import assert from "node:assert/strict";
import test from "node:test";
import {
  CORPUS_ERROR_GUIDANCE,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_DIGEST,
  INSTITUTIONAL_COLLECTION,
  MAX_PAYLOAD_BYTES,
  MAX_SUMMARY_BYTES,
  VECTOR_NAME,
  VECTOR_SIZE,
  compareCodeUnits,
  corpusFailure,
  deriveRecordId,
  normalizeInstitutionalManifest,
  normalizeInstitutionalRecord,
  normalizeInstitutionalSummary,
  storeInstitutionalManifest,
  storeInstitutionalRecord,
  utf8ByteLength,
  validateEmbedding,
} from "../lib/qdrant-corpus.ts";

const createdAt = "2026-08-25T12:00:00.000Z";
const record = () => ({
  recordKey: "ima-pi:implementation:story-a",
  project: "ima-pi",
  site: "",
  repo: "ima-pi",
  lifecycleKey: "ima-pi:lifecycle:memory-two-tier-qdrant-migration-2026-08-25",
  phase: "implementation",
  summary: "Shared Qdrant institutional corpus foundation.",
  detail: "The bounded full detail remains retrievable by deterministic record key.",
  sourceRefs: [" taskwarrior:ima-pi:story-a ", "docs/decision.md", "docs/decision.md"],
});

const vector = () => Array.from({ length: VECTOR_SIZE }, (_, index) => index / VECTOR_SIZE);
const success = (data) => ({ success: true, data });
const failure = (code) => corpusFailure(code);

const storedPoint = (normalized) => ({
  id: normalized.id,
  recordKey: normalized.recordKey,
  contentHash: normalized.payload.content_hash,
});

test("exports the fixed institutional corpus contract", () => {
  assert.equal(INSTITUTIONAL_COLLECTION, "ima-institutional-memory");
  assert.equal(EMBEDDING_MODEL, "nomic-embed-text:latest");
  assert.equal(EMBEDDING_MODEL_DIGEST.length, 64);
  assert.equal(VECTOR_NAME, "nomic-embed-text-0a109f42");
  assert.equal(VECTOR_SIZE, 768);
  assert.equal(MAX_PAYLOAD_BYTES, 44_000);
  assert.equal(MAX_SUMMARY_BYTES, 2_000);
});

test("normalizes immutable records without mutating caller input", () => {
  const input = record();
  const original = structuredClone(input);
  const normalized = normalizeInstitutionalRecord(input, createdAt);

  assert.equal(normalized.success, true);
  assert.deepEqual(input, original);
  assert.deepEqual(normalized.data.payload.source_refs, [
    "docs/decision.md",
    "taskwarrior:ima-pi:story-a",
  ]);
  assert.equal(normalized.data.payload.record_key, input.recordKey);
  assert.equal(normalized.data.payload.created_at, createdAt);
  assert.match(normalized.data.id, /^[0-9a-f-]{36}$/);
  assert.equal(utf8ByteLength(JSON.stringify(normalized.data.payload)) <= MAX_PAYLOAD_BYTES, true);
});

test("derives stable UUIDv5 identities from normalized record keys", () => {
  const first = deriveRecordId("  example:record  ");
  const second = deriveRecordId("example:record");
  const invalid = deriveRecordId("example\nrecord");

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data, second.data);
  assert.deepEqual(invalid, failure("record_invalid"));
});

test("content hash ignores created_at and changes with immutable content", () => {
  const initial = normalizeInstitutionalRecord(record(), createdAt);
  const later = normalizeInstitutionalRecord(record(), "2026-08-26T12:00:00.000Z");
  const changed = normalizeInstitutionalRecord({ ...record(), detail: "Changed immutable detail." }, createdAt);

  assert.equal(initial.success, true);
  assert.equal(later.success, true);
  assert.equal(changed.success, true);
  assert.equal(initial.data.id, later.data.id);
  assert.equal(initial.data.payload.content_hash, later.data.payload.content_hash);
  assert.notEqual(initial.data.payload.content_hash, changed.data.payload.content_hash);
});

