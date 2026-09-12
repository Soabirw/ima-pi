import {
  projectPlacementInput,
  type LifecyclePlacement,
} from "./bookstack-lifecycle-record.ts";
import type {
  BookStackLifecycleClient,
  BookStackResource,
} from "./bookstack-lifecycle-client.ts";
import {
  PENDING_PROJECT_BOOK,
  originFingerprint,
  projectRecoveryDescriptor,
  recoveryDescriptor,
  safeFailure,
  type FailureCategory,
  type RecoveryDescriptor,
} from "./bookstack-lifecycle-recovery.ts";

const SHELF_SLUG = "lifecycle-artifacts";

type PlacementInput = {
  projectSlug: string;
  sourceRef: string;
  lifecycleKey: string;
};

export type PlacementPreview = {
  projectSlug: string;
  sourceRef: string;
  lifecycleKey: string;
  chapterSlug: string;
  creates: Array<"shelf" | "book" | "chapter">;
  shelf: {
    id: number | null;
    slug: string;
    membershipBefore: number[];
    membershipAfter: Array<number | "new-project-book">;
  };
  book: { id: number | null; slug: string; attachToShelf: boolean };
  chapter: { id: number | null; slug: string };
  sharingImplications: string;
  requiredPrerequisites: string[];
};

export type PlacementResult =
  | { status: "verified"; placement: LifecyclePlacement; preview: PlacementPreview }
  | {
    status: "blocked";
    code: string;
    category: FailureCategory;
    recovery: RecoveryDescriptor | null;
  };

const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && value > 0;
const sameMembers = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const detachedMembers = (value: unknown) => Array.isArray(value)
  && value.length <= 10_000
  && value.every(positiveId)
  && new Set(value).size === value.length
  ? [...value]
  : null;
const requiredMembers = (value: unknown) => {
  const members = detachedMembers(value);
  if (!members) throw new Error("bookstack_shelf_membership_invalid");
  return members;
};
const matching = (resources: BookStackResource[], slug: string, bookId?: number) => {
  const matches = resources.filter((resource) => resource.slug === slug
    && (bookId === undefined || resource.bookId === bookId));
  if (matches.length > 1) throw new Error("bookstack_identity_ambiguous");
  return matches[0] ?? null;
};
const exactResource = (
  resource: BookStackResource | undefined,
  expected: { id?: number; slug: string; bookId?: number },
) => {
  if (!resource || !positiveId(resource.id) || resource.slug !== expected.slug
    || (expected.id !== undefined && resource.id !== expected.id)
    || (expected.bookId !== undefined && resource.bookId !== expected.bookId)) {
    throw new Error("bookstack_slug_unexpected");
  }
  return resource;
};
const failed = (error: unknown, fallback: string, recovery: unknown = null): PlacementResult => ({
  status: "blocked",
  ...safeFailure(error, fallback),
  recovery: projectRecoveryDescriptor(recovery),
});
const knownPostId = (error: unknown): number | null => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error as object, "knownResourceId");
    return positiveId(descriptor?.value) ? descriptor.value : null;
  } catch {
    return null;
  }
};
const recovery = (input: {
  client: BookStackLifecycleClient;
  location: Pick<PlacementPreview, "projectSlug" | "sourceRef" | "lifecycleKey" | "chapterSlug">;
  operation: RecoveryDescriptor["operation"];
  shelfId: number | null;
  bookId: number | null;
  chapterId: number | null;
  membershipBefore: number[];
  membershipAfter: Array<number | "new-project-book">;
}) => recoveryDescriptor({
  origin: input.client.origin,
  operation: input.operation,
  projectSlug: input.location.projectSlug,
  sourceRef: input.location.sourceRef,
  lifecycleKey: input.location.lifecycleKey,
  intendedSlug: input.operation === "create_shelf" || input.operation === "attach_book"
    ? SHELF_SLUG
    : input.operation === "create_book" ? input.location.projectSlug : input.location.chapterSlug,
  shelfId: input.shelfId,
  shelfSlug: SHELF_SLUG,
  bookId: input.bookId,
  bookSlug: input.location.projectSlug,
  chapterId: input.chapterId,
  chapterSlug: input.location.chapterSlug,
  pageId: null,
  membershipBefore: input.membershipBefore,
  membershipAfter: input.membershipAfter,
  artifactId: "",
  recordKey: "",
  contentHash: "",
  pageHash: "",
});

