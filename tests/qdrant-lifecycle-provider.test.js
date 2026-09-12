import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareLifecycleArtifact,
  validateLifecycleRequest,
} from "../lib/ima-lifecycle.ts";
import {
  VECTOR_SIZE,
  corpusFailure,
  deriveRecordId,
  detailChunkIds,
  normalizeInstitutionalManifestPoint,
  reassembleInstitutionalManifest,
} from "../lib/qdrant-corpus.ts";
import { createQdrantLifecycleProvider } from "../lib/qdrant-lifecycle.ts";

const createdAt = "2026-09-12T01:00:00.000Z";
const planeIdentity = {
  project: "ima-pi",
  lifecycleKey: "ima-pi:plane:ima:SKYNET-211",
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  planeWorkspace: "ima",
  planeWorkItem: "SKYNET-211",
  sourceRefs: ["plane:ima:SKYNET-211"],
  priorArtifactIds: ["85e12eff-d162-5262-bbfe-ec0624cb40d9"],
};

const success = (data) => ({ success: true, data });
const failure = (code) => corpusFailure(code);
const vector = () => Array.from({ length: VECTOR_SIZE }, () => 0.25);
const lifecycleRequest = ({ identity = {}, ...overrides } = {}) => ({
  type: "implementation",
  identity: { ...planeIdentity, ...identity },
  summary: "SKYNET-211 Qdrant lifecycle provider implementation is verified.",
  artifact: "# Implementation\n\nQdrant lifecycle provider contract.",
  ...overrides,
});

const preparationFor = (request) => {
  const valid = validateLifecycleRequest(request);
  assert.equal(valid.valid, true);
  const preparation = prepareLifecycleArtifact(valid);
  assert.equal(preparation.valid, true);
  return preparation.data;
};

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

const readStoredRecord = (recordKey, points) => {
  const id = deriveRecordId(recordKey);
  if (!id.success) return id;
  const manifestPoint = points.get(id.data);
  if (!manifestPoint) return failure("record_not_found");
  const manifest = normalizeInstitutionalManifestPoint(manifestPoint);
  if (!manifest.success) return manifest;
  const chunks = detailChunkIds(
    manifest.data.recordKey,
    manifest.data.payload.chunk_count,
  ).flatMap((chunkId) => points.has(chunkId) ? [points.get(chunkId)] : []);
  const reassembled = reassembleInstitutionalManifest({ manifestPoint, chunkPoints: chunks });
  return reassembled.success ? success(fullRecord(reassembled.data)) : reassembled;
};

const createCorpus = (options = {}) => {
  const points = new Map();
  const calls = {
    getPoints: [],
    ensureCollection: 0,
    embedSummary: [],
    insertPoints: [],
    getInstitutional: [],
    recallLifecycleInstitutional: [],
  };
  const client = {
    getPoints: async (ids, signal) => {
      calls.getPoints.push([...ids]);
      const intercepted = await options.onGetPoints?.({ ids: [...ids], signal, calls, points });
      if (intercepted) return intercepted;
      return success(ids.flatMap((id) => points.has(id) ? [structuredClone(points.get(id))] : []));
    },
    ensureCollection: async (signal) => {
      calls.ensureCollection += 1;
      await options.onEnsureCollection?.({ signal, calls, points });
      return success(undefined);
    },
    embedSummary: async (summary, signal) => {
      calls.embedSummary.push(summary);
      await options.onEmbedSummary?.({ summary, signal, calls, points });
      return success(vector());
    },
    insertPoints: async ({ points: inserted }, signal) => {
      calls.insertPoints.push(inserted.map((point) => point.id));
      const intercepted = await options.onInsertPoints?.({ points: inserted, signal, calls, stored: points });
      if (intercepted) return intercepted;
      if (inserted.some((point) => points.has(point.id))) return failure("record_conflict");
      for (const point of inserted) {
        points.set(point.id, { id: point.id, payload: structuredClone(point.payload) });
      }
      return success(undefined);
    },
    getInstitutional: async (recordKey, signal) => {
      calls.getInstitutional.push(recordKey);
      const result = readStoredRecord(recordKey, points);
      return options.onGetInstitutional
        ? options.onGetInstitutional({ recordKey, signal, result, calls, points })
        : result;
    },
    recallLifecycleInstitutional: async (selection, signal) => {
      calls.recallLifecycleInstitutional.push({ selection: structuredClone(selection), signal });
      return options.onRecallLifecycleInstitutional
        ? options.onRecallLifecycleInstitutional({ selection, signal, calls, points })
        : failure("query_failed");
    },
  };
  return { client, calls, points };
};

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

