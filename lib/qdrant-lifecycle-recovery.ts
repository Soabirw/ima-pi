import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { acquireLifecycleOperationLease } from "./ima-lifecycle-operation-lease.ts";
import {
  defaultResolveCycleProjectRoot,
  type ResolveCycleProjectRoot,
} from "./ima-cycle-persistence.ts";
import { normalizeLifecycleRecordKey } from "./ima-lifecycle.ts";
import {
  projectLifecycleProviderPin,
  sameLifecycleProviderPin,
  type LifecycleProviderPin,
  type QdrantLifecycleProviderRecovery,
} from "./ima-lifecycle-pin.ts";
import {
  advanceQdrantLifecyclePinRecoveryWith,
  beginQdrantLifecyclePinRecoveryWith,
  clearQdrantLifecyclePinRecoveryWith,
  loadLifecyclePinStateWith,
} from "./ima-lifecycle-pin-store.ts";
import {
  createVerifiedInstitutionalSnapshot,
} from "./qdrant-http-boundary.ts";
import {
  createQdrantCorpusClient,
  type QdrantCorpusClient,
} from "./qdrant-http.ts";
import {
  MAX_QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_BYTES,
  MAX_QDRANT_LIFECYCLE_RECOVERY_REPORT_BYTES,
  createQdrantLifecycleRecoveryAbsenceProof,
  createQdrantLifecycleRecoveryArchive,
  createQdrantLifecycleRecoveryCheckpoint,
  createQdrantLifecycleRecoveryReport,
  projectQdrantLifecycleRecoveryArchive,
  projectQdrantLifecycleRecoveryReport,
  qdrantLifecycleRecoveryPinFingerprint,
  reportMatchesQdrantLifecycleRecoveryArchive,
  sameQdrantLifecycleRecoveryInventory,
  serializeQdrantLifecycleRecoveryArchive,
  serializeQdrantLifecycleRecoveryReport,
  type QdrantLifecycleRecoveryArchive,
  type QdrantLifecycleRecoveryReport,
} from "./qdrant-lifecycle-recovery-report.ts";
import {
  isCorpusErrorCode,
  utf8ByteLength,
  type CorpusResult,
} from "./qdrant-corpus.ts";

const CYCLE_GITIGNORE = ".gitignore";
const CYCLE_GITIGNORE_BODY = "*\n";
const REPORT_NAME = /^qdrant-lifecycle-reset-([A-Za-z0-9-]{1,96})\.report\.json$/;
const ARCHIVE_NAME = /^qdrant-lifecycle-reset-([A-Za-z0-9-]{1,96})\.archive\.json$/;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const PRIVATE_FILE_MODE = 0o600;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type QdrantLifecycleResetConfirmation = Readonly<{
  operation: "execute" | "reconcile";
  stage: "intent" | "deletion";
  lifecycleKey: string;
  reportHash: string;
  recordCount: number;
  pointCount: number;
  destructiveScope: Readonly<{
    kind: "report_listed_qdrant_lifecycle_inventory";
    lifecycleKey: string;
    inventoryFingerprint: string;
    recordCount: number;
    pointCount: number;
  }>;
  snapshotReceipt?: Readonly<{ name: string }>;
}>;

export type QdrantLifecycleResetDependencies = {
  client?: QdrantCorpusClient;
  createSnapshot?: (signal?: AbortSignal) => Promise<CorpusResult<{ name: string }>>;
  now?: () => Date;
  resolveProjectRoot?: ResolveCycleProjectRoot;
  confirmReset?: (confirmation: QdrantLifecycleResetConfirmation) => Promise<unknown> | unknown;
};

export type QdrantLifecycleResetPreparedResult = {
  status: "prepared";
  reportPath: string;
  reportHash: string;
  lifecycleKey: string;
  recordCount: number;
  pointCount: number;
};

export type QdrantLifecycleResetCompletedResult = {
  status: "completed" | "reconciled";
  reportPath: string;
  reportHash: string;
  lifecycleKey: string;
  recordCount: number;
  pointCount: number;
};

export type QdrantLifecycleResetBlockedResult = {
  status: "blocked";
  code: string;
};

type ResetPaths = {
  root: string;
  directory: string;
};

type ReadResetReport = ResetPaths & {
  reportPath: string;
  reportHash: string;
  report: QdrantLifecycleRecoveryReport;
  archive: QdrantLifecycleRecoveryArchive;
};

type PrivateFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
  text: string;
};

class ResetFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new ResetFailure(code);
};

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : "";

const isMissing = (error: unknown) => errorCode(error) === "ENOENT";

const isInside = (root: string, path: string) => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (
    fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
};

const sameNode = (
  left: { dev: number; ino: number; size: number },
  right: { dev: number; ino: number; size: number },
) => left.dev === right.dev && left.ino === right.ino && left.size === right.size;

