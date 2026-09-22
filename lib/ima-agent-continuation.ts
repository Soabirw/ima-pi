import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./ima-agents.ts";
import {
  agentContractFingerprint,
  canResumeSession,
  classifyChildFailure,
  composeDelegatedBashPrompt,
  createDelegationResult,
  decideRecovery,
  deriveToolAuthority,
  isDocumentationTarget,
  normalizeOwnershipTarget,
  sanitizeDelegationError,
  validateDelegationCompletion,
  type DelegationAssignment,
  type SessionRecord,
} from "./ima-delegation.ts";
import { acquireNativeSessionLock, type NativeFileLease } from "./ima-agent-session-lock.ts";

export type FocusedContinuationDependencies = {
  createSession?: typeof createAgentSession;
  openManager?: (path: string) => unknown;
  acquireSessionLock?: (path: string) => Promise<NativeFileLease | null>;
  scopedTools: (input: {
    cwd: string;
    assignment: DelegationAssignment;
    agent: AgentDefinition;
    operationEvidence?: ScopedToolOperationEvidence;
  }) => unknown[];
  toolNames: Record<string, string>;
  finalAssistant: (session: unknown) => {
    stopReason?: unknown;
    isError?: boolean;
    hasPendingToolUse?: boolean;
    errorMessage?: unknown;
    report?: string;
  } | undefined;
  mutationAttemptUnsafe: (
    event: unknown,
    assignment: DelegationAssignment,
    cwd: string,
  ) => boolean;
  clock?: () => string;
  fileExists?: (path: string) => boolean;
};

export type FocusedContinuationInput = {
  record: SessionRecord;
  agent: AgentDefinition;
  brief: string;
  runtime: any;
  cwd: string;
  signal?: AbortSignal;
  sessionStore: Map<string, SessionRecord>;
  onSessionRecord?: (record: SessionRecord) => Promise<void> | void;
  dependencies: FocusedContinuationDependencies;
};

const now = () => new Date().toISOString();
const SESSION_CLEANUP_UNVERIFIED = "session_cleanup_unverified";
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const normalizedToolCallId = (value: unknown) => typeof value === "string"
  && value.length > 0
  && value.trim() === value
  && !/[\u0000-\u001f]/.test(value)
  ? value
  : "";
const normalizedToolName = (value: unknown) => typeof value === "string" ? value : "";

type AuthorizationOutcome = "pending" | "allowed" | "denied";
type MutationEntry = "not-entered" | "entered";
type OperationStage = "authorization" | "effect" | "settled";

export type ScopedToolOperationEvidenceSnapshot = {
  toolCallId: string;
  toolName: string;
  attempt: number;
  eventStarted: boolean;
  eventEnded: boolean;
  operations: Array<{
    name: string;
    mutation: boolean;
    entered: boolean;
    mutationEntry: MutationEntry;
    completed: boolean;
    failed: boolean;
    authorization: AuthorizationOutcome;
    safeRelativePath: string | null;
    stage: OperationStage;
    allowlistedCause: string | null;
  }>;
  mutationEntered: boolean;
  operationFailed: boolean;
  preExecutionBashDenial: string | null;
  firstSafeCause: string | null;
  unsafe: boolean;
};

type ToolOperation = ScopedToolOperationEvidenceSnapshot["operations"][number];
type ToolCallOperationEvidence = ScopedToolOperationEvidenceSnapshot;
const scopedMutationToolNames = new Set(["write", "edit", "bash"]);
const recoverableBashDenials = new Set([
  "empty_command",
  "unclassifiable_mutation",
  "shell_composition",
  "destructive_command",
  "unrecognized_command",
]);
const recoverableAuthorizationDenials = new Set([
  "documentation_target_required",
  "ownership_scope_symlink_escape",
  "ownership_symlink_escape",
  "ownership_target_out_of_scope",
  "ownership_target_outside_project",
]);
const MAX_SAFE_CAUSE_LENGTH = 120;
export const isScopedMutationTool = (value: unknown) =>
  typeof value === "string" && scopedMutationToolNames.has(value);

