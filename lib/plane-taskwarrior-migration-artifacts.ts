import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const RUN_PATH_PREFIX = join(".ima", "plane-taskwarrior-migrate");
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_BYTES = 512;
const LOCK_NAME = ".migration.lock";
const LOCK_TRANSITION_NAME = ".migration.lock.transition";
const LOCK_SCHEMA_VERSION = 1;
const MAX_LOCK_ATTEMPTS = 5;
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_ARTIFACT_KEY = /api.?key|authorization|headers?|base.?url|response|exception|stack|^error$/i;

export const MIGRATION_ARTIFACTS = Object.freeze({
  source: "source.json",
  plan: "plan.json",
  dryRunReport: "dry-run-report.json",
  preflightReport: "preflight-report.json",
  checkpoint: "checkpoint.json",
  reconciliationReport: "reconciliation-report.json",
});

const artifactFailure = (code) => {
  throw new Error(`plane_taskwarrior_artifact_${code}`);
};

const isErrorCode = (error, code) => error instanceof Error && "code" in error && error.code === code;

const isInside = (root, target) => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const sameNode = (left, right) => left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.mtimeMs === right.mtimeMs
  && left.ctimeMs === right.ctimeMs;

const sameLockNode = (left, right) => left.dev === right.dev && left.ino === right.ino;

const checkedDirectory = async (path) => {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) artifactFailure("directory_invalid");
  return realpath(path);
};

const ensureDirectory = async (parent, name) => {
  if (!ARTIFACT_NAME_PATTERN.test(name)) artifactFailure("directory_invalid");
  const target = join(parent, name);
  try {
    await mkdir(target, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) artifactFailure("directory_unavailable");
  }

  const canonical = await checkedDirectory(target);
  if (!isInside(parent, canonical)) artifactFailure("directory_escape");
  return canonical;
};

const rejectSymlinks = async (root, target) => {
  if (!isInside(root, target)) artifactFailure("path_escape");
  let current = root;
  for (const segment of relative(root, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) artifactFailure("symlink_rejected");
  }
};

const checkedRunDirectory = async (run) => {
  if (!run || typeof run !== "object") artifactFailure("run_invalid");
  const { projectRoot, migrationRoot, directory } = run;
  if (![projectRoot, migrationRoot, directory].every((value) => typeof value === "string")) {
    artifactFailure("run_invalid");
  }
  if (!isInside(projectRoot, migrationRoot) || !isInside(migrationRoot, directory)) {
    artifactFailure("run_invalid");
  }
  await rejectSymlinks(projectRoot, directory);
  const canonicalDirectory = await checkedDirectory(directory);
  if (canonicalDirectory !== directory || !isInside(migrationRoot, canonicalDirectory)) {
    artifactFailure("run_invalid");
  }
  return run;
};

const artifactPath = (run, name) => {
  if (!Object.values(MIGRATION_ARTIFACTS).includes(name)) artifactFailure("name_invalid");
  const target = join(run.directory, name);
  if (basename(target) !== name || !isInside(run.directory, target)) artifactFailure("path_escape");
  return target;
};

const assertSafeArtifactValue = (value) => {
  if (Array.isArray(value)) {
    value.forEach(assertSafeArtifactValue);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_ARTIFACT_KEY.test(key)) artifactFailure("secret_field");
    assertSafeArtifactValue(child);
  }
};

const stringifyArtifact = (value) => {
  assertSafeArtifactValue(value);
  let content;
  try {
    content = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    artifactFailure("json_invalid");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) artifactFailure("too_large");
  return content;
};

const writeAll = async (handle, content) => {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesWritten === 0) artifactFailure("write_failed");
    offset += bytesWritten;
  }
};

const writeNewFile = async (path, content) => {
  const handle = await open(path, CREATE_FLAGS, FILE_MODE);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) artifactFailure("file_invalid");
    await writeAll(handle, content);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const replaceFileAtomically = async (path, content) => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeNewFile(temporaryPath, content);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
};

const readTextFile = async (path) => {
  const link = await lstat(path);
  if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_ARTIFACT_BYTES) {
    artifactFailure("file_invalid");
  }
  const handle = await open(path, READ_FLAGS);
  try {
    const start = await handle.stat();
    if (!start.isFile() || !sameNode(link, start) || start.size > MAX_ARTIFACT_BYTES) {
      artifactFailure("file_invalid");
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const end = await handle.stat();
    if (!sameNode(start, end) || Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) {
      artifactFailure("file_changed");
    }
    return content;
  } finally {
    await handle.close();
  }
};

