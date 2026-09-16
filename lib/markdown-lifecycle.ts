import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { LIFECYCLE_PHASES, type LifecycleIdentity, type LifecyclePhase } from "./ima-lifecycle.ts";
import {
  MARKDOWN_LIFECYCLE_PROVIDER,
  MAX_MARKDOWN_LIFECYCLE_ARTIFACT_BYTES,
  MAX_MARKDOWN_LIFECYCLE_ENUMERATION,
  MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT,
  MAX_MARKDOWN_LIFECYCLE_RECEIPT_BYTES,
  containsRecognizedMarkdownLifecycleSecret,
  canonicalMarkdownCheckoutRoot,
  createMarkdownLifecycleRecord,
  detachedMarkdownLifecycleReference,
  markdownLifecycleArtifactName,
  markdownLifecycleDirectoryName,
  markdownLifecycleReceiptName,
  markdownLifecycleReferenceFor,
  projectMarkdownLifecycleReference,
  projectMarkdownLifecycleSelection,
  sameMarkdownLifecycleReference,
  verifyMarkdownLifecycleRecord,
  type MarkdownLifecyclePreparedRecord,
  type MarkdownLifecycleRecordFailureCode,
  type MarkdownLifecycleReference,
  type MarkdownLifecycleSelection,
  type MarkdownLifecycleVerifiedRecord,
} from "./markdown-lifecycle-record.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const LOCK_NAME = ".lifecycle.lock";
const MAX_LOCK_BYTES = 512;
const LIFECYCLE_DIRECTORY_SEGMENTS = [".ima", "lifecycle", "markdown", "v1"] as const;
const ARTIFACT_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PHASE_SOURCE = LIFECYCLE_PHASES.join("|");
const ARTIFACT_NAME_PATTERN = new RegExp(
  `^(${PHASE_SOURCE})-(${ARTIFACT_ID_SOURCE})\\.md$`,
);
const RECEIPT_NAME_PATTERN = new RegExp(
  `^(${PHASE_SOURCE})-(${ARTIFACT_ID_SOURCE})\\.commit\\.json$`,
);
const LIFECYCLE_LOOKING_ARTIFACT_PATTERN = new RegExp(
  `^(?:${PHASE_SOURCE})-.*\\.md$`,
);
const LIFECYCLE_LOOKING_RECEIPT_PATTERN = new RegExp(
  `^(?:${PHASE_SOURCE})-.*\\.commit\\.json$`,
);

export type MarkdownLifecycleFailureCode = MarkdownLifecycleRecordFailureCode
  | "aborted"
  | "markdown_checkout_invalid"
  | "markdown_containment_violation"
  | "markdown_lease_active"
  | "markdown_lease_lost"
  | "markdown_lease_release_failed"
  | "markdown_lease_unavailable"
  | "markdown_operation_failed"
  | "markdown_partial_evidence"
  | "markdown_path_invalid"
  | "markdown_recall_unverifiable"
  | "markdown_record_not_found"
  | "markdown_reference_invalid"
  | "markdown_selection_invalid"
  | "markdown_target_conflict"
  | "markdown_target_unverifiable"
  | "markdown_verification_failed"
  | "markdown_write_failed"
  | "markdown_write_uncertain";

export type MarkdownLifecycleBlockedResult = {
  provider: "markdown";
  status: "blocked";
  code: MarkdownLifecycleFailureCode;
  reference?: MarkdownLifecycleReference;
};

export type MarkdownLifecycleVerifiedResult = {
  provider: "markdown";
  status: "verified";
  disposition: "stored" | "unchanged";
  storageSchemaVersion: 1;
  sourceId: string;
  checkoutRoot: string;
  lifecycleKey: string;
  phase: LifecyclePhase;
  artifactId: string;
  contentHash: string;
  receiptHash: string;
  identity: LifecycleIdentity;
  summary: string;
  artifact: string;
  reference: MarkdownLifecycleReference;
};

export type MarkdownLifecycleAdapter = {
  persist: (
    request: unknown,
    signal?: AbortSignal,
  ) => Promise<MarkdownLifecycleVerifiedResult | MarkdownLifecycleBlockedResult>;
  get: (
    reference: unknown,
    signal?: AbortSignal,
  ) => Promise<MarkdownLifecycleVerifiedResult | MarkdownLifecycleBlockedResult>;
  recall: (
    selection: unknown,
    signal?: AbortSignal,
  ) => Promise<MarkdownLifecycleVerifiedResult[] | MarkdownLifecycleBlockedResult>;
};

export type MarkdownLifecycleProvider = MarkdownLifecycleAdapter;

type DirectoryNode = {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
};

