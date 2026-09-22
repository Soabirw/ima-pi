import { createHash } from "node:crypto";
import {
  normalizeLifecycleIdentity,
  normalizeLifecycleRecordKey,
  prepareLifecycleArtifact,
  validateLifecycleRequest,
  type LifecycleIdentity,
  type LifecyclePhase,
  type ValidLifecycleRequest,
} from "./ima-lifecycle.ts";
import {
  projectLifecycleProviderPin,
  projectLifecycleProviderReference,
  type LifecycleProviderPin,
} from "./ima-lifecycle-pin.ts";
import { markdownLifecycleCheckoutFingerprint } from "./markdown-lifecycle-record.ts";
import { serenaLifecycleMemoryName } from "./serena-lifecycle-record.ts";
import {
  normalizeLifecycleProvider,
  type LifecycleProviderName,
} from "./ima-lifecycle-selection.ts";
import {
  lifecycleContentBinding,
  MAX_LIFECYCLE_CONTENT_FINDINGS,
  screenLifecycleContent,
  type LifecycleContentFinding,
} from "./ima-lifecycle-security.ts";

export { containsRecognizedLifecycleContent as containsRecognizedLifecycleSecret } from "./ima-lifecycle-security.ts";

export type LifecycleRouteWriteState = "no-write" | "possible-write";

export type RoutedLifecycleRecord = {
  provider: LifecycleProviderName;
  artifactId: string;
  recordKey: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  summary: string;
  artifact: string;
  reference: Record<string, unknown>;
  createdAt: string | null;
};

export type LifecycleContentScreeningDiagnostic = {
  reason:
    | "record_summary_invalid"
    | "record_artifact_secret_bearer_placeholder"
    | "record_artifact_secret_bearer_value"
    | "record_artifact_secret_named"
    | "record_artifact_secret_private_key";
  findings: readonly LifecycleContentFinding[];
};

export type LifecycleContentWarningCandidate = {
  binding: string;
  findings: readonly LifecycleContentFinding[];
};

export type LifecycleContentWarningOptions = {
  allowWarnings?: boolean;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly LifecycleContentWarningCandidate[]) => void;
};

export type RoutedLifecyclePersistResult =
  | { status: "verified"; record: RoutedLifecycleRecord }
  | {
    status: "blocked";
    provider: LifecycleProviderName;
    code: string;
    writeState: LifecycleRouteWriteState;
    diagnostic?: LifecycleContentScreeningDiagnostic;
  };

export type RoutedLifecycleRecallResult =
  | { status: "verified"; provider: LifecycleProviderName; records: RoutedLifecycleRecord[] }
  | {
    status: "blocked";
    provider: LifecycleProviderName;
    code: string;
    readStep?: "authority" | "recall";
    readPhase?: LifecyclePhase;
    diagnostic?: LifecycleContentScreeningDiagnostic;
  };

export type LifecycleSourceIdentity = {
  project: string;
  lifecycleKey: string;
  taskwarriorProject: string;
  taskwarriorTask: string;
  taskwarriorUuid: string;
  jiraKey: string;
  sourceRefs: string[];
  planeWorkspace?: string;
  planeWorkItem?: string;
};

export type PinnedLifecycleLineage = {
  provider: LifecycleProviderName;
  initialReference: Record<string, unknown>;
  rootArtifactId: string;
  sourceIdentity: LifecycleSourceIdentity;
};

export type PinnedLifecycleLineageResult =
  | { status: "verified"; provider: LifecycleProviderName; lineage: PinnedLifecycleLineage }
  | {
    status: "blocked";
    provider: LifecycleProviderName;
    code: string;
    diagnostic?: LifecycleContentScreeningDiagnostic;
  };

export type LifecycleReadReference =
  | {
    schemaVersion: 1;
    fingerprint: string;
    nonce: string;
    contentHash: string;
  }
  | {
    schemaVersion: 1;
    fingerprint: string;
    logicalId: string;
    requestHash: string;
    canonicalHash: string;
  }
  | {
    schemaVersion: 1;
    fingerprint: string;
    checkoutFingerprint: string;
    receiptHash: string;
  }
  | {
    schemaVersion: 1;
    fingerprint: string;
    pageId: number;
    originFingerprint: string;
    pageHash: string;
    revisionCount: number;
    updatedAt: string;
  };

type LifecycleReadProof =
  | { nonce: string; contentHash: string }
  | { logicalId: string; requestHash: string; canonicalHash: string }
  | { checkoutFingerprint: string; receiptHash: string }
  | {
    pageId: number;
    originFingerprint: string;
    pageHash: string;
    revisionCount: number;
    updatedAt: string;
  };

export type LifecycleRoutingAdapter = {
  provider: LifecycleProviderName;
  persist: (
    request: ValidLifecycleRequest,
    signal?: AbortSignal,
  ) => Promise<RoutedLifecyclePersistResult>;
  persistPinned?: (
    request: ValidLifecycleRequest,
    initialReference: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<RoutedLifecyclePersistResult>;
  recall: (
    selection: {
      lifecycleKey: string;
      phase?: LifecyclePhase;
      limit: number;
      reference?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ) => Promise<RoutedLifecycleRecallResult>;
  get?: (
    reference: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<RoutedLifecyclePersistResult>;
  reconcile?: (
    reference: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<RoutedLifecyclePersistResult>;
};

export type LifecycleRouting = {
  adapters: Partial<Record<LifecycleProviderName, LifecycleRoutingAdapter>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SAFE_CODE = /^[a-z][a-z0-9_:-]{0,127}$/;
const MAX_LIFECYCLE_ARTIFACT_BYTES = 160_000;
const MAX_LIFECYCLE_RECALL_LIMIT = 50;
const MAX_LIFECYCLE_REFERENCES = 64;
const ROUTED_LIFECYCLE_RECORD_FIELDS = [
  "provider",
  "artifactId",
  "recordKey",
  "lifecycleKey",
  "phase",
  "summary",
  "artifact",
  "reference",
  "createdAt",
] as const;

const ownDataRecord = (value: unknown): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => typeof key !== "string") || keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value");
    })) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key as string].value]));
  } catch {
    return null;
  }
};

const ownDataArray = (value: unknown, maximum: number): unknown[] | null => {
  try {
    if (!Array.isArray(value) || value.length > maximum) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== value.length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || descriptors.length?.get
      || descriptors.length?.set
    ) return null;
    const entries: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return null;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
};

const safeCode = (value: unknown, fallback: string) =>
  typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;

const exactText = (value: unknown, maximum: number): string | null =>
  typeof value === "string"
  && value === value.trim()
  && value.length > 0
  && value.length <= maximum
  && Buffer.from(value, "utf8").toString("utf8") === value
  && Buffer.byteLength(value, "utf8") <= maximum
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value
    : null;

const canonicalArtifactId = (value: unknown): string | null => {
  const candidate = exactText(value, 36);
  return candidate && candidate === candidate.toLowerCase() && UUID.test(candidate)
    ? candidate
    : null;
};

const sourceIdentityValue = (identity: LifecycleIdentity): LifecycleSourceIdentity => ({
  project: identity.project,
  lifecycleKey: identity.lifecycleKey,
  taskwarriorProject: identity.taskwarriorProject,
  taskwarriorTask: identity.taskwarriorTask,
  taskwarriorUuid: identity.taskwarriorUuid,
  jiraKey: identity.jiraKey,
  sourceRefs: [...identity.sourceRefs],
  ...(identity.planeWorkspace && identity.planeWorkItem
    ? {
      planeWorkspace: identity.planeWorkspace,
      planeWorkItem: identity.planeWorkItem,
    }
    : {}),
});

export const projectLifecycleSourceIdentity = (
  value: unknown,
): LifecycleSourceIdentity | null => {
  const identity = normalizeLifecycleIdentity(value);
  return identity ? sourceIdentityValue(identity) : null;
};

const sourceIdentityMaterial = (source: LifecycleSourceIdentity) => JSON.stringify({
  project: source.project,
  lifecycleKey: source.lifecycleKey,
  taskwarriorProject: source.taskwarriorProject,
  taskwarriorTask: source.taskwarriorTask,
  taskwarriorUuid: source.taskwarriorUuid,
  jiraKey: source.jiraKey,
  planeWorkspace: source.planeWorkspace ?? "",
  planeWorkItem: source.planeWorkItem ?? "",
  sourceRefs: source.sourceRefs,
});

export const lifecycleSourceIdentityFingerprint = (
  source: LifecycleSourceIdentity,
) => createHash("sha256").update(sourceIdentityMaterial(source), "utf8").digest("hex");

export const sameLifecycleSourceIdentity = (
  left: LifecycleSourceIdentity,
  right: LifecycleSourceIdentity,
) => sourceIdentityMaterial(left) === sourceIdentityMaterial(right);

