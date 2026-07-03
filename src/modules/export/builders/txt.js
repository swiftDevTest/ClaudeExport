import {
  getPlatformLabel,
  t,
  formatDateDisplay,
  sanitizeExportText,
  getExportFooterText,
  notifyProgress,
  yieldToBrowser
} from '../utils.js';

export async function buildTxtBlob(messages, metadata, settings, options) {
  var opts = options || {};
  var signal = opts.signal;
  var lines = [];
  notifyProgress(opts, t("export_progress_preparing_text", "Preparing text export"), 0.06);

  // 1. Metadata Header
  var hasHeader = Boolean(
    (settings.show_conversation_title && metadata && metadata.title) ||
    (settings.show_platform_name && metadata && metadata.platform) ||
    (settings.show_export_time && metadata && metadata.exportedAt)
  );

  if (hasHeader) {
    if (settings.show_conversation_title && metadata && metadata.title) {
      lines.push("Title: " + metadata.title);
    }
    if (settings.show_platform_name && metadata && metadata.platform) {
      lines.push("Platform: " + getPlatformLabel(metadata.platform));
    }
    if (settings.show_export_time && metadata && metadata.exportedAt) {
      lines.push("Date: " + formatDateDisplay(metadata.exportedAt));
    }
    lines.push("--------------------------------------------------");
    lines.push("");
  } else if (settings.show_conversation_title && metadata && metadata.title) {
    lines.push("Title: " + metadata.title);
    lines.push("");
  }

  // 2. Process Messages
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
      lines.push(roleName + ":");
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
          var level = Math.min(6, block.level || 1);
          var hashes = "";
          for (var k = 0; k < level; k++) hashes += "#";
          lines.push(hashes + " " + sanitizeExportText(block.text || ""));
          lines.push("");
          break;

        case "paragraph":
          lines.push(sanitizeExportText(block.text || ""));
          lines.push("");
          break;

        case "code":
          lines.push("```" + (block.language || ""));
          lines.push(block.text || "");
          lines.push("```");
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
            lines.push(block.text.split("\n").map(function (line) {
              return "> " + line;
            }).join("\n"));
            lines.push("");
          }
          break;

        case "math":
        case "latex":
          lines.push("$$\n" + (block.text || "") + "\n$$");
          lines.push("");
          break;

        case "image":
          lines.push(t("export_image_placeholder", "[Image]"));
          lines.push("");
          break;
      }
    }

    // Separator line between messages
    if (i < messages.length - 1 && !settings.export_ai_replies_only) {
      lines.push("--------------------------------------------------");
      lines.push("");
    }

    // Relieve CPU throttling every 5 messages
    if (i % 5 === 0 || i === messages.length - 1) {
      notifyProgress(
        opts,
        t("export_progress_building_text", "Building text export"),
        0.08 + 0.78 * ((i + 1) / Math.max(1, messages.length))
      );
      await yieldToBrowser();
    }
  }

  // 3. Local export footer
  var footerText = getExportFooterText(settings, metadata);
  if (footerText) {
    trimTrailingBlankLines(lines);
    lines.push("");
    lines.push(footerText);
  }

  var outputText = lines.join("\n");
  notifyProgress(opts, t("export_progress_saving", "Saving export"), 0.88);
  var blob = new Blob([outputText], { type: "text/plain;charset=utf-8" });
  notifyProgress(opts, t("export_progress_ready", "Export ready"), 1);
  return blob;
}

function trimTrailingBlankLines(lines) {
  while (lines.length && !String(lines[lines.length - 1] || "").trim()) {
    lines.pop();
  }
}

function renderListItem(item, lines, prefix, indent) {
  var baseIndent = indent || "";
  lines.push(baseIndent + prefix + " " + sanitizeExportText((item && item.text) || ""));

  var childIndent = baseIndent + "  ";
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

function renderTableBlock(block, lines) {
  var headers = block.headers || [];
  var rows = block.rows || [];
  
  if (!headers.length && !rows.length) return;

  var colCount = headers.length;
  if (rows.length && rows[0].length > colCount) {
    colCount = rows[0].length;
  }

  var headerParts = [];
  for (var i = 0; i < colCount; i++) {
    headerParts.push(sanitizeExportText(headers[i] || ""));
  }
  lines.push("| " + headerParts.join(" | ") + " |");
  
  var dividerParts = [];
  for (var i = 0; i < colCount; i++) {
    dividerParts.push("---");
  }
  lines.push("| " + dividerParts.join(" | ") + " |");

  rows.forEach(function (row) {
    var rowParts = [];
    for (var i = 0; i < colCount; i++) {
      rowParts.push(sanitizeExportText(row[i] || ""));
    }
    lines.push("| " + rowParts.join(" | ") + " |");
  });
}
