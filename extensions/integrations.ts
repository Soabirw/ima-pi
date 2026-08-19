/** FNR-3016 production boundary for external IMA context and lifecycle services. */
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  normalizeSourcePayload,
  parseQdrantResults,
  prepareContextArguments,
  sanitizeContextError,
  sanitizeContextText,
  STANDARD_MEMORIES,
  validateContextRequest,
} from "../lib/ima-context.ts";
import { buildLifecycleArtifact, deriveLifecycleResult, evaluateLifecycleRecall, sanitizeLifecycleError, validateLifecycleRequest, validateVestigeSaveReceipt } from "../lib/ima-lifecycle.ts";
import { callMcpTool, withMcpSession } from "../lib/ima-mcp-client.ts";

const execFile = promisify(execFileCallback);
const TIMEOUT = 30_000;
const MCP_TIMEOUT = 300_000;
const VESTIGE_TIMEOUT = 300_000;
const MAX_BUFFER = 128 * 1024;
const SOURCE_ERROR_CODES = ["source_path_outside_project", "source_file_unreadable", "source_file_too_large"];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceErrorCode = (error: unknown) => error instanceof Error && SOURCE_ERROR_CODES.includes(error.message) ? error.message : "source_boundary_unavailable";
const inside = (root: string, target: string) => { const path = relative(root, target); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
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

type McpToolCaller = (
  name: string,
  arguments_: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;

type McpSession = <Result>(
  serverName: string,
  callback: (call: McpToolCaller) => Promise<Result>,
  signal?: AbortSignal,
) => Promise<Result | null>;

export type IntegrationDependencies = {
  run?: (program: string, args: string[]) => Promise<unknown>;
  read?: (path: string) => Promise<string>;
  canonical?: (path: string) => Promise<string>;
  stat?: typeof lstat;
  vestige?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  session?: McpSession;
  home?: () => string;
};

const productionDependencies: Required<IntegrationDependencies> = {
  run: async (program, args) => {
    try {
      const { stdout } = await execFile(program, args, { timeout: TIMEOUT, maxBuffer: MAX_BUFFER });
      return envelope(stdout);
    } catch {
      return null;
    }
  },
  read: (path) => readFile(path, "utf8"),
  canonical: realpath,
  stat: lstat,
  vestige: async (tool, args) => {
    const server = await mcpServer("vestige");
    if (!server) return null;

    try {
      return await callMcpTool({
        command: server.command,
        args: server.args,
        name: tool,
        arguments: args,
        timeoutMs: VESTIGE_TIMEOUT,
      });
    } catch {
      return null;
    }
  },
  session: async (serverName, callback, signal) => {
    const server = await mcpServer(serverName);
    return server ? withMcpSession(server, callback, signal) : null;
  },
  home: homedir,
};

const depsFor = (given?: IntegrationDependencies) => ({ ...productionDependencies, ...given });
const directResponse = (value: unknown) => {
  const response = object(value);
  return response?.isError === true ? null : response;
};
const directStructured = (value: unknown) => object(directResponse(value)?.structuredContent);
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
  const arguments_ = {
    query: request.query,
    ...(request.collection ? { collection_name: request.collection } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  };

  throwIfAborted(signal);
  try {
    const response = await deps.session("qdrant-memory", (call) => call(
      "qdrant_find",
      arguments_,
      MCP_TIMEOUT,
    ), signal);
    throwIfAborted(signal);
    if (!directResponse(response)) return { requested: true, status: "failed" as const, references: [] };

    const formattedResults = directResult(response);
    if (formattedResults === null) return { requested: true, status: "empty" as const, references: [] };

    const references = parseQdrantResults(formattedResults)
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

async function sourcePayload(
  source: any,
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
    const result = await deps.run("node", [helper, "jira:get", source.key]);
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
    const result = await deps.run("task", ["rc.verbose=nothing", `project:${source.project}`, source.uuid, "export"]);
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

export async function coordinateLifecycle(request: unknown, supplied?: IntegrationDependencies) {
  const valid = validateLifecycleRequest(request);
  if (!valid.valid) return { status: "failed", error: valid.error };

  const deps = depsFor(supplied);
  const nonce = randomUUID();
  const recallInput = {
    lifecycleKey: valid.identity.lifecycleKey,
    nonce,
    type: valid.type,
    jiraKey: valid.identity.jiraKey,
    taskwarriorUuid: valid.identity.taskwarriorUuid,
  };
  const emptyRecall = evaluateLifecycleRecall({ envelope: null, ...recallInput });
  const artifact = buildLifecycleArtifact({ ...valid, nonce });

  let saved: unknown;
  try {
    saved = await deps.vestige("smart_ingest", {
      content: artifact,
      node_type: "decision",
      forceCreate: true,
      source: valid.identity.lifecycleKey,
      tags: [valid.identity.project, "lifecycle", valid.type],
    });
  } catch {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      receipt: { accepted: false, artifactId: null },
      recall: emptyRecall,
      error: "vestige_save_failed",
    });
  }

  const receipt = validateVestigeSaveReceipt(saved, valid.type);
  if (saved == null) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      receipt,
      recall: emptyRecall,
      error: "vestige_save_failed",
    });
  }
  if (!receipt.accepted) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      receipt,
      recall: emptyRecall,
      error: "vestige_receipt_invalid",
    });
  }

  let recalled: unknown;
  try {
    recalled = await deps.vestige("recall", {
      query: `${valid.identity.lifecycleKey} ${nonce}`,
      mode: "lookup",
      limit: 10,
    });
  } catch {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      receipt,
      recall: emptyRecall,
      error: "vestige_recall_failed",
    });
  }
  if (recalled == null || object(recalled)?.isError === true) {
    return deriveLifecycleResult({
      type: valid.type,
      lifecycleKey: valid.identity.lifecycleKey,
      receipt,
      recall: emptyRecall,
      error: "vestige_recall_failed",
    });
  }

  return deriveLifecycleResult({
    type: valid.type,
    lifecycleKey: valid.identity.lifecycleKey,
    receipt,
    recall: evaluateLifecycleRecall({ envelope: recalled, ...recallInput }),
  });
}

