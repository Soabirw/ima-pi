import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareLifecycleArtifact,
  validateLifecycleWriteRequest,
} from "../lib/ima-lifecycle.ts";
import { createSerenaLifecycleProvider } from "../lib/serena-lifecycle.ts";
import {
  createSerenaLifecycleProject,
  createSerenaLifecycleRecord,
  serenaLifecycleMemoryName,
} from "../lib/serena-lifecycle-record.ts";

const createdAt = "2026-10-15T12:00:00.000Z";
const lifecycleKey = "synthetic-project:plane:ima:TEST-1500";
const project = (() => {
  const value = createSerenaLifecycleProject({
    projectName: "synthetic-serena-project",
    projectPath: "/workspace/synthetic-serena-project",
  });
  assert.ok(value);
  return value;
})();

const success = (data) => ({ success: true, data });
const failure = (code) => ({ success: false, code });
const settledWrite = () => ({
  success: true,
  data: undefined,
  dispatch: "dispatched",
  settlement: "settled",
});
const preDispatchWriteFailure = (code = "serena_memory_write_unknown") => ({
  success: false,
  code,
  dispatch: "not_dispatched",
  settlement: "not_dispatched",
});
const dispatchedUnknown = (code = "serena_memory_write_unknown") => ({
  success: false,
  code,
  dispatch: "dispatched",
  settlement: "unknown",
});
const identity = () => ({
  project: "synthetic-project",
  lifecycleKey,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  planeWorkspace: "ima",
  planeWorkItem: "TEST-1500",
  sourceRefs: ["plane:ima:TEST-1500"],
  priorArtifactIds: ["synthetic-plan-reference"],
});
const requestFor = (overrides = {}) => ({
  type: "plan",
  identity: identity(),
  summary: "Synthetic Serena lifecycle provider evidence is exact and independently verifiable.",
  artifact: "# Synthetic plan\n\nThis fixture is not production Serena lifecycle content.",
  ...overrides,
});

const expectedPreparation = (request) => {
  const valid = validateLifecycleWriteRequest(request);
  assert.equal(valid.valid, true);
  const preparation = prepareLifecycleArtifact(valid);
  assert.equal(preparation.valid, true);
  return preparation.data;
};

const createClient = (options = {}) => {
  const memories = new Map(Object.entries(options.memories ?? {}));
  const calls = [];
  const client = {
    activate: async (value, signal) => {
      calls.push({ operation: "activate", project: structuredClone(value) });
      if (options.onActivate) return options.onActivate({ value, signal, calls, memories });
      return success(structuredClone(project));
    },
    listMemoryNames: async (signal) => {
      calls.push({ operation: "list" });
      if (options.onList) return options.onList({ signal, calls, memories });
      return success([...memories.keys()]);
    },
    readMemory: async (memoryName, signal) => {
      calls.push({ operation: "read", memoryName });
      if (options.onRead) return options.onRead({ memoryName, signal, calls, memories });
      return memories.has(memoryName)
        ? success(memories.get(memoryName))
        : failure("serena_memory_read_unavailable");
    },
    writeMemory: async ({ memoryName, content }, signal) => {
      calls.push({ operation: "write", memoryName });
      if (options.onWrite) return options.onWrite({ memoryName, content, signal, calls, memories });
      memories.set(memoryName, content);
      return settledWrite();
    },
  };
  return { client, calls, memories };
};

const createLease = (options = {}) => {
  let acquisitions = 0;
  let releases = 0;
  const acquireLease = async (value) => {
    acquisitions += 1;
    if (options.acquire) return options.acquire(value);
    return {
      release: async () => {
        releases += 1;
        if (options.release) return options.release();
      },
    };
  };
  return {
    acquireLease,
    acquisitions: () => acquisitions,
    releases: () => releases,
  };
};

const createProvider = ({ client, lease, now = () => new Date(createdAt), providerProject = project }) =>
  createSerenaLifecycleProvider({
    client,
    project: providerProject,
    now,
    acquireLease: lease.acquireLease,
  });

