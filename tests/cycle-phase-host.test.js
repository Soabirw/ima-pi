import assert from "node:assert/strict";
import test from "node:test";
import { buildCycleOutcomeMarker, createCycleState, reduceCycleState } from "../lib/ima-cycle.ts";
import { coordinateCycleStart, registerCycleExtension } from "../extensions/cycle.ts";
import { lifecycleKey as planLifecycleKey, planRecord, planeSource, recallPayload } from "./cycle-plan-fixtures.js";

const ROUTE = Object.freeze({
  provider: "test-provider",
  model: "test-model",
  thinking: "high",
  profile: "cycle-profile",
  source: "command",
});
const IDENTITY = Object.freeze({
  childSessionId: "child-session",
  childSessionFile: "/isolated/sessions/child-session.jsonl",
  childSessionDir: "/isolated/sessions",
});
const at = "2026-08-04T18:00:00.000Z";

const cyclePhaseMarker = (phase, outcome) => `artifact\n${buildCycleOutcomeMarker({ phase, outcome })}`;
const cyclePhaseIdentity = (input) => ({
  project: "ima-pi",
  lifecycleKey: input.context.lifecycleKey,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "FNR-3036",
  sourceRefs: ["Jira:FNR-3036"],
  priorArtifactIds: [],
});
const cycleLifecycleEvent = (input, phase, outcome) => ({
  toolCallId: `${phase}-tool`,
  input: {
    type: phase,
    identity: cyclePhaseIdentity(input),
    artifact: cyclePhaseMarker(phase, outcome),
  },
  result: {
    content: [],
    details: {
      status: "completed",
      phase,
      lifecycleKey: input.context.lifecycleKey,
      artifactId: `${phase}-artifact`,
      receiptAccepted: true,
      semanticRecall: { matched: true },
    },
    isError: false,
  },
});
const settlement = (input, phase) => ({
  schemaVersion: 1,
  project: input.context.project,
  lifecycleKey: input.context.lifecycleKey,
  source: input.context.source,
  phase,
  dispatchId: input.context.dispatchId,
  childSessionId: IDENTITY.childSessionId,
  actual: {
    provider: input.route.provider,
    model: input.route.model,
    thinking: input.route.thinking,
  },
  artifacts: [{ artifactId: `${phase}-artifact`, recordKey: null }],
});
const settledResult = (input, phase, output) => ({
  status: "settled",
  acceptedEvidence: true,
  output,
  identity: IDENTITY,
  settlement: settlement(input, phase),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
};

const createCyclePhaseHarness = (createPhaseRuntime, branch = [], overrides = {}) => {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const notifications = [];
  const phaseMessages = [];
  const statuses = [];
  const widgets = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendMessage: overrides.sendMessage ?? ((message, options) => phaseMessages.push({ message, options })),
    getThinkingLevel: () => "high",
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const ctx = {
    cwd: "/cycle-parent",
    mode: "tui",
    hasUI: true,
    model: { provider: "parent-provider", id: "parent-model" },
    modelRegistry: {
      find: (_provider, model) => ({ provider: "test-provider", id: model }),
      hasConfiguredAuth: async () => true,
    },
    isProjectTrusted: () => true,
    isIdle: () => true,
    abort: () => { ctx.aborted = true; },
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => [],
      getLeafId: () => "parent-leaf",
      getSessionId: () => "parent-session",
    },
    ui: {
      setStatus: (key, value) => statuses.push({ key, value }),
      setWidget: (key, value, options) => widgets.push({ key, value, options }),
      notify: (message, level) => notifications.push({ message, level }),
      confirm: async () => true,
    },
  };
  registerCycleExtension(pi, {
    context: async () => ({ status: "ready" }),
    recall: overrides.recall ?? (async () => ({ structuredContent: { results: [] } })),
    resolveProjectRoot: async (cwd) => cwd,
    loadDurableState: overrides.loadDurableState ?? (async () => null),
    persistDurableState: overrides.persistDurableState ?? (async () => {}),
    applyRoute: async (_pi, _ctx, _phase, parentRoute) => ({ ok: true, route: parentRoute ?? ROUTE }),
    expandPrompt: async (value) => value,
    createPhaseRuntime,
    readPhaseSettlement: overrides.readPhaseSettlement ?? (async () => null),
  });
  return { handlers, commands, entries, notifications, phaseMessages, statuses, widgets, pi, ctx };
};

