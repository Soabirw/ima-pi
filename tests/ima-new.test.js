import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { IMA_PHASES } from "../lib/ima-config.ts";
import {
  IMA_NEW_BOOTSTRAP_COMMANDS,
  IMA_NEW_PHASE_SKILLS,
  IMA_NEW_REQUEST_ENTRY,
  IMA_NEW_RESULT_ENTRY,
  buildImaNewBootstrapSequence,
  buildImaNewResult,
  injectImaNewBootstrap,
  resolveImaNewBootstrapMessages,
  latestImaNewRequest,
  latestImaNewResult,
  parseImaNewSelector,
  validateImaNewRequest,
  validateImaNewResult,
} from "../extensions/ima-new.ts";

const ready = (selector = null, route = null) => ({ selector, ok: true, route });
const root = fileURLToPath(new URL("..", import.meta.url));
const defaultParentSession = fileURLToPath(import.meta.url);
const commandSelectors = ["brainstorm", "plan", "implement", "implement-js", "implement-wp", "test", "review", "resolve-review", "rereview", "document"];
const defaultPhaseSkills = [...new Set([
  ...IMA_NEW_PHASE_SKILLS.plan,
  ...IMA_NEW_PHASE_SKILLS.implement,
])];
const defaultBootstrapCommands = [
  ...IMA_NEW_BOOTSTRAP_COMMANDS.map((name) => ({
    name,
    source: "prompt",
    sourceInfo: { path: join(root, "prompts", `${name}.md`) },
  })),
  ...commandSelectors.map((name) => ({
    name: `ima:${name}`,
    source: "prompt",
    sourceInfo: { path: join(root, "prompts", `ima:${name}.md`) },
  })),
  ...defaultPhaseSkills.map((name) => ({
    name: `skill:${name}`,
    source: "skill",
    sourceInfo: { path: join(root, "skills", name, "SKILL.md") },
  })),
];
const roleSelectors = { low: "LOW", mid: "MID", high: "HIGH", xhigh: "XHIGH" };
const allSelectors = [...Object.keys(roleSelectors), ...commandSelectors];

const createHarness = (options = {}) => {
  const availableCommands = Object.hasOwn(options, "availableCommands") ? options.availableCommands : defaultBootstrapCommands;
  const sessionFile = Object.hasOwn(options, "sessionFile") ? options.sessionFile : defaultParentSession;
  const cwd = Object.hasOwn(options, "cwd") ? options.cwd : root;
  const projectTrusted = Object.hasOwn(options, "projectTrusted") ? options.projectTrusted : false;
  const modelRegistry = Object.hasOwn(options, "modelRegistry") ? options.modelRegistry : {
    find: () => ({ provider: "old", id: "old-model" }),
    hasConfiguredAuth: () => true,
  };
  let currentModel = Object.hasOwn(options, "model") ? options.model : { provider: "old", id: "old-model" };
  let currentThinking = Object.hasOwn(options, "thinking") ? options.thinking : "medium";
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const messages = [];
  const editor = [];
  let commandLookups = 0;
  let sessionStarts = 0;
  let branch = [];
  let entryNumber = 0;
  let replacementOptions;
  const appendBranchEntry = (entry) => branch.push({ ...entry, id: `entry-${entryNumber++}` });
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => appendBranchEntry({ type: "custom", customType, data }),
    getThinkingLevel: () => currentThinking,
    setThinkingLevel: (next) => { currentThinking = next; },
    setModel: async (next) => { currentModel = next; return true; },
    getCommands: () => {
      commandLookups += 1;
      return availableCommands;
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    isProjectTrusted: () => projectTrusted,
    modelRegistry,
    get model() { return currentModel; },
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setEditorText: (text) => editor.push(text),
    },
    newSession: async (options) => {
      replacementOptions = options;
      branch = [];
      entryNumber = 0;
      await options.setup({
        appendCustomEntry: (customType, data) => appendBranchEntry({ type: "custom", customType, data }),
      });
      const replacementContext = {
        hasUI: true,
        cwd,
        isProjectTrusted: () => projectTrusted,
        modelRegistry,
        get model() { return currentModel; },
        isIdle: () => true,
        ui: {
          notify: (message, level) => notifications.push({ message, level }),
          setEditorText: (text) => editor.push(text),
        },
        sessionManager: {
          getBranch: () => branch,
          getLeafId: () => branch.at(-1)?.id ?? null,
        },
        sendUserMessage: async (message) => messages.push(message),
        waitForIdle: async () => appendBranchEntry({ type: "message", message: { role: "assistant", stopReason: "stop" } }),
      };
      sessionStarts += 1;
      await handlers.get("session_start")({}, replacementContext);
      await options.withSession(replacementContext);
      return { cancelled: false };
    },
  };
  return { pi, ctx, handlers, commands, notifications, messages, editor, get branch() { return branch; }, get commandLookups() { return commandLookups; }, get sessionStarts() { return sessionStarts; }, get replacementOptions() { return replacementOptions; } };
};

