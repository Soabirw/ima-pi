import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCycleOutcomeMarker,
  buildResumeSource,
  createCycleState,
  cycleLifecycleKey,
  cycleSourceReference,
  normalizeCycleSource,
  parseCycleCommand,
  parseLifecycleSearchRecords,
  parsePlaneCurrentWorkItem,
  parsePlaneStateMutation,
  parsePlaneWorkflowStates,
  reduceCycleState,
  validateCycleState,
} from "../lib/ima-cycle.ts";
import {
  coordinateCycleClose,
  coordinateCycleReconcile,
  coordinateCycleStart,
  observeLifecycleResult,
} from "../extensions/cycle.ts";

const at = "2026-09-05T02:00:00.000Z";
const plane = normalizeCycleSource("plane:ima:SKYNET-61");
const browseUrl = "https://plane.example/ima/browse/SKYNET-61";
const workItemId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const startedStateId = "33333333-3333-4333-8333-333333333333";
const completedStateId = "44444444-4444-4444-8444-444444444444";
const cancelledStateId = "55555555-5555-4555-8555-555555555555";

assert.ok(plane);
assert.equal(plane.type, "plane");

const currentWorkItem = (overrides = {}) => ({
  success: true,
  data: {
    id: workItemId,
    projectId,
    reference: "plane:ima:SKYNET-61",
    workspace: "ima",
    identifier: "SKYNET-61",
    sequenceId: 61,
    stateId: startedStateId,
    ...overrides,
  },
});

const workflowStates = (states = [
  { id: startedStateId, group: "started" },
  { id: completedStateId, group: "completed" },
  { id: cancelledStateId, group: "cancelled" },
]) => ({
  success: true,
  data: {
    reference: "plane:ima:SKYNET-61",
    workItemId,
    states,
  },
});

const stateMutation = (overrides = {}) => ({
  success: true,
  data: {
    reference: "plane:ima:SKYNET-61",
    workItemId,
    stateId: completedStateId,
    ...overrides,
  },
});

const evidence = (state, phase, outcome) => {
  const result = reduceCycleState(state, {
    artifact: buildCycleOutcomeMarker({ phase, outcome }),
    toolCallId: `${phase}-${outcome}`,
    timestamp: at,
  }, { timestamp: at });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state;
};

const awaitingEvidence = (state) => ({ ...state, status: "awaiting-evidence", updatedAt: at });

const closeoutReadyState = () => {
  let state = createCycleState(plane, { timestamp: at });
  state = evidence(state, "plan", "APPROVED");
  state = evidence(awaitingEvidence(state), "implementation", "COMPLETED");
  state = evidence(awaitingEvidence(state), "test", "PASSED");
  state = evidence(awaitingEvidence(state), "review", "APPROVED");
  return evidence(awaitingEvidence(state), "document", "READY");
};

const lifecycleMarker = (state, phase, overrides = {}) => `<!-- ima-lifecycle verification: lifecycle_key=${overrides.lifecycleKey ?? state.lifecycleKey}; nonce=test-nonce; phase=${phase}; jira_key=${overrides.jiraKey ?? ""}; taskwarrior_uuid=${overrides.taskwarriorUuid ?? ""}; plane_workspace=${overrides.planeWorkspace ?? "ima"}; plane_work_item=${overrides.planeWorkItem ?? "SKYNET-61"}; outcome=completed -->`;

const persistedRecord = (state, phase, outcome, overrides = {}) => ({
  id: overrides.id ?? "plane-persisted",
  recordKey: overrides.recordKey ?? "ima-pi:plane:ima:SKYNET-61:plan:plane-test",
  content: `---\nlifecycle: {}\n---\n\n${buildCycleOutcomeMarker({ phase, outcome })}\n\n${lifecycleMarker(state, phase, overrides)}`,
});

