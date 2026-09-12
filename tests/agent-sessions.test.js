import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runFocusedContinuation } from "../extensions/agents.ts";
import { agentContractFingerprint, canResumeSession } from "../lib/ima-delegation.ts";

const agent = {
  schemaVersion: 1, name: "implementer", description: "Implement", tier: "MID", authority: "write",
  tools: ["read", "write"], skills: [], delegation: { allowed: false, maxDepth: 0 },
  independence: { freshInitial: false, followUpAllowed: true }, result: { kind: "implementation", requiredSections: ["files", "verification"] },
  escalation: ["scope"], prompt: "Implement safely.", source: "package", path: "/agents/implementer.md",
};
const makeRecord = (overrides = {}) => {
  const writeScope = overrides.writeScope ?? ["lib/a"];
  return {
    agent: agent.name, followUpAllowed: true, sessionFile: "/sessions/a.jsonl", reference: "a", role: "write", resultKind: "implementation",
    provider: "p", model: "m", thinking: "high", sessionId: "s", writeScope, status: "succeeded", fresh: false,
    contractFingerprint: agentContractFingerprint(agent, writeScope), createdAt: "old", updatedAt: "old", ...overrides,
  };
};
const runtime = { getModel: (provider, model) => provider === "p" && model === "m" ? { provider, id: model } : undefined };
const report = "## Files\nlib/a/file.ts\n\n## Verification\npassed";

const fakeSession = (overrides = {}) => {
  const reportText = overrides.text ?? report;
  const state = { prompts: [], aborts: 0, waits: 0, disposes: 0, unsubscribes: 0 };
  const listeners = [];
  const session = {
    messages: overrides.messages ?? [{ role: "assistant", stopReason: "stop", content: reportText ? [{ type: "text", text: reportText }] : [] }],
    model: overrides.model ?? { provider: "p", id: "m" }, thinkingLevel: overrides.thinking ?? "high",
    sessionId: overrides.sessionId ?? "s", sessionFile: overrides.sessionFile ?? "/sessions/a.jsonl",
    subscribe: (listener) => {
      listeners.push(listener);
      return () => { state.unsubscribes += 1; };
    },
    prompt: async (brief) => { state.prompts.push(brief); await overrides.prompt?.({ listeners, session }); },
    waitForIdle: () => { state.waits += 1; return overrides.waitForIdle?.({ listeners, session, state }); },
    getLastAssistantText: () => reportText,
    dispose: () => { state.disposes += 1; return overrides.dispose?.({ listeners, session, state }); },
    abort: () => { state.aborts += 1; return overrides.abort?.({ listeners, session, state }); },
  };
  return { state, session };
};

const continuation = ({
  record = makeRecord(),
  definition = agent,
  fake = fakeSession(),
  modelRuntime = runtime,
  exists = true,
  manager = {},
  acquireSessionLock = async (path) => ({ target: path, release: async () => undefined }),
  onSessionRecord,
} = {}) => {
  const store = new Map([[record.reference, record]]);
  let opened = 0;
  let created = 0;
  const promise = runFocusedContinuation({
    record, agent: definition, brief: "Fix the retained finding", runtime: modelRuntime, cwd: "/repo", sessionStore: store, onSessionRecord,
    dependencies: {
      fileExists: () => exists,
      openManager: (path) => {
        opened += 1;
        assert.equal(path, resolve(record.sessionFile));
        return {
          getSessionId: () => manager.sessionId ?? record.sessionId,
          getSessionFile: () => manager.sessionFile ?? path,
          getCwd: () => manager.cwd ?? "/repo",
        };
      },
      createSession: async () => { created += 1; return { session: fake.session }; },
      acquireSessionLock,
      scopedTools: () => [], clock: () => "new",
    },
  });
  return { promise, store, fake, counts: () => ({ opened, created }) };
};

test("requires fresh initial review and permits only review follow-ups from succeeded sessions", () => {
  const reviewer = { ...agent, name: "reviewer", authority: "review-read", independence: { freshInitial: true, followUpAllowed: true } };
  const writeScope = [];
  const record = { ...makeRecord({ agent: "reviewer", role: "review-read", resultKind: "review", writeScope }), contractFingerprint: agentContractFingerprint(reviewer, writeScope) };
  assert.equal(canResumeSession({ record, agent: reviewer, purpose: "initial-review", sessionFileExists: true }), false);
  assert.equal(canResumeSession({ record, agent: reviewer, purpose: "rereview", sessionFileExists: true }), true);
  assert.equal(canResumeSession({ record: { ...record, status: "failed" }, agent: reviewer, purpose: "rereview", sessionFileExists: true }), false);
  assert.equal(canResumeSession({ record, agent: reviewer, purpose: "rereview", sessionFileExists: false }), false);
});

