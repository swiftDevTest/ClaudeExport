import { detectPlatform, ensureAllGeminiMessagesLoaded, buildFilename, blobToDataUrl } from './utils.js';
import { resolveMessages, getImageEligibility } from './platform.js';
import { renderWordDocument } from './renderers/word/index.js';
import { renderImageDocument } from './renderers/image/index.js';
import { renderPdfDocument } from './renderers/pdf/index.js';
import { buildMarkdownBlob } from './builders/markdown.js';
import { buildTxtBlob } from './builders/txt.js';
import { buildJsonBlob } from './builders/json.js';
import { buildHtmlBlob } from './builders/html.js';
import { saveBlobWithDialog, saveBlob } from './save.js';

export { saveBlobWithDialog, saveBlob };

var PLATFORM_GEMINI = "gemini";

export async function createExportBlob(request) {
  var format = request && request.format;
  if (!/^(pdf|word|image|markdown|html|txt|json)$/.test(format || "")) {
    return { ok: false, error: "Unsupported export format." };
  }

  if (detectPlatform() === PLATFORM_GEMINI && !(request && Array.isArray(request.messages))) {
    await ensureAllGeminiMessagesLoaded(request);
  }

  var resolved = resolveMessages(request || {});
  if (!resolved.ok) {
    return resolved;
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

    if (format === "word") {
      blob = await renderWordDocument(document, {
        onProgress: request && request.onProgress,
        signal: request && request.signal
      });
    } else if (format === "pdf") {
      blob = await renderPdfDocument(document, {
        onProgress: request && request.onProgress,
        signal: request && request.signal
      });
    } else if (format === "markdown") {
      blob = await buildMarkdownBlob(document.messages, document.metadata, document.settings, {
        signal: request && request.signal,
        onProgress: request && request.onProgress
      });
    } else if (format === "txt") {
      blob = await buildTxtBlob(document.messages, document.metadata, document.settings, {
        signal: request && request.signal,
        onProgress: request && request.onProgress
      });
    } else if (format === "json") {
      blob = await buildJsonBlob(document.messages, document.metadata, document.settings, {
        signal: request && request.signal,
        onProgress: request && request.onProgress
      });
    } else if (format === "html") {
      blob = await buildHtmlBlob(document.messages, document.metadata, document.settings, {
        signal: request && request.signal,
        onProgress: request && request.onProgress
      });
    } else {
      var eligibility = getImageEligibility({ messages: resolved.messages, metadata: resolved.metadata, settings: resolved.settings });
      if (!eligibility.ok) return { ok: false, error: eligibility.reason };
      blob = await renderImageDocument(document, {
        onProgress: request && request.onProgress,
        signal: request && request.signal
      });
    }

    return {
      ok: true,
      blob: blob,
      filename: filename,
      format: format,
      scope: resolved.scope,
      messageCount: resolved.messages.length,
      metadata: resolved.metadata
    };
  } catch (error) {
    return { ok: false, error: error.message || "Export failed." };
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
    if (error && error.name === "AbortError") {
      return { ok: false, cancelled: true };
    }
    return { ok: false, error: error.message || "Export failed." };
  }
}

export async function renderImagePreview(request) {
  if (detectPlatform() === PLATFORM_GEMINI && !(request && Array.isArray(request.messages))) {
    await ensureAllGeminiMessagesLoaded(request);
  }
  var resolved = resolveMessages(request || {});
  if (!resolved.ok) return resolved;
  var eligibility = getImageEligibility({ messages: resolved.messages });
  if (!eligibility.ok) return { ok: false, error: eligibility.reason };
  if (eligibility.requiresMultipage) {
    return { ok: false, error: "Preview is not available for very long image exports." };
  }
  var blob = await renderImageDocument(resolved.document || {
    metadata: resolved.metadata,
    messages: resolved.messages,
    settings: resolved.settings,
    scope: resolved.scope
  }, { preview: true });
  return { ok: true, dataUrl: await blobToDataUrl(blob), charCount: eligibility.charCount };
}
