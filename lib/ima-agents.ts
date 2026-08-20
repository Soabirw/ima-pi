import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, parse, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { IMA_PHASES, type ImaPhase } from "./ima-config.ts";

export const IMA_AGENT_SCHEMA_VERSION = 1;
export const IMA_AGENT_TIERS = ["HIGH", "MID", "LOW", "vision", "reviewVerify", "adversaryA", "adversaryB"] as const;
export const IMA_AGENT_AUTHORITIES = ["read", "write", "test-write", "review-read", "vision-read", "document-write"] as const;
export const IMA_AGENT_RESULT_KINDS = ["evidence", "implementation", "test", "review", "vision", "documentation"] as const;
export const IMA_AGENT_TOOLS = ["read", "grep", "find", "ls", "write", "edit", "bash", "test", "image"] as const;
export const IMA_AGENT_USE_WHEN_MIN_ITEMS = 1;
export const IMA_AGENT_USE_WHEN_MAX_ITEMS = 3;
export const IMA_AGENT_USE_WHEN_MAX_LENGTH = 180;

type AgentTier = (typeof IMA_AGENT_TIERS)[number];
type AgentAuthority = (typeof IMA_AGENT_AUTHORITIES)[number];
type AgentResultKind = (typeof IMA_AGENT_RESULT_KINDS)[number];
export type AgentSource = "package" | "user" | "project";
export type AgentDiagnostic = { code: string; source: AgentSource; path: string; message: string };
export type AgentDefinition = {
  schemaVersion: 1;
  name: string;
  description: string;
  useWhen: string[];
  tier: AgentTier;
  phase?: ImaPhase;
  authority: AgentAuthority;
  tools: string[];
  skills: string[];
  delegation: { allowed: boolean; maxDepth: number };
  independence: { freshInitial: boolean; followUpAllowed: boolean };
  result: { kind: AgentResultKind; requiredSections: string[]; format?: "review-verdict-v1" };
  escalation: string[];
  prompt: string;
  source: AgentSource;
  path: string;
};
export type AgentParseResult = { definition: AgentDefinition | null; diagnostics: AgentDiagnostic[] };
export type ImaAgentPaths = { packageAgents: string; userAgents: string; projectAgents: string };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const diagnostic = (code: string, source: AgentSource, path: string, message: string): AgentDiagnostic => ({ code, source, path, message });
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()) : null;
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const inList = <T extends readonly string[]>(list: T, value: string): value is T[number] => list.includes(value);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const withoutControlCharacters = (value: string) => value.split(CONTROL_CHARACTERS).join(" ");

const normalizeExplicitUseWhen = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length < IMA_AGENT_USE_WHEN_MIN_ITEMS || value.length > IMA_AGENT_USE_WHEN_MAX_ITEMS) return null;
  const cues: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || CONTROL_CHARACTERS.test(item)) return null;
    const cue = item.trim();
    if (!cue || cue.length > IMA_AGENT_USE_WHEN_MAX_LENGTH) return null;
    cues.push(cue);
  }
  return cues;
};

const normalizeLegacyUseWhen = (description: string): string[] | null => {
  const cue = withoutControlCharacters(description).replace(/\s+/g, " ").trim().slice(0, IMA_AGENT_USE_WHEN_MAX_LENGTH);
  return cue ? [cue] : null;
};

export function deriveAgentPaths(input: { packageRoot: string; agentDir: string; cwd: string }): ImaAgentPaths {
  return { packageAgents: join(input.packageRoot, "agents"), userAgents: join(input.agentDir, "ima", "agents"), projectAgents: join(input.cwd, ".pi", "ima", "agents") };
}

