import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const IMA_CONFIG_SCHEMA_VERSION = 1;
export const IMA_MODEL_ROLES = ["HIGH", "MID", "LOW", "vision"] as const;
export const IMA_OPTIONAL_MODEL_ROLES = ["reviewVerify", "adversaryA", "adversaryB", "XHIGH"] as const;
export const IMA_ALL_MODEL_ROLES = [...IMA_MODEL_ROLES, ...IMA_OPTIONAL_MODEL_ROLES] as const;
export const IMA_PHASES = ["brainstorm", "plan", "implement", "test", "review", "resolution", "rereview", "document"] as const;
export const IMA_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ImaRole = (typeof IMA_ALL_MODEL_ROLES)[number];
export type ImaPhase = (typeof IMA_PHASES)[number];
export type ThinkingLevel = (typeof IMA_THINKING_LEVELS)[number];
export type ConfigSource = "package" | "preset" | "user" | "project" | "resolved";
export type ConfigDiagnostic = { code: string; source: ConfigSource; path: string[]; message: string };
export type ImaModelMapping = { provider: string; model: string; thinking?: ThinkingLevel };
export type ImaAgentMapping = ImaModelMapping;
export const IMA_ROLE_SHORTHANDS = ["low", "mid", "high", "xhigh"] as const;
export type RoleShorthand = (typeof IMA_ROLE_SHORTHANDS)[number];
export type ImaCommandMapping = ImaModelMapping | RoleShorthand;
export type ImaRouteMapping = ImaModelMapping | RoleShorthand;
export type ValidConfigLayer = { schemaVersion: 1; profile?: string | null; models?: Partial<Record<ImaRole, ImaModelMapping>>; phases?: Partial<Record<ImaPhase, ImaRouteMapping>>; agents?: Record<string, ImaAgentMapping>; commands?: Partial<Record<string, ImaCommandMapping>> };
export type ConfigValidationResult = { valid: boolean; value: ValidConfigLayer | null; diagnostics: ConfigDiagnostic[] };
export type ResolvedRole = ImaModelMapping & { source: "preset" | "user" | "project" };
export type ResolvedPhase = ImaModelMapping & { source: "preset" | "user" | "project" };
export type ResolvedAgent = ImaAgentMapping & { source: "preset" | "user" | "project" };
export type ResolvedCommand = ImaModelMapping & { source: "preset" | "user" | "project" };
export type ResolvedImaConfig = { schemaVersion: 1; profile: string | null; models: Partial<Record<ImaRole, ResolvedRole>>; phases: Partial<Record<ImaPhase, ResolvedPhase>>; agents: Record<string, ResolvedAgent>; commands: Partial<Record<string, ResolvedCommand>>; complete: boolean; missingRoles: ImaRole[]; sources: { packageDefaults: string; preset: string | null; user: string; project: string }; diagnostics: ConfigDiagnostic[] };
export type ModelCatalogEntry = { provider: string; model: string; input?: { image?: boolean } | string[] };
export type ImaProfile = { name: string; source: "package" | "user" | "project"; path: string; layer: ValidConfigLayer };
export type ImaConfigPaths = { packageDefaults: string; presets: string; user: string; project: string; userProfiles: string; projectProfiles: string };

export const COMMAND_PHASE_FALLBACK: Readonly<Record<string, ImaPhase>> = {
  "resolve-review": "resolution",
  "implement-js": "implement",
  "implement-wp": "implement",
};