const safeRelativeOperationPath = (value: unknown) => {
  const path = normalizeOwnershipTarget(value);
  return path && path.length <= 1_024 ? path : null;
};
const errorMessage = (error: unknown) => error instanceof Error
  ? error.message
  : typeof error === "string"
    ? error
    : "";
const allowlistedAuthorizationCause = (error: unknown) => {
  const cause = errorMessage(error);
  return recoverableAuthorizationDenials.has(cause) ? cause : null;
};

export type ScopedToolOperationEvidence = {
  runTool: <Value>(
    toolCallId: unknown,
    toolName: unknown,
    effect: () => Value | Promise<Value>,
  ) => Promise<Value>;
  runOperation: <Value>(input: {
    name: string;
    mutation: boolean;
    safeRelativePath?: string | null;
    authorize: () => void | Promise<void>;
    effect: () => Value | Promise<Value>;
  }) => Promise<Value>;
  observeToolStart: (input: {
    toolCallId: unknown;
    toolName: unknown;
  }) => void;
  denyBashBeforeExecution: (reason: unknown) => void;
  isUnsafeToolFailure: (input: {
    toolCallId: unknown;
    toolName: unknown;
    signalAborted: boolean;
    isError?: boolean;
  }) => boolean;
  hasPossibleMutation: () => boolean;
  hasUnsettledToolExecution: () => boolean;
  firstSafeCause: () => string | null;
  snapshot: () => ScopedToolOperationEvidenceSnapshot[];
};

