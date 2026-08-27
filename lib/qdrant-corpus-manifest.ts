import {
  HASH,
  MAX_MANIFEST_PAYLOAD_BYTES,
  MAX_SUMMARY_BYTES,
  aborted,
  canonicalSourceRefs,
  corpusFailure,
  deriveRecordId,
  hasRequiredInstitutionalMetadata,
  hashContent,
  normalizedInstitutionalMetadata,
  object,
  success,
  textBytes,
  validateEmbedding,
  type CorpusResult,
  type InstitutionalRecordInput,
  type LogicalCorpusPoint,
} from "./qdrant-corpus-contract.ts";
import {
  CORPUS_SCHEMA_VERSION_V2,
  DETAIL_CHUNK_RECORD_KIND,
  MANIFEST_RECORD_KIND,
  MAX_DETAIL_CHUNK_COUNT,
  MAX_STORED_ARTIFACT_BYTES,
  buildDetailChunks,
  detailChunkMatches,
  hashDetail,
  hasUnpairedSurrogate,
  reassembleDetailChunks,
  type DetailChunk,
  type DetailChunkPayload,
} from "./qdrant-corpus-chunks.ts";

export type InstitutionalManifestPayload = {
  schema_version: 2;
  record_kind: "manifest";
  record_key: string;
  project: string;
  site: string;
  repo: string;
  lifecycle_key: string;
  phase: string;
  summary: string;
  detail_hash: string;
  detail_bytes: number;
  chunk_count: number;
  source_refs: string[];
  content_hash: string;
  created_at: string;
};

export type InstitutionalManifest = {
  id: string;
  recordKey: string;
  payload: InstitutionalManifestPayload;
  chunks: DetailChunk[];
};

export type ReassembledInstitutionalManifest = {
  id: string;
  recordKey: string;
  payload: InstitutionalManifestPayload;
  detail: string;
};

export type ManifestStoreOperations = {
  getPoints: (
    ids: string[],
    signal?: AbortSignal,
  ) => Promise<CorpusResult<unknown[]>>;
  ensureCollection: (signal?: AbortSignal) => Promise<CorpusResult<unknown>>;
  embedSummary: (summary: string, signal?: AbortSignal) => Promise<CorpusResult<number[]>>;
  insertPoints: (
    input: { points: LogicalCorpusPoint[] },
    signal?: AbortSignal,
  ) => Promise<CorpusResult<undefined>>;
};

const manifestImmutablePayload = (input: {
  recordKey: string;
  project: string;
  site: string;
  repo: string;
  lifecycleKey: string;
  phase: string;
  summary: string;
  detailHash: string;
  detailBytes: number;
  chunkCount: number;
  sourceRefs: string[];
}) => ({
  schema_version: CORPUS_SCHEMA_VERSION_V2,
  record_kind: MANIFEST_RECORD_KIND,
  record_key: input.recordKey,
  project: input.project,
  site: input.site,
  repo: input.repo,
  lifecycle_key: input.lifecycleKey,
  phase: input.phase,
  summary: input.summary,
  detail_hash: input.detailHash,
  detail_bytes: input.detailBytes,
  chunk_count: input.chunkCount,
  source_refs: input.sourceRefs,
});

