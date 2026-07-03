import { isSubstantialSvg, convertSvgToDataUrl, mapLimit, yieldToBrowser, notifyProgress, isGoogleUserContentUrl, isGoogleAccountAvatarUrl, isTrustedConversationImageSrc, isPlatformOrSystemIcon, isTestEnv, canvasToBlob, ensureImageBlockMetadata, getImageDedupKey } from './utils.js';

var IMAGE_CACHE_MAX = 50;
var IMAGE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
var IMAGE_FETCH_MAX_BYTES = 8 * 1024 * 1024;
var IMAGE_PRELOAD_CONCURRENCY = 2;
var IMAGE_PRELOAD_CANVAS_TIMEOUT_MS = 5000;
var IMAGE_ELEMENT_LOAD_TIMEOUT_MS = 8000;
var _imageBytesCache = new Map();
var _imageBytesCacheBytes = 0;
var _imageBytesInFlight = new Map();

function normalizeImageMimeType(value) {
  var mimeType = String(value || "").split(";")[0].trim().toLowerCase();
  if (mimeType === "image/jpg") return "image/jpeg";
  return mimeType;
}

function isSupportedImageMimeType(value) {
  return /^image\/(?:png|jpe?g|gif|webp|svg\+xml|bmp|avif|heic|heif)$/i.test(String(value || ""));
}

function toByteArray(bytes) {
  if (!bytes) return new Uint8Array();
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength || bytes.length || 0);
  }
  return new Uint8Array();
}

