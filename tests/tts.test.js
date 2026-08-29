import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ttsExtension from "../extensions/tts.ts";
import {
  mergeTtsConfig,
  parseTtsConfigLayer,
  playerCandidatePaths,
  resolveTtsReadiness,
  TTS_CONFIG_DEFAULTS,
} from "../lib/ima-tts.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const readiness = (overrides = {}) => resolveTtsReadiness({
  enable: true,
  mode: "tui",
  hasUI: true,
  hasApiKey: true,
  playerResolved: true,
  ...overrides,
});

const diagnosticCodes = (result) => result.diagnostics.map(({ code }) => code);
const noticeCodes = (result) => result.notices.map(({ code }) => code);
const packageConfigUnavailable =
  "TTS is unavailable because its bundled configuration could not be loaded.";
const userConfigInvalid =
  "TTS configuration contains invalid settings; valid settings were used.";
const credentialsMissing =
  "TTS is enabled, but OpenAI credentials are unavailable. Configure Pi authentication or OPENAI_API_KEY.";
const playerMissing =
  "TTS is enabled, but its configured audio player is unavailable.";

const loadedConfig = (overrides = {}) => ({
  packageReady: true,
  config: { ...TTS_CONFIG_DEFAULTS, ...overrides },
  hasUserConfigDiagnostics: false,
});

const registerSessionStart = (dependencies = {}) => {
  let handler;
  ttsExtension({
    on: (event, callback) => {
      if (event === "session_start") handler = callback;
    },
    registerCommand: () => {},
  }, dependencies);
  return handler;
};

const sessionContext = (mode = "tui", hasUI = true) => {
  const notifications = [];
  return {
    ctx: {
      mode,
      hasUI,
      modelRegistry: {},
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
      },
    },
    notifications,
  };
};

const countedDependencies = (config, options = {}) => {
  const calls = { loadConfig: 0, credentials: 0, player: 0, path: 0 };
  return {
    calls,
    dependencies: {
      loadConfig: async () => {
        calls.loadConfig += 1;
        return config;
      },
      hasOpenAiCredentials: async () => {
        calls.credentials += 1;
        return options.hasApiKey ?? true;
      },
      hasPlayer: async () => {
        calls.player += 1;
        return options.playerResolved ?? true;
      },
      getPath: () => {
        calls.path += 1;
        return "/bin";
      },
    },
  };
};

