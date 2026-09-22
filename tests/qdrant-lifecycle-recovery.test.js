import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import {
  VECTOR_NAME,
  VECTOR_SIZE,
  corpusFailure,
  normalizeInstitutionalManifest,
  normalizeInstitutionalRecord,
} from "../lib/qdrant-corpus.ts";
import { createVerifiedInstitutionalSnapshot } from "../lib/qdrant-http-boundary.ts";
import { createQdrantCorpusClient } from "../lib/qdrant-http.ts";
import {
  executeQdrantLifecycleReset,
  prepareQdrantLifecycleReset,
  reconcileQdrantLifecycleReset,
} from "../lib/qdrant-lifecycle-recovery.ts";
import {
  MAX_QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_BYTES,
  MAX_QDRANT_LIFECYCLE_RECOVERY_REPORT_BYTES,
} from "../lib/qdrant-lifecycle-recovery-report.ts";

const lifecycleKey = "ima-pi:plane:ima:SKYNET-248";
const createdAt = "2026-09-20T12:00:00.000Z";
const pinAttemptId = "68475dab-a6c7-5c10-8744-bbd2edf5c48b";
const pinNonce = "2712a503-8994-5025-ae27-2f5caac146a2";
const snapshotName = "lifecycle-reset-2026-09-20.snapshot";
const environment = {
  IMA_QDRANT_URL: "http://qdrant.test",
  IMA_OLLAMA_URL: "http://ollama.test",
};

const success = (data) => ({ success: true, data });
const failure = (code) => corpusFailure(code);
const clone = (value) => structuredClone(value);
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const collection = () => ({
  result: {
    config: {
      params: {
        vectors: {
          [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" },
        },
      },
    },
    payload_schema: Object.fromEntries(
      ["lifecycle_key", "phase", "project", "site", "repo", "record_kind", "parent_record_key"]
        .map((field) => [field, { data_type: "keyword" }]),
    ),
  },
});

const recordKeyFor = ({ lifecycleKey: key, phase, suffix }) => {
  if (key === lifecycleKey && phase === "plan") {
    return "ima-pi:plane:ima:SKYNET-248:plan:3a2e2686967d";
  }
  if (key === lifecycleKey && phase === "implementation") {
    return "ima-pi:plane:ima:SKYNET-248:implementation:518c47a1b1aa";
  }
  return `${key}:${phase}:${suffix}`;
};

const storedRecord = ({
  schemaVersion,
  phase,
  lifecycleKey: key = lifecycleKey,
  suffix = "evidence",
  detail,
  recordKey = recordKeyFor({ lifecycleKey: key, phase, suffix }),
}) => {
  const input = {
    recordKey,
    project: "ima-pi",
    site: "",
    repo: "ima-pi",
    lifecycleKey: key,
    phase,
    summary: `${phase} evidence for ${key}.`,
    detail: detail ?? (schemaVersion === 1
      ? "# Lifecycle evidence\n\nImmutable schema-v1 evidence."
      : `# Lifecycle evidence\n\n${"chunked schema-v2 evidence.\n".repeat(1_600)}`),
    sourceRefs: [`plane:ima:${key.split(":").at(-1)}`],
  };
  const normalized = schemaVersion === 1
    ? normalizeInstitutionalRecord(input, createdAt)
    : normalizeInstitutionalManifest(input, createdAt);
  assert.equal(normalized.success, true, `${phase} fixture must normalize`);
  if (!normalized.success) throw new Error("fixture normalization failed");

  const points = schemaVersion === 1
    ? [{ id: normalized.data.id, payload: normalized.data.payload }]
    : [
      { id: normalized.data.id, payload: normalized.data.payload },
      ...normalized.data.chunks.map((chunk) => ({ id: chunk.id, payload: chunk.payload })),
    ];
  return {
    storageSchemaVersion: schemaVersion,
    recordKey: normalized.data.recordKey,
    contentHash: normalized.data.payload.content_hash,
    points,
    reference: {
      schemaVersion: 1,
      provider: "qdrant",
      artifactId: normalized.data.id,
      recordKey: normalized.data.recordKey,
      contentHash: normalized.data.payload.content_hash,
      lifecycleKey: key,
      phase,
      nonce: pinNonce,
    },
  };
};

const inventoryFor = (records, key = lifecycleKey) => ({
  schemaVersion: 1,
  lifecycleKey: key,
  records: [...records]
    .sort((left, right) => left.recordKey.localeCompare(right.recordKey))
    .map((record) => ({
      storageSchemaVersion: record.storageSchemaVersion,
      recordKey: record.recordKey,
      contentHash: record.contentHash,
      points: clone(record.points),
    })),
});

const targetRecords = (v1Detail) => {
  const v1 = storedRecord({
    schemaVersion: 1,
    phase: "plan",
    detail: v1Detail,
  });
  const v2 = storedRecord({ schemaVersion: 2, phase: "implementation" });
  return { v1, v2, inventory: inventoryFor([v1, v2]) };
};

const pointIds = (inventory) => inventory.records.flatMap((record) =>
  record.points.map((point) => point.id),
);

const pinFor = (record, pinnedAt = createdAt) => {
  const pin = createLifecycleProviderPin({
    lifecycleKey,
    provider: "qdrant",
    initialReference: record.reference,
    artifactId: record.reference.artifactId,
    recordKey: record.reference.recordKey,
    pinnedAt,
  });
  assert.ok(pin, "fixture pin must be valid");
  return pin;
};

const attemptFor = (attemptId = pinAttemptId) => {
  const attempt = createLifecycleProviderPinAttempt({
    lifecycleKey,
    provider: "qdrant",
    attemptId,
    startedAt: createdAt,
  });
  assert.ok(attempt, "fixture pin attempt must be valid");
  return attempt;
};

const temporaryRoot = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ima-qdrant-lifecycle-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
};

