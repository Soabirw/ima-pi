import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  MAX_CORPUS_TOOL_OUTPUT_BYTES,
  registerInstitutionalMemoryTools,
} from "../extensions/institutional-memory.ts";
import {
  EMBEDDING_MODEL_DIGEST,
  VECTOR_NAME,
  VECTOR_SIZE,
  corpusFailure,
  normalizeInstitutionalManifest,
  normalizeInstitutionalRecord,
  storeInstitutionalManifest,
  utf8ByteLength,
} from "../lib/qdrant-corpus.ts";
import {
  createQdrantCorpusClient,
  resolveCorpusEndpoints,
} from "../lib/qdrant-http.ts";

const success = (data) => ({ success: true, data });
const failure = (code, context) => corpusFailure(code, context);
const vector = () => Array.from({ length: VECTOR_SIZE }, () => 0.25);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const collection = (indexed = true) => ({
  result: {
    config: {
      params: {
        vectors: {
          [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" },
        },
      },
    },
    payload_schema: indexed
      ? Object.fromEntries(["lifecycle_key", "phase", "project", "site", "repo", "record_kind", "parent_record_key"].map((field) => [field, { data_type: "keyword" }]))
      : {},
  },
});
const modelTags = { models: [{ name: "nomic-embed-text:latest", digest: EMBEDDING_MODEL_DIGEST }] };
const environment = {
  IMA_QDRANT_URL: "http://qdrant.test",
  IMA_OLLAMA_URL: "http://ollama.test",
};

const institutionalPoint = (recordKey = "key", overrides = {}) => {
  const normalized = normalizeInstitutionalRecord({
    recordKey,
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey: "life",
    phase: "plan",
    summary: "summary",
    detail: "must not leak",
    sourceRefs: ["source"],
    ...overrides,
  }, "2026-08-25T00:00:00.000Z");
  if (!normalized.success) throw new Error("fixture invalid");
  return { id: normalized.data.id, payload: normalized.data.payload };
};

const fakeClient = (overrides = {}) => ({
  status: async () => success({ status: "ready", qdrantVersion: "1.17.1", collection: "ready", missingIndexes: [] }),
  ensureCollection: async () => success({ status: "ready", qdrantVersion: "1.17.1", collection: "ready", missingIndexes: [] }),
  getPoint: async () => success(null),
  embedSummary: async () => success(vector()),
  insertPoint: async () => success(undefined),
  findInstitutional: async () => success([{ id: "point", recordKey: "key", project: "ima-pi", site: "", repo: "ima-pi", lifecycleKey: "life", phase: "plan", summary: "summary", score: 0.9 }]),
  recallInstitutional: async () => success([]),
  getInstitutional: async () => success({ id: "point", recordKey: "key", project: "ima-pi", site: "", repo: "ima-pi", lifecycleKey: "life", phase: "plan", summary: "summary", detail: "full detail", sourceRefs: [], contentHash: "a".repeat(64), createdAt: "2026-08-25T00:00:00.000Z" }),
  findKnowledge: async () => success([]),
  ...overrides,
});

test("strict corpus tool schemas and registration expose all five native tools", async () => {
  const tools = [];
  registerInstitutionalMemoryTools({ registerTool: (tool) => tools.push(tool) }, { client: fakeClient() });
  assert.deepEqual(tools.map((tool) => tool.name), [
    "ima_corpus_status",
    "ima_corpus_store",
    "ima_corpus_find",
    "ima_corpus_recall",
    "ima_corpus_get",
  ]);
  const status = tools[0];
  const store = tools[1];
  const find = tools[2];
  const recall = tools[3];
  assert.equal(Check(status.parameters, {}), true);
  assert.equal(Check(status.parameters, { unwanted: true }), false);
  assert.equal(Check(store.parameters, {
    recordKey: "key", project: "ima-pi", site: "", repo: "ima-pi", lifecycleKey: "life", phase: "plan", summary: "summary", detail: "detail",
  }), true);
  assert.equal(Check(store.parameters, { recordKey: "key" }), false);
  assert.equal(Check(find.parameters, { query: "evidence", limit: 21 }), false);
  assert.equal(Check(recall.parameters, { lifecycleKey: "life", phase: "plan" }), false);
});

test("status is read-only and store returns only its immutable outcome", async () => {
  let ensured = 0;
  let reads = 0;
  const storeRequest = {
    recordKey: "key", project: "ima-pi", site: "", repo: "ima-pi", lifecycleKey: "life", phase: "plan", summary: "summary", detail: "detail",
  };
  const normalized = normalizeInstitutionalRecord(storeRequest, "2026-08-25T00:00:00.000Z");
  assert.equal(normalized.success, true);
  const stored = {
    id: normalized.data.id,
    recordKey: normalized.data.recordKey,
    contentHash: normalized.data.payload.content_hash,
  };
  const client = fakeClient({
    ensureCollection: async () => {
      ensured += 1;
      return success({ status: "ready", qdrantVersion: "1.17.1", collection: "ready", missingIndexes: [] });
    },
    getPoint: async () => {
      reads += 1;
      return reads === 1 ? success(null) : success(stored);
    },
  });
  const tools = [];
  registerInstitutionalMemoryTools({ registerTool: (tool) => tools.push(tool) }, {
    client,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });

  const status = await tools[0].execute("status", {}, undefined);
  assert.equal(JSON.parse(status.content[0].text).status, "ready");
  assert.equal(ensured, 0);

  const storedResult = await tools[1].execute("store", storeRequest, undefined);
  assert.equal(ensured, 1);
  assert.deepEqual(JSON.parse(storedResult.content[0].text), { status: "stored", id: stored.id, recordKey: stored.recordKey });
});

test("large corpus-tool detail stores a manifest and vectorless chunks instead of a schema-v1 point", async () => {
  const points = new Map();
  const client = fakeClient({
    getPoints: async (ids) => success(ids.flatMap((id) => points.has(id) ? [points.get(id)] : [])),
    insertPoints: async ({ points: inserted }) => {
      for (const point of inserted) {
        if (points.has(point.id)) return failure("record_conflict");
        points.set(point.id, { id: point.id, payload: point.payload });
      }
      return success(undefined);
    },
  });
  const tools = [];
  registerInstitutionalMemoryTools({ registerTool: (tool) => tools.push(tool) }, {
    client,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });

  const result = await tools[1].execute("store", {
    recordKey: "large-detail",
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey: "life",
    phase: "implementation",
    summary: "Large detail uses schema-v2 storage.",
    detail: "x".repeat(50_000),
  }, undefined);

  assert.equal(JSON.parse(result.content[0].text).status, "stored");
  assert.equal([...points.values()].filter(({ payload }) => payload.record_kind === "manifest").length, 1);
  assert.equal([...points.values()].filter(({ payload }) => payload.record_kind === "detail_chunk").length > 1, true);
});

test("find and recall tool output excludes full detail while get returns one bounded record", async () => {
  const tools = [];
  registerInstitutionalMemoryTools({ registerTool: (tool) => tools.push(tool) }, { client: fakeClient() });

  const found = await tools[2].execute("find", { query: "evidence" }, undefined);
  const recalled = await tools[3].execute("recall", { lifecycleKey: "life" }, undefined);
  const full = await tools[4].execute("get", { recordKey: "key" }, undefined);
  assert.doesNotMatch(found.content[0].text, /detail/);
  assert.doesNotMatch(recalled.content[0].text, /detail/);
  assert.equal(utf8ByteLength(found.content[0].text) <= MAX_CORPUS_TOOL_OUTPUT_BYTES, true);
  assert.equal(utf8ByteLength(recalled.content[0].text) <= MAX_CORPUS_TOOL_OUTPUT_BYTES, true);
  assert.match(full.content[0].text, /full detail/);
});

test("tool failures expose only stable sanitized codes", async () => {
  const tools = [];
  registerInstitutionalMemoryTools({ registerTool: (tool) => tools.push(tool) }, {
    client: fakeClient({ status: async () => failure("qdrant_unavailable") }),
  });
  await assert.rejects(tools[0].execute("status", {}, undefined), /Qdrant corpus failed: qdrant_unavailable\./);
});

test("endpoint resolution rejects unsafe operator configuration", () => {
  assert.equal(resolveCorpusEndpoints({ IMA_QDRANT_URL: "https://user:secret@qdrant.test" }).success, false);
  assert.equal(resolveCorpusEndpoints({ IMA_QDRANT_URL: "file:///tmp/qdrant" }).success, false);
  assert.equal(resolveCorpusEndpoints(environment).success, true);
});

test("status performs bounded read-only prerequisite and compatibility checks", async () => {
  const calls = [];
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      calls.push({ method: init.method ?? "GET", path: request.pathname });
      if (request.hostname === "qdrant.test" && request.pathname === "/") return json({ version: "1.17.1" });
      if (request.hostname === "ollama.test" && request.pathname === "/api/tags") return json(modelTags);
      if (request.hostname === "qdrant.test" && request.pathname === "/collections/ima-institutional-memory") return json(collection());
      throw new Error(`unexpected ${request}`);
    },
  });

  const result = await client.status();
  assert.deepEqual(result, success({ status: "ready", qdrantVersion: "1.17.1", collection: "ready", missingIndexes: [] }));
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "GET"]);
});

