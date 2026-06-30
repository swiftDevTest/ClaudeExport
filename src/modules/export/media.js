import { isSubstantialSvg, convertSvgToDataUrl, mapLimit, yieldToBrowser, notifyProgress, isGoogleUserContentUrl, isGoogleAccountAvatarUrl, isTrustedConversationImageSrc, isPlatformOrSystemIcon, isTestEnv, canvasToBlob, ensureImageBlockMetadata, getImageDedupKey } from './utils.js';

var IMAGE_CACHE_MAX = 50;
var IMAGE_PRELOAD_CANVAS_TIMEOUT_MS = 5000;
var IMAGE_ELEMENT_LOAD_TIMEOUT_MS = 8000;
var _imageBytesCache = new Map();
var _imageBytesInFlight = new Map();
export var imageBytesCache = {
  get: function (key) {
    return _imageBytesCache.get(key);
  },
  set: function (key, value) {
    if (_imageBytesCache.has(key)) _imageBytesCache.delete(key);
    _imageBytesCache.set(key, value);
    while (_imageBytesCache.size > IMAGE_CACHE_MAX) {
      var firstKey = _imageBytesCache.keys().next().value;
      _imageBytesCache.delete(firstKey);
    }
    return _imageBytesCache;
  },
  has: function (key) {
    return _imageBytesCache.has(key);
  },
  get size() {
    return _imageBytesCache.size;
  }
};

function createAbortError() {
  var err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

export var activeAdapters = { current: null };

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

  // Hook in injected imageFetcher adapter if present
  if (activeAdapters && activeAdapters.current && typeof activeAdapters.current.imageFetcher === "function") {
    var customPending = activeAdapters.current.imageFetcher(src, {
      signal: options && options.signal
    }).then(function (result) {
      if (!isTestEnv && result) {
        imageBytesCache.set(src, result);
      }
      return result;
    }).catch(function() {
      return null;
    });
    _imageBytesInFlight.set(src, customPending);
    var result = await customPending;
    _imageBytesInFlight.delete(src);
    return result;
  }

  var pending = _fetchImageBytesDirectly(src, options).then(function (result) {
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
      var arrayBuffer = await response.arrayBuffer();
      var bytes = new Uint8Array(arrayBuffer);
      var mimeType = response.headers.get("content-type") || "image/png";
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
      var messageTimeout = setTimeout(function () {
        reject(new Error("Background fetch timeout"));
      }, 8000);
      chrome.runtime.sendMessage({
        type: "CHATVAULT_FETCH_IMAGE_BYTES",
        url: src
      }, function (reply) {
        clearTimeout(messageTimeout);
        var lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "Background request failed."));
          return;
        }
        resolve(reply);
      });
    });

    if (bgResponse && bgResponse.ok && bgResponse.base64) {
      var binaryStr = atob(bgResponse.base64);
      var bytes = new Uint8Array(binaryStr.length);
      for (var i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      return {
        bytes: bytes,
        mimeType: bgResponse.mimeType || "image/png"
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
    try {
      var parts = src.split(",");
      var meta = parts[0] || "";
      var base64Data = parts[1] || "";
      var mimeType = (meta.split(";")[0] || "").split(":")[1] || "image/png";

      var binaryStr = atob(base64Data);
      var bytes = new Uint8Array(binaryStr.length);
      for (var i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      return { bytes: bytes, mimeType: mimeType };
    } catch (err) {
      return null;
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

  if (shouldFetchImageBeforeCorsLoad(src)) {
    var earlyNetworkBytes = await fetchImageBytesViaNetwork(src, options);
    if (earlyNetworkBytes) {
      return earlyNetworkBytes;
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

export async function preloadImageForDocx(src, index) {
  if (!src) return null;
  var bytesInfo = await fetchImageBytes(src);
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

  await mapLimit(uniqueImages, 5, async function (entry) {
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
