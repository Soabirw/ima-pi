import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveRecordId } from "../lib/qdrant-corpus.ts";
import {
  createLifecycleProviderPin,
  createLifecycleProviderPinAttempt,
} from "../lib/ima-lifecycle-pin.ts";
import {
  beginLifecyclePinWith,
  confirmLifecyclePinWith,
  loadLifecyclePinStateWith,
  markLifecyclePinAttemptWritingWith,
} from "../lib/ima-lifecycle-pin-store.ts";

const lifecycleKey = "shared-dev-memory:manual:human-ai-memory-system:2026-08-31";
const startedAt = "2026-08-31T12:00:00.000Z";
const attemptId = "68475dab-a6c7-5c10-8744-bbd2edf5c48b";
const hash = "a".repeat(64);

const qdrantReference = (key = lifecycleKey, phase = "plan") => {
  const recordKey = `${key}:${phase}:e9f5eb6a41c5`;
  const id = deriveRecordId(recordKey);
  assert.equal(id.success, true);
  if (!id.success) throw new Error("fixture record ID was not derived");
  return {
    schemaVersion: 1,
    provider: "qdrant",
    artifactId: id.data,
    recordKey,
    contentHash: hash,
    lifecycleKey: key,
    phase,
    nonce: "2712a503-8994-5025-ae27-2f5caac146a2",
  };
};

const attemptFor = (key = lifecycleKey, provider = "qdrant") => {
  const attempt = createLifecycleProviderPinAttempt({
    lifecycleKey: key,
    provider,
    attemptId,
    startedAt,
  });
  assert.ok(attempt);
  return attempt;
};

const pinFor = (key = lifecycleKey) => {
  const reference = qdrantReference(key);
  const pin = createLifecycleProviderPin({
    lifecycleKey: key,
    provider: "qdrant",
    initialReference: reference,
    artifactId: reference.artifactId,
    recordKey: reference.recordKey,
    pinnedAt: startedAt,
  });
  assert.ok(pin);
  return pin;
};

const temporaryRoot = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-lifecycle-pin-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
};

test("persists checkout-local authority only after a writing attempt and ignores active cycle state", async (t) => {
  const root = await temporaryRoot(t);
  const resolveRoot = async (cwd) => cwd === root ? root : "";
  const attempt = attemptFor();
  const begin = await beginLifecyclePinWith(resolveRoot)(root, attempt);
  assert.deepEqual(begin, { status: "started", attempt });

  const premature = await confirmLifecyclePinWith(resolveRoot)(root, attempt, pinFor());
  assert.deepEqual(premature, {
    status: "blocked",
    code: "lifecycle_pin_confirmation_invalid",
  });

  const writing = await markLifecyclePinAttemptWritingWith(resolveRoot)(root, attempt);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;

  const confirmed = await confirmLifecyclePinWith(resolveRoot)(root, writing.attempt, pinFor());
  assert.equal(confirmed.status, "pinned");
  await writeFile(
    join(root, ".ima-cycle", "active.json"),
    JSON.stringify({ lifecycleProvider: "markdown", lifecycleProviderAttemptId: "not-authoritative" }),
    "utf8",
  );

  const freshLoad = await loadLifecyclePinStateWith(resolveRoot)(root, lifecycleKey);
  assert.equal(freshLoad.status, "pinned");
  if (freshLoad.status !== "pinned") return;
  assert.equal(freshLoad.pin.provider, "qdrant");
  assert.equal(freshLoad.pin.recordKey, pinFor().recordKey);
  assert.equal(await readFile(join(root, ".ima-cycle", ".gitignore"), "utf8"), "*\n");
});

test("keeps an uncertain writing attempt authoritative instead of replacing it", async (t) => {
  const root = await temporaryRoot(t);
  const resolveRoot = async () => root;
  const first = attemptFor();
  assert.equal((await beginLifecyclePinWith(resolveRoot)(root, first)).status, "started");
  assert.equal((await markLifecyclePinAttemptWritingWith(resolveRoot)(root, first)).status, "writing");

  const retry = createLifecycleProviderPinAttempt({
    lifecycleKey,
    provider: "markdown",
    attemptId: "2712a503-8994-5025-ae27-2f5caac146a2",
    startedAt: "2026-08-31T12:01:00.000Z",
  });
  assert.ok(retry);
  const second = await beginLifecyclePinWith(resolveRoot)(root, retry);
  assert.equal(second.status, "pending");
  if (second.status !== "pending") return;
  assert.equal(second.attempt.attemptId, first.attemptId);
  assert.equal(second.attempt.status, "writing");
});

test("fails closed for corrupt, conflicting, and path-escape-shaped pin inputs", async (t) => {
  const root = await temporaryRoot(t);
  const resolveRoot = async () => root;
  const directory = join(root, ".ima-cycle");
  const registry = join(directory, "provider-pins.json");
  await mkdir(directory, { recursive: true });

  await writeFile(registry, "{", "utf8");
  assert.deepEqual(await loadLifecyclePinStateWith(resolveRoot)(root, lifecycleKey), { status: "corrupt" });

  await writeFile(registry, JSON.stringify({
    schemaVersion: 1,
    entries: [
      { status: "pinned", pin: pinFor() },
      { status: "pending", attempt: attemptFor() },
    ],
  }), "utf8");
  assert.deepEqual(await loadLifecyclePinStateWith(resolveRoot)(root, lifecycleKey), { status: "conflicting" });

  assert.equal(createLifecycleProviderPin({
    lifecycleKey: `${lifecycleKey}; token=synthetic-secret`,
    provider: "qdrant",
    initialReference: qdrantReference(),
    artifactId: qdrantReference().artifactId,
    recordKey: qdrantReference().recordKey,
    pinnedAt: startedAt,
  }), null);
  assert.deepEqual(
    await beginLifecyclePinWith(async () => "../outside")(root, attemptFor()),
    { status: "blocked", code: "lifecycle_pin_store_inaccessible" },
  );
});