const setupPinnedProject = async (t, record) => {
  const root = await temporaryRoot(t);
  const resolveProjectRoot = async () => root;
  const pin = pinFor(record);
  const attempt = attemptFor();
  const started = await beginLifecyclePinWith(resolveProjectRoot)(root, attempt);
  assert.deepEqual(started, { status: "started", attempt });
  const writing = await markLifecyclePinAttemptWritingWith(resolveProjectRoot)(root, attempt);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") throw new Error("fixture pin attempt did not enter writing state");
  const confirmed = await confirmLifecyclePinWith(resolveProjectRoot)(root, writing.attempt, pin);
  assert.deepEqual(confirmed, { status: "pinned", pin });
  return { root, resolveProjectRoot, pin };
};

const replacePinnedState = async (root, pin) => writeFile(
  join(root, ".ima-cycle", "provider-pins.json"),
  `${JSON.stringify({ schemaVersion: 1, entries: [{ status: "pinned", pin }] })}\n`,
  "utf8",
);

const resetDependencies = ({ client, resolveProjectRoot, createSnapshot, confirmReset }) => ({
  client,
  resolveProjectRoot,
  createSnapshot: createSnapshot ?? (async () => success({ name: snapshotName })),
  now: () => new Date(createdAt),
  ...(confirmReset ? { confirmReset } : {}),
});

const trustedResetConfirmations = ({ report, reportHash, stages }) => {
  let index = 0;
  const destructiveScope = {
    kind: "report_listed_qdrant_lifecycle_inventory",
    lifecycleKey: report.lifecycleKey,
    inventoryFingerprint: report.inventory.fingerprint,
    recordCount: report.inventory.recordCount,
    pointCount: report.inventory.pointCount,
  };
  return {
    confirmReset: async (confirmation) => {
      const expected = stages[index];
      assert.ok(expected, "recovery must not request an unbound confirmation");
      assert.deepEqual(confirmation, {
        operation: expected.operation,
        stage: expected.stage,
        lifecycleKey: report.lifecycleKey,
        reportHash,
        recordCount: report.inventory.recordCount,
        pointCount: report.inventory.pointCount,
        destructiveScope,
        ...(expected.stage === "deletion" ? {
          snapshotReceipt: { name: expected.snapshotName ?? snapshotName },
        } : {}),
      });
      index += 1;
      return confirmation;
    },
    assertComplete: () => assert.equal(index, stages.length, "every expected confirmation was requested exactly once"),
  };
};

const createRecoveryHttp = ({
  points,
  directMissing = new Set(),
  directOverrides = new Map(),
  discoveredChildren = new Map(),
  deleteResponse = { status: "ok", result: { status: "completed", operation_id: 1 } },
  mutateDeletes = true,
}) => {
  const stored = new Map(points.map((point) => [point.id, clone(point)]));
  const calls = { requests: [], scroll: [], direct: [], deletion: [] };

  const page = (items, offset) => {
    const start = offset === undefined
      ? 0
      : items.findIndex((item) => item.id === offset) + 1;
    if (offset !== undefined && start === 0) throw new Error("unexpected recovery scroll offset");
    const values = items.slice(start, start + 1);
    return {
      result: {
        points: clone(values),
        next_page_offset: start + values.length < items.length ? values.at(-1).id : null,
      },
    };
  };

  const scrollPoints = (body) => {
    const clauses = body?.filter?.must;
    assert.equal(Array.isArray(clauses), true, "recovery scroll requires an exact must filter");
    assert.equal(clauses.length, 1, "recovery scroll must not broaden its filter");
    const clause = clauses[0];
    assert.equal(body.limit, 1, "recovery scroll must exhaust one verified point at a time");
    assert.equal(body.with_payload, true);
    assert.equal(body.with_vector, false);
    const values = clause?.key === "lifecycle_key"
      ? [...stored.values()].filter((point) =>
        point.payload.lifecycle_key === clause.match?.value,
      )
      : clause?.key === "parent_record_key"
        ? clone(discoveredChildren.get(clause.match?.value)
          ?? [...stored.values()].filter((point) =>
            point.payload.parent_record_key === clause.match?.value,
          ))
        : null;
    if (!values) throw new Error("recovery scroll used an unsupported filter");
    return page(values.sort((left, right) => left.id.localeCompare(right.id)), body.offset);
  };

  const fetch = async (input, init = {}) => {
    const request = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.requests.push({ request, method, body: clone(body) });
    assert.equal(request.hostname, "qdrant.test", "no BookStack or fallback endpoint is admitted");

    if (
      request.pathname === "/collections/ima-institutional-memory"
      && method === "GET"
    ) return json(collection());

    if (
      request.pathname === "/collections/ima-institutional-memory/points/scroll"
      && method === "POST"
    ) {
      calls.scroll.push(clone(body));
      return json(scrollPoints(body));
    }

    if (
      request.pathname === "/collections/ima-institutional-memory/points"
      && method === "POST"
    ) {
      assert.equal(Array.isArray(body.ids), true);
      assert.equal(body.ids.length, 1, "direct absence and chunk checks must read one ID at a time");
      assert.equal(body.with_payload, true);
      assert.equal(body.with_vector, false);
      const id = body.ids[0];
      calls.direct.push([...body.ids]);
      const value = directMissing.has(id)
        ? null
        : directOverrides.has(id)
          ? directOverrides.get(id)
          : stored.get(id);
      return json({ result: value ? [clone(value)] : [] });
    }

    if (
      request.pathname === "/collections/ima-institutional-memory/points/delete"
      && method === "POST"
    ) {
      assert.equal(request.search, "?wait=true");
      assert.equal(Object.hasOwn(body, "filter"), false, "recovery deletion must not use a broad filter");
      assert.equal(Array.isArray(body.points), true);
      calls.deletion.push({ body: clone(body), request });
      if (mutateDeletes) body.points.forEach((id) => stored.delete(id));
      return json(deleteResponse);
    }

    throw new Error(`unexpected ${method} ${request}`);
  };

  return {
    client: createQdrantCorpusClient({ env: environment, fetch }),
    calls,
    points: stored,
  };
};

