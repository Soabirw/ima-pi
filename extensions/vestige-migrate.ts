import { basename, isAbsolute, join, relative } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_BACKUP_FILE_BYTES,
  MAX_EXPORT_FILE_BYTES,
  copyVerifiedArtifact,
  createMigrationArtifactRun,
  migrationArtifactQueueKey,
  readMigrationReportArtifact,
  readVerifiedText,
  verifyRecoveryReceipt,
  withReservedExclusiveText,
  writeExclusiveText,
} from "../lib/vestige-migrate-artifacts.ts";
import {
  MAX_MIGRATION_REPORT_BYTES,
  buildCleanupReport,
  buildMigrationReport,
  classifyVestigeExport,
  cleanupOutcomeIsVerified,
  cleanupOutcomes,
  importOutcome,
  institutionalExpectationMatches,
  lifecycleRecallContains,
  parseMigrationReport,
  parseVestigeExport,
  serializeCleanupReport,
  serializeMigrationReport,
  type CleanupRetentionReason,
  type ImportReason,
  type ImportOutcome,
  type MigrationCandidate,
  type MigrationReport,
} from "../lib/vestige-migrate.ts";
import { storeInstitutionalRecord, utf8ByteLength, type CorpusResult } from "../lib/qdrant-corpus.ts";
import { createInstitutionalSnapshot } from "../lib/qdrant-http-boundary.ts";
import { createQdrantCorpusClient, type QdrantCorpusClient } from "../lib/qdrant-http.ts";
import { withConfiguredMcpSession, type McpSession, type McpToolCaller } from "./integrations.ts";

const MCP_TIMEOUT_MS = 300_000;
const MAX_RECALL_RESULTS = 20;
const MAX_TOOL_OUTPUT_BYTES = 10 * 1024;
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
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
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

const artifactFromResponse = (data: Record<string, unknown>, extension?: string) => {
  const path = text(data.path);
  const sizeBytes = data.sizeBytes;
  return isAbsolute(path)
    && (extension === undefined || path.endsWith(extension))
    && (sizeBytes === undefined || (Number.isInteger(sizeBytes) && Number(sizeBytes) >= 0))
    ? { path, sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null }
    : null;
};

