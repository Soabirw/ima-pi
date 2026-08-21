import assert from "node:assert/strict";
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
  const state = { prompts: [], disposes: 0, unsubscribes: 0 };
  return {
    state,
    session: {
      messages: overrides.messages ?? [{ role: "assistant", stopReason: "stop", content: reportText ? [{ type: "text", text: reportText }] : [] }],
      model: overrides.model ?? { provider: "p", id: "m" }, thinkingLevel: overrides.thinking ?? "high",
      sessionId: overrides.sessionId ?? "s", sessionFile: overrides.sessionFile ?? "/sessions/a.jsonl",
      subscribe: () => () => { state.unsubscribes += 1; },
      prompt: async (brief) => { state.prompts.push(brief); await overrides.prompt?.(); },
      waitForIdle: async () => overrides.waitForIdle?.(),
      getLastAssistantText: () => reportText,
      dispose: () => { state.disposes += 1; }, abort: async () => undefined,
    },
  };
};

const continuation = ({ record = makeRecord(), definition = agent, fake = fakeSession(), modelRuntime = runtime, exists = true } = {}) => {
  const store = new Map([[record.reference, record]]);
  let opened = 0;
  let created = 0;
  const promise = runFocusedContinuation({
    record, agent: definition, brief: "Fix the retained finding", runtime: modelRuntime, cwd: "/repo", sessionStore: store,
    dependencies: {
      fileExists: () => exists,
      openManager: (path) => { opened += 1; assert.equal(path, record.sessionFile); return {}; },
      createSession: async () => { created += 1; return { session: fake.session }; },
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

test("fails closed on observed identity mismatch, exposes unverified context, and preserves the stored record", async () => {
  const wrong = fakeSession({ model: { provider: "p", id: "other" } });
  const run = continuation({ fake: wrong });
  const result = await run.promise;
  assert.equal(result.status, "failed");
  assert.ok(result.completion.includes("runtime_identity_mismatch"));
  assert.equal(result.report, undefined);
  assert.equal(result.unverifiedReport, undefined);
  assert.equal(result.summary, report);
  assert.equal(result.unverifiedReason, "runtime_identity_mismatch");
  assert.deepEqual(result.session, { id: "s", file: "/sessions/a.jsonl", resumeReference: null });
  assert.equal(run.store.get("a").updatedAt, "old");
  assert.equal(wrong.state.disposes, 1);
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
