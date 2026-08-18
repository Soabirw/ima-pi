import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { callMcpTool } from "../lib/ima-mcp-client.ts";

const clientPath = pathToFileURL(resolve("lib/ima-mcp-client.ts")).href;
const integrationsPath = pathToFileURL(resolve("extensions/integrations.ts")).href;

const toolServer = `
  import { Server } from "@modelcontextprotocol/sdk/server/index.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

  const server = new Server(
    { name: "ima-pi-test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        secret: process.env.IMA_PI_MCP_TEST_SECRET ?? null,
        hasHome: Boolean(process.env.HOME),
        hasPath: Boolean(process.env.PATH),
      }),
    }],
  }));
  await server.connect(new StdioServerTransport());
`;

const runNode = (script) => new Promise((resolveProcess, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (status) => resolveProcess({ status, stdout, stderr }));
});

test("MCP child receives the SDK safe environment and serves a tool", async () => {
  const sentinel = "ima-pi-parent-secret";
  const previous = process.env.IMA_PI_MCP_TEST_SECRET;
  process.env.IMA_PI_MCP_TEST_SECRET = sentinel;

  try {
    const result = await callMcpTool({
      command: "node",
      args: ["--input-type=module", "--eval", toolServer],
      name: "inspect-environment",
      arguments: {},
      timeoutMs: 5_000,
    });
    const observation = JSON.parse(result.content[0].text);

    assert.equal(observation.secret, null);
    assert.equal(observation.hasHome, true);
    assert.equal(observation.hasPath, true);
  } finally {
    if (previous === undefined) delete process.env.IMA_PI_MCP_TEST_SECRET;
    else process.env.IMA_PI_MCP_TEST_SECRET = previous;
  }
});

test("child stderr remains hidden behind the lifecycle error boundary", async () => {
  const sentinel = "ima-pi-child-stderr-secret";
  const script = `
    import { coordinateLifecycle } from ${JSON.stringify(integrationsPath)};
    import { callMcpTool } from ${JSON.stringify(clientPath)};

    const result = await coordinateLifecycle(
      {
        type: "implementation",
        identity: {
          project: "ima-pi",
          lifecycleKey: "ima-pi:test:child-stderr",
          lifecycleRootMemoryId: "",
          taskwarriorProject: "",
          taskwarriorTask: "",
          taskwarriorUuid: "",
          jiraKey: "",
          sourceRefs: [],
          priorArtifactIds: [],
        },
        artifact: "stderr boundary test",
      },
      {
        vestige: () => callMcpTool({
          command: process.execPath,
          args: ["--input-type=module", "--eval", ${JSON.stringify(`process.stderr.write(${JSON.stringify(sentinel)}); process.exit(1);`)}],
          name: "smart_ingest",
          arguments: {},
          timeoutMs: 5_000,
        }),
      },
    );
    process.stdout.write(JSON.stringify(result));
  `;
  const result = await runNode(script);

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  assert.doesNotMatch(result.stdout, new RegExp(sentinel));
  assert.equal(JSON.parse(result.stdout).error.code, "vestige_save_failed");
});
