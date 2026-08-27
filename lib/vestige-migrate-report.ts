import {
  MAX_LIFECYCLE_KEY_LENGTH,
  MAX_PHASE_LENGTH,
  MAX_RECORD_KEY_LENGTH,
  utf8ByteLength,
} from "./qdrant-corpus.ts";
import type {
  InstitutionalExpectation,
  MigrationCandidate,
  MigrationClassification,
  QuarantineReason,
  QuarantinedMemory,
} from "./vestige-migrate.ts";

const UUID_LENGTH = 36;
const SHA256_LENGTH = 64;
const MAX_ARTIFACT_NAME_LENGTH = 128;
const MAX_IMPORT_REASON_LENGTH = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const MAX_EXPORTED_RECORDS = 10_000;
const MAX_ESCAPED_METADATA_BYTES = 2 * (
  UUID_LENGTH * 2
  + MAX_RECORD_KEY_LENGTH
  + MAX_LIFECYCLE_KEY_LENGTH
  + MAX_PHASE_LENGTH
  + SHA256_LENGTH
  + MAX_IMPORT_REASON_LENGTH
);
const MAX_IMPORT_OUTCOME_BYTES = 512 + MAX_ESCAPED_METADATA_BYTES;
const MAX_QUARANTINE_BYTES = 192;
const MAX_RECOVERY_RECEIPT_BYTES = 512 * 1024 * 1024;
export const MAX_MIGRATION_REPORT_BYTES = 8_192
  + MAX_EXPORTED_RECORDS * (MAX_IMPORT_OUTCOME_BYTES + MAX_QUARANTINE_BYTES);

export type ImportStatus = "migrated" | "unchanged" | "record_conflict" | "failed" | "unverified";
export type ImportReason = "store_failed" | "qdrant_unavailable" | "verification_failed" | "qdrant_response_invalid";
export type ImportOutcome = Pick<InstitutionalExpectation, "id" | "recordKey" | "lifecycleKey" | "phase" | "contentHash">
  & { vestigeId: string; status: ImportStatus; reason?: ImportReason };

export type RecoveryReceipt = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

export type MigrationReport = {
  schemaVersion: 2;
  recovery: {
    backup: RecoveryReceipt;
    export: RecoveryReceipt;
    snapshot: { status: "created"; name: string } | { status: "not_applicable" };
  };
  summary: {
    migrated: number;
    unchanged: number;
    retainedPreferences: number;
    quarantined: number;
    conflicts: number;
    failed: number;
    unverified: number;
    redacted: number;
  };
  outcomes: ImportOutcome[];
  quarantined: QuarantinedMemory[];
};

export type CleanupRetentionReason =
  | "qdrant_unverified"
  | "qdrant_unavailable"
  | "vestige_negative_ack"
  | "vestige_unavailable";
export type CleanupReport = {
  schemaVersion: 2;
  sourceReport: string;
  purgedIds: string[];
  retained: Array<{ vestigeId: string; reason: CleanupRetentionReason }>;
};

type SerializationResult = { success: true; data: string } | { success: false; error: "report_invalid" | "report_too_large" };

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const stringArray = (value: unknown, maximum = MAX_EXPORTED_RECORDS) =>
  Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string")
    ? value
    : null;
const nonNegativeInteger = (value: unknown, maximum = MAX_MIGRATION_REPORT_BYTES) =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;

export function importOutcome(
  candidate: MigrationCandidate,
  status: ImportStatus,
  reason?: ImportReason,
): ImportOutcome {
  return {
    vestigeId: candidate.vestigeId,
    id: candidate.expected.id,
    recordKey: candidate.expected.recordKey,
    lifecycleKey: candidate.expected.lifecycleKey,
    phase: candidate.expected.phase,
    contentHash: candidate.expected.contentHash,
    status,
    ...(reason ? { reason } : {}),
  };
}