const CONTEXT_SOURCE_PARAMETERS = Type.Object({}, {
  oneOf: [
    Type.Object({ type: StringEnum(["jira"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), key: Type.String({ pattern: "^[A-Z][A-Z0-9]+-\\d+$", description: "Required for jira; extract the uppercase issue key from a Jira URL." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["taskwarrior"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), project: Type.String({ pattern: "^[\\w.-]+$", description: "Required for taskwarrior." }), uuid: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}$", description: "Required for taskwarrior." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["file"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), path: Type.String({ minLength: 1, maxLength: 1_024, description: "Required for file; project-root-contained regular file path." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["vestige"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), id: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "Required for vestige; memory UUID." }) }, { additionalProperties: false }),
    Type.Object({ type: StringEnum(["text"] as const, { description: "Source kind. Supply only the fields required for the selected kind." }), title: Type.String({ minLength: 1, maxLength: 256, description: "Required for text." }), content: Type.String({ minLength: 1, maxLength: 64_000, description: "Required for text." }) }, { additionalProperties: false }),
  ],
  description: "Exactly one source: jira uses key; taskwarrior uses project and uuid; file uses path; vestige uses id; text uses title and content.",
});

const CONTEXT_DURABLE_KNOWLEDGE_PARAMETERS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 2_000, description: "Read-only Qdrant query." }),
  collection: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Optional Qdrant collection." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum durable references." })),
}, { additionalProperties: false });

const CONTEXT_TOOL_PARAMETERS = Type.Object({
  source: CONTEXT_SOURCE_PARAMETERS,
  durableKnowledge: Type.Optional(CONTEXT_DURABLE_KNOWLEDGE_PARAMETERS),
}, { additionalProperties: false });

export default function integrations(pi: ExtensionAPI) {
  pi.registerTool({ name: "ima_context", label: "IMA context", description: "Build Serena-first project context from one typed source: jira/key, taskwarrior/project+uuid, file/path, vestige/id, or text/title+content. Optional durableKnowledge requires query and accepts collection and limit.", parameters: CONTEXT_TOOL_PARAMETERS, prepareArguments: prepareContextArguments, execute: async (_id, request, signal, _update, ctx) => ({ content: [{ type: "text", text: JSON.stringify(await coordinateContext(request, ctx.cwd, undefined, signal)) }], details: {} }) });
  pi.registerTool({ name: "ima_lifecycle", label: "IMA lifecycle", description: "Save and semantically verify a lifecycle artifact.", parameters: Type.Object({ type: Type.String(), identity: Type.Any(), artifact: Type.String() }), execute: async (_id, request) => { const result = await coordinateLifecycle(request); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } });
}