test("recovery inventory requires complete schema-v1 and schema-v2 evidence from derived and discovered chunks", async () => {
  const { v1, v2, inventory } = targetRecords();
  const corpus = createRecoveryHttp({ points: inventory.records.flatMap((record) => record.points) });

  const result = await corpus.client.inventoryLifecycleRecovery(lifecycleKey);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data, inventory);
  assert.deepEqual(
    corpus.calls.direct,
    v2.points.slice(1).map((point) => [point.id]),
    "schema-v2 chunks are read by their deterministic IDs",
  );

  const rootScrolls = corpus.calls.scroll.filter((body) =>
    body.filter.must[0].key === "lifecycle_key",
  );
  const childScrolls = corpus.calls.scroll.filter((body) =>
    body.filter.must[0].key === "parent_record_key",
  );
  assert.equal(rootScrolls.length, 2, "both root records require exhaustive exact-key reads");
  assert.equal(childScrolls.length, v2.points.length - 1, "every discovered schema-v2 child is paged");
  assert.equal(
    rootScrolls.every((body) => body.filter.must[0].match.value === lifecycleKey),
    true,
  );
  assert.equal(
    childScrolls.every((body) => body.filter.must[0].match.value === v2.recordKey),
    true,
  );
  assert.equal(
    corpus.calls.requests.every(({ request }) => request.hostname === "qdrant.test"),
    true,
    "the injected boundary admits no BookStack or provider-fallback request",
  );
});

test("recovery inventory fails closed for missing, malformed, and extra schema-v2 chunks", async () => {
  const { v2, inventory } = targetRecords();
  const targetPoints = inventory.records.flatMap((record) => record.points);
  const malformed = clone(v2.points[1]);
  malformed.payload.detail_chunk = `${malformed.payload.detail_chunk}tampered`;
  const extra = {
    id: "f0000000-0000-4000-8000-000000000001",
    payload: { parent_record_key: v2.recordKey },
  };
  const cases = [
    ["missing derived chunk", { directMissing: new Set([v2.points[1].id]) }],
    ["malformed direct chunk", { directOverrides: new Map([[v2.points[1].id, malformed]]) }],
    ["extra discovered chunk", {
      discoveredChildren: new Map([[v2.recordKey, [...v2.points.slice(1), extra]]]),
    }],
  ];

  for (const [label, options] of cases) {
    const corpus = createRecoveryHttp({ points: targetPoints, ...options });
    assert.deepEqual(
      await corpus.client.inventoryLifecycleRecovery(lifecycleKey),
      failure("record_incomplete"),
      label,
    );
  }
});

test("HTTP recovery deletes only report-listed UUIDs and proves direct plus exhaustive absence", async () => {
  const { v2, inventory } = targetRecords();
  const unrelated = storedRecord({
    schemaVersion: 1,
    lifecycleKey: "ima-pi:plane:ima:SKYNET-249",
    phase: "decision",
    suffix: "retained",
  });
  const corpus = createRecoveryHttp({
    points: [...inventory.records.flatMap((record) => record.points), ...unrelated.points],
  });
  const ids = pointIds(inventory);

  const current = await corpus.client.inventoryLifecycleRecovery(lifecycleKey);
  assert.equal(current.success, true);
  if (!current.success) return;
  assert.deepEqual(current.data, inventory);

  const beforeProofDirect = corpus.calls.direct.length;
  assert.deepEqual(
    await corpus.client.proveLifecycleRecoveryAbsence({ lifecycleKey, inventory }),
    failure("record_conflict"),
    "any still-present listed point blocks absence proof",
  );
  assert.deepEqual(corpus.calls.direct.slice(beforeProofDirect), [[ids[0]]]);

  const deleted = await corpus.client.deleteLifecycleRecoveryInventory({ lifecycleKey, inventory });
  assert.deepEqual(deleted, success(undefined));
  assert.equal(corpus.calls.deletion.length, 1, "deletion has no retry or fallback");
  assert.deepEqual(corpus.calls.deletion[0].body, { points: ids });
  assert.equal(corpus.points.has(unrelated.points[0].id), true, "an unrelated lifecycle point is retained");
  assert.equal(ids.every((id) => !corpus.points.has(id)), true, "only listed target IDs are removed");

  const proofDirect = corpus.calls.direct.length;
  const proofScroll = corpus.calls.scroll.length;
  assert.deepEqual(
    await corpus.client.proveLifecycleRecoveryAbsence({ lifecycleKey, inventory }),
    success(undefined),
  );
  assert.deepEqual(corpus.calls.direct.slice(proofDirect), ids.map((id) => [id]));
  const absenceScrolls = corpus.calls.scroll.slice(proofScroll);
  assert.equal(
    absenceScrolls.some((body) =>
      body.filter.must[0].key === "lifecycle_key"
      && body.filter.must[0].match.value === lifecycleKey,
    ),
    true,
    "proof freshly exhausts the exact lifecycle key",
  );
  assert.equal(
    absenceScrolls.filter((body) => body.filter.must[0].key === "parent_record_key")
      .every((body) => body.filter.must[0].match.value === v2.recordKey),
    true,
    "proof freshly exhausts every schema-v2 parent",
  );
  assert.equal(
    corpus.calls.requests.every(({ request }) => request.hostname === "qdrant.test"),
    true,
  );
});