export const createLifecycleContinuationIdentity = (input: {
  sourceIdentity: LifecycleSourceIdentity;
  lifecycleRootMemoryId: unknown;
  priorArtifactIds: unknown;
}): LifecycleIdentity | null => normalizeLifecycleIdentity({
  project: input.sourceIdentity.project,
  lifecycleKey: input.sourceIdentity.lifecycleKey,
  lifecycleRootMemoryId: input.lifecycleRootMemoryId,
  taskwarriorProject: input.sourceIdentity.taskwarriorProject,
  taskwarriorTask: input.sourceIdentity.taskwarriorTask,
  taskwarriorUuid: input.sourceIdentity.taskwarriorUuid,
  jiraKey: input.sourceIdentity.jiraKey,
  ...(input.sourceIdentity.planeWorkspace && input.sourceIdentity.planeWorkItem
    ? {
      planeWorkspace: input.sourceIdentity.planeWorkspace,
      planeWorkItem: input.sourceIdentity.planeWorkItem,
    }
    : {}),
  sourceRefs: input.sourceIdentity.sourceRefs,
  priorArtifactIds: input.priorArtifactIds,
});

const lifecycleSeedPhase = (phase: LifecyclePhase) =>
  phase === "plan" || phase === "decision";

export const deriveLifecycleRoot = (input: {
  phase: LifecyclePhase;
  artifactId: unknown;
  lifecycleRootMemoryId: unknown;
}): string | null => {
  const root = input.lifecycleRootMemoryId;
  if (root === "") {
    return lifecycleSeedPhase(input.phase) ? canonicalArtifactId(input.artifactId) : null;
  }
  return canonicalArtifactId(root);
};

export const validateInitialLifecycleWriteRequest = (
  value: ValidLifecycleRequest,
): { valid: true } | { valid: false; code: string } => {
  if (lifecycleSeedPhase(value.type) && value.identity.lifecycleRootMemoryId === "") {
    return { valid: true };
  }
  return deriveLifecycleRoot({
    phase: value.type,
    artifactId: "00000000-0000-5000-8000-000000000000",
    lifecycleRootMemoryId: value.identity.lifecycleRootMemoryId,
  })
    ? { valid: true }
    : { valid: false, code: "lifecycle_initial_root_required" };
};

export const validateLifecycleContinuationRequest = (input: {
  lineage: PinnedLifecycleLineage;
  request: unknown;
}): { valid: true } | { valid: false; code: string } => {
  const value = ownDataRecord(input.request);
  const requestFields = ["type", "identity", "summary", "artifact"];
  const isPlainRequest = value
    && Object.keys(value).length === requestFields.length
    && requestFields.every((field) => Object.hasOwn(value, field));
  const isValidatedRequest = value
    && Object.keys(value).length === requestFields.length + 1
    && value.valid === true
    && requestFields.every((field) => Object.hasOwn(value, field));
  if (!value || !isPlainRequest && !isValidatedRequest) {
    return { valid: false, code: "lifecycle_lineage_request_invalid" };
  }
  const request = validateLifecycleRequest({
    type: value.type,
    identity: value.identity,
    summary: value.summary,
    artifact: value.artifact,
  });
  if (!request.valid) return { valid: false, code: "lifecycle_lineage_request_invalid" };
  const sourceIdentity = projectLifecycleSourceIdentity(request.identity);
  if (
    !sourceIdentity
    || !sameLifecycleSourceIdentity(sourceIdentity, input.lineage.sourceIdentity)
    || request.identity.lifecycleRootMemoryId !== input.lineage.rootArtifactId
  ) return { valid: false, code: "lifecycle_lineage_conflict" };
  return { valid: true };
};

type RoutedLifecycleRecordProjection =
  | { status: "verified"; record: RoutedLifecycleRecord }
  | {
    status: "blocked";
    code:
      | "artifact_missing"
      | "artifact_secret_bearer_placeholder"
      | "artifact_secret_bearer_value"
      | "artifact_secret_named"
      | "artifact_secret_private_key"
      | "artifact_too_large"
      | "artifact_utf8"
      | "created_at"
      | "identity"
      | "reference"
      | "structure"
      | "summary";
    phase?: LifecyclePhase;
    diagnostic?: LifecycleContentScreeningDiagnostic;
    warning?: true;
    warningBinding?: string;
  };

type ArtifactScreeningCode =
  | "artifact_secret_bearer_placeholder"
  | "artifact_secret_bearer_value"
  | "artifact_secret_named"
  | "artifact_secret_private_key";

const artifactScreeningCode = (
  screening: ReturnType<typeof screenLifecycleContent>,
): ArtifactScreeningCode => {
  const category = screening.findings[0]?.category;
  if (category === "private_key") return "artifact_secret_private_key";
  if (category === "synthetic_bearer") return "artifact_secret_bearer_placeholder";
  if (category === "credential_assignment" || category === "ambiguous_assignment") {
    return "artifact_secret_named";
  }
  return "artifact_secret_bearer_value";
};

const screeningDiagnosticForRecord = (
  record: RoutedLifecycleRecord,
): LifecycleContentScreeningDiagnostic | undefined => {
  const screening = screenLifecycleContent({ summary: record.summary, artifact: record.artifact });
  if (screening.tier === "allow") return undefined;
  if (screening.findings.some(({ field }) => field === "summary")) {
    return { reason: "record_summary_invalid", findings: screening.findings };
  }
  const code = artifactScreeningCode(screening);
  return {
    reason: code === "artifact_secret_private_key"
      ? "record_artifact_secret_private_key"
      : code === "artifact_secret_named"
        ? "record_artifact_secret_named"
        : code === "artifact_secret_bearer_placeholder"
          ? "record_artifact_secret_bearer_placeholder"
          : "record_artifact_secret_bearer_value",
    findings: screening.findings,
  };
};

const warningBindingForRecord = (record: RoutedLifecycleRecord) => lifecycleContentBinding({
  provider: record.provider,
  artifactId: record.artifactId,
  recordKey: record.recordKey,
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  summary: record.summary,
  artifact: record.artifact,
});

const warningAllowed = (
  binding: string | null,
  options: LifecycleContentWarningOptions | undefined,
) => Boolean(options?.allowWarnings || binding && options?.approvedWarningBindings?.includes(binding));

const captureWarningCandidates = (
  candidates: readonly LifecycleContentWarningCandidate[],
  options: LifecycleContentWarningOptions | undefined,
) => {
  if (!candidates.length || !options?.captureWarningBindings) return;
  try {
    options.captureWarningBindings(candidates);
  } catch {
    // Capture is advisory process-memory plumbing; a failure must not release content.
  }
};

const projectRoutedLifecycleRecordResult = (
  value: unknown,
  expectedProvider?: LifecycleProviderName,
  options?: LifecycleContentWarningOptions,
): RoutedLifecycleRecordProjection => {
  const record = ownDataRecord(value);
  if (!record) return { status: "blocked", code: "structure" };
  const keys = Object.keys(record);
  if (
    keys.length !== ROUTED_LIFECYCLE_RECORD_FIELDS.length
    || !ROUTED_LIFECYCLE_RECORD_FIELDS.every((field) => Object.hasOwn(record, field))
    || keys.some((field) => !ROUTED_LIFECYCLE_RECORD_FIELDS.includes(
      field as (typeof ROUTED_LIFECYCLE_RECORD_FIELDS)[number],
    ))
  ) return { status: "blocked", code: "structure" };
  const provider = normalizeLifecycleProvider(record.provider);
  const artifactId = exactText(record.artifactId, 36);
  const recordKey = normalizeLifecycleRecordKey(record.recordKey);
  const lifecycleKey = exactText(record.lifecycleKey, 512);
  const phase = record.phase as LifecyclePhase;
  const safePhase = typeof phase === "string"
    && ["plan", "implementation", "test", "review", "resolution", "rereview", "document", "decision", "closeout"].includes(phase)
    ? phase
    : undefined;
  const summary = exactText(record.summary, 2_000);
  const artifact = typeof record.artifact === "string" ? record.artifact : null;
  const artifactUtf8 = artifact !== null
    && Buffer.from(artifact, "utf8").toString("utf8") === artifact;
  const artifactBytes = artifactUtf8 ? Buffer.byteLength(artifact, "utf8") : null;
  const reference = provider
    ? projectLifecycleProviderReference(provider, record.reference)
    : null;
  const createdAt = record.createdAt === null
    ? null
    : exactText(record.createdAt, 64);
  if (
    !provider
    || expectedProvider && provider !== expectedProvider
    || !artifactId
    || !UUID.test(artifactId)
    || !recordKey
    || recordKey !== record.recordKey
    || !lifecycleKey
    || typeof phase !== "string"
    || !["plan", "implementation", "test", "review", "resolution", "rereview", "document", "decision", "closeout"].includes(phase)
  ) return { status: "blocked", code: "identity", ...(safePhase ? { phase: safePhase } : {}) };
  if (!summary) {
    return { status: "blocked", code: "summary", ...(safePhase ? { phase: safePhase } : {}) };
  }
  if (!artifact) return { status: "blocked", code: "artifact_missing", ...(safePhase ? { phase: safePhase } : {}) };
  if (!artifactUtf8) return { status: "blocked", code: "artifact_utf8", ...(safePhase ? { phase: safePhase } : {}) };
  if (artifactBytes === null || artifactBytes > MAX_LIFECYCLE_ARTIFACT_BYTES) {
    return { status: "blocked", code: "artifact_too_large", ...(safePhase ? { phase: safePhase } : {}) };
  }
  if (!reference) return { status: "blocked", code: "reference", ...(safePhase ? { phase: safePhase } : {}) };
  if (createdAt !== null && (!TIMESTAMP.test(createdAt) || Number.isNaN(Date.parse(createdAt)))) {
    return { status: "blocked", code: "created_at", ...(safePhase ? { phase: safePhase } : {}) };
  }
  const projectedRecord: RoutedLifecycleRecord = {
    provider,
    artifactId: artifactId.toLowerCase(),
    recordKey,
    lifecycleKey,
    phase,
    summary,
    artifact,
    reference,
    createdAt,
  };
  const contentScreening = screenLifecycleContent({ summary, artifact });
  if (contentScreening.tier === "block") {
    const diagnostic = screeningDiagnosticForRecord(projectedRecord);
    return {
      status: "blocked",
      code: diagnostic?.reason === "record_summary_invalid"
        ? "summary"
        : artifactScreeningCode(contentScreening),
      ...(safePhase ? { phase: safePhase } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
  const summaryScreening = screenLifecycleContent({ summary });
  const artifactScreening = screenLifecycleContent({ artifact });
  if (contentScreening.tier === "warn") {
    const binding = warningBindingForRecord(projectedRecord);
    if (!warningAllowed(binding, options)) {
      const summaryWarning = summaryScreening.tier === "warn";
      const artifactCode = artifactScreeningCode(artifactScreening);
      return {
        status: "blocked",
        code: summaryWarning ? "summary" : artifactCode,
        ...(safePhase ? { phase: safePhase } : {}),
        diagnostic: {
          reason: summaryWarning
            ? "record_summary_invalid"
            : artifactCode === "artifact_secret_private_key"
              ? "record_artifact_secret_private_key"
              : artifactCode === "artifact_secret_named"
                ? "record_artifact_secret_named"
                : artifactCode === "artifact_secret_bearer_placeholder"
                  ? "record_artifact_secret_bearer_placeholder"
                  : "record_artifact_secret_bearer_value",
          findings: contentScreening.findings,
        },
        ...(binding ? { warning: true as const, warningBinding: binding } : {}),
      };
    }
  }
  return { status: "verified", record: projectedRecord };
};

export const projectRoutedLifecycleRecord = (
  value: unknown,
  expectedProvider?: LifecycleProviderName,
  options?: LifecycleContentWarningOptions,
): RoutedLifecycleRecord | null => {
  const result = projectRoutedLifecycleRecordResult(value, expectedProvider, options);
  return result.status === "verified" ? result.record : null;
};

const parsedQuotedValue = (line: string, prefix: string): string | null => {
  if (!line.startsWith(prefix)) return null;
  const quoted = line.slice(prefix.length);
  if (quoted.length < 2 || quoted[0] !== "'" || quoted.at(-1) !== "'") return null;

  const encoded = quoted.slice(1, -1);
  let value = "";
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] !== "'") {
      value += encoded[index];
      continue;
    }
    if (encoded[index + 1] !== "'") return null;
    value += "'";
    index += 1;
  }
  return value;
};

