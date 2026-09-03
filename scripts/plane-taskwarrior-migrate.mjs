#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as artifacts from "../lib/plane-taskwarrior-migration-artifacts.ts";
import {
  incompletePreflightReport,
  isMigrationPreflightError,
  oneIdentityMatch,
  runMigrationPreflight,
} from "../lib/plane-taskwarrior-migration-preflight.ts";
import {
  buildDryRunReport,
  buildMigrationPlan,
  buildReconciliationReport,
  reconcilePlannedItems,
  reconcilePlannedRelations,
} from "../lib/plane-taskwarrior-migration.ts";
import {
  createPlaneClient,
  readPlaneConfig,
  toPublicPlaneError,
} from "../skills/plane-api/scripts/plane-client.mjs";

const executeFile = promisify(execFileCallback);
const TASK_EXPORT_MAX_BUFFER = 32 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSHEET_PATH = "docs/plane-taskwarrior-project-map.md";
const CHECKPOINT_SCHEMA_VERSION = 1;

export const MIGRATION_DESTINATIONS = Object.freeze({
  WEB: Object.freeze({
    workspace: "ima",
    projectId: "0f641e48-5146-477d-9089-3a1ffc51169b",
    backlogStateId: "b6a6c51a-16fb-42fd-81fd-9d28949b7cc1",
    doneStateId: "122f911f-9199-4688-b6fb-e5a19a948a3c",
    representativeReference: "plane:ima:WEB-1",
  }),
  SKYNET: Object.freeze({
    workspace: "ima",
    projectId: "1ed41e2e-c344-4205-9763-b9e7e1dba3a8",
    backlogStateId: "cde5138f-0070-4279-9940-18e55cc9f6d6",
    doneStateId: "e91a7f90-127d-4ae4-b1cf-bc2819a384b3",
    representativeReference: "plane:ima:SKYNET-1",
  }),
});

export const usage = `Usage:
  plane-taskwarrior-migrate.mjs prepare
  plane-taskwarrior-migrate.mjs dry-run <relative-run-path>
  plane-taskwarrior-migrate.mjs preflight <relative-run-path>
  plane-taskwarrior-migrate.mjs apply <relative-run-path> <plan-sha256> confirm
  plane-taskwarrior-migrate.mjs reconcile <relative-run-path>
`;

class MigrationCliError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "MigrationCliError";
    this.code = code;
    this.details = details;
  }
}

const cliFail = (code, details) => {
  throw new MigrationCliError(code, details);
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const writeJson = (writer, value) => writer.write(`${JSON.stringify(value)}\n`);

const usageError = () => ({
  success: false,
  error: { code: "USAGE_ERROR", message: usage.trim() },
});

const parseCommand = (argv) => {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) return null;
  const [command, ...arguments_] = argv;
  if (command === "prepare" && arguments_.length === 0) return { command };
  if (command === "dry-run" && arguments_.length === 1) {
    return { command, relativeRunPath: arguments_[0] };
  }
  if (command === "preflight" && arguments_.length === 1) {
    return { command, relativeRunPath: arguments_[0] };
  }
  if (
    command === "apply"
    && arguments_.length === 3
    && HASH_PATTERN.test(arguments_[1])
    && arguments_[2] === "confirm"
  ) {
    return { command, relativeRunPath: arguments_[0], planSha256: arguments_[1] };
  }
  if (command === "reconcile" && arguments_.length === 1) {
    return { command, relativeRunPath: arguments_[0] };
  }
  return null;
};

export const stripPlaneEnvironment = (env) => Object.fromEntries(
  Object.entries(env).filter(([name]) => !name.startsWith("PLANE_")),
);

const parseTaskExport = (stdout) => {
  const content = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout;
  if (typeof content !== "string") cliFail("TASK_EXPORT_INVALID");
  try {
    const tasks = JSON.parse(content);
    if (!Array.isArray(tasks)) cliFail("TASK_EXPORT_INVALID");
    return tasks;
  } catch (error) {
    if (error instanceof MigrationCliError) throw error;
    cliFail("TASK_EXPORT_INVALID");
  }
};

