/** FNR-3016 production boundary for external IMA context and lifecycle services. */
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  derivePhaseContext,
  evaluateSerenaBootstrap,
  type ContextSource,
  normalizeCorpusLifecycleRecord,
  normalizeSourcePayload,
  prepareContextArguments,
  sanitizeContextError,
  sanitizeContextText,
  STANDARD_MEMORIES,
  validateContextRequest,
} from "../lib/ima-context.ts";
import {
  deriveLifecycleResult,
  evaluateLifecycleArtifact,
  normalizeLifecycleRecordKey,
  prepareLifecycleArtifact,
  validateLifecycleRequest,
  validateLifecycleStoreReceipt,
} from "../lib/ima-lifecycle.ts";
import { storeInstitutionalManifest } from "../lib/qdrant-corpus.ts";
import { withMcpSession } from "../lib/mcp-client.ts";
import { createQdrantCorpusClient, type QdrantCorpusClient } from "../lib/qdrant-http.ts";

const execFile = promisify(execFileCallback);
const TIMEOUT = 30_000;
const MCP_TIMEOUT = 300_000;
const VESTIGE_TIMEOUT = 300_000;
const LIFECYCLE_RECALL_LIMIT = 10;
const MAX_BUFFER = 128 * 1024;
const SOURCE_ERROR_CODES = ["source_path_outside_project", "source_file_unreadable", "source_file_too_large"];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceErrorCode = (error: unknown) => error instanceof Error && SOURCE_ERROR_CODES.includes(error.message) ? error.message : "source_boundary_unavailable";
const inside = (root: string, target: string) => { const path = relative(root, target); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const normalizeUuid = (value: unknown) => typeof value === "string" && UUID_PATTERN.test(value)
  ? value.toLowerCase()
  : null;
const envelope = (value: string) => { try { return JSON.parse(value); } catch { return null; } };
const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) signal.throwIfAborted();
};

const mcpServer = async (name: string) => {
  try {
    const config = object(envelope(await readFile(join(packageRoot, "config", "mcp.json"), "utf8")));
    const server = object(object(config?.mcpServers)?.[name]);
    const command = text(server?.command);
    const args = server?.args === undefined
      ? []
      : Array.isArray(server.args) && server.args.every((value) => typeof value === "string")
        ? server.args
        : null;

    return command && args ? { command, args } : null;
  } catch {
    return null;
  }
};