type FileNode = DirectoryNode & {
  size: number;
  nlink: number;
};

type CheckedDirectory = {
  path: string;
  node: DirectoryNode;
};

type LifecycleScope = {
  checkoutRoot: string;
  directory: string;
};

type SafeReadResult =
  | { status: "missing" }
  | { status: "ok"; content: string; node: FileNode }
  | { status: "invalid" | "changed" | "failed" };

type SafeWriteResult = "written" | "exists" | "failed" | "uncertain";

type LifecycleLease = {
  path: string;
  content: string;
  node: FileNode;
};

type PairObservation =
  | { status: "absent" | "partial" | "invalid" }
  | { status: "verified"; record: MarkdownLifecycleVerifiedRecord };

const errorCode = (error: unknown) =>
  (error as { code?: unknown } | null)?.code;

const isNotFound = (error: unknown) => errorCode(error) === "ENOENT";

const isInside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const directoryNode = (info: Stats): DirectoryNode => ({
  dev: info.dev,
  ino: info.ino,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs,
});

const fileNode = (info: Stats): FileNode => ({
  ...directoryNode(info),
  size: info.size,
  nlink: info.nlink,
});

const sameDirectoryNode = (left: DirectoryNode, right: DirectoryNode) =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.mtimeMs === right.mtimeMs
  && left.ctimeMs === right.ctimeMs;

const sameFileNode = (left: FileNode, right: FileNode) =>
  sameDirectoryNode(left, right)
  && left.size === right.size
  && left.nlink === right.nlink;

const sameFileIdentity = (left: FileNode, right: FileNode) =>
  left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;

const safeDirectory = (info: Stats) =>
  info.isDirectory() && !info.isSymbolicLink();

const safeFile = (info: Stats, maximumBytes: number) =>
  info.isFile()
  && !info.isSymbolicLink()
  && Number.isSafeInteger(info.size)
  && info.size >= 0
  && info.size <= maximumBytes
  && info.nlink === 1;

const detachedIdentity = (identity: LifecycleIdentity): LifecycleIdentity => ({
  project: identity.project,
  lifecycleKey: identity.lifecycleKey,
  lifecycleRootMemoryId: identity.lifecycleRootMemoryId,
  taskwarriorProject: identity.taskwarriorProject,
  taskwarriorTask: identity.taskwarriorTask,
  taskwarriorUuid: identity.taskwarriorUuid,
  jiraKey: identity.jiraKey,
  ...(identity.planeWorkspace && identity.planeWorkItem
    ? {
      planeWorkspace: identity.planeWorkspace,
      planeWorkItem: identity.planeWorkItem,
    }
    : {}),
  sourceRefs: [...identity.sourceRefs],
  priorArtifactIds: [...identity.priorArtifactIds],
});

const blocked = (
  code: MarkdownLifecycleFailureCode,
  reference?: MarkdownLifecycleReference,
): MarkdownLifecycleBlockedResult => ({
  provider: MARKDOWN_LIFECYCLE_PROVIDER,
  status: "blocked",
  code,
  ...(reference ? { reference: detachedMarkdownLifecycleReference(reference) } : {}),
});

const isAborted = (signal?: AbortSignal) => signal?.aborted === true;

const checkoutRootFrom = (value: unknown): string | null => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "checkoutRoot") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "checkoutRoot");
    if (
      !descriptor
      || descriptor.get
      || descriptor.set
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) return null;
    return canonicalMarkdownCheckoutRoot(descriptor.value);
  } catch {
    return null;
  }
};

const checkedCheckoutRoot = async (
  configuredRoot: string | null,
): Promise<CheckedDirectory | null> => {
  if (!configuredRoot) return null;
  try {
    const before = await lstat(configuredRoot);
    if (!safeDirectory(before)) return null;
    const canonical = await realpath(configuredRoot);
    if (canonical !== configuredRoot) return null;
    const after = await lstat(canonical);
    return safeDirectory(after)
      && sameDirectoryNode(directoryNode(before), directoryNode(after))
      ? { path: canonical, node: directoryNode(after) }
      : null;
  } catch {
    return null;
  }
};

const checkedDirectory = async (
  checkoutRoot: string,
  path: string,
): Promise<{ status: "ok"; directory: CheckedDirectory } | { status: "missing" | "invalid" | "escape" | "failed" }> => {
  try {
    const before = await lstat(path);
    if (!safeDirectory(before)) return { status: "invalid" };
    const canonical = await realpath(path);
    if (canonical !== path || !isInside(checkoutRoot, canonical)) {
      return { status: "escape" };
    }
    const after = await lstat(canonical);
    if (!safeDirectory(after) || !sameDirectoryNode(directoryNode(before), directoryNode(after))) {
      return { status: "invalid" };
    }
    return { status: "ok", directory: { path: canonical, node: directoryNode(after) } };
  } catch (error) {
    return isNotFound(error) ? { status: "missing" } : { status: "failed" };
  }
};

