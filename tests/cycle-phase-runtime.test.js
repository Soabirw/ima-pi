import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CYCLE_PHASE_SETTLEMENT_ENTRY, createCyclePhaseSettlement } from "../lib/ima-cycle-phase.ts";
import {
  CYCLE_PHASE_CONTEXT_ENTRY,
  createCyclePhaseRuntime,
  cyclePhaseResourceLoaderOptions,
  readCyclePhaseSettlement,
} from "../lib/ima-cycle-phase-runtime.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "/isolated/project";
const ROUTE = Object.freeze({
  provider: "test-provider",
  model: "test-model",
  thinking: "high",
  profile: "cycle-profile",
  source: "command",
});
const CONTEXT = Object.freeze({
  schemaVersion: 1,
  project: "ima-pi",
  lifecycleKey: "ima-pi:jira:SKYNET-192",
  source: "jira:SKYNET-192",
  phase: "test",
  dispatchId: "cycle-test-dispatch",
});
const IDENTITY = Object.freeze({
  childSessionId: "child-session",
  childSessionFile: "/isolated/sessions/child-session.jsonl",
  childSessionDir: "/isolated/sessions",
});
const ACTIVE_TOOLS = Object.freeze([
  "ima_context",
  "ima_lifecycle",
  "ima_delegate",
  "ima_agent_follow_up",
  "mcp",
  "ima_corpus_status",
  "ima_corpus_store",
  "ima_corpus_find",
  "ima_corpus_recall",
  "ima_corpus_get",
]);
const ACCEPTANCE = Object.freeze({
  artifactId: "artifact-test",
  recordKey: "ima-pi:jira:SKYNET-192:test:artifact-test",
});
const CYCLE_EXTENSION = resolve(new URL("../extensions/cycle.ts", import.meta.url).pathname);
const RETAINED_EXTENSION = resolve(new URL("./fixtures/retained-extension.ts", import.meta.url).pathname);
const NEARBY_EXTENSION = `${CYCLE_EXTENSION}.backup`;

const phaseExecution = (overrides = {}) => ({
  schemaVersion: 1,
  dispatchId: CONTEXT.dispatchId,
  phase: CONTEXT.phase,
  route: ROUTE,
  parentSessionId: "parent-session",
  status: "starting",
  possiblePartialWrite: true,
  startedAt: "2026-08-04T18:00:00.000Z",
  updatedAt: "2026-08-04T18:00:00.000Z",
  ...overrides,
});
const terminalAssistant = (output) => [{
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: output }],
}];
const deferred = () => {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
};
const lifecycleEvent = (toolCallId, input, result = { content: [], details: {}, isError: false }) => [
  { type: "tool_execution_start", toolName: "ima_lifecycle", toolCallId, args: input },
  {
    type: "tool_execution_end",
    toolName: "ima_lifecycle",
    toolCallId,
    result: { content: result.content, details: result.details },
    isError: result.isError,
  },
];