const timestampFrom = (clock) => {
  const date = clock();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) cliFail("CLOCK_INVALID");
  return date.toISOString().replace(/[:.]/g, "-");
};

const runTaskwarriorExport = async ({ execFile, env }) => {
  try {
    const { stdout } = await execFile("task", ["export"], {
      shell: false,
      env: stripPlaneEnvironment(env),
      maxBuffer: TASK_EXPORT_MAX_BUFFER,
    });
    return parseTaskExport(stdout);
  } catch (error) {
    if (error instanceof MigrationCliError) throw error;
    cliFail("TASK_EXPORT_UNAVAILABLE");
  }
};

const sourceSnapshot = ({ worksheet, tasks }) => ({
  schemaVersion: 1,
  worksheet,
  tasks,
});

const initialCheckpoint = (plan) => ({
  schemaVersion: CHECKPOINT_SCHEMA_VERSION,
  planSha256: plan.planSha256,
  planeItemIdsByTaskUuid: {},
  itemOutcomesByTaskUuid: {},
  relationOutcomesByKey: {},
  unresolvedRelationAttempts: [],
});

const normalizeCheckpoint = (value, plan) => {
  if (value === null || value === undefined) return initialCheckpoint(plan);
  if (!isRecord(value) || value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || value.planSha256 !== plan.planSha256) {
    cliFail("CHECKPOINT_INVALID");
  }
  const requiredObjects = [
    value.planeItemIdsByTaskUuid,
    value.itemOutcomesByTaskUuid,
    value.relationOutcomesByKey,
  ];
  if (!requiredObjects.every(isRecord) || !Array.isArray(value.unresolvedRelationAttempts)) {
    cliFail("CHECKPOINT_INVALID");
  }

  const plannedItemIds = new Set(plan.items
    .filter((item) => item.disposition === "create")
    .map((item) => item.taskUuid));
  const plannedRelationKeys = new Set(plan.eligibleRelations.map(relationKeyFor));
  const validItemOutcomes = new Set(["created", "reused"]);
  const validRelationOutcomes = new Set(["created", "reused", "unresolved"]);
  const validItemIds = Object.entries(value.planeItemIdsByTaskUuid).every(([taskUuid, planeItemId]) =>
    plannedItemIds.has(taskUuid) && typeof planeItemId === "string" && UUID_PATTERN.test(planeItemId));
  const validItemOutcomesByTask = Object.entries(value.itemOutcomesByTaskUuid).every(([taskUuid, outcome]) =>
    plannedItemIds.has(taskUuid) && validItemOutcomes.has(outcome));
  const validRelationOutcomesByKey = Object.entries(value.relationOutcomesByKey).every(([key, outcome]) =>
    plannedRelationKeys.has(key) && validRelationOutcomes.has(outcome));
  const validUnresolvedAttempts = value.unresolvedRelationAttempts.every((attempt) =>
    isRecord(attempt)
    && plannedRelationKeys.has(`${attempt.sourceTaskUuid}:${attempt.targetTaskUuid}`)
    && typeof attempt.reason === "string"
    && /^[A-Z0-9_:-]+$/.test(attempt.reason));
  if (!validItemIds || !validItemOutcomesByTask || !validRelationOutcomesByKey || !validUnresolvedAttempts) {
    cliFail("CHECKPOINT_INVALID");
  }
  return value;
};

const relationKeyFor = (relation) => `${relation.sourceTaskUuid}:${relation.targetTaskUuid}`;

const checkpointWithItem = ({ checkpoint, taskUuid, planeItemId, outcome }) => ({
  ...checkpoint,
  planeItemIdsByTaskUuid: {
    ...checkpoint.planeItemIdsByTaskUuid,
    [taskUuid]: planeItemId,
  },
  itemOutcomesByTaskUuid: {
    ...checkpoint.itemOutcomesByTaskUuid,
    [taskUuid]: outcome,
  },
});

