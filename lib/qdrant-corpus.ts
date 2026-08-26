import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
export const INSTITUTIONAL_COLLECTION = "ima-institutional-memory";
export const EMBEDDING_MODEL = "nomic-embed-text:latest";
export const EMBEDDING_MODEL_DIGEST = "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f";
export const VECTOR_SIZE = 768;
export const VECTOR_DISTANCE = "Cosine";
export const VECTOR_NAME = "nomic-embed-text-0a109f42";
export const RECORD_ID_NAMESPACE = "0476e0b1-db93-536a-a78e-959ea945997f";
export const CORPUS_SCHEMA_VERSION = 1;
export const MAX_RECORD_KEY_LENGTH = 512;
export const MAX_SUMMARY_BYTES = 2_000;
export const MAX_PAYLOAD_BYTES = 44_000;
export const MAX_SOURCE_REFERENCES = 64;

export const MAX_PROJECT_LENGTH = 256;
export const MAX_SITE_LENGTH = 256;
export const MAX_REPOSITORY_LENGTH = 1_024;
export const MAX_LIFECYCLE_KEY_LENGTH = 512;
export const MAX_PHASE_LENGTH = 128;
export const MAX_SOURCE_REFERENCE_LENGTH = 1_024;
export const MAX_CREATED_AT_LENGTH = 128;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();
export type CorpusErrorCode =
  | "record_invalid"
  | "record_too_large"
  | "record_conflict"
  | "embedding_dimension_mismatch"
  | "embedding_failed"
  | "store_failed"
  | "store_unverified"
  | "response_invalid"
  | "record_not_found"
  | "aborted"
  | "qdrant_unavailable"
  | "qdrant_version_unsupported"
  | "ollama_unavailable"
  | "embedding_model_missing"
  | "embedding_model_mismatch"
  | "collection_incompatible"
  | "collection_bootstrap_failed"
  | "query_failed";
export type CorpusFailure = {
  success: false;
  error: { code: CorpusErrorCode; message: string };
};

export type CorpusSuccess<Data> = {
  success: true;
  data: Data;
};

export type CorpusResult<Data> = CorpusSuccess<Data> | CorpusFailure;
const corpusErrorGuidance: Record<CorpusErrorCode, string> = {
  record_invalid: "Check required bounded record fields before retrying.",
  record_too_large: "Reduce the bounded record or result payload before retrying.",
  record_conflict: "Use a new record key; immutable records are never overwritten.",
  embedding_dimension_mismatch: "Verify the approved embedding model and 768-value vector contract.",
  embedding_failed: "Check the local Ollama service and approved embedding model.",
  store_failed: "Check local Qdrant service and operator configuration; no overwrite was performed.",
  store_unverified: "Inspect local Qdrant state before retrying; no successful store was reported.",
  response_invalid: "Inspect local service compatibility; raw provider responses are withheld.",
  record_not_found: "Verify the record key and institutional corpus state.",
  aborted: "Retry only after the caller cancellation is cleared.",
  qdrant_unavailable: "Check the local Qdrant service and operator configuration.",
  qdrant_version_unsupported: "Use Qdrant 1.16.0 or later.",
  ollama_unavailable: "Check the local Ollama service and operator configuration.",
  embedding_model_missing: "Install or verify the approved nomic-embed-text:latest model.",
  embedding_model_mismatch: "Verify the approved embedding model digest before writing records.",
  collection_incompatible: "Inspect or migrate the collection; do not repair or overwrite it automatically.",
  collection_bootstrap_failed: "Inspect local Qdrant configuration; no destructive repair was performed.",
  query_failed: "Check corpus availability and compatibility before retrying.",
};

