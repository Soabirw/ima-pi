import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  canDeliverNotification,
  hasCompleteNotificationConfigLayer,
  INITIAL_NOTIFICATION_STATE,
  isInteractiveNotificationContext,
  isSupportedNotificationPromptKind,
  mergeNotificationConfig,
  nextNotificationState,
  notificationCommand,
  NOTIFICATION_CONFIG_DEFAULTS,
  NOTIFICATION_TIMEOUT_MS,
  parseNotificationConfigLayer,
  type NotificationConfig,
  type NotificationState,
  type WaitingEvent,
} from "../lib/ima-notifications.ts";

export const MAX_NOTIFICATION_CONFIG_BYTES = 4 * 1024;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ConfigFileResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; reason: "missing" | "invalid" }>;

export type NotificationConfigPaths = Readonly<{
  packageBasePath: string;
  packageConfigPath: string;
  userBasePath: string;
  userConfigPath: string;
}>;

export type NotificationConfigLoadResult =
  | Readonly<{ valid: true; config: NotificationConfig }>
  | Readonly<{ valid: false }>;

export type NotificationExtensionDependencies = Readonly<{
  loadConfig: () => Promise<NotificationConfigLoadResult>;
  getPlatform: () => string;
  schedule: (callback: () => void) => unknown;
  cancelSchedule: (handle: unknown) => void;
  createAbortController: () => AbortController;
}>;

type NotificationExtensionDependencyOverrides = Readonly<
  Partial<NotificationExtensionDependencies>
>;

type ScheduledSettlement = Readonly<{
  handle: unknown;
  waitingEvent: Extract<WaitingEvent, { kind: "settlement" }>;
}>;

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && error.code === "ENOENT";

const isPathInsideBase = (basePath: string, candidatePath: string): boolean => {
  const relativePath = relative(basePath, candidatePath);
  return relativePath === ""
    || (
      relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    );
};

const invalidConfigFile = (): ConfigFileResult =>
  Object.freeze({ ok: false, reason: "invalid" });

const missingConfigFile = (): ConfigFileResult =>
  Object.freeze({ ok: false, reason: "missing" });

const inspectConfigEntry = async (
  path: string,
): Promise<"missing" | "present" | "invalid"> => {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    return isMissingFileError(error) ? "missing" : "invalid";
  }
};

const readConfigFile = async (
  basePath: string,
  configPath: string,
): Promise<ConfigFileResult> => {
  const baseEntry = await inspectConfigEntry(basePath);
  if (baseEntry === "missing") return missingConfigFile();
  if (baseEntry === "invalid") return invalidConfigFile();

  let resolvedBasePath: string;
  try {
    resolvedBasePath = await realpath(basePath);
    if (!(await stat(resolvedBasePath)).isDirectory()) return invalidConfigFile();
  } catch {
    return invalidConfigFile();
  }

  const configEntry = await inspectConfigEntry(configPath);
  if (configEntry === "missing") return missingConfigFile();
  if (configEntry === "invalid") return invalidConfigFile();

  let resolvedConfigPath: string;
  try {
    resolvedConfigPath = await realpath(configPath);
  } catch {
    return invalidConfigFile();
  }

  if (!isPathInsideBase(resolvedBasePath, resolvedConfigPath)) {
    return invalidConfigFile();
  }

  try {
    const configStats = await stat(resolvedConfigPath);
    if (!configStats.isFile() || configStats.size > MAX_NOTIFICATION_CONFIG_BYTES) {
      return invalidConfigFile();
    }
  } catch {
    return invalidConfigFile();
  }

  let content: string;
  try {
    const file = await open(resolvedConfigPath, "r");
    try {
      const buffer = Buffer.alloc(MAX_NOTIFICATION_CONFIG_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_NOTIFICATION_CONFIG_BYTES) return invalidConfigFile();
      content = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close().catch(() => {});
    }
  } catch {
    return invalidConfigFile();
  }

  try {
    return Object.freeze({ ok: true, value: JSON.parse(content) });
  } catch {
    return invalidConfigFile();
  }
};

export const createNotificationConfigPaths = (
  agentDirectory = getAgentDir(),
): NotificationConfigPaths => {
  const packageBasePath = join(packageRoot, "config");
  const userBasePath = join(resolve(agentDirectory), "ima");

  return Object.freeze({
    packageBasePath,
    packageConfigPath: join(packageBasePath, "notifications.json"),
    userBasePath,
    userConfigPath: join(userBasePath, "notifications.json"),
  });
};

export const loadNotificationConfig = async (
  paths = createNotificationConfigPaths(),
): Promise<NotificationConfigLoadResult> => {
  const packageFile = await readConfigFile(
    paths.packageBasePath,
    paths.packageConfigPath,
  );
  if (!packageFile.ok) return Object.freeze({ valid: false });

  const packageLayer = parseNotificationConfigLayer(packageFile.value);
  if (
    packageLayer.diagnostics.length > 0
    || !hasCompleteNotificationConfigLayer(packageLayer.values)
  ) {
    return Object.freeze({ valid: false });
  }

  const packageConfig = mergeNotificationConfig(
    NOTIFICATION_CONFIG_DEFAULTS,
    packageLayer.values,
  );
  const userFile = await readConfigFile(paths.userBasePath, paths.userConfigPath);
  if (!userFile.ok) {
    return userFile.reason === "missing"
      ? Object.freeze({ valid: true, config: packageConfig })
      : Object.freeze({ valid: false });
  }

  const userLayer = parseNotificationConfigLayer(userFile.value);
  if (userLayer.diagnostics.length > 0) return Object.freeze({ valid: false });

  return Object.freeze({
    valid: true,
    config: mergeNotificationConfig(packageConfig, userLayer.values),
  });
};

