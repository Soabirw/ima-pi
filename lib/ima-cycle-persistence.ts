import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CYCLE_ROOT_MARKERS,
  CYCLE_STORE_FILENAME,
  CYCLE_STORE_GITIGNORE_BODY,
  cycleStorePaths,
  parseCycleRecord,
  selectProjectRoot,
  serializeCycleRecord,
} from "./ima-cycle-store.ts";
import type { CycleState } from "./ima-cycle.ts";

export type CycleCurrent = () => boolean;
export type CyclePersistenceOptions = { isCurrent?: CycleCurrent };
export type ResolveCycleProjectRoot = (cwd: string) => Promise<string>;

const current = (isCurrent?: CycleCurrent) => isCurrent?.() ?? true;
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : "";
const isWithinRoot = (root: string, path: string) => {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
};
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
const ancestorDirectories = (cwd: string): string[] => {
  const directories: string[] = [];
  for (let currentDirectory = resolve(cwd); ; currentDirectory = dirname(currentDirectory)) {
    directories.push(currentDirectory);
    if (dirname(currentDirectory) === currentDirectory) return directories;
  }
};

export const defaultResolveCycleProjectRoot: ResolveCycleProjectRoot = async (cwd) => {
  const root = resolve(cwd);
  const marks = await Promise.all(ancestorDirectories(root).map(async (dir) => ({
    dir,
    hasMarker: (await Promise.all(CYCLE_ROOT_MARKERS.map((marker) => pathExists(join(dir, marker))))).some(Boolean),
  })));
  return selectProjectRoot(root, marks);
};

const requireCurrent = (isCurrent?: CycleCurrent) => {
  if (!current(isCurrent)) throw new Error("cycle_state_stale");
};
const resolveCycleStoreRoot = async (cwd: string, resolveProjectRoot: ResolveCycleProjectRoot) =>
  realpath(await resolveProjectRoot(cwd));
const verifyCycleStoreDirectory = async (root: string, create: boolean) => {
  const paths = cycleStorePaths(root);
  if (create) await mkdir(paths.dir, { recursive: true });
  const details = await lstat(paths.dir);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("cycle_store_directory_invalid");
  const canonicalDirectory = await realpath(paths.dir);
  if (!isWithinRoot(root, canonicalDirectory)) throw new Error("cycle_store_path_invalid");
  return paths;
};
const verifySafeRegularFile = async (root: string, path: string) => {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("cycle_store_file_invalid");
  const canonicalPath = await realpath(path);
  if (!isWithinRoot(root, canonicalPath)) throw new Error("cycle_store_path_invalid");
  return canonicalPath;
};
const verifyExistingSafeRegularFile = async (root: string, path: string) => {
  try {
    return await verifySafeRegularFile(root, path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};
const writeCycleStoreGitignore = async (root: string, path: string): Promise<void> => {
  try {
    await writeFile(path, CYCLE_STORE_GITIGNORE_BODY, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const safePath = await verifySafeRegularFile(root, path);
  if (await readFile(safePath, "utf8") !== CYCLE_STORE_GITIGNORE_BODY) throw new Error("cycle_store_gitignore_invalid");
};
const writeCycleStoreState = async (
  root: string,
  path: string,
  state: CycleState,
  options: CyclePersistenceOptions = {},
): Promise<void> => {
  const temporary = join(dirname(path), `.${CYCLE_STORE_FILENAME}.${randomUUID()}.tmp`);
  const serialized = serializeCycleRecord(state);
  try {
    requireCurrent(options.isCurrent);
    await verifyExistingSafeRegularFile(root, path);
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
    } finally {
      await handle.close();
    }
    requireCurrent(options.isCurrent);
    await verifySafeRegularFile(root, temporary);
    await verifyExistingSafeRegularFile(root, path);
    requireCurrent(options.isCurrent);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export const loadDurableStateWith = (resolveProjectRoot: ResolveCycleProjectRoot) => async (cwd: string): Promise<CycleState | null> => {
  try {
    const root = await resolveCycleStoreRoot(cwd, resolveProjectRoot);
    const paths = await verifyCycleStoreDirectory(root, false);
    const safePath = await verifySafeRegularFile(root, paths.file);
    return parseCycleRecord(await readFile(safePath, "utf8"));
  } catch {
    return null;
  }
};

export const persistDurableStateWith = (resolveProjectRoot: ResolveCycleProjectRoot) => async (
  cwd: string,
  state: CycleState,
  options: CyclePersistenceOptions = {},
): Promise<void> => {
  requireCurrent(options.isCurrent);
  const root = await resolveCycleStoreRoot(cwd, resolveProjectRoot);
  requireCurrent(options.isCurrent);
  const paths = await verifyCycleStoreDirectory(root, true);
  requireCurrent(options.isCurrent);
  await writeCycleStoreGitignore(root, paths.gitignore);
  requireCurrent(options.isCurrent);
  await writeCycleStoreState(root, paths.file, state, options);
};
