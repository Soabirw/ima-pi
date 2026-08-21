import assert from "node:assert/strict";
import test from "node:test";
import { classifyChildFailure, decideRecovery, resolveAgentRoute, resolveReviewVerificationRoute, sanitizeDelegationError, validateAdversarialRoutes } from "../lib/ima-delegation.ts";

const config = { models: { HIGH: { provider: "p", model: "high", thinking: "high" }, MID: { provider: "p", model: "mid" }, LOW: { provider: "p", model: "low" }, vision: { provider: "p", model: "vision" } } };
const catalog = [{ provider: "p", model: "high" }, { provider: "p", model: "mid" }, { provider: "p", model: "low" }, { provider: "p", model: "vision", input: ["image"] }];

test("routes exact configured tiers and fails closed for missing capability", () => {
  const high = resolveAgentRoute({ agent: { tier: "HIGH" }, config, catalog }); assert.deepEqual(high.route, { provider: "p", model: "high", thinking: "high", tier: "HIGH" });
  const vision = resolveAgentRoute({ agent: { tier: "vision" }, config, catalog }); assert.equal(vision.route.model, "vision");
  assert.equal(resolveAgentRoute({ agent: { tier: "HIGH" }, config, catalog: [] }).error, "model_unavailable");
  const phased = { ...config, phases: { implement: { provider: "p", model: "phase-implement", thinking: "max", source: "preset" } } };
  const phaseRoute = resolveAgentRoute({ agent: { tier: "MID", phase: "implement" }, config: phased, catalog: [...catalog, { provider: "p", model: "phase-implement" }] });
  assert.deepEqual(phaseRoute.route, { provider: "p", model: "phase-implement", thinking: "max", tier: "MID", phase: "implement" });
  assert.deepEqual(resolveAgentRoute({ agent: { tier: "MID", phase: "test" }, config: phased, catalog }).route, { provider: "p", model: "mid", thinking: undefined, tier: "MID", phase: "test" });
});

test("limits recovery and sanitizes credentials", () => {
  assert.equal(classifyChildFailure("provider timeout"), "transient-provider"); assert.equal(decideRecovery({ failure: "transient-provider", retries: 0 }).retry, true); assert.equal(decideRecovery({ failure: "transient-provider", retries: 1 }).retry, false);
  assert.equal(sanitizeDelegationError("api_key=secret-value failed"), "api_key=[redacted] failed");
});


test("review verification uses an explicit route or visible fresh-HIGH fallback", () => {
  const fallback = resolveReviewVerificationRoute({ config, catalog });
  assert.equal(fallback.resolvedRole, "HIGH"); assert.equal(fallback.fallbackUsed, true); assert.equal(fallback.route.model, "high");
  const configured = { models: { ...config.models, reviewVerify: { provider: "p", model: "mid" } } };
  const routed = resolveReviewVerificationRoute({ config: configured, catalog });
  assert.equal(routed.resolvedRole, "reviewVerify"); assert.equal(routed.fallbackUsed, false); assert.equal(routed.crossModel, true);
  assert.equal(resolveReviewVerificationRoute({ config: configured, catalog: [] }).route, null);

  const phaseAgent = { name: "review-verifier", tier: "reviewVerify", phase: "review" };
  const phaseRoute = { provider: "p", model: "phase-review", thinking: "low" };
  const phaseConfigured = { agents: {}, phases: { review: phaseRoute }, models: configured.models };
  const phasePreferred = resolveReviewVerificationRoute({
    agent: phaseAgent,
    config: phaseConfigured,
    catalog: [...catalog, { provider: "p", model: "phase-review" }],
  });
  assert.deepEqual(phasePreferred.route, { provider: "p", model: "mid", thinking: undefined, tier: "reviewVerify", phase: "review" });
  assert.equal(phasePreferred.resolvedRole, "reviewVerify");
  assert.equal(phasePreferred.fallbackUsed, false);

  const highFallback = resolveReviewVerificationRoute({
    agent: phaseAgent,
    config: { agents: {}, phases: { review: phaseRoute }, models: config.models },
    catalog: [...catalog, { provider: "p", model: "phase-review" }],
  });
  assert.deepEqual(highFallback.route, { provider: "p", model: "high", thinking: "high", tier: "HIGH", phase: "review" });
  assert.equal(highFallback.fallbackUsed, true);

  const unavailableExact = resolveReviewVerificationRoute({
    agent: phaseAgent,
    config: { ...phaseConfigured, agents: { "review-verifier": { provider: "p", model: "missing" } } },
    catalog: [...catalog, { provider: "p", model: "phase-review" }],
  });
  assert.equal(unavailableExact.route, null);
  assert.equal(unavailableExact.error, "model_unavailable");

  const unavailableReviewRole = resolveReviewVerificationRoute({
    agent: phaseAgent,
    config: { agents: {}, phases: { review: phaseRoute }, models: { ...config.models, reviewVerify: { provider: "p", model: "missing" } } },
    catalog: [...catalog, { provider: "p", model: "phase-review" }],
  });
  assert.equal(unavailableReviewRole.route, null);
  assert.equal(unavailableReviewRole.error, "model_unavailable");
});


test("adversary routes have no fallback and require distinct exact identities", () => {
  const adversaryAgent = { tier: "adversaryA" };
  assert.equal(resolveAgentRoute({ agent: adversaryAgent, config, catalog }).escalation, "adversaryA model is not configured");
  const mapped = { models: { ...config.models, adversaryA: { provider: "p", model: "high" }, adversaryB: { provider: "p", model: "mid" } } };
  assert.equal(resolveAgentRoute({ agent: adversaryAgent, config: mapped, catalog }).route.tier, "adversaryA");
  assert.deepEqual(validateAdversarialRoutes({ config: mapped, catalog }), { valid: true, routes: { adversaryA: mapped.models.adversaryA, adversaryB: mapped.models.adversaryB } });
  assert.deepEqual(validateAdversarialRoutes({ config: { models: { ...mapped.models, adversaryB: { provider: "p", model: "high", thinking: "off" } } }, catalog }), { valid: false, code: "adversary_routes_not_distinct" });
  assert.deepEqual(validateAdversarialRoutes({ config: { models: { ...config.models, adversaryB: { provider: "p", model: "mid" } } }, catalog }), { valid: false, code: "adversary_route_unconfigured", role: "adversaryA" });
  assert.deepEqual(validateAdversarialRoutes({ config: mapped, catalog: [] }), { valid: false, code: "adversary_route_unavailable", role: "adversaryA" });
});
