import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareLifecycleArtifact,
  validateLifecycleRequest,
} from "../lib/ima-lifecycle.ts";
import {
  VECTOR_NAME,
  VECTOR_SIZE,
  corpusFailure,
  normalizeInstitutionalManifest,
  normalizeInstitutionalRecord,
} from "../lib/qdrant-corpus.ts";
import { createQdrantCorpusClient } from "../lib/qdrant-http.ts";
import { createQdrantLifecycleProvider } from "../lib/qdrant-lifecycle.ts";

const createdAt = "2026-09-12T02:00:00.000Z";
const lifecycleKey = "ima-pi:plane:ima:SKYNET-211";
const environment = {
  IMA_QDRANT_URL: "http://qdrant.test",
  IMA_OLLAMA_URL: "http://ollama.test",
};
const identity = {
  project: "ima-pi",
  lifecycleKey,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  planeWorkspace: "ima",
  planeWorkItem: "SKYNET-211",
  sourceRefs: ["plane:ima:SKYNET-211"],
  priorArtifactIds: [],
};

const success = (data) => ({ success: true, data });
const failure = (code) => corpusFailure(code);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const collection = () => ({
  result: {
    config: {
      params: {
        vectors: {
          [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" },
        },
      },
    },
    payload_schema: Object.fromEntries(
      ["lifecycle_key", "phase", "project", "site", "repo", "record_kind", "parent_record_key"]
        .map((field) => [field, { data_type: "keyword" }]),
    ),
  },
});

const makeStored = ({ schemaVersion, artifact, summary }) => {
  const request = {
    type: "plan",
    identity,
    summary,
    artifact,
  };
  const valid = validateLifecycleRequest(request);
  assert.equal(valid.valid, true);
  const preparation = prepareLifecycleArtifact(valid);
  assert.equal(preparation.valid, true);
  const input = {
    recordKey: preparation.data.recordKey,
    project: identity.project,
    site: "",
    repo: "ima-pi",
    lifecycleKey,
    phase: "plan",
    summary,
    detail: preparation.data.artifact,
    sourceRefs: identity.sourceRefs,
  };
  const normalized = schemaVersion === 1
    ? normalizeInstitutionalRecord(input, createdAt)
    : normalizeInstitutionalManifest(input, createdAt);
  assert.equal(normalized.success, true);
  const points = schemaVersion === 1
    ? [{ id: normalized.data.id, payload: normalized.data.payload }]
    : [
      { id: normalized.data.id, payload: normalized.data.payload },
      ...normalized.data.chunks.map((chunk) => ({ id: chunk.id, payload: chunk.payload })),
    ];
  const payload = normalized.data.payload;
  return {
    points,
    summaryPoint: points[0],
    full: {
      id: normalized.data.id,
      recordKey: normalized.data.recordKey,
      project: payload.project,
      site: payload.site,
      repo: payload.repo,
      lifecycleKey: payload.lifecycle_key,
      phase: payload.phase,
      summary: payload.summary,
      detail: schemaVersion === 1 ? payload.detail : preparation.data.artifact,
      sourceRefs: [...payload.source_refs],
      contentHash: payload.content_hash,
      createdAt: payload.created_at,
    },
  };
};

const pointMap = (points) => new Map(points.map((point) => [
  point.id,
  structuredClone(point),
]));

const createHttpCorpus = ({
  summaryPoints,
  points,
  onScroll,
  scrollResponse,
  scrollResponseText,
}) => {
  const calls = { collection: 0, scroll: [], direct: [] };
  const client = createQdrantCorpusClient({
    env: environment,
    fetch: async (input, init = {}) => {
      const request = new URL(String(input));
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (
        request.pathname === "/collections/ima-institutional-memory"
        && method === "GET"
      ) {
        calls.collection += 1;
        return json(collection());
      }
      if (
        request.pathname === "/collections/ima-institutional-memory/points/scroll"
        && method === "POST"
      ) {
        calls.scroll.push(body);
        onScroll?.();
        if (scrollResponseText !== undefined) {
          return new Response(scrollResponseText, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return json(scrollResponse ?? {
          result: {
            points: summaryPoints.map((point) => structuredClone(point)),
            next_page_offset: null,
          },
        });
      }
      if (
        request.pathname === "/collections/ima-institutional-memory/points"
        && method === "POST"
      ) {
        const ids = body.ids;
        calls.direct.push([...ids]);
        return json({
          result: ids.flatMap((id) => points.has(id) ? [structuredClone(points.get(id))] : []),
        });
      }
      throw new Error(`unexpected ${method} ${request}`);
    },
  });
  return { client, calls };
};

test("lifecycle recall uses exact filters and direct full reads while public recall stays summary-only", async () => {
  const v1 = makeStored({
    schemaVersion: 1,
    summary: "Schema-v1 lifecycle evidence.",
    artifact: "# Plan\n\nSchema-v1 evidence.",
  });
  const v2 = makeStored({
    schemaVersion: 2,
    summary: "Schema-v2 lifecycle evidence.",
    artifact: "# Plan\n\nSchema-v2 evidence.",
  });
  const corpus = createHttpCorpus({
    summaryPoints: [v1.summaryPoint, v2.summaryPoint],
    points: pointMap([...v1.points, ...v2.points]),
  });
  const selection = { lifecycleKey, phase: "plan", limit: 2 };

  const publicRecall = await corpus.client.recallInstitutional(selection);
  assert.equal(publicRecall.success, true);
  assert.deepEqual(publicRecall.data.map(({ id, recordKey, summary }) => ({ id, recordKey, summary })), [
    { id: v1.full.id, recordKey: v1.full.recordKey, summary: v1.full.summary },
    { id: v2.full.id, recordKey: v2.full.recordKey, summary: v2.full.summary },
  ]);
  assert.equal(publicRecall.data.every((record) => !Object.hasOwn(record, "detail")), true);
  assert.deepEqual(corpus.calls.direct, []);

  corpus.calls.scroll.length = 0;
  const lifecycleRecall = await corpus.client.recallLifecycleInstitutional(selection);
  assert.equal(lifecycleRecall.success, true);
  assert.deepEqual(lifecycleRecall.data, [v1.full, v2.full]);
  assert.deepEqual(corpus.calls.scroll[0], {
    filter: {
      must: [
        { key: "lifecycle_key", match: { value: lifecycleKey } },
        { key: "phase", match: { value: "plan" } },
      ],
      must_not: [{ key: "record_kind", match: { value: "detail_chunk" } }],
    },
    limit: 2,
    with_payload: { exclude: ["detail", "detail_chunk"] },
    with_vector: false,
  });
  assert.deepEqual(corpus.calls.direct.flat(), [
    v1.full.id,
    ...v2.points.map((point) => point.id),
  ]);
  assert.equal(corpus.calls.direct.every((ids) => ids.length === 1), true);
});

test("lifecycle recall accepts terminal scroll pages at zero, fewer-than-limit, and exactly-limit", async () => {
  const v1 = makeStored({
    schemaVersion: 1,
    summary: "Terminal scroll lifecycle evidence.",
    artifact: "# Plan\n\nTerminal scroll evidence.",
  });
  const cases = [
    { label: "zero points", limit: 2, summaryPoints: [], expected: [], directReads: 0 },
    { label: "fewer-than-limit points", limit: 2, summaryPoints: [v1.summaryPoint], expected: [v1.full], directReads: 1 },
    { label: "exactly-limit points", limit: 1, summaryPoints: [v1.summaryPoint], expected: [v1.full], directReads: 1 },
  ];

  for (const item of cases) {
    const corpus = createHttpCorpus({
      summaryPoints: item.summaryPoints,
      points: pointMap(v1.points),
    });
    const result = await corpus.client.recallLifecycleInstitutional({
      lifecycleKey,
      phase: "plan",
      limit: item.limit,
    });

    assert.equal(result.success, true, item.label);
    assert.deepEqual(result.data, item.expected, item.label);
    assert.equal(corpus.calls.scroll.length, 1, item.label);
    assert.equal(corpus.calls.direct.length, item.directReads, item.label);
  }
});

test("lifecycle recall completes 49 and exactly 50 terminal records at the lifecycle cap", async () => {
  const recordsFor = (count) => Array.from({ length: count }, (_unused, index) => makeStored({
    schemaVersion: 1,
    summary: `Terminal lifecycle evidence ${index + 1}.`,
    artifact: `# Plan\n\nTerminal lifecycle evidence ${index + 1}.`,
  }));

  for (const count of [49, 50]) {
    const records = recordsFor(count);
    const corpus = createHttpCorpus({
      summaryPoints: records.map((record) => record.summaryPoint),
      points: pointMap(records.flatMap((record) => record.points)),
    });
    const result = await corpus.client.recallLifecycleInstitutional({
      lifecycleKey,
      phase: "plan",
      limit: 50,
    });

    assert.equal(result.success, true, String(count));
    if (!result.success) continue;
    assert.equal(result.data.length, count, String(count));
    assert.equal(corpus.calls.scroll[0].limit, 50, String(count));
    assert.equal(corpus.calls.direct.length, count, String(count));
  }
});

test("lifecycle recall requires terminal scroll completeness before direct detail reads", async () => {
  const v1 = makeStored({
    schemaVersion: 1,
    summary: "Scroll completeness lifecycle evidence.",
    artifact: "# Plan\n\nScroll completeness evidence.",
  });
  const cases = [
    {
      label: "non-null string continuation on a fewer-than-limit page",
      limit: 2,
      scrollResponse: { result: { points: [v1.summaryPoint], next_page_offset: "next-page" } },
      code: "lifecycle_scroll_non_terminal",
    },
    {
      label: "non-null numeric continuation at the limit",
      limit: 1,
      scrollResponse: { result: { points: [v1.summaryPoint], next_page_offset: 1 } },
      code: "lifecycle_scroll_non_terminal",
    },
    {
      label: "missing continuation metadata on a zero-point page",
      limit: 3,
      scrollResponse: { result: { points: [] } },
      code: "response_invalid",
    },
    {
      label: "malformed continuation metadata at the limit",
      limit: 1,
      scrollResponse: { result: { points: [v1.summaryPoint], next_page_offset: false } },
      code: "response_invalid",
    },
  ];

  for (const item of cases) {
    const corpus = createHttpCorpus({
      summaryPoints: [],
      points: pointMap(v1.points),
      scrollResponse: item.scrollResponse,
    });
    const result = await corpus.client.recallLifecycleInstitutional({
      lifecycleKey,
      phase: "plan",
      limit: item.limit,
    });

    assert.deepEqual(result, failure(item.code), item.label);
    assert.equal(corpus.calls.scroll.length, 1, item.label);
    assert.deepEqual(corpus.calls.direct, [], item.label);
  }
});

test("lifecycle recall blocks a continuation past fifty records before direct detail reads", async () => {
  const records = Array.from({ length: 50 }, (_unused, index) => makeStored({
    schemaVersion: 1,
    summary: `Overflow lifecycle evidence ${index + 1}.`,
    artifact: `# Plan\n\nOverflow lifecycle evidence ${index + 1}.`,
  }));
  const corpus = createHttpCorpus({
    summaryPoints: [],
    points: pointMap([]),
    scrollResponse: {
      result: {
        points: records.map((record) => record.summaryPoint),
        next_page_offset: "record-51",
      },
    },
  });

  const result = await corpus.client.recallLifecycleInstitutional({
    lifecycleKey,
    phase: "plan",
    limit: 50,
  });

  assert.deepEqual(result, failure("lifecycle_scroll_non_terminal"));
  assert.deepEqual(corpus.calls.direct, []);
});

test("lifecycle recall rejects accessor-backed continuation metadata before direct reads", async () => {
  const v1 = makeStored({
    schemaVersion: 1,
    summary: "Accessor-backed scroll lifecycle evidence.",
    artifact: "# Plan\n\nAccessor-backed scroll evidence.",
  });
  const scrollResponseText = "accessor-backed-scroll-response";
  let accessorReads = 0;
  const scroll = { points: [structuredClone(v1.summaryPoint)] };
  Object.defineProperty(scroll, "next_page_offset", {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      return null;
    },
  });
  const originalParse = JSON.parse;
  JSON.parse = (value, reviver) => value === scrollResponseText
    ? { result: scroll }
    : originalParse(value, reviver);

  try {
    const corpus = createHttpCorpus({
      summaryPoints: [],
      points: pointMap(v1.points),
      scrollResponseText,
    });
    const result = await corpus.client.recallLifecycleInstitutional({
      lifecycleKey,
      phase: "plan",
      limit: 1,
    });

    assert.deepEqual(result, failure("response_invalid"));
    assert.equal(accessorReads, 0);
    assert.deepEqual(corpus.calls.direct, []);
  } finally {
    JSON.parse = originalParse;
  }
});

test("lifecycle recall rejects invalid selections and honours pre- and mid-operation cancellation", async () => {
  const v1 = makeStored({
    schemaVersion: 1,
    summary: "Cancellation lifecycle evidence.",
    artifact: "# Plan\n\nCancellation evidence.",
  });
  const invalidCorpus = createHttpCorpus({ summaryPoints: [], points: pointMap([]) });
  assert.deepEqual(
    await invalidCorpus.client.recallLifecycleInstitutional({ lifecycleKey, limit: 0 }),
    failure("record_invalid"),
  );
  assert.deepEqual(invalidCorpus.calls, { collection: 0, scroll: [], direct: [] });

  const preAborted = new AbortController();
  preAborted.abort();
  const preAbortedCorpus = createHttpCorpus({
    summaryPoints: [v1.summaryPoint],
    points: pointMap(v1.points),
  });
  assert.deepEqual(
    await preAbortedCorpus.client.recallLifecycleInstitutional(
      { lifecycleKey, phase: "plan", limit: 1 },
      preAborted.signal,
    ),
    failure("aborted"),
  );
  assert.deepEqual(preAbortedCorpus.calls, { collection: 0, scroll: [], direct: [] });

  const midOperation = new AbortController();
  const midOperationCorpus = createHttpCorpus({
    summaryPoints: [v1.summaryPoint],
    points: pointMap(v1.points),
    onScroll: () => midOperation.abort(),
  });
  assert.deepEqual(
    await midOperationCorpus.client.recallLifecycleInstitutional(
      { lifecycleKey, phase: "plan", limit: 1 },
      midOperation.signal,
    ),
    failure("aborted"),
  );
  assert.deepEqual(midOperationCorpus.calls.direct, []);
});

test("lifecycle recall fails closed for incomplete, duplicate, corrupt, and inconsistent history", async () => {
  const v1 = makeStored({
    schemaVersion: 1,
    summary: "Original schema-v1 history.",
    artifact: "# Plan\n\nShared immutable history.",
  });
  const changedSummary = makeStored({
    schemaVersion: 1,
    summary: "Changed schema-v1 history summary.",
    artifact: "# Plan\n\nShared immutable history.",
  });
  const v2 = makeStored({
    schemaVersion: 2,
    summary: "Schema-v2 history with chunks.",
    artifact: `# Plan\n\n${"x".repeat(40_000)}`,
  });
  assert.equal(v1.full.id, changedSummary.full.id);
  const corruptPoint = structuredClone(v1.summaryPoint);
  corruptPoint.payload.content_hash = "a".repeat(64);
  const cases = [
    {
      label: "incomplete schema-v2 chunks",
      summaryPoints: [v2.summaryPoint],
      points: pointMap([v2.summaryPoint]),
      code: "record_incomplete",
    },
    {
      label: "duplicate manifest history",
      summaryPoints: [v1.summaryPoint, v1.summaryPoint],
      points: pointMap(v1.points),
      code: "response_invalid",
    },
    {
      label: "corrupt direct record",
      summaryPoints: [v1.summaryPoint],
      points: pointMap([corruptPoint]),
      code: "response_invalid",
    },
    {
      label: "summary and direct detail disagreement",
      summaryPoints: [v1.summaryPoint],
      points: pointMap(changedSummary.points),
      code: "response_invalid",
    },
  ];

  for (const item of cases) {
    const corpus = createHttpCorpus(item);
    const result = await corpus.client.recallLifecycleInstitutional({
      lifecycleKey,
      phase: "plan",
      limit: 2,
    });
    assert.deepEqual(result, failure(item.code), item.label);
  }
});

test("provider surfaces unverifiable direct lifecycle history as blocked without repair", async () => {
  const v2 = makeStored({
    schemaVersion: 2,
    summary: "Incomplete provider recall evidence.",
    artifact: `# Plan\n\n${"x".repeat(40_000)}`,
  });
  const corpus = createHttpCorpus({
    summaryPoints: [v2.summaryPoint],
    points: pointMap([v2.summaryPoint]),
  });
  const provider = createQdrantLifecycleProvider({ client: corpus.client });
  const result = await provider.recall({ lifecycleKey, phase: "plan", limit: 1 });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "record_incomplete");
  assert.notEqual(result.code, "lifecycle_provider_recall_overflow");
  assert.equal(corpus.calls.direct.length > 0, true);
});
