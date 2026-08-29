import {
  CORPUS_SCHEMA_VERSION,
  CORPUS_SCHEMA_VERSION_V2,
  DETAIL_CHUNK_RECORD_KIND,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_DIGEST,
  INSTITUTIONAL_COLLECTION,
  MAX_DETAIL_CHUNK_COUNT,
  MAX_PAYLOAD_BYTES,
  MAX_STORED_ARTIFACT_BYTES,
  MAX_SUMMARY_BYTES,
  VECTOR_DISTANCE,
  VECTOR_NAME,
  VECTOR_SIZE,
  corpusFailure as failure,
  deriveRecordId,
  detailChunkIds,
  existingInstitutionalRecord,
  normalizeInstitutionalFilters,
  normalizeInstitutionalManifestPoint,
  normalizeInstitutionalRecord,
  normalizeInstitutionalSummary,
  reassembleInstitutionalManifest,
  utf8ByteLength,
  validateEmbedding,
  type CorpusFailureOperation,
  type CorpusResult,
  type ExistingInstitutionalRecord,
  type InstitutionalFilters,
  type InstitutionalRecord,
  type LogicalCorpusPoint,
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
  resolveCorpusEndpoint,
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
export const MAX_LOGICAL_RECORD_OUTPUT_BYTES = (MAX_STORED_ARTIFACT_BYTES * 6) + 32_000;
const MAX_QDRANT_VERSION_LENGTH = 32;
const QDRANT_VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;
const LEGACY_KNOWLEDGE_COLLECTION = "ima-knowledge";
const REQUIRED_INDEXES = [
  "lifecycle_key",
  "phase",
  "project",
  "site",
  "repo",
  "record_kind",
  "parent_record_key",
] as const;
const MAX_DIRECT_POINT_IDS = MAX_DETAIL_CHUNK_COUNT + 1;
type CollectionDetails = JsonObject;

export type CorpusCollectionState = {
  collection: "absent" | "needs_indexes" | "ready";
  missingIndexes: string[];
};

export type CorpusStatus = CorpusCollectionState & {
  status: "ready";
  qdrantVersion: string;
};

export type CorpusPrerequisites = {
  endpointConfiguration: CorpusResult<undefined>;
  qdrantServiceAndVersion: CorpusResult<string>;
  ollamaEmbeddingModel: CorpusResult<undefined>;
  institutionalCollection: CorpusResult<CorpusCollectionState>;
};

export const corpusStatusFromPrerequisites = (
  prerequisites: CorpusPrerequisites,
): CorpusResult<CorpusStatus> => {
  if (!prerequisites.endpointConfiguration.success) return prerequisites.endpointConfiguration;
  if (!prerequisites.qdrantServiceAndVersion.success) return prerequisites.qdrantServiceAndVersion;
  if (!prerequisites.ollamaEmbeddingModel.success) return prerequisites.ollamaEmbeddingModel;
  if (!prerequisites.institutionalCollection.success) return prerequisites.institutionalCollection;
  return success({
    status: "ready",
    qdrantVersion: prerequisites.qdrantServiceAndVersion.data,
    ...prerequisites.institutionalCollection.data,
  });
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
  preflight: (signal?: AbortSignal) => Promise<CorpusResult<CorpusPrerequisites>>;
  status: (signal?: AbortSignal) => Promise<CorpusResult<CorpusStatus>>;
  ensureCollection: (signal?: AbortSignal) => Promise<CorpusResult<CorpusStatus>>;
  getPoint: (id: string, signal?: AbortSignal) => Promise<CorpusResult<ExistingInstitutionalRecord | null>>;
  getPoints: (ids: string[], signal?: AbortSignal) => Promise<CorpusResult<unknown[]>>;
  embedSummary: (summary: string, signal?: AbortSignal) => Promise<CorpusResult<number[]>>;
  insertPoint: (input: { record: InstitutionalRecord; vector: number[] }, signal?: AbortSignal) => Promise<CorpusResult<undefined>>;
  insertPoints: (input: { points: LogicalCorpusPoint[] }, signal?: AbortSignal) => Promise<CorpusResult<undefined>>;
  findInstitutional: (input: { query: string; limit: number; filters?: CorpusFilters }, signal?: AbortSignal) => Promise<CorpusResult<CorpusSummary[]>>;
  recallInstitutional: (input: { lifecycleKey: string; limit: number; phase?: string }, signal?: AbortSignal) => Promise<CorpusResult<CorpusSummary[]>>;
  getInstitutional: (recordKey: string, signal?: AbortSignal) => Promise<CorpusResult<FullInstitutionalRecord>>;
  findKnowledge: (input: { query: string; collection: string; limit: number }, signal?: AbortSignal) => Promise<CorpusResult<Array<{ summary: string; score: number }>>>;
};

const versionParts = (value: string) => {
  if (value.length > MAX_QDRANT_VERSION_LENGTH) return null;
  const match = QDRANT_VERSION.exec(value);
  const parts = match?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : null;
};

const versionAtLeast = (actual: number[], minimum: string) => {
  const minimumParts = versionParts(minimum);
  if (!minimumParts) return false;
  for (const [index, part] of actual.entries()) {
    if (part > minimumParts[index]) return true;
    if (part < minimumParts[index]) return false;
  }
  return true;
};

const vectorMatches = (value: unknown) => {
  const vector = object(value);
  return vector?.size === VECTOR_SIZE
    && text(vector.distance).toLowerCase() === VECTOR_DISTANCE.toLowerCase();
};

const indexType = (value: unknown) =>
  text(object(value)?.data_type ?? object(value)?.field_type).toLowerCase();

const indexState = (details: CollectionDetails) => {
  const schema = object(details.payload_schema) ?? {};
  const missingIndexes: string[] = [];
  for (const field of REQUIRED_INDEXES) {
    if (!(field in schema)) missingIndexes.push(field);
    else if (indexType(schema[field]) !== "keyword") return { compatible: false, missingIndexes: [] };
  }
  return { compatible: true, missingIndexes };
};

const validateInstitutionalCollection = (
  details: CollectionDetails,
): CorpusResult<{ missingIndexes: string[] }> => {
  const config = object(details.config);
  const params = object(config?.params);
  const vectors = object(params?.vectors);
  if (!vectors || !vectorMatches(vectors[VECTOR_NAME])) return failure("collection_incompatible");
  const indexes = indexState(details);
  return indexes.compatible
    ? success({ missingIndexes: indexes.missingIndexes })
    : failure("collection_incompatible");
};

const validateLegacyCollection = (details: CollectionDetails): CorpusResult<undefined> => {
  const config = object(details.config);
  const params = object(config?.params);
  const vectors = params?.vectors;
  return vectorMatches(vectors) ? success(undefined) : failure("collection_incompatible");
};

const normalizedQuery = (value: unknown, maximum = 2_000) => {
  const query = text(value);
  return query && query.length <= maximum && !/[\u0000-\u001f\u007f]/.test(query)
    ? query
    : "";
};

const boundedSummary = (value: unknown) => {
  const summary = text(value);
  return summary
    && utf8ByteLength(summary) <= MAX_SUMMARY_BYTES
    && !/[\u0000-\u001f\u007f]/.test(summary)
    ? summary
    : "";
};

const normalizedLimit = (value: unknown) => {
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 0;
};

const directPointIds = (value: unknown): string[] | null => {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_DIRECT_POINT_IDS
    || !value.every((id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  ) return null;
  const ids = [...value];
  return new Set(ids).size === ids.length ? ids : null;
};

const resolveInstitutionalPointId = (reference: string): CorpusResult<string> => {
  const [directPointId] = directPointIds([reference]) ?? [];
  return directPointId ? success(directPointId) : deriveRecordId(reference);
};

const detailChunkFilter = () => ({
  must_not: [{ key: "record_kind", match: { value: DETAIL_CHUNK_RECORD_KIND } }],
});

const withManifestFilter = (filter?: JsonObject) => ({
  ...(filter ?? {}),
  ...detailChunkFilter(),
});

const fullRecord = (input: {
  id: string;
  recordKey: string;
  payload: {
    project: string;
    site: string;
    repo: string;
    lifecycle_key: string;
    phase: string;
    summary: string;
    source_refs: string[];
    content_hash: string;
    created_at: string;
  };
  detail: string;
}): FullInstitutionalRecord => ({
  id: input.id,
  recordKey: input.recordKey,
  project: input.payload.project,
  site: input.payload.site,
  repo: input.payload.repo,
  lifecycleKey: input.payload.lifecycle_key,
  phase: input.payload.phase,
  summary: input.payload.summary,
  detail: input.detail,
  sourceRefs: [...input.payload.source_refs],
  contentHash: input.payload.content_hash,
  createdAt: input.payload.created_at,
});

export function createQdrantCorpusClient(
  supplied: QdrantHttpDependencies = {},
): QdrantCorpusClient {
  const fetcher = supplied.fetch ?? globalThis.fetch;
  const timeoutMs = supplied.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maximumResponseBytes = supplied.maxResponseBytes ?? MAX_HTTP_RESPONSE_BYTES;
  const maxAttempts = supplied.maxAttempts;
  const environment = supplied.env ?? process.env;
  const resolvedEndpoints = resolveCorpusEndpoints(environment);
  const endpointConfiguration = resolvedEndpoints.success
    ? success(undefined)
    : resolvedEndpoints;
  const qdrantUrl = resolveCorpusEndpoint(environment.IMA_QDRANT_URL, DEFAULT_QDRANT_URL);
  const ollamaUrl = resolveCorpusEndpoint(environment.IMA_OLLAMA_URL, DEFAULT_OLLAMA_URL);

  const endpointFailure = (
    code: "qdrant_unavailable" | "ollama_unavailable",
  ) => failure(code, {
    operation: "endpoint_configuration",
    cause: "invalid_configuration",
  });

  const qdrant = (
    path: string,
    signal?: AbortSignal,
    method?: string,
    body?: unknown,
    operation?: CorpusFailureOperation,
  ) => {
    if (aborted(signal)) return Promise.resolve(failure("aborted"));
    if (!qdrantUrl) return Promise.resolve(endpointFailure("qdrant_unavailable"));
    return requestJson({
      fetcher,
      endpoint: qdrantUrl,
      path,
      signal,
      method,
      body,
      timeoutMs,
      maximumResponseBytes,
      maxAttempts,
      unavailableCode: "qdrant_unavailable",
      operation,
    });
  };

  const ollama = (
    path: string,
    signal?: AbortSignal,
    method?: string,
    body?: unknown,
    operation?: CorpusFailureOperation,
  ) => {
    if (aborted(signal)) return Promise.resolve(failure("aborted"));
    if (!ollamaUrl) return Promise.resolve(endpointFailure("ollama_unavailable"));
    return requestJson({
      fetcher,
      endpoint: ollamaUrl,
      path,
      signal,
      method,
      body,
      timeoutMs,
      maximumResponseBytes,
      maxAttempts,
      unavailableCode: "ollama_unavailable",
      operation,
    });
  };

  const qdrantVersion = async (signal?: AbortSignal): Promise<CorpusResult<string>> => {
    const response = bodyOrFailure(
      await qdrant("", signal, undefined, undefined, "qdrant_version"),
      "qdrant_unavailable",
      "qdrant_version",
    );
    if (!response.success) return response;
    const version = text(object(response.data)?.version);
    const parts = versionParts(version);
    if (!parts) {
      return failure("response_invalid", {
        operation: "qdrant_version",
        cause: "invalid_response",
      });
    }
    return versionAtLeast(parts, MINIMUM_QDRANT_VERSION)
      ? success(version)
      : failure("qdrant_version_unsupported", {
        operation: "qdrant_version",
        cause: "incompatible",
      });
  };

  const validateEmbeddingModel = async (signal?: AbortSignal): Promise<CorpusResult<undefined>> => {
    const response = bodyOrFailure(
      await ollama("api/tags", signal, undefined, undefined, "ollama_embedding_model"),
      "ollama_unavailable",
      "ollama_embedding_model",
    );
    if (!response.success) return response;
    const models = Array.isArray(object(response.data)?.models)
      ? object(response.data)?.models
      : null;
    if (!models) {
      return failure("response_invalid", {
        operation: "ollama_embedding_model",
        cause: "invalid_response",
      });
    }
    const model = models.map(object).find((candidate) =>
      text(candidate?.name) === EMBEDDING_MODEL || text(candidate?.model) === EMBEDDING_MODEL,
    );
    if (!model) {
      return failure("embedding_model_missing", {
        operation: "ollama_embedding_model",
        cause: "incompatible",
      });
    }
    return text(model.digest) === EMBEDDING_MODEL_DIGEST
      ? success(undefined)
      : failure("embedding_model_mismatch", {
        operation: "ollama_embedding_model",
        cause: "incompatible",
      });
  };

  const readCollection = async (
    name: string,
    signal?: AbortSignal,
    operation?: CorpusFailureOperation,
  ): Promise<CorpusResult<CollectionDetails | null>> => {
    const response = await qdrant(
      `collections/${encodeURIComponent(name)}`,
      signal,
      undefined,
      undefined,
      operation,
    );
    if (!response.success) return response;
    if (response.data.status === 404) return success(null);
    const body = bodyOrFailure(response, "qdrant_unavailable", operation);
    if (!body.success) return body;
    const details = object(object(body.data)?.result);
    return details
      ? success(details)
      : operation
        ? failure("response_invalid", { operation, cause: "invalid_response" })
        : failure("response_invalid");
  };

  const institutionalState = async (
    signal?: AbortSignal,
  ): Promise<CorpusResult<CorpusCollectionState>> => {
    const collection = await readCollection(
      INSTITUTIONAL_COLLECTION,
      signal,
      "institutional_collection",
    );
    if (!collection.success) return collection;
    if (!collection.data) return success({ collection: "absent", missingIndexes: [...REQUIRED_INDEXES] });
    const valid = validateInstitutionalCollection(collection.data);
    if (!valid.success) {
      return failure(valid.error.code, {
        operation: "institutional_collection",
        cause: "incompatible",
      });
    }
    return success({
      collection: valid.data.missingIndexes.length ? "needs_indexes" : "ready",
      missingIndexes: valid.data.missingIndexes,
    });
  };

  const preflight = async (
    signal?: AbortSignal,
  ): Promise<CorpusResult<CorpusPrerequisites>> => {
    if (aborted(signal)) return failure("aborted");
    try {
      const [qdrantServiceAndVersion, ollamaEmbeddingModel, institutionalCollection] = await Promise.all([
        qdrantVersion(signal),
        validateEmbeddingModel(signal),
        institutionalState(signal),
      ]);
      if (aborted(signal)) return failure("aborted");
      if ([qdrantServiceAndVersion, ollamaEmbeddingModel, institutionalCollection].some(
        (result) => !result.success && result.error.code === "aborted",
      )) return failure("aborted");
      return success({
        endpointConfiguration,
        qdrantServiceAndVersion,
        ollamaEmbeddingModel,
        institutionalCollection,
      });
    } catch {
      if (aborted(signal)) return failure("aborted");
      return failure("qdrant_unavailable", {
        operation: "qdrant_version",
        cause: "client_exception",
      });
    }
  };

  const status = async (signal?: AbortSignal): Promise<CorpusResult<CorpusStatus>> => {
    const prerequisites = await preflight(signal);
    return prerequisites.success ? corpusStatusFromPrerequisites(prerequisites.data) : prerequisites;
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

  const createIndexes = async (
    fields: string[],
    signal?: AbortSignal,
  ): Promise<CorpusResult<undefined>> => {
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

  const embedSummary = async (
    summary: string,
    signal?: AbortSignal,
  ): Promise<CorpusResult<number[]>> => {
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
    const values = Array.isArray(object(response.data)?.result)
      ? object(response.data)?.result
      : null;
    if (!values || values.some((value) => !object(value)) || values.length > 1) {
      return failure("response_invalid");
    }
    if (values.length === 0) return success(null);
    const point = object(values[0]);
    return point && point.id === id ? success(point) : failure("response_invalid");
  };

  const getRawPoints = async (
    collection: string,
    ids: string[],
    signal?: AbortSignal,
  ): Promise<CorpusResult<JsonObject[]>> => {
    const boundedIds = directPointIds(ids);
    if (!boundedIds) return failure("record_invalid");

    const points: JsonObject[] = [];
    for (const id of boundedIds) {
      if (aborted(signal)) return failure("aborted");
      const point = await getRawPoint(collection, id, signal);
      if (!point.success) return point;
      if (point.data) points.push(point.data);
    }
    return success(points);
  };

  const getPoints = async (
    ids: string[],
    signal?: AbortSignal,
  ): Promise<CorpusResult<unknown[]>> => {
    const state = await institutionalState(signal);
    if (!state.success) return state;
    if (state.data.collection === "absent") return success([]);
    return getRawPoints(INSTITUTIONAL_COLLECTION, ids, signal);
  };

  const getPoint = async (
    id: string,
    signal?: AbortSignal,
  ): Promise<CorpusResult<ExistingInstitutionalRecord | null>> => {
    const points = await getPoints([id], signal);
    if (!points.success) return points;
    if (points.data.length === 0) return success(null);
    if (points.data.length !== 1) return failure("response_invalid");
    return existingInstitutionalRecord(points.data[0]);
  };

  const insertPoints = async (
    input: { points: LogicalCorpusPoint[] },
    signal?: AbortSignal,
  ): Promise<CorpusResult<undefined>> => {
    if (!Array.isArray(input.points) || input.points.length < 1 || input.points.length > MAX_DIRECT_POINT_IDS) {
      return failure("record_invalid");
    }
    const ids = directPointIds(input.points.map((point) => point?.id));
    if (!ids) return failure("record_invalid");

    const vectorless = input.points.every((point) => point.vector === undefined);
    if (!vectorless && input.points.some((point) => point.vector === undefined)) {
      return failure("record_invalid");
    }

    const points: Array<{ id: string; payload: unknown; vector: Record<string, number[]> }> = [];
    for (const point of input.points) {
      if (!object(point?.payload)) return failure("record_invalid");
      if (vectorless) continue;
      const vector = validateEmbedding(point.vector);
      if (!vector.success) return vector;
      points.push({ id: point.id, payload: point.payload, vector: { [VECTOR_NAME]: vector.data } });
    }

    const body = vectorless
      ? {
        batch: {
          ids,
          vectors: {},
          payloads: input.points.map((point) => point.payload),
        },
      }
      : { points };
    const response = await qdrant(
      `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points?wait=true&update_mode=insert_only`,
      signal,
      "PUT",
      body,
      "institutional_collection",
    );
    if (!response.success) return response;
    if (response.data.status === 409) return failure("record_conflict");
    return response.data.status >= 200 && response.data.status < 300
      ? success(undefined)
      : failure("store_failed");
  };

  const insertPoint = async (
    input: { record: InstitutionalRecord; vector: number[] },
    signal?: AbortSignal,
  ): Promise<CorpusResult<undefined>> => insertPoints({
    points: [{ id: input.record.id, payload: input.record.payload, vector: input.vector }],
  }, signal);

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

  const findInstitutional = async (
    input: { query: string; limit: number; filters?: CorpusFilters },
    signal?: AbortSignal,
  ): Promise<CorpusResult<CorpusSummary[]>> => {
    const query = normalizedQuery(input.query);
    const limit = normalizedLimit(input.limit);
    if (!query || !limit) return failure("record_invalid");
    const filters = queryFilters(input.filters);
    if (!filters.success) return filters;
    const state = await institutionalState(signal);
    if (!state.success || state.data.collection === "absent") {
      return state.success ? failure("query_failed") : state;
    }
    const vector = await embedSummary(query, signal);
    if (!vector.success) return vector;
    const response = bodyOrFailure(await qdrant(
      `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points/query`,
      signal,
      "POST",
      {
        query: vector.data,
        using: VECTOR_NAME,
        limit,
        with_payload: { exclude: ["detail", "detail_chunk"] },
        with_vector: false,
        filter: withManifestFilter(filters.data),
      },
    ), "query_failed");
    return response.success
      ? summaries(object(response.data)?.result?.points ?? object(response.data)?.result, true)
      : response;
  };

  const recallInstitutional = async (
    input: { lifecycleKey: string; limit: number; phase?: string },
    signal?: AbortSignal,
  ): Promise<CorpusResult<CorpusSummary[]>> => {
    const lifecycleKey = normalizedQuery(input.lifecycleKey, 512);
    const phase = input.phase === undefined ? "" : normalizedQuery(input.phase, 128);
    const limit = normalizedLimit(input.limit);
    if (!lifecycleKey || !limit || (input.phase !== undefined && !phase)) {
      return failure("record_invalid");
    }
    const state = await institutionalState(signal);
    if (!state.success || state.data.collection === "absent") {
      return state.success ? failure("query_failed") : state;
    }
    const must = [
      { key: "lifecycle_key", match: { value: lifecycleKey } },
      ...(phase ? [{ key: "phase", match: { value: phase } }] : []),
    ];
    const response = bodyOrFailure(await qdrant(
      `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points/scroll`,
      signal,
      "POST",
      {
        filter: { must, ...detailChunkFilter() },
        limit,
        with_payload: { exclude: ["detail", "detail_chunk"] },
        with_vector: false,
      },
    ), "query_failed");
    return response.success
      ? summaries(object(object(response.data)?.result)?.points, false)
      : response;
  };

  const getInstitutional = async (
    recordKey: string,
    signal?: AbortSignal,
  ): Promise<CorpusResult<FullInstitutionalRecord>> => {
    const id = resolveInstitutionalPointId(recordKey);
    if (!id.success) return id;
    const points = await getRawPoints(INSTITUTIONAL_COLLECTION, [id.data], signal);
    if (!points.success) return points;
    if (points.data.length === 0) return failure("record_not_found");
    if (points.data.length !== 1) return failure("response_invalid");

    const point = object(points.data[0]);
    const payload = object(point?.payload);
    if (!point || !payload) return failure("response_invalid");

    if (payload.schema_version === CORPUS_SCHEMA_VERSION) {
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
      if (
        !normalized.success
        || normalized.data.id !== id.data
        || normalized.data.payload.content_hash !== payload.content_hash
      ) return failure("response_invalid");
      const output = fullRecord({
        id: normalized.data.id,
        recordKey: normalized.data.recordKey,
        payload: normalized.data.payload,
        detail: normalized.data.payload.detail,
      });
      return utf8ByteLength(JSON.stringify(output)) <= MAX_LOGICAL_RECORD_OUTPUT_BYTES
        ? success(output)
        : failure("record_too_large");
    }

    if (payload.schema_version !== CORPUS_SCHEMA_VERSION_V2) return failure("response_invalid");
    const manifest = normalizeInstitutionalManifestPoint(point);
    if (!manifest.success || manifest.data.id !== id.data) return failure("response_invalid");
    const chunks = await getRawPoints(
      INSTITUTIONAL_COLLECTION,
      detailChunkIds(manifest.data.recordKey, manifest.data.payload.chunk_count),
      signal,
    );
    if (!chunks.success) return chunks;
    const reassembled = reassembleInstitutionalManifest({
      manifestPoint: point,
      chunkPoints: chunks.data,
    });
    if (!reassembled.success) return reassembled;
    const output = fullRecord({
      id: reassembled.data.id,
      recordKey: reassembled.data.recordKey,
      payload: reassembled.data.payload,
      detail: reassembled.data.detail,
    });
    return utf8ByteLength(JSON.stringify(output)) <= MAX_LOGICAL_RECORD_OUTPUT_BYTES
      ? success(output)
      : failure("record_too_large");
  };

  const findKnowledge = async (
    input: { query: string; collection: string; limit: number },
    signal?: AbortSignal,
  ): Promise<CorpusResult<Array<{ summary: string; score: number }>>> => {
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
      return summary
        && utf8ByteLength(summary) <= MAX_PAYLOAD_BYTES
        && typeof score === "number"
        && Number.isFinite(score)
        ? { summary, score }
        : null;
    });
    return results.some((result) => result === null)
      ? failure("response_invalid")
      : success(results as Array<{ summary: string; score: number }>);
  };

  return {
    preflight,
    status,
    ensureCollection,
    getPoint,
    getPoints,
    embedSummary,
    insertPoint,
    insertPoints,
    findInstitutional,
    recallInstitutional,
    getInstitutional,
    findKnowledge,
  };
}
