import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveRecordId } from "../lib/qdrant-corpus.ts";
import { prepareLifecycleArtifact, validateLifecycleWriteRequest } from "../lib/ima-lifecycle.ts";
import { createLifecycleProviderPin } from "../lib/ima-lifecycle-pin.ts";
import {
  createLifecycleRouting,
  lifecycleReadSourceIdentityFingerprint,
  routeLifecycleGet,
  routeLifecyclePersistence,
  routePinnedLifecycleGet,
  routePinnedLifecyclePersistence,
  routePinnedLifecycleRecall,
} from "../lib/ima-lifecycle-routing.ts";

const lifecycleKey = "shared-dev-memory:manual:routing-contract:2026-08-31";
const identity = {
  project: "shared-dev-memory",
  lifecycleKey,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  sourceRefs: [`lifecycle:${lifecycleKey}`],
  priorArtifactIds: [],
};

const requestFor = (type = "plan", lifecycleRootMemoryId = "") => {
  const request = validateLifecycleWriteRequest({
    type,
    identity: { ...identity, lifecycleRootMemoryId },
    summary: `${type} routing evidence is exact and independently verifiable.`,
    artifact: `# ${type}\n\nSynthetic routing evidence.`,
  });
  assert.equal(request.valid, true);
  if (!request.valid) throw new Error("fixture request is invalid");
  return request;
};

const recordFor = (request) => {
  const prepared = prepareLifecycleArtifact(request);
  assert.equal(prepared.valid, true);
  if (!prepared.valid) throw new Error("fixture artifact is invalid");
  const derived = deriveRecordId(prepared.data.recordKey);
  assert.equal(derived.success, true);
  if (!derived.success) throw new Error("fixture record ID was not derived");
  const reference = {
    schemaVersion: 1,
    provider: "qdrant",
    artifactId: derived.data,
    recordKey: prepared.data.recordKey,
    contentHash: createHash("sha256").update(prepared.data.artifact, "utf8").digest("hex"),
    lifecycleKey: request.identity.lifecycleKey,
    phase: request.type,
    nonce: prepared.data.nonce,
  };
  return {
    provider: "qdrant",
    artifactId: derived.data,
    recordKey: prepared.data.recordKey,
    lifecycleKey: request.identity.lifecycleKey,
    phase: request.type,
    summary: request.summary,
    artifact: prepared.data.artifact,
    reference,
    createdAt: null,
  };
};

const pinFor = (record) => {
  const pin = createLifecycleProviderPin({
    lifecycleKey: record.lifecycleKey,
    provider: "qdrant",
    initialReference: record.reference,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    pinnedAt: "2026-08-31T12:00:00.000Z",
  });
  assert.ok(pin);
  return pin;
};

test("uses the pinned provider alone for verified persistence and recovery", async () => {
  const initial = recordFor(requestFor("plan"));
  const next = requestFor("implementation", initial.artifactId);
  const calls = { qdrant: [], markdown: [] };
  const routing = createLifecycleRouting([
    {
      provider: "qdrant",
      reconcile: async (reference) => {
        calls.qdrant.push(["reconcile", reference]);
        return { status: "verified", record: initial };
      },
      persist: async (request) => {
        calls.qdrant.push(["persist", request.type]);
        return { status: "verified", record: recordFor(request) };
      },
      recall: async (selection) => {
        calls.qdrant.push(["recall", selection]);
        return { status: "verified", provider: "qdrant", records: [initial] };
      },
    },
    {
      provider: "markdown",
      reconcile: async () => {
        calls.markdown.push("reconcile");
        return { status: "blocked", provider: "markdown", code: "must_not_run", writeState: "no-write" };
      },
      persist: async () => {
        calls.markdown.push("persist");
        return { status: "blocked", provider: "markdown", code: "must_not_run", writeState: "no-write" };
      },
      recall: async () => {
        calls.markdown.push("recall");
        return { status: "blocked", provider: "markdown", code: "must_not_run" };
      },
    },
  ]);
  const pin = pinFor(initial);

  const persisted = await routePinnedLifecyclePersistence({ routing, pin, request: next });
  assert.equal(persisted.status, "verified");
  assert.deepEqual(calls.markdown, []);
  assert.deepEqual(calls.qdrant.map(([operation]) => operation), ["reconcile", "persist"]);

  const recalled = await routePinnedLifecycleRecall({
    routing,
    pin,
    lifecycleKey,
    phase: "plan",
    limit: 1,
  });
  assert.equal(recalled.status, "verified");
  if (recalled.status !== "verified") return;
  assert.equal(recalled.records[0].recordKey, initial.recordKey);
  assert.deepEqual(calls.markdown, []);
  assert.deepEqual(calls.qdrant.map(([operation]) => operation), [
    "reconcile",
    "persist",
    "reconcile",
    "recall",
  ]);
});

