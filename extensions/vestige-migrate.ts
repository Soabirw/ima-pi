import { basename, join, relative } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_BACKUP_FILE_BYTES,
  MAX_EXPORT_FILE_BYTES,
  createMigrationArtifactRun,
  hashReadableFile,
  hashReadableSqliteFile,
  migrationArtifactQueueKey,
  readMigrationReportArtifact,
  readVerifiedText,
  verifyRecoveryReceipt,
  withReservedExclusiveText,
  writeExclusiveText,
} from "../lib/vestige-migrate-artifacts.ts";
import { runVestigeBackup, runVestigeExport } from "../lib/vestige-cli.ts";
import { withVestigeMigrationLock } from "../lib/vestige-migrate-lock.ts";
import {
  MAX_MIGRATION_REPORT_BYTES,
  buildCleanupReport,
  buildMigrationReport,
  classifyVestigeExport,
  cleanupSources,
  parseMigrationReport,
  parseVestigeExport,
  serializeCleanupReport,
  serializeMigrationReport,
  vestigePurgeAcknowledged,
  type CleanupRetentionReason,
  type MigrationReport,
} from "../lib/vestige-migrate.ts";
import {
  blockedCheck,
  corpusPreflight,
  dryRunSummary,
  failedCheck,
  passedCheck,
  requiredMigrationMutations,
  skippedMutationCheck,
} from "../lib/vestige-migrate-dry-run.ts";
import {
  MAX_DRY_RUN_REPORT_BYTES,
  buildDryRunReport,
  serializeDryRunReport,
  type DryRunReport,
} from "../lib/vestige-migrate-dry-run-report.ts";
import {
  failedMigrationSourceOutcome,
  importMigrationSource,
  verifyMigrationSourceForCleanup,
} from "../lib/vestige-migrate-qdrant.ts";
import {
  corpusFailure,
  normalizeCorpusFailureContext,
  utf8ByteLength,
  type CorpusFailure,
  type CorpusFailureContext,
  type CorpusResult,
} from "../lib/qdrant-corpus.ts";
import { createInstitutionalSnapshot } from "../lib/qdrant-http-boundary.ts";
import {
  corpusStatusFromPrerequisites,
  createQdrantCorpusClient,
  type QdrantCorpusClient,
} from "../lib/qdrant-http.ts";
import { withConfiguredMcpSession, type McpSession, type McpToolCaller } from "./integrations.ts";

const MCP_TIMEOUT_MS = 300_000;
const MAX_TOOL_OUTPUT_BYTES = 10 * 1024;
const BACKUP_ARTIFACT_NAME = "vestige-backup.sqlite";
const EXPORT_ARTIFACT_NAME = "vestige-export.json";
const DRY_RUN_REPORT_ARTIFACT_NAME = "dry-run-report.json";
const migrateParameters = Type.Object({
  dryRun: Type.Optional(Type.Boolean({
    description: "Run itemized migration preparation checks and safe local backup/export without Qdrant or Vestige data mutation.",
  })),
  confirm: Type.Optional(Type.Boolean({
    description: "Must be true to run a live migration.",
  })),
}, { additionalProperties: false });
const cleanupParameters = Type.Object({
  reportPath: Type.String({ minLength: 1, maxLength: 1_024 }),
  confirm: Type.Boolean({ description: "Must be true after explicit operator confirmation." }),
}, { additionalProperties: false });

