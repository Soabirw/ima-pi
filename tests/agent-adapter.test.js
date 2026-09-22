import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  coordinateDelegation,
  createScopedTools,
  createSessionPersistence,
  resolveProjectTrust,
  restoreSessionRecord,
  runAgentFollowUp,
} from "../extensions/agents.ts";
import { DELEGATED_VERIFICATION_CLEANUP_TIMEOUT_MS } from "../lib/ima-delegated-verification.ts";
import {
  CYCLE_AGENT_SESSION_SCHEMA_VERSION,
  CYCLE_PHASE_CONTEXT_ENTRY,
  storeCycleOwnedSessionRecord,
  storeDirectSessionRecord,
} from "../lib/ima-agent-sessions.ts";

const agent = {
  schemaVersion: 1, name: "implementer", description: "Implement", tier: "MID", authority: "write",
  tools: ["read", "write", "edit", "bash"], skills: [], delegation: { allowed: false, maxDepth: 0 },
  independence: { freshInitial: false, followUpAllowed: true }, result: { kind: "implementation", requiredSections: ["files", "verification"] },
  escalation: ["scope"], prompt: "Implement safely.", source: "package", path: "/agents/implementer.md",
};
const assignment = (id, writeScope = ["owned"]) => ({ id, agent: "implementer", goal: "Change code", context: "Approved", paths: ["owned/file.txt"], constraints: [], nonGoals: [], expectedOutput: "report", writeScope });
const config = { models: { MID: { provider: "p", model: "m", thinking: "high" } } };
const runtime = { getModels: () => [{ provider: "p", id: "m", input: ["text"] }], getModel: (provider, model) => provider === "p" && model === "m" ? { provider, id: model } : undefined };
const report = "## Files\nowned/file.txt\n\n## Verification\npassed";

const fakeSession = (overrides = {}) => {
  const reportText = overrides.text ?? report;
  const state = {
    aborts: 0, disposes: 0, prompts: [], unsubscribes: 0,
    messages: [{ role: "assistant", stopReason: "stop", content: reportText ? [{ type: "text", text: reportText }] : [] }],
    ...overrides.state,
  };
  const listeners = [];
  const session = {
    messages: state.messages,
    model: { provider: "p", id: "m" }, thinkingLevel: "high", sessionId: overrides.sessionId ?? "session", sessionFile: overrides.sessionFile ?? "/sessions/session.jsonl",
    subscribe: (listener) => { listeners.push(listener); return () => { state.unsubscribes += 1; }; },
    prompt: async (brief, options) => { state.prompts.push({ brief, options }); await overrides.prompt?.({ state, listeners, session }); },
    waitForIdle: async () => overrides.waitForIdle?.({ state, listeners, session }),
    getLastAssistantText: () => reportText,
    abort: async () => { state.aborts += 1; await overrides.abort?.({ state, listeners, session }); },
    dispose: () => { state.disposes += 1; },
  };
  return { session, state };
};

const run = ({
  assignments = [assignment("a")],
  sessions,
  signal,
  onActivity,
  selectedConfig = config,
  selectedRuntime = runtime,
  sessionStore = new Map(),
  cwd = "/repo",
  scopedTools = () => [],
  selectedAgent = agent,
  createSession,
} = {}) => {
  let index = 0;
  let tick = 1_000;
  return coordinateDelegation({
    cwd, request: { title: "work", assignments }, agents: [selectedAgent], config: selectedConfig, runtime: selectedRuntime, runId: "tool-call", onActivity, signal,
    sessionStore, dependencies: {
      createManager: () => ({}), scopedTools, clock: () => "2026-07-31T20:00:00.000Z", activityClock: () => tick += 10,
      createSession: createSession ?? (async () => sessions[index++]),
    },
  });
};

