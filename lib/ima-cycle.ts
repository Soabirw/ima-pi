/** Pure cycle parsing, state reduction, evidence, and tracker-shape helpers. */

export const CYCLE_SCHEMA_VERSION = 1;
export const CYCLE_ENTRY = "ima-cycle-state";
export const IMA_PROJECT = "ima-pi";
export const CYCLE_REVIEW_CAP_DEFAULT = 2;
export const CYCLE_REVIEW_CAP_MIN = 0;
export const CYCLE_REVIEW_CAP_MAX = 10;

export const CYCLE_IMPLEMENTATION_MODES = ["generic", "js", "wp"] as const;
export type CycleImplementationMode = typeof CYCLE_IMPLEMENTATION_MODES[number];

export const CYCLE_PHASES = ["plan", "implementation", "test", "review", "resolution", "rereview", "document"] as const;
export type CyclePhase = typeof CYCLE_PHASES[number];

export const CYCLE_STATUSES = ["awaiting-evidence", "awaiting-resume", "stopped", "blocked", "closeout-ready", "closed", "blocked-after-tracker-close"] as const;
export type CycleStatus = typeof CYCLE_STATUSES[number];

export const CYCLE_PHASE_OUTCOMES: Readonly<Record<CyclePhase, readonly string[]>> = Object.freeze({
  plan: ["APPROVED", "BLOCKED"],
  implementation: ["COMPLETED", "BLOCKED"],
  test: ["PASSED", "DEFECTS", "BLOCKED"],
  review: ["APPROVED", "REQUEST_CHANGES", "BLOCKED"],
  resolution: ["RESOLVED", "BLOCKED"],
  rereview: ["APPROVED", "REQUEST_CHANGES", "BLOCKED"],
  document: ["READY", "BLOCKED"],
});

export type CycleSource =
  | { type: "jira"; key: string; url: string }
  | { type: "taskwarrior"; project: string; uuid: string };

export type CycleEvidence = {
  phase: CyclePhase;
  outcome: string;
  marker: string;
  toolCallId: string;
  artifactId: string | null;
  timestamp: string;
};

export type CycleState = {
  schemaVersion: 1;
  source: CycleSource;
  lifecycleKey: string;
  implementationMode: CycleImplementationMode;
  phase: CyclePhase;
  status: CycleStatus;
  reviewAttempts: number;
  reviewCap: number;
  evidence: CycleEvidence[];
  blockers: string[];
  updatedAt: string;
  stoppedAt?: string;
  stoppedPhase?: CyclePhase;
  trackerClosed?: boolean;
  branchId?: string;
};

export type CycleCommand =
  | { command: "start"; source: CycleSource; reviewCap?: number; implementationMode?: CycleImplementationMode }
  | { command: "status" }
  | { command: "stop"; acknowledge: boolean }
  | { command: "resume" }
  | { command: "close"; commitPrep: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const PROJECT = /^[\w.-]+$/;
const LIFECYCLE_KEY = /^[^\r\n]{1,512}$/;
const JIRA_URL = /^https:\/\/flccc\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)$/;
const CYCLE_MARKER = /<!--\s*ima-cycle outcome:\s*phase=(plan|implementation|test|review|resolution|rereview|document);\s*outcome=([A-Z_]+)\s*-->/g;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const boundedText = (value: unknown, maximum: number) => text(value).length > 0 && text(value).length <= maximum;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const nowIso = () => new Date().toISOString();
const timestamp = (value: unknown, fallback = nowIso()) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text(value)) ? text(value) : fallback;
const validTimestamp = (value: unknown) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text(value));
const cleanLine = (value: unknown, maximum = 512) => text(value).replace(/[\r\n]+/g, " ").replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, maximum);
const validPhase = (value: unknown): value is CyclePhase => CYCLE_PHASES.includes(value as CyclePhase);
const validStatus = (value: unknown): value is CycleStatus => CYCLE_STATUSES.includes(value as CycleStatus);
const validImplementationMode = (value: unknown): value is CycleImplementationMode => CYCLE_IMPLEMENTATION_MODES.includes(value as CycleImplementationMode);
const validOutcome = (phase: CyclePhase, value: unknown) => typeof value === "string" && CYCLE_PHASE_OUTCOMES[phase].includes(value);

