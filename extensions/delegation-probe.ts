/**
 * FNR-3009 technical spike: prove Pi child delegation primitives.
 *
 * Proves, using the Pi SDK directly (no nested `pi` subprocess), that a parent
 * can create a bounded child agent on an independently selected provider/model,
 * grant it explicit tool authority without per-command permission prompts, and
 * reopen the persisted child session for a context-dependent follow-up.
 *
 * This module keeps deterministic logic in pure, exported helpers and confines
 * all model/session/filesystem/network side effects to the shell functions and
 * the command handler. The pure helpers are the unit-tested surface; runtime
 * SDK behavior is proven by the live acceptance procedure in
 * `docs/spikes/FNR-3009.md`. The exported result shape is spike evidence only,
 * not a production contract.
 */

import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  McpPolicyOperation,
  createMcpChildRuntime as CreateMcpChildRuntime,
} from "./mcp.ts";

type McpChildRuntime = Awaited<ReturnType<typeof CreateMcpChildRuntime>>;

/** Fixed, harmless resources used by the bounded child. No user input is executed. */
export const SEED_FILE = "seed.txt";
export const MARKER_FILE = "marker.txt";
export const RESEARCH_URL = "https://github.com/earendil-works/pi";
export const LOCAL_SHELL_COMMAND = "pwd";
export const SERENA_ACTIVATE_TOOL = "serena_activate_project";
/** Marker embedded in the start brief so the follow-up can recover the expected nonce. */
export const NONCE_MARKER = "DELEGATION_PROBE_NONCE";

export const RESULT_ENV_VAR = "IMA_PI_DELEGATION_RESULT";
export const SCHEMA_VERSION = 1;
export const STORY = "FNR-3009";

const CHILD_TOOLS = ["read", "write", "bash", "mcp"] as const;
const FOLLOW_UP_TOOLS: string[] = [];

/* ------------------------------------------------------------------ *
 * Pure helpers (no side effects)
 * ------------------------------------------------------------------ */

export type ModelSelector =
  | { valid: true; provider: string; model: string }
  | { valid: false; error: string };

/**
 * Split a `<provider>/<model>` selector at the first `/`, preserving any
 * remaining slashes in the model id (e.g. `openrouter/openai/gpt-5.4`).
 */
export function parseModelSelector(selector: unknown): ModelSelector {
  if (typeof selector !== "string") {
    return { valid: false, error: "selector must be a string" };
  }
  const trimmed = selector.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return { valid: false, error: "selector must be <provider>/<model>" };
  }
  const provider = trimmed.slice(0, separator).trim();
  const model = trimmed.slice(separator + 1).trim();
  if (provider === "" || model === "") {
    return { valid: false, error: "selector must be <provider>/<model>" };
  }
  return { valid: true, provider, model };
}

export type DelegationProbeArgs =
  | { mode: "start"; provider: string; model: string }
  | { mode: "follow-up"; provider: string; model: string; sessionFile: string }
  | { error: "invalid_arguments"; message: string };

const USAGE =
  "usage: /ima:delegate-probe start <provider>/<model> | " +
  "follow-up <provider>/<model> <absolute-session-file>";

/** Parse and validate the fixed command grammar. Never throws for user input. */
export function parseDelegationProbeArgs(args: unknown): DelegationProbeArgs {
  const raw = typeof args === "string" ? args.trim() : "";
  const tokens = raw === "" ? [] : raw.split(/\s+/);
  const [mode, selector, sessionFile, ...extra] = tokens;

  if (mode !== "start" && mode !== "follow-up") {
    return { error: "invalid_arguments", message: USAGE };
  }
  const parsedSelector = parseModelSelector(selector);
  if (!parsedSelector.valid) {
    return { error: "invalid_arguments", message: USAGE };
  }

  if (mode === "start") {
    if (sessionFile !== undefined || extra.length > 0) {
      return { error: "invalid_arguments", message: USAGE };
    }
    return { mode, provider: parsedSelector.provider, model: parsedSelector.model };
  }

  if (sessionFile === undefined || extra.length > 0) {
    return { error: "invalid_arguments", message: USAGE };
  }
  if (!sessionFile.startsWith("/")) {
    return { error: "invalid_arguments", message: "session file must be an absolute path" };
  }
  return {
    mode,
    provider: parsedSelector.provider,
    model: parsedSelector.model,
    sessionFile,
  };
}

export interface ModelLike {
  provider: string;
  id: string;
}

