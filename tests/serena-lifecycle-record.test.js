import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SERENA_LIFECYCLE_MEMORY_BYTES,
  MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS,
  createSerenaLifecycleProject,
  createSerenaLifecycleRecord,
  isSerenaLifecycleMemoryName,
  normalizeSerenaLifecycleProject,
  projectSerenaLifecycleReference,
  projectSerenaLifecycleRequest,
  projectSerenaLifecycleSelection,
  serenaLifecycleMemoryName,
  serenaLifecycleNamespacePrefix,
  verifySerenaLifecycleRecord,
} from "../lib/serena-lifecycle-record.ts";

const createdAt = "2026-10-15T12:00:00.000Z";
const lifecycleKey = "synthetic-project:plane:ima:TEST-1500";
const projectInput = () => ({
  projectName: "synthetic-serena-project",
  projectPath: "/workspace/synthetic-serena-project",
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
  summary: "Synthetic Serena lifecycle evidence is exact and independently verifiable.",
  artifact: "# Synthetic plan\n\nThis fixture is not production Serena lifecycle content.",
  ...overrides,
});

const project = () => {
  const value = createSerenaLifecycleProject(projectInput());
  assert.ok(value);
  return value;
};

const recordFor = (overrides = {}) => {
  const request = requestFor(overrides.request);
  const record = createSerenaLifecycleRecord({
    request,
    project: overrides.project ?? projectInput(),
    createdAt: overrides.createdAt ?? createdAt,
  });
  assert.ok(record);
  return { request, record };
};

test("constructs a closed Serena record and round-trips exact project, request, and reference proof", () => {
  const { request, record } = recordFor();
  const expectedProject = project();

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.provider, "serena");
  assert.equal(record.project.fingerprint, expectedProject.fingerprint);
  assert.equal(record.artifactId, record.nonce);
  assert.equal(record.memoryName, serenaLifecycleMemoryName({
    lifecycleKey,
    phase: "plan",
    artifactId: record.artifactId,
  }));
  assert.equal(isSerenaLifecycleMemoryName(record.memoryName), true);
  assert.equal(isSerenaLifecycleMemoryName("core"), false);
  assert.equal(isSerenaLifecycleMemoryName("preferences"), false);
  assert.match(record.memoryName, /^ima-serena-lifecycle-v1-[a-f0-9]{64}-plan-/);
  assert.match(record.serialized, /^\{"schemaVersion":1,"provider":"serena"/);

  const verified = verifySerenaLifecycleRecord({
    content: record.serialized,
    project: expectedProject,
    selection: { lifecycleKey, phase: "plan", limit: 1 },
    reference: structuredClone(record.reference),
    request: structuredClone(request),
  });
  assert.ok(verified);
  assert.equal(verified.serialized, record.serialized);
  assert.equal(verified.recordKey, record.recordKey);
  assert.equal(verified.request.valid, true);
  assert.deepEqual(verified.request.identity, identity());
  assert.deepEqual(verified.reference, record.reference);

  verified.identity.sourceRefs.push("caller-mutation");
  verified.request.identity.priorArtifactIds.push("caller-mutation");
  verified.reference.recordKey = "caller-mutation";
  const reread = verifySerenaLifecycleRecord({ content: record.serialized });
  assert.ok(reread);
  assert.deepEqual(reread.identity.sourceRefs, ["plane:ima:TEST-1500"]);
  assert.deepEqual(reread.request.identity.priorArtifactIds, ["synthetic-plan-reference"]);
  assert.equal(reread.reference.recordKey, record.recordKey);
});

test("snapshots valid caller input and rejects malformed, accessor-backed, and mutable request projections", () => {
  const mutable = requestFor();
  const initial = createSerenaLifecycleRecord({
    request: mutable,
    project: projectInput(),
    createdAt,
  });
  assert.ok(initial);
  mutable.identity.lifecycleKey = "synthetic-project:plane:ima:OTHER-1500";
  mutable.identity.sourceRefs.push("plane:ima:OTHER-1500");
  mutable.summary = "Caller mutation after record construction.";
  mutable.artifact = "# Changed after construction";

  const verified = verifySerenaLifecycleRecord({ content: initial.serialized });
  assert.ok(verified);
  assert.equal(verified.lifecycleKey, lifecycleKey);
  assert.equal(verified.summary, "Synthetic Serena lifecycle evidence is exact and independently verifiable.");
  assert.deepEqual(verified.identity.sourceRefs, ["plane:ima:TEST-1500"]);

  let requestAccessorReads = 0;
  const requestAccessor = requestFor();
  Object.defineProperty(requestAccessor, "identity", {
    enumerable: true,
    get: () => {
      requestAccessorReads += 1;
      throw new Error("hostile request accessor");
    },
  });
  assert.doesNotThrow(() => projectSerenaLifecycleRequest(requestAccessor));
  assert.equal(projectSerenaLifecycleRequest(requestAccessor), null);
  assert.equal(requestAccessorReads, 0);

  let identityAccessorReads = 0;
  const identityAccessor = requestFor();
  Object.defineProperty(identityAccessor.identity, "project", {
    enumerable: true,
    get: () => {
      identityAccessorReads += 1;
      throw new Error("hostile identity accessor");
    },
  });
  assert.doesNotThrow(() => projectSerenaLifecycleRequest(identityAccessor));
  assert.equal(projectSerenaLifecycleRequest(identityAccessor), null);
  assert.equal(identityAccessorReads, 0);

  const sparse = requestFor();
  sparse.identity.sourceRefs.length = 2;
  const extra = requestFor();
  extra.extra = true;
  const symbol = requestFor();
  symbol[Symbol("extra")] = true;
  const partialPlane = requestFor();
  delete partialPlane.identity.planeWorkItem;
  for (const [label, value] of [
    ["sparse references", sparse],
    ["extra request field", extra],
    ["symbol request field", symbol],
    ["partial Plane identity", partialPlane],
  ]) {
    assert.equal(projectSerenaLifecycleRequest(value), null, label);
  }
});

