import assert from "node:assert/strict";
import test from "node:test";
import { buildLifecycleArtifact, buildLifecycleNonceMarker, deriveLifecycleResult, evaluateLifecycleRecall, LIFECYCLE_PHASES, sanitizeLifecycleError, validateLifecycleRequest, validateVestigeSaveReceipt } from "../lib/ima-lifecycle.ts";
const identity = { project: "ima-pi", lifecycleKey: "ima-pi:taskwarrior:FNR-3007:uuid", lifecycleRootMemoryId: "root", taskwarriorProject: "FNR-3007", taskwarriorTask: "uuid", taskwarriorUuid: "task-uuid", jiraKey: "FNR-3016", sourceRefs: ["Taskwarrior:task-uuid"], priorArtifactIds: ["plan"] };
const standalone = { ...identity, lifecycleRootMemoryId: "", taskwarriorProject: "", taskwarriorTask: "", taskwarriorUuid: "", jiraKey: "", sourceRefs: [], priorArtifactIds: [] };
const artifact = "# Source and approved outcome\n## Scope\n## Non-goals\n## Phase result\n## Changed files\n## Decisions\n## Verification commands/results\n## Blockers\n## Residual risk\n## Prior artifacts\n## Recommended next phase";
const nonce = "01234567-89ab-cdef-0123-456789abcdef";
const phaseMarker = "phase=implementation;";
const recall = (content, overrides = {}) => evaluateLifecycleRecall({
  envelope: { structuredContent: { results: [{ nested: { content } }] } },
  lifecycleKey: identity.lifecycleKey,
  nonce,
  type: "implementation",
  jiraKey: identity.jiraKey,
  taskwarriorUuid: identity.taskwarriorUuid,
  ...overrides,
});
test("validates every supported phase and lifecycle identity", () => { for (const type of LIFECYCLE_PHASES) assert.equal(validateLifecycleRequest({ type, identity, artifact }).valid, true); assert.equal(validateLifecycleRequest({ type: "decision", identity: standalone, artifact }).valid, true); assert.equal(validateLifecycleRequest({ type: "other", identity, artifact }).valid, false); assert.equal(validateLifecycleRequest({ type: "plan", identity: { ...standalone, project: "" }, artifact }).valid, false); assert.equal(validateLifecycleRequest({ type: "plan", identity: { ...standalone, jiraKey: 3 }, artifact }).valid, false); });
test("rejects non-string lifecycle identity array members", () => {
  const invalidMembers = [null, 1, {}, []];

  for (const key of ["sourceRefs", "priorArtifactIds"]) {
    for (const member of invalidMembers) {
      const result = validateLifecycleRequest({
        type: "implementation",
        identity: { ...identity, [key]: [member] },
        artifact,
      });

      assert.equal(result.valid, false);
      assert.equal(result.error.code, "invalid_lifecycle_request");
    }
  }
});

test("keeps non-empty lifecycle artifact bounds without heading requirements", () => {
  const request = (artifact) => validateLifecycleRequest({ type: "plan", identity, artifact }).valid;
  assert.equal(request("minimal artifact"), true);
  assert.equal(request("x".repeat(128_000)), true);
  const redactedBoundary = validateLifecycleRequest({ type: "plan", identity, artifact: `${"x".repeat(127_993)}token=z` });
  assert.equal(redactedBoundary.valid, true);
  assert.equal(redactedBoundary.artifact.length, 128_000);
  assert.doesNotMatch(redactedBoundary.artifact, /token=z/);
  assert.equal(request(""), false);
  assert.equal(request(" \n\t "), false);
  assert.equal(request("x".repeat(128_001)), false);
});

test("rejects an embedded persisted lifecycle verification marker", () => {
  const embeddedMarker = buildLifecycleNonceMarker({
    lifecycleKey: identity.lifecycleKey,
    nonce,
    type: "plan",
    jiraKey: identity.jiraKey,
    taskwarriorUuid: identity.taskwarriorUuid,
  });
  const result = validateLifecycleRequest({ type: "plan", identity, artifact: `${artifact}\n${embeddedMarker}` });

  assert.equal(result.valid, false);
  assert.equal(result.error.code, "lifecycle_artifact_embeds_prior_artifact");
  assert.equal(
    result.error.message,
    "Lifecycle artifact embeds a prior artifact. Reference prior IDs in prior_artifact_ids or source_refs instead of pasting content.",
  );
});

test("allows lifecycle marker data split across closed comments", () => {
  const result = validateLifecycleRequest({
    type: "plan",
    identity,
    artifact: `${artifact}\n<!-- ima-lifecycle verification: nonce=${nonce} -->\n<!-- ima-lifecycle verification: outcome=completed -->`,
  });

  assert.equal(result.valid, true);
});

