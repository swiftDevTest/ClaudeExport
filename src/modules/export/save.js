import { blobToDataUrl } from './utils.js';

export var SAVE_RESPONSE_TIMEOUT_MS = 30000;
// 保存对话框可能长时间停留等待用户操作，给予充裕的等待上限。
export var SAVE_DOWNLOAD_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000;
// Data URLs are only a small compatibility fallback when Blob URLs are unavailable.
export var MAX_EXPORT_SAVE_BYTES = 512 * 1024;
export var BLOB_URL_REVOKE_DELAY_MS = 60000;
export var BLOB_URL_SAFETY_TIMEOUT_MS = 30 * 60 * 1000;

function structuredSaveFailure(error) {
  var protocol = typeof globalThis !== "undefined" ? globalThis.CHATVAULT_EXPORT_ERRORS : null;
  var details = protocol && typeof protocol.serialize === "function"
    ? protocol.serialize(error, { phase: "save" })
    : { error_code: error && error.code || "SAVE_DENIED", error_phase: "save", retryable: true };
  return {
    ok: false,
    error: error && error.message || "Save failed.",
    code: details.error_code,
    ...details
  };
}

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

function sendExportBridgeMessage(message, timeoutMs) {
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
      chrome.runtime.sendMessage(message, function (reply) {
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

export function sendSaveExportMessage(payload, timeoutMs) {
  return sendExportBridgeMessage({ type: "CHATVAULT_SAVE_EXPORT", ...payload }, timeoutMs);
}

async function waitForSaveRequestStart(requestId) {
  var deadline = Date.now() + BLOB_URL_SAFETY_TIMEOUT_MS;
  while (true) {
    var status = await sendExportBridgeMessage({ type: "CHATVAULT_GET_EXPORT_SAVE_STATUS", requestId: requestId });
    if (!status || !status.ok || status.state !== "pending") return status;
    if (Date.now() >= deadline) {
      var error = new Error("Export save timed out while waiting for a filename. Please check Chrome downloads before trying again.");
      error.code = "OPERATION_TIMEOUT";
      throw error;
    }
    await new Promise(function (resolve) { setTimeout(resolve, DOWNLOAD_STATUS_POLL_MS); });
  }
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

// Download events are fast, but can be lost before the background persists its
// tab mapping. Poll only while a save is pending to cover that race and popups.
var DOWNLOAD_STATUS_POLL_MS = 1000;
var activeBlobUrls = new Map();

function releaseDownloadBlob(downloadId) {
  var entry = activeBlobUrls.get(downloadId);
  if (!entry) return;
  activeBlobUrls.delete("request:" + entry.requestId);
  if (entry.downloadId) activeBlobUrls.delete(entry.downloadId);
  clearTimeout(entry.timer);
  try { URL.revokeObjectURL(entry.objectUrl); } catch (error) {}
}

var downloadCompletionWaiters = new Map();
var downloadCompletionCache = new Map();

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "CHATVAULT_DOWNLOAD_STATUS" ||
        (message.state !== "complete" && message.state !== "interrupted")) return;
    var downloadId = message.downloadId;
    releaseDownloadBlob(downloadId);
    if (message.requestId) releaseDownloadBlob("request:" + message.requestId);
    if (!Number.isInteger(downloadId)) return;
    var waiter = downloadCompletionWaiters.get(downloadId);
    if (waiter) {
      waiter(message);
    } else {
      downloadCompletionCache.set(downloadId, message);
      var timer = setTimeout(function () { downloadCompletionCache.delete(downloadId); }, 30000);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
  });
}

function waitForDownloadCompletion(downloadId, timeoutMs) {
  var cached = downloadCompletionCache.get(downloadId);
  if (cached) {
    downloadCompletionCache.delete(downloadId);
    releaseDownloadBlob(downloadId);
    return Promise.resolve(cached);
  }

  return new Promise(function (resolve, reject) {
    var settled = false;
    var pollTimer = null;
    var timer = setTimeout(function () {
      var error = new Error("Export save timed out. Please check Chrome downloads before trying again.");
      error.code = "OPERATION_TIMEOUT";
      finish(reject, error);
    }, timeoutMs || SAVE_DOWNLOAD_COMPLETION_TIMEOUT_MS);

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      downloadCompletionWaiters.delete(downloadId);
      fn(value);
    }

    function poll() {
      if (settled) return;
      try {
        chrome.runtime.sendMessage({ type: "CHATVAULT_GET_DOWNLOAD_STATUS", downloadId: downloadId }, function (reply) {
          var lastError = chrome.runtime.lastError;
          if (settled) return;
          if (!lastError && reply && (reply.state === "complete" || reply.state === "interrupted")) {
            releaseDownloadBlob(downloadId);
            finish(resolve, reply);
          } else {
            pollTimer = setTimeout(poll, DOWNLOAD_STATUS_POLL_MS);
          }
        });
      } catch (error) {
        finish(reject, error);
      }
    }

    downloadCompletionWaiters.set(downloadId, function (status) { finish(resolve, status); });
    pollTimer = setTimeout(poll, DOWNLOAD_STATUS_POLL_MS);
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
  var terminalStatusKnown = false;
  var requestId = "save_" + (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + "_" + Math.random().toString(36).slice(2));
  var requestKey = "request:" + requestId;

  if (useBlobUrl) {
    objectUrl = URL.createObjectURL(blob);
    var entry = { objectUrl: objectUrl, requestId: requestId, downloadId: null, timer: null };
    entry.timer = setTimeout(function () { releaseDownloadBlob(requestKey); }, BLOB_URL_SAFETY_TIMEOUT_MS);
    if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
    activeBlobUrls.set(requestKey, entry);
  } else if (blobSize > MAX_EXPORT_SAVE_BYTES) {
    throw new Error("Export file is too large for the Chrome message bridge. Please export fewer conversations or split the export into smaller files.");
  }

  try {
    var dataUrl = objectUrl ? "" : await blobToDataUrl(blob);
    var response = await sendSaveExportMessage({
      requestId: requestId,
      filename: filename,
      dataUrl: dataUrl,
      blobUrl: objectUrl,
      saveAs: normalized.saveAs
    }, normalized.timeoutMs).catch(async function (error) {
      // The background may have accepted the request even if its immediate
      // acknowledgement was lost. Reconcile by identity before reporting failure.
      try {
        var status = await sendExportBridgeMessage({ type: "CHATVAULT_GET_EXPORT_SAVE_STATUS", requestId: requestId });
        if (status && (status.ok || status.state === "interrupted")) return status;
      } catch (statusError) {}
      throw error;
    });

    if (response && response.ok && response.state === "pending") {
      response = await waitForSaveRequestStart(requestId);
    }

    if (objectUrl && response?.ok && response.downloadId && response.state !== "complete") {
      var retained = activeBlobUrls.get(requestKey);
      if (retained) {
        retained.downloadId = response.downloadId;
        activeBlobUrls.set(response.downloadId, retained);
      }
    }

    if (response && response.ok && response.state !== "complete" && response.downloadId) {
      var completion = await waitForDownloadCompletion(response.downloadId, SAVE_DOWNLOAD_COMPLETION_TIMEOUT_MS);
      response = { ...response, ...completion, ok: completion.state === "complete" };
    }

    terminalStatusKnown = Boolean(response && (response.state === "complete" || response.state === "interrupted" || response.cancelled));
    if (!response || !response.ok) {
      var error = new Error(response && response.error || "Export save failed.");
      if (response && response.cancelled) error.name = "AbortError";
      throw error;
    }
    return response.filename || filename;
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    var msg = err && err.message ? err.message : "";
    if (msg.includes("context invalidated") || msg.includes("Extension context invalidated")) {
      throw new Error("Extension context invalidated. Please refresh the webpage and try again.");
    }
    throw err instanceof Error ? err : new Error(msg || "Save dialog is not available. Please reload the extension and try again.");
  } finally {
    // Pending file choosers and unconfirmed downloads retain their URL until a
    // terminal event or the safety cap, including after a message timeout.
    if (terminalStatusKnown) releaseDownloadBlob(requestKey);
  }
}

export async function saveBlob(blob, filename, options) {
  try {
    var savedName = await saveBlobWithDialog(blob, filename, options);
    return { ok: true, filename: savedName || filename };
  } catch (error) {
    if (error && error.name === "AbortError") {
      return { ok: false, cancelled: true, code: "SAVE_CANCELLED", error_code: "SAVE_CANCELLED", error_phase: "save", retryable: true };
    }
    return structuredSaveFailure(error);
  }
}
