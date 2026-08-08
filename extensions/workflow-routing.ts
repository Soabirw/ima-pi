import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  discoverImaProfiles,
  deriveImaConfigPaths,
  isFatalConfigDiagnostic,
  isImaProfileName,
  loadImaConfig,
  resolveCommandRoute as resolveConfiguredCommandRoute,
  validateConfigLayer,
  type ImaProfile,
  type ImaRole,
  type ResolvedImaConfig,
  type ThinkingLevel,
  type ValidConfigLayer,
} from "../lib/ima-config.ts";

export const IMA_PROFILE_ENTRY = "ima-profile-state";
export const IMA_PHASE_ROUTE_ENTRY = "ima-phase-route";
export const IMA_ROLE_ROUTE_ENTRY = "ima-role-route";

export type ParsedWorkflowCommand = { command: string; name: string; args: string };
export type ParsedProfileCommand = { mode: "list" } | { mode: "activate"; name: string } | { mode: "invalid"; error: string };
export type CommandRoute = { command: string; provider: string; model: string; thinking?: ThinkingLevel };
export type WorkflowRoute = CommandRoute;
export type RoleRoute = { role: ImaRole; provider: string; model: string; thinking?: ThinkingLevel };
export type RouteSwitchResult =
  | { ok: true; route: CommandRoute | RoleRoute }
  | { ok: false; error: string; message: string; rollback?: "succeeded" | "failed" | "not-needed" };

const PROFILE_USAGE = "usage: /ima:profile | /ima:profile <name>";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = getAgentDir();
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function parseWorkflowCommand(input: unknown): ParsedWorkflowCommand | null {
  if (typeof input !== "string") return null;
  const raw = input.trimStart();
  if (!raw.startsWith("/")) return null;
  const separator = raw.search(/\s/);
  const token = separator === -1 ? raw : raw.slice(0, separator);
  const command = token.slice(1);
  if (!command.startsWith("ima:")) return null;
  const name = command.slice("ima:".length);
  if (!name) return null;
  return { command, name, args: separator === -1 ? "" : raw.slice(separator).trim() };
}

export function parseProfileCommand(input: unknown): ParsedProfileCommand {
  const raw = text(input);
  if (!raw) return { mode: "list" };
  const tokens = raw.split(/\s+/).filter(Boolean);
  const names = tokens.filter((token) => token !== "--save");
  if (names.length !== 1 || !isImaProfileName(names[0])) return { mode: "invalid", error: PROFILE_USAGE };
  return { mode: "activate", name: names[0] };
}

export function resolveCommandRoute(config: Pick<ResolvedImaConfig, "commands" | "phases"> | null | undefined, command: string): { ok: true; route: CommandRoute } | null {
  const mapping = resolveConfiguredCommandRoute(config, command);
  return mapping ? { ok: true, route: { command, provider: mapping.provider, model: mapping.model, ...(mapping.thinking ? { thinking: mapping.thinking } : {}) } } : null;
}

export function resolveRoleRoute(config: Pick<ResolvedImaConfig, "models"> | null | undefined, role: ImaRole): { ok: true; route: RoleRoute } | { ok: false; error: "role_route_missing"; message: string } {
  const mapping = config?.models?.[role];
  if (!mapping || !text(mapping.provider) || !text(mapping.model)) return { ok: false, error: "role_route_missing", message: `${role} role route is not configured.` };
  return { ok: true, route: { role, provider: mapping.provider, model: mapping.model, ...(mapping.thinking ? { thinking: mapping.thinking } : {}) } };
}

