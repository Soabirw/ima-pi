import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  corpusFailure,
  storeLogicalInstitutionalRecord,
  utf8ByteLength,
  type CorpusResult,
  type InstitutionalRecordInput,
} from "../lib/qdrant-corpus.ts";
import {
  MAX_LOGICAL_RECORD_OUTPUT_BYTES,
  createQdrantCorpusClient,
  type QdrantCorpusClient,
} from "../lib/qdrant-http.ts";

const MAX_QUERY_LENGTH = 2_000;
const MAX_LIMIT = 20;
const MAX_RECORD_KEY_LENGTH = 512;
const MAX_PROJECT_LENGTH = 256;
const MAX_SITE_LENGTH = 256;
const MAX_REPOSITORY_LENGTH = 1_024;
const MAX_PHASE_LENGTH = 128;
const MAX_SOURCE_REFERENCES = 64;
const MAX_SOURCE_REFERENCE_LENGTH = 1_024;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_DETAIL_LENGTH = 128_000;
export const MAX_CORPUS_TOOL_OUTPUT_BYTES = MAX_LOGICAL_RECORD_OUTPUT_BYTES;

export type InstitutionalMemoryDependencies = {
  client?: QdrantCorpusClient;
  now?: () => Date;
};

const statusParameters = Type.Object({}, { additionalProperties: false });
const storeParameters = Type.Object({
  recordKey: Type.String({ minLength: 1, maxLength: MAX_RECORD_KEY_LENGTH }),
  project: Type.String({ minLength: 1, maxLength: MAX_PROJECT_LENGTH }),
  site: Type.String({ maxLength: MAX_SITE_LENGTH }),
  repo: Type.String({ maxLength: MAX_REPOSITORY_LENGTH }),
  lifecycleKey: Type.String({ minLength: 1, maxLength: MAX_RECORD_KEY_LENGTH }),
  phase: Type.String({ minLength: 1, maxLength: MAX_PHASE_LENGTH }),
  summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
  detail: Type.String({ minLength: 1, maxLength: MAX_DETAIL_LENGTH }),
  sourceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_SOURCE_REFERENCE_LENGTH }), { maxItems: MAX_SOURCE_REFERENCES })),
}, { additionalProperties: false });
const findParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
  project: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROJECT_LENGTH })),
  site: Type.Optional(Type.String({ maxLength: MAX_SITE_LENGTH })),
  repo: Type.Optional(Type.String({ maxLength: MAX_REPOSITORY_LENGTH })),
}, { additionalProperties: false });
const recallParameters = Type.Object({
  lifecycleKey: Type.String({ minLength: 1, maxLength: MAX_RECORD_KEY_LENGTH }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
}, { additionalProperties: false });
const getParameters = Type.Object({
  recordKey: Type.String({ minLength: 1, maxLength: MAX_RECORD_KEY_LENGTH }),
}, { additionalProperties: false });

const toolResult = (data: unknown) => {
  let text: unknown;
  try {
    text = JSON.stringify(data);
  } catch {
    throw new Error(corpusFailure("response_invalid").error.message);
  }
  if (typeof text !== "string") throw new Error(corpusFailure("response_invalid").error.message);
  if (utf8ByteLength(text) > MAX_CORPUS_TOOL_OUTPUT_BYTES) {
    throw new Error(corpusFailure("record_too_large").error.message);
  }
  return { content: [{ type: "text" as const, text }], details: data };
};

const resultOrThrow = <Data>(result: CorpusResult<Data>): Data => {
  if (result.success) return result.data;
  throw new Error(result.error.message);
};

export function registerInstitutionalMemoryTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  supplied: InstitutionalMemoryDependencies = {},
) {
  const client = supplied.client ?? createQdrantCorpusClient();
  const now = supplied.now ?? (() => new Date());

  pi.registerTool({
    name: "ima_corpus_status",
    label: "IMA corpus status",
    description: "Read-only Qdrant/Ollama institutional corpus prerequisite and compatibility check. It never bootstraps, indexes, stores, repairs, or migrates data.",
    parameters: statusParameters,
    async execute(_id, _request, signal) {
      return toolResult(resultOrThrow(await client.status(signal)));
    },
  });

  pi.registerTool({
    name: "ima_corpus_store",
    label: "Store IMA corpus record",
    description: "Store one bounded immutable institutional record. Large detail is stored as a summary manifest plus verified vectorless chunks; repeated identical records are unchanged and conflicting content fails.",
    parameters: storeParameters,
    async execute(_id, request, signal) {
      const result = resultOrThrow(await storeLogicalInstitutionalRecord({
        record: request as InstitutionalRecordInput,
        createdAt: now().toISOString(),
        operations: client,
        signal,
      }));
      return toolResult(result);
    },
  });

  pi.registerTool({
    name: "ima_corpus_find",
    label: "Find IMA corpus records",
    description: "Semantically find bounded institutional-record summaries. Full detail is never returned by this tool.",
    parameters: findParameters,
    async execute(_id, request, signal) {
      const result = resultOrThrow(await client.findInstitutional({
        query: request.query,
        limit: request.limit ?? MAX_LIMIT,
        filters: {
          ...(request.project === undefined ? {} : { project: request.project }),
          ...(request.site === undefined ? {} : { site: request.site }),
          ...(request.repo === undefined ? {} : { repo: request.repo }),
        },
      }, signal));
      return toolResult({ results: result });
    },
  });

  pi.registerTool({
    name: "ima_corpus_recall",
    label: "Recall IMA corpus lifecycle records",
    description: "Retrieve bounded institutional-record summaries by an exact lifecycle key. Full detail is never returned by this tool.",
    parameters: recallParameters,
    async execute(_id, request, signal) {
      const result = resultOrThrow(await client.recallInstitutional({
        lifecycleKey: request.lifecycleKey,
        limit: request.limit ?? MAX_LIMIT,
      }, signal));
      return toolResult({ results: result });
    },
  });

  pi.registerTool({
    name: "ima_corpus_get",
    label: "Get IMA corpus record",
    description: "Retrieve one full bounded institutional record by deterministic record key. It fails instead of returning a partial record.",
    parameters: getParameters,
    async execute(_id, request, signal) {
      return toolResult(resultOrThrow(await client.getInstitutional(request.recordKey, signal)));
    },
  });
}

export default function institutionalMemory(pi: ExtensionAPI) {
  registerInstitutionalMemoryTools(pi);
}
