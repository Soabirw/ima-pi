import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLegacyPlanApproval,
  filterImportedPlanLineage,
  selectReusablePlan,
  validatePlanRecord,
} from "../lib/ima-cycle-plan.ts";
import { adoptedPlanState } from "../lib/ima-cycle-plan-adoption.ts";
import { buildCycleOutcomeMarker, buildResumeSource, createCycleState } from "../lib/ima-cycle.ts";
import {
  buildLifecycleArtifact,
  prepareLifecycleArtifact,
  validateLifecycleWriteRequest,
} from "../lib/ima-lifecycle.ts";
import {
  createMarkdownLifecycleRecord,
  markdownLifecycleReferenceFor,
} from "../lib/markdown-lifecycle-record.ts";
import {
  contentHash,
  lifecycleKey,
  planArtifact,
  planContext,
  planIdentity,
  planRecord,
  planeSource,
  recordKey,
  recallPayload,
  uuid,
} from "./cycle-plan-fixtures.js";

const select = (records) => selectReusablePlan(recallPayload(records), planContext);

const legacy = (overrides = {}) => planRecord({ artifact: planArtifact(), ...overrides });

test("selects a newest direct approved manual plan and records its contract metadata", () => {
  const direct = planRecord();
  const selected = select([direct]);
  assert.equal(selected.kind, "approved");
  if (selected.kind !== "approved") return;
  assert.equal(selected.approval.artifactId, direct.id);
  assert.equal(selected.contract.recordKey, direct.recordKey);

  const state = createCycleState(planContext.source, { lifecycleKey, timestamp: "2026-09-08T01:00:00.000Z" });
  const adopted = adoptedPlanState(state, selected, {
    allowAwaitingEvidence: true,
    timestamp: "2026-09-08T01:01:00.000Z",
  });
  assert.equal(adopted.ok, true);
  if (!adopted.ok) return;
  assert.deepEqual({ phase: adopted.state.phase, status: adopted.state.status }, {
    phase: "implementation",
    status: "awaiting-resume",
  });
  assert.deepEqual(adopted.state.evidence.at(-1).approvedPlan, {
    artifactId: direct.id,
    recordKey: direct.recordKey,
    contentHash: direct.contentHash,
    approvedAt: direct.createdAt,
  });
  const packet = buildResumeSource(adopted.state);
  assert.match(packet, new RegExp(`approvedPlanArtifactId: ${direct.id}`));
  assert.match(packet, new RegExp(`approvedPlanRecordKey: ${direct.recordKey}`));
});

test("refuses manual plan adoption for execution-owned planning", () => {
  const direct = planRecord({ id: uuid(40), key: recordKey("execution-owned") });
  const selected = select([direct]);
  assert.equal(selected.kind, "approved");
  if (selected.kind !== "approved") return;
  const executionOwned = {
    ...createCycleState(planContext.source, { lifecycleKey, timestamp: "2026-09-08T01:00:00.000Z" }),
    status: "awaiting-resume",
    execution: {
      schemaVersion: 1,
      dispatchId: "plan-dispatch",
      phase: "plan",
      route: {
        provider: "test-provider",
        model: "test-model",
        thinking: "high",
        profile: "cycle-profile",
        source: "command",
      },
      parentSessionId: "parent-session",
      childSessionId: "child-session",
      childSessionFile: "/sessions/child-session.jsonl",
      childSessionDir: "/sessions",
      status: "failed",
      possiblePartialWrite: false,
      startedAt: "2026-09-08T01:00:00.000Z",
      updatedAt: "2026-09-08T01:00:00.000Z",
    },
  };

  assert.deepEqual(adoptedPlanState(executionOwned, selected), {
    ok: false,
    code: "plan_adoption_unavailable",
  });
});

