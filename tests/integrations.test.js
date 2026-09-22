import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import integrations, {
  coordinateBookStackLifecycleRecovery,
  coordinateContext,
  coordinateLifecycle,
  coordinateLifecycleGet,
  coordinateLifecycleRecall,
  beginLifecycleContentAdjudication,
  continueLifecycleContentAdjudication,
  dispatchLifecycleContentRead,
  recallCorpusLifecycle,
  recallLifecycle,
  resolveLifecycleLineage,
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
  validateLifecycleWriteRequest,
} from "../lib/ima-lifecycle.ts";
import {
  abandonLifecyclePinAttemptWith,
  beginLifecyclePinWith,
  claimLifecyclePinRecoveryWith,
  confirmLifecyclePinWith,
  loadLifecyclePinStateWith,
  markLifecyclePinAttemptWritingWith,
} from "../lib/ima-lifecycle-pin-store.ts";
import {
  createLifecycleProviderPin,
  createLifecycleProviderPinAttempt,
} from "../lib/ima-lifecycle-pin.ts";
import {
  createLifecycleRouting,
  lifecycleReadReferenceFor,
  routeLifecycleRecall,
} from "../lib/ima-lifecycle-routing.ts";
import {
  createSerenaLifecycleProject,
  createSerenaLifecycleRecord,
} from "../lib/serena-lifecycle-record.ts";
import { createBookStackLifecycleProvider } from "../lib/bookstack-lifecycle.ts";
import { createBookStackLifecycleClient } from "../lib/bookstack-lifecycle-client.ts";
import { createLifecycleRecord, digestBookStackValue } from "../lib/bookstack-lifecycle-record.ts";
import {
  createBookStackLifecycleJsonRequester,
  createBookStackLifecycleRequestScheduler,
} from "../lib/bookstack-lifecycle-requests.ts";
import { originFingerprint } from "../lib/bookstack-lifecycle-recovery.ts";
import { lifecycleContentBinding } from "../lib/ima-lifecycle-security.ts";
import { selectReusablePlan } from "../lib/ima-cycle-plan.ts";

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
const rootedLifecycleIdentity = {
  ...identity,
  lifecycleRootMemoryId: "00000000-0000-5000-8000-000000000230",
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
const standardMemories = ["core", "conventions", "tech_stack", "suggested_commands", "task_completion", "memory_maintenance"];
const serenaActivationReceipt = (projectPath) =>
  `The project with name 'synthetic' at ${projectPath} is activated.`;

const serenaSession = (calls = []) => async (server, callback) => {
  assert.equal(server, "serena");
  return callback(async (name, args) => {
    calls.push([server, name, args]);
    if (name === "activate_project") return direct(serenaActivationReceipt(args.project));
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
  const recovery = tools.find((tool) => tool.name === "ima_bookstack_lifecycle_recover");
  const lifecycleRecall = tools.find((tool) => tool.name === "ima_lifecycle_recall");
  const lifecycleGet = tools.find((tool) => tool.name === "ima_lifecycle_get");

  assert.ok(context);
  assert.ok(lifecycle);
  assert.ok(recovery);
  assert.ok(lifecycleRecall);
  assert.ok(lifecycleGet);
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
    contentAdjudication: {
      handle: "00000000-0000-4000-8000-000000000237",
      decisions: [{
        finding: "00000000-0000-4000-8000-000000000238",
        decision: "continue_after_review",
      }],
    },
  }), true);
  assert.equal(Check(lifecycle.parameters, {
    contentAdjudication: {
      handle: "00000000-0000-4000-8000-000000000237",
      decisions: [{
        finding: "00000000-0000-4000-8000-000000000238",
        decision: "reject",
      }],
    },
    artifact: "must-not-be-accepted",
  }), false);
  assert.equal(Check(lifecycleRecall.parameters, {
    lifecycleKey,
    phase: "plan",
    limit: 1,
  }), true);
  assert.equal(Check(lifecycleRecall.parameters, {
    lifecycleKey,
    phase: "plan",
    limit: 50,
  }), true);
  assert.equal(Check(lifecycleRecall.parameters, {
    lifecycleKey,
    phase: "plan",
    limit: 51,
  }), false);
  assert.equal(Check(lifecycleRecall.parameters, {
    lifecycleKey,
    provider: "qdrant",
  }), false);
  assert.equal(Check(lifecycleRecall.parameters, {
    lifecycleKey,
    checkoutRoot: "/caller-selected-checkout",
  }), false);
  assert.deepEqual(
    [...lifecycleGet.parameters.required].sort(),
    ["artifactId", "lifecycleKey", "phase"],
  );
  assert.deepEqual(
    Object.keys(lifecycleGet.parameters.properties).sort(),
    [
      "artifactId",
      "contentHash",
      "lifecycleKey",
      "phase",
      "recordKey",
      "reference",
      "summary",
    ],
  );
  const selector = {
    lifecycleKey,
    phase: "plan",
    artifactId: "00000000-0000-4000-8000-000000000001",
  };
  assert.equal(Check(lifecycleGet.parameters, selector), true);
  assert.equal(Check(lifecycleGet.parameters, {
    ...selector,
    recordKey: `${lifecycleKey}:plan:0123456789ab`,
  }), false);
  assert.equal(Check(lifecycleGet.parameters, {
    lifecycleKey,
    phase: "plan",
  }), false);
  assert.equal(Check(lifecycleGet.parameters, {
    ...selector,
    provider: "qdrant",
  }), false);
  assert.equal(Check(lifecycleGet.parameters, {
    lifecycleKey,
    phase: "plan",
    artifactId: "00000000-0000-4000-8000-000000000001",
    recordKey: `${lifecycleKey}:plan:0123456789ab`,
    contentHash: "a".repeat(64),
    reference: {
      schemaVersion: 1,
      fingerprint: "b".repeat(64),
      nonce: "00000000-0000-4000-8000-000000000001",
    },
  }), true);
  assert.equal(Check(lifecycleGet.parameters, {
    lifecycleKey,
    phase: "plan",
    artifactId: "00000000-0000-4000-8000-000000000001",
    recordKey: `${lifecycleKey}:plan:0123456789ab`,
    contentHash: "a".repeat(64),
    reference: {
      schemaVersion: 1,
      fingerprint: "b".repeat(64),
      nonce: "00000000-0000-4000-8000-000000000001",
    },
    summary: "Verified plan descriptor.",
  }), true);
  for (const length of [63, 65]) {
    assert.equal(Check(lifecycleGet.parameters, {
      lifecycleKey,
      phase: "plan",
      artifactId: "00000000-0000-4000-8000-000000000001",
      recordKey: `${lifecycleKey}:plan:0123456789ab`,
      contentHash: "a".repeat(length),
      reference: {
        schemaVersion: 1,
        fingerprint: "b".repeat(64),
        nonce: "00000000-0000-4000-8000-000000000001",
      },
    }), false);
  }
  assert.equal(Check(lifecycleGet.parameters, {
    lifecycleKey,
    phase: "plan",
    artifactId: "00000000-0000-4000-8000-000000000001",
    recordKey: `${lifecycleKey}:plan:0123456789ab`,
    contentHash: "a".repeat(64),
    reference: {
      schemaVersion: 1,
      fingerprint: "b".repeat(64),
      nonce: "00000000-0000-4000-8000-000000000001",
    },
    provider: "qdrant",
  }), false);
  assert.equal(Check(recovery.parameters, {
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: "00000000-0000-4000-8000-000000000001",
  }), true);
  assert.equal(Check(recovery.parameters, {
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: "00000000-0000-4000-8000-000000000001",
    origin: "https://untrusted.example",
  }), false);
  assert.equal(Check(recovery.parameters, {
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
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
    ...rootedLifecycleIdentity,
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
    identity: rootedLifecycleIdentity,
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
    { lifecycleKey, phase: "document", limit: 20 },
    { lifecycleKey, phase: "closeout", limit: 20 },
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
    identity: rootedLifecycleIdentity,
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
    identity: rootedLifecycleIdentity,
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
    lifecycleRootMemoryId: "00000000-0000-5000-8000-000000000230",
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
    identity: rootedLifecycleIdentity,
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
    identity: rootedLifecycleIdentity,
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
    identity: rootedLifecycleIdentity,
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
      identity: rootedLifecycleIdentity,
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
    identity: rootedLifecycleIdentity,
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
    identity: rootedLifecycleIdentity,
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

const localLifecycleRequest = (type = "plan", lifecycleRootMemoryId = "") => ({
  type,
  identity: { ...identity, lifecycleRootMemoryId },
  summary: `${type} evidence is exact before lifecycle provider pinning.`,
  artifact: `# ${type}\n\nSynthetic lifecycle provider evidence.`,
});

const bookStackRecoveryPlacement = {
  projectSlug: identity.project,
  sourceRef: identity.sourceRefs[0],
  lifecycleKey,
  shelfId: 1,
  shelfSlug: "lifecycle-artifacts",
  bookId: 2,
  bookSlug: identity.project,
  chapterId: 3,
  chapterSlug: `taskwarrior-${identity.taskwarriorUuid}`,
};

const createBookStackRecoveryClient = (options = {}) => {
  const pages = structuredClone(options.pages ?? []);
  let posts = 0;
  let lists = 0;
  let nextPageId = 10;
  const createCalls = [];
  return {
    origin: "https://bookstack.example",
    listPages: async () => {
      lists += 1;
      return pages.map((page) => structuredClone(page));
    },
    readShelf: async () => ({
      id: 1,
      name: "Lifecycle",
      slug: "lifecycle-artifacts",
      books: [2],
    }),
    readBook: async () => ({ id: 2, name: "IMA Pi", slug: "ima-pi" }),
    readChapter: async () => ({
      id: 3,
      name: bookStackRecoveryPlacement.chapterSlug,
      slug: bookStackRecoveryPlacement.chapterSlug,
      bookId: 2,
    }),
    readPage: async (id) => structuredClone(pages.find((page) => page.id === id)),
    createPage: async (name, chapterId, markdown) => {
      posts += 1;
      createCalls.push({ name, chapterId, markdown });
      if (options.failPost) throw new Error("token=synthetic-secret");
      const page = {
        id: nextPageId++,
        name,
        slug: name,
        bookId: 2,
        chapterId,
        markdown,
        revisionCount: 1,
        updatedAt: "2026-09-30T00:00:00.000Z",
        creatorId: 7,
        updaterId: 8,
      };
      pages.push(page);
      return structuredClone(page);
    },
    seedPage: (page) => { pages.push(structuredClone(page)); },
    posts: () => posts,
    lists: () => lists,
    createCalls: () => structuredClone(createCalls),
  };
};

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

const SKYNET_230_LIFECYCLE_KEY = "ima-pi:plane:ima:SKYNET-230";
const SKYNET_230_SOURCE = "plane:ima:SKYNET-230";
const SKYNET_230_TIMESTAMP = "2026-10-01T00:00:00.000Z";
const skyNet230Identity = ({
  lifecycleRootMemoryId = "",
  priorArtifactIds = [],
} = {}) => ({
  project: "ima-pi",
  lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
  lifecycleRootMemoryId,
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  planeWorkspace: "ima",
  planeWorkItem: "SKYNET-230",
  sourceRefs: [SKYNET_230_SOURCE],
  priorArtifactIds,
});

const lifecycleReadRequestFor = (phase, label, identity = {}) => {
  const request = validateLifecycleWriteRequest({
    type: phase,
    identity: skyNet230Identity(identity),
    summary: `${phase} SKYNET-230 synthetic lifecycle evidence ${label}.`,
    artifact: `# ${phase}\n\nSynthetic SKYNET-230 lifecycle evidence ${label}.`,
  });
  assert.equal(request.valid, true, `valid ${phase} fixture ${label}`);
  if (!request.valid) throw new Error(`invalid ${phase} fixture ${label}`);
  return request;
};

const lifecycleReadRecordFor = ({ provider, request, root, pageId = 1 }) => {
  if (provider === "serena") {
    const project = createSerenaLifecycleProject({
      projectName: "skynet-230-read-tests",
      projectPath: root,
    });
    assert.ok(project);
    const stored = createSerenaLifecycleRecord({
      request: {
        type: request.type,
        identity: request.identity,
        summary: request.summary,
        artifact: request.artifact,
      },
      project,
      createdAt: SKYNET_230_TIMESTAMP,
    });
    assert.ok(stored);
    return {
      provider,
      artifactId: stored.artifactId,
      recordKey: stored.recordKey,
      lifecycleKey: stored.lifecycleKey,
      phase: stored.phase,
      summary: stored.summary,
      artifact: stored.artifact,
      reference: stored.reference,
      createdAt: stored.createdAt,
    };
  }

  const prepared = prepareLifecycleArtifact(request);
  assert.equal(prepared.valid, true, `prepared ${provider} read fixture`);
  if (!prepared.valid) throw new Error(`unprepared ${provider} read fixture`);
  const contentHash = createHash("sha256").update(prepared.data.artifact, "utf8").digest("hex");
  const recordId = deriveRecordId(prepared.data.recordKey);
  assert.equal(recordId.success, true, `derived ${provider} read fixture ID`);
  if (!recordId.success) throw new Error(`underived ${provider} read fixture ID`);
  const artifactId = provider === "qdrant" ? recordId.data : prepared.data.nonce;
  const reference = provider === "qdrant"
    ? {
      schemaVersion: 1,
      provider,
      artifactId,
      recordKey: prepared.data.recordKey,
      contentHash,
      lifecycleKey: request.identity.lifecycleKey,
      phase: request.type,
      nonce: prepared.data.nonce,
    }
    : provider === "markdown"
      ? {
        schemaVersion: 1,
        provider,
        checkoutRoot: root,
        lifecycleKey: request.identity.lifecycleKey,
        phase: request.type,
        artifactId,
        contentHash,
        receiptHash: "a".repeat(64),
      }
      : {
        projectSlug: "ima-pi",
        sourceRef: SKYNET_230_SOURCE,
        lifecycleKey: request.identity.lifecycleKey,
        shelfId: 1,
        shelfSlug: "lifecycle-artifacts",
        bookId: 2,
        bookSlug: "ima-pi",
        chapterId: 3,
        chapterSlug: "skynet-230",
        pageId,
        pageSlug: `${request.type}-${artifactId}`,
        originFingerprint: "b".repeat(64),
        artifactId,
        recordKey: prepared.data.recordKey,
        contentHash,
        pageHash: "c".repeat(64),
        revisionCount: 1,
        updatedAt: SKYNET_230_TIMESTAMP,
      };
  return {
    provider,
    artifactId,
    recordKey: prepared.data.recordKey,
    lifecycleKey: request.identity.lifecycleKey,
    phase: request.type,
    summary: request.summary,
    artifact: prepared.data.artifact,
    reference,
    createdAt: null,
  };
};

const lifecycleReadDescriptorFor = (record) => {
  const reference = lifecycleReadReferenceFor(record);
  assert.ok(reference, "valid routed record has a closed public read reference");
  return {
    lifecycleKey: record.lifecycleKey,
    phase: record.phase,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    contentHash: createHash("sha256").update(record.artifact, "utf8").digest("hex"),
    reference,
  };
};

const lifecycleReadSelectorFor = (record) => ({
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  artifactId: record.artifactId,
});

const pinLifecycleReadAuthority = async (root, provider, initial) => {
  const attempt = createLifecycleProviderPinAttempt({
    lifecycleKey: initial.lifecycleKey,
    provider,
    attemptId: "00000000-0000-4000-8000-000000000230",
    startedAt: SKYNET_230_TIMESTAMP,
  });
  assert.ok(attempt);
  const started = await beginLifecyclePinWith(async () => root)(root, attempt);
  assert.equal(started.status, "started");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, attempt);
  assert.equal(writing.status, "writing");
  const pin = createLifecycleProviderPin({
    lifecycleKey: initial.lifecycleKey,
    provider,
    initialReference: initial.reference,
    artifactId: initial.artifactId,
    recordKey: initial.recordKey,
    pinnedAt: SKYNET_230_TIMESTAMP,
  });
  assert.ok(pin);
  const confirmed = await confirmLifecyclePinWith(async () => root)(root, writing.attempt, pin);
  assert.equal(confirmed.status, "pinned");
  return pin;
};

const lifecycleReadRoutingFor = ({ provider, initial, target, records, onGet, onReconcile }) => {
  const calls = [];
  const fallbackCalls = [];
  const fallbackProvider = provider === "qdrant" ? "markdown" : "qdrant";
  const adapter = {
    provider,
    persist: async () => {
      calls.push({ operation: "persist" });
      return {
        status: "blocked",
        provider,
        code: "read_only_fixture",
        writeState: "no-write",
      };
    },
    reconcile: async (reference, signal) => {
      calls.push({ operation: "reconcile", reference: structuredClone(reference), signal });
      if (onReconcile) await onReconcile({ reference, signal });
      return { status: "verified", record: structuredClone(initial) };
    },
    get: async (reference, signal) => {
      calls.push({ operation: "get", reference: structuredClone(reference), signal });
      if (onGet) await onGet({ reference, signal });
      return { status: "verified", record: structuredClone(target) };
    },
    recall: async (selection, signal) => {
      calls.push({ operation: "recall", selection: structuredClone(selection), signal });
      return {
        status: "verified",
        provider,
        records: records
          .filter((record) => record.lifecycleKey === selection.lifecycleKey
            && (selection.phase === undefined || record.phase === selection.phase))
          .slice(0, selection.limit)
          .map((record) => structuredClone(record)),
      };
    },
  };
  const fallback = {
    provider: fallbackProvider,
    persist: async () => { fallbackCalls.push("persist"); throw new Error("fallback must not run"); },
    reconcile: async () => { fallbackCalls.push("reconcile"); throw new Error("fallback must not run"); },
    get: async () => { fallbackCalls.push("get"); throw new Error("fallback must not run"); },
    recall: async () => { fallbackCalls.push("recall"); throw new Error("fallback must not run"); },
  };
  return { routing: createLifecycleRouting([adapter, fallback]), calls, fallbackCalls };
};

const bookStackPublicReadFixture = async (t) => {
  const root = await pinTestRoot(t);
  const origin = "https://bookstack.test";
  const placement = {
    projectSlug: "ima-pi",
    sourceRef: SKYNET_230_SOURCE,
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    shelfId: 1,
    shelfSlug: "lifecycle-artifacts",
    bookId: 2,
    bookSlug: "ima-pi",
    chapterId: 3,
    chapterSlug: "skynet-230",
  };
  const pageFor = (id, record) => ({
    id,
    name: `${record.phase}-${record.artifactId}`,
    slug: `${record.phase}-${record.artifactId}`,
    book_id: placement.bookId,
    chapter_id: placement.chapterId,
    markdown: record.pageMarkdown,
    revision_count: 1,
    updated_at: SKYNET_230_TIMESTAMP,
    created_by: { id: 7 },
    updated_by: { id: 8 },
  });
  const routedFor = (record, page) => ({
    provider: "bookstack",
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    lifecycleKey: record.lifecycleKey,
    phase: record.phase,
    summary: record.summary,
    artifact: record.artifact,
    reference: {
      ...placement,
      pageId: page.id,
      pageSlug: page.slug,
      originFingerprint: originFingerprint(origin),
      artifactId: record.artifactId,
      recordKey: record.recordKey,
      contentHash: record.contentHash,
      pageHash: digestBookStackValue(page.markdown),
      revisionCount: page.revision_count,
      updatedAt: page.updated_at,
    },
    createdAt: null,
  });
  const requestFor = (phase, label, lifecycleRootMemoryId = "") => {
    const request = lifecycleReadRequestFor(phase, label, { lifecycleRootMemoryId });
    return {
      type: request.type,
      identity: request.identity,
      summary: request.summary,
      artifact: request.artifact,
    };
  };
  const initialRecord = createLifecycleRecord({
    request: requestFor("plan", "bookstack-public-read-initial"),
    placement,
  });
  const targetRecord = createLifecycleRecord({
    request: requestFor(
      "implementation",
      "bookstack-public-read-target",
      initialRecord.artifactId,
    ),
    placement,
  });
  const initialPage = pageFor(1796, initialRecord);
  const targetPage = pageFor(1797, targetRecord);
  const initial = routedFor(initialRecord, initialPage);
  const target = routedFor(targetRecord, targetPage);
  await pinLifecycleReadAuthority(root, "bookstack", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  return {
    root,
    registry,
    placement,
    initialRecord,
    before: await readFile(registry, "utf8"),
    environment: {
      BOOKSTACK_BASE_URL: origin,
      BOOKSTACK_TOKEN_ID: "test-token-id",
      BOOKSTACK_TOKEN_SECRET: "test-token-secret",
    },
    shelf: { id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] },
    book: { id: 2, name: "IMA Pi", slug: "ima-pi" },
    chapter: { id: 3, name: "skynet-230", slug: "skynet-230", book_id: 2 },
    pages: [initialPage, targetPage],
    targetPage,
    descriptor: lifecycleReadDescriptorFor(target),
  };
};

const bookStackPublicReadTransport = (fixture, shouldBlock = () => false) => {
  const calls = [];
  let blockedSignal;
  let rejectBlocked;
  let resolveBlocked;
  let blocked = false;
  let transportAborts = 0;
  const pending = new Promise((resolve) => { resolveBlocked = resolve; });
  const json = (value) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const list = (value) => json({ total: value.length, data: value });
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = {
      origin: url.origin,
      pathname: url.pathname,
      method: init.method ?? "GET",
      signal: init.signal,
    };
    calls.push(call);
    if (!blocked && shouldBlock(call)) {
      blocked = true;
      blockedSignal = call.signal;
      resolveBlocked();
      return new Promise((resolve, reject) => {
        rejectBlocked = reject;
        const abort = () => {
          transportAborts += 1;
          reject(blockedSignal?.reason ?? new Error("missing BookStack abort reason"));
        };
        if (!blockedSignal) {
          reject(new Error("BookStack transport signal was missing"));
          return;
        }
        if (blockedSignal.aborted) {
          abort();
          return;
        }
        blockedSignal.addEventListener("abort", abort, { once: true });
      });
    }
    if (call.origin !== "https://bookstack.test" || call.method !== "GET") {
      return new Response("unexpected request", { status: 404 });
    }
    if (call.pathname === "/api/shelves") return list([fixture.shelf]);
    if (call.pathname === "/api/books") return list([fixture.book]);
    if (call.pathname === "/api/chapters") return list([fixture.chapter]);
    if (call.pathname === "/api/pages") return list(fixture.pages);
    if (call.pathname === "/api/shelves/1") return json(fixture.shelf);
    if (call.pathname === "/api/books/2") return json(fixture.book);
    if (call.pathname === "/api/chapters/3") return json(fixture.chapter);
    const pageId = /^\/api\/pages\/(\d+)$/.exec(call.pathname)?.[1];
    const page = pageId ? fixture.pages.find((candidate) => candidate.id === Number(pageId)) : null;
    return page ? json(page) : new Response("not found", { status: 404 });
  };
  return {
    fetch,
    calls,
    pending,
    blockedSignal: () => blockedSignal,
    cancel: (reason) => rejectBlocked?.(reason),
    transportAborts: () => transportAborts,
  };
};

test("rejects a rootless downstream BookStack recovery before provider effects", async (t) => {
  const root = await pinTestRoot(t);
  const client = createBookStackRecoveryClient();
  const result = await coordinateBookStackLifecycleRecovery({
    request: localLifecycleRequest("implementation"),
    placement: bookStackRecoveryPlacement,
    attemptId: "00000000-0000-4000-8000-000000000001",
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => true,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_initial_root_required");
  assert.equal(client.lists(), 0);
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "absent");
});

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

test("lifecycle context blocks pending and corrupt pin anchors before provider effects", async (t) => {
  for (const scenario of ["pending", "corrupt"]) {
    const root = await pinTestRoot(t);
    if (scenario === "pending") {
      await authorizedPinAttempt(root);
    } else {
      await mkdir(join(root, ".ima-cycle"), { recursive: true });
      await writeFile(join(root, ".ima-cycle", "provider-pins.json"), "{", "utf8");
    }
    const access = corpusAccessCounter();
    let sessionCalls = 0;
    const result = await coordinateContext({
      source: { type: "lifecycle", key: lifecycleKey },
    }, root, {
      canonical: async (path) => path,
      corpus: access.corpus,
      resolveProjectRoot: async () => root,
      session: async () => {
        sessionCalls += 1;
        throw new Error("Serena must not run for an invalid pin anchor");
      },
    });

    assert.equal(result.status, "failed", scenario);
    assert.equal(result.source, null, scenario);
    assert.deepEqual(result.diagnostics, [{
      code: "pinned_provider_unavailable",
      stage: "lifecycle",
      message: "Pinned lifecycle provider could not verify authoritative evidence.",
    }], scenario);
    assert.equal(access.calls(), 0, scenario);
    assert.equal(sessionCalls, 0, scenario);
  }
});

test("lifecycle context cancellation stops an in-flight pin-anchor read without fallback", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "context-anchor-cancellation"),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const access = corpusAccessCounter();
  let sessionCalls = 0;
  const controller = new AbortController();
  const reason = new Error("context anchor read cancelled");
  let startReconcile;
  const reconcileStarted = new Promise((resolve) => { startReconcile = resolve; });
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target: initial,
    records: [initial],
    onReconcile: async ({ signal }) => {
      startReconcile();
      if (!signal) throw new Error("missing lifecycle anchor signal");
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  const pending = coordinateContext({
    source: { type: "lifecycle", key: SKYNET_230_LIFECYCLE_KEY },
  }, root, {
    canonical: async (path) => path,
    corpus: access.corpus,
    routing: route.routing,
    resolveProjectRoot: async () => root,
    session: async () => {
      sessionCalls += 1;
      throw new Error("Serena fallback is forbidden after anchor cancellation");
    },
  }, controller.signal);

  await reconcileStarted;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile"]);
  assert.deepEqual(route.fallbackCalls, []);
  assert.equal(await readFile(registry, "utf8"), before);
  assert.equal(access.calls(), 0);
  assert.equal(sessionCalls, 0);
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
  const continued = await coordinateLifecycle(
    localLifecycleRequest("implementation", pin.pin.artifactId),
    localRoutingOptions(root, routing),
  );
  assert.equal(continued.status, "completed");
  assert.equal(calls.qdrant.filter(({ operation }) => operation === "persist").length, 2);
  assert.deepEqual(calls.markdown, []);

  const conflict = await coordinateLifecycle({
    ...localLifecycleRequest("test", pin.pin.artifactId),
    provider: "markdown",
  }, localRoutingOptions(root, routing));
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.error.code, "lifecycle_provider_pin_conflict");
  assert.equal(calls.qdrant.filter(({ operation }) => operation === "persist").length, 2);
  assert.deepEqual(calls.markdown, []);
});

test("persists a rootless decision seed while rejecting rootless downstream first writes before provider mutation", async (t) => {
  const root = await pinTestRoot(t);
  const local = localRouting();
  const decision = await coordinateLifecycle({
    ...localLifecycleRequest("decision"),
    provider: "qdrant",
  }, localRoutingOptions(root, local.routing));
  assert.equal(decision.status, "completed");
  assert.equal(typeof decision.artifactId, "string");
  if (typeof decision.artifactId !== "string") return;

  const pin = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pin.status, "pinned");
  if (pin.status !== "pinned") return;
  assert.equal(pin.pin.artifactId, decision.artifactId);

  const technicalPlan = await coordinateLifecycle(
    localLifecycleRequest("plan", decision.artifactId),
    localRoutingOptions(root, local.routing),
  );
  assert.equal(technicalPlan.status, "completed");
  const closeout = await coordinateLifecycle(
    localLifecycleRequest("closeout", decision.artifactId),
    localRoutingOptions(root, local.routing),
  );
  assert.equal(closeout.status, "completed");
  assert.deepEqual(
    local.calls.qdrant
      .filter(({ operation }) => operation === "persist")
      .map(({ type }) => type),
    ["decision", "plan", "closeout"],
  );
  assert.deepEqual(local.calls.markdown, []);

  const planFirstRoot = await pinTestRoot(t);
  const planFirst = localRouting();
  const plan = await coordinateLifecycle({
    ...localLifecycleRequest("plan"),
    provider: "qdrant",
  }, localRoutingOptions(planFirstRoot, planFirst.routing));
  assert.equal(plan.status, "completed");
  assert.equal(
    (await loadLifecyclePinStateWith(async () => planFirstRoot)(planFirstRoot, lifecycleKey)).status,
    "pinned",
  );

  const rejectionRoot = await pinTestRoot(t);
  const rejected = localRouting();
  let confirmations = 0;
  for (const phase of [
    "implementation",
    "test",
    "review",
    "resolution",
    "rereview",
    "document",
    "closeout",
  ]) {
    const result = await coordinateLifecycle({
      ...localLifecycleRequest(phase),
      provider: "qdrant",
    }, localRoutingOptions(rejectionRoot, rejected.routing, {
      confirmProvider: async () => {
        confirmations += 1;
        return true;
      },
    }));
    assert.equal(result.status, "failed", phase);
    assert.equal(result.error.code, "lifecycle_initial_root_required", phase);
  }
  assert.equal(confirmations, 0);
  assert.deepEqual(rejected.calls, { qdrant: [], markdown: [] });
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => rejectionRoot)(rejectionRoot, lifecycleKey),
    { status: "absent" },
  );
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
  assert.equal(mismatched.writeState, "possible-write");
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

