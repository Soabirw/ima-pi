import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyConfiguredCommandRoute, latestSessionProfile } from "./workflow-routing.ts";
import { coordinateContext, coordinateLifecycle, mcpResultData, recallCorpusLifecycle } from "./integrations.ts";
import {
  CYCLE_ENTRY,
  CYCLE_PHASES,
  IMA_PROJECT,
  buildCycleStatus,
  buildFinalCloseoutArtifact,
  buildResumeSource,
  createCycleState,
  cycleSourceReference,
  lifecycleTypeForPhase,
  normalizeCycleSource,
  parseCycleCommand,
  parseJiraTracker,
  parseLifecycleSearchRecords,
  parsePlaneCurrentWorkItem,
  parsePlaneStateMutation,
  parsePlaneWorkflowStates,
  parseTaskwarriorTracker,
  prepareCycleResume,
  reconcileCycleFromLifecycle,
  reduceCycleState,
  resolvePhaseOutcome,
  requiredCloseoutEvidence,
  sanitizeCycleError,
  validateCycleState,
  type CycleCommand,
  type CycleEvidence,
  type CycleImplementationMode,
  type CycleMode,
  type CyclePhase,
  type CycleSource,
  type CycleState,
} from "../lib/ima-cycle.ts";
import { CYCLE_ROOT_MARKERS, CYCLE_STORE_FILENAME, CYCLE_STORE_GITIGNORE_BODY, cycleStorePaths, parseCycleRecord, selectProjectRoot, serializeCycleRecord } from "../lib/ima-cycle-store.ts";
import {
  normalizeLifecycleRecordKey,
  type LifecycleIdentity,
} from "../lib/ima-lifecycle.ts";
import {
  adoptedPlanState,
  coordinateCyclePlanAdoption,
  revalidateImportedPlanReference,
  type PlanAdoptionResult,
  type PlanApprovalPersistenceRequest,
} from "../lib/ima-cycle-plan-adoption.ts";
import {
  filterImportedPlanLineage,
  type VerifiedPlanRecord,
} from "../lib/ima-cycle-plan.ts";

export const CYCLE_STATUS_KEY = "ima-cycle";
const JIRA_HELPER = join(homedir(), ".agents", "skills", "mcp-atlassian", "scripts", "atlassian-api.mjs");
const PLANE_HELPER = fileURLToPath(new URL("../skills/plane-api/scripts/plane-api.mjs", import.meta.url));
const MAX_PLANE_HELPER_OUTPUT_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_CAPABLE_PHASES = new Set<CyclePhase>(["implementation", "test", "resolution", "document"]);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nowIso = () => new Date().toISOString();
const safeError = (code: string) => ({ ok: false as const, error: sanitizeCycleError(code) });
const safeArtifactReference = (value: unknown) => {
  const reference = text(value).replace(/[\r\n]+/g, " ").replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, 512);
  return reference || null;
};
const safeRecordKey = (value: unknown) => normalizeLifecycleRecordKey(value);
const unresolvedOutcomeMessage = (phase: CyclePhase, artifactId: string | null, recordKey: string | null) => `Cycle lifecycle outcome is unresolved for ${phase}; inspect persisted artifactId ${artifactId ?? "unavailable"}; recordKey ${recordKey ?? "unavailable"}. State was preserved.`;
const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(message, level); };
const copyState = (state: CycleState): CycleState => structuredClone(state);
const CYCLE_PROMPT_PATH = fileURLToPath(new URL("../prompts", import.meta.url));

type CyclePromptTemplate = { name: string; content: string };

const parsePromptArgs = (argsString: string) => {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const character of argsString) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) { args.push(current); current = ""; }
    } else current += character;
  }
  if (current) args.push(current);
  return args;
};

const substitutePromptArgs = (content: string, args: readonly string[]) => {
  const allArgs = args.join(" ");
  return content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g, (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
    if (defaultTarget) {
      const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
      return value || defaultValue;
    }
    if (sliceStart) {
      const start = Math.max(0, parseInt(sliceStart, 10) - 1);
      return args.slice(start, sliceLength ? start + parseInt(sliceLength, 10) : undefined).join(" ");
    }
    if (simple === "ARGUMENTS" || simple === "@") return allArgs;
    return args[parseInt(simple, 10) - 1] ?? "";
  });
};

export function expandCyclePrompt(message: string, templates: readonly CyclePromptTemplate[]): string | null {
  if (!message.startsWith("/")) return message;
  const match = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return message;
  const template = templates.find(({ name }) => name === match[1]);
  return template ? substitutePromptArgs(template.content, parsePromptArgs(match[2] ?? "")) : null;
}

const expandCyclePromptFromResources = async (message: string, cwd: string) => {
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalPromptTemplatePaths: [CYCLE_PROMPT_PATH] });
  await loader.reload();
  const expanded = expandCyclePrompt(message, loader.getPrompts().prompts);
  if (expanded === null) throw new Error("cycle_prompt_template_missing");
  return expanded;
};

const CYCLE_ROUTE_COMMANDS: Readonly<Record<CyclePhase, string>> = {
  plan: "plan",
  implementation: "implement",
  test: "test",
  review: "review",
  resolution: "resolve-review",
  rereview: "rereview",
  document: "document",
};

export const cycleRoutePhase = (phase: CyclePhase): string => CYCLE_ROUTE_COMMANDS[phase];

export type CycleContextResult = { status: string; source?: unknown; diagnostics?: unknown[] };
export type CycleRouteResult = { ok: true; route?: unknown } | { ok: false; error: string; message?: string; rollback?: string };
export type CycleAppend = (state: CycleState) => void | Promise<void>;
export type CycleSend = (message: string, provisionalState: CycleState) => Promise<CycleState>;
export type CycleExpand = (message: string) => string | Promise<string>;
export type CycleRoute = (phase: CyclePhase) => Promise<CycleRouteResult>;
export type CyclePlanAdopter = (state: CycleState) => Promise<PlanAdoptionResult>;
export type CycleCurrent = () => boolean;

const current = (isCurrent?: CycleCurrent) => isCurrent?.() ?? true;

export const CYCLE_DISPATCH_CONFIRMATION_STATES = ["waiting-input", "waiting-before-agent", "waiting-agent-start", "waiting-agent-end", "waiting-settled", "succeeded", "failed"] as const;
export type CycleDispatchConfirmationStatus = typeof CYCLE_DISPATCH_CONFIRMATION_STATES[number];
export type CycleDispatchConfirmationState = { status: CycleDispatchConfirmationStatus; expectedPrompt: string };
export type CycleDispatchConfirmationEvent =
  | { type: "input"; source: string; text: string }
  | { type: "before-agent-start"; prompt: string }
  | { type: "agent-start" }
  | { type: "agent-end"; messages?: readonly unknown[]; stopReason?: unknown }
  | { type: "agent-settled" }
  | { type: "timeout" };

export function createCycleDispatchConfirmation(expectedPrompt: string): CycleDispatchConfirmationState {
  return { status: "waiting-input", expectedPrompt };
}

const lastAssistantStopReason = (event: Extract<CycleDispatchConfirmationEvent, { type: "agent-end" }>): unknown => {
  if (Array.isArray(event.messages)) {
    for (const message of [...event.messages].reverse()) {
      const value = object(message);
      if (value?.role === "assistant") return value.stopReason;
    }
    return undefined;
  }
  return event.stopReason;
};

export function reduceCycleDispatchConfirmation(state: CycleDispatchConfirmationState, event: CycleDispatchConfirmationEvent): CycleDispatchConfirmationState {
  if (["succeeded", "failed"].includes(state.status)) return state;
  if (state.status === "waiting-input" && event.type === "input" && event.source === "extension" && event.text === state.expectedPrompt) return { ...state, status: "waiting-before-agent" };
  if (state.status === "waiting-before-agent" && event.type === "before-agent-start" && event.prompt === state.expectedPrompt) return { ...state, status: "waiting-agent-start" };
  if (state.status === "waiting-agent-start" && event.type === "agent-start") return { ...state, status: "waiting-agent-end" };
  if (state.status === "waiting-agent-end" && event.type === "agent-end") return { ...state, status: lastAssistantStopReason(event) === "stop" ? "waiting-settled" : "failed" };
  if (state.status === "waiting-settled" && event.type === "agent-start") return { ...state, status: "waiting-agent-end" };
  if (state.status === "waiting-settled" && event.type === "agent-end") return { ...state, status: "failed" };
  if (state.status === "waiting-settled" && event.type === "agent-settled") return { ...state, status: "succeeded" };
  if (["waiting-input", "waiting-before-agent", "waiting-agent-start"].includes(state.status) && event.type === "timeout") return { ...state, status: "failed" };
  return state;
}

