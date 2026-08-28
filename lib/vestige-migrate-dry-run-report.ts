import { isCorpusErrorCode, utf8ByteLength } from "./qdrant-corpus.ts";
import {
  MAX_BACKUP_FILE_BYTES,
  MAX_EXPORT_FILE_BYTES,
} from "./vestige-migrate-artifacts.ts";
import type { RecoveryReceipt } from "./vestige-migrate-report.ts";
import {
  MIGRATION_PREFLIGHT_CHECK_NAMES,
  boundedCheckMessage,
  isMigrationPreflightCheckName,
  isMigrationPreflightStatus,
  preflightOutcome,
  requiredMigrationMutations,
  safeCollection,
  safeMissingIndexes,
  safeVersion,
  type DryRunCorpus,
  type DryRunSummary,
  type MigrationPreflightCheck,
  type MigrationPreflightResult,
} from "./vestige-migrate-dry-run.ts";

export const MAX_DRY_RUN_REPORT_BYTES = 64 * 1024;
export const NOT_VERIFIED_OPERATIONS = [
  "snapshot_creation",
  "collection_and_index_mutation_permissions",
  "embedding_execution",
  "destination_insertion",
  "direct_destination_verification",
  "second_run_idempotency",
  "cleanup",
  "restore",
] as const;

const MAX_DRY_RUN_COUNT = 100_000;
const RECEIPT_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const REQUIRED_MUTATIONS = new Set([
  "create_institutional_collection",
  "create_missing_indexes",
  "create_snapshot",
  "embed_summaries",
  "store_and_verify_records",
]);

export type DryRunReport = MigrationPreflightResult & {
  schemaVersion: 1;
  reportType: "vestige-migration-dry-run";
  summary: DryRunSummary | null;
  corpus: DryRunCorpus;
  recovery: {
    backup?: RecoveryReceipt;
    export?: RecoveryReceipt;
  };
  requiredMigrationMutations: string[];
  notVerified: string[];
};

const sameStrings = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const nonNegativeInteger = (value: unknown, maximum: number) =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : null;

const validCount = (value: unknown) => nonNegativeInteger(value, MAX_DRY_RUN_COUNT);

const validReceipt = (value: unknown, maximumBytes: number): RecoveryReceipt | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const relativePath = typeof receipt.relativePath === "string" ? receipt.relativePath.trim() : "";
  const sizeBytes = nonNegativeInteger(receipt.sizeBytes, maximumBytes);
  const sha256 = typeof receipt.sha256 === "string" ? receipt.sha256.trim() : "";
  return onlyKeys(receipt, ["relativePath", "sizeBytes", "sha256"])
    && RECEIPT_NAME.test(relativePath)
    && sizeBytes !== null
    && SHA256.test(sha256)
    ? { relativePath, sizeBytes, sha256: sha256.toLowerCase() }
    : null;
};

const validCheck = (value: unknown): MigrationPreflightCheck | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const check = value as Record<string, unknown>;
  const name = check.name;
  const status = check.status;
  const code = check.code;
  const message = boundedCheckMessage(check.message);
  if (
    !onlyKeys(check, ["name", "status", "code", "message"])
    || !isMigrationPreflightCheckName(name)
    || !isMigrationPreflightStatus(status)
    || !message
    || (code !== undefined && (!isCorpusErrorCode(code) || status !== "FAIL"))
  ) return null;
  return {
    name,
    status,
    ...(code === undefined ? {} : { code }),
    message,
  };
};

const validChecks = (value: unknown): MigrationPreflightCheck[] | null => {
  if (!Array.isArray(value) || value.length !== MIGRATION_PREFLIGHT_CHECK_NAMES.length) return null;
  const checks = value.map(validCheck);
  return checks.some((check) => check === null)
    || !sameStrings(
      checks.map((check) => (check as MigrationPreflightCheck).name),
      [...MIGRATION_PREFLIGHT_CHECK_NAMES],
    )
    ? null
    : checks as MigrationPreflightCheck[];
};

const validSummary = (value: unknown): DryRunSummary | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  const fields = [
    "institutionalSources",
    "destinationRecords",
    "retainedPreferences",
    "quarantined",
    "redacted",
  ];
  if (!onlyKeys(summary, fields)) return null;
  const values = fields.map((field) => validCount(summary[field]));
  return values.some((entry) => entry === null)
    ? null
    : {
      institutionalSources: values[0] as number,
      destinationRecords: values[1] as number,
      retainedPreferences: values[2] as number,
      quarantined: values[3] as number,
      redacted: values[4] as number,
    };
};