test("gates BookStack pinned persistence on a complete verified native lineage", async () => {
  const skynetLifecycleKey = "ima-pi:plane:ima:SKYNET-228";
  const identityForBookStack = (lifecycleRootMemoryId = "", priorArtifactIds = []) => ({
    project: "ima-pi",
    lifecycleKey: skynetLifecycleKey,
    lifecycleRootMemoryId,
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-228",
    sourceRefs: ["plane:ima:SKYNET-228"],
    priorArtifactIds,
  });
  const requestForBookStack = (type, lifecycleRootMemoryId = "", priorArtifactIds = []) => {
    const request = validateLifecycleWriteRequest({
      type,
      identity: identityForBookStack(lifecycleRootMemoryId, priorArtifactIds),
      summary: `${type} BookStack evidence uses one verified lifecycle lineage.`,
      artifact: `# ${type}\n\nPinned BookStack lifecycle evidence.`,
    });
    assert.equal(request.valid, true);
    if (!request.valid) throw new Error("invalid BookStack fixture request");
    return request;
  };
  const recordForBookStack = (request, overrides = {}) => {
    const prepared = prepareLifecycleArtifact(request);
    assert.equal(prepared.valid, true);
    if (!prepared.valid) throw new Error("unprepared BookStack fixture record");
    const artifactId = prepared.data.nonce;
    const recordKey = prepared.data.recordKey;
    const reference = {
      projectSlug: "ima-pi",
      sourceRef: "plane:ima:SKYNET-228",
      lifecycleKey: request.identity.lifecycleKey,
      shelfId: 71,
      shelfSlug: "lifecycle-artifacts",
      bookId: 72,
      bookSlug: "ima-pi",
      chapterId: 73,
      chapterSlug: "skynet-228",
      pageId: 74,
      pageSlug: `${request.type}-${artifactId}`,
      originFingerprint: "a".repeat(64),
      artifactId,
      recordKey,
      contentHash: createHash("sha256").update(prepared.data.artifact, "utf8").digest("hex"),
      pageHash: "b".repeat(64),
      revisionCount: 1,
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    return {
      provider: "bookstack",
      artifactId,
      recordKey,
      lifecycleKey: request.identity.lifecycleKey,
      phase: request.type,
      summary: request.summary,
      artifact: prepared.data.artifact,
      reference,
      createdAt: null,
      ...overrides,
    };
  };
  const initial = recordForBookStack(requestForBookStack("plan"));
  const request = requestForBookStack("implementation", initial.artifactId, [initial.artifactId]);
  const continuation = recordForBookStack(request);
  const pin = createLifecycleProviderPin({
    lifecycleKey: skynetLifecycleKey,
    provider: "bookstack",
    initialReference: initial.reference,
    artifactId: initial.artifactId,
    recordKey: initial.recordKey,
    pinnedAt: "2026-08-31T12:00:00.000Z",
  });
  assert.ok(pin);
  if (!pin) return;

  const routingFor = (reconciled) => {
    const calls = [];
    return {
      calls,
      routing: createLifecycleRouting([{
        provider: "bookstack",
        reconcile: async (reference) => {
          calls.push({ operation: "reconcile", reference: structuredClone(reference) });
          return { status: "verified", record: reconciled };
        },
        persistPinned: async (nextRequest, reference) => {
          calls.push({
            operation: "persistPinned",
            request: structuredClone(nextRequest),
            reference: structuredClone(reference),
          });
          return { status: "verified", record: continuation };
        },
        persist: async () => {
          calls.push({ operation: "persist" });
          return { status: "verified", record: continuation };
        },
        recall: async () => ({ status: "verified", provider: "bookstack", records: [] }),
      }]),
    };
  };

  const valid = routingFor(initial);
  const persisted = await routePinnedLifecyclePersistence({ routing: valid.routing, pin, request });
  assert.equal(persisted.status, "verified");
  assert.deepEqual(valid.calls.map(({ operation }) => operation), ["reconcile", "persistPinned"]);
  assert.deepEqual(valid.calls[0].reference, pin.initialReference);
  assert.deepEqual(valid.calls[1].reference, pin.initialReference);
  assert.deepEqual(valid.calls[1].request, request);

  const invalidResponses = [
    { label: "provider", record: recordFor(requestFor()) },
    { label: "lifecycle key", record: { ...initial, lifecycleKey: "ima-pi:plane:ima:SKYNET-229" } },
    { label: "artifact ID", record: { ...initial, artifactId: continuation.artifactId } },
    { label: "record key", record: { ...initial, recordKey: continuation.recordKey } },
    {
      label: "native reference",
      record: { ...initial, reference: { ...initial.reference, pageHash: "d".repeat(64) } },
    },
  ];
  for (const invalidResponse of invalidResponses) {
    const invalid = routingFor(invalidResponse.record);
    const result = await routePinnedLifecyclePersistence({ routing: invalid.routing, pin, request });
    assert.deepEqual(result, {
      status: "blocked",
      provider: "bookstack",
      code: "pinned_provider_response_invalid",
      writeState: "no-write",
    }, invalidResponse.label);
    assert.deepEqual(invalid.calls.map(({ operation }) => operation), ["reconcile"], invalidResponse.label);
  }

  const malformed = routingFor(initial);
  const invalidPin = {
    ...pin,
    initialReference: { ...pin.initialReference, pageHash: "not-a-valid-hash" },
  };
  assert.deepEqual(await routePinnedLifecyclePersistence({
    routing: malformed.routing,
    pin: invalidPin,
    request,
  }), {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_pin_invalid",
    writeState: "no-write",
  });
  assert.deepEqual(malformed.calls, []);
});

test("blocks invalid pins and failed pinned recovery without fallback writes", async () => {
  const initial = recordFor(requestFor("plan"));
  const next = requestFor("implementation", initial.artifactId);
  let persists = 0;
  const routing = createLifecycleRouting([
    {
      provider: "qdrant",
      reconcile: async () => ({
        status: "blocked",
        provider: "qdrant",
        code: "pinned_reference_missing",
        writeState: "no-write",
      }),
      persist: async () => {
        persists += 1;
        return { status: "verified", record: initial };
      },
      recall: async () => ({ status: "verified", provider: "qdrant", records: [initial] }),
    },
    {
      provider: "markdown",
      persist: async () => {
        persists += 100;
        return { status: "verified", record: initial };
      },
      recall: async () => ({ status: "verified", provider: "markdown", records: [] }),
    },
  ]);
  const pin = pinFor(initial);

  const recovery = await routePinnedLifecyclePersistence({ routing, pin, request: next });
  assert.deepEqual(recovery, {
    status: "blocked",
    provider: "qdrant",
    code: "pinned_reference_missing",
    writeState: "no-write",
  });
  assert.equal(persists, 0);

  const invalid = await routePinnedLifecyclePersistence({
    routing,
    pin: { ...pin, lifecycleKey: "other-lifecycle" },
    request: next,
  });
  assert.deepEqual(invalid, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_pin_invalid",
    writeState: "no-write",
  });
  assert.equal(persists, 0);
});

