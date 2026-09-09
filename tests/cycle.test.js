import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CYCLE_PHASE_OUTCOMES,
  CYCLE_REVIEW_CAP_DEFAULT,
  buildCycleOutcomeMarker,
  buildCycleStatus,
  buildFinalCloseoutArtifact,
  buildResumeSource,
  createCycleState,
  IMA_PROJECT,
  extractPhaseOutcome,
  lifecycleTypeForPhase,
  normalizeCycleSource,
  parseCycleCommand,
  parseJiraTracker,
  parseLifecycleSearchRecords,
  parseTaskwarriorTracker,
  prepareCycleResume,
  reconcileCycleFromLifecycle,
  reduceCycleState,
  requiredCloseoutEvidence,
  resolvePhaseOutcome,
  validateCycleState,
} from "../lib/ima-cycle.ts";
import { parseCycleRecord, serializeCycleRecord } from "../lib/ima-cycle-store.ts";
import { buildLifecycleArtifact } from "../lib/ima-lifecycle.ts";
import {
  coordinateCycleClose,
  coordinateCycleReconcile,
  coordinateCycleRecovery,
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

const evidence = (state, phase, outcome, id = phase, artifactId = null, recordKey = null) => {
  const result = reduceCycleState(state, {
    artifact: marker(phase, outcome),
    toolCallId: id,
    artifactId,
    recordKey,
    timestamp: at,
  }, { timestamp: at });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state;
};

const awaitingEvidence = (state) => ({ ...state, status: "awaiting-evidence", updatedAt: at });
const implementationAwaitingResumeState = () => evidence(createCycleState(jira, { timestamp: at }), "plan", "APPROVED");
const lifecycleObservation = (state, phase, outcome, toolCallId = `${phase}-tool`) => {
  const lifecyclePhase = lifecycleTypeForPhase(phase);
  return {
    state,
    toolName: "ima_lifecycle",
    toolCallId,
    input: { type: lifecyclePhase, identity: { ...identity, lifecycleKey: state.lifecycleKey }, artifact: marker(phase, outcome) },
    result: { details: { status: "completed", phase: lifecyclePhase, lifecycleKey: state.lifecycleKey, artifactId: `${phase}-artifact`, receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
    timestamp: at,
  };
};

const lifecycleVerification = (state, phase, options = {}) => {
  const jiraKey = state.source.type === "jira" ? state.source.key : "";
  const taskwarriorUuid = state.source.type === "taskwarrior" ? state.source.uuid : "";
  return `<!-- ima-lifecycle verification: lifecycle_key=${options.lifecycleKey ?? state.lifecycleKey}; nonce=test-nonce; phase=${options.lifecyclePhase ?? lifecycleTypeForPhase(phase)}; jira_key=${options.jiraKey ?? jiraKey}; taskwarrior_uuid=${options.taskwarriorUuid ?? taskwarriorUuid}; outcome=${options.lifecycleOutcome ?? "completed"} -->`;
};

const persistedRecord = (state, phase, outcome, options = {}) => ({
  id: options.id ?? `${phase}-persisted`,
  ...(options.recordKey === undefined ? {} : { recordKey: options.recordKey }),
  content: `---\nlifecycle: {}\n---\n\n${options.artifact ?? marker(phase, outcome)}\n\n${lifecycleVerification(state, phase, options)}`,
});

const vestigeSearch = (results = []) => ({ structuredContent: { results } });

const reviewUuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const directPlanRecord = (state, outcome = "APPROVED", options = {}) => {
  const id = options.id ?? reviewUuid(700);
  const recordKey = options.recordKey ?? `${state.lifecycleKey}:plan:direct-${id.slice(-4)}`;
  const createdAt = options.createdAt ?? "2026-08-04T18:00:00.000Z";
  const planIdentity = {
    ...identity,
    lifecycleKey: state.lifecycleKey,
    ...(options.identity ?? {}),
  };
  return {
    id,
    recordKey,
    project: "ima-pi",
    lifecycleKey: state.lifecycleKey,
    phase: "plan",
    sourceRefs: [...planIdentity.sourceRefs],
    contentHash: createHash("sha256").update(recordKey, "utf8").digest("hex"),
    createdAt,
    content: buildLifecycleArtifact({
      type: "plan",
      identity: planIdentity,
      artifact: options.artifact ?? marker("plan", outcome),
      nonce: options.nonce ?? reviewUuid(800),
    }),
  };
};

const directDownstreamRecord = (state, phase, outcome, approvalId, options = {}) => {
  const id = options.id ?? reviewUuid(900);
  const recordKey = options.recordKey ?? `${state.lifecycleKey}:${phase}:direct-${id.slice(-4)}`;
  const recordIdentity = {
    ...identity,
    lifecycleKey: state.lifecycleKey,
    priorArtifactIds: options.priorArtifactIds ?? [approvalId],
  };
  return {
    id,
    recordKey,
    project: "ima-pi",
    lifecycleKey: state.lifecycleKey,
    phase,
    sourceRefs: [...recordIdentity.sourceRefs],
    contentHash: createHash("sha256").update(recordKey, "utf8").digest("hex"),
    createdAt: options.createdAt ?? "2026-08-04T18:01:00.000Z",
    content: buildLifecycleArtifact({
      type: lifecycleTypeForPhase(phase),
      identity: recordIdentity,
      artifact: marker(phase, outcome),
      nonce: options.nonce ?? reviewUuid(950),
    }),
  };
};

const importedImplementationState = (plan) => {
  const reduced = reduceCycleState(createCycleState(jira, { timestamp: at }), {
    artifact: marker("plan", "APPROVED"),
    artifactId: plan.id,
    recordKey: plan.recordKey,
    toolCallId: `imported-${plan.id}`,
    timestamp: at,
    approvedPlan: {
      artifactId: plan.id,
      recordKey: plan.recordKey,
      contentHash: plan.contentHash,
      approvedAt: plan.createdAt,
    },
  }, { timestamp: at });
  assert.equal(reduced.ok, true, JSON.stringify(reduced));
  return reduced.state;
};

const awaitingPhaseState = (phase) => {
  let state = createCycleState(jira, { timestamp: at });
  if (phase === "plan") return state;
  state = evidence(state, "plan", "APPROVED");
  if (phase === "implementation") return awaitingEvidence(state);
  state = evidence(awaitingEvidence(state), "implementation", "COMPLETED");
  if (phase === "test") return awaitingEvidence(state);
  state = evidence(awaitingEvidence(state), "test", "PASSED");
  if (phase === "review") return awaitingEvidence(state);
  if (phase === "document") return awaitingEvidence(evidence(awaitingEvidence(state), "review", "APPROVED"));
  state = evidence(awaitingEvidence(state), "review", "REQUEST_CHANGES");
  if (phase === "resolution") return awaitingEvidence(state);
  state = evidence(awaitingEvidence(state), "resolution", "RESOLVED");
  if (phase === "rereview") return awaitingEvidence(state);
  throw new Error(`unsupported phase ${phase}`);
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};

const createCycleExtensionHarness = (branch, run = async () => vestigeSearch()) => {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const messages = [];
  const statuses = [];
  const notifications = [];
  const sendWaiters = [];
  let aborted = false;
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    exec: (program, args) => run(program, args),
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
    abort: () => { aborted = true; },
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
    wasAborted: () => aborted,
    waitForSend: () => {
      const signal = deferred();
      sendWaiters.push(signal);
      return signal.promise;
    },
  };
};

const cycleDependencies = (overrides = {}) => ({
  recall: async () => vestigeSearch(),
  resolveProjectRoot: async (cwd) => cwd,
  loadDurableState: async () => null,
  persistDurableState: async () => {},
  ...overrides,
});

const temporaryDirectory = () => mkdtemp(join(tmpdir(), "ima-cycle-"));

const dispatchWithDefaultStore = async (root, branch = implementationAwaitingResumeState()) => {
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: branch }]);
  harness.ctx.cwd = root;
  registerCycleExtension(harness.pi, {
    recall: async () => vestigeSearch(),
    resolveProjectRoot: async () => root,
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  });
  await harness.handlers.get("session_start")({}, harness.ctx);
  const sent = harness.waitForSend();
  const result = harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  await sent;
  return { harness, result };
};