export function sanitizeCycleError(code: string, _value?: unknown) {
  return { code, message: `Cycle integration failed: ${code}.` };
}

export function cycleSourceReference(source: CycleSource): string {
  return source.type === "jira" ? source.key : `taskwarrior ${source.project} ${source.uuid}`;
}

export function cycleLifecycleKey(source: CycleSource): string {
  return source.type === "jira" ? `${IMA_PROJECT}:jira:${source.key}` : `${IMA_PROJECT}:taskwarrior:${source.project}:${source.uuid}`;
}

export function normalizeCycleSource(value: unknown): CycleSource | null {
  if (typeof value === "string") {
    const raw = value.trim();
    const urlMatch = raw.match(JIRA_URL);
    const key = urlMatch?.[1] ?? (JIRA_KEY.test(raw) ? raw : "");
    return key ? { type: "jira", key, url: `https://flccc.atlassian.net/browse/${key}` } : null;
  }
  const input = object(value);
  if (!input || typeof input.type !== "string") return null;
  if (input.type === "jira" && onlyKeys(input, ["type", "key", "url"])) {
    const key = text(input.key);
    const url = text(input.url);
    if (!JIRA_KEY.test(key) || (url && url !== `https://flccc.atlassian.net/browse/${key}`)) return null;
    return { type: "jira", key, url: `https://flccc.atlassian.net/browse/${key}` };
  }
  if (input.type === "taskwarrior" && onlyKeys(input, ["type", "project", "uuid"])) {
    const project = text(input.project);
    const uuid = text(input.uuid);
    if (!PROJECT.test(project) || !UUID.test(uuid)) return null;
    return { type: "taskwarrior", project, uuid };
  }
  return null;
}

export function parseCycleCommand(input: unknown): CycleCommand | null {
  if (typeof input !== "string") return null;
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens[0] === "/ima:cycle") tokens.shift();
  if (!tokens.length) return null;
  const command = tokens.shift();
  if (command === "status" && tokens.length === 0) return { command: "status" };
  if (command === "resume" && tokens.length === 0) return { command: "resume" };
  if (command === "stop" && (tokens.length === 0 || (tokens.length === 1 && ["--ack", "--acknowledge"].includes(tokens[0])))) return { command: "stop", acknowledge: tokens.length === 1 };
  if (command === "close" && (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "--commit-prep"))) return { command: "close", commitPrep: tokens[0] === "--commit-prep" };
  if (command !== "start") return null;

  let reviewCap: number | undefined;
  let implementationMode: CycleImplementationMode | undefined;
  const sourceTokens: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--review-cap" || token.startsWith("--review-cap=")) {
      if (reviewCap !== undefined) return null;
      const raw = token === "--review-cap" ? tokens[++index] : token.slice("--review-cap=".length);
      if (!raw || !/^\d+$/.test(raw)) return null;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < CYCLE_REVIEW_CAP_MIN || parsed > CYCLE_REVIEW_CAP_MAX) return null;
      reviewCap = parsed;
      continue;
    }
    if (token === "--implementation" || token.startsWith("--implementation=")) {
      if (implementationMode !== undefined) return null;
      const raw = token === "--implementation" ? tokens[++index] : token.slice("--implementation=".length);
      if (!validImplementationMode(raw)) return null;
      implementationMode = raw;
      continue;
    }
    if (token.startsWith("--")) return null;
    sourceTokens.push(token);
  }

  const source = sourceTokens.length === 1
    ? normalizeCycleSource(sourceTokens[0])
    : sourceTokens.length === 3 && sourceTokens[0] === "taskwarrior"
      ? normalizeCycleSource({ type: "taskwarrior", project: sourceTokens[1], uuid: sourceTokens[2] })
      : null;
  return source
    ? { command: "start", source, ...(reviewCap === undefined ? {} : { reviewCap }), ...(implementationMode === undefined ? {} : { implementationMode }) }
    : null;
}