export const CORPUS_ERROR_GUIDANCE = Object.freeze(corpusErrorGuidance);
export const corpusFailure = (code: CorpusErrorCode): CorpusFailure => ({
  success: false,
  error: { code, message: `Qdrant corpus failed: ${code}. ${CORPUS_ERROR_GUIDANCE[code]}` },
});
export type InstitutionalRecordInput = {
  recordKey: string;
  project: string;
  site: string;
  repo: string;
  lifecycleKey: string;
  phase: string;
  summary: string;
  detail: string;
  sourceRefs?: string[];
};
export type InstitutionalPayload = {
  schema_version: number;
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

export type InstitutionalFilterClause = { key: "project" | "site" | "repo"; value: string };

export type StoreOperations = {
  getPoint: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<CorpusResult<ExistingInstitutionalRecord | null>>;
  ensureCollection: (
    signal?: AbortSignal,
  ) => Promise<CorpusResult<unknown>>;
  embedSummary: (
    summary: string,
    signal?: AbortSignal,
  ) => Promise<CorpusResult<number[]>>;
  insertPoint: (
    input: { record: InstitutionalRecord; vector: number[] },
    signal?: AbortSignal,
  ) => Promise<CorpusResult<undefined>>;
};

const success = <Data>(data: Data): CorpusSuccess<Data> => ({ success: true, data });
const failure = corpusFailure;
const aborted = (signal?: AbortSignal) => signal?.aborted === true;
const textBytes = (value: string) => encoder.encode(value).byteLength;
const hasControlCharacter = (value: string) => CONTROL_CHARACTER.test(value);

const normalizeText = (
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximumLength) return null;
  return normalized;
};