export type CycleAdoptionRecoveryResult =
  | { ok: true; state: CycleState }
  | { ok: false; state: CycleState; code: string; diagnostic?: CycleObservationDiagnostic };

export type CycleStartInput = {
  source: unknown;
  cwd: string;
  activeState?: CycleState | null;
  lifecycleKey?: string;
  reviewCap?: number;
  implementationMode?: CycleImplementationMode;
  mode?: CycleMode;
  branchId?: string;
  context?: (request: unknown, cwd: string) => Promise<CycleContextResult>;
  adoptPlan?: CyclePlanAdopter;
  recoverAdoptedState?: (state: CycleState) => Promise<CycleAdoptionRecoveryResult>;
  applyRoute: CycleRoute;
  appendState: CycleAppend;
  persistAdoptionState?: CycleAppend;
  sendUserMessage: CycleSend;
  expandPrompt?: CycleExpand;
  isCurrent?: CycleCurrent;
  timestamp?: string;
};

type CycleCoordinatorResult = { ok: true; state: CycleState; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError>; state?: CycleState };

const sameCycleSource = (left: CycleSource, right: CycleSource) => cycleSourceReference(left) === cycleSourceReference(right);

const reusablePlanningState = (stateValue: CycleState, source: CycleSource, input: CycleStartInput) => {
  const valid = validateCycleState(stateValue);
  if (!valid.valid || !sameCycleSource(valid.state.source, source) || valid.state.phase !== "plan") return null;
  const state = valid.state;
  const resumable = state.status === "awaiting-resume"
    || state.status === "stopped"
    || (state.status === "blocked" && state.blockers.length === 1 && state.blockers[0] === "plan:BLOCKED");
  return resumable
    ? {
      ...state,
      ...(input.mode ? { mode: input.mode } : {}),
      updatedAt: input.timestamp ?? nowIso(),
    }
    : null;
};

const hasConflictingReusableSettings = (state: CycleState, input: CycleStartInput) =>
  (input.lifecycleKey !== undefined && input.lifecycleKey !== state.lifecycleKey)
  || (input.reviewCap !== undefined && input.reviewCap !== state.reviewCap)
  || (input.implementationMode !== undefined && input.implementationMode !== state.implementationMode);

export async function coordinateCycleStart(input: CycleStartInput): Promise<CycleCoordinatorResult> {
  if (!current(input.isCurrent)) return safeError("cycle_operation_cancelled");
  const source = normalizeCycleSource(input.source);
  if (!source) return safeError("cycle_source_invalid");
  const active = input.activeState ? validateCycleState(input.activeState) : null;
  const activeState = active?.valid ? active.state : null;
  const activeIsTerminal = activeState && ["closed", "blocked-after-tracker-close"].includes(activeState.status);
  const existing = input.adoptPlan && activeState && !activeIsTerminal
    ? reusablePlanningState(activeState, source, input)
    : null;
  if (input.activeState && (!activeState || !activeIsTerminal && !existing)) {
    return safeError("cycle_active_replacement_blocked");
  }
  if (existing && hasConflictingReusableSettings(existing, input)) return safeError("cycle_active_settings_conflict");
  const context = input.context ?? ((request, cwd) => coordinateContext(request, cwd) as Promise<CycleContextResult>);
  let hydrated: CycleContextResult;
  try {
    const contextSource = source.type === "jira" ? { type: "jira", key: source.key } : source;
    hydrated = await context({ source: contextSource }, input.cwd);
  } catch {
    return safeError("cycle_context_failed");
  }
  if (!current(input.isCurrent)) return safeError("cycle_operation_cancelled");
  if (hydrated.status !== "ready") return safeError("cycle_context_not_ready");

  let state: CycleState;
  try {
    state = existing ?? createCycleState(source, {
      lifecycleKey: input.lifecycleKey,
      reviewCap: input.reviewCap,
      implementationMode: input.implementationMode,
      mode: input.mode,
      branchId: input.branchId,
      timestamp: input.timestamp,
    });
  } catch (error) {
    return safeError(error instanceof Error ? error.message : "cycle_state_invalid");
  }

  if (input.adoptPlan) {
    let adoption: PlanAdoptionResult;
    try {
      adoption = await input.adoptPlan(state);
    } catch {
      return { ...safeError("cycle_plan_adoption_failed"), ...(existing ? { state } : {}) };
    }
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
    if (adoption.kind === "approved") {
      const adopted = adoptedPlanState(state, adoption, { allowAwaitingEvidence: !existing, timestamp: input.timestamp });
      if (!adopted.ok) return { ...safeError(adopted.code), state };
      const append = input.persistAdoptionState ?? input.appendState;
      try {
        await append(copyState(adopted.state));
      } catch {
        return { ...safeError("cycle_state_persist_failed"), state };
      }
      if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: adopted.state };
      let recovered: CycleAdoptionRecoveryResult = { ok: true, state: adopted.state };
      if (input.recoverAdoptedState) {
        try {
          recovered = await input.recoverAdoptedState(adopted.state);
        } catch {
          recovered = { ok: false, state: adopted.state, code: "cycle_adoption_recovery_failed" };
        }
      }
      if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: adopted.state };
      if (!recovered.ok) return { ...safeError(recovered.code), state: recovered.state };
      if (recovered.state.status !== "awaiting-resume") {
        return { ok: true, state: recovered.state, message: `Cycle adopted verified progress for ${cycleSourceReference(source)} without dispatch.` };
      }
      const dispatched = await dispatchCyclePhase({
        state: recovered.state,
        applyRoute: input.applyRoute,
        appendState: append,
        sendUserMessage: input.sendUserMessage,
        expandPrompt: input.expandPrompt,
        isCurrent: input.isCurrent,
        timestamp: input.timestamp,
      });
      return dispatched.ok
        ? { ...dispatched, message: `Cycle started from approved plan for ${cycleSourceReference(source)}.` }
        : { ...dispatched, state: dispatched.state ?? recovered.state };
    }
    if (adoption.kind === "blocked") return { ...safeError(adoption.code), ...(existing ? { state } : {}) };
    if (adoption.kind === "confirmation-required") return { ...safeError("cycle_plan_confirmation_required"), ...(existing ? { state } : {}) };
    if (adoption.kind === "cancelled") return { ...safeError("cycle_plan_adoption_cancelled"), ...(existing ? { state } : {}) };
    if (existing) return { ...safeError("cycle_manual_plan_unavailable"), state };
  }

  let route: CycleRouteResult;
  try {
    route = await input.applyRoute("plan");
  } catch {
    return safeError("phase_route_apply_failed");
  }
  if (!current(input.isCurrent)) return safeError("cycle_operation_cancelled");
  if (!route.ok) return safeError(route.error || "phase_route_apply_failed");
  const command = buildResumeSource({ ...state, status: "awaiting-resume" }) ?? "/ima:plan";
  const provisional = copyState(state);
  try {
    await input.appendState(provisional);
  } catch {
    return safeError("cycle_state_persist_failed");
  }
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: provisional };
  let message: string;
  try {
    message = input.expandPrompt ? await input.expandPrompt(command) : command;
  } catch {
    return current(input.isCurrent)
      ? { ok: true, state: provisional, message: `Cycle state persisted for ${cycleSourceReference(source)}; plan prompt expansion was unavailable.` }
      : { ...safeError("cycle_operation_cancelled"), state: provisional };
  }
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: provisional };
  try {
    const confirmedState = await input.sendUserMessage(message, copyState(provisional));
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: provisional };
    await input.appendState(copyState(confirmedState));
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: provisional };
    return { ok: true, state: confirmedState, message: `Cycle started for ${cycleSourceReference(source)}.` };
  } catch {
    return { ...safeError("cycle_phase_injection_failed"), state: provisional };
  }
}