test("TEST-004 scoped tools preserve supported native paths and fail closed on unsafe path evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-adapter-"));
  const outside = await mkdtemp(join(tmpdir(), "ima-agent-outside-"));
  try {
    await mkdir(join(root, "owned"));
    await mkdir(join(root, "sibling"));
    await writeFile(join(root, "owned", "edit.txt"), "before\n");
    await writeFile(join(root, "sibling", "edit.txt"), "before\n");
    await symlink(outside, join(root, "owned", "escape"));
    await symlink(join(outside, "missing"), join(root, "owned", "broken"));
    await symlink("loop", join(root, "owned", "loop"));
    const tools = createScopedTools({ cwd: root, assignment: assignment("a"), agent });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const invoke = (name, args) => byName.get(name).execute("call", args, undefined, undefined, {});

    await invoke("write", { path: "owned/relative.txt", content: "relative" });
    await invoke("write", { path: "./owned/dot.txt", content: "dot" });
    await invoke("write", { path: join(root, "owned", "absolute.txt"), content: "absolute" });
    await invoke("write", { path: "@owned/new.txt", content: "owned" });
    await invoke("edit", { path: `@${join(root, "owned", "edit.txt")}`, edits: [{ oldText: "before", newText: "after" }] });
    assert.equal(await readFile(join(root, "owned", "relative.txt"), "utf8"), "relative");
    assert.equal(await readFile(join(root, "owned", "dot.txt"), "utf8"), "dot");
    assert.equal(await readFile(join(root, "owned", "absolute.txt"), "utf8"), "absolute");
    assert.equal(await readFile(join(root, "owned", "new.txt"), "utf8"), "owned");
    assert.equal(await readFile(join(root, "owned", "edit.txt"), "utf8"), "after\n");

    const denied = [
      ["write", { path: "sibling/no.txt", content: "no" }],
      ["write", { path: "@sibling/no-at-prefix.txt", content: "no" }],
      ["write", { path: `@${join(root, "sibling", "no-absolute-at-prefix.txt")}`, content: "no" }],
      ["write", { path: "@@owned/double-prefix.txt", content: "no" }],
      ["write", { path: "~/no-home.txt", content: "no" }],
      ["write", { path: `file://${join(root, "owned", "no-file-url.txt")}`, content: "no" }],
      ["write", { path: "owned\\no-backslash.txt", content: "no" }],
      ["write", { path: `${root}/owned/../sibling/no-raw-parent.txt`, content: "no" }],
      ["edit", { path: "@sibling/edit.txt", edits: [{ oldText: "before", newText: "after" }] }],
      ["write", { path: "../parent-no.txt", content: "no" }],
      ["write", { path: "owned/../sibling/no.txt", content: "no" }],
      ["write", { path: "owned/escape/no.txt", content: "no" }],
      ["write", { path: "owned/broken/no.txt", content: "no" }],
      ["write", { path: "owned/loop/no.txt", content: "no" }],
      ["bash", { command: "rm owned/edit.txt" }],
      ["bash", { command: "echo pwn>sibling/no-space.txt" }],
      ["bash", { command: "git status --short && printf diagnostics" }],
    ];
    for (const [name, args] of denied) await assert.rejects(invoke(name, args));
    assert.equal(existsSync(join(root, "sibling", "no.txt")), false);
    assert.equal(existsSync(join(root, "sibling", "no-at-prefix.txt")), false);
    assert.equal(existsSync(join(root, "sibling", "no-absolute-at-prefix.txt")), false);
    assert.equal(existsSync(join(root, "owned", "double-prefix.txt")), false);
    assert.equal(existsSync(join(root, "owned", "no-file-url.txt")), false);
    assert.equal(existsSync(join(root, "owned", "no-backslash.txt")), false);
    assert.equal(existsSync(join(root, "sibling", "no-raw-parent.txt")), false);
    assert.equal(await readFile(join(root, "sibling", "edit.txt"), "utf8"), "before\n");
    assert.equal(existsSync(join(root, "sibling", "no-space.txt")), false);
    assert.equal(existsSync(join(root, "..", "parent-no.txt")), false);
    assert.equal(existsSync(join(outside, "no.txt")), false);
    assert.equal(existsSync(join(root, "owned", "edit.txt")), true);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("adapter denies composed delegated Bash before any command executes", async () => {
  let executions = 0;
  const tools = createScopedTools({
    cwd: "/repo",
    assignment: assignment("composed-bash"),
    agent,
    operations: {
      bash: {
        exec: async () => {
          executions += 1;
          return { exitCode: 0 };
        },
      },
    },
  });
  const bash = tools.find((tool) => tool.name === "bash");
  const nativeBashContext = {
    sessionManager: {
      getSessionId: () => "composed-bash-test",
      getSessionFile: () => undefined,
    },
  };
  const commands = [
    "git status --short && git diff --check",
    "git status --short; git diff --check",
    "git status --short &",
    "git status --short | cat",
    "echo $(git status --short)",
  ];

  for (const [index, command] of commands.entries()) {
    await assert.rejects(
      bash.execute(`composed-bash-${index}`, { command }, undefined, undefined, nativeBashContext),
      { message: "ownership_bash_denied:shell_composition" },
    );
  }
  assert.equal(executions, 0);
});

test("adapter rejects raw package-manager, wrapper, and indirect commands before execution", async () => {
  let executions = 0;
  const tools = createScopedTools({
    cwd: "/repo",
    assignment: assignment("raw-verification-bash"),
    agent,
    operations: {
      bash: {
        exec: async () => {
          executions += 1;
          return { exitCode: 0 };
        },
      },
    },
  });
  const bash = tools.find((tool) => tool.name === "bash");
  const nativeBashContext = {
    sessionManager: {
      getSessionId: () => "raw-verification-bash-test",
      getSessionFile: () => undefined,
    },
  };
  const commands = [
    "npm test",
    "npm run test",
    "composer test",
    "npx playwright test",
    "pnpm test",
    "yarn test",
    "ddev npm test",
    "bash -c 'npm test'",
    "sh -c 'composer test'",
    "env npm test",
    "command npm test",
    "xargs npm",
  ];

  for (const [index, command] of commands.entries()) {
    await assert.rejects(
      bash.execute(`raw-verification-${index}`, { command }, undefined, undefined, nativeBashContext),
      /ownership_bash_denied:/,
    );
  }
  assert.equal(executions, 0);
});

test("uses Pi trust as authoritative and only falls back to the environment decision when unavailable", () => {
  assert.equal(resolveProjectTrust({ isProjectTrusted: () => true }, false), true);
  assert.equal(resolveProjectTrust({ isProjectTrusted: () => false }, true), false);
  assert.equal(resolveProjectTrust({}, true), true);
  assert.equal(resolveProjectTrust(undefined, false), false);
});

test("restores a direct reviewer record after in-memory phase state is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-direct-continuation-"));
  const persistence = createSessionPersistence(root, null);
  const reference = persistence.sessionReference();
  const reviewerSession = join(root, "reviewer.jsonl");
  const record = {
    reference,
    agent: "reviewer",
    role: "review-read",
    resultKind: "review",
    provider: "p",
    model: "review-model",
    thinking: "high",
    sessionId: "review-session",
    sessionFile: reviewerSession,
    writeScope: [],
    contractFingerprint: "review-contract",
    status: "succeeded",
    fresh: true,
    followUpAllowed: true,
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:00:00.000Z",
  };
  try {
    await writeFile(reviewerSession, "review session\n");
    await persistence.onSessionRecord(record);
    assert.deepEqual(await restoreSessionRecord({
      cwd: root,
      sessionManager: { getBranch: () => [] },
    }, reference), {
      record,
      owner: null,
      storage: "direct",
    });
    const nonReusableReference = persistence.sessionReference();
    await persistence.onSessionRecord({
      ...record,
      reference: nonReusableReference,
      followUpAllowed: false,
    });
    assert.equal(await restoreSessionRecord({
      cwd: root,
      sessionManager: { getBranch: () => [] },
    }, nonReusableReference), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TEST-001 keeps warmed cycle-owned references bound to their lifecycle and out of direct storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-cycle-provenance-"));
  const ownerA = {
    schemaVersion: CYCLE_AGENT_SESSION_SCHEMA_VERSION,
    project: "ima-pi",
    lifecycleKey: "ima-pi:jira:WT-001-A",
    source: "jira:WT-001-A",
    phase: "review",
    dispatchId: "review-a",
  };
  const ownerB = {
    ...ownerA,
    lifecycleKey: "ima-pi:jira:WT-001-B",
    source: "jira:WT-001-B",
    dispatchId: "review-b",
  };
  const context = (owner) => ({
    cwd: root,
    isProjectTrusted: () => false,
    sessionManager: {
      getBranch: () => owner ? [{ type: "custom", customType: CYCLE_PHASE_CONTEXT_ENTRY, data: owner }] : [],
    },
  });
  const record = (reference) => ({
    reference,
    agent: "reviewer",
    role: "review-read",
    resultKind: "review",
    provider: "p",
    model: "m",
    thinking: "high",
    sessionId: `${reference}-session`,
    sessionFile: join(root, `${reference.replace(/[^a-z0-9]/gi, "-")}.jsonl`),
    writeScope: [],
    contractFingerprint: "review-contract",
    status: "succeeded",
    fresh: true,
    followUpAllowed: true,
    createdAt: "2026-09-11T12:00:00.000Z",
    updatedAt: "2026-09-11T12:00:00.000Z",
  });
  const refusedPublicFollowUp = async (owner, reference) => {
    const result = await runAgentFollowUp({
      ctx: context(owner),
      reference,
      brief: "Confirm the cached record remains lifecycle-bound.",
    });
    assert.deepEqual(
      { status: result.status, error: result.error },
      { status: "refused", error: "session_not_reusable" },
    );
  };
  try {
    const cycle = record("cycle:wt-001-reviewer");
    await storeCycleOwnedSessionRecord({ cwd: root, owner: ownerA, record: cycle });
    assert.equal((await restoreSessionRecord(context(ownerA), cycle.reference))?.storage, "cycle");
    assert.equal(await restoreSessionRecord(context(ownerB), cycle.reference), null);
    assert.equal(await restoreSessionRecord(context(null), cycle.reference), null);
    await refusedPublicFollowUp(ownerB, cycle.reference);
    await refusedPublicFollowUp(null, cycle.reference);
    await assert.rejects(
      storeDirectSessionRecord({ cwd: root, record: cycle }),
      /direct_agent_session_invalid/,
    );

    const legacyCycle = record("t13-cycle-owned-review");
    await storeCycleOwnedSessionRecord({ cwd: root, owner: ownerA, record: legacyCycle });
    assert.equal((await restoreSessionRecord(context(ownerA), legacyCycle.reference))?.storage, "cycle");
    assert.equal(await restoreSessionRecord(context(ownerB), legacyCycle.reference), null);
    assert.equal(await restoreSessionRecord(context(null), legacyCycle.reference), null);
    await refusedPublicFollowUp(ownerB, legacyCycle.reference);
    await refusedPublicFollowUp(null, legacyCycle.reference);
    await assert.rejects(
      storeDirectSessionRecord({ cwd: root, record: legacyCycle }),
      /direct_agent_session_cycle_owned/,
    );
    assert.equal(existsSync(join(root, ".ima-cycle", "direct-agent-sessions.json")), false);

    const legacyDirect = record("t13-initial-review");
    await storeDirectSessionRecord({ cwd: root, record: legacyDirect });
    assert.equal((await restoreSessionRecord(context(null), legacyDirect.reference))?.storage, "direct");
    assert.equal((await restoreSessionRecord(context(ownerA), legacyDirect.reference))?.storage, "memory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routes a phase-tagged delegated agent through the parent phase matrix", async () => {
  const phaseAgent = { ...agent, phase: "implement" };
  const child = fakeSession();
  child.session.model = { provider: "p", id: "phase-model" };
  child.session.thinkingLevel = "max";
  let selected;
  const phaseRuntime = { getModels: () => [{ provider: "p", id: "phase-model", input: ["text"] }], getModel: (provider, model) => provider === "p" && model === "phase-model" ? { provider, id: model } : undefined };
  const result = await coordinateDelegation({
    cwd: "/repo", request: { title: "phase", assignments: [assignment("phase")] }, agents: [phaseAgent],
    config: { models: { MID: { provider: "p", model: "tier-model" } }, phases: { implement: { provider: "p", model: "phase-model", thinking: "max", source: "preset" } } }, runtime: phaseRuntime,
    sessionStore: new Map(), dependencies: { createManager: () => ({}), scopedTools: () => [], createSession: async (options) => { selected = options.model; return { session: child.session }; } },
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(selected, { provider: "p", id: "phase-model" });
  assert.equal(result.results[0].thinking, "max");
});

test("rejects a mismatched child route before prompt or idle wait", async () => {
  for (const mismatch of ["model", "thinking"]) {
    const child = fakeSession();
    if (mismatch === "model") child.session.model = { provider: "p", id: "wrong-model" };
    else child.session.thinkingLevel = "low";
    let idleWaits = 0;
    child.session.waitForIdle = async () => { idleWaits += 1; };
    const result = await run({ sessions: [{ session: child.session }] });
    assert.equal(result.status, "failed", mismatch);
    assert.ok(result.results[0].completion.includes("runtime_identity_mismatch"), mismatch);
    assert.equal(child.state.prompts.length, 0, mismatch);
    assert.equal(idleWaits, 0, mismatch);
    assert.equal(child.state.disposes, 1, mismatch);
  }
});

test("coordinates concurrent children but returns results in request order with observed reports and identity", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = fakeSession({ sessionId: "s-a", sessionFile: "/sessions/a.jsonl", waitForIdle: () => firstGate });
  const second = fakeSession({ sessionId: "s-b", sessionFile: "/sessions/b.jsonl", waitForIdle: () => { releaseFirst(); } });
  const result = await run({ assignments: [assignment("a", ["owned/a"]), assignment("b", ["owned/b"])], sessions: [{ session: first.session }, { session: second.session }] });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.results.map(({ id }) => id), ["a", "b"]);
  assert.deepEqual(result.results.map(({ session }) => session?.id), ["s-a", "s-b"]);
  assert.equal(result.results[0].summary, report);
  assert.equal(result.results[0].summaryTruncated, false);
  assert.equal(result.results[0].report, undefined);
  assert.equal(first.state.disposes, 1); assert.equal(second.state.disposes, 1);
  assert.equal(first.state.unsubscribes, 1); assert.equal(second.state.unsubscribes, 1);
});

test("coordinates advisory review-verifier prose as succeeded", async () => {
  const verifier = { ...agent, name: "review-verifier", tier: "reviewVerify", authority: "review-read", tools: ["read"], result: { kind: "review", format: "review-verdict-v1", requiredSections: ["verdict", "reason"] } };
  const verifierAssignment = { ...assignment("verify", []), agent: "review-verifier" };
  const child = fakeSession({ text: "The candidate is confirmed by the supplied direct evidence." });
  const result = await coordinateDelegation({
    cwd: "/repo", request: { title: "verify", assignments: [verifierAssignment] }, agents: [verifier], config: { models: { ...config.models, HIGH: config.models.MID } }, runtime, runId: "verify",
    sessionStore: new Map(), dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "2026-07-31T20:00:00.000Z", activityClock: () => 1_000, createSession: async () => ({ session: child.session }) },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.results[0].status, "succeeded");
});

test("caller abort cancels and settles live children without retry", async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const child = fakeSession({ waitForIdle: () => gate, abort: () => release() });
  const promise = run({ sessions: [{ session: child.session }], signal: controller.signal });
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.partialEffects, true);
  assert.ok(child.state.aborts >= 1);
  assert.equal(child.state.disposes, 1);
});

test("unexpected mutation marks unsafe partial state and aborts settled siblings", async () => {
  let releaseSibling;
  const siblingGate = new Promise((resolve) => { releaseSibling = resolve; });
  const unsafeChild = fakeSession({ prompt: ({ listeners }) => { for (const listener of listeners) listener({ type: "tool_execution_start", toolName: "write", args: { path: "owned/b/escape.txt" } }); } });
  const sibling = fakeSession({ waitForIdle: () => siblingGate, abort: () => releaseSibling() });
  const result = await run({ assignments: [assignment("a", ["owned/a"]), assignment("b", ["owned/b"])], sessions: [{ session: unsafeChild.session }, { session: sibling.session }] });
  assert.equal(result.status, "failed");
  assert.equal(result.partialEffects, true);
  assert.deepEqual(result.unsafeEvidence, [{ assignmentId: "a", writeScope: ["owned/a"] }]);
  assert.ok(sibling.state.aborts >= 1);
  assert.equal(sibling.state.disposes, 1);
  assert.equal(unsafeChild.state.disposes, 1);
});

test("unsettled valid scoped starts during fresh prompt or idle rejection fail closed before retry", async () => {
  const cases = [
    { name: "prompt rejection", rejection: "prompt" },
    { name: "idle rejection", rejection: "idle" },
  ];
  for (const scenario of cases) {
    let signalSiblingReady;
    const siblingReady = new Promise((resolve) => { signalSiblingReady = resolve; });
    let releaseSibling;
    const siblingGate = new Promise((resolve) => { releaseSibling = resolve; });
    const emitUnsettledStart = (listeners) => {
      for (const listener of listeners) {
        listener({
          type: "tool_execution_start",
          toolCallId: `unsettled-${scenario.rejection}`,
          toolName: "write",
          args: { path: "owned/a/result.txt" },
        });
      }
    };
    const unsafeChild = fakeSession({
      prompt: async ({ listeners }) => {
        emitUnsettledStart(listeners);
        await siblingReady;
        if (scenario.rejection === "prompt") throw new Error("provider timeout");
      },
      waitForIdle: async () => {
        if (scenario.rejection === "idle") throw new Error("provider timeout");
      },
    });
    const sibling = fakeSession({
      prompt: () => { signalSiblingReady(); },
      waitForIdle: () => siblingGate,
      abort: () => releaseSibling(),
    });
    const retry = fakeSession({ sessionId: `retry-${scenario.rejection}`, sessionFile: `/sessions/retry-${scenario.rejection}.jsonl` });
    const sessionStore = new Map();
    const result = await run({
      assignments: [assignment("a", ["owned/a"]), assignment("b", ["owned/b"])],
      sessions: [{ session: unsafeChild.session }, { session: sibling.session }, { session: retry.session }],
      sessionStore,
    });

    assert.equal(result.status, "failed", scenario.name);
    assert.equal(result.results[0].attempts, 1, scenario.name);
    assert.equal(result.results[0].failure, "unsafe-partial-state", scenario.name);
    assert.equal(result.results[0].session, null, scenario.name);
    assert.equal(result.partialEffects, true, scenario.name);
    assert.deepEqual(result.unsafeEvidence, [{ assignmentId: "a", writeScope: ["owned/a"] }], scenario.name);
    assert.ok(sibling.state.aborts >= 1, scenario.name);
    assert.equal(retry.state.prompts.length, 0, scenario.name);
    assert.equal(sessionStore.size, 0, scenario.name);
    assert.deepEqual(result.report.reusableSessionReferences, [], scenario.name);
  }
});

test("pre-execution ambiguous bash denial remains recoverable without aborting sibling work", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-ambiguous-bash-"));
  const diagnostic = "git status --short && printf '\\n-- candidates --\\n' && rg -l 'REVIEW-001|REVIEW-002' . | head -80";
  const toolSets = new Map();
  const nativeBashContext = {
    sessionManager: {
      getSessionId: () => "ambiguous-bash-test",
      getSessionFile: () => undefined,
    },
  };
  const inspectingChild = fakeSession({ prompt: async ({ listeners }) => {
    const bash = toolSets.get("inspect").find((tool) => tool.name === "bash");
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "ambiguous-bash", toolName: "bash", args: { command: diagnostic } });
    }
    await assert.rejects(
      bash.execute("ambiguous-bash", { command: diagnostic }, undefined, undefined, nativeBashContext),
      { message: "ownership_bash_denied:shell_composition" },
    );
    for (const listener of listeners) {
      listener({ type: "tool_execution_end", toolCallId: "ambiguous-bash", toolName: "bash", isError: true });
    }
  } });
  const sibling = fakeSession();
  try {
    const result = await run({
      cwd: root,
      assignments: [assignment("inspect", ["owned/a"]), assignment("sibling", ["owned/b"])],
      sessions: [{ session: inspectingChild.session }, { session: sibling.session }],
      scopedTools: (input) => {
        const tools = createScopedTools(input);
        toolSets.set(input.assignment.id, tools);
        return tools;
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.partialEffects, false);
    assert.deepEqual(result.unsafeEvidence, []);
    assert.equal(sibling.state.aborts, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authorized absolute exact-edit failures are proven non-mutating and recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-exact-edit-"));
  const target = join(root, "owned", "file.txt");
  const toolSets = new Map();
  await mkdir(join(root, "owned"));
  await writeFile(target, "before\n");
  const child = fakeSession({ prompt: async ({ listeners }) => {
    const edit = toolSets.get("a").find((tool) => tool.name === "edit");
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "exact-edit", toolName: "edit", args: { path: `@${target}` } });
    }
    await assert.rejects(edit.execute("exact-edit", {
      path: `@${target}`,
      edits: [{ oldText: "not present", newText: "after" }],
    }, undefined, undefined, {}));
    for (const listener of listeners) {
      listener({ type: "tool_execution_end", toolCallId: "exact-edit", toolName: "edit", isError: true });
    }
  } });
  try {
    const result = await run({
      cwd: root,
      sessions: [{ session: child.session }],
      scopedTools: (input) => {
        const tools = createScopedTools(input);
        toolSets.set(input.assignment.id, tools);
        return tools;
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.partialEffects, false);
    assert.deepEqual(result.unsafeEvidence, []);
    assert.equal(child.state.aborts, 0);
    assert.equal(await readFile(target, "utf8"), "before\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mismatched trusted operation evidence fails closed after an otherwise non-mutating edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-mismatched-evidence-"));
  const target = join(root, "owned", "file.txt");
  const toolSets = new Map();
  await mkdir(join(root, "owned"));
  await writeFile(target, "before\n");
  const child = fakeSession({ prompt: async ({ listeners }) => {
    const edit = toolSets.get("a").find((tool) => tool.name === "edit");
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "actual-edit", toolName: "edit", args: { path: `@${target}` } });
    }
    await assert.rejects(edit.execute("actual-edit", {
      path: `@${target}`,
      edits: [{ oldText: "not present", newText: "after" }],
    }, undefined, undefined, {}));
    for (const listener of listeners) {
      listener({ type: "tool_execution_end", toolCallId: "mismatched-edit", toolName: "edit", isError: true });
    }
  } });
  try {
    const result = await run({
      cwd: root,
      sessions: [{ session: child.session }],
      scopedTools: (input) => {
        const tools = createScopedTools(input);
        toolSets.set(input.assignment.id, tools);
        return tools;
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].failure, "unsafe-partial-state");
    assert.equal(result.partialEffects, true);
    assert.ok(child.state.aborts >= 1);
    assert.equal(await readFile(target, "utf8"), "before\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent authorized scoped writes settle without false unsafe partial state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-concurrent-writes-"));
  const toolSets = new Map();
  await mkdir(join(root, "owned"));
  const child = fakeSession({ prompt: async ({ listeners }) => {
    const write = toolSets.get("a").find((tool) => tool.name === "write");
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "first-write", toolName: "write", args: { path: "owned/first.txt" } });
      listener({ type: "tool_execution_start", toolCallId: "second-write", toolName: "write", args: { path: "owned/second.txt" } });
    }
    await Promise.all([
      write.execute("first-write", { path: "owned/first.txt", content: "first" }, undefined, undefined, {}),
      write.execute("second-write", { path: "owned/second.txt", content: "second" }, undefined, undefined, {}),
    ]);
    for (const listener of listeners) {
      listener({ type: "tool_execution_end", toolCallId: "first-write", toolName: "write", isError: false });
      listener({ type: "tool_execution_end", toolCallId: "second-write", toolName: "write", isError: false });
    }
  } });
  try {
    const result = await run({
      cwd: root,
      sessions: [{ session: child.session }],
      scopedTools: (input) => {
        const tools = createScopedTools(input);
        toolSets.set(input.assignment.id, tools);
        return tools;
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.partialEffects, false);
    assert.deepEqual(result.unsafeEvidence, []);
    assert.equal(child.state.aborts, 0);
    assert.equal(await readFile(join(root, "owned", "first.txt"), "utf8"), "first");
    assert.equal(await readFile(join(root, "owned", "second.txt"), "utf8"), "second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted operation-level ownership denials remain recoverable in fresh delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-owned-failure-"));
  const target = join(root, "sibling", "unowned.txt");
  const toolSets = new Map();
  await mkdir(join(root, "owned"));
  await mkdir(join(root, "sibling"));
  const child = fakeSession({ prompt: async ({ listeners }) => {
    const write = toolSets.get("a").find((tool) => tool.name === "write");
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "unowned-write", toolName: "write", args: { path: "sibling/unowned.txt" } });
    }
    await assert.rejects(write.execute("unowned-write", {
      path: "sibling/unowned.txt",
      content: "blocked",
    }, undefined, undefined, {}));
    for (const listener of listeners) {
      listener({ type: "tool_execution_end", toolCallId: "unowned-write", toolName: "write", isError: true });
    }
  } });
  try {
    const result = await run({
      cwd: root,
      sessions: [{ session: child.session }],
      scopedTools: (input) => {
        const tools = createScopedTools(input);
        toolSets.set(input.assignment.id, tools);
        return tools;
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].failure, undefined);
    assert.equal(result.partialEffects, false);
    assert.equal(child.state.aborts, 0);
    assert.deepEqual(result.unsafeEvidence, []);
    assert.equal(existsSync(target), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh exceptional exit fails closed when a trusted pre-entry denial has no matching end", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-unsettled-denial-"));
  const target = join(root, "sibling", "blocked.txt");
  const toolSets = new Map();
  const child = fakeSession({ prompt: async ({ listeners }) => {
    const write = toolSets.get("a").find((tool) => tool.name === "write");
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "unsettled-denial", toolName: "write", args: { path: "sibling/blocked.txt" } });
    }
    await assert.rejects(write.execute("unsettled-denial", {
      path: "sibling/blocked.txt",
      content: "blocked",
    }, undefined, undefined, {}), { message: "ownership_target_out_of_scope" });
    throw new Error("provider timeout");
  } });
  const retry = fakeSession({ sessionId: "unsettled-denial-retry", sessionFile: "/sessions/unsettled-denial-retry.jsonl" });
  const sessionStore = new Map();
  try {
    await mkdir(join(root, "owned"));
    await mkdir(join(root, "sibling"));
    const result = await run({
      cwd: root,
      sessions: [{ session: child.session }, { session: retry.session }],
      sessionStore,
      scopedTools: (input) => {
        const tools = createScopedTools(input);
        toolSets.set(input.assignment.id, tools);
        return tools;
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].failure, "unsafe-partial-state");
    assert.equal(result.results[0].session, null);
    assert.equal(result.partialEffects, true);
    assert.ok(child.state.aborts >= 1);
    assert.equal(retry.state.prompts.length, 0);
    assert.equal(sessionStore.size, 0);
    assert.deepEqual(result.report.reusableSessionReferences, []);
    assert.equal(existsSync(target), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted containment and symlink denials remain recoverable before mutation entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-trusted-denials-"));
  const outside = await mkdtemp(join(tmpdir(), "ima-agent-trusted-denials-outside-"));
  try {
    await mkdir(join(root, "owned"));
    await symlink(outside, join(root, "owned", "escape"));
    const cases = [
      { name: "containment", path: `@${join(outside, "blocked.txt")}`, cause: "ownership_target_outside_project", target: join(outside, "blocked.txt") },
      { name: "symlink", path: "owned/escape/blocked.txt", cause: "ownership_symlink_escape", target: join(outside, "blocked.txt") },
    ];
    for (const scenario of cases) {
      const toolSets = new Map();
      const child = fakeSession({ prompt: async ({ listeners }) => {
        const write = toolSets.get("a").find((tool) => tool.name === "write");
        for (const listener of listeners) {
          listener({ type: "tool_execution_start", toolCallId: `${scenario.name}-write`, toolName: "write", args: { path: scenario.path } });
        }
        await assert.rejects(write.execute(`${scenario.name}-write`, {
          path: scenario.path,
          content: "blocked",
        }, undefined, undefined, {}), { message: scenario.cause });
        for (const listener of listeners) {
          listener({ type: "tool_execution_end", toolCallId: `${scenario.name}-write`, toolName: "write", isError: true });
        }
      } });
      const result = await run({
        cwd: root,
        sessions: [{ session: child.session }],
        scopedTools: (input) => {
          const tools = createScopedTools(input);
          toolSets.set(input.assignment.id, tools);
          return tools;
        },
      });
      assert.equal(result.status, "succeeded", scenario.name);
      assert.equal(result.partialEffects, false, scenario.name);
      assert.deepEqual(result.unsafeEvidence, [], scenario.name);
      assert.equal(existsSync(scenario.target), false, scenario.name);
    }
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("fresh delegation retains the first trusted safe cause when the child later fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-safe-cause-"));
  const toolSets = new Map();
  await mkdir(join(root, "owned"));
  await mkdir(join(root, "sibling"));
  const child = fakeSession({
    text: "",
    state: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "child contract failed", content: [] }] },
    prompt: async ({ listeners }) => {
      const write = toolSets.get("a").find((tool) => tool.name === "write");
      for (const listener of listeners) {
        listener({ type: "tool_execution_start", toolCallId: "safe-cause-write", toolName: "write", args: { path: "sibling/blocked.txt" } });
      }
      await assert.rejects(write.execute("safe-cause-write", {
        path: "sibling/blocked.txt",
        content: "blocked",
      }, undefined, undefined, {}));
      for (const listener of listeners) {
        listener({ type: "tool_execution_end", toolCallId: "safe-cause-write", toolName: "write", isError: true });
      }
    },
  });
  try {
    const result = await run({
      cwd: root,
      sessions: [{ session: child.session }],
      scopedTools: (input) => {
        const tools = createScopedTools(input);
        toolSets.set(input.assignment.id, tools);
        return tools;
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].error, "ownership_target_out_of_scope");
    assert.equal(result.results[0].failure, "terminal");
    assert.equal(result.partialEffects, false);
    assert.deepEqual(result.unsafeEvidence, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-mkdir injected write failures immediately latch unsafe fresh delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-write-failure-"));
  const target = join(root, "owned", "result.txt");
  const toolSets = new Map();
  const enteredEffects = [];
  await mkdir(join(root, "owned"));
  const child = fakeSession({ prompt: async ({ listeners }) => {
    const write = toolSets.get("a").find((tool) => tool.name === "write");
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "injected-write", toolName: "write", args: { path: `@${target}` } });
    }
    await assert.rejects(write.execute("injected-write", {
      path: `@${target}`,
      content: "must not persist",
    }, undefined, undefined, {}));
    for (const listener of listeners) {
      listener({ type: "tool_execution_end", toolCallId: "injected-write", toolName: "write", isError: true });
    }
  } });
  try {
    const result = await run({
      cwd: root,
      sessions: [{ session: child.session }],
      scopedTools: (input) => {
        const tools = createScopedTools({
          ...input,
          operations: {
            mkdir: async (path, options) => {
              enteredEffects.push("mkdir");
              await mkdir(path, options);
            },
            writeFile: async () => {
              enteredEffects.push("writeFile");
              throw new Error("injected_write_failure");
            },
          },
        });
        toolSets.set(input.assignment.id, tools);
        return tools;
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].failure, "unsafe-partial-state");
    assert.equal(result.partialEffects, true);
    assert.deepEqual(enteredEffects, ["mkdir", "writeFile"]);
    assert.ok(child.state.aborts >= 1);
    assert.equal(existsSync(target), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing mutation-operation evidence fails closed in fresh delegation", async () => {
  const child = fakeSession({ prompt: ({ listeners }) => {
    for (const listener of listeners) {
      listener({ type: "tool_execution_end", toolCallId: "missing-evidence", toolName: "edit", isError: true });
    }
  } });
  const result = await run({ sessions: [{ session: child.session }] });
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].attempts, 1);
  assert.equal(result.results[0].failure, "unsafe-partial-state");
  assert.equal(result.partialEffects, true);
  assert.ok(child.state.aborts >= 1);
});

