import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_SCHEMA_VERSION,
  VECTOR_SIZE,
  corpusFailure,
  deriveRecordId,
  normalizeInstitutionalManifest,
  normalizeInstitutionalManifestPoint,
  normalizeInstitutionalRecord,
  reassembleInstitutionalManifest,
} from "../lib/qdrant-corpus.ts";

export const success = (data) => ({ success: true, data });
export const failure = (code) => corpusFailure(code);
export const embedding = () => Array.from({ length: VECTOR_SIZE }, () => 0.25);
export const sqliteBackup = () => {
  const backup = Buffer.alloc(100);
  Buffer.from("SQLite format 3\0", "ascii").copy(backup);
  return backup;
};

export const corpusPrerequisites = (collection = "ready", missingIndexes = []) => success({
  endpointConfiguration: success(undefined),
  qdrantServiceAndVersion: success("1.17.1"),
  ollamaEmbeddingModel: success(undefined),
  institutionalCollection: success({ collection, missingIndexes }),
});

export const lifecycleId = "11111111-1111-4111-8111-111111111111";
export const retainedId = "22222222-2222-4222-8222-222222222222";
export const nonce = "33333333-3333-4333-8333-333333333333";
export const createdAt = "2026-08-26T21:33:02.576436343+00:00";

export const lifecycleContent = (detail = "Authorization: lifecycle-secret") => `---
lifecycle:
  project: 'ima-pi'
  lifecycle_key: 'ima-pi:lifecycle:vestige-migrate-command-2026-08-26'
  source_refs:
    - 'taskwarrior:ima-pi:7742b1e1-af39-44d1-9c7e-39c455b15828'
  phase: 'plan'
---

# Migration plan

${detail}

<!-- ima-lifecycle verification: lifecycle_key=ima-pi:lifecycle:vestige-migrate-command-2026-08-26; nonce=${nonce}; phase=plan; jira_key=; taskwarrior_uuid=7742b1e1-af39-44d1-9c7e-39c455b15828; outcome=completed -->`;
export const lifecycleRecord = (content = lifecycleContent(), id = lifecycleId) => ({ id, content, createdAt });
export const response = (data) => ({ structuredContent: data });

export const purgeReceipt = (id, overrides = {}) => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      action: "purge",
      success: true,
      nodeId: id,
      deletedAt: "2026-08-28T00:00:00.000Z",
      edgesPruned: 0,
      insightsRewritten: 0,
      insightsDeleted: 0,
      childrenOrphaned: 0,
      ...overrides,
    }),
  }],
});

export const temporaryProject = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ima-pi-vestige-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const fullRecord = (record) => ({
  id: record.id,
  recordKey: record.recordKey,
  project: record.payload.project,
  site: record.payload.site,
  repo: record.payload.repo,
  lifecycleKey: record.payload.lifecycle_key,
  phase: record.payload.phase,
  summary: record.payload.summary,
  detail: record.detail ?? record.payload.detail,
  sourceRefs: record.payload.source_refs,
  contentHash: record.payload.content_hash,
  createdAt: record.payload.created_at,
});

export const fakeClient = (state = { collection: "absent" }) => {
  const points = new Map();
  const records = new Map();
  return {
    points,
    records,
    client: {
      preflight: async () => corpusPrerequisites(state.collection),
      status: async () => success({
        status: "ready", qdrantVersion: "1.17.1", collection: state.collection, missingIndexes: [],
      }),
      ensureCollection: async () => {
        state.collection = "ready";
        return success({ status: "ready", qdrantVersion: "1.17.1", collection: "ready", missingIndexes: [] });
      },
      getPoint: async (id) => success(points.get(id) ?? null),
      embedSummary: async () => success(embedding()),
      insertPoint: async ({ record }) => {
        points.set(record.id, {
          id: record.id,
          recordKey: record.recordKey,
          contentHash: record.payload.content_hash,
        });
        records.set(record.recordKey, fullRecord(record));
        return success(undefined);
      },
      findInstitutional: async () => success([]),
      recallInstitutional: async ({ lifecycleKey }) => success(
        [...records.values()]
          .filter((record) => record.lifecycleKey === lifecycleKey)
          .map(({ id, recordKey, project, site, repo, lifecycleKey: key, phase, summary }) => ({
            id, recordKey, project, site, repo, lifecycleKey: key, phase, summary,
          })),
      ),
      getInstitutional: async (recordKey) => records.has(recordKey)
        ? success(records.get(recordKey))
        : failure("record_not_found"),
      findKnowledge: async () => success([]),
    },
  };
};