test("ensureCollection creates an absent collection and only missing keyword indexes", async () => {
  const calls = [];
  let exists = false;
  let indexed = false;
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      const method = init.method ?? "GET";
      calls.push({ method, path: request.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
      if (request.hostname === "qdrant.test" && request.pathname === "/") return json({ version: "1.17.1" });
      if (request.hostname === "ollama.test" && request.pathname === "/api/tags") return json(modelTags);
      if (request.pathname === "/collections/ima-institutional-memory" && method === "GET") return exists ? json(collection(indexed)) : json({}, 404);
      if (request.pathname === "/collections/ima-institutional-memory" && method === "PUT") {
        exists = true;
        assert.deepEqual(JSON.parse(String(init.body)), { vectors: { [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" } } });
        return json({ result: true });
      }
      if (request.pathname === "/collections/ima-institutional-memory/index" && method === "PUT") {
        indexed = true;
        return json({ result: true });
      }
      throw new Error(`unexpected ${method} ${request}`);
    },
  });

  const result = await client.ensureCollection();
  assert.equal(result.success, true);
  assert.equal(result.data.collection, "ready");
  assert.equal(calls.filter((call) => call.path.endsWith("/index")).length, 7);
});

test("semantic and legacy searches use bounded payload selectors and never return detail", async () => {
  const calls = [];
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: request.pathname, body });
      if (request.hostname === "qdrant.test" && request.pathname === "/collections/ima-institutional-memory") return json(collection());
      if (request.hostname === "qdrant.test" && request.pathname === "/collections/ima-knowledge") return json({ result: { config: { params: { vectors: { size: VECTOR_SIZE, distance: "Cosine" } } } } });
      if (request.hostname === "ollama.test" && request.pathname === "/api/tags") return json(modelTags);
      if (request.hostname === "ollama.test" && request.pathname === "/api/embed") return json({ embeddings: [vector()] });
      if (request.pathname.endsWith("/points/query")) return json({
        result: { points: [{ ...institutionalPoint(), score: 0.8 }] },
      });
      if (request.pathname.endsWith("/points/search")) return json({ result: [{ id: "legacy", score: 0.7, payload: { document: "legacy summary" } }] });
      throw new Error(`unexpected ${request}`);
    },
  });

  const institutional = await client.findInstitutional({ query: "evidence", limit: 1 });
  const legacy = await client.findKnowledge({ query: "evidence", collection: "ima-knowledge", limit: 1 });
  assert.equal(institutional.success, true);
  assert.equal(JSON.stringify(institutional.data).includes("must not leak"), false);
  assert.deepEqual(legacy, success([{ summary: "legacy summary", score: 0.7 }]));
  const query = calls.find((call) => call.path.endsWith("/points/query"));
  assert.deepEqual(query.body.with_payload, { exclude: ["detail", "detail_chunk"] });
});

