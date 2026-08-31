import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantEntry,
  commandContext,
  createFakeEngine,
  createHarness,
  deferred,
  flushPromises,
  loadedConfig,
  SPEAK_COMPLETE,
  SPEAK_STARTING,
  textPart,
} from "./tts-command-fixtures.js";

test("speaks one latest completed response per idle TUI settlement when opted in", async () => {
  const engineState = createFakeEngine();
  const harness = createHarness({
    config: loadedConfig({
      autoSpeak: true,
      model: "custom-tts-model",
      voice: "nova",
      playerCommand: "cvlc",
    }),
    engineState,
  });
  const { ctx, notifications } = commandContext({
    entries: [
      assistantEntry([textPart("Earlier response")]),
      assistantEntry([textPart("Automatically speak this")]),
    ],
    calls: harness.calls,
  });

  await harness.handlers.get("agent_settled")({}, ctx);
  await flushPromises();

  assert.deepEqual(engineState.calls.speak, [{
    text: "Automatically speak this",
    apiKey: "test-api-key",
    model: "custom-tts-model",
    voice: "nova",
    playerCommand: "cvlc",
  }]);
  assert.deepEqual(notifications, [
    { message: SPEAK_STARTING, type: "info" },
    { message: SPEAK_COMPLETE, type: "info" },
  ]);
});

test("does not speak settled responses unless autoSpeak is enabled", async () => {
  const harness = createHarness();
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Do not speak this")])],
    calls: harness.calls,
  });

  await harness.handlers.get("agent_settled")({}, ctx);

  assert.deepEqual(notifications, []);
  assert.deepEqual(
    {
      getApiKey: harness.calls.getApiKey,
      hasPlayer: harness.calls.hasPlayer,
      getBranch: harness.calls.getBranch,
      speech: harness.engineState.calls.speak.length,
    },
    { getApiKey: 0, hasPlayer: 0, getBranch: 0, speech: 0 },
  );
});

test("does not speak settled responses when TTS is disabled", async () => {
  const harness = createHarness({
    config: loadedConfig({ enable: false, autoSpeak: true }),
  });
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Do not speak this")])],
    calls: harness.calls,
  });

  await harness.handlers.get("agent_settled")({}, ctx);

  assert.deepEqual(notifications, []);
  assert.equal(harness.calls.getApiKey, 0);
  assert.equal(harness.calls.hasPlayer, 0);
  assert.equal(harness.calls.getBranch, 0);
  assert.equal(harness.engineState.calls.speak.length, 0);
});

test("keeps noninteractive or UI-less settlement handlers silent before effects", async () => {
  for (const [mode, hasUI] of [
    ["print", false],
    ["json", false],
    ["rpc", true],
    ["tui", false],
  ]) {
    const harness = createHarness({ config: loadedConfig({ autoSpeak: true }) });
    const { ctx, notifications } = commandContext({
      mode,
      hasUI,
      entries: [assistantEntry([textPart("Do not speak this")])],
      calls: harness.calls,
    });

    await harness.handlers.get("agent_settled")({}, ctx);

    assert.deepEqual(notifications, [], `${mode}/${hasUI}`);
    assert.deepEqual(
      {
        loadConfig: harness.calls.loadConfig,
        getApiKey: harness.calls.getApiKey,
        hasPlayer: harness.calls.hasPlayer,
        getBranch: harness.calls.getBranch,
        speech: harness.engineState.calls.speak.length,
      },
      { loadConfig: 0, getApiKey: 0, hasPlayer: 0, getBranch: 0, speech: 0 },
      `${mode}/${hasUI}`,
    );
  }
});

test("does not speak a settlement after another run starts", async () => {
  const harness = createHarness({ config: loadedConfig({ autoSpeak: true }) });
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Do not speak this")])],
    isIdle: () => false,
    calls: harness.calls,
  });

  await harness.handlers.get("agent_settled")({}, ctx);

  assert.deepEqual(notifications, []);
  assert.equal(harness.calls.loadConfig, 0);
  assert.equal(harness.calls.getApiKey, 0);
  assert.equal(harness.calls.hasPlayer, 0);
  assert.equal(harness.calls.getBranch, 0);
  assert.equal(harness.engineState.calls.speak.length, 0);
});

