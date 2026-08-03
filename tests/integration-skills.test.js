import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const skills = ["mcp-serena", "mcp-vestige", "mcp-qdrant", "mcp-atlassian", "mcp-taskwarrior", "mcp-context7", "mcp-tavily", "mcp-fetch", "mcp-sequential-thinking", "mcp-chrome-devtools"];
const assets = ["skills/mcp-serena/scripts/migrate-context-to-serena.py", "skills/mcp-atlassian/scripts/atlassian-api.mjs", "skills/mcp-taskwarrior/agents/openai.yaml"];
const read = (path) => readFile(join(root, path), "utf8");
const localMarkdownTargets = (content) => [...content.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]*)?\)/g)].map((match) => match[1]);

test("integration skills and support assets are packaged", async () => {
  await Promise.all(assets.map((path) => access(join(root, path))));
  for (const name of skills) {
    const content = await read("skills/" + name + "/SKILL.md");
    assert.match(content, new RegExp("^---\\nname: ?[\"']?" + name + "[\"']?", "m"));
    assert.match(content, /^description:\s*\S/m);
    assert.doesNotMatch(content, /Goose TypeScript SDK|Context7\.|Tavily\.|Fetch\.fetch|SequentialThinking\.|ChromeDevtools\./);
  }
});

test("integration skill local Markdown links resolve within packaged assets", async () => {
  for (const name of skills) {
    const file = "skills/" + name + "/SKILL.md";
    await Promise.all(localMarkdownTargets(await read(file)).map((target) => access(resolve(root, dirname(file), target))));
  }
});

test("integration skills retain Pi-native safety and workflow boundaries", async () => {
  assert.match(await read("skills/mcp-serena/SKILL.md"), /activate.*initial_instructions.*list memories/is);
  assert.match(await read("skills/mcp-serena/SKILL.md"), /JetBrains/i);
  assert.match(await read("skills/mcp-vestige/SKILL.md"), /session_start.*recall/is);
  assert.match(await read("skills/mcp-vestige/SKILL.md"), /receipt protocol/i);
  assert.match(await read("skills/mcp-qdrant/SKILL.md"), /durable/i);
  assert.match(await read("skills/mcp-atlassian/SKILL.md"), /REST helper/i);
  assert.match(await read("skills/mcp-taskwarrior/SKILL.md"), /project plus UUID/i);
  assert.match(await read("skills/mcp-context7/SKILL.md"), /resolve.*library ID.*query/is);
  assert.match(await read("skills/mcp-tavily/SKILL.md"), /source attribution/i);
  assert.match(await read("skills/mcp-fetch/SKILL.md"), /exact URL/i);
  assert.match(await read("skills/mcp-sequential-thinking/SKILL.md"), /branching/i);
  assert.match(await read("skills/mcp-chrome-devtools/SKILL.md"), /latest accessibility snapshot/i);
});