const importStatuses = new Set<ImportStatus>(["migrated", "unchanged", "record_conflict", "failed", "unverified"]);
const importReasons = new Set<ImportReason>(["store_failed", "qdrant_unavailable", "verification_failed", "qdrant_response_invalid"]);
const cleanupReasons = new Set<CleanupRetentionReason>([
  "qdrant_unverified",
  "qdrant_unavailable",
  "vestige_negative_ack",
  "vestige_unavailable",
]);

const validImportOutcome = (value: unknown): ImportOutcome | null => {
  const outcome = object(value);
  if (!outcome || !onlyKeys(outcome, ["vestigeId", "id", "recordKey", "lifecycleKey", "phase", "contentHash", "status", "reason"])) return null;
  const status = text(outcome.status) as ImportStatus;
  const reason = outcome.reason === undefined ? undefined : text(outcome.reason) as ImportReason;
  if (
    !UUID_PATTERN.test(text(outcome.vestigeId))
    || !UUID_PATTERN.test(text(outcome.id))
    || !text(outcome.recordKey)
    || text(outcome.recordKey).length > MAX_RECORD_KEY_LENGTH
    || !text(outcome.lifecycleKey)
    || text(outcome.lifecycleKey).length > MAX_LIFECYCLE_KEY_LENGTH
    || !text(outcome.phase)
    || text(outcome.phase).length > MAX_PHASE_LENGTH
    || !SHA256_PATTERN.test(text(outcome.contentHash))
    || !importStatuses.has(status)
    || (reason !== undefined && !importReasons.has(reason))
    || ((status === "failed" || status === "unverified") !== (reason !== undefined))
  ) return null;
  return {
    vestigeId: text(outcome.vestigeId),
    id: text(outcome.id),
    recordKey: text(outcome.recordKey),
    lifecycleKey: text(outcome.lifecycleKey),
    phase: text(outcome.phase),
    contentHash: text(outcome.contentHash),
    status,
    ...(reason ? { reason } : {}),
  };
};

const validReceipt = (value: unknown): RecoveryReceipt | null => {
  const receipt = object(value);
  if (!receipt || !onlyKeys(receipt, ["relativePath", "sizeBytes", "sha256"])) return null;
  const relativePath = text(receipt.relativePath);
  const sizeBytes = nonNegativeInteger(receipt.sizeBytes, MAX_RECOVERY_RECEIPT_BYTES);
  return ARTIFACT_NAME_PATTERN.test(relativePath) && sizeBytes !== null && SHA256_PATTERN.test(text(receipt.sha256))
    ? { relativePath, sizeBytes, sha256: text(receipt.sha256) }
    : null;
};

const derivedSummary = (input: { outcomes: ImportOutcome[]; retainedPreferences: number; quarantined: number; redacted: number }) =>
  input.outcomes.reduce(
    (summary, outcome) => ({
      ...summary,
      migrated: summary.migrated + Number(outcome.status === "migrated"),
      unchanged: summary.unchanged + Number(outcome.status === "unchanged"),
      conflicts: summary.conflicts + Number(outcome.status === "record_conflict"),
      failed: summary.failed + Number(outcome.status === "failed"),
      unverified: summary.unverified + Number(outcome.status === "unverified"),
    }),
    {
      migrated: 0,
      unchanged: 0,
      retainedPreferences: input.retainedPreferences,
      quarantined: input.quarantined,
      conflicts: 0,
      failed: 0,
      unverified: 0,
      redacted: input.redacted,
    },
  );

