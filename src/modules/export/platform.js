import {
  PLATFORM_GEMINI,
  detectPlatform,
  getConversationTitle,
  IMAGE_MAX_CHARS,
  IMAGE_MAX_MESSAGES,
  IMAGE_MAX_CODE_CHARS,
  IMAGE_RENDER_WIDTH,
  IMAGE_EXPORT_SCALE,
  IMAGE_MIN_EXPORT_SCALE,
  IMAGE_MAX_RENDER_HEIGHT,
  normalizeExportSettings,
  t,
  getFittedCanvasScale,
  dedupeImageBlocksWithinMessage,
  getBlockText,
  getPlainText
} from './utils.js';

import { compareElementsInDocument, pushDistinctDocumentElement } from './platforms/shared.js';
import { parseMessagesForPlatform } from './platforms/registry.js';
import { createExportDocument, normalizeExportBlocks, validateExportDocument } from './document.js';

const PRODUCT_CONFIG = globalThis.CHATVAULT_PRODUCT_CONFIG || {};

function defaultPlatformLabel(platform) {
  if (platform === "claude") return "Claude";
  if (platform === "gemini") return "Gemini";
  if (platform === "chatgpt") return "ChatGPT";
  return "supported AI chat";
}

function getSupportedPlatformLabel() {
  const platformLabels = PRODUCT_CONFIG.platformLabels || {};
  const supportedPlatforms = Array.isArray(PRODUCT_CONFIG.supportedPlatforms) && PRODUCT_CONFIG.supportedPlatforms.length
    ? PRODUCT_CONFIG.supportedPlatforms
    : ["chatgpt", "claude", "gemini"];
  const names = supportedPlatforms.map((platform) => platformLabels[platform] || defaultPlatformLabel(platform));
  if (!names.length) return "supported AI chat";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

var selectionSelectedMessages = new Map();
var selectionOrderCounter = 0;
var selectionDomKeys = new WeakMap();
var selectionDomKeyCounter = 0;

function resetSelectionState() {
  selectionSelectedMessages.clear();
  selectionOrderCounter = 0;
  selectionDomKeys = new WeakMap();
  selectionDomKeyCounter = 0;
}



function parseChatGPTMessages() {
  return parseMessagesForPlatform("chatgpt");
}


function parseClaudeMessages() {
  return parseMessagesForPlatform("claude");
}


function parseGeminiMessages() {
  return parseMessagesForPlatform("gemini");
}


function parseMessages() {
  var platform = detectPlatform();
  var messages = parseMessagesForPlatform(platform);
  messages.forEach(function (message, index) {
    message.index = index;
  });
  return messages;
}



function getMessagesPlainText(messages) {
  return messages.map(function (message) {
    return getPlainText(message.contentBlocks);
  }).filter(Boolean).join("\n\n").trim();
}

function cloneContentBlocks(blocks) {
  return normalizeExportBlocks(blocks);
}

function orderUserImageBlocksFirst(role, blocks) {
  if (role !== "user") return blocks || [];
  var images = [];
  var rest = [];
  (blocks || []).forEach(function (block) {
    if (block && block.type === "image") {
      images.push(block);
    } else {
      rest.push(block);
    }
  });
  return images.length ? images.concat(rest) : (blocks || []);
}

function cloneExportMessage(message) {
  var role = message && message.role || "assistant";
  var cloned = cloneContentBlocks(message && message.contentBlocks);
  var deduped = dedupeImageBlocksWithinMessage(cloned);
  return {
    role: role,
    contentBlocks: orderUserImageBlocksFirst(role, deduped)
  };
}

function getSelectionDomKey(element) {
  if (!element || typeof WeakMap === "undefined") return "";
  if (!selectionDomKeys.has(element)) {
    selectionDomKeyCounter += 1;
    selectionDomKeys.set(element, "node-" + selectionDomKeyCounter);
  }
  return selectionDomKeys.get(element);
}

function getSelectionMessageKey(message, index) {
  var turn = message && message.turnElement;
  var content = message && message.contentElement;
  var domKeyParts = [];
  var generatedKey = getSelectionDomKey(turn || content);
  if (generatedKey) domKeyParts.push("generated=" + generatedKey);
  [turn, content].forEach(function (element) {
    if (!element || !element.getAttribute) return;
    [
      "data-testid",
      "data-message-id",
      "id"
    ].forEach(function (attr) {
      var value = element.getAttribute(attr);
      if (value) domKeyParts.push(attr + "=" + value);
    });
  });
  var textKey = getPlainText(message && message.contentBlocks)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  var role = message && message.role || "assistant";
  var stableDomKey = domKeyParts.join("|");
  return stableDomKey
    ? [role, stableDomKey].join("::")
    : [role, textKey ? "text-" + hashString(textKey) : "visible-" + index, textKey].join("::");
}

function hashString(value) {
  var hash = 2166136261;
  String(value || "").split("").forEach(function (ch) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  });
  return (hash >>> 0).toString(36);
}