export function formatRouteMatrix(config: Pick<ResolvedImaConfig, "profile" | "commands" | "phases" | "models"> | null | undefined): string {
  if (!config) return "No effective IMA profile.";
  const route = (mapping: { provider: string; model: string; thinking?: ThinkingLevel }) => `${mapping.provider}/${mapping.model}${mapping.thinking ? ` (${mapping.thinking})` : ""}`;
  const commands = Object.entries(config.commands).filter(([, mapping]) => Boolean(mapping)).sort(([left], [right]) => left.localeCompare(right));
  const phases = Object.entries(config.phases).filter(([, mapping]) => Boolean(mapping)).sort(([left], [right]) => left.localeCompare(right));
  const roles = Object.entries(config.models).filter(([, mapping]) => Boolean(mapping)).sort(([left], [right]) => left.localeCompare(right));
  return [
    `profile: ${config.profile ?? "(none)"}`,
    "commands:",
    ...(commands.length ? commands.map(([name, mapping]) => `${name}: ${route(mapping!)}`) : [phases.length ? "(none; no direct command routes)" : "(none; no direct command or legacy phase routes; unconfigured commands pass through)"]),
    "legacy phases:",
    ...(phases.length ? phases.map(([name, mapping]) => `${name}: ${route(mapping!)}`) : ["(none)"]),
    "roles:",
    ...(roles.length ? roles.map(([name, mapping]) => `${name}: ${route(mapping!)}`) : ["(none)"]),
  ].join("\n");
}

export function formatProfileList(profiles: readonly ImaProfile[], active: string | null = null): string {
  if (!profiles.length) return "No IMA profiles are available.";
  return profiles.map((profile) => `${profile.name}${profile.name === active ? " (active)" : ""} [${profile.source}]`).join("\n");
}

export function latestSessionProfile(entries: readonly any[]): string | null {
  for (const entry of [...entries].reverse()) {
    if (entry?.type !== "custom" || entry.customType !== IMA_PROFILE_ENTRY) continue;
    const profile = entry.data?.profile;
    if (isImaProfileName(profile)) return profile;
  }
  return null;
}

export type ProfileSaveDependencies = {
  readText?: (path: string) => Promise<string>;
  makeDirectory?: (path: string) => Promise<void>;
  writeText?: (path: string, content: string) => Promise<void>;
  move?: (from: string, to: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  temporaryId?: () => string;
};

export async function persistUserProfileSelection(input: { path: string; profile: string; dependencies?: ProfileSaveDependencies }): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!isImaProfileName(input.profile)) return { ok: false, error: "profile_name_invalid" };
  const dependencies = input.dependencies ?? {};
  const read = dependencies.readText ?? ((path: string) => readFile(path, "utf8"));
  const makeDirectory = dependencies.makeDirectory ?? (async (path: string) => { await mkdir(path, { recursive: true }); });
  const write = dependencies.writeText ?? (async (path: string, content: string) => { await writeFile(path, content, "utf8"); });
  const move = dependencies.move ?? rename;
  const remove = dependencies.remove ?? unlink;
  let layer: ValidConfigLayer = { schemaVersion: 1 };
  try {
    const existing = await read(input.path);
    const parsed = JSON.parse(existing);
    const validation = validateConfigLayer(parsed, "user");
    if (!validation.valid || !validation.value) return { ok: false, error: "user_config_invalid" };
    layer = validation.value;
  } catch (error: any) {
    if (error?.code !== "ENOENT") return { ok: false, error: "user_config_unreadable" };
  }
  const next: ValidConfigLayer = { schemaVersion: 1, profile: input.profile, ...(layer.models ? { models: layer.models } : {}), ...(layer.phases ? { phases: layer.phases } : {}), ...(layer.commands ? { commands: layer.commands } : {}) };
  const temporaryId = dependencies.temporaryId ?? randomUUID;
  const temporaryPath = join(dirname(input.path), `.${basename(input.path)}.${temporaryId()}.tmp`);
  try {
    await makeDirectory(dirname(input.path));
    await write(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    await move(temporaryPath, input.path);
    return { ok: true, path: input.path };
  } catch {
    try { await remove(temporaryPath); } catch {}
    return { ok: false, error: "user_config_save_failed" };
  }
}

