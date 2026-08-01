import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export type VisionImageSource = { id: string; sourceLabel: string; mimeType: string; byteLength: number; absolutePath: string };
export type VisionImageAttachment = { type: "image"; data: string; mimeType: string };
export type AdmittedVisionImage = { source: VisionImageSource; attachment: VisionImageAttachment };
export type VisionAdmissionError = "image_path_invalid" | "image_not_found" | "image_not_regular_file" | "image_empty" | "image_too_large" | "image_unsupported" | "image_read_failed";

export const classifyImage = (bytes: Uint8Array): string | null => {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))) return "image/gif";
  return null;
};
export const imageSizeError = (size: number): "image_empty" | "image_too_large" | null => size === 0 ? "image_empty" : size > MAX_IMAGE_BYTES ? "image_too_large" : null;
export const extensionMatchesMime = (path: string, mimeType: string): boolean => {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const expected: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  return !extension || !expected[extension] || expected[extension] === mimeType;
};
export const validateImagePaths = (paths: unknown): { valid: true; paths: string[] } | { valid: false; error: string } => {
  if (!Array.isArray(paths) || paths.length > 4) return { valid: false, error: "delegation_image_count_invalid" };
  const normalized = paths.map((path) => typeof path === "string" && path.trim() ? normalize(path) : "");
  if (normalized.some((path) => !path || !isAbsolute(path))) return { valid: false, error: "delegation_image_path_invalid" };
  if (new Set(normalized).size !== normalized.length) return { valid: false, error: "delegation_image_path_duplicate" };
  return { valid: true, paths: normalized };
};
export const publicVisionSource = (source: VisionImageSource) => ({ id: source.id, sourceLabel: source.sourceLabel, mimeType: source.mimeType, byteLength: source.byteLength });

type ReadHandle = { read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }> };
export async function readBoundedImage(handle: ReadHandle, validatedSize: number): Promise<Buffer | null> {
  const limit = Math.min(validatedSize + 1, MAX_IMAGE_BYTES + 1);
  const buffer = Buffer.allocUnsafe(limit);
  let offset = 0;
  while (offset < limit) {
    const { bytesRead } = await handle.read(buffer, offset, limit - offset, offset);
    if (bytesRead === 0) return buffer.subarray(0, offset);
    offset += bytesRead;
  }
  return null;
}

export async function admitVisionImage(path: string): Promise<{ admitted: true; value: AdmittedVisionImage } | { admitted: false; error: VisionAdmissionError }> {
  if (!isAbsolute(path)) return { admitted: false, error: "image_path_invalid" };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile()) return { admitted: false, error: "image_not_regular_file" };
    const sizeError = imageSizeError(info.size);
    if (sizeError) return { admitted: false, error: sizeError };
    const bytes = await readBoundedImage(handle, info.size);
    if (!bytes) return { admitted: false, error: "image_too_large" };
    const mimeType = classifyImage(bytes);
    if (!mimeType || !extensionMatchesMime(path, mimeType)) return { admitted: false, error: "image_unsupported" };
    const source = { id: randomUUID(), sourceLabel: basename(path), mimeType, byteLength: bytes.length, absolutePath: normalize(path) };
    return { admitted: true, value: { source, attachment: { type: "image", data: bytes.toString("base64"), mimeType } } };
  } catch (error) { return { admitted: false, error: (error as { code?: string }).code === "ENOENT" ? "image_not_found" : "image_read_failed" }; }
  finally { await handle?.close(); }
}
export async function admitVisionImages(paths: string[]) {
  const values: AdmittedVisionImage[] = [];
  for (const path of paths) { const admitted = await admitVisionImage(path); if (!admitted.admitted) return admitted; values.push(admitted.value); }
  return { admitted: true as const, value: values };
}