export function phaseCommand(phase: CyclePhase, implementationMode: CycleImplementationMode = "generic"): string {
  return {
    plan: "/ima:plan",
    implementation: implementationMode === "js" ? "/ima:implement-js" : implementationMode === "wp" ? "/ima:implement-wp" : "/ima:implement",
    test: "/ima:test",
    review: "/ima:review",
    resolution: "/ima:resolve-review",
    rereview: "/ima:rereview",
    document: "/ima:document",
  }[phase];
}

export function buildCycleOutcomeMarker(input: { phase: CyclePhase; outcome: string }): string {
  if (!validOutcome(input.phase, input.outcome)) throw new Error("cycle_outcome_invalid");
  return `<!-- ima-cycle outcome: phase=${input.phase}; outcome=${input.outcome} -->`;
}

export function extractPhaseOutcome(artifact: unknown): { ok: true; phase: CyclePhase; outcome: string; marker: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError> } {
  if (typeof artifact !== "string" || artifact.length > 128_000) return { ok: false, error: sanitizeCycleError("phase_artifact_invalid") };
  const matches = [...artifact.matchAll(CYCLE_MARKER)];
  if (!matches.length) return { ok: false, error: sanitizeCycleError("phase_marker_missing") };
  if (matches.length !== 1) return { ok: false, error: sanitizeCycleError("phase_marker_ambiguous") };
  const phase = matches[0][1] as CyclePhase;
  const outcome = matches[0][2];
  if (!validPhase(phase) || !validOutcome(phase, outcome)) return { ok: false, error: sanitizeCycleError("phase_marker_invalid") };
  return { ok: true, phase, outcome, marker: matches[0][0] };
}

const validateEvidence = (value: unknown): value is CycleEvidence => {
  const evidence = object(value);
  return Boolean(evidence && validPhase(evidence.phase) && validOutcome(evidence.phase, evidence.outcome) && boundedText(evidence.marker, 512) && boundedText(evidence.toolCallId, 256) && (evidence.artifactId === null || boundedText(evidence.artifactId, 512)) && validTimestamp(evidence.timestamp));
};

export function createCycleState(sourceValue: unknown, options: { lifecycleKey?: string; reviewCap?: number; implementationMode?: CycleImplementationMode; timestamp?: string; branchId?: string } = {}): CycleState {
  const source = normalizeCycleSource(sourceValue);
  if (!source) throw new Error("cycle_source_invalid");
  const reviewCap = options.reviewCap ?? CYCLE_REVIEW_CAP_DEFAULT;
  if (!Number.isInteger(reviewCap) || reviewCap < CYCLE_REVIEW_CAP_MIN || reviewCap > CYCLE_REVIEW_CAP_MAX) throw new Error("review_cap_invalid");
  const implementationMode = options.implementationMode ?? "generic";
  if (!validImplementationMode(implementationMode)) throw new Error("implementation_mode_invalid");
  const lifecycleKey = text(options.lifecycleKey) || cycleLifecycleKey(source);
  if (!LIFECYCLE_KEY.test(lifecycleKey)) throw new Error("lifecycle_key_invalid");
  return {
    schemaVersion: CYCLE_SCHEMA_VERSION,
    source,
    lifecycleKey,
    implementationMode,
    phase: "plan",
    status: "awaiting-evidence",
    reviewAttempts: 0,
    reviewCap,
    evidence: [],
    blockers: [],
    updatedAt: timestamp(options.timestamp),
    ...(options.branchId && boundedText(options.branchId, 256) ? { branchId: options.branchId } : {}),
  };
}