test("REVIEW-001 retains provisioning writes when a lifecycle page POST is rejected before dispatch", async (t) => {
  const queueRejectedClient = (preprovisioned, existingPages = []) => {
    const shelves = preprovisioned
      ? [{ id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] }]
      : [];
    const books = preprovisioned
      ? [{ id: 2, name: "ima-pi", slug: "ima-pi" }]
      : [];
    const chapters = preprovisioned
      ? [{ id: 3, name: bookStackRecoveryPlacement.chapterSlug, slug: bookStackRecoveryPlacement.chapterSlug, bookId: 2 }]
      : [];
    const pages = structuredClone(existingPages);
    const rejected = new AbortController();
    rejected.abort(new Error("page request rejected before dispatch"));
    const requester = createBookStackLifecycleJsonRequester(
      createBookStackLifecycleRequestScheduler({ now: () => 0, wait: async () => undefined }),
    );
    let pageAttempts = 0;
    let pagePosts = 0;
    let provisioningWrites = 0;
    const placementWrites = [];
    const page = () => requester({
      fetcher: async () => {
        pagePosts += 1;
        return new Response("must not dispatch", { status: 500 });
      },
      url: new URL("https://bookstack.example/api/pages"),
      init: { method: "POST" },
      signal: rejected.signal,
      timeoutMs: 60_000,
      maxResponseBytes: 4 * 1024 * 1024,
      failurePrefix: "bookstack",
    });
    return {
      client: {
        origin: "https://bookstack.example",
        listShelves: async () => shelves.map(({ books: _books, ...shelf }) => ({ ...shelf })),
        listBooks: async () => books.map((book) => ({ ...book })),
        listChapters: async () => chapters.map((chapter) => ({ ...chapter })),
        readShelf: async (id) => structuredClone(shelves.find((shelf) => shelf.id === id)),
        readBook: async (id) => structuredClone(books.find((book) => book.id === id)),
        readChapter: async (id) => structuredClone(chapters.find((chapter) => chapter.id === id)),
        listPages: async () => pages.map((page) => structuredClone(page)),
        readPage: async (id) => structuredClone(pages.find((page) => page.id === id)),
        createShelf: async (name) => {
          provisioningWrites += 1;
          placementWrites.push("create-shelf");
          const shelf = { id: 1, name, slug: name, books: [] };
          shelves.push(shelf);
          return structuredClone(shelf);
        },
        createBook: async (name) => {
          provisioningWrites += 1;
          placementWrites.push("create-book");
          const book = { id: 2, name, slug: name };
          books.push(book);
          return structuredClone(book);
        },
        replaceShelfBooks: async ({ shelfId, expectedBooks }) => {
          provisioningWrites += 1;
          placementWrites.push("replace-shelf-books");
          const shelf = shelves.find((candidate) => candidate.id === shelfId);
          shelf.books = [...expectedBooks];
          return structuredClone(shelf);
        },
        createChapter: async (name, bookId) => {
          provisioningWrites += 1;
          placementWrites.push("create-chapter");
          const chapter = { id: 3, name, slug: name, bookId };
          chapters.push(chapter);
          return structuredClone(chapter);
        },
        createPage: async () => {
          pageAttempts += 1;
          return page();
        },
      },
      pageAttempts: () => pageAttempts,
      pagePosts: () => pagePosts,
      provisioningWrites: () => provisioningWrites,
      placementWrites: () => [...placementWrites],
    };
  };

  for (const scenario of [
    { name: "provisioning", preprovisioned: false, writes: 4, pin: "pending", possibleWrite: true },
    { name: "reused read-only placement", preprovisioned: true, writes: 0, pin: "absent", possibleWrite: false },
  ]) {
    const root = await pinTestRoot(t);
    const fixture = queueRejectedClient(scenario.preprovisioned);
    const corpus = noHistoricalLifecycleCorpus;
    const result = await coordinateLifecycle({
      ...localLifecycleRequest(),
      provider: "bookstack",
    }, {
      cwd: root,
      corpus,
      bookStackLifecycleClient: fixture.client,
      environment: {},
      resolveProjectRoot: async () => root,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
      confirmProvider: async () => true,
      confirmBookStackPlacement: async () => true,
    });

    assert.equal(result.status, "failed", scenario.name);
    assert.equal(result.provider, "bookstack", scenario.name);
    assert.equal(result.writeState === "possible-write", scenario.possibleWrite, scenario.name);
    assert.equal(fixture.provisioningWrites(), scenario.writes, scenario.name);
    assert.deepEqual(
      fixture.placementWrites(),
      scenario.preprovisioned
        ? []
        : ["create-shelf", "create-book", "replace-shelf-books", "create-chapter"],
      scenario.name,
    );
    assert.equal(fixture.pageAttempts(), 1, scenario.name);
    assert.equal(fixture.pagePosts(), 0, scenario.name);
    const state = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    assert.equal(state.status, scenario.pin, scenario.name);
    if (scenario.possibleWrite) {
      assert.equal(Object.hasOwn(result, "recommendation"), false, scenario.name);
      assert.equal(state.status, "pending", scenario.name);
      if (state.status === "pending") assert.equal(state.attempt.status, "writing", scenario.name);
    }
  }

  const root = await pinTestRoot(t);
  const initialRequest = localLifecycleRequest();
  const initialRecord = createLifecycleRecord({
    request: initialRequest,
    placement: bookStackRecoveryPlacement,
  });
  const initialPage = {
    id: 9,
    name: `${initialRecord.phase}-${initialRecord.artifactId}`,
    slug: `${initialRecord.phase}-${initialRecord.artifactId}`,
    bookId: bookStackRecoveryPlacement.bookId,
    chapterId: bookStackRecoveryPlacement.chapterId,
    markdown: initialRecord.pageMarkdown,
    revisionCount: 1,
    updatedAt: "2026-10-02T00:00:00.000Z",
    creatorId: 7,
    updaterId: 8,
  };
  const pinnedFixture = queueRejectedClient(true, [initialPage]);
  const initial = {
    provider: "bookstack",
    artifactId: initialRecord.artifactId,
    recordKey: initialRecord.recordKey,
    lifecycleKey,
    phase: initialRecord.phase,
    summary: initialRecord.summary,
    artifact: initialRecord.artifact,
    reference: {
      ...bookStackRecoveryPlacement,
      pageId: initialPage.id,
      pageSlug: initialPage.slug,
      originFingerprint: originFingerprint(pinnedFixture.client.origin),
      artifactId: initialRecord.artifactId,
      recordKey: initialRecord.recordKey,
      contentHash: initialRecord.contentHash,
      pageHash: digestBookStackValue(initialRecord.pageMarkdown),
      revisionCount: initialPage.revisionCount,
      updatedAt: initialPage.updatedAt,
    },
    createdAt: null,
  };
  await pinLifecycleReadAuthority(root, "bookstack", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const pinnedResult = await coordinateLifecycle({
    ...localLifecycleRequest("implementation", initialRecord.artifactId),
    provider: "bookstack",
  }, {
    cwd: root,
    corpus: noHistoricalLifecycleCorpus,
    bookStackLifecycleClient: pinnedFixture.client,
    environment: {},
    resolveProjectRoot: async () => root,
    now: () => new Date("2026-10-02T00:00:00.000Z"),
    confirmProvider: async () => true,
    confirmBookStackPlacement: async () => true,
  });

  assert.equal(pinnedResult.status, "failed");
  assert.equal(pinnedResult.writeState, undefined);
  assert.equal(pinnedFixture.provisioningWrites(), 0);
  assert.deepEqual(pinnedFixture.placementWrites(), []);
  assert.equal(pinnedFixture.pageAttempts(), 1);
  assert.equal(pinnedFixture.pagePosts(), 0);
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "pinned");
  assert.equal(await readFile(registry, "utf8"), before);
});

test("REVIEW-002 forwards operation-local cancellation through initial and pinned BookStack persistence", async (t) => {
  const cancellableClient = () => {
    const shelf = { id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] };
    const book = { id: 2, name: "ima-pi", slug: "ima-pi" };
    const chapter = {
      id: 3,
      name: bookStackRecoveryPlacement.chapterSlug,
      slug: bookStackRecoveryPlacement.chapterSlug,
      book_id: 2,
    };
    const pages = [];
    const calls = [];
    const admissions = [];
    const transports = [];
    let current = 0;
    let blockNextPost = false;
    let signalPostStarted;
    let postStarted = Promise.resolve();
    const lane = createBookStackLifecycleRequestScheduler({
      now: () => current,
      wait: async (milliseconds) => { current += milliseconds; },
    });
    const client = createBookStackLifecycleClient({
      origin: "https://bookstack.example",
      tokenId: "test-id",
      tokenSecret: "test-secret",
      requestScheduler: {
        schedule: (input) => {
          admissions.push(input.signal);
          return lane.schedule(input);
        },
      },
      fetch: async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? "GET";
        calls.push({ pathname: url.pathname, method, signal: init.signal });
        const json = (value) => new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        const list = (data) => json({ total: data.length, data });
        if (method === "GET" && url.pathname === "/api/shelves") return list([shelf]);
        if (method === "GET" && url.pathname === "/api/books") return list([book]);
        if (method === "GET" && url.pathname === "/api/chapters") return list([chapter]);
        if (method === "GET" && url.pathname === "/api/pages") return list(pages);
        if (method === "GET" && url.pathname === "/api/shelves/1") return json(shelf);
        if (method === "GET" && url.pathname === "/api/books/2") return json(book);
        if (method === "GET" && url.pathname === "/api/chapters/3") return json(chapter);
        const pageId = /^\/api\/pages\/(\d+)$/.exec(url.pathname)?.[1];
        if (method === "GET" && pageId) {
          const page = pages.find((candidate) => candidate.id === Number(pageId));
          return page ? json(page) : new Response("not found", { status: 404 });
        }
        if (method === "POST" && url.pathname === "/api/pages") {
          const body = JSON.parse(String(init.body));
          if (blockNextPost) {
            const signal = init.signal;
            transports.push(signal);
            signalPostStarted?.();
            return new Promise((_resolve, reject) => {
              const abort = () => reject(signal?.reason ?? new Error("missing abort reason"));
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
            });
          }
          const page = {
            id: pages.length + 10,
            name: body.name,
            slug: body.name,
            book_id: 2,
            chapter_id: 3,
            markdown: body.markdown,
            revision_count: 1,
            updated_at: "2026-10-03T00:00:00.000Z",
            created_by: { id: 7 },
            updated_by: { id: 8 },
          };
          pages.push(page);
          return json(page);
        }
        return new Response("unexpected request", { status: 404 });
      },
    });
    return {
      client,
      calls,
      admissions,
      transports,
      armPostCancellation: () => {
        blockNextPost = true;
        postStarted = new Promise((resolve) => { signalPostStarted = resolve; });
      },
      postStarted: () => postStarted,
      reset: () => {
        calls.length = 0;
        admissions.length = 0;
        transports.length = 0;
      },
    };
  };

  for (const mode of ["initial", "pinned"]) {
    const root = await pinTestRoot(t);
    const fixture = cancellableClient();
    const corpus = noHistoricalLifecycleCorpus;
    const supplied = {
      cwd: root,
      corpus,
      bookStackLifecycleClient: fixture.client,
      environment: {},
      resolveProjectRoot: async () => root,
      now: () => new Date("2026-10-03T00:00:00.000Z"),
      confirmProvider: async () => true,
      confirmBookStackPlacement: async () => true,
    };
    let request = { ...localLifecycleRequest(), provider: "bookstack" };
    let pinBefore = null;
    if (mode === "pinned") {
      const initial = await coordinateLifecycle(request, supplied);
      assert.equal(initial.status, "completed", mode);
      assert.ok(initial.artifactId, mode);
      request = {
        ...localLifecycleRequest("implementation", initial.artifactId),
        provider: "bookstack",
      };
      pinBefore = await readFile(join(root, ".ima-cycle", "provider-pins.json"), "utf8");
      fixture.reset();
    }

    fixture.armPostCancellation();
    const controller = new AbortController();
    const pending = coordinateLifecycle(request, supplied, controller.signal);
    await fixture.postStarted();
    const activeTransport = fixture.transports[0];
    assert.ok(activeTransport, mode);
    assert.equal(fixture.admissions.every((signal) => signal === controller.signal), true, mode);
    const callsBeforeAbort = fixture.calls.length;
    controller.abort(new Error(`${mode} persistence cancelled`));
    const result = await pending;

    assert.equal(activeTransport.aborted, true, mode);
    assert.equal(result.status, "failed", mode);
    assert.equal(result.provider, "bookstack", mode);
    assert.equal(result.writeState, "possible-write", mode);
    assert.equal(fixture.calls.length, callsBeforeAbort, mode);
    assert.equal(fixture.calls.at(-1)?.method, "POST", mode);
    assert.equal(fixture.calls.every(({ signal }) => signal && typeof signal.aborted === "boolean"), true, mode);

    const unrelated = new AbortController();
    await fixture.client.listPages(unrelated.signal);
    assert.equal(fixture.admissions.at(-1), unrelated.signal, mode);
    assert.equal(fixture.calls.at(-1)?.pathname, "/api/pages", mode);
    assert.equal(fixture.calls.at(-1)?.signal?.aborted, false, mode);

    const state = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    if (mode === "initial") {
      assert.equal(state.status, "pending", mode);
      if (state.status === "pending") assert.equal(state.attempt.status, "writing", mode);
    } else {
      assert.equal(state.status, "pinned", mode);
      assert.equal(await readFile(join(root, ".ima-cycle", "provider-pins.json"), "utf8"), pinBefore, mode);
    }
  }
});

