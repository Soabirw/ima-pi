import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parseFrontMatter, sourceHash, type MigrationSource } from "./bookstack-migrate-source.ts";

const EXCLUDED_NAMES = new Set(["README.md", "CONTRIBUTING.md", "CLAUDE.md"]);
const EXCLUDED_DIRECTORIES = new Set(["scripts", ".serena", ".claude"]);

const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
const relativePath = (root: string, path: string) => relative(root, path).split(sep).join("/");
const isExcluded = (path: string) => path.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part));

const checkedRoot = async (root: string) => {
  const resolved = resolve(root);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("markdown_root_invalid");
  return resolved;
};

const readMarkdownFiles = async (root: string, directory: string, signal?: AbortSignal): Promise<string[]> => {
  signal?.throwIfAborted();
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    signal?.throwIfAborted();
    if (!entry.name || entry.name === "." || entry.name === "..") throw new Error("markdown_path_invalid");
    const path = resolve(directory, entry.name);
    if (!within(root, path)) throw new Error("markdown_path_escape");
    const sourcePath = relativePath(root, path);
    if (isExcluded(sourcePath)) continue;
    if (entry.isSymbolicLink()) throw new Error("markdown_symlink_invalid");
    if (entry.isDirectory()) {
      files.push(...await readMarkdownFiles(root, path, signal));
      continue;
    }
    if (!entry.name.endsWith(".md") || EXCLUDED_NAMES.has(entry.name)) continue;
    if (!entry.isFile()) throw new Error("markdown_file_invalid");
    files.push(path);
  }
  return files;
};

export type MarkdownWorkingTreeInput = { root: string; signal?: AbortSignal };

export async function enumerateMarkdownWorkingTree(input: MarkdownWorkingTreeInput): Promise<MigrationSource[]> {
  const root = await checkedRoot(input.root);
  const sources: MigrationSource[] = [];
  for (const path of await readMarkdownFiles(root, root, input.signal)) {
    input.signal?.throwIfAborted();
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("markdown_file_invalid");
    const markdown = await readFile(path, "utf8");
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("markdown_source_changed");
    }
    const { attributes } = parseFrontMatter(markdown);
    const sourcePath = relativePath(root, path);
    sources.push({
      kind: "knowledge",
      sourceOrigin: "filesystem",
      sourceId: `filesystem:${sourcePath}`,
      project: "ima-rag",
      artifactType: attributes.type || "knowledge",
      sourceRefs: [`path:${sourcePath}`],
      createdAt: before.mtime.toISOString(),
      author: attributes.author || "legacy-unknown",
      body: markdown,
      sourceHash: sourceHash(markdown),
      path: sourcePath,
    });
  }
  return sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

const fingerprint = (sources: MigrationSource[]) => sourceHash(
  sources.map((source) => `${source.sourceId}\0${source.sourceHash}`).join("\n"),
);

export async function stableMarkdownSnapshot(input: MarkdownWorkingTreeInput) {
  const first = await enumerateMarkdownWorkingTree(input);
  const second = await enumerateMarkdownWorkingTree(input);
  const sourceFingerprint = fingerprint(first);
  if (sourceFingerprint !== fingerprint(second)) throw new Error("markdown_snapshot_unstable");
  return { sources: first, fingerprint: sourceFingerprint };
}
