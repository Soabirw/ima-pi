import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareLifecycleArtifact,
  validateLifecycleRequest,
} from "../lib/ima-lifecycle.ts";
import {
  normalizeInstitutionalManifest,
  normalizeInstitutionalRecord,
} from "../lib/qdrant-corpus.ts";
import {
  projectQdrantLifecycleReference,
  projectQdrantLifecycleRequest,
  projectQdrantLifecycleSelection,
  verifyQdrantLifecycleRecord,
} from "../lib/qdrant-lifecycle-record.ts";

const createdAt = "2026-09-12T00:00:00.000Z";
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
const nonPlaneIdentity = {
  project: "ima-pi",
  lifecycleKey: "ima-pi:manual:qdrant-lifecycle-contract",
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  sourceRefs: ["source:z", "source:a"],
  priorArtifactIds: [],
};

const requestFor = ({ identity, artifact, type = "implementation" }) => ({
  type,
  identity,
  summary: "Qdrant lifecycle evidence is exact and independently verifiable.",
  artifact,
});

const prepared = (request) => {
  const valid = validateLifecycleRequest(request);
  assert.equal(valid.valid, true);
  const result = prepareLifecycleArtifact(valid);
  assert.equal(result.valid, true);
  return result.data;
};

const storedRecord = (request, schemaVersion, stored = {}) => {
  const preparation = prepared(request);
  const input = {
    recordKey: stored.recordKey ?? preparation.recordKey,
    project: stored.project ?? request.identity.project,
    site: stored.site ?? "",
    repo: stored.repo ?? "ima-pi",
    lifecycleKey: stored.lifecycleKey ?? request.identity.lifecycleKey,
    phase: stored.phase ?? request.type,
    summary: stored.summary ?? request.summary,
    detail: stored.detail ?? preparation.artifact,
    sourceRefs: stored.sourceRefs ?? request.identity.sourceRefs,
  };
  const normalized = schemaVersion === 1
    ? normalizeInstitutionalRecord(input, createdAt)
    : normalizeInstitutionalManifest(input, createdAt);
  assert.equal(normalized.success, true);

  return {
    preparation,
    record: {
      id: normalized.data.id,
      recordKey: normalized.data.recordKey,
      project: normalized.data.payload.project,
      site: normalized.data.payload.site,
      repo: normalized.data.payload.repo,
      lifecycleKey: normalized.data.payload.lifecycle_key,
      phase: normalized.data.payload.phase,
      summary: normalized.data.payload.summary,
      detail: schemaVersion === 1
        ? normalized.data.payload.detail
        : input.detail,
      sourceRefs: [...normalized.data.payload.source_refs],
      contentHash: normalized.data.payload.content_hash,
      createdAt: normalized.data.payload.created_at,
    },
  };
};

const referenceFor = ({ preparation, record }) => ({
  schemaVersion: 1,
  provider: "qdrant",
  artifactId: record.id,
  recordKey: record.recordKey,
  contentHash: record.contentHash,
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  nonce: preparation.nonce,
});

