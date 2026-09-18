import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_BOOKSTACK_PAGE_URL_BYTES,
  buildFrontmatterEnvelope,
  detectUpdateConflict,
  parseSourceId,
  sourceIdForPage,
  utf8ByteLength,
  validateSearchFilters,
  type BookStackSearchFilters,
} from "../lib/bookstack-knowledge.ts";
import {
  createBookStackKnowledgeClient,
  createBookStackSearchClient,
  resolveBookStackKnowledgeOrigin,
} from "../lib/bookstack-knowledge-clients.ts";

const MAX_QUERY_BYTES = 2_000;
const MAX_TITLE_BYTES = 512;
const MAX_MARKDOWN_BYTES = 128_000;
const MAX_FILTER_BYTES = 64;
const MAX_LIFECYCLE_KEY_BYTES = 512;

type Environment = Record<string, string | undefined>;
type SearchClient = ReturnType<typeof createBookStackSearchClient>;
type KnowledgeClient = ReturnType<typeof createBookStackKnowledgeClient>;

export type BookStackKnowledgeDependencies = {
  environment?: Environment;
  createSearchClient?: (input: Parameters<typeof createBookStackSearchClient>[0]) => SearchClient;
  createKnowledgeClient?: (input: Parameters<typeof createBookStackKnowledgeClient>[0]) => KnowledgeClient;
};

const filterParameters = Type.Object({
  corpus: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_FILTER_BYTES })),
  project: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_FILTER_BYTES })),
  artifact_type: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_FILTER_BYTES })),
  lifecycle_hash: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_FILTER_BYTES })),
  source_id: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_FILTER_BYTES })),
}, { additionalProperties: false });

const searchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: MAX_QUERY_BYTES }),
  filters: Type.Optional(filterParameters),
}, { additionalProperties: false });

const readParameters = Type.Object({
  sourceId: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 128,
    description: "BookStack source ID; mutually exclusive with url.",
  })),
  url: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_BOOKSTACK_PAGE_URL_BYTES,
    description: "Configured BookStack book/page URL; mutually exclusive with sourceId.",
  })),
}, {
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
});

const writeParameters = Type.Object({
  corpus: Type.Union([Type.Literal("lifecycle"), Type.Literal("ima-knowledge")]),
  project: Type.String({ minLength: 1, maxLength: MAX_FILTER_BYTES }),
  artifactType: Type.String({ minLength: 1, maxLength: MAX_FILTER_BYTES }),
  lifecycleKey: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_LIFECYCLE_KEY_BYTES })),
  title: Type.String({ minLength: 1, maxLength: MAX_TITLE_BYTES }),
  markdown: Type.String({ maxLength: MAX_MARKDOWN_BYTES }),
  sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  expectedRevisionCount: Type.Optional(Type.Integer({ minimum: 1 })),
  expectedUpdatedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
}, { additionalProperties: false });

const resultText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: value,
});

type ReadTarget =
  | { kind: "source"; value: unknown }
  | { kind: "url"; value: unknown };

const readTarget = (value: unknown): ReadTarget => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) {
    throw new Error("bookstack_read_input_invalid");
  }
  const request = value as Record<string, unknown>;
  const hasSourceId = Object.hasOwn(request, "sourceId");
  const hasUrl = Object.hasOwn(request, "url");
  if (hasSourceId === hasUrl) throw new Error("bookstack_read_input_invalid");
  return hasSourceId
    ? { kind: "source", value: request.sourceId }
    : { kind: "url", value: request.url };
};

const stableFailure = (error: unknown): never => {
  const code = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message)
    ? error.message
    : "bookstack_operation_failed";
  throw new Error(code);
};

const requiredTitle = (value: unknown) => {
  if (typeof value !== "string" || !value || /[\u0000-\u001F\u007F-\u009F]/.test(value)
    || utf8ByteLength(value) > MAX_TITLE_BYTES) {
    throw new Error("bookstack_title_invalid");
  }
  return value;
};

const bookIdForCorpus = (environment: Environment, corpus: "lifecycle" | "ima-knowledge") => {
  const name = corpus === "lifecycle"
    ? "BOOKSTACK_LIFECYCLE_BOOK_ID"
    : "BOOKSTACK_KNOWLEDGE_BOOK_ID";
  const value = environment[name];
  if (!value || !/^[1-9]\d*$/.test(value)) throw new Error("bookstack_book_id_invalid");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error("bookstack_book_id_invalid");
  return id;
};

const provenance = (client: KnowledgeClient, page: Awaited<ReturnType<KnowledgeClient["readPage"]>>) => ({
  source_id: sourceIdForPage(page.id),
  canonical_url: client.permalink(page.id),
  title: page.title,
  book_id: page.bookId,
  page_id: page.id,
  creator_id: page.creatorId,
  updater_id: page.updaterId,
  revision_count: page.revisionCount,
  updated_at: page.updatedAt,
});