const runFor = async ({ cwd, create }) => {
  const projectRoot = await checkedDirectory(await realpath(cwd));
  if (create) {
    const imaRoot = await ensureDirectory(projectRoot, ".ima");
    const migrationRoot = await ensureDirectory(imaRoot, "plane-taskwarrior-migrate");
    return { projectRoot, migrationRoot };
  }

  const imaRoot = await checkedDirectory(join(projectRoot, ".ima"));
  if (!isInside(projectRoot, imaRoot)) artifactFailure("directory_escape");
  const migrationRoot = await checkedDirectory(join(imaRoot, "plane-taskwarrior-migrate"));
  if (!isInside(imaRoot, migrationRoot)) artifactFailure("directory_escape");
  return { projectRoot, migrationRoot };
};

export const createMigrationRun = async ({ cwd, timestamp }) => {
  if (typeof timestamp !== "string" || !ARTIFACT_NAME_PATTERN.test(timestamp)) {
    artifactFailure("timestamp_invalid");
  }
  const { projectRoot, migrationRoot } = await runFor({ cwd, create: true });
  const directory = join(migrationRoot, timestamp);
  try {
    await mkdir(directory, { mode: DIRECTORY_MODE });
  } catch {
    artifactFailure("run_collision");
  }

  const canonicalDirectory = await checkedDirectory(directory);
  if (!isInside(migrationRoot, canonicalDirectory)) artifactFailure("directory_escape");
  return {
    projectRoot,
    migrationRoot,
    directory: canonicalDirectory,
    relativeRunPath: relative(projectRoot, canonicalDirectory),
  };
};

export const loadMigrationRun = async ({ cwd, relativeRunPath }) => {
  if (typeof relativeRunPath !== "string" || relativeRunPath.trim() === "" || isAbsolute(relativeRunPath)) {
    artifactFailure("run_path_invalid");
  }
  const { projectRoot, migrationRoot } = await runFor({ cwd, create: false });
  const directory = resolve(projectRoot, relativeRunPath);
  const relativeToMigrationRoot = relative(migrationRoot, directory);
  if (
    !isInside(migrationRoot, directory)
    || relativeToMigrationRoot === ""
    || relativeToMigrationRoot.includes("/")
    || relativeToMigrationRoot.includes("\\")
    || !ARTIFACT_NAME_PATTERN.test(relativeToMigrationRoot)
  ) {
    artifactFailure("run_path_invalid");
  }

  await rejectSymlinks(projectRoot, directory);
  const canonicalDirectory = await checkedDirectory(directory);
  if (canonicalDirectory !== directory || !isInside(migrationRoot, canonicalDirectory)) {
    artifactFailure("run_path_invalid");
  }
  return {
    projectRoot,
    migrationRoot,
    directory: canonicalDirectory,
    relativeRunPath: relative(projectRoot, canonicalDirectory),
  };
};

export const readProjectTextFile = async ({ cwd, relativePath }) => {
  if (typeof relativePath !== "string" || relativePath.trim() === "" || isAbsolute(relativePath)) {
    artifactFailure("source_path_invalid");
  }
  const projectRoot = await checkedDirectory(await realpath(cwd));
  const target = resolve(projectRoot, relativePath);
  if (!isInside(projectRoot, target)) artifactFailure("source_path_invalid");
  await rejectSymlinks(projectRoot, target);
  return readTextFile(target);
};

export const writeRunArtifact = async ({ run, name, value }) => {
  await checkedRunDirectory(run);
  const path = artifactPath(run, name);
  await writeNewFile(path, stringifyArtifact(value));
  return path;
};

export const replaceRunArtifact = async ({ run, name, value }) => {
  await checkedRunDirectory(run);
  const path = artifactPath(run, name);
  const existing = await lstat(path).catch((error) => isErrorCode(error, "ENOENT") ? null : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) artifactFailure("file_invalid");
  await replaceFileAtomically(path, stringifyArtifact(value));
  return path;
};

export const readRunArtifact = async ({ run, name }) => {
  await checkedRunDirectory(run);
  const path = artifactPath(run, name);
  const content = await readTextFile(path);
  try {
    return JSON.parse(content);
  } catch {
    artifactFailure("json_invalid");
  }
};