// Native tool events establish the correlation boundary. Operation records then prove whether a
// denied call stopped before a mutation entered; any missing or ambiguous evidence stays unsafe.
export function createScopedToolOperationEvidence(input: {
  attempt: number;
  onUnsafe?: () => void;
}): ScopedToolOperationEvidence {
  const calls = new Map<string, ToolCallOperationEvidence>();
  const starts = new Map<string, number>();
  const storage = new AsyncLocalStorage<ToolCallOperationEvidence>();
  const attempt = Number.isSafeInteger(input.attempt) && input.attempt > 0 ? input.attempt : 0;
  let unattributedUnsafe = false;
  let firstSafeCause: string | null = null;
  const keyFor = (toolCallId: string, toolName: string) => `${toolCallId}\u0000${toolName}`;
  const latchUnattributedUnsafe = () => {
    if (unattributedUnsafe) return;
    unattributedUnsafe = true;
    try { input.onUnsafe?.(); } catch {}
  };
  const latchUnsafe = (call: ToolCallOperationEvidence) => {
    if (call.unsafe) return;
    call.unsafe = true;
    try { input.onUnsafe?.(); } catch {}
  };
  const rememberSafeCause = (call: ToolCallOperationEvidence, cause: string) => {
    const bounded = cause.slice(0, MAX_SAFE_CAUSE_LENGTH);
    if (!call.firstSafeCause) call.firstSafeCause = bounded;
    if (!firstSafeCause) firstSafeCause = bounded;
  };
  const currentCall = () => {
    const call = storage.getStore();
    if (!call) throw new Error("operation_evidence_unavailable");
    return call;
  };
  const completeEditRead = (call: ToolCallOperationEvidence) => {
    const operations = call.operations.filter(({ name }) => name !== "edit.authorization");
    const names = operations.map(({ name }) => name);
    const access = operations.find(({ name }) => name === "access");
    const readFile = operations.find(({ name }) => name === "readFile");
    return names.length === 2
      && names.every((name) => name === "access" || name === "readFile")
      && access?.completed === true
      && readFile?.completed === true;
  };
  const trustedPreEntryDenial = (call: ToolCallOperationEvidence) => {
    const failed = call.operations.filter(({ failed }) => failed);
    const denial = failed[0];
    return !call.unsafe
      && !call.mutationEntered
      && failed.length === 1
      && call.operations.every(({ mutationEntry }) => mutationEntry === "not-entered")
      && denial?.authorization === "denied"
      && denial.stage === "authorization"
      && denial.entered === false
      && Boolean(denial.allowlistedCause)
      && recoverableAuthorizationDenials.has(denial.allowlistedCause ?? "");
  };
  const verifiedToolSuccess = (call: ToolCallOperationEvidence) => {
    if (call.unsafe || call.operationFailed || !call.operations.length) return false;
    if (!call.operations.every(({ completed, failed }) => completed && !failed)) return false;
    if (call.toolName === "bash") return call.operations.some(({ name }) => name === "bash.exec");
    return call.operations.some(({ mutation, mutationEntry }) => mutation && mutationEntry === "entered");
  };

  return {
    async runTool(toolCallId, toolName, effect) {
      const id = normalizedToolCallId(toolCallId);
      const name = normalizedToolName(toolName);
      const key = keyFor(id, name);
      const existing = calls.get(key);
      if (existing) {
        latchUnsafe(existing);
        return storage.run(existing, effect);
      }
      const call: ToolCallOperationEvidence = {
        toolCallId: id,
        toolName: name,
        attempt,
        eventStarted: starts.get(key) === 1,
        eventEnded: false,
        operations: [],
        mutationEntered: false,
        operationFailed: false,
        preExecutionBashDenial: null,
        firstSafeCause: null,
        unsafe: false,
      };
      calls.set(key, call);
      if (!id || !isScopedMutationTool(name) || (starts.get(key) ?? 0) > 1) latchUnsafe(call);
      return storage.run(call, effect);
    },
    async runOperation({ name, mutation, safeRelativePath, authorize, effect }) {
      const call = currentCall();
      const operation: ToolOperation = {
        name,
        mutation,
        entered: false,
        mutationEntry: "not-entered",
        completed: false,
        failed: false,
        authorization: "pending",
        safeRelativePath: safeRelativeOperationPath(safeRelativePath),
        stage: "authorization",
        allowlistedCause: null,
      };
      call.operations.push(operation);
      try {
        await authorize();
        operation.authorization = "allowed";
        operation.stage = "effect";
        // Mark entry before waiting so a rejected or interrupted effect remains unsafe.
        operation.entered = true;
        if (mutation) {
          operation.mutationEntry = "entered";
          call.mutationEntered = true;
        }
        const result = await effect();
        operation.completed = true;
        operation.stage = "settled";
        return result;
      } catch (error) {
        operation.failed = true;
        call.operationFailed = true;
        if (operation.authorization === "pending") {
          operation.authorization = "denied";
          operation.stage = "authorization";
          operation.allowlistedCause = allowlistedAuthorizationCause(error);
          const recoverableWithoutTarget = operation.allowlistedCause === "ownership_target_outside_project";
          if (operation.allowlistedCause && (operation.safeRelativePath || recoverableWithoutTarget)) {
            rememberSafeCause(call, operation.allowlistedCause);
          } else {
            latchUnsafe(call);
          }
        } else {
          latchUnsafe(call);
        }
        throw error;
      }
    },
    observeToolStart({ toolCallId, toolName }) {
      const id = normalizedToolCallId(toolCallId);
      const name = normalizedToolName(toolName);
      const key = keyFor(id, name);
      if (!id || !isScopedMutationTool(name)) {
        latchUnattributedUnsafe();
        return;
      }
      const count = (starts.get(key) ?? 0) + 1;
      starts.set(key, count);
      const call = calls.get(key);
      if (count > 1) {
        if (call) latchUnsafe(call);
        else latchUnattributedUnsafe();
        return;
      }
      if (call) call.eventStarted = true;
    },
    denyBashBeforeExecution(reason) {
      const call = currentCall();
      const denial = typeof reason === "string" ? reason : "";
      call.preExecutionBashDenial = denial || null;
      if (recoverableBashDenials.has(denial)) rememberSafeCause(call, denial);
      else latchUnsafe(call);
    },
    isUnsafeToolFailure({ toolCallId, toolName, signalAborted, isError = true }) {
      const id = normalizedToolCallId(toolCallId);
      const name = normalizedToolName(toolName);
      const call = calls.get(keyFor(id, name));
      if (!call || call.toolName !== name || signalAborted || !call.eventStarted || call.eventEnded) return true;
      call.eventEnded = true;
      if (!isError) return !verifiedToolSuccess(call);
      if (call.unsafe || call.mutationEntered) return true;
      if (name === "edit" && !call.operationFailed) return !completeEditRead(call);
      if (name === "bash" && call.preExecutionBashDenial) {
        return !recoverableBashDenials.has(call.preExecutionBashDenial);
      }
      return !trustedPreEntryDenial(call);
    },
    hasPossibleMutation: () => [...calls.values()].some(({ mutationEntered }) => mutationEntered),
    hasUnsettledToolExecution: () => unattributedUnsafe
      || [...starts.keys()].some((key) => !calls.get(key)?.eventEnded)
      || [...calls.values()].some((call) => !call.eventStarted || !call.eventEnded),
    firstSafeCause: () => firstSafeCause,
    snapshot: () => [...calls.values()].map((call) => ({
      ...call,
      operations: call.operations.map((operation) => ({ ...operation })),
    })),
  };
}