export function normalizeInstitutionalManifest(
  input: unknown,
  createdAt: unknown,
): CorpusResult<InstitutionalManifest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return corpusFailure("record_invalid");
  }
  const record = input as Partial<InstitutionalRecordInput>;
  if (
    typeof record.detail !== "string"
    || !record.detail
    || record.detail.includes("\0")
    || hasUnpairedSurrogate(record.detail)
  ) return corpusFailure("record_invalid");
  if (
    record.detail.length > MAX_STORED_ARTIFACT_BYTES
    || textBytes(record.detail) > MAX_STORED_ARTIFACT_BYTES
  ) return corpusFailure("record_too_large");

  const metadata = normalizedInstitutionalMetadata(record, createdAt);
  if (!hasRequiredInstitutionalMetadata(metadata)) return corpusFailure("record_invalid");
  if (textBytes(metadata.summary!) > MAX_SUMMARY_BYTES) return corpusFailure("record_too_large");

  const chunks = buildDetailChunks({
    manifestRecordKey: metadata.recordKey!,
    detail: record.detail,
  });
  if (!chunks) return corpusFailure("record_too_large");

  const immutable = manifestImmutablePayload({
    recordKey: metadata.recordKey!,
    project: metadata.project!,
    site: metadata.site!,
    repo: metadata.repo!,
    lifecycleKey: metadata.lifecycleKey!,
    phase: metadata.phase!,
    summary: metadata.summary!,
    detailHash: hashDetail(record.detail),
    detailBytes: textBytes(record.detail),
    chunkCount: chunks.length,
    sourceRefs: metadata.sourceRefs!,
  });
  const payload: InstitutionalManifestPayload = {
    ...immutable,
    content_hash: hashContent(immutable),
    created_at: metadata.normalizedCreatedAt!,
  };
  if (textBytes(JSON.stringify(payload)) > MAX_MANIFEST_PAYLOAD_BYTES) {
    return corpusFailure("record_too_large");
  }

  const id = deriveRecordId(metadata.recordKey!);
  if (!id.success) return id;
  return success({
    id: id.data,
    recordKey: metadata.recordKey!,
    payload: { ...payload, source_refs: [...payload.source_refs] },
    chunks: chunks.map((chunk) => ({ ...chunk, payload: { ...chunk.payload } })),
  });
}

const normalizedManifestPayload = (
  value: unknown,
): CorpusResult<InstitutionalManifestPayload> => {
  const payload = object(value);
  if (
    !payload
    || payload.schema_version !== CORPUS_SCHEMA_VERSION_V2
    || payload.record_kind !== MANIFEST_RECORD_KIND
  ) return corpusFailure("response_invalid");

  const metadata = normalizedInstitutionalMetadata({
    recordKey: payload.record_key as string,
    project: payload.project as string,
    site: payload.site as string,
    repo: payload.repo as string,
    lifecycleKey: payload.lifecycle_key as string,
    phase: payload.phase as string,
    summary: payload.summary as string,
    sourceRefs: payload.source_refs as string[],
  }, payload.created_at);
  const sourceRefs = canonicalSourceRefs(payload.source_refs);
  const detailHash = typeof payload.detail_hash === "string" && HASH.test(payload.detail_hash)
    ? payload.detail_hash.toLowerCase()
    : "";
  const detailBytes = payload.detail_bytes;
  const chunkCount = payload.chunk_count;
  const contentHash = typeof payload.content_hash === "string" && HASH.test(payload.content_hash)
    ? payload.content_hash.toLowerCase()
    : "";

  if (
    !hasRequiredInstitutionalMetadata(metadata)
    || !sourceRefs
    || textBytes(metadata.summary!) > MAX_SUMMARY_BYTES
    || !detailHash
    || !Number.isInteger(detailBytes)
    || Number(detailBytes) < 1
    || Number(detailBytes) > MAX_STORED_ARTIFACT_BYTES
    || !Number.isInteger(chunkCount)
    || Number(chunkCount) < 1
    || Number(chunkCount) > MAX_DETAIL_CHUNK_COUNT
    || !contentHash
  ) return corpusFailure("response_invalid");

  const immutable = manifestImmutablePayload({
    recordKey: metadata.recordKey!,
    project: metadata.project!,
    site: metadata.site!,
    repo: metadata.repo!,
    lifecycleKey: metadata.lifecycleKey!,
    phase: metadata.phase!,
    summary: metadata.summary!,
    detailHash,
    detailBytes: Number(detailBytes),
    chunkCount: Number(chunkCount),
    sourceRefs,
  });
  if (hashContent(immutable) !== contentHash) return corpusFailure("response_invalid");

  return success({
    ...immutable,
    content_hash: contentHash,
    created_at: metadata.normalizedCreatedAt!,
  });
};