test("persists once after proven absence, exact direct read-back, and keeps identical retries immutable", async () => {
  const fake = createClient({ memories: { core: "ordinary memory", preferences: "ordinary preference" } });
  const lease = createLease();
  const provider = createProvider({ client: fake.client, lease });
  const request = requestFor();
  const expected = expectedPreparation(request);

  const first = await provider.persist(request);
  assert.equal(first.status, "verified");
  assert.equal(first.disposition, "stored");
  assert.equal(first.recordKey, expected.recordKey);
  assert.equal(first.nonce, expected.nonce);
  assert.equal(first.sourceId, `serena:lifecycle:${first.memoryName}`);
  assert.equal(first.memoryName, serenaLifecycleMemoryName({
    lifecycleKey,
    phase: "plan",
    artifactId: expected.nonce,
  }));
  assert.deepEqual(fake.calls.map(({ operation }) => operation), ["activate", "list", "write", "read"]);
  assert.equal(fake.memories.get("core"), "ordinary memory");
  assert.equal(fake.memories.get("preferences"), "ordinary preference");
  assert.equal(lease.acquisitions(), 1);
  assert.equal(lease.releases(), 1);

  const writesBeforeRetry = fake.calls.filter(({ operation }) => operation === "write").length;
  const second = await provider.persist(structuredClone(request));
  assert.equal(second.status, "verified");
  assert.equal(second.disposition, "unchanged");
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.reference.memoryName, first.reference.memoryName);
  assert.equal(fake.calls.filter(({ operation }) => operation === "write").length, writesBeforeRetry);
  assert.deepEqual(fake.calls.slice(4).map(({ operation }) => operation), ["activate", "list", "read"]);

  const conflict = await provider.persist({
    ...request,
    summary: "A changed summary must not overwrite immutable lifecycle evidence.",
  });
  assert.equal(conflict.status, "blocked");
  assert.equal(conflict.code, "serena_target_conflict");
  assert.equal(fake.calls.filter(({ operation }) => operation === "write").length, writesBeforeRetry);
  assert.equal(fake.memories.size, 3);
});

test("rejects malformed and hostile persistence input before clock, lease, or client effects", async () => {
  const fake = createClient();
  const lease = createLease();
  let clockCalls = 0;
  const provider = createProvider({
    client: fake.client,
    lease,
    now: () => {
      clockCalls += 1;
      return new Date(createdAt);
    },
  });

  const partialPlane = requestFor();
  delete partialPlane.identity.planeWorkItem;
  let accessorReads = 0;
  const accessor = requestFor();
  Object.defineProperty(accessor, "identity", {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      throw new Error("hostile lifecycle request accessor");
    },
  });

  for (const [value, code] of [
    [null, "invalid_lifecycle_request"],
    [{ ...requestFor(), summary: "" }, "invalid_lifecycle_summary"],
    [partialPlane, "invalid_lifecycle_request"],
    [accessor, "invalid_lifecycle_request"],
  ]) {
    const result = await provider.persist(value);
    assert.equal(result.status, "blocked");
    assert.equal(result.code, code);
  }
  assert.equal(accessorReads, 0);
  assert.equal(clockCalls, 0);
  assert.equal(lease.acquisitions(), 0);
  assert.deepEqual(fake.calls, []);
});

test("snapshots a valid request before await boundaries and returns its original proof after caller mutation", async () => {
  let activateStarted;
  let releaseActivation;
  const activationStarted = new Promise((resolve) => { activateStarted = resolve; });
  const activationReleased = new Promise((resolve) => { releaseActivation = resolve; });
  const fake = createClient({
    onActivate: async () => {
      activateStarted();
      await activationReleased;
      return success(structuredClone(project));
    },
  });
  const lease = createLease();
  const provider = createProvider({ client: fake.client, lease });
  const mutable = requestFor();
  const expected = expectedPreparation(mutable);

  const pending = provider.persist(mutable);
  await activationStarted;
  mutable.identity.lifecycleKey = "synthetic-project:plane:ima:OTHER-1500";
  mutable.identity.sourceRefs.push("plane:ima:OTHER-1500");
  mutable.summary = "Caller mutation after provider entry.";
  mutable.artifact = "# Changed after provider entry";
  releaseActivation();

  const stored = await pending;
  assert.equal(stored.status, "verified");
  assert.equal(stored.recordKey, expected.recordKey);
  assert.equal(stored.lifecycleKey, lifecycleKey);
  assert.equal(stored.summary, "Synthetic Serena lifecycle provider evidence is exact and independently verifiable.");
  assert.deepEqual(stored.identity.sourceRefs, ["plane:ima:TEST-1500"]);
});

