import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createWriteToolDefinition,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { deriveAgentPaths, loadAgentDefinitions, type AgentDefinition } from "../lib/ima-agents.ts";
import {
  buildDelegationOutcomeReport,
  classifyDelegationActivity,
  createDelegationActivityState,
  reduceDelegationActivity,
  renderDelegationActivity,
  type DelegationActivityEvent,
  type DelegationActivityState,
} from "../lib/ima-activity.ts";
import {
  agentContractFingerprint,
  buildChildBrief,
  canResumeSession,
  classifyBashCommand,
  classifyChildFailure,
  createDelegationState,
  decideRecovery,
  deriveToolAuthority,
  isOwnedTarget,
  reduceDelegationEvent,
  resolveAgentRoute,
  sanitizeDelegationError,
  validateDelegationCompletion,
  validateDelegationRequest,
  type DelegationAssignment,
  type DelegationRequest,
  type SessionRecord,
} from "../lib/ima-delegation.ts";
import { loadImaConfig } from "../lib/ima-config.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessions = new Map<string, SessionRecord>();
const agentDir = resolve(homedir(), ".pi", "agent");
const projectTrusted = () => process.env.IMA_PI_PROJECT_TRUSTED === "true";
const agentToolNames: Record<string, string> = { grep: "grep", find: "find", ls: "ls", read: "read", write: "write", edit: "edit", bash: "bash", test: "bash", image: "read" };
const activityProjectionKey = "ima-delegation";
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const now = () => new Date().toISOString();

async function definitions(cwd: string) {
  return loadAgentDefinitions({ paths: deriveAgentPaths({ packageRoot, agentDir, cwd }), projectTrusted: projectTrusted() });
}
async function runtimeContext(cwd: string) {
  const config = await loadImaConfig({ packageRoot, agentDir, cwd, projectTrusted: projectTrusted() });
  const loaded = await definitions(cwd);
  const runtime = await ModelRuntime.create();
  return { config: config.config, loaded, runtime };
}

