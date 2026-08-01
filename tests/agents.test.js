import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAgentPaths, loadAgentDefinitions, parseAgentDocument, resolveAgentDefinitions, validateAgentDefinition } from "../lib/ima-agents.ts";

const document = (name = "explore", extra = "") => `---
schemaVersion: 1
name: ${name}
description: Explore safely
tier: LOW
authority: read
tools: [read, grep]
skills: [mcp-serena]
delegation: { allowed: false, maxDepth: 0 }
independence: { freshInitial: false, followUpAllowed: true }
result: { kind: evidence, requiredSections: [findings] }
escalation: [missing-evidence]
${extra}---

Evidence.`;

test("parses a constrained agent document and rejects missing or unknown schema", () => {
  const parsed = parseAgentDocument({ path: "/agents/explore.md", source: "package", content: document() });
  assert.equal(parsed.diagnostics.length, 0); assert.equal(parsed.definition.name, "explore");
  assert.equal(parseAgentDocument({ path: "/agents/x.md", source: "package", content: "prompt" }).diagnostics[0].code, "agent_frontmatter_missing");
  assert.equal(parseAgentDocument({ path: "/agents/explore.md", source: "package", content: document("explore", "surprise: true\n") }).diagnostics[0].code, "agent_unknown_key");
});

test("validates authority invariants and deterministic full replacement", () => {
  const invalid = validateAgentDefinition({ path: "/agents/reviewer.md", source: "package", prompt: "x", metadata: { schemaVersion: 1, name: "reviewer", description: "r", tier: "HIGH", authority: "review-read", tools: ["write"], skills: ["x"], delegation: { allowed: false, maxDepth: 0 }, independence: { freshInitial: true, followUpAllowed: true }, result: { kind: "review", requiredSections: ["findings"] }, escalation: ["x"] } });
  assert.ok(invalid.diagnostics.some(({ code }) => code === "agent_authority_tools_conflict"));
  const packageAgent = parseAgentDocument({ path: "/package/explore.md", source: "package", content: document() }).definition;
  const userAgent = { ...packageAgent, source: "user", path: "/user/explore.md", description: "User replacement" };
  const resolved = resolveAgentDefinitions({ packageAgents: [packageAgent], userAgents: [userAgent], projectAgents: [] });
  assert.deepEqual(resolved.definitions.map(({ name, source, description }) => ({ name, source, description })), [{ name: "explore", source: "user", description: "User replacement" }]);
});

test("loads the packaged agent catalog without treating README.md as an agent", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = await loadAgentDefinitions({
    paths: deriveAgentPaths({ packageRoot, agentDir: resolve(packageRoot, ".missing-agent-home"), cwd: packageRoot }),
    projectTrusted: false,
  });
  assert.deepEqual(loaded.definitions.map(({ name }) => name), ["explore", "implementer", "js-developer", "reviewer", "tester", "vision-handoff", "wordpress-developer"]);
  assert.deepEqual(loaded.diagnostics, []);
});

test("derives package, user, and project agent paths", () => {
  assert.deepEqual(deriveAgentPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" }), { packageAgents: "/package/agents", userAgents: "/agent/ima/agents", projectAgents: "/project/.pi/ima/agents" });
});
