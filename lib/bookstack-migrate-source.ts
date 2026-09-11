import { createHash } from "node:crypto";

export const MIGRATION_MARKER = "<!-- ima-bookstack-migration-source -->";
const PLANE_THREAD = /:plane:[A-Za-z0-9._~-]+:([A-Z][A-Z0-9_]*)-([1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export type MigrationSource = {
  kind: "lifecycle" | "knowledge";
  sourceOrigin?: "filesystem" | "qdrant";
  sourceId: string;
  recordKey?: string;
  lifecycleKey?: string;
  project: string;
  artifactType: string;
  sourceRefs: string[];
  createdAt: string;
  author: string;
  body: string;
  sourceHash: string;
  path?: string;
  phase?: string;
};

export type TargetPage = MigrationSource & {
  shelfName: "Lifecycle Artifacts" | "Institutional Knowledge";
  bookName: string;
  chapterName: string;
  pageName: string;
  markdown: string;
};

export type QuarantineOutcome = {
  sourceId: string;
  sourceHash: string;
  status: "quarantined";
  code: string;
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const bounded = (value: unknown, maximum: number) => typeof value === "string" && value.trim() && value.length <= maximum
  ? value.trim()
  : null;
const stableSuffix = (value: string) => sha256(value).slice(0, 12);
const safeName = (value: string, maximum = 180) => value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
const pageSuffix = (recordKey: string) => recordKey.split(":").at(-1) || stableSuffix(recordKey);
const sourcePathParts = (path: string) => path.split("/").filter(Boolean);

export const sourceHash = sha256;

export function lifecycleChapterName(lifecycleKey: string): string {
  const plane = lifecycleKey.match(PLANE_THREAD);
  return plane ? `${plane[1]}-${plane[2]}` : `${safeName(lifecycleKey, 130)} — ${stableSuffix(lifecycleKey)}`;
}

export function knowledgeLocation(path: string) {
  const parts = sourcePathParts(path);
  if (parts.length < 2) throw new Error("knowledge_path_invalid");
  const [bookName, ...remaining] = parts;
  const filename = remaining.pop()!;
  return {
    bookName,
    chapterName: remaining.length ? remaining.join("/") : "General",
    pageName: filename.replace(/\.md$/i, ""),
  };
}

export function parseFrontMatter(markdown: string): { attributes: Record<string, string>; body: string } {
  if (!markdown.startsWith("---\n")) return { attributes: {}, body: markdown };
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) return { attributes: {}, body: markdown };
  const attributes = Object.fromEntries(markdown.slice(4, end).split("\n").flatMap((line) => {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/);
    return match ? [[match[1], match[2].replace(/^['\"]|['\"]$/g, "").trim()]] : [];
  }));
  return { attributes, body: markdown.slice(end + 5) };
}

export function validSource(source: MigrationSource): boolean {
  return Boolean(
    bounded(source.sourceId, 512)
    && bounded(source.project, 256)
    && bounded(source.artifactType, 128)
    && bounded(source.createdAt, 128)
    && bounded(source.author, 256)
    && (source.sourceOrigin === undefined || source.sourceOrigin === "filesystem" || source.sourceOrigin === "qdrant")
    && typeof source.body === "string"
    && source.body.length > 0
    && SHA256.test(source.sourceHash)
    && sourceHash(source.body) === source.sourceHash
    && Array.isArray(source.sourceRefs)
    && source.sourceRefs.every((ref) => bounded(ref, 1024)),
  );
}

export function renderPage(source: MigrationSource, target: Omit<TargetPage, keyof MigrationSource | "markdown">): string {
  const envelope = source.kind === "lifecycle"
    ? ["---", "schema: ima-memory/v1", `project: ${source.project}`, `artifact_type: ${source.artifactType}`, `lifecycle_key: ${source.lifecycleKey}`, "---"]
    : ["---", "schema: ima-memory/v1", `project: ${source.project}`, `artifact_type: ${source.artifactType}`, "---"];
  const provenance = [
    "## Migration provenance",
    `- source_kind: ${source.sourceOrigin ?? source.kind}`,
    `- source_id: ${source.sourceId}`,
    ...(source.recordKey ? [`- record_key: ${source.recordKey}`] : []),
    ...(source.path ? [`- source_path: ${source.path}`] : []),
    ...(source.lifecycleKey ? [`- lifecycle_key: ${source.lifecycleKey}`] : []),
    `- source_created_at: ${source.createdAt}`,
    `- source_author: ${source.author}`,
    `- source_content_sha256: ${source.sourceHash}`,
    `- target: ${target.shelfName} / ${target.bookName} / ${target.chapterName} / ${target.pageName}`,
    `\n${MIGRATION_MARKER}`,
  ];
  return [...envelope, "", ...provenance, "", source.body].join("\n");
}

export function targetPage(source: MigrationSource): TargetPage {
  if (!validSource(source)) throw new Error("migration_source_invalid");
  if (source.kind === "lifecycle") {
    if (!source.recordKey || !source.lifecycleKey || !source.phase) throw new Error("lifecycle_source_invalid");
    const target = {
      shelfName: "Lifecycle Artifacts" as const,
      bookName: safeName(source.project),
      chapterName: lifecycleChapterName(source.lifecycleKey),
      pageName: safeName(`${source.phase} — ${pageSuffix(source.recordKey)}`),
    };
    return { ...source, ...target, markdown: renderPage(source, target) };
  }
  if (!source.path) throw new Error("knowledge_source_invalid");
  const location = knowledgeLocation(source.path);
  const target = { shelfName: "Institutional Knowledge" as const, ...location };
  return { ...source, ...target, markdown: renderPage(source, target) };
}

export function extractSourceBody(markdown: string): string | null {
  const marker = `\n${MIGRATION_MARKER}\n\n`;
  const position = markdown.indexOf(marker);
  return position < 0 ? null : markdown.slice(position + marker.length);
}

// BookStack trims trailing newlines from stored page markdown on save, so a body
// ending in "\n" reads back one newline short. Normalize only trailing newlines
// (not internal or leading whitespace) so this benign round-trip is not a false
// mismatch, while any real content change is still detected.
const stripTrailingNewlines = (text: string) => text.replace(/\n+$/, "");

export function sourceBodyMatches(storedMarkdown: string, expectedBody: string): boolean {
  const extracted = extractSourceBody(storedMarkdown);
  return extracted !== null && stripTrailingNewlines(extracted) === stripTrailingNewlines(expectedBody);
}

const quarantineCode = (error: unknown) => error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
  ? error.message
  : "target_page_invalid";

export function deterministicPages(sources: MigrationSource[]): { pages: TargetPage[]; quarantined: QuarantineOutcome[] } {
  const pages: TargetPage[] = [];
  const quarantined: QuarantineOutcome[] = [];
  const identities = new Set<string>();
  for (const source of [...sources].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.sourceId.localeCompare(right.sourceId))) {
    try {
      const page = targetPage(source);
      const identity = `${page.shelfName}\0${page.bookName}\0${page.chapterName}\0${page.pageName}`;
      if (identities.has(identity)) {
        quarantined.push({
          sourceId: source.sourceId,
          sourceHash: sourceHash(JSON.stringify(source)),
          status: "quarantined",
          code: "target_identity_conflict",
        });
        continue;
      }
      identities.add(identity);
      pages.push(page);
    } catch (error) {
      quarantined.push({
        sourceId: source.sourceId,
        sourceHash: sourceHash(JSON.stringify(source)),
        status: "quarantined",
        code: quarantineCode(error),
      });
    }
  }
  return { pages, quarantined };
}
