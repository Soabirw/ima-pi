export const CONTEXT_SCHEMA_VERSION = 1;
export const STANDARD_MEMORIES = ["core", "conventions", "tech_stack", "suggested_commands", "task_completion"] as const;

type MemoryName = typeof STANDARD_MEMORIES[number];
export type ContextSource =
  | { type: "jira"; key: string }
  | { type: "taskwarrior"; project: string; uuid: string }
  | { type: "file"; path: string }
  | { type: "vestige"; id: string }
  | { type: "text"; title: string; content: string };

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const bounded = (value: unknown, maximum: number) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
export const sanitizeContextText = (value: unknown, maximum = 8_000) => typeof value === "string" ? value.replace(/authorization\s*[:=]\s*[^\r\n]+/gi, "[redacted]").replace(/(?:token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, maximum) : "";
const QDRANT_RESULT_HEADER = /^## Result \d+ \(score: ([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\)\s*$/i;
const MARKDOWN_FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

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
const CONTEXT_REQUEST_HINT = "Use source fields jira:key, taskwarrior:project+uuid, file:path, vestige:id, or text:title+content. durableKnowledge requires query and optionally accepts collection and limit.";

export function sanitizeContextError(code: string, _value: unknown): { code: string; message: string; hint?: string } {
  const error = { code, message: `Context integration failed: ${code}.` };
  return code === "invalid_context_request" ? { ...error, hint: CONTEXT_REQUEST_HINT } : error;
}

export function normalizeSourceReference(source: ContextSource): string {
  if (source.type === "jira") return `Jira:${source.key}`;
  if (source.type === "taskwarrior") return `Taskwarrior:${source.project}:${source.uuid}`;
  if (source.type === "file") return `File:${clean(source.path, 1_024)}`;
  if (source.type === "vestige") return `Vestige:${source.id}`;
  return `Text:${source.title}`;
}

export function validateContextRequest(value: unknown): { valid: true; source: ContextSource; durableKnowledge: { query: string; collection?: string; limit?: number } | null } | { valid: false; error: ReturnType<typeof sanitizeContextError> } {
  const input = object(value); const source = object(input?.source);
  if (!input || !onlyKeys(input, ["source", "durableKnowledge"]) || !source || typeof source.type !== "string") return { valid: false, error: sanitizeContextError("invalid_context_request", value) };
  let normalized: ContextSource | null = null;
  if (source.type === "jira" && onlyKeys(source, ["type", "key"]) && /^[A-Z][A-Z0-9]+-\d+$/.test(string(source.key))) normalized = { type: "jira", key: string(source.key) };
  if (source.type === "taskwarrior" && onlyKeys(source, ["type", "project", "uuid"]) && /^[\w.-]+$/.test(string(source.project)) && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(string(source.uuid))) normalized = { type: "taskwarrior", project: string(source.project), uuid: string(source.uuid) };
  if (source.type === "file" && onlyKeys(source, ["type", "path"]) && bounded(source.path, 1_024)) normalized = { type: "file", path: string(source.path) };
  if (source.type === "vestige" && onlyKeys(source, ["type", "id"]) && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(string(source.id))) normalized = { type: "vestige", id: string(source.id) };
  if (source.type === "text" && onlyKeys(source, ["type", "title", "content"]) && bounded(source.title, 256) && bounded(source.content, 64_000)) normalized = { type: "text", title: string(source.title), content: clean(source.content, 64_000) };
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

export function normalizeSourcePayload(input: { source: ContextSource; payload: unknown }): { type: ContextSource["type"]; key: string; title: string; content: string; references: string[] } | null {
  const payload = object(input.payload);
  if (input.source.type === "text") {
    const title = clean(input.source.title, 256);
    return { type: "text", key: title, title, content: input.source.content, references: [`Text:${title}`] };
  }
  if (!payload) return null;
  const content = clean(payload.content ?? payload.description ?? payload.summary, 64_000);
  if (!content) return null;
  const references = Array.isArray(payload.references) ? payload.references.filter((item): item is string => typeof item === "string").map((item) => clean(item, 1_024)) : [];
  const key = string(payload.key) || (input.source.type === "taskwarrior" ? input.source.uuid : input.source.type === "jira" ? input.source.key : input.source.type === "file" ? input.source.path : input.source.id);
  return { type: input.source.type, key: input.source.type === "file" ? clean(key, 1_024) : key, title: clean(payload.title, 512) || normalizeSourceReference(input.source), content, references: [...new Set([normalizeSourceReference(input.source), ...references])] };
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
