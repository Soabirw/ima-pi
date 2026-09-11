export type BookStackItem = { id: number; name: string; [key: string]: unknown };
type ListResult<T> = { data?: T[]; total?: number };
const MAX_PAGE_SIZE = 500;

export const normalizeBookStackOrigin = (origin: string) => {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("bookstack_origin_invalid");
  }
  return url.origin;
};

const item = (value: unknown): BookStackItem | null => value && typeof value === "object"
  && Number.isInteger((value as { id?: unknown }).id)
  && typeof (value as { name?: unknown }).name === "string"
  ? value as BookStackItem : null;

const bookIds = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  const ids = value.map((book) => typeof book === "number" && Number.isSafeInteger(book)
    ? book
    : book && typeof book === "object" && Number.isSafeInteger((book as { id?: unknown }).id)
      ? (book as { id: number }).id
      : null);
  return ids.some((id) => id === null) ? null : ids as number[];
};

export type BookStackClientInput = {
  origin: string;
  tokenId: string;
  tokenSecret: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type BookStackClient = ReturnType<typeof createBookStackClient>;

export function createBookStackClient(input: BookStackClientInput) {
  const origin = normalizeBookStackOrigin(input.origin);
  if (!input.tokenId || !input.tokenSecret || /[\r\n]/.test(input.tokenId + input.tokenSecret)) {
    throw new Error("bookstack_credentials_invalid");
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("bookstack_timeout_invalid");
  }
  const request = async (path: string, options: RequestInit = {}, expectJson = true) => {
    let response: Response;
    const requestSignal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      response = await fetcher(new URL(`/api/${path.replace(/^\//, "")}`, `${origin}/`), {
        ...options,
        redirect: "error",
        signal: options.signal ?? requestSignal,
        headers: {
          accept: "application/json",
          authorization: `Token ${input.tokenId}:${input.tokenSecret}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.headers ?? {}),
        },
      });
    } catch {
      throw new Error("bookstack_transport_failed");
    }
    if (!response.ok) throw new Error(`bookstack_http_${response.status}`);
    if (!expectJson) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) throw new Error("bookstack_response_invalid");
    try {
      return await response.json();
    } catch {
      throw new Error("bookstack_response_invalid");
    }
  };
  const list = async (resource: string) => {
    const collected: BookStackItem[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const query = new URLSearchParams({ count: String(MAX_PAGE_SIZE), offset: String(offset) });
      const response = await request(`${resource}?${query}`) as ListResult<unknown>;
      if (!Array.isArray(response.data)) throw new Error("bookstack_response_invalid");
      const entries = response.data.map(item);
      if (entries.some((entry) => entry === null)) throw new Error("bookstack_response_invalid");
      collected.push(...entries as BookStackItem[]);
      if (response.data.length < MAX_PAGE_SIZE) return collected;
      if (collected.length > 10_000) throw new Error("bookstack_page_limit");
    }
  };
  const create = async (resource: string, body: Record<string, unknown>) => {
    const result = item(await request(resource, { method: "POST", body: JSON.stringify(body) }));
    if (!result) throw new Error("bookstack_response_invalid");
    return result;
  };
  const read = async (resource: string, id: number) => {
    const result = item(await request(`${resource}/${id}`));
    if (!result || result.id !== id) throw new Error("bookstack_response_invalid");
    return result;
  };
  const resolveShelf = async (name: string) => {
    const matches = (await list("shelves")).filter((shelf) => shelf.name === name);
    if (matches.length === 0) throw new Error("bookstack_shelf_absent");
    if (matches.length > 1) throw new Error("bookstack_identity_ambiguous");
    return matches[0];
  };
  return {
    listShelves: () => list("shelves"),
    resolveShelf,
    listBooks: () => list("books"),
    listChapters: () => list("chapters"),
    listPages: () => list("pages"),
    readShelf: (id: number) => read("shelves", id),
    createBook: (name: string) => create("books", { name }),
    replaceShelfBooks: async (shelfId: number, name: string, books: number[]) => {
      const expectedBooks = [...new Set(books)];
      const updated = item(await request(`shelves/${shelfId}`, {
        method: "PUT",
        body: JSON.stringify({ name, books: expectedBooks }),
      }));
      if (!updated || updated.id !== shelfId || updated.name !== name) {
        throw new Error("bookstack_response_invalid");
      }
      const readBack = await read("shelves", shelfId);
      const observedBooks = bookIds(readBack.books);
      if (!observedBooks || observedBooks.length !== expectedBooks.length
        || expectedBooks.some((id) => !observedBooks.includes(id))) {
        throw new Error("bookstack_shelf_membership_invalid");
      }
    },
    createChapter: (name: string, bookId: number, description: string) =>
      create("chapters", { name, book_id: bookId, description }),
    createPage: (name: string, chapterId: number, markdown: string) =>
      create("pages", { name, chapter_id: chapterId, markdown }),
    readPage: (id: number) => read("pages", id),
    deletePage: async (id: number) => {
      await request(`pages/${id}`, { method: "DELETE" }, false);
    },
  };
}
