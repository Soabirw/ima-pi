import assert from "node:assert/strict";
import test from "node:test";
import { coordinateDelegation } from "../extensions/agents.ts";
import {
  mergeConfigLayers,
  validateConfigLayer,
  validateModelCatalog,
} from "../lib/ima-config.ts";
import {
  resolveAgentRoute,
  resolveReviewVerificationRoute,
  validateAdversarialRoutes,
} from "../lib/ima-delegation.ts";

const route = (model, thinking = "high") => ({
  provider: "provider",
  model,
  ...(thinking ? { thinking } : {}),
});

const modelRoles = () => ({
  HIGH: route("high"),
  MID: route("mid"),
  LOW: route("low"),
  vision: route("vision"),
});

const validLayer = (value, source) => {
  const result = validateConfigLayer(value, source);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  return result.value;
};

const catalogEntry = (model, input = ["text"]) => ({
  provider: "provider",
  model,
  input,
});

const delegatedAgent = (name = "js-developer") => ({
  schemaVersion: 1,
  name,
  description: "Delegated implementation specialist.",
  useWhen: ["Bounded JavaScript implementation."],
  tier: "MID",
  phase: "implement",
  authority: "write",
  tools: [],
  skills: [],
  delegation: { allowed: false, maxDepth: 0 },
  independence: { freshInitial: true, followUpAllowed: false },
  result: { kind: "implementation", requiredSections: ["files", "verification"] },
  escalation: [],
  prompt: "Implement the approved change.",
  source: "package",
  path: `/agents/${name}.md`,
});

const delegatedAssignment = (agent) => ({
  id: "child",
  agent: agent.name,
  goal: "Implement the approved route.",
  context: "Approved plan.",
  paths: ["lib/ima-delegation.ts"],
  constraints: [],
  nonGoals: [],
  expectedOutput: "Verified implementation report.",
  writeScope: ["lib/ima-delegation.ts"],
});

const childSession = ({ provider, model, thinking }) => {
  const state = { prompts: 0, disposals: 0 };
  return {
    state,
    session: {
      model: { provider, id: model },
      thinkingLevel: thinking,
      sessionId: "child-session",
      sessionFile: "/sessions/child.jsonl",
      messages: [{
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "## Files\nlib/ima-delegation.ts\n\n## Verification\npassed" }],
      }],
      subscribe: () => () => undefined,
      prompt: async () => { state.prompts += 1; },
      waitForIdle: async () => undefined,
      dispose: () => { state.disposals += 1; },
    },
  };
};

const runDelegatedAgent = async ({ configuredRoute, observedRoute = configuredRoute }) => {
  const agent = delegatedAgent();
  const child = childSession(observedRoute);
  let selected;
  const result = await coordinateDelegation({
    cwd: "/repo",
    request: { title: "route", assignments: [delegatedAssignment(agent)] },
    agents: [agent],
    config: {
      agents: { [agent.name]: configuredRoute },
      phases: { implement: route("phase-route") },
      models: { MID: route("tier-route") },
    },
    runtime: {
      getModels: () => [{ provider: configuredRoute.provider, id: configuredRoute.model, input: ["text"] }],
      getModel: (provider, model) => provider === configuredRoute.provider && model === configuredRoute.model
        ? { provider, id: model }
        : undefined,
    },
    sessionStore: new Map(),
    dependencies: {
      createManager: () => ({}),
      scopedTools: () => [],
      clock: () => "2026-08-20T00:00:00.000Z",
      activityClock: () => 1,
      createSession: async ({ model, thinkingLevel }) => {
        selected = { model, thinkingLevel };
        return { session: child.session };
      },
    },
  });
  return { child, result, selected };
};

