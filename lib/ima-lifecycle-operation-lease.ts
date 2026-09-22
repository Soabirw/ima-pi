import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { acquireNativeFileLock } from "./ima-agent-session-lock.ts";

export const LIFECYCLE_OPERATION_LEASE_DIRECTORY = ".ima-cycle";
export const LIFECYCLE_OPERATION_LEASE_TARGET = "ima-lifecycle-operation";

const PRIVATE_DIRECTORY_MODE = 0o700;

export type LifecycleOperationLeaseResult =
  | {
    status: "acquired";
    root: string;
    directory: string;
    release: () => Promise<void>;
  }
  | { status: "busy" }
  | { status: "missing" }
  | { status: "unavailable" };

const isInside = (root: string, path: string) => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
};

const canonicalRoot = async (value: unknown): Promise<string | null> => {
  if (typeof value !== "string" || !isAbsolute(value)) return null;
  try {
    const before = await lstat(value);
    if (!before.isDirectory() || before.isSymbolicLink()) return null;
    const root = await realpath(value);
    const after = await lstat(root);
    return after.isDirectory() && !after.isSymbolicLink() && root === resolve(value)
      ? root
      : null;
  } catch {
    return null;
  }
};

const isMissing = (error: unknown): boolean => Boolean(
  error
  && typeof error === "object"
  && "code" in error
  && (error as { code?: unknown }).code === "ENOENT",
);

const canonicalLeaseDirectory = async (input: {
  root: string;
  createDirectory: boolean;
}): Promise<{ status: "ready"; directory: string } | { status: "missing" | "unavailable" }> => {
  const candidate = join(input.root, LIFECYCLE_OPERATION_LEASE_DIRECTORY);
  try {
    if (input.createDirectory) {
      await mkdir(candidate, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    }
    const before = await lstat(candidate);
    if (!before.isDirectory() || before.isSymbolicLink()) return { status: "unavailable" };
    const directory = await realpath(candidate);
    if (!isInside(input.root, directory) || directory !== resolve(candidate)) {
      return { status: "unavailable" };
    }
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
    const after = await lstat(directory);
    return after.isDirectory()
      && !after.isSymbolicLink()
      && (after.mode & 0o777) === PRIVATE_DIRECTORY_MODE
      ? { status: "ready", directory }
      : { status: "unavailable" };
  } catch (error) {
    return isMissing(error)
      ? { status: "missing" }
      : { status: "unavailable" };
  }
};

export const acquireLifecycleOperationLease = async (input: {
  root: unknown;
  createDirectory?: boolean;
}): Promise<LifecycleOperationLeaseResult> => {
  const root = await canonicalRoot(input.root);
  if (!root) return { status: "unavailable" };

  const prepared = await canonicalLeaseDirectory({
    root,
    createDirectory: input.createDirectory === true,
  });
  if (prepared.status !== "ready") return prepared;

  try {
    const lease = await acquireNativeFileLock({
      directory: prepared.directory,
      targetName: LIFECYCLE_OPERATION_LEASE_TARGET,
    });
    return lease
      ? {
        status: "acquired",
        root,
        directory: prepared.directory,
        release: lease.release,
      }
      : { status: "busy" };
  } catch {
    return { status: "unavailable" };
  }
};