test("rejects malformed controls and UTF-8 oversize summaries", () => {
  const malformed = normalizeInstitutionalRecord({ ...record(), recordKey: "bad\u0000key" }, createdAt);
  const oversized = normalizeInstitutionalRecord({ ...record(), summary: "é".repeat(1_001) }, createdAt);

  assert.deepEqual(malformed, failure("record_invalid"));
  assert.deepEqual(oversized, failure("record_too_large"));
});

test("requires an exactly sized finite embedding vector", () => {
  assert.equal(validateEmbedding(vector()).success, true);
  assert.deepEqual(validateEmbedding(vector().slice(1)), failure("embedding_dimension_mismatch"));
  const nonFinite = vector();
  nonFinite[0] = Number.NaN;
  assert.deepEqual(validateEmbedding(nonFinite), failure("embedding_dimension_mismatch"));
});

test("returns unchanged before embedding or insertion for a matching immutable record", async () => {
  const normalized = normalizeInstitutionalRecord(record(), createdAt);
  assert.equal(normalized.success, true);
  const calls = [];
  const result = await storeInstitutionalRecord({
    record: record(),
    createdAt,
    operations: {
      getPoint: async () => {
        calls.push("get");
        return success(storedPoint(normalized.data));
      },
      ensureCollection: async () => {
        calls.push("ensure");
        return success(undefined);
      },
      embedSummary: async () => {
        calls.push("embed");
        return success(vector());
      },
      insertPoint: async () => {
        calls.push("insert");
        return success(undefined);
      },
    },
  });

  assert.deepEqual(result, success({ status: "unchanged", id: normalized.data.id, recordKey: normalized.data.recordKey }));
  assert.deepEqual(calls, ["get"]);
});

test("rejects a reused record key with divergent immutable content", async () => {
  const normalized = normalizeInstitutionalRecord(record(), createdAt);
  assert.equal(normalized.success, true);
  const divergent = { ...storedPoint(normalized.data), contentHash: "a".repeat(64) };
  const result = await storeInstitutionalRecord({
    record: record(),
    createdAt,
    operations: {
      getPoint: async () => success(divergent),
      ensureCollection: async () => success(undefined),
      embedSummary: async () => success(vector()),
      insertPoint: async () => success(undefined),
    },
  });

  assert.deepEqual(result, failure("record_conflict"));
});

test("stores only after insertion reread verifies the immutable record", async () => {
  const normalized = normalizeInstitutionalRecord(record(), createdAt);
  assert.equal(normalized.success, true);
  const calls = [];
  const result = await storeInstitutionalRecord({
    record: record(),
    createdAt,
    operations: {
      getPoint: async () => {
        calls.push("get");
        return calls.filter((call) => call === "get").length === 1
          ? success(null)
          : success(storedPoint(normalized.data));
      },
      ensureCollection: async () => {
        calls.push("ensure");
        return success(undefined);
      },
      embedSummary: async (summary) => {
        calls.push(`embed:${summary}`);
        return success(vector());
      },
      insertPoint: async ({ record: inserted, vector: insertedVector }) => {
        calls.push("insert");
        assert.equal(inserted.id, normalized.data.id);
        assert.equal(insertedVector.length, VECTOR_SIZE);
        return success(undefined);
      },
    },
  });

  assert.deepEqual(result, success({ status: "stored", id: normalized.data.id, recordKey: normalized.data.recordKey }));
  assert.deepEqual(calls, ["get", "ensure", `embed:${record().summary}`, "insert", "get"]);
});

test("resolves an insert-only concurrent winner without overwriting", async () => {
  const normalized = normalizeInstitutionalRecord(record(), createdAt);
  assert.equal(normalized.success, true);
  let reads = 0;
  const result = await storeInstitutionalRecord({
    record: record(),
    createdAt,
    operations: {
      getPoint: async () => {
        reads += 1;
        return reads === 1 ? success(null) : success(storedPoint(normalized.data));
      },
      ensureCollection: async () => success(undefined),
      embedSummary: async () => success(vector()),
      insertPoint: async () => failure("record_conflict"),
    },
  });

  assert.deepEqual(result, success({ status: "unchanged", id: normalized.data.id, recordKey: normalized.data.recordKey }));
});

