import { readFile, stat } from "node:fs/promises";
import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../lib/ima-config.ts";
import {
  applyConfiguredPhaseRoute,
  applyConfiguredRoleRoute,
  type RoleRoute,
  type RouteSwitchResult,
  type WorkflowRoute,
} from "./workflow-routing.ts";

export const IMA_NEW_REQUEST_ENTRY = "ima-new-request";
export const IMA_NEW_RESULT_ENTRY = "ima-new-result";
export const IMA_NEW_BOOTSTRAP_COMMANDS = ["ima:serena-bootstrap", "ima:vestige-bootstrap"] as const;
export const IMA_NEW_PLAN_HINT = "/ima:plan <story-or-task-source>";

export type ImaNewSelector = "high" | "xhigh" | "plan" | null;
export type ImaNewRequest = { selector: ImaNewSelector };
export type ImaNewRouteEvidence =
  | { role: "HIGH" | "XHIGH"; provider: string; model: string; thinking?: ThinkingLevel }
  | { phase: "plan"; provider: string; model: string; thinking?: ThinkingLevel };
export type ImaNewResult =
  | { selector: ImaNewSelector; ok: true; route: ImaNewRouteEvidence | null }
  | { selector: ImaNewSelector; ok: false; error: string };

type Validation<T> = { valid: true; value: T } | { valid: false; error: string };
type Indexed<T> = { index: number; value: T };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const nonEmptyText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isPersistedParentSession = async (value: unknown): Promise<boolean> => {
  if (!nonEmptyText(value)) return false;
  try {
    return (await stat(value)).isFile();
  } catch {
    return false;
  }
};
const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const safeRouteErrors = new Set([
  "route_busy",
  "phase_config_unavailable",
  "role_config_unavailable",
  "phase_route_missing",
  "role_route_missing",
  "model_unavailable",
  "auth_unavailable",
  "thinking_unsupported",
  "route_apply_failed",
  "route_rollback_failed",
]);

export type ParsedImaNewSelector =
  | { ok: true; selector: ImaNewSelector }
  | { ok: false; error: "selector_invalid" };

export function parseImaNewSelector(input: unknown): ParsedImaNewSelector {
  if (typeof input !== "string") return { ok: false, error: "selector_invalid" };
  const value = input.trim();
  if (!value) return { ok: true, selector: null };
  if (value === "high" || value === "xhigh" || value === "plan") return { ok: true, selector: value };
  return { ok: false, error: "selector_invalid" };
}

const parseStoredSelector = (input: unknown): ParsedImaNewSelector => input === null ? { ok: true, selector: null } : parseImaNewSelector(input);

export function validateImaNewRequest(input: unknown): Validation<ImaNewRequest> {
  if (!object(input) || !exactKeys(input, ["selector"])) return { valid: false, error: "request_invalid" };
  const parsed = parseStoredSelector(input.selector);
  return parsed.ok ? { valid: true, value: { selector: parsed.selector } } : { valid: false, error: "request_invalid" };
}

const validateRouteEvidence = (input: unknown): ImaNewRouteEvidence | null => {
  if (!object(input) || !nonEmptyText(input.provider) || !nonEmptyText(input.model)) return null;
  if (input.thinking !== undefined && (!nonEmptyText(input.thinking) || !thinkingLevels.has(input.thinking as ThinkingLevel))) return null;
  const thinking = input.thinking === undefined ? {} : { thinking: input.thinking as ThinkingLevel };
  const role = input.role;
  if ((role === "HIGH" || role === "XHIGH") && exactKeys(input, ["role", "provider", "model", ...(input.thinking === undefined ? [] : ["thinking"])]) ) {
    return { role, provider: input.provider, model: input.model, ...thinking };
  }
  if (input.phase === "plan" && exactKeys(input, ["phase", "provider", "model", ...(input.thinking === undefined ? [] : ["thinking"])]) ) {
    return { phase: "plan", provider: input.provider, model: input.model, ...thinking };
  }
  return null;
};