const childPath = (parent: string, name: string): string | null => {
  if (
    name !== basename(name)
    || name === "."
    || name === ".."
    || name.includes("\0")
  ) return null;
  const target = join(parent, name);
  return target !== parent && isInside(parent, target) ? target : null;
};

const ensureChildDirectory = async (input: {
  checkoutRoot: string;
  parent: string;
  name: string;
}): Promise<{ status: "ok"; directory: CheckedDirectory } | { status: "invalid" | "escape" | "failed" }> => {
  const parent = await checkedDirectory(input.checkoutRoot, input.parent);
  if (parent.status !== "ok") {
    return { status: parent.status === "escape" ? "escape" : "invalid" };
  }
  const target = childPath(parent.directory.path, input.name);
  if (!target) return { status: "escape" };

  try {
    await mkdir(target, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") return { status: "failed" };
  }

  const directory = await checkedDirectory(input.checkoutRoot, target);
  return directory.status === "ok"
    ? directory
    : { status: directory.status === "escape" ? "escape" : "invalid" };
};

const lifecycleScope = async (input: {
  checkoutRoot: string;
  lifecycleKey: string;
  create: boolean;
}): Promise<{ status: "ok"; scope: LifecycleScope } | { status: "missing" | "invalid" | "escape" | "failed" }> => {
  const keyDirectory = markdownLifecycleDirectoryName(input.lifecycleKey);
  if (!keyDirectory) return { status: "invalid" };

  let parent = input.checkoutRoot;
  for (const name of [...LIFECYCLE_DIRECTORY_SEGMENTS, keyDirectory]) {
    if (input.create) {
      const ensured = await ensureChildDirectory({
        checkoutRoot: input.checkoutRoot,
        parent,
        name,
      });
      if (ensured.status !== "ok") return ensured;
      parent = ensured.directory.path;
      continue;
    }

    const target = childPath(parent, name);
    if (!target) return { status: "escape" };
    const existing = await checkedDirectory(input.checkoutRoot, target);
    if (existing.status !== "ok") return existing;
    parent = existing.directory.path;
  }

  return {
    status: "ok",
    scope: { checkoutRoot: input.checkoutRoot, directory: parent },
  };
};

const scopeIsStable = async (scope: LifecycleScope, expected?: DirectoryNode) => {
  const observed = await checkedDirectory(scope.checkoutRoot, scope.directory);
  return observed.status === "ok"
    && (expected === undefined || sameDirectoryNode(expected, observed.directory.node));
};

const scopedFilePath = (scope: LifecycleScope, name: string): string | null =>
  childPath(scope.directory, name);

const decodeExactUtf8 = (value: Buffer): string | null => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    return Buffer.from(text, "utf8").equals(value) ? text : null;
  } catch {
    return null;
  }
};

const readTextFile = async (path: string, maximumBytes: number): Promise<SafeReadResult> => {
  let link: Stats;
  try {
    link = await lstat(path);
  } catch (error) {
    return isNotFound(error) ? { status: "missing" } : { status: "failed" };
  }
  if (!safeFile(link, maximumBytes)) return { status: "invalid" };

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let result: SafeReadResult = { status: "failed" };
  try {
    handle = await open(path, READ_FLAGS);
    const start = await handle.stat();
    if (!safeFile(start, maximumBytes) || !sameFileNode(fileNode(link), fileNode(start))) {
      result = { status: "changed" };
    } else {
      const buffer = Buffer.alloc(start.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }

      const end = await handle.stat();
      const current = await lstat(path);
      if (
        offset !== start.size
        || !safeFile(end, maximumBytes)
        || !safeFile(current, maximumBytes)
        || !sameFileNode(fileNode(start), fileNode(end))
        || !sameFileNode(fileNode(end), fileNode(current))
      ) {
        result = { status: "changed" };
      } else {
        const content = decodeExactUtf8(buffer.subarray(0, offset));
        result = content === null
          ? { status: "invalid" }
          : { status: "ok", content, node: fileNode(end) };
      }
    }
  } catch {
    result = { status: "failed" };
  }

  try {
    await handle?.close();
  } catch {
    return { status: "failed" };
  }
  return result;
};

const writeAll = async (handle: Awaited<ReturnType<typeof open>>, content: Buffer) => {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error("markdown_lifecycle_write_failed");
    }
    offset += bytesWritten;
  }
};

