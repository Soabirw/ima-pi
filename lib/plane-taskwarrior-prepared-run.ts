import {
  buildHistoricalMigrationPlan,
  buildMigrationPlan,
  buildReconciliationReport,
  reconcilePlannedItems,
  reconcilePlannedRelations,
  validateMigrationPlan,
  validateReconciliationReport,
} from "./plane-taskwarrior-migration.ts";
import {
  applyMigrationPlan,
  isMigrationCheckpointComplete,
  migrationCheckpointSummary,
  normalizeMigrationCheckpoint,
  observeMigrationPlan,
  reportMigrationProgress,
} from "./plane-taskwarrior-migration-execution.ts";
import type { MigrationProgress } from "./plane-taskwarrior-migration-execution.ts";
import { oneIdentityMatch } from "./plane-taskwarrior-migration-preflight.ts";
import {
  buildPreparationSource,
  decisionsToPlanInputs,
} from "./plane-taskwarrior-planning.ts";

const PREPARATION_SOURCE_SCHEMA_VERSION = 2;
const LIVE_READINESS_SCHEMA_VERSION = 2;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY = "READY";
const BLOCKED = "BLOCKED";
const UNVERIFIED_WRITE = "UNVERIFIED_WRITE";

export class PreparedMigrationError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "PreparedMigrationError";
    this.code = code;
    this.details = details;
  }
}

export const isPreparedMigrationError = (error) => error instanceof PreparedMigrationError;