test("verifies exact Plane and non-Plane records in both Qdrant storage schemas", () => {
  const cases = [
    ["Plane", requestFor({
      identity: planeIdentity,
      artifact: "# Implementation\n\nSKYNET-211 provider contract.",
    })],
    ["non-Plane", requestFor({
      identity: nonPlaneIdentity,
      artifact: "# Implementation\n\nStandalone provider contract.",
    })],
    ["document", requestFor({
      identity: nonPlaneIdentity,
      type: "document",
      artifact: "# Documentation\n\nREADY: manual documentation evidence remains markerless.",
    })],
  ];

  for (const [label, request] of cases) {
    const v1 = storedRecord(request, 1);
    const v2 = storedRecord(request, 2);
    assert.equal(v1.preparation.recordKey, v2.preparation.recordKey, label);
    assert.equal(v1.preparation.nonce, v2.preparation.nonce, label);
    assert.equal(v1.record.id, v2.record.id, label);
    assert.match(v1.record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(v1.preparation.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(v1.record.id, v1.record.recordKey);
    assert.notEqual(v1.preparation.nonce, v1.record.id);

    for (const [schemaVersion, fixture] of [[1, v1], [2, v2]]) {
      const reference = referenceFor(fixture);
      const verified = verifyQdrantLifecycleRecord({
        record: fixture.record,
        selection: {
          lifecycleKey: request.identity.lifecycleKey,
          phase: request.type,
          limit: 1,
        },
        reference,
        request,
      });
      assert.ok(verified, `${label} schema-v${schemaVersion}`);
      assert.equal(verified.storageSchemaVersion, schemaVersion, label);
      assert.equal(verified.artifactId, fixture.record.id, label);
      assert.equal(verified.recordKey, fixture.preparation.recordKey, label);
      assert.equal(verified.nonce, fixture.preparation.nonce, label);
      assert.equal(
        verified.artifact,
        schemaVersion === 1
          ? fixture.preparation.artifact.trim()
          : fixture.preparation.artifact,
        label,
      );
      assert.deepEqual(verified.reference, reference, label);
      assert.deepEqual(verified.sourceRefs, fixture.record.sourceRefs, label);
      if (request.identity.planeWorkspace) {
        assert.match(verified.artifact, /plane_workspace: 'ima'/, label);
        assert.match(verified.artifact, /plane_work_item=SKYNET-211/, label);
      } else {
        assert.doesNotMatch(verified.artifact, /plane_workspace/, label);
      }
    }
  }
});

test("keeps historical closeout documentation verifiable without projecting it as a new write", () => {
  const historical = requestFor({
    identity: nonPlaneIdentity,
    type: "closeout",
    artifact: [
      "# Historical documentation",
      "",
      "Immutable compatibility evidence.",
      "",
      "<!-- ima-cycle outcome: phase=document; outcome=READY -->",
    ].join("\n"),
  });

  assert.equal(projectQdrantLifecycleRequest(historical), null);
  for (const schemaVersion of [1, 2]) {
    const fixture = storedRecord(historical, schemaVersion);
    const verified = verifyQdrantLifecycleRecord({
      record: fixture.record,
      selection: {
        lifecycleKey: historical.identity.lifecycleKey,
        phase: "closeout",
        limit: 1,
      },
      request: historical,
    });
    assert.ok(verified, `schema-v${schemaVersion}`);
    assert.equal(verified.phase, "closeout", `schema-v${schemaVersion}`);
    assert.deepEqual(verified.identity, historical.identity, `schema-v${schemaVersion}`);
  }
});

test("preserves ordinary closeout and canonical document write projections", () => {
  const ordinaryCloseout = requestFor({
    identity: nonPlaneIdentity,
    type: "closeout",
    artifact: "# Final Closeout\n\nTracker completion is recorded without a document outcome claim.",
  });
  const canonicalDocument = requestFor({
    identity: nonPlaneIdentity,
    type: "document",
    artifact: "# Documentation\n\n<!-- ima-cycle outcome: phase=document; outcome=READY -->",
  });

  assert.deepEqual(projectQdrantLifecycleRequest(ordinaryCloseout), ordinaryCloseout);
  assert.deepEqual(projectQdrantLifecycleRequest(canonicalDocument), canonicalDocument);
});

test("rejects corpus-valid records with divergent lifecycle proof across storage schemas", () => {
  const request = requestFor({
    identity: planeIdentity,
    type: "closeout",
    artifact: "# Historical documentation\n\n<!-- ima-cycle outcome: phase=document; outcome=READY -->",
  });
  const alternateNonce = "00000000-0000-4000-8000-000000000099";

  for (const schemaVersion of [1, 2]) {
    const fixture = storedRecord(request, schemaVersion);
    assert.ok(verifyQdrantLifecycleRecord({ record: fixture.record, request }), `schema-v${schemaVersion} control`);

    const coherentWrongIdentity = storedRecord({
      ...request,
      identity: {
        ...planeIdentity,
        planeWorkspace: "other",
        sourceRefs: ["plane:other:SKYNET-211"],
      },
    }, schemaVersion);
    const coherentWrongLifecycleKey = storedRecord({
      ...request,
      identity: {
        ...planeIdentity,
        lifecycleKey: "ima-pi:plane:ima:OTHER-211",
      },
    }, schemaVersion);
    const coherentWrongLineage = storedRecord({
      ...request,
      identity: {
        ...planeIdentity,
        priorArtifactIds: ["wrong-lineage"],
      },
    }, schemaVersion);
    const variants = [
      ["serialized phase", storedRecord(request, schemaVersion, {
        detail: fixture.preparation.artifact.replace("phase: 'closeout'", "phase: 'document'"),
      }).record],
      ["serialized nonce", storedRecord(request, schemaVersion, {
        detail: fixture.preparation.artifact.replace(`nonce=${fixture.preparation.nonce}`, `nonce=${alternateNonce}`),
      }).record],
      ["stored phase", storedRecord(request, schemaVersion, { phase: "document" }).record],
      ["stored lifecycle key", storedRecord(request, schemaVersion, {
        lifecycleKey: "ima-pi:plane:ima:OTHER-211",
      }).record],
      ["stored record key", storedRecord(request, schemaVersion, {
        recordKey: "ima-pi:plane:ima:SKYNET-211:closeout:forged",
      }).record],
      ["stored source identity", storedRecord(request, schemaVersion, {
        sourceRefs: ["plane:other:SKYNET-211"],
      }).record],
      ["serialized identity", coherentWrongIdentity.record],
      ["serialized lifecycle key", coherentWrongLifecycleKey.record],
      ["serialized lineage", coherentWrongLineage.record],
      ["incomplete serialized detail", storedRecord(request, schemaVersion, {
        detail: "# Forged closeout\n\n<!-- ima-cycle outcome: phase=document; outcome=READY -->",
      }).record],
    ];

    for (const [label, record] of variants) {
      assert.equal(
        verifyQdrantLifecycleRecord({ record, request }),
        null,
        `schema-v${schemaVersion} ${label}`,
      );
    }

    const missingDetail = { ...fixture.record };
    delete missingDetail.detail;
    assert.equal(verifyQdrantLifecycleRecord({ record: missingDetail, request }), null, `schema-v${schemaVersion} missing detail`);
  }
});

test("fails closed for malformed evidence and returns detached closed projections", () => {
  const request = requestFor({
    identity: planeIdentity,
    artifact: "# Implementation\n\nVerification must reject corrupt evidence.",
  });
  const fixture = storedRecord(request, 2);
  const reference = referenceFor(fixture);
  const selection = {
    lifecycleKey: request.identity.lifecycleKey,
    phase: request.type,
    limit: 1,
  };
  const original = structuredClone(fixture.record);
  const verified = verifyQdrantLifecycleRecord({
    record: fixture.record,
    selection,
    reference,
    request,
  });
  assert.ok(verified);

  for (const record of [
    { ...fixture.record, extra: true },
    { ...fixture.record, id: "00000000-0000-0000-0000-000000000000" },
    { ...fixture.record, contentHash: "a".repeat(64) },
    { ...fixture.record, detail: fixture.record.detail.replace("outcome=completed", "outcome=blocked") },
    { ...fixture.record, sourceRefs: [...fixture.record.sourceRefs, "unverified:source"] },
  ]) {
    assert.equal(verifyQdrantLifecycleRecord({ record }), null);
  }

  const accessor = { ...fixture.record };
  Object.defineProperty(accessor, "detail", {
    enumerable: true,
    get: () => { throw new Error("hostile accessor"); },
  });
  assert.doesNotThrow(() => verifyQdrantLifecycleRecord({ record: accessor }));
  assert.equal(verifyQdrantLifecycleRecord({ record: accessor }), null);
  assert.equal(
    verifyQdrantLifecycleRecord({
      record: fixture.record,
      selection: { ...selection, lifecycleKey: "ima-pi:plane:ima:OTHER-1" },
    }),
    null,
  );
  assert.equal(
    verifyQdrantLifecycleRecord({
      record: fixture.record,
      reference: { ...reference, nonce: "00000000-0000-0000-0000-000000000000" },
    }),
    null,
  );
  assert.ok(projectQdrantLifecycleSelection({ ...selection, limit: 50 }));
  assert.equal(projectQdrantLifecycleSelection({ ...selection, limit: 51 }), null);
  assert.equal(projectQdrantLifecycleReference({ ...reference, extra: true }), null);

  verified.sourceRefs.push("caller-mutation");
  verified.reference.recordKey = "caller-mutation";
  assert.deepEqual(fixture.record, original);
  const reread = verifyQdrantLifecycleRecord({
    record: fixture.record,
    selection,
    reference,
    request,
  });
  assert.ok(reread);
  assert.deepEqual(reread.sourceRefs, original.sourceRefs);
  assert.equal(reread.reference.recordKey, original.recordKey);
});

test("projects only dense own-data lifecycle requests and preserves valid request semantics", () => {
  const request = requestFor({
    identity: {
      ...nonPlaneIdentity,
      sourceRefs: ["source:z", "source:a"],
      priorArtifactIds: ["85e12eff-d162-5262-bbfe-ec0624cb40d9"],
    },
    artifact: "# Implementation\n\nStrict request projection.",
  });
  const projected = projectQdrantLifecycleRequest(request);
  assert.ok(projected);
  assert.deepEqual(projected, request);
  assert.notStrictEqual(projected.identity.sourceRefs, request.identity.sourceRefs);
  assert.notStrictEqual(projected.identity.priorArtifactIds, request.identity.priorArtifactIds);
  projected.identity.sourceRefs.push("caller-mutation");
  projected.identity.priorArtifactIds.push("caller-mutation");
  assert.deepEqual(request.identity.sourceRefs, ["source:z", "source:a"]);
  assert.deepEqual(request.identity.priorArtifactIds, ["85e12eff-d162-5262-bbfe-ec0624cb40d9"]);

  const emptyPlanePair = requestFor({
    identity: {
      ...nonPlaneIdentity,
      planeWorkspace: "",
      planeWorkItem: "",
    },
    artifact: "# Implementation\n\nEmpty Plane pair remains valid.",
  });
  const emptyPlaneProjection = projectQdrantLifecycleRequest(emptyPlanePair);
  assert.ok(emptyPlaneProjection);
  assert.equal(validateLifecycleRequest(emptyPlaneProjection).valid, true);

  const partialPlanePair = requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nPartial Plane pair is rejected.",
  });
  delete partialPlanePair.identity.planeWorkItem;
  assert.equal(projectQdrantLifecycleRequest(partialPlanePair), null);

  for (const [field, entries] of [
    ["sourceRefs", ["source:z"]],
    ["priorArtifactIds", ["85e12eff-d162-5262-bbfe-ec0624cb40d9"]],
  ]) {
    entries.length = 2;
    const sparse = requestFor({
      identity: { ...nonPlaneIdentity, [field]: entries },
      artifact: "# Implementation\n\nSparse lifecycle references are rejected.",
    });
    assert.equal(projectQdrantLifecycleRequest(sparse), null, field);
  }

  let requestAccessorReads = 0;
  const requestAccessor = requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nRequest accessors are rejected.",
  });
  Object.defineProperty(requestAccessor, "identity", {
    enumerable: true,
    get: () => {
      requestAccessorReads += 1;
      throw new Error("request accessor invoked");
    },
  });
  assert.doesNotThrow(() => projectQdrantLifecycleRequest(requestAccessor));
  assert.equal(projectQdrantLifecycleRequest(requestAccessor), null);
  assert.equal(requestAccessorReads, 0);

  let identityAccessorReads = 0;
  const identityAccessor = requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nIdentity accessors are rejected.",
  });
  Object.defineProperty(identityAccessor.identity, "project", {
    enumerable: true,
    get: () => {
      identityAccessorReads += 1;
      throw new Error("identity accessor invoked");
    },
  });
  assert.doesNotThrow(() => projectQdrantLifecycleRequest(identityAccessor));
  assert.equal(projectQdrantLifecycleRequest(identityAccessor), null);
  assert.equal(identityAccessorReads, 0);

  let entryAccessorReads = 0;
  const entryAccessor = requestFor({
    identity: { ...planeIdentity, sourceRefs: [...planeIdentity.sourceRefs] },
    artifact: "# Implementation\n\nArray entry accessors are rejected.",
  });
  Object.defineProperty(entryAccessor.identity.sourceRefs, "0", {
    enumerable: true,
    get: () => {
      entryAccessorReads += 1;
      throw new Error("array entry accessor invoked");
    },
  });
  assert.doesNotThrow(() => projectQdrantLifecycleRequest(entryAccessor));
  assert.equal(projectQdrantLifecycleRequest(entryAccessor), null);
  assert.equal(entryAccessorReads, 0);

  const extraArrayEntry = requestFor({
    identity: { ...planeIdentity, sourceRefs: [...planeIdentity.sourceRefs] },
    artifact: "# Implementation\n\nExtra array entries are rejected.",
  });
  extraArrayEntry.identity.sourceRefs.extra = true;
  const symbolArrayEntry = requestFor({
    identity: { ...planeIdentity, sourceRefs: [...planeIdentity.sourceRefs] },
    artifact: "# Implementation\n\nArray symbols are rejected.",
  });
  symbolArrayEntry.identity.sourceRefs[Symbol("extra")] = true;
  const nonEnumerableArrayEntry = requestFor({
    identity: { ...planeIdentity, sourceRefs: [...planeIdentity.sourceRefs] },
    artifact: "# Implementation\n\nNon-enumerable array entries are rejected.",
  });
  Object.defineProperty(nonEnumerableArrayEntry.identity.sourceRefs, "0", {
    value: nonEnumerableArrayEntry.identity.sourceRefs[0],
    enumerable: false,
  });

  const extraRequest = requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nExtra request keys are rejected.",
  });
  extraRequest.extra = true;
  const extraIdentity = requestFor({
    identity: { ...planeIdentity, extra: true },
    artifact: "# Implementation\n\nExtra identity keys are rejected.",
  });
  const symbolRequest = requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nRequest symbols are rejected.",
  });
  symbolRequest[Symbol("extra")] = true;
  const symbolIdentity = requestFor({
    identity: { ...planeIdentity, [Symbol("extra")]: true },
    artifact: "# Implementation\n\nIdentity symbols are rejected.",
  });
  const nonEnumerableRequest = requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nNon-enumerable request fields are rejected.",
  });
  Object.defineProperty(nonEnumerableRequest, "summary", {
    value: nonEnumerableRequest.summary,
    enumerable: false,
  });
  const nonEnumerableIdentity = requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nNon-enumerable identity fields are rejected.",
  });
  Object.defineProperty(nonEnumerableIdentity.identity, "project", {
    value: nonEnumerableIdentity.identity.project,
    enumerable: false,
  });
  const inheritedRequest = Object.create({ type: "implementation" });
  Object.assign(inheritedRequest, requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nInherited request fields are rejected.",
  }));
  delete inheritedRequest.type;
  const inheritedIdentity = Object.create({ project: "ima-pi" });
  Object.assign(inheritedIdentity, planeIdentity);
  delete inheritedIdentity.project;
  const inheritedIdentityRequest = requestFor({
    identity: inheritedIdentity,
    artifact: "# Implementation\n\nInherited identity fields are rejected.",
  });

  for (const [label, malformed] of [
    ["extra array entry", extraArrayEntry],
    ["array symbol", symbolArrayEntry],
    ["non-enumerable array entry", nonEnumerableArrayEntry],
    ["extra request key", extraRequest],
    ["extra identity key", extraIdentity],
    ["request symbol", symbolRequest],
    ["identity symbol", symbolIdentity],
    ["non-enumerable request field", nonEnumerableRequest],
    ["non-enumerable identity field", nonEnumerableIdentity],
    ["inherited request field", inheritedRequest],
    ["inherited identity field", inheritedIdentityRequest],
  ]) {
    assert.equal(projectQdrantLifecycleRequest(malformed), null, label);
  }
});