const CONFIG_KEYS = new Set(["schemaVersion", "profile", "models", "phases", "agents", "commands"]);
const MAPPING_KEYS = new Set(["provider", "model", "thinking"]);
const ROLE_FOR_SHORTHAND: Readonly<Record<RoleShorthand, ImaRole>> = { low: "LOW", mid: "MID", high: "HIGH", xhigh: "XHIGH" };
const FATAL_CONFIG_CODES = new Set(["config_json_invalid", "config_required_file_missing", "config_schema_version_unsupported", "config_invalid_profile", "config_invalid_agent", "config_preset_unknown", "config_duplicate_profile"]);
export const IMA_PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const IMA_AGENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const diagnostic = (code: string, source: ConfigSource, path: string[], message: string): ConfigDiagnostic => ({ code, source, path, message });
const cloneRole = (role: ImaModelMapping): ImaModelMapping => ({ ...role });
const isMissing = (error: any) => error?.code === "ENOENT";
const isRoleShorthand = (value: unknown): value is RoleShorthand => typeof value === "string" && IMA_ROLE_SHORTHANDS.includes(value as RoleShorthand);
const isKebabCaseName = (value: unknown): value is string => typeof value === "string" && IMA_PROFILE_NAME_PATTERN.test(value);
export const isImaProfileName = isKebabCaseName;
export const isImaAgentName = (value: unknown): value is string => typeof value === "string" && IMA_AGENT_NAME_PATTERN.test(value);
export const isFatalConfigDiagnostic = (entry: ConfigDiagnostic) =>
  FATAL_CONFIG_CODES.has(entry.code) ||
  entry.code.startsWith("config_profile_") ||
  entry.path[0] === "agents" ||
  (entry.path[0] === "models" &&
    (entry.path.length < 2 || IMA_ALL_MODEL_ROLES.includes(entry.path[1] as ImaRole)) &&
    ["config_invalid_model", "config_invalid_provider", "config_invalid_thinking", "config_unknown_key"].includes(entry.code));
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

export function validateConfigLayer(value: unknown, source: ConfigSource): ConfigValidationResult {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!object(value)) return { valid: false, value: null, diagnostics: [diagnostic("config_json_invalid", source, [], "Configuration must be an object.")] };
  for (const key of Object.keys(value)) if (!CONFIG_KEYS.has(key)) diagnostics.push(diagnostic("config_unknown_key", source, [key], "Unknown configuration key."));
  if (value.schemaVersion !== IMA_CONFIG_SCHEMA_VERSION) diagnostics.push(diagnostic("config_schema_version_unsupported", source, ["schemaVersion"], "schemaVersion must be 1."));
  const layer: ValidConfigLayer = { schemaVersion: IMA_CONFIG_SCHEMA_VERSION };
  if ("profile" in value) {
    const profile = typeof value.profile === "string" ? value.profile.trim() : value.profile;
    if (profile !== null && !isImaProfileName(profile)) diagnostics.push(diagnostic("config_invalid_profile", source, ["profile"], "Profile must be lowercase kebab-case or null."));
    else layer.profile = profile as string | null;
  }
  const mapping = (raw: unknown, path: string[], invalidCode: "config_invalid_model" | "config_invalid_phase" | "config_invalid_agent" | "config_invalid_command", allowRoleShorthand: boolean): ImaRouteMapping | null => {
    if (allowRoleShorthand && isRoleShorthand(raw)) return raw;
    if (!object(raw)) {
      diagnostics.push(diagnostic(invalidCode, source, path, allowRoleShorthand ? "Mapping must be an object or role shorthand." : "Mapping must be an object."));
      return null;
    }
    const hasUnknownKey = Object.keys(raw).some((key) => !MAPPING_KEYS.has(key));
    for (const key of Object.keys(raw)) if (!MAPPING_KEYS.has(key)) diagnostics.push(diagnostic("config_unknown_key", source, [...path, key], "Unknown mapping key."));
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    const thinking = raw.thinking;
    if (!provider) diagnostics.push(diagnostic("config_invalid_provider", source, [...path, "provider"], "Provider must be a non-empty string."));
    if (!model) diagnostics.push(diagnostic(invalidCode, source, [...path, "model"], "Model must be a non-empty string."));
    if ("thinking" in raw && !IMA_THINKING_LEVELS.includes(thinking as ThinkingLevel)) diagnostics.push(diagnostic("config_invalid_thinking", source, [...path, "thinking"], "Unsupported thinking level."));
    if (hasUnknownKey || !provider || !model || ("thinking" in raw && !IMA_THINKING_LEVELS.includes(thinking as ThinkingLevel))) return null;
    return { provider, model, ...(typeof thinking === "string" ? { thinking: thinking as ThinkingLevel } : {}) };
  };
  if ("models" in value) {
    if (!object(value.models)) diagnostics.push(diagnostic("config_invalid_model", source, ["models"], "models must be an object."));
    else {
      const models: Partial<Record<ImaRole, ImaModelMapping>> = {};
      for (const [name, raw] of Object.entries(value.models)) {
        if (!IMA_ALL_MODEL_ROLES.includes(name as ImaRole)) { diagnostics.push(diagnostic("config_unknown_role", source, ["models", name], "Unknown model role.")); continue; }
        const parsed = mapping(raw, ["models", name], "config_invalid_model", false);
        if (parsed && typeof parsed !== "string") models[name as ImaRole] = parsed;
      }
      layer.models = models;
    }
  }
  if ("phases" in value) {
    if (!object(value.phases)) diagnostics.push(diagnostic("config_invalid_phase", source, ["phases"], "phases must be an object."));
    else {
      const phases: Partial<Record<ImaPhase, ImaRouteMapping>> = {};
      for (const [name, raw] of Object.entries(value.phases)) {
        if (!IMA_PHASES.includes(name as ImaPhase)) { diagnostics.push(diagnostic("config_unknown_phase", source, ["phases", name], "Unknown phase.")); continue; }
        const parsed = mapping(raw, ["phases", name], "config_invalid_phase", true);
        if (parsed) phases[name as ImaPhase] = parsed;
      }
      layer.phases = phases;
    }
  }
  if ("agents" in value) {
    if (!object(value.agents)) diagnostics.push(diagnostic("config_invalid_agent", source, ["agents"], "agents must be an object."));
    else {
      const agents: Record<string, ImaAgentMapping> = {};
      for (const [name, raw] of Object.entries(value.agents)) {
        if (!isImaAgentName(name)) { diagnostics.push(diagnostic("config_invalid_agent", source, ["agents", name], "Agent name must be lowercase kebab-case and begin with a letter.")); continue; }
        const parsed = mapping(raw, ["agents", name], "config_invalid_agent", false);
        if (parsed && typeof parsed !== "string") agents[name] = parsed;
      }
      layer.agents = agents;
    }
  }
  if ("commands" in value) {
    if (!object(value.commands)) diagnostics.push(diagnostic("config_invalid_command", source, ["commands"], "commands must be an object."));
    else {
      const commandEntries: Array<[string, ImaCommandMapping]> = [];
      for (const [name, raw] of Object.entries(value.commands)) {
        if (!name.trim()) { diagnostics.push(diagnostic("config_invalid_command", source, ["commands", name], "Command name must be non-empty.")); continue; }
        const parsed = mapping(raw, ["commands", name], "config_invalid_command", true);
        if (parsed) commandEntries.push([name, parsed]);
      }
      layer.commands = Object.fromEntries(commandEntries);
    }
  }
  const valid = !diagnostics.some(isFatalConfigDiagnostic);
  return { valid, value: valid ? layer : null, diagnostics };
}

