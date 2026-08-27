import {
  CORPUS_SCHEMA_VERSION,
  MAX_CREATED_AT_LENGTH,
  MAX_LIFECYCLE_KEY_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_PHASE_LENGTH,
  MAX_PROJECT_LENGTH,
  MAX_REPOSITORY_LENGTH,
  MAX_SITE_LENGTH,
  MAX_SOURCE_REFERENCES,
  MAX_SOURCE_REFERENCE_LENGTH,
  MAX_SUMMARY_BYTES,
  VECTOR_SIZE,
  aborted,
  canonicalSourceRefs,
  corpusFailure,
  deriveRecordId,
  hasRequiredInstitutionalMetadata,
  hashContent,
  normalizedInstitutionalMetadata,
  normalizeMetadataText,
  normalizeRecordKey,
  success,
  textBytes,
  utf8ByteLength,
  validateEmbedding,
  type CorpusResult,
  type InstitutionalRecordInput,
} from "./qdrant-corpus-contract.ts";
import {
  CORPUS_SCHEMA_VERSION_V2,
  DETAIL_CHUNK_RECORD_KIND,
  MANIFEST_RECORD_KIND,
} from "./qdrant-corpus-chunks.ts";
import {
  normalizeInstitutionalManifest,
  normalizeInstitutionalManifestPoint,
  reassembleInstitutionalManifest,
  storeInstitutionalManifest,
  type InstitutionalManifest,
  type InstitutionalManifestPayload,
  type ManifestStoreOperations,
  type ReassembledInstitutionalManifest,
} from "./qdrant-corpus-manifest.ts";

export {
  CORPUS_SCHEMA_VERSION,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_DIGEST,
  INSTITUTIONAL_COLLECTION,
  MAX_CREATED_AT_LENGTH,
  MAX_LIFECYCLE_KEY_LENGTH,
  MAX_MANIFEST_PAYLOAD_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PHASE_LENGTH,
  MAX_PROJECT_LENGTH,
  MAX_RECORD_KEY_LENGTH,
  MAX_REPOSITORY_LENGTH,
  MAX_SITE_LENGTH,
  MAX_SOURCE_REFERENCES,
  MAX_SOURCE_REFERENCE_LENGTH,
  MAX_SUMMARY_BYTES,
  VECTOR_DISTANCE,
  VECTOR_NAME,
  VECTOR_SIZE,
  CORPUS_ERROR_GUIDANCE,
  corpusFailure,
  compareCodeUnits,
  deriveRecordId,
  utf8ByteLength,
  validateEmbedding,
  type CorpusErrorCode,
  type CorpusFailure,
  type CorpusResult,
  type CorpusSuccess,
  type InstitutionalRecordInput,
  type LogicalCorpusPoint,
} from "./qdrant-corpus-contract.ts";
export {
  CORPUS_SCHEMA_VERSION_V2,
  DETAIL_CHUNK_RECORD_KIND,
  MANIFEST_RECORD_KIND,
  MAX_DETAIL_CHUNK_BYTES,
  MAX_DETAIL_CHUNK_COUNT,
  MAX_STORED_ARTIFACT_BYTES,
  RECORD_ID_NAMESPACE,
  detailChunkIds,
} from "./qdrant-corpus-chunks.ts";
export {
  normalizeInstitutionalManifest,
  normalizeInstitutionalManifestPoint,
  reassembleInstitutionalManifest,
  storeInstitutionalManifest,
  type InstitutionalManifest,
  type InstitutionalManifestPayload,
  type ManifestStoreOperations,
  type ReassembledInstitutionalManifest,
} from "./qdrant-corpus-manifest.ts";

export type InstitutionalPayload = {
  schema_version: 1;
  record_key: string;
  project: string;
  site: string;
  repo: string;
  lifecycle_key: string;
  phase: string;
  summary: string;
  detail: string;
  source_refs: string[];
  content_hash: string;
  created_at: string;
};

export type InstitutionalRecord = {
  id: string;
  recordKey: string;
  payload: InstitutionalPayload;
};

export type ExistingInstitutionalRecord = {
  id: string;
  recordKey: string;
  contentHash: string;
};