const validCorpus = (value: unknown): DryRunCorpus | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const corpus = value as Record<string, unknown>;
  if (!onlyKeys(corpus, ["qdrantVersion", "collection", "missingIndexes"])) return null;
  const qdrantVersion = corpus.qdrantVersion === undefined ? undefined : safeVersion(corpus.qdrantVersion);
  const collection = corpus.collection === undefined ? undefined : safeCollection(corpus.collection);
  const missingIndexes = corpus.missingIndexes === undefined ? undefined : safeMissingIndexes(corpus.missingIndexes);
  return (corpus.qdrantVersion !== undefined && !qdrantVersion)
    || (corpus.collection !== undefined && !collection)
    || (corpus.missingIndexes !== undefined && !missingIndexes)
    ? null
    : {
      ...(qdrantVersion ? { qdrantVersion } : {}),
      ...(collection ? { collection } : {}),
      ...(missingIndexes ? { missingIndexes } : {}),
    };
};

const validRecovery = (value: unknown): DryRunReport["recovery"] | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const recovery = value as Record<string, unknown>;
  if (!onlyKeys(recovery, ["backup", "export"])) return null;
  const backup = recovery.backup === undefined
    ? undefined
    : validReceipt(recovery.backup, MAX_BACKUP_FILE_BYTES);
  const exported = recovery.export === undefined
    ? undefined
    : validReceipt(recovery.export, MAX_EXPORT_FILE_BYTES);
  return (recovery.backup !== undefined && !backup) || (recovery.export !== undefined && !exported)
    ? null
    : {
      ...(backup ? { backup } : {}),
      ...(exported ? { export: exported } : {}),
    };
};

const validMutations = (value: unknown) => Array.isArray(value)
  && value.length <= REQUIRED_MUTATIONS.size
  && value.every((mutation) => typeof mutation === "string" && REQUIRED_MUTATIONS.has(mutation))
  && new Set(value).size === value.length
  ? [...value]
  : null;

export const parseDryRunReport = (value: unknown): DryRunReport | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (!onlyKeys(report, [
    "schemaVersion",
    "reportType",
    "outcome",
    "checks",
    "summary",
    "corpus",
    "recovery",
    "requiredMigrationMutations",
    "notVerified",
  ])) return null;
  const checks = validChecks(report.checks);
  const summary = report.summary === null ? null : validSummary(report.summary);
  const corpus = validCorpus(report.corpus);
  const recovery = validRecovery(report.recovery);
  const mutations = validMutations(report.requiredMigrationMutations);
  const notVerified = Array.isArray(report.notVerified) && report.notVerified.every(
    (entry) => typeof entry === "string",
  ) ? report.notVerified : null;
  if (
    report.schemaVersion !== 1
    || report.reportType !== "vestige-migration-dry-run"
    || (report.outcome !== "READY" && report.outcome !== "NOT_READY")
    || !checks
    || (report.summary !== null && !summary)
    || !corpus
    || !recovery
    || !mutations
    || !notVerified
    || !sameStrings(notVerified, [...NOT_VERIFIED_OPERATIONS])
    || checks.at(-1)?.status !== "SKIP"
    || !sameStrings(mutations, requiredMigrationMutations(
      corpus.collection,
      summary?.institutionalSources ?? 0,
    ))
    || (summary === null) !== (
      checks.find((check) => check.name === "export_validation")?.status !== "PASS"
      || checks.find((check) => check.name === "classification_and_redaction")?.status !== "PASS"
    )
    || report.outcome !== preflightOutcome(checks)
  ) return null;
  return {
    schemaVersion: 1,
    reportType: "vestige-migration-dry-run",
    outcome: report.outcome,
    checks,
    summary,
    corpus,
    recovery,
    requiredMigrationMutations: mutations,
    notVerified: [...notVerified],
  };
};

export const buildDryRunReport = (input: {
  checks: MigrationPreflightCheck[];
  summary: DryRunSummary | null;
  corpus: DryRunCorpus;
  recovery: DryRunReport["recovery"];
  requiredMigrationMutations: string[];
}): DryRunReport | null => parseDryRunReport({
  schemaVersion: 1,
  reportType: "vestige-migration-dry-run",
  outcome: preflightOutcome(input.checks),
  checks: input.checks,
  summary: input.summary,
  corpus: input.corpus,
  recovery: input.recovery,
  requiredMigrationMutations: input.requiredMigrationMutations,
  notVerified: [...NOT_VERIFIED_OPERATIONS],
});

export const serializeDryRunReport = (report: DryRunReport) => {
  const parsed = parseDryRunReport(report);
  if (!parsed) return { success: false as const, error: "report_invalid" as const };
  const content = JSON.stringify(parsed);
  return utf8ByteLength(content) <= MAX_DRY_RUN_REPORT_BYTES
    ? { success: true as const, data: content }
    : { success: false as const, error: "report_too_large" as const };
};
