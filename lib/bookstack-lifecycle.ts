import {
  createLifecycleRecord,
  digestBookStackValue,
  parseLifecycleRecord,
  projectLifecyclePlacement,
  projectPlacementInput,
  placementMatchesRequest,
  type BookStackLifecycleRecord,
  type LifecyclePlacement,
} from "./bookstack-lifecycle-record.ts";
import {
  ensurePlacement,
  planPlacement,
  type PlacementPreview,
  type PlacementResult,
} from "./bookstack-lifecycle-placement.ts";
import type {
  BookStackLifecycleClient,
  BookStackResource,
} from "./bookstack-lifecycle-client.ts";
import {
  originFingerprint,
  projectRecoveryDescriptor,
  recoveryDescriptor,
  safeFailure,
  type FailureCategory,
  type RecoveryDescriptor,
} from "./bookstack-lifecycle-recovery.ts";
import { validateLifecycleRequest } from "./ima-lifecycle.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

export type LifecycleLocator = LifecyclePlacement & {
  pageId: number;
  pageSlug: string;
  originFingerprint: string;
  artifactId: string;
  recordKey: string;
  contentHash: string;
  pageHash: string;
  revisionCount: number;
  updatedAt: string;
};

export type BlockedResult = {
  provider: "bookstack";
  status: "blocked";
  code: string;
  category: FailureCategory;
  recovery: RecoveryDescriptor | null;
};

export type VerifiedResult = {
  provider: "bookstack";
  status: "verified";
  disposition: "stored" | "unchanged";
  artifactId: string;
  recordKey: string;
  contentHash: string;
  pageHash: string;
  artifact: string;
  sourceId: string;
  canonicalUrl: string;
  revisionCount: number;
  updatedAt: string;
  creatorId: number | null;
  updaterId: number | null;
  originFingerprint: string;
  locator: LifecycleLocator;
};

const VALID_PHASES = new Set([
  "plan", "implementation", "test", "review", "resolution", "rereview", "decision", "closeout",
]);
const LOCATOR_FIELDS = [
  "projectSlug", "sourceRef", "lifecycleKey", "shelfId", "shelfSlug", "bookId", "bookSlug", "chapterId", "chapterSlug",
  "pageId", "pageSlug", "originFingerprint", "artifactId", "recordKey", "contentHash", "pageHash", "revisionCount", "updatedAt",
] as const;
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && value > 0;
const boundedText = (value: unknown, maximum: number) => typeof value === "string"
  && value.length > 0
  && utf8ByteLength(value) <= maximum
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const dataRecord = (value: unknown, fields: readonly string[]): Record<string, unknown> | null => {
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
const optionalRecovery = (value: unknown, fields: readonly string[]) => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (!fields.every((field) => Object.hasOwn(descriptors, field))
      || keys.some((field) => ![...fields, "recovery"].includes(field))
      || keys.some((field) => descriptors[field].get || descriptors[field].set || !Object.hasOwn(descriptors[field], "value"))) return null;
    return { values: Object.fromEntries(fields.map((field) => [field, descriptors[field].value])), hasRecovery: Object.hasOwn(descriptors, "recovery"), recovery: descriptors.recovery?.value };
  } catch {
    return null;
  }
};

const blocked = (
  error: unknown,
  fallback: string,
  recovery: RecoveryDescriptor | null = null,
): BlockedResult => ({
  provider: "bookstack",
  status: "blocked",
  ...safeFailure(error, fallback),
  recovery,
});

const pageName = (record: BookStackLifecycleRecord) => `${record.phase}-${record.artifactId}`;
const placementMatches = (left: LifecyclePlacement, right: LifecyclePlacement) =>
  left.projectSlug === right.projectSlug
  && left.sourceRef === right.sourceRef
  && left.lifecycleKey === right.lifecycleKey
  && left.shelfId === right.shelfId
  && left.shelfSlug === right.shelfSlug
  && left.bookId === right.bookId
  && left.bookSlug === right.bookSlug
  && left.chapterId === right.chapterId
  && left.chapterSlug === right.chapterSlug;

