import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyConfiguredPhaseRoute, latestSessionProfile } from "./workflow-routing.ts";
import { coordinateContext, coordinateLifecycle } from "./integrations.ts";
import {
  CYCLE_ENTRY,
  IMA_PROJECT,
  buildCycleStatus,
  buildFinalCloseoutArtifact,
  buildResumeSource,
  createCycleState,
  cycleSourceReference,
  extractPhaseOutcome,
  normalizeCycleSource,
  parseCycleCommand,
  parseJiraTracker,
  parseTaskwarriorTracker,
  prepareCycleResume,
  reduceCycleState,
  requiredCloseoutEvidence,
  sanitizeCycleError,
  validateCycleState,
  type CycleCommand,
  type CycleEvidence,
  type CycleImplementationMode,
  type CyclePhase,
  type CycleSource,
  type CycleState,
} from "../lib/ima-cycle.ts";
import type { ImaPhase } from "../lib/ima-config.ts";
import type { LifecycleIdentity } from "../lib/ima-lifecycle.ts";

export const CYCLE_STATUS_KEY = "ima-cycle";
const JIRA_HELPER = join(homedir(), ".agents", "skills", "mcp-atlassian", "scripts", "atlassian-api.mjs");
const WRITE_CAPABLE_PHASES = new Set<CyclePhase>(["implementation", "test", "resolution", "document"]);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nowIso = () => new Date().toISOString();
const safeError = (code: string) => ({ ok: false as const, error: sanitizeCycleError(code) });
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

const CYCLE_ROUTE_PHASES: Readonly<Record<CyclePhase, ImaPhase>> = {
  plan: "plan",
  implementation: "implement",
  test: "test",
  review: "review",
  resolution: "resolution",
  rereview: "rereview",
  document: "document",
};

export const cycleRoutePhase = (phase: CyclePhase): ImaPhase => CYCLE_ROUTE_PHASES[phase];

export type CycleContextResult = { status: string; source?: unknown; diagnostics?: unknown[] };
export type CycleRouteResult = { ok: true; route?: unknown } | { ok: false; error: string; message?: string; rollback?: string };
export type CycleAppend = (state: CycleState) => void;
export type CycleSend = (message: string, provisionalState: CycleState) => Promise<CycleState>;
export type CycleExpand = (message: string) => string | Promise<string>;
export type CycleRoute = (phase: CyclePhase) => Promise<CycleRouteResult>;

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

export type CycleStartInput = {
  source: unknown;
  cwd: string;
  activeState?: CycleState | null;
  lifecycleKey?: string;
  reviewCap?: number;
  implementationMode?: CycleImplementationMode;
  branchId?: string;
  context?: (request: unknown, cwd: string) => Promise<CycleContextResult>;
  applyRoute: CycleRoute;
  appendState: CycleAppend;
  sendUserMessage: CycleSend;
  expandPrompt?: CycleExpand;
  timestamp?: string;
};

export async function coordinateCycleStart(input: CycleStartInput): Promise<{ ok: true; state: CycleState; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError> }> {
  const source = normalizeCycleSource(input.source);
  if (!source) return safeError("cycle_source_invalid");
  if (input.activeState && !["closed", "blocked-after-tracker-close"].includes(input.activeState.status)) return safeError("cycle_active_replacement_blocked");
  const context = input.context ?? ((request, cwd) => coordinateContext(request, cwd) as Promise<CycleContextResult>);
  let hydrated: CycleContextResult;
  try {
    const contextSource = source.type === "jira" ? { type: "jira", key: source.key } : source;
    hydrated = await context({ source: contextSource }, input.cwd);
  } catch {
    return safeError("cycle_context_failed");
  }
  if (hydrated.status !== "ready") return safeError("cycle_context_not_ready");
  let state: CycleState;
  try {
    state = createCycleState(source, { lifecycleKey: input.lifecycleKey, reviewCap: input.reviewCap, implementationMode: input.implementationMode, branchId: input.branchId, timestamp: input.timestamp });
  } catch (error) {
    return safeError(error instanceof Error ? error.message : "cycle_state_invalid");
  }
  let route: CycleRouteResult;
  try {
    route = await input.applyRoute("plan");
  } catch {
    return safeError("phase_route_apply_failed");
  }
  if (!route.ok) return safeError(route.error || "phase_route_apply_failed");
  const command = buildResumeSource({ ...state, status: "awaiting-resume" }) ?? "/ima:plan";
  try {
    const message = input.expandPrompt ? await input.expandPrompt(command) : command;
    const confirmedState = await input.sendUserMessage(message, copyState(state));
    input.appendState(copyState(confirmedState));
    return { ok: true, state: confirmedState, message: `Cycle started for ${cycleSourceReference(source)}.` };
  } catch {
    return safeError("cycle_phase_injection_failed");
  }
}

