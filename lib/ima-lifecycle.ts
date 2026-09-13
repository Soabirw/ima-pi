import { createHash } from "node:crypto";
import { utf8ByteLength } from "./qdrant-corpus.ts";

export const LIFECYCLE_PHASES = [
  "plan",
  "implementation",
  "test",
  "review",
  "resolution",
  "rereview",
  "document",
  "decision",
  "closeout",
] as const;

export const MAX_LIFECYCLE_REQUEST_CHARACTERS = 128_000;
export const MAX_LIFECYCLE_SUMMARY_BYTES = 2_000;
export const MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES = 160_000;
export const MAX_LIFECYCLE_RECORD_KEY_BYTES = 512;
export const MAX_LIFECYCLE_PROJECT_BYTES = 256;
export const MAX_LIFECYCLE_TASK_BYTES = 256;
export const MAX_LIFECYCLE_KEY_BYTES = 512;
export const MAX_LIFECYCLE_EXTERNAL_ID_BYTES = 128;
export const MAX_LIFECYCLE_REFERENCE_BYTES = 1_024;
export const MAX_LIFECYCLE_REFERENCES = 64;
export const PLANE_WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
export const PLANE_WORK_ITEM_PATTERN = /^([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;

export const isValidPlaneLifecycleIdentity = (
  workspace: unknown,
  workItem: unknown,
) => {
  if (typeof workspace !== "string" || typeof workItem !== "string") return false;
  const workItemMatch = PLANE_WORK_ITEM_PATTERN.exec(workItem);
  return Boolean(
    PLANE_WORKSPACE_PATTERN.test(workspace)
    && workItemMatch
    && Number.isSafeInteger(Number(workItemMatch[2]))
    && utf8ByteLength(workspace) <= MAX_LIFECYCLE_EXTERNAL_ID_BYTES
    && utf8ByteLength(workItem) <= MAX_LIFECYCLE_EXTERNAL_ID_BYTES,
  );
};

export type LifecyclePhase = typeof LIFECYCLE_PHASES[number];
type BaseLifecycleIdentity = {
  project: string;
  lifecycleKey: string;
  lifecycleRootMemoryId: string;
  taskwarriorProject: string;
  taskwarriorTask: string;
  taskwarriorUuid: string;
  jiraKey: string;
  sourceRefs: string[];
  priorArtifactIds: string[];
};

type CompletePlaneLifecycleIdentity = {
  planeWorkspace: string;
  planeWorkItem: string;
};

export type LifecycleIdentity = BaseLifecycleIdentity & (
  | { planeWorkspace?: never; planeWorkItem?: never }
  | CompletePlaneLifecycleIdentity
);

export type ValidLifecycleRequest = {
  valid: true;
  type: LifecyclePhase;
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
};

export type LifecycleRequestFailure = {
  valid: false;
  error: ReturnType<typeof sanitizeLifecycleError>;
};

export type PreparedLifecycleArtifact = {
  nonce: string;
  artifact: string;
  recordKey: string;
};

export type LifecycleStoreReceipt = {
  accepted: boolean;
  artifactId: string | null;
};

const IDENTITY_FIELDS = [
  "project",
  "lifecycleKey",
  "lifecycleRootMemoryId",
  "taskwarriorProject",
  "taskwarriorTask",
  "taskwarriorUuid",
  "jiraKey",
  "planeWorkspace",
  "planeWorkItem",
  "sourceRefs",
  "priorArtifactIds",
] as const;
const REQUEST_FIELDS = ["type", "identity", "summary", "artifact"] as const;
const REDACTED = "[redacted]";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMBEDDED_LIFECYCLE_FRONT_MATTER =
  /(?:^|\r?\n)---\r?\nlifecycle:\r?\n  project: '[^\r\n]*'\r?\n  lifecycle_key: '[^\r\n]*'/;
const DOCUMENT_CYCLE_OUTCOME_MARKER = /^[ \t]*<!-- ima-cycle outcome: phase=document; outcome=(?:READY|BLOCKED) -->[ \t]*\r?$/m;
const LIFECYCLE_ERROR_MESSAGES: Record<string, string> = {
  lifecycle_artifact_embeds_prior_artifact: "Lifecycle artifact embeds a prior artifact. Reference prior IDs in prior_artifact_ids or source_refs instead of pasting content.",
  closeout_document_phase_forbidden: "Documentation artifacts must use lifecycle phase document; closeout remains reserved for final closeout.",
  invalid_lifecycle_summary: "Lifecycle summary must be non-empty, control-character-safe, and at most 2,000 UTF-8 bytes.",
  lifecycle_artifact_too_large: "Serialized lifecycle artifact exceeds the approved 160,000 UTF-8-byte limit.",
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const clean = (value: unknown) => typeof value === "string"
  ? value.replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, (match) =>
    match.length < REDACTED.length ? "*".repeat(match.length) : REDACTED,
  )
  : "";

const hasPersistedLifecycleMarker = (artifact: string) => {
  const comments = artifact.match(/<!--[\s\S]*?-->/g) ?? [];
  return comments.some((comment) => {
    const nonce = /(?:^|[;\s])nonce=([^;\s]+)/.exec(comment)?.[1] ?? "";
    return comment.includes("ima-lifecycle verification:")
      && UUID_PATTERN.test(nonce)
      && comment.includes("outcome=completed");
  });
};

const embedsPriorLifecycleArtifact = (artifact: string) =>
  hasPersistedLifecycleMarker(artifact) || EMBEDDED_LIFECYCLE_FRONT_MATTER.test(artifact);

export function sanitizeLifecycleError(code: string, _value: unknown) {
  const message = Object.hasOwn(LIFECYCLE_ERROR_MESSAGES, code)
    ? LIFECYCLE_ERROR_MESSAGES[code]
    : `Lifecycle integration failed: ${code}.`;
  return { code, message };
}

const normalizeIdentityText = (
  value: unknown,
  maximumBytes: number,
  required = false,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || CONTROL_CHARACTER.test(normalized)) return null;
  return utf8ByteLength(normalized) <= maximumBytes ? normalized : null;
};

export const normalizeLifecycleRecordKey = (value: unknown): string | null => {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) return null;
  const normalized = value.trim();
  return normalized && utf8ByteLength(normalized) <= MAX_LIFECYCLE_RECORD_KEY_BYTES
    ? normalized
    : null;
};