export type RouteSwitchDependencies = {
  findModel: (provider: string, model: string) => unknown | undefined;
  hasConfiguredAuth?: (model: unknown) => boolean | Promise<boolean>;
  previousModel: unknown | undefined;
  previousThinking: ThinkingLevel;
  getThinkingLevel: () => ThinkingLevel;
  setModel: (model: unknown) => boolean | Promise<boolean>;
  setThinkingLevel: (level: ThinkingLevel) => void;
  appendEntry?: (customType: string, data: Record<string, unknown>) => void;
  isIdle?: () => boolean;
  profile?: string | null;
};

const rollbackRoute = async (input: RouteSwitchDependencies): Promise<boolean> => {
  if (!input.previousModel) return false;
  try {
    if (!await input.setModel(input.previousModel)) return false;
    input.setThinkingLevel(input.previousThinking);
    return input.getThinkingLevel() === input.previousThinking;
  } catch {
    return false;
  }
};

type ResolvedRouteTarget =
  | { kind: "command"; route: CommandRoute }
  | { kind: "role"; route: RoleRoute };

const routeBusy = (kind: ResolvedRouteTarget["kind"]): RouteSwitchResult => ({
  ok: false,
  error: "route_busy",
  message: `${kind === "command" ? "Command" : "Role"} routing is unavailable while the session is busy.`,
  rollback: "not-needed",
});

const applyResolvedRoute = async (target: ResolvedRouteTarget, input: RouteSwitchDependencies): Promise<RouteSwitchResult> => {
  const name = target.kind === "command" ? target.route.command : target.route.role;
  const model = input.findModel(target.route.provider, target.route.model);
  if (!model) return { ok: false, error: "model_unavailable", message: `Configured ${name} model is unavailable.`, rollback: "not-needed" };
  const authFailure = (): RouteSwitchResult => ({ ok: false, error: "auth_unavailable", message: `Configured ${name} model is unauthenticated.`, rollback: "not-needed" });
  if (input.hasConfiguredAuth) {
    try {
      if (!await input.hasConfiguredAuth(model)) return authFailure();
    } catch {
      return authFailure();
    }
  }
  let modelAttempted = false;
  try {
    modelAttempted = true;
    if (!await input.setModel(model)) return authFailure();
    if (target.route.thinking) {
      input.setThinkingLevel(target.route.thinking);
      if (input.getThinkingLevel() !== target.route.thinking) throw new Error("thinking_unsupported");
    }
    input.appendEntry?.(target.kind === "command" ? IMA_PHASE_ROUTE_ENTRY : IMA_ROLE_ROUTE_ENTRY, {
      profile: input.profile ?? null,
      ...(target.kind === "command" ? { command: target.route.command } : { role: target.route.role }),
      provider: target.route.provider,
      model: target.route.model,
      ...(target.route.thinking ? { thinking: target.route.thinking } : {}),
    });
    return { ok: true, route: target.route };
  } catch (error) {
    const restored = modelAttempted ? await rollbackRoute(input) : true;
    if (!restored) return { ok: false, error: "route_rollback_failed", message: `${target.kind === "command" ? "Command" : "Role"} routing failed and the previous model could not be restored; select a model manually.`, rollback: "failed" };
    const errorCode = error instanceof Error && error.message === "thinking_unsupported" ? "thinking_unsupported" : "route_apply_failed";
    return { ok: false, error: errorCode, message: errorCode === "thinking_unsupported" ? `Configured ${name} thinking level is unsupported by the selected model.` : `Configured ${name} route could not be applied.`, rollback: "succeeded" };
  }
};

export async function applyCommandRoute(config: Pick<ResolvedImaConfig, "commands" | "phases"> | null | undefined, command: string, input: RouteSwitchDependencies): Promise<RouteSwitchResult | null> {
  const resolved = resolveCommandRoute(config, command);
  if (!resolved) return null;
  if (input.isIdle && !input.isIdle()) return routeBusy("command");
  return applyResolvedRoute({ kind: "command", route: resolved.route }, input);
}