test("fails closed on unavailable, malformed, and secret-shaped provider boundary outcomes", async () => {
  let markdownWrites = 0;
  const markdownOnly = createLifecycleRouting([
    {
      provider: "markdown",
      persist: async () => {
        markdownWrites += 1;
        return { status: "blocked", provider: "markdown", code: "must_not_run", writeState: "no-write" };
      },
      recall: async () => ({ status: "verified", provider: "markdown", records: [] }),
    },
  ]);
  const unavailable = await routeLifecyclePersistence({
    routing: markdownOnly,
    provider: "qdrant",
    request: requestFor(),
  });
  assert.deepEqual(unavailable, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_provider_unavailable",
    writeState: "no-write",
  });
  assert.equal(markdownWrites, 0);

  const malformed = createLifecycleRouting([
    {
      provider: "qdrant",
      persist: async () => ({ status: "verified", record: { provider: "qdrant" } }),
      recall: async () => ({ status: "verified", provider: "qdrant", records: [] }),
    },
  ]);
  assert.deepEqual(await routeLifecyclePersistence({
    routing: malformed,
    provider: "qdrant",
    request: requestFor(),
  }), {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_provider_response_invalid",
    writeState: "possible-write",
  });

  const injected = createLifecycleRouting([
    {
      provider: "qdrant",
      persist: async (request) => ({
        status: "verified",
        record: { ...recordFor(request), injected: "../../synthetic-provider-boundary" },
      }),
      recall: async () => ({ status: "verified", provider: "qdrant", records: [] }),
    },
  ]);
  assert.deepEqual(await routeLifecyclePersistence({
    routing: injected,
    provider: "qdrant",
    request: requestFor(),
  }), {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_provider_response_invalid",
    writeState: "possible-write",
  });

  const throwing = createLifecycleRouting([
    {
      provider: "qdrant",
      persist: async () => { throw new Error("token=synthetic-secret"); },
      recall: async () => ({ status: "verified", provider: "qdrant", records: [] }),
    },
  ]);
  const failure = await routeLifecyclePersistence({
    routing: throwing,
    provider: "qdrant",
    request: requestFor(),
  });
  assert.equal(failure.status, "blocked");
  assert.equal(failure.code, "lifecycle_provider_operation_failed");
  assert.doesNotMatch(JSON.stringify(failure), /synthetic-secret/);
});

