import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  IMA_NEW_BOOTSTRAP_COMMANDS,
  IMA_NEW_PLAN_HINT,
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
const defaultBootstrapCommands = IMA_NEW_BOOTSTRAP_COMMANDS.map((name) => ({
  name,
  source: "prompt",
  sourceInfo: { path: join(root, "prompts", `${name}.md`) },
}));

const createHarness = (options = {}) => {
  const availableCommands = Object.hasOwn(options, "availableCommands") ? options.availableCommands : defaultBootstrapCommands;
  const sessionFile = Object.hasOwn(options, "sessionFile") ? options.sessionFile : defaultParentSession;
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
    getCommands: () => {
      commandLookups += 1;
      return availableCommands;
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
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

test("accepts only the closed ima:new selector set", () => {
  assert.deepEqual(parseImaNewSelector(""), { ok: true, selector: null });
  assert.deepEqual(parseImaNewSelector("  high  "), { ok: true, selector: "high" });
  assert.deepEqual(parseImaNewSelector("plan"), { ok: true, selector: "plan" });
  for (const value of ["HIGH", "plan extra", "/ima:plan", "high\nplan", "--save", null, 1]) {
    assert.deepEqual(parseImaNewSelector(value), { ok: false, error: "selector_invalid" });
  }
});

test("validates and restores only sanitized request and result entries", () => {
  assert.deepEqual(validateImaNewRequest({ selector: "high" }), { valid: true, value: { selector: "high" } });
  assert.equal(validateImaNewRequest({ selector: "high", extra: true }).valid, false);
  assert.deepEqual(validateImaNewResult(ready("high", { role: "HIGH", provider: "p", model: "m", thinking: "high" })), {
    valid: true,
    value: { selector: "high", ok: true, route: { role: "HIGH", provider: "p", model: "m", thinking: "high" } },
  });
  assert.deepEqual(validateImaNewResult({ selector: "high", ok: false, error: "secret-token" }), { valid: false, error: "result_invalid" });
  const entries = [
    { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector: "unsafe" } },
    { type: "custom", customType: IMA_NEW_REQUEST_ENTRY, data: { selector: "plan" } },
    { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector: "plan", ok: false, error: "secret-token" } },
    { type: "custom", customType: IMA_NEW_RESULT_ENTRY, data: { selector: "plan", ok: true, route: null } },
  ];
  assert.deepEqual(latestImaNewRequest(entries), { selector: "plan" });
  assert.deepEqual(latestImaNewResult(entries), ready("plan"));
});

test("shares route result sanitization and keeps resolved bootstrap bodies in order", () => {
  const role = buildImaNewResult("high", { ok: true, route: { role: "HIGH", provider: "p", model: "m", thinking: "max" } });
  const phase = buildImaNewResult("plan", { ok: true, route: { phase: "plan", provider: "p", model: "m" } });
  const failed = buildImaNewResult("high", { ok: false, error: "unexpected secret" });
  const bodies = ["Serena bootstrap body", "Vestige bootstrap body"];
  assert.deepEqual(role, { selector: "high", ok: true, route: { role: "HIGH", provider: "p", model: "m", thinking: "max" } });
  assert.deepEqual(phase, { selector: "plan", ok: true, route: { phase: "plan", provider: "p", model: "m" } });
  assert.deepEqual(failed, { selector: "high", ok: false, error: "route_apply_failed" });
  assert.deepEqual(buildImaNewBootstrapSequence(ready(), bodies), bodies);
  assert.deepEqual(buildImaNewBootstrapSequence(failed, bodies), []);
});

test("injects resolved Serena before Vestige bodies, waits between turns, and leaves an unsubmitted plan hint", async () => {
  const harness = createBootstrapHarness();
  const bodies = ["Serena bootstrap body", "Vestige bootstrap body"];
  await injectImaNewBootstrap(harness.context, ready(), bodies);
  assert.deepEqual(harness.calls, [
    ["send", bodies[0]],
    ["wait"],
    ["send", bodies[1]],
    ["wait"],
    ["editor", IMA_NEW_PLAN_HINT],
  ]);
  assert.equal(harness.calls.some(([type, value]) => type === "send" && typeof value === "string" && value.startsWith("/ima:")), false);
});

test("resolves exact prompt resources through sourceInfo.path and strips frontmatter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-bootstrap-"));
  const paths = IMA_NEW_BOOTSTRAP_COMMANDS.map((name) => join(directory, `${name}.md`));
  await writeFile(paths[0], "---\ndescription: Serena\n---\nSerena bootstrap body\n");
  await writeFile(paths[1], "---\ndescription: Vestige\n---\nVestige bootstrap body\n");

  const messages = await resolveImaNewBootstrapMessages({
    getCommands: () => IMA_NEW_BOOTSTRAP_COMMANDS.map((name, index) => ({
      name,
      source: "prompt",
      sourceInfo: { path: paths[index] },
    })),
  });
  assert.deepEqual(messages, ["Serena bootstrap body", "Vestige bootstrap body"]);
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

  await writeFile(paths[1], "");
  cases.push(validCommands);

  for (const commands of cases) {
    await assert.rejects(
      () => resolveImaNewBootstrapMessages({ getCommands: () => commands }),
      /bootstrap_resource_unavailable/,
    );
  }
});

test("requires a persisted parent before resource lookup or replacement", async () => {
  const harness = createHarness({ availableCommands: null, sessionFile: undefined });
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("", harness.ctx);

  assert.equal(harness.commandLookups, 0);
  assert.equal(harness.replacementOptions, undefined);
  assert.deepEqual(harness.branch, []);
  assert.deepEqual(harness.messages, []);
  assert.deepEqual(harness.editor, []);
  assert.deepEqual(harness.notifications, [{
    message: "ima:new requires a persisted parent session; restart Pi without --no-session.",
    level: "warning",
  }]);
});

test("rejects an allocated but unwritten parent before routing or replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ima-new-parent-"));
  const sessionFile = join(directory, "allocated-session.jsonl");
  await assert.rejects(() => stat(sessionFile));
  const harness = createHarness({ availableCommands: null, sessionFile });
  const { default: registerImaNew } = await import("../extensions/ima-new.ts");
  registerImaNew(harness.pi);
  await harness.commands.get("ima:new").handler("high", harness.ctx);

  assert.equal(harness.commandLookups, 0);
  assert.equal(harness.sessionStarts, 0);
  assert.equal(harness.replacementOptions, undefined);
  assert.deepEqual(harness.branch, []);
  assert.deepEqual(harness.messages, []);
  assert.deepEqual(harness.editor, []);
  assert.deepEqual(harness.notifications, [{
    message: "ima:new requires a persisted parent session; restart Pi without --no-session.",
    level: "warning",
  }]);
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

test("stops after a partial bootstrap failure without injecting a plan hint", async () => {
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

test("rejects unsuccessful Serena terminal states before sending Vestige or setting the hint", async () => {
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

test("stops after a failed Vestige terminal result without injecting a plan hint", async () => {
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
  assert.deepEqual(harness.editor, [IMA_NEW_PLAN_HINT]);
  assert.equal(harness.messages.includes("/ima:plan"), false);
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