test("cycle dispatches an isolated phase host and advances only from its verified settled proof", async () => {
  const state = { runs: [], disposes: 0 };
  const createPhaseRuntime = async (input) => {
    state.input = input;
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async (message) => {
        state.runs.push(message);
        input.onActivity("phase tool: ima_lifecycle");
        await input.onLifecycle(cycleLifecycleEvent(input, "plan", "APPROVED"));
        return settledResult(input, "plan", "plan saved");
      },
      reply: async () => { throw new Error("unexpected reply"); },
      abort: async () => undefined,
      dispose: async () => { state.disposes += 1; },
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);

  const finalState = harness.entries.at(-1).data;
  assert.ok(state.input, JSON.stringify(harness.notifications));
  assert.equal(state.input.context.phase, "plan");
  assert.equal(state.input.context.source, "FNR-3036");
  assert.match(state.runs[0], /cyclePhase: plan/);
  assert.deepEqual(
    { phase: finalState.phase, status: finalState.status, execution: finalState.execution.status },
    { phase: "implementation", status: "awaiting-resume", execution: "settled" },
  );
  assert.equal(state.disposes, 1);
  const actualRoute = `${state.input.route.provider}/${state.input.route.model} · thinking ${state.input.route.thinking ?? "default"}`;
  assert.ok(harness.notifications.some(({ message }) => message.startsWith("IMA cycle: start accepted for FNR-3036")));
  assert.ok(harness.widgets.some(({ value }) => Array.isArray(value) && value.includes("activity: Using ima_lifecycle.")));
  assert.ok(harness.widgets.some(({ value }) => Array.isArray(value) && value.includes(`actual ${actualRoute}`)));
  assert.ok(harness.widgets.every(({ options }) => options?.placement === "belowEditor"));
  assert.deepEqual(harness.phaseMessages.at(-1).message, {
    customType: "ima-cycle-phase-completion",
    content: `Cycle plan completed with ${actualRoute}.`,
    display: true,
  });
  assert.deepEqual(harness.widgets.at(-1), {
    key: "ima-cycle-phase",
    value: undefined,
    options: { placement: "belowEditor" },
  });
});

test("cycle reply is literal, retains the waiting phase host, and advances only after its settled proof", async () => {
  const state = { replies: [], aborts: 0, disposes: 0 };
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "need evidence", identity: IDENTITY }),
      reply: async (answer) => {
        state.replies.push(answer);
        await input.onLifecycle(cycleLifecycleEvent(input, "plan", "APPROVED"));
        return settledResult(input, "plan", "accepted");
      },
      abort: async () => { state.aborts += 1; },
      dispose: async () => { state.disposes += 1; },
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);
  assert.equal(harness.entries.at(-1).data.execution.status, "waiting-reply");
  assert.deepEqual(harness.phaseMessages, [{
    message: {
      customType: "ima-cycle-phase-question",
      content: "need evidence\n\nReply with `/ima:cycle reply <answer>`.",
      display: true,
    },
    options: undefined,
  }]);
  await harness.commands.get("ima:cycle").handler("reply /ima:cycle close", harness.ctx);

  const finalState = harness.entries.at(-1).data;
  assert.deepEqual(state.replies, ["/ima:cycle close"]);
  assert.deepEqual(
    { phase: finalState.phase, status: finalState.status, execution: finalState.execution.status },
    { phase: "implementation", status: "awaiting-resume", execution: "settled" },
  );
  assert.equal(state.aborts, 0);
  assert.equal(state.disposes, 1);
});