test("routes an exact pinned get through its authority only and fails closed on a mismatched record", async () => {
  const initial = recordFor(requestFor("plan"));
  const target = recordFor(requestFor("implementation", initial.artifactId));
  assert.equal(
    lifecycleReadSourceIdentityFingerprint(initial),
    lifecycleReadSourceIdentityFingerprint(target),
  );
  const pin = pinFor(initial);
  const calls = [];
  const fallbackCalls = [];
  const routing = createLifecycleRouting([
    {
      provider: "qdrant",
      persist: async () => ({
        status: "blocked",
        provider: "qdrant",
        code: "read_only_fixture",
        writeState: "no-write",
      }),
      reconcile: async (reference, signal) => {
        calls.push({ operation: "reconcile", reference: structuredClone(reference), signal });
        return { status: "verified", record: initial };
      },
      get: async (reference, signal) => {
        calls.push({ operation: "get", reference: structuredClone(reference), signal });
        return { status: "verified", record: target };
      },
      recall: async (_selection, signal) => {
        calls.push({ operation: "recall", signal });
        return { status: "verified", provider: "qdrant", records: [initial, target] };
      },
    },
    {
      provider: "markdown",
      persist: async () => { fallbackCalls.push("persist"); throw new Error("fallback must not run"); },
      reconcile: async () => { fallbackCalls.push("reconcile"); throw new Error("fallback must not run"); },
      get: async () => { fallbackCalls.push("get"); throw new Error("fallback must not run"); },
      recall: async () => { fallbackCalls.push("recall"); throw new Error("fallback must not run"); },
    },
  ]);
  const controller = new AbortController();
  const recalled = await routePinnedLifecycleRecall({
    routing,
    pin,
    lifecycleKey,
    limit: 2,
    signal: controller.signal,
  });
  assert.equal(recalled.status, "verified");
  assert.deepEqual(recalled.status === "verified"
    ? recalled.records.map(({ artifactId }) => artifactId)
    : [], [initial.artifactId, target.artifactId]);

  const result = await routePinnedLifecycleGet({
    routing,
    pin,
    reference: target.reference,
    signal: controller.signal,
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(calls.map(({ operation }) => operation), ["reconcile", "recall", "reconcile", "get"]);
  assert.deepEqual(calls[0].reference, initial.reference);
  assert.deepEqual(calls[2].reference, initial.reference);
  assert.deepEqual(calls[3].reference, target.reference);
  assert.equal(calls.every(({ signal }) => signal === controller.signal), true);
  assert.deepEqual(fallbackCalls, []);

  const mismatched = createLifecycleRouting([{
    provider: "qdrant",
    persist: async () => ({
      status: "blocked",
      provider: "qdrant",
      code: "read_only_fixture",
      writeState: "no-write",
    }),
    reconcile: async () => ({ status: "verified", record: initial }),
    get: async () => ({
      status: "verified",
      record: {
        ...target,
        reference: { ...target.reference, nonce: initial.reference.nonce },
      },
    }),
    recall: async () => ({ status: "verified", provider: "qdrant", records: [] }),
  }]);
  const blocked = await routePinnedLifecycleGet({
    routing: mismatched,
    pin,
    reference: target.reference,
  });
  assert.deepEqual(blocked, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_provider_response_invalid",
    writeState: "no-write",
  });

  const malformed = await routeLifecycleGet({
    routing,
    provider: "qdrant",
    reference: { ...target.reference, injected: "token=synthetic-secret" },
  });
  assert.deepEqual(malformed, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_get_request_invalid",
    writeState: "no-write",
  });
  assert.doesNotMatch(JSON.stringify(malformed), /synthetic-secret/);
  assert.deepEqual(fallbackCalls, []);
});