test("persists only after exact direct read-back and keeps immutable retries unchanged", async () => {
  const corpus = createCorpus();
  const provider = createQdrantLifecycleProvider({
    client: corpus.client,
    now: () => new Date(createdAt),
  });
  const request = lifecycleRequest();
  const preparation = preparationFor(request);
  const first = await provider.persist(request);

  assert.equal(first.status, "verified");
  assert.equal(first.disposition, "stored");
  assert.equal(first.recordKey, preparation.recordKey);
  assert.equal(first.nonce, preparation.nonce);
  assert.equal(first.artifact, preparation.artifact);
  assert.equal(first.sourceId, `qdrant:lifecycle:${first.artifactId}`);
  assert.equal(first.storageSchemaVersion, 2);
  assert.deepEqual(corpus.calls.getInstitutional, [preparation.recordKey]);
  assert.equal(corpus.calls.insertPoints.length, 2);

  const writesBeforeRetry = corpus.calls.insertPoints.length;
  const second = await provider.persist(structuredClone(request));
  assert.equal(second.status, "verified");
  assert.equal(second.disposition, "unchanged");
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.recordKey, first.recordKey);
  assert.equal(second.nonce, first.nonce);
  assert.equal(corpus.calls.insertPoints.length, writesBeforeRetry);
  assert.deepEqual(corpus.calls.getInstitutional, [preparation.recordKey, preparation.recordKey]);

  const conflict = await provider.persist({
    ...request,
    summary: "Changed summary must not overwrite immutable lifecycle evidence.",
  });
  assert.equal(conflict.status, "blocked");
  assert.equal(conflict.code, "record_conflict");
  assert.equal(corpus.calls.insertPoints.length, writesBeforeRetry);
  assert.equal(corpus.points.size, 2);
});

test("blocks invalid and cancelled persistence before later effects", async () => {
  const corpus = createCorpus();
  const provider = createQdrantLifecycleProvider({ client: corpus.client });
  const incompletePlane = lifecycleRequest();
  delete incompletePlane.identity.planeWorkItem;

  for (const request of [
    null,
    { ...lifecycleRequest(), summary: "" },
    incompletePlane,
  ]) {
    const result = await provider.persist(request);
    assert.equal(result.status, "blocked");
  }
  assert.deepEqual(corpus.calls.getPoints, []);
  assert.equal(corpus.calls.ensureCollection, 0);
  assert.deepEqual(corpus.calls.embedSummary, []);
  assert.deepEqual(corpus.calls.insertPoints, []);

  const preAborted = new AbortController();
  preAborted.abort();
  const preAbortedResult = await provider.persist(lifecycleRequest(), preAborted.signal);
  assert.equal(preAbortedResult.status, "blocked");
  assert.equal(preAbortedResult.code, "aborted");
  assert.deepEqual(corpus.calls.getPoints, []);

  const midOperation = new AbortController();
  const cancelledCorpus = createCorpus({
    onGetPoints: async () => {
      midOperation.abort();
    },
  });
  const cancelled = await createQdrantLifecycleProvider({
    client: cancelledCorpus.client,
    now: () => new Date(createdAt),
  }).persist(lifecycleRequest(), midOperation.signal);
  assert.equal(cancelled.status, "blocked");
  assert.equal(cancelled.code, "aborted");
  assert.equal(cancelledCorpus.calls.getPoints.length, 1);
  assert.equal(cancelledCorpus.calls.ensureCollection, 0);
  assert.deepEqual(cancelledCorpus.calls.insertPoints, []);
});