const isPrivateFile = (mode: number) => (mode & 0o777) === PRIVATE_FILE_MODE;

const throwIfAborted = (signal?: AbortSignal) => signal?.throwIfAborted();

const dependenciesFor = (
  supplied: QdrantLifecycleResetDependencies = {},
): Required<QdrantLifecycleResetDependencies> => ({
  client: supplied.client ?? createQdrantCorpusClient(),
  createSnapshot: supplied.createSnapshot
    ?? ((signal?: AbortSignal) => createVerifiedInstitutionalSnapshot({}, signal)),
  now: supplied.now ?? (() => new Date()),
  resolveProjectRoot: supplied.resolveProjectRoot ?? defaultResolveCycleProjectRoot,
  confirmReset: supplied.confirmReset ?? (() => null),
});

const timestamp = (now: () => Date) => {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString()
      : null;
  } catch {
    return null;
  }
};

const canonicalHash = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;

const reportPathValue = (value: unknown): string | null => {
  if (typeof value !== "string" || isAbsolute(value) || value.includes("\\")) return null;
  const match = /^\.ima-cycle\/(qdrant-lifecycle-reset-[A-Za-z0-9-]{1,96}\.report\.json)$/.exec(value);
  return match && REPORT_NAME.test(match[1]) ? value : null;
};

const safeResultCode = (result: CorpusResult<unknown>) =>
  !result.success && isCorpusErrorCode(result.error.code)
    ? result.error.code
    : "qdrant_unavailable";

const resultFailure = (operation: string, result: CorpusResult<unknown>): QdrantLifecycleResetBlockedResult => ({
  status: "blocked",
  code: `${operation}_${safeResultCode(result)}`,
});

const rootFor = async (
  cwd: string,
  resolveProjectRoot: ResolveCycleProjectRoot,
): Promise<string> => {
  let candidate: string;
  try {
    candidate = await resolveProjectRoot(cwd);
  } catch {
    return fail("lifecycle_reset_root_unavailable");
  }
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    return fail("lifecycle_reset_root_unavailable");
  }
  try {
    const before = await lstat(candidate);
    if (!before.isDirectory() || before.isSymbolicLink()) return fail("lifecycle_reset_root_invalid");
    const root = await realpath(candidate);
    const after = await lstat(root);
    return after.isDirectory() && !after.isSymbolicLink() && root === resolve(candidate)
      ? root
      : fail("lifecycle_reset_root_invalid");
  } catch {
    return fail("lifecycle_reset_root_unavailable");
  }
};

