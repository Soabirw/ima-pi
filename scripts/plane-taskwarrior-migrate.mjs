#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as artifacts from "../lib/plane-taskwarrior-migration-artifacts.ts";
import {
  MigrationExecutionError, applyMigrationPlan, migrationCheckpointSummary,
  normalizeMigrationCheckpoint, observeMigrationPlan,
} from "../lib/plane-taskwarrior-migration-execution.ts";
import {
  incompletePreflightReport, isMigrationPreflightError, runMigrationPreflight,
} from "../lib/plane-taskwarrior-migration-preflight.ts";
import {
  buildDryRunReport, buildMigrationPlan, buildReconciliationReport,
  reconcilePlannedItems, reconcilePlannedRelations,
} from "../lib/plane-taskwarrior-migration.ts";
import {
  createPlaneClient, readPlaneConfig, toPublicPlaneError,
} from "../skills/plane-api/scripts/plane-client.mjs";

const executeFile = promisify(execFileCallback);
const TASK_EXPORT_MAX_BUFFER = 32 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const WORKSHEET_PATH = "docs/plane-taskwarrior-project-map.md";
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
  if (command === "dry-run" && arguments_.length === 1) return { command, relativeRunPath: arguments_[0] };
  if (command === "preflight" && arguments_.length === 1) return { command, relativeRunPath: arguments_[0] };
  if (
    command === "apply"
    && arguments_.length === 3
    && HASH_PATTERN.test(arguments_[1])
    && arguments_[2] === "confirm"
  ) {
    return { command, relativeRunPath: arguments_[0], planSha256: arguments_[1] };
  }
  if (command === "reconcile" && arguments_.length === 1) return { command, relativeRunPath: arguments_[0] };
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

const sourceSnapshot = ({ worksheet, tasks }) => ({ schemaVersion: 1, worksheet, tasks });

const assertLegacyRunSource = async ({ artifactApi, run }) => {
  const source = await artifactApi.readRunArtifact({
    run,
    name: artifactApi.MIGRATION_ARTIFACTS.source,
  });
  if (isRecord(source) && source.schemaVersion === 2) {
    cliFail("PREPARED_RUN_INTERACTIVE_ONLY");
  }
  if (
    !isRecord(source)
    || source.schemaVersion !== 1
    || typeof source.worksheet !== "string"
    || !Array.isArray(source.tasks)
  ) {
    cliFail("LEGACY_SOURCE_INVALID");
  }
};

const planeErrorCode = (error) => {
  if (
    error instanceof MigrationCliError
    || isMigrationPreflightError(error)
    || error instanceof MigrationExecutionError
  ) {
    return error.code;
  }
  return toPublicPlaneError(error).code;
};

const clientFor = ({ env, createClient, readConfig }) => createClient(readConfig(env));

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
    report = incompletePreflightReport({ plan, destinations: MIGRATION_DESTINATIONS });
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
    if (item.workItem.stateId !== item.destination.stateId) cliFail("PLAN_DESTINATION_UNAPPROVED");
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

const prepareMigration = async ({ cwd, env, clock, execFile, readWorksheet, artifactApi }) => {
  const [tasks, worksheet] = await Promise.all([
    runTaskwarriorExport({ execFile, env }),
    readWorksheet({ cwd, relativePath: WORKSHEET_PATH }),
  ]);
  const plan = buildMigrationPlan({ worksheet, tasks, destinations: MIGRATION_DESTINATIONS });
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
      return { relativeRunPath: run.relativeRunPath, planSha256: plan.planSha256, preflight: report };
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
  await assertLegacyRunSource({ artifactApi, run });
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
      const currentCheckpoint = normalizeMigrationCheckpoint(
        await artifactApi.readCheckpoint({ run }),
        plan,
      );
      return applyMigrationPlan({
        client,
        plan,
        checkpoint: currentCheckpoint,
        artifactApi,
        run,
        toErrorCode: planeErrorCode,
      });
    },
  });
  return {
    relativeRunPath: run.relativeRunPath,
    planSha256: plan.planSha256,
    ...migrationCheckpointSummary({ plan, checkpoint }),
  };
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
  await assertLegacyRunSource({ artifactApi, run });
  const plan = await loadPlan({ artifactApi, run });
  const client = clientFor({ env, createClient, readConfig });
  const observed = await observeMigrationPlan({ client, plan });
  const checkpoint = normalizeMigrationCheckpoint(await artifactApi.readCheckpoint({ run }), plan);
  const report = buildReconciliationReport({
    plan,
    itemReconciliation: reconcilePlannedItems({
      plan,
      observedItemsByTaskUuid: observed.observedItemsByTaskUuid,
    }),
    relationReconciliation: reconcilePlannedRelations({
      plan,
      planeItemIdsByTaskUuid: observed.planeItemIdsByTaskUuid,
      observedRelationsByTaskUuid: observed.observedRelationsByTaskUuid,
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

export {
  applyPreparedMigrationRun,
  inspectPreparedMigrationRun,
  readPreparedMigrationRunStatus,
  reconcilePreparedMigrationRun,
} from "../lib/plane-taskwarrior-prepared-run-operations.ts";

const publicError = (error) => {
  if (
    error instanceof MigrationCliError
    || isMigrationPreflightError(error)
    || error instanceof MigrationExecutionError
  ) {
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
