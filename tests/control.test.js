import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyCancellationEvidence, classifyDestructiveCommand, classifySkillObservation, createInitialRunState, ControlProjectionError, awaitProjectionBeforeAbort, bestEffortNotify, createOrderedProjectionController, createRunStateController, cleanupCreatedChildren, projectAtLeastOne, projectWithDegradedWarning, createSafetyFixture, deriveConcurrentObserved, deriveRunStatus, formatControlProbeStarted, inspectSafetyFixture, parseControlProbeArgs, parseModelSelector, reduceControlEvent, renderActivityLines, sanitizeControlError } from "../extensions/control-probe.ts";

const event = (state, type, childId, at) => reduceControlEvent(state, { type, childId, at });
test("parses exact start/cancel grammar and nested model selectors", () => { assert.deepEqual(parseModelSelector("openrouter/openai/gpt"), { valid: true, provider: "openrouter", model: "openai/gpt" }); assert.equal(parseControlProbeArgs("start a/b c/d").mode, "start"); assert.deepEqual(parseControlProbeArgs("cancel run a"), { mode: "cancel", runId: "run", childId: "a" }); for (const input of ["", "start a/b", "start a/b c/d extra", "cancel run c"]) assert.equal(parseControlProbeArgs(input).error, "invalid_arguments"); });
test("concurrency requires overlapping observed Pi agent intervals", () => { const base = createInitialRunState({ runId: "run", at: 0 }); const overlapping = event(event(event(event(base, "child-agent-started", "a", 1), "child-agent-started", "b", 2), "child-agent-settled", "a", 4), "child-agent-settled", "b", 5); assert.equal(deriveConcurrentObserved(overlapping), true); const sequential = event(event(event(event(base, "child-agent-started", "a", 1), "child-agent-settled", "a", 2), "child-agent-started", "b", 3), "child-agent-settled", "b", 4); assert.equal(deriveConcurrentObserved(sequential), false); const failed = event(event(base, "child-failed", "a", 1), "child-failed", "b", 2); assert.equal(deriveConcurrentObserved(failed), false); });
test("reducer is immutable, terminal-monotonic, and renderer is bounded", () => { const base = createInitialRunState({ runId: "123456789", at: 0 }); const running = event(base, "child-agent-started", "b", 1); const skilled = reduceControlEvent(running, { type: "skill-explicit", childId: "b", skill: "ima-pi-probe", at: 2 }); assert.equal(base.children.b.state, "starting"); assert.equal(running.children.b.state, "running"); assert.deepEqual(renderActivityLines(skilled).slice(1, 3).map((line) => line[0]), ["a", "b"]); assert.ok(renderActivityLines(skilled).length <= 4); assert.equal(reduceControlEvent(event(base, "child-completed", "a", 1), { type: "child-agent-started", childId: "a", at: 2 }).children.a.state, "completed"); });
test("pass status requires all five controlled safety facts", () => { let state = event(event(createInitialRunState({ runId: "run", at: 0 }), "child-completed", "a", 1), "child-completed", "b", 2); state = reduceControlEvent(state, { type: "safety-blocked", childId: "b", family: "delete", at: 3 }); state = reduceControlEvent(state, { type: "safety-blocked", childId: "b", family: "git", at: 4 }); assert.equal(deriveRunStatus(state), "failed"); state = reduceControlEvent(state, { type: "safety-inspected", childId: "b", at: 5, facts: { deleteSentinelPreserved: true, gitStatePreserved: true, harmlessCommandObserved: true } }); assert.equal(deriveRunStatus(state), "passed"); });
test("fixture is committed and dirty, then proves preservation and harmless work", async () => { const workspace = await mkdtemp(join(tmpdir(), "ima-control-test-")); try { const fixture = await createSafetyFixture(workspace); assert.ok(fixture.head); assert.ok(fixture.dirtyStatus); await writeFile(fixture.harmlessMarker, "ok"); assert.deepEqual(await inspectSafetyFixture(fixture), { deleteSentinelPreserved: true, gitStatePreserved: true, harmlessCommandObserved: true }); } finally { await rm(workspace, { recursive: true, force: true }); } });
test("cancellation facts are stable and deduplicated", () => { assert.deepEqual(classifyCancellationEvidence({ abortRequested: true, abortSettled: true, childWasAlreadySettled: false, controlledMarkerExists: true, controlledSideEffects: ["marker-written"] }), { outcome: "cancelled-partial", possiblePartialEffects: ["marker-written"] }); assert.equal(classifyCancellationEvidence({ abortRequested: true, abortSettled: false, childWasAlreadySettled: false, controlledMarkerExists: false, controlledSideEffects: [] }).outcome, "cancel-failed"); });
test("narrow deletion classifier allows benign paths and blocks supported direct targets", () => { const bounds = { protectedRoots: ["/", "/home"], disposableRoot: "/tmp/control-probe-delete" }; for (const command of ["rm -rf /", "rm -fr /home/eric", "rm -rf /tmp/control-probe-delete/*", "git reset --hard", "git clean -fd", "git push origin main --force"]) assert.notEqual(classifyDestructiveCommand(command, bounds), null, command); for (const command of ["rm one-file", "rm notes/file.txt", "rm -rf tmp/cache", "rm -rf relative/dir", "rm -rf /homeward/x", "echo rm -rf /", "rm -rf /tmp/control-probe-delete/*; git status"]) assert.equal(classifyDestructiveCommand(command, bounds), null, command); });
test("only post-expansion skill blocks are explicit and semantic use remains unprovable", () => { const expanded = '<skill name="ima-pi-probe" location="/tmp/SKILL.md">\nx\n</skill>\n\nbrief'; assert.equal(classifySkillObservation({ available: true, expandedMessage: expanded }).explicitlyLoaded, true); assert.equal(classifySkillObservation({ available: true, expandedMessage: "/skill:ima-pi-probe x" }).explicitlyLoaded, false); assert.equal(classifySkillObservation({ available: true, expandedMessage: { content: expanded } }).explicitlyLoaded, false); assert.equal(classifySkillObservation({ available: false, expandedMessage: expanded }).useNotProvable, true); });
test("sanitizes credential-like errors", () => { const value = sanitizeControlError("failed", "Bearer token api_key=value sk-secret"); assert.doesNotMatch(value.message, /token|value|sk-secret/); });

