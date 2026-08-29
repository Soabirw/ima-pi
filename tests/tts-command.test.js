import assert from "node:assert/strict";
import test from "node:test";
import ttsExtension from "../extensions/tts.ts";
import { TTS_CONFIG_DEFAULTS } from "../lib/ima-tts.ts";

const PACKAGE_CONFIG_UNAVAILABLE =
  "TTS is unavailable because its bundled configuration could not be loaded.";
const TTS_DISABLED = "TTS is disabled. Enable it before using /ima:speak.";
const NO_COMPLETED_RESPONSE = "No completed assistant response is available to speak.";
const CLEANUP_EMPTY = "The latest assistant response has no speakable text.";
const SPEAK_USAGE = "Usage: /ima:speak or /ima:speak stop";
const SPEAK_STOPPED = "TTS playback stopped.";
const SPEAK_UNEXPECTED_FAILURE = "TTS speech could not be completed.";
const CREDENTIALS_MISSING =
  "TTS is enabled, but OpenAI credentials are unavailable. "
  + "Configure Pi authentication or OPENAI_API_KEY.";
const PLAYER_MISSING = "TTS is enabled, but its configured audio player is unavailable.";
const CANCELLED_SPEECH = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "tts_cancelled",
    message: "Speech synthesis or playback was cancelled.",
  }),
});

const loadedConfig = (overrides = {}) => ({
  packageReady: true,
  config: { ...TTS_CONFIG_DEFAULTS, enable: true, ...overrides },
  hasUserConfigDiagnostics: false,
});

const assistantEntry = (content, stopReason = "stop") => ({
  type: "message",
  message: {
    role: "assistant",
    stopReason,
    content,
  },
});

const textPart = (text) => ({ type: "text", text });

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

const createFakeEngine = (speak = async () => ({ ok: true, spoke: true })) => {
  const calls = { speak: [], cancel: 0 };

  return {
    calls,
    engine: {
      speak: (request) => {
        calls.speak.push(request);
        return speak(request);
      },
      cancel: () => {
        calls.cancel += 1;
      },
    },
  };
};

const createHarness = ({
  config = loadedConfig(),
  loadConfig = async () => config,
  apiKey = "test-api-key",
  getOpenAiApiKey = async () => apiKey,
  playerResolved = true,
  hasPlayer = async () => playerResolved,
  engineState = createFakeEngine(),
  useDefaultApiKeyResolver = false,
} = {}) => {
  const calls = {
    createEngine: 0,
    loadConfig: 0,
    hasCredentials: 0,
    getApiKey: 0,
    hasPlayer: 0,
    getPath: 0,
    getBranch: 0,
    exec: [],
  };
  const handlers = new Map();
  const commands = [];
  let engineDependencies;
  const pi = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name, options) => {
      commands.push({ name, ...options });
    },
    exec: async (command, args, options) => {
      calls.exec.push({ command, args, options });
      return { code: 0, killed: false, stdout: "", stderr: "" };
    },
  };
  const dependencies = {
    loadConfig: async () => {
      calls.loadConfig += 1;
      return loadConfig();
    },
    hasOpenAiCredentials: async () => {
      calls.hasCredentials += 1;
      return Boolean(apiKey);
    },
    hasPlayer: async () => {
      calls.hasPlayer += 1;
      return hasPlayer();
    },
    getPath: () => {
      calls.getPath += 1;
      return "/bin";
    },
    createSpeechEngine: (createdDependencies) => {
      calls.createEngine += 1;
      engineDependencies = createdDependencies;
      return engineState.engine;
    },
  };

  if (!useDefaultApiKeyResolver) {
    dependencies.getOpenAiApiKey = async () => {
      calls.getApiKey += 1;
      return getOpenAiApiKey();
    };
  }

  ttsExtension(pi, dependencies);

  return {
    calls,
    command: commands.find(({ name }) => name === "ima:speak"),
    commands,
    engineDependencies,
    engineState,
    handlers,
  };
};

const commandContext = ({
  mode = "tui",
  hasUI = true,
  entries = [],
  modelRegistry = {},
  calls,
} = {}) => {
  const notifications = [];

  return {
    ctx: {
      mode,
      hasUI,
      modelRegistry,
      sessionManager: {
        getBranch: () => {
          if (calls) calls.getBranch += 1;
          return entries;
        },
      },
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
      },
    },
    notifications,
  };
};

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

test("stops idempotently without credential, player, or session checks", async () => {
  const harness = createHarness();
  const { ctx, notifications } = commandContext({ calls: harness.calls });

  await harness.command.handler(" stop ", ctx);

  assert.deepEqual(notifications, [{ message: SPEAK_STOPPED, type: "info" }]);
  assert.equal(harness.calls.getApiKey, 0);
  assert.equal(harness.calls.hasPlayer, 0);
  assert.equal(harness.calls.getBranch, 0);
  assert.equal(harness.engineState.calls.cancel, 1);
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
  assert.deepEqual(notifications, [{ message: SPEAK_USAGE, type: "warning" }]);
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
  assert.deepEqual(notifications, []);
  assert.equal(engineState.calls.cancel, 0);
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

    assert.deepEqual(notifications, [{ message: CLEANUP_EMPTY, type: "info" }]);
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

    assert.deepEqual(notifications, [{ message, type: "warning" }]);
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

    assert.deepEqual(notifications, [{
      message: SPEAK_UNEXPECTED_FAILURE,
      type: "warning",
    }]);
  });
});

test("cancels on every real input event without transforming it", () => {
  const harness = createHarness();
  const { ctx } = commandContext({ calls: harness.calls });

  const result = harness.handlers.get("input")({ text: "next prompt" }, ctx);

  assert.equal(result, undefined);
  assert.equal(harness.engineState.calls.cancel, 1);
});