export type CycleDispatchInput = {
  state: CycleState;
  applyRoute: CycleRoute;
  appendState: CycleAppend;
  sendUserMessage: CycleSend;
  expandPrompt?: CycleExpand;
  timestamp?: string;
};

export async function dispatchCyclePhase(input: CycleDispatchInput): Promise<{ ok: true; state: CycleState; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError> }> {
  if (input.state.status !== "awaiting-resume") return safeError("cycle_resume_unavailable");
  const command = buildResumeSource(input.state);
  if (!command) return safeError("cycle_resume_source_invalid");
  let route: CycleRouteResult;
  try {
    route = await input.applyRoute(input.state.phase);
  } catch {
    return safeError("phase_route_apply_failed");
  }
  if (!route.ok) return safeError(route.error || "phase_route_apply_failed");
  const state: CycleState = { ...copyState(input.state), status: "awaiting-evidence", updatedAt: input.timestamp ?? nowIso() };
  try {
    const message = input.expandPrompt ? await input.expandPrompt(command) : command;
    const confirmedState = await input.sendUserMessage(message, copyState(state));
    input.appendState(copyState(confirmedState));
    return { ok: true, state: confirmedState, message: `Dispatched ${input.state.phase}.` };
  } catch {
    return safeError("cycle_phase_injection_failed");
  }
}

export type CycleStopInput = {
  state: CycleState;
  acknowledge: boolean;
  appendState: CycleAppend;
  abort: () => void;
  timestamp?: string;
};

export function coordinateCycleStop(input: CycleStopInput): { ok: true; state: CycleState; message: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError> } {
  if (!["awaiting-evidence", "awaiting-resume"].includes(input.state.status)) return safeError("cycle_stop_unavailable");
  if (WRITE_CAPABLE_PHASES.has(input.state.phase) && !input.acknowledge) return safeError("cycle_stop_ack_required");
  const state: CycleState = {
    ...copyState(input.state),
    status: "stopped",
    stoppedAt: input.timestamp ?? nowIso(),
    stoppedPhase: input.state.phase,
    updatedAt: input.timestamp ?? nowIso(),
  };
  input.appendState(copyState(state));
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
  return text(identity.taskwarriorProject) === state.source.project && text(identity.taskwarriorUuid) === state.source.uuid;
};

export type CycleObservationInput = {
  state: CycleState;
  toolName: unknown;
  toolCallId: unknown;
  input: unknown;
  result: unknown;
  timestamp?: string;
};

