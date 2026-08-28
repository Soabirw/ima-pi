import {
  MAX_LIFECYCLE_KEY_LENGTH,
  MAX_PHASE_LENGTH,
  MAX_RECORD_KEY_LENGTH,
} from "./qdrant-corpus.ts";
import { MAX_SOURCE_BUNDLE_RECORDS } from "./vestige-migrate-source.ts";
export { MAX_SOURCE_BUNDLE_RECORDS } from "./vestige-migrate-source.ts";
import type {
  DestinationRecordRole,
  InstitutionalExpectation,
  MigrationRecordCandidate,
} from "./vestige-migrate-source.ts";
import type { QuarantineReason } from "./vestige-migrate.ts";

const UUID_LENGTH = 36;
const MAX_IMPORT_REASON_LENGTH = 32;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export const MAX_EXPORTED_RECORDS = 10_000;
export const MAX_DESTINATION_RECORDS = MAX_EXPORTED_RECORDS + MAX_SOURCE_BUNDLE_RECORDS;

export type ImportStatus = "migrated" | "unchanged" | "record_conflict" | "failed" | "unverified";
export type ImportReason =
  | "store_failed"
  | "qdrant_unavailable"
  | "verification_failed"
  | "qdrant_response_invalid"
  | "dependency_blocked";
export type DestinationRecordOutcome = Pick<InstitutionalExpectation, "id" | "recordKey" | "lifecycleKey" | "phase" | "contentHash">
  & {
    role: DestinationRecordRole;
    vestigeId: string;
    partIndex?: number;
    partCount?: number;
    status: ImportStatus;
    reason?: ImportReason;
  };
export type MigrationSourceOutcome = {
  vestigeId: string;
  sourceHash: string;
  sourceBytes: number;
  status: ImportStatus;
  records: DestinationRecordOutcome[];
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const nonNegativeInteger = (value: unknown, maximum = MAX_SOURCE_BYTES) =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
const sameStrings = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const importStatuses = new Set<ImportStatus>(["migrated", "unchanged", "record_conflict", "failed", "unverified"]);
const importReasons = new Set<ImportReason>([
  "store_failed",
  "qdrant_unavailable",
  "verification_failed",
  "qdrant_response_invalid",
  "dependency_blocked",
]);
const quarantineReasons = new Set<QuarantineReason>([
  "export_invalid",
  "record_invalid",
  "record_too_large",
  "summary_invalid",
]);

const sourceReferenceArray = (value: unknown) =>
  Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === "string")
    ? value
    : null;

const validRoleFields = (input: {
  role: unknown;
  partIndex: unknown;
  partCount: unknown;
}): { role: DestinationRecordRole; partIndex?: number; partCount?: number } | null => {
  const role = text(input.role) as DestinationRecordRole;
  const partIndex = input.partIndex === undefined
    ? undefined
    : nonNegativeInteger(input.partIndex, MAX_SOURCE_BUNDLE_RECORDS);
  const partCount = input.partCount === undefined
    ? undefined
    : nonNegativeInteger(input.partCount, MAX_SOURCE_BUNDLE_RECORDS);
  if (role === "single" && partIndex === undefined && partCount === undefined) return { role };
  if (
    role === "part"
    && partIndex !== undefined
    && partIndex >= 1
    && partCount !== undefined
    && partCount >= 1
    && partCount < MAX_SOURCE_BUNDLE_RECORDS
    && partIndex <= partCount
  ) return { role, partIndex, partCount };
  if (
    role === "index"
    && partIndex === undefined
    && partCount !== undefined
    && partCount >= 1
    && partCount < MAX_SOURCE_BUNDLE_RECORDS
  ) return { role, partCount };
  return null;
};

const validDestinationRecordOutcome = (value: unknown): DestinationRecordOutcome | null => {
  const outcome = object(value);
  if (!outcome || !onlyKeys(outcome, [
    "role",
    "vestigeId",
    "partIndex",
    "partCount",
    "id",
    "recordKey",
    "lifecycleKey",
    "phase",
    "contentHash",
    "status",
    "reason",
  ])) return null;
  const role = validRoleFields(outcome);
  const status = text(outcome.status) as ImportStatus;
  const reason = outcome.reason === undefined ? undefined : text(outcome.reason) as ImportReason;
  const requiresReason = status === "failed" || status === "unverified";
  if (
    !role
    || !UUID_PATTERN.test(text(outcome.vestigeId))
    || !UUID_PATTERN.test(text(outcome.id))
    || !text(outcome.recordKey)
    || text(outcome.recordKey).length > MAX_RECORD_KEY_LENGTH
    || !text(outcome.lifecycleKey)
    || text(outcome.lifecycleKey).length > MAX_LIFECYCLE_KEY_LENGTH
    || !text(outcome.phase)
    || text(outcome.phase).length > MAX_PHASE_LENGTH
    || !SHA256_PATTERN.test(text(outcome.contentHash))
    || !importStatuses.has(status)
    || (reason !== undefined && (!importReasons.has(reason) || reason.length > MAX_IMPORT_REASON_LENGTH))
    || requiresReason !== (reason !== undefined)
  ) return null;
  return {
    role: role.role,
    vestigeId: text(outcome.vestigeId).toLowerCase(),
    ...(role.partIndex === undefined ? {} : { partIndex: role.partIndex }),
    ...(role.partCount === undefined ? {} : { partCount: role.partCount }),
    id: text(outcome.id).toLowerCase(),
    recordKey: text(outcome.recordKey),
    lifecycleKey: text(outcome.lifecycleKey),
    phase: text(outcome.phase),
    contentHash: text(outcome.contentHash).toLowerCase(),
    status,
    ...(reason ? { reason } : {}),
  };
};