export interface ModelIdentity {
  provider: string;
  model: string;
}

/** Normalize an actual Pi `Model` to a sanitized identity. Runtime evidence must use this. */
export function modelIdentity(model: ModelLike | null | undefined): ModelIdentity | null {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
    return null;
  }
  return { provider: model.provider, model: model.id };
}

export interface StartBriefInput {
  workspace: string;
  repoPath: string;
  nonce: string;
  seedFile?: string;
  markerFile?: string;
}

/** Build the self-contained bounded child brief for the start probe. */
export function buildStartBrief(input: StartBriefInput): string {
  const seedFile = input.seedFile ?? SEED_FILE;
  const markerFile = input.markerFile ?? MARKER_FILE;
  const seedPath = join(input.workspace, seedFile);
  const markerPath = join(input.workspace, markerFile);
  return [
    "You are a bounded delegation-probe child agent for IMA Pi story FNR-3009.",
    `Your continuity nonce is ${NONCE_MARKER}=${input.nonce}. Remember it exactly.`,
    "",
    "Complete these steps in order, using the named tools, then stop:",
    `1. Use the read tool on: ${seedPath}`,
    `2. Use the write tool to create ${markerPath} whose entire contents are exactly the nonce value ${input.nonce} with no extra text.`,
    `3. Use the bash tool to run exactly: ${LOCAL_SHELL_COMMAND}`,
    `4. Use the bash tool to fetch one fixed documentation URL over HTTPS with a timeout: curl -fsSL --max-time 20 ${RESEARCH_URL}`,
    `5. Use the mcp tool exactly once with server "serena", tool "${SERENA_ACTIVATE_TOOL}", and args {"project":"${input.repoPath}"}.`,
    "6. Reply with one short sentence confirming the steps you completed.",
    "",
    "Boundaries you must respect:",
    `- Do not modify any file outside ${input.workspace}.`,
    "- Do not modify the IMA Pi repository or any git-tracked file.",
    "- Do not run destructive commands (no rm, mv, chmod, git write, package installs).",
    "- Do not invent extra commands, URLs, or write targets beyond those listed above.",
    "- If any step cannot be completed, stop and report which step failed rather than substituting another action.",
  ].join("\n");
}

/** Build the follow-up brief. The child must answer from retained context, using no tools. */
export function buildFollowUpBrief(_nonce: string): string {
  return [
    "This is a follow-up to your earlier delegation-probe session.",
    "Do NOT use any tools. Answer only from your retained conversation memory.",
    `Return your continuity nonce in the form ${NONCE_MARKER}=<value>,`,
    "and briefly name the categories of authority work you completed earlier",
    "(file read, file write, shell, research, integration).",
  ].join("\n");
}

/** Recover the nonce embedded by buildStartBrief from retained session text. */
export function extractNonceFromText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const match = text.match(new RegExp(`${NONCE_MARKER}=([0-9a-fA-F-]{8,})`));
  return match ? match[1] : null;
}

export type ToolCategory =
  | "file-read"
  | "file-write"
  | "shell"
  | "research"
  | "integration"
  | "other";

export interface ObservedTool {
  tool: string;
  category: ToolCategory;
}

interface ToolEventLike {
  toolName?: string;
  args?: { command?: unknown; path?: unknown; [key: string]: unknown };
  input?: { command?: unknown; path?: unknown; [key: string]: unknown };
}

interface ToolEventContext {
  seedPath: string;
  markerPath: string;
  repoPath: string;
}

/**
 * Map an observed tool execution to a sanitized category. A category is granted
 * only for the exact controlled path or command; raw arguments, output, and
 * environment are never retained.
 */
export function classifyToolEvent(
  event: ToolEventLike,
  context: ToolEventContext,
): ObservedTool {
  const tool = typeof event?.toolName === "string" ? event.toolName : "unknown";
  const args = event?.args ?? event?.input ?? {};
  const path = typeof args.path === "string" ? args.path : "";
  if (tool === "read") {
    return { tool, category: path === context.seedPath ? "file-read" : "other" };
  }
  if (tool === "write") {
    return { tool, category: path === context.markerPath ? "file-write" : "other" };
  }
  if (tool === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const researchCommand = `curl -fsSL --max-time 20 ${RESEARCH_URL}`;
    if (command === researchCommand) return { tool, category: "research" };
    if (command === LOCAL_SHELL_COMMAND) return { tool, category: "shell" };
    return { tool, category: "other" };
  }
  if (tool === "mcp") {
    const server = typeof args.server === "string" ? args.server : "";
    const mcpTool = typeof args.tool === "string" ? args.tool : "";
    const project = args.args && typeof args.args === "object"
      ? (args.args as { project?: unknown }).project
      : undefined;
    const exactProject = args.args && typeof args.args === "object"
      && Object.keys(args.args).length === 1
      && project === context.repoPath;
    return server === "serena" && mcpTool === SERENA_ACTIVATE_TOOL && exactProject
      ? { tool, category: "integration" }
      : { tool, category: "other" };
  }
  return { tool, category: "other" };
}