test("fails closed when an insert cannot be verified", async () => {
  const result = await storeInstitutionalRecord({
    record: record(),
    createdAt,
    operations: {
      getPoint: async () => success(null),
      ensureCollection: async () => success(undefined),
      embedSummary: async () => success(vector()),
      insertPoint: async () => success(undefined),
    },
  });

  assert.deepEqual(result, failure("store_unverified"));
});

test("uses code-unit source-reference ordering for cross-machine hashes", () => {
  const values = ["z", "é", "Z", "a"];
  const permutations = (items) => items.length < 2
    ? [items]
    : items.flatMap((item, index) => permutations([
      ...items.slice(0, index),
      ...items.slice(index + 1),
    ]).map((rest) => [item, ...rest]));
  const records = permutations(values).map((sourceRefs) =>
    normalizeInstitutionalRecord({ ...record(), sourceRefs }, createdAt));

  assert.equal(compareCodeUnits("Z", "a") < 0, true);
  assert.equal(records.every((result) => result.success), true);
  assert.deepEqual(records[0].data.payload.source_refs, ["Z", "a", "z", "é"]);
  assert.equal(
    new Set(records.map((result) => result.data.payload.content_hash)).size,
    1,
  );
});

test("invalid records and post-read aborts cause no later store effects", async () => {
  for (const invalid of [
    { ...record(), summary: "é".repeat(1_001) },
    { ...record(), recordKey: "bad\nkey" },
  ]) {
    const calls = [];
    const result = await storeInstitutionalRecord({
      record: invalid,
      createdAt,
      operations: {
        getPoint: async () => { calls.push("get"); return success(null); },
        ensureCollection: async () => { calls.push("ensure"); return success(undefined); },
        embedSummary: async () => { calls.push("embed"); return success(vector()); },
        insertPoint: async () => { calls.push("insert"); return success(undefined); },
      },
    });
    assert.equal(result.success, false);
    assert.deepEqual(calls, []);
  }

  const controller = new AbortController();
  const calls = [];
  const abortedResult = await storeInstitutionalRecord({
    record: record(),
    createdAt,
    signal: controller.signal,
    operations: {
      getPoint: async () => {
        calls.push("get");
        controller.abort();
        return success(null);
      },
      ensureCollection: async () => { calls.push("ensure"); return success(undefined); },
      embedSummary: async () => { calls.push("embed"); return success(vector()); },
      insertPoint: async () => { calls.push("insert"); return success(undefined); },
    },
  });
  assert.deepEqual(abortedResult, failure("aborted"));
  assert.deepEqual(calls, ["get"]);
});

test("stores vectorless chunks before the manifest commit marker and verifies direct reassembly", async () => {
  const detail = "x".repeat(40_000);
  const rawRecord = { ...record(), recordKey: "ima-pi:implementation:chunked", detail };
  const normalized = normalizeInstitutionalManifest(rawRecord, createdAt);
  assert.equal(normalized.success, true);
  const points = new Map();
  const calls = [];
  const result = await storeInstitutionalManifest({
    record: rawRecord,
    createdAt,
    operations: {
      getPoints: async (ids) => {
        calls.push(`get:${ids.length}`);
        return success(ids.flatMap((id) => points.has(id) ? [points.get(id)] : []));
      },
      ensureCollection: async () => {
        calls.push("ensure");
        return success(undefined);
      },
      embedSummary: async () => {
        calls.push("embed");
        return success(vector());
      },
      insertPoints: async ({ points: inserted }) => {
        const kind = inserted[0].payload.record_kind;
        calls.push(`insert:${kind}`);
        for (const point of inserted) points.set(point.id, { id: point.id, payload: point.payload });
        return success(undefined);
      },
    },
  });

  assert.deepEqual(result, success({ status: "stored", id: normalized.data.id, recordKey: normalized.data.recordKey }));
  const firstManifestInsert = calls.indexOf("insert:manifest");
  assert.equal(firstManifestInsert > calls.lastIndexOf("insert:detail_chunk"), true);
  assert.equal(points.size, normalized.data.chunks.length + 1);
});