const failDefaultStoreDispatch = async ({ harness, result }) => {
  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error" }] });
  harness.handlers.get("agent_settled")();
  await result;
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

const settleHarnessDispatch = async (harness, phase, outcome, waitForNext = false) => {
  const nextSend = waitForNext ? harness.waitForSend() : null;
  const provisional = harness.entries.at(-1)?.data;
  assert.equal(provisional?.phase, phase);
  assert.equal(provisional?.status, "awaiting-evidence");
  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await harness.handlers.get("tool_result")(lifecycleToolResult(provisional, phase, outcome), harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.handlers.get("agent_settled")();
  if (nextSend) await nextSend;
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

test("parses closed Jira and Taskwarrior sources", () => {
  assert.deepEqual(parseCycleCommand("start FNR-3036"), { command: "start", source: jira });
  assert.deepEqual(parseCycleCommand("/ima:cycle start https://flccc.atlassian.net/browse/FNR-3036"), { command: "start", source: jira });
  assert.deepEqual(parseCycleCommand("start taskwarrior FNR-3007 6bbd7673-451e-4372-b1ad-0534f869725b"), { command: "start", source: task });
  assert.deepEqual(parseCycleCommand("start FNR-3036 --review-cap 4"), { command: "start", source: jira, reviewCap: 4 });
  assert.deepEqual(parseCycleCommand("/ima:cycle start --review-cap=0 taskwarrior FNR-3007 6bbd7673-451e-4372-b1ad-0534f869725b"), { command: "start", source: task, reviewCap: 0 });
  assert.deepEqual(parseCycleCommand("start --mode autonomous FNR-3036"), { command: "start", source: jira, mode: "autonomous" });
  assert.deepEqual(parseCycleCommand("start FNR-3036 --autonomous"), { command: "start", source: jira, mode: "autonomous" });
  assert.deepEqual(parseCycleCommand("start --guided FNR-3036"), { command: "start", source: jira, mode: "guided" });
  assert.deepEqual(parseCycleCommand("resume --autonomous"), { command: "resume", mode: "autonomous" });
  assert.deepEqual(parseCycleCommand("resume --mode=guided"), { command: "resume", mode: "guided" });
  assert.equal(parseCycleCommand("resume --mode autonomous --guided"), null);
  assert.equal(parseCycleCommand("start FNR-3036 --mode autonomous --guided"), null);
  assert.equal(parseCycleCommand("start FNR-3036 --mode invalid"), null);
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

test("parses multiline cycle replies literally while rejecting unsafe controls", () => {
  const answer = "1. Add Plane creation.\n\n2. Use explicit state and priority.\n3. Permit direct creation.";
  assert.deepEqual(parseCycleCommand(`reply ${answer}`), { command: "reply", answer });

  const windowsAnswer = "first line\r\nsecond line";
  assert.deepEqual(parseCycleCommand(`/ima:cycle reply ${windowsAnswer}`), { command: "reply", answer: windowsAnswer });

  assert.equal(parseCycleCommand("reply first\tsecond"), null);
  assert.equal(parseCycleCommand("reply first\u0000second"), null);
  assert.equal(parseCycleCommand(`reply ${"x".repeat(8_193)}`), null);
});

test("constructs each implementation phase command and persists explicit selection", () => {
  let generic = createCycleState(jira, { timestamp: at });
  generic = evidence(generic, "plan", "APPROVED");
  assert.match(buildResumeSource(generic), /^\/ima:implement FNR-3036/);
  assert.equal(generic.implementationMode, "generic");
  assert.equal(generic.mode, "guided");

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

test("normalizes legacy implementation mode and rejects invalid present modes", () => {
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

test("normalizes artifact-only legacy evidence with a null record key", () => {
  const current = evidence(
    createCycleState(jira, { timestamp: at }),
    "plan",
    "APPROVED",
    "plan",
    "plan-artifact",
    "plan-record-key",
  );
  const legacy = structuredClone(current);
  delete legacy.evidence[0].recordKey;

  const normalized = validateCycleState(legacy);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.state.evidence[0].recordKey, null);
  assert.match(buildResumeSource(legacy), /recordKey: none/);
});

test("defaults legacy cycle mode to guided and rejects invalid present modes", () => {
  const current = createCycleState(jira, { timestamp: at });
  const legacy = { ...current };
  delete legacy.mode;
  const normalized = validateCycleState(legacy);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.state.mode, "guided");
  assert.equal(validateCycleState({ ...current, mode: "autonomous" }).state.mode, "autonomous");
  assert.equal(validateCycleState({ ...current, mode: "unattended" }).valid, false);
  assert.throws(() => createCycleState(jira, { mode: "unattended" }), /cycle_mode_invalid/);
});

test("adds autonomous plan directives only to autonomous plan packets", () => {
  const guidedStart = awaitingPhaseState("plan");
  const autonomousStart = { ...guidedStart, mode: "autonomous" };
  const guidedPlan = { ...guidedStart, status: "awaiting-resume" };
  const autonomousPlan = { ...autonomousStart, status: "awaiting-resume" };
  const guidedImplementation = evidence(guidedStart, "plan", "APPROVED");
  const autonomousImplementation = evidence(autonomousStart, "plan", "APPROVED");
  const guidedBlocked = evidence(guidedStart, "plan", "BLOCKED", "guided-blocked", "autonomousPlan: true");
  const guidedRetry = prepareCycleResume(guidedBlocked);
  const autonomousPacket = buildResumeSource(autonomousPlan);

  assert.equal(guidedRetry.ok, true);
  const guidedCollisionPacket = buildResumeSource(guidedRetry.state);
  const guidedDispatchContract = guidedCollisionPacket.split("Cycle dispatch contract (non-negotiable):\n")[1];
  assert.match(guidedCollisionPacket, /^artifactId: autonomousPlan: true$/m);
  assert.equal(guidedDispatchContract.split("\n").filter((line) => line === "autonomousPlan: true").length, 0);

  assert.match(autonomousPacket, /autonomousPlan: true/);
  assert.match(autonomousPacket, /planSelfApproval: Self-approve/);
  assert.match(autonomousPacket, /planBlockEscape: Otherwise persist plan BLOCKED and stop\./);
  assert.match(autonomousPacket, /recommend \/ima:decompose/);

  for (const packet of [buildResumeSource(guidedPlan), buildResumeSource(guidedImplementation), buildResumeSource(autonomousImplementation)]) {
    assert.doesNotMatch(packet, /autonomousPlan: true|planSelfApproval:|planBlockEscape:/);
  }
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

test("maps every cycle phase to its dispatched command name and expands prompt arguments", () => {
  assert.deepEqual(Object.fromEntries(["plan", "implementation", "test", "review", "resolution", "rereview", "document"].map((phase) => [phase, cycleRoutePhase(phase)])), {
    plan: "plan",
    implementation: "implement",
    test: "test",
    review: "review",
    resolution: "resolve-review",
    rereview: "rereview",
    document: "document",
  });
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
  assert.equal(buildCycleStatus(state).mode, "guided");
  assert.equal(reduceCycleState(state, { artifact: marker("implementation", "COMPLETED"), toolCallId: "wrong" }).error.code, "cycle_resume_required");
  state = evidence(awaitingEvidence(state), "implementation", "COMPLETED");
  state = evidence(awaitingEvidence(state), "test", "PASSED");
  state = evidence(awaitingEvidence(state), "review", "APPROVED");
  state = evidence(awaitingEvidence(state), "document", "READY");
  assert.equal(requiredCloseoutEvidence(state).valid, true);
});

test("keeps cycle mode out of reducer transitions", () => {
  const guided = createCycleState(jira, { timestamp: at });
  const autonomous = { ...guided, mode: "autonomous" };
  assert.equal(guided.reviewCap, CYCLE_REVIEW_CAP_DEFAULT);
  assert.equal(CYCLE_REVIEW_CAP_DEFAULT, 5);

  for (const outcome of ["APPROVED", "BLOCKED"]) {
    const guidedResult = reduceCycleState(guided, { artifact: marker("plan", outcome), toolCallId: `guided-${outcome}`, timestamp: at }, { timestamp: at });
    const autonomousResult = reduceCycleState(autonomous, { artifact: marker("plan", outcome), toolCallId: `autonomous-${outcome}`, timestamp: at }, { timestamp: at });
    assert.equal(guidedResult.ok, true);
    assert.equal(autonomousResult.ok, true);
    assert.deepEqual(
      [guidedResult.state.phase, guidedResult.state.status, guidedResult.state.reviewAttempts, guidedResult.state.blockers],
      [autonomousResult.state.phase, autonomousResult.state.status, autonomousResult.state.reviewAttempts, autonomousResult.state.blockers],
    );
    assert.equal(guidedResult.state.mode, "guided");
    assert.equal(autonomousResult.state.mode, "autonomous");
  }
});

test("prepares stopped and recoverable phase blocks for explicit resume", () => {
  const resumable = implementationAwaitingResumeState();
  assert.equal(prepareCycleResume(resumable).state.status, "awaiting-resume");

  const stopped = prepareCycleResume({ ...resumable, status: "stopped", stoppedAt: at, stoppedPhase: resumable.phase });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.status, "awaiting-resume");
  assert.equal(stopped.state.stoppedAt, undefined);
  assert.equal(stopped.state.stoppedPhase, undefined);

  let blocked = createCycleState(jira, { timestamp: at });
  blocked = evidence(blocked, "plan", "APPROVED");
  blocked = evidence(awaitingEvidence(blocked), "implementation", "COMPLETED");
  blocked = evidence(awaitingEvidence(blocked), "test", "PASSED");
  blocked = evidence(awaitingEvidence(blocked), "review", "BLOCKED");
  const snapshot = structuredClone(blocked);
  const retry = prepareCycleResume(blocked);
  assert.equal(retry.ok, true);
  assert.equal(retry.state.status, "awaiting-resume");
  assert.deepEqual(retry.state.blockers, []);
  assert.equal(retry.state.evidence.at(-1).outcome, "BLOCKED");
  assert.deepEqual(blocked, snapshot);

  const blockedAgain = evidence(awaitingEvidence(retry.state), "review", "BLOCKED", "review-blocked-again");
  assert.equal(blockedAgain.status, "blocked");
  assert.equal(blockedAgain.evidence.filter((item) => item.phase === "review" && item.outcome === "BLOCKED").length, 2);
  assert.equal(prepareCycleResume(blockedAgain).ok, true);

  let capped = createCycleState(jira, { timestamp: at, reviewCap: 0 });
  capped = evidence(capped, "plan", "APPROVED");
  capped = evidence(awaitingEvidence(capped), "implementation", "COMPLETED");
  capped = evidence(awaitingEvidence(capped), "test", "PASSED");
  capped = evidence(awaitingEvidence(capped), "review", "REQUEST_CHANGES");
  assert.deepEqual(capped.blockers, ["review_cap_exceeded"]);
  assert.equal(prepareCycleResume(capped).error.code, "cycle_resume_unavailable");

  let defects = createCycleState(jira, { timestamp: at });
  defects = evidence(defects, "plan", "APPROVED");
  defects = evidence(awaitingEvidence(defects), "implementation", "COMPLETED");
  defects = evidence(awaitingEvidence(defects), "test", "DEFECTS");
  assert.deepEqual(defects.blockers, ["test:DEFECTS"]);
  assert.equal(prepareCycleResume(defects).error.code, "cycle_resume_unavailable");
  assert.equal(prepareCycleResume({ ...blocked, status: "blocked-after-tracker-close", blockers: [] }).error.code, "cycle_resume_unavailable");
});

test("renders ordered sanitized evidence with both lifecycle references", () => {
  let state = createCycleState(jira, { timestamp: at });
  state = evidence(state, "plan", "APPROVED", "plan", null, "plan-record-key");
  state = evidence(
    awaitingEvidence(state),
    "implementation",
    "COMPLETED",
    "implementation",
    "implementation-artifact",
    "implementation-record-key",
  );
  const packet = buildResumeSource(state);
  const lines = packet.split("\n");
  assert.deepEqual(lines.slice(0, 15), [
    "/ima:test FNR-3036",
    "Lifecycle evidence packet:",
    `project: ${IMA_PROJECT}`,
    "lifecycleKey: ima-pi:jira:FNR-3036",
    "sourceType: jira",
    "source: FNR-3036",
    "jiraKey: FNR-3036",
    "taskwarriorProject: none",
    "taskwarriorUuid: none",
    "planeWorkspace: none",
    "planeWorkItem: none",
    "reviewCap: 5",
    "implementationMode: generic",
    "orderedPhaseEvidence:",
    "phase: plan",
  ]);
  assert.match(packet, /phase: plan\noutcome: APPROVED\ntimestamp: 2026-08-04T18:00:00.000Z\nartifactId: none\nrecordKey: plan-record-key\ntoolCallId: plan/);
  assert.match(packet, /phase: implementation\noutcome: COMPLETED\ntimestamp: 2026-08-04T18:00:00.000Z\nartifactId: implementation-artifact\nrecordKey: implementation-record-key\ntoolCallId: implementation/);
  assert.match(packet, /priorArtifactIds: implementation-artifact/);
  assert.match(packet, /priorArtifactRecordKeys: plan-record-key, implementation-record-key/);
  assert.deepEqual(buildCycleStatus(state).evidence[1], {
    phase: "implementation",
    outcome: "COMPLETED",
    artifactId: "implementation-artifact",
    recordKey: "implementation-record-key",
    timestamp: at,
  });
  assert.match(buildFinalCloseoutArtifact(state), /artifactId: implementation-artifact; recordKey: implementation-record-key/);
  assert.ok(packet.indexOf("phase: plan") < packet.indexOf("phase: implementation"));
  assert.ok(packet.indexOf("orderedPhaseEvidence:") < packet.indexOf("priorArtifactIds:"));
  assert.ok(packet.indexOf("priorArtifactIds:") < packet.indexOf("priorArtifactRecordKeys:"));
  assert.ok(packet.indexOf("priorArtifactRecordKeys:") < packet.indexOf("Cycle dispatch contract"));
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
    result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, artifactId: "plan-id", recordKey: "plan-record-key", receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
    timestamp: at,
  });
  assert.equal(result.matched, true);
  assert.equal(result.state.evidence[0].artifactId, "plan-id");
  assert.equal(result.state.evidence[0].recordKey, "plan-record-key");
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

test("rejects control-character record keys before state and handoffs", () => {
  const state = createCycleState(jira, { timestamp: at });
  const artifact = marker("plan", "APPROVED");
  const selection = {
    lifecycleKey: state.lifecycleKey,
    phase: "plan",
    jiraKey: state.source.key,
    taskwarriorUuid: "",
  };
  const malformedRecordKeys = [
    ["embedded NUL", "ima-pi:jira:FNR-3036:plan\u0000malformed"],
    ["DEL", "ima-pi:jira:FNR-3036:plan\u007fmalformed"],
    ["C1 U+0080", "ima-pi:jira:FNR-3036:plan\u0080malformed"],
    ["C1 U+0085", "ima-pi:jira:FNR-3036:plan\u0085malformed"],
    ["C1 U+009F", "ima-pi:jira:FNR-3036:plan\u009fmalformed"],
    ["trailing TAB", "ima-pi:jira:FNR-3036:plan\t"],
    ["leading LF", "\nima-pi:jira:FNR-3036:plan"],
    ["trailing CR", "ima-pi:jira:FNR-3036:plan\r"],
    ["control-only TAB", "\t"],
  ];

  for (const [label, malformedRecordKey] of malformedRecordKeys) {
    const reduced = reduceCycleState(state, {
      artifact,
      toolCallId: `${label}-reduce`,
      recordKey: malformedRecordKey,
      timestamp: at,
    }, { timestamp: at });
    assert.equal(reduced.ok, false, label);
    assert.equal(reduced.error.code, "phase_evidence_invalid", label);
    assert.deepEqual(reduced.state, state, label);

    const observed = observeLifecycleResult({
      state,
      toolName: "ima_lifecycle",
      toolCallId: `${label}-observe`,
      input: { type: "plan", identity, artifact },
      result: {
        details: {
          status: "completed",
          phase: "plan",
          lifecycleKey: state.lifecycleKey,
          artifactId: "plan-id",
          recordKey: malformedRecordKey,
          receiptAccepted: true,
          semanticRecall: { matched: true },
        },
        content: [],
        isError: false,
      },
      timestamp: at,
    });
    assert.equal(observed.matched, false, label);
    assert.equal(observed.error.code, "lifecycle_completion_unverified", label);
    assert.deepEqual(observed.state, state, label);

    const parsed = parseLifecycleSearchRecords({
      results: [persistedRecord(state, "plan", "APPROVED", {
        id: "control-persisted",
        recordKey: malformedRecordKey,
      })],
    }, selection);
    assert.equal(parsed.valid, true, label);
    assert.equal(parsed.records[0].recordKey, null, label);

    const reconciled = reconcileCycleFromLifecycle(state, parsed.records, { timestamp: at });
    assert.equal(reconciled.ok, true, label);
    assert.equal(reconciled.reconciled, true, label);
    assert.equal(reconciled.state.evidence[0].artifactId, "control-persisted", label);
    assert.equal(reconciled.state.evidence[0].recordKey, null, label);
    const packet = buildResumeSource(reconciled.state);
    const status = buildCycleStatus(reconciled.state);
    const closeout = buildFinalCloseoutArtifact(reconciled.state);
    assert.ok(packet, label);
    assert.match(packet, /recordKey: none/, label);
    for (const output of [JSON.stringify(observed), packet, JSON.stringify(status), closeout]) {
      assert.equal(output.includes(malformedRecordKey), false, label);
    }

    const unsafeState = {
      ...reconciled.state,
      evidence: reconciled.state.evidence.map((item) => ({
        ...item,
        recordKey: malformedRecordKey,
      })),
    };
    assert.equal(validateCycleState(unsafeState).valid, false, label);
    assert.equal(buildResumeSource(unsafeState), null, label);
  }
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
  assert.deepEqual(events, ["append", "tool-result", "agent-settled", "append"]);
  assert.equal(stateEntries.length, 2);
  assert.equal(stateEntries[0].status, "awaiting-evidence");
  assert.equal(result.state.phase, "implementation");
  assert.equal(result.state.status, "awaiting-resume");
  assert.equal(result.state.evidence.at(-1).phase, "plan");
  assert.deepEqual(stateEntries.at(-1), result.state);
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

test("starts an autonomous plan only after context, routing, and plan confirmation", async () => {
  const calls = [];
  const stateEntries = [];
  const result = await coordinateCycleStart({
    source: jira,
    reviewCap: 4,
    implementationMode: "wp",
    mode: "autonomous",
    cwd: "/repo",
    context: async (request, cwd) => { calls.push(["context", request, cwd]); return { status: "ready" }; },
    applyRoute: async (phase) => { calls.push(["route", phase]); return { ok: true }; },
    appendState: (state) => { calls.push(["append", state.status]); stateEntries.push(state); },
    expandPrompt: async (message) => { calls.push(["expand", message]); return "expanded prompt"; },
    sendUserMessage: async (message, provisionalState) => { calls.push(["send", message]); return confirmDispatch(provisionalState, "plan", "APPROVED", message); },
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["context", "route", "append", "expand", "send", "append"]);
  assert.match(calls.find(([kind]) => kind === "expand")[1], /autonomousPlan: true/);
  assert.match(calls.find(([kind]) => kind === "expand")[1], /planSelfApproval: Self-approve/);
  assert.equal(calls.find(([kind]) => kind === "send")[1], "expanded prompt");
  assert.equal(stateEntries[0].status, "awaiting-evidence");
  assert.deepEqual({ phase: stateEntries.at(-1).phase, status: stateEntries.at(-1).status }, { phase: "implementation", status: "awaiting-resume" });
  assert.equal(result.state.reviewCap, 4);
  assert.equal(result.state.implementationMode, "wp");
  assert.equal(result.state.mode, "autonomous");
});

test("stops autonomous plan starts on plan BLOCKED", async () => {
  const routed = [];
  const result = await coordinateCycleStart({
    source: jira,
    mode: "autonomous",
    cwd: "/repo",
    context: async () => ({ status: "ready" }),
    applyRoute: async (phase) => { routed.push(phase); return { ok: true }; },
    appendState: () => {},
    expandPrompt: async (message) => message,
    sendUserMessage: async (message, provisionalState) => {
      assert.match(message, /autonomousPlan: true/);
      return confirmDispatch(provisionalState, "plan", "BLOCKED", message);
    },
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(routed, ["plan"]);
  assert.deepEqual({ phase: result.state.phase, status: result.state.status }, { phase: "plan", status: "blocked" });
  assert.deepEqual(result.state.blockers, ["plan:BLOCKED"]);
});

test("persists a provisional state when prompt expansion fails", async () => {
  const stateEntries = [];
  const result = await coordinateCycleStart({
    source: jira,
    cwd: "/repo",
    context: async () => ({ status: "ready" }),
    applyRoute: async () => ({ ok: true }),
    appendState: (state) => stateEntries.push(state),
    expandPrompt: async () => { throw new Error("prompt unavailable"); },
    sendUserMessage: async () => { throw new Error("must not send"); },
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /state persisted/);
  assert.equal(stateEntries.length, 1);
  assert.equal(stateEntries[0].status, "awaiting-evidence");
});

test("returns the provisional state and preserves allow-listed phase startup diagnostics", async () => {
  const startEntries = [];
  const start = await coordinateCycleStart({
    source: jira,
    cwd: "/repo",
    context: async () => ({ status: "ready" }),
    applyRoute: async () => ({ ok: true }),
    appendState: (state) => startEntries.push(state),
    sendUserMessage: () => { throw new Error("synchronous send failure"); },
    timestamp: at,
  });
  assert.equal(start.ok, false);
  assert.equal(start.error.code, "cycle_phase_injection_failed");
  assert.deepEqual(start.state, startEntries[0]);

  const dispatchEntries = [];
  const dispatch = await dispatchCyclePhase({
    state: implementationAwaitingResumeState(),
    applyRoute: async () => ({ ok: true }),
    appendState: (state) => dispatchEntries.push(state),
    sendUserMessage: () => { throw new Error("synchronous send failure"); },
    timestamp: at,
  });
  assert.equal(dispatch.ok, false);
  assert.equal(dispatch.error.code, "cycle_phase_injection_failed");
  assert.deepEqual(dispatch.state, dispatchEntries[0]);

  const toolkitEntries = [];
  const missingToolkit = await coordinateCycleStart({
    source: jira,
    cwd: "/repo",
    context: async () => ({ status: "ready" }),
    applyRoute: async () => ({ ok: true }),
    appendState: (state) => toolkitEntries.push(state),
    sendUserMessage: () => { throw new Error("phase_toolkit_missing"); },
    timestamp: at,
  });
  assert.equal(missingToolkit.ok, false);
  assert.equal(missingToolkit.error.code, "phase_toolkit_missing");
  assert.deepEqual(missingToolkit.state, toolkitEntries[0]);
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
  assert.equal(stateEntries.length, 2);
  assert.equal(stateEntries[0].status, "awaiting-evidence");
  assert.deepEqual(stateEntries.at(-1), result.state);
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
  assert.equal(stateEntries.length, 1);
  assert.equal(stateEntries[0].status, "awaiting-evidence");
  assert.deepEqual(committed, committedSnapshot);
});

test("dispatches route before injection and requires acknowledgement for write-capable stop", async () => {
  const calls = [];
  let state = createCycleState(jira, { timestamp: at });
  state = evidence(state, "plan", "APPROVED");
  const dispatch = await dispatchCyclePhase({ state, applyRoute: async (phase) => { calls.push(["route", phase]); return { ok: true }; }, appendState: (next) => calls.push(["append", next.status]), expandPrompt: async (message) => { calls.push(["expand", message]); return "expanded prompt"; }, sendUserMessage: async (message, provisionalState) => { calls.push(["send", message]); return provisionalState; }, timestamp: at });
  assert.equal(dispatch.ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["route", "append", "expand", "send", "append"]);
  assert.equal(dispatch.state.status, "awaiting-evidence");
  assert.equal(dispatch.state.evidence.length, 1);
  const blocked = await coordinateCycleStop({ state: dispatch.state, acknowledge: false, appendState: () => calls.push(["stop-append"]), abort: () => calls.push(["abort"]), timestamp: at });
  assert.equal(blocked.error.code, "cycle_stop_ack_required");
  assert.equal(calls.some(([kind]) => kind === "abort"), false);
  const autonomousStopped = await coordinateCycleStop({ state: { ...dispatch.state, mode: "autonomous" }, acknowledge: false, appendState: () => calls.push(["autonomous-stop-append"]), abort: () => calls.push(["autonomous-abort"]), timestamp: at });
  assert.equal(autonomousStopped.ok, true);
  assert.equal(calls.some(([kind]) => kind === "autonomous-abort"), true);
  const stopped = await coordinateCycleStop({ state: dispatch.state, acknowledge: true, appendState: () => calls.push(["stop-append"]), abort: () => calls.push(["abort"]), timestamp: at });
  assert.equal(stopped.ok, true);
  assert.deepEqual(calls.slice(-2).map(([kind]) => kind), ["stop-append", "abort"]);
  const failedEntries = [];
  const failed = await dispatchCyclePhase({ state, applyRoute: async () => ({ ok: true }), appendState: (next) => failedEntries.push(next), sendUserMessage: async () => { throw new Error("send failed"); }, timestamp: at });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "cycle_phase_injection_failed");
  assert.equal(failedEntries.length, 1);
  assert.equal(failedEntries[0].status, "awaiting-evidence");
});

test("cancels dispatch and recovery effects after their current invocation is invalidated", async () => {
  const expansionStarted = deferred();
  const expansion = deferred();
  let current = true;
  const sends = [];
  const dispatch = dispatchCyclePhase({
    state: implementationAwaitingResumeState(),
    applyRoute: async () => ({ ok: true }),
    appendState: () => {},
    expandPrompt: async () => {
      expansionStarted.resolve();
      return expansion.promise;
    },
    sendUserMessage: async (message) => { sends.push(message); return implementationAwaitingResumeState(); },
    isCurrent: () => current,
  });
  await expansionStarted.promise;
  current = false;
  expansion.resolve("expanded prompt");
  const dispatched = await dispatch;
  assert.equal(dispatched.ok, false);
  if (!dispatched.ok) assert.equal(dispatched.error.code, "cycle_operation_cancelled");
  assert.deepEqual(sends, []);

  const recallStarted = deferred();
  const recall = deferred();
  current = true;
  const state = awaitingEvidence(implementationAwaitingResumeState());
  const appended = [];
  const recovery = coordinateCycleRecovery({
    state,
    recall: async () => {
      recallStarted.resolve();
      return recall.promise;
    },
    appendState: (next) => appended.push(next),
    isCurrent: () => current,
  });
  await recallStarted.promise;
  current = false;
  recall.resolve(vestigeSearch([persistedRecord(state, "implementation", "COMPLETED", { id: "late" })]));
  const recovered = await recovery;
  assert.equal(recovered.ok, false);
  if (!recovered.ok) assert.equal(recovered.error.code, "cycle_operation_cancelled");
  assert.deepEqual(recovered.state, state);
  assert.deepEqual(appended, []);
});

test("recovers adopted progress before dispatch and rejects conflicting retained settings", async () => {
  const contract = {
    artifact: marker("plan", "APPROVED"),
    artifactId: reviewUuid(960),
    recordKey: "ima-pi:jira:FNR-3036:plan:adopted",
    contentHash: "a".repeat(64),
    createdAt: at,
    detail: "# Plan",
    identity,
    outcome: "APPROVED",
    marker: buildCycleOutcomeMarker({ phase: "plan", outcome: "APPROVED" }),
    approvalReference: null,
  };
  let recoveredState = implementationAwaitingResumeState();
  recoveredState = evidence(awaitingEvidence(recoveredState), "implementation", "COMPLETED");
  const routed = [];
  const adopted = await coordinateCycleStart({
    source: jira,
    cwd: "/repo",
    context: async () => ({ status: "ready" }),
    adoptPlan: async () => ({ kind: "approved", approval: contract, contract }),
    recoverAdoptedState: async () => ({ ok: true, state: recoveredState }),
    applyRoute: async (phase) => { routed.push(phase); return { ok: true }; },
    appendState: () => {},
    persistAdoptionState: () => {},
    expandPrompt: async (value) => value,
    sendUserMessage: async (_message, provisional) => provisional,
  });
  assert.equal(adopted.ok, true);
  assert.deepEqual(routed, ["test"]);

  const resumable = { ...createCycleState(jira, { timestamp: at }), status: "awaiting-resume" };
  const existingStates = [
    resumable,
    { ...resumable, status: "stopped", stoppedAt: at, stoppedPhase: "plan" },
    { ...resumable, status: "blocked", blockers: ["plan:BLOCKED"] },
  ];
  for (const existing of existingStates) {
    for (const overrides of [
      { lifecycleKey: "ima-pi:jira:FNR-9999" },
      { reviewCap: existing.reviewCap + 1 },
      { implementationMode: "js" },
    ]) {
      const calls = [];
      const result = await coordinateCycleStart({
        source: jira,
        cwd: "/repo",
        activeState: existing,
        ...overrides,
        context: async () => { calls.push("context"); return { status: "ready" }; },
        adoptPlan: async () => { calls.push("adopt"); return { kind: "no-plan" }; },
        applyRoute: async () => { calls.push("route"); return { ok: true }; },
        appendState: () => calls.push("append"),
        sendUserMessage: async () => { calls.push("send"); return existing; },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "cycle_active_settings_conflict");
      assert.deepEqual(calls, []);
    }
  }
});

test("registered resume recovers bound work before dispatch and blocks unbound work", async () => {
  const initial = { ...createCycleState(jira, { timestamp: at }), status: "awaiting-resume" };
  const direct = directPlanRecord(initial, "APPROVED", { id: reviewUuid(970), recordKey: `${initial.lifecycleKey}:plan:resume` });
  const implementation = directDownstreamRecord(initial, "implementation", "COMPLETED", direct.id, {
    id: reviewUuid(971),
    recordKey: `${initial.lifecycleKey}:implementation:resume`,
  });
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  const routed = [];
  registerCycleExtension(harness.pi, cycleDependencies({
    recall: async (query) => {
      if (query.endsWith(" plan")) return vestigeSearch([direct]);
      if (query.endsWith(" implementation")) return vestigeSearch([implementation]);
      return vestigeSearch([]);
    },
    applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
  }));
  await harness.handlers.get("session_tree")({}, harness.ctx);
  const sent = harness.waitForSend();
  const resumed = harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  await sent;
  assert.deepEqual(routed, ["test"]);
  const provisional = harness.entries.at(-1).data;
  assert.deepEqual({ phase: provisional.phase, status: provisional.status }, { phase: "test", status: "awaiting-evidence" });
  const testResult = lifecycleToolResult(provisional, "test", "PASSED");
  testResult.input.identity.priorArtifactIds = [direct.id];
  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await harness.handlers.get("tool_result")(testResult, harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.handlers.get("agent_settled")();
  await resumed;
  assert.equal(harness.entries.at(-1).data.phase, "review");

  const unboundHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  const unbound = directDownstreamRecord(initial, "implementation", "COMPLETED", direct.id, {
    id: reviewUuid(972),
    recordKey: `${initial.lifecycleKey}:implementation:unbound`,
    priorArtifactIds: [],
  });
  const unboundRoutes = [];
  registerCycleExtension(unboundHarness.pi, cycleDependencies({
    recall: async (query) => query.endsWith(" plan")
      ? vestigeSearch([direct])
      : query.endsWith(" implementation")
        ? vestigeSearch([unbound])
        : vestigeSearch([]),
    applyRoute: async (_pi, _ctx, phase) => { unboundRoutes.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
  }));
  await unboundHarness.handlers.get("session_tree")({}, unboundHarness.ctx);
  await unboundHarness.commands.get("ima:cycle").handler("resume", unboundHarness.ctx);
  assert.deepEqual(unboundRoutes, []);
  assert.deepEqual(unboundHarness.messages, []);
  assert.ok(unboundHarness.notifications.some(({ level, message }) => level === "warning" && /plan_lineage_unbound/.test(message)));
});

test("cancels fresh starts before publication without replacing an older terminal cycle", async () => {
  const terminalStates = [
    { label: "closed", state: { ...createCycleState(jira, { timestamp: at }), status: "closed" } },
    {
      label: "post-close blocked",
      state: {
        ...createCycleState(jira, { timestamp: at }),
        status: "blocked-after-tracker-close",
        trackerClosed: true,
        blockers: ["lifecycle_closeout_failed"],
      },
    },
  ];
  for (const { label, state: terminal } of terminalStates) {
    for (const stopCommand of ["stop", "stop --ack"]) {
      const lookupStarted = deferred();
      const lookup = deferred();
      const durableStates = [];
      const routes = [];
      let contexts = 0;
      let approvalWrites = 0;
      const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: terminal }]);
      registerCycleExtension(harness.pi, cycleDependencies({
        context: async () => { contexts += 1; return { status: "ready" }; },
        recall: async () => {
          lookupStarted.resolve();
          return lookup.promise;
        },
        lifecycle: async () => { approvalWrites += 1; return {}; },
        persistDurableState: async (_cwd, next) => durableStates.push(next),
        applyRoute: async (_pi, _ctx, phase) => { routes.push(phase); return { ok: true }; },
        expandPrompt: async () => "expanded prompt",
      }));
      await harness.handlers.get("session_tree")({}, harness.ctx);
      const started = harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);
      await lookupStarted.promise;
      await harness.commands.get("ima:cycle").handler(stopCommand, harness.ctx);
      lookup.resolve(vestigeSearch([]));
      await started;
      assert.equal(contexts, 1, `${label} ${stopCommand}`);
      assert.equal(harness.wasAborted(), true, `${label} ${stopCommand}`);
      assert.equal(approvalWrites, 0, `${label} ${stopCommand}`);
      assert.deepEqual(routes, [], `${label} ${stopCommand}`);
      assert.deepEqual(harness.entries, [], `${label} ${stopCommand}`);
      assert.deepEqual(durableStates, [], `${label} ${stopCommand}`);
      assert.deepEqual(harness.messages, [], `${label} ${stopCommand}`);
      assert.match(harness.statuses.at(-1).value, new RegExp(`Cycle ${terminal.status}`), `${label} ${stopCommand}`);
    }
  }
});

test("keeps current resume recovery phases as stop authority", async () => {
  const plan = directPlanRecord(createCycleState(jira, { timestamp: at }), "APPROVED", {
    id: reviewUuid(990),
    recordKey: "ima-pi:jira:FNR-3036:plan:stop-authority",
  });
  const initial = importedImplementationState(plan);
  const planLookupStarted = deferred();
  const planLookup = deferred();
  const durableStates = [];
  const beforePublication = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  registerCycleExtension(beforePublication.pi, cycleDependencies({
    recall: async (query) => {
      if (query.endsWith(" plan")) {
        planLookupStarted.resolve();
        return planLookup.promise;
      }
      return vestigeSearch([]);
    },
    persistDurableState: async (_cwd, next) => durableStates.push(next),
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await beforePublication.handlers.get("session_tree")({}, beforePublication.ctx);
  const resumedBeforePublication = beforePublication.commands.get("ima:cycle").handler("resume", beforePublication.ctx);
  await planLookupStarted.promise;
  await beforePublication.commands.get("ima:cycle").handler("stop", beforePublication.ctx);
  assert.equal(beforePublication.wasAborted(), false);
  assert.ok(beforePublication.notifications.some(({ level, message }) => level === "warning" && /cycle_stop_ack_required/.test(message)));
  const stoppedBeforePublication = beforePublication.commands.get("ima:cycle").handler("stop --ack", beforePublication.ctx);
  planLookup.resolve(vestigeSearch([plan]));
  await Promise.all([resumedBeforePublication, stoppedBeforePublication]);
  const firstStopped = beforePublication.entries.at(-1).data;
  assert.deepEqual({ status: firstStopped.status, phase: firstStopped.phase, stoppedPhase: firstStopped.stoppedPhase }, {
    status: "stopped",
    phase: "implementation",
    stoppedPhase: "implementation",
  });
  assert.deepEqual(durableStates.at(-1), firstStopped);

  const implementation = directDownstreamRecord(initial, "implementation", "COMPLETED", plan.id, {
    id: reviewUuid(991),
    recordKey: "ima-pi:jira:FNR-3036:implementation:stop-authority",
  });
  const testLookupStarted = deferred();
  const testLookup = deferred();
  const afterPublication = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  registerCycleExtension(afterPublication.pi, cycleDependencies({
    recall: async (query) => {
      if (query.endsWith(" plan")) return vestigeSearch([plan]);
      if (query.endsWith(" implementation")) return vestigeSearch([implementation]);
      if (query.endsWith(" test")) {
        testLookupStarted.resolve();
        return testLookup.promise;
      }
      return vestigeSearch([]);
    },
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await afterPublication.handlers.get("session_tree")({}, afterPublication.ctx);
  const resumedAfterPublication = afterPublication.commands.get("ima:cycle").handler("resume", afterPublication.ctx);
  await testLookupStarted.promise;
  await afterPublication.commands.get("ima:cycle").handler("stop", afterPublication.ctx);
  assert.equal(afterPublication.wasAborted(), false);
  assert.ok(afterPublication.notifications.some(({ level, message }) => level === "warning" && /cycle_stop_ack_required/.test(message)));
  const stoppedAfterPublication = afterPublication.commands.get("ima:cycle").handler("stop --ack", afterPublication.ctx);
  testLookup.resolve(vestigeSearch([]));
  await Promise.all([resumedAfterPublication, stoppedAfterPublication]);
  const secondStopped = afterPublication.entries.at(-1).data;
  assert.deepEqual({ status: secondStopped.status, phase: secondStopped.phase, stoppedPhase: secondStopped.stoppedPhase }, {
    status: "stopped",
    phase: "test",
    stoppedPhase: "test",
  });
});

test("uses strict plan selection for every explicit awaiting-evidence resume", async () => {
  const initial = createCycleState(jira, { timestamp: at });
  const direct = directPlanRecord(initial, "APPROVED", {
    id: reviewUuid(992),
    recordKey: "ima-pi:jira:FNR-3036:plan:awaiting-evidence",
  });
  const accepted = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  const routed = [];
  registerCycleExtension(accepted.pi, cycleDependencies({
    recall: async (query) => query.endsWith(" plan") ? vestigeSearch([direct]) : vestigeSearch([]),
    applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
  }));
  await accepted.handlers.get("session_tree")({}, accepted.ctx);
  const sent = accepted.waitForSend();
  const resumed = accepted.commands.get("ima:cycle").handler("resume", accepted.ctx);
  await sent;
  assert.deepEqual(routed, ["implementation"]);
  assert.equal(accepted.entries.find(({ data }) => data.phase === "implementation" && data.status === "awaiting-resume")?.data.evidence.at(-1).approvedPlan.artifactId, direct.id);
  accepted.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  accepted.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  accepted.handlers.get("agent_start")();
  accepted.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  accepted.handlers.get("agent_settled")();
  await resumed;

  const tied = [
    directPlanRecord(initial, "APPROVED", { id: reviewUuid(993), recordKey: "ima-pi:jira:FNR-3036:plan:tie-a", createdAt: "2026-08-04T18:00:00Z" }),
    directPlanRecord(initial, "BLOCKED", { id: reviewUuid(994), recordKey: "ima-pi:jira:FNR-3036:plan:tie-b", createdAt: "2026-08-04T18:00:00.000Z" }),
  ];
  const saturated = Array.from({ length: 20 }, (_, index) => directPlanRecord(initial, "APPROVED", {
    id: reviewUuid(1000 + index),
    recordKey: `ima-pi:jira:FNR-3036:plan:saturated-${index}`,
  }));
  const cases = [
    [],
    [{ ...direct, project: "other" }],
    tied,
    saturated,
  ];
  for (const records of cases) {
    const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
    const queries = [];
    const caseRoutes = [];
    registerCycleExtension(harness.pi, cycleDependencies({
      recall: async (query) => {
        queries.push(query);
        return queries.length === 1
          ? vestigeSearch(records)
          : vestigeSearch([persistedRecord(initial, "plan", "APPROVED", { id: "generic-fallback" })]);
      },
      applyRoute: async (_pi, _ctx, phase) => { caseRoutes.push(phase); return { ok: true }; },
      expandPrompt: async () => "expanded prompt",
    }));
    await harness.handlers.get("session_tree")({}, harness.ctx);
    await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
    assert.deepEqual(caseRoutes, []);
    assert.deepEqual(harness.messages, []);
    assert.equal(queries.filter((query) => query.endsWith(" plan")).length, 1);
  }
});

test("does not reconcile around an active planning dispatch handshake", async () => {
  const initial = { ...createCycleState(jira, { timestamp: at }), status: "awaiting-resume" };
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  const routed = [];
  const queries = [];
  registerCycleExtension(harness.pi, cycleDependencies({
    recall: async (query) => { queries.push(query); return vestigeSearch([]); },
    applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
  }));
  await harness.handlers.get("session_tree")({}, harness.ctx);
  const sent = harness.waitForSend();
  const firstResume = harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  await sent;
  const entriesBefore = harness.entries.length;
  await harness.commands.get("ima:cycle").handler("status", harness.ctx);
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  assert.equal(harness.wasAborted(), false);
  assert.equal(harness.entries.length, entriesBefore);
  assert.deepEqual(routed, ["plan"]);
  assert.equal(queries.filter((query) => query.endsWith(" plan")).length, 1);
  assert.ok(harness.notifications.some(({ level, message }) => level === "warning" && /cycle_resume_unavailable/.test(message)));
  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.handlers.get("agent_settled")();
  await firstResume;
});

test("retains the last imported publication after recovery failure", async () => {
  const initial = { ...createCycleState(jira, { timestamp: at }), status: "awaiting-resume" };
  const direct = directPlanRecord(initial, "APPROVED", {
    id: reviewUuid(1020),
    recordKey: "ima-pi:jira:FNR-3036:plan:failure-state",
  });
  const unboundImplementation = directDownstreamRecord(initial, "implementation", "COMPLETED", direct.id, {
    id: reviewUuid(1021),
    recordKey: "ima-pi:jira:FNR-3036:implementation:unbound-state",
    priorArtifactIds: [],
  });
  const immediate = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  const immediateDurable = [];
  const immediateRoutes = [];
  registerCycleExtension(immediate.pi, cycleDependencies({
    recall: async (query) => query.endsWith(" plan")
      ? vestigeSearch([direct])
      : query.endsWith(" implementation")
        ? vestigeSearch([unboundImplementation])
        : vestigeSearch([]),
    persistDurableState: async (_cwd, next) => immediateDurable.push(next),
    applyRoute: async (_pi, _ctx, phase) => { immediateRoutes.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
  }));
  await immediate.handlers.get("session_tree")({}, immediate.ctx);
  await immediate.commands.get("ima:cycle").handler("resume", immediate.ctx);
  assert.deepEqual(immediateRoutes, []);
  const imported = immediate.entries.at(-1).data;
  assert.deepEqual({ phase: imported.phase, status: imported.status }, { phase: "implementation", status: "awaiting-resume" });
  assert.equal(imported.evidence.at(-1).approvedPlan.artifactId, direct.id);
  assert.deepEqual(immediateDurable.at(-1), imported);
  assert.match(immediate.statuses.at(-1).value, /phase implementation/);

  const boundImplementation = directDownstreamRecord(initial, "implementation", "COMPLETED", direct.id, {
    id: reviewUuid(1022),
    recordKey: "ima-pi:jira:FNR-3036:implementation:bound-state",
  });
  const unboundTest = directDownstreamRecord(initial, "test", "PASSED", direct.id, {
    id: reviewUuid(1023),
    recordKey: "ima-pi:jira:FNR-3036:test:unbound-state",
    priorArtifactIds: [],
  });
  const partial = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  const partialDurable = [];
  registerCycleExtension(partial.pi, cycleDependencies({
    recall: async (query) => query.endsWith(" plan")
      ? vestigeSearch([direct])
      : query.endsWith(" implementation")
        ? vestigeSearch([boundImplementation])
        : query.endsWith(" test")
          ? vestigeSearch([unboundTest])
          : vestigeSearch([]),
    persistDurableState: async (_cwd, next) => partialDurable.push(next),
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await partial.handlers.get("session_tree")({}, partial.ctx);
  await partial.commands.get("ima:cycle").handler("resume", partial.ctx);
  const recovered = partial.entries.at(-1).data;
  assert.deepEqual({ phase: recovered.phase, status: recovered.status }, { phase: "test", status: "awaiting-resume" });
  assert.deepEqual(partialDurable.at(-1), recovered);
  assert.match(partial.statuses.at(-1).value, /phase test/);
  await partial.commands.get("ima:cycle").handler("start FNR-3036", partial.ctx);
  assert.ok(partial.notifications.some(({ level, message }) => level === "warning" && /cycle_active_replacement_blocked/.test(message)));
});

test("cancels pending adoption on stop and requires acknowledgement for its persisted implementation phase", async () => {
  const legacyState = { ...createCycleState(jira, { timestamp: at }), status: "awaiting-resume" };
  const legacy = directPlanRecord(legacyState, "APPROVED", {
    id: reviewUuid(973),
    recordKey: `${legacyState.lifecycleKey}:plan:legacy-stop`,
    artifact: "# Legacy Plan",
  });
  const editorStarted = deferred();
  const editor = deferred();
  let approvalWrites = 0;
  const legacyHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: legacyState }]);
  legacyHarness.ctx.ui.editor = async () => {
    editorStarted.resolve();
    return editor.promise;
  };
  registerCycleExtension(legacyHarness.pi, cycleDependencies({
    recall: async () => vestigeSearch([legacy]),
    lifecycle: async () => { approvalWrites += 1; return {}; },
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await legacyHarness.handlers.get("session_tree")({}, legacyHarness.ctx);
  const pendingResume = legacyHarness.commands.get("ima:cycle").handler("resume", legacyHarness.ctx);
  await editorStarted.promise;
  await legacyHarness.commands.get("ima:cycle").handler("stop", legacyHarness.ctx);
  editor.resolve(legacy.content);
  await pendingResume;
  assert.equal(legacyHarness.wasAborted(), true);
  assert.equal(approvalWrites, 0);
  assert.deepEqual(legacyHarness.messages, []);

  const directState = { ...createCycleState(jira, { timestamp: at }), status: "awaiting-resume" };
  const direct = directPlanRecord(directState, "APPROVED", { id: reviewUuid(974), recordKey: `${directState.lifecycleKey}:plan:guided-stop` });
  const guidedHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: directState }]);
  registerCycleExtension(guidedHarness.pi, cycleDependencies({
    recall: async (query) => query.endsWith(" plan") ? vestigeSearch([direct]) : vestigeSearch([]),
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await guidedHarness.handlers.get("session_tree")({}, guidedHarness.ctx);
  const sent = guidedHarness.waitForSend();
  const guidedResume = guidedHarness.commands.get("ima:cycle").handler("resume", guidedHarness.ctx);
  await sent;
  await guidedHarness.commands.get("ima:cycle").handler("stop", guidedHarness.ctx);
  assert.equal(guidedHarness.wasAborted(), false);
  assert.ok(guidedHarness.notifications.some(({ level, message }) => level === "warning" && /cycle_stop_ack_required/.test(message)));
  await guidedHarness.commands.get("ima:cycle").handler("stop --ack", guidedHarness.ctx);
  await guidedResume;
  assert.equal(guidedHarness.wasAborted(), true);
  const stopped = guidedHarness.entries.at(-1).data;
  assert.deepEqual({ status: stopped.status, phase: stopped.phase, stoppedPhase: stopped.stoppedPhase }, {
    status: "stopped",
    phase: "implementation",
    stoppedPhase: "implementation",
  });
});

test("serializes stale adoption publication behind a newer stopped snapshot", async () => {
  const initial = { ...createCycleState(jira, { timestamp: at }), status: "awaiting-resume" };
  const direct = directPlanRecord(initial, "APPROVED", { id: reviewUuid(977), recordKey: `${initial.lifecycleKey}:plan:publication` });
  const dispatchWriteStarted = deferred();
  const releaseDispatchWrite = deferred();
  let writes = 0;
  let durable = null;
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  registerCycleExtension(harness.pi, cycleDependencies({
    recall: async (query) => query.endsWith(" plan") ? vestigeSearch([direct]) : vestigeSearch([]),
    persistDurableState: async (_cwd, next) => {
      writes += 1;
      if (writes === 2) {
        dispatchWriteStarted.resolve();
        await releaseDispatchWrite.promise;
      }
      durable = next;
    },
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await harness.handlers.get("session_tree")({}, harness.ctx);
  const resumed = harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  await dispatchWriteStarted.promise;
  const stopped = harness.commands.get("ima:cycle").handler("stop --ack", harness.ctx);
  releaseDispatchWrite.resolve();
  await Promise.all([resumed, stopped]);
  assert.equal(harness.messages.length, 0);
  assert.deepEqual({ status: durable.status, phase: durable.phase, stoppedPhase: durable.stoppedPhase }, {
    status: "stopped",
    phase: "implementation",
    stoppedPhase: "implementation",
  });
  assert.deepEqual(harness.entries.at(-1).data, durable);
});

test("invalidates adoption across session replacement and idle planning recovery", async () => {
  const initial = { ...createCycleState(jira, { timestamp: at }), status: "awaiting-resume" };
  const legacy = directPlanRecord(initial, "APPROVED", {
    id: reviewUuid(975),
    recordKey: `${initial.lifecycleKey}:plan:session-legacy`,
    artifact: "# Legacy Plan",
  });
  const editorStarted = deferred();
  const editor = deferred();
  let lifecycleCalls = 0;
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  harness.ctx.ui.editor = async () => {
    editorStarted.resolve();
    return editor.promise;
  };
  registerCycleExtension(harness.pi, cycleDependencies({
    recall: async () => vestigeSearch([legacy]),
    lifecycle: async () => { lifecycleCalls += 1; return {}; },
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await harness.handlers.get("session_tree")({}, harness.ctx);
  const resumed = harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  await editorStarted.promise;
  await harness.handlers.get("session_tree")({}, harness.ctx);
  editor.resolve(legacy.content);
  await resumed;
  assert.equal(lifecycleCalls, 0);
  assert.deepEqual(harness.messages, []);

  const shutdownStarted = deferred();
  const shutdownEditor = deferred();
  const shutdownHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: initial }]);
  shutdownHarness.ctx.ui.editor = async () => {
    shutdownStarted.resolve();
    return shutdownEditor.promise;
  };
  registerCycleExtension(shutdownHarness.pi, cycleDependencies({
    recall: async () => vestigeSearch([legacy]),
    lifecycle: async () => { lifecycleCalls += 1; return {}; },
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await shutdownHarness.handlers.get("session_tree")({}, shutdownHarness.ctx);
  const shutdownResume = shutdownHarness.commands.get("ima:cycle").handler("resume", shutdownHarness.ctx);
  await shutdownStarted.promise;
  await shutdownHarness.handlers.get("session_shutdown")({}, shutdownHarness.ctx);
  shutdownEditor.resolve(legacy.content);
  await shutdownResume;
  assert.equal(lifecycleCalls, 0);
  assert.deepEqual(shutdownHarness.messages, []);

  const idle = createCycleState(jira, { timestamp: at });
  const approved = directPlanRecord(idle, "APPROVED", { id: reviewUuid(976), recordKey: `${idle.lifecycleKey}:plan:idle` });
  const idleHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: idle }]);
  registerCycleExtension(idleHarness.pi, cycleDependencies({
    recall: async (query) => query.endsWith(" plan") ? vestigeSearch([approved]) : vestigeSearch([]),
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await idleHarness.handlers.get("session_start")({}, idleHarness.ctx);
  const adopted = idleHarness.entries.at(-1).data;
  assert.deepEqual({ phase: adopted.phase, status: adopted.status }, { phase: "implementation", status: "awaiting-resume" });
  assert.equal(adopted.evidence.at(-1).approvedPlan.artifactId, approved.id);
  assert.deepEqual(idleHarness.messages, []);

  const saturated = Array.from({ length: 20 }, (_, index) => directDownstreamRecord(idle, "implementation", "COMPLETED", approved.id, {
    id: reviewUuid(980 + index),
    recordKey: `${idle.lifecycleKey}:implementation:saturated-${index}`,
  }));
  const saturatedHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: idle }]);
  registerCycleExtension(saturatedHarness.pi, cycleDependencies({
    recall: async (query) => query.endsWith(" plan")
      ? vestigeSearch([approved])
      : query.endsWith(" implementation")
        ? vestigeSearch(saturated)
        : vestigeSearch([]),
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await saturatedHarness.handlers.get("session_start")({}, saturatedHarness.ctx);
  assert.deepEqual(saturatedHarness.messages, []);
  assert.equal(saturatedHarness.entries.at(-1).data.phase, "implementation");
  assert.ok(saturatedHarness.notifications.some(({ level, message }) => level === "warning" && /plan_lineage_recall_invalid/.test(message)));
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

test("default cycle wiring persists provisional and settled lifecycle state", async () => {
  const committed = implementationAwaitingResumeState();
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: committed }]);
  const routedPhases = [];
  const expandedPrompts = [];
  const durableStates = [];
  registerCycleExtension(harness.pi, cycleDependencies({
    applyRoute: async (_pi, _ctx, phase) => { routedPhases.push(phase); return { ok: true }; },
    expandPrompt: async (value, cwd) => { expandedPrompts.push([value, cwd]); return "expanded prompt"; },
    persistDurableState: async (_cwd, state) => durableStates.push(state),
  }));

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
  assert.equal(harness.entries.length, 1);
  assert.equal(durableStates.length, 1);
  assert.equal(harness.entries[0].data.status, "awaiting-evidence");

  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await harness.handlers.get("tool_result")(lifecycleToolResult(awaitingEvidence(committed), "implementation", "COMPLETED"), harness.ctx);
  assert.equal(commandSettled, false);
  assert.equal(harness.entries.length, 1);

  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.handlers.get("agent_settled")();
  await commandPromise;

  assert.equal(harness.entries.length, 2);
  assert.equal(durableStates.length, 2);
  assert.equal(harness.entries.at(-1).customType, "ima-cycle-state");
  assert.equal(harness.entries.at(-1).data.phase, "test");
  assert.equal(harness.entries.at(-1).data.status, "awaiting-resume");
  assert.equal(harness.entries.at(-1).data.evidence.at(-1).phase, "implementation");
  assert.equal(harness.entries.at(-1).data.evidence.at(-1).outcome, "COMPLETED");
  assert.equal(harness.entries.at(-1).data.evidence.at(-1).toolCallId, "implementation-tool");
});

test("autonomously chains verified phases and leaves close human-gated", async () => {
  const state = implementationAwaitingResumeState();
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: state }]);
  const routed = [];
  const durableStates = [];
  registerCycleExtension(harness.pi, cycleDependencies({
    applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
    persistDurableState: async (_cwd, next) => durableStates.push(next),
  }));
  await harness.handlers.get("session_start")({}, harness.ctx);

  const command = harness.commands.get("ima:cycle");
  const initialSend = harness.waitForSend();
  const run = command.handler("resume --autonomous", harness.ctx);
  await initialSend;
  await settleHarnessDispatch(harness, "implementation", "COMPLETED", true);
  await settleHarnessDispatch(harness, "test", "PASSED", true);
  await settleHarnessDispatch(harness, "review", "APPROVED", true);
  await settleHarnessDispatch(harness, "document", "READY");
  await run;

  const final = harness.entries.at(-1).data;
  assert.deepEqual(routed, ["implementation", "test", "review", "document"]);
  assert.equal(harness.messages.length, 4);
  assert.equal(final.mode, "autonomous");
  assert.equal(final.phase, "document");
  assert.equal(final.status, "closeout-ready");
  assert.equal(harness.wasAborted(), false);
  assert.ok(durableStates.every((next) => next.mode === "autonomous"));
});

test("autonomous tail stops for blockers, defects, and review-cap excess", async () => {
  const testAwaitingResume = () => evidence(awaitingEvidence(implementationAwaitingResumeState()), "implementation", "COMPLETED");
  const reviewAwaitingResume = () => evidence(awaitingEvidence(testAwaitingResume()), "test", "PASSED");
  const cases = [
    { state: { ...implementationAwaitingResumeState(), mode: "autonomous" }, phase: "implementation", outcome: "BLOCKED", blocker: "implementation:BLOCKED" },
    { state: { ...testAwaitingResume(), mode: "autonomous" }, phase: "test", outcome: "DEFECTS", blocker: "test:DEFECTS" },
    { state: { ...reviewAwaitingResume(), mode: "autonomous", reviewCap: 0 }, phase: "review", outcome: "REQUEST_CHANGES", blocker: "review_cap_exceeded" },
  ];

  for (const { state, phase, outcome, blocker } of cases) {
    const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: state }]);
    const routed = [];
    registerCycleExtension(harness.pi, cycleDependencies({
      applyRoute: async (_pi, _ctx, routedPhase) => { routed.push(routedPhase); return { ok: true }; },
      expandPrompt: async () => "expanded prompt",
    }));
    await harness.handlers.get("session_start")({}, harness.ctx);

    const sent = harness.waitForSend();
    const run = harness.commands.get("ima:cycle").handler("resume", harness.ctx);
    await sent;
    await settleHarnessDispatch(harness, phase, outcome);
    await run;

    const final = harness.entries.at(-1).data;
    assert.deepEqual(routed, [phase]);
    assert.equal(harness.messages.length, 1);
    assert.equal(final.status, "blocked");
    assert.deepEqual(final.blockers, [blocker]);
    assert.ok(harness.notifications.some(({ level, message }) => level === "warning" && /Autonomous cycle stopped/.test(message)));
  }
});

test("autonomous stop during first resume dispatch preserves stopped state", async () => {
  const state = implementationAwaitingResumeState();
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: state }]);
  const routed = [];
  const durableStates = [];
  registerCycleExtension(harness.pi, cycleDependencies({
    applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
    persistDurableState: async (_cwd, next) => durableStates.push(next),
  }));
  await harness.handlers.get("session_start")({}, harness.ctx);

  const command = harness.commands.get("ima:cycle");
  const initialSend = harness.waitForSend();
  const run = command.handler("resume --autonomous", harness.ctx);
  await initialSend;
  const provisional = harness.entries.at(-1).data;
  assert.equal(provisional.phase, "implementation");
  assert.equal(provisional.status, "awaiting-evidence");

  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await harness.handlers.get("tool_result")(lifecycleToolResult(provisional, "implementation", "COMPLETED"), harness.ctx);
  await command.handler("stop", harness.ctx);
  const entryCountAtStop = harness.entries.length;
  const durableCountAtStop = durableStates.length;

  assert.equal(harness.wasAborted(), true);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.handlers.get("agent_settled")();
  await run;

  const final = harness.entries.at(-1).data;
  const durable = durableStates.at(-1);
  assert.deepEqual(routed, ["implementation"]);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.entries.length, entryCountAtStop);
  assert.equal(durableStates.length, durableCountAtStop);
  assert.equal(final.status, "stopped");
  assert.equal(final.phase, "implementation");
  assert.equal(final.stoppedPhase, "implementation");
  assert.equal(durable.status, "stopped");
  assert.equal(durable.phase, "implementation");
  assert.equal(durable.stoppedPhase, "implementation");
  assert.match(harness.statuses.at(-1).value, /^Cycle stopped: .*phase implementation; mode autonomous;/);
});

test("autonomous stop aborts the tail without clobbering stopped state", async () => {
  const state = implementationAwaitingResumeState();
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: state }]);
  const routed = [];
  registerCycleExtension(harness.pi, cycleDependencies({
    applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
  }));
  await harness.handlers.get("session_start")({}, harness.ctx);

  const command = harness.commands.get("ima:cycle");
  const initialSend = harness.waitForSend();
  const run = command.handler("resume --autonomous", harness.ctx);
  await initialSend;
  await settleHarnessDispatch(harness, "implementation", "COMPLETED", true);

  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await command.handler("stop", harness.ctx);
  assert.equal(harness.wasAborted(), true);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "aborted" }] });
  harness.handlers.get("agent_settled")();
  await run;

  const final = harness.entries.at(-1).data;
  assert.deepEqual(routed, ["implementation", "test"]);
  assert.equal(final.mode, "autonomous");
  assert.equal(final.status, "stopped");
  assert.equal(final.stoppedPhase, "test");
});

test("default cycle wiring retries a recoverable blocked phase", async () => {
  let blocked = createCycleState(jira, { timestamp: at });
  blocked = evidence(blocked, "plan", "APPROVED");
  blocked = evidence(awaitingEvidence(blocked), "implementation", "COMPLETED");
  blocked = evidence(awaitingEvidence(blocked), "test", "PASSED");
  blocked = evidence(awaitingEvidence(blocked), "review", "BLOCKED");
  const recovered = prepareCycleResume(blocked);
  assert.equal(recovered.ok, true);

  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: blocked }]);
  const routedPhases = [];
  const expandedPrompts = [];
  registerCycleExtension(harness.pi, cycleDependencies({
    applyRoute: async (_pi, _ctx, phase) => { routedPhases.push(phase); return { ok: true }; },
    expandPrompt: async (value) => { expandedPrompts.push(value); return "expanded prompt"; },
  }));
  await harness.handlers.get("session_start")({}, harness.ctx);

  const command = harness.commands.get("ima:cycle");
  const sendCalled = harness.waitForSend();
  const commandPromise = command.handler("resume", harness.ctx);
  await sendCalled;
  assert.deepEqual(routedPhases, ["review"]);
  assert.deepEqual(expandedPrompts, [buildResumeSource(recovered.state)]);

  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await harness.handlers.get("tool_result")(lifecycleToolResult(awaitingEvidence(recovered.state), "review", "REQUEST_CHANGES", "review-retry-tool"), harness.ctx);
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.handlers.get("agent_settled")();
  await commandPromise;

  assert.equal(harness.entries.length, 2);
  assert.equal(harness.entries.at(-1).data.phase, "resolution");
  assert.equal(harness.entries.at(-1).data.status, "awaiting-resume");
  assert.equal(harness.entries.at(-1).data.reviewAttempts, 1);
  assert.equal(harness.entries.at(-1).data.evidence.at(-1).outcome, "REQUEST_CHANGES");
});

test("default cycle wiring retains provisional state and discards buffered evidence after terminal failure", async () => {
  const committed = implementationAwaitingResumeState();
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: committed }]);
  registerCycleExtension(harness.pi, cycleDependencies({
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
  }));
  await harness.handlers.get("session_start")({}, harness.ctx);

  const command = harness.commands.get("ima:cycle");
  const firstSend = harness.waitForSend();
  const firstCommand = command.handler("resume", harness.ctx);
  await firstSend;
  assert.equal(harness.entries.length, 1);
  harness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  harness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  harness.handlers.get("agent_start")();
  await harness.handlers.get("tool_result")(lifecycleToolResult(awaitingEvidence(committed), "implementation", "COMPLETED"), harness.ctx);
  assert.equal(harness.entries.length, 1);

  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.handlers.get("agent_start")();
  harness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error" }] });
  harness.handlers.get("agent_settled")();
  await firstCommand;

  assert.equal(harness.entries.length, 2);
  assert.equal(harness.entries.at(-1).data.phase, "implementation");
  assert.equal(harness.entries.at(-1).data.status, "awaiting-evidence");
  assert.equal(harness.entries.at(-1).data.evidence.at(-1).phase, "plan");
  await command.handler("status", harness.ctx);
  assert.equal(harness.statuses.at(-1).value, "Cycle awaiting-evidence: FNR-3036; phase implementation; mode guided; review 0/5.");
  await command.handler("resume", harness.ctx);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.entries.length, 2);
});

test("default cycle wiring adopts provisional state after a synchronous injection failure", async () => {
  const committed = implementationAwaitingResumeState();
  const routed = [];
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: committed }]);
  harness.pi.sendUserMessage = () => { throw new Error("synchronous send failure"); };
  registerCycleExtension(harness.pi, cycleDependencies({
    applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
  }));

  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);

  assert.deepEqual(routed, ["implementation"]);
  assert.equal(harness.entries.length, 1);
  assert.deepEqual({ phase: harness.entries[0].data.phase, status: harness.entries[0].data.status }, { phase: "implementation", status: "awaiting-evidence" });
  assert.match(harness.statuses.at(-1).value, /awaiting-evidence/);
  assert.ok(harness.notifications.some(({ level, message }) => level === "warning" && /cycle_phase_injection_failed/.test(message)));

  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  assert.deepEqual(routed, ["implementation"]);
  assert.deepEqual(harness.messages, []);
});