export type McpToolCaller = (
  name: string,
  arguments_: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;

export type McpSession = <Result>(
  serverName: string,
  callback: (call: McpToolCaller) => Promise<Result>,
  signal?: AbortSignal,
) => Promise<Result | null>;

export const withConfiguredMcpSession: McpSession = async (
  serverName,
  callback,
  signal,
) => {
  const server = await mcpServer(serverName);
  if (!server) return null;

  try {
    return await withMcpSession(server, callback, signal);
  } catch {
    return null;
  }
};

const lifecycleRecallQuery = (value: string) => {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf(" ");
  if (separator < 1) return null;
  const lifecycleKey = trimmed.slice(0, separator);
  const phase = trimmed.slice(separator + 1);
  return lifecycleKey && ["plan", "implementation", "test", "review", "resolution", "rereview", "decision", "closeout"].includes(phase)
    ? { lifecycleKey, phase }
    : null;
};

export const recallCorpusLifecycle = async (
  query: string,
  corpus: QdrantCorpusClient = createQdrantCorpusClient(),
  signal?: AbortSignal,
) => {
  const selection = lifecycleRecallQuery(query);
  if (!selection) return null;

  try {
    const recalled = await corpus.recallInstitutional({
      lifecycleKey: selection.lifecycleKey,
      phase: selection.phase,
      limit: LIFECYCLE_RECALL_LIMIT,
    }, signal);
    throwIfAborted(signal);
    if (!recalled.success) return null;

    const records: Array<{ id: string; recordKey: string; content: string }> = [];
    for (const summary of recalled.data) {
      const full = await corpus.getInstitutional(summary.recordKey, signal);
      throwIfAborted(signal);
      if (!full.success) return null;
      const recordKey = normalizeLifecycleRecordKey(full.data.recordKey);
      if (!recordKey) return null;
      records.push({
        id: full.data.id,
        recordKey,
        content: full.data.detail,
      });
    }
    return { structuredContent: { results: records } };
  } catch {
    throwIfAborted(signal);
    return null;
  }
};

export type IntegrationDependencies = {
  run?: (program: string, args: string[], signal?: AbortSignal) => Promise<unknown>;
  read?: (path: string) => Promise<string>;
  canonical?: (path: string) => Promise<string>;
  stat?: typeof lstat;
  session?: McpSession;
  corpus?: QdrantCorpusClient;
  home?: () => string;
  now?: () => Date;
};

const productionDependencies: Required<IntegrationDependencies> = {
  run: async (program, args, signal) => {
    throwIfAborted(signal);
    try {
      const { stdout } = await execFile(program, args, {
        timeout: TIMEOUT,
        maxBuffer: MAX_BUFFER,
        signal,
      });
      return envelope(stdout);
    } catch {
      throwIfAborted(signal);
      return null;
    }
  },
  read: (path) => readFile(path, "utf8"),
  canonical: realpath,
  stat: lstat,
  session: withConfiguredMcpSession,
  corpus: createQdrantCorpusClient(),
  home: homedir,
  now: () => new Date(),
};

const depsFor = (given?: IntegrationDependencies) => ({ ...productionDependencies, ...given });
const directResponse = (value: unknown) => {
  const response = object(value);
  return response?.isError === true ? null : response;
};
const directStructured = (value: unknown) => object(directResponse(value)?.structuredContent);
export const mcpResultData = (value: unknown): Record<string, unknown> | null => {
  const response = directResponse(value);
  if (!response) return null;

  const structured = object(response.structuredContent);
  if (structured) return structured;
  if (Array.isArray(response.content)) {
    for (const content of response.content) {
      const item = object(content);
      if (typeof item?.text !== "string") continue;
      const parsed = envelope(item.text);
      if (object(parsed)) return object(parsed);
    }
  }

  return response;
};
const directResult = (value: unknown) => {
  const response = directResponse(value);
  if (!response) return null;

  const structured = object(response.structuredContent);
  if (typeof structured?.result === "string") return structured.result;
  if (!Array.isArray(response.content)) return null;

  for (const content of response.content) {
    const item = object(content);
    if (typeof item?.text === "string") return item.text;
  }

  return null;
};
const listedMemoryNames = (value: string | null) => {
  if (value === null) return null;

  try {
    const listing = object(JSON.parse(value));
    const names = listing?.memories;
    return Array.isArray(names) && names.every((name) => typeof name === "string") ? names : null;
  } catch {
    return null;
  }
};
const safeToolCall = async (
  call: McpToolCaller,
  name: string,
  arguments_: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
) => {
  throwIfAborted(signal);
  try {
    const result = await call(name, arguments_, timeoutMs);
    throwIfAborted(signal);
    return result;
  } catch {
    throwIfAborted(signal);
    return null;
  }
};
const serenaFailure = (
  activated: boolean,
  instructionsLoaded: boolean,
  memoryListLoaded: boolean,
  blocking: string,
) => ({
  bootstrap: evaluateSerenaBootstrap({ activated, instructionsLoaded, memoryListLoaded }),
  blocking,
});

async function serena(
  root: string,
  deps: Required<IntegrationDependencies>,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  try {
    const setup = await deps.session("serena", async (call) => {
      const activation = directResult(await safeToolCall(
        call,
        "activate_project",
        { project: root },
        MCP_TIMEOUT,
        signal,
      ));
      if (activation === null) return serenaFailure(false, false, false, "serena_activation_failed");

      const instructions = directResult(await safeToolCall(
        call,
        "initial_instructions",
        {},
        MCP_TIMEOUT,
        signal,
      ));
      if (instructions === null) return serenaFailure(true, false, false, "serena_instructions_failed");

      const listing = directResult(await safeToolCall(
        call,
        "list_memories",
        {},
        MCP_TIMEOUT,
        signal,
      ));
      const names = listedMemoryNames(listing);
      if (!names) return serenaFailure(true, true, false, "serena_memory_list_failed");

      const memories: Record<string, string | null | "failed"> = {};
      for (const name of STANDARD_MEMORIES) {
        if (!names.includes(name)) {
          memories[name] = null;
          continue;
        }

        const content = directResult(await safeToolCall(
          call,
          "read_memory",
          { memory_name: name },
          MCP_TIMEOUT,
          signal,
        ));
        memories[name] = text(content) || "failed";
      }

      return {
        bootstrap: evaluateSerenaBootstrap({
          activated: true,
          instructionsLoaded: true,
          memoryListLoaded: true,
          memories,
        }),
        blocking: null,
      };
    }, signal);

    throwIfAborted(signal);
    return setup ?? serenaFailure(false, false, false, "serena_activation_failed");
  } catch {
    throwIfAborted(signal);
    return serenaFailure(false, false, false, "serena_activation_failed");
  }
}

async function loadDurableKnowledge(
  request: { query: string; collection?: string; limit?: number },
  deps: Required<IntegrationDependencies>,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  try {
    const response = await deps.corpus.findKnowledge({
      query: request.query,
      collection: request.collection ?? "ima-knowledge",
      limit: request.limit ?? 20,
    }, signal);
    throwIfAborted(signal);
    if (!response.success) return { requested: true, status: "failed" as const, references: [] };

    const references = response.data
      .slice(0, request.limit ?? 20)
      .map(({ summary, score }) => ({ summary: sanitizeContextText(summary, 512), score }))
      .filter(({ summary }) => Boolean(summary));
    return references.length > 0
      ? { requested: true, status: "loaded" as const, references }
      : { requested: true, status: "empty" as const, references: [] };
  } catch {
    throwIfAborted(signal);
    return { requested: true, status: "failed" as const, references: [] };
  }
}

type PlaneSource = Extract<ContextSource, { type: "plane" }>;

const normalizePlaneResponse = (source: PlaneSource, value: unknown) => {
  const data = object(value);
  if (!data) return null;

  const canonical = `plane:${source.workspace}:${source.project}-${source.sequenceId}`;
  const identifier = `${source.project}-${source.sequenceId}`;
  const id = normalizeUuid(data.id);
  const projectId = normalizeUuid(data.projectId);
  const stateId = data.stateId === null ? null : normalizeUuid(data.stateId);
  const name = text(data.name);
  const description = data.description;
  if (
    !id
    || !projectId
    || data.reference !== canonical
    || data.workspace !== source.workspace
    || data.identifier !== identifier
    || data.sequenceId !== source.sequenceId
    || !name
    || typeof description !== "string"
    || (data.stateId !== null && stateId === null)
  ) return null;

  return {
    key: canonical,
    title: name,
    content: JSON.stringify({ name, description, state: stateId, reference: canonical }),
    references: [`Plane:${source.workspace}:${identifier}`],
  };
};

async function sourcePayload(
  source: ContextSource,
  root: string,
  deps: Required<IntegrationDependencies>,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  if (source.type === "text") {
    return { key: source.title, title: source.title, content: source.content, references: [] };
  }
  if (source.type === "jira") {
    const helper = join(deps.home(), ".agents", "skills", "mcp-atlassian", "scripts", "atlassian-api.mjs");
    const result = await deps.run("node", [helper, "jira:get", source.key], signal);
    throwIfAborted(signal);
    const data = object(result);
    return data
      ? {
        key: source.key,
        title: text(data.summary) || source.key,
        content: text(data.descriptionText) || text(data.summary),
        references: ["https://flccc.atlassian.net/browse/" + source.key],
      }
      : null;
  }
  if (source.type === "taskwarrior") {
    const result = await deps.run("task", ["rc.verbose=nothing", `project:${source.project}`, source.uuid, "export"], signal);
    throwIfAborted(signal);
    const resultObject = object(result);
    const tasks = Array.isArray(result) ? result : (Array.isArray(resultObject?.data) ? resultObject.data : []);
    const matches = tasks.filter((item) => object(item)?.uuid === source.uuid && object(item)?.project === source.project);
    const value = object(matches.length === 1 ? matches[0] : null);
    return value
      ? {
        key: source.uuid,
        title: text(value.description),
        content: JSON.stringify({
          description: value.description,
          status: value.status,
          tags: value.tags,
          depends: value.depends,
          annotations: value.annotations,
        }),
        references: [`Taskwarrior:${source.project}:${source.uuid}`],
      }
      : null;
  }
  if (source.type === "plane") {
    const canonical = `plane:${source.workspace}:${source.project}-${source.sequenceId}`;
    const helper = join(
      packageRoot,
      "skills",
      "plane-api",
      "scripts",
      "plane-api.mjs",
    );
    const response = object(await deps.run("node", [helper, "plane:get", canonical], signal));
    throwIfAborted(signal);
    return response?.success === true
      ? normalizePlaneResponse(source, response.data)
      : null;
  }
  if (source.type === "lifecycle") {
    const recalled = await deps.corpus.recallInstitutional({
      lifecycleKey: source.key,
      limit: LIFECYCLE_RECALL_LIMIT,
    }, signal);
    throwIfAborted(signal);
    if (!recalled.success) return null;

    for (const summary of recalled.data) {
      const full = await deps.corpus.getInstitutional(summary.recordKey, signal);
      throwIfAborted(signal);
      if (!full.success) return null;
      const artifact = normalizeCorpusLifecycleRecord({
        lifecycleKey: source.key,
        record: full.data,
      });
      if (!artifact) continue;
      return {
        key: source.key,
        title: `Lifecycle ${source.key}`,
        content: artifact.content,
        references: [`Qdrant:${artifact.id}`, `QdrantRecordKey:${artifact.recordKey}`],
      };
    }
    return null;
  }
  if (source.type === "vestige") {
    try {
      const value = await deps.session("vestige", (call) => call(
        "memory",
        { action: "get", id: source.id },
        VESTIGE_TIMEOUT,
      ), signal);
      throwIfAborted(signal);
      const structured = directStructured(value);
      const content = text(object(structured?.node)?.content);
      return structured?.found === true && content
        ? { key: source.id, title: `Vestige ${source.id}`, content, references: [`Vestige:${source.id}`] }
        : null;
    } catch {
      throwIfAborted(signal);
      return null;
    }
  }
  if (source.type !== "file") return null;

  const lexical = resolve(root, source.path);
  if (!inside(root, lexical)) throw new Error("source_path_outside_project");
  const actual = await deps.canonical(lexical);
  throwIfAborted(signal);
  if (!inside(root, actual)) throw new Error("source_path_outside_project");
  const info = await deps.stat(actual);
  throwIfAborted(signal);
  if (!info.isFile()) throw new Error("source_file_unreadable");
  if (info.size > 256 * 1024) throw new Error("source_file_too_large");
  const content = await deps.read(actual);
  throwIfAborted(signal);
  if (content.includes("\0")) throw new Error("source_file_unreadable");
  return { key: source.path, title: source.path, content, references: [`File:${source.path}`] };
}

export async function coordinateContext(
  request: unknown,
  cwd: string,
  supplied?: IntegrationDependencies,
  signal?: AbortSignal,
) {
  const valid = validateContextRequest(request);
  if (!valid.valid) return { status: "failed", error: valid.error };

  throwIfAborted(signal);
  const deps = depsFor(supplied);
  const root = await deps.canonical(cwd);
  throwIfAborted(signal);
  const setup = await serena(root, deps, signal);
  throwIfAborted(signal);
  if (setup.blocking) {
    return derivePhaseContext({
      cwd: root,
      serenaProjectPath: root,
      source: null,
      serena: setup.bootstrap,
      diagnostics: [{ code: setup.blocking, stage: "serena", message: "Serena bootstrap did not complete." }],
    });
  }

  try {
    const payload = await sourcePayload(valid.source, root, deps, signal);
    throwIfAborted(signal);
    const source = normalizeSourcePayload({ source: valid.source, payload });
    const durableKnowledge = valid.durableKnowledge
      ? await loadDurableKnowledge(valid.durableKnowledge, deps, signal)
      : undefined;
    throwIfAborted(signal);
    return derivePhaseContext({
      cwd: root,
      serenaProjectPath: root,
      source,
      serena: setup.bootstrap,
      durableKnowledge,
      diagnostics: source
        ? []
        : [{ code: "source_boundary_unavailable", stage: "source", message: "Source hydration did not return usable content." }],
    });
  } catch (error) {
    throwIfAborted(signal);
    return derivePhaseContext({
      cwd: root,
      serenaProjectPath: root,
      source: null,
      serena: setup.bootstrap,
      diagnostics: [{ code: sourceErrorCode(error), stage: "source", message: "Source hydration failed." }],
    });
  }
}

export async function coordinateLifecycle(
  request: unknown,
  supplied?: IntegrationDependencies,
  signal?: AbortSignal,
) {
  const valid = validateLifecycleRequest(request);
  if (!valid.valid) {
    return {
      status: "failed",
      artifactId: null,
      recordKey: null,
      error: valid.error,
    };
  }

  throwIfAborted(signal);
  const deps = depsFor(supplied);
  const preparation = prepareLifecycleArtifact(valid);
  const emptyRecall = evaluateLifecycleArtifact({
    artifact: null,
    lifecycleKey: valid.identity.lifecycleKey,
    nonce: "",
    type: valid.type,
    jiraKey: valid.identity.jiraKey,
    taskwarriorUuid: valid.identity.taskwarriorUuid,
  });
  if (!preparation.valid) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey: null,
      receipt: { accepted: false, artifactId: null },
      recall: emptyRecall,
      error: preparation.error.code,
    });
  }

  const { nonce, artifact, recordKey } = preparation.data;
  const verification = {
    lifecycleKey: valid.identity.lifecycleKey,
    nonce,
    type: valid.type,
    jiraKey: valid.identity.jiraKey,
    taskwarriorUuid: valid.identity.taskwarriorUuid,
  };
  let stored;
  try {
    stored = await storeInstitutionalManifest({
      record: {
        recordKey,
        project: valid.identity.project,
        site: "",
        repo: "ima-pi",
        lifecycleKey: valid.identity.lifecycleKey,
        phase: valid.type,
        summary: valid.summary,
        detail: artifact,
        sourceRefs: valid.identity.sourceRefs,
      },
      createdAt: deps.now().toISOString(),
      operations: deps.corpus,
      signal,
    });
    throwIfAborted(signal);
  } catch {
    throwIfAborted(signal);
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey: null,
      receipt: { accepted: false, artifactId: null },
      recall: emptyRecall,
      error: "corpus_store_failed",
    });
  }

  const receipt = stored.success
    ? validateLifecycleStoreReceipt(stored.data)
    : { accepted: false, artifactId: null };
  if (!stored.success || !receipt.accepted || !receipt.artifactId) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey: null,
      receipt,
      recall: emptyRecall,
      error: stored.success ? "corpus_receipt_invalid" : stored.error.code,
    });
  }

  let recalled;
  try {
    recalled = await deps.corpus.getInstitutional(recordKey, signal);
    throwIfAborted(signal);
  } catch {
    throwIfAborted(signal);
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey,
      receipt,
      recall: emptyRecall,
      error: "corpus_recall_failed",
    });
  }
  if (!recalled.success) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      recordKey,
      receipt,
      recall: emptyRecall,
      error: recalled.error.code,
    });
  }

  return deriveLifecycleResult({
    type: valid.type,
    lifecycleKey: valid.identity.lifecycleKey,
    recordKey,
    receipt,
    recall: evaluateLifecycleArtifact({ artifact: recalled.data.detail, ...verification }),
  });
}

