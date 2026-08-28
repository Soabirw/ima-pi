import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import {
  RECORD_ID_NAMESPACE,
  utf8ByteLength as chunkUtf8ByteLength,
} from "./qdrant-corpus-chunks.ts";

export const INSTITUTIONAL_COLLECTION = "ima-institutional-memory";
export const EMBEDDING_MODEL = "nomic-embed-text:latest";
export const EMBEDDING_MODEL_DIGEST = "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f";
export const VECTOR_SIZE = 768;
export const VECTOR_DISTANCE = "Cosine";
export const VECTOR_NAME = "nomic-embed-text-0a109f42";
export const CORPUS_SCHEMA_VERSION = 1;
export const MAX_RECORD_KEY_LENGTH = 512;
export const MAX_SUMMARY_BYTES = 2_000;
export const MAX_PAYLOAD_BYTES = 44_000;
export const MAX_SOURCE_REFERENCES = 64;
export const MAX_MANIFEST_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;
export const MAX_PROJECT_LENGTH = 256;
export const MAX_SITE_LENGTH = 256;
export const MAX_REPOSITORY_LENGTH = 1_024;
export const MAX_LIFECYCLE_KEY_LENGTH = 512;
export const MAX_PHASE_LENGTH = 128;
export const MAX_SOURCE_REFERENCE_LENGTH = 1_024;
export const MAX_CREATED_AT_LENGTH = 128;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
export const HASH = /^[a-f0-9]{64}$/i;

export type CorpusErrorCode =
  | "record_invalid"
  | "record_too_large"
  | "record_conflict"
  | "record_incomplete"
  | "embedding_dimension_mismatch"
  | "embedding_failed"
  | "store_failed"
  | "chunk_store_failed"
  | "manifest_store_failed"
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

export type CorpusFailureOperation =
  | "endpoint_configuration"
  | "qdrant_version"
  | "ollama_embedding_model"
  | "institutional_collection";

export type CorpusFailureCause =
  | "invalid_configuration"
  | "timeout"
  | "transport"
  | "transport_connect"
  | "transport_reset"
  | "transport_closed"
  | "transport_other"
  | "http_status"
  | "invalid_response"
  | "incompatible"
  | "client_exception";

export type CorpusFailureContext = {
  operation: CorpusFailureOperation;
  cause: CorpusFailureCause;
  httpStatus?: number;
};

export type CorpusFailure = {
  success: false;
  error: {
    code: CorpusErrorCode;
    message: string;
    context?: CorpusFailureContext;
  };
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
  record_incomplete: "Inspect the immutable manifest and chunk set; incomplete detail was not returned.",
  embedding_dimension_mismatch: "Verify the approved embedding model and 768-value vector contract.",
  embedding_failed: "Check the local Ollama service and approved embedding model.",
  store_failed: "Check local Qdrant service and operator configuration; no overwrite was performed.",
  chunk_store_failed: "Inspect Qdrant chunk storage; the manifest was not reported complete.",
  manifest_store_failed: "Inspect Qdrant manifest storage; no lifecycle completion was reported.",
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

const failureOperations = new Set<CorpusFailureOperation>([
  "endpoint_configuration",
  "qdrant_version",
  "ollama_embedding_model",
  "institutional_collection",
]);
const failureCauses = new Set<CorpusFailureCause>([
  "invalid_configuration",
  "timeout",
  "transport",
  "transport_connect",
  "transport_reset",
  "transport_closed",
  "transport_other",
  "http_status",
  "invalid_response",
  "incompatible",
  "client_exception",
]);

const transportFailureCauses = new Map<string, CorpusFailureCause>([
  ["ECONNREFUSED", "transport_connect"],
  ["ECONNRESET", "transport_reset"],
  ["UND_ERR_SOCKET", "transport_reset"],
  ["other side closed", "transport_reset"],
  ["ECONNABORTED", "transport_closed"],
  ["premature close", "transport_closed"],
]);

const matchingTransportFailureCause = (value: unknown) =>
  typeof value === "string" ? transportFailureCauses.get(value) : undefined;

export const classifyTransportError = (error: unknown): CorpusFailureCause => {
  if (!error || typeof error !== "object") return "transport_other";
  const transportError = error as { name?: unknown; cause?: unknown };
  const cause = transportError.cause;
  const causeCode = cause && typeof cause === "object"
    ? (cause as { code?: unknown }).code
    : undefined;
  return matchingTransportFailureCause(causeCode)
    ?? matchingTransportFailureCause(transportError.name)
    ?? "transport_other";
};

export const isRetriablePreSend = (cause: CorpusFailureCause) =>
  cause === "transport_connect"
  || cause === "transport_reset"
  || cause === "transport_closed";

export const CORPUS_ERROR_GUIDANCE = Object.freeze(corpusErrorGuidance);
export const isCorpusErrorCode = (value: unknown): value is CorpusErrorCode =>
  typeof value === "string" && Object.hasOwn(CORPUS_ERROR_GUIDANCE, value);

export const normalizeCorpusFailureContext = (
  value: unknown,
): CorpusFailureContext | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const context = value as Record<string, unknown>;
  const operation = context.operation;
  const cause = context.cause;
  if (!failureOperations.has(operation as CorpusFailureOperation) || !failureCauses.has(cause as CorpusFailureCause)) {
    return undefined;
  }

  const httpStatus = context.httpStatus;
  if (httpStatus === undefined) {
    return cause === "http_status" ? undefined : {
      operation: operation as CorpusFailureOperation,
      cause: cause as CorpusFailureCause,
    };
  }
  return cause === "http_status"
    && Number.isInteger(httpStatus)
    && httpStatus >= 100
    && httpStatus <= 599
    ? {
      operation: operation as CorpusFailureOperation,
      cause: cause as CorpusFailureCause,
      httpStatus,
    }
    : undefined;
};

