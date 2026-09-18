const FILTER_FIELDS = new Set([
  "corpus",
  "project",
  "artifact_type",
  "lifecycle_hash",
  "source_id",
]);
const RESERVED_FILTER_NAMES = new Set(["timestamp", "folder", "filename"]);
const MAX_FILTER_VALUE_BYTES = 64;
const MAX_LIFECYCLE_KEY_BYTES = 512;
const MAX_EXCERPT_BYTES = 2_000;
const MAX_SEARCH_RESULTS = 10;
export const MAX_BOOKSTACK_PAGE_URL_BYTES = 2_048;
const MAX_BOOKSTACK_SLUG_BYTES = 1_024;
const MAX_BOOKSTACK_CONTENT_ENTRIES = 10_000;
const BOOKSTACK_SLUG_PATTERN = /^[\p{L}\p{M}\p{N}_-]+$/u;

export type BookStackSearchFilters = Partial<Record<
  "corpus" | "project" | "artifact_type" | "lifecycle_hash" | "source_id",
  string
>>;

export type BookStackPage = {
  id: number;
  title: string;
  bookId: number;
  creatorId: number;
  updaterId: number;
  revisionCount: number;
  updatedAt: string;
  markdown: string;
};

export type BookStackPageIdentity = BookStackPage & {
  slug: string;
  draft: boolean;
};

export type BookStackPageUrl = {
  bookSlug: string;
  pageSlug: string;
};

export type BookStackPageListEntry = {
  id: number;
  bookId: number;
  slug: string;
  bookSlug: string;
  draft: boolean;
};

export type BookStackBookListEntry = {
  id: number;
  slug: string;
};

export type BookStackBook = {
  id: number;
  slug: string;
};

export type BookStackBookContentPage = {
  id: number;
  bookId: number;
  slug: string;
  draft: boolean;
};

export type BookStackBookWithContents = BookStackBook & {
  pages: BookStackBookContentPage[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasControlCharacters = (value: string) => /[\u0000-\u001F\u007F-\u009F]/.test(value);
const hasWhitespace = (value: string) => /\s/u.test(value);

export const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const boundedText = (value: string, maxBytes: number) => {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && utf8ByteLength(value.slice(0, end) + "…") > maxBytes) end -= 1;
  return value.slice(0, end) + "…";
};

const requiredText = (value: unknown, code: string, maxBytes: number) => {
  if (typeof value !== "string" || !value || hasControlCharacters(value) || utf8ByteLength(value) > maxBytes) {
    throw new Error(code);
  }
  return value;
};

const positiveInteger = (value: unknown, code: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
};

const requiredBookStackSlug = (value: unknown, code: string) => {
  if (typeof value !== "string" || !value || hasControlCharacters(value) || hasWhitespace(value)
    || utf8ByteLength(value) > MAX_BOOKSTACK_SLUG_BYTES || !BOOKSTACK_SLUG_PATTERN.test(value)) {
    throw new Error(code);
  }
  return value;
};

const requiredBookStackUserId = (value: unknown, code: string) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (!isPlainObject(value) || !Object.hasOwn(value, "id")) throw new Error(code);
  return positiveInteger(value.id, code);
};

export function validateSearchFilters(value: unknown): BookStackSearchFilters {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error("bookstack_filters_invalid");

  const filters: BookStackSearchFilters = {};
  for (const [name, filter] of Object.entries(value)) {
    const normalizedName = name.toLowerCase();
    if (RESERVED_FILTER_NAMES.has(normalizedName) || !FILTER_FIELDS.has(name)) {
      throw new Error("bookstack_filter_name_invalid");
    }
    filters[name as keyof BookStackSearchFilters] = requiredText(
      filter,
      "bookstack_filter_value_invalid",
      MAX_FILTER_VALUE_BYTES,
    );
  }
  return filters;
}

export function parseSourceId(value: unknown): number {
  if (typeof value !== "string") throw new Error("bookstack_source_id_invalid");
  const match = /^bookstack:shared-dev-memory:([1-9]\d*)$/.exec(value);
  if (!match) throw new Error("bookstack_source_id_invalid");
  const id = Number(match[1]);
  return positiveInteger(id, "bookstack_source_id_invalid");
}

const invalidPageUrl = (): never => {
  throw new Error("bookstack_url_invalid");
};