const CONTEXT_SOURCE_PARAMETERS = Type.Object({}, {
  oneOf: [
    Type.Object({ type: StringEnum(["jira"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), key: Type.String({ pattern: "^[A-Z][A-Z0-9]+-\\d+$", description: "Required for jira; extract the uppercase issue key from a Jira URL." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["taskwarrior"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), project: Type.String({ pattern: "^[\\w.-]+$", description: "Required for taskwarrior." }), uuid: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "Required for taskwarrior." }) }, { additionalProperties: false }),
    Type.Object({
      type: StringEnum(["plane"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }),
      workspace: Type.String({ maxLength: 1_024, pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]*$", description: "Required Plane workspace identifier." }),
      project: Type.String({ maxLength: 1_024, pattern: "^[A-Z][A-Z0-9_]*$", description: "Required uppercase Plane project identifier." }),
      sequenceId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Required positive Plane work-item sequence ID." }),
    }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["file"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), path: Type.String({ minLength: 1, maxLength: 1_024, description: "Required for file; project-root-contained regular file path." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["vestige"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), id: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "Required for vestige; memory UUID." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["lifecycle"] as const, { description: "Source kind. Supply a validated lifecycle key." }), key: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\r\\n]+$", description: "Required for lifecycle; a non-empty lifecycle key without line breaks." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["reference"] as const, { description: "Source kind. Raw manual-phase source identifier, normalized before external access." }), value: Type.String({ minLength: 1, maxLength: 1_024, description: "Canonical colon identifier or accepted space-delimited alias." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["text"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), title: Type.String({ minLength: 1, maxLength: 256, description: "Required for text." }), content: Type.String({ minLength: 1, maxLength: 64_000, description: "Required for text." }) }, { additionalProperties: false }),
  ],
  description: "Exactly one source: jira uses key; taskwarrior uses project and uuid; plane uses workspace, project, and sequenceId; file uses path; vestige uses id; lifecycle uses key; reference uses a canonical identifier or space alias; text uses title and content.",
});

const CONTEXT_DURABLE_KNOWLEDGE_PARAMETERS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 2_000, description: "Read-only Qdrant query." }),
  collection: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Optional legacy collection; only ima-knowledge is supported." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum durable references." })),
}, { additionalProperties: false });

