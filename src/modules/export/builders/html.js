import {
  blobToDataUrl,
  formatDateDisplay,
  formatLatexUnicode,
  getExportFooterSegments,
  mapLimit,
  notifyProgress,
  sanitizeExportText,
  sanitizeExportMathMl,
  sanitizeImageAlt,
  sanitizeInlineSegmentText,
  shouldCoalesceInlineSegments,
  getCoalescedInlineSegmentsText,
  t,
  yieldToBrowser
} from '../utils.js';
import { fetchImageBytes } from '../media.js';
import { getExportTheme } from '../themes/tokens.js';
import { isTransparentCssColor, serializeExportHtmlStyle } from '../html-style.js';

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(value) {
  var href = String(value || "").trim();
  if (!href) return "";
  try {
    var parsed = new URL(href);
    return /^(https?:|mailto:)$/.test(parsed.protocol) ? parsed.href : "";
  } catch (error) {
    return "";
  }
}

function styleAttribute(style) {
  var serialized = serializeExportHtmlStyle(style);
  return serialized ? ' style="' + escapeHtml(serialized) + '"' : "";
}

function messageStyleAttribute(style, flat) {
  if (!flat) return styleAttribute(style);
  var copy = style && typeof style === "object" ? { ...style } : null;
  if (!copy) return "";
  [
    "background", "background-color", "background-image", "border", "border-top",
    "border-right", "border-bottom", "border-left", "border-color", "border-radius",
    "box-shadow", "margin", "padding", "width", "max-width"
  ].forEach(function (property) { delete copy[property]; });
  return styleAttribute(copy);
}

function codeBlockStyleAttribute(style) {
  var copy = style && typeof style === "object" ? { ...style } : style;
  if (copy && isTransparentCssColor(copy["background-color"])) {
    delete copy["background-color"];
  }
  return styleAttribute(copy);
}

function blockquoteStyleAttribute(style) {
  var copy = style && typeof style === "object" ? { ...style } : style;
  if (copy) {
    var borderLeft = String(copy["border-left"] || "").trim();
    var zeroBorder = borderLeft.match(/^0(?:\.0+)?(?:px|pt|em|rem)?\s+(?:solid|dashed|dotted|double)\s+(.+)$/i);
    if (zeroBorder && !isTransparentCssColor(zeroBorder[1])) {
      copy["border-left"] = "4px solid " + zeroBorder[1].trim();
    } else if (/^0(?:\.0+)?(?:px|pt|em|rem)?(?:\s|$)/i.test(borderLeft)) {
      delete copy["border-left"];
    }
  }
  return styleAttribute(copy);
}

function renderEscapedInlineText(value) {
  return escapeHtml(formatLatexUnicode(String(value == null ? "" : value))).replace(/\n/g, "<br>");
}

function renderLiteralInlineText(value) {
  return escapeHtml(String(value == null ? "" : value)).replace(/\n/g, "<br>");
}