const decodedPageSlug = (value: string) => {
  if (/%(?:2f|5c)/i.test(value)) return invalidPageUrl();
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidPageUrl();
  }
  if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
    return invalidPageUrl();
  }
  try {
    return requiredBookStackSlug(decoded, "bookstack_url_invalid");
  } catch {
    return invalidPageUrl();
  }
};

export function parseBookStackPageUrl(value: unknown, configuredOrigin: unknown): BookStackPageUrl {
  if (typeof value !== "string" || !value || utf8ByteLength(value) > MAX_BOOKSTACK_PAGE_URL_BYTES
    || hasControlCharacters(value) || hasWhitespace(value) || value.includes("\\")
    || value.includes("?") || value.includes("#") || /%(?![0-9A-Fa-f]{2})/.test(value)
    || /%(?:2f|5c)/i.test(value)) {
    return invalidPageUrl();
  }

  const parts = /^https:\/\/([^/?#\\]*)(\/.*)$/i.exec(value);
  if (!parts || !parts[1] || parts[1].includes("@")) return invalidPageUrl();

  const pathSegments = parts[2].slice(1).split("/");
  if (pathSegments.length !== 4 || pathSegments.some((segment) => !segment || segment === "." || segment === "..")
    || pathSegments[0] !== "books" || pathSegments[2] !== "page") {
    return invalidPageUrl();
  }

  const bookSlug = decodedPageSlug(pathSegments[1]);
  const pageSlug = decodedPageSlug(pathSegments[3]);
  if (typeof configuredOrigin !== "string") throw new Error("bookstack_origin_invalid");

  let url: URL;
  let origin: URL;
  try {
    url = new URL(value);
    origin = new URL(configuredOrigin);
  } catch {
    return invalidPageUrl();
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== "/") {
    throw new Error("bookstack_origin_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.origin !== origin.origin) {
    return invalidPageUrl();
  }
  return { bookSlug, pageSlug };
}

export function buildPermalink(origin: unknown, pageId: unknown): string {
  const id = positiveInteger(pageId, "bookstack_page_id_invalid");
  if (typeof origin !== "string") throw new Error("bookstack_origin_invalid");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("bookstack_origin_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("bookstack_origin_invalid");
  }
  return `${url.origin}/link/${id}`;
}

export function buildFrontmatterEnvelope(input: {
  corpus: unknown;
  project: unknown;
  artifactType: unknown;
  lifecycleKey?: unknown;
  markdown: unknown;
}): string {
  const corpus = input.corpus === "lifecycle" || input.corpus === "ima-knowledge"
    ? input.corpus
    : null;
  if (!corpus) throw new Error("bookstack_corpus_invalid");
  const project = requiredText(input.project, "bookstack_project_invalid", MAX_FILTER_VALUE_BYTES);
  const artifactType = requiredText(input.artifactType, "bookstack_artifact_type_invalid", MAX_FILTER_VALUE_BYTES);
  const markdown = typeof input.markdown === "string" && !input.markdown.includes("\u0000")
    ? input.markdown
    : null;
  if (markdown === null || utf8ByteLength(markdown) > 128_000) throw new Error("bookstack_markdown_invalid");

  if (corpus === "lifecycle" && input.lifecycleKey === undefined) {
    throw new Error("bookstack_lifecycle_key_required");
  }
  const lifecycleKey = input.lifecycleKey === undefined
    ? null
    : requiredText(input.lifecycleKey, "bookstack_lifecycle_key_invalid", MAX_LIFECYCLE_KEY_BYTES);

  return [
    "---",
    "schema: ima-memory/v1",
    `project: ${project}`,
    `artifact_type: ${artifactType}`,
    ...(lifecycleKey === null ? [] : [`lifecycle_key: ${lifecycleKey}`]),
    "---",
    markdown,
  ].join("\n");
}

export function detectUpdateConflict(
  page: Pick<BookStackPage, "revisionCount" | "updatedAt">,
  expectedRevisionCount: unknown,
  expectedUpdatedAt: unknown,
): boolean {
  const revisionCount = positiveInteger(expectedRevisionCount, "bookstack_revision_count_invalid");
  const updatedAt = requiredText(expectedUpdatedAt, "bookstack_updated_at_invalid", 128);
  return page.revisionCount !== revisionCount || page.updatedAt !== updatedAt;
}

const searchChunk = (value: unknown, origin: string) => {
  if (!isPlainObject(value) || !isPlainObject(value.item) || !isPlainObject(value.item.metadata)) return null;
  const metadata = value.item.metadata;
  const sourceId = metadata.source_id;
  const text = value.text;
  const score = value.score;
  if (typeof sourceId !== "string" || typeof text !== "string" || !Number.isFinite(score)) return null;

  let pageId: number;
  try {
    pageId = parseSourceId(sourceId);
  } catch {
    return null;
  }
  const corpus = typeof metadata.corpus === "string" ? metadata.corpus : "";
  const project = typeof metadata.project === "string" ? metadata.project : "";
  const artifactType = typeof metadata.artifact_type === "string" ? metadata.artifact_type : "";
  if (!corpus || !project || !artifactType) return null;

  return {
    source_id: sourceId,
    canonical_url: buildPermalink(origin, pageId),
    excerpt: boundedText(text, MAX_EXCERPT_BYTES),
    score,
    corpus,
    project,
    artifact_type: artifactType,
  };
};

export function normalizeSearchResults(value: unknown, origin: string) {
  if (!isPlainObject(value) || !isPlainObject(value.result) || !Array.isArray(value.result.chunks)) {
    throw new Error("cloudflare_response_invalid");
  }
  const results = [];
  for (const chunk of value.result.chunks) {
    const normalized = searchChunk(chunk, origin);
    if (!normalized) throw new Error("cloudflare_response_invalid");
    results.push(normalized);
  }
  return results.slice(0, MAX_SEARCH_RESULTS);
}

export function parseBookStackPage(value: unknown, expectedId?: number): BookStackPage {
  if (!isPlainObject(value)) throw new Error("bookstack_response_invalid");
  const id = positiveInteger(value.id, "bookstack_response_invalid");
  if (expectedId !== undefined && id !== expectedId) throw new Error("bookstack_response_invalid");
  const title = requiredText(value.name, "bookstack_response_invalid", 512);
  const bookId = positiveInteger(value.book_id, "bookstack_response_invalid");
  const creatorId = requiredBookStackUserId(value.created_by, "bookstack_response_invalid");
  const updaterId = requiredBookStackUserId(value.updated_by, "bookstack_response_invalid");
  const revisionCount = positiveInteger(value.revision_count, "bookstack_response_invalid");
  const updatedAt = requiredText(value.updated_at, "bookstack_response_invalid", 128);
  if (typeof value.markdown !== "string" || utf8ByteLength(value.markdown) > 128_000) {
    throw new Error("bookstack_response_invalid");
  }
  return { id, title, bookId, creatorId, updaterId, revisionCount, updatedAt, markdown: value.markdown };
}

export function parseBookStackPageIdentity(value: unknown, expectedId?: number): BookStackPageIdentity {
  const page = parseBookStackPage(value, expectedId);
  if (!isPlainObject(value) || typeof value.draft !== "boolean") {
    throw new Error("bookstack_response_invalid");
  }
  const slug = requiredBookStackSlug(value.slug, "bookstack_response_invalid");
  return { ...page, slug, draft: value.draft };
}

export function parseBookStackPageListEntry(value: unknown, requestedSlug: string): BookStackPageListEntry {
  if (!isPlainObject(value) || typeof value.draft !== "boolean") {
    throw new Error("bookstack_response_invalid");
  }
  const slug = requiredBookStackSlug(value.slug, "bookstack_response_invalid");
  if (slug !== requestedSlug) throw new Error("bookstack_response_invalid");
  return {
    id: positiveInteger(value.id, "bookstack_response_invalid"),
    bookId: positiveInteger(value.book_id, "bookstack_response_invalid"),
    slug,
    bookSlug: requiredBookStackSlug(value.book_slug, "bookstack_response_invalid"),
    draft: value.draft,
  };
}

export function parseBookStackBookListEntry(value: unknown): BookStackBookListEntry {
  if (!isPlainObject(value)) throw new Error("bookstack_response_invalid");
  return {
    id: positiveInteger(value.id, "bookstack_response_invalid"),
    slug: requiredBookStackSlug(value.slug, "bookstack_response_invalid"),
  };
}

export function parseBookStackBook(value: unknown, expectedId?: number): BookStackBook {
  if (!isPlainObject(value)) throw new Error("bookstack_response_invalid");
  const id = positiveInteger(value.id, "bookstack_response_invalid");
  if (expectedId !== undefined && id !== expectedId) throw new Error("bookstack_response_invalid");
  return { id, slug: requiredBookStackSlug(value.slug, "bookstack_response_invalid") };
}

const parseBookStackBookContentPage = (
  value: unknown,
  expectedBookId: number,
  expectedChapterId: number | null,
): BookStackBookContentPage => {
  if (!isPlainObject(value) || typeof value.draft !== "boolean") {
    throw new Error("bookstack_response_invalid");
  }
  const id = positiveInteger(value.id, "bookstack_response_invalid");
  const bookId = positiveInteger(value.book_id, "bookstack_response_invalid");
  if (bookId !== expectedBookId) throw new Error("bookstack_response_invalid");
  if (expectedChapterId === null) {
    if (value.chapter_id !== null) throw new Error("bookstack_response_invalid");
  } else if (positiveInteger(value.chapter_id, "bookstack_response_invalid") !== expectedChapterId) {
    throw new Error("bookstack_response_invalid");
  }
  return {
    id,
    bookId,
    slug: requiredBookStackSlug(value.slug, "bookstack_response_invalid"),
    draft: value.draft,
  };
};

export function parseBookStackBookWithContents(value: unknown, expectedId?: number): BookStackBookWithContents {
  const book = parseBookStackBook(value, expectedId);
  if (!isPlainObject(value) || !Array.isArray(value.contents)) {
    throw new Error("bookstack_response_invalid");
  }

  const pages: BookStackBookContentPage[] = [];
  const pageIds = new Set<number>();
  const chapterIds = new Set<number>();
  let entryCount = 0;
  const addPage = (page: BookStackBookContentPage) => {
    if (pageIds.has(page.id)) throw new Error("bookstack_response_invalid");
    pageIds.add(page.id);
    pages.push(page);
  };
  const countEntry = () => {
    entryCount += 1;
    if (entryCount > MAX_BOOKSTACK_CONTENT_ENTRIES) throw new Error("bookstack_response_invalid");
  };

  for (const entry of value.contents) {
    countEntry();
    if (!isPlainObject(entry)) throw new Error("bookstack_response_invalid");
    if (entry.type === "page") {
      addPage(parseBookStackBookContentPage(entry, book.id, null));
      continue;
    }
    if (entry.type !== "chapter") throw new Error("bookstack_response_invalid");
    const chapterId = positiveInteger(entry.id, "bookstack_response_invalid");
    if (chapterIds.has(chapterId) || positiveInteger(entry.book_id, "bookstack_response_invalid") !== book.id) {
      throw new Error("bookstack_response_invalid");
    }
    chapterIds.add(chapterId);
    requiredBookStackSlug(entry.slug, "bookstack_response_invalid");
    if (!Array.isArray(entry.pages)) throw new Error("bookstack_response_invalid");
    for (const page of entry.pages) {
      countEntry();
      addPage(parseBookStackBookContentPage(page, book.id, chapterId));
    }
  }
  return { ...book, pages };
}

export const selectBookStackPageCandidate = (
  entries: readonly BookStackPageListEntry[],
  target: BookStackPageUrl,
): BookStackPageListEntry | null => {
  const matches = entries.filter((entry) => entry.bookSlug === target.bookSlug && entry.slug === target.pageSlug);
  if (matches.length === 0) return null;
  if (matches.some((entry) => entry.draft)) throw new Error("bookstack_page_draft");
  if (matches.length !== 1) throw new Error("bookstack_identity_ambiguous");
  return matches[0];
};

export const selectBookStackBookCandidate = (
  entries: readonly BookStackBookListEntry[],
  bookSlug: string,
): BookStackBookListEntry | null => {
  const matches = entries.filter((entry) => entry.slug === bookSlug);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("bookstack_identity_ambiguous");
  return matches[0];
};

export const selectBookStackContentPage = (
  entries: readonly BookStackBookContentPage[],
  pageSlug: string,
): BookStackBookContentPage | null => {
  const matches = entries.filter((entry) => entry.slug === pageSlug);
  if (matches.length === 0) return null;
  if (matches.some((entry) => entry.draft)) throw new Error("bookstack_page_draft");
  if (matches.length !== 1) throw new Error("bookstack_identity_ambiguous");
  return matches[0];
};

export const sourceIdForPage = (pageId: number) => `bookstack:shared-dev-memory:${pageId}`;
