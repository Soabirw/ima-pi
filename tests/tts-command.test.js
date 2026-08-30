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

const PACKAGE_CONFIG_UNAVAILABLE =
  "TTS is unavailable because its bundled configuration could not be loaded.";
const TTS_DISABLED = "TTS is disabled. Enable it before using /ima:speak.";
const NO_COMPLETED_RESPONSE = "No completed assistant response is available to speak.";
const CLEANUP_EMPTY = "The latest assistant response has no speakable text.";
const SPEAK_USAGE = "Usage: /ima:speak or /ima:speak stop";
const SPEAK_UNEXPECTED_FAILURE = "TTS speech could not be completed.";
const CREDENTIALS_MISSING =
  "TTS is enabled, but OpenAI credentials are unavailable. "
  + "Configure Pi authentication or OPENAI_API_KEY.";
const PLAYER_MISSING = "TTS is enabled, but its configured audio player is unavailable.";

test("registers only /ima:speak, input and shutdown handlers, and a command-and-args exec adapter", async () => {
  const harness = createHarness();
  const signal = new AbortController().signal;

  assert.deepEqual(harness.commands.map(({ name }) => name), ["ima:speak"]);
  assert.match(harness.command.description, /latest completed assistant response/i);
  assert.match(harness.command.description, /stop/i);
  assert.deepEqual(
    [...harness.handlers.keys()],
    ["session_start", "input", "session_shutdown"],
  );
  assert.equal(harness.calls.createEngine, 1);

  const result = await harness.engineDependencies.exec("ffplay", ["/tmp/audio.mp3"], {
    signal,
  });

  assert.deepEqual(result, { code: 0, killed: false, stdout: "", stderr: "" });
  assert.equal(harness.calls.exec.length, 1);
  assert.equal(harness.calls.exec[0].command, "ffplay");
  assert.deepEqual(harness.calls.exec[0].args, ["/tmp/audio.mp3"]);
  assert.equal(harness.calls.exec[0].options.signal, signal);
});

test("keeps non-TUI or UI-less commands silent before effects", async () => {
  const harness = createHarness();

  for (const [mode, hasUI] of [
    ["print", false],
    ["json", false],
    ["rpc", true],
    ["tui", false],
  ]) {
    const { ctx, notifications } = commandContext({ mode, hasUI, calls: harness.calls });
    await harness.command.handler("", ctx);
    assert.deepEqual(notifications, [], `${mode}/${hasUI}`);
  }

  assert.deepEqual(
    {
      loadConfig: harness.calls.loadConfig,
      getApiKey: harness.calls.getApiKey,
      hasPlayer: harness.calls.hasPlayer,
      getBranch: harness.calls.getBranch,
      speech: harness.engineState.calls.speak.length,
    },
    { loadConfig: 0, getApiKey: 0, hasPlayer: 0, getBranch: 0, speech: 0 },
  );
});

test("contains unavailable and disabled configuration before later command effects", async () => {
  const unavailable = createHarness({ config: { packageReady: false } });
  const unavailableContext = commandContext({ calls: unavailable.calls });

  await unavailable.command.handler("", unavailableContext.ctx);

  assert.deepEqual(unavailableContext.notifications, [{
    message: PACKAGE_CONFIG_UNAVAILABLE,
    type: "warning",
  }]);
  assert.equal(unavailable.calls.getApiKey, 0);
  assert.equal(unavailable.calls.hasPlayer, 0);
  assert.equal(unavailable.calls.getBranch, 0);
  assert.equal(unavailable.engineState.calls.speak.length, 0);

  const disabled = createHarness({ config: loadedConfig({ enable: false }) });
  const disabledContext = commandContext({ calls: disabled.calls });

  await disabled.command.handler("", disabledContext.ctx);

  assert.deepEqual(disabledContext.notifications, [{ message: TTS_DISABLED, type: "info" }]);
  assert.equal(disabled.calls.getApiKey, 0);
  assert.equal(disabled.calls.hasPlayer, 0);
  assert.equal(disabled.calls.getBranch, 0);
  assert.equal(disabled.engineState.calls.speak.length, 0);
});

