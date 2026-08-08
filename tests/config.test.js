import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  IMA_MODEL_ROLES,
  IMA_OPTIONAL_MODEL_ROLES,
  IMA_PHASES,
  IMA_THINKING_LEVELS,
  deriveImaConfigPaths,
  discoverImaProfiles,
  loadImaConfig,
  mergeConfigLayers,
  resolveCommandRoute,
  resolveNamedResources,
  resolveSelectedProfile,
  validateConfigLayer,
  validateModelCatalog,
} from "../lib/ima-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const layer = (models = {}, profile) => ({
  schemaVersion: 1,
  ...(profile === undefined ? {} : { profile }),
  models,
});
const role = (provider, model, thinking = "medium") => ({ provider, model, thinking });
const completeLayer = (provider = "provider") =>
  layer(Object.fromEntries(IMA_MODEL_ROLES.map((name) => [name, role(provider, name)])));
const valid = (value, source = "package") => {
  const result = validateConfigLayer(value, source);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  return result.value;
};
const codes = (result) => result.diagnostics.map(({ code }) => code);

const resolvedPreset = () => mergeConfigLayers({
  packageDefaults: valid(layer({}, null)),
  preset: valid(completeLayer(), "preset"),
  user: null,
  project: null,
});

test("accepts schema-v1 partial layers and trims their explicit values", () => {
  const result = validateConfigLayer(layer({ HIGH: { provider: " provider ", model: " model ", thinking: "high" } }, " profile "), "user");

  assert.equal(result.valid, true);
  assert.deepEqual(result.value, {
    schemaVersion: 1,
    profile: "profile",
    models: { HIGH: { provider: "provider", model: "model", thinking: "high" } },
  });
  for (const thinking of IMA_THINKING_LEVELS) {
    assert.equal(validateConfigLayer(layer({ HIGH: role("p", "m", thinking) }), "user").valid, true);
  }
});

test("keeps XHIGH optional, case-sensitive, and independently validated", () => {
  assert.deepEqual(IMA_OPTIONAL_MODEL_ROLES, ["reviewVerify", "adversaryA", "adversaryB", "XHIGH"]);
  assert.deepEqual(valid(layer({ XHIGH: role("provider", "model", "xhigh") }), "user").models.XHIGH, {
    provider: "provider",
    model: "model",
    thinking: "xhigh",
  });
  const lowercase = validateConfigLayer(layer({ xhigh: role("provider", "model") }), "user");
  assert.deepEqual(lowercase.diagnostics[0].path, ["models", "xhigh"]);
  const invalid = validateConfigLayer(layer({ XHIGH: { provider: "", model: "", thinking: "unsupported" } }), "user");
  assert.deepEqual(invalid.diagnostics.map(({ code, path }) => [code, path]), [
    ["config_invalid_provider", ["models", "XHIGH", "provider"]],
    ["config_invalid_model", ["models", "XHIGH", "model"]],
    ["config_invalid_thinking", ["models", "XHIGH", "thinking"]],
  ]);
});

test("rejects fatal config shapes and foundational model mappings", () => {
  const cases = [
    [{}, "config_schema_version_unsupported"],
    [[], "config_json_invalid"],
    [null, "config_json_invalid"],
    ["config", "config_json_invalid"],
    [1, "config_json_invalid"],
    [layer({ HIGH: { provider: "", model: "m" } }), "config_invalid_provider"],
    [layer({ HIGH: { provider: "p", model: "" } }), "config_invalid_model"],
    [layer({ HIGH: { provider: "p", model: "m", thinking: "invalid" } }), "config_invalid_thinking"],
    [layer({ HIGH: { provider: "p", model: "m", apiKey: "secret" } }), "config_unknown_key"],
    [{ ...layer(), profile: " " }, "config_invalid_profile"],
    [{ ...layer(), schemaVersion: 2 }, "config_schema_version_unsupported"],
    [{ schemaVersion: 1, models: [] }, "config_invalid_model"],
  ];

  for (const [input, expected] of cases) {
    const result = validateConfigLayer(input, "user");
    assert.equal(result.valid, false, `expected ${expected}`);
    assert.ok(codes(result).includes(expected));
  }
});