const validQuery = (value: unknown) => {
  if (typeof value !== "string" || !value || /[\u0000-\u001F\u007F-\u009F]/.test(value)
    || utf8ByteLength(value) > MAX_QUERY_BYTES) {
    throw new Error("bookstack_query_invalid");
  }
  return value;
};

const searchClientFor = (
  environment: Environment,
  createSearchClient: NonNullable<BookStackKnowledgeDependencies["createSearchClient"]>,
) => createSearchClient({
  accountId: environment.CLOUDFLARE_ACCOUNT_ID ?? "",
  token: environment.CLOUDFLARE_API_MEMORY ?? "",
  bookStackOrigin: resolveBookStackKnowledgeOrigin(environment),
});

const knowledgeClientFor = (
  environment: Environment,
  createKnowledgeClient: NonNullable<BookStackKnowledgeDependencies["createKnowledgeClient"]>,
  signal: AbortSignal | undefined,
) => createKnowledgeClient({
  origin: resolveBookStackKnowledgeOrigin(environment),
  tokenId: environment.BOOKSTACK_TOKEN_ID ?? "",
  tokenSecret: environment.BOOKSTACK_TOKEN_SECRET ?? "",
  signal,
});

export function registerBookStackKnowledgeTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  supplied: BookStackKnowledgeDependencies = {},
) {
  const environment = supplied.environment ?? process.env;
  const createSearchClient = supplied.createSearchClient ?? createBookStackSearchClient;
  const createKnowledgeClient = supplied.createKnowledgeClient ?? createBookStackKnowledgeClient;

  pi.registerTool({
    name: "ima_bookstack_search",
    label: "Search shared BookStack knowledge",
    description: "Discover private BookStack candidates through Cloudflare AI Search. Results are bounded derived excerpts with BookStack provenance; use ima_bookstack_read for authoritative content.",
    parameters: searchParameters,
    async execute(_id, request, signal) {
      try {
        const query = validQuery(request.query);
        const filters = validateSearchFilters(request.filters) as BookStackSearchFilters;
        const results = await searchClientFor(environment, createSearchClient).search({ query, filters, signal });
        return resultText({ results });
      } catch (error) {
        return stableFailure(error);
      }
    },
  });

  pi.registerTool({
    name: "ima_bookstack_read",
    label: "Read authoritative BookStack page",
    description: "Read an authoritative current BookStack page by its shared-memory source ID or configured book/page URL and return bounded content with provenance.",
    parameters: readParameters,
    async execute(_id, request, signal) {
      try {
        const target = readTarget(request);
        const pageId = target.kind === "source" ? parseSourceId(target.value) : undefined;
        const client = knowledgeClientFor(environment, createKnowledgeClient, signal);
        const page = pageId === undefined
          ? await client.readPageByUrl(target.value)
          : await client.readPage(pageId);
        return resultText({ ...provenance(client, page), content: page.markdown });
      } catch (error) {
        return stableFailure(error);
      }
    },
  });

  pi.registerTool({
    name: "ima_bookstack_write",
    label: "Create or update BookStack knowledge",
    description: "Create or optimistic-concurrency update a shared BookStack knowledge page with the required ima-memory/v1 envelope.",
    parameters: writeParameters,
    async execute(_id, request, signal) {
      try {
        const title = requiredTitle(request.title);
        const bookId = bookIdForCorpus(environment, request.corpus);
        const markdown = buildFrontmatterEnvelope({
          corpus: request.corpus,
          project: request.project,
          artifactType: request.artifactType,
          lifecycleKey: request.lifecycleKey,
          markdown: request.markdown,
        });
        const client = knowledgeClientFor(environment, createKnowledgeClient, signal);

        if (request.sourceId === undefined) {
          if (request.expectedRevisionCount !== undefined || request.expectedUpdatedAt !== undefined) {
            throw new Error("bookstack_update_fields_invalid");
          }
          const page = await client.createPage({ title, bookId, markdown });
          if (page.bookId !== bookId) throw new Error("bookstack_response_invalid");
          return resultText({ action: "created", ...provenance(client, page) });
        }

        if (request.expectedRevisionCount === undefined || request.expectedUpdatedAt === undefined) {
          throw new Error("bookstack_update_fields_required");
        }
        const pageId = parseSourceId(request.sourceId);
        const current = await client.readPage(pageId);
        if (current.bookId !== bookId || detectUpdateConflict(
          current,
          request.expectedRevisionCount,
          request.expectedUpdatedAt,
        )) {
          throw new Error("bookstack_update_conflict");
        }
        await client.updatePage({ pageId, title, bookId, markdown });
        const verified = await client.readPage(pageId);
        if (verified.revisionCount <= current.revisionCount) throw new Error("bookstack_revision_not_advanced");
        return resultText({ action: "updated", ...provenance(client, verified) });
      } catch (error) {
        return stableFailure(error);
      }
    },
  });
}

export default function bookStackKnowledgeExtension(pi: ExtensionAPI) {
  registerBookStackKnowledgeTools(pi);
}
