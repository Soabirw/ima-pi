import {
  MAX_PAYLOAD_BYTES,
  normalizeInstitutionalManifest,
  normalizeInstitutionalRecord,
  utf8ByteLength,
  type InstitutionalManifest,
  type InstitutionalRecord,
  type InstitutionalRecordInput,
} from "./qdrant-corpus.ts";
import {
  MAX_STORED_ARTIFACT_BYTES,
  hasUnpairedSurrogate,
  hashDetail,
} from "./qdrant-corpus-chunks.ts";
import { normalizeSourceReferences } from "./qdrant-corpus-contract.ts";
import { redactSecrets, summarizeInstitutionalDetail } from "./vestige-migrate-content.ts";
import type { ExportedVestigeMemory, QuarantineReason } from "./vestige-migrate.ts";

const MAX_UTF8_CODE_POINT_BYTES = 4;
export const MAX_SOURCE_BUNDLE_RECORDS = 512;

export type InstitutionalExpectation = {
  id: string;
  recordKey: string;
  project: string;
  site: string;
  repo: string;
  lifecycleKey: string;
  phase: string;
  summary: string;
  detail: string;
  sourceRefs: string[];
  contentHash: string;
  createdAt: string;
};

export type DestinationRecordRole = "single" | "part" | "index";
export type MigrationRecordCandidate = {
  role: DestinationRecordRole;
  partIndex?: number;
  partCount?: number;
  record: InstitutionalRecordInput;
  expected: InstitutionalExpectation;
};

export type MigrationSourceCandidate = {
  vestigeId: string;
  createdAt: string;
  sourceHash: string;
  sourceBytes: number;
  records: MigrationRecordCandidate[];
  wasRedacted: boolean;
};

export type InstitutionalMetadata = {
  project: string;
  lifecycleKey: string;
  phase: string;
  recordKey: string;
  sourceRefs: string[];
};

const utf8CodePointBytes = (codePoint: number) => codePoint <= 0x7f
  ? 1
  : codePoint <= 0x7ff
    ? 2
    : codePoint <= 0xffff
      ? 3
      : 4;

const expectationFromRecord = (record: InstitutionalRecord): InstitutionalExpectation => {
  const payload = record.payload;
  return {
    id: record.id,
    recordKey: record.recordKey,
    project: payload.project,
    site: payload.site,
    repo: payload.repo,
    lifecycleKey: payload.lifecycle_key,
    phase: payload.phase,
    summary: payload.summary,
    detail: payload.detail,
    sourceRefs: [...payload.source_refs],
    contentHash: payload.content_hash,
    createdAt: payload.created_at,
  };
};

const expectationFromManifest = (
  manifest: InstitutionalManifest,
  detail: string,
): InstitutionalExpectation => {
  const payload = manifest.payload;
  return {
    id: manifest.id,
    recordKey: manifest.recordKey,
    project: payload.project,
    site: payload.site,
    repo: payload.repo,
    lifecycleKey: payload.lifecycle_key,
    phase: payload.phase,
    summary: payload.summary,
    detail,
    sourceRefs: [...payload.source_refs],
    contentHash: payload.content_hash,
    createdAt: payload.created_at,
  };
};

const normalizedCandidate = (input: {
  role: DestinationRecordRole;
  partIndex?: number;
  partCount?: number;
  record: InstitutionalRecordInput;
  createdAt: string;
}): MigrationRecordCandidate | null => {
  const v1 = normalizeInstitutionalRecord(input.record, input.createdAt);
  const expected = v1.success
    ? expectationFromRecord(v1.data)
    : v1.error.code === "record_too_large"
      ? (() => {
        const v2 = normalizeInstitutionalManifest(input.record, input.createdAt);
        return v2.success ? expectationFromManifest(v2.data, input.record.detail) : null;
      })()
      : null;
  if (!expected) return null;
  return {
    role: input.role,
    ...(input.partIndex === undefined ? {} : { partIndex: input.partIndex }),
    ...(input.partCount === undefined ? {} : { partCount: input.partCount }),
    record: {
      recordKey: expected.recordKey,
      project: expected.project,
      site: expected.site,
      repo: expected.repo,
      lifecycleKey: expected.lifecycleKey,
      phase: expected.phase,
      summary: expected.summary,
      detail: expected.detail,
      sourceRefs: [...expected.sourceRefs],
    },
    expected,
  };
};

const sourceRecord = (input: {
  metadata: InstitutionalMetadata;
  summary: string;
  detail: string;
  sourceId: string;
  recordKey: string;
}): InstitutionalRecordInput | null => {
  const sourceRefs = normalizeSourceReferences([
    ...input.metadata.sourceRefs,
    `vestige:${input.sourceId}`,
  ]);
  return sourceRefs
    ? {
      recordKey: input.recordKey,
      project: input.metadata.project,
      site: "",
      repo: "",
      lifecycleKey: input.metadata.lifecycleKey,
      phase: input.metadata.phase,
      summary: input.summary,
      detail: input.detail,
      sourceRefs,
    }
    : null;
};

const partKey = (baseRecordKey: string, index: number) =>
  `${baseRecordKey}:part:${String(index).padStart(4, "0")}`;