export interface AuthorityEvidenceInput {
  observedTools: ObservedTool[];
  markerVerified: boolean;
  completedWithoutError: boolean;
}

export interface AuthorityEvidence {
  authority: {
    fileRead: boolean;
    fileWrite: boolean;
    shell: boolean;
    research: boolean;
    integration: boolean;
    markerVerified: boolean;
  };
  passed: boolean;
}

/** Start passes only when every required authority signal is present. Prose is never proof. */
export function evaluateAuthorityEvidence(input: AuthorityEvidenceInput): AuthorityEvidence {
  const has = (category: ToolCategory) =>
    input.observedTools.some((entry) => entry.category === category);
  const authority = {
    fileRead: has("file-read"),
    fileWrite: has("file-write"),
    shell: has("shell"),
    research: has("research"),
    integration: has("integration"),
    markerVerified: input.markerVerified === true,
  };
  const noUnexpectedTools = input.observedTools.every(
    (entry) => entry.category !== "other",
  );
  const passed =
    authority.fileRead &&
    authority.fileWrite &&
    authority.shell &&
    authority.research &&
    authority.integration &&
    authority.markerVerified &&
    noUnexpectedTools &&
    input.completedWithoutError === true;
  return { authority, passed };
}

export interface ContinuityInput {
  persistedSessionId: string;
  reopenedSessionId: string;
  requestedSessionFile: string;
  reopenedSessionFile: string;
  requested: ModelIdentity;
  actual: ModelIdentity | null;
  assistantText: string;
  nonce: string;
  followUpToolCount: number;
  completedWithoutError: boolean;
}

export interface ContinuityEvidence {
  continuity: {
    sameSessionId: boolean;
    sameSessionFile: boolean;
    sameChildModel: boolean;
    nonceRecalled: boolean;
    noToolsRerun: boolean;
  };
  passed: boolean;
}

/** Follow-up passes only with matching identity, recalled nonce, and zero tool reruns. */
export function evaluateContinuity(input: ContinuityInput): ContinuityEvidence {
  const continuity = {
    sameSessionId:
      input.persistedSessionId !== "" &&
      input.persistedSessionId === input.reopenedSessionId,
    sameSessionFile:
      input.requestedSessionFile !== "" &&
      input.requestedSessionFile === input.reopenedSessionFile,
    sameChildModel:
      input.actual !== null &&
      input.actual.provider === input.requested.provider &&
      input.actual.model === input.requested.model,
    nonceRecalled:
      input.nonce !== "" && input.assistantText.includes(input.nonce),
    noToolsRerun: input.followUpToolCount === 0,
  };
  const passed =
    continuity.sameSessionId &&
    continuity.sameSessionFile &&
    continuity.sameChildModel &&
    continuity.nonceRecalled &&
    continuity.noToolsRerun &&
    input.completedWithoutError === true;
  return { continuity, passed };
}

export interface ProbeError {
  code: string;
  message: string;
}

export interface DelegationProbeResult {
  schemaVersion: number;
  story: string;
  mode: "start" | "follow-up";
  status: "passed" | "failed";
  requestedChild: ModelIdentity;
  parent: ModelIdentity | null;
  child:
    | (ModelIdentity & { sessionId: string; sessionFile: string })
    | null;
  independentRouting: { providerDiffers: boolean; modelDiffers: boolean };
  workspace: string | null;
  authority: AuthorityEvidence["authority"] | null;
  continuity: ContinuityEvidence["continuity"] | null;
  observedTools: ObservedTool[];
  error: ProbeError | null;
}

/** Sanitize an error into a stable code + concise message (no secrets, env, or payloads). */
export function sanitizeError(code: string, message: unknown): ProbeError {
  const text = message instanceof Error ? message.message : String(message ?? "");
  const oneLine = text
    .split("\n")[0]
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-[redacted]")
    // Redact bearer credentials before the assignment rule so an
    // `Authorization: Bearer <credential>` shape cannot leave the value behind.
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 200);
  return { code, message: oneLine };
}