const checkpointWithRelation = ({ checkpoint, relation, outcome, reason = null }) => {
  const relationKey = relationKeyFor(relation);
  const unresolvedRelationAttempts = reason === null
    ? checkpoint.unresolvedRelationAttempts
    : [...checkpoint.unresolvedRelationAttempts, {
      sourceTaskUuid: relation.sourceTaskUuid,
      targetTaskUuid: relation.targetTaskUuid,
      reason,
    }];
  return {
    ...checkpoint,
    relationOutcomesByKey: {
      ...checkpoint.relationOutcomesByKey,
      [relationKey]: outcome,
    },
    unresolvedRelationAttempts,
  };
};

const planeErrorCode = (error) => {
  if (error instanceof MigrationCliError || isMigrationPreflightError(error)) return error.code;
  return toPublicPlaneError(error).code;
};

const clientFor = ({ env, createClient, readConfig }) => {
  const config = readConfig(env);
  return createClient(config);
};

const persistPreflightReport = async ({ artifactApi, run, report }) => {
  try {
    await artifactApi.replaceRunArtifact({
      run,
      name: artifactApi.MIGRATION_ARTIFACTS.preflightReport,
      value: report,
    });
  } catch {
    cliFail("PREFLIGHT_REPORT_WRITE_FAILED");
  }
};

const preflightClientForPlan = async ({
  env,
  artifactApi,
  createClient,
  readConfig,
  plan,
  run,
}) => {
  let client;
  let report;
  try {
    client = clientFor({ env, createClient, readConfig });
    report = await runMigrationPreflight({
      client,
      plan,
      destinations: MIGRATION_DESTINATIONS,
    });
  } catch {
    report = incompletePreflightReport({
      plan,
      destinations: MIGRATION_DESTINATIONS,
    });
  }

  await persistPreflightReport({ artifactApi, run, report });
  if (report.outcome !== "READY") cliFail("PREFLIGHT_BLOCKED", report);
  return { client, report };
};

const assertApprovedDestination = (destination) => {
  if (!Object.hasOwn(MIGRATION_DESTINATIONS, destination.projectKey)) {
    cliFail("PLAN_DESTINATION_UNAPPROVED");
  }
  const approved = MIGRATION_DESTINATIONS[destination.projectKey];
  const expectedStateId = destination.stateKind === "backlog"
    ? approved.backlogStateId
    : destination.stateKind === "done"
      ? approved.doneStateId
      : null;
  if (
    expectedStateId === null
    || destination.workspace !== approved.workspace
    || destination.projectId !== approved.projectId
    || destination.stateId !== expectedStateId
  ) {
    cliFail("PLAN_DESTINATION_UNAPPROVED");
  }
};

const assertApprovedPlanDestinations = (plan) => {
  const createItemsByTaskUuid = new Map();
  for (const item of plan.items) {
    if (item.disposition !== "create") continue;
    assertApprovedDestination(item.destination);
    if (item.workItem.stateId !== item.destination.stateId) {
      cliFail("PLAN_DESTINATION_UNAPPROVED");
    }
    createItemsByTaskUuid.set(item.taskUuid, item);
  }

  for (const relation of plan.eligibleRelations) {
    const source = createItemsByTaskUuid.get(relation.sourceTaskUuid);
    const target = createItemsByTaskUuid.get(relation.targetTaskUuid);
    if (
      !source
      || !target
      || relation.relationType !== "blocked_by"
      || relation.workspace !== source.destination.workspace
      || relation.workspace !== target.destination.workspace
      || relation.projectId !== source.destination.projectId
      || relation.projectId !== target.destination.projectId
    ) {
      cliFail("PLAN_DESTINATION_UNAPPROVED");
    }
  }
};

const loadPlan = async ({ artifactApi, run }) => {
  const plan = await artifactApi.readRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.plan,
  });
  buildDryRunReport(plan);
  assertApprovedPlanDestinations(plan);
  return plan;
};

