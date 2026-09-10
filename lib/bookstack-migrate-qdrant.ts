import { reassembleInstitutionalManifest, normalizeInstitutionalManifestPoint, normalizeInstitutionalRecord, type CorpusResult } from "./qdrant-corpus.ts";
import { sourceHash, type MigrationSource } from "./bookstack-migrate-source.ts";

type Point = { id: string; payload: Record<string, unknown> };
type ScrollResponse = { result?: { points?: Point[]; next_page_offset?: string | number | null } };
const MAX_POINTS = 10_000;

const asPoint = (value: unknown): Point | null => value && typeof value === "object"
  && typeof (value as { id?: unknown }).id === "string"
  && (value as { payload?: unknown }).payload
  && typeof (value as { payload: unknown }).payload === "object"
  && !Array.isArray((value as { payload: unknown }).payload)
  ? value as Point
  : null;

export const sourceFingerprint = (sources: MigrationSource[]) => sourceHash(
  sources.map((source) => `${source.sourceId}\0${source.sourceHash}`).sort().join("\n"),
);

const lifecycleSource = (id: string, payload: Record<string, unknown>, detail: string): MigrationSource | null => {
  const recordKey = typeof payload.record_key === "string" ? payload.record_key : "";
  const project = typeof payload.project === "string" ? payload.project : "";
  const lifecycleKey = typeof payload.lifecycle_key === "string" ? payload.lifecycle_key : "";
  const phase = typeof payload.phase === "string" ? payload.phase : "";
  const sourceRefs = Array.isArray(payload.source_refs) && payload.source_refs.every((ref) => typeof ref === "string")
    ? payload.source_refs as string[] : [];
  const createdAt = typeof payload.created_at === "string" ? payload.created_at : "legacy-unknown";
  if (!recordKey || !project || !lifecycleKey || !phase || !detail) return null;
  return {
    kind: "lifecycle", sourceId: `qdrant:${id}`, recordKey, lifecycleKey, project,
    artifactType: phase, phase, sourceRefs, createdAt, author: "legacy-unknown", body: detail,
    sourceHash: sourceHash(detail),
  };
};

export function reassembleLifecyclePoints(points: unknown[]): MigrationSource[] {
  const normalized = points.map(asPoint).filter((point): point is Point => point !== null);
  const manifestKeys = new Set(normalized.filter((point) => point.payload.schema_version === 2 && point.payload.record_kind === "manifest")
    .map((point) => String(point.payload.record_key)));
  const sources: MigrationSource[] = [];
  for (const point of normalized) {
    const payload = point.payload;
    if (payload.schema_version === 1) {
      const record = normalizeInstitutionalRecord({
        recordKey: payload.record_key, project: payload.project, site: payload.site, repo: payload.repo,
        lifecycleKey: payload.lifecycle_key, phase: payload.phase, summary: payload.summary,
        detail: payload.detail, sourceRefs: payload.source_refs,
      }, payload.created_at);
      if (!record.success || record.data.id !== point.id) throw new Error("qdrant_v1_invalid");
      const source = lifecycleSource(point.id, record.data.payload, record.data.payload.detail);
      if (!source || source.sourceHash !== sourceHash(source.body)) throw new Error("qdrant_v1_invalid");
      sources.push(source);
      continue;
    }
    if (payload.schema_version === 2 && payload.record_kind === "detail_chunk") continue;
    if (payload.schema_version !== 2 || payload.record_kind !== "manifest") throw new Error("qdrant_schema_unsupported");
    const manifest = normalizeInstitutionalManifestPoint(point);
    if (!manifest.success) throw new Error("qdrant_manifest_invalid");
    const chunks = normalized.filter((candidate) => candidate.payload.parent_record_key === manifest.data.recordKey);
    const result = reassembleInstitutionalManifest({ manifestPoint: point, chunkPoints: chunks });
    if (!result.success || result.data.id !== point.id) throw new Error("qdrant_manifest_invalid");
    const source = lifecycleSource(point.id, result.data.payload, result.data.detail);
    if (!source || source.sourceHash !== sourceHash(result.data.detail)) throw new Error("qdrant_manifest_invalid");
    sources.push(source);
  }
  for (const point of normalized) {
    if (point.payload.schema_version === 2 && point.payload.record_kind === "detail_chunk"
      && (!manifestKeys.has(String(point.payload.parent_record_key)) || !point.payload.parent_record_key)) {
      throw new Error("qdrant_chunk_orphaned");
    }
  }
  const identities = new Set<string>();
  for (const source of sources) {
    if (!source.recordKey || identities.has(source.recordKey)) throw new Error("qdrant_record_duplicate");
    identities.add(source.recordKey);
  }
  return sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export type QdrantScrollInput = { origin: string; collection: string; fetch?: typeof globalThis.fetch; signal?: AbortSignal };

const qdrantUrl = (origin: string, path: string) => {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("qdrant_origin_invalid");
  return new URL(path, `${url.origin}/`).toString();
};

export async function scrollLifecyclePoints(input: QdrantScrollInput): Promise<Point[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.collection)) throw new Error("qdrant_collection_invalid");
  const fetcher = input.fetch ?? globalThis.fetch;
  const points: Point[] = [];
  let offset: string | number | null = null;
  do {
    const response = await fetcher(qdrantUrl(input.origin, `collections/${encodeURIComponent(input.collection)}/points/scroll`), {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, redirect: "error", signal: input.signal,
      body: JSON.stringify({ limit: 500, with_payload: true, with_vector: false, ...(offset === null ? {} : { offset }) }),
    });
    if (!response.ok) throw new Error("qdrant_scroll_failed");
    const body = await response.json() as ScrollResponse;
    const batch = body.result?.points;
    if (!Array.isArray(batch) || batch.some((point) => !asPoint(point))) throw new Error("qdrant_response_invalid");
    points.push(...batch);
    if (points.length > MAX_POINTS) throw new Error("qdrant_point_limit");
    offset = body.result?.next_page_offset ?? null;
  } while (offset !== null);
  return points;
}

export async function stableLifecycleSnapshot(input: QdrantScrollInput): Promise<{ sources: MigrationSource[]; fingerprint: string }> {
  const first = reassembleLifecyclePoints(await scrollLifecyclePoints(input));
  const second = reassembleLifecyclePoints(await scrollLifecyclePoints(input));
  const fingerprint = sourceFingerprint(first);
  if (fingerprint !== sourceFingerprint(second)) throw new Error("qdrant_snapshot_unstable");
  return { sources: first, fingerprint };
}
