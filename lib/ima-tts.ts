import { delimiter, isAbsolute, join } from "node:path";

export type TtsConfig = Readonly<{
  enable: boolean;
  autoSpeak: boolean;
  provider: "openai";
  model: string;
  voice: string;
  playerCommand: string;
}>;

export type TtsConfigLayer = Readonly<Partial<TtsConfig>>;
type MutableTtsConfigLayer = { -readonly [Key in keyof TtsConfig]?: TtsConfig[Key] };

export type TtsConfigDiagnostic = Readonly<{
  code:
    | "tts_config_invalid_object"
    | "tts_config_unknown_key"
    | "tts_config_invalid_boolean"
    | "tts_config_invalid_provider"
    | "tts_config_invalid_string";
  path: readonly string[];
}>;

export type ParsedTtsConfigLayer = Readonly<{
  values: TtsConfigLayer;
  diagnostics: readonly TtsConfigDiagnostic[];
}>;

export type TtsReadinessNotice = Readonly<{
  code: "tts_openai_credentials_missing" | "tts_player_missing";
  message: string;
}>;

export type TtsReadiness = Readonly<{
  active: boolean;
  ready: boolean;
  notices: readonly TtsReadinessNotice[];
}>;

export const TTS_CONFIG_DEFAULTS: TtsConfig = Object.freeze({
  enable: false,
  autoSpeak: false,
  provider: "openai",
  model: "gpt-4o-mini-tts",
  voice: "alloy",
  playerCommand: "ffplay",
});

export const TTS_CONFIG_KEYS = Object.freeze([
  "enable",
  "autoSpeak",
  "provider",
  "model",
  "voice",
  "playerCommand",
] as const);

const OPENAI_CREDENTIALS_MISSING: TtsReadinessNotice = Object.freeze({
  code: "tts_openai_credentials_missing",
  message:
    "TTS is enabled, but OpenAI credentials are unavailable. "
    + "Configure Pi authentication or OPENAI_API_KEY.",
});

const PLAYER_MISSING: TtsReadinessNotice = Object.freeze({
  code: "tts_player_missing",
  message: "TTS is enabled, but its configured audio player is unavailable.",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const diagnostic = (
  code: TtsConfigDiagnostic["code"],
  path: readonly string[],
): TtsConfigDiagnostic => Object.freeze({ code, path: Object.freeze([...path]) });

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
};

const isPlayerCommand = (value: string): boolean => {
  if (!value || value === "." || value === "..") return false;
  return isAbsolute(value) || (!value.includes("/") && !value.includes("\\"));
};

export const parseTtsConfigLayer = (raw: unknown): ParsedTtsConfigLayer => {
  if (!isRecord(raw)) {
    return Object.freeze({
      values: Object.freeze({}),
      diagnostics: Object.freeze([diagnostic("tts_config_invalid_object", [])]),
    });
  }

  const values: MutableTtsConfigLayer = {};
  const diagnostics: TtsConfigDiagnostic[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (!TTS_CONFIG_KEYS.includes(key as typeof TTS_CONFIG_KEYS[number])) {
      diagnostics.push(diagnostic("tts_config_unknown_key", [key]));
      continue;
    }

    if (key === "enable" || key === "autoSpeak") {
      if (typeof value === "boolean") values[key] = value;
      else diagnostics.push(diagnostic("tts_config_invalid_boolean", [key]));
      continue;
    }

    if (key === "provider") {
      if (nonEmptyString(value) === "openai") values.provider = "openai";
      else diagnostics.push(diagnostic("tts_config_invalid_provider", [key]));
      continue;
    }

    const normalized = nonEmptyString(value);
    if (!normalized) {
      diagnostics.push(diagnostic("tts_config_invalid_string", [key]));
      continue;
    }

    if (key === "playerCommand") {
      if (isPlayerCommand(normalized)) values.playerCommand = normalized;
      else diagnostics.push(diagnostic("tts_config_invalid_string", [key]));
      continue;
    }

    if (key === "model") values.model = normalized;
    if (key === "voice") values.voice = normalized;
  }

  return Object.freeze({
    values: Object.freeze({ ...values }),
    diagnostics: Object.freeze([...diagnostics]),
  });
};

export const mergeTtsConfig = (
  defaults: TtsConfig,
  override: TtsConfigLayer = {},
): TtsConfig => Object.freeze({
  enable: override.enable ?? defaults.enable,
  autoSpeak: override.autoSpeak ?? defaults.autoSpeak,
  provider: override.provider ?? defaults.provider,
  model: override.model ?? defaults.model,
  voice: override.voice ?? defaults.voice,
  playerCommand: override.playerCommand ?? defaults.playerCommand,
});

export const hasCompleteTtsConfigLayer = (layer: TtsConfigLayer): boolean =>
  TTS_CONFIG_KEYS.every((key) => layer[key] !== undefined);

export const playerCandidatePaths = (
  playerCommand: string,
  pathEnv: string | undefined,
): readonly string[] => {
  const command = playerCommand.trim();
  if (!isPlayerCommand(command)) return Object.freeze([]);
  if (isAbsolute(command)) return Object.freeze([command]);

  return Object.freeze(
    (pathEnv ?? "")
      .split(delimiter)
      .filter((directory) => directory.length > 0)
      .map((directory) => join(directory, command)),
  );
};

export const resolveTtsReadiness = ({
  enable,
  mode,
  hasUI,
  hasApiKey,
  playerResolved,
}: Readonly<{
  enable: boolean;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  hasApiKey: boolean;
  playerResolved: boolean;
}>): TtsReadiness => {
  const active = enable && mode === "tui" && hasUI;
  if (!active) {
    return Object.freeze({
      active: false,
      ready: false,
      notices: Object.freeze([]),
    });
  }

  const notices = [
    ...(!hasApiKey ? [OPENAI_CREDENTIALS_MISSING] : []),
    ...(!playerResolved ? [PLAYER_MISSING] : []),
  ];

  return Object.freeze({
    active: true,
    ready: notices.length === 0,
    notices: Object.freeze(notices),
  });
};