test("legacy knowledge lookup rejects arbitrary collections before external calls", async () => {
  let calls = 0;
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async () => {
      calls += 1;
      throw new Error("arbitrary collections must not be queried");
    },
  });

  const result = await client.findKnowledge({ query: "evidence", collection: "other-knowledge", limit: 1 });
  assert.deepEqual(result, failure("collection_incompatible"));
  assert.equal(calls, 0);
});

test("semantic find propagates an over-byte external summary as response_invalid", async () => {
  const point = institutionalPoint("over-byte-summary");
  point.payload.summary = "é".repeat(1_001);
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input) => {
      const request = new URL(String(input));
      if (request.pathname === "/collections/ima-institutional-memory") return json(collection());
      if (request.pathname === "/api/tags") return json(modelTags);
      if (request.pathname === "/api/embed") return json({ embeddings: [vector()] });
      if (request.pathname.endsWith("/points/query")) {
        return json({ result: { points: [{ ...point, score: 0.8 }] } });
      }
      throw new Error(`unexpected ${request}`);
    },
  });

  assert.deepEqual(
    await client.findInstitutional({ query: "evidence", limit: 1 }),
    failure("response_invalid"),
  );
});

test("insert uses named vectors with insert_only and wait", async () => {
  const calls = [];
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      calls.push({ path: request.pathname, search: request.search, body: init.body ? JSON.parse(String(init.body)) : null });
      return json({ result: true });
    },
  });
  const record = {
    id: "6e90312f-9c9e-5cc4-85f6-1ea0f64d76a4",
    recordKey: "key",
    payload: { schema_version: 1, record_key: "key", project: "ima-pi", site: "", repo: "ima-pi", lifecycle_key: "life", phase: "plan", summary: "summary", detail: "detail", source_refs: [], content_hash: "a".repeat(64), created_at: "2026-08-25T00:00:00.000Z" },
  };
  const result = await client.insertPoint({ record, vector: vector() });
  assert.equal(result.success, true);
  assert.match(calls[0].search, /wait=true/);
  assert.match(calls[0].search, /update_mode=insert_only/);
  assert.deepEqual(calls[0].body.points[0].vector, { [VECTOR_NAME]: vector() });
});