const createBootstrapHarness = (outcomes = ["stop", "stop"], initialEntries = []) => {
  let branch = [...initialEntries];
  let turn = 0;
  const calls = [];
  const editor = [];
  const context = {
    sessionManager: {
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    sendUserMessage: async (message) => calls.push(["send", message]),
    waitForIdle: async () => {
      const stopReason = outcomes[turn++];
      if (stopReason !== "missing") {
        branch = [...branch, { type: "message", id: `turn-${turn}`, message: { role: "assistant", stopReason } }];
      }
      calls.push(["wait"]);
    },
    ui: { setEditorText: (text) => { editor.push(text); calls.push(["editor", text]); } },
  };
  return { context, calls, editor, get branch() { return branch; } };
};

test("accepts role selectors and discovered command selectors only", () => {
  assert.deepEqual(parseImaNewSelector("", commandSelectors), { ok: true, selector: null });
  for (const selector of allSelectors) {
    assert.deepEqual(parseImaNewSelector(`  ${selector}  `, commandSelectors), { ok: true, selector });
  }
  for (const value of ["HIGH", "xhigh extra", "plan extra", "/ima:plan", "high\nplan", "--save", "unknown", null, 1]) {
    assert.deepEqual(parseImaNewSelector(value, commandSelectors), { ok: false, error: "selector_invalid" });
  }
});

test("validates and restores only sanitized command-keyed request and result entries", () => {
  for (const selector of allSelectors) {
    assert.deepEqual(validateImaNewRequest({ selector }), { valid: true, value: { selector } });
  }
  assert.equal(validateImaNewRequest({ selector: "high", extra: true }).valid, false);
  for (const [selector, role] of Object.entries(roleSelectors)) {
    const route = { role, provider: "p", model: "m", thinking: "high" };
    assert.deepEqual(validateImaNewResult(ready(selector, route)), { valid: true, value: { selector, ok: true, route } });
  }
  for (const command of commandSelectors) {
    const route = { command, provider: "p", model: "m" };
    assert.deepEqual(validateImaNewResult(ready(command, route)), { valid: true, value: { selector: command, ok: true, route } });
  }
  assert.deepEqual(validateImaNewResult(ready("unconfigured", null)), { valid: true, value: ready("unconfigured", null) });
  assert.equal(validateImaNewResult(ready("xhigh", { role: "HIGH", provider: "p", model: "m" })).valid, false);
  assert.equal(validateImaNewResult(ready("low", { role: "MID", provider: "p", model: "m" })).valid, false);
  assert.equal(validateImaNewResult(ready("plan", { role: "HIGH", provider: "p", model: "m" })).valid, false);
  assert.equal(validateImaNewResult(ready("implement", { command: "plan", provider: "p", model: "m" })).valid, false);
  assert.equal(validateImaNewResult(ready("plan", { command: "unsupported/path", provider: "p", model: "m" })).valid, false);
  assert.equal(validateImaNewResult(ready("xhigh")).valid, false);
  assert.deepEqual(validateImaNewResult({ selector: "high", ok: false, error: "secret-token" }), { valid: false, error: "result_invalid" });
  const entries = [
    { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector: "unsafe/path" } },
    { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector: "document" } },
    { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector: "document", ok: false, error: "secret-token" } },
    { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector: "document", ok: true, route: { command: "document", provider: "p", model: "m" } } },
  ];
  assert.deepEqual(latestImaNewRequest(entries), { selector: "document" });
  assert.deepEqual(latestImaNewResult(entries), ready("document", { command: "document", provider: "p", model: "m" }));
});