const immutablePersistedWriteScope = (value: unknown, agent: AgentDefinition) => {
  if (!Array.isArray(value)) return null;
  const scope = value.map((entry) => normalizeOwnershipTarget(entry));
  if (scope.some((entry, index) => !entry || entry !== value[index])) return null;
  if (agent.authority === "document-write" && scope.some((entry) => !isDocumentationTarget(entry))) return null;
  return Object.freeze([...scope]) as unknown as string[];
};

const samePath = (left: unknown, right: unknown) => {
  const first = text(left);
  const second = text(right);
  return Boolean(first && second && resolve(first) === resolve(second));
};
const managerMatchesRecord = (manager: any, record: SessionRecord, cwd: string) => {
  const header = manager?.getHeader?.();
  const headerMatches = typeof manager?.getHeader !== "function"
    || (Boolean(header)
      && text(header.id) === record.sessionId
      && samePath(header.cwd, cwd));
  return headerMatches
    && text(manager?.getSessionId?.()) === record.sessionId
    && samePath(manager?.getSessionFile?.(), record.sessionFile)
    && samePath(manager?.getCwd?.(), cwd);
};
const observedIdentity = (session: any) => ({
  provider: session.model?.provider,
  model: session.model?.id,
  thinking: session.thinkingLevel,
  sessionId: session.sessionId,
  sessionFile: session.sessionFile ?? "",
});
const observedIdentityMatchesRecord = (observed: ReturnType<typeof observedIdentity>, record: SessionRecord) =>
  observed.provider === record.provider
  && observed.model === record.model
  && observed.thinking === record.thinking
  && observed.sessionId === record.sessionId
  && samePath(observed.sessionFile, record.sessionFile);

const settleAndDispose = async (session: any, settled: boolean, unsubscribe: () => void) => {
  if (!session) return true;
  const cleanupStep = async (effect: () => unknown) => {
    try {
      await effect();
      return true;
    } catch {
      return false;
    }
  };
  const aborted = settled || await cleanupStep(() => {
    if (typeof session.abort !== "function") throw new Error(SESSION_CLEANUP_UNVERIFIED);
    return session.abort();
  });
  const idle = settled || await cleanupStep(() => {
    if (typeof session.waitForIdle !== "function") throw new Error(SESSION_CLEANUP_UNVERIFIED);
    return session.waitForIdle();
  });
  const unsubscribed = await cleanupStep(() => unsubscribe());
  const disposed = await cleanupStep(() => {
    if (typeof session.dispose !== "function") throw new Error(SESSION_CLEANUP_UNVERIFIED);
    return session.dispose();
  });
  return aborted && idle && unsubscribed && disposed;
};