test("effectful insert does not retry an indeterminate transport reset by default", async () => {
  const secret = "insert-transport-secret";
  let calls = 0;
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      calls += 1;
      const request = new URL(String(input));
      assert.equal(init.method, "PUT");
      assert.match(request.pathname, /\/points$/);
      throw Object.assign(new Error(secret), { cause: { code: "ECONNRESET" } });
    },
  });

  const result = await client.insertPoint({
    record: institutionalPoint("effectful-transport"),
    vector: vector(),
  });

  assert.deepEqual(result, failure("qdrant_unavailable", {
    operation: "institutional_collection",
    cause: "transport_reset",
  }));
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /insert-transport-secret|qdrant\.test/);
});

test("vectorless chunk insertion uses an empty Qdrant batch vector map", async () => {
  const calls = [];
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      calls.push({ path: request.pathname, search: request.search, body: JSON.parse(String(init.body)) });
      return json({ result: true });
    },
  });

  const result = await client.insertPoints({
    points: [{
      id: "7e90312f-9c9e-5cc4-85f6-1ea0f64d76a4",
      payload: { schema_version: 2, record_kind: "detail_chunk" },
    }],
  });
  assert.equal(result.success, true);
  assert.match(calls[0].search, /wait=true/);
  assert.match(calls[0].search, /update_mode=insert_only/);
  assert.deepEqual(calls[0].body, {
    batch: {
      ids: ["7e90312f-9c9e-5cc4-85f6-1ea0f64d76a4"],
      vectors: {},
      payloads: [{ schema_version: 2, record_kind: "detail_chunk" }],
    },
  });
});

test("status fails closed for an approved-model digest mismatch", async () => {
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input) => {
      const request = new URL(String(input));
      if (request.hostname === "qdrant.test") return json({ version: "1.17.1" });
      return json({ models: [{ name: "nomic-embed-text:latest", digest: "wrong-digest" }] });
    },
  });
  assert.deepEqual(await client.status(), failure("embedding_model_mismatch", {
    operation: "ollama_embedding_model",
    cause: "incompatible",
  }));
});