test("an interrupted pre-manifest write reuses verified chunks on an identical retry", async () => {
  const rawRecord = { ...record(), recordKey: "ima-pi:implementation:retry", detail: "x".repeat(40_000) };
  const points = new Map();
  let failManifest = true;
  const operations = {
    getPoints: async (ids) => success(ids.flatMap((id) => points.has(id) ? [points.get(id)] : [])),
    ensureCollection: async () => success(undefined),
    embedSummary: async () => success(vector()),
    insertPoints: async ({ points: inserted }) => {
      if (inserted[0].payload.record_kind === "manifest" && failManifest) return failure("store_failed");
      for (const point of inserted) {
        if (points.has(point.id)) return failure("record_conflict");
        points.set(point.id, { id: point.id, payload: point.payload });
      }
      return success(undefined);
    },
  };

  const first = await storeInstitutionalManifest({ record: rawRecord, createdAt, operations });
  assert.deepEqual(first, failure("manifest_store_failed"));
  assert.equal([...points.values()].every(({ payload }) => payload.record_kind === "detail_chunk"), true);

  failManifest = false;
  const second = await storeInstitutionalManifest({ record: rawRecord, createdAt, operations });
  assert.equal(second.success, true);
  assert.equal(second.data.status, "stored");
  assert.equal([...points.values()].some(({ payload }) => payload.record_kind === "manifest"), true);
});

test("central error guidance is immutable, actionable, and secret-free", () => {
  assert.equal(Object.isFrozen(CORPUS_ERROR_GUIDANCE), true);
  for (const [code, guidance] of [
    ["qdrant_unavailable", "local Qdrant service"],
    ["ollama_unavailable", "local Ollama service"],
    ["qdrant_version_unsupported", "Qdrant 1.16.0"],
    ["embedding_model_missing", "nomic-embed-text:latest"],
    ["embedding_model_mismatch", "model digest"],
    ["collection_incompatible", "do not repair or overwrite"],
  ]) {
    const message = corpusFailure(code).error.message;
    assert.match(message, new RegExp(guidance));
    assert.doesNotMatch(message, /token=|https?:\/\/|stack/i);
  }
});

test("summary projection requires complete deterministic metadata and semantic scores", () => {
  const normalized = normalizeInstitutionalRecord(record(), createdAt);
  assert.equal(normalized.success, true);
  const point = { id: normalized.data.id, payload: normalized.data.payload, score: 0.8 };
  const semantic = normalizeInstitutionalSummary(point, { requireScore: true });
  const recall = normalizeInstitutionalSummary(
    { id: normalized.data.id, payload: normalized.data.payload },
    { requireScore: false },
  );

  assert.equal(semantic.success, true);
  assert.equal(recall.success, true);
  assert.equal("detail" in semantic.data, false);
  for (const malformed of [
    { ...point, id: "wrong" },
    { ...point, payload: { ...point.payload, site: undefined } },
    { ...point, payload: { ...point.payload, repo: 42 } },
    { ...point, payload: { ...point.payload, project: "p".repeat(257) } },
    { ...point, payload: { ...point.payload, repo: "bad\nrepo" } },
    { ...point, payload: { ...point.payload, source_refs: [...point.payload.source_refs].reverse() } },
    { ...point, score: Number.NaN },
    { id: point.id, payload: point.payload },
  ]) {
    assert.deepEqual(
      normalizeInstitutionalSummary(malformed, { requireScore: true }),
      failure("response_invalid"),
    );
  }
});

test("summary projection enforces the 2,000-byte UTF-8 boundary", () => {
  const exactRecord = normalizeInstitutionalRecord({
    ...record(),
    summary: "é".repeat(1_000),
  }, createdAt);
  assert.equal(exactRecord.success, true);
  const exactPoint = {
    id: exactRecord.data.id,
    payload: exactRecord.data.payload,
    score: 0.8,
  };
  assert.equal(
    normalizeInstitutionalSummary(exactPoint, { requireScore: true }).success,
    true,
  );
  assert.deepEqual(
    normalizeInstitutionalSummary({
      ...exactPoint,
      payload: { ...exactPoint.payload, summary: "é".repeat(1_001) },
    }, { requireScore: true }),
    failure("response_invalid"),
  );
});
