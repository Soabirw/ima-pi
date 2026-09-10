import {
  reassembleInstitutionalManifest,
  normalizeInstitutionalManifestPoint,
  normalizeInstitutionalRecord,
} from "./qdrant-corpus.ts";
import {
  sourceHash,
  type MigrationSource,
  type QuarantineOutcome,
} from "./bookstack-migrate-source.ts";

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

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
};

const quarantine = (sourceId: string, payload: unknown, code: string): QuarantineOutcome => ({
  sourceId,
  sourceHash: sourceHash(stableStringify(payload)),
  status: "quarantined",
  code,
});

export const sourceFingerprint = (sources: MigrationSource[]) => sourceHash(
  sources.map((source) => `${source.sourceId}\0${source.sourceHash}`).sort().join("\n"),
);

const lifecycleSource = (
  id: string,
  payload: Record<string, unknown>,
  detail: string,
): MigrationSource | null => {
  const recordKey = typeof payload.record_key === "string" ? payload.record_key : "";
  const project = typeof payload.project === "string" ? payload.project : "";
  const lifecycleKey = typeof payload.lifecycle_key === "string" ? payload.lifecycle_key : "";
  const phase = typeof payload.phase === "string" ? payload.phase : "";
  const sourceRefs = Array.isArray(payload.source_refs)
    && payload.source_refs.every((ref) => typeof ref === "string")
    ? payload.source_refs as string[]
    : [];
  const createdAt = typeof payload.created_at === "string" ? payload.created_at : "legacy-unknown";
  if (!recordKey || !project || !lifecycleKey || !phase || !detail) return null;
  return {
    kind: "lifecycle",
    sourceOrigin: "qdrant",
    sourceId: `qdrant:${id}`,
    recordKey,
    lifecycleKey,
    project,
    artifactType: phase,
    phase,
    sourceRefs,
    createdAt,
    author: "legacy-unknown",
    body: detail,
    sourceHash: sourceHash(detail),
  };
};

export function reassembleLifecyclePoints(points: unknown[]): {
  sources: MigrationSource[];
  quarantined: QuarantineOutcome[];
} {
  const normalized = points.map(asPoint).filter((point): point is Point => point !== null);
  const sources: Array<{ source: MigrationSource; point: Point }> = [];
  const quarantined: QuarantineOutcome[] = [];
  const manifestKeys = new Set(normalized
    .filter((point) => point.payload.schema_version === 2 && point.payload.record_kind === "manifest")
    .flatMap((point) => typeof point.payload.record_key === "string" ? [point.payload.record_key] : []));

  for (const point of normalized) {
    const payload = point.payload;
    if (payload.schema_version === 1) {
      try {
        const record = normalizeInstitutionalRecord({
          recordKey: payload.record_key,
          project: payload.project,
          site: payload.site,
          repo: payload.repo,
          lifecycleKey: payload.lifecycle_key,
          phase: payload.phase,
          summary: payload.summary,
          detail: payload.detail,
          sourceRefs: payload.source_refs,
        }, payload.created_at);
        const source = record.success && record.data.id === point.id
          ? lifecycleSource(point.id, record.data.payload, record.data.payload.detail)
          : null;
        if (!source || source.sourceHash !== sourceHash(source.body)) {
          quarantined.push(quarantine(`qdrant:${point.id}`, payload, "qdrant_v1_invalid"));
          continue;
        }
        sources.push({ source, point });
      } catch {
        quarantined.push(quarantine(`qdrant:${point.id}`, payload, "qdrant_v1_invalid"));
      }
      continue;
    }

    if (payload.schema_version === 2 && payload.record_kind === "detail_chunk") continue;
    if (payload.schema_version !== 2 || payload.record_kind !== "manifest") {
      quarantined.push(quarantine(`qdrant:${point.id}`, payload, "qdrant_schema_unsupported"));
      continue;
    }

    try {
      const manifest = normalizeInstitutionalManifestPoint(point);
      const chunks = manifest.success
        ? normalized.filter((candidate) => candidate.payload.parent_record_key === manifest.data.recordKey)
        : [];
      const result = manifest.success
        ? reassembleInstitutionalManifest({ manifestPoint: point, chunkPoints: chunks })
        : null;
      const source = result?.success && result.data.id === point.id
        ? lifecycleSource(point.id, result.data.payload, result.data.detail)
        : null;
      if (!source || source.sourceHash !== sourceHash(source.body)) {
        quarantined.push(quarantine(`qdrant:${point.id}`, payload, "qdrant_manifest_invalid"));
        continue;
      }
      sources.push({ source, point });
    } catch {
      quarantined.push(quarantine(`qdrant:${point.id}`, payload, "qdrant_manifest_invalid"));
    }
  }

  const orphanedChunks = new Map<string, Point[]>();
  for (const point of normalized) {
    if (point.payload.schema_version !== 2 || point.payload.record_kind !== "detail_chunk") continue;
    const parentRecordKey = typeof point.payload.parent_record_key === "string"
      ? point.payload.parent_record_key
      : "unknown";
    if (!parentRecordKey || manifestKeys.has(parentRecordKey)) continue;
    orphanedChunks.set(parentRecordKey, [...(orphanedChunks.get(parentRecordKey) ?? []), point]);
  }
  for (const [parentRecordKey, chunks] of orphanedChunks) {
    quarantined.push(quarantine(
      `qdrant:orphan:${parentRecordKey}`,
      chunks.map((chunk) => chunk.payload),
      "qdrant_chunk_orphaned",
    ));
  }

  const recordKeys = new Set<string>();
  const uniqueSources: MigrationSource[] = [];
  for (const entry of sources) {
    if (recordKeys.has(entry.source.recordKey!)) {
      quarantined.push(quarantine(
        `qdrant:${entry.point.id}:duplicate`,
        entry.point.payload,
        "qdrant_record_duplicate",
      ));
      continue;
    }
    recordKeys.add(entry.source.recordKey!);
    uniqueSources.push(entry.source);
  }

  return {
    sources: uniqueSources.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    quarantined: quarantined.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  };
}

export type QdrantScrollInput = {
  origin: string;
  collection: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
};

const qdrantUrl = (origin: string, path: string) => {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("qdrant_origin_invalid");
  }
  return new URL(path, `${url.origin}/`).toString();
};

export async function scrollLifecyclePoints(input: QdrantScrollInput): Promise<Point[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.collection)) throw new Error("qdrant_collection_invalid");
  const fetcher = input.fetch ?? globalThis.fetch;
  const points: Point[] = [];
  let offset: string | number | null = null;
  do {
    const response = await fetcher(
      qdrantUrl(input.origin, `collections/${encodeURIComponent(input.collection)}/points/scroll`),
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        redirect: "error",
        signal: input.signal,
        body: JSON.stringify({
          limit: 500,
          with_payload: true,
          with_vector: false,
          ...(offset === null ? {} : { offset }),
        }),
      },
    );
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

export async function lifecycleSnapshot(input: QdrantScrollInput): Promise<{
  sources: MigrationSource[];
  quarantined: QuarantineOutcome[];
  fingerprint: string;
  count: number;
}> {
  const snapshot = reassembleLifecyclePoints(await scrollLifecyclePoints(input));
  return {
    ...snapshot,
    fingerprint: sourceFingerprint(snapshot.sources),
    count: snapshot.sources.length + snapshot.quarantined.length,
  };
}
