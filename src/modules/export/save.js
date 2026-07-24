import { blobToDataUrl } from './utils.js';

export var SAVE_RESPONSE_TIMEOUT_MS = 30000;
// 保存对话框可能长时间停留等待用户操作，给予充裕的等待上限。
export var SAVE_DOWNLOAD_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000;
// Data URLs are only a small compatibility fallback when Blob URLs are unavailable.
export var MAX_EXPORT_SAVE_BYTES = 512 * 1024;
export var BLOB_URL_REVOKE_DELAY_MS = 60000;

export function normalizeSaveOptions(options) {
  var source = options && typeof options === "object" ? options : {};
  var timeoutMs = Number(source.timeoutMs);

  return {
    saveAs: source.saveAs !== false,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 120000)
      : SAVE_RESPONSE_TIMEOUT_MS
  };
}

export function sendSaveExportMessage(payload, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error("Export save timed out. Please check Chrome downloads and try again."));
    }, timeoutMs || SAVE_RESPONSE_TIMEOUT_MS);

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }

    try {
      chrome.runtime.sendMessage({
        type: "CHATVAULT_SAVE_EXPORT",
        filename: payload.filename,
        dataUrl: payload.dataUrl,
        blobUrl: payload.blobUrl,
        saveAs: payload.saveAs
      }, function (reply) {
        var lastError = chrome.runtime.lastError;
        if (lastError) {
          finish(reject, new Error(lastError.message || "Save dialog is not available."));
          return;
        }
        finish(resolve, reply);
      });
    } catch (error) {
      var msg = error.message || "";
      if (msg.includes("context invalidated") || msg.includes("Extension context invalidated")) {
        finish(reject, new Error("Extension context invalidated. Please refresh the webpage and try again."));
      } else {
        finish(reject, error);
      }
    }
  });
}

export function canUseBlobUrlDownload(blob) {
  return !!(blob &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof URL.revokeObjectURL === "function");
}

export function scheduleBlobUrlRevoke(objectUrl) {
  if (!objectUrl || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }

  var timer = setTimeout(function () {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch (error) {}
  }, BLOB_URL_REVOKE_DELAY_MS);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

var activeBlobUrls = new Map();
// 等待下载实际完成的 Promise resolve/reject 回调，按 downloadId 索引。
// saveBlobWithDialog 在 background 返回 state="in_progress" 时注册 waiter，
// 由 CHATVAULT_DOWNLOAD_STATUS 消息（下载 complete/interrupted 时触发）来 resolve。
var downloadCompletionWaiters = new Map();
// 缓存已完成的下载状态，处理"完成消息先于 waiter 注册到达"的竞态。
var downloadCompletionCache = new Map();
var downloadStatusListenerAttached = false;

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage && !downloadStatusListenerAttached) {
  downloadStatusListenerAttached = true;
  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === "CHATVAULT_DOWNLOAD_STATUS") {
      var downloadId = message.downloadId;
      var entry = activeBlobUrls.get(downloadId);
      if (entry) {
        try {
          URL.revokeObjectURL(entry.objectUrl);
        } catch (error) {}
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        activeBlobUrls.delete(downloadId);
      }
      // resolve 对应的 saveBlobWithDialog waiter，让结果弹窗在下载真正完成后才弹出
      var waiter = downloadCompletionWaiters.get(downloadId);
      if (waiter) {
        downloadCompletionWaiters.delete(downloadId);
        if (message.cancelled) {
          var cancelErr = new Error("Save cancelled.");
          cancelErr.name = "AbortError";
          waiter.reject(cancelErr);
        } else if (message.state === "complete") {
          waiter.resolve({ filename: message.filename });
        } else {
          waiter.reject(new Error(message.error || "Download failed."));
        }
      } else {
        // waiter 尚未注册（竞态），缓存结果供 waitForDownloadCompletion 立即读取
        downloadCompletionCache.set(downloadId, {
          cancelled: message.cancelled,
          state: message.state,
          filename: message.filename,
          error: message.error,
          ts: Date.now()
        });
        // 清理 30 秒前的缓存条目，避免无限增长
        setTimeout(function () {
          downloadCompletionCache.delete(downloadId);
        }, 30000);
      }
    }
  });
}