export function resolveSelectedProfile(packageDefaults: ValidConfigLayer, user: ValidConfigLayer | null, project: ValidConfigLayer | null): string | null {
  return project && "profile" in project ? project.profile ?? null : user && "profile" in user ? user.profile ?? null : packageDefaults.profile ?? null;
}

export function mergeConfigLayers(input: { packageDefaults: ValidConfigLayer; preset: ValidConfigLayer | null; user: ValidConfigLayer | null; project: ValidConfigLayer | null }): ResolvedImaConfig {
  const profile = resolveSelectedProfile(input.packageDefaults, input.user, input.project);
  const models: Partial<Record<ImaRole, ResolvedRole>> = {};
  for (const [source, layer] of [["preset", input.preset], ["user", input.user], ["project", input.project]] as const) for (const role of IMA_ALL_MODEL_ROLES) if (layer?.models?.[role]) models[role] = { ...cloneRole(layer.models[role]), source };
  const diagnostics: ConfigDiagnostic[] = [];
  const resolveRouteMapping = (mapping: ImaRouteMapping, source: "preset" | "user" | "project", path: string[]): ResolvedPhase | null => {
    if (typeof mapping !== "string") return { ...cloneRole(mapping), source };
    const role = ROLE_FOR_SHORTHAND[mapping];
    const direct = models[role];
    if (!direct) {
      diagnostics.push(diagnostic("config_route_role_missing", source, path, `Configured ${mapping} role is unavailable.`));
      return null;
    }
    return { ...cloneRole(direct), source };
  };
  const agents: Record<string, ResolvedAgent> = {};
  const phases: Partial<Record<ImaPhase, ResolvedPhase>> = {};
  const commandEntries: Array<[string, ResolvedCommand]> = [];
  for (const [source, layer] of [["preset", input.preset], ["user", input.user], ["project", input.project]] as const) {
    for (const [name, mapping] of Object.entries(layer?.agents ?? {})) agents[name] = { ...cloneRole(mapping), source };
    for (const phase of IMA_PHASES) {
      const mapping = layer?.phases?.[phase];
      if (!mapping) continue;
      const resolved = resolveRouteMapping(mapping, source, ["phases", phase]);
      if (resolved) phases[phase] = resolved;
    }
    for (const [command, mapping] of Object.entries(layer?.commands ?? {})) {
      if (!mapping) continue;
      const resolved = resolveRouteMapping(mapping, source, ["commands", command]);
      if (resolved) commandEntries.push([command, resolved]);
    }
  }
  const commands = Object.fromEntries(commandEntries);
  const missingRoles = IMA_MODEL_ROLES.filter((role) => !models[role]);
  if (missingRoles.length) diagnostics.push(diagnostic("config_incomplete", "resolved", ["models"], "All model roles require explicit mappings."));
  return { schemaVersion: 1, profile, models, phases, agents, commands, complete: !missingRoles.length, missingRoles, sources: { packageDefaults: "package", preset: profile, user: "user", project: "project" }, diagnostics };
}