test("default durable store persists and restores a contained cache", async () => {
  const root = await temporaryDirectory();
  try {
    const dispatched = await dispatchWithDefaultStore(root);
    const store = join(root, ".ima-cycle");
    assert.equal(await readFile(join(store, ".gitignore"), "utf8"), "*\n");
    assert.equal(parseCycleRecord(await readFile(join(store, "active.json"), "utf8"))?.status, "awaiting-evidence");
    await failDefaultStoreDispatch(dispatched);
    assert.equal(dispatched.harness.notifications.some(({ level }) => level === "warning"), false);

    const restored = createCycleExtensionHarness([]);
    restored.ctx.cwd = root;
    registerCycleExtension(restored.pi, {
      recall: async () => vestigeSearch(),
      resolveProjectRoot: async () => root,
      applyRoute: async () => ({ ok: true }),
      expandPrompt: async () => "expanded prompt",
    });
    await restored.handlers.get("session_start")({}, restored.ctx);
    assert.match(restored.statuses.at(-1).value, /awaiting-evidence/);
    assert.deepEqual(restored.messages, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default durable store rejects unsafe cache paths without touching external files", async () => {
  const assertBlocked = async (setup) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    try {
      const { sentinel, expected, absent } = await setup(root, outside);
      const dispatched = await dispatchWithDefaultStore(root);
      assert.equal(await readFile(sentinel, "utf8"), expected);
      if (absent) await assert.rejects(readFile(absent, "utf8"));
      await failDefaultStoreDispatch(dispatched);
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  };

  await assertBlocked(async (root, outside) => {
    const sentinel = join(outside, "sentinel");
    await writeFile(sentinel, "outside-store");
    await symlink(outside, join(root, ".ima-cycle"), "dir");
    return { sentinel, expected: "outside-store", absent: join(outside, "active.json") };
  });

  await assertBlocked(async (root, outside) => {
    const store = join(root, ".ima-cycle");
    const sentinel = join(outside, "sentinel");
    await mkdir(store);
    await writeFile(sentinel, "outside-ignore");
    await symlink(sentinel, join(store, ".gitignore"));
    return { sentinel, expected: "outside-ignore", absent: join(store, "active.json") };
  });

  for (const content of ["", "active.json\n"]) {
    await assertBlocked(async (root, outside) => {
      const store = join(root, ".ima-cycle");
      const sentinel = join(outside, "sentinel");
      await mkdir(store);
      await writeFile(sentinel, content);
      await writeFile(join(store, ".gitignore"), content);
      return { sentinel, expected: content, absent: join(store, "active.json") };
    });
  }

  await assertBlocked(async (root, outside) => {
    const store = join(root, ".ima-cycle");
    const sentinel = join(outside, "sentinel");
    await mkdir(store);
    await mkdir(join(store, ".gitignore"));
    await writeFile(sentinel, "ignore-directory");
    return { sentinel, expected: "ignore-directory", absent: join(store, "active.json") };
  });

  const root = await temporaryDirectory();
  const outside = await temporaryDirectory();
  try {
    const store = join(root, ".ima-cycle");
    const sentinel = join(outside, "active.json");
    await mkdir(store);
    await writeFile(join(store, ".gitignore"), "*\n");
    await writeFile(sentinel, serializeCycleRecord(createCycleState(jira, { timestamp: at })));
    await symlink(sentinel, join(store, "active.json"));

    const reader = createCycleExtensionHarness([]);
    reader.ctx.cwd = root;
    registerCycleExtension(reader.pi, {
      recall: async () => vestigeSearch(),
      resolveProjectRoot: async () => root,
      applyRoute: async () => ({ ok: true }),
      expandPrompt: async () => "expanded prompt",
    });
    await reader.handlers.get("session_start")({}, reader.ctx);
    assert.equal(reader.statuses.at(-1).value, "No active cycle.");

    const dispatched = await dispatchWithDefaultStore(root);
    assert.equal(await readFile(sentinel, "utf8"), serializeCycleRecord(createCycleState(jira, { timestamp: at })));
    await failDefaultStoreDispatch(dispatched);
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("session start restores durable state and reconciles it before reporting status", async () => {
  const durable = createCycleState(jira, { timestamp: at });
  const direct = directPlanRecord(durable, "APPROVED", { id: reviewUuid(701), recordKey: `${durable.lifecycleKey}:plan:durable` });
  const calls = [];
  const persisted = [];
  const recall = async (query) => {
    calls.push(query);
    return query.endsWith(" plan") ? vestigeSearch([direct]) : vestigeSearch([]);
  };
  const harness = createCycleExtensionHarness([]);
  registerCycleExtension(harness.pi, cycleDependencies({
    recall,
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
    loadDurableState: async () => durable,
    persistDurableState: async (_cwd, state) => persisted.push(state),
  }));

  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.deepEqual(calls, [
    `${durable.lifecycleKey} plan`,
    `${durable.lifecycleKey} plan`,
    `${durable.lifecycleKey} implementation`,
  ]);
  assert.deepEqual(harness.messages, []);
  assert.equal(persisted.length, 1);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0].data.phase, "implementation");
  assert.equal(harness.entries[0].data.status, "awaiting-resume");
  assert.equal(harness.statuses.at(-1).value, "Cycle awaiting-resume: FNR-3036; phase implementation; mode guided; review 0/5.");
});

test("session start reconciles a stale durable phase from verified lifecycle evidence", async () => {
  const stale = awaitingEvidence(implementationAwaitingResumeState());
  const persisted = [];
  const harness = createCycleExtensionHarness([]);
  registerCycleExtension(harness.pi, cycleDependencies({
    recall: async () => vestigeSearch([persistedRecord(stale, "implementation", "COMPLETED", { id: "durable-implementation" })]),
    applyRoute: async () => ({ ok: true }),
    expandPrompt: async () => "expanded prompt",
    loadDurableState: async () => stale,
    persistDurableState: async (_cwd, state) => persisted.push(state),
  }));

  await harness.handlers.get("session_start")({}, harness.ctx);

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].phase, "test");
  assert.equal(persisted[0].status, "awaiting-resume");
  assert.equal(harness.entries.at(-1).data.phase, "test");
});

test("resolves advisory current-phase markers while preserving exact extraction compatibility", () => {
  const first = "<!-- ima-cycle outcome: phase=implementation; outcome=COMPLETED -->";
  const last = "<!-- ima-cycle outcome: phase=implementation; outcome=COMPLETED  -->";
  assert.deepEqual(resolvePhaseOutcome(`${marker("plan", "APPROVED")}\n${first}\n${last}`, "implementation"), {
    ok: true,
    phase: "implementation",
    outcome: "COMPLETED",
    marker: last,
  });
  assert.equal(resolvePhaseOutcome(marker("plan", "APPROVED"), "implementation").error.code, "phase_marker_missing");
  assert.equal(resolvePhaseOutcome(`${marker("implementation", "COMPLETED")}\n${marker("implementation", "BLOCKED")}`, "implementation").error.code, "phase_marker_ambiguous");
  assert.equal(resolvePhaseOutcome(marker("implementation", "COMPLETED").replace("COMPLETED", "READY"), "implementation").error.code, "phase_marker_invalid");
  assert.equal(extractPhaseOutcome(`${first}\n${last}`).error.code, "phase_marker_ambiguous");
});

test("parses only persisted lifecycle records with exact identity, phase, and completion evidence", () => {
  const state = createCycleState(jira, { timestamp: at });
  const selection = { lifecycleKey: state.lifecycleKey, phase: state.phase, jiraKey: state.source.key, taskwarriorUuid: "" };
  const parsed = parseLifecycleSearchRecords({ data: { results: [
    persistedRecord(state, "plan", "APPROVED", { id: "good" }),
    persistedRecord(state, "plan", "APPROVED", { id: "wrong-key", lifecycleKey: "other" }),
    persistedRecord(state, "plan", "APPROVED", { id: "wrong-phase", lifecyclePhase: "implementation" }),
    persistedRecord(state, "plan", "APPROVED", { id: "wrong-outcome", lifecycleOutcome: "failed" }),
    persistedRecord(state, "plan", "APPROVED", { id: "wrong-source", jiraKey: "FNR-9999" }),
  ] } }, selection);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.records.map(({ artifactId, verified }) => [artifactId, verified]), [["good", true], ["wrong-key", false], ["wrong-phase", false], ["wrong-outcome", false], ["wrong-source", false]]);

  const nested = parseLifecycleSearchRecords({ results: [{ node: persistedRecord(state, "plan", "APPROVED", { id: "nested" }) }] }, selection);
  assert.equal(nested.valid, true);
  assert.deepEqual(nested.records[0].artifactId, "nested");
  assert.equal(nested.records[0].verified, true);

  const keyed = parseLifecycleSearchRecords({
    results: [persistedRecord(state, "plan", "APPROVED", {
      id: "keyed",
      recordKey: "ima-pi:jira:FNR-3036:plan:keyed",
    })],
  }, selection);
  assert.equal(keyed.valid, true);
  assert.equal(keyed.records[0].recordKey, "ima-pi:jira:FNR-3036:plan:keyed");

  const documentState = awaitingPhaseState("document");
  const documentSelection = { lifecycleKey: documentState.lifecycleKey, phase: "document", jiraKey: documentState.source.key, taskwarriorUuid: "" };
  const document = parseLifecycleSearchRecords({ data: { results: [persistedRecord(documentState, "document", "READY")] } }, documentSelection);
  assert.equal(document.valid, true);
  assert.equal(document.records[0].verified, true);
});

