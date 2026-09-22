import { createHash } from "node:crypto";
import {
  buildLifecycleArtifactBody,
  buildLifecycleNonceMarker,
  LIFECYCLE_PHASES,
  MAX_LIFECYCLE_KEY_BYTES,
  MAX_LIFECYCLE_RECORD_KEY_BYTES,
  MAX_LIFECYCLE_REFERENCES,
  prepareLifecycleArtifact,
  validateLifecycleWriteRequest,
  type LifecycleIdentity,
  type LifecyclePhase,
  type ValidLifecycleRequest,
} from "./ima-lifecycle.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

export const SERENA_LIFECYCLE_PROVIDER = "serena";
export const SERENA_LIFECYCLE_SCHEMA_VERSION = 1;
export const SERENA_LIFECYCLE_NAMESPACE = "ima-serena-lifecycle-v1";
export const MAX_SERENA_LIFECYCLE_RECALL_LIMIT = 50;
export const MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS = 200_000;
export const MAX_SERENA_LIFECYCLE_MEMORY_BYTES = 256_000;
export const MAX_SERENA_LIFECYCLE_PROJECT_NAME_BYTES = 256;
export const MAX_SERENA_LIFECYCLE_PROJECT_PATH_BYTES = 4_096;

export type SerenaLifecycleProject = {
  schemaVersion: 1;
  provider: "serena";
  projectName: string;
  projectPath: string;
  fingerprint: string;
};

export type SerenaLifecycleSelection = {
  lifecycleKey: string;
  phase?: LifecyclePhase;
  limit: number;
};

export type SerenaLifecycleReference = {
  schemaVersion: 1;
  provider: "serena";
  projectFingerprint: string;
  memoryName: string;
  artifactId: string;
  logicalId: string;
  recordKey: string;
  contentHash: string;
  requestHash: string;
  canonicalHash: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  nonce: string;
};

export type SerenaLifecycleRecord = {
  schemaVersion: 1;
  provider: "serena";
  namespace: "ima-serena-lifecycle-v1";
  project: SerenaLifecycleProject;
  memoryName: string;
  artifactId: string;
  logicalId: string;
  recordKey: string;
  contentHash: string;
  requestHash: string;
  canonicalHash: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  nonce: string;
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
  createdAt: string;
};

export type SerenaLifecyclePreparedRecord = SerenaLifecycleRecord & {
  serialized: string;
  reference: SerenaLifecycleReference;
};

export type SerenaLifecycleVerifiedRecord = SerenaLifecyclePreparedRecord & {
  request: ValidLifecycleRequest;
};

export type SerenaLifecycleRequestProjection = {
  type: unknown;
  identity: {
    project: unknown;
    lifecycleKey: unknown;
    lifecycleRootMemoryId: unknown;
    taskwarriorProject: unknown;
    taskwarriorTask: unknown;
    taskwarriorUuid: unknown;
    jiraKey: unknown;
    planeWorkspace?: unknown;
    planeWorkItem?: unknown;
    sourceRefs: unknown[];
    priorArtifactIds: unknown[];
  };
  summary: unknown;
  artifact: unknown;
};