export const migrationCli = (_backupText, exportText, calls = []) => ({
  runVestigeBackup: async ({ outputPath }) => {
    calls.push({ command: "backup", outputPath });
    await writeFile(outputPath, sqliteBackup());
  },
  runVestigeExport: async ({ outputPath }) => {
    calls.push({ command: "export", outputPath });
    await writeFile(outputPath, exportText);
  },
});

export const readReport = async (root, relativePath) =>
  JSON.parse(await readFile(join(root, relativePath), "utf8"));

const pointRecordKey = (point) => point?.payload?.record_key
  ?? (point?.payload?.parent_record_key
    ? `${point.payload.parent_record_key}:chunk:${String(point.payload.chunk_index).padStart(4, "0")}`
    : "");

export const createLogicalQdrantFixture = (options = {}) => {
  const points = new Map();
  const writeOrder = [];
  const failRecordKeys = new Set(options.failRecordKeys ?? []);
  let collection = options.collection ?? "absent";

  const insert = (point) => {
    const recordKey = pointRecordKey(point);
    if (failRecordKeys.has(recordKey)) return failure("store_failed");
    if (points.has(point.id)) return failure("record_conflict");
    points.set(point.id, { id: point.id, payload: point.payload });
    writeOrder.push(recordKey);
    return success(undefined);
  };

  const getInstitutional = async (recordKey) => {
    const id = deriveRecordId(recordKey);
    if (!id.success) return id;
    const point = points.get(id.data);
    if (!point) return failure("record_not_found");
    if (point.payload?.schema_version === CORPUS_SCHEMA_VERSION) {
      const normalized = normalizeInstitutionalRecord({
        recordKey: point.payload.record_key,
        project: point.payload.project,
        site: point.payload.site,
        repo: point.payload.repo,
        lifecycleKey: point.payload.lifecycle_key,
        phase: point.payload.phase,
        summary: point.payload.summary,
        detail: point.payload.detail,
        sourceRefs: point.payload.source_refs,
      }, point.payload.created_at);
      if (!normalized.success || normalized.data.payload.content_hash !== point.payload.content_hash) {
        return failure("response_invalid");
      }
      return success(fullRecord({
        id: normalized.data.id,
        recordKey: normalized.data.recordKey,
        payload: normalized.data.payload,
        detail: normalized.data.payload.detail,
      }));
    }

    const manifest = normalizeInstitutionalManifestPoint(point);
    if (!manifest.success) return manifest;
    const chunkPoints = [...points.values()].filter((candidate) =>
      candidate.payload?.parent_record_key === manifest.data.recordKey,
    );
    const reassembled = reassembleInstitutionalManifest({
      manifestPoint: point,
      chunkPoints,
    });
    if (!reassembled.success) return reassembled;
    return success(fullRecord({
      id: reassembled.data.id,
      recordKey: reassembled.data.recordKey,
      payload: reassembled.data.payload,
      detail: reassembled.data.detail,
    }));
  };

  const client = {
    preflight: async () => corpusPrerequisites(collection),
    status: async () => success({
      status: "ready",
      qdrantVersion: "1.17.1",
      collection,
      missingIndexes: [],
    }),
    ensureCollection: async () => {
      collection = "ready";
      return success({ status: "ready", qdrantVersion: "1.17.1", collection, missingIndexes: [] });
    },
    getPoint: async (id) => {
      const point = points.get(id);
      return success(point
        ? {
          id: point.id,
          recordKey: point.payload.record_key,
          contentHash: point.payload.content_hash,
        }
        : null);
    },
    getPoints: async (ids) => success(ids.flatMap((id) => points.has(id) ? [points.get(id)] : [])),
    embedSummary: async () => success(embedding()),
    insertPoint: async ({ record }) => insert({ id: record.id, payload: record.payload }),
    insertPoints: async ({ points: inputPoints }) => {
      for (const point of inputPoints) {
        const result = insert(point);
        if (!result.success) return result;
      }
      return success(undefined);
    },
    findInstitutional: async () => success([]),
    recallInstitutional: async () => success([]),
    getInstitutional,
    findKnowledge: async () => success([]),
  };

  const addManifestConflict = (record, createdAt) => {
    const normalized = normalizeInstitutionalManifest(record, createdAt);
    if (!normalized.success) throw new Error("fixture_manifest_invalid");
    points.set(normalized.data.id, { id: normalized.data.id, payload: normalized.data.payload });
  };

  return { client, points, writeOrder, failRecordKeys, addManifestConflict };
};
