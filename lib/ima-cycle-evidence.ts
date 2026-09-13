import {
  CYCLE_PHASES,
  IMA_PROJECT,
  lifecycleTypeForPhase,
  parseLifecycleSearchRecords,
  reconcileCycleFromLifecycle,
  reduceCycleState,
  resolvePhaseOutcome,
  sanitizeCycleError,
  validateCycleState,
  type CycleEvidence,
  type CyclePhase,
  type CycleState,
} from "./ima-cycle.ts";
import {
  type CyclePhaseSettlement,
} from "./ima-cycle-phase.ts";
import { normalizeLifecycleRecordKey } from "./ima-lifecycle.ts";

export type CycleCurrent = () => boolean;
export type CycleAppend = (state: CycleState) => void | Promise<void>;
export type CycleObservationInput = {
  state: CycleState;
  toolName: unknown;
  toolCallId: unknown;
  input: unknown;
  result: unknown;
  timestamp?: string;
};
export type CycleObservationDiagnostic = {
  phase: CyclePhase;
  artifactId: string | null;
  recordKey: string | null;
};
export type CycleObservationResult =
  | { matched: true; state: CycleState; evidence: CycleEvidence }
  | { matched: false; state: CycleState; error: ReturnType<typeof sanitizeCycleError>; diagnostic?: CycleObservationDiagnostic };
export type CycleRecall = (query: string) => Promise<unknown>;
export type CycleRecallValidation =
  | { valid: true; payload: Record<string, unknown> }
  | { valid: false; code: string };
export type CycleReconcileInput = {
  state: CycleState;
  recall: CycleRecall;
  appendState: CycleAppend;
  readExecutionSettlement?: (state: CycleState) => Promise<CyclePhaseSettlement | null>;
  validateRecall?: (state: CycleState, payload: Record<string, unknown>) => CycleRecallValidation;
  isCurrent?: CycleCurrent;
  timestamp?: string;
};
export type CycleReconcileResult =
  | { ok: true; state: CycleState; reconciled: boolean }
  | { ok: false; state: CycleState | null; error: ReturnType<typeof sanitizeCycleError>; diagnostic?: CycleObservationDiagnostic };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const current = (isCurrent?: CycleCurrent) => isCurrent?.() ?? true;
const copyState = (state: CycleState): CycleState => structuredClone(state);
const safeError = (code: string) => ({ ok: false as const, error: sanitizeCycleError(code) });
const safeArtifactReference = (value: unknown) => {
  const reference = text(value).replace(/[\r\n]+/g, " ").replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, 512);
  return reference || null;
};
const safeRecordKey = (value: unknown) => normalizeLifecycleRecordKey(value);
const contentText = (content: unknown): string => Array.isArray(content)
  ? content.flatMap((item) => {
    const entry = object(item);
    return entry?.type === "text" ? [text(entry.text)] : [];
  }).join("\n")
  : text(content);
const jsonObject = (value: unknown): Record<string, unknown> | null => {
  if (object(value)) return object(value);
  if (typeof value !== "string") return null;
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
};
const lifecyclePayload = (value: unknown): Record<string, unknown> | null => {
  const input = object(value);
  if (!input) return null;
  const details = object(input.details);
  if (details?.status) return details;
  return jsonObject(contentText(input.content)) ?? details;
};
const resultData = (value: unknown): Record<string, unknown> | null => {
  const response = object(value);
  if (!response || response.isError === true) return null;
  const structured = object(response.structuredContent);
  if (structured) return structured;
  if (Array.isArray(response.content)) {
    for (const content of response.content) {
      const parsed = jsonObject(object(content)?.text);
      if (parsed) return parsed;
    }
  }
  return response;
};
const sameLifecycleIdentity = (state: CycleState, identityValue: unknown): boolean => {
  const identity = object(identityValue);
  if (!identity || text(identity.project) !== IMA_PROJECT || text(identity.lifecycleKey) !== state.lifecycleKey) return false;
  if (state.source.type === "jira") return text(identity.jiraKey) === state.source.key;
  if (state.source.type === "taskwarrior") {
    return text(identity.taskwarriorProject) === state.source.project
      && text(identity.taskwarriorUuid) === state.source.uuid;
  }
  return text(identity.jiraKey) === ""
    && text(identity.taskwarriorProject) === ""
    && text(identity.taskwarriorTask) === ""
    && text(identity.taskwarriorUuid) === ""
    && text(identity.planeWorkspace) === state.source.workspace
    && text(identity.planeWorkItem) === `${state.source.project}-${state.source.sequenceId}`;
};
const hasImportedPlanLineage = (state: CycleState, identityValue: unknown) => {
  const evidence = [...state.evidence]
    .reverse()
    .find((item) => item.phase === "plan" && item.outcome === "APPROVED" && item.approvedPlan);
  if (!evidence?.approvedPlan) return true;
  const identity = object(identityValue);
  const priorArtifactIds = identity?.priorArtifactIds;
  return Boolean(
    evidence.artifactId
    && Array.isArray(priorArtifactIds)
    && priorArtifactIds.every((id) => typeof id === "string" && UUID.test(id))
    && priorArtifactIds.includes(evidence.artifactId)
    && priorArtifactIds.includes(evidence.approvedPlan.artifactId),
  );
};

