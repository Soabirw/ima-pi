import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enumerateMarkdownWorkingTree } from "../lib/bookstack-migrate-markdown.ts";

const sourceRoot = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-pi-bookstack-markdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test("reads current working-tree Markdown without Git state", async (t) => {
  const root = await sourceRoot(t);
  await mkdir(join(root, "architecture", "nested"), { recursive: true });
  await writeFile(join(root, "architecture", "nested", "current.md"), "---\ntype: architecture\n---\n# Current source\n");
  await writeFile(join(root, "architecture", "README.md"), "# Excluded\n");
  await writeFile(join(root, "untracked.md"), "# Included without Git\n");
  const sources = await enumerateMarkdownWorkingTree({ root });
  assert.deepEqual(sources.map((source) => source.sourceId), [
    "filesystem:architecture/nested/current.md",
    "filesystem:untracked.md",
  ]);
  assert.equal(sources[0].artifactType, "architecture");
  assert.equal(sources[0].sourceOrigin, "filesystem");
});

test("rejects Markdown symlinks instead of following them", async (t) => {
  const root = await sourceRoot(t);
  const outside = join(root, "outside.md");
  await writeFile(outside, "# Outside\n");
  await symlink(outside, join(root, "escape.md"));
  await assert.rejects(enumerateMarkdownWorkingTree({ root }), /markdown_symlink_invalid/);
});

test("ignores cache symlinks in excluded dot-directories", async (t) => {
  const root = await sourceRoot(t);
  const cache = join(root, ".fastembed_cache");
  const outside = join(root, "model.bin");
  await mkdir(join(root, "knowledge"), { recursive: true });
  await mkdir(cache, { recursive: true });
  await writeFile(join(root, "knowledge", "current.md"), "# Current source\n");
  await writeFile(outside, "model cache", "utf8");
  await symlink(outside, join(cache, "model-link"));

  const sources = await enumerateMarkdownWorkingTree({ root });

  assert.deepEqual(sources.map((source) => source.sourceId), ["filesystem:knowledge/current.md"]);
});
