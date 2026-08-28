import {
  storeLogicalInstitutionalRecord,
  utf8ByteLength,
} from "./qdrant-corpus.ts";
import { hashDetail } from "./qdrant-corpus-chunks.ts";
import type { QdrantCorpusClient } from "./qdrant-http.ts";
import {
  sourceBundleIndexDetail,
  type InstitutionalExpectation,
  type MigrationRecordCandidate,
  type MigrationSourceCandidate,
} from "./vestige-migrate.ts";
import {
  cleanupDestinationIsVerified,
  deriveSourceStatus,
  institutionalExpectationMatches,
  sourceDestinationOutcome,
  type DestinationRecordOutcome,
  type ImportReason,
  type MigrationSourceOutcome,
} from "./vestige-migrate-report.ts";
import type { CleanupRetentionReason } from "./vestige-cleanup-report.ts";

const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

const importReason = (code: string): ImportReason =>
  code === "qdrant_unavailable" ? "qdrant_unavailable" : "store_failed";

const verificationFailure = (code: string): ImportReason =>
  code === "qdrant_unavailable" ? "qdrant_unavailable" : "verification_failed";

export async function verifyInstitutionalRecord(input: {
  expectation: InstitutionalExpectation;
  client: QdrantCorpusClient;
  signal?: AbortSignal;
}): Promise<{ verified: true } | { verified: false; reason: ImportReason }> {
  try {
    throwIfAborted(input.signal);
    const full = await input.client.getInstitutional(input.expectation.recordKey, input.signal);
    throwIfAborted(input.signal);
    if (!full.success) return { verified: false, reason: verificationFailure(full.error.code) };
    return institutionalExpectationMatches(input.expectation, full.data)
      ? { verified: true }
      : { verified: false, reason: "qdrant_response_invalid" };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { verified: false, reason: "qdrant_unavailable" };
  }
}

const importMigrationRecord = async (input: {
  sourceId: string;
  candidate: MigrationRecordCandidate;
  client: QdrantCorpusClient;
  signal?: AbortSignal;
}): Promise<DestinationRecordOutcome> => {
  let stored: Awaited<ReturnType<typeof storeLogicalInstitutionalRecord>>;
  try {
    throwIfAborted(input.signal);
    stored = await storeLogicalInstitutionalRecord({
      record: input.candidate.record,
      createdAt: input.candidate.expected.createdAt,
      operations: input.client,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return sourceDestinationOutcome(input.sourceId, input.candidate, "failed", "qdrant_unavailable");
  }

  if (!stored.success) {
    return stored.error.code === "record_conflict"
      ? sourceDestinationOutcome(input.sourceId, input.candidate, "record_conflict")
      : sourceDestinationOutcome(input.sourceId, input.candidate, "failed", importReason(stored.error.code));
  }

  const verification = await verifyInstitutionalRecord({
    expectation: input.candidate.expected,
    client: input.client,
    signal: input.signal,
  });
  return verification.verified
    ? sourceDestinationOutcome(
      input.sourceId,
      input.candidate,
      stored.data.status === "stored" ? "migrated" : "unchanged",
    )
    : sourceDestinationOutcome(input.sourceId, input.candidate, "unverified", verification.reason);
};

const completedRecord = (outcome: DestinationRecordOutcome) =>
  outcome.status === "migrated" || outcome.status === "unchanged";

export async function importMigrationSource(input: {
  source: MigrationSourceCandidate;
  client: QdrantCorpusClient;
  signal?: AbortSignal;
}): Promise<MigrationSourceOutcome> {
  const records: DestinationRecordOutcome[] = [];
  let dependencyBlocked = false;
  for (const candidate of input.source.records) {
    if (dependencyBlocked) {
      records.push(sourceDestinationOutcome(
        input.source.vestigeId,
        candidate,
        "failed",
        "dependency_blocked",
      ));
      continue;
    }
    const outcome = await importMigrationRecord({
      sourceId: input.source.vestigeId,
      candidate,
      client: input.client,
      signal: input.signal,
    });
    records.push(outcome);
    dependencyBlocked = !completedRecord(outcome);
  }
  return {
    vestigeId: input.source.vestigeId,
    sourceHash: input.source.sourceHash,
    sourceBytes: input.source.sourceBytes,
    status: deriveSourceStatus(records),
    records,
  };
}

export const failedMigrationSourceOutcome = (
  source: MigrationSourceCandidate,
  reason: "dependency_blocked" = "dependency_blocked",
): MigrationSourceOutcome => {
  const records = source.records.map((candidate) =>
    sourceDestinationOutcome(source.vestigeId, candidate, "failed", reason),
  );
  return {
    vestigeId: source.vestigeId,
    sourceHash: source.sourceHash,
    sourceBytes: source.sourceBytes,
    status: deriveSourceStatus(records),
    records,
  };
};

const cleanupRecord = async (input: {
  outcome: DestinationRecordOutcome;
  client: QdrantCorpusClient;
  signal?: AbortSignal;
}): Promise<
  | { verified: true; detail: string }
  | { verified: false; reason: CleanupRetentionReason }
> => {
  try {
    throwIfAborted(input.signal);
    const record = await input.client.getInstitutional(input.outcome.recordKey, input.signal);
    throwIfAborted(input.signal);
    if (!record.success) {
      return {
        verified: false,
        reason: record.error.code === "qdrant_unavailable" ? "qdrant_unavailable" : "qdrant_unverified",
      };
    }
    return cleanupDestinationIsVerified(input.outcome, record.data) && typeof record.data.detail === "string"
      ? { verified: true, detail: record.data.detail }
      : { verified: false, reason: "qdrant_unverified" };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { verified: false, reason: "qdrant_unavailable" };
  }
};

export async function verifyMigrationSourceForCleanup(input: {
  source: MigrationSourceOutcome;
  client: QdrantCorpusClient;
  signal?: AbortSignal;
}): Promise<CleanupRetentionReason | null> {
  const details: string[] = [];
  for (const outcome of input.source.records) {
    const verification = await cleanupRecord({
      outcome,
      client: input.client,
      signal: input.signal,
    });
    if (!verification.verified) return verification.reason;
    details.push(verification.detail);
  }

  if (input.source.records.length === 1) {
    return hashDetail(details[0]) === input.source.sourceHash
      && utf8ByteLength(details[0]) === input.source.sourceBytes
      ? null
      : "qdrant_unverified";
  }

  const parts = input.source.records.slice(0, -1);
  const index = input.source.records.at(-1);
  if (!index || index.role !== "index") return "qdrant_unverified";
  const sourceDetail = details.slice(0, -1).join("");
  const expectedIndex = sourceBundleIndexDetail({
    sourceHash: input.source.sourceHash,
    sourceBytes: input.source.sourceBytes,
    partKeys: parts.map((part) => part.recordKey),
  });
  return hashDetail(sourceDetail) === input.source.sourceHash
    && utf8ByteLength(sourceDetail) === input.source.sourceBytes
    && details.at(-1) === expectedIndex
    ? null
    : "qdrant_unverified";
}