test("continues a verified BookStack pin without selecting, confirming placement, or provisioning", async (t) => {
  const root = await pinTestRoot(t);
  const originalFetch = globalThis.fetch;
  const environmentKeys = ["BOOKSTACK_BASE_URL", "BOOKSTACK_ORIGIN", "BOOKSTACK_TOKEN_ID", "BOOKSTACK_TOKEN_SECRET"];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const environment = {
    BOOKSTACK_BASE_URL: "https://bookstack.test",
    BOOKSTACK_ORIGIN: "https://bookstack.test",
    BOOKSTACK_TOKEN_ID: "test-token-id",
    BOOKSTACK_TOKEN_SECRET: "test-token-secret",
  };
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
  });

  const shelf = { id: 1, name: "Lifecycle artifacts", slug: "lifecycle-artifacts", books: [2] };
  const book = { id: 2, name: "ima-pi", slug: "ima-pi" };
  const chapter = {
    id: 3,
    name: `taskwarrior-${identity.taskwarriorUuid}`,
    slug: `taskwarrior-${identity.taskwarriorUuid}`,
    book_id: 2,
  };
  const pages = [];
  const calls = [];
  let stage = "first-use";
  const json = (value) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ stage, origin: url.origin, pathname: url.pathname, method, body });
    const list = (data) => json({ total: data.length, data });
    if (method === "GET" && ["/api/shelves", "/api/books", "/api/chapters"].includes(url.pathname)) {
      if (stage === "continuation") return new Response("ensure placement is forbidden", { status: 500 });
      return url.pathname === "/api/shelves"
        ? list([shelf])
        : url.pathname === "/api/books"
          ? list([book])
          : list([chapter]);
    }
    if (method === "GET" && url.pathname === "/api/shelves/1") return json(shelf);
    if (method === "GET" && url.pathname === "/api/books/2") return json(book);
    if (method === "GET" && url.pathname === "/api/chapters/3") return json(chapter);
    if (method === "GET" && url.pathname === "/api/pages") return list(pages);
    const pageId = /^\/api\/pages\/(\d+)$/.exec(url.pathname)?.[1];
    if (method === "GET" && pageId) {
      const page = pages.find((candidate) => candidate.id === Number(pageId));
      return page ? json(page) : new Response("not found", { status: 404 });
    }
    if (method === "POST" && url.pathname === "/api/pages" && body?.chapter_id === chapter.id) {
      const page = {
        id: pages.length + 4,
        name: body.name,
        slug: body.name,
        book_id: book.id,
        chapter_id: chapter.id,
        markdown: body.markdown,
        revision_count: 1,
        updated_at: "2026-08-31T12:00:00.000Z",
        created_by: { id: 7 },
        updated_by: { id: 8 },
      };
      pages.push(page);
      return json(page);
    }
    return new Response("unexpected request", { status: 404 });
  };

  let providerConfirmations = 0;
  let placementConfirmations = 0;
  const first = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "bookstack",
  }, {
    cwd: root,
    corpus: noHistoricalLifecycleCorpus,
    environment,
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
  assert.equal(first.status, "completed");
  assert.equal(providerConfirmations, 1);
  assert.equal(placementConfirmations, 1);
  assert.equal(pages.length, 1);

  const pinned = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pinned.status, "pinned");
  if (pinned.status !== "pinned") return;
  assert.equal(pinned.pin.provider, "bookstack");
  assert.deepEqual({
    shelfId: pinned.pin.initialReference.shelfId,
    bookId: pinned.pin.initialReference.bookId,
    chapterId: pinned.pin.initialReference.chapterId,
  }, {
    shelfId: shelf.id,
    bookId: book.id,
    chapterId: chapter.id,
  });
  assert.equal(
    pinned.pin.initialReference.originFingerprint,
    originFingerprint("https://bookstack.test"),
  );
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const pinBeforeContinuation = await readFile(registry, "utf8");

  stage = "continuation";
  calls.length = 0;
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.ok(lifecycle);
  let selections = 0;
  let confirmations = 0;
  const continued = await lifecycle.execute(
    "test",
    localLifecycleRequest("implementation", pinned.pin.artifactId),
    undefined,
    undefined,
    {
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

  assert.equal(continued.details.status, "completed");
  assert.equal(continued.details.provider, "bookstack");
  assert.equal(selections, 0);
  assert.equal(confirmations, 0);
  assert.equal(calls.every((call) => call.origin === "https://bookstack.test"), true);
  assert.equal(calls.some((call) => ["/api/shelves", "/api/books", "/api/chapters"].includes(call.pathname)), false);
  for (const pathname of ["/api/shelves/1", "/api/books/2", "/api/chapters/3"]) {
    assert.equal(calls.some((call) => call.method === "GET" && call.pathname === pathname), true, pathname);
  }
  assert.deepEqual(
    calls.filter((call) => call.method !== "GET").map((call) => ({
      method: call.method,
      pathname: call.pathname,
      chapterId: call.body?.chapter_id,
    })),
    [{ method: "POST", pathname: "/api/pages", chapterId: chapter.id }],
  );
  assert.equal(pages.length, 2);
  assert.equal(await readFile(registry, "utf8"), pinBeforeContinuation);
});

test("rejects malformed BookStack recovery input before pin or provider effects", async (t) => {
  const root = await pinTestRoot(t);
  const client = createBookStackRecoveryClient();
  const result = await coordinateBookStackLifecycleRecovery({
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: "not-an-attempt-id",
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => true,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "bookstack_recovery_request_invalid");
  assert.equal(client.lists(), 0);
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "absent");
});

test("blocks a target empty-slug BookStack draft before confirmation or a recovery POST", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const request = localLifecycleRequest();
  const prepared = prepareLifecycleArtifact(request);
  assert.equal(prepared.valid, true);
  if (!prepared.valid) return;
  const client = createBookStackRecoveryClient({
    pages: [{ id: 9, name: `plan-${prepared.data.nonce}`, slug: "" }],
  });
  let confirmations = 0;
  const result = await coordinateBookStackLifecycleRecovery({
    request,
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => {
      confirmations += 1;
      return true;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(confirmations, 0);
  assert.equal(client.posts(), 0);
  const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pending.status, "pending");
  if (pending.status !== "pending") return;
  assert.equal(pending.attempt.status, "writing");
  assert.equal(pending.attempt.recoveryCheckpoint, undefined);
});

test("blocked ambiguous, unavailable, incomplete, and malformed recovery inputs retain writing authority", async (t) => {
  const request = localLifecycleRequest();
  const prepared = prepareLifecycleArtifact(request);
  assert.equal(prepared.valid, true);
  if (!prepared.valid) return;
  const target = `plan-${prepared.data.nonce}`;
  const scenarios = [
    {
      name: "ambiguous",
      client: () => createBookStackRecoveryClient({ pages: [
        { id: 9, name: target, slug: target },
        { id: 10, name: target, slug: target },
      ] }),
    },
    {
      name: "unavailable",
      client: () => {
        const client = createBookStackRecoveryClient();
        client.listPages = async () => { throw new Error("token=synthetic-secret"); };
        return client;
      },
    },
    {
      name: "incomplete",
      client: () => createBookStackRecoveryClient({ pages: [
        { id: 9, name: target, slug: target, bookId: 2, chapterId: 3 },
      ] }),
    },
    {
      name: "malformed",
      malformed: true,
      client: () => createBookStackRecoveryClient(),
    },
  ];

  for (const scenario of scenarios) {
    const root = await pinTestRoot(t);
    const authorized = await authorizedPinAttempt(root, "bookstack");
    const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
    assert.equal(writing.status, "writing", scenario.name);
    if (writing.status !== "writing") continue;
    const client = scenario.client();
    let confirmations = 0;
    const result = await coordinateBookStackLifecycleRecovery({
      request,
      placement: bookStackRecoveryPlacement,
      attemptId: writing.attempt.attemptId,
      ...(scenario.malformed ? { extra: true } : {}),
    }, {
      cwd: root,
      bookStackLifecycleClient: client,
      resolveProjectRoot: async () => root,
      confirmBookStackRecovery: async () => {
        confirmations += 1;
        return true;
      },
    });
    assert.equal(result.status, "failed", scenario.name);
    assert.equal(confirmations, 0, scenario.name);
    assert.equal(client.posts(), 0, scenario.name);
    const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    assert.equal(pending.status, "pending", scenario.name);
    if (pending.status !== "pending") continue;
    assert.equal(pending.attempt.status, "writing", scenario.name);
    assert.equal(pending.attempt.recoveryCheckpoint, undefined, scenario.name);
  }
});

test("blocks a changed BookStack writing attempt after confirmation without a recovery POST", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const replacement = createLifecycleProviderPinAttempt({
    lifecycleKey,
    provider: "bookstack",
    attemptId: "00000000-0000-4000-8000-000000000002",
    startedAt: "2026-08-31T12:00:01.000Z",
  });
  assert.ok(replacement);
  const client = createBookStackRecoveryClient();
  const result = await coordinateBookStackLifecycleRecovery({
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => {
      assert.deepEqual(
        await abandonLifecyclePinAttemptWith(async () => root)(root, writing.attempt),
        { status: "cleared" },
      );
      assert.equal((await beginLifecyclePinWith(async () => root)(root, replacement)).status, "started");
      assert.equal((await markLifecyclePinAttemptWritingWith(async () => root)(root, replacement)).status, "writing");
      return true;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_pin_attempt_conflict");
  assert.equal(client.posts(), 0);
  const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pending.status, "pending");
  if (pending.status !== "pending") return;
  assert.equal(pending.attempt.attemptId, replacement.attemptId);
  assert.equal(pending.attempt.status, "writing");
});

test("cancellation after checkpoint claim makes no later BookStack POST and retains writing", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const controller = new AbortController();
  const reason = new Error("BookStack recovery was cancelled after checkpoint claim.");
  const client = createBookStackRecoveryClient();
  const listPages = client.listPages;
  let discoveries = 0;
  client.listPages = async () => {
    const pages = await listPages();
    discoveries += 1;
    if (discoveries === 3) controller.abort(reason);
    return pages;
  };

  await coordinateBookStackLifecycleRecovery({
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => true,
  }, controller.signal).catch(() => undefined);
  assert.equal(discoveries, 3);
  assert.equal(client.posts(), 0);
  const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pending.status, "pending");
  if (pending.status !== "pending") return;
  assert.equal(pending.attempt.status, "writing");
  assert.ok(pending.attempt.recoveryCheckpoint);
});

test("concurrent confirmed BookStack recovery attempts issue at most one POST", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const client = createBookStackRecoveryClient();
  const createPage = client.createPage;
  let startPost;
  let releasePost;
  const postStarted = new Promise((resolve) => { startPost = resolve; });
  client.createPage = async (...args) => {
    startPost();
    await new Promise((resolve) => { releasePost = resolve; });
    return createPage(...args);
  };
  const input = {
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  };
  const first = coordinateBookStackLifecycleRecovery(input, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => true,
  });
  await postStarted;
  const second = await coordinateBookStackLifecycleRecovery(input, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => true,
  });
  releasePost();
  const firstResult = await first;

  assert.equal(firstResult.status, "completed");
  assert.equal(second.status, "failed");
  assert.equal(client.posts(), 1);
  const pinned = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pinned.status, "pinned");
});

test("BookStack recovery tool is TUI-confirmed and cannot provision, delete, or fall back", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const originalFetch = globalThis.fetch;
  const environmentKeys = ["BOOKSTACK_BASE_URL", "BOOKSTACK_ORIGIN", "BOOKSTACK_TOKEN_ID", "BOOKSTACK_TOKEN_SECRET"];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.BOOKSTACK_BASE_URL = "https://bookstack.test";
  process.env.BOOKSTACK_ORIGIN = "https://bookstack.test";
  process.env.BOOKSTACK_TOKEN_ID = "synthetic-token-id";
  process.env.BOOKSTACK_TOKEN_SECRET = "synthetic-token-secret";
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
  });

  const shelf = { id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] };
  const book = { id: 2, name: "IMA Pi", slug: "ima-pi" };
  const chapter = {
    id: 3,
    name: bookStackRecoveryPlacement.chapterSlug,
    slug: bookStackRecoveryPlacement.chapterSlug,
    book_id: 2,
  };
  const pages = [];
  const calls = [];
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ origin: url.origin, pathname: url.pathname, method });
    const list = (data) => json({ total: data.length, data });
    if (method === "GET" && url.pathname === "/api/shelves/1") return json(shelf);
    if (method === "GET" && url.pathname === "/api/books/2") return json(book);
    if (method === "GET" && url.pathname === "/api/chapters/3") return json(chapter);
    if (method === "GET" && url.pathname === "/api/pages") return list(pages);
    if (method === "GET" && url.pathname === "/api/pages/10") return json(pages[0]);
    if (method === "POST" && url.pathname === "/api/pages") {
      const body = JSON.parse(String(init.body));
      const page = {
        id: 10,
        name: body.name,
        slug: body.name,
        book_id: 2,
        chapter_id: 3,
        markdown: body.markdown,
        revision_count: 1,
        updated_at: "2026-09-30T00:00:00.000Z",
        created_by: { id: 7 },
        updated_by: { id: 8 },
      };
      pages.push(page);
      return json(page);
    }
    return new Response("unexpected request", { status: 404 });
  };

  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const recovery = tools.find((tool) => tool.name === "ima_bookstack_lifecycle_recover");
  assert.ok(recovery);
  const input = {
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  };
  const record = createLifecycleRecord({ request: input.request, placement: bookStackRecoveryPlacement });
  let confirmations = 0;
  const confirmationPrompts = [];
  const nonTui = await recovery.execute("test", input, undefined, undefined, {
    cwd: root,
    mode: "json",
    hasUI: true,
    ui: { confirm: async () => { confirmations += 1; return true; } },
  });
  assert.equal(nonTui.details.status, "failed");
  assert.equal(nonTui.details.error.code, "bookstack_recovery_confirmation_required");
  assert.equal(confirmations, 0);
  assert.equal(calls.some((call) => call.method === "POST"), false);

  const tui = await recovery.execute("test", input, undefined, undefined, {
    cwd: root,
    mode: "tui",
    hasUI: true,
    ui: {
      confirm: async (title, message) => {
        confirmations += 1;
        confirmationPrompts.push({ title, message });
        return true;
      },
    },
  });
  assert.equal(tui.details.status, "completed");
  assert.equal(confirmations, 1);
  assert.deepEqual(confirmationPrompts.map(({ title }) => title), ["Confirm one-time BookStack lifecycle recovery"]);
  const confirmation = confirmationPrompts[0].message;
  for (const expected of [
    "Action: Authorize at most one page POST.",
    `BookStack origin: ${JSON.stringify("https://bookstack.test")}`,
    `Lifecycle key: ${JSON.stringify(lifecycleKey)}`,
    `Attempt ID: ${writing.attempt.attemptId}`,
    `Request hash: ${record.requestHash}`,
    `Phase: ${input.request.type}`,
    `Summary: ${JSON.stringify(input.request.summary)}`,
    `Page slug: ${input.request.type}-${record.artifactId}`,
    "Discovered page count: 0",
    `  Project slug: ${JSON.stringify(bookStackRecoveryPlacement.projectSlug)}`,
    `  Source reference: ${JSON.stringify(bookStackRecoveryPlacement.sourceRef)}`,
    `  Placement lifecycle key: ${JSON.stringify(bookStackRecoveryPlacement.lifecycleKey)}`,
    `  Shelf: ${JSON.stringify(bookStackRecoveryPlacement.shelfSlug)} (ID ${bookStackRecoveryPlacement.shelfId})`,
    `  Book: ${JSON.stringify(bookStackRecoveryPlacement.bookSlug)} (ID ${bookStackRecoveryPlacement.bookId})`,
    `  Chapter: ${JSON.stringify(bookStackRecoveryPlacement.chapterSlug)} (ID ${bookStackRecoveryPlacement.chapterId})`,
    "This display is not machine-verifiable proof of a historical request.",
    "Are these the unchanged original inputs for this recovery?",
  ]) {
    assert.ok(confirmation.includes(expected), expected);
  }
  assert.equal(confirmation.includes(input.request.artifact), false);
  assert.equal(confirmation.includes("synthetic-token-id"), false);
  assert.equal(confirmation.includes("synthetic-token-secret"), false);
  assert.deepEqual(
    calls.filter((call) => call.method !== "GET").map(({ method, pathname }) => ({ method, pathname })),
    [{ method: "POST", pathname: "/api/pages" }],
  );
  assert.equal(calls.every((call) => call.origin === "https://bookstack.test"), true);
  assert.equal(calls.every((call) => call.method !== "DELETE" && call.method !== "PUT"), true);
});

test("recovers one exact BookStack writing attempt with injected boundaries and one confirmed POST", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const client = createBookStackRecoveryClient({
    pages: [{ id: 9, name: "Unrelated draft", slug: "" }],
  });
  const confirmations = [];
  const request = localLifecycleRequest();
  const input = {
    request,
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  };
  const record = createLifecycleRecord({ request, placement: bookStackRecoveryPlacement });
  const unconfirmed = await coordinateBookStackLifecycleRecovery(input, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
  });
  assert.equal(unconfirmed.status, "failed");
  assert.equal(unconfirmed.error.code, "bookstack_recovery_confirmation_required");
  assert.equal(client.posts(), 0);
  const result = await coordinateBookStackLifecycleRecovery(input, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async (confirmation) => {
      confirmations.push(confirmation);
      return true;
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider, "bookstack");
  assert.equal(client.posts(), 1);
  assert.deepEqual(confirmations, [{
    summary: request.summary,
    placement: bookStackRecoveryPlacement,
    origin: "https://bookstack.example",
    requestHash: record.requestHash,
    attemptId: writing.attempt.attemptId,
    lifecycleKey,
    pageSlug: result.artifactId ? `plan-${result.artifactId}` : "",
    action: "create-page",
    pageCount: 1,
    existing: false,
    phase: request.type,
  }]);
  const pinned = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pinned.status, "pinned");
  assert.equal((await coordinateBookStackLifecycleRecovery(input, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => true,
  })).error.code, "lifecycle_pin_attempt_conflict");
  assert.equal(client.posts(), 1);
});

test("same-slug BookStack recovery summaries produce distinct confirmation snapshots and decline without effects", async (t) => {
  const snapshots = [];
  for (const summary of [
    "First immutable recovery summary.",
    "Second immutable recovery summary.",
  ]) {
    const root = await pinTestRoot(t);
    const authorized = await authorizedPinAttempt(root, "bookstack");
    const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
    assert.equal(writing.status, "writing");
    if (writing.status !== "writing") continue;
    const client = createBookStackRecoveryClient();
    const request = { ...localLifecycleRequest(), summary };
    const result = await coordinateBookStackLifecycleRecovery({
      request,
      placement: bookStackRecoveryPlacement,
      attemptId: writing.attempt.attemptId,
    }, {
      cwd: root,
      bookStackLifecycleClient: client,
      resolveProjectRoot: async () => root,
      confirmBookStackRecovery: async (confirmation) => {
        snapshots.push(structuredClone(confirmation));
        return false;
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "bookstack_recovery_declined");
    assert.equal(client.posts(), 0);
    const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    assert.equal(pending.status, "pending");
    if (pending.status === "pending") {
      assert.equal(pending.attempt.status, "writing");
      assert.equal(pending.attempt.recoveryCheckpoint, undefined);
    }
  }

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].pageSlug, snapshots[1].pageSlug);
  assert.notEqual(snapshots[0].summary, snapshots[1].summary);
  assert.notEqual(snapshots[0].requestHash, snapshots[1].requestHash);
  assert.equal(snapshots.every((snapshot) => snapshot.action === "create-page"), true);
  assert.doesNotMatch(JSON.stringify(snapshots), /Synthetic lifecycle provider evidence\./);
});