const resolveDependencies = (
  overrides: NotificationExtensionDependencyOverrides,
): NotificationExtensionDependencies => Object.freeze({
  loadConfig: overrides.loadConfig ?? loadNotificationConfig,
  getPlatform: overrides.getPlatform ?? (() => process.platform),
  schedule: overrides.schedule ?? ((callback) => setImmediate(callback)),
  cancelSchedule: overrides.cancelSchedule
    ?? ((handle) => clearImmediate(handle as NodeJS.Immediate)),
  createAbortController: overrides.createAbortController
    ?? (() => new AbortController()),
});

const isInteractiveTui = (
  ctx: Pick<ExtensionContext, "mode" | "hasUI">,
): boolean => isInteractiveNotificationContext({
  mode: ctx.mode,
  hasUI: ctx.hasUI,
});

const isSessionIdle = (ctx: Pick<ExtensionContext, "isIdle">): boolean => {
  try {
    return typeof ctx.isIdle === "function" && ctx.isIdle();
  } catch {
    return false;
  }
};

export default function notificationsExtension(
  pi: ExtensionAPI,
  overrides: NotificationExtensionDependencyOverrides = {},
): void {
  const dependencies = resolveDependencies(overrides);
  let state: NotificationState = INITIAL_NOTIFICATION_STATE;
  let configPromise: Promise<NotificationConfigLoadResult> | undefined;
  let scheduledSettlement: ScheduledSettlement | null = null;
  const activeControllers = new Set<AbortController>();

  const loadConfigOnce = (): Promise<NotificationConfigLoadResult> => {
    if (!configPromise) {
      configPromise = Promise.resolve()
        .then(() => dependencies.loadConfig())
        .catch(() => Object.freeze({ valid: false }));
    }
    return configPromise;
  };

  const cancelScheduledSettlement = (): void => {
    if (!scheduledSettlement) return;

    try {
      dependencies.cancelSchedule(scheduledSettlement.handle);
    } catch {
      // Scheduler failures must not make a waiting event visible or retryable.
    }
    scheduledSettlement = null;
  };

  const abortActiveCommands = (): void => {
    for (const controller of activeControllers) {
      try {
        controller.abort();
      } catch {
        // A cancellation failure cannot safely justify another notification attempt.
      }
    }
    activeControllers.clear();
  };

  const deliverNotification = async (
    waitingEvent: WaitingEvent,
    ctx: ExtensionContext,
  ): Promise<void> => {
    try {
      const loaded = await loadConfigOnce();
      if (!loaded.valid) return;

      if (!canDeliverNotification({
        state,
        waitingEvent,
        enable: loaded.config.enable,
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        idle: isSessionIdle(ctx),
      })) {
        return;
      }

      const deliveryStarted = nextNotificationState(state, {
        type: "delivery_started",
        waitingEvent,
      });
      if (deliveryStarted.state === state) return;
      state = deliveryStarted.state;

      const command = notificationCommand(dependencies.getPlatform());
      if (!command) return;

      const controller = dependencies.createAbortController();
      activeControllers.add(controller);
      try {
        await pi.exec(command.command, [...command.args], {
          timeout: NOTIFICATION_TIMEOUT_MS,
          signal: controller.signal,
        });
      } catch {
        // Desktop notification delivery is deliberately silent and non-blocking.
      } finally {
        activeControllers.delete(controller);
      }
    } catch {
      // Configuration, platform, and process-boundary failures remain silent.
    }
  };

  const invalidateSettlement = (
    event: "agent_start" | "input" | "before_agent_start" | "session_tree",
  ): void => {
    cancelScheduledSettlement();
    state = nextNotificationState(state, { type: event }).state;
  };

  pi.on("session_start", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    cancelScheduledSettlement();
    abortActiveCommands();
    state = INITIAL_NOTIFICATION_STATE;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    invalidateSettlement("agent_start");
  });

  pi.on("input", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    invalidateSettlement("input");
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    invalidateSettlement("before_agent_start");
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!isInteractiveTui(ctx) || !isSessionIdle(ctx)) return;

    const transition = nextNotificationState(state, { type: "agent_settled" });
    state = transition.state;
    if (!transition.waitingEvent || transition.waitingEvent.kind !== "settlement") {
      return;
    }

    try {
      const waitingEvent = transition.waitingEvent;
      const handle = dependencies.schedule(() => {
        scheduledSettlement = null;
        void deliverNotification(waitingEvent, ctx);
      });
      scheduledSettlement = Object.freeze({ handle, waitingEvent });
    } catch {
      state = nextNotificationState(state, {
        type: "delivery_started",
        waitingEvent: transition.waitingEvent,
      }).state;
    }
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    if (!isInteractiveTui(ctx) || !isSupportedNotificationPromptKind(event.kind)) {
      return;
    }

    cancelScheduledSettlement();
    const transition = nextNotificationState(state, { type: "ui_prompt_start" });
    state = transition.state;
    if (!transition.waitingEvent || transition.waitingEvent.kind !== "prompt") return;

    void deliverNotification(transition.waitingEvent, ctx);
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    state = nextNotificationState(state, { type: "ui_prompt_end" }).state;
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    invalidateSettlement("session_tree");
  });

  pi.on("session_shutdown", () => {
    cancelScheduledSettlement();
    state = nextNotificationState(state, { type: "session_shutdown" }).state;
    abortActiveCommands();
  });
}
