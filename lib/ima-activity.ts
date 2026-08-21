import type { AgentDefinition } from "./ima-agents.ts";
import type { DelegationFailure, DelegationRequest, DelegationResult } from "./ima-delegation.ts";

export type DelegationActivityChildState = "pending" | "starting" | "running" | "retrying" | "succeeded" | "blocked" | "failed" | "cancelling" | "cancelled";
export type DelegationActivityStateName = "starting" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";

export type DelegationActivityChild = {
  assignmentId: string;
  phase: AgentDefinition["result"]["kind"];
  agent: string;
  tier: AgentDefinition["tier"];
  authority: AgentDefinition["authority"];
  route: { provider: string; model: string; thinking?: string } | null;
  declaredSkills: string[];
  declaredTools: string[];
  state: DelegationActivityChildState;
  activity: string | null;
  attempt: number;
  maximumAttempts: 2;
  retryReason: DelegationFailure | null;
  blocker: string | null;
  escalation: string | null;
  startedAt: number | null;
  updatedAt: number;
  settledAt: number | null;
  possiblePartialWriteScopes: string[];
};

export type DelegationActivityState = {
  schemaVersion: 1;
  runId: string;
  title: string;
  phase: "delegation";
  state: DelegationActivityStateName;
  startedAt: number;
  updatedAt: number;
  cancellationRequested: boolean;
  children: DelegationActivityChild[];
};

export type DelegationActivityEvent =
  | { type: "route-resolved"; id: string; at: number; route: { provider: string; model: string; thinking?: string } }
  | { type: "child-started" | "child-running"; id: string; at: number; attempt: number }
  | { type: "child-activity"; id: string; at: number; category: string }
  | { type: "child-settled"; id: string; at: number }
  | { type: "retrying"; id: string; at: number; attempt: 2; reason: DelegationFailure }
  | { type: "safety-intercepted"; id: string; at: number; blocker: string; possiblePartialWriteScopes?: string[] }
  | { type: "cancel-requested"; id: string; at: number; possiblePartialWriteScopes?: string[] }
  | { type: "succeeded"; id: string; at: number }
  | { type: "blocked" | "failed" | "cancelled"; id: string; at: number; blocker: string; escalation?: string | null; possiblePartialWriteScopes?: string[] }
  | { type: "run-settled"; at: number; state: "succeeded" | "failed" | "cancelled" };

export type DelegationOutcomeReport = {
  schemaVersion: 1;
  phase: "delegation";
  state: "succeeded" | "failed" | "cancelled";
  elapsedMs: number;
  children: Array<{
    assignmentId: string;
    state: DelegationActivityChildState;
    attempts: number;
    blocker: string | null;
    retryHistory: DelegationFailure[];
    escalation: string | null;
    resumeReference: string | null;
  }>;
  completedAssignmentIds: string[];
  blocker: string | null;
  retryHistory: Array<{ assignmentId: string; reason: DelegationFailure }>;
  escalation: string | null;
  partialState: {
    possible: boolean;
    possibleWriteScopes: string[];
    unsafeAssignmentIds: string[];
  };
  reusableSessionReferences: string[];
  safeNextAction: { code: string; text: string; inspectScopes: string[] };
  projectionDegraded: boolean;
};

const terminal = new Set<DelegationActivityChildState>(["succeeded", "blocked", "failed", "cancelled"]);
const unique = (values: string[]) => [...new Set(values)];
const bound = (value: unknown, length = 48) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, length);
const childPhase = (state: DelegationActivityState): DelegationActivityStateName => {
  if (state.cancellationRequested && state.children.some((child) => !terminal.has(child.state))) return "cancelling";
  if (state.children.every((child) => terminal.has(child.state))) {
    if (state.children.every((child) => child.state === "succeeded")) return "succeeded";
    if (state.children.some((child) => child.state === "failed" || child.state === "blocked")) return "failed";
    return "cancelled";
  }
  if (state.children.some((child) => ["starting", "running", "retrying", "cancelling"].includes(child.state))) return "running";
  return "starting";
};

export function createDelegationActivityState(input: { runId: string; request: DelegationRequest; agents: AgentDefinition[]; at: number }): DelegationActivityState {
  const agents = new Map(input.agents.map((agent) => [agent.name, agent]));
  return {
    schemaVersion: 1,
    runId: bound(input.runId, 80) || "delegation",
    title: bound(input.request.title, 120) || "delegation",
    phase: "delegation",
    state: "starting",
    startedAt: input.at,
    updatedAt: input.at,
    cancellationRequested: false,
    children: input.request.assignments.map((assignment) => {
      const agent = agents.get(assignment.agent);
      if (!agent) throw new Error(`delegation_agent_unknown:${bound(assignment.agent)}`);
      return {
        assignmentId: assignment.id,
        phase: agent.result.kind,
        agent: agent.name,
        tier: agent.tier,
        authority: agent.authority,
        route: null,
        declaredSkills: unique(agent.skills.map((skill) => bound(skill, 60)).filter(Boolean)),
        declaredTools: unique(agent.tools.map((tool) => bound(tool, 30)).filter(Boolean)),
        state: "pending",
        activity: null,
        attempt: 0,
        maximumAttempts: 2,
        retryReason: null,
        blocker: null,
        escalation: null,
        startedAt: null,
        updatedAt: input.at,
        settledAt: null,
        possiblePartialWriteScopes: [],
      };
    }),
  };
}