test("cycle preserves a waiting phase when its persistent question cannot be displayed", async () => {
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "need evidence", identity: IDENTITY }),
      reply: async () => { throw new Error("unexpected reply"); },
      abort: async () => undefined,
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime, [], {
    sendMessage: () => { throw new Error("display unavailable"); },
  });

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);

  assert.equal(harness.entries.at(-1).data.execution.status, "waiting-reply");
  assert.ok(harness.notifications.some(({ message }) => (
    message === "need evidence\n\nReply with `/ima:cycle reply <answer>`."
  )));
});

test("cycle displays an actionable fallback when a waiting phase returns no text", async () => {
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "", identity: IDENTITY }),
      reply: async () => { throw new Error("unexpected reply"); },
      abort: async () => undefined,
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);

  assert.equal(harness.entries.at(-1).data.execution.status, "waiting-reply");
  assert.equal(
    harness.phaseMessages[0].message.content,
    "Cycle phase is waiting for operator input.\n\nReply with `/ima:cycle reply <answer>`.",
  );
});

test("cycle converts a thrown host run into retryable failed state without losing the runtime error", async () => {
  const state = { aborts: 0 };
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => { throw new Error("provider_transport_failed"); },
      reply: async () => { throw new Error("unexpected reply"); },
      abort: async () => { state.aborts += 1; },
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);

  const failed = harness.entries.at(-1).data;
  assert.deepEqual(
    { phase: failed.phase, status: failed.status, execution: failed.execution.status },
    { phase: "plan", status: "awaiting-resume", execution: "failed" },
  );
  assert.equal(state.aborts, 1);
  assert.ok(harness.notifications.some(({ message }) => message.includes("provider_transport_failed")));
});

test("cycle keeps buffered lifecycle evidence out of committed state after a failed terminal host", async () => {
  const state = { aborts: 0 };
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => {
        await input.onLifecycle(cycleLifecycleEvent(input, "plan", "APPROVED"));
        return { status: "failed", acceptedEvidence: false, output: "terminal failed", identity: IDENTITY, error: "phase_agent_not_settled" };
      },
      reply: async () => { throw new Error("unexpected reply"); },
      abort: async () => { state.aborts += 1; },
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start --mode autonomous FNR-3036", harness.ctx);
  const failed = harness.entries.at(-1).data;
  assert.deepEqual(
    { phase: failed.phase, status: failed.status, evidence: failed.evidence.length, execution: failed.execution.status },
    { phase: "plan", status: "awaiting-resume", evidence: 0, execution: "failed" },
  );
  assert.equal(state.aborts, 1);
});

test("cycle rejects a second reply while the first owns the waiting phase", async () => {
  const release = deferred();
  const replyStarted = deferred();
  const state = { replies: 0, aborts: 0, disposes: 0 };
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "need answer", identity: IDENTITY }),
      reply: async () => {
        state.replies += 1;
        replyStarted.resolve();
        await release.promise;
        return { status: "waiting-reply", acceptedEvidence: false, output: "still waiting", identity: IDENTITY };
      },
      abort: async () => { state.aborts += 1; },
      dispose: async () => { state.disposes += 1; },
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);
  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);

  const first = harness.commands.get("ima:cycle").handler("reply first", harness.ctx);
  await replyStarted.promise;
  await harness.commands.get("ima:cycle").handler("reply second", harness.ctx);
  assert.equal(state.replies, 1);
  assert.equal(state.aborts, 0);
  assert.equal(state.disposes, 0);

  release.resolve();
  await first;
  assert.equal(harness.entries.at(-1).data.execution.status, "waiting-reply");
  assert.deepEqual(
    harness.phaseMessages.map(({ message }) => message.content),
    [
      "need answer\n\nReply with `/ima:cycle reply <answer>`.",
      "still waiting\n\nReply with `/ima:cycle reply <answer>`.",
    ],
  );
});