function bytesStartWith(bytes, signature) {
  if (!bytes || bytes.length < signature.length) return false;
  for (var index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}

function asciiHeader(bytes, maxLength) {
  var length = Math.min(bytes.length, maxLength || 512);
  var text = "";
  for (var index = 0; index < length; index += 1) {
    var byte = bytes[index];
    if (byte === 0) continue;
    text += String.fromCharCode(byte);
  }
  return text.trim().toLowerCase();
}

function looksLikeNonImagePayload(bytes) {
  var header = asciiHeader(bytes, 512);
  return /^<!doctype\s+html\b/.test(header) ||
    /^<html\b/.test(header) ||
    /^<body\b/.test(header) ||
    /^<(?:error|script|div|pre)\b/.test(header) ||
    /^[{[]/.test(header);
}

export function detectImageMimeType(bytes, fallbackMimeType) {
  var data = toByteArray(bytes);
  var fallback = normalizeImageMimeType(fallbackMimeType);

  if (!data.length) return "";
  if (bytesStartWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytesStartWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytesStartWith(data, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (data.length >= 12 &&
      bytesStartWith(data.subarray(0, 4), [0x52, 0x49, 0x46, 0x46]) &&
      bytesStartWith(data.subarray(8, 12), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  if (bytesStartWith(data, [0x42, 0x4d])) return "image/bmp";

  var header = asciiHeader(data, 512);
  if (/^<\?xml\b[\s\S]*<svg\b/.test(header) || /^<svg\b/.test(header)) return "image/svg+xml";
  if (data.length >= 12 && bytesStartWith(data.subarray(4, 8), [0x66, 0x74, 0x79, 0x70])) {
    var brand = asciiHeader(data.subarray(8, 12), 4);
    if (/^(avif|avis)$/.test(brand)) return "image/avif";
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "image/heic";
  }

  if (isSupportedImageMimeType(fallback) && !looksLikeNonImagePayload(data)) {
    return fallback;
  }

  return "";
}

function getCachedImageByteLength(value) {
  return Math.max(0, Number(value && value.bytes && value.bytes.byteLength || 0) || 0);
}

function assertImageByteLength(byteLength) {
  if (Number.isFinite(byteLength) && byteLength > IMAGE_FETCH_MAX_BYTES) {
    throw new Error("Image is too large to export safely. Reduce images or export a shorter conversation.");
  }
}

function binaryStringToBytes(binaryStr) {
  return Uint8Array.from(binaryStr, function (char) {
    return char.charCodeAt(0);
  });
}

function textToUtf8Bytes(text) {
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(text);
  }
  var encoded = unescape(encodeURIComponent(text));
  return binaryStringToBytes(encoded);
}

export function parseImageDataUrl(src) {
  if (!src || typeof src !== "string" || src.indexOf("data:") !== 0) {
    return null;
  }
  var commaIndex = src.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }

  var meta = src.slice(5, commaIndex);
  var payload = src.slice(commaIndex + 1);
  var mimeType = (meta.split(";")[0] || "image/png").trim() || "image/png";

  try {
    if (/;base64(?:;|$)/i.test(";" + meta)) {
      return {
        bytes: binaryStringToBytes(atob(payload.replace(/\s/g, ""))),
        mimeType: mimeType
      };
    }

    var decodedPayload = payload;
    try {
      decodedPayload = decodeURIComponent(payload);
    } catch (decodeErr) {
      decodedPayload = payload;
    }
    return {
      bytes: textToUtf8Bytes(decodedPayload),
      mimeType: mimeType
    };
  } catch (err) {
    return null;
  }
}

export var imageBytesCache = {
  get: function (key) {
    return _imageBytesCache.get(key);
  },
  set: function (key, value) {
    if (_imageBytesCache.has(key)) {
      _imageBytesCacheBytes -= getCachedImageByteLength(_imageBytesCache.get(key));
      _imageBytesCache.delete(key);
    }
    _imageBytesCache.set(key, value);
    _imageBytesCacheBytes += getCachedImageByteLength(value);
    while (_imageBytesCache.size > IMAGE_CACHE_MAX || _imageBytesCacheBytes > IMAGE_CACHE_MAX_BYTES) {
      var firstKey = _imageBytesCache.keys().next().value;
      _imageBytesCacheBytes -= getCachedImageByteLength(_imageBytesCache.get(firstKey));
      _imageBytesCache.delete(firstKey);
    }
    return _imageBytesCache;
  },
  has: function (key) {
    return _imageBytesCache.has(key);
  },
  get size() {
    return _imageBytesCache.size;
  },
  get byteLength() {
    return Math.max(0, _imageBytesCacheBytes);
  }
};

function createAbortError() {
  var err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function createImageFetchRequestId() {
  return "img_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
}

function sendBackgroundImageFetchCancel(requestId) {
  if (!requestId) return;
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      return;
    }
    chrome.runtime.sendMessage({
      type: "CHATVAULT_CANCEL_IMAGE_FETCH",
      requestId: requestId
    }, function () {
      try {
        var ignored = chrome.runtime.lastError;
      } catch (error) {
      }
    });
  } catch (error) {
  }
}

export async function fetchImageBytes(src, options) {
  if (options && options.signal && options.signal.aborted) {
    throw createAbortError();
  }
  if (!src) return null;
  if (!isTestEnv && imageBytesCache.has(src)) {
    return imageBytesCache.get(src);
  }
  if (_imageBytesInFlight.has(src)) {
    return _imageBytesInFlight.get(src);
  }
  var pending = _fetchImageBytesDirectly(src, options).then(function (result) {
    if (result && result.bytes) {
      assertImageByteLength(result.bytes.byteLength);
    }
    if (!isTestEnv && result) {
      imageBytesCache.set(src, result);
    }
    return result;
  }).finally(function () {
    _imageBytesInFlight.delete(src);
  });
  _imageBytesInFlight.set(src, pending);
  var result = await pending;
  return result;
}

function shouldFetchImageBeforeCorsLoad(src) {
  var parsed = parseImageUrl(src);
  if (!parsed || !/^https?:$/i.test(parsed.protocol)) return false;

  return isCurrentCredentialedImageApi(src) ||
    (isTrustedConversationImageSrc(src) &&
      /(?:oaiusercontent\.com|googleusercontent\.com|google\.com|anthropic\.com|image_generation_content)/i.test(String(src || "")));
}

function getCurrentPageUrl() {
  return typeof window !== "undefined" && window.location && window.location.href
    ? window.location.href
    : "";
}

function parseImageUrl(src) {
  try {
    return new URL(String(src || ""), getCurrentPageUrl() || undefined);
  } catch (error) {
    return null;
  }
}

function isCurrentCredentialedImageApi(src) {
  var parsed = parseImageUrl(src);
  if (!parsed || !/^https?:$/i.test(parsed.protocol)) return false;
  if (typeof window === "undefined" || !window.location || parsed.origin !== window.location.origin) return false;

  var hostname = parsed.hostname.toLowerCase();
  var pathname = parsed.pathname.toLowerCase();
  var isChatGptHost = hostname === "chatgpt.com" || hostname === "chat.openai.com";
  var isClaudeHost = hostname === "claude.ai";

  return (isChatGptHost && pathname.indexOf("/backend-api/") !== -1) ||
    (isClaudeHost && pathname.indexOf("/api/organizations/") !== -1);
}

async function fetchImageBytesViaNetwork(src, options) {
  if (options && options.signal && options.signal.aborted) {
    throw createAbortError();
  }
  if (typeof window !== "undefined" && window.location && window.location.protocol === "https:") {
    if (src && String(src).indexOf("http://") === 0) {
      src = "https://" + String(src).slice(7);
    }
  }
  try {
    var shouldUseCredentialedApi = isCurrentCredentialedImageApi(src);
    var parsedSrc = parseImageUrl(src);
    if (!parsedSrc || !/^https?:$/i.test(parsedSrc.protocol)) {
      return null;
    }

    var headers = {};
    if (shouldUseCredentialedApi && String(src || "").indexOf("/backend-api/") !== -1) {
      try {
        var sessionController = typeof AbortController !== "undefined" ? new AbortController() : null;
        var sessionTimeoutId = sessionController ? setTimeout(function () { sessionController.abort(); }, 4000) : null;
        var sessionAbortListener = null;
        if (sessionController && options && options.signal) {
          sessionAbortListener = function () { sessionController.abort(); };
          if (options.signal.aborted) {
            sessionController.abort();
          } else {
            options.signal.addEventListener("abort", sessionAbortListener, { once: true });
          }
        }
        try {
          var sessionResponse = await globalThis["fetch"](window.location.origin + "/api/auth/session", {
            credentials: "include",
            signal: sessionController ? sessionController.signal : undefined
          });
          if (sessionResponse.ok) {
            var session = await sessionResponse.json();
            if (session && session.accessToken) {
              headers["Authorization"] = "Bearer " + session.accessToken;
            }
          }
        } finally {
          if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
          if (options && options.signal && sessionAbortListener) {
            options.signal.removeEventListener("abort", sessionAbortListener);
          }
        }
      } catch (sessionErr) {
      }
    }
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timeoutId = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;
    var abortListener = null;
    if (controller && options && options.signal) {
      abortListener = function () { controller.abort(); };
      options.signal.addEventListener("abort", abortListener, { once: true });
      if (options.signal.aborted) {
        controller.abort();
      }
    }
    try {
      var fetchOptions = {
        headers: headers,
        signal: controller ? controller.signal : undefined
      };
      if (shouldUseCredentialedApi) {
        fetchOptions.credentials = "include";
      }
      var response = await globalThis["fetch"](src, fetchOptions);
      if (!response.ok) throw new Error("Fetch response not OK: " + response.status);
      var contentLength = Number(response.headers && response.headers.get ? response.headers.get("content-length") || 0 : 0);
      assertImageByteLength(contentLength);
      var arrayBuffer = await response.arrayBuffer();
      assertImageByteLength(arrayBuffer.byteLength);
      var bytes = new Uint8Array(arrayBuffer);
      var mimeType = detectImageMimeType(bytes, response.headers.get("content-type") || "image/png");
      if (!mimeType) return null;
      return { bytes: bytes, mimeType: mimeType };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (controller && options && options.signal && abortListener) {
        options.signal.removeEventListener("abort", abortListener);
      }
    }
  } catch (err) {
    if (options && options.signal && options.signal.aborted) {
      throw createAbortError();
    }
  }

  try {
    var bgResponse = await new Promise(function (resolve, reject) {
      if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
        reject(new Error("chrome.runtime is not available"));
        return;
      }
      var requestId = createImageFetchRequestId();
      var settled = false;
      var abortListener = null;
      var messageTimeout = setTimeout(function () {
        sendBackgroundImageFetchCancel(requestId);
        finish(reject, new Error("Background fetch timeout"));
      }, 8000);
      function cleanup() {
        clearTimeout(messageTimeout);
        if (options && options.signal && abortListener) {
          options.signal.removeEventListener("abort", abortListener);
        }
      }
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      }
      if (options && options.signal) {
        abortListener = function () {
          sendBackgroundImageFetchCancel(requestId);
          finish(reject, createAbortError());
        };
        if (options.signal.aborted) {
          abortListener();
          return;
        }
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      chrome.runtime.sendMessage({
        type: "CHATVAULT_FETCH_IMAGE_BYTES",
        url: src,
        requestId: requestId
      }, function (reply) {
        var lastError = chrome.runtime.lastError;
        if (lastError) {
          finish(reject, new Error(lastError.message || "Background request failed."));
          return;
        }
        finish(resolve, reply);
      });
    });

    if (bgResponse && bgResponse.ok && bgResponse.base64) {
      var binaryStr = atob(bgResponse.base64);
      var bytes = new Uint8Array(binaryStr.length);
      assertImageByteLength(bytes.byteLength);
      for (var i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      var detectedMimeType = detectImageMimeType(bytes, bgResponse.mimeType || "image/png");
      if (!detectedMimeType) {
        return null;
      }
      return {
        bytes: bytes,
        mimeType: detectedMimeType
      };
    }
  } catch (bgErr) {
    if (options && options.signal && options.signal.aborted) {
      throw createAbortError();
    }
  }

  return null;
}

async function _fetchImageBytesDirectly(src, options) {
  if (!src) return null;

  function getRealImgSrc(imgEl) {
    if (!imgEl) return "";
    var rawSrc = imgEl.src || imgEl.getAttribute("src") || "";
    var imgSrc = rawSrc || imgEl.getAttribute("data-src") || imgEl.getAttribute("srcset") || "";

    var hasSrcset = imgEl.getAttribute("srcset");
    if (hasSrcset && (!imgSrc || imgSrc.indexOf("image_generation_content") !== -1 || imgSrc.startsWith("data:image/svg+xml"))) {
      var srcsetParts = String(hasSrcset).split(",").map(function (s) {
        return s.trim().split(" ")[0];
      }).filter(Boolean);
      if (srcsetParts.length > 0) {
        imgSrc = srcsetParts[srcsetParts.length - 1];
      }
    }

    if (imgSrc && imgSrc.indexOf(",") !== -1) {
      var srcsetParts = imgSrc.split(",").map(function (s) {
        return s.trim().split(" ")[0];
      }).filter(Boolean);
      if (srcsetParts.length > 0) {
        imgSrc = srcsetParts[srcsetParts.length - 1];
      }
    }
    return imgSrc;
  }

  if (src.indexOf("googleusercontent.com/image_generation_content/") !== -1) {
    if (typeof document !== "undefined") {
      try {
        var match = src.match(/image_generation_content\/(\d+)/);
        if (match) {
          var idx = parseInt(match[1], 10);
          var candidateImgs = [];

          var responseContainers = document.querySelectorAll('.model-response, [data-test-id="model-response"], message-content, .response-container, .markdown, [class*="markdown"]');
          if (responseContainers.length > 0) {
            for (var c = 0; c < responseContainers.length; c++) {
              var container = responseContainers[c];
              var imgs = container.querySelectorAll('img');
              for (var i = 0; i < imgs.length; i++) {
                var imgUrl = getRealImgSrc(imgs[i]);
                if (imgUrl && imgUrl.indexOf("image_generation_content") === -1) {
                  if (!isPlatformOrSystemIcon(imgUrl) && imgUrl.indexOf("avatar") === -1 && imgUrl.indexOf("favicon") === -1 && imgUrl.indexOf("photo.jpg") === -1 && imgUrl.indexOf("profile") === -1 && !/=s\d+-c/.test(imgUrl)) {
                    if (candidateImgs.indexOf(imgUrl) === -1) {
                      candidateImgs.push(imgUrl);
                    }
                  }
                }
              }
            }
          }

          if (idx < candidateImgs.length) {
            src = candidateImgs[idx];
          } else {
            var allImgs = document.querySelectorAll('img');
            var docCandidates = [];
            for (var i = 0; i < allImgs.length; i++) {
              var imgUrl = getRealImgSrc(allImgs[i]);
              if (imgUrl && imgUrl.indexOf("image_generation_content") === -1) {
                if (!isPlatformOrSystemIcon(imgUrl) && imgUrl.indexOf("avatar") === -1 && imgUrl.indexOf("favicon") === -1 && imgUrl.indexOf("photo.jpg") === -1 && imgUrl.indexOf("profile") === -1 && !/=s\d+-c/.test(imgUrl)) {
                  if (docCandidates.indexOf(imgUrl) === -1) {
                    docCandidates.push(imgUrl);
                  }
                }
              }
            }

            if (idx < docCandidates.length) {
              src = docCandidates[idx];
            }
          }
        }
      } catch (domErr) {
      }
    }
  }

  if (src.startsWith("data:")) {
    var parsedDataUrl = parseImageDataUrl(src);
    if (!parsedDataUrl) return null;
    var parsedMimeType = detectImageMimeType(parsedDataUrl.bytes, parsedDataUrl.mimeType);
    return parsedMimeType ? { bytes: parsedDataUrl.bytes, mimeType: parsedMimeType } : null;
  }

  if (shouldFetchImageBeforeCorsLoad(src)) {
    var earlyNetworkBytes = await fetchImageBytesViaNetwork(src, options);
    if (earlyNetworkBytes) {
      return earlyNetworkBytes;
    }
  }

  if (typeof document !== "undefined") {
    try {
      var imgEl = null;
      var imgs = document.querySelectorAll("img");

      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        if (img.src === src || img.getAttribute("src") === src || img.getAttribute("data-src") === src) {
          imgEl = img;
          break;
        }
      }

      if (!imgEl) {
        var fileIdMatch = src.match(/\bfile[-_][a-zA-Z0-9]{15,}\b/);
        if (fileIdMatch) {
          var fileId = fileIdMatch[0];
          for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            var imgStr = (img.src || "") + " " + (img.getAttribute("src") || "") + " " + (img.getAttribute("data-src") || "");
            if (imgStr.indexOf(fileId) !== -1) {
              imgEl = img;
              break;
            }
          }
        }
      }

      if (imgEl && imgEl.naturalWidth > 0) {
        var canvas = document.createElement("canvas");
        canvas.width = imgEl.naturalWidth || imgEl.width || 600;
        canvas.height = imgEl.naturalHeight || imgEl.height || 400;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(imgEl, 0, 0);
        var blob = await canvasToBlob(canvas, "image/png", undefined, IMAGE_PRELOAD_CANVAS_TIMEOUT_MS);
        var buffer = await blob.arrayBuffer();
        assertImageByteLength(buffer.byteLength);
        var bytes = new Uint8Array(buffer);
        return {
          bytes: bytes,
          mimeType: "image/png",
          width: imgEl.naturalWidth || imgEl.width || 600,
          height: imgEl.naturalHeight || imgEl.height || 400
        };
      } else {
      }
    } catch (canvasErr) {
    }
  }

  if (typeof document !== "undefined") {
    try {
      var bytesObj = await new Promise(function (resolve, reject) {
        var settled = false;
        var abortListener = null;
        var timeoutId = setTimeout(function () {
          finish(reject, new Error("Image load timed out"));
        }, IMAGE_ELEMENT_LOAD_TIMEOUT_MS);
        function finish(fn, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          if (options && options.signal && abortListener) {
            options.signal.removeEventListener("abort", abortListener);
          }
          fn(value);
        }
        if (options && options.signal) {
          abortListener = function () {
            finish(reject, createAbortError());
          };
          if (options.signal.aborted) {
            finish(reject, createAbortError());
            return;
          }
          options.signal.addEventListener("abort", abortListener, { once: true });
        }
        var img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = function () {
          try {
            var canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || 600;
            canvas.height = img.naturalHeight || 400;
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            canvasToBlob(canvas, "image/png", undefined, IMAGE_PRELOAD_CANVAS_TIMEOUT_MS).then(function (blob) {
              return blob.arrayBuffer();
            }).then(function (buffer) {
              assertImageByteLength(buffer.byteLength);
              finish(resolve, {
                bytes: new Uint8Array(buffer),
                mimeType: "image/png",
                width: img.naturalWidth || 600,
                height: img.naturalHeight || 400
              });
            }).catch(function (error) {
              finish(reject, error);
            });
          } catch (ex) {
            finish(reject, ex);
          }
        };
        img.onerror = function () {
          finish(reject, new Error("Image failed to load via CORS"));
        };
        img.src = src;
      });
      if (bytesObj) {
        return bytesObj;
      }
    } catch (corsErr) {
      if (corsErr && corsErr.name === "AbortError") {
        throw corsErr;
      }
    }
  }

  var networkBytes = await fetchImageBytesViaNetwork(src, options);
  if (networkBytes) {
    return networkBytes;
  }

  return null;
}

export async function preloadImageForDocx(src, index, options) {
  if (!src) return null;
  var bytesInfo = null;
  try {
    bytesInfo = await fetchImageBytes(src, options);
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw error;
    }
    return null;
  }
  if (!bytesInfo) {
    return null;
  }

  var mimeType = bytesInfo.mimeType || "image/png";
  var dims = await new Promise(function (resolve) {
    if (bytesInfo.width && bytesInfo.height) {
      resolve({ width: bytesInfo.width, height: bytesInfo.height });
      return;
    }
    if (typeof Image === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") {
      resolve({ width: 600, height: 400 });
      return;
    }
    var settled = false;
    var timeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve({ width: 600, height: 400 });
    }, 5000);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    }

    var img = new Image();
    var blob = new Blob([bytesInfo.bytes], { type: mimeType });
    var objectUrl = URL.createObjectURL(blob);
    img.onload = function () {
      finish({ width: img.naturalWidth || 600, height: img.naturalHeight || 400 });
      URL.revokeObjectURL(objectUrl);
    };
    img.onerror = function () {
      finish({ width: 600, height: 400 });
      URL.revokeObjectURL(objectUrl);
    };
    img.src = objectUrl;
  });

  var id = index + 1;
  var ext = "png";
  if (mimeType.indexOf("jpeg") !== -1 || mimeType.indexOf("jpg") !== -1) ext = "jpeg";
  else if (mimeType.indexOf("gif") !== -1) ext = "gif";
  else if (mimeType.indexOf("webp") !== -1) ext = "webp";
  return {
    src: src,
    bytes: bytesInfo.bytes,
    mimeType: mimeType,
    ext: ext,
    id: id,
    path: "media/image" + id + "." + ext,
    relId: "rIdImage" + id,
    width: dims.width,
    height: dims.height
  };
}

