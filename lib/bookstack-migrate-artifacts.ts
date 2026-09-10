import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const ROOT = ".ima/bookstack-migrate";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

export type BookStackArtifactRun = { projectRoot: string; directory: string; runId: string };

export async function createBookStackArtifactRun(projectRoot: string, now = new Date()): Promise<BookStackArtifactRun> {
  const root = resolve(projectRoot);
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(root, ROOT, runId);
  if (!inside(root, directory)) throw new Error("artifact_path_invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { projectRoot: root, directory, runId };
}

export async function writeImmutableArtifact(run: BookStackArtifactRun, name: string, content: string): Promise<{ path: string; sha256: string }> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || Buffer.byteLength(content, "utf8") > 512 * 1024) throw new Error("artifact_invalid");
  const path = resolve(run.directory, name);
  if (!inside(run.directory, path)) throw new Error("artifact_path_invalid");
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
  return { path: relative(run.projectRoot, path), sha256: hash(content) };
}

export async function readProjectArtifact(projectRoot: string, path: string): Promise<string> {
  const root = resolve(projectRoot);
  const absolute = resolve(root, path);
  if (!inside(resolve(root, ROOT), absolute)) throw new Error("artifact_path_invalid");
  return readFile(absolute, "utf8");
}

export async function acquireBookStackMigrationLock(projectRoot: string): Promise<() => Promise<void>> {
  const path = resolve(projectRoot, ROOT, ".lock");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(path, "wx", 0o600); } catch { throw new Error("migration_in_progress"); }
  return async () => { await handle.close(); await unlink(path); };
}
