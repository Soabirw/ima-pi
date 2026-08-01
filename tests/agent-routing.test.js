import assert from "node:assert/strict";
import test from "node:test";
import { classifyChildFailure, decideRecovery, resolveAgentRoute, resolveReviewVerificationRoute, sanitizeDelegationError } from "../lib/ima-delegation.ts";

const config = { models: { HIGH: { provider: "p", model: "high", thinking: "high" }, MID: { provider: "p", model: "mid" }, LOW: { provider: "p", model: "low" }, vision: { provider: "p", model: "vision" } } };
const catalog = [{ provider: "p", model: "high" }, { provider: "p", model: "mid" }, { provider: "p", model: "low" }, { provider: "p", model: "vision", input: ["image"] }];

test("routes exact configured tiers and fails closed for missing capability", () => {
  const high = resolveAgentRoute({ agent: { tier: "HIGH" }, config, catalog }); assert.deepEqual(high.route, { provider: "p", model: "high", thinking: "high", tier: "HIGH" });
  const vision = resolveAgentRoute({ agent: { tier: "vision" }, config, catalog }); assert.equal(vision.route.model, "vision");
  assert.equal(resolveAgentRoute({ agent: { tier: "HIGH" }, config, catalog: [] }).error, "model_unavailable");
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
});
