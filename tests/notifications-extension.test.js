import assert from "node:assert/strict";
import test from "node:test";
import notificationsExtension from "../extensions/notifications.ts";

const enabledConfig = (enable = true) => ({
  valid: true,
  config: { enable },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushPromises = async () => {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
};

const createContext = ({
  mode = "tui",
  hasUI = true,
  isIdle = () => true,
} = {}) => ({ mode, hasUI, isIdle });

const createHarness = ({
  config = enabledConfig(),
  loadConfig = async () => config,
  platform = "linux",
  exec = async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
} = {}) => {
  const handlers = new Map();
  const scheduled = [];
  const controllers = [];
  const calls = {
    loadConfig: 0,
    exec: [],
    cancelledSchedules: 0,
  };

  notificationsExtension({
    on: (event, handler) => handlers.set(event, handler),
    exec: async (command, args, options) => {
      calls.exec.push({ command, args, options });
      return exec(command, args, options);
    },
  }, {
    loadConfig: async () => {
      calls.loadConfig += 1;
      return loadConfig();
    },
    getPlatform: () => platform,
    schedule: (callback) => {
      const scheduledCallback = { callback, cancelled: false };
      scheduled.push(scheduledCallback);
      return scheduledCallback;
    },
    cancelSchedule: (scheduledCallback) => {
      scheduledCallback.cancelled = true;
      calls.cancelledSchedules += 1;
    },
    createAbortController: () => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller;
    },
  });

  const emit = (event, payload = {}, ctx = createContext()) =>
    handlers.get(event)(payload, ctx);

  const runScheduled = async (scheduledCallback) => {
    scheduledCallback.callback();
    await flushPromises();
  };

  return {
    calls,
    controllers,
    emit,
    handlers,
    runScheduled,
    scheduled,
  };
};

const expectedLinuxCommand = {
  command: "/usr/bin/notify-send",
  args: [
    "--app-name=Pi",
    "--urgency=normal",
    "--hint=string:sound-name:message-new-instant",
    "Pi",
    "Pi is ready for your input",
  ],
};

test("registers only notification lifecycle handlers and remains lazy at startup", () => {
  const harness = createHarness();
  const ctx = createContext();

  assert.deepEqual([...harness.handlers.keys()], [
    "session_start",
    "agent_start",
    "input",
    "before_agent_start",
    "agent_settled",
    "ui_prompt_start",
    "ui_prompt_end",
    "session_tree",
    "session_shutdown",
  ]);

  harness.emit("session_start", {}, ctx);
  assert.equal(harness.calls.loadConfig, 0);
  assert.deepEqual(harness.calls.exec, []);
});

test("keeps every noninteractive context silent before configuration or process effects", () => {
  for (const [mode, hasUI] of [
    ["print", false],
    ["json", false],
    ["rpc", true],
    ["tui", false],
  ]) {
    const harness = createHarness();
    const ctx = createContext({ mode, hasUI });

    harness.emit("agent_start", {}, ctx);
    harness.emit("agent_settled", {}, ctx);
    harness.emit("ui_prompt_start", { kind: "confirm" }, ctx);

    assert.equal(harness.calls.loadConfig, 0, `${mode}/${hasUI}`);
    assert.equal(harness.scheduled.length, 0, `${mode}/${hasUI}`);
    assert.equal(harness.calls.exec.length, 0, `${mode}/${hasUI}`);
  }
});

test("fails closed when configuration loading rejects", async () => {
  const harness = createHarness({
    loadConfig: async () => {
      throw new Error("invalid configuration");
    },
  });
  const ctx = createContext();

  harness.emit("ui_prompt_start", { kind: "confirm" }, ctx);
  await flushPromises();

  assert.equal(harness.calls.loadConfig, 1);
  assert.equal(harness.calls.exec.length, 0);
});

test("delivers one deferred generic notification after a final idle settlement", async () => {
  const harness = createHarness();
  const ctx = createContext();

  harness.emit("agent_start", {}, ctx);
  harness.emit("agent_settled", {}, ctx);

  assert.equal(harness.scheduled.length, 1);
  assert.equal(harness.calls.exec.length, 0);

  await harness.runScheduled(harness.scheduled[0]);

  assert.equal(harness.calls.loadConfig, 1);
  assert.equal(harness.calls.exec.length, 1);
  assert.deepEqual(
    {
      command: harness.calls.exec[0].command,
      args: harness.calls.exec[0].args,
    },
    expectedLinuxCommand,
  );
  assert.equal(harness.calls.exec[0].options.timeout, 2_000);
  assert.equal(harness.calls.exec[0].options.signal.aborted, false);

  harness.emit("agent_settled", {}, ctx);
  assert.equal(harness.scheduled.length, 1);
});

test("does not gate legitimate settled runs on success, error, interruption, or length outcome", async () => {
  for (const outcome of ["success", "error", "interrupted", "length"]) {
    const harness = createHarness();
    const ctx = createContext();

    harness.emit("agent_start", {}, ctx);
    harness.emit("agent_settled", { outcome }, ctx);
    await harness.runScheduled(harness.scheduled[0]);

    assert.equal(harness.calls.exec.length, 1, outcome);
  }
});

test("cancels a pending settlement for newer input, a new run, branch navigation, or preflight", async () => {
  for (const invalidator of [
    "input",
    "before_agent_start",
    "agent_start",
    "session_tree",
  ]) {
    const harness = createHarness();
    const ctx = createContext();

    harness.emit("agent_start", {}, ctx);
    harness.emit("agent_settled", {}, ctx);
    const scheduled = harness.scheduled[0];
    const result = harness.emit(invalidator, {}, ctx);

    assert.equal(result, undefined, invalidator);
    assert.equal(scheduled.cancelled, true, invalidator);
    await harness.runScheduled(scheduled);
    assert.equal(harness.calls.exec.length, 0, invalidator);
  }
});

test("suppresses a settlement that becomes stale while configuration is loading", async () => {
  const pendingConfig = deferred();
  const harness = createHarness({ loadConfig: () => pendingConfig.promise });
  const ctx = createContext();

  harness.emit("agent_start", {}, ctx);
  harness.emit("agent_settled", {}, ctx);
  await harness.runScheduled(harness.scheduled[0]);
  harness.emit("input", {}, ctx);
  pendingConfig.resolve(enabledConfig());
  await flushPromises();

  assert.equal(harness.calls.exec.length, 0);
});

test("notifies once for each distinct supported extension prompt span", async () => {
  const harness = createHarness();
  const ctx = createContext();

  for (const kind of ["confirm", "select", "input", "editor", "custom"]) {
    harness.emit("ui_prompt_start", { kind }, ctx);
    await flushPromises();
    harness.emit("ui_prompt_end", { kind }, ctx);
  }

  assert.equal(harness.scheduled.length, 0);
  assert.equal(harness.calls.exec.length, 5);
  assert.equal(harness.calls.loadConfig, 1);
});

test("coalesces duplicate prompt starts and suppresses closing a prompt during config loading", async (t) => {
  await t.test("duplicate outer span", async () => {
    const harness = createHarness();
    const ctx = createContext();

    harness.emit("ui_prompt_start", { kind: "confirm" }, ctx);
    await flushPromises();
    harness.emit("ui_prompt_start", { kind: "custom" }, ctx);
    await flushPromises();

    assert.equal(harness.calls.exec.length, 1);
  });

  await t.test("prompt ends before delayed configuration resolves", async () => {
    const pendingConfig = deferred();
    const harness = createHarness({ loadConfig: () => pendingConfig.promise });
    const ctx = createContext();

    harness.emit("ui_prompt_start", { kind: "confirm" }, ctx);
    await flushPromises();
    harness.emit("ui_prompt_end", {}, ctx);
    pendingConfig.resolve(enabledConfig());
    await flushPromises();

    assert.equal(harness.calls.exec.length, 0);
  });
});

test("consumes a settlement while a prompt span is already open", async () => {
  const harness = createHarness();
  const ctx = createContext();

  harness.emit("agent_start", {}, ctx);
  harness.emit("ui_prompt_start", { kind: "confirm" }, ctx);
  await flushPromises();
  harness.emit("agent_settled", {}, ctx);

  assert.equal(harness.scheduled.length, 0);
  assert.equal(harness.calls.exec.length, 1);
});

test("ignores unsupported prompt kinds and never forwards event content to the process boundary", async () => {
  const harness = createHarness();
  const ctx = createContext();

  harness.emit("ui_prompt_start", {
    kind: "picker",
    title: "do-not-forward",
  }, ctx);
  await flushPromises();
  assert.equal(harness.calls.exec.length, 0);

  harness.emit("ui_prompt_start", {
    kind: "confirm",
    title: "credential=do-not-forward",
  }, ctx);
  await flushPromises();

  assert.deepEqual(
    {
      command: harness.calls.exec[0].command,
      args: harness.calls.exec[0].args,
    },
    expectedLinuxCommand,
  );
  assert.equal(JSON.stringify(harness.calls.exec[0]).includes("credential="), false);
});

test("contains rejected, nonzero, and unsupported-platform delivery attempts without retries", async (t) => {
  await t.test("rejected process", async () => {
    const harness = createHarness({
      exec: async () => {
        throw new Error("missing notifier");
      },
    });
    const ctx = createContext();

    harness.emit("agent_start", {}, ctx);
    harness.emit("agent_settled", {}, ctx);
    await harness.runScheduled(harness.scheduled[0]);
    harness.emit("agent_settled", {}, ctx);

    assert.equal(harness.calls.exec.length, 1);
    assert.equal(harness.scheduled.length, 1);
  });

  await t.test("nonzero result", async () => {
    const harness = createHarness({
      exec: async () => ({ code: 127, killed: false, stdout: "", stderr: "" }),
    });
    const ctx = createContext();

    harness.emit("agent_start", {}, ctx);
    harness.emit("agent_settled", {}, ctx);
    await harness.runScheduled(harness.scheduled[0]);

    assert.equal(harness.calls.exec.length, 1);
  });

  await t.test("unsupported platform", async () => {
    const harness = createHarness({ platform: "win32" });
    const ctx = createContext();

    harness.emit("agent_start", {}, ctx);
    harness.emit("agent_settled", {}, ctx);
    await harness.runScheduled(harness.scheduled[0]);

    assert.equal(harness.calls.exec.length, 0);
  });
});

test("aborts an active notification command during session shutdown", async () => {
  const pendingExec = deferred();
  const harness = createHarness({ exec: () => pendingExec.promise });
  const ctx = createContext();

  harness.emit("ui_prompt_start", { kind: "confirm" }, ctx);
  await flushPromises();
  assert.equal(harness.controllers.length, 1);

  harness.emit("session_shutdown", {}, ctx);
  assert.equal(harness.controllers[0].signal.aborted, true);

  pendingExec.reject(new Error("cancelled"));
  await flushPromises();
  assert.equal(harness.calls.exec.length, 1);
});
