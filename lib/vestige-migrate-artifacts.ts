import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { utf8ByteLength } from "./qdrant-corpus.ts";
import type { RecoveryReceipt } from "./vestige-migrate.ts";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const COPY_BUFFER_BYTES = 64 * 1024;
const SQLITE_HEADER_BYTES = 100;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "ascii");
const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export const MAX_EXPORT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = 512 * 1024 * 1024;

export type MigrationArtifactRun = {
  projectRoot: string;
  migrationRoot: string;
  directory: string;
};

export type ReservationActions = {
  write: (content: string) => Promise<string>;
  markDeletionStarted: () => void;
};

const artifactFailure = (code: string): never => {
  throw new Error(`artifact_${code}`);
};

const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const sameNode = (
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
) => left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.mtimeMs === right.mtimeMs
  && left.ctimeMs === right.ctimeMs;

const checkedDirectory = async (path: string, signal?: AbortSignal) => {
  throwIfAborted(signal);
  const info = await lstat(path);
  throwIfAborted(signal);
  if (!info.isDirectory() || info.isSymbolicLink()) artifactFailure("directory_invalid");
  const canonical = await realpath(path);
  throwIfAborted(signal);
  return canonical;
};

const ensureDirectory = async (parent: string, name: string, signal?: AbortSignal) => {
  if (!ARTIFACT_NAME.test(name)) artifactFailure("directory_invalid");
  const target = join(parent, name);
  try {
    throwIfAborted(signal);
    await mkdir(target, { mode: 0o700 });
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      artifactFailure("directory_unavailable");
    }
  }
  const canonical = await checkedDirectory(target, signal);
  if (!inside(parent, canonical)) artifactFailure("directory_escape");
  return canonical;
};

const noSymlinkPath = async (root: string, target: string, signal?: AbortSignal) => {
  if (!inside(root, target)) artifactFailure("path_escape");
  const segments = relative(root, target).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    throwIfAborted(signal);
    current = join(current, segment);
    const info = await lstat(current);
    throwIfAborted(signal);
    if (info.isSymbolicLink()) artifactFailure("symlink_rejected");
  }
};

const openReadable = async (path: string, maximumBytes: number, signal?: AbortSignal) => {
  throwIfAborted(signal);
  const link = await lstat(path);
  throwIfAborted(signal);
  if (!link.isFile() || link.isSymbolicLink() || link.size > maximumBytes) artifactFailure("source_invalid");
  const handle = await open(path, READ_FLAGS);
  try {
    throwIfAborted(signal);
    const start = await handle.stat();
    throwIfAborted(signal);
    if (!start.isFile() || !sameNode(link, start) || start.size > maximumBytes) artifactFailure("source_invalid");
    return { handle, start };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const writeAll = async (handle: FileHandle, content: Uint8Array, signal?: AbortSignal) => {
  let offset = 0;
  while (offset < content.byteLength) {
    throwIfAborted(signal);
    const { bytesWritten } = await handle.write(content, offset, content.byteLength - offset, offset);
    throwIfAborted(signal);
    if (bytesWritten === 0) artifactFailure("write_failed");
    offset += bytesWritten;
  }
};

const hashReadable = async (
  path: string,
  maximumBytes: number,
  requireSqliteHeader: boolean,
  signal?: AbortSignal,
) => {
  const source = await openReadable(path, maximumBytes, signal);
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  const header = Buffer.alloc(SQLITE_HEADER_BYTES);
  const hash = createHash("sha256");
  let headerBytes = 0;
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.byteLength, null);
      throwIfAborted(signal);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) artifactFailure("source_invalid");
      const copied = Math.min(bytesRead, SQLITE_HEADER_BYTES - headerBytes);
      if (copied > 0) {
        buffer.copy(header, headerBytes, 0, copied);
        headerBytes += copied;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const end = await source.handle.stat();
    throwIfAborted(signal);
    if (!sameNode(source.start, end) || total !== source.start.size) artifactFailure("source_changed");
    if (
      requireSqliteHeader
      && (total < SQLITE_HEADER_BYTES || headerBytes < SQLITE_HEADER_BYTES || !header.subarray(0, SQLITE_MAGIC.byteLength).equals(SQLITE_MAGIC))
    ) artifactFailure("source_invalid");
    return { sizeBytes: total, sha256: hash.digest("hex") };
  } finally {
    await source.handle.close();
  }
};

