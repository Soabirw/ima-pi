import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareLifecycleArtifact,
  validateLifecycleWriteRequest,
} from "../lib/ima-lifecycle.ts";
import { createMarkdownLifecycleAdapter } from "../lib/markdown-lifecycle.ts";
import {
  MAX_MARKDOWN_LIFECYCLE_ENUMERATION,
  MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT,
  containsRecognizedMarkdownLifecycleSecret,
  createMarkdownLifecycleRecord,
  markdownLifecycleArtifactName,
  markdownLifecycleCheckoutFingerprint,
  markdownLifecycleDirectoryName,
  markdownLifecycleReceiptName,
  markdownLifecycleReferenceFor,
} from "../lib/markdown-lifecycle-record.ts";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const LIFECYCLE_KEY = "ima-pi:plane:ima:SKYNET-209";

const identityFor = (overrides = {}) => ({
  project: "ima-pi",
  lifecycleKey: LIFECYCLE_KEY,
  lifecycleRootMemoryId: "",
  taskwarriorProject: "",
  taskwarriorTask: "",
  taskwarriorUuid: "",
  jiraKey: "",
  planeWorkspace: "ima",
  planeWorkItem: "SKYNET-209",
  sourceRefs: ["plane:ima:SKYNET-209"],
  priorArtifactIds: [],
  ...overrides,
});

const lifecycleInputFor = ({
  phase = "plan",
  identity = identityFor(),
  summary = "Markdown lifecycle adapter evidence is exact and independently verifiable.",
  payload = "# Markdown lifecycle evidence\n\nThis is deterministic local test evidence.",
} = {}) => ({
  type: phase,
  identity,
  summary,
  artifact: payload,
});

const fixtureFor = (options = {}) => {
  const lifecycleInput = lifecycleInputFor(options);
  const validated = validateLifecycleWriteRequest(lifecycleInput);
  assert.equal(validated.valid, true, "test fixture must satisfy the lifecycle contract");
  const prepared = prepareLifecycleArtifact(validated);
  assert.equal(prepared.valid, true, "test fixture must prepare a lifecycle artifact");
  const request = {
    schemaVersion: 1,
    phase: validated.type,
    identity: structuredClone(validated.identity),
    summary: validated.summary,
    artifact: prepared.data.artifact,
    expectedHash: sha256(prepared.data.artifact),
  };
  const record = createMarkdownLifecycleRecord(request);
  assert.equal(record.valid, true, "test fixture must create a Markdown lifecycle record");
  return {
    lifecycleInput,
    prepared: prepared.data,
    request,
    record: record.data,
  };
};

const createCheckout = async (t, prefix = "ima-markdown-lifecycle-") => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const pathsFor = (root, record) => {
  const directoryName = markdownLifecycleDirectoryName(record.lifecycleKey);
  const artifactName = markdownLifecycleArtifactName(record);
  const receiptName = markdownLifecycleReceiptName(record);
  assert.ok(directoryName);
  assert.ok(artifactName);
  assert.ok(receiptName);
  const scope = join(root, ".ima", "lifecycle", "markdown", "v1", directoryName);
  return {
    scope,
    artifact: join(scope, artifactName),
    receipt: join(scope, receiptName),
    lease: join(scope, ".lifecycle.lock"),
  };
};

const referenceFor = (root, record) => {
  const reference = markdownLifecycleReferenceFor({ checkoutRoot: root, record });
  assert.ok(reference);
  return reference;
};

const assertBlocked = (result, code) => {
  assert.equal(result.status, "blocked");
  assert.equal(result.code, code);
};

const storedCheckout = async (t, options = {}) => {
  const root = await createCheckout(t);
  const fixture = fixtureFor(options);
  const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const stored = await adapter.persist(fixture.request);
  assert.equal(stored.status, "verified");
  assert.equal(stored.disposition, "stored");
  return {
    root,
    fixture,
    adapter,
    stored,
    paths: pathsFor(root, fixture.record),
  };
};