function renderInlineMarkdownSource(value, depth) {
  var input = String(value == null ? "" : value);
  if (!input || depth > 4 || input.length > 100000) return renderEscapedInlineText(input);

  var output = "";
  var plainStart = 0;
  var index = 0;
  var remainingDelimiterSearches = 256;
  var missingClosers = new Set();

  function appendPlain(end) {
    if (end > plainStart) output += renderEscapedInlineText(input.slice(plainStart, end));
  }

  function findClosingMarker(marker, start) {
    if (remainingDelimiterSearches <= 0 || missingClosers.has(marker)) return -1;
    remainingDelimiterSearches -= 1;
    var end = input.indexOf(marker, start);
    if (end < 0) missingClosers.add(marker);
    return end;
  }

  while (index < input.length) {
    var character = input[index];

    if (character === "\\" && index + 1 < input.length && /[`*_~[\]\\]/.test(input[index + 1])) {
      appendPlain(index);
      output += renderEscapedInlineText(input[index + 1]);
      index += 2;
      plainStart = index;
      continue;
    }

    if (character === "`") {
      var markerEnd = index + 1;
      while (input[markerEnd] === "`") markerEnd += 1;
      var codeMarker = input.slice(index, markerEnd);
      var codeEnd = findClosingMarker(codeMarker, markerEnd);
      if (codeEnd >= markerEnd) {
        appendPlain(index);
        output += "<code>" + renderLiteralInlineText(input.slice(markerEnd, codeEnd)) + "</code>";
        index = codeEnd + codeMarker.length;
        plainStart = index;
        continue;
      }
    }

    var strongMarker = input.startsWith("**", index) ? "**" : input.startsWith("__", index) ? "__" : "";
    if (strongMarker) {
      var strongEnd = findClosingMarker(strongMarker, index + strongMarker.length);
      var strongContent = strongEnd > index ? input.slice(index + strongMarker.length, strongEnd) : "";
      var hasValidStrongBoundaries = strongContent && !/^\s|\s$/.test(strongContent) &&
        (strongMarker !== "__" || (!/[A-Za-z0-9]/.test(input[index - 1] || "") && !/[A-Za-z0-9]/.test(input[strongEnd + strongMarker.length] || "")));
      if (hasValidStrongBoundaries) {
        appendPlain(index);
        output += "<strong>" + renderInlineMarkdownSource(strongContent, depth + 1) + "</strong>";
        index = strongEnd + strongMarker.length;
        plainStart = index;
        continue;
      }
    }

    if (input.startsWith("~~", index)) {
      var strikeEnd = findClosingMarker("~~", index + 2);
      var strikeContent = strikeEnd > index ? input.slice(index + 2, strikeEnd) : "";
      if (strikeContent && !/^\s|\s$/.test(strikeContent)) {
        appendPlain(index);
        output += "<del>" + renderInlineMarkdownSource(strikeContent, depth + 1) + "</del>";
        index = strikeEnd + 2;
        plainStart = index;
        continue;
      }
    }

    if ((character === "*" || character === "_") && input[index + 1] !== character && input[index - 1] !== character) {
      var emphasisEnd = findClosingMarker(character, index + 1);
      var emphasisContent = emphasisEnd > index ? input.slice(index + 1, emphasisEnd) : "";
      var hasValidEmphasisBoundaries = emphasisContent && !/^\s|\s$/.test(emphasisContent) &&
        (character !== "_" || (!/[A-Za-z0-9]/.test(input[index - 1] || "") && !/[A-Za-z0-9]/.test(input[emphasisEnd + 1] || "")));
      if (hasValidEmphasisBoundaries) {
        appendPlain(index);
        output += "<em>" + renderInlineMarkdownSource(emphasisContent, depth + 1) + "</em>";
        index = emphasisEnd + 1;
        plainStart = index;
        continue;
      }
    }

    if (character === "[") {
      var labelEnd = findClosingMarker("](", index + 1);
      if (labelEnd >= 0) {
        var destinationStart = labelEnd + 2;
        var destinationEnd = findClosingMarker(")", destinationStart);
        var href = destinationEnd >= 0 ? safeHref(input.slice(destinationStart, destinationEnd)) : "";
        if (href) {
          appendPlain(index);
          output += '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' +
            renderInlineMarkdownSource(input.slice(index + 1, labelEnd), depth + 1) + "</a>";
          index = destinationEnd + 1;
          plainStart = index;
          continue;
        }
      }
    }

    index += 1;
  }

  appendPlain(input.length);
  return output;
}

function renderInlineMarkdownFallback(value, textSource) {
  var sanitized = sanitizeExportText(value);
  return textSource === "dom"
    ? renderLiteralInlineText(sanitized)
    : renderInlineMarkdownSource(sanitized, 0);
}

function renderCodeSegments(block) {
  var segments = block && block.codeSegments;
  if (!Array.isArray(segments) || !segments.length) {
    return escapeHtml(String(block && block.text || "").replace(/^\s*\n|\n\s*$/g, ""));
  }
  return segments.map(function (segment) {
    if (!segment) return "";
    var text = escapeHtml(String(segment.text == null ? "" : segment.text));
    var inlineStyle = styleAttribute(segment.htmlStyle);
    return inlineStyle ? "<span" + inlineStyle + ">" + text + "</span>" : text;
  }).join("");
}

function renderInlineSegments(block) {
  var segments = block && block.segments;
  if (!Array.isArray(segments) || !segments.length) {
    return renderInlineMarkdownFallback(block && block.text || "", block && block.textSource);
  }
  if (shouldCoalesceInlineSegments(segments)) {
    return renderInlineMarkdownFallback(getCoalescedInlineSegmentsText(segments, block && block.text), block && block.textSource);
  }
  return segments.map(function (segment) {
    if (!segment) return "";
    var marks = segment.marks || {};
    var isCode = Boolean(marks.code || segment.code);
    var isMath = Boolean(marks.math || segment.math);
    var sanitizedText = sanitizeInlineSegmentText(segment.text || "");
    var mathMl = isMath ? sanitizeExportMathMl(segment.mathMl) : "";
    var text = mathMl || (isMath
      ? escapeHtml(formatLatexUnicode("\\(" + sanitizedText.trim() + "\\)"))
      : renderLiteralInlineText(sanitizedText));
    var inlineStyle = styleAttribute(segment.htmlStyle);
    if (inlineStyle) text = "<span" + inlineStyle + ">" + text + "</span>";
    if (isMath) text = '<span class="math-inline">' + text + "</span>";
    if (isCode) text = "<code>" + text + "</code>";
    if (marks.bold || segment.bold) text = "<strong>" + text + "</strong>";
    if (marks.italic || segment.italic) text = "<em>" + text + "</em>";
    if (marks.strike || segment.strike) text = "<del>" + text + "</del>";
    if (marks.superscript || segment.superscript) text = "<sup>" + text + "</sup>";
    if (marks.subscript || segment.subscript) text = "<sub>" + text + "</sub>";
    if (marks.highlight || segment.highlight) text = "<mark>" + text + "</mark>";
    if (marks.underline || segment.underline) text = "<u>" + text + "</u>";
    var href = safeHref(segment.href);
    if (href) {
      text = '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
    }
    return text;
  }).join("");
}

function renderListItems(items) {
  return (items || []).map(function (item) {
    if (!item) return "";
    var content = item.segments && item.segments.length
      ? renderInlineSegments(item)
      : renderInlineMarkdownFallback(item.text || "", item.textSource);
    var children = item.subItems && item.subItems.length
      ? "<ul>" + renderListItems(item.subItems) + "</ul>"
      : "";
    return "<li>" + content + children + "</li>";
  }).join("");
}

function renderTable(block) {
  var headers = Array.isArray(block.headers) ? block.headers : [];
  var rows = Array.isArray(block.rows) ? block.rows : [];
  if (!headers.length && !rows.length) return "";
  var columnCount = headers.length;
  rows.forEach(function (row) {
    columnCount = Math.max(columnCount, Array.isArray(row) ? row.length : 0);
  });
  var head = "";
  if (headers.length) {
    head = "<thead><tr>";
    for (var index = 0; index < columnCount; index += 1) {
      head += "<th>" + renderInlineMarkdownFallback(headers[index] || "", block.textSource) + "</th>";
    }
    head += "</tr></thead>";
  }
  var body = "<tbody>" + rows.map(function (row) {
    var cells = "";
    for (var index = 0; index < columnCount; index += 1) {
      cells += "<td>" + renderInlineMarkdownFallback(row && row[index] || "", block.textSource) + "</td>";
    }
    return "<tr>" + cells + "</tr>";
  }).join("") + "</tbody>";
  return '<div class="table-wrap"><table' + styleAttribute(block.htmlStyle) + '>' + head + body + "</table></div>";
}

async function buildEmbeddedImageMap(messages, options) {
  var sources = [];
  var seen = new Set();
  (messages || []).forEach(function (message) {
    (message.contentBlocks || []).forEach(function (block) {
      if (block && block.type === "image" && block.src && !seen.has(block.src)) {
        seen.add(block.src);
        sources.push(block.src);
      }
    });
  });
  var imageMap = new Map();
  await mapLimit(sources, 2, async function (src, index) {
    if (options.signal && options.signal.aborted) {
      var abortError = new Error("aborted");
      abortError.name = "AbortError";
      throw abortError;
    }
    try {
      var result = await fetchImageBytes(src, options);
      if (result && result.bytes && result.bytes.byteLength) {
        var blob = new Blob([result.bytes], { type: result.mimeType || "image/png" });
        imageMap.set(src, await blobToDataUrl(blob));
      }
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
    }
    notifyProgress(options, t("export_progress_embedding_images", "Embedding images"), 0.05 + 0.2 * ((index + 1) / Math.max(1, sources.length)));
  });
  return imageMap;
}

function renderBlock(block, imageMap) {
  if (!block) return "";
  var blockStyle = styleAttribute(block.htmlStyle);
  if (block.type === "heading") {
    var level = Math.min(6, Math.max(2, Number(block.level || 1) + 1));
    return "<h" + level + blockStyle + ">" + renderInlineSegments(block) + "</h" + level + ">";
  }
  if (block.type === "paragraph") return "<p" + blockStyle + ">" + renderInlineSegments(block) + "</p>";
  if (block.type === "code") {
    var language = String(block.language || "").replace(/[^a-z0-9_+.-]/gi, "").slice(0, 40);
    var label = language ? '<div class="code-label">' + escapeHtml(language) + "</div>" : "";
    return '<div class="code-block"' + codeBlockStyleAttribute(block.htmlStyle) + ">" + label + "<pre><code" + styleAttribute(block.codeStyle) + ">" + renderCodeSegments(block) + "</code></pre></div>";
  }
  if (block.type === "list") {
    var tag = block.ordered ? "ol" : "ul";
    return "<" + tag + blockStyle + ">" + renderListItems(block.items) + "</" + tag + ">";
  }
  if (block.type === "table") return renderTable(block);
  if (block.type === "blockquote" || block.type === "quote") {
    return "<blockquote" + blockquoteStyleAttribute(block.htmlStyle) + ">" + renderInlineSegments(block) + "</blockquote>";
  }
  if (block.type === "image") {
    var dataUrl = imageMap.get(block.src);
    var alt = sanitizeImageAlt(block.alt || "Image");
    return dataUrl
      ? '<figure><img' + blockStyle + ' src="' + escapeHtml(dataUrl) + '" alt="' + escapeHtml(alt) + '" loading="lazy"><figcaption>' + escapeHtml(alt) + "</figcaption></figure>"
      : '<div class="image-placeholder">' + escapeHtml(t("export_image_unavailable", "Image unavailable in offline export")) + "</div>";
  }
  if (block.type === "separator") return "<hr" + blockStyle + ">";
  return block.text ? "<p" + blockStyle + ">" + renderInlineMarkdownFallback(block.text, block.textSource) + "</p>" : "";
}

function pageBackground(theme) {
  var bg = theme && theme.bg || {};
  var colors = Array.isArray(bg.colors) && bg.colors.length ? bg.colors : ["#ffffff"];
  if (bg.type === "gradient" || bg.type === "mesh") {
    return "linear-gradient(135deg," + colors.join(",") + ")";
  }
  return colors[0];
}

function buildCss(theme, styleId, settings) {
  var color = theme.color || {};
  var natural = styleId === "natural";
  var flat = styleId === "default" || natural;
  var userAlign = settings.align_user_messages_right ? "width:fit-content;max-width:88%;margin-left:auto;margin-right:0" : "width:auto;max-width:100%;margin-left:0";
  return `
    :root{color-scheme:light;--ink:${color.ink || "#17202a"};--muted:${color.muted || "#64748b"};--accent:${color.accent || "#16869a"};--line:${color.line || "#d9e2ec"};--code-bg:${color.codeBg || "#162334"};--code-text:${color.codeText || "#e5eef8"};--quote-bg:${color.quoteBg || "#f8fafc"};--quote-border:${color.quoteBorder || color.accent || "#16869a"}}
    *{box-sizing:border-box}html{background:#fff}body{margin:0;background:${natural ? "#fff" : pageBackground(theme)};color:var(--ink);font:16px/1.72 ${theme.font && theme.font.body || "sans-serif"};overflow-wrap:anywhere}
    main{width:min(920px,calc(100% - 32px));margin:0 auto;padding:56px 0 40px}header{padding-bottom:24px;border-bottom:1px solid var(--line);margin-bottom:30px}h1,h2,h3,h4,h5,h6{font-family:${theme.font && theme.font.title || "sans-serif"};line-height:1.3;margin:1.35em 0 .55em}h1{font-size:2rem;margin:0 0 12px}.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--muted);font-size:.9rem}
    .message{max-width:100%;margin:0 0 22px;padding:${flat ? "4px 0 22px" : "22px 24px"};background:transparent;border:${flat ? "0" : "1px solid"};border-bottom:${flat ? "1px solid var(--line)" : "1px solid"};border-radius:${flat ? "0" : "16px"};box-shadow:none}.message.user{${userAlign};background:${flat ? "transparent" : color.cardBgUser || "#eef8fb"};border-color:${flat ? "var(--line)" : color.cardBorderUser || "#bfe6ee"}}.message.assistant{background:${flat ? "transparent" : color.cardBgAssistant || "#fff"};border-color:${flat ? "var(--line)" : color.cardBorderAssistant || "#dbe7ef"}}
    .message p{margin:.35em 0 1em}.message> :last-child{margin-bottom:0}a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}code{font-family:${theme.font && theme.font.mono || "monospace"};background:${natural ? "#f3f4f6" : color.tagBgAssistant || "#f1f5f9"};padding:.12em .35em;border-radius:5px}.math-inline{display:inline-block;max-width:100%;vertical-align:middle;white-space:nowrap;overflow-x:auto;font-family:${theme.font && theme.font.body || "serif"}}.math-inline math{font-size:1em}mark{color:inherit;border-radius:3px;padding:0 .08em}.code-block{margin:18px 0;background:var(--code-bg);color:var(--code-text);border-radius:10px;overflow:hidden}.code-label{padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.15);font:700 .72rem ${theme.font && theme.font.mono || "monospace"};opacity:.8}.code-block pre{margin:0;padding:16px;overflow:auto;white-space:pre}.code-block code{padding:0;background:transparent;color:inherit}
    blockquote{margin:18px 0;padding:12px 16px;background:var(--quote-bg);border-left:4px solid var(--quote-border);border-radius:0 8px 8px 0}hr{height:0;margin:24px 0;border:0;border-top:1px solid var(--line)}.table-wrap{overflow-x:auto;margin:18px 0}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{padding:10px 12px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:${natural ? "#f8fafc" : color.tagBgAssistant || "#f1f5f9"}}figure{margin:20px 0}img{display:block;max-width:100%;height:auto;border-radius:8px}figcaption{margin-top:6px;color:var(--muted);font-size:.8rem}.image-placeholder{margin:16px 0;padding:14px;border:1px dashed var(--line);color:var(--muted);text-align:center}footer{display:flex;justify-content:space-between;gap:18px;margin-top:34px;padding-top:16px;border-top:${natural ? "0" : "1px solid var(--line)"};color:var(--muted);font-size:.8rem}footer span:last-child{text-align:right}
    @media(max-width:640px){main{width:min(100% - 24px,920px);padding-top:28px}.message{max-width:100%;padding:${flat ? "4px 0 18px" : "18px"}}footer{display:block}footer span{display:block;margin-top:6px}footer span:last-child{text-align:left}}
    @media print{body{background:#fff}main{width:auto;padding:0}.message{break-inside:avoid;box-shadow:none}a{color:inherit}footer{break-before:avoid}}
  `;
}

export async function buildHtmlBlob(messages, metadata, settings, options) {
  var opts = options || {};
  notifyProgress(opts, t("export_progress_preparing_html", "Preparing HTML export"), 0.03);
  var imageMap = await buildEmbeddedImageMap(messages, opts);
  var styleId = "natural"; // HTML export does not use custom themes; force native web presentation
  var theme = getExportTheme(styleId);
  var flat = styleId === "default" || styleId === "natural";
  var body = [];
  for (var index = 0; index < messages.length; index += 1) {
    if (opts.signal && opts.signal.aborted) {
      var abortError = new Error("aborted");
      abortError.name = "AbortError";
      throw abortError;
    }
    var message = messages[index];
    if (settings.export_ai_replies_only && message.role === "user") continue;
    var role = message.role === "user" ? "user" : "assistant";
    body.push('<section class="message ' + role + '"' + messageStyleAttribute(message.htmlStyle, flat) + '>' + (message.contentBlocks || []).map(function (block) {
      return renderBlock(block, imageMap);
    }).join("") + "</section>");
    if (index % 5 === 4 || index === messages.length - 1) {
      notifyProgress(opts, t("export_progress_building_html", "Building HTML export"), 0.28 + 0.64 * ((index + 1) / Math.max(1, messages.length)));
      await yieldToBrowser();
    }
  }
  var meta = [];
  if (settings.show_export_time && metadata && metadata.exportedAt) meta.push(escapeHtml(formatDateDisplay(metadata.exportedAt)));
  var title = metadata && metadata.title || "Untitled Chat";
  var header = settings.show_conversation_title || meta.length
    ? "<header>" + (settings.show_conversation_title ? "<h1>" + escapeHtml(title) + "</h1>" : "") + (meta.length ? '<div class="meta"><span>' + meta.join("</span><span>") + "</span></div>" : "") + "</header>"
    : "";
  var footerSegments = getExportFooterSegments(settings, metadata);
  var footer = footerSegments.left || footerSegments.right
    ? "<footer><span>" + escapeHtml(footerSegments.left) + "</span><span>" + escapeHtml(footerSegments.right) + "</span></footer>"
    : "";
  var html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>' + escapeHtml(title) + "</title><style>" + buildCss(theme, styleId, settings) + "</style></head><body><main>" + header + body.join("") + footer + "</main></body></html>";
  notifyProgress(opts, t("export_progress_ready", "Export ready"), 1);
  return new Blob([html], { type: "text/html;charset=utf-8" });
}