test("accepts known TTS config values and normalizes strings", () => {
  const layer = {
    enable: true,
    autoSpeak: false,
    provider: " openai ",
    model: " gpt-4o-mini-tts ",
    voice: " alloy ",
    playerCommand: " ffplay ",
  };

  const result = parseTtsConfigLayer(layer);

  assert.deepEqual(result.values, {
    enable: true,
    autoSpeak: false,
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    playerCommand: "ffplay",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(layer.model, " gpt-4o-mini-tts ");
});

test("drops unknown and invalid TTS config values without throwing", () => {
  const layer = {
    enable: "true",
    autoSpeak: 1,
    provider: "other",
    model: " ",
    voice: false,
    playerCommand: null,
    ignored: "value",
  };

  const result = parseTtsConfigLayer(layer);

  assert.deepEqual(result.values, {});
  assert.deepEqual(diagnosticCodes(result), [
    "tts_config_invalid_boolean",
    "tts_config_invalid_boolean",
    "tts_config_invalid_provider",
    "tts_config_invalid_string",
    "tts_config_invalid_string",
    "tts_config_invalid_string",
    "tts_config_unknown_key",
  ]);
  assert.deepEqual(layer, {
    enable: "true",
    autoSpeak: 1,
    provider: "other",
    model: " ",
    voice: false,
    playerCommand: null,
    ignored: "value",
  });
  assert.doesNotThrow(() => parseTtsConfigLayer(null));
});

test("keeps disabled and auto-speak opt-ins independent", () => {
  const autoSpeakOnly = mergeTtsConfig(TTS_CONFIG_DEFAULTS, { autoSpeak: true });

  assert.equal(TTS_CONFIG_DEFAULTS.enable, false);
  assert.equal(TTS_CONFIG_DEFAULTS.autoSpeak, false);
  assert.equal(autoSpeakOnly.enable, false);
  assert.equal(autoSpeakOnly.autoSpeak, true);
});

test("merges whole TTS config keys without mutating either input", () => {
  const defaults = { ...TTS_CONFIG_DEFAULTS };
  const override = { enable: true, model: "custom-model" };
  const merged = mergeTtsConfig(defaults, override);

  assert.notEqual(merged, defaults);
  assert.deepEqual(merged, {
    ...TTS_CONFIG_DEFAULTS,
    enable: true,
    model: "custom-model",
  });
  assert.deepEqual(defaults, TTS_CONFIG_DEFAULTS);
  assert.deepEqual(override, { enable: true, model: "custom-model" });
});

test("derives player candidates without filesystem access", () => {
  assert.deepEqual(
    playerCandidatePaths("/usr/local/bin/cvlc", "/bin"),
    ["/usr/local/bin/cvlc"],
  );
  assert.deepEqual(
    playerCandidatePaths("ffplay", ["/one", "/two"].join(delimiter)),
    [join("/one", "ffplay"), join("/two", "ffplay")],
  );
  assert.deepEqual(playerCandidatePaths("", "/one:/two"), []);
});

test("rejects relative path-like player commands without mutating input", () => {
  for (const playerCommand of ["subdir/player", "../player", ".", "..", "subdir\\player"]) {
    const layer = { playerCommand };
    const parsed = parseTtsConfigLayer(layer);

    assert.deepEqual(parsed.values, {}, playerCommand);
    assert.deepEqual(diagnosticCodes(parsed), ["tts_config_invalid_string"], playerCommand);
    assert.deepEqual(playerCandidatePaths(playerCommand, "/one:/two"), [], playerCommand);
    assert.deepEqual(layer, { playerCommand }, playerCommand);
  }
});

test("keeps disabled TTS inactive without notices", () => {
  const result = readiness({ enable: false, hasApiKey: false, playerResolved: false });

  assert.deepEqual(result, { active: false, ready: false, notices: [] });
});

test("keeps non-TUI TTS modes inactive and silent", () => {
  for (const mode of ["print", "json", "rpc"]) {
    const result = readiness({
      mode,
      hasUI: mode === "rpc",
      hasApiKey: false,
      playerResolved: false,
    });

    assert.deepEqual(result, { active: false, ready: false, notices: [] }, mode);
  }
});

test("keeps enabled TTS inactive and silent in TUI mode without a UI", () => {
  const result = readiness({
    enable: true,
    mode: "tui",
    hasUI: false,
    hasApiKey: false,
    playerResolved: false,
  });

  assert.deepEqual(result, { active: false, ready: false, notices: [] });
});

test("reports only the TTS resources missing from an enabled TUI", () => {
  assert.deepEqual(
    noticeCodes(readiness({ hasApiKey: false })),
    ["tts_openai_credentials_missing"],
  );
  assert.deepEqual(
    noticeCodes(readiness({ playerResolved: false })),
    ["tts_player_missing"],
  );
  assert.deepEqual(
    noticeCodes(readiness({ hasApiKey: false, playerResolved: false })),
    ["tts_openai_credentials_missing", "tts_player_missing"],
  );

  const ready = readiness();
  assert.equal(ready.active, true);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.notices, []);
});

test("ships the approved disabled-by-default TTS package configuration", async () => {
  const config = JSON.parse(await readFile(join(root, "config", "tts.json"), "utf8"));

  assert.deepEqual(config, TTS_CONFIG_DEFAULTS);
});

test("retains S1 readiness while registering S3 command, input, and shutdown wiring", () => {
  const events = [];
  const commands = [];

  ttsExtension({
    on: (event) => events.push(event),
    registerCommand: (name) => commands.push(name),
  });

  assert.deepEqual(events, ["session_start", "input", "session_shutdown"]);
  assert.deepEqual(commands, ["ima:speak"]);
});

test("skips every noninteractive session-start context before effects", async () => {
  const { calls, dependencies } = countedDependencies(loadedConfig({ enable: true }));
  const handler = registerSessionStart(dependencies);

  for (const [mode, hasUI] of [
    ["print", false],
    ["json", false],
    ["rpc", true],
    ["tui", false],
  ]) {
    const { ctx, notifications } = sessionContext(mode, hasUI);
    await handler({}, ctx);
    assert.deepEqual(notifications, [], `${mode}/${hasUI}`);
  }

  assert.deepEqual(calls, { loadConfig: 0, credentials: 0, player: 0, path: 0 });
});

test("loads disabled TTS config without resource or notification effects", async () => {
  const { calls, dependencies } = countedDependencies(loadedConfig());
  const handler = registerSessionStart(dependencies);
  const { ctx, notifications } = sessionContext();

  await handler({}, ctx);

  assert.deepEqual(calls, { loadConfig: 1, credentials: 0, player: 0, path: 0 });
  assert.deepEqual(notifications, []);
});

test("stops after one non-fatal bundled-config warning", async () => {
  const { calls, dependencies } = countedDependencies({ packageReady: false });
  const handler = registerSessionStart(dependencies);
  const { ctx, notifications } = sessionContext();

  await handler({}, ctx);

  assert.deepEqual(calls, { loadConfig: 1, credentials: 0, player: 0, path: 0 });
  assert.deepEqual(notifications, [{ message: packageConfigUnavailable, type: "warning" }]);
});

test("continues an enabled TTS config after warning about invalid user settings", async () => {
  const config = { ...loadedConfig({ enable: true }), hasUserConfigDiagnostics: true };
  const { calls, dependencies } = countedDependencies(config);
  const handler = registerSessionStart(dependencies);
  const { ctx, notifications } = sessionContext();

  await handler({}, ctx);

  assert.deepEqual(calls, { loadConfig: 1, credentials: 1, player: 1, path: 1 });
  assert.deepEqual(notifications, [{ message: userConfigInvalid, type: "warning" }]);
});

test("routes exactly the enabled TTS readiness warnings", async () => {
  const cases = [
    [false, true, [credentialsMissing]],
    [true, false, [playerMissing]],
    [false, false, [credentialsMissing, playerMissing]],
    [true, true, []],
  ];

  for (const [hasApiKey, playerResolved, messages] of cases) {
    const { dependencies } = countedDependencies(loadedConfig({ enable: true }), {
      hasApiKey,
      playerResolved,
    });
    const handler = registerSessionStart(dependencies);
    const { ctx, notifications } = sessionContext();

    await handler({}, ctx);

    assert.deepEqual(
      notifications,
      messages.map((message) => ({ message, type: "warning" })),
      `${hasApiKey}/${playerResolved}`,
    );
  }
});

test(
  "requires executable access before treating a player as ready",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ima-tts-player-"));
    const playerCommand = "tts-player";
    const playerPath = join(directory, playerCommand);
    const handler = registerSessionStart({
      loadConfig: async () => loadedConfig({ enable: true, playerCommand }),
      hasOpenAiCredentials: async () => true,
      getPath: () => directory,
    });

    try {
      await writeFile(playerPath, "#!/bin/sh\n", "utf8");
      await chmod(playerPath, 0o600);

      const unavailable = sessionContext();
      await handler({}, unavailable.ctx);
      assert.deepEqual(
        unavailable.notifications,
        [{ message: playerMissing, type: "warning" }],
      );

      await chmod(playerPath, 0o700);

      const available = sessionContext();
      await handler({}, available.ctx);
      assert.deepEqual(available.notifications, []);

      const fallbackDirectory = join(directory, "fallback");
      const fallbackPath = join(fallbackDirectory, playerCommand);
      await mkdir(fallbackDirectory);
      await writeFile(fallbackPath, "#!/bin/sh\n", "utf8");
      await chmod(fallbackPath, 0o700);
      await chmod(playerPath, 0o600);

      const fallbackHandler = registerSessionStart({
        loadConfig: async () => loadedConfig({ enable: true, playerCommand }),
        hasOpenAiCredentials: async () => true,
        getPath: () => [directory, fallbackDirectory].join(delimiter),
      });
      const fallback = sessionContext();
      await fallbackHandler({}, fallback.ctx);
      assert.deepEqual(fallback.notifications, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