test("lifecycle recall uses an exact keyword filter and excludes full detail", async () => {
  const calls = [];
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: request.pathname, body });
      if (request.pathname === "/collections/ima-institutional-memory") return json(collection());
      if (request.pathname === "/collections/ima-institutional-memory/points/scroll") {
        return json({ result: { points: [institutionalPoint()] } });
      }
      throw new Error(`unexpected ${request}`);
    },
  });

  const result = await client.recallInstitutional({ lifecycleKey: "life", phase: "plan", limit: 1 });
  assert.equal(result.success, true);
  assert.doesNotMatch(JSON.stringify(result.data), /must not leak/);
  const scroll = calls.find((call) => call.path.endsWith("/points/scroll"));
  assert.deepEqual(scroll.body.filter, {
    must: [
      { key: "lifecycle_key", match: { value: "life" } },
      { key: "phase", match: { value: "plan" } },
    ],
    must_not: [{ key: "record_kind", match: { value: "detail_chunk" } }],
  });
  assert.deepEqual(scroll.body.with_payload, { exclude: ["detail", "detail_chunk"] });
});

test("full retrieval validates deterministic identity and returns bounded detail", async () => {
  const input = {
    recordKey: "ima-pi:plan:story-a", project: "ima-pi", site: "", repo: "ima-pi", lifecycleKey: "life", phase: "plan", summary: "summary", detail: "exact full detail", sourceRefs: ["source"],
  };
  const normalized = normalizeInstitutionalRecord(input, "2026-08-25T00:00:00.000Z");
  assert.equal(normalized.success, true);
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (inputUrl) => {
      const request = new URL(String(inputUrl));
      if (request.pathname === "/collections/ima-institutional-memory/points") {
        return json({ result: [{ id: normalized.data.id, payload: normalized.data.payload }] });
      }
      throw new Error(`unexpected ${request}`);
    },
  });

  const result = await client.getInstitutional("ima-pi:plan:story-a");
  assert.equal(result.success, true);
  assert.equal(result.data.detail, "exact full detail");
  assert.deepEqual(result.data.sourceRefs, ["source"]);
});

test("schema-v2 full retrieval directly reassembles vectorless chunks from singleton reads", async () => {
  const input = {
    recordKey: "ima-pi:implementation:chunked",
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey: "life",
    phase: "implementation",
    summary: "Chunked lifecycle record.",
    detail: "é".repeat(20_000),
    sourceRefs: ["source"],
  };
  const manifest = normalizeInstitutionalManifest(input, "2026-08-25T00:00:00.000Z");
  assert.equal(manifest.success, true);
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (inputUrl, init = {}) => {
      const request = new URL(String(inputUrl));
      const ids = JSON.parse(String(init.body)).ids;
      if (request.pathname !== "/collections/ima-institutional-memory/points") {
        throw new Error(`unexpected ${request}`);
      }
      if (ids.length === 1 && ids[0] === manifest.data.id) {
        return json({ result: [{ id: manifest.data.id, payload: manifest.data.payload }] });
      }
      const chunk = manifest.data.chunks.find((candidate) => candidate.id === ids[0]);
      return json({ result: chunk ? [{ id: chunk.id, payload: chunk.payload }] : [] });
    },
  });

  const result = await client.getInstitutional(input.recordKey);
  assert.equal(result.success, true);
  assert.equal(result.data.detail, input.detail);
  assert.equal(result.data.contentHash, manifest.data.payload.content_hash);
});

test("schema-v2 singleton reads keep escaped near-limit chunks below the response bound", async () => {
  const input = {
    recordKey: "ima-pi:implementation:escaped-chunks",
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey: "life",
    phase: "implementation",
    summary: "Escaped chunk transport stays bounded.",
    detail: "\t".repeat(160_000),
    sourceRefs: ["source"],
  };
  const manifest = normalizeInstitutionalManifest(input, "2026-08-25T00:00:00.000Z");
  assert.equal(manifest.success, true);
  const calls = [];
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (inputUrl, init = {}) => {
      const request = new URL(String(inputUrl));
      const ids = JSON.parse(String(init.body)).ids;
      calls.push(ids);
      const point = ids[0] === manifest.data.id
        ? { id: manifest.data.id, payload: manifest.data.payload }
        : manifest.data.chunks.find((candidate) => candidate.id === ids[0]);
      return json({ result: point ? [{ id: point.id, payload: point.payload }] : [] });
    },
  });

  const result = await client.getInstitutional(input.recordKey);
  assert.equal(result.success, true);
  assert.equal(result.data.detail, input.detail);
  assert.deepEqual(calls.map((ids) => ids.length), Array(manifest.data.chunks.length + 1).fill(1));
});

