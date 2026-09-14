import { createHash } from "node:crypto";
import {
  buildLifecycleArtifactBody,
  buildLifecycleNonceMarker,
  prepareLifecycleArtifact,
  validateLifecycleRequest,
  validateLifecycleWriteRequest,
  type LifecycleIdentity,
  type LifecyclePhase,
  type ValidLifecycleRequest,
} from "./ima-lifecycle.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

export const MAX_PROJECT_SLUG_LENGTH = 100;
export const MAX_PROVIDER_PAGE_BYTES = 512_000;
const CONTROL_MARKER = "ima-bookstack-lifecycle/v1";
const CONTROL_FIELDS = [
  "schemaVersion",
  "provider",
  "artifactId",
  "recordKey",
  "contentHash",
  "requestHash",
  "lifecycleKey",
  "phase",
  "identity",
  "summary",
  "placement",
] as const;

export type LifecyclePlacement = {
  projectSlug: string;
  sourceRef: string;
  lifecycleKey: string;
  shelfId: number;
  shelfSlug: string;
  bookId: number;
  bookSlug: string;
  chapterId: number;
  chapterSlug: string;
};

export type BookStackLifecycleRecord = {
  artifactId: string;
  recordKey: string;
  contentHash: string;
  requestHash: string;
  artifact: string;
  pageMarkdown: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  identity: LifecycleIdentity;
  summary: string;
  placement: LifecyclePlacement;
};

export const digestBookStackValue = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasOnlyFields = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length
  && Object.keys(value).every((field) => fields.includes(field));
const validId = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const validSlug = (value: unknown) => typeof value === "string"
  && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  && utf8ByteLength(value) <= MAX_PROJECT_SLUG_LENGTH;
const boundedText = (value: unknown, maximum: number) => typeof value === "string"
  && value.length > 0
  && utf8ByteLength(value) <= maximum
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const ownDataRecord = (value: unknown, fields: readonly string[]) => {
  try {
    if (!isObject(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length !== fields.length || !fields.every((field) => Object.hasOwn(descriptors, field))) return null;
    if (keys.some((field) => descriptors[field].get || descriptors[field].set || !Object.hasOwn(descriptors[field], "value"))) return null;
    return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
  } catch {
    return null;
  }
};

export const validateProjectSlug = (value: unknown) => {
  if (!validSlug(value)) throw new Error("bookstack_project_slug_invalid");
  return value;
};

export const chapterSelectorFor = (input: { sourceRef: string; lifecycleKey: string }) => {
  const sourceRef = input.sourceRef.trim();
  const taskwarrior = /^taskwarrior:([^:\s]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(sourceRef);
  if (taskwarrior) return `taskwarrior-${taskwarrior[2].toLowerCase()}`;
  const jira = /^jira:([A-Z][A-Z0-9]+-\d+)$/i.exec(sourceRef);
  if (jira) return jira[1].toLowerCase();
  const plane = /^plane:([^:\s]+):([A-Z][A-Z0-9_]*-\d+)$/i.exec(sourceRef);
  if (plane) return plane[2].toLowerCase();
  if (/^lifecycle:[^\s]+$/.test(sourceRef)
    || /^vestige:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceRef)) {
    return `lifecycle-${digestBookStackValue(input.lifecycleKey)}`;
  }
  throw new Error("bookstack_source_reference_invalid");
};

const sourceMatchesIdentity = (sourceRef: string, identity: LifecycleIdentity) => {
  const taskwarrior = /^taskwarrior:([^:]+):([0-9a-f-]{36})$/i.exec(sourceRef);
  if (taskwarrior) {
    return taskwarrior[1] === identity.taskwarriorProject
      && taskwarrior[2].toLowerCase() === identity.taskwarriorUuid.toLowerCase();
  }
  const jira = /^jira:([A-Z][A-Z0-9]+-\d+)$/i.exec(sourceRef);
  if (jira) return jira[1].toUpperCase() === identity.jiraKey.toUpperCase();
  const plane = /^plane:([^:]+):([A-Z][A-Z0-9_]*-\d+)$/i.exec(sourceRef);
  if (plane) {
    return plane[1] === identity.planeWorkspace
      && plane[2].toUpperCase() === identity.planeWorkItem?.toUpperCase();
  }
  if (sourceRef.startsWith("lifecycle:")) return sourceRef.slice(10) === identity.lifecycleKey;
  return /^vestige:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceRef);
};

