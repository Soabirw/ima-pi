import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCycleOutcomeMarker,
  buildCycleStatus,
  buildResumeSource,
  createCycleState,
  IMA_PROJECT,
  extractPhaseOutcome,
  normalizeCycleSource,
  parseCycleCommand,
  parseJiraTracker,
  parseTaskwarriorTracker,
  reduceCycleState,
  requiredCloseoutEvidence,
  validateCycleState,
} from "../lib/ima-cycle.ts";
import {
  coordinateCycleClose,
  coordinateCycleStart,
  coordinateCycleStop,
  createCycleDispatchConfirmation,
  cycleRoutePhase,
  dispatchCyclePhase,
  expandCyclePrompt,
  observeLifecycleResult,
  reduceCycleDispatchConfirmation,
  registerCycleExtension,
  restoreCycleState,
} from "../extensions/cycle.ts";

const at = "2026-08-04T18:00:00.000Z";
const jira = normalizeCycleSource("FNR-3036");
const task = normalizeCycleSource({ type: "taskwarrior", project: "FNR-3007", uuid: "6bbd7673-451e-4372-b1ad-0534f869725b" });
const identity = { project: "ima-pi", lifecycleKey: "ima-pi:jira:FNR-3036", lifecycleRootMemoryId: "", taskwarriorProject: "", taskwarriorTask: "", taskwarriorUuid: "", jiraKey: "FNR-3036", sourceRefs: ["Jira:FNR-3036"], priorArtifactIds: [] };
const marker = (phase, outcome) => `artifact\n${buildCycleOutcomeMarker({ phase, outcome })}`;

const evidence = (state, phase, outcome, id = phase, artifactId = null) => {
  const result = reduceCycleState(state, { artifact: marker(phase, outcome), toolCallId: id, artifactId, timestamp: at }, { timestamp: at });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state;
};

const awaitingEvidence = (state) => ({ ...state, status: "awaiting-evidence", updatedAt: at });
const implementationAwaitingResumeState = () => evidence(createCycleState(jira, { timestamp: at }), "plan", "APPROVED");
const lifecycleObservation = (state, phase, outcome, toolCallId = `${phase}-tool`) => ({
  state,
  toolName: "ima_lifecycle",
  toolCallId,
  input: { type: phase, identity: { ...identity, lifecycleKey: state.lifecycleKey }, artifact: marker(phase, outcome) },
  result: { details: { status: "completed", phase, lifecycleKey: state.lifecycleKey, artifactId: `${phase}-artifact`, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
  timestamp: at,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};

const createCycleExtensionHarness = (branch) => {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const messages = [];
  const statuses = [];
  const notifications = [];
  const sendWaiters = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (message) => {
      messages.push(message);
      sendWaiters.shift()?.resolve(message);
      return Promise.resolve();
    },
  };
  const ctx = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => branch, getLeafId: () => "branch-id" },
    ui: {
      setStatus: (key, value) => statuses.push({ key, value }),
      notify: (message, level) => notifications.push({ message, level }),
      confirm: async () => true,
    },
  };
  return {
    pi,
    ctx,
    handlers,
    commands,
    entries,
    messages,
    statuses,
    notifications,
    waitForSend: () => {
      const signal = deferred();
      sendWaiters.push(signal);
      return signal.promise;
    },
  };
};

const lifecycleToolResult = (state, phase, outcome, toolCallId = `${phase}-tool`) => {
  const observation = lifecycleObservation(state, phase, outcome, toolCallId);
  return {
    toolName: observation.toolName,
    toolCallId: observation.toolCallId,
    input: observation.input,
    content: observation.result.content,
    details: observation.result.details,
    isError: observation.result.isError,
  };
};

const confirmDispatch = (provisionalState, phase, outcome, message = "expanded prompt", events = []) => {
  let confirmation = createCycleDispatchConfirmation(message);
  confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "input", source: "extension", text: message });
  confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "before-agent-start", prompt: message });
  confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "agent-start" });
  const observed = observeLifecycleResult(lifecycleObservation(provisionalState, phase, outcome));
  assert.equal(observed.matched, true, JSON.stringify(observed));
  events.push("tool-result");
  confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "agent-end", messages: [{ role: "assistant", stopReason: "stop" }] });
  confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "agent-settled" });
  events.push("agent-settled");
  assert.equal(confirmation.status, "succeeded");
  return observed.state;
};

const readyState = () => {
  let state = createCycleState(jira, { timestamp: at });
  state = evidence(state, "plan", "APPROVED");
  state = awaitingEvidence(state);
  state = evidence(state, "implementation", "COMPLETED");
  state = awaitingEvidence(state);
  state = evidence(state, "test", "PASSED");
  state = awaitingEvidence(state);
  state = evidence(state, "review", "APPROVED");
  state = awaitingEvidence(state);
  return evidence(state, "document", "READY");
};