export function validateCycleState(value: unknown): { valid: true; state: CycleState } | { valid: false; error: ReturnType<typeof sanitizeCycleError> } {
  const state = object(value);
  const implementationMode = state?.implementationMode === undefined ? "js" : state.implementationMode;
  if (!state || state.schemaVersion !== CYCLE_SCHEMA_VERSION || !normalizeCycleSource(state.source) || !LIFECYCLE_KEY.test(text(state.lifecycleKey)) || !validImplementationMode(implementationMode) || !validPhase(state.phase) || !validStatus(state.status) || !Number.isInteger(state.reviewAttempts) || !Number.isInteger(state.reviewCap) || state.reviewCap < CYCLE_REVIEW_CAP_MIN || state.reviewCap > CYCLE_REVIEW_CAP_MAX || state.reviewAttempts < 0 || state.reviewAttempts > state.reviewCap || !Array.isArray(state.evidence) || !state.evidence.every(validateEvidence) || !Array.isArray(state.blockers) || !state.blockers.every((item) => typeof item === "string" && item.length <= 512) || !validTimestamp(state.updatedAt)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.stoppedAt !== undefined && !validTimestamp(state.stoppedAt)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.stoppedPhase !== undefined && !validPhase(state.stoppedPhase)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.trackerClosed !== undefined && typeof state.trackerClosed !== "boolean") return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.branchId !== undefined && !boundedText(state.branchId, 256)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  const source = normalizeCycleSource(state.source)!;
  const duplicateToolCall = new Set<string>();
  for (const evidence of state.evidence) {
    if (duplicateToolCall.has(evidence.toolCallId)) return { valid: false, error: sanitizeCycleError("cycle_evidence_duplicate") };
    duplicateToolCall.add(evidence.toolCallId);
  }
  return { valid: true, state: { ...state, source, implementationMode, evidence: state.evidence.map((item) => ({ ...item })), blockers: state.blockers.map((item) => cleanLine(item)) } as CycleState };
}

const lastEvidence = (state: CycleState) => state.evidence[state.evidence.length - 1] ?? null;
const transition = (state: CycleState, outcome: string): { phase: CyclePhase; status: CycleStatus; reviewAttempts: number; blockers: string[] } => {
  if (outcome === "BLOCKED" || outcome === "DEFECTS") return { phase: state.phase, status: "blocked", reviewAttempts: state.reviewAttempts, blockers: [`${state.phase}:${outcome}`] };
  if (state.phase === "plan" && outcome === "APPROVED") return { phase: "implementation", status: "awaiting-resume", reviewAttempts: state.reviewAttempts, blockers: [] };
  if (state.phase === "implementation" && outcome === "COMPLETED") return { phase: "test", status: "awaiting-resume", reviewAttempts: state.reviewAttempts, blockers: [] };
  if (state.phase === "test" && outcome === "PASSED") return { phase: "review", status: "awaiting-resume", reviewAttempts: state.reviewAttempts, blockers: [] };
  if ((state.phase === "review" || state.phase === "rereview") && outcome === "APPROVED") return { phase: "document", status: "awaiting-resume", reviewAttempts: state.reviewAttempts, blockers: [] };
  if ((state.phase === "review" || state.phase === "rereview") && outcome === "REQUEST_CHANGES") {
    const attempts = state.reviewAttempts + 1;
    return attempts <= state.reviewCap
      ? { phase: "resolution", status: "awaiting-resume", reviewAttempts: attempts, blockers: [] }
      : { phase: state.phase, status: "blocked", reviewAttempts: state.reviewCap, blockers: ["review_cap_exceeded"] };
  }
  if (state.phase === "resolution" && outcome === "RESOLVED") return { phase: "rereview", status: "awaiting-resume", reviewAttempts: state.reviewAttempts, blockers: [] };
  if (state.phase === "document" && outcome === "READY") return { phase: "document", status: "closeout-ready", reviewAttempts: state.reviewAttempts, blockers: [] };
  return { phase: state.phase, status: "blocked", reviewAttempts: state.reviewAttempts, blockers: ["phase_transition_invalid"] };
};