test("BookStack recovery confirmation callback cannot mutate its request, placement, checkpoint, or POST", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const request = localLifecycleRequest();
  const record = createLifecycleRecord({ request, placement: bookStackRecoveryPlacement });
  const client = createBookStackRecoveryClient();
  const createPage = client.createPage;
  let checkpoint;
  client.createPage = async (...args) => {
    const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    assert.equal(pending.status, "pending");
    if (pending.status !== "pending") throw new Error("recovery checkpoint was not retained");
    checkpoint = structuredClone(pending.attempt.recoveryCheckpoint);
    return createPage(...args);
  };
  let snapshot;
  const result = await coordinateBookStackLifecycleRecovery({
    request,
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async (confirmation) => {
      snapshot = structuredClone(confirmation);
      confirmation.summary = "Tampered summary";
      confirmation.placement.chapterId = 99;
      confirmation.origin = "https://tampered.example";
      confirmation.requestHash = "0".repeat(64);
      confirmation.lifecycleKey = "tampered-lifecycle";
      confirmation.pageSlug = "plan-00000000-0000-4000-8000-000000000099";
      confirmation.action = "pin-existing-page";
      confirmation.pageCount = 99;
      return true;
    },
  });

  assert.equal(snapshot.summary, request.summary);
  assert.deepEqual(snapshot.placement, bookStackRecoveryPlacement);
  assert.equal(result.status, "completed");
  assert.ok(checkpoint);
  assert.equal(checkpoint.lifecycleKey, lifecycleKey);
  assert.equal(checkpoint.requestHash, record.requestHash);
  assert.equal(checkpoint.originFingerprint, originFingerprint("https://bookstack.example"));
  assert.equal(checkpoint.pageSlug, `plan-${record.artifactId}`);
  assert.match(checkpoint.discoveryHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(client.createCalls(), [{
    name: `plan-${record.artifactId}`,
    chapterId: bookStackRecoveryPlacement.chapterId,
    markdown: record.pageMarkdown,
  }]);
});

test("blocks changed complete BookStack discovery after confirmation without a checkpoint or POST", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const client = createBookStackRecoveryClient();
  const listPages = client.listPages;
  let changed = false;
  client.listPages = async () => changed
    ? [...(await listPages()), { id: 9, name: "New draft", slug: "" }]
    : listPages();
  const result = await coordinateBookStackLifecycleRecovery({
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => {
      changed = true;
      return true;
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "bookstack_recovery_stale");
  assert.equal(client.posts(), 0);
  const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pending.status, "pending");
  if (pending.status === "pending") {
    assert.equal(pending.attempt.status, "writing");
    assert.equal(pending.attempt.recoveryCheckpoint, undefined);
  }
});

test("a consumed BookStack recovery checkpoint makes one read-only discovery and cannot issue another POST", async (t) => {
  const root = await pinTestRoot(t);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const client = createBookStackRecoveryClient({ failPost: true });
  const input = {
    request: localLifecycleRequest(),
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  };
  const failed = await coordinateBookStackLifecycleRecovery(input, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => true,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "bookstack_write_unknown");
  assert.doesNotMatch(JSON.stringify(failed), /secret|token=/);
  assert.equal(client.posts(), 1);
  const checkpointed = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(checkpointed.status, "pending");
  if (checkpointed.status !== "pending") return;
  assert.equal(checkpointed.attempt.status, "writing");
  assert.ok(checkpointed.attempt.recoveryCheckpoint);

  const listsBeforeRetry = client.lists();
  let confirmations = 0;
  const retry = await coordinateBookStackLifecycleRecovery(input, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => {
      confirmations += 1;
      return true;
    },
  });
  assert.equal(retry.status, "failed");
  assert.equal(retry.error.code, "lifecycle_pin_recovery_consumed");
  assert.equal(confirmations, 0);
  assert.equal(client.posts(), 1);
  assert.equal(client.lists(), listsBeforeRetry + 1);
});

test("a consumed BookStack checkpoint blocks absent, ambiguous, and changed evidence before confirmation or POST", async (t) => {
  const request = localLifecycleRequest();
  const record = createLifecycleRecord({ request, placement: bookStackRecoveryPlacement });
  const pageSlug = `${record.phase}-${record.artifactId}`;
  const scenarios = [
    {
      name: "absent",
      expectedCode: "lifecycle_pin_recovery_consumed",
      seed: () => [],
    },
    {
      name: "ambiguous",
      expectedCode: "bookstack_identity_ambiguous",
      seed: () => [
        { id: 9, name: pageSlug, slug: pageSlug },
        { id: 10, name: pageSlug, slug: pageSlug },
      ],
    },
    {
      name: "changed",
      expectedCode: "bookstack_verification_failed",
      seed: () => [{
        id: 9,
        name: pageSlug,
        slug: pageSlug,
        bookId: bookStackRecoveryPlacement.bookId,
        chapterId: bookStackRecoveryPlacement.chapterId,
        markdown: record.pageMarkdown.replace("Synthetic lifecycle provider evidence.", "Changed evidence."),
        revisionCount: 1,
        updatedAt: "2026-09-30T00:00:00.000Z",
        creatorId: 7,
        updaterId: 8,
      }],
    },
  ];

  for (const scenario of scenarios) {
    const root = await pinTestRoot(t);
    const client = createBookStackRecoveryClient();
    const discovery = await createBookStackLifecycleProvider({ client })
      .discoverSameAttemptRecovery({ request, placement: bookStackRecoveryPlacement });
    assert.equal(discovery.status, "ready", scenario.name);
    if (discovery.status !== "ready") continue;
    const authorized = await authorizedPinAttempt(root, "bookstack");
    const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
    assert.equal(writing.status, "writing", scenario.name);
    if (writing.status !== "writing") continue;
    const claimed = await claimLifecyclePinRecoveryWith(async () => root)(
      root,
      writing.attempt,
      discovery.checkpoint,
    );
    assert.equal(claimed.status, "claimed", scenario.name);
    if (claimed.status !== "claimed") continue;
    for (const page of scenario.seed()) client.seedPage(page);

    let confirmations = 0;
    const result = await coordinateBookStackLifecycleRecovery({
      request,
      placement: bookStackRecoveryPlacement,
      attemptId: claimed.attempt.attemptId,
    }, {
      cwd: root,
      bookStackLifecycleClient: client,
      resolveProjectRoot: async () => root,
      confirmBookStackRecovery: async () => {
        confirmations += 1;
        return true;
      },
    });
    assert.equal(result.status, "failed", scenario.name);
    assert.equal(result.error.code, scenario.expectedCode, scenario.name);
    assert.equal(confirmations, 0, scenario.name);
    assert.equal(client.posts(), 0, scenario.name);
    const pending = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
    assert.equal(pending.status, "pending", scenario.name);
    if (pending.status !== "pending") continue;
    assert.deepEqual(pending.attempt, claimed.attempt, scenario.name);
  }
});

test("pins an exact existing BookStack artifact without a recovery POST", async (t) => {
  const root = await pinTestRoot(t);
  const client = createBookStackRecoveryClient();
  const request = localLifecycleRequest();
  const seeded = await createBookStackLifecycleProvider({ client }).persist({
    request,
    placement: bookStackRecoveryPlacement,
  });
  assert.equal(seeded.status, "verified");
  assert.equal(client.posts(), 1);
  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const record = createLifecycleRecord({ request, placement: bookStackRecoveryPlacement });
  let confirmationSnapshot;
  const recovered = await coordinateBookStackLifecycleRecovery({
    request,
    placement: bookStackRecoveryPlacement,
    attemptId: writing.attempt.attemptId,
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async (confirmation) => {
      confirmationSnapshot = structuredClone(confirmation);
      return true;
    },
  });
  assert.deepEqual(confirmationSnapshot, {
    summary: request.summary,
    placement: bookStackRecoveryPlacement,
    origin: "https://bookstack.example",
    requestHash: record.requestHash,
    attemptId: writing.attempt.attemptId,
    lifecycleKey,
    pageSlug: `plan-${record.artifactId}`,
    action: "pin-existing-page",
    pageCount: 1,
    existing: true,
    phase: request.type,
  });
  assert.equal(recovered.status, "completed");
  assert.equal(client.posts(), 1);
  assert.equal((await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey)).status, "pinned");
});

test("TEST-004 reconciles a checkpointed one-LF-normalized page into a pin-ready receipt without a POST", async (t) => {
  const root = await pinTestRoot(t);
  const request = localLifecycleRequest();
  const record = createLifecycleRecord({ request, placement: bookStackRecoveryPlacement });
  assert.equal(record.pageMarkdown.endsWith("\n"), true);
  const actualMarkdown = record.pageMarkdown.slice(0, -1);
  assert.equal(actualMarkdown.endsWith("\n"), false);
  const actualPageHash = digestBookStackValue(actualMarkdown);
  const pageSlug = `${record.phase}-${record.artifactId}`;
  const client = createBookStackRecoveryClient();
  const discovery = await createBookStackLifecycleProvider({ client })
    .discoverSameAttemptRecovery({ request, placement: bookStackRecoveryPlacement });
  assert.equal(discovery.status, "ready");
  if (discovery.status !== "ready") return;
  assert.equal(discovery.existing, null);

  const authorized = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, authorized);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const claimed = await claimLifecyclePinRecoveryWith(async () => root)(
    root,
    writing.attempt,
    discovery.checkpoint,
  );
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  client.seedPage({
    id: 1796,
    name: pageSlug,
    slug: pageSlug,
    bookId: bookStackRecoveryPlacement.bookId,
    chapterId: bookStackRecoveryPlacement.chapterId,
    markdown: actualMarkdown,
    revisionCount: 1,
    updatedAt: "2026-09-30T00:00:00.000Z",
    creatorId: 7,
    updaterId: 8,
  });

  const result = await coordinateBookStackLifecycleRecovery({
    request,
    placement: bookStackRecoveryPlacement,
    attemptId: claimed.attempt.attemptId,
  }, {
    cwd: root,
    bookStackLifecycleClient: client,
    resolveProjectRoot: async () => root,
    confirmBookStackRecovery: async () => true,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.provider, "bookstack");
  assert.equal(result.receiptAccepted, true);
  assert.equal(result.semanticRecall.matched, true);
  assert.equal(result.artifactId, record.artifactId);
  assert.equal(result.recordKey, record.recordKey);
  assert.equal(client.posts(), 0);

  const pinned = await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey);
  assert.equal(pinned.status, "pinned");
  if (pinned.status !== "pinned") return;
  assert.equal(pinned.pin.artifactId, record.artifactId);
  assert.equal(pinned.pin.recordKey, record.recordKey);
  assert.equal(pinned.pin.initialReference.pageId, 1796);
  assert.equal(pinned.pin.initialReference.contentHash, record.contentHash);
  assert.equal(pinned.pin.initialReference.pageHash, actualPageHash);
  assert.notEqual(pinned.pin.initialReference.pageHash, digestBookStackValue(record.pageMarkdown));
});

test("TEST-006 hydrates a valid pinned BookStack anchor and phase-reads its exact placement", async (t) => {
  const root = await pinTestRoot(t);
  const request = localLifecycleRequest();
  const record = createLifecycleRecord({ request, placement: bookStackRecoveryPlacement });
  const page = {
    id: 1796,
    name: `${record.phase}-${record.artifactId}`,
    slug: `${record.phase}-${record.artifactId}`,
    book_id: bookStackRecoveryPlacement.bookId,
    chapter_id: bookStackRecoveryPlacement.chapterId,
    markdown: record.pageMarkdown,
    revision_count: 1,
    updated_at: "2026-09-30T00:00:00.000Z",
    created_by: { id: 7 },
    updated_by: { id: 8 },
  };
  const pageFor = (id, lifecycleRecord) => ({
    id,
    name: `${lifecycleRecord.phase}-${lifecycleRecord.artifactId}`,
    slug: `${lifecycleRecord.phase}-${lifecycleRecord.artifactId}`,
    book_id: bookStackRecoveryPlacement.bookId,
    chapter_id: bookStackRecoveryPlacement.chapterId,
    markdown: lifecycleRecord.pageMarkdown,
    revision_count: 1,
    updated_at: "2026-09-30T00:00:00.000Z",
    created_by: { id: 7 },
    updated_by: { id: 8 },
  });
  const continuationPageFor = (id, phase, index) => pageFor(id, createLifecycleRecord({
    request: {
      ...request,
      type: phase,
      identity: {
        ...request.identity,
        lifecycleRootMemoryId: record.artifactId,
        priorArtifactIds: [...request.identity.priorArtifactIds, record.artifactId],
      },
      summary: `Synthetic ${phase} evidence ${index + 1} shares the pinned lifecycle source.`,
      artifact: `# ${phase}\n\nSynthetic ${phase} lifecycle provider evidence ${index + 1}.`,
    },
    placement: bookStackRecoveryPlacement,
  }));
  const implementationPages = Array.from(
    { length: 10 },
    (_unused, index) => continuationPageFor(1797 + index, "implementation", index),
  );
  const testPages = Array.from(
    { length: 10 },
    (_unused, index) => continuationPageFor(1807 + index, "test", index),
  );
  let listedPages = [page, ...implementationPages, ...testPages];
  const locator = {
    ...bookStackRecoveryPlacement,
    pageId: page.id,
    pageSlug: page.slug,
    originFingerprint: originFingerprint("https://bookstack.test"),
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    contentHash: record.contentHash,
    pageHash: digestBookStackValue(page.markdown),
    revisionCount: page.revision_count,
    updatedAt: page.updated_at,
  };
  const attempt = await authorizedPinAttempt(root, "bookstack");
  const writing = await markLifecyclePinAttemptWritingWith(async () => root)(root, attempt);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  const pin = createLifecycleProviderPin({
    lifecycleKey,
    provider: "bookstack",
    initialReference: locator,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    pinnedAt: attempt.startedAt,
  });
  assert.ok(pin);
  const confirmed = await confirmLifecyclePinWith(async () => root)(root, writing.attempt, pin);
  assert.equal(confirmed.status, "pinned");
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const pinStateBeforeRecall = await readFile(registry, "utf8");

  const calls = [];
  const shelf = { id: 1, name: "Lifecycle", slug: "lifecycle-artifacts", books: [2] };
  const book = { id: 2, name: "IMA Pi", slug: "ima-pi" };
  const chapter = {
    id: 3,
    name: bookStackRecoveryPlacement.chapterSlug,
    slug: bookStackRecoveryPlacement.chapterSlug,
    book_id: 2,
  };
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ origin: url.origin, pathname: url.pathname, method });
    const list = (data) => json({ total: data.length, data });
    if (method === "GET" && url.pathname === "/api/shelves/1") return json(shelf);
    if (method === "GET" && url.pathname === "/api/books/2") return json(book);
    if (method === "GET" && url.pathname === "/api/chapters/3") return json(chapter);
    if (method === "GET" && url.pathname === "/api/pages") return list(listedPages);
    const pageId = /^\/api\/pages\/(\d+)$/.exec(url.pathname)?.[1];
    const listed = pageId ? listedPages.find((candidate) => candidate.id === Number(pageId)) : null;
    if (method === "GET" && listed) return json(listed);
    return new Response("unexpected request", { status: 404 });
  };
  let virtualTime = 0;
  const waits = [];
  const client = createBookStackLifecycleClient({
    origin: "https://bookstack.test",
    tokenId: "test-token-id",
    tokenSecret: "test-token-secret",
    requestScheduler: createBookStackLifecycleRequestScheduler({
      now: () => virtualTime,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        virtualTime += milliseconds;
      },
    }),
    fetch,
  });

  const access = corpusAccessCounter();
  let serenaCalls = 0;
  const supplied = {
    canonical: async (path) => path,
    cwd: root,
    corpus: access.corpus,
    bookStackLifecycleClient: client,
    environment: {},
    resolveProjectRoot: async () => root,
    session: async () => {
      serenaCalls += 1;
      throw new Error("Serena fallback is forbidden for a verified BookStack pin");
    },
  };
  const context = await coordinateContext({
    source: { type: "lifecycle", key: lifecycleKey },
  }, root, supplied);

  assert.equal(
    context.status,
    "degraded",
    `valid BookStack pin must pass direct anchor authority: ${JSON.stringify(context.diagnostics)}`,
  );
  assert.deepEqual(context.source, {
    type: "lifecycle",
    key: lifecycleKey,
    title: `Lifecycle ${lifecycleKey}`,
    content: record.artifact,
    references: [
      `Lifecycle:${lifecycleKey}`,
      "LifecycleProvider:bookstack",
      `LifecycleRecordKey:${record.recordKey}`,
    ],
  });
  assert.deepEqual(context.diagnostics, [{
    code: "lifecycle_pinned_provider_context",
    stage: "lifecycle",
    message: "Lifecycle hydration used the pinned provider.",
  }]);
  assert.equal(calls.filter(({ pathname }) => pathname === "/api/pages").length, 0);
  assert.equal(calls.some(({ pathname }) => pathname === "/api/pages/1796"), true);
  assert.equal(calls.every(({ origin }) => origin === "https://bookstack.test"), true);
  assert.equal(calls.every(({ method }) => method === "GET"), true);
  assert.equal(access.calls(), 0);
  assert.equal(serenaCalls, 0);
  assert.equal(await readFile(registry, "utf8"), pinStateBeforeRecall);

  const phaseRecalled = await recallLifecycle(`${lifecycleKey} plan`, root, supplied);
  assert.ok(phaseRecalled);
  assert.deepEqual(phaseRecalled.structuredContent.results.map(({ phase, recordKey }) => ({ phase, recordKey })), [{
    phase: "plan",
    recordKey: record.recordKey,
  }]);
  const implementationRecalled = await recallLifecycle(`${lifecycleKey} implementation`, root, supplied);
  assert.ok(implementationRecalled);
  assert.equal(implementationRecalled.structuredContent.results.length, 10);
  assert.equal(implementationRecalled.structuredContent.results.every(({ phase }) => phase === "implementation"), true);

  const lineage = await resolveLifecycleLineage(lifecycleKey, supplied);
  assert.equal(lineage.status, "verified");
  if (lineage.status === "verified") {
    assert.equal(lineage.lineage.rootArtifactId, record.artifactId);
  }

  const routedRecall = await coordinateLifecycleRecall({
    lifecycleKey,
    phase: "implementation",
    limit: 1,
  }, supplied);
  assert.equal(routedRecall.status, "completed");
  assert.equal(routedRecall.results.length, 1);
  const descriptor = routedRecall.results[0];
  assert.ok(descriptor);
  const routedGet = await coordinateLifecycleGet(descriptor, supplied);
  assert.equal(routedGet.status, "completed");
  assert.equal(routedGet.phase, "implementation");
  assert.equal(waits.length > 0, true);
  assert.equal(virtualTime > 0, true);

  const overflowPages = Array.from({ length: 51 }, (_, index) => pageFor(
    1798 + index,
    createLifecycleRecord({
      request: {
        ...request,
        summary: `Synthetic overflow plan evidence ${index + 1}.`,
        artifact: `# Plan\n\nSynthetic overflow lifecycle provider evidence ${index + 1}.`,
      },
      placement: bookStackRecoveryPlacement,
    }),
  ));
  listedPages = [page, ...overflowPages];
  const listCallsBeforeOverflow = calls.filter(({ pathname }) => pathname === "/api/pages").length;
  assert.equal(await recallLifecycle(`${lifecycleKey} plan`, root, supplied), null);
  assert.equal(calls.filter(({ pathname }) => pathname === "/api/pages").length, listCallsBeforeOverflow + 1);
  listedPages = [page, ...implementationPages, ...testPages];

  const listCallsBeforeMismatch = calls.filter(({ pathname }) => pathname === "/api/pages").length;
  page.markdown = page.markdown.replace("Synthetic lifecycle provider evidence.", "Tampered provider evidence.");
  const mismatched = await coordinateContext({
    source: { type: "lifecycle", key: lifecycleKey },
  }, root, supplied);
  assert.equal(mismatched.status, "failed");
  assert.equal(mismatched.source, null);
  assert.deepEqual(mismatched.diagnostics, [{
    code: "pinned_provider_unavailable",
    stage: "lifecycle",
    message: "Pinned lifecycle provider could not verify authoritative evidence.",
  }]);
  assert.equal(calls.every(({ method }) => method === "GET"), true);
  assert.equal(calls.filter(({ pathname }) => pathname === "/api/pages").length, listCallsBeforeMismatch);
  assert.equal(access.calls(), 0);
  assert.equal(serenaCalls, 0);
  assert.equal(await readFile(registry, "utf8"), pinStateBeforeRecall);
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
  assert.deepEqual(selections, [{ lifecycleKey, phase: "plan", limit: 50 }]);
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
    const historical = await coordinateLifecycle(
      localLifecycleRequest(phase, "00000000-0000-5000-8000-000000000230"),
      {
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
    assert.deepEqual(selections, [{ lifecycleKey, limit: 50 }], phase);
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
  assert.deepEqual(selections, [{ lifecycleKey, limit: 50 }]);
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
  assert.equal(calls.qdrant.filter(({ operation }) => operation === "recall").length, 0);
  assert.equal(calls.qdrant.filter(({ operation }) => operation === "reconcile").length >= 2, true);
});