test("missing correlated mutation evidence remains unsafe for fresh delegated-agent observers", async () => {
  const cases = [
    { path: "@owned/file.txt", status: "failed", partialEffects: true },
    { path: "@/repo/owned/file.txt", status: "failed", partialEffects: true },
    { path: "@@owned/file.txt", status: "failed", partialEffects: true },
    { path: "@outside/file.txt", status: "failed", partialEffects: true },
  ];
  for (const scenario of cases) {
    const child = fakeSession({ prompt: ({ listeners }) => {
      for (const listener of listeners) {
        listener({ type: "tool_execution_start", toolName: "write", args: { path: scenario.path } });
      }
    } });
    const result = await run({ sessions: [{ session: child.session }] });
    assert.equal(result.status, scenario.status, scenario.path);
    assert.equal(result.partialEffects, scenario.partialEffects, scenario.path);
  }
});

test("retries one transient provider failure in a fresh session and never retries contract failures", async () => {
  const transient = fakeSession({ state: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider timeout", content: [] }] }, text: "" });
  const success = fakeSession({ sessionId: "fresh", sessionFile: "/sessions/fresh.jsonl" });
  const recovered = await run({ sessions: [{ session: transient.session }, { session: success.session }] });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.results[0].attempts, 2);
  assert.equal(recovered.results[0].session?.id, "fresh");
  assert.equal(transient.state.disposes, 1); assert.equal(success.state.disposes, 1);

  const contractFailure = fakeSession({ text: "normal child report" });
  contractFailure.session.model = { provider: "p", id: "other" };
  const notUsed = fakeSession();
  const failed = await run({ sessions: [{ session: contractFailure.session }, { session: notUsed.session }] });
  assert.equal(failed.status, "failed");
  assert.equal(failed.results[0].attempts, 1);
  assert.equal(notUsed.state.prompts.length, 0);
});

test("idle is not success when terminal report or observed identity is invalid", async () => {
  const wrongIdentity = fakeSession({ text: "Child report that remains unverified.", prompt: ({ session }) => { session.model = { provider: "p", id: "other" }; } });
  const sessionStore = new Map();
  const result = await run({ sessions: [{ session: wrongIdentity.session }], sessionStore });
  assert.equal(result.status, "failed");
  assert.ok(result.results[0].completion.includes("runtime_identity_mismatch"));
  assert.equal(result.results[0].report, undefined);
  assert.equal(result.results[0].unverifiedReport, undefined);
  assert.equal(result.results[0].summary, "Child report that remains unverified.");
  assert.equal(result.results[0].unverifiedReason, "runtime_identity_mismatch");
  assert.deepEqual(result.results[0].session, { id: "session", file: "/sessions/session.jsonl", resumeReference: null });
  assert.equal(sessionStore.has("a"), false);
});

test("emits ordered sanitized route, start, tool, and success activity with a final report", async () => {
  const snapshots = [];
  const child = fakeSession({ prompt: ({ listeners }) => {
    for (const listener of listeners) {
      listener({ type: "agent_start" });
      listener({ type: "tool_execution_start", toolName: "read", args: { path: "/secret/credentials", token: "secret" } });
    }
  } });
  const result = await run({ sessions: [{ session: child.session }], onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(snapshots.map((snapshot) => snapshot.children[0].state), ["pending", "starting", "running", "running", "succeeded", "succeeded"]);
  assert.equal(snapshots[3].children[0].activity, "tool:read");
  assert.doesNotMatch(JSON.stringify(snapshots), /credentials|token|secret/);
  assert.equal(result.activity.state, "succeeded");
  assert.equal(result.report.state, "succeeded");
  assert.equal(result.report.children[0].resumeReference, "a");
});

test("transient retry is visible and attempt two remains the maximum", async () => {
  const snapshots = [];
  const transient = fakeSession({ state: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider timeout", content: [] }] }, text: "" });
  const success = fakeSession();
  const result = await run({ sessions: [{ session: transient.session }, { session: success.session }], onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "succeeded");
  const retry = snapshots.find((snapshot) => snapshot.children[0].state === "retrying").children[0];
  assert.equal(retry.attempt, 2);
  assert.equal(retry.retryReason, "transient-provider");
  assert.equal(result.results[0].attempts, 2);
});

test("abort activity is emitted before child abort, preserves a completed sibling, and discloses writer scope", async () => {
  const controller = new AbortController();
  const snapshots = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let abortSawCancelling = false;
  const completed = fakeSession();
  const writing = fakeSession({ waitForIdle: () => gate, abort: () => { abortSawCancelling = snapshots.some((snapshot) => snapshot.children[1]?.state === "cancelling"); release(); } });
  const promise = run({
    assignments: [assignment("done", []), assignment("writing", ["owned/write"])],
    sessions: [{ session: completed.session }, { session: writing.session }], signal: controller.signal,
    onActivity: (snapshot) => snapshots.push(snapshot),
  });
  for (let i = 0; i < 20 && !snapshots.some((snapshot) => snapshot.children[0].state === "succeeded"); i += 1) await Promise.resolve();
  controller.abort();
  const result = await promise;
  assert.equal(abortSawCancelling, true);
  assert.equal(result.status, "cancelled");
  assert.equal(result.activity.children[0].state, "succeeded");
  assert.equal(result.activity.children[1].state, "cancelled");
  assert.deepEqual(result.report.partialState.possibleWriteScopes, ["owned/write"]);
  assert.equal(result.report.children[1].resumeReference, null);
  assert.equal(result.report.safeNextAction.code, "inspect-partial-state");
});

test("unsafe mutation emits visible interception and reports unsafe partial state", async () => {
  const snapshots = [];
  const child = fakeSession({ prompt: ({ listeners }) => { for (const listener of listeners) listener({ type: "tool_execution_start", toolName: "write", args: { path: "outside/file" } }); } });
  const result = await run({ sessions: [{ session: child.session }], onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "failed");
  assert.ok(snapshots.some((snapshot) => snapshot.children[0].activity === "safety:intercepted"));
  assert.equal(result.report.safeNextAction.code, "correct-safety-boundary");
  assert.deepEqual(result.report.partialState.unsafeAssignmentIds, ["a"]);
});

test("missing exact model blocks without creating a child and exposes escalation", async () => {
  let created = false;
  const snapshots = [];
  const missingRuntime = { getModels: () => [], getModel: () => undefined };
  const result = await run({ sessions: [{ session: fakeSession().session }], selectedRuntime: missingRuntime, onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].status, "blocked");
  assert.equal(result.results[0].attempts, 0);
  assert.match(result.activity.children[0].escalation, /minimum capability/);
  assert.equal(result.report.safeNextAction.code, "restore-exact-model");
  assert.equal(created, false);
});

test("credential-like provider errors are redacted from activity and outcome reports", async () => {
  const snapshots = [];
  const child = fakeSession({
    state: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "authorization=BearerVerySecret quota exceeded", content: [] }] },
    text: "",
  });
  const result = await run({ sessions: [{ session: child.session }], onActivity: (snapshot) => snapshots.push(snapshot) });
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].attempts, 1);
  assert.equal(result.report.safeNextAction.code, "restore-exact-model");
  assert.match(result.report.blocker, /authorization=\[redacted\] quota exceeded/);
  assert.doesNotMatch(JSON.stringify({ snapshots, result }), /BearerVerySecret/);
});

test("throwing activity observer never changes coordinator completion or cleanup", async () => {
  const child = fakeSession();
  const result = await run({ sessions: [{ session: child.session }], onActivity: () => { throw new Error("projection failed"); } });
  assert.equal(result.status, "succeeded");
  assert.equal(child.state.disposes, 1);
  assert.equal(child.state.unsubscribes, 1);
});


test("documenter tools refuse code targets even when ownership is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-documenter-"));
  await mkdir(join(root, "docs")); await mkdir(join(root, "lib"));
  const documenter = { ...agent, name: "documenter", authority: "document-write", tools: ["write", "edit", "bash"], result: { kind: "documentation", requiredSections: ["local-changes"] } };
  const docsAssignment = { ...assignment("docs", ["docs/readme.md"]), writeScope: ["docs/readme.md"] };
  const tools = createScopedTools({ cwd: root, assignment: docsAssignment, agent: documenter });
  const write = tools.find((tool) => tool.name === "write");
  await write.execute("call", { path: "docs/readme.md", content: "ok" }, undefined, undefined, {});
  await assert.rejects(write.execute("call", { path: "lib/unsafe.ts", content: "no" }, undefined, undefined, {}));
});

