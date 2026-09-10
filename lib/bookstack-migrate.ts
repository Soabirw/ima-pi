import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createBookStackArtifactRun, readProjectArtifact, writeImmutableArtifact, type BookStackArtifactRun } from "./bookstack-migrate-artifacts.ts";
import { createBookStackClient, type BookStackClient } from "./bookstack-migrate-client.ts";
import { stableMarkdownSnapshot } from "./bookstack-migrate-markdown.ts";
import { stableLifecycleSnapshot } from "./bookstack-migrate-qdrant.ts";
import { DEFAULT_QDRANT_URL, resolveCorpusEndpoint } from "./qdrant-http-boundary.ts";
import { buildBookStackMigrationReport, parseBookStackMigrationReport, serializeBookStackMigrationReport, type BookStackMigrationReport } from "./bookstack-migrate-report.ts";
import { deterministicPages, extractSourceBody, sourceHash, type TargetPage } from "./bookstack-migrate-source.ts";

export type BookStackMigrationSpec = {
  schemaVersion: 1;
  lifecycle: { collection: string; qdrantOrigin?: string; shelfName: "Lifecycle Artifacts" };
  knowledge: { root?: string; shelfName: "Institutional Knowledge" };
};
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const itemParent = (item: Record<string, unknown>, name: string) => typeof item[name] === "number" ? item[name] : null;

export async function readBookStackMigrationSpec(path: string): Promise<BookStackMigrationSpec> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as BookStackMigrationSpec;
  if (parsed?.schemaVersion !== 1 || !parsed.lifecycle || !parsed.knowledge || parsed.lifecycle.shelfName !== "Lifecycle Artifacts" || parsed.knowledge.shelfName !== "Institutional Knowledge") throw new Error("migration_spec_invalid");
  return parsed;
}

const sourceFingerprint = (pages: TargetPage[]) => sourceHash(
  pages.map((page) => `${page.sourceId}\0${page.sourceHash}`).sort().join("\n"),
);

const migrationPages = async (spec: BookStackMigrationSpec, signal?: AbortSignal) => {
  const qdrantOrigin = resolveCorpusEndpoint(
    spec.lifecycle.qdrantOrigin || process.env.IMA_QDRANT_URL,
    DEFAULT_QDRANT_URL,
  );
  const knowledgeRoot = spec.knowledge.root || process.env.IMA_RAG_ROOT;
  if (!qdrantOrigin || !knowledgeRoot) throw new Error("migration_binding_missing");
  const [lifecycle, knowledge] = await Promise.all([
    stableLifecycleSnapshot({ origin: qdrantOrigin, collection: spec.lifecycle.collection, signal }),
    stableMarkdownSnapshot({ root: knowledgeRoot, signal }),
  ]);
  return deterministicPages([...lifecycle.sources, ...knowledge.sources]);
};

export async function dryRunBookStackMigration(input: { projectRoot: string; specPath: string; signal?: AbortSignal }) {
  const specText = await readFile(input.specPath, "utf8");
  const spec = await readBookStackMigrationSpec(input.specPath);
  const pages = await migrationPages(spec, input.signal);
  const run = await createBookStackArtifactRun(input.projectRoot);
  await writeImmutableArtifact(run, "spec.json", specText);
  await writeImmutableArtifact(run, "inventory.json", `${JSON.stringify(pages, null, 2)}\n`);
  const report = buildBookStackMigrationReport({
    runId: run.runId, specHash: hash(specText), sourceFingerprint: sourceFingerprint(pages),
    outcomes: pages.map((page) => ({ sourceId: page.sourceId, sourceHash: page.sourceHash, status: "unverified" as const })),
  });
  const artifact = await writeImmutableArtifact(run, "dry-run-report.json", serializeBookStackMigrationReport(report));
  return { run, pages, report, artifact };
}

const existing = (items: Array<Record<string, unknown>>, name: string, parent: string, parentId: number) =>
  items.filter((item) => item.name === name && itemParent(item, parent) === parentId);

