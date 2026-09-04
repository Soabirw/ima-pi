import * as artifacts from "./plane-taskwarrior-migration-artifacts.ts";
import { MigrationExecutionError } from "./plane-taskwarrior-migration-execution.ts";
import {
  applyPreparedMigration,
  inspectPreparedMigration,
  isPreparedMigrationError,
  readPreparedMigrationStatus,
  reconcilePreparedMigration,
} from "./plane-taskwarrior-prepared-run.ts";
import {
  createPlaneClient,
  readPlaneConfig,
  toPublicPlaneError,
} from "../skills/plane-api/scripts/plane-client.mjs";

const preparedOperationErrorCode = (error) => {
  if (error instanceof MigrationExecutionError || isPreparedMigrationError(error)) {
    return error.code;
  }
  return toPublicPlaneError(error).code;
};

const preparedRunInput = ({ cwd, relativeRunPath, artifactApi = artifacts }) => ({
  cwd,
  relativeRunPath,
  artifactApi,
});

const preparedOperationInput = ({
  cwd,
  relativeRunPath,
  env = process.env,
  artifactApi = artifacts,
  createClient = createPlaneClient,
  readConfig = readPlaneConfig,
  onProgress,
}) => ({
  cwd,
  relativeRunPath,
  env,
  artifactApi,
  createClient,
  readConfig,
  onProgress,
});

export const inspectPreparedMigrationRun = (input) =>
  inspectPreparedMigration(preparedRunInput(input));

export const readPreparedMigrationRunStatus = (input) =>
  readPreparedMigrationStatus(preparedRunInput(input));

export const applyPreparedMigrationRun = ({ reviewedPlanSha256, ...input }) =>
  applyPreparedMigration({
    ...preparedOperationInput(input),
    reviewedPlanSha256,
    toErrorCode: preparedOperationErrorCode,
  });

export const reconcilePreparedMigrationRun = (input) =>
  reconcilePreparedMigration(preparedOperationInput(input));
