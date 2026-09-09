import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  CYCLE_PHASE_SETTLEMENT_ENTRY,
  createCyclePhaseSettlement,
  hasMatchingCyclePhaseSettlement,
  validateCyclePhaseArtifactReference,
  validateCyclePhaseSettlement,
  type CyclePhaseArtifactReference,
  type CyclePhaseContext,
  type CyclePhaseExecution,
  type CyclePhaseRoute,
  type CyclePhaseSettlement,
} from "./ima-cycle-phase.ts";

export const CYCLE_PHASE_CONTEXT_ENTRY = "ima-cycle-phase-context";
const IMA_PROFILE_ENTRY = "ima-profile-state";
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cycleExtensionPath = resolve(packageRoot, "extensions", "cycle.ts");
const REQUIRED_PHASE_TOOLS = [
  "ima_context",
  "ima_lifecycle",
  "ima_delegate",
  "ima_agent_follow_up",
  "mcp",
  "ima_corpus_status",
  "ima_corpus_store",
  "ima_corpus_find",
  "ima_corpus_recall",
  "ima_corpus_get",
] as const;

export type LifecycleToolResult = {
  toolCallId: string;
  input: unknown;
  result: {
    content: unknown;
    details: unknown;
    isError: boolean;
  };
};

export type PhaseSessionIdentity = {
  childSessionId: string;
  childSessionFile: string;
  childSessionDir: string;
};

export type CyclePhaseLifecycleAcceptance = CyclePhaseArtifactReference;

export type CyclePhaseRuntimeResult = {
  status: "settled" | "waiting-reply" | "failed" | "aborted" | "busy";
  acceptedEvidence: boolean;
  output: string;
  identity: PhaseSessionIdentity;
  settlement?: CyclePhaseSettlement;
  error?: string;
};

export type CyclePhaseRuntimeDependencies = {
  createRuntime?: typeof createAgentSessionRuntime;
  createServices?: typeof createAgentSessionServices;
  createSession?: typeof createAgentSessionFromServices;
  createModelRuntime?: () => Promise<ModelRuntime>;
  createSettings?: (cwd: string, agentDir: string, projectTrusted: boolean) => SettingsManager;
  createManager?: (cwd: string) => SessionManager;
  openManager?: (file: string, directory: string) => SessionManager;
  canonical?: (path: string) => Promise<string>;
  stat?: typeof lstat;
};

export type CreateCyclePhaseRuntimeInput = {
  cwd: string;
  route: CyclePhaseRoute;
  execution: CyclePhaseExecution;
  context: CyclePhaseContext;
  projectTrusted: boolean;
  modelRuntime?: ModelRuntime;
  onStarted?: (identity: PhaseSessionIdentity) => Promise<void> | void;
  onLifecycle?: (event: LifecycleToolResult) => Promise<CyclePhaseLifecycleAcceptance | null> | CyclePhaseLifecycleAcceptance | null;
  onActivity?: (message: string) => void;
  dependencies?: CyclePhaseRuntimeDependencies;
};

export type ReadCyclePhaseSettlementInput = {
  cwd: string;
  execution: CyclePhaseExecution;
  context: CyclePhaseContext;
  dependencies?: Pick<CyclePhaseRuntimeDependencies, "openManager" | "canonical" | "stat">;
};

export type CyclePhaseRuntime = {
  identity: PhaseSessionIdentity;
  run: (prompt: string) => Promise<CyclePhaseRuntimeResult>;
  reply: (answer: string) => Promise<CyclePhaseRuntimeResult>;
  abort: () => Promise<void>;
  dispose: () => Promise<void>;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(".."));
};
const finalAssistantText = (session: any) => {
  const assistant = [...(session.messages ?? [])].reverse().find((message: any) => message?.role === "assistant");
  const output = (Array.isArray(assistant?.content) ? assistant.content : [])
    .filter((item: any) => item?.type === "text")
    .map((item: any) => text(item.text))
    .filter(Boolean)
    .join("\n")
    .trim();
  return { stopReason: assistant?.stopReason, output };
};
const safeResultError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "phase_runtime_failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 256) || "phase_runtime_failed";
};
const phaseRuntimeExtensions = (base: any) => ({
  ...base,
  extensions: base.extensions.filter((extension: any) => resolve(extension.resolvedPath) !== cycleExtensionPath),
});