const snapshotTree = async (root) => {
  const entries = [];
  const visit = async (path, name) => {
    const info = await lstat(path);
    const type = info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "symlink"
          : "other";
    const entry = {
      name,
      type,
      mode: info.mode & 0o777,
      size: info.size,
      nlink: info.nlink,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    };
    if (type === "file") {
      entry.contentHash = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    if (type === "symlink") entry.target = await readlink(path);
    entries.push(entry);
    if (type !== "directory") return;

    const names = await readdir(path);
    for (const child of names.sort()) await visit(join(path, child), join(name, child));
  };

  await visit(root, ".");
  return entries;
};

test("derives an opaque stable checkout fingerprint for closed public read proofs", async (t) => {
  const root = await createCheckout(t);
  const first = markdownLifecycleCheckoutFingerprint(root);
  const second = markdownLifecycleCheckoutFingerprint(root);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.equal(first.includes(root), false);
  assert.equal(markdownLifecycleCheckoutFingerprint(`${root}/.`), null);
  assert.equal(markdownLifecycleCheckoutFingerprint("relative-checkout"), null);
});

const writeOverflowEntries = async (directory) => {
  const total = MAX_MARKDOWN_LIFECYCLE_ENUMERATION + 1;
  const batchSize = 100;
  for (let start = 0; start < total; start += batchSize) {
    const count = Math.min(batchSize, total - start);
    await Promise.all(Array.from({ length: count }, (_, index) =>
      writeFile(join(directory, `ordinary-${start + index}`), "x"),
    ));
  }
};

test("persists exact artifact and receipt bytes, then returns direct verified read-back", async (t) => {
  const root = await createCheckout(t);
  const fixture = fixtureFor();
  const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const stored = await adapter.persist(fixture.request);
  const paths = pathsFor(root, fixture.record);

  assert.equal(stored.status, "verified");
  assert.equal(stored.disposition, "stored");
  assert.equal(stored.provider, "markdown");
  assert.equal(stored.storageSchemaVersion, 1);
  assert.equal(stored.sourceId, `markdown:lifecycle:${fixture.record.artifactId}`);
  assert.equal(stored.artifact, fixture.record.artifact);
  assert.equal(stored.contentHash, fixture.record.contentHash);
  assert.equal(stored.receiptHash, fixture.record.receiptHash);
  assert.deepEqual(stored.reference, referenceFor(root, fixture.record));
  assert.equal(await readFile(paths.artifact, "utf8"), fixture.record.artifact);
  assert.equal(await readFile(paths.receipt, "utf8"), fixture.record.serializedReceipt);
  assert.equal((await lstat(paths.artifact)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.receipt)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(paths.scope)).sort(), [
    markdownLifecycleArtifactName(fixture.record),
    markdownLifecycleReceiptName(fixture.record),
  ].sort());

  const readBack = await adapter.get(structuredClone(stored.reference));
  assert.equal(readBack.status, "verified");
  assert.equal(readBack.disposition, "unchanged");
  assert.equal(readBack.artifact, fixture.record.artifact);
  assert.equal(readBack.receiptHash, fixture.record.receiptHash);
});

test("blocks invalid requests before filesystem effects", async (t) => {
  const root = await createCheckout(t);
  const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const fixture = fixtureFor();
  await writeFile(join(root, "ordinary.txt"), "ordinary file remains untouched");
  const before = await snapshotTree(root);

  const wrongHash = structuredClone(fixture.request);
  wrongHash.expectedHash = "0".repeat(64);
  const credentialShaped = structuredClone(fixture.request);
  credentialShaped.summary = "token=[redacted]";

  for (const [value, code] of [
    [null, "markdown_request_invalid"],
    [wrongHash, "markdown_request_invalid"],
    [credentialShaped, "markdown_secret_detected"],
  ]) {
    assertBlocked(await adapter.persist(value), code);
    assert.deepEqual(await snapshotTree(root), before);
  }
});

