import { utf8ByteLength } from "./qdrant-corpus.ts";

export const LIFECYCLE_PROVIDER_NAMES = [
  "bookstack",
  "qdrant",
  "serena",
  "markdown",
] as const;

export const LIFECYCLE_PROVIDER_PRIORITY = [...LIFECYCLE_PROVIDER_NAMES] as const;

export const LIFECYCLE_PROVIDER_PREFERENCE_SOURCES = [
  "session",
  "project",
  "serena",
  "global",
  "historical-qdrant",
  "default",
] as const;

export type LifecycleProviderName = (typeof LIFECYCLE_PROVIDER_NAMES)[number];
export type LifecycleProviderPreferenceSource =
  (typeof LIFECYCLE_PROVIDER_PREFERENCE_SOURCES)[number];

export type LifecycleProviderPreference = {
  provider: LifecycleProviderName;
  source: Exclude<LifecycleProviderPreferenceSource, "default" | "historical-qdrant">;
};

export type LifecycleProviderRecommendation = {
  provider: LifecycleProviderName;
  source: LifecycleProviderPreferenceSource;
  candidates: LifecycleProviderName[];
  bookStackSharing: boolean;
};

export type LifecycleProviderPreferenceInputs = {
  session?: unknown;
  project?: unknown;
  serena?: unknown;
  global?: unknown;
};

export type LifecycleProviderRecommendationResult =
  | { ok: true; recommendation: LifecycleProviderRecommendation }
  | { ok: false; code: "lifecycle_provider_preference_invalid"; source: Exclude<LifecycleProviderPreferenceSource, "default" | "historical-qdrant"> };

const PROVIDER_SET = new Set<string>(LIFECYCLE_PROVIDER_NAMES);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const PREFERENCE_SOURCES: Exclude<LifecycleProviderPreferenceSource, "default" | "historical-qdrant">[] = [
  "session",
  "project",
  "serena",
  "global",
];

const dataRecord = (
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length !== fields.length
      || !fields.every((field) => keys.includes(field))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
  } catch {
    return null;
  }
};

export const normalizeLifecycleProvider = (
  value: unknown,
): LifecycleProviderName | null => {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) return null;
  const provider = value.trim().toLowerCase();
  return provider && utf8ByteLength(provider) <= 32 && PROVIDER_SET.has(provider)
    ? provider as LifecycleProviderName
    : null;
};

const preferenceProvider = (value: unknown): LifecycleProviderName | null => {
  if (typeof value === "string") return normalizeLifecycleProvider(value);
  const preference = dataRecord(value, ["provider"]);
  return preference ? normalizeLifecycleProvider(preference.provider) : null;
};

export const projectLifecycleProviderPreference = (
  value: unknown,
  source: Exclude<LifecycleProviderPreferenceSource, "default" | "historical-qdrant">,
): LifecycleProviderPreference | null => {
  const provider = preferenceProvider(value);
  return provider ? { provider, source } : null;
};

export const lifecycleProviderCandidates = (
  provider: LifecycleProviderName,
): LifecycleProviderName[] => [
  provider,
  ...LIFECYCLE_PROVIDER_PRIORITY.filter((candidate) => candidate !== provider),
];

export const lifecycleProviderRecommendation = (
  provider: LifecycleProviderName,
  source: LifecycleProviderPreferenceSource,
): LifecycleProviderRecommendation => ({
  provider,
  source,
  candidates: lifecycleProviderCandidates(provider),
  bookStackSharing: provider === "bookstack",
});

/**
 * Resolves only supplied preference values. A malformed higher-precedence
 * value blocks instead of silently selecting a lower-precedence provider.
 */
export const resolveLifecycleProviderRecommendation = (
  input: LifecycleProviderPreferenceInputs = {},
): LifecycleProviderRecommendationResult => {
  for (const source of PREFERENCE_SOURCES) {
    const value = input[source];
    if (value === undefined) continue;
    const preference = projectLifecycleProviderPreference(value, source);
    if (!preference) {
      return { ok: false, code: "lifecycle_provider_preference_invalid", source };
    }
    return {
      ok: true,
      recommendation: lifecycleProviderRecommendation(preference.provider, source),
    };
  }
  return {
    ok: true,
    recommendation: lifecycleProviderRecommendation("bookstack", "default"),
  };
};

export const selectLifecycleProvider = (input: {
  recommendation: LifecycleProviderRecommendation;
  provider: unknown;
}): LifecycleProviderName | null => {
  const provider = normalizeLifecycleProvider(input.provider);
  return provider && input.recommendation.candidates.includes(provider)
    ? provider
    : null;
};

export const lifecycleProviderSharingNotice = (
  provider: LifecycleProviderName,
): string => provider === "bookstack"
  ? "BookStack stores lifecycle evidence in shared organization-visible content; only the user may approve that placement."
  : "This provider does not make a BookStack sharing decision.";
