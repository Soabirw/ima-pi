import { digestBookStackValue } from "./bookstack-lifecycle-record.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

export type RecoveryOperation =
  | "create_shelf"
  | "create_book"
  | "create_chapter"
  | "attach_book"
  | "create_page";

type MembershipId = number;
type PendingProjectBook = "new-project-book";
type RecoveryMembership = MembershipId[] | [...MembershipId[], PendingProjectBook];

export type RecoveryDescriptor = {
  schemaVersion: 1;
  provider: "bookstack";
  operation: RecoveryOperation;
  originFingerprint: string;
  projectSlug: string;
  sourceRef: string;
  lifecycleKey: string;
  intendedSlug: string;
  shelfId: number | null;
  shelfSlug: "lifecycle-artifacts";
  bookId: number | null;
  bookSlug: string;
  chapterId: number | null;
  chapterSlug: string;
  pageId: number | null;
  membershipBefore: MembershipId[];
  membershipAfter: RecoveryMembership;
  artifactId: string;
  recordKey: string;
  contentHash: string;
  pageHash: string;
};

export type BookStackPageRecoveryCheckpoint = {
  schemaVersion: 1;
  provider: "bookstack";
  operation: "recover_page";
  lifecycleKey: string;
  requestHash: string;
  originFingerprint: string;
  pageSlug: string;
  discoveryHash: string;
};

export type FailureCategory =
  | "validation"
  | "denied"
  | "conflict"
  | "unavailable"
  | "unverifiable"
  | "approval"
  | "recovery";

export const PENDING_PROJECT_BOOK = "new-project-book";
const MAX_MEMBERSHIP_IDS = 10_000;
const SHELF_SLUG = "lifecycle-artifacts";
const RECOVERY_FIELDS = [
  "schemaVersion", "provider", "operation", "originFingerprint", "projectSlug",
  "sourceRef", "lifecycleKey", "intendedSlug", "shelfId", "shelfSlug", "bookId",
  "bookSlug", "chapterId", "chapterSlug", "pageId", "membershipBefore",
  "membershipAfter", "artifactId", "recordKey", "contentHash", "pageHash",
] as const;
const PAGE_RECOVERY_CHECKPOINT_FIELDS = [
  "schemaVersion",
  "provider",
  "operation",
  "lifecycleKey",
  "requestHash",
  "originFingerprint",
  "pageSlug",
  "discoveryHash",
] as const;
const PHASES = new Set([
  "plan", "implementation", "test", "review", "resolution", "rereview", "document", "decision", "closeout",
]);

const ownDataRecord = (value: unknown, fields: readonly string[]): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length !== fields.length || !fields.every((field) => Object.hasOwn(descriptors, field))) return null;
    if (keys.some((field) => descriptors[field].get || descriptors[field].set || !Object.hasOwn(descriptors[field], "value"))) return null;
    return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
  } catch {
    return null;
  }
};

const dataArray = (value: unknown): unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MEMBERSHIP_IDS) return null;
    const values = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value")) return null;
      values.push(descriptor.value);
    }
    if (Object.keys(descriptors).some((key) => key !== "length" && !/^\d+$/.test(key))) return null;
    return values;
  } catch {
    return null;
  }
};