const writeNewTextFile = async (path: string, content: string): Promise<SafeWriteResult> => {
  const bytes = Buffer.from(content, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, CREATE_FLAGS, FILE_MODE);
  } catch (error) {
    return errorCode(error) === "EEXIST" ? "exists" : "failed";
  }

  let result: SafeWriteResult = "uncertain";
  let writtenNode: FileNode | null = null;
  try {
    const start = await handle.stat();
    if (safeFile(start, bytes.length) && start.size === 0) {
      await writeAll(handle, bytes);
      await handle.sync();
      const end = await handle.stat();
      if (
        safeFile(end, bytes.length)
        && sameFileIdentity(fileNode(start), fileNode(end))
        && end.size === bytes.length
      ) {
        result = "written";
        writtenNode = fileNode(end);
      }
    }
  } catch {
    result = "uncertain";
  }

  try {
    await handle.close();
  } catch {
    return "uncertain";
  }
  if (result !== "written" || !writtenNode) return result;

  try {
    const current = await lstat(path);
    return safeFile(current, bytes.length)
      && sameFileNode(fileNode(current), writtenNode)
      ? "written"
      : "uncertain";
  } catch {
    return "uncertain";
  }
};

const lockContent = (token: string) => `${JSON.stringify({
  schemaVersion: 1,
  provider: MARKDOWN_LIFECYCLE_PROVIDER,
  token,
})}\n`;

const acquireLifecycleLease = async (
  scope: LifecycleScope,
): Promise<{ status: "acquired"; lease: LifecycleLease } | { status: "active" | "unavailable" }> => {
  const path = scopedFilePath(scope, LOCK_NAME);
  if (!path) return { status: "unavailable" };

  let content: string;
  try {
    content = lockContent(randomUUID());
  } catch {
    return { status: "unavailable" };
  }
  const written = await writeNewTextFile(path, content);
  if (written === "exists") return { status: "active" };
  if (written !== "written") return { status: "unavailable" };

  const read = await readTextFile(path, MAX_LOCK_BYTES);
  return read.status === "ok" && read.content === content
    ? { status: "acquired", lease: { path, content, node: read.node } }
    : { status: "unavailable" };
};

const ownsLifecycleLease = async (lease: LifecycleLease) => {
  const current = await readTextFile(lease.path, MAX_LOCK_BYTES);
  return current.status === "ok"
    && current.content === lease.content
    && sameFileNode(current.node, lease.node);
};

const releaseLifecycleLease = async (lease: LifecycleLease) => {
  if (!await ownsLifecycleLease(lease)) return false;
  try {
    const current = await lstat(lease.path);
    if (!safeFile(current, MAX_LOCK_BYTES) || !sameFileNode(fileNode(current), lease.node)) {
      return false;
    }
    await unlink(lease.path);
    return true;
  } catch {
    return false;
  }
};

const observedLease = async (
  scope: LifecycleScope,
): Promise<"clear" | "active" | "unavailable"> => {
  const path = scopedFilePath(scope, LOCK_NAME);
  if (!path) return "unavailable";
  try {
    await lstat(path);
    return "active";
  } catch (error) {
    return isNotFound(error) ? "clear" : "unavailable";
  }
};

const sameRecord = (
  left: MarkdownLifecyclePreparedRecord | MarkdownLifecycleVerifiedRecord,
  right: MarkdownLifecyclePreparedRecord | MarkdownLifecycleVerifiedRecord,
) => left.lifecycleKey === right.lifecycleKey
  && left.phase === right.phase
  && left.artifactId === right.artifactId
  && left.summary === right.summary
  && left.artifact === right.artifact
  && left.contentHash === right.contentHash
  && left.receiptHash === right.receiptHash
  && left.identity.project === right.identity.project
  && left.identity.lifecycleKey === right.identity.lifecycleKey
  && left.identity.lifecycleRootMemoryId === right.identity.lifecycleRootMemoryId
  && left.identity.taskwarriorProject === right.identity.taskwarriorProject
  && left.identity.taskwarriorTask === right.identity.taskwarriorTask
  && left.identity.taskwarriorUuid === right.identity.taskwarriorUuid
  && left.identity.jiraKey === right.identity.jiraKey
  && left.identity.planeWorkspace === right.identity.planeWorkspace
  && left.identity.planeWorkItem === right.identity.planeWorkItem
  && left.identity.sourceRefs.length === right.identity.sourceRefs.length
  && left.identity.sourceRefs.every((value, index) => value === right.identity.sourceRefs[index])
  && left.identity.priorArtifactIds.length === right.identity.priorArtifactIds.length
  && left.identity.priorArtifactIds.every((value, index) => value === right.identity.priorArtifactIds[index]);