export function resolveCommandRoute(config: Pick<ResolvedImaConfig, "commands" | "phases"> | null | undefined, commandName: string): ImaModelMapping | null {
  const name = commandName.trim();
  if (!name) return null;
  const commands = config?.commands;
  const command = commands && Object.hasOwn(commands, name) ? commands[name] : undefined;
  const phase = Object.hasOwn(COMMAND_PHASE_FALLBACK, name)
    ? COMMAND_PHASE_FALLBACK[name]
    : (IMA_PHASES.includes(name as ImaPhase) ? name as ImaPhase : null);
  const mapping = command ?? (phase ? config?.phases?.[phase] : undefined);
  return mapping ? { provider: mapping.provider, model: mapping.model, ...(mapping.thinking ? { thinking: mapping.thinking } : {}) } : null;
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
  const mappings: Array<{ path: string[]; mapping: ImaModelMapping; role?: ImaRole }> = [];
  for (const role of IMA_ALL_MODEL_ROLES) if (config.models[role]) mappings.push({ path: ["models", role], mapping: config.models[role]!, role });
  for (const phase of IMA_PHASES) if (config.phases[phase]) mappings.push({ path: ["phases", phase], mapping: config.phases[phase]! });
  for (const [name, mapping] of Object.entries(config.agents)) mappings.push({ path: ["agents", name], mapping });
  for (const [command, mapping] of Object.entries(config.commands)) if (mapping) mappings.push({ path: ["commands", command], mapping });
  for (const { path, mapping, role } of mappings) {
    const entry = catalog.find((item) => item.provider === mapping.provider && item.model === mapping.model);
    if (!entry) { diagnostics.push(diagnostic("config_model_unavailable", "resolved", path, "Configured model is unavailable.")); continue; }
    const image = Array.isArray(entry.input) ? entry.input.includes("image") : entry.input?.image === true;
    if (role === "vision" && !image) diagnostics.push(diagnostic("config_vision_not_supported", "resolved", path, "Vision model must support image input."));
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function deriveImaConfigPaths(input: { packageRoot: string; agentDir: string; cwd: string }): ImaConfigPaths {
  return {
    packageDefaults: join(input.packageRoot, "config", "defaults.json"),
    presets: join(input.packageRoot, "config", "presets"),
    user: join(input.agentDir, "ima", "config.json"),
    project: join(input.cwd, ".pi", "ima", "config.json"),
    userProfiles: join(input.agentDir, "ima", "profiles"),
    projectProfiles: join(input.cwd, ".pi", "ima", "profiles"),
  };
}

const optionalRead = async (path: string, readText: (path: string) => Promise<string>) => { try { return await readText(path); } catch (error: any) { if (isMissing(error)) return null; throw error; } };
const sourceFor = (source: ImaProfile["source"]): ConfigSource => source === "package" ? "preset" : source;

type ProfileDependencies = { readText: (path: string) => Promise<string>; readDirectory: (path: string) => Promise<unknown[]>; resolvePath: (path: string) => Promise<string>; stat: (path: string) => Promise<{ isFile(): boolean }> };
const defaultProfileDependencies = (): ProfileDependencies => ({ readText: (path) => readFile(path, "utf8"), readDirectory: async (path) => await readdir(path) as unknown[], resolvePath: realpath, stat: lstat });

async function discoverProfileDirectory(input: { directory: string; source: ImaProfile["source"]; dependencies: ProfileDependencies }) {
  const diagnostics: ConfigDiagnostic[] = [];
  let names: unknown[];
  try { names = await input.dependencies.readDirectory(input.directory); } catch (error) { if (isMissing(error)) return { profiles: [], diagnostics }; diagnostics.push(diagnostic("config_profile_directory_unreadable", sourceFor(input.source), ["profiles"], "Profile directory cannot be read.")); return { profiles: [], diagnostics }; }
  let directoryReal: string;
  try { directoryReal = await input.dependencies.resolvePath(input.directory); } catch { diagnostics.push(diagnostic("config_profile_directory_unreadable", sourceFor(input.source), ["profiles"], "Profile directory cannot be resolved.")); return { profiles: [], diagnostics }; }
  if (directoryReal !== resolve(input.directory)) { diagnostics.push(diagnostic("config_profile_directory_unsafe", sourceFor(input.source), ["profiles"], "Profile directory must not be a symlink.")); return { profiles: [], diagnostics }; }
  const profiles: ImaProfile[] = [];
  const local = new Set<string>();
  for (const entry of names.map((value) => typeof value === "string" ? value : (value as { name?: string })?.name ?? "").filter((value) => value.endsWith(".json")).sort()) {
    const name = basename(entry, ".json");
    const path = join(input.directory, entry);
    if (entry !== basename(entry) || !isImaProfileName(name)) { diagnostics.push(diagnostic("config_profile_name_invalid", sourceFor(input.source), ["profiles", entry], "Profile filename must be lowercase kebab-case.")); continue; }
    if (local.has(name)) { diagnostics.push(diagnostic("config_duplicate_profile", sourceFor(input.source), ["profiles", name], "Duplicate profile definition.")); continue; }
    local.add(name);
    try {
      const info = await input.dependencies.stat(path); const resolved = await input.dependencies.resolvePath(path);
      if (!info.isFile() || !inside(directoryReal, resolved)) { diagnostics.push(diagnostic("config_profile_path_unsafe", sourceFor(input.source), ["profiles", name], "Profile must be a regular file inside its source directory.")); continue; }
      const parsed = validateConfigLayer(JSON.parse(await input.dependencies.readText(path)), sourceFor(input.source));
      diagnostics.push(...parsed.diagnostics);
      if (parsed.value) profiles.push({ name, source: input.source, path, layer: parsed.value });
    } catch (error: any) {
      diagnostics.push(diagnostic(error?.code === "ENOENT" ? "config_profile_missing" : "config_profile_unreadable", sourceFor(input.source), ["profiles", name], "Profile cannot be read safely."));
    }
  }
  return { profiles, diagnostics };
}

export async function discoverImaProfiles(input: { paths: ImaConfigPaths; projectTrusted: boolean; readText?: (path: string) => Promise<string>; readDirectory?: (path: string) => Promise<unknown[]>; resolvePath?: (path: string) => Promise<string>; stat?: (path: string) => Promise<{ isFile(): boolean }> }) {
  const defaults = defaultProfileDependencies();
  const dependencies: ProfileDependencies = {
    readText: input.readText ?? defaults.readText,
    readDirectory: input.readDirectory ?? defaults.readDirectory,
    resolvePath: input.resolvePath ?? defaults.resolvePath,
    stat: input.stat ?? defaults.stat,
  };
  const diagnostics: ConfigDiagnostic[] = []; const selected = new Map<string, ImaProfile>();
  const directories: Array<{ source: ImaProfile["source"]; directory: string; enabled: boolean }> = [
    { source: "project", directory: input.paths.projectProfiles, enabled: input.projectTrusted },
    { source: "user", directory: input.paths.userProfiles, enabled: true },
    { source: "package", directory: input.paths.presets, enabled: true },
  ];
  for (const item of directories) if (item.enabled) {
    const result = await discoverProfileDirectory({ directory: item.directory, source: item.source, dependencies });
    diagnostics.push(...result.diagnostics);
    for (const profile of result.profiles) if (!selected.has(profile.name)) selected.set(profile.name, profile);
  }
  return { profiles: [...selected.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics, paths: input.paths };
}

export async function loadImaConfig(input: { packageRoot: string; agentDir: string; cwd: string; projectTrusted: boolean; profileOverride?: string | null; readText?: (path: string) => Promise<string>; readDirectory?: (path: string) => Promise<unknown[]>; resolvePath?: (path: string) => Promise<string>; stat?: (path: string) => Promise<{ isFile(): boolean }> }) {
  const paths = deriveImaConfigPaths(input);
  const readText = input.readText ?? ((path: string) => readFile(path, "utf8"));
  const readDirectory = input.readDirectory ?? defaultProfileDependencies().readDirectory;
  const diagnostics: ConfigDiagnostic[] = [];
  const parse = (text: string | null, source: ConfigSource, required = false): ValidConfigLayer | null => {
    if (text === null) {
      if (required) diagnostics.push(diagnostic("config_required_file_missing", source, [], "Required configuration file is missing."));
      return null;
    }
    try {
      const parsed = validateConfigLayer(JSON.parse(text), source);
      diagnostics.push(...parsed.diagnostics);
      return parsed.value;
    } catch {
      diagnostics.push(diagnostic("config_json_invalid", source, [], "Configuration JSON is invalid."));
      return null;
    }
  };
  const defaults = parse(await optionalRead(paths.packageDefaults, readText), "package", true);
  const user = parse(await optionalRead(paths.user, readText), "user");
  const project = input.projectTrusted ? parse(await optionalRead(paths.project, readText), "project") : null;
  const profiles = await discoverImaProfiles({ paths, projectTrusted: input.projectTrusted, readText, readDirectory, resolvePath: input.resolvePath, stat: input.stat });
  diagnostics.push(...profiles.diagnostics);
  if (!defaults || diagnostics.some(isFatalConfigDiagnostic)) return { config: null, diagnostics, paths, profiles: profiles.profiles };
  const selectedProfile = input.profileOverride === undefined ? resolveSelectedProfile(defaults, user, project) : input.profileOverride;
  if (selectedProfile !== null && !isImaProfileName(selectedProfile)) diagnostics.push(diagnostic("config_invalid_profile", "resolved", ["profile"], "Profile must be lowercase kebab-case or null."));
  let preset: ValidConfigLayer | null = null;
  if (selectedProfile) {
    let selected = profiles.profiles.find((profile) => profile.name === selectedProfile);
    if (!selected) {
      const candidates: Array<{ source: ConfigSource; path: string }> = [
        ...(input.projectTrusted ? [{ source: "project" as const, path: join(paths.projectProfiles, `${selectedProfile}.json`) }] : []),
        { source: "user", path: join(paths.userProfiles, `${selectedProfile}.json`) },
        { source: "preset", path: join(paths.presets, `${selectedProfile}.json`) },
      ];
      for (const candidate of candidates) {
        const text = await optionalRead(candidate.path, readText);
        if (text !== null) {
          const parsed = parse(text, candidate.source, true);
          if (parsed) {
            preset = parsed;
            selected = { name: selectedProfile, source: candidate.source === "preset" ? "package" : candidate.source, path: candidate.path, layer: parsed };
          }
          break;
        }
      }
    } else preset = selected.layer;
    if (!selected) diagnostics.push(diagnostic("config_preset_unknown", "preset", ["profile"], "Selected preset is unavailable."));
  }
  if (diagnostics.some(isFatalConfigDiagnostic)) return { config: null, diagnostics, paths, profiles: profiles.profiles };
  const merged = mergeConfigLayers({ packageDefaults: defaults, preset, user, project });
  const commands = Object.fromEntries(Object.entries(merged.commands));
  if (Object.keys(commands).length) {
    try {
      const names = await readDirectory(join(input.packageRoot, "prompts"));
      const known = new Set(names
        .map((entry) => typeof entry === "string" ? entry : object(entry) && typeof entry.name === "string" ? entry.name : "")
        .map((entry) => entry.match(/^ima:([a-z0-9][a-z0-9-]*)\.md$/)?.[1] ?? "")
        .filter(Boolean));
      for (const [name, mapping] of Object.entries(commands)) {
        if (isRoleShorthand(name) || known.has(name)) continue;
        diagnostics.push(diagnostic("config_unknown_command", mapping.source, ["commands", name], "Command does not match a packaged IMA prompt or role selector."));
        delete commands[name];
      }
    } catch {}
  }
  diagnostics.push(...merged.diagnostics);
  const config: ResolvedImaConfig = {
    ...merged,
    commands,
    profile: selectedProfile,
    sources: { ...merged.sources, preset: selectedProfile },
    diagnostics,
  };
  return { config, diagnostics, paths, profiles: profiles.profiles };
}