const preparedFailure = (code, details) => {
  throw new PreparedMigrationError(code, details);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

const sameValue = (left, right) => JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const sourceDestinationsMatchDiscovery = (source) => {
  for (const decision of source.decisions) {
    if (decision.action !== "migrate") continue;
    const destination = decision.destination;
    const discovery = source.discovered.find((entry) => entry.project.id === destination.projectId);
    if (
      destination.workspace !== source.workspace
      || !discovery
      || discovery.project.archivedAt !== null
      || discovery.project.identifier !== destination.projectKey
      || discovery.project.name !== destination.projectName
      || discovery.identityLookup.status !== "ready"
      || discovery.compatibility.compatible !== true
      || discovery.compatibility.backlogStateId !== destination.backlogStateId
      || discovery.compatibility.doneStateId !== destination.doneStateId
    ) {
      preparedFailure("PREPARED_DESTINATION_UNAUTHORIZED");
    }
  }
};

const canonicalSource = (source) => {
  if (!isRecord(source) || source.schemaVersion !== PREPARATION_SOURCE_SCHEMA_VERSION) {
    preparedFailure("PREPARED_SOURCE_INVALID");
  }

  let canonical;
  try {
    canonical = buildPreparationSource({
      workspace: source.workspace,
      decisions: source.decisions,
      discovered: source.discovered,
      tasks: source.tasks,
    });
  } catch {
    preparedFailure("PREPARED_SOURCE_INVALID");
  }
  if (!sameValue(source, canonical)) preparedFailure("PREPARED_SOURCE_INVALID");
  sourceDestinationsMatchDiscovery(canonical);
  return canonical;
};

export const validatePreparedMigrationRun = ({ source, plan }) => {
  const preparedSource = canonicalSource(source);
  let migrationPlan;
  try {
    migrationPlan = validateMigrationPlan(plan);
  } catch {
    preparedFailure("PREPARED_PLAN_INVALID");
  }

  let inputs;
  let enrichedPlan;
  try {
    inputs = decisionsToPlanInputs({
      decisions: preparedSource.decisions,
      tasks: preparedSource.tasks,
    });
    enrichedPlan = buildMigrationPlan({
      worksheet: inputs.projectMappings,
      destinations: inputs.destinations,
      tasks: inputs.tasks,
    });
  } catch {
    preparedFailure("PREPARED_PLAN_SOURCE_MISMATCH");
  }
  if (sameValue(migrationPlan, enrichedPlan)) return { source: preparedSource, plan: migrationPlan };

  let historicalPlan;
  try {
    historicalPlan = buildHistoricalMigrationPlan({
      worksheet: inputs.projectMappings,
      destinations: inputs.destinations,
      tasks: inputs.tasks,
    });
  } catch {
    preparedFailure("PREPARED_PLAN_SOURCE_MISMATCH");
  }
  if (!sameValue(migrationPlan, historicalPlan)) preparedFailure("PREPARED_PLAN_SOURCE_MISMATCH");

  return { source: preparedSource, plan: migrationPlan };
};

const artifactName = (artifactApi, key) => {
  const name = artifactApi?.MIGRATION_ARTIFACTS?.[key];
  if (typeof name !== "string") preparedFailure("ARTIFACT_API_INVALID");
  return name;
};

const readPreparedArtifacts = async ({ artifactApi, run }) => {
  const [source, plan] = await Promise.all([
    artifactApi.readRunArtifact({ run, name: artifactName(artifactApi, "source") }),
    artifactApi.readRunArtifact({ run, name: artifactName(artifactApi, "plan") }),
  ]);
  return validatePreparedMigrationRun({ source, plan });
};

export const inspectPreparedMigration = async ({ cwd, relativeRunPath, artifactApi }) => {
  const run = await artifactApi.loadMigrationRun({ cwd, relativeRunPath });
  const prepared = await readPreparedArtifacts({ artifactApi, run });
  return { run, ...prepared };
};

const optionalRunArtifact = async ({ artifactApi, run, name }) => {
  try {
    return await artifactApi.readRunArtifact({ run, name });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
};

const READINESS_CAPABILITY_STATUSES = new Map([
  ["project_states", [READY, BLOCKED]],
  ["external_identity_lookup", [READY, BLOCKED]],
  ["work_item_creation", [UNVERIFIED_WRITE]],
  ["work_item_relations", [UNVERIFIED_WRITE]],
  ["relation_creation", [UNVERIFIED_WRITE]],
]);
const REQUIRED_READINESS_CAPABILITIES = new Set([
  "project_states",
  "external_identity_lookup",
]);

const plannedDestinationKeys = (plan) => {
  const projectKeys = new Set();
  for (const item of plan.items) {
    if (item.disposition === "create") projectKeys.add(item.destination.projectKey);
  }
  return projectKeys;
};

const readinessCapabilitiesAreValid = (capabilities) => {
  if (!Array.isArray(capabilities) || capabilities.length === 0) return false;

  const capabilityNames = new Set();
  const validEntries = capabilities.every((entry) => {
    const allowedStatuses = isRecord(entry) && typeof entry.capability === "string"
      ? READINESS_CAPABILITY_STATUSES.get(entry.capability)
      : undefined;
    if (
      !allowedStatuses
      || capabilityNames.has(entry.capability)
      || !allowedStatuses.includes(entry.status)
    ) {
      return false;
    }
    capabilityNames.add(entry.capability);
    return true;
  });

  return validEntries && [...REQUIRED_READINESS_CAPABILITIES]
    .every((capabilityName) => capabilityNames.has(capabilityName));
};

const readinessDestinationsAreValid = ({ destinations, plan }) => {
  const expectedProjectKeys = plannedDestinationKeys(plan);
  if (
    expectedProjectKeys.size === 0
    || !Array.isArray(destinations)
    || destinations.length !== expectedProjectKeys.size
  ) {
    return false;
  }

  const reportedProjectKeys = new Set();
  return destinations.every((destination) => {
    if (
      !isRecord(destination)
      || typeof destination.projectKey !== "string"
      || destination.projectKey === ""
      || !expectedProjectKeys.has(destination.projectKey)
      || reportedProjectKeys.has(destination.projectKey)
      || !readinessCapabilitiesAreValid(destination.capabilities)
    ) {
      return false;
    }
    reportedProjectKeys.add(destination.projectKey);
    return true;
  }) && reportedProjectKeys.size === expectedProjectKeys.size;
};

const readinessOutcomeFrom = ({ report, plan }) => {
  if (report === null) return null;
  if (
    !isRecord(report)
    || (report.schemaVersion !== 1 && report.schemaVersion !== LIVE_READINESS_SCHEMA_VERSION)
    || report.planSha256 !== plan.planSha256
    || (report.outcome !== READY && report.outcome !== BLOCKED)
    || !readinessDestinationsAreValid({ destinations: report.destinations, plan })
  ) {
    preparedFailure("READINESS_REPORT_INVALID");
  }

  const outcome = report.destinations.some((destination) =>
    destination.capabilities.some((entry) =>
      REQUIRED_READINESS_CAPABILITIES.has(entry.capability) && entry.status === BLOCKED))
    ? BLOCKED
    : READY;
  if (report.outcome !== outcome) preparedFailure("READINESS_REPORT_INVALID");
  return outcome;
};

const relationKeyFor = (relation) => `${relation.sourceTaskUuid}:${relation.targetTaskUuid}`;

const reconciliationMatchesPlan = ({ report, plan }) => {
  let validatedReport;
  try {
    validatedReport = validateReconciliationReport({ report, plan });
  } catch {
    preparedFailure("RECONCILIATION_REPORT_INVALID");
  }

  const itemStatusByTaskUuid = new Map(validatedReport.items.map((item) => [item.taskUuid, item.status]));
  const relationStatusByKey = new Map(validatedReport.relations.map((relation) => [
    relationKeyFor(relation),
    relation.status,
  ]));
  const itemsMatch = plan.items.every((item) =>
    itemStatusByTaskUuid.get(item.taskUuid) === (item.disposition === "create" ? "matched" : "skipped"));
  const relationsMatch = [
    ...plan.eligibleRelations.map((relation) => ({ relation, status: "matched" })),
    ...plan.skippedRelations.map((relation) => ({ relation, status: "skipped" })),
  ].every(({ relation, status }) => relationStatusByKey.get(relationKeyFor(relation)) === status);

  return itemsMatch && relationsMatch;
};

export const classifyPreparedMigrationStatus = ({
  plan,
  checkpoint,
  readinessReport,
  reconciliationReport,
}) => {
  const migrationPlan = validateMigrationPlan(plan);
  const readiness = readinessOutcomeFrom({
    report: readinessReport,
    plan: migrationPlan,
  });
  if (reconciliationReport !== null && checkpoint === null) {
    preparedFailure("RECONCILIATION_REPORT_INVALID");
  }
  if (reconciliationReport !== null && reconciliationMatchesPlan({ report: reconciliationReport, plan: migrationPlan })) {
    return { state: "reconciled", readiness };
  }
  if (checkpoint !== null) {
    return {
      state: isMigrationCheckpointComplete({ plan: migrationPlan, checkpoint })
        ? "applied"
        : "partially-applied",
      readiness,
    };
  }
  return { state: readiness === BLOCKED ? "blocked" : "prepared", readiness };
};

export const readPreparedMigrationStatus = async ({ cwd, relativeRunPath, artifactApi }) => {
  const { run, source, plan } = await inspectPreparedMigration({ cwd, relativeRunPath, artifactApi });
  const [checkpoint, readinessReport, reconciliationReport] = await Promise.all([
    artifactApi.readCheckpoint({ run }),
    optionalRunArtifact({ artifactApi, run, name: artifactName(artifactApi, "preflightReport") }),
    optionalRunArtifact({ artifactApi, run, name: artifactName(artifactApi, "reconciliationReport") }),
  ]);
  const status = classifyPreparedMigrationStatus({
    plan,
    checkpoint,
    readinessReport,
    reconciliationReport,
  });
  return { relativeRunPath: run.relativeRunPath, planSha256: plan.planSha256, summary: plan.summary, ...status };
};

const preparedDestinationsFor = ({ source, plan }) => {
  const itemsByProjectId = new Map();
  for (const item of plan.items) {
    if (item.disposition !== "create") continue;
    const items = itemsByProjectId.get(item.destination.projectId) ?? [];
    itemsByProjectId.set(item.destination.projectId, [...items, item]);
  }

  const destinationsByProjectId = new Map();
  for (const decision of source.decisions) {
    if (decision.action !== "migrate") continue;
    const items = itemsByProjectId.get(decision.destination.projectId) ?? [];
    if (items.length === 0) preparedFailure("PREPARED_DESTINATION_UNAUTHORIZED");
    destinationsByProjectId.set(decision.destination.projectId, {
      ...decision.destination,
      items,
    });
  }
  return [...destinationsByProjectId.values()].sort((left, right) =>
    left.projectKey.localeCompare(right.projectKey));
};

const capability = (name, status, extra = {}) => ({ capability: name, status, ...extra });

const writeCapabilities = () => [
  capability("work_item_creation", UNVERIFIED_WRITE, { reason: "WRITE_ONLY" }),
  capability("work_item_relations", UNVERIFIED_WRITE, { reason: "DEFERRED_TO_APPLY" }),
  capability("relation_creation", UNVERIFIED_WRITE, { reason: "WRITE_ONLY" }),
];

const safeReason = (error, fallback) => {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
  return code !== null && /^[A-Z0-9_:-]+$/.test(code) ? code : fallback;
};

const statesMatchDestination = ({ states, destination }) => {
  if (!Array.isArray(states)) preparedFailure("STATE_LIST_INVALID");
  const normalized = states.map((state) => {
    if (!isRecord(state)) preparedFailure("STATE_RECORD_INVALID");
    if (!isUuid(state.id)) preparedFailure("STATE_UUID_INVALID");
    if (typeof state.group !== "string") preparedFailure("STATE_GROUP_INVALID");
    return { id: state.id.toLowerCase(), group: state.group };
  });
  const stateMatches = (stateId, group, prefix) => {
    const matches = normalized.filter((state) => state.id === stateId);
    if (matches.length === 0) preparedFailure(`${prefix}_STATE_MISSING`);
    if (matches.length > 1) preparedFailure(`${prefix}_STATE_AMBIGUOUS`);
    if (matches[0].group !== group) preparedFailure(`${prefix}_STATE_GROUP_INVALID`);
  };
  stateMatches(destination.backlogStateId, "backlog", "BACKLOG");
  stateMatches(destination.doneStateId, "completed", "DONE");
};

const readinessForDestination = async ({
  client,
  destination,
  onProgress,
  completed,
  total,
}) => {
  const report = (readinessStep, readinessCompleted, readinessTotal) => {
    reportMigrationProgress(onProgress, {
      phase: "checking-readiness",
      completed,
      total,
      projectKey: destination.projectKey,
      readinessStep,
      readinessCompleted,
      readinessTotal,
    });
  };

  report("project-states", 0, 1);
  let stateCapability;
  try {
    if (!isRecord(client) || typeof client.listProjectStates !== "function") {
      preparedFailure("READ_CLIENT_UNAVAILABLE");
    }
    const states = await client.listProjectStates({
      workspace: destination.workspace,
      projectId: destination.projectId,
    });
    statesMatchDestination({ states, destination });
    stateCapability = capability("project_states", READY);
  } catch (error) {
    stateCapability = capability("project_states", BLOCKED, {
      reason: safeReason(error, "STATE_READ_FAILED"),
    });
  }
  report("project-states", 1, 1);

  let identityMatchCount = 0;
  let identityReason = null;
  report("external-identities", 0, destination.items.length);
  for (const [index, item] of destination.items.entries()) {
    try {
      if (!isRecord(client) || typeof client.listProjectWorkItems !== "function") {
        preparedFailure("READ_CLIENT_UNAVAILABLE");
      }
      const workItems = await client.listProjectWorkItems({
        workspace: destination.workspace,
        projectId: destination.projectId,
        externalId: item.workItem.externalId,
        externalSource: item.workItem.externalSource,
      });
      if (oneIdentityMatch({ workItems, item })) identityMatchCount += 1;
    } catch (error) {
      identityReason = safeReason(error, "IDENTITY_LOOKUP_FAILED");
    }
    report("external-identities", index + 1, destination.items.length);
    if (identityReason !== null) break;
  }

  return {
    projectKey: destination.projectKey,
    capabilities: [
      stateCapability,
      identityReason === null
        ? capability("external_identity_lookup", READY, {
          identityCheckCount: destination.items.length,
          identityMatchCount,
        })
        : capability("external_identity_lookup", BLOCKED, { reason: identityReason }),
      ...writeCapabilities(),
    ],
  };
};

const blockedReadinessReport = ({ source, plan, reason }) => ({
  schemaVersion: LIVE_READINESS_SCHEMA_VERSION,
  planSha256: plan.planSha256,
  outcome: BLOCKED,
  destinations: preparedDestinationsFor({ source, plan }).map((destination) => ({
    projectKey: destination.projectKey,
    capabilities: [
      capability("project_states", BLOCKED, { reason }),
      capability("external_identity_lookup", BLOCKED, { reason }),
      ...writeCapabilities(),
    ],
  })),
});

export const runPreparedMigrationReadiness = async ({ client, source, plan, onProgress }: {
  client: unknown;
  source: unknown;
  plan: unknown;
  onProgress?: MigrationProgress;
}) => {
  const prepared = validatePreparedMigrationRun({ source, plan });
  const destinations = preparedDestinationsFor(prepared);
  const reports = [];
  reportMigrationProgress(onProgress, {
    phase: "checking-readiness",
    completed: 0,
    total: destinations.length,
  });
  for (const [index, destination] of destinations.entries()) {
    reports.push(await readinessForDestination({
      client,
      destination,
      onProgress,
      completed: index,
      total: destinations.length,
    }));
    reportMigrationProgress(onProgress, {
      phase: "checking-readiness",
      completed: index + 1,
      total: destinations.length,
    });
  }
  return {
    schemaVersion: LIVE_READINESS_SCHEMA_VERSION,
    planSha256: prepared.plan.planSha256,
    outcome: reports.some((report) => report.capabilities.some(({ status }) => status === BLOCKED))
      ? BLOCKED
      : READY,
    destinations: reports,
  };
};

const persistReadinessReport = async ({ artifactApi, run, report }) => {
  try {
    await artifactApi.replaceRunArtifact({
      run,
      name: artifactName(artifactApi, "preflightReport"),
      value: report,
    });
  } catch {
    preparedFailure("READINESS_REPORT_WRITE_FAILED");
  }
};

const invalidateReconciliationReport = async ({ artifactApi, run }) => {
  try {
    await artifactApi.clearReconciliationReport({ run });
  } catch {
    preparedFailure("RECONCILIATION_INVALIDATION_FAILED");
  }
};

const readinessWithClient = async ({ env, createClient, readConfig, source, plan, onProgress }) => {
  reportMigrationProgress(onProgress, { phase: "checking-readiness" });
  try {
    const client = createClient(readConfig(env));
    const report = await runPreparedMigrationReadiness({ client, source, plan, onProgress });
    return { client, report };
  } catch {
    return {
      client: null,
      report: blockedReadinessReport({ source, plan, reason: "READINESS_UNAVAILABLE" }),
    };
  }
};

const reviewedHash = (value) => {
  if (typeof value !== "string" || !PLAN_HASH_PATTERN.test(value)) preparedFailure("REVIEWED_HASH_INVALID");
  return value;
};

export const applyPreparedMigration = async ({
  cwd,
  relativeRunPath,
  reviewedPlanSha256,
  env,
  artifactApi,
  createClient,
  readConfig,
  toErrorCode,
  onProgress,
}: {
  cwd: string;
  relativeRunPath: string;
  reviewedPlanSha256: string;
  env: NodeJS.ProcessEnv;
  artifactApi: typeof import("./plane-taskwarrior-migration-artifacts.ts");
  createClient: (config: unknown) => unknown;
  readConfig: (env: NodeJS.ProcessEnv) => unknown;
  toErrorCode: (error: unknown) => string;
  onProgress?: MigrationProgress;
}) => {
  const reviewedHashValue = reviewedHash(reviewedPlanSha256);
  const initial = await inspectPreparedMigration({ cwd, relativeRunPath, artifactApi });
  if (initial.plan.planSha256 !== reviewedHashValue) preparedFailure("PLAN_HASH_MISMATCH");

  reportMigrationProgress(onProgress, { phase: "waiting-for-lock" });
  return artifactApi.withMigrationLock({
    run: initial.run,
    operation: async () => {
      reportMigrationProgress(onProgress, { phase: "revalidating-run" });
      const locked = await readPreparedArtifacts({ artifactApi, run: initial.run });
      if (locked.plan.planSha256 !== reviewedHashValue) preparedFailure("PLAN_HASH_CHANGED");

      const readiness = await readinessWithClient({
        env,
        createClient,
        readConfig,
        source: locked.source,
        plan: locked.plan,
        onProgress,
      });
      await persistReadinessReport({ artifactApi, run: initial.run, report: readiness.report });
      reportMigrationProgress(onProgress, {
        phase: "readiness-persisted",
        outcome: readiness.report.outcome,
      });
      if (readiness.report.outcome !== READY || readiness.client === null) {
        preparedFailure("READINESS_BLOCKED");
      }

      const checkpoint = normalizeMigrationCheckpoint(
        await artifactApi.readCheckpoint({ run: initial.run }),
        locked.plan,
      );
      reportMigrationProgress(onProgress, { phase: "checkpoint-loaded" });
      await invalidateReconciliationReport({ artifactApi, run: initial.run });
      reportMigrationProgress(onProgress, { phase: "reconciliation-invalidated" });
      const appliedCheckpoint = await applyMigrationPlan({
        client: readiness.client,
        plan: locked.plan,
        checkpoint,
        artifactApi,
        run: initial.run,
        toErrorCode,
        onProgress,
      });
      return {
        relativeRunPath: initial.run.relativeRunPath,
        planSha256: locked.plan.planSha256,
        state: isMigrationCheckpointComplete({ plan: locked.plan, checkpoint: appliedCheckpoint })
          ? "applied"
          : "partially-applied",
        readiness: READY,
        ...migrationCheckpointSummary({ plan: locked.plan, checkpoint: appliedCheckpoint }),
      };
    },
  });
};

const checkpointForReconciliation = async ({ artifactApi, run, plan }) => {
  const checkpoint = await artifactApi.readCheckpoint({ run });
  if (checkpoint === null) preparedFailure("CHECKPOINT_REQUIRED");
  return normalizeMigrationCheckpoint(checkpoint, plan);
};

export const reconcilePreparedMigration = async ({
  cwd,
  relativeRunPath,
  env,
  artifactApi,
  createClient,
  readConfig,
  onProgress,
}: {
  cwd: string;
  relativeRunPath: string;
  env: NodeJS.ProcessEnv;
  artifactApi: typeof import("./plane-taskwarrior-migration-artifacts.ts");
  createClient: (config: unknown) => unknown;
  readConfig: (env: NodeJS.ProcessEnv) => unknown;
  onProgress?: MigrationProgress;
}) => {
  const initial = await inspectPreparedMigration({ cwd, relativeRunPath, artifactApi });
  await checkpointForReconciliation({ artifactApi, run: initial.run, plan: initial.plan });

  reportMigrationProgress(onProgress, { phase: "waiting-for-lock" });
  return artifactApi.withMigrationLock({
    run: initial.run,
    operation: async () => {
      reportMigrationProgress(onProgress, { phase: "revalidating-run" });
      const locked = await readPreparedArtifacts({ artifactApi, run: initial.run });
      const checkpoint = await checkpointForReconciliation({
        artifactApi,
        run: initial.run,
        plan: locked.plan,
      });
      reportMigrationProgress(onProgress, { phase: "reconciliation-checkpoint-loaded" });
      let client;
      try {
        client = createClient(readConfig(env));
      } catch {
        preparedFailure("RECONCILIATION_UNAVAILABLE");
      }

      let observed;
      try {
        observed = await observeMigrationPlan({ client, plan: locked.plan, onProgress });
      } catch {
        preparedFailure("RECONCILIATION_READ_FAILED");
      }
      reportMigrationProgress(onProgress, { phase: "building-reconciliation" });
      const report = buildReconciliationReport({
        plan: locked.plan,
        itemReconciliation: reconcilePlannedItems({
          plan: locked.plan,
          observedItemsByTaskUuid: observed.observedItemsByTaskUuid,
        }),
        relationReconciliation: reconcilePlannedRelations({
          plan: locked.plan,
          planeItemIdsByTaskUuid: observed.planeItemIdsByTaskUuid,
          observedRelationsByTaskUuid: observed.observedRelationsByTaskUuid,
        }),
        unresolvedRelationAttempts: checkpoint.unresolvedRelationAttempts,
      });
      try {
        await artifactApi.replaceRunArtifact({
          run: initial.run,
          name: artifactName(artifactApi, "reconciliationReport"),
          value: report,
        });
      } catch {
        preparedFailure("RECONCILIATION_REPORT_WRITE_FAILED");
      }
      reportMigrationProgress(onProgress, { phase: "reconciliation-persisted" });

      return {
        relativeRunPath: initial.run.relativeRunPath,
        planSha256: locked.plan.planSha256,
        state: reconciliationMatchesPlan({ report, plan: locked.plan })
          ? "reconciled"
          : isMigrationCheckpointComplete({ plan: locked.plan, checkpoint })
            ? "applied"
            : "partially-applied",
        summary: report.summary,
      };
    },
  });
};