test("manifest storage verifies escaped near-limit chunks through bounded singleton reads", async () => {
  const points = new Map();
  const pointReadIds = [];
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (inputUrl, init = {}) => {
      const request = new URL(String(inputUrl));
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (request.pathname === "/") return json({ version: "1.17.1" });
      if (request.pathname === "/api/tags") return json(modelTags);
      if (request.pathname === "/api/embed") return json({ embeddings: [vector()] });
      if (request.pathname === "/collections/ima-institutional-memory" && method === "GET") return json(collection());
      if (request.pathname === "/collections/ima-institutional-memory/points" && method === "POST") {
        pointReadIds.push(body.ids);
        return json({ result: body.ids.flatMap((id) => points.has(id) ? [points.get(id)] : []) });
      }
      if (request.pathname === "/collections/ima-institutional-memory/points" && method === "PUT") {
        if (body.batch) {
          body.batch.ids.forEach((id, index) => points.set(id, { id, payload: body.batch.payloads[index] }));
        } else {
          body.points.forEach((point) => points.set(point.id, { id: point.id, payload: point.payload }));
        }
        return json({ result: true });
      }
      throw new Error(`unexpected ${method} ${request}`);
    },
  });
  const detail = "\t".repeat(160_000);
  const stored = await storeInstitutionalManifest({
    record: {
      recordKey: "ima-pi:implementation:escaped-store",
      project: "ima-pi",
      site: "",
      repo: "ima-pi",
      lifecycleKey: "life",
      phase: "implementation",
      summary: "Escaped storage verification remains bounded.",
      detail,
      sourceRefs: ["source"],
    },
    createdAt: "2026-08-25T00:00:00.000Z",
    operations: client,
  });

  assert.equal(stored.success, true);
  assert.equal(pointReadIds.every((ids) => ids.length === 1), true);
  const full = await client.getInstitutional(stored.data.recordKey);
  assert.equal(full.success, true);
  assert.equal(full.data.detail, detail);
});

test("singleton retrieval aborts before later chunk reads", async () => {
  const input = {
    recordKey: "ima-pi:implementation:abort-chunks",
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey: "life",
    phase: "implementation",
    summary: "Abort stops later chunk reads.",
    detail: "x".repeat(40_000),
    sourceRefs: ["source"],
  };
  const manifest = normalizeInstitutionalManifest(input, "2026-08-25T00:00:00.000Z");
  assert.equal(manifest.success, true);
  const controller = new AbortController();
  let calls = 0;
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (inputUrl, init = {}) => {
      const ids = JSON.parse(String(init.body)).ids;
      calls += 1;
      const point = ids[0] === manifest.data.id
        ? { id: manifest.data.id, payload: manifest.data.payload }
        : manifest.data.chunks.find((candidate) => candidate.id === ids[0]);
      if (ids[0] !== manifest.data.id) controller.abort();
      return json({ result: point ? [{ id: point.id, payload: point.payload }] : [] });
    },
  });

  assert.deepEqual(await client.getInstitutional(input.recordKey, controller.signal), failure("aborted"));
  assert.equal(calls, 2);
});

test("an individually oversized singleton provider response remains sanitized", async () => {
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async () => json({ result: [{ id: "6e90312f-9c9e-5cc4-85f6-1ea0f64d76a4", payload: { pad: "x".repeat(300_000) } }] }),
  });

  assert.deepEqual(await client.getInstitutional("ima-pi:implementation:oversized-response"), failure("response_invalid"));
});

