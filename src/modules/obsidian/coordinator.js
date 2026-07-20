// Obsidian-only synchronization coordinator. It owns the staged write protocol
// and intentionally does not register itself with the generic export engine.

import { collectObsidianImages, renderObsidianMarkdown } from "./renderer.js";
import {
  OBSIDIAN_MEDIA_LIMITS,
  encodeAssetChunks,
  mapWithConcurrency,
  prepareObsidianImage
} from "./media.js";

// 历史问题：runtimeMessage 一次失败即 abort，content script 与 SW 之间短暂的
// 连接断开（"Could not establish connection. Receiving end does not exist."）
// 会让整个同步失败。修复：对这类瞬时错误做 1-2 次指数退避重试，避免长同步因
// 短暂通信中断前功尽弃。注意：只对通信类错误重试，业务错误（response.ok=false）
// 不重试。
const RUNTIME_MESSAGE_MAX_RETRIES = 2;
const RUNTIME_MESSAGE_BASE_DELAY_MS = 200;

function isTransientRuntimeError(lastError, attempt) {
  if (!lastError) return false;
  const message = String(lastError.message || "").toLowerCase();
  // SW 重启 / content script 未就绪 / 通道未建立 等可恢复错误
  return (
    message.includes("could not establish connection") ||
    message.includes("receiving end does not exist") ||
    message.includes("the message port closed before a response was received") ||
    message.includes("extension context invalidated")
  );
}

