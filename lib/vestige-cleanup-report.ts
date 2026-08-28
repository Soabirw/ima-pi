import { utf8ByteLength } from "./qdrant-corpus.ts";
import {
  MAX_EXPORTED_RECORDS,
  MAX_MIGRATION_REPORT_BYTES,
} from "./vestige-migrate-report.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

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

const cleanupReasons = new Set<CleanupRetentionReason>([
  "qdrant_unverified",
  "qdrant_unavailable",
  "vestige_negative_ack",
  "vestige_unavailable",
]);

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const stringArray = (value: unknown) =>
  Array.isArray(value) && value.length <= MAX_EXPORTED_RECORDS && value.every((item) => typeof item === "string")
    ? value.map((item) => item.trim().toLowerCase())
    : null;

export function buildCleanupReport(input: {
  sourceReport: string;
  purgedIds: string[];
  retained: Array<{ vestigeId: string; reason: CleanupRetentionReason }>;
}): CleanupReport | null {
  const sourceReport = text(input.sourceReport);
  const purgedIds = stringArray(input.purgedIds);
  const retained = input.retained.map((item) => ({
    vestigeId: text(item.vestigeId).toLowerCase(),
    reason: item.reason,
  }));
  if (
    !ARTIFACT_NAME_PATTERN.test(sourceReport)
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
  if (!valid) return { success: false, error: "report_invalid" };
  const data = JSON.stringify(valid);
  return utf8ByteLength(data) <= MAX_MIGRATION_REPORT_BYTES
    ? { success: true, data }
    : { success: false, error: "report_too_large" };
}

export function parseCleanupReport(value: unknown): CleanupReport | null {
  const report = object(value);
  if (!report || !onlyKeys(report, ["schemaVersion", "sourceReport", "purgedIds", "retained"])) return null;
  if (report.schemaVersion !== 2 || !Array.isArray(report.retained)) return null;
  const retained = report.retained.map((item) => {
    const entry = object(item);
    const vestigeId = text(entry?.vestigeId).toLowerCase();
    const reason = text(entry?.reason) as CleanupRetentionReason;
    return entry
      && onlyKeys(entry, ["vestigeId", "reason"])
      && UUID_PATTERN.test(vestigeId)
      && cleanupReasons.has(reason)
      ? { vestigeId, reason }
      : null;
  });
  const sourceReport = text(report.sourceReport);
  const purgedIds = stringArray(report.purgedIds);
  if (
    !ARTIFACT_NAME_PATTERN.test(sourceReport)
    || !purgedIds
    || !purgedIds.every((id) => UUID_PATTERN.test(id))
    || retained.some((entry) => entry === null)
  ) return null;
  return buildCleanupReport({
    sourceReport,
    purgedIds,
    retained: retained as Array<{ vestigeId: string; reason: CleanupRetentionReason }>,
  });
}
