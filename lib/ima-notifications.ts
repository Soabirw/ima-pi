export type NotificationConfig = Readonly<{
  enable: boolean;
}>;

export type NotificationConfigLayer = Readonly<Partial<NotificationConfig>>;
type MutableNotificationConfigLayer = {
  -readonly [Key in keyof NotificationConfig]?: NotificationConfig[Key];
};

export type NotificationConfigDiagnostic = Readonly<{
  code:
    | "notifications_config_invalid_object"
    | "notifications_config_unknown_key"
    | "notifications_config_invalid_boolean";
  path: readonly string[];
}>;

export type ParsedNotificationConfigLayer = Readonly<{
  values: NotificationConfigLayer;
  diagnostics: readonly NotificationConfigDiagnostic[];
}>;

export const NOTIFICATION_CONFIG_DEFAULTS: NotificationConfig = Object.freeze({
  enable: true,
});

export const NOTIFICATION_CONFIG_KEYS = Object.freeze(["enable"] as const);

export const NOTIFICATION_TITLE = "Pi";
export const NOTIFICATION_BODY = "Pi is ready for your input";
export const NOTIFICATION_TIMEOUT_MS = 2_000;

export const NOTIFICATION_PROMPT_KINDS = Object.freeze([
  "confirm",
  "select",
  "input",
  "editor",
  "custom",
] as const);