test("hydrates a pinned Serena lifecycle source through its direct anchor without recall", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "serena",
    request: lifecycleReadRequestFor("plan", "context-serena-anchor"),
    root,
  });
  await pinLifecycleReadAuthority(root, "serena", initial);
  const route = lifecycleReadRoutingFor({
    provider: "serena",
    initial,
    target: initial,
    records: [initial],
  });
  const access = corpusAccessCounter();
  const context = await coordinateContext({
    source: { type: "lifecycle", key: SKYNET_230_LIFECYCLE_KEY },
  }, root, {
    canonical: async (path) => path,
    corpus: access.corpus,
    routing: route.routing,
    resolveProjectRoot: async () => root,
    session: serenaSession(),
  });

  assert.equal(context.status, "ready");
  assert.equal(context.source.content, initial.artifact);
  assert.deepEqual(route.calls.map(({ operation }) => operation), [
    "reconcile",
    "reconcile",
    "reconcile",
    "reconcile",
  ]);
  assert.deepEqual(route.calls.filter(({ operation }) => operation === "recall"), []);
  assert.deepEqual(route.fallbackCalls, []);
  assert.equal(access.calls(), 0);
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
  const denied = await coordinateLifecycle(
    localLifecycleRequest("implementation", historical.artifactId),
    {
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
    ...localLifecycleRequest("implementation", historical.artifactId),
    provider: "markdown",
  }, {
    ...localRoutingOptions(root, local.routing),
    corpus,
  });
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.error.code, "historical_qdrant_authority_conflict");
  assert.deepEqual(local.calls, { qdrant: [], markdown: [] });
});

test("SKYNET-230 public reads accept plan-to-later root lineage for recall and exact direct get", async (t) => {
  for (const provider of ["qdrant", "markdown", "serena", "bookstack"]) {
    const root = await pinTestRoot(t);
    if (provider === "serena") {
      await mkdir(join(root, ".serena", "memories"), { recursive: true });
      await writeFile(join(root, ".serena", "project.yml"), "project_name: skynet-230-read-tests\n", "utf8");
    }

    const initial = lifecycleReadRecordFor({
      provider,
      request: lifecycleReadRequestFor("plan", `${provider}-initial`),
      root,
      pageId: 1,
    });
    const laterRecords = [
      ["implementation", "latest-implementation"],
      ["test", "passing-test"],
      ["rereview", "final-rereview"],
      ["document", "document"],
    ].map(([phase, label], index) => lifecycleReadRecordFor({
      provider,
      request: lifecycleReadRequestFor(phase, `${provider}-${label}`, {
        lifecycleRootMemoryId: initial.artifactId,
      }),
      root,
      pageId: index + 2,
    }));
    const [target] = laterRecords;
    const records = [initial, ...laterRecords];
    await pinLifecycleReadAuthority(root, provider, initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const descriptor = lifecycleReadDescriptorFor(target);
    const serializedDescriptor = JSON.stringify(descriptor);
    assert.equal(serializedDescriptor.includes(root), false, `${provider} descriptor must not expose checkout authority`);
    assert.equal(serializedDescriptor.includes("provider"), false, `${provider} descriptor must not expose provider authority`);

    const route = lifecycleReadRoutingFor({ provider, initial, target, records });
    const recalled = await coordinateLifecycleRecall({
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      limit: 5,
    }, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
    });
    assert.equal(recalled.status, "completed", provider);
    assert.equal(recalled.results.some(({ artifactId }) => artifactId === initial.artifactId), true, provider);
    assert.deepEqual(
      new Set(recalled.results.map(({ phase }) => phase)),
      new Set(["plan", "implementation", "test", "rereview", "document"]),
      provider,
    );
    assert.equal(recalled.results.some(({ artifactId }) => artifactId === target.artifactId), true, provider);

    const direct = await coordinateLifecycleGet(descriptor, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
    });
    assert.equal(direct.status, "completed", provider);
    assert.equal(direct.artifact, target.artifact, provider);
    assert.equal(direct.recordKey, target.recordKey, provider);
    assert.equal(Object.hasOwn(direct, "provider"), false, provider);
    assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall", "reconcile", "get"], provider);
    assert.deepEqual(route.calls[0].reference, initial.reference, provider);
    assert.deepEqual(route.calls[2].reference, initial.reference, provider);
    assert.deepEqual(route.calls[3].reference, target.reference, provider);
    assert.deepEqual(route.fallbackCalls, [], provider);
    assert.equal(await readFile(registry, "utf8"), before, `${provider} public reads must not mutate authority`);
  }
});

test("SKYNET-245 preserves decision-seeded R/S and distinct approved plans across provider contracts", async (t) => {
  const source = { type: "plane", workspace: "ima", project: "SKYNET", sequenceId: 230 };
  const selectionRecord = (record) => ({
    id: record.artifactId,
    recordKey: record.recordKey,
    lifecycleKey: record.lifecycleKey,
    phase: record.phase,
    summary: record.summary,
    content: record.artifact,
    detail: record.artifact,
    contentHash: createHash("sha256").update(record.artifact, "utf8").digest("hex"),
    provider: record.provider,
    reference: record.reference,
    ...(record.createdAt ? { createdAt: record.createdAt } : {}),
  });

  for (const provider of ["qdrant", "markdown", "serena", "bookstack"]) {
    const root = await pinTestRoot(t);
    if (provider === "serena") {
      await mkdir(join(root, ".serena", "memories"), { recursive: true });
      await writeFile(join(root, ".serena", "project.yml"), "project_name: skynet-230-read-tests\n", "utf8");
    }

    const decision = lifecycleReadRecordFor({
      provider,
      request: lifecycleReadRequestFor("decision", `${provider}-decision-seed`),
      root,
      pageId: 1,
    });
    const laterDecision = lifecycleReadRecordFor({
      provider,
      request: lifecycleReadRequestFor("decision", `${provider}-later-decision`, {
        lifecycleRootMemoryId: decision.artifactId,
        priorArtifactIds: [decision.artifactId],
      }),
      root,
      pageId: 2,
    });
    const technicalPlanRequest = validateLifecycleWriteRequest({
      type: "plan",
      identity: skyNet230Identity({
        lifecycleRootMemoryId: decision.artifactId,
        priorArtifactIds: [laterDecision.artifactId],
      }),
      summary: "APPROVED: decision-seeded technical plan is ready for cycle adoption.",
      artifact: [
        "# Plan",
        "",
        "Approved technical implementation contract remains distinct from decision evidence.",
        "",
        "<!-- ima-cycle outcome: phase=plan; outcome=APPROVED -->",
      ].join("\n"),
    });
    assert.equal(technicalPlanRequest.valid, true, provider);
    if (!technicalPlanRequest.valid) continue;
    const technicalPlan = lifecycleReadRecordFor({
      provider,
      request: technicalPlanRequest,
      root,
      pageId: 3,
    });
    const implementation = lifecycleReadRecordFor({
      provider,
      request: lifecycleReadRequestFor("implementation", `${provider}-implementation`, {
        lifecycleRootMemoryId: decision.artifactId,
        priorArtifactIds: [technicalPlan.artifactId],
      }),
      root,
      pageId: 4,
    });
    const closeout = lifecycleReadRecordFor({
      provider,
      request: lifecycleReadRequestFor("closeout", `${provider}-closeout`, {
        lifecycleRootMemoryId: decision.artifactId,
        priorArtifactIds: [technicalPlan.artifactId, implementation.artifactId],
      }),
      root,
      pageId: 5,
    });
    const records = [decision, laterDecision, technicalPlan, implementation, closeout];
    await pinLifecycleReadAuthority(root, provider, decision);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const route = lifecycleReadRoutingFor({
      provider,
      initial: decision,
      target: technicalPlan,
      records,
    });
    const supplied = {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
    };

    const lineage = await resolveLifecycleLineage(SKYNET_230_LIFECYCLE_KEY, supplied);
    assert.equal(lineage.status, "verified", provider);
    if (lineage.status !== "verified") continue;
    assert.equal(lineage.lineage.rootArtifactId, decision.artifactId, provider);
    assert.deepEqual(lineage.lineage.sourceIdentity, {
      project: "ima-pi",
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      taskwarriorProject: "",
      taskwarriorTask: "",
      taskwarriorUuid: "",
      jiraKey: "",
      planeWorkspace: "ima",
      planeWorkItem: "SKYNET-230",
      sourceRefs: [SKYNET_230_SOURCE],
    }, provider);

    const recalled = await coordinateLifecycleRecall({
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      limit: 5,
    }, supplied);
    assert.equal(recalled.status, "completed", provider);
    assert.deepEqual(
      new Set(recalled.results.map(({ artifactId }) => artifactId)),
      new Set(records.map(({ artifactId }) => artifactId)),
      provider,
    );

    const planOnly = await coordinateLifecycleRecall({
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      phase: "plan",
      limit: 1,
    }, supplied);
    assert.equal(planOnly.status, "completed", provider);
    assert.deepEqual(planOnly.results.map(({ artifactId }) => artifactId), [technicalPlan.artifactId], provider);
    assert.equal(
      selectReusablePlan({ results: [selectionRecord(technicalPlan)] }, {
        lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
        source,
      }).kind,
      "approved",
      provider,
    );
    assert.deepEqual(
      selectReusablePlan({ results: [selectionRecord(decision)] }, {
        lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
        source,
      }),
      { kind: "blocked", code: "plan_record_invalid" },
      provider,
    );

    const direct = await coordinateLifecycleGet(lifecycleReadDescriptorFor(technicalPlan), supplied);
    assert.equal(direct.status, "completed", provider);
    assert.equal(direct.artifact, technicalPlan.artifact, provider);
    assert.equal(direct.recordKey, technicalPlan.recordKey, provider);
    assert.equal(route.calls.some(({ operation }) => operation === "persist"), false, provider);
    assert.deepEqual(route.fallbackCalls, [], provider);
    assert.equal(await readFile(registry, "utf8"), before, `${provider} reads must not mutate authority`);
  }
});

test("SKYNET-230 pinned public reads retrieve an original root plan behind a later plan pin", async (t) => {
  const root = await pinTestRoot(t);
  const original = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "later-pin-original"),
    root,
  });
  const laterPlan = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "later-pin-approval", {
      lifecycleRootMemoryId: original.artifactId,
      priorArtifactIds: [original.artifactId],
    }),
    root,
  });
  const decision = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("decision", "later-pin-decision", {
      lifecycleRootMemoryId: original.artifactId,
    }),
    root,
  });
  const closeout = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("closeout", "later-pin-closeout", {
      lifecycleRootMemoryId: original.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", laterPlan);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial: laterPlan,
    target: original,
    records: [original, laterPlan, decision, closeout],
  });
  const recalled = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 4,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(recalled.status, "completed");
  assert.deepEqual(
    new Set(recalled.results.map(({ artifactId }) => artifactId)),
    new Set([original.artifactId, laterPlan.artifactId, decision.artifactId, closeout.artifactId]),
  );
  const originalRead = await coordinateLifecycleGet(lifecycleReadDescriptorFor(original), {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(originalRead.status, "completed");
  assert.equal(originalRead.artifactId, original.artifactId);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall", "reconcile", "get"]);
  assert.deepEqual(route.fallbackCalls, []);
});

test("public lifecycle get selector owns fresh pinned recall proof before exact get", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "selector-pinned-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "selector-pinned-target", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });

  const result = await coordinateLifecycleGet(lifecycleReadSelectorFor(target), {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.artifact, target.artifact);
  assert.equal(result.recordKey, target.recordKey);
  assert.deepEqual(route.calls.map(({ operation }) => operation), [
    "reconcile",
    "recall",
    "reconcile",
    "get",
  ]);
  assert.deepEqual(route.calls[1].selection, {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 50,
    reference: initial.reference,
  });
  assert.deepEqual(route.calls[3].reference, target.reference);
  assert.deepEqual(route.fallbackCalls, []);
  assert.equal(await readFile(registry, "utf8"), before);
});

test("public lifecycle get selectors fail closed on no match, duplicate match, and phase saturation", async (t) => {
  const scenarios = [
    {
      label: "no match",
      recordsFor: ({ initial, target }) => [initial, target],
      selectorFor: ({ initial, target }) => ({
        ...lifecycleReadSelectorFor(target),
        artifactId: initial.artifactId,
      }),
      error: "lifecycle_read_verification_failed",
    },
    {
      label: "duplicate match",
      recordsFor: ({ initial, target }) => [initial, target, structuredClone(target)],
      selectorFor: ({ target }) => lifecycleReadSelectorFor(target),
      error: "lifecycle_read_unavailable",
    },
    {
      label: "phase saturation",
      recordsFor: ({ root, initial, target }) => [
        initial,
        target,
        ...Array.from({ length: 49 }, (_unused, index) => lifecycleReadRecordFor({
          provider: "qdrant",
          request: lifecycleReadRequestFor("implementation", `selector-saturation-${index + 2}`, {
            lifecycleRootMemoryId: initial.artifactId,
          }),
          root,
        })),
      ],
      selectorFor: ({ target }) => lifecycleReadSelectorFor(target),
      error: "lifecycle_read_verification_failed",
    },
  ];

  for (const scenario of scenarios) {
    const root = await pinTestRoot(t);
    const initial = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("plan", `selector-${scenario.label}-root`),
      root,
    });
    const target = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("implementation", `selector-${scenario.label}-target`, {
        lifecycleRootMemoryId: initial.artifactId,
      }),
      root,
    });
    await pinLifecycleReadAuthority(root, "qdrant", initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const route = lifecycleReadRoutingFor({
      provider: "qdrant",
      initial,
      target,
      records: scenario.recordsFor({ root, initial, target }),
    });

    const result = await coordinateLifecycleGet(scenario.selectorFor({ initial, target }), {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
    });

    assert.equal(result.status, "failed", scenario.label);
    assert.equal(result.error.code, scenario.error, scenario.label);
    assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"], scenario.label);
    assert.deepEqual(route.fallbackCalls, [], scenario.label);
    assert.equal(await readFile(registry, "utf8"), before, scenario.label);
  }
});

test("public lifecycle get selector passes its exact phase to unpinned Qdrant recall", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "selector-unpinned-root"),
    root,
  });
  const plans = Array.from({ length: 19 }, (_unused, index) => lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", `selector-unpinned-plan-${index + 2}`),
    root,
  }));
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "selector-unpinned-target", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, ...plans, target],
  });

  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, SKYNET_230_LIFECYCLE_KEY),
    { status: "absent" },
  );
  const result = await coordinateLifecycleGet(lifecycleReadSelectorFor(target), {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.artifactId, target.artifactId);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["recall", "get"]);
  assert.deepEqual(route.calls[0].selection, {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 50,
  });
  assert.deepEqual(route.calls[1].reference, target.reference);
  assert.deepEqual(route.fallbackCalls, []);
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, SKYNET_230_LIFECYCLE_KEY),
    { status: "absent" },
  );
});

test("public lifecycle get rejects an altered legacy fingerprint before provider get", async (t) => {
  const root = await pinTestRoot(t);
  const record = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "legacy-fingerprint"),
    root,
  });
  const descriptor = lifecycleReadDescriptorFor(record);
  const alteredFingerprint = descriptor.reference.fingerprint === "0".repeat(64)
    ? "1".repeat(64)
    : "0".repeat(64);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial: record,
    target: record,
    records: [record],
  });

  const result = await coordinateLifecycleGet({
    ...descriptor,
    reference: { ...descriptor.reference, fingerprint: alteredFingerprint },
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_read_verification_failed");
  assert.deepEqual(route.calls, []);
  assert.deepEqual(route.fallbackCalls, []);
});

test("public lifecycle reads fail closed with a bounded authority code for wrong pinned roots", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "wrong-root-initial"),
    root,
  });
  const wrongRoot = "00000000-0000-5000-8000-000000000230";
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "wrong-root-later", {
      lifecycleRootMemoryId: wrongRoot,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });
  const expectedError = {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_authority_invalid",
      message: "Lifecycle read authority cannot verify the requested record.",
    },
  };

  const recalled = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 2,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.deepEqual(recalled, expectedError);
  assert.doesNotMatch(JSON.stringify(recalled), new RegExp(wrongRoot));

  const direct = await coordinateLifecycleGet(lifecycleReadDescriptorFor(target), {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.deepEqual(direct, expectedError);
  assert.doesNotMatch(JSON.stringify(direct), new RegExp(wrongRoot));
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall", "reconcile", "get"]);
  assert.deepEqual(route.fallbackCalls, []);
  assert.equal(await readFile(registry, "utf8"), before);
});

test("SKYNET-230 public get reaches a later unpinned historical Qdrant artifact without recall", async (t) => {
  const root = await pinTestRoot(t);
  const document = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("document", "historical-document"),
    root,
  });
  const closeout = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("closeout", "historical-closeout"),
    root,
  });
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "historical-initial"),
    root,
  });
  const plans = Array.from({ length: 49 }, (_, index) => lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", `historical-plan-${index + 2}`),
    root,
  }));
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "historical-later"),
    root,
  });
  const records = [document, closeout, initial, ...plans, target];
  assert.equal(records.indexOf(target) > 50, true);
  assert.deepEqual(await loadLifecyclePinStateWith(async () => root)(root, SKYNET_230_LIFECYCLE_KEY), { status: "absent" });
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records,
  });
  const descriptor = lifecycleReadDescriptorFor(target);

  const direct = await coordinateLifecycleGet(descriptor, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(direct.status, "completed");
  assert.equal(direct.artifactId, target.artifactId);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["get"]);
  assert.deepEqual(route.calls[0].reference, target.reference);
  assert.deepEqual(route.fallbackCalls, []);

  const recalled = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 50,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(recalled.status, "failed");
  assert.equal(recalled.error.code, "lifecycle_read_verification_failed");
  assert.equal(Object.hasOwn(recalled, "results"), false);
  assert.deepEqual(route.calls.at(-1).selection, {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 50,
  });

  const documentsOnly = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "document",
    limit: 1,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(documentsOnly.status, "completed");
  assert.deepEqual(documentsOnly.results.map(({ phase }) => phase), ["document"]);
  assert.deepEqual(route.fallbackCalls, []);
});

test("public lifecycle recall accepts forty-nine records, blocks fifty terminal records, and rejects fifty-one before provider effects", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "public-bound-root"),
    root,
  });
  const recordsFor = (count) => Array.from({ length: count }, (_unused, index) => lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", `public-bound-${index + 1}`, {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  }));

  const completeRecords = recordsFor(49);
  const completeRoute = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target: completeRecords[0],
    records: completeRecords,
  });
  const complete = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 49,
  }, {
    cwd: root,
    routing: completeRoute.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(complete.status, "completed");
  assert.equal(complete.results.length, 49);
  assert.deepEqual(completeRoute.calls.map(({ operation }) => operation), ["recall"]);
  assert.deepEqual(completeRoute.calls[0].selection, {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 50,
  });

  const saturatedRecords = recordsFor(50);
  const saturatedRoute = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target: saturatedRecords[0],
    records: saturatedRecords,
  });
  const saturated = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 50,
  }, {
    cwd: root,
    routing: saturatedRoute.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(saturated.status, "failed");
  assert.equal(saturated.error.code, "lifecycle_read_verification_failed");
  assert.equal(Object.hasOwn(saturated, "results"), false);
  assert.deepEqual(saturatedRoute.calls.map(({ operation }) => operation), ["recall"]);

  const rejectedRoute = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target: initial,
    records: [],
  });
  const rejected = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 51,
  }, {
    cwd: root,
    routing: rejectedRoute.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.error.code, "lifecycle_read_request_invalid");
  assert.deepEqual(rejectedRoute.calls, []);
  assert.deepEqual(rejectedRoute.fallbackCalls, []);
});

test("public lifecycle reads expose Qdrant continuation overflow as recall verification failure", async (t) => {
  const root = await pinTestRoot(t);
  const calls = [];
  const routing = createLifecycleRouting([{
    provider: "qdrant",
    recall: async (selection) => {
      calls.push(structuredClone(selection));
      return {
        status: "blocked",
        provider: "qdrant",
        code: "lifecycle_provider_recall_overflow",
      };
    },
  }]);

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 1,
  }, {
    cwd: root,
    routing,
    resolveProjectRoot: async () => root,
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_unavailable",
      message: "Lifecycle read is unavailable.",
      diagnostic: {
        stage: "provider",
        code: "provider_verification_failed",
        step: "recall",
        reason: "recall_overflow",
      },
    },
  });
  assert.deepEqual(calls, [{
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 50,
  }]);
});

