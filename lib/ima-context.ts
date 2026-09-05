import {
  isValidPlaneLifecycleIdentity,
  LIFECYCLE_PHASES,
  MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES,
  normalizeLifecycleRecordKey,
} from "./ima-lifecycle.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

export const CONTEXT_SCHEMA_VERSION = 1;
export const STANDARD_MEMORIES = ["core", "conventions", "tech_stack", "suggested_commands", "task_completion"] as const;

type MemoryName = typeof STANDARD_MEMORIES[number];
export type ContextSource =
  | { type: "jira"; key: string }
  | { type: "taskwarrior"; project: string; uuid: string }
  | { type: "plane"; workspace: string; project: string; sequenceId: number }
  | { type: "file"; path: string }
  | { type: "vestige"; id: string }
  | { type: "lifecycle"; key: string }
  | { type: "text"; title: string; content: string };

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const bounded = (value: unknown, maximum: number) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const redactContextText = (value: unknown) => typeof value === "string"
  ? value.replace(/authorization\s*[:=]\s*[^\r\n]+/gi, "[redacted]").replace(/(?:token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]")
  : "";
export const sanitizeContextText = (value: unknown, maximum = 8_000) =>
  redactContextText(value).slice(0, maximum);
const QDRANT_RESULT_HEADER = /^## Result \d+ \(score: ([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\)\s*$/i;
const MARKDOWN_FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const TASKWARRIOR_PROJECT_PATTERN = /^[\w.-]+$/;
// Keep these grammar rules aligned with skills/plane-api/scripts/plane-client.mjs.
const PLANE_WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PLANE_PROJECT_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PLANE_WORK_ITEM_PATTERN = /^([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;
const UUID_FRAGMENT = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_FRAGMENT}$`);
const LIFECYCLE_PHASE_PATTERN = LIFECYCLE_PHASES.join("|");
const CONTEXT_IDENTIFIER_MAXIMUM = 1_024;
const LIFECYCLE_KEY_MAXIMUM = 512;
export const LIFECYCLE_ARTIFACT_MAXIMUM = MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES;

export function parseQdrantResults(formattedText: unknown): Array<{ summary: string; score: number }> {
  if (typeof formattedText !== "string") return [];

  const results: Array<{ summary: string; score: number }> = [];
  let current: { score: number; lines: string[] } | null = null;
  let fenceState: { character: string; length: number } | null = null;
  const appendCurrent = () => {
    if (!current) return;
    const summary = current.lines.join("\n").trim();
    if (summary) results.push({ summary, score: current.score });
  };

  for (const line of formattedText.split(/\r?\n/)) {
    const fenceMatch = line.match(MARKDOWN_FENCE);
    if (fenceMatch) {
      const delimiter = fenceMatch[1];
      const remainder = fenceMatch[2];
      if (!fenceState) {
        fenceState = { character: delimiter.charAt(0), length: delimiter.length };
      } else if (
        delimiter.charAt(0) === fenceState.character
        && delimiter.length >= fenceState.length
        && remainder.trim() === ""
      ) {
        fenceState = null;
      }
      if (current) current.lines.push(line);
      continue;
    }

    const header = fenceState ? null : line.match(QDRANT_RESULT_HEADER);
    if (header) {
      appendCurrent();
      const score = Number(header[1]);
      current = Number.isFinite(score) ? { score, lines: [] } : null;
      continue;
    }

    if (current) current.lines.push(line);
  }

  appendCurrent();
  return results;
}

const clean = sanitizeContextText;
const CONTEXT_REQUEST_HINT = "Use source fields jira:key, taskwarrior:project+uuid, plane:workspace+project+sequenceId, file:path, vestige:id, lifecycle:key, text:title+content, or reference:value. Canonical references are taskwarrior:<project>:<uuid>, plane:<workspace>:PROJ-123, jira:<KEY>, lifecycle:<lifecycle-key>, and vestige:<UUID>. durableKnowledge requires query and optionally accepts collection and limit.";

export function sanitizeContextError(code: string, _value: unknown): { code: string; message: string; hint?: string } {
  const error = { code, message: `Context integration failed: ${code}.` };
  return code === "invalid_context_request" ? { ...error, hint: CONTEXT_REQUEST_HINT } : error;
}

const lifecycleKey = (value: unknown) => {
  if (typeof value !== "string" || value.length > LIFECYCLE_KEY_MAXIMUM || /[\r\n]/.test(value)) return "";
  return string(value);
};

const lifecycleSource = (value: unknown): ContextSource | null => {
  const key = lifecycleKey(value);
  return key ? { type: "lifecycle", key } : null;
};

const planeSource = (
  workspaceValue: unknown,
  projectValue: unknown,
  sequenceId: unknown,
): ContextSource | null => {
  const workspace = string(workspaceValue);
  const project = string(projectValue);
  if (
    !PLANE_WORKSPACE_PATTERN.test(workspace)
    || !PLANE_PROJECT_PATTERN.test(project)
    || typeof sequenceId !== "number"
    || !Number.isSafeInteger(sequenceId)
    || sequenceId < 1
  ) return null;
  const canonical = `plane:${workspace}:${project}-${sequenceId}`;
  return canonical.length <= CONTEXT_IDENTIFIER_MAXIMUM
    ? { type: "plane", workspace, project, sequenceId }
    : null;
};

const planeSourceFromWorkItem = (
  workspace: unknown,
  workItem: unknown,
): ContextSource | null => {
  const match = PLANE_WORK_ITEM_PATTERN.exec(string(workItem));
  return match ? planeSource(workspace, match[1], Number(match[2])) : null;
};

const contextSourceFromIdentifierParts = (
  prefix: string,
  values: string[],
): ContextSource | null => {
  if (prefix === "taskwarrior" && values.length === 2) {
    const [project, uuid] = values.map(string);
    return TASKWARRIOR_PROJECT_PATTERN.test(project) && UUID_PATTERN.test(uuid)
      ? { type: "taskwarrior", project, uuid }
      : null;
  }
  if (prefix === "plane" && values.length === 2) {
    const [workspace, workItem] = values;
    return planeSourceFromWorkItem(workspace, workItem);
  }
  if (prefix === "jira" && values.length === 1) {
    const [key] = values.map(string);
    return JIRA_KEY_PATTERN.test(key) ? { type: "jira", key } : null;
  }
  if (prefix === "vestige" && values.length === 1) {
    const [id] = values.map(string);
    return UUID_PATTERN.test(id) ? { type: "vestige", id } : null;
  }
  return null;
};

export function parseContextSourceIdentifier(value: unknown): ContextSource | null {
  if (typeof value !== "string" || value.length > CONTEXT_IDENTIFIER_MAXIMUM || /[\r\n]/.test(value)) return null;
  const identifier = value.trim();
  if (!identifier) return null;

  const colonIndex = identifier.indexOf(":");
  if (colonIndex > 0 && !/\s/.test(identifier.slice(0, colonIndex))) {
    const prefix = identifier.slice(0, colonIndex);
    const remainder = identifier.slice(colonIndex + 1);
    return prefix === "lifecycle"
      ? lifecycleSource(remainder)
      : contextSourceFromIdentifierParts(prefix, remainder.split(":"));
  }

  const spaceDelimited = /^(\S+)\s+(.+)$/.exec(identifier);
  if (!spaceDelimited) return null;
  const [, prefix, remainder] = spaceDelimited;
  return prefix === "lifecycle"
    ? lifecycleSource(remainder)
    : contextSourceFromIdentifierParts(prefix, remainder.split(/\s+/));
}

const normalizeContextSource = (source: Record<string, unknown>): ContextSource | null => {
  if (source.type === "reference" && onlyKeys(source, ["type", "value"]) && bounded(source.value, CONTEXT_IDENTIFIER_MAXIMUM)) return parseContextSourceIdentifier(source.value);
  if (source.type === "jira" && onlyKeys(source, ["type", "key"]) && JIRA_KEY_PATTERN.test(string(source.key))) return { type: "jira", key: string(source.key) };
  if (source.type === "taskwarrior" && onlyKeys(source, ["type", "project", "uuid"]) && TASKWARRIOR_PROJECT_PATTERN.test(string(source.project)) && UUID_PATTERN.test(string(source.uuid))) return { type: "taskwarrior", project: string(source.project), uuid: string(source.uuid) };
  if (source.type === "plane" && onlyKeys(source, ["type", "workspace", "project", "sequenceId"])) return planeSource(source.workspace, source.project, source.sequenceId);
  if (source.type === "file" && onlyKeys(source, ["type", "path"]) && bounded(source.path, 1_024)) return { type: "file", path: string(source.path) };
  if (source.type === "vestige" && onlyKeys(source, ["type", "id"]) && UUID_PATTERN.test(string(source.id))) return { type: "vestige", id: string(source.id) };
  if (source.type === "lifecycle" && onlyKeys(source, ["type", "key"])) return lifecycleSource(source.key);
  if (source.type === "text" && onlyKeys(source, ["type", "title", "content"]) && bounded(source.title, 256) && bounded(source.content, 64_000)) return { type: "text", title: string(source.title), content: clean(source.content, 64_000) };
  return null;
};

export function normalizeSourceReference(source: ContextSource): string {
  if (source.type === "jira") return `Jira:${source.key}`;
  if (source.type === "taskwarrior") return `Taskwarrior:${source.project}:${source.uuid}`;
  if (source.type === "plane") return `Plane:${source.workspace}:${source.project}-${source.sequenceId}`;
  if (source.type === "file") return `File:${clean(source.path, 1_024)}`;
  if (source.type === "vestige") return `Vestige:${source.id}`;
  if (source.type === "lifecycle") return `Lifecycle:${clean(source.key, LIFECYCLE_KEY_MAXIMUM)}`;
  return `Text:${source.title}`;
}

export function validateContextRequest(value: unknown): { valid: true; source: ContextSource; durableKnowledge: { query: string; collection?: string; limit?: number } | null } | { valid: false; error: ReturnType<typeof sanitizeContextError> } {
  const input = object(value); const source = object(input?.source);
  if (!input || !onlyKeys(input, ["source", "durableKnowledge"]) || !source || typeof source.type !== "string") return { valid: false, error: sanitizeContextError("invalid_context_request", value) };
  const normalized = normalizeContextSource(source);
  if (!normalized) return { valid: false, error: sanitizeContextError("invalid_context_request", value) };
  const durable = input.durableKnowledge === undefined ? null : object(input.durableKnowledge);
  if (input.durableKnowledge !== undefined && (!durable || !onlyKeys(durable, ["query", "collection", "limit"]) || !bounded(durable.query, 2_000) || (durable.collection !== undefined && !bounded(durable.collection, 256)) || (durable.limit !== undefined && (!Number.isInteger(durable.limit) || Number(durable.limit) < 1 || Number(durable.limit) > 20)))) return { valid: false, error: sanitizeContextError("invalid_context_request", value) };
  return { valid: true, source: normalized, durableKnowledge: durable ? { query: string(durable.query), ...(durable.collection ? { collection: string(durable.collection) } : {}), ...(durable.limit ? { limit: Number(durable.limit) } : {}) } : null };
}

const INVALID_CONTEXT_ARGUMENTS = Object.freeze({ source: Object.freeze({ type: "invalid_context_request" }) });

export function prepareContextArguments(value: unknown) {
  const valid = validateContextRequest(value);
  return valid.valid ? { source: valid.source, ...(valid.durableKnowledge ? { durableKnowledge: valid.durableKnowledge } : {}) } : INVALID_CONTEXT_ARGUMENTS;
}

const escapeRegularExpression = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const lifecycleArtifact = (value: unknown) => {
  const result = object(value);
  const content = typeof result?.detail === "string"
    ? result.detail
    : typeof result?.content === "string" ? result.content : "";
  const id = string(result?.id);
  const recordKey = normalizeLifecycleRecordKey(result?.recordKey);
  const lifecycleKey = string(result?.lifecycleKey);
  const sanitizedContent = redactContextText(content);
  return bounded(id, 1_024)
    && !/[\r\n]/.test(id)
    && recordKey
    && lifecycleKey
    && sanitizedContent
    && utf8ByteLength(sanitizedContent) <= LIFECYCLE_ARTIFACT_MAXIMUM
    ? { id, recordKey, lifecycleKey, content: sanitizedContent }
    : null;
};

const lifecycleVerificationPattern = (key: string) => new RegExp(
  `<!-- ima-lifecycle verification: lifecycle_key=${escapeRegularExpression(key)}; nonce=${UUID_FRAGMENT}; phase=(?:${LIFECYCLE_PHASE_PATTERN}); jira_key=[^;\\r\\n]*; taskwarrior_uuid=[^;\\r\\n]*;(?: outcome=completed| plane_workspace=([^;\\r\\n]*); plane_work_item=([^;\\r\\n]*); outcome=completed) -->`,
);

const verifiedLifecycleArtifact = (content: string, key: string) => {
  const markerPattern = lifecycleVerificationPattern(key);
  const marker = [...content.matchAll(new RegExp(markerPattern.source, "g"))].at(-1);
  if (!marker || marker.index === undefined) return false;
  const [, planeWorkspace, planeWorkItem] = marker;
  if (
    (planeWorkspace === undefined) !== (planeWorkItem === undefined)
    || (planeWorkspace !== undefined
      && !isValidPlaneLifecycleIdentity(planeWorkspace, planeWorkItem))
  ) return false;
  const trailingContent = content.slice(marker.index + marker[0].length);
  return trailingContent === "" || trailingContent === "\n";
};

export function normalizeCorpusLifecycleRecord(input: { lifecycleKey: string; record: unknown }): { id: string; recordKey: string; content: string } | null {
  const source = lifecycleSource(input.lifecycleKey);
  const artifact = lifecycleArtifact(input.record);
  return source
    && artifact
    && artifact.lifecycleKey === source.key
    && verifiedLifecycleArtifact(artifact.content, source.key)
    ? { id: artifact.id, recordKey: artifact.recordKey, content: artifact.content }
    : null;
}

const sourceKey = (source: ContextSource) => {
  if (source.type === "taskwarrior") return source.uuid;
  if (source.type === "plane") return `${source.workspace}:${source.project}-${source.sequenceId}`;
  if (source.type === "jira" || source.type === "lifecycle") return source.key;
  if (source.type === "file") return source.path;
  if (source.type === "vestige") return source.id;
  return source.title;
};

export function normalizeSourcePayload(input: { source: ContextSource; payload: unknown }): { type: ContextSource["type"]; key: string; title: string; content: string; references: string[] } | null {
  const payload = object(input.payload);
  if (input.source.type === "text") {
    const title = clean(input.source.title, 256);
    return { type: "text", key: title, title, content: input.source.content, references: [`Text:${title}`] };
  }
  if (!payload) return null;
  const rawContent = payload.content ?? payload.description ?? payload.summary;
  const content = input.source.type === "lifecycle"
    ? redactContextText(rawContent)
    : clean(rawContent, 64_000);
  if (
    !content
    || (input.source.type === "lifecycle" && utf8ByteLength(content) > LIFECYCLE_ARTIFACT_MAXIMUM)
  ) return null;
  const references = Array.isArray(payload.references) ? payload.references.filter((item): item is string => typeof item === "string").map((item) => clean(item, 1_024)) : [];
  const key = clean(string(payload.key) || sourceKey(input.source), 1_024);
  return { type: input.source.type, key, title: clean(payload.title, 512) || normalizeSourceReference(input.source), content, references: [...new Set([normalizeSourceReference(input.source), ...references])] };
}

export function evaluateSerenaBootstrap(input: { activated: boolean; instructionsLoaded: boolean; memoryListLoaded: boolean; memories?: Partial<Record<MemoryName, string | null | "failed">> }) {
  const memories = Object.fromEntries(STANDARD_MEMORIES.map((name) => {
    const value = input.memories?.[name];
    return [name, value === "failed" ? { status: "failed" as const, content: null } : typeof value === "string" ? { status: "loaded" as const, content: clean(value) } : { status: "missing" as const, content: null }];
  })) as Record<MemoryName, { status: "loaded" | "missing" | "failed"; content: string | null }>;
  const missingRequiredMemories = STANDARD_MEMORIES.filter((name) => memories[name].status !== "loaded");
  return { activated: input.activated, instructionsLoaded: input.instructionsLoaded, memoryListLoaded: input.memoryListLoaded, memories, missingRequiredMemories };
}

export function derivePhaseContext(input: { cwd: string; serenaProjectPath: string | null; source: ReturnType<typeof normalizeSourcePayload>; serena: ReturnType<typeof evaluateSerenaBootstrap>; durableKnowledge?: { requested: boolean; status: "loaded" | "empty" | "failed"; references: Array<{ summary: string; score: number | null }> }; diagnostics?: Array<{ code: string; stage: string; message: string }> }) {
  const sourceReady = Boolean(input.source); const blocking = !input.serena.activated || !input.serena.instructionsLoaded || !input.serena.memoryListLoaded || !sourceReady;
  const durableKnowledge = input.durableKnowledge ?? { requested: false, status: "not-requested" as const, references: [] };
  const status = blocking ? "failed" : input.serena.missingRequiredMemories.length || durableKnowledge.status === "failed" ? "degraded" : "ready";
  return { schemaVersion: CONTEXT_SCHEMA_VERSION, status, project: { cwd: clean(input.cwd, 2_048), serenaProjectPath: input.serenaProjectPath }, source: input.source, serena: input.serena, durableKnowledge, diagnostics: input.diagnostics ?? [] };
}
