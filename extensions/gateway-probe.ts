/** FNR-3011 technical spike: Pi child access to external IMA gateways. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  mcpResultData,
  recallVestige,
  withConfiguredMcpSession,
  type McpSession,
} from "./integrations.ts";
import type {
  McpPolicyOperation,
  createMcpChildRuntime as CreateMcpChildRuntime,
} from "./mcp.ts";

type McpChildRuntime = Awaited<ReturnType<typeof CreateMcpChildRuntime>>;

export const STORY = "FNR-3011";
export const SCHEMA_VERSION = 1;
export const RESULT_ENV_VAR = "IMA_PI_GATEWAY_RESULT";
export const LIFECYCLE_KEY = "ima-pi:taskwarrior:FNR-3007:4baa9fce-919a-44d4-a476-fb82efe50f3e";
export const JIRA_KEY = "FNR-3011";
export const USAGE = "usage: /ima:gateway-probe <provider>/<model>";
export const CHILD_TIMEOUT_MS = 60_000;
export const MCP_TIMEOUT_MS = 300_000;
export const QDRANT_PROBE_QUERY = "ima-pi gateway probe";
export const CHILD_EXECUTION_TIMEOUT = Symbol("child_execution_timeout");
const CHILD_TOOLS = ["mcp"] as const;

type Service = "serena" | "vestige" | "qdrant-memory" | "unknown";
type Operation =
  | "activate_project"
  | "get_current_config"
  | "memory_status"
  | "qdrant_find"
  | "smart_ingest"
  | "unknown";

type GatewayContext = {
  repoPath: string;
  payload: string;
};

export type GatewayOperation = {
  server: Exclude<Service, "unknown">;
  serverTool: string;
  compactTool: string;
  args: Record<string, unknown>;
  operation: Exclude<Operation, "unknown">;
  mutation: boolean;
};

type GatewayResultKind = "direct" | "compact";
type GatewayResultIdentity = {
  server: Exclude<Service, "unknown">;
  tool: string;
};
type ObservedMcpResult = {
  result: unknown;
  isError: boolean;
};

export interface GatewayCheck {
  service: Exclude<Service, "unknown">;
  operation: string;
  passed: boolean;
  errorCode: string | null;
}

export interface ObservedCommand {
  service: Service;
  operation: Operation;
  mutation: boolean;
}

export interface ModelIdentity {
  provider: string;
  model: string;
}

export interface GatewayProbeResult {
  schemaVersion: 1;
  story: "FNR-3011";
  status: "passed" | "failed";
  requestedChild: ModelIdentity;
  actualChild: ModelIdentity | null;
  parent: {
    serenaActivate: GatewayCheck;
    serenaConfig: GatewayCheck;
    vestige: GatewayCheck;
    qdrant: GatewayCheck;
  };
  child: {
    serenaActivate: GatewayCheck;
    serenaConfig: GatewayCheck;
    vestigeRead: GatewayCheck;
    qdrant: GatewayCheck;
    vestigeIngest: GatewayCheck;
  };
  semanticCompletion: {
    ingestAccepted: boolean;
    recallMatched: boolean;
    lifecycleKeyMatched: boolean;
    jiraKeyMatched: boolean;
    nonceMatched: boolean;
    outcomeMatched: boolean;
    physicalShapeIgnored: true;
  };
  observedCommands: ObservedCommand[];
  error: { code: string; message: string } | null;
}

type Selector =
  | { valid: true; provider: string; model: string }
  | { valid: false; error: string };

export function parseModelSelector(input: unknown): Selector {
  if (typeof input !== "string") {
    return { valid: false, error: "selector must be a string" };
  }
  const value = input.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return { valid: false, error: "selector must be <provider>/<model>" };
  }
  const provider = value.slice(0, slash).trim();
  const model = value.slice(slash + 1).trim();
  return provider && model
    ? { valid: true, provider, model }
    : { valid: false, error: "selector must be <provider>/<model>" };
}

export function parseGatewayProbeArgs(input: unknown):
  | { provider: string; model: string }
  | { error: "invalid_arguments"; message: string } {
  const parts = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : [];
  if (parts.length !== 1) {
    return { error: "invalid_arguments", message: USAGE };
  }
  const selector = parseModelSelector(parts[0]);
  return selector.valid
    ? { provider: selector.provider, model: selector.model }
    : { error: "invalid_arguments", message: USAGE };
}

export function modelIdentity(
  model: { provider?: unknown; id?: unknown } | null | undefined,
): ModelIdentity | null {
  return model && typeof model.provider === "string" && typeof model.id === "string"
    ? { provider: model.provider, model: model.id }
    : null;
}

export function buildLifecyclePayload(input: {
  lifecycleKey: string;
  jiraKey: string;
  nonce: string;
}): string {
  return `FNR-3011 implementation-probe completed external Serena, Vestige, and Qdrant gateway workflow attempts. lifecycle_key=${input.lifecycleKey}; jira_key=${input.jiraKey}; run_nonce=${input.nonce}; outcome=completed. Serena and Qdrant remain external read-only services; this is a semantic lifecycle update, not a required memory shape.`;
}

export const childOperations = (input: GatewayContext): GatewayOperation[] => [
  {
    server: "serena",
    serverTool: "activate_project",
    compactTool: "serena_activate_project",
    args: { project: input.repoPath },
    operation: "activate_project",
    mutation: false,
  },
  {
    server: "serena",
    serverTool: "get_current_config",
    compactTool: "serena_get_current_config",
    args: {},
    operation: "get_current_config",
    mutation: false,
  },
  {
    server: "vestige",
    serverTool: "memory_status",
    compactTool: "vestige_memory_status",
    args: { view: "health" },
    operation: "memory_status",
    mutation: false,
  },
  {
    server: "qdrant-memory",
    serverTool: "qdrant_find",
    compactTool: "qdrant_memory_qdrant_find",
    args: { query: QDRANT_PROBE_QUERY, limit: 1 },
    operation: "qdrant_find",
    mutation: false,
  },
  {
    server: "vestige",
    serverTool: "smart_ingest",
    compactTool: "vestige_smart_ingest",
    args: {
      content: input.payload,
      node_type: "event",
      tags: [STORY, "gateway-probe"],
    },
    operation: "smart_ingest",
    mutation: true,
  },
];

export function buildChildBrief(input: GatewayContext): string {
  const operations = childOperations(input);
  return [
    "You are the bounded FNR-3011 gateway-probe child.",
    "Run exactly these five compact mcp calls in order, then stop:",
    ...operations.map((operation, index) =>
      `${index + 1}. mcp({"server":"${operation.server}","tool":"${operation.compactTool}","args":${JSON.stringify(operation.args)}})`,
    ),
    "",
    "Boundaries: use only mcp; do not modify the repository; do not run shell commands, URLs, or destructive actions; do not alter arguments; and do not access services or paths outside the listed calls. If a call fails, stop rather than substituting an action.",
  ].join("\n");
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export function classifyGatewayCommand(
  event: { toolName?: unknown; args?: unknown; input?: unknown },
  context: GatewayContext,
): ObservedCommand {
  if (event.toolName !== "mcp") {
    return { service: "unknown", operation: "unknown", mutation: false };
  }

  const input = object(event.args ?? event.input);
  const server = input?.server;
  const tool = input?.tool;
  const args = input?.args;
  const operation = childOperations(context).find((candidate) =>
    candidate.server === server
    && candidate.compactTool === tool
    && isDeepStrictEqual(candidate.args, args),
  );
  return operation
    ? {
      service: operation.server,
      operation: operation.operation,
      mutation: operation.mutation,
    }
    : { service: "unknown", operation: "unknown", mutation: false };
}

const hasTextContent = (value: unknown) => Array.isArray(value)
  && value.some((content) => {
    const item = object(content);
    return item?.type === "text"
      && typeof item.text === "string"
      && item.text.trim().length > 0;
  });

const hasStructuredContent = (value: unknown) => {
  const content = object(value);
  return content !== null && Object.keys(content).length > 0;
};

const validMcpResultShape = (value: unknown) => {
  const result = object(value);
  return result !== null
    && result.isError !== true
    && (hasTextContent(result.content) || hasStructuredContent(result.structuredContent));
};

export function validateGatewayResult(input: {
  service: Exclude<Service, "unknown">;
  operation: string;
  kind: GatewayResultKind;
  expected: GatewayResultIdentity;
  result: unknown;
  isError?: boolean;
}): GatewayCheck {
  const result = object(input.result);
  const details = object(result?.details);
  const compactIdentityMatches = details?.mode === "call"
    && details.server === input.expected.server
    && details.tool === input.expected.tool
    && details.error === undefined;
  const passed = input.isError !== true
    && validMcpResultShape(input.result)
    && (input.kind === "direct" || compactIdentityMatches);
  return {
    service: input.service,
    operation: input.operation,
    passed,
    errorCode: passed ? null : `${input.service}_${input.operation}_failed`,
  };
}

export function evaluateObservedWorkflow(events: ObservedCommand[]): {
  passed: boolean;
  errorCode: string | null;
} {
  const expected: ObservedCommand[] = [
    { service: "serena", operation: "activate_project", mutation: false },
    { service: "serena", operation: "get_current_config", mutation: false },
    { service: "vestige", operation: "memory_status", mutation: false },
    { service: "qdrant-memory", operation: "qdrant_find", mutation: false },
    { service: "vestige", operation: "smart_ingest", mutation: true },
  ];
  const passed = events.length === expected.length
    && events.every((event, index) => isDeepStrictEqual(event, expected[index]));
  return { passed, errorCode: passed ? null : "unexpected_child_command" };
}

const MAX_CONTENT_VALUES = 64;
const MAX_CONTENT_LENGTH = 8_192;

function contentStrings(value: unknown, collected: string[] = []): string[] {
  if (collected.length >= MAX_CONTENT_VALUES) return collected;
  if (typeof value === "string") {
    collected.push(value.slice(0, MAX_CONTENT_LENGTH));
    return collected;
  }
  if (Array.isArray(value)) {
    for (const item of value) contentStrings(item, collected);
    return collected;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) contentStrings(item, collected);
  }
  return collected;
}

export function evaluateSemanticCompletion(input: {
  ingestResult: unknown;
  ingestIsError?: boolean;
  recalledMemories: unknown;
  lifecycleKey: string;
  jiraKey: string;
  nonce: string;
}) {
  const ingest = validateGatewayResult({
    service: "vestige",
    operation: "smart_ingest",
    kind: "compact",
    expected: { server: "vestige", tool: "smart_ingest" },
    result: input.ingestResult,
    isError: input.ingestIsError,
  });
  const data = mcpResultData(input.recalledMemories);
  const nested = object(data?.data);
  const results = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(nested?.results)
      ? nested.results
      : [];
  const matches = results.map((result) => {
    const text = contentStrings(result).join("\n");
    return {
      lifecycleKeyMatched: text.includes(input.lifecycleKey),
      jiraKeyMatched: text.includes(input.jiraKey),
      nonceMatched: text.includes(input.nonce),
      outcomeMatched: /\b(completed|success)\b/i.test(text),
    };
  });
  const matched = matches.find((match) =>
    match.lifecycleKeyMatched
    && match.jiraKeyMatched
    && match.nonceMatched
    && match.outcomeMatched,
  );
  const lifecycleKeyMatched = matched?.lifecycleKeyMatched ?? false;
  const jiraKeyMatched = matched?.jiraKeyMatched ?? false;
  const nonceMatched = matched?.nonceMatched ?? false;
  const outcomeMatched = matched?.outcomeMatched ?? false;
  const recallMatched = Boolean(matched);
  return {
    ingestAccepted: ingest.passed,
    recallMatched,
    lifecycleKeyMatched,
    jiraKeyMatched,
    nonceMatched,
    outcomeMatched,
    physicalShapeIgnored: true as const,
    passed: ingest.passed && recallMatched,
  };
}

export function sanitizeGatewayError(
  code: string,
  _error: unknown,
): { code: string; message: string } {
  return { code, message: `Gateway probe failed: ${code}.` };
}

export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(CHILD_EXECUTION_TIMEOUT), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function childExecutionErrorCode(
  error: unknown,
): "child_execution_timeout" | "child_execution_failed" {
  return error === CHILD_EXECUTION_TIMEOUT
    ? "child_execution_timeout"
    : "child_execution_failed";
}

const failedCheck = (
  service: Exclude<Service, "unknown">,
  operation: string,
  code: string,
): GatewayCheck => ({ service, operation, passed: false, errorCode: code });

export function deriveGatewayProbeResult(
  input: Omit<GatewayProbeResult, "status" | "error">,
): GatewayProbeResult {
  const checks = [...Object.values(input.parent), ...Object.values(input.child)];
  const identity = input.actualChild?.provider === input.requestedChild.provider
    && input.actualChild?.model === input.requestedChild.model;
  const workflow = evaluateObservedWorkflow(input.observedCommands).passed;
  const passed = checks.every((check) => check.passed)
    && identity
    && workflow
    && input.semanticCompletion.ingestAccepted
    && input.semanticCompletion.recallMatched;
  return {
    ...input,
    status: passed ? "passed" : "failed",
    error: passed
      ? null
      : sanitizeGatewayError(
        !workflow
          ? "unexpected_child_command"
          : !identity
            ? "child_execution_failed"
            : "semantic_completion_unverified",
        "",
      ),
  };
}

const operationKey = (operation: ObservedCommand) =>
  `${operation.service}:${operation.operation}`;

const childResult = (
  results: Map<string, ObservedMcpResult>,
  service: Exclude<Service, "unknown">,
  operation: Exclude<Operation, "unknown">,
  serverTool: string,
) => {
  const observed = results.get(`${service}:${operation}`);
  return validateGatewayResult({
    service,
    operation,
    kind: "compact",
    expected: { server: service, tool: serverTool },
    result: observed?.result,
    isError: observed?.isError,
  });
};

export async function runParentCheck(
  operation: GatewayOperation,
  session: McpSession = withConfiguredMcpSession,
): Promise<GatewayCheck> {
  const result = await session(
    operation.server,
    (call) => call(operation.serverTool, operation.args, MCP_TIMEOUT_MS),
  );
  return validateGatewayResult({
    service: operation.server,
    operation: operation.operation,
    kind: "direct",
    expected: { server: operation.server, tool: operation.serverTool },
    result,
  });
}

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

async function runGatewayProbe(input: {
  provider: string;
  model: string;
}): Promise<GatewayProbeResult> {
  const requestedChild = { provider: input.provider, model: input.model };
  const parentOperations = childOperations({
    repoPath: repoRoot,
    payload: "",
  }).slice(0, 4);
  const [serenaActivate, serenaConfig, vestige, qdrant] = await Promise.all(
    parentOperations.map(runParentCheck),
  );
  const parent = { serenaActivate, serenaConfig, vestige, qdrant };
  const blank = (): GatewayProbeResult => deriveGatewayProbeResult({
    schemaVersion: 1,
    story: STORY,
    requestedChild,
    actualChild: null,
    parent,
    child: {
      serenaActivate: failedCheck("serena", "activate_project", "not_run"),
      serenaConfig: failedCheck("serena", "get_current_config", "not_run"),
      vestigeRead: failedCheck("vestige", "memory_status", "not_run"),
      qdrant: failedCheck("qdrant-memory", "qdrant_find", "not_run"),
      vestigeIngest: failedCheck("vestige", "smart_ingest", "not_run"),
    },
    semanticCompletion: {
      ingestAccepted: false,
      recallMatched: false,
      lifecycleKeyMatched: false,
      jiraKeyMatched: false,
      nonceMatched: false,
      outcomeMatched: false,
      physicalShapeIgnored: true,
    },
    observedCommands: [],
  });
  if (!Object.values(parent).every((check) => check.passed)) {
    const errorCode = !parent.serenaActivate.passed || !parent.serenaConfig.passed
      ? "parent_serena_failed"
      : !parent.vestige.passed
        ? "parent_vestige_failed"
        : "parent_qdrant_failed";
    return { ...blank(), error: sanitizeGatewayError(errorCode, "") };
  }

  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(input.provider, input.model);
  if (!model) {
    return { ...blank(), error: sanitizeGatewayError("child_model_not_found", "") };
  }
  if (!modelRuntime.hasConfiguredAuth(input.provider)) {
    return { ...blank(), error: sanitizeGatewayError("child_model_unauthenticated", "") };
  }

  const workspace = await mkdtemp(join(tmpdir(), "ima-pi-gateway-"));
  const sessionDirectory = join(workspace, "sessions");
  await mkdir(sessionDirectory);
  const nonce = randomUUID();
  const payload = buildLifecyclePayload({
    lifecycleKey: LIFECYCLE_KEY,
    jiraKey: JIRA_KEY,
    nonce,
  });
  const context = { repoPath: repoRoot, payload };
  const mcpPolicy: McpPolicyOperation[] = childOperations(context).map(
    ({ server, compactTool, args }) => ({
      server,
      tool: compactTool,
      args,
    }),
  );
  const observedCommands: ObservedCommand[] = [];
  const observedByCallId = new Map<string, ObservedCommand>();
  const resultsByOperation = new Map<string, ObservedMcpResult>();
  let childRuntime: McpChildRuntime | undefined;
  let toolError = false;
  let outcome: GatewayProbeResult = blank();

  try {
    const { createMcpChildRuntime } = await import("./mcp.ts");
    const runtime = await createMcpChildRuntime({
      cwd: workspace,
      model,
      modelRuntime,
      tools: CHILD_TOOLS,
      sessionManager: SessionManager.create(workspace, sessionDirectory),
      mcpPolicy,
    });
    childRuntime = runtime;
    const session = runtime.session;
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const observed = classifyGatewayCommand(event, context);
        observedCommands.push(observed);
        observedByCallId.set(event.toolCallId, observed);
      }
      if (event.type === "tool_execution_end") {
        if (event.isError) toolError = true;
        const observed = observedByCallId.get(event.toolCallId);
        if (observed && observed.service !== "unknown") {
          resultsByOperation.set(operationKey(observed), {
            result: event.result,
            isError: event.isError,
          });
        }
      }
    });

    await withDeadline(
      Promise.all([
        session.prompt(buildChildBrief(context)),
        session.waitForIdle(),
      ]),
      CHILD_TIMEOUT_MS,
    );
    const child = {
      serenaActivate: childResult(resultsByOperation, "serena", "activate_project", "activate_project"),
      serenaConfig: childResult(resultsByOperation, "serena", "get_current_config", "get_current_config"),
      vestigeRead: childResult(resultsByOperation, "vestige", "memory_status", "memory_status"),
      qdrant: childResult(resultsByOperation, "qdrant-memory", "qdrant_find", "qdrant_find"),
      vestigeIngest: childResult(resultsByOperation, "vestige", "smart_ingest", "smart_ingest"),
    };
    const ingest = resultsByOperation.get("vestige:smart_ingest");
    const recalled = await recallVestige(`${LIFECYCLE_KEY} ${nonce}`);
    const semantic = evaluateSemanticCompletion({
      ingestResult: ingest?.result,
      ingestIsError: ingest?.isError,
      recalledMemories: recalled,
      lifecycleKey: LIFECYCLE_KEY,
      jiraKey: JIRA_KEY,
      nonce,
    });
    const result = deriveGatewayProbeResult({
      schemaVersion: 1,
      story: STORY,
      requestedChild,
      actualChild: modelIdentity(session.model),
      parent,
      child,
      semanticCompletion: semantic,
      observedCommands,
    });
    outcome = toolError && result.status === "passed"
      ? {
        ...result,
        status: "failed",
        error: sanitizeGatewayError("child_execution_failed", ""),
      }
      : result;
  } catch (error) {
    outcome = {
      ...blank(),
      error: sanitizeGatewayError(childExecutionErrorCode(error), error),
    };
  }

  try {
    await childRuntime?.dispose();
  } catch {
    return {
      ...outcome,
      status: "failed",
      error: sanitizeGatewayError("child_cleanup_failed", ""),
    };
  }
  return outcome;
}

export default function gatewayProbe(pi: ExtensionAPI) {
  pi.registerCommand("ima:gateway-probe", {
    description: "Prove parent/child IMA gateway and semantic lifecycle integration (FNR-3011)",
    handler: async (args, ctx) => {
      const parsed = parseGatewayProbeArgs(args);
      if ("error" in parsed) {
        if (ctx.hasUI) ctx.ui.notify(parsed.message, "warning");
        return;
      }

      let result = await runGatewayProbe(parsed);
      const output = process.env[RESULT_ENV_VAR];
      if (output && isAbsolute(output)) {
        try {
          await writeFile(output, JSON.stringify(result, null, 2));
        } catch {
          result = {
            ...result,
            status: "failed",
            error: sanitizeGatewayError("result_write_failed", ""),
          };
        }
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          result.status === "passed"
            ? "Gateway probe passed."
            : `Gateway probe failed: ${result.error?.code ?? "unknown"}.`,
          result.status === "passed" ? "info" : "warning",
        );
      }
    },
  });
}
