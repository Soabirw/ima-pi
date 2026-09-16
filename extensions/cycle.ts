import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyConfiguredCycleOrchestratorRoute,
  latestSessionProfile,
  resolveConfiguredCyclePhaseRoute,
} from "./workflow-routing.ts";
import {
  coordinateContext,
  coordinateLifecycle,
  mcpResultData,
  recallLifecycle,
  resolveLifecycleLineage,
  type LifecycleRoutingOptions,
} from "./integrations.ts";
import {
  CYCLE_ENTRY,
  CYCLE_PHASES,
  CYCLE_REVIEW_CAP_DEFAULT,
  IMA_PROJECT,
  buildCycleStatus,
  buildResumeSource,
  createCycleState,
  cycleLifecycleKey,
  cycleSourceReference,
  normalizeCycleSource,
  parseCycleCommand,
  prepareCycleResume,
  requiredCloseoutEvidence,
  sanitizeCycleError,
  validateCycleState,
  type CycleImplementationMode,
  type CycleMode,
  type CyclePhase,
  type CycleSource,
  type CycleState,
} from "../lib/ima-cycle.ts";
import {
  normalizeLifecycleProvider,
  resolveLifecycleProviderRecommendation,
  type LifecycleProviderName,
} from "../lib/ima-lifecycle-selection.ts";
import { createLifecycleProviderPinAttempt } from "../lib/ima-lifecycle-pin.ts";
import {
  beginLifecyclePinWith,
  loadLifecyclePinStateWith,
  type LifecyclePinLoadResult,
} from "../lib/ima-lifecycle-pin-store.ts";
import {
  defaultResolveCycleProjectRoot,
  loadDurableStateWith,
  persistDurableStateWith,
  type CyclePersistenceOptions,
  type ResolveCycleProjectRoot,
} from "../lib/ima-cycle-persistence.ts";
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
import {
  canResumeCyclePhaseExecution,
  createCyclePhaseExecution,
  hasMatchingCyclePhaseExecution,
  hasMatchingCyclePhaseSettlement,
  validateCyclePhaseArtifactReference,
  withCyclePhaseExecution,
  type CyclePhaseArtifactReference,
  type CyclePhaseContext,
  type CyclePhaseRoute,
} from "../lib/ima-cycle-phase.ts";
import {
  createCyclePhaseRuntime,
  readCyclePhaseSettlement,
  type CyclePhaseLifecycleAcceptance,
  type CyclePhaseRuntime,
} from "../lib/ima-cycle-phase-runtime.ts";
import {
  buildCyclePhaseCompletion,
  buildCyclePhaseWidget,
  buildCycleStartAck,
  describeCycleBlockers,
  describeCyclePhaseActivity,
} from "../lib/ima-cycle-feedback.ts";
import {
  coordinateCycleClose as coordinateCycleCloseCore,
  identityForCycleSource as identityForSource,
  type CycleCloseInput,
} from "../lib/ima-cycle-close.ts";
import {
  coordinateCycleReconcile,
  coordinateCycleRecovery,
  observeLifecycleResult,
  type CycleObservationDiagnostic,
  type CycleObservationInput,
  type CycleObservationResult,
  type CycleRecall,
  type CycleRecallValidation,
  type CycleReconcileInput,
  type CycleReconcileResult,
} from "../lib/ima-cycle-evidence.ts";

export {
  coordinateCycleReconcile,
  coordinateCycleRecovery,
  observeLifecycleResult,
};
export type { CycleCloseInput } from "../lib/ima-cycle-close.ts";
export type {
  CycleObservationDiagnostic,
  CycleObservationInput,
  CycleObservationResult,
  CycleRecall,
  CycleRecallValidation,
  CycleReconcileInput,
  CycleReconcileResult,
};

export const coordinateCycleClose = async (input: CycleCloseInput) =>
  coordinateCycleCloseCore({
    ...input,
    resolveLineage: input.resolveLineage ?? ((lifecycleKey) => resolveLifecycleLineage(
      lifecycleKey,
      input.cwd ? { cwd: input.cwd } : undefined,
    )),
    lifecycle: input.lifecycle ?? ((request) => coordinateLifecycle(
      request,
      input.cwd ? { cwd: input.cwd } : undefined,
    )),
  });

export const CYCLE_STATUS_KEY = "ima-cycle";
export const CYCLE_WIDGET_KEY = "ima-cycle-phase";
const CYCLE_WIDGET_OPTIONS = { placement: "belowEditor" } as const;
const WRITE_CAPABLE_PHASES = new Set<CyclePhase>(["implementation", "test", "resolution", "document"]);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nowIso = () => new Date().toISOString();
const safeError = (code: string) => ({ ok: false as const, error: sanitizeCycleError(code) });
const PHASE_STARTUP_ERRORS = new Set([
  "phase_model_unavailable",
  "phase_resource_provenance_mismatch",
  "phase_runtime_identity_mismatch",
  "phase_thinking_unsupported",
  "phase_toolkit_missing",
]);
const phaseInjectionError = (error: unknown) => {
  const code = error instanceof Error ? error.message : "";
  return safeError(PHASE_STARTUP_ERRORS.has(code) ? code : "cycle_phase_injection_failed");
};
const safeResultError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "phase_runtime_failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 256) || "phase_runtime_failed";
};
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
export type CycleRouteResult = { ok: true; route?: CyclePhaseRoute } | { ok: false; error: string; message?: string; rollback?: string };
export type CycleAppend = (state: CycleState) => void | Promise<void>;
export type CyclePrepareDispatch = (state: CycleState, route?: CyclePhaseRoute) => CycleState;
export type CycleSend = (message: string, provisionalState: CycleState) => Promise<CycleState>;
export type CycleExpand = (message: string) => string | Promise<string>;
export type CycleRoute = (phase: CyclePhase) => Promise<CycleRouteResult>;
export type CyclePlanAdopter = (state: CycleState) => Promise<PlanAdoptionResult>;
export type CycleCurrent = () => boolean;

const current = (isCurrent?: CycleCurrent) => isCurrent?.() ?? true;
const requireCurrent = (isCurrent?: CycleCurrent) => {
  if (!current(isCurrent)) throw new Error("cycle_state_stale");
};

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
  lifecycleProvider?: LifecycleProviderName;
  lifecycleProviderAttemptId?: string;
  context?: (request: unknown, cwd: string) => Promise<CycleContextResult>;
  adoptPlan?: CyclePlanAdopter;
  recoverAdoptedState?: (state: CycleState) => Promise<CycleAdoptionRecoveryResult>;
  applyRoute: CycleRoute;
  appendState: CycleAppend;
  persistAdoptionState?: CycleAppend;
  sendUserMessage: CycleSend;
  prepareDispatch?: CyclePrepareDispatch;
  expandPrompt?: CycleExpand;
  isCurrent?: CycleCurrent;
  timestamp?: string;
};

type CycleCoordinatorResult = { ok: true; state: CycleState; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError>; state?: CycleState };

const sameCycleSource = (left: CycleSource, right: CycleSource) => cycleSourceReference(left) === cycleSourceReference(right);