test("HTTP recovery rejects partial or unknown deletion acknowledgement without retry", async () => {
  const { inventory } = targetRecords();
  const cases = [
    { status: "ok", result: { status: "acknowledged", operation_id: 1 } },
    { status: "ok", result: { status: "completed" } },
  ];

  for (const acknowledgement of cases) {
    const corpus = createRecoveryHttp({
      points: inventory.records.flatMap((record) => record.points),
      deleteResponse: acknowledgement,
      mutateDeletes: false,
    });
    assert.deepEqual(
      await corpus.client.deleteLifecycleRecoveryInventory({ lifecycleKey, inventory }),
      failure("store_unverified"),
    );
    assert.equal(corpus.calls.deletion.length, 1);
    assert.deepEqual(corpus.calls.deletion[0].body, { points: pointIds(inventory) });
  }
});

test("verified snapshots reject missing or ambiguous snapshot-list evidence without retry", async () => {
  for (const listed of [[], [{ name: snapshotName }, { name: snapshotName }]]) {
    const calls = [];
    const result = await createVerifiedInstitutionalSnapshot({
      env: environment,
      fetch: async (input, init = {}) => {
        const request = new URL(String(input));
        calls.push({ request, method: init.method ?? "GET" });
        assert.equal(request.hostname, "qdrant.test");
        if (init.method === "POST") return json({ result: { name: snapshotName } });
        return json({ result: listed });
      },
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "response_invalid");
    assert.equal(calls.length, 2, "snapshot creation/listing is a single non-retryable attempt");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[1].method, "GET");
    assert.doesNotMatch(JSON.stringify(result), /qdrant\.test|snapshot/);
  }
});

test("prepare creates private report-bound recovery evidence without exposing payload bodies", async (t) => {
  const secret = "token=archive-body-secret";
  const { v1, inventory } = targetRecords(`# Private archive payload\n\n${secret}`);
  const project = await setupPinnedProject(t, v1);
  const calls = { inventory: 0 };
  const client = {
    inventoryLifecycleRecovery: async () => {
      calls.inventory += 1;
      return success(clone(inventory));
    },
  };
  const prepared = await prepareQdrantLifecycleReset({
    cwd: project.root,
    lifecycleKey,
    dependencies: resetDependencies({ client, resolveProjectRoot: project.resolveProjectRoot }),
  });

  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  assert.equal(calls.inventory, 1);
  const reportPath = join(project.root, prepared.reportPath);
  const reportText = await readFile(reportPath, "utf8");
  const report = JSON.parse(reportText);
  const archiveText = await readFile(join(project.root, ".ima-cycle", report.archive.name), "utf8");
  assert.equal(prepared.reportHash, sha256(reportText));
  assert.equal(report.expectedPinFingerprint.length, 64);
  assert.equal(report.inventory.fingerprint.length, 64);
  assert.equal(report.inventory.recordCount, inventory.records.length);
  assert.equal(report.inventory.pointCount, pointIds(inventory).length);
  assert.equal(report.inventory.records.flatMap((record) => record.pointIds).length, pointIds(inventory).length);
  assert.deepEqual(report.inventory.records.flatMap((record) => record.pointIds), pointIds(inventory));
  assert.equal(report.inventory.records.every((record) => record.pointFingerprint.length === 64), true);
  assert.equal(report.archive.sha256.length, 64);
  assert.doesNotMatch(JSON.stringify(prepared), /archive-body-secret|token=/);
  assert.doesNotMatch(reportText, /archive-body-secret|token=|qdrant\.test/);
  assert.match(archiveText, /archive-body-secret/, "only the private archive retains recovery payloads");
  assert.equal((await stat(join(project.root, ".ima-cycle"))).mode & 0o777, 0o700);
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(project.root, ".ima-cycle", report.archive.name))).mode & 0o777, 0o600);
});

