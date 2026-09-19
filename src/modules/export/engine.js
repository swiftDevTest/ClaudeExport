import { detectPlatform, ensureAllGeminiMessagesLoaded, buildFilename, blobToDataUrl } from './utils.js';
import { resolveMessages, getImageEligibility } from './platform.js';
import { saveBlobWithDialog, saveBlob } from './save.js';
import { imageBytesCache } from './media.js';

export { saveBlobWithDialog, saveBlob };

var PLATFORM_GEMINI = "gemini";
var formatModules = new Map();

function isTransientModuleLoadError(error) {
  return /failed to fetch dynamically imported module|importing a module script failed/i.test(String(error && error.message || error || ""));
}

async function loadFormatModule(format) {
  if (formatModules.has(format)) return formatModules.get(format);
  var loaders = {
    word: function () { return import('./renderers/word/index.js'); },
    pdf: function () { return import('./renderers/pdf/index.js'); },
    image: function () { return import('./renderers/image/index.js'); },
    markdown: function () { return import('./builders/markdown.js'); },
    html: function () { return import('./builders/html.js'); },
    txt: function () { return import('./builders/txt.js'); },
    json: function () { return import('./builders/json.js'); }
  };
  var loader = loaders[format];
  if (!loader) throw new Error("Unsupported export format.");
  var pending = (async function () {
    for (var attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await loader();
      } catch (error) {
        if (!isTransientModuleLoadError(error) || attempt === 1) throw error;
        await new Promise(function (resolve) { setTimeout(resolve, 180); });
      }
    }
  })();
  formatModules.set(format, pending);
  try {
    return await pending;
  } catch (error) {
    formatModules.delete(format);
    throw error;
  }
}

function countListItems(items, depth, stats) {
  (items || []).forEach(function (item) {
    stats.count += 1;
    stats.depth = Math.max(stats.depth, depth);
    countListItems(item && item.subItems, depth + 1, stats);
  });
}

function collectPreflightDiagnostics(document, format) {
  var diagnostics = [];
  var imageCount = 0;
  var largeMarkdownDataImages = 0;
  var longMath = 0;
  var listStats = { count: 0, depth: 0 };
  (document && document.messages || []).forEach(function (message) {
    (message && message.contentBlocks || []).forEach(function (block) {
      if (!block) return;
      if (block.type === "image") {
        imageCount += 1;
        if (format === "markdown" && /^data:image\//i.test(String(block.src || "")) && String(block.src || "").length > 512 * 1024) {
          largeMarkdownDataImages += 1;
        }
      }
      if (block.type === "math" && block.truncated) longMath += 1;
      if (block.type === "list") {
        countListItems(block.items, 1, listStats);
        if (block.truncated) listStats.truncated = true;
      }
    });
  });
  if ((format === "pdf" || format === "image" || format === "word") && imageCount > 50) {
    diagnostics.push({
      code: "IMAGE_COUNT_LIMIT",
      message: imageCount + " images were found; this format can embed up to 50 images safely, so later images may use placeholders.",
      count: imageCount - 50,
      format: format
    });
  }
  if (largeMarkdownDataImages) {
    diagnostics.push({
      code: "MARKDOWN_DATA_IMAGE_LIMIT",
      message: largeMarkdownDataImages + " embedded image(s) exceed the portable Markdown size limit and will be represented as placeholders.",
      count: largeMarkdownDataImages,
      format: format
    });
  }
  if (longMath) {
    diagnostics.push({
      code: "MATH_SOURCE_TRUNCATED",
      message: longMath + " formula(s) exceed the 8,000-character safety limit and were truncated during normalization.",
      count: longMath,
      format: format
    });
  }
  if (listStats.truncated || listStats.count > 2000 || listStats.depth > 32) {
    diagnostics.push({
      code: "LIST_STRUCTURE_LIMIT",
      message: "A list exceeds the portable export limit of 2,000 items or 32 nesting levels and may be truncated.",
      count: 1,
      format: format
    });
  }
  return diagnostics;
}

function appendDiagnostic(target, diagnostic) {
  if (!diagnostic || !diagnostic.code) return;
  var code = String(diagnostic.code);
  var existing = target.find(function (item) { return item.code === code && item.message === diagnostic.message; });
  if (existing) {
    existing.count += Math.max(1, Number(diagnostic.count) || 1);
    return;
  }
  target.push({
    level: diagnostic.level === "error" ? "error" : "warning",
    code: code,
    message: String(diagnostic.message || "Some export content was degraded."),
    count: Math.max(1, Number(diagnostic.count) || 1),
    format: diagnostic.format || undefined
  });
}

function structuredFailure(error, phase, fallbackMessage) {
  var source = error instanceof Error
    ? error
    : Object.assign(new Error(error && error.error || fallbackMessage || "Export failed."), error || {});
  var protocol = typeof globalThis !== "undefined" ? globalThis.CHATVAULT_EXPORT_ERRORS : null;
  var details = protocol && typeof protocol.serialize === "function"
    ? protocol.serialize(source, { phase: phase })
    : { error_code: source.code || "UNKNOWN_ERROR", error_phase: phase, retryable: true };
  return {
    ok: false,
    error: source.message || fallbackMessage || "Export failed.",
    code: details.error_code,
    ...details
  };
}