export type NotificationPromptKind = typeof NOTIFICATION_PROMPT_KINDS[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const diagnostic = (
  code: NotificationConfigDiagnostic["code"],
  path: readonly string[],
): NotificationConfigDiagnostic => Object.freeze({
  code,
  path: Object.freeze([...path]),
});

export const parseNotificationConfigLayer = (
  raw: unknown,
): ParsedNotificationConfigLayer => {
  if (!isRecord(raw)) {
    return Object.freeze({
      values: Object.freeze({}),
      diagnostics: Object.freeze([
        diagnostic("notifications_config_invalid_object", []),
      ]),
    });
  }

  const values: MutableNotificationConfigLayer = {};
  const diagnostics: NotificationConfigDiagnostic[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (key !== "enable") {
      diagnostics.push(diagnostic("notifications_config_unknown_key", [key]));
      continue;
    }

    if (typeof value !== "boolean") {
      diagnostics.push(
        diagnostic("notifications_config_invalid_boolean", [key]),
      );
      continue;
    }

    values.enable = value;
  }

  return Object.freeze({
    values: Object.freeze({ ...values }),
    diagnostics: Object.freeze([...diagnostics]),
  });
};

export const hasCompleteNotificationConfigLayer = (
  layer: NotificationConfigLayer,
): boolean => layer.enable !== undefined;

export const mergeNotificationConfig = (
  defaults: NotificationConfig,
  override: NotificationConfigLayer = {},
): NotificationConfig => Object.freeze({
  enable: override.enable ?? defaults.enable,
});

export const isSupportedNotificationPromptKind = (
  value: unknown,
): value is NotificationPromptKind =>
  typeof value === "string"
  && NOTIFICATION_PROMPT_KINDS.includes(value as NotificationPromptKind);

export type WaitingEvent =
  | Readonly<{ kind: "settlement"; runGeneration: number }>
  | Readonly<{ kind: "prompt"; promptSpan: number }>;

export type NotificationState = Readonly<{
  runGeneration: number;
  consumedSettlementGeneration: number;
  promptSpan: number;
  promptOpen: boolean;
  pendingSettlementGeneration: number | null;
  pendingPromptSpan: number | null;
  shutdown: boolean;
}>;

export type NotificationStateEvent =
  | Readonly<{ type: "agent_start" }>
  | Readonly<{ type: "input" }>
  | Readonly<{ type: "before_agent_start" }>
  | Readonly<{ type: "agent_settled" }>
  | Readonly<{ type: "ui_prompt_start" }>
  | Readonly<{ type: "ui_prompt_end" }>
  | Readonly<{ type: "session_tree" }>
  | Readonly<{ type: "session_shutdown" }>
  | Readonly<{ type: "delivery_started"; waitingEvent: WaitingEvent }>;

export type NotificationTransition = Readonly<{
  state: NotificationState;
  waitingEvent: WaitingEvent | null;
}>;

export const INITIAL_NOTIFICATION_STATE: NotificationState = Object.freeze({
  runGeneration: 0,
  consumedSettlementGeneration: 0,
  promptSpan: 0,
  promptOpen: false,
  pendingSettlementGeneration: null,
  pendingPromptSpan: null,
  shutdown: false,
});

const transition = (
  state: NotificationState,
  waitingEvent: WaitingEvent | null = null,
): NotificationTransition => Object.freeze({ state, waitingEvent });

const withState = (
  state: NotificationState,
  changes: Partial<NotificationState>,
): NotificationState => Object.freeze({ ...state, ...changes });

const clearPendingSettlement = (state: NotificationState): NotificationState =>
  state.pendingSettlementGeneration === null
    ? state
    : withState(state, { pendingSettlementGeneration: null });

export const nextNotificationState = (
  state: NotificationState,
  event: NotificationStateEvent,
): NotificationTransition => {
  if (event.type === "session_shutdown") {
    return transition(withState(state, {
      pendingSettlementGeneration: null,
      pendingPromptSpan: null,
      promptOpen: false,
      shutdown: true,
    }));
  }

  if (state.shutdown) return transition(state);

  if (event.type === "agent_start") {
    return transition(withState(state, {
      runGeneration: state.runGeneration + 1,
      pendingSettlementGeneration: null,
    }));
  }

  if (
    event.type === "input"
    || event.type === "before_agent_start"
    || event.type === "session_tree"
  ) {
    return transition(clearPendingSettlement(state));
  }

  if (event.type === "agent_settled") {
    if (
      state.runGeneration === 0
      || state.consumedSettlementGeneration === state.runGeneration
    ) {
      return transition(state);
    }

    if (state.promptOpen) {
      return transition(withState(state, {
        consumedSettlementGeneration: state.runGeneration,
        pendingSettlementGeneration: null,
      }));
    }

    const waitingEvent: WaitingEvent = Object.freeze({
      kind: "settlement",
      runGeneration: state.runGeneration,
    });
    return transition(withState(state, {
      consumedSettlementGeneration: state.runGeneration,
      pendingSettlementGeneration: state.runGeneration,
    }), waitingEvent);
  }

  if (event.type === "ui_prompt_start") {
    if (state.promptOpen) return transition(state);

    const promptSpan = state.promptSpan + 1;
    const waitingEvent: WaitingEvent = Object.freeze({
      kind: "prompt",
      promptSpan,
    });
    return transition(withState(state, {
      promptSpan,
      promptOpen: true,
      pendingPromptSpan: promptSpan,
      pendingSettlementGeneration: null,
    }), waitingEvent);
  }

  if (event.type === "ui_prompt_end") {
    return transition(withState(state, {
      promptOpen: false,
      pendingPromptSpan: null,
    }));
  }

  if (event.waitingEvent.kind === "settlement") {
    if (
      state.pendingSettlementGeneration
      !== event.waitingEvent.runGeneration
    ) {
      return transition(state);
    }
    return transition(withState(state, { pendingSettlementGeneration: null }));
  }

  if (state.pendingPromptSpan !== event.waitingEvent.promptSpan) {
    return transition(state);
  }
  return transition(withState(state, { pendingPromptSpan: null }));
};

export const isInteractiveNotificationContext = ({
  mode,
  hasUI,
}: Readonly<{
  mode: unknown;
  hasUI: unknown;
}>): boolean => mode === "tui" && hasUI === true;

export const canDeliverNotification = ({
  state,
  waitingEvent,
  enable,
  mode,
  hasUI,
  idle,
}: Readonly<{
  state: NotificationState;
  waitingEvent: WaitingEvent;
  enable: boolean;
  mode: unknown;
  hasUI: unknown;
  idle: boolean;
}>): boolean => {
  if (
    !enable
    || state.shutdown
    || !isInteractiveNotificationContext({ mode, hasUI })
  ) {
    return false;
  }

  if (waitingEvent.kind === "settlement") {
    return idle
      && state.pendingSettlementGeneration === waitingEvent.runGeneration;
  }

  return state.promptOpen && state.pendingPromptSpan === waitingEvent.promptSpan;
};

export type NotificationCommand = Readonly<{
  command: string;
  args: readonly string[];
}>;

const LINUX_NOTIFICATION_COMMAND: NotificationCommand = Object.freeze({
  command: "/usr/bin/notify-send",
  args: Object.freeze([
    "--app-name=Pi",
    "--urgency=normal",
    "--hint=string:sound-name:message-new-instant",
    NOTIFICATION_TITLE,
    NOTIFICATION_BODY,
  ]),
});

const MACOS_NOTIFICATION_COMMAND: NotificationCommand = Object.freeze({
  command: "/usr/bin/osascript",
  args: Object.freeze([
    "-e",
    'display notification "Pi is ready for your input" with title "Pi" sound name "Frog"',
  ]),
});

export const notificationCommand = (
  platform: unknown,
): NotificationCommand | null => {
  if (platform === "linux") return LINUX_NOTIFICATION_COMMAND;
  if (platform === "darwin") return MACOS_NOTIFICATION_COMMAND;
  return null;
};