test("validates direct manual plans for Jira, Taskwarrior, and Plane identities", () => {
  const taskUuid = uuid(16);
  const cases = [
    {
      source: { type: "jira", key: "FNR-3036", url: "https://flccc.atlassian.net/browse/FNR-3036" },
      identity: {
        project: "ima-pi",
        lifecycleKey: "ima-pi:jira:FNR-3036",
        lifecycleRootMemoryId: "",
        taskwarriorProject: "",
        taskwarriorTask: "",
        taskwarriorUuid: "",
        jiraKey: "FNR-3036",
        sourceRefs: ["Jira:FNR-3036"],
        priorArtifactIds: [],
      },
    },
    {
      source: { type: "taskwarrior", project: "FNR-3007", uuid: taskUuid },
      identity: {
        project: "ima-pi",
        lifecycleKey: `ima-pi:taskwarrior:FNR-3007:${taskUuid}`,
        lifecycleRootMemoryId: "",
        taskwarriorProject: "FNR-3007",
        taskwarriorTask: taskUuid,
        taskwarriorUuid: taskUuid,
        jiraKey: "",
        sourceRefs: [`Taskwarrior:FNR-3007:${taskUuid}`],
        priorArtifactIds: [],
      },
    },
    { source: planeSource, identity: planIdentity() },
  ];
  for (const [index, entry] of cases.entries()) {
    const key = `${entry.identity.lifecycleKey}:plan:identity-${index}`;
    const record = {
      id: uuid(30 + index),
      recordKey: key,
      project: "ima-pi",
      lifecycleKey: entry.identity.lifecycleKey,
      phase: "plan",
      sourceRefs: entry.identity.sourceRefs,
      contentHash: contentHash(key),
      createdAt: `2026-09-08T00:0${index}:00.000Z`,
      content: buildLifecycleArtifact({
        type: "plan",
        identity: entry.identity,
        artifact: `# Plan\n\n${buildCycleOutcomeMarker({ phase: "plan", outcome: "APPROVED" })}`,
        nonce: `01234567-89ab-4def-8abc-0123456789a${index}`,
      }),
    };
    const selection = selectReusablePlan({ results: [record] }, {
      lifecycleKey: entry.identity.lifecycleKey,
      source: entry.source,
    });
    assert.equal(selection.kind, "approved");
  }
});

test("uses the newest plan outcome and refuses stale approval after a newer block", () => {
  const approved = planRecord({
    id: uuid(2),
    key: recordKey("approved"),
    createdAt: "2026-09-08T00:00:00.000Z",
  });
  const blocked = planRecord({
    id: uuid(3),
    key: recordKey("blocked"),
    createdAt: "2026-09-08T00:01:00.000Z",
    artifact: planArtifact("BLOCKED"),
  });
  assert.deepEqual(select([approved, blocked]), {
    kind: "blocked",
    code: "plan_latest_blocked",
  });
});

test("requires confirmation for a marker-free legacy plan and resolves a one-hop approval wrapper", () => {
  const original = legacy({ id: uuid(4), key: recordKey("legacy") });
  const initial = select([original]);
  assert.equal(initial.kind, "confirmation-required");
  if (initial.kind !== "confirmation-required") return;

  const approval = buildLegacyPlanApproval(initial.plan);
  assert.ok(approval);
  const approvalIdentity = planIdentity({
    lifecycleRootMemoryId: original.id,
    priorArtifactIds: [original.id],
  });
  const wrapper = planRecord({
    id: uuid(5),
    key: recordKey("legacy-approval"),
    createdAt: "2026-09-08T00:01:00.000Z",
    artifact: approval.artifact,
    identity: approvalIdentity,
  });
  const selected = select([original, wrapper]);
  assert.equal(selected.kind, "approved");
  if (selected.kind !== "approved") return;
  assert.equal(selected.approval.recordKey, wrapper.recordKey);
  assert.equal(selected.contract.recordKey, original.recordKey);

  const changedSource = planRecord({
    id: uuid(55),
    key: recordKey("legacy-changed-source"),
    createdAt: "2026-09-08T00:02:00.000Z",
    artifact: approval.artifact,
    identity: planIdentity({
      lifecycleRootMemoryId: original.id,
      sourceRefs: ["plane:ima:SKYNET-189", "QdrantRecordKey:forbidden-annotation"],
      priorArtifactIds: [original.id],
    }),
  });
  assert.deepEqual(select([original, changedSource]), {
    kind: "blocked",
    code: "plan_approval_reference_invalid",
  });
});