const createPhaseRuntimeHarness = (options = {}) => {
  const state = {
    bindings: [],
    entries: [],
    managerSessionId: options.managerSessionId ?? IDENTITY.childSessionId,
    managerSessionFile: options.managerSessionFile ?? IDENTITY.childSessionFile,
    managerSessionDir: options.managerSessionDir ?? IDENTITY.childSessionDir,
    modelRequests: [],
    prompts: [],
    runtimeDisposes: 0,
    sessionAborts: 0,
    waits: 0,
    unsubscribes: 0,
  };
  const listeners = new Set();
  const manager = {
    appendCustomEntry: (customType, data) => {
      if (customType === CYCLE_PHASE_SETTLEMENT_ENTRY && options.settlementAppendFails) throw new Error("settlement_write_failed");
      state.entries.push({ type: "custom", customType, data });
    },
    getBranch: () => state.entries,
    getCwd: () => PROJECT,
    getHeader: () => ({ id: state.managerSessionId, cwd: PROJECT }),
    getSessionId: () => state.managerSessionId,
    getSessionFile: () => state.managerSessionFile,
    getSessionDir: () => state.managerSessionDir,
  };
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const session = {
    messages: options.messages ?? [],
    model: options.sessionModel ?? { provider: ROUTE.provider, id: ROUTE.model },
    thinkingLevel: options.sessionThinking ?? ROUTE.thinking,
    sessionId: options.sessionId ?? IDENTITY.childSessionId,
    sessionFile: options.sessionFile ?? IDENTITY.childSessionFile,
    getActiveToolNames: () => options.activeTools ?? ACTIVE_TOOLS,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        state.unsubscribes += 1;
      };
    },
    bindExtensions: async (binding) => { state.bindings.push(binding); },
    prompt: async (message, promptOptions) => {
      state.prompts.push({ message, promptOptions });
      try {
        await options.onBeforeAgentStart?.({ emit, message, promptOptions, session, state });
      } catch (error) {
        promptOptions.preflightResult?.(false);
        throw error;
      }
      promptOptions.preflightResult?.(true);
      await options.onPrompt?.({ emit, message, promptOptions, session, state });
    },
    waitForIdle: async () => {
      state.waits += 1;
      await options.onWaitForIdle?.({ emit, session, state });
    },
    abort: async () => {
      state.sessionAborts += 1;
      await options.onAbort?.({ emit, session, state });
    },
  };
  const modelRuntime = {
    getModel: (provider, model) => {
      state.modelRequests.push({ provider, model });
      if (options.modelAvailable === false) return undefined;
      return options.resolvedModel ?? { provider, id: model };
    },
  };
  const dependencies = {
    createManager: (cwd) => {
      state.managerCwd = cwd;
      return manager;
    },
    createSettings: (cwd, agentDir, projectTrusted) => {
      state.settings = { cwd, agentDir, projectTrusted };
      return { kind: "fake-settings" };
    },
    createServices: async (input) => {
      state.serviceInput = input;
      state.filteredResources = input.resourceLoaderOptions.extensionsOverride({
        extensions: [
          { name: "cycle", resolvedPath: CYCLE_EXTENSION },
          { name: "retained", resolvedPath: RETAINED_EXTENSION },
          { name: "nearby", resolvedPath: NEARBY_EXTENSION },
        ],
        marker: "preserved",
      });
      return { modelRuntime: input.modelRuntime, diagnostics: [] };
    },
    createSession: async (input) => {
      state.createSessionInput = {
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        sessionManager: input.sessionManager,
      };
      return { session };
    },
    createRuntime: async (factory, input) => {
      state.runtimeInput = input;
      const created = await factory({ ...input, sessionStartEvent: { type: "session_start" } });
      state.runtimeCreated = created;
      return {
        session: created.session,
        dispose: async () => { state.runtimeDisposes += 1; },
      };
    },
  };
  return { dependencies, manager, modelRuntime, session, state };
};

const phaseRuntimeInput = (harness, overrides = {}) => ({
  cwd: PROJECT,
  route: ROUTE,
  execution: phaseExecution(),
  context: CONTEXT,
  projectTrusted: true,
  modelRuntime: harness.modelRuntime,
  dependencies: harness.dependencies,
  ...overrides,
});

test("seeds an isolated phase session, filters only the cycle extension, verifies its toolkit, and uses the configured route", async () => {
  const harness = createPhaseRuntimeHarness();
  const started = [];
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness, {
    onStarted: (identity) => { started.push(identity); },
  }));

  assert.equal(harness.state.managerCwd, PROJECT);
  assert.deepEqual(harness.state.entries, [
    { type: "custom", customType: "ima-profile-state", data: { profile: ROUTE.profile } },
    { type: "custom", customType: CYCLE_PHASE_CONTEXT_ENTRY, data: CONTEXT },
  ]);
  assert.deepEqual(harness.state.filteredResources, {
    extensions: [
      { name: "retained", resolvedPath: RETAINED_EXTENSION },
      { name: "nearby", resolvedPath: NEARBY_EXTENSION },
    ],
    marker: "preserved",
  });
  assert.deepEqual(harness.state.serviceInput.resourceLoaderOptions.additionalExtensionPaths, [PACKAGE_ROOT]);
  assert.equal(harness.state.serviceInput.resourceLoaderOptions.noExtensions, true);
  assert.equal(harness.state.serviceInput.resourceLoaderOptions.noSkills, true);
  assert.equal(harness.state.serviceInput.resourceLoaderOptions.noPromptTemplates, true);
  assert.equal(harness.state.serviceInput.resourceLoaderOptions.noThemes, true);
  assert.deepEqual(harness.state.modelRequests, [{ provider: ROUTE.provider, model: ROUTE.model }]);
  assert.deepEqual(harness.state.createSessionInput.model, { provider: ROUTE.provider, id: ROUTE.model });
  assert.equal(harness.state.createSessionInput.thinkingLevel, ROUTE.thinking);
  assert.deepEqual(started, [IDENTITY]);
  assert.deepEqual(host.identity, IDENTITY);

  await host.dispose();
  assert.equal(harness.state.runtimeDisposes, 1);
  assert.equal(harness.state.unsubscribes, 1);
});

