import assert from "node:assert/strict";
import test from "node:test";
import {
  CYCLE_PHASE_EXECUTION_SCHEMA_VERSION,
  canResumeCyclePhaseExecution,
  createCyclePhaseExecution,
  createCyclePhaseSettlement,
  hasMatchingCyclePhaseExecution,
  hasMatchingCyclePhaseSettlement,
  selectCycleOrchestratorRoute,
  selectCyclePhaseRoute,
  validateCyclePhaseExecution,
  validateCyclePhaseSettlement,
} from "../lib/ima-cycle-phase.ts";
import { buildCycleOutcomeMarker, createCycleState, reconcileCycleFromLifecycle } from "../lib/ima-cycle.ts";

const PROFILE = "cycle-profile";
const TIMESTAMP = "2026-08-04T18:00:00.000Z";
const parentRoute = Object.freeze({ provider: "parent-provider", model: "parent-model", thinking: "minimal" });
const mapping = (provider, model, thinking = "medium") => Object.freeze({ provider, model, thinking });
const routeConfig = ({ commands = {}, phases = {}, models = {} } = {}) => Object.freeze({
  commands: Object.freeze({ ...commands }),
  phases: Object.freeze({ ...phases }),
  models: Object.freeze({ ...models }),
});
const selectedRoute = (route, source) => Object.freeze({
  provider: route.provider,
  model: route.model,
  thinking: route.thinking,
  profile: PROFILE,
  source,
});

const executionRoute = Object.freeze({
  provider: "child-provider",
  model: "child-model",
  thinking: "high",
  profile: PROFILE,
  source: "command",
});
const executionRecord = (overrides = {}) => Object.freeze({
  schemaVersion: CYCLE_PHASE_EXECUTION_SCHEMA_VERSION,
  dispatchId: "cycle-dispatch-1",
  phase: "implementation",
  route: executionRoute,
  parentSessionId: "parent-session-1",
  childSessionId: "child-session-1",
  childSessionFile: "/sessions/child-session-1.jsonl",
  childSessionDir: "/sessions",
  status: "running",
  possiblePartialWrite: true,
  startedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  ...overrides,
});
const executionInput = (overrides = {}) => {
  const { schemaVersion: _schemaVersion, ...input } = executionRecord(overrides);
  return Object.freeze(input);
};

test("selects cycle orchestrator routes by command, HIGH, then parent", () => {
  const cycleCommand = mapping("command-provider", "cycle-model", "max");
  const high = mapping("high-provider", "high-model", "high");
  const cases = Object.freeze([
    Object.freeze({
      name: "uses the direct cycle command route before HIGH",
      config: routeConfig({ commands: { cycle: cycleCommand }, models: { HIGH: high } }),
      expected: selectedRoute(cycleCommand, "command"),
    }),
    Object.freeze({
      name: "uses HIGH when the cycle command is not configured",
      config: routeConfig({ models: { HIGH: high } }),
      expected: selectedRoute(high, "high"),
    }),
    Object.freeze({
      name: "keeps the parent route when neither command nor HIGH is configured",
      config: routeConfig(),
      expected: Object.freeze({ ...parentRoute, profile: PROFILE, source: "parent" }),
    }),
  ]);

  for (const { name, config, expected } of cases) {
    assert.deepEqual(
      selectCycleOrchestratorRoute({ config, parentRoute, profile: PROFILE }),
      expected,
      name,
    );
  }
});

test("selects phase routes with explicit precedence, legacy mappings, and parent fallback", () => {
  const directResolution = mapping("direct-provider", "direct-resolution", "max");
  const legacyResolution = mapping("legacy-provider", "legacy-resolution", "high");
  const implement = mapping("implement-provider", "implement-model", "medium");
  const legacyImplement = mapping("legacy-provider", "legacy-implement", "low");
  const review = mapping("review-provider", "review-model", "xhigh");
  const legacyReview = mapping("legacy-provider", "legacy-review", "high");
  const cases = Object.freeze([
    Object.freeze({
      name: "prefers an explicit resolve-review command over legacy and implement routes",
      command: "resolve-review",
      config: routeConfig({
        commands: { "resolve-review": directResolution, implement },
        phases: { resolution: legacyResolution },
      }),
      expected: selectedRoute(directResolution, "command"),
    }),
    Object.freeze({
      name: "uses a legacy resolution mapping before the implement fallback",
      command: "resolve-review",
      config: routeConfig({ commands: { implement }, phases: { resolution: legacyResolution } }),
      expected: selectedRoute(legacyResolution, "command"),
    }),
    Object.freeze({
      name: "falls back from resolution to the implement command route",
      command: "resolve-review",
      config: routeConfig({ commands: { implement } }),
      expected: selectedRoute(implement, "command"),
    }),
    Object.freeze({
      name: "falls back from resolution to the legacy implement mapping",
      command: "resolve-review",
      config: routeConfig({ phases: { implement: legacyImplement } }),
      expected: selectedRoute(legacyImplement, "command"),
    }),
    Object.freeze({
      name: "falls back from rereview to the review command route",
      command: "rereview",
      config: routeConfig({ commands: { review }, phases: { review: legacyReview } }),
      expected: selectedRoute(review, "command"),
    }),
    Object.freeze({
      name: "uses the parent route for an unconfigured phase",
      command: "document",
      config: routeConfig(),
      expected: Object.freeze({ ...parentRoute, profile: PROFILE, source: "parent" }),
    }),
  ]);

  for (const { name, command, config, expected } of cases) {
    assert.deepEqual(
      selectCyclePhaseRoute({ config, command, parentRoute, profile: PROFILE }),
      expected,
      name,
    );
  }
});