test("delegates repeated speak requests to the singleton engine", async () => {
  const engineState = createFakeEngine();
  const harness = createHarness({ engineState });
  const { ctx } = commandContext({
    entries: [assistantEntry([textPart("Replay this")])],
    calls: harness.calls,
  });

  await harness.command.handler("", ctx);
  await harness.command.handler("", ctx);
  await flushPromises();

  assert.equal(harness.calls.createEngine, 1);
  assert.equal(engineState.calls.speak.length, 2);
  assert.deepEqual(engineState.calls.speak.map(({ text }) => text), [
    "Replay this",
    "Replay this",
  ]);
});

test("keeps intentional cancellation settlements silent", async (t) => {
  await t.test("shows only the explicit stop notice", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Stop this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await harness.command.handler("stop", ctx);
    pendingSpeech.resolve(CANCELLED_SPEECH);
    await flushPromises();

    assert.deepEqual(notifications, [{ message: SPEAK_STOPPED, type: "info" }]);
  });

  await t.test("keeps input cancellation silent", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Cancel this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    harness.handlers.get("input")({}, ctx);
    pendingSpeech.resolve(CANCELLED_SPEECH);
    await flushPromises();

    assert.deepEqual(notifications, []);
  });

  await t.test("keeps superseded cancellation silent", async () => {
    const pendingSpeech = [deferred(), deferred()];
    let requestCount = 0;
    const engineState = createFakeEngine(() => pendingSpeech[requestCount++].promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Replay this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await harness.command.handler("", ctx);
    pendingSpeech[0].resolve(CANCELLED_SPEECH);
    pendingSpeech[1].resolve({ ok: true, spoke: true });
    await flushPromises();

    assert.deepEqual(notifications, []);
  });
});

test("invalidates stale pending speech intents", async (t) => {
  await t.test("input prevents a readiness-pending request from starting", async () => {
    const pendingApiKey = deferred();
    const harness = createHarness({
      getOpenAiApiKey: () => pendingApiKey.promise,
    });
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    const speaking = harness.command.handler("", ctx);
    harness.handlers.get("input")({}, ctx);
    pendingApiKey.resolve("test-api-key");
    await speaking;

    assert.equal(harness.engineState.calls.speak.length, 0);
    assert.deepEqual(notifications, []);
  });

  await t.test("stop prevents an older readiness-pending request from starting", async () => {
    const pendingApiKey = deferred();
    const harness = createHarness({
      getOpenAiApiKey: () => pendingApiKey.promise,
    });
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    const speaking = harness.command.handler("", ctx);
    await harness.command.handler("stop", ctx);
    pendingApiKey.resolve("test-api-key");
    await speaking;

    assert.equal(harness.engineState.calls.cancel, 1);
    assert.equal(harness.engineState.calls.speak.length, 0);
    assert.deepEqual(notifications, [{ message: SPEAK_STOPPED, type: "info" }]);
  });

  await t.test("only starts the newest request when readiness resolves out of order", async () => {
    const pendingApiKeys = [deferred(), deferred()];
    let apiKeyRequests = 0;
    const harness = createHarness({
      getOpenAiApiKey: () => pendingApiKeys[apiKeyRequests++].promise,
    });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Latest response")])],
      calls: harness.calls,
    });

    const first = harness.command.handler("", ctx);
    await flushPromises();
    const second = harness.command.handler("", ctx);
    await flushPromises();
    pendingApiKeys[1].resolve("newest-api-key");
    await second;
    pendingApiKeys[0].resolve("older-api-key");
    await first;

    assert.deepEqual(harness.engineState.calls.speak.map(({ apiKey }) => apiKey), [
      "newest-api-key",
    ]);
    assert.deepEqual(notifications, []);
  });

  await t.test("a stale stop cannot cancel a newer started request", async () => {
    const pendingStopConfig = deferred();
    let configRequests = 0;
    const harness = createHarness({
      loadConfig: () => {
        configRequests += 1;
        return configRequests === 1 ? pendingStopConfig.promise : loadedConfig();
      },
    });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Newer response")])],
      calls: harness.calls,
    });

    const stopping = harness.command.handler("stop", ctx);
    await harness.command.handler("", ctx);
    pendingStopConfig.resolve(loadedConfig());
    await stopping;

    assert.equal(harness.engineState.calls.speak.length, 1);
    assert.equal(harness.engineState.calls.cancel, 0);
    assert.deepEqual(notifications, []);
  });
});

test("cancels active and pending speech during session shutdown", async (t) => {
  await t.test("cancels active speech without a notice", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Shutdown this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    const result = harness.handlers.get("session_shutdown")({}, ctx);
    pendingSpeech.resolve(CANCELLED_SPEECH);
    await flushPromises();

    assert.equal(result, undefined);
    assert.equal(engineState.calls.cancel, 1);
    assert.deepEqual(notifications, []);
  });

  await t.test("invalidates a readiness-pending request", async () => {
    const pendingApiKey = deferred();
    const harness = createHarness({
      getOpenAiApiKey: () => pendingApiKey.promise,
    });
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    const speaking = harness.command.handler("", ctx);
    const result = harness.handlers.get("session_shutdown")({}, ctx);
    pendingApiKey.resolve("test-api-key");
    await speaking;

    assert.equal(result, undefined);
    assert.equal(harness.engineState.calls.cancel, 1);
    assert.equal(harness.engineState.calls.speak.length, 0);
    assert.deepEqual(notifications, []);
  });

  await t.test("remains safe while inactive", () => {
    const harness = createHarness();
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    const result = harness.handlers.get("session_shutdown")({}, ctx);

    assert.equal(result, undefined);
    assert.equal(harness.engineState.calls.cancel, 1);
    assert.deepEqual(notifications, []);
  });
});
