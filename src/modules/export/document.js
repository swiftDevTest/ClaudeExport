import {
  normalizeExportSettings,
  sanitizeExportText,
  sanitizeInlineSegmentText,
  sanitizeImageAlt,
  normalizeExportLinkHref,
  ensureImageBlockMetadata,
  dedupeImageBlocksWithinMessage,
  getBlockText,
  shouldCoalesceInlineSegments,
  getCoalescedInlineSegmentsText,
  isDalleMetadataText,
  isGeminiImagePlaceholderText
} from './utils.js';

export var EXPORT_DOCUMENT_VERSION = 1;
export var EXPORT_BLOCK_TYPES = {
  paragraph: true,
  heading: true,
  code: true,
  list: true,
  blockquote: true,
  table: true,
  image: true,
  separator: true
};

function normalizeExportDate(value) {
  if (value instanceof Date) return value;
  if (value) {
    var parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function normalizeExportRole(role) {
  return role === "user" ? "user" : "assistant";
}

function normalizeExportHref(value) {
  return normalizeExportLinkHref(value);
}

export function normalizeInlineSegments(segments, fallbackText) {
  if (!Array.isArray(segments)) {
    return undefined;
  }
  if (shouldCoalesceInlineSegments(segments)) {
    var coalesced = getCoalescedInlineSegmentsText(segments, fallbackText);
    return coalesced ? [{ text: coalesced }] : undefined;
  }
  var normalized = segments.map(function (segment) {
    if (typeof segment === "string") {
      segment = { text: segment };
    }
    if (!segment || typeof segment !== "object") return null;
    var marks = segment.marks && typeof segment.marks === "object" ? segment.marks : {};
    var text = sanitizeInlineSegmentText(segment.text);
    if (text === "") return null;
    var out = {
      text: text
    };
    var href = normalizeExportHref(segment.href || segment.url);
    if (href) out.href = href;
    var normalizedMarks = {};
    if (segment.bold || marks.bold) normalizedMarks.bold = true;
    if (segment.italic || marks.italic) normalizedMarks.italic = true;
    if (segment.code || marks.code) normalizedMarks.code = true;
    if (Object.keys(normalizedMarks).length) out.marks = normalizedMarks;
    return out;
  }).filter(Boolean);

  var fallback = sanitizeExportText(fallbackText);
  if (!normalized.length && fallback) {
    return [{ text: fallback }];
  }
  return normalized.length ? normalized : undefined;
}

function copyTextBlock(block, type, index) {
  var copy = { ...block, type: type };
  copy.text = sanitizeExportText(copy.text);
  var segments = normalizeInlineSegments(copy.segments, copy.text);
  if (segments) copy.segments = segments;
  if (type === "heading") {
    var level = Number(copy.level);
    copy.level = Number.isFinite(level) ? Math.min(4, Math.max(1, Math.round(level))) : 2;
  }
  copy.originalIndex = Number.isFinite(Number(copy.originalIndex))
    ? Number(copy.originalIndex)
    : Number(index);
  return copy;
}

function normalizeListItems(items) {
  return (items || []).map(function (item) {
    if (typeof item === "string") item = { text: item };
    if (!item || typeof item !== "object") return null;
    var text = sanitizeExportText(item.text);
    var subItems = normalizeListItems(item.subItems);
    if (!text && !subItems.length) return null;
    var out = {
      text: text,
      subItems: subItems
    };
    var segments = normalizeInlineSegments(item.segments, text);
    if (segments) out.segments = segments;
    return out;
  }).filter(Boolean);
}

function normalizeTableRows(rows) {
  return (rows || []).map(function (row) {
    return (row || []).map(function (cell) {
      return sanitizeExportText(cell);
    });
  }).filter(function (row) {
    return row.some(Boolean);
  });
}

export function normalizeExportBlock(block, index) {
  if (!block || typeof block !== "object") return null;
  var type = EXPORT_BLOCK_TYPES[block.type] ? block.type : "";
  if (!type) {
    if (block.src) type = "image";
    else if (block.text) type = "paragraph";
    else return null;
  }

  if (type === "paragraph" || type === "heading" || type === "code" || type === "blockquote") {
    var textBlock = copyTextBlock(block, type, index);
    var text = getBlockText(textBlock);
    return text && !isDalleMetadataText(text) && !isGeminiImagePlaceholderText(text)
      ? textBlock
      : null;
  }

  if (type === "list") {
    var listBlock = {
      ...block,
      type: "list",
      ordered: Boolean(block.ordered),
      items: normalizeListItems(block.items)
    };
    return listBlock.items.length ? listBlock : null;
  }

  if (type === "table") {
    var tableBlock = {
      ...block,
      type: "table",
      headers: normalizeTableRows([block.headers || []])[0] || [],
      rows: normalizeTableRows(block.rows)
    };
    return tableBlock.headers.length || tableBlock.rows.length ? tableBlock : null;
  }

  if (type === "image") {
    var imageBlock = ensureImageBlockMetadata({
      ...block,
      type: "image",
      alt: sanitizeImageAlt(block.alt),
      src: String(block.src || "")
    }, index);
    return imageBlock.src || imageBlock.normalizedSrc || imageBlock.sourceKind === "fallback"
      ? imageBlock
      : null;
  }

  if (type === "separator") {
    return { type: "separator" };
  }

  return null;
}

export function normalizeExportBlocks(blocks) {
  return dedupeImageBlocksWithinMessage((blocks || []).map(normalizeExportBlock).filter(Boolean));
}

export function normalizeExportMessage(message, index) {
  if (!message || typeof message !== "object") return null;
  var role = normalizeExportRole(message.role);
  var contentBlocks = normalizeExportBlocks(message.contentBlocks);
  if (!contentBlocks.length) return null;
  var out = {
    role: role,
    contentBlocks: contentBlocks
  };
  if (Number.isFinite(Number(message.index))) {
    out.index = Number(message.index);
  } else if (Number.isFinite(Number(index))) {
    out.index = Number(index);
  }
  return out;
}

export function normalizeExportMessages(messages) {
  return (messages || []).map(normalizeExportMessage).filter(Boolean);
}

export function flattenDocumentContentBlocks(messages) {
  var blocks = [];
  (messages || []).forEach(function (message, messageIndex) {
    (message.contentBlocks || []).forEach(function (block) {
      blocks.push({
        ...block,
        role: message.role,
        messageIndex: messageIndex
      });
    });
  });
  return blocks;
}

export function createExportDocument(input) {
  var source = input || {};
  var metadataInput = source.metadata || {};
  var settings = normalizeExportSettings(source.settings);
  var scope = source.scope || metadataInput.scope || (settings.export_ai_replies_only ? "ai_only" : "conversation");
  var messages = normalizeExportMessages(source.messages);
  var metadata = {
    platform: source.platform || metadataInput.platform || "",
    title: metadataInput.title || source.title || "Untitled Chat",
    sourceUrl: metadataInput.sourceUrl || source.sourceUrl || "",
    exportedAt: normalizeExportDate(metadataInput.exportedAt || source.exportedAt),
    scope: scope
  };

  return {
    version: EXPORT_DOCUMENT_VERSION,
    metadata: metadata,
    settings: settings,
    scope: scope,
    messages: messages,
    contentBlocks: flattenDocumentContentBlocks(messages)
  };
}

export function coerceExportDocument(documentOrMessages, metadata, settings) {
  if (documentOrMessages && typeof documentOrMessages === "object" && Array.isArray(documentOrMessages.messages)) {
    return createExportDocument(documentOrMessages);
  }
  return createExportDocument({
    messages: Array.isArray(documentOrMessages) ? documentOrMessages : [],
    metadata: metadata || {},
    settings: settings || {}
  });
}

export function validateExportDocument(document) {
  var errors = [];
  if (!document || typeof document !== "object") {
    return { ok: false, errors: ["ExportDocument must be an object."] };
  }
  if (!document.metadata || typeof document.metadata !== "object") {
    errors.push("metadata is required.");
  }
  if (!Array.isArray(document.messages)) {
    errors.push("messages must be an array.");
  } else {
    document.messages.forEach(function (message, messageIndex) {
      if (!message || (message.role !== "user" && message.role !== "assistant")) {
        errors.push("messages[" + messageIndex + "].role must be user or assistant.");
      }
      if (!Array.isArray(message && message.contentBlocks)) {
        errors.push("messages[" + messageIndex + "].contentBlocks must be an array.");
      }
      (message && message.contentBlocks || []).forEach(function (block, blockIndex) {
        if (!block || !EXPORT_BLOCK_TYPES[block.type]) {
          errors.push("messages[" + messageIndex + "].contentBlocks[" + blockIndex + "] has an unsupported type.");
        }
      });
    });
  }
  return { ok: errors.length === 0, errors: errors };
}