export async function applyRoleRoute(config: Pick<ResolvedImaConfig, "models"> | null | undefined, role: ImaRole, input: RouteSwitchDependencies): Promise<RouteSwitchResult> {
  if (input.isIdle && !input.isIdle()) return routeBusy("role");
  const resolved = resolveRoleRoute(config, role);
  if (!resolved.ok) return resolved;
  return applyResolvedRoute({ kind: "role", route: resolved.route }, input);
}

const projectTrusted = (ctx: ExtensionContext) => typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : process.env.IMA_PI_PROJECT_TRUSTED === "true";
const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(message, level); };

const routeDependencies = (pi: ExtensionAPI, ctx: ExtensionContext, profile: string | null): RouteSwitchDependencies => ({
  findModel: (provider, model) => ctx.modelRegistry.find(provider, model),
  hasConfiguredAuth: (model) => ctx.modelRegistry.hasConfiguredAuth(model as any),
  previousModel: ctx.model,
  previousThinking: pi.getThinkingLevel(),
  getThinkingLevel: () => pi.getThinkingLevel(),
  setModel: (model) => pi.setModel(model as any),
  setThinkingLevel: (level) => pi.setThinkingLevel(level),
  appendEntry: (customType, data) => pi.appendEntry(customType, data),
  isIdle: () => ctx.isIdle(),
  profile,
});

export async function applyConfiguredCommandRoute(pi: ExtensionAPI, ctx: ExtensionContext, command: string, profileOverride?: string | null): Promise<RouteSwitchResult | null> {
  const loaded = await loadImaConfig({ packageRoot, agentDir, cwd: ctx.cwd, projectTrusted: projectTrusted(ctx), ...(profileOverride ? { profileOverride } : {}) });
  if (!loaded.config) return { ok: false, error: "command_config_unavailable", message: `${command} command routing is unavailable: ${loaded.diagnostics.map(({ code }) => code).join(", ") || "invalid configuration"}.`, rollback: "not-needed" };
  return applyCommandRoute(loaded.config, command, routeDependencies(pi, ctx, profileOverride ?? loaded.config.profile));
}

export async function applyConfiguredRoleRoute(pi: ExtensionAPI, ctx: ExtensionContext, role: ImaRole, profileOverride?: string | null): Promise<RouteSwitchResult> {
  const loaded = await loadImaConfig({ packageRoot, agentDir, cwd: ctx.cwd, projectTrusted: projectTrusted(ctx), ...(profileOverride ? { profileOverride } : {}) });
  if (!loaded.config) return { ok: false, error: "role_config_unavailable", message: `${role} role routing is unavailable: ${loaded.diagnostics.map(({ code }) => code).join(", ") || "invalid configuration"}.`, rollback: "not-needed" };
  return applyRoleRoute(loaded.config, role, routeDependencies(pi, ctx, profileOverride ?? loaded.config.profile));
}