test("rejects emitted lifecycle front matter with LF and CRLF endings", () => {
  const lifecycleMarker = buildLifecycleNonceMarker({
    lifecycleKey: identity.lifecycleKey,
    nonce,
    type: "plan",
    jiraKey: identity.jiraKey,
    taskwarriorUuid: identity.taskwarriorUuid,
  });
  const emittedArtifact = buildLifecycleArtifact({ type: "plan", identity, artifact, nonce });
  const frontMatterArtifact = emittedArtifact.replace(lifecycleMarker, "");

  for (const candidate of [frontMatterArtifact, frontMatterArtifact.replaceAll("\n", "\r\n")]) {
    const result = validateLifecycleRequest({ type: "plan", identity, artifact: candidate });
    assert.equal(result.valid, false);
    assert.equal(result.error.code, "lifecycle_artifact_embeds_prior_artifact");
  }
});

test("allows unrelated nested YAML lifecycle_key fields", () => {
  const result = validateLifecycleRequest({
    type: "plan",
    identity,
    artifact: `${artifact}\nsettings:\n  lifecycle_key: '${identity.lifecycleKey}'`,
  });

  assert.equal(result.valid, true);
});

test("limits lifecycle error messages to registered codes", () => {
  assert.deepEqual(
    sanitizeLifecycleError("lifecycle_artifact_embeds_prior_artifact", undefined),
    {
      code: "lifecycle_artifact_embeds_prior_artifact",
      message: "Lifecycle artifact embeds a prior artifact. Reference prior IDs in prior_artifact_ids or source_refs instead of pasting content.",
    },
  );

  for (const code of ["constructor", "toString", "__proto__", "invalid_lifecycle_request", "vestige_save_failed"]) {
    assert.deepEqual(sanitizeLifecycleError(code, undefined), {
      code,
      message: `Lifecycle integration failed: ${code}.`,
    });
  }
});

test("accepts lifecycle artifacts that reference prior IDs only", () => {
  const result = validateLifecycleRequest({
    type: "plan",
    identity,
    artifact: `${artifact}\n\n## Prior artifacts\n- ${nonce}`,
  });

  assert.equal(result.valid, true);
});

test("allows discussion of lifecycle markers without a persisted nonce", () => {
  const result = validateLifecycleRequest({
    type: "plan",
    identity,
    artifact: `${artifact}\n<!-- ima-lifecycle verification: nonce=<uuid>; outcome=completed -->\nThe lifecycle_key field is discussed in prose.`,
  });

  assert.equal(result.valid, true);
});

test("allows ima-cycle outcome markers", () => {
  const result = validateLifecycleRequest({
    type: "plan",
    identity,
    artifact: `${artifact}\n<!-- ima-cycle outcome: phase=implementation; outcome=COMPLETED -->`,
  });

  assert.equal(result.valid, true);
});

test("builds labeled lifecycle metadata without inventing standalone identifiers", () => { const standaloneResult = buildLifecycleArtifact({ type: "decision", identity: standalone, artifact, nonce }); assert.match(standaloneResult, /lifecycle_root_memory_id: ''/); assert.match(standaloneResult, /taskwarrior_uuid: ''/); assert.match(standaloneResult, /jira_key: ''/); assert.match(standaloneResult, /source_refs: \[\]/); assert.match(standaloneResult, /prior_artifact_ids: \[\]/); assert.doesNotMatch(standaloneResult, /- ''/); const correlatedResult = buildLifecycleArtifact({ type: "decision", identity, artifact, nonce }); assert.match(correlatedResult, /source_refs:\n    - 'Taskwarrior:task-uuid'/); assert.match(correlatedResult, /prior_artifact_ids:\n    - 'plan'/); assert.match(buildLifecycleNonceMarker({ lifecycleKey: identity.lifecycleKey, nonce, type: "implementation", jiraKey: identity.jiraKey, taskwarriorUuid: identity.taskwarriorUuid }), /outcome=completed/); });
test("validates successful and failed MCP save receipts", () => {
  const unrelatedUuid = "abcdefab-cdef-abcd-efab-cdefabcdefab";
  const structuredReceipt = validateVestigeSaveReceipt(
    { isError: false, structuredContent: { memoryId: "stored-memory" } },
    "plan",
  );
  const textReceipt = validateVestigeSaveReceipt(
    { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, id: "text-memory" }) }] },
    "plan",
  );
  const rejectedReceipts = [
    { isError: true, structuredContent: { id: "failed-memory" } },
    { isError: false, content: [{ type: "text", text: JSON.stringify({ success: false, id: "not-stored" }) }] },
    { isError: false, structuredContent: { stored: false, id: "not-stored" } },
    { isError: false, structuredContent: { status: "error", id: "not-stored" } },
    { isError: false, structuredContent: { success: true, error: { message: "failed" } } },
    { isError: false, content: [{ type: "text", text: "artifact stored successfully" }] },
    { isError: false, content: [{ type: "text", text: `artifact stored successfully id=${unrelatedUuid}` }] },
    { isError: false, content: [{ type: "text", text: "failed: artifact was not stored" }] },
    { isError: false, content: [{ type: "text", text: "artifact could not be stored" }] },
    { isError: false, content: [{ type: "text", text: "artifact could not be successfully stored" }] },
    { isError: false, content: [{ type: "text", text: "artifact wasn't stored" }] },
    { isError: false, content: [{ type: "text", text: "artifact was not only stored successfully, but also indexed" }] },
    { isError: false, content: [{ type: "text", text: `unrelated reference ${unrelatedUuid}` }] },
    { isError: false, content: [] },
  ];

  assert.deepEqual(structuredReceipt, { accepted: true, artifactId: "stored-memory" });
  assert.deepEqual(textReceipt, { accepted: true, artifactId: "text-memory" });
  for (const receipt of rejectedReceipts) {
    assert.deepEqual(validateVestigeSaveReceipt(receipt, "plan"), {
      accepted: false,
      artifactId: null,
    });
  }
});