const dependenciesFor = (supplied: VestigeMigrateDependencies = {}) => ({
  client: supplied.client ?? createQdrantCorpusClient(),
  createSnapshot: supplied.createSnapshot ?? ((signal?: AbortSignal) => createInstitutionalSnapshot({}, signal)),
  mcpSession: supplied.mcpSession ?? withConfiguredMcpSession,
  now: supplied.now ?? (() => new Date()),
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

const importReason = (result: { success: false; error: { code: string } }): ImportReason =>
  result.error.code === "qdrant_unavailable" ? "qdrant_unavailable" : "store_failed";

const verifyInstitutionalImport = async (
  candidate: MigrationCandidate,
  client: QdrantCorpusClient,
  signal?: AbortSignal,
): Promise<{ verified: true } | { verified: false; reason: ImportReason }> => {
  try {
    throwIfAborted(signal);
    const full = await client.getInstitutional(candidate.expected.recordKey, signal);
    throwIfAborted(signal);
    if (!full.success) {
      return { verified: false, reason: full.error.code === "qdrant_unavailable" ? "qdrant_unavailable" : "verification_failed" };
    }
    if (!institutionalExpectationMatches(candidate.expected, full.data)) {
      return { verified: false, reason: "qdrant_response_invalid" };
    }
    const recalled = await client.recallInstitutional({
      lifecycleKey: candidate.expected.lifecycleKey,
      limit: MAX_RECALL_RESULTS,
    }, signal);
    throwIfAborted(signal);
    return recalled.success && lifecycleRecallContains(candidate.expected, recalled.data)
      ? { verified: true }
      : { verified: false, reason: recalled.success ? "verification_failed" : "qdrant_unavailable" };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { verified: false, reason: "qdrant_unavailable" };
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

const migrationRecovery = (backup: MigrationReport["recovery"]["backup"], exported: MigrationReport["recovery"]["export"], snapshot: MigrationReport["recovery"]["snapshot"]) => ({
  backup,
  export: exported,
  snapshot,
});

export async function migrateVestige(
  cwd: string,
  supplied: VestigeMigrateDependencies = {},
  signal?: AbortSignal,
) {
  const dependencies = dependenciesFor(supplied);
  const status = await safeQdrant(() => dependencies.client.status(signal), signal);
  if (!status.success) fail(status.error.code);

  const run = await safeArtifact(() => createMigrationArtifactRun(cwd, timestamp(dependencies.now()), signal), signal);
  let sourceArtifacts: { backup: Record<string, unknown>; export: Record<string, unknown> } | null = null;
  try {
    sourceArtifacts = await dependencies.mcpSession("vestige", async (call) => ({
      backup: await callMcpData(call, "maintain", { action: "backup" }, signal),
      export: await callMcpData(call, "maintain", { action: "export", format: "json" }, signal),
    }), signal);
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    fail("vestige_unavailable");
  }
  if (!sourceArtifacts) fail("vestige_unavailable");

  const backupSource = artifactFromResponse(sourceArtifacts.backup);
  const exportSource = artifactFromResponse(sourceArtifacts.export, ".json");
  if (!backupSource || !exportSource) fail("vestige_artifact_invalid");
  const backup = await safeArtifact(
    () => copyVerifiedArtifact({
      sourcePath: backupSource.path,
      run,
      destinationName: "vestige-backup.sqlite",
      maximumBytes: MAX_BACKUP_FILE_BYTES,
      signal,
    }),
    signal,
  );
  const exported = await safeArtifact(
    () => copyVerifiedArtifact({
      sourcePath: exportSource.path,
      run,
      destinationName: "vestige-export.json",
      maximumBytes: MAX_EXPORT_FILE_BYTES,
      signal,
    }),
    signal,
  );
  if (
    (backupSource.sizeBytes !== null && backupSource.sizeBytes !== backup.sizeBytes)
    || (exportSource.sizeBytes !== null && exportSource.sizeBytes !== exported.sizeBytes)
  ) fail("vestige_artifact_invalid");

  const exportText = await safeArtifact(
    () => readVerifiedText(join(run.directory, exported.relativePath), MAX_EXPORT_FILE_BYTES, signal),
    signal,
  );
  const parsed = parseVestigeExport(exportText);
  const exportedCount = sourceArtifacts.export.memoriesExported;
  if (
    !parsed
    || (
      Object.hasOwn(sourceArtifacts.export, "memoriesExported")
      && (!Number.isInteger(exportedCount) || exportedCount !== parsed.records.length)
    )
  ) fail("export_invalid");

  const classification = classifyVestigeExport(parsed.records);
  let recovery = migrationRecovery(backup, exported, { status: "not_applicable" });
  if (classification.lifecycle.length === 0) {
    const report = buildMigrationReport({ classification, outcomes: [], recovery });
    if (!report) fail("report_invalid");
    const output = await writeMigrationReport(run.directory, report, signal);
    fail(`no_lifecycle_records; see ${relative(run.projectRoot, output)}`);
  }
  if (status.data.collection !== "absent") {
    const created = await safeQdrant(() => dependencies.createSnapshot(signal), signal);
    if (!created.success) fail(created.error.code);
    recovery = migrationRecovery(backup, exported, { status: "created", name: created.data.name });
  }

  const ensured = await safeQdrant(() => dependencies.client.ensureCollection(signal), signal);
  if (!ensured.success) fail(ensured.error.code);

  const outcomes: ImportOutcome[] = [];
  for (const candidate of classification.lifecycle) {
    let stored: Awaited<ReturnType<typeof storeInstitutionalRecord>>;
    try {
      stored = await storeInstitutionalRecord({
        record: candidate.record,
        createdAt: candidate.createdAt,
        operations: dependencies.client,
        signal,
      });
      throwIfAborted(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      outcomes.push(importOutcome(candidate, "failed", "qdrant_unavailable"));
      continue;
    }
    if (!stored.success) {
      outcomes.push(stored.error.code === "record_conflict"
        ? importOutcome(candidate, "record_conflict")
        : importOutcome(candidate, "failed", importReason(stored)));
      continue;
    }
    const verification = await verifyInstitutionalImport(candidate, dependencies.client, signal);
    outcomes.push(verification.verified
      ? importOutcome(candidate, stored.data.status === "stored" ? "migrated" : "unchanged")
      : importOutcome(candidate, "unverified", verification.reason));
  }

  const report = buildMigrationReport({ classification, outcomes, recovery });
  if (!report) fail("report_invalid");
  const output = await writeMigrationReport(run.directory, report, signal);
  return { artifactPath: relative(run.projectRoot, output), report };
}

const cleanupVerification = async (
  outcome: ImportOutcome,
  client: QdrantCorpusClient,
  signal?: AbortSignal,
): Promise<CleanupRetentionReason | null> => {
  try {
    throwIfAborted(signal);
    const record = await client.getInstitutional(outcome.recordKey, signal);
    throwIfAborted(signal);
    if (!record.success) return record.error.code === "qdrant_unavailable" ? "qdrant_unavailable" : "qdrant_unverified";
    return cleanupOutcomeIsVerified(outcome, record.data) ? null : "qdrant_unverified";
  } catch (error) {
    if (signal?.aborted) throw error;
    return "qdrant_unavailable";
  }
};

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

  const candidates = cleanupOutcomes(report);
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
              const verification = await cleanupVerification(candidate, dependencies.client, signal);
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

export function registerVestigeMigrateTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  supplied: VestigeMigrateDependencies = {},
) {
  pi.registerTool({
    name: "ima_vestige_migrate",
    label: "Migrate Vestige lifecycle memories",
    description: "Back up, export, classify, redact, and idempotently migrate Vestige lifecycle memories to the institutional corpus. It never deletes Vestige memories.",
    parameters: migrateParameters,
    async execute(_id, _request, signal, _update, ctx) {
      const result = await queuedMutation(ctx.cwd, () => migrateVestige(ctx.cwd, supplied, signal), signal);
      return reportResult(result.artifactPath, result.report);
    },
  });
  pi.registerTool({
    name: "ima_vestige_cleanup",
    label: "Clean up verified Vestige lifecycle memories",
    description: "Explicitly delete only report-listed Vestige lifecycle memories after recovery and Tier-1 verification. Requires confirm: true and never deletes preferences.",
    parameters: cleanupParameters,
    async execute(_id, request, signal, _update, ctx) {
      const result = await queuedMutation(ctx.cwd, () => cleanupVestige(ctx.cwd, request, supplied, signal), signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}

export default function vestigeMigrate(pi: ExtensionAPI) {
  registerVestigeMigrateTools(pi);
}