export const planPlacement = async (
  client: BookStackLifecycleClient,
  input: PlacementInput,
): Promise<PlacementPreview> => {
  const location = projectPlacementInput(input);
  if (!location) throw new Error("bookstack_placement_invalid");
  const [shelves, books, chapters] = await Promise.all([
    client.listShelves(),
    client.listBooks(),
    client.listChapters(),
  ]);
  const listedShelf = matching(shelves, SHELF_SLUG);
  const shelf = listedShelf ? exactResource(await client.readShelf(listedShelf.id), { id: listedShelf.id, slug: SHELF_SLUG }) : null;
  const membershipBefore = shelf ? requiredMembers(shelf.books) : [];
  const book = matching(books, location.projectSlug);
  const attached = Boolean(book && membershipBefore.includes(book.id));
  if (book && !attached) throw new Error("bookstack_placement_conflict");
  const chapter = book
    ? matching(chapters, location.chapterSlug, book.id)
    : null;
  return {
    projectSlug: location.projectSlug,
    sourceRef: location.sourceRef,
    lifecycleKey: location.lifecycleKey,
    chapterSlug: location.chapterSlug,
    creates: [
      ...(shelf ? [] : ["shelf" as const]),
      ...(book ? [] : ["book" as const]),
      ...(chapter ? [] : ["chapter" as const]),
    ],
    shelf: {
      id: shelf?.id ?? null,
      slug: SHELF_SLUG,
      membershipBefore,
      membershipAfter: book ? [...membershipBefore] : [...membershipBefore, PENDING_PROJECT_BOOK],
    },
    book: { id: book?.id ?? null, slug: location.projectSlug, attachToShelf: !book },
    chapter: { id: chapter?.id ?? null, slug: location.chapterSlug },
    sharingImplications: "Attaching the project book changes organization-visible shelf membership; shelf permissions do not secure newly created books.",
    requiredPrerequisites: [
      "Administrator-confirmed private defaults for newly created resources.",
      "Administrator-confirmed complete shelf membership visibility.",
      "Serialized provisioning and lifecycle writes for this placement.",
    ],
  };
};

const samePreview = (left: PlacementPreview, right: PlacementPreview) =>
  JSON.stringify(left) === JSON.stringify(right);

const reconcilePlacement = async (
  client: BookStackLifecycleClient,
  input: PlacementInput,
  value: unknown,
): Promise<PlacementResult> => {
  const recoveryValue = projectRecoveryDescriptor(value);
  const location = projectPlacementInput(input);
  if (!recoveryValue || !location
    || recoveryValue.originFingerprint !== originFingerprint(client.origin)
    || recoveryValue.projectSlug !== location.projectSlug
    || recoveryValue.sourceRef !== location.sourceRef
    || recoveryValue.lifecycleKey !== location.lifecycleKey
    || recoveryValue.operation === "create_page") {
    return failed("bookstack_recovery_unresolved", "bookstack_recovery_unresolved", recoveryValue);
  }
  try {
    const readShelf = async () => exactResource(await client.readShelf(recoveryValue.shelfId!), {
      id: recoveryValue.shelfId!, slug: SHELF_SLUG,
    });
    if (recoveryValue.operation === "create_shelf") {
      const shelf = recoveryValue.shelfId
        ? await readShelf()
        : await (async () => {
          const candidate = exactResource(matching(await client.listShelves(), SHELF_SLUG), { slug: SHELF_SLUG });
          return exactResource(await client.readShelf(candidate.id), { id: candidate.id, slug: SHELF_SLUG });
        })();
      const complete = recoveryValue.shelfId ? recoveryValue : recovery({
        client,
        location,
        operation: "create_shelf", shelfId: shelf.id, bookId: null, chapterId: null, membershipBefore: [], membershipAfter: [PENDING_PROJECT_BOOK],
      });
      if (!sameMembers(requiredMembers(shelf.books), complete.membershipBefore)) throw new Error("bookstack_recovery_unresolved");
      return failed("bookstack_recovery_reconciled", "bookstack_recovery_unresolved", complete);
    }
    const shelf = await readShelf();
    if (recoveryValue.operation === "create_book") {
      const book = recoveryValue.bookId
        ? exactResource(await client.readBook(recoveryValue.bookId), { id: recoveryValue.bookId, slug: location.projectSlug })
        : await (async () => {
          const candidate = exactResource(matching(await client.listBooks(), location.projectSlug), { slug: location.projectSlug });
          return exactResource(await client.readBook(candidate.id), { id: candidate.id, slug: location.projectSlug });
        })();
      const complete = recoveryValue.bookId ? recoveryValue : recovery({
        client,
        location,
        operation: "create_book", shelfId: shelf.id, bookId: book.id, chapterId: null,
        membershipBefore: recoveryValue.membershipBefore, membershipAfter: [...recoveryValue.membershipBefore, book.id],
      });
      if (!sameMembers(requiredMembers(shelf.books), complete.membershipBefore)) throw new Error("bookstack_recovery_unresolved");
      return failed("bookstack_recovery_reconciled", "bookstack_recovery_unresolved", complete);
    }
    const book = exactResource(await client.readBook(recoveryValue.bookId!), { id: recoveryValue.bookId!, slug: location.projectSlug });
    if (recoveryValue.operation === "attach_book") {
      if (!sameMembers(requiredMembers(shelf.books), recoveryValue.membershipAfter as number[])) throw new Error("bookstack_recovery_unresolved");
      return failed("bookstack_recovery_reconciled", "bookstack_recovery_unresolved", recoveryValue);
    }
    const chapter = recoveryValue.chapterId
      ? exactResource(await client.readChapter(recoveryValue.chapterId), { id: recoveryValue.chapterId, slug: location.chapterSlug, bookId: book.id })
      : await (async () => {
        const candidate = exactResource(
          matching(await client.listChapters(), location.chapterSlug, book.id),
          { slug: location.chapterSlug, bookId: book.id },
        );
        return exactResource(await client.readChapter(candidate.id), {
          id: candidate.id,
          slug: location.chapterSlug,
          bookId: book.id,
        });
      })();
    const complete = recoveryValue.chapterId ? recoveryValue : recovery({
      client,
      location,
      operation: "create_chapter", shelfId: shelf.id, bookId: book.id, chapterId: chapter.id,
      membershipBefore: recoveryValue.membershipBefore, membershipAfter: recoveryValue.membershipAfter,
    });
    if (!sameMembers(requiredMembers(shelf.books), complete.membershipAfter as number[])) throw new Error("bookstack_recovery_unresolved");
    return failed("bookstack_recovery_reconciled", "bookstack_recovery_unresolved", complete);
  } catch {
    return failed("bookstack_recovery_unresolved", "bookstack_recovery_unresolved", recoveryValue);
  }
};