test("shares command-route result sanitization and keeps resolved bootstrap bodies in order", () => {
  for (const [selector, role] of Object.entries(roleSelectors)) {
    assert.deepEqual(
      buildImaNewResult(selector, { ok: true, route: { role, provider: "p", model: "m", thinking: "max" } }),
      { selector, ok: true, route: { role, provider: "p", model: "m", thinking: "max" } },
    );
  }
  for (const command of commandSelectors) {
    assert.deepEqual(
      buildImaNewResult(command, { ok: true, route: { command, provider: "p", model: "m" } }),
      { selector: command, ok: true, route: { command, provider: "p", model: "m" } },
    );
  }
  const failed = buildImaNewResult("high", { ok: false, error: "unexpected secret" });
  const mismatched = buildImaNewResult("xhigh", { ok: true, route: { role: "HIGH", provider: "p", model: "m" } });
  const bodies = ["Serena bootstrap body", "Vestige bootstrap body"];
  assert.deepEqual(failed, { selector: "high", ok: false, error: "route_apply_failed" });
  assert.deepEqual(mismatched, { selector: "xhigh", ok: false, error: "route_apply_failed" });
  assert.deepEqual(buildImaNewResult("unconfigured", null), ready("unconfigured", null));
  assert.deepEqual(buildImaNewBootstrapSequence(ready(), bodies), bodies);
  assert.deepEqual(buildImaNewBootstrapSequence(failed, bodies), []);
});

test("injects resolved Serena before Vestige bodies, waits between turns, and never writes the editor", async () => {
  const harness = createBootstrapHarness();
  const bodies = ["Serena bootstrap body", "Vestige bootstrap body"];
  await injectImaNewBootstrap(harness.context, ready(), bodies);
  assert.deepEqual(harness.calls, [
    ["send", bodies[0]],
    ["wait"],
    ["send", bodies[1]],
    ["wait"],
  ]);
  assert.equal(harness.calls.some(([type, value]) => type === "send" && typeof value === "string" && value.startsWith("/ima:")), false);
});

