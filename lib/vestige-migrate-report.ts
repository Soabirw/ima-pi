import { utf8ByteLength } from "./qdrant-corpus.ts";
import {
  MAX_EXPORTED_RECORDS,
  MAX_SOURCE_BUNDLE_RECORDS,
  cleanupDestinationIsVerified,
  deriveSourceStatus,
  destinationRecordOutcome,
  hasUniqueDestinationRecordKeys,
  institutionalExpectationMatches,
  isQuarantineReason,
  migrationOutcomeMatchesCandidate,
  parseMigrationSourceOutcome,
  sourceDestinationOutcome,
  vestigePurgeAcknowledged,
  type DestinationRecordOutcome,
  type ImportReason,
  type ImportStatus,
  type MigrationSourceOutcome,
} from "./vestige-migrate-outcomes.ts";
import type {
  MigrationClassification,
  QuarantinedMemory,
  RetainedPreference,
} from "./vestige-migrate.ts";

const SQLITE_HEADER_BYTES = 100;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export { MAX_EXPORTED_RECORDS, MAX_SOURCE_BUNDLE_RECORDS };
export {
  cleanupDestinationIsVerified,
  deriveSourceStatus,
  destinationRecordOutcome,
  institutionalExpectationMatches,
  sourceDestinationOutcome,
  vestigePurgeAcknowledged,
};
export type {
  DestinationRecordOutcome,
  ImportReason,
  ImportStatus,
  MigrationSourceOutcome,
};

export const MAX_MIGRATION_REPORT_BYTES = 16 * 1024 * 1024;

export type RecoveryReceipt = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};
export type MigrationReport = {
  schemaVersion: 2;
  layout: "source-bundles";
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
  outcomes: MigrationSourceOutcome[];
  retainedPreferences: RetainedPreference[];
  quarantined: QuarantinedMemory[];
};

type SerializationResult = { success: true; data: string } | { success: false; error: "report_invalid" | "report_too_large" };

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const nonNegativeInteger = (value: unknown, maximum = MAX_MIGRATION_REPORT_BYTES) =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;

const validReceipt = (value: unknown): RecoveryReceipt | null => {
  const receipt = object(value);
  if (!receipt || !onlyKeys(receipt, ["relativePath", "sizeBytes", "sha256"])) return null;
  const relativePath = text(receipt.relativePath);
  const sizeBytes = nonNegativeInteger(receipt.sizeBytes, 512 * 1024 * 1024);
  return ARTIFACT_NAME_PATTERN.test(relativePath) && sizeBytes !== null && SHA256_PATTERN.test(text(receipt.sha256))
    ? { relativePath, sizeBytes, sha256: text(receipt.sha256).toLowerCase() }
    : null;
};

const validRecovery = (value: unknown): MigrationReport["recovery"] | null => {
  const recovery = object(value);
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
  return backup && backup.sizeBytes >= SQLITE_HEADER_BYTES && exported && validSnapshot
    ? { backup, export: exported, snapshot: validSnapshot }
    : null;
};

const validRetainedPreference = (value: unknown): RetainedPreference | null => {
  const preference = object(value);
  if (!preference || !onlyKeys(preference, ["vestigeId", "reason"])) return null;
  const vestigeId = text(preference.vestigeId).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(vestigeId)
    && preference.reason === "explicit_preference"
    ? { vestigeId, reason: "explicit_preference" }
    : null;
};

const validQuarantinedMemory = (value: unknown): QuarantinedMemory | null => {
  const candidate = object(value);
  const vestigeId = candidate?.vestigeId === null ? null : text(candidate?.vestigeId).toLowerCase();
  const reason = text(candidate?.reason);
  return candidate
    && onlyKeys(candidate, ["vestigeId", "reason"])
    && (vestigeId === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(vestigeId))
    && isQuarantineReason(reason)
    ? { vestigeId, reason }
    : null;
};

