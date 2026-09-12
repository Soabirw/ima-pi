import {
  LIFECYCLE_PHASES,
  MAX_LIFECYCLE_KEY_BYTES,
  MAX_LIFECYCLE_RECORD_KEY_BYTES,
  MAX_LIFECYCLE_REFERENCES,
  MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES,
  prepareLifecycleArtifact,
  validateLifecycleRequest,
  type LifecyclePhase,
  type ValidLifecycleRequest,
} from "./ima-lifecycle.ts";
import {
  MAX_CREATED_AT_LENGTH,
  MAX_PROJECT_LENGTH,
  MAX_REPOSITORY_LENGTH,
  MAX_SITE_LENGTH,
  MAX_SOURCE_REFERENCES,
  MAX_SUMMARY_BYTES,
  deriveRecordId,
  normalizeInstitutionalRecord,
  utf8ByteLength,
} from "./qdrant-corpus.ts";
import { normalizeSourceReferences } from "./qdrant-corpus-contract.ts";
import { normalizeInstitutionalManifest } from "./qdrant-corpus-manifest.ts";

export const QDRANT_LIFECYCLE_PROVIDER = "qdrant";
export const QDRANT_LIFECYCLE_REFERENCE_SCHEMA_VERSION = 1;
export const QDRANT_LIFECYCLE_REPOSITORY = "ima-pi";
export const QDRANT_LIFECYCLE_SITE = "";
export const MAX_QDRANT_LIFECYCLE_RECALL_LIMIT = 20;

export type QdrantLifecycleSelection = {
  lifecycleKey: string;
  phase?: LifecyclePhase;
  limit: number;
};

export type QdrantLifecycleReference = {
  schemaVersion: 1;
  provider: "qdrant";
  artifactId: string;
  recordKey: string;
  contentHash: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  nonce: string;
};

export type QdrantLifecycleVerifiedRecord = {
  artifactId: string;
  recordKey: string;
  contentHash: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  nonce: string;
  project: string;
  summary: string;
  artifact: string;
  sourceRefs: string[];
  createdAt: string;
  storageSchemaVersion: 1 | 2;
  reference: QdrantLifecycleReference;
};