const prepareMigration = async ({
  cwd,
  env,
  clock,
  execFile,
  readWorksheet,
  artifactApi,
}) => {
  const [tasks, worksheet] = await Promise.all([
    runTaskwarriorExport({ execFile, env }),
    readWorksheet({ cwd, relativePath: WORKSHEET_PATH }),
  ]);
  const plan = buildMigrationPlan({
    worksheet,
    tasks,
    destinations: MIGRATION_DESTINATIONS,
  });
  const run = await artifactApi.createMigrationRun({ cwd, timestamp: timestampFrom(clock) });
  await artifactApi.writeRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.source,
    value: sourceSnapshot({ worksheet, tasks }),
  });
  await artifactApi.writeRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.plan,
    value: plan,
  });

  return {
    relativeRunPath: run.relativeRunPath,
    planSha256: plan.planSha256,
    summary: plan.summary,
  };
};

const dryRunMigration = async ({ cwd, relativeRunPath, artifactApi }) => {
  const run = await artifactApi.loadMigrationRun({ cwd, relativeRunPath });
  const plan = await loadPlan({ artifactApi, run });
  const report = buildDryRunReport(plan);
  await artifactApi.replaceRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.dryRunReport,
    value: report,
  });

  return { relativeRunPath: run.relativeRunPath, planSha256: plan.planSha256, summary: report.summary };
};

const resolvePlaneItem = async ({ client, item, checkpoint }) => {
  const workItems = await client.listProjectWorkItems({
    workspace: item.destination.workspace,
    projectId: item.destination.projectId,
    externalId: item.workItem.externalId,
    externalSource: item.workItem.externalSource,
  });
  const existing = oneIdentityMatch({ workItems, item });
  const checkpointId = checkpoint.planeItemIdsByTaskUuid[item.taskUuid];

  if (checkpointId && (!existing || existing.id !== checkpointId)) cliFail("CHECKPOINT_MISMATCH");
  if (existing) return { planeItemId: existing.id, outcome: "reused" };
  if (checkpointId) cliFail("CHECKPOINT_MISSING");

  const created = await client.createProjectWorkItem({
    workspace: item.destination.workspace,
    projectId: item.destination.projectId,
    input: item.workItem,
  });
  return { planeItemId: created.id, outcome: "created" };
};

const applyItems = async ({ client, plan, checkpoint, artifactApi, run }) => {
  let currentCheckpoint = checkpoint;
  for (const item of plan.items.filter((entry) => entry.disposition === "create")) {
    let resolved;
    try {
      resolved = await resolvePlaneItem({ client, item, checkpoint: currentCheckpoint });
    } catch (error) {
      if (error instanceof MigrationCliError || isMigrationPreflightError(error)) throw error;
      cliFail(`ITEM_CREATE_${planeErrorCode(error)}`);
    }
    currentCheckpoint = checkpointWithItem({
      checkpoint: currentCheckpoint,
      taskUuid: item.taskUuid,
      planeItemId: resolved.planeItemId,
      outcome: resolved.outcome,
    });
    await artifactApi.writeCheckpoint({ run, value: currentCheckpoint });
  }
  return currentCheckpoint;
};

const applyRelations = async ({ client, plan, checkpoint, artifactApi, run }) => {
  let currentCheckpoint = checkpoint;
  for (const relation of plan.eligibleRelations) {
    const sourcePlaneItemId = currentCheckpoint.planeItemIdsByTaskUuid[relation.sourceTaskUuid];
    const targetPlaneItemId = currentCheckpoint.planeItemIdsByTaskUuid[relation.targetTaskUuid];
    if (!sourcePlaneItemId || !targetPlaneItemId) {
      currentCheckpoint = checkpointWithRelation({
        checkpoint: currentCheckpoint,
        relation,
        outcome: "unresolved",
        reason: "MISSING_PLANE_ENDPOINT",
      });
      await artifactApi.writeCheckpoint({ run, value: currentCheckpoint });
      continue;
    }

    try {
      const existing = await client.listWorkItemRelations({
        workspace: relation.workspace,
        projectId: relation.projectId,
        workItemId: sourcePlaneItemId,
      });
      const outcome = existing.blockedByIds.includes(targetPlaneItemId) ? "reused" : "created";
      if (outcome === "created") {
        await client.createWorkItemRelation({
          workspace: relation.workspace,
          projectId: relation.projectId,
          workItemId: sourcePlaneItemId,
          relation: { relationType: relation.relationType, issueIds: [targetPlaneItemId] },
        });
      }
      currentCheckpoint = checkpointWithRelation({ checkpoint: currentCheckpoint, relation, outcome });
    } catch (error) {
      currentCheckpoint = checkpointWithRelation({
        checkpoint: currentCheckpoint,
        relation,
        outcome: "unresolved",
        reason: planeErrorCode(error),
      });
    }
    await artifactApi.writeCheckpoint({ run, value: currentCheckpoint });
  }
  return currentCheckpoint;
};

