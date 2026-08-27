import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";

export const RECORD_ID_NAMESPACE = "0476e0b1-db93-536a-a78e-959ea945997f";
export const CORPUS_SCHEMA_VERSION_V2 = 2;
export const MANIFEST_RECORD_KIND = "manifest";
export const DETAIL_CHUNK_RECORD_KIND = "detail_chunk";
export const MAX_STORED_ARTIFACT_BYTES = 160_000;
export const MAX_DETAIL_CHUNK_BYTES = 32_000;
export const CHUNK_INDEX_WIDTH = 4;
export const MAX_DETAIL_CHUNK_COUNT = Math.ceil(
  MAX_STORED_ARTIFACT_BYTES / MAX_DETAIL_CHUNK_BYTES,
) + 1;

const encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/i;

export type DetailChunkPayload = {
  schema_version: 2;
  record_kind: "detail_chunk";
  parent_record_key: string;
  chunk_index: number;
  chunk_count: number;
  chunk_hash: string;
  detail_chunk: string;
};

export type DetailChunk = {
  id: string;
  recordKey: string;
  payload: DetailChunkPayload;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export const utf8ByteLength = (value: string) => encoder.encode(value).byteLength;

export const hashDetail = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const hasUnpairedSurrogate = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const validDetail = (value: unknown) =>
  typeof value === "string"
  && value.length > 0
  && value.length <= MAX_STORED_ARTIFACT_BYTES
  && !hasUnpairedSurrogate(value)
  && utf8ByteLength(value) <= MAX_STORED_ARTIFACT_BYTES;

export const deriveDeterministicRecordId = (recordKey: string) =>
  uuidv5(recordKey, RECORD_ID_NAMESPACE);

export const detailChunkRecordKey = (manifestRecordKey: string, index: number) =>
  `${manifestRecordKey}:chunk:${String(index).padStart(CHUNK_INDEX_WIDTH, "0")}`;

const largestFittingBoundary = (
  detail: string,
  start: number,
  preferBreaks: boolean,
) => {
  let index = start;
  let bytes = 0;
  let lastNewline = start;
  let lastParagraph = start;

  while (index < detail.length) {
    const codePoint = detail.codePointAt(index);
    if (codePoint === undefined) return start;
    const character = String.fromCodePoint(codePoint);
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > MAX_DETAIL_CHUNK_BYTES) break;

    index += character.length;
    bytes += characterBytes;
    if (character === "\n") {
      lastNewline = index;
      if (/\r?\n\r?\n$/.test(detail.slice(Math.max(start, index - 4), index))) {
        lastParagraph = index;
      }
    }
  }

  if (index === start) return start;
  if (index === detail.length) return index;
  if (!preferBreaks) return index;
  return lastParagraph > start
    ? lastParagraph
    : lastNewline > start
      ? lastNewline
      : index;
};

const planDetailChunks = (detail: string, preferBreaks: boolean): string[] | null => {
  const chunks: string[] = [];
  for (let start = 0; start < detail.length;) {
    const end = largestFittingBoundary(detail, start, preferBreaks);
    if (end <= start) return null;
    chunks.push(detail.slice(start, end));
    start = end;
  }
  return chunks;
};

export function splitDetailIntoChunks(detail: unknown): string[] | null {
  if (!validDetail(detail)) return null;

  const preferred = planDetailChunks(detail, true);
  if (preferred && preferred.length <= MAX_DETAIL_CHUNK_COUNT) return preferred;

  const strict = planDetailChunks(detail, false);
  return strict && strict.length <= MAX_DETAIL_CHUNK_COUNT ? strict : null;
}

export function buildDetailChunks(input: {
  manifestRecordKey: string;
  detail: unknown;
}): DetailChunk[] | null {
  const manifestRecordKey = typeof input.manifestRecordKey === "string"
    ? input.manifestRecordKey.trim()
    : "";
  const chunks = splitDetailIntoChunks(input.detail);
  if (!manifestRecordKey || !chunks) return null;

  return chunks.map((detailChunk, chunkIndex) => {
    const recordKey = detailChunkRecordKey(manifestRecordKey, chunkIndex);
    return {
      id: deriveDeterministicRecordId(recordKey),
      recordKey,
      payload: {
        schema_version: CORPUS_SCHEMA_VERSION_V2,
        record_kind: DETAIL_CHUNK_RECORD_KIND,
        parent_record_key: manifestRecordKey,
        chunk_index: chunkIndex,
        chunk_count: chunks.length,
        chunk_hash: hashDetail(detailChunk),
        detail_chunk: detailChunk,
      },
    };
  });
}