test("pinned reads reject conflicting lifecycle roots without fallback writes", async () => {
  const initial = recordFor(requestFor("plan"));
  const pin = pinFor(initial);
  const wrongRoot = recordFor(requestFor(
    "implementation",
    "00000000-0000-5000-8000-000000000230",
  ));
  let writes = 0;
  const calls = [];
  const fallbackCalls = [];
  const routing = createLifecycleRouting([
    {
      provider: "qdrant",
      persist: async () => {
        writes += 1;
        throw new Error("pinned reads must not persist");
      },
      reconcile: async (reference) => {
        calls.push({ operation: "reconcile", reference: structuredClone(reference) });
        return { status: "verified", record: initial };
      },
      get: async (reference) => {
        calls.push({ operation: "get", reference: structuredClone(reference) });
        return { status: "verified", record: wrongRoot };
      },
      recall: async () => {
        calls.push({ operation: "recall" });
        return { status: "verified", provider: "qdrant", records: [initial, wrongRoot] };
      },
    },
    {
      provider: "markdown",
      persist: async () => { fallbackCalls.push("persist"); throw new Error("fallback must not run"); },
      reconcile: async () => { fallbackCalls.push("reconcile"); throw new Error("fallback must not run"); },
      get: async () => { fallbackCalls.push("get"); throw new Error("fallback must not run"); },
      recall: async () => { fallbackCalls.push("recall"); throw new Error("fallback must not run"); },
    },
  ]);

  const recalled = await routePinnedLifecycleRecall({
    routing,
    pin,
    lifecycleKey,
    limit: 2,
  });
  assert.deepEqual(recalled, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_read_authority_invalid",
  });

  const direct = await routePinnedLifecycleGet({
    routing,
    pin,
    reference: wrongRoot.reference,
  });
  assert.deepEqual(direct, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_read_authority_invalid",
    writeState: "no-write",
  });
  assert.deepEqual(calls.map(({ operation }) => operation), ["reconcile", "recall", "reconcile", "get"]);
  assert.equal(writes, 0);
  assert.deepEqual(fallbackCalls, []);
});

test("derives a rooted later pin and admits its original plan, decision, and closeout lineage", async () => {
  const original = recordFor(requestFor("plan"));
  const laterPlan = recordFor(requestFor("plan", original.artifactId));
  const decision = recordFor(requestFor("decision", original.artifactId));
  const closeout = recordFor(requestFor("closeout", original.artifactId));
  const pin = pinFor(laterPlan);
  const calls = [];
  const routing = createLifecycleRouting([{
    provider: "qdrant",
    reconcile: async (reference) => {
      calls.push({ operation: "reconcile", reference: structuredClone(reference) });
      return { status: "verified", record: laterPlan };
    },
    get: async (reference) => {
      calls.push({ operation: "get", reference: structuredClone(reference) });
      return {
        status: "verified",
        record: reference.artifactId === original.artifactId ? original : laterPlan,
      };
    },
    recall: async () => {
      calls.push({ operation: "recall" });
      return { status: "verified", provider: "qdrant", records: [original, laterPlan, decision, closeout] };
    },
    persist: async (request) => {
      calls.push({ operation: "persist", request: structuredClone(request) });
      return { status: "verified", record: recordFor(request) };
    },
  }]);

  const recalled = await routePinnedLifecycleRecall({ routing, pin, lifecycleKey, limit: 4 });
  assert.equal(recalled.status, "verified");
  assert.deepEqual(
    recalled.status === "verified" ? recalled.records.map(({ artifactId }) => artifactId) : [],
    [original.artifactId, laterPlan.artifactId, decision.artifactId, closeout.artifactId],
  );
  const originalRead = await routePinnedLifecycleGet({
    routing,
    pin,
    reference: original.reference,
  });
  assert.equal(originalRead.status, "verified");
  assert.equal(originalRead.status === "verified" ? originalRead.record.artifactId : null, original.artifactId);

  const invalid = await routePinnedLifecyclePersistence({
    routing,
    pin,
    request: requestFor("implementation", "00000000-0000-5000-8000-000000000231"),
  });
  assert.deepEqual(invalid, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_lineage_conflict",
    writeState: "no-write",
  });
  assert.equal(calls.filter(({ operation }) => operation === "persist").length, 0);
  const sourceMismatch = validateLifecycleWriteRequest({
    type: "implementation",
    identity: {
      ...identity,
      lifecycleRootMemoryId: original.artifactId,
      sourceRefs: ["lifecycle:other"],
    },
    summary: "Implementation source identity must match the verified pinned lineage.",
    artifact: "# Implementation\n\nMismatched source identity.",
  });
  assert.equal(sourceMismatch.valid, true);
  if (!sourceMismatch.valid) return;
  assert.deepEqual(await routePinnedLifecyclePersistence({
    routing,
    pin,
    request: sourceMismatch,
  }), {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_lineage_conflict",
    writeState: "no-write",
  });
  assert.equal(calls.filter(({ operation }) => operation === "persist").length, 0);

  const persisted = await routePinnedLifecyclePersistence({
    routing,
    pin,
    request: requestFor("implementation", original.artifactId),
  });
  assert.equal(persisted.status, "verified");
  assert.equal(calls.filter(({ operation }) => operation === "persist").length, 1);
});

