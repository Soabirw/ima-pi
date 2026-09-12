import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFocusedAgentContinuation } from "../lib/ima-agent-continuation.ts";
import { agentContractFingerprint } from "../lib/ima-delegation.ts";
import { acquireRegistryFileLock } from "../lib/ima-agent-session-lock.ts";
import { loadDirectSessionRecord, storeDirectSessionRecord } from "../lib/ima-agent-sessions.ts";

const sessionsModule = new URL("../lib/ima-agent-sessions.ts", import.meta.url).href;
const locksModule = new URL("../lib/ima-agent-session-lock.ts", import.meta.url).href;
const continuationModule = new URL("../lib/ima-agent-continuation.ts", import.meta.url).href;
// Allow subprocess module loading under the full parallel suite; this is a liveness guard, not a performance assertion.
const CHILD_DEADLINE_MS = 10_000;
const CHILD_RELEASE_GRACE_MS = 250;
const CHILD_TERMINATION_GRACE_MS = 1_000;
const deferred = () => {
  let resolveDeferred;
  const promise = new Promise((resolve) => { resolveDeferred = resolve; });
  return { promise, resolve: () => resolveDeferred() };
};

// Liveness deadlines bound test-owned processes; IPC messages, not time, order assertions.
const withDeadline = (promise, label, milliseconds = CHILD_DEADLINE_MS) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed_out:${label}`)), milliseconds);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

const childEvent = (message) => message
  && typeof message === "object"
  && !Array.isArray(message)
  && typeof message.event === "string"
  ? message.event
  : null;

const runChild = (source, input) => {
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, IMA_AGENT_LOCK_TEST: JSON.stringify(input) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  } catch (error) {
    const result = { code: null, signal: null, stdout: "", stderr: "", error };
    return {
      child: null,
      messages: [],
      closed: true,
      completion: Promise.resolve(result),
      nextMessage: () => Promise.resolve({ kind: "closed", result }),
    };
  }

  let stdout = "";
  let stderr = "";
  let processError = null;
  let closed = false;
  let result;
  const messages = [];
  const waiters = new Set();
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const finish = (code, signal) => {
    if (closed) return;
    closed = true;
    result = { code, signal, stdout, stderr, error: processError };
    resolveCompletion(result);
    for (const waiter of waiters) waiter.resolve({ kind: "closed", result });
    waiters.clear();
  };

  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.stdout?.on("error", (error) => { processError ??= error; });
  child.stderr?.on("error", (error) => { processError ??= error; });
  child.on("message", (message) => {
    messages.push(message);
    const event = childEvent(message);
    for (const waiter of [...waiters]) {
      if (waiter.event !== event) continue;
      waiters.delete(waiter);
      waiter.resolve({ kind: "message", message });
    }
  });
  child.once("error", (error) => {
    processError ??= error;
    if (!child.pid) finish(null, null);
  });
  child.once("close", finish);

  return {
    child,
    messages,
    completion,
    get closed() { return closed; },
    nextMessage: (event) => {
      const message = messages.find((item) => childEvent(item) === event);
      if (message) return Promise.resolve({ kind: "message", message });
      if (closed) return Promise.resolve({ kind: "closed", result });
      return new Promise((resolve) => waiters.add({ event, resolve }));
    },
  };
};

const sendChildEvent = async (owned, event, milliseconds = CHILD_DEADLINE_MS) => {
  if (!owned.child || owned.closed || !owned.child.connected) return false;
  const sent = new Promise((resolve) => {
    try {
      owned.child.send({ event }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
  try {
    return await withDeadline(sent, `child_send:${event}`, milliseconds);
  } catch {
    return false;
  }
};

const waitForChildMessage = async (owned, event, milliseconds = CHILD_DEADLINE_MS) => {
  const outcome = await withDeadline(owned.nextMessage(event), `child_${event}`, milliseconds);
  if (outcome.kind === "message") return outcome.message;
  throw new Error(`child_closed_before:${event}`);
};

const waitForChildExit = (owned, label, milliseconds = CHILD_DEADLINE_MS) =>
  withDeadline(owned.completion, `child_exit:${label}`, milliseconds);

const childIsLive = (owned) => Boolean(
  owned.child
  && !owned.closed
  && owned.child.exitCode === null
  && owned.child.signalCode === null,
);

const terminateOwnedChild = (owned, signal) => {
  if (!childIsLive(owned)) return false;
  try {
    return owned.child.kill(signal);
  } catch {
    return false;
  }
};

const stopOwnedChild = async (owned) => {
  if (!childIsLive(owned)) return owned.completion;
  await sendChildEvent(owned, "release", CHILD_RELEASE_GRACE_MS);
  try {
    return await waitForChildExit(owned, "release", CHILD_RELEASE_GRACE_MS);
  } catch {}
  terminateOwnedChild(owned, "SIGTERM");
  try {
    return await waitForChildExit(owned, "sigterm", CHILD_TERMINATION_GRACE_MS);
  } catch {}
  terminateOwnedChild(owned, "SIGKILL");
  return waitForChildExit(owned, "sigkill", CHILD_TERMINATION_GRACE_MS);
};

const createChildScope = (t) => {
  const children = new Set();
  let cleanup = null;
  const releaseAll = async () => {
    await Promise.all([...children].map((owned) => sendChildEvent(owned, "release", CHILD_RELEASE_GRACE_MS)));
  };
  const closeAll = () => {
    if (!cleanup) cleanup = (async () => {
      await releaseAll();
      const outcomes = await Promise.allSettled([...children].map(stopOwnedChild));
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return cleanup;
  };
  t.after(closeAll);
  return {
    spawn: (source, input) => {
      const owned = runChild(source, input);
      // Register ownership before exposing the handle to a test assertion.
      children.add(owned);
      return owned;
    },
    releaseAll,
    closeAll,
  };
};

const removeFixtures = async (scope, paths) => {
  await scope.releaseAll();
  await scope.closeAll();
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
};

const directRecord = (root, reference, sessionId) => ({
  reference,
  agent: "reviewer",
  role: "review-read",
  resultKind: "review",
  provider: "p",
  model: "m",
  thinking: "high",
  sessionId,
  sessionFile: join(root, "sessions", `${sessionId}.jsonl`),
  writeScope: [],
  contractFingerprint: "review-contract",
  status: "succeeded",
  fresh: true,
  followUpAllowed: true,
  createdAt: "2026-09-11T12:00:00.000Z",
  updatedAt: "2026-09-11T12:00:00.000Z",
});

const createProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-lock-"));
  await mkdir(join(root, "sessions"));
  return root;
};

const childIpcGate = `
  const notify = (event) => new Promise((resolve) => {
    if (typeof process.send !== "function") { resolve(false); return; }
    try { process.send({ event }, (error) => resolve(!error)); }
    catch { resolve(false); }
  });
  const waitFor = (expected) => new Promise((resolve) => {
    const receive = (message) => {
      const event = message?.event;
      if (event !== expected && event !== "release") return;
      process.off("message", receive);
      resolve(event);
    };
    process.on("message", receive);
  });