test("rejects confirmation wrappers that point to a direct approval or an altered contract", () => {
  const direct = planRecord({ id: uuid(6), key: recordKey("direct") });
  const reference = {
    version: 1,
    kind: "legacy-plan-confirmation",
    artifactId: direct.id,
    recordKey: direct.recordKey,
    contentHash: direct.contentHash,
  };
  const wrapper = planRecord({
    id: uuid(7),
    key: recordKey("invalid-wrapper"),
    createdAt: "2026-09-08T00:01:00.000Z",
    artifact: [
      "# Manual Plan Approval",
      "",
      `<!-- ima-plan-approval: ${JSON.stringify(reference)} -->`,
      "<!-- ima-cycle outcome: phase=plan; outcome=APPROVED -->",
    ].join("\n"),
  });
  assert.deepEqual(select([direct, wrapper]), {
    kind: "blocked",
    code: "plan_approval_reference_invalid",
  });

  const legacyPlan = legacy({ id: uuid(8), key: recordKey("legacy-contract") });
  const legacySelection = select([legacyPlan]);
  assert.equal(legacySelection.kind, "confirmation-required");
  if (legacySelection.kind !== "confirmation-required") return;
  const approval = buildLegacyPlanApproval(legacySelection.plan);
  const alteredReference = approval.artifact.replace(legacyPlan.contentHash, contentHash("different"));
  const altered = planRecord({
    id: uuid(9),
    key: recordKey("altered-wrapper"),
    createdAt: "2026-09-08T00:01:00.000Z",
    artifact: alteredReference,
  });
  assert.deepEqual(select([legacyPlan, altered]), {
    kind: "blocked",
    code: "plan_approval_reference_invalid",
  });

  const duplicateReference = `{"version":1,"kind":"legacy-plan-confirmation","artifactId":"${legacyPlan.id}","recordKey":"${legacyPlan.recordKey}","contentHash":"${legacyPlan.contentHash}","contentHash":"${legacyPlan.contentHash}"}`;
  const duplicateWrapper = planRecord({
    id: uuid(90),
    key: recordKey("duplicate-wrapper"),
    createdAt: "2026-09-08T00:02:00.000Z",
    artifact: [
      "# Manual Plan Approval",
      "",
      `<!-- ima-plan-approval: ${duplicateReference} -->`,
      "<!-- ima-cycle outcome: phase=plan; outcome=APPROVED -->",
    ].join("\n"),
    identity: planIdentity({
      lifecycleRootMemoryId: legacyPlan.id,
      priorArtifactIds: [legacyPlan.id],
    }),
  });
  assert.deepEqual(select([legacyPlan, duplicateWrapper]), {
    kind: "blocked",
    code: "plan_outcome_invalid",
  });
});