test("creates valid execution records and rejects malformed persisted records", () => {
  const valid = executionRecord();
  const malformedRecords = Object.freeze([
    Object.freeze({ name: "wrong schema version", record: executionRecord({ schemaVersion: 2 }) }),
    Object.freeze({ name: "unknown status", record: executionRecord({ status: "unknown" }) }),
    Object.freeze({ name: "partial child identity", record: executionRecord({ childSessionFile: undefined }) }),
    Object.freeze({ name: "relative child session file", record: executionRecord({ childSessionFile: "sessions/child.jsonl" }) }),
    Object.freeze({ name: "missing parent session", record: executionRecord({ parentSessionId: "" }) }),
    Object.freeze({
      name: "malformed route profile",
      record: executionRecord({ route: Object.freeze({ ...executionRoute, profile: "bad\nprofile" }) }),
    }),
    Object.freeze({ name: "invalid timestamp", record: executionRecord({ updatedAt: "not-a-timestamp" }) }),
  ]);
  const malformedInputs = Object.freeze([
    Object.freeze({ name: "unknown phase", input: executionInput({ phase: "unknown" }) }),
    Object.freeze({ name: "relative child session directory", input: executionInput({ childSessionDir: "sessions" }) }),
  ]);

  assert.equal(validateCyclePhaseExecution(valid), true);
  assert.deepEqual(createCyclePhaseExecution(executionInput()), valid);
  for (const { name, record } of malformedRecords) {
    assert.equal(validateCyclePhaseExecution(record), false, name);
  }
  for (const { name, input } of malformedInputs) {
    assert.equal(createCyclePhaseExecution(input), null, name);
  }
});

test("matches only the correlated phase dispatch and child session identity", () => {
  const execution = executionRecord();
  const cases = Object.freeze([
    Object.freeze({
      name: "matches the exact identity",
      input: Object.freeze({ execution, phase: "implementation", dispatchId: "cycle-dispatch-1", childSessionId: "child-session-1" }),
      expected: true,
    }),
    Object.freeze({
      name: "rejects a different phase",
      input: Object.freeze({ execution, phase: "review", dispatchId: "cycle-dispatch-1", childSessionId: "child-session-1" }),
      expected: false,
    }),
    Object.freeze({
      name: "rejects a different dispatch",
      input: Object.freeze({ execution, phase: "implementation", dispatchId: "other-dispatch", childSessionId: "child-session-1" }),
      expected: false,
    }),
    Object.freeze({
      name: "rejects a different child session",
      input: Object.freeze({ execution, phase: "implementation", dispatchId: "cycle-dispatch-1", childSessionId: "other-child-session" }),
      expected: false,
    }),
    Object.freeze({
      name: "rejects a missing execution",
      input: Object.freeze({ execution: undefined, phase: "implementation", dispatchId: "cycle-dispatch-1", childSessionId: "child-session-1" }),
      expected: false,
    }),
  ]);

  for (const { name, input, expected } of cases) {
    assert.equal(hasMatchingCyclePhaseExecution(input), expected, name);
  }
});