test("requires an authoritative terminal lifecycle verification marker", () => {
  const state = createCycleState(jira, { timestamp: at });
  const selection = { lifecycleKey: state.lifecycleKey, phase: "plan", jiraKey: state.source.key, taskwarriorUuid: "" };
  const matching = persistedRecord(state, "plan", "APPROVED", { id: "matching-terminal" });
  const inlineCurrentThenForeignTerminal = persistedRecord(state, "plan", "APPROVED", {
    id: "inline-current-terminal-foreign",
    artifact: `${marker("plan", "APPROVED")}\n${lifecycleVerification(state, "plan")}`,
    lifecyclePhase: "implementation",
  });
  const nonterminalBase = persistedRecord(state, "plan", "APPROVED", { id: "nonterminal" });
  const nonterminal = { ...nonterminalBase, content: `${nonterminalBase.content}\ntrailing text` };
  const parsed = parseLifecycleSearchRecords({ data: { results: [matching, inlineCurrentThenForeignTerminal, nonterminal] } }, selection);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.records.map(({ artifactId, verified }) => [artifactId, verified]), [
    ["matching-terminal", true],
    ["inline-current-terminal-foreign", false],
    ["nonterminal", false],
  ]);
  assert.doesNotMatch(parsed.records[0].artifact, /ima-lifecycle verification/);

  const reconciled = reconcileCycleFromLifecycle(state, [parsed.records[0]], { timestamp: at });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true);

  const rejected = reconcileCycleFromLifecycle(state, [parsed.records[1]], { timestamp: at });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.reconciled, false);
  assert.deepEqual(rejected.state, state);
});