export function validateAgentDefinition(input: { path: string; source: AgentSource; metadata: unknown; prompt: string }): AgentParseResult {
  const { path, source } = input; const diagnostics: AgentDiagnostic[] = [];
  if (!object(input.metadata)) return { definition: null, diagnostics: [diagnostic("agent_frontmatter_invalid", source, path, "Frontmatter must be a YAML object.")] };
  const allowed = new Set(["schemaVersion", "name", "description", "useWhen", "tier", "phase", "authority", "tools", "skills", "delegation", "independence", "result", "escalation"]);
  for (const key of Object.keys(input.metadata)) if (!allowed.has(key)) diagnostics.push(diagnostic("agent_unknown_key", source, path, `Unknown agent key: ${key}.`));
  const name = string(input.metadata.name); const description = string(input.metadata.description); const tier = string(input.metadata.tier); const phase = string(input.metadata.phase); const authority = string(input.metadata.authority);
  const tools = strings(input.metadata.tools);
  const skills = strings(input.metadata.skills);
  const escalation = strings(input.metadata.escalation);
  const explicitUseWhen = normalizeExplicitUseWhen(input.metadata.useWhen);
  const useWhen = input.metadata.useWhen === undefined && source !== "package"
    ? normalizeLegacyUseWhen(description)
    : explicitUseWhen;
  const prompt = input.prompt.trim();
  const delegation = input.metadata.delegation; const independence = input.metadata.independence; const result = input.metadata.result;
  if (input.metadata.schemaVersion !== IMA_AGENT_SCHEMA_VERSION) diagnostics.push(diagnostic("agent_schema_version_unsupported", source, path, "schemaVersion must be 1."));
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name !== parse(path).name) diagnostics.push(diagnostic("agent_name_invalid", source, path, "name must be lowercase kebab-case and match its filename."));
  if (!description) diagnostics.push(diagnostic("agent_description_invalid", source, path, "description must be non-empty."));
  if (!useWhen) diagnostics.push(diagnostic("agent_use_when_invalid", source, path, `useWhen must contain ${IMA_AGENT_USE_WHEN_MIN_ITEMS} to ${IMA_AGENT_USE_WHEN_MAX_ITEMS} non-empty single-line strings of at most ${IMA_AGENT_USE_WHEN_MAX_LENGTH} characters.`));
  if (!inList(IMA_AGENT_TIERS, tier)) diagnostics.push(diagnostic("agent_tier_invalid", source, path, "tier is unsupported."));
  if (input.metadata.phase !== undefined && !inList(IMA_PHASES, phase)) diagnostics.push(diagnostic("agent_phase_invalid", source, path, "phase is unsupported."));
  if (!inList(IMA_AGENT_AUTHORITIES, authority)) diagnostics.push(diagnostic("agent_authority_invalid", source, path, "authority is unsupported."));
  if (!tools || tools.some((tool) => !inList(IMA_AGENT_TOOLS, tool))) diagnostics.push(diagnostic("agent_tools_invalid", source, path, "tools must contain only supported tool names."));
  if (!skills || skills.some((skill) => !skill)) diagnostics.push(diagnostic("agent_skills_invalid", source, path, "skills must be non-empty strings."));
  if (!escalation || escalation.some((item) => !item)) diagnostics.push(diagnostic("agent_escalation_invalid", source, path, "escalation must be non-empty strings."));
  if (!prompt) diagnostics.push(diagnostic("agent_prompt_empty", source, path, "Markdown prompt body must be non-empty."));
  if (!object(delegation) || typeof delegation.allowed !== "boolean" || !Number.isInteger(delegation.maxDepth) || delegation.maxDepth !== 0) diagnostics.push(diagnostic("agent_delegation_invalid", source, path, "delegation requires allowed and maxDepth: 0."));
  if (!object(independence) || typeof independence.freshInitial !== "boolean" || typeof independence.followUpAllowed !== "boolean") diagnostics.push(diagnostic("agent_independence_invalid", source, path, "independence requires boolean fields."));
  const resultKind = object(result) ? string(result.kind) : ""; const requiredSections = object(result) ? strings(result.requiredSections) : null; const resultFormat = object(result) ? string(result.format) : "";
  if (!object(result) || !inList(IMA_AGENT_RESULT_KINDS, resultKind) || !requiredSections || !requiredSections.length || requiredSections.some((item) => !item) || (resultFormat && resultFormat !== "review-verdict-v1") || (resultFormat === "review-verdict-v1" && (resultKind !== "review" || requiredSections.join(",") !== "verdict,reason"))) diagnostics.push(diagnostic("agent_result_invalid", source, path, "result requires a supported kind, non-empty requiredSections, and a valid optional format."));
  if (authority === "review-read" && tools?.some((tool) => ["write", "edit", "bash", "test"].includes(tool))) diagnostics.push(diagnostic("agent_authority_tools_conflict", source, path, "review-read cannot receive write-capable tools."));
  if ((tier === "vision") !== (authority === "vision-read")) diagnostics.push(diagnostic("agent_vision_invariant", source, path, "vision tier and vision-read authority are required together."));
  if (authority === "vision-read" && tools?.some((tool) => !["read", "image"].includes(tool))) diagnostics.push(diagnostic("agent_authority_tools_conflict", source, path, "vision-read only permits read and image tools."));
  if (authority === "document-write" && tools?.some((tool) => !["read", "grep", "find", "ls", "write", "edit", "bash"].includes(tool))) diagnostics.push(diagnostic("agent_authority_tools_conflict", source, path, "document-write only permits scoped documentation tools."));
  if (authority === "document-write" && !["write", "edit"].some((tool) => tools?.includes(tool))) diagnostics.push(diagnostic("agent_authority_tools_conflict", source, path, "document-write requires write or edit."));
  if (authority === "read" && tools?.some((tool) => ["write", "edit", "bash", "test"].includes(tool))) diagnostics.push(diagnostic("agent_authority_tools_conflict", source, path, "read authority cannot receive write-capable tools."));
  if (diagnostics.length) return { definition: null, diagnostics };
  return { definition: { schemaVersion: 1, name, description, useWhen: useWhen!, tier: tier as AgentTier, ...(input.metadata.phase !== undefined ? { phase: phase as ImaPhase } : {}), authority: authority as AgentAuthority, tools: tools!, skills: skills!, delegation: delegation as AgentDefinition["delegation"], independence: independence as AgentDefinition["independence"], result: { kind: resultKind as AgentResultKind, requiredSections: requiredSections!, ...(resultFormat ? { format: resultFormat as "review-verdict-v1" } : {}) }, escalation: escalation!, prompt, source, path }, diagnostics };
}