const normalizeIdentityReferences = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > MAX_LIFECYCLE_REFERENCES) return null;
  const normalized = value.map((reference) =>
    normalizeIdentityText(reference, MAX_LIFECYCLE_REFERENCE_BYTES, true),
  );
  return normalized.some((reference) => reference === null)
    ? null
    : normalized as string[];
};

export function normalizeLifecycleIdentity(value: unknown): LifecycleIdentity | null {
  const identity = object(value);
  if (!identity || !onlyKeys(identity, IDENTITY_FIELDS)) return null;

  const project = normalizeIdentityText(identity.project, MAX_LIFECYCLE_PROJECT_BYTES, true);
  const lifecycleKey = normalizeIdentityText(identity.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES, true);
  const lifecycleRootMemoryId = normalizeIdentityText(identity.lifecycleRootMemoryId, MAX_LIFECYCLE_KEY_BYTES);
  const taskwarriorProject = normalizeIdentityText(identity.taskwarriorProject, MAX_LIFECYCLE_PROJECT_BYTES);
  const taskwarriorTask = normalizeIdentityText(identity.taskwarriorTask, MAX_LIFECYCLE_TASK_BYTES);
  const taskwarriorUuid = normalizeIdentityText(identity.taskwarriorUuid, MAX_LIFECYCLE_EXTERNAL_ID_BYTES);
  const jiraKey = normalizeIdentityText(identity.jiraKey, MAX_LIFECYCLE_EXTERNAL_ID_BYTES);
  const hasPlaneWorkspace = identity.planeWorkspace !== undefined;
  const hasPlaneWorkItem = identity.planeWorkItem !== undefined;
  const planeWorkspace = hasPlaneWorkspace
    ? normalizeIdentityText(identity.planeWorkspace, MAX_LIFECYCLE_EXTERNAL_ID_BYTES)
    : "";
  const planeWorkItem = hasPlaneWorkItem
    ? normalizeIdentityText(identity.planeWorkItem, MAX_LIFECYCLE_EXTERNAL_ID_BYTES)
    : "";
  const planeIdentity = hasPlaneWorkspace !== hasPlaneWorkItem
    || planeWorkspace === null
    || planeWorkItem === null
    ? null
    : !planeWorkspace && !planeWorkItem
      ? {}
      : planeWorkspace && planeWorkItem
        && isValidPlaneLifecycleIdentity(planeWorkspace, planeWorkItem)
        ? { planeWorkspace, planeWorkItem }
        : null;
  const sourceRefs = normalizeIdentityReferences(identity.sourceRefs);
  const priorArtifactIds = normalizeIdentityReferences(identity.priorArtifactIds);

  return project !== null
    && lifecycleKey !== null
    && lifecycleRootMemoryId !== null
    && taskwarriorProject !== null
    && taskwarriorTask !== null
    && taskwarriorUuid !== null
    && jiraKey !== null
    && planeIdentity !== null
    && sourceRefs !== null
    && priorArtifactIds !== null
    ? {
      project,
      lifecycleKey,
      lifecycleRootMemoryId,
      taskwarriorProject,
      taskwarriorTask,
      taskwarriorUuid,
      jiraKey,
      ...planeIdentity,
      sourceRefs: [...sourceRefs],
      priorArtifactIds: [...priorArtifactIds],
    }
    : null;
}