export const hashReadableFile = (path: string, maximumBytes: number, signal?: AbortSignal) =>
  hashReadable(path, maximumBytes, false, signal);

export const hashReadableSqliteFile = (path: string, maximumBytes: number, signal?: AbortSignal) =>
  hashReadable(path, maximumBytes, true, signal);

const checkedWritableDirectory = async (directory: string, signal?: AbortSignal) => {
  const info = await lstat(directory);
  throwIfAborted(signal);
  const canonical = await realpath(directory);
  throwIfAborted(signal);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== directory) {
    artifactFailure("destination_invalid");
  }
};

export async function createMigrationArtifactRun(
  cwd: string,
  timestamp: string,
  signal?: AbortSignal,
): Promise<MigrationArtifactRun> {
  if (!ARTIFACT_NAME.test(timestamp)) artifactFailure("timestamp_invalid");
  throwIfAborted(signal);
  const projectRoot = await checkedDirectory(await realpath(cwd), signal);
  const imaRoot = await ensureDirectory(projectRoot, ".ima", signal);
  const migrationRoot = await ensureDirectory(imaRoot, "vestige-migrate", signal);
  const directory = join(migrationRoot, timestamp);
  try {
    throwIfAborted(signal);
    await mkdir(directory, { mode: 0o700 });
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    artifactFailure("run_collision");
  }
  const canonicalDirectory = await checkedDirectory(directory, signal);
  if (!inside(migrationRoot, canonicalDirectory)) artifactFailure("directory_escape");
  return { projectRoot, migrationRoot, directory: canonicalDirectory };
}

export async function copyVerifiedArtifact(input: {
  sourcePath: string;
  run: MigrationArtifactRun;
  destinationName: string;
  maximumBytes: number;
  signal?: AbortSignal;
}): Promise<RecoveryReceipt> {
  if (!isAbsolute(input.sourcePath) || !ARTIFACT_NAME.test(input.destinationName)) artifactFailure("source_invalid");
  await noSymlinkPath(input.run.migrationRoot, input.run.directory, input.signal);
  const destination = join(input.run.directory, input.destinationName);
  const source = await openReadable(input.sourcePath, input.maximumBytes, input.signal);
  const output = await open(destination, WRITE_FLAGS, 0o600);
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  const hash = createHash("sha256");
  let total = 0;
  try {
    const destinationInfo = await output.stat();
    throwIfAborted(input.signal);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) artifactFailure("destination_invalid");
    for (;;) {
      throwIfAborted(input.signal);
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.byteLength, null);
      throwIfAborted(input.signal);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > input.maximumBytes) artifactFailure("source_invalid");
      const chunk = buffer.subarray(0, bytesRead);
      await writeAll(output, chunk, input.signal);
      hash.update(chunk);
    }
    const end = await source.handle.stat();
    throwIfAborted(input.signal);
    if (!sameNode(source.start, end) || total !== source.start.size) artifactFailure("source_changed");
    return { relativePath: input.destinationName, sizeBytes: total, sha256: hash.digest("hex") };
  } finally {
    await Promise.allSettled([source.handle.close(), output.close()]);
  }
}

export async function readVerifiedText(path: string, maximumBytes: number, signal?: AbortSignal) {
  const source = await openReadable(path, maximumBytes, signal);
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.byteLength, null);
      throwIfAborted(signal);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) artifactFailure("source_invalid");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const end = await source.handle.stat();
    throwIfAborted(signal);
    if (!sameNode(source.start, end) || total !== source.start.size) artifactFailure("source_changed");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await source.handle.close();
  }
}

