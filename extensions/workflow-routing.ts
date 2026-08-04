import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  IMA_PHASES,
  discoverImaProfiles,
  deriveImaConfigPaths,
  isImaProfileName,
  loadImaConfig,
  validateConfigLayer,
  type ImaPhase,
  type ImaProfile,
  type ResolvedImaConfig,
  type ThinkingLevel,
  type ValidConfigLayer,
} from "../lib/ima-config.ts";

export const IMA_PROFILE_ENTRY = "ima-profile-state";
export const IMA_PHASE_ROUTE_ENTRY = "ima-phase-route";
export const WORKFLOW_PHASES = IMA_PHASES;
export const WORKFLOW_COMMAND_PHASES: Readonly<Record<string, ImaPhase>> = {
  "ima:plan": "plan",
  "ima:implement": "implement",
  "ima:implement-js": "implement",
  "ima:implement-wp": "implement",
  "ima:test": "test",
  "ima:review": "review",
  "ima:document": "document",
};

export type ParsedWorkflowCommand = { command: string; phase: ImaPhase; args: string };
export type ParsedProfileCommand = { mode: "list" } | { mode: "activate"; name: string; save: boolean } | { mode: "invalid"; error: string };
export type WorkflowRoute = { phase: ImaPhase; provider: string; model: string; thinking?: ThinkingLevel };
export type RouteSwitchResult =
  | { ok: true; route: WorkflowRoute }
  | { ok: false; error: string; message: string; rollback?: "succeeded" | "failed" | "not-needed" };

const PROFILE_USAGE = "usage: /ima:profile | /ima:profile <name> [--save]";
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
  const phase = WORKFLOW_COMMAND_PHASES[command];
  if (!phase) return null;
  return { command, phase, args: separator === -1 ? "" : raw.slice(separator).trim() };
}

export function parseProfileCommand(input: unknown): ParsedProfileCommand {
  const raw = text(input);
  if (!raw) return { mode: "list" };
  const tokens = raw.split(/\s+/).filter(Boolean);
  const save = tokens.includes("--save");
  const names = tokens.filter((token) => token !== "--save");
  if (names.length !== 1 || names[0] === "--save" || !isImaProfileName(names[0])) return { mode: "invalid", error: PROFILE_USAGE };
  return { mode: "activate", name: names[0], save };
}

export function resolvePhaseRoute(config: Pick<ResolvedImaConfig, "phases"> | null | undefined, phase: ImaPhase): { ok: true; route: WorkflowRoute } | { ok: false; error: "phase_route_missing"; message: string } {
  const mapping = config?.phases?.[phase];
  if (!mapping || !text(mapping.provider) || !text(mapping.model)) return { ok: false, error: "phase_route_missing", message: `${phase} phase route is not configured.` };
  return { ok: true, route: { phase, provider: mapping.provider, model: mapping.model, ...(mapping.thinking ? { thinking: mapping.thinking } : {}) } };
}

export function formatPhaseMatrix(config: Pick<ResolvedImaConfig, "profile" | "phases"> | null | undefined): string {
  if (!config) return "No effective IMA profile.";
  const rows = WORKFLOW_PHASES.map((phase) => {
    const route = config.phases[phase];
    if (!route) return `${phase}: unavailable`;
    const effort = route.thinking ? ` (${route.thinking})` : "";
    const inherited = route.source === "inherited" ? ` [${route.inheritedFrom} inheritance]` : "";
    return `${phase}: ${route.provider}/${route.model}${effort}${inherited}`;
  });
  return [`profile: ${config.profile ?? "(none)"}`, ...rows].join("\n");
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
  const next: ValidConfigLayer = { schemaVersion: 1, profile: input.profile, ...(layer.models ? { models: layer.models } : {}), ...(layer.phases ? { phases: layer.phases } : {}) };
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

export async function applyPhaseRoute(config: Pick<ResolvedImaConfig, "phases"> | null | undefined, phase: ImaPhase, input: RouteSwitchDependencies): Promise<RouteSwitchResult> {
  if (input.isIdle && !input.isIdle()) return { ok: false, error: "route_busy", message: "Phase routing is unavailable while the session is busy.", rollback: "not-needed" };
  const resolved = resolvePhaseRoute(config, phase);
  if (!resolved.ok) return resolved;
  const model = input.findModel(resolved.route.provider, resolved.route.model);
  if (!model) return { ok: false, error: "model_unavailable", message: `Configured ${phase} model is unavailable.`, rollback: "not-needed" };
  const authFailure = (): RouteSwitchResult => ({ ok: false, error: "auth_unavailable", message: `Configured ${phase} model is unauthenticated.`, rollback: "not-needed" });
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
    if (!await input.setModel(model)) return { ok: false, error: "auth_unavailable", message: `Configured ${phase} model is unauthenticated.`, rollback: "not-needed" };
    if (resolved.route.thinking) {
      input.setThinkingLevel(resolved.route.thinking);
      if (input.getThinkingLevel() !== resolved.route.thinking) throw new Error("thinking_unsupported");
    }
    input.appendEntry?.(IMA_PHASE_ROUTE_ENTRY, {
      profile: input.profile ?? null,
      phase,
      provider: resolved.route.provider,
      model: resolved.route.model,
      ...(resolved.route.thinking ? { thinking: resolved.route.thinking } : {}),
    });
    return { ok: true, route: resolved.route };
  } catch (error) {
    const restored = modelAttempted ? await rollbackRoute(input) : true;
    if (!restored) return { ok: false, error: "route_rollback_failed", message: "Phase routing failed and the previous model could not be restored; select a model manually.", rollback: "failed" };
    const errorCode = error instanceof Error && error.message === "thinking_unsupported" ? "thinking_unsupported" : "route_apply_failed";
    return { ok: false, error: errorCode, message: errorCode === "thinking_unsupported" ? `Configured ${phase} thinking level is unsupported by the selected model.` : `Configured ${phase} route could not be applied.`, rollback: "succeeded" };
  }
}