export const readCheckpoint = async ({ run }) => {
  try {
    return await readRunArtifact({ run, name: MIGRATION_ARTIFACTS.checkpoint });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
};

export const writeCheckpoint = ({ run, value }) => replaceRunArtifact({
  run,
  name: MIGRATION_ARTIFACTS.checkpoint,
  value,
});

const lockOwnerFrom = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) artifactFailure("lock_in_progress");
  const keys = Object.keys(value);
  if (keys.length !== 3 || keys.some((key) => !["schemaVersion", "pid", "token"].includes(key))) {
    artifactFailure("lock_in_progress");
  }
  if (value.schemaVersion !== LOCK_SCHEMA_VERSION
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.token !== "string"
    || !LOCK_TOKEN_PATTERN.test(value.token)) {
    artifactFailure("lock_in_progress");
  }
  return { pid: value.pid, token: value.token.toLowerCase() };
};

const sameLockOwner = (left, right) => left.pid === right.pid && left.token === right.token;

const lockContentFor = (owner) => `${JSON.stringify({
  schemaVersion: LOCK_SCHEMA_VERSION,
  pid: owner.pid,
  token: owner.token,
})}\n`;

const readLockOwner = async (path) => {
  let linkInfo;
  try {
    linkInfo = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    artifactFailure("lock_in_progress");
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.size > MAX_LOCK_BYTES) {
    artifactFailure("lock_in_progress");
  }

  let handle;
  try {
    handle = await open(path, READ_FLAGS);
    const start = await handle.stat();
    if (!start.isFile() || !sameNode(linkInfo, start) || start.size > MAX_LOCK_BYTES) {
      artifactFailure("lock_in_progress");
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const end = await handle.stat();
    if (!sameNode(start, end) || Buffer.byteLength(content, "utf8") > MAX_LOCK_BYTES) {
      artifactFailure("lock_in_progress");
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      artifactFailure("lock_in_progress");
    }
    return { owner: lockOwnerFrom(parsed), node: end };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("plane_taskwarrior_artifact_")) throw error;
    artifactFailure("lock_in_progress");
  } finally {
    await handle?.close();
  }
};

const defaultProbeProcess = (pid) => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return isErrorCode(error, "ESRCH") ? "dead" : "unknown";
  }
};

const transitionPathFor = (path) => join(dirname(path), LOCK_TRANSITION_NAME);

const sameLockRecord = (left, right) => left !== null
  && right !== null
  && sameLockNode(left.node, right.node)
  && sameLockOwner(left.owner, right.owner);

const ownerIsDead = async ({ owner, probeProcess }) => {
  try {
    return await probeProcess(owner.pid) === "dead";
  } catch {
    return false;
  }
};

const unlinkVerifiedLock = async ({ path, expected }) => {
  const current = await readLockOwner(path);
  if (!sameLockRecord(current, expected)) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
};

const createTransition = async ({ path, transitionPath }) => {
  try {
    await link(path, transitionPath);
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) return { status: "occupied" };
    if (isErrorCode(error, "ENOENT")) return { status: "missing" };
    artifactFailure("lock_unavailable");
  }

  const transition = await readLockOwner(transitionPath);
  if (!transition) artifactFailure("lock_unavailable");
  return { status: "acquired", transition };
};

const recoverTransition = async ({ path, transitionPath, probeProcess }) => {
  const transition = await readLockOwner(transitionPath);
  if (!transition) return "clear";
  if (!await ownerIsDead({ owner: transition.owner, probeProcess })) return "blocked";

  const canonical = await readLockOwner(path);
  if (canonical && !sameLockRecord(canonical, transition)) return "blocked";
  if (canonical && !await unlinkVerifiedLock({ path, expected: transition })) return "blocked";
  if (!await unlinkVerifiedLock({ path: transitionPath, expected: transition })) return "blocked";
  return "clear";
};

