/** Pure cycle parsing, state reduction, evidence, and tracker-shape helpers. */

import {
  hasMatchingCyclePhaseSettlement,
  validateCyclePhaseExecution,
  type CyclePhaseExecution,
  type CyclePhaseSettlement,
} from "./ima-cycle-phase.ts";
import {
  normalizeLifecycleIdentity,
  normalizeLifecycleRecordKey,
  type LifecycleIdentity,
} from "./ima-lifecycle.ts";
import { verifyQdrantLifecycleRecord } from "./qdrant-lifecycle-record.ts";
import { normalizeLifecycleProvider, type LifecycleProviderName } from "./ima-lifecycle-selection.ts";

export const CYCLE_SCHEMA_VERSION = 1;
export const CYCLE_ENTRY = "ima-cycle-state";
export const IMA_PROJECT = "ima-pi";
export const CYCLE_REVIEW_CAP_DEFAULT = 5;
export const CYCLE_REVIEW_CAP_MIN = 0;
export const CYCLE_REVIEW_CAP_MAX = 10;

export const CYCLE_MODES = ["guided", "autonomous"] as const;
export type CycleMode = typeof CYCLE_MODES[number];

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
  | { type: "taskwarrior"; project: string; uuid: string }
  | { type: "plane"; workspace: string; project: string; sequenceId: number };

export type ApprovedPlanReference = {
  artifactId: string;
  recordKey: string;
  contentHash: string;
  approvedAt: string;
};

export type CycleEvidence = {
  phase: CyclePhase;
  outcome: string;
  marker: string;
  toolCallId: string;
  artifactId: string | null;
  recordKey: string | null;
  timestamp: string;
  approvedPlan?: ApprovedPlanReference;
};

export type LifecycleSearchSelection = {
  lifecycleKey: string;
  phase: CyclePhase;
  jiraKey: string;
  taskwarriorProject?: string;
  taskwarriorUuid: string;
  planeWorkspace?: string;
  planeWorkItem?: string;
};

type DocumentLifecycleEvidence = {
  artifactId: string;
  recordKey: string;
  artifact: string;
  phase: "document" | "closeout";
  identity: LifecycleIdentity;
  createdAt: string;
};

type HistoricalDocumentEvidence = {
  identity: LifecycleIdentity;
  createdAt: string;
};

export type LifecycleSearchRecord = {
  artifactId: string | null;
  recordKey: string | null;
  artifact: string;
  verified: boolean;
  createdAt?: string;
  documentEvidence?: DocumentLifecycleEvidence;
  historicalDocument?: HistoricalDocumentEvidence;
  documentEvidenceInvalid?: boolean;
};

export type LifecycleSearchParse =
  | { valid: true; records: LifecycleSearchRecord[] }
  | { valid: false; records: [] };

export type CycleLifecycleReconciliation =
  | { ok: true; state: CycleState; reconciled: boolean; artifactId: string | null; recordKey: string | null }
  | { ok: false; state: CycleState | null; error: ReturnType<typeof sanitizeCycleError>; artifactId: string | null; recordKey: string | null };

export type CycleLifecycleReconciliationOptions = {
  timestamp?: string;
  executionSettlement?: CyclePhaseSettlement;
};

export type CycleState = {
  schemaVersion: 1;
  source: CycleSource;
  lifecycleKey: string;
  implementationMode: CycleImplementationMode;
  mode: CycleMode;
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
  lifecycleProvider?: LifecycleProviderName;
  lifecycleProviderAttemptId?: string;
  execution?: CyclePhaseExecution;
};