export async function withReservedExclusiveText<Result>(input: {
  directory: string;
  name: string;
  maximumBytes: number;
  signal?: AbortSignal;
  operation: (actions: ReservationActions) => Promise<Result>;
}): Promise<Result> {
  if (!ARTIFACT_NAME.test(input.name)) artifactFailure("write_invalid");
  await checkedWritableDirectory(input.directory, input.signal);
  throwIfAborted(input.signal);
  const path = join(input.directory, input.name);
  const handle = await open(path, WRITE_FLAGS, 0o600);
  let contentWritten = false;
  let deletionStarted = false;
  try {
    const info = await handle.stat();
    throwIfAborted(input.signal);
    if (!info.isFile() || info.isSymbolicLink()) artifactFailure("destination_invalid");
    return await input.operation({
      markDeletionStarted: () => { deletionStarted = true; },
      write: async (content) => {
        if (utf8ByteLength(content) > input.maximumBytes) artifactFailure("write_invalid");
        throwIfAborted(input.signal);
        await handle.truncate(0);
        throwIfAborted(input.signal);
        await writeAll(handle, Buffer.from(content, "utf8"), input.signal);
        await handle.sync();
        contentWritten = true;
        throwIfAborted(input.signal);
        return path;
      },
    });
  } finally {
    await handle.close();
    if (!contentWritten && !deletionStarted) {
      await unlink(path).catch(() => {});
    }
  }
}

export async function writeExclusiveText(input: {
  directory: string;
  name: string;
  content: string;
  maximumBytes: number;
  signal?: AbortSignal;
}) {
  return withReservedExclusiveText({
    ...input,
    operation: ({ write }) => write(input.content),
  });
}

export async function readMigrationReportArtifact(
  cwd: string,
  reportPath: string,
  maximumBytes: number,
  signal?: AbortSignal,
) {
  if (isAbsolute(reportPath)) artifactFailure("report_invalid");
  throwIfAborted(signal);
  const projectRoot = await checkedDirectory(await realpath(cwd), signal);
  const imaRoot = await checkedDirectory(join(projectRoot, ".ima"), signal);
  if (!inside(projectRoot, imaRoot)) artifactFailure("path_escape");
  const migrationRoot = await checkedDirectory(join(imaRoot, "vestige-migrate"), signal);
  if (!inside(imaRoot, migrationRoot)) artifactFailure("path_escape");
  const target = resolve(projectRoot, reportPath);
  if (!inside(migrationRoot, target) || basename(target) !== "report.json") artifactFailure("report_invalid");
  await noSymlinkPath(migrationRoot, target, signal);
  const canonicalTarget = await realpath(target);
  throwIfAborted(signal);
  if (!inside(migrationRoot, canonicalTarget)) artifactFailure("path_escape");
  return {
    projectRoot,
    migrationRoot,
    reportPath: canonicalTarget,
    reportDirectory: dirname(canonicalTarget),
    content: await readVerifiedText(canonicalTarget, maximumBytes, signal),
  };
}

export async function verifyRecoveryReceipt(input: {
  reportDirectory: string;
  receipt: RecoveryReceipt;
  maximumBytes: number;
  hashFile?: typeof hashReadableFile;
  signal?: AbortSignal;
}) {
  if (!ARTIFACT_NAME.test(input.receipt.relativePath)) return false;
  const target = resolve(input.reportDirectory, input.receipt.relativePath);
  if (!inside(input.reportDirectory, target)) return false;
  try {
    await noSymlinkPath(input.reportDirectory, target, input.signal);
    const observed = await (input.hashFile ?? hashReadableFile)(target, input.maximumBytes, input.signal);
    return observed.sizeBytes === input.receipt.sizeBytes && observed.sha256 === input.receipt.sha256;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return false;
  }
}

export async function migrationArtifactQueueKey(cwd: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const projectRoot = await checkedDirectory(await realpath(cwd), signal);
  const fallback = join(projectRoot, ".ima", "vestige-migrate");
  try {
    const canonical = await realpath(fallback);
    throwIfAborted(signal);
    return inside(projectRoot, canonical) ? canonical : artifactFailure("path_escape");
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallback;
  }
}