test("validates canonical project paths, selections, namespace names, and references without coercion", () => {
  const validProject = project();
  assert.deepEqual(normalizeSerenaLifecycleProject(validProject), validProject);
  assert.equal(createSerenaLifecycleProject({
    projectName: "synthetic-serena-project",
    projectPath: "/workspace/../synthetic-serena-project",
  }), null);
  assert.equal(createSerenaLifecycleProject({
    projectName: "synthetic-serena-project\n",
    projectPath: "/workspace/synthetic-serena-project",
  }), null);
  assert.equal(normalizeSerenaLifecycleProject({
    ...validProject,
    fingerprint: "a".repeat(64),
  }), null);

  const prefix = serenaLifecycleNamespacePrefix(lifecycleKey);
  assert.ok(prefix);
  assert.equal(serenaLifecycleNamespacePrefix(`${lifecycleKey}\n`), null);
  assert.equal(isSerenaLifecycleMemoryName(`${prefix}plan-not-a-uuid`), false);
  assert.equal(projectSerenaLifecycleSelection({ lifecycleKey, limit: 0 }), null);
  assert.equal(projectSerenaLifecycleSelection({ lifecycleKey, phase: "unknown", limit: 1 }), null);

  const { record } = recordFor();
  assert.ok(projectSerenaLifecycleReference(record.reference));
  assert.equal(projectSerenaLifecycleReference({ ...record.reference, extra: true }), null);
  assert.equal(projectSerenaLifecycleReference({
    ...record.reference,
    memoryName: "core",
  }), null);
  assert.equal(projectSerenaLifecycleReference({
    ...record.reference,
    artifactId: "00000000-0000-5000-8000-000000001500",
  }), null);
});

test("fails closed for hash, reference, identity, timestamp, malformed, and oversized stored evidence", () => {
  const { request, record } = recordFor();
  const alternateRequest = requestFor({
    summary: "A different request must not satisfy the original immutable reference.",
  });
  const alternate = createSerenaLifecycleRecord({
    request: alternateRequest,
    project: projectInput(),
    createdAt,
  });
  assert.ok(alternate);

  const parsed = JSON.parse(record.serialized);
  const malformed = [
    JSON.stringify({ ...parsed, extra: true }),
    JSON.stringify({ ...parsed, contentHash: "a".repeat(64) }),
    JSON.stringify({ ...parsed, canonicalHash: "b".repeat(64) }),
    JSON.stringify({ ...parsed, createdAt: "2026-10-15T12:00:00Z" }),
    JSON.stringify({ ...parsed, memoryName: "core" }),
    "not-json",
    "x".repeat(MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS + 1),
    "x".repeat(MAX_SERENA_LIFECYCLE_MEMORY_BYTES + 1),
  ];
  for (const content of malformed) {
    assert.doesNotThrow(() => verifySerenaLifecycleRecord({ content }));
    assert.equal(verifySerenaLifecycleRecord({ content }), null);
  }

  assert.equal(verifySerenaLifecycleRecord({
    content: record.serialized,
    project: { ...project(), projectPath: "/workspace/other-project" },
  }), null);
  assert.equal(verifySerenaLifecycleRecord({
    content: record.serialized,
    selection: { lifecycleKey: "synthetic-project:plane:ima:OTHER-1500", limit: 1 },
  }), null);
  assert.equal(verifySerenaLifecycleRecord({
    content: record.serialized,
    reference: { ...record.reference, requestHash: "a".repeat(64) },
  }), null);
  assert.equal(verifySerenaLifecycleRecord({
    content: record.serialized,
    request: alternateRequest,
  }), null);
  assert.equal(verifySerenaLifecycleRecord({
    content: alternate.serialized,
    reference: record.reference,
    request,
  }), null);

  let accessorReads = 0;
  const input = { content: record.serialized };
  Object.defineProperty(input, "reference", {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      throw new Error("hostile verifier accessor");
    },
  });
  assert.doesNotThrow(() => verifySerenaLifecycleRecord(input));
  assert.equal(verifySerenaLifecycleRecord(input), null);
  assert.equal(accessorReads, 0);
});