const selectorMatchesRoute = (selector: ImaNewSelector, route: ImaNewRouteEvidence | null): boolean => {
  if (selector === null) return route === null;
  if (selector === "high") return route !== null && "role" in route && route.role === "HIGH";
  if (selector === "xhigh") return route !== null && "role" in route && route.role === "XHIGH";
  return route !== null && "phase" in route && route.phase === "plan";
};

export function validateImaNewResult(input: unknown): Validation<ImaNewResult> {
  if (!object(input) || !("selector" in input)) return { valid: false, error: "result_invalid" };
  const selector = parseStoredSelector(input.selector);
  if (!selector.ok || typeof input.ok !== "boolean") return { valid: false, error: "result_invalid" };
  if (input.ok) {
    const route = input.route === null ? null : validateRouteEvidence(input.route);
    if (!exactKeys(input, ["selector", "ok", "route"]) || (input.route !== null && route === null) || !selectorMatchesRoute(selector.selector, route)) return { valid: false, error: "result_invalid" };
    return { valid: true, value: { selector: selector.selector, ok: true, route } };
  }
  if (!exactKeys(input, ["selector", "ok", "error"]) || typeof input.error !== "string" || !safeRouteErrors.has(input.error)) return { valid: false, error: "result_invalid" };
  return { valid: true, value: { selector: selector.selector, ok: false, error: input.error } };
}

const latestValidEntry = <T>(entries: readonly unknown[], customType: string, validate: (value: unknown) => Validation<T>): Indexed<T> | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!object(entry) || entry.type !== "custom" || entry.customType !== customType) continue;
    const result = validate(entry.data);
    if (result.valid) return { index, value: result.value };
  }
  return null;
};

export function latestImaNewRequest(entries: readonly unknown[]): ImaNewRequest | null {
  return latestValidEntry(entries, IMA_NEW_REQUEST_ENTRY, validateImaNewRequest)?.value ?? null;
}

export function latestImaNewResult(entries: readonly unknown[]): ImaNewResult | null {
  return latestValidEntry(entries, IMA_NEW_RESULT_ENTRY, validateImaNewResult)?.value ?? null;
}

const pendingImaNewRequest = (entries: readonly unknown[]): ImaNewRequest | null => {
  const request = latestValidEntry(entries, IMA_NEW_REQUEST_ENTRY, validateImaNewRequest);
  if (!request) return null;
  const result = latestValidEntry(entries, IMA_NEW_RESULT_ENTRY, validateImaNewResult);
  if (result && result.index > request.index && result.value.selector === request.value.selector) return null;
  return request.value;
};

const routeEvidence = (route: WorkflowRoute | RoleRoute): ImaNewRouteEvidence | null => {
  if ("role" in route) {
    const role = route.role;
    return (role === "HIGH" || role === "XHIGH") && nonEmptyText(route.provider) && nonEmptyText(route.model)
      ? { role, provider: route.provider, model: route.model, ...(route.thinking ? { thinking: route.thinking } : {}) }
      : null;
  }
  return route.phase === "plan" && nonEmptyText(route.provider) && nonEmptyText(route.model)
    ? { phase: "plan", provider: route.provider, model: route.model, ...(route.thinking ? { thinking: route.thinking } : {}) }
    : null;
};

const safeRouteError = (error: unknown) => typeof error === "string" && safeRouteErrors.has(error) ? error : "route_apply_failed";

export function buildImaNewResult(selector: ImaNewSelector, result: RouteSwitchResult): ImaNewResult {
  if (!result.ok) return { selector, ok: false, error: safeRouteError(result.error) };
  const route = routeEvidence(result.route);
  return !selectorMatchesRoute(selector, route)
    ? { selector, ok: false, error: "route_apply_failed" }
    : { selector, ok: true, route };
}

const invalidBootstrapResource = () => new Error("bootstrap_resource_unavailable");

