import {
  normalizeLifecycleRecordKey,
} from "./ima-lifecycle.ts";
import {
  projectBookStackPageRecoveryCheckpoint,
  sameBookStackPageRecoveryCheckpoint,
  type BookStackPageRecoveryCheckpoint,
} from "./bookstack-lifecycle-recovery.ts";
import {
  projectMarkdownLifecycleReference,
} from "./markdown-lifecycle-record.ts";
import {
  projectQdrantLifecycleReference,
} from "./qdrant-lifecycle-record.ts";
import {
  projectSerenaLifecycleReference,
} from "./serena-lifecycle-record.ts";
import {
  LIFECYCLE_PROVIDER_NAMES,
  normalizeLifecycleProvider,
  type LifecycleProviderName,
} from "./ima-lifecycle-selection.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";
import {
  projectQdrantLifecycleRecoveryCheckpoint,
  qdrantLifecycleRecoveryPinFingerprint,
  sameQdrantLifecycleRecoveryCheckpoint,
  type QdrantLifecycleRecoveryCheckpoint,
} from "./qdrant-lifecycle-recovery-report.ts";

export const LIFECYCLE_PROVIDER_PIN_SCHEMA_VERSION = 1;
export const LIFECYCLE_PROVIDER_PIN_ATTEMPT_SCHEMA_VERSION = 1;

export type LifecycleProviderPin = {
  schemaVersion: 1;
  lifecycleKey: string;
  provider: LifecycleProviderName;
  initialReference: Record<string, unknown>;
  artifactId: string;
  recordKey: string;
  pinnedAt: string;
};

export type LifecycleProviderPinAttempt = {
  schemaVersion: 1;
  lifecycleKey: string;
  provider: LifecycleProviderName;
  attemptId: string;
  status: "authorized" | "writing";
  startedAt: string;
  recoveryCheckpoint?: BookStackPageRecoveryCheckpoint;
};

