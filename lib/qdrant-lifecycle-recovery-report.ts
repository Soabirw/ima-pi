import { createHash } from "node:crypto";
import {
  compareCodeUnits,
  MAX_SOURCE_REFERENCES,
  normalizeInstitutionalRecord,
  utf8ByteLength,
} from "./qdrant-corpus.ts";
import {
  normalizeInstitutionalManifest,
  normalizeInstitutionalManifestPoint,
  reassembleInstitutionalManifest,
} from "./qdrant-corpus-manifest.ts";
import {
  DETAIL_CHUNK_RECORD_KIND,
  MANIFEST_RECORD_KIND,
  MAX_DETAIL_CHUNK_COUNT,
} from "./qdrant-corpus-chunks.ts";
import { normalizeLifecycleRecordKey } from "./ima-lifecycle.ts";
import {
  projectQdrantLifecycleReference,
  type QdrantLifecycleReference,
} from "./qdrant-lifecycle-record.ts";

export const QDRANT_LIFECYCLE_RECOVERY_SCHEMA_VERSION = 1;
export const QDRANT_LIFECYCLE_RECOVERY_REPORT_TYPE = "qdrant-lifecycle-recovery-report";
export const QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_TYPE = "qdrant-lifecycle-recovery-archive";
export const MAX_QDRANT_LIFECYCLE_RECOVERY_RECORDS = 50;
export const MAX_QDRANT_LIFECYCLE_RECOVERY_POINTS = MAX_QDRANT_LIFECYCLE_RECOVERY_RECORDS
  * (MAX_DETAIL_CHUNK_COUNT + 1);
export const MAX_QDRANT_LIFECYCLE_RECOVERY_REPORT_BYTES = 128 * 1024;
export const MAX_QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_BYTES = 64 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECOVERY_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SNAPSHOT_NAME = /^[A-Za-z0-9._-]{1,255}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const V1_PAYLOAD_FIELDS = [
  "schema_version",
  "record_key",
  "project",
  "site",
  "repo",
  "lifecycle_key",
  "phase",
  "summary",
  "detail",
  "source_refs",
  "content_hash",
  "created_at",
] as const;
const MANIFEST_PAYLOAD_FIELDS = [
  "schema_version",
  "record_kind",
  "record_key",
  "project",
  "site",
  "repo",
  "lifecycle_key",
  "phase",
  "summary",
  "detail_hash",
  "detail_bytes",
  "chunk_count",
  "source_refs",
  "content_hash",
  "created_at",
] as const;
const CHUNK_PAYLOAD_FIELDS = [
  "schema_version",
  "record_kind",
  "parent_record_key",
  "chunk_index",
  "chunk_count",
  "chunk_hash",
  "detail_chunk",
] as const;
const PIN_FIELDS = [
  "schemaVersion",
  "lifecycleKey",
  "provider",
  "initialReference",
  "artifactId",
  "recordKey",
  "pinnedAt",
] as const;
const INVENTORY_FIELDS = ["schemaVersion", "lifecycleKey", "records"] as const;
const INVENTORY_RECORD_FIELDS = [
  "storageSchemaVersion",
  "recordKey",
  "contentHash",
  "points",
] as const;
const POINT_FIELDS = ["id", "payload"] as const;
const INVENTORY_SUMMARY_FIELDS = [
  "lifecycleKey",
  "fingerprint",
  "recordCount",
  "pointCount",
  "records",
] as const;
const INVENTORY_SUMMARY_RECORD_FIELDS = [
  "storageSchemaVersion",
  "recordKey",
  "contentHash",
  "pointFingerprint",
  "pointIds",
] as const;
const ARCHIVE_FIELDS = [
  "schemaVersion",
  "artifactType",
  "lifecycleKey",
  "inventoryFingerprint",
  "records",
] as const;
const REPORT_FIELDS = [
  "schemaVersion",
  "artifactType",
  "lifecycleKey",
  "createdAt",
  "attemptId",
  "expectedPin",
  "expectedPinFingerprint",
  "archive",
  "inventory",
] as const;
const ARCHIVE_RECEIPT_FIELDS = ["name", "sizeBytes", "sha256"] as const;
const CHECKPOINT_BASE_FIELDS = [
  "schemaVersion",
  "lifecycleKey",
  "attemptId",
  "reportHash",
  "inventoryFingerprint",
  "expectedPinFingerprint",
  "stage",
  "startedAt",
] as const;
const CHECKPOINT_SNAPSHOT_FIELDS = [...CHECKPOINT_BASE_FIELDS, "snapshotName"] as const;
const ABSENCE_PROOF_FIELDS = [
  "schemaVersion",
  "lifecycleKey",
  "attemptId",
  "reportHash",
  "inventoryFingerprint",
  "expectedPinFingerprint",
  "expectedPointCount",
  "expectedParentCount",
  "verifiedAt",
] as const;

export type QdrantLifecycleRecoveryPoint = {
  id: string;
  payload: Record<string, unknown>;
};

export type QdrantLifecycleRecoveryInventoryRecord = {
  storageSchemaVersion: 1 | 2;
  recordKey: string;
  contentHash: string;
  points: QdrantLifecycleRecoveryPoint[];
};

