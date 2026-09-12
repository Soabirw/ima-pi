import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const LOCK_SCHEMA_VERSION = 1;
const LOCK_SUFFIX = ".ima-agent.lock";
const REGISTRY_LOCK_RETRIES = 40;
const REGISTRY_LOCK_RETRY_DELAY_MS = 10;

// Sidecar metadata is local-only lease state; it contains no credentials or session content.
type LockMetadata = {
  schemaVersion: 1;
  token: string;
  pid: number;
  createdAt: string;
};

type LockNode = {
  dev: number;
  ino: number;
};

export type NativeFileLease = {
  target: string;
  release: () => Promise<void>;
};

export type NativeFileLockOptions = {
  retries?: number;
  retryDelayMs?: number;
};

const errorCode = (error: unknown) =>
  (error as { code?: unknown } | null)?.code;

const validTargetName = (value: unknown): value is string =>
  typeof value === "string"
  && value.length > 0
  && value === basename(value)
  && value !== "."
  && value !== ".."
  && !value.includes("\0");

const validRetryCount = (value: unknown, fallback: number) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100
    ? value as number
    : fallback;

const validRetryDelay = (value: unknown, fallback: number) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000
    ? value as number
    : fallback;

const sleep = (milliseconds: number) => new Promise<void>((resolveSleep) => {
  setTimeout(resolveSleep, milliseconds);
});

const isLockMetadata = (value: unknown): value is LockMetadata => {
  const metadata = value as LockMetadata | null;
  return Boolean(
    metadata
    && metadata.schemaVersion === LOCK_SCHEMA_VERSION
    && typeof metadata.token === "string"
    && /^[a-f0-9-]{36}$/.test(metadata.token)
    && Number.isInteger(metadata.pid)
    && metadata.pid > 0
    && typeof metadata.createdAt === "string"
    && metadata.createdAt.length > 0,
  );
};

const sameNode = (left: LockNode, right: LockNode) =>
  left.dev === right.dev && left.ino === right.ino;

const canonicalDirectory = async (directory: string) => {
  const lexical = resolve(directory);
  const details = await lstat(lexical);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("agent_session_lock_directory_invalid");
  }
  return realpath(lexical);
};

const metadataMatches = (value: unknown, expected: LockMetadata) =>
  isLockMetadata(value) && value.token === expected.token;

const releaseOwnedLock = async (
  lockPath: string,
  metadata: LockMetadata,
  node: LockNode,
): Promise<void> => {
  try {
    const details = await lstat(lockPath);
    if (!details.isFile() || details.isSymbolicLink() || !sameNode(details, node)) return;
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    if (!metadataMatches(parsed, metadata)) return;
    const rechecked = await lstat(lockPath);
    if (!rechecked.isFile() || rechecked.isSymbolicLink() || !sameNode(rechecked, node)) return;
    await unlink(lockPath);
  } catch {
    // An unverifiable lease remains in place rather than deleting another operation's lock.
  }
};

export async function acquireNativeFileLock(input: {
  directory: string;
  targetName: string;
  options?: NativeFileLockOptions;
}): Promise<NativeFileLease | null> {
  if (!validTargetName(input.targetName)) {
    throw new Error("agent_session_lock_target_invalid");
  }
  const directory = await canonicalDirectory(input.directory);
  const target = join(directory, input.targetName);
  const lockPath = join(directory, `.${input.targetName}${LOCK_SUFFIX}`);
  const retries = validRetryCount(input.options?.retries, 0);
  const retryDelayMs = validRetryDelay(input.options?.retryDelayMs, 0);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const metadata: LockMetadata = {
      schemaVersion: LOCK_SCHEMA_VERSION,
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    try {
      await writeFile(lockPath, `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const details = await lstat(lockPath);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error("agent_session_lock_invalid");
      }
      const parsed = JSON.parse(await readFile(lockPath, "utf8"));
      if (!metadataMatches(parsed, metadata)) {
        throw new Error("agent_session_lock_invalid");
      }
      const node: LockNode = { dev: details.dev, ino: details.ino };
      return {
        target,
        release: () => releaseOwnedLock(lockPath, metadata, node),
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (attempt === retries) return null;
      await sleep(retryDelayMs);
    }
  }
  return null;
}

export const acquireRegistryFileLock = (file: string) =>
  acquireNativeFileLock({
    directory: dirname(resolve(file)),
    targetName: basename(file),
    options: {
      retries: REGISTRY_LOCK_RETRIES,
      retryDelayMs: REGISTRY_LOCK_RETRY_DELAY_MS,
    },
  });

export async function acquireNativeSessionLock(
  sessionFile: string,
): Promise<NativeFileLease | null> {
  if (typeof sessionFile !== "string" || !sessionFile.startsWith("/")) {
    throw new Error("agent_session_lock_target_invalid");
  }
  const lexical = resolve(sessionFile);
  const details = await lstat(lexical);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("agent_session_lock_target_invalid");
  }
  const canonical = await realpath(lexical);
  const canonicalDetails = await lstat(canonical);
  if (!canonicalDetails.isFile() || canonicalDetails.isSymbolicLink()) {
    throw new Error("agent_session_lock_target_invalid");
  }
  return acquireNativeFileLock({
    directory: dirname(canonical),
    targetName: basename(canonical),
  });
}
