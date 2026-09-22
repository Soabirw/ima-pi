import { LIFECYCLE_PHASES, normalizeLifecycleRecordKey } from "./ima-lifecycle.ts";
import {
  CORPUS_SCHEMA_VERSION,
  CORPUS_SCHEMA_VERSION_V2,
  DETAIL_CHUNK_RECORD_KIND,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_DIGEST,
  INSTITUTIONAL_COLLECTION,
  MANIFEST_RECORD_KIND,
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
import {
  MAX_QDRANT_LIFECYCLE_RECOVERY_RECORDS,
  lifecycleRecoveryPointIds,
  projectQdrantLifecycleRecoveryInventory,
  sameQdrantLifecycleRecoveryInventory,
  type QdrantLifecycleRecoveryInventory,
} from "./qdrant-lifecycle-recovery-report.ts";

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
const LIFECYCLE_PHASE_SET = new Set<string>(LIFECYCLE_PHASES);
const MAX_LIFECYCLE_RECALL_LIMIT = 50;
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
const RECOVERY_SCROLL_PAGE_SIZE = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  recallLifecycleInstitutional: (input: { lifecycleKey: string; limit: number; phase?: string }, signal?: AbortSignal) => Promise<CorpusResult<FullInstitutionalRecord[]>>;
  getInstitutional: (recordKey: string, signal?: AbortSignal) => Promise<CorpusResult<FullInstitutionalRecord>>;
  inventoryLifecycleRecovery: (lifecycleKey: string, signal?: AbortSignal) => Promise<CorpusResult<QdrantLifecycleRecoveryInventory>>;
  deleteLifecycleRecoveryInventory: (input: { lifecycleKey: string; inventory: unknown }, signal?: AbortSignal) => Promise<CorpusResult<undefined>>;
  proveLifecycleRecoveryAbsence: (input: { lifecycleKey: string; inventory: unknown }, signal?: AbortSignal) => Promise<CorpusResult<undefined>>;
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

const lifecycleRecallSelection = (
  value: unknown,
): { lifecycleKey: string; limit: number; phase?: string } | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string")
      || (keys.length !== 2 && keys.length !== 3)
      || !keys.includes("lifecycleKey")
      || !keys.includes("limit")
      || keys.some((key) => !["lifecycleKey", "limit", "phase"].includes(key as string))
    ) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value");
    })) return null;

    const lifecycleKey = descriptors.lifecycleKey.value;
    const limit = descriptors.limit.value;
    const hasPhase = Object.hasOwn(descriptors, "phase");
    const phase = hasPhase ? descriptors.phase.value : undefined;
    if (
      typeof lifecycleKey !== "string"
      || lifecycleKey !== lifecycleKey.trim()
      || !lifecycleKey
      || utf8ByteLength(lifecycleKey) > 512
      || /[\u0000-\u001f\u007f-\u009f]/.test(lifecycleKey)
      || !Number.isInteger(limit)
      || limit < 1
      || limit > MAX_LIFECYCLE_RECALL_LIMIT
      || (hasPhase && (
        typeof phase !== "string"
        || phase !== phase.trim()
        || !phase
        || utf8ByteLength(phase) > 128
        || /[\u0000-\u001f\u007f-\u009f]/.test(phase)
        || !LIFECYCLE_PHASE_SET.has(phase)
      ))
    ) return null;
    return {
      lifecycleKey,
      limit,
      ...(hasPhase ? { phase: phase as string } : {}),
    };
  } catch {
    return null;
  }
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

const ownDataField = (value: unknown, key: string): { value: unknown } | null => {
  try {
    const source = object(value);
    const descriptor = source && Object.getOwnPropertyDescriptor(source, key);
    return descriptor
      && !descriptor.get
      && !descriptor.set
      && Object.hasOwn(descriptor, "value")
      ? { value: descriptor.value }
      : null;
  } catch {
    return null;
  }
};

const recoveryDataArray = (value: unknown, maximum: number): unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > maximum
      || keys.length !== length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;
    const entries: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) return null;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
};

