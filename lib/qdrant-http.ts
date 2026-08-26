import {
  CORPUS_SCHEMA_VERSION,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_DIGEST,
  INSTITUTIONAL_COLLECTION,
  MAX_PAYLOAD_BYTES,
  MAX_SUMMARY_BYTES,
  VECTOR_DISTANCE,
  VECTOR_NAME,
  VECTOR_SIZE,
  corpusFailure as failure,
  deriveRecordId,
  existingInstitutionalRecord,
  normalizeInstitutionalFilters,
  normalizeInstitutionalRecord,
  normalizeInstitutionalSummary,
  utf8ByteLength,
  validateEmbedding,
  type CorpusResult,
  type ExistingInstitutionalRecord,
  type InstitutionalFilters,
  type InstitutionalRecord,
} from "./qdrant-corpus.ts";
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_OLLAMA_URL,
  DEFAULT_QDRANT_URL,
  MAX_HTTP_RESPONSE_BYTES,
  aborted,
  bodyOrFailure,
  collectionName,
  object,
  requestJson,
  resolveCorpusEndpoints,
  success,
  text,
  type JsonObject,
  type QdrantHttpDependencies,
} from "./qdrant-http-boundary.ts";

export {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_OLLAMA_URL,
  DEFAULT_QDRANT_URL,
  MAX_HTTP_RESPONSE_BYTES,
  resolveCorpusEndpoints,
} from "./qdrant-http-boundary.ts";
export type { CorpusEndpoints, QdrantHttpDependencies } from "./qdrant-http-boundary.ts";

export const MINIMUM_QDRANT_VERSION = "1.16.0";
const LEGACY_KNOWLEDGE_COLLECTION = "ima-knowledge";
const REQUIRED_INDEXES = ["lifecycle_key", "project", "site", "repo"] as const;
type CollectionDetails = JsonObject;
export type CorpusStatus = {
  status: "ready";
  qdrantVersion: string;
  collection: "absent" | "needs_indexes" | "ready";
  missingIndexes: string[];
};
export type CorpusSummary = {
  id: string;
  recordKey: string;
  project: string;
  site: string;
  repo: string;
  lifecycleKey: string;
  phase: string;
  summary: string;
  score?: number;
};
export type FullInstitutionalRecord = CorpusSummary & {
  detail: string;
  sourceRefs: string[];
  contentHash: string;
  createdAt: string;
};
export type CorpusFilters = InstitutionalFilters;

export type QdrantCorpusClient = {
  status: (signal?: AbortSignal) => Promise<CorpusResult<CorpusStatus>>;
  ensureCollection: (signal?: AbortSignal) => Promise<CorpusResult<CorpusStatus>>;
  getPoint: (id: string, signal?: AbortSignal) => Promise<CorpusResult<ExistingInstitutionalRecord | null>>;
  embedSummary: (summary: string, signal?: AbortSignal) => Promise<CorpusResult<number[]>>;
  insertPoint: (input: { record: InstitutionalRecord; vector: number[] }, signal?: AbortSignal) => Promise<CorpusResult<undefined>>;
  findInstitutional: (input: { query: string; limit: number; filters?: CorpusFilters }, signal?: AbortSignal) => Promise<CorpusResult<CorpusSummary[]>>;
  recallInstitutional: (input: { lifecycleKey: string; limit: number }, signal?: AbortSignal) => Promise<CorpusResult<CorpusSummary[]>>;
  getInstitutional: (recordKey: string, signal?: AbortSignal) => Promise<CorpusResult<FullInstitutionalRecord>>;
  findKnowledge: (input: { query: string; collection: string; limit: number }, signal?: AbortSignal) => Promise<CorpusResult<Array<{ summary: string; score: number }>>>;
};

const versionParts = (value: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1).map(Number) : null;
};
const versionAtLeast = (actual: string, minimum: string) => {
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  if (!actualParts || !minimumParts) return false;
  for (const [index, part] of actualParts.entries()) {
    if (part > minimumParts[index]) return true;
    if (part < minimumParts[index]) return false;
  }
  return true;
};