test("blocks strict lifecycle request projection failures before clocks or client effects", async () => {
  const corpus = createCorpus();
  let clockCalls = 0;
  const provider = createQdrantLifecycleProvider({
    client: corpus.client,
    now: () => {
      clockCalls += 1;
      return new Date(createdAt);
    },
  });

  const sparseSourceRefs = ["plane:ima:SKYNET-211"];
  sparseSourceRefs.length = 2;
  const sparsePriorArtifactIds = ["85e12eff-d162-5262-bbfe-ec0624cb40d9"];
  sparsePriorArtifactIds.length = 2;
  let requestAccessorReads = 0;
  const requestAccessor = lifecycleRequest();
  Object.defineProperty(requestAccessor, "identity", {
    enumerable: true,
    get: () => {
      requestAccessorReads += 1;
      throw new Error("request accessor invoked");
    },
  });
  let identityAccessorReads = 0;
  const identityAccessor = lifecycleRequest();
  Object.defineProperty(identityAccessor.identity, "project", {
    enumerable: true,
    get: () => {
      identityAccessorReads += 1;
      throw new Error("identity accessor invoked");
    },
  });
  let entryAccessorReads = 0;
  const entryAccessor = lifecycleRequest({
    identity: { sourceRefs: [...planeIdentity.sourceRefs] },
  });
  Object.defineProperty(entryAccessor.identity.sourceRefs, "0", {
    enumerable: true,
    get: () => {
      entryAccessorReads += 1;
      throw new Error("array entry accessor invoked");
    },
  });
  const extraArrayEntry = lifecycleRequest({
    identity: { sourceRefs: [...planeIdentity.sourceRefs] },
  });
  extraArrayEntry.identity.sourceRefs.extra = true;
  const symbolArrayEntry = lifecycleRequest({
    identity: { sourceRefs: [...planeIdentity.sourceRefs] },
  });
  symbolArrayEntry.identity.sourceRefs[Symbol("extra")] = true;
  const nonEnumerableArrayEntry = lifecycleRequest({
    identity: { sourceRefs: [...planeIdentity.sourceRefs] },
  });
  Object.defineProperty(nonEnumerableArrayEntry.identity.sourceRefs, "0", {
    value: nonEnumerableArrayEntry.identity.sourceRefs[0],
    enumerable: false,
  });

  const partialPlanePair = lifecycleRequest();
  delete partialPlanePair.identity.planeWorkItem;
  const extraRequest = lifecycleRequest();
  extraRequest.extra = true;
  const extraIdentity = lifecycleRequest({ identity: { extra: true } });
  const symbolRequest = lifecycleRequest();
  symbolRequest[Symbol("extra")] = true;
  const symbolIdentity = lifecycleRequest({ identity: { [Symbol("extra")]: true } });
  const nonEnumerableRequest = lifecycleRequest();
  Object.defineProperty(nonEnumerableRequest, "summary", {
    value: nonEnumerableRequest.summary,
    enumerable: false,
  });
  const nonEnumerableIdentity = lifecycleRequest();
  Object.defineProperty(nonEnumerableIdentity.identity, "project", {
    value: nonEnumerableIdentity.identity.project,
    enumerable: false,
  });
  const inheritedRequest = Object.create({ type: "implementation" });
  Object.assign(inheritedRequest, lifecycleRequest());
  delete inheritedRequest.type;
  const inheritedIdentity = Object.create({ project: "ima-pi" });
  Object.assign(inheritedIdentity, planeIdentity);
  delete inheritedIdentity.project;
  const inheritedIdentityRequest = lifecycleRequest();
  inheritedIdentityRequest.identity = inheritedIdentity;

  for (const [label, request] of [
    ["sparse source references", lifecycleRequest({ identity: { sourceRefs: sparseSourceRefs } })],
    ["sparse prior artifact IDs", lifecycleRequest({ identity: { priorArtifactIds: sparsePriorArtifactIds } })],
    ["request accessor", requestAccessor],
    ["identity accessor", identityAccessor],
    ["array entry accessor", entryAccessor],
    ["extra array entry", extraArrayEntry],
    ["array symbol", symbolArrayEntry],
    ["non-enumerable array entry", nonEnumerableArrayEntry],
    ["partial Plane pair", partialPlanePair],
    ["extra request key", extraRequest],
    ["extra identity key", extraIdentity],
    ["request symbol", symbolRequest],
    ["identity symbol", symbolIdentity],
    ["non-enumerable request field", nonEnumerableRequest],
    ["non-enumerable identity field", nonEnumerableIdentity],
    ["inherited request field", inheritedRequest],
    ["inherited identity field", inheritedIdentityRequest],
  ]) {
    const result = await provider.persist(request);
    assert.equal(result.status, "blocked", label);
    assert.equal(result.code, "invalid_lifecycle_request", label);
  }

  assert.equal(requestAccessorReads, 0);
  assert.equal(identityAccessorReads, 0);
  assert.equal(entryAccessorReads, 0);
  assert.equal(clockCalls, 0);
  assert.deepEqual(corpus.calls, {
    getPoints: [],
    ensureCollection: 0,
    embedSummary: [],
    insertPoints: [],
    getInstitutional: [],
    recallLifecycleInstitutional: [],
  });
});

