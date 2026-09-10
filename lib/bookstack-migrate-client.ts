type BookStackItem = { id: number; name: string; [key: string]: unknown };
type ListResult<T> = { data?: T[]; total?: number };
const MAX_PAGE_SIZE = 500;

const safeOrigin = (origin: string) => {
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

export type BookStackClientInput = {
  origin: string;
  tokenId: string;
  tokenSecret: string;
  fetch?: typeof globalThis.fetch;
};

export type BookStackClient = ReturnType<typeof createBookStackClient>;

export function createBookStackClient(input: BookStackClientInput) {
  const origin = safeOrigin(input.origin);
  if (!input.tokenId || !input.tokenSecret || /[\r\n]/.test(input.tokenId + input.tokenSecret)) throw new Error("bookstack_credentials_invalid");
  const fetcher = input.fetch ?? globalThis.fetch;
  const request = async (path: string, options: RequestInit = {}) => {
    const response = await fetcher(new URL(`/api/${path.replace(/^\//, "")}`, `${origin}/`), {
      ...options,
      redirect: "error",
      headers: {
        accept: "application/json", authorization: `Token ${input.tokenId}:${input.tokenSecret}`,
        ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`bookstack_http_${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) throw new Error("bookstack_response_invalid");
    return response.json();
  };
  const list = async (resource: string, filter?: string) => {
    const collected: BookStackItem[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const query = new URLSearchParams({ count: String(MAX_PAGE_SIZE), offset: String(offset), ...(filter ? { filter } : {}) });
      const response = await request(`${resource}?${query}`) as ListResult<unknown>;
      if (!Array.isArray(response.data)) throw new Error("bookstack_response_invalid");
      const entries = response.data.map(item);
      if (entries.some((entry) => entry === null)) throw new Error("bookstack_response_invalid");
      collected.push(...entries as BookStackItem[]);
      if (response.data.length < MAX_PAGE_SIZE) return collected;
      if (collected.length > 10_000) throw new Error("bookstack_page_limit");
    }
  };
  const exactOne = async (resource: string, name: string) => {
    const matches = (await list(resource)).filter((entry) => entry.name === name);
    if (matches.length !== 1) throw new Error("bookstack_identity_ambiguous");
    return matches[0];
  };
  const create = async (resource: string, body: Record<string, unknown>) => {
    const result = item(await request(resource, { method: "POST", body: JSON.stringify(body) }));
    if (!result) throw new Error("bookstack_response_invalid");
    return result;
  };
  const read = async (resource: string, id: number) => {
    const result = item(await request(`${resource}/${id}`));
    if (!result) throw new Error("bookstack_response_invalid");
    return result;
  };
  const addBookToShelf = async (shelfId: number, bookId: number) => {
    const shelf = await read("shelves", shelfId);
    const books = Array.isArray(shelf.books) ? shelf.books.map((book) =>
      typeof book === "number" ? book : typeof book === "object" && book && Number.isInteger((book as { id?: unknown }).id) ? (book as { id: number }).id : null,
    ) : null;
    if (!books || books.some((id) => id === null)) throw new Error("bookstack_shelf_membership_invalid");
    const membership = [...new Set([...books as number[], bookId])];
    await request(`shelves/${shelfId}`, { method: "PUT", body: JSON.stringify({ name: shelf.name, books: membership }) });
  };
  return {
    listShelves: () => list("shelves"),
    resolveShelf: (name: string) => exactOne("shelves", name),
    listBooks: () => list("books"),
    listChapters: () => list("chapters"),
    listPages: () => list("pages"),
    createBook: (name: string) => create("books", { name }),
    addBookToShelf,
    createChapter: (name: string, bookId: number, description: string) => create("chapters", { name, book_id: bookId, description }),
    createPage: (name: string, chapterId: number, markdown: string) => create("pages", { name, chapter_id: chapterId, markdown }),
    readPage: (id: number) => read("pages", id),
    deletePage: async (id: number) => { await request(`pages/${id}`, { method: "DELETE" }); },
  };
}
