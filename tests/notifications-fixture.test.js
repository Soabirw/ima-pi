import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import notificationPromptFixture from "./fixtures/notifications-prompts.ts";

const requireFromCodingAgent = createRequire(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/package.json",
    import.meta.url,
  ),
);
const tui = await import(requireFromCodingAgent.resolve("@earendil-works/pi-tui"));

const {
  isKittyProtocolActive,
  KeybindingsManager,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
} = tui;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
};

const createKeybindings = (userBindings = {}) =>
  new KeybindingsManager(TUI_KEYBINDINGS, userBindings);

const createFixtureHarness = (keybindings = createKeybindings()) => {
  const commands = new Map();
  const customRequests = [];
  const innerConfirmations = [];
  const confirmCalls = [];

  const ui = {
    confirm: (title, message) => {
      confirmCalls.push({ title, message });
      if (title !== "Nested notification fixture") return Promise.resolve(false);

      const result = deferred();
      innerConfirmations.push(result);
      return result.promise;
    },
    select: async () => undefined,
    input: async () => undefined,
    editor: async () => undefined,
    custom: (factory) => {
      const result = deferred();
      const request = {
        component: undefined,
        doneCalls: 0,
        mounted: false,
      };
      let closed = false;
      const done = (value) => {
        request.doneCalls += 1;
        if (closed) return;
        closed = true;
        result.resolve(value);
      };

      customRequests.push(request);
      let component;
      try {
        component = factory({}, {}, keybindings, done);
      } catch (error) {
        result.reject(error);
        return result.promise;
      }

      Promise.resolve(component).then(
        (mounted) => {
          if (closed) return;
          request.component = mounted;
          request.mounted = true;
        },
        result.reject,
      );
      return result.promise;
    },
  };

  notificationPromptFixture({
    registerCommand: (name, options) => commands.set(name, options),
  });

  return {
    command: commands.get("ima:notification-prompts"),
    confirmCalls,
    customRequests,
    ctx: { mode: "tui", hasUI: true, ui },
    innerConfirmations,
  };
};

const startFixture = async (harness) => {
  const completion = harness.command.handler("", harness.ctx);
  await waitFor(
    () => harness.customRequests.length === 1 && harness.customRequests[0].mounted,
    "custom fixture did not mount",
  );
  return { completion };
};

const mountNestedFixture = async (harness, completion, input = "\r") => {
  harness.customRequests[0].component.handleInput(input);
  await waitFor(
    () => harness.customRequests.length === 2 && harness.customRequests[1].mounted,
    "nested fixture did not mount",
  );
  return { completion, nested: harness.customRequests[1] };
};

test("custom fixture honors legacy and CSI-u confirm/cancel input", async () => {
  const previousKittyState = isKittyProtocolActive();
  setKittyProtocolActive(true);

  try {
    for (const input of ["\r", "\u001b", "\x1b[13u", "\x1b[27u"]) {
      const harness = createFixtureHarness();
      const { completion } = await startFixture(harness);

      harness.customRequests[0].component.handleInput(input);
      await waitFor(
        () => harness.customRequests.length === 2 && harness.customRequests[1].mounted,
        `custom fixture did not honor ${JSON.stringify(input)}`,
      );
      assert.equal(harness.customRequests[0].doneCalls, 1);

      harness.customRequests[1].component.handleInput("\u001b");
      await completion;
      assert.equal(harness.innerConfirmations.length, 0);
    }
  } finally {
    setKittyProtocolActive(previousKittyState);
  }
});

test("custom fixture ignores unrelated input", async () => {
  const harness = createFixtureHarness();
  const { completion } = await startFixture(harness);

  harness.customRequests[0].component.handleInput("x");
  await Promise.resolve();
  assert.equal(harness.customRequests.length, 1);
  assert.equal(harness.customRequests[0].doneCalls, 0);

  const { nested } = await mountNestedFixture(harness, completion);
  nested.component.handleInput("\u001b");
  await completion;
});

test("custom fixture respects configured confirm and cancel remapping", async () => {
  const confirmHarness = createFixtureHarness(createKeybindings({
    "tui.select.cancel": "ctrl+y",
    "tui.select.confirm": "ctrl+x",
  }));
  const { completion: confirmCompletion } = await startFixture(confirmHarness);
  const { nested } = await mountNestedFixture(
    confirmHarness,
    confirmCompletion,
    "\x18",
  );

  nested.component.handleInput("\x18");
  nested.component.handleInput("\x18");
  assert.equal(confirmHarness.innerConfirmations.length, 1);

  confirmHarness.innerConfirmations[0].resolve(false);
  await confirmCompletion;
  assert.equal(nested.doneCalls, 1);

  const cancelHarness = createFixtureHarness(createKeybindings({
    "tui.select.cancel": "ctrl+y",
    "tui.select.confirm": "ctrl+x",
  }));
  const { completion: cancelCompletion } = await startFixture(cancelHarness);
  const { nested: cancelledNested } = await mountNestedFixture(
    cancelHarness,
    cancelCompletion,
    "\x19",
  );

  cancelledNested.component.handleInput("\x19");
  await cancelCompletion;
  assert.equal(cancelHarness.innerConfirmations.length, 0);
  assert.equal(cancelledNested.doneCalls, 1);
});

test("nested fixture opens after outer mounting and closes once for every inner outcome", async () => {
  for (const [name, settle] of [
    ["confirmation", (result) => result.resolve(true)],
    ["cancellation", (result) => result.resolve(false)],
    ["rejection", (result) => result.reject(new Error("fixture confirmation failed"))],
  ]) {
    const harness = createFixtureHarness();
    const { completion } = await startFixture(harness);
    const { nested } = await mountNestedFixture(harness, completion);

    assert.equal(harness.confirmCalls.length, 1, name);
    assert.equal(harness.innerConfirmations.length, 0, name);

    nested.component.handleInput("\r");
    nested.component.handleInput("\r");
    assert.equal(harness.innerConfirmations.length, 1, name);

    settle(harness.innerConfirmations[0]);
    await completion;
    assert.equal(nested.doneCalls, 1, name);
  }
});
