import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  createBookStackArtifactRun,
  readBookStackInventory,
  readProjectArtifact,
  writeBookStackInventory,
  writeImmutableArtifact,
  writeReplaceableArtifact,
  type BookStackArtifactRun,
} from "./bookstack-migrate-artifacts.ts";
import {
  applyBookStackPages,
  buildBookStackCatalog,
  emptyBookStackCatalog,
} from "./bookstack-migrate-apply.ts";
import { selectBookStackCanaryPages } from "./bookstack-migrate-canary.ts";
import { createBookStackClient } from "./bookstack-migrate-client.ts";
import { stableMarkdownSnapshot } from "./bookstack-migrate-markdown.ts";
import {
  boundedErrorCode,
  buildApplyPreflightReport,
  buildApplySourceDelta,
  inventoryFingerprint,
  parseApplySourceDelta,
  preflightFailureStatus,
  revalidateMigrationSources,
  type PreflightCheck,
} from "./bookstack-migrate-preflight.ts";
import { lifecycleSnapshot } from "./bookstack-migrate-qdrant.ts";
import { DEFAULT_QDRANT_URL, resolveCorpusEndpoint } from "./qdrant-http-boundary.ts";
import {
  buildBookStackMigrationReport,
  parseBookStackMigrationReport,
  serializeBookStackMigrationReport,
  type BookStackMigrationReport,
} from "./bookstack-migrate-report.ts";
import {
  deterministicPages,
  sourceBodyMatches,
  type QuarantineOutcome,
  type TargetPage,
} from "./bookstack-migrate-source.ts";

export type BookStackMigrationSpec = {
  schemaVersion: 1;
  lifecycle: { collection: string; qdrantOrigin?: string; shelfName: "Lifecycle Artifacts" };
  knowledge: { root?: string; shelfName: "Institutional Knowledge" };
};

type MigrationSnapshot = {
  pages: TargetPage[];
  quarantined: QuarantineOutcome[];
  fingerprint: string;
};
type MigrationClientInput = Parameters<typeof createBookStackClient>[0];
type PreparedApply = {
  run: BookStackArtifactRun;
  report: BookStackMigrationReport;
  inventory: TargetPage[];
  validation: ReturnType<typeof revalidateMigrationSources>;
  client: ReturnType<typeof createBookStackClient>;
  catalog: Awaited<ReturnType<typeof buildBookStackCatalog>>;
};

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const parseBookStackMigrationSpec = (value: unknown): BookStackMigrationSpec => {
  const parsed = value as BookStackMigrationSpec;
  if (parsed?.schemaVersion !== 1 || !parsed.lifecycle || !parsed.knowledge
    || parsed.lifecycle.shelfName !== "Lifecycle Artifacts"
    || parsed.knowledge.shelfName !== "Institutional Knowledge") {
    throw new Error("migration_spec_invalid");
  }
  return parsed;
};

export async function readBookStackMigrationSpec(path: string): Promise<BookStackMigrationSpec> {
  return parseBookStackMigrationSpec(JSON.parse(await readFile(path, "utf8")));
}

export async function migrationSnapshot(
  spec: BookStackMigrationSpec,
  signal?: AbortSignal,
): Promise<MigrationSnapshot> {
  const qdrantOrigin = resolveCorpusEndpoint(
    spec.lifecycle.qdrantOrigin || process.env.IMA_QDRANT_URL,
    DEFAULT_QDRANT_URL,
  );
  const knowledgeRoot = spec.knowledge.root || process.env.IMA_RAG_ROOT;
  if (!qdrantOrigin || !knowledgeRoot) throw new Error("migration_binding_missing");
  const [lifecycle, knowledge] = await Promise.all([
    lifecycleSnapshot({ origin: qdrantOrigin, collection: spec.lifecycle.collection, signal }),
    stableMarkdownSnapshot({ root: knowledgeRoot, signal }),
  ]);
  const pages = deterministicPages([...lifecycle.sources, ...knowledge.sources]);
  return {
    ...pages,
    quarantined: [...lifecycle.quarantined, ...pages.quarantined]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    fingerprint: inventoryFingerprint(pages.pages),
  };
}

