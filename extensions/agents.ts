import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createWriteToolDefinition,
  ModelRuntime,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  buildAgentCatalogPrompt,
  deriveAgentPaths,
  IMA_AGENT_CATALOG_UNAVAILABLE,
  loadAgentDefinitions,
  type AgentDefinition,
} from "../lib/ima-agents.ts";
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
  buildDelegationToolPayload,
  canResumeSession,
  createDelegationResult,
  classifyBashCommand,
  classifyChildFailure,
  createDelegationState,
  decideRecovery,
  deriveToolAuthority,
  isDocumentationTarget,
  isOwnedTarget,
  normalizeOwnershipTarget,
  reduceDelegationEvent,
  resolveAgentRoute,
  sanitizeDelegationError,
  validateAdversarialAssignments,
  validateAdversarialRoutes,
  validateDelegationCompletion,
  validateDelegationRequest,
  validateDelegationRouteIdentity,
  type DelegationAssignment,
  type DelegationRequest,
  type SessionRecord,
} from "../lib/ima-delegation.ts";
import { loadImaConfig } from "../lib/ima-config.ts";
import { admitVisionImages, publicVisionSource } from "../lib/ima-vision.ts";
import {
  createScopedToolOperationEvidence,
  isScopedMutationTool,
  runFocusedAgentContinuation,
  type ScopedToolOperationEvidence,
} from "../lib/ima-agent-continuation.ts";
import type { NativeFileLease } from "../lib/ima-agent-session-lock.ts";
import {
  createCycleSessionReference,
  createDirectSessionReference,
  cycleSessionOwnerFromEntries,
  findCycleOwnedSession,
  isCycleSessionReference,
  loadCycleOwnedSession,
  loadDirectSessionRecord,
  sameCycleSessionLifecycle,
  storeCycleOwnedSessionRecord,
  storeDirectSessionRecord,
  type CycleSessionOwner,
} from "../lib/ima-agent-sessions.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessions = new Map<string, SessionRecord>();
const cycleSessionOwners = new Map<string, CycleSessionOwner>();
const continuingSessions = new Set<string>();
const agentDir = getAgentDir();
export function resolveProjectTrust(ctx: Partial<Pick<ExtensionContext, "isProjectTrusted">> | undefined, fallback = process.env.IMA_PI_PROJECT_TRUSTED === "true"): boolean {
  return typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : fallback;
}
const agentToolNames: Record<string, string> = { grep: "grep", find: "find", ls: "ls", read: "read", write: "write", edit: "edit", bash: "bash", test: "bash", image: "read" };
const activityProjectionKey = "ima-delegation";
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const now = () => new Date().toISOString();
const appendAgentCatalog = (systemPrompt: string, catalog: string) => `${systemPrompt}\n\n${catalog}`;

async function definitions(cwd: string, trusted: boolean) {
  return loadAgentDefinitions({ paths: deriveAgentPaths({ packageRoot, agentDir, cwd }), projectTrusted: trusted });
}
export const readSessionProfile = (entries: readonly any[]): string | null => {
  for (const entry of [...entries].reverse()) if (entry?.type === "custom" && entry.customType === "ima-profile-state" && typeof entry.data?.profile === "string") return entry.data.profile;
  return null;
};

async function runtimeContext(cwd: string, profile: string | null, trusted: boolean) {
  const config = await loadImaConfig({ packageRoot, agentDir, cwd, projectTrusted: trusted, ...(profile ? { profileOverride: profile } : {}) });
  const loaded = await definitions(cwd, trusted);
  const runtime = await ModelRuntime.create();
  return { config: config.config, loaded, runtime };
}

const inside = (target: string, owner: string) => target === owner || target.startsWith(`${owner}${sep}`);
const withinRoot = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const errorCode = (error: unknown) => {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
};

type CanonicalPathOperations = {
  lstat: typeof lstat;
  realpath: typeof realpath;
};

const canonicalPathOperations: CanonicalPathOperations = { lstat, realpath };

