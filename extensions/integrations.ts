/** FNR-3016 production boundary for external IMA context and lifecycle services. */
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { derivePhaseContext, evaluateSerenaBootstrap, normalizeSourcePayload, prepareContextArguments, sanitizeContextError, sanitizeContextText, validateContextRequest } from "../lib/ima-context.ts";
import { artifactIsComplete, buildLifecycleArtifact, deriveLifecycleResult, evaluateLifecycleRecall, sanitizeLifecycleError, validateLifecycleRequest, validateVestigeSaveReceipt } from "../lib/ima-lifecycle.ts";

const execFile = promisify(execFileCallback);
const TIMEOUT = 30_000;
const MAX_BUFFER = 128 * 1024;
const SOURCE_ERROR_CODES = ["source_path_outside_project", "source_file_unreadable", "source_file_too_large"];
const sourceErrorCode = (error: unknown) => error instanceof Error && SOURCE_ERROR_CODES.includes(error.message) ? error.message : "source_boundary_unavailable";
const inside = (root: string, target: string) => { const path = relative(root, target); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const envelope = (value: string) => { try { return JSON.parse(value); } catch { return null; } };

export type IntegrationDependencies = {
  run?: (program: string, args: string[]) => Promise<unknown>;
  read?: (path: string) => Promise<string>;
  canonical?: (path: string) => Promise<string>;
  stat?: typeof lstat;
  temp?: () => Promise<string>;
  write?: (path: string, value: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  home?: () => string;
};
const productionDependencies: Required<IntegrationDependencies> = {
  run: async (program, args) => { try { const { stdout } = await execFile(program, args, { timeout: TIMEOUT, maxBuffer: MAX_BUFFER }); return envelope(stdout); } catch { return null; } },
  read: (path) => readFile(path, "utf8"), canonical: realpath, stat: lstat, temp: () => mkdtemp(join(tmpdir(), "ima-pi-lifecycle-")), write: writeFile, remove: (path) => rm(path, { force: true }), home: homedir,
};
const depsFor = (given?: IntegrationDependencies) => ({ ...productionDependencies, ...given });
const passed = (value: unknown, command: string) => { const e = object(value); return Boolean(e?.ok === true && e?.command === command && !e?.error); };
const memoryContent = (value: unknown) => { const e = object(value); return text(object(e?.data)?.content ?? object(object(e?.data)?.memory)?.content); };

async function serena(root: string, deps: Required<IntegrationDependencies>) {
  const activate = await deps.run("ima-mcp", ["serena", "project", "activate", "--json"]);
  if (!passed(activate, "serena.project.activate")) return { bootstrap: evaluateSerenaBootstrap({ activated: false, instructionsLoaded: false, memoryListLoaded: false }), blocking: "serena_activation_failed" };
  const instructions = await deps.run("ima-mcp", ["serena", "instructions", "--json"]);
  if (!passed(instructions, "serena.instructions")) return { bootstrap: evaluateSerenaBootstrap({ activated: true, instructionsLoaded: false, memoryListLoaded: false }), blocking: "serena_instructions_failed" };
  const listing = await deps.run("ima-mcp", ["serena", "memory", "list", "--json"]);
  const names = object(listing && object(listing)?.data)?.memories;
  if (!passed(listing, "serena.memory.list") || !Array.isArray(names)) return { bootstrap: evaluateSerenaBootstrap({ activated: true, instructionsLoaded: true, memoryListLoaded: false }), blocking: "serena_memory_list_failed" };
  const loaded = await Promise.all(["core", "conventions", "tech_stack", "suggested_commands", "task_completion"].map(async (name) => [name, names.includes(name) ? memoryContent(await deps.run("ima-mcp", ["serena", "memory", "read", name, "--json"])) || "failed" : null] as const));
  return { bootstrap: evaluateSerenaBootstrap({ activated: true, instructionsLoaded: true, memoryListLoaded: true, memories: Object.fromEntries(loaded) }), blocking: null };
}

async function sourcePayload(source: any, root: string, deps: Required<IntegrationDependencies>): Promise<unknown> {
  if (source.type === "text") return { key: source.title, title: source.title, content: source.content, references: [] };
  if (source.type === "jira") {
    const helper = join(deps.home(), ".agents", "skills", "mcp-atlassian", "scripts", "atlassian-api.mjs");
    const result = await deps.run("node", [helper, "jira:get", source.key]); const data = object(result);
    return data ? { key: source.key, title: text(data.summary) || source.key, content: text(data.descriptionText) || text(data.summary), references: ["https://flccc.atlassian.net/browse/" + source.key] } : null;
  }
  if (source.type === "taskwarrior") {
    const result = await deps.run("task", ["rc.verbose=nothing", `project:${source.project}`, source.uuid, "export"]);
    const resultObject = object(result);
    const tasks = Array.isArray(result) ? result : (Array.isArray(resultObject?.data) ? resultObject.data : []);
    const matches = tasks.filter((item) => object(item)?.uuid === source.uuid && object(item)?.project === source.project);
    const value = object(matches.length === 1 ? matches[0] : null);
    return value ? { key: source.uuid, title: text(value.description), content: JSON.stringify({ description: value.description, status: value.status, tags: value.tags, depends: value.depends, annotations: value.annotations }), references: [`Taskwarrior:${source.project}:${source.uuid}`] } : null;
  }
  if (source.type === "vestige") { const value = object(await deps.run("ima-mcp", ["vestige", "get", source.id, "--timeout-ms", "300000", "--json"])); const content = memoryContent(value); return passed(value, "vestige.get") && content ? { key: source.id, title: `Vestige ${source.id}`, content, references: [`Vestige:${source.id}`] } : null; }
  const lexical = resolve(root, source.path); if (!inside(root, lexical)) throw new Error("source_path_outside_project"); const actual = await deps.canonical(lexical); if (!inside(root, actual)) throw new Error("source_path_outside_project"); const info = await deps.stat(actual); if (!info.isFile()) throw new Error("source_file_unreadable"); if (info.size > 256 * 1024) throw new Error("source_file_too_large"); const content = await deps.read(actual); if (content.includes("\0")) throw new Error("source_file_unreadable"); return { key: source.path, title: source.path, content, references: [`File:${source.path}`] };
}

export async function coordinateContext(request: unknown, cwd: string, supplied?: IntegrationDependencies) {
  const valid = validateContextRequest(request); if (!valid.valid) return { status: "failed", error: valid.error };
  const deps = depsFor(supplied); const root = await deps.canonical(cwd); const setup = await serena(root, deps);
  if (setup.blocking) return derivePhaseContext({ cwd: root, serenaProjectPath: root, source: null, serena: setup.bootstrap, diagnostics: [{ code: setup.blocking, stage: "serena", message: "Serena bootstrap did not complete." }] });
  try {
    const payload = await sourcePayload(valid.source, root, deps); const source = normalizeSourcePayload({ source: valid.source, payload });
    const durableKnowledge = valid.durableKnowledge ? await (async () => { const args = ["qdrant", "find", valid.durableKnowledge!.query, ...(valid.durableKnowledge!.collection ? ["--collection", valid.durableKnowledge!.collection] : []), "--json"]; const result = object(await deps.run("ima-mcp", args)); const results = object(result?.data)?.results; return !passed(result, "qdrant.find") ? { requested: true, status: "failed" as const, references: [] } : !Array.isArray(results) || results.length === 0 ? { requested: true, status: "empty" as const, references: [] } : { requested: true, status: "loaded" as const, references: results.slice(0, valid.durableKnowledge!.limit ?? 20).map((entry: any) => ({ summary: sanitizeContextText(text(entry.summary ?? entry.content), 512), score: typeof entry.score === "number" ? entry.score : null })) }; })() : undefined;
    return derivePhaseContext({ cwd: root, serenaProjectPath: root, source, serena: setup.bootstrap, durableKnowledge, diagnostics: source ? [] : [{ code: "source_boundary_unavailable", stage: "source", message: "Source hydration did not return usable content." }] });
  } catch (error) { return derivePhaseContext({ cwd: root, serenaProjectPath: root, source: null, serena: setup.bootstrap, diagnostics: [{ code: sourceErrorCode(error), stage: "source", message: "Source hydration failed." }] }); }
}

export async function coordinateLifecycle(request: unknown, supplied?: IntegrationDependencies) {
  const valid = validateLifecycleRequest(request); if (!valid.valid) return { status: "failed", error: valid.error };
  if (!artifactIsComplete(valid.artifact)) return { status: "failed", error: sanitizeLifecycleError("artifact_incomplete", "") };
  const deps = depsFor(supplied); let path = "";
  let result: ReturnType<typeof deriveLifecycleResult> | { status: "failed"; error: ReturnType<typeof sanitizeLifecycleError> };
  try {
    const nonce = randomUUID(); const directory = await deps.temp(); path = join(directory, `${randomUUID()}.md`);
    await deps.write(path, buildLifecycleArtifact({ ...valid, nonce }));
    const saved = await deps.run("ima-mcp", ["vestige", "save", "--type", valid.type, "--file", path, "--timeout-ms", "300000", "--json"]);
    const receipt = validateVestigeSaveReceipt(saved, valid.type);
    if (!receipt.accepted) {
      result = deriveLifecycleResult({ type: valid.type, lifecycleKey: valid.identity.lifecycleKey, receipt, recall: { matched: false, lifecycleKeyMatched: false, nonceMatched: false, phaseMatched: false, sourceIdentityMatched: false, outcomeMatched: false, physicalShapeIgnored: true }, error: "vestige_receipt_invalid" });
    } else {
      const recalled = await deps.run("ima-mcp", ["vestige", "search", `${valid.identity.lifecycleKey} ${nonce}`, "--timeout-ms", "300000", "--json"]);
      result = deriveLifecycleResult({ type: valid.type, lifecycleKey: valid.identity.lifecycleKey, receipt, recall: evaluateLifecycleRecall({ envelope: recalled, lifecycleKey: valid.identity.lifecycleKey, nonce, type: valid.type, jiraKey: valid.identity.jiraKey, taskwarriorUuid: valid.identity.taskwarriorUuid }), error: passed(recalled, "vestige.search") ? undefined : "vestige_recall_failed" });
    }
  } catch {
    result = { status: "failed", error: sanitizeLifecycleError("temporary_artifact_failed", "") };
  }
  if (!path) return result;
  try {
    await deps.remove(path);
    return result;
  } catch {
    const provisional = result as ReturnType<typeof deriveLifecycleResult>;
    return {
      ...provisional,
      status: "failed" as const,
      error: sanitizeLifecycleError("temporary_cleanup_failed", ""),
    };
  }
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
  pi.registerTool({ name: "ima_context", label: "IMA context", description: "Build Serena-first project context from one typed source: jira/key, taskwarrior/project+uuid, file/path, vestige/id, or text/title+content. Optional durableKnowledge requires query and accepts collection and limit.", parameters: CONTEXT_TOOL_PARAMETERS, prepareArguments: prepareContextArguments, execute: async (_id, request, _signal, _update, ctx) => ({ content: [{ type: "text", text: JSON.stringify(await coordinateContext(request, ctx.cwd)) }], details: {} }) });
  pi.registerTool({ name: "ima_lifecycle", label: "IMA lifecycle", description: "Save and semantically verify a lifecycle artifact.", parameters: Type.Object({ type: Type.String(), identity: Type.Any(), artifact: Type.String() }), execute: async (_id, request) => ({ content: [{ type: "text", text: JSON.stringify(await coordinateLifecycle(request)) }], details: {} }) });
}