test("rejects recognized configured checkout roots before filesystem effects without reflection", async (t) => {
  const marker = "token=harmless";
  const root = await createCheckout(t, `ima-markdown-${marker}-`);
  const referenceRoot = await createCheckout(t, "ima-markdown-reference-");
  const fixture = fixtureFor();
  const adapterInput = { checkoutRoot: root };
  const adapter = createMarkdownLifecycleAdapter(adapterInput);
  adapterInput.checkoutRoot = referenceRoot;
  const reference = referenceFor(referenceRoot, fixture.record);
  const before = await snapshotTree(root);

  assert.equal(containsRecognizedMarkdownLifecycleSecret(root), true);

  for (const [operation, result] of [
    ["persist", await adapter.persist(fixture.request)],
    ["retry", await adapter.persist(structuredClone(fixture.request))],
    ["get", await adapter.get(reference)],
    ["recall", await adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 1 })],
  ]) {
    assertBlocked(result, "markdown_secret_detected");
    assert.deepEqual(Object.keys(result).sort(), ["code", "provider", "status"], operation);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(marker), false, operation);
    assert.equal(serialized.includes(root), false, operation);
    assert.deepEqual(await snapshotTree(root), before, operation);
  }
  assert.deepEqual(await readdir(root), []);
});

test("keeps ordinary and Unicode checkout roots available", async (t) => {
  for (const [label, prefix] of [
    ["ordinary", "ima-markdown-ordinary-"],
    ["Unicode", "ima-markdown-Δ-"],
  ]) {
    const root = await createCheckout(t, prefix);
    const fixture = fixtureFor({
      payload: `# ${label} checkout root\n\nThe adapter remains available.`,
    });
    const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
    const stored = await adapter.persist(fixture.request);
    assert.equal(stored.status, "verified", label);
    assert.equal(stored.checkoutRoot, root, label);

    const read = await adapter.get(stored.reference);
    assert.equal(read.status, "verified", label);
    const recalled = await adapter.recall({ lifecycleKey: fixture.record.lifecycleKey, limit: 1 });
    assert.ok(Array.isArray(recalled), label);
    assert.equal(recalled.length, 1, label);
    assert.equal(recalled[0].checkoutRoot, root, label);
  }
});

test("keeps matching retries unchanged and never overwrites summary, content, or identity conflicts", async (t) => {
  const root = await createCheckout(t);
  const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const fixture = fixtureFor();
  const first = await adapter.persist(fixture.request);
  assert.equal(first.status, "verified");
  const paths = pathsFor(root, fixture.record);
  const originalArtifact = await readFile(paths.artifact, "utf8");
  const originalReceipt = await readFile(paths.receipt, "utf8");

  const retry = await adapter.persist(structuredClone(fixture.request));
  assert.equal(retry.status, "verified");
  assert.equal(retry.disposition, "unchanged");
  assert.equal(await readFile(paths.artifact, "utf8"), originalArtifact);
  assert.equal(await readFile(paths.receipt, "utf8"), originalReceipt);

  const changedSummary = {
    ...fixture.request,
    summary: "Changed summaries must not overwrite immutable Markdown evidence.",
  };
  assertBlocked(await adapter.persist(changedSummary), "markdown_target_conflict");
  assert.equal(await readFile(paths.artifact, "utf8"), originalArtifact);
  assert.equal(await readFile(paths.receipt, "utf8"), originalReceipt);

  const changedContent = fixtureFor({
    payload: "# Markdown lifecycle evidence\n\nChanged content receives a distinct immutable artifact.",
  });
  const contentResult = await adapter.persist(changedContent.request);
  assert.equal(contentResult.status, "verified");
  assert.equal(contentResult.disposition, "stored");
  assert.notEqual(contentResult.artifactId, first.artifactId);
  assert.equal(await readFile(paths.artifact, "utf8"), originalArtifact);
  assert.equal(await readFile(paths.receipt, "utf8"), originalReceipt);

  const changedIdentity = fixtureFor({
    identity: identityFor({ project: "ima-pi-other" }),
  });
  const identityResult = await adapter.persist(changedIdentity.request);
  assert.equal(identityResult.status, "verified");
  assert.equal(identityResult.disposition, "stored");
  assert.notEqual(identityResult.artifactId, first.artifactId);
  assert.equal(await readFile(paths.artifact, "utf8"), originalArtifact);
  assert.equal(await readFile(paths.receipt, "utf8"), originalReceipt);

  const replacementArtifact = `${originalArtifact}changed`;
  await writeFile(paths.artifact, replacementArtifact, { mode: 0o600 });
  assertBlocked(await adapter.persist(fixture.request), "markdown_target_unverifiable");
  assert.equal(await readFile(paths.artifact, "utf8"), replacementArtifact);
  assert.equal(await readFile(paths.receipt, "utf8"), originalReceipt);

  await writeFile(paths.artifact, originalArtifact, { mode: 0o600 });
  const changedReceipt = JSON.parse(originalReceipt);
  changedReceipt.identity.project = "different-project";
  const replacementReceipt = `${JSON.stringify(changedReceipt)}\n`;
  await writeFile(paths.receipt, replacementReceipt, { mode: 0o600 });
  assertBlocked(await adapter.persist(fixture.request), "markdown_target_unverifiable");
  assert.equal(await readFile(paths.artifact, "utf8"), originalArtifact);
  assert.equal(await readFile(paths.receipt, "utf8"), replacementReceipt);
});