test("blocks pre- and mid-I/O cancellation without later client operations and releases an acquired lease", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const before = createClient();
  const beforeLease = createLease();
  const preResult = await createProvider({ client: before.client, lease: beforeLease })
    .persist(requestFor(), preAborted.signal);
  assert.equal(preResult.status, "blocked");
  assert.equal(preResult.code, "aborted");
  assert.equal(beforeLease.acquisitions(), 0);
  assert.deepEqual(before.calls, []);

  const during = new AbortController();
  const fake = createClient({
    onActivate: () => {
      during.abort();
      return success(structuredClone(project));
    },
  });
  const lease = createLease();
  const result = await createProvider({ client: fake.client, lease })
    .persist(requestFor(), during.signal);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "aborted");
  assert.deepEqual(fake.calls.map(({ operation }) => operation), ["activate"]);
  assert.equal(lease.acquisitions(), 1);
  assert.equal(lease.releases(), 1);
});

test("blocks mismatched or unavailable project evidence before listing or writing", async () => {
  const alternate = createSerenaLifecycleProject({
    projectName: "different-project",
    projectPath: "/workspace/different-project",
  });
  assert.ok(alternate);

  const mismatched = createClient({ onActivate: () => success(alternate) });
  const mismatchLease = createLease();
  const mismatch = await createProvider({ client: mismatched.client, lease: mismatchLease })
    .persist(requestFor());
  assert.equal(mismatch.status, "blocked");
  assert.equal(mismatch.code, "serena_project_mismatch");
  assert.deepEqual(mismatched.calls.map(({ operation }) => operation), ["activate"]);

  const unavailable = createClient({
    onActivate: () => failure("serena_project_unavailable"),
  });
  const unavailableLease = createLease();
  const unavailableResult = await createProvider({ client: unavailable.client, lease: unavailableLease })
    .persist(requestFor());
  assert.equal(unavailableResult.status, "blocked");
  assert.equal(unavailableResult.code, "serena_project_unavailable");
  assert.deepEqual(unavailable.calls.map(({ operation }) => operation), ["activate"]);

  const badProject = createClient();
  const badLease = createLease();
  const invalidProjectResult = await createProvider({
    client: badProject.client,
    lease: badLease,
    providerProject: { projectName: "bad", projectPath: "relative" },
  }).persist(requestFor());
  assert.equal(invalidProjectResult.status, "blocked");
  assert.equal(invalidProjectResult.code, "serena_project_mismatch");
  assert.equal(badLease.acquisitions(), 0);
  assert.deepEqual(badProject.calls, []);
});

test("blocks target conflict or unverifiable target without overwrite, fallback, or repair write", async () => {
  const request = requestFor();
  const preparation = expectedPreparation(request);
  const target = serenaLifecycleMemoryName({
    lifecycleKey,
    phase: "plan",
    artifactId: preparation.nonce,
  });
  assert.ok(target);
  const fake = createClient({ memories: { [target]: "not a Serena lifecycle record" } });
  const lease = createLease();
  const result = await createProvider({ client: fake.client, lease }).persist(request);

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "serena_target_unverifiable");
  assert.deepEqual(fake.calls.map(({ operation }) => operation), ["activate", "list", "read"]);
  assert.equal(fake.calls.filter(({ operation }) => operation === "write").length, 0);
  assert.equal(fake.memories.get(target), "not a Serena lifecycle record");
});

test("blocks an unknown write outcome without automatic retry or secret leakage", async () => {
  const fake = createClient({
    onWrite: () => { throw new Error("token=synthetic-write-secret"); },
  });
  const lease = createLease();
  const result = await createProvider({ client: fake.client, lease }).persist(requestFor());

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "serena_memory_write_unknown");
  assert.ok(result.reference);
  assert.deepEqual(fake.calls.map(({ operation }) => operation), ["activate", "list", "write"]);
  assert.equal(fake.calls.filter(({ operation }) => operation === "write").length, 1);
  assert.equal(lease.releases(), 0);
  assert.doesNotMatch(JSON.stringify(result), /secret|token=/i);
});

