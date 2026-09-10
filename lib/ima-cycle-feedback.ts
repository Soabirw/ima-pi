import type { CycleMode, CyclePhase, CycleStatus } from "./ima-cycle.ts";
import type { CyclePhaseRoute } from "./ima-cycle-phase.ts";

const MAX_WIDGET_LINE_LENGTH = 200;
const RETRIABLE_PHASES = new Set<CyclePhase>([
  "implementation",
  "test",
  "review",
  "resolution",
  "rereview",
  "document",
]);

type CycleIdentity = Pick<CyclePhaseRoute, "provider" | "model" | "thinking">;

type CycleBlockerGuidance = {
  code: string;
  guidance: string;
  terminal: boolean;
};

type CyclePhaseWidgetInput = {
  status: CycleStatus;
  source: string;
  phase: CyclePhase;
  nextPhase: CyclePhase | null;
  mode: CycleMode;
  reviewAttempts: number;
  reviewCap: number;
  route?: CyclePhaseRoute;
  activity?: string;
  actual?: CycleIdentity;
  blockers: readonly string[];
};

const safeText = (value: unknown) => String(value ?? "")
  .replace(/[\r\n\t]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const widgetLine = (value: string) => safeText(value).slice(0, MAX_WIDGET_LINE_LENGTH);

const routeText = (route?: CyclePhaseRoute) => route
  ? `${route.profile || "none"} · ${route.source} · ${route.provider}/${route.model} · thinking ${route.thinking ?? "default"}`
  : "none";

const actualText = (actual: CycleIdentity) => `${actual.provider}/${actual.model} · thinking ${actual.thinking ?? "default"}`;

const phaseStatus = (status: CycleStatus) => status === "awaiting-evidence"
  ? "executing"
  : status === "awaiting-resume"
    ? "awaiting"
    : status;

const isVisibleStatus = (status: CycleStatus) => [
  "awaiting-evidence",
  "blocked",
  "blocked-after-tracker-close",
].includes(status);

export const buildCycleStartAck = (
  source: string,
  options: { reviewCap?: number; implementationMode?: string; mode?: string } = {},
) => `IMA cycle: start accepted for ${safeText(source)} — preparing plan phase (mode ${options.mode ?? "guided"}, review cap ${options.reviewCap ?? 5}). Working…`;

export const describeCyclePhaseActivity = (rawActivity: string) => {
  const activity = safeText(rawActivity);
  if (activity === "phase agent started") return "Phase agent started.";
  if (activity === "phase agent settled") return "Phase agent settled; validating lifecycle evidence.";
  if (activity.startsWith("phase tool: ")) return `Using ${activity.slice("phase tool: ".length)}.`;
  return activity;
};

export const describeCycleBlockers = (blockers: readonly string[]): CycleBlockerGuidance[] => blockers.map((code) => {
  if (code === "plan:BLOCKED") {
    return {
      code,
      guidance: "Inspect the plan artifact, correct scope or decompose multiple units, then run /ima:cycle resume.",
      terminal: false,
    };
  }
  if (code === "test:DEFECTS") {
    return {
      code,
      guidance: "Legacy test defects resume at implementation for plan-bound repair and retest before fresh review.",
      terminal: false,
    };
  }
  if (code === "review_cap_exceeded") {
    return {
      code,
      guidance: "Change-request cap reached; resolve findings manually and start a fresh review. Resume cannot bypass the cap.",
      terminal: true,
    };
  }
  if (code === "phase_transition_invalid") {
    return {
      code,
      guidance: "Inspect lifecycle evidence; no resume is available for an invalid phase transition.",
      terminal: true,
    };
  }
  if (["lifecycle_closeout_failed", "blocked-after-tracker-close"].includes(code)) {
    return {
      code,
      guidance: "Tracker closed but lifecycle persistence failed; re-persist closeout manually. Tracker mutation is not retried.",
      terminal: true,
    };
  }
  const phase = code.replace(/:BLOCKED$/, "") as CyclePhase;
  if (code.endsWith(":BLOCKED") && RETRIABLE_PHASES.has(phase)) {
    return {
      code,
      guidance: "Inspect the persisted phase artifact, correct the external blocker, then run /ima:cycle resume.",
      terminal: false,
    };
  }
  return {
    code,
    guidance: "Inspect the persisted artifact and correct the blocker before resuming.",
    terminal: false,
  };
});

export const buildCyclePhaseCompletion = (phase: CyclePhase, actual: CycleIdentity) =>
  `Cycle ${phase} completed with ${actualText(actual)}.`;

export const buildCyclePhaseWidget = (input: CyclePhaseWidgetInput): string[] => {
  if (!isVisibleStatus(input.status)) return [];
  const lines = [
    `IMA cycle · ${input.source}`,
    `phase ${input.phase} · ${phaseStatus(input.status)} → next ${input.nextPhase ?? "end"}`,
    `route ${routeText(input.route)}`,
  ];
  if (input.activity && input.status === "awaiting-evidence") lines.push(`activity: ${describeCyclePhaseActivity(input.activity)}`);
  lines.push(`review ${input.reviewAttempts}/${input.reviewCap} · mode ${input.mode}`);
  if (input.actual) lines.push(`actual ${actualText(input.actual)}`);
  for (const blocker of describeCycleBlockers(input.blockers)) lines.push(`blocker ${blocker.code} — ${blocker.guidance}`);
  return lines.map(widgetLine);
};