export const placementMatchesRequest = (
  placement: LifecyclePlacement,
  request: ValidLifecycleRequest,
) => placement.projectSlug === request.identity.project
  && placement.bookSlug === placement.projectSlug
  && placement.lifecycleKey === request.identity.lifecycleKey
  && request.identity.sourceRefs.includes(placement.sourceRef)
  && sourceMatchesIdentity(placement.sourceRef, request.identity)
  && placement.chapterSlug === chapterSelectorFor(placement);

export const projectPlacementInput = (value: unknown) => {
  const input = ownDataRecord(value, ["projectSlug", "sourceRef", "lifecycleKey"]);
  if (!input || !validSlug(input.projectSlug) || !boundedText(input.sourceRef, 1_024)
    || !boundedText(input.lifecycleKey, 512)) return null;
  let chapterSlug;
  try {
    chapterSlug = chapterSelectorFor({ sourceRef: input.sourceRef as string, lifecycleKey: input.lifecycleKey as string });
  } catch {
    return null;
  }
  return {
    projectSlug: input.projectSlug as string,
    sourceRef: input.sourceRef as string,
    lifecycleKey: input.lifecycleKey as string,
    chapterSlug,
  };
};

export const projectLifecyclePlacement = (value: unknown): LifecyclePlacement | null => {
  const input = ownDataRecord(value, [
    "projectSlug", "sourceRef", "lifecycleKey", "shelfId", "shelfSlug", "bookId", "bookSlug", "chapterId", "chapterSlug",
  ]);
  const location = projectPlacementInput(input && {
    projectSlug: input.projectSlug,
    sourceRef: input.sourceRef,
    lifecycleKey: input.lifecycleKey,
  });
  if (!input || !location || !validId(input.shelfId) || input.shelfSlug !== "lifecycle-artifacts"
    || !validId(input.bookId) || input.bookSlug !== location.projectSlug
    || !validId(input.chapterId) || input.chapterSlug !== location.chapterSlug) return null;
  return {
    projectSlug: location.projectSlug,
    sourceRef: location.sourceRef,
    lifecycleKey: location.lifecycleKey,
    shelfId: input.shelfId,
    shelfSlug: "lifecycle-artifacts",
    bookId: input.bookId,
    bookSlug: location.projectSlug,
    chapterId: input.chapterId,
    chapterSlug: location.chapterSlug,
  };
};

const validPlacement = (value: unknown): value is LifecyclePlacement =>
  projectLifecyclePlacement(value) !== null;

const quoted = (value: string) => JSON.stringify(value);
const controlValue = (value: Omit<BookStackLifecycleRecord, "pageMarkdown">) => ({
  schemaVersion: 1,
  provider: "bookstack",
  artifactId: value.artifactId,
  recordKey: value.recordKey,
  contentHash: value.contentHash,
  requestHash: value.requestHash,
  lifecycleKey: value.lifecycleKey,
  phase: value.phase,
  identity: value.identity,
  summary: value.summary,
  placement: value.placement,
});
const controlBlock = (value: Omit<BookStackLifecycleRecord, "pageMarkdown">) =>
  `<!-- ${CONTROL_MARKER}\n${JSON.stringify(controlValue(value))}\n-->`;
const pageEnvelope = (value: Omit<BookStackLifecycleRecord, "pageMarkdown">) =>
  `---\nschema: ima-memory/v1\nproject: ${quoted(value.identity.project)}\nartifact_type: ${quoted(value.phase)}\nlifecycle_key: ${quoted(value.lifecycleKey)}\n---\n${controlBlock(value)}\n\n${value.artifact}`;

const createPreparedRecord = (
  request: ValidLifecycleRequest,
  placement: LifecyclePlacement,
): BookStackLifecycleRecord => {
  if (!validPlacement(placement) || !placementMatchesRequest(placement, request)) {
    throw new Error("bookstack_placement_invalid");
  }
  const prepared = prepareLifecycleArtifact(request);
  if (!prepared.valid) throw new Error(prepared.error.code);
  const requestHash = digestBookStackValue(JSON.stringify({
    identity: request.identity,
    summary: request.summary,
    placement,
    artifact: prepared.data.artifact,
  }));
  const record = {
    artifactId: prepared.data.nonce,
    recordKey: prepared.data.recordKey,
    contentHash: digestBookStackValue(prepared.data.artifact),
    requestHash,
    artifact: prepared.data.artifact,
    lifecycleKey: request.identity.lifecycleKey,
    phase: request.type,
    identity: request.identity,
    summary: request.summary,
    placement,
  };
  const pageMarkdown = pageEnvelope(record);
  if (utf8ByteLength(pageMarkdown) > MAX_PROVIDER_PAGE_BYTES) {
    throw new Error("bookstack_lifecycle_page_too_large");
  }
  return { ...record, pageMarkdown };
};