export const hasBoundedLifecycleRecordKey = (
  lifecycleKey: string,
  type: LifecyclePhase,
) => utf8ByteLength(lifecycleKey) + utf8ByteLength(type) + 14
  <= MAX_LIFECYCLE_RECORD_KEY_BYTES;

export function validateLifecycleRequest(value: unknown): ValidLifecycleRequest | LifecycleRequestFailure {
  const input = object(value);
  const type = text(input?.type);
  const rawArtifact = typeof input?.artifact === "string" ? input.artifact : "";
  if (
    !input
    || !onlyKeys(input, REQUEST_FIELDS)
    || !LIFECYCLE_PHASES.includes(type as LifecyclePhase)
    || rawArtifact.length > MAX_LIFECYCLE_REQUEST_CHARACTERS
  ) return { valid: false, error: sanitizeLifecycleError("invalid_lifecycle_request", value) };

  const identity = normalizeLifecycleIdentity(input.identity);
  if (
    !identity
    || !hasBoundedLifecycleRecordKey(identity.lifecycleKey, type as LifecyclePhase)
  ) return { valid: false, error: sanitizeLifecycleError("invalid_lifecycle_request", value) };

  const summary = clean(input.summary).trim();
  if (!summary || CONTROL_CHARACTER.test(summary) || utf8ByteLength(summary) > MAX_LIFECYCLE_SUMMARY_BYTES) {
    return { valid: false, error: sanitizeLifecycleError("invalid_lifecycle_summary", value) };
  }
  if (embedsPriorLifecycleArtifact(rawArtifact)) {
    return { valid: false, error: sanitizeLifecycleError("lifecycle_artifact_embeds_prior_artifact", value) };
  }

  const artifact = clean(rawArtifact).trim();
  if (!artifact || artifact.length > MAX_LIFECYCLE_REQUEST_CHARACTERS) {
    return { valid: false, error: sanitizeLifecycleError("invalid_lifecycle_request", value) };
  }
  return { valid: true, type: type as LifecyclePhase, identity, summary, artifact };
}

export const isCloseoutDocumentCycleArtifact = (
  type: unknown,
  artifact: unknown,
) => typeof type === "string"
  && type.trim() === "closeout"
  && typeof artifact === "string"
  && DOCUMENT_CYCLE_OUTCOME_MARKER.test(artifact);

export const validateLifecycleWriteRequest = (value: unknown):
  | ValidLifecycleRequest
  | LifecycleRequestFailure => {
  const request = validateLifecycleRequest(value);
  return request.valid && isCloseoutDocumentCycleArtifact(request.type, request.artifact)
    ? { valid: false, error: sanitizeLifecycleError("closeout_document_phase_forbidden", value) }
    : request;
};