test("reopens exact persisted session, executes focused brief, validates identity, and atomically updates record", async () => {
  const run = continuation();
  const result = await run.promise;
  assert.equal(result.status, "succeeded");
  assert.equal(result.report, undefined);
  assert.equal(result.summary, report);
  assert.deepEqual(result.session, { id: "s", file: "/sessions/a.jsonl", resumeReference: "a" });
  assert.deepEqual(run.counts(), { opened: 1, created: 1 });
  assert.deepEqual(run.fake.state.prompts, ["Fix the retained finding"]);
  assert.equal(run.store.get("a").status, "succeeded");
  assert.equal(run.store.get("a").updatedAt, "new");
  assert.equal(run.fake.state.disposes, 1);
  assert.equal(run.fake.state.unsubscribes, 1);
});

test("refuses fingerprint drift, non-succeeded status, missing file, and unavailable model before session side effects", async () => {
  const cases = [
    { record: makeRecord({ contractFingerprint: "drifted" }), error: "agent_contract_drift" },
    { record: makeRecord({ status: "running" }), error: "session_not_reusable" },
    { record: makeRecord({ status: "failed" }), error: "session_not_reusable" },
    { record: makeRecord({ status: "cancelled" }), error: "session_not_reusable" },
    { exists: false, error: "session_not_reusable" },
    { modelRuntime: { getModel: () => undefined }, error: "model_unavailable" },
  ];
  for (const input of cases) {
    const run = continuation(input);
    const result = await run.promise;
    assert.equal(result.status, "refused", input.error);
    assert.equal(result.error, input.error);
    assert.deepEqual(run.counts(), { opened: 0, created: 0 });
    assert.equal(run.fake.state.prompts.length, 0);
  }
});

test("refuses agent identity mismatch and preserves reviewer/vision isolation with no side effects", async () => {
  const reviewer = { ...agent, name: "reviewer", authority: "review-read", tools: ["read"], result: { kind: "review", requiredSections: ["findings"] }, independence: { freshInitial: true, followUpAllowed: true } };
  const vision = { ...agent, name: "vision-handoff", authority: "vision-read", tier: "vision", tools: ["read"], result: { kind: "vision", requiredSections: ["findings"] } };
  const mismatch = continuation({ definition: reviewer });
  assert.equal((await mismatch.promise).status, "refused");
  assert.deepEqual(mismatch.counts(), { opened: 0, created: 0 });

  const visionRecord = makeRecord({ agent: vision.name, role: vision.authority, resultKind: vision.result.kind, writeScope: [] });
  visionRecord.contractFingerprint = agentContractFingerprint(vision, []);
  const visionRun = continuation({ record: visionRecord, definition: vision, fake: fakeSession({ text: "## Findings\nvisual evidence" }) });
  assert.equal((await visionRun.promise).status, "succeeded");
  assert.deepEqual(visionRun.counts(), { opened: 1, created: 1 });
});

test("refuses manager, model, thinking, session ID, and session-file drift before a continuation prompt", async () => {
  const cases = [
    { name: "wrong manager ID", manager: { sessionId: "other" }, created: 0 },
    { name: "wrong manager file", manager: { sessionFile: "/sessions/other.jsonl" }, created: 0 },
    { name: "wrong manager cwd", manager: { cwd: "/other" }, created: 0 },
    { name: "wrong actual model", fake: fakeSession({ model: { provider: "p", id: "other" } }), created: 1 },
    { name: "clamped thinking", fake: fakeSession({ thinking: "low" }), created: 1 },
    { name: "wrong actual session ID", fake: fakeSession({ sessionId: "other" }), created: 1 },
    { name: "wrong actual session file", fake: fakeSession({ sessionFile: "/sessions/other.jsonl" }), created: 1 },
  ];
  for (const scenario of cases) {
    const run = continuation(scenario);
    const result = await run.promise;
    assert.equal(result.status, "refused", scenario.name);
    assert.equal(result.error, "session_not_reusable", scenario.name);
    assert.deepEqual(run.counts(), { opened: 1, created: scenario.created }, scenario.name);
    assert.equal(run.fake.state.prompts.length, 0, scenario.name);
    assert.equal(run.store.get("a").updatedAt, "old", scenario.name);
    assert.equal(run.fake.state.disposes, scenario.created, scenario.name);
  }
});

