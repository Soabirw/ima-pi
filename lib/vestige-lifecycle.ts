import { LIFECYCLE_ARTIFACT_MAXIMUM } from "./ima-context.ts";

export const LIFECYCLE_DISCOVERY_LIMIT = 10;
export const LIFECYCLE_DISCOVERY_TOKEN_BUDGET = 1_000;

export type LifecycleArtifact = { id: string; content: string };
type LifecycleDiscovery = (arguments_: Record<string, unknown>) => Promise<unknown>;
type LifecycleMemoryRead = (id: string) => Promise<unknown>;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

const mcpResultData = (value: unknown): Record<string, unknown> | null => {
  const response = object(value);
  if (!response || response.isError === true) return null;

  const structured = object(response.structuredContent);
  if (structured) return structured;
  if (!Array.isArray(response.content)) return response;

  for (const content of response.content) {
    const item = object(content);
    if (typeof item?.text !== "string") continue;
    try {
      const parsed = object(JSON.parse(item.text));
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }

  return response;
};

const resultRecords = (data: Record<string, unknown>) => {
  if (Array.isArray(data.results)) return data.results;
  const nested = object(data.data);
  return Array.isArray(nested?.results) ? nested.results : null;
};

const candidateId = (value: unknown) => {
  const result = object(value);
  const nested = object(result?.node) ?? object(result?.memory);
  return text(result?.id) || text(nested?.id);
};

const memoryRecord = (data: Record<string, unknown>) =>
  data.action === "get" && data.found === true
    ? object(data.node)
    : null;

const validId = (value: string) => UUID_PATTERN.test(value);

export function buildLifecycleDiscoveryArguments(query: string, concrete = false) {
  return {
    query,
    mode: "lookup",
    retrieval_mode: "precise",
    detail_level: "brief",
    concrete,
    limit: LIFECYCLE_DISCOVERY_LIMIT,
    token_budget: LIFECYCLE_DISCOVERY_TOKEN_BUDGET,
  };
}

export function parseLifecycleCandidateIds(response: unknown): string[] | null {
  const data = mcpResultData(response);
  if (!data) return null;

  const results = resultRecords(data);
  if (!results) return null;

  const ids: string[] = [];
  const seenIds = new Set<string>();
  for (const result of results) {
    const id = candidateId(result);
    const normalizedId = id.toLowerCase();
    if (!validId(id) || seenIds.has(normalizedId)) continue;
    seenIds.add(normalizedId);
    ids.push(id);
    if (ids.length === LIFECYCLE_DISCOVERY_LIMIT) break;
  }

  return ids;
}

export async function discoverLifecycleCandidates(input: {
  query: string;
  concrete?: boolean;
  discover: LifecycleDiscovery;
  signal?: AbortSignal;
}): Promise<string[] | null> {
  const query = text(input.query);
  if (!query) return null;

  try {
    throwIfAborted(input.signal);
    const response = await input.discover(
      buildLifecycleDiscoveryArguments(query, input.concrete ?? false),
    );
    throwIfAborted(input.signal);
    return parseLifecycleCandidateIds(response);
  } catch {
    throwIfAborted(input.signal);
    return null;
  }
}

export async function readBoundedLifecycleArtifact(input: {
  id: string;
  read: LifecycleMemoryRead;
  signal?: AbortSignal;
}): Promise<LifecycleArtifact | null> {
  const id = text(input.id);
  if (!validId(id)) return null;

  try {
    throwIfAborted(input.signal);
    const response = await input.read(id);
    throwIfAborted(input.signal);
    const data = mcpResultData(response);
    const record = data ? memoryRecord(data) : null;
    const returnedId = text(record?.id);
    const content = typeof record?.content === "string" ? record.content : "";
    if (
      !validId(returnedId)
      || returnedId.toLowerCase() !== id.toLowerCase()
      || content.length === 0
      || content.length > LIFECYCLE_ARTIFACT_MAXIMUM
    ) return null;

    return { id, content };
  } catch {
    throwIfAborted(input.signal);
    return null;
  }
}

export function createLifecycleRecallEnvelope(results: LifecycleArtifact[]) {
  return { isError: false, structuredContent: { results } };
}

export async function retrieveBoundedLifecycleArtifacts(input: {
  query: string;
  concrete?: boolean;
  discover: LifecycleDiscovery;
  read: LifecycleMemoryRead;
  signal?: AbortSignal;
}) {
  const ids = await discoverLifecycleCandidates({
    query: input.query,
    concrete: input.concrete,
    discover: input.discover,
    signal: input.signal,
  });
  if (ids === null) return null;

  const results: LifecycleArtifact[] = [];
  for (const id of ids) {
    const artifact = await readBoundedLifecycleArtifact({
      id,
      read: input.read,
      signal: input.signal,
    });
    if (artifact) results.push(artifact);
  }

  return createLifecycleRecallEnvelope(results);
}