export async function dryRunBookStackMigration(input: {
  projectRoot: string;
  specPath: string;
  signal?: AbortSignal;
}) {
  const specText = await readFile(input.specPath, "utf8");
  const spec = parseBookStackMigrationSpec(JSON.parse(specText));
  const snapshot = await migrationSnapshot(spec, input.signal);
  const run = await createBookStackArtifactRun(input.projectRoot);
  await writeImmutableArtifact(run, "spec.json", specText);
  await writeBookStackInventory(run, snapshot.pages);
  await writeImmutableArtifact(run, "quarantine.json", `${JSON.stringify(snapshot.quarantined, null, 2)}\n`);
  const report = buildBookStackMigrationReport({
    runId: run.runId,
    specHash: hash(specText),
    sourceFingerprint: snapshot.fingerprint,
    outcomes: [
      ...snapshot.pages.map((page) => ({
        sourceId: page.sourceId,
        sourceHash: page.sourceHash,
        status: "unverified" as const,
      })),
      ...snapshot.quarantined,
    ].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  });
  const artifact = await writeImmutableArtifact(
    run,
    "dry-run-report.json",
    serializeBookStackMigrationReport(report),
  );
  return { run, ...snapshot, report, artifact };
}

const runFromReport = (projectRoot: string, reportPath: string): BookStackArtifactRun => {
  const match = reportPath.match(/^\.ima\/bookstack-migrate\/([A-Za-z0-9._-]{1,128})\/dry-run-report\.json$/);
  if (!match) throw new Error("migration_report_path_invalid");
  const directory = dirname(reportPath);
  return { projectRoot: resolve(projectRoot), directory: resolve(projectRoot, directory), runId: match[1] };
};

const parseJson = (text: string, code: string) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
};

async function prepareApply(input: {
  projectRoot: string;
  dryRunReportPath: string;
  bookStack: MigrationClientInput;
  signal?: AbortSignal;
  checks?: PreflightCheck[];
}): Promise<PreparedApply> {
  const run = runFromReport(input.projectRoot, input.dryRunReportPath);
  const report = parseBookStackMigrationReport(parseJson(
    await readProjectArtifact(input.projectRoot, input.dryRunReportPath),
    "migration_report_invalid",
  ));
  if (!report || report.outcomes.some((outcome) =>
    outcome.status !== "unverified" && outcome.status !== "quarantined")) {
    throw new Error("migration_report_not_ready");
  }
  input.checks?.push({ name: "report", status: "PASS" });

  const inventory = await readBookStackInventory(input.projectRoot, `${dirname(input.dryRunReportPath)}/inventory.json`);
  input.checks?.push({ name: "inventory", status: "PASS" });

  const specText = await readProjectArtifact(input.projectRoot, `${dirname(input.dryRunReportPath)}/spec.json`);
  if (hash(specText) !== report.specHash) throw new Error("migration_spec_changed");
  const spec = parseBookStackMigrationSpec(parseJson(specText, "migration_spec_invalid"));
  const fresh = await migrationSnapshot(spec, input.signal);
  const validation = revalidateMigrationSources({
    inventory,
    reportFingerprint: report.sourceFingerprint,
    freshPages: fresh.pages,
    approvedQuarantined: report.outcomes.filter((outcome) => outcome.status === "quarantined"),
    freshQuarantined: fresh.quarantined,
  });
  input.checks?.push({ name: "sources", status: "PASS" });

  const client = createBookStackClient({ ...input.bookStack, signal: input.signal });
  input.checks?.push({ name: "configuration", status: "PASS" });
  const catalog = inventory.length > 0
    ? await buildBookStackCatalog(client)
    : emptyBookStackCatalog();
  input.checks?.push({ name: "catalog", status: "PASS" });
  return { run, report, inventory, validation, client, catalog };
}

async function persistSourceDelta(prepared: PreparedApply) {
  const delta = buildApplySourceDelta(prepared.run.runId, prepared.validation.appendedLifecycle);
  const artifact = await writeReplaceableArtifact(
    prepared.run,
    "apply-source-delta.json",
    `${JSON.stringify(delta, null, 2)}\n`,
  );
  const stored = parseApplySourceDelta(parseJson(
    await readProjectArtifact(prepared.run.projectRoot, artifact.path),
    "apply_source_delta_invalid",
  ));
  if (!stored || stored.runId !== prepared.run.runId || stored.appendedCount !== delta.appendedCount) {
    throw new Error("apply_source_delta_invalid");
  }
  return { delta, artifact };
}

