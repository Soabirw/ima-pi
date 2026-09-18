import {
  MAX_LIFECYCLE_RESPONSE_BYTES,
  createBookStackHttpClient,
  type BookStackHttpClientInput,
} from "./bookstack-http.ts";
import { utf8ByteLength } from "./qdrant-corpus.ts";

const PAGE_SIZE = 500;
const MAX_LIST_ENTRIES = 10_000;
const MAX_REMOTE_TEXT_BYTES = 1_024;

type ObjectValue = Record<string, unknown>;
export type BookStackResource = {
  id: number;
  name: string;
  slug: string;
  books?: number[];
  bookId?: number;
  chapterId?: number;
  markdown?: string;
  revisionCount?: number;
  updatedAt?: string;
  creatorId?: number;
  updaterId?: number;
};

export type BookStackClientFailure = Error & { knownResourceId?: number };

const object = (value: unknown): ObjectValue | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const boundedText = (value: unknown, allowEmpty = false) => typeof value === "string"
  && (allowEmpty || value.length > 0)
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  && utf8ByteLength(value) <= MAX_REMOTE_TEXT_BYTES
  ? value
  : null;
const userId = (value: unknown) => {
  if (positiveId(value)) return value;
  const nestedId = object(value)?.id;
  return positiveId(nestedId) ? nestedId : null;
};
const books = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const ids = value.map((book) => positiveId(book) ? book : object(book)?.id);
  return ids.every(positiveId) && new Set(ids).size === ids.length ? ids : null;
};
const invalidResource = (value: unknown): BookStackClientFailure => {
  const error = new Error("bookstack_response_invalid") as BookStackClientFailure;
  const knownResourceId = object(value)?.id;
  if (positiveId(knownResourceId)) error.knownResourceId = knownResourceId;
  return error;
};

const parseResource = (
  value: unknown,
  allowEmptySlug = false,
): BookStackResource | null => {
  const input = object(value);
  if (!input || !positiveId(input.id)) return null;
  const name = boundedText(input.name);
  const slug = boundedText(input.slug, allowEmptySlug);
  if (!name || slug === null) return null;
  const bookId = input.book_id === undefined ? undefined : input.book_id;
  const chapterId = input.chapter_id === undefined || input.chapter_id === null
    ? undefined
    : input.chapter_id;
  const markdown = input.markdown === undefined ? undefined : input.markdown;
  const revisionCount = input.revision_count === undefined ? undefined : input.revision_count;
  const updatedAt = input.updated_at === undefined ? undefined : boundedText(input.updated_at);
  const creatorId = input.created_by === undefined ? undefined : userId(input.created_by);
  const updaterId = input.updated_by === undefined ? undefined : userId(input.updated_by);
  const shelfBooks = input.books === undefined ? undefined : books(input.books);
  if ((bookId !== undefined && !positiveId(bookId))
    || (chapterId !== undefined && !positiveId(chapterId))
    || (markdown !== undefined && typeof markdown !== "string")
    || (revisionCount !== undefined && (!Number.isSafeInteger(revisionCount) || Number(revisionCount) < 0))
    || (input.updated_at !== undefined && !updatedAt)
    || (input.created_by !== undefined && !creatorId)
    || (input.updated_by !== undefined && !updaterId)
    || (input.books !== undefined && !shelfBooks)) return null;
  return {
    id: input.id,
    name,
    slug,
    ...(shelfBooks ? { books: shelfBooks } : {}),
    ...(bookId ? { bookId } : {}),
    ...(chapterId ? { chapterId } : {}),
    ...(markdown === undefined ? {} : { markdown }),
    ...(revisionCount === undefined ? {} : { revisionCount: Number(revisionCount) }),
    ...(updatedAt ? { updatedAt } : {}),
    ...(creatorId ? { creatorId } : {}),
    ...(updaterId ? { updaterId } : {}),
  };
};

const expectedResource = (value: unknown, id?: number) => {
  const resource = parseResource(value);
  if (!resource || (id && resource.id !== id)) throw invalidResource(value);
  return resource;
};

const hasStrictlyAscendingPositiveIds = (
  resources: BookStackResource[],
  previousId: number,
) => resources.every((resource, index) =>
  positiveId(resource.id)
    && resource.id > (index === 0 ? previousId : resources[index - 1].id),
);

