import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, sep } from "node:path";
import { parseFrontMatter, sourceHash, type MigrationSource } from "./bookstack-migrate-source.ts";

const run = promisify(execFile);
const COMMIT = /^[0-9a-f]{40}$/i;
const EXCLUDED = new Set(["README.md", "CONTRIBUTING.md", "CLAUDE.md"]);
const blockedPath = (path: string) => path.startsWith("scripts/") || path.startsWith(".serena/") || path.startsWith(".claude/");
const SYSTEM_GIT_PATH = "/usr/local/bin:/usr/bin:/bin";

const git = async (root: string, args: string[], signal?: AbortSignal) => {
  try {
    const result = await run("git", args, {
      cwd: root,
      encoding: "utf8",
      signal,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      env: { PATH: SYSTEM_GIT_PATH },
    });
    return result.stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    throw new Error(code === "ENOENT" ? "git_unavailable" : "git_command_failed");
  }
};

export type MarkdownGitInput = { root: string; commit: string; signal?: AbortSignal };

export async function enumerateMarkdownGit(input: MarkdownGitInput): Promise<MigrationSource[]> {
  if (!COMMIT.test(input.commit)) throw new Error("git_commit_invalid");
  const root = resolve(input.root);
  const revision = (await git(root, ["rev-parse", "--verify", `${input.commit}^{commit}`], input.signal)).trim();
  if (revision.toLowerCase() !== input.commit.toLowerCase()) throw new Error("git_commit_mismatch");
  if ((await git(root, ["status", "--porcelain"], input.signal)).trim()) throw new Error("git_tree_dirty");
  const tracked = await git(root, ["ls-tree", "-r", "--name-only", input.commit], input.signal);
  const paths = tracked.split("\n").filter((path) => path.endsWith(".md") && !EXCLUDED.has(path.split("/").at(-1)!) && !blockedPath(path));
  const sources: MigrationSource[] = [];
  for (const path of paths.sort()) {
    if (path.includes("\\") || path.split("/").some((part) => part === ".." || !part)) throw new Error("git_path_invalid");
    const absolute = resolve(root, path);
    if (!(absolute === root || absolute.startsWith(`${root}${sep}`)) || relative(root, absolute).startsWith("..")) throw new Error("git_path_escape");
    const markdown = await git(root, ["show", `${input.commit}:${path}`], input.signal);
    const { attributes } = parseFrontMatter(markdown);
    sources.push({
      kind: "knowledge",
      sourceId: `git:${input.commit}:${path}`,
      project: "ima-rag",
      artifactType: attributes.type || "knowledge",
      sourceRefs: [`git:${input.commit}`, `path:${path}`],
      createdAt: attributes.created_at || "legacy-unknown",
      author: attributes.author || "legacy-unknown",
      body: markdown,
      sourceHash: sourceHash(markdown),
      path,
      commit: input.commit.toLowerCase(),
    });
  }
  return sources;
}