const recoveryLifecycleKey = (value: unknown): string | null => {
  const key = normalizeLifecycleRecordKey(value);
  return key && key === value ? key : null;
};

const recoveryPoint = (value: unknown): { id: string; payload: JsonObject } | null => {
  try {
    const source = object(value);
    const keys = source ? Reflect.ownKeys(source) : [];
    const descriptors = source ? Object.getOwnPropertyDescriptors(source) : {};
    if (
      !source
      || keys.length !== 2
      || keys.some((key) => typeof key !== "string" || !["id", "payload"].includes(key))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    const id = descriptors.id.value;
    const payload = descriptors.payload.value;
    return typeof id === "string" && UUID.test(id) && object(payload)
      ? { id, payload: object(payload) as JsonObject }
      : null;
  } catch {
    return null;
  }
};

const recoveryField = (payload: JsonObject, key: string) => ownDataField(payload, key)?.value;

const terminalLifecycleScroll = (value: unknown): CorpusResult<JsonObject> => {
  const result = ownDataField(value, "result");
  const scroll = object(result?.value);
  const nextPageOffset = ownDataField(scroll, "next_page_offset");
  if (!scroll || !nextPageOffset) return failure("response_invalid");
  if (nextPageOffset.value === null) return success(scroll);
  return typeof nextPageOffset.value === "string"
    || (typeof nextPageOffset.value === "number" && Number.isFinite(nextPageOffset.value))
    ? failure("lifecycle_scroll_non_terminal")
    : failure("response_invalid");
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
    attempts?: number,
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
      maxAttempts: attempts ?? maxAttempts,
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

  const recoveryCollection = async (
    signal?: AbortSignal,
  ): Promise<CorpusResult<undefined>> => {
    const state = await institutionalState(signal);
    if (!state.success) return state;
    if (state.data.collection === "absent") return failure("query_failed");
    return state.data.collection === "ready"
      ? success(undefined)
      : failure("collection_incompatible");
  };

  const recoveryScroll = async (input: {
    filter: JsonObject;
    maximumPoints: number;
    signal?: AbortSignal;
  }): Promise<CorpusResult<JsonObject[]>> => {
    const points: JsonObject[] = [];
    const pointIds = new Set<string>();
    const offsets = new Set<string>();
    let offset: string | undefined;

    for (;;) {
      if (aborted(input.signal)) return failure("aborted");
      const response = bodyOrFailure(await qdrant(
        `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points/scroll`,
        input.signal,
        "POST",
        {
          filter: input.filter,
          limit: RECOVERY_SCROLL_PAGE_SIZE,
          with_payload: true,
          with_vector: false,
          ...(offset === undefined ? {} : { offset }),
        },
        "institutional_collection",
      ), "query_failed", "institutional_collection");
      if (!response.success) return response;

      const result = ownDataField(response.data, "result")?.value;
      const scroll = object(result);
      const pagePoints = recoveryDataArray(ownDataField(scroll, "points")?.value, RECOVERY_SCROLL_PAGE_SIZE);
      const nextPageOffset = ownDataField(scroll, "next_page_offset")?.value;
      if (!scroll || !pagePoints || nextPageOffset === undefined) return failure("response_invalid");

      for (const rawPoint of pagePoints) {
        const point = recoveryPoint(rawPoint);
        if (!point || pointIds.has(point.id)) return failure("response_invalid");
        pointIds.add(point.id);
        points.push({ id: point.id, payload: point.payload });
      }
      if (points.length > input.maximumPoints) return failure("response_invalid");
      if (nextPageOffset === null) return success(points);
      if (typeof nextPageOffset !== "string" || !UUID.test(nextPageOffset) || !pagePoints.length) {
        return failure("response_invalid");
      }
      if (offsets.has(nextPageOffset)) return failure("response_invalid");
      offsets.add(nextPageOffset);
      offset = nextPageOffset;
    }
  };

  const recoveryRootDescriptor = (pointValue: JsonObject): {
    storageSchemaVersion: 1 | 2;
    recordKey: string;
    contentHash: string;
    chunkCount: number;
    point: JsonObject;
  } | null => {
    const point = recoveryPoint(pointValue);
    if (!point) return null;
    const schemaVersion = recoveryField(point.payload, "schema_version");
    const recordKey = recoveryLifecycleKey(recoveryField(point.payload, "record_key"));
    const contentHash = recoveryField(point.payload, "content_hash");
    if (
      !recordKey
      || typeof contentHash !== "string"
      || !/^[a-f0-9]{64}$/.test(contentHash)
    ) return null;
    if (schemaVersion === 1) {
      return {
        storageSchemaVersion: 1,
        recordKey,
        contentHash,
        chunkCount: 0,
        point: { id: point.id, payload: point.payload },
      };
    }
    const recordKind = recoveryField(point.payload, "record_kind");
    const chunkCount = recoveryField(point.payload, "chunk_count");
    return schemaVersion === 2
      && recordKind === MANIFEST_RECORD_KIND
      && Number.isInteger(chunkCount)
      && Number(chunkCount) >= 1
      && Number(chunkCount) <= MAX_DETAIL_CHUNK_COUNT
      ? {
        storageSchemaVersion: 2,
        recordKey,
        contentHash,
        chunkCount: Number(chunkCount),
        point: { id: point.id, payload: point.payload },
      }
      : null;
  };

  const recoveryInventory = async (
    lifecycleKeyValue: string,
    signal?: AbortSignal,
  ): Promise<CorpusResult<QdrantLifecycleRecoveryInventory>> => {
    const lifecycleKey = recoveryLifecycleKey(lifecycleKeyValue);
    if (!lifecycleKey) return failure("record_invalid");
    const collection = await recoveryCollection(signal);
    if (!collection.success) return collection;
    const rootPoints = await recoveryScroll({
      filter: { must: [{ key: "lifecycle_key", match: { value: lifecycleKey } }] },
      maximumPoints: MAX_QDRANT_LIFECYCLE_RECOVERY_RECORDS,
      signal,
    });
    if (!rootPoints.success) return rootPoints;

    const roots = rootPoints.data.map(recoveryRootDescriptor);
    if (roots.some((root) => root === null)) return failure("response_invalid");
    const descriptors = roots as Array<NonNullable<typeof roots[number]>>;
    const recordKeys = new Set<string>();
    const rootIds = new Set<string>();
    if (descriptors.some((root) => {
      if (recordKeys.has(root.recordKey) || rootIds.has(root.point.id)) return true;
      recordKeys.add(root.recordKey);
      rootIds.add(root.point.id);
      return false;
    })) return failure("response_invalid");

    const records: unknown[] = [];
    for (const root of descriptors) {
      if (aborted(signal)) return failure("aborted");
      if (root.storageSchemaVersion === 1) {
        records.push({
          storageSchemaVersion: 1,
          recordKey: root.recordKey,
          contentHash: root.contentHash,
          points: [root.point],
        });
        continue;
      }

      const expectedChunkIds = detailChunkIds(root.recordKey, root.chunkCount);
      const directChunks = await getRawPoints(INSTITUTIONAL_COLLECTION, expectedChunkIds, signal);
      if (!directChunks.success) return directChunks;
      if (directChunks.data.length !== expectedChunkIds.length) return failure("record_incomplete");

      const parentChunks = await recoveryScroll({
        filter: { must: [{ key: "parent_record_key", match: { value: root.recordKey } }] },
        maximumPoints: MAX_DETAIL_CHUNK_COUNT,
        signal,
      });
      if (!parentChunks.success) return parentChunks;
      const parentById = new Map<string, JsonObject>();
      for (const point of parentChunks.data) {
        const parsed = recoveryPoint(point);
        if (!parsed || parentById.has(parsed.id)) return failure("response_invalid");
        parentById.set(parsed.id, { id: parsed.id, payload: parsed.payload });
      }
      if (
        parentById.size !== expectedChunkIds.length
        || expectedChunkIds.some((id) => !parentById.has(id))
      ) return failure("record_incomplete");

      const directCandidate = projectQdrantLifecycleRecoveryInventory({
        schemaVersion: 1,
        lifecycleKey,
        records: [{
          storageSchemaVersion: 2,
          recordKey: root.recordKey,
          contentHash: root.contentHash,
          points: [root.point, ...directChunks.data],
        }],
      });
      const parentCandidate = projectQdrantLifecycleRecoveryInventory({
        schemaVersion: 1,
        lifecycleKey,
        records: [{
          storageSchemaVersion: 2,
          recordKey: root.recordKey,
          contentHash: root.contentHash,
          points: [root.point, ...expectedChunkIds.map((id) => parentById.get(id))],
        }],
      });
      if (
        !directCandidate
        || !parentCandidate
        || !sameQdrantLifecycleRecoveryInventory(directCandidate, parentCandidate)
      ) return failure("record_incomplete");
      records.push(parentCandidate.records[0]);
    }

    const inventory = projectQdrantLifecycleRecoveryInventory({
      schemaVersion: 1,
      lifecycleKey,
      records: [...records].sort((left, right) => {
        const leftKey = typeof left === "object" && left !== null
          ? (left as { recordKey?: unknown }).recordKey
          : "";
        const rightKey = typeof right === "object" && right !== null
          ? (right as { recordKey?: unknown }).recordKey
          : "";
        if (typeof leftKey !== "string" || typeof rightKey !== "string") return 0;
        if (leftKey < rightKey) return -1;
        if (leftKey > rightKey) return 1;
        return 0;
      }),
    });
    return inventory ? success(inventory) : failure("response_invalid");
  };

  const deletionCompleted = (value: unknown) => {
    const responseStatus = ownDataField(value, "status")?.value;
    const result = ownDataField(value, "result")?.value;
    const status = object(result) ? ownDataField(result, "status")?.value : undefined;
    const operationId = object(result) ? ownDataField(result, "operation_id")?.value : undefined;
    return responseStatus === "ok"
      && status === "completed"
      && Number.isSafeInteger(operationId)
      && Number(operationId) >= 0;
  };

  const deleteLifecycleRecoveryInventory = async (
    input: { lifecycleKey: string; inventory: unknown },
    signal?: AbortSignal,
  ): Promise<CorpusResult<undefined>> => {
    const lifecycleKey = recoveryLifecycleKey(input.lifecycleKey);
    const expected = projectQdrantLifecycleRecoveryInventory(input.inventory);
    const pointIds = lifecycleRecoveryPointIds(expected);
    if (!lifecycleKey || !expected || expected.lifecycleKey !== lifecycleKey || !pointIds) {
      return failure("record_invalid");
    }
    const current = await recoveryInventory(lifecycleKey, signal);
    if (!current.success) return current;
    if (!sameQdrantLifecycleRecoveryInventory(current.data, expected)) {
      return failure("record_conflict");
    }
    if (pointIds.length === 0) return success(undefined);

    const deleted = bodyOrFailure(await qdrant(
      `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points/delete?wait=true`,
      signal,
      "POST",
      { points: pointIds },
      "institutional_collection",
      1,
    ), "store_failed", "institutional_collection");
    return deleted.success && deletionCompleted(deleted.data)
      ? success(undefined)
      : deleted.success ? failure("store_unverified") : deleted;
  };

  const proveLifecycleRecoveryAbsence = async (
    input: { lifecycleKey: string; inventory: unknown },
    signal?: AbortSignal,
  ): Promise<CorpusResult<undefined>> => {
    const lifecycleKey = recoveryLifecycleKey(input.lifecycleKey);
    const inventory = projectQdrantLifecycleRecoveryInventory(input.inventory);
    const pointIds = lifecycleRecoveryPointIds(inventory);
    if (!lifecycleKey || !inventory || inventory.lifecycleKey !== lifecycleKey || !pointIds) {
      return failure("record_invalid");
    }
    const collection = await recoveryCollection(signal);
    if (!collection.success) return collection;

    for (const pointId of pointIds) {
      if (aborted(signal)) return failure("aborted");
      const direct = await getRawPoints(INSTITUTIONAL_COLLECTION, [pointId], signal);
      if (!direct.success) return direct;
      if (direct.data.length !== 0) return failure("record_conflict");
    }

    const rootPoints = await recoveryScroll({
      filter: { must: [{ key: "lifecycle_key", match: { value: lifecycleKey } }] },
      maximumPoints: MAX_QDRANT_LIFECYCLE_RECOVERY_RECORDS,
      signal,
    });
    if (!rootPoints.success) return rootPoints;
    if (rootPoints.data.length !== 0) return failure("record_conflict");

    for (const record of inventory.records) {
      if (record.storageSchemaVersion !== 2) continue;
      const children = await recoveryScroll({
        filter: { must: [{ key: "parent_record_key", match: { value: record.recordKey } }] },
        maximumPoints: MAX_DETAIL_CHUNK_COUNT,
        signal,
      });
      if (!children.success) return children;
      if (children.data.length !== 0) return failure("record_conflict");
    }
    return success(undefined);
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

  const recallLifecycleInstitutional = async (
    input: { lifecycleKey: string; limit: number; phase?: string },
    signal?: AbortSignal,
  ): Promise<CorpusResult<FullInstitutionalRecord[]>> => {
    const selection = lifecycleRecallSelection(input);
    if (!selection) return failure("record_invalid");
    if (aborted(signal)) return failure("aborted");

    try {
      const state = await institutionalState(signal);
      if (aborted(signal)) return failure("aborted");
      if (!state.success || state.data.collection === "absent") {
        return state.success ? failure("query_failed") : state;
      }
      const must = [
        { key: "lifecycle_key", match: { value: selection.lifecycleKey } },
        ...(selection.phase ? [{ key: "phase", match: { value: selection.phase } }] : []),
      ];
      const response = bodyOrFailure(await qdrant(
        `collections/${encodeURIComponent(INSTITUTIONAL_COLLECTION)}/points/scroll`,
        signal,
        "POST",
        {
          filter: { must, ...detailChunkFilter() },
          limit: selection.limit,
          with_payload: { exclude: ["detail", "detail_chunk"] },
          with_vector: false,
        },
      ), "query_failed");
      if (aborted(signal)) return failure("aborted");
      if (!response.success) return response;

      const scroll = terminalLifecycleScroll(response.data);
      if (!scroll.success) return scroll;
      const summariesResult = summaries(scroll.data.points, false);
      if (!summariesResult.success) return summariesResult;
      if (summariesResult.data.length > selection.limit) return failure("response_invalid");

      const records: FullInstitutionalRecord[] = [];
      const ids = new Set<string>();
      const recordKeys = new Set<string>();
      for (const summary of summariesResult.data) {
        if (
          ids.has(summary.id)
          || recordKeys.has(summary.recordKey)
          || summary.lifecycleKey !== selection.lifecycleKey
          || (selection.phase !== undefined && summary.phase !== selection.phase)
        ) return failure("response_invalid");
        ids.add(summary.id);
        recordKeys.add(summary.recordKey);

        if (aborted(signal)) return failure("aborted");
        const full = await getInstitutional(summary.recordKey, signal);
        if (aborted(signal)) return failure("aborted");
        if (!full.success) return full;
        if (
          full.data.id !== summary.id
          || full.data.recordKey !== summary.recordKey
          || full.data.project !== summary.project
          || full.data.site !== summary.site
          || full.data.repo !== summary.repo
          || full.data.lifecycleKey !== summary.lifecycleKey
          || full.data.phase !== summary.phase
          || full.data.summary !== summary.summary
        ) return failure("response_invalid");
        records.push({ ...full.data, sourceRefs: [...full.data.sourceRefs] });
      }
      return success(records);
    } catch {
      return aborted(signal) ? failure("aborted") : failure("query_failed");
    }
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
    recallLifecycleInstitutional,
    getInstitutional,
    inventoryLifecycleRecovery: recoveryInventory,
    deleteLifecycleRecoveryInventory,
    proveLifecycleRecoveryAbsence,
    findKnowledge,
  };
}