test("reconciles verified lifecycle records through the existing phase transitions", () => {
  const transitions = [
    ["plan", "APPROVED", "implementation", "awaiting-resume"],
    ["implementation", "COMPLETED", "test", "awaiting-resume"],
    ["test", "PASSED", "review", "awaiting-resume"],
    ["review", "APPROVED", "document", "awaiting-resume"],
    ["review", "REQUEST_CHANGES", "resolution", "awaiting-resume"],
    ["resolution", "RESOLVED", "rereview", "awaiting-resume"],
    ["rereview", "APPROVED", "document", "awaiting-resume"],
    ["rereview", "REQUEST_CHANGES", "resolution", "awaiting-resume"],
    ["document", "READY", "document", "closeout-ready"],
  ];
  for (const [phase, outcome, nextPhase, status] of transitions) {
    const state = awaitingPhaseState(phase);
    const parsed = parseLifecycleSearchRecords({ data: { results: [persistedRecord(state, phase, outcome)] } }, { lifecycleKey: state.lifecycleKey, phase, jiraKey: state.source.key, taskwarriorUuid: "" });
    assert.equal(parsed.valid, true);
    const reconciled = reconcileCycleFromLifecycle(state, parsed.records, { timestamp: at });
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.equal(reconciled.reconciled, true);
    assert.deepEqual({ phase: reconciled.state.phase, status: reconciled.state.status }, { phase: nextPhase, status });
  }

  const blocked = awaitingPhaseState("implementation");
  const blockedParsed = parseLifecycleSearchRecords({ data: { results: [persistedRecord(blocked, "implementation", "BLOCKED")] } }, { lifecycleKey: blocked.lifecycleKey, phase: "implementation", jiraKey: blocked.source.key, taskwarriorUuid: "" });
  const blockedResult = reconcileCycleFromLifecycle(blocked, blockedParsed.records, { timestamp: at });
  assert.equal(blockedResult.ok, true);
  assert.deepEqual(blockedResult.state.blockers, ["implementation:BLOCKED"]);

  const defects = awaitingPhaseState("test");
  const defectsParsed = parseLifecycleSearchRecords({ data: { results: [persistedRecord(defects, "test", "DEFECTS")] } }, { lifecycleKey: defects.lifecycleKey, phase: "test", jiraKey: defects.source.key, taskwarriorUuid: "" });
  const defectsResult = reconcileCycleFromLifecycle(defects, defectsParsed.records, { timestamp: at });
  assert.equal(defectsResult.ok, true);
  assert.deepEqual(defectsResult.state.blockers, ["test:DEFECTS"]);
});