test("resolves planned prompt and skill resources through sourceInfo.path and strips frontmatter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-bootstrap-"));
  const paths = IMA_NEW_BOOTSTRAP_COMMANDS.map((name) => join(directory, `${name}.md`));
  const skillPath = join(directory, "ima-lifecycle-contract.md");
  const readableCodeSkillPath = join(directory, "readable-code.md");
  const functionalProgrammerSkillPath = join(directory, "functional-programmer.md");
  const securityGuardrailsSkillPath = join(directory, "ima-security-guardrails.md");
  await writeFile(paths[0], "---\ndescription: Serena\n---\nSerena bootstrap body\n");
  await writeFile(paths[1], "---\ndescription: Vestige\n---\nVestige bootstrap body\n");
  await writeFile(skillPath, "---\nname: ima-lifecycle-contract\ndescription: Lifecycle\n---\nLifecycle contract body\n");
  await writeFile(readableCodeSkillPath, "---\nname: readable-code\ndescription: Readability\n---\nReadable code body\n");
  await writeFile(functionalProgrammerSkillPath, "---\nname: functional-programmer\ndescription: Functional programming\n---\nFunctional programmer body\n");
  await writeFile(securityGuardrailsSkillPath, "---\nname: ima-security-guardrails\ndescription: Security\n---\nSecurity guardrails body\n");
  const commands = [
    ...IMA_NEW_BOOTSTRAP_COMMANDS.map((name, index) => ({
      name,
      source: "prompt",
      sourceInfo: { path: paths[index] },
    })),
    { name: "skill:ima-lifecycle-contract", source: "skill", sourceInfo: { path: skillPath } },
    { name: "skill:readable-code", source: "skill", sourceInfo: { path: readableCodeSkillPath } },
    { name: "skill:functional-programmer", source: "skill", sourceInfo: { path: functionalProgrammerSkillPath } },
    { name: "skill:ima-security-guardrails", source: "skill", sourceInfo: { path: securityGuardrailsSkillPath } },
  ];

  assert.deepEqual(IMA_NEW_PHASE_SKILLS.plan, [
    "ima-lifecycle-contract",
    "readable-code",
    "functional-programmer",
    "ima-security-guardrails",
  ]);
  assert.deepEqual(IMA_NEW_PHASE_SKILLS.implement, ["readable-code"]);
  for (const phase of IMA_PHASES.filter((phase) => phase !== "plan" && phase !== "implement")) assert.deepEqual(IMA_NEW_PHASE_SKILLS[phase], []);
  assert.deepEqual(
    await resolveImaNewBootstrapMessages({ getCommands: () => commands }),
    ["Serena bootstrap body", "Vestige bootstrap body"],
  );
  assert.deepEqual(
    await resolveImaNewBootstrapMessages({ getCommands: () => commands }, "plan"),
    [
      "Serena bootstrap body",
      "Vestige bootstrap body",
      "Lifecycle contract body",
      "Readable code body",
      "Functional programmer body",
      "Security guardrails body",
    ],
  );
  assert.deepEqual(
    await resolveImaNewBootstrapMessages({ getCommands: () => commands }, "implement"),
    ["Serena bootstrap body", "Vestige bootstrap body", "Readable code body"],
  );
});

test("does not inherit fallback aliases for fresh-session skills", async () => {
  const pi = { getCommands: () => defaultBootstrapCommands };
  Object.defineProperty(Object.prototype, "future-command", { configurable: true, value: "plan" });
  try {
    assert.deepEqual(
      await resolveImaNewBootstrapMessages(pi, "future-command"),
      await resolveImaNewBootstrapMessages(pi),
    );
  } finally {
    delete Object.prototype["future-command"];
  }
});

test("rejects missing, ambiguous, wrong-source, unreadable, and empty bootstrap resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-bootstrap-invalid-"));
  const paths = IMA_NEW_BOOTSTRAP_COMMANDS.map((name) => join(directory, `${name}.md`));
  await writeFile(paths[0], "Serena bootstrap body");
  await writeFile(paths[1], "Vestige bootstrap body");
  const validCommands = IMA_NEW_BOOTSTRAP_COMMANDS.map((name, index) => ({
    name,
    source: "prompt",
    sourceInfo: { path: paths[index] },
  }));
  const cases = [
    validCommands.slice(0, 1),
    [...validCommands, validCommands[0]],
    [validCommands[0], { ...validCommands[1], source: "extension" }],
    [validCommands[0], { ...validCommands[1], sourceInfo: { path: join(directory, "missing.md") } }],
  ];

  await assert.rejects(
    () => resolveImaNewBootstrapMessages({ getCommands: () => validCommands }, "plan"),
    /bootstrap_resource_unavailable/,
  );

  await writeFile(paths[1], "");
  cases.push(validCommands);

  for (const commands of cases) {
    await assert.rejects(
      () => resolveImaNewBootstrapMessages({ getCommands: () => commands }),
      /bootstrap_resource_unavailable/,
    );
  }
});

test("creates an unlinked fresh session when the parent is absent", async () => {
  const harness = createHarness({ sessionFile: undefined });
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("", harness.ctx);

  assert.equal(Object.hasOwn(harness.replacementOptions, "parentSession"), false);
  assert.deepEqual(harness.branch.filter(({ type }) => type === "custom").map(({ type, customType, data }) => ({ type, customType, data })), [
    { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector: null } },
    { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector: null, ok: true, route: null } },
  ]);
  assert.deepEqual(harness.messages, await resolveImaNewBootstrapMessages(harness.pi));
  assert.deepEqual(harness.editor, []);
  assert.deepEqual(harness.notifications, []);
});