export function buildLifecycleNonceMarker(input: {
  lifecycleKey: string;
  nonce: string;
  type: LifecyclePhase;
  jiraKey: string;
  taskwarriorUuid: string;
  planeWorkspace?: string;
  planeWorkItem?: string;
}) {
  const planeIdentity = input.planeWorkspace && input.planeWorkItem
    ? `; plane_workspace=${input.planeWorkspace}; plane_work_item=${input.planeWorkItem}`
    : "";
  return `<!-- ima-lifecycle verification: lifecycle_key=${input.lifecycleKey}; nonce=${input.nonce}; phase=${input.type}; jira_key=${input.jiraKey}; taskwarrior_uuid=${input.taskwarriorUuid}${planeIdentity}; outcome=completed -->`;
}

const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function buildLifecycleArtifactBody(input: {
  type: LifecyclePhase;
  identity: LifecycleIdentity;
  artifact: string;
}) {
  const identity = input.identity;
  const references = (key: string, values: string[]) => values.length
    ? `${key}:\n${values.map((value) => `    - ${quoted(value)}`).join("\n")}`
    : `${key}: []`;
  const planeIdentity = identity.planeWorkspace && identity.planeWorkItem
    ? `\n  plane_workspace: ${quoted(identity.planeWorkspace)}\n  plane_work_item: ${quoted(identity.planeWorkItem)}`
    : "";
  return `---\nlifecycle:\n  project: ${quoted(identity.project)}\n  lifecycle_key: ${quoted(identity.lifecycleKey)}\n  lifecycle_root_memory_id: ${quoted(identity.lifecycleRootMemoryId)}\n  taskwarrior_project: ${quoted(identity.taskwarriorProject)}\n  taskwarrior_task: ${quoted(identity.taskwarriorTask)}\n  taskwarrior_uuid: ${quoted(identity.taskwarriorUuid)}\n  jira_key: ${quoted(identity.jiraKey)}${planeIdentity}\n  ${references("source_refs", identity.sourceRefs)}\n  phase: ${quoted(input.type)}\n  ${references("prior_artifact_ids", identity.priorArtifactIds)}\n---\n\n${input.artifact}\n\n`;
}

const deterministicUuid = (value: string) => {
  const bytes = createHash("sha256").update(value, "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export function deriveLifecycleNonce(input: {
  type: LifecyclePhase;
  identity: LifecycleIdentity;
  artifact: string;
}) {
  return deterministicUuid(JSON.stringify({
    type: input.type,
    identity: input.identity,
    artifact: input.artifact,
  }));
}

export function buildLifecycleArtifact(input: {
  type: LifecyclePhase;
  identity: LifecycleIdentity;
  artifact: string;
  nonce: string;
}) {
  return `${buildLifecycleArtifactBody(input)}${buildLifecycleNonceMarker({
    lifecycleKey: input.identity.lifecycleKey,
    nonce: input.nonce,
    type: input.type,
    jiraKey: input.identity.jiraKey,
    taskwarriorUuid: input.identity.taskwarriorUuid,
    planeWorkspace: input.identity.planeWorkspace,
    planeWorkItem: input.identity.planeWorkItem,
  })}\n`;
}

export function buildLifecycleRecordKey(input: {
  lifecycleKey: string;
  type: LifecyclePhase;
  artifact: string;
}) {
  const digest = createHash("sha256").update(input.artifact, "utf8").digest("hex").slice(0, 12);
  return `${input.lifecycleKey}:${input.type}:${digest}`;
}