test("cycle ignores parent lifecycle events while an isolated execution owns the phase", async () => {
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "wait", identity: IDENTITY }),
      reply: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "wait", identity: IDENTITY }),
      abort: async () => undefined,
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);
  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);
  const before = harness.entries.at(-1).data;

  const event = cycleLifecycleEvent({ context: {
    lifecycleKey: before.lifecycleKey,
  } }, "plan", "APPROVED");
  await harness.handlers.get("tool_result")({
    toolName: "ima_lifecycle",
    toolCallId: event.toolCallId,
    input: event.input,
    content: event.result.content,
    details: event.result.details,
    isError: event.result.isError,
  }, harness.ctx);

  const after = harness.entries.at(-1).data;
  assert.equal(after.phase, "plan");
  assert.equal(after.evidence.length, 0);
  assert.equal(after.execution.status, "waiting-reply");
});

test("cycle stop persists the stopped phase before aborting its isolated host", async () => {
  const state = { aborts: 0 };
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "need reply", identity: IDENTITY }),
      reply: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "need reply", identity: IDENTITY }),
      abort: async () => { state.aborts += 1; },
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);
  await harness.commands.get("ima:cycle").handler("stop", harness.ctx);

  const finalState = harness.entries.at(-1).data;
  assert.equal(state.aborts, 1);
  assert.deepEqual(
    { phase: finalState.phase, status: finalState.status, execution: finalState.execution.status },
    { phase: "plan", status: "stopped", execution: "stopped" },
  );
});

test("autonomous mode stops after a failed phase host and retries only after explicit resume", async () => {
  const state = { hosts: 0 };
  const createPhaseRuntime = async (input) => {
    state.hosts += 1;
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "failed", acceptedEvidence: false, output: "provider failed", identity: IDENTITY, error: "phase_agent_not_settled" }),
      reply: async () => { throw new Error("unexpected reply"); },
      abort: async () => undefined,
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start --mode autonomous FNR-3036", harness.ctx);
  const failed = harness.entries.at(-1).data;
  assert.equal(state.hosts, 1);
  assert.deepEqual(
    { phase: failed.phase, status: failed.status, execution: failed.execution.status },
    { phase: "plan", status: "awaiting-resume", execution: "failed" },
  );

  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  assert.equal(state.hosts, 2);
});

test("strict persistence blocks dispatch before host work and before child identity publication", async () => {
  let hosts = 0;
  let runs = 0;
  const createPhaseRuntime = async (input) => {
    hosts += 1;
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => { runs += 1; return { status: "waiting-reply", acceptedEvidence: false, output: "wait", identity: IDENTITY }; },
      reply: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "wait", identity: IDENTITY }),
      abort: async () => undefined,
      dispose: async () => undefined,
    };
  };
  const intentFailure = createCyclePhaseHarness(createPhaseRuntime, [], {
    persistDurableState: async () => { throw new Error("intent write failed"); },
  });
  await intentFailure.commands.get("ima:cycle").handler("start FNR-3036", intentFailure.ctx);
  assert.equal(hosts, 0);
  assert.equal(runs, 0);

  let writes = 0;
  const identityFailure = createCyclePhaseHarness(createPhaseRuntime, [], {
    persistDurableState: async () => {
      writes += 1;
      if (writes === 2) throw new Error("identity write failed");
    },
  });
  await identityFailure.commands.get("ima:cycle").handler("start FNR-3036", identityFailure.ctx);
  assert.equal(hosts, 1);
  assert.equal(runs, 0);
});