test("keeps reconciliation idempotent and fails loudly for verified unresolved or conflicting evidence", () => {
  const state = createCycleState(jira, { timestamp: at });
  const selection = { lifecycleKey: state.lifecycleKey, phase: "plan", jiraKey: state.source.key, taskwarriorUuid: "" };
  const parsed = parseLifecycleSearchRecords({ data: { results: [persistedRecord(state, "plan", "APPROVED", { id: "plan-proof" })] } }, selection);
  const recovered = reconcileCycleFromLifecycle(state, parsed.records, { timestamp: at });
  assert.equal(recovered.ok, true);
  const repeated = reconcileCycleFromLifecycle(recovered.state, parsed.records, { timestamp: at });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.reconciled, false);
  assert.deepEqual(repeated.state, recovered.state);

  const noEvidence = reconcileCycleFromLifecycle(state, [], { timestamp: at });
  assert.equal(noEvidence.ok, true);
  assert.equal(noEvidence.reconciled, false);

  const unresolved = parseLifecycleSearchRecords({ data: { results: [persistedRecord(state, "plan", "APPROVED", { id: "unclear", artifact: "Saved artifact without a cycle outcome." })] } }, selection);
  const unresolvedResult = reconcileCycleFromLifecycle(state, unresolved.records, { timestamp: at });
  assert.equal(unresolvedResult.ok, false);
  assert.equal(unresolvedResult.error.code, "lifecycle_outcome_undetermined");
  assert.equal(unresolvedResult.artifactId, "unclear");
  assert.deepEqual(unresolvedResult.state, state);

  const conflicting = parseLifecycleSearchRecords({ data: { results: [persistedRecord(state, "plan", "APPROVED", { id: "approved" }), persistedRecord(state, "plan", "BLOCKED", { id: "blocked" })] } }, selection);
  const conflict = reconcileCycleFromLifecycle(state, conflicting.records, { timestamp: at });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "lifecycle_outcome_undetermined");
});