export function prepareLifecycleArtifact(input: ValidLifecycleRequest):
  | { valid: true; data: PreparedLifecycleArtifact }
  | LifecycleRequestFailure {
  if (!hasBoundedLifecycleRecordKey(input.identity.lifecycleKey, input.type)) {
    return { valid: false, error: sanitizeLifecycleError("invalid_lifecycle_request", input) };
  }
  const body = buildLifecycleArtifactBody(input);
  const markerLength = utf8ByteLength(buildLifecycleNonceMarker({
    lifecycleKey: input.identity.lifecycleKey,
    nonce: "00000000-0000-5000-8000-000000000000",
    type: input.type,
    jiraKey: input.identity.jiraKey,
    taskwarriorUuid: input.identity.taskwarriorUuid,
    planeWorkspace: input.identity.planeWorkspace,
    planeWorkItem: input.identity.planeWorkItem,
  })) + 1;
  if (utf8ByteLength(body) + markerLength > MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES) {
    return { valid: false, error: sanitizeLifecycleError("lifecycle_artifact_too_large", input) };
  }

  const nonce = deriveLifecycleNonce(input);
  const artifact = buildLifecycleArtifact({ ...input, nonce });
  if (utf8ByteLength(artifact) > MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES) {
    return { valid: false, error: sanitizeLifecycleError("lifecycle_artifact_too_large", input) };
  }
  const recordKey = buildLifecycleRecordKey({
    lifecycleKey: input.identity.lifecycleKey,
    type: input.type,
    artifact,
  });
  if (!normalizeLifecycleRecordKey(recordKey)) {
    return { valid: false, error: sanitizeLifecycleError("invalid_lifecycle_request", input) };
  }
  return { valid: true, data: { nonce, artifact, recordKey } };
}

const unmatchedLifecycleVerification = () => ({
  matched: false,
  lifecycleKeyMatched: false,
  nonceMatched: false,
  phaseMatched: false,
  sourceIdentityMatched: false,
  outcomeMatched: false,
  physicalShapeIgnored: true as const,
});

export function evaluateLifecycleArtifact(input: {
  artifact: unknown;
  lifecycleKey: string;
  nonce: string;
  type: LifecyclePhase;
  jiraKey: string;
  taskwarriorUuid: string;
  planeWorkspace?: string;
  planeWorkItem?: string;
}) {
  if (
    typeof input.artifact !== "string"
    || Boolean(input.planeWorkspace) !== Boolean(input.planeWorkItem)
  ) return unmatchedLifecycleVerification();
  const marker = buildLifecycleNonceMarker({
    lifecycleKey: input.lifecycleKey,
    nonce: input.nonce,
    type: input.type,
    jiraKey: input.jiraKey,
    taskwarriorUuid: input.taskwarriorUuid,
    planeWorkspace: input.planeWorkspace,
    planeWorkItem: input.planeWorkItem,
  });
  const markerIndex = input.artifact.lastIndexOf(marker);
  const matches = markerIndex >= 0
    && input.artifact.slice(markerIndex + marker.length).trim() === "";

  return matches
    ? {
      matched: true,
      lifecycleKeyMatched: true,
      nonceMatched: true,
      phaseMatched: true,
      sourceIdentityMatched: true,
      outcomeMatched: true,
      physicalShapeIgnored: true as const,
    }
    : unmatchedLifecycleVerification();
}

export function validateLifecycleStoreReceipt(value: unknown): LifecycleStoreReceipt {
  const result = object(value);
  const status = text(result?.status);
  const artifactId = text(result?.id);
  return (status === "stored" || status === "unchanged") && UUID_PATTERN.test(artifactId)
    ? { accepted: true, artifactId }
    : { accepted: false, artifactId: null };
}

export function deriveLifecycleResult(input: {
  type: LifecyclePhase;
  lifecycleKey: string;
  recordKey: string | null;
  receipt: LifecycleStoreReceipt;
  recall: ReturnType<typeof evaluateLifecycleArtifact>;
  error?: string;
}) {
  const completed = input.receipt.accepted && input.recall.matched && !input.error;
  return {
    schemaVersion: 1,
    status: completed ? "completed" as const : "failed" as const,
    phase: input.type,
    lifecycleKey: input.lifecycleKey,
    artifactId: input.receipt.artifactId,
    recordKey: input.receipt.accepted ? input.recordKey : null,
    receiptAccepted: input.receipt.accepted,
    semanticRecall: input.recall,
    error: completed
      ? null
      : sanitizeLifecycleError(
        input.error
          ?? (!input.receipt.accepted
            ? "corpus_receipt_invalid"
            : "corpus_semantic_completion_unverified"),
        "",
      ),
  };
}
