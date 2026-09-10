import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import type { TargetPage } from "./bookstack-migrate-source.ts";

const ROOT = ".ima/bookstack-migrate";
export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MAX_COLLECTION_PART_BYTES = 480 * 1024;
export const MAX_COLLECTION_PARTS = 1024;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hasExactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

export type BookStackArtifactRun = { projectRoot: string; directory: string; runId: string };
type InventoryPart = { name: string; count: number; sha256: string };
type InventoryManifest = {
  schemaVersion: 1;
  artifactType: "bookstack-inventory";
  count: number;
  parts: InventoryPart[];
};

export async function createBookStackArtifactRun(projectRoot: string, now = new Date()): Promise<BookStackArtifactRun> {
  const root = resolve(projectRoot);
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(root, ROOT, runId);
  if (!inside(root, directory)) throw new Error("artifact_path_invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { projectRoot: root, directory, runId };
}

export async function writeImmutableArtifact(
  run: BookStackArtifactRun,
  name: string,
  content: string,
): Promise<{ path: string; sha256: string }> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) {
    throw new Error("artifact_invalid");
  }
  const path = resolve(run.directory, name);
  if (!inside(run.directory, path)) throw new Error("artifact_path_invalid");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return { path: relative(run.projectRoot, path), sha256: hash(content) };
}

export async function readProjectArtifact(projectRoot: string, path: string): Promise<string> {
  const root = resolve(projectRoot);
  const absolute = resolve(root, path);
  if (!inside(resolve(root, ROOT), absolute)) throw new Error("artifact_path_invalid");
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_ARTIFACT_BYTES) {
    throw new Error("artifact_path_invalid");
  }
  return readFile(absolute, "utf8");
}

export const partitionBookStackInventory = (pages: TargetPage[]): TargetPage[][] => {
  const parts: TargetPage[][] = [];
  let part: TargetPage[] = [];
  let partBytes = Buffer.byteLength("[]", "utf8");

  for (const page of pages) {
    const serialized = JSON.stringify(page);
    if (typeof serialized !== "string") throw new Error("artifact_collection_item_too_large");
    const itemBytes = Buffer.byteLength(serialized, "utf8");
    const separatorBytes = part.length === 0 ? 0 : 1;
    if (Buffer.byteLength("[]", "utf8") + itemBytes > MAX_COLLECTION_PART_BYTES) {
      throw new Error("artifact_collection_item_too_large");
    }
    if (partBytes + separatorBytes + itemBytes > MAX_COLLECTION_PART_BYTES) {
      parts.push(part);
      part = [];
      partBytes = Buffer.byteLength("[]", "utf8");
    }
    part.push(page);
    partBytes += (part.length === 1 ? 0 : 1) + itemBytes;
  }

  if (part.length > 0) parts.push(part);
  if (parts.length > MAX_COLLECTION_PARTS) throw new Error("artifact_collection_too_large");
  return parts;
};

export async function writeBookStackInventory(
  run: BookStackArtifactRun,
  pages: TargetPage[],
): Promise<{ path: string; count: number; parts: InventoryPart[] }> {
  const partPages = partitionBookStackInventory(pages);
  const parts: InventoryPart[] = [];

  for (const [index, pagesForPart] of partPages.entries()) {
    const name = `inventory.part-${String(index + 1).padStart(4, "0")}.json`;
    const artifact = await writeImmutableArtifact(run, name, JSON.stringify(pagesForPart));
    parts.push({ name, count: pagesForPart.length, sha256: artifact.sha256 });
  }

  const manifest: InventoryManifest = {
    schemaVersion: 1,
    artifactType: "bookstack-inventory",
    count: pages.length,
    parts,
  };
  const artifact = await writeImmutableArtifact(run, "inventory.json", JSON.stringify(manifest));
  return { path: artifact.path, count: pages.length, parts };
}

const parseInventoryJson = (content: string, code: string): unknown => {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(code);
  }
};

const parseInventoryManifest = (value: unknown): InventoryManifest => {
  if (!isObject(value) || !hasExactKeys(value, ["schemaVersion", "artifactType", "count", "parts"])) {
    throw new Error("inventory_manifest_invalid");
  }
  if (value.schemaVersion !== 1 || value.artifactType !== "bookstack-inventory" || !isNonNegativeInteger(value.count)) {
    throw new Error("inventory_manifest_invalid");
  }
  if (!Array.isArray(value.parts) || value.parts.length > MAX_COLLECTION_PARTS) {
    throw new Error("inventory_manifest_invalid");
  }

  const parts = value.parts.map((part) => {
    if (!isObject(part) || !hasExactKeys(part, ["name", "count", "sha256"])) {
      throw new Error("inventory_manifest_invalid");
    }
    if (
      typeof part.name !== "string"
      || !/^inventory\.part-\d{4}\.json$/.test(part.name)
      || !isNonNegativeInteger(part.count)
      || typeof part.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(part.sha256)
    ) {
      throw new Error("inventory_manifest_invalid");
    }
    return { name: part.name, count: part.count, sha256: part.sha256 };
  });

  return { schemaVersion: 1, artifactType: "bookstack-inventory", count: value.count, parts };
};

export async function readBookStackInventory(projectRoot: string, inventoryPath: string): Promise<TargetPage[]> {
  let inventoryContent: string;
  try {
    inventoryContent = await readProjectArtifact(projectRoot, inventoryPath);
  } catch {
    throw new Error("inventory_manifest_invalid");
  }
  const inventory = parseInventoryJson(inventoryContent, "inventory_manifest_invalid");
  if (Array.isArray(inventory)) return inventory as TargetPage[];

  const manifest = parseInventoryManifest(inventory);
  const runDirectory = dirname(inventoryPath);
  const pages: TargetPage[] = [];

  for (const [index, part] of manifest.parts.entries()) {
    const expectedName = `inventory.part-${String(index + 1).padStart(4, "0")}.json`;
    if (part.name !== expectedName) throw new Error("inventory_manifest_invalid");
    let content: string;
    try {
      content = await readProjectArtifact(projectRoot, `${runDirectory}/${part.name}`);
    } catch {
      throw new Error("inventory_part_invalid");
    }
    if (hash(content) !== part.sha256) throw new Error("inventory_part_hash_mismatch");
    const values = parseInventoryJson(content, "inventory_part_invalid");
    if (!Array.isArray(values) || values.length !== part.count) throw new Error("inventory_part_invalid");
    pages.push(...values as TargetPage[]);
  }

  if (pages.length !== manifest.count) throw new Error("inventory_count_mismatch");
  return pages;
}

export async function acquireBookStackMigrationLock(projectRoot: string): Promise<() => Promise<void>> {
  const path = resolve(projectRoot, ROOT, ".lock");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    throw new Error("migration_in_progress");
  }
  return async () => {
    await handle.close();
    await unlink(path);
  };
}
