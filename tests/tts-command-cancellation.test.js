import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantEntry,
  commandContext,
  createFakeEngine,
  createHarness,
  deferred,
  flushPromises,
  loadedConfig,
  SPEAK_COMPLETE,
  SPEAK_STARTING,
  SPEAK_STOPPED,
  textPart,
} from "./tts-command-fixtures.js";

const CANCELLED_SPEECH = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "tts_cancelled",
    message: "Speech synthesis or playback was cancelled.",
  }),
});

test("stops idempotently without credential, player, or session checks", async () => {
  const harness = createHarness();
  const { ctx, notifications } = commandContext({ calls: harness.calls });

  await harness.command.handler(" stop ", ctx);

  assert.deepEqual(notifications, [{ message: SPEAK_STOPPED, type: "info" }]);
  assert.equal(harness.calls.getApiKey, 0);
  assert.equal(harness.calls.hasPlayer, 0);
  assert.equal(harness.calls.getBranch, 0);
  assert.equal(harness.engineState.calls.cancel, 1);
  assert.equal(harness.engineState.calls.speak.length, 0);
});

test("cancels on every real input event without transforming it", () => {
  const harness = createHarness();
  const { ctx } = commandContext({ calls: harness.calls });

  const result = harness.handlers.get("input")({ text: "next prompt" }, ctx);

  assert.equal(result, undefined);
  assert.equal(harness.engineState.calls.cancel, 1);
});

test("delegates repeated speak requests to the singleton engine", async () => {
  const engineState = createFakeEngine();
  const harness = createHarness({ engineState });
  const { ctx } = commandContext({
    entries: [assistantEntry([textPart("Replay this")])],
    calls: harness.calls,
  });

  await harness.command.handler("", ctx);
  await harness.command.handler("", ctx);
  await flushPromises();

  assert.equal(harness.calls.createEngine, 1);
  assert.equal(engineState.calls.speak.length, 2);
  assert.deepEqual(engineState.calls.speak.map(({ text }) => text), [
    "Replay this",
    "Replay this",
  ]);
});

test("keeps intentional cancellation settlements silent", async (t) => {
  await t.test("reports Starting then the explicit stop notice", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Stop this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await harness.command.handler("stop", ctx);
    pendingSpeech.resolve(CANCELLED_SPEECH);
    await flushPromises();

    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      { message: SPEAK_STOPPED, type: "info" },
    ]);
  });

  await t.test("keeps input cancellation settlement silent", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Cancel this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    harness.handlers.get("input")({}, ctx);
    pendingSpeech.resolve(CANCELLED_SPEECH);
    await flushPromises();

    assert.deepEqual(notifications, [{ message: SPEAK_STARTING, type: "info" }]);
  });

  await t.test("suppresses late segment progress after an explicit stop", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine((_request, hooks) => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Stop this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await harness.command.handler("stop", ctx);
    engineState.calls.hooks[0].onSegmentStart({ index: 1, total: 2 });
    pendingSpeech.resolve(CANCELLED_SPEECH);
    await flushPromises();

    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      { message: SPEAK_STOPPED, type: "info" },
    ]);
  });

  await t.test("suppresses stale superseded settlement notices", async () => {
    const pendingSpeech = [deferred(), deferred()];
    let requestCount = 0;
    const engineState = createFakeEngine(() => pendingSpeech[requestCount++].promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Replay this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await harness.command.handler("", ctx);
    pendingSpeech[0].resolve({ ok: true, spoke: true });
    pendingSpeech[1].resolve({ ok: true, spoke: true });
    await flushPromises();

    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      { message: SPEAK_STARTING, type: "info" },
      { message: SPEAK_COMPLETE, type: "info" },
    ]);
  });
});

test("suppresses stale unexpected failures after cancellation", async (t) => {
  await t.test("after explicit stop", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Stop this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    await harness.command.handler("stop", ctx);
    pendingSpeech.reject(new Error("late stopped rejection"));
    await flushPromises();

    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      { message: SPEAK_STOPPED, type: "info" },
    ]);
  });

  await t.test("after input", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Cancel this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    harness.handlers.get("input")({}, ctx);
    pendingSpeech.reject(new Error("late input rejection"));
    await flushPromises();

    assert.deepEqual(notifications, [{ message: SPEAK_STARTING, type: "info" }]);
  });

  await t.test("after session shutdown", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Shutdown this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    harness.handlers.get("session_shutdown")({}, ctx);
    pendingSpeech.reject(new Error("late shutdown rejection"));
    await flushPromises();

    assert.deepEqual(notifications, [{ message: SPEAK_STARTING, type: "info" }]);
  });
});