async function canonicalPath(path: string, operations: CanonicalPathOperations): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  let observedExistingRetry = false;
  while (true) {
    try {
      const base = await operations.realpath(current);
      return resolve(base, ...missing.reverse());
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw new Error("ownership_path_unresolved");
      let missingEntry = false;
      try {
        await operations.lstat(current);
      } catch (probeError) {
        if (errorCode(probeError) === "ENOENT") missingEntry = true;
        else throw new Error("ownership_path_unresolved");
      }
      if (!missingEntry) {
        // The entry appeared after realpath failed; retry canonical resolution once, never lexically.
        if (observedExistingRetry) throw new Error("ownership_path_unresolved");
        observedExistingRetry = true;
        continue;
      }
      const parent = dirname(current);
      if (parent === current) throw new Error("ownership_path_unresolved");
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

// REVIEW-001: symlink-safe ownership check used by every mutating operation before effects.
export async function assertOwnedPath(
  cwd: string,
  absoluteTarget: string,
  writeScope: string[],
  allowOwnerAncestor = false,
  operations: CanonicalPathOperations = canonicalPathOperations,
): Promise<{ root: string; target: string }> {
  const lexicalRoot = resolve(cwd);
  const root = await operations.realpath(lexicalRoot);
  const lexicalTarget = resolve(absoluteTarget);
  if (!withinRoot(lexicalRoot, lexicalTarget)) throw new Error("ownership_target_outside_project");
  const target = await canonicalPath(lexicalTarget, operations);
  if (!withinRoot(root, target)) throw new Error("ownership_symlink_escape");
  const owners = await Promise.all(writeScope.map(async (entry) => {
    if (!isOwnedTarget(entry, [entry])) throw new Error("ownership_scope_invalid");
    const owner = await canonicalPath(resolve(lexicalRoot, entry), operations);
    if (!withinRoot(root, owner)) throw new Error("ownership_scope_symlink_escape");
    return owner;
  }));
  if (!owners.some((owner) => inside(target, owner) || (allowOwnerAncestor && inside(owner, target)))) {
    throw new Error("ownership_target_out_of_scope");
  }
  return { root, target };
}

type ScopedToolOperations = {
  mkdir?: typeof mkdir;
  readFile?: typeof readFile;
  lstat?: typeof lstat;
  writeFile?: typeof writeFile;
  bash?: Pick<ReturnType<typeof createLocalBashOperations>, "exec">;
};

type ScopedToolInput = {
  cwd: string;
  assignment: DelegationAssignment;
  agent: AgentDefinition;
  operationEvidence?: ScopedToolOperationEvidence;
  operations?: ScopedToolOperations;
};

const hasSupportedNativeMutationPath = (value: unknown) => {
  if (typeof value !== "string" || value.startsWith("@@")) return false;
  const nativePath = value.startsWith("@") ? value.slice(1) : value;
  return Boolean(nativePath)
    && nativePath !== "~"
    && !nativePath.startsWith("~/")
    && !nativePath.startsWith("file://")
    && !nativePath.includes("\\")
    && !nativePath.split("/").includes("..");
};

const assertSupportedNativeMutationPath = (value: unknown) => {
  if (!hasSupportedNativeMutationPath(value)) throw new Error("ownership_path_invalid");
};

const validateNativeMutationToolInput = (toolName: string, input: unknown) => {
  if (toolName !== "write" && toolName !== "edit") return;
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  if (!Object.hasOwn(input, "path")) return;
  assertSupportedNativeMutationPath((input as { path?: unknown }).path);
};

type AssignmentMutationQueue = <Value>(effect: () => Promise<Value>) => Promise<Value>;
type ScopedToolEvidenceOptions = {
  queue?: AssignmentMutationQueue;
  beforeExecute?: (input: unknown) => Promise<void>;
};

const createAssignmentMutationQueue = (): AssignmentMutationQueue => {
  let tail: Promise<void> = Promise.resolve();
  return (effect) => {
    const next = tail.then(effect, effect);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
};

const withScopedToolEvidence = (
  tool: any,
  evidence: ScopedToolOperationEvidence,
  options: ScopedToolEvidenceOptions = {},
): ToolDefinition => ({
  ...tool,
  execute: async (toolCallId: string, input: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => {
    validateNativeMutationToolInput(tool.name, input);
    const execute = () => evidence.runTool(toolCallId, tool.name, async () => {
      await options.beforeExecute?.(input);
      return tool.execute(toolCallId, input, signal, onUpdate, ctx);
    });
    return options.queue ? options.queue(execute) : execute();
  },
}) as ToolDefinition;

// REVIEW-001/SKYNET-222: custom definitions preserve Pi's native tools and queues. Authorization
// happens at each operation boundary; trusted evidence is entered before every possible mutation.
export function createScopedTools(input: ScopedToolInput): ToolDefinition[] {
  const { cwd, assignment, agent } = input;
  if (agent.authority === "document-write" && assignment.writeScope.some((path) => !isDocumentationTarget(path))) throw new Error("document_scope_invalid");
  const evidence = input.operationEvidence ?? createScopedToolOperationEvidence({ attempt: 0 });
  const filesystem = {
    mkdir: input.operations?.mkdir ?? mkdir,
    readFile: input.operations?.readFile ?? readFile,
    lstat: input.operations?.lstat ?? lstat,
    writeFile: input.operations?.writeFile ?? writeFile,
  };
  const documentTarget = (path: string, canonical: { root: string; target: string }) => {
    if (agent.authority !== "document-write") return;
    const lexicalTarget = relative(cwd, path);
    const canonicalTarget = relative(canonical.root, canonical.target);
    if (!isDocumentationTarget(lexicalTarget) || !isDocumentationTarget(canonicalTarget)) {
      throw new Error("documentation_target_required");
    }
  };
  const authorize = async (path: string) => {
    const canonical = await assertOwnedPath(cwd, path, assignment.writeScope);
    documentTarget(path, canonical);
  };
  const authorizeParentDirectory = async (path: string) => {
    await assertOwnedPath(cwd, path, assignment.writeScope, true);
  };
  const safeRelativePath = (path: string) => {
    const root = resolve(cwd);
    const target = resolve(path);
    return withinRoot(root, target)
      ? normalizeOwnershipTarget(relative(root, target))
      : null;
  };
  const nativeMutationTarget = (toolInput: unknown) => {
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
    const path = (toolInput as { path?: unknown }).path;
    if (typeof path !== "string") return null;
    return resolve(cwd, path.startsWith("@") ? path.slice(1) : path);
  };
  const authorizeNativeMutation = async (toolName: "write" | "edit", toolInput: unknown) => {
    const target = nativeMutationTarget(toolInput);
    if (!target) return;
    await evidence.runOperation({
      name: `${toolName}.authorization`,
      mutation: false,
      safeRelativePath: safeRelativePath(target),
      authorize: () => authorize(target),
      effect: async () => undefined,
    });
  };
  const mutationQueue = createAssignmentMutationQueue();
  const mutationToolOptions = (toolName: "write" | "edit") => ({
    queue: mutationQueue,
    beforeExecute: (toolInput: unknown) => authorizeNativeMutation(toolName, toolInput),
  });
  const enabled = new Set(deriveToolAuthority(agent));
  const custom: ToolDefinition[] = [];
  if (enabled.has("write")) {
    custom.push(withScopedToolEvidence(createWriteToolDefinition(cwd, { operations: {
      mkdir: async (path) => evidence.runOperation({
        name: "mkdir",
        mutation: true,
        safeRelativePath: safeRelativePath(path),
        authorize: () => authorizeParentDirectory(path),
        effect: async () => { await filesystem.mkdir(path, { recursive: true }); },
      }),
      writeFile: async (path, content) => evidence.runOperation({
        name: "writeFile",
        mutation: true,
        safeRelativePath: safeRelativePath(path),
        authorize: () => authorize(path),
        effect: async () => { await filesystem.writeFile(path, content); },
      }),
    } }), evidence, mutationToolOptions("write")));
  }
  if (enabled.has("edit")) {
    custom.push(withScopedToolEvidence(createEditToolDefinition(cwd, { operations: {
      readFile: (path) => evidence.runOperation({
        name: "readFile",
        mutation: false,
        safeRelativePath: safeRelativePath(path),
        authorize: () => authorize(path),
        effect: () => filesystem.readFile(path),
      }),
      access: async (path) => evidence.runOperation({
        name: "access",
        mutation: false,
        safeRelativePath: safeRelativePath(path),
        authorize: () => authorize(path),
        effect: async () => { await filesystem.lstat(path); },
      }),
      writeFile: async (path, content) => evidence.runOperation({
        name: "writeFile",
        mutation: true,
        safeRelativePath: safeRelativePath(path),
        authorize: () => authorize(path),
        effect: async () => { await filesystem.writeFile(path, content); },
      }),
    } }), evidence, mutationToolOptions("edit")));
  }
  if (enabled.has("bash") || enabled.has("test")) {
    const local = input.operations?.bash ?? createLocalBashOperations();
    custom.push(withScopedToolEvidence(createBashToolDefinition(cwd, { operations: {
      exec: async (command, commandCwd, options) => {
        const classification = classifyBashCommand(command, assignment.writeScope);
        if (classification.kind === "unsafe-ambiguous") {
          evidence.denyBashBeforeExecution(classification.reason);
          throw new Error(`ownership_bash_denied:${classification.reason}`);
        }
        for (const path of classification.paths) {
          const target = resolve(commandCwd, path);
          await evidence.runOperation({
            name: "bash.authorization",
            mutation: false,
            safeRelativePath: safeRelativePath(target),
            authorize: () => authorize(target),
            effect: async () => undefined,
          });
        }
        return evidence.runOperation({
          name: "bash.exec",
          mutation: classification.kind === "owned-mutation",
          safeRelativePath: null,
          authorize: async () => undefined,
          effect: () => local.exec(command, commandCwd, options),
        });
      },
    } }), evidence));
  }
  return custom;
}

const finalAssistant = (session: any) => {
  const message = [...(session.messages ?? [])].reverse().find((item: any) => item?.role === "assistant");
  if (!message) return undefined;
  const report = (Array.isArray(message.content) ? message.content : [])
    .filter((item: any) => item?.type === "text")
    .map((item: any) => typeof item.text === "string" ? item.text : "")
    .join("")
    .trim();
  return {
    stopReason: message.stopReason,
    isError: message.stopReason === "error",
    hasPendingToolUse: message.stopReason === "toolUse" || message.content?.some((item: any) => item?.type === "toolCall"),
    errorMessage: message.errorMessage,
    report,
  };
};

const observedIdentity = (session: any) => ({
  provider: session.model?.provider,
  model: session.model?.id,
  thinking: session.thinkingLevel,
  sessionId: session.sessionId,
  sessionFile: session.sessionFile ?? "",
});

const eventOwnershipTarget = (cwd: string, target: unknown) => {
  if (!hasSupportedNativeMutationPath(target)) return null;
  const nativeTarget = target.startsWith("@") ? target.slice(1) : target;
  if (!isAbsolute(nativeTarget)) return nativeTarget;
  const projectRoot = resolve(cwd);
  const resolvedTarget = resolve(nativeTarget);
  const relativeTarget = relative(projectRoot, resolvedTarget);
  return withinRoot(projectRoot, resolvedTarget) ? relativeTarget : nativeTarget;
};

const mutationAttemptUnsafe = (
  event: any,
  assignment: DelegationAssignment,
  cwd: string,
) => {
  if (event?.type !== "tool_execution_start") return false;
  if (event.toolName === "write" || event.toolName === "edit") {
    // A safe lexical target may be denied by the trusted operation boundary before entry.
    // Wait for that correlated proof; malformed paths remain immediately unsafe.
    return eventOwnershipTarget(cwd, event.args?.path) === null;
  }
  if (event.toolName !== "bash") return false;
  const classification = classifyBashCommand(event.args?.command, assignment.writeScope);
  return classification.kind === "unsafe-ambiguous"
    && classification.reason === "target_out_of_scope";
};

type CoordinatorDependencies = {
  createSession?: typeof createAgentSession;
  createManager?: (cwd: string) => unknown;
  scopedTools?: typeof createScopedTools;
  clock?: () => string;
  activityClock?: () => number;
  admitImages?: typeof admitVisionImages;
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
  sessionReference?: (assignment: DelegationAssignment) => string;
  onSessionRecord?: (record: SessionRecord) => Promise<void> | void;
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
    admitImages: input.dependencies?.admitImages ?? admitVisionImages,
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
  const toBoundedResult = (result: any) => {
    const report = typeof result.report === "string"
      ? result.report
      : typeof result.unverifiedReport === "string"
        ? result.unverifiedReport
        : undefined;
    return createDelegationResult({
      id: result.id,
      status: result.status,
      attempts: result.attempts,
      error: result.error,
      failure: result.failure,
      escalation: result.escalation,
      completion: result.completion,
      provider: result.provider,
      model: result.model,
      thinking: result.thinking,
      report,
      unverifiedReason: result.unverifiedReason,
      session: report ? {
        id: result.sessionId,
        file: result.sessionFile,
        resumeReference: result.status === "succeeded" ? result.resumeReference : null,
      } : null,
    });
  };
  const runAssignment = async (assignment: DelegationAssignment) => {
    const agent = input.agents.find((item) => item.name === assignment.agent)!;
    const imagePaths = assignment.imagePaths ?? [];
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
    if (cancelled || unsafe) {
      const failure = "unsafe-partial-state" as const;
      emit({ type: "cancelled", id: assignment.id, at: deps.activityClock(), blocker: unsafe ? failure : "cancelled", possiblePartialWriteScopes: assignment.writeScope.length ? assignment.writeScope : [] });
      return { id: assignment.id, status: "cancelled", attempts: 0, error: unsafe ? failure : "cancelled", failure, resumeReference: null };
    }
    const admitted = imagePaths.length ? await deps.admitImages(imagePaths) : { admitted: true as const, value: [] };
    if (!admitted.admitted) {
      const blocker = admitted.error;
      emit({ type: "blocked", id: assignment.id, at: deps.activityClock(), blocker, escalation: "correct the local visual source" });
      return { id: assignment.id, status: "blocked", attempts: 0, error: blocker, failure: "agent-contract" as const, escalation: "correct the local visual source", resumeReference: null };
    }
    let attempt = 0;
    let firstSafeCause: string | null = null;
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
      const operationEvidence = createScopedToolOperationEvidence({
        attempt,
        onUnsafe: () => markUnsafe(assignment),
      });
      const rememberSafeCause = () => {
        const cause = operationEvidence.firstSafeCause();
        if (!firstSafeCause && cause) firstSafeCause = cause;
        return firstSafeCause;
      };
      try {
        state = reduceDelegationEvent(state, { type: "started", id: assignment.id });
        const created = await deps.createSession({
          cwd: input.cwd,
          modelRuntime: input.runtime,
          model,
          thinkingLevel: route.route.thinking as any,
          tools: deriveToolAuthority(agent).map((tool) => agentToolNames[tool]).filter(Boolean),
          customTools: deps.scopedTools({
            cwd: input.cwd,
            assignment,
            agent,
            operationEvidence,
          }),
          sessionManager: deps.createManager(input.cwd) as any,
        });
        session = created.session;
        const identity = validateDelegationRouteIdentity({ expected: route.route, observed: observedIdentity(session) });
        if (!identity.ok) {
          const detail = identity.failures.join(",");
          emit({ type: "failed", id: assignment.id, at: deps.activityClock(), blocker: detail, possiblePartialWriteScopes: [] });
          state = reduceDelegationEvent(state, { type: "failed", id: assignment.id, detail, partialEffects: false });
          return { id: assignment.id, status: "failed", attempts: attempt, error: detail, failure: "agent-contract" as const, completion: identity.failures, resumeReference: null };
        }
        live.set(assignment.id, session);
        unsubscribe = session.subscribe?.((event: any) => {
          try {
            if (event?.type === "agent_start") emit({ type: "child-running", id: assignment.id, at: deps.activityClock(), attempt });
            if (event?.type === "agent_settled") emit({ type: "child-settled", id: assignment.id, at: deps.activityClock() });
            if (event?.type === "tool_execution_start") {
              emit({ type: "child-activity", id: assignment.id, at: deps.activityClock(), category: classifyDelegationActivity(event.toolName, event.args) });
              if (isScopedMutationTool(event.toolName)) {
                operationEvidence.observeToolStart({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                });
              }
            }
            if (mutationAttemptUnsafe(event, assignment, input.cwd)) markUnsafe(assignment);
            if (event?.type === "tool_execution_end"
              && isScopedMutationTool(event.toolName)
              && operationEvidence.isUnsafeToolFailure({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                signalAborted: cancelled || input.signal?.aborted === true,
                isError: event.isError === true,
              })) markUnsafe(assignment);
          } catch {
            markUnsafe(assignment);
          }
        }) ?? unsubscribe;
        if (cancelled || unsafe) { await session.abort?.(); throw new Error(cancelled ? "cancelled" : "unsafe-partial-state"); }
        const brief = buildChildBrief({ projectRoot: input.cwd, assignment, agent, images: admitted.value.map(({ source }) => publicVisionSource(source)) });
        if (admitted.value.length) await session.prompt(brief, { images: admitted.value.map(({ attachment }) => attachment), expandPromptTemplates: false });
        else await session.prompt(brief);
        await session.waitForIdle();
        if (operationEvidence.hasUnsettledToolExecution()) markUnsafe(assignment);
        rememberSafeCause();
        if (cancelled && operationEvidence.hasPossibleMutation()) markUnsafe(assignment);
        if (cancelled || unsafe) throw new Error(cancelled ? "cancelled" : "unsafe-partial-state");
        const final = finalAssistant(session);
        const report = final?.report ?? "";
        const observed = observedIdentity(session);
        const completion = validateDelegationCompletion({ final, text: report, requiredSections: agent.result.requiredSections, expected: route.route, observed });
        if (!completion.ok) {
          if (operationEvidence.hasPossibleMutation()) markUnsafe(assignment);
          const safeCause = rememberSafeCause();
          const providerError = final?.errorMessage;
          const error = unsafe
            ? "unsafe-partial-state"
            : safeCause ?? providerError ?? completion.failures.join(",");
          const failure = unsafe
            ? "unsafe-partial-state"
            : providerError ? classifyChildFailure(providerError) : "agent-contract";
          const recovery = decideRecovery({ failure, retries: attempt - 1 });
          if (recovery.retry && !cancelled && !unsafe) {
            emit({ type: "retrying", id: assignment.id, at: deps.activityClock(), attempt: 2, reason: failure });
            continue;
          }
          const detail = sanitizeDelegationError(error);
          const unverifiedReport = report.trim();
          emit({ type: cancelled ? "cancelled" : "failed", id: assignment.id, at: deps.activityClock(), blocker: detail, possiblePartialWriteScopes: cancelled && assignment.writeScope.length ? assignment.writeScope : [] });
          state = reduceDelegationEvent(state, { type: cancelled ? "cancelled" : "failed", id: assignment.id, detail, partialEffects: unsafe || (cancelled && assignment.writeScope.length > 0) });
          return { id: assignment.id, status: cancelled ? "cancelled" : "failed", attempts: attempt, error: detail, failure, completion: completion.failures, resumeReference: null, ...(unverifiedReport ? { unverifiedReport: report, unverifiedReason: detail, sessionId: observed.sessionId, sessionFile: observed.sessionFile } : {}) };
        }
        const timestamp = deps.clock();
        const reference = text(input.sessionReference?.(assignment) ?? assignment.id);
        if (!reference) throw new Error("session_reference_invalid");
        const record: SessionRecord = {
          reference, agent: agent.name, role: agent.authority, resultKind: agent.result.kind,
          provider: observed.provider!, model: observed.model!, thinking: observed.thinking,
          sessionId: observed.sessionId!, sessionFile: observed.sessionFile!, writeScope: [...assignment.writeScope],
          contractFingerprint: agentContractFingerprint(agent, assignment.writeScope), status: "succeeded",
          fresh: agent.independence.freshInitial, followUpAllowed: agent.independence.followUpAllowed,
          createdAt: timestamp, updatedAt: timestamp,
        };
        await input.onSessionRecord?.(record);
        store.set(record.reference, record);
        emit({ type: "succeeded", id: assignment.id, at: deps.activityClock() });
        state = reduceDelegationEvent(state, { type: "succeeded", id: assignment.id });
        return { id: assignment.id, status: "succeeded", attempts: attempt, report, provider: record.provider, model: record.model, thinking: record.thinking, sessionId: record.sessionId, sessionFile: record.sessionFile, resumeReference: record.followUpAllowed ? record.reference : null };
      } catch (error) {
        if (!unsafe && (operationEvidence.hasUnsettledToolExecution() || operationEvidence.hasPossibleMutation())) markUnsafe(assignment);
        const safeCause = rememberSafeCause();
        const failure = unsafe ? "unsafe-partial-state" : cancelled ? "unsafe-partial-state" : classifyChildFailure(error);
        const recovery = decideRecovery({ failure, retries: attempt - 1 });
        if (recovery.retry && !cancelled && !unsafe) {
          emit({ type: "retrying", id: assignment.id, at: deps.activityClock(), attempt: 2, reason: failure });
          continue;
        }
        const detail = unsafe
          ? "unsafe-partial-state"
          : cancelled
            ? "cancelled"
            : safeCause ?? sanitizeDelegationError(error);
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
    const adversaryAssignments = validateAdversarialAssignments(input.request.assignments);
    if (!adversaryAssignments.valid) {
      const blocker = adversaryAssignments.errors[0] ?? "delegation_adversary_pair_required";
      const results = input.request.assignments.map((assignment) => {
        emit({ type: "blocked", id: assignment.id, at: deps.activityClock(), blocker, escalation: "submit one matching adversary-a and adversary-b pair" });
        return { id: assignment.id, status: "blocked" as const, attempts: 0, error: blocker, failure: "agent-contract" as const, escalation: "submit one matching adversary-a and adversary-b pair", resumeReference: null };
      }).map(toBoundedResult);
      emit({ type: "run-settled", at: deps.activityClock(), state: "failed" });
      const report = buildDelegationOutcomeReport({ activity, results, partialEffects: false, unsafeEvidence: [] });
      return { status: "failed" as const, results, state, activity, report, partialEffects: false, unsafeEvidence: [] };
    }
    const adversaryNames = new Set(input.request.assignments.map((assignment) => assignment.agent));
    if (adversaryNames.has("adversary-a") && adversaryNames.has("adversary-b")) {
      const validation = validateAdversarialRoutes({ config: input.config, catalog });
      if (!validation.valid) {
        const results = input.request.assignments.map((assignment) => {
          emit({ type: "blocked", id: assignment.id, at: deps.activityClock(), blocker: validation.code, escalation: "configure two distinct available adversary routes" });
          return { id: assignment.id, status: "blocked" as const, attempts: 0, error: validation.code, failure: "model-unavailable" as const, escalation: "configure two distinct available adversary routes", resumeReference: null };
        }).map(toBoundedResult);
        emit({ type: "run-settled", at: deps.activityClock(), state: "failed" });
        const report = buildDelegationOutcomeReport({ activity, results, partialEffects: false, unsafeEvidence: [] });
        return { status: "failed" as const, results, state, activity, report, partialEffects: false, unsafeEvidence: [] };
      }
    }
    const settled = await Promise.allSettled(input.request.assignments.map(runAssignment));
    if (cancelled || unsafe) await abortLive();
    const results = settled.map((entry, index) => entry.status === "fulfilled"
      ? entry.value
      : { id: input.request.assignments[index].id, status: "failed", attempts: 0, error: sanitizeDelegationError(entry.reason), failure: classifyChildFailure(entry.reason), resumeReference: null }).map(toBoundedResult);
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
  signal?: AbortSignal;
  sessionStore?: Map<string, SessionRecord>;
  onSessionRecord?: (record: SessionRecord) => Promise<void> | void;
  dependencies?: CoordinatorDependencies & {
    openManager?: (path: string) => unknown;
    fileExists?: (path: string) => boolean;
    acquireSessionLock?: (path: string) => Promise<NativeFileLease | null>;
  };
};

// REVIEW-004: reopen and execute the exact persisted session after status, independence,
// fingerprint, file, model, terminal-result, and observed-identity checks.
export async function runFocusedContinuation(input: ContinuationInput) {
  return runFocusedAgentContinuation({
    record: input.record,
    agent: input.agent,
    brief: input.brief,
    runtime: input.runtime,
    cwd: input.cwd,
    signal: input.signal,
    sessionStore: input.sessionStore ?? sessions,
    onSessionRecord: input.onSessionRecord,
    dependencies: {
      createSession: input.dependencies?.createSession,
      openManager: input.dependencies?.openManager,
      acquireSessionLock: input.dependencies?.acquireSessionLock,
      scopedTools: input.dependencies?.scopedTools ?? createScopedTools,
      toolNames: agentToolNames,
      finalAssistant,
      mutationAttemptUnsafe: (event, assignment, cwd) =>
        mutationAttemptUnsafe(event, assignment, cwd),
      clock: input.dependencies?.clock ?? now,
      fileExists: input.dependencies?.fileExists,
    },
  });
}

const cycleOwner = (ctx: Pick<ExtensionContext, "sessionManager">): CycleSessionOwner | null =>
  cycleSessionOwnerFromEntries(ctx.sessionManager.getBranch?.() ?? []);

const cacheCycleOwnedSession = (record: SessionRecord, owner: CycleSessionOwner) => {
  sessions.set(record.reference, structuredClone(record));
  cycleSessionOwners.set(record.reference, structuredClone(owner));
};

export const createSessionPersistence = (cwd: string, owner: CycleSessionOwner | null) => {
  if (owner) return {
    sessionReference: () => createCycleSessionReference(),
    onSessionRecord: async (record: SessionRecord) => {
      await storeCycleOwnedSessionRecord({ cwd, owner, record });
      cacheCycleOwnedSession(record, owner);
    },
  };
  return {
    sessionReference: () => createDirectSessionReference(),
    onSessionRecord: (record: SessionRecord) => record.followUpAllowed
      ? storeDirectSessionRecord({ cwd, record })
      : undefined,
  };
};

type RestoredSessionRecord = {
  record: SessionRecord;
  owner: CycleSessionOwner | null;
  storage: "cycle" | "direct" | "memory";
};

const restoredCycleSession = (record: SessionRecord, owner: CycleSessionOwner): RestoredSessionRecord => ({
  record: structuredClone(record),
  owner: structuredClone(owner),
  storage: "cycle",
});

export const restoreSessionRecord = async (
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
  reference: string,
  capturedOwner: CycleSessionOwner | null = cycleOwner(ctx),
): Promise<RestoredSessionRecord | null> => {
  const normalizedReference = text(reference);
  if (!normalizedReference) return null;
  if (capturedOwner) {
    const persisted = await loadCycleOwnedSession({
      cwd: ctx.cwd,
      owner: capturedOwner,
      reference: normalizedReference,
    });
    if (persisted) {
      cacheCycleOwnedSession(persisted.record, persisted.owner);
      return restoredCycleSession(persisted.record, persisted.owner);
    }
    const cachedOwner = cycleSessionOwners.get(normalizedReference);
    const cachedRecord = sessions.get(normalizedReference);
    if (cachedOwner && cachedRecord && sameCycleSessionLifecycle(cachedOwner, capturedOwner)) {
      return restoredCycleSession(cachedRecord, cachedOwner);
    }
  }

  const cachedOwner = cycleSessionOwners.get(normalizedReference);
  const cachedRecord = sessions.get(normalizedReference);
  if (cachedOwner && cachedRecord) return null;
  if (isCycleSessionReference(normalizedReference)) return null;

  const knownCycleRecord = await findCycleOwnedSession({
    cwd: ctx.cwd,
    reference: normalizedReference,
  });
  if (knownCycleRecord) {
    cacheCycleOwnedSession(knownCycleRecord.record, knownCycleRecord.owner);
    return capturedOwner && sameCycleSessionLifecycle(knownCycleRecord.owner, capturedOwner)
      ? restoredCycleSession(knownCycleRecord.record, knownCycleRecord.owner)
      : null;
  }

  if (cachedRecord) return { record: structuredClone(cachedRecord), owner: null, storage: "memory" };
  const direct = await loadDirectSessionRecord({ cwd: ctx.cwd, reference: normalizedReference });
  if (!direct) return null;
  sessions.set(direct.reference, structuredClone(direct));
  return { record: direct, owner: null, storage: "direct" };
};

export const runAgentFollowUp = async (input: {
  ctx: ExtensionContext;
  reference: string;
  brief: string;
  signal?: AbortSignal;
}) => {
  const reference = text(input.reference);
  const brief = typeof input.brief === "string" && input.brief.trim().length <= 16_000
    ? input.brief.trim()
    : "";
  const cwd = input.ctx.cwd;
  const owner = cycleOwner(input.ctx);
  const trusted = resolveProjectTrust(input.ctx);
  if (!reference || !brief) return createDelegationResult({ id: reference || "unknown", status: "refused", attempts: 0, error: "session_follow_up_invalid", session: null });
  if (continuingSessions.has(reference)) return createDelegationResult({ id: reference, status: "refused", attempts: 0, error: "session_follow_up_busy", session: null });
  continuingSessions.add(reference);
  try {
    const restored = await restoreSessionRecord({ cwd, sessionManager: input.ctx.sessionManager }, reference, owner);
    const record = restored?.record;
    const loaded = await definitions(cwd, trusted);
    const agent = loaded.definitions.find((item) => item.name === record?.agent);
    if (!record || !agent) {
      return createDelegationResult({ id: reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
    }
    const canonicalCwd = await realpath(cwd);
    const runtime = await ModelRuntime.create();
    const onSessionRecord = restored.storage === "cycle" && restored.owner
      ? async (updated: SessionRecord) => {
        await storeCycleOwnedSessionRecord({ cwd: canonicalCwd, owner: restored.owner!, record: updated });
        cacheCycleOwnedSession(updated, restored.owner!);
      }
      : (updated: SessionRecord) => storeDirectSessionRecord({ cwd: canonicalCwd, record: updated });
    return await runFocusedContinuation({
      record,
      agent,
      brief,
      runtime,
      cwd: canonicalCwd,
      signal: input.signal,
      sessionStore: sessions,
      onSessionRecord,
    });
  } catch {
    return createDelegationResult({ id: reference, status: "refused", attempts: 0, error: "session_record_unavailable", session: null });
  } finally {
    continuingSessions.delete(reference);
  }
};

export default function agents(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ima_delegate",
    label: "IMA delegate",
    description: "Delegate one to four bounded, agent-defined assignments. Terminal summaries are capped at 400 lines or 10 KiB per child; inspect the structured session pointer for the full report.",
    promptSnippet: "Delegate one to four bounded assignments to an applicable IMA agent.",
    promptGuidelines: [
      "Use ima_delegate opportunistically for a clear agent match or an explicit request to use a named IMA agent; do not delegate when no agent fits. Rereview and verified-finding follow-up must use an eligible existing reviewer continuation, not a new reviewer delegation.",
      "With ima_delegate, give writers exact, disjoint write scopes, never ask a child to delegate, and rely on visible activity instead of a confirmation loop.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({ title: Type.String(), assignments: Type.Array(Type.Object({ id: Type.String(), agent: Type.String(), goal: Type.String(), context: Type.String(), paths: Type.Array(Type.String()), constraints: Type.Array(Type.String()), nonGoals: Type.Array(Type.String()), expectedOutput: Type.String(), writeScope: Type.Array(Type.String()), imagePaths: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })) }), { minItems: 1, maxItems: 4 }) }),
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
        const trusted = resolveProjectTrust(ctx);
        const profile = readSessionProfile(ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries());
        const { config, loaded, runtime } = await runtimeContext(ctx.cwd, profile, trusted);
        if (!config || loaded.diagnostics.length) return { content: [{ type: "text", text: JSON.stringify({ status: "blocked", errors: [...config?.diagnostics ?? [], ...loaded.diagnostics] }) }], details: { status: "blocked" } };
        const valid = validateDelegationRequest(request, loaded.definitions);
        if (!valid.valid) return { content: [{ type: "text", text: JSON.stringify({ status: "blocked", errors: valid.errors }) }], details: { status: "blocked" } };
        const persistence = createSessionPersistence(ctx.cwd, cycleOwner(ctx));
        result = await coordinateDelegation({
          cwd: ctx.cwd,
          request,
          agents: loaded.definitions,
          config,
          runtime,
          runId: toolCallId,
          onActivity: project,
          signal,
          sessionStore: sessions,
          ...persistence,
        });
      } finally {
        if (ctx.mode === "tui") {
          try { ctx.ui.setWidget(activityProjectionKey, undefined); } catch { projectionDegraded = true; }
          try { ctx.ui.setStatus(activityProjectionKey, undefined); } catch { projectionDegraded = true; }
        }
      }
      // Build the terminal report only after clearing so clear failures remain observable.
      const parentResult = buildDelegationToolPayload({
        status: result.status,
        results: result.results,
        report: { ...result.report, projectionDegraded },
      });
      const details = parentResult.overflow
        ? { ...parentResult.payload, projectionDegraded }
        : { ...result, status: parentResult.payload.status, results: parentResult.payload.results, report: parentResult.payload.report, projectionDegraded };
      return { content: [{ type: "text", text: parentResult.serialized }], details };
    },
  });
  pi.registerTool({
    name: "ima_agent_follow_up",
    label: "IMA Agent Follow-up",
    description: "Continue one eligible persisted IMA specialist session with a bounded literal brief.",
    parameters: Type.Object({
      reference: Type.String({ minLength: 1, maxLength: 256 }),
      brief: Type.String({ minLength: 1, maxLength: 16_000 }),
    }),
    async execute(_toolCallId, request, signal, _onUpdate, ctx) {
      const result = await runAgentFollowUp({ ctx, reference: request.reference, brief: request.brief, signal });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!event.systemPromptOptions.selectedTools?.includes("ima_delegate")) return;
    try {
      const loaded = await definitions(
        event.systemPromptOptions.cwd,
        resolveProjectTrust(ctx),
      );
      return {
        systemPrompt: appendAgentCatalog(
          event.systemPrompt,
          buildAgentCatalogPrompt(loaded),
        ),
      };
    } catch {
      return {
        systemPrompt: appendAgentCatalog(
          event.systemPrompt,
          IMA_AGENT_CATALOG_UNAVAILABLE,
        ),
      };
    }
  });
  pi.registerCommand("ima:agents", { description: "List resolved IMA agents.", handler: async (_args, ctx) => { const loaded = await definitions(ctx.cwd, resolveProjectTrust(ctx)); const rows = loaded.definitions.map(({ name, source, tier, authority, description, useWhen }) => `${name}\t${source}\t${tier}\t${authority}\t${description}\t${useWhen.join("; ")}`); ctx.ui.notify(rows.join("\n") || "No valid IMA agents.", loaded.diagnostics.length ? "warning" : "info"); } });
  pi.registerCommand("ima:agent-sessions", { description: "List sanitized IMA agent session references.", handler: async (_args, ctx) => ctx.ui.notify([...sessions.values()].map((record) => `${record.reference}\t${record.role}\t${record.provider}/${record.model}\t${record.status}`).join("\n") || "No IMA agent sessions.", "info") });
  pi.registerCommand("ima:agent-follow-up", { description: "Run a focused continuation: <session-reference> <brief>.", handler: async (args, ctx) => {
    const [reference, ...rest] = args.trim().split(/\s+/);
    const result = await runAgentFollowUp({ ctx, reference, brief: rest.join(" ") });
    ctx.ui.notify(JSON.stringify(result), result.status === "succeeded" ? "info" : "warning");
  } });
}
