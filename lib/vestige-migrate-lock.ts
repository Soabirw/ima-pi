import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const LOCK_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const LOCK_DIRECTORY_MODE = 0o700;
const LOCK_FILE_MODE = 0o600;

export type VestigeMigrationLockInput = {
  lockPath?: string;
  signal?: AbortSignal;
};

const lockFailure = (code: "in_progress" | "invalid" | "unavailable" | "release_failed"): never => {
  throw new Error(`Vestige migration lock ${code}.`);
};

const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

const lockPathFor = (input: VestigeMigrationLockInput) =>
  input.lockPath ?? join(homedir(), ".ima", "locks", "vestige-migrate.lock");

const isErrorCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

const prepareLockDirectory = async (path: string, signal?: AbortSignal) => {
  const directory = dirname(path);
  try {
    throwIfAborted(signal);
    await mkdir(directory, { recursive: true, mode: LOCK_DIRECTORY_MODE });
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    lockFailure("unavailable");
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(directory);
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    lockFailure("unavailable");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) lockFailure("invalid");
};

const acquireLock = async (path: string, signal?: AbortSignal): Promise<FileHandle> => {
  try {
    throwIfAborted(signal);
    return await open(path, LOCK_FLAGS, LOCK_FILE_MODE);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isErrorCode(error, "EEXIST")) lockFailure("in_progress");
    lockFailure("unavailable");
  }
};

const releaseLock = async (path: string, handle: FileHandle) => {
  try {
    await handle.close();
    await unlink(path);
  } catch {
    lockFailure("release_failed");
  }
};

export async function withVestigeMigrationLock<Result>(
  operation: () => Promise<Result>,
  input: VestigeMigrationLockInput = {},
): Promise<Result> {
  const path = lockPathFor(input);
  if (!isAbsolute(path)) lockFailure("invalid");
  await prepareLockDirectory(path, input.signal);
  const handle = await acquireLock(path, input.signal);
  try {
    throwIfAborted(input.signal);
    return await operation();
  } finally {
    await releaseLock(path, handle);
  }
}