test("keeps unknown and malformed command or phase entries nonfatal while dropping them", () => {
  const result = validateConfigLayer({
    schemaVersion: 1,
    apiKey: "secret",
    models: { unknown: role("p", "m") },
    phases: { plan: { provider: "", model: "" }, test: role("p", "test"), unknown: role("p", "m") },
    commands: { "resolve-review": "high", good: role("p", "good"), broken: "unsupported", " ": "mid", unsafe: { provider: "p", model: "unsafe", apiKey: "secret" } },
  }, "user");

  assert.equal(result.valid, true);
  assert.deepEqual(result.value, {
    schemaVersion: 1,
    models: {},
    phases: { test: role("p", "test") },
    commands: { "resolve-review": "high", good: role("p", "good") },
  });
  for (const code of ["config_unknown_key", "config_unknown_role", "config_invalid_provider", "config_invalid_phase", "config_unknown_phase", "config_invalid_command"]) assert.ok(codes(result).includes(code), code);
});

test("selects no profile by default and respects user, trusted project, and project null precedence", () => {
  const defaults = valid(layer({}, null));
  const user = valid(layer({}, "user-profile"), "user");
  const project = valid(layer({}, "project-profile"), "project");
  const clearingProject = valid(layer({}, null), "project");

  assert.equal(resolveSelectedProfile(defaults, null, null), null);
  assert.equal(resolveSelectedProfile(defaults, user, null), "user-profile");
  assert.equal(resolveSelectedProfile(defaults, user, project), "project-profile");
  assert.equal(resolveSelectedProfile(defaults, user, clearingProject), null);
});

test("merges whole role mappings by precedence without mutation or vision inheritance", () => {
  const defaults = valid(layer({}, null));
  const preset = valid(completeLayer("preset"), "preset");
  const user = valid(layer({ HIGH: role("user", "high", "high") }), "user");
  const project = valid(layer({ HIGH: { provider: "project", model: "override" } }), "project");
  const resolved = mergeConfigLayers({ packageDefaults: defaults, preset, user, project });

  assert.deepEqual(resolved.models.HIGH, { provider: "project", model: "override", source: "project" });
  assert.deepEqual(resolved.models.vision, { provider: "preset", model: "vision", thinking: "medium", source: "preset" });
  assert.equal(resolved.complete, true);
  assert.equal(preset.models.HIGH.provider, "preset");
  assert.equal(user.models.HIGH.thinking, "high");
});

test("reports incomplete mappings in stable role order and never derives vision from HIGH", () => {
  const result = mergeConfigLayers({
    packageDefaults: valid(layer()),
    preset: null,
    user: valid(layer({ HIGH: role("p", "high") }), "user"),
    project: null,
  });

  assert.equal(result.complete, false);
  assert.deepEqual(result.missingRoles, ["MID", "LOW", "vision"]);
  assert.equal(result.models.vision, undefined);
  assert.deepEqual(codes(result), ["config_incomplete"]);
});

test("resolves named resources by project, user, then package with deterministic order", () => {
  const packageResources = [{ name: "one", value: "package" }, { name: "shared", value: "package" }];
  const userResources = [{ name: "two", value: "user" }, { name: "shared", value: "user" }];
  const projectResources = [{ name: "three", value: "project", nested: { values: [1] } }, { name: "shared", value: "project" }];
  const result = resolveNamedResources({ packageResources, userResources, projectResources });

  assert.deepEqual(result, [
    { name: "three", value: "project", nested: { values: [1] }, source: "project" },
    { name: "shared", value: "project", source: "project" },
    { name: "two", value: "user", source: "user" },
    { name: "one", value: "package", source: "package" },
  ]);
  result[0].nested.values.push(2);
  assert.deepEqual(projectResources[0].nested.values, [1]);
  assert.deepEqual(packageResources, [{ name: "one", value: "package" }, { name: "shared", value: "package" }]);
});

