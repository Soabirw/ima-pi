import { sourceHash, type TargetPage } from "./bookstack-migrate-source.ts";

const MAX_APPENDED_LIFECYCLE = 500;
const SHA256 = /^[a-f0-9]{64}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const inventoryFingerprint = (pages: TargetPage[]) => sourceHash(
  pages.map((page) => `${page.sourceId}\0${page.sourceHash}`).sort().join("\n"),
);

export type SourceRevalidation = {
  appendedLifecycle: Array<{ sourceId: string; sourceHash: string }>;
};

type SourceIdentity = { sourceId: string; sourceHash: string };
const knowledgeQuarantines = (values: SourceIdentity[]) => new Map(
  values.filter(({ sourceId }) => sourceId.startsWith("filesystem:"))
    .map((value) => [value.sourceId, value.sourceHash]),
);

export function revalidateMigrationSources(input: {
  inventory: TargetPage[];
  reportFingerprint: string;
  freshPages: TargetPage[];
  approvedQuarantined?: SourceIdentity[];
  freshQuarantined?: SourceIdentity[];
}): SourceRevalidation {
  if (inventoryFingerprint(input.inventory) !== input.reportFingerprint) {
    throw new Error("migration_inventory_fingerprint_invalid");
  }
  const fresh = new Map(input.freshPages.map((page) => [page.sourceId, page]));
  const approved = new Map(input.inventory.map((page) => [page.sourceId, page]));
  for (const page of input.inventory) {
    const current = fresh.get(page.sourceId);
    if (!current) throw new Error("migration_source_missing");
    if (current.sourceHash !== page.sourceHash) throw new Error("migration_source_changed");
  }

  const approvedKnowledgeQuarantines = knowledgeQuarantines(input.approvedQuarantined ?? []);
  const freshKnowledgeQuarantines = knowledgeQuarantines(input.freshQuarantined ?? []);
  if (approvedKnowledgeQuarantines.size !== freshKnowledgeQuarantines.size
    || [...approvedKnowledgeQuarantines].some(([sourceId, sourceHash]) =>
      freshKnowledgeQuarantines.get(sourceId) !== sourceHash)) {
    throw new Error("markdown_source_changed");
  }

  const appendedLifecycle: Array<{ sourceId: string; sourceHash: string }> = [];
  for (const page of input.freshPages) {
    if (approved.has(page.sourceId)) continue;
    if (page.kind === "knowledge") throw new Error("markdown_source_changed");
    appendedLifecycle.push({ sourceId: page.sourceId, sourceHash: page.sourceHash });
  }
  return { appendedLifecycle: appendedLifecycle.sort((left, right) => left.sourceId.localeCompare(right.sourceId)) };
}

export type ApplySourceDelta = {
  schemaVersion: 1;
  artifactType: "bookstack-apply-source-delta";
  runId: string;
  appended: Array<{ sourceId: string; sourceHash: string }>;
  appendedCount: number;
  truncated: boolean;
};

export function buildApplySourceDelta(runId: string, appended: SourceRevalidation["appendedLifecycle"]): ApplySourceDelta {
  const sorted = [...appended].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return {
    schemaVersion: 1,
    artifactType: "bookstack-apply-source-delta",
    runId,
    appended: sorted.slice(0, MAX_APPENDED_LIFECYCLE),
    appendedCount: sorted.length,
    truncated: sorted.length > MAX_APPENDED_LIFECYCLE,
  };
}

export function parseApplySourceDelta(value: unknown): ApplySourceDelta | null {
  if (!isObject(value)
    || Object.keys(value).sort().join("\0") !== ["appended", "appendedCount", "artifactType", "runId", "schemaVersion", "truncated"].join("\0")
    || value.schemaVersion !== 1 || value.artifactType !== "bookstack-apply-source-delta") return null;
  if (typeof value.runId !== "string" || !value.runId || value.runId.length > 128 || /[\x00-\x1f\x7f]/.test(value.runId)
    || !Array.isArray(value.appended)
    || !Number.isSafeInteger(value.appendedCount) || (value.appendedCount as number) < value.appended.length
    || typeof value.truncated !== "boolean" || value.appended.length > MAX_APPENDED_LIFECYCLE) return null;
  const appended = value.appended.flatMap((entry) => isObject(entry)
    && Object.keys(entry).sort().join("\0") === "sourceHash\0sourceId"
    && typeof entry.sourceId === "string" && entry.sourceId.length > 0 && entry.sourceId.length <= 512
    && !/[\x00-\x1f\x7f]/.test(entry.sourceId)
    && typeof entry.sourceHash === "string" && SHA256.test(entry.sourceHash)
    ? [{ sourceId: entry.sourceId, sourceHash: entry.sourceHash }]
    : []);
  if (appended.length !== value.appended.length) return null;
  if (value.truncated !== ((value.appendedCount as number) > appended.length)) return null;
  if (appended.some((entry, index) => index > 0 && appended[index - 1].sourceId >= entry.sourceId)) return null;
  return {
    schemaVersion: 1,
    artifactType: "bookstack-apply-source-delta",
    runId: value.runId,
    appended,
    appendedCount: value.appendedCount as number,
    truncated: value.truncated,
  };
}

export type PreflightCheck = { name: string; status: "PASS" | "FAIL" | "BLOCKED"; code?: string };
export type ApplyPreflightReport = {
  schemaVersion: 1;
  artifactType: "bookstack-apply-preflight";
  runId: string;
  outcome: "PASS" | "FAIL" | "BLOCKED";
  checks: PreflightCheck[];
};

export const boundedErrorCode = (error: unknown) => {
  const code = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]{1,128}$/.test(code) ? code : "preflight_failed";
};

export const preflightFailureStatus = (code: string): "FAIL" | "BLOCKED" =>
  /(?:_required$|transport|timeout|qdrant_scroll_failed|http_429|http_5\d\d)/.test(code)
    ? "BLOCKED"
    : "FAIL";

export function buildApplyPreflightReport(runId: string, checks: PreflightCheck[]): ApplyPreflightReport {
  const outcome = checks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : checks.some((check) => check.status === "BLOCKED") ? "BLOCKED" : "PASS";
  return { schemaVersion: 1, artifactType: "bookstack-apply-preflight", runId, outcome, checks: [...checks] };
}
