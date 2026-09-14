import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  LIFECYCLE_PHASES,
  MAX_LIFECYCLE_KEY_BYTES,
  MAX_LIFECYCLE_REFERENCES,
  MAX_LIFECYCLE_SUMMARY_BYTES,
  MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES,
  evaluateLifecycleArtifact,
  prepareLifecycleArtifact,
  validateLifecycleWriteRequest,
  type LifecycleIdentity,
  type LifecyclePhase,
} from "./ima-lifecycle.ts";

export const MARKDOWN_LIFECYCLE_PROVIDER = "markdown";
export const MARKDOWN_LIFECYCLE_SCHEMA_VERSION = 1;
export const MARKDOWN_LIFECYCLE_DIRECTORY_VERSION = "v1";
export const MARKDOWN_LIFECYCLE_ROOT = ".ima/lifecycle/markdown/v1";
export const MAX_MARKDOWN_LIFECYCLE_CHECKOUT_ROOT_BYTES = 4_096;
export const MAX_MARKDOWN_LIFECYCLE_ARTIFACT_BYTES = MAX_SERIALIZED_LIFECYCLE_ARTIFACT_BYTES;
export const MAX_MARKDOWN_LIFECYCLE_RECEIPT_BYTES = 128 * 1024;
export const MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT = 20;
export const MAX_MARKDOWN_LIFECYCLE_ENUMERATION = 10_000;