test("parses only closed Jira and Taskwarrior sources", () => {
  assert.deepEqual(parseCycleCommand("start FNR-3036"), { command: "start", source: jira });
  assert.deepEqual(parseCycleCommand("/ima:cycle start https://flccc.atlassian.net/browse/FNR-3036"), { command: "start", source: jira });
  assert.deepEqual(parseCycleCommand("start taskwarrior FNR-3007 6bbd7673-451e-4372-b1ad-0534f869725b"), { command: "start", source: task });
  assert.deepEqual(parseCycleCommand("start FNR-3036 --review-cap 4"), { command: "start", source: jira, reviewCap: 4 });
  assert.deepEqual(parseCycleCommand("/ima:cycle start --review-cap=0 taskwarrior FNR-3007 6bbd7673-451e-4372-b1ad-0534f869725b"), { command: "start", source: task, reviewCap: 0 });
  assert.equal(parseCycleCommand("start FNR-3036 --review-cap 11"), null);
  assert.deepEqual(parseCycleCommand("start FNR-3036 --implementation generic"), { command: "start", source: jira, implementationMode: "generic" });
  assert.deepEqual(parseCycleCommand("start --implementation=js FNR-3036"), { command: "start", source: jira, implementationMode: "js" });
  assert.deepEqual(parseCycleCommand("start FNR-3036 --implementation wp"), { command: "start", source: jira, implementationMode: "wp" });
  assert.equal(parseCycleCommand("start FNR-3036 --implementation"), null);
  assert.equal(parseCycleCommand("start FNR-3036 --implementation=invalid"), null);
  assert.equal(parseCycleCommand("start FNR-3036 --implementation js --implementation=wp"), null);
  assert.equal(parseCycleCommand("start FNR-3036 --unknown-option"), null);
  assert.deepEqual(parseCycleCommand("close --commit-prep"), { command: "close", commitPrep: true });
  assert.equal(parseCycleCommand("start https://evil.example/browse/FNR-3036"), null);
  assert.equal(parseCycleCommand("start FNR-3036 && rm -rf ."), null);
  assert.equal(parseCycleCommand("close --force"), null);
});

test("constructs each implementation phase command and persists explicit selection", () => {
  let generic = createCycleState(jira, { timestamp: at });
  generic = evidence(generic, "plan", "APPROVED");
  assert.match(buildResumeSource(generic), /^\/ima:implement FNR-3036/);
  assert.equal(generic.implementationMode, "generic");

  let js = createCycleState(jira, { timestamp: at, implementationMode: "js" });
  js = evidence(js, "plan", "APPROVED");
  assert.match(buildResumeSource(js), /^\/ima:implement-js FNR-3036/);

  let wp = createCycleState(jira, { timestamp: at, implementationMode: "wp" });
  wp = evidence(wp, "plan", "APPROVED");
  assert.match(buildResumeSource(wp), /^\/ima:implement-wp FNR-3036/);

  const explicit = validateCycleState({ ...generic, implementationMode: "wp" });
  assert.equal(explicit.valid, true);
  assert.equal(explicit.state.implementationMode, "wp");
});

test("normalizes legacy mode to js and rejects invalid present modes", () => {
  const current = evidence(createCycleState(jira, { timestamp: at }), "plan", "APPROVED");
  const legacy = { ...current };
  delete legacy.implementationMode;
  const normalized = validateCycleState(legacy);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.state.implementationMode, "js");
  assert.match(buildResumeSource({ ...legacy, status: "awaiting-resume" }), /^\/ima:implement-js FNR-3036/);
  assert.equal(validateCycleState({ ...current, implementationMode: "ruby" }).valid, false);
  assert.throws(() => createCycleState(jira, { implementationMode: "ruby" }), /implementation_mode_invalid/);
});

test("extracts exactly one phase marker and rejects ambiguity", () => {
  assert.deepEqual(extractPhaseOutcome(marker("review", "REQUEST_CHANGES")), {
    ok: true,
    phase: "review",
    outcome: "REQUEST_CHANGES",
    marker: buildCycleOutcomeMarker({ phase: "review", outcome: "REQUEST_CHANGES" }),
  });
  assert.equal(extractPhaseOutcome("no marker").error.code, "phase_marker_missing");
  assert.equal(extractPhaseOutcome(`${marker("plan", "APPROVED")} ${marker("plan", "BLOCKED")}`).error.code, "phase_marker_ambiguous");
  assert.equal(extractPhaseOutcome(buildCycleOutcomeMarker({ phase: "plan", outcome: "APPROVED" }).replace("APPROVED", "READY")).error.code, "phase_marker_invalid");
});

