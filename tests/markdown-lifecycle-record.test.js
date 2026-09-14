import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MAX_LIFECYCLE_REFERENCES,
  MAX_LIFECYCLE_SUMMARY_BYTES,
  prepareLifecycleArtifact,
  validateLifecycleWriteRequest,
} from "../lib/ima-lifecycle.ts";
import {
  MARKDOWN_LIFECYCLE_DIRECTORY_VERSION,
  MARKDOWN_LIFECYCLE_PROVIDER,
  MARKDOWN_LIFECYCLE_ROOT,
  MARKDOWN_LIFECYCLE_SCHEMA_VERSION,
  MAX_MARKDOWN_LIFECYCLE_ARTIFACT_BYTES,
  MAX_MARKDOWN_LIFECYCLE_CHECKOUT_ROOT_BYTES,
  MAX_MARKDOWN_LIFECYCLE_RECEIPT_BYTES,
  MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT,
  canonicalMarkdownCheckoutRoot,
  containsRecognizedMarkdownLifecycleSecret,
  createMarkdownLifecycleRecord,
  markdownLifecycleArtifactName,
  markdownLifecycleDirectoryName,
  markdownLifecycleReceiptName,
  markdownLifecycleReferenceFor,
  projectMarkdownLifecycleReceipt,
  projectMarkdownLifecycleReference,
  projectMarkdownLifecycleRequest,
  projectMarkdownLifecycleSelection,
  serializeMarkdownLifecycleReceipt,
  verifyMarkdownLifecycleRecord,
} from "../lib/markdown-lifecycle-record.ts";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const LIFECYCLE_KEY = "ima-pi:plane:ima:SKYNET-209";
const CANONICAL_SUMMARY = "Markdown lifecycle evidence is exact and independently verifiable.";
const CANONICAL_PAYLOAD = "# Markdown lifecycle plan\n\nExact canonical bytes for SKYNET-209.";

const identityFor = (overrides = {}) => ({
  project: "ima-pi",
  lifecycleKey: LIFECYCLE_KEY,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  planeWorkspace: "ima",
  planeWorkItem: "SKYNET-209",
  sourceRefs: ["plane:ima:SKYNET-209"],
  priorArtifactIds: [],
  ...overrides,
});

const deterministicUuidV5 = (value) => {
  const bytes = createHash("sha256").update(value, "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const CANONICAL_ARTIFACT_ID = deterministicUuidV5(JSON.stringify({
  type: "plan",
  identity: identityFor(),
  artifact: CANONICAL_PAYLOAD,
}));

const lifecycleInputFor = ({
  phase = "plan",
  identity = identityFor(),
  summary = CANONICAL_SUMMARY,
  payload = CANONICAL_PAYLOAD,
} = {}) => ({
  type: phase,
  identity,
  summary,
  artifact: payload,
});

const markdownRequestFor = (options = {}) => {
  const lifecycleInput = lifecycleInputFor(options);
  const validated = validateLifecycleWriteRequest(lifecycleInput);
  assert.equal(validated.valid, true, "test fixture must satisfy the lifecycle contract");
  const prepared = prepareLifecycleArtifact(validated);
  assert.equal(prepared.valid, true, "test fixture must produce a prepared artifact");

  return {
    lifecycleInput,
    prepared: prepared.data,
    request: {
      schemaVersion: 1,
      phase: validated.type,
      identity: structuredClone(validated.identity),
      summary: validated.summary,
      artifact: prepared.data.artifact,
      expectedHash: sha256(prepared.data.artifact),
    },
  };
};

const recordFor = (options = {}) => {
  const fixture = markdownRequestFor(options);
  const result = createMarkdownLifecycleRecord(fixture.request);
  assert.equal(result.valid, true, "test fixture must create a Markdown lifecycle record");
  return { ...fixture, record: result.data };
};

const invalidRecord = (value) => {
  const result = createMarkdownLifecycleRecord(value);
  assert.deepEqual(result, { valid: false, code: "markdown_request_invalid" });
};

