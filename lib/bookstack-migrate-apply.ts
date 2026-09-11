import type { BookStackClient, BookStackItem } from "./bookstack-migrate-client.ts";
import type { BookStackMigrationReport, MigrationOutcome } from "./bookstack-migrate-report.ts";
import { sourceBodyMatches, type TargetPage } from "./bookstack-migrate-source.ts";

const APPROVED_SHELVES = ["Lifecycle Artifacts", "Institutional Knowledge"] as const;
const parentId = (item: BookStackItem, field: string) => typeof item[field] === "number" ? item[field] : null;
const identityKey = (parent: number, name: string) => `${parent}\0${name}`;

const addToIndex = (index: Map<string, BookStackItem[]>, key: string, item: BookStackItem) => {
  index.set(key, [...(index.get(key) ?? []), item]);
};

const indexByName = (items: BookStackItem[]) => {
  const index = new Map<string, BookStackItem[]>();
  for (const item of items) addToIndex(index, item.name, item);
  return index;
};

const indexByParentAndName = (items: BookStackItem[], parent: string) => {
  const index = new Map<string, BookStackItem[]>();
  for (const item of items) {
    const id = parentId(item, parent);
    if (id !== null) addToIndex(index, identityKey(id, item.name), item);
  }
  return index;
};

const exactShelf = (shelves: BookStackItem[], name: string) => {
  const matches = shelves.filter((shelf) => shelf.name === name);
  if (matches.length === 0) throw new Error("bookstack_shelf_absent");
  if (matches.length > 1) throw new Error("bookstack_shelf_ambiguous");
  return matches[0];
};

const shelfBookIds = (shelf: BookStackItem) => {
  if (!Array.isArray(shelf.books)) throw new Error("bookstack_shelf_membership_invalid");
  const ids = shelf.books.map((book) => {
    if (typeof book === "number" && Number.isSafeInteger(book)) return book;
    if (book && typeof book === "object" && Number.isSafeInteger((book as { id?: unknown }).id)) {
      return (book as { id: number }).id;
    }
    throw new Error("bookstack_shelf_membership_invalid");
  });
  return new Set(ids);
};

export type BookStackCatalog = {
  shelfIds: Map<string, number>;
  shelfBooks: Map<number, Set<number>>;
  books: Map<string, BookStackItem[]>;
  chapters: Map<string, BookStackItem[]>;
  pages: Map<string, BookStackItem[]>;
};

export const emptyBookStackCatalog = (): BookStackCatalog => ({
  shelfIds: new Map(),
  shelfBooks: new Map(),
  books: new Map(),
  chapters: new Map(),
  pages: new Map(),
});

export async function buildBookStackCatalog(client: BookStackClient): Promise<BookStackCatalog> {
  const shelves = await client.listShelves();
  const selected = APPROVED_SHELVES.map((name) => [name, exactShelf(shelves, name)] as const);
  const detailedShelves = await Promise.all(selected.map(async ([name, shelf]) => {
    const detailed = await client.readShelf(shelf.id);
    if (detailed.id !== shelf.id || detailed.name !== name) throw new Error("bookstack_response_invalid");
    return [name, detailed] as const;
  }));
  const [books, chapters, pages] = await Promise.all([
    client.listBooks(),
    client.listChapters(),
    client.listPages(),
  ]);
  return {
    shelfIds: new Map(detailedShelves.map(([name, shelf]) => [name, shelf.id])),
    shelfBooks: new Map(detailedShelves.map(([, shelf]) => [shelf.id, shelfBookIds(shelf)])),
    books: indexByName(books),
    chapters: indexByParentAndName(chapters, "book_id"),
    pages: indexByParentAndName(pages, "chapter_id"),
  };
}

const exactOrCreate = async (
  matches: BookStackItem[],
  create: () => Promise<BookStackItem>,
) => {
  if (matches.length > 1) throw new Error("bookstack_identity_ambiguous");
  return matches[0] ?? await create();
};

export async function ensureBookStackPage(
  client: BookStackClient,
  page: TargetPage,
  catalog: BookStackCatalog,
) {
  const shelfId = catalog.shelfIds.get(page.shelfName);
  if (!shelfId) throw new Error("bookstack_shelf_absent");

  const book = await exactOrCreate(catalog.books.get(page.bookName) ?? [], async () => {
    const created = await client.createBook(page.bookName);
    addToIndex(catalog.books, page.bookName, created);
    return created;
  });
  const membership = catalog.shelfBooks.get(shelfId);
  if (!membership) throw new Error("bookstack_shelf_membership_invalid");
  if (!membership.has(book.id)) {
    await client.replaceShelfBooks(shelfId, page.shelfName, [...membership, book.id]);
    membership.add(book.id);
  }

  const chapterKey = identityKey(book.id, page.chapterName);
  const chapter = await exactOrCreate(catalog.chapters.get(chapterKey) ?? [], async () => {
    const created = await client.createChapter(
      page.chapterName,
      book.id,
      `lifecycle/source grouping for ${page.chapterName}`,
    );
    addToIndex(catalog.chapters, chapterKey, created);
    return created;
  });

  const pageKey = identityKey(chapter.id, page.pageName);
  const matches = catalog.pages.get(pageKey) ?? [];
  if (matches.length > 1) throw new Error("bookstack_identity_ambiguous");
  if (matches.length === 1) {
    const existing = await client.readPage(matches[0].id);
    const markdown = typeof existing.markdown === "string" ? existing.markdown : "";
    return sourceBodyMatches(markdown, page.body)
      ? { status: "unchanged" as const, targetId: existing.id }
      : { status: "conflict" as const, targetId: existing.id };
  }

  const created = await client.createPage(page.pageName, chapter.id, page.markdown);
  addToIndex(catalog.pages, pageKey, created);
  const readBack = await client.readPage(created.id);
  const markdown = typeof readBack.markdown === "string" ? readBack.markdown : "";
  return sourceBodyMatches(markdown, page.body)
    ? { status: "created" as const, targetId: created.id }
    : { status: "unverified" as const, targetId: created.id };
}

const safeErrorCode = (error: unknown) => {
  const code = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]{1,128}$/.test(code) ? code : "apply_page_failed";
};

export const classifyApplyError = (error: unknown): "record" | "trip" =>
  safeErrorCode(error) === "bookstack_identity_ambiguous" ? "record" : "trip";

export async function applyBookStackPages(input: {
  client: BookStackClient;
  catalog: BookStackCatalog;
  pages: TargetPage[];
  initialOutcomes?: BookStackMigrationReport["outcomes"];
}): Promise<MigrationOutcome[]> {
  const outcomes: MigrationOutcome[] = [...(input.initialOutcomes ?? [])];
  let tripped = false;
  for (const page of input.pages) {
    if (tripped) {
      outcomes.push({
        sourceId: page.sourceId,
        sourceHash: page.sourceHash,
        status: "failed",
        code: "apply_not_attempted",
      });
      continue;
    }
    try {
      outcomes.push({
        sourceId: page.sourceId,
        sourceHash: page.sourceHash,
        ...await ensureBookStackPage(input.client, page, input.catalog),
      });
    } catch (error) {
      outcomes.push({
        sourceId: page.sourceId,
        sourceHash: page.sourceHash,
        status: "failed",
        code: safeErrorCode(error),
      });
      tripped = classifyApplyError(error) === "trip";
    }
  }
  return outcomes;
}
