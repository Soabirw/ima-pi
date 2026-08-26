import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const run = promisify(execFile);
const expected = ["serena", "vestige", "context7", "tavily", "fetch", "sequential-thinking", "chrome-devtools"];

test("MCP package composition has an exact pinned adapter and approved catalog", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["pi-mcp-adapter"], "2.17.0");
  const extension = await readFile(join(root, "extensions/mcp.ts"), "utf8");
  assert.match(extension, /createMcpAdapter/);
  assert.match(extension, /configPath/);
  const config = JSON.parse(await readFile(join(root, "config/mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(config.mcpServers), expected);
  assert.deepEqual(config.mcpServers.serena, {
    command: "uvx",
    args: ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server", "--context=desktop-app", "--language-backend", "JetBrains", "--project-from-cwd"],
  });
  assert.deepEqual(config.mcpServers.vestige, { command: "vestige-mcp" });
  assert.equal("qdrant-memory" in config.mcpServers, false);
  assert.deepEqual(config.mcpServers.context7, { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] });
  assert.deepEqual(config.mcpServers.tavily, {
    command: "npx",
    args: ["-y", "tavily-mcp@latest"],
    env: { TAVILY_API_KEY: "$" + "{TAVILY_API_KEY}" },
  });
  assert.deepEqual(config.mcpServers.fetch, { command: "uvx", args: ["--with", "mcp<2", "mcp-server-fetch"] });
  assert.deepEqual(config.mcpServers["sequential-thinking"], { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking@latest"] });
  assert.deepEqual(config.mcpServers["chrome-devtools"], { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] });
  assert.equal("atlassian" in config.mcpServers, false);
  assert.equal("taskwarrior" in config.mcpServers, false);
  assert.doesNotMatch(JSON.stringify(config), /(sk-|ghp_|Bearer\s+[A-Za-z0-9])/i);
});

test("skill installer validates and synchronizes an isolated destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-pi-skills-"));
  await mkdir(join(directory, "unrelated"));
  await writeFile(join(directory, "unrelated", "keep.txt"), "keep");
  await run(process.execPath, ["scripts/install.ts", "--validate"], { cwd: root });
  await run(process.execPath, ["scripts/install.ts", "--dest", directory], { cwd: root });
  assert.equal(await readFile(join(directory, "unrelated", "keep.txt"), "utf8"), "keep");
  assert.match(await readFile(join(directory, "mcp-serena", "SKILL.md"), "utf8"), /name: mcp-serena/);
  await writeFile(join(directory, "mcp-serena", "stale.txt"), "stale");
  await run(process.execPath, ["scripts/install.ts", "--dest", directory], { cwd: root });
  await assert.rejects(readFile(join(directory, "mcp-serena", "stale.txt"), "utf8"));
  await assert.rejects(run(process.execPath, ["scripts/install.ts", "--dest", "/"], { cwd: root }));
  await assert.rejects(run(process.execPath, ["scripts/install.ts", "--dest", join(root, "skills")], { cwd: root }));

  const aliasParent = await mkdtemp(join(tmpdir(), "ima-pi-skills-alias-"));
  const alias = join(aliasParent, "skills");
  const sentinel = join(root, "skills", ".installer-sentinel");
  await writeFile(sentinel, "unchanged");
  await symlink(join(root, "skills"), alias);
  try {
    await assert.rejects(run(process.execPath, ["scripts/install.ts", "--dest", alias], { cwd: root }));
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  } finally {
    await rm(sentinel, { force: true });
  }
});

test("MCP installation documentation has a verified remote team command", async () => {
  const remote = "pi install ssh://git@gitea.theflccc.org:2222/IMA/ima-pi.git";
  const [readme, foundation] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "docs", "foundation", "FNR-3032.md"), "utf8"),
  ]);
  assert.match(readme, new RegExp(remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(foundation, new RegExp(remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(readme, /For local development only, run `pi install \/home\/eric\/IMA\/dev\/ima-pi`/);
  assert.match(foundation, /### Local development/);
});
