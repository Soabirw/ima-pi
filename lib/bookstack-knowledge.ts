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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasControlCharacters = (value: string) => /[\u0000-\u001F\u007F-\u009F]/.test(value);

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
  const creatorId = positiveInteger(value.created_by, "bookstack_response_invalid");
  const updaterId = positiveInteger(value.updated_by, "bookstack_response_invalid");
  const revisionCount = positiveInteger(value.revision_count, "bookstack_response_invalid");
  const updatedAt = requiredText(value.updated_at, "bookstack_response_invalid", 128);
  if (typeof value.markdown !== "string" || utf8ByteLength(value.markdown) > 128_000) {
    throw new Error("bookstack_response_invalid");
  }
  return { id, title, bookId, creatorId, updaterId, revisionCount, updatedAt, markdown: value.markdown };
}

export const sourceIdForPage = (pageId: number) => `bookstack:shared-dev-memory:${pageId}`;
