import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { enumerateMarkdownGit } from "../lib/bookstack-migrate-markdown.ts";

const run = promisify(execFile);
const git = (cwd, args) => run("/usr/bin/git", args, { cwd });

const repository = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-pi-bookstack-markdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Migration test"]);
  await writeFile(join(root, "architecture.md"), "---\ntype: architecture\n---\n# Canonical source\n");
  await git(root, ["add", "architecture.md"]);
  await git(root, ["commit", "-qm", "fixture"]);
  return root;
};

test("reads a clean pinned Git source through the fixed system Git path", async (t) => {
  const root = await repository(t);
  const { stdout } = await git(root, ["rev-parse", "HEAD"]);
  const sources = await enumerateMarkdownGit({ root, commit: stdout.trim() });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].body, "---\ntype: architecture\n---\n# Canonical source\n");
  assert.equal(sources[0].artifactType, "architecture");
});

test("rejects a dirty canonical Git source", async (t) => {
  const root = await repository(t);
  const { stdout } = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "untracked.md"), "# not pinned\n");
  await assert.rejects(enumerateMarkdownGit({ root, commit: stdout.trim() }), /git_tree_dirty/);
});