test("snapshots caller input and reconciles a fresh provider through read-only evidence", async () => {
  const enteredRead = deferred();
  const releaseRead = deferred();
  let paused = false;
  const corpus = createCorpus({
    onGetPoints: async () => {
      if (paused) return undefined;
      paused = true;
      enteredRead.resolve();
      await releaseRead.promise;
      return undefined;
    },
  });
  const request = lifecycleRequest();
  const expected = preparationFor(request);
  const provider = createQdrantLifecycleProvider({
    client: corpus.client,
    now: () => new Date(createdAt),
  });
  const pending = provider.persist(request);
  await enteredRead.promise;
  request.identity.lifecycleKey = "ima-pi:plane:ima:OTHER-1";
  request.identity.sourceRefs.push("plane:ima:OTHER-1");
  request.summary = "Caller mutation after provider entry.";
  request.artifact = "# Changed after provider entry";
  releaseRead.resolve();

  const stored = await pending;
  assert.equal(stored.status, "verified");
  assert.equal(stored.recordKey, expected.recordKey);
  assert.equal(stored.nonce, expected.nonce);
  assert.equal(stored.lifecycleKey, planeIdentity.lifecycleKey);
  assert.equal(stored.summary, "SKYNET-211 Qdrant lifecycle provider implementation is verified.");

  const writesBeforeReconcile = {
    ensureCollection: corpus.calls.ensureCollection,
    insertPoints: corpus.calls.insertPoints.length,
  };
  const readsBeforeReconcile = corpus.calls.getInstitutional.length;
  const freshProvider = createQdrantLifecycleProvider({ client: corpus.client });
  const reconciled = await freshProvider.reconcile(structuredClone(stored.reference));
  assert.equal(reconciled.status, "verified");
  assert.equal(reconciled.disposition, "unchanged");
  assert.equal(reconciled.artifactId, stored.artifactId);
  assert.equal(corpus.calls.ensureCollection, writesBeforeReconcile.ensureCollection);
  assert.equal(corpus.calls.insertPoints.length, writesBeforeReconcile.insertPoints);
  assert.equal(corpus.calls.getInstitutional.length, readsBeforeReconcile + 1);

  const readsBeforeInvalid = corpus.calls.getInstitutional.length;
  const invalid = await freshProvider.reconcile({
    ...stored.reference,
    recordKey: "bad\nreference",
  });
  assert.equal(invalid.status, "blocked");
  assert.equal(invalid.code, "qdrant_reference_invalid");
  assert.equal(corpus.calls.getInstitutional.length, readsBeforeInvalid);
});

test("fails closed on unverified read-back and never falls back or repairs recall evidence", async () => {
  const secret = "token=provider-readback-secret";
  const corruptCorpus = createCorpus({
    onGetInstitutional: ({ result }) => result.success
      ? success({
        ...result.data,
        detail: result.data.detail.replace("outcome=completed", `outcome=blocked ${secret}`),
      })
      : result,
  });
  const corrupt = await createQdrantLifecycleProvider({
    client: corruptCorpus.client,
    now: () => new Date(createdAt),
  }).persist(lifecycleRequest());
  assert.equal(corrupt.status, "blocked");
  assert.equal(corrupt.code, "qdrant_verification_failed");
  assert.ok(corrupt.reference);
  assert.doesNotMatch(JSON.stringify(corrupt), /provider-readback-secret|token=/);
  assert.equal(corruptCorpus.calls.insertPoints.length, 2);

  const unavailableCorpus = createCorpus({
    onGetInstitutional: async () => { throw new Error(secret); },
  });
  const unavailable = await createQdrantLifecycleProvider({
    client: unavailableCorpus.client,
    now: () => new Date(createdAt),
  }).persist(lifecycleRequest());
  assert.equal(unavailable.status, "blocked");
  assert.equal(unavailable.code, "qdrant_unavailable");
  assert.doesNotMatch(JSON.stringify(unavailable), /provider-readback-secret|token=/);
  assert.equal(unavailableCorpus.calls.insertPoints.length, 2);

  const corpus = createCorpus();
  const provider = createQdrantLifecycleProvider({
    client: corpus.client,
    now: () => new Date(createdAt),
  });
  const stored = await provider.persist(lifecycleRequest());
  assert.equal(stored.status, "verified");
  const full = await corpus.client.getInstitutional(stored.recordKey);
  assert.equal(full.success, true);
  const writesBeforeRecall = corpus.calls.insertPoints.length;
  corpus.client.recallLifecycleInstitutional = async (selection) => {
    corpus.calls.recallLifecycleInstitutional.push({ selection: structuredClone(selection) });
    return success([full.data, full.data]);
  };

  const duplicate = await provider.recall({
    lifecycleKey: planeIdentity.lifecycleKey,
    phase: "implementation",
    limit: 2,
  });
  assert.equal(duplicate.status, "blocked");
  assert.equal(duplicate.code, "qdrant_recall_unverifiable");
  assert.deepEqual(corpus.calls.recallLifecycleInstitutional.at(-1).selection, {
    lifecycleKey: planeIdentity.lifecycleKey,
    phase: "implementation",
    limit: 2,
  });
  assert.equal(corpus.calls.insertPoints.length, writesBeforeRecall);

  const invalidSelection = await provider.recall({ lifecycleKey: "", limit: 1 });
  assert.equal(invalidSelection.status, "blocked");
  assert.equal(invalidSelection.code, "qdrant_selection_invalid");
  assert.equal(corpus.calls.insertPoints.length, writesBeforeRecall);
});