export type MarkdownLifecycleIdentityProjection = {
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

export type MarkdownLifecycleRequestProjection = {
  schemaVersion: unknown;
  phase: unknown;
  identity: MarkdownLifecycleIdentityProjection;
  summary: unknown;
  artifact: unknown;
  expectedHash: unknown;
};

export type MarkdownLifecycleRequest = {
  schemaVersion: 1;
  phase: LifecyclePhase;
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
  expectedHash: string;
};

export type MarkdownLifecycleReceipt = {
  schemaVersion: 1;
  provider: "markdown";
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  identity: LifecycleIdentity;
  summary: string;
  contentHash: string;
};

export type MarkdownLifecycleReference = {
  schemaVersion: 1;
  provider: "markdown";
  checkoutRoot: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  contentHash: string;
  receiptHash: string;
};

export type MarkdownLifecycleSelection = {
  lifecycleKey: string;
  phase?: LifecyclePhase;
  limit: number;
};

export type MarkdownLifecyclePreparedRecord = {
  schemaVersion: 1;
  provider: "markdown";
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
  contentHash: string;
  receipt: MarkdownLifecycleReceipt;
  serializedReceipt: string;
  receiptHash: string;
};

export type MarkdownLifecycleVerifiedRecord = MarkdownLifecyclePreparedRecord & {
  checkoutRoot: string;
  reference: MarkdownLifecycleReference;
};

export type MarkdownLifecycleRecordFailureCode =
  | "markdown_request_invalid"
  | "markdown_secret_detected";

export type MarkdownLifecycleRecordResult =
  | { valid: true; data: MarkdownLifecyclePreparedRecord }
  | { valid: false; code: MarkdownLifecycleRecordFailureCode };

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHASES = new Set<string>(LIFECYCLE_PHASES);
const REQUEST_FIELDS = [
  "schemaVersion",
  "phase",
  "identity",
  "summary",
  "artifact",
  "expectedHash",
] as const;
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
const RECEIPT_FIELDS = [
  "schemaVersion",
  "provider",
  "lifecycleKey",
  "phase",
  "artifactId",
  "identity",
  "summary",
  "contentHash",
] as const;
const REFERENCE_FIELDS = [
  "schemaVersion",
  "provider",
  "checkoutRoot",
  "lifecycleKey",
  "phase",
  "artifactId",
  "contentHash",
  "receiptHash",
] as const;
const SELECTION_REQUIRED_FIELDS = ["lifecycleKey"] as const;
const SELECTION_OPTIONAL_FIELDS = ["phase", "limit"] as const;
const VERIFY_FIELDS = ["artifact", "receipt", "checkoutRoot"] as const;
const SECRET_ASSIGNMENT = "(?:authorization|token|secret|password|api[_-]?key|access[_-]?token|client[_-]?secret|private(?:[_ -]?key))";
const SECRET_PATTERN = new RegExp(
  `(?:\\b${SECRET_ASSIGNMENT}\\b\\s*[:=]\\s*(?:bearer\\s+)?\\S+|\\bbearer\\s+\\S+|-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----)`,
  "i",
);

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const isExactUtf8 = (value: string) => Buffer.from(value, "utf8").toString("utf8") === value;

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
  && value.length <= maximumBytes
  && value === value.trim()
  && (allowEmpty || value.length > 0)
  && !CONTROL_CHARACTER.test(value)
  && isExactUtf8(value)
  && byteLength(value) <= maximumBytes
  ? value
  : null;

const canonicalPhase = (value: unknown): LifecyclePhase | null =>
  typeof value === "string" && PHASES.has(value) ? value as LifecyclePhase : null;

const canonicalHash = (value: unknown): string | null =>
  typeof value === "string" && HASH_PATTERN.test(value) ? value : null;

const canonicalArtifactId = (value: unknown): string | null => {
  const candidate = canonicalText(value, 36);
  return candidate && ARTIFACT_ID_PATTERN.test(candidate) ? candidate : null;
};

export const canonicalMarkdownCheckoutRoot = (value: unknown): string | null => {
  const candidate = canonicalText(value, MAX_MARKDOWN_LIFECYCLE_CHECKOUT_ROOT_BYTES);
  return candidate && isAbsolute(candidate) && resolve(candidate) === candidate
    ? candidate
    : null;
};

/**
 * Callers remain responsible for never supplying credentials in lifecycle data.
 * This guard rejects only recognized assignment, Bearer, and private-key forms;
 * it deliberately does not redact or transform a supplied value.
 */
export const containsRecognizedMarkdownLifecycleSecret = (value: unknown) =>
  typeof value === "string" && SECRET_PATTERN.test(value);

const containsSecret = (values: readonly unknown[]) =>
  values.some((value) => containsRecognizedMarkdownLifecycleSecret(value));

const projectIdentity = (value: unknown): MarkdownLifecycleIdentityProjection | null => {
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

export const projectMarkdownLifecycleRequest = (
  value: unknown,
): MarkdownLifecycleRequestProjection | null => {
  const request = ownDataRecord(value, REQUEST_FIELDS);
  if (!request) return null;

  const identity = projectIdentity(request.identity);
  return identity
    ? {
      schemaVersion: request.schemaVersion,
      phase: request.phase,
      identity,
      summary: request.summary,
      artifact: request.artifact,
      expectedHash: request.expectedHash,
    }
    : null;
};

export const projectMarkdownLifecycleReceipt = (
  value: unknown,
): MarkdownLifecycleReceipt | null => {
  const receipt = ownDataRecord(value, RECEIPT_FIELDS);
  if (!receipt) return null;

  const lifecycleKey = canonicalText(receipt.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  const phase = canonicalPhase(receipt.phase);
  const artifactId = canonicalArtifactId(receipt.artifactId);
  const identity = projectIdentity(receipt.identity);
  const summary = canonicalText(receipt.summary, MAX_LIFECYCLE_SUMMARY_BYTES);
  const contentHash = canonicalHash(receipt.contentHash);
  if (
    receipt.schemaVersion !== MARKDOWN_LIFECYCLE_SCHEMA_VERSION
    || receipt.provider !== MARKDOWN_LIFECYCLE_PROVIDER
    || !lifecycleKey
    || !phase
    || !artifactId
    || !identity
    || !summary
    || !contentHash
  ) return null;

  const placeholder = validateLifecycleWriteRequest({
    type: phase,
    identity,
    summary,
    artifact: "placeholder",
  });
  if (!placeholder.valid || placeholder.identity.lifecycleKey !== lifecycleKey) return null;

  return {
    schemaVersion: 1,
    provider: MARKDOWN_LIFECYCLE_PROVIDER,
    lifecycleKey,
    phase,
    artifactId,
    identity: detachedIdentity(placeholder.identity),
    summary,
    contentHash,
  };
};

export const projectMarkdownLifecycleReference = (
  value: unknown,
): MarkdownLifecycleReference | null => {
  const reference = ownDataRecord(value, REFERENCE_FIELDS);
  if (!reference) return null;

  const checkoutRoot = canonicalMarkdownCheckoutRoot(reference.checkoutRoot);
  const lifecycleKey = canonicalText(reference.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  const phase = canonicalPhase(reference.phase);
  const artifactId = canonicalArtifactId(reference.artifactId);
  const contentHash = canonicalHash(reference.contentHash);
  const receiptHash = canonicalHash(reference.receiptHash);
  if (
    reference.schemaVersion !== MARKDOWN_LIFECYCLE_SCHEMA_VERSION
    || reference.provider !== MARKDOWN_LIFECYCLE_PROVIDER
    || !checkoutRoot
    || !lifecycleKey
    || !phase
    || !artifactId
    || !contentHash
    || !receiptHash
  ) return null;

  return {
    schemaVersion: 1,
    provider: MARKDOWN_LIFECYCLE_PROVIDER,
    checkoutRoot,
    lifecycleKey,
    phase,
    artifactId,
    contentHash,
    receiptHash,
  };
};

export const projectMarkdownLifecycleSelection = (
  value: unknown,
): MarkdownLifecycleSelection | null => {
  const selection = ownDataRecord(value, SELECTION_REQUIRED_FIELDS, SELECTION_OPTIONAL_FIELDS);
  if (!selection) return null;

  const lifecycleKey = canonicalText(selection.lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  const phase = Object.hasOwn(selection, "phase")
    ? canonicalPhase(selection.phase)
    : undefined;
  const limit = Object.hasOwn(selection, "limit")
    ? selection.limit
    : MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT;
  if (
    !lifecycleKey
    || (Object.hasOwn(selection, "phase") && !phase)
    || !Number.isInteger(limit)
    || Number(limit) < 1
    || Number(limit) > MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT
  ) return null;

  return {
    lifecycleKey,
    ...(phase ? { phase } : {}),
    limit: Number(limit),
  };
};

export const markdownLifecycleDirectoryName = (lifecycleKey: unknown): string | null => {
  const canonical = canonicalText(lifecycleKey, MAX_LIFECYCLE_KEY_BYTES);
  return canonical && !containsRecognizedMarkdownLifecycleSecret(canonical)
    ? digest(canonical)
    : null;
};

export const markdownLifecycleArtifactName = (input: {
  phase: unknown;
  artifactId: unknown;
}): string | null => {
  const phase = canonicalPhase(input.phase);
  const artifactId = canonicalArtifactId(input.artifactId);
  return phase && artifactId ? `${phase}-${artifactId}.md` : null;
};

export const markdownLifecycleReceiptName = (input: {
  phase: unknown;
  artifactId: unknown;
}): string | null => {
  const phase = canonicalPhase(input.phase);
  const artifactId = canonicalArtifactId(input.artifactId);
  return phase && artifactId ? `${phase}-${artifactId}.commit.json` : null;
};

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

const detachedReceipt = (receipt: MarkdownLifecycleReceipt): MarkdownLifecycleReceipt => ({
  schemaVersion: 1,
  provider: MARKDOWN_LIFECYCLE_PROVIDER,
  lifecycleKey: receipt.lifecycleKey,
  phase: receipt.phase,
  artifactId: receipt.artifactId,
  identity: detachedIdentity(receipt.identity),
  summary: receipt.summary,
  contentHash: receipt.contentHash,
});

export const detachedMarkdownLifecycleReference = (
  reference: MarkdownLifecycleReference,
): MarkdownLifecycleReference => ({
  schemaVersion: 1,
  provider: MARKDOWN_LIFECYCLE_PROVIDER,
  checkoutRoot: reference.checkoutRoot,
  lifecycleKey: reference.lifecycleKey,
  phase: reference.phase,
  artifactId: reference.artifactId,
  contentHash: reference.contentHash,
  receiptHash: reference.receiptHash,
});

const sameArray = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameIdentityProjection = (
  projection: MarkdownLifecycleIdentityProjection,
  identity: LifecycleIdentity,
) => projection.project === identity.project
  && projection.lifecycleKey === identity.lifecycleKey
  && projection.lifecycleRootMemoryId === identity.lifecycleRootMemoryId
  && projection.taskwarriorProject === identity.taskwarriorProject
  && projection.taskwarriorTask === identity.taskwarriorTask
  && projection.taskwarriorUuid === identity.taskwarriorUuid
  && projection.jiraKey === identity.jiraKey
  && projection.planeWorkspace === identity.planeWorkspace
  && projection.planeWorkItem === identity.planeWorkItem
  && sameArray(projection.sourceRefs, identity.sourceRefs)
  && sameArray(projection.priorArtifactIds, identity.priorArtifactIds);

const sameIdentity = (left: LifecycleIdentity, right: LifecycleIdentity) =>
  left.project === right.project
  && left.lifecycleKey === right.lifecycleKey
  && left.lifecycleRootMemoryId === right.lifecycleRootMemoryId
  && left.taskwarriorProject === right.taskwarriorProject
  && left.taskwarriorTask === right.taskwarriorTask
  && left.taskwarriorUuid === right.taskwarriorUuid
  && left.jiraKey === right.jiraKey
  && left.planeWorkspace === right.planeWorkspace
  && left.planeWorkItem === right.planeWorkItem
  && sameArray(left.sourceRefs, right.sourceRefs)
  && sameArray(left.priorArtifactIds, right.priorArtifactIds);

const requestValuesContainSecret = (request: MarkdownLifecycleRequestProjection) =>
  containsSecret([
    request.phase,
    request.summary,
    request.artifact,
    request.expectedHash,
    request.identity.project,
    request.identity.lifecycleKey,
    request.identity.lifecycleRootMemoryId,
    request.identity.taskwarriorProject,
    request.identity.taskwarriorTask,
    request.identity.taskwarriorUuid,
    request.identity.jiraKey,
    request.identity.planeWorkspace,
    request.identity.planeWorkItem,
    ...request.identity.sourceRefs,
    ...request.identity.priorArtifactIds,
  ]);

const receiptValuesContainSecret = (receipt: MarkdownLifecycleReceipt) =>
  containsSecret([
    receipt.lifecycleKey,
    receipt.phase,
    receipt.artifactId,
    receipt.summary,
    receipt.contentHash,
    receipt.identity.project,
    receipt.identity.lifecycleKey,
    receipt.identity.lifecycleRootMemoryId,
    receipt.identity.taskwarriorProject,
    receipt.identity.taskwarriorTask,
    receipt.identity.taskwarriorUuid,
    receipt.identity.jiraKey,
    receipt.identity.planeWorkspace,
    receipt.identity.planeWorkItem,
    ...receipt.identity.sourceRefs,
    ...receipt.identity.priorArtifactIds,
  ]);

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
    if (value === null || values.length >= MAX_LIFECYCLE_REFERENCES) return null;
    values.push(value);
    next += 1;
  }
  return values.length ? { values, next } : null;
};

type ParsedPreparedArtifact = {
  phase: string;
  identity: MarkdownLifecycleIdentityProjection;
  payload: string;
};

const parsePreparedArtifact = (artifact: string): ParsedPreparedArtifact | null => {
  const headerDelimiter = "\n---\n\n";
  const markerPrefix = "\n<!-- ima-lifecycle verification: ";
  if (!artifact.startsWith("---\nlifecycle:\n")) return null;

  const delimiterIndex = artifact.indexOf(headerDelimiter);
  if (delimiterIndex < 0) return null;
  const markerIndex = artifact.lastIndexOf(markerPrefix);
  const artifactStart = delimiterIndex + headerDelimiter.length;
  if (markerIndex < artifactStart) return null;

  const payloadWithSpacing = artifact.slice(artifactStart, markerIndex + 1);
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

  const sourceRefs = parseReferenceList(lines, index, "source_refs");
  if (!sourceRefs) return null;
  index = sourceRefs.next;
  const phase = nextQuoted("  phase: ");
  if (phase === null) return null;
  const priorArtifactIds = parseReferenceList(lines, index, "prior_artifact_ids");
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

const receiptFor = (input: {
  phase: LifecyclePhase;
  artifactId: string;
  identity: LifecycleIdentity;
  summary: string;
  contentHash: string;
}): MarkdownLifecycleReceipt => ({
  schemaVersion: 1,
  provider: MARKDOWN_LIFECYCLE_PROVIDER,
  lifecycleKey: input.identity.lifecycleKey,
  phase: input.phase,
  artifactId: input.artifactId,
  identity: detachedIdentity(input.identity),
  summary: input.summary,
  contentHash: input.contentHash,
});

export const serializeMarkdownLifecycleReceipt = (receipt: MarkdownLifecycleReceipt) =>
  `${JSON.stringify({
    schemaVersion: 1,
    provider: MARKDOWN_LIFECYCLE_PROVIDER,
    lifecycleKey: receipt.lifecycleKey,
    phase: receipt.phase,
    artifactId: receipt.artifactId,
    identity: detachedIdentity(receipt.identity),
    summary: receipt.summary,
    contentHash: receipt.contentHash,
  })}\n`;

const parseMarkdownLifecycleReceipt = (content: unknown): MarkdownLifecycleReceipt | null => {
  if (
    typeof content !== "string"
    || content.length > MAX_MARKDOWN_LIFECYCLE_RECEIPT_BYTES
    || byteLength(content) > MAX_MARKDOWN_LIFECYCLE_RECEIPT_BYTES
  ) return null;

  try {
    const receipt = projectMarkdownLifecycleReceipt(JSON.parse(content));
    return receipt
      && !receiptValuesContainSecret(receipt)
      && serializeMarkdownLifecycleReceipt(receipt) === content
      ? detachedReceipt(receipt)
      : null;
  } catch {
    return null;
  }
};

export const createMarkdownLifecycleRecord = (
  value: unknown,
): MarkdownLifecycleRecordResult => {
  try {
    const projection = projectMarkdownLifecycleRequest(value);
    if (!projection) return { valid: false, code: "markdown_request_invalid" };
    if (requestValuesContainSecret(projection)) {
      return { valid: false, code: "markdown_secret_detected" };
    }

    const phase = canonicalPhase(projection.phase);
    const summary = canonicalText(projection.summary, MAX_LIFECYCLE_SUMMARY_BYTES);
    const expectedHash = canonicalHash(projection.expectedHash);
    const artifact = typeof projection.artifact === "string"
      && projection.artifact.length <= MAX_MARKDOWN_LIFECYCLE_ARTIFACT_BYTES
      && isExactUtf8(projection.artifact)
      && byteLength(projection.artifact) <= MAX_MARKDOWN_LIFECYCLE_ARTIFACT_BYTES
      ? projection.artifact
      : null;
    if (
      projection.schemaVersion !== MARKDOWN_LIFECYCLE_SCHEMA_VERSION
      || !phase
      || !summary
      || !expectedHash
      || !artifact
      || digest(artifact) !== expectedHash
    ) return { valid: false, code: "markdown_request_invalid" };

    const parsed = parsePreparedArtifact(artifact);
    if (!parsed) return { valid: false, code: "markdown_request_invalid" };
    const validated = validateLifecycleWriteRequest({
      type: parsed.phase,
      identity: parsed.identity,
      summary,
      artifact: parsed.payload,
    });
    if (!validated.valid) return { valid: false, code: "markdown_request_invalid" };

    const prepared = prepareLifecycleArtifact(validated);
    const proof = prepared.valid
      ? evaluateLifecycleArtifact({
        artifact,
        lifecycleKey: validated.identity.lifecycleKey,
        nonce: prepared.data.nonce,
        type: validated.type,
        jiraKey: validated.identity.jiraKey,
        taskwarriorUuid: validated.identity.taskwarriorUuid,
        planeWorkspace: validated.identity.planeWorkspace,
        planeWorkItem: validated.identity.planeWorkItem,
      })
      : null;
    if (
      !prepared.valid
      || validated.type !== phase
      || validated.summary !== summary
      || !sameIdentityProjection(projection.identity, validated.identity)
      || prepared.data.artifact !== artifact
      || !proof?.matched
    ) return { valid: false, code: "markdown_request_invalid" };

    const receipt = receiptFor({
      phase: validated.type,
      artifactId: prepared.data.nonce,
      identity: validated.identity,
      summary: validated.summary,
      contentHash: expectedHash,
    });
    const serializedReceipt = serializeMarkdownLifecycleReceipt(receipt);
    if (byteLength(serializedReceipt) > MAX_MARKDOWN_LIFECYCLE_RECEIPT_BYTES) {
      return { valid: false, code: "markdown_request_invalid" };
    }

    return {
      valid: true,
      data: {
        schemaVersion: 1,
        provider: MARKDOWN_LIFECYCLE_PROVIDER,
        lifecycleKey: validated.identity.lifecycleKey,
        phase: validated.type,
        artifactId: prepared.data.nonce,
        identity: detachedIdentity(validated.identity),
        summary: validated.summary,
        artifact,
        contentHash: expectedHash,
        receipt: detachedReceipt(receipt),
        serializedReceipt,
        receiptHash: digest(serializedReceipt),
      },
    };
  } catch {
    return { valid: false, code: "markdown_request_invalid" };
  }
};

export const markdownLifecycleReferenceFor = (input: {
  checkoutRoot: unknown;
  record: MarkdownLifecyclePreparedRecord;
}): MarkdownLifecycleReference | null => {
  const checkoutRoot = canonicalMarkdownCheckoutRoot(input.checkoutRoot);
  if (!checkoutRoot) return null;
  return {
    schemaVersion: 1,
    provider: MARKDOWN_LIFECYCLE_PROVIDER,
    checkoutRoot,
    lifecycleKey: input.record.lifecycleKey,
    phase: input.record.phase,
    artifactId: input.record.artifactId,
    contentHash: input.record.contentHash,
    receiptHash: input.record.receiptHash,
  };
};

export const sameMarkdownLifecycleReference = (
  left: MarkdownLifecycleReference,
  right: MarkdownLifecycleReference,
) => left.checkoutRoot === right.checkoutRoot
  && left.lifecycleKey === right.lifecycleKey
  && left.phase === right.phase
  && left.artifactId === right.artifactId
  && left.contentHash === right.contentHash
  && left.receiptHash === right.receiptHash;

export const verifyMarkdownLifecycleRecord = (
  value: unknown,
): MarkdownLifecycleVerifiedRecord | null => {
  try {
    const input = ownDataRecord(value, VERIFY_FIELDS);
    if (!input || containsSecret([input.checkoutRoot])) return null;
    const checkoutRoot = canonicalMarkdownCheckoutRoot(input.checkoutRoot);
    const receipt = parseMarkdownLifecycleReceipt(input.receipt);
    if (!checkoutRoot || !receipt) return null;

    const prepared = createMarkdownLifecycleRecord({
      schemaVersion: 1,
      phase: receipt.phase,
      identity: receipt.identity,
      summary: receipt.summary,
      artifact: input.artifact,
      expectedHash: receipt.contentHash,
    });
    if (
      !prepared.valid
      || prepared.data.artifactId !== receipt.artifactId
      || prepared.data.serializedReceipt !== input.receipt
      || !sameIdentity(prepared.data.identity, receipt.identity)
      || prepared.data.lifecycleKey !== receipt.lifecycleKey
    ) return null;

    const reference = markdownLifecycleReferenceFor({ checkoutRoot, record: prepared.data });
    return reference
      ? {
        ...prepared.data,
        identity: detachedIdentity(prepared.data.identity),
        receipt: detachedReceipt(prepared.data.receipt),
        checkoutRoot,
        reference: detachedMarkdownLifecycleReference(reference),
      }
      : null;
  } catch {
    return null;
  }
};
