import {
  getPlatformLabel,
  t,
  formatDateDisplay,
  sanitizeExportText,
  sanitizeImageAlt,
  sanitizeInlineSegmentText,
  formatLatexUnicode,
  hasLatexMathSyntax,
  getExportFooterSegments,
  shouldCoalesceInlineSegments,
  getCoalescedInlineSegmentsText,
  notifyProgress,
  yieldToBrowser
} from '../utils.js';

var MESSAGE_SEPARATOR_MARKDOWN = "---";
var BRANDING_FOOTER_STYLE = "display: flex; justify-content: space-between; gap: 16px; margin: 8px 0 0;";

export async function buildMarkdownBlob(messages, metadata, settings, options) {
  var opts = options || {};
  var signal = opts.signal;
  var lines = [];
  notifyProgress(opts, t("export_progress_preparing_markdown", "Preparing Markdown export"), 0.06);

  // 1. Generate YAML Front Matter
  var hasFrontMatter = Boolean(
    (settings.show_conversation_title && metadata && metadata.title) ||
    (settings.show_platform_name && metadata && metadata.platform) ||
    (settings.show_export_time && metadata && metadata.exportedAt)
  );
  if (hasFrontMatter) {
    lines.push("---");
    if (settings.show_conversation_title && metadata && metadata.title) {
      lines.push('title: "' + escapeYamlDoubleQuoted(metadata.title) + '"');
    }
    if (settings.show_platform_name && metadata && metadata.platform) {
      lines.push('platform: "' + escapeYamlDoubleQuoted(getPlatformLabel(metadata.platform)) + '"');
    }
    if (settings.show_export_time && metadata && metadata.exportedAt) {
      lines.push('date: "' + escapeYamlDoubleQuoted(formatDateDisplay(metadata.exportedAt)) + '"');
    }
    lines.push("---");
    lines.push("");
  }

  // 2. Main Title
  if (settings.show_conversation_title && metadata && metadata.title) {
    lines.push("# " + renderHeadingText(metadata.title));
    lines.push("");
  }

  // 3. Process Messages
  for (var i = 0; i < messages.length; i++) {
    if (signal && signal.aborted) {
      var err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    var msg = messages[i];

    // Filter out user messages if "Export AI Replies Only" is enabled
    if (settings.export_ai_replies_only && msg.role === "user") {
      continue;
    }

    // Role Label
    if (settings.show_role_labels && msg.role !== "system") {
      var roleName = msg.role === "user"
        ? t("role_user", "User")
        : getPlatformLabel((metadata && metadata.platform) || "assistant");
      lines.push("**" + roleName + ":**");
      lines.push("");
    }

    // Process ContentBlocks within the message
    var blocks = msg.contentBlocks || [];
    for (var j = 0; j < blocks.length; j++) {
      if (signal && signal.aborted) {
        var err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }

      var block = blocks[j];
      if (!block) continue;

      switch (block.type) {
        case "heading":
          var level = Math.min(6, (block.level || 1) + 1); // Indent by one level to fit main H1
          var hashes = "";
          for (var k = 0; k < level; k++) hashes += "#";
          lines.push(hashes + " " + renderInlineSegments(block));
          lines.push("");
          break;

        case "paragraph":
          lines.push(renderInlineSegments(block));
          lines.push("");
          break;

        case "code":
          renderCodeBlock(block, lines);
          lines.push("");
          break;

        case "list":
          j = renderListRun(blocks, j, lines);
          lines.push("");
          break;

        case "table":
          renderTableBlock(block, lines);
          lines.push("");
          break;

        case "blockquote":
        case "quote":
          if (block.text) {
            lines.push(renderInlineSegments(block).split("\n").map(function (line) {
              return "> " + line;
            }).join("\n"));
            lines.push("");
          }
          break;

        case "separator":
          lines.push("---");
          lines.push("");
          break;

        case "image":
          lines.push(renderMarkdownImage(block));
          lines.push("");
          break;
      }
    }

    // Separator line between messages
    if (i < messages.length - 1 && !settings.export_ai_replies_only) {
      lines.push(MESSAGE_SEPARATOR_MARKDOWN);
      lines.push("");
    }

    // Relieve CPU throttling every 5 messages
    if (i % 5 === 0 || i === messages.length - 1) {
      notifyProgress(
        opts,
        t("export_progress_building_markdown", "Building Markdown export"),
        0.08 + 0.78 * ((i + 1) / Math.max(1, messages.length))
      );
      await yieldToBrowser();
    }
  }

  // 4. Local export footer
  var footerSegments = getExportFooterSegments(settings, metadata);
  if (footerSegments.left || footerSegments.right) {
    trimTrailingBlankLines(lines);
    lines.push("");
    lines.push(
      '<div style="' + BRANDING_FOOTER_STYLE + '">' +
      '<span><em>' + escapeHtmlText(footerSegments.left) + "</em></span>" +
      '<span style="text-align: right;">' + escapeHtmlText(footerSegments.right) + "</span>" +
      "</div>"
    );
  }

  var outputText = lines.join("\n");
  notifyProgress(opts, t("export_progress_saving", "Saving export"), 0.88);
  var blob = new Blob([outputText], { type: "text/markdown;charset=utf-8" });
  notifyProgress(opts, t("export_progress_ready", "Export ready"), 1);
  return blob;
}

function renderInlineSegments(block) {
  if (!block.segments || !block.segments.length) {
    return renderMarkdownText(block.text || "");
  }
  if (shouldCoalesceInlineSegments(block.segments)) {
    return formatLatexUnicode(getCoalescedInlineSegmentsText(block.segments, block.text));
  }
  if (shouldRenderLatexSegmentsAsPlainText(block.segments)) {
    return formatLatexUnicode(block.segments.map(function (seg) {
      return sanitizeInlineSegmentText(seg && seg.text || "");
    }).join(""));
  }
  return block.segments.map(function (seg) {
    if (!seg) return "";
    var marks = seg.marks || {};
    var isCode = Boolean(marks.code || seg.code);
    var isMath = Boolean(marks.math || seg.math);
    var text = isMath
      ? formatLatexUnicode("\\(" + sanitizeInlineSegmentText(seg.text || "").trim() + "\\)")
      : isCode ? sanitizeInlineSegmentText(seg.text || "") : renderMarkdownInlineText(seg.text || "");
    var isBold = Boolean(marks.bold || seg.bold);
    var isItalic = Boolean(marks.italic || seg.italic);
    var href = seg.href || "";

    if (isCode) text = renderInlineCode(text);
    if (marks.superscript || seg.superscript) text = "<sup>" + escapeHtmlText(text) + "</sup>";
    if (marks.subscript || seg.subscript) text = "<sub>" + escapeHtmlText(text) + "</sub>";
    if (marks.highlight || seg.highlight) text = "<mark>" + escapeHtmlText(text) + "</mark>";
    if (marks.underline || seg.underline) text = "<u>" + escapeHtmlText(text) + "</u>";
    if (marks.strike || seg.strike) text = wrapMarkdownSpan(text, "~~");
    if (isBold) text = wrapMarkdownSpan(text, "**");
    if (isItalic) text = wrapMarkdownSpan(text, "*");
    if (href) text = "[" + escapeMarkdownLinkText(text) + "](" + escapeMarkdownLinkDestination(href) + ")";

    return text;
  }).join("");
}

function renderMarkdownText(value) {
  return formatLatexUnicode(sanitizeExportText(value));
}

function renderMarkdownImage(block) {
  var alt = escapeMarkdownLinkText(sanitizeImageAlt(block && block.alt || "Image"));
  var src = String(block && block.src || "").trim();
  if (/^https?:\/\//i.test(src)) {
    return "![" + alt + "](" + escapeMarkdownLinkDestination(src) + ")";
  }
  return t("export_image_placeholder", "[Image]");
}

function renderMarkdownInlineText(value) {
  return formatLatexUnicode(sanitizeInlineSegmentText(value));
}

function wrapMarkdownSpan(value, marker) {
  var text = String(value || "");
  var leading = text.match(/^\s+/);
  var trailing = text.match(/\s+$/);
  var start = leading ? leading[0] : "";
  var end = trailing ? trailing[0] : "";
  var core = text.slice(start.length, text.length - end.length);
  return core ? start + marker + core + marker + end : text;
}

function shouldRenderLatexSegmentsAsPlainText(segments) {
  if (!Array.isArray(segments) || !segments.length) return false;
  var hasCodeOrSemanticMath = segments.some(function (seg) {
    var marks = seg && seg.marks || {};
    return Boolean(seg && (seg.code || marks.code || seg.math || marks.math));
  });
  if (hasCodeOrSemanticMath) return false;
  return hasLatexMathSyntax(segments.map(function (seg) {
    return seg && seg.text || "";
  }).join(""));
}

function escapeYamlDoubleQuoted(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function escapeHtmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trimTrailingBlankLines(lines) {
  while (lines.length && !String(lines[lines.length - 1] || "").trim()) {
    lines.pop();
  }
}

function renderHeadingText(value) {
  return renderMarkdownText(value).replace(/\s+/g, " ").trim();
}

function sanitizeFenceInfo(value) {
  return String(value || "")
    .replace(/`/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCodeFence(text) {
  var maxRun = 0;
  String(text || "").replace(/`{3,}/g, function (match) {
    maxRun = Math.max(maxRun, match.length);
    return match;
  });
  var size = Math.max(3, maxRun + 1);
  var fence = "";
  for (var i = 0; i < size; i++) fence += "`";
  return fence;
}

function renderCodeBlock(block, lines) {
  var codeText = cleanMarkdownCodeText(block && block.text);
  var fence = getCodeFence(codeText);
  var info = sanitizeFenceInfo(block && block.language);
  lines.push(fence + info);
  lines.push(codeText);
  lines.push(fence);
}

function renderInlineCode(text) {
  var value = String(text || "");
  var maxRun = 0;
  value.replace(/`+/g, function (match) {
    maxRun = Math.max(maxRun, match.length);
    return match;
  });
  var delimiter = "";
  for (var i = 0; i < Math.max(1, maxRun + 1); i++) delimiter += "`";
  if (maxRun > 0) {
    return delimiter + " " + value + " " + delimiter;
  }
  return delimiter + value + delimiter;
}

function escapeMarkdownLinkText(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function escapeMarkdownEmphasisText(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

function escapeMarkdownLinkDestination(href) {
  return String(href || "").replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function renderTableBlock(block, lines) {
  var headers = block.headers || [];
  var rows = block.rows || [];

  if (!headers.length && !rows.length) return;

  var colCount = headers.length;
  if (rows.length && rows[0].length > colCount) {
    colCount = rows[0].length;
  }

  // Header line
  var headerParts = [];
  for (var i = 0; i < colCount; i++) {
    headerParts.push(renderTableCell(headers[i] || ""));
  }
  lines.push("| " + headerParts.join(" | ") + " |");

  // Divider line
  var dividerParts = [];
  for (var i = 0; i < colCount; i++) {
    dividerParts.push("---");
  }
  lines.push("| " + dividerParts.join(" | ") + " |");

  // Row lines
  rows.forEach(function (row) {
    var rowParts = [];
    for (var i = 0; i < colCount; i++) {
      rowParts.push(renderTableCell(row[i] || ""));
    }
    lines.push("| " + rowParts.join(" | ") + " |");
  });
}

function renderTableCell(value) {
  return renderMarkdownText(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function cleanMarkdownCodeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

function repeatSpaces(count) {
  var out = "";
  for (var i = 0; i < count; i++) out += " ";
  return out;
}

function renderListItemText(item) {
  if (item && item.segments && item.segments.length) {
    return renderInlineSegments(item);
  }
  return renderMarkdownText((item && item.text) || "");
}

function renderListItem(item, lines, prefix, indent) {
  var baseIndent = indent || "";
  lines.push(baseIndent + prefix + " " + renderListItemText(item));

  var childIndent = baseIndent + repeatSpaces(prefix.length + 1);
  var subItems = (item && item.subItems) || [];
  subItems.forEach(function (sub) {
    if (!sub) return;
    renderListItem(sub, lines, "-", childIndent);
  });
  return childIndent;
}

function renderListRun(blocks, startIndex, lines) {
  var index = startIndex;
  var orderedNumber = 1;
  var previousOrderedItemCount = 0;
  var previousOrderedChildIndent = "";

  while (index < blocks.length) {
    var block = blocks[index];
    if (!block || block.type !== "list") break;

    var items = block.items || [];
    if (!items.length) {
      index += 1;
      continue;
    }

    if (block.ordered) {
      items.forEach(function (item) {
        previousOrderedChildIndent = renderListItem(item, lines, orderedNumber + ".", "");
        orderedNumber += 1;
      });
      previousOrderedItemCount = items.length;
      index += 1;
      continue;
    }

    if (index > startIndex && previousOrderedItemCount === 1 && previousOrderedChildIndent) {
      items.forEach(function (item) {
        renderListItem(item, lines, "-", previousOrderedChildIndent);
      });
      previousOrderedItemCount = 0;
      index += 1;
      continue;
    }

    if (index !== startIndex) break;

    items.forEach(function (item) {
      renderListItem(item, lines, "-", "");
    });
    previousOrderedItemCount = 0;
    index += 1;
  }

  return Math.max(startIndex, index - 1);
}
