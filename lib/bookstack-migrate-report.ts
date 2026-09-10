import { createHash } from "node:crypto";

export const BOOKSTACK_MIGRATION_REPORT_VERSION = 1;
export type MigrationStatus = "created" | "unchanged" | "conflict" | "quarantined" | "failed" | "unverified";
export type MigrationOutcome = { sourceId: string; sourceHash: string; status: MigrationStatus; targetId?: number; code?: string };
export type BookStackMigrationReport = {
  schemaVersion: 1;
  reportType: "bookstack-migration";
  runId: string;
  specHash: string;
  sourceFingerprint: string;
  outcomes: MigrationOutcome[];
  summary: Record<MigrationStatus, number>;
};
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const STATUSES: MigrationStatus[] = ["created", "unchanged", "conflict", "quarantined", "failed", "unverified"];

export function buildBookStackMigrationReport(input: Omit<BookStackMigrationReport, "schemaVersion" | "reportType" | "summary">): BookStackMigrationReport {
  const identities = new Set<string>();
  for (const outcome of input.outcomes) {
    if (!outcome.sourceId || !/^[a-f0-9]{64}$/i.test(outcome.sourceHash) || !STATUSES.includes(outcome.status) || identities.has(outcome.sourceId)) {
      throw new Error("migration_report_invalid");
    }
    identities.add(outcome.sourceId);
  }
  const summary = Object.fromEntries(STATUSES.map((status) => [status, input.outcomes.filter((outcome) => outcome.status === status).length])) as Record<MigrationStatus, number>;
  return { schemaVersion: BOOKSTACK_MIGRATION_REPORT_VERSION, reportType: "bookstack-migration", ...input, outcomes: [...input.outcomes], summary };
}

export function serializeBookStackMigrationReport(report: BookStackMigrationReport): string {
  const verified = buildBookStackMigrationReport(report);
  return `${JSON.stringify(verified, null, 2)}\n`;
}

export function parseBookStackMigrationReport(value: unknown): BookStackMigrationReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const report = value as BookStackMigrationReport;
    if (report.schemaVersion !== 1 || report.reportType !== "bookstack-migration" || typeof report.runId !== "string" || typeof report.specHash !== "string" || typeof report.sourceFingerprint !== "string" || !Array.isArray(report.outcomes)) return null;
    const built = buildBookStackMigrationReport({ runId: report.runId, specHash: report.specHash, sourceFingerprint: report.sourceFingerprint, outcomes: report.outcomes });
    return JSON.stringify(built.summary) === JSON.stringify(report.summary) ? built : null;
  } catch { return null; }
}

export const reportHash = (report: BookStackMigrationReport) => hash(serializeBookStackMigrationReport(report));
