// Obsidian-only image preparation. Generic media fetching is used as a
// low-level byte source; size policy and compression remain isolated here.

import { fetchImageBytes } from "../export/media.js";

export const OBSIDIAN_MEDIA_LIMITS = Object.freeze({
  maxAssets: 50,
  maxAssetBytes: 8 * 1024 * 1024,
  compressAboveBytes: 4 * 1024 * 1024,
  targetBytes: 4 * 1024 * 1024,
  maxDimension: 4096,
  concurrency: 2,
  chunkBytes: 512 * 1024
});

const MIME_EXTENSIONS = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff"
});

// 使用 FileReader 原生 base64 编码，避免原实现中 binary += String.fromCharCode(...)
// 的 O(n²) 字符串拼接（512KB chunk 需要 16 次循环拼接，每次拷贝不断增长的 binary 字符串）。
// FileReader 在 C++ 层完成编码，性能与内存占用均优于 JS 字符串拼接路径。
function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    const blob = new Blob([view]);
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      // readAsDataURL 返回 "data:<mime>;base64,<payload>"，需截取逗号后的纯 base64。
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to encode base64."));
    reader.readAsDataURL(blob);
  });
}

export async function sha256Bytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Image compression failed.")), type, quality);
  });
}

function safeBitmapDimensions(bitmap) {
  const sourceWidth = Number(bitmap && bitmap.width);
  const sourceHeight = Number(bitmap && bitmap.height);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("Image dimensions are invalid.");
  }
  const scale = Math.min(1, OBSIDIAN_MEDIA_LIMITS.maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  if (width * height > OBSIDIAN_MEDIA_LIMITS.maxDimension ** 2) {
    throw new Error("Image dimensions exceed the Obsidian safety limit.");
  }
  return { width, height };
}

async function compressStaticImage(bytes, mimeType, widthHint, heightHint, signal) {
  if (signal && signal.aborted) throw new DOMException("Sync cancelled.", "AbortError");
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  const sourceBlob = new Blob([bytes], { type: mimeType });
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const { width, height } = safeBitmapDimensions(bitmap);
    // 快速路径：触发压缩的图像通常 4-10MB，WebP 在 (scale=0.82, quality=0.82) 下
    // 一般能达到 60-70% 压缩率，足以命中 4MB 目标。命中时跳过下方 4 quality × 5 scale
    // = 20 次 canvasToBlob 网格搜索。视觉上 0.82 scale 与 0.82 quality 的损耗极小，
    // 仅在 export 产物中体现，不影响原始资产。未命中则退化到完整网格搜索以找最优解。
    try {
      const fastCanvas = document.createElement("canvas");
      fastCanvas.width = Math.max(1, Math.round(width * 0.82));
      fastCanvas.height = Math.max(1, Math.round(height * 0.82));
      const fastContext = fastCanvas.getContext("2d", { alpha: true });
      if (fastContext) {
        fastContext.drawImage(bitmap, 0, 0, fastCanvas.width, fastCanvas.height);
        const fastBlob = await canvasToBlob(fastCanvas, "image/webp", 0.82);
        if (fastBlob
          && fastBlob.size <= OBSIDIAN_MEDIA_LIMITS.targetBytes
          && fastBlob.size < bytes.byteLength) {
          return { bytes: new Uint8Array(await fastBlob.arrayBuffer()), mimeType: "image/webp", width, height };
        }
      }
    } catch (error) {
      if (signal && signal.aborted) throw error;
      // 快速路径失败（如 canvas 不可用）时静默退化到网格搜索。
    }
    const qualities = [0.86, 0.76, 0.64, 0.52];
    const scales = [1, 0.82, 0.68, 0.55, 0.42];
    let best = null;
    for (const scale of scales) {
      if (signal && signal.aborted) throw new DOMException("Sync cancelled.", "AbortError");
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Image compression canvas is unavailable.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of qualities) {
        const blob = await canvasToBlob(canvas, "image/webp", quality);
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= OBSIDIAN_MEDIA_LIMITS.targetBytes) break;
      }
      if (best && best.size <= OBSIDIAN_MEDIA_LIMITS.targetBytes) break;
    }
    if (!best || best.size >= bytes.byteLength && bytes.byteLength <= OBSIDIAN_MEDIA_LIMITS.maxAssetBytes) return null;
    return { bytes: new Uint8Array(await best.arrayBuffer()), mimeType: "image/webp", width, height };
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

