import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  IMA_PHASE_ROUTE_ENTRY,
  IMA_ROLE_ROUTE_ENTRY,
  applyPhaseRoute,
  applyRoleRoute,
  formatPhaseMatrix,
  latestSessionProfile,
  parseProfileCommand,
  parseWorkflowCommand,
  persistUserProfileSelection,
  resolvePhaseRoute,
  resolveRoleRoute,
} from "../extensions/workflow-routing.ts";

const config = {
  profile: "test-profile",
  models: {
    HIGH: { provider: "terra", model: "high", thinking: "max", source: "preset" },
  },
  phases: {
    plan: { provider: "terra", model: "plan", thinking: "max", source: "preset" },
    implement: { provider: "luna", model: "implement", thinking: "max", source: "preset" },
    test: { provider: "luna", model: "test", thinking: "max", source: "preset" },
    review: { provider: "sol", model: "review", thinking: "xhigh", source: "preset" },
    resolution: { provider: "luna", model: "resolution", thinking: "max", source: "preset" },
    rereview: { provider: "sol", model: "rereview", thinking: "xhigh", source: "preset" },
    document: { provider: "terra", model: "document", thinking: "max", source: "preset" },
  },
};

const state = () => {
  let model = { provider: "old", id: "old-model" };
  let thinking = "medium";
  const entries = [];
  return {
    get model() { return model; },
    get thinking() { return thinking; },
    entries,
    findModel: (provider, id) => ({ provider, id }),
    hasConfiguredAuth: () => true,
    setModel: async (next) => { model = next; return true; },
    setThinkingLevel: (next) => { thinking = next; },
    getThinkingLevel: () => thinking,
    appendEntry: (type, data) => entries.push({ type, data }),
  };
};

test("maps only exact workflow commands and leaves ordinary input unchanged", () => {
  assert.deepEqual(parseWorkflowCommand("/ima:brainstorm idea"), { command: "ima:brainstorm", phase: "brainstorm", args: "idea" });
  assert.deepEqual(parseWorkflowCommand("/ima:plan source"), { command: "ima:plan", phase: "plan", args: "source" });
  assert.deepEqual(parseWorkflowCommand("  /ima:implement-js plan"), { command: "ima:implement-js", phase: "implement", args: "plan" });
  assert.deepEqual(parseWorkflowCommand("/ima:resolve-review review"), { command: "ima:resolve-review", phase: "resolution", args: "review" });
  assert.deepEqual(parseWorkflowCommand("/ima:rereview resolution"), { command: "ima:rereview", phase: "rereview", args: "resolution" });
  assert.equal(parseWorkflowCommand("/ima:planner source"), null);
  assert.equal(parseWorkflowCommand("ordinary /ima:plan text"), null);
  assert.deepEqual(parseProfileCommand(""), { mode: "list" });
  assert.deepEqual(parseProfileCommand("openai-codex-56-max"), { mode: "activate", name: "openai-codex-56-max" });
  assert.deepEqual(parseProfileCommand("openai-codex-56-max --save"), { mode: "activate", name: "openai-codex-56-max" });
  assert.equal(parseProfileCommand("../unsafe").mode, "invalid");
  assert.equal(parseProfileCommand("profile --save extra").mode, "invalid");
});

test("resolves explicit phase routes without a runtime tier fallback", () => {
  assert.deepEqual(resolvePhaseRoute(config, "review"), { ok: true, route: { phase: "review", provider: "sol", model: "review", thinking: "xhigh" } });
  assert.deepEqual(resolvePhaseRoute(config, "resolution"), { ok: true, route: { phase: "resolution", provider: "luna", model: "resolution", thinking: "max" } });
  assert.equal(resolvePhaseRoute({ phases: {} }, "implement").error, "phase_route_missing");
  assert.match(formatPhaseMatrix(config), /review: sol\/review \(xhigh\)/);
});