test("invalidates stale pending speech intents", async (t) => {
  await t.test("input prevents a readiness-pending request from starting", async () => {
    const pendingApiKey = deferred();
    const harness = createHarness({
      getOpenAiApiKey: () => pendingApiKey.promise,
    });
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    const speaking = harness.command.handler("", ctx);
    harness.handlers.get("input")({}, ctx);
    pendingApiKey.resolve("test-api-key");
    await speaking;

    assert.equal(harness.engineState.calls.speak.length, 0);
    assert.deepEqual(notifications, []);
  });

  await t.test("stop prevents an older readiness-pending request from starting", async () => {
    const pendingApiKey = deferred();
    const harness = createHarness({
      getOpenAiApiKey: () => pendingApiKey.promise,
    });
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    const speaking = harness.command.handler("", ctx);
    await harness.command.handler("stop", ctx);
    pendingApiKey.resolve("test-api-key");
    await speaking;

    assert.equal(harness.engineState.calls.cancel, 1);
    assert.equal(harness.engineState.calls.speak.length, 0);
    assert.deepEqual(notifications, [{ message: SPEAK_STOPPED, type: "info" }]);
  });

  await t.test("only starts the newest request when readiness resolves out of order", async () => {
    const pendingApiKeys = [deferred(), deferred()];
    let apiKeyRequests = 0;
    const harness = createHarness({
      getOpenAiApiKey: () => pendingApiKeys[apiKeyRequests++].promise,
    });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Latest response")])],
      calls: harness.calls,
    });

    const first = harness.command.handler("", ctx);
    await flushPromises();
    const second = harness.command.handler("", ctx);
    await flushPromises();
    pendingApiKeys[1].resolve("newest-api-key");
    await second;
    pendingApiKeys[0].resolve("older-api-key");
    await first;
    await flushPromises();

    assert.deepEqual(harness.engineState.calls.speak.map(({ apiKey }) => apiKey), [
      "newest-api-key",
    ]);
    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      { message: SPEAK_COMPLETE, type: "info" },
    ]);
  });

  await t.test("a stale stop cannot cancel a newer started request", async () => {
    const pendingStopConfig = deferred();
    let configRequests = 0;
    const harness = createHarness({
      loadConfig: () => {
        configRequests += 1;
        return configRequests === 1 ? pendingStopConfig.promise : loadedConfig();
      },
    });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Newer response")])],
      calls: harness.calls,
    });

    const stopping = harness.command.handler("stop", ctx);
    await harness.command.handler("", ctx);
    pendingStopConfig.resolve(loadedConfig());
    await stopping;
    await flushPromises();

    assert.equal(harness.engineState.calls.speak.length, 1);
    assert.equal(harness.engineState.calls.cancel, 0);
    assert.deepEqual(notifications, [
      { message: SPEAK_STARTING, type: "info" },
      { message: SPEAK_COMPLETE, type: "info" },
    ]);
  });
});

test("cancels active and pending speech during session shutdown", async (t) => {
  await t.test("cancels active speech without a cancellation notice", async () => {
    const pendingSpeech = deferred();
    const engineState = createFakeEngine(() => pendingSpeech.promise);
    const harness = createHarness({ engineState });
    const { ctx, notifications } = commandContext({
      entries: [assistantEntry([textPart("Shutdown this")])],
      calls: harness.calls,
    });

    await harness.command.handler("", ctx);
    const result = harness.handlers.get("session_shutdown")({}, ctx);
    pendingSpeech.resolve(CANCELLED_SPEECH);
    await flushPromises();

    assert.equal(result, undefined);
    assert.equal(engineState.calls.cancel, 1);
    assert.deepEqual(notifications, [{ message: SPEAK_STARTING, type: "info" }]);
  });

  await t.test("invalidates a readiness-pending request", async () => {
    const pendingApiKey = deferred();
    const harness = createHarness({
      getOpenAiApiKey: () => pendingApiKey.promise,
    });
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    const speaking = harness.command.handler("", ctx);
    const result = harness.handlers.get("session_shutdown")({}, ctx);
    pendingApiKey.resolve("test-api-key");
    await speaking;

    assert.equal(result, undefined);
    assert.equal(harness.engineState.calls.cancel, 1);
    assert.equal(harness.engineState.calls.speak.length, 0);
    assert.deepEqual(notifications, []);
  });

  await t.test("remains safe while inactive", () => {
    const harness = createHarness();
    const { ctx, notifications } = commandContext({ calls: harness.calls });

    const result = harness.handlers.get("session_shutdown")({}, ctx);

    assert.equal(result, undefined);
    assert.equal(harness.engineState.calls.cancel, 1);
    assert.deepEqual(notifications, []);
  });
});