const validSourceLayout = (records: DestinationRecordOutcome[]) => {
  if (!records.length || records.length > MAX_SOURCE_BUNDLE_RECORDS) return false;
  if (records.length === 1) return records[0].role === "single";
  const index = records.at(-1);
  const parts = records.slice(0, -1);
  return index?.role === "index"
    && index.partCount === parts.length
    && parts.every((record, position) =>
      record.role === "part"
      && record.partIndex === position + 1
      && record.partCount === parts.length,
    );
};

export const deriveSourceStatus = (records: Array<Pick<DestinationRecordOutcome, "status">>): ImportStatus => {
  if (records.every((record) => record.status === "unchanged")) return "unchanged";
  if (records.every((record) => record.status === "migrated" || record.status === "unchanged")) return "migrated";
  if (records.some((record) => record.status === "record_conflict")) return "record_conflict";
  if (records.some((record) => record.status === "unverified")) return "unverified";
  return "failed";
};

export const parseMigrationSourceOutcome = (value: unknown): MigrationSourceOutcome | null => {
  const outcome = object(value);
  if (!outcome || !onlyKeys(outcome, ["vestigeId", "sourceHash", "sourceBytes", "status", "records"])) return null;
  const records = Array.isArray(outcome.records)
    ? outcome.records.map(validDestinationRecordOutcome)
    : null;
  const sourceBytes = nonNegativeInteger(outcome.sourceBytes);
  const status = text(outcome.status) as ImportStatus;
  if (
    !UUID_PATTERN.test(text(outcome.vestigeId))
    || !SHA256_PATTERN.test(text(outcome.sourceHash))
    || sourceBytes === null
    || sourceBytes < 1
    || !importStatuses.has(status)
    || !records
    || records.some((record) => record === null)
    || !validSourceLayout(records as DestinationRecordOutcome[])
    || deriveSourceStatus(records as DestinationRecordOutcome[]) !== status
    || (records as DestinationRecordOutcome[]).some((record) => record.vestigeId !== text(outcome.vestigeId).toLowerCase())
  ) return null;
  return {
    vestigeId: text(outcome.vestigeId).toLowerCase(),
    sourceHash: text(outcome.sourceHash).toLowerCase(),
    sourceBytes,
    status,
    records: records as DestinationRecordOutcome[],
  };
};

export const migrationOutcomeMatchesCandidate = (
  candidate: MigrationRecordCandidate,
  outcome: DestinationRecordOutcome,
) => outcome.role === candidate.role
  && outcome.partIndex === candidate.partIndex
  && outcome.partCount === candidate.partCount
  && outcome.id === candidate.expected.id
  && outcome.recordKey === candidate.expected.recordKey
  && outcome.lifecycleKey === candidate.expected.lifecycleKey
  && outcome.phase === candidate.expected.phase
  && outcome.contentHash === candidate.expected.contentHash
  && outcome.vestigeId.length === UUID_LENGTH;

export function destinationRecordOutcome(
  vestigeId: string,
  candidate: MigrationRecordCandidate,
  status: ImportStatus,
  reason?: ImportReason,
): DestinationRecordOutcome {
  return {
    role: candidate.role,
    vestigeId,
    ...(candidate.partIndex === undefined ? {} : { partIndex: candidate.partIndex }),
    ...(candidate.partCount === undefined ? {} : { partCount: candidate.partCount }),
    id: candidate.expected.id,
    recordKey: candidate.expected.recordKey,
    lifecycleKey: candidate.expected.lifecycleKey,
    phase: candidate.expected.phase,
    contentHash: candidate.expected.contentHash,
    status,
    ...(reason ? { reason } : {}),
  };
}

export const sourceDestinationOutcome = destinationRecordOutcome;

export const hasUniqueDestinationRecordKeys = (outcomes: MigrationSourceOutcome[]) => {
  const recordKeys = outcomes.flatMap((outcome) => outcome.records.map((record) => record.recordKey));
  return recordKeys.length <= MAX_DESTINATION_RECORDS && new Set(recordKeys).size === recordKeys.length;
};

export function institutionalExpectationMatches(expectation: InstitutionalExpectation, value: unknown) {
  const record = object(value);
  const sourceRefs = sourceReferenceArray(record?.sourceRefs);
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

export function cleanupDestinationIsVerified(
  outcome: DestinationRecordOutcome,
  value: unknown,
) {
  const record = object(value);
  const sourceRefs = sourceReferenceArray(record?.sourceRefs);
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

export const isQuarantineReason = (value: string): value is QuarantineReason =>
  quarantineReasons.has(value as QuarantineReason);
