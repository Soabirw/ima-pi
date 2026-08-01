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
const clean = (value: unknown, maximum = 8_000) => typeof value === "string" ? value.replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, maximum) : "";

export function sanitizeContextError(code: string, _value: unknown): { code: string; message: string } {
  return { code, message: `Context integration failed: ${code}.` };
}

export function normalizeSourceReference(source: ContextSource): string {
  if (source.type === "jira") return `Jira:${source.key}`;
  if (source.type === "taskwarrior") return `Taskwarrior:${source.project}:${source.uuid}`;
  if (source.type === "file") return `File:${source.path}`;
  if (source.type === "vestige") return `Vestige:${source.id}`;
  return `Text:${source.title}`;
}

export function validateContextRequest(value: unknown): { valid: true; source: ContextSource; durableKnowledge: { query: string; collection?: string; limit?: number } | null } | { valid: false; error: ReturnType<typeof sanitizeContextError> } {
  const input = object(value); const source = object(input?.source);
  if (!input || !source || typeof source.type !== "string") return { valid: false, error: sanitizeContextError("invalid_context_request", value) };
  let normalized: ContextSource | null = null;
  if (source.type === "jira" && /^[A-Z][A-Z0-9]+-\d+$/.test(string(source.key))) normalized = { type: "jira", key: string(source.key) };
  if (source.type === "taskwarrior" && /^[\w.-]+$/.test(string(source.project)) && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(string(source.uuid))) normalized = { type: "taskwarrior", project: string(source.project), uuid: string(source.uuid) };
  if (source.type === "file" && bounded(source.path, 1_024)) normalized = { type: "file", path: string(source.path) };
  if (source.type === "vestige" && /^[0-9a-f-]{36}$/i.test(string(source.id))) normalized = { type: "vestige", id: string(source.id) };
  if (source.type === "text" && bounded(source.title, 256) && bounded(source.content, 64_000)) normalized = { type: "text", title: string(source.title), content: clean(source.content, 64_000) };
  if (!normalized) return { valid: false, error: sanitizeContextError("invalid_context_request", value) };
  const durable = input.durableKnowledge === undefined ? null : object(input.durableKnowledge);
  if (input.durableKnowledge !== undefined && (!durable || !bounded(durable.query, 2_000) || (durable.collection !== undefined && !bounded(durable.collection, 256)) || (durable.limit !== undefined && (!Number.isInteger(durable.limit) || Number(durable.limit) < 1 || Number(durable.limit) > 20)))) return { valid: false, error: sanitizeContextError("invalid_context_request", value) };
  return { valid: true, source: normalized, durableKnowledge: durable ? { query: string(durable.query), ...(durable.collection ? { collection: string(durable.collection) } : {}), ...(durable.limit ? { limit: Number(durable.limit) } : {}) } : null };
}

export function normalizeSourcePayload(input: { source: ContextSource; payload: unknown }): { type: ContextSource["type"]; key: string; title: string; content: string; references: string[] } | null {
  const payload = object(input.payload);
  if (input.source.type === "text") return { type: "text", key: input.source.title, title: input.source.title, content: input.source.content, references: [normalizeSourceReference(input.source)] };
  if (!payload) return null;
  const content = clean(payload.content ?? payload.description ?? payload.summary, 64_000);
  if (!content) return null;
  const references = Array.isArray(payload.references) ? payload.references.filter((item): item is string => typeof item === "string").map((item) => clean(item, 1_024)) : [];
  return { type: input.source.type, key: string(payload.key) || (input.source.type === "taskwarrior" ? input.source.uuid : input.source.type === "jira" ? input.source.key : input.source.type === "file" ? input.source.path : input.source.id), title: clean(payload.title, 512) || normalizeSourceReference(input.source), content, references: [...new Set([normalizeSourceReference(input.source), ...references])] };
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
