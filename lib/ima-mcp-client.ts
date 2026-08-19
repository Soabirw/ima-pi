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

const clientInfo = { name: "ima-pi", version: "1.9.0" };

export async function withMcpSession<Result>(
  server: McpServer,
  callback: (call: McpToolCaller) => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const client = new Client(clientInfo);

  try {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      stderr: "ignore",
    });

    await client.connect(transport, { signal });
    return await callback((name, arguments_, timeoutMs) => client.callTool(
      { name, arguments: arguments_ },
      undefined,
      { timeout: timeoutMs, signal },
    ));
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