export function observeLifecycleResult(input: CycleObservationInput): CycleObservationResult {
  if (input.toolName !== "ima_lifecycle") return { matched: false, state: input.state, error: sanitizeCycleError("tool_not_cycle_lifecycle") };
  const request = object(input.input);
  const resultObject = object(input.result);
  const payload = lifecyclePayload(input.result);
  if (!request || !payload || resultObject?.isError === true || payload.status !== "completed" || payload.receiptAccepted !== true || object(payload.semanticRecall)?.matched !== true) {
    return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_completion_unverified") };
  }
  const expectedLifecycleType = lifecycleTypeForPhase(input.state.phase);
  if (text(payload.lifecycleKey) !== input.state.lifecycleKey || text(payload.phase) !== expectedLifecycleType || text(request.type) !== expectedLifecycleType || !sameLifecycleIdentity(input.state, request.identity)) {
    return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_identity_mismatch") };
  }
  if (!hasImportedPlanLineage(input.state, request.identity)) {
    return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_plan_lineage_mismatch") };
  }
  const artifactId = safeArtifactReference(payload.artifactId);
  const rawRecordKey = payload.recordKey;
  const recordKey = rawRecordKey === undefined || rawRecordKey === null ? null : safeRecordKey(rawRecordKey);
  if (rawRecordKey !== undefined && rawRecordKey !== null && !recordKey) {
    return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_completion_unverified") };
  }
  const outcome = resolvePhaseOutcome(text(request.artifact), input.state.phase);
  if (!outcome.ok) {
    return { matched: false, state: input.state, error: outcome.error, diagnostic: { phase: input.state.phase, artifactId, recordKey } };
  }
  const toolCallId = text(input.toolCallId);
  if (!toolCallId) return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_tool_call_missing") };
  const reduced = reduceCycleState(input.state, {
    phase: outcome.phase,
    outcome: outcome.outcome,
    marker: outcome.marker,
    artifactId,
    recordKey,
    toolCallId,
    timestamp: input.timestamp,
  }, { timestamp: input.timestamp });
  if (!reduced.ok) return { matched: false, state: input.state, error: reduced.error };
  return { matched: true, state: reduced.state, evidence: reduced.state.evidence.at(-1)! };
}

export async function coordinateCycleReconcile(input: CycleReconcileInput): Promise<CycleReconcileResult> {
  const valid = validateCycleState(input.state);
  if (!valid.valid) return { ok: false, state: null, error: valid.error };
  const state = valid.state;
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
  if (state.status !== "awaiting-evidence") return { ok: true, state, reconciled: false };
  let response: unknown;
  try {
    response = await input.recall(`${state.lifecycleKey} ${lifecycleTypeForPhase(state.phase)}`);
  } catch {
    return { ...safeError("cycle_reconcile_read_failed"), state };
  }
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
  const payload = resultData(response);
  if (!payload) return { ...safeError("cycle_reconcile_read_failed"), state };
  const validatedPayload = input.validateRecall ? input.validateRecall(state, payload) : { valid: true as const, payload };
  if (!validatedPayload.valid) return { ...safeError(validatedPayload.code), state };
  const parsed = parseLifecycleSearchRecords(validatedPayload.payload, {
    lifecycleKey: state.lifecycleKey,
    phase: state.phase,
    jiraKey: state.source.type === "jira" ? state.source.key : "",
    taskwarriorProject: state.source.type === "taskwarrior" ? state.source.project : "",
    taskwarriorUuid: state.source.type === "taskwarrior" ? state.source.uuid : "",
    planeWorkspace: state.source.type === "plane" ? state.source.workspace : "",
    planeWorkItem: state.source.type === "plane" ? `${state.source.project}-${state.source.sequenceId}` : "",
  });
  if (!parsed.valid) return { ...safeError("cycle_reconcile_read_failed"), state };
  const needsExecutionSettlement = Boolean(
    state.execution
      && state.execution.phase === state.phase
      && parsed.records.some((record) => record.verified),
  );
  let executionSettlement: CyclePhaseSettlement | undefined;
  if (needsExecutionSettlement) {
    try {
      executionSettlement = await input.readExecutionSettlement?.(state) ?? undefined;
    } catch {
      executionSettlement = undefined;
    }
    if (!executionSettlement) return { ...safeError("cycle_execution_settlement_missing"), state };
  }
  const reconciled = reconcileCycleFromLifecycle(state, parsed.records, {
    timestamp: input.timestamp,
    ...(executionSettlement ? { executionSettlement } : {}),
  });
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
  if (!reconciled.ok) {
    return {
      ok: false,
      state: reconciled.state ?? state,
      error: reconciled.error,
      ...(reconciled.error.code === "lifecycle_outcome_undetermined"
        ? { diagnostic: { phase: state.phase, artifactId: safeArtifactReference(reconciled.artifactId), recordKey: safeRecordKey(reconciled.recordKey) } }
        : {}),
    };
  }
  if (!reconciled.reconciled) return { ok: true, state: reconciled.state, reconciled: false };
  try {
    await input.appendState(copyState(reconciled.state));
  } catch {
    return { ...safeError("cycle_state_persist_failed"), state };
  }
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
  return { ok: true, state: reconciled.state, reconciled: true };
}

export async function coordinateCycleRecovery(input: CycleReconcileInput): Promise<CycleReconcileResult> {
  const valid = validateCycleState(input.state);
  if (!valid.valid) return { ok: false, state: null, error: valid.error };
  let state = valid.state;
  let reconciled = false;
  const limit = CYCLE_PHASES.length + (state.reviewCap * 2);
  for (let step = 0; step < limit; step += 1) {
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
    if (!["awaiting-evidence", "awaiting-resume"].includes(state.status)) return { ok: true, state, reconciled };
    const probe: CycleState = state.status === "awaiting-resume" ? { ...copyState(state), status: "awaiting-evidence" } : state;
    const result = await coordinateCycleReconcile({ ...input, state: probe });
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
    if (!result.ok) return { ok: false, state, error: result.error, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) };
    if (!result.reconciled) return { ok: true, state, reconciled };
    state = copyState(result.state);
    reconciled = true;
  }
  return { ok: false, state, error: sanitizeCycleError("cycle_recovery_limit_reached") };
}