const inside = (target: string, owner: string) => target === owner || target.startsWith(`${owner}${sep}`);
const withinRoot = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const base = await realpath(current);
      return resolve(base, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("ownership_path_unresolved");
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

// REVIEW-001: symlink-safe ownership check used by every mutating operation before effects.
export async function assertOwnedPath(cwd: string, absoluteTarget: string, writeScope: string[], allowOwnerAncestor = false): Promise<void> {
  const root = await realpath(cwd);
  const lexicalTarget = resolve(absoluteTarget);
  if (!withinRoot(root, lexicalTarget)) throw new Error("ownership_target_outside_project");
  const target = await canonicalPath(lexicalTarget);
  if (!withinRoot(root, target)) throw new Error("ownership_symlink_escape");
  const owners = await Promise.all(writeScope.map(async (entry) => {
    if (!isOwnedTarget(entry, [entry])) throw new Error("ownership_scope_invalid");
    const owner = await canonicalPath(resolve(root, entry));
    if (!withinRoot(root, owner)) throw new Error("ownership_scope_symlink_escape");
    return owner;
  }));
  if (!owners.some((owner) => inside(target, owner) || (allowOwnerAncestor && inside(owner, target)))) {
    throw new Error("ownership_target_out_of_scope");
  }
}

type ScopedToolInput = {
  cwd: string;
  assignment: DelegationAssignment;
  agent: AgentDefinition;
};

// REVIEW-001: custom definitions replace Pi's mutation tools by name. Their injected operations
// enforce realpath containment before write/edit/bash effects.
export function createScopedTools(input: ScopedToolInput): ToolDefinition[] {
  const { cwd, assignment, agent } = input;
  const enabled = new Set(deriveToolAuthority(agent));
  const custom: ToolDefinition[] = [];
  if (enabled.has("write")) {
    custom.push(createWriteToolDefinition(cwd, { operations: {
      mkdir: async (path) => { await assertOwnedPath(cwd, path, assignment.writeScope, true); await mkdir(path, { recursive: true }); },
      writeFile: async (path, content) => { await assertOwnedPath(cwd, path, assignment.writeScope); await writeFile(path, content); },
    } }));
  }
  if (enabled.has("edit")) {
    custom.push(createEditToolDefinition(cwd, { operations: {
      readFile: async (path) => { await assertOwnedPath(cwd, path, assignment.writeScope); return readFile(path); },
      access: async (path) => { await assertOwnedPath(cwd, path, assignment.writeScope); await lstat(path); },
      writeFile: async (path, content) => { await assertOwnedPath(cwd, path, assignment.writeScope); await writeFile(path, content); },
    } }));
  }
  if (enabled.has("bash") || enabled.has("test")) {
    const local = createLocalBashOperations();
    custom.push(createBashToolDefinition(cwd, { operations: {
      exec: async (command, commandCwd, options) => {
        const classification = classifyBashCommand(command, assignment.writeScope);
        if (classification.kind === "unsafe-ambiguous") throw new Error(`ownership_bash_denied:${classification.reason}`);
        for (const path of classification.paths) await assertOwnedPath(cwd, resolve(commandCwd, path), assignment.writeScope);
        return local.exec(command, commandCwd, options);
      },
    } }));
  }
  return custom;
}

const finalAssistant = (session: any) => {
  const message = [...(session.messages ?? [])].reverse().find((item: any) => item?.role === "assistant");
  return message ? {
    stopReason: message.stopReason,
    isError: message.stopReason === "error",
    hasPendingToolUse: message.stopReason === "toolUse" || message.content?.some((item: any) => item?.type === "toolCall"),
    errorMessage: message.errorMessage,
  } : undefined;
};

const observedIdentity = (session: any) => ({
  provider: session.model?.provider,
  model: session.model?.id,
  thinking: session.thinkingLevel,
  sessionId: session.sessionId,
  sessionFile: session.sessionFile ?? "",
});

const mutationAttemptUnsafe = (event: any, assignment: DelegationAssignment) => {
  if (event?.type !== "tool_execution_start") return false;
  if (event.toolName === "write" || event.toolName === "edit") return !isOwnedTarget(event.args?.path, assignment.writeScope);
  if (event.toolName === "bash") return classifyBashCommand(event.args?.command, assignment.writeScope).kind === "unsafe-ambiguous";
  return false;
};

type CoordinatorDependencies = {
  createSession?: typeof createAgentSession;
  createManager?: (cwd: string) => unknown;
  scopedTools?: typeof createScopedTools;
  clock?: () => string;
  activityClock?: () => number;
};

type CoordinatorInput = {
  cwd: string;
  request: DelegationRequest;
  agents: AgentDefinition[];
  config: any;
  runtime: any;
  runId?: string;
  onActivity?: (snapshot: DelegationActivityState) => void;
  signal?: AbortSignal;
  sessionStore?: Map<string, SessionRecord>;
  dependencies?: CoordinatorDependencies;
};

// REVIEW-002/003: injectable production coordinator. It owns immutable event state, live-session
// settlement, cancellation, unsafe sibling abort, one transient retry, input ordering, cleanup,
// terminal validation, and observed identity.
export async function coordinateDelegation(input: CoordinatorInput) {
  const deps = {
    createSession: input.dependencies?.createSession ?? createAgentSession,
    createManager: input.dependencies?.createManager ?? ((cwd: string) => SessionManager.create(cwd)),
    scopedTools: input.dependencies?.scopedTools ?? createScopedTools,
    clock: input.dependencies?.clock ?? now,
    activityClock: input.dependencies?.activityClock ?? Date.now,
  };
  const store = input.sessionStore ?? sessions;
  let state = createDelegationState(input.request);
  let activity = createDelegationActivityState({ runId: input.runId ?? "delegation", request: input.request, agents: input.agents, at: deps.activityClock() });
  const emit = (event: DelegationActivityEvent) => {
    activity = reduceDelegationActivity(activity, event);
    try { input.onActivity?.(activity); } catch {}
  };
  let unsafe = false;
  let cancelled = input.signal?.aborted === true;
  const unsafeEvidence: Array<{ assignmentId: string; writeScope: string[] }> = [];
  const live = new Map<string, any>();
  const abortLive = async () => Promise.allSettled([...live.values()].map((session) => Promise.resolve(session.abort?.())));
  const markUnsafe = (assignment: DelegationAssignment) => {
    unsafe = true;
    if (!unsafeEvidence.some(({ assignmentId }) => assignmentId === assignment.id)) unsafeEvidence.push({ assignmentId: assignment.id, writeScope: [...assignment.writeScope] });
    emit({ type: "safety-intercepted", id: assignment.id, at: deps.activityClock(), blocker: "unsafe-partial-state", possiblePartialWriteScopes: assignment.writeScope });
    state = reduceDelegationEvent(state, { type: "failed", id: assignment.id, detail: "unsafe-partial-state", partialEffects: true });
    void abortLive();
  };
  const requestCancellation = () => {
    cancelled = true;
    for (const assignment of input.request.assignments) {
      const current = activity.children.find((child) => child.assignmentId === assignment.id);
      if (current && !["succeeded", "blocked", "failed", "cancelled"].includes(current.state)) {
        emit({ type: "cancel-requested", id: assignment.id, at: deps.activityClock(), possiblePartialWriteScopes: assignment.writeScope.length ? assignment.writeScope : [] });
      }
    }
  };
  const onAbort = () => { requestCancellation(); void abortLive(); };
  if (cancelled) requestCancellation();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const catalog = input.runtime.getModels().map((model: any) => ({ provider: model.provider, model: model.id, input: model.input }));
  const runAssignment = async (assignment: DelegationAssignment) => {
    const agent = input.agents.find((item) => item.name === assignment.agent)!;
    const route = resolveAgentRoute({ agent, config: input.config, catalog });
    if (!route.route) {
      emit({ type: "blocked", id: assignment.id, at: deps.activityClock(), blocker: route.error ?? "model_unavailable", escalation: route.escalation });
      return { id: assignment.id, status: "blocked", attempts: 0, error: route.error, failure: "model-unavailable" as const, escalation: route.escalation, resumeReference: null };
    }
    emit({ type: "route-resolved", id: assignment.id, at: deps.activityClock(), route: route.route });
    const model = input.runtime.getModel(route.route.provider, route.route.model);
    if (!model) {
      emit({ type: "blocked", id: assignment.id, at: deps.activityClock(), blocker: "model_unavailable", escalation: "minimum capability is unavailable" });
      return { id: assignment.id, status: "blocked", attempts: 0, error: "model_unavailable", failure: "model-unavailable" as const, escalation: "minimum capability is unavailable", resumeReference: null };
    }
    let attempt = 0;
    while (attempt < 2) {
      if (cancelled || unsafe) {
        const failure = "unsafe-partial-state" as const;
        emit({ type: "cancelled", id: assignment.id, at: deps.activityClock(), blocker: unsafe ? failure : "cancelled", possiblePartialWriteScopes: assignment.writeScope.length ? assignment.writeScope : [] });
        return { id: assignment.id, status: "cancelled", attempts: attempt, error: unsafe ? failure : "cancelled", failure, resumeReference: null };
      }
      attempt += 1;
      emit({ type: "child-started", id: assignment.id, at: deps.activityClock(), attempt });
      let session: any;
      let unsubscribe = () => undefined;
      try {
        state = reduceDelegationEvent(state, { type: "started", id: assignment.id });
        const created = await deps.createSession({
          cwd: input.cwd,
          modelRuntime: input.runtime,
          model,
          thinkingLevel: route.route.thinking as any,
          tools: deriveToolAuthority(agent).map((tool) => agentToolNames[tool]).filter(Boolean),
          customTools: deps.scopedTools({ cwd: input.cwd, assignment, agent }),
          sessionManager: deps.createManager(input.cwd) as any,
        });
        session = created.session;
        live.set(assignment.id, session);
        unsubscribe = session.subscribe?.((event: any) => {
          if (event?.type === "agent_start") emit({ type: "child-running", id: assignment.id, at: deps.activityClock(), attempt });
          if (event?.type === "agent_settled") emit({ type: "child-settled", id: assignment.id, at: deps.activityClock() });
          if (event?.type === "tool_execution_start") emit({ type: "child-activity", id: assignment.id, at: deps.activityClock(), category: classifyDelegationActivity(event.toolName, event.args) });
          if (mutationAttemptUnsafe(event, assignment) || (event?.type === "tool_execution_end" && event.isError && ["write", "edit", "bash"].includes(event.toolName))) markUnsafe(assignment);
        }) ?? unsubscribe;
        if (cancelled || unsafe) { await session.abort?.(); throw new Error(cancelled ? "cancelled" : "unsafe-partial-state"); }
        await session.prompt(buildChildBrief({ projectRoot: input.cwd, assignment, agent }));
        await session.waitForIdle();
        if (cancelled || unsafe) throw new Error(cancelled ? "cancelled" : "unsafe-partial-state");
        const final = finalAssistant(session);
        const report = session.getLastAssistantText?.() ?? "";
        const observed = observedIdentity(session);
        const completion = validateDelegationCompletion({ final, text: report, requiredSections: agent.result.requiredSections, expected: route.route, observed });
        if (!completion.ok) {
          const providerError = final?.errorMessage;
          const error = providerError || completion.failures.join(",");
          const failure = providerError ? classifyChildFailure(providerError) : "agent-contract";
          const recovery = decideRecovery({ failure, retries: attempt - 1 });
          if (recovery.retry && !cancelled && !unsafe) {
            emit({ type: "retrying", id: assignment.id, at: deps.activityClock(), attempt: 2, reason: failure });
            continue;
          }
          const detail = sanitizeDelegationError(error);
          emit({ type: cancelled ? "cancelled" : "failed", id: assignment.id, at: deps.activityClock(), blocker: detail, possiblePartialWriteScopes: cancelled && assignment.writeScope.length ? assignment.writeScope : [] });
          state = reduceDelegationEvent(state, { type: cancelled ? "cancelled" : "failed", id: assignment.id, detail, partialEffects: unsafe || (cancelled && assignment.writeScope.length > 0) });
          return { id: assignment.id, status: cancelled ? "cancelled" : "failed", attempts: attempt, error: detail, failure, completion: completion.failures, resumeReference: null };
        }
        const timestamp = deps.clock();
        const record: SessionRecord = {
          reference: assignment.id, agent: agent.name, role: agent.authority, resultKind: agent.result.kind,
          provider: observed.provider!, model: observed.model!, thinking: observed.thinking,
          sessionId: observed.sessionId!, sessionFile: observed.sessionFile!, writeScope: [...assignment.writeScope],
          contractFingerprint: agentContractFingerprint(agent, assignment.writeScope), status: "succeeded",
          fresh: agent.independence.freshInitial, followUpAllowed: agent.independence.followUpAllowed,
          createdAt: timestamp, updatedAt: timestamp,
        };
        store.set(record.reference, record);
        emit({ type: "succeeded", id: assignment.id, at: deps.activityClock() });
        state = reduceDelegationEvent(state, { type: "succeeded", id: assignment.id });
        return { id: assignment.id, status: "succeeded", attempts: attempt, report, provider: record.provider, model: record.model, thinking: record.thinking, sessionId: record.sessionId, sessionFile: record.sessionFile, resumeReference: record.followUpAllowed ? record.reference : null };
      } catch (error) {
        const failure = unsafe ? "unsafe-partial-state" : cancelled ? "unsafe-partial-state" : classifyChildFailure(error);
        const recovery = decideRecovery({ failure, retries: attempt - 1 });
        if (recovery.retry && !cancelled && !unsafe) {
          emit({ type: "retrying", id: assignment.id, at: deps.activityClock(), attempt: 2, reason: failure });
          continue;
        }
        const detail = unsafe ? "unsafe-partial-state" : cancelled ? "cancelled" : sanitizeDelegationError(error);
        const possibleWrites = assignment.writeScope.length > 0;
        emit({ type: cancelled || unsafe ? "cancelled" : "failed", id: assignment.id, at: deps.activityClock(), blocker: detail, possiblePartialWriteScopes: (cancelled || unsafe) && possibleWrites ? assignment.writeScope : [] });
        state = reduceDelegationEvent(state, { type: cancelled ? "cancelled" : "failed", id: assignment.id, detail, partialEffects: unsafe || (cancelled && possibleWrites) });
        return { id: assignment.id, status: cancelled ? "cancelled" : "failed", attempts: attempt, error: detail, failure, resumeReference: null };
      } finally {
        live.delete(assignment.id);
        unsubscribe();
        session?.dispose?.();
      }
    }
    emit({ type: "failed", id: assignment.id, at: deps.activityClock(), blocker: "terminal" });
    return { id: assignment.id, status: "failed", attempts: attempt, error: "terminal", failure: "terminal" as const, resumeReference: null };
  };

  try {
    const settled = await Promise.allSettled(input.request.assignments.map(runAssignment));
    if (cancelled || unsafe) await abortLive();
    const results = settled.map((entry, index) => entry.status === "fulfilled"
      ? entry.value
      : { id: input.request.assignments[index].id, status: "failed", attempts: 0, error: sanitizeDelegationError(entry.reason), failure: classifyChildFailure(entry.reason), resumeReference: null });
    const status = results.every((result) => result.status === "succeeded") ? "succeeded" : cancelled ? "cancelled" : "failed";
    emit({ type: "run-settled", at: deps.activityClock(), state: status });
    const partialEffects = state.partialEffects || unsafe;
    const report = buildDelegationOutcomeReport({ activity, results, partialEffects, unsafeEvidence });
    return { status, results, state: { ...state, partialEffects }, activity, report, partialEffects, unsafeEvidence };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await abortLive();
  }
}

type ContinuationInput = {
  record: SessionRecord;
  agent: AgentDefinition;
  brief: string;
  runtime: any;
  cwd: string;
  sessionStore?: Map<string, SessionRecord>;
  dependencies?: CoordinatorDependencies & { openManager?: (path: string) => unknown; fileExists?: (path: string) => boolean };
};

// REVIEW-004: reopen and execute the exact persisted session after status, independence,
// fingerprint, file, model, terminal-result, and observed-identity checks.
export async function runFocusedContinuation(input: ContinuationInput) {
  const purpose = input.agent.authority === "review-read" ? "finding-follow-up" : input.agent.authority === "vision-read" ? "vision-follow-up" : "implementation-follow-up";
  const fileExists = input.dependencies?.fileExists ?? existsSync;
  if (!canResumeSession({ record: input.record, agent: input.agent, purpose, sessionFileExists: fileExists(input.record.sessionFile) })) return { status: "refused", error: "session_not_reusable" };
  if (input.record.contractFingerprint !== agentContractFingerprint(input.agent, input.record.writeScope)) return { status: "refused", error: "agent_contract_drift" };
  const model = input.runtime.getModel(input.record.provider, input.record.model);
  if (!model) return { status: "refused", error: "model_unavailable" };
  const deps = {
    createSession: input.dependencies?.createSession ?? createAgentSession,
    openManager: input.dependencies?.openManager ?? ((path: string) => SessionManager.open(path)),
    scopedTools: input.dependencies?.scopedTools ?? createScopedTools,
    clock: input.dependencies?.clock ?? now,
  };
  const store = input.sessionStore ?? sessions;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let session: any;
    let unsubscribe = () => undefined;
    try {
      const created = await deps.createSession({
        cwd: input.cwd, modelRuntime: input.runtime, model, thinkingLevel: input.record.thinking as any,
        tools: deriveToolAuthority(input.agent).map((tool) => agentToolNames[tool]).filter(Boolean),
        customTools: deps.scopedTools({ cwd: input.cwd, assignment: { id: input.record.reference, agent: input.agent.name, goal: input.brief, context: "Focused continuation", paths: [], constraints: [], nonGoals: [], expectedOutput: input.agent.result.requiredSections.join(", "), writeScope: input.record.writeScope }, agent: input.agent }),
        sessionManager: deps.openManager(input.record.sessionFile) as any,
      });
      session = created.session;
      let unsafe = false;
      unsubscribe = session.subscribe?.((event: any) => { if (mutationAttemptUnsafe(event, { writeScope: input.record.writeScope } as DelegationAssignment)) { unsafe = true; void session.abort?.(); } }) ?? unsubscribe;
      await session.prompt(input.brief);
      await session.waitForIdle();
      if (unsafe) return { status: "failed", error: "unsafe-partial-state" };
      const final = finalAssistant(session);
      const report = session.getLastAssistantText?.() ?? "";
      const observed = observedIdentity(session);
      const completion = validateDelegationCompletion({ final, text: report, requiredSections: input.agent.result.requiredSections, expected: { provider: input.record.provider, model: input.record.model, thinking: input.record.thinking, sessionId: input.record.sessionId, sessionFile: input.record.sessionFile }, observed });
      if (!completion.ok) {
        const failure = final?.errorMessage ? classifyChildFailure(final.errorMessage) : "agent-contract";
        if (attempt === 0 && decideRecovery({ failure, retries: 0 }).retry) continue;
        return { status: "failed", error: final?.errorMessage ? sanitizeDelegationError(final.errorMessage) : completion.failures.join(","), completion: completion.failures };
      }
      const updated = { ...input.record, status: "succeeded" as const, updatedAt: deps.clock() };
      store.set(updated.reference, updated);
      return { status: "succeeded", attempts: attempt + 1, report, provider: observed.provider, model: observed.model, thinking: observed.thinking, sessionId: observed.sessionId, sessionFile: observed.sessionFile };
    } catch (error) {
      const failure = classifyChildFailure(error);
      if (attempt === 0 && decideRecovery({ failure, retries: 0 }).retry) continue;
      return { status: "failed", error: sanitizeDelegationError(error) };
    } finally {
      unsubscribe();
      session?.dispose?.();
    }
  }
  return { status: "failed", error: "terminal" };
}