const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && value > 0;
const nullableId = (value: unknown): value is number | null => value === null || positiveId(value);
const boundedText = (value: unknown, maximum: number, required = true): value is string =>
  typeof value === "string"
  && (!required || value.length > 0)
  && utf8ByteLength(value) <= maximum
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const validSlug = (value: unknown): value is string => boundedText(value, 100)
  && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const validSource = (sourceRef: unknown, lifecycleKey: string) => {
  if (!boundedText(sourceRef, 1_024)) return null;
  const taskwarrior = /^taskwarrior:([^:\s]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(sourceRef);
  if (taskwarrior) return `taskwarrior-${taskwarrior[2].toLowerCase()}`;
  const jira = /^jira:([A-Z][A-Z0-9]+-\d+)$/i.exec(sourceRef);
  if (jira) return jira[1].toLowerCase();
  const plane = /^plane:([^:\s]+):([A-Z][A-Z0-9_]*-\d+)$/i.exec(sourceRef);
  if (plane) return plane[2].toLowerCase();
  if (/^(?:lifecycle|vestige):[^\s]+$/.test(sourceRef)) {
    return `lifecycle-${digestBookStackValue(lifecycleKey)}`;
  }
  return null;
};
const membership = (value: unknown, permitPending: boolean): RecoveryMembership | null => {
  const values = dataArray(value);
  if (!values) return null;
  const pendingIndex = values.indexOf(PENDING_PROJECT_BOOK);
  if (!permitPending && pendingIndex >= 0) return null;
  if (pendingIndex >= 0 && (pendingIndex !== values.length - 1 || values.filter((item) => item === PENDING_PROJECT_BOOK).length !== 1)) return null;
  const ids = values.filter((item) => item !== PENDING_PROJECT_BOOK);
  if (!ids.every(positiveId) || new Set(ids).size !== ids.length) return null;
  return values as RecoveryMembership;
};
const sameMembership = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const phaseArtifactSlug = (value: string) => /^([a-z]+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(value);

export const projectBookStackPageRecoveryCheckpoint = (
  value: unknown,
): BookStackPageRecoveryCheckpoint | null => {
  const checkpoint = ownDataRecord(value, PAGE_RECOVERY_CHECKPOINT_FIELDS);
  const page = typeof checkpoint?.pageSlug === "string"
    ? phaseArtifactSlug(checkpoint.pageSlug)
    : null;
  if (
    !checkpoint
    || checkpoint.schemaVersion !== 1
    || checkpoint.provider !== "bookstack"
    || checkpoint.operation !== "recover_page"
    || !boundedText(checkpoint.lifecycleKey, 512)
    || typeof checkpoint.requestHash !== "string"
    || !/^[a-f0-9]{64}$/.test(checkpoint.requestHash)
    || typeof checkpoint.originFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(checkpoint.originFingerprint)
    || !page
    || !PHASES.has(page[1])
    || typeof checkpoint.discoveryHash !== "string"
    || !/^[a-f0-9]{64}$/.test(checkpoint.discoveryHash)
  ) return null;
  return {
    schemaVersion: 1,
    provider: "bookstack",
    operation: "recover_page",
    lifecycleKey: checkpoint.lifecycleKey,
    requestHash: checkpoint.requestHash,
    originFingerprint: checkpoint.originFingerprint,
    pageSlug: checkpoint.pageSlug,
    discoveryHash: checkpoint.discoveryHash,
  };
};

export const createBookStackPageRecoveryCheckpoint = (
  input: Omit<BookStackPageRecoveryCheckpoint, "schemaVersion" | "provider" | "operation">,
): BookStackPageRecoveryCheckpoint | null => projectBookStackPageRecoveryCheckpoint({
  schemaVersion: 1,
  provider: "bookstack",
  operation: "recover_page",
  ...input,
});

export const sameBookStackPageRecoveryCheckpoint = (
  left: BookStackPageRecoveryCheckpoint,
  right: BookStackPageRecoveryCheckpoint,
) => left.lifecycleKey === right.lifecycleKey
  && left.requestHash === right.requestHash
  && left.originFingerprint === right.originFingerprint
  && left.pageSlug === right.pageSlug
  && left.discoveryHash === right.discoveryHash;

const KNOWN_CODES = new Set([
  "bookstack_access_denied",
  "bookstack_approval_declined",
  "bookstack_approval_required",
  "bookstack_approval_stale",
  "bookstack_identity_ambiguous",
  "bookstack_locator_invalid",
  "bookstack_locator_mismatch",
  "bookstack_markdown_missing",
  "bookstack_pagination_invalid",
  "bookstack_placement_conflict",
  "bookstack_placement_invalid",
  "bookstack_placement_unavailable",
  "bookstack_project_slug_invalid",
  "bookstack_record_invalid",
  "bookstack_recall_unavailable",
  "bookstack_recovery_reconciled",
  "bookstack_recovery_stale",
  "bookstack_recovery_unresolved",
  "bookstack_response_invalid",
  "bookstack_response_too_large",
  "bookstack_shelf_membership_conflict",
  "bookstack_shelf_membership_invalid",
  "bookstack_slug_unexpected",
  "bookstack_source_reference_invalid",
  "bookstack_transport_failed",
  "bookstack_unavailable",
  "bookstack_verification_failed",
  "bookstack_write_unknown",
]);

const categoryFor = (code: string): FailureCategory => {
  if (code.includes("approval")) return "approval";
  if (code.includes("access_denied")) return "denied";
  if (code.includes("conflict") || code.includes("ambiguous")) return "conflict";
  if (code.includes("transport") || code.includes("unavailable") || code.includes("write_unknown")) return "unavailable";
  if (code.includes("recovery")) return "recovery";
  if (code.includes("verification") || code.includes("markdown") || code.includes("pagination")) return "unverifiable";
  return "validation";
};

export const safeFailure = (error: unknown, fallback: string) => {
  const candidate = typeof error === "string"
    ? error
    : error instanceof Error ? error.message : "";
  const code = KNOWN_CODES.has(candidate) ? candidate : fallback;
  return { code, category: categoryFor(code) };
};

export const originFingerprint = (origin: string) =>
  digestBookStackValue(new URL(origin).origin);

export const projectRecoveryDescriptor = (value: unknown): RecoveryDescriptor | null => {
  const input = ownDataRecord(value, RECOVERY_FIELDS);
  if (!input
    || input.schemaVersion !== 1
    || input.provider !== "bookstack"
    || typeof input.operation !== "string"
    || !["create_shelf", "create_book", "create_chapter", "attach_book", "create_page"].includes(input.operation)
    || typeof input.originFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(input.originFingerprint)
    || !validSlug(input.projectSlug)
    || !boundedText(input.lifecycleKey, 512)
    || !validSlug(input.intendedSlug)
    || input.shelfSlug !== SHELF_SLUG
    || !validSlug(input.bookSlug)
    || input.bookSlug !== input.projectSlug
    || !validSlug(input.chapterSlug)
    || !nullableId(input.shelfId)
    || !nullableId(input.bookId)
    || !nullableId(input.chapterId)
    || !nullableId(input.pageId)) return null;

  const sourceChapter = validSource(input.sourceRef, input.lifecycleKey);
  const before = membership(input.membershipBefore, false);
  const after = membership(input.membershipAfter, true);
  if (!sourceChapter || input.chapterSlug !== sourceChapter || !before || !after) return null;

  const operation = input.operation as RecoveryOperation;
  const ids = { shelfId: input.shelfId, bookId: input.bookId, chapterId: input.chapterId, pageId: input.pageId };
  const noPageProof = input.artifactId === "" && input.recordKey === "" && input.contentHash === "" && input.pageHash === "";
  const pageProof = boundedText(input.artifactId, 36)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.artifactId)
    && boundedText(input.recordKey, 512)
    && typeof input.contentHash === "string"
    && /^[a-f0-9]{64}$/.test(input.contentHash)
    && typeof input.pageHash === "string"
    && /^[a-f0-9]{64}$/.test(input.pageHash);
  const pendingAfter = [...before, PENDING_PROJECT_BOOK];
  const numericAfter = (bookId: number) => [...before, bookId];

  const validOperation = operation === "create_shelf"
    ? ids.bookId === null && ids.chapterId === null && ids.pageId === null && before.length === 0
      && sameMembership(after, pendingAfter) && input.intendedSlug === SHELF_SLUG && noPageProof
    : operation === "create_book"
      ? ids.shelfId !== null && ids.chapterId === null && ids.pageId === null && !before.includes(ids.bookId ?? -1)
        && input.intendedSlug === input.bookSlug && noPageProof
        && (ids.bookId === null ? sameMembership(after, pendingAfter) : sameMembership(after, numericAfter(ids.bookId)))
      : operation === "attach_book"
        ? ids.shelfId !== null && ids.bookId !== null && ids.chapterId === null && ids.pageId === null
          && !before.includes(ids.bookId) && sameMembership(after, numericAfter(ids.bookId))
          && input.intendedSlug === SHELF_SLUG && noPageProof
        : operation === "create_chapter"
          ? ids.shelfId !== null && ids.bookId !== null && ids.pageId === null
            && input.intendedSlug === input.chapterSlug && noPageProof
            && (before.includes(ids.bookId)
              ? sameMembership(after, before)
              : sameMembership(after, numericAfter(ids.bookId)))
          : (() => {
            const slug = phaseArtifactSlug(input.intendedSlug);
            return ids.shelfId !== null && ids.bookId !== null && ids.chapterId !== null
              && before.length === 0 && after.length === 0 && pageProof && slug !== null
              && PHASES.has(slug[1]) && slug[2].toLowerCase() === input.artifactId.toLowerCase()
              && input.recordKey === `${input.lifecycleKey}:${slug[1]}:${input.contentHash.slice(0, 12)}`;
          })();
  if (!validOperation) return null;

  return {
    schemaVersion: 1,
    provider: "bookstack",
    operation,
    originFingerprint: input.originFingerprint,
    projectSlug: input.projectSlug,
    sourceRef: input.sourceRef as string,
    lifecycleKey: input.lifecycleKey,
    intendedSlug: input.intendedSlug,
    shelfId: ids.shelfId,
    shelfSlug: SHELF_SLUG,
    bookId: ids.bookId,
    bookSlug: input.bookSlug,
    chapterId: ids.chapterId,
    chapterSlug: input.chapterSlug,
    pageId: ids.pageId,
    membershipBefore: [...before] as MembershipId[],
    membershipAfter: [...after] as RecoveryMembership,
    artifactId: input.artifactId as string,
    recordKey: input.recordKey as string,
    contentHash: input.contentHash as string,
    pageHash: input.pageHash as string,
  };
};

export const validRecoveryDescriptor = (value: unknown): value is RecoveryDescriptor =>
  projectRecoveryDescriptor(value) !== null;

export const recoveryDescriptor = (input: Omit<RecoveryDescriptor, "schemaVersion" | "provider" | "originFingerprint"> & { origin: string }): RecoveryDescriptor => {
  const { origin, ...value } = input;
  const descriptor = projectRecoveryDescriptor({
    schemaVersion: 1,
    provider: "bookstack",
    ...value,
    originFingerprint: originFingerprint(origin),
  });
  if (!descriptor) throw new Error("bookstack_recovery_unresolved");
  return descriptor;
};