test("explicit resume replaces a stale starting dispatch record with one fresh phase host", async () => {
  const initial = createCycleState("FNR-3036", { timestamp: at });
  const approved = reduceCycleState(initial, { artifact: cyclePhaseMarker("plan", "APPROVED"), toolCallId: "plan-tool", timestamp: at }, { timestamp: at });
  assert.equal(approved.ok, true);
  const stale = {
    ...approved.state,
    status: "awaiting-evidence",
    execution: {
      schemaVersion: 1,
      dispatchId: "cycle-stale-dispatch",
      phase: "implementation",
      route: ROUTE,
      parentSessionId: "parent-session",
      status: "starting",
      possiblePartialWrite: true,
      startedAt: at,
      updatedAt: at,
    },
  };
  const state = { hosts: 0 };
  const createPhaseRuntime = async (input) => {
    state.hosts += 1;
    assert.notEqual(input.execution.dispatchId, "cycle-stale-dispatch");
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "need reply", identity: IDENTITY }),
      reply: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "need reply", identity: IDENTITY }),
      abort: async () => undefined,
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime, [
    { type: "custom", customType: "ima-cycle-state", data: stale },
  ]);

  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);

  const finalState = harness.entries.at(-1).data;
  assert.equal(state.hosts, 1);
  assert.equal(finalState.status, "awaiting-evidence");
  assert.equal(finalState.execution.status, "waiting-reply");
});

test("execution-owned planning reconciles an exact settled proof before any host can reopen", async () => {
  const initial = createCycleState("FNR-3036", { timestamp: at });
  const execution = {
    schemaVersion: 1,
    dispatchId: "cycle-plan-dispatch",
    phase: "plan",
    route: ROUTE,
    parentSessionId: "parent-session",
    ...IDENTITY,
    status: "running",
    possiblePartialWrite: false,
    startedAt: at,
    updatedAt: at,
  };
  const retained = { ...initial, execution };
  const proof = {
    schemaVersion: 1,
    project: "ima-pi",
    lifecycleKey: retained.lifecycleKey,
    source: "FNR-3036",
    phase: "plan",
    dispatchId: execution.dispatchId,
    childSessionId: execution.childSessionId,
    actual: { provider: ROUTE.provider, model: ROUTE.model, thinking: ROUTE.thinking },
    artifacts: [{ artifactId: "plan-proof", recordKey: "ima-pi:jira:FNR-3036:plan:proof" }],
  };
  let hosts = 0;
  const createPhaseRuntime = async () => {
    hosts += 1;
    throw new Error("reconciliation must not launch a host");
  };
  const persistedPlan = [
    `artifact\n${cyclePhaseMarker("plan", "APPROVED")}`,
    "<!-- ima-lifecycle verification: lifecycle_key=ima-pi:jira:FNR-3036; nonce=00000000-0000-0000-0000-000000000000; phase=plan; jira_key=FNR-3036; taskwarrior_uuid=; outcome=completed -->",
  ].join("\n");
  const harness = createCyclePhaseHarness(createPhaseRuntime, [
    { type: "custom", customType: "ima-cycle-state", data: retained },
  ], {
    readPhaseSettlement: async () => proof,
    recall: async () => ({ structuredContent: {
      results: [{ id: "plan-proof", recordKey: proof.artifacts[0].recordKey, content: persistedPlan }],
    } }),
  });

  await harness.handlers.get("session_start")({}, harness.ctx);

  const reconciled = harness.entries.at(-1).data;
  assert.equal(hosts, 0);
  assert.deepEqual(
    { phase: reconciled.phase, status: reconciled.status, execution: reconciled.execution.phase },
    { phase: "implementation", status: "awaiting-resume", execution: "plan" },
  );
});