export function extensionForMime(mimeType) {
  return MIME_EXTENSIONS[String(mimeType || "").toLowerCase()] || "png";
}

export async function prepareObsidianImage(image, options = {}) {
  const fetcher = options.fetchImageBytes || fetchImageBytes;
  const result = await fetcher(image.sourceUrl, { signal: options.signal });
  if (!result || !result.bytes || !result.mimeType) throw new Error("Image bytes are unavailable.");
  let bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
  let mimeType = String(result.mimeType || "").toLowerCase();
  if (!MIME_EXTENSIONS[mimeType]) throw new Error(`Unsupported image type: ${mimeType || "unknown"}`);
  if (bytes.byteLength > OBSIDIAN_MEDIA_LIMITS.maxAssetBytes) {
    throw new Error(mimeType === "image/gif" || mimeType === "image/svg+xml"
      ? "Large animated GIF or SVG could not be compressed safely."
      : "Image exceeds the Obsidian safety limit.");
  }
  let compressed = false;
  if (mimeType === "image/svg+xml") {
    // Pass SVG bytes through untouched, matching Notion's behavior.
    // Obsidian renders SVG attachments via <img>, which sandboxes scripts,
    // so no sanitization is needed. Regex/DOM-based sanitization risks
    // corrupting the markup (e.g. matching "on...=" inside <text> content,
    // re-serialization altering attribute order), which causes rendering
    // artifacts such as blank bands.
    compressed = true;
  }
  const staticRaster = !["image/gif", "image/svg+xml", "image/tiff"].includes(mimeType);
  const shouldCompress = staticRaster && (
    bytes.byteLength > OBSIDIAN_MEDIA_LIMITS.compressAboveBytes ||
    Math.max(Number(result.width || 0), Number(result.height || 0)) > OBSIDIAN_MEDIA_LIMITS.maxDimension
  );
  if (shouldCompress) {
    const next = await compressStaticImage(bytes, mimeType, result.width, result.height, options.signal).catch((error) => {
      if (error && error.name === "AbortError") throw error;
      return null;
    });
    if (next && next.bytes.byteLength < bytes.byteLength) {
      bytes = next.bytes;
      mimeType = next.mimeType;
      compressed = true;
    }
    if (bytes.byteLength > OBSIDIAN_MEDIA_LIMITS.targetBytes) {
      throw new Error("Image could not be compressed below the Obsidian 4 MiB target.");
    }
  }
  if (bytes.byteLength > OBSIDIAN_MEDIA_LIMITS.maxAssetBytes) {
    throw new Error(mimeType === "image/gif" || mimeType === "image/svg+xml"
      ? "Large animated GIF or SVG could not be compressed safely."
      : "Image remains larger than the Obsidian safety limit after compression.");
  }
  return {
    key: image.key,
    alt: image.alt,
    bytes,
    mimeType,
    extension: extensionForMime(mimeType),
    byteLength: bytes.byteLength,
    sha256: await sha256Bytes(bytes),
    compressed
  };
}

export async function* encodeAssetChunks(bytes, chunkBytes = OBSIDIAN_MEDIA_LIMITS.chunkBytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  for (let offset = 0; offset < source.byteLength; offset += chunkBytes) {
    const slice = source.subarray(offset, Math.min(source.byteLength, offset + chunkBytes));
    yield { offset, base64: await bytesToBase64(slice), byteLength: slice.byteLength };
  }
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(Number(concurrency || 1), source.length || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < source.length) {
      const index = cursor++;
      results[index] = await worker(source[index], index);
    }
  }));
  return results;
}
