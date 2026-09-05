import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLE_PHASES,
  MAX_LIFECYCLE_REQUEST_CHARACTERS,
  MAX_LIFECYCLE_RECORD_KEY_BYTES,
  MAX_LIFECYCLE_SUMMARY_BYTES,
  buildLifecycleArtifact,
  buildLifecycleArtifactBody,
  buildLifecycleNonceMarker,
  buildLifecycleRecordKey,
  deriveLifecycleNonce,
  deriveLifecycleResult,
  normalizeLifecycleIdentity,
  normalizeLifecycleRecordKey,
  prepareLifecycleArtifact,
  evaluateLifecycleArtifact,
  hasBoundedLifecycleRecordKey,
  sanitizeLifecycleError,
  validateLifecycleRequest,
  validateLifecycleStoreReceipt,
} from "../lib/ima-lifecycle.ts";

const identity = {
  project: "ima-pi",
  lifecycleKey: "ima-pi:taskwarrior:FNR-3007:uuid",
  lifecycleRootMemoryId: "root",
  taskwarriorProject: "FNR-3007",
  taskwarriorTask: "uuid",
  taskwarriorUuid: "task-uuid",
  jiraKey: "FNR-3016",
  sourceRefs: ["Taskwarrior:task-uuid"],
  priorArtifactIds: ["plan"],
};
const standalone = {
  ...identity,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  sourceRefs: [],
  priorArtifactIds: [],
};
const summary = "Implementation stores verified lifecycle artifacts in the institutional corpus.";
const artifact = "# Source and approved outcome\n\n## Scope\n\n## Verification";
const nonce = "01234567-89ab-cdef-0123-456789abcdef";

const verification = (content, overrides = {}) => evaluateLifecycleArtifact({
  artifact: content,
  lifecycleKey: identity.lifecycleKey,
  nonce,
  type: "implementation",
  jiraKey: identity.jiraKey,
  taskwarriorUuid: identity.taskwarriorUuid,
  ...overrides,
});
const completedArtifact = (overrides = {}) => {
  const input = {
    lifecycleKey: identity.lifecycleKey,
    nonce,
    type: "implementation",
    jiraKey: identity.jiraKey,
    taskwarriorUuid: identity.taskwarriorUuid,
    ...overrides,
  };
  return `${artifact}\n${buildLifecycleNonceMarker(input)}\n`;
};

test("validates every supported phase with an explicit summary and identity", () => {
  for (const type of LIFECYCLE_PHASES) {
    assert.equal(validateLifecycleRequest({ type, identity, summary, artifact }).valid, true);
  }
  assert.equal(validateLifecycleRequest({ type: "decision", identity: standalone, summary, artifact }).valid, true);
  assert.equal(validateLifecycleRequest({ type: "other", identity, summary, artifact }).valid, false);
  assert.equal(validateLifecycleRequest({ type: "plan", identity: { ...standalone, project: "" }, summary, artifact }).valid, false);
  assert.equal(validateLifecycleRequest({ type: "plan", identity: { ...standalone, jiraKey: 3 }, summary, artifact }).valid, false);
});

test("requires a bounded control-character-safe UTF-8 summary", () => {
  for (const invalidSummary of ["", " \t", "line\nbreak", "\0", "é".repeat(1_001)]) {
    const result = validateLifecycleRequest({ type: "plan", identity, summary: invalidSummary, artifact });
    assert.equal(result.valid, false);
    assert.equal(result.error.code, "invalid_lifecycle_summary");
  }
  assert.equal(MAX_LIFECYCLE_SUMMARY_BYTES, 2_000);
});

test("normalizes only raw control-safe bounded lifecycle record keys", () => {
  const valid = "ima-pi:jira:FNR-3036:implementation:abcdefabcdef";
  const controls = [
    ...Array.from({ length: 0x20 }, (_, code) => String.fromCodePoint(code)),
    String.fromCodePoint(0x7f),
    ...Array.from({ length: 0x20 }, (_, offset) => String.fromCodePoint(0x80 + offset)),
  ];
  assert.equal(normalizeLifecycleRecordKey(` ${valid} `), valid);
  assert.equal(normalizeLifecycleRecordKey("é".repeat(256)), "é".repeat(256));
  assert.equal(MAX_LIFECYCLE_RECORD_KEY_BYTES, 512);

  for (const control of controls) {
    for (const invalid of [`${control}${valid}`, `${valid}${control}`, control]) {
      assert.equal(normalizeLifecycleRecordKey(invalid), null);
    }
  }
  for (const invalid of ["", "é".repeat(257)]) {
    assert.equal(normalizeLifecycleRecordKey(invalid), null);
  }
});

