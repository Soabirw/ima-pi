import { createHash } from "node:crypto";
import type { AgentDefinition } from "./ima-agents.ts";
import type { ImaPhase, ResolvedImaConfig, ResolvedRole } from "./ima-config.ts";
import { validateImagePaths } from "./ima-vision.ts";
import {
  validateDelegatedVerifications,
  type DelegatedVerification as DelegatedVerificationConfig,
} from "./ima-delegated-verification.ts";

export type DelegationAssignment = { id: string; agent: string; goal: string; context: string; paths: string[]; constraints: string[]; nonGoals: string[]; expectedOutput: string; writeScope: string[]; imagePaths?: string[]; verifications?: DelegatedVerificationConfig[]; allowUpwardFallback?: boolean };
export type { DelegatedVerification } from "./ima-delegated-verification.ts";
export type DelegationRequest = { title: string; assignments: DelegationAssignment[] };
export type DelegationFailure = "brief-correctable" | "transient-provider" | "model-unavailable" | "auth-or-quota" | "agent-contract" | "unsafe-partial-state" | "plan-contradiction" | "critical-decision" | "terminal";
export type DelegationEvent = { type: "started" | "succeeded" | "failed" | "cancelled"; id: string; detail?: string; partialEffects?: boolean };
export type SessionRecord = { reference: string; agent: string; role: string; resultKind: string; provider: string; model: string; thinking?: string; sessionId: string; sessionFile: string; writeScope: string[]; contractFingerprint: string; status: "running" | "succeeded" | "failed" | "cancelled"; fresh: boolean; followUpAllowed: boolean; createdAt: string; updatedAt: string };
export type BashClassification = { kind: "read-only" | "owned-mutation" | "unsafe-ambiguous"; paths: string[]; reason?: string };
export type CompletionFailureCode = "assistant_missing" | "assistant_error" | "assistant_aborted" | "assistant_truncated" | "assistant_tool_use" | "assistant_not_terminal" | "report_empty" | "runtime_identity_missing" | "runtime_identity_mismatch" | "session_identity_missing" | "session_identity_mismatch";

const delegatedBashTools = new Set(["bash", "test"]);

export const DELEGATED_BASH_PROMPT_GUIDANCE = [
  "Mandatory delegated-Bash guidance: use one logical command per call; await and inspect success before a dependent call.",
  "`&&` runs its right side only after its left succeeds; `;` runs the next regardless; `&` backgrounds work. Delegated composition is unsupported because operations require independent authorization and observation.",
  "Prefer native read/search/edit/write. Do not bypass with separators, backgrounding, pipes, substitutions, redirects, shell wrappers, or alternate/indirect execution.",
  "Keep paths repository-relative. Report unsupported verification to the parent; never claim it. This supplements adapter enforcement.",
].join(" ");

export const requiresDelegatedBashGuidance = (tools: readonly string[]) =>
  tools.some((tool) => delegatedBashTools.has(tool));

export const composeDelegatedBashPrompt = (prompt: string, tools: readonly string[]) =>
  requiresDelegatedBashGuidance(tools)
    ? `${prompt}\n\n${DELEGATED_BASH_PROMPT_GUIDANCE}`
    : prompt;