const verifiedPageMetadata = (page: BookStackResource) => {
  if (page.markdown === undefined) throw new Error("bookstack_markdown_missing");
  if (!Number.isSafeInteger(page.revisionCount) || page.revisionCount < 0 || !boundedText(page.updatedAt, 1_024)) {
    throw new Error("bookstack_verification_failed");
  }
  return {
    revisionCount: page.revisionCount,
    updatedAt: page.updatedAt,
    creatorId: positiveId(page.creatorId) ? page.creatorId : null,
    updaterId: positiveId(page.updaterId) ? page.updaterId : null,
  };
};

const verifyHierarchy = async (input: {
  client: BookStackLifecycleClient;
  placement: LifecyclePlacement;
  page?: BookStackResource;
}) => {
  const [shelf, book, chapter] = await Promise.all([
    input.client.readShelf(input.placement.shelfId),
    input.client.readBook(input.placement.bookId),
    input.client.readChapter(input.placement.chapterId),
  ]);
  if (shelf.id !== input.placement.shelfId
    || book.id !== input.placement.bookId
    || chapter.id !== input.placement.chapterId
    || shelf.slug !== input.placement.shelfSlug
    || book.slug !== input.placement.bookSlug
    || chapter.slug !== input.placement.chapterSlug
    || chapter.bookId !== book.id
    || !shelf.books?.includes(book.id)
    || (input.page && (
      input.page.chapterId !== chapter.id
      || input.page.bookId !== book.id
    ))) throw new Error("bookstack_placement_conflict");
  return { shelf, book, chapter };
};

const verifiedPage = async (input: {
  client: BookStackLifecycleClient;
  pageId: number;
  placement: LifecyclePlacement;
  expected?: BookStackLifecycleRecord;
}) => {
  const page = await input.client.readPage(input.pageId);
  if (page.id !== input.pageId) throw new Error("bookstack_verification_failed");
  await verifyHierarchy({ client: input.client, placement: input.placement, page });
  const metadata = verifiedPageMetadata(page);
  const record = parseLifecycleRecord(page.markdown);
  if (!record
    || page.slug !== pageName(record)
    || !placementMatches(record.placement, input.placement)
    || (input.expected && (
      page.markdown !== input.expected.pageMarkdown
      || record.artifactId !== input.expected.artifactId
      || record.contentHash !== input.expected.contentHash
      || record.recordKey !== input.expected.recordKey
    ))) throw new Error("bookstack_verification_failed");
  return { page, record, metadata, pageHash: digestBookStackValue(page.markdown!) };
};