test("leaves partial and orphan evidence unauthoritative and never deletes or completes it", async (t) => {
  for (const [label, remaining] of [
    ["artifact only", "artifact"],
    ["receipt only", "receipt"],
  ]) {
    const root = await createCheckout(t, "ima-markdown-partial-");
    const fixture = fixtureFor({
      payload: `# Partial evidence\n\n${label} remains untrusted.`,
    });
    const paths = pathsFor(root, fixture.record);
    const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
    await mkdir(paths.scope, { recursive: true, mode: 0o700 });
    const remainingPath = remaining === "artifact" ? paths.artifact : paths.receipt;
    const missingPath = remaining === "artifact" ? paths.receipt : paths.artifact;
    const remainingContent = remaining === "artifact"
      ? fixture.record.artifact
      : fixture.record.serializedReceipt;
    await writeFile(remainingPath, remainingContent, { mode: 0o600 });

    assertBlocked(await adapter.persist(fixture.request), "markdown_partial_evidence");
    assertBlocked(await adapter.get(referenceFor(root, fixture.record)), "markdown_partial_evidence");
    assertBlocked(await adapter.recall({
      lifecycleKey: fixture.record.lifecycleKey,
      limit: 1,
    }), "markdown_recall_unverifiable");
    assert.equal(await readFile(remainingPath, "utf8"), remainingContent, label);
    await assert.rejects(lstat(missingPath), /ENOENT/, label);
  }
});

test("retrieves an exact serialized reference from a fresh adapter and blocks wrong checkout, changed, and missing evidence", async (t) => {
  const stored = await storedCheckout(t);
  const serializedReference = JSON.stringify(stored.stored.reference);
  const fresh = createMarkdownLifecycleAdapter({ checkoutRoot: stored.root });
  const read = await fresh.get(JSON.parse(serializedReference));

  assert.equal(read.status, "verified");
  assert.deepEqual(read, { ...stored.stored, disposition: "unchanged" });
  assert.equal(JSON.stringify(read.reference), serializedReference);
  assertBlocked(await fresh.get({
    ...JSON.parse(serializedReference),
    receiptHash: "f".repeat(64),
  }), "markdown_verification_failed");

  const otherRoot = await createCheckout(t, "ima-markdown-wrong-checkout-");
  const otherBefore = await snapshotTree(otherRoot);
  const wrongCheckout = await createMarkdownLifecycleAdapter({ checkoutRoot: otherRoot })
    .get(JSON.parse(serializedReference));
  assertBlocked(wrongCheckout, "markdown_reference_invalid");
  assert.deepEqual(await snapshotTree(otherRoot), otherBefore);

  const changedEvidence = "replacement evidence remains blocked";
  await writeFile(stored.paths.artifact, changedEvidence, { mode: 0o600 });
  assertBlocked(await fresh.get(JSON.parse(serializedReference)), "markdown_verification_failed");
  assert.equal(await readFile(stored.paths.artifact, "utf8"), changedEvidence);

  await unlink(stored.paths.receipt);
  assertBlocked(await fresh.get(JSON.parse(serializedReference)), "markdown_partial_evidence");
  await assert.rejects(lstat(stored.paths.receipt), /ENOENT/);
});