test("requires exact read-back after its sole write and never repairs unverifiable evidence", async () => {
  const fake = createClient({
    onRead: ({ calls }) => calls.some(({ operation }) => operation === "write")
      ? success("tampered direct read-back token=synthetic-readback-secret")
      : failure("serena_memory_read_unavailable"),
  });
  const lease = createLease();
  const result = await createProvider({ client: fake.client, lease }).persist(requestFor());

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "serena_verification_failed");
  assert.ok(result.reference);
  assert.deepEqual(fake.calls.map(({ operation }) => operation), ["activate", "list", "write", "read"]);
  assert.equal(fake.calls.filter(({ operation }) => operation === "write").length, 1);
  assert.equal(lease.releases(), 1);
  assert.doesNotMatch(JSON.stringify(result), /secret|token=/i);
});

test("returns bounded lease acquisition and release failures without exposing injected error text", async () => {
  const nullClient = createClient();
  const nullLease = createLease({ acquire: async () => null });
  const unavailableFromNull = await createProvider({
    client: nullClient.client,
    lease: nullLease,
  }).persist(requestFor());
  assert.equal(unavailableFromNull.status, "blocked");
  assert.equal(unavailableFromNull.code, "serena_lease_unavailable");
  assert.deepEqual(nullClient.calls, []);

  const unavailableClient = createClient();
  const unavailableLease = createLease({ acquire: async () => { throw new Error("token=lease-acquire-secret"); } });
  const unavailable = await createProvider({
    client: unavailableClient.client,
    lease: unavailableLease,
  }).persist(requestFor());
  assert.equal(unavailable.status, "blocked");
  assert.equal(unavailable.code, "serena_lease_unavailable");
  assert.deepEqual(unavailableClient.calls, []);
  assert.doesNotMatch(JSON.stringify(unavailable), /secret|token=/i);

  const releaseClient = createClient();
  const releaseLease = createLease({ release: async () => { throw new Error("token=lease-release-secret"); } });
  const release = await createProvider({ client: releaseClient.client, lease: releaseLease })
    .persist(requestFor());
  assert.equal(release.status, "blocked");
  assert.equal(release.code, "serena_lease_release_failed");
  assert.ok(release.reference);
  assert.equal(releaseLease.acquisitions(), 1);
  assert.equal(releaseLease.releases(), 1);
  assert.equal(releaseClient.calls.filter(({ operation }) => operation === "write").length, 1);
  assert.doesNotMatch(JSON.stringify(release), /secret|token=/i);
});

test("REVIEW-003 releases proven pre-dispatch failures but retains an uncertain shared exclusion", async () => {
  const preDispatchClient = createClient({
    onWrite: () => preDispatchWriteFailure(),
  });
  const preDispatchLease = createLease();
  const preDispatchProvider = createProvider({
    client: preDispatchClient.client,
    lease: preDispatchLease,
  });
  const preDispatch = await preDispatchProvider.persist(requestFor());
  assert.equal(preDispatch.status, "blocked");
  assert.equal(preDispatch.code, "serena_memory_write_unknown");
  assert.ok(preDispatch.reference);
  assert.equal(preDispatchLease.releases(), 1);
  assert.deepEqual(preDispatchClient.calls.map(({ operation }) => operation), [
    "activate",
    "list",
    "write",
  ]);

  const uncertainClient = createClient({
    onWrite: ({ memoryName, content, memories }) => {
      memories.set(memoryName, content);
      return dispatchedUnknown();
    },
  });
  const uncertainLease = createLease();
  const uncertainProvider = createProvider({
    client: uncertainClient.client,
    lease: uncertainLease,
  });
  const uncertain = await uncertainProvider.persist(requestFor());
  assert.equal(uncertain.status, "blocked");
  assert.equal(uncertain.code, "serena_memory_write_unknown");
  assert.ok(uncertain.reference);
  assert.equal(uncertainLease.acquisitions(), 1);
  assert.equal(uncertainLease.releases(), 0);
  assert.equal(uncertainClient.calls.filter(({ operation }) => operation === "write").length, 1);

  const recovered = await uncertainProvider.get(structuredClone(uncertain.reference));
  const reconciled = await uncertainProvider.reconcile(structuredClone(uncertain.reference));
  assert.equal(recovered.status, "verified");
  assert.equal(recovered.disposition, "unchanged");
  assert.equal(reconciled.status, "verified");
  assert.equal(reconciled.disposition, "unchanged");
  assert.equal(uncertainClient.calls.filter(({ operation }) => operation === "write").length, 1);
  assert.equal(uncertainLease.releases(), 0);
});