test("preserves the approved raw request ceiling while rejecting empty artifacts", () => {
  const request = (value) => validateLifecycleRequest({ type: "plan", identity, summary, artifact: value });
  assert.equal(request("x".repeat(MAX_LIFECYCLE_REQUEST_CHARACTERS)).valid, true);
  assert.equal(request("x".repeat(MAX_LIFECYCLE_REQUEST_CHARACTERS + 1)).valid, false);
  assert.equal(request(" \n\t ").valid, false);
});

test("rejects closed identity violations before serialization", () => {
  const invalidIdentities = [
    { ...identity, extra: "forbidden" },
    { ...identity, lifecycleKey: "line\nbreak" },
    { ...identity, project: "\u0085" },
    { ...identity, taskwarriorProject: "p".repeat(257) },
    { ...identity, lifecycleRootMemoryId: "r".repeat(513) },
    { ...identity, jiraKey: "J".repeat(129) },
    { ...identity, planeWorkspace: "P".repeat(129) },
    { ...identity, planeWorkspace: "IMA; plane_workspace=other", planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "IMA -->", planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "eric-1" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "ERIC-0" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "ERIC-9007199254740992" },
    { ...identity, planeWorkItem: "line\nbreak" },
    { ...identity, planeWorkspace: "IMA" },
    { ...identity, planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "" },
    { ...identity, planeWorkItem: "" },
    { ...identity, planeWorkspace: "", planeWorkItem: "ERIC-1" },
    { ...identity, planeWorkspace: "IMA", planeWorkItem: "" },
    { ...identity, sourceRefs: Array.from({ length: 65 }, () => "source") },
    { ...identity, priorArtifactIds: ["x".repeat(1_025)] },
  ];
  for (const candidate of invalidIdentities) {
    assert.equal(normalizeLifecycleIdentity(candidate), null);
    assert.equal(validateLifecycleRequest({ type: "implementation", identity: candidate, summary, artifact }).valid, false);
  }
  const normalized = normalizeLifecycleIdentity({ ...identity, project: " ima-pi ", sourceRefs: [" source "] });
  assert.deepEqual(normalized?.project, "ima-pi");
  assert.deepEqual(normalized?.sourceRefs, ["source"]);
});

test("derives deterministic lifecycle nonces and rejects projected storage overflows", () => {
  const valid = validateLifecycleRequest({ type: "implementation", identity, summary, artifact });
  assert.equal(valid.valid, true);
  const first = prepareLifecycleArtifact(valid);
  const second = prepareLifecycleArtifact(valid);
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.equal(first.data.nonce, second.data.nonce);
  assert.equal(first.data.recordKey, second.data.recordKey);
  assert.equal(deriveLifecycleNonce(valid), first.data.nonce);

  const changedArtifact = validateLifecycleRequest({ type: "implementation", identity, summary, artifact: `${artifact} changed` });
  const changedIdentity = validateLifecycleRequest({ type: "implementation", identity: { ...identity, taskwarriorTask: "other" }, summary, artifact });
  assert.equal(changedArtifact.valid, true);
  assert.equal(changedIdentity.valid, true);
  assert.notEqual(prepareLifecycleArtifact(changedArtifact).data.recordKey, first.data.recordKey);
  assert.notEqual(prepareLifecycleArtifact(changedIdentity).data.recordKey, first.data.recordKey);

  const changedSummary = validateLifecycleRequest({ type: "implementation", identity, summary: "A different immutable summary.", artifact });
  assert.equal(changedSummary.valid, true);
  assert.equal(prepareLifecycleArtifact(changedSummary).data.recordKey, first.data.recordKey);

  const oversized = validateLifecycleRequest({ type: "implementation", identity, summary, artifact: "é".repeat(80_000) });
  assert.equal(oversized.valid, true);
  assert.deepEqual(prepareLifecycleArtifact(oversized), {
    valid: false,
    error: sanitizeLifecycleError("lifecycle_artifact_too_large", oversized),
  });

  const longKey = validateLifecycleRequest({ type: "implementation", identity: { ...identity, lifecycleKey: "l".repeat(512) }, summary, artifact });
  assert.equal(hasBoundedLifecycleRecordKey("l".repeat(512), "implementation"), false);
  assert.equal(longKey.valid, false);
  const forged = {
    ...valid,
    identity: { ...valid.identity, lifecycleKey: "l".repeat(512) },
  };
  assert.equal(prepareLifecycleArtifact(forged).valid, false);
});