const canonicalArtifact = () => `---
lifecycle:
  project: 'ima-pi'
  lifecycle_key: 'ima-pi:plane:ima:SKYNET-209'
  lifecycle_root_memory_id: ''
  taskwarrior_project: ''
  taskwarrior_task: ''
  taskwarrior_uuid: ''
  jira_key: ''
  plane_workspace: 'ima'
  plane_work_item: 'SKYNET-209'
  source_refs:
    - 'plane:ima:SKYNET-209'
  phase: 'plan'
  prior_artifact_ids: []
---

# Markdown lifecycle plan

Exact canonical bytes for SKYNET-209.

<!-- ima-lifecycle verification: lifecycle_key=ima-pi:plane:ima:SKYNET-209; nonce=${CANONICAL_ARTIFACT_ID}; phase=plan; jira_key=; taskwarrior_uuid=; plane_workspace=ima; plane_work_item=SKYNET-209; outcome=completed -->
`;

test("creates exact canonical prepared bytes, receipt metadata, names, and reference", () => {
  const { request, record } = recordFor();
  const artifact = canonicalArtifact();
  const contentHash = sha256(artifact);
  const receipt = {
    schemaVersion: 1,
    provider: "markdown",
    lifecycleKey: LIFECYCLE_KEY,
    phase: "plan",
    artifactId: CANONICAL_ARTIFACT_ID,
    identity: identityFor(),
    summary: CANONICAL_SUMMARY,
    contentHash,
  };
  const serializedReceipt = `${JSON.stringify(receipt)}\n`;
  const receiptHash = sha256(serializedReceipt);
  const checkoutRoot = "/workspace/ima-pi";

  assert.equal(MARKDOWN_LIFECYCLE_PROVIDER, "markdown");
  assert.equal(MARKDOWN_LIFECYCLE_SCHEMA_VERSION, 1);
  assert.equal(MARKDOWN_LIFECYCLE_DIRECTORY_VERSION, "v1");
  assert.equal(MARKDOWN_LIFECYCLE_ROOT, ".ima/lifecycle/markdown/v1");
  assert.equal(record.artifactId, CANONICAL_ARTIFACT_ID);
  assert.equal(record.artifact, artifact);
  assert.equal(record.contentHash, contentHash);
  assert.deepEqual(record.identity, identityFor());
  assert.deepEqual(record.receipt, receipt);
  assert.equal(record.serializedReceipt, serializedReceipt);
  assert.equal(record.receiptHash, receiptHash);
  assert.equal(serializeMarkdownLifecycleReceipt(record.receipt), serializedReceipt);
  assert.equal(markdownLifecycleDirectoryName(LIFECYCLE_KEY), sha256(LIFECYCLE_KEY));
  assert.equal(
    markdownLifecycleArtifactName({ phase: record.phase, artifactId: record.artifactId }),
    `plan-${CANONICAL_ARTIFACT_ID}.md`,
  );
  assert.equal(
    markdownLifecycleReceiptName({ phase: record.phase, artifactId: record.artifactId }),
    `plan-${CANONICAL_ARTIFACT_ID}.commit.json`,
  );

  const reference = markdownLifecycleReferenceFor({ checkoutRoot, record });
  assert.deepEqual(reference, {
    schemaVersion: 1,
    provider: "markdown",
    checkoutRoot,
    lifecycleKey: LIFECYCLE_KEY,
    phase: "plan",
    artifactId: CANONICAL_ARTIFACT_ID,
    contentHash,
    receiptHash,
  });
  assert.deepEqual(projectMarkdownLifecycleRequest(request), request);
  assert.deepEqual(projectMarkdownLifecycleReceipt(record.receipt), receipt);
  assert.deepEqual(projectMarkdownLifecycleReference(reference), reference);

  const verified = verifyMarkdownLifecycleRecord({
    artifact: record.artifact,
    receipt: record.serializedReceipt,
    checkoutRoot,
  });
  assert.ok(verified);
  assert.equal(verified.artifact, artifact);
  assert.deepEqual(verified.reference, reference);
});