test("public lifecycle reads reject caller authority and block pending state without changing cycle-only plan discovery", async (t) => {
  const root = await pinTestRoot(t);
  const record = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "boundary"),
    root,
  });
  const descriptor = lifecycleReadDescriptorFor(record);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial: record,
    target: record,
    records: [record],
  });
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "lifecycleKey", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return SKYNET_230_LIFECYCLE_KEY;
    },
  });
  const sparse = [];
  sparse[1] = SKYNET_230_LIFECYCLE_KEY;
  const invalidRequests = [
    { lifecycleKey: SKYNET_230_LIFECYCLE_KEY, provider: "qdrant" },
    { lifecycleKey: SKYNET_230_LIFECYCLE_KEY, checkoutRoot: root },
    { lifecycleKey: "token=synthetic-read-secret" },
    { lifecycleKey: `${SKYNET_230_LIFECYCLE_KEY}\nplan` },
    { lifecycleKey: SKYNET_230_LIFECYCLE_KEY, limit: 0 },
    { lifecycleKey: SKYNET_230_LIFECYCLE_KEY, limit: 51 },
    { lifecycleKey: SKYNET_230_LIFECYCLE_KEY, limit: 1.5 },
    accessor,
    Object.create({ lifecycleKey: SKYNET_230_LIFECYCLE_KEY }),
    sparse,
  ];
  for (const request of invalidRequests) {
    const result = await coordinateLifecycleRecall(request, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "lifecycle_read_request_invalid");
    assert.doesNotMatch(JSON.stringify(result), /synthetic-read-secret/);
  }
  assert.equal(getterCalls, 0);

  for (const reference of [
    { ...descriptor.reference, provider: "qdrant" },
    { ...descriptor.reference, checkoutRoot: root },
  ]) {
    const malformedProof = await coordinateLifecycleGet({ ...descriptor, reference }, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
    });
    assert.equal(malformedProof.status, "failed");
    assert.equal(malformedProof.error.code, "lifecycle_read_request_invalid");
  }
  const secretSummary = await coordinateLifecycleGet({
    ...descriptor,
    summary: "token=synthetic-read-secret",
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(secretSummary.error.code, "lifecycle_read_request_invalid");
  assert.doesNotMatch(JSON.stringify(secretSummary), /synthetic-read-secret/);
  const callerProvider = await coordinateLifecycleGet({ ...descriptor, provider: "qdrant" }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(callerProvider.error.code, "lifecycle_read_request_invalid");
  assert.deepEqual(route.calls, []);
  assert.deepEqual(route.fallbackCalls, []);

  const attempt = createLifecycleProviderPinAttempt({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    provider: "qdrant",
    attemptId: "00000000-0000-4000-8000-000000000231",
    startedAt: SKYNET_230_TIMESTAMP,
  });
  assert.ok(attempt);
  const started = await beginLifecyclePinWith(async () => root)(root, attempt);
  assert.equal(started.status, "started");
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const publicRecall = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "plan",
    limit: 1,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  const publicGet = await coordinateLifecycleGet(descriptor, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(publicRecall.error.code, "lifecycle_read_authority_pending");
  assert.equal(publicGet.error.code, "lifecycle_read_authority_pending");
  assert.deepEqual(route.calls, []);
  assert.deepEqual(route.fallbackCalls, []);
  assert.equal(await readFile(registry, "utf8"), before);

  const cyclePlanDiscovery = await recallLifecycle(`${SKYNET_230_LIFECYCLE_KEY} plan`, root, {
    corpus: noHistoricalLifecycleCorpus,
    resolveProjectRoot: async () => root,
  });
  assert.deepEqual(cyclePlanDiscovery, { structuredContent: { results: [] } });
  assert.equal(await readFile(registry, "utf8"), before);
});

test("public lifecycle get accepts only a descriptor summary allowed by routed evidence", async (t) => {
  const root = await pinTestRoot(t);
  const record = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "summary-boundary"),
    root,
  });
  const descriptor = lifecycleReadDescriptorFor(record);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial: record,
    target: record,
    records: [record],
  });

  const accepted = await coordinateLifecycleGet({
    ...descriptor,
    summary: "my_api_key=fixture",
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.artifactId, record.artifactId);

  const rejected = await coordinateLifecycleGet({
    ...descriptor,
    summary: "Bearer opaque-value",
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(rejected.error.code, "lifecycle_read_request_invalid");
  assert.doesNotMatch(JSON.stringify(rejected), /opaque-value/);

  const mixed = await coordinateLifecycleGet({
    ...descriptor,
    summary: "Bearer token; Bearer opaque-value",
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(mixed.error.code, "lifecycle_read_request_invalid");
  assert.doesNotMatch(JSON.stringify(mixed), /opaque-value|Bearer token/);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["get"]);
  assert.deepEqual(route.fallbackCalls, []);
});

test("public lifecycle get fails closed for authority changes, cancellation, and provider failures", async (t) => {
  const scenarios = [
    {
      label: "authority changed",
      onGet: async ({ root }) => rm(join(root, ".ima-cycle", "provider-pins.json")),
      verify: async ({ root, result }) => {
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "lifecycle_read_authority_changed");
        assert.deepEqual(await loadLifecyclePinStateWith(async () => root)(root, SKYNET_230_LIFECYCLE_KEY), { status: "absent" });
      },
    },
    {
      label: "cancellation",
      onGet: async ({ controller }) => controller.abort(new Error("synthetic read cancelled")),
      verify: async ({ result }) => assert.equal(result, "cancelled"),
    },
    {
      label: "provider failure",
      onGet: async () => { throw new Error("token=synthetic-read-secret"); },
      verify: async ({ before, registry, result }) => {
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "lifecycle_read_unavailable");
        assert.doesNotMatch(JSON.stringify(result), /synthetic-read-secret/);
        assert.equal(await readFile(registry, "utf8"), before);
      },
    },
  ];

  for (const scenario of scenarios) {
    const root = await pinTestRoot(t);
    const initial = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("plan", `${scenario.label}-initial`),
      root,
    });
    const target = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("implementation", `${scenario.label}-target`, {
        lifecycleRootMemoryId: initial.artifactId,
      }),
      root,
    });
    await pinLifecycleReadAuthority(root, "qdrant", initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const controller = new AbortController();
    const route = lifecycleReadRoutingFor({
      provider: "qdrant",
      initial,
      target,
      records: [initial, target],
      onGet: async ({ signal }) => scenario.onGet({ root, controller, signal }),
    });
    const descriptor = lifecycleReadDescriptorFor(target);
    let result;
    if (scenario.label === "cancellation") {
      await assert.rejects(
        coordinateLifecycleGet(descriptor, {
          cwd: root,
          routing: route.routing,
          resolveProjectRoot: async () => root,
        }, controller.signal),
        /synthetic read cancelled/,
      );
      result = "cancelled";
      assert.equal(await readFile(registry, "utf8"), before);
    } else {
      result = await coordinateLifecycleGet(descriptor, {
        cwd: root,
        routing: route.routing,
        resolveProjectRoot: async () => root,
      });
    }
    await scenario.verify({ root, before, registry, result });
    assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "get"], scenario.label);
    assert.deepEqual(route.fallbackCalls, [], scenario.label);
  }
});

test("public lifecycle recall drops descriptors when pinned authority changes during the read", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "recall-authority-initial"),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target: initial,
    records: [initial],
  });
  const adapter = route.routing.adapters.qdrant;
  const originalRecall = adapter.recall;
  adapter.recall = async (...args) => {
    const result = await originalRecall(...args);
    await rm(join(root, ".ima-cycle", "provider-pins.json"));
    return result;
  };

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "plan",
    limit: 1,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_read_authority_changed");
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"]);
  assert.deepEqual(route.fallbackCalls, []);
  assert.deepEqual(await loadLifecyclePinStateWith(async () => root)(root, SKYNET_230_LIFECYCLE_KEY), { status: "absent" });
});

test("REVIEW-003 preserves unchanged root-plan and explicitly rooted later-pin lineage", async (t) => {
  for (const scenario of ["root-plan", "later-pin"]) {
    const root = await pinTestRoot(t);
    const rootPlan = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("plan", `${scenario}-root`),
      root,
    });
    const initial = scenario === "root-plan"
      ? rootPlan
      : lifecycleReadRecordFor({
        provider: "qdrant",
        request: lifecycleReadRequestFor("rereview", `${scenario}-initial`, {
          lifecycleRootMemoryId: rootPlan.artifactId,
        }),
        root,
      });
    await pinLifecycleReadAuthority(root, "qdrant", initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const route = lifecycleReadRoutingFor({
      provider: "qdrant",
      initial,
      target: rootPlan,
      records: [rootPlan, initial],
    });

    const result = await resolveLifecycleLineage(SKYNET_230_LIFECYCLE_KEY, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
    });

    assert.equal(result.status, "verified", scenario);
    if (result.status !== "verified") throw new Error(`expected verified lineage for ${scenario}`);
    assert.equal(result.lineage.rootArtifactId, rootPlan.artifactId, scenario);
    assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile"], scenario);
    assert.deepEqual(route.fallbackCalls, [], scenario);
    assert.equal(await readFile(registry, "utf8"), before, scenario);
  }
});

test("REVIEW-003 blocks removed, replaced, and corrupt pins after provider lineage verification", async (t) => {
  const scenarios = [
    {
      label: "removed",
      change: async ({ registry }) => {
        await rm(registry);
        return null;
      },
      verify: async ({ root, registry }) => {
        assert.deepEqual(
          await loadLifecyclePinStateWith(async () => root)(root, SKYNET_230_LIFECYCLE_KEY),
          { status: "absent" },
        );
        await assert.rejects(readFile(registry, "utf8"), { code: "ENOENT" });
      },
    },
    {
      label: "replaced",
      change: async ({ root, registry, initial, pinned }) => {
        const replacement = lifecycleReadRecordFor({
          provider: "qdrant",
          request: lifecycleReadRequestFor("rereview", "replaced-pin", {
            lifecycleRootMemoryId: initial.artifactId,
          }),
          root,
        });
        const replacementPin = createLifecycleProviderPin({
          lifecycleKey: replacement.lifecycleKey,
          provider: "qdrant",
          initialReference: replacement.reference,
          artifactId: replacement.artifactId,
          recordKey: replacement.recordKey,
          pinnedAt: "2026-10-01T00:00:01.000Z",
        });
        assert.ok(replacementPin);
        assert.notDeepEqual(replacementPin, pinned);
        const changed = `${JSON.stringify({
          schemaVersion: 1,
          entries: [{ status: "pinned", pin: replacementPin }],
        })}\n`;
        await writeFile(registry, changed, "utf8");
        return changed;
      },
      verify: async ({ registry, changed }) => {
        assert.equal(await readFile(registry, "utf8"), changed);
      },
    },
    {
      label: "corrupt",
      change: async ({ registry }) => {
        const changed = "{\n";
        await writeFile(registry, changed, "utf8");
        return changed;
      },
      verify: async ({ registry, changed }) => {
        assert.equal(await readFile(registry, "utf8"), changed);
      },
    },
  ];

  for (const scenario of scenarios) {
    const root = await pinTestRoot(t);
    const initial = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("plan", `${scenario.label}-initial`),
      root,
    });
    const pinned = await pinLifecycleReadAuthority(root, "qdrant", initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    let changed;
    const route = lifecycleReadRoutingFor({
      provider: "qdrant",
      initial,
      target: initial,
      records: [initial],
      onReconcile: async () => {
        changed = await scenario.change({ root, registry, initial, pinned });
      },
    });

    const result = await resolveLifecycleLineage(SKYNET_230_LIFECYCLE_KEY, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
    });

    assert.deepEqual(result, { status: "blocked", code: "lifecycle_lineage_unavailable" }, scenario.label);
    assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile"], scenario.label);
    assert.deepEqual(route.calls.filter(({ operation }) => operation === "persist"), [], scenario.label);
    assert.deepEqual(route.fallbackCalls, [], scenario.label);
    await scenario.verify({ root, registry, changed });
  }
});

test("REVIEW-003 preserves cancellation during the final lineage authority check", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "final-authority-cancellation"),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target: initial,
    records: [initial],
  });
  const controller = new AbortController();
  const reason = new Error("final lineage authority check cancelled");
  let resolverCalls = 0;
  const resolveProjectRoot = async () => {
    resolverCalls += 1;
    if (resolverCalls === 3) controller.abort(reason);
    return root;
  };

  await assert.rejects(
    resolveLifecycleLineage(SKYNET_230_LIFECYCLE_KEY, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot,
    }, controller.signal),
    (error) => {
      assert.equal(error, reason);
      return true;
    },
  );

  assert.equal(resolverCalls, 3);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile"]);
  assert.deepEqual(route.calls.filter(({ operation }) => operation === "persist"), []);
  assert.deepEqual(route.fallbackCalls, []);
  assert.equal(await readFile(registry, "utf8"), before);
});

test("REVIEW-001 aborts in-flight production BookStack recall and get transports", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const operation of ["recall", "get"]) {
    const fixture = await bookStackPublicReadFixture(t);
    const transport = bookStackPublicReadTransport(fixture, (call) =>
      call.method === "GET" && call.pathname === (operation === "recall"
        ? "/api/pages"
        : `/api/pages/${fixture.targetPage.id}`),
    );
    globalThis.fetch = transport.fetch;
    const corpus = corpusAccessCounter();
    let fallbackCalls = 0;
    const controller = new AbortController();
    const supplied = {
      cwd: fixture.root,
      corpus: corpus.corpus,
      environment: fixture.environment,
      resolveProjectRoot: async () => fixture.root,
      session: async () => {
        fallbackCalls += 1;
        throw new Error("fallback is forbidden");
      },
    };
    const pagesBefore = JSON.stringify(fixture.pages);
    const pending = operation === "recall"
      ? coordinateLifecycleRecall({
        lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
        phase: "implementation",
        limit: 1,
      }, supplied, controller.signal)
      : coordinateLifecycleGet(fixture.descriptor, supplied, controller.signal);

    await transport.pending;
    const activeSignal = transport.blockedSignal();
    assert.ok(activeSignal, `${operation} receives an active BookStack transport signal`);
    const callsBeforeAbort = transport.calls.length;
    const reason = new Error(`BookStack ${operation} cancelled`);
    controller.abort(reason);
    const transportAborted = activeSignal.aborted;
    if (!transportAborted) transport.cancel(reason);
    await assert.rejects(pending, (error) => {
      assert.equal(error, reason);
      return true;
    });

    assert.equal(transportAborted, true, `${operation} abort reaches the transport signal`);
    assert.equal(transport.transportAborts(), 1, `${operation} aborts its active transport`);
    assert.equal(transport.calls.length, callsBeforeAbort, `${operation} makes no request after abort`);
    assert.equal(transport.calls.every(({ origin }) => origin === "https://bookstack.test"), true);
    assert.equal(transport.calls.every(({ method }) => method === "GET"), true);
    assert.equal(transport.calls.every(({ signal }) => signal && typeof signal.aborted === "boolean"), true);
    assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
    assert.equal(JSON.stringify(fixture.pages), pagesBefore);
    assert.equal(corpus.calls(), 0);
    assert.equal(fallbackCalls, 0);
  }
});

test("REVIEW-002 rejects cancellation during final public recall and get authority checks", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const operation of ["recall", "get"]) {
    const fixture = await bookStackPublicReadFixture(t);
    const transport = bookStackPublicReadTransport(fixture);
    globalThis.fetch = transport.fetch;
    const corpus = corpusAccessCounter();
    let fallbackCalls = 0;
    let resolveFinalAuthority;
    const finalAuthorityStarted = new Promise((resolve) => { resolveFinalAuthority = resolve; });
    let releaseFinalAuthority;
    const finalAuthorityRelease = new Promise((resolve) => { releaseFinalAuthority = resolve; });
    let resolverCalls = 0;
    const finalResolverCall = operation === "recall" ? 3 : 4;
    const resolveProjectRoot = async () => {
      resolverCalls += 1;
      if (resolverCalls === finalResolverCall) {
        resolveFinalAuthority();
        await finalAuthorityRelease;
      }
      return fixture.root;
    };
    const controller = new AbortController();
    const supplied = {
      cwd: fixture.root,
      corpus: corpus.corpus,
      environment: fixture.environment,
      resolveProjectRoot,
      session: async () => {
        fallbackCalls += 1;
        throw new Error("fallback is forbidden");
      },
    };
    const pending = operation === "recall"
      ? coordinateLifecycleRecall({
        lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
        phase: "implementation",
        limit: 1,
      }, supplied, controller.signal)
      : coordinateLifecycleGet(fixture.descriptor, supplied, controller.signal);

    await finalAuthorityStarted;
    assert.equal(
      transport.calls.some(({ pathname }) => pathname === (operation === "recall"
        ? "/api/pages"
        : `/api/pages/${fixture.targetPage.id}`)),
      true,
      `${operation} provider read completed before final authority check`,
    );
    const callsBeforeAbort = transport.calls.length;
    const reason = new Error(`final ${operation} authority check cancelled`);
    controller.abort(reason);
    releaseFinalAuthority();
    await assert.rejects(pending, (error) => {
      assert.equal(error, reason);
      return true;
    });

    assert.equal(resolverCalls, finalResolverCall, `${operation} reaches its final authority resolver`);
    assert.equal(transport.calls.length, callsBeforeAbort, `${operation} makes no provider call after final authority abort`);
    assert.equal(transport.calls.every(({ origin }) => origin === "https://bookstack.test"), true);
    assert.equal(transport.calls.every(({ method }) => method === "GET"), true);
    assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
    assert.equal(corpus.calls(), 0);
    assert.equal(fallbackCalls, 0);
  }
});

test("TEST-007 registered public lifecycle reads use pinned BookStack process.env wiring", async (t) => {
  const fixture = await bookStackPublicReadFixture(t);
  const originalFetch = globalThis.fetch;
  const environmentKeys = ["BOOKSTACK_BASE_URL", "BOOKSTACK_ORIGIN", "BOOKSTACK_TOKEN_ID", "BOOKSTACK_TOKEN_SECRET"];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const environment = {
    ...fixture.environment,
    BOOKSTACK_ORIGIN: fixture.environment.BOOKSTACK_BASE_URL,
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
  });
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;

  const transport = bookStackPublicReadTransport(fixture);
  globalThis.fetch = transport.fetch;
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const recall = tools.find((tool) => tool.name === "ima_lifecycle_recall");
  const get = tools.find((tool) => tool.name === "ima_lifecycle_get");
  assert.ok(recall);
  assert.ok(get);
  const context = { cwd: fixture.root, mode: "json", hasUI: false, ui: {} };

  const recalled = await recall.execute("test", {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 1,
  }, undefined, undefined, context);
  assert.equal(recalled.details.status, "completed");
  assert.equal(recalled.details.results.length, 1);
  assert.equal(Check(get.parameters, recalled.details.results[0]), true);
  const [{ summary, ...descriptor }] = recalled.details.results;
  assert.deepEqual([descriptor], [fixture.descriptor]);
  assert.equal(typeof summary, "string");
  assert.equal(summary.length > 0, true);
  assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
  const callsAfterRecall = transport.calls.length;
  assert.equal(callsAfterRecall > 0, true);
  assert.equal(
    transport.calls.slice(0, callsAfterRecall).some(({ pathname }) => pathname === "/api/pages"),
    true,
  );

  const selector = {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    artifactId: fixture.descriptor.artifactId,
  };
  assert.equal(Check(get.parameters, selector), true);
  const retrieved = await get.execute(
    "test",
    selector,
    undefined,
    undefined,
    context,
  );
  assert.equal(retrieved.details.status, "completed");
  assert.equal(retrieved.details.artifactId, fixture.descriptor.artifactId);
  assert.equal(retrieved.details.recordKey, fixture.descriptor.recordKey);
  assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
  assert.equal(transport.calls.length > callsAfterRecall, true);
  assert.equal(
    transport.calls.slice(callsAfterRecall).some(({ pathname }) =>
      pathname === `/api/pages/${fixture.targetPage.id}`),
    true,
  );

  const expectedPaths = new Set([
    "/api/shelves/1",
    "/api/books/2",
    "/api/chapters/3",
    "/api/pages",
    ...fixture.pages.map(({ id }) => `/api/pages/${id}`),
  ]);
  assert.equal(
    transport.calls.every(({ origin, pathname, method }) =>
      origin === fixture.environment.BOOKSTACK_BASE_URL
      && method === "GET"
      && expectedPaths.has(pathname)),
    true,
  );
  assert.equal(
    JSON.stringify({ recalled, retrieved }).includes(fixture.environment.BOOKSTACK_TOKEN_ID),
    false,
  );
  assert.equal(
    JSON.stringify({ recalled, retrieved }).includes(fixture.environment.BOOKSTACK_TOKEN_SECRET),
    false,
  );
});

