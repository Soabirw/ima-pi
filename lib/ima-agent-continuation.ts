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

export type FocusedContinuationDependencies = {
  createSession?: typeof createAgentSession;
  openManager?: (path: string) => unknown;
  scopedTools: (input: { cwd: string; assignment: DelegationAssignment; agent: AgentDefinition }) => unknown[];
  toolNames: Record<string, string>;
  finalAssistant: (session: unknown) => {
    stopReason?: unknown;
    isError?: boolean;
    hasPendingToolUse?: boolean;
    errorMessage?: unknown;
    report?: string;
  } | undefined;
  mutationAttemptUnsafe: (event: unknown, assignment: DelegationAssignment) => boolean;
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
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const samePath = (left: unknown, right: unknown) => {
  const first = text(left);
  const second = text(right);
  return Boolean(first && second && resolve(first) === resolve(second));
};
const managerMatchesRecord = (manager: any, record: SessionRecord, cwd: string) =>
  text(manager?.getSessionId?.()) === record.sessionId
  && samePath(manager?.getSessionFile?.(), record.sessionFile)
  && samePath(manager?.getCwd?.(), cwd);
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

export async function runFocusedAgentContinuation(input: FocusedContinuationInput) {
  const purpose = input.agent.authority === "review-read"
    ? "finding-follow-up"
    : input.agent.authority === "vision-read"
      ? "vision-follow-up"
      : "implementation-follow-up";
  const fileExists = input.dependencies.fileExists ?? existsSync;
  if (!canResumeSession({ record: input.record, agent: input.agent, purpose, sessionFileExists: fileExists(input.record.sessionFile) })) {
    return createDelegationResult({ id: input.record.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
  }
  if (input.record.contractFingerprint !== agentContractFingerprint(input.agent, input.record.writeScope)) {
    return createDelegationResult({ id: input.record.reference, status: "refused", attempts: 0, error: "agent_contract_drift", session: null });
  }
  const model = input.runtime.getModel(input.record.provider, input.record.model);
  if (!model) return createDelegationResult({ id: input.record.reference, status: "refused", attempts: 0, error: "model_unavailable", session: null });
  if (input.signal?.aborted) {
    return createDelegationResult({ id: input.record.reference, status: "failed", attempts: 0, error: "cancelled", failure: "unsafe-partial-state", session: null });
  }

  const createSession = input.dependencies.createSession ?? createAgentSession;
  const openManager = input.dependencies.openManager ?? ((path: string) => SessionManager.open(path));
  let sessionManager: unknown;
  try {
    sessionManager = openManager(input.record.sessionFile);
  } catch {
    return createDelegationResult({ id: input.record.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
  }
  if (!managerMatchesRecord(sessionManager, input.record, input.cwd)) {
    return createDelegationResult({ id: input.record.reference, status: "refused", attempts: 0, error: "session_not_reusable", session: null });
  }
  const clock = input.dependencies.clock ?? now;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let session: any;
    let unsubscribe = () => undefined;
    let cancelled = input.signal?.aborted === true;
    const onAbort = () => {
      cancelled = true;
      void session?.abort?.();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const created = await createSession({
        cwd: input.cwd,
        modelRuntime: input.runtime,
        model,
        thinkingLevel: input.record.thinking as any,
        tools: deriveToolAuthority(input.agent).map((tool) => input.dependencies.toolNames[tool]).filter(Boolean),
        customTools: input.dependencies.scopedTools({
          cwd: input.cwd,
          assignment: {
            id: input.record.reference,
            agent: input.agent.name,
            goal: input.brief,
            context: "Focused continuation",
            paths: [],
            constraints: [],
            nonGoals: [],
            expectedOutput: input.agent.result.requiredSections.join(", "),
            writeScope: input.record.writeScope,
          },
          agent: input.agent,
        }),
        sessionManager: sessionManager as any,
      });
      session = created.session;
      const observedBeforePrompt = observedIdentity(session);
      if (!observedIdentityMatchesRecord(observedBeforePrompt, input.record)) {
        return createDelegationResult({ id: input.record.reference, status: "refused", attempts: attempt + 1, error: "session_not_reusable", session: null });
      }
      let unsafe = false;
      unsubscribe = session.subscribe?.((event: unknown) => {
        if (input.dependencies.mutationAttemptUnsafe(event, { writeScope: input.record.writeScope } as DelegationAssignment)) {
          unsafe = true;
          void session.abort?.();
        }
      }) ?? unsubscribe;
      if (cancelled) {
        return createDelegationResult({ id: input.record.reference, status: "failed", attempts: attempt + 1, error: "cancelled", failure: "unsafe-partial-state", session: null });
      }
      await session.prompt(input.brief, { expandPromptTemplates: false });
      await session.waitForIdle();
      if (cancelled) {
        return createDelegationResult({ id: input.record.reference, status: "failed", attempts: attempt + 1, error: "cancelled", failure: "unsafe-partial-state", session: null });
      }
      if (unsafe) {
        return createDelegationResult({ id: input.record.reference, status: "failed", attempts: attempt + 1, error: "unsafe-partial-state", failure: "unsafe-partial-state", session: null });
      }
      const final = input.dependencies.finalAssistant(session);
      const report = final?.report ?? "";
      const observed = observedIdentity(session);
      const completion = validateDelegationCompletion({
        final,
        text: report,
        requiredSections: input.agent.result.requiredSections,
        expected: {
          provider: input.record.provider,
          model: input.record.model,
          thinking: input.record.thinking,
          sessionId: input.record.sessionId,
          sessionFile: input.record.sessionFile,
        },
        observed,
      });
      if (!completion.ok) {
        const failure = final?.errorMessage ? classifyChildFailure(final.errorMessage) : "agent-contract";
        if (attempt === 0 && decideRecovery({ failure, retries: 0 }).retry) continue;
        const detail = final?.errorMessage ? sanitizeDelegationError(final.errorMessage) : completion.failures.join(",");
        const unverifiedReport = report.trim();
        return createDelegationResult({
          id: input.record.reference,
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
      const updated = { ...input.record, status: "succeeded" as const, updatedAt: clock() };
      await input.onSessionRecord?.(updated);
      input.sessionStore.set(updated.reference, updated);
      return createDelegationResult({
        id: input.record.reference,
        status: "succeeded",
        attempts: attempt + 1,
        provider: observed.provider,
        model: observed.model,
        thinking: observed.thinking,
        report,
        session: { id: observed.sessionId, file: observed.sessionFile, resumeReference: input.record.reference },
      });
    } catch (error) {
      const failure = classifyChildFailure(error);
      if (attempt === 0 && decideRecovery({ failure, retries: 0 }).retry) continue;
      return createDelegationResult({
        id: input.record.reference,
        status: "failed",
        attempts: attempt + 1,
        error: sanitizeDelegationError(error),
        failure,
        session: null,
      });
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      session?.dispose?.();
    }
  }
  return createDelegationResult({ id: input.record.reference, status: "failed", attempts: 2, error: "terminal", failure: "terminal", session: null });
}