export const sourceBundleIndexDetail = (input: {
  sourceHash: string;
  sourceBytes: number;
  partKeys: string[];
}) => JSON.stringify({
  schemaVersion: 1,
  layout: "vestige-source-bundle",
  sourceHash: input.sourceHash,
  sourceBytes: input.sourceBytes,
  partCount: input.partKeys.length,
  partKeys: input.partKeys,
});

export function splitVestigeSource(detail: string): string[] | null {
  if (!detail || detail.includes("\0") || hasUnpairedSurrogate(detail)) return null;
  const sourceBytes = utf8ByteLength(detail);
  if (sourceBytes <= MAX_STORED_ARTIFACT_BYTES) return [detail];

  const usablePartBytes = MAX_STORED_ARTIFACT_BYTES - (MAX_UTF8_CODE_POINT_BYTES - 1);
  const partCount = Math.ceil(sourceBytes / usablePartBytes);
  if (partCount + 1 > MAX_SOURCE_BUNDLE_RECORDS) return null;
  const targetBytes = Math.min(
    MAX_STORED_ARTIFACT_BYTES,
    Math.ceil(sourceBytes / partCount) + (MAX_UTF8_CODE_POINT_BYTES - 1),
  );
  const parts: string[] = [];
  let start = 0;
  let currentBytes = 0;

  for (let index = 0; index < detail.length;) {
    const codePoint = detail.codePointAt(index);
    if (codePoint === undefined) return null;
    const characterBytes = utf8CodePointBytes(codePoint);
    if (currentBytes > 0 && currentBytes + characterBytes > targetBytes) {
      parts.push(detail.slice(start, index));
      start = index;
      currentBytes = 0;
    }
    currentBytes += characterBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (start < detail.length) parts.push(detail.slice(start));

  return parts.length === partCount
    && parts.every((part) => utf8ByteLength(part) <= MAX_STORED_ARTIFACT_BYTES)
    && parts.every((part) => utf8ByteLength(part) > MAX_PAYLOAD_BYTES)
    ? parts
    : null;
}

const sourceCandidate = (input: {
  source: ExportedVestigeMemory;
  records: MigrationRecordCandidate[];
  redacted: boolean;
  detail: string;
}): MigrationSourceCandidate => ({
  vestigeId: input.source.id,
  createdAt: input.source.createdAt,
  sourceHash: hashDetail(input.detail),
  sourceBytes: utf8ByteLength(input.detail),
  records: input.records,
  wasRedacted: input.redacted,
});

export const candidateFor = (input: {
  source: ExportedVestigeMemory;
  metadata: InstitutionalMetadata;
}): { source: MigrationSourceCandidate } | { quarantine: QuarantineReason } => {
  const { source, metadata } = input;
  if (source.content.includes("\0") || hasUnpairedSurrogate(source.content)) {
    return { quarantine: "record_invalid" };
  }

  const redacted = redactSecrets(source.content);
  const summary = summarizeInstitutionalDetail(redacted.text);
  if (!summary) return { quarantine: "summary_invalid" };
  const parts = splitVestigeSource(redacted.text);
  if (!parts) return { quarantine: "record_too_large" };

  if (parts.length === 1) {
    const record = sourceRecord({
      metadata,
      summary,
      detail: parts[0],
      sourceId: source.id,
      recordKey: metadata.recordKey,
    });
    const single = record
      ? normalizedCandidate({ role: "single", record, createdAt: source.createdAt })
      : null;
    return single
      ? { source: sourceCandidate({
        source,
        records: [single],
        redacted: redacted.text !== source.content,
        detail: single.expected.detail,
      }) }
      : { quarantine: "record_invalid" };
  }

  const partCandidates: Array<MigrationRecordCandidate | null> = [];
  for (const [index, detail] of parts.entries()) {
    const record = sourceRecord({
      metadata,
      summary,
      detail,
      sourceId: source.id,
      recordKey: partKey(metadata.recordKey, index + 1),
    });
    partCandidates.push(record
      ? normalizedCandidate({
        role: "part",
        partIndex: index + 1,
        partCount: parts.length,
        record,
        createdAt: source.createdAt,
      })
      : null);
  }
  if (partCandidates.some((candidate) => candidate === null)) return { quarantine: "record_invalid" };

  const completeParts = partCandidates as MigrationRecordCandidate[];
  const sourceDetail = completeParts.map((candidate) => candidate.expected.detail).join("");
  const sourceHash = hashDetail(sourceDetail);
  const sourceBytes = utf8ByteLength(sourceDetail);
  const indexRecord = sourceRecord({
    metadata,
    summary: `Vestige source bundle ${source.id} (${completeParts.length} parts)`,
    detail: sourceBundleIndexDetail({
      sourceHash,
      sourceBytes,
      partKeys: completeParts.map((candidate) => candidate.expected.recordKey),
    }),
    sourceId: source.id,
    recordKey: `${metadata.recordKey}:bundle`,
  });
  const index = indexRecord
    ? normalizedCandidate({
      role: "index",
      partCount: completeParts.length,
      record: indexRecord,
      createdAt: source.createdAt,
    })
    : null;
  return index
    ? { source: {
      vestigeId: source.id,
      createdAt: source.createdAt,
      sourceHash,
      sourceBytes,
      records: [...completeParts, index],
      wasRedacted: redacted.text !== source.content,
    } }
    : { quarantine: "record_invalid" };
};