test("TEST-008 registered public lifecycle reads expose a safe provider diagnostic", async (t) => {
  const fixture = await bookStackPublicReadFixture(t);
  const originalFetch = globalThis.fetch;
  const environmentKeys = ["BOOKSTACK_BASE_URL", "BOOKSTACK_ORIGIN", "BOOKSTACK_TOKEN_ID", "BOOKSTACK_TOKEN_SECRET"];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const environment = {
    ...fixture.environment,
    BOOKSTACK_ORIGIN: fixture.environment.BOOKSTACK_BASE_URL,
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
  });
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;

  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ origin: url.origin, pathname: url.pathname, method: init.method ?? "GET" });
    return new Response("denied", { status: 403 });
  };
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const recall = tools.find((tool) => tool.name === "ima_lifecycle_recall");
  assert.ok(recall);

  const result = await recall.execute("test", {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 1,
  }, undefined, undefined, { cwd: fixture.root, mode: "json", hasUI: false, ui: {} });

  assert.deepEqual(result.details, {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_unavailable",
      message: "Lifecycle read is unavailable.",
      diagnostic: { stage: "provider", code: "provider_access_denied" },
    },
  });
  assert.deepEqual(calls, [{
    origin: fixture.environment.BOOKSTACK_BASE_URL,
    pathname: "/api/pages/1796",
    method: "GET",
  }]);
  assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
  assert.doesNotMatch(JSON.stringify(result), /test-token-(?:id|secret)/);
});

test("public lifecycle reads expose a safe BookStack HTTP failure diagnostic", async (t) => {
  const fixture = await bookStackPublicReadFixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ origin: url.origin, pathname: url.pathname, method: init.method ?? "GET" });
    return new Response("upstream failure", { status: 502 });
  };

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 1,
  }, {
    cwd: fixture.root,
    environment: fixture.environment,
    resolveProjectRoot: async () => fixture.root,
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_unavailable",
      message: "Lifecycle read is unavailable.",
      diagnostic: {
        stage: "provider",
        code: "provider_unavailable",
        step: "authority",
        reason: "http_failed",
      },
    },
  });
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({
    origin: fixture.environment.BOOKSTACK_BASE_URL,
    pathname: "/api/pages/1796",
    method: "GET",
  })));
  assert.doesNotMatch(JSON.stringify(result), /test-token-(?:id|secret)/);
  assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
});

test("public lifecycle reads expose selected BookStack recall overflow safely", async (t) => {
  const fixture = await bookStackPublicReadFixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const overflowPages = Array.from({ length: 51 }, (_unused, index) => {
    const request = lifecycleReadRequestFor("implementation", `bookstack-overflow-${index + 1}`, {
      lifecycleRootMemoryId: fixture.initialRecord.artifactId,
      priorArtifactIds: [fixture.initialRecord.artifactId],
    });
    const record = createLifecycleRecord({
      request: {
        type: request.type,
        identity: request.identity,
        summary: request.summary,
        artifact: request.artifact,
      },
      placement: fixture.placement,
    });
    return {
      id: 1900 + index,
      name: `${record.phase}-${record.artifactId}`,
      slug: `${record.phase}-${record.artifactId}`,
      book_id: fixture.placement.bookId,
      chapter_id: fixture.placement.chapterId,
      markdown: record.pageMarkdown,
      revision_count: 1,
      updated_at: SKYNET_230_TIMESTAMP,
      created_by: { id: 7 },
      updated_by: { id: 8 },
    };
  });
  fixture.pages.splice(0, fixture.pages.length, fixture.pages[0], ...overflowPages);
  const transport = bookStackPublicReadTransport(fixture);
  globalThis.fetch = transport.fetch;

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 50,
  }, {
    cwd: fixture.root,
    environment: fixture.environment,
    resolveProjectRoot: async () => fixture.root,
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_unavailable",
      message: "Lifecycle read is unavailable.",
      diagnostic: {
        stage: "provider",
        code: "provider_verification_failed",
        step: "recall",
        reason: "recall_overflow",
      },
    },
  });
  assert.equal(transport.calls.filter(({ pathname }) => pathname === "/api/pages").length, 1);
  assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
  assert.doesNotMatch(JSON.stringify(result), /test-token-(?:id|secret)/);
});

test("lifecycle routing labels selected recall excess as a recall overflow", async (t) => {
  const root = await pinTestRoot(t);
  const plan = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "overflow-root"),
    root,
  });
  const first = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "overflow-first", {
      lifecycleRootMemoryId: plan.artifactId,
      priorArtifactIds: [plan.artifactId],
    }),
    root,
  });
  const second = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "overflow-second", {
      lifecycleRootMemoryId: plan.artifactId,
      priorArtifactIds: [plan.artifactId],
    }),
    root,
  });
  const selections = [];
  const routing = createLifecycleRouting([{
    provider: "qdrant",
    persist: async () => ({
      status: "blocked",
      provider: "qdrant",
      code: "read_only_fixture",
      writeState: "no-write",
    }),
    recall: async (selection) => {
      selections.push(structuredClone(selection));
      return {
        status: "verified",
        provider: "qdrant",
        records: [structuredClone(first), structuredClone(second)],
      };
    },
  }]);

  const result = await routeLifecycleRecall({
    routing,
    provider: "qdrant",
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 1,
  });

  assert.deepEqual(result, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_provider_recall_overflow",
  });
  assert.deepEqual(selections, [{
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    phase: "implementation",
    limit: 1,
  }]);
});

test("TEST-009 registered public lifecycle reads diagnose an unavailable BookStack adapter", async (t) => {
  const fixture = await bookStackPublicReadFixture(t);
  const environmentKeys = ["BOOKSTACK_BASE_URL", "BOOKSTACK_ORIGIN", "BOOKSTACK_TOKEN_ID", "BOOKSTACK_TOKEN_SECRET"];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of environmentKeys) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
  });
  for (const key of environmentKeys) delete process.env[key];

  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const recall = tools.find((tool) => tool.name === "ima_lifecycle_recall");
  assert.ok(recall);
  const result = await recall.execute("test", {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 1,
  }, undefined, undefined, { cwd: fixture.root, mode: "json", hasUI: false, ui: {} });

  assert.deepEqual(result.details, {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_unavailable",
      message: "Lifecycle read is unavailable.",
      diagnostic: { stage: "provider", code: "provider_adapter_unavailable" },
    },
  });
  assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
});

test("TEST-010 registered public lifecycle reads identify an invalid authority response", async (t) => {
  const fixture = await bookStackPublicReadFixture(t);
  const originalFetch = globalThis.fetch;
  const environmentKeys = ["BOOKSTACK_BASE_URL", "BOOKSTACK_ORIGIN", "BOOKSTACK_TOKEN_ID", "BOOKSTACK_TOKEN_SECRET"];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const environment = {
    ...fixture.environment,
    BOOKSTACK_ORIGIN: fixture.environment.BOOKSTACK_BASE_URL,
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
  });
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;

  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ origin: url.origin, pathname: url.pathname, method: init.method ?? "GET" });
    return new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const recall = tools.find((tool) => tool.name === "ima_lifecycle_recall");
  assert.ok(recall);

  const result = await recall.execute("test", {
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 1,
  }, undefined, undefined, { cwd: fixture.root, mode: "json", hasUI: false, ui: {} });

  assert.deepEqual(result.details, {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_unavailable",
      message: "Lifecycle read is unavailable.",
      diagnostic: {
        stage: "provider",
        code: "provider_response_invalid",
        step: "authority",
        reason: "response_decode_invalid",
      },
    },
  });
  assert.deepEqual(calls, [{
    origin: fixture.environment.BOOKSTACK_BASE_URL,
    pathname: "/api/pages/1796",
    method: "GET",
  }]);
  assert.equal(await readFile(fixture.registry, "utf8"), fixture.before);
  assert.doesNotMatch(JSON.stringify(result), /test-token-(?:id|secret)/);
});

test("TEST-011 public lifecycle recall reports a safe rejected-record field", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "diagnostic-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "diagnostic-target", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, { ...target, summary: "Bearer token; Bearer opaque-record-value" }],
  });

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 2,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_unavailable",
      message: "Lifecycle read is unavailable.",
      diagnostic: {
        stage: "provider",
        code: "provider_verification_failed",
        step: "recall",
        phase: "implementation",
        reason: "record_summary_invalid",
        findings: [{
          category: "bearer_credential",
          field: "summary",
          index: null,
          line: 1,
          column: 15,
        }],
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /opaque-record-value|Bearer token/);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"]);
  assert.deepEqual(route.fallbackCalls, []);
  assert.equal(await readFile(registry, "utf8"), before);
});

test("TEST-012 public lifecycle recall reports a safe secret-shaped artifact", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "artifact-diagnostic-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "artifact-diagnostic-target", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, { ...target, artifact: "Bearer token; Bearer opaque-artifact-value" }],
  });

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 2,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "failed",
    error: {
      code: "lifecycle_read_unavailable",
      message: "Lifecycle read is unavailable.",
      diagnostic: {
        stage: "provider",
        code: "provider_verification_failed",
        step: "recall",
        phase: "implementation",
        reason: "record_artifact_secret_bearer_value",
        findings: [{
          category: "bearer_credential",
          field: "artifact",
          index: null,
          line: 1,
          column: 15,
        }],
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /opaque-artifact-value|Bearer token/);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"]);
  assert.deepEqual(route.fallbackCalls, []);
  assert.equal(await readFile(registry, "utf8"), before);
});

test("TEST-013 public lifecycle recall accepts a Bearer placeholder", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "placeholder-diagnostic-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "Bearer token", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 2,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.results.map(({ artifactId }) => artifactId).sort(), [
    initial.artifactId,
    target.artifactId,
  ].sort());
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"]);
  assert.deepEqual(route.fallbackCalls, []);
});

test("TEST-014 public lifecycle recall accepts a composite Bearer placeholder", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "composite-placeholder-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "Bearer ${tokenId}:${tokenSecret}", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 2,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.results.map(({ artifactId }) => artifactId).sort(), [
    initial.artifactId,
    target.artifactId,
  ].sort());
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"]);
  assert.deepEqual(route.fallbackCalls, []);
});

test("TEST-015 public lifecycle recall withholds a non-definitive synthetic bearer marker", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "synthetic-placeholder-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "Bearer test-token-value", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 2,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_read_unavailable");
  assert.equal(result.error.diagnostic.reason, "record_summary_invalid");
  assert.deepEqual(
    result.error.diagnostic.findings.map(({ category, field, index }) => ({ category, field, index })),
    [
      { category: "synthetic_bearer", field: "summary", index: null },
      { category: "synthetic_bearer", field: "artifact", index: null },
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /test-token-value/);
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"]);
  assert.deepEqual(route.fallbackCalls, []);
});

test("TEST-015b captures a warning-tier read only for process-local continuation", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "warning-capture-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "Bearer test-token-value", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });
  let captured = null;
  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 2,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
    captureContentWarning: (warning) => { captured = warning; },
  });

  assert.equal(result.status, "failed");
  assert.equal(captured?.kind, "read-recall");
  assert.equal(captured?.warnings.length, 1);
  assert.deepEqual(captured?.warnings.map(({ findings }) =>
    findings.map(({ category, field }) => ({ category, field }))), [[
    { category: "synthetic_bearer", field: "summary" },
    { category: "synthetic_bearer", field: "artifact" },
  ]]);
  assert.doesNotMatch(JSON.stringify(result), /test-token-value/);
});

test("TEST-001 captures every warning binding with correlated safe findings", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "multi-warning-root"),
    root,
  });
  const summaryWarning = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "ordinary-artifact", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  const artifactWarning = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("test", "Bearer test-token-value", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target: summaryWarning,
    records: [
      initial,
      artifactWarning,
      { ...summaryWarning, summary: "Bearer test-token-value" },
    ],
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  let captured = null;
  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 3,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
    captureContentWarning: (warning) => { captured = warning; },
  });

  assert.equal(result.status, "failed");
  assert.equal(captured?.kind, "read-recall");
  assert.equal(captured?.warnings.length, 2);
  assert.equal(new Set(captured?.warnings.map(({ binding }) => binding)).size, 2);
  assert.deepEqual(captured?.warnings.map(({ findings }) =>
    findings.map(({ field }) => field).sort()), [
    ["artifact", "summary"],
    ["summary"],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /test-token-value/);
});

test("TEST-002 block precedence discards mixed warning candidates in either provider order", async (t) => {
  for (const recordsOrder of ["warning-first", "block-first"]) {
    const root = await pinTestRoot(t);
    const initial = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("plan", `${recordsOrder}-root`),
      root,
    });
    const warning = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("implementation", "Bearer test-token-value", {
        lifecycleRootMemoryId: initial.artifactId,
      }),
      root,
    });
    const blocked = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("test", "ordinary-block-artifact", {
        lifecycleRootMemoryId: initial.artifactId,
      }),
      root,
    });
    const records = recordsOrder === "warning-first"
      ? [initial, warning, { ...blocked, artifact: "token=not-a-placeholder" }]
      : [initial, { ...blocked, artifact: "token=not-a-placeholder" }, warning];
    await pinLifecycleReadAuthority(root, "qdrant", initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const route = lifecycleReadRoutingFor({
      provider: "qdrant",
      initial,
      target: warning,
      records,
    });
    let captured = null;
    const result = await coordinateLifecycleRecall({
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      limit: 3,
    }, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
      captureContentWarning: (warningCapture) => { captured = warningCapture; },
    });

    assert.equal(result.status, "failed", recordsOrder);
    assert.equal(result.error.code, "lifecycle_read_unavailable", recordsOrder);
    assert.equal(result.error.diagnostic.reason, "record_artifact_secret_named", recordsOrder);
    assert.equal(captured, null, recordsOrder);
    assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"], recordsOrder);
    assert.equal(await readFile(registry, "utf8"), before, recordsOrder);
    assert.doesNotMatch(JSON.stringify(result), /not-a-placeholder|test-token-value/, recordsOrder);
  }
});

test("read warning overflow is noncontinuable while exactly 16 findings remain disclosed", async (t) => {
  const warningLines = (count) => Array.from(
    { length: count },
    (_unused, index) => `Bearer test-warning-${index + 1}`,
  ).join("\n");
  for (const count of [16, 17]) {
    const root = await pinTestRoot(t);
    const initial = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("plan", `overflow-root-${count}`),
      root,
    });
    const target = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("implementation", "ordinary-overflow-artifact", {
        lifecycleRootMemoryId: initial.artifactId,
      }),
      root,
    });
    await pinLifecycleReadAuthority(root, "qdrant", initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const route = lifecycleReadRoutingFor({
      provider: "qdrant",
      initial,
      target,
      records: [initial, { ...target, artifact: warningLines(count) }],
    });
    let captured = null;
    const result = await coordinateLifecycleRecall({
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      limit: 2,
    }, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
      captureContentWarning: (warning) => { captured = warning; },
    });

    assert.equal(result.status, "failed", count);
    assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"], count);
    assert.equal(await readFile(registry, "utf8"), before, count);
    if (count === 16) {
      assert.equal(captured?.warnings.length, 1);
      assert.equal(captured?.warnings[0].findings.length, 16);
    } else {
      assert.equal(captured, null);
      assert.deepEqual(result.error.diagnostic.findings, [{
        category: "finding_overflow",
        field: "artifact",
        index: null,
        line: 17,
        column: 1,
      }]);
    }
  }
});

test("recall enforces warning bounds across records before capture and block precedence", async (t) => {
  const warningRecordFor = (initial, root, index) => {
    const record = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("implementation", `ordinary-record-${index}`, {
        lifecycleRootMemoryId: initial.artifactId,
      }),
      root,
      pageId: index + 10,
    });
    return { ...record, artifact: `Bearer test-warning-${index}` };
  };
  for (const count of [16, 17]) {
    const root = await pinTestRoot(t);
    const initial = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("plan", `batch-root-${count}`),
      root,
    });
    const warnings = Array.from(
      { length: count },
      (_unused, index) => warningRecordFor(initial, root, index + 1),
    );
    await pinLifecycleReadAuthority(root, "qdrant", initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const route = lifecycleReadRoutingFor({
      provider: "qdrant",
      initial,
      target: warnings[0],
      records: [initial, ...warnings],
    });
    let captured = null;
    const result = await coordinateLifecycleRecall({
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      limit: 20,
    }, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
      captureContentWarning: (warning) => { captured = warning; },
    });
    assert.equal(result.status, "failed", count);
    assert.equal(await readFile(registry, "utf8"), before, count);
    if (count === 16) {
      assert.equal(captured?.warnings.length, 16);
      assert.equal(captured?.warnings.flatMap(({ findings }) => findings).length, 16);
    } else {
      assert.equal(captured, null);
      assert.deepEqual(result.error.diagnostic.findings, [{
        category: "finding_overflow",
        field: "artifact",
        index: null,
        line: 1,
        column: 1,
      }]);
    }
  }

  for (const order of ["warnings-first", "block-first"]) {
    const root = await pinTestRoot(t);
    const initial = lifecycleReadRecordFor({
      provider: "qdrant",
      request: lifecycleReadRequestFor("plan", `batch-definite-${order}`),
      root,
    });
    const warnings = Array.from(
      { length: 17 },
      (_unused, index) => warningRecordFor(initial, root, index + 1),
    );
    const definite = {
      ...lifecycleReadRecordFor({
        provider: "qdrant",
        request: lifecycleReadRequestFor("test", `batch-definite-record-${order}`, {
          lifecycleRootMemoryId: initial.artifactId,
        }),
        root,
        pageId: 99,
      }),
      artifact: "token=not-a-placeholder",
    };
    await pinLifecycleReadAuthority(root, "qdrant", initial);
    const registry = join(root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");
    const route = lifecycleReadRoutingFor({
      provider: "qdrant",
      initial,
      target: warnings[0],
      records: order === "warnings-first"
        ? [initial, ...warnings, definite]
        : [initial, definite, ...warnings],
    });
    let captured = null;
    const result = await coordinateLifecycleRecall({
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      limit: 20,
    }, {
      cwd: root,
      routing: route.routing,
      resolveProjectRoot: async () => root,
      captureContentWarning: (warning) => { captured = warning; },
    });
    assert.equal(result.status, "failed", order);
    assert.equal(result.error.diagnostic.reason, "record_artifact_secret_named", order);
    assert.equal(captured, null, order);
    assert.equal(await readFile(registry, "utf8"), before, order);
  }
});

test("TEST-003 approved public recall decisions reach only fresh read dispatch", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "test-003-recall-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "Bearer test-token-value", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });
  const request = { lifecycleKey: SKYNET_230_LIFECYCLE_KEY, limit: 2 };
  let captured = null;
  const initialResult = await coordinateLifecycleRecall(request, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
    captureContentWarning: (warning) => { captured = warning; },
  });
  assert.equal(initialResult.status, "failed");
  assert.equal(captured?.warnings.length, 1);
  const context = {
    cwd: root,
    sessionManager: { getSessionId: () => "test-003-recall-session" },
  };
  const operationFor = (finding) => ({
    kind: "read-recall",
    request,
    warningDecisions: [{
      finding,
      findings: captured.warnings[0].findings,
      binding: captured.warnings[0].binding,
    }],
    approvedWarningBindings: [captured.warnings[0].binding],
  });
  const screening = { tier: "warn", findings: captured.warnings[0].findings };

  const incompletePending = beginLifecycleContentAdjudication({
    ctx: context,
    operation: operationFor("00000000-0000-4000-8000-000000000301"),
    screening,
  });
  assert.equal(incompletePending.status, "pending");
  const incomplete = continueLifecycleContentAdjudication({
    ctx: context,
    adjudication: {
      handle: incompletePending.result.adjudication.handle,
      decisions: [],
    },
  });
  assert.equal(incomplete.status, "failed");
  assert.equal(incomplete.result.error.code, "lifecycle_content_adjudication_invalid");

  const foreignPending = beginLifecycleContentAdjudication({
    ctx: context,
    operation: operationFor("00000000-0000-4000-8000-000000000302"),
    screening,
  });
  assert.equal(foreignPending.status, "pending");
  const foreign = continueLifecycleContentAdjudication({
    ctx: { ...context, sessionManager: { getSessionId: () => "foreign-session" } },
    adjudication: {
      handle: foreignPending.result.adjudication.handle,
      decisions: foreignPending.result.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "continue_after_review",
      })),
    },
  });
  assert.equal(foreign.status, "failed");
  assert.equal(foreign.result.error.code, "lifecycle_content_adjudication_mismatch");

  const malformedPending = beginLifecycleContentAdjudication({
    ctx: context,
    operation: operationFor("00000000-0000-4000-8000-000000000305"),
    screening,
  });
  assert.equal(malformedPending.status, "pending");
  const malformed = continueLifecycleContentAdjudication({
    ctx: context,
    adjudication: {
      handle: malformedPending.result.adjudication.handle,
      decisions: [{
        finding: "00000000-0000-4000-8000-000000000399",
        decision: "continue_after_review",
      }],
    },
  });
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.result.error.code, "lifecycle_content_adjudication_invalid");

  const pending = beginLifecycleContentAdjudication({
    ctx: context,
    operation: operationFor("00000000-0000-4000-8000-000000000303"),
    screening,
  });
  assert.equal(pending.status, "pending");
  const resumed = continueLifecycleContentAdjudication({
    ctx: context,
    adjudication: {
      handle: pending.result.adjudication.handle,
      decisions: pending.result.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "continue_after_review",
      })),
    },
  });
  assert.equal(resumed.status, "read");
  if (resumed.status !== "read") throw new Error("read continuation did not resume");
  const dispatched = await dispatchLifecycleContentRead({
    operation: resumed.operation,
    ctx: context,
    admission: resumed.admission,
    supplied: { routing: route.routing, resolveProjectRoot: async () => root },
  });
  assert.equal(dispatched.status, "completed");
  assert.deepEqual(route.calls.map(({ operation }) => operation), [
    "reconcile",
    "recall",
    "reconcile",
    "recall",
  ]);
  assert.equal(await readFile(registry, "utf8"), before);
  const replayed = continueLifecycleContentAdjudication({
    ctx: context,
    adjudication: {
      handle: pending.result.adjudication.handle,
      decisions: pending.result.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "continue_after_review",
      })),
    },
  });
  assert.equal(replayed.status, "failed");
  assert.equal(replayed.result.error.code, "lifecycle_content_adjudication_invalid");
});

