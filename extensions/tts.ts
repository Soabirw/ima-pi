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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageConfigPath = join(packageRoot, "config", "tts.json");
const userConfigPath = join(getAgentDir(), "ima", "tts.json");

const PACKAGE_CONFIG_UNAVAILABLE =
  "TTS is unavailable because its bundled configuration could not be loaded.";
const USER_CONFIG_INVALID =
  "TTS configuration contains invalid settings; valid settings were used.";

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
  hasPlayer: (candidatePaths: readonly string[]) => Promise<boolean>;
  getPath: () => string | undefined;
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

const resolveTtsDependencies = (
  overrides: TtsExtensionDependencyOverrides,
): TtsExtensionDependencies => Object.freeze({
  loadConfig: overrides.loadConfig ?? loadTtsConfig,
  hasOpenAiCredentials: overrides.hasOpenAiCredentials ?? hasOpenAiCredentials,
  hasPlayer: overrides.hasPlayer ?? hasPlayer,
  getPath: overrides.getPath ?? (() => process.env.PATH),
});

export default function ttsExtension(
  pi: ExtensionAPI,
  overrides: TtsExtensionDependencyOverrides = {},
) {
  const dependencies = resolveTtsDependencies(overrides);

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
}