export const createLifecycleRecord = (input: {
  request: unknown;
  placement: LifecyclePlacement;
}): BookStackLifecycleRecord => {
  const request = validateLifecycleWriteRequest(input.request);
  if (!request.valid) throw new Error(request.error.code);
  return createPreparedRecord(request, input.placement);
};

const parseControl = (markdown: string) => {
  const match = new RegExp(`<!-- ${CONTROL_MARKER}\\n([^\\n]*)\\n-->`).exec(markdown);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return null;
  }
};

const originalPayload = (input: {
  artifact: string;
  artifactId: string;
  request: ValidLifecycleRequest;
}) => {
  const sentinel = "ima-bookstack-original-payload";
  const framedBody = buildLifecycleArtifactBody({
    type: input.request.type,
    identity: input.request.identity,
    artifact: sentinel,
  });
  const sentinelIndex = framedBody.lastIndexOf(sentinel);
  if (sentinelIndex < 0) return null;
  const prefix = framedBody.slice(0, sentinelIndex);
  const suffix = framedBody.slice(sentinelIndex + sentinel.length);
  const marker = buildLifecycleNonceMarker({
    lifecycleKey: input.request.identity.lifecycleKey,
    nonce: input.artifactId,
    type: input.request.type,
    jiraKey: input.request.identity.jiraKey,
    taskwarriorUuid: input.request.identity.taskwarriorUuid,
    planeWorkspace: input.request.identity.planeWorkspace,
    planeWorkItem: input.request.identity.planeWorkItem,
  });
  const ending = `${suffix}${marker}\n`;
  return input.artifact.startsWith(prefix) && input.artifact.endsWith(ending)
    ? input.artifact.slice(prefix.length, -ending.length)
    : null;
};

export const parseLifecycleRecord = (markdown: unknown): BookStackLifecycleRecord | null => {
  if (typeof markdown !== "string" || utf8ByteLength(markdown) > MAX_PROVIDER_PAGE_BYTES) return null;
  const control = parseControl(markdown);
  if (!isObject(control)
    || !hasOnlyFields(control, CONTROL_FIELDS)
    || control.schemaVersion !== 1
    || control.provider !== "bookstack"
    || typeof control.artifactId !== "string"
    || typeof control.recordKey !== "string"
    || typeof control.contentHash !== "string"
    || !/^[a-f0-9]{64}$/.test(control.contentHash)
    || typeof control.requestHash !== "string"
    || !/^[a-f0-9]{64}$/.test(control.requestHash)
    || typeof control.lifecycleKey !== "string"
    || typeof control.phase !== "string"
    || typeof control.summary !== "string"
    || !isObject(control.identity)
    || !validPlacement(control.placement)) return null;

  const placeholder = validateLifecycleRequest({
    type: control.phase,
    identity: control.identity,
    summary: control.summary,
    artifact: "placeholder",
  });
  if (!placeholder.valid) return null;
  const artifactStart = markdown.indexOf("\n\n", markdown.indexOf("-->"));
  const artifact = artifactStart < 0 ? "" : markdown.slice(artifactStart + 2);
  const payload = originalPayload({ artifact, artifactId: control.artifactId, request: placeholder });
  if (payload === null) return null;
  const request = validateLifecycleRequest({
    type: control.phase,
    identity: control.identity,
    summary: control.summary,
    artifact: payload,
  });
  if (!request.valid || !placementMatchesRequest(control.placement, request)) return null;
  let expected: BookStackLifecycleRecord;
  try {
    expected = createPreparedRecord(request, control.placement);
  } catch {
    return null;
  }
  if (expected.artifactId !== control.artifactId
    || expected.recordKey !== control.recordKey
    || expected.contentHash !== control.contentHash
    || expected.lifecycleKey !== control.lifecycleKey
    || expected.pageMarkdown !== markdown) return null;
  return expected;
};

export const lifecycleRecordProjection = (record: BookStackLifecycleRecord) => ({
  id: record.artifactId,
  recordKey: record.recordKey,
  lifecycleKey: record.lifecycleKey,
  content: record.artifact,
});

export const lifecycleRecordRequest = (input: ValidLifecycleRequest) => ({
  type: input.type,
  identity: input.identity,
  summary: input.summary,
  artifact: input.artifact,
});