const parsedReferenceList = (
  lines: readonly string[],
  start: number,
  field: "source_refs" | "prior_artifact_ids",
): { values: string[]; next: number } | null => {
  const empty = `  ${field}: []`;
  const heading = `  ${field}:`;
  if (lines[start] === empty) return { values: [], next: start + 1 };
  if (lines[start] !== heading) return null;

  const values: string[] = [];
  let next = start + 1;
  while (lines[next]?.startsWith("    - ")) {
    const value = parsedQuotedValue(lines[next], "    - ");
    if (value === null || values.length >= MAX_LIFECYCLE_REFERENCES) return null;
    values.push(value);
    next += 1;
  }
  return values.length > 0 ? { values, next } : null;
};

const parsedRoutedLifecycleArtifact = (artifact: string) => {
  const delimiter = "\n---\n\n";
  const markerPrefix = "\n<!-- ima-lifecycle verification: ";
  if (!artifact.startsWith("---\nlifecycle:\n")) return null;

  const delimiterIndex = artifact.indexOf(delimiter);
  const markerIndex = artifact.lastIndexOf(markerPrefix);
  if (delimiterIndex < 0 || markerIndex < delimiterIndex + delimiter.length) return null;

  const payloadWithSpacing = artifact.slice(delimiterIndex + delimiter.length, markerIndex + 1);
  if (!payloadWithSpacing.endsWith("\n\n")) return null;
  const payload = payloadWithSpacing.slice(0, -2);
  const lines = artifact.slice(0, delimiterIndex).split("\n");
  if (lines[0] !== "---" || lines[1] !== "lifecycle:") return null;

  let index = 2;
  const nextQuoted = (prefix: string) => {
    const value = parsedQuotedValue(lines[index] ?? "", prefix);
    index += 1;
    return value;
  };
  const project = nextQuoted("  project: ");
  const lifecycleKey = nextQuoted("  lifecycle_key: ");
  const lifecycleRootMemoryId = nextQuoted("  lifecycle_root_memory_id: ");
  const taskwarriorProject = nextQuoted("  taskwarrior_project: ");
  const taskwarriorTask = nextQuoted("  taskwarrior_task: ");
  const taskwarriorUuid = nextQuoted("  taskwarrior_uuid: ");
  const jiraKey = nextQuoted("  jira_key: ");
  if (
    project === null
    || lifecycleKey === null
    || lifecycleRootMemoryId === null
    || taskwarriorProject === null
    || taskwarriorTask === null
    || taskwarriorUuid === null
    || jiraKey === null
  ) return null;

  let planeWorkspace: string | undefined;
  let planeWorkItem: string | undefined;
  if (lines[index]?.startsWith("  plane_workspace: ")) {
    planeWorkspace = nextQuoted("  plane_workspace: ") ?? undefined;
    planeWorkItem = nextQuoted("  plane_work_item: ") ?? undefined;
    if (planeWorkspace === undefined || planeWorkItem === undefined) return null;
  } else if (lines[index]?.startsWith("  plane_work_item: ")) {
    return null;
  }

  const sourceRefs = parsedReferenceList(lines, index, "source_refs");
  if (!sourceRefs) return null;
  index = sourceRefs.next;
  const phase = nextQuoted("  phase: ");
  if (phase === null) return null;
  const priorArtifactIds = parsedReferenceList(lines, index, "prior_artifact_ids");
  if (!priorArtifactIds || priorArtifactIds.next !== lines.length) return null;

  return {
    phase,
    identity: {
      project,
      lifecycleKey,
      lifecycleRootMemoryId,
      taskwarriorProject,
      taskwarriorTask,
      taskwarriorUuid,
      jiraKey,
      ...(planeWorkspace && planeWorkItem ? { planeWorkspace, planeWorkItem } : {}),
      sourceRefs: sourceRefs.values,
      priorArtifactIds: priorArtifactIds.values,
    },
    payload,
  };
};

// Markdown receipts bind the logical key through the canonical content hash, not a native recordKey field.
const nativeReferenceMatchesRecordKey = (input: {
  provider: LifecycleProviderName;
  lifecycleKey: string;
  phase: LifecyclePhase;
  recordKey: string;
  contentHash: string;
  reference: Record<string, unknown>;
}) => input.provider === "markdown"
  ? input.recordKey === `${input.lifecycleKey}:${input.phase}:${input.contentHash.slice(0, 12)}`
  : input.reference.recordKey === input.recordKey;

export const verifyRoutedLifecycleReadRecord = (
  value: unknown,
  expected: {
    provider?: LifecycleProviderName;
    lifecycleKey?: string;
    phase?: LifecyclePhase;
  } = {},
  options?: LifecycleContentWarningOptions,
): RoutedLifecycleRecord | null => {
  try {
    const record = projectRoutedLifecycleRecord(value, expected.provider, options);
    if (
      !record
      || expected.lifecycleKey !== undefined && record.lifecycleKey !== expected.lifecycleKey
      || expected.phase !== undefined && record.phase !== expected.phase
    ) return null;

    const parsed = parsedRoutedLifecycleArtifact(record.artifact);
    if (!parsed) return null;
    const request = validateLifecycleRequest({
      type: parsed.phase,
      identity: parsed.identity,
      summary: record.summary,
      artifact: parsed.payload,
    });
    if (!request.valid) return null;

    const prepared = prepareLifecycleArtifact(request);
    const reference = projectLifecycleProviderReference(record.provider, record.reference);
    const contentHash = createHash("sha256").update(record.artifact, "utf8").digest("hex");
    const nativeContentHash = reference && nativeReferenceContentHash({
      provider: record.provider,
      artifactContentHash: contentHash,
      reference,
    });
    const artifactMatches = prepared.valid && (
      prepared.data.artifact === record.artifact
      || record.provider === "qdrant" && prepared.data.artifact.trim() === record.artifact
    );
    if (
      !prepared.valid
      || !artifactMatches
      || !reference
      || request.identity.lifecycleKey !== record.lifecycleKey
      || request.type !== record.phase
      || request.summary !== record.summary
      || prepared.data.recordKey !== record.recordKey
      || reference.lifecycleKey !== record.lifecycleKey
      || nativeReferencePhase(record.provider, reference) !== record.phase
      || reference.artifactId !== record.artifactId
      || !nativeReferenceMatchesRecordKey({
        provider: record.provider,
        lifecycleKey: record.lifecycleKey,
        phase: record.phase,
        recordKey: record.recordKey,
        contentHash,
        reference,
      })
      || !nativeContentHash
      || record.provider === "qdrant" && reference.nonce !== prepared.data.nonce
      || record.provider !== "qdrant" && record.artifactId !== prepared.data.nonce
    ) return null;

    return {
      ...record,
      reference: structuredClone(reference),
    };
  } catch {
    return null;
  }
};