export async function createExportBlob(request) {
  var format = request && request.format;
  if (!/^(pdf|word|image|markdown|html|txt|json)$/.test(format || "")) {
    return structuredFailure({ code: "RENDER_FAILED", error: "Unsupported export format." }, "render");
  }

  if (detectPlatform() === PLATFORM_GEMINI && !(request && Array.isArray(request.messages))) {
    await ensureAllGeminiMessagesLoaded({ ...request, signal: request && request.signal });
  }

  var resolved = resolveMessages(request || {});
  if (!resolved.ok) {
    return structuredFailure(resolved, "parse", resolved.error || "Conversation content could not be parsed.");
  }
  try {
    var filename = buildFilename(format, resolved.scope, resolved.metadata);
    var blob = null;
    var document = resolved.document || {
      metadata: resolved.metadata,
      messages: resolved.messages,
      settings: resolved.settings,
      scope: resolved.scope
    };
    var diagnostics = collectPreflightDiagnostics(document, format);
    var renderOptions = {
      onProgress: request && request.onProgress,
      signal: request && request.signal,
      onDiagnostic: function (diagnostic) { appendDiagnostic(diagnostics, diagnostic); }
    };

    if (format === "word") {
      blob = await (await loadFormatModule("word")).renderWordDocument(document, renderOptions);
    } else if (format === "pdf") {
      blob = await (await loadFormatModule("pdf")).renderPdfDocument(document, renderOptions);
    } else if (format === "markdown") {
      blob = await (await loadFormatModule("markdown")).buildMarkdownBlob(document.messages, document.metadata, document.settings, renderOptions);
    } else if (format === "txt") {
      blob = await (await loadFormatModule("txt")).buildTxtBlob(document.messages, document.metadata, document.settings, renderOptions);
    } else if (format === "json") {
      blob = await (await loadFormatModule("json")).buildJsonBlob(document.messages, document.metadata, document.settings, renderOptions);
    } else if (format === "html") {
      blob = await (await loadFormatModule("html")).buildHtmlBlob(document.messages, document.metadata, document.settings, renderOptions);
    } else {
      var eligibility = getImageEligibility({ messages: resolved.messages, metadata: resolved.metadata, settings: resolved.settings });
      if (!eligibility.ok) return { ok: false, error: eligibility.reason, code: eligibility.code || "IMAGE_CANVAS_LIMIT_EXCEEDED" };
      blob = await (await loadFormatModule("image")).renderImageDocument(document, renderOptions);
    }

    return {
      ok: true,
      blob: blob,
      filename: filename,
      format: format,
      scope: resolved.scope,
      messageCount: resolved.messages.length,
      metadata: resolved.metadata,
      diagnostics: diagnostics
    };
  } catch (error) {
    // 保留 AbortError 语义，让 startExport 能识别取消而非失败
    if (error && error.name === "AbortError") {
      return { ok: false, cancelled: true, code: "EXPORT_CANCELLED", error_code: "EXPORT_CANCELLED", error_phase: "render", retryable: true };
    }
    return structuredFailure(error, "render", "Export failed.");
  } finally {
    // Cached image bytes are useful only within one export operation. Keeping
    // up to 24 MiB alive across later exports increases popup/page memory peaks.
    imageBytesCache.clear();
  }
}

export async function startExport(request) {
  try {
    var prepared = await createExportBlob(request || {});
    if (!prepared.ok) return prepared;

    var filename = prepared.filename;
    var blob = prepared.blob;
    var savedName = await saveBlobWithDialog(blob, filename, request && request.options);
    return {
      ok: true,
      filename: savedName || filename,
      format: prepared.format,
      scope: prepared.scope,
      messageCount: prepared.messageCount
    };
  } catch (error) {
    // createExportBlob 已经捕获 AbortError 并返回 cancelled:true，此处兜底处理 saveBlobWithDialog 抛出的 AbortError

    if (error && error.name === "AbortError") {
      return { ok: false, cancelled: true, code: "SAVE_CANCELLED", error_code: "SAVE_CANCELLED", error_phase: "save", retryable: true };
    }
    return structuredFailure(error, "save", "Export failed.");
  }
}

export async function renderImagePreview(request) {
  try {
    if (detectPlatform() === PLATFORM_GEMINI && !(request && Array.isArray(request.messages))) {
      await ensureAllGeminiMessagesLoaded({ ...request, signal: request && request.signal });
    }
    var resolved = resolveMessages(request || {});
    if (!resolved.ok) return resolved;
    var eligibility = getImageEligibility({ messages: resolved.messages });
    if (!eligibility.ok) return { ok: false, error: eligibility.reason };
    if (eligibility.requiresMultipage) {
      return { ok: false, error: "Preview is not available for very long image exports." };
    }
    var blob = await (await loadFormatModule("image")).renderImageDocument(resolved.document || {
      metadata: resolved.metadata,
      messages: resolved.messages,
      settings: resolved.settings,
      scope: resolved.scope
    }, { preview: true });
    return { ok: true, dataUrl: await blobToDataUrl(blob), charCount: eligibility.charCount };
  } finally {
    imageBytesCache.clear();
  }
}