test("TEST-003 approved public get decisions reach only fresh read dispatch", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "test-003-get-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "Bearer test-token-value", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });
  const binding = lifecycleContentBinding({
    provider: target.provider,
    artifactId: target.artifactId,
    recordKey: target.recordKey,
    lifecycleKey: target.lifecycleKey,
    phase: target.phase,
    summary: target.summary,
    artifact: target.artifact,
  });
  assert.ok(binding);
  const reference = lifecycleReadReferenceFor(target, {
    approvedWarningBindings: [binding],
  });
  assert.ok(reference);
  const request = {
    lifecycleKey: target.lifecycleKey,
    phase: target.phase,
    artifactId: target.artifactId,
    recordKey: target.recordKey,
    contentHash: createHash("sha256").update(target.artifact, "utf8").digest("hex"),
    reference,
    summary: target.summary,
  };
  assert.equal(request.summary, target.summary);
  let captured = null;
  const initialResult = await coordinateLifecycleGet(request, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
    captureContentWarning: (warning) => { captured = warning; },
  });
  assert.equal(initialResult.status, "failed");
  assert.equal(captured?.warnings.length, 1);
  assert.deepEqual(captured?.warnings[0].findings.map(({ field }) => field), [
    "summary",
    "artifact",
  ]);
  const context = {
    cwd: root,
    sessionManager: { getSessionId: () => "test-003-get-session" },
  };
  const pending = beginLifecycleContentAdjudication({
    ctx: context,
    operation: {
      kind: "read-get",
      request,
      warningDecisions: [{
        finding: "00000000-0000-4000-8000-000000000304",
        findings: captured.warnings[0].findings,
        binding: captured.warnings[0].binding,
      }],
      approvedWarningBindings: [captured.warnings[0].binding],
    },
    screening: { tier: "warn", findings: captured.warnings[0].findings },
  });
  assert.equal(pending.status, "pending");
  const resumed = continueLifecycleContentAdjudication({
    ctx: context,
    adjudication: {
      handle: pending.result.adjudication.handle,
      decisions: pending.result.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "continue_after_review",
      })),
    },
  });
  assert.equal(resumed.status, "read");
  if (resumed.status !== "read") throw new Error("get continuation did not resume");
  const dispatched = await dispatchLifecycleContentRead({
    operation: resumed.operation,
    ctx: context,
    admission: resumed.admission,
    supplied: { routing: route.routing, resolveProjectRoot: async () => root },
  });
  assert.equal(dispatched.status, "completed");
  assert.equal(dispatched.artifactId, request.artifactId);
  assert.deepEqual(route.calls.map(({ operation }) => operation), [
    "reconcile",
    "get",
    "reconcile",
    "get",
  ]);
  assert.equal(await readFile(registry, "utf8"), before);
});

test("TEST-016 public lifecycle recall accepts a plural Bearer placeholder", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("plan", "plural-placeholder-root"),
    root,
  });
  const target = lifecycleReadRecordFor({
    provider: "qdrant",
    request: lifecycleReadRequestFor("implementation", "Bearer placeholders", {
      lifecycleRootMemoryId: initial.artifactId,
    }),
    root,
  });
  await pinLifecycleReadAuthority(root, "qdrant", initial);
  const route = lifecycleReadRoutingFor({
    provider: "qdrant",
    initial,
    target,
    records: [initial, target],
  });

  const result = await coordinateLifecycleRecall({
    lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
    limit: 2,
  }, {
    cwd: root,
    routing: route.routing,
    resolveProjectRoot: async () => root,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.results.map(({ artifactId }) => artifactId).sort(), [
    initial.artifactId,
    target.artifactId,
  ].sort());
  assert.deepEqual(route.calls.map(({ operation }) => operation), ["reconcile", "recall"]);
  assert.deepEqual(route.fallbackCalls, []);
});

test("screens lifecycle content before corpus, provider, confirmation, or pin effects", async (t) => {
  const root = await pinTestRoot(t);
  const routed = localRouting();
  let confirmations = 0;
  const options = localRoutingOptions(root, routed.routing, {
    confirmProvider: async () => {
      confirmations += 1;
      return true;
    },
  });

  const blocked = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
    artifact: "token=not-a-placeholder",
  }, options);
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.error.code, "lifecycle_content_blocked");
  assert.deepEqual(blocked.error.findings, [{
    category: "credential_assignment",
    field: "artifact",
    index: null,
    line: 1,
    column: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(blocked), /not-a-placeholder/);

  for (const [field, request] of [
    ["summary", {
      ...localLifecycleRequest(),
      provider: "qdrant",
      summary: "Authorization: Basic QmFzaWM6dGVzdA==",
    }],
    ["artifact", {
      ...localLifecycleRequest(),
      provider: "qdrant",
      artifact: "Authorization: Basic QmFzaWM6dGVzdA==",
    }],
    ["identity.sourceRefs", {
      ...localLifecycleRequest(),
      provider: "qdrant",
      identity: {
        ...localLifecycleRequest().identity,
        sourceRefs: ["Authorization: Basic QmFzaWM6dGVzdA=="],
      },
    }],
  ]) {
    const result = await coordinateLifecycle(request, options);
    assert.equal(result.status, "failed", field);
    assert.equal(result.error.code, "lifecycle_content_blocked", field);
    assert.equal(result.error.findings[0].category, "basic_credential", field);
    assert.equal(result.error.findings[0].field, field, field);
    assert.doesNotMatch(JSON.stringify(result), /QmFzaWM6dGVzdA==/, field);
  }

  const basicFixture = "QmFzaWM6dGVzdA==";
  const basicFields = ["summary", "artifact", "identity.sourceRefs"];
  for (const [index, suffix] of ["", ".", "`", " ", ",", ")"].entries()) {
    const field = basicFields[index % basicFields.length];
    const value = `Basic ${basicFixture}${suffix}`;
    const request = field === "summary"
      ? { ...localLifecycleRequest(), provider: "qdrant", summary: value }
      : field === "artifact"
        ? { ...localLifecycleRequest(), provider: "qdrant", artifact: value }
        : {
          ...localLifecycleRequest(),
          provider: "qdrant",
          identity: {
            ...localLifecycleRequest().identity,
            sourceRefs: [value],
          },
        };
    const result = await coordinateLifecycle(request, options);
    assert.equal(result.status, "failed", `${field}:${suffix || "end"}`);
    assert.equal(result.error.code, "lifecycle_content_blocked", `${field}:${suffix || "end"}`);
    assert.equal(result.error.findings[0].category, "basic_credential", `${field}:${suffix || "end"}`);
    assert.equal(result.error.findings[0].field, field, `${field}:${suffix || "end"}`);
    assert.doesNotMatch(JSON.stringify(result), /QmFzaWM6dGVzdA==/, `${field}:${suffix || "end"}`);
  }

  const warned = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
    artifact: "Bearer test-token-value",
  }, options);
  assert.equal(warned.status, "failed");
  assert.equal(warned.error.code, "lifecycle_content_adjudication_required");
  assert.deepEqual(warned.error.findings, [{
    category: "synthetic_bearer",
    field: "artifact",
    index: null,
    line: 1,
    column: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(warned), /test-token-value/);
  assert.equal(confirmations, 0);
  assert.deepEqual(routed.calls, { qdrant: [], markdown: [] });
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey),
    { status: "absent" },
  );
});

test("write warning overflow returns no handle before provider or pin effects", async (t) => {
  const root = await pinTestRoot(t);
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.ok(lifecycle);
  const artifact = Array.from(
    { length: 17 },
    (_unused, index) => `Bearer test-warning-${index + 1}`,
  ).join("\n");
  const result = await lifecycle.execute("warning-overflow-237", {
    ...localLifecycleRequest(),
    provider: "qdrant",
    artifact,
  }, undefined, undefined, {
    cwd: root,
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => "warning-overflow-session" },
    ui: {},
  });

  assert.equal(result.details.status, "failed");
  assert.equal(result.details.error.code, "lifecycle_content_blocked");
  assert.equal(Object.hasOwn(result.details, "adjudication"), false);
  assert.deepEqual(result.details.error.findings, [{
    category: "finding_overflow",
    field: "artifact",
    index: null,
    line: 17,
    column: 1,
  }]);
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey),
    { status: "absent" },
  );
});

test("registered lifecycle warning bound exposes all 16 findings before adjudication", async (t) => {
  const root = await pinTestRoot(t);
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.ok(lifecycle);
  const artifact = Array.from(
    { length: 16 },
    (_unused, index) => `Bearer test-warning-${index + 1}`,
  ).join("\n");
  const context = {
    cwd: root,
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => "warning-bound-session" },
    ui: {},
  };
  const pending = await lifecycle.execute("warning-bound-237", {
    ...localLifecycleRequest(),
    provider: "qdrant",
    artifact,
  }, undefined, undefined, context);
  assert.equal(pending.details.status, "pending");
  assert.equal(pending.details.adjudication.findings.length, 16);
  assert.doesNotMatch(JSON.stringify(pending.details), /test-warning-1/);
  const rejected = await lifecycle.execute("warning-bound-reject-237", {
    contentAdjudication: {
      handle: pending.details.adjudication.handle,
      decisions: pending.details.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "reject",
      })),
    },
  }, undefined, undefined, context);
  assert.equal(rejected.details.error.code, "lifecycle_content_adjudication_declined");
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey),
    { status: "absent" },
  );
});

test("registered lifecycle warning rejection consumes an opaque manual handle without provider or pin effects", async (t) => {
  const root = await pinTestRoot(t);
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.ok(lifecycle);
  const context = {
    cwd: root,
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => "screening-denial-session-237" },
    ui: {
      select: async () => { throw new Error("provider selection must not run"); },
      confirm: async () => { throw new Error("confirmation must not run"); },
    },
  };
  const pending = await lifecycle.execute("screening-denial-237", {
    ...localLifecycleRequest(),
    provider: "qdrant",
    artifact: "Bearer test-token-value",
  }, undefined, undefined, context);

  assert.equal(pending.details.status, "pending");
  assert.equal(typeof pending.details.adjudication.handle, "string");
  assert.deepEqual(pending.details.adjudication.decisionValues, ["continue_after_review", "reject"]);
  assert.equal(pending.details.adjudication.findings.length, 1);
  assert.doesNotMatch(JSON.stringify(pending.details), /test-token-value/);

  const rejected = await lifecycle.execute("screening-denial-continuation-237", {
    contentAdjudication: {
      handle: pending.details.adjudication.handle,
      decisions: pending.details.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "reject",
      })),
    },
  }, undefined, undefined, context);
  assert.equal(rejected.details.status, "failed");
  assert.equal(rejected.details.error.code, "lifecycle_content_adjudication_declined");
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey),
    { status: "absent" },
  );
});

test("registered lifecycle manual continuation resumes one noninteractive write call after rescan", async (t) => {
  const root = await pinTestRoot(t);
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.ok(lifecycle);
  const context = {
    cwd: root,
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => "screening-session-237" },
    ui: {
      select: async () => { throw new Error("provider selection must not run before root validation"); },
      confirm: async () => { throw new Error("TUI confirmation must not run"); },
    },
  };
  const pending = await lifecycle.execute("screening-tool-237", {
    ...localLifecycleRequest("implementation"),
    provider: "qdrant",
    artifact: "Bearer test-token-value",
  }, undefined, undefined, context);
  assert.equal(pending.details.status, "pending");

  const resumed = await lifecycle.execute("screening-tool-continuation-237", {
    contentAdjudication: {
      handle: pending.details.adjudication.handle,
      decisions: pending.details.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "continue_after_review",
      })),
    },
  }, undefined, undefined, context);

  assert.equal(resumed.details.status, "failed");
  assert.equal(resumed.details.error.code, "lifecycle_initial_root_required");
  assert.doesNotMatch(JSON.stringify({ pending, resumed }), /test-token-value/);
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey),
    { status: "absent" },
  );
});

test("requires a complete explicit decision for every disclosed warning finding", async (t) => {
  const root = await pinTestRoot(t);
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.ok(lifecycle);
  const context = {
    cwd: root,
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => "complete-decisions-session-237" },
    ui: {},
  };
  const pending = await lifecycle.execute("complete-decisions-237", {
    ...localLifecycleRequest(),
    provider: "qdrant",
    identity: {
      ...identity,
      sourceRefs: ["Bearer synthetic-reference"],
    },
    artifact: "Bearer test-token-value",
  }, undefined, undefined, context);
  assert.equal(pending.details.status, "pending");
  assert.equal(pending.details.adjudication.findings.length, 2);
  assert.equal(
    new Set(pending.details.adjudication.findings.map(({ finding }) => finding)).size,
    2,
  );
  assert.deepEqual(
    pending.details.adjudication.findings.map(({ findings }) =>
      findings.map(({ field }) => field)),
    [["identity.sourceRefs"], ["artifact"]],
  );

  const incomplete = await lifecycle.execute("complete-decisions-continuation-237", {
    contentAdjudication: {
      handle: pending.details.adjudication.handle,
      decisions: [{
        finding: pending.details.adjudication.findings[0].finding,
        decision: "continue_after_review",
      }],
    },
  }, undefined, undefined, context);
  assert.equal(incomplete.details.status, "failed");
  assert.equal(incomplete.details.error.code, "lifecycle_content_adjudication_invalid");
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey),
    { status: "absent" },
  );
});

test("registered lifecycle continuation accepts no returned or resubmitted content", async (t) => {
  const root = await pinTestRoot(t);
  const tools = [];
  integrations({ registerTool: (tool) => tools.push(tool) });
  const lifecycle = tools.find((tool) => tool.name === "ima_lifecycle");
  assert.ok(lifecycle);
  const context = {
    cwd: root,
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => "screening-mutation-session-237" },
    ui: {},
  };
  const pending = await lifecycle.execute("screening-mutation-237", {
    ...localLifecycleRequest(),
    provider: "qdrant",
    artifact: "Bearer test-token-value",
  }, undefined, undefined, context);
  assert.equal(pending.details.status, "pending");

  const invalid = await lifecycle.execute("screening-mutation-invalid-237", {
    contentAdjudication: {
      handle: pending.details.adjudication.handle,
      decisions: pending.details.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "continue_after_review",
      })),
    },
    artifact: "token=not-a-placeholder",
  }, undefined, undefined, context);
  assert.equal(invalid.details.status, "failed");
  assert.equal(invalid.details.error.code, "lifecycle_content_adjudication_invalid");
  assert.doesNotMatch(JSON.stringify(invalid.details), /not-a-placeholder|test-token-value/);

  const rejected = await lifecycle.execute("screening-mutation-reject-237", {
    contentAdjudication: {
      handle: pending.details.adjudication.handle,
      decisions: pending.details.adjudication.findings.map(({ finding }) => ({
        finding,
        decision: "reject",
      })),
    },
  }, undefined, undefined, context);
  assert.equal(rejected.details.error.code, "lifecycle_content_adjudication_declined");
  assert.deepEqual(
    await loadLifecyclePinStateWith(async () => root)(root, lifecycleKey),
    { status: "absent" },
  );
});

test("projects a screened post-write record with its exact reason and possible-write state", async (t) => {
  const root = await pinTestRoot(t);
  const routed = localRouting({
    persist: async (request) => ({
      status: "verified",
      record: routedQdrantRecord(request, { artifact: "token=not-a-placeholder" }),
    }),
  });
  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(root, routed.routing));

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_provider_response_invalid");
  assert.equal(result.writeState, "possible-write");
  assert.deepEqual(result.error.diagnostic, {
    stage: "provider",
    code: "provider_content_screening_failed",
    reason: "record_artifact_secret_named",
    findings: [{
      category: "credential_assignment",
      field: "artifact",
      index: null,
      line: 1,
      column: 1,
    }],
  });
  assert.doesNotMatch(JSON.stringify(result), /not-a-placeholder/);
  assert.equal(routed.calls.qdrant.filter(({ operation }) => operation === "persist").length, 1);
  assert.deepEqual(routed.calls.markdown, []);
});

test("withholds an unexpected post-write warning with a precise possible-write diagnostic", async (t) => {
  const root = await pinTestRoot(t);
  const routed = localRouting({
    persist: async (request) => ({
      status: "verified",
      record: routedQdrantRecord(request, { artifact: "Bearer test-token-value" }),
    }),
  });
  const result = await coordinateLifecycle({
    ...localLifecycleRequest(),
    provider: "qdrant",
  }, localRoutingOptions(root, routed.routing));

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "lifecycle_provider_response_invalid");
  assert.equal(result.writeState, "possible-write");
  assert.deepEqual(result.error.diagnostic, {
    stage: "provider",
    code: "provider_content_screening_failed",
    reason: "record_artifact_secret_bearer_placeholder",
    findings: [{
      category: "synthetic_bearer",
      field: "artifact",
      index: null,
      line: 1,
      column: 1,
    }],
  });
  assert.doesNotMatch(JSON.stringify(result), /test-token-value/);
  assert.equal(routed.calls.qdrant.filter(({ operation }) => operation === "persist").length, 1);
  assert.deepEqual(routed.calls.markdown, []);
});

test("persistent BookStack rate limits identify authority and recall steps without mutating the pin", async (t) => {
  const root = await pinTestRoot(t);
  const initial = lifecycleReadRecordFor({
    provider: "bookstack",
    request: lifecycleReadRequestFor("plan", "rate-limit-root"),
    root,
    pageId: 1796,
  });
  await pinLifecycleReadAuthority(root, "bookstack", initial);
  const registry = join(root, ".ima-cycle", "provider-pins.json");
  const before = await readFile(registry, "utf8");

  for (const stage of ["authority", "recall"]) {
    const calls = [];
    const routing = createLifecycleRouting([{
      provider: "bookstack",
      persist: async () => ({
        status: "blocked",
        provider: "bookstack",
        code: "read_only_fixture",
        writeState: "no-write",
      }),
      reconcile: async () => {
        calls.push("reconcile");
        return stage === "authority"
          ? {
            status: "blocked",
            provider: "bookstack",
            code: "bookstack_rate_limited",
            writeState: "no-write",
          }
          : { status: "verified", record: structuredClone(initial) };
      },
      recall: async () => {
        calls.push("recall");
        return {
          status: "blocked",
          provider: "bookstack",
          code: "bookstack_rate_limited",
        };
      },
    }]);

    const result = await coordinateLifecycleRecall({
      lifecycleKey: SKYNET_230_LIFECYCLE_KEY,
      phase: "plan",
      limit: 1,
    }, {
      cwd: root,
      routing,
      resolveProjectRoot: async () => root,
    });

    assert.deepEqual(result, {
      schemaVersion: 1,
      status: "failed",
      error: {
        code: "lifecycle_read_unavailable",
        message: "Lifecycle read is unavailable.",
        diagnostic: {
          stage: "provider",
          code: "provider_rate_limited",
          step: stage,
        },
      },
    }, stage);
    assert.deepEqual(calls, stage === "authority" ? ["reconcile"] : ["reconcile", "recall"], stage);
    assert.equal(await readFile(registry, "utf8"), before, stage);
    assert.doesNotMatch(JSON.stringify(result), /test-token|secret/i, stage);
  }
});
