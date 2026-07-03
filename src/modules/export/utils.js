const i18n = globalThis.CHATVAULT_I18N;
const PRODUCT_NAME = globalThis.CHATVAULT_PRODUCT_CONFIG?.productName || "Claude Export";

export function t(key, defaultText, ...args) {
  if (i18n && typeof i18n.t === "function") {
    return i18n.t(key, defaultText, ...args);
  }

  try {
    if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
      var val = chrome.i18n.getMessage(key, args);
      if (val) return val;
    }
  } catch (error) {}
  if (args.length > 0) {
    var formatted = defaultText;
    args.forEach(function (arg, index) {
      formatted = formatted.replace(new RegExp("\\$" + (index + 1), "g"), arg);
    });
    return formatted;
  }
  return defaultText;
}

export var PLATFORM_CHATGPT = "chatgpt";
export var PLATFORM_CLAUDE = "claude";
export var PLATFORM_GEMINI = "gemini";
export var IMAGE_MAX_CHARS = 12000;
export var IMAGE_MAX_MESSAGES = 40;
export var IMAGE_MAX_CODE_CHARS = 8000;
export var IMAGE_RENDER_WIDTH = 1080;
export var IMAGE_EXPORT_SCALE = 4;
export var IMAGE_PREVIEW_SCALE = 1.5;
export var IMAGE_MAX_CANVAS_PIXELS = 72000000;
export var IMAGE_MAX_CANVAS_DIMENSION = 32767;
export var IMAGE_MIN_EXPORT_SCALE = 2.5;
export var IMAGE_MAX_RENDER_HEIGHT = Math.floor(IMAGE_MAX_CANVAS_PIXELS / (IMAGE_RENDER_WIDTH * IMAGE_EXPORT_SCALE * IMAGE_EXPORT_SCALE));
export var CANVAS_TO_BLOB_TIMEOUT_MS = 30000;
export var SELECTION_STYLE_ID = "chatvault-export-selection-style";
export var isTestEnv = false;
try {
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    isTestEnv = true;
  }
} catch (e) {}

export var DEFAULT_EXPORT_SETTINGS = {
  export_ai_replies_only: false,
  show_export_time: true,
  show_conversation_title: true,
  show_platform_name: true,
  show_role_labels: true,
  show_chatvault_badge: true,
  include_source_url: false,
  align_user_messages_right: true,
  export_style: "default"
};

import { EXPORT_THEMES } from './themes/tokens.js';
export { DESIGN, IMAGE_THEME, EXPORT_THEMES } from './themes/tokens.js';

export function normalizeBooleanSetting(value, defaultValue) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    var normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off" || normalized === "") return false;
  }
  return Boolean(defaultValue);
}


var CHINESE_THOUGHT_STATUS_PATTERN = /^\s*(?:已\s*)?(?:思考|推理)(?:了|中)?\s*(?:(?:约|大约|若干|几|数|多)?(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千万半两]+)?\s*(?:毫秒|秒钟|秒|分钟|分|小时|时))?\s*[。.,，:：-]?\s*$/i;
var ENGLISH_THOUGHT_STATUS_PATTERN = /^\s*(?:(?:Thought|Reasoned|Worked)\s+(?:for|about)|Thinking|Reasoning|Working)(?:\b|[\s:：,，。.·-]|$)[\s\S]{0,160}$/i;
export var THOUGHT_ATTR_PATTERN = /\b(?:reasoning|thought|thinking|chain[-_ ]?of[-_ ]?thought|model[-_ ]?thought|oai[-_ ]?reasoning)\b/i;

export function isThoughtStatusLine(value) {
  var text = String(value || "").trim();
  return text.length > 0 &&
    text.length <= 180 &&
    (CHINESE_THOUGHT_STATUS_PATTERN.test(text) || ENGLISH_THOUGHT_STATUS_PATTERN.test(text));
}

export function normalizeExportSettings(input) {
  var src = input && typeof input === "object" ? input : {};
  var out = {};
  Object.keys(DEFAULT_EXPORT_SETTINGS).forEach(function (key) {
    if (key === "export_style") {
      out[key] = typeof src[key] === "string" && EXPORT_THEMES[src[key]] ? src[key] : DEFAULT_EXPORT_SETTINGS[key];
    } else {
      out[key] = normalizeBooleanSetting(src[key], DEFAULT_EXPORT_SETTINGS[key]);
    }
  });
  return out;
}

export function detectPlatform() {
  var hostname = window.location.hostname;
  if (/^(chatgpt\.com|chat\.openai\.com)$/.test(hostname)) {
    return PLATFORM_CHATGPT;
  }
  if (/(^|\.)claude\.ai$/.test(hostname)) {
    return PLATFORM_CLAUDE;
  }
  if (hostname === "gemini.google.com") {
    return PLATFORM_GEMINI;
  }
  return "";
}

export function getPlatformLabel(platform) {
  if (platform === PLATFORM_GEMINI) return "Gemini";
  if (platform === PLATFORM_CLAUDE) return "Claude";
  if (platform === PLATFORM_CHATGPT) return "ChatGPT";
  return "AI";
}