test("isolated phase resources use the active package when configured package resources are stale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-cycle-phase-resources-"));
  const agentDir = join(directory, "agent");
  const projectDir = join(directory, "project");
  const stalePackage = join(directory, "stale-ima-pi");

  try {
    await mkdir(join(stalePackage, "extensions"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(stalePackage, "package.json"), JSON.stringify({
      name: "stale-ima-pi",
      type: "module",
      pi: { extensions: ["./extensions"] },
    }));
    await writeFile(join(stalePackage, "extensions", "agents.ts"), `
      export default function (pi) {
        pi.registerTool({ name: "ima_delegate", description: "stale", parameters: {}, execute: async () => ({ content: [] }) });
      }
    `);
    await writeFile(join(stalePackage, "extensions", "cycle.ts"), `
      export default function (pi) {
        pi.registerCommand("ima:cycle", { description: "stale", handler: async () => {} });
      }
    `);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [stalePackage] }));

    const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd: projectDir,
      agentDir,
      settingsManager,
      ...cyclePhaseResourceLoaderOptions(),
    });
    await loader.reload();

    const result = loader.getExtensions();
    const loadedPaths = result.extensions.map((extension) => resolve(extension.resolvedPath));
    const activeTools = new Set(result.extensions.flatMap((extension) => [...extension.tools.keys()]));

    assert.deepEqual(result.errors, []);
    assert.equal(loadedPaths.some((path) => path.startsWith(stalePackage)), false);
    assert.equal(loadedPaths.some((path) => path.endsWith(join("extensions", "cycle.ts"))), false);
    for (const toolName of ACTIVE_TOOLS) {
      assert.equal(activeTools.has(toolName), true, toolName);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed before prompting for missing toolkit or initial identity drift", async () => {
  const cases = [
    {
      name: "provider or model mismatch",
      harness: { sessionModel: { provider: "other-provider", id: ROUTE.model } },
      error: "phase_runtime_identity_mismatch",
    },
    {
      name: "thinking mismatch",
      harness: { sessionThinking: "low" },
      error: "phase_thinking_unsupported",
    },
    {
      name: "child session mismatch",
      harness: { sessionId: "other-child-session" },
      execution: phaseExecution({ childSessionId: IDENTITY.childSessionId }),
      error: "phase_session_identity_mismatch",
    },
    {
      name: "missing lifecycle toolkit capability",
      harness: { activeTools: ACTIVE_TOOLS.filter((name) => name !== "ima_lifecycle") },
      error: "phase_toolkit_missing",
    },
  ];

  for (const scenario of cases) {
    const harness = createPhaseRuntimeHarness(scenario.harness);
    let started = 0;
    await assert.rejects(
      createCyclePhaseRuntime(phaseRuntimeInput(harness, {
        execution: scenario.execution ?? phaseExecution(),
        onStarted: () => { started += 1; },
      })),
      new RegExp(scenario.error),
      scenario.name,
    );
    assert.equal(started, 0, scenario.name);
    assert.equal(harness.state.prompts.length, 0, scenario.name);
    assert.equal(harness.state.runtimeDisposes, 1, scenario.name);
    assert.equal(harness.state.unsubscribes, 1, scenario.name);
  }
});

test("disposes an unprompted host when strict child-identity publication rejects", async () => {
  const harness = createPhaseRuntimeHarness();
  await assert.rejects(
    createCyclePhaseRuntime(phaseRuntimeInput(harness, {
      onStarted: async () => { throw new Error("durable identity write failed"); },
    })),
    /durable identity write failed/,
  );
  assert.equal(harness.state.prompts.length, 0);
  assert.equal(harness.state.runtimeDisposes, 1);
  assert.equal(harness.state.unsubscribes, 1);
});