async function ensurePage(client: BookStackClient, page: TargetPage, shelves: Map<string, number>) {
  const shelfId = shelves.get(page.shelfName);
  if (!shelfId) throw new Error("bookstack_shelf_missing");
  const books = await client.listBooks();
  const bookMatches = books.filter((book) => book.name === page.bookName);
  const book = bookMatches.length === 1 ? bookMatches[0] : bookMatches.length === 0 ? await client.createBook(page.bookName) : (() => { throw new Error("bookstack_identity_ambiguous"); })();
  await client.addBookToShelf(shelfId, book.id);
  const chapters = await client.listChapters();
  const chapterMatches = existing(chapters, page.chapterName, "book_id", book.id);
  const chapter = chapterMatches.length === 1 ? chapterMatches[0] : chapterMatches.length === 0
    ? await client.createChapter(page.chapterName, book.id, `lifecycle/source grouping for ${page.chapterName}`)
    : (() => { throw new Error("bookstack_identity_ambiguous"); })();
  const pages = await client.listPages();
  const matches = existing(pages, page.pageName, "chapter_id", chapter.id);
  if (matches.length > 1) throw new Error("bookstack_identity_ambiguous");
  if (matches.length === 1) {
    const read = await client.readPage(matches[0].id);
    const markdown = typeof read.markdown === "string" ? read.markdown : "";
    return extractSourceBody(markdown) === page.body ? { status: "unchanged" as const, targetId: read.id } : { status: "conflict" as const, targetId: read.id };
  }
  const created = await client.createPage(page.pageName, chapter.id, page.markdown);
  const read = await client.readPage(created.id);
  const markdown = typeof read.markdown === "string" ? read.markdown : "";
  return extractSourceBody(markdown) === page.body ? { status: "created" as const, targetId: created.id } : { status: "unverified" as const, targetId: created.id };
}

export async function applyBookStackMigration(input: { projectRoot: string; dryRunReportPath: string; bookStack: Parameters<typeof createBookStackClient>[0] }) {
  const report = parseBookStackMigrationReport(JSON.parse(await readProjectArtifact(input.projectRoot, input.dryRunReportPath)));
  if (!report || report.outcomes.some((outcome) => outcome.status !== "unverified")) throw new Error("migration_report_not_ready");
  const runDirectory = input.dryRunReportPath.replace(/\/dry-run-report\.json$/, "");
  const inventory = JSON.parse(await readProjectArtifact(input.projectRoot, `${runDirectory}/inventory.json`)) as TargetPage[];
  const spec = await readBookStackMigrationSpec(`${input.projectRoot}/${runDirectory}/spec.json`);
  if (sourceFingerprint(await migrationPages(spec)) !== report.sourceFingerprint) throw new Error("migration_source_changed");
  const client = createBookStackClient(input.bookStack);
  const shelves = new Map<string, number>();
  for (const name of ["Lifecycle Artifacts", "Institutional Knowledge"] as const) shelves.set(name, (await client.resolveShelf(name)).id);
  const outcomes = [];
  for (const page of inventory) {
    const result = await ensurePage(client, page, shelves);
    outcomes.push({ sourceId: page.sourceId, sourceHash: page.sourceHash, ...result });
  }
  const finalReport = buildBookStackMigrationReport({ ...report, outcomes });
  const run: BookStackArtifactRun = { projectRoot: input.projectRoot, directory: `${input.projectRoot}/${runDirectory}`, runId: report.runId };
  return { report: finalReport, artifact: await writeImmutableArtifact(run, "final-report.json", serializeBookStackMigrationReport(finalReport)) };
}

export async function verifyBookStackMigration(input: { projectRoot: string; reportPath: string }) {
  const report = parseBookStackMigrationReport(JSON.parse(await readProjectArtifact(input.projectRoot, input.reportPath)));
  if (!report) throw new Error("migration_report_invalid");
  return { verified: report.summary.conflict === 0 && report.summary.failed === 0 && report.summary.unverified === 0, report };
}

export async function cleanupBookStackMigration(input: { projectRoot: string; reportPath: string; bookStack: Parameters<typeof createBookStackClient>[0] }) {
  const report = parseBookStackMigrationReport(JSON.parse(await readProjectArtifact(input.projectRoot, input.reportPath)));
  if (!report) throw new Error("migration_report_invalid");
  const runDirectory = input.reportPath.replace(/\/(?:dry-run|final)-report\.json$/, "");
  const inventory = JSON.parse(await readProjectArtifact(input.projectRoot, `${runDirectory}/inventory.json`)) as TargetPage[];
  const bySourceId = new Map(inventory.map((page) => [page.sourceId, page]));
  const client = createBookStackClient(input.bookStack);
  const deleted: number[] = [];
  for (const outcome of report.outcomes) {
    if (outcome.status !== "created" || outcome.targetId === undefined) continue;
    const page = bySourceId.get(outcome.sourceId);
    if (!page || page.sourceHash !== outcome.sourceHash) throw new Error("cleanup_inventory_invalid");
    const current = await client.readPage(outcome.targetId);
    if (extractSourceBody(typeof current.markdown === "string" ? current.markdown : "") !== page.body) {
      throw new Error("cleanup_page_human_edited");
    }
    await client.deletePage(outcome.targetId);
    deleted.push(outcome.targetId);
  }
  return { deleted };
}