export function withResultWriteFailure(
  result: DelegationProbeResult,
  error: unknown,
): DelegationProbeResult {
  return {
    ...result,
    status: "failed",
    error: sanitizeError("result_write_failed", error),
  };
}

interface AssistantMessageLike {
  role?: string;
  stopReason?: string;
}

/** Pi records provider failures as assistant messages even when prompt() resolves. */
export function assistantExecutionFailed(
  messages: readonly AssistantMessageLike[],
): boolean {
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  return lastAssistant?.stopReason === "error";
}

export function childIdentityVerified(
  requested: ModelIdentity,
  actual: ModelIdentity | null,
  sessionId: string,
  sessionFile: string,
): boolean {
  return (
    actual !== null &&
    actual.provider === requested.provider &&
    actual.model === requested.model &&
    sessionId !== "" &&
    sessionFile.startsWith("/")
  );
}

/** Independent-routing comparison between parent and requested/actual child identity. */
export function independentRouting(
  parent: ModelIdentity | null,
  child: ModelIdentity,
): { providerDiffers: boolean; modelDiffers: boolean } {
  if (!parent) return { providerDiffers: false, modelDiffers: false };
  return {
    providerDiffers: parent.provider !== child.provider,
    modelDiffers: parent.model !== child.model,
  };
}

/* ------------------------------------------------------------------ *
 * Impure shell (model runtime, sessions, filesystem, network via child)
 * ------------------------------------------------------------------ */

interface StartInput {
  provider: string;
  model: string;
  parent: ModelIdentity | null;
  repoPath: string;
}

async function runStartProbe(input: StartInput): Promise<DelegationProbeResult> {
  const requestedChild: ModelIdentity = { provider: input.provider, model: input.model };
  const observedTools: ObservedTool[] = [];
  const base: DelegationProbeResult = {
    schemaVersion: SCHEMA_VERSION,
    story: STORY,
    mode: "start",
    status: "failed",
    requestedChild,
    parent: input.parent,
    child: null,
    independentRouting: independentRouting(input.parent, requestedChild),
    workspace: null,
    authority: null,
    continuity: null,
    observedTools,
    error: null,
  };

  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(input.provider, input.model);
  if (!model) {
    return { ...base, error: sanitizeError("child_model_not_found", `${input.provider}/${input.model}`) };
  }
  if (!modelRuntime.hasConfiguredAuth(input.provider)) {
    return { ...base, error: sanitizeError("child_model_unauthenticated", input.provider) };
  }

  let workspace: string;
  let sessionDir: string;
  let markerPath: string;
  const nonce = randomUUID();

  try {
    workspace = await mkdtemp(join(tmpdir(), "ima-pi-delegation-"));
    base.workspace = workspace;
    sessionDir = join(workspace, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(workspace, SEED_FILE),
      "delegation-probe seed file. The child must read this file to prove file-read authority.\n",
    );
    markerPath = join(workspace, MARKER_FILE);
  } catch (error) {
    return { ...base, error: sanitizeError("workspace_setup_failed", error) };
  }

  let childRuntime: McpChildRuntime;
  try {
    const { createMcpChildRuntime } = await import("./mcp.ts");
    const mcpPolicy: McpPolicyOperation[] = [{
      server: "serena",
      tool: SERENA_ACTIVATE_TOOL,
      args: { project: input.repoPath },
    }];
    childRuntime = await createMcpChildRuntime({
      cwd: workspace,
      model,
      modelRuntime,
      tools: CHILD_TOOLS,
      sessionManager: SessionManager.create(workspace, sessionDir),
      mcpPolicy,
    });
  } catch (error) {
    return { ...base, error: sanitizeError("child_creation_failed", error) };
  }

  const session = childRuntime.session;
  let toolErrored = false;
  let outcome: DelegationProbeResult = base;
  const toolContext = {
    seedPath: join(workspace, SEED_FILE),
    markerPath,
    repoPath: input.repoPath,
  };

  try {
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        observedTools.push(classifyToolEvent(event, toolContext));
      }
      if (event.type === "tool_execution_end" && event.isError) {
        toolErrored = true;
      }
    });

    await session.prompt(
      buildStartBrief({ workspace, repoPath: input.repoPath, nonce }),
    );
    await session.waitForIdle();

    let markerVerified = false;
    try {
      const marker = await readFile(markerPath, "utf8");
      markerVerified = marker.trim() === nonce;
    } catch {
      markerVerified = false;
    }

    const providerErrored = assistantExecutionFailed(session.messages);
    const evidence = evaluateAuthorityEvidence({
      observedTools,
      markerVerified,
      completedWithoutError: !toolErrored && !providerErrored,
    });

    const actualChild = modelIdentity(session.model);
    const sessionId = session.sessionId;
    const sessionFile = session.sessionFile ?? "";
    const identityVerified = childIdentityVerified(
      requestedChild,
      actualChild,
      sessionId,
      sessionFile,
    );
    const passed = evidence.passed && identityVerified;
    const child = actualChild
      ? { ...actualChild, sessionId, sessionFile }
      : null;

    outcome = {
      ...base,
      status: passed ? "passed" : "failed",
      child,
      independentRouting: independentRouting(
        input.parent,
        actualChild ?? requestedChild,
      ),
      authority: evidence.authority,
      error: passed
        ? null
        : providerErrored
          ? sanitizeError(
              "child_execution_failed",
              "provider returned an error before child completion",
            )
          : !identityVerified
            ? sanitizeError(
                "child_creation_failed",
                "actual child or persisted session identity did not match request",
              )
            : sanitizeError("authority_incomplete", "one or more authority signals missing"),
    };
  } catch (error) {
    outcome = { ...base, error: sanitizeError("child_execution_failed", error) };
  }

  try {
    await childRuntime.dispose();
  } catch {
    return { ...outcome, status: "failed", error: sanitizeError("child_cleanup_failed", "") };
  }
  return outcome;
}