test("isolates lifecycle keys, filters phases, and applies bounded recall limits", async (t) => {
  const root = await createCheckout(t);
  const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const firstLifecycle = [
    fixtureFor({ phase: "plan", payload: "# Plan\n\nFirst lifecycle plan." }),
    fixtureFor({ phase: "implementation", payload: "# Implementation\n\nFirst lifecycle implementation." }),
    fixtureFor({ phase: "review", payload: "# Review\n\nFirst lifecycle review." }),
  ];
  const secondIdentity = identityFor({
    lifecycleKey: "ima-pi:plane:ima:SKYNET-210",
    planeWorkItem: "SKYNET-210",
    sourceRefs: ["plane:ima:SKYNET-210"],
  });
  const secondLifecycle = fixtureFor({
    identity: secondIdentity,
    phase: "plan",
    payload: "# Plan\n\nSecond lifecycle plan.",
  });

  const firstResults = [];
  for (const fixture of firstLifecycle) {
    const result = await adapter.persist(fixture.request);
    assert.equal(result.status, "verified");
    firstResults.push(result);
  }
  const secondResult = await adapter.persist(secondLifecycle.request);
  assert.equal(secondResult.status, "verified");

  const allFirst = await adapter.recall({
    lifecycleKey: LIFECYCLE_KEY,
    limit: MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT,
  });
  assert.ok(Array.isArray(allFirst));
  assert.equal(allFirst.length, 3);
  assert.equal(allFirst.every((result) => result.lifecycleKey === LIFECYCLE_KEY), true);
  assert.deepEqual(allFirst.map((result) => result.phase).sort(), [
    "implementation",
    "plan",
    "review",
  ]);

  const plans = await adapter.recall({ lifecycleKey: LIFECYCLE_KEY, phase: "plan", limit: 20 });
  assert.ok(Array.isArray(plans));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].phase, "plan");
  assert.equal(plans[0].artifactId, firstResults.find((result) => result.phase === "plan").artifactId);

  const limited = await adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 1 });
  assert.ok(Array.isArray(limited));
  assert.equal(limited.length, 1);

  const secondOnly = await adapter.recall({
    lifecycleKey: secondIdentity.lifecycleKey,
    limit: 20,
  });
  assert.ok(Array.isArray(secondOnly));
  assert.equal(secondOnly.length, 1);
  assert.equal(secondOnly[0].artifactId, secondResult.artifactId);

  const contaminatedReference = {
    ...secondResult.reference,
    lifecycleKey: LIFECYCLE_KEY,
  };
  assertBlocked(await adapter.get(contaminatedReference), "markdown_record_not_found");
  assert.notEqual(
    markdownLifecycleDirectoryName(LIFECYCLE_KEY),
    markdownLifecycleDirectoryName(secondIdentity.lifecycleKey),
  );

  const beforeInvalidSelection = await snapshotTree(root);
  for (const limit of [0, MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT + 1]) {
    assertBlocked(await adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit }), "markdown_selection_invalid");
  }
  assert.deepEqual(await snapshotTree(root), beforeInvalidSelection);
});

test("fails closed when a phase has more than the public twenty-record recall bound", async (t) => {
  const root = await createCheckout(t, "ima-markdown-read-bound-");
  const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  for (let index = 0; index < MAX_MARKDOWN_LIFECYCLE_RECALL_LIMIT + 1; index += 1) {
    const fixture = fixtureFor({
      phase: "plan",
      payload: `# Plan\n\nBounded synthetic lifecycle evidence ${index + 1}.`,
    });
    const stored = await adapter.persist(fixture.request);
    assert.equal(stored.status, "verified", String(index + 1));
  }
  const before = await snapshotTree(root);
  assertBlocked(await adapter.recall({
    lifecycleKey: LIFECYCLE_KEY,
    phase: "plan",
    limit: 1,
  }), "markdown_recall_unverifiable");
  assert.deepEqual(await snapshotTree(root), before);
});

test("preserves ordinary files and leaves read-only get and recall tree snapshots unchanged", async (t) => {
  const root = await createCheckout(t);
  const fixture = fixtureFor();
  const paths = pathsFor(root, fixture.record);
  const rootFile = join(root, "ordinary.txt");
  const scopeFile = join(paths.scope, "notes.txt");
  await mkdir(paths.scope, { recursive: true, mode: 0o700 });
  await writeFile(rootFile, "root ordinary content");
  await writeFile(scopeFile, "scope ordinary content");

  const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const stored = await adapter.persist(fixture.request);
  assert.equal(stored.status, "verified");
  assert.equal(await readFile(rootFile, "utf8"), "root ordinary content");
  assert.equal(await readFile(scopeFile, "utf8"), "scope ordinary content");

  const beforeReadOnly = await snapshotTree(root);
  const fresh = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const get = await fresh.get(JSON.parse(JSON.stringify(stored.reference)));
  const recall = await fresh.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 20 });
  assert.equal(get.status, "verified");
  assert.ok(Array.isArray(recall));
  assert.equal(recall.length, 1);
  assert.deepEqual(await snapshotTree(root), beforeReadOnly);
  assert.equal(await readFile(rootFile, "utf8"), "root ordinary content");
  assert.equal(await readFile(scopeFile, "utf8"), "scope ordinary content");
});

