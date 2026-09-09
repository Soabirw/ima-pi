import {
  normalizeLifecycleIdentity,
  normalizeLifecycleRecordKey,
  type LifecycleIdentity,
} from "./ima-lifecycle.ts";
import {
  buildLegacyPlanApproval,
  selectReusablePlan,
  type ReusablePlanSelection,
  type VerifiedPlanRecord,
} from "./ima-cycle-plan.ts";
import {
  reduceCycleState,
  validateCycleState,
  type CycleState,
} from "./ima-cycle.ts";

export type PlanApprovalPersistenceRequest = {
  type: "plan";
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
};

export type PlanAdoptionResult =
  | { kind: "no-plan" }
  | { kind: "confirmation-required"; plan: VerifiedPlanRecord }
  | { kind: "cancelled" }
  | { kind: "approved"; approval: VerifiedPlanRecord; contract: VerifiedPlanRecord }
  | { kind: "blocked"; code: string };

export type PlanAdoptionStateResult =
  | { ok: true; state: CycleState }
  | { ok: false; code: string };

export type CyclePlanAdoptionInput = {
  state: CycleState;
  recall: (query: string) => Promise<Record<string, unknown> | null>;
  interactive: boolean;
  confirm?: (plan: VerifiedPlanRecord) => Promise<boolean>;
  persistApproval?: (request: PlanApprovalPersistenceRequest) => Promise<unknown>;
  identity?: LifecycleIdentity;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const current = (input: Pick<CyclePlanAdoptionInput, "isCurrent" | "signal">) =>
  !input.signal?.aborted && (input.isCurrent?.() ?? true);

const exactRecordKey = (value: unknown) => {
  const normalized = normalizeLifecycleRecordKey(value);
  return normalized && value === normalized ? normalized : null;
};

const persistedApproval = (value: unknown): { artifactId: string; recordKey: string } | null => {
  const result = object(value);
  const semanticRecall = object(result?.semanticRecall);
  const artifactId = typeof result?.artifactId === "string" && UUID.test(result.artifactId)
    ? result.artifactId.toLowerCase()
    : null;
  const recordKey = exactRecordKey(result?.recordKey);
  return result?.status === "completed"
    && result.receiptAccepted === true
    && semanticRecall?.matched === true
    && artifactId
    && recordKey
    ? { artifactId, recordKey }
    : null;
};

const sameContract = (left: VerifiedPlanRecord, right: VerifiedPlanRecord) =>
  left.artifactId === right.artifactId
  && left.recordKey === right.recordKey
  && left.contentHash === right.contentHash;

const approvalIdentity = (identity: LifecycleIdentity, plan: VerifiedPlanRecord) => {
  const normalized = normalizeLifecycleIdentity({
    ...identity,
    sourceRefs: [...new Set([...identity.sourceRefs, `QdrantRecordKey:${plan.recordKey}`])],
    priorArtifactIds: [...new Set([...identity.priorArtifactIds, plan.artifactId])],
  });
  return normalized;
};

const readSelection = async (
  input: Pick<CyclePlanAdoptionInput, "state" | "recall">,
): Promise<ReusablePlanSelection | null> => {
  let payload: Record<string, unknown> | null;
  try {
    payload = await input.recall(`${input.state.lifecycleKey} plan`);
  } catch {
    return null;
  }
  if (!payload) return null;
  return selectReusablePlan(payload, {
    lifecycleKey: input.state.lifecycleKey,
    source: input.state.source,
  });
};

const fromSelection = (selection: ReusablePlanSelection): PlanAdoptionResult => {
  if (selection.kind === "approved") {
    return {
      kind: "approved",
      approval: selection.approval,
      contract: selection.contract,
    };
  }
  if (selection.kind === "confirmation-required") {
    return { kind: "confirmation-required", plan: selection.plan };
  }
  if (selection.kind === "no-plan") return selection;
  return selection;
};

export function adoptedPlanState(
  stateValue: unknown,
  adoption: Extract<PlanAdoptionResult, { kind: "approved" }>,
  options: { allowAwaitingEvidence?: boolean; timestamp?: string } = {},
): PlanAdoptionStateResult {
  const valid = validateCycleState(stateValue);
  if (!valid.valid || valid.state.phase !== "plan" || valid.state.execution) return { ok: false, code: "plan_adoption_unavailable" };
  const state = valid.state;
  const probe = state.status === "awaiting-evidence" && options.allowAwaitingEvidence
    ? state
    : state.status === "awaiting-resume"
      ? { ...state, status: "awaiting-evidence" as const }
      : state.status === "stopped"
        ? { ...state, status: "awaiting-evidence" as const, stoppedAt: undefined, stoppedPhase: undefined }
        : state.status === "blocked" && state.blockers.length === 1 && state.blockers[0] === "plan:BLOCKED"
          ? { ...state, status: "awaiting-evidence" as const, blockers: [] }
          : null;
  if (!probe) return { ok: false, code: "plan_adoption_unavailable" };

  const reduced = reduceCycleState(probe, {
    artifact: adoption.approval.artifact,
    artifactId: adoption.approval.artifactId,
    recordKey: adoption.approval.recordKey,
    toolCallId: `plan-adoption:${adoption.approval.artifactId}`,
    timestamp: options.timestamp,
    approvedPlan: {
      artifactId: adoption.contract.artifactId,
      recordKey: adoption.contract.recordKey,
      contentHash: adoption.contract.contentHash,
      approvedAt: adoption.approval.createdAt,
    },
  }, options);
  return reduced.ok
    ? { ok: true, state: reduced.state }
    : { ok: false, code: reduced.error.code };
}

export async function coordinateCyclePlanAdoption(input: CyclePlanAdoptionInput): Promise<PlanAdoptionResult> {
  if (!current(input)) return { kind: "cancelled" };
  const first = await readSelection(input);
  if (!current(input)) return { kind: "cancelled" };
  if (!first) return { kind: "blocked", code: "plan_recall_failed" };
  if (first.kind !== "confirmation-required") return fromSelection(first);
  if (!input.interactive) return fromSelection(first);
  if (!input.confirm || !input.persistApproval || !input.identity) {
    return { kind: "blocked", code: "plan_confirmation_unavailable" };
  }

  let confirmed: boolean;
  try {
    confirmed = await input.confirm(first.plan);
  } catch {
    return { kind: "blocked", code: "plan_confirmation_failed" };
  }
  if (!current(input)) return { kind: "cancelled" };
  if (!confirmed) return { kind: "cancelled" };

  const rechecked = await readSelection(input);
  if (!current(input)) return { kind: "cancelled" };
  if (!rechecked) return { kind: "blocked", code: "plan_recall_failed" };
  if (rechecked.kind === "approved" && sameContract(rechecked.contract, first.plan)) {
    return fromSelection(rechecked);
  }
  if (rechecked.kind !== "confirmation-required" || !sameContract(rechecked.plan, first.plan)) {
    return { kind: "blocked", code: "plan_selection_changed" };
  }

  const approval = buildLegacyPlanApproval(rechecked.plan);
  const identity = approvalIdentity(input.identity, rechecked.plan);
  if (!approval || !identity) return { kind: "blocked", code: "plan_approval_invalid" };

  let persisted: { artifactId: string; recordKey: string } | null;
  try {
    persisted = persistedApproval(await input.persistApproval({
      type: "plan",
      identity,
      summary: approval.summary,
      artifact: approval.artifact,
    }));
  } catch {
    persisted = null;
  }
  if (!current(input)) return { kind: "cancelled" };
  if (!persisted) return { kind: "blocked", code: "plan_approval_persist_failed" };

  const verified = await readSelection(input);
  if (!current(input)) return { kind: "cancelled" };
  if (
    !verified
    || verified.kind !== "approved"
    || !sameContract(verified.contract, rechecked.plan)
    || verified.approval.artifactId !== persisted.artifactId
    || verified.approval.recordKey !== persisted.recordKey
  ) return { kind: "blocked", code: "plan_approval_recheck_failed" };

  return fromSelection(verified);
}

export type ImportedPlanVerificationResult =
  | { kind: "not-imported" }
  | { kind: "verified" }
  | { kind: "cancelled" }
  | { kind: "blocked"; code: string };

const importedPlanEvidence = (state: CycleState) => [...state.evidence]
  .reverse()
  .find((evidence) => evidence.phase === "plan" && evidence.outcome === "APPROVED" && evidence.approvedPlan);

export async function revalidateImportedPlanReference(
  input: Pick<CyclePlanAdoptionInput, "state" | "recall" | "isCurrent" | "signal">,
): Promise<ImportedPlanVerificationResult> {
  const evidence = importedPlanEvidence(input.state);
  if (!evidence) return { kind: "not-imported" };
  if (!evidence.approvedPlan || !evidence.artifactId || !evidence.recordKey) {
    return { kind: "blocked", code: "plan_reference_invalid" };
  }
  if (!current(input)) return { kind: "cancelled" };
  const selection = await readSelection(input);
  if (!current(input)) return { kind: "cancelled" };
  if (!selection || selection.kind !== "approved") return { kind: "blocked", code: "plan_reference_unverified" };
  const approvedPlan = evidence.approvedPlan;
  const matched = selection.approval.artifactId === evidence.artifactId
    && selection.approval.recordKey === evidence.recordKey
    && selection.approval.createdAt === approvedPlan.approvedAt
    && selection.contract.artifactId === approvedPlan.artifactId
    && selection.contract.recordKey === approvedPlan.recordKey
    && selection.contract.contentHash === approvedPlan.contentHash;
  return matched ? { kind: "verified" } : { kind: "blocked", code: "plan_reference_changed" };
}
