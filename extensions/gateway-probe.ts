/** FNR-3011 technical spike: Pi child access to external IMA gateways. */
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);
export const STORY = "FNR-3011";
export const SCHEMA_VERSION = 1;
export const RESULT_ENV_VAR = "IMA_PI_GATEWAY_RESULT";
export const LIFECYCLE_KEY = "ima-pi:taskwarrior:FNR-3007:4baa9fce-919a-44d4-a476-fb82efe50f3e";
export const JIRA_KEY = "FNR-3011";
export const USAGE = "usage: /ima:gateway-probe <provider>/<model>";
export const CHILD_TIMEOUT_MS = 60_000;
export const CHILD_EXECUTION_TIMEOUT = Symbol("child_execution_timeout");
const CHILD_TOOLS = ["bash"] as const;

type Service = "serena" | "vestige" | "qdrant" | "unknown";
type Operation = "status" | "smart_ingest" | "unknown";
export interface GatewayCheck { service: Exclude<Service, "unknown">; operation: string; passed: boolean; errorCode: string | null; }
export interface ObservedCommand { service: Service; operation: Operation; mutation: boolean; }
export interface ModelIdentity { provider: string; model: string; }
export interface GatewayProbeResult {
  schemaVersion: 1; story: "FNR-3011"; status: "passed" | "failed";
  requestedChild: ModelIdentity; actualChild: ModelIdentity | null;
  parent: { serena: GatewayCheck; vestige: GatewayCheck; qdrant: GatewayCheck };
  child: { serena: GatewayCheck; vestigeRead: GatewayCheck; vestigeIngest: GatewayCheck; qdrant: GatewayCheck };
  semanticCompletion: { ingestAccepted: boolean; recallMatched: boolean; lifecycleKeyMatched: boolean; jiraKeyMatched: boolean; nonceMatched: boolean; outcomeMatched: boolean; physicalShapeIgnored: true; };
  observedCommands: ObservedCommand[]; error: { code: string; message: string } | null;
}