const projectTrusted = (ctx: ExtensionContext) => typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : process.env.IMA_PI_PROJECT_TRUSTED === "true";
const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(message, level); };

export default function workflowRouting(pi: ExtensionAPI) {
  let sessionProfile: string | null = null;
  const load = (ctx: ExtensionContext, override = sessionProfile) => loadImaConfig({ packageRoot, agentDir, cwd: ctx.cwd, projectTrusted: projectTrusted(ctx), ...(override ? { profileOverride: override } : {}) });
  const showProfiles = async (ctx: ExtensionContext) => {
    const paths = deriveImaConfigPaths({ packageRoot, agentDir, cwd: ctx.cwd });
    return discoverImaProfiles({ paths, projectTrusted: projectTrusted(ctx) });
  };
  const activate = async (name: string, save: boolean, ctx: ExtensionContext) => {
    const loaded = await load(ctx, name);
    if (!loaded.config) { notify(ctx, `Profile "${name}" blocked: ${loaded.diagnostics.map(({ code }) => code).join(", ") || "invalid configuration"}.`, "warning"); return false; }
    if (save) {
      const saved = await persistUserProfileSelection({ path: loaded.paths.user, profile: name });
      if (!saved.ok) { notify(ctx, `Profile "${name}" was not activated: ${saved.error}.`, "warning"); return false; }
    }
    sessionProfile = name;
    pi.appendEntry(IMA_PROFILE_ENTRY, { profile: name });
    notify(ctx, `IMA profile "${name}" activated.\n${formatPhaseMatrix(loaded.config)}`, "info");
    return true;
  };

  pi.registerCommand("ima:profile", {
    description: "Show or activate an IMA phase model profile.",
    handler: async (args, ctx) => {
      const parsed = parseProfileCommand(args);
      if (parsed.mode === "invalid") { notify(ctx, parsed.error, "warning"); return; }
      if (parsed.mode === "activate") { await activate(parsed.name, parsed.save, ctx); return; }
      const [profiles, loaded] = await Promise.all([showProfiles(ctx), load(ctx)]);
      if (profiles.diagnostics.length) { notify(ctx, `IMA profile discovery blocked: ${profiles.diagnostics.map(({ code }) => code).join(", ")}.`, "warning"); return; }
      const listing = formatProfileList(profiles.profiles, sessionProfile ?? loaded.config?.profile ?? null);
      if (!ctx.hasUI) { notify(ctx, listing, "info"); return; }
      const choice = await ctx.ui.select("Select IMA profile", profiles.profiles.map((profile) => `${profile.name}${profile.name === (sessionProfile ?? loaded.config?.profile) ? " (active)" : ""}`));
      if (!choice) { notify(ctx, listing, "info"); return; }
      await activate(choice.replace(/ \(active\)$/, ""), false, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionProfile = latestSessionProfile(ctx.sessionManager.getBranch());
    const loaded = await load(ctx);
    if (!loaded.config && loaded.diagnostics.length) notify(ctx, `IMA phase profiles unavailable: ${loaded.diagnostics.map(({ code }) => code).join(", ")}.`, "warning");
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
    const result = await applyPhaseRoute(loaded.config, parsed.phase, {
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
    if (!result.ok) {
      notify(ctx, `/${parsed.command} blocked: ${result.message}`, "warning");
      return { action: "handled" as const };
    }
    if (ctx.hasUI) ctx.ui.setStatus("ima-phase-route", `${parsed.phase}: ${result.route.provider}/${result.route.model}`);
    return { action: "continue" as const };
  });
}