test("validates complete per-agent mappings and merges whole entries by precedence", () => {
  const malformedName = validateConfigLayer({
    schemaVersion: 1,
    agents: { "not_a_name": route("invalid") },
  }, "user");
  assert.equal(malformedName.valid, false);
  assert.equal(malformedName.value, null);
  assert.ok(malformedName.diagnostics.some(({ code }) => code === "config_invalid_agent"));

  const digitPrefixedName = validateConfigLayer({
    schemaVersion: 1,
    agents: { "1-reviewer": route("invalid") },
  }, "user");
  assert.equal(digitPrefixedName.valid, false);
  assert.equal(digitPrefixedName.value, null);
  assert.ok(digitPrefixedName.diagnostics.some(({ code, path }) => code === "config_invalid_agent" && path.join("/") === "agents/1-reviewer"));

  const validAgentName = validateConfigLayer({
    schemaVersion: 1,
    agents: { "reviewer-2": route("valid") },
  }, "user");
  assert.equal(validAgentName.valid, true);
  assert.deepEqual(validAgentName.value.agents, { "reviewer-2": route("valid") });
  assert.equal(validateConfigLayer({ schemaVersion: 1, profile: "1-profile" }, "user").valid, true);

  const shorthand = validateConfigLayer({
    schemaVersion: 1,
    agents: { "js-developer": "high" },
  }, "user");
  assert.equal(shorthand.valid, false);
  assert.equal(shorthand.value, null);
  assert.ok(shorthand.diagnostics.some(({ code }) => code === "config_invalid_agent"));

  const unsafeMapping = validateConfigLayer({
    schemaVersion: 1,
    agents: { "js-developer": { provider: "provider", model: "agent", apiKey: "secret" } },
  }, "user");
  assert.equal(unsafeMapping.valid, false);
  assert.equal(unsafeMapping.value, null);
  assert.ok(unsafeMapping.diagnostics.some(({ code }) => code === "config_unknown_key"));

  const incompleteMapping = validateConfigLayer({
    schemaVersion: 1,
    agents: { "js-developer": { model: "agent" } },
  }, "user");
  assert.equal(incompleteMapping.valid, false);
  assert.equal(incompleteMapping.value, null);
  assert.ok(incompleteMapping.diagnostics.some(({ code, path }) => code === "config_invalid_provider" && path[0] === "agents"));

  const resolved = mergeConfigLayers({
    packageDefaults: validLayer({ schemaVersion: 1, profile: null }, "package"),
    preset: validLayer({
      schemaVersion: 1,
      models: modelRoles(),
      agents: { "js-developer": route("preset-agent", "max") },
    }, "preset"),
    user: validLayer({
      schemaVersion: 1,
      agents: { "js-developer": route("user-agent", "medium") },
    }, "user"),
    project: validLayer({
      schemaVersion: 1,
      agents: { "js-developer": route("project-agent", "low") },
    }, "project"),
  });

  assert.deepEqual(resolved.agents["js-developer"], {
    provider: "provider",
    model: "project-agent",
    thinking: "low",
    source: "project",
  });

  const catalog = [
    catalogEntry("high"),
    catalogEntry("mid"),
    catalogEntry("low"),
    catalogEntry("vision", ["image"]),
  ];
  assert.deepEqual(
    validateModelCatalog(resolved, catalog).diagnostics
      .filter(({ path }) => path[0] === "agents")
      .map(({ code, path }) => [code, path]),
    [["config_model_unavailable", ["agents", "js-developer"]]],
  );
});

test("resolves agent overrides before phase and tier routes without fallback", () => {
  const config = {
    agents: { "js-developer": route("agent-route", "max") },
    phases: { implement: route("phase-route", "medium") },
    models: { ...modelRoles(), MID: route("tier-route", "low") },
  };
  const catalog = [
    catalogEntry("agent-route"),
    catalogEntry("phase-route"),
    catalogEntry("tier-route"),
  ];
  const agent = { name: "js-developer", tier: "MID", phase: "implement" };

  assert.deepEqual(resolveAgentRoute({ agent, config, catalog }).route, {
    provider: "provider",
    model: "agent-route",
    thinking: "max",
    tier: "MID",
    phase: "implement",
  });
  assert.equal(resolveAgentRoute({ agent, config: { ...config, agents: {} }, catalog }).route.model, "phase-route");
  assert.equal(resolveAgentRoute({ agent, config: { ...config, agents: {}, phases: {} }, catalog }).route.model, "tier-route");

  const unavailable = resolveAgentRoute({
    agent,
    config: { ...config, agents: { "js-developer": route("unavailable-route") } },
    catalog,
  });
  assert.equal(unavailable.route, null);
  assert.equal(unavailable.error, "model_unavailable");
  assert.equal(unavailable.escalation, "configured agent route is unavailable");
});