const inspectPair = async (input: {
  scope: LifecycleScope;
  phase: LifecyclePhase;
  artifactId: string;
}): Promise<PairObservation> => {
  const artifactName = markdownLifecycleArtifactName(input);
  const receiptName = markdownLifecycleReceiptName(input);
  if (!artifactName || !receiptName) return { status: "invalid" };
  const artifactPath = scopedFilePath(input.scope, artifactName);
  const receiptPath = scopedFilePath(input.scope, receiptName);
  if (!artifactPath || !receiptPath) return { status: "invalid" };

  const artifact = await readTextFile(artifactPath, MAX_MARKDOWN_LIFECYCLE_ARTIFACT_BYTES);
  const receipt = await readTextFile(receiptPath, MAX_MARKDOWN_LIFECYCLE_RECEIPT_BYTES);
  if (artifact.status === "missing" && receipt.status === "missing") return { status: "absent" };
  if (artifact.status === "missing" || receipt.status === "missing") return { status: "partial" };
  if (artifact.status !== "ok" || receipt.status !== "ok") return { status: "invalid" };

  const record = verifyMarkdownLifecycleRecord({
    artifact: artifact.content,
    receipt: receipt.content,
    checkoutRoot: input.scope.checkoutRoot,
  });
  return record
    && record.phase === input.phase
    && record.artifactId === input.artifactId
    ? { status: "verified", record }
    : { status: "invalid" };
};

const verifiedResult = (
  record: MarkdownLifecycleVerifiedRecord,
  disposition: "stored" | "unchanged",
): MarkdownLifecycleVerifiedResult => ({
  provider: MARKDOWN_LIFECYCLE_PROVIDER,
  status: "verified",
  disposition,
  storageSchemaVersion: 1,
  sourceId: `markdown:lifecycle:${record.artifactId}`,
  checkoutRoot: record.checkoutRoot,
  lifecycleKey: record.lifecycleKey,
  phase: record.phase,
  artifactId: record.artifactId,
  contentHash: record.contentHash,
  receiptHash: record.receiptHash,
  identity: detachedIdentity(record.identity),
  summary: record.summary,
  artifact: record.artifact,
  reference: detachedMarkdownLifecycleReference(record.reference),
});

const referenceFor = (
  checkoutRoot: string,
  record: MarkdownLifecyclePreparedRecord,
): MarkdownLifecycleReference | null => markdownLifecycleReferenceFor({ checkoutRoot, record });