export function observeLifecycleResult(input: CycleObservationInput): { matched: true; state: CycleState; evidence: CycleEvidence } | { matched: false; state: CycleState; error: ReturnType<typeof sanitizeCycleError> } {
  if (input.toolName !== "ima_lifecycle") return { matched: false, state: input.state, error: sanitizeCycleError("tool_not_cycle_lifecycle") };
  const request = object(input.input);
  const resultObject = object(input.result);
  const payload = lifecyclePayload(input.result);
  if (!request || !payload || resultObject?.isError === true || payload.status !== "completed" || payload.receiptAccepted !== true || object(payload.semanticRecall)?.matched !== true) return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_completion_unverified") };
  const expectedLifecycleType = input.state.phase === "document" ? "closeout" : input.state.phase;
  if (text(payload.lifecycleKey) !== input.state.lifecycleKey || text(payload.phase) !== expectedLifecycleType || text(request.type) !== expectedLifecycleType || !sameLifecycleIdentity(input.state, request.identity)) return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_identity_mismatch") };
  const artifact = text(request.artifact);
  const outcome = extractPhaseOutcome(artifact);
  if (!outcome.ok || outcome.phase !== input.state.phase) return { matched: false, state: input.state, error: outcome.ok ? sanitizeCycleError("phase_marker_mismatch") : outcome.error };
  const toolCallId = text(input.toolCallId);
  if (!toolCallId) return { matched: false, state: input.state, error: sanitizeCycleError("lifecycle_tool_call_missing") };
  const reduced = reduceCycleState(input.state, {
    phase: outcome.phase,
    outcome: outcome.outcome,
    marker: outcome.marker,
    artifact,
    artifactId: text(payload.artifactId) || null,
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

const execSucceeded = (value: unknown) => {
  const result = object(value);
  if (!result) return false;
  if (typeof result.code === "number") return result.code === 0;
  return result.ok === true || result.success === true;
};

const identityForSource = (state: CycleState): LifecycleIdentity => state.source.type === "jira"
  ? { project: IMA_PROJECT, lifecycleKey: state.lifecycleKey, lifecycleRootMemoryId: "", taskwarriorProject: "", taskwarriorTask: "", taskwarriorUuid: "", jiraKey: state.source.key, sourceRefs: [`Jira:${state.source.key}`], priorArtifactIds: state.evidence.flatMap((item) => item.artifactId ? [item.artifactId] : []) }
  : { project: IMA_PROJECT, lifecycleKey: state.lifecycleKey, lifecycleRootMemoryId: "", taskwarriorProject: state.source.project, taskwarriorTask: state.source.uuid, taskwarriorUuid: state.source.uuid, jiraKey: "", sourceRefs: [`Taskwarrior:${state.source.project}:${state.source.uuid}`], priorArtifactIds: state.evidence.flatMap((item) => item.artifactId ? [item.artifactId] : []) };

export type CycleCloseInput = {
  state: CycleState;
  mode: string;
  commitPrep: boolean;
  confirmed?: boolean;
  run: (program: string, args: string[]) => Promise<unknown>;
  lifecycle?: (request: { type: "closeout"; identity: LifecycleIdentity; artifact: string }) => Promise<{ status?: string; [key: string]: unknown }>;
  identity?: LifecycleIdentity;
  appendState: CycleAppend;
  timestamp?: string;
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
  const identity = input.identity ?? identityForSource(state);
  const artifact = buildFinalCloseoutArtifact(state, { identity });
  const lifecycle = input.lifecycle ?? (async (request) => coordinateLifecycle(request));
  let persisted: { status?: string; [key: string]: unknown };
  try {
    persisted = await lifecycle({ type: "closeout", identity, artifact });
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
  input.appendState(copyState(next));
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
  return status.status === "invalid" ? "Cycle state is invalid." : `Cycle ${status.status}: ${status.source}; phase ${status.phase}; review ${status.reviewAttempts}/${status.reviewCap}.`;
};

const routeFor = (pi: ExtensionAPI, ctx: ExtensionContext): CycleRoute => (phase) => applyConfiguredPhaseRoute(pi, ctx, cycleRoutePhase(phase), latestSessionProfile(ctx.sessionManager.getBranch()));

export type CycleExtensionDependencies = {
  applyRoute: (pi: ExtensionAPI, ctx: ExtensionContext, phase: CyclePhase) => Promise<CycleRouteResult>;
  expandPrompt: (value: string, cwd: string) => Promise<string>;
};

const defaultCycleExtensionDependencies: CycleExtensionDependencies = {
  applyRoute: (pi, ctx, phase) => routeFor(pi, ctx)(phase),
  expandPrompt: expandCyclePromptFromResources,
};

const appendFor = (pi: ExtensionAPI): CycleAppend => (state) => pi.appendEntry(CYCLE_ENTRY, copyState(state));

export function registerCycleExtension(pi: ExtensionAPI, dependencies: CycleExtensionDependencies = defaultCycleExtensionDependencies) {
  let state: CycleState | null = null;
  type PendingDispatch = { confirmation: CycleDispatchConfirmationState; state: CycleState; finish: (error?: Error) => void; timer: ReturnType<typeof setTimeout> | null };
  let pendingDispatch: PendingDispatch | null = null;
  const reducePendingDispatch = (event: CycleDispatchConfirmationEvent) => {
    const pending = pendingDispatch;
    if (!pending) return;
    const previous = pending.confirmation;
    const next = reduceCycleDispatchConfirmation(previous, event);
    pending.confirmation = next;
    if (previous.status === "waiting-agent-start" && next.status === "waiting-agent-end") {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (next.status === "succeeded") pending.finish();
    if (next.status === "failed") pending.finish(new Error("cycle_phase_injection_unverified"));
  };
  const sendCycleUserMessage = (message: string, provisionalState: CycleState) => new Promise<CycleState>((resolve, reject) => {
    if (pendingDispatch) { reject(new Error("cycle_phase_injection_pending")); return; }
    const pending: PendingDispatch = { confirmation: createCycleDispatchConfirmation(message), state: copyState(provisionalState), finish: () => {}, timer: null };
    const finish = (error?: Error) => {
      if (pendingDispatch !== pending) return;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      pendingDispatch = null;
      if (error) reject(error); else resolve(copyState(pending.state));
    };
    pending.finish = finish;
    pendingDispatch = pending;
    pending.timer = setTimeout(() => reducePendingDispatch({ type: "timeout" }), 10_000);
    try {
      Promise.resolve(pi.sendUserMessage(message)).catch((error) => finish(error instanceof Error ? error : new Error("cycle_phase_injection_failed")));
    } catch (error) {
      finish(error instanceof Error ? error : new Error("cycle_phase_injection_failed"));
    }
  });
  const restore = (ctx: ExtensionContext) => {
    state = restoreCycleState(ctx.sessionManager.getBranch());
    if (ctx.hasUI) ctx.ui.setStatus(CYCLE_STATUS_KEY, stateText(state));
  };
  const stateText = (value: CycleState | null) => statusText(value);
  const notifyState = (ctx: ExtensionContext, value: CycleState | null = state) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(CYCLE_STATUS_KEY, stateText(value));
      ctx.ui.notify(stateText(value), "info");
    }
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
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
      return;
    }
    if (!state) return;
    const observed = observeLifecycleResult({ ...observation, state });
    if (!observed.matched) return;
    state = observed.state;
    appendFor(pi)(state);
    if (ctx.hasUI) ctx.ui.setStatus(CYCLE_STATUS_KEY, stateText(state));
  });

  pi.registerCommand("ima:cycle", {
    description: "Start, inspect, stop, resume, or explicitly close one IMA lifecycle Story.",
    handler: async (args, ctx) => {
      const parsed = parseCycleCommand(args);
      if (!parsed) { notify(ctx, "Usage: /ima:cycle start [--review-cap 0-10] [--implementation generic|js|wp] <Jira key|browse URL|taskwarrior project uuid> | status | stop [--ack] | resume | close [--commit-prep].", "warning"); return; }
      if (parsed.command === "status") { notifyState(ctx); return; }
      if (parsed.command === "start") {
        const result = await coordinateCycleStart({ source: parsed.source, reviewCap: parsed.reviewCap, implementationMode: parsed.implementationMode, cwd: ctx.cwd, activeState: state, context: (request, cwd) => coordinateContext(request, cwd) as Promise<CycleContextResult>, applyRoute: (phase) => dependencies.applyRoute(pi, ctx, phase), appendState: appendFor(pi), sendUserMessage: sendCycleUserMessage, expandPrompt: (message) => dependencies.expandPrompt(message, ctx.cwd), branchId: ctx.sessionManager.getLeafId() ?? undefined });
        if (result.ok) { state = result.state; notifyState(ctx); } else notify(ctx, result.error.message, "warning");
        return;
      }
      if (!state) { notify(ctx, "No active cycle. Start one first.", "warning"); return; }
      if (parsed.command === "stop") {
        const result = coordinateCycleStop({ state, acknowledge: parsed.acknowledge, appendState: appendFor(pi), abort: () => ctx.abort() });
        if (result.ok) { state = result.state; notifyState(ctx); } else notify(ctx, result.error.message, "warning");
        return;
      }
      if (parsed.command === "resume") {
        const resumable = prepareCycleResume(state);
        if (!resumable.ok) { notify(ctx, resumable.error.message, "warning"); return; }
        const result = await dispatchCyclePhase({ state: resumable.state, applyRoute: (phase) => dependencies.applyRoute(pi, ctx, phase), appendState: appendFor(pi), sendUserMessage: sendCycleUserMessage, expandPrompt: (value) => dependencies.expandPrompt(value, ctx.cwd) });
        if (result.ok) { state = result.state; notifyState(ctx); } else notify(ctx, result.error.message, "warning");
        return;
      }
      if (parsed.command === "close") {
        let confirmed = true;
        if (!parsed.commitPrep) {
          if (ctx.mode !== "tui") { notify(ctx, "Cycle close requires TUI confirmation.", "warning"); return; }
          confirmed = await ctx.ui.confirm("Close cycle", `Close ${cycleSourceReference(state.source)} and mark its single tracker source complete?`);
        }
        const result = await coordinateCycleClose({ state, mode: ctx.mode, commitPrep: parsed.commitPrep, confirmed, run: (program, commandArgs) => pi.exec(program, commandArgs), appendState: appendFor(pi) });
        if (result.ok) { if (result.state) state = result.state; notifyState(ctx, result.state ?? state); } else { if (result.state) state = result.state; notify(ctx, result.error.message, "warning"); }
      }
    },
  });
}

export default function cycle(pi: ExtensionAPI) {
  registerCycleExtension(pi);
}
