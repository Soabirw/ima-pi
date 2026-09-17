import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const promptPath = join(root, "prompts", "ima:bookstack-migrate.md");
const skillPath = join(root, "skills", "ima-bookstack-migrate", "SKILL.md");
const packagedSpecPath = resolve(
  dirname(skillPath),
  "../../config/bookstack-migrations/shared-dev-memory.json",
);
const has = (text, value) => assert.match(
  text,
  new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
);

test("guided BookStack migration resolves the packaged spec outside a caller checkout", async () => {
  const callerRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-guided-"));
  const shadowSpecPath = join(
    callerRoot,
    "config",
    "bookstack-migrations",
    "shared-dev-memory.json",
  );

  try {
    await mkdir(dirname(shadowSpecPath), { recursive: true });
    await writeFile(shadowSpecPath, '{"schemaVersion":999}\n', "utf8");

    assert.equal(
      packagedSpecPath,
      join(root, "config", "bookstack-migrations", "shared-dev-memory.json"),
    );
    assert.notEqual(packagedSpecPath, shadowSpecPath);
    assert.deepEqual(JSON.parse(await readFile(packagedSpecPath, "utf8")), {
      schemaVersion: 1,
      lifecycle: {
        collection: "ima-institutional-memory",
        shelfName: "Lifecycle Artifacts",
      },
      knowledge: { shelfName: "Institutional Knowledge" },
    });

    const skill = await readFile(skillPath, "utf8");
    has(skill, "from the directory containing this loaded package `SKILL.md`");
    has(skill, "Never select a caller-local same-name shadow spec.");
    has(skill, "must work when the caller is outside the package checkout");
  } finally {
    await rm(callerRoot, { recursive: true, force: true });
  }
});

test("guided BookStack migration preserves report routing and independent gates", async () => {
  const [prompt, skill, readme, changelog] = await Promise.all([
    readFile(promptPath, "utf8"),
    readFile(skillPath, "utf8"),
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "CHANGELOG.md"), "utf8"),
  ]);

  for (const value of [
    "Empty arguments: begin guided setup.",
    "Do not ask the operator to locate, author, or choose a spec path.",
    "specPath: packagedSpecPath",
    "dry-run <spec-path>",
    "preflight <report-path>",
    "canary <report-path> confirm",
    "apply <report-path> confirm",
    "verify <report-path>",
    "cleanup <report-path> confirm",
  ]) has(prompt, value);

  for (const value of [
    "Preparation and canonical packaged spec",
    "Dry-run",
    "Review",
    "Preflight",
    "Canary",
    "Canary verification",
    "Apply",
    "Final verification",
    "Optional cleanup",
    "A literal confirmation token is an implementation input",
    "Never carry approval across reports, reruns, interrupted operations, or sessions.",
    "On cancellation",
    "fail closed",
    "Do not retry automatically",
    "Record-level Qdrant and page-mapping problems remain itemized quarantines",
    "Newly appended lifecycle records remain a separately reported deferred delta",
  ]) has(skill, value);

  assert.match(
    skill,
    /preflight, canary, and apply receive the original dry-run report; verify receives the returned canary or final report; cleanup receives a separately approved eligible creation report/i,
  );
  assert.match(
    skill,
    /Only then call `\{ operation: "canary", reportPath: originalDryRunReportPath, confirm: "canary-report" \}`/,
  );
  assert.match(
    skill,
    /then call `\{ operation: "apply", reportPath: originalDryRunReportPath, confirm: "apply-report" \}`/,
  );
  assert.match(
    skill,
    /only after separate review and a fresh explicit approval[\s\S]*confirm: "cleanup-report"/i,
  );

  has(readme, "caller-local shadow spec is never selected");
  has(readme, "cleanup is a destructive external BookStack write/delete");
  has(readme, "Separately approved cleanup may read and recycle only report-created Pages");
  has(changelog, "Made bare `/ima:bookstack-migrate` start package-relative guided preparation");
});