type RecordBase = Omit<SerenaLifecycleRecord, "canonicalHash">;
type VerificationInput = {
  content: unknown;
  project?: unknown;
  selection?: unknown;
  reference?: unknown;
  request?: unknown;
};

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MEMORY_NAME_PATTERN = new RegExp(
  `^${SERENA_LIFECYCLE_NAMESPACE}-[a-f0-9]{64}-(${LIFECYCLE_PHASES.join("|")})-${UUID_PATTERN.source.slice(1, -1)}$`,
);
const PHASES = new Set<string>(LIFECYCLE_PHASES);
const PROJECT_FIELDS = [
  "schemaVersion",
  "provider",
  "projectName",
  "projectPath",
  "fingerprint",
] as const;
const PROJECT_INPUT_FIELDS = ["projectName", "projectPath"] as const;
const REQUEST_FIELDS = ["type", "identity", "summary", "artifact"] as const;
const IDENTITY_REQUIRED_FIELDS = [
  "project",
  "lifecycleKey",
  "lifecycleRootMemoryId",
  "taskwarriorProject",
  "taskwarriorTask",
  "taskwarriorUuid",
  "jiraKey",
  "sourceRefs",
  "priorArtifactIds",
] as const;
const IDENTITY_OPTIONAL_FIELDS = ["planeWorkspace", "planeWorkItem"] as const;
const RECORD_FIELDS = [
  "schemaVersion",
  "provider",
  "namespace",
  "project",
  "memoryName",
  "artifactId",
  "logicalId",
  "recordKey",
  "contentHash",
  "requestHash",
  "canonicalHash",
  "lifecycleKey",
  "phase",
  "nonce",
  "identity",
  "summary",
  "artifact",
  "createdAt",
] as const;
const REFERENCE_FIELDS = [
  "schemaVersion",
  "provider",
  "projectFingerprint",
  "memoryName",
  "artifactId",
  "logicalId",
  "recordKey",
  "contentHash",
  "requestHash",
  "canonicalHash",
  "lifecycleKey",
  "phase",
  "nonce",
] as const;
const SELECTION_REQUIRED_FIELDS = ["lifecycleKey"] as const;
const SELECTION_OPTIONAL_FIELDS = ["phase", "limit"] as const;
const VERIFICATION_REQUIRED_FIELDS = ["content"] as const;
const VERIFICATION_OPTIONAL_FIELDS = ["project", "selection", "reference", "request"] as const;
const ORIGINAL_ARTIFACT_SENTINEL = "ima-serena-lifecycle-original-artifact";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const ownDataRecord = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length < required.length
      || !required.every((field) => keys.includes(field))
      || keys.some((key) => ![...required, ...optional].includes(key as string))
    ) return null;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
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
    if (!Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > maximum
      || keys.length !== length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;

    const entries: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) return null;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
};

const canonicalText = (
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): string | null => typeof value === "string"
  && value === value.trim()
  && (allowEmpty || value.length > 0)
  && !CONTROL_CHARACTER.test(value)
  && utf8ByteLength(value) <= maximumBytes
  ? value
  : null;

const canonicalHash = (value: unknown): string | null =>
  typeof value === "string" && HASH_PATTERN.test(value) ? value : null;

const canonicalUuid = (value: unknown): string | null => {
  const candidate = canonicalText(value, 36);
  return candidate && UUID_PATTERN.test(candidate) ? candidate : null;
};

const canonicalPhase = (value: unknown): LifecyclePhase | null =>
  typeof value === "string" && PHASES.has(value) ? value as LifecyclePhase : null;

const canonicalProjectPath = (value: unknown): string | null => {
  const candidate = canonicalText(value, MAX_SERENA_LIFECYCLE_PROJECT_PATH_BYTES);
  if (
    !candidate
    || !candidate.startsWith("/")
    || (candidate.length > 1 && candidate.endsWith("/"))
    || candidate.includes("//")
  ) return null;

  const segments = candidate.split("/");
  return segments.some((segment) => segment === "." || segment === "..")
    ? null
    : candidate;
};

const canonicalTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
};