const clean = (value: unknown) => typeof value === "string" ? value.trim() : value instanceof Error ? value.message.trim() : "";
const invalidSegments = (path: string) => path.split("/").some((segment) => !segment || segment === "." || segment === "..");
const safeRelative = (path: string) => !!path && path !== "." && path !== "/" && !path.startsWith("/") && !path.includes("\\") && !invalidSegments(path);
const normalized = (path: string) => path.replace(/^\.\//, "").replace(/\/+$/, "");
const overlaps = (left: string, right: string) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const contained = (target: string, owner: string) => target === owner || target.startsWith(`${owner}/`);
const sameStringList = (left: readonly string[] = [], right: readonly string[] = []) => left.length === right.length && left.every((value, index) => value === right[index]);
const isAdversaryAssignment = (assignment: DelegationAssignment) => assignment.agent === "adversary-a" || assignment.agent === "adversary-b";
const sameAdversarialPacket = (left: DelegationAssignment, right: DelegationAssignment) =>
  left.goal === right.goal
  && left.context === right.context
  && sameStringList(left.paths, right.paths)
  && sameStringList(left.constraints, right.constraints)
  && sameStringList(left.nonGoals, right.nonGoals)
  && left.expectedOutput === right.expectedOutput
  && sameStringList(left.writeScope, right.writeScope)
  && sameStringList(left.imagePaths ?? [], right.imagePaths ?? []);

export function validateAdversarialAssignments(assignments: DelegationAssignment[]) {
  const adversaries = assignments.filter(isAdversaryAssignment);
  if (!adversaries.length) return { valid: true, errors: [] };
  const adversaryA = adversaries.filter(({ agent }) => agent === "adversary-a");
  const adversaryB = adversaries.filter(({ agent }) => agent === "adversary-b");
  if (adversaryA.length !== 1 || adversaryB.length !== 1) return { valid: false, errors: ["delegation_adversary_pair_required"] };
  return sameAdversarialPacket(adversaryA[0], adversaryB[0])
    ? { valid: true, errors: [] }
    : { valid: false, errors: ["delegation_adversary_packet_mismatch"] };
}

export function validateDelegationRequest(request: DelegationRequest, agents: AgentDefinition[]) {
  const assignments = Array.isArray(request.assignments) ? request.assignments : [];
  const errors: string[] = []; if (!clean(request.title)) errors.push("delegation_title_invalid");
  if (!Array.isArray(request.assignments) || assignments.length < 1 || assignments.length > 4) errors.push("delegation_child_count_invalid");
  const verificationAssignments = assignments.filter((assignment) => assignment?.verifications !== undefined);
  if (verificationAssignments.length && assignments.length !== 1) errors.push("delegated_verification_assignment_count_invalid");
  const names = new Map(agents.map((agent) => [agent.name, agent])); const seen = new Set<string>();
  for (const assignment of assignments) {
    if (!clean(assignment.id) || seen.has(assignment.id)) errors.push(`delegation_assignment_id_invalid:${assignment.id}`); seen.add(assignment.id);
    const agent = names.get(assignment.agent); if (!agent) { errors.push(`delegation_agent_unknown:${assignment.agent}`); continue; }
    for (const field of ["goal", "context", "expectedOutput"] as const) if (!clean(assignment[field])) errors.push(`delegation_${field}_invalid:${assignment.id}`);
    for (const path of [...assignment.paths, ...assignment.writeScope]) if (!safeRelative(path)) errors.push(`delegation_path_invalid:${assignment.id}`);
    const imageValidation = validateImagePaths(assignment.imagePaths ?? []);
    if (!imageValidation.valid) errors.push(`${imageValidation.error}:${assignment.id}`);
    if (assignment.verifications !== undefined) {
      errors.push(...validateDelegatedVerifications({
        verifications: assignment.verifications,
        agent,
      }).errors.map((error) => `${error}:${assignment.id}`));
    }
    if ((assignment.imagePaths?.length ?? 0) > 0 && (agent.tier !== "vision" || agent.authority !== "vision-read" || agent.result.kind !== "vision")) errors.push(`delegation_images_vision_only:${assignment.id}`);
    if (["read", "review-read", "vision-read"].includes(agent.authority) && assignment.writeScope.length) errors.push(`delegation_read_write_scope:${assignment.id}`);
    if (["write", "test-write", "document-write"].includes(agent.authority) && !assignment.writeScope.length) errors.push(`delegation_write_scope_required:${assignment.id}`);
  if (agent?.authority === "document-write") errors.push(...validateDocumentWriteScope(assignment.writeScope).errors.map((error) => `${error}:${assignment.id}`));
  }
  errors.push(...validateAdversarialAssignments(assignments).errors);
  errors.push(...validateParallelAssignments(assignments));
  return { valid: !errors.length, errors };
}

export function buildChildBrief(input: { projectRoot: string; assignment: DelegationAssignment; agent: AgentDefinition; tools?: readonly string[]; images?: Array<{ id: string; sourceLabel: string; mimeType: string; byteLength: number }> }) {
  const { assignment, agent } = input;
  const tools = input.tools ?? deriveToolAuthority(agent);
  const brief = [
    `You are the ${agent.name} specialist.`, `Goal: ${assignment.goal}`, `Project root: ${input.projectRoot}`, `Relevant paths: ${assignment.paths.join(", ") || "none"}`, `Context and prior decisions: ${assignment.context}`,
    `Constraints: ${assignment.constraints.join("; ") || "none"}`, `Non-goals: ${assignment.nonGoals.join("; ") || "none"}`, `Expected output: ${assignment.expectedOutput}`,
    `Phase route: ${agent.phase ?? "tier-routed"}.`,
    `Authority: ${agent.authority}. Allowed tools: ${tools.join(", ")}.`, `Exact write ownership: ${assignment.writeScope.join(", ") || "none"}.`,
    ...(input.images?.length ? [`Attached visual evidence only: ${input.images.map((image) => `${image.id} (${image.sourceLabel}, ${image.mimeType}, ${image.byteLength} bytes)`).join("; ")}. Analyze only those identities; report direct visual facts, exact legible text, uncertainty, and missing/ambiguous evidence. Do not include paths, bytes, or implementation decisions.`] : []),
    "Other work may run concurrently. Do not edit outside your ownership, rely on parent chat, or delegate further.", `Escalate: ${agent.escalation.join(", ")}.`, `Report sections: ${agent.result.requiredSections.join(", ")}.`, agent.prompt,
  ].join("\n\n");
  return composeDelegatedBashPrompt(brief, tools);
}

type AgentRouteSelection = {
  mapping: ResolvedRole;
  phase?: ImaPhase;
  routeTier: AgentDefinition["tier"];
  source: "agent" | "phase" | "tier";
};

const configuredAgentRoute = (config: ResolvedImaConfig, name: string) =>
  Object.hasOwn(config.agents ?? {}, name) ? config.agents[name] : undefined;

const selectAgentRoute = (input: { agent: Pick<AgentDefinition, "name" | "tier" | "phase">; config: ResolvedImaConfig }): AgentRouteSelection | null => {
  const agentMapping = configuredAgentRoute(input.config, input.agent.name);
  if (agentMapping) return { mapping: agentMapping, phase: input.agent.phase, routeTier: input.agent.tier, source: "agent" };
  const phase = input.agent.phase;
  const phaseMapping = phase ? input.config.phases[phase] : undefined;
  if (phaseMapping) return { mapping: phaseMapping, phase, routeTier: input.agent.tier, source: "phase" };
  const fallbackTier = input.agent.tier === "reviewVerify" && !input.config.models.reviewVerify ? "HIGH" : input.agent.tier;
  const tierMapping = input.config.models[fallbackTier];
  return tierMapping ? { mapping: tierMapping, phase, routeTier: fallbackTier, source: "tier" } : null;
};

export function resolveReviewVerificationRoute(input: { config: ResolvedImaConfig; catalog: Array<{ provider: string; model: string }>; agent?: Pick<AgentDefinition, "name" | "tier" | "phase"> }) {
  const requestedRole = "reviewVerify" as const;
  const agent = input.agent ?? { name: "review-verifier", tier: requestedRole };
  const agentMapping = configuredAgentRoute(input.config, agent.name);
  const reviewMapping = input.config.models.reviewVerify;
  const fallbackUsed = !agentMapping && !reviewMapping;
  const resolvedRole = fallbackUsed ? "HIGH" : requestedRole;
  const selected = agentMapping ?? reviewMapping ?? input.config.models.HIGH;
  if (!selected) return { route: null, error: "model_unavailable", requestedRole, resolvedRole, fallbackUsed, crossModel: false };
  const available = input.catalog.some((entry) => entry.provider === selected.provider && entry.model === selected.model);
  if (!available) return { route: null, error: "model_unavailable", requestedRole, resolvedRole, fallbackUsed, crossModel: false };
  const high = input.config.models.HIGH;
  return {
    route: {
      provider: selected.provider,
      model: selected.model,
      thinking: selected.thinking,
      tier: fallbackUsed ? "HIGH" : requestedRole,
      ...(agent.phase ? { phase: agent.phase } : {}),
    },
    error: null,
    requestedRole,
    resolvedRole,
    fallbackUsed,
    crossModel: !!high && (high.provider !== selected.provider || high.model !== selected.model),
  };
}

export type AdversarialRouteValidation =
  | { valid: true; routes: { adversaryA: ResolvedRole; adversaryB: ResolvedRole } }
  | { valid: false; code: "adversary_route_unconfigured" | "adversary_route_unavailable" | "adversary_routes_not_distinct"; role?: "adversaryA" | "adversaryB" };

export function validateAdversarialRoutes(input: { config: ResolvedImaConfig; catalog: Array<{ provider: string; model: string }> }): AdversarialRouteValidation {
  const adversaryA = selectAgentRoute({ agent: { name: "adversary-a", tier: "adversaryA" }, config: input.config })?.mapping;
  const adversaryB = selectAgentRoute({ agent: { name: "adversary-b", tier: "adversaryB" }, config: input.config })?.mapping;
  if (!adversaryA) return { valid: false, code: "adversary_route_unconfigured", role: "adversaryA" };
  if (!adversaryB) return { valid: false, code: "adversary_route_unconfigured", role: "adversaryB" };
  if (!input.catalog.some((entry) => entry.provider === adversaryA.provider && entry.model === adversaryA.model)) return { valid: false, code: "adversary_route_unavailable", role: "adversaryA" };
  if (!input.catalog.some((entry) => entry.provider === adversaryB.provider && entry.model === adversaryB.model)) return { valid: false, code: "adversary_route_unavailable", role: "adversaryB" };
  if (adversaryA.provider === adversaryB.provider && adversaryA.model === adversaryB.model) return { valid: false, code: "adversary_routes_not_distinct" };
  return { valid: true, routes: { adversaryA, adversaryB } };
}

export function resolveAgentRoute(input: { agent: AgentDefinition; config: ResolvedImaConfig; catalog: Array<{ provider: string; model: string; input?: { image?: boolean } | string[] }> }) {
  if (input.agent.tier === "reviewVerify") {
    const verified = resolveReviewVerificationRoute(input);
    return verified.route ? { route: verified.route, error: null, escalation: null, verification: verified } : { route: null, error: verified.error, escalation: "review verification model is unavailable", verification: verified };
  }
  const selected = selectAgentRoute(input);
  if (!selected) return { route: null, error: "model_unavailable", escalation: input.agent.tier === "adversaryA" || input.agent.tier === "adversaryB" ? `${input.agent.tier} model is not configured` : "minimum capability is not configured" };
  const catalog = input.catalog.find((entry) => entry.provider === selected.mapping.provider && entry.model === selected.mapping.model);
  const image = Array.isArray(catalog?.input) ? catalog.input.includes("image") : catalog?.input?.image === true;
  if (!catalog || (input.agent.tier === "vision" && !image)) {
    const escalation = selected.source === "agent"
      ? "configured agent route is unavailable"
      : input.agent.tier === "adversaryA" || input.agent.tier === "adversaryB"
        ? `${input.agent.tier} model is unavailable`
        : "minimum capability is unavailable";
    return { route: null, error: "model_unavailable", escalation };
  }
  return {
    route: {
      provider: selected.mapping.provider,
      model: selected.mapping.model,
      thinking: selected.mapping.thinking,
      tier: selected.routeTier,
      ...(selected.phase ? { phase: selected.phase } : {}),
    },
    error: null,
    escalation: null,
  };
}

export function deriveToolAuthority(agent: AgentDefinition) { return [...agent.tools]; }

// REVIEW-001: pure ownership normalization and containment. A target is owned only when it is a
// safe repository-relative path that resolves within one declared write-scope entry.
export function normalizeOwnershipTarget(target: unknown): string | null {
  const value = normalized(clean(target));
  if (!value || !safeRelative(value)) return null;
  return value;
}
export function isOwnedTarget(target: unknown, writeScope: string[]): boolean {
  const normalizedTarget = normalizeOwnershipTarget(target);
  if (!normalizedTarget) return false;
  const owners = writeScope.map(normalizeOwnershipTarget).filter((owner): owner is string => owner !== null);
  return owners.some((owner) => contained(normalizedTarget, owner));
}

export function isDocumentationTarget(path: unknown): boolean {
  const target = normalizeOwnershipTarget(path);
  if (!target) return false;
  if (["README.md", "README", "CHANGELOG.md", "CHANGELOG", "CHANGES", "RELEASE_NOTES"].includes(target)) return true;
  if (["agents/README.md", "config/README.md", "policies/README.md"].includes(target)) return true;
  const [root, ...rest] = target.split("/");
  if (root !== "docs" || rest.length === 0) return false;
  const name = rest.at(-1) ?? "";
  return /\.(?:md|mdx|txt)$/i.test(name) || ["README", "CHANGELOG", "CHANGES", "RELEASE_NOTES"].includes(name);
}
export function validateDocumentWriteScope(writeScope: string[]): { valid: boolean; errors: string[] } {
  const errors = writeScope.filter((path) => !isDocumentationTarget(path)).map((path) => `document_scope_invalid:${path}`);
  return { valid: errors.length === 0 && writeScope.length > 0, errors: writeScope.length ? errors : ["document_scope_empty"] };
}

// REVIEW-001: narrow bash classifier. Recognizes only a small set of unambiguous read-only commands;
// classifies clearly owned mutations; everything uncertain fails closed as unsafe-ambiguous.
const READ_ONLY_BASH = new Set(["ls", "cat", "pwd", "echo", "head", "tail", "grep", "wc", "stat"]);
const SAFE_GIT_SUBCOMMANDS = new Set(["diff", "status", "log", "show", "rev-parse"]);
const SAFE_REDIRECT_PRODUCERS = new Set(["echo", "printf", "cat", "head", "tail", "grep", "wc"]);
const MUTATION_REDIRECT = /(?<![0-9&>])(?:[0-9]+|&)?(>>?)\s*([^\s<>&|;()]+)/g;
const DESTRUCTIVE_BASH = /(^|[\s;|&])(rm|mv|cp|dd|truncate|tee|sed\s+-i|install|chmod|chown|mkdir|rmdir|touch|ln)\b/;
const SHELL_COMPOSITION = /[\n\r;&|`]|\$\(|<\(|>\(/;
export function classifyBashCommand(command: unknown, writeScope: string[]): BashClassification {
  const value = clean(command);
  if (!value) return { kind: "unsafe-ambiguous", paths: [], reason: "empty_command" };
  const redirects: string[] = [];
  for (const match of value.matchAll(MUTATION_REDIRECT)) redirects.push(match[2]);
  const commandWithoutRedirects = value.replace(MUTATION_REDIRECT, " ");
  const destructive = DESTRUCTIVE_BASH.test(value);
  const words = value.split(/\s+/);
  const head = words[0] ?? "";
  if (commandWithoutRedirects.includes(">")) return { kind: "unsafe-ambiguous", paths: redirects, reason: "unclassifiable_mutation" };
  if (!destructive && redirects.length === 0) {
    if (SHELL_COMPOSITION.test(value)) return { kind: "unsafe-ambiguous", paths: [], reason: "shell_composition" };
    if (READ_ONLY_BASH.has(head) || (head === "git" && SAFE_GIT_SUBCOMMANDS.has(words[1] ?? ""))) return { kind: "read-only", paths: [] };
    return { kind: "unsafe-ambiguous", paths: [], reason: "unrecognized_command" };
  }
  if (SHELL_COMPOSITION.test(commandWithoutRedirects)) return { kind: "unsafe-ambiguous", paths: redirects, reason: "shell_composition" };
  if (destructive) return { kind: "unsafe-ambiguous", paths: redirects, reason: "destructive_command" };
  if (!redirects.length || !SAFE_REDIRECT_PRODUCERS.has(head)) return { kind: "unsafe-ambiguous", paths: redirects, reason: "unclassifiable_mutation" };
  const owned = redirects.every((target) => isOwnedTarget(target, writeScope));
  return owned ? { kind: "owned-mutation", paths: redirects.map((target) => normalizeOwnershipTarget(target) ?? target) } : { kind: "unsafe-ambiguous", paths: redirects, reason: "target_out_of_scope" };
}

export function writeScopesOverlap(left: string[], right: string[]) { return left.some((a) => right.some((b) => overlaps(normalized(a), normalized(b)))); }
export function validateParallelAssignments(assignments: DelegationAssignment[]) { const errors: string[] = []; for (let i = 0; i < assignments.length; i += 1) for (let j = i + 1; j < assignments.length; j += 1) if (writeScopesOverlap(assignments[i].writeScope, assignments[j].writeScope)) errors.push(`delegation_write_scope_overlap:${assignments[i].id}:${assignments[j].id}`); return errors; }
export function classifyChildFailure(error: unknown): DelegationFailure { const value = clean(error).toLowerCase(); if (/quota|unauth|auth/.test(value)) return "auth-or-quota"; if (/unavailable|not found/.test(value)) return "model-unavailable"; if (/timeout|network|rate/.test(value)) return "transient-provider"; if (/partial|cancel/.test(value)) return "unsafe-partial-state"; if (/brief/.test(value)) return "brief-correctable"; if (/scope|architecture|security|contradiction/.test(value)) return "critical-decision"; return "terminal"; }
export function decideRecovery(input: { failure: DelegationFailure; retries: number; materiallyImproved?: boolean }) { const retry = input.retries === 0 && (input.failure === "transient-provider" || (input.failure === "brief-correctable" && input.materiallyImproved === true)); return { retry, escalation: !retry, reason: retry ? "one_safe_retry" : input.failure }; }
export function createDelegationState(request: DelegationRequest) { return { assignments: request.assignments.map((assignment) => ({ id: assignment.id, status: "pending" as const, detail: "" })), partialEffects: false }; }
export function reduceDelegationEvent(state: ReturnType<typeof createDelegationState>, event: DelegationEvent) { return { ...state, assignments: state.assignments.map((assignment) => assignment.id === event.id ? { ...assignment, status: event.type === "started" ? "running" as const : event.type === "succeeded" ? "succeeded" as const : event.type === "cancelled" ? "cancelled" as const : "failed" as const, detail: event.detail ?? "" } : assignment), partialEffects: state.partialEffects || event.partialEffects === true || event.type === "cancelled" }; }
export function sanitizeDelegationError(error: unknown) { return clean(error).replace(/(api[_ -]?key|token|authorization|password)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]").slice(0, 500); }

// REVIEW-003: pure terminal-completion validator. Idle alone is not success; require a normal
// terminal assistant report and exact observed runtime/session identity.

export function validateDelegationRouteIdentity(input: {
  expected: { provider: string; model: string; thinking?: string };
  observed: { provider?: string; model?: string; thinking?: string };
}): { ok: boolean; failures: CompletionFailureCode[] } {
  const failures: CompletionFailureCode[] = [];
  const observed = input.observed;
  if (!clean(observed.provider) || !clean(observed.model)) failures.push("runtime_identity_missing");
  else if (observed.provider !== input.expected.provider || observed.model !== input.expected.model || (input.expected.thinking !== undefined && observed.thinking !== input.expected.thinking)) failures.push("runtime_identity_mismatch");
  return { ok: failures.length === 0, failures };
}

export function validateDelegationCompletion(input: {
  final: { stopReason?: string; isError?: boolean; hasPendingToolUse?: boolean } | undefined | null;
  text: unknown;
  requiredSections: string[];
  expected: { provider: string; model: string; thinking?: string; sessionId?: string; sessionFile?: string };
  observed: { provider?: string; model?: string; thinking?: string; sessionId?: string; sessionFile?: string };
}): { ok: boolean; failures: CompletionFailureCode[] } {
  const failures: CompletionFailureCode[] = [];
  const final = input.final;
  if (!final) failures.push("assistant_missing");
  else {
    if (final.isError) failures.push("assistant_error");
    if (final.stopReason === "aborted" || final.stopReason === "cancelled") failures.push("assistant_aborted");
    if (final.stopReason === "length" || final.stopReason === "max_tokens") failures.push("assistant_truncated");
    if (final.hasPendingToolUse || final.stopReason === "toolUse" || final.stopReason === "tool_use") failures.push("assistant_tool_use");
    if (final.stopReason !== "stop") failures.push("assistant_not_terminal");
  }
  const text = clean(input.text);
  if (!text) failures.push("report_empty");
  const observed = input.observed;
  failures.push(...validateDelegationRouteIdentity({ expected: input.expected, observed }).failures);
  if (!clean(observed.sessionId) || !clean(observed.sessionFile)) failures.push("session_identity_missing");
  else if ((input.expected.sessionId !== undefined && observed.sessionId !== input.expected.sessionId) || (input.expected.sessionFile !== undefined && observed.sessionFile !== input.expected.sessionFile)) failures.push("session_identity_mismatch");
  return { ok: failures.length === 0, failures };
}

// REVIEW-004: canonical agent-contract fingerprint used to detect definition drift before session reuse.
export function agentContractFingerprint(agent: AgentDefinition, writeScope: string[]): string {
  const canonical = {
    authority: agent.authority,
    tools: [...agent.tools].sort(),
    resultKind: agent.result.kind,
    requiredSections: [...agent.result.requiredSections].sort(),
    resultFormat: agent.result.format ?? null,
    freshInitial: agent.independence.freshInitial,
    followUpAllowed: agent.independence.followUpAllowed,
    writeScope: [...writeScope].map((entry) => normalizeOwnershipTarget(entry) ?? entry).sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function canResumeSession(input: { record: SessionRecord; agent: AgentDefinition; purpose: "initial-review" | "rereview" | "finding-follow-up" | "implementation-follow-up" | "review-resolution" | "vision-follow-up"; sessionFileExists: boolean }) { if (!input.sessionFileExists || input.record.agent !== input.agent.name || input.record.status !== "succeeded" || !input.agent.independence.followUpAllowed) return false; if (input.agent.authority === "review-read") return ["rereview", "finding-follow-up"].includes(input.purpose); if (input.agent.authority === "vision-read") return input.purpose === "vision-follow-up"; return ["implementation-follow-up", "review-resolution"].includes(input.purpose); }
export {
  DELEGATION_RESULT_MAX_BYTES,
  DELEGATION_RESULT_MAX_LINES,
  DELEGATION_SUMMARY_MAX_BYTES,
  DELEGATION_SUMMARY_MAX_LINES,
  boundDelegationSummary,
  buildDelegationToolPayload,
  createDelegationResult,
  summarizeDelegationResults,
} from "./ima-delegation-results.ts";
export type {
  DelegationResult,
  DelegationSessionPointer,
  DelegationSummaryLimits,
} from "./ima-delegation-results.ts";
