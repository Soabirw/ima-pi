import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import integrations, {
  coordinateContext,
  coordinateLifecycle,
  recallCorpusLifecycle,
  recallLifecycle,
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
import {
  prepareLifecycleArtifact,
  validateLifecycleRequest,
} from "../lib/ima-lifecycle.ts";
import {
  abandonLifecyclePinAttemptWith,
  beginLifecyclePinWith,
  confirmLifecyclePinWith,
  loadLifecyclePinStateWith,
  markLifecyclePinAttemptWritingWith,
} from "../lib/ima-lifecycle-pin-store.ts";
import {
  createLifecycleProviderPin,
  createLifecycleProviderPinAttempt,
} from "../lib/ima-lifecycle-pin.ts";
import { createLifecycleRouting } from "../lib/ima-lifecycle-routing.ts";

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
const planeSource = { type: "plane", workspace: "IMA", project: "ERIC", sequenceId: 1 };
const planeRequest = { source: planeSource };
const planeHelperResult = (overrides = {}) => ({
  success: true,
  data: {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    reference: "plane:IMA:ERIC-1",
    workspace: "IMA",
    identifier: "ERIC-1",
    sequenceId: 1,
    name: "Plane item",
    description: "Hydrated description",
    stateId: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  },
});
const sourceBoundaryDiagnostic = {
  code: "source_boundary_unavailable",
  stage: "source",
  message: "Source hydration did not return usable content.",
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

const seedHistoricalCloseoutDocument = async (corpus, outcome = "READY") => {
  const request = {
    type: "closeout",
    identity,
    summary: "Historical documentation evidence predates the document lifecycle phase.",
    artifact: [
      "# Historical documentation",
      "",
      "This immutable closeout record predates first-class document persistence.",
      "",
      `<!-- ima-cycle outcome: phase=document; outcome=${outcome} -->`,
    ].join("\n"),
  };
  const valid = validateLifecycleRequest(request);
  assert.equal(valid.valid, true);
  const prepared = prepareLifecycleArtifact(valid);
  assert.equal(prepared.valid, true);
  const stored = await storeInstitutionalManifest({
    record: {
      recordKey: prepared.data.recordKey,
      project: identity.project,
      site: "",
      repo: "ima-pi",
      lifecycleKey,
      phase: "closeout",
      summary: valid.summary,
      detail: prepared.data.artifact,
      sourceRefs: identity.sourceRefs,
    },
    createdAt: "2026-09-21T00:00:00.000Z",
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
  assert.equal(Check(context.parameters, {
    source: { type: "plane", workspace: "IMA", project: "ERIC", sequenceId: 1 },
  }), true);
  assert.equal(Check(context.parameters, {
    source: { type: "plane", workspace: "IMA", project: "ERIC", sequenceId: 0 },
  }), false);
  assert.equal(Check(context.parameters, {
    source: { type: "plane", workspace: "W".repeat(1_025), project: "ERIC", sequenceId: 1 },
  }), false);
  assert.equal(Check(context.parameters, {
    source: { type: "plane", workspace: "IMA", project: "P".repeat(1_025), sequenceId: 1 },
  }), false);
  assert.equal(Check(lifecycle.parameters, {
    type: "implementation",
    identity,
    summary: "Completed implementation.",
    artifact: "Detailed artifact",
  }), true);
  assert.equal(Check(lifecycle.parameters, {
    type: "implementation",
    identity: { ...identity, planeWorkspace: "IMA", planeWorkItem: "ERIC-1" },
    summary: "Completed implementation.",
    artifact: "Detailed artifact",
  }), true);
  assert.equal(Check(lifecycle.parameters, {
    type: "implementation",
    identity: { ...identity, planeWorkspace: "", planeWorkItem: "" },
    summary: "Completed implementation.",
    artifact: "Detailed artifact",
  }), true);
  for (const invalidPlaneIdentity of [
    { ...identity, planeWorkspace: "IMA; plane_workspace=other", planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "eric-1" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "ERIC-0" },
  ]) {
    assert.equal(Check(lifecycle.parameters, {
      type: "implementation",
      identity: invalidPlaneIdentity,
      summary: "Completed implementation.",
      artifact: "Detailed artifact",
    }), false);
  }
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

test("lifecycle rejects incomplete or noncanonical Plane identity before corpus effects", async () => {
  const invalidPlaneIdentities = [
    { ...identity, planeWorkspace: "IMA" },
    { ...identity, planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "" },
    { ...identity, planeWorkItem: "" },
    { ...identity, planeWorkspace: "", planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "" },
    { ...identity, planeWorkspace: "IMA; plane_workspace=other", planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "IMA -->", planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "eric-1" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "ERIC-0" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "ERIC-9007199254740992" },
  ];
  let corpusAccesses = 0;
  const corpus = new Proxy({}, {
    get: () => {
      corpusAccesses += 1;
      return undefined;
    },
  });

  for (const invalidPlaneIdentity of invalidPlaneIdentities) {
    const result = await coordinateLifecycle({
      type: "implementation",
      identity: invalidPlaneIdentity,
      summary: "Invalid Plane identity must not persist.",
      artifact: "# Invalid Plane identity",
    }, { corpus });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "invalid_lifecycle_request");
  }
  assert.equal(corpusAccesses, 0);
});

test("context rejects oversized Plane sources before any boundary effect", async () => {
  const calls = { canonical: 0, session: 0, run: 0 };
  const result = await coordinateContext(
    { source: { type: "plane", workspace: "W".repeat(1_025), project: "P", sequenceId: 1 } },
    "/repo",
    {
      canonical: async (path) => {
        calls.canonical += 1;
        return path;
      },
      session: async () => {
        calls.session += 1;
        return null;
      },
      run: async () => {
        calls.run += 1;
        return null;
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "invalid_context_request");
  assert.deepEqual(calls, { canonical: 0, session: 0, run: 0 });
  assert.doesNotMatch(JSON.stringify(result), /W{20}/);
});

test("context hydrates a complete normalized Plane helper result", async () => {
  const apiKey = "plane-api-key-not-in-arguments";
  const runCalls = [];
  const result = await coordinateContext(
    planeRequest,
    "/repo",
    {
      canonical: async (path) => path,
      session: serenaSession(),
      run: async (program, args) => {
        runCalls.push([program, args]);
        return planeHelperResult({ ignored: "additive helper field" });
      },
    },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(result.source, {
    type: "plane",
    key: "plane:IMA:ERIC-1",
    title: "Plane item",
    content: "{\"name\":\"Plane item\",\"description\":\"Hydrated description\",\"state\":\"33333333-3333-4333-8333-333333333333\",\"reference\":\"plane:IMA:ERIC-1\"}",
    references: ["Plane:IMA:ERIC-1"],
  });
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0][0], "node");
  assert.match(runCalls[0][1][0], /skills\/plane-api\/scripts\/plane-api\.mjs$/);
  assert.deepEqual(runCalls[0][1].slice(1), ["plane:get", "plane:IMA:ERIC-1"]);
  assert.doesNotMatch(JSON.stringify({ result, runCalls }), new RegExp(apiKey));
});

test("context safely rejects unavailable Plane helper results", async () => {
  const result = await coordinateContext(
    planeRequest,
    "/repo",
    {
      canonical: async (path) => path,
      session: serenaSession(),
      run: async () => null,
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.source, null);
  assert.deepEqual(result.diagnostics, [sourceBoundaryDiagnostic]);
});

test("context accepts normalized Plane results without a state", async () => {
  const result = await coordinateContext(
    planeRequest,
    "/repo",
    {
      canonical: async (path) => path,
      session: serenaSession(),
      run: async () => planeHelperResult({ stateId: null }),
    },
  );

  assert.equal(result.status, "ready");
  assert.equal(JSON.parse(result.source.content).state, null);
});

test("context rejects malformed Plane helper results", async () => {
  const invalidResults = [
    ["missing data", { success: true, data: null }],
    ["missing work-item ID", planeHelperResult({ id: undefined })],
    ["malformed work-item ID", planeHelperResult({ id: "not-a-uuid" })],
    ["missing project ID", planeHelperResult({ projectId: undefined })],
    ["malformed project ID", planeHelperResult({ projectId: "not-a-uuid" })],
    ["missing reference", planeHelperResult({ reference: undefined })],
    ["mismatched reference", planeHelperResult({ reference: "plane:OTHER:ERIC-1" })],
    ["missing workspace", planeHelperResult({ workspace: undefined })],
    ["mismatched workspace", planeHelperResult({ workspace: "OTHER" })],
    ["missing identifier", planeHelperResult({ identifier: undefined })],
    ["mismatched identifier", planeHelperResult({ identifier: "ERIC-2" })],
    ["missing sequence", planeHelperResult({ sequenceId: undefined })],
    ["non-numeric sequence", planeHelperResult({ sequenceId: "1" })],
    ["mismatched sequence", planeHelperResult({ sequenceId: 2 })],
    ["blank name", planeHelperResult({ name: "  " })],
    ["missing description", planeHelperResult({ description: undefined })],
    ["non-string description", planeHelperResult({ description: { detail: "provider-text" } })],
    ["missing state", planeHelperResult({ stateId: undefined })],
    ["malformed state", planeHelperResult({ stateId: "not-a-uuid" })],
  ];

  for (const [label, helperResult] of invalidResults) {
    const result = await coordinateContext(
      planeRequest,
      "/repo",
      {
        canonical: async (path) => path,
        session: serenaSession(),
        run: async () => helperResult,
      },
    );
    assert.equal(result.status, "failed", label);
    assert.equal(result.source, null, label);
    assert.deepEqual(result.diagnostics, [sourceBoundaryDiagnostic], label);
    assert.doesNotMatch(JSON.stringify(result), /provider-text/, label);
  }
});

test("context skips Plane helper effects for pre-aborted requests", async () => {
  const controller = new AbortController();
  const reason = new Error("Plane helper request was cancelled before start.");
  controller.abort(reason);
  let runCalls = 0;

  await assert.rejects(
    coordinateContext(
      planeRequest,
      "/repo",
      {
        canonical: async (path) => path,
        session: serenaSession(),
        run: async () => {
          runCalls += 1;
          return planeHelperResult();
        },
      },
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.equal(runCalls, 0);
});

test("context forwards mid-flight cancellation to the Plane helper runner", async () => {
  const controller = new AbortController();
  const reason = new Error("Plane helper request was cancelled in flight.");
  let signalSeen;
  let startRun;
  const started = new Promise((resolve) => {
    startRun = resolve;
  });
  const pending = coordinateContext(
    planeRequest,
    "/repo",
    {
      canonical: async (path) => path,
      session: serenaSession(),
      run: async (_program, _args, signal) => {
        signalSeen = signal;
        startRun();
        if (!signal) throw new Error("Missing helper abort signal.");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
    controller.signal,
  );

  await started;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(signalSeen, controller.signal);
});

test("context hydrates an exact lifecycle source through corpus summary recall and direct detail retrieval", async (t) => {
  const root = await pinTestRoot(t);
  const corpus = createCorpus();
  const marker = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=${identity.taskwarriorUuid}; outcome=completed -->`;
  const detail = `# Plan\n\n${marker}\n`;
  const stored = await seedLifecycleRecord(corpus, detail);
  const calls = [];

  const result = await coordinateContext(
    { source: { type: "lifecycle", key: lifecycleKey } },
    root,
    {
      canonical: async (path) => path,
      session: serenaSession(calls),
      corpus,
      resolveProjectRoot: async () => root,
    },
  );

  assert.equal(result.status, "ready");
  assert.deepEqual(result.source, {
    type: "lifecycle",
    key: lifecycleKey,
    title: `Lifecycle ${lifecycleKey}`,
    content: detail,
    references: [
      `Lifecycle:${lifecycleKey}`,
      `Qdrant:${stored.id}`,
      `QdrantRecordKey:${stored.recordKey}`,
    ],
  });
  assert.equal(calls.every(([server]) => server === "serena"), true);
});

test("context hydrates a persisted canonical Plane lifecycle marker", async (t) => {
  const root = await pinTestRoot(t);
  const planeLifecycleKey = "ima-pi:plane:ima:SKYNET-61";
  const planeIdentity = {
    ...identity,
    lifecycleKey: planeLifecycleKey,
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-61",
    sourceRefs: ["plane:ima:SKYNET-61"],
    priorArtifactIds: [],
  };
  const corpus = createCorpus();
  const persisted = await coordinateLifecycle({
    type: "implementation",
    identity: planeIdentity,
    summary: "Canonical Plane lifecycle markers hydrate through lifecycle context.",
    artifact: "# Implementation\n\nPlane lifecycle source hydration.",
  }, { corpus, now: () => new Date("2026-09-05T03:00:00.000Z") });
  assert.equal(persisted.status, "completed");

  const result = await coordinateContext(
    { source: { type: "lifecycle", key: planeLifecycleKey } },
    root,
    {
      canonical: async (path) => path,
      session: serenaSession(),
      corpus,
      resolveProjectRoot: async () => root,
    },
  );
  assert.equal(result.status, "ready");
  assert.equal(result.source.type, "lifecycle");
  assert.equal(result.source.key, planeLifecycleKey);
  assert.match(result.source.content, /plane_workspace=ima; plane_work_item=SKYNET-61/);
});

test("corpus lifecycle reconciliation adapts verified direct detail to the existing cycle envelope", async () => {
  const corpus = createCorpus();
  const marker = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=${identity.taskwarriorUuid}; outcome=completed -->`;
  const stored = await seedLifecycleRecord(corpus, `# Plan\n${marker}\n`);

  const recalled = await recallCorpusLifecycle(`${lifecycleKey} plan`, corpus);
  assert.equal(Array.isArray(recalled.structuredContent.results), true);
  assert.equal(recalled.structuredContent.results.length, 1);
  assert.equal(recalled.structuredContent.results[0].recordKey, stored.recordKey);
  assert.match(recalled.structuredContent.results[0].content, /outcome=completed/);
  assert.equal(await recallCorpusLifecycle("malformed", corpus), null);
});

test("document recall combines canonical records with bounded historical closeout compatibility", async () => {
  const corpus = createCorpus();
  const canonical = await coordinateLifecycle({
    type: "document",
    identity,
    summary: "READY: canonical documentation evidence is stored separately from closeout.",
    artifact: "# Documentation\n\nREADY: canonical documentation evidence is complete.",
  }, { corpus, now: () => new Date("2026-09-22T00:00:00.000Z") });
  const historical = await seedHistoricalCloseoutDocument(corpus);
  const calls = [];
  const recallInstitutional = corpus.recallInstitutional;
  corpus.recallInstitutional = async (selection) => {
    calls.push(selection);
    return recallInstitutional(selection);
  };

  const recalled = await recallCorpusLifecycle(`${lifecycleKey} document`, corpus);
  assert.deepEqual(calls, [
    { lifecycleKey, phase: "document", limit: 10 },
    { lifecycleKey, phase: "closeout", limit: 10 },
  ]);
  assert.deepEqual(recalled.structuredContent.results.map(({ id, phase }) => ({ id, phase })), [
    { id: canonical.artifactId, phase: "document" },
    { id: historical.id, phase: "closeout" },
  ]);
  assert.equal(recalled.structuredContent.results.every(({ lifecycleKey: key }) => key === lifecycleKey), true);
});

test("document recall fails closed when mixed historical detail is incomplete", async () => {
  const corpus = createCorpus();
  const canonical = await coordinateLifecycle({
    type: "document",
    identity,
    summary: "READY: canonical documentation evidence for mixed-history validation.",
    artifact: "# Documentation\n\nREADY: canonical evidence.",
  }, { corpus, now: () => new Date("2026-09-22T00:00:00.000Z") });
  assert.equal(canonical.status, "completed");
  await seedHistoricalCloseoutDocument(corpus);
  const getInstitutional = corpus.getInstitutional;
  corpus.getInstitutional = async (recordKey) => {
    const result = await getInstitutional(recordKey);
    if (!result.success || result.data.phase !== "closeout") return result;
    const { detail: _detail, ...incomplete } = result.data;
    return success(incomplete);
  };

  assert.equal(await recallCorpusLifecycle(`${lifecycleKey} document`, corpus), null);
});

test("corpus lifecycle reconciliation rejects C1 and trim-sensitive C0 record keys", async () => {
  const marker = `<!-- ima-lifecycle verification: lifecycle_key=${lifecycleKey}; nonce=01234567-89ab-cdef-0123-456789abcdef; phase=plan; jira_key=; taskwarrior_uuid=${identity.taskwarriorUuid}; outcome=completed -->`;
  const malformedRecordKeys = [
    (recordKey) => `${recordKey}\u0085`,
    (recordKey) => `\t${recordKey}`,
    (recordKey) => `${recordKey}\r`,
  ];

  for (const malformedRecordKey of malformedRecordKeys) {
    const corpus = createCorpus();
    await seedLifecycleRecord(corpus, `# Plan\n${marker}\n`);
    const getInstitutional = corpus.getInstitutional;
    corpus.getInstitutional = async (recordKey) => {
      const full = await getInstitutional(recordKey);
      return full.success
        ? success({ ...full.data, recordKey: malformedRecordKey(full.data.recordKey) })
        : full;
    };

    assert.equal(await recallCorpusLifecycle(`${lifecycleKey} plan`, corpus), null);
  }
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
  assert.deepEqual(calls, [{ lifecycleKey, phase: "review", limit: 20 }]);
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
  const manifest = stored.find(({ payload }) => payload.record_kind === "manifest");
  assert.equal(result.artifactId, manifest.id);
  assert.equal(result.recordKey, manifest.payload.record_key);
  assert.equal(stored.filter(({ payload }) => payload.record_kind === "manifest").length, 1);
  assert.equal(stored.filter(({ payload }) => payload.record_kind === "detail_chunk").length, 1);
  assert.equal(stored.every(({ payload }) => payload.record_kind === "manifest" || payload.record_kind === "detail_chunk"), true);
});

test("lifecycle carries the Plane identity pair through direct reassembly", async () => {
  const planeIdentity = {
    project: "ima-pi",
    lifecycleKey: "ima-pi:plane:ima:SKYNET-61",
    lifecycleRootMemoryId: "",
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-61",
    sourceRefs: ["plane:ima:SKYNET-61"],
    priorArtifactIds: [],
  };
  const request = {
    type: "implementation",
    identity: planeIdentity,
    summary: "Plane-bound lifecycle evidence was directly reassembled.",
    artifact: "# Implementation\n\nPlane lifecycle identity is source-bound.",
  };
  const corpus = createCorpus();
  const completed = await coordinateLifecycle(request, {
    corpus,
    now: () => new Date("2026-09-05T02:00:00.000Z"),
  });

  assert.equal(completed.status, "completed");
  const full = await corpus.getInstitutional(completed.recordKey);
  assert.equal(full.success, true);
  assert.match(full.data.detail, /plane_workspace: 'ima'/);
  assert.match(
    full.data.detail,
    /plane_workspace=ima; plane_work_item=SKYNET-61; outcome=completed -->/,
  );

  const mismatchedCorpus = createCorpus();
  const getInstitutional = mismatchedCorpus.getInstitutional;
  mismatchedCorpus.getInstitutional = async (recordKey) => {
    const result = await getInstitutional(recordKey);
    return result.success
      ? success({
        ...result.data,
        detail: result.data.detail.replace(
          "plane_workspace=ima",
          "plane_workspace=other",
        ),
      })
      : result;
  };
  const mismatched = await coordinateLifecycle(request, {
    corpus: mismatchedCorpus,
    now: () => new Date("2026-09-05T02:00:00.000Z"),
  });
  assert.equal(mismatched.status, "failed");
  assert.equal(mismatched.semanticRecall.matched, false);
  assert.equal(mismatched.error.code, "corpus_semantic_completion_unverified");
});

test("lifecycle retains both references when direct verification fails", async () => {
  const corpus = createCorpus();
  let readReference = "";
  corpus.getInstitutional = async (recordKey) => {
    readReference = recordKey;
    return failure("record_not_found");
  };

  const result = await coordinateLifecycle({
    type: "implementation",
    identity,
    summary: "Accepted persistence retains references when direct verification fails.",
    artifact: "# Implementation\n\nVerification failed after storage.",
  }, { corpus, now: () => new Date("2026-08-27T00:00:00.000Z") });

  assert.equal(result.status, "failed");
  assert.equal(result.receiptAccepted, true);
  assert.match(result.artifactId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.recordKey, readReference);
  assert.match(result.recordKey, /:implementation:[a-f0-9]{12}$/);
  assert.equal(result.error.code, "record_not_found");
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
  assert.equal(first.recordKey, second.recordKey);
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
  assert.equal(retried.recordKey, first.recordKey);
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

test("persists markerless manual documentation outcomes without treating persistence as readiness", async () => {
  for (const outcome of ["READY", "BLOCKED"]) {
    const corpus = createCorpus();
    const summary = `${outcome}: manual documentation assessment.`;
    const artifact = `# Documentation\n\n${outcome}: manual documentation assessment.`;
    const result = await coordinateLifecycle({
      type: "document",
      identity,
      summary,
      artifact,
    }, { corpus, now: () => new Date("2026-09-23T00:00:00.000Z") });

    assert.equal(result.status, "completed", outcome);
    assert.notEqual(result.status, outcome, outcome);
    assert.equal(result.phase, "document", outcome);
    assert.equal(result.receiptAccepted, true, outcome);
    assert.equal(result.semanticRecall.matched, true, outcome);
    const stored = await corpus.getInstitutional(result.recordKey);
    assert.equal(stored.success, true, outcome);
    assert.equal(stored.data.phase, "document", outcome);
    assert.equal(stored.data.summary, summary, outcome);
    assert.equal(stored.data.detail.includes(artifact), true, outcome);
    assert.equal(stored.data.detail.includes("ima-cycle outcome:"), false, outcome);
  }
});

test("rejects a new closeout write carrying document evidence before corpus access", async () => {
  let corpusAccesses = 0;
  const corpus = new Proxy({}, {
    get: () => {
      corpusAccesses += 1;
      return undefined;
    },
  });
  const result = await coordinateLifecycle({
    type: "closeout",
    identity,
    summary: "Historical-style documentation must not be written as closeout.",
    artifact: "# Documentation\n\n<!-- ima-cycle outcome: phase=document; outcome=READY -->",
  }, { corpus });

  assert.equal(result.status, "failed");
  assert.equal(result.artifactId, null);
  assert.equal(result.recordKey, null);
  assert.equal(result.error.code, "closeout_document_phase_forbidden");
  assert.equal(corpusAccesses, 0);
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
  assert.equal(missingSummary.artifactId, null);
  assert.equal(missingSummary.recordKey, null);
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
  assert.equal(result.recordKey, null);
});

const pinTestRoot = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-lifecycle-routing-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
};

const localLifecycleRequest = (type = "plan") => ({
  type,
  identity,
  summary: `${type} evidence is exact before lifecycle provider pinning.`,
  artifact: `# ${type}\n\nSynthetic lifecycle provider evidence.`,
});

const routedQdrantRecord = (request, overrides = {}) => {
  const prepared = prepareLifecycleArtifact(request);
  assert.equal(prepared.valid, true);
  if (!prepared.valid) throw new Error("fixture lifecycle artifact is invalid");
  const id = deriveRecordId(prepared.data.recordKey);
  assert.equal(id.success, true);
  if (!id.success) throw new Error("fixture lifecycle record ID was not derived");
  const reference = {
    schemaVersion: 1,
    provider: "qdrant",
    artifactId: id.data,
    recordKey: prepared.data.recordKey,
    contentHash: createHash("sha256").update(prepared.data.artifact, "utf8").digest("hex"),
    lifecycleKey: request.identity.lifecycleKey,
    phase: request.type,
    nonce: prepared.data.nonce,
  };
  return {
    provider: "qdrant",
    artifactId: id.data,
    recordKey: prepared.data.recordKey,
    lifecycleKey: request.identity.lifecycleKey,
    phase: request.type,
    summary: request.summary,
    artifact: prepared.data.artifact,
    reference,
    createdAt: null,
    ...overrides,
  };
};

const localRouting = (overrides = {}) => {
  const records = new Map();
  const calls = { qdrant: [], markdown: [] };
  const qdrant = {
    provider: "qdrant",
    persist: async (request) => {
      calls.qdrant.push({ operation: "persist", type: request.type });
      const defaultResult = { status: "verified", record: routedQdrantRecord(request) };
      const result = overrides.persist
        ? await overrides.persist(request, defaultResult)
        : defaultResult;
      if (result.status === "verified") records.set(result.record.recordKey, result.record);
      return result;
    },
    reconcile: async (reference) => {
      calls.qdrant.push({ operation: "reconcile", reference: structuredClone(reference) });
      if (overrides.reconcile) return overrides.reconcile(reference, records.get(reference.recordKey) ?? null);
      const record = records.get(reference.recordKey);
      return record
        ? { status: "verified", record }
        : { status: "blocked", provider: "qdrant", code: "pinned_reference_missing", writeState: "no-write" };
    },
    recall: async (selection) => {
      calls.qdrant.push({ operation: "recall", selection: structuredClone(selection) });
      const result = [...records.values()]
        .filter((record) => record.lifecycleKey === selection.lifecycleKey
          && (selection.phase === undefined || record.phase === selection.phase))
        .slice(0, selection.limit);
      return { status: "verified", provider: "qdrant", records: result };
    },
  };
  const markdown = {
    provider: "markdown",
    persist: async () => {
      calls.markdown.push("persist");
      return { status: "blocked", provider: "markdown", code: "must_not_fallback", writeState: "no-write" };
    },
    reconcile: async () => {
      calls.markdown.push("reconcile");
      return { status: "blocked", provider: "markdown", code: "must_not_fallback", writeState: "no-write" };
    },
    recall: async () => {
      calls.markdown.push("recall");
      return { status: "blocked", provider: "markdown", code: "must_not_fallback" };
    },
  };
  return { routing: createLifecycleRouting([qdrant, markdown]), calls };
};

const noHistoricalLifecycleCorpus = {
  recallLifecycleInstitutional: async () => success([]),
};

const corpusAccessCounter = () => {
  let calls = 0;
  return {
    corpus: new Proxy({}, {
      get: () => {
        calls += 1;
        throw new Error("historical corpus must not be accessed");
      },
    }),
    calls: () => calls,
  };
};

const localRoutingOptions = (root, routing, overrides = {}) => ({
  cwd: root,
  routing,
  corpus: noHistoricalLifecycleCorpus,
  resolveProjectRoot: async () => root,
  now: () => new Date("2026-08-31T12:00:00.000Z"),
  confirmProvider: async () => true,
  ...overrides,
});

const authorizedPinAttempt = async (root, provider = "qdrant") => {
  const attempt = createLifecycleProviderPinAttempt({
    lifecycleKey,
    provider,
    attemptId: "00000000-0000-4000-8000-000000000001",
    startedAt: "2026-08-31T12:00:00.000Z",
  });
  assert.ok(attempt);
  const started = await beginLifecyclePinWith(async () => root)(root, attempt);
  assert.equal(started.status, "started");
  return attempt;
};

const pinQdrantAttempt = async (root, attempt) => {
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, attempt);
  assert.equal(writing.status, "writing");
  const record = routedQdrantRecord(localLifecycleRequest());
  const pin = createLifecycleProviderPin({
    lifecycleKey,
    provider: "qdrant",
    initialReference: record.reference,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    pinnedAt: attempt.startedAt,
  });
  assert.ok(pin);
  const confirmed = await confirmLifecyclePinWith(async () => root)(root, writing.attempt, pin);
  assert.equal(confirmed.status, "pinned");
  return pin;
};

const pinMarkdownLifecycleAuthority = async (root) => {
  const attempt = await authorizedPinAttempt(root, "markdown");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, attempt);
  assert.equal(writing.status, "writing");
  const recordKey = `${lifecycleKey}:plan:markdown-authority`;
  const artifactId = deriveRecordId(recordKey);
  assert.equal(artifactId.success, true);
  if (!artifactId.success) throw new Error("test Markdown lifecycle ID was not derived");
  const pin = createLifecycleProviderPin({
    lifecycleKey,
    provider: "markdown",
    initialReference: {
      schemaVersion: 1,
      provider: "markdown",
      checkoutRoot: root,
      lifecycleKey,
      phase: "plan",
      artifactId: artifactId.data,
      contentHash: "a".repeat(64),
      receiptHash: "b".repeat(64),
    },
    artifactId: artifactId.data,
    recordKey,
    pinnedAt: "2026-08-31T12:00:00.000Z",
  });
  assert.ok(pin);
  const confirmed = await confirmLifecyclePinWith(async () => root)(root, writing.attempt, pin);
  assert.equal(confirmed.status, "pinned");
};

test("registered lifecycle execution loads a valid pin before provider selection", async (t) => {
  const root = await pinTestRoot(t);
  await mkdir(join(root, ".serena"), { recursive: true });
  await pinMarkdownLifecycleAuthority(root);
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.ok(lifecycle);
  let selections = 0;
  let confirmations = 0;
  const output = await lifecycle.execute("test", localLifecycleRequest(), undefined, undefined, {
    cwd: root,
    mode: "tui",
    hasUI: true,
    ui: {
      select: async () => {
        selections += 1;
        return "qdrant";
      },
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    },
  });

  assert.equal(selections, 0);
  assert.equal(confirmations, 0);
  assert.equal(output.details.provider, "markdown");
  assert.equal(output.details.status, "failed");
});

test("does not reinterpret inaccessible lifecycle pin authority as historical corpus absence", async () => {
  const access = corpusAccessCounter();
  const result = await coordinateContext({
    source: { type: "lifecycle", key: lifecycleKey },
  }, "/unavailable", {
    canonical: async (path) => path,
    session: serenaSession(),
    corpus: access.corpus,
    resolveProjectRoot: async () => "relative-root",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.source, null);
  assert.equal(access.calls(), 0);
});

test("does not reinterpret symlink-rejected lifecycle pin authority as historical corpus absence", async (t) => {
  const root = await pinTestRoot(t);
  const outside = await pinTestRoot(t);
  await symlink(outside, join(root, ".ima-cycle"), "dir");
  const access = corpusAccessCounter();
  const result = await coordinateContext({
    source: { type: "lifecycle", key: lifecycleKey },
  }, root, {
    canonical: async (path) => path,
    session: serenaSession(),
    corpus: access.corpus,
    resolveProjectRoot: async () => root,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.source, null);
  assert.equal(access.calls(), 0);
});

test("requires explicit user confirmation before BookStack selection and preserves an exact durable pin", async (t) => {
  const root = await pinTestRoot(t);
  const { routing, calls } = localRouting();
  let confirmation;
  const denied = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "bookstack",
  }, localRoutingOptions(root, routing, {
    confirmProvider: async (input) => {
      confirmation = input;
      return false;
    },
  }));
  assert.equal(denied.status, "failed");
  assert.equal(denied.error.code, "lifecycle_provider_confirmation_required");
  assert.equal(confirmation.provider, "bookstack");
  assert.equal(confirmation.recommendation.source, "session");
  assert.deepEqual(calls, { qdrant: [], markdown: [] });
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey),
    { status: "absent" },
  );

  const first = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(root, routing));
  assert.equal(first.status, "completed");
  const pin = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pin.status, "pinned");
  if (pin.status !== "pinned") return;
  assert.equal(pin.pin.provider, "qdrant");

  await writeFile(
    join(root, ".ima-cycle", "active.json"),
    JSON.stringify({ lifecycleProvider: "markdown", lifecycleProviderAttemptId: "not-authoritative" }),
    "utf8",
  );
  const continued = await coordinateLifecycle(localLifecycleRequest("implementation"), localRoutingOptions(root, routing));
  assert.equal(continued.status, "completed");
  assert.equal(calls.qdrant.filter(({ operation }) => operation === "persist").length, 2);
  assert.deepEqual(calls.markdown, []);

  const conflict = await coordinateLifecycle({
    ...localLifecycleRequest("test"),
    provider: "markdown",
  }, localRoutingOptions(root, routing));
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.error.code, "lifecycle_provider_pin_conflict");
  assert.equal(calls.qdrant.filter(({ operation }) => operation === "persist").length, 2);
  assert.deepEqual(calls.markdown, []);
});

test("does not pin mismatched lifecycle identity or uncertain first persistence", async (t) => {
  const mismatchedRoot = await pinTestRoot(t);
  const mismatch = localRouting({
    persist: async (request) => ({
      status: "verified",
      record: routedQdrantRecord(request, { lifecycleKey: "other-lifecycle" }),
    }),
  });
  const mismatched = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(mismatchedRoot, mismatch.routing));
  assert.equal(mismatched.status, "failed");
  assert.equal(mismatched.error.code, "lifecycle_provider_verification_failed");
  const mismatchPin = await loadLifecyclePinStateWith(async () => mismatchedRoot)(mismatchedRoot, lifecycleKey);
  assert.equal(mismatchPin.status, "pending");
  if (mismatchPin.status !== "pending") return;
  assert.equal(mismatchPin.attempt.status, "writing");

  const uncertainRoot = await pinTestRoot(t);
  const uncertain = localRouting({
    persist: async () => ({
      status: "blocked",
      provider: "qdrant",
      code: "synthetic_possible_write",
      writeState: "possible-write",
    }),
  });
  const first = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(uncertainRoot, uncertain.routing));
  assert.equal(first.status, "failed");
  assert.equal(first.error.code, "synthetic_possible_write");
  const pending = await loadLifecyclePinStateWith(async () => uncertainRoot)(uncertainRoot, lifecycleKey);
  assert.equal(pending.status, "pending");
  if (pending.status !== "pending") return;
  assert.equal(pending.attempt.status, "writing");

  const retry = await coordinateLifecycle({
    ...localLifecycleRequest("implementation"),
    provider: "markdown",
  }, localRoutingOptions(uncertainRoot, uncertain.routing));
  assert.equal(retry.status, "failed");
  assert.equal(retry.error.code, "lifecycle_pin_write_unresolved");
  assert.equal(uncertain.calls.qdrant.filter(({ operation }) => operation === "persist").length, 1);
  assert.deepEqual(uncertain.calls.markdown, []);
});

test("routes a provider-neutral four-key request into native Qdrant persistence", async (t) => {
  const root = await pinTestRoot(t);
  const corpus = createCorpus();
  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, {
    cwd: root,
    corpus,
    environment: {},
    resolveProjectRoot: async () => root,
    now: () => new Date("2026-08-31T12:00:00.000Z"),
    confirmProvider: async () => true,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider, "qdrant");
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "pinned");
});

test("routes a provider-neutral four-key request into native BookStack persistence", async (t) => {
  const root = await pinTestRoot(t);
  const originalFetch = globalThis.fetch;
  const shelf = { id: 1, name: "Lifecycle artifacts", slug: "lifecycle-artifacts", books: [2] };
  const book = { id: 2, name: "ima-pi", slug: "ima-pi" };
  const chapter = {
    id: 3,
    name: `taskwarrior-${identity.taskwarriorUuid}`,
    slug: `taskwarrior-${identity.taskwarriorUuid}`,
    book_id: 2,
  };
  const pages = [];
  let providerConfirmations = 0;
  let placementConfirmations = 0;
  const json = (value) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const list = (data) => json({ total: data.length, data });
    if (method === "GET" && url.pathname === "/api/shelves") return list([shelf]);
    if (method === "GET" && url.pathname === "/api/books") return list([book]);
    if (method === "GET" && url.pathname === "/api/chapters") return list([chapter]);
    if (method === "GET" && url.pathname === "/api/pages") return list(pages);
    if (method === "GET" && url.pathname === "/api/shelves/1") return json(shelf);
    if (method === "GET" && url.pathname === "/api/books/2") return json(book);
    if (method === "GET" && url.pathname === "/api/chapters/3") return json(chapter);
    if (method === "GET" && url.pathname === "/api/pages/4") return json(pages[0]);
    if (method === "POST" && url.pathname === "/api/pages") {
      const body = JSON.parse(String(init.body));
      const page = {
        id: 4,
        name: body.name,
        slug: body.name,
        book_id: 2,
        chapter_id: 3,
        markdown: body.markdown,
        revision_count: 1,
        updated_at: "2026-08-31T12:00:00.000Z",
        created_by: { id: 7 },
        updated_by: { id: 8 },
      };
      pages.push(page);
      return json(page);
    }
    return new Response("not found", { status: 404 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "bookstack",
  }, {
    cwd: root,
    corpus: noHistoricalLifecycleCorpus,
    environment: {
      BOOKSTACK_BASE_URL: "https://bookstack.test",
      BOOKSTACK_TOKEN_ID: "test-token-id",
      BOOKSTACK_TOKEN_SECRET: "test-token-secret",
    },
    resolveProjectRoot: async () => root,
    now: () => new Date("2026-08-31T12:00:00.000Z"),
    confirmProvider: async () => {
      providerConfirmations += 1;
      return true;
    },
    confirmBookStackPlacement: async () => {
      placementConfirmations += 1;
      return true;
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider, "bookstack");
  assert.equal(providerConfirmations, 1);
  assert.equal(placementConfirmations, 1);
  assert.equal(pages.length, 1);
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "pinned");
});

test("routes a provider-neutral four-key request into native Serena persistence", async (t) => {
  const root = await pinTestRoot(t);
  await mkdir(join(root, ".serena", "memories"), { recursive: true });
  await writeFile(join(root, ".serena", "project.yml"), "project_name: integration-serena\n", "utf8");
  let sessionCalls = 0;
  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "serena",
  }, {
    cwd: root,
    corpus: noHistoricalLifecycleCorpus,
    environment: {},
    resolveProjectRoot: async () => root,
    now: () => new Date("2026-08-31T12:00:00.000Z"),
    confirmProvider: async () => true,
    session: async (_server, callback) => callback(async () => {
      sessionCalls += 1;
      throw new Error("Serena project inspection must fail before a transport call");
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "serena_project_unavailable");
  assert.equal(sessionCalls, 0);
  const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pending.status, "pending");
  if (pending.status === "pending") assert.equal(pending.attempt.status, "writing");
});

test("recallLifecycle returns an approved pre-pin plan without changing authorization", async (t) => {
  const root = await pinTestRoot(t);
  const corpus = createCorpus();
  const historical = await coordinateLifecycle({
    ...localLifecycleRequest(),
    summary: "APPROVED lifecycle plan is available for read-only adoption.",
    artifact: "# Approved plan\n\n<!-- ima-cycle outcome: phase=plan; outcome=APPROVED -->",
  }, {
    corpus,
    now: () => new Date("2026-08-31T12:00:00.000Z"),
  });
  assert.equal(historical.status, "completed");

  const attempt = await authorizedPinAttempt(root);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const recalled = await recallLifecycle(`${lifecycleKey} plan`, root, {
    corpus,
    resolveProjectRoot: async () => root,
  });

  assert.ok(recalled);
  assert.equal(recalled.structuredContent.results.length, 1);
  assert.equal(recalled.structuredContent.results[0].phase, "plan");
  assert.equal(recalled.structuredContent.results[0].recordKey, historical.recordKey);
  assert.equal(await readFile(registry, "utf8"), before);
  const authority = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(authority.status, "pending");
  if (authority.status === "pending") assert.deepEqual(authority.attempt, attempt);
});

test("recallLifecycle returns verified empty plan history without changing authorization", async (t) => {
  const root = await pinTestRoot(t);
  const attempt = await authorizedPinAttempt(root);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const selections = [];
  const recalled = await recallLifecycle(`${lifecycleKey} plan`, root, {
    corpus: {
      recallLifecycleInstitutional: async (selection) => {
        selections.push(structuredClone(selection));
        return success([]);
      },
    },
    resolveProjectRoot: async () => root,
  });

  assert.deepEqual(recalled, { structuredContent: { results: [] } });
  assert.deepEqual(selections, [{ lifecycleKey, phase: "plan", limit: 20 }]);
  assert.equal(await readFile(registry, "utf8"), before);
  const authority = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(authority.status, "pending");
  if (authority.status === "pending") assert.deepEqual(authority.attempt, attempt);
});

test("recallLifecycle blocks failed and cancelled pre-pin plan discovery without state effects", async (t) => {
  const failedRoot = await pinTestRoot(t);
  const failedAttempt = await authorizedPinAttempt(failedRoot);
  const failedRegistry = join(failedRoot, ".ima-cycle", "provider-pins.json");
  const beforeFailure = await readFile(failedRegistry, "utf8");
  const failed = await recallLifecycle(`${lifecycleKey} plan`, failedRoot, {
    corpus: { recallLifecycleInstitutional: async () => failure("query_failed") },
    resolveProjectRoot: async () => failedRoot,
  });
  assert.equal(failed, null);
  assert.equal(await readFile(failedRegistry, "utf8"), beforeFailure);
  const failedAuthority = await loadLifecyclePinStateWith(async () => failedRoot)(failedRoot, lifecycleKey);
  assert.equal(failedAuthority.status, "pending");
  if (failedAuthority.status === "pending") assert.deepEqual(failedAuthority.attempt, failedAttempt);

  const cancelledRoot = await pinTestRoot(t);
  const cancelledAttempt = await authorizedPinAttempt(cancelledRoot);
  const cancelledRegistry = join(cancelledRoot, ".ima-cycle", "provider-pins.json");
  const beforeCancellation = await readFile(cancelledRegistry, "utf8");
  const controller = new AbortController();
  const cancelled = recallLifecycle(`${lifecycleKey} plan`, cancelledRoot, {
    corpus: {
      recallLifecycleInstitutional: async () => {
        controller.abort();
        return success([]);
      },
    },
    resolveProjectRoot: async () => cancelledRoot,
  }, controller.signal);
  await assert.rejects(cancelled);
  assert.equal(await readFile(cancelledRegistry, "utf8"), beforeCancellation);
  const cancelledAuthority = await loadLifecyclePinStateWith(async () => cancelledRoot)(cancelledRoot, lifecycleKey);
  assert.equal(cancelledAuthority.status, "pending");
  if (cancelledAuthority.status === "pending") assert.deepEqual(cancelledAuthority.attempt, cancelledAttempt);
});

test("recallLifecycle blocks non-plan and invalid pending authority without corpus fallback", async (t) => {
  const scenarios = [
    { label: "non-plan query", query: `${lifecycleKey} implementation` },
    {
      label: "writing attempt",
      query: `${lifecycleKey} plan`,
      arrange: async (root, attempt) => {
        const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, attempt);
        assert.equal(writing.status, "writing");
      },
    },
    {
      label: "corrupt authority",
      query: `${lifecycleKey} plan`,
      arrange: async (root) => writeFile(join(root, ".ima-cycle", "provider-pins.json"), "{", "utf8"),
    },
    {
      label: "conflicting authority",
      query: `${lifecycleKey} plan`,
      arrange: async (root, attempt) => writeFile(
        join(root, ".ima-cycle", "provider-pins.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          entries: [
            { status: "pending", attempt },
            { status: "pending", attempt: { ...attempt, attemptId: "00000000-0000-4000-8000-000000000002" } },
          ],
        })}\n`,
        "utf8",
      ),
    },
    {
      label: "inaccessible authority",
      query: `${lifecycleKey} plan`,
      arrange: async (root) => {
        const outside = await pinTestRoot(t);
        await rm(join(root, ".ima-cycle"), { recursive: true, force: true });
        await symlink(outside, join(root, ".ima-cycle"), "dir");
      },
    },
  ];

  for (const scenario of scenarios) {
    const root = await pinTestRoot(t);
    const attempt = await authorizedPinAttempt(root);
    await scenario.arrange?.(root, attempt);
    const access = corpusAccessCounter();
    const recalled = await recallLifecycle(scenario.query, root, {
      corpus: access.corpus,
      resolveProjectRoot: async () => root,
    });
    assert.equal(recalled, null, scenario.label);
    assert.equal(access.calls(), 0, scenario.label);
  }
});

test("recallLifecycle drops plan results when the snapshotted authority changes", async (t) => {
  const transitions = [
    {
      label: "writing",
      change: async (root, attempt) => {
        const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, attempt);
        assert.equal(writing.status, "writing");
        return writing.attempt;
      },
      verify: (authority, expected) => {
        assert.equal(authority.status, "pending");
        if (authority.status === "pending") assert.deepEqual(authority.attempt, expected);
      },
    },
    {
      label: "removed",
      change: async (root, attempt) => {
        const abandoned = await abandonLifecyclePinAttemptWith(async () => root)(root, attempt);
        assert.equal(abandoned.status, "cleared");
        return null;
      },
      verify: (authority) => assert.deepEqual(authority, { status: "absent" }),
    },
    {
      label: "replaced",
      change: async (root, attempt) => {
        const abandoned = await abandonLifecyclePinAttemptWith(async () => root)(root, attempt);
        assert.equal(abandoned.status, "cleared");
        const replacement = createLifecycleProviderPinAttempt({
          lifecycleKey,
          provider: "qdrant",
          attemptId: "00000000-0000-4000-8000-000000000002",
          startedAt: "2026-08-31T12:00:00.000Z",
        });
        assert.ok(replacement);
        const started = await beginLifecyclePinWith(async () => root)(root, replacement);
        assert.equal(started.status, "started");
        return replacement;
      },
      verify: (authority, expected) => {
        assert.equal(authority.status, "pending");
        if (authority.status === "pending") assert.deepEqual(authority.attempt, expected);
      },
    },
    {
      label: "pinned",
      change: pinQdrantAttempt,
      verify: (authority, expected) => {
        assert.equal(authority.status, "pinned");
        if (authority.status === "pinned") assert.deepEqual(authority.pin, expected);
      },
    },
  ];

  for (const transition of transitions) {
    const root = await pinTestRoot(t);
    const attempt = await authorizedPinAttempt(root);
    let startRecall;
    const started = new Promise((resolve) => { startRecall = resolve; });
    let finishRecall;
    const recall = new Promise((resolve) => { finishRecall = resolve; });
    const result = recallLifecycle(`${lifecycleKey} plan`, root, {
      corpus: {
        recallLifecycleInstitutional: async () => {
          startRecall();
          return recall;
        },
      },
      resolveProjectRoot: async () => root,
    });

    await started;
    const expected = await transition.change(root, attempt);
    finishRecall(success([]));
    assert.equal(await result, null, transition.label);
    const authority = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    transition.verify(authority, expected);
  }
});

test("rejects non-Qdrant persistence for historical Qdrant evidence in every lifecycle phase", async (t) => {
  for (const phase of ["implementation", "test", "review", "document"]) {
    const root = await pinTestRoot(t);
    const corpus = createCorpus();
    const selections = [];
    corpus.recallLifecycleInstitutional = async ({ lifecycleKey: expected, phase: selectedPhase, limit }) => {
      selections.push({
        lifecycleKey: expected,
        ...(selectedPhase ? { phase: selectedPhase } : {}),
        limit,
      });
      const recordKeys = [...corpus.points.values()]
        .filter(({ payload }) => payload.schema_version === 2
          && payload.record_kind === "manifest"
          && payload.lifecycle_key === expected
          && (selectedPhase === undefined || payload.phase === selectedPhase))
        .map(({ payload }) => payload.record_key)
        .slice(0, limit);
      const records = [];
      for (const recordKey of recordKeys) {
        const record = await corpus.getInstitutional(recordKey);
        if (!record.success) return record;
        records.push(record.data);
      }
      return success(records);
    };
    const historical = await coordinateLifecycle(localLifecycleRequest(phase), {
      corpus,
      now: () => new Date("2026-08-31T12:00:00.000Z"),
    });
    assert.equal(historical.status, "completed", phase);

    const attempt = await authorizedPinAttempt(root, "markdown");
    const destination = localRouting();
    const result = await coordinateLifecycle({
      ...localLifecycleRequest(),
      provider: attempt.provider,
      pinAttemptId: attempt.attemptId,
    }, localRoutingOptions(root, destination.routing, { corpus }));

    assert.equal(result.status, "failed", phase);
    assert.equal(result.error.code, "historical_qdrant_authority_conflict", phase);
    assert.deepEqual(selections, [{ lifecycleKey, limit: 20 }], phase);
    assert.deepEqual(destination.calls, { qdrant: [], markdown: [] }, phase);
    const authority = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    assert.equal(authority.status, "pending", phase);
    if (authority.status === "pending") assert.deepEqual(authority.attempt, attempt, phase);
  }
});

test("continues an authorized attempt after verified empty lifecycle-wide Qdrant history", async (t) => {
  const root = await pinTestRoot(t);
  const attempt = await authorizedPinAttempt(root);
  const { routing, calls } = localRouting();
  const selections = [];
  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: attempt.provider,
    pinAttemptId: attempt.attemptId,
  }, localRoutingOptions(root, routing, {
    corpus: {
      recallLifecycleInstitutional: async (selection) => {
        selections.push(selection);
        return success([]);
      },
    },
  }));

  assert.equal(result.status, "completed");
  assert.deepEqual(selections, [{ lifecycleKey, limit: 20 }]);
  assert.equal(calls.qdrant.filter(({ operation }) => operation === "persist").length, 1);
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "pinned");
});

test("preserves an authorized attempt when lifecycle-wide authority detection fails", async (t) => {
  const root = await pinTestRoot(t);
  const attempt = await authorizedPinAttempt(root, "markdown");
  const { routing, calls } = localRouting();
  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: attempt.provider,
    pinAttemptId: attempt.attemptId,
  }, localRoutingOptions(root, routing, {
    corpus: {
      recallLifecycleInstitutional: async () => failure("query_failed"),
    },
  }));

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "query_failed");
  assert.deepEqual(calls, { qdrant: [], markdown: [] });
  const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pending.status, "pending");
  if (pending.status === "pending") assert.equal(pending.attempt.status, "authorized");
});

test("clears a reused attempt after a proven no-write provider result", async (t) => {
  const root = await pinTestRoot(t);
  const attempt = await authorizedPinAttempt(root);
  const rejected = localRouting({
    persist: async () => ({
      status: "blocked",
      provider: "qdrant",
      code: "synthetic_no_write",
      writeState: "no-write",
    }),
  });
  let reusedConfirmations = 0;
  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: attempt.provider,
    pinAttemptId: attempt.attemptId,
  }, localRoutingOptions(root, rejected.routing, {
    confirmProvider: async () => {
      reusedConfirmations += 1;
      return true;
    },
  }));

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "synthetic_no_write");
  assert.equal(reusedConfirmations, 0);
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "absent");
  assert.equal(rejected.calls.qdrant.filter(({ operation }) => operation === "persist").length, 1);
  assert.deepEqual(rejected.calls.markdown, []);

  const recovered = localRouting();
  let confirmations = 0;
  const retried = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(root, recovered.routing, {
    confirmProvider: async () => {
      confirmations += 1;
      return true;
    },
  }));
  assert.equal(retried.status, "completed");
  assert.equal(confirmations, 1);
  assert.equal(recovered.calls.qdrant.filter(({ operation }) => operation === "persist").length, 1);
  assert.deepEqual(recovered.calls.markdown, []);
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "pinned");
});

test("surfaces reused no-write cleanup failure without clearing a replacement attempt", async (t) => {
  const root = await pinTestRoot(t);
  const attempt = await authorizedPinAttempt(root);
  const replacement = createLifecycleProviderPinAttempt({
    lifecycleKey,
    provider: "qdrant",
    attemptId: "00000000-0000-4000-8000-000000000002",
    startedAt: "2026-08-31T12:00:00.000Z",
  });
  assert.ok(replacement);
  const rejected = localRouting({
    persist: async () => {
      const abandoned = await abandonLifecyclePinAttemptWith(async () => root)(root, {
        ...attempt,
        status: "writing",
      });
      assert.equal(abandoned.status, "cleared");
      const started = await beginLifecyclePinWith(async () => root)(root, replacement);
      assert.equal(started.status, "started");
      return {
        status: "blocked",
        provider: "qdrant",
        code: "synthetic_no_write",
        writeState: "no-write",
      };
    },
  });
  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: attempt.provider,
    pinAttemptId: attempt.attemptId,
  }, localRoutingOptions(root, rejected.routing, {
    confirmProvider: async () => {
      throw new Error("reused attempts must not request another provider confirmation");
    },
  }));

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_pin_attempt_conflict");
  assert.equal(rejected.calls.qdrant.filter(({ operation }) => operation === "persist").length, 1);
  assert.deepEqual(rejected.calls.markdown, []);
  const authority = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(authority.status, "pending");
  if (authority.status === "pending") assert.deepEqual(authority.attempt, replacement);
});

test("retains a reused writing attempt for uncertain provider outcomes", async (t) => {
  const outcomes = [
    {
      label: "possible write",
      code: "synthetic_possible_write",
      persist: async () => ({
        status: "blocked",
        provider: "qdrant",
        code: "synthetic_possible_write",
        writeState: "possible-write",
      }),
    },
    {
      label: "malformed response",
      code: "lifecycle_provider_response_invalid",
      persist: async () => ({ malformed: true }),
    },
    {
      label: "provider exception",
      code: "lifecycle_provider_operation_failed",
      persist: async () => { throw new Error("synthetic provider exception"); },
    },
    {
      label: "failed verification",
      code: "lifecycle_provider_verification_failed",
      persist: async (request) => ({
        status: "verified",
        record: routedQdrantRecord(request, { summary: "mismatched provider response" }),
      }),
    },
  ];

  for (const outcome of outcomes) {
    const root = await pinTestRoot(t);
    const attempt = await authorizedPinAttempt(root);
    const routed = localRouting({ persist: outcome.persist });
    const result = await coordinateLifecycle({
      ...localLifecycleRequest(),
      provider: attempt.provider,
      pinAttemptId: attempt.attemptId,
    }, localRoutingOptions(root, routed.routing));

    assert.equal(result.status, "failed", outcome.label);
    assert.equal(result.error.code, outcome.code, outcome.label);
    assert.equal(routed.calls.qdrant.filter(({ operation }) => operation === "persist").length, 1, outcome.label);
    assert.deepEqual(routed.calls.markdown, [], outcome.label);
    const authority = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    assert.equal(authority.status, "pending", outcome.label);
    if (authority.status === "pending") {
      assert.equal(authority.attempt.status, "writing", outcome.label);
      assert.equal(authority.attempt.attemptId, attempt.attemptId, outcome.label);
    }
  }
});

test("blocks an authorized pre-pin attempt when authority changes during plan discovery", async (t) => {
  const root = await pinTestRoot(t);
  const attempt = await authorizedPinAttempt(root);
  const { routing, calls } = localRouting();
  let markDiscoveryStarted;
  const discoveryStarted = new Promise((resolve) => { markDiscoveryStarted = resolve; });
  let releaseDiscovery;
  const discovery = new Promise((resolve) => { releaseDiscovery = resolve; });
  const result = coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: attempt.provider,
    pinAttemptId: attempt.attemptId,
  }, localRoutingOptions(root, routing, {
    corpus: {
      recallLifecycleInstitutional: async () => {
        markDiscoveryStarted();
        return discovery;
      },
    },
  }));

  await discoveryStarted;
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, attempt);
  assert.equal(writing.status, "writing");
  releaseDiscovery(success([]));
  const blocked = await result;

  assert.equal(blocked.status, "failed");
  assert.equal(blocked.error.code, "lifecycle_pin_write_unresolved");
  assert.deepEqual(calls, { qdrant: [], markdown: [] });
  const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pending.status, "pending");
  if (pending.status === "pending") assert.equal(pending.attempt.status, "writing");
});

test("permits pre-pin reevaluation only after a proven no-write failure", async (t) => {
  const root = await pinTestRoot(t);
  const rejected = localRouting({
    persist: async () => ({
      status: "blocked",
      provider: "qdrant",
      code: "synthetic_no_write",
      writeState: "no-write",
    }),
  });
  const failed = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(root, rejected.routing));
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "synthetic_no_write");
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "absent");

  const recovered = localRouting();
  const retried = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(root, recovered.routing));
  assert.equal(retried.status, "completed");
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "pinned");
});

test("hydrates an independently verified non-Serena pin as degraded context without Serena fallback", async (t) => {
  const root = await pinTestRoot(t);
  const { routing, calls } = localRouting();
  const persisted = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(root, routing));
  assert.equal(persisted.status, "completed");

  let serenaCalls = 0;
  const context = await coordinateContext({
    source: { type: "lifecycle", key: lifecycleKey },
  }, root, {
    ...localRoutingOptions(root, routing),
    canonical: async (path) => path,
    session: async () => {
      serenaCalls += 1;
      throw new Error("Serena must not be used for a verified non-Serena pin");
    },
  });
  assert.equal(context.status, "degraded");
  assert.equal(context.source.type, "lifecycle");
  assert.match(context.source.content, /Synthetic lifecycle provider evidence/);
  assert.equal(context.diagnostics[0].code, "lifecycle_pinned_provider_context");
  assert.equal(serenaCalls, 0);
  assert.equal(calls.qdrant.some(({ operation }) => operation === "recall"), true);
});

test("retains verified historical Qdrant authority before unpinned provider selection", async (t) => {
  const corpus = createCorpus();
  corpus.recallLifecycleInstitutional = async ({ lifecycleKey: expected, phase, limit }) => {
    const recordKeys = [...corpus.points.values()]
      .filter(({ payload }) => payload.schema_version === 2
        && payload.record_kind === "manifest"
        && payload.lifecycle_key === expected
        && (phase === undefined || payload.phase === phase))
      .map(({ payload }) => payload.record_key)
      .slice(0, limit);
    const records = [];
    for (const recordKey of recordKeys) {
      const record = await corpus.getInstitutional(recordKey);
      if (!record.success) return record;
      records.push(record.data);
    }
    return success(records);
  };
  const historical = await coordinateLifecycle(localLifecycleRequest(), {
    corpus,
    now: () => new Date("2026-08-31T12:00:00.000Z"),
  });
  assert.equal(historical.status, "completed");

  const root = await pinTestRoot(t);
  const local = localRouting();
  let recommendation;
  const denied = await coordinateLifecycle(localLifecycleRequest("implementation"), {
    ...localRoutingOptions(root, local.routing),
    corpus,
    confirmProvider: async (input) => {
      recommendation = input.recommendation;
      return false;
    },
  });
  assert.equal(denied.status, "failed");
  assert.equal(denied.error.code, "lifecycle_provider_confirmation_required");
  assert.equal(recommendation.provider, "qdrant");
  assert.equal(recommendation.source, "historical-qdrant");
  assert.deepEqual(local.calls, { qdrant: [], markdown: [] });

  const conflict = await coordinateLifecycle({
    ...localLifecycleRequest("implementation"),
    provider: "markdown",
  }, {
    ...localRoutingOptions(root, local.routing),
    corpus,
  });
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.error.code, "historical_qdrant_authority_conflict");
  assert.deepEqual(local.calls, { qdrant: [], markdown: [] });
});