test("fails closed on tied, saturated, malformed, and unsafe plan evidence", () => {
  const tiedLeft = planRecord({ id: uuid(10), key: recordKey("tie-left") });
  const tiedRight = planRecord({ id: uuid(11), key: recordKey("tie-right") });
  assert.deepEqual(select([tiedLeft, tiedRight]), {
    kind: "blocked",
    code: "plan_selection_ambiguous",
  });

  const saturated = Array.from({ length: 20 }, (_, index) => planRecord({
    id: uuid(100 + index),
    key: recordKey(`saturated-${index}`),
    createdAt: `2026-09-08T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  assert.deepEqual(select(saturated), {
    kind: "blocked",
    code: "plan_history_saturated",
  });

  const malformed = planRecord({ id: uuid(12), key: recordKey("malformed") });
  malformed.content = malformed.content.replace("project: 'ima-pi'", "project: 'other-project'");
  assert.deepEqual(select([malformed]), {
    kind: "blocked",
    code: "plan_identity_invalid",
  });

  const unsafe = planRecord({ id: uuid(13), key: recordKey("unsafe") });
  unsafe.content = unsafe.content.replace("# Plan", "# Plan\u001b[2J");
  assert.deepEqual(select([unsafe]), {
    kind: "blocked",
    code: "plan_identity_invalid",
  });

  const aliases = planRecord({ id: uuid(14), key: recordKey("aliases") });
  aliases.content = aliases.content
    .replace("source_refs:\n", "source_refs: &source_refs\n")
    .replace("prior_artifact_ids: []", "prior_artifact_ids: *source_refs");
  assert.deepEqual(select([aliases]), {
    kind: "blocked",
    code: "plan_identity_invalid",
  });

  const duplicate = planRecord({ id: uuid(140), key: recordKey("duplicate") });
  duplicate.content = duplicate.content.replace(
    "  project: 'ima-pi'\n",
    "  project: 'ima-pi'\n  project: 'ima-pi'\n",
  );
  assert.deepEqual(select([duplicate]), {
    kind: "blocked",
    code: "plan_identity_invalid",
  });
});

test("rejects equal parsed newest instants and saturated imported lineage before filtering", () => {
  const approval = planRecord({ id: uuid(150), key: recordKey("lineage-approval"), createdAt: "2026-09-08T00:01:00.000Z" });
  const equalApproved = planRecord({
    id: uuid(151),
    key: recordKey("equal-approved"),
    createdAt: "2026-09-08T00:02:00Z",
  });
  const equalBlocked = planRecord({
    id: uuid(152),
    key: recordKey("equal-blocked"),
    createdAt: "2026-09-08T00:02:00.000Z",
    artifact: planArtifact("BLOCKED"),
  });
  for (const records of [[equalApproved, equalBlocked], [equalBlocked, equalApproved]]) {
    assert.deepEqual(select(records), {
      kind: "blocked",
      code: "plan_selection_ambiguous",
    });
  }
  const later = planRecord({
    id: uuid(153),
    key: recordKey("later-approved"),
    createdAt: "2026-09-08T00:02:00.001Z",
  });
  assert.equal(select([equalApproved, later]).kind, "approved");

  const downstream = (number, createdAt) => {
    const key = `${lifecycleKey}:implementation:lineage-${number}`;
    return {
      id: uuid(200 + number),
      recordKey: key,
      project: "ima-pi",
      lifecycleKey,
      phase: "implementation",
      sourceRefs: ["plane:ima:SKYNET-189"],
      contentHash: contentHash(key),
      createdAt,
      content: buildLifecycleArtifact({
        type: "implementation",
        identity: planIdentity({ priorArtifactIds: [approval.id] }),
        artifact: "# Implementation",
        nonce: uuid(300 + number),
      }),
    };
  };
  const context = {
    lifecycleKey,
    source: planeSource,
    phase: "implementation",
    lineage: { approvalArtifactId: approval.id, approvedAt: approval.createdAt },
  };
  const valid = filterImportedPlanLineage(recallPayload(Array.from({ length: 19 }, (_, index) => downstream(index, "2026-09-08T00:03:00.000Z"))), context);
  assert.equal(valid.valid, true);
  if (valid.valid) assert.equal(valid.payload.results.length, 19);
  for (const createdAt of ["2026-09-08T00:03:00.000Z", "2026-09-08T00:00:00.000Z"]) {
    assert.deepEqual(filterImportedPlanLineage(
      recallPayload(Array.from({ length: 20 }, (_, index) => downstream(20 + index, createdAt))),
      context,
    ), { valid: false, code: "plan_lineage_recall_invalid" });
  }
});

test("validates exact metadata and does not normalize unsafe imported plan references", () => {
  const record = planRecord({ id: uuid(15), key: recordKey("validate") });
  assert.equal(validatePlanRecord(record, planContext).valid, true);
  const badTimestamp = { ...record, createdAt: "2026-09-08T00:00:00Z " };
  assert.deepEqual(validatePlanRecord(badTimestamp, planContext), {
    valid: false,
    code: "plan_record_invalid",
  });
  const extraField = { ...record, injected: true };
  assert.deepEqual(validatePlanRecord(extraField, planContext), {
    valid: false,
    code: "plan_record_invalid",
  });
});

const markdownPlan = (artifact) => {
  const request = validateLifecycleWriteRequest({
    type: "plan",
    identity: planIdentity(),
    summary: "Approved Markdown plan must retain its exact local receipt reference.",
    artifact,
  });
  assert.equal(request.valid, true);
  if (!request.valid) throw new Error("fixture request is invalid");
  const prepared = prepareLifecycleArtifact(request);
  assert.equal(prepared.valid, true);
  if (!prepared.valid) throw new Error("fixture artifact is invalid");
  const record = createMarkdownLifecycleRecord({
    schemaVersion: 1,
    phase: request.type,
    identity: request.identity,
    summary: request.summary,
    artifact: prepared.data.artifact,
    expectedHash: contentHash(prepared.data.artifact),
  });
  assert.equal(record.valid, true);
  if (!record.valid) throw new Error("fixture Markdown record is invalid");
  const reference = markdownLifecycleReferenceFor({
    checkoutRoot: "/workspace/ima-pi",
    record: record.data,
  });
  assert.ok(reference);
  return {
    id: record.data.artifactId,
    recordKey: prepared.data.recordKey,
    lifecycleKey,
    phase: "plan",
    summary: request.summary,
    content: record.data.artifact,
    detail: record.data.artifact,
    contentHash: record.data.contentHash,
    provider: "markdown",
    reference,
  };
};

test("requires exact Markdown references and explicit selection when local plan order is unknowable", () => {
  const first = markdownPlan(`${planArtifact("APPROVED")}\n\nFirst local plan.`);
  const second = markdownPlan(`${planArtifact("APPROVED")}\n\nSecond local plan.`);
  const selected = selectReusablePlan(recallPayload([first, second]), planContext);

  assert.equal(selected.kind, "selection-required");
  if (selected.kind !== "selection-required") return;
  assert.deepEqual(selected.plans.map((plan) => plan.recordKey), [first.recordKey, second.recordKey]);
  assert.equal(selected.plans.every((plan) => plan.provider === "markdown"), true);
  assert.equal(selected.plans.every((plan) => plan.reference !== null), true);

  const escaped = {
    ...first,
    reference: { ...first.reference, checkoutRoot: "/workspace/ima-pi/../outside" },
  };
  assert.deepEqual(validatePlanRecord(escaped, planContext), {
    valid: false,
    code: "plan_record_invalid",
  });
});