test("normalizes native @ mutation paths in continued-agent observers", async () => {
  const cases = [
    { path: "@lib/a/file.ts", status: "succeeded" },
    { path: "@/repo/lib/a/file.ts", status: "succeeded" },
    { path: "@@lib/a/file.ts", status: "failed" },
    { path: "@outside/file.ts", status: "failed" },
  ];
  for (const scenario of cases) {
    const fake = fakeSession({ prompt: ({ listeners }) => {
      for (const listener of listeners) {
        listener({ type: "tool_execution_start", toolName: "edit", args: { path: scenario.path } });
      }
    } });
    const run = continuation({ fake });
    const result = await run.promise;
    assert.equal(result.status, scenario.status, scenario.path);
    assert.equal(fake.state.prompts.length, 1, scenario.path);
  }
});

const trackedLease = () => {
  const held = new Set();
  let releases = 0;
  return {
    acquireSessionLock: async (path) => {
      const key = resolve(path);
      if (held.has(key)) return null;
      held.add(key);
      return {
        target: key,
        release: async () => {
          releases += 1;
          held.delete(key);
        },
      };
    },
    releases: () => releases,
  };
};

const aliasedRecord = () => makeRecord({ sessionFile: "/sessions/./a.jsonl" });

test("fails closed and retains the lease when owned cleanup cannot be verified", async () => {
  const cases = [
    {
      name: "synchronous abort failure",
      fake: () => fakeSession({
        prompt: () => { throw new Error("provider timeout"); },
        abort: () => { throw new Error("native abort failed"); },
      }),
    },
    {
      name: "rejected abort failure",
      fake: () => fakeSession({
        prompt: () => { throw new Error("provider timeout"); },
        abort: () => Promise.reject(new Error("native abort rejected")),
      }),
    },
    {
      name: "synchronous idle failure",
      fake: () => fakeSession({
        waitForIdle: () => { throw new Error("provider timeout"); },
      }),
    },
    {
      name: "rejected idle failure",
      fake: () => fakeSession({
        waitForIdle: () => Promise.reject(new Error("provider timeout")),
      }),
    },
    {
      name: "synchronous disposal failure",
      fake: () => fakeSession({
        dispose: () => { throw new Error("native dispose failed"); },
      }),
    },
    {
      name: "rejected disposal failure",
      fake: () => fakeSession({
        dispose: () => Promise.reject(new Error("native dispose rejected")),
      }),
    },
  ];
  for (const scenario of cases) {
    const lease = trackedLease();
    const fake = scenario.fake();
    const first = continuation({ fake, acquireSessionLock: lease.acquireSessionLock });
    const result = await first.promise;
    assert.equal(result.status, "failed", scenario.name);
    assert.equal(result.error, "session_cleanup_unverified", scenario.name);
    assert.equal(result.attempts, 1, scenario.name);
    assert.deepEqual(first.counts(), { opened: 1, created: 1 }, scenario.name);
    assert.equal(fake.state.prompts.length, 1, scenario.name);
    assert.equal(lease.releases(), 0, scenario.name);

    const alias = continuation({
      record: aliasedRecord(),
      acquireSessionLock: lease.acquireSessionLock,
    });
    const blocked = await alias.promise;
    assert.equal(blocked.status, "refused", scenario.name);
    assert.equal(blocked.error, "session_follow_up_busy", scenario.name);
    assert.deepEqual(alias.counts(), { opened: 0, created: 0 }, scenario.name);
  }
});

test("releases the lease after verified cleanup so an alias can continue", async () => {
  const lease = trackedLease();
  const first = continuation({ acquireSessionLock: lease.acquireSessionLock });
  assert.equal((await first.promise).status, "succeeded");
  assert.equal(lease.releases(), 1);

  const alias = continuation({
    record: aliasedRecord(),
    acquireSessionLock: lease.acquireSessionLock,
  });
  assert.equal((await alias.promise).status, "succeeded");
  assert.equal(lease.releases(), 2);
});

test("does not relabel prior session text after an empty aborted continuation", async () => {
  const aborted = fakeSession({
    messages: [
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: report }] },
      { role: "assistant", stopReason: "aborted", content: [] },
    ],
    text: report,
  });
  const run = continuation({ fake: aborted });
  const result = await run.promise;
  assert.equal(result.status, "failed");
  assert.ok(result.completion.includes("assistant_aborted"));
  assert.ok(result.completion.includes("report_empty"));
  assert.equal(result.report, undefined);
  assert.equal(result.unverifiedReport, undefined);
  assert.equal(result.unverifiedReason, undefined);
  assert.equal(run.store.get("a").updatedAt, "old");
  assert.equal(aborted.state.disposes, 1);
});