export function parseAgentDocument(input: { path: string; source: AgentSource; content: string }): AgentParseResult {
  const match = input.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { definition: null, diagnostics: [diagnostic("agent_frontmatter_missing", input.source, input.path, "Document requires one leading YAML frontmatter block.")] };
  try { return validateAgentDefinition({ path: input.path, source: input.source, metadata: parseYaml(match[1]), prompt: match[2] }); }
  catch { return { definition: null, diagnostics: [diagnostic("agent_yaml_invalid", input.source, input.path, "Frontmatter YAML is invalid.")] }; }
}

export function resolveAgentDefinitions(input: { packageAgents: AgentDefinition[]; userAgents: AgentDefinition[]; projectAgents: AgentDefinition[] }) {
  const diagnostics: AgentDiagnostic[] = []; const selected = new Map<string, AgentDefinition>();
  for (const [source, definitions] of [["package", input.packageAgents], ["user", input.userAgents], ["project", input.projectAgents]] as const) {
    const local = new Set<string>();
    for (const definition of definitions) { if (local.has(definition.name)) diagnostics.push(diagnostic("agent_duplicate_definition", source, definition.path, `Duplicate ${definition.name} definition.`)); local.add(definition.name); selected.set(definition.name, structuredClone(definition)); }
  }
  return { definitions: [...selected.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

export const IMA_AGENT_CATALOG_UNAVAILABLE = "IMA agent catalog unavailable. Do not use ima_delegate until valid agents are available.";
export const IMA_AGENT_CATALOG_EMPTY = "IMA agent catalog has no available agents. Do not use ima_delegate; handle the task directly.";

export function buildAgentCatalogPrompt(input: { definitions: readonly AgentDefinition[]; diagnostics: readonly AgentDiagnostic[] }): string {
  if (input.diagnostics.length) return IMA_AGENT_CATALOG_UNAVAILABLE;
  if (!input.definitions.length) return IMA_AGENT_CATALOG_EMPTY;
  const rows = [...input.definitions]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, tier, authority, useWhen }) => `- ${name} (${tier}, ${authority}): ${useWhen.join("; ")}`);
  return [
    "## IMA delegation catalog",
    "Use `ima_delegate` opportunistically when an agent is a clear bounded fit, or when the user explicitly asks to use a named agent.",
    "If no agent fits, do not delegate. Write-capable agents require exact, disjoint write scopes. Children cannot delegate.",
    "Do not newly delegate `reviewer` for rereview or verified-finding follow-up; use an eligible existing reviewer continuation.",
    "Available agents:",
    ...rows,
  ].join("\n");
}

