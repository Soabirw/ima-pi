type McpToolCall = {
  command: string;
  args: string[];
  name: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
};

const clientInfo = { name: "ima-pi", version: "1.9.0" };

export async function callMcpTool(input: McpToolCall): Promise<unknown> {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const client = new Client(clientInfo);

  try {
    const transport = new StdioClientTransport({
      command: input.command,
      args: input.args,
      stderr: "ignore",
    });

    await client.connect(transport);
    return await client.callTool(
      { name: input.name, arguments: input.arguments },
      undefined,
      { timeout: input.timeoutMs },
    );
  } finally {
    await client.close();
  }
}