test("single run-state controller preserves cancellation facts through later lifecycle observation", () => {
  const controller = createRunStateController(createInitialRunState({ runId: "run", at: 0 }));
  controller.dispatch({ type: "cancel-requested", childId: "a", at: 1 });
  controller.dispatch({ type: "cancel-settled", childId: "a", outcome: "cancelled-partial", at: 2 });
  controller.update((state) => ({ ...state, cancellation: { ...state.cancellation, possiblePartialEffects: ["marker-written"] } }));
  controller.dispatch({ type: "child-agent-settled", childId: "a", at: 3 });
  assert.deepEqual(controller.state.cancellation, { requested: true, childId: "a", outcome: "cancelled-partial", possiblePartialEffects: ["marker-written"] });
  assert.equal(controller.state.children.a.observedSettledAt, 3);
});
test("start notification exposes the exact cancellation UUID", () => {
  const runId = "123e4567-e89b-12d3-a456-426614174000";
  const message = formatControlProbeStarted(runId);
  assert.match(message, new RegExp(runId));
  assert.notEqual(message, `Control probe ${runId.slice(0, 8)} started.`);
  assert.deepEqual(parseControlProbeArgs(`cancel ${runId} a`), { mode: "cancel", runId, childId: "a" });
});

test("ordered projection captures each mutation snapshot before a delayed sink", async () => {
  const snapshots = [];
  const queue = createOrderedProjectionController(createInitialRunState({ runId: "run", at: 0 }), async (snapshot) => { await new Promise((resolve) => setTimeout(resolve, 1)); snapshots.push(snapshot); });
  const first = queue.dispatch({ type: "cancel-requested", childId: "a", at: 1 });
  const second = queue.dispatch({ type: "cancel-settled", childId: "a", outcome: "cancelled-partial", at: 2 });
  const third = queue.update((state) => ({ ...state, cancellation: { ...state.cancellation, possiblePartialEffects: ["marker-written"] } }));
  const fourth = queue.dispatch({ type: "child-agent-settled", childId: "a", at: 3 });
  await Promise.all([first, second, third, fourth, queue.flush()]);
  assert.equal(snapshots.length, 4);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.cancellation.outcome), [null, "cancelled-partial", "cancelled-partial", "cancelled-partial"]);
  assert.equal(snapshots[0].cancellation.requested, true);
  assert.deepEqual(snapshots[2].cancellation.possiblePartialEffects, ["marker-written"]);
  assert.equal(snapshots[3].children.a.observedSettledAt, 3);
});
test("ordered final safety inspection is projected before shutdown disposal", async () => {
  const snapshots = [];
  const queue = createOrderedProjectionController(createInitialRunState({ runId: "run", at: 0 }), async (snapshot) => { snapshots.push(snapshot); });
  await queue.dispatch({ type: "safety-blocked", childId: "b", family: "delete", at: 1 });
  await queue.dispatch({ type: "safety-blocked", childId: "b", family: "git", at: 2 });
  await queue.dispatch({ type: "safety-inspected", childId: "b", at: 3, facts: { deleteSentinelPreserved: true, gitStatePreserved: true, harmlessCommandObserved: true } });
  await queue.flush();
  assert.deepEqual(snapshots.at(-1).safety, { deleteBlocked: true, gitBlocked: true, deleteSentinelPreserved: true, gitStatePreserved: true, harmlessCommandObserved: true });
});