const persistWithLease = async (input: {
  scope: LifecycleScope;
  lease: LifecycleLease;
  record: MarkdownLifecyclePreparedRecord;
  reference: MarkdownLifecycleReference;
  signal?: AbortSignal;
}): Promise<MarkdownLifecycleVerifiedResult | MarkdownLifecycleBlockedResult> => {
  if (isAborted(input.signal)) return blocked("aborted", input.reference);
  if (!await scopeIsStable(input.scope)) return blocked("markdown_path_invalid", input.reference);
  if (!await ownsLifecycleLease(input.lease)) return blocked("markdown_lease_lost", input.reference);

  const existing = await inspectPair({
    scope: input.scope,
    phase: input.record.phase,
    artifactId: input.record.artifactId,
  });
  if (isAborted(input.signal)) return blocked("aborted", input.reference);
  if (!await scopeIsStable(input.scope)) return blocked("markdown_path_invalid", input.reference);
  if (!await ownsLifecycleLease(input.lease)) return blocked("markdown_lease_lost", input.reference);
  if (existing.status === "verified") {
    return sameRecord(existing.record, input.record)
      ? verifiedResult(existing.record, "unchanged")
      : blocked("markdown_target_conflict", input.reference);
  }
  if (existing.status === "partial") return blocked("markdown_partial_evidence", input.reference);
  if (existing.status === "invalid") return blocked("markdown_target_unverifiable", input.reference);

  const artifactName = markdownLifecycleArtifactName(input.record);
  const receiptName = markdownLifecycleReceiptName(input.record);
  if (!artifactName || !receiptName) return blocked("markdown_operation_failed", input.reference);
  const artifactPath = scopedFilePath(input.scope, artifactName);
  const receiptPath = scopedFilePath(input.scope, receiptName);
  if (!artifactPath || !receiptPath) return blocked("markdown_containment_violation", input.reference);

  if (isAborted(input.signal)) return blocked("aborted", input.reference);
  const artifactWrite = await writeNewTextFile(artifactPath, input.record.artifact);
  if (artifactWrite === "exists") return blocked("markdown_target_conflict", input.reference);
  if (artifactWrite === "failed") return blocked("markdown_write_failed", input.reference);
  if (artifactWrite !== "written") return blocked("markdown_write_uncertain", input.reference);
  if (isAborted(input.signal)) return blocked("aborted", input.reference);
  if (!await scopeIsStable(input.scope)) return blocked("markdown_path_invalid", input.reference);
  if (!await ownsLifecycleLease(input.lease)) return blocked("markdown_lease_lost", input.reference);

  const artifactReadBack = await readTextFile(artifactPath, MAX_MARKDOWN_LIFECYCLE_ARTIFACT_BYTES);
  if (artifactReadBack.status !== "ok" || artifactReadBack.content !== input.record.artifact) {
    return blocked("markdown_verification_failed", input.reference);
  }
  if (isAborted(input.signal)) return blocked("aborted", input.reference);
  if (!await scopeIsStable(input.scope)) return blocked("markdown_path_invalid", input.reference);
  if (!await ownsLifecycleLease(input.lease)) return blocked("markdown_lease_lost", input.reference);

  const receiptWrite = await writeNewTextFile(receiptPath, input.record.serializedReceipt);
  if (receiptWrite === "exists") return blocked("markdown_target_conflict", input.reference);
  if (receiptWrite === "failed") return blocked("markdown_write_failed", input.reference);
  if (receiptWrite !== "written") return blocked("markdown_write_uncertain", input.reference);
  if (isAborted(input.signal)) return blocked("aborted", input.reference);
  if (!await scopeIsStable(input.scope)) return blocked("markdown_path_invalid", input.reference);
  if (!await ownsLifecycleLease(input.lease)) return blocked("markdown_lease_lost", input.reference);

  const verified = await inspectPair({
    scope: input.scope,
    phase: input.record.phase,
    artifactId: input.record.artifactId,
  });
  if (isAborted(input.signal)) return blocked("aborted", input.reference);
  if (!await scopeIsStable(input.scope)) return blocked("markdown_path_invalid", input.reference);
  if (!await ownsLifecycleLease(input.lease)) return blocked("markdown_lease_lost", input.reference);
  return verified.status === "verified" && sameRecord(verified.record, input.record)
    ? verifiedResult(verified.record, "stored")
    : blocked("markdown_verification_failed", input.reference);
};

const referenceContainsSecret = (reference: MarkdownLifecycleReference) => [
  reference.checkoutRoot,
  reference.lifecycleKey,
  reference.phase,
  reference.artifactId,
  reference.contentHash,
  reference.receiptHash,
].some((value) => containsRecognizedMarkdownLifecycleSecret(value));

const selectionContainsSecret = (selection: MarkdownLifecycleSelection) => [
  selection.lifecycleKey,
  selection.phase,
].some((value) => containsRecognizedMarkdownLifecycleSecret(value));

const artifactCandidate = (name: string): { phase: LifecyclePhase; artifactId: string } | "invalid" | null => {
  const match = ARTIFACT_NAME_PATTERN.exec(name);
  if (match) return { phase: match[1] as LifecyclePhase, artifactId: match[2] };
  return LIFECYCLE_LOOKING_ARTIFACT_PATTERN.test(name) ? "invalid" : null;
};

const receiptCandidate = (name: string): { phase: LifecyclePhase; artifactId: string } | "invalid" | null => {
  const match = RECEIPT_NAME_PATTERN.exec(name);
  if (match) return { phase: match[1] as LifecyclePhase, artifactId: match[2] };
  return LIFECYCLE_LOOKING_RECEIPT_PATTERN.test(name) ? "invalid" : null;
};

const enumerateScope = async (
  scope: LifecycleScope,
): Promise<{ status: "ok"; names: string[]; node: DirectoryNode } | { status: "invalid" | "failed" }> => {
  const before = await checkedDirectory(scope.checkoutRoot, scope.directory);
  if (before.status !== "ok") return { status: "invalid" };

  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  const names: string[] = [];
  try {
    directory = await opendir(scope.directory);
    for await (const entry of directory) {
      if (typeof entry.name !== "string" || names.length >= MAX_MARKDOWN_LIFECYCLE_ENUMERATION) {
        return { status: "invalid" };
      }
      names.push(entry.name);
    }
  } catch {
    return { status: "failed" };
  } finally {
    if (directory) await directory.close().catch(() => {});
  }

  const after = await checkedDirectory(scope.checkoutRoot, scope.directory);
  return after.status === "ok" && sameDirectoryNode(before.directory.node, after.directory.node)
    ? { status: "ok", names, node: after.directory.node }
    : { status: "invalid" };
};

/**
 * Creates an additive local-only Markdown adapter. `checkoutRoot` is a
 * checkout-local path, never a credential or a shared provider setting.
 */