test("documenter permits only exact owned documentation targets and rejects code and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-documenter-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "ima-documenter-outside-"));
  await mkdir(join(root, "docs")); await mkdir(join(root, "lib"));
  await writeFile(join(root, "docs", "FNR-3019.md"), "before\n");
  await symlink(outside, join(root, "docs", "escape"));
  const documenter = { ...agent, name: "documenter", authority: "document-write", tools: ["write", "edit", "bash"], result: { kind: "documentation", requiredSections: ["local-changes"] } };
  const docsAssignment = { ...assignment("docs", ["docs/FNR-3019.md", "docs/README"]), writeScope: ["docs/FNR-3019.md", "docs/README"] };
  const tools = new Map(createScopedTools({ cwd: root, assignment: docsAssignment, agent: documenter }).map((tool) => [tool.name, tool]));
  const invoke = (name, args) => tools.get(name).execute("call", args, undefined, undefined, {});

  await invoke("edit", { path: "docs/FNR-3019.md", edits: [{ oldText: "before", newText: "after" }] });
  await invoke("write", { path: "docs/README", content: "guide" });
  assert.equal(await readFile(join(root, "docs", "FNR-3019.md"), "utf8"), "after\n");
  assert.equal(await readFile(join(root, "docs", "README"), "utf8"), "guide");

  for (const args of [
    { path: "lib/unsafe.ts", content: "no" },
    { path: "docs/escape/unsafe.md", content: "no" },
  ]) await assert.rejects(invoke("write", args));
  assert.equal(existsSync(join(root, "lib", "unsafe.ts")), false);
  assert.equal(existsSync(join(outside, "unsafe.md")), false);
});