test("ignores inherited agent routes and uses the configured phase route", () => {
  const agents = Object.create({ "js-developer": route("inherited-route") });
  const config = {
    agents,
    phases: { implement: route("phase-route") },
    models: modelRoles(),
  };

  assert.deepEqual(resolveAgentRoute({
    agent: { name: "js-developer", tier: "MID", phase: "implement" },
    config,
    catalog: [catalogEntry("phase-route")],
  }).route, {
    provider: "provider",
    model: "phase-route",
    thinking: "high",
    tier: "MID",
    phase: "implement",
  });
});

test("keeps specialized review, adversarial, and vision routing fail-closed", () => {
  const reviewConfig = {
    agents: { "review-verifier": route("review-agent", "xhigh") },
    phases: {},
    models: { HIGH: route("high"), reviewVerify: route("review-role") },
  };
  const review = resolveReviewVerificationRoute({
    agent: { name: "review-verifier", tier: "reviewVerify" },
    config: reviewConfig,
    catalog: [catalogEntry("review-agent")],
  });
  assert.equal(review.route.model, "review-agent");
  assert.equal(review.fallbackUsed, false);

  const adversaryConfig = {
    agents: {
      "adversary-a": route("agent-a"),
      "adversary-b": route("agent-b"),
    },
    phases: {},
    models: {
      adversaryA: route("tier-a"),
      adversaryB: route("tier-b"),
    },
  };
  assert.deepEqual(validateAdversarialRoutes({
    config: adversaryConfig,
    catalog: [catalogEntry("agent-a"), catalogEntry("agent-b")],
  }), {
    valid: true,
    routes: {
      adversaryA: adversaryConfig.agents["adversary-a"],
      adversaryB: adversaryConfig.agents["adversary-b"],
    },
  });

  const vision = resolveAgentRoute({
    agent: { name: "vision-handoff", tier: "vision" },
    config: {
      agents: { "vision-handoff": route("text-only") },
      phases: {},
      models: { vision: route("image-capable") },
    },
    catalog: [catalogEntry("text-only"), catalogEntry("image-capable", ["image"])],
  });
  assert.equal(vision.route, null);
  assert.equal(vision.error, "model_unavailable");
});

test("keeps review verification above phase routes and fails closed", () => {
  const agent = { name: "review-verifier", tier: "reviewVerify", phase: "review" };
  const phase = route("phase-route", "low");
  const reviewRole = route("review-role", "max");
  const high = route("high-route", "xhigh");
  const catalog = [catalogEntry("phase-route"), catalogEntry("review-role"), catalogEntry("high-route")];

  const explicitReviewRole = resolveReviewVerificationRoute({
    agent,
    config: { agents: {}, phases: { review: phase }, models: { reviewVerify: reviewRole, HIGH: high } },
    catalog,
  });
  assert.deepEqual(explicitReviewRole.route, {
    provider: "provider",
    model: "review-role",
    thinking: "max",
    tier: "reviewVerify",
    phase: "review",
  });
  assert.equal(explicitReviewRole.resolvedRole, "reviewVerify");
  assert.equal(explicitReviewRole.fallbackUsed, false);
  assert.equal(explicitReviewRole.crossModel, true);

  const highFallback = resolveReviewVerificationRoute({
    agent,
    config: { agents: {}, phases: { review: phase }, models: { HIGH: high } },
    catalog,
  });
  assert.deepEqual(highFallback.route, {
    provider: "provider",
    model: "high-route",
    thinking: "xhigh",
    tier: "HIGH",
    phase: "review",
  });
  assert.equal(highFallback.resolvedRole, "HIGH");
  assert.equal(highFallback.fallbackUsed, true);
  assert.equal(highFallback.crossModel, false);

  const unavailableExact = resolveReviewVerificationRoute({
    agent,
    config: {
      agents: { "review-verifier": route("unavailable-exact") },
      phases: { review: phase },
      models: { reviewVerify: reviewRole, HIGH: high },
    },
    catalog,
  });
  assert.equal(unavailableExact.route, null);
  assert.equal(unavailableExact.error, "model_unavailable");
  assert.equal(unavailableExact.fallbackUsed, false);

  const unavailableReviewRole = resolveReviewVerificationRoute({
    agent,
    config: {
      agents: {},
      phases: { review: phase },
      models: { reviewVerify: route("unavailable-review-role"), HIGH: high },
    },
    catalog,
  });
  assert.equal(unavailableReviewRole.route, null);
  assert.equal(unavailableReviewRole.error, "model_unavailable");
  assert.equal(unavailableReviewRole.fallbackUsed, false);
});

