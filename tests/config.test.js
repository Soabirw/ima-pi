import assert from "node:assert/strict";
import test from "node:test";
import {
  IMA_MODEL_ROLES,
  IMA_THINKING_LEVELS,
  deriveImaConfigPaths,
  loadImaConfig,
  mergeConfigLayers,
  resolveNamedResources,
  resolveSelectedProfile,
  validateConfigLayer,
  validateModelCatalog,
} from "../lib/ima-config.ts";

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

test("rejects invalid schema shapes, unknown fields, unknown roles, and secret-bearing fields", () => {
  const cases = [
    [{}, "config_schema_version_unsupported"],
    [[], "config_json_invalid"],
    [null, "config_json_invalid"],
    ["config", "config_json_invalid"],
    [1, "config_json_invalid"],
    [{ ...layer(), apiKey: "secret" }, "config_unknown_key"],
    [layer({ unknown: role("p", "m") }), "config_unknown_role"],
    [layer({ HIGH: { provider: "", model: "m" } }), "config_invalid_provider"],
    [layer({ HIGH: { provider: "p", model: "" } }), "config_invalid_model"],
    [layer({ HIGH: { provider: "p", model: "m", thinking: "invalid" } }), "config_invalid_thinking"],
    [{ ...layer(), profile: " " }, "config_invalid_profile"],
    [{ ...layer(), schemaVersion: 2 }, "config_schema_version_unsupported"],
    [{ schemaVersion: 1, models: [] }, "config_invalid_model"],
    [layer({ HIGH: { provider: "p", model: "m", apiKey: "secret" } }), "config_unknown_key"],
  ];

  for (const [input, expected] of cases) {
    const result = validateConfigLayer(input, "user");
    assert.equal(result.valid, false, `expected ${expected}`);
    assert.ok(codes(result).includes(expected));
  }
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

test("derives the exact package, user, and project configuration paths", () => {
  assert.deepEqual(deriveImaConfigPaths({ packageRoot: "/package", agentDir: "/agent", cwd: "/project" }), {
    packageDefaults: "/package/config/defaults.json",
    presets: "/package/config/presets",
    user: "/agent/ima/config.json",
    project: "/project/.pi/ima/config.json",
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
    user: valid(layer({ reviewVerify: role("verify", "model"), adversaryA: role("provider-a", "model-a") }), "user"),
    project: valid(layer({ adversaryA: role("provider-a-project", "model-a-project"), adversaryB: role("provider-b", "model-b") }), "project"),
  });
  assert.equal(resolved.complete, true);
  assert.deepEqual(resolved.models.reviewVerify, { provider: "verify", model: "model", thinking: "medium", source: "user" });
  assert.deepEqual(resolved.models.adversaryA, { provider: "provider-a-project", model: "model-a-project", thinking: "medium", source: "project" });
  assert.deepEqual(resolved.models.adversaryB, { provider: "provider-b", model: "model-b", thinking: "medium", source: "project" });
});

test("accepts adversary roles as optional mappings and validates their catalog availability", () => {
  const accepted = validateConfigLayer(layer({ adversaryA: role("provider-a", "model-a"), adversaryB: role("provider-b", "model-b") }), "user");
  assert.equal(accepted.valid, true);
  const resolved = mergeConfigLayers({ packageDefaults: valid(layer({}, null)), preset: valid(completeLayer("p"), "preset"), user: accepted.value, project: null });
  assert.equal(validateModelCatalog(resolved, [
    { provider: "p", model: "HIGH" }, { provider: "p", model: "MID" }, { provider: "p", model: "LOW" }, { provider: "p", model: "vision", input: ["image"] },
    { provider: "provider-a", model: "model-a" }, { provider: "provider-b", model: "model-b" },
  ]).valid, true);
  const unavailable = validateModelCatalog(resolved, []);
  assert.deepEqual(unavailable.diagnostics.filter(({ path }) => path[1].startsWith("adversary")).map(({ code, path }) => [code, path]), [
    ["config_model_unavailable", ["models", "adversaryA"]],
    ["config_model_unavailable", ["models", "adversaryB"]],
  ]);
});