export function reduceCycleState(stateValue: unknown, evidenceValue: unknown, options: { timestamp?: string } = {}): { ok: true; state: CycleState } | { ok: false; state: CycleState | null; error: ReturnType<typeof sanitizeCycleError> } {
  const valid = validateCycleState(stateValue);
  if (!valid.valid) return { ok: false, state: null, error: valid.error };
  const state = valid.state;
  if (state.status !== "awaiting-evidence") return { ok: false, state, error: sanitizeCycleError("cycle_resume_required") };
  const input = object(evidenceValue);
  const artifact = text(input?.artifact);
  const extracted = artifact ? extractPhaseOutcome(artifact) : null;
  const phase = (extracted?.ok ? extracted.phase : text(input?.phase)) as CyclePhase;
  const outcome = extracted?.ok ? extracted.outcome : text(input?.outcome);
  const marker = extracted?.ok ? extracted.marker : text(input?.marker);
  const toolCallId = text(input?.toolCallId);
  if (extracted && !extracted.ok) return { ok: false, state, error: extracted.error };
  if (!validPhase(phase) || !validOutcome(phase, outcome) || !boundedText(marker, 512) || !boundedText(toolCallId, 256)) return { ok: false, state, error: sanitizeCycleError("phase_evidence_invalid") };
  if (phase !== state.phase) return { ok: false, state, error: sanitizeCycleError("phase_evidence_out_of_order") };
  const repeatableMarkerPhase = phase === "resolution" || phase === "rereview";
  if (state.evidence.some((item) => item.toolCallId === toolCallId || (!repeatableMarkerPhase && item.marker === marker))) return { ok: false, state, error: sanitizeCycleError("phase_evidence_duplicate") };
  const evidence: CycleEvidence = { phase, outcome, marker, toolCallId, artifactId: text(input?.artifactId) || null, timestamp: timestamp(input?.timestamp, options.timestamp ?? nowIso()) };
  const next = transition(state, outcome);
  const updated: CycleState = {
    ...state,
    phase: next.phase,
    status: next.status,
    reviewAttempts: next.reviewAttempts,
    blockers: next.blockers,
    evidence: [...state.evidence.map((item) => ({ ...item })), evidence],
    updatedAt: timestamp(options.timestamp),
  };
  return { ok: true, state: updated };
}

export function nextCyclePhase(stateValue: unknown, outcome?: string): CyclePhase | null {
  const valid = validateCycleState(stateValue);
  if (!valid.valid) return null;
  const state = valid.state;
  if (state.status === "closeout-ready" || state.status === "closed" || state.status === "blocked" || state.status === "blocked-after-tracker-close") return null;
  if (state.status === "awaiting-resume" || state.status === "awaiting-evidence" || state.status === "stopped") return state.phase;
  const resolvedOutcome = outcome ?? lastEvidence(state)?.outcome;
  if (!resolvedOutcome) return state.phase;
  const next = transition(state, resolvedOutcome);
  return next.status === "blocked" ? null : next.phase;
}

export function buildResumeSource(stateValue: unknown): string | null {
  const valid = validateCycleState(stateValue);
  if (!valid.valid || valid.state.status !== "awaiting-resume") return null;
  const state = valid.state;
  const source = cycleSourceReference(state.source);
  const jiraKey = state.source.type === "jira" ? state.source.key : "none";
  const taskwarriorProject = state.source.type === "taskwarrior" ? state.source.project : "none";
  const taskwarriorUuid = state.source.type === "taskwarrior" ? state.source.uuid : "none";
  const priorArtifactIds = state.evidence.flatMap((item) => item.artifactId ? [cleanLine(item.artifactId)] : []);
  const orderedEvidence = state.evidence.flatMap((item) => [
    `phase: ${cleanLine(item.phase, 128)}`,
    `outcome: ${cleanLine(item.outcome, 128)}`,
    `timestamp: ${cleanLine(item.timestamp, 64)}`,
    `artifactId: ${item.artifactId === null ? "none" : cleanLine(item.artifactId)}`,
    `toolCallId: ${cleanLine(item.toolCallId)}`,
  ]);
  return [
    `${phaseCommand(state.phase, state.implementationMode)} ${cleanLine(source)}`,
    "Lifecycle evidence packet:",
    `project: ${IMA_PROJECT}`,
    `lifecycleKey: ${cleanLine(state.lifecycleKey)}`,
    `sourceType: ${cleanLine(state.source.type, 64)}`,
    `source: ${cleanLine(source)}`,
    `jiraKey: ${cleanLine(jiraKey, 128)}`,
    `taskwarriorProject: ${cleanLine(taskwarriorProject, 128)}`,
    `taskwarriorUuid: ${cleanLine(taskwarriorUuid, 128)}`,
    `reviewCap: ${cleanLine(String(state.reviewCap), 32)}`,
    `implementationMode: ${cleanLine(state.implementationMode, 32)}`,
    "orderedPhaseEvidence:",
    ...orderedEvidence,
    `priorArtifactIds: ${priorArtifactIds.length ? priorArtifactIds.join(", ") : "none"}`,
  ].join("\n");
}