export type QdrantLifecycleRecoveryInventory = {
  schemaVersion: 1;
  lifecycleKey: string;
  records: QdrantLifecycleRecoveryInventoryRecord[];
};

export type QdrantLifecycleRecoveryInventorySummaryRecord = {
  storageSchemaVersion: 1 | 2;
  recordKey: string;
  contentHash: string;
  pointFingerprint: string;
  pointIds: string[];
};

export type QdrantLifecycleRecoveryInventorySummary = {
  lifecycleKey: string;
  fingerprint: string;
  recordCount: number;
  pointCount: number;
  records: QdrantLifecycleRecoveryInventorySummaryRecord[];
};

export type QdrantLifecycleRecoveryArchive = {
  schemaVersion: 1;
  artifactType: "qdrant-lifecycle-recovery-archive";
  lifecycleKey: string;
  inventoryFingerprint: string;
  records: QdrantLifecycleRecoveryInventoryRecord[];
};

export type QdrantLifecycleRecoveryExpectedPin = {
  schemaVersion: 1;
  lifecycleKey: string;
  provider: "qdrant";
  initialReference: QdrantLifecycleReference;
  artifactId: string;
  recordKey: string;
  pinnedAt: string;
};

export type QdrantLifecycleRecoveryArchiveReceipt = {
  name: string;
  sizeBytes: number;
  sha256: string;
};

export type QdrantLifecycleRecoveryReport = {
  schemaVersion: 1;
  artifactType: "qdrant-lifecycle-recovery-report";
  lifecycleKey: string;
  createdAt: string;
  attemptId: string;
  expectedPin: QdrantLifecycleRecoveryExpectedPin;
  expectedPinFingerprint: string;
  archive: QdrantLifecycleRecoveryArchiveReceipt;
  inventory: QdrantLifecycleRecoveryInventorySummary;
};

export type QdrantLifecycleRecoveryStage =
  | "prepared"
  | "snapshot_started"
  | "snapshot_verified"
  | "deletion_started";

export type QdrantLifecycleRecoveryCheckpoint = {
  schemaVersion: 1;
  lifecycleKey: string;
  attemptId: string;
  reportHash: string;
  inventoryFingerprint: string;
  expectedPinFingerprint: string;
  stage: QdrantLifecycleRecoveryStage;
  startedAt: string;
  snapshotName?: string;
};

export type QdrantLifecycleRecoveryAbsenceProof = {
  schemaVersion: 1;
  lifecycleKey: string;
  attemptId: string;
  reportHash: string;
  inventoryFingerprint: string;
  expectedPinFingerprint: string;
  expectedPointCount: number;
  expectedParentCount: number;
  verifiedAt: string;
};

const ownDataRecord = (
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length !== fields.length
      || !fields.every((field) => keys.includes(field))
      || keys.some((key) => {
        const descriptor = descriptors[key as string];
        return !descriptor
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value");
      })
    ) return null;
    return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
  } catch {
    return null;
  }
};

const ownDataArray = (
  value: unknown,
  minimum: number,
  maximum: number,
): unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length)
      || length < minimum
      || length > maximum
      || keys.length !== length + 1
      || keys.some((key) => typeof key !== "string")
      || keys.some((key) => key !== "length" && !/^\d+$/.test(key as string))
      || !descriptors.length
      || descriptors.length.get
      || descriptors.length.set
      || !Object.hasOwn(descriptors.length, "value")
    ) return null;
    const entries: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.get
        || descriptor.set
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) return null;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
};

const canonicalText = (
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): string | null => typeof value === "string"
  && value === value.trim()
  && (allowEmpty || value.length > 0)
  && !CONTROL_CHARACTER.test(value)
  && utf8ByteLength(value) <= maximumBytes
  ? value
  : null;

const canonicalLifecycleKey = (value: unknown): string | null => {
  const key = normalizeLifecycleRecordKey(value);
  return key && key === value ? key : null;
};

const canonicalUuid = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;

const canonicalRecoveryAttemptId = (value: unknown): string | null =>
  typeof value === "string" && RECOVERY_ATTEMPT_ID.test(value) ? value.toLowerCase() : null;

const canonicalHash = (value: unknown): string | null =>
  typeof value === "string" && HASH.test(value) ? value : null;

const canonicalTimestamp = (value: unknown): string | null => {
  const timestamp = canonicalText(value, 64);
  return timestamp && TIMESTAMP.test(timestamp) && !Number.isNaN(Date.parse(timestamp))
    ? timestamp
    : null;
};

const dataStringArray = (value: unknown, maximum: number): string[] | null => {
  const values = ownDataArray(value, 0, maximum);
  return values && values.every((entry) => typeof entry === "string")
    ? [...values] as string[]
    : null;
};

const sameTextArray = (left: readonly unknown[], right: readonly string[]) =>
  left.length === right.length
  && left.every((value, index) => value === right[index]);

const clonePoint = (point: { id: string; payload: Record<string, unknown> }) => ({
  id: point.id,
  payload: Object.fromEntries(Object.entries(point.payload).map(([key, value]) => [
    key,
    Array.isArray(value) ? [...value] : value,
  ])),
});