test("rejects duplicate named resources only within their originating scope", () => {
  assert.throws(
    () => resolveNamedResources({ packageResources: [], userResources: [{ name: "x" }, { name: "x" }], projectResources: [] }),
    /config_duplicate_resource:user:x/,
  );
  assert.doesNotThrow(() => resolveNamedResources({ packageResources: [{ name: "x" }], userResources: [{ name: "x" }], projectResources: [] }));
});

test("validates exact catalog identities and requires image input exclusively for vision", () => {
  const config = resolvedPreset();
  const catalog = IMA_MODEL_ROLES.map((name) => ({ provider: "provider", model: name, input: ["text"] }));

  assert.deepEqual(codes(validateModelCatalog(config, catalog)), ["config_vision_not_supported"]);
  catalog[3].input = ["image"];
  assert.equal(validateModelCatalog(config, catalog).valid, true);
  assert.deepEqual(codes(validateModelCatalog(config, catalog.slice(0, 3))), ["config_model_unavailable"]);
  assert.equal(validateModelCatalog(config, IMA_MODEL_ROLES.map((name) => ({ provider: "provider", model: name, input: { image: true } }))).valid, true);
});

test("validates configured command routes against the model catalog", () => {
  const config = mergeConfigLayers({
    packageDefaults: valid(layer({}, null)),
    preset: valid({ ...completeLayer("provider"), commands: { plan: role("provider", "command") } }, "preset"),
    user: null,
    project: null,
  });
  const catalog = [...IMA_MODEL_ROLES.map((name) => ({ provider: "provider", model: name, input: name === "vision" ? ["image"] : ["text"] })), { provider: "provider", model: "command" }];
  assert.equal(validateModelCatalog(config, catalog).valid, true);
  assert.deepEqual(validateModelCatalog(config, catalog.slice(0, -1)).diagnostics.map(({ path }) => path), [["commands", "plan"]]);
});

test("derives the exact package, user, and project configuration paths", () => {
  assert.deepEqual(deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" }), {
    packageDefaults: "/package/config/defaults.json",
    presets: "/package/config/presets",
    user: "/agent/ima/config.json",
    project: "/project/.pi/ima/config.json",
    userProfiles: "/agent/ima/profiles",
    projectProfiles: "/project/.pi/ima/profiles",
  });
});

test("loads an opt-in preset and applies user then trusted project role replacements", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const files = new Map([
    [paths.packageDefaults, JSON.stringify(layer({}, null))],
    [paths.user, JSON.stringify(layer({ MID: role("user", "mid") }, "preset") )],
    ["/package/config/presets/preset.json", JSON.stringify(completeLayer("preset"))],
    [paths.project, JSON.stringify(layer({ MID: { provider: "project", model: "mid" } }))],
  ]);
  const loaded = await loadImaConfig({ packageRoot: "/package", agentDir: "/agent", cwd: "/project", projectTrusted: true, readText: async (path) => {
    if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return files.get(path);
  } });

  assert.equal(loaded.diagnostics.length, 0);
  assert.deepEqual(loaded.config.models.MID, { provider: "project", model: "mid", source: "project" });
  assert.equal(loaded.config.complete, true);
});

test("does not read untrusted project configuration", async () => {
  const reads = [];
  const loaded = await loadImaConfig({ packageRoot: "/package", agentDir: "/agent", cwd: "/project", projectTrusted: false, readText: async (path) => {
    reads.push(path);
    if (path === "/package/config/defaults.json") return JSON.stringify(layer({}, null));
    if (path === "/agent/ima/config.json") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    throw new Error(`unexpected read: ${path}`);
  } });

  assert.equal(loaded.config.complete, false);
  assert.equal(reads.includes("/project/.pi/ima/config.json"), false);
});