const preflightMigration = async ({
  cwd,
  relativeRunPath,
  env,
  artifactApi,
  createClient,
  readConfig,
}) => {
  const run = await artifactApi.loadMigrationRun({ cwd, relativeRunPath });
  const plan = await loadPlan({ artifactApi, run });

  return artifactApi.withMigrationLock({
    run,
    operation: async () => {
      const { report } = await preflightClientForPlan({
        env,
        artifactApi,
        createClient,
        readConfig,
        plan,
        run,
      });
      return {
        relativeRunPath: run.relativeRunPath,
        planSha256: plan.planSha256,
        preflight: report,
      };
    },
  });
};

const applyMigration = async ({
  cwd,
  relativeRunPath,
  planSha256,
  env,
  artifactApi,
  createClient,
  readConfig,
}) => {
  const run = await artifactApi.loadMigrationRun({ cwd, relativeRunPath });
  const plan = await loadPlan({ artifactApi, run });
  if (plan.planSha256 !== planSha256) cliFail("PLAN_HASH_MISMATCH");

  const checkpoint = await artifactApi.withMigrationLock({
    run,
    operation: async () => {
      const { client } = await preflightClientForPlan({
        env,
        artifactApi,
        createClient,
        readConfig,
        plan,
        run,
      });
      const currentCheckpoint = normalizeCheckpoint(await artifactApi.readCheckpoint({ run }), plan);
      const itemCheckpoint = await applyItems({
        client,
        plan,
        checkpoint: currentCheckpoint,
        artifactApi,
        run,
      });
      return applyRelations({ client, plan, checkpoint: itemCheckpoint, artifactApi, run });
    },
  });

  const outcomes = Object.values(checkpoint.itemOutcomesByTaskUuid);
  const relationOutcomes = Object.values(checkpoint.relationOutcomesByKey);
  return {
    relativeRunPath: run.relativeRunPath,
    planSha256: plan.planSha256,
    createdItems: outcomes.filter((outcome) => outcome === "created").length,
    reusedItems: outcomes.filter((outcome) => outcome === "reused").length,
    createdRelations: relationOutcomes.filter((outcome) => outcome === "created").length,
    reusedRelations: relationOutcomes.filter((outcome) => outcome === "reused").length,
    unresolvedRelations: relationOutcomes.filter((outcome) => outcome === "unresolved").length,
    skippedRelations: plan.skippedRelations.length,
  };
};

const reconciledItems = async ({ client, plan }) => {
  const observedItemsByTaskUuid = {};
  const planeItemIdsByTaskUuid = {};
  for (const item of plan.items.filter((entry) => entry.disposition === "create")) {
    const workItems = await client.listProjectWorkItems({
      workspace: item.destination.workspace,
      projectId: item.destination.projectId,
      externalId: item.workItem.externalId,
      externalSource: item.workItem.externalSource,
    });
    const match = oneIdentityMatch({ workItems, item });
    if (!match) continue;
    observedItemsByTaskUuid[item.taskUuid] = match;
    planeItemIdsByTaskUuid[item.taskUuid] = match.id;
  }
  return { observedItemsByTaskUuid, planeItemIdsByTaskUuid };
};