export async function preflightBookStackMigration(input: {
  projectRoot: string;
  dryRunReportPath: string;
  bookStack?: MigrationClientInput;
  configurationError?: unknown;
  signal?: AbortSignal;
}) {
  const run = runFromReport(input.projectRoot, input.dryRunReportPath);
  const checks: PreflightCheck[] = [];
  let prepared: PreparedApply | null = null;
  try {
    if (input.configurationError) throw input.configurationError;
    if (!input.bookStack) throw new Error("bookstack_base_url_required");
    prepared = await prepareApply({ ...input, bookStack: input.bookStack, checks });
    await persistSourceDelta(prepared);
    checks.push({ name: "source-delta", status: "PASS" });
  } catch (error) {
    const code = boundedErrorCode(error);
    checks.push({ name: "blocked", status: preflightFailureStatus(code), code });
  }
  const report = buildApplyPreflightReport(run.runId, checks);
  const artifact = await writeReplaceableArtifact(
    run,
    "apply-preflight-report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return { report, artifact, prepared };
}

export async function applyBookStackMigration(input: {
  projectRoot: string;
  dryRunReportPath: string;
  bookStack: MigrationClientInput;
  signal?: AbortSignal;
}) {
  const prepared = await prepareApply(input);
  await persistSourceDelta(prepared);
  const outcomes = await applyBookStackPages({
    client: prepared.client,
    catalog: prepared.catalog,
    pages: prepared.inventory,
    initialOutcomes: prepared.report.outcomes.filter((outcome) => outcome.status === "quarantined"),
  });
  const finalReport = buildBookStackMigrationReport({ ...prepared.report, outcomes });
  const artifact = await writeReplaceableArtifact(
    prepared.run,
    "final-report.json",
    serializeBookStackMigrationReport(finalReport),
  );
  return { report: finalReport, artifact };
}

export async function canaryBookStackMigration(input: {
  projectRoot: string;
  dryRunReportPath: string;
  bookStack: MigrationClientInput;
  signal?: AbortSignal;
}) {
  const prepared = await prepareApply(input);
  await persistSourceDelta(prepared);
  const selected = selectBookStackCanaryPages(prepared.inventory);
  const outcomes = await applyBookStackPages({
    client: prepared.client,
    catalog: prepared.catalog,
    pages: selected,
  });
  const report = buildBookStackMigrationReport({ ...prepared.report, outcomes });
  const artifact = await writeReplaceableArtifact(
    prepared.run,
    "canary-report.json",
    serializeBookStackMigrationReport(report),
  );
  return { report, artifact, selected: selected.map((page) => page.sourceId) };
}

export async function verifyBookStackMigration(input: { projectRoot: string; reportPath: string }) {
  const report = parseBookStackMigrationReport(parseJson(
    await readProjectArtifact(input.projectRoot, input.reportPath),
    "migration_report_invalid",
  ));
  if (!report) throw new Error("migration_report_invalid");
  return {
    verified: report.summary.conflict === 0 && report.summary.failed === 0 && report.summary.unverified === 0,
    report,
  };
}

export async function cleanupBookStackMigration(input: {
  projectRoot: string;
  reportPath: string;
  bookStack: MigrationClientInput;
}) {
  const report = parseBookStackMigrationReport(parseJson(
    await readProjectArtifact(input.projectRoot, input.reportPath),
    "migration_report_invalid",
  ));
  if (!report) throw new Error("migration_report_invalid");
  const runDirectory = input.reportPath.replace(/\/(?:dry-run|final|canary)-report\.json$/, "");
  if (runDirectory === input.reportPath) throw new Error("migration_report_path_invalid");
  const inventory = await readBookStackInventory(input.projectRoot, `${runDirectory}/inventory.json`);
  const bySourceId = new Map(inventory.map((page) => [page.sourceId, page]));
  const client = createBookStackClient(input.bookStack);
  const deleted: number[] = [];
  for (const outcome of report.outcomes) {
    if (outcome.status !== "created" || outcome.targetId === undefined) continue;
    const page = bySourceId.get(outcome.sourceId);
    if (!page || page.sourceHash !== outcome.sourceHash) throw new Error("cleanup_inventory_invalid");
    const current = await client.readPage(outcome.targetId);
    if (!sourceBodyMatches(typeof current.markdown === "string" ? current.markdown : "", page.body)) {
      throw new Error("cleanup_page_human_edited");
    }
    await client.deletePage(outcome.targetId);
    deleted.push(outcome.targetId);
  }
  return { deleted };
}