export const detailChunkIds = (manifestRecordKey: string, chunkCount: number) =>
  Array.from({ length: chunkCount }, (_, index) =>
    deriveDeterministicRecordId(detailChunkRecordKey(manifestRecordKey, index)),
  );

const validHash = (value: unknown) =>
  typeof value === "string" && HASH.test(value);

const validChunkCount = (value: unknown) =>
  Number.isInteger(value)
  && Number(value) >= 1
  && Number(value) <= MAX_DETAIL_CHUNK_COUNT;

export function detailChunkMatches(input: {
  point: unknown;
  expected: DetailChunk;
}): boolean {
  const point = object(input.point);
  const payload = object(point?.payload);
  if (!point || !payload || point.id !== input.expected.id) return false;

  const detail = payload.detail_chunk;
  return payload.schema_version === CORPUS_SCHEMA_VERSION_V2
    && payload.record_kind === DETAIL_CHUNK_RECORD_KIND
    && payload.parent_record_key === input.expected.payload.parent_record_key
    && payload.chunk_index === input.expected.payload.chunk_index
    && payload.chunk_count === input.expected.payload.chunk_count
    && payload.chunk_hash === input.expected.payload.chunk_hash
    && detail === input.expected.payload.detail_chunk
    && typeof detail === "string"
    && validDetail(detail)
    && utf8ByteLength(detail) <= MAX_DETAIL_CHUNK_BYTES
    && hashDetail(detail) === input.expected.payload.chunk_hash;
}

export function reassembleDetailChunks(input: {
  manifestRecordKey: string;
  detailHash: string;
  detailBytes: number;
  chunkCount: number;
  points: unknown;
}): { detail: string; detailHash: string; detailBytes: number } | null {
  if (
    typeof input.manifestRecordKey !== "string"
    || !input.manifestRecordKey
    || !validHash(input.detailHash)
    || !Number.isInteger(input.detailBytes)
    || input.detailBytes < 1
    || input.detailBytes > MAX_STORED_ARTIFACT_BYTES
    || !validChunkCount(input.chunkCount)
    || !Array.isArray(input.points)
    || input.points.length !== input.chunkCount
  ) return null;

  const chunks = new Map<number, string>();
  const pointIds = new Set<string>();
  for (const rawPoint of input.points) {
    const point = object(rawPoint);
    const payload = object(point?.payload);
    const id = typeof point?.id === "string" ? point.id : "";
    const parentRecordKey = payload?.parent_record_key;
    const chunkIndex = payload?.chunk_index;
    const chunkCount = payload?.chunk_count;
    const chunkHash = payload?.chunk_hash;
    const detail = payload?.detail_chunk;

    if (
      !point
      || !payload
      || !id
      || pointIds.has(id)
      || payload.schema_version !== CORPUS_SCHEMA_VERSION_V2
      || payload.record_kind !== DETAIL_CHUNK_RECORD_KIND
      || parentRecordKey !== input.manifestRecordKey
      || !Number.isInteger(chunkIndex)
      || Number(chunkIndex) < 0
      || Number(chunkIndex) >= input.chunkCount
      || chunkCount !== input.chunkCount
      || !validHash(chunkHash)
      || typeof detail !== "string"
      || !validDetail(detail)
      || utf8ByteLength(detail) > MAX_DETAIL_CHUNK_BYTES
      || hashDetail(detail) !== chunkHash
      || id !== deriveDeterministicRecordId(detailChunkRecordKey(input.manifestRecordKey, Number(chunkIndex)))
      || chunks.has(Number(chunkIndex))
    ) return null;

    pointIds.add(id);
    chunks.set(Number(chunkIndex), detail);
  }

  if (chunks.size !== input.chunkCount) return null;
  const detail = Array.from({ length: input.chunkCount }, (_, index) => chunks.get(index))
    .join("");
  const detailBytes = utf8ByteLength(detail);
  return validDetail(detail)
    && detailBytes === input.detailBytes
    && hashDetail(detail) === input.detailHash.toLowerCase()
    ? { detail, detailHash: input.detailHash.toLowerCase(), detailBytes }
    : null;
}