function getMessageOriginalIndex(message, fallback) {
  var index = Number(message && message.index);
  return Number.isFinite(index) ? index : (Number.isFinite(Number(fallback)) ? Number(fallback) : Number.MAX_SAFE_INTEGER);
}

function getSortedSelectionEntries(entries) {
  return entries.slice().sort(function (left, right) {
    var leftIndex = Number.isFinite(Number(left.index)) ? Number(left.index) : Number.MAX_SAFE_INTEGER;
    var rightIndex = Number.isFinite(Number(right.index)) ? Number(right.index) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return Number(left.order || 0) - Number(right.order || 0);
  });
}

function rememberSelectionMessage(key, message, index) {
  var existing = selectionSelectedMessages.get(key);
  selectionSelectedMessages.set(key, {
    order: existing ? existing.order : selectionOrderCounter++,
    index: getMessageOriginalIndex(message, index),
    message: cloneExportMessage(message)
  });
}

function estimateWrappedLineCount(text, charsPerLine) {
  var max = charsPerLine || 48;
  return String(text || "").split("\n").reduce(function (sum, line) {
    var length = Array.prototype.reduce.call(line, function (count, ch) {
      return count + (/[\u3400-\u9fff]/.test(ch) ? 1.35 : 1);
    }, 0);
    return sum + Math.max(1, Math.ceil(length / max));
  }, 0);
}

function estimateImageHeight(messages, settings, metadata) {
  var height = 120;
  if (settings.show_platform_name || settings.show_export_time) height += 30;
  if (settings.show_conversation_title) {
    height += estimateWrappedLineCount(metadata && metadata.title || "Untitled Chat", 32) * 42 + 14;
  }
  height += 26;
  messages.forEach(function (message) {
    if (settings.show_role_labels && (!metadata || metadata.scope !== "ai_only")) height += 34;
    height += 28;
    height += estimateWrappedLineCount(getPlainText(message.contentBlocks), 52) * 29;
    height += 24;
  });
  if (settings.show_chatvault_badge) height += 52;
  return height;
}

function getSelectedIndices() {
  var indices = [];
  document.querySelectorAll(".cv-export-checkbox").forEach(function (checkbox) {
    if (checkbox.dataset.selected === "true") {
      var idx = Number(checkbox.dataset.index);
      if (Number.isFinite(idx)) indices.push(idx);
    }
  });
  return indices;
}

function resolveMessages(request) {
  var platform = request && request.platform || detectPlatform();
  var hasSelectedMessages = Array.isArray(request && request.selectedMessages) && request.selectedMessages.length > 0;
  var allMessages = request && Array.isArray(request.messages) ? request.messages : hasSelectedMessages ? [] : parseMessages();
  var settings = normalizeExportSettings(request && request.settings);
  var scope = request && request.scope || (settings.export_ai_replies_only ? "ai_only" : "conversation");
  var messages = [];

  if (!platform) {
    return { ok: false, error: `Open a ${getSupportedPlatformLabel()} conversation to export.` };
  }

  if (!allMessages.length && !hasSelectedMessages) {
    return { ok: false, error: "No messages found. Make sure the conversation is open and loaded." };
  }

  if (scope === "selected") {
    if (hasSelectedMessages) {
      messages = request.selectedMessages.map(cloneExportMessage);
    } else {
      (request.selectedIndices || getSelectedIndices()).forEach(function (idx) {
        if (idx >= 0 && idx < allMessages.length) messages.push(allMessages[idx]);
      });
    }
    if (settings.export_ai_replies_only) {
      messages = messages.filter(function (message) { return message.role === "assistant" || message.role === "system"; });
    }
  } else if (scope === "assistant_single") {
    var message = allMessages[Number(request.messageIndex)];
    if (message && message.role === "assistant") messages = [message];
  } else if (scope === "ai_only") {
    messages = allMessages.filter(function (message) {
      return message.role === "assistant" || message.role === "system";
    });
  } else if (scope && scope !== "conversation") {
    messages = allMessages.slice();
  } else {
    messages = settings.export_ai_replies_only
      ? allMessages.filter(function (message) { return message.role === "assistant" || message.role === "system"; })
      : allMessages.slice();
    scope = settings.export_ai_replies_only ? "ai_only" : "conversation";
  }

  messages = messages
    .map(cloneExportMessage);

  messages = messages.filter(function (message) {
    return getPlainText(message.contentBlocks);
  });

  if (platform === PLATFORM_GEMINI) {
    var GEMINI_IMAGE_GEN_MARKER = /`?image_generation\.ImageGenerationUsecase\b/;
    messages.forEach(function (msg) {
      (msg.contentBlocks || []).forEach(function (block) {
        if (block && block.text && typeof block.text === "string" && GEMINI_IMAGE_GEN_MARKER.test(block.text)) {
          var cleaned = block.text.replace(/\n`?image_generation\.ImageGenerationUsecase[\s\S]*$/, "").trim();
          if (cleaned) block.text = cleaned;
        }
      });
    });
    messages = messages.filter(function (message) {
      return getPlainText(message.contentBlocks);
    });
  }



  if (!messages.length) {
    return { ok: false, error: "No messages match this export scope." };
  }

  var metadata = {
    platform: platform,
    title: request && request.title || (typeof window !== "undefined" ? getConversationTitle() : "Untitled Chat"),
    exportedAt: new Date(),
    sourceUrl: request && request.sourceUrl || (typeof window !== "undefined" ? window.location.href : ""),
    scope: scope
  };
  var document = createExportDocument({
    platform: platform,
    scope: scope,
    messages: messages,
    settings: settings,
    metadata: metadata
  });
  var validation = validateExportDocument(document);
  if (!validation.ok) {
    return { ok: false, error: validation.errors.join(" ") || "Export content could not be normalized." };
  }

  return {
    ok: true,
    platform: platform,
    scope: scope,
    messages: document.messages,
    settings: document.settings,
    metadata: document.metadata,
    contentBlocks: document.contentBlocks,
    document: document
  };
}

