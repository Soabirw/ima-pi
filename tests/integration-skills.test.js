import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const skills = ["mcp-serena", "mcp-vestige", "ima-qdrant", "mcp-atlassian", "mcp-taskwarrior", "mcp-context7", "mcp-tavily", "mcp-fetch", "mcp-sequential-thinking", "mcp-chrome-devtools"];
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
  const vestige = await read("skills/mcp-vestige/SKILL.md");
  assert.match(vestige, /session_start.*recall/is);
  assert.match(vestige, /focused\s+topic.*mode:\s*"lookup".*retrieval_mode:\s*"precise".*detail_level:\s*"brief".*concrete:\s*true.*limit:\s*10.*token_budget:\s*1000/is);
  assert.match(vestige, /selected full memory only when the summary is insufficient[\s\S]*vestige_memory.*action:\s*"get".*id/i);
  assert.match(vestige, /preference load/i);
  assert.match(vestige, /Do not use Vestige for lifecycle persistence.*lifecycle recall.*per-node lifecycle reads/is);
  assert.match(vestige, /mcp\(\{ connect: "vestige" \}\)/);
  assert.match(vestige, /same read.*identical arguments.*exactly once/is);
  assert.match(vestige, /Never retry.*smart_ingest.*mutation/is);
  assert.match(vestige, /current invocation.*unrelated merged/is);
  assert.match(vestige, /Stop after an adequate summary/i);
  assert.match(vestige, /Retrieve one selected full memory only when the summary is insufficient for preference relevance or summarization/i);
  assert.match(vestige, /partial\s+or failed evidence rather than guessing/i);
  assert.match(vestige, /\/ima:memorize/);
  assert.match(vestige, /Qdrant manifest plus verified detail chunks/i);
  assert.match(vestige, /no Vestige\s+fallback/i);
  const qdrant = await read("skills/ima-qdrant/SKILL.md");
  assert.match(qdrant, /package-native/i);
  assert.match(qdrant, /ima_corpus_status/);
  assert.match(qdrant, /never add.*qdrant-memory/is);
  assert.match(qdrant, /schema-v2.*vectorless detail chunks/is);
  assert.match(await read("skills/mcp-atlassian/SKILL.md"), /REST helper/i);
  assert.match(await read("skills/mcp-taskwarrior/SKILL.md"), /project plus UUID/i);
  assert.match(await read("skills/mcp-context7/SKILL.md"), /resolve.*library ID.*query/is);
  assert.match(await read("skills/mcp-tavily/SKILL.md"), /source attribution/i);
  assert.match(await read("skills/mcp-fetch/SKILL.md"), /exact URL/i);
  assert.match(await read("skills/mcp-sequential-thinking/SKILL.md"), /branching/i);
  assert.match(await read("skills/mcp-chrome-devtools/SKILL.md"), /latest accessibility snapshot/i);
});