test("maps cycle phases and expands prompt arguments", () => {
  assert.equal(cycleRoutePhase("implementation"), "implement");
  assert.equal(expandCyclePrompt("/ima:plan FNR-3036", [{ name: "ima:plan", content: "Source: $@" }]), "Source: FNR-3036");
});

test("reduces the fixed lifecycle and holds for explicit resume", () => {
  let state = createCycleState(jira, { timestamp: at });
  state = evidence(state, "plan", "APPROVED", "plan", "plan-artifact");
  assert.deepEqual({ phase: state.phase, status: state.status }, { phase: "implementation", status: "awaiting-resume" });
  const resumeSource = buildResumeSource(state);
  assert.match(resumeSource, /^\/ima:implement FNR-3036/);
  assert.match(resumeSource, /project: ima-pi/);
  assert.match(resumeSource, /lifecycleKey: ima-pi:jira:FNR-3036/);
  assert.match(resumeSource, /priorArtifactIds: plan-artifact/);
  assert.equal(buildCycleStatus(state).implementationMode, "generic");
  assert.equal(reduceCycleState(state, { artifact: marker("implementation", "COMPLETED"), toolCallId: "wrong" }).error.code, "cycle_resume_required");
  state = evidence(awaitingEvidence(state), "implementation", "COMPLETED");
  state = evidence(awaitingEvidence(state), "test", "PASSED");
  state = evidence(awaitingEvidence(state), "review", "APPROVED");
  state = evidence(awaitingEvidence(state), "document", "READY");
  assert.equal(requiredCloseoutEvidence(state).valid, true);
});

test("renders ordered sanitized evidence with explicit source fields", () => {
  let state = createCycleState(jira, { timestamp: at });
  state = evidence(state, "plan", "APPROVED", "plan", null);
  state = evidence(awaitingEvidence(state), "implementation", "COMPLETED", "implementation", "implementation-artifact");
  const packet = buildResumeSource(state);
  const lines = packet.split("\n");
  assert.deepEqual(lines.slice(0, 13), [
    "/ima:test FNR-3036",
    "Lifecycle evidence packet:",
    `project: ${IMA_PROJECT}`,
    "lifecycleKey: ima-pi:jira:FNR-3036",
    "sourceType: jira",
    "source: FNR-3036",
    "jiraKey: FNR-3036",
    "taskwarriorProject: none",
    "taskwarriorUuid: none",
    "reviewCap: 2",
    "implementationMode: generic",
    "orderedPhaseEvidence:",
    "phase: plan",
  ]);
  assert.match(packet, /phase: plan\noutcome: APPROVED\ntimestamp: 2026-08-04T18:00:00.000Z\nartifactId: none\ntoolCallId: plan/);
  assert.match(packet, /phase: implementation\noutcome: COMPLETED\ntimestamp: 2026-08-04T18:00:00.000Z\nartifactId: implementation-artifact\ntoolCallId: implementation/);
  assert.match(packet, /priorArtifactIds: implementation-artifact$/);
  assert.ok(packet.indexOf("phase: plan") < packet.indexOf("phase: implementation"));
  assert.ok(packet.indexOf("orderedPhaseEvidence:") < packet.indexOf("priorArtifactIds:"));
});

test("caps review request-change loops and rejects out-of-order or duplicate evidence", () => {
  let state = createCycleState(jira, { timestamp: at, reviewCap: 1 });
  state = evidence(state, "plan", "APPROVED");
  state = awaitingEvidence(state);
  state = evidence(state, "implementation", "COMPLETED");
  state = awaitingEvidence(state);
  state = evidence(state, "test", "PASSED");
  state = awaitingEvidence(state);
  state = evidence(state, "review", "REQUEST_CHANGES");
  assert.deepEqual({ phase: state.phase, reviewAttempts: state.reviewAttempts }, { phase: "resolution", reviewAttempts: 1 });
  state = awaitingEvidence(state);
  const resolutionState = state;
  state = evidence(state, "resolution", "RESOLVED");
  const resolutionDone = awaitingEvidence(state);
  state = resolutionDone;
  const secondReview = evidence(state, "rereview", "REQUEST_CHANGES");
  assert.equal(secondReview.status, "blocked");
  const wrong = reduceCycleState(awaitingEvidence(state), { artifact: marker("document", "READY"), toolCallId: "wrong", timestamp: at });
  assert.equal(wrong.error.code, "phase_evidence_out_of_order");
  const duplicate = reduceCycleState(resolutionDone, { artifact: marker("resolution", "RESOLVED"), toolCallId: "resolution", timestamp: at });
  assert.equal(duplicate.error.code, "phase_evidence_out_of_order");
});