export type InstitutionalSummary = {
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

export type InstitutionalFilters = {
  project?: string;
  site?: string;
  repo?: string;
};

export type InstitutionalFilterClause = {
  key: "project" | "site" | "repo";
  value: string;
};

export type StoreOperations = {
  getPoint: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<CorpusResult<ExistingInstitutionalRecord | null>>;
  ensureCollection: (signal?: AbortSignal) => Promise<CorpusResult<unknown>>;
  embedSummary: (summary: string, signal?: AbortSignal) => Promise<CorpusResult<number[]>>;
  insertPoint: (
    input: { record: InstitutionalRecord; vector: number[] },
    signal?: AbortSignal,
  ) => Promise<CorpusResult<undefined>>;
};

const FILTER_FIELDS = [
  { input: "project", maximum: MAX_PROJECT_LENGTH, allowEmpty: false },
  { input: "site", maximum: MAX_SITE_LENGTH, allowEmpty: true },
  { input: "repo", maximum: MAX_REPOSITORY_LENGTH, allowEmpty: true },
] as const;

export function normalizeInstitutionalFilters(
  value: unknown,
): CorpusResult<InstitutionalFilterClause[]> {
  if (value === undefined) return success([]);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return corpusFailure("record_invalid");
  }
  const filters = value as Record<string, unknown>;
  const keys = Object.keys(filters);
  if (keys.some((key) => !FILTER_FIELDS.some((field) => field.input === key))) {
    return corpusFailure("record_invalid");
  }

  const clauses: InstitutionalFilterClause[] = [];
  for (const field of FILTER_FIELDS) {
    if (!Object.hasOwn(filters, field.input)) continue;
    const normalized = normalizeMetadataText(
      filters[field.input],
      field.maximum,
      field.allowEmpty,
    );
    if (normalized === null) return corpusFailure("record_invalid");
    clauses.push({ key: field.input, value: normalized });
  }
  return success(clauses);
}

const immutablePayload = (input: {
  recordKey: string;
  project: string;
  site: string;
  repo: string;
  lifecycleKey: string;
  phase: string;
  summary: string;
  detail: string;
  sourceRefs: string[];
}) => ({
  schema_version: CORPUS_SCHEMA_VERSION,
  record_key: input.recordKey,
  project: input.project,
  site: input.site,
  repo: input.repo,
  lifecycle_key: input.lifecycleKey,
  phase: input.phase,
  summary: input.summary,
  detail: input.detail,
  source_refs: input.sourceRefs,
});

export function normalizeInstitutionalRecord(
  input: unknown,
  createdAt: unknown,
): CorpusResult<InstitutionalRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return corpusFailure("record_invalid");
  }
  const record = input as Partial<InstitutionalRecordInput>;
  if (typeof record.detail !== "string" || !record.detail.trim()) {
    return corpusFailure("record_invalid");
  }
  if (record.detail.length > MAX_PAYLOAD_BYTES) return corpusFailure("record_too_large");

  const metadata = normalizedInstitutionalMetadata(record, createdAt);
  const detail = record.detail.trim();
  if (!hasRequiredInstitutionalMetadata(metadata) || !detail) {
    return corpusFailure("record_invalid");
  }
  if (textBytes(metadata.summary!) > MAX_SUMMARY_BYTES) {
    return corpusFailure("record_too_large");
  }

  const immutable = immutablePayload({
    recordKey: metadata.recordKey!,
    project: metadata.project!,
    site: metadata.site!,
    repo: metadata.repo!,
    lifecycleKey: metadata.lifecycleKey!,
    phase: metadata.phase!,
    summary: metadata.summary!,
    detail,
    sourceRefs: metadata.sourceRefs!,
  });
  const payload: InstitutionalPayload = {
    ...immutable,
    content_hash: hashContent(immutable),
    created_at: metadata.normalizedCreatedAt!,
  };
  if (textBytes(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    return corpusFailure("record_too_large");
  }

  const id = deriveRecordId(metadata.recordKey!);
  if (!id.success) return id;
  return success({
    id: id.data,
    recordKey: metadata.recordKey!,
    payload: { ...payload, source_refs: [...payload.source_refs] },
  });
}