export async function preloadCanvasImages(messages, options) {
  var imageEntriesByKey = new Map();
  messages.forEach(function (message, msgIdx) {
    (message.contentBlocks || []).forEach(function (block, blockIdx) {
      if (block.type === "image" && block.src) {
        var imageBlock = ensureImageBlockMetadata(block, blockIdx);
        var key = getImageDedupKey(imageBlock) || block.src;
        var entry = imageEntriesByKey.get(key);
        if (!entry) {
          entry = {
            key: key,
            src: block.src,
            aliases: new Set()
          };
          imageEntriesByKey.set(key, entry);
        }
        entry.aliases.add(block.src);
      }
    });
  });

  var cache = {};
  var uniqueImages = Array.from(imageEntriesByKey.values()).filter(function (entry) { return entry.src; });
  if (uniqueImages.length === 0) return cache;

  await mapLimit(uniqueImages, IMAGE_PRELOAD_CONCURRENCY, async function (entry) {
    try {
      var src = entry.src;
      var bytesInfo = await fetchImageBytes(src, options);
      if (!bytesInfo) {
        return;
      }

      var img = await new Promise(function (resolve, reject) {
        if (typeof Image === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") {
          reject(new Error("Image/URL/Blob constructor not found in environment"));
          return;
        }
        var settled = false;
        var timeoutId = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new Error("Image element load timed out"));
        }, 5000);

        function finish(fn, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          fn(value);
        }

        var element = new Image();
        var mime = bytesInfo.mimeType || "image/png";
        var blob = new Blob([bytesInfo.bytes], { type: mime });
        var objectUrl = URL.createObjectURL(blob);

        element.onload = function () {
          finish(resolve, element);
          URL.revokeObjectURL(objectUrl);
        };
        element.onerror = function () {
          finish(reject, new Error("Failed to load image into element"));
          URL.revokeObjectURL(objectUrl);
        };
        element.src = objectUrl;
      });

      var cached = {
        element: img,
        width: img.naturalWidth || 600,
        height: img.naturalHeight || 400
      };
      cache[src] = cached;
      cache[entry.key] = cached;
      entry.aliases.forEach(function (alias) {
        cache[alias] = cached;
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw err;
      }
    }
  });

  return cache;
}

export function calculateWordImageDimensions(naturalWidth, naturalHeight) {
  var widthPx = naturalWidth || 600;
  var heightPx = naturalHeight || 400;
  var maxEmuWidth = 5029200;
  var pixelToEmu = 9525;

  var emuWidth = widthPx * pixelToEmu;
  var emuHeight = heightPx * pixelToEmu;

  if (emuWidth > maxEmuWidth) {
    var ratio = maxEmuWidth / emuWidth;
    emuWidth = maxEmuWidth;
    emuHeight = Math.round(emuHeight * ratio);
  }
  return { cx: emuWidth, cy: emuHeight };
}