test("contains traversal-shaped values under the checkout and rejects lexical checkout traversal", async (t) => {
  const root = await createCheckout(t);
  const outside = await createCheckout(t, "ima-markdown-outside-");
  const fixture = fixtureFor();
  const rootBefore = await snapshotTree(root);
  const lexicalCheckout = `${root}/nested/..`;
  const rejected = await createMarkdownLifecycleAdapter({ checkoutRoot: lexicalCheckout })
    .persist(fixture.request);
  assertBlocked(rejected, "markdown_checkout_invalid");
  assert.deepEqual(await snapshotTree(root), rootBefore);

  const outsideFile = join(outside, "sentinel.txt");
  await writeFile(outsideFile, "outside remains untouched");
  const traversalIdentity = identityFor({
    lifecycleKey: "../outside",
    sourceRefs: ["local:../outside"],
  });
  delete traversalIdentity.planeWorkspace;
  delete traversalIdentity.planeWorkItem;
  const traversal = fixtureFor({
    identity: traversalIdentity,
    payload: "# Traversal-shaped lifecycle key\n\nIt must be stored under a digest.",
  });
  const safeAdapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const stored = await safeAdapter.persist(traversal.request);
  assert.equal(stored.status, "verified");
  assert.equal(stored.lifecycleKey, "../outside");
  assert.equal(await readFile(outsideFile, "utf8"), "outside remains untouched");
  assert.equal((await lstat(pathsFor(root, traversal.record).scope)).isDirectory(), true);

  const lexicalReference = {
    ...stored.reference,
    checkoutRoot: lexicalCheckout,
  };
  assertBlocked(await safeAdapter.get(lexicalReference), "markdown_reference_invalid");
  assert.equal(await readFile(outsideFile, "utf8"), "outside remains untouched");
});

test("rejects checkout and lifecycle-directory symlinks without touching their targets", async (t) => {
  const root = await createCheckout(t);
  const internalRoot = await createCheckout(t, "ima-markdown-internal-link-");
  const outside = await createCheckout(t, "ima-markdown-link-target-");
  const fixture = fixtureFor();
  const sentinel = join(outside, "sentinel.txt");
  await writeFile(sentinel, "symlink target remains untouched");

  const checkoutLink = join(root, "checkout-link");
  await symlink(outside, checkoutLink, "dir");
  assertBlocked(await createMarkdownLifecycleAdapter({ checkoutRoot: checkoutLink })
    .persist(fixture.request), "markdown_checkout_invalid");
  assert.equal(await readFile(sentinel, "utf8"), "symlink target remains untouched");

  await symlink(outside, join(internalRoot, ".ima"), "dir");
  assertBlocked(await createMarkdownLifecycleAdapter({ checkoutRoot: internalRoot })
    .persist(fixture.request), "markdown_path_invalid");
  assert.equal(await readFile(sentinel, "utf8"), "symlink target remains untouched");
});