test("uses only fresh identified records for repeated phase reconciliation", () => {
  const firstAttempt = awaitingPhaseState("resolution");
  const firstSelection = { lifecycleKey: firstAttempt.lifecycleKey, phase: "resolution", jiraKey: firstAttempt.source.key, taskwarriorUuid: "" };
  const firstArtifact = parseLifecycleSearchRecords({ data: { results: [persistedRecord(firstAttempt, "resolution", "RESOLVED", {
    id: "resolution-first",
    recordKey: "ima-pi:jira:FNR-3036:resolution:first",
  })] } }, firstSelection);
  const firstRecovery = reconcileCycleFromLifecycle(firstAttempt, firstArtifact.records, { timestamp: at });
  assert.equal(firstRecovery.ok, true);

  const rereviewAttempt = awaitingEvidence(firstRecovery.state);
  const secondAttempt = awaitingEvidence(evidence(rereviewAttempt, "rereview", "REQUEST_CHANGES", "rereview-second"));
  const replay = reconcileCycleFromLifecycle(secondAttempt, firstArtifact.records, { timestamp: at });
  assert.equal(replay.ok, true);
  assert.equal(replay.reconciled, false);
  assert.deepEqual(replay.state, secondAttempt);

  const toolCallOnly = {
    ...secondAttempt,
    evidence: secondAttempt.evidence.map((item) => item.artifactId === "resolution-first" ? { ...item, artifactId: null } : item),
  };
  assert.equal(toolCallOnly.evidence.find((item) => item.recordKey)?.artifactId, null);
  assert.equal(toolCallOnly.evidence.find((item) => item.recordKey)?.recordKey, "ima-pi:jira:FNR-3036:resolution:first");
  const toolCallReplay = reconcileCycleFromLifecycle(toolCallOnly, firstArtifact.records, { timestamp: at });
  assert.equal(toolCallReplay.ok, true);
  assert.equal(toolCallReplay.reconciled, false);
  assert.deepEqual(toolCallReplay.state, toolCallOnly);

  const idlessBase = persistedRecord(secondAttempt, "resolution", "RESOLVED", { id: "idless" });
  const idless = parseLifecycleSearchRecords({ data: { results: [{ content: idlessBase.content }] } }, { lifecycleKey: secondAttempt.lifecycleKey, phase: "resolution", jiraKey: secondAttempt.source.key, taskwarriorUuid: "" });
  const unresolved = reconcileCycleFromLifecycle(secondAttempt, idless.records, { timestamp: at });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.error.code, "lifecycle_outcome_undetermined");
  assert.deepEqual(unresolved.state, secondAttempt);

  const fresh = parseLifecycleSearchRecords({ data: { results: [persistedRecord(secondAttempt, "resolution", "RESOLVED", { id: "resolution-second" })] } }, { lifecycleKey: secondAttempt.lifecycleKey, phase: "resolution", jiraKey: secondAttempt.source.key, taskwarriorUuid: "" });
  const recovered = reconcileCycleFromLifecycle(secondAttempt, [...firstArtifact.records, ...fresh.records], { timestamp: at });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.reconciled, true);
  assert.deepEqual({ phase: recovered.state.phase, status: recovered.state.status }, { phase: "rereview", status: "awaiting-resume" });

  const blockedAttempt = awaitingPhaseState("implementation");
  const blockedArtifact = parseLifecycleSearchRecords({ data: { results: [persistedRecord(blockedAttempt, "implementation", "BLOCKED", { id: "implementation-blocked" })] } }, { lifecycleKey: blockedAttempt.lifecycleKey, phase: "implementation", jiraKey: blockedAttempt.source.key, taskwarriorUuid: "" });
  const blocked = reconcileCycleFromLifecycle(blockedAttempt, blockedArtifact.records, { timestamp: at });
  assert.equal(blocked.ok, true);
  const resumed = prepareCycleResume(blocked.state);
  assert.equal(resumed.ok, true);
  const retry = awaitingEvidence(resumed.state);
  const blockedReplay = reconcileCycleFromLifecycle(retry, blockedArtifact.records, { timestamp: at });
  assert.equal(blockedReplay.ok, true);
  assert.equal(blockedReplay.reconciled, false);
  assert.deepEqual(blockedReplay.state, retry);
});

test("buildResumeSource always supplies the central cycle reporting contract", () => {
  for (const [phase, outcomes] of Object.entries(CYCLE_PHASE_OUTCOMES)) {
    const state = { ...awaitingPhaseState(phase), status: "awaiting-resume" };
    const packet = buildResumeSource(state);
    assert.match(packet, /Cycle dispatch contract \(non-negotiable\):/);
    assert.match(packet, /cycleDispatch: true/);
    assert.match(packet, new RegExp(`cyclePhase: ${phase}`));
    assert.match(packet, new RegExp(`validOutcomes: ${outcomes.join(", ")}`));
    assert.match(packet, new RegExp(`requiredMarker: <!-- ima-cycle outcome: phase=${phase}; outcome=<valid-outcome> -->`));
    assert.match(packet, /Persist this phase through ima_lifecycle/);
  }
});

