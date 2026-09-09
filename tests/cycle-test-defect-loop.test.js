import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCycleOutcomeMarker,
  createCycleState,
  normalizeCycleSource,
  prepareCycleResume,
  reduceCycleState,
} from "../lib/ima-cycle.ts";

const at = "2026-09-09T22:17:50.302Z";
const source = normalizeCycleSource("SKYNET-194");
const marker = (phase, outcome) => buildCycleOutcomeMarker({ phase, outcome });
const awaitingEvidence = (state) => ({ ...state, status: "awaiting-evidence", updatedAt: at });

const addEvidence = (state, phase, outcome, toolCallId) => {
  const result = reduceCycleState(awaitingEvidence(state), {
    artifact: marker(phase, outcome),
    toolCallId,
    timestamp: at,
  }, { timestamp: at });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state;
};

test("routes repeated pre-review test defects through implementation and retest before fresh review", () => {
  let state = createCycleState(source, { timestamp: at });
  state = addEvidence(state, "plan", "APPROVED", "plan");
  state = addEvidence(state, "implementation", "COMPLETED", "implementation-first");
  state = addEvidence(state, "test", "DEFECTS", "test-first");
  assert.deepEqual(
    { phase: state.phase, status: state.status, reviewAttempts: state.reviewAttempts, blockers: state.blockers },
    { phase: "implementation", status: "awaiting-resume", reviewAttempts: 0, blockers: [] },
  );

  state = addEvidence(state, "implementation", "COMPLETED", "implementation-repair");
  state = addEvidence(state, "test", "DEFECTS", "test-second");
  state = addEvidence(state, "implementation", "COMPLETED", "implementation-second-repair");
  state = addEvidence(state, "test", "PASSED", "test-passed");
  assert.deepEqual(
    { phase: state.phase, status: state.status, reviewAttempts: state.reviewAttempts },
    { phase: "review", status: "awaiting-resume", reviewAttempts: 0 },
  );
});

test("accepts a repair after a resumed test block before the first defect", () => {
  let state = createCycleState(source, { timestamp: at });
  state = addEvidence(state, "plan", "APPROVED", "plan");
  state = addEvidence(state, "implementation", "COMPLETED", "implementation");
  state = addEvidence(state, "test", "BLOCKED", "test-blocked");
  const resumed = prepareCycleResume(state);
  assert.equal(resumed.ok, true);

  state = addEvidence(resumed.state, "test", "DEFECTS", "test-defects");
  state = addEvidence(state, "implementation", "COMPLETED", "implementation-repair");
  state = addEvidence(state, "test", "PASSED", "test-passed");
  assert.deepEqual(
    { phase: state.phase, status: state.status, reviewAttempts: state.reviewAttempts, blockers: state.blockers },
    { phase: "review", status: "awaiting-resume", reviewAttempts: 0, blockers: [] },
  );
});

test("recovers only the exact legacy test-defect block", () => {
  let state = createCycleState(source, { timestamp: at });
  state = addEvidence(state, "plan", "APPROVED", "plan");
  state = addEvidence(state, "implementation", "COMPLETED", "implementation");
  const blocked = {
    phase: "test",
    outcome: "BLOCKED",
    marker: marker("test", "BLOCKED"),
    toolCallId: "legacy-blocked",
    artifactId: null,
    recordKey: null,
    timestamp: at,
  };
  const defects = {
    phase: "test",
    outcome: "DEFECTS",
    marker: marker("test", "DEFECTS"),
    toolCallId: "legacy-defects",
    artifactId: null,
    recordKey: null,
    timestamp: at,
  };
  const legacy = {
    ...state,
    phase: "test",
    status: "blocked",
    blockers: ["test:DEFECTS"],
    evidence: [...state.evidence, blocked, defects],
  };
  const recovered = prepareCycleResume(legacy);
  assert.equal(recovered.ok, true);
  assert.deepEqual(
    { phase: recovered.state.phase, status: recovered.state.status, blockers: recovered.state.blockers },
    { phase: "implementation", status: "awaiting-resume", blockers: [] },
  );

  const repaired = addEvidence(recovered.state, "implementation", "COMPLETED", "legacy-repair");
  const passed = addEvidence(repaired, "test", "PASSED", "legacy-passed");
  assert.deepEqual(
    { phase: passed.phase, status: passed.status, blockers: passed.blockers },
    { phase: "review", status: "awaiting-resume", blockers: [] },
  );

  const wrongBlocker = prepareCycleResume({ ...legacy, blockers: ["unrelated:blocker"] });
  assert.equal(wrongBlocker.ok, false);
  assert.equal(wrongBlocker.error.code, "cycle_resume_unavailable");
  assert.equal(prepareCycleResume({ ...legacy, blockers: ["test:DEFECTS", "legacy-extra"] }).ok, false);
  assert.equal(prepareCycleResume({ ...legacy, evidence: [state.evidence[0], defects] }).ok, false);
});

test("rejects repeated tool-call IDs during otherwise valid repair-marker reuse", () => {
  let state = createCycleState(source, { timestamp: at });
  state = addEvidence(state, "plan", "APPROVED", "plan");
  state = addEvidence(state, "implementation", "COMPLETED", "implementation");
  state = addEvidence(state, "test", "DEFECTS", "test-defects");
  const result = reduceCycleState(awaitingEvidence(state), {
    artifact: marker("implementation", "COMPLETED"),
    toolCallId: "implementation",
    timestamp: at,
  }, { timestamp: at });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "phase_evidence_duplicate");
});

test("rejects out-of-order implementation evidence outside the repair loop", () => {
  let state = createCycleState(source, { timestamp: at });
  state = addEvidence(state, "plan", "APPROVED", "plan");
  state = addEvidence(state, "implementation", "COMPLETED", "implementation");
  state = addEvidence(state, "test", "PASSED", "test");
  const result = reduceCycleState(awaitingEvidence(state), {
    artifact: marker("implementation", "COMPLETED"),
    toolCallId: "out-of-order",
    timestamp: at,
  }, { timestamp: at });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "phase_evidence_out_of_order");
});