test("correlates native lifecycle start and end events, awaits validation, and persists one success proof", async () => {
  const accepted = deferred();
  const terminalReached = deferred();
  const lifecycleEvents = [];
  const lifecycleInput = { type: "test", identity: { lifecycleKey: CONTEXT.lifecycleKey } };
  const lifecycleContent = [{ type: "text", text: "persisted" }];
  const lifecycleDetails = { artifactId: ACCEPTANCE.artifactId, recordKey: ACCEPTANCE.recordKey };
  const harness = createPhaseRuntimeHarness({
    onPrompt: ({ emit }) => {
      for (const event of lifecycleEvent("lifecycle-tool-1", lifecycleInput, {
        content: lifecycleContent,
        details: lifecycleDetails,
        isError: false,
      })) emit(event);
    },
    onWaitForIdle: ({ session }) => {
      session.messages = terminalAssistant("Lifecycle evidence accepted.");
      terminalReached.resolve();
    },
  });
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness, {
    onLifecycle: async (event) => {
      lifecycleEvents.push(event);
      return accepted.promise;
    },
  }));

  const resultPromise = host.run("Persist the test lifecycle result.");
  await terminalReached.promise;
  let completed = false;
  void resultPromise.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(lifecycleEvents, [{
    toolCallId: "lifecycle-tool-1",
    input: lifecycleInput,
    result: { content: lifecycleContent, details: lifecycleDetails, isError: false },
  }]);

  accepted.resolve(ACCEPTANCE);
  const result = await resultPromise;
  assert.equal(result.status, "settled");
  assert.equal(result.acceptedEvidence, true);
  assert.equal(result.output, "Lifecycle evidence accepted.");
  assert.deepEqual(result.identity, IDENTITY);
  assert.deepEqual(result.settlement?.artifacts, [ACCEPTANCE]);
  assert.equal(result.settlement?.dispatchId, CONTEXT.dispatchId);
  assert.equal(result.settlement?.actual.provider, ROUTE.provider);
  assert.deepEqual(
    harness.state.entries.at(-1),
    { type: "custom", customType: CYCLE_PHASE_SETTLEMENT_ENTRY, data: result.settlement },
  );

  await host.dispose();
  assert.equal(harness.state.runtimeDisposes, 1);
});

test("ignores unmatched native lifecycle ends and rejects duplicate accepted lifecycle results", async () => {
  const harness = createPhaseRuntimeHarness({
    onPrompt: ({ emit }) => {
      emit({ type: "tool_execution_end", toolName: "ima_lifecycle", toolCallId: "missing-start", result: { content: [], details: {} }, isError: false });
      for (const event of lifecycleEvent("first", { type: "test" })) emit(event);
      for (const event of lifecycleEvent("second", { type: "test" })) emit(event);
    },
    onWaitForIdle: ({ session }) => { session.messages = terminalAssistant("Two records."); },
  });
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness, { onLifecycle: () => ACCEPTANCE }));

  const result = await host.run("Persist only one lifecycle result.");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "phase_lifecycle_ambiguous");
  assert.equal(result.acceptedEvidence, false);
  assert.equal(harness.state.entries.some((entry) => entry.customType === CYCLE_PHASE_SETTLEMENT_ENTRY), false);
  await host.abort();
});