const reusablePlanningState = (stateValue: CycleState, source: CycleSource, input: CycleStartInput) => {
  const valid = validateCycleState(stateValue);
  if (!valid.valid || !sameCycleSource(valid.state.source, source) || valid.state.phase !== "plan" || valid.state.execution) return null;
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
  || (input.implementationMode !== undefined && input.implementationMode !== state.implementationMode)
  || (input.lifecycleProvider !== undefined && input.lifecycleProvider !== state.lifecycleProvider)
  || (input.lifecycleProviderAttemptId !== undefined && input.lifecycleProviderAttemptId !== state.lifecycleProviderAttemptId);

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
  const independentNonSerenaContext = hydrated.status === "degraded"
    && input.lifecycleProvider !== undefined
    && input.lifecycleProvider !== "serena"
    && hydrated.source !== undefined;
  if (hydrated.status !== "ready" && !independentNonSerenaContext) return safeError("cycle_context_not_ready");

  let state: CycleState;
  try {
    state = existing ?? createCycleState(source, {
      lifecycleKey: input.lifecycleKey,
      reviewCap: input.reviewCap,
      implementationMode: input.implementationMode,
      mode: input.mode,
      branchId: input.branchId,
      lifecycleProvider: input.lifecycleProvider,
      lifecycleProviderAttemptId: input.lifecycleProviderAttemptId,
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
        prepareDispatch: input.prepareDispatch,
        expandPrompt: input.expandPrompt,
        isCurrent: input.isCurrent,
        timestamp: input.timestamp,
      });
      return dispatched.ok
        ? { ...dispatched, message: `Cycle started from approved plan for ${cycleSourceReference(source)}.` }
        : { ...dispatched, state: dispatched.state ?? recovered.state };
    }
    if (adoption.kind === "blocked") return { ...safeError(adoption.code), ...(existing ? { state } : {}) };
    if (adoption.kind === "selection-required") return { ...safeError("cycle_plan_selection_required"), ...(existing ? { state } : {}) };
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
  let prepared: CycleState;
  try {
    prepared = input.prepareDispatch ? input.prepareDispatch(copyState(state), route.route) : state;
  } catch {
    return safeError("cycle_phase_dispatch_prepare_failed");
  }
  const command = buildResumeSource({ ...prepared, status: "awaiting-resume" }) ?? "/ima:plan";
  const provisional = copyState(prepared);
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
  } catch (error) {
    return { ...phaseInjectionError(error), state: provisional };
  }
}

export type CycleDispatchInput = {
  state: CycleState;
  applyRoute: CycleRoute;
  appendState: CycleAppend;
  sendUserMessage: CycleSend;
  prepareDispatch?: CyclePrepareDispatch;
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
  let prepared: CycleState;
  try {
    prepared = input.prepareDispatch ? input.prepareDispatch(copyState(state), route.route) : state;
  } catch {
    return safeError("cycle_phase_dispatch_prepare_failed");
  }
  const provisional = copyState(prepared);
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
  } catch (error) {
    return { ...phaseInjectionError(error), state: provisional };
  }
}

export type CycleStopInput = {
  state: CycleState;
  acknowledge: boolean;
  appendState: CycleAppend;
  abort: () => void | Promise<void>;
  updateStoppedState?: (state: CycleState) => CycleState;
  timestamp?: string;
};