export default function workflowRouting(pi: ExtensionAPI) {
  let sessionProfile: string | null = null;
  const load = (ctx: ExtensionContext, override = sessionProfile) => loadImaConfig({ packageRoot, agentDir, cwd: ctx.cwd, projectTrusted: projectTrusted(ctx), ...(override ? { profileOverride: override } : {}) });
  const showProfiles = async (ctx: ExtensionContext) => {
    const paths = deriveImaConfigPaths({ packageRoot, agentDir, cwd: ctx.cwd });
    return discoverImaProfiles({ paths, projectTrusted: projectTrusted(ctx) });
  };
  const activate = async (name: string, ctx: ExtensionContext) => {
    const loaded = await load(ctx, name);
    if (!loaded.config) { notify(ctx, `Profile "${name}" blocked: ${loaded.diagnostics.map(({ code }) => code).join(", ") || "invalid configuration"}.`, "warning"); return false; }
    const saved = await persistUserProfileSelection({ path: loaded.paths.user, profile: name });
    if (!saved.ok) { notify(ctx, `Profile "${name}" was not activated: ${saved.error}.`, "warning"); return false; }
    sessionProfile = name;
    pi.appendEntry(IMA_PROFILE_ENTRY, { profile: name });
    if (loaded.diagnostics.length) notify(ctx, `IMA profile "${name}" warnings: ${loaded.diagnostics.map(({ code }) => code).join(", ")}.`, "warning");
    notify(ctx, `IMA profile "${name}" activated and saved as your user default.\n${formatRouteMatrix(loaded.config)}`, "info");
    return true;
  };

  pi.registerCommand("ima:profile", {
    description: "Show or activate an IMA phase model profile.",
    handler: async (args, ctx) => {
      const parsed = parseProfileCommand(args);
      if (parsed.mode === "invalid") { notify(ctx, parsed.error, "warning"); return; }
      if (parsed.mode === "activate") { await activate(parsed.name, ctx); return; }
      const [profiles, loaded] = await Promise.all([showProfiles(ctx), load(ctx)]);
      if (profiles.diagnostics.some(isFatalConfigDiagnostic)) { notify(ctx, `IMA profile discovery blocked: ${profiles.diagnostics.map(({ code }) => code).join(", ")}.`, "warning"); return; }
      if (profiles.diagnostics.length) notify(ctx, `IMA profile discovery warnings: ${profiles.diagnostics.map(({ code }) => code).join(", ")}.`, "warning");
      const listing = formatProfileList(profiles.profiles, sessionProfile ?? loaded.config?.profile ?? null);
      if (!ctx.hasUI) { notify(ctx, listing, "info"); return; }
      const choice = await ctx.ui.select("Select IMA profile", profiles.profiles.map((profile) => `${profile.name}${profile.name === (sessionProfile ?? loaded.config?.profile) ? " (active)" : ""}`));
      if (!choice) { notify(ctx, listing, "info"); return; }
      await activate(choice.replace(/ \(active\)$/, ""), ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionProfile = latestSessionProfile(ctx.sessionManager.getBranch());
    const loaded = await load(ctx);
    if (!loaded.config && loaded.diagnostics.length) notify(ctx, `IMA command profiles unavailable: ${loaded.diagnostics.map(({ code }) => code).join(", ")}.`, "warning");
    else if (loaded.diagnostics.length) notify(ctx, `IMA command profile warnings: ${loaded.diagnostics.map(({ code }) => code).join(", ")}.`, "warning");
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    const parsed = parseWorkflowCommand(event.text);
    if (!parsed) return { action: "continue" as const };
    const loaded = await load(ctx);
    if (!loaded.config) {
      notify(ctx, `/${parsed.command} blocked: ${loaded.diagnostics.map(({ code }) => code).join(", ") || "invalid IMA configuration"}.`, "warning");
      return { action: "handled" as const };
    }
    if (loaded.diagnostics.length) notify(ctx, `/${parsed.command} configuration warnings: ${loaded.diagnostics.map(({ code }) => code).join(", ")}.`, "warning");
    const result = await applyCommandRoute(loaded.config, parsed.name, {
      findModel: (provider, model) => ctx.modelRegistry.find(provider, model),
      hasConfiguredAuth: (model) => ctx.modelRegistry.hasConfiguredAuth(model as any),
      previousModel: ctx.model,
      previousThinking: pi.getThinkingLevel(),
      getThinkingLevel: () => pi.getThinkingLevel(),
      setModel: (model) => pi.setModel(model as any),
      setThinkingLevel: (level) => pi.setThinkingLevel(level),
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
      isIdle: () => ctx.isIdle(),
      profile: sessionProfile ?? loaded.config.profile,
    });
    if (result === null) return { action: "continue" as const };
    if (!result.ok) {
      notify(ctx, `/${parsed.command} blocked: ${result.message}`, "warning");
      return { action: "handled" as const };
    }
    if (ctx.hasUI) ctx.ui.setStatus("ima-command-route", `${parsed.name}: ${result.route.provider}/${result.route.model}`);
    return { action: "continue" as const };
  });
}