const failureContextMessage = (context?: CorpusFailureContext) => context
  ? ` operation=${context.operation}; cause=${context.cause}${
    context.httpStatus === undefined ? "" : `; status=${context.httpStatus}`
  }.`
  : "";

export const corpusFailure = (
  code: CorpusErrorCode,
  context?: CorpusFailureContext,
): CorpusFailure => {
  const normalizedContext = normalizeCorpusFailureContext(context);
  return {
    success: false,
    error: {
      code,
      message: `Qdrant corpus failed: ${code}.${failureContextMessage(normalizedContext)} ${CORPUS_ERROR_GUIDANCE[code]}`,
      ...(normalizedContext ? { context: normalizedContext } : {}),
    },
  };
};
export const success = <Data>(data: Data): CorpusSuccess<Data> => ({ success: true, data });
export const aborted = (signal?: AbortSignal) => signal?.aborted === true;
export const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

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

export type LogicalCorpusPoint = {
  id: string;
  payload: unknown;
  vector?: number[];
};

export type NormalizedInstitutionalMetadata = {
  recordKey: string | null;
  project: string | null;
  site: string | null;
  repo: string | null;
  lifecycleKey: string | null;
  phase: string | null;
  summary: string | null;
  sourceRefs: string[] | null;
  normalizedCreatedAt: string | null;
};

export const utf8ByteLength = (value: string) => chunkUtf8ByteLength(value);
export const textBytes = utf8ByteLength;
export const hashContent = (payload: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

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

export const normalizeMetadataText = (
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string | null => {
  const normalized = normalizeText(value, maximumLength, allowEmpty);
  return normalized !== null && !CONTROL_CHARACTER.test(normalized) ? normalized : null;
};

export const normalizeRecordKey = (value: unknown): string | null =>
  normalizeMetadataText(value, MAX_RECORD_KEY_LENGTH) || null;

export const compareCodeUnits = (left: string, right: string) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const normalizeSourceReferences = (value: unknown): string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFERENCES) return null;

  const references = value.map((reference) => {
    const normalized = normalizeText(reference, MAX_SOURCE_REFERENCE_LENGTH);
    return normalized && !CONTROL_CHARACTER.test(normalized) ? normalized : null;
  });
  if (references.some((reference) => reference === null)) return null;
  return [...new Set(references)].sort(compareCodeUnits);
};

export const canonicalSourceRefs = (value: unknown) => {
  const sourceRefs = value === undefined ? null : normalizeSourceReferences(value);
  const sourceRefsAreCanonical = Array.isArray(value)
    && sourceRefs !== null
    && value.length === sourceRefs.length
    && value.every((reference, index) => reference === sourceRefs[index]);
  return sourceRefs && sourceRefsAreCanonical ? sourceRefs : null;
};

export const normalizedInstitutionalMetadata = (
  input: Partial<InstitutionalRecordInput>,
  createdAt: unknown,
): NormalizedInstitutionalMetadata => ({
  recordKey: normalizeRecordKey(input.recordKey),
  project: normalizeMetadataText(input.project, MAX_PROJECT_LENGTH),
  site: normalizeMetadataText(input.site, MAX_SITE_LENGTH, true),
  repo: normalizeMetadataText(input.repo, MAX_REPOSITORY_LENGTH, true),
  lifecycleKey: normalizeMetadataText(input.lifecycleKey, MAX_LIFECYCLE_KEY_LENGTH),
  phase: normalizeMetadataText(input.phase, MAX_PHASE_LENGTH),
  summary: normalizeMetadataText(input.summary, MAX_SUMMARY_BYTES),
  sourceRefs: normalizeSourceReferences(input.sourceRefs),
  normalizedCreatedAt: normalizeMetadataText(createdAt, MAX_CREATED_AT_LENGTH),
});

export const hasRequiredInstitutionalMetadata = (
  metadata: NormalizedInstitutionalMetadata,
) => Boolean(
  metadata.recordKey
  && metadata.project
  && metadata.site !== null
  && metadata.repo !== null
  && metadata.lifecycleKey
  && metadata.phase
  && metadata.summary
  && metadata.sourceRefs
  && metadata.normalizedCreatedAt,
);

export function deriveRecordId(recordKey: unknown): CorpusResult<string> {
  const normalized = normalizeRecordKey(recordKey);
  return normalized
    ? success(uuidv5(normalized, RECORD_ID_NAMESPACE))
    : corpusFailure("record_invalid");
}

export function validateEmbedding(value: unknown): CorpusResult<number[]> {
  if (!Array.isArray(value) || value.length !== VECTOR_SIZE || !value.every(Number.isFinite)) {
    return corpusFailure("embedding_dimension_mismatch");
  }
  return success([...value]);
}