test("parses strict canonical, browse-URL, and alias Plane cycle sources with flags", () => {
  const canonical = parseCycleCommand(
    "/ima:cycle start --review-cap 3 plane:ima:SKYNET-61 --mode guided",
  );
  const browseUrlCommand = parseCycleCommand(
    `/ima:cycle start --implementation js ${browseUrl} --review-cap=1 --mode guided`,
  );
  const alias = parseCycleCommand(
    "/ima:cycle start --implementation js plane ima SKYNET-61 --review-cap=1",
  );
  const browseSource = normalizeCycleSource(browseUrl);

  assert.deepEqual(canonical, {
    command: "start",
    source: plane,
    reviewCap: 3,
    mode: "guided",
  });
  assert.deepEqual(browseUrlCommand, {
    command: "start",
    source: plane,
    implementationMode: "js",
    reviewCap: 1,
    mode: "guided",
  });
  assert.deepEqual(alias, {
    command: "start",
    source: plane,
    implementationMode: "js",
    reviewCap: 1,
  });
  assert.deepEqual(browseSource, plane);
  assert.equal(cycleSourceReference(browseSource), "plane:ima:SKYNET-61");
  assert.equal(cycleLifecycleKey(browseSource), "ima-pi:plane:ima:SKYNET-61");

  for (const invalid of [
    "plane:ima:skynet-61",
    "plane:ima:SKYNET-0",
    "plane:ima:SKYNET-61;node",
    "plane:ima:SKYNET-61 extra",
    "http://plane.example/ima/browse/SKYNET-61",
    "https://operator:secret@plane.example/ima/browse/SKYNET-61",
    "https://plane.example/ima/browse/SKYNET-61?query=value",
    "https://plane.example/ima/browse/SKYNET-61?",
    "https://plane.example/ima/browse/SKYNET-61#fragment",
    "https://plane.example/ima/browse/SKYNET-61#",
    "https://plane.example/ima/browse/SKYNET-61/",
    "https://plane.example/ima/browse/SKYNET-61/extra",
    "https://plane.example/browse/SKYNET-61",
    "https://plane.example/ima/SKYNET-61",
    "https://plane.example/ima/browse/skynet-61",
    "https://plane.example/ima/browse/SKYNET-0",
    "https://plane.example/ima/browse/SKYNET-9007199254740992",
    "https://plane.example/ima/browse/SKYNET-61;node",
    "https://plane.example/ima/browse/SKYNET-61%20extra",
    "https://plane.example/ima/browse/SKYNET%2D61",
    "https://plane.example/ima/./browse/SKYNET-61",
    "https://plane.example/ignored/../ima/browse/SKYNET-61",
    "https://plane.example/ima/%2e/browse/SKYNET-61",
    "https://plane.example/ima/%2e%2e/ima/browse/SKYNET-61",
    String.raw`https://plane.example\ima\browse\SKYNET-61`,
    "https:////plane.example/ima/browse/SKYNET-61",
    "https://@plane.example/ima/browse/SKYNET-61",
    { type: "plane", workspace: "ima", project: "SKYNET", sequenceId: 0 },
    { type: "plane", workspace: "ima", project: "SKYNET", sequenceId: 61, extra: true },
  ]) {
    assert.equal(normalizeCycleSource(invalid), null, JSON.stringify(invalid));
    if (typeof invalid === "string") {
      assert.equal(parseCycleCommand(`start ${invalid}`), null, JSON.stringify(invalid));
    }
  }
  assert.equal(parseCycleCommand(`/ima:cycle start ${browseUrl} extra`), null);
});

test("derives Plane lifecycle state and emits a canonical resume packet", () => {
  const state = createCycleState(plane, { timestamp: at });
  const packet = buildResumeSource({ ...state, status: "awaiting-resume" });

  assert.equal(cycleSourceReference(plane), "plane:ima:SKYNET-61");
  assert.equal(cycleLifecycleKey(plane), "ima-pi:plane:ima:SKYNET-61");
  assert.equal(state.lifecycleKey, "ima-pi:plane:ima:SKYNET-61");
  assert.equal(validateCycleState(structuredClone(state)).valid, true);
  assert.match(packet, /^\/ima:plan plane:ima:SKYNET-61$/m);
  assert.match(packet, /^planeWorkspace: ima$/m);
  assert.match(packet, /^planeWorkItem: SKYNET-61$/m);
});