const reconciledRelations = async ({ client, plan, planeItemIdsByTaskUuid }) => {
  const observedRelationsByTaskUuid = {};
  for (const relation of plan.eligibleRelations) {
    const sourcePlaneItemId = planeItemIdsByTaskUuid[relation.sourceTaskUuid];
    if (!sourcePlaneItemId || Object.hasOwn(observedRelationsByTaskUuid, relation.sourceTaskUuid)) continue;
    observedRelationsByTaskUuid[relation.sourceTaskUuid] = await client.listWorkItemRelations({
      workspace: relation.workspace,
      projectId: relation.projectId,
      workItemId: sourcePlaneItemId,
    });
  }
  return observedRelationsByTaskUuid;
};

const reconcileMigration = async ({
  cwd,
  relativeRunPath,
  env,
  artifactApi,
  createClient,
  readConfig,
}) => {
  const run = await artifactApi.loadMigrationRun({ cwd, relativeRunPath });
  const plan = await loadPlan({ artifactApi, run });
  const client = clientFor({ env, createClient, readConfig });
  const { observedItemsByTaskUuid, planeItemIdsByTaskUuid } = await reconciledItems({ client, plan });
  const observedRelationsByTaskUuid = await reconciledRelations({
    client,
    plan,
    planeItemIdsByTaskUuid,
  });
  const checkpoint = normalizeCheckpoint(await artifactApi.readCheckpoint({ run }), plan);
  const report = buildReconciliationReport({
    plan,
    itemReconciliation: reconcilePlannedItems({ plan, observedItemsByTaskUuid }),
    relationReconciliation: reconcilePlannedRelations({
      plan,
      planeItemIdsByTaskUuid,
      observedRelationsByTaskUuid,
    }),
    unresolvedRelationAttempts: checkpoint.unresolvedRelationAttempts,
  });
  await artifactApi.replaceRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.reconciliationReport,
    value: report,
  });

  return { relativeRunPath: run.relativeRunPath, planSha256: plan.planSha256, summary: report.summary };
};

const publicError = (error) => {
  if (error instanceof MigrationCliError || isMigrationPreflightError(error)) {
    return {
      code: error.code,
      message: "Plane migration could not be completed safely.",
      ...(error instanceof MigrationCliError
        && error.code === "PREFLIGHT_BLOCKED"
        && isRecord(error.details)
        ? { details: error.details }
        : {}),
    };
  }
  return { code: "MIGRATION_ERROR", message: "Plane migration could not be completed safely." };
};

export const runPlaneTaskwarriorMigration = async ({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  clock = () => new Date(),
  execFile = executeFile,
  createClient = createPlaneClient,
  readConfig = readPlaneConfig,
  artifactApi = artifacts,
  readWorksheet = artifactApi.readProjectTextFile,
} = {}) => {
  const command = parseCommand(argv);
  if (!command) {
    writeJson(stderr, usageError());
    return 2;
  }

  try {
    const data = command.command === "prepare"
      ? await prepareMigration({ cwd, env, clock, execFile, readWorksheet, artifactApi })
      : command.command === "dry-run"
        ? await dryRunMigration({ cwd, relativeRunPath: command.relativeRunPath, artifactApi })
        : command.command === "preflight"
          ? await preflightMigration({
            cwd,
            relativeRunPath: command.relativeRunPath,
            env,
            artifactApi,
            createClient,
            readConfig,
          })
          : command.command === "apply"
            ? await applyMigration({
              cwd,
              relativeRunPath: command.relativeRunPath,
              planSha256: command.planSha256,
              env,
              artifactApi,
              createClient,
              readConfig,
            })
            : await reconcileMigration({
              cwd,
              relativeRunPath: command.relativeRunPath,
              env,
              artifactApi,
              createClient,
              readConfig,
            });
    writeJson(stdout, { success: true, data });
    return 0;
  } catch (error) {
    writeJson(stderr, { success: false, error: publicError(error) });
    return 1;
  }
};

const isDirectExecution = (moduleUrl = import.meta.url, executablePath = process.argv[1]) =>
  typeof executablePath === "string" && pathToFileURL(resolve(executablePath)).href === moduleUrl;

if (isDirectExecution()) {
  process.exitCode = await runPlaneTaskwarriorMigration();
}