test("preserves canonical Unicode while rejecting whitespace, control, and invalid UTF-8 projections", () => {
  const unicodeIdentity = identityFor({
    project: "ima-pí",
    lifecycleKey: "ima-pí:plane:ima:SKYNET-209:évidence",
    sourceRefs: ["plane:ima:SKYNET-209", "source:évidence"],
  });
  const { request, record } = recordFor({
    identity: unicodeIdentity,
    summary: "Résumé Δ — exact",
    payload: "# 計画\n\nUnicode evidence remains byte-exact.",
  });
  assert.deepEqual(record.identity, unicodeIdentity);
  assert.equal(record.summary, "Résumé Δ — exact");
  assert.match(record.artifact, /# 計画/);
  assert.equal(record.contentHash, sha256(record.artifact));

  const whitespaceSummary = structuredClone(request);
  whitespaceSummary.summary = " Résumé Δ — exact";
  invalidRecord(whitespaceSummary);

  const whitespaceIdentity = structuredClone(request);
  whitespaceIdentity.identity.project = " ima-pí";
  invalidRecord(whitespaceIdentity);

  const whitespacePhase = structuredClone(request);
  whitespacePhase.phase = " plan";
  invalidRecord(whitespacePhase);

  const upperCaseHash = structuredClone(request);
  upperCaseHash.expectedHash = upperCaseHash.expectedHash.toUpperCase();
  invalidRecord(upperCaseHash);

  const invalidUnicode = structuredClone(request);
  invalidUnicode.summary = "invalid\ud800";
  invalidRecord(invalidUnicode);

  assert.equal(canonicalMarkdownCheckoutRoot("/workspace/évidence"), "/workspace/évidence");
  for (const value of ["workspace/relative", "/workspace/évidence ", "/workspace/évidence/.."]) {
    assert.equal(canonicalMarkdownCheckoutRoot(value), null, value);
  }
});

test("rejects altered framing, identity, phase, nonce, and SHA-256 proof", () => {
  const { request, record } = recordFor();
  const withArtifact = (artifact) => ({
    ...request,
    artifact,
    expectedHash: sha256(artifact),
  });

  const framingMismatch = request.artifact.replace("\n---\n\n", "\n---\n\n\n");
  const identityMismatch = request.artifact.replace(
    "lifecycle_key: 'ima-pi:plane:ima:SKYNET-209'",
    "lifecycle_key: 'ima-pi:plane:ima:SKYNET-210'",
  );
  const nonceMismatch = request.artifact.replace(
    record.artifactId,
    "00000000-0000-5000-8000-000000000001",
  );

  for (const [label, candidate] of [
    ["framing", withArtifact(framingMismatch)],
    ["identity", withArtifact(identityMismatch)],
    ["phase", { ...request, phase: "implementation" }],
    ["nonce", withArtifact(nonceMismatch)],
    ["SHA-256", { ...request, expectedHash: "0".repeat(64) }],
  ]) {
    assert.doesNotThrow(() => invalidRecord(candidate), label);
  }

  const receipt = JSON.parse(record.serializedReceipt);
  const receiptMismatches = [
    { ...receipt, contentHash: "f".repeat(64) },
    { ...receipt, phase: "implementation" },
    { ...receipt, artifactId: "00000000-0000-5000-8000-000000000002" },
    { ...receipt, identity: { ...receipt.identity, project: "other-project" } },
  ];
  for (const mismatch of receiptMismatches) {
    assert.equal(verifyMarkdownLifecycleRecord({
      artifact: record.artifact,
      receipt: `${JSON.stringify(mismatch)}\n`,
      checkoutRoot: "/workspace/ima-pi",
    }), null);
  }
});

test("enforces byte limits for requests, receipts, references, checkout roots, and recall selection", () => {
  const { request, record } = recordFor();
  const oversizedArtifact = "x".repeat(MAX_MARKDOWN_LIFECYCLE_ARTIFACT_BYTES + 1);
  invalidRecord({
    ...request,
    artifact: oversizedArtifact,
    expectedHash: sha256(oversizedArtifact),
  });

  const oversizedSummary = structuredClone(request);
  oversizedSummary.summary = "é".repeat((MAX_LIFECYCLE_SUMMARY_BYTES / 2) + 1);
  invalidRecord(oversizedSummary);

  const oversizedReferences = structuredClone(request);
  oversizedReferences.identity.sourceRefs = Array.from(
    { length: MAX_LIFECYCLE_REFERENCES + 1 },
    (_, index) => `source:${index}`,
  );
  invalidRecord(oversizedReferences);

  assert.equal(
    verifyMarkdownLifecycleRecord({
      artifact: record.artifact,
      receipt: `${record.serializedReceipt}${"x".repeat(MAX_MARKDOWN_LIFECYCLE_RECEIPT_BYTES + 1)}`,
      checkoutRoot: "/workspace/ima-pi",
    }),
    null,
  );

  const largestRoot = `/${"a".repeat(MAX_MARKDOWN_LIFECYCLE_CHECKOUT_ROOT_BYTES - 1)}`;
  assert.equal(canonicalMarkdownCheckoutRoot(largestRoot), largestRoot);
  assert.equal(
    canonicalMarkdownCheckoutRoot(`/${"a".repeat(MAX_MARKDOWN_LIFECYCLE_CHECKOUT_ROOT_BYTES)}`),
    null,
  );

  assert.deepEqual(projectMarkdownLifecycleSelection({ lifecycleKey: LIFECYCLE_KEY }), {
    lifecycleKey: LIFECYCLE_KEY,
    limit: MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT,
  });
  assert.deepEqual(projectMarkdownLifecycleSelection({
    lifecycleKey: LIFECYCLE_KEY,
    phase: "plan",
    limit: MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT,
  }), {
    lifecycleKey: LIFECYCLE_KEY,
    phase: "plan",
    limit: MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT,
  });
  for (const limit of [0, MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT + 1, "1", 1.5]) {
    assert.equal(projectMarkdownLifecycleSelection({ lifecycleKey: LIFECYCLE_KEY, limit }), null);
  }
});

test("accepts only dense own-data requests and rejects malformed, extra, accessor-backed, and inherited inputs", () => {
  const { request, record } = recordFor();
  const reference = markdownLifecycleReferenceFor({
    checkoutRoot: "/workspace/ima-pi",
    record,
  });
  assert.ok(reference);

  const sparseReferences = structuredClone(request);
  sparseReferences.identity.sourceRefs = ["plane:ima:SKYNET-209"];
  sparseReferences.identity.sourceRefs.length = 2;

  const extraRequest = { ...request, extra: true };
  const extraIdentity = {
    ...request,
    identity: { ...request.identity, extra: true },
  };
  const symbolRequest = { ...request, [Symbol("extra")]: true };
  const symbolIdentity = {
    ...request,
    identity: { ...request.identity, [Symbol("extra")]: true },
  };
  const extraArrayEntry = structuredClone(request);
  extraArrayEntry.identity.sourceRefs.extra = true;
  const nonEnumerableArrayEntry = structuredClone(request);
  Object.defineProperty(nonEnumerableArrayEntry.identity.sourceRefs, "0", {
    value: nonEnumerableArrayEntry.identity.sourceRefs[0],
    enumerable: false,
  });

  const inheritedRequest = Object.create({ schemaVersion: 1 });
  Object.assign(inheritedRequest, request);
  delete inheritedRequest.schemaVersion;
  const inheritedIdentity = Object.create({ project: request.identity.project });
  Object.assign(inheritedIdentity, request.identity);
  delete inheritedIdentity.project;
  const inheritedIdentityRequest = { ...request, identity: inheritedIdentity };

  let requestAccessorReads = 0;
  const requestAccessor = structuredClone(request);
  Object.defineProperty(requestAccessor, "identity", {
    enumerable: true,
    get: () => {
      requestAccessorReads += 1;
      throw new Error("hostile request accessor");
    },
  });
  let identityAccessorReads = 0;
  const identityAccessor = structuredClone(request);
  Object.defineProperty(identityAccessor.identity, "project", {
    enumerable: true,
    get: () => {
      identityAccessorReads += 1;
      throw new Error("hostile identity accessor");
    },
  });
  let arrayAccessorReads = 0;
  const arrayAccessor = structuredClone(request);
  Object.defineProperty(arrayAccessor.identity.sourceRefs, "0", {
    enumerable: true,
    get: () => {
      arrayAccessorReads += 1;
      throw new Error("hostile array accessor");
    },
  });

  for (const [label, candidate] of [
    ["null", null],
    ["sparse references", sparseReferences],
    ["extra request field", extraRequest],
    ["extra identity field", extraIdentity],
    ["symbol request field", symbolRequest],
    ["symbol identity field", symbolIdentity],
    ["extra array entry", extraArrayEntry],
    ["non-enumerable array entry", nonEnumerableArrayEntry],
    ["inherited request field", inheritedRequest],
    ["inherited identity field", inheritedIdentityRequest],
    ["request accessor", requestAccessor],
    ["identity accessor", identityAccessor],
    ["array accessor", arrayAccessor],
  ]) {
    assert.doesNotThrow(() => projectMarkdownLifecycleRequest(candidate), label);
    assert.equal(projectMarkdownLifecycleRequest(candidate), null, label);
    invalidRecord(candidate);
  }
  assert.equal(requestAccessorReads, 0);
  assert.equal(identityAccessorReads, 0);
  assert.equal(arrayAccessorReads, 0);

  const receiptAccessor = structuredClone(record.receipt);
  Object.defineProperty(receiptAccessor, "summary", {
    enumerable: true,
    get: () => {
      throw new Error("hostile receipt accessor");
    },
  });
  const inheritedReference = Object.create({ checkoutRoot: reference.checkoutRoot });
  Object.assign(inheritedReference, reference);
  delete inheritedReference.checkoutRoot;
  const sparseSelection = { lifecycleKey: LIFECYCLE_KEY, limit: 1 };
  Object.defineProperty(sparseSelection, "limit", { value: 1, enumerable: false });

  assert.equal(projectMarkdownLifecycleReceipt({ ...record.receipt, extra: true }), null);
  assert.equal(projectMarkdownLifecycleReceipt(receiptAccessor), null);
  assert.equal(projectMarkdownLifecycleReference({ ...reference, extra: true }), null);
  assert.equal(projectMarkdownLifecycleReference(inheritedReference), null);
  assert.equal(projectMarkdownLifecycleSelection(sparseSelection), null);
  assert.equal(verifyMarkdownLifecycleRecord({
    artifact: record.artifact,
    receipt: record.serializedReceipt,
    checkoutRoot: "/workspace/ima-pi",
    extra: true,
  }), null);
});

test("rejects recognized credential-shaped input without mutating or transforming it", () => {
  const recognizedPatterns = [
    "authorization: [redacted]",
    "bearer [redacted]",
    "api_key=[redacted]",
    "-----BEGIN PRIVATE KEY-----",
  ];
  for (const value of recognizedPatterns) {
    assert.equal(containsRecognizedMarkdownLifecycleSecret(value), true, value);
  }
  assert.equal(containsRecognizedMarkdownLifecycleSecret("ordinary lifecycle prose"), false);

  const { request } = markdownRequestFor();
  const summaryInput = structuredClone(request);
  summaryInput.summary = "token=[redacted]";
  const summaryBefore = structuredClone(summaryInput);
  assert.deepEqual(createMarkdownLifecycleRecord(summaryInput), {
    valid: false,
    code: "markdown_secret_detected",
  });
  assert.deepEqual(summaryInput, summaryBefore);

  const artifactInput = structuredClone(request);
  artifactInput.artifact = `${artifactInput.artifact}\napi_key=[redacted]`;
  artifactInput.expectedHash = sha256(artifactInput.artifact);
  const artifactBefore = structuredClone(artifactInput);
  assert.deepEqual(createMarkdownLifecycleRecord(artifactInput), {
    valid: false,
    code: "markdown_secret_detected",
  });
  assert.deepEqual(artifactInput, artifactBefore);
  assert.equal(markdownLifecycleDirectoryName("token=[redacted]"), null);
});