test("keeps a no-evidence terminal host replyable, marks coordinator prompts as extension input, and accepts a literal reply", async () => {
  const initialPrompt = "The phase needs an operator answer.";
  const literalReply = "/ima:implement must remain literal";
  const harness = createPhaseRuntimeHarness({
    onPrompt: ({ emit, message, session }) => {
      if (message === initialPrompt) {
        session.messages = terminalAssistant("Please provide the approved evidence reference.");
        return;
      }
      session.messages = terminalAssistant("The lifecycle result is now accepted.");
      for (const event of lifecycleEvent("lifecycle-tool-2", { type: "test" })) emit(event);
    },
  });
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness, { onLifecycle: () => ACCEPTANCE }));

  const waiting = await host.run(initialPrompt);
  assert.equal(waiting.status, "waiting-reply");
  assert.equal(waiting.acceptedEvidence, false);
  assert.equal(waiting.output, "Please provide the approved evidence reference.");
  assert.equal(harness.state.runtimeDisposes, 0);

  const settled = await host.reply(literalReply);
  assert.equal(settled.status, "settled");
  assert.equal(settled.acceptedEvidence, true);
  assert.deepEqual(
    harness.state.prompts.map(({ message, promptOptions }) => ({
      message,
      promptOptions: {
        expandPromptTemplates: promptOptions.expandPromptTemplates,
        source: promptOptions.source,
      },
    })),
    [
      { message: initialPrompt, promptOptions: { expandPromptTemplates: false, source: "extension" } },
      { message: literalReply, promptOptions: { expandPromptTemplates: false, source: "extension" } },
    ],
  );
  assert.ok(harness.state.prompts.every(({ promptOptions }) => typeof promptOptions.preflightResult === "function"));

  await host.dispose();
  assert.equal(harness.state.runtimeDisposes, 1);
  assert.equal(harness.state.unsubscribes, 1);
});

test("fails closed on route drift or settlement persistence failure without creating a proof", async () => {
  const drift = createPhaseRuntimeHarness({
    onPrompt: ({ emit, session }) => {
      for (const event of lifecycleEvent("drift", { type: "test" })) emit(event);
      session.model = { provider: "other", id: ROUTE.model };
    },
    onWaitForIdle: ({ session }) => { session.messages = terminalAssistant("Route changed."); },
  });
  const driftHost = await createCyclePhaseRuntime(phaseRuntimeInput(drift, { onLifecycle: () => ACCEPTANCE }));
  const driftResult = await driftHost.run("Do not accept model drift.");
  assert.equal(driftResult.status, "failed");
  assert.equal(driftResult.error, "phase_runtime_identity_mismatch");
  assert.equal(drift.state.entries.some((entry) => entry.customType === CYCLE_PHASE_SETTLEMENT_ENTRY), false);
  await driftHost.abort();

  const persistence = createPhaseRuntimeHarness({
    settlementAppendFails: true,
    onPrompt: ({ emit }) => {
      for (const event of lifecycleEvent("persist", { type: "test" })) emit(event);
    },
    onWaitForIdle: ({ session }) => { session.messages = terminalAssistant("Persist proof."); },
  });
  const persistenceHost = await createCyclePhaseRuntime(phaseRuntimeInput(persistence, { onLifecycle: () => ACCEPTANCE }));
  const persistenceResult = await persistenceHost.run("Persist the success proof.");
  assert.equal(persistenceResult.status, "failed");
  assert.equal(persistenceResult.error, "phase_settlement_persist_failed");
  assert.equal(persistence.state.entries.some((entry) => entry.customType === CYCLE_PHASE_SETTLEMENT_ENTRY), false);
  await persistenceHost.abort();
});

test("refuses a drifted waiting host before sending its literal reply", async () => {
  const initial = "Need an answer.";
  const harness = createPhaseRuntimeHarness({
    onPrompt: ({ message, session }) => {
      session.messages = terminalAssistant(message === initial ? "Waiting." : "Unexpected reply.");
    },
  });
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness));

  const waiting = await host.run(initial);
  assert.equal(waiting.status, "waiting-reply");
  harness.session.model = { provider: "other-provider", id: ROUTE.model };
  const drifted = await host.reply("literal reply");
  assert.equal(drifted.status, "failed");
  assert.equal(drifted.error, "phase_runtime_identity_mismatch");
  assert.deepEqual(harness.state.prompts.map(({ message }) => message), [initial]);
  await host.abort();
});