test("creates an unlinked fresh session when the parent is allocated but unwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-parent-"));
  const sessionFile = join(directory, "allocated-session.jsonl");
  await assert.rejects(() => stat(sessionFile));
  const harness = createHarness({ sessionFile });
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("", harness.ctx);

  assert.equal(Object.hasOwn(harness.replacementOptions, "parentSession"), false);
  assert.equal(harness.sessionStarts, 1);
  assert.deepEqual(harness.messages, await resolveImaNewBootstrapMessages(harness.pi));
  assert.deepEqual(harness.editor, []);
  assert.deepEqual(harness.notifications, []);
});

test("creates an unlinked fresh session when the parent is a non-file", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "ima-new-parent-directory-"));
  assert.equal((await stat(sessionDirectory)).isFile(), false);
  const harness = createHarness({ sessionFile: sessionDirectory });
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("", harness.ctx);

  assert.equal(Object.hasOwn(harness.replacementOptions, "parentSession"), false);
  assert.equal(harness.sessionStarts, 1);
  assert.deepEqual(harness.messages, await resolveImaNewBootstrapMessages(harness.pi));
  assert.deepEqual(harness.editor, []);
  assert.deepEqual(harness.notifications, []);
});

test("creates an unlinked fresh session when the parent is inaccessible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-parent-inaccessible-"));
  const inaccessibleDirectory = join(directory, "inaccessible");
  const sessionFile = join(inaccessibleDirectory, "session.jsonl");
  await mkdir(inaccessibleDirectory);
  await writeFile(sessionFile, "session");
  await chmod(inaccessibleDirectory, 0o000);
  try {
    await assert.rejects(() => stat(sessionFile), { code: "EACCES" });
    const harness = createHarness({ sessionFile });
    const { default: registerImaNew } = await import("../extensions/ima-new.ts");
    registerImaNew(harness.pi);
    await harness.commands.get("ima:new").handler("", harness.ctx);

    assert.equal(Object.hasOwn(harness.replacementOptions, "parentSession"), false);
    assert.equal(harness.sessionStarts, 1);
    assert.deepEqual(harness.messages, await resolveImaNewBootstrapMessages(harness.pi));
    assert.deepEqual(harness.editor, []);
    assert.deepEqual(harness.notifications, []);
  } finally {
    await chmod(inaccessibleDirectory, 0o700);
  }
});

test("does not replace or prefill when bootstrap resources are unavailable", async () => {
  const harness = createHarness({ availableCommands: [] });
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("", harness.ctx);

  assert.equal(harness.replacementOptions, undefined);
  assert.deepEqual(harness.editor, []);
  assert.equal(harness.notifications.at(-1)?.message, "Fresh session bootstrap resources were unavailable.");
});

test("does not replace or prefill a plan session when its lifecycle skill is unavailable", async () => {
  const harness = createHarness({ availableCommands: defaultBootstrapCommands.filter(({ source }) => source !== "skill") });
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("plan", harness.ctx);

  assert.equal(harness.replacementOptions, undefined);
  assert.deepEqual(harness.editor, []);
  assert.equal(harness.notifications.at(-1)?.message, "Fresh session bootstrap resources were unavailable.");
});

test("stops after a partial bootstrap failure without writing the editor", async () => {
  const harness = createBootstrapHarness();
  harness.context.sendUserMessage = async (message) => {
    harness.calls.push(["send", message]);
    if (message === "Vestige bootstrap body") throw new Error("send failed");
  };
  await assert.rejects(
    () => injectImaNewBootstrap(harness.context, ready(), ["Serena bootstrap body", "Vestige bootstrap body"]),
  );
  assert.deepEqual(harness.calls, [
    ["send", "Serena bootstrap body"],
    ["wait"],
    ["send", "Vestige bootstrap body"],
  ]);
  assert.equal(harness.calls.some(([type]) => type === "editor"), false);
});