type Selector = { valid: true; provider: string; model: string } | { valid: false; error: string };
export function parseModelSelector(input: unknown): Selector {
  if (typeof input !== "string") return { valid: false, error: "selector must be a string" };
  const value = input.trim(); const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { valid: false, error: "selector must be <provider>/<model>" };
  const provider = value.slice(0, slash).trim(); const model = value.slice(slash + 1).trim();
  return provider && model ? { valid: true, provider, model } : { valid: false, error: "selector must be <provider>/<model>" };
}
export function parseGatewayProbeArgs(input: unknown): { provider: string; model: string } | { error: "invalid_arguments"; message: string } {
  const parts = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : [];
  if (parts.length !== 1) return { error: "invalid_arguments", message: USAGE };
  const selector = parseModelSelector(parts[0]);
  return selector.valid ? { provider: selector.provider, model: selector.model } : { error: "invalid_arguments", message: USAGE };
}
export function modelIdentity(model: { provider?: unknown; id?: unknown } | null | undefined): ModelIdentity | null {
  return model && typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, model: model.id } : null;
}
export function buildLifecyclePayload(input: { lifecycleKey: string; jiraKey: string; nonce: string }): string {
  return `FNR-3011 implementation-probe completed external Serena, Vestige, and Qdrant gateway workflow attempts. lifecycle_key=${input.lifecycleKey}; jira_key=${input.jiraKey}; run_nonce=${input.nonce}; outcome=completed. Serena and Qdrant remain external read-only services; this is a semantic lifecycle update, not a required memory shape.`;
}
export function buildChildBrief(input: { repoPath: string; workspace: string; payload: string }): string {
  const commands = childCommands(input);
  return [
    "You are the bounded FNR-3011 gateway-probe child.", "Run exactly these four bash commands in order, then stop:",
    ...commands.map((command, index) => `${index + 1}. ${command}`), "",
    "Boundaries: use only bash; do not modify the repository; do not run extra commands, URLs, or destructive commands; do not alter payloads; do not access paths outside the listed workspace artifacts. If a command fails, stop rather than substituting an action.",
  ].join("\n");
}
function childCommands(input: { repoPath: string; workspace: string; payload: string }): string[] {
  const output = (name: string) => join(input.workspace, name);
  const args = JSON.stringify({ content: input.payload, node_type: "event", tags: [STORY, "gateway-probe"] });
  return [
    `ima-mcp serena project status --project ${input.repoPath} --json > ${output("child-serena.json")}`,
    `ima-mcp vestige status --json > ${output("child-vestige.json")}`,
    `ima-mcp qdrant status --json > ${output("child-qdrant.json")}`,
    `ima-mcp vestige smart_ingest --args-json '${args}' --allow-write --json > ${output("child-ingest.json")}`,
  ];
}
export function classifyGatewayCommand(event: { toolName?: unknown; args?: { command?: unknown }; input?: { command?: unknown } }, context: { repoPath: string; workspace: string; payload: string }): ObservedCommand {
  const command = typeof (event.args ?? event.input)?.command === "string" ? (event.args ?? event.input)?.command : "";
  const commands = childCommands(context);
  const index = commands.indexOf(command as string);
  if (event.toolName !== "bash" || index < 0) return { service: "unknown", operation: "unknown", mutation: false };
  return index === 0 ? { service: "serena", operation: "status", mutation: false }
    : index === 1 ? { service: "vestige", operation: "status", mutation: false }
    : index === 2 ? { service: "qdrant", operation: "status", mutation: false }
    : { service: "vestige", operation: "smart_ingest", mutation: true };
}
function parseEnvelope(input: unknown): Record<string, unknown> | null {
  if (typeof input === "string") { try { return JSON.parse(input) as Record<string, unknown>; } catch { return null; } }
  return input && typeof input === "object" ? input as Record<string, unknown> : null;
}
export function validateGatewayEnvelope(input: { service: Exclude<Service, "unknown">; operation: string; envelope: unknown }): GatewayCheck {
  const envelope = parseEnvelope(input.envelope); const command = typeof envelope?.command === "string" ? envelope.command : "";
  const diagnostics = Array.isArray(envelope?.diagnostics) ? envelope.diagnostics : [];
  const diagnosticError = diagnostics.some((item) => item && typeof item === "object" && (item as { severity?: unknown }).severity === "error");
  const expected = input.service === "serena" && input.operation === "status" ? "serena.project.status" : `${input.service}.${input.operation}`;
  const ingestProcessed = input.operation !== "smart_ingest" || Boolean(envelope?.data ?? envelope?.result);
  const passed = Boolean(envelope?.ok === true && command === expected && !envelope?.error && !diagnosticError && ingestProcessed);
  return { service: input.service, operation: input.operation, passed, errorCode: passed ? null : `${input.service}_${input.operation}_failed` };
}
export function evaluateObservedWorkflow(events: ObservedCommand[]): { passed: boolean; errorCode: string | null } {
  const expected: ObservedCommand[] = [
    { service: "serena", operation: "status", mutation: false }, { service: "vestige", operation: "status", mutation: false },
    { service: "qdrant", operation: "status", mutation: false }, { service: "vestige", operation: "smart_ingest", mutation: true },
  ];
  const passed = events.length === expected.length && events.every((event, index) => JSON.stringify(event) === JSON.stringify(expected[index]));
  return { passed, errorCode: passed ? null : "unexpected_child_command" };
}
function contentStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(contentStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(contentStrings);
  return [];
}
export function evaluateSemanticCompletion(input: { ingestEnvelope: unknown; recalledMemories: unknown; lifecycleKey: string; jiraKey: string; nonce: string }) {
  const ingest = validateGatewayEnvelope({ service: "vestige", operation: "smart_ingest", envelope: input.ingestEnvelope });
  const results = input.recalledMemories && typeof input.recalledMemories === "object" && Array.isArray((input.recalledMemories as { data?: { results?: unknown } }).data?.results)
    ? (input.recalledMemories as { data: { results: unknown[] } }).data.results
    : [];
  const matches = results.map((result) => {
    const text = contentStrings(result).join("\n");
    return { lifecycleKeyMatched: text.includes(input.lifecycleKey), jiraKeyMatched: text.includes(input.jiraKey), nonceMatched: text.includes(input.nonce), outcomeMatched: /\b(completed|success)\b/i.test(text) };
  });
  const matched = matches.find((match) => match.lifecycleKeyMatched && match.jiraKeyMatched && match.nonceMatched && match.outcomeMatched);
  const lifecycleKeyMatched = matched?.lifecycleKeyMatched ?? false; const jiraKeyMatched = matched?.jiraKeyMatched ?? false; const nonceMatched = matched?.nonceMatched ?? false; const outcomeMatched = matched?.outcomeMatched ?? false;
  const recallMatched = Boolean(matched);
  return { ingestAccepted: ingest.passed, recallMatched, lifecycleKeyMatched, jiraKeyMatched, nonceMatched, outcomeMatched, physicalShapeIgnored: true as const, passed: ingest.passed && recallMatched };
}
export function sanitizeGatewayError(code: string, _error: unknown): { code: string; message: string } { return { code, message: `Gateway probe failed: ${code}.` }; }
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(CHILD_EXECUTION_TIMEOUT), timeoutMs); });
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}
export function childExecutionErrorCode(error: unknown): "child_execution_timeout" | "child_execution_failed" {
  return error === CHILD_EXECUTION_TIMEOUT ? "child_execution_timeout" : "child_execution_failed";
}
const failedCheck = (service: Exclude<Service, "unknown">, operation: string, code: string): GatewayCheck => ({ service, operation, passed: false, errorCode: code });
export function deriveGatewayProbeResult(input: Omit<GatewayProbeResult, "status" | "error">): GatewayProbeResult {
  const checks = [...Object.values(input.parent), ...Object.values(input.child)];
  const identity = input.actualChild?.provider === input.requestedChild.provider && input.actualChild?.model === input.requestedChild.model;
  const workflow = evaluateObservedWorkflow(input.observedCommands).passed;
  const passed = checks.every((check) => check.passed) && identity && workflow && input.semanticCompletion.ingestAccepted && input.semanticCompletion.recallMatched;
  return { ...input, status: passed ? "passed" : "failed", error: passed ? null : sanitizeGatewayError(!workflow ? "unexpected_child_command" : !identity ? "child_execution_failed" : "semantic_completion_unverified", "") };
}
async function runGateway(args: string[]): Promise<unknown> {
  try { const { stdout } = await execFile("ima-mcp", args, { timeout: 30_000, maxBuffer: 128 * 1024 }); return JSON.parse(stdout); } catch { return null; }
}
async function readEnvelope(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
async function runGatewayProbe(input: { provider: string; model: string }): Promise<GatewayProbeResult> {
  const requestedChild = { provider: input.provider, model: input.model };
  const parentEnvelopes = await Promise.all([
    runGateway(["serena", "project", "status", "--project", repoRoot, "--json"]), runGateway(["vestige", "status", "--json"]), runGateway(["qdrant", "status", "--json"]),
  ]);
  const parent = { serena: validateGatewayEnvelope({ service: "serena", operation: "status", envelope: parentEnvelopes[0] }), vestige: validateGatewayEnvelope({ service: "vestige", operation: "status", envelope: parentEnvelopes[1] }), qdrant: validateGatewayEnvelope({ service: "qdrant", operation: "status", envelope: parentEnvelopes[2] }) };
  const blank = (): GatewayProbeResult => deriveGatewayProbeResult({ schemaVersion: 1, story: STORY, requestedChild, actualChild: null, parent, child: { serena: failedCheck("serena", "status", "not_run"), vestigeRead: failedCheck("vestige", "status", "not_run"), vestigeIngest: failedCheck("vestige", "smart_ingest", "not_run"), qdrant: failedCheck("qdrant", "status", "not_run") }, semanticCompletion: { ingestAccepted: false, recallMatched: false, lifecycleKeyMatched: false, jiraKeyMatched: false, nonceMatched: false, outcomeMatched: false, physicalShapeIgnored: true }, observedCommands: [] });
  if (!Object.values(parent).every((check) => check.passed)) return { ...blank(), error: sanitizeGatewayError(!parent.serena.passed ? "parent_serena_failed" : !parent.vestige.passed ? "parent_vestige_failed" : "parent_qdrant_failed", "") };
  const runtime = await ModelRuntime.create(); const model = runtime.getModel(input.provider, input.model);
  if (!model) return { ...blank(), error: sanitizeGatewayError("child_model_not_found", "") };
  if (!runtime.hasConfiguredAuth(input.provider)) return { ...blank(), error: sanitizeGatewayError("child_model_unauthenticated", "") };
  const workspace = await mkdtemp(join(tmpdir(), "ima-pi-gateway-")); await mkdir(join(workspace, "sessions"));
  const nonce = randomUUID(); const payload = buildLifecyclePayload({ lifecycleKey: LIFECYCLE_KEY, jiraKey: JIRA_KEY, nonce });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined; const observedCommands: ObservedCommand[] = []; let toolError = false;
  try {
    ({ session } = await createAgentSession({ cwd: workspace, model, modelRuntime: runtime, tools: [...CHILD_TOOLS], sessionManager: SessionManager.create(workspace, join(workspace, "sessions")) }));
    const context = { repoPath: repoRoot, workspace, payload };
    session.subscribe((event) => { if (event.type === "tool_execution_start") observedCommands.push(classifyGatewayCommand(event, context)); if (event.type === "tool_execution_end" && event.isError) toolError = true; });
    await withDeadline(Promise.all([session.prompt(buildChildBrief(context)), session.waitForIdle()]), CHILD_TIMEOUT_MS);
    const [serenaEnvelope, vestigeEnvelope, qdrantEnvelope, ingestEnvelope] = await Promise.all(["child-serena.json", "child-vestige.json", "child-qdrant.json", "child-ingest.json"].map((name) => readEnvelope(join(workspace, name))));
    const child = { serena: validateGatewayEnvelope({ service: "serena", operation: "status", envelope: serenaEnvelope }), vestigeRead: validateGatewayEnvelope({ service: "vestige", operation: "status", envelope: vestigeEnvelope }), qdrant: validateGatewayEnvelope({ service: "qdrant", operation: "status", envelope: qdrantEnvelope }), vestigeIngest: validateGatewayEnvelope({ service: "vestige", operation: "smart_ingest", envelope: ingestEnvelope }) };
    const recalled = await runGateway(["vestige", "search", `${LIFECYCLE_KEY} ${nonce}`, "--json"]);
    const semantic = evaluateSemanticCompletion({ ingestEnvelope, recalledMemories: recalled, lifecycleKey: LIFECYCLE_KEY, jiraKey: JIRA_KEY, nonce });
    const result = deriveGatewayProbeResult({ schemaVersion: 1, story: STORY, requestedChild, actualChild: modelIdentity(session.model), parent, child, semanticCompletion: semantic, observedCommands });
    return toolError && result.status === "passed" ? { ...result, status: "failed", error: sanitizeGatewayError("child_execution_failed", "") } : result;
  } catch (error) { return { ...blank(), error: sanitizeGatewayError(childExecutionErrorCode(error), error) }; } finally { session?.dispose(); }
}
export default function gatewayProbe(pi: ExtensionAPI) {
  pi.registerCommand("ima:gateway-probe", { description: "Prove parent/child IMA gateway and semantic lifecycle integration (FNR-3011)", handler: async (args, ctx) => {
    const parsed = parseGatewayProbeArgs(args);
    if ("error" in parsed) {
      if (ctx.hasUI) ctx.ui.notify(parsed.message, "warning");
      return;
    }
    let result = await runGatewayProbe(parsed);
    const output = process.env[RESULT_ENV_VAR]; if (output && isAbsolute(output)) { try { await writeFile(output, JSON.stringify(result, null, 2)); } catch { result = { ...result, status: "failed", error: sanitizeGatewayError("result_write_failed", "") }; } }
    if (ctx.hasUI) ctx.ui.notify(result.status === "passed" ? "Gateway probe passed." : `Gateway probe failed: ${result.error?.code ?? "unknown"}.`, result.status === "passed" ? "info" : "warning");
  } });
}