test("resolves and applies the effective HIGH role route with shared safeguards", async () => {
  assert.deepEqual(resolveRoleRoute(config, "HIGH"), { ok: true, route: { role: "HIGH", provider: "terra", model: "high", thinking: "max" } });
  assert.equal(resolveRoleRoute({ models: {} }, "HIGH").error, "role_route_missing");

  const current = state();
  const result = await applyRoleRoute(config, "HIGH", {
    ...current,
    previousModel: current.model,
    previousThinking: current.thinking,
    profile: "test-profile",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(current.model, { provider: "terra", id: "high" });
  assert.equal(current.thinking, "max");
  assert.deepEqual(current.entries, [{ type: IMA_ROLE_ROUTE_ENTRY, data: { profile: "test-profile", role: "HIGH", provider: "terra", model: "high", thinking: "max" } }]);

  const busy = state();
  const blocked = await applyRoleRoute(config, "HIGH", { ...busy, previousModel: busy.model, previousThinking: busy.thinking, isIdle: () => false });
  assert.equal(blocked.error, "route_busy");
});

test("applies an exact route and persists sanitized route evidence", async () => {
  const current = state();
  const result = await applyPhaseRoute(config, "implement", {
    ...current,
    previousModel: current.model,
    previousThinking: current.thinking,
    profile: "test-profile",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(current.model, { provider: "luna", id: "implement" });
  assert.equal(current.thinking, "max");
  assert.deepEqual(current.entries, [{ type: IMA_PHASE_ROUTE_ENTRY, data: { profile: "test-profile", phase: "implement", provider: "luna", model: "implement", thinking: "max" } }]);
});

test("blocks unavailable, unauthenticated, and busy routes before switching", async () => {
  const unavailable = state();
  const missing = await applyPhaseRoute(config, "plan", { ...unavailable, previousModel: unavailable.model, previousThinking: unavailable.thinking, findModel: () => undefined });
  assert.equal(missing.error, "model_unavailable");
  assert.deepEqual(unavailable.model, { provider: "old", id: "old-model" });

  const unauthenticated = state();
  const unauth = await applyPhaseRoute(config, "plan", { ...unauthenticated, previousModel: unauthenticated.model, previousThinking: unauthenticated.thinking, hasConfiguredAuth: () => false });
  assert.equal(unauth.error, "auth_unavailable");

  const rejected = state();
  let modelCalls = 0;
  let thinkingCalls = 0;
  const credentialMarker = "credential-secret";
  const rejectedAuth = await applyPhaseRoute(config, "plan", {
    ...rejected,
    previousModel: rejected.model,
    previousThinking: rejected.thinking,
    hasConfiguredAuth: async () => { throw new Error(credentialMarker); },
    setModel: async () => { modelCalls += 1; return true; },
    setThinkingLevel: () => { thinkingCalls += 1; },
  });
  assert.deepEqual(rejectedAuth, { ok: false, error: "auth_unavailable", message: "Configured plan model is unauthenticated.", rollback: "not-needed" });
  assert.doesNotMatch(JSON.stringify(rejectedAuth), new RegExp(credentialMarker));
  assert.equal(modelCalls, 0);
  assert.equal(thinkingCalls, 0);
  assert.deepEqual(rejected.entries, []);
  assert.deepEqual(rejected.model, { provider: "old", id: "old-model" });
  assert.equal(rejected.thinking, "medium");

  const busy = state();
  const blocked = await applyPhaseRoute(config, "plan", { ...busy, previousModel: busy.model, previousThinking: busy.thinking, isIdle: () => false });
  assert.equal(blocked.error, "route_busy");
});

test("rolls back model and thinking when the target thinking level is clamped", async () => {
  const current = state();
  const result = await applyPhaseRoute(config, "review", {
    ...current,
    previousModel: current.model,
    previousThinking: current.thinking,
    setThinkingLevel: (next) => { current.setThinkingLevel(next === "xhigh" ? "high" : next); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "thinking_unsupported");
  assert.deepEqual(current.model, { provider: "old", id: "old-model" });
  assert.equal(current.thinking, "medium");
});

test("saves a user profile atomically while retaining valid overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-profile-test-"));
  const path = join(directory, "ima", "config.json");
  await mkdir(join(directory, "ima"), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, profile: "old", models: { HIGH: { provider: "p", model: "m" } }, phases: { test: { provider: "p", model: "test" } } }));
  const result = await persistUserProfileSelection({ path, profile: "new-profile" });
  assert.deepEqual(result, { ok: true, path });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    schemaVersion: 1,
    profile: "new-profile",
    models: { HIGH: { provider: "p", model: "m" } },
    phases: { test: { provider: "p", model: "test" } },
  });
});

test("creates a user profile default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-profile-test-"));
  const path = join(directory, "ima", "config.json");
  const result = await persistUserProfileSelection({ path, profile: "new-profile" });
  assert.deepEqual(result, { ok: true, path });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { schemaVersion: 1, profile: "new-profile" });
});

test("restores only valid session profile entries", () => {
  assert.equal(latestSessionProfile([{ type: "custom", customType: "ima-profile-state", data: { profile: "first" } }, { type: "custom", customType: "other", data: { profile: "ignored" } }]), "first");
  assert.equal(latestSessionProfile([{ type: "custom", customType: "ima-profile-state", data: { profile: "../unsafe" } }]), null);
});