const safePrivateFile = async (
  root: string,
  directory: string,
  name: string,
  maximumBytes: number,
): Promise<PrivateFile> => {
  const path = join(directory, name);
  if (
    !isInside(root, path)
    || dirname(path) !== directory
    || !ARTIFACT_NAME.test(name)
  ) return fail("lifecycle_reset_artifact_invalid");
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    return isMissing(error)
      ? fail("lifecycle_reset_artifact_missing")
      : fail("lifecycle_reset_artifact_unavailable");
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size < 1
    || before.size > maximumBytes
    || !isPrivateFile(before.mode)
  ) return fail("lifecycle_reset_artifact_invalid");

  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    return fail("lifecycle_reset_artifact_unavailable");
  }
  if (!isInside(directory, canonical) || canonical !== resolve(path)) {
    return fail("lifecycle_reset_artifact_invalid");
  }

  let handle;
  try {
    handle = await open(canonical, READ_FLAGS);
    const start = await handle.stat();
    if (
      !start.isFile()
      || start.nlink !== 1
      || !sameNode(before, start)
      || !isPrivateFile(start.mode)
    ) return fail("lifecycle_reset_artifact_invalid");
    const bytes = await handle.readFile();
    const end = await handle.stat();
    if (!sameNode(start, end) || bytes.byteLength !== start.size || bytes.byteLength > maximumBytes) {
      return fail("lifecycle_reset_artifact_changed");
    }
    let text: string;
    try {
      text = textDecoder.decode(bytes);
    } catch {
      return fail("lifecycle_reset_artifact_invalid");
    }
    return {
      path: canonical,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text,
    };
  } catch (error) {
    if (error instanceof ResetFailure) throw error;
    return fail("lifecycle_reset_artifact_unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const ensureCycleGitignore = async (root: string, directory: string) => {
  const path = join(directory, CYCLE_GITIGNORE);
  try {
    await writeFile(path, CYCLE_GITIGNORE_BODY, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") return fail("lifecycle_reset_directory_unavailable");
  }
  const file = await safePrivateFile(root, directory, CYCLE_GITIGNORE, 16);
  if (file.text !== CYCLE_GITIGNORE_BODY) fail("lifecycle_reset_directory_invalid");
};

const writePrivateArtifact = async (input: {
  root: string;
  directory: string;
  name: string;
  content: string;
  maximumBytes: number;
}): Promise<{ path: string; sizeBytes: number; sha256: string }> => {
  if (
    !ARTIFACT_NAME.test(input.name)
    || utf8ByteLength(input.content) > input.maximumBytes
  ) return fail("lifecycle_reset_artifact_invalid");
  const path = join(input.directory, input.name);
  if (!isInside(input.root, path) || dirname(path) !== input.directory) {
    return fail("lifecycle_reset_artifact_invalid");
  }
  let handle;
  try {
    handle = await open(path, WRITE_FLAGS, PRIVATE_FILE_MODE);
    const start = await handle.stat();
    if (!start.isFile() || start.isSymbolicLink() || start.nlink !== 1) {
      return fail("lifecycle_reset_artifact_invalid");
    }
    await handle.writeFile(Buffer.from(input.content, "utf8"));
    await handle.sync();
    const end = await handle.stat();
    if (
      start.dev !== end.dev
      || start.ino !== end.ino
      || end.size !== utf8ByteLength(input.content)
      || !isPrivateFile(end.mode)
    ) return fail("lifecycle_reset_artifact_invalid");
    return {
      path,
      sizeBytes: end.size,
      sha256: createHash("sha256").update(input.content, "utf8").digest("hex"),
    };
  } catch (error) {
    if (error instanceof ResetFailure) throw error;
    return errorCode(error) === "EEXIST"
      ? fail("lifecycle_reset_artifact_collision")
      : fail("lifecycle_reset_artifact_unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const artifactNames = (createdAt: string) => {
  const timestampPart = createdAt.replace(/[.:]/g, "-");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const base = `qdrant-lifecycle-reset-${timestampPart}-${suffix}`;
  return { archive: `${base}.archive.json`, report: `${base}.report.json` };
};

const withResetLock = async <Data>(input: {
  cwd: string;
  dependencies: Required<QdrantLifecycleResetDependencies>;
  createDirectory: boolean;
  operation: (
    paths: ResetPaths,
    dependencies: Required<QdrantLifecycleResetDependencies>,
  ) => Promise<Data>;
}): Promise<Data> => {
  const root = await rootFor(input.cwd, input.dependencies.resolveProjectRoot);
  const lease = await acquireLifecycleOperationLease({
    root,
    createDirectory: input.createDirectory,
  });
  if (lease.status === "missing") return fail("lifecycle_reset_directory_missing");
  if (lease.status === "unavailable") return fail("lifecycle_reset_lock_unavailable");
  if (lease.status === "busy") return fail("lifecycle_reset_in_progress");
  const dependencies: Required<QdrantLifecycleResetDependencies> = {
    ...input.dependencies,
    resolveProjectRoot: async (_cwd: string) => lease.root,
  };
  try {
    if (input.createDirectory) await ensureCycleGitignore(lease.root, lease.directory);
    return await input.operation({ root: lease.root, directory: lease.directory }, dependencies);
  } finally {
    await lease.release().catch(() => undefined);
  }
};

const parseJson = (text: string, code: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return fail(code);
  }
};

const expectedArchiveName = (reportName: string) => {
  const match = REPORT_NAME.exec(reportName);
  return match ? `qdrant-lifecycle-reset-${match[1]}.archive.json` : "";
};

const readResetReport = async (input: {
  paths: ResetPaths;
  reportPathValue: unknown;
}): Promise<ReadResetReport> => {
  const reportPath = typeof input.reportPathValue === "string"
    ? input.reportPathValue
    : null;
  if (!reportPath) return fail("lifecycle_reset_report_invalid");
  const candidate = resolve(input.paths.root, reportPath);
  const reportName = basename(candidate);
  if (
    dirname(candidate) !== input.paths.directory
    || !isInside(input.paths.directory, candidate)
    || !REPORT_NAME.test(reportName)
  ) return fail("lifecycle_reset_report_invalid");
  const reportFile = await safePrivateFile(
    input.paths.root,
    input.paths.directory,
    reportName,
    MAX_QDRANT_LIFECYCLE_RECOVERY_REPORT_BYTES,
  );
  const report = projectQdrantLifecycleRecoveryReport(
    parseJson(reportFile.text, "lifecycle_reset_report_invalid"),
  );
  if (!report || report.archive.name !== expectedArchiveName(reportName)) {
    return fail("lifecycle_reset_report_invalid");
  }
  const archiveName = report.archive.name;
  if (!ARCHIVE_NAME.test(archiveName)) return fail("lifecycle_reset_report_invalid");
  const archiveFile = await safePrivateFile(
    input.paths.root,
    input.paths.directory,
    archiveName,
    MAX_QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_BYTES,
  );
  if (
    archiveFile.sizeBytes !== report.archive.sizeBytes
    || archiveFile.sha256 !== report.archive.sha256
  ) return fail("lifecycle_reset_archive_invalid");
  const archive = projectQdrantLifecycleRecoveryArchive(
    parseJson(archiveFile.text, "lifecycle_reset_archive_invalid"),
  );
  if (!archive || !reportMatchesQdrantLifecycleRecoveryArchive({ report, archive })) {
    return fail("lifecycle_reset_archive_invalid");
  }
  return {
    ...input.paths,
    reportPath: relative(input.paths.root, reportFile.path),
    reportHash: reportFile.sha256,
    report,
    archive,
  };
};

const reportPin = (report: QdrantLifecycleRecoveryReport): LifecycleProviderPin | null => {
  const pin = projectLifecycleProviderPin(report.expectedPin);
  const fingerprint = pin ? qdrantLifecycleRecoveryPinFingerprint(pin) : null;
  return pin
    && pin.provider === "qdrant"
    && fingerprint === report.expectedPinFingerprint
    ? pin
    : null;
};

const reportInventory = (bound: ReadResetReport) => ({
  schemaVersion: 1,
  lifecycleKey: bound.archive.lifecycleKey,
  records: bound.archive.records,
});

const reportMatchesInventory = (
  bound: ReadResetReport,
  inventory: unknown,
) => sameQdrantLifecycleRecoveryInventory(reportInventory(bound), inventory);

const reportHashMatches = (
  confirmation: unknown,
  reportHash: string,
) => canonicalHash(confirmation) === reportHash;

const resetConfirmation = (input: {
  operation: "execute" | "reconcile";
  stage: "intent" | "deletion";
  bound: ReadResetReport;
  snapshotName?: string;
}): QdrantLifecycleResetConfirmation | null => {
  const snapshotReceipt = input.stage === "deletion" && input.snapshotName
    ? Object.freeze({ name: input.snapshotName })
    : undefined;
  if (input.stage === "deletion" && !snapshotReceipt) return null;
  const destructiveScope = Object.freeze({
    kind: "report_listed_qdrant_lifecycle_inventory" as const,
    lifecycleKey: input.bound.report.lifecycleKey,
    inventoryFingerprint: input.bound.report.inventory.fingerprint,
    recordCount: input.bound.report.inventory.recordCount,
    pointCount: input.bound.report.inventory.pointCount,
  });
  return Object.freeze({
    operation: input.operation,
    stage: input.stage,
    lifecycleKey: input.bound.report.lifecycleKey,
    reportHash: input.bound.reportHash,
    recordCount: input.bound.report.inventory.recordCount,
    pointCount: input.bound.report.inventory.pointCount,
    destructiveScope,
    ...(snapshotReceipt ? { snapshotReceipt } : {}),
  });
};

const confirmResetIntent = async (input: {
  operation: "execute" | "reconcile";
  bound: ReadResetReport;
  dependencies: Required<QdrantLifecycleResetDependencies>;
}) => {
  const confirmation = resetConfirmation({
    operation: input.operation,
    stage: "intent",
    bound: input.bound,
  });
  if (!confirmation) return false;
  try {
    return await input.dependencies.confirmReset(confirmation) === confirmation;
  } catch {
    return false;
  }
};

const confirmResetDeletion = async (input: {
  bound: ReadResetReport;
  snapshotName: string | undefined;
  dependencies: Required<QdrantLifecycleResetDependencies>;
}) => {
  const confirmation = resetConfirmation({
    operation: "execute",
    stage: "deletion",
    bound: input.bound,
    snapshotName: input.snapshotName,
  });
  if (!confirmation) return false;
  try {
    return await input.dependencies.confirmReset(confirmation) === confirmation;
  } catch {
    return false;
  }
};

const pinStateCode = (status: string) => status === "recovering"
  ? "lifecycle_reset_recovery_unresolved"
  : status === "pending"
    ? "lifecycle_reset_pin_pending"
    : status === "absent"
      ? "lifecycle_reset_pin_missing"
      : ["corrupt", "conflicting", "inaccessible"].includes(status)
        ? `lifecycle_pin_store_${status}`
        : "lifecycle_reset_pin_invalid";

const currentPinnedQdrantPin = async (input: {
  cwd: string;
  lifecycleKey: string;
  dependencies: Required<QdrantLifecycleResetDependencies>;
}): Promise<LifecycleProviderPin | QdrantLifecycleResetBlockedResult> => {
  const state = await loadLifecyclePinStateWith(input.dependencies.resolveProjectRoot)(
    input.cwd,
    input.lifecycleKey,
  );
  return state.status === "pinned" && state.pin.provider === "qdrant"
    ? state.pin
    : { status: "blocked", code: pinStateCode(state.status) };
};

const currentRecovery = async (input: {
  cwd: string;
  lifecycleKey: string;
  dependencies: Required<QdrantLifecycleResetDependencies>;
}): Promise<QdrantLifecycleProviderRecovery | QdrantLifecycleResetBlockedResult> => {
  const state = await loadLifecyclePinStateWith(input.dependencies.resolveProjectRoot)(
    input.cwd,
    input.lifecycleKey,
  );
  return state.status === "recovering"
    ? state.recovery
    : { status: "blocked", code: pinStateCode(state.status) };
};

const recoveryMatchesReport = (input: {
  recovery: QdrantLifecycleProviderRecovery;
  report: QdrantLifecycleRecoveryReport;
  reportHash: string;
  expectedPin: LifecycleProviderPin;
}) => input.recovery.lifecycleKey === input.report.lifecycleKey
  && sameLifecycleProviderPin(input.recovery.expectedPin, input.expectedPin)
  && input.recovery.checkpoint.attemptId === input.report.attemptId
  && input.recovery.checkpoint.reportHash === input.reportHash
  && input.recovery.checkpoint.inventoryFingerprint === input.report.inventory.fingerprint
  && input.recovery.checkpoint.expectedPinFingerprint === input.report.expectedPinFingerprint
  && input.recovery.checkpoint.startedAt === input.report.createdAt;

const successful = <Data>(value: Data | QdrantLifecycleResetBlockedResult): value is Data =>
  !(typeof value === "object"
    && value !== null
    && "status" in value
    && value.status === "blocked");

const safely = async <Data>(
  signal: AbortSignal | undefined,
  operation: () => Promise<CorpusResult<Data>>,
): Promise<CorpusResult<Data> | null> => {
  try {
    throwIfAborted(signal);
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch {
    return null;
  }
};

const blockedForUnexpected = (signal?: AbortSignal): QdrantLifecycleResetBlockedResult => ({
  status: "blocked",
  code: signal?.aborted ? "aborted" : "lifecycle_reset_qdrant_unavailable",
});

export async function prepareQdrantLifecycleReset(input: {
  cwd: string;
  lifecycleKey: unknown;
  dependencies?: QdrantLifecycleResetDependencies;
  signal?: AbortSignal;
}): Promise<QdrantLifecycleResetPreparedResult | QdrantLifecycleResetBlockedResult> {
  const normalizedLifecycleKey = normalizeLifecycleRecordKey(input.lifecycleKey);
  const lifecycleKey = normalizedLifecycleKey === input.lifecycleKey
    ? normalizedLifecycleKey
    : null;
  const dependencies = dependenciesFor(input.dependencies);
  if (!lifecycleKey) return { status: "blocked", code: "lifecycle_reset_key_invalid" };
  try {
    return await withResetLock({
      cwd: input.cwd,
      dependencies,
      createDirectory: true,
      operation: async (paths, dependencies) => {
        throwIfAborted(input.signal);
        const firstPin = await currentPinnedQdrantPin({
          cwd: input.cwd,
          lifecycleKey,
          dependencies,
        });
        if (!successful<LifecycleProviderPin>(firstPin)) return firstPin;

        const inventory = await safely(
          input.signal,
          () => dependencies.client.inventoryLifecycleRecovery(lifecycleKey, input.signal),
        );
        if (!inventory) return blockedForUnexpected(input.signal);
        if (!inventory.success) return resultFailure("lifecycle_reset_inventory", inventory);

        const secondPin = await currentPinnedQdrantPin({
          cwd: input.cwd,
          lifecycleKey,
          dependencies,
        });
        if (!successful<LifecycleProviderPin>(secondPin)) return secondPin;
        if (!sameLifecycleProviderPin(firstPin, secondPin)) {
          return { status: "blocked", code: "lifecycle_reset_pin_stale" };
        }
        throwIfAborted(input.signal);

        const createdAt = timestamp(dependencies.now);
        if (!createdAt) return { status: "blocked", code: "lifecycle_reset_time_invalid" };
        const attemptId = randomUUID();
        const archive = createQdrantLifecycleRecoveryArchive(inventory.data);
        const archiveText = archive ? serializeQdrantLifecycleRecoveryArchive(archive) : null;
        if (!archive || !archiveText) return { status: "blocked", code: "lifecycle_reset_archive_invalid" };
        const names = artifactNames(createdAt);
        const archiveArtifact = await writePrivateArtifact({
          root: paths.root,
          directory: paths.directory,
          name: names.archive,
          content: archiveText,
          maximumBytes: MAX_QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_BYTES,
        });
        const report = createQdrantLifecycleRecoveryReport({
          createdAt,
          attemptId,
          expectedPin: firstPin,
          archive: {
            name: names.archive,
            sizeBytes: archiveArtifact.sizeBytes,
            sha256: archiveArtifact.sha256,
          },
          inventory: inventory.data,
        });
        const reportText = report ? serializeQdrantLifecycleRecoveryReport(report) : null;
        if (!report || !reportText) return { status: "blocked", code: "lifecycle_reset_report_invalid" };
        const reportArtifact = await writePrivateArtifact({
          root: paths.root,
          directory: paths.directory,
          name: names.report,
          content: reportText,
          maximumBytes: MAX_QDRANT_LIFECYCLE_RECOVERY_REPORT_BYTES,
        });
        return {
          status: "prepared",
          reportPath: relative(paths.root, reportArtifact.path),
          reportHash: reportArtifact.sha256,
          lifecycleKey,
          recordCount: report.inventory.recordCount,
          pointCount: report.inventory.pointCount,
        };
      },
    });
  } catch (error) {
    return {
      status: "blocked",
      code: input.signal?.aborted
        ? "aborted"
        : error instanceof ResetFailure ? error.code : "lifecycle_reset_unavailable",
    };
  }
}

const executeBoundReset = async (input: {
  cwd: string;
  bound: ReadResetReport;
  dependencies: Required<QdrantLifecycleResetDependencies>;
  signal?: AbortSignal;
}): Promise<QdrantLifecycleResetCompletedResult | QdrantLifecycleResetBlockedResult> => {
  const expectedPin = reportPin(input.bound.report);
  if (!expectedPin) return { status: "blocked", code: "lifecycle_reset_report_invalid" };
  const inventory = reportInventory(input.bound);
  const initialInventory = await safely(
    input.signal,
    () => input.dependencies.client.inventoryLifecycleRecovery(input.bound.report.lifecycleKey, input.signal),
  );
  if (!initialInventory) return blockedForUnexpected(input.signal);
  if (!initialInventory.success) return resultFailure("lifecycle_reset_inventory", initialInventory);
  if (!reportMatchesInventory(input.bound, initialInventory.data)) {
    return { status: "blocked", code: "lifecycle_reset_inventory_stale" };
  }
  const authority = await loadLifecyclePinStateWith(input.dependencies.resolveProjectRoot)(
    input.cwd,
    input.bound.report.lifecycleKey,
  );
  if (authority.status === "pinned" && !sameLifecycleProviderPin(authority.pin, expectedPin)) {
    return { status: "blocked", code: "lifecycle_pin_recovery_pin_conflict" };
  }
  if (authority.status === "recovering" && !recoveryMatchesReport({
    recovery: authority.recovery,
    report: input.bound.report,
    reportHash: input.bound.reportHash,
    expectedPin,
  })) return { status: "blocked", code: "lifecycle_reset_recovery_stale" };
  if (authority.status !== "pinned" && authority.status !== "recovering") {
    return { status: "blocked", code: pinStateCode(authority.status) };
  }
  throwIfAborted(input.signal);

  const initialCheckpoint = createQdrantLifecycleRecoveryCheckpoint({
    lifecycleKey: input.bound.report.lifecycleKey,
    attemptId: input.bound.report.attemptId,
    reportHash: input.bound.reportHash,
    inventoryFingerprint: input.bound.report.inventory.fingerprint,
    expectedPinFingerprint: input.bound.report.expectedPinFingerprint,
    stage: "prepared",
    startedAt: input.bound.report.createdAt,
  });
  if (!initialCheckpoint) return { status: "blocked", code: "lifecycle_reset_checkpoint_invalid" };
  const started = await beginQdrantLifecyclePinRecoveryWith(input.dependencies.resolveProjectRoot)(
    input.cwd,
    expectedPin,
    initialCheckpoint,
  );
  if (started.status !== "recovering") {
    return { status: "blocked", code: started.code };
  }
  let recovery = started.recovery;
  if (!recoveryMatchesReport({
    recovery,
    report: input.bound.report,
    reportHash: input.bound.reportHash,
    expectedPin,
  })) return { status: "blocked", code: "lifecycle_reset_recovery_stale" };
  if (input.signal?.aborted) return { status: "blocked", code: "aborted" };

  if (recovery.checkpoint.stage === "prepared") {
    const snapshotStarted = createQdrantLifecycleRecoveryCheckpoint({
      ...recovery.checkpoint,
      stage: "snapshot_started",
    });
    if (!snapshotStarted) return { status: "blocked", code: "lifecycle_reset_checkpoint_invalid" };
    const advanced = await advanceQdrantLifecyclePinRecoveryWith(input.dependencies.resolveProjectRoot)(
      input.cwd,
      recovery,
      snapshotStarted,
    );
    if (advanced.status !== "recovering") return { status: "blocked", code: advanced.code };
    recovery = advanced.recovery;

    const snapshot = await safely(input.signal, () => input.dependencies.createSnapshot(input.signal));
    if (!snapshot) return blockedForUnexpected(input.signal);
    if (!snapshot.success) return resultFailure("lifecycle_reset_snapshot", snapshot);
    const snapshotVerified = createQdrantLifecycleRecoveryCheckpoint({
      ...recovery.checkpoint,
      stage: "snapshot_verified",
      snapshotName: snapshot.data.name,
    });
    if (!snapshotVerified) return { status: "blocked", code: "lifecycle_reset_checkpoint_invalid" };
    const marked = await advanceQdrantLifecyclePinRecoveryWith(input.dependencies.resolveProjectRoot)(
      input.cwd,
      recovery,
      snapshotVerified,
    );
    if (marked.status !== "recovering") return { status: "blocked", code: marked.code };
    recovery = marked.recovery;
  }

  if (recovery.checkpoint.stage === "snapshot_started") {
    return { status: "blocked", code: "lifecycle_reset_snapshot_uncertain" };
  }
  if (recovery.checkpoint.stage === "deletion_started") {
    return { status: "blocked", code: "lifecycle_reset_deletion_uncertain" };
  }
  if (recovery.checkpoint.stage !== "snapshot_verified") {
    return { status: "blocked", code: "lifecycle_reset_checkpoint_invalid" };
  }

  const beforeDeletion = await safely(
    input.signal,
    () => input.dependencies.client.inventoryLifecycleRecovery(input.bound.report.lifecycleKey, input.signal),
  );
  if (!beforeDeletion) return blockedForUnexpected(input.signal);
  if (!beforeDeletion.success) return resultFailure("lifecycle_reset_inventory", beforeDeletion);
  if (!reportMatchesInventory(input.bound, beforeDeletion.data)) {
    return { status: "blocked", code: "lifecycle_reset_inventory_stale" };
  }
  const deletionConfirmed = await confirmResetDeletion({
    bound: input.bound,
    snapshotName: recovery.checkpoint.snapshotName,
    dependencies: input.dependencies,
  });
  if (!deletionConfirmed) {
    return { status: "blocked", code: "lifecycle_reset_confirmation_required" };
  }
  throwIfAborted(input.signal);

  const deletionStarted = createQdrantLifecycleRecoveryCheckpoint({
    ...recovery.checkpoint,
    stage: "deletion_started",
  });
  if (!deletionStarted) return { status: "blocked", code: "lifecycle_reset_checkpoint_invalid" };
  const markedDeletion = await advanceQdrantLifecyclePinRecoveryWith(input.dependencies.resolveProjectRoot)(
    input.cwd,
    recovery,
    deletionStarted,
  );
  if (markedDeletion.status !== "recovering") {
    return { status: "blocked", code: markedDeletion.code };
  }
  recovery = markedDeletion.recovery;

  const deleted = await safely(input.signal, () => input.dependencies.client.deleteLifecycleRecoveryInventory({
    lifecycleKey: input.bound.report.lifecycleKey,
    inventory,
  }, input.signal));
  if (!deleted) return blockedForUnexpected(input.signal);
  if (!deleted.success) return resultFailure("lifecycle_reset_delete", deleted);

  const absence = await safely(input.signal, () => input.dependencies.client.proveLifecycleRecoveryAbsence({
    lifecycleKey: input.bound.report.lifecycleKey,
    inventory,
  }, input.signal));
  if (!absence) return blockedForUnexpected(input.signal);
  if (!absence.success) return resultFailure("lifecycle_reset_absence", absence);

  const verifiedAt = timestamp(input.dependencies.now);
  const proof = verifiedAt ? createQdrantLifecycleRecoveryAbsenceProof({
    checkpoint: recovery.checkpoint,
    inventory,
    verifiedAt,
  }) : null;
  if (!proof) return { status: "blocked", code: "lifecycle_reset_absence_unverified" };
  const cleared = await clearQdrantLifecyclePinRecoveryWith(input.dependencies.resolveProjectRoot)(
    input.cwd,
    recovery,
    proof,
  );
  if (cleared.status !== "cleared") return { status: "blocked", code: cleared.code };
  return {
    status: "completed",
    reportPath: input.bound.reportPath,
    reportHash: input.bound.reportHash,
    lifecycleKey: input.bound.report.lifecycleKey,
    recordCount: input.bound.report.inventory.recordCount,
    pointCount: input.bound.report.inventory.pointCount,
  };
};

export async function executeQdrantLifecycleReset(input: {
  cwd: string;
  reportPath: unknown;
  confirmation: unknown;
  dependencies?: QdrantLifecycleResetDependencies;
  signal?: AbortSignal;
}): Promise<QdrantLifecycleResetCompletedResult | QdrantLifecycleResetBlockedResult> {
  const dependencies = dependenciesFor(input.dependencies);
  const reportPath = reportPathValue(input.reportPath);
  if (!reportPath) return { status: "blocked", code: "lifecycle_reset_report_invalid" };
  try {
    return await withResetLock({
      cwd: input.cwd,
      dependencies,
      createDirectory: false,
      operation: async (paths, dependencies) => {
        const bound = await readResetReport({ paths, reportPathValue: reportPath });
        if (!reportHashMatches(input.confirmation, bound.reportHash)) {
          return { status: "blocked", code: "lifecycle_reset_confirmation_invalid" };
        }
        if (!reportPin(bound.report)) {
          return { status: "blocked", code: "lifecycle_reset_report_invalid" };
        }
        const intentConfirmed = await confirmResetIntent({
          operation: "execute",
          bound,
          dependencies,
        });
        if (!intentConfirmed) {
          return { status: "blocked", code: "lifecycle_reset_confirmation_required" };
        }
        throwIfAborted(input.signal);
        return executeBoundReset({
          cwd: input.cwd,
          bound,
          dependencies,
          signal: input.signal,
        });
      },
    });
  } catch (error) {
    return {
      status: "blocked",
      code: input.signal?.aborted
        ? "aborted"
        : error instanceof ResetFailure ? error.code : "lifecycle_reset_unavailable",
    };
  }
}

export async function reconcileQdrantLifecycleReset(input: {
  cwd: string;
  reportPath: unknown;
  confirmation: unknown;
  dependencies?: QdrantLifecycleResetDependencies;
  signal?: AbortSignal;
}): Promise<QdrantLifecycleResetCompletedResult | QdrantLifecycleResetBlockedResult> {
  const dependencies = dependenciesFor(input.dependencies);
  const reportPath = reportPathValue(input.reportPath);
  if (!reportPath) return { status: "blocked", code: "lifecycle_reset_report_invalid" };
  try {
    return await withResetLock({
      cwd: input.cwd,
      dependencies,
      createDirectory: false,
      operation: async (paths, dependencies) => {
        const bound = await readResetReport({ paths, reportPathValue: reportPath });
        if (!reportHashMatches(input.confirmation, bound.reportHash)) {
          return { status: "blocked", code: "lifecycle_reset_confirmation_invalid" };
        }
        const expectedPin = reportPin(bound.report);
        if (!expectedPin) return { status: "blocked", code: "lifecycle_reset_report_invalid" };
        const intentConfirmed = await confirmResetIntent({
          operation: "reconcile",
          bound,
          dependencies,
        });
        if (!intentConfirmed) {
          return { status: "blocked", code: "lifecycle_reset_confirmation_required" };
        }
        const recovery = await currentRecovery({
          cwd: input.cwd,
          lifecycleKey: bound.report.lifecycleKey,
          dependencies,
        });
        if (!successful<QdrantLifecycleProviderRecovery>(recovery)) return recovery;
        if (!recoveryMatchesReport({
          recovery,
          report: bound.report,
          reportHash: bound.reportHash,
          expectedPin,
        })) return { status: "blocked", code: "lifecycle_reset_recovery_stale" };

        const absence = await safely(input.signal, () => dependencies.client.proveLifecycleRecoveryAbsence({
          lifecycleKey: bound.report.lifecycleKey,
          inventory: reportInventory(bound),
        }, input.signal));
        if (!absence) return blockedForUnexpected(input.signal);
        if (!absence.success) return resultFailure("lifecycle_reset_absence", absence);
        const verifiedAt = timestamp(dependencies.now);
        const proof = verifiedAt ? createQdrantLifecycleRecoveryAbsenceProof({
          checkpoint: recovery.checkpoint,
          inventory: reportInventory(bound),
          verifiedAt,
        }) : null;
        if (!proof) return { status: "blocked", code: "lifecycle_reset_absence_unverified" };
        const cleared = await clearQdrantLifecyclePinRecoveryWith(dependencies.resolveProjectRoot)(
          input.cwd,
          recovery,
          proof,
        );
        if (cleared.status !== "cleared") return { status: "blocked", code: cleared.code };
        return {
          status: "reconciled",
          reportPath: bound.reportPath,
          reportHash: bound.reportHash,
          lifecycleKey: bound.report.lifecycleKey,
          recordCount: bound.report.inventory.recordCount,
          pointCount: bound.report.inventory.pointCount,
        };
      },
    });
  } catch (error) {
    return {
      status: "blocked",
      code: input.signal?.aborted
        ? "aborted"
        : error instanceof ResetFailure ? error.code : "lifecycle_reset_unavailable",
    };
  }
}