export async function coordinateCycleStop(input: CycleStopInput): Promise<{ ok: true; state: CycleState; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError> }> {
  if (!["awaiting-evidence", "awaiting-resume"].includes(input.state.status)) return safeError("cycle_stop_unavailable");
  if (WRITE_CAPABLE_PHASES.has(input.state.phase) && input.state.mode !== "autonomous" && !input.acknowledge) return safeError("cycle_stop_ack_required");
  const stopped: CycleState = {
    ...copyState(input.state),
    status: "stopped",
    stoppedAt: input.timestamp ?? nowIso(),
    stoppedPhase: input.state.phase,
    updatedAt: input.timestamp ?? nowIso(),
  };
  const state = input.updateStoppedState?.(stopped) ?? stopped;
  await input.appendState(copyState(state));
  await input.abort();
  return { ok: true, state, message: `Cycle stopped during ${state.phase}.` };
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

const routeFor = (pi: ExtensionAPI, ctx: ExtensionContext, parentRoute: CyclePhaseRoute | null): CycleRoute => async (phase) => {
  const profile = latestSessionProfile(ctx.sessionManager.getBranch());
  const parent = parentRoute ?? (ctx.model
    ? {
      provider: ctx.model.provider,
      model: ctx.model.id,
      thinking: pi.getThinkingLevel(),
      profile,
      source: "parent" as const,
    }
    : null);
  if (!parent) return { ok: false, error: "parent_model_unavailable", message: "Cycle phase routing requires an active parent model." };
  return resolveConfiguredCyclePhaseRoute(ctx, cycleRoutePhase(phase), parent, profile);
};


export type CycleExtensionDependencies = {
  context: (request: unknown, cwd: string) => Promise<CycleContextResult>;
  applyRoute: (pi: ExtensionAPI, ctx: ExtensionContext, phase: CyclePhase, parentRoute?: CyclePhaseRoute | null) => Promise<CycleRouteResult>;
  expandPrompt: (value: string, cwd: string) => Promise<string>;
  createPhaseRuntime: typeof createCyclePhaseRuntime;
  readPhaseSettlement: typeof readCyclePhaseSettlement;
  recall: (query: string, cwd?: string, signal?: AbortSignal) => Promise<unknown>;
  resolveLifecycleLineage: typeof resolveLifecycleLineage;
  lifecycle: (request: PlanApprovalPersistenceRequest, options?: LifecycleRoutingOptions) => Promise<unknown>;
  resolveProjectRoot: ResolveCycleProjectRoot;
  loadDurableState: (cwd: string) => Promise<CycleState | null>;
  persistDurableState: (cwd: string, state: CycleState, options?: CyclePersistenceOptions) => Promise<void>;
};

const defaultCycleExtensionDependencies: CycleExtensionDependencies = {
  context: (request, cwd) => coordinateContext(request, cwd) as Promise<CycleContextResult>,
  applyRoute: (pi, ctx, phase, parentRoute) => routeFor(pi, ctx, parentRoute ?? null)(phase),
  expandPrompt: expandCyclePromptFromResources,
  createPhaseRuntime: createCyclePhaseRuntime,
  readPhaseSettlement: readCyclePhaseSettlement,
  recall: (query, cwd, signal) => recallLifecycle(query, cwd, undefined, signal),
  resolveLifecycleLineage,
  lifecycle: (request, options) => coordinateLifecycle(request, options),
  resolveProjectRoot: defaultResolveCycleProjectRoot,
  loadDurableState: loadDurableStateWith(defaultResolveCycleProjectRoot),
  persistDurableState: persistDurableStateWith(defaultResolveCycleProjectRoot),
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
  type ActivePhaseRuntime = {
    dispatchId: string;
    host: CyclePhaseRuntime;
    state: CycleState;
    bufferedState: CycleState | null;
    acceptance: CyclePhaseArtifactReference | null;
    operation: ActiveCycleOperation | null;
    cleanup: Promise<boolean> | null;
  };
  let pendingDispatch: PendingDispatch | null = null;
  let activePhase: ActivePhaseRuntime | null = null;
  let autonomousRun: { aborted: boolean; dispatches: number } | null = null;
  let currentOperation: ActiveCycleOperation | null = null;
  let orchestratorRoute: CyclePhaseRoute | null = null;
  let dispatchGeneration = 0;
  let publication: Promise<void> = Promise.resolve();
  const presentPhaseQuestion = (ctx: ExtensionContext, output: string) => {
    const content = output.trim() ? output.slice(0, 4_000) : "Cycle phase is waiting for operator input.";
    const message = `${content}\n\nReply with \`/ima:cycle reply <answer>\`.`;
    try {
      pi.sendMessage({
        customType: "ima-cycle-phase-question",
        content: message,
        display: true,
      });
    } catch {
      notify(ctx, message, "info");
    }
  };
  const hasCycleWidget = (ctx: ExtensionContext) => ctx.hasUI && typeof ctx.ui.setWidget === "function";
  const clearCycleWidget = (ctx: ExtensionContext) => {
    if (hasCycleWidget(ctx)) ctx.ui.setWidget(CYCLE_WIDGET_KEY, undefined, CYCLE_WIDGET_OPTIONS);
  };
  const renderCycleWidget = (
    ctx: ExtensionContext,
    value: CycleState | null,
    options: {
      activity?: string;
      actual?: { provider: string; model: string; thinking?: CyclePhaseRoute["thinking"] };
    } = {},
  ) => {
    if (!hasCycleWidget(ctx)) return;
    const status = value ? buildCycleStatus(value) : null;
    if (!status || status.status === "invalid") {
      clearCycleWidget(ctx);
      return;
    }
    const lines = buildCyclePhaseWidget({
      status: status.status,
      source: status.source,
      phase: status.phase,
      nextPhase: status.nextPhase,
      mode: status.mode,
      reviewAttempts: status.reviewAttempts,
      reviewCap: status.reviewCap,
      route: value.execution?.route,
      activity: options.activity,
      actual: options.actual,
      blockers: status.blockers,
    });
    if (lines.length) ctx.ui.setWidget(CYCLE_WIDGET_KEY, lines, CYCLE_WIDGET_OPTIONS);
    else clearCycleWidget(ctx);
  };
  const presentPhaseCompletion = (ctx: ExtensionContext, phase: CyclePhase, actual: { provider: string; model: string; thinking: NonNullable<CyclePhaseRoute["thinking"]> }) => {
    const message = buildCyclePhaseCompletion(phase, actual);
    try {
      pi.sendMessage({
        customType: "ima-cycle-phase-completion",
        content: message,
        display: true,
      });
    } catch {
      notify(ctx, message, "info");
    }
  };
  const operationCurrent = (operation: ActiveCycleOperation) =>
    currentOperation === operation
    && operation.generation === dispatchGeneration
    && !operation.controller.signal.aborted;
  const cancelPendingDispatch = (code: string) => {
    const pending = pendingDispatch;
    if (pending) pending.reject(new Error(code));
  };
  const settleActivePhase = async (active: ActivePhaseRuntime, abort: boolean) => {
    if (!active.cleanup) {
      active.cleanup = (async () => {
        try {
          if (abort) await active.host.abort();
          else await active.host.dispose();
        } catch {
          return false;
        }
        if (activePhase === active) activePhase = null;
        return true;
      })();
    }
    return active.cleanup;
  };
  const cleanupWarning = (ctx: ExtensionContext) => {
    notify(ctx, "Cycle phase cleanup is unsettled; ownership is retained and no replacement may start.", "warning");
  };
  const abortActivePhase = async (ctx?: ExtensionContext) => {
    const active = activePhase;
    if (!active) return true;
    const settled = await settleActivePhase(active, true);
    if (!settled && ctx) cleanupWarning(ctx);
    return settled;
  };
  const invalidateOperation = (preservePhase = false) => {
    dispatchGeneration += 1;
    const operation = currentOperation;
    currentOperation = null;
    operation?.controller.abort();
    if (autonomousRun) autonomousRun.aborted = true;
    cancelPendingDispatch("cycle_operation_cancelled");
    if (!preservePhase) void abortActivePhase();
    return dispatchGeneration;
  };
  const beginOperation = (preservePhase = false) => {
    invalidateOperation(preservePhase);
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
  const strictAppendFor = (
    ctx: ExtensionContext,
    isCurrent?: CycleCurrent,
    operation: ActiveCycleOperation | null = null,
  ): CycleAppend => async (next) => publishState(ctx, next, { strict: true, isCurrent, operation });
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
  const phaseRuntimeAvailable = (ctx: ExtensionContext) => Boolean(
    ctx.model
      && ctx.modelRegistry
      && typeof ctx.isProjectTrusted === "function",
  );
  const authorizeLifecycleProvider = async (
    ctx: ExtensionContext,
    source: CycleSource,
    requested: { provider?: LifecycleProviderName; attemptId?: string } = {},
  ): Promise<{ provider?: LifecycleProviderName; attemptId?: string } | null> => {
    if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.select !== "function") return {};
    const lifecycleKey = cycleLifecycleKey(source);
    let authority: LifecyclePinLoadResult;
    try {
      authority = await loadLifecyclePinStateWith(dependencies.resolveProjectRoot)(ctx.cwd, lifecycleKey);
    } catch {
      return null;
    }
    if (authority.status === "pinned") {
      return requested.provider && requested.provider !== authority.pin.provider
        ? null
        : { provider: authority.pin.provider };
    }
    if (authority.status === "pending") {
      return authority.attempt.status === "authorized"
        && requested.provider === authority.attempt.provider
        && requested.attemptId === authority.attempt.attemptId
        ? { provider: authority.attempt.provider, attemptId: authority.attempt.attemptId }
        : null;
    }
    if (authority.status !== "absent") return null;
    if (requested.attemptId) return null;
    if (!phaseRuntimeAvailable(ctx)) return {};
    const resolved = resolveLifecycleProviderRecommendation();
    if (!resolved.ok) return null;
    const recommendation = resolved.recommendation;
    const choice = requested.provider ?? await ctx.ui.select(
      "Select lifecycle provider",
      recommendation.candidates,
    );
    const provider = normalizeLifecycleProvider(choice);
    if (!provider || !recommendation.candidates.includes(provider)) return null;
    const sharing = provider === "bookstack"
      ? " BookStack shares lifecycle evidence with the configured organization content."
      : "";
    const confirmed = await ctx.ui.confirm(
      "Confirm lifecycle provider",
      `Use ${provider} from ${recommendation.source === "default" ? "built-in default" : `${recommendation.source} preference`}?${sharing}`,
    );
    if (!confirmed) return null;
    const attempt = createLifecycleProviderPinAttempt({
      lifecycleKey,
      provider,
      attemptId: randomUUID(),
      startedAt: nowIso(),
    });
    if (!attempt) return null;
    const started = await beginLifecyclePinWith(dependencies.resolveProjectRoot)(ctx.cwd, attempt);
    if (started.status === "started") {
      return { provider: started.attempt.provider, attemptId: started.attempt.attemptId };
    }
    if (
      started.status === "pending"
      && started.attempt.status === "authorized"
      && started.attempt.provider === provider
      && started.attempt.attemptId === attempt.attemptId
    ) {
      return { provider: started.attempt.provider, attemptId: started.attempt.attemptId };
    }
    if (started.status === "pinned" && started.pin.provider === provider) {
      return { provider: started.pin.provider };
    }
    return null;
  };
  const preparePhaseDispatch = (ctx: ExtensionContext): CyclePrepareDispatch => (candidate, route) => {
    if (!route) throw new Error("phase_route_unavailable");
    const timestamp = nowIso();
    const execution = createCyclePhaseExecution({
      dispatchId: randomUUID(),
      phase: candidate.phase,
      route,
      parentSessionId: text((ctx.sessionManager as any).getSessionId?.()) || `parent:${randomUUID()}`,
      status: "starting",
      possiblePartialWrite: WRITE_CAPABLE_PHASES.has(candidate.phase),
      startedAt: timestamp,
      updatedAt: timestamp,
    });
    if (!execution) throw new Error("phase_execution_invalid");
    return { ...candidate, execution };
  };
  const updatePhaseExecution = (
    candidate: CycleState,
    patch: Parameters<typeof withCyclePhaseExecution>[1],
  ): CycleState => {
    if (!candidate.execution) throw new Error("phase_execution_missing");
    const execution = withCyclePhaseExecution(candidate.execution, patch);
    if (!execution) throw new Error("phase_execution_invalid");
    return { ...candidate, execution };
  };
  const phaseContext = (candidate: CycleState, execution: NonNullable<CycleState["execution"]>): CyclePhaseContext => ({
    schemaVersion: 1,
    project: IMA_PROJECT,
    lifecycleKey: candidate.lifecycleKey,
    source: cycleSourceReference(candidate.source),
    phase: execution.phase,
    dispatchId: execution.dispatchId,
  });
  const phaseIdentityMatches = (active: ActivePhaseRuntime, outcome: Awaited<ReturnType<CyclePhaseRuntime["run"]>>) => {
    const execution = active.state.execution;
    return Boolean(
      execution
        && outcome.identity.childSessionId === execution.childSessionId
        && outcome.identity.childSessionFile === execution.childSessionFile
        && outcome.identity.childSessionDir === execution.childSessionDir,
    );
  };
  const acceptedSettlement = (active: ActivePhaseRuntime, outcome: Awaited<ReturnType<CyclePhaseRuntime["run"]>>) => {
    const execution = active.state.execution;
    const evidence = active.bufferedState?.evidence.at(-1);
    if (!execution || !evidence || !active.acceptance || !outcome.settlement || !phaseIdentityMatches(active, outcome)) return false;
    if (!validateCyclePhaseArtifactReference(active.acceptance)) return false;
    if (evidence.phase !== execution.phase || evidence.artifactId !== active.acceptance.artifactId || evidence.recordKey !== active.acceptance.recordKey) return false;
    return hasMatchingCyclePhaseSettlement({
      settlement: outcome.settlement,
      execution,
      context: phaseContext(active.state, execution),
      artifact: active.acceptance,
    });
  };
  const finishPhaseRuntime = async (
    ctx: ExtensionContext,
    active: ActivePhaseRuntime,
    outcome: Awaited<ReturnType<CyclePhaseRuntime["run"]>>,
  ): Promise<CycleState | null> => {
    if (outcome.status === "busy") {
      active.operation = null;
      return null;
    }
    const settled = outcome.status === "settled" && outcome.acceptedEvidence && acceptedSettlement(active, outcome);
    if (settled && active.bufferedState) {
      const phaseState = updatePhaseExecution(active.bufferedState, { status: "settled", updatedAt: nowIso() });
      if (outcome.output) notify(ctx, outcome.output.slice(0, 4_000), "info");
      renderCycleWidget(ctx, active.state, { actual: outcome.settlement.actual });
      presentPhaseCompletion(ctx, active.state.phase, outcome.settlement.actual);
      if (!(await settleActivePhase(active, false))) {
        const failedExecution = updatePhaseExecution(active.state, { status: "failed", updatedAt: nowIso() });
        const cleanupBlockedState = { ...failedExecution, status: "awaiting-resume" as const, updatedAt: nowIso() };
        active.state = cleanupBlockedState;
        cleanupWarning(ctx);
        return cleanupBlockedState;
      }
      active.state = phaseState;
      return phaseState;
    }
    if (outcome.status === "waiting-reply") {
      const phaseState = updatePhaseExecution(active.state, { status: "waiting-reply", updatedAt: nowIso() });
      active.state = phaseState;
      active.operation = null;
      presentPhaseQuestion(ctx, outcome.output);
      return phaseState;
    }
    const status = outcome.status === "aborted" ? "interrupted" : "failed";
    let phaseState = updatePhaseExecution(active.state, { status, updatedAt: nowIso() });
    phaseState = { ...phaseState, status: "awaiting-resume", updatedAt: nowIso() };
    active.state = phaseState;
    if (outcome.output) notify(ctx, outcome.output.slice(0, 4_000), "warning");
    const error = outcome.error ?? (outcome.status === "settled" ? "phase_settlement_unverified" : undefined);
    if (error) notify(ctx, `Cycle phase ${active.state.execution?.phase ?? "unknown"} ended without verified evidence: ${error}.`, "warning");
    if (!(await settleActivePhase(active, true))) cleanupWarning(ctx);
    return phaseState;
  };
  const createPhaseCallbacks = (
    ctx: ExtensionContext,
    holder: { state: CycleState; active: ActivePhaseRuntime | null },
    execution: NonNullable<CycleState["execution"]>,
    operation: ActiveCycleOperation | null,
  ) => ({
    onStarted: async (identity: Awaited<ReturnType<typeof createCyclePhaseRuntime>>["identity"]) => {
      if (operation && !operationCurrent(operation)) throw new Error("cycle_operation_cancelled");
      holder.state = updatePhaseExecution(holder.state, {
        ...identity,
        status: "running",
        updatedAt: nowIso(),
      });
      renderCycleWidget(ctx, holder.state, { activity: "phase agent started" });
      await strictAppendFor(ctx, operation ? () => operationCurrent(operation) : undefined, operation)(holder.state);
    },
    onLifecycle: async (event: Parameters<NonNullable<Parameters<typeof createCyclePhaseRuntime>[0]["onLifecycle"]>>[0]): Promise<CyclePhaseLifecycleAcceptance | null> => {
      const active = holder.active;
      const activeOperation = active?.operation ?? operation;
      if (!active || activeOperation && !operationCurrent(activeOperation)) return null;
      const activeExecution = active.state.execution;
      if (!activeExecution || !hasMatchingCyclePhaseExecution({
        execution: activeExecution,
        phase: execution.phase,
        dispatchId: execution.dispatchId,
      })) return null;
      const observed = observeLifecycleResult({
        state: active.state,
        toolName: "ima_lifecycle",
        toolCallId: event.toolCallId,
        input: event.input,
        result: event.result,
      });
      if (!observed.matched) {
        warnObservation(ctx, observed);
        return null;
      }
      const acceptance = {
        artifactId: observed.evidence.artifactId,
        recordKey: observed.evidence.recordKey,
      };
      if (!validateCyclePhaseArtifactReference(acceptance)) return null;
      active.bufferedState = { ...observed.state, execution: activeExecution };
      active.acceptance = acceptance;
      return acceptance;
    },
    onActivity: (message: string) => {
      renderCycleWidget(ctx, holder.state, { activity: describeCyclePhaseActivity(message) });
    },
  });
  const sendCyclePhaseMessage = async (
    ctx: ExtensionContext,
    message: string,
    provisionalState: CycleState,
    operation: ActiveCycleOperation | null = null,
  ) => {
    if (activePhase) throw new Error("cycle_phase_ownership_retained");
    if (!phaseRuntimeAvailable(ctx)) return sendCycleUserMessage(message, provisionalState, operation);
    if (operation && !operationCurrent(operation)) throw new Error("cycle_operation_cancelled");
    const execution = provisionalState.execution;
    if (!execution || !hasMatchingCyclePhaseExecution({ execution, phase: provisionalState.phase, dispatchId: execution.dispatchId })) {
      throw new Error("phase_execution_missing");
    }
    const holder = { state: copyState(provisionalState), active: null as ActivePhaseRuntime | null };
    let active: ActivePhaseRuntime | null = null;
    try {
      const host = await dependencies.createPhaseRuntime({
        cwd: ctx.cwd,
        route: execution.route,
        execution,
        context: phaseContext(provisionalState, execution),
        projectTrusted: ctx.isProjectTrusted(),
        ...createPhaseCallbacks(ctx, holder, execution, operation),
      });
      if (operation && !operationCurrent(operation)) {
        await host.abort();
        throw new Error("cycle_operation_cancelled");
      }
      active = {
        dispatchId: execution.dispatchId,
        host,
        state: holder.state,
        bufferedState: null,
        acceptance: null,
        operation,
        cleanup: null,
      };
      holder.active = active;
      activePhase = active;
      const result = await host.run(message);
      if (operation && !operationCurrent(operation)) {
        await settleActivePhase(active, true);
        throw new Error("cycle_operation_cancelled");
      }
      const completed = await finishPhaseRuntime(ctx, active, result);
      if (ctx.hasUI && !["waiting-reply", "busy"].includes(result.status)) clearCycleWidget(ctx);
      return completed ?? active.state;
    } catch (error) {
      if (operation && !operationCurrent(operation)) throw error;
      if (!active) throw error;
      const failed = await finishPhaseRuntime(ctx, active, {
        status: "failed",
        acceptedEvidence: false,
        output: "",
        identity: active.host.identity,
        error: safeResultError(error),
      });
      return failed ?? active.state;
    }
  };
  const replyToCyclePhase = async (
    ctx: ExtensionContext,
    answer: string,
    operation: ActiveCycleOperation,
  ) => {
    const active = activePhase;
    if (!active || !state?.execution || active.dispatchId !== state.execution.dispatchId || active.operation || state.execution.status !== "waiting-reply") return null;
    const replyState = updatePhaseExecution(active.state, { status: "running", updatedAt: nowIso() });
    active.operation = operation;
    try {
      await strictAppendFor(ctx, () => operationCurrent(operation), operation)(replyState);
    } catch {
      if (active.operation === operation) active.operation = null;
      if (operationCurrent(operation)) {
        notify(ctx, "Cycle reply intent could not be persisted; no reply was sent.", "warning");
      }
      return null;
    }
    if (!operationCurrent(operation)) {
      if (active.operation === operation) active.operation = null;
      return null;
    }
    active.state = replyState;
    state = copyState(replyState);
    const outcome = await active.host.reply(answer);
    if (!operationCurrent(operation)) return null;
    const completed = await finishPhaseRuntime(ctx, active, outcome);
    if (ctx.hasUI && !["waiting-reply", "busy"].includes(outcome.status)) clearCycleWidget(ctx);
    return completed;
  };
  const resumeCyclePhaseRuntime = async (
    ctx: ExtensionContext,
    candidate: CycleState,
    operation: ActiveCycleOperation,
  ): Promise<CycleState | null> => {
    const execution = candidate.execution;
    if (!canResumeCyclePhaseExecution(execution) || !execution) return null;
    try {
      return await sendCyclePhaseMessage(ctx, [
        "This isolated lifecycle phase is resuming after an explicit operator request.",
        "Do not repeat prior effects blindly. Reconcile the persisted lifecycle evidence and current repository state before continuing.",
        "Continue only the existing bounded phase and persist a valid lifecycle result when safe.",
      ].join("\n"), candidate, operation);
    } catch (error) {
      if (operationCurrent(operation)) notify(ctx, `Cycle phase recovery could not start: ${error instanceof Error ? error.message : "unknown error"}.`, "warning");
      return null;
    }
  };
  const ensureOrchestratorRoute = async (ctx: ExtensionContext): Promise<CycleRouteResult> => {
    if (!phaseRuntimeAvailable(ctx)) {
      orchestratorRoute = null;
      return { ok: true };
    }
    const profile = latestSessionProfile(ctx.sessionManager.getBranch());
    const resolved = await applyConfiguredCycleOrchestratorRoute(pi, ctx, profile);
    if (!resolved.ok) return resolved;
    orchestratorRoute = resolved.route;
    return { ok: true, route: resolved.route };
  };
  const lifecycleRoutingOptions = (ctx: ExtensionContext): LifecycleRoutingOptions => ({
    cwd: ctx.cwd,
    ...(ctx.mode === "tui" && ctx.hasUI
      ? {
        confirmProvider: async ({ recommendation, provider }: { recommendation: { source: string }; provider: string }) => ctx.ui.confirm(
          "Confirm lifecycle provider",
          `Use ${provider} from ${recommendation.source === "default" ? "built-in default" : `${recommendation.source} preference`}?${provider === "bookstack" ? " BookStack shares lifecycle evidence with the configured organization content." : ""}`,
        ),
        confirmBookStackPlacement: async (preview: any) => ctx.ui.confirm(
          "Approve BookStack lifecycle placement",
          typeof preview?.sharingImplications === "string"
            ? preview.sharingImplications
            : "Approve the shared BookStack lifecycle placement?",
        ),
      }
      : {}),
  });
  const confirmLegacyPlan = async (ctx: ExtensionContext, plan: VerifiedPlanRecord) => {
    if (ctx.mode !== "tui") return false;
    const reviewed = await ctx.ui.editor("Review saved manual plan", plan.detail);
    if (reviewed === undefined || reviewed !== plan.detail) return false;
    return ctx.ui.confirm("Approve saved manual plan", "Reuse this exact saved plan for the current cycle?");
  };
  const selectUnorderedPlan = async (ctx: ExtensionContext, plans: VerifiedPlanRecord[]) => {
    if (ctx.mode !== "tui" || plans.length === 0) return null;
    const options = plans.map((plan) => `${plan.provider}: ${plan.recordKey}`);
    const selected = await ctx.ui.select("Select the exact saved lifecycle plan", options);
    const index = typeof selected === "string" ? options.indexOf(selected) : -1;
    const plan = index >= 0 ? plans[index] : null;
    if (!plan) return null;
    const reviewed = await ctx.ui.editor("Review selected saved plan", plan.detail);
    return reviewed === plan.detail ? plan : null;
  };
  const requestPlanAdoption = async (
    ctx: ExtensionContext,
    candidate: CycleState,
    interactive: boolean,
    isCurrent: CycleCurrent,
    signal?: AbortSignal,
  ) => coordinateCyclePlanAdoption({
    state: candidate,
    recall: async (query) => mcpResultData(await dependencies.recall(query, ctx.cwd, signal)),
    interactive: interactive && ctx.mode === "tui",
    ...(interactive && ctx.mode === "tui"
      ? {
        confirm: (plan: VerifiedPlanRecord) => confirmLegacyPlan(ctx, plan),
        select: (plans: VerifiedPlanRecord[]) => selectUnorderedPlan(ctx, plans),
      }
      : {}),
    persistApproval: (request: PlanApprovalPersistenceRequest) => dependencies.lifecycle({
      ...request,
      ...(candidate.lifecycleProvider ? { provider: candidate.lifecycleProvider } : {}),
      ...(candidate.lifecycleProviderAttemptId ? { pinAttemptId: candidate.lifecycleProviderAttemptId } : {}),
    }, lifecycleRoutingOptions(ctx)),
    identity: identityForSource(candidate),
    ...(candidate.lifecycleProvider ? { provider: candidate.lifecycleProvider } : {}),
    ...(candidate.lifecycleProviderAttemptId ? { pinAttemptId: candidate.lifecycleProviderAttemptId } : {}),
    isCurrent,
    signal,
  });
  const canInteractivelyAdoptPlan = (candidate: CycleState) => candidate.phase === "plan"
    && (candidate.status === "awaiting-resume"
      || candidate.status === "stopped"
      || candidate.status === "blocked" && candidate.blockers.length === 1 && candidate.blockers[0] === "plan:BLOCKED");
  const canAdoptManualPlan = (
    candidate: CycleState,
    operation: ActiveCycleOperation | null = null,
  ) => !pendingDispatch
    && candidate.execution === undefined
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
      renderCycleWidget(ctx, value);
    }
  };
  const notifyBlockerGuidance = (ctx: ExtensionContext, value: CycleState | null = state) => {
    if (!value || !["blocked", "blocked-after-tracker-close"].includes(value.status) || value.blockers.length === 0) return;
    const prefix = value.mode === "autonomous" ? "Autonomous cycle stopped" : "Cycle blocked";
    const guidance = describeCycleBlockers(value.blockers)
      .map(({ code, guidance: action, terminal }) => `${code} (${terminal ? "terminal" : "retriable"}) — ${action}`)
      .join("\n");
    notify(ctx, `${prefix}:\n${guidance}`, "warning");
  };
  const recoverImportedPlan = async (
    ctx: ExtensionContext,
    candidate: CycleState,
    isCurrent: CycleCurrent,
    appendState: CycleAppend,
    signal?: AbortSignal,
  ): Promise<CycleAdoptionRecoveryResult> => {
    if (!current(isCurrent) || signal?.aborted) return { ok: false, state: candidate, code: "cycle_operation_cancelled" };
    const planReference = await revalidateImportedPlanReference({
      state: candidate,
      recall: async (query) => mcpResultData(await dependencies.recall(query, ctx.cwd, signal)),
      isCurrent,
      signal,
    });
    if (!current(isCurrent) || signal?.aborted || planReference.kind === "cancelled") {
      return { ok: false, state: candidate, code: "cycle_operation_cancelled" };
    }
    if (planReference.kind === "blocked") return { ok: false, state: candidate, code: planReference.code };
    const result = await coordinateCycleRecovery({
      state: candidate,
      recall: async (query) => {
        if (!current(isCurrent) || signal?.aborted) return null;
        const recalled = await dependencies.recall(query, ctx.cwd, signal);
        return current(isCurrent) && !signal?.aborted ? recalled : null;
      },
      appendState,
      readExecutionSettlement: async (recoveryState) => {
        const execution = recoveryState.execution;
        return execution && execution.phase === recoveryState.phase
          ? dependencies.readPhaseSettlement({
            cwd: ctx.cwd,
            execution,
            context: phaseContext(recoveryState, execution),
          })
          : null;
      },
      validateRecall: validateImportedPlanLineage,
      isCurrent,
    });
    if (!current(isCurrent) || signal?.aborted) return { ok: false, state: candidate, code: "cycle_operation_cancelled" };
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
        if (activePhase) {
          notify(ctx, "Autonomous cycle stopped while phase ownership is retained.", "warning");
          break;
        }
        if (state.execution?.phase === state.phase && ["failed", "interrupted"].includes(state.execution.status)) {
          notify(ctx, "Autonomous cycle stopped after a phase host failure; use an explicit resume after inspection.", "warning");
          break;
        }
        if (run.dispatches >= ceiling) {
          notify(ctx, "Autonomous cycle dispatch ceiling reached; cycle state was preserved.", "warning");
          break;
        }
        const resumable = prepareCycleResume(state);
        if (!resumable.ok) break;
        run.dispatches += 1;
        const result = await dispatchCyclePhase({
          state: resumable.state,
          applyRoute: (phase) => dependencies.applyRoute(pi, ctx, phase, orchestratorRoute),
          appendState: phaseRuntimeAvailable(ctx)
            ? strictAppendFor(ctx, isCurrent, operation)
            : appendFor(ctx, isCurrent, operation),
          sendUserMessage: (message, provisional) => sendCyclePhaseMessage(ctx, message, provisional, operation),
          ...(phaseRuntimeAvailable(ctx) ? { prepareDispatch: preparePhaseDispatch(ctx) } : {}),
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
        notifyBlockerGuidance(ctx);
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

    if (state.phase === "plan" && canAdoptManualPlan(state, operation)) {
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
      } else if (adoption.kind === "selection-required") {
        if (options.interactive === true) notify(ctx, sanitizeCycleError("cycle_plan_selection_required").message, "warning");
        return false;
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
  const invalidateAndDrain = async (ctx?: ExtensionContext) => {
    const active = activePhase;
    if (ctx && active && state?.execution && state.execution.dispatchId === active.dispatchId) {
      state = updatePhaseExecution(state, { status: "interrupted", updatedAt: nowIso() });
      try {
        await publishState(ctx, state);
      } catch {
        // A shutdown can interrupt local cache writes; verified lifecycle artifacts remain authoritative.
      }
    }
    const generation = invalidateOperation();
    if (active) await abortActivePhase(ctx);
    if (ctx) clearCycleWidget(ctx);
    await publication;
    return generation;
  };
  const warnObservation = (ctx: ExtensionContext, observed: CycleObservationResult) => {
    if (!observed.matched && observed.diagnostic) notify(ctx, unresolvedOutcomeMessage(observed.diagnostic.phase, observed.diagnostic.artifactId, observed.diagnostic.recordKey), "warning");
  };

  pi.on("session_start", async (_event, ctx) => {
    const generation = await invalidateAndDrain(ctx);
    await restore(ctx, true, generation);
  });
  pi.on("session_tree", async (_event, ctx) => {
    const generation = await invalidateAndDrain(ctx);
    await restore(ctx, false, generation);
  });
  pi.on("session_shutdown", async (_event, ctx) => { await invalidateAndDrain(ctx); });
  pi.on("input", (event) => reducePendingDispatch({ type: "input", source: event.source, text: event.text }));
  pi.on("before_agent_start", (event) => reducePendingDispatch({ type: "before-agent-start", prompt: event.prompt }));
  pi.on("agent_start", () => reducePendingDispatch({ type: "agent-start" }));
  pi.on("agent_end", (event) => reducePendingDispatch({ type: "agent-end", messages: event.messages }));
  pi.on("agent_settled", () => reducePendingDispatch({ type: "agent-settled" }));

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "ima_lifecycle") return;
    const observation = { state: state ?? undefined, toolName: event.toolName, toolCallId: event.toolCallId, input: event.input, result: { content: event.content, details: event.details, isError: event.isError } };
    if (pendingDispatch) {
      if (pendingDispatch.state.execution) return;
      const observed = observeLifecycleResult({ ...observation, state: pendingDispatch.state });
      if (observed.matched) pendingDispatch.state = copyState(observed.state);
      else warnObservation(ctx, observed);
      return;
    }
    if (!state || state.execution) return;
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
      if (!parsed) { notify(ctx, "Usage: /ima:cycle start [--review-cap 0-10] [--implementation generic|js|wp] [--mode guided|autonomous] <Jira key|Jira browse URL|taskwarrior project uuid|plane:workspace:PROJECT-sequence|plane workspace PROJECT-sequence|Plane browse URL> | status | stop [--ack] | resume [--autonomous|--guided] | reply <answer> | close [--commit-prep].", "warning"); return; }
      if (parsed.command === "status") {
        await reconcile(ctx);
        notifyState(ctx);
        notifyBlockerGuidance(ctx);
        return;
      }
      if (parsed.command === "reply") {
        if (!state || !activePhase || currentOperation || activePhase.operation || state.status !== "awaiting-evidence" || state.execution?.status !== "waiting-reply" || activePhase.dispatchId !== state.execution.dispatchId) {
          notify(ctx, "No cycle phase is waiting for a reply.", "warning");
          return;
        }
        const operation = beginOperation(true);
        const isCurrent = () => operationCurrent(operation);
        try {
          const replied = await replyToCyclePhase(ctx, parsed.answer, operation);
          if (!current(isCurrent) || !replied) return;
          await strictAppendFor(ctx, isCurrent, operation)(replied);
          if (!current(isCurrent)) return;
          state = copyState(replied);
          notifyState(ctx);
          notifyBlockerGuidance(ctx);
          if (state.mode === "autonomous" && state.status === "awaiting-resume") await runAutonomousTail(ctx, operation);
        } finally {
          finishOperation(operation);
        }
        return;
      }
      if (parsed.command === "start") {
        if (activePhase) {
          notify(ctx, "A cycle phase is already active; reply to it or stop the cycle before starting another Story.", "warning");
          return;
        }
        notify(ctx, buildCycleStartAck(cycleSourceReference(parsed.source), {
          reviewCap: parsed.reviewCap ?? CYCLE_REVIEW_CAP_DEFAULT,
          implementationMode: parsed.implementationMode,
          mode: parsed.mode,
        }), "info");
        if (hasCycleWidget(ctx)) {
          const lines = buildCyclePhaseWidget({
            status: "awaiting-evidence",
            source: cycleSourceReference(parsed.source),
            phase: "plan",
            nextPhase: "implementation",
            mode: parsed.mode ?? "guided",
            reviewAttempts: 0,
            reviewCap: parsed.reviewCap ?? CYCLE_REVIEW_CAP_DEFAULT,
            activity: "Accepted, preparing route and context.",
            blockers: [],
          });
          ctx.ui.setWidget(CYCLE_WIDGET_KEY, lines, CYCLE_WIDGET_OPTIONS);
        }
        const orchestrator = await ensureOrchestratorRoute(ctx);
        if (!orchestrator.ok) {
          clearCycleWidget(ctx);
          notify(ctx, orchestrator.message ?? sanitizeCycleError(orchestrator.error).message, "warning");
          return;
        }
        const requestedProviderAuthorization = state && !["closed", "blocked-after-tracker-close"].includes(state.status)
          ? {
            ...(state.lifecycleProvider ? { provider: state.lifecycleProvider } : {}),
            ...(state.lifecycleProviderAttemptId ? { attemptId: state.lifecycleProviderAttemptId } : {}),
          }
          : {};
        const providerAuthorization = await authorizeLifecycleProvider(
          ctx,
          parsed.source,
          requestedProviderAuthorization,
        );
        if (providerAuthorization === null) {
          clearCycleWidget(ctx);
          notify(ctx, "Lifecycle provider selection or confirmation was not completed.", "warning");
          return;
        }
        const authorizedActiveState = state
          && !["closed", "blocked-after-tracker-close"].includes(state.status)
          && providerAuthorization.provider
          ? {
            ...state,
            lifecycleProvider: providerAuthorization.provider,
            ...(providerAuthorization.attemptId
              ? { lifecycleProviderAttemptId: providerAuthorization.attemptId }
              : { lifecycleProviderAttemptId: undefined }),
          }
          : state;
        const operation = beginOperation();
        const isCurrent = () => operationCurrent(operation);
        try {
          const result = await coordinateCycleStart({
            source: parsed.source,
            reviewCap: parsed.reviewCap,
            implementationMode: parsed.implementationMode,
            mode: parsed.mode,
            ...(providerAuthorization.provider ? { lifecycleProvider: providerAuthorization.provider } : {}),
            ...(providerAuthorization.attemptId ? { lifecycleProviderAttemptId: providerAuthorization.attemptId } : {}),
            cwd: ctx.cwd,
            activeState: authorizedActiveState,
            context: dependencies.context,
            adoptPlan: (candidate) => requestPlanAdoption(ctx, candidate, true, isCurrent, operation.controller.signal),
            recoverAdoptedState: (candidate) => recoverImportedPlan(
              ctx,
              candidate,
              isCurrent,
              (next) => strictAdoptionAppend(ctx, next, isCurrent, operation),
              operation.controller.signal,
            ),
            applyRoute: (phase) => dependencies.applyRoute(pi, ctx, phase, orchestratorRoute),
            appendState: phaseRuntimeAvailable(ctx)
              ? strictAppendFor(ctx, isCurrent, operation)
              : appendFor(ctx, isCurrent, operation),
            persistAdoptionState: (next) => strictAdoptionAppend(ctx, next, isCurrent, operation),
            sendUserMessage: (message, provisional) => sendCyclePhaseMessage(ctx, message, provisional, operation),
            ...(phaseRuntimeAvailable(ctx) ? { prepareDispatch: preparePhaseDispatch(ctx) } : {}),
            expandPrompt: (message) => dependencies.expandPrompt(message, ctx.cwd),
            isCurrent,
            branchId: ctx.sessionManager.getLeafId() ?? undefined,
          });
          if (!current(isCurrent)) return;
          if (result.ok) {
            state = result.state;
            notifyState(ctx);
            notifyBlockerGuidance(ctx);
            if (state.mode === "autonomous") await runAutonomousTail(ctx, operation);
          } else {
            if (result.state) { state = copyState(result.state); notifyState(ctx); }
            else clearCycleWidget(ctx);
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
          renderCycleWidget(ctx, state);
          notify(ctx, "Cycle start cancelled before a phase was persisted.", "info");
          return;
        }
        const activeState = currentOperation?.provisional ?? state;
        if (!activeState) {
          if (currentOperation) {
            invalidateOperation();
            ctx.abort();
            renderCycleWidget(ctx, state);
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
        const operation = beginOperation(true);
        const isCurrent = () => operationCurrent(operation);
        try {
          const result = await coordinateCycleStop({
            state: activeState,
            acknowledge: parsed.acknowledge,
            appendState: appendFor(ctx, isCurrent, operation),
            updateStoppedState: (candidate) => candidate.execution
              ? updatePhaseExecution(candidate, { status: "stopped", updatedAt: nowIso() })
              : candidate,
            abort: async () => {
              await abortActivePhase(ctx);
              ctx.abort();
            },
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
        if (pendingDispatch || currentOperation || activePhase) {
          notify(ctx, sanitizeCycleError("cycle_resume_unavailable").message, "warning");
          return;
        }
        const orchestrator = await ensureOrchestratorRoute(ctx);
        if (!orchestrator.ok) {
          notify(ctx, orchestrator.message ?? sanitizeCycleError(orchestrator.error).message, "warning");
          return;
        }
        const operation = beginOperation();
        const isCurrent = () => operationCurrent(operation);
        try {
          if (!state) return;
          if (typeof ctx.ui.select === "function" && state.status === "awaiting-resume") {
            const authorization = await authorizeLifecycleProvider(ctx, state.source, {
              ...(state.lifecycleProvider ? { provider: state.lifecycleProvider } : {}),
              ...(state.lifecycleProviderAttemptId ? { attemptId: state.lifecycleProviderAttemptId } : {}),
            });
            if (!authorization) {
              notify(ctx, "Lifecycle provider selection or confirmation was not completed.", "warning");
              return;
            }
            const candidate = {
              ...state,
              ...(authorization.provider ? { lifecycleProvider: authorization.provider } : {}),
              ...(authorization.attemptId
                ? { lifecycleProviderAttemptId: authorization.attemptId }
                : { lifecycleProviderAttemptId: undefined }),
              updatedAt: nowIso(),
            };
            await appendFor(ctx, isCurrent, operation)(candidate);
            if (!current(isCurrent)) return;
            state = copyState(candidate);
          }
          if (parsed.mode) {
            const candidate = { ...state, mode: parsed.mode, updatedAt: nowIso() };
            await appendFor(ctx, isCurrent, operation)(candidate);
            if (!current(isCurrent)) return;
            state = copyState(candidate);
          }
          if (!(await reconcile(ctx, { operation, interactive: true })) || !current(isCurrent) || !state) return;
          if (state.status === "awaiting-evidence" && ["starting", "failed"].includes(state.execution?.status ?? "")) {
            const failedExecution = state.execution
              ? withCyclePhaseExecution(state.execution, { status: "failed", updatedAt: nowIso() })
              : null;
            if (!failedExecution) {
              notify(ctx, "Cycle phase recovery record is invalid; inspect the retained lifecycle state.", "warning");
              return;
            }
            const retry = { ...state, status: "awaiting-resume" as const, execution: failedExecution, updatedAt: nowIso() };
            await appendFor(ctx, isCurrent, operation)(retry);
            if (!current(isCurrent)) return;
            state = copyState(retry);
          }
          if (state.status === "awaiting-evidence" && phaseRuntimeAvailable(ctx) && canResumeCyclePhaseExecution(state.execution)) {
            const recovered = await resumeCyclePhaseRuntime(ctx, state, operation);
            if (!current(isCurrent) || !recovered) return;
            await appendFor(ctx, isCurrent, operation)(recovered);
            if (!current(isCurrent)) return;
            state = copyState(recovered);
            notifyState(ctx);
            notifyBlockerGuidance(ctx);
            if (state.mode === "autonomous" && state.status === "awaiting-resume") await runAutonomousTail(ctx, operation);
            return;
          }
          const resumable = prepareCycleResume(state);
          if (!resumable.ok) { notify(ctx, resumable.error.message, "warning"); return; }
          const result = await dispatchCyclePhase({
            state: resumable.state,
            applyRoute: (phase) => dependencies.applyRoute(pi, ctx, phase, orchestratorRoute),
            appendState: phaseRuntimeAvailable(ctx)
              ? strictAppendFor(ctx, isCurrent, operation)
              : appendFor(ctx, isCurrent, operation),
            sendUserMessage: (message, provisional) => sendCyclePhaseMessage(ctx, message, provisional, operation),
            ...(phaseRuntimeAvailable(ctx) ? { prepareDispatch: preparePhaseDispatch(ctx) } : {}),
            expandPrompt: (value) => dependencies.expandPrompt(value, ctx.cwd),
            isCurrent,
          });
          if (!current(isCurrent)) return;
          if (result.ok) {
            state = result.state;
            notifyState(ctx);
            notifyBlockerGuidance(ctx);
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
        const result = await coordinateCycleClose({
          state,
          cwd: ctx.cwd,
          mode: ctx.mode,
          commitPrep: parsed.commitPrep,
          confirmed,
          run: (program, commandArgs) => pi.exec(program, commandArgs),
          resolveLineage: (lifecycleKey) => dependencies.resolveLifecycleLineage(
            lifecycleKey,
            lifecycleRoutingOptions(ctx),
          ),
          lifecycle: (request) => dependencies.lifecycle({
            ...request,
            ...(state.lifecycleProvider ? { provider: state.lifecycleProvider } : {}),
            ...(state.lifecycleProviderAttemptId ? { pinAttemptId: state.lifecycleProviderAttemptId } : {}),
          }, lifecycleRoutingOptions(ctx)),
          appendState: appendFor(ctx),
        });
        if (result.ok) {
          if (result.state) state = result.state;
          notifyState(ctx, result.state ?? state);
        } else {
          if (result.state) {
            state = result.state;
            notifyState(ctx, state);
            notifyBlockerGuidance(ctx, state);
          }
          notify(ctx, result.error.message, "warning");
        }
      }
    },
  });
}

export default function cycle(pi: ExtensionAPI) {
  registerCycleExtension(pi);
}