export type QdrantLifecycleRequestProjection = {
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

type ProjectedStoredRecord = {
  id: string;
  recordKey: string;
  contentHash: string;
  project: string;
  site: string;
  repo: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  summary: string;
  detail: string;
  sourceRefs: string[];
  createdAt: string;
};

type VerificationInput = {
  record: unknown;
  selection?: unknown;
  reference?: unknown;
  request?: unknown;
};

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PHASES = new Set<string>(LIFECYCLE_PHASES);
const RECORD_FIELDS = [
  "id",
  "recordKey",
  "project",
  "site",
  "repo",
  "lifecycleKey",
  "phase",
  "summary",
  "detail",
  "sourceRefs",
  "contentHash",
  "createdAt",
] as const;
const REFERENCE_FIELDS = [
  "schemaVersion",
  "provider",
  "artifactId",
  "recordKey",
  "contentHash",
  "lifecycleKey",
  "phase",
  "nonce",
] as const;
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
const SELECTION_REQUIRED_FIELDS = ["lifecycleKey"] as const;
const SELECTION_OPTIONAL_FIELDS = ["phase", "limit"] as const;
const VERIFICATION_REQUIRED_FIELDS = ["record"] as const;
const VERIFICATION_OPTIONAL_FIELDS = ["selection", "reference", "request"] as const;

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
    if (keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
    if (
      keys.length !== length + 1
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;

    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        return null;
      }
      values.push(descriptor.value);
    }
    return values;
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

const canonicalUuid = (value: unknown): string | null => {
  const candidate = canonicalText(value, 36);
  return candidate && UUID_PATTERN.test(candidate) ? candidate : null;
};

const canonicalHash = (value: unknown): string | null =>
  typeof value === "string" && HASH_PATTERN.test(value) ? value : null;

const canonicalPhase = (value: unknown): LifecyclePhase | null =>
  typeof value === "string" && PHASES.has(value) ? value as LifecyclePhase : null;

const sameArray = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const detachedRequest = (value: ValidLifecycleRequest): ValidLifecycleRequest => ({
  valid: true,
  type: value.type,
  identity: {
    project: value.identity.project,
    lifecycleKey: value.identity.lifecycleKey,
    lifecycleRootMemoryId: value.identity.lifecycleRootMemoryId,
    taskwarriorProject: value.identity.taskwarriorProject,
    taskwarriorTask: value.identity.taskwarriorTask,
    taskwarriorUuid: value.identity.taskwarriorUuid,
    jiraKey: value.identity.jiraKey,
    ...(value.identity.planeWorkspace && value.identity.planeWorkItem
      ? {
        planeWorkspace: value.identity.planeWorkspace,
        planeWorkItem: value.identity.planeWorkItem,
      }
      : {}),
    sourceRefs: [...value.identity.sourceRefs],
    priorArtifactIds: [...value.identity.priorArtifactIds],
  },
  summary: value.summary,
  artifact: value.artifact,
});

const projectStoredRecord = (value: unknown): ProjectedStoredRecord | null => {
  const record = ownDataRecord(value, RECORD_FIELDS);
  if (!record) return null;

  const id = canonicalUuid(record.id);
  const recordKey = canonicalText(record.recordKey, MAX_LIFECYCLE_RECORD_KEY_BYTES);
  const project = canonicalText(record.project, MAX_PROJECT_LENGTH);
  const site = canonicalText(record.site, MAX_SITE_LENGTH, true);
  const repo = canonicalText(record.repo, MAX_REPOSITORY_LENGTH, true);
  const lifecycleKey = canonicalText(record.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  const phase = canonicalPhase(record.phase);
  const summary = canonicalText(record.summary, MAX_SUMMARY_BYTES);
  const contentHash = canonicalHash(record.contentHash);
  const createdAt = canonicalText(record.createdAt, MAX_CREATED_AT_LENGTH);
  const sourceRefs = ownDataArray(record.sourceRefs, MAX_SOURCE_REFERENCES);
  const detail = typeof record.detail === "string"
    && record.detail.length > 0
    && utf8ByteLength(record.detail) <= MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES
    ? record.detail
    : null;

  if (
    !id
    || !recordKey
    || !project
    || site === null
    || repo === null
    || !lifecycleKey
    || !phase
    || !summary
    || !contentHash
    || !createdAt
    || !detail
    || !sourceRefs
    || !sourceRefs.every((reference) => typeof reference === "string")
  ) return null;

  const normalizedSourceRefs = normalizeSourceReferences(sourceRefs);
  const derivedId = deriveRecordId(recordKey);
  if (
    !normalizedSourceRefs
    || !sameArray(sourceRefs as string[], normalizedSourceRefs)
    || !derivedId.success
    || derivedId.data !== id
  ) return null;

  return {
    id,
    recordKey,
    contentHash,
    project,
    site,
    repo,
    lifecycleKey,
    phase,
    summary,
    detail,
    sourceRefs: [...normalizedSourceRefs],
    createdAt,
  };
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

const parseReferenceList = (
  lines: string[],
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
    if (value === null) return null;
    values.push(value);
    next += 1;
  }
  return values.length ? { values, next } : null;
};

const parseSerializedRequest = (detail: string): { request: ValidLifecycleRequest } | null => {
  const headerDelimiter = "\n---\n\n";
  const delimiterIndex = detail.indexOf(headerDelimiter);
  if (delimiterIndex < 0) return null;
  const header = detail.slice(0, delimiterIndex);
  const markerIndex = detail.lastIndexOf("\n<!-- ima-lifecycle verification: ");
  const artifactStart = delimiterIndex + headerDelimiter.length;
  if (markerIndex < artifactStart) return null;

  const artifactWithSpacing = detail.slice(artifactStart, markerIndex + 1);
  if (!artifactWithSpacing.endsWith("\n\n")) return null;
  const artifact = artifactWithSpacing.slice(0, -2);
  const lines = header.split("\n");
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

  const sourceRefs = parseReferenceList(lines, index, "source_refs");
  if (!sourceRefs) return null;
  index = sourceRefs.next;
  const type = nextQuoted("  phase: ");
  if (type === null) return null;
  const priorArtifactIds = parseReferenceList(lines, index, "prior_artifact_ids");
  if (!priorArtifactIds || priorArtifactIds.next !== lines.length) return null;

  const request = validateLifecycleRequest({
    type,
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
    summary: "placeholder",
    artifact,
  });
  return request.valid ? { request: detachedRequest(request) } : null;
};

const parsedRequestWithSummary = (
  detail: string,
  summary: string,
): { request: ValidLifecycleRequest; artifact: string; nonce: string; recordKey: string } | null => {
  const parsed = parseSerializedRequest(detail);
  if (!parsed) return null;

  const request = validateLifecycleRequest({
    type: parsed.request.type,
    identity: parsed.request.identity,
    summary,
    artifact: parsed.request.artifact,
  });
  if (!request.valid) return null;
  const prepared = prepareLifecycleArtifact(request);
  return prepared.valid
    ? {
      request: detachedRequest(request),
      artifact: prepared.data.artifact,
      nonce: prepared.data.nonce,
      recordKey: prepared.data.recordKey,
    }
    : null;
};

const storageSchemaVersion = (record: ProjectedStoredRecord): 1 | 2 | null => {
  const input = {
    recordKey: record.recordKey,
    project: record.project,
    site: record.site,
    repo: record.repo,
    lifecycleKey: record.lifecycleKey,
    phase: record.phase,
    summary: record.summary,
    detail: record.detail,
    sourceRefs: record.sourceRefs,
  };
  const v1 = normalizeInstitutionalRecord(input, record.createdAt);
  if (
    v1.success
    && v1.data.id === record.id
    && v1.data.recordKey === record.recordKey
    && v1.data.payload.content_hash === record.contentHash
  ) return 1;

  const v2 = normalizeInstitutionalManifest(input, record.createdAt);
  return v2.success
    && v2.data.id === record.id
    && v2.data.recordKey === record.recordKey
    && v2.data.payload.content_hash === record.contentHash
    ? 2
    : null;
};

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

export const projectQdrantLifecycleRequest = (
  value: unknown,
): QdrantLifecycleRequestProjection | null => {
  const request = ownDataRecord(value, REQUEST_FIELDS);
  if (!request) return null;

  const identity = ownDataRecord(
    request.identity,
    IDENTITY_REQUIRED_FIELDS,
    IDENTITY_OPTIONAL_FIELDS,
  );
  if (!identity) return null;

  const hasPlaneWorkspace = Object.hasOwn(identity, "planeWorkspace");
  const hasPlaneWorkItem = Object.hasOwn(identity, "planeWorkItem");
  if (hasPlaneWorkspace !== hasPlaneWorkItem) return null;

  const sourceRefs = ownDataArray(identity.sourceRefs, MAX_LIFECYCLE_REFERENCES);
  const priorArtifactIds = ownDataArray(identity.priorArtifactIds, MAX_LIFECYCLE_REFERENCES);
  if (!sourceRefs || !priorArtifactIds) return null;

  return {
    type: request.type,
    identity: {
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
    },
    summary: request.summary,
    artifact: request.artifact,
  };
};

export const projectQdrantLifecycleSelection = (
  value: unknown,
): QdrantLifecycleSelection | null => {
  const selection = ownDataRecord(value, SELECTION_REQUIRED_FIELDS, SELECTION_OPTIONAL_FIELDS);
  if (!selection) return null;

  const lifecycleKey = canonicalText(selection.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  const phase = Object.hasOwn(selection, "phase")
    ? canonicalPhase(selection.phase)
    : undefined;
  const limit = Object.hasOwn(selection, "limit")
    ? selection.limit
    : MAX_QDRANT_LIFECYCLE_RECALL_LIMIT;
  if (
    !lifecycleKey
    || (Object.hasOwn(selection, "phase") && !phase)
    || !Number.isInteger(limit)
    || Number(limit) < 1
    || Number(limit) > MAX_QDRANT_LIFECYCLE_RECALL_LIMIT
  ) return null;

  return {
    lifecycleKey,
    ...(phase ? { phase } : {}),
    limit: Number(limit),
  };
};

export const projectQdrantLifecycleReference = (
  value: unknown,
): QdrantLifecycleReference | null => {
  const reference = ownDataRecord(value, REFERENCE_FIELDS);
  if (!reference) return null;

  const artifactId = canonicalUuid(reference.artifactId);
  const recordKey = canonicalText(reference.recordKey, MAX_LIFECYCLE_RECORD_KEY_BYTES);
  const contentHash = canonicalHash(reference.contentHash);
  const lifecycleKey = canonicalText(reference.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  const phase = canonicalPhase(reference.phase);
  const nonce = canonicalUuid(reference.nonce);
  const derivedId = recordKey ? deriveRecordId(recordKey) : null;
  if (
    reference.schemaVersion !== QDRANT_LIFECYCLE_REFERENCE_SCHEMA_VERSION
    || reference.provider !== QDRANT_LIFECYCLE_PROVIDER
    || !artifactId
    || !recordKey
    || !contentHash
    || !lifecycleKey
    || !phase
    || !nonce
    || !derivedId?.success
    || derivedId.data !== artifactId
  ) return null;

  return {
    schemaVersion: 1,
    provider: "qdrant",
    artifactId,
    recordKey,
    contentHash,
    lifecycleKey,
    phase,
    nonce,
  };
};

export const verifyQdrantLifecycleRecord = (
  value: unknown,
): QdrantLifecycleVerifiedRecord | null => {
  try {
    const input = ownDataRecord(value, VERIFICATION_REQUIRED_FIELDS, VERIFICATION_OPTIONAL_FIELDS) as VerificationInput | null;
    if (!input) return null;

    const record = projectStoredRecord(input.record);
    const selection = Object.hasOwn(input, "selection")
      ? projectQdrantLifecycleSelection(input.selection)
      : null;
    const reference = Object.hasOwn(input, "reference")
      ? projectQdrantLifecycleReference(input.reference)
      : null;
    const expectedRequestInput = Object.hasOwn(input, "request")
      ? projectQdrantLifecycleRequest(input.request)
      : null;
    const expectedRequest = expectedRequestInput
      ? validateLifecycleRequest(expectedRequestInput)
      : null;
    if (
      !record
      || (Object.hasOwn(input, "selection") && !selection)
      || (Object.hasOwn(input, "reference") && !reference)
      || (Object.hasOwn(input, "request") && (!expectedRequest || !expectedRequest.valid))
    ) return null;

    const parsed = parsedRequestWithSummary(record.detail, record.summary);
    const schemaVersion = storageSchemaVersion(record);
    if (!parsed || !schemaVersion) return null;

    const expectedArtifact = schemaVersion === 1
      ? parsed.artifact.trim()
      : parsed.artifact;
    const expectedSourceRefs = normalizeSourceReferences(parsed.request.identity.sourceRefs);
    if (
      record.detail !== expectedArtifact
      || record.recordKey !== parsed.recordKey
      || record.lifecycleKey !== parsed.request.identity.lifecycleKey
      || record.phase !== parsed.request.type
      || record.summary !== parsed.request.summary
      || record.project !== parsed.request.identity.project
      || record.site !== QDRANT_LIFECYCLE_SITE
      || record.repo !== QDRANT_LIFECYCLE_REPOSITORY
      || !expectedSourceRefs
      || !sameArray(record.sourceRefs, expectedSourceRefs)
    ) return null;

    if (
      selection
      && (
        record.lifecycleKey !== selection.lifecycleKey
        || (selection.phase !== undefined && record.phase !== selection.phase)
      )
    ) return null;

    const resolvedReference: QdrantLifecycleReference = {
      schemaVersion: 1,
      provider: "qdrant",
      artifactId: record.id,
      recordKey: record.recordKey,
      contentHash: record.contentHash,
      lifecycleKey: record.lifecycleKey,
      phase: record.phase,
      nonce: parsed.nonce,
    };
    if (
      reference
      && (
        reference.artifactId !== resolvedReference.artifactId
        || reference.recordKey !== resolvedReference.recordKey
        || reference.contentHash !== resolvedReference.contentHash
        || reference.lifecycleKey !== resolvedReference.lifecycleKey
        || reference.phase !== resolvedReference.phase
        || reference.nonce !== resolvedReference.nonce
      )
    ) return null;

    if (expectedRequest?.valid && !sameRequest(detachedRequest(expectedRequest), parsed.request)) {
      return null;
    }

    return {
      artifactId: record.id,
      recordKey: record.recordKey,
      contentHash: record.contentHash,
      lifecycleKey: record.lifecycleKey,
      phase: record.phase,
      nonce: parsed.nonce,
      project: record.project,
      summary: record.summary,
      artifact: record.detail,
      sourceRefs: [...record.sourceRefs],
      createdAt: record.createdAt,
      storageSchemaVersion: schemaVersion,
      reference: resolvedReference,
    };
  } catch {
    return null;
  }
};
