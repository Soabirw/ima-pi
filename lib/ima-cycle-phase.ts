import { resolveCommandRoute, type ImaModelMapping, type ResolvedImaConfig, type ThinkingLevel } from "./ima-config.ts";

export const CYCLE_PHASE_EXECUTION_SCHEMA_VERSION = 1;
export const CYCLE_PHASE_SETTLEMENT_SCHEMA_VERSION = 1;
export const CYCLE_PHASE_SETTLEMENT_ENTRY = "ima-cycle-phase-settlement";
export const CYCLE_PHASE_EXECUTION_STATUSES = ["starting", "running", "waiting-reply", "settled", "stopped", "interrupted", "failed"] as const;

export type CyclePhaseExecutionStatus = (typeof CYCLE_PHASE_EXECUTION_STATUSES)[number];
export type CyclePhaseRouteSource = "command" | "high" | "parent";
export type CyclePhaseRoute = {
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
  profile: string | null;
  source: CyclePhaseRouteSource;
};
export type CyclePhaseExecution = {
  schemaVersion: 1;
  dispatchId: string;
  phase: string;
  route: CyclePhaseRoute;
  parentSessionId: string;
  childSessionId?: string;
  childSessionFile?: string;
  childSessionDir?: string;
  status: CyclePhaseExecutionStatus;
  possiblePartialWrite: boolean;
  startedAt: string;
  updatedAt: string;
};

export type CyclePhaseContext = {
  schemaVersion: 1;
  project: string;
  lifecycleKey: string;
  source: string;
  phase: string;
  dispatchId: string;
};

export type CyclePhaseArtifactReference = {
  artifactId: string | null;
  recordKey: string | null;
};

export type CyclePhaseSettlement = {
  schemaVersion: 1;
  project: string;
  lifecycleKey: string;
  source: string;
  phase: string;
  dispatchId: string;
  childSessionId: string;
  actual: {
    provider: string;
    model: string;
    thinking: ThinkingLevel;
  };
  artifacts: CyclePhaseArtifactReference[];
};

type CycleRouteConfig = Pick<ResolvedImaConfig, "commands" | "phases" | "models">;
type RouteInput = { provider: string; model: string; thinking?: ThinkingLevel };
type ValidExecutionInput = Omit<CyclePhaseExecution, "schemaVersion">;

const DISPATCH_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const PHASE = /^(plan|implementation|test|review|resolution|rereview|document)$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const ABSOLUTE_PATH = /^\//;
const hasText = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TEXT.test(value);
const isTimestamp = (value: unknown) => hasText(value, 64) && ISO_TIMESTAMP.test(value);
const isThinkingLevel = (value: unknown): value is ThinkingLevel | undefined =>
  value === undefined || ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string);