export const projectLocator = (value: unknown, normalizedOrigin: string): LifecycleLocator | null => {
  const locator = dataRecord(value, LOCATOR_FIELDS);
  if (!locator) return null;
  const placement = projectLifecyclePlacement({
    projectSlug: locator.projectSlug,
    sourceRef: locator.sourceRef,
    lifecycleKey: locator.lifecycleKey,
    shelfId: locator.shelfId,
    shelfSlug: locator.shelfSlug,
    bookId: locator.bookId,
    bookSlug: locator.bookSlug,
    chapterId: locator.chapterId,
    chapterSlug: locator.chapterSlug,
  });
  if (!placement
    || locator.originFingerprint !== originFingerprint(normalizedOrigin)
    || !positiveId(locator.pageId)
    || !boundedText(locator.pageSlug, 100)
    || !boundedText(locator.artifactId, 36)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(locator.artifactId)
    || !boundedText(locator.recordKey, 512)
    || typeof locator.contentHash !== "string"
    || !/^[a-f0-9]{64}$/.test(locator.contentHash)
    || typeof locator.pageHash !== "string"
    || !/^[a-f0-9]{64}$/.test(locator.pageHash)
    || !Number.isSafeInteger(locator.revisionCount) || locator.revisionCount < 0
    || !boundedText(locator.updatedAt, 1_024)) return null;
  const slug = /^([a-z]+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(locator.pageSlug);
  if (!slug || !VALID_PHASES.has(slug[1]) || slug[2].toLowerCase() !== locator.artifactId.toLowerCase()
    || locator.recordKey !== `${placement.lifecycleKey}:${slug[1]}:${locator.contentHash.slice(0, 12)}`) return null;
  return {
    ...placement,
    pageId: locator.pageId,
    pageSlug: locator.pageSlug,
    originFingerprint: locator.originFingerprint as string,
    artifactId: locator.artifactId as string,
    recordKey: locator.recordKey as string,
    contentHash: locator.contentHash as string,
    pageHash: locator.pageHash as string,
    revisionCount: locator.revisionCount as number,
    updatedAt: locator.updatedAt as string,
  };
};

const receipt = (input: {
  client: BookStackLifecycleClient;
  verified: Awaited<ReturnType<typeof verifiedPage>>;
  disposition: "stored" | "unchanged";
}): VerifiedResult => {
  const { page, record, metadata, pageHash } = input.verified;
  const origin = input.client.origin;
  const locator = projectLocator({
    ...record.placement,
    pageId: page.id,
    pageSlug: page.slug,
    originFingerprint: originFingerprint(origin),
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    contentHash: record.contentHash,
    pageHash,
    revisionCount: metadata.revisionCount,
    updatedAt: metadata.updatedAt,
  }, origin);
  if (!locator) throw new Error("bookstack_verification_failed");
  return {
    provider: "bookstack",
    status: "verified",
    disposition: input.disposition,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    contentHash: record.contentHash,
    pageHash,
    artifact: record.artifact,
    sourceId: `bookstack:lifecycle:${page.id}`,
    canonicalUrl: `${origin}/link/${page.id}`,
    ...metadata,
    originFingerprint: locator.originFingerprint,
    locator,
  };
};

const placementPageCandidates = async (
  client: BookStackLifecycleClient,
  placement: LifecyclePlacement,
  pageSlug: string,
) => (await client.listPages()).filter((page) =>
  page.chapterId === placement.chapterId && page.slug === pageSlug,
);

const canonicalPageCandidates = async (
  client: BookStackLifecycleClient,
  pageSlug: string,
) => (await client.listPages()).filter((page) => page.slug === pageSlug);

const recoveryForPage = (input: {
  client: BookStackLifecycleClient;
  record: BookStackLifecycleRecord;
  pageId: number | null;
}): RecoveryDescriptor => recoveryDescriptor({
  origin: input.client.origin,
  operation: "create_page",
  projectSlug: input.record.placement.projectSlug,
  sourceRef: input.record.placement.sourceRef,
  lifecycleKey: input.record.placement.lifecycleKey,
  intendedSlug: pageName(input.record),
  shelfId: input.record.placement.shelfId,
  shelfSlug: "lifecycle-artifacts",
  bookId: input.record.placement.bookId,
  bookSlug: input.record.placement.bookSlug,
  chapterId: input.record.placement.chapterId,
  chapterSlug: input.record.placement.chapterSlug,
  pageId: input.pageId,
  membershipBefore: [],
  membershipAfter: [],
  artifactId: input.record.artifactId,
  recordKey: input.record.recordKey,
  contentHash: input.record.contentHash,
  pageHash: digestBookStackValue(input.record.pageMarkdown),
});

const knownPostId = (error: unknown): number | null => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error as object, "knownResourceId");
    return positiveId(descriptor?.value) ? descriptor.value : null;
  } catch {
    return null;
  }
};