const CONTEXT_TOOL_PARAMETERS = Type.Object({
  source: CONTEXT_SOURCE_PARAMETERS,
  durableKnowledge: Type.Optional(CONTEXT_DURABLE_KNOWLEDGE_PARAMETERS),
}, { additionalProperties: false });

const CONTROL_SAFE_STRING_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F]*$";
const LIFECYCLE_IDENTITY_PARAMETERS = Type.Object({
  project: Type.String({ minLength: 1, maxLength: 256, pattern: CONTROL_SAFE_STRING_PATTERN }),
  lifecycleKey: Type.String({ minLength: 1, maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
  lifecycleRootMemoryId: Type.String({ maxLength: 512, pattern: CONTROL_SAFE_STRING_PATTERN }),
  taskwarriorProject: Type.String({ maxLength: 256, pattern: CONTROL_SAFE_STRING_PATTERN }),
  taskwarriorTask: Type.String({ maxLength: 256, pattern: CONTROL_SAFE_STRING_PATTERN }),
  taskwarriorUuid: Type.String({ maxLength: 128, pattern: CONTROL_SAFE_STRING_PATTERN }),
  jiraKey: Type.String({ maxLength: 128, pattern: CONTROL_SAFE_STRING_PATTERN }),
  planeWorkspace: Type.Optional(Type.String({ maxLength: 128, pattern: CONTROL_SAFE_STRING_PATTERN, description: "Optional Plane workspace; supply only with planeWorkItem." })),
  planeWorkItem: Type.Optional(Type.String({ maxLength: 128, pattern: CONTROL_SAFE_STRING_PATTERN, description: "Optional Plane work item; supply only with planeWorkspace." })),
  sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 1_024, pattern: CONTROL_SAFE_STRING_PATTERN }), { maxItems: 64 }),
  priorArtifactIds: Type.Array(Type.String({ minLength: 1, maxLength: 1_024, pattern: CONTROL_SAFE_STRING_PATTERN }), { maxItems: 64 }),
}, { additionalProperties: false });