export default function agents(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ima_delegate", label: "IMA delegate", description: "Delegate one to four bounded, agent-defined assignments.", executionMode: "sequential",
    parameters: Type.Object({ title: Type.String(), assignments: Type.Array(Type.Object({ id: Type.String(), agent: Type.String(), goal: Type.String(), context: Type.String(), paths: Type.Array(Type.String()), constraints: Type.Array(Type.String()), nonGoals: Type.Array(Type.String()), expectedOutput: Type.String(), writeScope: Type.Array(Type.String()) }), { minItems: 1, maxItems: 4 }) }),
    execute: async (toolCallId, request, signal, onUpdate, ctx) => {
      let projectionDegraded = false;
      const project = (snapshot: DelegationActivityState) => {
        const lines = renderDelegationActivity(snapshot, Date.now());
        try { onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: { status: "running", activity: snapshot } }); } catch { projectionDegraded = true; }
        if (ctx.mode === "tui") {
          try { ctx.ui.setWidget(activityProjectionKey, lines); ctx.ui.setStatus(activityProjectionKey, `delegation: ${snapshot.state}`); } catch { projectionDegraded = true; }
        }
      };
      let result: Awaited<ReturnType<typeof coordinateDelegation>>;
      try {
        const { config, loaded, runtime } = await runtimeContext(ctx.cwd);
        if (!config || loaded.diagnostics.length) return { content: [{ type: "text", text: JSON.stringify({ status: "blocked", errors: [...config?.diagnostics ?? [], ...loaded.diagnostics] }) }], details: { status: "blocked" } };
        const valid = validateDelegationRequest(request, loaded.definitions);
        if (!valid.valid) return { content: [{ type: "text", text: JSON.stringify({ status: "blocked", errors: valid.errors }) }], details: { status: "blocked" } };
        result = await coordinateDelegation({ cwd: ctx.cwd, request, agents: loaded.definitions, config, runtime, runId: toolCallId, onActivity: project, signal, sessionStore: sessions });
      } finally {
        if (ctx.mode === "tui") {
          try { ctx.ui.setWidget(activityProjectionKey, undefined); } catch { projectionDegraded = true; }
          try { ctx.ui.setStatus(activityProjectionKey, undefined); } catch { projectionDegraded = true; }
        }
      }
      // Build the terminal report only after clearing so clear failures remain observable.
      const details = { ...result, projectionDegraded, report: { ...result.report, projectionDegraded } };
      return { content: [{ type: "text", text: JSON.stringify({ status: result.status, results: result.results, report: details.report }) }], details };
    },
  });
  pi.registerCommand("ima:agents", { description: "List resolved IMA agents.", handler: async (_args, ctx) => { const loaded = await definitions(ctx.cwd); const rows = loaded.definitions.map(({ name, source, tier, authority, description }) => `${name}\t${source}\t${tier}\t${authority}\t${description}`); ctx.ui.notify(rows.join("\n") || "No valid IMA agents.", loaded.diagnostics.length ? "warning" : "info"); } });
  pi.registerCommand("ima:agent-sessions", { description: "List sanitized IMA agent session references.", handler: async (_args, ctx) => ctx.ui.notify([...sessions.values()].map((record) => `${record.reference}\t${record.role}\t${record.provider}/${record.model}\t${record.status}`).join("\n") || "No IMA agent sessions.", "info") });
  pi.registerCommand("ima:agent-follow-up", { description: "Run a focused continuation: <session-reference> <brief>.", handler: async (args, ctx) => {
    const [reference, ...rest] = args.trim().split(/\s+/);
    const record = sessions.get(reference);
    const brief = rest.join(" ");
    const loaded = await definitions(ctx.cwd);
    const agent = loaded.definitions.find((item) => item.name === record?.agent);
    if (!record || !agent || !brief) { ctx.ui.notify("Follow-up refused: unknown, unsafe, or non-reusable session.", "warning"); return; }
    const runtime = await ModelRuntime.create();
    const result = await runFocusedContinuation({ record, agent, brief, runtime, cwd: ctx.cwd, sessionStore: sessions });
    ctx.ui.notify(JSON.stringify(result), result.status === "succeeded" ? "info" : "warning");
  } });
}