const samePayload = (
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  fields: readonly string[],
) => fields.every((field) => {
  const left = actual[field];
  const right = expected[field];
  return Array.isArray(left) && Array.isArray(right)
    ? sameTextArray(left, right as string[])
    : left === right;
});

const projectPoint = (value: unknown): { id: string; payload: Record<string, unknown> } | null => {
  const point = ownDataRecord(value, POINT_FIELDS);
  const id = canonicalUuid(point?.id);
  const payload = point ? point.payload : null;
  return id && payload && typeof payload === "object" && !Array.isArray(payload)
    ? { id, payload }
    : null;
};

const projectV1Record = (
  value: Record<string, unknown>,
  lifecycleKey: string,
): QdrantLifecycleRecoveryInventoryRecord | null => {
  const record = ownDataRecord(value, INVENTORY_RECORD_FIELDS);
  const points = ownDataArray(record?.points, 1, 1);
  if (!record || record.storageSchemaVersion !== 1 || !points) return null;

  const point = projectPoint(points[0]);
  const payload = point ? ownDataRecord(point.payload, V1_PAYLOAD_FIELDS) : null;
  if (!point || !payload || payload.schema_version !== 1 || payload.lifecycle_key !== lifecycleKey) {
    return null;
  }
  const sourceRefs = dataStringArray(payload.source_refs, MAX_SOURCE_REFERENCES);
  if (!sourceRefs) return null;
  const safePayload = { ...payload, source_refs: sourceRefs };
  const normalized = normalizeInstitutionalRecord({
    recordKey: safePayload.record_key,
    project: safePayload.project,
    site: safePayload.site,
    repo: safePayload.repo,
    lifecycleKey: safePayload.lifecycle_key,
    phase: safePayload.phase,
    summary: safePayload.summary,
    detail: safePayload.detail,
    sourceRefs,
  }, safePayload.created_at);
  if (
    !normalized.success
    || point.id !== normalized.data.id
    || !samePayload(safePayload, normalized.data.payload, V1_PAYLOAD_FIELDS)
    || record.recordKey !== normalized.data.recordKey
    || record.contentHash !== normalized.data.payload.content_hash
  ) return null;

  return {
    storageSchemaVersion: 1,
    recordKey: normalized.data.recordKey,
    contentHash: normalized.data.payload.content_hash,
    points: [clonePoint({ id: normalized.data.id, payload: normalized.data.payload })],
  };
};

const projectChunkPoint = (
  value: unknown,
): { id: string; payload: Record<string, unknown> } | null => {
  const point = projectPoint(value);
  const payload = point ? ownDataRecord(point.payload, CHUNK_PAYLOAD_FIELDS) : null;
  if (
    !point
    || !payload
    || payload.schema_version !== 2
    || payload.record_kind !== DETAIL_CHUNK_RECORD_KIND
  ) return null;
  return { id: point.id, payload };
};

const projectV2Record = (
  value: Record<string, unknown>,
  lifecycleKey: string,
): QdrantLifecycleRecoveryInventoryRecord | null => {
  const record = ownDataRecord(value, INVENTORY_RECORD_FIELDS);
  const points = ownDataArray(record?.points, 2, MAX_DETAIL_CHUNK_COUNT + 1);
  if (!record || record.storageSchemaVersion !== 2 || !points) return null;

  const manifestPoint = projectPoint(points[0]);
  const manifestPayload = manifestPoint
    ? ownDataRecord(manifestPoint.payload, MANIFEST_PAYLOAD_FIELDS)
    : null;
  if (
    !manifestPoint
    || !manifestPayload
    || manifestPayload.schema_version !== 2
    || manifestPayload.record_kind !== MANIFEST_RECORD_KIND
    || manifestPayload.lifecycle_key !== lifecycleKey
  ) return null;

  const manifestSourceRefs = dataStringArray(
    manifestPayload.source_refs,
    MAX_SOURCE_REFERENCES,
  );
  if (!manifestSourceRefs) return null;
  const safeManifestPayload = { ...manifestPayload, source_refs: manifestSourceRefs };
  const manifest = normalizeInstitutionalManifestPoint({
    id: manifestPoint.id,
    payload: safeManifestPayload,
  });
  if (
    !manifest.success
    || !samePayload(safeManifestPayload, manifest.data.payload, MANIFEST_PAYLOAD_FIELDS)
    || points.length !== manifest.data.payload.chunk_count + 1
  ) return null;

  const chunks = points.slice(1).map(projectChunkPoint);
  if (chunks.some((chunk) => chunk === null)) return null;
  const canonicalChunks = chunks as Array<{ id: string; payload: Record<string, unknown> }>;
  const reassembled = reassembleInstitutionalManifest({
    manifestPoint: { id: manifestPoint.id, payload: safeManifestPayload },
    chunkPoints: canonicalChunks,
  });
  if (!reassembled.success || reassembled.data.id !== manifest.data.id) return null;

  const sourceRefs = dataStringArray(
    reassembled.data.payload.source_refs,
    MAX_SOURCE_REFERENCES,
  );
  if (!sourceRefs) return null;
  const rebuilt = normalizeInstitutionalManifest({
    recordKey: reassembled.data.recordKey,
    project: reassembled.data.payload.project,
    site: reassembled.data.payload.site,
    repo: reassembled.data.payload.repo,
    lifecycleKey: reassembled.data.payload.lifecycle_key,
    phase: reassembled.data.payload.phase,
    summary: reassembled.data.payload.summary,
    detail: reassembled.data.detail,
    sourceRefs,
  }, reassembled.data.payload.created_at);
  if (
    !rebuilt.success
    || rebuilt.data.id !== manifest.data.id
    || rebuilt.data.recordKey !== manifest.data.recordKey
    || rebuilt.data.payload.content_hash !== manifest.data.payload.content_hash
    || !samePayload(safeManifestPayload, rebuilt.data.payload, MANIFEST_PAYLOAD_FIELDS)
    || rebuilt.data.chunks.length !== canonicalChunks.length
    || !rebuilt.data.chunks.every((chunk, index) => {
      const observed = canonicalChunks[index];
      return observed.id === chunk.id
        && samePayload(observed.payload, chunk.payload, CHUNK_PAYLOAD_FIELDS);
    })
    || record.recordKey !== rebuilt.data.recordKey
    || record.contentHash !== rebuilt.data.payload.content_hash
  ) return null;

  return {
    storageSchemaVersion: 2,
    recordKey: rebuilt.data.recordKey,
    contentHash: rebuilt.data.payload.content_hash,
    points: [
      clonePoint({ id: rebuilt.data.id, payload: rebuilt.data.payload }),
      ...rebuilt.data.chunks.map((chunk) => clonePoint({ id: chunk.id, payload: chunk.payload })),
    ],
  };
};

