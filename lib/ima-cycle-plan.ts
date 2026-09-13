import { parseDocument } from "yaml";
import {
  IMA_PROJECT,
  buildCycleOutcomeMarker,
  lifecycleTypeForPhase,
  parseLifecycleSearchRecords,
  resolvePhaseOutcome,
  type CyclePhase,
  type CycleSource,
  type LifecycleSearchSelection,
} from "./ima-cycle.ts";
import {
  normalizeLifecycleIdentity,
  normalizeLifecycleRecordKey,
  type LifecycleIdentity,
} from "./ima-lifecycle.ts";

export const PLAN_RECALL_LIMIT = 20;

export type PlanApprovalReference = {
  version: 1;
  kind: "legacy-plan-confirmation";
  artifactId: string;
  recordKey: string;
  contentHash: string;
};

export type VerifiedPlanRecord = {
  artifactId: string;
  recordKey: string;
  contentHash: string;
  createdAt: string;
  artifact: string;
  detail: string;
  identity: LifecycleIdentity;
  outcome: "APPROVED" | "BLOCKED" | "LEGACY";
  marker: string | null;
  approvalReference: PlanApprovalReference | null;
};

export type ReusablePlanSelection =
  | { kind: "no-plan" }
  | { kind: "confirmation-required"; plan: VerifiedPlanRecord }
  | { kind: "approved"; approval: VerifiedPlanRecord; contract: VerifiedPlanRecord }
  | { kind: "blocked"; code: string };

type PlanSelectionContext = {
  lifecycleKey: string;
  source: CycleSource;
};

type LifecycleMetadata = {
  identity: LifecycleIdentity;
  phase: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const MAX_PLAN_DETAIL_BYTES = 160_000;
const MAX_FRONTMATTER_LENGTH = 16_384;
const PLAN_APPROVAL_MARKER = /<!--\s*ima-plan-approval:\s*([^\r\n]*?)\s*-->/g;
const ANY_CYCLE_MARKER = /<!--\s*ima-cycle outcome:/;
const LIFECYCLE_KEYS = new Set([
  "project",
  "lifecycle_key",
  "lifecycle_root_memory_id",
  "taskwarrior_project",
  "taskwarrior_task",
  "taskwarrior_uuid",
  "jira_key",
  "plane_workspace",
  "plane_work_item",
  "source_refs",
  "phase",
  "prior_artifact_ids",
]);
const LIFECYCLE_RECORD_KEYS = new Set([
  "id",
  "recordKey",
  "project",
  "site",
  "repo",
  "lifecycleKey",
  "phase",
  "summary",
  "sourceRefs",
  "contentHash",
  "createdAt",
  "content",
]);

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const exactText = (value: unknown, maximum: number) =>
  typeof value === "string"
  && value.length > 0
  && value.length <= maximum
  && value.trim() === value
  && !UNSAFE_CONTROL.test(value)
    ? value
    : null;

const exactRecordKey = (value: unknown) => {
  const normalized = normalizeLifecycleRecordKey(value);
  return normalized && value === normalized ? normalized : null;
};

const exactTimestamp = (value: unknown) => {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) return null;
  return value;
};

const exactStringList = (value: unknown, maximum: number) => {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const values = value.map((entry) => exactText(entry, 1_024));
  return values.some((entry) => entry === null) ? null : values as string[];
};

const sameStringSet = (left: readonly string[], right: readonly string[]) => {
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.length === orderedRight.length
    && orderedLeft.every((value, index) => value === orderedRight[index]);
};

const lifecycleSelection = (context: PlanSelectionContext): LifecycleSearchSelection => ({
  lifecycleKey: context.lifecycleKey,
  phase: "plan",
  jiraKey: context.source.type === "jira" ? context.source.key : "",
  taskwarriorUuid: context.source.type === "taskwarrior" ? context.source.uuid : "",
  planeWorkspace: context.source.type === "plane" ? context.source.workspace : "",
  planeWorkItem: context.source.type === "plane"
    ? `${context.source.project}-${context.source.sequenceId}`
    : "",
});

const expectedSourceIdentity = (identity: LifecycleIdentity, source: CycleSource) => {
  if (identity.project !== IMA_PROJECT) return false;
  if (source.type === "jira") {
    return identity.jiraKey === source.key
      && identity.taskwarriorProject === ""
      && identity.taskwarriorTask === ""
      && identity.taskwarriorUuid === ""
      && !("planeWorkspace" in identity);
  }
  if (source.type === "taskwarrior") {
    return identity.jiraKey === ""
      && identity.taskwarriorProject === source.project
      && identity.taskwarriorTask === source.uuid
      && identity.taskwarriorUuid === source.uuid
      && !("planeWorkspace" in identity);
  }
  return identity.jiraKey === ""
    && identity.taskwarriorProject === ""
    && identity.taskwarriorTask === ""
    && identity.taskwarriorUuid === ""
    && identity.planeWorkspace === source.workspace
    && identity.planeWorkItem === `${source.project}-${source.sequenceId}`;
};