test("schema-v2 full retrieval fails closed for an incomplete chunk response", async () => {
  const input = {
    recordKey: "ima-pi:implementation:incomplete",
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey: "life",
    phase: "implementation",
    summary: "Incomplete chunks fail closed.",
    detail: "x".repeat(40_000),
    sourceRefs: ["source"],
  };
  const manifest = normalizeInstitutionalManifest(input, "2026-08-25T00:00:00.000Z");
  assert.equal(manifest.success, true);
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (inputUrl, init = {}) => {
      const request = new URL(String(inputUrl));
      const ids = JSON.parse(String(init.body)).ids;
      if (ids.length === 1 && ids[0] === manifest.data.id) {
        return json({ result: [{ id: manifest.data.id, payload: manifest.data.payload }] });
      }
      const firstChunk = manifest.data.chunks[0];
      return json({
        result: ids[0] === firstChunk.id
          ? [{ id: firstChunk.id, payload: firstChunk.payload }]
          : [],
      });
    },
  });

  assert.deepEqual(await client.getInstitutional(input.recordKey), failure("record_incomplete"));
});

test("a pre-aborted corpus request performs no fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async () => {
      calls += 1;
      return json({});
    },
  });
  assert.deepEqual(await client.status(controller.signal), failure("aborted"));
  assert.equal(calls, 0);
});

test("status fails closed for an unavailable Qdrant without exposing transport text", async () => {
  const secret = "token=operator-secret";
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async () => {
      throw new Error(secret);
    },
  });

  const result = await client.status();
  assert.deepEqual(result, failure("qdrant_unavailable", {
    operation: "qdrant_version",
    cause: "transport_other",
  }));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("status fails closed when the approved embedding model is absent", async () => {
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input) => {
      const request = new URL(String(input));
      if (request.hostname === "qdrant.test") return json({ version: "1.17.1" });
      if (request.hostname === "ollama.test") return json({ models: [] });
      throw new Error(`unexpected ${request}`);
    },
  });

  assert.deepEqual(await client.status(), failure("embedding_model_missing", {
    operation: "ollama_embedding_model",
    cause: "incompatible",
  }));
});

test("status fails closed for an incompatible collection vector configuration", async () => {
  const incompatible = collection();
  incompatible.result.config.params.vectors[VECTOR_NAME].size = VECTOR_SIZE - 1;
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input) => {
      const request = new URL(String(input));
      if (request.hostname === "qdrant.test" && request.pathname === "/") return json({ version: "1.17.1" });
      if (request.hostname === "ollama.test" && request.pathname === "/api/tags") return json(modelTags);
      if (request.hostname === "qdrant.test") return json(incompatible);
      throw new Error(`unexpected ${request}`);
    },
  });

  assert.deepEqual(await client.status(), failure("collection_incompatible", {
    operation: "institutional_collection",
    cause: "incompatible",
  }));
});

test("status rejects malformed and oversized Qdrant responses without exposing response text", async () => {
  const secret = "token=malformed-response";
  const responses = [
    () => new Response(secret, { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ version: "1.17.1" }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "1024" },
    }),
  ];

  for (const response of responses) {
    const client = createQdrantCorpusClient({
      env: environment,
      maxResponseBytes: 64,
      fetch: async () => response(),
    });
    const result = await client.status();
    assert.deepEqual(result, failure("response_invalid", {
      operation: "qdrant_version",
      cause: "invalid_response",
    }));
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("full retrieval rejects a corrupt immutable payload", async () => {
  const input = {
    recordKey: "ima-pi:plan:corrupt", project: "ima-pi", site: "", repo: "ima-pi", lifecycleKey: "life", phase: "plan", summary: "summary", detail: "exact full detail", sourceRefs: ["source"],
  };
  const normalized = normalizeInstitutionalRecord(input, "2026-08-25T00:00:00.000Z");
  assert.equal(normalized.success, true);
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (inputUrl) => {
      const request = new URL(String(inputUrl));
      if (request.pathname === "/collections/ima-institutional-memory/points") {
        return json({
          result: [{
            id: normalized.data.id,
            payload: { ...normalized.data.payload, content_hash: "b".repeat(64) },
          }],
        });
      }
      throw new Error(`unexpected ${request}`);
    },
  });

  assert.deepEqual(await client.getInstitutional(input.recordKey), failure("response_invalid"));
});