export type VestigeMigrateDependencies = {
  client?: QdrantCorpusClient;
  createSnapshot?: (signal?: AbortSignal) => Promise<CorpusResult<{ name: string }>>;
  mcpSession?: McpSession;
  now?: () => Date;
  runVestigeBackup?: typeof runVestigeBackup;
  runVestigeExport?: typeof runVestigeExport;
  migrationLockPath?: string;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const failureContext = (context?: CorpusFailureContext) => {
  const normalized = normalizeCorpusFailureContext(context);
  return normalized
    ? `; operation=${normalized.operation}; cause=${normalized.cause}${
      normalized.httpStatus === undefined ? "" : `; status=${normalized.httpStatus}`
    }`
    : "";
};

const fail = (code: string, context?: CorpusFailureContext): never => {
  throw new Error(`Vestige migration failed: ${code}${failureContext(context)}.`);
};

const failCorpus = (error: CorpusFailure["error"]): never => fail(error.code, error.context);
const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

type AttemptResult<Data> = { success: true; data: Data } | { success: false };
type MigrationOperation = "dry_run" | "migration";

const parseMigrationOperation = (request: unknown): MigrationOperation => {
  const input = object(request);
  if (!input) return fail("migration_request_invalid");

  const keys = Object.keys(input);
  if (keys.some((key) => key !== "dryRun" && key !== "confirm")) {
    return fail("migration_request_invalid");
  }
  if (input.dryRun === true && input.confirm === undefined && keys.length === 1) {
    return "dry_run";
  }
  if (input.confirm === true && input.dryRun === undefined && keys.length === 1) {
    return "migration";
  }
  if (
    keys.length === 0
    || (keys.length === 1 && (input.dryRun === false || input.confirm === false))
  ) return fail("migration_confirmation_required");

  return fail("migration_request_invalid");
};

const mcpData = (value: unknown): Record<string, unknown> | null => {
  const response = object(value);
  if (!response || response.isError === true) return null;
  const structured = object(response.structuredContent);
  if (structured) return structured;
  if (Array.isArray(response.content)) {
    for (const content of response.content) {
      const item = object(content);
      if (typeof item?.text !== "string") continue;
      try {
        const parsed = object(JSON.parse(item.text));
        if (parsed) return parsed;
      } catch {
        continue;
      }
    }
  }
  return response;
};

const callMcpData = async (
  call: McpToolCaller,
  name: string,
  arguments_: Record<string, unknown>,
  signal?: AbortSignal,
) => {
  throwIfAborted(signal);
  let response: unknown;
  try {
    response = await call(name, arguments_, MCP_TIMEOUT_MS);
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return fail("vestige_unavailable");
  }
  return mcpData(response) ?? fail("vestige_response_invalid");
};

const timestamp = (date: Date) => {
  try {
    return date.toISOString().replace(/[.:]/g, "-");
  } catch {
    return fail("clock_invalid");
  }
};

const dependenciesFor = (supplied: VestigeMigrateDependencies = {}) => ({
  client: supplied.client ?? createQdrantCorpusClient(),
  createSnapshot: supplied.createSnapshot ?? ((signal?: AbortSignal) => createInstitutionalSnapshot({}, signal)),
  mcpSession: supplied.mcpSession ?? withConfiguredMcpSession,
  now: supplied.now ?? (() => new Date()),
  runVestigeBackup: supplied.runVestigeBackup ?? runVestigeBackup,
  runVestigeExport: supplied.runVestigeExport ?? runVestigeExport,
});

const migrationArtifactRun = (
  cwd: string,
  dependencies: ReturnType<typeof dependenciesFor>,
  signal?: AbortSignal,
) => createMigrationArtifactRun(cwd, timestamp(dependencies.now()), signal);

const classifiedExport = async (exportPath: string, signal?: AbortSignal) => {
  const exportText = await readVerifiedText(exportPath, MAX_EXPORT_FILE_BYTES, signal);
  const parsed = parseVestigeExport(exportText);
  return parsed ? classifyVestigeExport(parsed.records) : null;
};

const safeQdrant = async <Data>(
  operation: () => Promise<CorpusResult<Data>>,
  diagnosticOperation: CorpusFailureContext["operation"],
  signal?: AbortSignal,
): Promise<CorpusResult<Data>> => {
  try {
    throwIfAborted(signal);
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    return corpusFailure("qdrant_unavailable", {
      operation: diagnosticOperation,
      cause: "client_exception",
    });
  }
};

const attemptArtifact = async <Data>(
  operation: () => Promise<Data>,
  signal?: AbortSignal,
): Promise<AttemptResult<Data>> => {
  try {
    throwIfAborted(signal);
    const data = await operation();
    throwIfAborted(signal);
    return { success: true, data };
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    return { success: false };
  }
};

const safeArtifact = async <Data>(operation: () => Promise<Data>, signal?: AbortSignal) => {
  const result = await attemptArtifact(operation, signal);
  return result.success ? result.data : fail("artifact_unavailable");
};

const createVestigeArtifact = async (input: {
  operation: () => Promise<void>;
  outputPath: string;
  relativePath: string;
  maximumBytes: number;
  hashFile: typeof hashReadableFile;
  signal?: AbortSignal;
}) => {
  throwIfAborted(input.signal);
  await input.operation();
  throwIfAborted(input.signal);
  const receipt = await input.hashFile(input.outputPath, input.maximumBytes, input.signal);
  throwIfAborted(input.signal);
  return { relativePath: input.relativePath, ...receipt };
};

const runVestigeArtifact = async (input: {
  operation: () => Promise<void>;
  outputPath: string;
  relativePath: string;
  maximumBytes: number;
  unavailableCode: "backup_unavailable" | "export_unavailable";
  hashFile: typeof hashReadableFile;
  signal?: AbortSignal;
}) => {
  const result = await attemptArtifact(() => createVestigeArtifact(input), input.signal);
  return result.success ? result.data : fail(input.unavailableCode);
};

const reportResult = (artifactPath: string, report: MigrationReport) => {
  const result = { artifactPath, summary: report.summary };
  const output = JSON.stringify(result);
  if (utf8ByteLength(output) > MAX_TOOL_OUTPUT_BYTES) fail("tool_output_too_large");
  return { content: [{ type: "text" as const, text: output }], details: result };
};

const writeMigrationReport = async (
  directory: string,
  report: MigrationReport,
  signal?: AbortSignal,
) => {
  const serialized = serializeMigrationReport(report);
  if (!serialized.success) fail(serialized.error);
  return safeArtifact(
    () => writeExclusiveText({
      directory,
      name: "report.json",
      content: serialized.data,
      maximumBytes: MAX_MIGRATION_REPORT_BYTES,
      signal,
    }),
    signal,
  );
};

const writeDryRunReport = async (
  directory: string,
  report: DryRunReport,
  signal?: AbortSignal,
) => {
  const serialized = serializeDryRunReport(report);
  if (!serialized.success) fail(serialized.error);
  return safeArtifact(
    () => writeExclusiveText({
      directory,
      name: DRY_RUN_REPORT_ARTIFACT_NAME,
      content: serialized.data,
      maximumBytes: MAX_DRY_RUN_REPORT_BYTES,
      signal,
    }),
    signal,
  );
};

const dryRunResult = (artifactPath: string, report: DryRunReport) => {
  const result = {
    artifactPath,
    outcome: report.outcome,
    checks: report.checks,
    summary: report.summary,
    corpus: report.corpus,
    requiredMigrationMutations: report.requiredMigrationMutations,
    notVerified: report.notVerified,
  };
  const output = JSON.stringify(result);
  if (utf8ByteLength(output) > MAX_TOOL_OUTPUT_BYTES) fail("tool_output_too_large");
  return { content: [{ type: "text" as const, text: output }], details: result };
};

const migrationRecovery = (
  backup: MigrationReport["recovery"]["backup"],
  exported: MigrationReport["recovery"]["export"],
  snapshot: MigrationReport["recovery"]["snapshot"],
) => ({ backup, export: exported, snapshot });

export async function migrateVestige(
  cwd: string,
  supplied: VestigeMigrateDependencies = {},
  signal?: AbortSignal,
) {
  const dependencies = dependenciesFor(supplied);
  const prerequisites = await safeQdrant(
    () => dependencies.client.preflight(signal),
    "qdrant_version",
    signal,
  );
  if (!prerequisites.success) failCorpus(prerequisites.error);
  const status = corpusStatusFromPrerequisites(prerequisites.data);
  if (!status.success) failCorpus(status.error);

  const run = await safeArtifact(
    () => migrationArtifactRun(cwd, dependencies, signal),
    signal,
  );
  const backupPath = join(run.directory, BACKUP_ARTIFACT_NAME);
  const exportPath = join(run.directory, EXPORT_ARTIFACT_NAME);
  const backup = await runVestigeArtifact({
    operation: () => dependencies.runVestigeBackup({ outputPath: backupPath, signal }),
    outputPath: backupPath,
    relativePath: BACKUP_ARTIFACT_NAME,
    maximumBytes: MAX_BACKUP_FILE_BYTES,
    unavailableCode: "backup_unavailable",
    hashFile: hashReadableSqliteFile,
    signal,
  });
  const exported = await runVestigeArtifact({
    operation: () => dependencies.runVestigeExport({ outputPath: exportPath, signal }),
    outputPath: exportPath,
    relativePath: EXPORT_ARTIFACT_NAME,
    maximumBytes: MAX_EXPORT_FILE_BYTES,
    unavailableCode: "export_unavailable",
    hashFile: hashReadableFile,
    signal,
  });

  const classification = await safeArtifact(
    () => classifiedExport(exportPath, signal),
    signal,
  );
  if (!classification) fail("export_invalid");

  let recovery = migrationRecovery(backup, exported, { status: "not_applicable" });
  if (classification.institutional.length === 0) {
    const report = buildMigrationReport({ classification, outcomes: [], recovery });
    if (!report) fail("report_invalid");
    const output = await writeMigrationReport(run.directory, report, signal);
    return { artifactPath: relative(run.projectRoot, output), report };
  }
  if (status.data.collection !== "absent") {
    const created = await safeQdrant(
      () => dependencies.createSnapshot(signal),
      "institutional_collection",
      signal,
    );
    if (!created.success) failCorpus(created.error);
    recovery = migrationRecovery(backup, exported, { status: "created", name: created.data.name });
  }

  const ensured = await safeQdrant(
    () => dependencies.client.ensureCollection(signal),
    "institutional_collection",
    signal,
  );
  if (!ensured.success) failCorpus(ensured.error);

  const outcomes: MigrationReport["outcomes"] = [];
  let destinationWritesMayHaveStarted = false;
  try {
    for (const source of classification.institutional) {
      throwIfAborted(signal);
      destinationWritesMayHaveStarted = true;
      outcomes.push(await importMigrationSource({ source, client: dependencies.client, signal }));
    }
  } catch (error) {
    if (!destinationWritesMayHaveStarted) throw error;

    const interruptedOutcomes = [
      ...outcomes,
      ...classification.institutional
        .slice(outcomes.length)
        .map((source) => failedMigrationSourceOutcome(source)),
    ];
    const interruptedReport = buildMigrationReport({
      classification,
      outcomes: interruptedOutcomes,
      recovery,
    });
    if (interruptedReport) {
      try {
        await writeMigrationReport(run.directory, interruptedReport);
      } catch {
        // Recovery evidence must not replace the original migration failure.
      }
    }
    throw error;
  }

  const report = buildMigrationReport({ classification, outcomes, recovery });
  if (!report) fail("report_invalid");
  // Preserve recovery evidence before rethrowing any cancellation.
  const output = await writeMigrationReport(run.directory, report);
  throwIfAborted(signal);
  return { artifactPath: relative(run.projectRoot, output), report };
}

export async function dryRunVestige(
  cwd: string,
  supplied: VestigeMigrateDependencies = {},
  signal?: AbortSignal,
) {
  const dependencies = dependenciesFor(supplied);
  const prerequisites = await safeQdrant(
    () => dependencies.client.preflight(signal),
    "qdrant_version",
    signal,
  );
  if (!prerequisites.success) failCorpus(prerequisites.error);

  const { checks: corpusChecks, corpus } = corpusPreflight(prerequisites.data);
  const runResult = await attemptArtifact(
    () => migrationArtifactRun(cwd, dependencies, signal),
    signal,
  );
  if (!runResult.success) fail("artifact_unavailable");

  const run = runResult.data;
  const backupPath = join(run.directory, BACKUP_ARTIFACT_NAME);
  const exportPath = join(run.directory, EXPORT_ARTIFACT_NAME);
  const backup = await attemptArtifact(() => createVestigeArtifact({
    operation: () => dependencies.runVestigeBackup({ outputPath: backupPath, signal }),
    outputPath: backupPath,
    relativePath: BACKUP_ARTIFACT_NAME,
    maximumBytes: MAX_BACKUP_FILE_BYTES,
    hashFile: hashReadableSqliteFile,
    signal,
  }), signal);
  const exported = await attemptArtifact(() => createVestigeArtifact({
    operation: () => dependencies.runVestigeExport({ outputPath: exportPath, signal }),
    outputPath: exportPath,
    relativePath: EXPORT_ARTIFACT_NAME,
    maximumBytes: MAX_EXPORT_FILE_BYTES,
    hashFile: hashReadableFile,
    signal,
  }), signal);
  const classified = exported.success
    ? await attemptArtifact(() => classifiedExport(exportPath, signal), signal)
    : null;
  const classification = classified?.success === true ? classified.data : null;
  const validExport = classification !== null;
  const checks = [
    ...corpusChecks,
    passedCheck("artifact_run_directory"),
    backup.success ? passedCheck("vestige_sqlite_backup") : failedCheck("vestige_sqlite_backup"),
    exported.success ? passedCheck("vestige_json_export") : failedCheck("vestige_json_export"),
    !exported.success
      ? blockedCheck("export_validation", "vestige_json_export")
      : validExport
        ? passedCheck("export_validation")
        : failedCheck("export_validation"),
    validExport
      ? passedCheck("classification_and_redaction")
      : blockedCheck("classification_and_redaction", "export_validation"),
    skippedMutationCheck(),
  ];
  const report = buildDryRunReport({
    checks,
    summary: classification ? dryRunSummary(classification) : null,
    corpus,
    recovery: {
      ...(backup.success ? { backup: backup.data } : {}),
      ...(exported.success ? { export: exported.data } : {}),
    },
    requiredMigrationMutations: requiredMigrationMutations(
      corpus.collection,
      classification?.institutional.length ?? 0,
    ),
  });
  if (!report) fail("dry_run_report_invalid");
  const output = await writeDryRunReport(run.directory, report, signal);
  return { artifactPath: relative(run.projectRoot, output), report };
}

const cleanupReportContent = (report: Parameters<typeof buildCleanupReport>[0]) => {
  const built = buildCleanupReport(report);
  if (!built) fail("cleanup_report_invalid");
  const serialized = serializeCleanupReport(built);
  if (!serialized.success) fail(serialized.error);
  return serialized.data;
};

export async function cleanupVestige(
  cwd: string,
  input: { reportPath: string; confirm: boolean },
  supplied: VestigeMigrateDependencies = {},
  signal?: AbortSignal,
) {
  if (input.confirm !== true) fail("cleanup_confirmation_required");
  const dependencies = dependenciesFor(supplied);
  const source = await safeArtifact(
    () => readMigrationReportArtifact(cwd, input.reportPath, MAX_MIGRATION_REPORT_BYTES, signal),
    signal,
  );
  let report: MigrationReport | null = null;
  try {
    report = parseMigrationReport(JSON.parse(source.content));
  } catch {
    report = null;
  }
  if (!report) fail("cleanup_report_invalid");

  const backupVerified = await safeArtifact(
    () => verifyRecoveryReceipt({
      reportDirectory: source.reportDirectory,
      receipt: report.recovery.backup,
      maximumBytes: MAX_BACKUP_FILE_BYTES,
      hashFile: hashReadableSqliteFile,
      signal,
    }),
    signal,
  );
  const exportVerified = await safeArtifact(
    () => verifyRecoveryReceipt({
      reportDirectory: source.reportDirectory,
      receipt: report.recovery.export,
      maximumBytes: MAX_EXPORT_FILE_BYTES,
      signal,
    }),
    signal,
  );
  if (!backupVerified || !exportVerified) fail("cleanup_recovery_invalid");

  const candidates = cleanupSources(report);
  const name = `cleanup-${timestamp(dependencies.now())}.json`;
  return safeArtifact(
    () => withReservedExclusiveText({
      directory: source.reportDirectory,
      name,
      maximumBytes: MAX_MIGRATION_REPORT_BYTES,
      signal,
      operation: async ({ markDeletionStarted, write }) => {
        const purgedIds: string[] = [];
        const retained: Array<{ vestigeId: string; reason: CleanupRetentionReason }> = [];
        const pending = new Set(candidates.map((candidate) => candidate.vestigeId));
        try {
          const session = await dependencies.mcpSession("vestige", async (call) => {
            for (const candidate of candidates) {
              throwIfAborted(signal);
              const verification = await verifyMigrationSourceForCleanup({
                source: candidate,
                client: dependencies.client,
                signal,
              });
              if (verification) {
                retained.push({ vestigeId: candidate.vestigeId, reason: verification });
                pending.delete(candidate.vestigeId);
                continue;
              }
              try {
                markDeletionStarted();
                const deletion = await callMcpData(call, "memory", {
                  action: "purge",
                  id: candidate.vestigeId,
                  confirm: true,
                  reason: "Verified Tier-1 migration cleanup.",
                }, signal);
                throwIfAborted(signal);
                if (vestigePurgeAcknowledged(deletion, candidate.vestigeId)) purgedIds.push(candidate.vestigeId);
                else retained.push({ vestigeId: candidate.vestigeId, reason: "vestige_negative_ack" });
              } catch (error) {
                if (signal?.aborted) throw error;
                retained.push({ vestigeId: candidate.vestigeId, reason: "vestige_unavailable" });
              }
              pending.delete(candidate.vestigeId);
            }
          }, signal);
          throwIfAborted(signal);
          if (session === null) fail("vestige_unavailable");
        } catch (error) {
          if (signal?.aborted) throw error;
          for (const vestigeId of pending) retained.push({ vestigeId, reason: "vestige_unavailable" });
        }

        throwIfAborted(signal);
        const content = cleanupReportContent({
          sourceReport: basename(source.reportPath),
          purgedIds,
          retained,
        });
        const output = await write(content);
        const result = { reportPath: relative(source.projectRoot, output), purged: purgedIds.length, retained: retained.length };
        if (utf8ByteLength(JSON.stringify(result)) > MAX_TOOL_OUTPUT_BYTES) fail("tool_output_too_large");
        return result;
      },
    }),
    signal,
  );
}

const queuedMutation = async <Data>(cwd: string, callback: () => Promise<Data>, signal?: AbortSignal) => {
  const target = await migrationArtifactQueueKey(cwd, signal);
  return withFileMutationQueue(target, callback);
};

const lockedMutation = async <Data>(input: {
  cwd: string;
  callback: () => Promise<Data>;
  lockPath?: string;
  signal?: AbortSignal;
}) => withVestigeMigrationLock(
  () => queuedMutation(input.cwd, input.callback, input.signal),
  { lockPath: input.lockPath, signal: input.signal },
);

export function registerVestigeMigrateTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  supplied: VestigeMigrateDependencies = {},
) {
  pi.registerTool({
    name: "ima_vestige_migrate",
    label: "Migrate Vestige lifecycle memories",
    description: "Run an itemized dry-run checklist or migrate Vestige institutional memories into the institutional corpus. It never deletes Vestige memories.",
    parameters: migrateParameters,
    async execute(_id, request, signal, _update, ctx) {
      const operation = parseMigrationOperation(request);
      if (operation === "dry_run") {
        const result = await lockedMutation({
          cwd: ctx.cwd,
          callback: () => dryRunVestige(ctx.cwd, supplied, signal),
          lockPath: supplied.migrationLockPath,
          signal,
        });
        return dryRunResult(result.artifactPath, result.report);
      }
      const result = await lockedMutation({
        cwd: ctx.cwd,
        callback: () => migrateVestige(ctx.cwd, supplied, signal),
        lockPath: supplied.migrationLockPath,
        signal,
      });
      return reportResult(result.artifactPath, result.report);
    },
  });
  pi.registerTool({
    name: "ima_vestige_cleanup",
    label: "Clean up verified Vestige institutional memories",
    description: "Explicitly delete only report-listed Vestige institutional memories after recovery and every-record Tier-1 verification. Requires confirm: true and never deletes preferences.",
    parameters: cleanupParameters,
    async execute(_id, request, signal, _update, ctx) {
      const result = await lockedMutation({
        cwd: ctx.cwd,
        callback: () => cleanupVestige(ctx.cwd, request, supplied, signal),
        lockPath: supplied.migrationLockPath,
        signal,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}

export default function vestigeMigrate(pi: ExtensionAPI) {
  registerVestigeMigrateTools(pi);
}