export function normalizeInstitutionalManifestPoint(
  value: unknown,
): CorpusResult<{ id: string; recordKey: string; payload: InstitutionalManifestPayload }> {
  const point = object(value);
  const payload = normalizedManifestPayload(point?.payload);
  if (!point || !payload.success || typeof point.id !== "string") {
    return corpusFailure("response_invalid");
  }

  const expectedId = deriveRecordId(payload.data.record_key);
  if (!expectedId.success || expectedId.data !== point.id) return corpusFailure("response_invalid");
  return success({
    id: point.id,
    recordKey: payload.data.record_key,
    payload: { ...payload.data, source_refs: [...payload.data.source_refs] },
  });
}

export function reassembleInstitutionalManifest(input: {
  manifestPoint: unknown;
  chunkPoints: unknown;
}): CorpusResult<ReassembledInstitutionalManifest> {
  const manifest = normalizeInstitutionalManifestPoint(input.manifestPoint);
  if (!manifest.success) return manifest;
  const detail = reassembleDetailChunks({
    manifestRecordKey: manifest.data.recordKey,
    detailHash: manifest.data.payload.detail_hash,
    detailBytes: manifest.data.payload.detail_bytes,
    chunkCount: manifest.data.payload.chunk_count,
    points: input.chunkPoints,
  });
  if (!detail) return corpusFailure("record_incomplete");
  return success({ ...manifest.data, detail: detail.detail });
}

const readLogicalPoints = async (
  ids: string[],
  operations: ManifestStoreOperations,
  signal?: AbortSignal,
): Promise<CorpusResult<unknown[]>> => {
  if (aborted(signal)) return corpusFailure("aborted");
  try {
    const result = await operations.getPoints(ids, signal);
    return aborted(signal) ? corpusFailure("aborted") : result;
  } catch {
    return aborted(signal) ? corpusFailure("aborted") : corpusFailure("store_failed");
  }
};

const insertLogicalPoints = async (
  points: LogicalCorpusPoint[],
  operations: ManifestStoreOperations,
  signal?: AbortSignal,
): Promise<CorpusResult<undefined>> => {
  if (aborted(signal)) return corpusFailure("aborted");
  try {
    const result = await operations.insertPoints({ points }, signal);
    return aborted(signal) ? corpusFailure("aborted") : result;
  } catch {
    return aborted(signal) ? corpusFailure("aborted") : corpusFailure("store_failed");
  }
};

