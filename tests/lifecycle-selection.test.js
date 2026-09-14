import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLE_PROVIDER_NAMES,
  LIFECYCLE_PROVIDER_PRIORITY,
  lifecycleProviderCandidates,
  lifecycleProviderSharingNotice,
  normalizeLifecycleProvider,
  resolveLifecycleProviderRecommendation,
  selectLifecycleProvider,
} from "../lib/ima-lifecycle-selection.ts";

test("orders all four lifecycle providers exactly and preserves the recommendation source", () => {
  assert.deepEqual(LIFECYCLE_PROVIDER_NAMES, ["bookstack", "qdrant", "serena", "markdown"]);
  assert.deepEqual(LIFECYCLE_PROVIDER_PRIORITY, ["bookstack", "qdrant", "serena", "markdown"]);

  const cases = [
    [{ session: "qdrant", project: "markdown", serena: "bookstack", global: "serena" }, "qdrant", "session"],
    [{ project: { provider: "serena" }, global: "markdown" }, "serena", "project"],
    [{ serena: "markdown", global: "qdrant" }, "markdown", "serena"],
    [{ global: "qdrant" }, "qdrant", "global"],
    [{}, "bookstack", "default"],
  ];

  for (const [input, provider, source] of cases) {
    const resolved = resolveLifecycleProviderRecommendation(input);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) continue;
    assert.equal(resolved.recommendation.provider, provider);
    assert.equal(resolved.recommendation.source, source);
    assert.deepEqual(
      resolved.recommendation.candidates,
      [provider, ...LIFECYCLE_PROVIDER_PRIORITY.filter((candidate) => candidate !== provider)],
    );
  }
});

test("fails closed instead of accepting malformed high-precedence preferences", () => {
  for (const session of [
    "../../markdown",
    "bookstack\nqdrant",
    "bookstack\u0000",
    "bookstack; token=synthetic-secret",
    { provider: "qdrant", extra: true },
    new Proxy({}, { ownKeys: () => { throw new Error("hostile preference"); } }),
  ]) {
    assert.deepEqual(
      resolveLifecycleProviderRecommendation({ session, project: "qdrant" }),
      { ok: false, code: "lifecycle_provider_preference_invalid", source: "session" },
    );
  }

  for (const value of ["", "unknown", " ../serena ", "markdown\r", 3, []]) {
    assert.equal(normalizeLifecycleProvider(value), null);
  }
});

test("accepts only canonical selected providers and makes BookStack sharing user-only", () => {
  const resolved = resolveLifecycleProviderRecommendation({ project: "serena" });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.equal(selectLifecycleProvider({ recommendation: resolved.recommendation, provider: " SeReNa " }), "serena");
  assert.equal(selectLifecycleProvider({ recommendation: resolved.recommendation, provider: "markdown\n" }), null);
  assert.match(lifecycleProviderSharingNotice("bookstack"), /only the user may approve/i);
  assert.match(lifecycleProviderSharingNotice("bookstack"), /organization-visible/i);
  assert.doesNotMatch(lifecycleProviderSharingNotice("qdrant"), /approve/i);

  assert.deepEqual(lifecycleProviderCandidates("markdown"), [
    "markdown",
    "bookstack",
    "qdrant",
    "serena",
  ]);
});