const leadingFrontmatter = (detail: string) => {
  if (!detail.startsWith("---\n") || Buffer.byteLength(detail, "utf8") > MAX_PLAN_DETAIL_BYTES) return null;
  const end = detail.indexOf("\n---", 3);
  if (end < 3 || end > MAX_FRONTMATTER_LENGTH || detail.slice(end, end + 5) !== "\n---\n") return null;
  return detail.slice(4, end);
};

const lifecycleMetadata = (detail: string, expectedPhase?: string): LifecycleMetadata | null => {
  const frontmatter = leadingFrontmatter(detail);
  if (frontmatter === null || UNSAFE_CONTROL.test(detail)) return null;

  try {
    const document = parseDocument(frontmatter, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length || document.warnings.length) return null;
    const root = object(document.toJS({ maxAliasCount: 0 }));
    if (!root || Object.keys(root).length !== 1 || !("lifecycle" in root)) return null;
    const lifecycle = object(root.lifecycle);
    if (!lifecycle || Object.keys(lifecycle).some((key) => !LIFECYCLE_KEYS.has(key))) return null;
    if (typeof lifecycle.phase !== "string" || !lifecycle.phase || expectedPhase && lifecycle.phase !== expectedPhase) return null;

    const hasPlaneWorkspace = Object.hasOwn(lifecycle, "plane_workspace");
    const hasPlaneWorkItem = Object.hasOwn(lifecycle, "plane_work_item");
    if (hasPlaneWorkspace !== hasPlaneWorkItem) return null;

    const identityInput = {
      project: lifecycle.project,
      lifecycleKey: lifecycle.lifecycle_key,
      lifecycleRootMemoryId: lifecycle.lifecycle_root_memory_id,
      taskwarriorProject: lifecycle.taskwarrior_project,
      taskwarriorTask: lifecycle.taskwarrior_task,
      taskwarriorUuid: lifecycle.taskwarrior_uuid,
      jiraKey: lifecycle.jira_key,
      sourceRefs: lifecycle.source_refs,
      priorArtifactIds: lifecycle.prior_artifact_ids,
      ...(hasPlaneWorkspace
        ? {
          planeWorkspace: lifecycle.plane_workspace,
          planeWorkItem: lifecycle.plane_work_item,
        }
        : {}),
    };
    const identity = normalizeLifecycleIdentity(identityInput);
    return identity ? { identity, phase: lifecycle.phase } : null;
  } catch {
    return null;
  }
};

const approvalReference = (artifact: string): PlanApprovalReference | "invalid" | null => {
  const markers = [...artifact.matchAll(PLAN_APPROVAL_MARKER)];
  if (markers.length === 0) return null;
  if (markers.length !== 1) return "invalid";

  try {
    const value = object(JSON.parse(markers[0][1]));
    if (!value || Object.keys(value).length !== 5) return "invalid";
    if (
      value.version !== 1
      || value.kind !== "legacy-plan-confirmation"
      || typeof value.artifactId !== "string"
      || !UUID.test(value.artifactId)
      || !exactRecordKey(value.recordKey)
      || typeof value.contentHash !== "string"
      || !HASH.test(value.contentHash)
    ) return "invalid";
    const reference: PlanApprovalReference = {
      version: 1,
      kind: "legacy-plan-confirmation",
      artifactId: value.artifactId.toLowerCase(),
      recordKey: value.recordKey,
      contentHash: value.contentHash.toLowerCase(),
    };
    return JSON.stringify(reference) === markers[0][1] ? reference : "invalid";
  } catch {
    return "invalid";
  }
};

const artifactOutcome = (artifact: string): {
  outcome: "APPROVED" | "BLOCKED" | "LEGACY";
  marker: string | null;
  approvalReference: PlanApprovalReference | null;
} | null => {
  const reference = approvalReference(artifact);
  if (reference === "invalid") return null;

  const outcome = resolvePhaseOutcome(artifact, "plan");
  if (outcome.ok) {
    if (outcome.outcome === "APPROVED") {
      return { outcome: "APPROVED", marker: outcome.marker, approvalReference: reference };
    }
    return reference === null
      ? { outcome: "BLOCKED", marker: outcome.marker, approvalReference: null }
      : null;
  }

  if (outcome.error.code !== "phase_marker_missing" || ANY_CYCLE_MARKER.test(artifact) || reference !== null) return null;
  return { outcome: "LEGACY", marker: null, approvalReference: null };
};