test("blocks symlinked, hard-linked, deleted, replaced, and grown evidence without repair", async (t) => {
  const symlinked = await storedCheckout(t, {
    payload: "# Symlink evidence\n\nSymlinked evidence must be rejected.",
  });
  const outside = await createCheckout(t, "ima-markdown-evidence-target-");
  const outsideEvidence = join(outside, "evidence.txt");
  await writeFile(outsideEvidence, "outside evidence remains untouched");
  await unlink(symlinked.paths.artifact);
  await symlink(outsideEvidence, symlinked.paths.artifact, "file");
  assertBlocked(await symlinked.adapter.get(symlinked.stored.reference), "markdown_verification_failed");
  assert.equal(await readFile(outsideEvidence, "utf8"), "outside evidence remains untouched");

  const hardLinked = await storedCheckout(t, {
    payload: "# Hard link evidence\n\nHard-linked evidence must be rejected.",
  });
  const hardLink = join(hardLinked.root, "hard-link-copy");
  await link(hardLinked.paths.artifact, hardLink);
  assert.equal((await lstat(hardLinked.paths.artifact)).nlink, 2);
  assertBlocked(await hardLinked.adapter.get(hardLinked.stored.reference), "markdown_verification_failed");
  assert.equal(await readFile(hardLink, "utf8"), hardLinked.fixture.record.artifact);

  const deleted = await storedCheckout(t, {
    payload: "# Deleted evidence\n\nMissing receipt must remain partial.",
  });
  await unlink(deleted.paths.receipt);
  assertBlocked(await deleted.adapter.get(deleted.stored.reference), "markdown_partial_evidence");
  assertBlocked(await deleted.adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 1 }), "markdown_recall_unverifiable");
  assertBlocked(await deleted.adapter.persist(deleted.fixture.request), "markdown_partial_evidence");
  await assert.rejects(lstat(deleted.paths.receipt), /ENOENT/);

  const replaced = await storedCheckout(t, {
    payload: "# Replaced evidence\n\nReplacement must be rejected.",
  });
  const replacement = "replacement evidence remains untrusted";
  await writeFile(replaced.paths.artifact, replacement, { mode: 0o600 });
  assertBlocked(await replaced.adapter.get(replaced.stored.reference), "markdown_verification_failed");
  assert.equal(await readFile(replaced.paths.artifact, "utf8"), replacement);

  const grown = await storedCheckout(t, {
    payload: "# Growing evidence\n\nA deterministic pre-read growth must be rejected.",
  });
  await appendFile(grown.paths.artifact, "\nadditional unverified bytes");
  assertBlocked(await grown.adapter.get(grown.stored.reference), "markdown_verification_failed");
  assert.match(await readFile(grown.paths.artifact, "utf8"), /additional unverified bytes$/);
});

test("blocks malformed, duplicate-ID, missing, and overflowing recall evidence without deletion", async (t) => {
  const malformed = await storedCheckout(t, {
    payload: "# Malformed evidence\n\nMalformed names block recall.",
  });
  const malformedName = join(malformed.paths.scope, "plan-not-a-uuid.md");
  await writeFile(malformedName, "malformed lifecycle-looking evidence");
  const malformedBefore = await snapshotTree(malformed.root);
  assertBlocked(await malformed.adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 1 }), "markdown_recall_unverifiable");
  assert.deepEqual(await snapshotTree(malformed.root), malformedBefore);

  const duplicate = await storedCheckout(t, {
    payload: "# Duplicate evidence\n\nDuplicate lifecycle IDs block recall.",
  });
  const duplicateArtifactName = markdownLifecycleArtifactName({
    phase: "implementation",
    artifactId: duplicate.fixture.record.artifactId,
  });
  const duplicateReceiptName = markdownLifecycleReceiptName({
    phase: "implementation",
    artifactId: duplicate.fixture.record.artifactId,
  });
  assert.ok(duplicateArtifactName);
  assert.ok(duplicateReceiptName);
  await writeFile(
    join(duplicate.paths.scope, duplicateArtifactName),
    duplicate.fixture.record.artifact,
    { mode: 0o600 },
  );
  await writeFile(
    join(duplicate.paths.scope, duplicateReceiptName),
    duplicate.fixture.record.serializedReceipt,
    { mode: 0o600 },
  );
  const duplicateBefore = await snapshotTree(duplicate.root);
  assertBlocked(await duplicate.adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 20 }), "markdown_recall_unverifiable");
  assert.deepEqual(await snapshotTree(duplicate.root), duplicateBefore);

  const missing = await storedCheckout(t, {
    payload: "# Missing evidence\n\nA missing pair blocks recall.",
  });
  await unlink(missing.paths.receipt);
  assertBlocked(await missing.adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 1 }), "markdown_recall_unverifiable");
  await assert.rejects(lstat(missing.paths.receipt), /ENOENT/);

  const overflow = await storedCheckout(t, {
    payload: "# Overflow evidence\n\nToo many entries block recall.",
  });
  await writeOverflowEntries(overflow.paths.scope);
  assertBlocked(await overflow.adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 1 }), "markdown_recall_unverifiable");
  assert.equal((await readdir(overflow.paths.scope)).length > MAX_MARKDOWN_LIFECYCLE_ENUMERATION, true);
});