const publishLock = async ({ path, transitionPath, owner }) => {
  if (await readLockOwner(transitionPath)) return null;

  const temporaryPath = `${path}.${owner.token}.tmp`;
  try {
    await writeNewFile(temporaryPath, lockContentFor(owner));
    if (await readLockOwner(transitionPath)) return null;
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) return null;
      artifactFailure("lock_unavailable");
    }
    await unlink(temporaryPath);

    const published = await readLockOwner(path);
    if (!published || !sameLockOwner(published.owner, owner)) artifactFailure("lock_unavailable");
    let transition;
    try {
      transition = await readLockOwner(transitionPath);
    } catch (error) {
      await unlinkVerifiedLock({ path, expected: published });
      throw error;
    }
    if (!transition) return published;

    if (sameLockRecord(transition, published)) {
      await unlinkVerifiedLock({ path, expected: published });
      await unlinkVerifiedLock({ path: transitionPath, expected: transition });
      return null;
    }
    await unlinkVerifiedLock({ path, expected: published });
    return null;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
};

const reclaimDeadLock = async ({ path, transitionPath, probeProcess }) => {
  const transitionResult = await createTransition({ path, transitionPath });
  if (transitionResult.status === "occupied") return "retry";
  if (transitionResult.status === "missing") return "retry";

  const { transition } = transitionResult;
  const canonical = await readLockOwner(path);
  if (!sameLockRecord(canonical, transition)) {
    await unlinkVerifiedLock({ path: transitionPath, expected: transition });
    return canonical ? "blocked" : "retry";
  }
  if (!await ownerIsDead({ owner: transition.owner, probeProcess })) {
    await unlinkVerifiedLock({ path: transitionPath, expected: transition });
    return "blocked";
  }
  if (!await unlinkVerifiedLock({ path, expected: transition })) return "blocked";
  if (!await unlinkVerifiedLock({ path: transitionPath, expected: transition })) return "blocked";
  return "retry";
};

const acquireMigrationLock = async ({ path, owner, probeProcess }) => {
  const transitionPath = transitionPathFor(path);
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    if (await recoverTransition({ path, transitionPath, probeProcess }) !== "clear") {
      artifactFailure("lock_in_progress");
    }

    const published = await publishLock({ path, transitionPath, owner });
    if (published) return published;

    const observed = await readLockOwner(path);
    if (!observed) continue;
    const reclaimResult = await reclaimDeadLock({ path, transitionPath, probeProcess });
    if (reclaimResult === "retry") continue;
    artifactFailure("lock_in_progress");
  }
  artifactFailure("lock_in_progress");
};

const releaseMigrationLock = async ({ path, acquired, beforeCanonicalUnlink }) => {
  const transitionPath = transitionPathFor(path);
  const transitionResult = await createTransition({ path, transitionPath });
  if (transitionResult.status !== "acquired") artifactFailure("lock_replaced");

  const { transition } = transitionResult;
  const canonical = await readLockOwner(path);
  if (!sameLockRecord(canonical, transition) || !sameLockOwner(transition.owner, acquired.owner)) {
    await unlinkVerifiedLock({ path: transitionPath, expected: transition });
    artifactFailure("lock_replaced");
  }
  await beforeCanonicalUnlink?.();
  if (!await unlinkVerifiedLock({ path, expected: transition })) {
    await unlinkVerifiedLock({ path: transitionPath, expected: transition });
    artifactFailure("lock_replaced");
  }
  if (!await unlinkVerifiedLock({ path: transitionPath, expected: transition })) {
    artifactFailure("lock_unavailable");
  }
};

export const withMigrationLock = async ({
  run,
  operation,
  processId = process.pid,
  token = randomUUID(),
  probeProcess = defaultProbeProcess,
  beforeCanonicalUnlink,
}) => {
  if (typeof operation !== "function"
    || !Number.isSafeInteger(processId)
    || processId < 1
    || typeof token !== "string"
    || !LOCK_TOKEN_PATTERN.test(token)
    || typeof probeProcess !== "function"
    || (beforeCanonicalUnlink !== undefined && typeof beforeCanonicalUnlink !== "function")) {
    artifactFailure("lock_invalid");
  }
  await checkedRunDirectory(run);

  const owner = { pid: processId, token: token.toLowerCase() };
  const path = join(run.directory, LOCK_NAME);
  const acquired = await acquireMigrationLock({ path, owner, probeProcess });
  let settlement;
  try {
    settlement = { status: "fulfilled", value: await operation() };
  } catch (error) {
    settlement = { status: "rejected", error };
  }

  try {
    await releaseMigrationLock({ path, acquired, beforeCanonicalUnlink });
  } catch (error) {
    if (settlement.status === "fulfilled") throw error;
  }

  if (settlement.status === "fulfilled") return settlement.value;
  throw settlement.error;
};