export const validatePlanRecord = (
  value: unknown,
  context: PlanSelectionContext,
): { valid: true; record: VerifiedPlanRecord } | { valid: false; code: string } => {
  const raw = object(value);
  if (!raw || Object.keys(raw).some((key) => !LIFECYCLE_RECORD_KEYS.has(key))) {
    return { valid: false, code: "plan_record_invalid" };
  }

  const artifactId = typeof raw.id === "string" && UUID.test(raw.id) ? raw.id.toLowerCase() : null;
  const recordKey = exactRecordKey(raw.recordKey);
  const project = exactText(raw.project, 256);
  const lifecycleKey = exactText(raw.lifecycleKey, 512);
  const phase = raw.phase === "plan" ? raw.phase : null;
  const sourceRefs = exactStringList(raw.sourceRefs, 64);
  const contentHash = typeof raw.contentHash === "string" && HASH.test(raw.contentHash)
    ? raw.contentHash.toLowerCase()
    : null;
  const createdAt = exactTimestamp(raw.createdAt);
  const detail = typeof raw.content === "string" && raw.content.length > 0 ? raw.content : null;
  if (!artifactId || !recordKey || !project || !lifecycleKey || !phase || !sourceRefs || !contentHash || !createdAt || !detail) {
    return { valid: false, code: "plan_record_invalid" };
  }

  const metadata = lifecycleMetadata(detail, "plan");
  if (
    !metadata
    || project !== IMA_PROJECT
    || lifecycleKey !== context.lifecycleKey
    || metadata.identity.project !== project
    || metadata.identity.lifecycleKey !== lifecycleKey
    || metadata.phase !== phase
    || !sameStringSet(metadata.identity.sourceRefs, sourceRefs)
    || !expectedSourceIdentity(metadata.identity, context.source)
  ) return { valid: false, code: "plan_identity_invalid" };

  const parsed = parseLifecycleSearchRecords({ results: [{ id: artifactId, recordKey, content: detail }] }, lifecycleSelection(context));
  const parsedRecord = parsed.valid && parsed.records.length === 1 ? parsed.records[0] : null;
  if (
    !parsedRecord
    || parsedRecord.verified !== true
    || parsedRecord.artifactId !== artifactId
    || parsedRecord.recordKey !== recordKey
  ) return { valid: false, code: "plan_lifecycle_unverified" };

  const classified = artifactOutcome(parsedRecord.artifact);
  if (!classified) return { valid: false, code: "plan_outcome_invalid" };
  return {
    valid: true,
    record: {
      artifactId,
      recordKey,
      contentHash,
      createdAt,
      artifact: parsedRecord.artifact,
      detail,
      identity: metadata.identity,
      ...classified,
    },
  };
};

export type ImportedPlanLineage = {
  approvalArtifactId: string;
  approvedAt: string;
};

export type ImportedPlanLineageResult =
  | { valid: true; payload: { results: unknown[] } }
  | { valid: false; code: string };

const lineagedRecord = (
  value: unknown,
  context: PlanSelectionContext,
  phase: CyclePhase,
): { createdAt: string; identity: LifecycleIdentity } | null => {
  const raw = object(value);
  if (!raw || Object.keys(raw).some((key) => !LIFECYCLE_RECORD_KEYS.has(key))) return null;
  const artifactId = typeof raw.id === "string" && UUID.test(raw.id) ? raw.id : null;
  const recordKey = exactRecordKey(raw.recordKey);
  const project = exactText(raw.project, 256);
  const lifecycleKey = exactText(raw.lifecycleKey, 512);
  const expectedPhase = lifecycleTypeForPhase(phase);
  const sourceRefs = exactStringList(raw.sourceRefs, 64);
  const contentHash = typeof raw.contentHash === "string" && HASH.test(raw.contentHash);
  const createdAt = exactTimestamp(raw.createdAt);
  const detail = typeof raw.content === "string" && raw.content.length > 0 ? raw.content : null;
  if (!artifactId || !recordKey || !project || lifecycleKey !== context.lifecycleKey || raw.phase !== expectedPhase || !sourceRefs || !contentHash || !createdAt || !detail) return null;
  const metadata = lifecycleMetadata(detail, expectedPhase);
  return metadata
    && metadata.identity.project === project
    && metadata.identity.lifecycleKey === lifecycleKey
    && sameStringSet(metadata.identity.sourceRefs, sourceRefs)
    && expectedSourceIdentity(metadata.identity, context.source)
    ? { createdAt, identity: metadata.identity }
    : null;
};

