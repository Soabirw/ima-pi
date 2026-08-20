import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import agentsExtension from "../extensions/agents.ts";
import {
  buildAgentCatalogPrompt,
  deriveAgentPaths,
  IMA_AGENT_CATALOG_EMPTY,
  IMA_AGENT_CATALOG_UNAVAILABLE,
  loadAgentDefinitions,
} from "../lib/ima-agents.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const definition = (overrides = {}) => ({
  schemaVersion: 1,
  name: "zeta",
  description: "Visible description",
  useWhen: ["Use zeta for bounded work."],
  tier: "MID",
  authority: "read",
  tools: ["read"],
  skills: [],
  delegation: { allowed: false, maxDepth: 0 },
  independence: { freshInitial: false, followUpAllowed: true },
  result: { kind: "evidence", requiredSections: ["findings"] },
  escalation: ["missing-evidence"],
  prompt: "PROMPT_SECRET must not reach the catalog.",
  source: "package",
  path: "/private/agent.md",
  ...overrides,
});

const loadPackageAgents = () => loadAgentDefinitions({
  paths: deriveAgentPaths({
    packageRoot,
    agentDir: resolve(packageRoot, ".missing-agent-home"),
    cwd: packageRoot,
  }),
  projectTrusted: false,
});

const registerExtension = () => {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  agentsExtension({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (event, handler) => handlers.set(event, handler),
  });
  return { tools, commands, handlers };
};

test("formats a deterministic safe catalog with applicable delegation guidance", () => {
  const catalog = buildAgentCatalogPrompt({
    definitions: [
      definition(),
      definition({
        name: "alpha",
        tier: "LOW",
        authority: "write",
        useWhen: ["Use alpha for an approved implementation."],
      }),
    ],
    diagnostics: [],
  });

  assert.ok(catalog.indexOf("- alpha") < catalog.indexOf("- zeta"));
  assert.match(catalog, /alpha \(LOW, write\): Use alpha for an approved implementation\./);
  assert.match(catalog, /opportunistically/);
  assert.match(catalog, /explicitly asks to use a named agent/);
  assert.match(catalog, /If no agent fits, do not delegate/);
  assert.match(catalog, /exact, disjoint write scopes/);
  assert.match(catalog, /Children cannot delegate/);
  assert.match(catalog, /Do not newly delegate `reviewer` for rereview or verified-finding follow-up/);
  assert.doesNotMatch(catalog, /PROMPT_SECRET|private\/agent/);
});

test("renders each validated agent on one line without Unicode line boundaries", async () => {
  const loaded = await loadPackageAgents();
  const catalog = buildAgentCatalogPrompt(loaded);
  const rows = catalog.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(rows.length, loaded.definitions.length);
  for (const separator of ["\u0085", "\u2028", "\u2029"]) assert.equal(catalog.includes(separator), false);
});

test("fails closed when agent definitions have diagnostics or no agents", () => {
  const agents = [definition({ name: "alpha" })];
  assert.equal(buildAgentCatalogPrompt({ definitions: agents, diagnostics: [{ code: "invalid" }] }), IMA_AGENT_CATALOG_UNAVAILABLE);
  assert.equal(buildAgentCatalogPrompt({ definitions: [], diagnostics: [] }), IMA_AGENT_CATALOG_EMPTY);
});

test("registers agent guidance and injects a catalog only while ima_delegate is active", async () => {
  const { tools, handlers } = registerExtension();
  const delegate = tools.get("ima_delegate");
  assert.equal(delegate.promptSnippet, "Delegate one to four bounded assignments to an applicable IMA agent.");
  assert.equal(delegate.promptGuidelines.length, 2);
  assert.ok(delegate.promptGuidelines.every((guideline) => guideline.includes("ima_delegate")));
  assert.match(delegate.promptGuidelines.join("\n"), /rereview.*existing reviewer continuation/i);

  const beforeAgentStart = handlers.get("before_agent_start");
  const basePrompt = "Earlier chained extension prompt.";
  const inactive = await beforeAgentStart({
    systemPrompt: basePrompt,
    systemPromptOptions: { cwd: packageRoot, selectedTools: ["read"] },
  }, { isProjectTrusted: () => false });
  assert.equal(inactive, undefined);

  const injected = await beforeAgentStart({
    systemPrompt: basePrompt,
    systemPromptOptions: { cwd: packageRoot, selectedTools: ["read", "ima_delegate"] },
  }, { isProjectTrusted: () => false });
  assert.equal(injected.systemPrompt.startsWith(`${basePrompt}\n\n## IMA delegation catalog`), true);

  const loaded = await loadPackageAgents();
  for (const agent of loaded.definitions) {
    const row = `- ${agent.name} (${agent.tier}, ${agent.authority}): ${agent.useWhen.join("; ")}`;
    assert.ok(injected.systemPrompt.includes(row), row);
  }
});

test("appends only the sanitized unavailable notice when catalog loading fails", async () => {
  const { handlers } = registerExtension();
  const beforeAgentStart = handlers.get("before_agent_start");
  const result = await beforeAgentStart({
    systemPrompt: "Earlier chained extension prompt.",
    systemPromptOptions: { selectedTools: ["ima_delegate"] },
  }, {});

  assert.equal(
    result.systemPrompt,
    `Earlier chained extension prompt.\n\n${IMA_AGENT_CATALOG_UNAVAILABLE}`,
  );
});
