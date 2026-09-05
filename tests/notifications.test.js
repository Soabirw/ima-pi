import assert from "node:assert/strict";
import test from "node:test";
import {
  canDeliverNotification,
  hasCompleteNotificationConfigLayer,
  INITIAL_NOTIFICATION_STATE,
  isInteractiveNotificationContext,
  isSupportedNotificationPromptKind,
  mergeNotificationConfig,
  nextNotificationState,
  notificationCommand,
  NOTIFICATION_BODY,
  NOTIFICATION_CONFIG_DEFAULTS,
  NOTIFICATION_TITLE,
  parseNotificationConfigLayer,
} from "../lib/ima-notifications.ts";

const diagnosticCodes = (result) => result.diagnostics.map(({ code }) => code);

const startRun = (state = INITIAL_NOTIFICATION_STATE) =>
  nextNotificationState(state, { type: "agent_start" }).state;

const settleRun = (state) =>
  nextNotificationState(state, { type: "agent_settled" });

test("parses the only supported notification configuration key without mutation", () => {
  const raw = { enable: false };
  const parsed = parseNotificationConfigLayer(raw);

  assert.deepEqual(parsed, {
    values: { enable: false },
    diagnostics: [],
  });
  assert.deepEqual(raw, { enable: false });
  assert.equal(hasCompleteNotificationConfigLayer(parsed.values), true);
});

test("rejects malformed, unknown, and non-boolean notification configuration", () => {
  assert.deepEqual(
    diagnosticCodes(parseNotificationConfigLayer(null)),
    ["notifications_config_invalid_object"],
  );
  assert.deepEqual(
    diagnosticCodes(parseNotificationConfigLayer({ enable: "true", extra: true })),
    [
      "notifications_config_invalid_boolean",
      "notifications_config_unknown_key",
    ],
  );
  assert.equal(hasCompleteNotificationConfigLayer({}), false);
});

test("merges an empty user configuration while preserving an explicit opt-out", () => {
  const inherited = mergeNotificationConfig(NOTIFICATION_CONFIG_DEFAULTS, {});
  const optedOut = mergeNotificationConfig(NOTIFICATION_CONFIG_DEFAULTS, {
    enable: false,
  });

  assert.deepEqual(inherited, { enable: true });
  assert.deepEqual(optedOut, { enable: false });
  assert.deepEqual(NOTIFICATION_CONFIG_DEFAULTS, { enable: true });
});

test("reserves exactly one settled waiting event for an observed run", () => {
  const running = startRun();
  const settled = settleRun(running);

  assert.deepEqual(settled.waitingEvent, {
    kind: "settlement",
    runGeneration: 1,
  });
  assert.equal(
    canDeliverNotification({
      state: settled.state,
      waitingEvent: settled.waitingEvent,
      enable: true,
      mode: "tui",
      hasUI: true,
      idle: true,
    }),
    true,
  );

  const delivered = nextNotificationState(settled.state, {
    type: "delivery_started",
    waitingEvent: settled.waitingEvent,
  });
  assert.equal(delivered.state.pendingSettlementGeneration, null);
  assert.equal(settleRun(delivered.state).waitingEvent, null);
});

test("does not reserve settlement for an unobserved run or an open prompt span", () => {
  assert.equal(settleRun(INITIAL_NOTIFICATION_STATE).waitingEvent, null);

  const running = startRun();
  const prompt = nextNotificationState(running, { type: "ui_prompt_start" });
  const settled = settleRun(prompt.state);

  assert.equal(settled.waitingEvent, null);
  assert.equal(settled.state.consumedSettlementGeneration, 1);
});

test("cancels a pending settlement when a prompt opens and deduplicates prompt spans", () => {
  const pendingSettlement = settleRun(startRun());
  const prompt = nextNotificationState(pendingSettlement.state, {
    type: "ui_prompt_start",
  });

  assert.equal(prompt.state.pendingSettlementGeneration, null);
  assert.deepEqual(prompt.waitingEvent, { kind: "prompt", promptSpan: 1 });
  assert.equal(
    nextNotificationState(prompt.state, { type: "ui_prompt_start" }).waitingEvent,
    null,
  );

  const closed = nextNotificationState(prompt.state, { type: "ui_prompt_end" });
  const nextPrompt = nextNotificationState(closed.state, {
    type: "ui_prompt_start",
  });
  assert.deepEqual(nextPrompt.waitingEvent, { kind: "prompt", promptSpan: 2 });
});

test("invalidates stale settlement reservations for input, a new run, tree navigation, and shutdown", () => {
  const cases = ["input", "before_agent_start", "agent_start", "session_tree"];

  for (const event of cases) {
    const settled = settleRun(startRun());
    const transition = nextNotificationState(settled.state, { type: event });
    assert.equal(transition.state.pendingSettlementGeneration, null, event);
  }

  const settled = settleRun(startRun());
  const shutdown = nextNotificationState(settled.state, { type: "session_shutdown" });
  assert.equal(shutdown.state.shutdown, true);
  assert.equal(shutdown.state.pendingSettlementGeneration, null);
  assert.equal(shutdown.state.pendingPromptSpan, null);
});

test("requires an idle interactive TUI and a current waiting-event identity", () => {
  const settled = settleRun(startRun());

  for (const [mode, hasUI, idle] of [
    ["rpc", true, true],
    ["json", false, true],
    ["tui", false, true],
    ["tui", true, false],
  ]) {
    assert.equal(
      canDeliverNotification({
        state: settled.state,
        waitingEvent: settled.waitingEvent,
        enable: true,
        mode,
        hasUI,
        idle,
      }),
      false,
      `${mode}/${hasUI}/${idle}`,
    );
  }

  assert.equal(isInteractiveNotificationContext({ mode: "tui", hasUI: true }), true);
  assert.equal(isInteractiveNotificationContext({ mode: "rpc", hasUI: true }), false);
});

test("recognizes only Pi's documented extension prompt kinds", () => {
  for (const kind of ["confirm", "select", "input", "editor", "custom"]) {
    assert.equal(isSupportedNotificationPromptKind(kind), true, kind);
  }
  assert.equal(isSupportedNotificationPromptKind("picker"), false);
  assert.equal(isSupportedNotificationPromptKind(undefined), false);
});

test("selects only fixed no-shell Linux and macOS notification commands", () => {
  assert.deepEqual(notificationCommand("linux"), {
    command: "/usr/bin/notify-send",
    args: [
      "--app-name=Pi",
      "--urgency=normal",
      "--hint=string:sound-name:message-new-instant",
      NOTIFICATION_TITLE,
      NOTIFICATION_BODY,
    ],
  });
  assert.deepEqual(notificationCommand("darwin"), {
    command: "/usr/bin/osascript",
    args: [
      "-e",
      'display notification "Pi is ready for your input" with title "Pi" sound name "Frog"',
    ],
  });
  assert.equal(notificationCommand("win32"), null);
  assert.equal(notificationCommand("linux; rm -rf /"), null);
});