test("rejects embedded persisted lifecycle artifacts but permits cycle outcomes", () => {
  const persistedMarker = buildLifecycleNonceMarker({
    lifecycleKey: identity.lifecycleKey,
    nonce,
    type: "plan",
    jiraKey: identity.jiraKey,
    taskwarriorUuid: identity.taskwarriorUuid,
  });
  const rejected = validateLifecycleRequest({
    type: "plan",
    identity,
    summary,
    artifact: `${artifact}\n${persistedMarker}`,
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.error.code, "lifecycle_artifact_embeds_prior_artifact");

  const accepted = validateLifecycleRequest({
    type: "plan",
    identity,
    summary,
    artifact: `${artifact}\n<!-- ima-cycle outcome: phase=implementation; outcome=COMPLETED -->`,
  });
  assert.equal(accepted.valid, true);
});

test("adds Plane identity only when set without changing existing serialization", () => {
  const nonPlaneInput = { type: "implementation", identity, artifact };
  const expectedNonPlaneBody = `---
lifecycle:
  project: 'ima-pi'
  lifecycle_key: 'ima-pi:taskwarrior:FNR-3007:uuid'
  lifecycle_root_memory_id: 'root'
  taskwarrior_project: 'FNR-3007'
  taskwarrior_task: 'uuid'
  taskwarrior_uuid: 'task-uuid'
  jira_key: 'FNR-3016'
  source_refs:
    - 'Taskwarrior:task-uuid'
  phase: 'implementation'
  prior_artifact_ids:
    - 'plan'
---

# Source and approved outcome

## Scope

## Verification

`;

  assert.equal(buildLifecycleArtifactBody(nonPlaneInput), expectedNonPlaneBody);
  assert.equal(deriveLifecycleNonce(nonPlaneInput), "46f91656-ff58-58bc-8735-97387144f678");
  assert.deepEqual(
    normalizeLifecycleIdentity({ ...identity, planeWorkspace: "", planeWorkItem: "" }),
    identity,
  );

  const planeIdentity = {
    ...standalone,
    planeWorkspace: "IMA",
    planeWorkItem: "ERIC-1",
  };
  const normalizedPlaneIdentity = normalizeLifecycleIdentity(planeIdentity);
  assert.deepEqual(normalizedPlaneIdentity, planeIdentity);

  const serialized = buildLifecycleArtifactBody({
    type: "implementation",
    identity: normalizedPlaneIdentity,
    artifact,
  });
  assert.match(
    serialized,
    /plane_workspace: 'IMA'\n  plane_work_item: 'ERIC-1'\n  source_refs/,
  );

  const otherWorkspaceIdentity = { ...planeIdentity, planeWorkspace: "OTHER" };
  const first = validateLifecycleRequest({ type: "implementation", identity: planeIdentity, summary, artifact });
  const second = validateLifecycleRequest({ type: "implementation", identity: otherWorkspaceIdentity, summary, artifact });
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  const firstArtifact = prepareLifecycleArtifact(first);
  const secondArtifact = prepareLifecycleArtifact(second);
  assert.equal(firstArtifact.valid, true);
  assert.equal(secondArtifact.valid, true);
  assert.notEqual(firstArtifact.data.nonce, secondArtifact.data.nonce);
  assert.notEqual(firstArtifact.data.recordKey, secondArtifact.data.recordKey);
});

test("serializes lifecycle metadata and derives a deterministic content-addressed manifest key", () => {
  const serialized = buildLifecycleArtifact({ type: "implementation", identity, artifact, nonce });
  const first = buildLifecycleRecordKey({ lifecycleKey: identity.lifecycleKey, type: "implementation", artifact: serialized });
  const second = buildLifecycleRecordKey({ lifecycleKey: identity.lifecycleKey, type: "implementation", artifact: serialized });
  const changed = buildLifecycleRecordKey({ lifecycleKey: identity.lifecycleKey, type: "implementation", artifact: `${serialized}changed` });

  assert.match(serialized, /lifecycle_key: 'ima-pi:taskwarrior:FNR-3007:uuid'/);
  assert.match(serialized, /source_refs:\n    - 'Taskwarrior:task-uuid'/);
  assert.match(serialized, /outcome=completed/);
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(first, /:implementation:[a-f0-9]{12}$/);
});

test("accepts only successful corpus store receipts with deterministic point IDs", () => {
  const id = "abcdefab-cdef-abcd-efab-cdefabcdefab";
  assert.deepEqual(validateLifecycleStoreReceipt({ status: "stored", id }), { accepted: true, artifactId: id });
  assert.deepEqual(validateLifecycleStoreReceipt({ status: "unchanged", id }), { accepted: true, artifactId: id });
  for (const receipt of [null, {}, { status: "stored", id: "not-a-uuid" }, { status: "failed", id }]) {
    assert.deepEqual(validateLifecycleStoreReceipt(receipt), { accepted: false, artifactId: null });
  }
});

test("direct reassembled artifacts must contain every lifecycle completion marker", () => {
  const content = completedArtifact();
  assert.equal(verification(content).matched, true);
  assert.equal(verification(content.replace(nonce, "other")).matched, false);
  assert.equal(verification(content.replace("phase=implementation", "phase=review")).matched, false);
  assert.equal(verification(content.replace(identity.jiraKey, "")).matched, false);
  assert.equal(verification(content.replace("outcome=completed", "outcome=blocked")).matched, false);
  assert.equal(verification(`${content}unrelated`).matched, false);
  const lifecycleOnly = completedArtifact({ jiraKey: "", taskwarriorUuid: "" });
  assert.equal(verification(lifecycleOnly, { jiraKey: "", taskwarriorUuid: "" }).matched, true);
});

test("binds Plane lifecycle markers to the complete source identity", () => {
  const planeIdentity = {
    ...standalone,
    lifecycleKey: "ima-pi:plane:ima:SKYNET-61",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-61",
    sourceRefs: ["plane:ima:SKYNET-61"],
  };
  const serialized = buildLifecycleArtifact({
    type: "implementation",
    identity: planeIdentity,
    artifact,
    nonce,
  });

  assert.match(
    serialized,
    /plane_workspace=ima; plane_work_item=SKYNET-61; outcome=completed -->\n$/,
  );
  assert.equal(evaluateLifecycleArtifact({
    artifact: serialized,
    lifecycleKey: planeIdentity.lifecycleKey,
    nonce,
    type: "implementation",
    jiraKey: "",
    taskwarriorUuid: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-61",
  }).matched, true);
  assert.equal(evaluateLifecycleArtifact({
    artifact: serialized,
    lifecycleKey: planeIdentity.lifecycleKey,
    nonce,
    type: "implementation",
    jiraKey: "",
    taskwarriorUuid: "",
    planeWorkspace: "other",
    planeWorkItem: "SKYNET-61",
  }).matched, false);
  assert.equal(evaluateLifecycleArtifact({
    artifact: serialized,
    lifecycleKey: planeIdentity.lifecycleKey,
    nonce,
    type: "implementation",
    jiraKey: "",
    taskwarriorUuid: "",
    planeWorkspace: "ima",
    planeWorkItem: "SKYNET-62",
  }).matched, false);
  assert.equal(evaluateLifecycleArtifact({
    artifact: serialized,
    lifecycleKey: planeIdentity.lifecycleKey,
    nonce,
    type: "implementation",
    jiraKey: "",
    taskwarriorUuid: "",
    planeWorkspace: "ima",
  }).matched, false);
  assert.equal(
    buildLifecycleNonceMarker({
      lifecycleKey: identity.lifecycleKey,
      nonce,
      type: "implementation",
      jiraKey: identity.jiraKey,
      taskwarriorUuid: identity.taskwarriorUuid,
    }),
    `<!-- ima-lifecycle verification: lifecycle_key=${identity.lifecycleKey}; nonce=${nonce}; phase=implementation; jira_key=${identity.jiraKey}; taskwarrior_uuid=${identity.taskwarriorUuid}; outcome=completed -->`,
  );
});

test("derivation retains both lifecycle references and sanitized failures", () => {
  const recordKey = `${identity.lifecycleKey}:implementation:abcdefabcdef`;
  const recall = verification(completedArtifact());
  const completed = deriveLifecycleResult({
    type: "implementation",
    lifecycleKey: identity.lifecycleKey,
    recordKey,
    receipt: { accepted: true, artifactId: "abcdefab-cdef-abcd-efab-cdefabcdefab" },
    recall,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.recordKey, recordKey);
  assert.equal(completed.receiptAccepted, true);
  assert.equal(completed.semanticRecall.matched, true);

  const unverified = deriveLifecycleResult({
    type: "implementation",
    lifecycleKey: identity.lifecycleKey,
    recordKey,
    receipt: { accepted: true, artifactId: "abcdefab-cdef-abcd-efab-cdefabcdefab" },
    recall: verification(""),
    error: "corpus_recall_failed",
  });
  assert.equal(unverified.status, "failed");
  assert.equal(unverified.artifactId, "abcdefab-cdef-abcd-efab-cdefabcdefab");
  assert.equal(unverified.recordKey, recordKey);

  const failed = deriveLifecycleResult({
    type: "plan",
    lifecycleKey: identity.lifecycleKey,
    recordKey,
    receipt: { accepted: false, artifactId: null },
    recall: verification(""),
    error: "corpus_store_failed",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.recordKey, null);
  assert.deepEqual(sanitizeLifecycleError("invalid_lifecycle_summary", "token=secret"), {
    code: "invalid_lifecycle_summary",
    message: "Lifecycle summary must be non-empty, control-character-safe, and at most 2,000 UTF-8 bytes.",
  });
});