test("returns null without invoking an optional verifier request accessor", () => {
  const request = requestFor({
    identity: { ...planeIdentity },
    artifact: "# Implementation\n\nOptional request projection.",
  });
  const fixture = storedRecord(request, 2);
  let requestAccessorReads = 0;
  const optionalRequest = { ...request };
  Object.defineProperty(optionalRequest, "identity", {
    enumerable: true,
    get: () => {
      requestAccessorReads += 1;
      throw new Error("optional request accessor invoked");
    },
  });

  assert.doesNotThrow(() => verifyQdrantLifecycleRecord({
    record: fixture.record,
    request: optionalRequest,
  }));
  assert.equal(verifyQdrantLifecycleRecord({
    record: fixture.record,
    request: optionalRequest,
  }), null);
  assert.equal(requestAccessorReads, 0);

  let verifierRequestAccessorReads = 0;
  const verifierInput = { record: fixture.record };
  Object.defineProperty(verifierInput, "request", {
    enumerable: true,
    get: () => {
      verifierRequestAccessorReads += 1;
      throw new Error("verifier request accessor invoked");
    },
  });
  assert.doesNotThrow(() => verifyQdrantLifecycleRecord(verifierInput));
  assert.equal(verifyQdrantLifecycleRecord(verifierInput), null);
  assert.equal(verifierRequestAccessorReads, 0);
});
