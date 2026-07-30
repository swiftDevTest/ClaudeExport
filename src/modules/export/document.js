import {
  normalizeExportSettings,
  sanitizeExportText,
  sanitizeInlineSegmentText,
  sanitizeImageAlt,
  sanitizeExportMathMl,
  normalizeExportLinkHref,
  normalizeGeneratedFileHref,
  getGeneratedFileNameFromHref,
  ensureImageBlockMetadata,
  dedupeImageBlocksWithinMessage,
  getBlockText,
  shouldCoalesceInlineSegments,
  getCoalescedInlineSegmentsText,
  overlayCoalescedInlineLinks,
  isDalleMetadataText,
  isGeminiImagePlaceholderText
} from './utils.js';
import { captureExportHtmlStyle, sanitizeExportHtmlStyle } from './html-style.js';

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
  if (role === "system") return "system";
  return role === "user" ? "user" : "assistant";
}

function normalizeExportHref(value) {
  return normalizeExportLinkHref(value);
}

function normalizeGeneratedFileEntry(value) {
  if (!value || typeof value !== "object") return null;
  var source = normalizeGeneratedFileHref(value.source || value.href || value.url);
  if (!source) return null;
  var href = normalizeExportHref(value.href || value.downloadUrl || value.download_url);
  var name = sanitizeExportText(value.name || "");
  var rawName = sanitizeExportText(value.rawName || "");
  return {
    name: name || getGeneratedFileNameFromHref(source) || rawName || source.split("/").pop() || "Generated file",
    rawName: rawName || name,
    source: source,
    ...(href ? { href: href } : {})
  };
}

function normalizeGeneratedFileEntries(block) {
  var entries = [];
  if (block && block.generatedFile) entries.push(block.generatedFile);
  if (block && Array.isArray(block.generatedFiles)) entries.push.apply(entries, block.generatedFiles);
  if (block && Array.isArray(block.segments)) {
    block.segments.forEach(function (segment) {
      var source = normalizeGeneratedFileHref(segment && (segment.href || segment.url));
      if (!source) return;
      var name = getGeneratedFileNameFromHref(source);
      entries.push({ name: name, rawName: source.split("/").pop() || name, source: source });
    });
  }
  return entries.map(normalizeGeneratedFileEntry).filter(Boolean).filter(function (entry, index, all) {
    return all.findIndex(function (candidate) { return candidate.source === entry.source; }) === index;
  });
}

function makeGeneratedFileSegmentsPortable(messages) {
  function normalizeSegments(segments, generatedFiles) {
    (Array.isArray(segments) ? segments : []).forEach(function (segment) {
      var source = normalizeGeneratedFileHref(segment && (segment.href || segment.url));
      if (!source) return;
      var match = (generatedFiles || []).find(function (entry) {
        return entry && entry.source === source && entry.href;
      });
      var portableHref = normalizeExportHref(match && match.href);
      if (portableHref) segment.href = portableHref;
      else delete segment.href;
      delete segment.url;
    });
  }
  function normalizeItems(items) {
    (Array.isArray(items) ? items : []).forEach(function (item) {
      normalizeSegments(item && item.segments, normalizeGeneratedFileEntries(item));
      normalizeItems(item && item.subItems);
    });
  }
  (Array.isArray(messages) ? messages : []).forEach(function (message) {
    (message && message.contentBlocks || []).forEach(function (block) {
      normalizeSegments(block && block.segments, normalizeGeneratedFileEntries(block));
      if (block && block.type === "list") normalizeItems(block.items);
    });
  });
  return messages;
}

function collapseGeneratedFileMarkdownWrappers(segments) {
  var source = (Array.isArray(segments) ? segments : []).map(function (segment) {
    return segment && typeof segment === "object" ? { ...segment } : { text: String(segment || "") };
  });
  var wrappers = [
    { marker: "**", mark: "bold" },
    { marker: "__", mark: "bold" },
    { marker: "~~", mark: "strike" },
    { marker: "==", mark: "highlight" },
    { marker: "*", mark: "italic" },
    { marker: "_", mark: "italic" }
  ];

  for (var index = 0; index < source.length; index += 1) {
    var segment = source[index];
    if (!normalizeGeneratedFileHref(segment && (segment.href || segment.url))) continue;
    var marks = segment.marks && typeof segment.marks === "object" ? { ...segment.marks } : {};
    wrappers.some(function (wrapper) {
      var text = String(segment.text || "");
      if (text.startsWith(wrapper.marker) && text.endsWith(wrapper.marker) && text.length > wrapper.marker.length * 2) {
        segment.text = text.slice(wrapper.marker.length, -wrapper.marker.length);
        marks[wrapper.mark] = true;
        return true;
      }
      var previous = source[index - 1];
      var next = source[index + 1];
      var previousText = String(previous && previous.text || "");
      var nextText = String(next && next.text || "");
      var openingIndex = previousText.lastIndexOf(wrapper.marker);
      if (!previous || !next || openingIndex < 0 || !nextText.startsWith(wrapper.marker)) return false;
      var wrappedPrefix = previousText.slice(openingIndex + wrapper.marker.length);
      previous.text = previousText.slice(0, openingIndex);
      if (wrappedPrefix) {
        var prefixMarks = previous.marks && typeof previous.marks === "object" ? { ...previous.marks } : {};
        prefixMarks[wrapper.mark] = true;
        source.splice(index, 0, { text: wrappedPrefix, marks: prefixMarks });
        index += 1;
        segment = source[index];
        next = source[index + 1];
        nextText = String(next && next.text || "");
      }
      next.text = nextText.slice(wrapper.marker.length);
      marks[wrapper.mark] = true;
      return true;
    });
    if (Object.keys(marks).length) segment.marks = marks;
  }
  return source.filter(function (segment) { return String(segment && segment.text || "") !== ""; });
}