const hasUniqueArtifacts = (artifacts: CyclePhaseArtifactReference[]) => {
  const seen = new Set<string>();
  return artifacts.every((artifact) => {
    const key = `${artifact.artifactId ?? ""}\u0000${artifact.recordKey ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const routeFrom = (
  mapping: ImaModelMapping | RouteInput,
  profile: string | null,
  source: CyclePhaseRouteSource,
  fallbackThinking?: ThinkingLevel,
): CyclePhaseRoute => ({
  provider: mapping.provider,
  model: mapping.model,
  ...((mapping.thinking ?? fallbackThinking) ? { thinking: mapping.thinking ?? fallbackThinking } : {}),
  profile,
  source,
});

export function selectCycleOrchestratorRoute(input: {
  config: CycleRouteConfig;
  parentRoute: RouteInput;
  profile: string | null;
}): CyclePhaseRoute {
  const command = resolveCommandRoute(input.config, "cycle");
  if (command) return routeFrom(command, input.profile, "command", input.parentRoute.thinking);
  const high = input.config.models.HIGH;
  if (high) return routeFrom(high, input.profile, "high", input.parentRoute.thinking);
  return routeFrom(input.parentRoute, input.profile, "parent");
}

export function selectCyclePhaseRoute(input: {
  config: CycleRouteConfig;
  command: string;
  parentRoute: RouteInput;
  profile: string | null;
}): CyclePhaseRoute {
  const command = resolveCommandRoute(input.config, input.command);
  return command
    ? routeFrom(command, input.profile, "command", input.parentRoute.thinking)
    : routeFrom(input.parentRoute, input.profile, "parent");
}

export function isCyclePhaseRoute(value: unknown): value is CyclePhaseRoute {
  const route = value as CyclePhaseRoute | null;
  return Boolean(
    route
      && hasText(route.provider, 256)
      && hasText(route.model, 256)
      && isThinkingLevel(route.thinking)
      && (route.profile === null || hasText(route.profile, 128))
      && ["command", "high", "parent"].includes(route.source),
  );
}

export function createCyclePhaseExecution(input: ValidExecutionInput): CyclePhaseExecution | null {
  const candidate: CyclePhaseExecution = {
    schemaVersion: CYCLE_PHASE_EXECUTION_SCHEMA_VERSION,
    ...input,
  };
  return validateCyclePhaseExecution(candidate) ? candidate : null;
}

export function validateCyclePhaseExecution(value: unknown): value is CyclePhaseExecution {
  const execution = value as CyclePhaseExecution | null;
  if (!execution || execution.schemaVersion !== CYCLE_PHASE_EXECUTION_SCHEMA_VERSION) return false;
  if (!hasText(execution.dispatchId, 128) || !DISPATCH_ID.test(execution.dispatchId)) return false;
  if (!hasText(execution.phase, 32) || !PHASE.test(execution.phase)) return false;
  if (!isCyclePhaseRoute(execution.route) || !hasText(execution.parentSessionId, 256)) return false;
  if (!CYCLE_PHASE_EXECUTION_STATUSES.includes(execution.status)) return false;
  if (typeof execution.possiblePartialWrite !== "boolean" || !isTimestamp(execution.startedAt) || !isTimestamp(execution.updatedAt)) return false;

  const hasChildIdentity = execution.childSessionId !== undefined
    || execution.childSessionFile !== undefined
    || execution.childSessionDir !== undefined;
  if (!hasChildIdentity) return ["starting", "failed", "stopped", "interrupted"].includes(execution.status);
  if (!hasText(execution.childSessionId, 256)) return false;
  if (!hasText(execution.childSessionFile, 2_048) || !ABSOLUTE_PATH.test(execution.childSessionFile)) return false;
  if (!hasText(execution.childSessionDir, 2_048) || !ABSOLUTE_PATH.test(execution.childSessionDir)) return false;
  return true;
}

export function withCyclePhaseExecution(
  execution: CyclePhaseExecution,
  patch: Partial<Omit<CyclePhaseExecution, "schemaVersion" | "dispatchId" | "phase" | "route" | "parentSessionId" | "startedAt">>,
): CyclePhaseExecution | null {
  return createCyclePhaseExecution({
    ...execution,
    ...patch,
  });
}

export function hasMatchingCyclePhaseExecution(input: {
  execution: CyclePhaseExecution | undefined;
  phase: string;
  dispatchId: string;
  childSessionId?: string;
}): boolean {
  const { execution } = input;
  if (!execution || execution.phase !== input.phase || execution.dispatchId !== input.dispatchId) return false;
  return input.childSessionId === undefined || execution.childSessionId === input.childSessionId;
}

export function canResumeCyclePhaseExecution(execution: CyclePhaseExecution | undefined): boolean {
  return Boolean(
    execution
      && validateCyclePhaseExecution(execution)
      && ["running", "waiting-reply", "interrupted"].includes(execution.status)
      && execution.childSessionId
      && execution.childSessionFile
      && execution.childSessionDir,
  );
}

export function validateCyclePhaseArtifactReference(value: unknown): value is CyclePhaseArtifactReference {
  const artifact = value as CyclePhaseArtifactReference | null;
  return Boolean(
    artifact
      && (artifact.artifactId === null || hasText(artifact.artifactId, 512))
      && (artifact.recordKey === null || hasText(artifact.recordKey, 1_024))
      && (artifact.artifactId !== null || artifact.recordKey !== null),
  );
}

export function validateCyclePhaseSettlement(value: unknown): value is CyclePhaseSettlement {
  const settlement = value as CyclePhaseSettlement | null;
  return Boolean(
    settlement
      && settlement.schemaVersion === CYCLE_PHASE_SETTLEMENT_SCHEMA_VERSION
      && hasText(settlement.project, 256)
      && hasText(settlement.lifecycleKey, 512)
      && hasText(settlement.source, 1_024)
      && hasText(settlement.phase, 32)
      && PHASE.test(settlement.phase)
      && hasText(settlement.dispatchId, 128)
      && DISPATCH_ID.test(settlement.dispatchId)
      && hasText(settlement.childSessionId, 256)
      && hasText(settlement.actual?.provider, 256)
      && hasText(settlement.actual?.model, 256)
      && settlement.actual?.thinking !== undefined
      && isThinkingLevel(settlement.actual.thinking)
      && Array.isArray(settlement.artifacts)
      && settlement.artifacts.length > 0
      && settlement.artifacts.length <= 8
      && settlement.artifacts.every(validateCyclePhaseArtifactReference)
      && hasUniqueArtifacts(settlement.artifacts),
  );
}

export function createCyclePhaseSettlement(input: Omit<CyclePhaseSettlement, "schemaVersion">): CyclePhaseSettlement | null {
  const settlement: CyclePhaseSettlement = {
    schemaVersion: CYCLE_PHASE_SETTLEMENT_SCHEMA_VERSION,
    ...input,
  };
  return validateCyclePhaseSettlement(settlement) ? settlement : null;
}

export function hasMatchingCyclePhaseSettlement(input: {
  settlement: CyclePhaseSettlement | undefined | null;
  execution: CyclePhaseExecution | undefined;
  context: CyclePhaseContext;
  artifact?: CyclePhaseArtifactReference;
}): boolean {
  const { settlement, execution, context, artifact } = input;
  if (!settlement || !execution || !validateCyclePhaseSettlement(settlement) || !validateCyclePhaseExecution(execution)) return false;
  if (!execution.childSessionId || context.schemaVersion !== 1) return false;
  if (
    settlement.project !== context.project
    || settlement.lifecycleKey !== context.lifecycleKey
    || settlement.source !== context.source
    || settlement.phase !== context.phase
    || settlement.dispatchId !== context.dispatchId
    || settlement.phase !== execution.phase
    || settlement.dispatchId !== execution.dispatchId
    || settlement.childSessionId !== execution.childSessionId
    || settlement.actual.provider !== execution.route.provider
    || settlement.actual.model !== execution.route.model
    || (execution.route.thinking !== undefined && settlement.actual.thinking !== execution.route.thinking)
  ) return false;
  return !artifact || settlement.artifacts.some((item) =>
    item.artifactId === artifact.artifactId && item.recordKey === artifact.recordKey,
  );
}
