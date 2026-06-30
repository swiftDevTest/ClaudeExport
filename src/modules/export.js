(function initChatVaultExport() {
  "use strict";

  var PLATFORM_CHATGPT = "chatgpt";
  var PLATFORM_CLAUDE = "claude";
  var PLATFORM_GEMINI = "gemini";

  var IMAGE_MAX_CHARS = 12000;
  var IMAGE_MAX_MESSAGES = 40;
  var IMAGE_MAX_CODE_CHARS = 8000;
  var IMAGE_RENDER_WIDTH = 1080;
  var IMAGE_EXPORT_SCALE = 4;
  var IMAGE_MAX_CANVAS_PIXELS = 72000000;
  var IMAGE_MAX_RENDER_HEIGHT = Math.floor(IMAGE_MAX_CANVAS_PIXELS / (IMAGE_RENDER_WIDTH * IMAGE_EXPORT_SCALE * IMAGE_EXPORT_SCALE));
  var EXTENSION_CONTEXT_INVALIDATED_CODE = "CHATVAULT_EXTENSION_CONTEXT_INVALIDATED";
  var EXTENSION_CONTEXT_INVALIDATED_ERROR_NAME = "ChatVaultExtensionContextInvalidatedError";
  var EXTENSION_CONTEXT_INVALIDATED_MESSAGE = "ChatVault was updated. Refresh this page to continue.";

  var DEFAULT_EXPORT_SETTINGS = {
    export_ai_replies_only: false,
    show_export_time: true,
    show_conversation_title: true,
    show_platform_name: true,
    show_role_labels: true,
    show_chatvault_badge: false,
    include_source_url: false,
    align_user_messages_right: true,
    export_style: "default"
  };

  var EXPORT_THEMES = {
    default: true,
    oxford: true,
    mckinsey: true,
    newsprint: true,
    aurora: true,
    terminal: true,
    editorial: true,
    midnight: true
  };

  function normalizeBooleanSetting(value, defaultValue) {
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

  function normalizeExportSettings(input) {
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

  function detectPlatform() {
    var hostname = window.location.hostname;
    if (/^(chatgpt\.com|chat\.openai\.com)$/.test(hostname)) return PLATFORM_CHATGPT;
    if (/(^|\.)claude\.ai$/.test(hostname)) return PLATFORM_CLAUDE;
    if (hostname === "gemini.google.com") return PLATFORM_GEMINI;
    return "";
  }

  function getConversationTitle() {
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

  function sanitizeFilename(name) {
    return String(name || "Untitled Chat").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().substring(0, 80) || "Untitled Chat";
  }

  function formatDateDisplay(date) {
    var d = date || new Date();
    var locale = undefined;
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
        locale = chrome.i18n.getUILanguage() || undefined;
      }
    } catch (e) {}
    return d.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function buildFilename(format, scope, metadata) {
    var title = sanitizeFilename((metadata && metadata.title) || getConversationTitle());
    var ext = format === "word" ? "docx" : format === "image" ? "png" : "pdf";
    return title + "." + ext;
  }

  function replaceFileExtension(filename, nextExt) {
    var cleanExt = String(nextExt || "").replace(/^\./, "");
    var base = String(filename || "ChatVault-export").replace(/\.[^.]+$/, "");
    return base + (cleanExt ? "." + cleanExt : "");
  }

  var _mods = null;
  var _ready = null;

  function isExtensionContextInvalidated(error) {
    var code = error && typeof error === "object" ? error.code : "";
    var name = error && typeof error === "object" ? error.name : "";
    var message = String(error && typeof error === "object" ? error.message || error : error || "");

    return code === EXTENSION_CONTEXT_INVALIDATED_CODE ||
      name === EXTENSION_CONTEXT_INVALIDATED_ERROR_NAME ||
      /extension context (?:is )?invalidated|context invalidated/i.test(message);
  }

  function createExtensionContextInvalidatedError() {
    var error = new Error(EXTENSION_CONTEXT_INVALIDATED_MESSAGE);
    error.name = EXTENSION_CONTEXT_INVALIDATED_ERROR_NAME;
    error.code = EXTENSION_CONTEXT_INVALIDATED_CODE;
    return error;
  }

  function normalizeModuleLoadError(error) {
    if (isExtensionContextInvalidated(error)) {
      return createExtensionContextInvalidatedError();
    }

    return new Error("[ChatVault] Export sub-modules failed: " + (error && error.message));
  }

  function resolveModulePath(name) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
        return chrome.runtime.getURL(name);
      }
    } catch (e) {
      if (isExtensionContextInvalidated(e)) {
        throw createExtensionContextInvalidatedError();
      }
    }

    // Allow relative path fallback in Node.js unit testing environments
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
      return "./" + name.replace("src/modules/", "");
    }

    throw createExtensionContextInvalidatedError();
  }

  function loadSubmodules() {
    try {
      return Promise.all([
        import(resolveModulePath("src/modules/export/utils.js")),
        import(resolveModulePath("src/modules/export/platform.js")),
        import(resolveModulePath("src/modules/export/parser-dom.js")),
        import(resolveModulePath("src/modules/export/selection.js")),
        import(resolveModulePath("src/modules/export/engine.js")),
        import(resolveModulePath("src/modules/export/media.js")),
        import(resolveModulePath("src/modules/export/zip.js")),
        import(resolveModulePath("src/modules/export/save.js")),
        import(resolveModulePath("src/modules/export/builders/docx.js")),
        import(resolveModulePath("src/modules/export/builders/image.js")),
        import(resolveModulePath("src/modules/export/builders/pdf.js")),
        import(resolveModulePath("src/modules/export/builders/markdown.js")),
        import(resolveModulePath("src/modules/export/ui-controller.js")),
        import(resolveModulePath("src/modules/export/platform-fetchers.js")),
        import(resolveModulePath("src/modules/export/message-adapter.js"))
      ]);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function ensureModules() {
    if (!_ready) {
      _ready = loadSubmodules().then(function (arr) {
        _mods = {
          utils: arr[0], platform: arr[1], parserDom: arr[2], selection: arr[3],
          engine: arr[4], media: arr[5], zip: arr[6],
          save: arr[7], docx: arr[8], image: arr[9], pdf: arr[10],
          markdown: arr[11], uiController: arr[12], platformFetchers: arr[13], messageAdapter: arr[14]
        };
      }).catch(function (err) {
        _ready = null;
        ready = null;
        globalThis.CHATVAULT_EXPORT_READY = null;
        throw normalizeModuleLoadError(err);
      });
      ready = _ready;
      globalThis.CHATVAULT_EXPORT_READY = ready;
    }
    return _ready;
  }

  var ready = null;
  var isTestEnv = false;
  try {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
      isTestEnv = true;
    }
  } catch (e) {}

  if (isTestEnv) {
    ready = ensureModules();
  } else {
    // 真实浏览器插件环境中不自动预加载，只在此 API 触发时拉取
  }

  function assertMods() {
    if (!_mods) throw new Error("ChatVault export modules not loaded yet");
  }

  var _progressUiRequestId = 0;

  function runWhenProgressUiReady(requestId, callback) {
    return ensureModules().then(function () {
      if (requestId !== _progressUiRequestId) return undefined;
      return callback();
    }).catch(function () {
      return undefined;
    });
  }

  globalThis.CHATVAULT_EXPORT = {
    createExportUiController: function (opts) {
      assertMods();
      return _mods.uiController.createExportUiController(opts);
    },
    createExportPlatformFetchers: function (opts) {
      assertMods();
      return _mods.platformFetchers.createExportPlatformFetchers(opts);
    },
    createExportMessageAdapter: function (opts) {
      assertMods();
      return _mods.messageAdapter.createExportMessageAdapter(opts);
    },
    renderProgressUI: function (format, progress, targetShadowRoot, onCancel) {
      var requestId = ++_progressUiRequestId;
      if (_mods) {
        return _mods.uiController.renderProgressUI(format, progress, targetShadowRoot, onCancel);
      }
      return runWhenProgressUiReady(requestId, function () {
        return _mods.uiController.renderProgressUI(format, progress, targetShadowRoot, onCancel);
      });
    },
    hideProgressUI: function () {
      _progressUiRequestId++;
      if (!_mods) return undefined;
      return _mods.uiController.hideProgressUI();
    },
    buildMarkdownBlob: function (messages, metadata, settings, options) {
      assertMods();
      return _mods.markdown.buildMarkdownBlob(messages, metadata, settings, options);
    },
    DEFAULT_EXPORT_SETTINGS: DEFAULT_EXPORT_SETTINGS,
    IMAGE_LIMITS: {
      maxChars: IMAGE_MAX_CHARS,
      maxMessages: IMAGE_MAX_MESSAGES,
      maxCodeChars: IMAGE_MAX_CODE_CHARS,
      maxRenderHeight: IMAGE_MAX_RENDER_HEIGHT
    },
    normalizeExportSettings: normalizeExportSettings,
    detectPlatform: detectPlatform,
    getConversationTitle: getConversationTitle,
    buildFilename: buildFilename,

    parseMessages: function () {
      if (!_mods) { return []; }
      return _mods.platform.parseMessages();
    },
    getMessageCount: function () {
      if (!_mods) { return 0; }
      return _mods.platform.parseMessages().length;
    },
    getImageEligibility: function (opts) { return _mods ? _mods.platform.getImageEligibility(opts) : { ok: true, pending: true }; },
    getPlainText: function (msgs) { return _mods ? _mods.platform.getPlainText(msgs) : ""; },
    ensureImageBlockMetadata: function (block, index) { assertMods(); return _mods.utils.ensureImageBlockMetadata(block, index); },
    dedupeImageBlocksWithinMessage: function (blocks) { assertMods(); return _mods.utils.dedupeImageBlocksWithinMessage(blocks); },

    enterSelectionMode: function () { if (_mods) _mods.selection.enterSelectionMode(); },
    exitSelectionMode: function () { if (_mods) _mods.selection.exitSelectionMode(); },
    getSelectedIndices: function () { return _mods ? _mods.selection.getSelectedIndices() : []; },
    getSelectedMessages: function () { return _mods ? _mods.selection.getSelectedMessages() : []; },
    getSelectedCount: function () { return _mods ? _mods.selection.getSelectedCount() : 0; },
    clearSelection: function () { if (_mods) _mods.selection.clearSelection(); },
    selectAllAssistant: function () { if (_mods) _mods.selection.selectAllAssistant(); },
    installInlineExportButtons: function () { if (_mods) _mods.selection.installInlineExportButtons(); },
    clearInlineExportButtons: function () { if (_mods) _mods.selection.clearInlineExportButtons(); },
    closeInlineMenu: function () { if (_mods) _mods.selection.closeInlineMenu(); },
    onSelectionChange: function (callback) { return _mods ? _mods.selection.onSelectionChange(callback) : function () {}; },

    preload: function () {
      return ensureModules();
    },
    createExportBlob: function (opts) {
      return ensureModules().then(function () { return _mods.engine.createExportBlob(opts); });
    },
    startExport: function (opts) {
      return ensureModules().then(function () { return _mods.engine.startExport(opts); });
    },
    saveBlob: function (blob, filename, options) { return ensureModules().then(function () { return _mods.save.saveBlob(blob, filename, options); }); },
    createZip: function (entries) { return ensureModules().then(function () { return _mods.zip.createZip(entries); }); },
    exportConversation: function (format) { return ensureModules().then(function () { return _mods.engine.startExport({ format: format, scope: "conversation", settings: DEFAULT_EXPORT_SETTINGS }); }); },
    exportSelectedMessages: function (format, selectedIndices) { return ensureModules().then(function () { return _mods.engine.startExport({ format: format, scope: "selected", selectedIndices: selectedIndices, settings: DEFAULT_EXPORT_SETTINGS }); }); },
    renderImagePreview: function (messages, settings) { return ensureModules().then(function () { return _mods.engine.renderImagePreview(messages, settings); }); },
    buildDocxBlob: function (messages, metadata, settings) { return ensureModules().then(function () { return _mods.docx.buildDocxBlob(messages, metadata, settings); }); },

    _test: {
      createPdfFromJpegs: function (jpegs) { return ensureModules().then(function () { return _mods.pdf.createPdfFromJpegs(jpegs); }); },
      createZip: function (entries) { return ensureModules().then(function () { return _mods.zip.createZip(entries); }); },
      crc32: function (bytes) { return ensureModules().then(function () { return _mods.zip.crc32(bytes); }); },
      resolveMessages: function (opts) { assertMods(); return _mods.platform.resolveMessages(opts); },
      getSortedSelectionEntries: function (entries) { assertMods(); return _mods.platform.getSortedSelectionEntries(entries); },
      chooseMoreCompleteBlocks: function (primary, fallback) { assertMods(); return _mods.parserDom.chooseMoreCompleteBlocks(primary, fallback); },
      fetchImageBytes: function (url, timeout) { return ensureModules().then(function () { return _mods.media.fetchImageBytes(url, timeout); }); },
      saveBlobWithDialog: function (blob, filename, options) { return ensureModules().then(function () { return _mods.save.saveBlobWithDialog(blob, filename, options); }); },
      isPlatformOrSystemIcon: function (src) { assertMods(); return _mods.utils.isPlatformOrSystemIcon(src); },
      isTrustedConversationImageSrc: function (src) { assertMods(); return _mods.utils.isTrustedConversationImageSrc(src); },
      isGeminiUINoiseText: function (text, element) { assertMods(); return _mods.utils.isGeminiUINoiseText(text, element); },
      isGeminiUINoiseContainer: function (element) { assertMods(); return _mods.utils.isGeminiUINoiseContainer(element); },
      isIgnoredContentNode: function (node) { assertMods(); return _mods.utils.isIgnoredContentNode(node); },
      cleanText: function (text) { assertMods(); return _mods.utils.cleanText(text); },
      cleanInlineSegments: function (element) { assertMods(); return _mods.utils.cleanInlineSegments(element); },
      sanitizeExportText: function (text) { assertMods(); return _mods.utils.sanitizeExportText(text); },
      sanitizeImageAlt: function (text) { assertMods(); return _mods.utils.sanitizeImageAlt(text); },
      ensureImageBlockMetadata: function (block, index) { assertMods(); return _mods.utils.ensureImageBlockMetadata(block, index); },
      canvasToBlob: function (canvas, type, quality, timeoutMs) { assertMods(); return _mods.utils.canvasToBlob(canvas, type, quality, timeoutMs); },
      getFittedCanvasScale: function (width, height, preferredScale, minScale) { assertMods(); return _mods.utils.getFittedCanvasScale(width, height, preferredScale, minScale); }
    }
  };

  globalThis.CHATVAULT_EXPORT_READY = ready;
})();
