import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DETAIL_CHUNK_BYTES,
  buildDetailChunks,
  hashDetail,
  reassembleDetailChunks,
  splitDetailIntoChunks,
  utf8ByteLength,
} from "../lib/qdrant-corpus-chunks.ts";

const point = (chunk) => ({ id: chunk.id, payload: chunk.payload });

const reassemble = (manifestRecordKey, detail, chunks, points = chunks.map(point)) =>
  reassembleDetailChunks({
    manifestRecordKey,
    detailHash: hashDetail(detail),
    detailBytes: utf8ByteLength(detail),
    chunkCount: chunks.length,
    points,
  });

test("splits multibyte detail at valid UTF-8 boundaries and reassembles byte-for-byte", () => {
  const manifestRecordKey = "ima-pi:lifecycle:implementation:multibyte";
  const detail = `${"é".repeat(16_000)}\n\n${"🙂".repeat(8_000)}`;
  const chunks = buildDetailChunks({ manifestRecordKey, detail });

  assert.ok(chunks);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every((chunk) =>
    utf8ByteLength(chunk.payload.detail_chunk) <= MAX_DETAIL_CHUNK_BYTES,
  ), true);

  const rebuilt = reassemble(manifestRecordKey, detail, chunks, [...chunks].reverse().map(point));
  assert.deepEqual(rebuilt, {
    detail,
    detailHash: hashDetail(detail),
    detailBytes: utf8ByteLength(detail),
  });
});

test("prefers a paragraph boundary without trimming or adding delimiters", () => {
  const detail = `${"a".repeat(MAX_DETAIL_CHUNK_BYTES - 2)}\n\n${"b".repeat(100)}`;
  const chunks = splitDetailIntoChunks(detail);

  assert.ok(chunks);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], `${"a".repeat(MAX_DETAIL_CHUNK_BYTES - 2)}\n\n`);
  assert.equal(chunks.join(""), detail);
});

test("falls back to strict UTF-8 boundaries when preferred paragraphs exceed the chunk cap", () => {
  const detail = Array.from(
    { length: 4 },
    () => `x\n\n${"a".repeat(MAX_DETAIL_CHUNK_BYTES - 3)}\n\n`,
  ).join("");
  const manifestRecordKey = "ima-pi:lifecycle:implementation:adversarial-boundaries";
  const chunks = buildDetailChunks({ manifestRecordKey, detail });

  assert.ok(chunks);
  assert.equal(utf8ByteLength(detail) <= 160_000, true);
  assert.equal(chunks.length <= 6, true);
  assert.equal(chunks.every((chunk) =>
    utf8ByteLength(chunk.payload.detail_chunk) <= MAX_DETAIL_CHUNK_BYTES,
  ), true);
  assert.deepEqual(reassemble(manifestRecordKey, detail, chunks), {
    detail,
    detailHash: hashDetail(detail),
    detailBytes: utf8ByteLength(detail),
  });
});

test("uses deterministic chunk identities for identical logical detail", () => {
  const input = {
    manifestRecordKey: "ima-pi:lifecycle:implementation:stable",
    detail: "first paragraph\n\nsecond paragraph",
  };
  const first = buildDetailChunks(input);
  const second = buildDetailChunks(input);

  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first, second);
  assert.match(first[0].id, /^[0-9a-f-]{36}$/);
  assert.match(first[0].recordKey, /:chunk:0000$/);
});

test("rejects empty, oversized, and malformed UTF-16 detail before storage planning", () => {
  assert.equal(splitDetailIntoChunks(""), null);
  assert.equal(splitDetailIntoChunks("\ud800"), null);
  assert.equal(splitDetailIntoChunks("x".repeat(160_001)), null);
});

test("fails closed for missing, duplicate, extra, and corrupt chunk responses", () => {
  const manifestRecordKey = "ima-pi:lifecycle:implementation:corrupt";
  const detail = "x".repeat(MAX_DETAIL_CHUNK_BYTES + 100);
  const chunks = buildDetailChunks({ manifestRecordKey, detail });
  assert.ok(chunks);
  assert.equal(chunks.length, 2);

  const validPoints = chunks.map(point);
  const wrongParent = structuredClone(validPoints);
  wrongParent[0].payload.parent_record_key = "other";
  const wrongIndex = structuredClone(validPoints);
  wrongIndex[0].payload.chunk_index = 1;
  const wrongHash = structuredClone(validPoints);
  wrongHash[0].payload.chunk_hash = "a".repeat(64);

  for (const invalid of [
    validPoints.slice(1),
    [validPoints[0], validPoints[0]],
    [...validPoints, validPoints[0]],
    wrongParent,
    wrongIndex,
    wrongHash,
  ]) {
    assert.equal(reassemble(manifestRecordKey, detail, chunks, invalid), null);
  }
});