export function reduceDelegationActivity(state: DelegationActivityState, event: DelegationActivityEvent): DelegationActivityState {
  if (event.type === "run-settled") return { ...state, state: event.state, updatedAt: event.at };
  const current = state.children.find((child) => child.assignmentId === event.id);
  if (!current) return state;
  if (event.type === "child-settled") {
    if (current.settledAt !== null) return state;
    return { ...state, updatedAt: event.at, children: state.children.map((child) => child === current ? { ...child, updatedAt: event.at, settledAt: event.at } : child) };
  }
  if (terminal.has(current.state)) return state;
  const scopes = "possiblePartialWriteScopes" in event ? unique(event.possiblePartialWriteScopes ?? []) : current.possiblePartialWriteScopes;
  let nextChild: DelegationActivityChild;
  if (event.type === "route-resolved") nextChild = { ...current, route: { ...event.route }, updatedAt: event.at };
  else if (event.type === "child-started") nextChild = { ...current, state: "starting", attempt: event.attempt, startedAt: current.startedAt ?? event.at, updatedAt: event.at, activity: null };
  else if (event.type === "child-running") nextChild = { ...current, state: "running", attempt: event.attempt, startedAt: current.startedAt ?? event.at, updatedAt: event.at };
  else if (event.type === "child-activity") nextChild = { ...current, state: current.state === "starting" ? "running" : current.state, activity: bound(event.category, 80) || "tool:other", updatedAt: event.at };
  else if (event.type === "retrying") nextChild = { ...current, state: "retrying", attempt: event.attempt, retryReason: event.reason, activity: null, updatedAt: event.at };
  else if (event.type === "cancel-requested") nextChild = { ...current, state: "cancelling", possiblePartialWriteScopes: scopes, updatedAt: event.at };
  else if (event.type === "succeeded") nextChild = { ...current, state: "succeeded", activity: null, updatedAt: event.at, settledAt: event.at };
  else if (event.type === "safety-intercepted") nextChild = { ...current, state: "blocked", activity: "safety:intercepted", blocker: bound(event.blocker, 160), possiblePartialWriteScopes: scopes, updatedAt: event.at, settledAt: event.at };
  else nextChild = { ...current, state: event.type, blocker: bound(event.blocker, 160), escalation: bound(event.escalation, 160) || null, possiblePartialWriteScopes: scopes, activity: null, updatedAt: event.at, settledAt: event.at };
  const children = state.children.map((child) => child === current ? nextChild : child);
  const next = { ...state, children, updatedAt: event.at, cancellationRequested: state.cancellationRequested || event.type === "cancel-requested" };
  return { ...next, state: childPhase(next) };
}

export function classifyDelegationActivity(toolName: unknown, args: unknown): string {
  const name = typeof toolName === "string" ? toolName : "";
  if (name === "mcp") {
    const server = args && typeof args === "object"
      ? (args as { server?: unknown }).server
      : undefined;
    if (typeof server !== "string") return "gateway:other";
    return ["serena", "vestige", "qdrant-memory"].includes(server)
      ? `gateway:${server}`
      : "gateway:other";
  }
  return ["read", "grep", "find", "ls", "write", "edit", "bash", "test", "image"].includes(name) ? `tool:${name}` : "tool:other";
}

export function renderDelegationActivity(state: DelegationActivityState, at: number): string[] {
  const elapsed = Math.max(0, at - state.startedAt);
  const lines = [`[${bound(state.title, 40)} | ${bound(state.runId, 12)}] ${state.state} ${Math.floor(elapsed / 1000)}s`];
  for (const child of state.children) {
    const route = child.route ? `${bound(child.route.provider, 24)}/${bound(child.route.model, 36)}${child.route.thinking ? `:${bound(child.route.thinking, 12)}` : ""}` : "model:pending";
    const skills = child.declaredSkills.length ? child.declaredSkills.map((skill) => bound(skill, 24)).join(",") : "none";
    const retry = child.attempt ? ` ${child.attempt}/${child.maximumAttempts}${child.retryReason ? ` retry:${child.retryReason}` : ""}` : "";
    const escalation = child.escalation ? " escalate" : "";
    lines.push(bound(`${bound(child.assignmentId, 18)} ${child.phase} ${bound(child.agent, 24)} ${route} declared-skills:${skills} ${child.state}${child.activity ? ` ${child.activity}` : ""}${retry}${escalation} ${Math.floor(Math.max(0, at - (child.startedAt ?? state.startedAt)) / 1000)}s`, 320));
  }
  return lines.slice(0, 5);
}