export const cyclePhaseResourceLoaderOptions = () => ({
  additionalExtensionPaths: [packageRoot],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  extensionsOverride: phaseRuntimeExtensions,
});

const validContext = (value: unknown, expected: CyclePhaseContext): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Partial<CyclePhaseContext>;
  return context.schemaVersion === 1
    && context.project === expected.project
    && context.lifecycleKey === expected.lifecycleKey
    && context.source === expected.source
    && context.phase === expected.phase
    && context.dispatchId === expected.dispatchId;
};

const managerIdentity = (manager: SessionManager): PhaseSessionIdentity | null => {
  const childSessionId = text(manager.getSessionId());
  const childSessionFile = text(manager.getSessionFile());
  const childSessionDir = text(manager.getSessionDir());
  return childSessionId && childSessionFile && childSessionDir
    ? { childSessionId, childSessionFile, childSessionDir }
    : null;
};

const sessionIdentity = (manager: SessionManager, session: any): PhaseSessionIdentity | null => {
  const currentManagerIdentity = managerIdentity(manager);
  if (!currentManagerIdentity) return null;
  const childSessionId = text(session.sessionId) || currentManagerIdentity.childSessionId;
  const childSessionFile = text(session.sessionFile) || currentManagerIdentity.childSessionFile;
  return { ...currentManagerIdentity, childSessionId, childSessionFile };
};

const sameSessionIdentity = (left: PhaseSessionIdentity, right: PhaseSessionIdentity) =>
  left.childSessionId === right.childSessionId
  && resolve(left.childSessionFile) === resolve(right.childSessionFile)
  && resolve(left.childSessionDir) === resolve(right.childSessionDir);

const observeRuntimeIdentity = (
  manager: SessionManager,
  session: any,
  expectedIdentity: PhaseSessionIdentity,
  input: Pick<CreateCyclePhaseRuntimeInput, "execution" | "route">,
): { identity: PhaseSessionIdentity | null; error: string | null } => {
  const identity = sessionIdentity(manager, session);
  const currentManagerIdentity = managerIdentity(manager);
  if (!identity || !currentManagerIdentity) return { identity: null, error: "phase_session_identity_missing" };
  if (!sameSessionIdentity(identity, currentManagerIdentity) || !sameSessionIdentity(identity, expectedIdentity)) {
    return { identity, error: "phase_session_identity_mismatch" };
  }
  const execution = input.execution;
  if (
    execution.childSessionId && identity.childSessionId !== execution.childSessionId
    || execution.childSessionFile && resolve(identity.childSessionFile) !== resolve(execution.childSessionFile)
    || execution.childSessionDir && resolve(identity.childSessionDir) !== resolve(execution.childSessionDir)
  ) return { identity, error: "phase_session_identity_mismatch" };
  if (session.model?.provider !== input.route.provider || session.model?.id !== input.route.model) {
    return { identity, error: "phase_runtime_identity_mismatch" };
  }
  if (input.route.thinking && session.thinkingLevel !== input.route.thinking) {
    return { identity, error: "phase_thinking_unsupported" };
  }
  return { identity, error: null };
};

const missingRequiredTools = (session: any) => {
  const tools = typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : [];
  const active = new Set(Array.isArray(tools) ? tools.filter((name) => typeof name === "string") : []);
  return REQUIRED_PHASE_TOOLS.filter((name) => !active.has(name));
};

const phaseRuntimeDependencies = (dependencies: CyclePhaseRuntimeDependencies | undefined) => ({
  createRuntime: dependencies?.createRuntime ?? createAgentSessionRuntime,
  createServices: dependencies?.createServices ?? createAgentSessionServices,
  createSession: dependencies?.createSession ?? createAgentSessionFromServices,
  createModelRuntime: dependencies?.createModelRuntime ?? (() => ModelRuntime.create()),
  createSettings: dependencies?.createSettings ?? ((cwd: string, agentDir: string, projectTrusted: boolean) => SettingsManager.create(cwd, agentDir, { projectTrusted })),
  createManager: dependencies?.createManager ?? ((cwd: string) => SessionManager.create(cwd)),
  openManager: dependencies?.openManager ?? ((file: string, directory: string) => SessionManager.open(file, directory)),
  canonical: dependencies?.canonical ?? realpath,
  stat: dependencies?.stat ?? lstat,
});

