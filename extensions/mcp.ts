import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
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

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_POLICY_BLOCK_REASON = "MCP operation is not authorized for this child.";

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
  if (mcpEnabled && input.mcpPolicy === undefined) {
    throw new Error("mcp_policy_required");
  }
  if (!mcpEnabled && input.mcpPolicy !== undefined) {
    throw new Error("mcp_policy_without_tool");
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
          { name: "mcp", factory: configuredMcpAdapter },
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
