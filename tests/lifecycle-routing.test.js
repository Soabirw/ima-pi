import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveRecordId } from "../lib/qdrant-corpus.ts";
import { prepareLifecycleArtifact, validateLifecycleWriteRequest } from "../lib/ima-lifecycle.ts";
import { createLifecycleProviderPin } from "../lib/ima-lifecycle-pin.ts";
import {
  createLifecycleRouting,
  routeLifecyclePersistence,
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

const requestFor = (type = "plan") => {
  const request = validateLifecycleWriteRequest({
    type,
    identity,
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
  const next = requestFor("implementation");
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

test("blocks invalid pins and failed pinned recovery without fallback writes", async () => {
  const initial = recordFor(requestFor("plan"));
  const next = requestFor("implementation");
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