test("documenter rejects prohibited documentation-looking locations at construction and effect time", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-documenter-prohibited-"));
  for (const directory of ["docs", "config", "tests", "lib", "extensions", "migrations"]) await mkdir(join(root, directory));
  const documenter = { ...agent, name: "documenter", authority: "document-write", tools: ["write", "edit", "bash"], result: { kind: "documentation", requiredSections: ["local-changes"] } };
  assert.throws(() => createScopedTools({ cwd: root, assignment: { ...assignment("bad"), writeScope: ["config/other.md"] }, agent: documenter }));
  const tools = new Map(createScopedTools({ cwd: root, assignment: { ...assignment("docs"), writeScope: ["docs/guide.md"] }, agent: documenter }).map((tool) => [tool.name, tool]));
  for (const [name, args] of [["write", { path: "config/other.md", content: "no" }], ["edit", { path: "lib/design.md", edits: [] }], ["bash", { command: "echo no > tests/notes.md" }]]) await assert.rejects(tools.get(name).execute("call", args, undefined, undefined, {}));
});

test("documenter final-target authorization rejects code aliases and preserves documentation-only aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-documenter-final-target-"));
  const modulePath = join(root, "lib", "module.ts");
  const moduleContent = "export const value = 'before';\n";
  const documenter = { ...agent, name: "documenter", authority: "document-write", tools: ["write", "edit", "bash"], result: { kind: "documentation", requiredSections: ["local-changes"] } };
  const nativeBashContext = {
    sessionManager: {
      getSessionId: () => "documenter-final-target",
      getSessionFile: () => undefined,
    },
  };
  let bashEffects = 0;
  try {
    await mkdir(join(root, "lib"));
    await writeFile(modulePath, moduleContent);
    await symlink("lib/module.ts", join(root, "README.md"));
    const codeAliasTools = new Map(createScopedTools({
      cwd: root,
      assignment: { ...assignment("readme", ["README.md"]), agent: "documenter", paths: ["README.md"], writeScope: ["README.md"] },
      agent: documenter,
      operations: {
        bash: {
          exec: async () => {
            bashEffects += 1;
            return { exitCode: 0 };
          },
        },
      },
    }).map((tool) => [tool.name, tool]));

    await assert.rejects(
      codeAliasTools.get("write").execute("readme-write", { path: "README.md", content: "overwritten\n" }, undefined, undefined, {}),
      { message: "documentation_target_required" },
    );
    await assert.rejects(
      codeAliasTools.get("edit").execute("readme-edit", { path: "README.md", edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined, {}),
      /documentation_target_required/,
    );
    await assert.rejects(
      codeAliasTools.get("bash").execute("readme-bash", { command: "echo blocked > README.md" }, undefined, undefined, nativeBashContext),
      { message: "documentation_target_required" },
    );
    assert.equal(bashEffects, 0);
    assert.equal(await readFile(modulePath, "utf8"), moduleContent);

    const newGuide = "docs/new/guide.md";
    const newGuideTools = new Map(createScopedTools({
      cwd: root,
      assignment: { ...assignment("new-guide", [newGuide]), agent: "documenter", paths: [newGuide], writeScope: [newGuide] },
      agent: documenter,
    }).map((tool) => [tool.name, tool]));
    await newGuideTools.get("write").execute("new-guide-write", { path: newGuide, content: "first\n" }, undefined, undefined, {});
    assert.equal(await readFile(join(root, newGuide), "utf8"), "first\n");

    await symlink("new/guide.md", join(root, "docs", "alias.md"));
    const documentationAliasTools = new Map(createScopedTools({
      cwd: root,
      assignment: { ...assignment("documentation-alias", ["docs/alias.md"]), agent: "documenter", paths: ["docs/alias.md"], writeScope: ["docs/alias.md"] },
      agent: documenter,
    }).map((tool) => [tool.name, tool]));
    await documentationAliasTools.get("write").execute("documentation-alias-write", { path: "docs/alias.md", content: "aliased\n" }, undefined, undefined, {});
    assert.equal(await readFile(join(root, newGuide), "utf8"), "aliased\n");

    await rm(join(root, "docs"), { recursive: true, force: true });
    await writeFile(join(root, "lib", "notes.md"), "code notes\n");
    await symlink("lib", join(root, "docs"));
    const directoryAliasEditTools = new Map(createScopedTools({
      cwd: root,
      assignment: { ...assignment("directory-alias-edit", ["docs/notes.md"]), agent: "documenter", paths: ["docs/notes.md"], writeScope: ["docs/notes.md"] },
      agent: documenter,
    }).map((tool) => [tool.name, tool]));
    const directoryAliasWriteTools = new Map(createScopedTools({
      cwd: root,
      assignment: { ...assignment("directory-alias-write", ["docs/created.md"]), agent: "documenter", paths: ["docs/created.md"], writeScope: ["docs/created.md"] },
      agent: documenter,
    }).map((tool) => [tool.name, tool]));
    await assert.rejects(
      directoryAliasEditTools.get("edit").execute("directory-alias-edit", { path: "docs/notes.md", edits: [{ oldText: "code", newText: "changed" }] }, undefined, undefined, {}),
      /documentation_target_required/,
    );
    await assert.rejects(
      directoryAliasWriteTools.get("write").execute("directory-alias-write", { path: "docs/created.md", content: "blocked\n" }, undefined, undefined, {}),
      { message: "documentation_target_required" },
    );
    assert.equal(await readFile(join(root, "lib", "notes.md"), "utf8"), "code notes\n");
    assert.equal(existsSync(join(root, "lib", "created.md")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh documenter alias denial is recoverable with no forbidden effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-documenter-fresh-alias-"));
  const modulePath = join(root, "lib", "module.ts");
  const moduleContent = "export const value = 'before';\n";
  const documenter = { ...agent, name: "documenter", authority: "document-write", tools: ["write", "edit", "bash"], result: { kind: "documentation", requiredSections: ["local-changes"] } };
  const docsAssignment = { ...assignment("documenter", ["README.md"]), agent: "documenter", paths: ["README.md"], expectedOutput: "local-changes", writeScope: ["README.md"] };
  const sessionStore = new Map();
  let tools;
  let created = 0;
  const child = fakeSession({ text: "## Local-changes\nnone", prompt: async ({ listeners }) => {
    const write = tools.find((tool) => tool.name === "write");
    for (const listener of listeners) {
      listener({ type: "tool_execution_start", toolCallId: "fresh-readme-write", toolName: "write", args: { path: "README.md" } });
    }
    await assert.rejects(
      write.execute("fresh-readme-write", { path: "README.md", content: "blocked\n" }, undefined, undefined, {}),
      { message: "documentation_target_required" },
    );
    for (const listener of listeners) {
      listener({ type: "tool_execution_end", toolCallId: "fresh-readme-write", toolName: "write", isError: true });
    }
  } });
  try {
    await mkdir(join(root, "lib"));
    await writeFile(modulePath, moduleContent);
    await symlink("lib/module.ts", join(root, "README.md"));
    const result = await run({
      cwd: root,
      assignments: [docsAssignment],
      selectedAgent: documenter,
      sessionStore,
      scopedTools: createScopedTools,
      createSession: async ({ customTools }) => {
        created += 1;
        tools = customTools;
        return { session: child.session };
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].failure, undefined);
    assert.equal(result.results[0].session?.resumeReference, "documenter");
    assert.equal(result.report.children[0].resumeReference, "documenter");
    assert.deepEqual(result.report.reusableSessionReferences, ["documenter"]);
    assert.equal(result.partialEffects, false);
    assert.equal(created, 1);
    assert.equal(sessionStore.size, 1);
    assert.equal(child.state.aborts, 0);
    assert.equal(await readFile(modulePath, "utf8"), moduleContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivers admitted vision images through Pi prompt options without projecting bytes or paths", async () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment("visual", []), agent: "vision-handoff", imagePaths: ["/tmp/evidence.png"] };
  const child = fakeSession({ text: "## Source-access\naccessible" });
  child.session.model = { provider: "p", id: "vision" };
  const runtimeWithVision = { getModels: () => [{ provider: "p", id: "vision", input: ["text", "image"] }], getModel: () => ({ provider: "p", id: "vision" }) };
  const result = await coordinateDelegation({ cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: runtimeWithVision, dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1, admitImages: async () => ({ admitted: true, value: [{ source: { id: "opaque", sourceLabel: "evidence.png", mimeType: "image/png", byteLength: 8, absolutePath: "/tmp/evidence.png" }, attachment: { type: "image", data: "cHJpdmF0ZQ==", mimeType: "image/png" } }] }), createSession: async () => ({ session: child.session }) } });
  assert.equal(result.status, "succeeded");
  assert.equal(child.state.prompts.length, 1);
  assert.equal(child.state.prompts[0].options.images[0].data, "cHJpdmF0ZQ==");
  assert.doesNotMatch(JSON.stringify(result), /cHJpdmF0ZQ==|\/tmp\/evidence\.png/);
});

test("blocks all vision delivery before session creation when any local image admission fails", async () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment("visual", []), agent: "vision-handoff", imagePaths: ["/tmp/first.png", "/tmp/unreadable.png"] };
  let created = false;
  const result = await coordinateDelegation({
    cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: { getModels: () => [{ provider: "p", id: "vision", input: ["text", "image"] }], getModel: () => ({ provider: "p", id: "vision" }) },
    dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1, admitImages: async () => ({ admitted: false, error: "image_not_found" }), createSession: async () => { created = true; return { session: fakeSession().session }; } },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].status, "blocked");
  assert.equal(result.results[0].error, "image_not_found");
  assert.equal(created, false);
  assert.doesNotMatch(JSON.stringify(result), /\/tmp\/(first|unreadable)\.png/);
});

test("keeps text-only delegation on the original prompt call shape", async () => {
  const child = fakeSession();
  const result = await run({ sessions: [{ session: child.session }] });
  assert.equal(result.status, "succeeded");
  assert.equal(child.state.prompts.length, 1);
  assert.equal(child.state.prompts[0].options, undefined);
});


test("unavailable model and pre-aborted signal never admit local images", async () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment("visual", []), agent: "vision-handoff", imagePaths: ["/tmp/evidence.png"] };
  let admissions = 0;
  const dependencies = { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1, admitImages: async () => { admissions += 1; return { admitted: true, value: [] }; }, createSession: async () => { assert.fail("session must not be created"); } };
  const unavailable = await coordinateDelegation({ cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: { getModels: () => [], getModel: () => undefined }, dependencies });
  assert.equal(unavailable.results[0].error, "model_unavailable");
  assert.equal(admissions, 0);
  const controller = new AbortController(); controller.abort();
  const availableRuntime = { getModels: () => [{ provider: "p", id: "vision", input: ["text", "image"] }], getModel: () => ({ provider: "p", id: "vision" }) };
  const aborted = await coordinateDelegation({ cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: availableRuntime, signal: controller.signal, dependencies });
  assert.equal(aborted.status, "cancelled");
  assert.equal(admissions, 0);
});

