import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  hasCompleteTtsConfigLayer,
  mergeTtsConfig,
  parseTtsConfigLayer,
  playerCandidatePaths,
  resolveTtsReadiness,
  TTS_CONFIG_DEFAULTS,
  type TtsConfig,
} from "../lib/ima-tts.ts";
import {
  createSpeechEngine,
  type SpeechEngine,
  type SpeechEngineDependencies,
  type SpeakHooks,
  type SpeakRequest,
  type SpeakResult,
} from "../lib/ima-tts-speech.ts";
import { selectLatestCompletedAssistantText } from "../lib/ima-tts-session.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageConfigPath = join(packageRoot, "config", "tts.json");
const userConfigPath = join(getAgentDir(), "ima", "tts.json");

const PACKAGE_CONFIG_UNAVAILABLE =
  "TTS is unavailable because its bundled configuration could not be loaded.";
const USER_CONFIG_INVALID =
  "TTS configuration contains invalid settings; valid settings were used.";
const TTS_DISABLED = "TTS is disabled. Enable it before using /ima:speak.";
const NO_COMPLETED_RESPONSE = "No completed assistant response is available to speak.";
const CLEANUP_EMPTY = "The latest assistant response has no speakable text.";
const SPEAK_USAGE = "Usage: /ima:speak or /ima:speak stop";
const SPEAK_STARTING = "Speaking the latest response.";
const SPEAK_COMPLETE = "Finished speaking the latest response.";
const SPEAK_STOPPED = "TTS playback stopped.";
const SPEAK_UNEXPECTED_FAILURE = "TTS speech could not be completed.";

const speakingSegmentMessage = (index: number, total: number): string =>
  `Speaking part ${index} of ${total}.`;

type JsonFile =
  | { ok: true; value: unknown }
  | { ok: false; reason: "missing" | "invalid" | "unreadable" };

export type TtsConfigLoadResult =
  | {
    packageReady: true;
    config: TtsConfig;
    hasUserConfigDiagnostics: boolean;
  }
  | { packageReady: false };

export type TtsExtensionDependencies = Readonly<{
  loadConfig: () => Promise<TtsConfigLoadResult>;
  hasOpenAiCredentials: (
    ctx: Pick<ExtensionContext, "modelRegistry">,
  ) => Promise<boolean>;
  getOpenAiApiKey: (
    ctx: Pick<ExtensionContext, "modelRegistry">,
  ) => Promise<string | undefined>;
  hasPlayer: (candidatePaths: readonly string[]) => Promise<boolean>;
  getPath: () => string | undefined;
  createSpeechEngine: (dependencies: SpeechEngineDependencies) => SpeechEngine;
}>;

type TtsExtensionDependencyOverrides = Readonly<Partial<TtsExtensionDependencies>>;

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && error.code === "ENOENT";

const readJsonFile = async (path: string): Promise<JsonFile> => {
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: isMissingFileError(error) ? "missing" : "unreadable",
    };
  }

  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
};

const loadTtsConfig = async (): Promise<TtsConfigLoadResult> => {
  const packageFile = await readJsonFile(packageConfigPath);
  if (!packageFile.ok) return { packageReady: false };

  const packageLayer = parseTtsConfigLayer(packageFile.value);
  const packageConfigIsComplete = hasCompleteTtsConfigLayer(packageLayer.values);
  if (packageLayer.diagnostics.length || !packageConfigIsComplete) {
    return { packageReady: false };
  }

  const packageConfig = mergeTtsConfig(TTS_CONFIG_DEFAULTS, packageLayer.values);
  const userFile = await readJsonFile(userConfigPath);
  if (!userFile.ok) {
    return {
      packageReady: true,
      config: packageConfig,
      hasUserConfigDiagnostics: userFile.reason !== "missing",
    };
  }

  const userLayer = parseTtsConfigLayer(userFile.value);
  return {
    packageReady: true,
    config: mergeTtsConfig(packageConfig, userLayer.values),
    hasUserConfigDiagnostics: userLayer.diagnostics.length > 0,
  };
};