const projectInventoryRecords = (
  value: unknown,
  lifecycleKey: string,
): QdrantLifecycleRecoveryInventoryRecord[] | null => {
  const records = ownDataArray(value, 0, MAX_QDRANT_LIFECYCLE_RECOVERY_RECORDS);
  if (!records) return null;

  const projected = records.map((entry) => {
    const record = ownDataRecord(entry, INVENTORY_RECORD_FIELDS);
    return record?.storageSchemaVersion === 1
      ? projectV1Record(record, lifecycleKey)
      : record?.storageSchemaVersion === 2
        ? projectV2Record(record, lifecycleKey)
        : null;
  });
  if (projected.some((record) => record === null)) return null;

  const canonical = projected as QdrantLifecycleRecoveryInventoryRecord[];
  const recordKeys = new Set<string>();
  const pointIds = new Set<string>();
  let totalPoints = 0;
  for (const [index, record] of canonical.entries()) {
    if (
      recordKeys.has(record.recordKey)
      || (index > 0 && compareCodeUnits(canonical[index - 1].recordKey, record.recordKey) >= 0)
    ) return null;
    recordKeys.add(record.recordKey);
    for (const point of record.points) {
      if (pointIds.has(point.id)) return null;
      pointIds.add(point.id);
      totalPoints += 1;
    }
  }
  return totalPoints <= MAX_QDRANT_LIFECYCLE_RECOVERY_POINTS
    ? canonical.map((record) => ({
      ...record,
      points: record.points.map(clonePoint),
    }))
    : null;
};

export const projectQdrantLifecycleRecoveryInventory = (
  value: unknown,
): QdrantLifecycleRecoveryInventory | null => {
  const inventory = ownDataRecord(value, INVENTORY_FIELDS);
  const lifecycleKey = canonicalLifecycleKey(inventory?.lifecycleKey);
  const records = lifecycleKey
    ? projectInventoryRecords(inventory?.records, lifecycleKey)
    : null;
  return inventory
    && inventory.schemaVersion === QDRANT_LIFECYCLE_RECOVERY_SCHEMA_VERSION
    && lifecycleKey
    && records
    ? {
      schemaVersion: 1,
      lifecycleKey,
      records,
    }
    : null;
};

export const lifecycleRecoveryPointIds = (
  value: unknown,
): string[] | null => {
  const inventory = projectQdrantLifecycleRecoveryInventory(value);
  return inventory
    ? inventory.records.flatMap((record) => record.points.map((point) => point.id))
    : null;
};

const recordPointFingerprint = (
  points: QdrantLifecycleRecoveryPoint[],
) => createHash("sha256").update(JSON.stringify(points), "utf8").digest("hex");

const inventorySummaryRecords = (
  inventory: QdrantLifecycleRecoveryInventory,
): QdrantLifecycleRecoveryInventorySummaryRecord[] => inventory.records.map((record) => ({
  storageSchemaVersion: record.storageSchemaVersion,
  recordKey: record.recordKey,
  contentHash: record.contentHash,
  pointFingerprint: recordPointFingerprint(record.points),
  pointIds: record.points.map((point) => point.id),
}));

const fingerprintInput = (input: {
  lifecycleKey: string;
  records: QdrantLifecycleRecoveryInventorySummaryRecord[];
}) => ({
  schemaVersion: QDRANT_LIFECYCLE_RECOVERY_SCHEMA_VERSION,
  lifecycleKey: input.lifecycleKey,
  records: input.records.map((record) => ({
    storageSchemaVersion: record.storageSchemaVersion,
    recordKey: record.recordKey,
    contentHash: record.contentHash,
    pointFingerprint: record.pointFingerprint,
    pointIds: [...record.pointIds],
  })),
});