test("allows canonical resolution and rereview markers on separate review attempts", () => {
  let state = createCycleState(jira, { timestamp: at, reviewCap: 2 });
  state = evidence(state, "plan", "APPROVED");
  state = evidence(awaitingEvidence(state), "implementation", "COMPLETED");
  state = evidence(awaitingEvidence(state), "test", "PASSED");
  state = evidence(awaitingEvidence(state), "review", "REQUEST_CHANGES", "review-1");
  state = evidence(awaitingEvidence(state), "resolution", "RESOLVED", "resolution-1");
  state = evidence(awaitingEvidence(state), "rereview", "REQUEST_CHANGES", "rereview-1");
  state = evidence(awaitingEvidence(state), "resolution", "RESOLVED", "resolution-2");
  state = evidence(awaitingEvidence(state), "rereview", "APPROVED", "rereview-2");
  assert.deepEqual({ phase: state.phase, status: state.status, reviewAttempts: state.reviewAttempts }, { phase: "document", status: "awaiting-resume", reviewAttempts: 2 });
});

test("observes only fully verified matching lifecycle results", () => {
  let state = createCycleState(jira, { timestamp: at });
  const artifact = marker("plan", "APPROVED");
  const result = observeLifecycleResult({
    state,
    toolName: "ima_lifecycle",
    toolCallId: "tool-plan",
    input: { type: "plan", identity, artifact },
    result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, artifactId: "plan-id", receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
    timestamp: at,
  });
  assert.equal(result.matched, true);
  assert.equal(result.state.evidence[0].artifactId, "plan-id");
  const mismatch = observeLifecycleResult({
    state,
    toolName: "ima_lifecycle",
    toolCallId: "bad",
    input: { type: "plan", identity: { ...identity, lifecycleKey: "other" }, artifact },
    result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
  });
  assert.equal(mismatch.matched, false);
  assert.equal(mismatch.error.code, "lifecycle_identity_mismatch");
  const projectMismatch = observeLifecycleResult({
    state,
    toolName: "ima_lifecycle",
    toolCallId: "wrong-project",
    input: { type: "plan", identity: { ...identity, project: "other-project" }, artifact },
    result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
  });
  assert.equal(projectMismatch.matched, false);
  assert.equal(projectMismatch.error.code, "lifecycle_identity_mismatch");
  const foreignTool = observeLifecycleResult({ state, toolName: "other_tool", toolCallId: "foreign", input: { type: "plan", identity, artifact }, result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false }, timestamp: at });
  assert.equal(foreignTool.matched, false);
  const invalid = observeLifecycleResult({ state, toolName: "ima_lifecycle", toolCallId: "invalid", input: { type: "plan", identity, artifact: "not a lifecycle marker" }, result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false }, timestamp: at });
  assert.equal(invalid.matched, false);
  const failed = observeLifecycleResult({ state, toolName: "ima_lifecycle", toolCallId: "failed", input: { type: "plan", identity, artifact }, result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: true }, timestamp: at });
  assert.equal(failed.matched, false);
});

test("enforces literal ima-pi identity for custom lifecycle keys", () => {
  const state = createCycleState(jira, { lifecycleKey: "custom:lifecycle-key", timestamp: at });
  const artifact = marker("plan", "APPROVED");
  const result = observeLifecycleResult({
    state,
    toolName: "ima_lifecycle",
    toolCallId: "custom-project",
    input: { type: "plan", identity: { ...identity, project: "custom", lifecycleKey: state.lifecycleKey }, artifact },
    result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
    timestamp: at,
  });
  assert.equal(result.matched, false);
  assert.equal(result.error.code, "lifecycle_identity_mismatch");

  const canonical = observeLifecycleResult({
    state,
    toolName: "ima_lifecycle",
    toolCallId: "custom-canonical",
    input: { type: "plan", identity: { ...identity, lifecycleKey: state.lifecycleKey, project: IMA_PROJECT }, artifact },
    result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
    timestamp: at,
  });
  assert.equal(canonical.matched, true);
});