export type QdrantLifecycleProviderRecovery = {
  schemaVersion: 1;
  provider: "qdrant";
  lifecycleKey: string;
  expectedPin: LifecycleProviderPin;
  checkpoint: QdrantLifecycleRecoveryCheckpoint;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const SECRET_ASSIGNMENT = /(?:authorization|token|secret|password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S+/i;
const PIN_FIELDS = [
  "schemaVersion",
  "lifecycleKey",
  "provider",
  "initialReference",
  "artifactId",
  "recordKey",
  "pinnedAt",
] as const;
const ATTEMPT_FIELDS = [
  "schemaVersion",
  "lifecycleKey",
  "provider",
  "attemptId",
  "status",
  "startedAt",
] as const;
const ATTEMPT_WITH_RECOVERY_CHECKPOINT_FIELDS = [
  ...ATTEMPT_FIELDS,
  "recoveryCheckpoint",
] as const;
const QDRANT_RECOVERY_FIELDS = [
  "schemaVersion",
  "provider",
  "lifecycleKey",
  "expectedPin",
  "checkpoint",
] as const;
const BOOKSTACK_REFERENCE_FIELDS = [
  "projectSlug",
  "sourceRef",
  "lifecycleKey",
  "shelfId",
  "shelfSlug",
  "bookId",
  "bookSlug",
  "chapterId",
  "chapterSlug",
  "pageId",
  "pageSlug",
  "originFingerprint",
  "artifactId",
  "recordKey",
  "contentHash",
  "pageHash",
  "revisionCount",
  "updatedAt",
] as const;
const BOOKSTACK_PHASES = new Set([
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

const ownDataRecord = (
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length !== fields.length
      || !fields.every((field) => keys.includes(field))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
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
  && !SECRET_ASSIGNMENT.test(value)
  && utf8ByteLength(value) <= maximumBytes
  ? value
  : null;

const lifecycleKey = (value: unknown): string | null => {
  const normalized = normalizeLifecycleRecordKey(value);
  return normalized && normalized === value ? normalized : null;
};

const timestamp = (value: unknown): string | null => {
  const result = canonicalText(value, 64);
  return result && TIMESTAMP.test(result) && !Number.isNaN(Date.parse(result))
    ? result
    : null;
};

const bookStackReference = (value: unknown): Record<string, unknown> | null => {
  const reference = ownDataRecord(value, BOOKSTACK_REFERENCE_FIELDS);
  if (!reference) return null;
  const projectSlug = canonicalText(reference.projectSlug, 100);
  const sourceRef = canonicalText(reference.sourceRef, 1_024);
  const key = lifecycleKey(reference.lifecycleKey);
  const shelfId = reference.shelfId;
  const shelfSlug = reference.shelfSlug;
  const bookId = reference.bookId;
  const bookSlug = reference.bookSlug;
  const chapterId = reference.chapterId;
  const chapterSlug = reference.chapterSlug;
  const pageId = reference.pageId;
  const pageSlug = canonicalText(reference.pageSlug, 100);
  const originFingerprint = reference.originFingerprint;
  const artifactId = canonicalText(reference.artifactId, 36);
  const recordKey = lifecycleKey(reference.recordKey);
  const contentHash = reference.contentHash;
  const pageHash = reference.pageHash;
  const revisionCount = reference.revisionCount;
  const updatedAt = canonicalText(reference.updatedAt, 1_024);
  const ids = [shelfId, bookId, chapterId, pageId];
  const validSlug = (candidate: string | null) => Boolean(
    candidate && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate),
  );
  const page = /^([a-z]+)-([0-9a-f-]{36})$/i.exec(pageSlug ?? "");
  if (
    !validSlug(projectSlug)
    || !sourceRef
    || !key
    || !ids.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
    || shelfSlug !== "lifecycle-artifacts"
    || !validSlug(bookSlug)
    || bookSlug !== projectSlug
    || !validSlug(chapterSlug)
    || !page
    || !BOOKSTACK_PHASES.has(page[1])
    || !artifactId
    || !UUID.test(artifactId)
    || page[2].toLowerCase() !== artifactId.toLowerCase()
    || !recordKey
    || typeof originFingerprint !== "string"
    || !HASH.test(originFingerprint)
    || typeof contentHash !== "string"
    || !HASH.test(contentHash)
    || typeof pageHash !== "string"
    || !HASH.test(pageHash)
    || !Number.isSafeInteger(revisionCount)
    || Number(revisionCount) < 0
    || !updatedAt
  ) return null;
  return {
    projectSlug,
    sourceRef,
    lifecycleKey: key,
    shelfId,
    shelfSlug,
    bookId,
    bookSlug,
    chapterId,
    chapterSlug,
    pageId,
    pageSlug,
    originFingerprint,
    artifactId: artifactId.toLowerCase(),
    recordKey,
    contentHash,
    pageHash,
    revisionCount,
    updatedAt,
  };
};

const detachedReference = (
  value: Record<string, unknown>,
): Record<string, unknown> | null => {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
};

export const projectLifecycleProviderReference = (
  providerValue: unknown,
  value: unknown,
): Record<string, unknown> | null => {
  const provider = normalizeLifecycleProvider(providerValue);
  if (!provider) return null;
  const projected = provider === "qdrant"
    ? projectQdrantLifecycleReference(value)
    : provider === "serena"
      ? projectSerenaLifecycleReference(value)
      : provider === "markdown"
        ? projectMarkdownLifecycleReference(value)
        : bookStackReference(value);
  return projected ? detachedReference(projected as Record<string, unknown>) : null;
};

export const projectLifecycleProviderPinAttempt = (
  value: unknown,
): LifecycleProviderPinAttempt | null => {
  const attempt = ownDataRecord(value, ATTEMPT_FIELDS)
    ?? ownDataRecord(value, ATTEMPT_WITH_RECOVERY_CHECKPOINT_FIELDS);
  const provider = normalizeLifecycleProvider(attempt?.provider);
  const key = lifecycleKey(attempt?.lifecycleKey);
  const attemptId = canonicalText(attempt?.attemptId, 36);
  const status = attempt?.status;
  const startedAt = timestamp(attempt?.startedAt);
  const hasRecoveryCheckpoint = Boolean(attempt && Object.hasOwn(attempt, "recoveryCheckpoint"));
  const recoveryCheckpoint = hasRecoveryCheckpoint
    ? projectBookStackPageRecoveryCheckpoint(attempt?.recoveryCheckpoint)
    : null;
  if (
    !attempt
    || attempt.schemaVersion !== LIFECYCLE_PROVIDER_PIN_ATTEMPT_SCHEMA_VERSION
    || !key
    || !provider
    || !attemptId
    || !UUID.test(attemptId)
    || (status !== "authorized" && status !== "writing")
    || !startedAt
    || hasRecoveryCheckpoint && !recoveryCheckpoint
    || recoveryCheckpoint && (
      provider !== "bookstack"
      || status !== "writing"
      || recoveryCheckpoint.lifecycleKey !== key
    )
  ) return null;
  return {
    schemaVersion: 1,
    lifecycleKey: key,
    provider,
    attemptId: attemptId.toLowerCase(),
    status,
    startedAt,
    ...(recoveryCheckpoint ? { recoveryCheckpoint } : {}),
  };
};

export const createLifecycleProviderPinAttempt = (input: {
  lifecycleKey: unknown;
  provider: unknown;
  attemptId: unknown;
  status?: unknown;
  startedAt: unknown;
  recoveryCheckpoint?: unknown;
}): LifecycleProviderPinAttempt | null => projectLifecycleProviderPinAttempt({
  schemaVersion: LIFECYCLE_PROVIDER_PIN_ATTEMPT_SCHEMA_VERSION,
  lifecycleKey: input.lifecycleKey,
  provider: input.provider,
  attemptId: input.attemptId,
  status: input.status ?? "authorized",
  startedAt: input.startedAt,
  ...(input.recoveryCheckpoint === undefined
    ? {}
    : { recoveryCheckpoint: input.recoveryCheckpoint }),
});

export const projectLifecycleProviderPin = (
  value: unknown,
): LifecycleProviderPin | null => {
  const pin = ownDataRecord(value, PIN_FIELDS);
  const provider = normalizeLifecycleProvider(pin?.provider);
  const key = lifecycleKey(pin?.lifecycleKey);
  const initialReference = provider
    ? projectLifecycleProviderReference(provider, pin?.initialReference)
    : null;
  const artifactId = canonicalText(pin?.artifactId, 36);
  const recordKey = lifecycleKey(pin?.recordKey);
  const pinnedAt = timestamp(pin?.pinnedAt);
  if (
    !pin
    || pin.schemaVersion !== LIFECYCLE_PROVIDER_PIN_SCHEMA_VERSION
    || !provider
    || !key
    || !initialReference
    || typeof initialReference.lifecycleKey !== "string"
    || initialReference.lifecycleKey !== key
    || !artifactId
    || !UUID.test(artifactId)
    || !recordKey
    || !pinnedAt
    || typeof initialReference.artifactId === "string" && initialReference.artifactId.toLowerCase() !== artifactId.toLowerCase()
    || typeof initialReference.recordKey === "string" && initialReference.recordKey !== recordKey
  ) return null;
  return {
    schemaVersion: 1,
    lifecycleKey: key,
    provider,
    initialReference,
    artifactId: artifactId.toLowerCase(),
    recordKey,
    pinnedAt,
  };
};

export const createLifecycleProviderPin = (input: {
  lifecycleKey: unknown;
  provider: unknown;
  initialReference: unknown;
  artifactId: unknown;
  recordKey: unknown;
  pinnedAt: unknown;
}): LifecycleProviderPin | null => projectLifecycleProviderPin({
  schemaVersion: LIFECYCLE_PROVIDER_PIN_SCHEMA_VERSION,
  lifecycleKey: input.lifecycleKey,
  provider: input.provider,
  initialReference: input.initialReference,
  artifactId: input.artifactId,
  recordKey: input.recordKey,
  pinnedAt: input.pinnedAt,
});

export const projectQdrantLifecycleProviderRecovery = (
  value: unknown,
): QdrantLifecycleProviderRecovery | null => {
  const recovery = ownDataRecord(value, QDRANT_RECOVERY_FIELDS);
  const lifecycleKeyValue = lifecycleKey(recovery?.lifecycleKey);
  const expectedPin = projectLifecycleProviderPin(recovery?.expectedPin);
  const checkpoint = projectQdrantLifecycleRecoveryCheckpoint(recovery?.checkpoint);
  const expectedPinFingerprint = expectedPin
    ? qdrantLifecycleRecoveryPinFingerprint(expectedPin)
    : null;
  if (
    !recovery
    || recovery.schemaVersion !== 1
    || recovery.provider !== "qdrant"
    || !lifecycleKeyValue
    || !expectedPin
    || expectedPin.provider !== "qdrant"
    || !checkpoint
    || !expectedPinFingerprint
    || expectedPin.lifecycleKey !== lifecycleKeyValue
    || checkpoint.lifecycleKey !== lifecycleKeyValue
    || checkpoint.expectedPinFingerprint !== expectedPinFingerprint
  ) return null;
  return {
    schemaVersion: 1,
    provider: "qdrant",
    lifecycleKey: lifecycleKeyValue,
    expectedPin,
    checkpoint,
  };
};

export const createQdrantLifecycleProviderRecovery = (input: {
  lifecycleKey: unknown;
  expectedPin: unknown;
  checkpoint: unknown;
}): QdrantLifecycleProviderRecovery | null => projectQdrantLifecycleProviderRecovery({
  schemaVersion: 1,
  provider: "qdrant",
  lifecycleKey: input.lifecycleKey,
  expectedPin: input.expectedPin,
  checkpoint: input.checkpoint,
});

export const sameQdrantLifecycleProviderRecovery = (
  left: QdrantLifecycleProviderRecovery,
  right: QdrantLifecycleProviderRecovery,
): boolean => sameLifecycleProviderPin(left.expectedPin, right.expectedPin)
  && left.lifecycleKey === right.lifecycleKey
  && sameQdrantLifecycleRecoveryCheckpoint(left.checkpoint, right.checkpoint);

export const sameLifecycleProviderPin = (
  left: LifecycleProviderPin,
  right: LifecycleProviderPin,
): boolean => left.lifecycleKey === right.lifecycleKey
  && left.provider === right.provider
  && left.artifactId === right.artifactId
  && left.recordKey === right.recordKey
  && left.pinnedAt === right.pinnedAt
  && JSON.stringify(left.initialReference) === JSON.stringify(right.initialReference);

export const sameLifecycleProviderPinAttempt = (
  left: LifecycleProviderPinAttempt,
  right: LifecycleProviderPinAttempt,
): boolean => left.lifecycleKey === right.lifecycleKey
  && left.provider === right.provider
  && left.attemptId === right.attemptId
  && left.status === right.status
  && left.startedAt === right.startedAt
  && (
    (left.recoveryCheckpoint === undefined && right.recoveryCheckpoint === undefined)
    || (
      left.recoveryCheckpoint !== undefined
      && right.recoveryCheckpoint !== undefined
      && sameBookStackPageRecoveryCheckpoint(
        left.recoveryCheckpoint,
        right.recoveryCheckpoint,
      )
    )
  );

export const isLifecycleProviderName = (
  value: unknown,
): value is LifecycleProviderName => LIFECYCLE_PROVIDER_NAMES.includes(
  value as LifecycleProviderName,
);