const inventoryFingerprint = (input: {
  lifecycleKey: string;
  records: QdrantLifecycleRecoveryInventorySummaryRecord[];
}) => createHash("sha256")
  .update(JSON.stringify(fingerprintInput(input)), "utf8")
  .digest("hex");

export const summarizeQdrantLifecycleRecoveryInventory = (
  value: unknown,
): QdrantLifecycleRecoveryInventorySummary | null => {
  const inventory = projectQdrantLifecycleRecoveryInventory(value);
  if (!inventory) return null;
  const records = inventorySummaryRecords(inventory);
  const pointCount = records.reduce((total, record) => total + record.pointIds.length, 0);
  return {
    lifecycleKey: inventory.lifecycleKey,
    fingerprint: inventoryFingerprint({ lifecycleKey: inventory.lifecycleKey, records }),
    recordCount: records.length,
    pointCount,
    records: records.map((record) => ({ ...record, pointIds: [...record.pointIds] })),
  };
};

const projectInventorySummaryRecord = (
  value: unknown,
): QdrantLifecycleRecoveryInventorySummaryRecord | null => {
  const record = ownDataRecord(value, INVENTORY_SUMMARY_RECORD_FIELDS);
  const recordKey = canonicalText(record?.recordKey, 512);
  const contentHash = canonicalHash(record?.contentHash);
  const pointFingerprint = canonicalHash(record?.pointFingerprint);
  const pointIds = ownDataArray(record?.pointIds, 1, MAX_DETAIL_CHUNK_COUNT + 1);
  if (
    !record
    || (record.storageSchemaVersion !== 1 && record.storageSchemaVersion !== 2)
    || !recordKey
    || !contentHash
    || !pointFingerprint
    || !pointIds
    || !pointIds.every((id) => canonicalUuid(id))
    || new Set(pointIds as string[]).size !== pointIds.length
    || (record.storageSchemaVersion === 1 && pointIds.length !== 1)
  ) return null;
  return {
    storageSchemaVersion: record.storageSchemaVersion,
    recordKey,
    contentHash,
    pointFingerprint,
    pointIds: [...pointIds] as string[],
  };
};

export const projectQdrantLifecycleRecoveryInventorySummary = (
  value: unknown,
): QdrantLifecycleRecoveryInventorySummary | null => {
  const summary = ownDataRecord(value, INVENTORY_SUMMARY_FIELDS);
  const lifecycleKey = canonicalLifecycleKey(summary?.lifecycleKey);
  const fingerprint = canonicalHash(summary?.fingerprint);
  const records = ownDataArray(summary?.records, 0, MAX_QDRANT_LIFECYCLE_RECOVERY_RECORDS)
    ?.map(projectInventorySummaryRecord) ?? null;
  if (
    !summary
    || !lifecycleKey
    || !fingerprint
    || !records
    || records.some((record) => record === null)
    || !Number.isSafeInteger(summary.recordCount)
    || !Number.isSafeInteger(summary.pointCount)
  ) return null;
  const canonicalRecords = records as QdrantLifecycleRecoveryInventorySummaryRecord[];
  const pointIds = new Set<string>();
  const totalPoints = canonicalRecords.reduce((total, record, index) => {
    if (
      (index > 0 && compareCodeUnits(canonicalRecords[index - 1].recordKey, record.recordKey) >= 0)
      || record.pointIds.some((id) => pointIds.has(id))
    ) return Number.NaN;
    record.pointIds.forEach((id) => pointIds.add(id));
    return total + record.pointIds.length;
  }, 0);
  if (
    summary.recordCount !== canonicalRecords.length
    || summary.pointCount !== totalPoints
    || totalPoints > MAX_QDRANT_LIFECYCLE_RECOVERY_POINTS
    || fingerprint !== inventoryFingerprint({ lifecycleKey, records: canonicalRecords })
  ) return null;
  return {
    lifecycleKey,
    fingerprint,
    recordCount: canonicalRecords.length,
    pointCount: totalPoints,
    records: canonicalRecords.map((record) => ({ ...record, pointIds: [...record.pointIds] })),
  };
};

export const sameQdrantLifecycleRecoveryInventorySummary = (
  left: QdrantLifecycleRecoveryInventorySummary,
  right: QdrantLifecycleRecoveryInventorySummary,
) => left.lifecycleKey === right.lifecycleKey
  && left.fingerprint === right.fingerprint
  && left.recordCount === right.recordCount
  && left.pointCount === right.pointCount
  && left.records.length === right.records.length
  && left.records.every((record, index) => {
    const compared = right.records[index];
    return compared !== undefined
      && record.storageSchemaVersion === compared.storageSchemaVersion
      && record.recordKey === compared.recordKey
      && record.contentHash === compared.contentHash
      && record.pointFingerprint === compared.pointFingerprint
      && sameTextArray(record.pointIds, compared.pointIds);
  });

export const sameQdrantLifecycleRecoveryInventory = (
  left: unknown,
  right: unknown,
) => {
  const leftSummary = summarizeQdrantLifecycleRecoveryInventory(left);
  const rightSummary = summarizeQdrantLifecycleRecoveryInventory(right);
  return Boolean(
    leftSummary
    && rightSummary
    && sameQdrantLifecycleRecoveryInventorySummary(leftSummary, rightSummary),
  );
};