test("reads only an exact settlement from a contained matching phase session", async () => {
  const execution = phaseExecution({ ...IDENTITY, status: "interrupted" });
  const settlement = createCyclePhaseSettlement({
    project: CONTEXT.project,
    lifecycleKey: CONTEXT.lifecycleKey,
    source: CONTEXT.source,
    phase: CONTEXT.phase,
    dispatchId: CONTEXT.dispatchId,
    childSessionId: IDENTITY.childSessionId,
    actual: { provider: ROUTE.provider, model: ROUTE.model, thinking: ROUTE.thinking },
    artifacts: [ACCEPTANCE],
  });
  assert.ok(settlement);
  const manager = (data) => ({
    getCwd: () => PROJECT,
    getSessionId: () => IDENTITY.childSessionId,
    getSessionFile: () => IDENTITY.childSessionFile,
    getSessionDir: () => IDENTITY.childSessionDir,
    getHeader: () => ({ id: IDENTITY.childSessionId, cwd: PROJECT }),
    getBranch: () => [
      { type: "custom", customType: CYCLE_PHASE_CONTEXT_ENTRY, data: CONTEXT },
      { type: "custom", customType: CYCLE_PHASE_SETTLEMENT_ENTRY, data },
    ],
  });
  const dependencies = {
    stat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    canonical: async (path) => path,
    openManager: (_file, _directory) => manager(settlement),
  };
  assert.deepEqual(
    await readCyclePhaseSettlement({ cwd: PROJECT, execution, context: CONTEXT, dependencies }),
    settlement,
  );
  assert.equal(
    await readCyclePhaseSettlement({
      cwd: PROJECT,
      execution,
      context: CONTEXT,
      dependencies: { ...dependencies, openManager: () => manager({ ...settlement, dispatchId: "other" }) },
    }),
    null,
  );
});

test("aborts, drains, and disposes an active phase host exactly once", async () => {
  const harness = createPhaseRuntimeHarness();
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness));

  await Promise.all([host.abort(), host.abort()]);
  assert.equal(harness.state.sessionAborts, 1);
  assert.equal(harness.state.waits, 1);
  assert.equal(harness.state.runtimeDisposes, 1);
  assert.equal(harness.state.unsubscribes, 1);

  const result = await host.run("This must not prompt a disposed session.");
  assert.deepEqual(result, {
    status: "aborted",
    acceptedEvidence: false,
    output: "",
    identity: IDENTITY,
    error: "phase_session_disposed",
  });
  assert.equal(harness.state.prompts.length, 0);
});

test("preflight cancellation prevents native agent work before runtime release", async () => {
  const preflightStarted = deferred();
  const releasePreflight = deferred();
  const harness = createPhaseRuntimeHarness({
    onBeforeAgentStart: async () => {
      preflightStarted.resolve();
      await releasePreflight.promise;
    },
    onPrompt: ({ state }) => {
      state.agentWork = (state.agentWork ?? 0) + 1;
    },
  });
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness));

  const invocation = host.run("Wait for preflight cancellation.");
  await preflightStarted.promise;
  let drained = false;
  const abort = Promise.all([host.abort(), host.abort()]).then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(harness.state.runtimeDisposes, 0);

  releasePreflight.resolve();
  const result = await invocation;
  await abort;
  assert.equal(result.status, "aborted");
  assert.equal(harness.state.agentWork ?? 0, 0);
  assert.equal(harness.state.sessionAborts, 1);
  assert.equal(harness.state.runtimeDisposes, 1);
});

test("drains lifecycle validation before disposing a cancelled invocation", async () => {
  const validationStarted = deferred();
  const releaseValidation = deferred();
  const harness = createPhaseRuntimeHarness({
    onPrompt: ({ emit, session }) => {
      for (const event of lifecycleEvent("cancelled-validation", { type: "test" })) emit(event);
      session.messages = terminalAssistant("Validation is pending.");
    },
  });
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness, {
    onLifecycle: () => {
      validationStarted.resolve();
      return releaseValidation.promise;
    },
  }));

  const invocation = host.run("Wait for lifecycle validation.");
  await validationStarted.promise;
  let drained = false;
  const abort = host.abort().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(harness.state.runtimeDisposes, 0);

  releaseValidation.resolve(ACCEPTANCE);
  const result = await invocation;
  await abort;
  assert.equal(result.status, "aborted");
  assert.equal(harness.state.entries.some((entry) => entry.customType === CYCLE_PHASE_SETTLEMENT_ENTRY), false);
  assert.equal(harness.state.runtimeDisposes, 1);
});