const lifecycleReadRequest = (
  value: unknown,
  options?: LifecycleContentWarningOptions,
): ValidLifecycleRequest | null => {
  const record = verifyRoutedLifecycleReadRecord(value, {}, options);
  if (!record) return null;
  const parsed = parsedRoutedLifecycleArtifact(record.artifact);
  if (!parsed) return null;
  const request = validateLifecycleRequest({
    type: parsed.phase,
    identity: parsed.identity,
    summary: record.summary,
    artifact: parsed.payload,
  });
  return request.valid ? request : null;
};

export const lifecycleReadSourceIdentityFingerprint = (
  value: unknown,
): string | null => {
  const request = lifecycleReadRequest(value);
  const sourceIdentity = request && projectLifecycleSourceIdentity(request.identity);
  return sourceIdentity ? lifecycleSourceIdentityFingerprint(sourceIdentity) : null;
};

const QDRANT_READ_REFERENCE_FIELDS = [
  "schemaVersion",
  "fingerprint",
  "nonce",
  "contentHash",
] as const;
const SERENA_READ_REFERENCE_FIELDS = [
  "schemaVersion",
  "fingerprint",
  "logicalId",
  "requestHash",
  "canonicalHash",
] as const;
const MARKDOWN_READ_REFERENCE_FIELDS = [
  "schemaVersion",
  "fingerprint",
  "checkoutFingerprint",
  "receiptHash",
] as const;
const BOOKSTACK_READ_REFERENCE_FIELDS = [
  "schemaVersion",
  "fingerprint",
  "pageId",
  "originFingerprint",
  "pageHash",
  "revisionCount",
  "updatedAt",
] as const;
const LIFECYCLE_READ_PHASES = new Set<LifecyclePhase>([
  "plan",
  "implementation",
  "test",
  "review",
  "resolution",
  "rereview",
  "document",
  "decision",
  "closeout",
]);

const exactReadUuid = (value: unknown): string | null => canonicalArtifactId(value);

const exactReadHash = (value: unknown): string | null => {
  const candidate = exactText(value, 64);
  return candidate && HASH.test(candidate) ? candidate : null;
};

// BookStack's strict locator encodes its phase in pageSlug rather than a standalone field.
const nativeReferencePhase = (
  provider: LifecycleProviderName,
  reference: Record<string, unknown>,
): LifecyclePhase | null => {
  const candidate = provider === "bookstack"
    ? /^([a-z]+)-/.exec(
      typeof reference.pageSlug === "string" ? reference.pageSlug : "",
    )?.[1]
    : reference.phase;
  return typeof candidate === "string" && LIFECYCLE_READ_PHASES.has(candidate as LifecyclePhase)
    ? candidate as LifecyclePhase
    : null;
};

const nativeReferenceContentHash = (input: {
  provider: LifecycleProviderName;
  artifactContentHash: string;
  reference: Record<string, unknown>;
}) => {
  const contentHash = exactReadHash(input.reference.contentHash);
  return contentHash && (
    input.provider === "qdrant" || contentHash === input.artifactContentHash
  ) ? contentHash : null;
};

const exactReadTimestamp = (value: unknown): string | null => {
  const candidate = exactText(value, 1_024);
  return candidate && TIMESTAMP.test(candidate) && !Number.isNaN(Date.parse(candidate))
    ? candidate
    : null;
};

const exactReadReferenceFields = (
  value: Record<string, unknown>,
  fields: readonly string[],
) => Object.keys(value).length === fields.length
  && fields.every((field) => Object.hasOwn(value, field));

const sameLifecycleReadReferenceValue = (
  left: LifecycleReadReference,
  right: LifecycleReadReference,
) => JSON.stringify(left) === JSON.stringify(right);

export const projectLifecycleReadReference = (
  value: unknown,
): LifecycleReadReference | null => {
  const reference = ownDataRecord(value);
  if (!reference || reference.schemaVersion !== 1) return null;
  const fingerprint = exactReadHash(reference.fingerprint);
  if (!fingerprint) return null;

  if (exactReadReferenceFields(reference, QDRANT_READ_REFERENCE_FIELDS)) {
    const nonce = exactReadUuid(reference.nonce);
    const contentHash = exactReadHash(reference.contentHash);
    return nonce && contentHash ? { schemaVersion: 1, fingerprint, nonce, contentHash } : null;
  }
  if (exactReadReferenceFields(reference, SERENA_READ_REFERENCE_FIELDS)) {
    const logicalId = exactReadHash(reference.logicalId);
    const requestHash = exactReadHash(reference.requestHash);
    const canonicalHash = exactReadHash(reference.canonicalHash);
    return logicalId && requestHash && canonicalHash
      ? { schemaVersion: 1, fingerprint, logicalId, requestHash, canonicalHash }
      : null;
  }
  if (exactReadReferenceFields(reference, MARKDOWN_READ_REFERENCE_FIELDS)) {
    const checkoutFingerprint = exactReadHash(reference.checkoutFingerprint);
    const receiptHash = exactReadHash(reference.receiptHash);
    return checkoutFingerprint && receiptHash
      ? { schemaVersion: 1, fingerprint, checkoutFingerprint, receiptHash }
      : null;
  }
  if (exactReadReferenceFields(reference, BOOKSTACK_READ_REFERENCE_FIELDS)) {
    const pageId = reference.pageId;
    const originFingerprint = exactReadHash(reference.originFingerprint);
    const pageHash = exactReadHash(reference.pageHash);
    const revisionCount = reference.revisionCount;
    const updatedAt = exactReadTimestamp(reference.updatedAt);
    return Number.isSafeInteger(pageId)
      && pageId > 0
      && originFingerprint
      && pageHash
      && Number.isSafeInteger(revisionCount)
      && revisionCount >= 0
      && updatedAt
      ? {
        schemaVersion: 1,
        fingerprint,
        pageId: Number(pageId),
        originFingerprint,
        pageHash,
        revisionCount: Number(revisionCount),
        updatedAt,
      }
      : null;
  }
  return null;
};

const lifecycleReadReferenceProof = (
  provider: LifecycleProviderName,
  value: unknown,
): LifecycleReadProof | null => {
  const reference = projectLifecycleProviderReference(provider, value);
  if (!reference) return null;
  if (provider === "qdrant") {
    const nonce = exactReadUuid(reference.nonce);
    const contentHash = exactReadHash(reference.contentHash);
    return nonce && contentHash ? { nonce, contentHash } : null;
  }
  if (provider === "serena") {
    const logicalId = exactReadHash(reference.logicalId);
    const requestHash = exactReadHash(reference.requestHash);
    const canonicalHash = exactReadHash(reference.canonicalHash);
    return logicalId && requestHash && canonicalHash
      ? { logicalId, requestHash, canonicalHash }
      : null;
  }
  if (provider === "markdown") {
    const checkoutFingerprint = markdownLifecycleCheckoutFingerprint(reference.checkoutRoot);
    const receiptHash = exactReadHash(reference.receiptHash);
    return checkoutFingerprint && receiptHash
      ? { checkoutFingerprint, receiptHash }
      : null;
  }
  const pageId = reference.pageId;
  const originFingerprint = exactReadHash(reference.originFingerprint);
  const pageHash = exactReadHash(reference.pageHash);
  const revisionCount = reference.revisionCount;
  const updatedAt = exactReadTimestamp(reference.updatedAt);
  return Number.isSafeInteger(pageId)
    && pageId > 0
    && originFingerprint
    && pageHash
    && Number.isSafeInteger(revisionCount)
    && revisionCount >= 0
    && updatedAt
    ? {
      pageId: Number(pageId),
      originFingerprint,
      pageHash,
      revisionCount: Number(revisionCount),
      updatedAt,
    }
    : null;
};

const lifecycleReadReferenceMaterial = (
  provider: LifecycleProviderName,
  value: unknown,
) => {
  const reference = projectLifecycleProviderReference(provider, value);
  const proof = lifecycleReadReferenceProof(provider, reference);
  if (!reference || !proof) return null;
  if (provider !== "markdown") return { reference, proof };
  if (!("checkoutFingerprint" in proof)) return null;

  const { checkoutRoot: _checkoutRoot, ...closedReference } = reference;
  return {
    reference: { ...closedReference, checkoutFingerprint: proof.checkoutFingerprint },
    proof,
  };
};