export type CycleCommand =
  | { command: "start"; source: CycleSource; reviewCap?: number; implementationMode?: CycleImplementationMode; mode?: CycleMode }
  | { command: "status" }
  | { command: "stop"; acknowledge: boolean }
  | { command: "resume"; mode?: CycleMode }
  | { command: "reply"; answer: string }
  | { command: "close"; commitPrep: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const PROJECT = /^[\w.-]+$/;
const PLANE_WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PLANE_PROJECT = /^[A-Z][A-Z0-9_]*$/;
const PLANE_WORK_ITEM = /^([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;
const PLANE_REFERENCE = /^plane:([A-Za-z0-9][A-Za-z0-9._~-]*):([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;
const PLANE_IDENTITY_MAXIMUM = 128;
const MAX_PLANE_STATES = 1_000;
const PLANE_STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
type PlaneStateGroup = typeof PLANE_STATE_GROUPS[number];
const LIFECYCLE_KEY = /^[^\r\n]{1,512}$/;
const DISALLOWED_REPLY_CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;
const JIRA_URL = /^https:\/\/flccc\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)$/;
const CYCLE_MARKER = /<!--\s*ima-cycle outcome:\s*phase=(plan|implementation|test|review|resolution|rereview|document);\s*outcome=([A-Z_]+)\s*-->/g;
const HISTORICAL_CYCLE_MARKER_PREFIX = "ima-cycleoutcome:";
const HISTORICAL_DOCUMENT_MARKER = /^ {0,3}<!-- ima-cycle outcome: phase=document; outcome=(READY|BLOCKED) -->[ \t]*$/;
const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/;
const LIFECYCLE_VERIFICATION = /<!--\s*ima-lifecycle verification:\s*([\s\S]*?)\s*-->/g;
const LEGACY_LIFECYCLE_MARKER_FIELDS = [
  "lifecycle_key",
  "nonce",
  "phase",
  "jira_key",
  "taskwarrior_uuid",
  "outcome",
] as const;
const PLANE_LIFECYCLE_MARKER_FIELDS = [
  ...LEGACY_LIFECYCLE_MARKER_FIELDS.slice(0, 5),
  "plane_workspace",
  "plane_work_item",
  "outcome",
] as const;
const MAX_PHASE_ARTIFACT_LENGTH = 128_000;
const MAX_PERSISTED_ARTIFACT_LENGTH = 160_000;
const MAX_SEARCH_RECORDS = 32;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const boundedText = (value: unknown, maximum: number) => text(value).length > 0 && text(value).length <= maximum;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const nowIso = () => new Date().toISOString();
const timestamp = (value: unknown, fallback = nowIso()) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text(value)) ? text(value) : fallback;
const validTimestamp = (value: unknown) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text(value));
const cleanLine = (value: unknown, maximum = 512) => text(value).replace(/[\r\n]+/g, " ").replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, maximum);
const validRecordKey = (value: unknown) => Boolean(normalizeLifecycleRecordKey(value));
const optionalRecordKey = (value: unknown) => value === undefined || value === null || validRecordKey(value);

export function normalizeApprovedPlanReference(value: unknown): ApprovedPlanReference | null {
  const reference = object(value);
  const artifactId = typeof reference?.artifactId === "string" && UUID.test(reference.artifactId)
    ? reference.artifactId.toLowerCase()
    : null;
  const rawRecordKey = reference?.recordKey;
  const recordKey = normalizeLifecycleRecordKey(rawRecordKey);
  const contentHash = typeof reference?.contentHash === "string" && HASH.test(reference.contentHash)
    ? reference.contentHash.toLowerCase()
    : null;
  const approvedAt = typeof reference?.approvedAt === "string" && validTimestamp(reference.approvedAt)
    && reference.approvedAt === text(reference.approvedAt)
    ? reference.approvedAt
    : null;
  return reference
    && Object.keys(reference).length === 4
    && artifactId
    && recordKey
    && rawRecordKey === recordKey
    && contentHash
    && approvedAt
    ? { artifactId, recordKey, contentHash, approvedAt }
    : null;
}

const validPhase = (value: unknown): value is CyclePhase => CYCLE_PHASES.includes(value as CyclePhase);
const validStatus = (value: unknown): value is CycleStatus => CYCLE_STATUSES.includes(value as CycleStatus);
const validImplementationMode = (value: unknown): value is CycleImplementationMode => CYCLE_IMPLEMENTATION_MODES.includes(value as CycleImplementationMode);
const validCycleMode = (value: unknown): value is CycleMode => CYCLE_MODES.includes(value as CycleMode);
const validOutcome = (phase: CyclePhase, value: unknown) => typeof value === "string" && CYCLE_PHASE_OUTCOMES[phase].includes(value);
const planeWorkItemIdentifier = (source: Extract<CycleSource, { type: "plane" }>) => `${source.project}-${source.sequenceId}`;
const planeCycleSource = (workspaceValue: unknown, projectValue: unknown, sequenceValue: unknown): Extract<CycleSource, { type: "plane" }> | null => {
  const workspace = text(workspaceValue);
  const project = text(projectValue);
  if (
    !PLANE_WORKSPACE.test(workspace)
    || !PLANE_PROJECT.test(project)
    || !boundedText(workspace, PLANE_IDENTITY_MAXIMUM)
    || !boundedText(project, PLANE_IDENTITY_MAXIMUM)
    || typeof sequenceValue !== "number"
    || !Number.isSafeInteger(sequenceValue)
    || sequenceValue < 1
  ) return null;

  const source = { type: "plane" as const, workspace, project, sequenceId: sequenceValue };
  return boundedText(planeWorkItemIdentifier(source), PLANE_IDENTITY_MAXIMUM)
    ? source
    : null;
};
const planeCycleSourceFromReference = (value: unknown) => {
  const match = PLANE_REFERENCE.exec(text(value));
  return match ? planeCycleSource(match[1], match[2], Number(match[3])) : null;
};
const planeCycleSourceFromWorkItem = (workspace: unknown, workItem: unknown) => {
  const match = PLANE_WORK_ITEM.exec(text(workItem));
  return match ? planeCycleSource(workspace, match[1], Number(match[2])) : null;
};
const planeCycleSourceFromBrowseUrl = (value: unknown) => {
  const raw = text(value);
  const match = /^https:\/\/[^\s/\\?#@]+\/([^/\s\\?#]+)\/browse\/([^/\s\\?#]+)$/.exec(raw);
  if (!match) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
  ) return null;

  return planeCycleSourceFromWorkItem(match[1], match[2]);
};
const validPlaneLifecycleIdentity = (workspace: unknown, workItem: unknown) => {
  const normalizedWorkspace = text(workspace);
  const normalizedWorkItem = text(workItem);
  if (!normalizedWorkspace && !normalizedWorkItem) return true;
  return Boolean(planeCycleSourceFromWorkItem(normalizedWorkspace, normalizedWorkItem));
};
const isPlaneStateGroup = (value: unknown): value is PlaneStateGroup =>
  PLANE_STATE_GROUPS.includes(value as PlaneStateGroup);

export function sanitizeCycleError(code: string, _value?: unknown) {
  return { code, message: `Cycle integration failed: ${code}.` };
}

export function cycleSourceReference(source: CycleSource): string {
  if (source.type === "jira") return source.key;
  if (source.type === "taskwarrior") return `taskwarrior ${source.project} ${source.uuid}`;
  return `plane:${source.workspace}:${planeWorkItemIdentifier(source)}`;
}

export function cycleLifecycleKey(source: CycleSource): string {
  if (source.type === "jira") return `${IMA_PROJECT}:jira:${source.key}`;
  if (source.type === "taskwarrior") return `${IMA_PROJECT}:taskwarrior:${source.project}:${source.uuid}`;
  return `${IMA_PROJECT}:plane:${source.workspace}:${planeWorkItemIdentifier(source)}`;
}

export function normalizeCycleSource(value: unknown): CycleSource | null {
  if (typeof value === "string") {
    const raw = value.trim();
    const planeSource = planeCycleSourceFromReference(raw)
      ?? planeCycleSourceFromBrowseUrl(raw);
    if (planeSource) return planeSource;
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
  if (input.type === "plane" && onlyKeys(input, ["type", "workspace", "project", "sequenceId"])) {
    return planeCycleSource(input.workspace, input.project, input.sequenceId);
  }
  return null;
}

export function parseCycleCommand(input: unknown): CycleCommand | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  const reply = raw.match(/^(?:\/ima:cycle\s+)?reply(?:\s+([\s\S]+))?$/);
  if (reply) {
    const answer = reply[1]?.trim() ?? "";
    return answer && answer.length <= 8_192 && !DISALLOWED_REPLY_CONTROL.test(answer)
      ? { command: "reply", answer }
      : null;
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens[0] === "/ima:cycle") tokens.shift();
  if (!tokens.length) return null;
  const command = tokens.shift();
  if (command === "status" && tokens.length === 0) return { command: "status" };
  if (command === "resume") {
    if (tokens.length === 0) return { command: "resume" };
    if (tokens.length === 1 && tokens[0] === "--autonomous") return { command: "resume", mode: "autonomous" };
    if (tokens.length === 1 && tokens[0] === "--guided") return { command: "resume", mode: "guided" };
    if (tokens.length === 1 && tokens[0].startsWith("--mode=")) {
      const mode = tokens[0].slice("--mode=".length);
      return validCycleMode(mode) ? { command: "resume", mode } : null;
    }
    if (tokens.length === 2 && tokens[0] === "--mode" && validCycleMode(tokens[1])) return { command: "resume", mode: tokens[1] };
    return null;
  }
  if (command === "stop" && (tokens.length === 0 || (tokens.length === 1 && ["--ack", "--acknowledge"].includes(tokens[0])))) return { command: "stop", acknowledge: tokens.length === 1 };
  if (command === "close" && (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "--commit-prep"))) return { command: "close", commitPrep: tokens[0] === "--commit-prep" };
  if (command !== "start") return null;

  let reviewCap: number | undefined;
  let implementationMode: CycleImplementationMode | undefined;
  let mode: CycleMode | undefined;
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
    if (token === "--mode" || token.startsWith("--mode=")) {
      if (mode !== undefined) return null;
      const raw = token === "--mode" ? tokens[++index] : token.slice("--mode=".length);
      if (!validCycleMode(raw)) return null;
      mode = raw;
      continue;
    }
    const shorthandMode = token === "--autonomous" ? "autonomous" : token === "--guided" ? "guided" : null;
    if (shorthandMode) {
      if (mode !== undefined) return null;
      mode = shorthandMode;
      continue;
    }
    if (token.startsWith("--")) return null;
    sourceTokens.push(token);
  }

  const source = sourceTokens.length === 1
    ? normalizeCycleSource(sourceTokens[0])
    : sourceTokens.length === 3 && sourceTokens[0] === "taskwarrior"
      ? normalizeCycleSource({ type: "taskwarrior", project: sourceTokens[1], uuid: sourceTokens[2] })
      : sourceTokens.length === 3 && sourceTokens[0] === "plane"
        ? planeCycleSourceFromWorkItem(sourceTokens[1], sourceTokens[2])
        : null;
  return source
    ? { command: "start", source, ...(reviewCap === undefined ? {} : { reviewCap }), ...(implementationMode === undefined ? {} : { implementationMode }), ...(mode === undefined ? {} : { mode }) }
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
  if (typeof artifact !== "string" || artifact.length > MAX_PHASE_ARTIFACT_LENGTH) return { ok: false, error: sanitizeCycleError("phase_artifact_invalid") };
  const matches = [...artifact.matchAll(CYCLE_MARKER)];
  if (!matches.length) return { ok: false, error: sanitizeCycleError("phase_marker_missing") };
  if (matches.length !== 1) return { ok: false, error: sanitizeCycleError("phase_marker_ambiguous") };
  const phase = matches[0][1] as CyclePhase;
  const outcome = matches[0][2];
  if (!validPhase(phase) || !validOutcome(phase, outcome)) return { ok: false, error: sanitizeCycleError("phase_marker_invalid") };
  return { ok: true, phase, outcome, marker: matches[0][0] };
}

export function lifecycleTypeForPhase(phase: CyclePhase): CyclePhase {
  return phase;
}

export function resolvePhaseOutcome(artifact: unknown, expectedPhase: CyclePhase): { ok: true; phase: CyclePhase; outcome: string; marker: string } | { ok: false; error: ReturnType<typeof sanitizeCycleError> } {
  if (typeof artifact !== "string" || artifact.length > MAX_PHASE_ARTIFACT_LENGTH) return { ok: false, error: sanitizeCycleError("phase_artifact_invalid") };
  if (!validPhase(expectedPhase)) return { ok: false, error: sanitizeCycleError("phase_marker_invalid") };
  const matches = [...artifact.matchAll(CYCLE_MARKER)].filter((match) => match[1] === expectedPhase);
  if (!matches.length) return { ok: false, error: sanitizeCycleError("phase_marker_missing") };
  if (matches.some((match) => !validOutcome(expectedPhase, match[2]))) return { ok: false, error: sanitizeCycleError("phase_marker_invalid") };
  if (new Set(matches.map((match) => match[2])).size !== 1) return { ok: false, error: sanitizeCycleError("phase_marker_ambiguous") };
  const marker = matches[matches.length - 1];
  return { ok: true, phase: expectedPhase, outcome: marker[2], marker: marker[0] };
}

const searchResults = (envelope: unknown): unknown[] | null => {
  if (Array.isArray(envelope)) return envelope.slice(0, MAX_SEARCH_RECORDS);
  const input = object(envelope);
  if (!input) return null;
  const data = input.data;
  const nested = object(data);
  for (const candidate of [nested?.results, nested?.memories, input.results, input.memories, data]) {
    if (Array.isArray(candidate)) return candidate.slice(0, MAX_SEARCH_RECORDS);
  }
  return null;
};