type ExistingPhaseSessionInput = Pick<CreateCyclePhaseRuntimeInput, "cwd" | "execution" | "context">;
type ExistingPhaseSessionDependencies = Pick<ReturnType<typeof phaseRuntimeDependencies>, "canonical" | "stat" | "openManager">;

const verifyExistingSession = async (
  input: ExistingPhaseSessionInput,
  dependencies: ExistingPhaseSessionDependencies,
): Promise<SessionManager> => {
  const execution = input.execution;
  if (!execution.childSessionId || !execution.childSessionFile || !execution.childSessionDir) throw new Error("phase_session_identity_missing");
  const [fileDetails, sessionFile, sessionDirectory] = await Promise.all([
    dependencies.stat(execution.childSessionFile),
    dependencies.canonical(execution.childSessionFile),
    dependencies.canonical(execution.childSessionDir),
  ]);
  if (!fileDetails.isFile() || fileDetails.isSymbolicLink()) throw new Error("phase_session_file_invalid");
  if (!inside(sessionDirectory, sessionFile)) throw new Error("phase_session_path_invalid");
  const manager = dependencies.openManager(sessionFile, sessionDirectory);
  const header = manager.getHeader();
  if (resolve(manager.getCwd()) !== resolve(input.cwd)) throw new Error("phase_session_project_mismatch");
  if (!header || text(header.id) !== execution.childSessionId || resolve(text(header.cwd)) !== resolve(input.cwd)) throw new Error("phase_session_identity_mismatch");
  if (text(manager.getSessionId()) !== execution.childSessionId) throw new Error("phase_session_identity_mismatch");
  if (resolve(text(manager.getSessionFile())) !== resolve(sessionFile)) throw new Error("phase_session_identity_mismatch");
  const context = [...manager.getBranch()].reverse().find((entry: any) => entry?.type === "custom" && entry.customType === CYCLE_PHASE_CONTEXT_ENTRY);
  if (!validContext(context?.data, input.context)) throw new Error("phase_session_context_mismatch");
  return manager;
};

export async function readCyclePhaseSettlement(input: ReadCyclePhaseSettlementInput): Promise<CyclePhaseSettlement | null> {
  try {
    const dependencies = phaseRuntimeDependencies(input.dependencies);
    const manager = await verifyExistingSession(input, dependencies);
    const entry = [...manager.getBranch()]
      .reverse()
      .find((candidate: any) => candidate?.type === "custom" && candidate.customType === CYCLE_PHASE_SETTLEMENT_ENTRY);
    const settlement = entry?.data;
    return hasMatchingCyclePhaseSettlement({
      settlement: validateCyclePhaseSettlement(settlement) ? settlement : null,
      execution: input.execution,
      context: input.context,
    })
      ? settlement
      : null;
  } catch {
    return null;
  }
}