export function normalizeInlineSegments(segments, fallbackText, options) {
  if (!Array.isArray(segments)) {
    return undefined;
  }
  segments = collapseGeneratedFileMarkdownWrappers(segments);
  if (shouldCoalesceInlineSegments(segments)) {
    var coalesced = getCoalescedInlineSegmentsText(segments, fallbackText);
    segments = coalesced ? overlayCoalescedInlineLinks(coalesced, segments) : [];
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
    var rawHref = segment.href || segment.url;
    var href = normalizeExportHref(rawHref);
    if (!href && options && options.allowGeneratedFileLinks) {
      var generatedSource = normalizeGeneratedFileHref(rawHref);
      var generatedEntry = (options.generatedFileEntries || []).find(function (entry) {
        return entry && entry.source === generatedSource;
      });
      href = normalizeExportHref(generatedEntry && generatedEntry.href) || generatedSource;
      if (generatedSource) {
        var rawName = generatedSource.replace(/^sandbox:\/mnt\/data\//i, "").split(/[?#]/)[0];
        var decodedName = getGeneratedFileNameFromHref(generatedSource);
        if (rawName && decodedName && rawName !== decodedName) text = text.split(rawName).join(decodedName);
      }
    }
    out.text = text;
    if (href) out.href = href;
    var normalizedMarks = {};
    if (segment.bold || marks.bold) normalizedMarks.bold = true;
    if (segment.italic || marks.italic) normalizedMarks.italic = true;
    if (segment.code || marks.code) normalizedMarks.code = true;
    if (segment.strike || marks.strike) normalizedMarks.strike = true;
    if (segment.superscript || marks.superscript) normalizedMarks.superscript = true;
    if (segment.subscript || marks.subscript) normalizedMarks.subscript = true;
    if (segment.highlight || marks.highlight) normalizedMarks.highlight = true;
    if (segment.underline || marks.underline) normalizedMarks.underline = true;
    if (segment.math || marks.math) normalizedMarks.math = true;
    if (Object.keys(normalizedMarks).length) out.marks = normalizedMarks;
    if (normalizedMarks.math && segment.mathMl) {
      var mathMl = sanitizeExportMathMl(segment.mathMl);
      if (mathMl) out.mathMl = mathMl;
    }
    var htmlStyle = sanitizeExportHtmlStyle(segment.htmlStyle);
    if (htmlStyle) out.htmlStyle = htmlStyle;
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
  if (copy.textSource !== "dom") delete copy.textSource;
  copy.text = type === "code"
    ? String(copy.text == null ? "" : copy.text).replace(/\u00a0/g, " ").trim()
    : sanitizeExportText(copy.text);
  var generatedFiles = normalizeGeneratedFileEntries(copy);
  if (generatedFiles.length) {
    copy.generatedFile = generatedFiles[0];
    if (generatedFiles.length > 1) copy.generatedFiles = generatedFiles;
    else delete copy.generatedFiles;
  } else {
    delete copy.generatedFile;
    delete copy.generatedFiles;
  }
  var segments = normalizeInlineSegments(copy.segments, copy.text, {
    allowGeneratedFileLinks: generatedFiles.length > 0,
    generatedFileEntries: generatedFiles
  });
  if (segments) {
    copy.segments = segments;
    if (generatedFiles.length) copy.text = segments.map(function (segment) { return segment.text || ""; }).join("");
  }
  var htmlStyle = sanitizeExportHtmlStyle(copy.htmlStyle);
  if (htmlStyle) copy.htmlStyle = htmlStyle;
  else delete copy.htmlStyle;
  if (type === "code") {
    var codeStyle = sanitizeExportHtmlStyle(copy.codeStyle);
    if (codeStyle) copy.codeStyle = codeStyle;
    else delete copy.codeStyle;
    var codeSegments = Array.isArray(copy.codeSegments) ? copy.codeSegments.map(function (segment) {
      if (!segment || typeof segment !== "object") return null;
      var text = String(segment.text == null ? "" : segment.text).replace(/\u00a0/g, " ");
      if (!text) return null;
      var out = { text: text };
      var segmentStyle = sanitizeExportHtmlStyle(segment.htmlStyle);
      if (segmentStyle) out.htmlStyle = segmentStyle;
      return out;
    }).filter(Boolean) : [];
    if (codeSegments.length && codeSegments.map(function (segment) { return segment.text; }).join("") === copy.text) {
      copy.codeSegments = codeSegments;
    } else {
      delete copy.codeSegments;
    }
  }
  if (type === "heading") {
    var level = Number(copy.level);
    copy.level = Number.isFinite(level) ? Math.min(6, Math.max(1, Math.round(level))) : 2;
  }
  copy.originalIndex = Number.isFinite(Number(copy.originalIndex))
    ? Number(copy.originalIndex)
    : Number(index);
  return copy;
}

var EXPORT_LIST_MAX_DEPTH = 32;
var EXPORT_LIST_MAX_ITEMS = 2000;

function normalizeListItems(items, depth, budget) {
  var currentDepth = Number.isFinite(Number(depth)) ? Number(depth) : 0;
  var remaining = budget || { value: EXPORT_LIST_MAX_ITEMS };
  if (currentDepth >= EXPORT_LIST_MAX_DEPTH || remaining.value <= 0) return [];
  return (items || []).map(function (item) {
    if (remaining.value <= 0) return null;
    remaining.value -= 1;
    if (typeof item === "string") item = { text: item };
    if (!item || typeof item !== "object") return null;
    var text = sanitizeExportText(item.text);
    var subItems = normalizeListItems(item.subItems, currentDepth + 1, remaining);
    if (!text && !subItems.length) return null;
    var out = {
      text: text,
      subItems: subItems
    };
    if (item.textSource === "dom") out.textSource = "dom";
    var generatedFiles = normalizeGeneratedFileEntries(item);
    if (generatedFiles.length) {
      out.generatedFile = generatedFiles[0];
      if (generatedFiles.length > 1) out.generatedFiles = generatedFiles;
    }
    var segments = normalizeInlineSegments(item.segments, text, {
      allowGeneratedFileLinks: generatedFiles.length > 0,
      generatedFileEntries: generatedFiles
    });
    if (segments) {
      out.segments = segments;
      if (generatedFiles.length) out.text = segments.map(function (segment) { return segment.text || ""; }).join("");
    }
    if (typeof item.subItemsOrdered === "boolean") out.subItemsOrdered = item.subItemsOrdered;
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
    if (listBlock.textSource !== "dom") delete listBlock.textSource;
    var listHtmlStyle = sanitizeExportHtmlStyle(block.htmlStyle);
    if (listHtmlStyle) listBlock.htmlStyle = listHtmlStyle;
    return listBlock.items.length ? listBlock : null;
  }

  if (type === "table") {
    var tableBlock = {
      ...block,
      type: "table",
      headers: normalizeTableRows([block.headers || []])[0] || [],
      rows: normalizeTableRows(block.rows)
    };
    if (tableBlock.textSource !== "dom") delete tableBlock.textSource;
    var tableHtmlStyle = sanitizeExportHtmlStyle(block.htmlStyle);
    if (tableHtmlStyle) tableBlock.htmlStyle = tableHtmlStyle;
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
    var separator = { type: "separator" };
    var separatorHtmlStyle = sanitizeExportHtmlStyle(block.htmlStyle);
    if (separatorHtmlStyle) separator.htmlStyle = separatorHtmlStyle;
    return separator;
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
  var messageHtmlStyle = sanitizeExportHtmlStyle(message.htmlStyle) || captureExportHtmlStyle(message.contentElement);
  if (messageHtmlStyle) out.htmlStyle = messageHtmlStyle;
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
  // 优化：如果输入已经是 ExportDocument（带 _normalized 标记），messages 已归一化，
  // 跳过 normalizeExportMessages 避免重复 sanitize/segments 处理。
  // coerceExportDocument 传入已归一化的 document 时会走这条快路径。
  var alreadyNormalized = Boolean(source._normalized) && Array.isArray(source.messages);
  var messages = alreadyNormalized ? source.messages : normalizeExportMessages(source.messages);
  var metadata = {
    platform: source.platform || metadataInput.platform || "",
    title: metadataInput.title || source.title || "Untitled Chat",
    sourceUrl: metadataInput.sourceUrl || source.sourceUrl || "",
    exportedAt: normalizeExportDate(metadataInput.exportedAt || source.exportedAt),
    scope: scope
  };
  if (!alreadyNormalized) makeGeneratedFileSegmentsPortable(messages);

  return {
    version: EXPORT_DOCUMENT_VERSION,
    metadata: metadata,
    settings: settings,
    scope: scope,
    messages: messages,
    contentBlocks: alreadyNormalized ? source.contentBlocks : flattenDocumentContentBlocks(messages),
    _normalized: true
  };
}

export function coerceExportDocument(documentOrMessages, metadata, settings) {
  if (documentOrMessages && typeof documentOrMessages === "object" && Array.isArray(documentOrMessages.messages)) {
    // 已是 ExportDocument：若带 _normalized 标记则直接返回，避免重新归一化。
    if (documentOrMessages._normalized) return documentOrMessages;
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
      if (!message || (message.role !== "user" && message.role !== "assistant" && message.role !== "system")) {
        errors.push("messages[" + messageIndex + "].role must be user, assistant, or system.");
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
