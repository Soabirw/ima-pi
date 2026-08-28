import assert from "node:assert/strict";
import test from "node:test";
import { dryRunVestige, migrateVestige } from "../extensions/vestige-migrate.ts";
import {
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_DIGEST,
  VECTOR_NAME,
  VECTOR_SIZE,
} from "../lib/qdrant-corpus.ts";
import { createInstitutionalSnapshot } from "../lib/qdrant-http-boundary.ts";
import { createQdrantCorpusClient } from "../lib/qdrant-http.ts";
import {
  fakeClient,
  lifecycleRecord,
  migrationCli,
  temporaryProject,
} from "./vestige-migrate-fixtures.js";

const environment = {
  IMA_QDRANT_URL: "http://qdrant.test",
  IMA_OLLAMA_URL: "http://ollama.test",
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const indexedCollection = () => ({
  result: {
    config: {
      params: {
        vectors: {
          [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" },
        },
      },
    },
    payload_schema: Object.fromEntries([
      "lifecycle_key",
      "phase",
      "project",
      "site",
      "repo",
      "record_kind",
      "parent_record_key",
    ].map((field) => [field, { data_type: "keyword" }])),
  },
});

const transportError = (code) =>
  Object.assign(new Error("snapshot-transport-secret"), { cause: { code } });

const snapshotFetcher = (snapshotAttempts) => async (input) => {
  const request = new URL(String(input));
  if (request.hostname === "qdrant.test" && request.pathname === "/") {
    return json({ version: "1.17.1" });
  }
  if (request.hostname === "ollama.test" && request.pathname === "/api/tags") {
    return json({ models: [{ name: EMBEDDING_MODEL, digest: EMBEDDING_MODEL_DIGEST }] });
  }
  if (request.hostname === "qdrant.test"
    && request.pathname === "/collections/ima-institutional-memory/snapshots") {
    snapshotAttempts.count += 1;
    if (snapshotAttempts.count === 1) throw transportError("ECONNRESET");
    return json({ result: { name: "recovered.snapshot" } });
  }
  if (request.hostname === "qdrant.test"
    && request.pathname === "/collections/ima-institutional-memory") {
    return json(indexedCollection());
  }
  throw new Error(`unexpected request: ${request.pathname}`);
};

const migrationClient = (fetcher, destination) => ({
  ...destination.client,
  preflight: createQdrantCorpusClient({ env: environment, fetch: fetcher }).preflight,
});

test("migration recovers one pre-send snapshot reset and imports the source", async (t) => {
  const root = await temporaryProject(t);
  const snapshotAttempts = { count: 0 };
  const fetcher = snapshotFetcher(snapshotAttempts);
  const destination = fakeClient({ collection: "ready" });
  const migration = await migrateVestige(root, {
    client: migrationClient(fetcher, destination),
    createSnapshot: (signal) => createInstitutionalSnapshot({
      env: environment,
      fetch: fetcher,
    }, signal),
    ...migrationCli("backup", JSON.stringify([lifecycleRecord()])),
  });

  assert.deepEqual(migration.report.recovery.snapshot, {
    status: "created",
    name: "recovered.snapshot",
  });
  assert.equal(migration.report.summary.migrated, 1);
  assert.equal(destination.records.size, 1);
  assert.equal(snapshotAttempts.count, 2);
  assert.doesNotMatch(JSON.stringify(migration), /snapshot-transport-secret/);
});

test("dry run is READY without issuing a snapshot request", async (t) => {
  const root = await temporaryProject(t);
  const snapshotAttempts = { count: 0 };
  const fetcher = snapshotFetcher(snapshotAttempts);
  const destination = fakeClient({ collection: "ready" });
  const dryRun = await dryRunVestige(root, {
    client: migrationClient(fetcher, destination),
    ...migrationCli("backup", JSON.stringify([lifecycleRecord()])),
  });

  assert.equal(dryRun.report.outcome, "READY");
  assert.equal(dryRun.artifactPath.endsWith("dry-run-report.json"), true);
  assert.equal(snapshotAttempts.count, 0);
});

test("snapshot maxAttempts one disables reset recovery", async () => {
  let attempts = 0;
  const result = await createInstitutionalSnapshot({
    env: environment,
    maxAttempts: 1,
    fetch: async () => {
      attempts += 1;
      throw transportError("ECONNRESET");
    },
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.error.context, {
    operation: "institutional_collection",
    cause: "transport_reset",
  });
  assert.equal(attempts, 1);
  assert.doesNotMatch(JSON.stringify(result), /snapshot-transport-secret/);
});