export const createQdrantLifecycleRecoveryArchive = (
  value: unknown,
): QdrantLifecycleRecoveryArchive | null => {
  const inventory = projectQdrantLifecycleRecoveryInventory(value);
  const summary = inventory ? summarizeQdrantLifecycleRecoveryInventory(inventory) : null;
  return inventory && summary
    ? {
      schemaVersion: 1,
      artifactType: QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_TYPE,
      lifecycleKey: inventory.lifecycleKey,
      inventoryFingerprint: summary.fingerprint,
      records: inventory.records.map((record) => ({
        ...record,
        points: record.points.map(clonePoint),
      })),
    }
    : null;
};

export const projectQdrantLifecycleRecoveryArchive = (
  value: unknown,
): QdrantLifecycleRecoveryArchive | null => {
  const archive = ownDataRecord(value, ARCHIVE_FIELDS);
  const lifecycleKey = canonicalLifecycleKey(archive?.lifecycleKey);
  const inventoryFingerprintValue = canonicalHash(archive?.inventoryFingerprint);
  const inventory = lifecycleKey
    ? projectQdrantLifecycleRecoveryInventory({
      schemaVersion: 1,
      lifecycleKey,
      records: archive?.records,
    })
    : null;
  const summary = inventory ? summarizeQdrantLifecycleRecoveryInventory(inventory) : null;
  return archive
    && archive.schemaVersion === QDRANT_LIFECYCLE_RECOVERY_SCHEMA_VERSION
    && archive.artifactType === QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_TYPE
    && lifecycleKey
    && inventoryFingerprintValue
    && inventory
    && summary
    && summary.fingerprint === inventoryFingerprintValue
    ? {
      schemaVersion: 1,
      artifactType: QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_TYPE,
      lifecycleKey,
      inventoryFingerprint: summary.fingerprint,
      records: inventory.records.map((record) => ({
        ...record,
        points: record.points.map(clonePoint),
      })),
    }
    : null;
};

export const serializeQdrantLifecycleRecoveryArchive = (
  value: unknown,
): string | null => {
  const archive = projectQdrantLifecycleRecoveryArchive(value);
  if (!archive) return null;
  const serialized = `${JSON.stringify(archive)}\n`;
  return utf8ByteLength(serialized) <= MAX_QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_BYTES
    ? serialized
    : null;
};

export const projectQdrantLifecycleRecoveryExpectedPin = (
  value: unknown,
): QdrantLifecycleRecoveryExpectedPin | null => {
  const pin = ownDataRecord(value, PIN_FIELDS);
  const lifecycleKey = canonicalLifecycleKey(pin?.lifecycleKey);
  const reference = projectQdrantLifecycleReference(pin?.initialReference);
  const artifactId = canonicalUuid(pin?.artifactId);
  const recordKey = canonicalText(pin?.recordKey, 512);
  const pinnedAt = canonicalTimestamp(pin?.pinnedAt);
  if (
    !pin
    || pin.schemaVersion !== 1
    || pin.provider !== "qdrant"
    || !lifecycleKey
    || !reference
    || !artifactId
    || !recordKey
    || !pinnedAt
    || reference.lifecycleKey !== lifecycleKey
    || reference.artifactId !== artifactId
    || reference.recordKey !== recordKey
  ) return null;
  return {
    schemaVersion: 1,
    lifecycleKey,
    provider: "qdrant",
    initialReference: { ...reference },
    artifactId,
    recordKey,
    pinnedAt,
  };
};

export const qdrantLifecycleRecoveryPinFingerprint = (
  value: unknown,
): string | null => {
  const pin = projectQdrantLifecycleRecoveryExpectedPin(value);
  return pin
    ? createHash("sha256").update(JSON.stringify(pin), "utf8").digest("hex")
    : null;
};

const projectArchiveReceipt = (
  value: unknown,
): QdrantLifecycleRecoveryArchiveReceipt | null => {
  const receipt = ownDataRecord(value, ARCHIVE_RECEIPT_FIELDS);
  const name = typeof receipt?.name === "string" && ARTIFACT_NAME.test(receipt.name)
    ? receipt.name
    : null;
  const sha256 = canonicalHash(receipt?.sha256);
  return receipt
    && name
    && sha256
    && Number.isSafeInteger(receipt.sizeBytes)
    && receipt.sizeBytes > 0
    && receipt.sizeBytes <= MAX_QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_BYTES
    ? { name, sizeBytes: receipt.sizeBytes, sha256 }
    : null;
};