test("recall requires all nonempty external identities in one result", () => {
  const completed = `${identity.lifecycleKey} ${nonce} ${phaseMarker} ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed`;
  assert.equal(recall(completed).matched, true);
  assert.equal(recall(`${identity.lifecycleKey} ${nonce} ${phaseMarker} ${identity.jiraKey} outcome=completed`).matched, false);
  assert.equal(recall(`${identity.lifecycleKey} ${nonce} ${phaseMarker} ${identity.taskwarriorUuid} outcome=completed`).matched, false);

  const split = evaluateLifecycleRecall({
    envelope: {
      structuredContent: {
        results: [
          { content: identity.lifecycleKey },
          { content: `${nonce} ${phaseMarker} ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed` },
        ],
      },
    },
    lifecycleKey: identity.lifecycleKey,
    nonce,
    type: "implementation",
    jiraKey: identity.jiraKey,
    taskwarriorUuid: identity.taskwarriorUuid,
  });

  assert.equal(split.matched, false);
});

test("recall requires the authoritative completed outcome marker", () => {
  const prefix = `${identity.lifecycleKey} ${nonce} ${phaseMarker} ${identity.jiraKey} ${identity.taskwarriorUuid}`;

  for (const outcome of ["outcome=failed", "outcome=pending", "outcome"]) {
    assert.equal(recall(`${prefix} ${outcome}`).matched, false);
  }
});

test("recall requires its exact phase marker", () => {
  const content = `${identity.lifecycleKey} ${nonce} phase=review test ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed`;
  const result = evaluateLifecycleRecall({
    envelope: { structuredContent: { results: [{ content }] } },
    lifecycleKey: identity.lifecycleKey,
    nonce,
    type: "test",
    jiraKey: identity.jiraKey,
    taskwarriorUuid: identity.taskwarriorUuid,
  });

  assert.equal(result.matched, false);
  assert.equal(result.phaseMatched, false);
});

test("recall ignores error-marked MCP payloads", () => {
  const content = `${identity.lifecycleKey} ${nonce} ${phaseMarker} ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed`;
  const result = evaluateLifecycleRecall({
    envelope: { isError: true, structuredContent: { results: [{ content }] } },
    lifecycleKey: identity.lifecycleKey,
    nonce,
    type: "implementation",
    jiraKey: identity.jiraKey,
    taskwarriorUuid: identity.taskwarriorUuid,
  });

  assert.deepEqual(result, {
    matched: false,
    lifecycleKeyMatched: false,
    nonceMatched: false,
    phaseMatched: false,
    sourceIdentityMatched: false,
    outcomeMatched: false,
    physicalShapeIgnored: true,
  });
});

test("recall parses JSON text content from an MCP result", () => {
  const content = `${identity.lifecycleKey} ${nonce} ${phaseMarker} ${identity.jiraKey} ${identity.taskwarriorUuid} outcome=completed`;
  const result = evaluateLifecycleRecall({
    envelope: {
      content: [{ type: "text", text: JSON.stringify({ results: [{ content }] }) }],
    },
    lifecycleKey: identity.lifecycleKey,
    nonce,
    type: "implementation",
    jiraKey: identity.jiraKey,
    taskwarriorUuid: identity.taskwarriorUuid,
  });

  assert.equal(result.matched, true);
});
test("recall supports lifecycle-key-only, Jira-only, and Taskwarrior-only identities", () => { const base = `${identity.lifecycleKey} ${nonce} ${phaseMarker} outcome=completed`; assert.equal(recall(base, { jiraKey: "", taskwarriorUuid: "" }).matched, true); assert.equal(recall(`${base} ${identity.jiraKey}`, { taskwarriorUuid: "" }).matched, true); assert.equal(recall(`${base} ${identity.taskwarriorUuid}`, { jiraKey: "" }).matched, true); });
test("derivation reports save-success recall failure without inferring IDs", () => { const result = deriveLifecycleResult({ type: "plan", lifecycleKey: identity.lifecycleKey, receipt: { accepted: true, artifactId: "receipt-id" }, recall: { matched: false, lifecycleKeyMatched: false, nonceMatched: false, phaseMatched: false, sourceIdentityMatched: false, outcomeMatched: false, physicalShapeIgnored: true } }); assert.equal(result.status, "failed"); assert.equal(result.artifactId, "receipt-id"); });
