import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import integrations, {
  coordinateContext,
  coordinateLifecycle,
  recallCorpusLifecycle,
} from "../extensions/integrations.ts";
import {
  VECTOR_SIZE,
  corpusFailure,
  detailChunkIds,
  deriveRecordId,
  normalizeInstitutionalManifestPoint,
  reassembleInstitutionalManifest,
  storeInstitutionalManifest,
} from "../lib/qdrant-corpus.ts";

const success = (data) => ({ success: true, data });
const failure = (code) => corpusFailure(code);
const lifecycleKey = "ima-pi:taskwarrior:ima-pi:a6264cf5-82a1-49c5-9ea1-8a39b3b1405a";
const identity = {
  project: "ima-pi",
  lifecycleKey,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "ima-pi",
  taskwarriorTask: "39",
  taskwarriorUuid: "a6264cf5-82a1-49c5-9ea1-8a39b3b1405a",
  jiraKey: "",
  sourceRefs: ["taskwarrior:ima-pi:a6264cf5-82a1-49c5-9ea1-8a39b3b1405a"],
  priorArtifactIds: ["docs/decisions/plan.md"],
};
const vector = () => Array.from({ length: VECTOR_SIZE }, () => 0.25);

const fullRecord = (record) => ({
  id: record.id,
  recordKey: record.recordKey,
  project: record.payload.project,
  site: record.payload.site,
  repo: record.payload.repo,
  lifecycleKey: record.payload.lifecycle_key,
  phase: record.payload.phase,
  summary: record.payload.summary,
  detail: record.detail,
  sourceRefs: [...record.payload.source_refs],
  contentHash: record.payload.content_hash,
  createdAt: record.payload.created_at,
});

const createCorpus = (overrides = {}) => {
  const points = new Map();
  const client = {
    points,
    status: async () => success({ status: "ready", qdrantVersion: "1.17.1", collection: "ready", missingIndexes: [] }),
    ensureCollection: async () => success(undefined),
    getPoints: async (ids) => success(ids.flatMap((id) => points.has(id) ? [points.get(id)] : [])),
    getPoint: async (id) => success(points.has(id)
      ? { id, recordKey: points.get(id).payload.record_key, contentHash: points.get(id).payload.content_hash }
      : null),
    embedSummary: async () => success(vector()),
    insertPoints: async ({ points: inserted }) => {
      for (const point of inserted) {
        if (points.has(point.id)) return failure("record_conflict");
        points.set(point.id, { id: point.id, payload: point.payload });
      }
      return success(undefined);
    },
    insertPoint: async ({ record, vector: embedded }) => {
      if (!Array.isArray(embedded) || embedded.length !== VECTOR_SIZE) return failure("embedding_dimension_mismatch");
      if (points.has(record.id)) return failure("record_conflict");
      points.set(record.id, { id: record.id, payload: record.payload });
      return success(undefined);
    },
    findInstitutional: async () => success([]),
    recallInstitutional: async ({ lifecycleKey: expected, phase }) => {
      const summaries = [...points.values()]
        .filter(({ payload }) => payload.schema_version === 2
          && payload.record_kind === "manifest"
          && payload.lifecycle_key === expected
          && (phase === undefined || payload.phase === phase))
        .map(({ id, payload }) => ({
          id,
          recordKey: payload.record_key,
          project: payload.project,
          site: payload.site,
          repo: payload.repo,
          lifecycleKey: payload.lifecycle_key,
          phase: payload.phase,
          summary: payload.summary,
        }));
      return success(summaries);
    },
    getInstitutional: async (recordKey) => {
      const id = deriveRecordId(recordKey);
      if (!id.success || !points.has(id.data)) return failure("record_not_found");
      const manifestPoint = points.get(id.data);
      const manifest = normalizeInstitutionalManifestPoint(manifestPoint);
      if (!manifest.success) return manifest;
      const chunks = detailChunkIds(manifest.data.recordKey, manifest.data.payload.chunk_count)
        .flatMap((chunkId) => points.has(chunkId) ? [points.get(chunkId)] : []);
      const record = reassembleInstitutionalManifest({ manifestPoint, chunkPoints: chunks });
      return record.success ? success(fullRecord(record.data)) : record;
    },
    findKnowledge: async () => success([]),
    ...overrides,
  };
  return client;
};

const direct = (result) => ({ content: [{ type: "text", text: result }] });
const standardMemories = ["core", "conventions", "tech_stack", "suggested_commands", "task_completion"];

const serenaSession = (calls = []) => async (server, callback) => {
  assert.equal(server, "serena");
  return callback(async (name, args) => {
    calls.push([server, name, args]);
    if (name === "activate_project") return direct("activated");
    if (name === "initial_instructions") return direct("instructions");
    if (name === "list_memories") return direct(JSON.stringify({ memories: standardMemories }));
    if (name === "read_memory") return direct(`${args.memory_name} memory`);
    throw new Error(`unexpected Serena call ${name}`);
  });
};