export function buildMigrationReport(input: {
  classification: MigrationClassification;
  outcomes: ImportOutcome[];
  recovery: MigrationReport["recovery"];
}): MigrationReport | null {
  if (
    input.outcomes.length !== input.classification.lifecycle.length
    || input.outcomes.some((outcome) => !validImportOutcome(outcome))
  ) return null;
  const candidates = new Map(input.classification.lifecycle.map((candidate) => [candidate.vestigeId, candidate]));
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.vestigeId, outcome]));
  if (candidates.size !== input.classification.lifecycle.length || outcomes.size !== input.outcomes.length) return null;

  for (const [vestigeId, candidate] of candidates) {
    const outcome = outcomes.get(vestigeId);
    if (
      !outcome
      || outcome.id !== candidate.expected.id
      || outcome.recordKey !== candidate.expected.recordKey
      || outcome.lifecycleKey !== candidate.expected.lifecycleKey
      || outcome.phase !== candidate.expected.phase
      || outcome.contentHash !== candidate.expected.contentHash
    ) return null;
  }

  return {
    schemaVersion: 2,
    recovery: input.recovery,
    summary: derivedSummary({
      outcomes: input.outcomes,
      retainedPreferences: input.classification.retained.length,
      quarantined: input.classification.quarantined.length,
      redacted: input.classification.lifecycle.reduce((count, candidate) => count + Number(candidate.wasRedacted), 0),
    }),
    outcomes: input.outcomes.map((outcome) => ({ ...outcome })),
    quarantined: input.classification.quarantined.map((item) => ({ ...item })),
  };
}

const sameStrings = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export function institutionalExpectationMatches(expectation: InstitutionalExpectation, value: unknown) {
  const record = object(value);
  const sourceRefs = stringArray(record?.sourceRefs, 64);
  return Boolean(
    record
    && sourceRefs
    && record.id === expectation.id
    && record.recordKey === expectation.recordKey
    && record.project === expectation.project
    && record.site === expectation.site
    && record.repo === expectation.repo
    && record.lifecycleKey === expectation.lifecycleKey
    && record.phase === expectation.phase
    && record.summary === expectation.summary
    && record.detail === expectation.detail
    && record.contentHash === expectation.contentHash
    && record.createdAt === expectation.createdAt
    && sameStrings(sourceRefs, expectation.sourceRefs),
  );
}

export function lifecycleRecallContains(expectation: InstitutionalExpectation, value: unknown) {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    const record = object(item);
    return record?.id === expectation.id
      && record.recordKey === expectation.recordKey
      && record.lifecycleKey === expectation.lifecycleKey
      && record.phase === expectation.phase;
  });
}

export function cleanupOutcomeIsVerified(outcome: ImportOutcome, value: unknown) {
  const record = object(value);
  const sourceRefs = stringArray(record?.sourceRefs, 64);
  return Boolean(
    record
    && sourceRefs
    && record.id === outcome.id
    && record.recordKey === outcome.recordKey
    && record.lifecycleKey === outcome.lifecycleKey
    && record.phase === outcome.phase
    && record.contentHash === outcome.contentHash
    && sourceRefs.includes(`vestige:${outcome.vestigeId}`),
  );
}