test("silently skips automatic speech without readiness or a completed response", async (t) => {
  await t.test("when a resource is unavailable", async () => {
    const harness = createHarness({
      config: loadedConfig({ autoSpeak: true }),
      apiKey: undefined,
      playerResolved: false,
    });
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    await harness.handlers.get("agent_settled")({}, ctx);

    assert.deepEqual(notifications, []);
    assert.equal(harness.calls.getBranch, 0);
    assert.equal(harness.engineState.calls.speak.length, 0);
  });

  await t.test("when no completed assistant response exists", async () => {
    const harness = createHarness({ config: loadedConfig({ autoSpeak: true }) });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Interrupted")], "aborted")],
      calls: harness.calls,
    });

    await harness.handlers.get("agent_settled")({}, ctx);

    assert.deepEqual(notifications, []);
    assert.equal(harness.calls.getBranch, 1);
    assert.equal(harness.engineState.calls.speak.length, 0);
  });
});

test("does not replay an older completed response for an aborted settlement", async () => {
  const harness = createHarness({ config: loadedConfig({ autoSpeak: true }) });
  const { ctx, notifications } = commandContext({
    entries: [
      assistantEntry([textPart("Earlier completed response")]),
      assistantEntry([textPart("Newer aborted response")], "aborted"),
    ],
    calls: harness.calls,
  });

  await harness.handlers.get("agent_settled")({}, ctx);

  assert.equal(harness.engineState.calls.speak.length, 0);
  assert.deepEqual(notifications, []);
});

test("does not start automatic speech when the session becomes busy during readiness", async () => {
  const pendingApiKey = deferred();
  let idle = true;
  const harness = createHarness({
    config: loadedConfig({ autoSpeak: true }),
    getOpenAiApiKey: () => pendingApiKey.promise,
  });
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Do not speak this busy response")])],
    isIdle: () => idle,
    calls: harness.calls,
  });

  const settling = harness.handlers.get("agent_settled")({}, ctx);
  await flushPromises();
  assert.equal(harness.calls.getApiKey, 1);

  idle = false;
  pendingApiKey.resolve("test-api-key");
  await settling;

  assert.equal(harness.calls.getBranch, 0);
  assert.equal(harness.engineState.calls.speak.length, 0);
  assert.deepEqual(notifications, []);
});

test("does not start automatic speech after the next prompt arrives during setup", async () => {
  const pendingConfig = deferred();
  const engineState = createFakeEngine();
  const harness = createHarness({
    config: loadedConfig({ autoSpeak: true }),
    loadConfig: () => pendingConfig.promise,
    engineState,
  });
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Do not speak this stale response")])],
    calls: harness.calls,
  });

  const settling = harness.handlers.get("agent_settled")({}, ctx);
  harness.handlers.get("input")({ text: "next prompt" }, ctx);
  pendingConfig.resolve(loadedConfig({ autoSpeak: true }));
  await settling;

  assert.equal(engineState.calls.speak.length, 0);
  assert.deepEqual(notifications, []);
});

test("does not start automatic speech when the session becomes busy during setup", async () => {
  const pendingConfig = deferred();
  let idle = true;
  const engineState = createFakeEngine();
  const harness = createHarness({
    config: loadedConfig({ autoSpeak: true }),
    loadConfig: () => pendingConfig.promise,
    engineState,
  });
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Do not speak this stale response")])],
    isIdle: () => idle,
    calls: harness.calls,
  });

  const settling = harness.handlers.get("agent_settled")({}, ctx);
  idle = false;
  pendingConfig.resolve(loadedConfig({ autoSpeak: true }));
  await settling;

  assert.equal(engineState.calls.speak.length, 0);
  assert.deepEqual(notifications, []);
});

test("cancels active automatic speech on the next input", async () => {
  const pendingSpeech = deferred();
  const engineState = createFakeEngine(() => pendingSpeech.promise);
  const harness = createHarness({
    config: loadedConfig({ autoSpeak: true }),
    engineState,
  });
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Cancel this automatic speech")])],
    calls: harness.calls,
  });

  await harness.handlers.get("agent_settled")({}, ctx);
  harness.handlers.get("input")({ text: "next prompt" }, ctx);
  pendingSpeech.resolve({
    ok: false,
    error: {
      code: "tts_cancelled",
      message: "Speech synthesis or playback was cancelled.",
    },
  });
  await flushPromises();

  assert.equal(engineState.calls.cancel, 1);
  assert.deepEqual(notifications, [{ message: SPEAK_STARTING, type: "info" }]);
});