export function openFollowUpSession(sessionFile: string) {
  const sessionManager = SessionManager.open(sessionFile);
  return { sessionManager, cwd: sessionManager.getCwd() };
}

interface FollowUpInput {
  provider: string;
  model: string;
  sessionFile: string;
  parent: ModelIdentity | null;
}

async function validateSessionFile(path: string): Promise<ProbeError | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return sanitizeError("session_not_found", path);
  }
  if (!info.isFile()) {
    return sanitizeError("session_invalid", "session path is not a regular file");
  }
  try {
    const content = await readFile(path, "utf8");
    const firstLine = content.split("\n")[0] ?? "";
    const header = JSON.parse(firstLine);
    if (!header || header.type !== "session") {
      return sanitizeError("session_invalid", "missing session header");
    }
    return null;
  } catch {
    return sanitizeError("session_invalid", "session file is not valid JSONL");
  }
}

async function runFollowUpProbe(input: FollowUpInput): Promise<DelegationProbeResult> {
  const requested: ModelIdentity = { provider: input.provider, model: input.model };
  const base: DelegationProbeResult = {
    schemaVersion: SCHEMA_VERSION,
    story: STORY,
    mode: "follow-up",
    status: "failed",
    requestedChild: requested,
    parent: input.parent,
    child: null,
    independentRouting: independentRouting(input.parent, requested),
    workspace: null,
    authority: null,
    continuity: null,
    observedTools: [],
    error: null,
  };

  const invalid = await validateSessionFile(input.sessionFile);
  if (invalid) return { ...base, error: invalid };

  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(input.provider, input.model);
  if (!model) {
    return { ...base, error: sanitizeError("child_model_not_found", `${input.provider}/${input.model}`) };
  }
  if (!modelRuntime.hasConfiguredAuth(input.provider)) {
    return { ...base, error: sanitizeError("child_model_unauthenticated", input.provider) };
  }

  // Recover persisted identity and expected nonce from JSONL, never from the marker file.
  let persistedSessionId = "";
  let expectedNonce = "";
  try {
    const transcript = await readFile(input.sessionFile, "utf8");
    const header = JSON.parse(transcript.split("\n")[0] ?? "{}");
    persistedSessionId = typeof header.id === "string" ? header.id : "";
    expectedNonce = extractNonceFromText(transcript) ?? "";
  } catch {
    persistedSessionId = "";
    expectedNonce = "";
  }

  let childRuntime: McpChildRuntime;
  try {
    const { sessionManager, cwd } = openFollowUpSession(input.sessionFile);
    const { createMcpChildRuntime } = await import("./mcp.ts");
    childRuntime = await createMcpChildRuntime({
      cwd,
      model,
      modelRuntime,
      tools: FOLLOW_UP_TOOLS,
      sessionManager,
    });
  } catch (error) {
    return { ...base, error: sanitizeError("session_reopen_failed", error) };
  }

  const session = childRuntime.session;
  let outcome: DelegationProbeResult = base;
  try {
    const reopenedSessionId = session.sessionId;
    const reopenedSessionFile = session.sessionFile ?? "";
    const actual = modelIdentity(session.model);

    let followUpToolCount = 0;
    let toolErrored = false;
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") followUpToolCount += 1;
      if (event.type === "tool_execution_end" && event.isError) toolErrored = true;
    });

    await session.prompt(buildFollowUpBrief(expectedNonce));
    await session.waitForIdle();

    const assistantText = session.getLastAssistantText() ?? "";
    const providerErrored = assistantExecutionFailed(session.messages);
    const evidence = evaluateContinuity({
      persistedSessionId,
      reopenedSessionId,
      requestedSessionFile: input.sessionFile,
      reopenedSessionFile,
      requested,
      actual,
      assistantText,
      nonce: expectedNonce,
      followUpToolCount,
      completedWithoutError: !toolErrored && !providerErrored,
    });

    outcome = {
      ...base,
      status: evidence.passed ? "passed" : "failed",
      child: {
        ...(actual ?? requested),
        sessionId: reopenedSessionId,
        sessionFile: reopenedSessionFile,
      },
      continuity: evidence.continuity,
      error: evidence.passed
        ? null
        : providerErrored
          ? sanitizeError(
              "child_execution_failed",
              "provider returned an error before follow-up completion",
            )
          : sanitizeError("continuity_failed", "continuity signals not satisfied"),
    };
  } catch (error) {
    outcome = { ...base, error: sanitizeError("child_execution_failed", error) };
  }

  try {
    await childRuntime.dispose();
  } catch {
    return { ...outcome, status: "failed", error: sanitizeError("child_cleanup_failed", "") };
  }
  return outcome;
}

