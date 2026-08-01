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
  assert.deepEqual(loaded.definitions.map(({ name }) => name), ["adversary-a", "adversary-b", "documenter", "explore", "implementer", "js-developer", "review-verifier", "reviewer", "tester", "vision-handoff", "wordpress-developer"]);
  assert.deepEqual(loaded.diagnostics, []);
});

test("derives package, user, and project agent paths", () => {
  assert.deepEqual(deriveAgentPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" }), { packageAgents: "/package/agents", userAgents: "/agent/ima/agents", projectAgents: "/project/.pi/ima/agents" });
});

test("implementation specialist agent documents preserve plan, verification, and security contracts", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = await loadAgentDefinitions({ paths: deriveAgentPaths({ packageRoot, agentDir: resolve(packageRoot, ".missing-agent-home"), cwd: packageRoot }), projectTrusted: false });
  const byName = new Map(loaded.definitions.map((definition) => [definition.name, definition]));
  for (const name of ["implementer", "js-developer", "wordpress-developer"]) {
    const definition = byName.get(name);
    assert.equal(definition.tier, "MID");
    assert.equal(definition.authority, "write");
    assert.deepEqual(definition.result.requiredSections, ["changed-files", "verification", "blockers"]);
    assert.match(definition.prompt, /approved.*plan|plan.*approved/i);
    assert.match(definition.prompt, /Serena.*evidence/i);
    assert.match(definition.prompt, /verification/i);
  }
  assert.match(byName.get("js-developer").prompt, /parameterized SQL/i);
  assert.match(byName.get("wordpress-developer").prompt, /nonce.*capability|capability.*nonce/i);
  assert.match(byName.get("wordpress-developer").prompt, /sanitize.*escape.*prepared/i);
});


test("quality agents enforce fresh verification and exact documentation authority", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = await loadAgentDefinitions({ paths: deriveAgentPaths({ packageRoot, agentDir: resolve(packageRoot, ".missing-agent-home"), cwd: packageRoot }), projectTrusted: false });
  const byName = new Map(loaded.definitions.map((definition) => [definition.name, definition]));
  assert.equal(byName.get("review-verifier").tier, "reviewVerify");
  assert.equal(byName.get("review-verifier").independence.freshInitial, true);
  assert.equal(byName.get("review-verifier").authority, "review-read");
  assert.equal(byName.get("documenter").authority, "document-write");
  assert.equal(byName.get("documenter").result.kind, "documentation");
});


test("adversaries require fresh, distinct, read-only review contracts", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = await loadAgentDefinitions({ paths: deriveAgentPaths({ packageRoot, agentDir: resolve(packageRoot, ".missing-agent-home"), cwd: packageRoot }), projectTrusted: false });
  const byName = new Map(loaded.definitions.map((definition) => [definition.name, definition]));
  for (const [name, tier] of [["adversary-a", "adversaryA"], ["adversary-b", "adversaryB"]]) {
    const definition = byName.get(name);
    assert.equal(definition.tier, tier); assert.equal(definition.authority, "review-read");
    assert.deepEqual(definition.tools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(definition.delegation, { allowed: false, maxDepth: 0 });
    assert.deepEqual(definition.independence, { freshInitial: true, followUpAllowed: false });
    assert.deepEqual(definition.result.requiredSections, ["model-route", "verdict", "findings", "disproof-attempts", "confidence"]);
    assert.doesNotMatch(definition.prompt, /Claude|OpenAI|Opus|GPT/i);
  }
  assert.match(byName.get("adversary-a").prompt, /integration|state-transition/i);
  assert.match(byName.get("adversary-b").prompt, /boundary|invariant/i);
});