export type BookStackLifecycleClientInput = BookStackHttpClientInput;

export const createBookStackLifecycleClient = (input: BookStackLifecycleClientInput) => {
  const http = createBookStackHttpClient({ ...input, maxResponseBytes: MAX_LIFECYCLE_RESPONSE_BYTES });
  const list = async (resource: "shelves" | "books" | "chapters" | "pages") => {
    const entries: BookStackResource[] = [];
    let expectedTotal: number | null = null;
    let previousId = 0;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const response = object(await http.request(resource, {}, new URLSearchParams({
        count: String(PAGE_SIZE),
        offset: String(offset),
        sort: "+id",
      })));
      const total = response?.total;
      if (!Number.isSafeInteger(total) || Number(total) < 0 || Number(total) > MAX_LIST_ENTRIES) {
        throw new Error("bookstack_pagination_invalid");
      }
      const currentTotal = Number(total);
      if (expectedTotal !== null && currentTotal < expectedTotal) {
        throw new Error("bookstack_pagination_invalid");
      }
      expectedTotal = currentTotal;
      if (!Array.isArray(response?.data) || response.data.length > PAGE_SIZE) {
        throw new Error("bookstack_pagination_invalid");
      }
      const page = response.data.map((entry) => parseResource(entry, resource === "pages"));
      if (page.some((entry) => entry === null)) throw new Error("bookstack_response_invalid");
      const resources = page as BookStackResource[];
      if (!hasStrictlyAscendingPositiveIds(resources, previousId)) {
        throw new Error("bookstack_pagination_invalid");
      }
      entries.push(...resources);
      previousId = resources.at(-1)?.id ?? previousId;
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length || entries.length > expectedTotal) {
        throw new Error("bookstack_pagination_invalid");
      }
      if (entries.length === expectedTotal) return entries;
      const expectedBatchSize = Math.min(PAGE_SIZE, expectedTotal - offset);
      if (page.length !== expectedBatchSize) throw new Error("bookstack_pagination_invalid");
    }
  };
  const read = async (resource: "shelves" | "books" | "chapters" | "pages", id: number) => {
    if (!positiveId(id)) throw new Error("bookstack_resource_id_invalid");
    return expectedResource(await http.request(`${resource}/${id}`), id);
  };
  const create = async (resource: "shelves" | "books" | "chapters" | "pages", body: ObjectValue) =>
    expectedResource(await http.request(resource, { method: "POST", body: JSON.stringify(body) }));

  return {
    origin: http.origin,
    listShelves: () => list("shelves"),
    listBooks: () => list("books"),
    listChapters: () => list("chapters"),
    listPages: () => list("pages"),
    readShelf: (id: number) => read("shelves", id),
    readBook: (id: number) => read("books", id),
    readChapter: (id: number) => read("chapters", id),
    readPage: (id: number) => read("pages", id),
    createShelf: (name: string) => create("shelves", { name }),
    createBook: (name: string) => create("books", { name }),
    createChapter: (name: string, bookId: number) => create("chapters", {
      name,
      book_id: bookId,
      description: "Immutable IMA lifecycle artifacts.",
    }),
    createPage: (name: string, chapterId: number, markdown: string) => create("pages", {
      name,
      chapter_id: chapterId,
      markdown,
    }),
    async replaceShelfBooks(value: { shelfId: number; shelfName: string; expectedBooks: number[] }) {
      if (!positiveId(value.shelfId) || !boundedText(value.shelfName)
        || !value.expectedBooks.every(positiveId)
        || new Set(value.expectedBooks).size !== value.expectedBooks.length) {
        throw new Error("bookstack_shelf_membership_invalid");
      }
      const updated = expectedResource(await http.request(`shelves/${value.shelfId}`, {
        method: "PUT",
        body: JSON.stringify({ name: value.shelfName, books: value.expectedBooks }),
      }), value.shelfId);
      const readBack = await read("shelves", value.shelfId);
      if (updated.name !== value.shelfName
        || !readBack.books
        || readBack.books.length !== value.expectedBooks.length
        || readBack.books.some((id, index) => id !== value.expectedBooks[index])) {
        throw new Error("bookstack_shelf_membership_invalid");
      }
      return readBack;
    },
  };
};

export type BookStackLifecycleClient = ReturnType<typeof createBookStackLifecycleClient>;