const persistedContentValues = (value: unknown): string[] => {
  const values: string[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number) => {
    if (values.length >= MAX_SEARCH_RECORDS || depth > 4) return;
    if (typeof candidate === "string") { values.push(candidate); return; }
    if (Array.isArray(candidate)) { candidate.slice(0, 8).forEach((item) => visit(item, depth + 1)); return; }
    const entry = object(candidate);
    if (!entry || seen.has(entry)) return;
    seen.add(entry);
    for (const key of ["content", "detail", "artifact", "text", "body", "markdown"]) if (key in entry) visit(entry[key], depth + 1);
    for (const key of ["memory", "node", "document", "result", "data"]) if (key in entry) visit(entry[key], depth + 1);
  };
  visit(value, 0);
  return values;
};

const boundedJoined = (values: readonly string[], maximum: number) => {
  let result = "";
  for (const value of values) {
    if (result.length >= maximum) break;
    const separator = result ? "\n" : "";
    const remaining = maximum - result.length - separator.length;
    if (remaining <= 0) break;
    result += separator + value.slice(0, remaining);
  }
  return result.trim();
};

const searchArtifactId = (value: unknown, depth = 0, seen = new Set<object>()): string | null => {
  if (depth > 3) return null;
  const entry = object(value);
  if (!entry || seen.has(entry)) return null;
  seen.add(entry);
  for (const key of ["artifactId", "id", "memoryId"]) {
    const candidate = cleanLine(entry[key], 512);
    if (candidate) return candidate;
  }
  for (const key of ["memory", "node", "document", "result", "data"]) {
    const nested = searchArtifactId(entry[key], depth + 1, seen);
    if (nested) return nested;
  }
  return null;
};

const searchRecordKey = (value: unknown, depth = 0, seen = new Set<object>()): string | null => {
  if (depth > 3) return null;
  const entry = object(value);
  if (!entry || seen.has(entry)) return null;
  seen.add(entry);
  const candidate = normalizeLifecycleRecordKey(entry.recordKey);
  if (candidate) return candidate;
  for (const key of ["memory", "node", "document", "result", "data"]) {
    const nested = searchRecordKey(entry[key], depth + 1, seen);
    if (nested) return nested;
  }
  return null;
};

const verificationFields = (value: string): Map<string, string> | null => {
  const fields = new Map<string, string>();
  for (const field of value.split(";")) {
    const separator = field.indexOf("=");
    const key = field.slice(0, separator).trim();
    const fieldValue = field.slice(separator + 1);
    if (
      separator < 1
      || !key
      || fieldValue !== fieldValue.trim()
      || fields.has(key)
    ) return null;
    fields.set(key, fieldValue);
  }

  const expectedFields = fields.has("plane_workspace") || fields.has("plane_work_item")
    ? PLANE_LIFECYCLE_MARKER_FIELDS
    : LEGACY_LIFECYCLE_MARKER_FIELDS;
  return fields.size === expectedFields.length
    && expectedFields.every((field) => fields.has(field))
    ? fields
    : null;
};

const validLifecycleSearchSelection = (value: unknown): value is LifecycleSearchSelection => {
  const selection = object(value);
  return Boolean(
    selection
    && LIFECYCLE_KEY.test(text(selection.lifecycleKey))
    && validPhase(selection.phase)
    && text(selection.jiraKey).length <= 128
    && text(selection.taskwarriorProject).length <= 256
    && (!text(selection.taskwarriorProject) || PROJECT.test(text(selection.taskwarriorProject)))
    && text(selection.taskwarriorUuid).length <= 128
    && validPlaneLifecycleIdentity(selection.planeWorkspace, selection.planeWorkItem),
  );
};

const terminalLifecycleVerification = (content: string) => {
  const bounded = content.slice(0, MAX_PERSISTED_ARTIFACT_LENGTH);
  const match = [...bounded.matchAll(LIFECYCLE_VERIFICATION)].at(-1);
  if (!match || match.index === undefined || bounded.slice(match.index + match[0].length).trim()) return null;
  return match;
};

const verifiedLifecycleContent = (content: string, selection: LifecycleSearchSelection) => {
  const verification = terminalLifecycleVerification(content);
  if (!verification) return false;
  const fields = verificationFields(verification[1]);
  if (!fields) return false;
  const planeWorkspace = text(selection.planeWorkspace);
  const planeWorkItem = text(selection.planeWorkItem);
  const planeIdentityMatched = planeWorkspace
    ? fields.get("jira_key") === ""
      && fields.get("taskwarrior_uuid") === ""
      && fields.get("plane_workspace") === planeWorkspace
      && fields.get("plane_work_item") === planeWorkItem
    : !fields.has("plane_workspace") && !fields.has("plane_work_item");
  return fields.get("lifecycle_key") === selection.lifecycleKey
    && fields.get("phase") === lifecycleTypeForPhase(selection.phase)
    && fields.get("outcome") === "completed"
    && (!selection.jiraKey || fields.get("jira_key") === selection.jiraKey)
    && (!selection.taskwarriorUuid || fields.get("taskwarrior_uuid") === selection.taskwarriorUuid)
    && planeIdentityMatched;
};

const phaseArtifact = (content: string) => {
  let artifact = content;
  if (artifact.startsWith("---")) {
    const frontmatterEnd = artifact.indexOf("\n---", 3);
    if (frontmatterEnd >= 0) artifact = artifact.slice(frontmatterEnd + 4);
  }
  const lifecycleMarker = terminalLifecycleVerification(artifact);
  if (lifecycleMarker?.index !== undefined) artifact = artifact.slice(0, lifecycleMarker.index);
  return artifact.trim().slice(0, MAX_PHASE_ARTIFACT_LENGTH + 1);
};

const ownDataValue = (value: unknown, key: string): { value: unknown } | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor
      && !descriptor.get
      && !descriptor.set
      && descriptor.enumerable
      && Object.hasOwn(descriptor, "value")
      ? { value: descriptor.value }
      : null;
  } catch {
    return null;
  }
};

const HISTORICAL_QDRANT_RECORD_FIELDS = [
  "id",
  "recordKey",
  "project",
  "site",
  "repo",
  "lifecycleKey",
  "phase",
  "summary",
  "sourceRefs",
  "contentHash",
  "createdAt",
] as const;

const historicalQdrantRecord = (value: unknown): Record<string, unknown> | null => {
  const projected: Record<string, unknown> = {};
  for (const field of HISTORICAL_QDRANT_RECORD_FIELDS) {
    const entry = ownDataValue(value, field);
    if (!entry) return null;
    projected[field] = entry.value;
  }
  const detail = ownDataValue(value, "detail") ?? ownDataValue(value, "content");
  if (!detail) return null;
  return { ...projected, detail: detail.value };
};

const exactCreatedAt = (value: unknown) => {
  const createdAt = ownDataValue(value, "createdAt")?.value;
  return typeof createdAt === "string"
    && createdAt === text(createdAt)
    && validTimestamp(createdAt)
    && !Number.isNaN(Date.parse(createdAt))
    ? createdAt
    : null;
};

const historicalDocumentMarker = (artifact: string): {
  hasDocumentClaim: boolean;
  outcome: "READY" | "BLOCKED" | null;
} => {
  const claims: Array<{ index: number; document: boolean }> = [];
  const lines = artifact.split(/\r?\n/);
  let fence: { character: string; length: number } | null = null;
  let openComment: { index: number; content: string } | null = null;

  const claim = (index: number, content: string) => {
    const compact = content.replace(/\s+/g, "").toLowerCase();
    if (!compact.startsWith(HISTORICAL_CYCLE_MARKER_PREFIX)) return;
    claims.push({
      index,
      document: /\bphase=document(?:;|$)/.test(compact),
    });
  };
  const scan = (line: string, index: number, start = 0) => {
    let cursor = start;
    while (cursor < line.length) {
      const opening = line.indexOf("<!--", cursor);
      if (opening < 0) return;
      const closing = line.indexOf("-->", opening + 4);
      if (closing < 0) {
        openComment = { index, content: line.slice(opening + 4) };
        return;
      }
      claim(index, line.slice(opening + 4, closing));
      cursor = closing + 3;
    }
  };

  for (const [index, line] of lines.entries()) {
    if (openComment) {
      const closing = line.indexOf("-->");
      if (closing < 0) {
        openComment = { ...openComment, content: `${openComment.content}\n${line}` };
        continue;
      }
      claim(openComment.index, `${openComment.content}\n${line.slice(0, closing)}`);
      openComment = null;
      scan(line, index, closing + 3);
      continue;
    }
    if (fence) {
      const delimiter = MARKDOWN_FENCE.exec(line)?.[1] ?? "";
      if (
        delimiter.charAt(0) === fence.character
        && delimiter.length >= fence.length
        && line.trim().slice(delimiter.length).trim() === ""
      ) fence = null;
      continue;
    }
    if (/^ {0,3}>/.test(line)) continue;
    const opening = MARKDOWN_FENCE.exec(line)?.[1];
    if (opening) {
      fence = { character: opening.charAt(0), length: opening.length };
      continue;
    }
    if (!/^ {0,3}(?:\S|$)/.test(line)) continue;
    scan(line, index);
  }
  if (openComment) claim(openComment.index, openComment.content);

  const strict = claims.filter(({ index }) => HISTORICAL_DOCUMENT_MARKER.test(lines[index]));
  const lastNonBlank = lines.reduce(
    (last, line, index) => line.trim() ? index : last,
    -1,
  );
  const candidate = strict.length === 1 && claims.length === 1 && strict[0].index === lastNonBlank
    ? strict[0]
    : null;
  const outcome = candidate
    ? (HISTORICAL_DOCUMENT_MARKER.exec(lines[candidate.index])?.[1] as "READY" | "BLOCKED" | undefined)
    : undefined;
  return {
    hasDocumentClaim: claims.some((claim) => claim.document),
    outcome: outcome ?? null,
  };
};