const promptSourcePath = (command: unknown): string | null => {
  if (!object(command) || command.source !== "prompt" || !object(command.sourceInfo)) return null;
  return typeof command.sourceInfo.path === "string" && command.sourceInfo.path.trim() ? command.sourceInfo.path : null;
};

const readPromptBody = async (path: string): Promise<string> => {
  try {
    const body = stripFrontmatter(await readFile(path, "utf8")).trim();
    if (!body) throw invalidBootstrapResource();
    return body;
  } catch {
    throw invalidBootstrapResource();
  }
};

export async function resolveImaNewBootstrapMessages(pi: Pick<ExtensionAPI, "getCommands">): Promise<readonly string[]> {
  const commands = pi.getCommands();
  if (!Array.isArray(commands)) throw invalidBootstrapResource();

  const messages: string[] = [];
  for (const name of IMA_NEW_BOOTSTRAP_COMMANDS) {
    const matches = commands.filter((command) => object(command) && command.name === name);
    if (matches.length !== 1) throw invalidBootstrapResource();
    const path = promptSourcePath(matches[0]);
    if (!path) throw invalidBootstrapResource();
    messages.push(await readPromptBody(path));
  }
  return messages;
}

export function buildImaNewBootstrapSequence(result: ImaNewResult | null, messages: readonly string[]): readonly string[] {
  return result?.ok ? messages : [];
}

type ReplacementSessionManager = {
  getBranch: () => readonly unknown[];
  getLeafId?: () => string | null;
};

type ReplacementSessionContext = {
  sendUserMessage: (message: string) => Promise<unknown> | unknown;
  waitForIdle: () => Promise<unknown>;
  sessionManager: ReplacementSessionManager;
  ui: { setEditorText: (text: string) => unknown; notify?: (message: string, level: "info" | "warning" | "error") => unknown };
};

type BootstrapBoundary = { leafId: string | null; branchLength: number };

const entryId = (entry: unknown): string | null => object(entry) && typeof entry.id === "string" ? entry.id : null;

const snapshotBootstrapBoundary = (sessionManager: ReplacementSessionManager): BootstrapBoundary => {
  const branch = sessionManager.getBranch();
  const leafId = typeof sessionManager.getLeafId === "function"
    ? sessionManager.getLeafId()
    : entryId(branch[branch.length - 1]);
  return { leafId: typeof leafId === "string" ? leafId : null, branchLength: branch.length };
};

const entriesAfterBootstrapBoundary = (sessionManager: ReplacementSessionManager, boundary: BootstrapBoundary): readonly unknown[] | null => {
  const branch = sessionManager.getBranch();
  if (boundary.leafId === null) return branch.length >= boundary.branchLength ? branch.slice(boundary.branchLength) : null;
  const index = branch.findIndex((entry) => entryId(entry) === boundary.leafId);
  return index < 0 ? null : branch.slice(index + 1);
};

const assistantMessage = (entry: unknown): Record<string, unknown> | null => {
  if (!object(entry) || entry.type !== "message" || !object(entry.message) || entry.message.role !== "assistant") return null;
  return entry.message;
};

const bootstrapTurnSucceeded = (sessionManager: ReplacementSessionManager, boundary: BootstrapBoundary): boolean => {
  const entries = entriesAfterBootstrapBoundary(sessionManager, boundary);
  if (!entries) return false;
  const assistants = entries.map(assistantMessage).filter((message) => message !== null);
  return assistants.at(-1)?.stopReason === "stop";
};

const validBootstrapMessages = (messages: readonly string[]) =>
  Array.isArray(messages) &&
  messages.length === IMA_NEW_BOOTSTRAP_COMMANDS.length &&
  messages.every((message, index) => nonEmptyText(message) && message !== `/${IMA_NEW_BOOTSTRAP_COMMANDS[index]}`);