type CoordinatorResult = DelegationResult;
const actionFor = (input: { state: DelegationOutcomeReport["state"]; failures: DelegationFailure[]; possibleScopes: string[] }) => {
  if (input.state === "cancelled") return { code: "inspect-partial-state", text: "Inspect git status and diffs limited to the reported write scopes before rerunning; cancellation does not roll back effects.", inspectScopes: input.possibleScopes };
  if (input.failures.includes("unsafe-partial-state")) return { code: "correct-safety-boundary", text: "Stop, inspect the reported scopes, and correct assignment ownership or the requested operation before rerunning.", inspectScopes: input.possibleScopes };
  if (input.possibleScopes.length) return { code: "inspect-partial-state", text: "Inspect git status and diffs limited to the reported write scopes before rerunning; possible partial effects are not rolled back.", inspectScopes: input.possibleScopes };
  if (input.failures.some((failure) => failure === "model-unavailable" || failure === "auth-or-quota")) return { code: "restore-exact-model", text: "Restore or configure the required exact role model, then rerun without silent substitution.", inspectScopes: [] };
  if (input.failures.includes("transient-provider")) return { code: "retry-after-provider-recovery", text: "Retry later after provider recovery.", inspectScopes: [] };
  if (input.failures.includes("agent-contract")) return { code: "correct-agent-contract", text: "Correct the brief or agent result contract using the reported contract evidence.", inspectScopes: [] };
  if (input.failures.some((failure) => failure === "critical-decision" || failure === "plan-contradiction")) return { code: "obtain-human-decision", text: "Obtain a human decision; do not retry automatically.", inspectScopes: [] };
  if (input.state === "succeeded") return { code: "continue-parent-synthesis", text: "Continue parent synthesis using successful reusable session references.", inspectScopes: [] };
  return { code: "inspect-blocker", text: "Inspect the structured blocker before rerunning.", inspectScopes: [] };
};

export function buildDelegationOutcomeReport(input: {
  activity: DelegationActivityState;
  results: CoordinatorResult[];
  partialEffects: boolean;
  unsafeEvidence: Array<{ assignmentId: string; writeScope: string[] }>;
  projectionDegraded?: boolean;
}): DelegationOutcomeReport {
  const results = new Map(input.results.map((result) => [result.id, result]));
  const possibleWriteScopes = unique(input.activity.children.flatMap((child) => child.possiblePartialWriteScopes));
  const failures = unique(input.results.map((result) => result.failure).filter((failure): failure is DelegationFailure => Boolean(failure)));
  const reusableSessionReferences = input.results.map((result) => result.status === "succeeded" ? result.session?.resumeReference : null).filter((reference): reference is string => Boolean(reference));
  const state = input.activity.state === "succeeded" ? "succeeded" : input.activity.state === "cancelled" ? "cancelled" : "failed";
  const children = input.activity.children.map((child) => {
    const result = results.get(child.assignmentId);
    return {
      assignmentId: child.assignmentId,
      state: child.state,
      attempts: result?.attempts ?? child.attempt,
      blocker: child.blocker ?? result?.error ?? null,
      retryHistory: child.retryReason ? [child.retryReason] : [],
      escalation: child.escalation ?? result?.escalation ?? null,
      resumeReference: result?.status === "succeeded" ? result.session?.resumeReference ?? null : null,
    };
  });
  return {
    schemaVersion: 1,
    phase: "delegation",
    state,
    elapsedMs: Math.max(0, input.activity.updatedAt - input.activity.startedAt),
    children,
    completedAssignmentIds: input.results.filter((result) => result.status === "succeeded").map((result) => result.id),
    blocker: children.find((child) => child.blocker)?.blocker ?? null,
    retryHistory: input.activity.children.filter((child) => child.retryReason).map((child) => ({ assignmentId: child.assignmentId, reason: child.retryReason! })),
    escalation: children.find((child) => child.escalation)?.escalation ?? null,
    partialState: { possible: input.partialEffects || possibleWriteScopes.length > 0, possibleWriteScopes, unsafeAssignmentIds: unique(input.unsafeEvidence.map((item) => item.assignmentId)) },
    reusableSessionReferences,
    safeNextAction: actionFor({ state, failures, possibleScopes: possibleWriteScopes }),
    projectionDegraded: input.projectionDegraded === true,
  };
}
