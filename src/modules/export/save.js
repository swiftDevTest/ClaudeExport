import { blobToDataUrl } from './utils.js';

export var SAVE_RESPONSE_TIMEOUT_MS = 30000;
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

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
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
    }
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

    if (objectUrl && response.downloadId && response.state === "in_progress") {
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