test("accepts closeout lifecycle evidence for the document phase", () => {
  let state = createCycleState(jira, { timestamp: at });
  state = evidence(state, "plan", "APPROVED");
  state = awaitingEvidence(state);
  state = evidence(state, "implementation", "COMPLETED");
  state = awaitingEvidence(state);
  state = evidence(state, "test", "PASSED");
  state = awaitingEvidence(state);
  state = evidence(state, "review", "APPROVED");
  state = awaitingEvidence(state);
  const artifact = marker("document", "READY");
  const result = observeLifecycleResult({
    state,
    toolName: "ima_lifecycle",
    toolCallId: "tool-closeout",
    input: { type: "closeout", identity, artifact },
    result: { details: { status: "completed", phase: "closeout", lifecycleKey: state.lifecycleKey, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
    timestamp: at,
  });
  assert.equal(result.matched, true);
  assert.equal(result.state.status, "closeout-ready");
});

test("restores the latest valid branch snapshot", () => {
  const state = createCycleState(task, { timestamp: at });
  assert.deepEqual(restoreCycleState([
    { type: "custom", customType: "ima-cycle-state", data: { invalid: true } },
    { type: "custom", customType: "ima-cycle-state", data: state },
  ]), state);
  assert.equal(restoreCycleState([{ type: "custom", customType: "ima-cycle-state", data: { schemaVersion: 1 } }]), null);
});

test("requires exact correlated dispatch events and terminal settlement", () => {
  const expectedPrompt = "expanded prompt";
  const assistant = (stopReason) => ({ role: "assistant", stopReason });
  const initial = createCycleDispatchConfirmation(expectedPrompt);
  assert.equal(reduceCycleDispatchConfirmation(initial, { type: "agent-start" }).status, "waiting-input");
  assert.equal(reduceCycleDispatchConfirmation(initial, { type: "input", source: "interactive", text: expectedPrompt }).status, "waiting-input");
  assert.equal(reduceCycleDispatchConfirmation(initial, { type: "agent-end", messages: [assistant("stop")] }).status, "waiting-input");
  assert.equal(reduceCycleDispatchConfirmation(initial, { type: "agent-settled" }).status, "waiting-input");

  let state = reduceCycleDispatchConfirmation(initial, { type: "input", source: "extension", text: expectedPrompt });
  assert.equal(state.status, "waiting-before-agent");
  assert.equal(reduceCycleDispatchConfirmation(state, { type: "before-agent-start", prompt: "foreign" }).status, "waiting-before-agent");
  state = reduceCycleDispatchConfirmation(state, { type: "before-agent-start", prompt: expectedPrompt });
  state = reduceCycleDispatchConfirmation(state, { type: "agent-start" });
  state = reduceCycleDispatchConfirmation(state, { type: "agent-end", messages: [assistant("stop")] });
  state = reduceCycleDispatchConfirmation(state, { type: "agent-settled" });
  assert.equal(state.status, "succeeded");
});

test("fails terminal dispatch confirmation for unsafe terminal results and timeout", () => {
  const assistant = (stopReason) => ({ role: "assistant", stopReason });
  const started = () => {
    let state = createCycleDispatchConfirmation("prompt");
    state = reduceCycleDispatchConfirmation(state, { type: "input", source: "extension", text: "prompt" });
    state = reduceCycleDispatchConfirmation(state, { type: "before-agent-start", prompt: "prompt" });
    return reduceCycleDispatchConfirmation(state, { type: "agent-start" });
  };
  for (const stopReason of ["error", "aborted", "length", "toolUse", "other"]) {
    assert.equal(reduceCycleDispatchConfirmation(started(), { type: "agent-end", messages: [assistant(stopReason)] }).status, "failed");
  }
  assert.equal(reduceCycleDispatchConfirmation(started(), { type: "agent-end", messages: [{ role: "user" }] }).status, "failed");
  assert.equal(reduceCycleDispatchConfirmation(createCycleDispatchConfirmation("prompt"), { type: "timeout" }).status, "failed");
  let mismatched = reduceCycleDispatchConfirmation(createCycleDispatchConfirmation("prompt"), { type: "input", source: "extension", text: "prompt" });
  mismatched = reduceCycleDispatchConfirmation(mismatched, { type: "before-agent-start", prompt: "wrong" });
  assert.equal(mismatched.status, "waiting-before-agent");
  assert.equal(reduceCycleDispatchConfirmation(mismatched, { type: "timeout" }).status, "failed");
});

test("buffers fresh-start lifecycle evidence until terminal settlement", async () => {
  const events = [];
  const stateEntries = [];
  const result = await coordinateCycleStart({
    source: jira,
    cwd: "/repo",
    context: async () => ({ status: "ready" }),
    applyRoute: async () => ({ ok: true }),
    appendState: (next) => { events.push("append"); stateEntries.push(next); },
    expandPrompt: async (message) => message,
    sendUserMessage: async (_message, provisionalState) => {
      assert.equal(provisionalState.status, "awaiting-evidence");
      return confirmDispatch(provisionalState, "plan", "APPROVED", "expanded prompt", events);
    },
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["tool-result", "agent-settled", "append"]);
  assert.equal(stateEntries.length, 1);
  assert.equal(result.state.phase, "implementation");
  assert.equal(result.state.status, "awaiting-resume");
  assert.equal(result.state.evidence.at(-1).phase, "plan");
  assert.deepEqual(stateEntries[0], result.state);
});

test("tracks queued continuation runs before accepting settlement", () => {
  const started = () => {
    let state = createCycleDispatchConfirmation("prompt");
    state = reduceCycleDispatchConfirmation(state, { type: "input", source: "extension", text: "prompt" });
    state = reduceCycleDispatchConfirmation(state, { type: "before-agent-start", prompt: "prompt" });
    return reduceCycleDispatchConfirmation(state, { type: "agent-start" });
  };
  const firstRunStopped = () => reduceCycleDispatchConfirmation(started(), { type: "agent-end", messages: [{ role: "assistant", stopReason: "stop" }] });

  let state = firstRunStopped();
  state = reduceCycleDispatchConfirmation(state, { type: "agent-start" });
  state = reduceCycleDispatchConfirmation(state, { type: "agent-end", messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(reduceCycleDispatchConfirmation(state, { type: "agent-settled" }).status, "succeeded");

  for (const stopReason of ["error", "aborted"]) {
    state = reduceCycleDispatchConfirmation(firstRunStopped(), { type: "agent-start" });
    state = reduceCycleDispatchConfirmation(state, { type: "agent-end", messages: [{ role: "assistant", stopReason }] });
    assert.equal(state.status, "failed");
    assert.equal(reduceCycleDispatchConfirmation(state, { type: "agent-settled" }).status, "failed");
  }

  assert.equal(reduceCycleDispatchConfirmation(firstRunStopped(), { type: "agent-end", messages: [{ role: "assistant", stopReason: "stop" }] }).status, "failed");
});

test("starts only after context and route succeed, then injects the plan", async () => {
  const calls = [];
  const stateEntries = [];
  const result = await coordinateCycleStart({
    source: jira,
    reviewCap: 4,
    implementationMode: "wp",
    cwd: "/repo",
    context: async (request, cwd) => { calls.push(["context", request, cwd]); return { status: "ready" }; },
    applyRoute: async (phase) => { calls.push(["route", phase]); return { ok: true }; },
    appendState: (state) => { calls.push(["append", state.status]); stateEntries.push(state); },
    expandPrompt: async (message) => { calls.push(["expand", message]); return "expanded prompt"; },
    sendUserMessage: async (message, provisionalState) => { calls.push(["send", message]); return provisionalState; },
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["context", "route", "expand", "send", "append"]);
  assert.equal(calls.find(([kind]) => kind === "send")[1], "expanded prompt");
  assert.equal(stateEntries[0].status, "awaiting-evidence");
  assert.equal(result.state.reviewCap, 4);
  assert.equal(result.state.implementationMode, "wp");
});

test("does not persist a waiting state when prompt injection fails", async () => {
  const stateEntries = [];
  const result = await coordinateCycleStart({
    source: jira,
    cwd: "/repo",
    context: async () => ({ status: "ready" }),
    applyRoute: async () => ({ ok: true }),
    appendState: (state) => stateEntries.push(state),
    sendUserMessage: async () => { throw new Error("send failed"); },
    timestamp: at,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cycle_phase_injection_failed");
  assert.deepEqual(stateEntries, []);
});

test("evaluates resume evidence against provisional awaiting-evidence state", async () => {
  let committed = createCycleState(jira, { timestamp: at });
  committed = evidence(committed, "plan", "APPROVED");
  const committedSnapshot = structuredClone(committed);
  const stateEntries = [];
  const result = await dispatchCyclePhase({
    state: committed,
    applyRoute: async () => ({ ok: true }),
    appendState: (next) => stateEntries.push(next),
    expandPrompt: async () => "expanded prompt",
    sendUserMessage: async (_message, provisionalState) => {
      assert.equal(provisionalState.status, "awaiting-evidence");
      assert.equal(observeLifecycleResult(lifecycleObservation(committed, "implementation", "COMPLETED")).matched, false);
      return confirmDispatch(provisionalState, "implementation", "COMPLETED");
    },
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "test");
  assert.equal(result.state.status, "awaiting-resume");
  assert.deepEqual(stateEntries, [result.state]);
  assert.deepEqual(committed, committedSnapshot);
});

test("discards buffered lifecycle evidence when terminal confirmation fails", async () => {
  let committed = createCycleState(jira, { timestamp: at });
  committed = evidence(committed, "plan", "APPROVED");
  const committedSnapshot = structuredClone(committed);
  const stateEntries = [];
  let buffered;
  const result = await dispatchCyclePhase({
    state: committed,
    applyRoute: async () => ({ ok: true }),
    appendState: (next) => stateEntries.push(next),
    expandPrompt: async () => "expanded prompt",
    sendUserMessage: async (message, provisionalState) => {
      const observed = observeLifecycleResult(lifecycleObservation(provisionalState, "implementation", "COMPLETED"));
      assert.equal(observed.matched, true);
      buffered = observed.state;
      let confirmation = createCycleDispatchConfirmation(message);
      confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "input", source: "extension", text: message });
      confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "before-agent-start", prompt: message });
      confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "agent-start" });
      confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "agent-end", messages: [{ role: "assistant", stopReason: "error" }] });
      assert.equal(confirmation.status, "failed");
      confirmation = reduceCycleDispatchConfirmation(confirmation, { type: "agent-settled" });
      assert.equal(confirmation.status, "failed");
      throw new Error("cycle_phase_injection_unverified");
    },
    timestamp: at,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cycle_phase_injection_failed");
  assert.equal(buffered.phase, "test");
  assert.deepEqual(stateEntries, []);
  assert.deepEqual(committed, committedSnapshot);
});

test("dispatches route before injection and requires acknowledgement for write-capable stop", async () => {
  const calls = [];
  let state = createCycleState(jira, { timestamp: at });
  state = evidence(state, "plan", "APPROVED");
  const dispatch = await dispatchCyclePhase({ state, applyRoute: async (phase) => { calls.push(["route", phase]); return { ok: true }; }, appendState: (next) => calls.push(["append", next.status]), expandPrompt: async (message) => { calls.push(["expand", message]); return "expanded prompt"; }, sendUserMessage: async (message, provisionalState) => { calls.push(["send", message]); return provisionalState; }, timestamp: at });
  assert.equal(dispatch.ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["route", "expand", "send", "append"]);
  assert.equal(dispatch.state.status, "awaiting-evidence");
  assert.equal(dispatch.state.evidence.length, 1);
  const blocked = coordinateCycleStop({ state: dispatch.state, acknowledge: false, appendState: () => calls.push(["stop-append"]), abort: () => calls.push(["abort"]), timestamp: at });
  assert.equal(blocked.error.code, "cycle_stop_ack_required");
  assert.equal(calls.some(([kind]) => kind === "abort"), false);
  const stopped = coordinateCycleStop({ state: dispatch.state, acknowledge: true, appendState: () => calls.push(["stop-append"]), abort: () => calls.push(["abort"]), timestamp: at });
  assert.equal(stopped.ok, true);
  assert.deepEqual(calls.slice(-2).map(([kind]) => kind), ["stop-append", "abort"]);
  const failedEntries = [];
  const failed = await dispatchCyclePhase({ state, applyRoute: async () => ({ ok: true }), appendState: (next) => failedEntries.push(next), sendUserMessage: async () => { throw new Error("send failed"); }, timestamp: at });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "cycle_phase_injection_failed");
  assert.deepEqual(failedEntries, []);
});

test("closes exactly one tracker after confirmation and blocks after lifecycle failure", async () => {
  const state = readyState();
  const calls = [];
  const run = async (program, args) => {
    calls.push([program, args]);
    if (args[1] === "jira:transitions") return { code: 0, stdout: JSON.stringify([{ id: "done", name: "Done", to: "Done" }]) };
    if (args[1] === "jira:transition") return { code: 0, stdout: "" };
    throw new Error("unexpected");
  };
  const result = await coordinateCycleClose({ state, mode: "tui", commitPrep: false, confirmed: true, run, lifecycle: async () => ({ status: "failed" }), appendState: (next) => calls.push(["append", next.status]), timestamp: at });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "lifecycle_closeout_failed");
  assert.equal(result.state.status, "blocked-after-tracker-close");
  assert.deepEqual(calls.filter(([program]) => program === "node").map(([, args]) => args[1]), ["jira:transitions", "jira:transition"]);

  const cancelled = await coordinateCycleClose({ state, mode: "tui", commitPrep: false, confirmed: false, run: async () => { throw new Error("must not run"); }, appendState: () => {}, timestamp: at });
  assert.equal(cancelled.error.code, "close_confirmation_required");
});

test("rejects failed tracker reads before any close mutation", async () => {
  const calls = [];
  const result = await coordinateCycleClose({
    state: readyState(),
    mode: "tui",
    commitPrep: false,
    confirmed: true,
    run: async (program, args) => { calls.push([program, args]); return { code: 1, stdout: JSON.stringify([{ id: "done", name: "Done", to: "Done" }]) }; },
    appendState: () => {},
    timestamp: at,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tracker_read_failed");
  assert.equal(calls.length, 1);
});

test("parses task tracker shape and keeps commit preparation read-only", async () => {
  const source = task;
  const parsed = parseTaskwarriorTracker([{ uuid: source.uuid, project: source.project, status: "pending" }], source);
  assert.equal(parsed.valid, true);
  assert.equal(parseTaskwarriorTracker([{ uuid: source.uuid, project: source.project, status: "completed" }], source).error.code, "taskwarrior_not_pending");
  assert.equal(parseJiraTracker([{ id: "done", name: "Done", to: "Done" }]).doneTransitions.length, 1);
  const calls = [];
  const prep = await coordinateCycleClose({ state: createCycleState(source, { timestamp: at }), mode: "tui", commitPrep: true, run: async (program, args) => { calls.push([program, args]); return { code: 0, stdout: "" }; }, appendState: () => {} });
  assert.equal(prep.ok, true);
  assert.deepEqual(calls.map(([program, args]) => [program, args]), [["git", ["status", "--short"]], ["git", ["diff", "--check"]]]);
});

test("default cycle wiring buffers lifecycle evidence until settlement", async () => {
  const committed = implementationAwaitingResumeState();
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: committed }]);
  const routedPhases = [];
  const expandedPrompts = [];
  registerCycleExtension(harness.pi, {
    applyRoute: async (_pi, _ctx, phase) => { routedPhases.push(phase); return { ok: true }; },
    expandPrompt: async (value, cwd) => { expandedPrompts.push([value, cwd]); return "expanded prompt"; },
  });

  for (const event of ["input", "before_agent_start", "agent_start", "agent_end", "agent_settled", "tool_result"]) assert.equal(harness.handlers.has(event), true, event);
  assert.equal(harness.commands.has("ima:cycle"), true);
  await harness.handlers.get("session_start")({}, harness.ctx);

  const command = harness.commands.get("ima:cycle");
  const sendCalled = harness.waitForSend();
  let commandSettled = false;
  const commandPromise = command.handler("resume", harness.ctx).then(() => { commandSettled = true; });
  await sendCalled;
  assert.deepEqual(harness.messages, ["expanded prompt"]);
  assert.deepEqual(routedPhases, ["implementation"]);
  assert.deepEqual(expandedPrompts, [[buildResumeSource(committed), "/repo"]]);

  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await harness.handlers.get("tool_result")(lifecycleToolResult(awaitingEvidence(committed), "implementation", "COMPLETED"), harness.ctx);
  assert.equal(commandSettled, false);
  assert.equal(harness.entries.length, 0);

  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.handlers.get("agent_settled")();
  await commandPromise;

  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].customType, "ima-cycle-state");
  assert.equal(harness.entries[0].data.phase, "test");
  assert.equal(harness.entries[0].data.status, "awaiting-resume");
  assert.equal(harness.entries[0].data.evidence.at(-1).phase, "implementation");
  assert.equal(harness.entries[0].data.evidence.at(-1).outcome, "COMPLETED");
  assert.equal(harness.entries[0].data.evidence.at(-1).toolCallId, "implementation-tool");
  assert.equal(harness.entries.length, 1);
});