export const createMarkdownLifecycleAdapter = (input: {
  checkoutRoot: unknown;
}): MarkdownLifecycleAdapter => {
  const configuredRoot = checkoutRootFrom(input);
  const configuredRootContainsSecret = configuredRoot !== null
    && containsRecognizedMarkdownLifecycleSecret(configuredRoot);

  const persist = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MarkdownLifecycleVerifiedResult | MarkdownLifecycleBlockedResult> => {
    const prepared = createMarkdownLifecycleRecord(value);
    if (!prepared.valid) return blocked(prepared.code);
    if (isAborted(signal)) return blocked("aborted");
    if (configuredRootContainsSecret) return blocked("markdown_secret_detected");

    const checkout = await checkedCheckoutRoot(configuredRoot);
    if (!checkout) return blocked("markdown_checkout_invalid");
    const reference = referenceFor(checkout.path, prepared.data);
    if (!reference) return blocked("markdown_checkout_invalid");
    if (isAborted(signal)) return blocked("aborted", reference);

    const scope = await lifecycleScope({
      checkoutRoot: checkout.path,
      lifecycleKey: prepared.data.lifecycleKey,
      create: true,
    });
    if (scope.status !== "ok") {
      return blocked(
        scope.status === "escape" ? "markdown_containment_violation" : "markdown_path_invalid",
        reference,
      );
    }
    if (isAborted(signal)) return blocked("aborted", reference);

    const acquired = await acquireLifecycleLease(scope.scope);
    if (acquired.status === "active") return blocked("markdown_lease_active", reference);
    if (acquired.status !== "acquired") return blocked("markdown_lease_unavailable", reference);

    let outcome: MarkdownLifecycleVerifiedResult | MarkdownLifecycleBlockedResult;
    try {
      outcome = await persistWithLease({
        scope: scope.scope,
        lease: acquired.lease,
        record: prepared.data,
        reference,
        signal,
      });
    } catch {
      outcome = blocked("markdown_operation_failed", reference);
    }

    if (!await releaseLifecycleLease(acquired.lease)) {
      return blocked("markdown_lease_release_failed", reference);
    }
    return isAborted(signal) ? blocked("aborted", reference) : outcome;
  };

  const get = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MarkdownLifecycleVerifiedResult | MarkdownLifecycleBlockedResult> => {
    const reference = projectMarkdownLifecycleReference(value);
    if (!reference) return blocked("markdown_reference_invalid");
    if (referenceContainsSecret(reference)) return blocked("markdown_secret_detected");
    if (isAborted(signal)) return blocked("aborted", reference);
    if (configuredRootContainsSecret) return blocked("markdown_secret_detected");

    const checkout = await checkedCheckoutRoot(configuredRoot);
    if (!checkout || reference.checkoutRoot !== checkout.path) {
      return blocked("markdown_reference_invalid", reference);
    }
    const scope = await lifecycleScope({
      checkoutRoot: checkout.path,
      lifecycleKey: reference.lifecycleKey,
      create: false,
    });
    if (scope.status === "missing") return blocked("markdown_record_not_found", reference);
    if (scope.status !== "ok") {
      return blocked(
        scope.status === "escape" ? "markdown_containment_violation" : "markdown_path_invalid",
        reference,
      );
    }
    if (isAborted(signal)) return blocked("aborted", reference);

    const lease = await observedLease(scope.scope);
    if (lease === "active") return blocked("markdown_lease_active", reference);
    if (lease !== "clear") return blocked("markdown_lease_unavailable", reference);

    const before = await checkedDirectory(scope.scope.checkoutRoot, scope.scope.directory);
    if (before.status !== "ok") return blocked("markdown_path_invalid", reference);
    const observed = await inspectPair({
      scope: scope.scope,
      phase: reference.phase,
      artifactId: reference.artifactId,
    });
    if (isAborted(signal)) return blocked("aborted", reference);
    const after = await checkedDirectory(scope.scope.checkoutRoot, scope.scope.directory);
    if (
      after.status !== "ok"
      || !sameDirectoryNode(before.directory.node, after.directory.node)
    ) return blocked("markdown_verification_failed", reference);
    const finalLease = await observedLease(scope.scope);
    if (finalLease === "active") return blocked("markdown_lease_active", reference);
    if (finalLease !== "clear") return blocked("markdown_lease_unavailable", reference);

    if (observed.status === "absent") return blocked("markdown_record_not_found", reference);
    if (observed.status === "partial") return blocked("markdown_partial_evidence", reference);
    if (observed.status !== "verified" || !sameMarkdownLifecycleReference(observed.record.reference, reference)) {
      return blocked("markdown_verification_failed", reference);
    }
    return verifiedResult(observed.record, "unchanged");
  };

  const recall = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<MarkdownLifecycleVerifiedResult[] | MarkdownLifecycleBlockedResult> => {
    const selection = projectMarkdownLifecycleSelection(value);
    if (!selection) return blocked("markdown_selection_invalid");
    if (selectionContainsSecret(selection)) return blocked("markdown_secret_detected");
    if (isAborted(signal)) return blocked("aborted");
    if (configuredRootContainsSecret) return blocked("markdown_secret_detected");

    const checkout = await checkedCheckoutRoot(configuredRoot);
    if (!checkout) return blocked("markdown_checkout_invalid");
    const scope = await lifecycleScope({
      checkoutRoot: checkout.path,
      lifecycleKey: selection.lifecycleKey,
      create: false,
    });
    if (scope.status === "missing") return [];
    if (scope.status !== "ok") {
      return blocked(
        scope.status === "escape" ? "markdown_containment_violation" : "markdown_path_invalid",
      );
    }
    if (isAborted(signal)) return blocked("aborted");

    const lease = await observedLease(scope.scope);
    if (lease === "active") return blocked("markdown_lease_active");
    if (lease !== "clear") return blocked("markdown_lease_unavailable");

    const enumerated = await enumerateScope(scope.scope);
    if (enumerated.status !== "ok") return blocked("markdown_recall_unverifiable");
    if (isAborted(signal)) return blocked("aborted");

    const artifactNames = new Set<string>();
    const receiptNames = new Set<string>();
    const artifacts: { phase: LifecyclePhase; artifactId: string; name: string }[] = [];
    const candidates: { phase: LifecyclePhase; artifactId: string; name: string }[] = [];
    for (const name of enumerated.names) {
      const artifact = artifactCandidate(name);
      if (artifact === "invalid") return blocked("markdown_recall_unverifiable");
      if (artifact) {
        if (artifactNames.has(name)) return blocked("markdown_recall_unverifiable");
        artifactNames.add(name);
        artifacts.push({ ...artifact, name });
        continue;
      }

      const candidate = receiptCandidate(name);
      if (candidate === "invalid") return blocked("markdown_recall_unverifiable");
      if (!candidate) continue;
      if (receiptNames.has(name)) return blocked("markdown_recall_unverifiable");
      receiptNames.add(name);
      candidates.push({ ...candidate, name });
    }

    for (const artifact of artifacts) {
      const receiptName = markdownLifecycleReceiptName(artifact);
      if (!receiptName || !receiptNames.has(receiptName)) {
        return blocked("markdown_recall_unverifiable");
      }
    }
    for (const candidate of candidates) {
      const artifactName = markdownLifecycleArtifactName(candidate);
      if (!artifactName || !artifactNames.has(artifactName)) {
        return blocked("markdown_recall_unverifiable");
      }
    }

    const artifactIds = new Set<string>();
    const records: MarkdownLifecycleVerifiedRecord[] = [];
    for (const candidate of candidates.sort((left, right) => left.name.localeCompare(right.name))) {
      if (isAborted(signal)) return blocked("aborted");
      if (!await scopeIsStable(scope.scope, enumerated.node)) {
        return blocked("markdown_recall_unverifiable");
      }
      const leaseDuringRead = await observedLease(scope.scope);
      if (leaseDuringRead === "active") return blocked("markdown_lease_active");
      if (leaseDuringRead !== "clear") return blocked("markdown_lease_unavailable");

      const observed = await inspectPair({
        scope: scope.scope,
        phase: candidate.phase,
        artifactId: candidate.artifactId,
      });
      if (
        observed.status !== "verified"
        || observed.record.lifecycleKey !== selection.lifecycleKey
        || artifactIds.has(observed.record.artifactId)
      ) return blocked("markdown_recall_unverifiable");

      artifactIds.add(observed.record.artifactId);
      records.push(observed.record);
    }

    if (isAborted(signal)) return blocked("aborted");
    if (!await scopeIsStable(scope.scope, enumerated.node)) {
      return blocked("markdown_recall_unverifiable");
    }
    const finalLease = await observedLease(scope.scope);
    if (finalLease === "active") return blocked("markdown_lease_active");
    if (finalLease !== "clear") return blocked("markdown_lease_unavailable");

    const selected = records.filter((record) =>
      selection.phase === undefined || record.phase === selection.phase,
    );
    if (selected.length > MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT) {
      return blocked("markdown_recall_unverifiable");
    }
    return selected
      .slice(0, selection.limit)
      .map((record) => verifiedResult(record, "unchanged"));
  };

  return { persist, get, recall };
};