export function normalizeInstitutionalSummary(
  value: unknown,
  options: { requireScore: boolean },
): CorpusResult<InstitutionalSummary> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return corpusFailure("response_invalid");
  }
  const point = value as { id?: unknown; payload?: unknown; score?: unknown };
  if (!point.payload || typeof point.payload !== "object" || Array.isArray(point.payload)) {
    return corpusFailure("response_invalid");
  }

  const scoreIsFinite = typeof point.score === "number" && Number.isFinite(point.score);
  if (
    (options.requireScore && !scoreIsFinite)
    || (!options.requireScore && point.score !== undefined && !scoreIsFinite)
  ) return corpusFailure("response_invalid");

  const payload = point.payload as Record<string, unknown>;
  if (payload.schema_version === CORPUS_SCHEMA_VERSION_V2) {
    const manifest = normalizeInstitutionalManifestPoint(value);
    if (!manifest.success) return manifest;
    return success({
      id: manifest.data.id,
      recordKey: manifest.data.recordKey,
      project: manifest.data.payload.project,
      site: manifest.data.payload.site,
      repo: manifest.data.payload.repo,
      lifecycleKey: manifest.data.payload.lifecycle_key,
      phase: manifest.data.payload.phase,
      summary: manifest.data.payload.summary,
      ...(scoreIsFinite ? { score: point.score as number } : {}),
    });
  }

  const recordKey = normalizeRecordKey(payload.record_key);
  const project = normalizeMetadataText(payload.project, MAX_PROJECT_LENGTH);
  const site = normalizeMetadataText(payload.site, MAX_SITE_LENGTH, true);
  const repo = normalizeMetadataText(payload.repo, MAX_REPOSITORY_LENGTH, true);
  const lifecycleKey = normalizeMetadataText(payload.lifecycle_key, MAX_LIFECYCLE_KEY_LENGTH);
  const phase = normalizeMetadataText(payload.phase, MAX_PHASE_LENGTH);
  const summary = normalizeMetadataText(payload.summary, MAX_SUMMARY_BYTES);
  const sourceRefs = canonicalSourceRefs(payload.source_refs);
  const createdAt = normalizeMetadataText(payload.created_at, MAX_CREATED_AT_LENGTH);
  const contentHash = typeof payload.content_hash === "string" && /^[a-f0-9]{64}$/i.test(payload.content_hash);

  if (
    payload.schema_version !== CORPUS_SCHEMA_VERSION
    || typeof point.id !== "string"
    || !recordKey
    || !project
    || site === null
    || repo === null
    || !lifecycleKey
    || !phase
    || !summary
    || textBytes(summary) > MAX_SUMMARY_BYTES
    || !sourceRefs
    || !createdAt
    || !contentHash
  ) return corpusFailure("response_invalid");

  const expectedId = deriveRecordId(recordKey);
  if (!expectedId.success || expectedId.data !== point.id) {
    return corpusFailure("response_invalid");
  }
  return success({
    id: point.id,
    recordKey,
    project,
    site,
    repo,
    lifecycleKey,
    phase,
    summary,
    ...(scoreIsFinite ? { score: point.score as number } : {}),
  });
}

export function existingInstitutionalRecord(
  value: unknown,
): CorpusResult<ExistingInstitutionalRecord | null> {
  if (value === null) return success(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return corpusFailure("response_invalid");
  }
  const point = value as { id?: unknown; payload?: unknown };
  if (
    typeof point.id !== "string"
    || !point.payload
    || typeof point.payload !== "object"
    || Array.isArray(point.payload)
  ) return corpusFailure("response_invalid");
  const payload = point.payload as { record_key?: unknown; content_hash?: unknown };
  const recordKey = normalizeRecordKey(payload.record_key);
  const contentHash = typeof payload.content_hash === "string" && /^[a-f0-9]{64}$/i.test(payload.content_hash)
    ? payload.content_hash.toLowerCase()
    : null;
  return recordKey && contentHash
    ? success({ id: point.id, recordKey, contentHash })
    : corpusFailure("response_invalid");
}

