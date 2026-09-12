import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./ima-agents.ts";
import {
  agentContractFingerprint,
  canResumeSession,
  classifyChildFailure,
  createDelegationResult,
  decideRecovery,
  deriveToolAuthority,
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
  scopedTools: (input: { cwd: string; assignment: DelegationAssignment; agent: AgentDefinition }) => unknown[];
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
  const record = structuredClone(input.record);
  const cwd = resolve(input.cwd);
  const purpose = input.agent.authority === "review-read"
    ? "finding-follow-up"
    : input.agent.authority === "vision-read"
      ? "vision-follow-up"
      : "implementation-follow-up";
  const fileExists = input.dependencies.fileExists ?? existsSync;
  if (!canResumeSession({ record, agent: input.agent, purpose, sessionFileExists: fileExists(record.sessionFile) })) {
    return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
  }
  if (record.contractFingerprint !== agentContractFingerprint(input.agent, record.writeScope)) {
    return createDelegationResult({ id: record.reference, status: "refused", attempts: 0, error: "agent_contract_drift", session: null });
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
          tools: deriveToolAuthority(input.agent).map((tool) => input.dependencies.toolNames[tool]).filter(Boolean),
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
            agent: input.agent,
          }),
          sessionManager: sessionManager as any,
        });
        session = created.session;
        const observedBeforePrompt = observedIdentity(session);
        if (!observedIdentityMatchesRecord(observedBeforePrompt, validatedRecord)) {
          return createDelegationResult({ id: record.reference, status: "refused", attempts: attempt + 1, error: "session_not_reusable", session: null });
        }
        let unsafe = false;
        unsubscribe = session.subscribe?.((event: unknown) => {
          if (input.dependencies.mutationAttemptUnsafe(
            event,
            { writeScope: record.writeScope } as DelegationAssignment,
            cwd,
          )) {
            unsafe = true;
            requestAbort();
          }
        }) ?? unsubscribe;
        if (cancelled) {
          return createDelegationResult({ id: record.reference, status: "failed", attempts: attempt + 1, error: "cancelled", failure: "unsafe-partial-state", session: null });
        }
        await session.prompt(input.brief, { expandPromptTemplates: false });
        await session.waitForIdle();
        childSettled = true;
        if (cancelled) {
          return createDelegationResult({ id: record.reference, status: "failed", attempts: attempt + 1, error: "cancelled", failure: "unsafe-partial-state", session: null });
        }
        if (unsafe) {
          return createDelegationResult({ id: record.reference, status: "failed", attempts: attempt + 1, error: "unsafe-partial-state", failure: "unsafe-partial-state", session: null });
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
          const failure = final?.errorMessage ? classifyChildFailure(final.errorMessage) : "agent-contract";
          if (attempt === 0 && decideRecovery({ failure, retries: 0 }).retry) continue;
          const detail = final?.errorMessage ? sanitizeDelegationError(final.errorMessage) : completion.failures.join(",");
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
        const failure = classifyChildFailure(error);
        if (!durableUpdateStarted && attempt === 0 && decideRecovery({ failure, retries: 0 }).retry) continue;
        return createDelegationResult({
          id: record.reference,
          status: "failed",
          attempts: attempt + 1,
          error: sanitizeDelegationError(error),
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
    return createDelegationResult({ id: record.reference, status: "failed", attempts: 2, error: "terminal", failure: "terminal", session: null });
  } finally {
    if (releaseLease) await lease.release();
  }
}