const sameArray = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const detachedIdentity = (identity: LifecycleIdentity): LifecycleIdentity => ({
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

const detachedRequest = (request: ValidLifecycleRequest): ValidLifecycleRequest => ({
  valid: true,
  type: request.type,
  identity: detachedIdentity(request.identity),
  summary: request.summary,
  artifact: request.artifact,
});

const detachedProject = (project: SerenaLifecycleProject): SerenaLifecycleProject => ({
  schemaVersion: 1,
  provider: SERENA_LIFECYCLE_PROVIDER,
  projectName: project.projectName,
  projectPath: project.projectPath,
  fingerprint: project.fingerprint,
});

const sameProject = (left: SerenaLifecycleProject, right: SerenaLifecycleProject) =>
  left.projectName === right.projectName
  && left.projectPath === right.projectPath
  && left.fingerprint === right.fingerprint;

const sameRequest = (left: ValidLifecycleRequest, right: ValidLifecycleRequest) =>
  left.type === right.type
  && left.summary === right.summary
  && left.artifact === right.artifact
  && left.identity.project === right.identity.project
  && left.identity.lifecycleKey === right.identity.lifecycleKey
  && left.identity.lifecycleRootMemoryId === right.identity.lifecycleRootMemoryId
  && left.identity.taskwarriorProject === right.identity.taskwarriorProject
  && left.identity.taskwarriorTask === right.identity.taskwarriorTask
  && left.identity.taskwarriorUuid === right.identity.taskwarriorUuid
  && left.identity.jiraKey === right.identity.jiraKey
  && left.identity.planeWorkspace === right.identity.planeWorkspace
  && left.identity.planeWorkItem === right.identity.planeWorkItem
  && sameArray(left.identity.sourceRefs, right.identity.sourceRefs)
  && sameArray(left.identity.priorArtifactIds, right.identity.priorArtifactIds);

const projectIdentity = (value: unknown): SerenaLifecycleRequestProjection["identity"] | null => {
  const identity = ownDataRecord(value, IDENTITY_REQUIRED_FIELDS, IDENTITY_OPTIONAL_FIELDS);
  if (!identity) return null;

  const hasPlaneWorkspace = Object.hasOwn(identity, "planeWorkspace");
  const hasPlaneWorkItem = Object.hasOwn(identity, "planeWorkItem");
  const sourceRefs = ownDataArray(identity.sourceRefs, MAX_LIFECYCLE_REFERENCES);
  const priorArtifactIds = ownDataArray(identity.priorArtifactIds, MAX_LIFECYCLE_REFERENCES);
  if (!sourceRefs || !priorArtifactIds || hasPlaneWorkspace !== hasPlaneWorkItem) return null;

  return {
    project: identity.project,
    lifecycleKey: identity.lifecycleKey,
    lifecycleRootMemoryId: identity.lifecycleRootMemoryId,
    taskwarriorProject: identity.taskwarriorProject,
    taskwarriorTask: identity.taskwarriorTask,
    taskwarriorUuid: identity.taskwarriorUuid,
    jiraKey: identity.jiraKey,
    ...(hasPlaneWorkspace && hasPlaneWorkItem
      ? {
        planeWorkspace: identity.planeWorkspace,
        planeWorkItem: identity.planeWorkItem,
      }
      : {}),
    sourceRefs,
    priorArtifactIds,
  };
};

export const projectSerenaLifecycleRequest = (
  value: unknown,
): SerenaLifecycleRequestProjection | null => {
  const request = ownDataRecord(value, REQUEST_FIELDS);
  if (!request) return null;

  const identity = projectIdentity(request.identity);
  return identity
    ? {
      type: request.type,
      identity,
      summary: request.summary,
      artifact: request.artifact,
    }
    : null;
};

export const normalizeSerenaLifecycleRequest = (
  value: unknown,
): ValidLifecycleRequest | null => {
  try {
    const projected = projectSerenaLifecycleRequest(value);
    if (!projected) return null;
    const request = validateLifecycleWriteRequest(projected);
    return request.valid ? detachedRequest(request) : null;
  } catch {
    return null;
  }
};

const projectFingerprint = (projectName: string, projectPath: string) =>
  digest(JSON.stringify({ projectName, projectPath }));

export const createSerenaLifecycleProject = (
  value: unknown,
): SerenaLifecycleProject | null => {
  const input = ownDataRecord(value, PROJECT_INPUT_FIELDS);
  if (!input) return null;

  const projectName = canonicalText(input.projectName, MAX_SERENA_LIFECYCLE_PROJECT_NAME_BYTES);
  const projectPath = canonicalProjectPath(input.projectPath);
  return projectName && projectPath
    ? {
      schemaVersion: 1,
      provider: SERENA_LIFECYCLE_PROVIDER,
      projectName,
      projectPath,
      fingerprint: projectFingerprint(projectName, projectPath),
    }
    : null;
};

export const projectSerenaLifecycleProject = (
  value: unknown,
): SerenaLifecycleProject | null => {
  const project = ownDataRecord(value, PROJECT_FIELDS);
  if (!project) return null;

  const projectName = canonicalText(project.projectName, MAX_SERENA_LIFECYCLE_PROJECT_NAME_BYTES);
  const projectPath = canonicalProjectPath(project.projectPath);
  const fingerprint = canonicalHash(project.fingerprint);
  if (
    project.schemaVersion !== SERENA_LIFECYCLE_SCHEMA_VERSION
    || project.provider !== SERENA_LIFECYCLE_PROVIDER
    || !projectName
    || !projectPath
    || !fingerprint
    || fingerprint !== projectFingerprint(projectName, projectPath)
  ) return null;

  return {
    schemaVersion: 1,
    provider: SERENA_LIFECYCLE_PROVIDER,
    projectName,
    projectPath,
    fingerprint,
  };
};

export const normalizeSerenaLifecycleProject = (
  value: unknown,
): SerenaLifecycleProject | null =>
  projectSerenaLifecycleProject(value) ?? createSerenaLifecycleProject(value);

export const serenaLifecycleNamespacePrefix = (lifecycleKey: unknown): string | null => {
  const canonical = canonicalText(lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  return canonical ? `${SERENA_LIFECYCLE_NAMESPACE}-${digest(canonical)}-` : null;
};

const logicalIdFor = (input: {
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
}) => digest(`${input.lifecycleKey}\u0000${input.phase}\u0000${input.artifactId}`);

export const serenaLifecycleMemoryName = (input: {
  lifecycleKey: unknown;
  phase: unknown;
  artifactId: unknown;
}): string | null => {
  const prefix = serenaLifecycleNamespacePrefix(input.lifecycleKey);
  const phase = canonicalPhase(input.phase);
  const artifactId = canonicalUuid(input.artifactId);
  return prefix && phase && artifactId ? `${prefix}${phase}-${artifactId}` : null;
};

export const isSerenaLifecycleMemoryName = (value: unknown): value is string =>
  typeof value === "string"
  && utf8ByteLength(value) <= 160
  && MEMORY_NAME_PATTERN.test(value);

export const projectSerenaLifecycleSelection = (
  value: unknown,
): SerenaLifecycleSelection | null => {
  const selection = ownDataRecord(value, SELECTION_REQUIRED_FIELDS, SELECTION_OPTIONAL_FIELDS);
  if (!selection) return null;

  const lifecycleKey = canonicalText(selection.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  const phase = Object.hasOwn(selection, "phase")
    ? canonicalPhase(selection.phase)
    : undefined;
  const limit = Object.hasOwn(selection, "limit")
    ? selection.limit
    : MAX_SERENA_LIFECYCLE_RECALL_LIMIT;
  if (
    !lifecycleKey
    || (Object.hasOwn(selection, "phase") && !phase)
    || !Number.isInteger(limit)
    || Number(limit) < 1
    || Number(limit) > MAX_SERENA_LIFECYCLE_RECALL_LIMIT
  ) return null;

  return {
    lifecycleKey,
    ...(phase ? { phase } : {}),
    limit: Number(limit),
  };
};

export const projectSerenaLifecycleReference = (
  value: unknown,
): SerenaLifecycleReference | null => {
  const reference = ownDataRecord(value, REFERENCE_FIELDS);
  if (!reference) return null;

  const projectFingerprintValue = canonicalHash(reference.projectFingerprint);
  const artifactId = canonicalUuid(reference.artifactId);
  const logicalId = canonicalHash(reference.logicalId);
  const recordKey = canonicalText(reference.recordKey, MAX_LIFECYCLE_RECORD_KEY_BYTES);
  const contentHash = canonicalHash(reference.contentHash);
  const requestHash = canonicalHash(reference.requestHash);
  const canonicalHashValue = canonicalHash(reference.canonicalHash);
  const lifecycleKey = canonicalText(reference.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  const phase = canonicalPhase(reference.phase);
  const nonce = canonicalUuid(reference.nonce);
  const memoryName = isSerenaLifecycleMemoryName(reference.memoryName)
    ? reference.memoryName
    : null;
  const expectedMemoryName = lifecycleKey && phase && artifactId
    ? serenaLifecycleMemoryName({ lifecycleKey, phase, artifactId })
    : null;
  const expectedLogicalId = lifecycleKey && phase && artifactId
    ? logicalIdFor({ lifecycleKey, phase, artifactId })
    : null;
  if (
    reference.schemaVersion !== SERENA_LIFECYCLE_SCHEMA_VERSION
    || reference.provider !== SERENA_LIFECYCLE_PROVIDER
    || !projectFingerprintValue
    || !artifactId
    || !logicalId
    || !recordKey
    || !contentHash
    || !requestHash
    || !canonicalHashValue
    || !lifecycleKey
    || !phase
    || !nonce
    || artifactId !== nonce
    || !memoryName
    || memoryName !== expectedMemoryName
    || logicalId !== expectedLogicalId
  ) return null;

  return {
    schemaVersion: 1,
    provider: SERENA_LIFECYCLE_PROVIDER,
    projectFingerprint: projectFingerprintValue,
    memoryName,
    artifactId,
    logicalId,
    recordKey,
    contentHash,
    requestHash,
    canonicalHash: canonicalHashValue,
    lifecycleKey,
    phase,
    nonce,
  };
};

const referenceFor = (record: SerenaLifecycleRecord): SerenaLifecycleReference => ({
  schemaVersion: 1,
  provider: SERENA_LIFECYCLE_PROVIDER,
  projectFingerprint: record.project.fingerprint,
  memoryName: record.memoryName,
  artifactId: record.artifactId,
  logicalId: record.logicalId,
  recordKey: record.recordKey,
  contentHash: record.contentHash,
  requestHash: record.requestHash,
  canonicalHash: record.canonicalHash,
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  nonce: record.nonce,
});

const detachedReference = (reference: SerenaLifecycleReference): SerenaLifecycleReference => ({
  schemaVersion: 1,
  provider: SERENA_LIFECYCLE_PROVIDER,
  projectFingerprint: reference.projectFingerprint,
  memoryName: reference.memoryName,
  artifactId: reference.artifactId,
  logicalId: reference.logicalId,
  recordKey: reference.recordKey,
  contentHash: reference.contentHash,
  requestHash: reference.requestHash,
  canonicalHash: reference.canonicalHash,
  lifecycleKey: reference.lifecycleKey,
  phase: reference.phase,
  nonce: reference.nonce,
});

const requestHashFor = (request: ValidLifecycleRequest) => digest(JSON.stringify({
  type: request.type,
  identity: detachedIdentity(request.identity),
  summary: request.summary,
  artifact: request.artifact,
}));

const originalArtifact = (input: {
  artifact: string;
  nonce: string;
  phase: LifecyclePhase;
  identity: LifecycleIdentity;
}): string | null => {
  const framed = buildLifecycleArtifactBody({
    type: input.phase,
    identity: input.identity,
    artifact: ORIGINAL_ARTIFACT_SENTINEL,
  });
  const sentinelIndex = framed.lastIndexOf(ORIGINAL_ARTIFACT_SENTINEL);
  if (sentinelIndex < 0) return null;

  const prefix = framed.slice(0, sentinelIndex);
  const suffix = framed.slice(sentinelIndex + ORIGINAL_ARTIFACT_SENTINEL.length);
  const marker = buildLifecycleNonceMarker({
    lifecycleKey: input.identity.lifecycleKey,
    nonce: input.nonce,
    type: input.phase,
    jiraKey: input.identity.jiraKey,
    taskwarriorUuid: input.identity.taskwarriorUuid,
    planeWorkspace: input.identity.planeWorkspace,
    planeWorkItem: input.identity.planeWorkItem,
  });
  const ending = `${suffix}${marker}\n`;
  return input.artifact.startsWith(prefix) && input.artifact.endsWith(ending)
    ? input.artifact.slice(prefix.length, -ending.length)
    : null;
};

const recordBase = (input: {
  project: SerenaLifecycleProject;
  memoryName: string;
  artifactId: string;
  logicalId: string;
  recordKey: string;
  contentHash: string;
  requestHash: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  nonce: string;
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
  createdAt: string;
}): RecordBase => ({
  schemaVersion: 1,
  provider: SERENA_LIFECYCLE_PROVIDER,
  namespace: SERENA_LIFECYCLE_NAMESPACE,
  project: detachedProject(input.project),
  memoryName: input.memoryName,
  artifactId: input.artifactId,
  logicalId: input.logicalId,
  recordKey: input.recordKey,
  contentHash: input.contentHash,
  requestHash: input.requestHash,
  lifecycleKey: input.lifecycleKey,
  phase: input.phase,
  nonce: input.nonce,
  identity: detachedIdentity(input.identity),
  summary: input.summary,
  artifact: input.artifact,
  createdAt: input.createdAt,
});

export const createSerenaLifecycleRecord = (input: {
  request: unknown;
  project: unknown;
  createdAt: unknown;
}): SerenaLifecyclePreparedRecord | null => {
  try {
    const request = normalizeSerenaLifecycleRequest(input.request);
    const project = normalizeSerenaLifecycleProject(input.project);
    const createdAt = canonicalTimestamp(input.createdAt);
    if (!request || !project || !createdAt) return null;

    const prepared = prepareLifecycleArtifact(request);
    if (!prepared.valid) return null;
    const artifactId = prepared.data.nonce;
    const memoryName = serenaLifecycleMemoryName({
      lifecycleKey: request.identity.lifecycleKey,
      phase: request.type,
      artifactId,
    });
    if (!memoryName) return null;

    const base = recordBase({
      project,
      memoryName,
      artifactId,
      logicalId: logicalIdFor({
        lifecycleKey: request.identity.lifecycleKey,
        phase: request.type,
        artifactId,
      }),
      recordKey: prepared.data.recordKey,
      contentHash: digest(prepared.data.artifact),
      requestHash: requestHashFor(request),
      lifecycleKey: request.identity.lifecycleKey,
      phase: request.type,
      nonce: prepared.data.nonce,
      identity: request.identity,
      summary: request.summary,
      artifact: prepared.data.artifact,
      createdAt,
    });
    const canonicalHashValue = digest(JSON.stringify(base));
    const record: SerenaLifecycleRecord = { ...base, canonicalHash: canonicalHashValue };
    const serialized = JSON.stringify(record);
    if (
      serialized.length > MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS
      || utf8ByteLength(serialized) > MAX_SERENA_LIFECYCLE_MEMORY_BYTES
    ) return null;

    const reference = projectSerenaLifecycleReference(referenceFor(record));
    return reference
      ? { ...record, serialized, reference }
      : null;
  } catch {
    return null;
  }
};

const parseStoredRecord = (content: unknown): SerenaLifecycleVerifiedRecord | null => {
  try {
    if (
      typeof content !== "string"
      || content.length > MAX_SERENA_LIFECYCLE_MEMORY_CHARACTERS
      || utf8ByteLength(content) > MAX_SERENA_LIFECYCLE_MEMORY_BYTES
    ) return null;

    const raw = ownDataRecord(JSON.parse(content), RECORD_FIELDS);
    if (!raw) return null;
    const project = projectSerenaLifecycleProject(raw.project);
    const memoryName = isSerenaLifecycleMemoryName(raw.memoryName) ? raw.memoryName : null;
    const artifactId = canonicalUuid(raw.artifactId);
    const logicalId = canonicalHash(raw.logicalId);
    const recordKey = canonicalText(raw.recordKey, MAX_LIFECYCLE_RECORD_KEY_BYTES);
    const contentHash = canonicalHash(raw.contentHash);
    const requestHash = canonicalHash(raw.requestHash);
    const canonicalHashValue = canonicalHash(raw.canonicalHash);
    const lifecycleKey = canonicalText(raw.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
    const phase = canonicalPhase(raw.phase);
    const nonce = canonicalUuid(raw.nonce);
    const identityProjection = projectIdentity(raw.identity);
    const summary = canonicalText(raw.summary, 2_000);
    const artifact = typeof raw.artifact === "string" ? raw.artifact : null;
    const createdAt = canonicalTimestamp(raw.createdAt);
    if (
      raw.schemaVersion !== SERENA_LIFECYCLE_SCHEMA_VERSION
      || raw.provider !== SERENA_LIFECYCLE_PROVIDER
      || raw.namespace !== SERENA_LIFECYCLE_NAMESPACE
      || !project
      || !memoryName
      || !artifactId
      || !logicalId
      || !recordKey
      || !contentHash
      || !requestHash
      || !canonicalHashValue
      || !lifecycleKey
      || !phase
      || !nonce
      || !identityProjection
      || !summary
      || !artifact
      || !createdAt
      || artifactId !== nonce
    ) return null;

    const placeholder = validateLifecycleWriteRequest({
      type: phase,
      identity: identityProjection,
      summary,
      artifact: "placeholder",
    });
    if (!placeholder.valid) return null;
    const identity = detachedIdentity(placeholder.identity);
    const payload = originalArtifact({ artifact, nonce, phase, identity });
    if (payload === null) return null;

    const request = validateLifecycleWriteRequest({
      type: phase,
      identity,
      summary,
      artifact: payload,
    });
    if (!request.valid) return null;
    const prepared = prepareLifecycleArtifact(request);
    const expectedMemoryName = serenaLifecycleMemoryName({
      lifecycleKey: request.identity.lifecycleKey,
      phase: request.type,
      artifactId,
    });
    const expectedLogicalId = logicalIdFor({
      lifecycleKey: request.identity.lifecycleKey,
      phase: request.type,
      artifactId,
    });
    if (
      !prepared.valid
      || artifact !== prepared.data.artifact
      || recordKey !== prepared.data.recordKey
      || nonce !== prepared.data.nonce
      || lifecycleKey !== request.identity.lifecycleKey
      || phase !== request.type
      || memoryName !== expectedMemoryName
      || logicalId !== expectedLogicalId
      || contentHash !== digest(artifact)
      || requestHash !== requestHashFor(request)
    ) return null;

    const base = recordBase({
      project,
      memoryName,
      artifactId,
      logicalId,
      recordKey,
      contentHash,
      requestHash,
      lifecycleKey,
      phase,
      nonce,
      identity: request.identity,
      summary: request.summary,
      artifact,
      createdAt,
    });
    if (canonicalHashValue !== digest(JSON.stringify(base))) return null;

    const record: SerenaLifecycleRecord = { ...base, canonicalHash: canonicalHashValue };
    if (content !== JSON.stringify(record)) return null;
    const reference = projectSerenaLifecycleReference(referenceFor(record));
    return reference
      ? {
        ...record,
        serialized: content,
        reference,
        request: detachedRequest(request),
      }
      : null;
  } catch {
    return null;
  }
};

const sameReference = (left: SerenaLifecycleReference, right: SerenaLifecycleReference) =>
  left.projectFingerprint === right.projectFingerprint
  && left.memoryName === right.memoryName
  && left.artifactId === right.artifactId
  && left.logicalId === right.logicalId
  && left.recordKey === right.recordKey
  && left.contentHash === right.contentHash
  && left.requestHash === right.requestHash
  && left.canonicalHash === right.canonicalHash
  && left.lifecycleKey === right.lifecycleKey
  && left.phase === right.phase
  && left.nonce === right.nonce;

const detachedVerifiedRecord = (record: SerenaLifecycleVerifiedRecord): SerenaLifecycleVerifiedRecord => ({
  schemaVersion: 1,
  provider: SERENA_LIFECYCLE_PROVIDER,
  namespace: SERENA_LIFECYCLE_NAMESPACE,
  project: detachedProject(record.project),
  memoryName: record.memoryName,
  artifactId: record.artifactId,
  logicalId: record.logicalId,
  recordKey: record.recordKey,
  contentHash: record.contentHash,
  requestHash: record.requestHash,
  canonicalHash: record.canonicalHash,
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  nonce: record.nonce,
  identity: detachedIdentity(record.identity),
  summary: record.summary,
  artifact: record.artifact,
  createdAt: record.createdAt,
  serialized: record.serialized,
  reference: detachedReference(record.reference),
  request: detachedRequest(record.request),
});

export const verifySerenaLifecycleRecord = (
  value: unknown,
): SerenaLifecycleVerifiedRecord | null => {
  try {
    const input = ownDataRecord(
      value,
      VERIFICATION_REQUIRED_FIELDS,
      VERIFICATION_OPTIONAL_FIELDS,
    ) as VerificationInput | null;
    if (!input) return null;

    const project = Object.hasOwn(input, "project")
      ? normalizeSerenaLifecycleProject(input.project)
      : null;
    const selection = Object.hasOwn(input, "selection")
      ? projectSerenaLifecycleSelection(input.selection)
      : null;
    const reference = Object.hasOwn(input, "reference")
      ? projectSerenaLifecycleReference(input.reference)
      : null;
    const expectedRequest = Object.hasOwn(input, "request")
      ? normalizeSerenaLifecycleRequest(input.request)
      : null;
    if (
      (Object.hasOwn(input, "project") && !project)
      || (Object.hasOwn(input, "selection") && !selection)
      || (Object.hasOwn(input, "reference") && !reference)
      || (Object.hasOwn(input, "request") && !expectedRequest)
    ) return null;

    const record = parseStoredRecord(input.content);
    if (!record) return null;
    if (
      (project && !sameProject(record.project, project))
      || (selection && (
        record.lifecycleKey !== selection.lifecycleKey
        || (selection.phase !== undefined && record.phase !== selection.phase)
      ))
      || (reference && !sameReference(record.reference, reference))
      || (expectedRequest && !sameRequest(record.request, expectedRequest))
    ) return null;

    return detachedVerifiedRecord(record);
  } catch {
    return null;
  }
};