test("rejects unsuccessful Serena terminal states before sending Vestige or writing the editor", async () => {
  for (const stopReason of ["error", "aborted", "length", "pending", "toolUse", "unexpected", "missing"]) {
    const harness = createBootstrapHarness([stopReason, "stop"]);
    await assert.rejects(
      () => injectImaNewBootstrap(harness.context, ready(), ["Serena bootstrap body", "Vestige bootstrap body"]),
      /bootstrap_turn_failed/,
    );
    assert.deepEqual(harness.calls, [["send", "Serena bootstrap body"], ["wait"]]);
    assert.deepEqual(harness.editor, []);
  }
});

test("does not accept a stale prior assistant stop for a new bootstrap turn", async () => {
  const harness = createBootstrapHarness(["missing", "stop"], [
    { type: "message", id: "stale", message: { role: "assistant", stopReason: "stop" } },
  ]);
  await assert.rejects(
    () => injectImaNewBootstrap(harness.context, ready(), ["Serena bootstrap body", "Vestige bootstrap body"]),
    /bootstrap_turn_failed/,
  );
  assert.deepEqual(harness.calls, [["send", "Serena bootstrap body"], ["wait"]]);
  assert.deepEqual(harness.editor, []);
});

test("stops after a failed Vestige terminal result without writing the editor", async () => {
  const harness = createBootstrapHarness(["stop", "error"]);
  await assert.rejects(
    () => injectImaNewBootstrap(harness.context, ready(), ["Serena bootstrap body", "Vestige bootstrap body"]),
    /bootstrap_turn_failed/,
  );
  assert.deepEqual(harness.calls, [
    ["send", "Serena bootstrap body"],
    ["wait"],
    ["send", "Vestige bootstrap body"],
    ["wait"],
  ]);
  assert.deepEqual(harness.editor, []);
});

test("stops after a failed plan-skill terminal result without writing the editor", async () => {
  const harness = createBootstrapHarness(["stop", "stop", "error"]);
  const messages = ["Serena bootstrap body", "Vestige bootstrap body", "Lifecycle contract body"];
  await assert.rejects(
    () => injectImaNewBootstrap(harness.context, ready(), messages, [...IMA_NEW_BOOTSTRAP_COMMANDS, "skill:ima-lifecycle-contract"]),
    /bootstrap_turn_failed/,
  );
  assert.deepEqual(harness.calls, [
    ["send", "Serena bootstrap body"],
    ["wait"],
    ["send", "Vestige bootstrap body"],
    ["wait"],
    ["send", "Lifecycle contract body"],
    ["wait"],
  ]);
  assert.deepEqual(harness.editor, []);
});

test("creates a parent-linked bare fresh session and runs the replacement lifecycle", async () => {
  assert.equal((await stat(defaultParentSession)).isFile(), true);
  const harness = createHarness();
  harness.pi.default = undefined;
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("", harness.ctx);

  assert.equal(harness.replacementOptions.parentSession, defaultParentSession);
  assert.deepEqual(harness.branch.filter(({ type }) => type === "custom").map(({ type, customType, data }) => ({ type, customType, data })), [
    { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector: null } },
    { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector: null, ok: true, route: null } },
  ]);
  assert.deepEqual(harness.messages, await resolveImaNewBootstrapMessages(harness.pi));
  assert.deepEqual(harness.editor, []);
  assert.equal(harness.messages.includes("/ima:plan"), false);
});

const writeCompleteRouteConfig = async (directory) => {
  const configDirectory = join(directory, ".pi", "ima");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "config.json"), JSON.stringify({
    schemaVersion: 1,
    profile: null,
    models: {
      HIGH: { provider: "provider", model: "high" },
      MID: { provider: "provider", model: "mid" },
      LOW: { provider: "provider", model: "low" },
      vision: { provider: "provider", model: "vision" },
      XHIGH: { provider: "provider", model: "xhigh", thinking: "xhigh" },
    },
    phases: Object.fromEntries(IMA_PHASES.map((phase) => [phase, { provider: "provider", model: phase }])),
  }));
};

