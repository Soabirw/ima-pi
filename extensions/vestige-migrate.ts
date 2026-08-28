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
  type CleanupRetentionReason,
  type MigrationReport,
} from "../lib/vestige-migrate.ts";
import {
  importMigrationSource,
  verifyMigrationSourceForCleanup,
} from "../lib/vestige-migrate-qdrant.ts";
import { utf8ByteLength, type CorpusResult } from "../lib/qdrant-corpus.ts";
import { createInstitutionalSnapshot } from "../lib/qdrant-http-boundary.ts";
import { createQdrantCorpusClient, type QdrantCorpusClient } from "../lib/qdrant-http.ts";
import { withConfiguredMcpSession, type McpSession, type McpToolCaller } from "./integrations.ts";

const MCP_TIMEOUT_MS = 300_000;
const MAX_TOOL_OUTPUT_BYTES = 10 * 1024;
const BACKUP_ARTIFACT_NAME = "vestige-backup.sqlite";
const EXPORT_ARTIFACT_NAME = "vestige-export.json";
const migrateParameters = Type.Object({}, { additionalProperties: false });
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

const fail = (code: string): never => { throw new Error(`Vestige migration failed: ${code}.`); };
const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

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

const safeQdrant = async <Data>(operation: () => Promise<CorpusResult<Data>>, signal?: AbortSignal) => {
  try {
    throwIfAborted(signal);
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    return fail("qdrant_unavailable");
  }
};

const safeArtifact = async <Data>(operation: () => Promise<Data>, signal?: AbortSignal) => {
  try {
    throwIfAborted(signal);
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    return fail("artifact_unavailable");
  }
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
  try {
    throwIfAborted(input.signal);
    await input.operation();
    throwIfAborted(input.signal);
    const receipt = await input.hashFile(input.outputPath, input.maximumBytes, input.signal);
    throwIfAborted(input.signal);
    return { relativePath: input.relativePath, ...receipt };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return fail(input.unavailableCode);
  }
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
  const status = await safeQdrant(() => dependencies.client.status(signal), signal);
  if (!status.success) fail(status.error.code);

  const run = await safeArtifact(() => createMigrationArtifactRun(cwd, timestamp(dependencies.now()), signal), signal);
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

  const exportText = await safeArtifact(
    () => readVerifiedText(exportPath, MAX_EXPORT_FILE_BYTES, signal),
    signal,
  );
  const parsed = parseVestigeExport(exportText);
  if (!parsed) fail("export_invalid");

  const classification = classifyVestigeExport(parsed.records);
  let recovery = migrationRecovery(backup, exported, { status: "not_applicable" });
  if (classification.institutional.length === 0) {
    const report = buildMigrationReport({ classification, outcomes: [], recovery });
    if (!report) fail("report_invalid");
    const output = await writeMigrationReport(run.directory, report, signal);
    return { artifactPath: relative(run.projectRoot, output), report };
  }
  if (status.data.collection !== "absent") {
    const created = await safeQdrant(() => dependencies.createSnapshot(signal), signal);
    if (!created.success) fail(created.error.code);
    recovery = migrationRecovery(backup, exported, { status: "created", name: created.data.name });
  }

  const ensured = await safeQdrant(() => dependencies.client.ensureCollection(signal), signal);
  if (!ensured.success) fail(ensured.error.code);

  const outcomes = [];
  for (const source of classification.institutional) {
    throwIfAborted(signal);
    outcomes.push(await importMigrationSource({ source, client: dependencies.client, signal }));
  }

  const report = buildMigrationReport({ classification, outcomes, recovery });
  if (!report) fail("report_invalid");
  const output = await writeMigrationReport(run.directory, report, signal);
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
                  action: "delete",
                  id: candidate.vestigeId,
                  confirm: true,
                  reason: "Verified Tier-1 migration cleanup.",
                }, signal);
                throwIfAborted(signal);
                if (deletion.deleted === true) purgedIds.push(candidate.vestigeId);
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
    description: "Back up, export, classify, redact, and idempotently migrate Vestige institutional memories to the institutional corpus. It never deletes Vestige memories.",
    parameters: migrateParameters,
    async execute(_id, _request, signal, _update, ctx) {
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