test("REVIEW-003 retains the lease and exact recovery reference for cancellation after an unsettled dispatch", async () => {
  const controller = new AbortController();
  const fake = createClient({
    onWrite: ({ memoryName, content, memories }) => {
      memories.set(memoryName, content);
      controller.abort();
      return dispatchedUnknown("aborted");
    },
  });
  const lease = createLease();
  const result = await createProvider({ client: fake.client, lease })
    .persist(requestFor(), controller.signal);

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "aborted");
  assert.ok(result.reference);
  assert.equal(lease.acquisitions(), 1);
  assert.equal(lease.releases(), 0);
  assert.equal(fake.calls.filter(({ operation }) => operation === "write").length, 1);
});

test("REVIEW-003 releases a known-settled write cancelled after dispatch without read-back", async () => {
  const controller = new AbortController();
  const fake = createClient({
    onWrite: ({ memoryName, content, memories }) => {
      memories.set(memoryName, content);
      controller.abort();
      return settledWrite();
    },
  });
  const lease = createLease();
  const result = await createProvider({ client: fake.client, lease })
    .persist(requestFor(), controller.signal);

  assert.equal(result.status, "blocked");
  assert.equal(result.code, "aborted");
  assert.ok(result.reference);
  assert.equal(lease.acquisitions(), 1);
  assert.equal(lease.releases(), 1);
  assert.deepEqual(fake.calls.map(({ operation }) => operation), ["activate", "list", "write"]);
});

test("REVIEW-004 returns aborted after a deferred successful release for stored and unchanged results", async () => {
  for (const disposition of ["stored", "unchanged"]) {
    const request = requestFor();
    const existing = disposition === "unchanged"
      ? createSerenaLifecycleRecord({ request, project, createdAt })
      : null;
    if (disposition === "unchanged") assert.ok(existing);
    const fake = createClient({
      memories: existing ? { [existing.memoryName]: existing.serialized } : {},
    });
    const controller = new AbortController();
    let releaseStarted;
    let finishRelease;
    const releaseStartedPromise = new Promise((resolve) => { releaseStarted = resolve; });
    const releaseFinished = new Promise((resolve) => { finishRelease = resolve; });
    let releases = 0;
    const lease = {
      acquireLease: async () => ({
        release: async () => {
          releases += 1;
          releaseStarted();
          await releaseFinished;
        },
      }),
    };
    const pending = createProvider({ client: fake.client, lease })
      .persist(request, controller.signal);

    await releaseStartedPromise;
    controller.abort();
    finishRelease();
    const result = await pending;
    assert.equal(result.status, "blocked", disposition);
    assert.equal(result.code, "aborted", disposition);
    assert.ok(result.reference, disposition);
    assert.equal(releases, 1, disposition);
    assert.equal(
      fake.calls.filter(({ operation }) => operation === "write").length,
      disposition === "stored" ? 1 : 0,
      disposition,
    );
  }
});

test("REVIEW-004 gives deferred release failure precedence over cancellation", async () => {
  const fake = createClient();
  const controller = new AbortController();
  let releaseStarted;
  let finishRelease;
  const releaseStartedPromise = new Promise((resolve) => { releaseStarted = resolve; });
  const releaseFinished = new Promise((resolve) => { finishRelease = resolve; });
  const lease = {
    acquireLease: async () => ({
      release: async () => {
        releaseStarted();
        await releaseFinished;
        throw new Error("token=deferred-release-secret");
      },
    }),
  };
  const pending = createProvider({ client: fake.client, lease })
    .persist(requestFor(), controller.signal);

  await releaseStartedPromise;
  controller.abort();
  finishRelease();
  const result = await pending;
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "serena_lease_release_failed");
  assert.ok(result.reference);
  assert.equal(fake.calls.filter(({ operation }) => operation === "write").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret|token=/i);
});