const vectorMatches = (value: unknown) => {
  const vector = object(value);
  return vector?.size === VECTOR_SIZE && text(vector.distance).toLowerCase() === VECTOR_DISTANCE.toLowerCase();
};
const indexType = (value: unknown) => text(object(value)?.data_type ?? object(value)?.field_type).toLowerCase();
const indexState = (details: CollectionDetails) => {
  const schema = object(details.payload_schema) ?? {};
  const missingIndexes: string[] = [];
  for (const field of REQUIRED_INDEXES) {
    if (!(field in schema)) missingIndexes.push(field);
    else if (indexType(schema[field]) !== "keyword") return { compatible: false, missingIndexes: [] };
  }
  return { compatible: true, missingIndexes };
};

const validateInstitutionalCollection = (details: CollectionDetails): CorpusResult<{ missingIndexes: string[] }> => {
  const config = object(details.config);
  const params = object(config?.params);
  const vectors = object(params?.vectors);
  if (!vectors || !vectorMatches(vectors[VECTOR_NAME])) return failure("collection_incompatible");
  const indexes = indexState(details);
  return indexes.compatible ? success({ missingIndexes: indexes.missingIndexes }) : failure("collection_incompatible");
};

const validateLegacyCollection = (details: CollectionDetails): CorpusResult<undefined> => {
  const config = object(details.config);
  const params = object(config?.params);
  const vectors = params?.vectors;
  return vectorMatches(vectors) ? success(undefined) : failure("collection_incompatible");
};