test("explicit resume reopens one validated interrupted phase host instead of launching a duplicate writer", async () => {
  const initial = createCycleState("FNR-3036", { timestamp: at });
  const approved = reduceCycleState(initial, { artifact: cyclePhaseMarker("plan", "APPROVED"), toolCallId: "plan-tool", timestamp: at }, { timestamp: at });
  assert.equal(approved.ok, true);
  const recoveredState = {
    ...approved.state,
    status: "awaiting-evidence",
    execution: {
      schemaVersion: 1,
      dispatchId: "cycle-resume-dispatch",
      phase: "implementation",
      route: ROUTE,
      parentSessionId: "parent-session",
      ...IDENTITY,
      status: "interrupted",
      possiblePartialWrite: true,
      startedAt: at,
      updatedAt: at,
    },
  };
  const state = { hosts: 0, prompts: [] };
  const createPhaseRuntime = async (input) => {
    state.hosts += 1;
    assert.equal(input.execution.dispatchId, "cycle-resume-dispatch");
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async (message) => {
        state.prompts.push(message);
        await input.onLifecycle(cycleLifecycleEvent(input, "implementation", "COMPLETED"));
        return settledResult(input, "implementation", "implementation saved");
      },
      reply: async () => { throw new Error("unexpected reply"); },
      abort: async () => undefined,
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime, [
    { type: "custom", customType: "ima-cycle-state", data: recoveredState },
  ]);

  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);

  const finalState = harness.entries.at(-1).data;
  assert.equal(state.hosts, 1);
  assert.match(state.prompts[0], /resuming after an explicit operator request/);
  assert.deepEqual(
    { phase: finalState.phase, status: finalState.status, execution: finalState.execution.status },
    { phase: "test", status: "awaiting-resume", execution: "settled" },
  );
});

test("cycle persists reply intent before prompting and leaves a failed write retryable", async () => {
  let failNextReplyIntent = false;
  const hostState = { aborts: 0, replies: [] };
  const createPhaseRuntime = async (input) => {
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "need reply", identity: IDENTITY }),
      reply: async (answer) => {
        hostState.replies.push(answer);
        return { status: "waiting-reply", acceptedEvidence: false, output: "still waiting", identity: IDENTITY };
      },
      abort: async () => { hostState.aborts += 1; },
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime, [], {
    persistDurableState: async (_cwd, candidate) => {
      if (failNextReplyIntent && candidate.execution?.status === "running") {
        failNextReplyIntent = false;
        throw new Error("reply intent write failed");
      }
    },
  });

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);
  const waiting = harness.entries.at(-1).data;
  failNextReplyIntent = true;
  await harness.commands.get("ima:cycle").handler("reply first", harness.ctx);

  const afterFailedReply = harness.entries.at(-1).data;
  assert.deepEqual(hostState.replies, []);
  assert.deepEqual(
    {
      phase: afterFailedReply.phase,
      status: afterFailedReply.status,
      evidence: afterFailedReply.evidence,
      dispatchId: afterFailedReply.execution.dispatchId,
      executionStatus: afterFailedReply.execution.status,
    },
    {
      phase: waiting.phase,
      status: waiting.status,
      evidence: waiting.evidence,
      dispatchId: waiting.execution.dispatchId,
      executionStatus: waiting.execution.status,
    },
  );
  assert.ok(harness.notifications.some(({ message }) => message.includes("no reply was sent")));

  await harness.commands.get("ima:cycle").handler("reply retry", harness.ctx);
  assert.deepEqual(hostState.replies, ["retry"]);
  assert.equal(harness.entries.at(-1).data.execution.status, "waiting-reply");

  await harness.commands.get("ima:cycle").handler("stop", harness.ctx);
  assert.equal(hostState.aborts, 1);
});

test("cycle blocks replacement until an active host drain completes", async () => {
  const abortStarted = deferred();
  const releaseAbort = deferred();
  const hostState = { aborts: 0, hosts: 0 };
  const createPhaseRuntime = async (input) => {
    hostState.hosts += 1;
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "wait", identity: IDENTITY }),
      reply: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "wait", identity: IDENTITY }),
      abort: async () => {
        hostState.aborts += 1;
        if (hostState.hosts === 1) {
          abortStarted.resolve();
          await releaseAbort.promise;
        }
      },
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);
  const stopping = harness.commands.get("ima:cycle").handler("stop", harness.ctx);
  await abortStarted.promise;
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  assert.equal(hostState.hosts, 1);

  releaseAbort.resolve();
  await stopping;
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  assert.equal(hostState.hosts, 2);
});