test("retains possible-write semantics when a pinned provider returns unverifiable continuation evidence", async () => {
  const initial = recordFor(requestFor("plan"));
  const pin = pinFor(initial);
  const request = requestFor("implementation", initial.artifactId);
  const conflicting = recordFor(requestFor(
    "implementation",
    "00000000-0000-5000-8000-000000000233",
  ));
  const calls = [];
  const routing = createLifecycleRouting([{
    provider: "qdrant",
    reconcile: async () => {
      calls.push("reconcile");
      return { status: "verified", record: initial };
    },
    persist: async () => {
      calls.push("persist");
      return { status: "verified", record: conflicting };
    },
    recall: async () => ({ status: "verified", provider: "qdrant", records: [] }),
  }]);
  assert.deepEqual(await routePinnedLifecyclePersistence({ routing, pin, request }), {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_provider_response_invalid",
    writeState: "possible-write",
  });
  assert.deepEqual(calls, ["reconcile", "persist"]);
});

test("derives an explicit root from a rooted non-plan pin", async () => {
  const original = recordFor(requestFor("plan"));
  const pinnedDecision = recordFor(requestFor("decision", original.artifactId));
  const closeout = recordFor(requestFor("closeout", original.artifactId));
  const pin = pinFor(pinnedDecision);
  const calls = [];
  const routing = createLifecycleRouting([{
    provider: "qdrant",
    reconcile: async () => {
      calls.push("reconcile");
      return { status: "verified", record: pinnedDecision };
    },
    recall: async () => {
      calls.push("recall");
      return { status: "verified", provider: "qdrant", records: [original, pinnedDecision, closeout] };
    },
    persist: async (request) => {
      calls.push("persist");
      return { status: "verified", record: recordFor(request) };
    },
  }]);
  const recalled = await routePinnedLifecycleRecall({ routing, pin, lifecycleKey, limit: 3 });
  assert.equal(recalled.status, "verified");
  assert.deepEqual(
    recalled.status === "verified" ? recalled.records.map(({ artifactId }) => artifactId) : [],
    [original.artifactId, pinnedDecision.artifactId, closeout.artifactId],
  );
  assert.deepEqual(calls, ["reconcile", "recall"]);
  const persisted = await routePinnedLifecyclePersistence({
    routing,
    pin,
    request: requestFor("implementation", original.artifactId),
  });
  assert.equal(persisted.status, "verified");
  assert.deepEqual(calls, ["reconcile", "recall", "reconcile", "persist"]);
});

test("blocks existing rootless non-plan pins before recall or continuation persistence", async () => {
  const rootlessDecision = recordFor(requestFor("decision"));
  const pin = pinFor(rootlessDecision);
  const calls = [];
  const routing = createLifecycleRouting([{
    provider: "qdrant",
    reconcile: async () => {
      calls.push("reconcile");
      return { status: "verified", record: rootlessDecision };
    },
    recall: async () => { calls.push("recall"); return { status: "verified", provider: "qdrant", records: [] }; },
    persist: async () => { calls.push("persist"); return { status: "verified", record: rootlessDecision }; },
  }]);

  const recalled = await routePinnedLifecycleRecall({ routing, pin, lifecycleKey, limit: 1 });
  assert.deepEqual(recalled, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_read_authority_invalid",
  });
  const persisted = await routePinnedLifecyclePersistence({
    routing,
    pin,
    request: requestFor("closeout", "00000000-0000-5000-8000-000000000232"),
  });
  assert.deepEqual(persisted, {
    status: "blocked",
    provider: "qdrant",
    code: "lifecycle_lineage_unresolved",
    writeState: "no-write",
  });
  assert.deepEqual(calls, ["reconcile", "reconcile"]);
});