export const createQdrantLifecycleRecoveryReport = (input: {
  createdAt: unknown;
  attemptId: unknown;
  expectedPin: unknown;
  archive: unknown;
  inventory: unknown;
}): QdrantLifecycleRecoveryReport | null => {
  const createdAt = canonicalTimestamp(input.createdAt);
  const attemptId = canonicalRecoveryAttemptId(input.attemptId);
  const expectedPin = projectQdrantLifecycleRecoveryExpectedPin(input.expectedPin);
  const expectedPinFingerprint = qdrantLifecycleRecoveryPinFingerprint(expectedPin);
  const archive = projectArchiveReceipt(input.archive);
  const inventory = summarizeQdrantLifecycleRecoveryInventory(input.inventory);
  if (
    !createdAt
    || !attemptId
    || !expectedPin
    || !expectedPinFingerprint
    || !archive
    || !inventory
    || inventory.lifecycleKey !== expectedPin.lifecycleKey
  ) return null;
  return {
    schemaVersion: 1,
    artifactType: QDRANT_LIFECYCLE_RECOVERY_REPORT_TYPE,
    lifecycleKey: inventory.lifecycleKey,
    createdAt,
    attemptId,
    expectedPin,
    expectedPinFingerprint,
    archive,
    inventory,
  };
};

export const projectQdrantLifecycleRecoveryReport = (
  value: unknown,
): QdrantLifecycleRecoveryReport | null => {
  const report = ownDataRecord(value, REPORT_FIELDS);
  const lifecycleKey = canonicalLifecycleKey(report?.lifecycleKey);
  const createdAt = canonicalTimestamp(report?.createdAt);
  const attemptId = canonicalRecoveryAttemptId(report?.attemptId);
  const expectedPin = projectQdrantLifecycleRecoveryExpectedPin(report?.expectedPin);
  const expectedPinFingerprint = canonicalHash(report?.expectedPinFingerprint);
  const archive = projectArchiveReceipt(report?.archive);
  const inventory = projectQdrantLifecycleRecoveryInventorySummary(report?.inventory);
  if (
    !report
    || report.schemaVersion !== QDRANT_LIFECYCLE_RECOVERY_SCHEMA_VERSION
    || report.artifactType !== QDRANT_LIFECYCLE_RECOVERY_REPORT_TYPE
    || !lifecycleKey
    || !createdAt
    || !attemptId
    || !expectedPin
    || !expectedPinFingerprint
    || !archive
    || !inventory
    || expectedPin.lifecycleKey !== lifecycleKey
    || inventory.lifecycleKey !== lifecycleKey
    || qdrantLifecycleRecoveryPinFingerprint(expectedPin) !== expectedPinFingerprint
  ) return null;
  return {
    schemaVersion: 1,
    artifactType: QDRANT_LIFECYCLE_RECOVERY_REPORT_TYPE,
    lifecycleKey,
    createdAt,
    attemptId,
    expectedPin,
    expectedPinFingerprint,
    archive,
    inventory,
  };
};

export const serializeQdrantLifecycleRecoveryReport = (
  value: unknown,
): string | null => {
  const report = projectQdrantLifecycleRecoveryReport(value);
  if (!report) return null;
  const serialized = `${JSON.stringify(report)}\n`;
  return utf8ByteLength(serialized) <= MAX_QDRANT_LIFECYCLE_RECOVERY_REPORT_BYTES
    ? serialized
    : null;
};

export const reportMatchesQdrantLifecycleRecoveryArchive = (input: {
  report: unknown;
  archive: unknown;
}): boolean => {
  const report = projectQdrantLifecycleRecoveryReport(input.report);
  const archive = projectQdrantLifecycleRecoveryArchive(input.archive);
  const summary = archive
    ? summarizeQdrantLifecycleRecoveryInventory({
      schemaVersion: 1,
      lifecycleKey: archive.lifecycleKey,
      records: archive.records,
    })
    : null;
  return Boolean(
    report
    && archive
    && summary
    && report.lifecycleKey === archive.lifecycleKey
    && report.inventory.fingerprint === archive.inventoryFingerprint
    && sameQdrantLifecycleRecoveryInventorySummary(report.inventory, summary),
  );
};

export const projectQdrantLifecycleRecoveryCheckpoint = (
  value: unknown,
): QdrantLifecycleRecoveryCheckpoint | null => {
  const base = ownDataRecord(value, CHECKPOINT_BASE_FIELDS)
    ?? ownDataRecord(value, CHECKPOINT_SNAPSHOT_FIELDS);
  const lifecycleKey = canonicalLifecycleKey(base?.lifecycleKey);
  const attemptId = canonicalRecoveryAttemptId(base?.attemptId);
  const reportHash = canonicalHash(base?.reportHash);
  const inventoryFingerprint = canonicalHash(base?.inventoryFingerprint);
  const expectedPinFingerprint = canonicalHash(base?.expectedPinFingerprint);
  const startedAt = canonicalTimestamp(base?.startedAt);
  const stage = base?.stage;
  const hasSnapshotName = Boolean(base && Object.hasOwn(base, "snapshotName"));
  const snapshotName = hasSnapshotName && typeof base?.snapshotName === "string"
    && SNAPSHOT_NAME.test(base.snapshotName)
    ? base.snapshotName
    : undefined;
  if (
    !base
    || base.schemaVersion !== QDRANT_LIFECYCLE_RECOVERY_SCHEMA_VERSION
    || !lifecycleKey
    || !attemptId
    || !reportHash
    || !inventoryFingerprint
    || !expectedPinFingerprint
    || !startedAt
    || !["prepared", "snapshot_started", "snapshot_verified", "deletion_started"].includes(stage as string)
    || ((stage === "prepared" || stage === "snapshot_started") && hasSnapshotName)
    || ((stage === "snapshot_verified" || stage === "deletion_started") && !snapshotName)
  ) return null;
  return {
    schemaVersion: 1,
    lifecycleKey,
    attemptId,
    reportHash,
    inventoryFingerprint,
    expectedPinFingerprint,
    stage: stage as QdrantLifecycleRecoveryStage,
    startedAt,
    ...(snapshotName ? { snapshotName } : {}),
  };
};