function runtimeMessageOnce(payload) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          const error = new Error(lastError.message || "Obsidian background request failed.");
          error._runtimeLastError = lastError;
          return reject(error);
        }
        if (!response || !response.ok) {
          const error = new Error(response && response.error || "Obsidian background request failed.");
          error.code = response && response.code || "obsidian_error";
          return reject(error);
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runtimeMessage(payload) {
  let lastError = null;
  for (let attempt = 0; attempt <= RUNTIME_MESSAGE_MAX_RETRIES; attempt++) {
    try {
      return await runtimeMessageOnce(payload);
    } catch (error) {
      lastError = error;
      // 业务错误（已收到 SW 响应但 response.ok=false）不重试
      if (error.code && error.code !== "obsidian_error" && !error._runtimeLastError) {
        throw error;
      }
      // 通信类错误：判断是否可重试
      const runtimeError = error._runtimeLastError;
      if (!isTransientRuntimeError(runtimeError || { message: error.message }, attempt)) {
        throw error;
      }
      if (attempt >= RUNTIME_MESSAGE_MAX_RETRIES) {
        throw error;
      }
      // 指数退避：200ms → 400ms
      const delay = RUNTIME_MESSAGE_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError || new Error("Obsidian background request failed.");
}

function abortError() {
  return new DOMException("Sync cancelled.", "AbortError");
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

function randomId(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sanitizePathSegment(value, fallback, maxLength = 96) {
  let output = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/[.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  if (!output || output === "." || output === "..") output = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(output)) output = `${output}-chat`;
  return output;
}

function normalizeRoot(value) {
  const source = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!source) return "";
  return source.split("/").map((segment) => sanitizePathSegment(segment, "Folder", 80)).join("/");
}

function joinRelativePath(root, leaf) {
  return [normalizeRoot(root), String(leaf || "").replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
}

function relativePath(fromFile, toFile) {
  const from = String(fromFile || "").split("/").filter(Boolean);
  const to = String(toFile || "").split("/").filter(Boolean);
  from.pop();
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const parts = [...Array(from.length - common).fill(".."), ...to.slice(common)];
  return parts.join("/") || to[to.length - 1] || "image";
}

export async function createObsidianSyncPaths(input, status, runId) {
  const config = status.config || {};
  const notesRoot = normalizeRoot(config.notesRoot);
  const assetsRoot = config.assetsRootCustom ? normalizeRoot(config.assetsRoot) : notesRoot;
  const suffix = runId.replace(/^obsidian_run_/, "").replace(/-/g, "").slice(0, 8) || Date.now().toString(36);
  const baseName = sanitizePathSegment(input.title, "AI Chat Export");
  const sourceIdentity = input.sourceUrl
    ? `${String(input.platform || "unknown").toLowerCase()}\n${String(input.sourceUrl)}`
    : `${String(input.platform || "unknown").toLowerCase()}\n${String(input.title || "")}\n${runId}`;
  const sourceKey = /^[a-f0-9]{64}$/i.test(String(input.sourceKey || ""))
    ? String(input.sourceKey).toLowerCase()
    : await sha256Text(sourceIdentity);
  return {
    sourceKey,
    noteRelativePath: joinRelativePath(notesRoot, `${baseName}.md`),
    assetsDirectory: joinRelativePath(assetsRoot, `${baseName}-assets/${sourceKey.slice(0, 12)}-${suffix}`)
  };
}

function notify(input, phase, progress, detail) {
  if (typeof input.onProgress !== "function") return;
  input.onProgress({ phase, progress: Math.max(0, Math.min(1, Number(progress || 0))), detail: detail || "" });
}

export async function getObsidianStatus() {
  return runtimeMessage({ type: "CHATVAULT_OBSIDIAN_GET_STATUS" });
}

export async function syncConversationToObsidian(input = {}) {
  const signal = input.signal;
  throwIfAborted(signal);
  notify(input, "preflight", 0.03, "Checking Vault access");
  const status = input.status && input.status.connected !== undefined ? input.status : await getObsidianStatus();
  if (!status.connected) {
    const error = new Error("Connect an Obsidian Vault first.");
    error.code = "vault_missing";
    throw error;
  }
  if (status.permission !== "granted") {
    const error = new Error("Obsidian Vault permission must be granted again.");
    error.code = "permission_required";
    throw error;
  }
  if (status.directoriesValid === false) {
    const error = new Error("Obsidian note or asset folder is missing. Open Vault settings to repair it.");
    error.code = "directories_missing";
    throw error;
  }
  if (status.activeJob) {
    const error = new Error("Another Obsidian sync is already in progress.");
    error.code = "job_conflict";
    throw error;
  }
  const messages = Array.isArray(input.messages) ? input.messages : [];
  if (!messages.length) throw new Error("No conversation messages are available for Obsidian sync.");

  const runId = String(input.runId || randomId("obsidian_run"));
  const jobId = String(input.jobId || randomId("obsidian_job"));
  const paths = await createObsidianSyncPaths(input, status, runId);
  const allImages = collectObsidianImages(messages);
  const images = allImages.slice(0, OBSIDIAN_MEDIA_LIMITS.maxAssets);
  const warnings = Array.isArray(input.warnings) ? input.warnings.slice() : [];
  if (allImages.length > images.length) {
    warnings.push({ code: "image_limit", detail: `${allImages.length - images.length} images exceeded the per-note limit.` });
  }
  let began = false;
  let completed = 0;
  const mediaBySource = new Map();
  const stats = { savedImages: 0, compressedImages: 0, skippedImages: allImages.length - images.length, failedImages: 0 };

  try {
    await runtimeMessage({
      type: "CHATVAULT_OBSIDIAN_BEGIN",
      payload: {
        jobId,
        batchId: input.batchId || "",
        title: input.title || "AI Chat Export",
        platform: input.platform || "unknown",
        scope: input.scope === "selected" ? "selected" : "conversation",
        sourceKey: paths.sourceKey,
        noteRelativePath: paths.noteRelativePath,
        assetsDirectory: paths.assetsDirectory,
        expectedAssets: images.length
      }
    });
    began = true;
    notify(input, "media", images.length ? 0.1 : 0.72, images.length ? `Processing 0/${images.length} images` : "No images to process");

    await mapWithConcurrency(images, OBSIDIAN_MEDIA_LIMITS.concurrency, async (image, index) => {
      throwIfAborted(signal);
      const assetId = `asset_${String(index + 1).padStart(6, "0")}`;
      try {
        const prepared = await prepareObsidianImage(image, { signal, fetchImageBytes: input.fetchImageBytes });
        const filename = `${String(index + 1).padStart(3, "0")}-${prepared.sha256.slice(0, 8)}.${prepared.extension}`;
        const assetPath = `${paths.assetsDirectory}/${filename}`;
        for (const chunk of encodeAssetChunks(prepared.bytes)) {
          throwIfAborted(signal);
          await runtimeMessage({
            type: "CHATVAULT_OBSIDIAN_WRITE_ASSET_CHUNK",
            payload: {
              jobId,
              asset: {
                id: assetId,
                relativePath: assetPath,
                mimeType: prepared.mimeType,
                byteLength: prepared.byteLength,
                sha256: prepared.sha256
              },
              offset: chunk.offset,
              base64: chunk.base64
            }
          });
        }
        await runtimeMessage({ type: "CHATVAULT_OBSIDIAN_COMPLETE_ASSET", payload: { jobId, assetId } });
        mediaBySource.set(image.key, { linkPath: relativePath(paths.noteRelativePath, assetPath), assetPath });
        stats.savedImages += 1;
        if (prepared.compressed) stats.compressedImages += 1;
      } catch (error) {
        if (signal && signal.aborted || error && error.name === "AbortError") throw error;
        stats.failedImages += 1;
        warnings.push({ code: "image_unavailable", detail: String(error && error.message || "Image could not be saved.").slice(0, 300) });
      } finally {
        completed += 1;
        notify(input, "media", 0.1 + 0.6 * (completed / Math.max(1, images.length)), `Processing ${completed}/${images.length} images`);
      }
    });

    throwIfAborted(signal);
    notify(input, "render", 0.76, "Building Obsidian Markdown");
    const markdown = renderObsidianMarkdown({
      runId,
      sourceKey: paths.sourceKey,
      scope: input.scope,
      selectedCount: input.selectedCount,
      messages,
      metadata: {
        title: input.title,
        platform: input.platform,
        platformLabel: input.platformLabel,
        userLabel: input.userLabel,
        sourceUrl: input.sourceUrl,
        exportedAt: input.exportedAt || new Date()
      },
      settings: input.settings || {},
      mediaBySource
    });
    if (typeof input.beforeFinalize === "function") {
      await input.beforeFinalize({ jobId, runId, noteRelativePath: paths.noteRelativePath });
    }
    notify(input, "write", 0.88, "Writing note to Vault");
    const response = await runtimeMessage({
      type: "CHATVAULT_OBSIDIAN_FINALIZE",
      payload: { jobId, markdown, warnings, stats }
    });
    began = false;
    notify(input, "complete", 1, "Obsidian sync complete");
    return { ...response, runId, jobId };
  } catch (error) {
    if (began) {
      await runtimeMessage({
        type: "CHATVAULT_OBSIDIAN_ABORT",
        jobId,
        record: true,
        status: signal && signal.aborted || error && error.name === "AbortError" ? "cancelled" : "failed",
        warningCode: String(error && error.code || error && error.name || "sync_failed").slice(0, 80)
      }).catch(() => {});
    }
    throw error;
  }
}

export const OBSIDIAN_COORDINATOR_VERSION = "obsidian-sync-v1";