export function getConversationTitle() {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.querySelector) {
    return "Untitled Chat";
  }
  var platform = detectPlatform();
  var pathname = window.location.pathname || "";
  var searchTitle = "";

  if (platform === PLATFORM_CHATGPT) {
    var match = pathname.match(/^\/c\/([^/?#]+)/);
    var chatId = match && match[1] ? decodeURIComponent(match[1]) : "";
    if (chatId) {
      var anchors = document.querySelectorAll('a[href^="/c/"], a[href*="chatgpt.com/c/"], a[href*="chat.openai.com/c/"]');
      for (var i = 0; i < anchors.length; i++) {
        var anchor = anchors[i];
        var href = anchor.getAttribute("href") || "";
        var aMatch = href.match(/^\/c\/([^/?#]+)/);
        var aChatId = aMatch && aMatch[1] ? decodeURIComponent(aMatch[1]) : "";
        if (aChatId === chatId) {
          var clone = anchor.cloneNode(true);
          var buttons = clone.querySelectorAll(".chatvault-left-bookmark-button, .chatvault-left-folder-button, .chatvault-left-folder-tags");
          for (var j = 0; j < buttons.length; j++) {
            buttons[j].remove();
          }
          searchTitle = (clone.textContent || anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "").replace(/\s+/g, " ").trim();
          if (searchTitle) break;
        }
      }
    }
    var title = searchTitle || (document.title || "")
      .replace(/\s*-\s*ChatGPT\s*$/i, "")
      .replace(/^ChatGPT$/i, "")
      .trim();
    return title || "Untitled Chat";
  }

  if (platform === PLATFORM_CLAUDE) {
    var match = pathname.match(/\/chat\/([^/?#]+)/);
    var chatId = match && match[1] ? decodeURIComponent(match[1]) : "";
    if (chatId) {
      var anchors = document.querySelectorAll('a[href^="/chat/"], a[href*="claude.ai/chat/"]');
      for (var i = 0; i < anchors.length; i++) {
        var anchor = anchors[i];
        var href = anchor.getAttribute("href") || "";
        var aMatch = href.match(/\/chat\/([^/?#]+)/);
        var aChatId = aMatch && aMatch[1] ? decodeURIComponent(aMatch[1]) : "";
        if (aChatId === chatId) {
          var clone = anchor.cloneNode(true);
          var buttons = clone.querySelectorAll(".chatvault-left-bookmark-button, .chatvault-left-folder-button, .chatvault-left-folder-tags");
          for (var j = 0; j < buttons.length; j++) {
            buttons[j].remove();
          }
          searchTitle = (clone.textContent || anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "").replace(/\s+/g, " ").trim();
          if (searchTitle) break;
        }
      }
    }
    var h1 = document.querySelector("main h1") || document.querySelector('[data-testid*="conversation"] h1');
    var title = (h1 && h1.textContent ? h1.textContent : searchTitle || document.title || "")
      .replace(/\s*[-|]\s*Claude\s*$/i, "")
      .replace(/^Claude$/i, "")
      .trim();
    return title || "Untitled Chat";
  }

  if (platform === PLATFORM_GEMINI) {
    var match = pathname.match(/\/(?:app|gem\/[^/?#]+)\/([^/?#]+)/);
    var chatId = match && match[1] ? decodeURIComponent(match[1]) : "";
    if (chatId) {
      var anchors = document.querySelectorAll('a[href*="/app/"], a[href*="/gem/"]');
      for (var i = 0; i < anchors.length; i++) {
        var anchor = anchors[i];
        var href = anchor.getAttribute("href") || "";
        var aMatch = href.match(/\/(?:app|gem\/[^/?#]+)\/([^/?#]+)/);
        var aChatId = aMatch && aMatch[1] ? decodeURIComponent(aMatch[1]) : "";
        if (aChatId === chatId) {
          var clone = anchor.cloneNode(true);
          var buttons = clone.querySelectorAll(".chatvault-left-bookmark-button, .chatvault-left-folder-button, .chatvault-left-folder-tags");
          for (var j = 0; j < buttons.length; j++) {
            buttons[j].remove();
          }
          searchTitle = (clone.textContent || anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "").replace(/\s+/g, " ").trim();
          if (searchTitle) break;
        }
      }
    }
    if (!searchTitle) {
      var activeAnchor = document.querySelector('nav a[aria-current="page"], aside a[aria-current="page"], mat-sidenav a[aria-current="page"], [class*="active"] a[href*="/app/"]');
      if (activeAnchor) {
        var clone = activeAnchor.cloneNode(true);
        var buttons = clone.querySelectorAll(".chatvault-left-bookmark-button, .chatvault-left-folder-button, .chatvault-left-folder-tags");
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].remove();
        }
        searchTitle = (clone.textContent || activeAnchor.getAttribute("aria-label") || activeAnchor.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      }
    }
    var h1 = document.querySelector("main h1");
    var title = searchTitle || (h1 && h1.textContent ? h1.textContent : document.title || "")
      .replace(/\s*[-|]\s*(?:Google\s+)?Gemini\s*$/i, "")
      .replace(/^(?:Google\s+)?Gemini\s*$/i, "")
      .trim();
    return title || "Untitled Chat";
  }

  return "Untitled Chat";
}

export function isInsideUserQuery(element) {
  if (!element) return false;
  if (!element.closest) return false;
  return Boolean(element.closest('user-query, [data-test-id="user-query"], .user-query, .query-container, [class*="user-query"], [class*="query-container"], [class*="query-content"], .user-prompt, [class*="user-prompt"], [data-message-author-role="user"], [data-testid*="user"], [data-test-id*="user"], [class*="user-message"], [class*="human-message"]'));
}

export function isGeminiUINoiseText(text, element) {
  if (!text) return false;
  if (detectPlatform() !== PLATFORM_GEMINI) return false;
  if (element && isInsideUserQuery(element)) return false;
  var trimmed = String(text).replace(/\s+/g, " ").trim();

  if (/^\d{1,3}$/.test(trimmed)) return true;

  if (/^(Good response|Bad response|More|Share|Copy|Modify|Report|Retry|Edit|Rewrite|Shorter|Longer|Simpler|More casual|More professional)$/i.test(trimmed)) return true;

  if (/^Draft\s*\d+$/i.test(trimmed)) return true;
  if (/^Show\s+\d+\s+drafts?$/i.test(trimmed)) return true;

  if (/^(Hello|Hi|Hey),?\s+(I'm Gemini|how can I help)/i.test(trimmed)) return true;

  return false;
}

export function isGeminiUINoiseContainer(element) {
  if (!element) return false;
  if (detectPlatform() !== PLATFORM_GEMINI) return false;
  if (element.closest && element.closest('.welcome-container, [class*="welcome"], [class*="onboarding"], [class*="suggestion-grid"]')) {
    return true;
  }
  return false;
}

export async function ensureAllGeminiMessagesLoaded(options) {
  var platform = detectPlatform();
  if (platform !== PLATFORM_GEMINI) return;

  var scroller = document.querySelector(
    'infinite-scroller, .conversation-container, mat-sidenav-content, [role="main"], main'
  );
  if (!scroller) return;

  var previousHeight = 0;
  var stableCount = 0;
  var maxAttempts = 60;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var progress = Math.round(((attempt + 1) / maxAttempts) * 100);
    if (options && typeof notifyProgress === "function") {
      notifyProgress(options, "Loading Gemini messages: " + (attempt + 1) + "/" + maxAttempts, progress);
    }

    scroller.scrollTop = 0;
    await new Promise(function (resolve) { setTimeout(resolve, 300); });

    if (scroller.scrollHeight === previousHeight) {
      stableCount++;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
    }
    previousHeight = scroller.scrollHeight;
  }

  scroller.scrollTop = scroller.scrollHeight;
  await new Promise(function (resolve) { setTimeout(resolve, 200); });
}

export function sanitizeFilename(name) {
  return String(name || "Untitled Chat")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 80) || "Untitled Chat";
}

export function formatDateDisplay(date) {
  var d = date || new Date();
  var locale = undefined;
  try {
    if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
      locale = chrome.i18n.getUILanguage() || undefined;
    }
  } catch (e) {}
  return d.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function buildFilename(format, scope, metadata) {
  var title = sanitizeFilename((metadata && metadata.title) || getConversationTitle());
  var ext = format === "word" ? "docx" : format === "image" ? "png" : format === "markdown" ? "md" : format === "txt" ? "txt" : format === "json" ? "json" : "pdf";
  return title + "." + ext;
}

export function replaceFileExtension(filename, nextExt) {
  var cleanExt = String(nextExt || "").replace(/^\./, "");
  var base = String(filename || "AI-Chat-Export").replace(/\.[^.]+$/, "");
  return base + (cleanExt ? "." + cleanExt : "");
}

export function getExportSourceUrl(metadata) {
  return metadata && (metadata.sourceUrl || metadata.url || metadata.source) || "";
}

export function getExportFooterParts(settings, metadata) {
  var segments = getExportFooterSegments(settings, metadata);
  var parts = [];
  if (segments.left) parts.push(segments.left);
  if (segments.right) parts.push(segments.right);
  return parts;
}

export function getExportFooterSegments(settings, metadata) {
  var sourceUrl = getExportSourceUrl(metadata);
  return {
    left: settings && settings.show_chatvault_badge
      ? PRODUCT_NAME
      : "",
    right: settings && settings.include_source_url && sourceUrl
      ? t("export_footer_source", "Export From: $1", sourceUrl)
      : ""
  };
}

export function getExportFooterText(settings, metadata) {
  return getExportFooterParts(settings, metadata).join(" ").trim();
}

export function notifyProgress(options, message, progress) {
  if (!options || typeof options.onProgress !== "function") {
    return;
  }

  try {
    options.onProgress({
      message: message,
      progress: Math.max(0, Math.min(1, Number(progress) || 0))
    });
  } catch (error) {}
}

export function yieldToBrowser() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

export function getFittedCanvasScale(width, height, preferredScale, minScale) {
  var safeWidth = Math.max(1, Number(width) || 1);
  var safeHeight = Math.max(1, Number(height) || 1);
  var targetScale = Number(preferredScale);
  if (!Number.isFinite(targetScale) || targetScale <= 0) targetScale = 1;

  var maxByArea = Math.sqrt(IMAGE_MAX_CANVAS_PIXELS / (safeWidth * safeHeight));
  var maxByDimension = IMAGE_MAX_CANVAS_DIMENSION / Math.max(safeWidth, safeHeight);
  var fitted = Math.min(targetScale, maxByArea, maxByDimension);
  var floorScale = Number(minScale);
  if (!Number.isFinite(floorScale) || floorScale <= 0) floorScale = IMAGE_MIN_EXPORT_SCALE;

  if (!Number.isFinite(fitted) || fitted <= 0 || fitted < floorScale) {
    return null;
  }

  return Math.max(floorScale, fitted);
}

export async function mapLimit(array, limit, fn) {
  var results = [];
  var index = 0;
  async function worker() {
    while (index < array.length) {
      var currentIndex = index++;
      results[currentIndex] = await fn(array[currentIndex], currentIndex);
    }
  }
  var workers = [];
  for (var i = 0; i < Math.min(limit, array.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

export function stripInvisibleTextControls(value) {
  return String(value || "")
    .replace(/[\u200b-\u200d\uFEFF\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/[\u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, " ");
}

export function normalizeStructuredLinkPart(value) {
  return stripInvisibleTextControls(value)
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeExportLinkHref(value) {
  var href = String(value || "").trim();
  if (!href) return "";
  href = href.replace(/[\u0000-\u001f\u007f]/g, "");

  var baseHref = typeof window !== "undefined" && window.location && window.location.href
    ? window.location.href
    : "";
  try {
    var url = baseHref ? new URL(href, baseHref) : new URL(href);
    if (!/^(https?:|mailto:|tel:)$/i.test(url.protocol)) {
      return "";
    }
    return url.href;
  } catch (error) {
    return "";
  }
}

export function decodeVisibleTextEscapes(value) {
  var source = String(value || "");
  if (!/\\u[0-9a-fA-F]{4}|\\["']/.test(source)) {
    return source;
  }

  var decodedUnicode = false;
  var text = source.replace(/\\u([0-9a-fA-F]{4})/g, function (match, code) {
    var value = parseInt(code, 16);
    if (!Number.isFinite(value) || value < 32) {
      return match;
    }
    decodedUnicode = true;
    return String.fromCharCode(value);
  });

  if (decodedUnicode) {
    text = text
      .replace(/\\"/g, "\"")
      .replace(/\\'/g, "'");
  }

  return text;
}

export function stripInternalCitationMarkers(value) {
  function isInternalTurnMarker(prefix, target) {
    prefix = String(prefix || "").toLowerCase();
    target = String(target || "").toLowerCase();
    if (!target) return false;
    if (prefix === target && target.length >= 3) return true;
    if (prefix === "cite" || prefix === "citation" || prefix === "source" || prefix === "reference" || prefix === "ref") return true;
    if (!prefix && /^(?:search|source|result|open|view|news)$/.test(target)) return true;
    return false;
  }

  function removeMarkers(text) {
    return String(text || "").replace(/\b([a-z][a-z0-9_]{0,30})?turn\d{1,12}([a-z][a-z0-9_]{0,30})\d+\b/gi, function (match, prefix, target) {
      return isInternalTurnMarker(prefix, target) ? "" : match;
    });
  }

  var lines = String(value || "").split(/\r?\n/);
  return lines.map(function (line) {
    return removeMarkers(line);
  }).filter(function (line, index) {
    return line.trim() || !lines[index].trim();
  }).join("\n")
    .replace(/[ \t]+([。.,，:：;；!?！？])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

export function isInternalToolCallText(value) {
  var trimmed = decodeVisibleTextEscapes(String(value || "")).trim();
  if (!trimmed) return false;
  if (/^(?:search|open|click|find|screenshot|image_query|finance|weather|sports|time)\s*\([\s\S]*\)\s*;?$/i.test(trimmed)) {
    return true;
  }
  if (/^(?:web_)?search\s*query\s*[:=]/i.test(trimmed)) {
    return true;
  }
  return false;
}

function normalizeStructuredUiKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function parseJsonObjectAt(source, startIndex) {
  var text = String(source || "");
  var start = Number(startIndex);
  if (!Number.isFinite(start) || text[start] !== "{") return null;
  var depth = 0;
  var inString = false;
  var escaped = false;

  for (var index = start; index < text.length; index += 1) {
    var char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return {
            value: JSON.parse(text.slice(start, index + 1)),
            end: index + 1
          };
        } catch (error) {
          return null;
        }
      }
    }
  }

  return null;
}

function hasStructuredUiQuestionShape(value, depth) {
  if (!value || depth > 5) return false;
  if (Array.isArray(value)) {
    return value.some(function (item) {
      return hasStructuredUiQuestionShape(item, depth + 1);
    });
  }
  if (typeof value !== "object") return false;

  var keys = Object.keys(value);
  var normalizedKeys = keys.map(normalizeStructuredUiKey);
  var hasQuestionText = normalizedKeys.some(function (key) {
    return key === "question" || key === "prompt" || key === "label" || key === "title";
  });
  var hasChoices = normalizedKeys.some(function (key) {
    return key === "options" || key === "choices" || key === "items" || key === "answers";
  });
  if (hasQuestionText && hasChoices) return true;

  for (var index = 0; index < keys.length; index += 1) {
    var key = normalizedKeys[index];
    if (key === "questions" || key === "fields" || key === "inputs" || key === "controls") {
      if (hasStructuredUiQuestionShape(value[keys[index]], depth + 1)) return true;
    }
  }

  return false;
}

export function isStructuredUiPayloadValue(value, depth, allowShapeOnly) {
  if (!value || typeof value !== "object" || depth > 5) return false;
  if (Array.isArray(value)) {
    return value.some(function (item) {
      return isStructuredUiPayloadValue(item, depth + 1, allowShapeOnly);
    });
  }

  var keys = Object.keys(value);
  var normalizedKeys = keys.map(normalizeStructuredUiKey);
  if (normalizedKeys.some(function (key) {
    return key === "askuserinput" || key === "userinput" || key === "genui";
  })) {
    return true;
  }

  var typeLabel = [
    value.type,
    value.content_type,
    value.kind,
    value.name,
    value.role,
    value.component,
    value.widget
  ].map(function (item) { return String(item || ""); }).join(" ");
  if (/\b(?:genui|interactive|widget|component|form|input|select|multiselect|singleselect|checkbox|radio|choice|question)\b/i.test(typeLabel) &&
      hasStructuredUiQuestionShape(value, depth + 1)) {
    return true;
  }

  return Boolean(allowShapeOnly && hasStructuredUiQuestionShape(value, depth + 1));
}

export function stripSerializedUiPayloads(value) {
  var source = String(value || "");
  if (!source) return "";
  if (!/(?:^|\b)genui\s*\{|\{\s*"|(?:^|\n)[ \t]*genui[A-Za-z0-9_-]{3,64}[ \t]*(?:\n|$)/i.test(source)) {
    return source;
  }

  var markerPattern = /\bgenui\s*(?=\{)/gi;
  var output = "";
  var cursor = 0;
  var match;
  while ((match = markerPattern.exec(source)) !== null) {
    var jsonStart = source.indexOf("{", markerPattern.lastIndex - 1);
    var parsed = parseJsonObjectAt(source, jsonStart);
    if (!parsed || !isStructuredUiPayloadValue(parsed.value, 0, true)) {
      continue;
    }
    output += source.slice(cursor, match.index).replace(/[ \t]+$/g, "");
    cursor = parsed.end;
    markerPattern.lastIndex = parsed.end;
  }

  if (cursor > 0) {
    source = output + source.slice(cursor);
  }

  var trimmed = source.trim();
  if (trimmed[0] === "{") {
    var parsedWhole = parseJsonObjectAt(trimmed, 0);
    if (parsedWhole && parsedWhole.end === trimmed.length && isStructuredUiPayloadValue(parsedWhole.value, 0, false)) {
      return "";
    }
  }

  return stripStandaloneGenUiPlaceholderTokens(source
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

export function isStandaloneGenUiPlaceholderToken(value) {
  var text = stripInvisibleTextControls(value).trim();
  return /^genui[A-Za-z0-9_-]{3,64}$/.test(text);
}

export function hasStandaloneGenUiPlaceholderToken(value) {
  return String(value || "").split(/\r?\n/).some(function (line) {
    return isStandaloneGenUiPlaceholderToken(line);
  });
}

export function stripStandaloneGenUiPlaceholderTokens(value) {
  var source = String(value || "");
  if (!source || !/\bgenui[A-Za-z0-9_-]{3,64}\b/.test(source)) return source;

  var removed = false;
  var lines = source.split(/\r?\n/).filter(function (line) {
    if (isStandaloneGenUiPlaceholderToken(line)) {
      removed = true;
      return false;
    }
    return true;
  });

  if (!removed) return source;
  return lines.join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chooseStructuredLinkText(label, href) {
  var cleanLabel = normalizeStructuredLinkPart(label);
  var cleanHref = normalizeStructuredLinkPart(href);
  if (cleanLabel && cleanLabel !== cleanHref) return cleanLabel;
  return cleanHref;
}

export function sanitizeStructuredLinkText(value) {
  var text = stripInvisibleTextControls(value);
  var previous = "";
  var guard = 0;

  while (text !== previous && guard++ < 2000) {
    previous = text;
    text = text.replace(/url\s*\ue202([^\ue202\ue201]*)\ue202([^\ue202\ue201]*)\ue201/gi, function (match, label, href) {
      return chooseStructuredLinkText(label, href) || "";
    });
    text = text.replace(/\ue202([^\ue202\ue201]*)\ue202([^\ue202\ue201]*)\ue201/g, function (match, label, href) {
      return chooseStructuredLinkText(label, href) || "";
    });
    text = text.replace(/url\s*\ue202([^\ue202\ue201]*)\ue201/gi, function (match, label) {
      return normalizeStructuredLinkPart(label);
    });
    text = text.replace(/\ue202([^\ue202\ue201]*)\ue201/g, function (match, label) {
      return normalizeStructuredLinkPart(label);
    });
  }

  return text
    .replace(/[\ue000-\uf8ff]/g, "")
    .replace(/([\u3001-\u303f\uff01-\uff1f\uff5b-\uff60])[\t \u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]+(?=\S)/g, "$1")
    .replace(/([\u3400-\u9fff]):[\t \u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]+(?=\S)/g, "$1:");
}

export function sanitizeExportText(value) {
  var text = stripInternalCitationMarkers(stripThoughtText(sanitizeStructuredLinkText(stripStandaloneGenUiPlaceholderTokens(stripSerializedUiPayloads(value)))));
  return stripClaudeUnsupportedMediaPlaceholderText(text);
}

export function sanitizeInlineSegmentText(value) {
  var raw = String(value == null ? "" : value);
  if (!raw) return "";
  var leading = raw.match(/^\s+/);
  var trailing = raw.match(/\s+$/);
  var text = sanitizeExportText(raw);
  if (!text && /^\s+$/.test(raw)) {
    return " ";
  }
  if (!text) return "";
  var prefix = leading ? " " : "";
  var suffix = trailing ? " " : "";
  return prefix + text + suffix;
}

function getInlineSegmentsRawText(segments) {
  return (segments || []).map(function (segment) {
    if (typeof segment === "string") return segment;
    return String(segment && segment.text || "");
  }).join("");
}

function getInlineSegmentsSanitizedText(segments) {
  return (segments || []).map(function (segment) {
    if (typeof segment === "string") return sanitizeInlineSegmentText(segment);
    return sanitizeInlineSegmentText(segment && segment.text || "");
  }).join("");
}

export function shouldCoalesceInlineSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return false;
  var raw = getInlineSegmentsRawText(segments);
  if (!/\bgenui\s*\{|ask\s*user\s*input|askuserinput|userinput/i.test(raw) &&
      !hasStandaloneGenUiPlaceholderToken(raw)) {
    return false;
  }
  return sanitizeExportText(raw) !== getInlineSegmentsSanitizedText(segments);
}

export function getCoalescedInlineSegmentsText(segments, fallbackText) {
  var text = sanitizeExportText(getInlineSegmentsRawText(segments));
  if (text) return text;
  return sanitizeExportText(fallbackText || "");
}

export function sanitizeImageAlt(value) {
  var text = sanitizeExportText(value)
    .replace(/\s+/g, " ")
    .trim();
  if (!text || isDalleMetadataText(text) || isGeminiImagePlaceholderText(text)) {
    return "Image";
  }
  if (text.length > 180) {
    return "Image";
  }
  return text;
}

export function stripClaudeUnsupportedMediaPlaceholderText(text) {
  var sawPlaceholder = false;
  var cleaned = String(text || "")
    .split("\n")
    .filter(function (line) {
      if (isClaudeUnsupportedMediaPlaceholderText(line) || isImagePlaceholderTagText(line)) {
        sawPlaceholder = true;
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sawPlaceholder ? cleaned : String(text || "");
}

export function isImagePlaceholderTagText(text) {
  if (!text) return false;
  var normalized = stripInvisibleTextControls(text)
    .replace(/\s+/g, " ")
    .trim();
  return /^\[Image\]$/i.test(normalized);
}

export function isClaudeUnsupportedMediaPlaceholderText(text) {
  if (!text) return false;
  var normalized = stripInvisibleTextControls(text)
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return /^This block is not supported on your current device yet\.?$/i.test(normalized);
}

export function normalizeImageSrc(src) {
  var value = String(src || "").trim();
  if (!value) return "";
  var fileIdMatch = value.match(/(file[-_][A-Za-z0-9_-]+)/);
  if (fileIdMatch) return fileIdMatch[1];
  if (value.indexOf("blob:") === 0 || value.indexOf("data:") === 0) return value;
  return value.split("#")[0];
}

function imageHash(value) {
  var text = String(value || "image");
  var hash = 2166136261;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function inferImageSourceKind(block) {
  var src = String(block && block.src || "");
  var sourceKind = String(block && block.sourceKind || "").toLowerCase();
  if (/^(uploaded|generated|remote|data-url|fallback|blob|thumbnail)$/.test(sourceKind)) return sourceKind;
  if (!src) return "fallback";
  if (src.indexOf("data:") === 0) return "data-url";
  if (src.indexOf("blob:") === 0) return "blob";
  if (/image_generation_content|dalle|generated/i.test(src)) return "generated";
  if (block && (block._chatGptFileId || block._claudeAttachmentId)) return "uploaded";
  return "remote";
}

export function ensureImageBlockMetadata(block, index) {
  if (!block || block.type !== "image") return block;
  var copy = { ...block };
  copy.alt = sanitizeImageAlt(copy.alt);
  copy.normalizedSrc = copy.normalizedSrc || copy._chatGptFileId || copy._claudeAttachmentId || normalizeImageSrc(copy.src);
  copy.sourceKind = inferImageSourceKind(copy);
  if (copy.originalIndex == null || !Number.isFinite(Number(copy.originalIndex))) {
    copy.originalIndex = Number.isFinite(Number(index)) ? Number(index) : 0;
  }
  if (!copy.imageId) {
    var identity = copy._chatGptFileId || copy._claudeAttachmentId || copy.normalizedSrc || copy.src || copy.alt || copy.originalIndex;
    copy.imageId = "img_" + imageHash(copy.sourceKind + ":" + identity);
  }
  return copy;
}

export function getImageDedupKey(block) {
  if (!block || block.type !== "image") return "";
  return block._chatGptFileId ||
    block._claudeAttachmentId ||
    block.normalizedSrc ||
    normalizeImageSrc(block.src);
}

export function isMoreCompleteImageBlock(candidate, current) {
  if (!candidate || candidate.type !== "image") return false;
  if (!current || current.type !== "image") return true;
  if (!current.src && candidate.src) return true;
  if (!current.normalizedSrc && candidate.normalizedSrc) return true;
  return false;
}

export function dedupeImageBlocksWithinMessage(blocks) {
  if (!blocks || !blocks.length) return blocks || [];
  var seen = new Map();
  var result = [];

  blocks.forEach(function (block) {
    if (!block || block.type !== "image") {
      result.push(block);
      return;
    }

    var key = getImageDedupKey(block);
    if (key && seen.has(key)) {
      var existingIndex = seen.get(key);
      if (isMoreCompleteImageBlock(block, result[existingIndex])) {
        result[existingIndex] = block;
      }
      return;
    }
    if (key) {
      seen.set(key, result.length);
    }
    result.push(block);
  });

  return result;
}

export function getBlockText(block) {
  if (!block) return "";
  if (block.type === "table") {
    var rows = (block.headers && block.headers.length ? [block.headers] : []).concat(block.rows || []);
    return rows.map(function (row) {
      return (row || []).map(sanitizeExportText).join(" ");
    }).join(" ");
  }
  if (block.type === "list") {
    return block.items.map(function (item) {
      return sanitizeExportText(item.text) + " " + (item.subItems || []).map(function (sub) { return sanitizeExportText(sub.text); }).join(" ");
    }).join("\n");
  }
  if (block.type === "image") return "[Image: " + (block.alt || "Image") + "]";
  return sanitizeExportText(block.text || "");
}

export function getPlainText(blocks) {
  return (blocks || []).map(getBlockText).filter(Boolean).join("\n\n").trim();
}

export function getCleanedAnchorText(anchor) {
  if (!anchor || !anchor.getAttribute) return null;
  var href = anchor.getAttribute("href") || "";
  var text = normalizeStructuredLinkPart(anchor.textContent);
  var structuredText = normalizeStructuredLinkPart(sanitizeStructuredLinkText(text));
  if (structuredText && structuredText !== text) return structuredText;
  if (!href) return null;

  var match = text.match(/^[^a-zA-Z0-9]*url/i);
  if (!match) return null;

  var urlWordIndex = text.toLowerCase().indexOf("url");
  var withoutUrl = text.slice(urlWordIndex + 3).trim();

  var urlIndex = withoutUrl.toLowerCase().lastIndexOf("http");
  if (urlIndex !== -1 && urlIndex > 0) {
    var cleanLinkText = withoutUrl.slice(0, urlIndex).trim();
    return cleanLinkText || href;
  }

  var domain = href.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].trim();
  if (domain) {
    var domainIndex = withoutUrl.toLowerCase().lastIndexOf(domain.toLowerCase());
    if (domainIndex !== -1) {
      var cleanLinkText = withoutUrl.slice(0, domainIndex).trim();
      cleanLinkText = cleanLinkText.replace(/https?:\/\/$/i, "").replace(/\/+$/, "").trim();
      return cleanLinkText || href;
    }
  }
  return null;
}

function getInlineElementMarks(element, inheritedMarks) {
  var marks = Object.assign({}, inheritedMarks || {});
  var tag = String(element && element.tagName || "").toLowerCase();
  if (tag === "b" || tag === "strong") marks.bold = true;
  if (tag === "i" || tag === "em") marks.italic = true;
  if (tag === "code" || tag === "kbd" || tag === "samp") marks.code = true;
  return marks;
}

function sameInlineSegmentStyle(first, second) {
  if (!first || !second) return false;
  if ((first.href || "") !== (second.href || "")) return false;
  var a = first.marks || {};
  var b = second.marks || {};
  return Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.code) === Boolean(b.code);
}

function pushInlineSegment(segments, text, href, marks) {
  var value = sanitizeInlineSegmentText(text);
  if (value === "") return;
  var segment = { text: value };
  if (href) segment.href = href;
  var normalizedMarks = {};
  if (marks && marks.bold) normalizedMarks.bold = true;
  if (marks && marks.italic) normalizedMarks.italic = true;
  if (marks && marks.code) normalizedMarks.code = true;
  if (Object.keys(normalizedMarks).length) segment.marks = normalizedMarks;

  var previous = segments[segments.length - 1];
  if (sameInlineSegmentStyle(previous, segment)) {
    previous.text += segment.text;
    return;
  }
  segments.push(segment);
}

export function cleanInlineSegments(element) {
  if (!element) return undefined;
  var target = element;
  if (element.cloneNode && element.querySelectorAll) {
    target = element.cloneNode(true);
    Array.prototype.forEach.call(target.querySelectorAll(".sr-only, [class*=\"sr-only\"]"), function (el) {
      el.remove();
    });
  }

  var segments = [];

  function walk(node, inheritedHref, inheritedMarks) {
    if (!node) return;
    if (node.nodeType === 3) {
      pushInlineSegment(segments, node.textContent || "", inheritedHref, inheritedMarks);
      return;
    }
    if (node.nodeType !== 1) return;

    var tag = String(node.tagName || "").toLowerCase();
    if (tag === "br") {
      pushInlineSegment(segments, "\n", inheritedHref, inheritedMarks);
      return;
    }

    var marks = getInlineElementMarks(node, inheritedMarks);
    var href = inheritedHref;
    if (tag === "a") {
      href = normalizeExportLinkHref(node.getAttribute && node.getAttribute("href"));
      var cleanedText = getCleanedAnchorText(node);
      if (cleanedText) {
        pushInlineSegment(segments, cleanedText, href, marks);
        return;
      }
    }

    Array.prototype.forEach.call(node.childNodes || [], function (child) {
      walk(child, href, marks);
    });
  }

  walk(target, "", {});
  var text = segments.map(function (segment) { return segment.text; }).join("").trim();
  return text ? segments : undefined;
}

export function cleanText(element) {
  if (!element) return "";
  var target = element;
  if (element.cloneNode && element.querySelectorAll) {
    target = element.cloneNode(true);
    var srOnlys = target.querySelectorAll(".sr-only, [class*=\"sr-only\"]");
    Array.prototype.forEach.call(srOnlys, function (el) {
      el.remove();
    });

    var anchors = target.querySelectorAll("a");
    Array.prototype.forEach.call(anchors, function (anchor) {
      var cleanedText = getCleanedAnchorText(anchor);
      if (cleanedText) {
        anchor.textContent = cleanedText;
      }
    });
    if (String(target.tagName || "").toLowerCase() === "a") {
      var cleanedText = getCleanedAnchorText(target);
      if (cleanedText) {
        target.textContent = cleanedText;
      }
    }
  }

  return sanitizeExportText(decodeVisibleTextEscapes(String(target.textContent || ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim());
}

export function isChatVaultNode(element) {
  return element && element.classList && (
    element.classList.contains("cv-message-export-button") ||
    element.classList.contains("cv-message-export-menu") ||
    element.classList.contains("cv-export-checkbox-wrapper")
  );
}

export function stripThoughtText(value) {
  return String(value || "")
    .split("\n")
    .filter(function (line) {
      return !isThoughtStatusLine(line);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isThoughtLikeContentValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  var type = String(value.type || value.content_type || value.kind || value.name || value.role || "").trim();
  if (/^(analysis|reasoning|thinking|thought|chain_of_thought|model_thought)$/i.test(type)) {
    return true;
  }

  var label = [
    value.title,
    value.label,
    value.summary,
    value.status,
    value.display_name
  ].map(function (item) { return String(item || ""); }).join(" ");

  return THOUGHT_ATTR_PATTERN.test(label) || isThoughtStatusLine(label);
}

export function isThoughtLikeElement(element) {
  if (!element || !element.getAttribute) return false;
  var label = [
    element.getAttribute("data-testid"),
    element.getAttribute("aria-label"),
    element.getAttribute("data-message-type"),
    element.getAttribute("data-content-type"),
    element.getAttribute("data-state"),
    element.className
  ].map(function (item) { return String(item || ""); }).join(" ");

  if (THOUGHT_ATTR_PATTERN.test(label)) {
    return true;
  }

  var text = String(element.textContent || "")
    .replace(/\s+/g, " ")
    .trim();

  return isThoughtStatusLine(text);
}

var TOOL_CALL_CONTAINER_RE = /\b(?:tool[-_ ]?(?:call|use|input|output|result)|action[-_ ]?card|web[-_ ]?(?:search|browse)|code[-_ ]?interpreter)\b/i;

export function isToolCallContainerElement(element) {
  if (!element || !element.getAttribute) return false;
  var label = [
    element.getAttribute("data-testid"),
    element.getAttribute("data-test-id"),
    element.getAttribute("aria-label"),
    element.getAttribute("data-message-type"),
    element.getAttribute("data-content-type"),
    element.getAttribute("data-action-type"),
    element.className
  ].map(function (item) { return String(item || ""); }).join(" ");
  return TOOL_CALL_CONTAINER_RE.test(label);
}

export function isGoogleUserContentUrl(url) {
  if (!url) return false;
  return url.indexOf("googleusercontent.com") !== -1 || /lh\d+\.google\.com/i.test(url);
}

export function isGoogleAccountAvatarUrl(src) {
  var value = String(src || "").toLowerCase();
  return value.indexOf("googleusercontent.com/a/") !== -1 ||
    value.indexOf("googleusercontent.com/a-/") !== -1 ||
    value.indexOf("googleusercontent.com/ogw/") !== -1 ||
    value.indexOf("/ogw/") !== -1;
}

export function isGoogleNonConversationImageUrl(src) {
  var value = String(src || "").toLowerCase();
  return isGoogleAccountAvatarUrl(value) ||
    /(?:favicon|immersive_entry_chip|entry_chip|logo|sprite|emoji)/i.test(value);
}

export function isTrustedConversationImageSrc(src) {
  var rawValue = String(src || "").trim();
  var value = rawValue.toLowerCase();
  if (!value) return false;

  if (value.indexOf("blob:") === 0) {
    return true;
  }

  var baseHref = typeof window !== "undefined" && window.location && window.location.href
    ? window.location.href
    : undefined;
  var url = null;

  try {
    url = new URL(rawValue, baseHref);
  } catch (error) {
    return false;
  }

  var hostname = url.hostname.toLowerCase();
  var pathname = url.pathname.toLowerCase();
  var isChatGptHost = hostname === "chatgpt.com" || hostname === "chat.openai.com";
  var isClaudeHost = hostname === "claude.ai";

  if (hostname === "oaiusercontent.com" || hostname.endsWith(".oaiusercontent.com")) {
    return true;
  }

  if (hostname === "images.anthropic.com" || hostname === "media.anthropic.com") {
    return true;
  }

  if ((isChatGptHost || isClaudeHost) && (
    pathname.indexOf("/backend-api/files/") !== -1 ||
    pathname.indexOf("/api/organizations/") !== -1 ||
    pathname.indexOf("/multimodal/") !== -1 ||
    pathname.indexOf("/attachments/") !== -1 ||
    pathname.indexOf("/chats/") !== -1
  )) {
    return true;
  }

  return isGoogleUserContentUrl(value) && !isGoogleNonConversationImageUrl(value);
}

export function isPlatformOrSystemIcon(src) {
  if (!src) return false;
  src = String(src).toLowerCase();

  if (isTrustedConversationImageSrc(src)) {
    return false;
  }

  if (src.indexOf("favicon") !== -1 || src.indexOf("avatar") !== -1 || src.indexOf("profile") !== -1) {
    return true;
  }

  if (isGoogleAccountAvatarUrl(src) || src.indexOf("photo.jpg") !== -1) {
    return true;
  }

  if (src.indexOf("google.com") !== -1 || src.indexOf("gstatic.com") !== -1) {
    if (!isGoogleUserContentUrl(src)) {
      return true;
    }
  }

  if (src.indexOf("openai.com") !== -1 && src.indexOf("oaiusercontent") === -1) {
    return true;
  }

  if (src.indexOf("anthropic.com") !== -1 && src.indexOf("usercontent") === -1) {
    return true;
  }

  return false;
}

export function isSubstantialSvg(element) {
  if (!element || String(element.tagName).toLowerCase() !== "svg") return false;

  var parent = element.parentElement;
  while (parent && parent !== document.body) {
    var tag = String(parent.tagName || "").toLowerCase();
    if (tag === "button" || tag === "a") {
      return false;
    }
    var parentTestId = String(parent.getAttribute("data-testid") || "");
    var parentLabel = String(parent.getAttribute("aria-label") || "");
    var parentClassName = String(parent.className || "");
    if (/copy|feedback|rating|share|menu|toolbar|composer/i.test(parentTestId + " " + parentLabel + " " + parentClassName)) {
      return false;
    }
    parent = parent.parentElement;
  }

  var widthAttr = element.getAttribute("width");
  var heightAttr = element.getAttribute("height");
  if (widthAttr && heightAttr) {
    var w = parseInt(widthAttr, 10);
    var h = parseInt(heightAttr, 10);
    if (!isNaN(w) && !isNaN(h) && (w <= 48 && h <= 48)) {
      return false;
    }
  }

  var viewBox = element.getAttribute("viewBox") || "";
  if (viewBox) {
    var parts = viewBox.split(/[ ,]+/).map(parseFloat).filter(function (n) { return !isNaN(n); });
    if (parts.length >= 4) {
      var vW = parts[2];
      var vH = parts[3];
      if (vW <= 48 && vH <= 48) {
        return false;
      }
    }
  }

  var childCount = element.querySelectorAll("path, circle, rect, text, line, polygon, polyline, ellipse, g").length;
  if (childCount < 2) {
    return false;
  }

  return true;
}

export function convertSvgToDataUrl(svgEl) {
  try {
    if (!svgEl) return "";

    var svgStr = "";
    if (typeof XMLSerializer !== "undefined") {
      if (!svgEl.getAttribute("xmlns")) {
        svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      }
      var serializer = new XMLSerializer();
      svgStr = serializer.serializeToString(svgEl);
    } else {
      svgStr = svgEl.outerHTML || "";
    }

    if (!svgStr) return "";

    var base64 = "";
    if (typeof btoa !== "undefined") {
      base64 = btoa(unescape(encodeURIComponent(svgStr)));
    } else if (typeof Buffer !== "undefined") {
      base64 = Buffer.from(svgStr, "utf-8").toString("base64");
    }

    return base64 ? "data:image/svg+xml;base64," + base64 : "";
  } catch (e) {
    return "";
  }
}

export function isImageOrFileSignature(val) {
  if (!val) return false;
  var s = String(val).toLowerCase();
  if (s.indexOf("oaiusercontent") !== -1 || s.indexOf("estuary") !== -1 || s.indexOf("blob:") !== -1 || s.indexOf("backend-api/files") !== -1 || s.indexOf("googleusercontent") !== -1) {
    return true;
  }
  if (/\bfile[-_][a-zA-Z0-9]{15,}\b/.test(val)) {
    return true;
  }
  return false;
}

export function isDalleMetadataText(text) {
  if (!text) return false;
  var trimmed = String(text).trim();
  if (isInternalToolCallText(trimmed)) return true;
  
  // JSON metadata/tool calls
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      var parsed = JSON.parse(trimmed);
      if (parsed && (
        parsed.size || parsed.referenced_image_ids || parsed.n || parsed.prompt ||
        parsed.open || parsed.search_query || parsed.response_length || parsed.ref_id ||
        Array.isArray(parsed.open) || Array.isArray(parsed.search_query)
      )) {
        return true;
      }
    } catch (e) {}
  }
  
  if (/"size"\s*:\s*"\d+x\d+"/.test(trimmed) && (/"referenced_image_ids"/.test(trimmed) || /"prompt"/.test(trimmed))) {
    return true;
  }
  
  if (/"response_length"\s*:\s*"/i.test(trimmed) && (/"open"/i.test(trimmed) || /"search_query"/i.test(trimmed) || /"ref_id"/i.test(trimmed))) {
    return true;
  }

  // Filter Python / Bash tool execution code
  if (/^bash\s+-lc\s+python3/i.test(trimmed)) return true;
  if (trimmed.indexOf("import requests") !== -1 && trimmed.indexOf("requests.get") !== -1) {
    if (trimmed.indexOf("<<'PY'") !== -1 || trimmed.indexOf("PY") !== -1) {
      return true;
    }
  }

  // Filter Python Tracebacks and command errors
  if (trimmed.indexOf("Traceback (most recent call last):") !== -1) return true;
  if (/socket\.gaierror:\s+\[Errno\s+-?\d+\]/i.test(trimmed)) return true;
  if (/\b(?:urllib3|requests)\.exceptions\.\w+Error:/i.test(trimmed)) return true;
  if (/HTTPSConnectionPool\(host=.*Failed\s+to\s+resolve/i.test(trimmed)) return true;
  if (/^Command\s+['"]bash\s+-lc\s+.*failed\s+with\s+status/i.test(trimmed)) return true;

  // Filter DALL-E tool output: file paths, dimensions, aspect ratios, inspection prompts
  if (/\/mnt\/data\//.test(trimmed)) return true;
  if (/\(\s*wxh\s*=/.test(trimmed)) return true;
  if (/exact aspect ratio/.test(trimmed)) return true;
  if (/visually inspect the generated image/.test(trimmed)) return true;
  if (/ghostwriter_images/.test(trimmed)) return true;
  if (/^\S+\.png\s*\(/.test(trimmed)) return true;
  // Filter DALL-E model captions / internal prompt text and watermark tokens
  if (/\<\|has_watermark\|\>/.test(trimmed)) return true;
  if (/\<\|no_watermark\|\>/.test(trimmed)) return true;
  if (/^Model caption\s*:/i.test(trimmed)) return true;
  if (/close to aspect ratio/i.test(trimmed)) return true;
  if (/^I'll create\b.*\bimage\b/i.test(trimmed) && trimmed.length < 200) return true;
  if (/^I'll generate\b.*\bimage\b/i.test(trimmed) && trimmed.length < 200) return true;

  return false;
}


var GEMINI_MIME_TYPE_RE = /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|tiff|avif|heic|heif)$/i;
var GEMINI_BASE64_BLOB_RE = /^\$[A-Za-z0-9+/=]{20,}$/;
var GEMINI_IMAGE_FILENAME_RE = /^image_[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp|bmp|tiff|avif|heic|heif)$/i;

export function isGeminiImagePlaceholderText(text) {
  if (!text) return false;
  var trimmed = String(text).trim();
  if (/googleusercontent\.com\/image_generation_content/i.test(trimmed)) return true;
  if (GEMINI_MIME_TYPE_RE.test(trimmed)) return true;
  if (GEMINI_BASE64_BLOB_RE.test(trimmed)) return true;
  if (GEMINI_IMAGE_FILENAME_RE.test(trimmed)) return true;
  if (/^`?image_generation\.ImageGenerationUsecase\b/.test(trimmed)) return true;
  return false;
}

export function hasImageAttachment(element) {
  if (!element) return false;

  var tag = String(element.tagName || "").toLowerCase();
  if (tag === "img") {
    var src = element.src || element.getAttribute("src") || element.getAttribute("data-src") || "";
    if (src && !isPlatformOrSystemIcon(src)) {
      return true;
    }
  }
  if (tag === "svg" && isSubstantialSvg(element)) {
    return true;
  }
  var selfStyle = element.getAttribute && element.getAttribute("style") || "";
  if (selfStyle && selfStyle.indexOf("background-image") !== -1) {
    var bgMatch = selfStyle.match(/url\(['"]?([^'")]+)['"]?\)/);
    if (bgMatch && bgMatch[1] && !isPlatformOrSystemIcon(bgMatch[1])) {
      return true;
    }
  }

  if (!element.querySelectorAll) return false;

  var imgs = element.querySelectorAll("img");
  for (var i = 0; i < imgs.length; i++) {
    var src = imgs[i].src || imgs[i].getAttribute("src") || imgs[i].getAttribute("data-src") || imgs[i].getAttribute("srcset") || "";
    if (!src) return true;
    if (!isPlatformOrSystemIcon(src)) {
      return true;
    }
  }

  var svgs = element.querySelectorAll("svg");
  for (var i = 0; i < svgs.length; i++) {
    if (isSubstantialSvg(svgs[i])) {
      return true;
    }
  }

  var all = element.querySelectorAll("*");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.attributes) {
      for (var j = 0; j < el.attributes.length; j++) {
        var val = el.attributes[j].value || "";
        if (val && isImageOrFileSignature(val)) {
          if (!isPlatformOrSystemIcon(val)) {
            return true;
          }
        }
      }
    }
  }

  if (element.attributes) {
    for (var j = 0; j < element.attributes.length; j++) {
      var val = element.attributes[j].value || "";
      if (val && isImageOrFileSignature(val)) {
        if (!isPlatformOrSystemIcon(val)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function isIgnoredRoleLabel(text) {
  if (!text) return false;
  var trimmed = String(text).replace(/\s+/g, " ").trim();
  var match = trimmed === "你说" || trimmed === "You said" || trimmed === "你说：" || trimmed === "You said:" ||
         trimmed === "Gemini" || trimmed === "Gemini 说" || trimmed === "Gemini 说：" || trimmed === "Gemini said" ||
         trimmed === "Gemini said:" || trimmed === "Gemini said：" ||
         /^\s*(你说|你|you said|you|gemini|gemini 说|gemini said)[:：,\s]*$/i.test(trimmed);
  if (match) {
  }
  return match;
}

export function getElementLabel(element) {
  if (!element) return "";
  return [
    element.tagName,
    element.getAttribute && element.getAttribute("data-testid"),
    element.getAttribute && element.getAttribute("data-language"),
    element.getAttribute && element.getAttribute("aria-label"),
    element.className
  ].map(function (item) { return String(item || ""); }).join(" ");
}

export function isCodeLikeElement(element) {
  if (!element || !element.tagName) return false;
  var tag = String(element.tagName || "").toLowerCase();
  if (tag === "pre") return true;
  var label = getElementLabel(element);
  return /\b(?:code|syntax|highlight|shiki|hljs|font-mono|whitespace-pre|language-[a-z0-9_-]+)\b/i.test(label);
}

export function isIgnoredContentNode(element) {
  if (!element || !element.tagName || isChatVaultNode(element)) return true;
  var className = String(element.className || "");
  if (className.indexOf("sr-only") !== -1) return true;
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
  if (hasImageAttachment(element)) return false;
  if (isThoughtLikeElement(element)) return true;

  var tag = String(element.tagName || "").toLowerCase();
  var textContent = String(element.textContent || "").replace(/\s+/g, " ").trim();
  
  // 过滤常见的控制和操作按钮纯文本，特别是在非代码的段落中
  if (!/^(pre|code)$/.test(tag)) {
    var textLower = textContent.toLowerCase();
    if (textLower === "编辑" || textLower === "edit" || textLower === "copy" || textLower === "复制" || textLower === "share" || textLower === "分享" || textLower === "重新生成" || textLower === "regenerate") {
      return true;
    }
  }

  var isUserQueryContent = isInsideUserQuery(element);
  if (!isUserQueryContent) {
    if (!/^(pre|code)$/.test(tag)) {
      if (isIgnoredRoleLabel(textContent) || isGeminiUINoiseText(textContent, element)) {
        return true;
      }
    }
  } else {
    if (!/^(pre|code)$/.test(tag)) {
      if (isIgnoredRoleLabel(textContent)) {
        return true;
      }
    }
  }
  if (/^(script|style|noscript|template|button|path)$/.test(tag)) return true;
  if (tag === "svg" && !isSubstantialSvg(element)) return true;
  if (isToolCallContainerElement(element)) return true;
  
  var testId = String(element.getAttribute("data-testid") || "");
  var label = String(element.getAttribute("aria-label") || "");
  var className = String(element.className || "");
  if (THOUGHT_ATTR_PATTERN.test(testId + " " + label + " " + className)) {
    return true;
  }

  var testIdStr = String(element.getAttribute("data-test-id") || "");
  var fullLabel = testId + " " + testIdStr + " " + label + " " + className;

  // 不管是不是 user query，如果明确是操作栏按钮/组件，必须忽略
  if (/copy|feedback|rating|share|menu|toolbar|composer|message-actions|message_actions/i.test(fullLabel) && !isCodeLikeElement(element)) {
    return true;
  }
  if (/edit-message|edit_message|edit-button|edit_button/i.test(fullLabel)) {
    return true;
  }

  if (!isUserQueryContent) {
    if (/suggestion|chip|prompt-chip|follow-up|welcome|onboarding/i.test(fullLabel)) {
      return true;
    }
    if (/feedback|rating|thumb|vote|like|dislike|good-response|bad-response|report/i.test(fullLabel)) {
      return true;
    }
    if (/draft|candidate|response-tab|show-drafts/i.test(fullLabel)) {
      return true;
    }
  }
  if (typeof window !== "undefined" && window.getComputedStyle) {
    var style = window.getComputedStyle(element);
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  }
  return false;
}

// --- LaTeX & Canvas Utils migrated from image.js to resolve circular dependency ---

var mathSymbols = {
  "\\\\alpha": "α", "\\\\beta": "β", "\\\\gamma": "γ", "\\\\delta": "δ", "\\\\epsilon": "ε",
  "\\\\zeta": "ζ", "\\\\eta": "η", "\\\\theta": "θ", "\\\\iota": "ι", "\\\\kappa": "κ",
  "\\\\lambda": "λ", "\\\\mu": "μ", "\\\\nu": "ν", "\\\\xi": "ξ", "\\\\pi": "π",
  "\\\\rho": "ρ", "\\\\sigma": "σ", "\\\\tau": "τ", "\\\\upsilon": "υ", "\\\\phi": "φ",
  "\\\\chi": "χ", "\\\\psi": "ψ", "\\\\omega": "ω",
  "\\\\Gamma": "Γ", "\\\\Delta": "Δ", "\\\\Theta": "Θ", "\\\\Lambda": "Λ", "\\\\Xi": "Ξ",
  "\\\\Pi": "Π", "\\\\Sigma": "Σ", "\\\\Phi": "Φ", "\\\\Psi": "Ψ", "\\\\Omega": "Ω",
  "\\\\infty": "∞", "\\\\sum": "∑", "\\\\int": "∫", "\\\\times": "×", "\\\\div": "÷",
  "\\\\pm": "±", "\\\\le": "≤", "\\\\ge": "≥", "\\\\ne": "≠", "\\\\approx": "≈",
  "\\\\cdot": "·", "\\\\partial": "∂", "\\\\nabla": "∇", "\\\\in": "∈", "\\\\notin": "∉",
  "\\\\forall": "∀", "\\\\exists": "∃", "\\\\varnothing": "∅", "\\\\subset": "⊂",
  "\\\\supset": "⊃", "\\\\cap": "∩", "\\\\cup": "∪", "\\\\rightarrow": "→",
  "\\\\leftarrow": "←", "\\\\neq": "≠", "\\\\leq": "≤", "\\\\geq": "≥", "\\\\sqrt": "√"
};

var superscripts = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "x": "ˣ", "i": "ⁱ"
};

var subscripts = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", "a": "ₐ", "e": "ₑ", "o": "ₒ", "x": "ₓ",
  "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "p": "ₚ", "s": "ₛ", "t": "ₜ"
};

export function formatLatexUnicode(text) {
  if (!text) return "";

  function replaceSupersSubscripts(expr) {
    expr = expr.replace(/\^\{([^}]+)\}/g, function(m, p1) {
      return p1.split("").map(function(c) { return superscripts[c] || c; }).join("");
    });
    expr = expr.replace(/\^([a-zA-Z0-9+-])/g, function(m, p1) {
      return superscripts[p1] || p1;
    });
    expr = expr.replace(/_\{([^}]+)\}/g, function(m, p1) {
      return p1.split("").map(function(c) { return subscripts[c] || c; }).join("");
    });
    expr = expr.replace(/_([a-zA-Z0-9+-])/g, function(m, p1) {
      return subscripts[p1] || p1;
    });
    return expr;
  }

  function looksLikeLatexMath(math) {
    var expr = String(math || "").trim();
    return Boolean(expr) && (
      /\\[a-zA-Z]+/.test(expr) ||
      /[\^_{}]/.test(expr) ||
      /[a-zA-Z]\s*[=<>]\s*[a-zA-Z0-9]/.test(expr) ||
      /[0-9]\s*[=<>]\s*[a-zA-Z]/.test(expr) ||
      /[a-zA-Z]\s*[+\-*/]\s*[a-zA-Z0-9]/.test(expr) ||
      /[0-9]\s*[+\-*/]\s*[a-zA-Z]/.test(expr)
    );
  }

  function cleanLatexMath(math) {
    Object.keys(mathSymbols).forEach(function(cmd) {
      math = math.replace(new RegExp(cmd + "(?![a-zA-Z])", "g"), mathSymbols[cmd]);
    });
    math = math.replace(/\\mathrm\{([^}]+)\}/g, "$1");
    math = math.replace(/\\mathbf\{([^}]+)\}/g, "$1");
    math = math.replace(/\\mathit\{([^}]+)\}/g, "$1");
    math = math.replace(/\\text\{([^}]+)\}/g, "$1");
    math = math.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "($1)/($2)");
    math = replaceSupersSubscripts(math);
    math = math.replace(/\\/g, "");
    return math.trim();
  }

  var formatted = text;
  formatted = formatted.replace(/\$\$([\s\S]+?)\$\$/g, function(m, p1) {
    return "\n" + cleanLatexMath(p1) + "\n";
  });
  formatted = formatted.replace(/\\\[([\s\S]+?)\\\]/g, function(m, p1) {
    return "\n" + cleanLatexMath(p1) + "\n";
  });
  formatted = formatted.replace(/\$([^$]+?)\$/g, function(m, p1) {
    if (!looksLikeLatexMath(p1)) {
      return m;
    }
    return cleanLatexMath(p1);
  });
  formatted = formatted.replace(/\\\(([\s\S]+?)\\\)/g, function(m, p1) {
    return cleanLatexMath(p1);
  });
  formatted = formatted.replace(/(^|\n)([^\n]*\\(?:frac|sqrt|times|div|cdot|pm|leq?|geq?|neq?|approx|alpha|beta|gamma|delta|theta|lambda|pi|sigma|sum|int)\b[^\n]*)(?=\n|$)/g, function(m, prefix, line) {
    return prefix + (looksLikeLatexMath(line) ? cleanLatexMath(line) : line);
  });

  return formatted;
}

export function hasLatexMathSyntax(value) {
  var text = String(value || "");
  return /\\\[|\\\(|\$\$/.test(text) ||
    /\$[^$\n]*(?:\\[a-zA-Z]+|[\^_{}]|[A-Za-z0-9]\s*[=<>+\-*/]\s*[A-Za-z0-9])[^$\n]*\$/.test(text) ||
    /\\(?:frac|sqrt|times|div|cdot|pm|leq?|geq?|neq?|approx|alpha|beta|gamma|delta|theta|lambda|pi|sigma|sum|int)\b/.test(text);
}

export function formatExportTextForDisplay(value) {
  return formatLatexUnicode(sanitizeExportText(value));
}

function formatInlineTextForDisplay(value) {
  return formatLatexUnicode(sanitizeInlineSegmentText(value));
}

function hasInlineCodeSegment(segments) {
  return (segments || []).some(function (segment) {
    var marks = segment && segment.marks || {};
    return Boolean(segment && (segment.code || marks.code));
  });
}

export function createCanvas(width, height, scale) {
  var canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  var ctx = canvas.getContext("2d");
  var nativeFillText = ctx.fillText.bind(ctx);
  var nativeMeasureText = ctx.measureText.bind(ctx);
  ctx.fillText = function (text, x, y, maxWidth) {
    var cleaned = sanitizeExportText(text);
    var rx = Math.round(x);
    var ry = Math.round(y);
    return typeof maxWidth === "number"
      ? nativeFillText(cleaned, rx, ry, maxWidth)
      : nativeFillText(cleaned, rx, ry);
  };
  ctx.measureText = function (text) {
    return nativeMeasureText(sanitizeExportText(text));
  };
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas: canvas, ctx: ctx };
}

export function canvasToBlob(canvas, type, quality, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error("Canvas export timed out. Please try exporting again."));
    }, Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : CANVAS_TO_BLOB_TIMEOUT_MS);

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }

    try {
      canvas.toBlob(function (blob) {
        if (!blob) {
          finish(reject, new Error("Canvas export failed."));
          return;
        }
        finish(resolve, blob);
      }, type || "image/png", quality);
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function blobToDataUrl(blob) {
  if (typeof FileReader === "undefined" && blob && typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      var binary = "";
      var chunk = 8192;
      for (var index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
      }
      var base64 = "";
      if (typeof btoa === "function") {
        base64 = btoa(binary);
      } else if (typeof Buffer !== "undefined") {
        base64 = Buffer.from(binary, "binary").toString("base64");
      } else {
        throw new Error("Failed to read generated file.");
      }
      return "data:" + (blob.type || "application/octet-stream") + ";base64," + base64;
    });
  }

  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onloadend = function () { resolve(reader.result); };
    reader.onerror = function () { reject(new Error("Failed to read generated file.")); };
    reader.readAsDataURL(blob);
  });
}

export function wrapText(ctx, text, maxWidth, font) {
  ctx.font = font;
  var lines = [];
  String(text || "").split("\n").forEach(function (paragraph) {
    if (!paragraph.trim()) {
      lines.push("");
      return;
    }

    var tokens = paragraph.match(/[\u4e00-\u9fa5]|([a-zA-Z0-9'-]+)|(\s+)|[^\u4e00-\u9fa5\w]/g) || [];
    var line = "";

    tokens.forEach(function (token) {
      var test = line + token;
      if (ctx.measureText(test).width > maxWidth && line !== "") {
        var isAvoidHeadPunc = /^[，。？！、：）】]/.test(token);
        if (isAvoidHeadPunc && line.length > 0) {
          var lastChar = line.slice(-1);
          lines.push(line.slice(0, -1).trimEnd());
          line = lastChar + token;
        } else {
          lines.push(line.trimEnd());
          line = token;
        }
      } else {
        line = test;
      }

      if (ctx.measureText(line).width > maxWidth) {
        var currentText = line;
        while (currentText && ctx.measureText(currentText).width > maxWidth) {
          var lo = 1;
          var hi = currentText.length;
          var best = 1;
          while (lo <= hi) {
            var mid = Math.floor((lo + hi) / 2);
            var candidate = currentText.substring(0, mid);
            if (ctx.measureText(candidate).width <= maxWidth) {
              best = mid;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
          // Guard: ensure we always advance at least 1 char to prevent infinite loop
          var safeBest = Math.max(1, best);
          lines.push(currentText.substring(0, safeBest).trimEnd());
          currentText = currentText.substring(safeBest);
        }
        line = currentText;
      }
    });

    if (line.trim()) {
      lines.push(line.trimEnd());
    }
  });

  return lines;
}

export function cleanInlineMarkdownText(text) {
  var cleaned = sanitizeExportText(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
  return formatLatexUnicode(cleaned);
}

export function drawRoundRect(ctx, x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export function drawPremiumCard(ctx, x, y, width, height, radius, fill, stroke, shadowColor) {
  ctx.save();
  if (shadowColor && shadowColor !== "transparent") {
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = 24;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 10;
  }
  
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  
  ctx.restore();
  
  if (stroke) {
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

export function drawMacTerminalHeader(ctx, x, y, width, height, lang) {
  ctx.save();
  drawPremiumCard(ctx, x, y, width, height, 8, "#1e293b", null, null);
  
  var colors = ["#ef4444", "#fbbf24", "#22c55e"];
  var dotX = x + 16;
  var dotY = y + height / 2;
  colors.forEach(function (color, index) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(dotX + index * 14, dotY, 4.5, 0, Math.PI * 2);
    ctx.fill();
  });
  
  if (lang) {
    ctx.font = "800 10px sans-serif";
    ctx.fillStyle = "#94a3b8";
    var label = lang.toUpperCase();
    var textW = ctx.measureText(label).width;
    ctx.fillText(label, x + width - textW - 16, dotY + 3.5);
  }
  ctx.restore();
}

export function parseInlineMarkdown(text) {
  var str = String(text == null ? "" : text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  var chunks = [];
  var i = 0;
  while (i < str.length) {
    if (str.indexOf("**", i) === i || str.indexOf("__", i) === i) {
      var marker = str.substr(i, 2);
      var endIdx = str.indexOf(marker, i + 2);
      if (endIdx !== -1) {
        chunks.push({ text: str.substring(i + 2, endIdx), bold: true });
        i = endIdx + 2;
        continue;
      }
    }
    if (str.indexOf("`", i) === i) {
      var endIdx = str.indexOf("`", i + 1);
      if (endIdx !== -1) {
        chunks.push({ text: str.substring(i + 1, endIdx), code: true });
        i = endIdx + 1;
        continue;
      }
    }
    if (str.indexOf("*", i) === i || str.indexOf("_", i) === i) {
      var marker = str.substr(i, 1);
      var endIdx = str.indexOf(marker, i + 1);
      if (endIdx !== -1) {
        chunks.push({ text: str.substring(i + 1, endIdx), italic: true });
        i = endIdx + 1;
        continue;
      }
    }

    var nextMarkerIdx = -1;
    var markers = ["**", "__", "*", "_", "`"];
    for (var m = 0; m < markers.length; m++) {
      var idx = str.indexOf(markers[m], i);
      if (idx !== -1 && (nextMarkerIdx === -1 || idx < nextMarkerIdx)) {
        nextMarkerIdx = idx;
      }
    }

    if (nextMarkerIdx === -1) {
      chunks.push({ text: str.substring(i) });
      break;
    } else {
      if (nextMarkerIdx > i) {
        chunks.push({ text: str.substring(i, nextMarkerIdx) });
      }
      if (nextMarkerIdx === i) {
        var markerLen = 1;
        if (str.indexOf("**", i) === i || str.indexOf("__", i) === i) {
          markerLen = 2;
        }
        var markerText = str.substring(i, i + markerLen);
        chunks.push({ text: markerText });
        i += markerLen;
      } else {
        i = nextMarkerIdx;
      }
    }
  }
  return chunks;
}

export function getFontsForStyle(baseFont, DESIGN_fonts) {
  var str = String(baseFont || "");
  var sizeMatch = str.match(/(\d+)px/);
  var size = sizeMatch ? sizeMatch[1] + "px" : "15px";

  var family = "Inter, sans-serif";
  if (sizeMatch) {
    family = str.substring(sizeMatch.index + sizeMatch[0].length).trim();
  }

  var monoFamily = (DESIGN_fonts && DESIGN_fonts.mono) || "Courier New, monospace";

  return {
    normal: "normal " + size + " " + family,
    bold: "800 " + size + " " + family,
    italic: "italic " + size + " " + family,
    code: size + " " + monoFamily
  };
}

export function wrapRichText(ctx, text, maxWidth, baseFont, DESIGN_fonts) {
  var fonts = getFontsForStyle(baseFont, DESIGN_fonts);
  var lines = [];
  var currentLine = { chunks: [] };

  function getFont(chunk) {
    if (chunk.bold) return fonts.bold;
    if (chunk.italic) return fonts.italic;
    if (chunk.code) return fonts.code;
    return fonts.normal;
  }

  var paragraphs = String(text == null ? "" : text).split("\n");
  paragraphs.forEach(function (paragraph, pIndex) {
    if (pIndex > 0) {
      if (currentLine.chunks.length > 0) {
        lines.push(currentLine);
        currentLine = { chunks: [] };
      }
      if (!paragraph.trim()) {
        lines.push({ chunks: [{ text: "", normal: true }] });
        return;
      }
    }

    if (pIndex === 0 && !paragraph.trim()) {
      lines.push({ chunks: [{ text: "", normal: true }] });
      return;
    }

    var chunks = parseInlineMarkdown(paragraph);
    chunks.forEach(function (chunk) {
      var font = getFont(chunk);
      ctx.font = font;

      var tokens = chunk.text.match(/[\u4e00-\u9fa5]|([a-zA-Z0-9'-]+)|(\s+)|[^\u4e00-\u9fa5\w]/g) || [];
      if (tokens.length === 0 && chunk.text) {
        tokens = [chunk.text];
      }

      tokens.forEach(function (token) {
        var currentLineWidth = 0;
        currentLine.chunks.forEach(function (c) {
          ctx.font = getFont(c);
          currentLineWidth += ctx.measureText(c.text).width;
        });

        ctx.font = font;
        var tokenWidth = ctx.measureText(token).width;

        if (currentLineWidth + tokenWidth > maxWidth && currentLineWidth > 0) {
          var isAvoidHeadPunc = /^[，。？！、：）】]/.test(token);
          if (isAvoidHeadPunc && currentLine.chunks.length > 0) {
            var lastChunk = currentLine.chunks[currentLine.chunks.length - 1];
            if (lastChunk && lastChunk.text.length > 0) {
              var lastChar = lastChunk.text.slice(-1);
              lastChunk.text = lastChunk.text.slice(0, -1);
              if (lastChunk.text.length === 0) {
                currentLine.chunks.pop();
              }
              lines.push(currentLine);
              currentLine = { chunks: [] };
              currentLine.chunks.push({
                text: lastChar + token,
                bold: chunk.bold,
                italic: chunk.italic,
                code: chunk.code
              });
              return;
            }
          }
          lines.push(currentLine);
          currentLine = { chunks: [] };
          currentLineWidth = 0;
        }

        if (tokenWidth > maxWidth) {
          var currentText = token;
          while (currentText) {
            var lo = 1;
            var hi = currentText.length;
            var best = 1;
            while (lo <= hi) {
              var mid = Math.floor((lo + hi) / 2);
              var candidate = currentText.substring(0, mid);
              ctx.font = font;
              if (ctx.measureText(candidate).width <= maxWidth) {
                best = mid;
                lo = mid + 1;
              } else {
                hi = mid - 1;
              }
            }
            // Guard: ensure we always advance at least 1 char to prevent infinite loop
            var safeBest = Math.max(1, best);
            var subPart = currentText.substring(0, safeBest);
            currentLine.chunks.push({
              text: subPart,
              bold: chunk.bold,
              italic: chunk.italic,
              code: chunk.code
            });
            lines.push(currentLine);
            currentLine = { chunks: [] };
            currentLineWidth = 0;
            currentText = currentText.substring(safeBest);
          }
        } else {
          var lastChunk = currentLine.chunks[currentLine.chunks.length - 1];
          if (lastChunk && lastChunk.bold === chunk.bold && lastChunk.italic === chunk.italic && lastChunk.code === chunk.code) {
            lastChunk.text += token;
          } else {
            currentLine.chunks.push({
              text: token,
              bold: chunk.bold,
              italic: chunk.italic,
              code: chunk.code
            });
          }
        }
      });
    });
  });

  if (currentLine.chunks.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

export function getInlinePlainText(value) {
  if (value && Array.isArray(value.segments) && value.segments.length) {
    if (shouldCoalesceInlineSegments(value.segments)) {
      return formatLatexUnicode(getCoalescedInlineSegmentsText(value.segments, value.text));
    }
    return formatLatexUnicode(value.segments.map(function (segment) {
      return sanitizeInlineSegmentText(segment && segment.text || "");
    }).join(""));
  }
  return formatExportTextForDisplay(value && value.text || "");
}

function canWrapWithMarkdown(text, marker) {
  return text && String(text).indexOf(marker) === -1;
}

export function getInlineRichText(value) {
  if (!value || !Array.isArray(value.segments) || !value.segments.length) {
    return formatExportTextForDisplay(value && value.text || "");
  }
  if (shouldCoalesceInlineSegments(value.segments)) {
    return formatLatexUnicode(getCoalescedInlineSegmentsText(value.segments, value.text));
  }
  if (!hasInlineCodeSegment(value.segments) && hasLatexMathSyntax(getInlineSegmentsRawText(value.segments))) {
    return formatLatexUnicode(getInlineSegmentsSanitizedText(value.segments));
  }
  return value.segments.map(function (segment) {
    var marks = segment.marks || {};
    var isCode = Boolean(marks.code || segment.code);
    var text = isCode
      ? sanitizeInlineSegmentText(segment && segment.text || "")
      : formatInlineTextForDisplay(segment && segment.text || "");
    if (!text) return "";
    if (isCode && canWrapWithMarkdown(text, "`")) {
      return "`" + text + "`";
    }
    if (marks.bold && canWrapWithMarkdown(text, "*")) {
      text = "**" + text + "**";
    }
    if (marks.italic && canWrapWithMarkdown(text, "*") && canWrapWithMarkdown(text, "_")) {
      text = "*" + text + "*";
    }
    return text;
  }).join("");
}

export function getPrefixedInlineSegments(prefix, segments) {
  if (!Array.isArray(segments) || !segments.length) {
    return undefined;
  }
  if (shouldCoalesceInlineSegments(segments)) {
    var coalesced = getCoalescedInlineSegmentsText(segments, "");
    return coalesced ? [{ text: sanitizeInlineSegmentText(prefix || "") + coalesced }] : undefined;
  }
  var normalizedPrefix = sanitizeExportText(prefix || "");
  var out = segments.map(function (segment) {
    return {
      text: sanitizeInlineSegmentText(segment && segment.text || ""),
      href: segment && segment.href || "",
      marks: segment && segment.marks || {}
    };
  }).filter(function (segment) {
    return segment.text !== "";
  });
  if (normalizedPrefix) {
    out.unshift({ text: normalizedPrefix });
  }
  return out.length ? out : undefined;
}
