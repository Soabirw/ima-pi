import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDelegationOutcomeReport,
  classifyDelegationActivity,
  createDelegationActivityState,
  reduceDelegationActivity,
  renderDelegationActivity,
} from "../lib/ima-activity.ts";

const agents = [
  {
    schemaVersion: 1, name: "explore", description: "Explore", tier: "LOW", authority: "read",
    tools: ["read", "grep", "read"], skills: ["rg", "rg"], delegation: { allowed: false, maxDepth: 0 },
    independence: { freshInitial: false, followUpAllowed: true }, result: { kind: "evidence", requiredSections: ["findings"] },
    escalation: ["scope"], prompt: "Explore.", source: "package", path: "/agents/explore.md",
  },
  {
    schemaVersion: 1, name: "implementer", description: "Implement", tier: "MID", authority: "write",
    tools: ["read", "write", "bash"], skills: ["js-fp"], delegation: { allowed: false, maxDepth: 0 },
    independence: { freshInitial: false, followUpAllowed: true }, result: { kind: "implementation", requiredSections: ["files"] },
    escalation: ["architecture"], prompt: "Implement.", source: "package", path: "/agents/implementer.md",
  },
];
const assignment = (id, agent = "explore", writeScope = []) => ({ id, agent, goal: "work", context: "approved", paths: ["lib"], constraints: [], nonGoals: [], expectedOutput: "report", writeScope });
const initial = (assignments = [assignment("a")], at = 1_000) => createDelegationActivityState({ runId: "run-123456789", request: { title: "Bounded work", assignments }, agents, at });
const event = (state, value) => reduceDelegationActivity(state, { at: state.updatedAt + 10, ...value });

test("initial state exposes declared topology in request order without claiming a model", () => {
  const state = initial([assignment("b", "implementer", ["lib/b"]), assignment("a")]);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.phase, "delegation");
  assert.deepEqual(state.children.map((child) => child.assignmentId), ["b", "a"]);
  assert.deepEqual(state.children[0].declaredSkills, ["js-fp"]);
  assert.deepEqual(state.children[1].declaredTools, ["read", "grep"]);
  assert.equal(state.children[0].phase, "implementation");
  assert.equal(state.children[0].authority, "write");
  assert.equal(state.children[0].route, null);
});

test("long assignment ids remain exact across activity events and outcome reports", () => {
  const id = "a".repeat(81);
  let state = initial([assignment(id)]);
  state = event(state, { type: "route-resolved", id, route: { provider: "p", model: "m" } });
  state = event(state, { type: "child-started", id, attempt: 1 });
  state = event(state, { type: "succeeded", id });
  state = reduceDelegationActivity(state, { type: "run-settled", state: "succeeded", at: 2_000 });
  const report = buildDelegationOutcomeReport({
    activity: state,
    results: [{ id, status: "succeeded", attempts: 1, resumeReference: id }],
    partialEffects: false,
    unsafeEvidence: [],
  });
  assert.equal(state.children[0].assignmentId, id);
  assert.equal(state.children[0].state, "succeeded");
  assert.equal(state.children[0].attempt, 1);
  assert.deepEqual(report.completedAssignmentIds, [id]);
  assert.ok(report.children.every((child) => child.state !== "pending"));
});

test("reducer is immutable, records exact route only when observed, and is terminal-monotonic", () => {
  const base = initial();
  const routed = event(base, { type: "route-resolved", id: "a", route: { provider: "p", model: "m", thinking: "high" } });
  const running = event(routed, { type: "child-running", id: "a", attempt: 1 });
  const succeeded = event(running, { type: "succeeded", id: "a" });
  const ignored = event(succeeded, { type: "failed", id: "a", blocker: "late" });
  const settled = event(succeeded, { type: "child-settled", id: "a" });
  assert.equal(base.children[0].route, null);
  assert.deepEqual(routed.children[0].route, { provider: "p", model: "m", thinking: "high" });
  assert.equal(running.children[0].state, "running");
  assert.equal(succeeded.children[0].state, "succeeded");
  assert.strictEqual(ignored, succeeded);
  assert.equal(settled.children[0].state, "succeeded");
  assert.equal(settled.children[0].settledAt, succeeded.updatedAt);
});

test("activity classifier exposes compact-MCP categories without raw arguments", () => {
  for (const server of ["serena", "vestige", "qdrant-memory"]) {
    const category = classifyDelegationActivity("mcp", {
      server,
      args: { query: "super-secret" },
    });
    assert.equal(category, `gateway:${server}`);
    assert.doesNotMatch(category, /secret|query/);
  }
  assert.equal(classifyDelegationActivity("mcp", { server: "unknown" }), "gateway:other");
  assert.equal(classifyDelegationActivity("bash", { command: "ima-mcp serena search super-secret" }), "tool:bash");
  assert.equal(classifyDelegationActivity("read", { path: "/private/path" }), "tool:read");
  assert.equal(classifyDelegationActivity("custom", { token: "secret" }), "tool:other");
});