test("rejects unknown command arguments without provider, player, session, or engine effects", async () => {
  const harness = createHarness();
  const { ctx, notifications } = commandContext({ calls: harness.calls });

  await harness.command.handler("replay", ctx);

  assert.deepEqual(notifications, [{ message: SPEAK_USAGE, type: "warning" }]);
  assert.equal(harness.calls.getApiKey, 0);
  assert.equal(harness.calls.hasPlayer, 0);
  assert.equal(harness.calls.getBranch, 0);
  assert.equal(harness.engineState.calls.cancel, 0);
  assert.equal(harness.engineState.calls.speak.length, 0);
});

test("maps missing credentials and player readiness to existing notices", async () => {
  const missingCredentials = createHarness({ apiKey: null });
  const credentialsContext = commandContext({ calls: missingCredentials.calls });

  await missingCredentials.command.handler("", credentialsContext.ctx);

  assert.deepEqual(credentialsContext.notifications, [{
    message: CREDENTIALS_MISSING,
    type: "warning",
  }]);
  assert.equal(missingCredentials.calls.getBranch, 0);
  assert.equal(missingCredentials.engineState.calls.speak.length, 0);

  const missingPlayer = createHarness({ playerResolved: false });
  const playerContext = commandContext({ calls: missingPlayer.calls });

  await missingPlayer.command.handler("", playerContext.ctx);

  assert.deepEqual(playerContext.notifications, [{ message: PLAYER_MISSING, type: "warning" }]);
  assert.equal(missingPlayer.calls.getBranch, 0);
  assert.equal(missingPlayer.engineState.calls.speak.length, 0);
});

test("uses Pi's API-key resolver only after speak-command guards", async () => {
  const harness = createHarness({ useDefaultApiKeyResolver: true });
  let resolverCalls = 0;
  const modelRegistry = {
    getApiKeyForProvider: async (provider) => {
      resolverCalls += 1;
      assert.equal(provider, "openai");
      return "resolved-api-key";
    },
  };
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Speak this")])],
    modelRegistry,
    calls: harness.calls,
  });

  await harness.command.handler("unknown", ctx);
  assert.equal(resolverCalls, 0);

  await harness.command.handler("", ctx);
  await flushPromises();

  assert.equal(resolverCalls, 1);
  assert.deepEqual(notifications, [
    { message: SPEAK_USAGE, type: "warning" },
    { message: SPEAK_STARTING, type: "info" },
    { message: SPEAK_COMPLETE, type: "info" },
  ]);
  assert.equal(harness.engineState.calls.speak[0].apiKey, "resolved-api-key");
});

test("contains API-key resolver failures as missing credentials", async () => {
  const harness = createHarness({ useDefaultApiKeyResolver: true });
  let resolverCalls = 0;
  const { ctx, notifications } = commandContext({
    modelRegistry: {
      getApiKeyForProvider: async () => {
        resolverCalls += 1;
        throw new Error("resolver failure");
      },
    },
    calls: harness.calls,
  });

  await harness.command.handler("", ctx);

  assert.equal(resolverCalls, 1);
  assert.deepEqual(notifications, [{
    message: CREDENTIALS_MISSING,
    type: "warning",
  }]);
  assert.equal(harness.calls.getBranch, 0);
  assert.equal(harness.engineState.calls.speak.length, 0);
});

test("reports when no completed assistant response is available", async () => {
  const harness = createHarness();
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Interrupted")], "aborted")],
    calls: harness.calls,
  });

  await harness.command.handler("", ctx);

  assert.deepEqual(notifications, [{ message: NO_COMPLETED_RESPONSE, type: "info" }]);
  assert.equal(harness.calls.getBranch, 1);
  assert.equal(harness.engineState.calls.speak.length, 0);
});