test("default cycle wiring discards buffered evidence after terminal failure", async () => {
  const committed = implementationAwaitingResumeState();
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: committed }]);
  registerCycleExtension(harness.pi, {
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  });
  await harness.handlers.get("session_start")({}, harness.ctx);

  const command = harness.commands.get("ima:cycle");
  const firstSend = harness.waitForSend();
  const firstCommand = command.handler("resume", harness.ctx);
  await firstSend;
  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await harness.handlers.get("tool_result")(lifecycleToolResult(awaitingEvidence(committed), "implementation", "COMPLETED"), harness.ctx);
  assert.equal(harness.entries.length, 0);

  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.handlers.get("agent_start")();
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error" }] });
  harness.handlers.get("agent_settled")();
  await firstCommand;

  assert.equal(harness.entries.length, 0);
  assert.deepEqual(harness.statuses.at(-1).value, "Cycle awaiting-resume: FNR-3036; phase implementation; review 0/2.");
  await command.handler("status", harness.ctx);
  assert.equal(harness.statuses.at(-1).value, "Cycle awaiting-resume: FNR-3036; phase implementation; review 0/2.");
  assert.deepEqual(harness.entries, []);

  const secondSend = harness.waitForSend();
  const secondCommand = command.handler("resume", harness.ctx);
  await secondSend;
  assert.equal(harness.messages.length, 2);
  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error" }] });
  harness.handlers.get("agent_settled")();
  await secondCommand;

  assert.equal(harness.entries.length, 0);
  assert.deepEqual(harness.statuses.at(-1).value, "Cycle awaiting-resume: FNR-3036; phase implementation; review 0/2.");
});