test("fails explicit malformed or invalid higher-precedence input instead of falling back", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const readText = async (path) => {
    if (path === paths.packageDefaults) return JSON.stringify(layer({}, "preset"));
    if (path === paths.user) return "{bad json";
    if (path === "/package/config/presets/preset.json") return JSON.stringify(completeLayer());
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const loaded = await loadImaConfig({ packageRoot: "/package", agentDir: "/agent", cwd: "/project", projectTrusted: false, readText });

  assert.equal(loaded.config, null);
  assert.deepEqual(codes(loaded), ["config_json_invalid"]);
});

test("fails a malformed known role before exposing a lower-precedence route", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const files = new Map([
    [paths.packageDefaults, JSON.stringify(layer({}, "preset"))],
    [paths.user, JSON.stringify(layer({ HIGH: { provider: "user", model: "high", apiKey: "secret" } }))],
    [`${paths.presets}/preset.json`, JSON.stringify(completeLayer("preset"))],
  ]);
  const loaded = await loadImaConfig({
    packageRoot: "/package",
    agentDir: "/agent",
    cwd: "/project",
    projectTrusted: false,
    readText: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path);
    },
  });

  assert.equal(loaded.config, null);
  assert.ok(codes(loaded).includes("config_unknown_key"));
  assert.equal(loaded.config?.models.HIGH, undefined);
});

test("loads nonfatal command and phase warnings without blocking configured siblings", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const files = new Map([
    [paths.packageDefaults, JSON.stringify(layer({}, null))],
    [paths.user, JSON.stringify({
      schemaVersion: 1,
      stray: true,
      phases: { plan: { provider: "", model: "" }, test: role("provider", "test") },
      commands: { plan: role("provider", "plan"), typo: role("provider", "typo"), broken: "unsupported" },
    })],
  ]);
  const loaded = await loadImaConfig({
    packageRoot: "/package",
    agentDir: "/agent",
    cwd: "/project",
    projectTrusted: false,
    readText: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path);
    },
    readDirectory: async (path) => {
      if (path === "/package/prompts") return ["ima:plan.md"];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });

  assert.ok(loaded.config);
  assert.deepEqual(loaded.config.phases, { test: { provider: "provider", model: "test", thinking: "medium", source: "user" } });
  assert.deepEqual(loaded.config.commands, { plan: { provider: "provider", model: "plan", thinking: "medium", source: "user" } });
  for (const code of ["config_unknown_key", "config_invalid_provider", "config_invalid_phase", "config_invalid_command", "config_unknown_command"]) assert.ok(codes(loaded).includes(code), code);
});

test("drops prototype-collision command keys without inherited routes", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const files = new Map([
    [paths.packageDefaults, JSON.stringify(layer({}, null))],
    [paths.user, '{"schemaVersion":1,"commands":{"constructor":{"provider":"provider","model":"constructor"},"toString":{"provider":"provider","model":"to-string"},"__proto__":{"provider":"provider","model":"proto"}}}'],
  ]);
  const loaded = await loadImaConfig({
    packageRoot: "/package",
    agentDir: "/agent",
    cwd: "/project",
    projectTrusted: false,
    readText: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path);
    },
    readDirectory: async (path) => {
      if (path === "/package/prompts") return ["ima:plan.md"];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });

  assert.ok(loaded.config);
  assert.deepEqual(loaded.config.commands, {});
  assert.equal(Object.getPrototypeOf(loaded.config.commands), Object.prototype);
  for (const name of ["constructor", "toString", "__proto__"]) assert.equal(resolveCommandRoute(loaded.config, name), null);
  assert.equal(codes(loaded).filter((code) => code === "config_unknown_command").length, 3);

  Object.defineProperty(Object.prototype, "future-command", { configurable: true, value: "plan" });
  try {
    assert.equal(
      resolveCommandRoute({ commands: {}, phases: { plan: role("provider", "plan") } }, "future-command"),
      null,
    );
  } finally {
    delete Object.prototype["future-command"];
  }
});

