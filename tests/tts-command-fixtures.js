import ttsExtension from "../extensions/tts.ts";
import { TTS_CONFIG_DEFAULTS } from "../lib/ima-tts.ts";

export const SPEAK_STARTING = "Speaking the latest response.";
export const SPEAK_COMPLETE = "Finished speaking the latest response.";
export const SPEAK_STOPPED = "TTS playback stopped.";

export const loadedConfig = (overrides = {}) => ({
  packageReady: true,
  config: { ...TTS_CONFIG_DEFAULTS, enable: true, ...overrides },
  hasUserConfigDiagnostics: false,
});

export const assistantEntry = (content, stopReason = "stop") => ({
  type: "message",
  message: {
    role: "assistant",
    stopReason,
    content,
  },
});

export const textPart = (text) => ({ type: "text", text });

export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

export const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

export const createFakeEngine = (speak = async () => ({ ok: true, spoke: true })) => {
  const calls = { speak: [], hooks: [], cancel: 0 };

  return {
    calls,
    engine: {
      speak: (request, hooks) => {
        calls.speak.push(request);
        calls.hooks.push(hooks);
        return speak(request, hooks);
      },
      cancel: () => {
        calls.cancel += 1;
      },
    },
  };
};

export const createHarness = ({
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

export const commandContext = ({
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