function getImageEligibility(input) {
  var resolved = input && input.messages ? {
    ok: true,
    messages: input.messages,
    settings: normalizeExportSettings(input.settings),
    metadata: input.metadata || {}
  } : resolveMessages(input || {});
  if (!resolved.ok) {
    return { ok: false, reason: resolved.error || "No exportable content." };
  }

  var messages = resolved.messages;
  var charCount = getMessagesPlainText(messages).length;

  var tableStats = messages.reduce(function (stats, message) {
    message.contentBlocks.forEach(function (block) {
      if (block.type !== "table") return;
      var rows = (block.headers && block.headers.length ? [block.headers] : []).concat(block.rows || []);
      stats.cells += rows.reduce(function (sum, row) { return sum + row.length; }, 0);
      stats.chars += rows.map(function (row) { return row.join(" "); }).join(" ").length;
    });
    return stats;
  }, { cells: 0, chars: 0 });
  if (tableStats.cells > 48 || tableStats.chars > 1800) {
    return { ok: false, reason: "Large tables are best exported as PDF or Word." };
  }

  var settings = normalizeExportSettings(resolved.settings);
  var estimatedHeight = estimateImageHeight(messages, settings, resolved.metadata);
  var fittedScale = getFittedCanvasScale(IMAGE_RENDER_WIDTH, estimatedHeight, IMAGE_EXPORT_SCALE, IMAGE_MIN_EXPORT_SCALE);
  if (!fittedScale) {
    return {
      ok: false,
      reason: t("export_image_canvas_limit", "This conversation is too long for a high-quality image export because browsers limit canvas size. Export as PDF instead."),
      charCount: charCount,
      estimatedHeight: estimatedHeight,
      requiresMultipage: true,
      large: true
    };
  }

  var requiresMultipage = estimatedHeight > IMAGE_MAX_RENDER_HEIGHT || messages.length > IMAGE_MAX_MESSAGES;
  var hasLongCode = messages.some(function (message) {
    return message.contentBlocks.some(function (block) {
      return block.type === "code" && String(block.text || "").length > IMAGE_MAX_CODE_CHARS;
    });
  });

  return {
    ok: true,
    charCount: charCount,
    estimatedHeight: estimatedHeight,
    requiresMultipage: requiresMultipage || hasLongCode,
    large: requiresMultipage || hasLongCode || charCount > IMAGE_MAX_CHARS
  };
}

export {
  compareElementsInDocument,
  pushDistinctDocumentElement,
  parseChatGPTMessages,
  parseClaudeMessages,
  parseGeminiMessages,
  parseMessages,
  getBlockText,
  getPlainText,
  getMessagesPlainText,
  cloneContentBlocks,
  orderUserImageBlocksFirst,
  cloneExportMessage,
  getSelectionDomKey,
  getSelectionMessageKey,
  hashString,
  getMessageOriginalIndex,
  getSortedSelectionEntries,
  rememberSelectionMessage,
  estimateWrappedLineCount,
  estimateImageHeight,
  getSelectedIndices,
  resolveMessages,
  getImageEligibility,
  selectionSelectedMessages,
  selectionOrderCounter,
  selectionDomKeys,
  selectionDomKeyCounter,
  resetSelectionState
};
