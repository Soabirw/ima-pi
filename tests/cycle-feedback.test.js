import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCyclePhaseCompletion,
  buildCyclePhaseWidget,
  buildCycleStartAck,
  describeCycleBlockers,
  describeCyclePhaseActivity,
} from "../lib/ima-cycle-feedback.ts";

const widgetInput = (overrides = {}) => ({
  status: "awaiting-evidence",
  source: "plane:ima:SKYNET-201",
  phase: "plan",
  nextPhase: "implementation",
  mode: "guided",
  reviewAttempts: 0,
  reviewCap: 5,
  route: {
    provider: "test-provider",
    model: "test-model",
    thinking: "high",
    profile: "cycle-profile",
    source: "command",
  },
  activity: "phase agent started",
  blockers: [],
  ...overrides,
});

test("buildCycleStartAck describes the accepted source and selected options", () => {
  assert.equal(
    buildCycleStartAck("plane:ima:SKYNET-201", { reviewCap: 3, mode: "autonomous" }),
    "IMA cycle: start accepted for plane:ima:SKYNET-201 — preparing plan phase (mode autonomous, review cap 3). Working…",
  );
});

test("describeCyclePhaseActivity makes runtime signals friendly and preserves unknown activity", () => {
  assert.equal(describeCyclePhaseActivity("phase agent started"), "Phase agent started.");
  assert.equal(describeCyclePhaseActivity("phase agent settled"), "Phase agent settled; validating lifecycle evidence.");
  assert.equal(describeCyclePhaseActivity("phase tool: ima_lifecycle"), "Using ima_lifecycle.");
  assert.equal(describeCyclePhaseActivity("waiting for local approval"), "waiting for local approval");
});

test("describeCycleBlockers classifies known blockers and fails safely for unknown codes", () => {
  const guidance = describeCycleBlockers([
    "plan:BLOCKED",
    "implementation:BLOCKED",
    "test:DEFECTS",
    "review_cap_exceeded",
    "phase_transition_invalid",
    "lifecycle_closeout_failed",
    "unknown_code",
  ]);

  assert.deepEqual(guidance.map(({ code, terminal }) => ({ code, terminal })), [
    { code: "plan:BLOCKED", terminal: false },
    { code: "implementation:BLOCKED", terminal: false },
    { code: "test:DEFECTS", terminal: true },
    { code: "review_cap_exceeded", terminal: true },
    { code: "phase_transition_invalid", terminal: true },
    { code: "lifecycle_closeout_failed", terminal: true },
    { code: "unknown_code", terminal: false },
  ]);
  assert.match(guidance[0].guidance, /decompose multiple units/);
  assert.match(guidance[1].guidance, /persisted phase artifact/);
  assert.match(guidance[2].guidance, /cannot bypass/);
  assert.match(guidance.at(-1).guidance, /persisted artifact/);
});

test("buildCyclePhaseWidget shows running route, activity, actual identity, and blockers", () => {
  const lines = buildCyclePhaseWidget(widgetInput({
    status: "blocked",
    activity: "phase tool: ima_lifecycle",
    actual: { provider: "actual-provider", model: "actual-model", thinking: "medium" },
    blockers: ["implementation:BLOCKED"],
  }));

  assert.deepEqual(lines.slice(0, 4), [
    "IMA cycle · plane:ima:SKYNET-201",
    "phase plan · blocked → next implementation",
    "route cycle-profile · command · test-provider/test-model · thinking high",
    "review 0/5 · mode guided",
  ]);
  assert.ok(lines.includes("actual actual-provider/actual-model · thinking medium"));
  assert.ok(lines.some((line) => line.startsWith("blocker implementation:BLOCKED — Inspect the persisted phase artifact")));
  assert.ok(lines.every((line) => line.length <= 200));
});

test("buildCyclePhaseWidget hides inactive cycles and includes activity only while executing", () => {
  assert.deepEqual(buildCyclePhaseWidget(widgetInput({ status: "awaiting-resume" })), []);
  assert.ok(buildCyclePhaseWidget(widgetInput()).includes("activity: Phase agent started."));
});

test("buildCyclePhaseCompletion reports the validated actual identity", () => {
  assert.equal(
    buildCyclePhaseCompletion("plan", { provider: "actual-provider", model: "actual-model", thinking: "low" }),
    "Cycle plan completed with actual-provider/actual-model · thinking low.",
  );
});