`;

const directWriterSource = `
  import { storeDirectSessionRecord } from ${JSON.stringify(sessionsModule)};
  ${childIpcGate}
  const input = JSON.parse(process.env.IMA_AGENT_LOCK_TEST);
  const start = waitFor("start");
  await notify("ready");
  if (await start === "start") {
    try {
      await storeDirectSessionRecord({ cwd: input.cwd, record: input.record });
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
`;

const registryLockHolderSource = `
  import { acquireRegistryFileLock } from ${JSON.stringify(locksModule)};
  ${childIpcGate}
  const input = JSON.parse(process.env.IMA_AGENT_LOCK_TEST);
  const lease = await acquireRegistryFileLock(input.file);
  if (!lease) throw new Error("lock_not_acquired");
  const gate = waitFor(input.crash ? "ready_ack" : "release");
  await notify("ready");
  await gate;
  if (!input.crash) await lease.release();
`;

const sessionLockHolderSource = `
  import { acquireNativeSessionLock } from ${JSON.stringify(locksModule)};
  ${childIpcGate}
  const input = JSON.parse(process.env.IMA_AGENT_LOCK_TEST);
  const lease = await acquireNativeSessionLock(input.sessionFile);
  if (!lease) throw new Error("lock_not_acquired");
  const gate = waitFor(input.crash ? "ready_ack" : "release");
  await notify("ready");
  await gate;
  if (!input.crash) await lease.release();
`;

const abandonedHolderSource = `
  ${childIpcGate}
  const release = waitFor("release");
  await notify("ready");
  await release;
`;

const silentHolderSource = `
  ${childIpcGate}
  const waitForNever = new Promise((resolve) => {
    const receive = (message) => {
      if (message?.event !== "never") return;
      process.off("message", receive);
      resolve();
    };
    process.on("message", receive);
  });
  await notify("started");
  await waitForNever;
`;

test("TEST-009 closes withheld-release owned holders after missing readiness without touching the parent", async (t) => {
  const root = await createProject();
  const scope = createChildScope(t);
  const parentPid = process.pid;
  try {
    let abandoned;
    let silent;
    await assert.rejects(async () => {
      abandoned = scope.spawn(abandonedHolderSource, {});
      silent = scope.spawn(silentHolderSource, {});
      try {
        await Promise.all([
          waitForChildMessage(abandoned, "ready"),
          waitForChildMessage(silent, "started"),
        ]);
        assert.notEqual(abandoned.child?.pid, parentPid);
        assert.notEqual(silent.child?.pid, parentPid);
        assert.equal(abandoned.closed, false);
        await waitForChildMessage(silent, "ready", CHILD_RELEASE_GRACE_MS);
      } finally {
        await withDeadline(scope.closeAll(), "owned_child_cleanup", CHILD_DEADLINE_MS * 2);
      }
    }, /timed_out:child_ready/);
    const [abandonedResult, silentResult] = await Promise.all([
      waitForChildExit(abandoned, "abandoned-holder"),
      waitForChildExit(silent, "silent-holder"),
    ]);
    assert.equal(abandonedResult.error, null, abandonedResult.stderr);
    assert.equal(silentResult.error, null, silentResult.stderr);
    assert.equal(abandonedResult.code, 0, abandonedResult.stderr);
    assert.equal(abandonedResult.signal, null);
    assert.ok(["SIGTERM", "SIGKILL"].includes(silentResult.signal));
    assert.equal(process.pid, parentPid);
  } finally {
    await removeFixtures(scope, [root]);
  }
});

test("TEST-002 preserves unrelated direct records across synchronized processes and canonical cwd aliases", async (t) => {
  const root = await createProject();
  const alias = `${root}-alias`;
  const scope = createChildScope(t);
  try {
    await symlink(root, alias);
    const first = directRecord(root, "direct:process-a", "process-a");
    const second = directRecord(root, "direct:process-b", "process-b");
    const firstChild = scope.spawn(directWriterSource, { cwd: root, record: first });
    const secondChild = scope.spawn(directWriterSource, { cwd: alias, record: second });
    await Promise.all([
      waitForChildMessage(firstChild, "ready"),
      waitForChildMessage(secondChild, "ready"),
    ]);
    assert.deepEqual(await Promise.all([
      sendChildEvent(firstChild, "start"),
      sendChildEvent(secondChild, "start"),
    ]), [true, true]);
    const [firstResult, secondResult] = await Promise.all([
      waitForChildExit(firstChild, "process-a"),
      waitForChildExit(secondChild, "process-b"),
    ]);
    assert.equal(firstResult.error, null, firstResult.stderr);
    assert.equal(secondResult.error, null, secondResult.stderr);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    assert.deepEqual(JSON.parse(firstResult.stdout), { ok: true });
    assert.deepEqual(JSON.parse(secondResult.stdout), { ok: true });
    assert.deepEqual(
      (await Promise.all([
        loadDirectSessionRecord({ cwd: root, reference: first.reference }),
        loadDirectSessionRecord({ cwd: root, reference: second.reference }),
      ])).map((record) => record?.reference).sort(),
      [first.reference, second.reference],
    );
  } finally {
    await removeFixtures(scope, [alias, root]);
  }
});

test("serializes conflicting direct records across processes without replacing the first identity", async (t) => {
  const root = await createProject();
  const scope = createChildScope(t);
  try {
    const reference = "direct:shared";
    const firstChild = scope.spawn(directWriterSource, {
      cwd: root,
      record: directRecord(root, reference, "first"),
    });
    const secondChild = scope.spawn(directWriterSource, {
      cwd: root,
      record: directRecord(root, reference, "second"),
    });
    await Promise.all([
      waitForChildMessage(firstChild, "ready"),
      waitForChildMessage(secondChild, "ready"),
    ]);
    assert.deepEqual(await Promise.all([
      sendChildEvent(firstChild, "start"),
      sendChildEvent(secondChild, "start"),
    ]), [true, true]);
    const outcomes = await Promise.all([
      waitForChildExit(firstChild, "conflict-first"),
      waitForChildExit(secondChild, "conflict-second"),
    ]);
    const results = outcomes.map(({ stdout, stderr, code, error }) => {
      assert.equal(error, null, stderr);
      assert.equal(code, 0, stderr);
      return JSON.parse(stdout);
    });
    assert.equal(results.filter(({ ok }) => ok).length, 1);
    assert.equal(results.filter(({ error }) => error === "direct_agent_session_conflict").length, 1);
    assert.ok(["first", "second"].includes((await loadDirectSessionRecord({ cwd: root, reference }))?.sessionId));
  } finally {
    await removeFixtures(scope, [root]);
  }
});

test("TEST-007 fails closed for live and crashed registry locks without stealing either", async (t) => {
  const root = await createProject();
  const scope = createChildScope(t);
  try {
    const first = directRecord(root, "direct:initial", "initial");
    await storeDirectSessionRecord({ cwd: root, record: first });
    const file = join(root, ".ima-cycle", "direct-agent-sessions.json");

    const liveHolder = scope.spawn(registryLockHolderSource, { file, crash: false });
    await waitForChildMessage(liveHolder, "ready");
    await assert.rejects(
      storeDirectSessionRecord({ cwd: root, record: directRecord(root, "direct:live-blocked", "live-blocked") }),
      /direct_agent_session_busy/,
    );
    assert.equal(await sendChildEvent(liveHolder, "release"), true);
    const liveHolderResult = await waitForChildExit(liveHolder, "live-lock");
    assert.equal(liveHolderResult.error, null, liveHolderResult.stderr);
    assert.equal(liveHolderResult.code, 0, liveHolderResult.stderr);

    const staleHolder = scope.spawn(registryLockHolderSource, { file, crash: true });
    await waitForChildMessage(staleHolder, "ready");
    assert.equal(await sendChildEvent(staleHolder, "ready_ack"), true);
    const staleHolderResult = await waitForChildExit(staleHolder, "stale-lock");
    assert.equal(staleHolderResult.error, null, staleHolderResult.stderr);
    assert.equal(staleHolderResult.code, 0, staleHolderResult.stderr);
    await assert.rejects(
      storeDirectSessionRecord({ cwd: root, record: directRecord(root, "direct:stale-blocked", "stale-blocked") }),
      /direct_agent_session_busy/,
    );
    assert.equal(await acquireRegistryFileLock(file), null);
    assert.deepEqual(await loadDirectSessionRecord({ cwd: root, reference: first.reference }), first);
  } finally {
    await removeFixtures(scope, [root]);
  }
});

const continuationAgent = {
  schemaVersion: 1,
  name: "reviewer",
  description: "Review",
  tier: "HIGH",
  authority: "review-read",
  tools: ["read"],
  skills: [],
  delegation: { allowed: false, maxDepth: 0 },
  independence: { freshInitial: true, followUpAllowed: true },
  result: { kind: "review", requiredSections: ["findings"] },
  escalation: ["scope"],
  prompt: "Review safely.",
  source: "package",
  path: "/agents/reviewer.md",
};

const continuationRecord = (cwd, sessionFile) => {
  const writeScope = [];
  return {
    reference: "direct:continued-review",
    agent: continuationAgent.name,
    role: continuationAgent.authority,
    resultKind: continuationAgent.result.kind,
    provider: "p",
    model: "m",
    thinking: "high",
    sessionId: "continued-review-session",
    sessionFile,
    writeScope,
    contractFingerprint: agentContractFingerprint(continuationAgent, writeScope),
    status: "succeeded",
    fresh: true,
    followUpAllowed: true,
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:00:00.000Z",
  };
};

const runContinuation = ({ cwd, record, session, signal, onSessionRecord } = {}) => {
  const store = new Map([[record.reference, record]]);
  let opens = 0;
  let creates = 0;
  const promise = runFocusedAgentContinuation({
    record,
    agent: continuationAgent,
    brief: "Recheck the confirmed finding",
    runtime: { getModel: (provider, model) => provider === "p" && model === "m" ? { provider, id: model } : undefined },
    cwd,
    signal,
    sessionStore: store,
    onSessionRecord,
    dependencies: {
      openManager: (path) => {
        opens += 1;
        return {
          getSessionId: () => record.sessionId,
          getSessionFile: () => path,
          getCwd: () => cwd,
        };
      },
      createSession: async () => {
        creates += 1;
        return { session };
      },
      scopedTools: () => [],
      toolNames: { read: "read" },
      finalAssistant: () => ({ stopReason: "stop", report: "## Findings\nrechecked" }),
      mutationAttemptUnsafe: () => false,
      clock: () => "2026-09-11T12:01:00.000Z",
    },
  });
  return { promise, counts: () => ({ opens, creates }), store };
};

const continuationSession = (record, overrides = {}) => {
  const state = { prompts: 0, aborts: 0, waits: 0, disposes: 0 };
  const session = {
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
    sessionId: record.sessionId,
    sessionFile: overrides.sessionFile ?? record.sessionFile,
    subscribe: () => () => undefined,
    prompt: async () => {
      state.prompts += 1;
      await overrides.prompt?.();
    },
    waitForIdle: async () => {
      state.waits += 1;
      await overrides.waitForIdle?.();
    },
    abort: async () => {
      state.aborts += 1;
      await overrides.abort?.();
    },
    dispose: () => { state.disposes += 1; },
  };
  return { session, state };
};

const continuationRunnerSource = `
  import { runFocusedAgentContinuation } from ${JSON.stringify(continuationModule)};
  ${childIpcGate}
  const input = JSON.parse(process.env.IMA_AGENT_LOCK_TEST);
  const agent = {
    name: "reviewer",
    authority: "review-read",
    tools: ["read"],
    independence: { freshInitial: true, followUpAllowed: true },
    result: { kind: "review", requiredSections: ["findings"] },
  };
  const session = {
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
    sessionId: input.record.sessionId,
    sessionFile: input.canonicalSessionFile,
    subscribe: () => () => undefined,
    prompt: async () => {
      const release = input.hold ? waitFor("release") : null;
      await notify("prompted");
      if (release) await release;
    },
    waitForIdle: async () => undefined,
    dispose: () => undefined,
  };
  const result = await runFocusedAgentContinuation({
    record: input.record,
    agent,
    brief: "Recheck the confirmed finding",
    runtime: { getModel: (provider, model) => provider === "p" && model === "m" ? { provider, id: model } : undefined },
    cwd: input.cwd,
    sessionStore: new Map([[input.record.reference, input.record]]),
    dependencies: {
      openManager: (path) => ({
        getSessionId: () => input.record.sessionId,
        getSessionFile: () => path,
        getCwd: () => input.cwd,
      }),
      createSession: async () => ({ session }),
      scopedTools: () => [],
      toolNames: { read: "read" },
      finalAssistant: () => ({ stopReason: "stop", report: "## Findings\\nrechecked" }),
      mutationAttemptUnsafe: () => false,
      clock: () => "2026-09-11T12:01:00.000Z",
    },
  });
  console.log(JSON.stringify({ status: result.status, error: result.error, attempts: result.attempts }));
`;

test("TEST-003 allows only one real continuation across processes, canonical aliases, and reference aliases", async (t) => {
  const root = await createProject();
  const alias = `${root}-alias`;
  const sessionFile = join(root, "sessions", "cross-process.jsonl");
  const scope = createChildScope(t);
  try {
    await writeFile(sessionFile, "session\n");
    await symlink(root, alias);
    const firstRecord = continuationRecord(root, sessionFile);
    const secondRecord = {
      ...continuationRecord(root, join(alias, "sessions", "cross-process.jsonl")),
      reference: "direct:continued-review-alias",
    };
    const first = scope.spawn(continuationRunnerSource, {
      cwd: root,
      record: firstRecord,
      canonicalSessionFile: sessionFile,
      hold: true,
    });
    await waitForChildMessage(first, "prompted");

    const second = scope.spawn(continuationRunnerSource, {
      cwd: root,
      record: secondRecord,
      canonicalSessionFile: sessionFile,
      hold: false,
    });
    const secondResult = await waitForChildExit(second, "continuation-contender");
    assert.equal(secondResult.error, null, secondResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    assert.deepEqual(JSON.parse(secondResult.stdout), {
      status: "refused",
      error: "session_follow_up_busy",
      attempts: 0,
    });
    assert.equal(second.messages.some((message) => childEvent(message) === "prompted"), false);

    assert.equal(await sendChildEvent(first, "release"), true);
    const firstResult = await waitForChildExit(first, "continuation-owner");
    assert.equal(firstResult.error, null, firstResult.stderr);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.deepEqual(JSON.parse(firstResult.stdout), {
      status: "succeeded",
      attempts: 1,
    });
  } finally {
    await removeFixtures(scope, [alias, root]);
  }
});

test("blocks cross-process aliased continuations, releases after cancellation, and refuses stale leases", async (t) => {
  const root = await createProject();
  const alias = `${root}-alias`;
  const sessionFile = join(root, "sessions", "continued.jsonl");
  const scope = createChildScope(t);
  try {
    await writeFile(sessionFile, "session\n");
    await symlink(root, alias);
    const holder = scope.spawn(sessionLockHolderSource, { sessionFile, crash: false });
    await waitForChildMessage(holder, "ready");

    const aliasedRecord = continuationRecord(root, join(alias, "sessions", "continued.jsonl"));
    const blockedSession = continuationSession(aliasedRecord);
    const blocked = runContinuation({ cwd: root, record: aliasedRecord, session: blockedSession.session });
    const blockedResult = await blocked.promise;
    assert.equal(blockedResult.error, "session_follow_up_busy");
    assert.deepEqual(blocked.counts(), { opens: 0, creates: 0 });
    assert.equal(blockedSession.state.prompts, 0);

    assert.equal(await sendChildEvent(holder, "release"), true);
    const holderResult = await waitForChildExit(holder, "session-lock");
    assert.equal(holderResult.error, null, holderResult.stderr);
    assert.equal(holderResult.code, 0, holderResult.stderr);

    const reusableSession = continuationSession(aliasedRecord, { sessionFile });
    const reusable = runContinuation({ cwd: root, record: aliasedRecord, session: reusableSession.session });
    assert.equal((await reusable.promise).status, "succeeded");
    assert.equal(reusableSession.state.prompts, 1);

    const controller = new AbortController();
    let releaseIdle;
    const idle = new Promise((resolveIdle) => { releaseIdle = resolveIdle; });
    let promptStarted;
    const started = new Promise((resolveStarted) => { promptStarted = resolveStarted; });
    const cancellingSession = continuationSession(aliasedRecord, {
      sessionFile,
      prompt: () => promptStarted(),
      waitForIdle: () => idle,
      abort: () => releaseIdle(),
    });
    const cancelling = runContinuation({
      cwd: root,
      record: aliasedRecord,
      session: cancellingSession.session,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    assert.equal((await cancelling.promise).error, "cancelled");
    assert.ok(cancellingSession.state.aborts >= 1);
    assert.ok(cancellingSession.state.waits >= 1);
    assert.equal(cancellingSession.state.disposes, 1);

    const afterCancellationSession = continuationSession(aliasedRecord, { sessionFile });
    const afterCancellation = runContinuation({ cwd: root, record: aliasedRecord, session: afterCancellationSession.session });
    assert.equal((await afterCancellation.promise).status, "succeeded");

    const staleHolder = scope.spawn(sessionLockHolderSource, { sessionFile, crash: true });
    await waitForChildMessage(staleHolder, "ready");
    assert.equal(await sendChildEvent(staleHolder, "ready_ack"), true);
    const staleHolderResult = await waitForChildExit(staleHolder, "stale-session-lock");
    assert.equal(staleHolderResult.error, null, staleHolderResult.stderr);
    assert.equal(staleHolderResult.code, 0, staleHolderResult.stderr);
    const staleSession = continuationSession(aliasedRecord);
    const stale = runContinuation({ cwd: root, record: aliasedRecord, session: staleSession.session });
    assert.equal((await stale.promise).error, "session_follow_up_busy");
    assert.deepEqual(stale.counts(), { opens: 0, creates: 0 });
  } finally {
    await removeFixtures(scope, [alias, root]);
  }
});

test("TEST-008 holds a canonical continuation lease through persistence, disposal, and abort settlement", async () => {
  const root = await createProject();
  const alias = `${root}-alias`;
  const sessionFile = join(root, "sessions", "lease.jsonl");
  await writeFile(sessionFile, "session\n");
  await symlink(root, alias);
  try {
    const record = continuationRecord(root, sessionFile);
    const aliasedRecord = {
      ...continuationRecord(root, join(alias, "sessions", "lease.jsonl")),
      reference: "direct:continued-review-alias",
    };

    const persistenceStarted = deferred();
    const releasePersistence = deferred();
    const disposalStarted = deferred();
    const releaseDisposal = deferred();
    const firstSession = continuationSession(record);
    firstSession.session.dispose = async () => {
      firstSession.state.disposes += 1;
      disposalStarted.resolve();
      await releaseDisposal.promise;
    };
    const first = runContinuation({
      cwd: root,
      record,
      session: firstSession.session,
      onSessionRecord: async () => {
        persistenceStarted.resolve();
        await releasePersistence.promise;
      },
    });
    await persistenceStarted.promise;

    const duringPersistence = runContinuation({
      cwd: root,
      record: aliasedRecord,
      session: continuationSession(aliasedRecord, { sessionFile }).session,
    });
    assert.equal((await duringPersistence.promise).error, "session_follow_up_busy");
    assert.deepEqual(duringPersistence.counts(), { opens: 0, creates: 0 });

    releasePersistence.resolve();
    await disposalStarted.promise;
    const duringDisposal = runContinuation({
      cwd: root,
      record: aliasedRecord,
      session: continuationSession(aliasedRecord, { sessionFile }).session,
    });
    assert.equal((await duringDisposal.promise).error, "session_follow_up_busy");
    assert.deepEqual(duringDisposal.counts(), { opens: 0, creates: 0 });

    releaseDisposal.resolve();
    assert.equal((await first.promise).status, "succeeded");
    assert.equal(firstSession.state.disposes, 1);

    const controller = new AbortController();
    const promptStarted = deferred();
    const abortObserved = deferred();
    const settleAbort = deferred();
    const abortingSession = continuationSession(record, {
      prompt: () => promptStarted.resolve(),
      waitForIdle: () => settleAbort.promise,
      abort: () => abortObserved.resolve(),
    });
    const aborting = runContinuation({
      cwd: root,
      record,
      session: abortingSession.session,
      signal: controller.signal,
    });
    await promptStarted.promise;
    controller.abort();
    await abortObserved.promise;

    const duringAbortSettlement = runContinuation({
      cwd: root,
      record: aliasedRecord,
      session: continuationSession(aliasedRecord, { sessionFile }).session,
    });
    assert.equal((await duringAbortSettlement.promise).error, "session_follow_up_busy");
    assert.deepEqual(duringAbortSettlement.counts(), { opens: 0, creates: 0 });

    settleAbort.resolve();
    assert.equal((await aborting.promise).error, "cancelled");
    assert.ok(abortingSession.state.aborts >= 1);
    assert.ok(abortingSession.state.waits >= 1);

    const afterSettlement = runContinuation({
      cwd: root,
      record: aliasedRecord,
      session: continuationSession(aliasedRecord, { sessionFile }).session,
    });
    assert.equal((await afterSettlement.promise).status, "succeeded");
  } finally {
    await Promise.all([
      rm(alias, { force: true }),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("does not retry a completed specialist when durable continuation persistence fails", async () => {
  const root = await createProject();
  const sessionFile = join(root, "sessions", "durable.jsonl");
  await writeFile(sessionFile, "session\n");
  try {
    const record = continuationRecord(root, sessionFile);
    const child = continuationSession(record);
    const run = runContinuation({
      cwd: root,
      record,
      session: child.session,
      onSessionRecord: async () => { throw new Error("network timeout"); },
    });
    const result = await run.promise;
    assert.equal(result.status, "failed");
    assert.equal(result.attempts, 1);
    assert.deepEqual(run.counts(), { opens: 1, creates: 1 });
    assert.equal(child.state.prompts, 1);
    const afterFailure = continuationSession(record);
    assert.equal((await runContinuation({ cwd: root, record, session: afterFailure.session }).promise).status, "succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