const existingOutcome = (
  existing: ExistingInstitutionalRecord,
  record: InstitutionalRecord,
): CorpusResult<{ status: "unchanged"; id: string; recordKey: string }> => {
  if (existing.id !== record.id || existing.recordKey !== record.recordKey) {
    return corpusFailure("record_conflict");
  }
  return existing.contentHash === record.payload.content_hash
    ? success({ status: "unchanged", id: record.id, recordKey: record.recordKey })
    : corpusFailure("record_conflict");
};

const readExisting = async (
  record: InstitutionalRecord,
  operations: StoreOperations,
  signal?: AbortSignal,
): Promise<CorpusResult<ExistingInstitutionalRecord | null>> => {
  if (aborted(signal)) return corpusFailure("aborted");
  try {
    const result = await operations.getPoint(record.id, signal);
    return aborted(signal) ? corpusFailure("aborted") : result;
  } catch {
    return aborted(signal) ? corpusFailure("aborted") : corpusFailure("store_failed");
  }
};

const ensureCollection = async (
  operations: Pick<StoreOperations, "ensureCollection">,
  signal?: AbortSignal,
): Promise<CorpusResult<unknown>> => {
  if (aborted(signal)) return corpusFailure("aborted");
  try {
    const result = await operations.ensureCollection(signal);
    return aborted(signal) ? corpusFailure("aborted") : result;
  } catch {
    return aborted(signal) ? corpusFailure("aborted") : corpusFailure("store_failed");
  }
};

export async function storeInstitutionalRecord(input: {
  record: unknown;
  createdAt: unknown;
  operations: StoreOperations;
  signal?: AbortSignal;
}): Promise<CorpusResult<{ status: "stored" | "unchanged"; id: string; recordKey: string }>> {
  const { record: rawRecord, createdAt, operations, signal } = input;
  if (aborted(signal)) return corpusFailure("aborted");

  const normalized = normalizeInstitutionalRecord(rawRecord, createdAt);
  if (!normalized.success) return normalized;
  const record = normalized.data;

  const existing = await readExisting(record, operations, signal);
  if (!existing.success) return existing;
  if (existing.data) return existingOutcome(existing.data, record);

  const ready = await ensureCollection(operations, signal);
  if (!ready.success) return ready;

  let embedded: CorpusResult<number[]>;
  try {
    embedded = await operations.embedSummary(record.payload.summary, signal);
  } catch {
    return aborted(signal) ? corpusFailure("aborted") : corpusFailure("embedding_failed");
  }
  if (aborted(signal)) return corpusFailure("aborted");
  if (!embedded.success) return embedded;

  const vector = validateEmbedding(embedded.data);
  if (!vector.success) return vector;

  let inserted: CorpusResult<undefined>;
  try {
    inserted = await operations.insertPoint({ record, vector: vector.data }, signal);
  } catch {
    return aborted(signal) ? corpusFailure("aborted") : corpusFailure("store_failed");
  }
  if (aborted(signal)) return corpusFailure("aborted");

  if (!inserted.success && inserted.error.code !== "record_conflict") return inserted;
  const verified = await readExisting(record, operations, signal);
  if (!verified.success) return verified;
  if (!verified.data) return inserted.success ? corpusFailure("store_unverified") : corpusFailure("record_conflict");

  const outcome = existingOutcome(verified.data, record);
  if (!outcome.success) return outcome;
  return inserted.success
    ? success({ status: "stored", id: record.id, recordKey: record.recordKey })
    : outcome;
}

export async function storeLogicalInstitutionalRecord(input: {
  record: unknown;
  createdAt: unknown;
  operations: StoreOperations & ManifestStoreOperations;
  signal?: AbortSignal;
}): Promise<CorpusResult<{ status: "stored" | "unchanged"; id: string; recordKey: string }>> {
  const v1 = normalizeInstitutionalRecord(input.record, input.createdAt);
  if (v1.success) return storeInstitutionalRecord(input);
  if (v1.error.code !== "record_too_large") return v1;
  return storeInstitutionalManifest(input);
}