test("cancellation during image admission prevents child session creation", async () => {
  const vision = { ...agent, name: "vision-handoff", tier: "vision", authority: "vision-read", tools: ["read", "image"], result: { kind: "vision", requiredSections: ["source-access"] } };
  const visual = { ...assignment("visual", []), agent: "vision-handoff", imagePaths: ["/tmp/evidence.png"] };
  const controller = new AbortController();
  let release; const admitted = new Promise((resolve) => { release = resolve; });
  let created = 0;
  const runtimeWithVision = { getModels: () => [{ provider: "p", id: "vision", input: ["text", "image"] }], getModel: () => ({ provider: "p", id: "vision" }) };
  const promise = coordinateDelegation({ cwd: "/repo", request: { title: "visual", assignments: [visual] }, agents: [vision], config: { models: { vision: { provider: "p", model: "vision", thinking: "high" } } }, runtime: runtimeWithVision, signal: controller.signal, dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1, admitImages: () => admitted, createSession: async () => { created += 1; return { session: fakeSession().session }; } } });
  await Promise.resolve(); controller.abort(); release({ admitted: true, value: [] });
  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.equal(created, 0);
});

test("blocks malformed adversarial packets before session creation and runs a matching pair on distinct routes", async () => {
  const adversaryA = { ...agent, name: "adversary-a", tier: "adversaryA", authority: "review-read", tools: ["read"], independence: { freshInitial: true, followUpAllowed: false }, result: { kind: "review", requiredSections: ["model-route", "verdict", "findings", "disproof-attempts", "confidence"] } };
  const adversaryB = { ...adversaryA, name: "adversary-b", tier: "adversaryB" };
  const adversaryAAssignment = { ...assignment("a", []), agent: "adversary-a" };
  const adversaryBAssignment = { ...adversaryAAssignment, id: "b", agent: "adversary-b" };
  const reject = async (assignments, expectedError) => {
    let created = 0;
    const result = await coordinateDelegation({
      cwd: "/repo", request: { title: "adversarial", assignments }, agents: [adversaryA, adversaryB], config: { models: {} }, runtime, runId: "adversarial", sessionStore: new Map(),
      dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1_000, createSession: async () => { created += 1; return { session: fakeSession().session }; } },
    });
    assert.equal(result.status, "failed");
    assert.equal(created, 0);
    assert.deepEqual(result.results.map(({ status, attempts, error, failure }) => ({ status, attempts, error, failure })), assignments.map(() => ({ status: "blocked", attempts: 0, error: expectedError, failure: "agent-contract" })));
  };

  await reject([adversaryAAssignment], "delegation_adversary_pair_required");
  await reject([adversaryAAssignment, { ...adversaryBAssignment, context: "Different evidence" }], "delegation_adversary_packet_mismatch");

  let missingRouteSessions = 0;
  const missingRoute = await coordinateDelegation({
    cwd: "/repo", request: { title: "adversarial", assignments: [adversaryAAssignment, adversaryBAssignment] }, agents: [adversaryA, adversaryB],
    config: { models: { adversaryA: { provider: "p", model: "a", thinking: "high" } } }, runtime: { getModels: () => [{ provider: "p", id: "a", input: ["text"] }], getModel: () => ({ provider: "p", id: "a" }) }, runId: "adversarial", sessionStore: new Map(),
    dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1_000, createSession: async () => { missingRouteSessions += 1; return { session: fakeSession().session }; } },
  });
  assert.equal(missingRouteSessions, 0);
  assert.deepEqual(missingRoute.results.map(({ error }) => error), ["adversary_route_unconfigured", "adversary_route_unconfigured"]);

  const first = fakeSession();
  first.session.model = { provider: "p", id: "a" };
  const second = fakeSession();
  second.session.model = { provider: "q", id: "b" };
  let created = 0;
  const result = await coordinateDelegation({
    cwd: "/repo", request: { title: "adversarial", assignments: [adversaryAAssignment, adversaryBAssignment] }, agents: [adversaryA, adversaryB],
    config: { models: { adversaryA: { provider: "p", model: "a", thinking: "high" }, adversaryB: { provider: "q", model: "b", thinking: "high" } } }, runtime: { getModels: () => [{ provider: "p", id: "a", input: ["text"] }, { provider: "q", id: "b", input: ["text"] }], getModel: (provider, model) => ({ provider, id: model }) }, runId: "adversarial", sessionStore: new Map(),
    dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1_000, createSession: async ({ model }) => { created += 1; return { session: model.id === "a" ? first.session : second.session }; } },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(created, 2);
});