const isMissing = (error: any) => error?.code === "ENOENT";
const within = (parent: string, child: string) => relative(parent, child) === "" || (!relative(parent, child).startsWith("..") && !resolve(parent) === resolve(child));

export async function loadAgentDefinitions(input: { paths: ImaAgentPaths; projectTrusted: boolean; readText?: (path: string) => Promise<string>; readDirectory?: typeof readdir; resolvePath?: typeof realpath; stat?: typeof lstat }) {
  const readText = input.readText ?? ((path: string) => readFile(path, "utf8")); const readDirectory = input.readDirectory ?? readdir; const resolvePath = input.resolvePath ?? realpath; const stat = input.stat ?? lstat;
  const diagnostics: AgentDiagnostic[] = []; const loaded: Record<AgentSource, AgentDefinition[]> = { package: [], user: [], project: [] };
  for (const [source, directory] of [["package", input.paths.packageAgents], ["user", input.paths.userAgents], ["project", input.paths.projectAgents]] as const) {
    if (source === "project" && !input.projectTrusted) continue;
    let names: string[]; try { names = await readDirectory(directory); } catch (error) { if (isMissing(error)) continue; diagnostics.push(diagnostic("agent_directory_unreadable", source, directory, "Agent directory cannot be read.")); continue; }
    let directoryReal: string; try { directoryReal = await resolvePath(directory); } catch { diagnostics.push(diagnostic("agent_directory_unreadable", source, directory, "Agent directory cannot be resolved.")); continue; }
    for (const name of names.filter((entry) => entry.endsWith(".md") && entry.toLowerCase() !== "readme.md").sort()) {
      const path = join(directory, name); try {
        const info = await stat(path); const real = await resolvePath(path);
        if (!info.isFile() || !(real === directoryReal || real.startsWith(`${directoryReal}/`))) { diagnostics.push(diagnostic("agent_path_unsafe", source, path, "Agent must be a regular file inside its source directory.")); continue; }
        const parsed = parseAgentDocument({ path, source, content: await readText(path) }); diagnostics.push(...parsed.diagnostics); if (parsed.definition) loaded[source].push(parsed.definition);
      } catch { diagnostics.push(diagnostic("agent_file_unreadable", source, path, "Agent file cannot be read safely.")); }
    }
  }
  const resolved = resolveAgentDefinitions({ packageAgents: loaded.package, userAgents: loaded.user, projectAgents: loaded.project }); diagnostics.push(...resolved.diagnostics);
  return { definitions: resolved.definitions, diagnostics, paths: input.paths };
}
