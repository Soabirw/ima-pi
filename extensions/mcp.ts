import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSerenaMcpSession } from "../lib/serena-mcp-session.ts";
import { withConfiguredMcpSession } from "./integrations.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_POLICY_BLOCK_REASON = "MCP operation is not authorized for this child.";
const SERENA_BOOTSTRAP_TIMEOUT_MS = 300_000;
export const SERENA_BOOTSTRAP_TOOL = "ima_serena_bootstrap";

export const configuredMcpAdapter = async (pi: ExtensionAPI) => {
  const { createMcpAdapter } = await import("pi-mcp-adapter");
  return createMcpAdapter({
    configPath: join(packageRoot, "config", "mcp.json"),
  })(pi);
};

export type McpPolicyOperation = Readonly<{
  server: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
}>;

type McpPolicyState = Readonly<{
  operations: readonly McpPolicyOperation[];
  nextIndex: number;
}>;

type McpPolicyDecision = Readonly<{
  allowed: boolean;
  state: McpPolicyState;
}>;

type McpChildModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

type McpChildRuntimeInput = {
  cwd: string;
  model: McpChildModel;
  modelRuntime: ModelRuntime;
  tools: readonly string[];
  sessionManager: SessionManager;
  mcpPolicy?: readonly McpPolicyOperation[];
  serenaBootstrapProject?: string;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const validMcpPolicyOperation = (operation: unknown): operation is McpPolicyOperation => {
  const value = object(operation);
  return Boolean(
    value
    && typeof value.server === "string"
    && value.server.length > 0
    && typeof value.tool === "string"
    && value.tool.length > 0
    && object(value.args),
  );
};

const ownDataRecord = (value: unknown): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 16 || keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value");
    })) return null;
    return Object.fromEntries(keys.map((key) => [key, descriptors[key as string].value]));
  } catch {
    return null;
  }
};

const safeSerenaBootstrapProject = (value: unknown): string | null =>
  typeof value === "string"
  && value.length > 0
  && value.length <= 4_096
  && isAbsolute(value)
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  && !value.includes("//")
  && !value.split("/").some((segment) => segment === "." || segment === "..")
    ? value
    : null;

const textToolResponse = (value: unknown): string | null => {
  const response = ownDataRecord(value);
  if (
    !response
    || response.isError === true
    || (Object.hasOwn(response, "isError") && response.isError !== false)
    || !Array.isArray(response.content)
    || response.content.length !== 1
  ) return null;
  const block = ownDataRecord(response.content[0]);
  return block && block.type === "text" && typeof block.text === "string" && block.text.length <= 300_000
    ? block.text
    : null;
};

const activationReceiptFor = (value: unknown, project: string): boolean => {
  const text = textToolResponse(value);
  if (text === null) return false;
  const firstLine = text.split("\n", 1)[0];
  const escapedProject = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^The project with name '[^'\\r\\n]+' at ${escapedProject} is activated\\.$`)
    .test(firstLine);
};

export const runSerenaBootstrap = async (
  project: unknown,
  signal?: AbortSignal,
): Promise<boolean> => {
  const expectedProject = safeSerenaBootstrapProject(project);
  if (!expectedProject || signal?.aborted) return false;

  try {
    const completed = await withConfiguredMcpSession("serena", async (call, listTools) => {
      if (!listTools) return false;
      let advertisedTools: unknown;
      try {
        advertisedTools = await listTools(SERENA_BOOTSTRAP_TIMEOUT_MS);
      } catch {
        return false;
      }
      if (signal?.aborted) return false;

      const created = createSerenaMcpSession({
        call,
        advertisedTools,
        initialization: listTools.initialization,
      });
      if (!created.success || !created.capabilities.contextSupported) return false;

      const prepared = await created.session.prepare(SERENA_BOOTSTRAP_TIMEOUT_MS, signal);
      if (!prepared.success || signal?.aborted) return false;

      let response: unknown;
      try {
        response = await created.session.activateProject(
          expectedProject,
          SERENA_BOOTSTRAP_TIMEOUT_MS,
          signal,
        );
      } catch {
        return false;
      }
      if (signal?.aborted || !activationReceiptFor(response, expectedProject)) return false;
      if (prepared.instructionsLoaded) return true;

      try {
        response = await created.session.initialInstructions(
          SERENA_BOOTSTRAP_TIMEOUT_MS,
          signal,
        );
      } catch {
        return false;
      }
      return !signal?.aborted && textToolResponse(response) !== null;
    }, signal);
    return completed === true;
  } catch {
    return false;
  }
};