export const filterImportedPlanLineage = (
  value: unknown,
  context: PlanSelectionContext & { phase: CyclePhase; lineage: ImportedPlanLineage },
): ImportedPlanLineageResult => {
  const records = recordList(value);
  if (!records || records.length >= PLAN_RECALL_LIMIT) return { valid: false, code: "plan_lineage_recall_invalid" };
  const approvalAt = exactTimestamp(context.lineage.approvedAt);
  if (!UUID.test(context.lineage.approvalArtifactId) || !approvalAt) return { valid: false, code: "plan_lineage_invalid" };

  const filtered: unknown[] = [];
  for (const record of records) {
    if (context.phase === "document") {
      filtered.push(record);
      continue;
    }
    const metadata = lineagedRecord(record, context, context.phase);
    if (!metadata) return { valid: false, code: "plan_lineage_invalid" };
    if (Date.parse(metadata.createdAt) < Date.parse(approvalAt)) continue;
    if (!metadata.identity.priorArtifactIds.includes(context.lineage.approvalArtifactId)) {
      return { valid: false, code: "plan_lineage_unbound" };
    }
    filtered.push(record);
  }
  return { valid: true, payload: { results: filtered } };
};

const recordList = (value: unknown): unknown[] | null => {
  const payload = object(value);
  return payload && Array.isArray(payload.results) ? payload.results : null;
};

const newestRecord = (records: readonly VerifiedPlanRecord[]) => {
  const ordered = [...records].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (ordered.length > 1 && Date.parse(ordered[0].createdAt) === Date.parse(ordered[1].createdAt)) return null;
  return ordered[0] ?? null;
};

const matchesReference = (record: VerifiedPlanRecord, reference: PlanApprovalReference) =>
  record.artifactId === reference.artifactId
  && record.recordKey === reference.recordKey
  && record.contentHash === reference.contentHash;

export const selectReusablePlan = (
  value: unknown,
  context: PlanSelectionContext,
): ReusablePlanSelection => {
  const rawRecords = recordList(value);
  if (!rawRecords) return { kind: "blocked", code: "plan_recall_invalid" };
  if (rawRecords.length >= PLAN_RECALL_LIMIT) return { kind: "blocked", code: "plan_history_saturated" };
  if (rawRecords.length === 0) return { kind: "no-plan" };

  const parsed = rawRecords.map((record) => validatePlanRecord(record, context));
  const invalid = parsed.find((result) => !result.valid);
  if (invalid && !invalid.valid) return { kind: "blocked", code: invalid.code };
  const records = parsed.map((result) => (result as { valid: true; record: VerifiedPlanRecord }).record);
  const newest = newestRecord(records);
  if (!newest) return { kind: "blocked", code: "plan_selection_ambiguous" };
  if (newest.outcome === "BLOCKED") return { kind: "blocked", code: "plan_latest_blocked" };
  if (newest.outcome === "LEGACY") return { kind: "confirmation-required", plan: newest };

  if (newest.approvalReference === null) {
    return { kind: "approved", approval: newest, contract: newest };
  }

  const referenced = records.filter((record) => matchesReference(record, newest.approvalReference!));
  if (
    referenced.length !== 1
    || referenced[0].outcome !== "LEGACY"
    || referenced[0].approvalReference !== null
    || !newest.identity.priorArtifactIds.includes(referenced[0].artifactId)
    || !newest.identity.sourceRefs.includes(`QdrantRecordKey:${referenced[0].recordKey}`)
  ) return { kind: "blocked", code: "plan_approval_reference_invalid" };
  return { kind: "approved", approval: newest, contract: referenced[0] };
};

export const buildLegacyPlanApproval = (plan: VerifiedPlanRecord) => {
  if (plan.outcome !== "LEGACY" || plan.approvalReference !== null) return null;
  const reference: PlanApprovalReference = {
    version: 1,
    kind: "legacy-plan-confirmation",
    artifactId: plan.artifactId,
    recordKey: plan.recordKey,
    contentHash: plan.contentHash,
  };
  const serializedReference = JSON.stringify(reference);
  const artifact = [
    "# Manual Plan Approval",
    "",
    "The referenced manual plan was explicitly confirmed for cycle execution.",
    "",
    `<!-- ima-plan-approval: ${serializedReference} -->`,
    buildCycleOutcomeMarker({ phase: "plan", outcome: "APPROVED" }),
  ].join("\n");
  return {
    reference,
    artifact,
    summary: `APPROVED: confirmed legacy manual plan ${plan.recordKey} for cycle reuse.`,
  };
};