export async function createCyclePhaseRuntime(input: CreateCyclePhaseRuntimeInput): Promise<CyclePhaseRuntime> {
  const dependencies = phaseRuntimeDependencies(input.dependencies);
  const agentDir = getAgentDir();
  const resume = input.execution.status !== "starting";
  const manager = resume
    ? await verifyExistingSession(input, dependencies)
    : dependencies.createManager(input.cwd);

  if (!resume) {
    manager.appendCustomEntry(IMA_PROFILE_ENTRY, { profile: input.route.profile });
    manager.appendCustomEntry(CYCLE_PHASE_CONTEXT_ENTRY, input.context);
  }

  const modelRuntime = input.modelRuntime ?? await dependencies.createModelRuntime();
  const settingsManager = dependencies.createSettings(input.cwd, agentDir, input.projectTrusted);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const services = await dependencies.createServices({
      cwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: cyclePhaseResourceLoaderOptions(),
    });
    const model = services.modelRuntime.getModel(input.route.provider, input.route.model);
    if (!model) throw new Error("phase_model_unavailable");
    const created = await dependencies.createSession({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      ...(input.route.thinking ? { thinkingLevel: input.route.thinking } : {}),
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await dependencies.createRuntime(createRuntime, {
    cwd: input.cwd,
    agentDir,
    sessionManager: manager,
  });
  const session = runtime.session;
  let disposed = false;
  let aborted = false;
  let running = false;
  let inFlightInvocation: Promise<CyclePhaseRuntimeResult> | null = null;
  let drain: Promise<void> | null = null;
  const lifecycleInputs = new Map<string, unknown>();
  const lifecycleTasks: Promise<CyclePhaseLifecycleAcceptance | null>[] = [];

  const disposeRuntime = async () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    await runtime.dispose();
  };
  const abortAndDispose = () => {
    if (drain) return drain;
    aborted = true;
    const invocation = inFlightInvocation;
    drain = (async () => {
      try {
        await session.abort();
      } finally {
        try {
          if (invocation) await invocation;
        } finally {
          try {
            await session.waitForIdle();
          } finally {
            await disposeRuntime();
          }
        }
      }
    })();
    return drain;
  };
  const unsubscribe = session.subscribe?.((event: any) => {
    if (event?.type === "agent_start") input.onActivity?.("phase agent started");
    if (event?.type === "agent_settled") input.onActivity?.("phase agent settled");
    if (event?.type === "tool_execution_start") {
      input.onActivity?.(`phase tool: ${text(event.toolName) || "unknown"}`);
      if (event.toolName === "ima_lifecycle" && text(event.toolCallId)) lifecycleInputs.set(text(event.toolCallId), event.args);
      return;
    }
    if (event?.type !== "tool_execution_end" || event.toolName !== "ima_lifecycle") return;
    const toolCallId = text(event.toolCallId);
    const lifecycleInput = lifecycleInputs.get(toolCallId);
    lifecycleInputs.delete(toolCallId);
    if (!toolCallId || lifecycleInput === undefined) return;
    const result = event.result as Record<string, unknown> | undefined;
    const task = Promise.resolve(input.onLifecycle?.({
      toolCallId,
      input: lifecycleInput,
      result: {
        content: result?.content,
        details: result?.details,
        isError: event.isError === true,
      },
    }) ?? null)
      .then((acceptance) => validateCyclePhaseArtifactReference(acceptance) ? acceptance : null)
      .catch(() => null);
    lifecycleTasks.push(task);
  }) ?? (() => undefined);

  try {
    await session.bindExtensions({
      mode: "print",
      abortHandler: () => { void abortAndDispose(); },
      shutdownHandler: () => { void abortAndDispose(); },
    });
    const identity = sessionIdentity(manager, session);
    if (!identity) throw new Error("phase_session_identity_missing");
    const initialIdentity = observeRuntimeIdentity(manager, session, identity, input);
    if (initialIdentity.error) throw new Error(initialIdentity.error);
    if (missingRequiredTools(session).length) throw new Error("phase_toolkit_missing");
    await input.onStarted?.(identity);

    const abortedResult = (output = ""): CyclePhaseRuntimeResult => ({
      status: "aborted",
      acceptedEvidence: false,
      output,
      identity,
    });
    const rejectCancelledPreflight = (success: boolean) => {
      if (success && (aborted || disposed)) throw new Error("phase_prompt_cancelled");
    };
    const runInvocation = async (
      message: string,
      lifecycleStart: number,
    ): Promise<CyclePhaseRuntimeResult> => {
      try {
        let invocationError: unknown = null;
        try {
          await session.prompt(message, {
            expandPromptTemplates: false,
            source: "extension",
            preflightResult: rejectCancelledPreflight,
          });
        } catch (error) {
          invocationError = error;
        }
        try {
          await session.waitForIdle();
        } catch (error) {
          invocationError ??= error;
        }
        let acceptances: CyclePhaseLifecycleAcceptance[] = [];
        try {
          acceptances = (await Promise.all(lifecycleTasks.slice(lifecycleStart)))
            .flatMap((acceptance) => acceptance ? [acceptance] : []);
        } catch (error) {
          invocationError ??= error;
        }
        if (aborted || disposed) return abortedResult();
        if (invocationError) {
          return { status: "failed", acceptedEvidence: false, output: "", identity, error: safeResultError(invocationError) };
        }
        const final = finalAssistantText(session);
        if (final.stopReason === "aborted") return abortedResult(final.output);
        if (final.stopReason !== "stop") {
          return { status: "failed", acceptedEvidence: false, output: final.output, identity, error: "phase_agent_not_settled" };
        }
        const finalIdentity = observeRuntimeIdentity(manager, session, identity, input);
        if (finalIdentity.error || !finalIdentity.identity) {
          return {
            status: "failed",
            acceptedEvidence: false,
            output: final.output,
            identity,
            error: finalIdentity.error ?? "phase_session_identity_missing",
          };
        }
        if (!acceptances.length) return { status: "waiting-reply", acceptedEvidence: false, output: final.output, identity: finalIdentity.identity };
        if (acceptances.length !== 1) {
          return { status: "failed", acceptedEvidence: false, output: final.output, identity, error: "phase_lifecycle_ambiguous" };
        }
        const settlement = createCyclePhaseSettlement({
          project: input.context.project,
          lifecycleKey: input.context.lifecycleKey,
          source: input.context.source,
          phase: input.context.phase,
          dispatchId: input.context.dispatchId,
          childSessionId: finalIdentity.identity.childSessionId,
          actual: {
            provider: session.model.provider,
            model: session.model.id,
            thinking: session.thinkingLevel,
          },
          artifacts: acceptances,
        });
        if (!settlement) {
          return { status: "failed", acceptedEvidence: false, output: final.output, identity, error: "phase_settlement_invalid" };
        }
        try {
          manager.appendCustomEntry(CYCLE_PHASE_SETTLEMENT_ENTRY, settlement);
        } catch {
          return { status: "failed", acceptedEvidence: false, output: final.output, identity, error: "phase_settlement_persist_failed" };
        }
        return {
          status: "settled",
          acceptedEvidence: true,
          output: final.output,
          identity: finalIdentity.identity,
          settlement,
        };
      } catch (error) {
        return aborted
          ? abortedResult()
          : { status: "failed", acceptedEvidence: false, output: "", identity, error: safeResultError(error) };
      } finally {
        lifecycleInputs.clear();
        running = false;
      }
    };
    const execute = (message: string): Promise<CyclePhaseRuntimeResult> => {
      if (disposed) {
        return Promise.resolve({ status: "aborted", acceptedEvidence: false, output: "", identity, error: "phase_session_disposed" });
      }
      if (aborted) {
        return Promise.resolve({ status: "aborted", acceptedEvidence: false, output: "", identity, error: "phase_session_aborted" });
      }
      if (running) return Promise.resolve({ status: "busy", acceptedEvidence: false, output: "", identity, error: "phase_session_busy" });
      if (!text(message)) return Promise.resolve({ status: "failed", acceptedEvidence: false, output: "", identity, error: "phase_message_invalid" });
      const beforePromptIdentity = observeRuntimeIdentity(manager, session, identity, input);
      if (beforePromptIdentity.error) {
        return Promise.resolve({
          status: "failed",
          acceptedEvidence: false,
          output: "",
          identity,
          error: beforePromptIdentity.error,
        });
      }
      running = true;
      const lifecycleStart = lifecycleTasks.length;
      let resolveInvocation: (result: CyclePhaseRuntimeResult) => void = () => undefined;
      const invocation = new Promise<CyclePhaseRuntimeResult>((resolveInvocationResult) => {
        resolveInvocation = resolveInvocationResult;
      });
      inFlightInvocation = invocation;
      void runInvocation(message, lifecycleStart).then(
        resolveInvocation,
        (error) => resolveInvocation({
          status: aborted ? "aborted" : "failed",
          acceptedEvidence: false,
          output: "",
          identity,
          error: safeResultError(error),
        }),
      );
      void invocation.finally(() => {
        if (inFlightInvocation === invocation) inFlightInvocation = null;
      });
      return invocation;
    };

    return {
      identity,
      run: execute,
      reply: execute,
      abort: abortAndDispose,
      dispose: async () => running ? abortAndDispose() : disposeRuntime(),
    };
  } catch (error) {
    unsubscribe();
    await runtime.dispose().catch(() => undefined);
    throw error;
  }
}