test("allows resumption only for valid child identities in resumable statuses", () => {
  const statusCases = Object.freeze([
    Object.freeze({ status: "starting", resumable: false }),
    Object.freeze({ status: "running", resumable: true }),
    Object.freeze({ status: "waiting-reply", resumable: true }),
    Object.freeze({ status: "settled", resumable: false }),
    Object.freeze({ status: "stopped", resumable: false }),
    Object.freeze({ status: "interrupted", resumable: true }),
    Object.freeze({ status: "failed", resumable: false }),
  ]);
  const invalidResumeCandidates = Object.freeze([
    Object.freeze({
      name: "starting without a child identity",
      structurallyValid: true,
      record: executionRecord({
        status: "starting",
        childSessionId: undefined,
        childSessionFile: undefined,
        childSessionDir: undefined,
      }),
    }),
    Object.freeze({
      name: "a partial child identity",
      structurallyValid: false,
      record: executionRecord({ childSessionDir: undefined }),
    }),
    Object.freeze({
      name: "a relative child session path",
      structurallyValid: false,
      record: executionRecord({ childSessionFile: "sessions/child.jsonl" }),
    }),
    Object.freeze({
      name: "an unsupported schema version",
      structurallyValid: false,
      record: executionRecord({ schemaVersion: 2 }),
    }),
    Object.freeze({
      name: "an invalid execution route",
      structurallyValid: false,
      record: executionRecord({ route: Object.freeze({ ...executionRoute, provider: "" }) }),
    }),
  ]);

  for (const { status, resumable } of statusCases) {
    const record = executionRecord({ status });
    assert.equal(validateCyclePhaseExecution(record), true, status);
    assert.equal(canResumeCyclePhaseExecution(record), resumable, status);
  }
  for (const { name, record, structurallyValid } of invalidResumeCandidates) {
    assert.equal(validateCyclePhaseExecution(record), structurallyValid, name);
    assert.equal(canResumeCyclePhaseExecution(record), false, name);
  }
});

test("requires exact successful settlement proof before reconciling an execution-owned artifact", () => {
  const execution = executionRecord();
  const state = {
    ...createCycleState("FNR-3036", { timestamp: TIMESTAMP }),
    phase: "implementation",
    status: "awaiting-evidence",
    execution,
  };
  const artifact = {
    artifactId: "implementation-artifact",
    recordKey: "ima-pi:jira:FNR-3036:implementation:artifact",
    artifact: `artifact\n${buildCycleOutcomeMarker({ phase: "implementation", outcome: "COMPLETED" })}`,
    verified: true,
  };
  const context = {
    schemaVersion: 1,
    project: "ima-pi",
    lifecycleKey: state.lifecycleKey,
    source: "FNR-3036",
    phase: "implementation",
    dispatchId: execution.dispatchId,
  };
  const matching = createCyclePhaseSettlement({
    project: context.project,
    lifecycleKey: context.lifecycleKey,
    source: context.source,
    phase: context.phase,
    dispatchId: context.dispatchId,
    childSessionId: execution.childSessionId,
    actual: { provider: execution.route.provider, model: execution.route.model, thinking: execution.route.thinking },
    artifacts: [{ artifactId: artifact.artifactId, recordKey: artifact.recordKey }],
  });
  assert.ok(matching);
  assert.equal(validateCyclePhaseSettlement(matching), true);
  assert.equal(hasMatchingCyclePhaseSettlement({ settlement: matching, execution, context, artifact }), true);

  const noProof = reconcileCycleFromLifecycle(state, [artifact], { timestamp: TIMESTAMP });
  assert.equal(noProof.ok, false);
  assert.equal(noProof.error.code, "cycle_execution_settlement_missing");
  assert.deepEqual(noProof.state, state);

  const wrongProof = createCyclePhaseSettlement({
    ...matching,
    artifacts: [{ artifactId: "other-artifact", recordKey: artifact.recordKey }],
  });
  assert.ok(wrongProof);
  const wrong = reconcileCycleFromLifecycle(state, [artifact], { timestamp: TIMESTAMP, executionSettlement: wrongProof });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, "cycle_execution_settlement_mismatch");
  assert.deepEqual(wrong.state, state);

  const reconciled = reconcileCycleFromLifecycle(state, [artifact], { timestamp: TIMESTAMP, executionSettlement: matching });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true);
  assert.deepEqual({ phase: reconciled.state.phase, status: reconciled.state.status }, { phase: "test", status: "awaiting-resume" });

  const nextPhase = { ...reconciled.state, status: "awaiting-evidence" };
  const previousProof = reconcileCycleFromLifecycle(nextPhase, [{
    ...artifact,
    artifactId: "test-artifact",
    artifact: `artifact\n${buildCycleOutcomeMarker({ phase: "test", outcome: "PASSED" })}`,
  }], {
    timestamp: TIMESTAMP,
    executionSettlement: matching,
  });
  assert.equal(previousProof.ok, true);
  assert.equal(previousProof.reconciled, false);
  assert.deepEqual(previousProof.state, nextPhase);
});
