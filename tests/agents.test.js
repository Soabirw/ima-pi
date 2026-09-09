import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveAgentPaths,
  IMA_AGENT_USE_WHEN_MAX_LENGTH,
  loadAgentDefinitions,
  parseAgentDocument,
  resolveAgentDefinitions,
  validateAgentDefinition,
} from "../lib/ima-agents.ts";
import { validateDelegationCompletion, validateDelegationRequest } from "../lib/ima-delegation.ts";

const document = (name = "explore", extra = "") => `---
schemaVersion: 1
name: ${name}
description: Explore safely
useWhen: [Explore safely]
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

test("shares the per-agent route name syntax with resolved definitions", () => {
  const digitPrefixed = parseAgentDocument({
    path: "/agents/1-reviewer.md",
    source: "package",
    content: document("1-reviewer"),
  });
  assert.ok(digitPrefixed.diagnostics.some(({ code }) => code === "agent_name_invalid"));

  const numericSuffix = parseAgentDocument({
    path: "/agents/reviewer-2.md",
    source: "package",
    content: document("reviewer-2"),
  });
  assert.equal(numericSuffix.diagnostics.length, 0);
  assert.equal(numericSuffix.definition.name, "reviewer-2");
});

test("requires bounded package applicability and normalizes legacy custom applicability", () => {
  const base = {
    schemaVersion: 1,
    name: "explore",
    description: "Explore safely",
    tier: "LOW",
    authority: "read",
    tools: ["read", "grep"],
    skills: ["mcp-serena"],
    delegation: { allowed: false, maxDepth: 0 },
    independence: { freshInitial: false, followUpAllowed: true },
    result: { kind: "evidence", requiredSections: ["findings"] },
    escalation: ["missing-evidence"],
  };
  const parse = (source, useWhen) => validateAgentDefinition({
    path: "/agents/explore.md",
    source,
    prompt: "Evidence.",
    metadata: useWhen === undefined ? base : { ...base, useWhen },
  });

  assert.ok(parse("package").diagnostics.some(({ code }) => code === "agent_use_when_invalid"));
  assert.deepEqual(parse("user").definition.useWhen, ["Explore safely"]);
  assert.deepEqual(parse("project").definition.useWhen, ["Explore safely"]);
  for (const separator of ["\u0085", "\u2028", "\u2029"]) {
    for (const source of ["user", "project"]) {
      const legacy = validateAgentDefinition({
        path: "/agents/explore.md",
        source,
        prompt: "Evidence.",
        metadata: { ...base, description: `Explore${separator}safely` },
      });
      assert.deepEqual(legacy.definition.useWhen, ["Explore safely"]);
    }
  }
  for (const useWhen of [[], [""], ["one", "two", "three", "four"], ["multiple\nlines"], ["control\u0000character"], ["control\u0085character"], ["control\u2028character"], ["control\u2029character"], ["x".repeat(IMA_AGENT_USE_WHEN_MAX_LENGTH + 1)], [42]]) {
    assert.ok(parse("package", useWhen).diagnostics.some(({ code }) => code === "agent_use_when_invalid"));
  }
});

test("validates authority invariants and deterministic full replacement", () => {
  const invalid = validateAgentDefinition({ path: "/agents/reviewer.md", source: "package", prompt: "x", metadata: { schemaVersion: 1, name: "reviewer", description: "r", tier: "HIGH", authority: "review-read", tools: ["write"], skills: ["x"], delegation: { allowed: false, maxDepth: 0 }, independence: { freshInitial: true, followUpAllowed: true }, result: { kind: "review", requiredSections: ["findings"] }, escalation: ["x"] } });
  assert.ok(invalid.diagnostics.some(({ code }) => code === "agent_authority_tools_conflict"));
  const invalidPhase = validateAgentDefinition({ path: "/agents/explore.md", source: "package", prompt: "x", metadata: { schemaVersion: 1, name: "explore", description: "r", tier: "LOW", phase: "unknown", authority: "read", tools: ["read"], skills: ["x"], delegation: { allowed: false, maxDepth: 0 }, independence: { freshInitial: true, followUpAllowed: false }, result: { kind: "evidence", requiredSections: ["findings"] }, escalation: ["x"] } });
  assert.ok(invalidPhase.diagnostics.some(({ code }) => code === "agent_phase_invalid"));
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
  assert.deepEqual(
    loaded.definitions.map(({ name }) => name),
    [
      "adversary-a",
      "adversary-b",
      "brainstormer",
      "decomposer",
      "document-assessor",
      "documenter",
      "explore",
      "implementer",
      "investigator",
      "js-developer",
      "planner",
      "preflight-probe",
      "review-verifier",
      "reviewer",
      "tester",
      "vision-handoff",
      "wordpress-developer",
    ],
  );
  assert.deepEqual(loaded.diagnostics, []);
  assert.ok(loaded.definitions.every(({ useWhen }) => useWhen.length > 0));
});

test("lifecycle-specialist agents preserve read-only evidence contracts", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = await loadAgentDefinitions({
    paths: deriveAgentPaths({ packageRoot, agentDir: resolve(packageRoot, ".missing-agent-home"), cwd: packageRoot }),
    projectTrusted: false,
  });
  const byName = new Map(loaded.definitions.map((definition) => [definition.name, definition]));
  const expected = {
    brainstormer: { phase: "brainstorm", requiredSections: ["findings", "options", "risks"] },
    planner: { phase: "plan", requiredSections: ["findings", "plan-outline", "risks"] },
    decomposer: { phase: null, requiredSections: ["findings", "delivery-units", "dependencies"] },
    investigator: { phase: null, requiredSections: ["findings", "evidence", "hypotheses"] },
  };
  for (const [name, expectation] of Object.entries(expected)) {
    const definition = byName.get(name);
    assert.ok(definition, name);
    assert.equal(definition.tier, "HIGH");
    if (expectation.phase) assert.equal(definition.phase, expectation.phase);
    else assert.equal(Object.hasOwn(definition, "phase"), false);
    assert.equal(definition.authority, "read");
    assert.deepEqual(definition.tools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(definition.result, { kind: "evidence", requiredSections: expectation.requiredSections });
    assert.ok(definition.useWhen[0]);
    assert.deepEqual(definition.delegation, { allowed: false, maxDepth: 0 });
    assert.deepEqual(definition.independence, { freshInitial: false, followUpAllowed: true });
  }
});

test("accepts bounded read-only delegation to each lifecycle specialist", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = await loadAgentDefinitions({
    paths: deriveAgentPaths({ packageRoot, agentDir: resolve(packageRoot, ".missing-agent-home"), cwd: packageRoot }),
    projectTrusted: false,
  });
  const assignments = ["brainstormer", "planner", "decomposer", "investigator"].map((name) => ({
    id: name,
    agent: name,
    goal: `Gather ${name} evidence`,
    context: "Approved lifecycle-specialist work.",
    paths: [`agents/${name}.md`],
    constraints: ["Read only"],
    nonGoals: ["Editing"],
    expectedOutput: "Evidence",
    writeScope: [],
  }));
  assert.deepEqual(
    validateDelegationRequest({ title: "Delegate lifecycle-specialist evidence", assignments }, loaded.definitions),
    { valid: true, errors: [] },
  );
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
    assert.equal(definition.phase, "implement");
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
  assert.equal(byName.get("tester").phase, "test");
  assert.match(byName.get("tester").prompt, /stable `TEST-NNN` identifiers/);
  assert.match(byName.get("tester").prompt, /affected acceptance criterion/);
  assert.equal(byName.get("reviewer").phase, "review");
  assert.match(byName.get("reviewer").useWhen.join(" "), /initial review only/i);
  assert.match(byName.get("reviewer").useWhen.join(" "), /existing reviewer continuation/i);
  const assessor = byName.get("document-assessor");
  assert.equal(assessor.phase, "document");
  assert.equal(assessor.authority, "read");
  assert.equal(assessor.result.kind, "documentation");
  assert.deepEqual(assessor.result.requiredSections, ["evidence", "external-update-manifest", "residual-risk"]);
  for (const tool of ["write", "edit", "bash", "test"]) assert.equal(assessor.tools.includes(tool), false, tool);
  assert.equal(byName.get("documenter").phase, "document");
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


test("preflight-probe is a fixed fresh read-only package canary", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = await loadAgentDefinitions({ paths: deriveAgentPaths({ packageRoot, agentDir: resolve(packageRoot, ".missing-agent-home"), cwd: packageRoot }), projectTrusted: false });
  const definition = loaded.definitions.find(({ name }) => name === "preflight-probe");
  assert.equal(definition.tier, "LOW"); assert.equal(definition.authority, "read");
  assert.deepEqual(definition.tools, []); assert.deepEqual(definition.skills, []);
  assert.deepEqual(definition.delegation, { allowed: false, maxDepth: 0 });
  assert.deepEqual(definition.independence, { freshInitial: true, followUpAllowed: false });
  assert.deepEqual(definition.result, { kind: "evidence", requiredSections: ["marker", "identity", "limitations"] });
  assert.match(definition.prompt, /IMA_PI_PREFLIGHT_CHILD_OK/);
  const response = "## Marker\n\nIMA_PI_PREFLIGHT_CHILD_OK\n\n## Identity\n\npackage preflight-probe Pi agent invoked through ima_delegate\n\n## Limitations\n\nno files, services, or memory were inspected or changed";
  assert.deepEqual(validateDelegationCompletion({
    final: { stopReason: "stop" },
    text: response,
    requiredSections: definition.result.requiredSections,
    expected: { provider: "test-provider", model: "test-model", sessionId: "session-id", sessionFile: "session-file" },
    observed: { provider: "test-provider", model: "test-model", sessionId: "session-id", sessionFile: "session-file" },
  }), { ok: true, failures: [] });
});