const derivedSummary = (input: {
  outcomes: MigrationSourceOutcome[];
  retainedPreferences: number;
  quarantined: number;
  redacted: number;
}) => input.outcomes.reduce(
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

const distinctSourceIds = (input: {
  outcomes: MigrationSourceOutcome[];
  retained: RetainedPreference[];
  quarantined: QuarantinedMemory[];
}) => {
  const imported = input.outcomes.map((outcome) => outcome.vestigeId);
  const retained = input.retained.map((preference) => preference.vestigeId);
  const quarantined = input.quarantined.flatMap((memory) => memory.vestigeId ? [memory.vestigeId] : []);
  const all = [...imported, ...retained, ...quarantined];
  return new Set(all).size === all.length;
};

const uniqueRecordKeys = hasUniqueDestinationRecordKeys;

export function buildMigrationReport(input: {
  classification: MigrationClassification;
  outcomes: MigrationSourceOutcome[];
  recovery: MigrationReport["recovery"];
}): MigrationReport | null {
  const recovery = validRecovery(input.recovery);
  if (
    !recovery
    || input.outcomes.length !== input.classification.institutional.length
    || input.outcomes.length > MAX_EXPORTED_RECORDS
    || input.outcomes.some((outcome) => !parseMigrationSourceOutcome(outcome))
    || input.classification.retained.some((preference) => !validRetainedPreference(preference))
    || input.classification.quarantined.some((memory) => !validQuarantinedMemory(memory))
  ) return null;

  const candidates = new Map(input.classification.institutional.map((candidate) => [candidate.vestigeId, candidate]));
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.vestigeId, outcome]));
  if (candidates.size !== input.classification.institutional.length || outcomes.size !== input.outcomes.length) return null;

  for (const [vestigeId, candidate] of candidates) {
    const outcome = outcomes.get(vestigeId);
    if (
      !outcome
      || outcome.sourceHash !== candidate.sourceHash
      || outcome.sourceBytes !== candidate.sourceBytes
      || outcome.records.length !== candidate.records.length
      || outcome.records.some((record, index) => !migrationOutcomeMatchesCandidate(candidate.records[index], record))
      || outcome.status !== deriveSourceStatus(outcome.records)
    ) return null;
  }

  if (!distinctSourceIds({
    outcomes: input.outcomes,
    retained: input.classification.retained,
    quarantined: input.classification.quarantined,
  }) || !uniqueRecordKeys(input.outcomes)) return null;

  const parsedOutcomes = input.outcomes.map((outcome) => ({
    ...outcome,
    records: outcome.records.map((record) => ({ ...record })),
  }));
  const retainedPreferences = input.classification.retained.map((preference) => ({ ...preference }));
  const quarantined = input.classification.quarantined.map((memory) => ({ ...memory }));
  return {
    schemaVersion: 2,
    layout: "source-bundles",
    recovery,
    summary: derivedSummary({
      outcomes: parsedOutcomes,
      retainedPreferences: retainedPreferences.length,
      quarantined: quarantined.length,
      redacted: input.classification.institutional.reduce((count, candidate) => count + Number(candidate.wasRedacted), 0),
    }),
    outcomes: parsedOutcomes,
    retainedPreferences,
    quarantined,
  };
}

export function parseMigrationReport(value: unknown): MigrationReport | null {
  const report = object(value);
  if (!report || !onlyKeys(report, [
    "schemaVersion",
    "layout",
    "recovery",
    "summary",
    "outcomes",
    "retainedPreferences",
    "quarantined",
  ])) return null;
  if (report.schemaVersion !== 2 || report.layout !== "source-bundles") return null;

  const recovery = validRecovery(report.recovery);
  const outcomes = Array.isArray(report.outcomes) ? report.outcomes.map(parseMigrationSourceOutcome) : null;
  const retainedPreferences = Array.isArray(report.retainedPreferences)
    ? report.retainedPreferences.map(validRetainedPreference)
    : null;
  const quarantined = Array.isArray(report.quarantined)
    ? report.quarantined.map(validQuarantinedMemory)
    : null;
  const summary = object(report.summary);
  if (
    !recovery
    || !outcomes
    || !retainedPreferences
    || !quarantined
    || outcomes.some((outcome) => outcome === null)
    || retainedPreferences.some((preference) => preference === null)
    || quarantined.some((memory) => memory === null)
    || outcomes.length > MAX_EXPORTED_RECORDS
    || retainedPreferences.length > MAX_EXPORTED_RECORDS
    || quarantined.length > MAX_EXPORTED_RECORDS
    || !summary
    || !onlyKeys(summary, ["migrated", "unchanged", "retainedPreferences", "quarantined", "conflicts", "failed", "unverified", "redacted"])
  ) return null;

  const parsedOutcomes = outcomes as MigrationSourceOutcome[];
  const parsedRetained = retainedPreferences as RetainedPreference[];
  const parsedQuarantined = quarantined as QuarantinedMemory[];
  const redacted = nonNegativeInteger(summary.redacted, MAX_EXPORTED_RECORDS);
  if (
    redacted === null
    || redacted > parsedOutcomes.length
    || !distinctSourceIds({ outcomes: parsedOutcomes, retained: parsedRetained, quarantined: parsedQuarantined })
    || !uniqueRecordKeys(parsedOutcomes)
  ) return null;

  const expected = derivedSummary({
    outcomes: parsedOutcomes,
    retainedPreferences: parsedRetained.length,
    quarantined: parsedQuarantined.length,
    redacted,
  });
  return Object.entries(expected).every(([key, value]) => summary[key] === value)
    ? {
      schemaVersion: 2,
      layout: "source-bundles",
      recovery,
      summary: expected,
      outcomes: parsedOutcomes,
      retainedPreferences: parsedRetained,
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

export function cleanupSources(report: MigrationReport) {
  return report.outcomes.filter((outcome) => outcome.status === "migrated" || outcome.status === "unchanged");
}