export async function injectImaNewBootstrap(
  ctx: ReplacementSessionContext,
  result: ImaNewResult,
  messages: readonly string[],
): Promise<void> {
  if (!result.ok || !validBootstrapMessages(messages)) throw invalidBootstrapResource();
  for (const message of buildImaNewBootstrapSequence(result, messages)) {
    const boundary = snapshotBootstrapBoundary(ctx.sessionManager);
    await ctx.sendUserMessage(message);
    await ctx.waitForIdle();
    if (!bootstrapTurnSucceeded(ctx.sessionManager, boundary)) throw new Error("bootstrap_turn_failed");
  }
  ctx.ui.setEditorText(IMA_NEW_PLAN_HINT);
}

const notify = (ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error" = "warning") => {
  if (ctx.hasUI) ctx.ui.notify(message, level);
};

const prepareResult = async (pi: ExtensionAPI, ctx: ExtensionContext, selector: ImaNewSelector): Promise<ImaNewResult> => {
  if (selector === null) return { selector, ok: true, route: null };
  try {
    let result: RouteSwitchResult;
    if (selector === "high") result = await applyConfiguredRoleRoute(pi, ctx, "HIGH");
    else if (selector === "xhigh") result = await applyConfiguredRoleRoute(pi, ctx, "XHIGH");
    else if (selector === "plan") result = await applyConfiguredPhaseRoute(pi, ctx, "plan");
    else return { selector, ok: false, error: "route_apply_failed" };
    return buildImaNewResult(selector, result);
  } catch {
    return { selector, ok: false, error: "route_apply_failed" };
  }
};

const handleReplacement = async (ctx: ReplacementSessionContext, messages: readonly string[]) => {
  const result = latestImaNewResult(ctx.sessionManager.getBranch());
  if (!result) {
    notify(ctx as Pick<ExtensionContext, "hasUI" | "ui">, "Fresh session route result was unavailable.");
    return;
  }
  if (!result.ok) {
    notify(ctx as Pick<ExtensionContext, "hasUI" | "ui">, `Fresh session blocked: ${result.error}.`);
    return;
  }
  try {
    await injectImaNewBootstrap(ctx, result, messages);
  } catch {
    notify(ctx as Pick<ExtensionContext, "hasUI" | "ui">, "Fresh session bootstrap failed; no planning prompt was injected.");
  }
};

export default function imaNew(pi: ExtensionAPI) {
  pi.registerCommand("ima:new", {
    description: "Create a fresh TUI session with an optional HIGH, XHIGH, or plan route.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        notify(ctx, "ima:new requires TUI mode.");
        return;
      }
      if (!ctx.isIdle()) {
        notify(ctx, "ima:new is unavailable while the session is busy.");
        return;
      }
      const parsed = parseImaNewSelector(args);
      if (!parsed.ok) {
        notify(ctx, "Usage: /ima:new [high|xhigh|plan].");
        return;
      }
      const parentSession = ctx.sessionManager.getSessionFile();
      if (!nonEmptyText(parentSession) || !(await isPersistedParentSession(parentSession))) {
        notify(ctx, "ima:new requires a persisted parent session; restart Pi without --no-session.");
        return;
      }
      let bootstrapMessages: readonly string[];
      try {
        bootstrapMessages = await resolveImaNewBootstrapMessages(pi);
      } catch {
        notify(ctx, "Fresh session bootstrap resources were unavailable.");
        return;
      }
      try {
        const result = await ctx.newSession({
          parentSession,
          setup: async (sessionManager) => {
            sessionManager.appendCustomEntry(IMA_NEW_REQUEST_ENTRY, { selector: parsed.selector });
          },
          withSession: async (replacementCtx) => {
            await handleReplacement(replacementCtx, bootstrapMessages);
          },
        });
        if (result.cancelled) notify(ctx, "New session cancelled.", "info");
      } catch {
        notify(ctx, "Fresh session could not be created.");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const request = pendingImaNewRequest(ctx.sessionManager.getBranch());
    if (!request) return;
    const result = await prepareResult(pi, ctx, request.selector);
    pi.appendEntry(IMA_NEW_RESULT_ENTRY, result);
  });
}