const normalizeMetadataText = (
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string | null => {
  const normalized = normalizeText(value, maximumLength, allowEmpty);
  return normalized !== null && !hasControlCharacter(normalized) ? normalized : null;
};

const normalizeRecordKey = (value: unknown): string | null => {
  const recordKey = normalizeMetadataText(value, MAX_RECORD_KEY_LENGTH);
  return recordKey || null;
};

export const compareCodeUnits = (left: string, right: string) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizeSourceReferences = (value: unknown): string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFERENCES) return null;

  const references = value.map((reference) => {
    const normalized = normalizeText(reference, MAX_SOURCE_REFERENCE_LENGTH);
    return normalized && !hasControlCharacter(normalized) ? normalized : null;
  });
  if (references.some((reference) => reference === null)) return null;
  return [...new Set(references)].sort(compareCodeUnits);
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("record_invalid");
  const filters = value as Record<string, unknown>;
  const keys = Object.keys(filters);
  if (keys.some((key) => !FILTER_FIELDS.some((field) => field.input === key))) {
    return failure("record_invalid");
  }

  const clauses: InstitutionalFilterClause[] = [];
  for (const field of FILTER_FIELDS) {
    if (!Object.hasOwn(filters, field.input)) continue;
    const normalized = normalizeMetadataText(
      filters[field.input],
      field.maximum,
      field.allowEmpty,
    );
    if (normalized === null) return failure("record_invalid");
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

const hashContent = (payload: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

export const utf8ByteLength = (value: string) => textBytes(value);

export function deriveRecordId(recordKey: unknown): CorpusResult<string> {
  const normalized = normalizeRecordKey(recordKey);
  return normalized ? success(uuidv5(normalized, RECORD_ID_NAMESPACE)) : failure("record_invalid");
}

export function validateEmbedding(value: unknown): CorpusResult<number[]> {
  if (!Array.isArray(value) || value.length !== VECTOR_SIZE || !value.every(Number.isFinite)) {
    return failure("embedding_dimension_mismatch");
  }
  return success([...value]);
}

export function normalizeInstitutionalRecord(
  input: unknown,
  createdAt: unknown,
): CorpusResult<InstitutionalRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return failure("record_invalid");
  const record = input as Partial<InstitutionalRecordInput>;
  const recordKey = normalizeRecordKey(record.recordKey);
  const project = normalizeMetadataText(record.project, MAX_PROJECT_LENGTH);
  const site = normalizeMetadataText(record.site, MAX_SITE_LENGTH, true);
  const repo = normalizeMetadataText(record.repo, MAX_REPOSITORY_LENGTH, true);
  const lifecycleKey = normalizeMetadataText(record.lifecycleKey, MAX_LIFECYCLE_KEY_LENGTH);
  const phase = normalizeMetadataText(record.phase, MAX_PHASE_LENGTH);
  const summary = normalizeMetadataText(record.summary, MAX_SUMMARY_BYTES);
  const detail = normalizeText(record.detail, MAX_PAYLOAD_BYTES);
  const sourceRefs = normalizeSourceReferences(record.sourceRefs);
  const normalizedCreatedAt = normalizeMetadataText(createdAt, MAX_CREATED_AT_LENGTH);

  if (
    !recordKey
    || !project
    || site === null
    || repo === null
    || !lifecycleKey
    || !phase
    || !summary
    || !detail
    || !sourceRefs
    || !normalizedCreatedAt
  ) return failure("record_invalid");
  if (textBytes(summary) > MAX_SUMMARY_BYTES) return failure("record_too_large");

  const immutable = immutablePayload({
    recordKey,
    project,
    site,
    repo,
    lifecycleKey,
    phase,
    summary,
    detail,
    sourceRefs,
  });
  const payload: InstitutionalPayload = {
    ...immutable,
    content_hash: hashContent(immutable),
    created_at: normalizedCreatedAt,
  };
  if (textBytes(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) return failure("record_too_large");

  return success({
    id: uuidv5(recordKey, RECORD_ID_NAMESPACE),
    recordKey,
    payload: { ...payload, source_refs: [...payload.source_refs] },
  });
}

export function normalizeInstitutionalSummary(
  value: unknown,
  options: { requireScore: boolean },
): CorpusResult<InstitutionalSummary> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("response_invalid");
  const point = value as { id?: unknown; payload?: unknown; score?: unknown };
  if (!point.payload || typeof point.payload !== "object" || Array.isArray(point.payload)) {
    return failure("response_invalid");
  }
  const payload = point.payload as Record<string, unknown>;
  const recordKey = normalizeRecordKey(payload.record_key);
  const project = normalizeMetadataText(payload.project, MAX_PROJECT_LENGTH);
  const site = normalizeMetadataText(payload.site, MAX_SITE_LENGTH, true);
  const repo = normalizeMetadataText(payload.repo, MAX_REPOSITORY_LENGTH, true);
  const lifecycleKey = normalizeMetadataText(payload.lifecycle_key, MAX_LIFECYCLE_KEY_LENGTH);
  const phase = normalizeMetadataText(payload.phase, MAX_PHASE_LENGTH);
  const summary = normalizeMetadataText(payload.summary, MAX_SUMMARY_BYTES);
  const sourceRefs = payload.source_refs === undefined ? null : normalizeSourceReferences(payload.source_refs);
  const sourceRefsAreCanonical = Array.isArray(payload.source_refs)
    && sourceRefs !== null
    && payload.source_refs.length === sourceRefs.length
    && payload.source_refs.every((reference, index) => reference === sourceRefs[index]);
  const createdAt = normalizeMetadataText(payload.created_at, MAX_CREATED_AT_LENGTH);
  const contentHash = typeof payload.content_hash === "string" && /^[a-f0-9]{64}$/i.test(payload.content_hash);
  const scoreIsFinite = typeof point.score === "number" && Number.isFinite(point.score);

  if (
    payload.schema_version !== CORPUS_SCHEMA_VERSION
    || typeof point.id !== "string"
    || !recordKey
    || !project
    || site === null
    || repo === null
    || !lifecycleKey
    || !phase
    || !summary || textBytes(summary) > MAX_SUMMARY_BYTES
    || !sourceRefs
    || !sourceRefsAreCanonical
    || !createdAt
    || !contentHash
    || (options.requireScore && !scoreIsFinite)
    || (!options.requireScore && point.score !== undefined && !scoreIsFinite)
  ) return failure("response_invalid");

  const expectedId = deriveRecordId(recordKey);
  if (!expectedId.success || expectedId.data !== point.id) return failure("response_invalid");
  return success({
    id: point.id,
    recordKey,
    project,
    site,
    repo,
    lifecycleKey,
    phase,
    summary,
    ...(scoreIsFinite ? { score: point.score } : {}),
  });
}

export function existingInstitutionalRecord(value: unknown): CorpusResult<ExistingInstitutionalRecord | null> {
  if (value === null) return success(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("response_invalid");
  const point = value as { id?: unknown; payload?: unknown };
  if (
    typeof point.id !== "string"
    || !point.payload
    || typeof point.payload !== "object"
    || Array.isArray(point.payload)
  ) return failure("response_invalid");
  const payload = point.payload as { record_key?: unknown; content_hash?: unknown };
  const recordKey = normalizeRecordKey(payload.record_key);
  const contentHash = typeof payload.content_hash === "string" && /^[a-f0-9]{64}$/i.test(payload.content_hash)
    ? payload.content_hash.toLowerCase()
    : null;
  return recordKey && contentHash
    ? success({ id: point.id, recordKey, contentHash })
    : failure("response_invalid");
}

const existingOutcome = (
  existing: ExistingInstitutionalRecord,
  record: InstitutionalRecord,
): CorpusResult<{ status: "unchanged"; id: string; recordKey: string }> => {
  if (existing.id !== record.id || existing.recordKey !== record.recordKey) return failure("record_conflict");
  return existing.contentHash === record.payload.content_hash
    ? success({ status: "unchanged", id: record.id, recordKey: record.recordKey })
    : failure("record_conflict");
};

const readExisting = async (
  record: InstitutionalRecord,
  operations: StoreOperations,
  signal?: AbortSignal,
): Promise<CorpusResult<ExistingInstitutionalRecord | null>> => {
  if (aborted(signal)) return failure("aborted");
  try {
    const result = await operations.getPoint(record.id, signal);
    return aborted(signal) ? failure("aborted") : result;
  } catch {
    return aborted(signal) ? failure("aborted") : failure("store_failed");
  }
};

const ensureCollection = async (
  operations: StoreOperations,
  signal?: AbortSignal,
): Promise<CorpusResult<unknown>> => {
  if (aborted(signal)) return failure("aborted");
  try {
    const result = await operations.ensureCollection(signal);
    return aborted(signal) ? failure("aborted") : result;
  } catch {
    return aborted(signal) ? failure("aborted") : failure("store_failed");
  }
};

export async function storeInstitutionalRecord(input: {
  record: unknown;
  createdAt: unknown;
  operations: StoreOperations;
  signal?: AbortSignal;
}): Promise<CorpusResult<{ status: "stored" | "unchanged"; id: string; recordKey: string }>> {
  const { record: rawRecord, createdAt, operations, signal } = input;
  if (aborted(signal)) return failure("aborted");

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
    return aborted(signal) ? failure("aborted") : failure("embedding_failed");
  }
  if (aborted(signal)) return failure("aborted");
  if (!embedded.success) return embedded;

  const vector = validateEmbedding(embedded.data);
  if (!vector.success) return vector;

  let inserted: CorpusResult<undefined>;
  try {
    inserted = await operations.insertPoint({ record, vector: vector.data }, signal);
  } catch {
    return aborted(signal) ? failure("aborted") : failure("store_failed");
  }
  if (aborted(signal)) return failure("aborted");

  if (!inserted.success && inserted.error.code !== "record_conflict") return inserted;
  const verified = await readExisting(record, operations, signal);
  if (!verified.success) return verified;
  if (!verified.data) return inserted.success ? failure("store_unverified") : failure("record_conflict");

  const outcome = existingOutcome(verified.data, record);
  if (!outcome.success) return outcome;
  return inserted.success
    ? success({ status: "stored", id: record.id, recordKey: record.recordKey })
    : outcome;
}