test("adversarial pairs block before child creation when routes are matching or incomplete", async () => {
  const adversaryA = { ...agent, name: "adversary-a", tier: "adversaryA", authority: "review-read", tools: ["read"], independence: { freshInitial: true, followUpAllowed: false }, result: { kind: "review", requiredSections: ["model-route", "verdict", "findings", "disproof-attempts", "confidence"] } };
  const adversaryB = { ...adversaryA, name: "adversary-b", tier: "adversaryB" };
  const assignments = [
    { ...assignment("a", []), agent: "adversary-a" },
    { ...assignment("b", []), agent: "adversary-b" },
  ];
  let created = 0;
  const result = await coordinateDelegation({
    cwd: "/repo", request: { title: "adversarial", assignments }, agents: [adversaryA, adversaryB],
    config: { models: { adversaryA: { provider: "p", model: "m" }, adversaryB: { provider: "p", model: "m" } } }, runtime, runId: "adversarial", sessionStore: new Map(),
    dependencies: { createManager: () => ({}), scopedTools: () => [], clock: () => "now", activityClock: () => 1_000, createSession: async () => { created += 1; return { session: fakeSession().session }; } },
  });
  assert.equal(result.status, "failed");
  assert.equal(created, 0);
  assert.deepEqual(result.results.map(({ error }) => error), ["adversary_routes_not_distinct", "adversary_routes_not_distinct"]);
});

