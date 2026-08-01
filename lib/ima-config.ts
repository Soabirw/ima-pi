import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const IMA_CONFIG_SCHEMA_VERSION = 1;
export const IMA_MODEL_ROLES = ["HIGH", "MID", "LOW", "vision"] as const;
export const IMA_OPTIONAL_MODEL_ROLES = ["reviewVerify"] as const;
export const IMA_ALL_MODEL_ROLES = [...IMA_MODEL_ROLES, ...IMA_OPTIONAL_MODEL_ROLES] as const;
export const IMA_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ImaRole = (typeof IMA_ALL_MODEL_ROLES)[number];
type ThinkingLevel = (typeof IMA_THINKING_LEVELS)[number];
export type ConfigSource = "package" | "preset" | "user" | "project" | "resolved";
export type ConfigDiagnostic = { code: string; source: ConfigSource; path: string[]; message: string };
type ImaModelMapping = { provider: string; model: string; thinking?: ThinkingLevel };
export type ValidConfigLayer = { schemaVersion: 1; profile?: string | null; models?: Partial<Record<ImaRole, ImaModelMapping>> };
export type ConfigValidationResult = { valid: boolean; value: ValidConfigLayer | null; diagnostics: ConfigDiagnostic[] };
type ResolvedRole = ImaModelMapping & { source: "preset" | "user" | "project" };
export type ResolvedImaConfig = { schemaVersion: 1; profile: string | null; models: Partial<Record<ImaRole, ResolvedRole>>; complete: boolean; missingRoles: ImaRole[]; sources: { packageDefaults: string; preset: string | null; user: string; project: string }; diagnostics: ConfigDiagnostic[] };
export type ModelCatalogEntry = { provider: string; model: string; input?: { image?: boolean } | string[] };

const diagnostic = (code: string, source: ConfigSource, path: string[], message: string): ConfigDiagnostic => ({ code, source, path, message });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const cloneRole = (role: ImaModelMapping): ImaModelMapping => ({ ...role });

export function validateConfigLayer(value: unknown, source: ConfigSource): ConfigValidationResult {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!object(value)) return { valid: false, value: null, diagnostics: [diagnostic("config_json_invalid", source, [], "Configuration must be an object.")] };
  for (const key of Object.keys(value)) if (!new Set(["schemaVersion", "profile", "models"]).has(key)) diagnostics.push(diagnostic("config_unknown_key", source, [key], "Unknown configuration key."));
  if (value.schemaVersion !== IMA_CONFIG_SCHEMA_VERSION) diagnostics.push(diagnostic("config_schema_version_unsupported", source, ["schemaVersion"], "schemaVersion must be 1."));
  const layer: ValidConfigLayer = { schemaVersion: IMA_CONFIG_SCHEMA_VERSION };
  if ("profile" in value) {
    if (value.profile !== null && (typeof value.profile !== "string" || !value.profile.trim())) diagnostics.push(diagnostic("config_invalid_profile", source, ["profile"], "Profile must be a non-empty string or null."));
    else layer.profile = typeof value.profile === "string" ? value.profile.trim() : value.profile as null;
  }
  if ("models" in value) {
    if (!object(value.models)) diagnostics.push(diagnostic("config_invalid_model", source, ["models"], "Models must be an object."));
    else {
      const models: Partial<Record<ImaRole, ImaModelMapping>> = {};
      for (const [role, raw] of Object.entries(value.models)) {
        if (!IMA_ALL_MODEL_ROLES.includes(role as ImaRole)) { diagnostics.push(diagnostic("config_unknown_role", source, ["models", role], "Unknown model role.")); continue; }
        if (!object(raw)) { diagnostics.push(diagnostic("config_invalid_model", source, ["models", role], "Role must be an object.")); continue; }
        for (const key of Object.keys(raw)) if (!new Set(["provider", "model", "thinking"]).has(key)) diagnostics.push(diagnostic("config_unknown_key", source, ["models", role, key], "Unknown role key."));
        const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
        const model = typeof raw.model === "string" ? raw.model.trim() : "";
        if (!provider) diagnostics.push(diagnostic("config_invalid_provider", source, ["models", role, "provider"], "Provider must be a non-empty string."));
        if (!model) diagnostics.push(diagnostic("config_invalid_model", source, ["models", role, "model"], "Model must be a non-empty string."));
        if ("thinking" in raw && !IMA_THINKING_LEVELS.includes(raw.thinking as ThinkingLevel)) diagnostics.push(diagnostic("config_invalid_thinking", source, ["models", role, "thinking"], "Unsupported thinking level."));
        if (provider && model && (!("thinking" in raw) || IMA_THINKING_LEVELS.includes(raw.thinking as ThinkingLevel))) models[role as ImaRole] = { provider, model, ...(typeof raw.thinking === "string" ? { thinking: raw.thinking as ThinkingLevel } : {}) };
      }
      layer.models = models;
    }
  }
  return { valid: diagnostics.length === 0, value: diagnostics.length === 0 ? layer : null, diagnostics };
}