test("store defers bootstrap until validated absence and getPoint treats an absent collection as absent record", async () => {
  const calls = [];
  const tools = [];
  const client = fakeClient({
    getPoint: async () => { calls.push("get"); return success(null); },
    ensureCollection: async () => { calls.push("ensure"); return success({}); },
    embedSummary: async () => { calls.push("embed"); return success(vector()); },
    insertPoint: async () => { calls.push("insert"); return success(undefined); },
  });
  registerInstitutionalMemoryTools({ registerTool: (tool) => tools.push(tool) }, { client });
  await assert.rejects(
    tools[1].execute("store", {
      recordKey: "key", project: "ima-pi", site: "", repo: "ima-pi", lifecycleKey: "life", phase: "plan", summary: "é".repeat(1_001), detail: "detail",
    }, undefined),
    /record_too_large/,
  );
  assert.deepEqual(calls, []);

  const httpCalls = [];
  const httpClient = createQdrantCorpusClient({
    env: environment,
    fetch: async (input) => {
      const request = new URL(String(input));
      httpCalls.push(request.pathname);
      if (request.pathname === "/collections/ima-institutional-memory") return json({}, 404);
      throw new Error(`unexpected ${request}`);
    },
  });
  assert.deepEqual(await httpClient.getPoint("any-id"), success(null));
  assert.deepEqual(httpCalls, ["/collections/ima-institutional-memory"]);
});

test("find filters match schema bounds, empty values, and only fixed payload keys", async () => {
  const calls = [];
  const repository = "r".repeat(1_024);
  const point = institutionalPoint("filter-key", { repo: repository });
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: request.pathname, body });
      if (request.pathname === "/collections/ima-institutional-memory") return json(collection());
      if (request.pathname === "/api/tags") return json(modelTags);
      if (request.pathname === "/api/embed") return json({ embeddings: [vector()] });
      if (request.pathname.endsWith("/points/query")) return json({ result: { points: [{ ...point, score: 0.8 }] } });
      throw new Error(`unexpected ${request}`);
    },
  });

  const filtered = await client.findInstitutional({
    query: "evidence",
    limit: 1,
    filters: { project: "ima-pi", site: "", repo: repository },
  });
  assert.equal(filtered.success, true);
  const filter = calls.find((call) => call.path.endsWith("/points/query")).body.filter;
  assert.deepEqual(filter, {
    must: [
      { key: "project", match: { value: "ima-pi" } },
      { key: "site", match: { value: "" } },
      { key: "repo", match: { value: repository } },
    ],
    must_not: [{ key: "record_kind", match: { value: "detail_chunk" } }],
  });

  let invalidCalls = 0;
  const invalidClient = createQdrantCorpusClient({
    env: environment,
    fetch: async () => { invalidCalls += 1; return json({}); },
  });
  assert.deepEqual(
    await invalidClient.findInstitutional({ query: "evidence", limit: 1, filters: { site: "bad\nsite" } }),
    failure("record_invalid"),
  );
  assert.deepEqual(
    await invalidClient.findInstitutional({ query: "evidence", limit: 1, filters: { other: "value" } }),
    failure("record_invalid"),
  );
  assert.equal(invalidCalls, 0);
});

test("find and recall tool output fails closed instead of exceeding Pi's output ceiling", async () => {
  const oversizedResults = Array.from({ length: 20 }, (_, index) => ({
    id: `point-${index}`,
    recordKey: `record-${index}`,
    project: "p".repeat(256),
    site: "s".repeat(256),
    repo: "r".repeat(1_024),
    lifecycleKey: "l".repeat(512),
    phase: "x".repeat(128),
    summary: "q".repeat(60_000),
    score: 0.5,
  }));
  const tools = [];
  registerInstitutionalMemoryTools({ registerTool: (tool) => tools.push(tool) }, {
    client: fakeClient({ findInstitutional: async () => success(oversizedResults) }),
  });

  await assert.rejects(
    tools[2].execute("find", { query: "evidence" }, undefined),
    /record_too_large/,
  );
});