export const lifecycleReadReferenceForNative = (input: {
  provider: LifecycleProviderName;
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  recordKey: string;
  contentHash: string;
  nativeReference: unknown;
}): LifecycleReadReference | null => {
  const lifecycleKey = exactText(input.lifecycleKey, 512);
  const phase = LIFECYCLE_READ_PHASES.has(input.phase) ? input.phase : null;
  const artifactId = exactReadUuid(input.artifactId);
  const recordKey = normalizeLifecycleRecordKey(input.recordKey);
  const contentHash = exactReadHash(input.contentHash);
  const nativeReference = projectLifecycleProviderReference(input.provider, input.nativeReference);
  const nativeContentHash = contentHash && nativeReference
    ? nativeReferenceContentHash({
      provider: input.provider,
      artifactContentHash: contentHash,
      reference: nativeReference,
    })
    : null;
  if (
    !lifecycleKey
    || !phase
    || !artifactId
    || !recordKey
    || recordKey !== input.recordKey
    || !contentHash
    || !nativeReference
    || nativeReference.lifecycleKey !== lifecycleKey
    || nativeReferencePhase(input.provider, nativeReference) !== phase
    || nativeReference.artifactId !== artifactId
    || !nativeContentHash
    || !nativeReferenceMatchesRecordKey({
      provider: input.provider,
      lifecycleKey,
      phase,
      recordKey,
      contentHash,
      reference: nativeReference,
    })
  ) return null;
  const material = lifecycleReadReferenceMaterial(input.provider, nativeReference);
  if (!material) return null;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    provider: input.provider,
    lifecycleKey,
    phase,
    artifactId,
    recordKey,
    contentHash,
    reference: material.reference,
  }), "utf8").digest("hex");
  return {
    schemaVersion: 1,
    fingerprint,
    ...material.proof,
  } as LifecycleReadReference;
};

export const lifecycleReadNativeReferenceFor = (input: {
  provider: LifecycleProviderName;
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  recordKey: string;
  contentHash: string;
  reference: unknown;
  checkoutRoot?: unknown;
  initialReference?: unknown;
  serenaProjectFingerprint?: unknown;
}): Record<string, unknown> | null => {
  const reference = projectLifecycleReadReference(input.reference);
  const lifecycleKey = exactText(input.lifecycleKey, 512);
  const phase = LIFECYCLE_READ_PHASES.has(input.phase) ? input.phase : null;
  const artifactId = exactReadUuid(input.artifactId);
  const recordKey = normalizeLifecycleRecordKey(input.recordKey);
  const contentHash = exactReadHash(input.contentHash);
  if (
    !reference
    || !lifecycleKey
    || !phase
    || !artifactId
    || !recordKey
    || recordKey !== input.recordKey
    || !contentHash
  ) return null;

  let nativeValue: Record<string, unknown> | null = null;
  if (input.provider === "qdrant" && "nonce" in reference && "contentHash" in reference) {
    nativeValue = {
      schemaVersion: 1,
      provider: "qdrant",
      artifactId,
      recordKey,
      contentHash: reference.contentHash,
      lifecycleKey,
      phase,
      nonce: reference.nonce,
    };
  }
  if (input.provider === "serena" && "logicalId" in reference) {
    const projectFingerprint = exactReadHash(input.serenaProjectFingerprint);
    const memoryName = serenaLifecycleMemoryName({ lifecycleKey, phase, artifactId });
    if (projectFingerprint && memoryName) {
      nativeValue = {
        schemaVersion: 1,
        provider: "serena",
        projectFingerprint,
        memoryName,
        artifactId,
        logicalId: reference.logicalId,
        recordKey,
        contentHash,
        requestHash: reference.requestHash,
        canonicalHash: reference.canonicalHash,
        lifecycleKey,
        phase,
        nonce: artifactId,
      };
    }
  }
  if (input.provider === "markdown" && "checkoutFingerprint" in reference) {
    const checkoutFingerprint = markdownLifecycleCheckoutFingerprint(input.checkoutRoot);
    if (checkoutFingerprint && checkoutFingerprint === reference.checkoutFingerprint) {
      nativeValue = {
        schemaVersion: 1,
        provider: "markdown",
        checkoutRoot: input.checkoutRoot,
        lifecycleKey,
        phase,
        artifactId,
        contentHash,
        receiptHash: reference.receiptHash,
      };
    }
  }
  if (input.provider === "bookstack" && "pageId" in reference) {
    const initial = projectLifecycleProviderReference("bookstack", input.initialReference);
    if (initial && initial.originFingerprint === reference.originFingerprint) {
      nativeValue = {
        projectSlug: initial.projectSlug,
        sourceRef: initial.sourceRef,
        lifecycleKey,
        shelfId: initial.shelfId,
        shelfSlug: initial.shelfSlug,
        bookId: initial.bookId,
        bookSlug: initial.bookSlug,
        chapterId: initial.chapterId,
        chapterSlug: initial.chapterSlug,
        pageId: reference.pageId,
        pageSlug: `${phase}-${artifactId}`,
        originFingerprint: reference.originFingerprint,
        artifactId,
        recordKey,
        contentHash,
        pageHash: reference.pageHash,
        revisionCount: reference.revisionCount,
        updatedAt: reference.updatedAt,
      };
    }
  }

  const nativeReference = nativeValue
    ? projectLifecycleProviderReference(input.provider, nativeValue)
    : null;
  const expected = nativeReference
    ? lifecycleReadReferenceForNative({
      provider: input.provider,
      lifecycleKey,
      phase,
      artifactId,
      recordKey,
      contentHash,
      nativeReference,
    })
    : null;
  return expected && sameLifecycleReadReferenceValue(expected, reference)
    ? nativeReference
    : null;
};

export const lifecycleReadReferenceFor = (
  value: unknown,
  options?: LifecycleContentWarningOptions,
): LifecycleReadReference | null => {
  const record = verifyRoutedLifecycleReadRecord(value, {}, options);
  if (!record) return null;
  return lifecycleReadReferenceForNative({
    provider: record.provider,
    lifecycleKey: record.lifecycleKey,
    phase: record.phase,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    contentHash: createHash("sha256").update(record.artifact, "utf8").digest("hex"),
    nativeReference: record.reference,
  });
};

export const sameLifecycleReadReference = (
  record: unknown,
  reference: unknown,
  options?: LifecycleContentWarningOptions,
) => {
  const expected = lifecycleReadReferenceFor(record, options);
  const supplied = projectLifecycleReadReference(reference);
  return Boolean(expected && supplied && sameLifecycleReadReferenceValue(expected, supplied));
};

export const projectRoutedLifecyclePersistResult = (
  value: unknown,
  expectedProvider?: LifecycleProviderName,
  options?: LifecycleContentWarningOptions,
): RoutedLifecyclePersistResult | null => {
  const result = ownDataRecord(value);
  if (!result || typeof result.status !== "string") return null;
  if (result.status === "verified" && Object.keys(result).length === 2) {
    const projected = projectRoutedLifecycleRecordResult(result.record, expectedProvider, options);
    if (projected.status === "verified") return { status: "verified", record: projected.record };
    const record = ownDataRecord(result.record);
    const provider = expectedProvider ?? normalizeLifecycleProvider(record?.provider);
    if (projected.warningBinding && projected.diagnostic) {
      captureWarningCandidates([{
        binding: projected.warningBinding,
        findings: projected.diagnostic.findings,
      }], options);
    }
    return provider && projected.diagnostic
      ? {
        status: "blocked",
        provider,
        code: "lifecycle_provider_response_invalid",
        writeState: "possible-write",
        diagnostic: projected.diagnostic,
      }
      : null;
  }
  if (result.status === "blocked" && Object.keys(result).length === 4) {
    const provider = normalizeLifecycleProvider(result.provider);
    const writeState = result.writeState;
    if (!provider || expectedProvider && provider !== expectedProvider) return null;
    if (writeState !== "no-write" && writeState !== "possible-write") return null;
    return {
      status: "blocked",
      provider,
      code: safeCode(result.code, "lifecycle_provider_operation_failed"),
      writeState,
    };
  }
  return null;
};