test("omits delegated test authority for assignments without a parent-approved verification", async () => {
  const tester = {
    ...agent,
    name: "tester",
    authority: "test-write",
    tools: ["read", "test"],
    result: { kind: "test", requiredSections: ["tests", "results", "defects"] },
  };
  const child = fakeSession({ text: "## Results\nno delegated verification" });
  let suppliedTools;
  let suppliedCustomTools;
  const result = await coordinateDelegation({
    cwd: "/repo",
    request: { title: "no verification", assignments: [{ ...assignment("no-capability"), agent: "tester" }] },
    agents: [tester],
    config,
    runtime,
    sessionStore: new Map(),
    dependencies: {
      createManager: () => ({}),
      scopedTools: createScopedTools,
      createSession: async ({ tools, customTools }) => {
        suppliedTools = tools;
        suppliedCustomTools = customTools;
        return { session: child.session };
      },
    },
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(suppliedTools, ["read"]);
  assert.equal(suppliedCustomTools.some((tool) => tool.name === "test"), false);
});

test("uses typed delegated verification with bounded activity and no retry after a settled failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-delegated-verification-"));
  const tester = {
    ...agent,
    name: "tester",
    authority: "test-write",
    tools: ["read", "test"],
    result: { kind: "test", requiredSections: ["tests", "results", "defects"] },
  };
  const verificationAssignment = {
    ...assignment("delegated-verification"),
    agent: "tester",
    verifications: [{
      id: "node-test",
      runner: "npm",
      cwd: ".",
      script: "test:unit",
      args: ["--grep=delegated"],
      timeout: 1_000,
    }],
  };
  let testTool;
  let toolOutcome;
  let created = 0;
  const executions = [];
  const activity = [];
  const child = fakeSession({
    text: "",
    state: {
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider timeout",
        content: [],
      }],
    },
    prompt: async ({ listeners }) => {
      for (const listener of listeners) {
        listener({
          type: "tool_execution_start",
          toolCallId: "delegated-test",
          toolName: "test",
          args: { id: "node-test" },
        });
      }
      toolOutcome = await testTool.execute("delegated-test", { id: "node-test" }, undefined, undefined, {});
      for (const listener of listeners) {
        listener({
          type: "tool_execution_end",
          toolCallId: "delegated-test",
          toolName: "test",
          isError: false,
        });
      }
    },
  });
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { "test:unit": "node --test" },
    }));
    const result = await coordinateDelegation({
      cwd: root,
      request: { title: "delegated verification", assignments: [verificationAssignment] },
      agents: [tester],
      config,
      runtime,
      projectTrusted: true,
      sessionStore: new Map(),
      onActivity: (snapshot) => activity.push(snapshot),
      dependencies: {
        createManager: () => ({}),
        scopedTools: createScopedTools,
        verificationExecutor: async (command, args, options) => {
          executions.push({ command, args, cwd: options.cwd, optionKeys: Object.keys(options).sort() });
          return {
            stdout: "token=delegated-secret",
            stderr: "",
            code: 1,
            killed: false,
          };
        },
        createSession: async ({ tools, customTools }) => {
          created += 1;
          assert.deepEqual(tools, ["read", "test"]);
          testTool = customTools.find((tool) => tool.name === "test");
          return { session: child.session };
        },
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].failure, "transient-provider");
    assert.equal(result.partialEffects, false);
    assert.deepEqual(result.unsafeEvidence, []);
    assert.equal(created, 1);
    assert.deepEqual(executions, [{
      command: "npm",
      args: ["run", "test:unit", "--", "--grep=delegated"],
      cwd: root,
      optionKeys: ["cwd", "signal", "timeout"],
    }]);
    assert.equal(toolOutcome.details.status, "failed");
    assert.match(toolOutcome.details.output, /token=\[redacted\]/i);
    assert.doesNotMatch(toolOutcome.details.output, /delegated-secret/);
    assert.ok(activity.some((snapshot) => snapshot.children[0].activity === "tool:test"));
    assert.doesNotMatch(JSON.stringify(activity), /delegated-secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending delegated verification latches prompt safety and blocks later effects, retry, and reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "ima-agent-pending-verification-"));
  const verifier = {
    ...agent,
    name: "verification-writer",
    tools: ["read", "write", "test"],
  };
  const verificationAssignment = {
    ...assignment("pending-verification", ["owned"]),
    agent: verifier.name,
    verifications: [{
      id: "node-test",
      runner: "npm",
      cwd: ".",
      script: "test:unit",
      args: [],
      timeout: 1_000,
    }],
  };
  const scheduled = [];
  const timer = {
    schedule: (callback, milliseconds) => {
      const entry = { callback, milliseconds, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    cancel: (entry) => { entry.cancelled = true; },
  };
  let testTool;
  let writeTool;
  let created = 0;
  let executions = 0;
  let writeEffects = 0;
  let promptLatchedUnsafe = false;
  const unsafeReasons = [];
  const activity = [];
  let signalExecutorStart;
  const executorStarted = new Promise((resolve) => { signalExecutorStart = resolve; });
  const child = fakeSession({
    prompt: async () => {
      const controller = new AbortController();
      const pending = testTool.execute("pending-verification", { id: "node-test" }, controller.signal, undefined, {});
      await executorStarted;
      controller.abort();
      for (let attempt = 0; attempt < 4 && scheduled.length < 2; attempt += 1) await Promise.resolve();
      promptLatchedUnsafe = unsafeReasons.includes("delegated_verification_cancelled")
        && activity.some((snapshot) => snapshot.children[0].activity === "safety:intercepted");
      assert.equal(scheduled.length, 2);
      assert.equal(scheduled[1].milliseconds, DELEGATED_VERIFICATION_CLEANUP_TIMEOUT_MS);
      scheduled[1].callback();
      await assert.rejects(pending, { message: "delegated_verification_process_cleanup_unverified" });
      await assert.rejects(
        testTool.execute("verification-reuse", { id: "node-test" }, undefined, undefined, {}),
        { message: "delegated_verification_process_cleanup_unverified" },
      );
      await assert.rejects(
        writeTool.execute("blocked-write", { path: "owned/later.txt", content: "blocked" }, undefined, undefined, {}),
        { message: "delegated_verification_process_cleanup_unverified" },
      );
    },
  });
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { "test:unit": "node --test" },
    }));
    const result = await coordinateDelegation({
      cwd: root,
      request: { title: "pending verification", assignments: [verificationAssignment] },
      agents: [verifier],
      config,
      runtime,
      projectTrusted: true,
      sessionStore: new Map(),
      onActivity: (snapshot) => activity.push(snapshot),
      dependencies: {
        createManager: () => ({}),
        scopedTools: (input) => createScopedTools({
          ...input,
          onVerificationUnsafe: (reason) => {
            unsafeReasons.push(reason);
            input.onVerificationUnsafe?.(reason);
          },
          operations: {
            writeFile: async () => { writeEffects += 1; },
          },
        }),
        verificationExecutor: async () => new Promise(() => {
          executions += 1;
          signalExecutorStart();
        }),
        verificationTimer: timer,
        createSession: async ({ customTools }) => {
          created += 1;
          testTool = customTools.find((tool) => tool.name === "test");
          writeTool = customTools.find((tool) => tool.name === "write");
          return { session: child.session };
        },
      },
    });

    assert.equal(promptLatchedUnsafe, true);
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].failure, "unsafe-partial-state");
    assert.equal(result.results[0].error, "delegated_verification_process_cleanup_unverified");
    assert.equal(result.partialEffects, true);
    assert.deepEqual(result.unsafeEvidence, [{ assignmentId: "pending-verification", writeScope: ["owned"] }]);
    assert.equal(created, 1);
    assert.equal(executions, 1);
    assert.equal(writeEffects, 0);
    assert.equal(existsSync(join(root, "owned", "later.txt")), false);
    assert.deepEqual(result.report.reusableSessionReferences, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