export type CycleDispatchInput = {
  state: CycleState;
  applyRoute: CycleRoute;
  appendState: CycleAppend;
  sendUserMessage: CycleSend;
  expandPrompt?: CycleExpand;
  isCurrent?: CycleCurrent;
  timestamp?: string;
};

export async function dispatchCyclePhase(input: CycleDispatchInput): Promise<CycleCoordinatorResult> {
  if (!current(input.isCurrent)) return safeError("cycle_operation_cancelled");
  if (input.state.status !== "awaiting-resume") return safeError("cycle_resume_unavailable");
  const command = buildResumeSource(input.state);
  if (!command) return safeError("cycle_resume_source_invalid");
  let route: CycleRouteResult;
  try {
    route = await input.applyRoute(input.state.phase);
  } catch {
    return safeError("phase_route_apply_failed");
  }
  if (!current(input.isCurrent)) return safeError("cycle_operation_cancelled");
  if (!route.ok) return safeError(route.error || "phase_route_apply_failed");
  const state: CycleState = { ...copyState(input.state), status: "awaiting-evidence", updatedAt: input.timestamp ?? nowIso() };
  const provisional = copyState(state);
  try {
    await input.appendState(provisional);
  } catch {
    return safeError("cycle_state_persist_failed");
  }
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: provisional };
  let message: string;
  try {
    message = input.expandPrompt ? await input.expandPrompt(command) : command;
  } catch {
    return current(input.isCurrent)
      ? { ok: true, state: provisional, message: `Cycle state persisted for ${input.state.phase}; prompt expansion was unavailable.` }
      : { ...safeError("cycle_operation_cancelled"), state: provisional };
  }
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: provisional };
  try {
    const confirmedState = await input.sendUserMessage(message, copyState(provisional));
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: provisional };
    await input.appendState(copyState(confirmedState));
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state: provisional };
    return { ok: true, state: confirmedState, message: `Dispatched ${input.state.phase}.` };
  } catch {
    return { ...safeError("cycle_phase_injection_failed"), state: provisional };
  }
}

export type CycleStopInput = {
  state: CycleState;
  acknowledge: boolean;
  appendState: CycleAppend;
  abort: () => void;
  timestamp?: string;
};

export async function coordinateCycleStop(input: CycleStopInput): Promise<{ ok: true; state: CycleState; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError> }> {
  if (!["awaiting-evidence", "awaiting-resume"].includes(input.state.status)) return safeError("cycle_stop_unavailable");
  if (WRITE_CAPABLE_PHASES.has(input.state.phase) && input.state.mode !== "autonomous" && !input.acknowledge) return safeError("cycle_stop_ack_required");
  const state: CycleState = {
    ...copyState(input.state),
    status: "stopped",
    stoppedAt: input.timestamp ?? nowIso(),
    stoppedPhase: input.state.phase,
    updatedAt: input.timestamp ?? nowIso(),
  };
  await input.appendState(copyState(state));
  input.abort();
  return { ok: true, state, message: `Cycle stopped during ${state.phase}.` };
}

const contentText = (content: unknown): string => Array.isArray(content)
  ? content.flatMap((item) => { const entry = object(item); return entry?.type === "text" ? [text(entry.text)] : []; }).join("\n")
  : text(content);

const jsonObject = (value: unknown): Record<string, unknown> | null => {
  if (object(value)) return value;
  if (typeof value !== "string") return null;
  try { return object(JSON.parse(value)); } catch { return null; }
};