const hasOpenAiCredentials = async (
  ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<boolean> => {
  try {
    return Boolean(await ctx.modelRegistry.getProviderAuth("openai"));
  } catch {
    return false;
  }
};

const getOpenAiApiKey = async (
  ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<string | undefined> => {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider("openai");
  } catch {
    return undefined;
  }
};

const hasPlayer = async (candidatePaths: readonly string[]): Promise<boolean> => {
  for (const candidatePath of candidatePaths) {
    try {
      if (!(await stat(candidatePath)).isFile()) continue;
      await access(candidatePath, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }

  return false;
};

const hasUsableApiKey = (apiKey: unknown): apiKey is string =>
  typeof apiKey === "string" && apiKey.trim().length > 0;

const reportSpeakResult = (
  result: SpeakResult,
  ctx: Pick<ExtensionContext, "ui">,
  isCurrent: () => boolean,
): void => {
  if (result.ok) {
    if (!result.spoke) {
      ctx.ui.notify(CLEANUP_EMPTY, "info");
      return;
    }
    if (isCurrent()) ctx.ui.notify(SPEAK_COMPLETE, "info");
    return;
  }

  if (result.error.code === "tts_cancelled") return;
  ctx.ui.notify(result.error.message, "warning");
};

const startSpeech = (
  engine: SpeechEngine,
  request: SpeakRequest,
  ctx: Pick<ExtensionContext, "ui">,
  isCurrent: () => boolean,
): void => {
  const hooks: SpeakHooks = {
    onSegmentStart: ({ index, total }) => {
      if (total <= 1 || !isCurrent()) return;
      ctx.ui.notify(speakingSegmentMessage(index, total), "info");
    },
  };
  const notifyUnexpectedFailure = (): void => {
    if (!isCurrent()) return;
    ctx.ui.notify(SPEAK_UNEXPECTED_FAILURE, "warning");
  };

  try {
    void engine
      .speak(request, hooks)
      .then((result) => reportSpeakResult(result, ctx, isCurrent))
      .catch(notifyUnexpectedFailure);
  } catch {
    notifyUnexpectedFailure();
  }
};

const resolveTtsDependencies = (
  overrides: TtsExtensionDependencyOverrides,
): TtsExtensionDependencies => Object.freeze({
  loadConfig: overrides.loadConfig ?? loadTtsConfig,
  hasOpenAiCredentials: overrides.hasOpenAiCredentials ?? hasOpenAiCredentials,
  getOpenAiApiKey: overrides.getOpenAiApiKey ?? getOpenAiApiKey,
  hasPlayer: overrides.hasPlayer ?? hasPlayer,
  getPath: overrides.getPath ?? (() => process.env.PATH),
  createSpeechEngine: overrides.createSpeechEngine ?? createSpeechEngine,
});

export default function ttsExtension(
  pi: ExtensionAPI,
  overrides: TtsExtensionDependencyOverrides = {},
) {
  const dependencies = resolveTtsDependencies(overrides);
  const engine = dependencies.createSpeechEngine({
    exec: (command, args, options) => pi.exec(command, args, options),
  });
  let latestSpeechIntent = 0;

  const reserveSpeechIntent = (): number => {
    latestSpeechIntent += 1;
    return latestSpeechIntent;
  };

  const isCurrentSpeechIntent = (intent: number): boolean =>
    intent === latestSpeechIntent;

  const cancelSpeech = (): void => {
    reserveSpeechIntent();
    engine.cancel();
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    const loaded = await dependencies.loadConfig();
    if (!loaded.packageReady) {
      ctx.ui.notify(PACKAGE_CONFIG_UNAVAILABLE, "warning");
      return;
    }

    if (!loaded.config.enable) return;
    if (loaded.hasUserConfigDiagnostics) {
      ctx.ui.notify(USER_CONFIG_INVALID, "warning");
    }

    const [hasApiKey, playerResolved] = await Promise.all([
      dependencies.hasOpenAiCredentials(ctx),
      dependencies.hasPlayer(
        playerCandidatePaths(loaded.config.playerCommand, dependencies.getPath()),
      ),
    ]);
    const readiness = resolveTtsReadiness({
      enable: loaded.config.enable,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      hasApiKey,
      playerResolved,
    });

    for (const notice of readiness.notices) {
      ctx.ui.notify(notice.message, "warning");
    }
  });

  pi.registerCommand("ima:speak", {
    description: "Speak the latest completed assistant response; use /ima:speak stop to cancel.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;

      const command = args.trim();
      const speechIntent = command === "" || command === "stop"
        ? reserveSpeechIntent()
        : undefined;
      const loaded = await dependencies.loadConfig();
      if (speechIntent !== undefined && !isCurrentSpeechIntent(speechIntent)) return;

      if (!loaded.packageReady) {
        ctx.ui.notify(PACKAGE_CONFIG_UNAVAILABLE, "warning");
        return;
      }

      if (!loaded.config.enable) {
        ctx.ui.notify(TTS_DISABLED, "info");
        return;
      }

      if (command === "stop") {
        if (speechIntent === undefined || !isCurrentSpeechIntent(speechIntent)) return;
        engine.cancel();
        ctx.ui.notify(SPEAK_STOPPED, "info");
        return;
      }

      if (command) {
        ctx.ui.notify(SPEAK_USAGE, "warning");
        return;
      }

      if (speechIntent === undefined || !isCurrentSpeechIntent(speechIntent)) return;
      const [apiKey, playerResolved] = await Promise.all([
        dependencies.getOpenAiApiKey(ctx),
        dependencies.hasPlayer(
          playerCandidatePaths(loaded.config.playerCommand, dependencies.getPath()),
        ),
      ]);
      if (!isCurrentSpeechIntent(speechIntent)) return;

      const readiness = resolveTtsReadiness({
        enable: loaded.config.enable,
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        hasApiKey: hasUsableApiKey(apiKey),
        playerResolved,
      });

      for (const notice of readiness.notices) {
        ctx.ui.notify(notice.message, "warning");
      }
      if (!readiness.ready || !hasUsableApiKey(apiKey)) return;
      if (!isCurrentSpeechIntent(speechIntent)) return;

      const text = selectLatestCompletedAssistantText(ctx.sessionManager.getBranch());
      if (!text) {
        ctx.ui.notify(NO_COMPLETED_RESPONSE, "info");
        return;
      }
      if (!isCurrentSpeechIntent(speechIntent)) return;

      const isCurrent = (): boolean => isCurrentSpeechIntent(speechIntent);
      ctx.ui.notify(SPEAK_STARTING, "info");
      startSpeech(
        engine,
        {
          text,
          apiKey,
          model: loaded.config.model,
          voice: loaded.config.voice,
          playerCommand: loaded.config.playerCommand,
        },
        ctx,
        isCurrent,
      );
    },
  });

  pi.on("input", () => {
    cancelSpeech();
  });

  pi.on("session_shutdown", () => {
    cancelSpeech();
  });
}