test("exposes missing shorthand warnings without blocking sibling routes", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const files = new Map([
    [paths.packageDefaults, JSON.stringify(layer({}, "preset"))],
    [paths.user, JSON.stringify({ schemaVersion: 1, commands: { review: "xhigh" } })],
    [`${paths.presets}/preset.json`, JSON.stringify({ ...completeLayer("preset"), commands: { plan: role("preset", "plan") } })],
  ]);
  const loaded = await loadImaConfig({
    packageRoot: "/package",
    agentDir: "/agent",
    cwd: "/project",
    projectTrusted: false,
    readText: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path);
    },
    readDirectory: async (path) => {
      if (path === "/package/prompts") return ["ima:plan.md", "ima:review.md"];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });

  assert.ok(loaded.config);
  const missing = [{ source: "user", path: ["commands", "review"] }];
  const routeWarnings = (entries) => entries.filter(({ code }) => code === "config_route_role_missing").map(({ source, path }) => ({ source, path }));
  assert.deepEqual(routeWarnings(loaded.diagnostics), missing);
  assert.deepEqual(routeWarnings(loaded.config.diagnostics), missing);
  assert.deepEqual(resolveCommandRoute(loaded.config, "plan"), { provider: "preset", model: "plan", thinking: "medium" });
});

test("reports missing required defaults and an unknown selected preset without exposing content", async () => {
  const missingDefaults = await loadImaConfig({ packageRoot: "/package", agentDir: "/agent", cwd: "/project", projectTrusted: false, readText: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  assert.deepEqual(codes(missingDefaults), ["config_required_file_missing"]);

  const unknownPreset = await loadImaConfig({ packageRoot: "/package", agentDir: "/agent", cwd: "/project", projectTrusted: false, readText: async (path) => {
    if (path === "/package/config/defaults.json") return JSON.stringify(layer({}, "missing"));
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  } });
  assert.deepEqual(codes(unknownPreset), ["config_preset_unknown"]);
});


test("keeps optional quality roles out of completeness while merging their explicit mappings", () => {
  const resolved = mergeConfigLayers({
    packageDefaults: valid(layer({}, null)),
    preset: valid(completeLayer("p"), "preset"),
    user: valid(layer({ reviewVerify: role("verify", "model"), adversaryA: role("provider-a", "model-a"), XHIGH: role("provider-xhigh", "model-xhigh", "high") }), "user"),
    project: valid(layer({ adversaryA: role("provider-a-project", "model-a-project"), adversaryB: role("provider-b", "model-b"), XHIGH: { provider: "provider-xhigh-project", model: "model-xhigh-project" } }), "project"),
  });
  assert.equal(resolved.complete, true);
  assert.deepEqual(resolved.models.reviewVerify, { provider: "verify", model: "model", thinking: "medium", source: "user" });
  assert.deepEqual(resolved.models.adversaryA, { provider: "provider-a-project", model: "model-a-project", thinking: "medium", source: "project" });
  assert.deepEqual(resolved.models.adversaryB, { provider: "provider-b", model: "model-b", thinking: "medium", source: "project" });
  assert.deepEqual(resolved.models.XHIGH, { provider: "provider-xhigh-project", model: "model-xhigh-project", source: "project" });
});

test("accepts optional mappings and validates their catalog availability", () => {
  const accepted = validateConfigLayer(layer({ adversaryA: role("provider-a", "model-a"), adversaryB: role("provider-b", "model-b"), XHIGH: role("provider-xhigh", "model-xhigh", "xhigh") }), "user");
  assert.equal(accepted.valid, true);
  const resolved = mergeConfigLayers({ packageDefaults: valid(layer({}, null)), preset: valid(completeLayer("p"), "preset"), user: accepted.value, project: null });
  assert.equal(validateModelCatalog(resolved, [
    { provider: "p", model: "HIGH" }, { provider: "p", model: "MID" }, { provider: "p", model: "LOW" }, { provider: "p", model: "vision", input: ["image"] },
    { provider: "provider-a", model: "model-a" }, { provider: "provider-b", model: "model-b" }, { provider: "provider-xhigh", model: "model-xhigh" },
  ]).valid, true);
  const unavailable = validateModelCatalog(resolved, []);
  assert.deepEqual(unavailable.diagnostics.filter(({ path }) => ["adversaryA", "adversaryB", "XHIGH"].includes(path[1])).map(({ code, path }) => [code, path]), [
    ["config_model_unavailable", ["models", "adversaryA"]],
    ["config_model_unavailable", ["models", "adversaryB"]],
    ["config_model_unavailable", ["models", "XHIGH"]],
  ]);
});

test("resolves explicit phases and commands without inherited routes", () => {
  const phaseLayer = valid({
    schemaVersion: 1,
    phases: { plan: role("phase", "plan", "max"), implement: "mid" },
    commands: { "resolve-review": "high", "implement-js": role("command", "override"), custom: role("command", "custom") },
  }, "user");
  assert.deepEqual(Object.keys(phaseLayer.phases), ["plan", "implement"]);
  assert.deepEqual(phaseLayer.commands, { "resolve-review": "high", "implement-js": role("command", "override"), custom: role("command", "custom") });

  const resolved = mergeConfigLayers({ packageDefaults: valid(layer({}, null)), preset: valid(completeLayer("role"), "preset"), user: phaseLayer, project: null });
  assert.deepEqual(resolved.phases.plan, { provider: "phase", model: "plan", thinking: "max", source: "user" });
  assert.deepEqual(resolved.phases.implement, { provider: "role", model: "MID", thinking: "medium", source: "user" });
  assert.equal(resolved.phases.brainstorm, undefined);
  assert.deepEqual(resolved.commands["resolve-review"], { provider: "role", model: "HIGH", thinking: "medium", source: "user" });
  assert.deepEqual(resolveCommandRoute(resolved, "resolve-review"), { provider: "role", model: "HIGH", thinking: "medium" });
  assert.deepEqual(resolveCommandRoute(resolved, "implement-js"), { provider: "command", model: "override", thinking: "medium" });
  assert.deepEqual(resolveCommandRoute({ ...resolved, commands: {} }, "implement-js"), { provider: "role", model: "MID", thinking: "medium" });
  assert.equal(resolveCommandRoute(resolved, "unconfigured"), null);
  assert.deepEqual(IMA_PHASES, ["brainstorm", "plan", "implement", "test", "review", "resolution", "rereview", "document"]);
});

test("warns and drops missing shorthand roles while preserving valid routes", () => {
  const preset = valid({
    ...completeLayer("preset"),
    phases: { plan: role("preset", "phase-plan") },
    commands: { review: role("preset", "review") },
  }, "preset");
  const user = valid({
    schemaVersion: 1,
    phases: { plan: "xhigh", test: role("user", "test") },
    commands: { review: "xhigh", plan: role("user", "plan") },
  }, "user");
  const resolved = mergeConfigLayers({ packageDefaults: valid(layer({}, null)), preset, user, project: null });

  assert.deepEqual(resolved.phases.plan, { provider: "preset", model: "phase-plan", thinking: "medium", source: "preset" });
  assert.deepEqual(resolved.phases.test, { provider: "user", model: "test", thinking: "medium", source: "user" });
  assert.deepEqual(resolved.commands.review, { provider: "preset", model: "review", thinking: "medium", source: "preset" });
  assert.deepEqual(resolved.commands.plan, { provider: "user", model: "plan", thinking: "medium", source: "user" });
  assert.deepEqual(resolved.diagnostics.filter(({ code }) => code === "config_route_role_missing").map(({ source, path }) => ({ source, path })), [
    { source: "user", path: ["phases", "plan"] },
    { source: "user", path: ["commands", "review"] },
  ]);
  assert.equal(mergeConfigLayers({ packageDefaults: valid(layer({}, null)), preset, user: null, project: null }).diagnostics.some(({ code }) => code === "config_route_role_missing"), false);
});

test("loads the highest-precedence selected profile and applies trusted project overrides", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const defaults = JSON.stringify(layer({}, null));
  const user = JSON.stringify({ schemaVersion: 1, profile: "shared", phases: { document: role("user", "document") } });
  const project = JSON.stringify({ schemaVersion: 1, models: { MID: role("project", "mid") } });
  const shared = JSON.stringify({ schemaVersion: 1, models: { ...Object.fromEntries(IMA_MODEL_ROLES.map((name) => [name, role("project-profile", name)])), XHIGH: role("project-profile", "xhigh", "xhigh") }, phases: { implement: role("project-profile", "implement") } });
  const files = new Map([[paths.packageDefaults, defaults], [paths.user, user], [paths.project, project], [`${paths.projectProfiles}/shared.json`, shared]]);
  const loaded = await loadImaConfig({
    packageRoot: "/package", agentDir: "/agent", cwd: "/project", projectTrusted: true,
    readText: async (path) => { if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(path); },
  });
  assert.equal(loaded.diagnostics.length, 0);
  assert.equal(loaded.config.models.MID.provider, "project");
  assert.deepEqual(loaded.config.models.XHIGH, { provider: "project-profile", model: "xhigh", thinking: "xhigh", source: "preset" });
  assert.equal(loaded.config.phases.implement.model, "implement");
  assert.equal(loaded.config.phases.document.provider, "user");
});

test("validates the approved XHIGH mapping in every bundled preset", async () => {
  const expected = {
    anthropic: { provider: "anthropic", model: "claude-opus-4-7", thinking: "high" },
    hybrid: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh" },
    "openai-codex": { provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
    "openai-codex-56": { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh" },
    "openai-codex-56-max": { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh" },
  };
  for (const [name, mapping] of Object.entries(expected)) {
    const parsed = JSON.parse(await readFile(join(root, "config", "presets", `${name}.json`), "utf8"));
    const result = validateConfigLayer(parsed, "preset");
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.value?.models?.XHIGH, mapping, name);
  }
});

test("reports an explicit profile override as active", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const files = new Map([
    [paths.packageDefaults, JSON.stringify(layer({}, null))],
    [`${paths.presets}/session-profile.json`, JSON.stringify(completeLayer("session"))],
  ]);
  const loaded = await loadImaConfig({
    packageRoot: "/package", agentDir: "/agent", cwd: "/project", projectTrusted: false, profileOverride: "session-profile",
    readText: async (path) => { if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(path); },
  });
  assert.equal(loaded.diagnostics.length, 0);
  assert.equal(loaded.config?.profile, "session-profile");
  assert.equal(loaded.config?.sources.preset, "session-profile");
});

test("discovers profile files by trusted project, user, then package precedence", async () => {
  const paths = deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" });
  const directories = new Map([
    [paths.projectProfiles, ["same.json", "project-only.json"]],
    [paths.userProfiles, ["same.json", "user-only.json"]],
    [paths.presets, ["same.json", "package-only.json"]],
  ]);
  const files = new Map();
  for (const [directory, names] of directories) for (const name of names) files.set(`${directory}/${name}`, JSON.stringify({ schemaVersion: 1, models: {} }));
  const result = await discoverImaProfiles({
    paths,
    projectTrusted: true,
    readDirectory: async (directory) => directories.get(directory) ?? [],
    readText: async (path) => files.get(path),
    resolvePath: async (path) => path,
    stat: async () => ({ isFile: () => true }),
  });
  assert.deepEqual(result.profiles.map(({ name, source }) => ({ name, source })), [
    { name: "package-only", source: "package" },
    { name: "project-only", source: "project" },
    { name: "same", source: "project" },
    { name: "user-only", source: "user" },
  ]);
});