const normalizedQuery = (value: unknown, maximum = 2_000) => {
  const query = text(value);
  return query && query.length <= maximum && !/[\u0000-\u001f\u007f]/.test(query) ? query : "";
};
const boundedSummary = (value: unknown) => {
  const summary = text(value);
  return summary && utf8ByteLength(summary) <= MAX_SUMMARY_BYTES && !summary.includes("\0") ? summary : "";
};
const normalizedLimit = (value: unknown) => {
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 0;
};
export function createQdrantCorpusClient(
  supplied: QdrantHttpDependencies = {},
): QdrantCorpusClient {
  const fetcher = supplied.fetch ?? globalThis.fetch;
  const timeoutMs = supplied.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maximumResponseBytes = supplied.maxResponseBytes ?? MAX_HTTP_RESPONSE_BYTES;
  const endpoints = resolveCorpusEndpoints(supplied.env ?? process.env);

  const qdrant = (path: string, signal?: AbortSignal, method?: string, body?: unknown) => {
    if (!endpoints.success) return Promise.resolve(failure(endpoints.error.code));
    return requestJson({ fetcher, endpoint: endpoints.data.qdrantUrl, path, signal, method, body, timeoutMs, maximumResponseBytes, unavailableCode: "qdrant_unavailable" });
  };
  const ollama = (path: string, signal?: AbortSignal, method?: string, body?: unknown) => {
    if (!endpoints.success) return Promise.resolve(failure(endpoints.error.code));
    return requestJson({ fetcher, endpoint: endpoints.data.ollamaUrl, path, signal, method, body, timeoutMs, maximumResponseBytes, unavailableCode: "ollama_unavailable" });
  };

  const qdrantVersion = async (signal?: AbortSignal): Promise<CorpusResult<string>> => {
    const response = bodyOrFailure(await qdrant("", signal), "qdrant_unavailable");
    if (!response.success) return response;
    const version = text(object(response.data)?.version);
    return version && versionAtLeast(version, MINIMUM_QDRANT_VERSION)
      ? success(version)
      : version ? failure("qdrant_version_unsupported") : failure("response_invalid");
  };

  const validateEmbeddingModel = async (signal?: AbortSignal): Promise<CorpusResult<undefined>> => {
    const response = bodyOrFailure(await ollama("api/tags", signal), "ollama_unavailable");
    if (!response.success) return response;
    const models = Array.isArray(object(response.data)?.models) ? object(response.data)?.models : null;
    if (!models) return failure("response_invalid");
    const model = models.map(object).find((candidate) =>
      text(candidate?.name) === EMBEDDING_MODEL || text(candidate?.model) === EMBEDDING_MODEL,
    );
    if (!model) return failure("embedding_model_missing");
    return text(model.digest) === EMBEDDING_MODEL_DIGEST
      ? success(undefined)
      : failure("embedding_model_mismatch");
  };

  const readCollection = async (name: string, signal?: AbortSignal): Promise<CorpusResult<CollectionDetails | null>> => {
    const response = await qdrant(`collections/${encodeURIComponent(name)}`, signal);
    if (!response.success) return response;
    if (response.data.status === 404) return success(null);
    if (response.data.status < 200 || response.data.status >= 300) return failure("qdrant_unavailable");
    const details = object(object(response.data.body)?.result);
    return details ? success(details) : failure("response_invalid");
  };

  const institutionalState = async (
    signal?: AbortSignal,
  ): Promise<CorpusResult<{
    collection: "absent" | "needs_indexes" | "ready";
    missingIndexes: string[];
  }>> => {
    const collection = await readCollection(INSTITUTIONAL_COLLECTION, signal);
    if (!collection.success) return collection;
    if (!collection.data) return success({ collection: "absent", missingIndexes: [...REQUIRED_INDEXES] });
    const valid = validateInstitutionalCollection(collection.data);
    if (!valid.success) return valid;
    return success({
      collection: valid.data.missingIndexes.length ? "needs_indexes" : "ready",
      missingIndexes: valid.data.missingIndexes,
    });
  };

  const status = async (signal?: AbortSignal): Promise<CorpusResult<CorpusStatus>> => {
    const version = await qdrantVersion(signal);
    if (!version.success) return version;
    const model = await validateEmbeddingModel(signal);
    if (!model.success) return model;
    const state = await institutionalState(signal);
    return state.success
      ? success({ status: "ready", qdrantVersion: version.data, ...state.data })
      : state;
  };

  const createCollection = async (signal?: AbortSignal): Promise<CorpusResult<undefined>> => {
    const response = bodyOrFailure(await qdrant(
      `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}`,
      signal,
      "PUT",
      { vectors: { [VECTOR_NAME]: { size: VECTOR_SIZE, distance: VECTOR_DISTANCE } } },
    ), "collection_bootstrap_failed");
    return response.success ? success(undefined) : response;
  };

  const createIndexes = async (fields: string[], signal?: AbortSignal): Promise<CorpusResult<undefined>> => {
    for (const field of fields) {
      const response = bodyOrFailure(await qdrant(
        `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/index?wait=true`,
        signal,
        "PUT",
        { field_name: field, field_schema: "keyword" },
      ), "collection_bootstrap_failed");
      if (!response.success) return response;
    }
    return success(undefined);
  };

  const ensureCollection = async (signal?: AbortSignal): Promise<CorpusResult<CorpusStatus>> => {
    const current = await status(signal);
    if (!current.success) return current;
    if (current.data.collection === "absent") {
      const created = await createCollection(signal);
      if (!created.success) return created;
    }
    const afterCreate = await institutionalState(signal);
    if (!afterCreate.success) return afterCreate;
    if (afterCreate.data.missingIndexes.length) {
      const indexed = await createIndexes(afterCreate.data.missingIndexes, signal);
      if (!indexed.success) return indexed;
    }
    const verified = await status(signal);
    return verified.success && verified.data.collection === "ready"
      ? verified
      : verified.success ? failure("collection_bootstrap_failed") : verified;
  };

  const embedSummary = async (summary: string, signal?: AbortSignal): Promise<CorpusResult<number[]>> => {
    if (!boundedSummary(summary)) return failure("record_invalid");
    const model = await validateEmbeddingModel(signal);
    if (!model.success) return model;
    const response = bodyOrFailure(await ollama("api/embed", signal, "POST", {
      model: EMBEDDING_MODEL,
      input: summary,
    }), "embedding_failed");
    if (!response.success) return response;
    const body = object(response.data);
    const embeddings = Array.isArray(body?.embeddings) ? body.embeddings : null;
    const vector = Array.isArray(embeddings?.[0]) ? embeddings[0] : body?.embedding;
    const valid = validateEmbedding(vector);
    return valid.success ? valid : failure("embedding_dimension_mismatch");
  };

  const getRawPoint = async (
    collection: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<CorpusResult<JsonObject | null>> => {
    const response = bodyOrFailure(await qdrant(
      `collections/${encodeURIComponent(collection)}/points`,
      signal,
      "POST",
      { ids: [id], with_payload: true, with_vector: false },
    ), "query_failed");
    if (!response.success) return response;
    const points = Array.isArray(object(response.data)?.result) ? object(response.data)?.result : null;
    if (!points) return failure("response_invalid");
    if (points.length === 0) return success(null);
    const point = object(points[0]);
    return point ? success(point) : failure("response_invalid");
  };

  const getPoint = async (
    id: string,
    signal?: AbortSignal,
  ): Promise<CorpusResult<ExistingInstitutionalRecord | null>> => {
    const state = await institutionalState(signal);
    if (!state.success) return state;
    if (state.data.collection === "absent") return success(null);
    const point = await getRawPoint(INSTITUTIONAL_COLLECTION, id, signal);
    if (!point.success || !point.data) return point;
    return existingInstitutionalRecord({ id: String(point.data.id ?? ""), payload: point.data.payload });
  };

  const insertPoint = async (
    input: { record: InstitutionalRecord; vector: number[] },
    signal?: AbortSignal,
  ): Promise<CorpusResult<undefined>> => {
    const vector = validateEmbedding(input.vector);
    if (!vector.success) return vector;
    const response = await qdrant(
      `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points?wait=true&update_mode=insert_only`,
      signal,
      "PUT",
      { points: [{ id: input.record.id, vector: { [VECTOR_NAME]: vector.data }, payload: input.record.payload }] },
    );
    if (!response.success) return response;
    if (response.data.status === 409) return failure("record_conflict");
    return response.data.status >= 200 && response.data.status < 300
      ? success(undefined)
      : failure("store_failed");
  };

  const summaryFromPoint = (
    point: unknown,
    requireScore: boolean,
  ): CorpusResult<CorpusSummary> => normalizeInstitutionalSummary(point, { requireScore });

  const summaries = (
    points: unknown,
    requireScore: boolean,
  ): CorpusResult<CorpusSummary[]> => {
    if (!Array.isArray(points)) return failure("response_invalid");
    const collected: CorpusSummary[] = [];
    for (const point of points) {
      const result = summaryFromPoint(point, requireScore);
      if (!result.success) return result;
      collected.push(result.data);
    }
    return success(collected);
  };

  const queryFilters = (filters?: CorpusFilters): CorpusResult<JsonObject | undefined> => {
    const normalized = normalizeInstitutionalFilters(filters);
    if (!normalized.success) return normalized;
    const must = normalized.data.map(({ key, value }) => ({ key, match: { value } }));
    return success(must.length ? { must } : undefined);
  };

  const findInstitutional = async (input: { query: string; limit: number; filters?: CorpusFilters }, signal?: AbortSignal): Promise<CorpusResult<CorpusSummary[]>> => {
    const query = normalizedQuery(input.query);
    const limit = normalizedLimit(input.limit);
    if (!query || !limit) return failure("record_invalid");
    const filters = queryFilters(input.filters);
    if (!filters.success) return filters;
    const state = await institutionalState(signal);
    if (!state.success || state.data.collection === "absent") return state.success ? failure("query_failed") : state;
    const vector = await embedSummary(query, signal);
    if (!vector.success) return vector;
    const response = bodyOrFailure(await qdrant(
      `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points/query`,
      signal,
      "POST",
      { query: vector.data, using: VECTOR_NAME, limit, with_payload: { exclude: ["detail"] }, with_vector: false, ...(filters.data ? { filter: filters.data } : {}) },
    ), "query_failed");
    return response.success
      ? summaries(object(response.data)?.result?.points ?? object(response.data)?.result, true)
      : response;
  };

  const recallInstitutional = async (input: { lifecycleKey: string; limit: number }, signal?: AbortSignal): Promise<CorpusResult<CorpusSummary[]>> => {
    const lifecycleKey = normalizedQuery(input.lifecycleKey, 512);
    const limit = normalizedLimit(input.limit);
    if (!lifecycleKey || !limit) return failure("record_invalid");
    const state = await institutionalState(signal);
    if (!state.success || state.data.collection === "absent") return state.success ? failure("query_failed") : state;
    const response = bodyOrFailure(await qdrant(
      `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points/scroll`,
      signal,
      "POST",
      { filter: { must: [{ key: "lifecycle_key", match: { value: lifecycleKey } }] }, limit, with_payload: { exclude: ["detail"] }, with_vector: false },
    ), "query_failed");
    return response.success
      ? summaries(object(object(response.data)?.result)?.points, false)
      : response;
  };

  const getInstitutional = async (recordKey: string, signal?: AbortSignal): Promise<CorpusResult<FullInstitutionalRecord>> => {
    const id = deriveRecordId(recordKey);
    if (!id.success) return id;
    const point = await getRawPoint(INSTITUTIONAL_COLLECTION, id.data, signal);
    if (!point.success) return point;
    if (!point.data) return failure("record_not_found");
    const payload = object(point.data.payload);
    if (!payload || payload.schema_version !== CORPUS_SCHEMA_VERSION) return failure("response_invalid");
    const normalized = normalizeInstitutionalRecord({
      recordKey: payload.record_key,
      project: payload.project,
      site: payload.site,
      repo: payload.repo,
      lifecycleKey: payload.lifecycle_key,
      phase: payload.phase,
      summary: payload.summary,
      detail: payload.detail,
      sourceRefs: payload.source_refs,
    }, payload.created_at);
    if (!normalized.success || normalized.data.id !== id.data || normalized.data.payload.content_hash !== payload.content_hash) {
      return failure("response_invalid");
    }
    const record = normalized.data;
    const output: FullInstitutionalRecord = {
      id: record.id,
      recordKey: record.recordKey,
      project: record.payload.project,
      site: record.payload.site,
      repo: record.payload.repo,
      lifecycleKey: record.payload.lifecycle_key,
      phase: record.payload.phase,
      summary: record.payload.summary,
      detail: record.payload.detail,
      sourceRefs: [...record.payload.source_refs],
      contentHash: record.payload.content_hash,
      createdAt: record.payload.created_at,
    };
    return utf8ByteLength(JSON.stringify(output)) <= 50_000 ? success(output) : failure("record_too_large");
  };

  const findKnowledge = async (input: { query: string; collection: string; limit: number }, signal?: AbortSignal): Promise<CorpusResult<Array<{ summary: string; score: number }>>> => {
    const query = normalizedQuery(input.query);
    const collection = collectionName(input.collection);
    const limit = normalizedLimit(input.limit);
    if (!query || !collection || !limit) return failure("record_invalid");
    if (collection !== LEGACY_KNOWLEDGE_COLLECTION) return failure("collection_incompatible");
    const details = await readCollection(collection, signal);
    if (!details.success || !details.data) return details.success ? failure("query_failed") : details;
    const compatible = validateLegacyCollection(details.data);
    if (!compatible.success) return compatible;
    const vector = await embedSummary(query, signal);
    if (!vector.success) return vector;
    const response = bodyOrFailure(await qdrant(
      `collections/${encodeURIComponent(collection)}/points/search`,
      signal,
      "POST",
      { vector: vector.data, limit, with_payload: true, with_vector: false },
    ), "query_failed");
    if (!response.success) return response;
    const points = object(response.data)?.result;
    if (!Array.isArray(points)) return failure("response_invalid");
    const results = points.map((point) => {
      const source = object(point);
      const payload = object(source?.payload);
      const summary = text(payload?.document ?? payload?.summary);
      const score = source?.score;
      return summary && utf8ByteLength(summary) <= MAX_PAYLOAD_BYTES && typeof score === "number" && Number.isFinite(score)
        ? { summary, score }
        : null;
    });
    return results.some((result) => result === null)
      ? failure("response_invalid")
      : success(results as Array<{ summary: string; score: number }>);
  };

  return {
    status,
    ensureCollection,
    getPoint,
    embedSummary,
    insertPoint,
    findInstitutional,
    recallInstitutional,
    getInstitutional,
    findKnowledge,
  };
}