export function parseMigrationReport(value: unknown): MigrationReport | null {
  const report = object(value);
  if (!report || !onlyKeys(report, ["schemaVersion", "recovery", "summary", "outcomes", "quarantined"])) return null;
  if (report.schemaVersion !== 2) return null;
  const recovery = object(report.recovery);
  if (!recovery || !onlyKeys(recovery, ["backup", "export", "snapshot"])) return null;
  const backup = validReceipt(recovery.backup);
  const exported = validReceipt(recovery.export);
  const snapshot = object(recovery.snapshot);
  const snapshotName = text(snapshot?.name);
  const validSnapshot = snapshot && onlyKeys(snapshot, ["status", "name"])
    ? snapshot.status === "not_applicable" && snapshot.name === undefined
      ? { status: "not_applicable" as const }
      : snapshot.status === "created" && ARTIFACT_NAME_PATTERN.test(snapshotName)
        ? { status: "created" as const, name: snapshotName }
        : null
    : null;
  const outcomes = Array.isArray(report.outcomes) ? report.outcomes.map(validImportOutcome) : null;
  const quarantined = Array.isArray(report.quarantined)
    ? report.quarantined.map((item) => {
      const candidate = object(item);
      const vestigeId = candidate?.vestigeId === null ? null : text(candidate?.vestigeId);
      const reason = text(candidate?.reason) as QuarantineReason;
      return candidate
        && onlyKeys(candidate, ["vestigeId", "reason"])
        && (vestigeId === null || UUID_PATTERN.test(vestigeId))
        && ["record_invalid", "record_too_large", "lifecycle_invalid", "export_invalid"].includes(reason)
        ? { vestigeId, reason }
        : null;
    })
    : null;
  const summary = object(report.summary);
  if (
    !backup
    || !exported
    || !validSnapshot
    || !outcomes
    || outcomes.some((outcome) => outcome === null)
    || !quarantined
    || quarantined.some((item) => item === null)
    || outcomes.length > MAX_EXPORTED_RECORDS
    || quarantined.length > MAX_EXPORTED_RECORDS
    || !summary
    || !onlyKeys(summary, ["migrated", "unchanged", "retainedPreferences", "quarantined", "conflicts", "failed", "unverified", "redacted"])
  ) return null;

  const parsedOutcomes = outcomes as ImportOutcome[];
  const parsedQuarantined = quarantined as QuarantinedMemory[];
  const uniqueVestigeIds = new Set(parsedOutcomes.map((outcome) => outcome.vestigeId));
  const retainedPreferences = nonNegativeInteger(summary.retainedPreferences, MAX_EXPORTED_RECORDS);
  const redacted = nonNegativeInteger(summary.redacted, MAX_EXPORTED_RECORDS);
  if (
    uniqueVestigeIds.size !== parsedOutcomes.length
    || retainedPreferences === null
    || redacted === null
  ) return null;

  const expected = derivedSummary({
    outcomes: parsedOutcomes,
    retainedPreferences,
    quarantined: parsedQuarantined.length,
    redacted,
  });
  return Object.entries(expected).every(([key, value]) => summary[key] === value)
    ? {
      schemaVersion: 2,
      recovery: { backup, export: exported, snapshot: validSnapshot },
      summary: expected,
      outcomes: parsedOutcomes,
      quarantined: parsedQuarantined,
    }
    : null;
}

const serialize = (value: unknown): SerializationResult => {
  const content = JSON.stringify(value);
  return utf8ByteLength(content) <= MAX_MIGRATION_REPORT_BYTES
    ? { success: true, data: content }
    : { success: false, error: "report_too_large" };
};

export function serializeMigrationReport(report: MigrationReport): SerializationResult {
  return parseMigrationReport(report) ? serialize(report) : { success: false, error: "report_invalid" };
}

export function cleanupOutcomes(report: MigrationReport) {
  return report.outcomes.filter((outcome) => outcome.status === "migrated" || outcome.status === "unchanged");
}

export function buildCleanupReport(input: {
  sourceReport: string;
  purgedIds: string[];
  retained: Array<{ vestigeId: string; reason: CleanupRetentionReason }>;
}): CleanupReport | null {
  const sourceReport = text(input.sourceReport);
  const purgedIds = stringArray(input.purgedIds, MAX_EXPORTED_RECORDS);
  const retained = input.retained.map((item) => ({ vestigeId: text(item.vestigeId), reason: item.reason }));
  if (
    !ARTIFACT_NAME_PATTERN.test(sourceReport)
    || sourceReport.length > MAX_ARTIFACT_NAME_LENGTH
    || !purgedIds
    || !purgedIds.every((id) => UUID_PATTERN.test(id))
    || retained.length > MAX_EXPORTED_RECORDS
    || !retained.every((item) => UUID_PATTERN.test(item.vestigeId) && cleanupReasons.has(item.reason))
    || new Set([...purgedIds, ...retained.map((item) => item.vestigeId)]).size !== purgedIds.length + retained.length
  ) return null;
  return { schemaVersion: 2, sourceReport, purgedIds: [...purgedIds], retained };
}

export function serializeCleanupReport(report: CleanupReport): SerializationResult {
  const valid = buildCleanupReport(report);
  return valid ? serialize(valid) : { success: false, error: "report_invalid" };
}