// 等待指定 downloadId 的下载真正完成（用户在保存对话框中确认保存或取消）。
// 解决 saveBlob 在 saveAs 对话框仍打开时就 resolve、导致结果弹窗与保存对话框叠加的问题。
function waitForDownloadCompletion(downloadId, timeoutMs) {
  // 先检查缓存：下载可能在 waiter 注册前已完成（小文件 / saveAs:false 快速完成）
  var cached = downloadCompletionCache.get(downloadId);
  if (cached) {
    downloadCompletionCache.delete(downloadId);
    if (cached.cancelled) {
      var cancelErr = new Error("Save cancelled.");
      cancelErr.name = "AbortError";
      return Promise.reject(cancelErr);
    }
    if (cached.state === "complete") {
      return Promise.resolve({ filename: cached.filename });
    }
    return Promise.reject(new Error(cached.error || "Download failed."));
  }

  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      downloadCompletionWaiters.delete(downloadId);
      // 超时不视为失败——下载可能仍在进行，resolve 让调用方继续流程
      resolve({ filename: "", timedOut: true });
    }, timeoutMs || SAVE_DOWNLOAD_COMPLETION_TIMEOUT_MS);

    downloadCompletionWaiters.set(downloadId, {
      resolve: function (result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      reject: function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

export async function saveBlobWithDialog(blob, filename, options) {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    throw new Error("Save dialog is not available. Please reload the extension and try again.");
  }

  var normalized = normalizeSaveOptions(options);
  var blobSize = Number(blob && blob.size || 0);
  var useBlobUrl = canUseBlobUrlDownload(blob);
  var objectUrl = "";

  if (useBlobUrl) {
    objectUrl = URL.createObjectURL(blob);
  } else if (blobSize > MAX_EXPORT_SAVE_BYTES) {
    throw new Error("Export file is too large for the Chrome message bridge. Please export fewer conversations or split the export into smaller files.");
  }

  var dataUrl = objectUrl ? "" : await blobToDataUrl(blob);

  try {
    var response = await sendSaveExportMessage({
      filename: filename,
      dataUrl: dataUrl,
      blobUrl: objectUrl,
      saveAs: normalized.saveAs
    }, normalized.timeoutMs);

    if (!response || !response.ok) {
      var error = new Error(response && response.error || "Export save was canceled.");
      if (response && response.cancelled) error.name = "AbortError";
      throw error;
    }

    if (objectUrl && response.downloadId) {
      // 所有 response.ok 情况下都转移 objectUrl 到 activeBlobUrls，由 CHATVAULT_DOWNLOAD_STATUS
      // 监听器在下载 complete/interrupted 时统一清理。之前仅在 state==="in_progress" 时转移，
      // 若 background 返回 ok 但 state 字段缺失/为其他值，finally 会 60s 后过早 revoke。
      var safetyTimer = setTimeout(function () {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (e) {}
        activeBlobUrls.delete(response.downloadId);
      }, 5 * 60 * 1000);
      if (safetyTimer && typeof safetyTimer.unref === "function") {
        safetyTimer.unref();
      }
      activeBlobUrls.set(response.downloadId, {
        objectUrl: objectUrl,
        timer: safetyTimer
      });
      objectUrl = "";
    }

    // background 在 saveAs 对话框打开时即返回 state="in_progress"。
    // 必须等待下载真正完成（用户确认保存）后才 resolve，否则结果弹窗会与
    // 保存对话框叠加显示。waitForDownloadCompletion 通过 CHATVAULT_DOWNLOAD_STATUS
    // 消息获知下载 complete/interrupted/cancelled。
    if (response.state === "in_progress" && response.downloadId) {
      var completion = await waitForDownloadCompletion(
        response.downloadId,
        SAVE_DOWNLOAD_COMPLETION_TIMEOUT_MS
      );
      if (completion && completion.filename) {
        response.filename = completion.filename;
      }
    }

    return response.filename || filename;
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw err;
    }
    var msg = err && err.message ? err.message : "";
    if (msg.includes("context invalidated") || msg.includes("Extension context invalidated")) {
      throw new Error("Extension context invalidated. Please refresh the webpage and try again.");
    }
    throw new Error(msg || "Save dialog is not available. Please reload the extension and try again.");
  } finally {
    if (objectUrl) {
      scheduleBlobUrlRevoke(objectUrl);
    }
  }
}

export async function saveBlob(blob, filename, options) {
  try {
    var savedName = await saveBlobWithDialog(blob, filename, options);
    return { ok: true, filename: savedName || filename };
  } catch (error) {
    if (error && error.name === "AbortError") {
      return { ok: false, cancelled: true };
    }
    return { ok: false, error: error.message || "Save failed." };
  }
}