test("keeps verified live writes advisory and reports unresolved outcomes with an artifact reference", () => {
  const state = createCycleState(jira, { timestamp: at });
  const duplicate = `${marker("plan", "APPROVED")}\n${marker("plan", "APPROVED")}`;
  const matched = observeLifecycleResult({ ...lifecycleObservation(state, "plan", "APPROVED"), input: { type: "plan", identity, artifact: duplicate } });
  assert.equal(matched.matched, true);

  const unresolved = observeLifecycleResult({
    ...lifecycleObservation(state, "plan", "APPROVED"),
    input: { type: "plan", identity, artifact: "No cycle marker." },
    result: { details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, artifactId: "persisted-plan", receiptAccepted: true, semanticRecall: { matched: true } }, content: [], isError: false },
  });
  assert.equal(unresolved.matched, false);
  assert.equal(unresolved.diagnostic.phase, "plan");
  assert.equal(unresolved.diagnostic.artifactId, "persisted-plan");
});

test("coordinates a direct-MCP persisted-evidence reconciliation shell", async () => {
  const state = createCycleState(jira, { timestamp: at });
  const entries = [];
  const calls = [];
  const result = await coordinateCycleReconcile({
    state,
    recall: async (query) => {
      calls.push(query);
      return vestigeSearch([persistedRecord(state, "plan", "APPROVED", { id: "plan-proof" })]);
    },
    appendState: (next) => entries.push(next),
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [`${state.lifecycleKey} plan`]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].phase, "implementation");

  const noEvidence = await coordinateCycleReconcile({ state, recall: async () => vestigeSearch(), appendState: () => { throw new Error("must not append"); }, timestamp: at });
  assert.equal(noEvidence.ok, true);
  assert.equal(noEvidence.reconciled, false);

  const contentWrapped = await coordinateCycleReconcile({
    state,
    recall: async () => ({ content: [{ type: "text", text: JSON.stringify({ results: [persistedRecord(state, "plan", "APPROVED", { id: "content-proof" })] }) }] }),
    appendState: () => {},
    timestamp: at,
  });
  assert.equal(contentWrapped.ok, true);
  assert.equal(contentWrapped.reconciled, true);

  const malformed = await coordinateCycleReconcile({ state, recall: async () => ({ structuredContent: {} }), appendState: () => {}, timestamp: at });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "cycle_reconcile_read_failed");

  const unresolved = await coordinateCycleReconcile({
    state,
    recall: async () => vestigeSearch([persistedRecord(state, "plan", "APPROVED", {
      id: "unclear",
      recordKey: "ima-pi:jira:FNR-3036:plan:unclear",
      artifact: "No cycle marker.",
    })]),
    appendState: () => {},
    timestamp: at,
  });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.error.code, "lifecycle_outcome_undetermined");
  assert.deepEqual(unresolved.diagnostic, {
    phase: "plan",
    artifactId: "unclear",
    recordKey: "ima-pi:jira:FNR-3036:plan:unclear",
  });
});

test("recovers consecutive verified phases before any resume dispatch", async () => {
  const stale = createCycleState(jira, { timestamp: at });
  const calls = [];
  const entries = [];
  const result = await coordinateCycleRecovery({
    state: stale,
    recall: async (query) => {
      const phase = query.split(" ").at(-1);
      calls.push(phase);
      const records = {
        plan: persistedRecord(stale, "plan", "APPROVED", { id: "plan-proof" }),
        implementation: persistedRecord(stale, "implementation", "COMPLETED", { id: "implementation-proof" }),
      };
      return vestigeSearch(records[phase] ? [records[phase]] : []);
    },
    appendState: (state) => entries.push(state),
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.deepEqual({ phase: result.state.phase, status: result.state.status }, { phase: "test", status: "awaiting-resume" });
  assert.deepEqual(calls, ["plan", "implementation", "test"]);
  assert.deepEqual(entries.map(({ phase, status }) => ({ phase, status })), [
    { phase: "implementation", status: "awaiting-resume" },
    { phase: "test", status: "awaiting-resume" },
  ]);

  const implementationStale = implementationAwaitingResumeState();
  const implementationRecovery = await coordinateCycleRecovery({
    state: implementationStale,
    recall: async (query) => query.endsWith(" implementation")
      ? vestigeSearch([persistedRecord(implementationStale, "implementation", "COMPLETED", { id: "implementation-stale-proof" })])
      : vestigeSearch(),
    appendState: () => {},
    timestamp: at,
  });
  assert.equal(implementationRecovery.ok, true);
  assert.deepEqual({ phase: implementationRecovery.state.phase, status: implementationRecovery.state.status }, { phase: "test", status: "awaiting-resume" });
});

test("caps verified recovery by the fixed lifecycle and review cap", async () => {
  const stale = createCycleState(jira, { timestamp: at, reviewCap: 2 });
  const records = {
    plan: [["plan", "APPROVED"]],
    implementation: [["implementation", "COMPLETED"]],
    test: [["test", "PASSED"]],
    review: [["review", "REQUEST_CHANGES"]],
    resolution: [["resolution", "RESOLVED"], ["resolution", "RESOLVED"]],
    rereview: [["rereview", "REQUEST_CHANGES"], ["rereview", "APPROVED"]],
  };
  const calls = [];
  const result = await coordinateCycleRecovery({
    state: stale,
    recall: async (query) => {
      const phase = query.split(" ").at(-1);
      calls.push(phase);
      const record = records[phase]?.shift();
      return vestigeSearch(record ? [persistedRecord(stale, record[0], record[1], { id: `${phase}-${calls.length}` })] : []);
    },
    appendState: () => {},
    timestamp: at,
  });
  assert.equal(result.ok, true);
  assert.deepEqual({ phase: result.state.phase, status: result.state.status, reviewAttempts: result.state.reviewAttempts }, { phase: "document", status: "awaiting-resume", reviewAttempts: 2 });
  assert.equal(calls.length, 9);
});

test("preserves stale resume state and prevents dispatch for undetermined recovery evidence", async () => {
  const stale = implementationAwaitingResumeState();
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: stale }]);
  const routed = [];
  registerCycleExtension(harness.pi, cycleDependencies({
    recall: async () => vestigeSearch([persistedRecord(stale, "implementation", "COMPLETED", { id: "unclear", artifact: "No cycle marker." })]),
    applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; },
    expandPrompt: async () => "expanded prompt",
  }));
  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  assert.deepEqual(routed, []);
  assert.deepEqual(harness.messages, []);
  assert.deepEqual(harness.entries, []);
  assert.match(harness.statuses.at(-1).value, /awaiting-resume/);
  assert.ok(harness.notifications.some(({ level, message }) => level === "warning" && /outcome is unresolved/.test(message)));
});

test("rejects malformed or failed direct Vestige recall results", async () => {
  const state = createCycleState(jira, { timestamp: at });
  const rejectedResults = [
    null,
    { isError: true },
    { structuredContent: {} },
    { content: [{ type: "text", text: "not JSON" }] },
  ];
  for (const response of rejectedResults) {
    const entries = [];
    const result = await coordinateCycleReconcile({ state, recall: async () => response, appendState: (next) => entries.push(next), timestamp: at });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "cycle_reconcile_read_failed");
    assert.deepEqual(result.state, state);
    assert.deepEqual(entries, []);

    const routed = [];
    const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: state }]);
    registerCycleExtension(harness.pi, cycleDependencies({ recall: async () => response, applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; }, expandPrompt: async () => "expanded prompt" }));
    await harness.handlers.get("session_start")({}, harness.ctx);
    await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
    assert.deepEqual(routed, []);
    assert.deepEqual(harness.entries, []);
    assert.deepEqual(harness.messages, []);
  }
});

test("preserves awaiting-evidence state when reconciliation reads fail", async () => {
  const state = createCycleState(jira, { timestamp: at });
  for (const recall of [
    async () => null,
    async () => { throw new Error("vestige unavailable"); },
  ]) {
    const entries = [];
    const result = await coordinateCycleReconcile({ state, recall, appendState: (next) => entries.push(next), timestamp: at });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "cycle_reconcile_read_failed");
    assert.deepEqual(result.state, state);
    assert.deepEqual(entries, []);
  }
});

test("status and resume self-heal from persisted lifecycle evidence", async () => {
  const stuck = createCycleState(jira, { timestamp: at });
  const direct = directPlanRecord(stuck, "APPROVED", { id: reviewUuid(702), recordKey: `${stuck.lifecycleKey}:plan:self-heal` });
  const search = async (query) => {
    assert.match(query, new RegExp(`^${stuck.lifecycleKey} (plan|implementation)$`));
    return query.endsWith(" plan") ? vestigeSearch([direct]) : vestigeSearch([]);
  };
  const statusHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: stuck }]);
  registerCycleExtension(statusHarness.pi, cycleDependencies({ recall: search, applyRoute: async () => ({ ok: true }), expandPrompt: async () => "expanded prompt" }));
  await statusHarness.handlers.get("session_start")({}, statusHarness.ctx);
  await statusHarness.commands.get("ima:cycle").handler("status", statusHarness.ctx);
  assert.equal(statusHarness.entries.length, 1);
  assert.deepEqual({ phase: statusHarness.entries[0].data.phase, status: statusHarness.entries[0].data.status }, { phase: "implementation", status: "awaiting-resume" });

  const resumeHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: stuck }]);
  const routed = [];
  registerCycleExtension(resumeHarness.pi, cycleDependencies({ recall: search, applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; }, expandPrompt: async () => "expanded prompt" }));
  await resumeHarness.handlers.get("session_start")({}, resumeHarness.ctx);
  const command = resumeHarness.commands.get("ima:cycle");
  const sent = resumeHarness.waitForSend();
  const resumed = command.handler("resume", resumeHarness.ctx);
  await sent;
  assert.equal(resumeHarness.entries.length, 2);
  assert.deepEqual(routed, ["implementation"]);
  const recovered = resumeHarness.entries.at(-1).data;
  resumeHarness.handlers.get("input")({ source: "extension", text: "expanded prompt" });
  resumeHarness.handlers.get("before_agent_start")({ prompt: "expanded prompt" });
  resumeHarness.handlers.get("agent_start")();
  const implementationResult = lifecycleToolResult(awaitingEvidence(recovered), "implementation", "COMPLETED");
  implementationResult.input.identity.priorArtifactIds = [direct.id];
  await resumeHarness.handlers.get("tool_result")(implementationResult, resumeHarness.ctx);
  resumeHarness.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] });
  resumeHarness.handlers.get("agent_settled")();
  await resumed;
  assert.equal(resumeHarness.entries.at(-1).data.phase, "test");
  assert.equal(resumeHarness.entries.at(-1).data.status, "awaiting-resume");
});

test("keeps marker-free persisted planning evidence non-advancing until interactive confirmation", async () => {
  const stuck = createCycleState(jira, { timestamp: at });
  const legacy = directPlanRecord(stuck, "APPROVED", {
    id: reviewUuid(703),
    recordKey: `${stuck.lifecycleKey}:plan:legacy`,
    artifact: "Saved artifact without a cycle outcome.",
  });
  const search = async () => vestigeSearch([legacy]);

  const statusHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: stuck }]);
  registerCycleExtension(statusHarness.pi, cycleDependencies({ recall: search, applyRoute: async () => ({ ok: true }), expandPrompt: async () => "expanded prompt" }));
  await statusHarness.handlers.get("session_start")({}, statusHarness.ctx);
  await statusHarness.commands.get("ima:cycle").handler("status", statusHarness.ctx);
  assert.deepEqual(statusHarness.entries, []);
  assert.match(statusHarness.statuses.at(-1).value, /awaiting-evidence/);
  assert.deepEqual(statusHarness.notifications.filter(({ level }) => level === "warning"), []);

  const routed = [];
  const resumeHarness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: stuck }]);
  resumeHarness.ctx.ui.editor = async () => undefined;
  registerCycleExtension(resumeHarness.pi, cycleDependencies({ recall: search, applyRoute: async (_pi, _ctx, phase) => { routed.push(phase); return { ok: true }; }, expandPrompt: async () => "expanded prompt" }));
  await resumeHarness.handlers.get("session_start")({}, resumeHarness.ctx);
  await resumeHarness.commands.get("ima:cycle").handler("resume", resumeHarness.ctx);
  assert.deepEqual(routed, []);
  assert.deepEqual(resumeHarness.messages, []);
  assert.deepEqual(resumeHarness.entries, []);
});

test("warns instead of silently discarding a verified unresolved live write", async () => {
  const state = createCycleState(jira, { timestamp: at });
  const harness = createCycleExtensionHarness([{ type: "custom", customType: "ima-cycle-state", data: state }]);
  registerCycleExtension(harness.pi, cycleDependencies({ applyRoute: async () => ({ ok: true }), expandPrompt: async () => "expanded prompt" }));
  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.handlers.get("tool_result")({
    ...lifecycleToolResult(state, "plan", "APPROVED"),
    input: { type: "plan", identity, artifact: "No cycle marker." },
    details: { status: "completed", phase: "plan", lifecycleKey: state.lifecycleKey, artifactId: "persisted-plan", receiptAccepted: true, semanticRecall: { matched: true } },
  }, harness.ctx);
  assert.equal(harness.entries.length, 0);
  assert.match(harness.notifications.at(-1).message, /outcome is unresolved/);
  assert.match(harness.notifications.at(-1).message, /persisted-plan/);
});
