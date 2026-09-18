type McpServer = {
  command: string;
  args: string[];
};

type McpToolCall = McpServer & {
  name: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type McpToolCaller = (
  name: string,
  arguments_: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;

export type McpToolDiscovery = ((timeoutMs: number) => Promise<unknown>) & {
  readonly initialization?: unknown;
};

const clientInfo = { name: "ima-pi", version: "1.9.0" };

export async function withMcpSession<Result>(
  server: McpServer,
  callback: (call: McpToolCaller, listTools: McpToolDiscovery) => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const client = new Client(clientInfo);
  let initialization: unknown;
  const requestClient = client as unknown as {
    request: (...arguments_: unknown[]) => Promise<unknown>;
  };
  const request = requestClient.request.bind(client);
  requestClient.request = async (...arguments_) => {
    const result = await request(...arguments_);
    const requestBody = arguments_[0];
    if (
      requestBody
      && typeof requestBody === "object"
      && !Array.isArray(requestBody)
      && Object.hasOwn(requestBody, "method")
      && (requestBody as { method?: unknown }).method === "initialize"
    ) initialization = result;
    return result;
  };

  try {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      stderr: "ignore",
    });

    await client.connect(transport, { signal });
    const listTools = ((timeoutMs: number) => client.listTools(
      undefined,
      { timeout: timeoutMs, signal },
    )) as McpToolDiscovery;
    Object.defineProperty(listTools, "initialization", {
      value: initialization,
      enumerable: false,
      writable: false,
    });
    return await callback(
      (name, arguments_, timeoutMs) => client.callTool(
        { name, arguments: arguments_ },
        undefined,
        { timeout: timeoutMs, signal },
      ),
      listTools,
    );
  } finally {
    await client.close();
  }
}

export async function callMcpTool(input: McpToolCall): Promise<unknown> {
  return withMcpSession(
    { command: input.command, args: input.args },
    (call) => call(input.name, input.arguments, input.timeoutMs),
    input.signal,
  );
}