export const ensurePlacement = async (input: {
  client: BookStackLifecycleClient;
  placement: PlacementInput;
  approve?: (preview: PlacementPreview) => Promise<boolean> | boolean;
  recovery?: unknown;
}): Promise<PlacementResult> => {
  const location = projectPlacementInput(input.placement);
  if (!location) return failed("bookstack_placement_invalid", "bookstack_placement_invalid");
  const placement = {
    projectSlug: location.projectSlug,
    sourceRef: location.sourceRef,
    lifecycleKey: location.lifecycleKey,
  };
  if (Object.hasOwn(input, "recovery")) {
    return reconcilePlacement(input.client, placement, input.recovery);
  }
  let approved: PlacementPreview;
  try {
    approved = await planPlacement(input.client, placement);
  } catch (error) {
    return failed(error, "bookstack_placement_unavailable");
  }
  if (!input.approve) return failed("bookstack_approval_required", "bookstack_approval_required");
  try {
    if (await input.approve(structuredClone(approved)) !== true) {
      return failed("bookstack_approval_declined", "bookstack_approval_declined");
    }
  } catch {
    return failed("bookstack_approval_declined", "bookstack_approval_declined");
  }
  let current: PlacementPreview;
  try {
    current = await planPlacement(input.client, placement);
  } catch (error) {
    return failed(error, "bookstack_placement_unavailable");
  }
  if (!samePreview(approved, current)) return failed("bookstack_approval_stale", "bookstack_approval_stale");

  const shelfWasCreated = current.shelf.id === null;
  let shelfId = current.shelf.id;
  if (!shelfId) {
    try {
      shelfId = (await input.client.createShelf(SHELF_SLUG)).id;
      if (!positiveId(shelfId)) throw new Error("bookstack_response_invalid");
    } catch (error) {
      return failed(error, "bookstack_placement_unavailable", recovery({
        client: input.client, location: current, operation: "create_shelf", shelfId: knownPostId(error), bookId: null, chapterId: null,
        membershipBefore: [], membershipAfter: [PENDING_PROJECT_BOOK],
      }));
    }
  }
  let shelf: BookStackResource;
  try {
    shelf = exactResource(await input.client.readShelf(shelfId), { id: shelfId, slug: SHELF_SLUG });
    if (!sameMembers(requiredMembers(shelf.books), current.shelf.membershipBefore)) throw new Error("bookstack_shelf_membership_conflict");
  } catch (error) {
    if (!shelfWasCreated) return failed(error, "bookstack_placement_unavailable");
    return failed(error, "bookstack_placement_unavailable", recovery({
      client: input.client, location: current, operation: "create_shelf", shelfId, bookId: null, chapterId: null,
      membershipBefore: [], membershipAfter: [PENDING_PROJECT_BOOK],
    }));
  }

  const bookWasCreated = current.book.id === null;
  let bookId = current.book.id;
  if (!bookId) {
    try {
      bookId = (await input.client.createBook(current.projectSlug)).id;
      if (!positiveId(bookId)) throw new Error("bookstack_response_invalid");
    } catch (error) {
      return failed(error, "bookstack_placement_unavailable", recovery({
        client: input.client, location: current, operation: "create_book", shelfId, bookId: knownPostId(error), chapterId: null,
        membershipBefore: current.shelf.membershipBefore,
        membershipAfter: knownPostId(error) ? [...current.shelf.membershipBefore, knownPostId(error)!] : [...current.shelf.membershipBefore, PENDING_PROJECT_BOOK],
      }));
    }
  }
  let book: BookStackResource;
  try {
    book = exactResource(await input.client.readBook(bookId), { id: bookId, slug: current.projectSlug });
  } catch (error) {
    if (!bookWasCreated) return failed(error, "bookstack_placement_unavailable");
    return failed(error, "bookstack_placement_unavailable", recovery({
      client: input.client, location: current, operation: "create_book", shelfId, bookId, chapterId: null,
      membershipBefore: current.shelf.membershipBefore, membershipAfter: [...current.shelf.membershipBefore, bookId],
    }));
  }

  const membershipAfter = shelf.books?.includes(book.id)
    ? [...current.shelf.membershipBefore]
    : [...current.shelf.membershipBefore, book.id];
  if (!shelf.books?.includes(book.id)) {
    try {
      const beforeMutation = exactResource(await input.client.readShelf(shelf.id), { id: shelf.id, slug: SHELF_SLUG });
      if (!sameMembers(requiredMembers(beforeMutation.books), current.shelf.membershipBefore)) throw new Error("bookstack_shelf_membership_conflict");
      await input.client.replaceShelfBooks({ shelfId: shelf.id, shelfName: shelf.name, expectedBooks: membershipAfter });
    } catch (error) {
      return failed(error, "bookstack_placement_unavailable", recovery({
        client: input.client, location: current, operation: "attach_book", shelfId: shelf.id, bookId: book.id, chapterId: null,
        membershipBefore: current.shelf.membershipBefore, membershipAfter,
      }));
    }
  }

  let chapterId = current.chapter.id;
  if (!chapterId) {
    try {
      chapterId = (await input.client.createChapter(current.chapterSlug, book.id)).id;
      if (!positiveId(chapterId)) throw new Error("bookstack_response_invalid");
    } catch (error) {
      return failed(error, "bookstack_placement_unavailable", recovery({
        client: input.client, location: current, operation: "create_chapter", shelfId: shelf.id, bookId: book.id, chapterId: knownPostId(error),
        membershipBefore: current.shelf.membershipBefore, membershipAfter,
      }));
    }
  }
  let chapter: BookStackResource;
  try {
    chapter = exactResource(await input.client.readChapter(chapterId), { id: chapterId, slug: current.chapterSlug, bookId: book.id });
    const verifiedShelf = exactResource(await input.client.readShelf(shelf.id), { id: shelf.id, slug: SHELF_SLUG });
    if (!sameMembers(requiredMembers(verifiedShelf.books), membershipAfter)) throw new Error("bookstack_shelf_membership_invalid");
  } catch (error) {
    return failed(error, "bookstack_placement_unavailable", recovery({
      client: input.client, location: current, operation: "create_chapter", shelfId: shelf.id, bookId: book.id, chapterId,
      membershipBefore: current.shelf.membershipBefore, membershipAfter,
    }));
  }

  return {
    status: "verified",
    preview: approved,
    placement: {
      projectSlug: current.projectSlug,
      sourceRef: current.sourceRef,
      lifecycleKey: current.lifecycleKey,
      shelfId: shelf.id,
      shelfSlug: shelf.slug,
      bookId: book.id,
      bookSlug: book.slug,
      chapterId: chapter.id,
      chapterSlug: chapter.slug,
    },
  };
};