export const projectRoutedLifecycleRecallResult = (
  value: unknown,
  expectedProvider?: LifecycleProviderName,
  options?: LifecycleContentWarningOptions,
): RoutedLifecycleRecallResult | null => {
  const result = ownDataRecord(value);
  if (!result || typeof result.status !== "string") return null;
  if (result.status === "blocked" && Object.keys(result).length === 3) {
    const provider = normalizeLifecycleProvider(result.provider);
    return provider && (!expectedProvider || provider === expectedProvider)
      ? { status: "blocked", provider, code: safeCode(result.code, "lifecycle_provider_recall_failed") }
      : null;
  }
  if (result.status !== "verified" || Object.keys(result).length !== 3) return null;
  const provider = normalizeLifecycleProvider(result.provider);
  const records = ownDataArray(result.records, MAX_LIFECYCLE_RECALL_LIMIT);
  if (!provider || expectedProvider && provider !== expectedProvider || !records) return null;
  const projected = records.map((record) => projectRoutedLifecycleRecordResult(record, provider, options));
  const definite = projected.find((result) =>
    result.status === "blocked"
    && !result.warning
    && !result.diagnostic?.findings.some(({ category }) => category === "finding_overflow"),
  );
  const invalid = definite ?? projected.find((result) => result.status === "blocked" && !result.warning);
  if (invalid?.status === "blocked") {
    return {
      status: "blocked",
      provider,
      code: `lifecycle_provider_record_${invalid.code}_invalid`,
      ...(invalid.phase ? { readPhase: invalid.phase } : {}),
      ...(invalid.diagnostic ? { diagnostic: invalid.diagnostic } : {}),
    };
  }
  const warnings = projected.filter((result): result is Extract<RoutedLifecycleRecordProjection, { status: "blocked" }> =>
    result.status === "blocked" && result.warning === true,
  );
  const warningCandidates = warnings.flatMap(({ warningBinding, diagnostic, phase }) =>
    warningBinding && diagnostic
      ? [{ binding: warningBinding, findings: diagnostic.findings, phase }]
      : [],
  );
  const warningFindings = warningCandidates.flatMap(({ findings }) => findings);
  if (warningFindings.length > MAX_LIFECYCLE_CONTENT_FINDINGS) {
    const firstUndisclosed = warningFindings[MAX_LIFECYCLE_CONTENT_FINDINGS];
    const candidate = warningCandidates.find(({ findings }) => findings.includes(firstUndisclosed));
    const diagnostic: LifecycleContentScreeningDiagnostic = {
      reason: firstUndisclosed.field === "summary"
        ? "record_summary_invalid"
        : "record_artifact_secret_bearer_value",
      findings: [{
        category: "finding_overflow",
        field: firstUndisclosed.field,
        index: firstUndisclosed.index,
        line: firstUndisclosed.line,
        column: firstUndisclosed.column,
      }],
    };
    return {
      status: "blocked",
      provider,
      code: firstUndisclosed.field === "summary"
        ? "lifecycle_provider_record_summary_invalid"
        : "lifecycle_provider_record_artifact_secret_bearer_value_invalid",
      ...(candidate?.phase ? { readPhase: candidate.phase } : {}),
      diagnostic,
    };
  }
  if (warnings.length > 0) {
    captureWarningCandidates(
      warningCandidates.map(({ binding, findings }) => ({ binding, findings })),
      options,
    );
    const warning = warnings[0];
    return {
      status: "blocked",
      provider,
      code: `lifecycle_provider_record_${warning.code}_invalid`,
      ...(warning.phase ? { readPhase: warning.phase } : {}),
      ...(warning.diagnostic ? { diagnostic: warning.diagnostic } : {}),
    };
  }
  const verified = projected
    .filter((result): result is Extract<RoutedLifecycleRecordProjection, { status: "verified" }> =>
      result.status === "verified",
    )
    .map((result) => result.record);
  const artifactIds = new Set(verified.map((record) => record.artifactId));
  const recordKeys = new Set(verified.map((record) => record.recordKey));
  return artifactIds.size === verified.length && recordKeys.size === verified.length
    ? { status: "verified", provider, records: verified }
    : null;
};

export const createLifecycleRouting = (
  adapters: readonly LifecycleRoutingAdapter[],
): LifecycleRouting => {
  const selected: Partial<Record<LifecycleProviderName, LifecycleRoutingAdapter>> = {};
  for (const adapter of adapters) {
    const provider = normalizeLifecycleProvider(adapter?.provider);
    if (!provider || selected[provider]) continue;
    selected[provider] = adapter;
  }
  return { adapters: selected };
};

const adapterFor = (
  routing: LifecycleRouting,
  provider: LifecycleProviderName,
) => routing.adapters[provider] ?? null;

const blockedPersist = (
  provider: LifecycleProviderName,
  code: string,
  writeState: LifecycleRouteWriteState = "possible-write",
): RoutedLifecyclePersistResult => ({ status: "blocked", provider, code, writeState });

const sameProviderReference = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const lifecycleProviderAuthority = (
  provider: LifecycleProviderName,
  value: unknown,
): string | null => {
  const reference = projectLifecycleProviderReference(provider, value);
  if (!reference) return null;
  if (provider === "qdrant") return "qdrant";
  if (provider === "serena") {
    return typeof reference.projectFingerprint === "string"
      ? `serena:${reference.projectFingerprint}`
      : null;
  }
  if (provider === "markdown") {
    return typeof reference.checkoutRoot === "string"
      ? `markdown:${reference.checkoutRoot}`
      : null;
  }
  const fields = [
    "originFingerprint",
    "projectSlug",
    "sourceRef",
    "lifecycleKey",
    "shelfId",
    "shelfSlug",
    "bookId",
    "bookSlug",
    "chapterId",
    "chapterSlug",
  ] as const;
  return fields.every((field) => reference[field] !== undefined)
    ? JSON.stringify(fields.map((field) => reference[field]))
    : null;
};

const sameLifecycleProviderAuthority = (input: {
  provider: LifecycleProviderName;
  left: unknown;
  right: unknown;
}) => {
  const left = lifecycleProviderAuthority(input.provider, input.left);
  const right = lifecycleProviderAuthority(input.provider, input.right);
  return left !== null && left === right;
};

const recordMatchesNativeReference = (input: {
  provider: LifecycleProviderName;
  record: RoutedLifecycleRecord;
  reference: unknown;
}) => {
  const reference = projectLifecycleProviderReference(input.provider, input.reference);
  return Boolean(
    reference
    && input.record.provider === input.provider
    && input.record.artifactId === reference.artifactId
    && nativeReferenceMatchesRecordKey({
      provider: input.provider,
      lifecycleKey: input.record.lifecycleKey,
      phase: input.record.phase,
      recordKey: input.record.recordKey,
      contentHash: createHash("sha256").update(input.record.artifact, "utf8").digest("hex"),
      reference,
    })
    && input.record.lifecycleKey === reference.lifecycleKey
    && nativeReferencePhase(input.provider, reference) === input.record.phase
    && sameProviderReference(input.record.reference, reference),
  );
};

const validRecallSelection = (input: {
  lifecycleKey: unknown;
  phase?: unknown;
  limit: unknown;
}) => {
  const lifecycleKey = exactText(input.lifecycleKey, 512);
  const phase = input.phase === undefined
    ? undefined
    : typeof input.phase === "string"
      && ["plan", "implementation", "test", "review", "resolution", "rereview", "document", "decision", "closeout"].includes(input.phase)
        ? input.phase as LifecyclePhase
        : null;
  const limit = input.limit;
  return lifecycleKey
    && normalizeLifecycleRecordKey(lifecycleKey) === lifecycleKey
    && phase !== null
    && typeof limit === "number"
    && Number.isSafeInteger(limit)
    && limit >= 1
    && limit <= MAX_LIFECYCLE_RECALL_LIMIT
    ? { lifecycleKey, ...(phase ? { phase } : {}), limit }
    : null;
};

const verifiedPinnedInitialReference = (input: {
  pin: LifecycleProviderPin;
  expectedReference: Record<string, unknown>;
  record: RoutedLifecycleRecord;
}): Record<string, unknown> | null => {
  const reference = projectLifecycleProviderReference(
    input.pin.provider,
    input.record.reference,
  );
  if (
    !reference
    || input.record.provider !== input.pin.provider
    || input.record.lifecycleKey !== input.pin.lifecycleKey
    || input.record.artifactId !== input.pin.artifactId
    || input.record.recordKey !== input.pin.recordKey
    || !sameProviderReference(input.expectedReference, reference)
  ) return null;
  return reference;
};

export const derivePinnedLifecycleLineage = (input: {
  pin: unknown;
  record: unknown;
  warningOptions?: LifecycleContentWarningOptions;
}): PinnedLifecycleLineage | null => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin) return null;
  const record = verifyRoutedLifecycleReadRecord(input.record, {
    provider: pin.provider,
    lifecycleKey: pin.lifecycleKey,
  }, input.warningOptions);
  const expectedReference = projectLifecycleProviderReference(pin.provider, pin.initialReference);
  if (!record || !expectedReference) return null;
  const initialReference = verifiedPinnedInitialReference({ pin, expectedReference, record });
  const request = lifecycleReadRequest(record, input.warningOptions);
  const sourceIdentity = request && projectLifecycleSourceIdentity(request.identity);
  const rootArtifactId = request && deriveLifecycleRoot({
    phase: request.type,
    artifactId: record.artifactId,
    lifecycleRootMemoryId: request.identity.lifecycleRootMemoryId,
  });
  return initialReference && sourceIdentity && rootArtifactId
    ? {
      provider: pin.provider,
      initialReference: structuredClone(initialReference),
      rootArtifactId,
      sourceIdentity,
    }
    : null;
};

export const lifecycleRecordMatchesPinnedLineage = (input: {
  lineage: PinnedLifecycleLineage;
  record: unknown;
  approvedWarningBindings?: readonly string[];
  allowWarnings?: boolean;
}): boolean => {
  const record = verifyRoutedLifecycleReadRecord(input.record, {
    provider: input.lineage.provider,
    lifecycleKey: input.lineage.sourceIdentity.lifecycleKey,
  }, {
    allowWarnings: input.allowWarnings,
    approvedWarningBindings: input.approvedWarningBindings,
  });
  const request = record && lifecycleReadRequest(
    record,
    {
      allowWarnings: input.allowWarnings,
      approvedWarningBindings: input.approvedWarningBindings,
    },
  );
  const sourceIdentity = request && projectLifecycleSourceIdentity(request.identity);
  if (!record || !request || !sourceIdentity) return false;
  if (
    !sameLifecycleProviderAuthority({
      provider: input.lineage.provider,
      left: input.lineage.initialReference,
      right: record.reference,
    })
    || !sameLifecycleSourceIdentity(sourceIdentity, input.lineage.sourceIdentity)
  ) return false;

  return (
    lifecycleSeedPhase(request.type)
    && record.artifactId === input.lineage.rootArtifactId
    && request.identity.lifecycleRootMemoryId === ""
  ) || request.identity.lifecycleRootMemoryId === input.lineage.rootArtifactId;
};

