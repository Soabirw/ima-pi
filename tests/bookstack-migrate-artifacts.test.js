import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MAX_ARTIFACT_BYTES,
  MAX_COLLECTION_PART_BYTES,
  createBookStackArtifactRun,
  partitionBookStackInventory,
  readBookStackInventory,
  writeBookStackInventory,
} from "../lib/bookstack-migrate-artifacts.ts";

const inventoryPage = (index, body = "body") => ({
  sourceId: `source:${index}`,
  sourceHash: `${index}`.padStart(64, "0"),
  body,
  markdown: body,
});

const withProjectRoot = async (run) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ima-bookstack-artifacts-"));
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

const inventoryPath = (projectRoot, artifact) => join(projectRoot, artifact.path);

test("inventory collection preserves page order and private artifact modes", async () => {
  await withProjectRoot(async (projectRoot) => {
    const run = await createBookStackArtifactRun(projectRoot);
    const pages = [inventoryPage(1), inventoryPage(2)];
    const inventory = await writeBookStackInventory(run, pages);
    const manifest = JSON.parse(await readFile(inventoryPath(projectRoot, inventory), "utf8"));

    assert.equal(manifest.artifactType, "bookstack-inventory");
    assert.equal(manifest.count, pages.length);
    assert.equal(manifest.parts.length, 1);
    assert.deepEqual(await readBookStackInventory(projectRoot, inventory.path), pages);
    assert.equal((await stat(run.directory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(projectRoot, dirname(inventory.path), manifest.parts[0].name))).mode & 0o777,
      0o600,
    );
  });
});

test("inventory collection splits oversized aggregate inventories into bounded parts", async () => {
  await withProjectRoot(async (projectRoot) => {
    const run = await createBookStackArtifactRun(projectRoot);
    const pages = Array.from({ length: 30 }, (_, index) => inventoryPage(index, "x".repeat(20_000)));
    const inventory = await writeBookStackInventory(run, pages);

    assert.ok(inventory.parts.length > 1);
    for (const part of inventory.parts) {
      const size = (await stat(join(projectRoot, dirname(inventory.path), part.name))).size;
      assert.ok(size <= MAX_ARTIFACT_BYTES);
      assert.ok(size <= MAX_COLLECTION_PART_BYTES);
    }
    assert.deepEqual(await readBookStackInventory(projectRoot, inventory.path), pages);
  });
});

test("inventory collection rejects oversized individual pages", () => {
  assert.throws(
    () => partitionBookStackInventory([inventoryPage(1, "x".repeat(MAX_COLLECTION_PART_BYTES))]),
    /artifact_collection_item_too_large/,
  );
});

test("inventory collection fails closed on modified, missing, or reordered parts", async () => {
  await withProjectRoot(async (projectRoot) => {
    const run = await createBookStackArtifactRun(projectRoot);
    const inventory = await writeBookStackInventory(run, [inventoryPage(1)]);
    const manifestPath = inventoryPath(projectRoot, inventory);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const partPath = join(projectRoot, dirname(inventory.path), manifest.parts[0].name);

    await writeFile(partPath, "[]", "utf8");
    await assert.rejects(readBookStackInventory(projectRoot, inventory.path), /inventory_part_hash_mismatch/);

    await writeFile(manifestPath, JSON.stringify({ ...manifest, parts: [{ ...manifest.parts[0], name: "inventory.part-0002.json" }] }), "utf8");
    await assert.rejects(readBookStackInventory(projectRoot, inventory.path), /inventory_manifest_invalid/);

    await writeFile(manifestPath, JSON.stringify({ ...manifest, parts: [{ ...manifest.parts[0], name: "inventory.part-0001.json", sha256: manifest.parts[0].sha256 }] }), "utf8");
    await rm(partPath);
    await assert.rejects(readBookStackInventory(projectRoot, inventory.path), /inventory_part_invalid/);
  });
});

test("inventory collection rejects malformed manifests and reads legacy arrays", async () => {
  await withProjectRoot(async (projectRoot) => {
    const directory = join(projectRoot, ".ima", "bookstack-migrate", "legacy");
    const path = ".ima/bookstack-migrate/legacy/inventory.json";
    const pages = [inventoryPage(1)];
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "inventory.json"), JSON.stringify(pages), { mode: 0o600 });
    assert.deepEqual(await readBookStackInventory(projectRoot, path), pages);

    const excessiveManifest = {
      schemaVersion: 1,
      artifactType: "bookstack-inventory",
      count: 0,
      parts: Array.from({ length: 1025 }, (_, index) => ({
        name: `inventory.part-${String(index + 1).padStart(4, "0")}.json`,
        count: 0,
        sha256: "0".repeat(64),
      })),
    };
    await writeFile(join(directory, "inventory.json"), JSON.stringify(excessiveManifest), "utf8");
    await assert.rejects(readBookStackInventory(projectRoot, path), /inventory_manifest_invalid/);
  });
});