test("prepare report carries a persistent attempt identifier with its immutable report hash", async (t) => {
  const { v1, inventory } = targetRecords();
  const project = await setupPinnedProject(t, v1);
  const client = { inventoryLifecycleRecovery: async () => success(clone(inventory)) };
  const prepared = await prepareQdrantLifecycleReset({
    cwd: project.root,
    lifecycleKey,
    dependencies: resetDependencies({ client, resolveProjectRoot: project.resolveProjectRoot }),
  });

  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  const report = JSON.parse(await readFile(join(project.root, prepared.reportPath), "utf8"));
  assert.equal(
    typeof report.attemptId,
    "string",
    "approved recovery evidence requires a persistent attempt identifier",
  );
  assert.match(report.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(prepared.reportHash, sha256(await readFile(join(project.root, prepared.reportPath), "utf8")));
});

test("direct reset confirmation denial, exception, and identity mismatch cause no recovery mutation", async (t) => {
  const cases = [
    ["missing trusted confirmation", undefined],
    ["denied trusted confirmation", async () => null],
    ["cancelled trusted confirmation", async () => false],
    ["throwing trusted confirmation", async () => { throw new Error("confirmation unavailable"); }],
    ["identity-mismatched trusted confirmation", async (confirmation) => {
      assert.equal(confirmation.stage, "intent");
      return structuredClone(confirmation);
    }],
  ];

  for (const [label, confirmReset] of cases) {
    const { v1, inventory } = targetRecords();
    const project = await setupPinnedProject(t, v1);
    const calls = { inventory: 0, snapshot: 0, deletion: 0, absence: 0 };
    const dependencies = resetDependencies({
      client: {
        inventoryLifecycleRecovery: async () => {
          calls.inventory += 1;
          return success(clone(inventory));
        },
        deleteLifecycleRecoveryInventory: async () => {
          calls.deletion += 1;
          return success(undefined);
        },
        proveLifecycleRecoveryAbsence: async () => {
          calls.absence += 1;
          return success(undefined);
        },
      },
      resolveProjectRoot: project.resolveProjectRoot,
      createSnapshot: async () => {
        calls.snapshot += 1;
        return success({ name: snapshotName });
      },
      confirmReset,
    });
    const prepared = await prepareQdrantLifecycleReset({
      cwd: project.root,
      lifecycleKey,
      dependencies,
    });
    assert.equal(prepared.status, "prepared", label);
    if (prepared.status !== "prepared") continue;
    const registry = join(project.root, ".ima-cycle", "provider-pins.json");
    const before = await readFile(registry, "utf8");

    assert.deepEqual(
      await executeQdrantLifecycleReset({
        cwd: project.root,
        reportPath: prepared.reportPath,
        confirmation: prepared.reportHash,
        dependencies,
      }),
      { status: "blocked", code: "lifecycle_reset_confirmation_required" },
      label,
    );
    assert.deepEqual(calls, { inventory: 1, snapshot: 0, deletion: 0, absence: 0 }, label);
    assert.equal(await readFile(registry, "utf8"), before, label);
    assert.deepEqual(
      await loadLifecyclePinStateWith(project.resolveProjectRoot)(project.root, lifecycleKey),
      { status: "pinned", pin: project.pin },
      label,
    );
  }
});

test("execute rejects report/archive tampering and declared bounds before Qdrant effects", async (t) => {
  const cases = [
    {
      label: "tampered archive",
      mutate: async ({ archivePath }) => writeFile(archivePath, "{}", "utf8"),
      code: "lifecycle_reset_archive_invalid",
    },
    {
      label: "tampered report hash",
      mutate: async ({ reportPath }) => {
        const original = await readFile(reportPath, "utf8");
        await writeFile(reportPath, `${original.trimEnd()} `, "utf8");
      },
      code: "lifecycle_reset_confirmation_invalid",
    },
    {
      label: "oversized report file",
      mutate: async ({ reportPath }) => writeFile(
        reportPath,
        "x".repeat(MAX_QDRANT_LIFECYCLE_RECOVERY_REPORT_BYTES + 1),
        "utf8",
      ),
      code: "lifecycle_reset_artifact_invalid",
    },
    {
      label: "archive receipt above its byte bound",
      mutate: async ({ reportPath }) => {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        report.archive.sizeBytes = MAX_QDRANT_LIFECYCLE_RECOVERY_ARCHIVE_BYTES + 1;
        await writeFile(reportPath, `${JSON.stringify(report)}\n`, "utf8");
      },
      code: "lifecycle_reset_report_invalid",
      useChangedHash: true,
    },
  ];

  for (const item of cases) {
    const { v1, inventory } = targetRecords();
    const project = await setupPinnedProject(t, v1);
    const calls = { inventory: 0, snapshot: 0, deletion: 0, absence: 0 };
    const client = {
      inventoryLifecycleRecovery: async () => {
        calls.inventory += 1;
        return success(clone(inventory));
      },
      deleteLifecycleRecoveryInventory: async () => {
        calls.deletion += 1;
        return success(undefined);
      },
      proveLifecycleRecoveryAbsence: async () => {
        calls.absence += 1;
        return success(undefined);
      },
    };
    const dependencies = resetDependencies({
      client,
      resolveProjectRoot: project.resolveProjectRoot,
      createSnapshot: async () => {
        calls.snapshot += 1;
        return success({ name: snapshotName });
      },
    });
    const prepared = await prepareQdrantLifecycleReset({
      cwd: project.root,
      lifecycleKey,
      dependencies,
    });
    assert.equal(prepared.status, "prepared", item.label);
    if (prepared.status !== "prepared") continue;
    const reportPath = join(project.root, prepared.reportPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    await item.mutate({
      reportPath,
      archivePath: join(project.root, ".ima-cycle", report.archive.name),
    });
    const confirmation = item.useChangedHash
      ? sha256(await readFile(reportPath, "utf8"))
      : prepared.reportHash;
    assert.deepEqual(
      await executeQdrantLifecycleReset({
        cwd: project.root,
        reportPath: prepared.reportPath,
        confirmation,
        dependencies,
      }),
      { status: "blocked", code: item.code },
      item.label,
    );
    assert.equal(calls.inventory, 1, item.label);
    assert.deepEqual(calls, { inventory: 1, snapshot: 0, deletion: 0, absence: 0 }, item.label);
    assert.deepEqual(
      await loadLifecyclePinStateWith(project.resolveProjectRoot)(project.root, lifecycleKey),
      { status: "pinned", pin: project.pin },
      item.label,
    );
  }
});

test("prepare and execute reject stale pin authority at their exact compare-and-swap boundaries", async (t) => {
  const { v1, v2, inventory } = targetRecords();
  const changedPin = pinFor(v2, "2026-09-20T12:01:00.000Z");

  const preparing = await setupPinnedProject(t, v1);
  let prepareInventoryCalls = 0;
  const prepareClient = {
    inventoryLifecycleRecovery: async () => {
      prepareInventoryCalls += 1;
      await replacePinnedState(preparing.root, changedPin);
      return success(clone(inventory));
    },
  };
  assert.deepEqual(
    await prepareQdrantLifecycleReset({
      cwd: preparing.root,
      lifecycleKey,
      dependencies: resetDependencies({
        client: prepareClient,
        resolveProjectRoot: preparing.resolveProjectRoot,
      }),
    }),
    { status: "blocked", code: "lifecycle_reset_pin_stale" },
  );
  assert.equal(prepareInventoryCalls, 1);
  assert.deepEqual(
    await loadLifecyclePinStateWith(preparing.resolveProjectRoot)(preparing.root, lifecycleKey),
    { status: "pinned", pin: changedPin },
  );

  const executing = await setupPinnedProject(t, v1);
  const calls = { inventory: 0, snapshot: 0, deletion: 0, absence: 0 };
  const client = {
    inventoryLifecycleRecovery: async () => {
      calls.inventory += 1;
      return success(clone(inventory));
    },
    deleteLifecycleRecoveryInventory: async () => {
      calls.deletion += 1;
      return success(undefined);
    },
    proveLifecycleRecoveryAbsence: async () => {
      calls.absence += 1;
      return success(undefined);
    },
  };
  const dependencies = resetDependencies({
    client,
    resolveProjectRoot: executing.resolveProjectRoot,
    createSnapshot: async () => {
      calls.snapshot += 1;
      return success({ name: snapshotName });
    },
  });
  const prepared = await prepareQdrantLifecycleReset({
    cwd: executing.root,
    lifecycleKey,
    dependencies,
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  const trusted = trustedResetConfirmations({
    report: JSON.parse(await readFile(join(executing.root, prepared.reportPath), "utf8")),
    reportHash: prepared.reportHash,
    stages: [{ operation: "execute", stage: "intent" }],
  });
  dependencies.confirmReset = trusted.confirmReset;
  await replacePinnedState(executing.root, changedPin);
  assert.deepEqual(
    await executeQdrantLifecycleReset({
      cwd: executing.root,
      reportPath: prepared.reportPath,
      confirmation: prepared.reportHash,
      dependencies,
    }),
    { status: "blocked", code: "lifecycle_pin_recovery_pin_conflict" },
  );
  trusted.assertComplete();
  assert.deepEqual(calls, { inventory: 2, snapshot: 0, deletion: 0, absence: 0 });
  assert.deepEqual(
    await loadLifecyclePinStateWith(executing.resolveProjectRoot)(executing.root, lifecycleKey),
    { status: "pinned", pin: changedPin },
  );
});

test("execute transitions through blocking recovery, clears only after proof, and permits ordinary repinning", async (t) => {
  const { v1, v2, inventory } = targetRecords();
  const project = await setupPinnedProject(t, v1);
  const calls = { inventory: 0, snapshot: 0, deletion: [], absence: [] };
  const snapshotStates = [];
  const client = {
    inventoryLifecycleRecovery: async () => {
      calls.inventory += 1;
      return success(clone(inventory));
    },
    deleteLifecycleRecoveryInventory: async (input) => {
      calls.deletion.push({
        input: clone(input),
        state: await loadLifecyclePinStateWith(project.resolveProjectRoot)(project.root, lifecycleKey),
      });
      return success(undefined);
    },
    proveLifecycleRecoveryAbsence: async (input) => {
      calls.absence.push({
        input: clone(input),
        state: await loadLifecyclePinStateWith(project.resolveProjectRoot)(project.root, lifecycleKey),
      });
      return success(undefined);
    },
  };
  const dependencies = resetDependencies({
    client,
    resolveProjectRoot: project.resolveProjectRoot,
    createSnapshot: async () => {
      calls.snapshot += 1;
      snapshotStates.push(await loadLifecyclePinStateWith(project.resolveProjectRoot)(project.root, lifecycleKey));
      return success({ name: snapshotName });
    },
  });
  const prepared = await prepareQdrantLifecycleReset({
    cwd: project.root,
    lifecycleKey,
    dependencies,
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  const trusted = trustedResetConfirmations({
    report: JSON.parse(await readFile(join(project.root, prepared.reportPath), "utf8")),
    reportHash: prepared.reportHash,
    stages: [
      { operation: "execute", stage: "intent" },
      { operation: "execute", stage: "deletion" },
    ],
  });
  dependencies.confirmReset = trusted.confirmReset;

  const result = await executeQdrantLifecycleReset({
    cwd: project.root,
    reportPath: prepared.reportPath,
    confirmation: prepared.reportHash,
    dependencies,
  });
  assert.equal(result.status, "completed");
  trusted.assertComplete();
  assert.equal(calls.inventory, 3);
  assert.equal(calls.snapshot, 1);
  assert.equal(calls.deletion.length, 1);
  assert.equal(calls.absence.length, 1);
  assert.equal(snapshotStates[0].status, "recovering");
  assert.equal(snapshotStates[0].recovery.checkpoint.stage, "snapshot_started");
  assert.equal(calls.deletion[0].state.status, "recovering");
  assert.equal(calls.deletion[0].state.recovery.checkpoint.stage, "deletion_started");
  assert.equal(calls.absence[0].state.recovery.checkpoint.stage, "deletion_started");
  assert.deepEqual(calls.deletion[0].input, { lifecycleKey, inventory });
  assert.deepEqual(calls.absence[0].input, { lifecycleKey, inventory });
  assert.deepEqual(
    await loadLifecyclePinStateWith(project.resolveProjectRoot)(project.root, lifecycleKey),
    { status: "absent" },
  );

  const ordinaryAttempt = attemptFor("2712a503-8994-5025-ae27-2f5caac146a2");
  const repin = pinFor(v2, "2026-09-20T12:02:00.000Z");
  assert.deepEqual(
    await beginLifecyclePinWith(project.resolveProjectRoot)(project.root, ordinaryAttempt),
    { status: "started", attempt: ordinaryAttempt },
  );
  const writing = await markLifecyclePinAttemptWritingWith(project.resolveProjectRoot)(project.root, ordinaryAttempt);
  assert.equal(writing.status, "writing");
  if (writing.status !== "writing") return;
  assert.deepEqual(
    await confirmLifecyclePinWith(project.resolveProjectRoot)(project.root, writing.attempt, repin),
    { status: "pinned", pin: repin },
  );
});

test("snapshot uncertainty and cancellation retain blocking recovery without deletion", async (t) => {
  const scenarios = [
    {
      label: "unverified snapshot listing",
      snapshot: async () => failure("response_invalid"),
      expected: { status: "blocked", code: "lifecycle_reset_snapshot_response_invalid" },
    },
    {
      label: "mid-snapshot cancellation",
      controller: new AbortController(),
      snapshot: async ({ controller, signal }) => {
        assert.equal(signal, controller.signal);
        controller.abort();
        return success({ name: snapshotName });
      },
      expected: { status: "blocked", code: "aborted" },
    },
  ];

  for (const scenario of scenarios) {
    const { v1, inventory } = targetRecords();
    const project = await setupPinnedProject(t, v1);
    const calls = { inventory: 0, snapshot: 0, deletion: 0, absence: 0 };
    const client = {
      inventoryLifecycleRecovery: async () => {
        calls.inventory += 1;
        return success(clone(inventory));
      },
      deleteLifecycleRecoveryInventory: async () => {
        calls.deletion += 1;
        return success(undefined);
      },
      proveLifecycleRecoveryAbsence: async () => {
        calls.absence += 1;
        return success(undefined);
      },
    };
    const dependencies = resetDependencies({
      client,
      resolveProjectRoot: project.resolveProjectRoot,
      createSnapshot: async (signal) => {
        calls.snapshot += 1;
        return scenario.snapshot({ controller: scenario.controller, signal });
      },
    });
    const prepared = await prepareQdrantLifecycleReset({
      cwd: project.root,
      lifecycleKey,
      dependencies,
    });
    assert.equal(prepared.status, "prepared", scenario.label);
    if (prepared.status !== "prepared") continue;
    const trusted = trustedResetConfirmations({
      report: JSON.parse(await readFile(join(project.root, prepared.reportPath), "utf8")),
      reportHash: prepared.reportHash,
      stages: [{ operation: "execute", stage: "intent" }],
    });
    dependencies.confirmReset = trusted.confirmReset;
    assert.deepEqual(
      await executeQdrantLifecycleReset({
        cwd: project.root,
        reportPath: prepared.reportPath,
        confirmation: prepared.reportHash,
        dependencies,
        ...(scenario.controller ? { signal: scenario.controller.signal } : {}),
      }),
      scenario.expected,
      scenario.label,
    );
    const state = await loadLifecyclePinStateWith(project.resolveProjectRoot)(project.root, lifecycleKey);
    assert.equal(state.status, "recovering", scenario.label);
    if (state.status === "recovering") assert.equal(state.recovery.checkpoint.stage, "snapshot_started", scenario.label);
    trusted.assertComplete();
    assert.deepEqual(calls, { inventory: 2, snapshot: 1, deletion: 0, absence: 0 }, scenario.label);
  }
});

test("appended records and unverified deletion retain recovery for read-only reconciliation", async (t) => {
  const { v1, inventory } = targetRecords();
  const appended = storedRecord({
    schemaVersion: 1,
    phase: "decision",
    suffix: "appended",
  });
  const appendedInventory = inventoryFor([
    ...inventory.records.map((record) => ({
      ...record,
      points: clone(record.points),
    })),
    appended,
  ]);
  const concurrent = await setupPinnedProject(t, v1);
  let inventoryCalls = 0;
  const concurrentCalls = { snapshot: 0, deletion: 0, absence: 0 };
  const concurrentClient = {
    inventoryLifecycleRecovery: async () => {
      inventoryCalls += 1;
      return success(clone(inventoryCalls >= 3 ? appendedInventory : inventory));
    },
    deleteLifecycleRecoveryInventory: async () => {
      concurrentCalls.deletion += 1;
      return success(undefined);
    },
    proveLifecycleRecoveryAbsence: async () => {
      concurrentCalls.absence += 1;
      return success(undefined);
    },
  };
  const concurrentDependencies = resetDependencies({
    client: concurrentClient,
    resolveProjectRoot: concurrent.resolveProjectRoot,
    createSnapshot: async () => {
      concurrentCalls.snapshot += 1;
      return success({ name: snapshotName });
    },
  });
  const concurrentPrepared = await prepareQdrantLifecycleReset({
    cwd: concurrent.root,
    lifecycleKey,
    dependencies: concurrentDependencies,
  });
  assert.equal(concurrentPrepared.status, "prepared");
  if (concurrentPrepared.status !== "prepared") return;
  const concurrentTrusted = trustedResetConfirmations({
    report: JSON.parse(await readFile(join(concurrent.root, concurrentPrepared.reportPath), "utf8")),
    reportHash: concurrentPrepared.reportHash,
    stages: [{ operation: "execute", stage: "intent" }],
  });
  concurrentDependencies.confirmReset = concurrentTrusted.confirmReset;
  assert.deepEqual(
    await executeQdrantLifecycleReset({
      cwd: concurrent.root,
      reportPath: concurrentPrepared.reportPath,
      confirmation: concurrentPrepared.reportHash,
      dependencies: concurrentDependencies,
    }),
    { status: "blocked", code: "lifecycle_reset_inventory_stale" },
  );
  const concurrentState = await loadLifecyclePinStateWith(
    concurrent.resolveProjectRoot,
  )(concurrent.root, lifecycleKey);
  assert.equal(concurrentState.status, "recovering");
  if (concurrentState.status === "recovering") assert.equal(concurrentState.recovery.checkpoint.stage, "snapshot_verified");
  concurrentTrusted.assertComplete();
  assert.deepEqual(concurrentCalls, { snapshot: 1, deletion: 0, absence: 0 });

  const uncertainDelete = await setupPinnedProject(t, v1);
  const deleteCalls = { inventory: 0, snapshot: 0, deletion: 0, absence: 0 };
  const deleteClient = {
    inventoryLifecycleRecovery: async () => {
      deleteCalls.inventory += 1;
      return success(clone(inventory));
    },
    deleteLifecycleRecoveryInventory: async () => {
      deleteCalls.deletion += 1;
      return failure("store_unverified");
    },
    proveLifecycleRecoveryAbsence: async () => {
      deleteCalls.absence += 1;
      return success(undefined);
    },
  };
  const deleteDependencies = resetDependencies({
    client: deleteClient,
    resolveProjectRoot: uncertainDelete.resolveProjectRoot,
    createSnapshot: async () => {
      deleteCalls.snapshot += 1;
      return success({ name: snapshotName });
    },
  });
  const deletePrepared = await prepareQdrantLifecycleReset({
    cwd: uncertainDelete.root,
    lifecycleKey,
    dependencies: deleteDependencies,
  });
  assert.equal(deletePrepared.status, "prepared");
  if (deletePrepared.status !== "prepared") return;
  const deleteTrusted = trustedResetConfirmations({
    report: JSON.parse(await readFile(join(uncertainDelete.root, deletePrepared.reportPath), "utf8")),
    reportHash: deletePrepared.reportHash,
    stages: [
      { operation: "execute", stage: "intent" },
      { operation: "execute", stage: "deletion" },
      { operation: "reconcile", stage: "intent" },
    ],
  });
  deleteDependencies.confirmReset = deleteTrusted.confirmReset;
  assert.deepEqual(
    await executeQdrantLifecycleReset({
      cwd: uncertainDelete.root,
      reportPath: deletePrepared.reportPath,
      confirmation: deletePrepared.reportHash,
      dependencies: deleteDependencies,
    }),
    { status: "blocked", code: "lifecycle_reset_delete_store_unverified" },
  );
  const retained = await loadLifecyclePinStateWith(
    uncertainDelete.resolveProjectRoot,
  )(uncertainDelete.root, lifecycleKey);
  assert.equal(retained.status, "recovering");
  if (retained.status === "recovering") assert.equal(retained.recovery.checkpoint.stage, "deletion_started");
  assert.deepEqual(deleteCalls, { inventory: 3, snapshot: 1, deletion: 1, absence: 0 });

  assert.equal(
    (await reconcileQdrantLifecycleReset({
      cwd: uncertainDelete.root,
      reportPath: deletePrepared.reportPath,
      confirmation: deletePrepared.reportHash,
      dependencies: deleteDependencies,
    })).status,
    "reconciled",
  );
  assert.deepEqual(deleteCalls, { inventory: 3, snapshot: 1, deletion: 1, absence: 1 });
  assert.deepEqual(
    await loadLifecyclePinStateWith(uncertainDelete.resolveProjectRoot)(uncertainDelete.root, lifecycleKey),
    { status: "absent" },
  );
  deleteTrusted.assertComplete();
});