export function buildCycleStatus(stateValue: unknown): { status: "invalid"; error: ReturnType<typeof sanitizeCycleError> } | { status: CycleStatus; source: string; phase: CyclePhase; nextPhase: CyclePhase | null; implementationMode: CycleImplementationMode; reviewAttempts: number; reviewCap: number; evidence: Array<Pick<CycleEvidence, "phase" | "outcome" | "artifactId" | "timestamp">>; blockers: string[] } {
  const valid = validateCycleState(stateValue);
  if (!valid.valid) return { status: "invalid", error: valid.error };
  const state = valid.state;
  return {
    status: state.status,
    source: cycleSourceReference(state.source),
    phase: state.phase,
    nextPhase: nextCyclePhase(state),
    implementationMode: state.implementationMode,
    reviewAttempts: state.reviewAttempts,
    reviewCap: state.reviewCap,
    evidence: state.evidence.map(({ phase, outcome, artifactId, timestamp: at }) => ({ phase, outcome, artifactId, timestamp: at })),
    blockers: state.blockers.map((item) => cleanLine(item)),
  };
}

export function requiredCloseoutEvidence(stateValue: unknown): { valid: boolean; missing: string[]; evidence: CycleEvidence[] } {
  const valid = validateCycleState(stateValue);
  if (!valid.valid) return { valid: false, missing: ["valid_cycle_state"], evidence: [] };
  const state = valid.state;
  const evidence = state.evidence;
  const latest = (phase: CyclePhase, outcomes: readonly string[]) => [...evidence].reverse().find((item) => item.phase === phase && outcomes.includes(item.outcome));
  const missing: string[] = [];
  if (state.status !== "closeout-ready") missing.push("closeout_ready");
  if (!latest("plan", ["APPROVED"])) missing.push("plan_approved");
  if (!latest("implementation", ["COMPLETED"])) missing.push("implementation_completed");
  if (!latest("test", ["PASSED"])) missing.push("test_passed");
  if (!latest("review", ["APPROVED"]) && !latest("rereview", ["APPROVED"])) missing.push("review_approved");
  if (!latest("document", ["READY"])) missing.push("document_ready");
  if (state.blockers.length) missing.push("blockers_resolved");
  return { valid: missing.length === 0, missing, evidence: evidence.map((item) => ({ ...item })) };
}