/* ------------------------------------------------------------------ *
 * Extension registration
 * ------------------------------------------------------------------ */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default function delegationProbe(pi: ExtensionAPI) {
  pi.registerCommand("ima:delegate-probe", {
    description:
      "Prove Pi child delegation: independent provider/model, bounded tool authority, reusable session (FNR-3009)",
    handler: async (args, ctx) => {
      const parsed = parseDelegationProbeArgs(args);

      let result: DelegationProbeResult;
      if ("error" in parsed) {
        result = {
          schemaVersion: SCHEMA_VERSION,
          story: STORY,
          mode: "start",
          status: "failed",
          requestedChild: { provider: "", model: "" },
          parent: null,
          child: null,
          independentRouting: { providerDiffers: false, modelDiffers: false },
          workspace: null,
          authority: null,
          continuity: null,
          observedTools: [],
          error: sanitizeError(parsed.error, parsed.message),
        };
      } else if (parsed.mode === "start") {
        const parent = modelIdentity(ctx.model);
        if (!parent) {
          result = {
            schemaVersion: SCHEMA_VERSION,
            story: STORY,
            mode: "start",
            status: "failed",
            requestedChild: { provider: parsed.provider, model: parsed.model },
            parent: null,
            child: null,
            independentRouting: { providerDiffers: false, modelDiffers: false },
            workspace: null,
            authority: null,
            continuity: null,
            observedTools: [],
            error: sanitizeError("parent_model_missing", "no parent model selected"),
          };
        } else {
          result = await runStartProbe({
            provider: parsed.provider,
            model: parsed.model,
            parent,
            repoPath: repoRoot,
          });
        }
      } else {
        result = await runFollowUpProbe({
          provider: parsed.provider,
          model: parsed.model,
          sessionFile: parsed.sessionFile,
          parent: modelIdentity(ctx.model),
        });
      }

      const outputPath = process.env[RESULT_ENV_VAR];
      if (outputPath) {
        try {
          await writeFile(outputPath, JSON.stringify(result, null, 2));
        } catch (error) {
          result = withResultWriteFailure(result, error);
        }
      }

      if (ctx.hasUI) {
        const summary =
          result.status === "passed"
            ? `Delegation probe (${result.mode}) passed.`
            : `Delegation probe (${result.mode}) failed: ${result.error?.code ?? "unknown"}.`;
        ctx.ui.notify(summary, result.status === "passed" ? "info" : "warning");
      }
    },
  });
}
