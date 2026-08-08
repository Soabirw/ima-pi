import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  IMA_PHASE_ROUTE_ENTRY,
  IMA_ROLE_ROUTE_ENTRY,
  applyCommandRoute,
  applyRoleRoute,
  formatRouteMatrix,
  latestSessionProfile,
  parseProfileCommand,
  parseWorkflowCommand,
  persistUserProfileSelection,
  resolveCommandRoute,
  resolveRoleRoute,
} from "../extensions/workflow-routing.ts";

const config = {
  profile: "test-profile",
  models: {
    HIGH: { provider: "terra", model: "high", thinking: "max", source: "preset" },
    XHIGH: { provider: "terra", model: "xhigh", thinking: "xhigh", source: "preset" },
  },
  commands: {
    plan: { provider: "terra", model: "plan", thinking: "max", source: "preset" },
    implement: { provider: "luna", model: "implement", thinking: "max", source: "preset" },
    review: { provider: "sol", model: "review", thinking: "xhigh", source: "preset" },
    "resolve-review": { provider: "luna", model: "resolution", thinking: "max", source: "preset" },
  },
  phases: {
    implement: { provider: "legacy", model: "implement", thinking: "high", source: "preset" },
    resolution: { provider: "legacy", model: "resolution", thinking: "high", source: "preset" },
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

test("parses every /ima:* command candidate and leaves unrelated input unchanged", () => {
  assert.deepEqual(parseWorkflowCommand("/ima:brainstorm idea"), { command: "ima:brainstorm", name: "brainstorm", args: "idea" });
  assert.deepEqual(parseWorkflowCommand("/ima:implement-js plan"), { command: "ima:implement-js", name: "implement-js", args: "plan" });
  assert.deepEqual(parseWorkflowCommand("  /ima:future-command source"), { command: "ima:future-command", name: "future-command", args: "source" });
  assert.equal(parseWorkflowCommand("/ima:"), null);
  assert.equal(parseWorkflowCommand("/other:command source"), null);
  assert.equal(parseWorkflowCommand("ordinary /ima:plan text"), null);
  assert.deepEqual(parseProfileCommand(""), { mode: "list" });
  assert.deepEqual(parseProfileCommand("openai-codex-56-max"), { mode: "activate", name: "openai-codex-56-max" });
  assert.deepEqual(parseProfileCommand("openai-codex-56-max --save"), { mode: "activate", name: "openai-codex-56-max" });
  assert.equal(parseProfileCommand("../unsafe").mode, "invalid");
  assert.equal(parseProfileCommand("profile --save extra").mode, "invalid");
});

test("resolves configured commands before legacy phase fallback and otherwise passes through", () => {
  assert.deepEqual(resolveCommandRoute(config, "review"), { ok: true, route: { command: "review", provider: "sol", model: "review", thinking: "xhigh" } });
  assert.deepEqual(resolveCommandRoute(config, "resolve-review"), { ok: true, route: { command: "resolve-review", provider: "luna", model: "resolution", thinking: "max" } });
  assert.deepEqual(resolveCommandRoute({ commands: {}, phases: config.phases }, "resolve-review"), { ok: true, route: { command: "resolve-review", provider: "legacy", model: "resolution", thinking: "high" } });
  assert.equal(resolveCommandRoute({ commands: {}, phases: {} }, "unconfigured"), null);
  assert.match(formatRouteMatrix(config), /commands:\nimplement: luna\/implement \(max\)/);
  assert.match(formatRouteMatrix(config), /legacy phases:\nimplement: legacy\/implement \(high\)/);
  assert.match(formatRouteMatrix(config), /roles:\nHIGH: terra\/high \(max\)/);
  const phaseOnly = formatRouteMatrix({
    profile: "phase-only",
    commands: {},
    phases: { plan: { provider: "legacy", model: "plan", thinking: "high" } },
    models: {},
  });
  assert.match(phaseOnly, /commands:\n\(none; no direct command routes\)/);
  assert.match(phaseOnly, /legacy phases:\nplan: legacy\/plan \(high\)/);
  assert.doesNotMatch(phaseOnly, /unconfigured commands pass through/);
  assert.match(formatRouteMatrix({ profile: null, commands: {}, phases: {}, models: {} }), /unconfigured commands pass through/);
});

test("resolves and applies the effective HIGH role route with shared safeguards", async () => {
  assert.deepEqual(resolveRoleRoute(config, "HIGH"), { ok: true, route: { role: "HIGH", provider: "terra", model: "high", thinking: "max" } });
  assert.deepEqual(resolveRoleRoute(config, "XHIGH"), { ok: true, route: { role: "XHIGH", provider: "terra", model: "xhigh", thinking: "xhigh" } });
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

test("applies a configured command and leaves an unconfigured command unchanged", async () => {
  const current = state();
  const result = await applyCommandRoute(config, "implement", {
    ...current,
    previousModel: current.model,
    previousThinking: current.thinking,
    profile: "test-profile",
  });
  assert.equal(result?.ok, true);
  assert.deepEqual(current.model, { provider: "luna", id: "implement" });
  assert.equal(current.thinking, "max");
  assert.deepEqual(current.entries, [{ type: IMA_PHASE_ROUTE_ENTRY, data: { profile: "test-profile", command: "implement", provider: "luna", model: "implement", thinking: "max" } }]);

  for (const command of ["future-command", "constructor", "toString", "__proto__"]) {
    const passthrough = state();
    assert.equal(await applyCommandRoute({ commands: {}, phases: {} }, command, { ...passthrough, previousModel: passthrough.model, previousThinking: passthrough.thinking }), null);
    assert.deepEqual(passthrough.model, { provider: "old", id: "old-model" });
    assert.equal(passthrough.thinking, "medium");
    assert.deepEqual(passthrough.entries, []);
  }

  Object.defineProperty(Object.prototype, "future-command", { configurable: true, value: "plan" });
  try {
    const passthrough = state();
    assert.equal(
      await applyCommandRoute(
        { commands: {}, phases: { plan: { provider: "legacy", model: "plan", thinking: "high", source: "preset" } } },
        "future-command",
        { ...passthrough, previousModel: passthrough.model, previousThinking: passthrough.thinking },
      ),
      null,
    );
    assert.deepEqual(passthrough.model, { provider: "old", id: "old-model" });
    assert.equal(passthrough.thinking, "medium");
    assert.deepEqual(passthrough.entries, []);
  } finally {
    delete Object.prototype["future-command"];
  }
});

test("blocks unavailable, unauthenticated, and busy command routes before switching", async () => {
  const unavailable = state();
  const missing = await applyCommandRoute(config, "plan", { ...unavailable, previousModel: unavailable.model, previousThinking: unavailable.thinking, findModel: () => undefined });
  assert.equal(missing?.error, "model_unavailable");
  assert.deepEqual(unavailable.model, { provider: "old", id: "old-model" });

  const unauthenticated = state();
  const unauth = await applyCommandRoute(config, "plan", { ...unauthenticated, previousModel: unauthenticated.model, previousThinking: unauthenticated.thinking, hasConfiguredAuth: () => false });
  assert.equal(unauth?.error, "auth_unavailable");

  const rejected = state();
  const credentialMarker = "credential-secret";
  const rejectedAuth = await applyCommandRoute(config, "plan", {
    ...rejected,
    previousModel: rejected.model,
    previousThinking: rejected.thinking,
    hasConfiguredAuth: async () => { throw new Error(credentialMarker); },
  });
  assert.deepEqual(rejectedAuth, { ok: false, error: "auth_unavailable", message: "Configured plan model is unauthenticated.", rollback: "not-needed" });
  assert.doesNotMatch(JSON.stringify(rejectedAuth), new RegExp(credentialMarker));

  const busy = state();
  const blocked = await applyCommandRoute(config, "plan", { ...busy, previousModel: busy.model, previousThinking: busy.thinking, isIdle: () => false });
  assert.equal(blocked?.error, "route_busy");
});

test("rolls back model and thinking when the target command thinking level is clamped", async () => {
  const current = state();
  const result = await applyCommandRoute(config, "review", {
    ...current,
    previousModel: current.model,
    previousThinking: current.thinking,
    setThinkingLevel: (next) => { current.setThinkingLevel(next === "xhigh" ? "high" : next); },
  });
  assert.equal(result?.ok, false);
  assert.equal(result?.error, "thinking_unsupported");
  assert.deepEqual(current.model, { provider: "old", id: "old-model" });
  assert.equal(current.thinking, "medium");
});

test("saves a user profile atomically while retaining valid overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-profile-test-"));
  const path = join(directory, "ima", "config.json");
  await mkdir(join(directory, "ima"), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, profile: "old", models: { HIGH: { provider: "p", model: "m" } }, phases: { test: { provider: "p", model: "test" } }, commands: { plan: "high" } }));
  const result = await persistUserProfileSelection({ path, profile: "new-profile" });
  assert.deepEqual(result, { ok: true, path });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    schemaVersion: 1,
    profile: "new-profile",
    models: { HIGH: { provider: "p", model: "m" } },
    phases: { test: { provider: "p", model: "test" } },
    commands: { plan: "high" },
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