test("renderer stays within five bounded lines and shows route, declared skills, activity, retry, and escalation", () => {
  let state = initial([assignment("a"), assignment("b"), assignment("c"), assignment("d")]);
  for (const id of ["a", "b", "c", "d"]) {
    state = event(state, { type: "route-resolved", id, route: { provider: "provider", model: "model", thinking: "high" } });
    state = event(state, { type: "child-started", id, attempt: 1 });
    state = event(state, { type: "child-activity", id, category: "gateway:serena" });
  }
  state = event(state, { type: "retrying", id: "a", attempt: 2, reason: "transient-provider" });
  state = event(state, { type: "failed", id: "b", blocker: "blocked", escalation: "human" });
  const lines = renderDelegationActivity(state, 5_000);
  assert.equal(lines.length, 5);
  assert.match(lines[1], /evidence explore provider\/model:high declared-skills:rg retrying 2\/2 retry:transient-provider/);
  assert.match(lines[2], /escalate/);
  assert.ok(lines.every((line) => line.length <= 320));
});

test("cancellation preserves successful children and reports only cancelled writer scopes", () => {
  let state = initial([assignment("read"), assignment("write", "implementer", ["owned/write"])]);
  state = event(state, { type: "succeeded", id: "read" });
  state = event(state, { type: "cancel-requested", id: "write", possiblePartialWriteScopes: ["owned/write"] });
  state = event(state, { type: "cancelled", id: "write", blocker: "cancelled", possiblePartialWriteScopes: ["owned/write"] });
  state = reduceDelegationActivity(state, { type: "run-settled", state: "cancelled", at: 2_000 });
  const report = buildDelegationOutcomeReport({
    activity: state,
    results: [
      { id: "read", status: "succeeded", attempts: 1, resumeReference: "read" },
      { id: "write", status: "cancelled", attempts: 1, error: "cancelled", failure: "unsafe-partial-state", resumeReference: "must-not-leak" },
    ],
    partialEffects: true,
    unsafeEvidence: [],
  });
  assert.deepEqual(report.completedAssignmentIds, ["read"]);
  assert.deepEqual(report.partialState.possibleWriteScopes, ["owned/write"]);
  assert.equal(report.children[0].resumeReference, "read");
  assert.equal(report.children[1].resumeReference, null);
  assert.equal(report.safeNextAction.code, "inspect-partial-state");
});

test("retry, safety, failure fields, and reusable successful sessions are structured", () => {
  let state = initial([assignment("safe", "implementer", ["owned/safe"]), assignment("unsafe", "implementer", ["owned/unsafe"])]);
  state = event(state, { type: "child-started", id: "safe", attempt: 1 });
  state = event(state, { type: "retrying", id: "safe", attempt: 2, reason: "transient-provider" });
  state = event(state, { type: "succeeded", id: "safe" });
  state = event(state, { type: "safety-intercepted", id: "unsafe", blocker: "unsafe-partial-state token=secret", possiblePartialWriteScopes: ["owned/unsafe"] });
  state = reduceDelegationActivity(state, { type: "run-settled", state: "failed", at: 4_000 });
  const report = buildDelegationOutcomeReport({
    activity: state,
    results: [
      { id: "safe", status: "succeeded", attempts: 2, resumeReference: "safe" },
      { id: "unsafe", status: "failed", attempts: 1, error: "unsafe-partial-state", failure: "unsafe-partial-state" },
    ],
    partialEffects: true,
    unsafeEvidence: [{ assignmentId: "unsafe", writeScope: ["owned/unsafe"] }],
  });
  assert.equal(report.phase, "delegation");
  assert.equal(report.state, "failed");
  assert.equal(report.elapsedMs, 3_000);
  assert.deepEqual(report.retryHistory, [{ assignmentId: "safe", reason: "transient-provider" }]);
  assert.deepEqual(report.reusableSessionReferences, ["safe"]);
  assert.deepEqual(report.partialState.unsafeAssignmentIds, ["unsafe"]);
  assert.match(report.blocker, /unsafe-partial-state/);
  assert.doesNotMatch(JSON.stringify(report), /must-not-leak/);
});

test("safe next actions distinguish model, provider, contract, decision, and success outcomes", () => {
  const cases = [
    ["model-unavailable", "restore-exact-model"],
    ["auth-or-quota", "restore-exact-model"],
    ["transient-provider", "retry-after-provider-recovery"],
    ["agent-contract", "correct-agent-contract"],
    ["critical-decision", "obtain-human-decision"],
    ["plan-contradiction", "obtain-human-decision"],
  ];
  for (const [failure, code] of cases) {
    let state = event(initial(), { type: "failed", id: "a", blocker: failure });
    state = reduceDelegationActivity(state, { type: "run-settled", state: "failed", at: 2_000 });
    const report = buildDelegationOutcomeReport({ activity: state, results: [{ id: "a", status: "failed", attempts: 1, error: failure, failure }], partialEffects: false, unsafeEvidence: [] });
    assert.equal(report.safeNextAction.code, code, failure);
  }
  let state = event(initial(), { type: "succeeded", id: "a" });
  state = reduceDelegationActivity(state, { type: "run-settled", state: "succeeded", at: 2_000 });
  const success = buildDelegationOutcomeReport({ activity: state, results: [{ id: "a", status: "succeeded", attempts: 1, resumeReference: "a" }], partialEffects: false, unsafeEvidence: [] });
  assert.equal(success.safeNextAction.code, "continue-parent-synthesis");
});

test("user-derived live labels are bounded and cannot inject extra lines", () => {
  const state = createDelegationActivityState({ runId: "run\nsecret", request: { title: "title\nforged", assignments: [assignment("a\nforged")] }, agents, at: 0 });
  const lines = renderDelegationActivity(state, 0);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => !line.includes("\n")));
  assert.match(lines[0], /title forged/);
});