test("starts a Plane browse URL through the canonical typed context boundary", async () => {
  const contextRequests = [];
  const states = [];
  const started = await coordinateCycleStart({
    source: browseUrl,
    cwd: "/repo",
    context: async (request) => {
      contextRequests.push(request);
      return { status: "ready" };
    },
    applyRoute: async () => ({ ok: true }),
    appendState: (state) => states.push(state),
    sendUserMessage: async (_message, state) => state,
    timestamp: at,
  });

  assert.equal(started.ok, true);
  assert.deepEqual(contextRequests, [{ source: plane }]);
  assert.deepEqual(started.state.source, plane);
  assert.equal(started.state.lifecycleKey, "ima-pi:plane:ima:SKYNET-61");
  assert.deepEqual(states.map((state) => state.source), [plane, plane]);
  assert.doesNotMatch(JSON.stringify({ contextRequests, states }), /plane\.example/);
});

test("rejects malformed Plane browse URLs before cycle effects", async () => {
  const calls = [];
  const result = await coordinateCycleStart({
    source: "https://plane.example/ignored/../ima/browse/SKYNET-61",
    cwd: "/repo",
    context: async () => {
      calls.push("context");
      return { status: "ready" };
    },
    applyRoute: async () => {
      calls.push("route");
      return { ok: true };
    },
    appendState: async () => {
      calls.push("append");
    },
    expandPrompt: async () => {
      calls.push("expand");
      return "unexpected";
    },
    sendUserMessage: async () => {
      calls.push("send");
      return null;
    },
    timestamp: at,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test("accepts persisted lifecycle evidence only for the exact Plane identity", async () => {
  const state = createCycleState(plane, { timestamp: at });
  const selection = {
    lifecycleKey: state.lifecycleKey,
    phase: "plan",
    jiraKey: "",
    taskwarriorUuid: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-61",
  };
  const matching = parseLifecycleSearchRecords({
    results: [persistedRecord(state, "plan", "APPROVED")],
  }, selection);
  const wrongWorkspace = parseLifecycleSearchRecords({
    results: [persistedRecord(state, "plan", "APPROVED", { planeWorkspace: "other" })],
  }, selection);
  const wrongWorkItem = parseLifecycleSearchRecords({
    results: [persistedRecord(state, "plan", "APPROVED", { planeWorkItem: "SKYNET-62" })],
  }, selection);
  const wrongTracker = parseLifecycleSearchRecords({
    results: [persistedRecord(state, "plan", "APPROVED", { jiraKey: "FNR-3036" })],
  }, selection);

  assert.equal(matching.valid, true);
  assert.equal(matching.records[0].verified, true);
  assert.equal(wrongWorkspace.records[0].verified, false);
  assert.equal(wrongWorkItem.records[0].verified, false);
  assert.equal(wrongTracker.records[0].verified, false);

  const duplicateBase = persistedRecord(state, "plan", "APPROVED");
  const duplicate = {
    ...duplicateBase,
    content: duplicateBase.content.replace(
      "plane_workspace=ima",
      "plane_workspace=other; plane_workspace=ima",
    ),
  };
  const missingPlaneFieldBase = persistedRecord(state, "plan", "APPROVED");
  const missingPlaneField = {
    ...missingPlaneFieldBase,
    content: missingPlaneFieldBase.content.replace(
      "; plane_work_item=SKYNET-61",
      "",
    ),
  };
  const unexpectedFieldBase = persistedRecord(state, "plan", "APPROVED");
  const unexpectedField = {
    ...unexpectedFieldBase,
    content: unexpectedFieldBase.content.replace(
      "; outcome=completed",
      "; unexpected=value; outcome=completed",
    ),
  };
  for (const record of [duplicate, missingPlaneField, unexpectedField]) {
    const parsed = parseLifecycleSearchRecords({ results: [record] }, selection);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.records[0].verified, false);
  }
  const invalidAppends = [];
  const invalidReconciliation = await coordinateCycleReconcile({
    state,
    recall: async () => ({ structuredContent: { results: [duplicate] } }),
    appendState: (next) => invalidAppends.push(next),
    timestamp: at,
  });
  assert.equal(invalidReconciliation.ok, true);
  assert.equal(invalidReconciliation.reconciled, false);
  assert.equal(invalidAppends.length, 0);

  const appended = [];
  const reconciled = await coordinateCycleReconcile({
    state,
    recall: async () => ({ structuredContent: { results: [persistedRecord(state, "plan", "APPROVED")] } }),
    appendState: (next) => appended.push(next),
    timestamp: at,
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.state.phase, "implementation");
  assert.equal(appended.length, 1);

  const identity = {
    project: "ima-pi",
    lifecycleKey: state.lifecycleKey,
    lifecycleRootMemoryId: "",
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-61",
    sourceRefs: ["plane:ima:SKYNET-61"],
    priorArtifactIds: [],
  };
  const direct = observeLifecycleResult({
    state,
    toolName: "ima_lifecycle",
    toolCallId: "plane-plan",
    input: {
      type: "plan",
      identity,
      artifact: buildCycleOutcomeMarker({ phase: "plan", outcome: "APPROVED" }),
    },
    result: {
      details: {
        status: "completed",
        phase: "plan",
        lifecycleKey: state.lifecycleKey,
        artifactId: "plane-plan-artifact",
        receiptAccepted: true,
        semanticRecall: { matched: true },
      },
      content: [],
      isError: false,
    },
    timestamp: at,
  });
  assert.equal(direct.matched, true);
  const wrongIdentity = observeLifecycleResult({
    state,
    toolName: "ima_lifecycle",
    toolCallId: "plane-plan-wrong-workspace",
    input: {
      type: "plan",
      identity: { ...identity, planeWorkspace: "other" },
      artifact: buildCycleOutcomeMarker({ phase: "plan", outcome: "APPROVED" }),
    },
    result: {
      details: {
        status: "completed",
        phase: "plan",
        lifecycleKey: state.lifecycleKey,
        artifactId: "plane-plan-artifact",
        receiptAccepted: true,
        semanticRecall: { matched: true },
      },
      content: [],
      isError: false,
    },
    timestamp: at,
  });
  assert.equal(wrongIdentity.matched, false);
  assert.equal(wrongIdentity.error.code, "lifecycle_identity_mismatch");
});

test("validates Plane helper envelopes and terminal states before mutation", () => {
  const current = parsePlaneCurrentWorkItem(currentWorkItem(), plane);
  assert.equal(current.valid, true);
  if (!current.valid) return;

  const workflow = parsePlaneWorkflowStates(workflowStates(), plane, current.workItem);
  assert.equal(workflow.valid, true);
  if (!workflow.valid) return;
  assert.equal(workflow.completedState.id, completedStateId);

  assert.equal(
    parsePlaneWorkflowStates(workflowStates([{ id: startedStateId, group: "started" }]), plane, current.workItem).error.code,
    "plane_completed_state_missing",
  );
  assert.equal(
    parsePlaneWorkflowStates(workflowStates([
      { id: startedStateId, group: "started" },
      { id: completedStateId, group: "completed" },
      { id: cancelledStateId, group: "completed" },
    ]), plane, current.workItem).error.code,
    "plane_completed_state_ambiguous",
  );
  assert.equal(
    parsePlaneWorkflowStates(workflowStates([
      { id: startedStateId, group: "completed" },
      { id: completedStateId, group: "completed" },
    ]), plane, current.workItem).error.code,
    "plane_tracker_already_completed",
  );
  assert.equal(
    parsePlaneWorkflowStates(workflowStates([
      { id: startedStateId, group: "cancelled" },
      { id: completedStateId, group: "completed" },
    ]), plane, current.workItem).error.code,
    "plane_tracker_cancelled",
  );
  assert.equal(parsePlaneCurrentWorkItem("not JSON", plane).error.code, "tracker_read_failed");
  assert.equal(
    parsePlaneStateMutation(stateMutation({ stateId: startedStateId }), plane, current.workItem, completedStateId).error.code,
    "tracker_close_failed",
  );
});

test("closes Plane in get-to-states-to-set-state order and never retries after lifecycle failure", async () => {
  const calls = [];
  const lifecycleRequests = [];
  const run = async (program, args) => {
    calls.push([program, args]);
    if (args[1] === "plane:get") return { code: 0, stdout: JSON.stringify(currentWorkItem()) };
    if (args[1] === "plane:states") return { code: 0, stdout: JSON.stringify(workflowStates()) };
    if (args[1] === "plane:set-state") return { code: 0, stdout: JSON.stringify(stateMutation()) };
    throw new Error("unexpected command");
  };

  const result = await coordinateCycleClose({
    state: closeoutReadyState(),
    mode: "tui",
    commitPrep: false,
    confirmed: true,
    run,
    lifecycle: async (request) => {
      lifecycleRequests.push(request);
      return { status: "failed" };
    },
    appendState: () => {},
    timestamp: at,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "lifecycle_closeout_failed");
  assert.equal(result.state.status, "blocked-after-tracker-close");
  assert.deepEqual(calls.map(([program, args]) => [program, args.slice(1)]), [
    ["node", ["plane:get", "plane:ima:SKYNET-61"]],
    ["node", ["plane:states", "plane:ima:SKYNET-61"]],
    ["node", ["plane:set-state", "plane:ima:SKYNET-61", completedStateId]],
  ]);
  assert.equal(lifecycleRequests.length, 1);
  assert.deepEqual(lifecycleRequests[0].identity, {
    project: "ima-pi",
    lifecycleKey: "ima-pi:plane:ima:SKYNET-61",
    lifecycleRootMemoryId: "",
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-61",
    sourceRefs: ["plane:ima:SKYNET-61"],
    priorArtifactIds: [],
  });
});

test("fails closed before a Plane write when a read or state envelope is invalid", async () => {
  const malformed = [];
  const malformedResult = await coordinateCycleClose({
    state: closeoutReadyState(),
    mode: "tui",
    commitPrep: false,
    confirmed: true,
    run: async (program, args) => {
      malformed.push([program, args]);
      return { code: 0, stdout: "not JSON" };
    },
    appendState: () => {},
    timestamp: at,
  });
  assert.equal(malformedResult.error.code, "tracker_read_failed");
  assert.equal(malformed.length, 1);

  const failedRead = [];
  const failedReadResult = await coordinateCycleClose({
    state: closeoutReadyState(),
    mode: "tui",
    commitPrep: false,
    confirmed: true,
    run: async (program, args) => {
      failedRead.push([program, args]);
      return { code: 1, stdout: "" };
    },
    appendState: () => {},
    timestamp: at,
  });
  assert.equal(failedReadResult.error.code, "tracker_read_failed");
  assert.equal(failedRead.length, 1);

  const terminal = [];
  const terminalResult = await coordinateCycleClose({
    state: closeoutReadyState(),
    mode: "tui",
    commitPrep: false,
    confirmed: true,
    run: async (program, args) => {
      terminal.push([program, args]);
      if (args[1] === "plane:get") {
        return { code: 0, stdout: JSON.stringify(currentWorkItem()) };
      }
      return {
        code: 0,
        stdout: JSON.stringify(workflowStates([
          { id: startedStateId, group: "completed" },
        ])),
      };
    },
    appendState: () => {},
    timestamp: at,
  });
  assert.equal(terminalResult.error.code, "plane_tracker_already_completed");
  assert.deepEqual(terminal.map(([, args]) => args[1]), ["plane:get", "plane:states"]);
});

test("does not persist or retry when the Plane helper rejects an unconfirmed mutation", async () => {
  const calls = [];
  const lifecycleRequests = [];
  const appended = [];
  const result = await coordinateCycleClose({
    state: closeoutReadyState(),
    mode: "tui",
    commitPrep: false,
    confirmed: true,
    run: async (program, args) => {
      calls.push([program, args]);
      if (args[1] === "plane:get") {
        return { code: 0, stdout: JSON.stringify(currentWorkItem()) };
      }
      if (args[1] === "plane:states") {
        return { code: 0, stdout: JSON.stringify(workflowStates()) };
      }
      return { code: 1, stdout: "" };
    },
    lifecycle: async (request) => {
      lifecycleRequests.push(request);
      return { status: "completed" };
    },
    appendState: (state) => appended.push(state),
    timestamp: at,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tracker_close_failed");
  assert.deepEqual(calls.map(([, args]) => args[1]), [
    "plane:get",
    "plane:states",
    "plane:set-state",
  ]);
  assert.equal(lifecycleRequests.length, 0);
  assert.equal(appended.length, 0);
});