test("drains lifecycle validation after a thrown prompt before releasing cleanup", async () => {
  const validationStarted = deferred();
  const releaseValidation = deferred();
  const harness = createPhaseRuntimeHarness({
    onPrompt: ({ emit }) => {
      for (const event of lifecycleEvent("thrown-prompt", { type: "test" })) emit(event);
      throw new Error("phase_prompt_failed");
    },
  });
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness, {
    onLifecycle: () => {
      validationStarted.resolve();
      return releaseValidation.promise;
    },
  }));

  const invocation = host.run("Wait for thrown prompt validation.");
  await validationStarted.promise;
  let drained = false;
  const abort = host.abort().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(harness.state.runtimeDisposes, 0);

  releaseValidation.resolve(ACCEPTANCE);
  const result = await invocation;
  await abort;
  assert.equal(result.status, "aborted");
  assert.equal(harness.state.entries.some((entry) => entry.customType === CYCLE_PHASE_SETTLEMENT_ENTRY), false);
  assert.equal(harness.state.runtimeDisposes, 1);
});

test("drains lifecycle validation after idle failure before reporting failure", async () => {
  const validationStarted = deferred();
  const releaseValidation = deferred();
  const harness = createPhaseRuntimeHarness({
    onPrompt: ({ emit }) => {
      for (const event of lifecycleEvent("idle-failure", { type: "test" })) emit(event);
    },
    onWaitForIdle: ({ state }) => {
      if (state.waits === 1) throw new Error("phase_idle_failed");
    },
  });
  const host = await createCyclePhaseRuntime(phaseRuntimeInput(harness, {
    onLifecycle: () => {
      validationStarted.resolve();
      return releaseValidation.promise;
    },
  }));

  const invocation = host.run("Wait for idle failure validation.");
  await validationStarted.promise;
  let completed = false;
  void invocation.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);

  releaseValidation.resolve(ACCEPTANCE);
  const result = await invocation;
  assert.equal(result.status, "failed");
  assert.equal(result.error, "phase_idle_failed");
  assert.equal(harness.state.entries.some((entry) => entry.customType === CYCLE_PHASE_SETTLEMENT_ENTRY), false);
  await host.abort();
});

test("observes live child and manager identity before prompts and settlement", async () => {
  const waiting = createPhaseRuntimeHarness({
    onPrompt: ({ message, session }) => {
      session.messages = terminalAssistant(message === "Need a reply." ? "Waiting." : "Unexpected reply.");
    },
  });
  const waitingHost = await createCyclePhaseRuntime(phaseRuntimeInput(waiting));
  await waitingHost.run("Need a reply.");
  waiting.session.sessionId = "drifted-child-session";
  const reply = await waitingHost.reply("Do not prompt after identity drift.");
  assert.equal(reply.status, "failed");
  assert.equal(reply.error, "phase_session_identity_mismatch");
  assert.deepEqual(waiting.state.prompts.map(({ message }) => message), ["Need a reply."]);
  await waitingHost.abort();

  const terminal = createPhaseRuntimeHarness({
    onPrompt: ({ emit, session, state }) => {
      for (const event of lifecycleEvent("terminal-drift", { type: "test" })) emit(event);
      state.managerSessionFile = "/isolated/sessions/other-child.jsonl";
      session.messages = terminalAssistant("Identity changed.");
    },
  });
  const terminalHost = await createCyclePhaseRuntime(phaseRuntimeInput(terminal, { onLifecycle: () => ACCEPTANCE }));
  const terminalResult = await terminalHost.run("Do not settle after manager file drift.");
  assert.equal(terminalResult.status, "failed");
  assert.equal(terminalResult.error, "phase_session_identity_mismatch");
  assert.equal(terminal.state.entries.some((entry) => entry.customType === CYCLE_PHASE_SETTLEMENT_ENTRY), false);
  await terminalHost.abort();

  const resumed = createPhaseRuntimeHarness({
    managerSessionFile: "/isolated/sessions/other-child.jsonl",
  });
  resumed.state.entries.push({ type: "custom", customType: CYCLE_PHASE_CONTEXT_ENTRY, data: CONTEXT });
  resumed.dependencies.stat = async () => ({ isFile: () => true, isSymbolicLink: () => false });
  resumed.dependencies.canonical = async (path) => path;
  resumed.dependencies.openManager = () => resumed.manager;
  await assert.rejects(
    createCyclePhaseRuntime(phaseRuntimeInput(resumed, {
      execution: phaseExecution({ ...IDENTITY, status: "interrupted" }),
    })),
    /phase_session_identity_mismatch/,
  );
  assert.equal(resumed.state.prompts.length, 0);
});