const lifecyclePayload = (value: unknown): Record<string, unknown> | null => {
  const input = object(value);
  if (!input) return null;
  const details = object(input.details);
  if (details?.status) return details;
  const parsed = jsonObject(contentText(input.content));
  return parsed ?? details;
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

export function observeLifecycleResult(input: CycleObservationInput): CycleObservationResult {
  if (input.toolName !== "ima_lifecycle") return { matched: false, state: input.state, error: sanitizeCycleError("tool_not_cycle_lifecycle") };
  const request = object(input.input);
  const resultObject = object(input.result);
  const payload = lifecyclePayload(input.result);
  if (!request || !payload || resultObject?.isError === true || payload.status !== "completed" || payload.receiptAccepted !== true || object(payload.semanticRecall)?.matched !== true) return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_completion_unverified") };
  const expectedLifecycleType = lifecycleTypeForPhase(input.state.phase);
  if (text(payload.lifecycleKey) !== input.state.lifecycleKey || text(payload.phase) !== expectedLifecycleType || text(request.type) !== expectedLifecycleType || !sameLifecycleIdentity(input.state, request.identity)) return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_identity_mismatch") };
  if (!hasImportedPlanLineage(input.state, request.identity)) return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_plan_lineage_mismatch") };
  const artifactId = safeArtifactReference(payload.artifactId);
  const rawRecordKey = payload.recordKey;
  const recordKey = rawRecordKey === undefined || rawRecordKey === null
    ? null
    : safeRecordKey(rawRecordKey);
  if (rawRecordKey !== undefined && rawRecordKey !== null && !recordKey) return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_completion_unverified") };
  const outcome = resolvePhaseOutcome(text(request.artifact), input.state.phase);
  if (!outcome.ok) return { matched: false, state: input.state, error: outcome.error, diagnostic: { phase: input.state.phase, artifactId, recordKey } };
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
  return { matched: true, state: reduced.state, evidence: reduced.state.evidence[reduced.state.evidence.length - 1] };
}

const execPayload = (value: unknown): unknown => {
  const result = object(value);
  if (!result) return value;
  if (typeof result.stdout === "string") {
    try { return JSON.parse(result.stdout); } catch { return result.stdout; }
  }
  return value;
};

const planePayload = (value: unknown): unknown | null => {
  const result = object(value);
  if (
    !result
    || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > MAX_PLANE_HELPER_OUTPUT_BYTES
  ) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
};

const execSucceeded = (value: unknown) => {
  const result = object(value);
  if (!result) return false;
  if (typeof result.code === "number") return result.code === 0;
  return result.ok === true || result.success === true;
};

export type CycleRecall = (query: string) => Promise<unknown>;
export type CycleRecallValidation =
  | { valid: true; payload: Record<string, unknown> }
  | { valid: false; code: string };

export type CycleReconcileInput = {
  state: CycleState;
  recall: CycleRecall;
  appendState: CycleAppend;
  validateRecall?: (state: CycleState, payload: Record<string, unknown>) => CycleRecallValidation;
  isCurrent?: CycleCurrent;
  timestamp?: string;
};

export type CycleReconcileResult =
  | { ok: true; state: CycleState; reconciled: boolean }
  | { ok: false; state: CycleState | null; error: ReturnType<typeof sanitizeCycleError>; diagnostic?: CycleObservationDiagnostic };

export async function coordinateCycleReconcile(input: CycleReconcileInput): Promise<CycleReconcileResult> {
  const valid = validateCycleState(input.state);
  if (!valid.valid) return { ok: false, state: null, error: valid.error };
  const state = valid.state;
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
  if (state.status !== "awaiting-evidence") return { ok: true, state, reconciled: false };

  const query = `${state.lifecycleKey} ${lifecycleTypeForPhase(state.phase)}`;
  let response: unknown;
  try {
    response = await input.recall(query);
  } catch {
    return { ...safeError("cycle_reconcile_read_failed"), state };
  }
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };

  const payload = mcpResultData(response);
  if (!payload) return { ...safeError("cycle_reconcile_read_failed"), state };
  const validatedPayload = input.validateRecall
    ? input.validateRecall(state, payload)
    : { valid: true as const, payload };
  if (!validatedPayload.valid) return { ...safeError(validatedPayload.code), state };
  const parsed = parseLifecycleSearchRecords(validatedPayload.payload, {
    lifecycleKey: state.lifecycleKey,
    phase: state.phase,
    jiraKey: state.source.type === "jira" ? state.source.key : "",
    taskwarriorUuid: state.source.type === "taskwarrior" ? state.source.uuid : "",
    planeWorkspace: state.source.type === "plane" ? state.source.workspace : "",
    planeWorkItem: state.source.type === "plane"
      ? `${state.source.project}-${state.source.sequenceId}`
      : "",
  });
  if (!parsed.valid) return { ...safeError("cycle_reconcile_read_failed"), state };
  const reconciled = reconcileCycleFromLifecycle(state, parsed.records, { timestamp: input.timestamp });
  if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
  if (!reconciled.ok) {
    return {
      ok: false,
      state: reconciled.state ?? state,
      error: reconciled.error,
      ...(reconciled.error.code === "lifecycle_outcome_undetermined" ? {
        diagnostic: {
          phase: state.phase,
          artifactId: safeArtifactReference(reconciled.artifactId),
          recordKey: safeRecordKey(reconciled.recordKey),
        },
      } : {}),
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

const cycleRecoveryLimit = (state: CycleState) => CYCLE_PHASES.length + (state.reviewCap * 2);

export async function coordinateCycleRecovery(input: CycleReconcileInput): Promise<CycleReconcileResult> {
  const valid = validateCycleState(input.state);
  if (!valid.valid) return { ok: false, state: null, error: valid.error };
  let state = valid.state;
  let reconciled = false;
  for (let step = 0; step < cycleRecoveryLimit(state); step += 1) {
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
    if (!["awaiting-evidence", "awaiting-resume"].includes(state.status)) return { ok: true, state, reconciled };
    const probe: CycleState = state.status === "awaiting-resume" ? { ...copyState(state), status: "awaiting-evidence" } : state;
    const result = await coordinateCycleReconcile({ ...input, state: probe });
    if (!current(input.isCurrent)) return { ...safeError("cycle_operation_cancelled"), state };
    if (!result.ok) {
      return {
        ok: false,
        state,
        error: result.error,
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      };
    }
    if (!result.reconciled) return { ok: true, state, reconciled };
    state = copyState(result.state);
    reconciled = true;
  }
  return { ok: false, state, error: sanitizeCycleError("cycle_recovery_limit_reached") };
}

const identityForSource = (state: CycleState): LifecycleIdentity => {
  const priorArtifactIds = [...new Set(state.evidence.flatMap((item) => [
    ...(item.artifactId ? [item.artifactId] : []),
    ...(item.approvedPlan ? [item.approvedPlan.artifactId] : []),
  ]))];
  if (state.source.type === "jira") {
    return { project: IMA_PROJECT, lifecycleKey: state.lifecycleKey, lifecycleRootMemoryId: "", taskwarriorProject: "", taskwarriorTask: "", taskwarriorUuid: "", jiraKey: state.source.key, sourceRefs: [`Jira:${state.source.key}`], priorArtifactIds };
  }
  if (state.source.type === "taskwarrior") {
    return { project: IMA_PROJECT, lifecycleKey: state.lifecycleKey, lifecycleRootMemoryId: "", taskwarriorProject: state.source.project, taskwarriorTask: state.source.uuid, taskwarriorUuid: state.source.uuid, jiraKey: "", sourceRefs: [`Taskwarrior:${state.source.project}:${state.source.uuid}`], priorArtifactIds };
  }
  const planeWorkItem = `${state.source.project}-${state.source.sequenceId}`;
  return {
    project: IMA_PROJECT,
    lifecycleKey: state.lifecycleKey,
    lifecycleRootMemoryId: "",
    taskwarriorProject: "",
    taskwarriorTask: "",
    taskwarriorUuid: "",
    jiraKey: "",
    planeWorkspace: state.source.workspace,
    planeWorkItem,
    sourceRefs: [cycleSourceReference(state.source)],
    priorArtifactIds,
  };
};

export type CycleCloseInput = {
  state: CycleState;
  mode: string;
  commitPrep: boolean;
  confirmed?: boolean;
  run: (program: string, args: string[]) => Promise<unknown>;
  lifecycle?: (request: { type: "closeout"; identity: LifecycleIdentity; summary: string; artifact: string }) => Promise<{ status?: string; [key: string]: unknown }>;
  identity?: LifecycleIdentity;
  appendState: CycleAppend;
  timestamp?: string;
};

const closePlaneTracker = async (
  source: Extract<CycleSource, { type: "plane" }>,
  run: CycleCloseInput["run"],
): Promise<{ ok: true } | { ok: false; code: string }> => {
  const reference = cycleSourceReference(source);
  let currentResult: unknown;
  try {
    currentResult = await run("node", [PLANE_HELPER, "plane:get", reference]);
  } catch {
    return { ok: false, code: "tracker_read_failed" };
  }
  if (!execSucceeded(currentResult)) return { ok: false, code: "tracker_read_failed" };

  const current = parsePlaneCurrentWorkItem(planePayload(currentResult), source);
  if (!current.valid) return { ok: false, code: current.error.code };

  let statesResult: unknown;
  try {
    statesResult = await run("node", [PLANE_HELPER, "plane:states", reference]);
  } catch {
    return { ok: false, code: "tracker_read_failed" };
  }
  if (!execSucceeded(statesResult)) return { ok: false, code: "tracker_read_failed" };

  const workflow = parsePlaneWorkflowStates(
    planePayload(statesResult),
    source,
    current.workItem,
  );
  if (!workflow.valid) return { ok: false, code: workflow.error.code };

  let mutationResult: unknown;
  try {
    mutationResult = await run("node", [
      PLANE_HELPER,
      "plane:set-state",
      reference,
      workflow.completedState.id,
    ]);
  } catch {
    return { ok: false, code: "tracker_close_failed" };
  }
  if (!execSucceeded(mutationResult)) return { ok: false, code: "tracker_close_failed" };

  const mutation = parsePlaneStateMutation(
    planePayload(mutationResult),
    source,
    current.workItem,
    workflow.completedState.id,
  );
  return mutation.valid
    ? { ok: true }
    : { ok: false, code: mutation.error.code };
};

export async function coordinateCycleClose(input: CycleCloseInput): Promise<{ ok: true; state?: CycleState; commitPrep?: { status: string; diffCheck: string; gitStatus: string }; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError>; state?: CycleState }> {
  if (input.commitPrep) {
    let status: unknown;
    let diffCheck: unknown;
    try {
      [status, diffCheck] = await Promise.all([input.run("git", ["status", "--short"]), input.run("git", ["diff", "--check"])]);
    } catch {
      return safeError("commit_prep_failed");
    }
    if (!execSucceeded(status) || !execSucceeded(diffCheck)) return safeError("commit_prep_failed");
    const statusResult = object(status);
    const diffResult = object(diffCheck);
    return { ok: true, commitPrep: { status: "read-only", gitStatus: text(statusResult?.stdout), diffCheck: text(diffResult?.stdout) }, message: "Read-only commit preparation completed." };
  }
  if (input.mode !== "tui") return { ...safeError("close_requires_tui"), state: input.state };
  const evidence = requiredCloseoutEvidence(input.state);
  if (!evidence.valid) return { ...safeError("closeout_evidence_missing"), state: input.state };
  if (input.confirmed !== true) return { ...safeError("close_confirmation_required"), state: input.state };
  const state = input.state;
  const identity = input.identity ?? identityForSource(state);
  if (!sameLifecycleIdentity(state, identity)) {
    return { ...safeError("lifecycle_identity_mismatch"), state };
  }
  if (state.source.type === "plane") {
    const closed = await closePlaneTracker(state.source, input.run);
    if (!closed.ok) return { ...safeError(closed.code), state };
  } else {
    let tracker: unknown;
    try {
      const trackerResult = state.source.type === "jira"
        ? await input.run("node", [JIRA_HELPER, "jira:transitions", state.source.key])
        : await input.run("task", ["rc.verbose=nothing", `project:${state.source.project}`, state.source.uuid, "export"]);
      if (object(trackerResult) && !execSucceeded(trackerResult)) return { ...safeError("tracker_read_failed"), state };
      tracker = execPayload(trackerResult);
    } catch {
      return { ...safeError("tracker_read_failed"), state };
    }
    let transitionId = "";
    if (state.source.type === "jira") {
      const parsed = parseJiraTracker(tracker);
      if (!parsed.valid || (parsed.key && parsed.key !== state.source.key) || parsed.doneTransitions.length !== 1) return { ...safeError(parsed.valid ? "jira_done_transition_ambiguous" : parsed.error.code), state };
      transitionId = parsed.doneTransitions[0].id;
    } else {
      const parsed = parseTaskwarriorTracker(tracker, state.source);
      if (!parsed.valid) return { ...safeError(parsed.error.code), state };
    }
    let mutation: unknown;
    try {
      mutation = state.source.type === "jira"
        ? await input.run("node", [JIRA_HELPER, "jira:transition", state.source.key, transitionId])
        : await input.run("task", ["rc.verbose=nothing", `project:${state.source.project}`, state.source.uuid, "done"]);
    } catch {
      return { ...safeError("tracker_close_failed"), state };
    }
    if (!execSucceeded(mutation)) return { ...safeError("tracker_close_failed"), state };
  }
  const artifact = buildFinalCloseoutArtifact(state, { identity });
  const lifecycle = input.lifecycle ?? (async (request) => coordinateLifecycle(request));
  let persisted: { status?: string; [key: string]: unknown };
  try {
    persisted = await lifecycle({
      type: "closeout",
      identity,
      summary: "Cycle closeout verified after tracker completion.",
      artifact,
    });
  } catch {
    persisted = { status: "failed" };
  }
  const success = persisted.status === "completed";
  const next: CycleState = {
    ...copyState(state),
    status: success ? "closed" : "blocked-after-tracker-close",
    trackerClosed: true,
    blockers: success ? [] : ["lifecycle_closeout_failed"],
    updatedAt: input.timestamp ?? nowIso(),
  };
  await input.appendState(copyState(next));
  return success
    ? { ok: true, state: next, message: "Tracker closed and lifecycle closeout verified." }
    : { ...safeError("lifecycle_closeout_failed"), state: next };
}

export function restoreCycleState(entries: readonly unknown[]): CycleState | null {
  for (const entry of [...entries].reverse()) {
    const value = object(entry);
    if (value?.type !== "custom" || value.customType !== CYCLE_ENTRY) continue;
    const data = object(value.data);
    const candidate = data?.state ?? value.data;
    const valid = validateCycleState(candidate);
    if (valid.valid) return valid.state;
  }
  return null;
}

const statusText = (state: CycleState | null) => {
  if (!state) return "No active cycle.";
  const status = buildCycleStatus(state);
  return status.status === "invalid" ? "Cycle state is invalid." : `Cycle ${status.status}: ${status.source}; phase ${status.phase}; mode ${status.mode}; review ${status.reviewAttempts}/${status.reviewCap}.`;
};

const routeFor = (pi: ExtensionAPI, ctx: ExtensionContext): CycleRoute => async (phase) =>
  await applyConfiguredCommandRoute(pi, ctx, cycleRoutePhase(phase), latestSessionProfile(ctx.sessionManager.getBranch())) ?? { ok: true };

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const ancestorDirectories = (cwd: string): string[] => {
  const directories: string[] = [];
  for (let current = resolve(cwd); ; current = dirname(current)) {
    directories.push(current);
    if (dirname(current) === current) return directories;
  }
};

const defaultResolveProjectRoot = async (cwd: string): Promise<string> => {
  const root = resolve(cwd);
  const marks = await Promise.all(ancestorDirectories(root).map(async (dir) => ({
    dir,
    hasMarker: (await Promise.all(CYCLE_ROOT_MARKERS.map((marker) => pathExists(join(dir, marker))))).some(Boolean),
  })));
  return selectProjectRoot(root, marks);
};

const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : "";

const isWithinRoot = (root: string, path: string) => {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
};

const resolveCycleStoreRoot = async (cwd: string, resolveProjectRoot: CycleExtensionDependencies["resolveProjectRoot"]) =>
  realpath(await resolveProjectRoot(cwd));

const verifyCycleStoreDirectory = async (root: string, create: boolean) => {
  const paths = cycleStorePaths(root);
  if (create) await mkdir(paths.dir, { recursive: true });
  const details = await lstat(paths.dir);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("cycle_store_directory_invalid");
  const canonicalDirectory = await realpath(paths.dir);
  if (!isWithinRoot(root, canonicalDirectory)) throw new Error("cycle_store_path_invalid");
  return paths;
};

const verifySafeRegularFile = async (root: string, path: string) => {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("cycle_store_file_invalid");
  const canonicalPath = await realpath(path);
  if (!isWithinRoot(root, canonicalPath)) throw new Error("cycle_store_path_invalid");
  return canonicalPath;
};

const verifyExistingSafeRegularFile = async (root: string, path: string) => {
  try {
    return await verifySafeRegularFile(root, path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

const writeCycleStoreGitignore = async (root: string, path: string): Promise<void> => {
  try {
    await writeFile(path, CYCLE_STORE_GITIGNORE_BODY, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const safePath = await verifySafeRegularFile(root, path);
  if (await readFile(safePath, "utf8") !== CYCLE_STORE_GITIGNORE_BODY) throw new Error("cycle_store_gitignore_invalid");
};

type CyclePersistenceOptions = { isCurrent?: CycleCurrent };

const requireCurrent = (isCurrent?: CycleCurrent) => {
  if (!current(isCurrent)) throw new Error("cycle_state_stale");
};

const writeCycleStoreState = async (
  root: string,
  path: string,
  state: CycleState,
  options: CyclePersistenceOptions = {},
): Promise<void> => {
  const temporary = join(dirname(path), `.${CYCLE_STORE_FILENAME}.${randomUUID()}.tmp`);
  const serialized = serializeCycleRecord(state);
  try {
    requireCurrent(options.isCurrent);
    await verifyExistingSafeRegularFile(root, path);
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
    } finally {
      await handle.close();
    }
    requireCurrent(options.isCurrent);
    await verifySafeRegularFile(root, temporary);
    await verifyExistingSafeRegularFile(root, path);
    requireCurrent(options.isCurrent);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const loadDurableStateWith = (resolveProjectRoot: CycleExtensionDependencies["resolveProjectRoot"]) => async (cwd: string): Promise<CycleState | null> => {
  try {
    const root = await resolveCycleStoreRoot(cwd, resolveProjectRoot);
    const paths = await verifyCycleStoreDirectory(root, false);
    const safePath = await verifySafeRegularFile(root, paths.file);
    return parseCycleRecord(await readFile(safePath, "utf8"));
  } catch {
    return null;
  }
};

const persistDurableStateWith = (resolveProjectRoot: CycleExtensionDependencies["resolveProjectRoot"]) => async (
  cwd: string,
  state: CycleState,
  options: CyclePersistenceOptions = {},
): Promise<void> => {
  requireCurrent(options.isCurrent);
  const root = await resolveCycleStoreRoot(cwd, resolveProjectRoot);
  requireCurrent(options.isCurrent);
  const paths = await verifyCycleStoreDirectory(root, true);
  requireCurrent(options.isCurrent);
  await writeCycleStoreGitignore(root, paths.gitignore);
  requireCurrent(options.isCurrent);
  await writeCycleStoreState(root, paths.file, state, options);
};

export type CycleExtensionDependencies = {
  context: (request: unknown, cwd: string) => Promise<CycleContextResult>;
  applyRoute: (pi: ExtensionAPI, ctx: ExtensionContext, phase: CyclePhase) => Promise<CycleRouteResult>;
  expandPrompt: (value: string, cwd: string) => Promise<string>;
  recall: CycleRecall;
  lifecycle: (request: PlanApprovalPersistenceRequest) => Promise<unknown>;
  resolveProjectRoot: (cwd: string) => Promise<string>;
  loadDurableState: (cwd: string) => Promise<CycleState | null>;
  persistDurableState: (cwd: string, state: CycleState, options?: CyclePersistenceOptions) => Promise<void>;
};

const defaultCycleExtensionDependencies: CycleExtensionDependencies = {
  context: (request, cwd) => coordinateContext(request, cwd) as Promise<CycleContextResult>,
  applyRoute: (pi, ctx, phase) => routeFor(pi, ctx)(phase),
  expandPrompt: expandCyclePromptFromResources,
  recall: (query) => recallCorpusLifecycle(query),
  lifecycle: (request) => coordinateLifecycle(request),
  resolveProjectRoot: defaultResolveProjectRoot,
  loadDurableState: loadDurableStateWith(defaultResolveProjectRoot),
  persistDurableState: persistDurableStateWith(defaultResolveProjectRoot),
};

export function registerCycleExtension(pi: ExtensionAPI, overrides: Partial<CycleExtensionDependencies> = {}) {
  const resolveProjectRoot = overrides.resolveProjectRoot ?? defaultCycleExtensionDependencies.resolveProjectRoot;
  const dependencies: CycleExtensionDependencies = {
    ...defaultCycleExtensionDependencies,
    ...overrides,
    resolveProjectRoot,
    loadDurableState: overrides.loadDurableState ?? loadDurableStateWith(resolveProjectRoot),
    persistDurableState: overrides.persistDurableState ?? persistDurableStateWith(resolveProjectRoot),
  };
  let state: CycleState | null = null;
  type ActiveCycleOperation = {
    generation: number;
    controller: AbortController;
    provisional: CycleState | null;
  };
  type PendingDispatch = {
    confirmation: CycleDispatchConfirmationState;
    state: CycleState;
    provisionalState: CycleState;
    operation: ActiveCycleOperation | null;
    finish: (state?: CycleState) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  };
  type PublicationOptions = {
    strict?: boolean;
    isCurrent?: CycleCurrent;
    operation?: ActiveCycleOperation | null;
  };
  let pendingDispatch: PendingDispatch | null = null;
  let autonomousRun: { aborted: boolean; dispatches: number } | null = null;
  let currentOperation: ActiveCycleOperation | null = null;
  let dispatchGeneration = 0;
  let publication: Promise<void> = Promise.resolve();
  const operationCurrent = (operation: ActiveCycleOperation) =>
    currentOperation === operation
    && operation.generation === dispatchGeneration
    && !operation.controller.signal.aborted;
  const cancelPendingDispatch = (code: string) => {
    const pending = pendingDispatch;
    if (pending) pending.reject(new Error(code));
  };
  const invalidateOperation = () => {
    dispatchGeneration += 1;
    const operation = currentOperation;
    currentOperation = null;
    operation?.controller.abort();
    if (autonomousRun) autonomousRun.aborted = true;
    cancelPendingDispatch("cycle_operation_cancelled");
    return dispatchGeneration;
  };
  const beginOperation = () => {
    invalidateOperation();
    const operation: ActiveCycleOperation = {
      generation: dispatchGeneration,
      controller: new AbortController(),
      provisional: null,
    };
    currentOperation = operation;
    return operation;
  };
  const finishOperation = (operation: ActiveCycleOperation) => {
    if (currentOperation === operation) currentOperation = null;
  };
  const publishState = async (
    ctx: ExtensionContext,
    next: CycleState,
    options: PublicationOptions = {},
  ) => {
    const persisted = copyState(next);
    const isCurrent = options.isCurrent ?? (options.operation
      ? () => operationCurrent(options.operation!)
      : undefined);
    const publish = async () => {
      requireCurrent(isCurrent);
      try {
        await dependencies.persistDurableState(ctx.cwd, persisted, { isCurrent });
      } catch (error) {
        if (options.strict || !current(isCurrent)) throw error;
        notify(ctx, "Cycle durable state could not be written; lifecycle artifacts remain authoritative.", "warning");
      }
      requireCurrent(isCurrent);
      if (options.operation) options.operation.provisional = copyState(persisted);
      pi.appendEntry(CYCLE_ENTRY, copyState(persisted));
    };
    const queued = publication.then(publish, publish);
    publication = queued.then(() => undefined, () => undefined);
    return queued;
  };
  const appendFor = (
    ctx: ExtensionContext,
    isCurrent?: CycleCurrent,
    operation: ActiveCycleOperation | null = null,
  ): CycleAppend => async (next) => publishState(ctx, next, { isCurrent, operation });
  const strictAdoptionAppend = (
    ctx: ExtensionContext,
    next: CycleState,
    isCurrent: CycleCurrent,
    operation: ActiveCycleOperation | null = null,
  ) => publishState(ctx, next, { strict: true, isCurrent, operation });
  const reducePendingDispatch = (event: CycleDispatchConfirmationEvent) => {
    const pending = pendingDispatch;
    if (!pending) return;
    if (pending.operation && !operationCurrent(pending.operation)) {
      pending.reject(new Error("cycle_operation_cancelled"));
      return;
    }
    const previous = pending.confirmation;
    const next = reduceCycleDispatchConfirmation(previous, event);
    pending.confirmation = next;
    if (previous.status === "waiting-agent-start" && next.status === "waiting-agent-end") {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (next.status === "succeeded") pending.finish();
    if (next.status === "failed") pending.finish(pending.provisionalState);
  };
  const sendCycleUserMessage = (
    message: string,
    provisionalState: CycleState,
    operation: ActiveCycleOperation | null = null,
  ) => new Promise<CycleState>((resolveMessage, rejectMessage) => {
    if (operation && !operationCurrent(operation)) { rejectMessage(new Error("cycle_operation_cancelled")); return; }
    if (pendingDispatch) { rejectMessage(new Error("cycle_phase_injection_pending")); return; }
    const pending: PendingDispatch = {
      confirmation: createCycleDispatchConfirmation(message),
      state: copyState(provisionalState),
      provisionalState: copyState(provisionalState),
      operation,
      finish: () => {},
      reject: () => {},
      timer: null,
    };
    const settle = (action: () => void) => {
      if (pendingDispatch !== pending) return;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      pendingDispatch = null;
      action();
    };
    pending.finish = (resolvedState = pending.state) => settle(() => resolveMessage(copyState(resolvedState)));
    pending.reject = (error) => settle(() => rejectMessage(error));
    pendingDispatch = pending;
    pending.timer = setTimeout(() => reducePendingDispatch({ type: "timeout" }), 10_000);
    try {
      if (operation && !operationCurrent(operation)) {
        pending.reject(new Error("cycle_operation_cancelled"));
        return;
      }
      Promise.resolve(pi.sendUserMessage(message)).catch(() => pending.finish(pending.provisionalState));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error("cycle_phase_injection_failed"));
    }
  });
  const confirmLegacyPlan = async (ctx: ExtensionContext, plan: VerifiedPlanRecord) => {
    if (ctx.mode !== "tui") return false;
    const reviewed = await ctx.ui.editor("Review saved manual plan", plan.detail);
    if (reviewed === undefined || reviewed !== plan.detail) return false;
    return ctx.ui.confirm("Approve saved manual plan", "Reuse this exact saved plan for the current cycle?");
  };
  const requestPlanAdoption = async (
    ctx: ExtensionContext,
    candidate: CycleState,
    interactive: boolean,
    isCurrent: CycleCurrent,
    signal?: AbortSignal,
  ) => coordinateCyclePlanAdoption({
    state: candidate,
    recall: async (query) => mcpResultData(await dependencies.recall(query)),
    interactive: interactive && ctx.mode === "tui",
    ...(interactive && ctx.mode === "tui"
      ? { confirm: (plan: VerifiedPlanRecord) => confirmLegacyPlan(ctx, plan) }
      : {}),
    persistApproval: (request: PlanApprovalPersistenceRequest) => dependencies.lifecycle(request),
    identity: identityForSource(candidate),
    isCurrent,
    signal,
  });
  const canInteractivelyAdoptPlan = (candidate: CycleState) => candidate.phase === "plan"
    && (candidate.status === "awaiting-resume"
      || candidate.status === "stopped"
      || candidate.status === "blocked" && candidate.blockers.length === 1 && candidate.blockers[0] === "plan:BLOCKED");
  const canRecoverPlan = (
    candidate: CycleState,
    operation: ActiveCycleOperation | null = null,
  ) => !pendingDispatch
    && candidate.phase === "plan"
    && (candidate.status === "awaiting-evidence" || canInteractivelyAdoptPlan(candidate))
    && (operation ? operationCurrent(operation) : !currentOperation);
  const importedPlanEvidence = (candidate: CycleState) => [...candidate.evidence]
    .reverse()
    .find((evidence) => evidence.phase === "plan" && evidence.outcome === "APPROVED" && evidence.approvedPlan);
  const validateImportedPlanLineage = (candidate: CycleState, payload: Record<string, unknown>): CycleRecallValidation => {
    const evidence = importedPlanEvidence(candidate);
    if (!evidence?.approvedPlan) return { valid: true, payload };
    if (!evidence.artifactId) return { valid: false, code: "plan_lineage_invalid" };
    return filterImportedPlanLineage(payload, {
      lifecycleKey: candidate.lifecycleKey,
      source: candidate.source,
      phase: candidate.phase,
      lineage: {
        approvalArtifactId: evidence.artifactId,
        approvedAt: evidence.approvedPlan.approvedAt,
      },
    });
  };
  const stateText = (value: CycleState | null) => statusText(value);
  const notifyState = (ctx: ExtensionContext, value: CycleState | null = state) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(CYCLE_STATUS_KEY, stateText(value));
      ctx.ui.notify(stateText(value), "info");
    }
  };
  const notifyAutonomousStop = (ctx: ExtensionContext, value: CycleState | null = state) => {
    if (value?.mode === "autonomous" && value.status === "blocked") notify(ctx, `Autonomous cycle stopped: ${value.blockers.join(", ") || "phase blocked"}.`, "warning");
  };
  const recoverImportedPlan = async (
    ctx: ExtensionContext,
    candidate: CycleState,
    isCurrent: CycleCurrent,
    appendState: CycleAppend,
    signal?: AbortSignal,
  ): Promise<CycleAdoptionRecoveryResult> => {
    if (!current(isCurrent)) return { ok: false, state: candidate, code: "cycle_operation_cancelled" };
    const planReference = await revalidateImportedPlanReference({
      state: candidate,
      recall: async (query) => mcpResultData(await dependencies.recall(query)),
      isCurrent,
      signal,
    });
    if (!current(isCurrent) || planReference.kind === "cancelled") {
      return { ok: false, state: candidate, code: "cycle_operation_cancelled" };
    }
    if (planReference.kind === "blocked") return { ok: false, state: candidate, code: planReference.code };
    const result = await coordinateCycleRecovery({
      state: candidate,
      recall: dependencies.recall,
      appendState,
      validateRecall: validateImportedPlanLineage,
      isCurrent,
    });
    if (!current(isCurrent)) return { ok: false, state: candidate, code: "cycle_operation_cancelled" };
    return result.ok
      ? { ok: true, state: result.state }
      : {
        ok: false,
        state: result.state ?? candidate,
        code: result.error.code,
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      };
  };
  const runAutonomousTail = async (ctx: ExtensionContext, operation: ActiveCycleOperation) => {
    if (!state || state.mode !== "autonomous" || !operationCurrent(operation)) return;
    const run = { aborted: false, dispatches: 0 };
    const ceiling = CYCLE_PHASES.length + state.reviewCap * 2;
    const isCurrent = () => !run.aborted && operationCurrent(operation);
    autonomousRun = run;
    try {
      while (isCurrent() && state && state.mode === "autonomous" && state.status === "awaiting-resume") {
        if (run.dispatches >= ceiling) {
          notify(ctx, "Autonomous cycle dispatch ceiling reached; cycle state was preserved.", "warning");
          break;
        }
        const resumable = prepareCycleResume(state);
        if (!resumable.ok) break;
        run.dispatches += 1;
        const result = await dispatchCyclePhase({
          state: resumable.state,
          applyRoute: (phase) => dependencies.applyRoute(pi, ctx, phase),
          appendState: appendFor(ctx, isCurrent, operation),
          sendUserMessage: (message, provisional) => sendCycleUserMessage(message, provisional, operation),
          expandPrompt: (value) => dependencies.expandPrompt(value, ctx.cwd),
          isCurrent,
        });
        if (!isCurrent()) return;
        if (!result.ok) {
          if (result.state) state = copyState(result.state);
          notifyState(ctx);
          notify(ctx, result.error.message, "warning");
          break;
        }
        state = copyState(result.state);
        notifyState(ctx);
        notifyAutonomousStop(ctx);
      }
    } finally {
      if (autonomousRun === run) autonomousRun = null;
    }
  };
  const reconcile = async (
    ctx: ExtensionContext,
    options: {
      generation?: number;
      operation?: ActiveCycleOperation | null;
      interactive?: boolean;
    } = {},
  ) => {
    if (!state) return true;
    const operation = options.operation ?? null;
    const generation = options.generation ?? dispatchGeneration;
    const isCurrent = operation
      ? () => operationCurrent(operation)
      : () => generation === dispatchGeneration;
    if (!current(isCurrent)) return false;
    if (pendingDispatch || currentOperation && currentOperation !== operation) return true;

    if (state.phase === "plan") {
      if (!canRecoverPlan(state, operation)) return true;
      const candidate = state;
      const adoption = await requestPlanAdoption(
        ctx,
        candidate,
        options.interactive === true,
        isCurrent,
        operation?.controller.signal,
      );
      if (!current(isCurrent)) return false;
      if (adoption.kind === "approved") {
        const adopted = adoptedPlanState(candidate, adoption, {
          allowAwaitingEvidence: candidate.status === "awaiting-evidence",
        });
        if (!adopted.ok) {
          notify(ctx, sanitizeCycleError(adopted.code).message, "warning");
          return false;
        }
        try {
          await strictAdoptionAppend(ctx, adopted.state, isCurrent, operation);
        } catch {
          if (current(isCurrent)) notify(ctx, sanitizeCycleError("cycle_state_persist_failed").message, "warning");
          return false;
        }
        if (!current(isCurrent)) return false;
        state = copyState(adopted.state);
      } else if (adoption.kind === "no-plan") {
        return candidate.status === "awaiting-evidence" ? false : true;
      } else if (adoption.kind === "confirmation-required") {
        if (options.interactive === true) notify(ctx, sanitizeCycleError("cycle_plan_confirmation_required").message, "warning");
        return false;
      } else if (adoption.kind === "blocked") {
        notify(ctx, sanitizeCycleError(adoption.code).message, "warning");
        return false;
      } else {
        return false;
      }
    }

    const candidate = state;
    const imported = Boolean(importedPlanEvidence(candidate));
    const result = await recoverImportedPlan(
      ctx,
      candidate,
      isCurrent,
      imported
        ? (next) => strictAdoptionAppend(ctx, next, isCurrent, operation)
        : appendFor(ctx, isCurrent, operation),
      operation?.controller.signal,
    );
    if (!current(isCurrent)) return false;
    state = copyState(result.state);
    if (!result.ok) {
      if (ctx.hasUI) ctx.ui.setStatus(CYCLE_STATUS_KEY, stateText(state));
      if (result.code !== "cycle_operation_cancelled") {
        notify(ctx, result.diagnostic
          ? unresolvedOutcomeMessage(result.diagnostic.phase, result.diagnostic.artifactId, result.diagnostic.recordKey)
          : sanitizeCycleError(result.code).message, "warning");
      }
      return false;
    }
    return true;
  };
  const restore = async (ctx: ExtensionContext, reconcileActive: boolean, generation: number) => {
    await publication;
    if (generation !== dispatchGeneration) return;
    let durableState: CycleState | null = null;
    try {
      durableState = await dependencies.loadDurableState(ctx.cwd);
    } catch {
      durableState = null;
    }
    if (generation !== dispatchGeneration) return;
    state = durableState ?? restoreCycleState(ctx.sessionManager.getBranch());
    if (reconcileActive && state) await reconcile(ctx, { generation });
    if (generation !== dispatchGeneration) return;
    if (ctx.hasUI) ctx.ui.setStatus(CYCLE_STATUS_KEY, stateText(state));
  };
  const invalidateAndDrain = async () => {
    const generation = invalidateOperation();
    await publication;
    return generation;
  };
  const warnObservation = (ctx: ExtensionContext, observed: CycleObservationResult) => {
    if (!observed.matched && observed.diagnostic) notify(ctx, unresolvedOutcomeMessage(observed.diagnostic.phase, observed.diagnostic.artifactId, observed.diagnostic.recordKey), "warning");
  };

  pi.on("session_start", async (_event, ctx) => {
    const generation = await invalidateAndDrain();
    await restore(ctx, true, generation);
  });
  pi.on("session_tree", async (_event, ctx) => {
    const generation = await invalidateAndDrain();
    await restore(ctx, false, generation);
  });
  pi.on("session_shutdown", async () => { await invalidateAndDrain(); });
  pi.on("input", (event) => reducePendingDispatch({ type: "input", source: event.source, text: event.text }));
  pi.on("before_agent_start", (event) => reducePendingDispatch({ type: "before-agent-start", prompt: event.prompt }));
  pi.on("agent_start", () => reducePendingDispatch({ type: "agent-start" }));
  pi.on("agent_end", (event) => reducePendingDispatch({ type: "agent-end", messages: event.messages }));
  pi.on("agent_settled", () => reducePendingDispatch({ type: "agent-settled" }));

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "ima_lifecycle") return;
    const observation = { state: state ?? undefined, toolName: event.toolName, toolCallId: event.toolCallId, input: event.input, result: { content: event.content, details: event.details, isError: event.isError } };
    if (pendingDispatch) {
      const observed = observeLifecycleResult({ ...observation, state: pendingDispatch.state });
      if (observed.matched) pendingDispatch.state = copyState(observed.state);
      else warnObservation(ctx, observed);
      return;
    }
    if (!state) return;
    const observed = observeLifecycleResult({ ...observation, state });
    if (!observed.matched) { warnObservation(ctx, observed); return; }
    state = observed.state;
    await appendFor(ctx)(state);
    if (ctx.hasUI) ctx.ui.setStatus(CYCLE_STATUS_KEY, stateText(state));
  });

  pi.registerCommand("ima:cycle", {
    description: "Start, inspect, stop, resume, or explicitly close one IMA lifecycle Story.",
    handler: async (args, ctx) => {
      const parsed = parseCycleCommand(args);
      if (!parsed) { notify(ctx, "Usage: /ima:cycle start [--review-cap 0-10] [--implementation generic|js|wp] [--mode guided|autonomous] <Jira key|Jira browse URL|taskwarrior project uuid|plane:workspace:PROJECT-sequence|plane workspace PROJECT-sequence|Plane browse URL> | status | stop [--ack] | resume [--autonomous|--guided] | close [--commit-prep].", "warning"); return; }
      if (parsed.command === "status") { await reconcile(ctx); notifyState(ctx); return; }
      if (parsed.command === "start") {
        const operation = beginOperation();
        const isCurrent = () => operationCurrent(operation);
        try {
          const result = await coordinateCycleStart({
            source: parsed.source,
            reviewCap: parsed.reviewCap,
            implementationMode: parsed.implementationMode,
            mode: parsed.mode,
            cwd: ctx.cwd,
            activeState: state,
            context: dependencies.context,
            adoptPlan: (candidate) => requestPlanAdoption(ctx, candidate, true, isCurrent, operation.controller.signal),
            recoverAdoptedState: (candidate) => recoverImportedPlan(
              ctx,
              candidate,
              isCurrent,
              (next) => strictAdoptionAppend(ctx, next, isCurrent, operation),
              operation.controller.signal,
            ),
            applyRoute: (phase) => dependencies.applyRoute(pi, ctx, phase),
            appendState: appendFor(ctx, isCurrent, operation),
            persistAdoptionState: (next) => strictAdoptionAppend(ctx, next, isCurrent, operation),
            sendUserMessage: (message, provisional) => sendCycleUserMessage(message, provisional, operation),
            expandPrompt: (message) => dependencies.expandPrompt(message, ctx.cwd),
            isCurrent,
            branchId: ctx.sessionManager.getLeafId() ?? undefined,
          });
          if (!current(isCurrent)) return;
          if (result.ok) {
            state = result.state;
            notifyState(ctx);
            notifyAutonomousStop(ctx);
            if (state.mode === "autonomous") await runAutonomousTail(ctx, operation);
          } else {
            if (result.state) { state = copyState(result.state); notifyState(ctx); }
            notify(ctx, result.error.message, "warning");
          }
        } finally {
          finishOperation(operation);
        }
        return;
      }
      if (parsed.command === "stop") {
        if (
          currentOperation
          && !currentOperation.provisional
          && (!state || ["closed", "blocked-after-tracker-close"].includes(state.status))
        ) {
          invalidateOperation();
          ctx.abort();
          notify(ctx, "Cycle start cancelled before a phase was persisted.", "info");
          return;
        }
        const activeState = currentOperation?.provisional ?? state;
        if (!activeState) {
          if (currentOperation) {
            invalidateOperation();
            ctx.abort();
            notify(ctx, "Cycle start cancelled before a phase was persisted.", "info");
          } else {
            notify(ctx, "No active cycle. Start one first.", "warning");
          }
          return;
        }
        if (!["awaiting-evidence", "awaiting-resume"].includes(activeState.status)) {
          notify(ctx, sanitizeCycleError("cycle_stop_unavailable").message, "warning");
          return;
        }
        if (WRITE_CAPABLE_PHASES.has(activeState.phase) && activeState.mode !== "autonomous" && !parsed.acknowledge) {
          notify(ctx, sanitizeCycleError("cycle_stop_ack_required").message, "warning");
          return;
        }
        const operation = beginOperation();
        const isCurrent = () => operationCurrent(operation);
        try {
          const result = await coordinateCycleStop({
            state: activeState,
            acknowledge: parsed.acknowledge,
            appendState: appendFor(ctx, isCurrent, operation),
            abort: () => ctx.abort(),
          });
          if (!current(isCurrent)) return;
          if (result.ok) {
            state = result.state;
            notifyState(ctx);
          } else {
            notify(ctx, result.error.message, "warning");
          }
        } finally {
          finishOperation(operation);
        }
        return;
      }
      if (!state) { notify(ctx, "No active cycle. Start one first.", "warning"); return; }
      if (parsed.command === "resume") {
        if (pendingDispatch || currentOperation) {
          notify(ctx, sanitizeCycleError("cycle_resume_unavailable").message, "warning");
          return;
        }
        const operation = beginOperation();
        const isCurrent = () => operationCurrent(operation);
        try {
          if (!state) return;
          if (parsed.mode) {
            const candidate = { ...state, mode: parsed.mode, updatedAt: nowIso() };
            await appendFor(ctx, isCurrent, operation)(candidate);
            if (!current(isCurrent)) return;
            state = copyState(candidate);
          }
          if (!(await reconcile(ctx, { operation, interactive: true })) || !current(isCurrent) || !state) return;
          const resumable = prepareCycleResume(state);
          if (!resumable.ok) { notify(ctx, resumable.error.message, "warning"); return; }
          const result = await dispatchCyclePhase({
            state: resumable.state,
            applyRoute: (phase) => dependencies.applyRoute(pi, ctx, phase),
            appendState: appendFor(ctx, isCurrent, operation),
            sendUserMessage: (message, provisional) => sendCycleUserMessage(message, provisional, operation),
            expandPrompt: (value) => dependencies.expandPrompt(value, ctx.cwd),
            isCurrent,
          });
          if (!current(isCurrent)) return;
          if (result.ok) {
            state = result.state;
            notifyState(ctx);
            notifyAutonomousStop(ctx);
            if (state.mode === "autonomous") await runAutonomousTail(ctx, operation);
          } else {
            if (result.state) { state = copyState(result.state); notifyState(ctx); }
            notify(ctx, result.error.message, "warning");
          }
        } finally {
          finishOperation(operation);
        }
        return;
      }
      if (parsed.command === "close") {
        let confirmed = true;
        if (!parsed.commitPrep) {
          if (ctx.mode !== "tui") { notify(ctx, "Cycle close requires TUI confirmation.", "warning"); return; }
          confirmed = await ctx.ui.confirm("Close cycle", `Close ${cycleSourceReference(state.source)} and mark its single tracker source complete?`);
        }
        const result = await coordinateCycleClose({ state, mode: ctx.mode, commitPrep: parsed.commitPrep, confirmed, run: (program, commandArgs) => pi.exec(program, commandArgs), appendState: appendFor(ctx) });
        if (result.ok) { if (result.state) state = result.state; notifyState(ctx, result.state ?? state); } else { if (result.state) state = result.state; notify(ctx, result.error.message, "warning"); }
      }
    },
  });
}

export default function cycle(pi: ExtensionAPI) {
  registerCycleExtension(pi);
}