export const createBookStackLifecycleProvider = (input: {
  client: BookStackLifecycleClient;
  approvePlacement?: (preview: PlacementPreview) => Promise<boolean> | boolean;
}) => {
  const placement = async (location: unknown): Promise<PlacementPreview | BlockedResult> => {
    const projected = projectPlacementInput(location);
    if (!projected) return blocked("bookstack_placement_invalid", "bookstack_placement_invalid");
    try {
      return await planPlacement(input.client, {
        projectSlug: projected.projectSlug,
        sourceRef: projected.sourceRef,
        lifecycleKey: projected.lifecycleKey,
      });
    } catch (error) {
      return blocked(error, "bookstack_placement_unavailable");
    }
  };

  const ensure = async (location: unknown): Promise<PlacementResult> => {
    const call = optionalRecovery(location, ["projectSlug", "sourceRef", "lifecycleKey"]);
    const projected = projectPlacementInput(call?.values);
    if (!call || !projected) return blocked("bookstack_placement_invalid", "bookstack_placement_invalid");
    return ensurePlacement({
      client: input.client,
      placement: {
        projectSlug: projected.projectSlug,
        sourceRef: projected.sourceRef,
        lifecycleKey: projected.lifecycleKey,
      },
      approve: input.approvePlacement,
      ...(call.hasRecovery ? { recovery: call.recovery } : {}),
    });
  };

  const reconcile = async (value: unknown): Promise<VerifiedResult | BlockedResult> => {
    const recovery = projectRecoveryDescriptor(value);
    if (!recovery || recovery.operation !== "create_page" || recovery.originFingerprint !== originFingerprint(input.client.origin)) {
      return blocked("bookstack_recovery_unresolved", "bookstack_recovery_unresolved");
    }
    const placement = projectLifecyclePlacement({
      projectSlug: recovery.projectSlug,
      sourceRef: recovery.sourceRef,
      lifecycleKey: recovery.lifecycleKey,
      shelfId: recovery.shelfId,
      shelfSlug: recovery.shelfSlug,
      bookId: recovery.bookId,
      bookSlug: recovery.bookSlug,
      chapterId: recovery.chapterId,
      chapterSlug: recovery.chapterSlug,
    });
    if (!placement) return blocked("bookstack_recovery_unresolved", "bookstack_recovery_unresolved", recovery);
    try {
      const candidates = recovery.pageId
        ? [await input.client.readPage(recovery.pageId)]
        : await placementPageCandidates(input.client, placement, recovery.intendedSlug);
      if (candidates.length !== 1 || candidates[0].id !== recovery.pageId && recovery.pageId !== null
        || candidates[0].slug !== recovery.intendedSlug) throw new Error("bookstack_recovery_unresolved");
      const verified = await verifiedPage({ client: input.client, pageId: candidates[0].id, placement });
      if (verified.record.artifactId !== recovery.artifactId
        || verified.record.recordKey !== recovery.recordKey
        || verified.record.contentHash !== recovery.contentHash
        || verified.pageHash !== recovery.pageHash) throw new Error("bookstack_recovery_unresolved");
      return receipt({ client: input.client, verified, disposition: "unchanged" });
    } catch (error) {
      return blocked(error, "bookstack_recovery_unresolved", recovery);
    }
  };

  const persist = async (value: unknown): Promise<VerifiedResult | BlockedResult> => {
    const call = optionalRecovery(value, ["request", "placement"]);
    const placement = projectLifecyclePlacement(call?.values.placement);
    if (!call || !placement) return blocked("bookstack_placement_invalid", "bookstack_placement_invalid");
    let record: BookStackLifecycleRecord;
    try {
      record = createLifecycleRecord({ request: call.values.request, placement });
      const request = validateLifecycleRequest(call.values.request);
      if (!request.valid || !placementMatchesRequest(placement, request)) throw new Error("bookstack_placement_invalid");
    } catch (error) {
      return blocked(error, "bookstack_record_invalid");
    }
    if (call.hasRecovery) {
      const recovery = projectRecoveryDescriptor(call.recovery);
      const expected = recoveryForPage({ client: input.client, record, pageId: recovery?.pageId ?? null });
      if (!recovery || recovery.operation !== "create_page" || recovery.originFingerprint !== originFingerprint(input.client.origin)
        || JSON.stringify(recovery) !== JSON.stringify(expected)) {
        return blocked("bookstack_recovery_unresolved", "bookstack_recovery_unresolved", recovery);
      }
      return reconcile(recovery);
    }
    try {
      await verifyHierarchy({ client: input.client, placement });
    } catch (error) {
      return blocked(error, "bookstack_record_invalid");
    }
    const title = pageName(record);
    let candidates: BookStackResource[];
    try {
      candidates = await canonicalPageCandidates(input.client, title);
    } catch (error) {
      return blocked(error, "bookstack_unavailable");
    }
    if (candidates.length > 1) return blocked("bookstack_identity_ambiguous", "bookstack_identity_ambiguous");
    if (candidates.length === 1) {
      try {
        const verified = await verifiedPage({ client: input.client, pageId: candidates[0].id, placement, expected: record });
        return receipt({ client: input.client, verified, disposition: "unchanged" });
      } catch (error) {
        return blocked(error, "bookstack_verification_failed");
      }
    }

    let created: BookStackResource;
    try {
      created = await input.client.createPage(title, placement.chapterId, record.pageMarkdown);
      if (!positiveId(created.id)) throw new Error("bookstack_response_invalid");
    } catch (error) {
      return blocked(error, "bookstack_write_unknown", recoveryForPage({ client: input.client, record, pageId: knownPostId(error) }));
    }
    const recovery = recoveryForPage({ client: input.client, record, pageId: created.id });
    if (created.slug !== title) return blocked("bookstack_slug_unexpected", "bookstack_verification_failed", recovery);
    try {
      const verified = await verifiedPage({ client: input.client, pageId: created.id, placement, expected: record });
      return receipt({ client: input.client, verified, disposition: "stored" });
    } catch (error) {
      return blocked(error, "bookstack_verification_failed", recovery);
    }
  };

  const get = async (value: unknown): Promise<VerifiedResult | BlockedResult> => {
    const locator = projectLocator(value, input.client.origin);
    if (!locator) return blocked("bookstack_locator_invalid", "bookstack_locator_invalid");
    try {
      const verified = await verifiedPage({ client: input.client, pageId: locator.pageId, placement: locator });
      if (verified.page.slug !== locator.pageSlug
        || verified.record.artifactId !== locator.artifactId
        || verified.record.recordKey !== locator.recordKey
        || verified.record.contentHash !== locator.contentHash
        || verified.pageHash !== locator.pageHash
        || verified.metadata.revisionCount !== locator.revisionCount
        || verified.metadata.updatedAt !== locator.updatedAt) throw new Error("bookstack_locator_mismatch");
      return receipt({ client: input.client, verified, disposition: "unchanged" });
    } catch (error) {
      return blocked(error, "bookstack_unavailable");
    }
  };

  const recall = async (value: unknown): Promise<VerifiedResult[] | BlockedResult> => {
    const selection = dataRecord(value, ["placement", "lifecycleKey", "sourceRef"]);
    const placement = projectLifecyclePlacement(selection?.placement);
    if (!selection || !placement || selection.lifecycleKey !== placement.lifecycleKey || selection.sourceRef !== placement.sourceRef) {
      return blocked("bookstack_placement_invalid", "bookstack_placement_invalid");
    }
    try {
      await verifyHierarchy({ client: input.client, placement });
      const chapterPages = (await input.client.listPages()).filter((page) => page.chapterId === placement.chapterId);
      const records = await Promise.all(chapterPages.map(async (page) => {
        const pageRecord = parseLifecycleRecord((await input.client.readPage(page.id)).markdown);
        if (!pageRecord) throw new Error("bookstack_verification_failed");
        const verified = await verifiedPage({ client: input.client, pageId: page.id, placement: pageRecord.placement });
        return placementMatches(pageRecord.placement, placement)
          && verified.record.lifecycleKey === placement.lifecycleKey
          && verified.record.identity.sourceRefs.includes(placement.sourceRef)
          ? receipt({ client: input.client, verified, disposition: "unchanged" })
          : null;
      }));
      return records.filter((record): record is VerifiedResult => record !== null);
    } catch (error) {
      return blocked(error, "bookstack_recall_unavailable");
    }
  };

  return { planPlacement: placement, ensurePlacement: ensure, persist, get, recall, reconcile };
};