export function buildFinalCloseoutArtifact(stateValue: unknown, details: { identity?: Record<string, unknown>; verification?: string[]; blockers?: string[]; residualRisk?: string[] } = {}): string {
  const valid = validateCycleState(stateValue);
  if (!valid.valid) return "# Source and approved outcome\n\nCycle state is invalid.\n";
  const state = valid.state;
  const verification = (details.verification ?? ["Cycle state and closeout evidence were revalidated before tracker close."]).map((item) => `- ${cleanLine(item, 1_024)}`);
  const blockers = (details.blockers ?? state.blockers).map((item) => `- ${cleanLine(item, 1_024)}`);
  const risk = (details.residualRisk ?? ["Tracker mutation and lifecycle persistence are separate operations; a lifecycle failure after tracker close remains blocked."]).map((item) => `- ${cleanLine(item, 1_024)}`);
  const prior = state.evidence.filter((item) => item.artifactId).map((item) => `- ${cleanLine(item.artifactId)}`);
  return [
    "# Source and approved outcome",
    `Cycle source: ${cycleSourceReference(state.source)}. Lifecycle key: ${cleanLine(state.lifecycleKey)}.`,
    "## Scope",
    "Coordinate one closed Jira or Taskwarrior Story through the approved Pi-native lifecycle with explicit user-gated phase progression.",
    "## Non-goals",
    "No generic workflow DSL, automatic progression, parallel stories, deployment, push, release, or mutation of an unrelated tracker.",
    "## Phase result",
    `Cycle status: ${state.status}. Completed evidence: ${state.evidence.map((item) => `${item.phase}=${item.outcome}`).join(", ") || "none"}.`,
    "## Changed files",
    "Cycle closeout records lifecycle evidence; repository changes remain recorded by the implementation artifact.",
    "## Decisions",
    "Pi custom entries remain the branch-aware state source; semantic lifecycle evidence remains authoritative over physical memory IDs.",
    "## Verification commands/results",
    ...verification,
    "## Blockers",
    ...(blockers.length ? blockers : ["- None."]),
    "## Residual risk",
    ...risk,
    "## Prior artifacts",
    ...(prior.length ? prior : ["- Phase artifact IDs were not supplied by the lifecycle tools."]),
    "## Recommended next phase",
    "Closeout complete; no automatic follow-up phase.",
  ].join("\n");
}

const arrayFrom = (value: unknown): unknown[] => Array.isArray(value) ? value : Array.isArray(object(value)?.data) ? object(value)!.data as unknown[] : [];

export function parseJiraTracker(value: unknown): { valid: true; key: string; transitions: Array<{ id: string; name: string; to: string }>; doneTransitions: Array<{ id: string; name: string; to: string }> } | { valid: false; error: ReturnType<typeof sanitizeCycleError> } {
  const input = object(value);
  const rawTransitions = Array.isArray(value) ? value : input?.transitions;
  if (!Array.isArray(rawTransitions)) return { valid: false, error: sanitizeCycleError("jira_transitions_invalid") };
  const key = text(input?.key);
  const transitions = rawTransitions.map((item) => {
    const entry = object(item);
    return { id: text(entry?.id), name: cleanLine(entry?.name), to: cleanLine(entry?.to ?? object(entry?.to)?.name) };
  });
  if (!transitions.every((item) => boundedText(item.id, 128) && boundedText(item.name, 256) && boundedText(item.to, 256))) return { valid: false, error: sanitizeCycleError("jira_transitions_invalid") };
  const doneTransitions = transitions.filter((item) => item.to.toLowerCase() === "done");
  return { valid: true, key, transitions, doneTransitions };
}

export function parseTaskwarriorTracker(value: unknown, sourceValue: unknown): { valid: true; source: Extract<CycleSource, { type: "taskwarrior" }>; matches: Array<Record<string, unknown>>; pending: Record<string, unknown> } | { valid: false; error: ReturnType<typeof sanitizeCycleError> } {
  const source = normalizeCycleSource(sourceValue);
  if (!source || source.type !== "taskwarrior") return { valid: false, error: sanitizeCycleError("taskwarrior_source_invalid") };
  const matches = arrayFrom(value).filter((item) => {
    const task = object(item);
    return task?.uuid === source.uuid && task?.project === source.project;
  }).map((item) => object(item)!).filter(Boolean);
  if (matches.length !== 1) return { valid: false, error: sanitizeCycleError("taskwarrior_match_invalid") };
  const pending = matches[0];
  if (pending.status !== "pending") return { valid: false, error: sanitizeCycleError("taskwarrior_not_pending") };
  return { valid: true, source, matches, pending };
}

export const parseJiraTransitions = parseJiraTracker;
export const parseTaskwarriorExport = parseTaskwarriorTracker;