export const resolvePinnedLifecycleLineage = async (input: {
  routing: LifecycleRouting;
  pin: unknown;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly LifecycleContentWarningCandidate[]) => void;
  signal?: AbortSignal;
}): Promise<PinnedLifecycleLineageResult> => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin) return { status: "blocked", provider: "qdrant", code: "lifecycle_pin_invalid" };
  const adapter = adapterFor(input.routing, pin.provider);
  const verify = adapter?.reconcile ?? adapter?.get;
  const expectedReference = projectLifecycleProviderReference(pin.provider, pin.initialReference);
  if (!adapter || !verify) {
    return { status: "blocked", provider: pin.provider, code: "pinned_provider_unavailable" };
  }
  if (!expectedReference) {
    return { status: "blocked", provider: pin.provider, code: "lifecycle_pin_invalid" };
  }

  try {
    const result = projectRoutedLifecyclePersistResult(
      await verify(structuredClone(expectedReference), input.signal),
      pin.provider,
      {
        approvedWarningBindings: input.approvedWarningBindings,
        captureWarningBindings: input.captureWarningBindings,
      },
    );
    if (!result) {
      return { status: "blocked", provider: pin.provider, code: "pinned_provider_response_invalid" };
    }
    if (result.status !== "verified") {
      return {
        status: "blocked",
        provider: pin.provider,
        code: result.code,
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      };
    }
    const record = verifyRoutedLifecycleReadRecord(result.record, {
      provider: pin.provider,
      lifecycleKey: pin.lifecycleKey,
    }, { approvedWarningBindings: input.approvedWarningBindings });
    if (!record || !verifiedPinnedInitialReference({ pin, expectedReference, record })) {
      return { status: "blocked", provider: pin.provider, code: "pinned_provider_response_invalid" };
    }
    const lineage = derivePinnedLifecycleLineage({
      pin,
      record,
      warningOptions: { approvedWarningBindings: input.approvedWarningBindings },
    });
    return lineage
      ? { status: "verified", provider: pin.provider, lineage }
      : { status: "blocked", provider: pin.provider, code: "lifecycle_lineage_unresolved" };
  } catch {
    return { status: "blocked", provider: pin.provider, code: "pinned_provider_failed" };
  }
};

const verifiedPinnedReadAuthority = async (input: {
  routing: LifecycleRouting;
  pin: LifecycleProviderPin;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly LifecycleContentWarningCandidate[]) => void;
  signal?: AbortSignal;
}): Promise<{
  status: "verified";
  lineage: PinnedLifecycleLineage;
} | {
  status: "blocked";
  code: string;
  diagnostic?: LifecycleContentScreeningDiagnostic;
}> => {
  const resolved = await resolvePinnedLifecycleLineage(input);
  if (resolved.status === "verified") return { status: "verified", lineage: resolved.lineage };
  return {
    status: "blocked",
    code: resolved.code === "lifecycle_lineage_unresolved"
      ? "lifecycle_read_authority_invalid"
      : resolved.code,
    ...(resolved.diagnostic ? { diagnostic: resolved.diagnostic } : {}),
  };
};

const matchesPinnedPersistenceRecord = (input: {
  lineage: PinnedLifecycleLineage;
  request: ValidLifecycleRequest;
  record: unknown;
  approvedWarningBindings?: readonly string[];
  allowWarnings?: boolean;
}) => {
  const record = verifyRoutedLifecycleReadRecord(input.record, {
    provider: input.lineage.provider,
    lifecycleKey: input.request.identity.lifecycleKey,
    phase: input.request.type,
  }, {
    allowWarnings: input.allowWarnings,
    approvedWarningBindings: input.approvedWarningBindings,
  });
  const prepared = prepareLifecycleArtifact(input.request);
  const recordRequest = record && lifecycleReadRequest(
    record,
    {
      allowWarnings: input.allowWarnings,
      approvedWarningBindings: input.approvedWarningBindings,
    },
  );
  return Boolean(
    record
    && prepared.valid
    && recordRequest
    && record.artifact === prepared.data.artifact
    && record.recordKey === prepared.data.recordKey
    && recordRequest.summary === input.request.summary
    && JSON.stringify(recordRequest.identity) === JSON.stringify(input.request.identity)
    && lifecycleRecordMatchesPinnedLineage({
      lineage: input.lineage,
      record,
      allowWarnings: input.allowWarnings,
      approvedWarningBindings: input.approvedWarningBindings,
    }),
  );
};

export const routeLifecyclePersistence = async (input: {
  routing: LifecycleRouting;
  provider: LifecycleProviderName;
  request: ValidLifecycleRequest;
  approvedWarningBindings?: readonly string[];
  allowWarnings?: boolean;
  signal?: AbortSignal;
}): Promise<RoutedLifecyclePersistResult> => {
  const adapter = adapterFor(input.routing, input.provider);
  if (!adapter) return blockedPersist(input.provider, "lifecycle_provider_unavailable", "no-write");
  try {
    const result = projectRoutedLifecyclePersistResult(
      await adapter.persist(input.request, input.signal),
      input.provider,
      {
        allowWarnings: input.allowWarnings,
        approvedWarningBindings: input.approvedWarningBindings,
      },
    );
    return result ?? blockedPersist(input.provider, "lifecycle_provider_response_invalid");
  } catch {
    return blockedPersist(input.provider, "lifecycle_provider_operation_failed");
  }
};

export const routePinnedLifecyclePersistence = async (input: {
  routing: LifecycleRouting;
  pin: unknown;
  request: ValidLifecycleRequest;
  approvedWarningBindings?: readonly string[];
  allowWarnings?: boolean;
  signal?: AbortSignal;
}): Promise<RoutedLifecyclePersistResult> => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin || pin.lifecycleKey !== input.request.identity.lifecycleKey) {
    return blockedPersist("qdrant", "lifecycle_pin_invalid", "no-write");
  }
  const adapter = adapterFor(input.routing, pin.provider);
  if (!adapter) return blockedPersist(pin.provider, "pinned_provider_unavailable", "no-write");

  const resolved = await resolvePinnedLifecycleLineage({
    routing: input.routing,
    pin,
    signal: input.signal,
  });
  if (resolved.status !== "verified") {
    return blockedPersist(pin.provider, resolved.code, "no-write");
  }
  const continuation = validateLifecycleContinuationRequest({
    lineage: resolved.lineage,
    request: input.request,
  });
  if (!continuation.valid) return blockedPersist(pin.provider, continuation.code, "no-write");

  try {
    const result = projectRoutedLifecyclePersistResult(
      typeof adapter.persistPinned === "function"
        ? await adapter.persistPinned(input.request, resolved.lineage.initialReference, input.signal)
        : await adapter.persist(input.request, input.signal),
      pin.provider,
      {
        allowWarnings: input.allowWarnings,
        approvedWarningBindings: input.approvedWarningBindings,
      },
    );
    if (!result) return blockedPersist(pin.provider, "lifecycle_provider_response_invalid");
    if (result.status !== "verified") return result;
    const matches = matchesPinnedPersistenceRecord({
      lineage: resolved.lineage,
      request: input.request,
      record: result.record,
      approvedWarningBindings: input.approvedWarningBindings,
      allowWarnings: input.allowWarnings,
    });
    if (matches) return result;
    const diagnostic = screeningDiagnosticForRecord(result.record);
    return {
      ...blockedPersist(pin.provider, "lifecycle_provider_response_invalid"),
      ...(diagnostic ? { diagnostic } : {}),
    };
  } catch {
    return blockedPersist(pin.provider, "lifecycle_provider_operation_failed");
  }
};

export const routeLifecycleRecall = async (input: {
  routing: LifecycleRouting;
  provider: LifecycleProviderName;
  lifecycleKey: string;
  phase?: LifecyclePhase;
  limit: number;
  reference?: Record<string, unknown>;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly LifecycleContentWarningCandidate[]) => void;
  signal?: AbortSignal;
}): Promise<RoutedLifecycleRecallResult> => {
  const provider = normalizeLifecycleProvider(input.provider);
  const selection = validRecallSelection(input);
  if (!provider || !selection) {
    return {
      status: "blocked",
      provider: provider ?? "qdrant",
      code: "lifecycle_recall_request_invalid",
    };
  }
  const adapter = adapterFor(input.routing, provider);
  if (!adapter) {
    return { status: "blocked", provider, code: "lifecycle_provider_unavailable" };
  }
  const reference = input.reference === undefined
    ? undefined
    : projectLifecycleProviderReference(provider, input.reference);
  if (input.reference !== undefined && !reference) {
    return { status: "blocked", provider, code: "pinned_provider_response_invalid" };
  }

  try {
    const result = projectRoutedLifecycleRecallResult(
      await adapter.recall({
        lifecycleKey: selection.lifecycleKey,
        ...(selection.phase ? { phase: selection.phase } : {}),
        limit: selection.limit,
        ...(reference ? { reference: structuredClone(reference) } : {}),
      }, input.signal),
      provider,
      {
        approvedWarningBindings: input.approvedWarningBindings,
        captureWarningBindings: input.captureWarningBindings,
      },
    );
    if (!result) {
      return { status: "blocked", provider, code: "lifecycle_provider_recall_envelope_invalid" };
    }
    if (result.status !== "verified") return result;
    if (result.records.length > selection.limit) {
      return { status: "blocked", provider, code: "lifecycle_provider_recall_overflow" };
    }
    const records = result.records.map((record) => verifyRoutedLifecycleReadRecord(record, {
      provider,
      lifecycleKey: selection.lifecycleKey,
      ...(selection.phase ? { phase: selection.phase } : {}),
    }, { approvedWarningBindings: input.approvedWarningBindings }));
    return records.some((record) => record === null)
      ? { status: "blocked", provider, code: "lifecycle_provider_record_verification_failed" }
      : { status: "verified", provider, records: records as RoutedLifecycleRecord[] };
  } catch {
    return { status: "blocked", provider, code: "lifecycle_provider_recall_failed" };
  }
};