const LIFECYCLE_TOOL_PARAMETERS = Type.Object({
  type: Type.String(),
  identity: LIFECYCLE_IDENTITY_PARAMETERS,
  summary: Type.String({ minLength: 1, maxLength: 2_000, pattern: CONTROL_SAFE_STRING_PATTERN, description: "Required approved one-line phase outcome; validated to 2,000 UTF-8 bytes without control characters." }),
  artifact: Type.String({ minLength: 1, maxLength: 128_000 }),
}, { additionalProperties: false });

export default function integrations(pi: ExtensionAPI) {
  pi.registerTool({ name: "ima_context", label: "IMA context", description: "Build Serena-first project context from one typed source: jira/key, taskwarrior/project+uuid, plane/workspace+project+sequenceId, file/path, vestige/id, lifecycle/key, reference/value, or text/title+content. Reference accepts canonical taskwarrior:<project>:<uuid>, plane:<workspace>:PROJ-123, jira:<KEY>, lifecycle:<lifecycle-key>, and vestige:<UUID> forms plus space aliases. Optional durableKnowledge requires query and accepts the supported ima-knowledge collection and limit.", parameters: CONTEXT_TOOL_PARAMETERS, prepareArguments: prepareContextArguments, execute: async (_id, request, signal, _update, ctx) => ({ content: [{ type: "text", text: JSON.stringify(await coordinateContext(request, ctx.cwd, undefined, signal)) }], details: {} }) });
  pi.registerTool({ name: "ima_lifecycle", label: "IMA lifecycle", description: "Store and directly verify one lifecycle artifact in the Tier-1 Qdrant corpus. An explicit summary and closed bounded lifecycle identity are required for manifest-only semantic recall.", parameters: LIFECYCLE_TOOL_PARAMETERS, execute: async (_id, request, signal) => { const result = await coordinateLifecycle(request, undefined, signal); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } });
}