test("coordinates promoted and demoted children with observed route identity", async () => {
  const scenarios = [
    {
      name: "promoted child",
      parent: { provider: "provider", model: "low-parent", thinking: "low" },
      configuredRoute: route("high-child", "xhigh"),
    },
    {
      name: "demoted child",
      parent: { provider: "provider", model: "high-parent", thinking: "max" },
      configuredRoute: route("low-child", "medium"),
    },
  ];

  for (const scenario of scenarios) {
    const parentBefore = { ...scenario.parent };
    const outcome = await runDelegatedAgent(scenario);
    assert.equal(outcome.result.status, "succeeded", scenario.name);
    assert.deepEqual(outcome.selected, {
      model: { provider: "provider", id: scenario.configuredRoute.model },
      thinkingLevel: scenario.configuredRoute.thinking,
    }, scenario.name);
    assert.deepEqual({
      provider: outcome.result.results[0].provider,
      model: outcome.result.results[0].model,
      thinking: outcome.result.results[0].thinking,
    }, {
      provider: "provider",
      model: scenario.configuredRoute.model,
      thinking: scenario.configuredRoute.thinking,
    }, scenario.name);
    assert.deepEqual(scenario.parent, parentBefore, scenario.name);
  }
});

test("fails closed before prompting for unavailable or identity-mismatched exact routes", async () => {
  const agent = delegatedAgent();
  let created = false;
  const unavailable = await coordinateDelegation({
    cwd: "/repo",
    request: { title: "blocked", assignments: [delegatedAssignment(agent)] },
    agents: [agent],
    config: {
      agents: { [agent.name]: route("unavailable-route") },
      phases: { implement: route("phase-route") },
      models: { MID: route("tier-route") },
    },
    runtime: {
      getModels: () => [
        { provider: "provider", id: "phase-route", input: ["text"] },
        { provider: "provider", id: "tier-route", input: ["text"] },
      ],
      getModel: () => undefined,
    },
    dependencies: {
      createManager: () => ({}),
      scopedTools: () => [],
      clock: () => "2026-08-20T00:00:00.000Z",
      activityClock: () => 1,
      createSession: async () => {
        created = true;
        return { session: childSession(route("unavailable-route")).session };
      },
    },
  });
  assert.equal(unavailable.results[0].error, "model_unavailable");
  assert.match(unavailable.results[0].escalation, /configured agent route/);
  assert.equal(created, false);

  const configuredRoute = route("exact-route", "max");
  const mismatch = await runDelegatedAgent({
    configuredRoute,
    observedRoute: route("wrong-route", "max"),
  });
  assert.equal(mismatch.result.status, "failed");
  assert.ok(mismatch.result.results[0].completion.includes("runtime_identity_mismatch"));
  assert.equal(mismatch.child.state.prompts, 0);
});