export async function runFocusedAgentContinuation(input: FocusedContinuationInput) {
  const persistedRecord = structuredClone(input.record);
  const writeScope = immutablePersistedWriteScope(persistedRecord.writeScope, input.agent);
  if (!writeScope) {
    return createDelegationResult({ id: persistedRecord.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
  }
  const record = { ...persistedRecord, writeScope };
  const cwd = resolve(input.cwd);
  const purpose = input.agent.authority === "review-read"
    ? "finding-follow-up"
    : input.agent.authority === "vision-read"
      ? "vision-follow-up"
      : "implementation-follow-up";
  if (record.contractFingerprint !== agentContractFingerprint(input.agent, record.writeScope)) {
    return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "agent_contract_drift", session: null });
  }
  const fileExists = input.dependencies.fileExists ?? existsSync;
  if (!canResumeSession({ record, agent: input.agent, purpose, sessionFileExists: fileExists(record.sessionFile) })) {
    return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
  }
  const model = input.runtime.getModel(record.provider, record.model);
  if (!model) return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "model_unavailable", session: null });
  if (input.signal?.aborted) {
    return createDelegationResult({ id: record.reference, status: "failed", attempts: 0, error: "cancelled", failure: "unsafe-partial-state", session: null });
  }

  // The lease is acquired before SessionManager.open and survives durable persistence and disposal.
  const acquireSessionLock = input.dependencies.acquireSessionLock ?? acquireNativeSessionLock;
  let lease: NativeFileLease | null;
  try {
    lease = await acquireSessionLock(record.sessionFile);
  } catch {
    return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
  }
  if (!lease) {
    return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "session_follow_up_busy", session: null });
  }

  let releaseLease = true;
  try {
    if (input.signal?.aborted) {
      return createDelegationResult({ id: record.reference, status: "failed", attempts: 0, error: "cancelled", failure: "unsafe-partial-state", session: null });
    }
    const validatedRecord = { ...record, sessionFile: lease.target };
    const createSession = input.dependencies.createSession ?? createAgentSession;
    const openManager = input.dependencies.openManager ?? ((path: string) => SessionManager.open(path));
    let sessionManager: unknown;
    try {
      sessionManager = openManager(lease.target);
    } catch {
      return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
    }
    if (!managerMatchesRecord(sessionManager, validatedRecord, cwd)) {
      return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
    }
    const clock = input.dependencies.clock ?? now;
    let unsafe = false;
    let invalidation: Promise<boolean> | undefined;
    const invalidateUnsafeRecord = () => {
      invalidation ??= (async () => {
        const failed = { ...record, status: "failed" as const, updatedAt: clock() };
        let persisted = typeof input.onSessionRecord === "function";
        try {
          await input.onSessionRecord?.(failed);
        } catch {
          persisted = false;
        }
        try {
          input.sessionStore.set(failed.reference, failed);
        } catch {
          persisted = false;
        }
        return persisted;
      })();
      return invalidation;
    };
    const unsafeResult = async (attempts: number) => {
      if (!await invalidateUnsafeRecord()) releaseLease = false;
      return createDelegationResult({
        id: record.reference,
        status: "failed",
        attempts,
        error: "unsafe-partial-state",
        failure: "unsafe-partial-state",
        session: null,
      });
    };
    let firstSafeCause: string | null = null;
    // Persisted continuation records never carry parent-minted verification snapshots.
    const continuationAgent = {
      ...input.agent,
      tools: deriveToolAuthority(input.agent).filter((tool) => tool !== "test"),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let session: any;
      let unsubscribe = () => undefined;
      let cancelled = input.signal?.aborted === true;
      let childSettled = false;
      let durableUpdateStarted = false;
      const abortRequests: Promise<boolean>[] = [];
      const requestAbort = () => {
        if (!session) return;
        try {
          abortRequests.push(Promise.resolve(session.abort?.()).then(
            () => true,
            () => false,
          ));
        } catch {
          abortRequests.push(Promise.resolve(false));
        }
      };
      const latchUnsafe = () => {
        unsafe = true;
        requestAbort();
      };
      const operationEvidence = createScopedToolOperationEvidence({
        attempt: attempt + 1,
        onUnsafe: latchUnsafe,
      });
      const rememberSafeCause = () => {
        const cause = operationEvidence.firstSafeCause();
        if (!firstSafeCause && cause) firstSafeCause = cause;
        return firstSafeCause;
      };
      const onAbort = () => {
        cancelled = true;
        requestAbort();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const created = await createSession({
          cwd,
          modelRuntime: input.runtime,
          model,
          thinkingLevel: record.thinking as any,
          tools: deriveToolAuthority(continuationAgent).map((tool) => input.dependencies.toolNames[tool]).filter(Boolean),
          customTools: input.dependencies.scopedTools({
            cwd,
            assignment: {
              id: record.reference,
              agent: input.agent.name,
              goal: input.brief,
              context: "Focused continuation",
              paths: [],
              constraints: [],
              nonGoals: [],
              expectedOutput: input.agent.result.requiredSections.join(", "),
              writeScope: record.writeScope,
            },
            agent: continuationAgent,
            operationEvidence,
          }),
          sessionManager: sessionManager as any,
        });
        session = created.session;
        const observedBeforePrompt = observedIdentity(session);
        if (!observedIdentityMatchesRecord(observedBeforePrompt, validatedRecord)) {
          return createDelegationResult({ id: record.reference, status: "refused", attempts: attempt + 1, error: "session_not_reusable", session: null });
        }
        unsubscribe = session.subscribe?.((event: unknown) => {
          try {
            const toolEvent = event as {
              type?: unknown;
              toolCallId?: unknown;
              toolName?: unknown;
              isError?: unknown;
            };
            if (toolEvent?.type === "tool_execution_start" && isScopedMutationTool(toolEvent.toolName)) {
              operationEvidence.observeToolStart({
                toolCallId: toolEvent.toolCallId,
                toolName: toolEvent.toolName,
              });
            }
            if (input.dependencies.mutationAttemptUnsafe(
              event,
              { writeScope: record.writeScope } as DelegationAssignment,
              cwd,
            )) latchUnsafe();
            if (toolEvent?.type === "tool_execution_end"
              && isScopedMutationTool(toolEvent.toolName)
              && operationEvidence.isUnsafeToolFailure({
                toolCallId: toolEvent.toolCallId,
                toolName: toolEvent.toolName,
                signalAborted: cancelled || input.signal?.aborted === true,
                isError: toolEvent.isError === true,
              })) latchUnsafe();
          } catch {
            latchUnsafe();
          }
        }) ?? unsubscribe;
        if (unsafe) return await unsafeResult(attempt + 1);
        if (cancelled) {
          return createDelegationResult({ id: record.reference, status: "failed", attempts: attempt + 1, error: "cancelled", failure: "unsafe-partial-state", session: null });
        }
        const prompt = composeDelegatedBashPrompt(
          input.brief,
          deriveToolAuthority(input.agent),
        );
        await session.prompt(prompt, { expandPromptTemplates: false });
        await session.waitForIdle();
        childSettled = true;
        if (operationEvidence.hasUnsettledToolExecution()) latchUnsafe();
        rememberSafeCause();
        if (cancelled && operationEvidence.hasPossibleMutation()) latchUnsafe();
        if (unsafe) return await unsafeResult(attempt + 1);
        if (cancelled) {
          return createDelegationResult({ id: record.reference, status: "failed", attempts: attempt + 1, error: "cancelled", failure: "unsafe-partial-state", session: null });
        }
        const final = input.dependencies.finalAssistant(session);
        const report = final?.report ?? "";
        const observed = observedIdentity(session);
        const completion = validateDelegationCompletion({
          final,
          text: report,
          requiredSections: input.agent.result.requiredSections,
          expected: {
            provider: record.provider,
            model: record.model,
            thinking: record.thinking,
            sessionId: record.sessionId,
            sessionFile: validatedRecord.sessionFile,
          },
          observed,
        });
        if (!completion.ok) {
          if (operationEvidence.hasPossibleMutation()) latchUnsafe();
          if (unsafe) return await unsafeResult(attempt + 1);
          const safeCause = rememberSafeCause();
          const failure = final?.errorMessage ? classifyChildFailure(final.errorMessage) : "agent-contract";
          if (attempt === 0 && decideRecovery({ failure, retries: 0 }).retry) continue;
          const detail = safeCause ?? (final?.errorMessage
            ? sanitizeDelegationError(final.errorMessage)
            : completion.failures.join(","));
          const unverifiedReport = report.trim();
          return createDelegationResult({
            id: record.reference,
            status: "failed",
            attempts: attempt + 1,
            error: detail,
            failure,
            completion: completion.failures,
            report: unverifiedReport ? report : undefined,
            unverifiedReason: unverifiedReport ? detail : undefined,
            session: unverifiedReport ? { id: observed.sessionId, file: observed.sessionFile, resumeReference: null } : null,
          });
        }
        if (unsafe) return await unsafeResult(attempt + 1);
        const updated = { ...record, status: "succeeded" as const, updatedAt: clock() };
        durableUpdateStarted = true;
        await input.onSessionRecord?.(updated);
        input.sessionStore.set(updated.reference, updated);
        return createDelegationResult({
          id: record.reference,
          status: "succeeded",
          attempts: attempt + 1,
          provider: observed.provider,
          model: observed.model,
          thinking: observed.thinking,
          report,
          session: { id: observed.sessionId, file: observed.sessionFile, resumeReference: record.reference },
        });
      } catch (error) {
        if (!unsafe && (operationEvidence.hasUnsettledToolExecution() || operationEvidence.hasPossibleMutation())) latchUnsafe();
        if (unsafe) return await unsafeResult(attempt + 1);
        const safeCause = rememberSafeCause();
        const failure = classifyChildFailure(error);
        if (!durableUpdateStarted && attempt === 0 && decideRecovery({ failure, retries: 0 }).retry) continue;
        return createDelegationResult({
          id: record.reference,
          status: "failed",
          attempts: attempt + 1,
          error: safeCause ?? sanitizeDelegationError(error),
          failure,
          session: null,
        });
      } finally {
        let signalDetached = true;
        try { input.signal?.removeEventListener("abort", onAbort); } catch { signalDetached = false; }
        let abortRequestsVerified = false;
        try { abortRequestsVerified = (await Promise.all(abortRequests)).every(Boolean); } catch {}
        let sessionCleanupVerified = false;
        try { sessionCleanupVerified = await settleAndDispose(session, childSettled, unsubscribe); } catch {}
        if (!signalDetached || !abortRequestsVerified || !sessionCleanupVerified) {
          releaseLease = false;
          if (!unsafe) {
            return createDelegationResult({
              id: record.reference,
              status: "failed",
              attempts: attempt + 1,
              error: SESSION_CLEANUP_UNVERIFIED,
              failure: "unsafe-partial-state",
              session: null,
            });
          }
        }
      }
    }
    return createDelegationResult({ id: record.reference, status: "failed", attempts: 2, error: "terminal", failure: "terminal", session: null });
  } finally {
    if (releaseLease) await lease.release();
  }
}