const seedLifecycleRecord = async (corpus, detail, phase = "plan", suffix = "seed") => {
  const stored = await storeInstitutionalManifest({
    record: {
      recordKey: `${lifecycleKey}:${phase}:${suffix}`,
      project: "ima-pi",
      site: "",
      repo: "ima-pi",
      lifecycleKey,
      phase,
      summary: "Approved lifecycle artifact available for direct corpus retrieval.",
      detail,
      sourceRefs: identity.sourceRefs,
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    operations: corpus,
  });
  assert.equal(stored.success, true);
  return stored.data;
};

test("registers strict lifecycle summary schema alongside Serena-first context", () => {
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const context = tools.find((tool) => tool.name === "ima_context");
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");

  assert.ok(context);
  assert.ok(lifecycle);
  assert.equal(Check(lifecycle.parameters, {
    type: "implementation",
    identity,
    summary: "Completed implementation.",
    artifact: "Detailed artifact",
  }), true);
  assert.equal(Check(lifecycle.parameters, {
    type: "implementation",
    identity,
    artifact: "Detailed artifact",
  }), false);
  assert.equal(Check(lifecycle.parameters, {
    type: "implementation",
    identity,
    summary: "Completed implementation.",
    artifact: "Detailed artifact",
    extra: true,
  }), false);
  assert.equal(Check(lifecycle.parameters, {
    type: "implementation",
    identity: { ...identity, extra: "forbidden" },
    summary: "Completed implementation.",
    artifact: "Detailed artifact",
  }), false);
  assert.equal(Check(lifecycle.parameters, {
    type: "implementation",
    identity: { ...identity, lifecycleKey: "bad\nkey" },
    summary: "Completed implementation.",
    artifact: "Detailed artifact",
  }), false);
});

test("context hydrates an exact lifecycle source through corpus summary recall and direct detail retrieval", async () => {
  const corpus = createCorpus();
  const marker = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=${identity.taskwarriorUuid}; outcome=completed -->`;
  const detail = `# Plan\n\n${marker}\n`;
  const stored = await seedLifecycleRecord(corpus, detail);
  const calls = [];

  const result = await coordinateContext(
    { source: { type: "lifecycle", key: lifecycleKey } },
    "/repo",
    { canonical: async (path) => path, session: serenaSession(calls), corpus },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(result.source, {
    type: "lifecycle",
    key: lifecycleKey,
    title: `Lifecycle ${lifecycleKey}`,
    content: detail,
    references: [`Lifecycle:${lifecycleKey}`, `Qdrant:${stored.id}`],
  });
  assert.equal(calls.every(([server]) => server === "serena"), true);
});

test("corpus lifecycle reconciliation adapts verified direct detail to the existing cycle envelope", async () => {
  const corpus = createCorpus();
  const marker = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=${identity.taskwarriorUuid}; outcome=completed -->`;
  await seedLifecycleRecord(corpus, `# Plan\n${marker}\n`);

  const recalled = await recallCorpusLifecycle(`${lifecycleKey} plan`, corpus);
  assert.equal(Array.isArray(recalled.structuredContent.results), true);
  assert.equal(recalled.structuredContent.results.length, 1);
  assert.match(recalled.structuredContent.results[0].content, /outcome=completed/);
  assert.equal(await recallCorpusLifecycle("malformed", corpus), null);
});

test("cycle reconciliation filters lifecycle recall by phase before the bounded limit", async () => {
  const corpus = createCorpus();
  for (let index = 0; index < 10; index += 1) {
    await seedLifecycleRecord(corpus, `# Plan ${index}`, "plan", `plan-${index}`);
  }
  const target = await seedLifecycleRecord(
    corpus,
    `# Review\n<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=review; jira_key=; taskwarrior_uuid=${identity.taskwarriorUuid}; outcome=completed -->`,
    "review",
    "review-target",
  );
  const calls = [];
  const recallInstitutional = corpus.recallInstitutional;
  corpus.recallInstitutional = async (input) => {
    calls.push(input);
    return recallInstitutional(input);
  };

  const recalled = await recallCorpusLifecycle(`${lifecycleKey} review`, corpus);
  assert.deepEqual(calls, [{ lifecycleKey, phase: "review", limit: 10 }]);
  assert.deepEqual(recalled.structuredContent.results.map(({ id }) => id), [target.id]);
});

test("lifecycle persists a manifest and vectorless chunks, then directly verifies its reassembled detail without Vestige", async () => {
  const corpus = createCorpus();
  const result = await coordinateLifecycle({
    type: "implementation",
    identity,
    summary: "Implementation moved lifecycle persistence to the Tier-1 corpus.",
    artifact: "# Implementation\n\nQdrant now owns lifecycle artifacts.",
  }, {
    corpus,
    now: () => new Date("2026-08-27T00:00:00.000Z"),
    session: async () => { throw new Error("Vestige lifecycle access is forbidden"); },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.receiptAccepted, true);
  assert.equal(result.semanticRecall.matched, true);
  const stored = [...corpus.points.values()];
  assert.equal(stored.filter(({ payload }) => payload.record_kind === "manifest").length, 1);
  assert.equal(stored.filter(({ payload }) => payload.record_kind === "detail_chunk").length, 1);
  assert.equal(stored.every(({ payload }) => payload.record_kind === "manifest" || payload.record_kind === "detail_chunk"), true);
});

test("lifecycle retries keep a deterministic manifest identity and reuse orphan chunks", async () => {
  const corpus = createCorpus();
  const request = {
    type: "implementation",
    identity,
    summary: "Deterministic retries reuse the same immutable lifecycle identity.",
    artifact: "# Implementation\n\nDeterministic persistence.",
  };
  const options = { corpus, now: () => new Date("2026-08-27T00:00:00.000Z") };
  const first = await coordinateLifecycle(request, options);
  const pointCount = corpus.points.size;
  const second = await coordinateLifecycle(request, options);

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(first.artifactId, second.artifactId);
  assert.equal(corpus.points.size, pointCount);

  const changedSummary = await coordinateLifecycle({
    ...request,
    summary: "A changed summary conflicts with the same immutable detail key.",
  }, options);
  assert.equal(changedSummary.status, "failed");
  assert.equal(changedSummary.error.code, "record_conflict");

  let failManifest = true;
  const retryCorpus = createCorpus();
  const insertPoints = retryCorpus.insertPoints;
  retryCorpus.insertPoints = async (input) => {
    if (input.points[0].payload.record_kind === "manifest" && failManifest) {
      return failure("store_failed");
    }
    return insertPoints(input);
  };
  const interrupted = await coordinateLifecycle(request, {
    corpus: retryCorpus,
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });
  assert.equal(interrupted.error.code, "manifest_store_failed");
  assert.equal([...retryCorpus.points.values()].every(({ payload }) => payload.record_kind === "detail_chunk"), true);

  failManifest = false;
  const retried = await coordinateLifecycle(request, {
    corpus: retryCorpus,
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });
  assert.equal(retried.status, "completed");
  assert.equal(retried.artifactId, first.artifactId);
});

test("lifecycle stores artifacts over 44 KB as multiple vectorless chunks and reassembles them exactly", async () => {
  const corpus = createCorpus();
  const artifact = `# Implementation\n\n${"é".repeat(30_000)}`;
  const result = await coordinateLifecycle({
    type: "implementation",
    identity,
    summary: "Large multibyte lifecycle artifact was stored and directly verified.",
    artifact,
  }, { corpus, now: () => new Date("2026-08-27T00:00:00.000Z") });

  assert.equal(result.status, "completed");
  const manifests = [...corpus.points.values()].filter(({ payload }) => payload.record_kind === "manifest");
  const chunks = [...corpus.points.values()].filter(({ payload }) => payload.record_kind === "detail_chunk");
  assert.equal(manifests.length, 1);
  assert.equal(chunks.length > 1, true);
  const full = await corpus.getInstitutional(manifests[0].payload.record_key);
  assert.equal(full.success, true);
  assert.match(full.data.detail, /é{100}/);
});

test("lifecycle rejects missing summaries and request-bound violations before corpus effects", async () => {
  const corpus = createCorpus({
    getPoints: async () => { throw new Error("must not read corpus"); },
  });
  const missingSummary = await coordinateLifecycle({
    type: "implementation",
    identity,
    artifact: "artifact",
  }, { corpus });
  assert.equal(missingSummary.status, "failed");
  assert.equal(missingSummary.error.code, "invalid_lifecycle_summary");

  const oversized = await coordinateLifecycle({
    type: "implementation",
    identity,
    summary: "Oversized request is rejected before corpus I/O.",
    artifact: "x".repeat(128_001),
  }, { corpus });
  assert.equal(oversized.status, "failed");
  assert.equal(oversized.error.code, "invalid_lifecycle_request");

  for (const invalidIdentity of [
    { ...identity, extra: "forbidden" },
    { ...identity, lifecycleKey: "bad\nkey" },
    { ...identity, lifecycleKey: "l".repeat(512) },
    { ...identity, sourceRefs: ["x".repeat(1_025)] },
  ]) {
    const invalid = await coordinateLifecycle({
      type: "implementation",
      identity: invalidIdentity,
      summary: "Invalid identities are rejected before corpus I/O.",
      artifact: "artifact",
    }, { corpus });
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.error.code, "invalid_lifecycle_request");
  }

  const projectedOversize = await coordinateLifecycle({
    type: "implementation",
    identity,
    summary: "Projected oversized persistence is rejected before corpus I/O.",
    artifact: "é".repeat(80_000),
  }, { corpus });
  assert.equal(projectedOversize.status, "failed");
  assert.equal(projectedOversize.error.code, "lifecycle_artifact_too_large");
});

test("lifecycle fails closed on chunk-store errors without a Vestige fallback", async () => {
  const corpus = createCorpus({ insertPoints: async () => failure("store_failed") });
  const result = await coordinateLifecycle({
    type: "implementation",
    identity,
    summary: "Chunk-store failure must block lifecycle completion.",
    artifact: "artifact",
  }, {
    corpus,
    session: async () => { throw new Error("Vestige fallback is forbidden"); },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "chunk_store_failed");
  assert.equal(result.receiptAccepted, false);
});