test("speaks the selected response with exact configured request values", async () => {
  const engineState = createFakeEngine();
  const harness = createHarness({
    config: loadedConfig({
      model: "custom-tts-model",
      voice: "nova",
      playerCommand: "cvlc",
    }),
    engineState,
  });
  const { ctx, notifications } = commandContext({
    entries: [
      assistantEntry([textPart("Earlier")]),
      assistantEntry([textPart("Latest"), { type: "thinking", thinking: "ignore" }]),
    ],
    calls: harness.calls,
  });

  await harness.command.handler("", ctx);
  await flushPromises();

  assert.deepEqual(engineState.calls.speak, [{
    text: "Latest",
    apiKey: "test-api-key",
    model: "custom-tts-model",
    voice: "nova",
    playerCommand: "cvlc",
  }]);
  assert.deepEqual(notifications, [
    { message: SPEAK_STARTING, type: "info" },
    { message: SPEAK_COMPLETE, type: "info" },
  ]);
  assert.equal(engineState.calls.cancel, 0);
});

test("reports starting, multi-segment progress, and completion in order", async () => {
  const pendingSpeech = deferred();
  const engineState = createFakeEngine((_request, hooks) => {
    hooks?.onSegmentStart?.({ index: 1, total: 2 });
    hooks?.onSegmentStart?.({ index: 2, total: 2 });
    return pendingSpeech.promise;
  });
  const harness = createHarness({ engineState });
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Long response")])],
    calls: harness.calls,
  });

  await harness.command.handler("", ctx);

  assert.deepEqual(notifications, [
    { message: SPEAK_STARTING, type: "info" },
    { message: "Speaking part 1 of 2.", type: "info" },
    { message: "Speaking part 2 of 2.", type: "info" },
  ]);

  pendingSpeech.resolve({ ok: true, spoke: true });
  await flushPromises();

  assert.deepEqual(notifications, [
    { message: SPEAK_STARTING, type: "info" },
    { message: "Speaking part 1 of 2.", type: "info" },
    { message: "Speaking part 2 of 2.", type: "info" },
    { message: SPEAK_COMPLETE, type: "info" },
  ]);
});

test("suppresses the single-segment progress notice", async () => {
  const pendingSpeech = deferred();
  const engineState = createFakeEngine((_request, hooks) => {
    hooks?.onSegmentStart?.({ index: 1, total: 1 });
    return pendingSpeech.promise;
  });
  const harness = createHarness({ engineState });
  const { ctx, notifications } = commandContext({
    entries: [assistantEntry([textPart("Short response")])],
    calls: harness.calls,
  });

  await harness.command.handler("", ctx);

  assert.deepEqual(notifications, [{ message: SPEAK_STARTING, type: "info" }]);

  pendingSpeech.resolve({ ok: true, spoke: true });
  await flushPromises();

  assert.deepEqual(notifications, [
    { message: SPEAK_STARTING, type: "info" },
    { message: SPEAK_COMPLETE, type: "info" },
  ]);
});

test("returns from the command before speech playback settles", async () => {
  const pendingSpeech = deferred();
  const engineState = createFakeEngine(() => pendingSpeech.promise);
  const harness = createHarness({ engineState });
  const { ctx } = commandContext({
    entries: [assistantEntry([textPart("Long response")])],
    calls: harness.calls,
  });

  await harness.command.handler("", ctx);

  assert.equal(engineState.calls.speak.length, 1);
  pendingSpeech.resolve({ ok: true, spoke: true });
  await flushPromises();
});

test("contains cleanup, engine failure, and unexpected rejection notices", async (t) => {
  await t.test("reports cleanup-only speech without an error", async () => {
    const harness = createHarness({
      engineState: createFakeEngine(async () => ({ ok: true, spoke: false })),
    });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Only markup after cleanup")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await flushPromises();

    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      { message: CLEANUP_EMPTY, type: "info" },
    ]);
  });

  await t.test("reports the bounded engine failure message", async () => {
    const message = "OpenAI speech synthesis could not be completed.";
    const harness = createHarness({
      engineState: createFakeEngine(async () => ({
        ok: false,
        error: { code: "tts_synthesis_failed", message },
      })),
    });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Speech request")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await flushPromises();

    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      { message, type: "warning" },
    ]);
  });

  await t.test("contains an unexpected speech rejection", async () => {
    const harness = createHarness({
      engineState: createFakeEngine(async () => {
        throw new Error("do not expose this rejection");
      }),
    });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Speech request")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await flushPromises();

    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      {
        message: SPEAK_UNEXPECTED_FAILURE,
        type: "warning",
      },
    ]);
  });
});