test("cycle retains ownership after a drain failure", async () => {
  const hostState = { aborts: 0, hosts: 0 };
  const createPhaseRuntime = async (input) => {
    hostState.hosts += 1;
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "wait", identity: IDENTITY }),
      reply: async () => ({ status: "waiting-reply", acceptedEvidence: false, output: "wait", identity: IDENTITY }),
      abort: async () => {
        hostState.aborts += 1;
        throw new Error("phase drain failed");
      },
      dispose: async () => undefined,
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);
  await harness.commands.get("ima:cycle").handler("stop", harness.ctx);
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);

  assert.equal(hostState.aborts, 1);
  assert.equal(hostState.hosts, 1);
});

test("cleanup failure blocks successor state and autonomous or manual replacement", async () => {
  const hostState = { disposes: 0, hosts: 0 };
  const createPhaseRuntime = async (input) => {
    hostState.hosts += 1;
    await input.onStarted(IDENTITY);
    return {
      identity: IDENTITY,
      run: async () => {
        await input.onLifecycle(cycleLifecycleEvent(input, "plan", "APPROVED"));
        return settledResult(input, "plan", "plan persisted");
      },
      reply: async () => { throw new Error("unexpected reply"); },
      abort: async () => undefined,
      dispose: async () => {
        hostState.disposes += 1;
        throw new Error("phase_cleanup_failed");
      },
    };
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime);

  await harness.commands.get("ima:cycle").handler("start --mode autonomous FNR-3036", harness.ctx);

  const blocked = harness.entries.at(-1).data;
  assert.equal(hostState.hosts, 1);
  assert.equal(hostState.disposes, 1);
  assert.deepEqual(
    { phase: blocked.phase, status: blocked.status, evidence: blocked.evidence.length, execution: blocked.execution.status },
    { phase: "plan", status: "awaiting-resume", evidence: 0, execution: "failed" },
  );
  assert.ok(harness.notifications.some(({ message }) => message.includes("cleanup is unsettled")));

  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);
  await harness.commands.get("ima:cycle").handler("start FNR-3036", harness.ctx);
  assert.equal(hostState.hosts, 1);
});

test("execution-owned planning never enters manual adoption without settlement proof", async () => {
  const initial = createCycleState(planeSource, { lifecycleKey: planLifecycleKey, timestamp: at });
  const retained = {
    ...initial,
    status: "awaiting-resume",
    execution: {
      schemaVersion: 1,
      dispatchId: "cycle-plan-dispatch",
      phase: "plan",
      route: ROUTE,
      parentSessionId: "parent-session",
      ...IDENTITY,
      status: "failed",
      possiblePartialWrite: false,
      startedAt: at,
      updatedAt: at,
    },
  };
  let adoptionAttempts = 0;
  const repeatedStart = await coordinateCycleStart({
    source: planeSource,
    activeState: retained,
    cwd: "/cycle-parent",
    context: async () => ({ status: "ready" }),
    adoptPlan: async () => {
      adoptionAttempts += 1;
      return { kind: "no-plan" };
    },
    applyRoute: async () => ({ ok: true }),
    appendState: async () => undefined,
    sendUserMessage: async (_message, provisional) => provisional,
  });
  assert.equal(repeatedStart.ok, false);
  if (!repeatedStart.ok) assert.equal(repeatedStart.error.code, "cycle_active_replacement_blocked");
  assert.equal(adoptionAttempts, 0);

  const hostState = { hosts: 0 };
  const createPhaseRuntime = async () => {
    hostState.hosts += 1;
    throw new Error("execution-owned plan must not dispatch without settlement proof");
  };
  const harness = createCyclePhaseHarness(createPhaseRuntime, [], {
    loadDurableState: async () => retained,
    recall: async () => ({ structuredContent: recallPayload([planRecord()]) }),
  });

  await harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("ima:cycle").handler("start plane:ima:SKYNET-189", harness.ctx);
  await harness.commands.get("ima:cycle").handler("status", harness.ctx);
  await harness.commands.get("ima:cycle").handler("resume", harness.ctx);

  assert.equal(hostState.hosts, 0);
  assert.equal(harness.entries.some(({ data }) => data.phase === "implementation"), false);
});