test("projection accepts one successful configured sink and reports category-only degradation", async () => {
  const uiOnly = await projectAtLeastOne([{ name: "ui", project: async () => {} }]);
  const resultOnly = await projectAtLeastOne([{ name: "result", project: async () => {} }]);
  const degraded = await projectAtLeastOne([{ name: "ui", project: async () => { throw new Error("ui unavailable"); } }, { name: "result", project: async () => {} }]);
  assert.deepEqual(uiOnly, { succeeded: ["ui"], failed: [] });
  assert.deepEqual(resultOnly, { succeeded: ["result"], failed: [] });
  assert.deepEqual(degraded, { succeeded: ["result"], failed: ["ui"] });
});
test("projection fails closed when no configured sink or every sink fails", async () => {
  await assert.rejects(projectAtLeastOne([]), (error) => error instanceof ControlProjectionError && error.code === "no_projection_sink");
  await assert.rejects(projectAtLeastOne([{ name: "ui", project: async () => { throw new Error("no ui"); } }, { name: "result", project: async () => { throw new Error("no file"); } }]), (error) => error instanceof ControlProjectionError && error.code === "all_projection_sinks_failed");
});
test("a rejected projection task does not poison later ordered snapshots", async () => {
  const seen = []; let count = 0;
  const queue = createOrderedProjectionController(createInitialRunState({ runId: "run", at: 0 }), async (snapshot) => { count += 1; if (count === 1) throw new Error("first sink failure"); seen.push(snapshot.cancellation.childId); return { succeeded: ["ui"], failed: [] }; });
  const rejected = queue.dispatch({ type: "cancel-requested", childId: "a", at: 1 });
  const recovered = queue.dispatch({ type: "cancel-settled", childId: "a", outcome: "cancelled-clean", at: 2 });
  await assert.rejects(rejected, (error) => error instanceof Error);
  await recovered; await queue.flush();
  assert.deepEqual(seen, ["a"]);
});

test("degraded warning failure cannot overturn a successful partial projection", async () => {
  const outcome = await projectWithDegradedWarning([{ name: "ui", project: async () => { throw new Error("ui"); } }, { name: "result", project: async () => {} }], () => { throw new Error("warning"); });
  assert.deepEqual(outcome, { succeeded: ["result"], failed: ["ui"] });
  assert.doesNotThrow(() => bestEffortNotify(() => { throw new Error("notify"); }, "stable"));
});
test("projection gate prevents abort on rejection and invokes it exactly once on success", async () => {
  let aborts = 0;
  assert.equal(await awaitProjectionBeforeAbort(async () => { throw new Error("projection"); }, async () => { aborts += 1; }), false);
  assert.equal(aborts, 0);
  assert.equal(await awaitProjectionBeforeAbort(async () => {}, async () => { aborts += 1; }), true);
  assert.equal(aborts, 1);
});
test("startup cleanup disposes every created child exactly once", async () => {
  const calls = { firstAbort: 0, firstDispose: 0, secondAbort: 0, secondDispose: 0 };
  const first = { disposed: false, session: { abort: async () => { calls.firstAbort += 1; }, dispose: () => { calls.firstDispose += 1; } } };
  const second = { disposed: false, session: { abort: async () => { calls.secondAbort += 1; }, dispose: () => { calls.secondDispose += 1; } } };
  await cleanupCreatedChildren({ a: first, b: second });
  await cleanupCreatedChildren({ a: first, b: second });
  assert.deepEqual(calls, { firstAbort: 1, firstDispose: 1, secondAbort: 1, secondDispose: 1 });
});