const serenaBootstrapExtension = (project: string) => ({
  name: "ima-serena-bootstrap",
  factory: (pi: ExtensionAPI) => {
    pi.registerTool({
      name: SERENA_BOOTSTRAP_TOOL,
      label: "IMA Serena bootstrap",
      description: "Run the package-owned Serena bootstrap for the fixed delegated checkout.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_toolCallId, _params, signal) => {
        if (!await runSerenaBootstrap(project, signal)) {
          throw new Error("serena_bootstrap_failed");
        }
        return {
          content: [{ type: "text" as const, text: "Serena bootstrap completed." }],
          details: { status: "completed" },
        };
      },
    });
  },
});

const cloneMcpPolicyOperation = (operation: McpPolicyOperation): McpPolicyOperation => ({
  server: operation.server,
  tool: operation.tool,
  args: structuredClone(operation.args),
});

export function createMcpPolicyState(
  operations: readonly McpPolicyOperation[],
): McpPolicyState {
  if (
    !Array.isArray(operations)
    || operations.length === 0
    || !operations.every(validMcpPolicyOperation)
  ) {
    throw new Error("mcp_policy_invalid");
  }
  return {
    operations: operations.map(cloneMcpPolicyOperation),
    nextIndex: 0,
  };
}

const isExactMcpPolicyCall = (
  input: unknown,
  operation: McpPolicyOperation,
) => {
  const call = object(input);
  if (!call) return false;
  const keys = Object.keys(call);
  if (
    keys.length !== 3
    || !keys.includes("server")
    || !keys.includes("tool")
    || !keys.includes("args")
  ) {
    return false;
  }
  return call.server === operation.server
    && call.tool === operation.tool
    && isDeepStrictEqual(call.args, operation.args);
};

export function authorizeMcpPolicyCall(
  state: McpPolicyState,
  input: unknown,
): McpPolicyDecision {
  const expected = state.operations[state.nextIndex];
  if (!expected || !isExactMcpPolicyCall(input, expected)) {
    return { allowed: false, state };
  }
  return {
    allowed: true,
    state: { ...state, nextIndex: state.nextIndex + 1 },
  };
}

const mcpPolicyExtension = (initialState: McpPolicyState) => ({
  name: "mcp-child-policy",
  factory: (pi: ExtensionAPI) => {
    let state = initialState;
    pi.on("tool_call", (event) => {
      if (event.toolName !== "mcp") return;
      const decision = authorizeMcpPolicyCall(state, event.input);
      state = decision.state;
      return decision.allowed
        ? undefined
        : { block: true, reason: MCP_POLICY_BLOCK_REASON };
    });
  },
});

export async function createMcpChildRuntime(input: McpChildRuntimeInput) {
  const mcpEnabled = input.tools.includes("mcp");
  const serenaBootstrapEnabled = input.tools.includes(SERENA_BOOTSTRAP_TOOL);
  const serenaBootstrapProject = serenaBootstrapEnabled
    ? safeSerenaBootstrapProject(input.serenaBootstrapProject)
    : null;
  if (mcpEnabled && input.mcpPolicy === undefined) {
    throw new Error("mcp_policy_required");
  }
  if (!mcpEnabled && input.mcpPolicy !== undefined) {
    throw new Error("mcp_policy_without_tool");
  }
  if (serenaBootstrapEnabled && !serenaBootstrapProject) {
    throw new Error("serena_bootstrap_project_required");
  }
  if (!serenaBootstrapEnabled && input.serenaBootstrapProject !== undefined) {
    throw new Error("serena_bootstrap_without_tool");
  }

  const policy = mcpEnabled
    ? createMcpPolicyState(input.mcpPolicy ?? [])
    : null;
  const settingsManager = SettingsManager.inMemory();
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime: input.modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [
          ...(policy ? [mcpPolicyExtension(policy)] : []),
          ...(serenaBootstrapProject ? [serenaBootstrapExtension(serenaBootstrapProject)] : []),
          ...(mcpEnabled ? [{ name: "mcp", factory: configuredMcpAdapter }] : []),
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    const session = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: input.model,
      tools: [...input.tools],
    });

    return { ...session, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: input.cwd,
    agentDir: getAgentDir(),
    sessionManager: input.sessionManager,
  });

  try {
    await runtime.session.bindExtensions({ mode: "print" });
    return runtime;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export default configuredMcpAdapter;