const detachedLifecycleIdentity = (identity: LifecycleIdentity): LifecycleIdentity => ({
  project: identity.project,
  lifecycleKey: identity.lifecycleKey,
  lifecycleRootMemoryId: identity.lifecycleRootMemoryId,
  taskwarriorProject: identity.taskwarriorProject,
  taskwarriorTask: identity.taskwarriorTask,
  taskwarriorUuid: identity.taskwarriorUuid,
  jiraKey: identity.jiraKey,
  ...(identity.planeWorkspace && identity.planeWorkItem
    ? {
      planeWorkspace: identity.planeWorkspace,
      planeWorkItem: identity.planeWorkItem,
    }
    : {}),
  sourceRefs: [...identity.sourceRefs],
  priorArtifactIds: [...identity.priorArtifactIds],
});

const matchesDocumentLifecycleSelection = (
  identity: LifecycleIdentity,
  selection: LifecycleSearchSelection,
) => {
  if (identity.project !== IMA_PROJECT || identity.lifecycleKey !== selection.lifecycleKey) return false;
  const planeWorkspace = text(selection.planeWorkspace);
  const planeWorkItem = text(selection.planeWorkItem);
  if (planeWorkspace || planeWorkItem) {
    return identity.jiraKey === ""
      && identity.taskwarriorProject === ""
      && identity.taskwarriorTask === ""
      && identity.taskwarriorUuid === ""
      && identity.planeWorkspace === planeWorkspace
      && identity.planeWorkItem === planeWorkItem;
  }
  if (selection.jiraKey) {
    return identity.jiraKey === selection.jiraKey
      && identity.taskwarriorProject === ""
      && identity.taskwarriorTask === ""
      && identity.taskwarriorUuid === ""
      && !("planeWorkspace" in identity);
  }
  if (selection.taskwarriorUuid) {
    return identity.jiraKey === ""
      && identity.taskwarriorTask === selection.taskwarriorUuid
      && identity.taskwarriorUuid === selection.taskwarriorUuid
      && (!selection.taskwarriorProject || identity.taskwarriorProject === selection.taskwarriorProject)
      && !("planeWorkspace" in identity);
  }
  return false;
};

const isTrueFinalCloseout = (summary: string, artifact: string) =>
  summary.startsWith("Final lifecycle closeout:")
  || summary === "Cycle closeout verified after tracker completion."
  || /(?:^|\n)## Final Closeout(?:\r?\n|$)/.test(artifact)
  || /(?:^|\n)Closeout complete; no automatic follow-up phase\.(?:\r?\n|$)/.test(artifact);

const verifiedDocumentLifecycleEvidence = (
  verified: ReturnType<typeof verifyQdrantLifecycleRecord>,
): DocumentLifecycleEvidence | null => {
  const recordKey = normalizeLifecycleRecordKey(verified?.recordKey);
  const identity = normalizeLifecycleIdentity(verified?.identity);
  const createdAt = typeof verified?.createdAt === "string" && verified.createdAt === text(verified.createdAt)
    && validTimestamp(verified.createdAt)
    && !Number.isNaN(Date.parse(verified.createdAt))
    ? verified.createdAt
    : null;
  if (
    !verified
    || !UUID.test(verified.artifactId)
    || verified.artifactId !== verified.artifactId.toLowerCase()
    || !recordKey
    || recordKey !== verified.recordKey
    || !identity
    || !createdAt
    || (verified.phase !== "document" && verified.phase !== "closeout")
  ) return null;
  return {
    artifactId: verified.artifactId,
    recordKey,
    artifact: phaseArtifact(verified.artifact),
    phase: verified.phase,
    identity: detachedLifecycleIdentity(identity),
    createdAt,
  };
};

const invalidDocumentSearchRecord = (
  evidence: DocumentLifecycleEvidence | null = null,
): LifecycleSearchRecord => ({
  artifactId: evidence?.artifactId ?? null,
  recordKey: evidence?.recordKey ?? null,
  artifact: evidence?.artifact ?? "",
  verified: false,
  ...(evidence
    ? { createdAt: evidence.createdAt, documentEvidence: evidence }
    : {}),
  documentEvidenceInvalid: true,
});

const documentLifecycleSearchRecord = (
  record: unknown,
  selection: LifecycleSearchSelection,
): LifecycleSearchRecord => {
  const projected = historicalQdrantRecord(record);
  const verified = projected ? verifyQdrantLifecycleRecord({ record: projected }) : null;
  const evidence = verifiedDocumentLifecycleEvidence(verified);
  if (!verified || !evidence || !matchesDocumentLifecycleSelection(evidence.identity, selection)) {
    return invalidDocumentSearchRecord(evidence);
  }
  if (evidence.phase === "document") {
    return {
      artifactId: evidence.artifactId,
      recordKey: evidence.recordKey,
      artifact: evidence.artifact,
      verified: true,
      createdAt: evidence.createdAt,
      documentEvidence: evidence,
    };
  }

  const marker = historicalDocumentMarker(evidence.artifact);
  if (!marker.hasDocumentClaim) {
    return {
      artifactId: evidence.artifactId,
      recordKey: evidence.recordKey,
      artifact: evidence.artifact,
      verified: false,
      createdAt: evidence.createdAt,
      documentEvidence: evidence,
    };
  }
  if (marker.outcome === null || isTrueFinalCloseout(verified.summary, evidence.artifact)) {
    return invalidDocumentSearchRecord(evidence);
  }
  return {
    artifactId: evidence.artifactId,
    recordKey: evidence.recordKey,
    artifact: evidence.artifact,
    verified: true,
    createdAt: evidence.createdAt,
    documentEvidence: evidence,
    historicalDocument: {
      identity: detachedLifecycleIdentity(evidence.identity),
      createdAt: evidence.createdAt,
    },
  };
};

export function parseLifecycleSearchRecords(envelope: unknown, selectionValue: LifecycleSearchSelection): LifecycleSearchParse {
  const records = searchResults(envelope);
  if (!records || !validLifecycleSearchSelection(selectionValue)) return { valid: false, records: [] };
  if (selectionValue.phase === "document") {
    return {
      valid: true,
      records: records.map((record) => documentLifecycleSearchRecord(record, selectionValue)),
    };
  }
  return {
    valid: true,
    records: records.flatMap((record) => {
      const content = boundedJoined(persistedContentValues(record), MAX_PERSISTED_ARTIFACT_LENGTH);
      if (!content) return [];
      const createdAt = exactCreatedAt(record);
      return [{
        artifactId: searchArtifactId(record),
        recordKey: searchRecordKey(record),
        artifact: phaseArtifact(content),
        verified: verifiedLifecycleContent(content, selectionValue),
        ...(createdAt ? { createdAt } : {}),
      }];
    }),
  };
}