export const createQdrantLifecycleRecoveryCheckpoint = (input: {
  lifecycleKey: unknown;
  attemptId: unknown;
  reportHash: unknown;
  inventoryFingerprint: unknown;
  expectedPinFingerprint: unknown;
  stage: unknown;
  startedAt: unknown;
  snapshotName?: unknown;
}): QdrantLifecycleRecoveryCheckpoint | null => projectQdrantLifecycleRecoveryCheckpoint({
  schemaVersion: 1,
  lifecycleKey: input.lifecycleKey,
  attemptId: input.attemptId,
  reportHash: input.reportHash,
  inventoryFingerprint: input.inventoryFingerprint,
  expectedPinFingerprint: input.expectedPinFingerprint,
  stage: input.stage,
  startedAt: input.startedAt,
  ...(input.snapshotName === undefined ? {} : { snapshotName: input.snapshotName }),
});

export const sameQdrantLifecycleRecoveryCheckpoint = (
  left: QdrantLifecycleRecoveryCheckpoint,
  right: QdrantLifecycleRecoveryCheckpoint,
): boolean => left.lifecycleKey === right.lifecycleKey
  && left.attemptId === right.attemptId
  && left.reportHash === right.reportHash
  && left.inventoryFingerprint === right.inventoryFingerprint
  && left.expectedPinFingerprint === right.expectedPinFingerprint
  && left.stage === right.stage
  && left.startedAt === right.startedAt
  && left.snapshotName === right.snapshotName;

export const projectQdrantLifecycleRecoveryAbsenceProof = (
  value: unknown,
): QdrantLifecycleRecoveryAbsenceProof | null => {
  const proof = ownDataRecord(value, ABSENCE_PROOF_FIELDS);
  const lifecycleKey = canonicalLifecycleKey(proof?.lifecycleKey);
  const attemptId = canonicalRecoveryAttemptId(proof?.attemptId);
  const reportHash = canonicalHash(proof?.reportHash);
  const inventoryFingerprint = canonicalHash(proof?.inventoryFingerprint);
  const expectedPinFingerprint = canonicalHash(proof?.expectedPinFingerprint);
  const verifiedAt = canonicalTimestamp(proof?.verifiedAt);
  if (
    !proof
    || proof.schemaVersion !== QDRANT_LIFECYCLE_RECOVERY_SCHEMA_VERSION
    || !lifecycleKey
    || !attemptId
    || !reportHash
    || !inventoryFingerprint
    || !expectedPinFingerprint
    || !verifiedAt
    || !Number.isSafeInteger(proof.expectedPointCount)
    || proof.expectedPointCount < 0
    || proof.expectedPointCount > MAX_QDRANT_LIFECYCLE_RECOVERY_POINTS
    || !Number.isSafeInteger(proof.expectedParentCount)
    || proof.expectedParentCount < 0
    || proof.expectedParentCount > MAX_QDRANT_LIFECYCLE_RECOVERY_RECORDS
  ) return null;
  return {
    schemaVersion: 1,
    lifecycleKey,
    attemptId,
    reportHash,
    inventoryFingerprint,
    expectedPinFingerprint,
    expectedPointCount: proof.expectedPointCount,
    expectedParentCount: proof.expectedParentCount,
    verifiedAt,
  };
};

export const createQdrantLifecycleRecoveryAbsenceProof = (input: {
  checkpoint: unknown;
  inventory: unknown;
  verifiedAt: unknown;
}): QdrantLifecycleRecoveryAbsenceProof | null => {
  const checkpoint = projectQdrantLifecycleRecoveryCheckpoint(input.checkpoint);
  const inventory = projectQdrantLifecycleRecoveryInventory(input.inventory);
  const verifiedAt = canonicalTimestamp(input.verifiedAt);
  const expectedPointCount = inventory?.records.reduce(
    (total, record) => total + record.points.length,
    0,
  );
  const expectedParentCount = inventory?.records.filter(
    (record) => record.storageSchemaVersion === 2,
  ).length;
  if (
    !checkpoint
    || !inventory
    || !verifiedAt
    || checkpoint.lifecycleKey !== inventory.lifecycleKey
    || summarizeQdrantLifecycleRecoveryInventory(inventory)?.fingerprint
      !== checkpoint.inventoryFingerprint
    || expectedPointCount === undefined
    || expectedParentCount === undefined
  ) return null;
  return projectQdrantLifecycleRecoveryAbsenceProof({
    schemaVersion: 1,
    lifecycleKey: checkpoint.lifecycleKey,
    attemptId: checkpoint.attemptId,
    reportHash: checkpoint.reportHash,
    inventoryFingerprint: checkpoint.inventoryFingerprint,
    expectedPinFingerprint: checkpoint.expectedPinFingerprint,
    expectedPointCount,
    expectedParentCount,
    verifiedAt,
  });
};