const routedHarnessOptions = (directory) => ({
  cwd: directory,
  projectTrusted: true,
  modelRegistry: {
    find: (provider, model) => ({ provider, id: model }),
    hasConfiguredAuth: () => true,
  },
});

test("dispatches every role selector to its exact configured role before bootstrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-roles-"));
  await writeCompleteRouteConfig(directory);
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");

  for (const [selector, role] of Object.entries(roleSelectors)) {
    const harness = createHarness(routedHarnessOptions(directory));
    registerImaNew(harness.pi);
    await harness.commands.get("ima:new").handler(selector, harness.ctx);
    const route = { profile: null, role, provider: "provider", model: selector, ...(selector === "xhigh" ? { thinking: "xhigh" } : {}) };
    const evidence = { role, provider: "provider", model: selector, ...(selector === "xhigh" ? { thinking: "xhigh" } : {}) };
    assert.deepEqual(harness.branch.filter(({ type }) => type === "custom").map(({ type, customType, data }) => ({ type, customType, data })), [
      { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector } },
      { type: "custom", customType: "ima-role-route", data: route },
      { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector, ok: true, route: evidence } },
    ]);
    assert.deepEqual(harness.messages, await resolveImaNewBootstrapMessages(harness.pi));
    assert.deepEqual(harness.editor, []);
  }
});

test("dispatches every discovered command selector through the shared command lookup before bootstrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-commands-"));
  await writeCompleteRouteConfig(directory);
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  const fallbackPhase = { "resolve-review": "resolution", "implement-js": "implement", "implement-wp": "implement" };

  for (const command of commandSelectors) {
    const harness = createHarness(routedHarnessOptions(directory));
    registerImaNew(harness.pi);
    await harness.commands.get("ima:new").handler(command, harness.ctx);
    const model = fallbackPhase[command] ?? command;
    const route = { profile: null, command, provider: "provider", model };
    const evidence = { command, provider: "provider", model };
    assert.deepEqual(harness.branch.filter(({ type }) => type === "custom").map(({ type, customType, data }) => ({ type, customType, data })), [
      { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector: command } },
      { type: "custom", customType: "ima-phase-route", data: route },
      { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector: command, ok: true, route: evidence } },
    ]);
    assert.deepEqual(harness.messages, await resolveImaNewBootstrapMessages(harness.pi, command));
    assert.deepEqual(harness.editor, []);
  }
});

test("starts an unconfigured discovered command without changing the session model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-passthrough-"));
  await writeCompleteRouteConfig(directory);
  const custom = { name: "ima:custom", source: "prompt", sourceInfo: { path: join(root, "prompts", "ima:plan.md") } };
  const harness = createHarness({ ...routedHarnessOptions(directory), availableCommands: [...defaultBootstrapCommands, custom] });
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("custom", harness.ctx);

  assert.deepEqual(harness.branch.filter(({ type }) => type === "custom").map(({ type, customType, data }) => ({ type, customType, data })), [
    { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector: "custom" } },
    { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector: "custom", ok: true, route: null } },
  ]);
});

test("rejects non-TUI, busy, and invalid invocations before replacement", async () => {
  const harness = createHarness();
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  let replacements = 0;
  harness.ctx.newSession = async () => { replacements += 1; return { cancelled: false }; };
  harness.ctx.mode = "print";
  await harness.commands.get("ima:new").handler("", harness.ctx);
  harness.ctx.mode = "tui";
  harness.ctx.isIdle = () => false;
  await harness.commands.get("ima:new").handler("", harness.ctx);
  harness.ctx.isIdle = () => true;
  await harness.commands.get("ima:new").handler("unknown", harness.ctx);
  assert.equal(replacements, 0);
  assert.equal(harness.notifications.length, 3);
});