export function resolveSelectedProfile(packageDefaults: ValidConfigLayer, user: ValidConfigLayer | null, project: ValidConfigLayer | null): string | null {
  return project && "profile" in project ? project.profile ?? null : user && "profile" in user ? user.profile ?? null : packageDefaults.profile ?? null;
}

export function mergeConfigLayers(input: { packageDefaults: ValidConfigLayer; preset: ValidConfigLayer | null; user: ValidConfigLayer | null; project: ValidConfigLayer | null }): ResolvedImaConfig {
  const profile = resolveSelectedProfile(input.packageDefaults, input.user, input.project);
  const models: Partial<Record<ImaRole, ResolvedRole>> = {};
  for (const [source, layer] of [["preset", input.preset], ["user", input.user], ["project", input.project]] as const) for (const role of IMA_ALL_MODEL_ROLES) if (layer?.models?.[role]) models[role] = { ...cloneRole(layer.models[role]), source };
  const missingRoles = IMA_MODEL_ROLES.filter((role) => !models[role]);
  const diagnostics = missingRoles.length ? [diagnostic("config_incomplete", "resolved", ["models"], "All model roles require explicit mappings.")] : [];
  return { schemaVersion: 1, profile, models, complete: !missingRoles.length, missingRoles, sources: { packageDefaults: "package", preset: profile, user: "user", project: "project" }, diagnostics };
}

export function resolveNamedResources<T extends { name: string }>(input: { packageResources: T[]; userResources: T[]; projectResources: T[] }): Array<T & { source: "package" | "user" | "project" }> {
  const seen = new Set<string>(); const result: Array<T & { source: "package" | "user" | "project" }> = [];
  for (const [source, resources] of [["project", input.projectResources], ["user", input.userResources], ["package", input.packageResources]] as const) {
    const local = new Set<string>();
    for (const resource of resources) { if (local.has(resource.name)) throw new Error(`config_duplicate_resource:${source}:${resource.name}`); local.add(resource.name); if (!seen.has(resource.name)) { seen.add(resource.name); result.push({ ...structuredClone(resource), source }); } }
  }
  return result;
}

export function validateModelCatalog(config: ResolvedImaConfig, catalog: ModelCatalogEntry[]) {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const role of IMA_ALL_MODEL_ROLES) {
    const mapping = config.models[role]; if (!mapping) continue;
    const entry = catalog.find((item) => item.provider === mapping.provider && item.model === mapping.model);
    if (!entry) { diagnostics.push(diagnostic("config_model_unavailable", "resolved", ["models", role], "Configured model is unavailable.")); continue; }
    const image = Array.isArray(entry.input) ? entry.input.includes("image") : entry.input?.image === true;
    if (role === "vision" && !image) diagnostics.push(diagnostic("config_vision_not_supported", "resolved", ["models", role], "Vision model must support image input."));
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export type ImaConfigPaths = { packageDefaults: string; presets: string; user: string; project: string };
export function deriveImaConfigPaths(input: { packageRoot: string; agentDir: string; cwd: string }): ImaConfigPaths { return { packageDefaults: join(input.packageRoot, "config", "defaults.json"), presets: join(input.packageRoot, "config", "presets"), user: join(input.agentDir, "ima", "config.json"), project: join(input.cwd, ".pi", "ima", "config.json") }; }
const optionalRead = async (path: string, readText: (path: string) => Promise<string>) => { try { return await readText(path); } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; } };
export async function loadImaConfig(input: { packageRoot: string; agentDir: string; cwd: string; projectTrusted: boolean; readText?: (path: string) => Promise<string> }) {
  const paths = deriveImaConfigPaths(input); const readText = input.readText ?? ((path) => readFile(path, "utf8")); const diagnostics: ConfigDiagnostic[] = [];
  const parse = (text: string | null, source: ConfigSource, required = false): ValidConfigLayer | null => { if (text === null) { if (required) diagnostics.push(diagnostic("config_required_file_missing", source, [], "Required configuration file is missing.")); return null; } try { const parsed = validateConfigLayer(JSON.parse(text), source); diagnostics.push(...parsed.diagnostics); return parsed.value; } catch { diagnostics.push(diagnostic("config_json_invalid", source, [], "Configuration JSON is invalid.")); return null; } };
  const defaults = parse(await optionalRead(paths.packageDefaults, readText), "package", true); const user = parse(await optionalRead(paths.user, readText), "user"); const project = input.projectTrusted ? parse(await optionalRead(paths.project, readText), "project") : null;
  if (!defaults || diagnostics.length) return { config: null, diagnostics, paths };
  const profile = resolveSelectedProfile(defaults, user, project); let preset: ValidConfigLayer | null = null;
  if (profile) { const presetPath = join(paths.presets, `${profile}.json`); const text = await optionalRead(presetPath, readText); if (text === null) diagnostics.push(diagnostic("config_preset_unknown", "preset", ["profile"], "Selected preset is unavailable.")); else preset = parse(text, "preset", true); }
  if (diagnostics.length) return { config: null, diagnostics, paths };
  return { config: mergeConfigLayers({ packageDefaults: defaults, preset, user, project }), diagnostics: [], paths };
}