const ensureCollection = async (
  operations: ManifestStoreOperations,
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

const onlyPoint = (points: unknown[]): unknown | null => points.length === 0
  ? null
  : points.length === 1 ? points[0] : undefined;

const pointMatchesManifest = (point: unknown, expected: InstitutionalManifest) => {
  const normalized = normalizeInstitutionalManifestPoint(point);
  return normalized.success
    && normalized.data.id === expected.id
    && normalized.data.recordKey === expected.recordKey
    && normalized.data.payload.content_hash === expected.payload.content_hash;
};

const verifyManifestStorage = async (
  record: InstitutionalManifest,
  operations: ManifestStoreOperations,
  signal?: AbortSignal,
): Promise<CorpusResult<ReassembledInstitutionalManifest>> => {
  const points = await readLogicalPoints(
    [record.id, ...record.chunks.map((chunk) => chunk.id)],
    operations,
    signal,
  );
  if (!points.success) return points;
  if (points.data.length !== record.chunks.length + 1) return corpusFailure("record_incomplete");

  const manifestPoint = points.data.find((point) => object(point)?.id === record.id);
  if (!manifestPoint || !pointMatchesManifest(manifestPoint, record)) {
    return corpusFailure("record_incomplete");
  }
  const chunkPoints = points.data.filter((point) => object(point)?.id !== record.id);
  const reassembled = reassembleInstitutionalManifest({ manifestPoint, chunkPoints });
  if (!reassembled.success) return reassembled;
  return reassembled.data.detail === record.chunks.map((chunk) => chunk.payload.detail_chunk).join("")
    ? reassembled
    : corpusFailure("record_incomplete");
};

const verifyOrInsertChunk = async (
  chunk: DetailChunk,
  operations: ManifestStoreOperations,
  signal?: AbortSignal,
): Promise<CorpusResult<undefined>> => {
  const before = await readLogicalPoints([chunk.id], operations, signal);
  if (!before.success) return before;
  const existing = onlyPoint(before.data);
  if (existing === undefined) return corpusFailure("record_incomplete");
  if (existing !== null) {
    return detailChunkMatches({ point: existing, expected: chunk })
      ? success(undefined)
      : corpusFailure("record_conflict");
  }

  const inserted = await insertLogicalPoints([
    { id: chunk.id, payload: chunk.payload },
  ], operations, signal);
  if (!inserted.success && inserted.error.code !== "record_conflict") {
    return inserted.error.code === "store_failed"
      ? corpusFailure("chunk_store_failed")
      : inserted;
  }

  const after = await readLogicalPoints([chunk.id], operations, signal);
  if (!after.success) return after;
  const stored = onlyPoint(after.data);
  if (stored === undefined || stored === null) {
    return inserted.success ? corpusFailure("chunk_store_failed") : corpusFailure("record_conflict");
  }
  return detailChunkMatches({ point: stored, expected: chunk })
    ? success(undefined)
    : corpusFailure("record_conflict");
};

export async function storeInstitutionalManifest(input: {
  record: unknown;
  createdAt: unknown;
  operations: ManifestStoreOperations;
  signal?: AbortSignal;
}): Promise<CorpusResult<{ status: "stored" | "unchanged"; id: string; recordKey: string }>> {
  const { record: rawRecord, createdAt, operations, signal } = input;
  if (aborted(signal)) return corpusFailure("aborted");

  const normalized = normalizeInstitutionalManifest(rawRecord, createdAt);
  if (!normalized.success) return normalized;
  const record = normalized.data;

  const existing = await readLogicalPoints([record.id], operations, signal);
  if (!existing.success) return existing;
  const existingManifest = onlyPoint(existing.data);
  if (existingManifest === undefined) return corpusFailure("record_incomplete");
  if (existingManifest !== null) {
    const normalizedExisting = normalizeInstitutionalManifestPoint(existingManifest);
    if (!normalizedExisting.success) return corpusFailure("record_incomplete");
    if (
      normalizedExisting.data.id !== record.id
      || normalizedExisting.data.recordKey !== record.recordKey
      || normalizedExisting.data.payload.content_hash !== record.payload.content_hash
    ) return corpusFailure("record_conflict");
    const verified = await verifyManifestStorage(record, operations, signal);
    return verified.success
      ? success({ status: "unchanged", id: record.id, recordKey: record.recordKey })
      : verified;
  }

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

  for (const chunk of record.chunks) {
    const chunkResult = await verifyOrInsertChunk(chunk, operations, signal);
    if (!chunkResult.success) return chunkResult;
  }

  const storedChunks = await readLogicalPoints(
    record.chunks.map((chunk) => chunk.id),
    operations,
    signal,
  );
  if (!storedChunks.success) return storedChunks;
  const chunksVerified = reassembleDetailChunks({
    manifestRecordKey: record.recordKey,
    detailHash: record.payload.detail_hash,
    detailBytes: record.payload.detail_bytes,
    chunkCount: record.payload.chunk_count,
    points: storedChunks.data,
  });
  if (!chunksVerified) return corpusFailure("record_incomplete");

  const manifestInsert = await insertLogicalPoints([
    { id: record.id, payload: record.payload, vector: vector.data },
  ], operations, signal);
  if (!manifestInsert.success && manifestInsert.error.code !== "record_conflict") {
    return manifestInsert.error.code === "store_failed"
      ? corpusFailure("manifest_store_failed")
      : manifestInsert;
  }

  const verified = await verifyManifestStorage(record, operations, signal);
  if (!verified.success) return verified;
  return success({
    status: manifestInsert.success ? "stored" : "unchanged",
    id: record.id,
    recordKey: record.recordKey,
  });
}