const reconciliationToolCallId = (record: LifecycleSearchRecord) => {
  if (record.artifactId) return `reconcile:${cleanLine(record.artifactId, 240)}`;
  if (record.recordKey) return `reconcile:key:${cleanLine(record.recordKey, 240)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < record.artifact.length; index += 1) {
    hash ^= record.artifact.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `reconcile:${(hash >>> 0).toString(36)}`;
};

const normalizedDocumentLifecycleEvidence = (
  value: unknown,
): DocumentLifecycleEvidence | null => {
  try {
    const evidence = object(value);
    const fields = ["artifactId", "recordKey", "artifact", "phase", "identity", "createdAt"];
    const keys = evidence ? Reflect.ownKeys(evidence) : [];
    if (
      !evidence
      || keys.length !== fields.length
      || keys.some((key) => typeof key !== "string" || !fields.includes(key))
      || !fields.every((field) => keys.includes(field))
    ) return null;

    const artifactId = ownDataValue(evidence, "artifactId")?.value;
    const recordKeyValue = ownDataValue(evidence, "recordKey")?.value;
    const artifact = ownDataValue(evidence, "artifact")?.value;
    const phase = ownDataValue(evidence, "phase")?.value;
    const identity = normalizeLifecycleIdentity(ownDataValue(evidence, "identity")?.value);
    const createdAt = ownDataValue(evidence, "createdAt")?.value;
    const recordKey = normalizeLifecycleRecordKey(recordKeyValue);
    if (
      typeof artifactId !== "string"
      || !UUID.test(artifactId)
      || artifactId !== artifactId.toLowerCase()
      || !recordKey
      || recordKey !== recordKeyValue
      || typeof artifact !== "string"
      || artifact !== artifact.trim()
      || artifact.length > MAX_PHASE_ARTIFACT_LENGTH + 1
      || (phase !== "document" && phase !== "closeout")
      || !identity
      || typeof createdAt !== "string"
      || createdAt !== text(createdAt)
      || !validTimestamp(createdAt)
      || Number.isNaN(Date.parse(createdAt))
    ) return null;
    return {
      artifactId,
      recordKey,
      artifact,
      phase,
      identity: detachedLifecycleIdentity(identity),
      createdAt,
    };
  } catch {
    return null;
  }
};

const matchesDocumentLifecycleSource = (
  identity: LifecycleIdentity,
  state: CycleState,
) => {
  if (identity.project !== IMA_PROJECT || identity.lifecycleKey !== state.lifecycleKey) return false;
  if (state.source.type === "jira") {
    return identity.jiraKey === state.source.key
      && identity.taskwarriorProject === ""
      && identity.taskwarriorTask === ""
      && identity.taskwarriorUuid === ""
      && !("planeWorkspace" in identity);
  }
  if (state.source.type === "taskwarrior") {
    return identity.jiraKey === ""
      && identity.taskwarriorProject === state.source.project
      && identity.taskwarriorTask === state.source.uuid
      && identity.taskwarriorUuid === state.source.uuid
      && !("planeWorkspace" in identity);
  }
  return identity.jiraKey === ""
    && identity.taskwarriorProject === ""
    && identity.taskwarriorTask === ""
    && identity.taskwarriorUuid === ""
    && identity.planeWorkspace === state.source.workspace
    && identity.planeWorkItem === planeWorkItemIdentifier(state.source);
};

const hasDocumentLifecycleLineage = (
  state: CycleState,
  evidence: DocumentLifecycleEvidence,
) => {
  if (!matchesDocumentLifecycleSource(evidence.identity, state)) return false;
  const requiredArtifactIds = new Set(state.evidence.flatMap((item) => [
    ...(item.artifactId ? [item.artifactId] : []),
    ...(item.approvedPlan ? [item.approvedPlan.artifactId] : []),
  ]));
  if (![...requiredArtifactIds].every((artifactId) => evidence.identity.priorArtifactIds.includes(artifactId))) {
    return false;
  }
  const approvedPlan = [...state.evidence]
    .reverse()
    .find((item) => item.phase === "plan" && item.outcome === "APPROVED" && item.approvedPlan)
    ?.approvedPlan;
  return !approvedPlan || Date.parse(evidence.createdAt) >= Date.parse(approvedPlan.approvedAt);
};

const newestDocumentRecord = <Record extends { record: LifecycleSearchRecord }>(
  records: readonly Record[],
): Record | null => {
  if (records.length === 0) return null;
  if (records.length === 1) return records[0];
  const dated = records.map((record) => ({
    record,
    createdAt: record.record.createdAt,
  }));
  if (dated.some(({ createdAt }) => !createdAt || !validTimestamp(createdAt) || Number.isNaN(Date.parse(createdAt)))) {
    return null;
  }
  const newest = Math.max(...dated.map(({ createdAt }) => Date.parse(createdAt!)));
  const newestRecords = dated.filter(({ createdAt }) => Date.parse(createdAt!) === newest);
  return newestRecords.length === 1 ? newestRecords[0].record : null;
};

export function reconcileCycleFromLifecycle(stateValue: unknown, recordsValue: unknown, options: CycleLifecycleReconciliationOptions = {}): CycleLifecycleReconciliation {
  const valid = validateCycleState(stateValue);
  if (!valid.valid) return { ok: false, state: null, error: valid.error, artifactId: null, recordKey: null };
  const state = valid.state;
  if (state.status !== "awaiting-evidence") return { ok: true, state, reconciled: false, artifactId: null, recordKey: null };
  const parsedRecords = (Array.isArray(recordsValue) ? recordsValue : []).flatMap((value) => {
    const record = object(value);
    if (state.phase === "document") {
      if (!record) return [invalidDocumentSearchRecord()];
      const documentEvidence = normalizedDocumentLifecycleEvidence(
        ownDataValue(record, "documentEvidence")?.value,
      );
      const verified = ownDataValue(record, "verified")?.value === true;
      const documentEvidenceInvalid = ownDataValue(record, "documentEvidenceInvalid")?.value === true
        || !documentEvidence
        || (!verified && documentEvidence.phase !== "closeout");
      return [{
        artifactId: documentEvidence?.artifactId ?? null,
        recordKey: documentEvidence?.recordKey ?? null,
        artifact: documentEvidence?.artifact ?? "",
        verified,
        ...(documentEvidence
          ? { createdAt: documentEvidence.createdAt, documentEvidence }
          : {}),
        ...(documentEvidenceInvalid ? { documentEvidenceInvalid: true } : {}),
      } satisfies LifecycleSearchRecord];
    }
    if (!record) return [];
    const createdAt = exactCreatedAt(record);
    return [{
      artifactId: searchArtifactId(record),
      recordKey: searchRecordKey(record),
      artifact: typeof record.artifact === "string" ? record.artifact.slice(0, MAX_PHASE_ARTIFACT_LENGTH + 1) : "",
      verified: record.verified === true,
      ...(createdAt ? { createdAt } : {}),
      ...(record.documentEvidenceInvalid === true ? { documentEvidenceInvalid: true } : {}),
    } satisfies LifecycleSearchRecord];
  });
  const malformedDocumentEvidence = state.phase === "document"
    ? parsedRecords.find((record) => record.documentEvidenceInvalid)
    : null;
  if (malformedDocumentEvidence) {
    return {
      ok: false,
      state,
      error: sanitizeCycleError("lifecycle_outcome_undetermined"),
      artifactId: malformedDocumentEvidence.artifactId,
      recordKey: malformedDocumentEvidence.recordKey,
    };
  }
  const invalidDocumentSource = state.phase === "document"
    ? parsedRecords.find((record) => record.documentEvidence
      && !matchesDocumentLifecycleSource(record.documentEvidence.identity, state))
    : null;
  if (invalidDocumentSource) {
    return {
      ok: false,
      state,
      error: sanitizeCycleError("lifecycle_outcome_undetermined"),
      artifactId: invalidDocumentSource.artifactId,
      recordKey: invalidDocumentSource.recordKey,
    };
  }
  let records = parsedRecords.filter((record) => record.verified);
  if (!records.length) return { ok: true, state, reconciled: false, artifactId: null, recordKey: null };
  if (state.execution) {
    if (state.execution.phase !== state.phase) return { ok: true, state, reconciled: false, artifactId: null, recordKey: null };
    const context = {
      schemaVersion: 1 as const,
      project: IMA_PROJECT,
      lifecycleKey: state.lifecycleKey,
      source: cycleSourceReference(state.source),
      phase: state.phase,
      dispatchId: state.execution.dispatchId,
    };
    if (!hasMatchingCyclePhaseSettlement({
      settlement: options.executionSettlement,
      execution: state.execution,
      context,
    })) {
      return { ok: false, state, error: sanitizeCycleError("cycle_execution_settlement_missing"), artifactId: null, recordKey: null };
    }
    records = records.filter((record) => hasMatchingCyclePhaseSettlement({
      settlement: options.executionSettlement,
      execution: state.execution,
      context,
      artifact: { artifactId: record.artifactId, recordKey: record.recordKey },
    }));
    if (!records.length) {
      return { ok: false, state, error: sanitizeCycleError("cycle_execution_settlement_mismatch"), artifactId: null, recordKey: null };
    }
  }
  const consumedArtifactIds = new Set(state.evidence.flatMap((item) => item.artifactId ? [cleanLine(item.artifactId, 512)] : []));
  const consumedRecordKeys = new Set(state.evidence.flatMap((item) => item.recordKey ? [item.recordKey] : []));
  const consumedToolCallIds = new Set(state.evidence.map((item) => cleanLine(item.toolCallId, 256)));
  const currentPhaseSeen = state.evidence.some((item) => item.phase === state.phase);
  const freshRecords: LifecycleSearchRecord[] = [];
  let unidentified: LifecycleSearchRecord | null = null;
  for (const record of records) {
    const toolCallId = reconciliationToolCallId(record);
    if (record.artifactId) {
      if (
        consumedArtifactIds.has(record.artifactId)
        || (record.recordKey !== null && consumedRecordKeys.has(record.recordKey))
        || consumedToolCallIds.has(toolCallId)
      ) continue;
      freshRecords.push(record);
      continue;
    }
    if (record.recordKey) {
      if (consumedRecordKeys.has(record.recordKey) || consumedToolCallIds.has(toolCallId)) continue;
      freshRecords.push(record);
      continue;
    }
    if (currentPhaseSeen) {
      unidentified ??= record;
      continue;
    }
    if (consumedToolCallIds.has(toolCallId)) continue;
    freshRecords.push(record);
  }
  if (unidentified) return { ok: false, state, error: sanitizeCycleError("lifecycle_outcome_undetermined"), artifactId: unidentified.artifactId, recordKey: unidentified.recordKey };
  if (!freshRecords.length) return { ok: true, state, reconciled: false, artifactId: null, recordKey: null };
  const invalidDocumentLineage = state.phase === "document"
    ? freshRecords.find((record) => record.documentEvidence
      && !hasDocumentLifecycleLineage(state, record.documentEvidence))
    : null;
  if (invalidDocumentLineage) {
    return {
      ok: false,
      state,
      error: sanitizeCycleError("lifecycle_outcome_undetermined"),
      artifactId: invalidDocumentLineage.artifactId,
      recordKey: invalidDocumentLineage.recordKey,
    };
  }
  const resolved = freshRecords.map((record) => ({ record, outcome: resolvePhaseOutcome(record.artifact, state.phase) }));
  const unresolved = resolved.find((value) => !value.outcome.ok);
  if (unresolved) return { ok: false, state, error: sanitizeCycleError("lifecycle_outcome_undetermined"), artifactId: unresolved.record.artifactId, recordKey: unresolved.record.recordKey };
  const outcomes = new Set(resolved.map(({ outcome }) => outcome.ok ? outcome.outcome : ""));
  const selected = state.phase === "document"
    ? newestDocumentRecord(resolved)
    : outcomes.size === 1 ? resolved[0] : null;
  if (!selected || !selected.outcome.ok) {
    const diagnostic = selected ?? resolved[0];
    return {
      ok: false,
      state,
      error: sanitizeCycleError("lifecycle_outcome_undetermined"),
      artifactId: diagnostic.record.artifactId,
      recordKey: diagnostic.record.recordKey,
    };
  }
  const reduced = reduceCycleState(state, {
    phase: selected.outcome.phase,
    outcome: selected.outcome.outcome,
    marker: selected.outcome.marker,
    artifactId: selected.record.artifactId,
    recordKey: selected.record.recordKey,
    toolCallId: reconciliationToolCallId(selected.record),
    timestamp: options.timestamp,
  }, options);
  if (!reduced.ok) return { ok: false, state: reduced.state, error: reduced.error, artifactId: selected.record.artifactId, recordKey: selected.record.recordKey };
  return { ok: true, state: reduced.state, reconciled: true, artifactId: selected.record.artifactId, recordKey: selected.record.recordKey };
}

const validateEvidence = (value: unknown): value is CycleEvidence => {
  const evidence = object(value);
  const approvedPlan = evidence?.approvedPlan === undefined
    ? null
    : normalizeApprovedPlanReference(evidence.approvedPlan);
  return Boolean(
    evidence
      && validPhase(evidence.phase)
      && validOutcome(evidence.phase, evidence.outcome)
      && boundedText(evidence.marker, 512)
      && boundedText(evidence.toolCallId, 256)
      && (evidence.artifactId === null || boundedText(evidence.artifactId, 512))
      && optionalRecordKey(evidence.recordKey)
      && validTimestamp(evidence.timestamp)
      && (evidence.approvedPlan === undefined || approvedPlan)
      && (!approvedPlan || (evidence.phase === "plan" && evidence.outcome === "APPROVED")),
  );
};

export function createCycleState(sourceValue: unknown, options: { lifecycleKey?: string; reviewCap?: number; implementationMode?: CycleImplementationMode; mode?: CycleMode; timestamp?: string; branchId?: string; lifecycleProvider?: LifecycleProviderName; lifecycleProviderAttemptId?: string } = {}): CycleState {
  const source = normalizeCycleSource(sourceValue);
  if (!source) throw new Error("cycle_source_invalid");
  const reviewCap = options.reviewCap ?? CYCLE_REVIEW_CAP_DEFAULT;
  if (!Number.isInteger(reviewCap) || reviewCap < CYCLE_REVIEW_CAP_MIN || reviewCap > CYCLE_REVIEW_CAP_MAX) throw new Error("review_cap_invalid");
  const implementationMode = options.implementationMode ?? "generic";
  if (!validImplementationMode(implementationMode)) throw new Error("implementation_mode_invalid");
  const mode = options.mode ?? "guided";
  if (!validCycleMode(mode)) throw new Error("cycle_mode_invalid");
  const lifecycleKey = text(options.lifecycleKey) || cycleLifecycleKey(source);
  if (!LIFECYCLE_KEY.test(lifecycleKey)) throw new Error("lifecycle_key_invalid");
  const lifecycleProvider = options.lifecycleProvider === undefined
    ? undefined
    : normalizeLifecycleProvider(options.lifecycleProvider);
  const lifecycleProviderAttemptId = options.lifecycleProviderAttemptId;
  if (
    lifecycleProvider === null
    || lifecycleProvider === undefined && lifecycleProviderAttemptId !== undefined
    || lifecycleProviderAttemptId !== undefined && !UUID.test(lifecycleProviderAttemptId)
  ) throw new Error("lifecycle_provider_invalid");
  return {
    schemaVersion: CYCLE_SCHEMA_VERSION,
    source,
    lifecycleKey,
    implementationMode,
    mode,
    phase: "plan",
    status: "awaiting-evidence",
    reviewAttempts: 0,
    reviewCap,
    evidence: [],
    blockers: [],
    updatedAt: timestamp(options.timestamp),
    ...(options.branchId && boundedText(options.branchId, 256) ? { branchId: options.branchId } : {}),
    ...(lifecycleProvider ? { lifecycleProvider } : {}),
    ...(lifecycleProviderAttemptId ? { lifecycleProviderAttemptId: lifecycleProviderAttemptId.toLowerCase() } : {}),
  };
}

export function validateCycleState(value: unknown): { valid: true; state: CycleState } | { valid: false; error: ReturnType<typeof sanitizeCycleError> } {
  const state = object(value);
  const implementationMode = state?.implementationMode === undefined ? "js" : state.implementationMode;
  const mode = state?.mode === undefined ? "guided" : state.mode;
  if (!state || state.schemaVersion !== CYCLE_SCHEMA_VERSION || !normalizeCycleSource(state.source) || !LIFECYCLE_KEY.test(text(state.lifecycleKey)) || !validImplementationMode(implementationMode) || !validCycleMode(mode) || !validPhase(state.phase) || !validStatus(state.status) || !Number.isInteger(state.reviewAttempts) || !Number.isInteger(state.reviewCap) || state.reviewCap < CYCLE_REVIEW_CAP_MIN || state.reviewCap > CYCLE_REVIEW_CAP_MAX || state.reviewAttempts < 0 || state.reviewAttempts > state.reviewCap || !Array.isArray(state.evidence) || !state.evidence.every(validateEvidence) || !Array.isArray(state.blockers) || !state.blockers.every((item) => typeof item === "string" && item.length <= 512) || !validTimestamp(state.updatedAt)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.stoppedAt !== undefined && !validTimestamp(state.stoppedAt)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.stoppedPhase !== undefined && !validPhase(state.stoppedPhase)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.trackerClosed !== undefined && typeof state.trackerClosed !== "boolean") return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.branchId !== undefined && !boundedText(state.branchId, 256)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  const lifecycleProvider = state.lifecycleProvider === undefined
    ? undefined
    : normalizeLifecycleProvider(state.lifecycleProvider);
  const lifecycleProviderAttemptId = state.lifecycleProviderAttemptId;
  if (
    lifecycleProvider === null
    || lifecycleProvider === undefined && lifecycleProviderAttemptId !== undefined
    || lifecycleProviderAttemptId !== undefined && (typeof lifecycleProviderAttemptId !== "string" || !UUID.test(lifecycleProviderAttemptId))
  ) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  if (state.execution !== undefined && !validateCyclePhaseExecution(state.execution)) return { valid: false, error: sanitizeCycleError("cycle_state_invalid") };
  const source = normalizeCycleSource(state.source)!;
  const duplicateToolCall = new Set<string>();
  for (const evidence of state.evidence) {
    if (duplicateToolCall.has(evidence.toolCallId)) return { valid: false, error: sanitizeCycleError("cycle_evidence_duplicate") };
    duplicateToolCall.add(evidence.toolCallId);
  }
  return {
    valid: true,
    state: {
      ...state,
      source,
      implementationMode,
      mode,
      evidence: state.evidence.map((item) => ({
        ...item,
        recordKey: item.recordKey === undefined ? null : item.recordKey,
      })),
      ...(state.execution ? { execution: structuredClone(state.execution) } : {}),
      ...(lifecycleProvider ? { lifecycleProvider } : {}),
      ...(lifecycleProviderAttemptId ? { lifecycleProviderAttemptId: lifecycleProviderAttemptId.toLowerCase() } : {}),
      blockers: state.blockers.map((item) => cleanLine(item)),
    } as CycleState,
  };
}

const lastEvidence = (state: CycleState) => state.evidence[state.evidence.length - 1] ?? null;

const hasPreReviewDefectLoop = (evidence: readonly CycleEvidence[]) => evidence.some((item, index) => {
  if (item.phase !== "test" || item.outcome !== "DEFECTS") return false;
  let prior = index - 1;
  while (evidence[prior]?.phase === "test" && evidence[prior]?.outcome === "BLOCKED") prior -= 1;
  return evidence[prior]?.phase === "implementation" && evidence[prior]?.outcome === "COMPLETED";
});

const isRepairLoopMarkerReuse = (state: CycleState, phase: CyclePhase) => {
  const previous = lastEvidence(state);
  if (!hasPreReviewDefectLoop(state.evidence)) return false;
  if (phase === "implementation") return previous?.phase === "test" && previous.outcome === "DEFECTS";
  return phase === "test" && previous?.phase === "implementation" && previous.outcome === "COMPLETED";
};

const isLegacyTestDefectBlock = (state: CycleState) => state.phase === "test"
  && state.status === "blocked"
  && state.blockers.length === 1
  && state.blockers[0] === "test:DEFECTS"
  && lastEvidence(state)?.phase === "test"
  && lastEvidence(state)?.outcome === "DEFECTS"
  && hasPreReviewDefectLoop(state.evidence);

const transition = (state: CycleState, outcome: string): { phase: CyclePhase; status: CycleStatus; reviewAttempts: number; blockers: string[] } => {
  if (state.phase === "test" && outcome === "DEFECTS") return { phase: "implementation", status: "awaiting-resume", reviewAttempts: state.reviewAttempts, blockers: [] };
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
  const rawRecordKey = input?.recordKey;
  const recordKey = rawRecordKey === undefined || rawRecordKey === null
    ? null
    : normalizeLifecycleRecordKey(rawRecordKey);
  const rawApprovedPlan = input?.approvedPlan;
  const approvedPlan = rawApprovedPlan === undefined
    ? null
    : normalizeApprovedPlanReference(rawApprovedPlan);
  if (extracted && !extracted.ok) return { ok: false, state, error: extracted.error };
  if (!validPhase(phase) || !validOutcome(phase, outcome) || !boundedText(marker, 512) || !boundedText(toolCallId, 256) || (rawRecordKey !== undefined && rawRecordKey !== null && recordKey === null) || (rawApprovedPlan !== undefined && (!approvedPlan || phase !== "plan" || outcome !== "APPROVED"))) return { ok: false, state, error: sanitizeCycleError("phase_evidence_invalid") };
  if (phase !== state.phase) return { ok: false, state, error: sanitizeCycleError("phase_evidence_out_of_order") };
  const previous = lastEvidence(state);
  const repeatableMarkerPhase = phase === "resolution"
    || phase === "rereview"
    || (previous?.phase === phase && previous.outcome === "BLOCKED")
    || isRepairLoopMarkerReuse(state, phase);
  if (state.evidence.some((item) => item.toolCallId === toolCallId || (!repeatableMarkerPhase && item.marker === marker))) return { ok: false, state, error: sanitizeCycleError("phase_evidence_duplicate") };
  const evidence: CycleEvidence = {
    phase,
    outcome,
    marker,
    toolCallId,
    artifactId: text(input?.artifactId) || null,
    recordKey,
    timestamp: timestamp(input?.timestamp, options.timestamp ?? nowIso()),
    ...(approvedPlan ? { approvedPlan } : {}),
  };
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

export function prepareCycleResume(stateValue: unknown): { ok: true; state: CycleState } | { ok: false; error: ReturnType<typeof sanitizeCycleError> } {
  const valid = validateCycleState(stateValue);
  if (!valid.valid) return { ok: false, error: valid.error };
  const state = valid.state;
  if (state.status === "awaiting-resume") return { ok: true, state };
  if (state.status === "stopped") return { ok: true, state: { ...state, status: "awaiting-resume", stoppedAt: undefined, stoppedPhase: undefined } };
  if (state.status === "blocked" && state.blockers.length === 1 && state.blockers[0] === `${state.phase}:BLOCKED`) {
    return { ok: true, state: { ...state, status: "awaiting-resume", blockers: [] } };
  }
  if (isLegacyTestDefectBlock(state)) {
    return { ok: true, state: { ...state, phase: "implementation", status: "awaiting-resume", blockers: [] } };
  }
  return { ok: false, error: sanitizeCycleError("cycle_resume_unavailable") };
}

export function buildResumeSource(stateValue: unknown): string | null {
  const valid = validateCycleState(stateValue);
  if (!valid.valid || valid.state.status !== "awaiting-resume") return null;
  const state = valid.state;
  const source = cycleSourceReference(state.source);
  const jiraKey = state.source.type === "jira" ? state.source.key : "none";
  const taskwarriorProject = state.source.type === "taskwarrior" ? state.source.project : "none";
  const taskwarriorUuid = state.source.type === "taskwarrior" ? state.source.uuid : "none";
  const planeWorkspace = state.source.type === "plane" ? state.source.workspace : "none";
  const planeWorkItem = state.source.type === "plane" ? planeWorkItemIdentifier(state.source) : "none";
  const priorArtifactIds = [...new Set(state.evidence.flatMap((item) => [
    ...(item.artifactId ? [cleanLine(item.artifactId)] : []),
    ...(item.approvedPlan ? [cleanLine(item.approvedPlan.artifactId)] : []),
  ]))];
  const priorArtifactRecordKeys = [...new Set(state.evidence.flatMap((item) => [
    ...(item.recordKey ? [cleanLine(item.recordKey)] : []),
    ...(item.approvedPlan ? [cleanLine(item.approvedPlan.recordKey)] : []),
  ]))];
  const orderedEvidence = state.evidence.flatMap((item) => [
    `phase: ${cleanLine(item.phase, 128)}`,
    `outcome: ${cleanLine(item.outcome, 128)}`,
    `timestamp: ${cleanLine(item.timestamp, 64)}`,
    `artifactId: ${item.artifactId === null ? "none" : cleanLine(item.artifactId)}`,
    `recordKey: ${item.recordKey === null ? "none" : cleanLine(item.recordKey)}`,
    `toolCallId: ${cleanLine(item.toolCallId)}`,
    ...(item.approvedPlan ? [
      `approvedPlanArtifactId: ${cleanLine(item.approvedPlan.artifactId)}`,
      `approvedPlanRecordKey: ${cleanLine(item.approvedPlan.recordKey)}`,
      `approvedPlanContentHash: ${cleanLine(item.approvedPlan.contentHash)}`,
      `approvedPlanApprovedAt: ${cleanLine(item.approvedPlan.approvedAt, 64)}`,
    ] : []),
  ]);
  const validOutcomes = CYCLE_PHASE_OUTCOMES[state.phase];
  const autonomousPlanDirectives = state.phase === "plan" && state.mode === "autonomous"
    ? [
      "autonomousPlan: true",
      "planSelfApproval: Self-approve (persist plan APPROVED without waiting for human approval) ONLY when this is exactly one bounded, conflict-free, low-risk delivery unit with no unresolved product/architecture/security/rollout/verification questions.",
      "planBlockEscape: Otherwise persist plan BLOCKED and stop. If multiple independent delivery units, recommend /ima:decompose; if unresolved questions remain, enumerate them.",
    ]
    : [];
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
    `planeWorkspace: ${cleanLine(planeWorkspace, 128)}`,
    `planeWorkItem: ${cleanLine(planeWorkItem, 128)}`,
    `reviewCap: ${cleanLine(String(state.reviewCap), 32)}`,
    `implementationMode: ${cleanLine(state.implementationMode, 32)}`,
    `lifecycleProvider: ${state.lifecycleProvider ?? "none"}`,
    `lifecycleProviderAttemptId: ${state.lifecycleProviderAttemptId ?? "none"}`,
    "orderedPhaseEvidence:",
    ...orderedEvidence,
    `priorArtifactIds: ${priorArtifactIds.length ? priorArtifactIds.join(", ") : "none"}`,
    `priorArtifactRecordKeys: ${priorArtifactRecordKeys.length ? priorArtifactRecordKeys.join(", ") : "none"}`,
    "Cycle dispatch contract (non-negotiable):",
    "cycleDispatch: true",
    `cyclePhase: ${state.phase}`,
    `validOutcomes: ${validOutcomes.join(", ")}`,
    ...autonomousPlanDirectives,
    "Persist this phase through ima_lifecycle with an explicit one-line summary. Finish the saved artifact with exactly one cycle outcome marker for cyclePhase using one validOutcomes value; do not include any other cycle outcome marker.",
    ...(state.lifecycleProvider && state.lifecycleProviderAttemptId
      ? ["Pass lifecycleProvider as provider and lifecycleProviderAttemptId as pinAttemptId to ima_lifecycle. They are the user-confirmed checkout-local pre-persistence authorization; do not substitute a provider or attempt ID."]
      : state.lifecycleProvider
        ? ["Pass lifecycleProvider as provider to ima_lifecycle. A verified checkout-local provider pin is authoritative; do not substitute a provider."]
        : []),
    `requiredMarker: <!-- ima-cycle outcome: phase=${state.phase}; outcome=<valid-outcome> -->`,
  ].join("\n");
}

export function buildCycleStatus(stateValue: unknown): { status: "invalid"; error: ReturnType<typeof sanitizeCycleError> } | { status: CycleStatus; source: string; phase: CyclePhase; nextPhase: CyclePhase | null; implementationMode: CycleImplementationMode; mode: CycleMode; reviewAttempts: number; reviewCap: number; evidence: Array<Pick<CycleEvidence, "phase" | "outcome" | "artifactId" | "recordKey" | "timestamp">>; blockers: string[] } {
  const valid = validateCycleState(stateValue);
  if (!valid.valid) return { status: "invalid", error: valid.error };
  const state = valid.state;
  return {
    status: state.status,
    source: cycleSourceReference(state.source),
    phase: state.phase,
    nextPhase: nextCyclePhase(state),
    implementationMode: state.implementationMode,
    mode: state.mode,
    reviewAttempts: state.reviewAttempts,
    reviewCap: state.reviewCap,
    evidence: state.evidence.map(({ phase, outcome, artifactId, recordKey, timestamp: at }) => ({ phase, outcome, artifactId, recordKey, timestamp: at })),
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
  const prior = state.evidence
    .filter((item) => item.artifactId || item.recordKey)
    .map((item) => `- phase: ${cleanLine(item.phase)}; outcome: ${cleanLine(item.outcome)}; artifactId: ${item.artifactId === null ? "none" : cleanLine(item.artifactId)}; recordKey: ${item.recordKey === null ? "none" : cleanLine(item.recordKey)}`);
  return [
    "# Source and approved outcome",
    `Cycle source: ${cycleSourceReference(state.source)}. Lifecycle key: ${cleanLine(state.lifecycleKey)}.`,
    "## Scope",
    "Coordinate one closed Jira, Taskwarrior, or Plane Story through the approved Pi-native lifecycle with explicit user-gated phase progression.",
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
    ...(prior.length ? prior : ["- Phase artifact references were not supplied by the lifecycle tools."]),
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

type PlaneTrackerWorkItem = {
  id: string;
  stateId: string;
};
type PlaneTrackerState = {
  id: string;
  group: PlaneStateGroup;
};

const exactText = (value: unknown) => typeof value === "string" ? value : "";
const successfulPlaneData = (value: unknown) => {
  const response = object(value);
  return response?.success === true ? object(response.data) : null;
};
const planeTrackerWorkItem = (value: unknown): PlaneTrackerWorkItem | null => {
  const workItem = object(value);
  const id = exactText(workItem?.id);
  const stateId = exactText(workItem?.stateId);
  return UUID.test(id) && UUID.test(stateId) ? { id, stateId } : null;
};
const planeTrackerState = (value: unknown): PlaneTrackerState | null => {
  const state = object(value);
  const id = exactText(state?.id);
  const group = exactText(state?.group);
  return UUID.test(id) && isPlaneStateGroup(group) ? { id, group } : null;
};
const invalidPlaneTracker = () => ({ valid: false as const, error: sanitizeCycleError("tracker_read_failed") });
const invalidPlaneMutation = () => ({ valid: false as const, error: sanitizeCycleError("tracker_close_failed") });

export function parsePlaneCurrentWorkItem(value: unknown, sourceValue: unknown): { valid: true; source: Extract<CycleSource, { type: "plane" }>; workItem: PlaneTrackerWorkItem } | ReturnType<typeof invalidPlaneTracker> {
  const source = normalizeCycleSource(sourceValue);
  if (!source || source.type !== "plane") return invalidPlaneTracker();

  const data = successfulPlaneData(value);
  const workItem = data ? planeTrackerWorkItem(data) : null;
  if (
    !data
    || !workItem
    || !UUID.test(exactText(data.projectId))
    || exactText(data.reference) !== cycleSourceReference(source)
    || exactText(data.workspace) !== source.workspace
    || exactText(data.identifier) !== planeWorkItemIdentifier(source)
    || data.sequenceId !== source.sequenceId
  ) return invalidPlaneTracker();

  return { valid: true, source, workItem };
}

export function parsePlaneWorkflowStates(value: unknown, sourceValue: unknown, workItemValue: unknown): { valid: true; source: Extract<CycleSource, { type: "plane" }>; workItem: PlaneTrackerWorkItem; currentState: PlaneTrackerState; completedState: PlaneTrackerState } | ReturnType<typeof invalidPlaneTracker> {
  const source = normalizeCycleSource(sourceValue);
  const workItem = planeTrackerWorkItem(workItemValue);
  if (!source || source.type !== "plane" || !workItem) return invalidPlaneTracker();

  const data = successfulPlaneData(value);
  const rawStates = data?.states;
  if (
    !data
    || exactText(data.reference) !== cycleSourceReference(source)
    || exactText(data.workItemId) !== workItem.id
    || !Array.isArray(rawStates)
    || rawStates.length === 0
    || rawStates.length > MAX_PLANE_STATES
  ) return invalidPlaneTracker();

  const states = rawStates.map(planeTrackerState);
  if (states.some((state) => state === null)) return invalidPlaneTracker();
  const verifiedStates = states as PlaneTrackerState[];
  if (new Set(verifiedStates.map((state) => state.id)).size !== verifiedStates.length) return invalidPlaneTracker();

  const currentStates = verifiedStates.filter((state) => state.id === workItem.stateId);
  if (currentStates.length !== 1) return invalidPlaneTracker();
  const currentState = currentStates[0];
  if (currentState.group === "completed") {
    return { valid: false, error: sanitizeCycleError("plane_tracker_already_completed") };
  }
  if (currentState.group === "cancelled") {
    return { valid: false, error: sanitizeCycleError("plane_tracker_cancelled") };
  }
  if (!(["backlog", "unstarted", "started"] as const).includes(currentState.group)) return invalidPlaneTracker();

  const completedStates = verifiedStates.filter((state) => state.group === "completed");
  if (completedStates.length === 0) {
    return { valid: false, error: sanitizeCycleError("plane_completed_state_missing") };
  }
  if (completedStates.length !== 1) {
    return { valid: false, error: sanitizeCycleError("plane_completed_state_ambiguous") };
  }

  return { valid: true, source, workItem, currentState, completedState: completedStates[0] };
}

export function parsePlaneStateMutation(value: unknown, sourceValue: unknown, workItemValue: unknown, selectedStateId: unknown): { valid: true; source: Extract<CycleSource, { type: "plane" }>; workItem: PlaneTrackerWorkItem; stateId: string } | ReturnType<typeof invalidPlaneMutation> {
  const source = normalizeCycleSource(sourceValue);
  const workItem = planeTrackerWorkItem(workItemValue);
  const stateId = exactText(selectedStateId);
  if (!source || source.type !== "plane" || !workItem || !UUID.test(stateId)) return invalidPlaneMutation();

  const data = successfulPlaneData(value);
  if (
    !data
    || exactText(data.reference) !== cycleSourceReference(source)
    || exactText(data.workItemId) !== workItem.id
    || exactText(data.stateId) !== stateId
  ) return invalidPlaneMutation();

  return { valid: true, source, workItem, stateId };
}

export const parseJiraTransitions = parseJiraTracker;
export const parseTaskwarriorExport = parseTaskwarriorTracker;