test("prevents independent adapters from stealing an active lease and serializes contention", async (t) => {
  const root = await createCheckout(t);
  const fixture = fixtureFor();
  const paths = pathsFor(root, fixture.record);
  await mkdir(paths.scope, { recursive: true, mode: 0o700 });
  const activeLease = "active test lease\n";
  await writeFile(paths.lease, activeLease, { mode: 0o600 });
  const firstAdapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const secondAdapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });

  const blockedResults = await Promise.all([
    firstAdapter.persist(fixture.request),
    secondAdapter.persist(structuredClone(fixture.request)),
  ]);
  for (const result of blockedResults) assertBlocked(result, "markdown_lease_active");
  assert.equal(await readFile(paths.lease, "utf8"), activeLease);
  await assert.rejects(lstat(paths.artifact), /ENOENT/);
  await assert.rejects(lstat(paths.receipt), /ENOENT/);

  await unlink(paths.lease);
  const contested = await Promise.all([
    firstAdapter.persist(fixture.request),
    secondAdapter.persist(structuredClone(fixture.request)),
  ]);
  assert.equal(contested.filter((result) =>
    result.status === "verified" && result.disposition === "stored").length, 1);
  for (const result of contested) {
    if (result.status === "verified") {
      assert.equal(["stored", "unchanged"].includes(result.disposition), true);
    } else {
      assert.equal(
        ["markdown_lease_active", "markdown_path_invalid"].includes(result.code),
        true,
      );
    }
  }
  assert.equal(await readFile(paths.artifact, "utf8"), fixture.record.artifact);
  assert.equal(await readFile(paths.receipt, "utf8"), fixture.record.serializedReceipt);
  await assert.rejects(lstat(paths.lease), /ENOENT/);
});

test("honors cancellation and returns bounded non-reflecting filesystem failures", async (t) => {
  const root = await createCheckout(t);
  const fixture = fixtureFor();
  const adapter = createMarkdownLifecycleAdapter({ checkoutRoot: root });
  const before = await snapshotTree(root);

  const preAborted = new AbortController();
  preAborted.abort();
  const beforePersist = await adapter.persist(fixture.request, preAborted.signal);
  assertBlocked(beforePersist, "aborted");
  assert.equal(Object.hasOwn(beforePersist, "reference"), false);
  assert.deepEqual(await snapshotTree(root), before);

  const during = new AbortController();
  const pending = adapter.persist(fixture.request, during.signal);
  during.abort();
  const duringPersist = await pending;
  assertBlocked(duringPersist, "aborted");
  assert.ok(duringPersist.reference);
  assert.deepEqual(await snapshotTree(root), before);

  const stored = await adapter.persist(fixture.request);
  assert.equal(stored.status, "verified");
  const beforeReadOnlyCancellation = await snapshotTree(root);
  const readAbort = new AbortController();
  readAbort.abort();
  assertBlocked(await adapter.get(stored.reference, readAbort.signal), "aborted");
  const recallAbort = new AbortController();
  recallAbort.abort();
  assertBlocked(await adapter.recall({ lifecycleKey: LIFECYCLE_KEY, limit: 1 }, recallAbort.signal), "aborted");
  assert.deepEqual(await snapshotTree(root), beforeReadOnlyCancellation);

  const invalidRoot = await createCheckout(t, "ima-markdown-bounded-error-");
  const boundaryMarker = "untrusted-boundary-marker";
  await writeFile(join(invalidRoot, ".ima"), boundaryMarker);
  const bounded = await createMarkdownLifecycleAdapter({ checkoutRoot: invalidRoot })
    .persist(fixture.request);
  assertBlocked(bounded, "markdown_path_invalid");
  assert.deepEqual(Object.keys(bounded).sort(), ["code", "provider", "reference", "status"]);
  assert.doesNotMatch(JSON.stringify(bounded), /untrusted-boundary-marker/);
  assert.equal(await readFile(join(invalidRoot, ".ima"), "utf8"), boundaryMarker);
});