export const routeLifecycleGet = async (input: {
  routing: LifecycleRouting;
  provider: LifecycleProviderName;
  reference: unknown;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly LifecycleContentWarningCandidate[]) => void;
  signal?: AbortSignal;
}): Promise<RoutedLifecyclePersistResult> => {
  const provider = normalizeLifecycleProvider(input.provider);
  if (!provider) return blockedPersist("qdrant", "lifecycle_get_request_invalid", "no-write");
  const reference = projectLifecycleProviderReference(provider, input.reference);
  if (!reference) return blockedPersist(provider, "lifecycle_get_request_invalid", "no-write");
  const adapter = adapterFor(input.routing, provider);
  if (!adapter?.get) return blockedPersist(provider, "pinned_provider_unavailable", "no-write");

  try {
    const result = projectRoutedLifecyclePersistResult(
      await adapter.get(structuredClone(reference), input.signal),
      provider,
      {
        approvedWarningBindings: input.approvedWarningBindings,
        captureWarningBindings: input.captureWarningBindings,
      },
    );
    if (!result) return blockedPersist(provider, "lifecycle_provider_response_invalid", "no-write");
    if (result.status !== "verified") {
      return { ...result, writeState: "no-write" };
    }
    const record = verifyRoutedLifecycleReadRecord(
      result.record,
      { provider },
      { approvedWarningBindings: input.approvedWarningBindings },
    );
    return record && recordMatchesNativeReference({ provider, record, reference })
      ? { status: "verified", record }
      : blockedPersist(provider, "lifecycle_provider_response_invalid", "no-write");
  } catch {
    return blockedPersist(provider, "lifecycle_provider_get_failed", "no-write");
  }
};

export const routePinnedLifecycleGet = async (input: {
  routing: LifecycleRouting;
  pin: unknown;
  reference: unknown;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly LifecycleContentWarningCandidate[]) => void;
  signal?: AbortSignal;
}): Promise<RoutedLifecyclePersistResult> => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin) return blockedPersist("qdrant", "lifecycle_pin_invalid", "no-write");
  const reference = projectLifecycleProviderReference(pin.provider, input.reference);
  if (
    !reference
    || reference.lifecycleKey !== pin.lifecycleKey
    || !sameLifecycleProviderAuthority({
      provider: pin.provider,
      left: pin.initialReference,
      right: reference,
    })
  ) return blockedPersist(pin.provider, "lifecycle_read_authority_invalid", "no-write");

  const authority = await verifiedPinnedReadAuthority({
    routing: input.routing,
    pin,
    approvedWarningBindings: input.approvedWarningBindings,
    captureWarningBindings: input.captureWarningBindings,
    signal: input.signal,
  });
  if (authority.status !== "verified") {
    return {
      ...blockedPersist(pin.provider, authority.code, "no-write"),
      ...(authority.diagnostic ? { diagnostic: authority.diagnostic } : {}),
    };
  }
  if (!sameLifecycleProviderAuthority({
    provider: pin.provider,
    left: authority.lineage.initialReference,
    right: reference,
  })) return blockedPersist(pin.provider, "lifecycle_read_authority_invalid", "no-write");

  const result = await routeLifecycleGet({
    routing: input.routing,
    provider: pin.provider,
    reference,
    approvedWarningBindings: input.approvedWarningBindings,
    captureWarningBindings: input.captureWarningBindings,
    signal: input.signal,
  });
  if (result.status !== "verified") return result;
  return lifecycleRecordMatchesPinnedLineage({
    lineage: authority.lineage,
    record: result.record,
    approvedWarningBindings: input.approvedWarningBindings,
  })
    ? result
    : blockedPersist(pin.provider, "lifecycle_read_authority_invalid", "no-write");
};

const providerReadStepCode = (code: string) => [
  "bookstack_http_failed",
  "bookstack_pagination_invalid",
  "bookstack_rate_limited",
  "bookstack_response_invalid",
  "bookstack_response_too_large",
  "lifecycle_provider_recall_envelope_invalid",
  "lifecycle_provider_recall_overflow",
  "lifecycle_provider_record_projection_invalid",
  "lifecycle_provider_record_artifact_missing_invalid",
  "lifecycle_provider_record_artifact_secret_bearer_placeholder_invalid",
  "lifecycle_provider_record_artifact_secret_bearer_value_invalid",
  "lifecycle_provider_record_artifact_secret_named_invalid",
  "lifecycle_provider_record_artifact_secret_private_key_invalid",
  "lifecycle_provider_record_artifact_too_large_invalid",
  "lifecycle_provider_record_artifact_utf8_invalid",
  "lifecycle_provider_record_created_at_invalid",
  "lifecycle_provider_record_identity_invalid",
  "lifecycle_provider_record_reference_invalid",
  "lifecycle_provider_record_structure_invalid",
  "lifecycle_provider_record_summary_invalid",
  "lifecycle_provider_response_invalid",
  "pinned_provider_response_invalid",
].includes(code);

export const routePinnedLifecycleRecall = async (input: {
  routing: LifecycleRouting;
  pin: unknown;
  lifecycleKey: string;
  phase?: LifecyclePhase;
  limit: number;
  approvedWarningBindings?: readonly string[];
  captureWarningBindings?: (warnings: readonly LifecycleContentWarningCandidate[]) => void;
  signal?: AbortSignal;
}): Promise<RoutedLifecycleRecallResult> => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin || pin.lifecycleKey !== input.lifecycleKey) {
    return { status: "blocked", provider: "qdrant", code: "lifecycle_pin_invalid" };
  }
  const authority = await verifiedPinnedReadAuthority({
    routing: input.routing,
    pin,
    approvedWarningBindings: input.approvedWarningBindings,
    captureWarningBindings: input.captureWarningBindings,
    signal: input.signal,
  });
  if (authority.status !== "verified") {
    const blocked = {
      status: "blocked" as const,
      provider: pin.provider,
      code: authority.code,
      ...(authority.diagnostic ? { diagnostic: authority.diagnostic } : {}),
    };
    return providerReadStepCode(authority.code)
      ? { ...blocked, readStep: "authority" as const }
      : blocked;
  }

  const result = await routeLifecycleRecall({
    routing: input.routing,
    provider: pin.provider,
    lifecycleKey: input.lifecycleKey,
    ...(input.phase ? { phase: input.phase } : {}),
    limit: input.limit,
    reference: authority.lineage.initialReference,
    approvedWarningBindings: input.approvedWarningBindings,
    captureWarningBindings: input.captureWarningBindings,
    signal: input.signal,
  });
  if (result.status !== "verified") {
    return providerReadStepCode(result.code)
      ? { ...result, readStep: "recall" as const }
      : result;
  }
  return result.records.every((record) => lifecycleRecordMatchesPinnedLineage({
    lineage: authority.lineage,
    record,
    approvedWarningBindings: input.approvedWarningBindings,
  }))
    ? result
    : { status: "blocked", provider: pin.provider, code: "lifecycle_read_authority_invalid" };
};

export const routePinnedLifecycleReference = async (input: {
  routing: LifecycleRouting;
  pin: unknown;
  operation: "get" | "reconcile";
  signal?: AbortSignal;
}): Promise<RoutedLifecyclePersistResult> => {
  const pin = projectLifecycleProviderPin(input.pin);
  if (!pin) return blockedPersist("qdrant", "lifecycle_pin_invalid", "no-write");
  const adapter = adapterFor(input.routing, pin.provider);
  const operation = adapter?.[input.operation];
  if (!adapter || typeof operation !== "function") {
    return blockedPersist(pin.provider, "pinned_provider_unavailable", "no-write");
  }
  const resolved = await resolvePinnedLifecycleLineage({
    routing: input.routing,
    pin,
    signal: input.signal,
  });
  if (resolved.status !== "verified") {
    return blockedPersist(pin.provider, resolved.code, "no-write");
  }
  try {
    const result = projectRoutedLifecyclePersistResult(
      await operation(structuredClone(resolved.lineage.initialReference), input.signal),
      pin.provider,
    );
    if (!result) return blockedPersist(pin.provider, "pinned_provider_response_invalid", "no-write");
    return result.status === "verified" && lifecycleRecordMatchesPinnedLineage({
      lineage: resolved.lineage,
      record: result.record,
    })
      ? result
      : result.status === "verified"
        ? blockedPersist(pin.provider, "pinned_provider_response_invalid", "no-write")
        : { ...result, writeState: "no-write" };
  } catch {
    return blockedPersist(pin.provider, "pinned_provider_failed", "no-write");
  }
};
