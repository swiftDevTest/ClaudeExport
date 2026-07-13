import { SELECTION_STYLE_ID, t } from './utils.js';
import { parseMessages } from './platform.js';
import {
  getSelectionDomKey,
  getSelectionMessageKey,
  getSortedSelectionEntries,
  rememberSelectionMessage,
  cloneExportMessage,
  hashString,
  selectionSelectedMessages,
  selectionOrderCounter,
  selectionDomKeys,
  selectionDomKeyCounter,
  resetSelectionState
} from './platform.js';

var selectionCleanup = [];
var selectionWrappers = [];
var selectionSelectedKeys = new Set();
var inlineButtonCleanup = [];
var inlineMenu = null;
var inlineExportHandler = null;
var selectionChangeCallbacks = [];

function getSelectionThemeVars() {
  var productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  var vars = typeof productConfig.getThemeVars === "function" ? productConfig.getThemeVars() : {};
  return {
    primary: vars["--cv-primary"] || "#c96442",
    rgb: vars["--cv-primary-rgb"] || "201, 100, 66",
    border: vars["--accent-wash"] || "#fff1e8"
  };
}

function isChatVaultNode(element) {
  return element && element.classList && (
    element.classList.contains("cv-message-export-button") ||
    element.classList.contains("cv-message-export-menu") ||
    element.classList.contains("cv-export-checkbox-wrapper")
  );
}

function getMessageOriginalIndex(message, fallback) {
  var index = Number(message && message.index);
  return Number.isFinite(index) ? index : (Number.isFinite(Number(fallback)) ? Number(fallback) : Number.MAX_SAFE_INTEGER);
}

function ensureSelectionStyles() {
  if (typeof document === "undefined" || document.getElementById(SELECTION_STYLE_ID)) return;
  var style = document.createElement("style");
  style.id = SELECTION_STYLE_ID;
  var theme = getSelectionThemeVars();
  style.textContent = [
    ".chatvault-export-selectable{border-radius:16px!important;transition:background .14s ease,box-shadow .14s ease,padding .14s ease!important;}",
    ".chatvault-export-selectable.chatvault-export-needs-gutter{box-sizing:border-box!important;padding-left:72px!important;}",
    ".chatvault-export-selectable-content{border-radius:12px!important;cursor:pointer!important;transition:background .14s ease,box-shadow .14s ease!important;}",
    ".chatvault-export-selected{background:rgba(" + theme.rgb + ",.10)!important;box-shadow:inset 4px 0 0 rgba(" + theme.rgb + ",.82),0 0 0 1px rgba(" + theme.rgb + ",.18)!important;}",
    ".chatvault-export-selected-content{background:rgba(" + theme.rgb + ",.055)!important;box-shadow:0 0 0 1px rgba(" + theme.rgb + ",.12)!important;}",
    ".cv-export-checkbox-wrapper{position:fixed;z-index:2147483000;pointer-events:none;width:32px;height:32px;}",
    ".cv-export-checkbox{width:32px;height:32px;border-radius:10px;border:1px solid " + theme.border + ";background:#fff;color:#fff;box-shadow:0 10px 24px rgba(" + theme.rgb + ",.18);font-size:15px;font-weight:900;line-height:1;cursor:pointer;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;transition:background .14s ease,border-color .14s ease,transform .14s ease,box-shadow .14s ease;}",
    ".cv-export-checkbox:hover{transform:translateY(-1px);border-color:" + theme.primary + ";box-shadow:0 12px 26px rgba(" + theme.rgb + ",.22);}",
    ".cv-export-checkbox[data-selected='true']{background:" + theme.primary + ";border-color:" + theme.primary + ";color:#fff;}"
  ].join("");
  document.documentElement.appendChild(style);
}

function shouldIgnoreSelectionClick(event) {
  var target = event && event.target;
  if (!target || !(target instanceof Element)) return true;
  if (isChatVaultNode(target) || target.closest(".cv-export-checkbox-wrapper,.cv-message-export-menu,.cv-message-export-button")) return true;
  return Boolean(target.closest("a,button,input,textarea,select,summary,[role='button'],[contenteditable='true']"));
}

function enterSelectionMode() {
  exitSelectionMode();
  ensureSelectionStyles();
  selectionSelectedKeys = new Set();
  resetSelectionState();

  var updatePositions = function () {
    selectionWrappers.forEach(function (wrapper) {
      var anchor = wrapper.__chatVaultAnchor;
      var turn = wrapper.__chatVaultTurnElement;
      if (!anchor || !anchor.isConnected) {
        wrapper.style.display = "none";
        return;
      }

      var rect = anchor.getBoundingClientRect();
      var turnRect = turn && turn.getBoundingClientRect ? turn.getBoundingClientRect() : rect;
      if ((rect.width <= 0 || rect.height <= 0) && turnRect) {
        rect = turnRect;
      }

      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.width <= 0 || rect.height <= 0) {
        wrapper.style.display = "none";
        return;
      }

      if (turn) {
        turn.classList.toggle("chatvault-export-needs-gutter", rect.left < 66 && turnRect.left < 66);
        if (turn.classList.contains("chatvault-export-needs-gutter")) {
          rect = anchor.getBoundingClientRect();
        }
      }

      var visibleTop = Math.max(rect.top, 10);
      var visibleBottom = Math.min(rect.bottom, window.innerHeight - 10);
      var left = Math.max(10, Math.min(rect.left - 66, window.innerWidth - 46));
      var top = visibleTop + Math.max(32, visibleBottom - visibleTop) / 2 - 16;
      top = Math.max(10, Math.min(top, window.innerHeight - 42));

      wrapper.style.display = "block";
      wrapper.style.left = left + "px";
      wrapper.style.top = top + "px";
    });
  };

  function removeWrapper(wrapper) {
    if (!wrapper) return;
    if (wrapper.__chatVaultTurnElement) {
      wrapper.__chatVaultTurnElement.classList.remove("chatvault-export-selectable", "chatvault-export-selected", "chatvault-export-needs-gutter");
    }
    if (wrapper.__chatVaultHighlightElement) {
      wrapper.__chatVaultHighlightElement.classList.remove("chatvault-export-selectable-content", "chatvault-export-selected-content");
    }
    if (wrapper.__chatVaultClickTarget && wrapper.__chatVaultClickHandler) {
      wrapper.__chatVaultClickTarget.removeEventListener("click", wrapper.__chatVaultClickHandler, true);
    }
    wrapper.remove();
  }

  function clearVisibleControls() {
    selectionWrappers.forEach(removeWrapper);
    selectionWrappers = [];
  }

  function renderVisibleControls() {
    var newMessages = parseMessages();
    var canReuse = selectionWrappers.length === newMessages.length && selectionWrappers.every(function (wrapper, idx) {
      return wrapper.__chatVaultTurnElement === newMessages[idx].turnElement &&
             wrapper.__chatVaultAnchor === (newMessages[idx].contentElement || newMessages[idx].turnElement);
    });

    if (canReuse) {
      updatePositions();
      return;
    }

    clearVisibleControls();
    newMessages.forEach(function (message, index) {
      var turnEl = message.turnElement;
      if (!turnEl || !(turnEl instanceof Element)) return;
      var anchorEl = message.contentElement instanceof Element ? message.contentElement : turnEl;
      var key = getSelectionMessageKey(message, index);
      var selected = selectionSelectedKeys.has(key);

      turnEl.classList.add("chatvault-export-selectable");
      turnEl.classList.toggle("chatvault-export-selected", selected);
      anchorEl.classList.add("chatvault-export-selectable-content");
      anchorEl.classList.toggle("chatvault-export-selected-content", selected);

      var wrapper = document.createElement("div");
      wrapper.className = "cv-export-checkbox-wrapper";
      wrapper.dataset.index = String(index);
      wrapper.dataset.role = message.role;
      wrapper.dataset.selectionKey = key;
      wrapper.__chatVaultAnchor = anchorEl;
      wrapper.__chatVaultTurnElement = turnEl;
      wrapper.__chatVaultHighlightElement = anchorEl;
      wrapper.__chatVaultClickTarget = turnEl;
      wrapper.__chatVaultRole = message.role;
      wrapper.__chatVaultMessage = message;

      var checkbox = document.createElement("button");
      checkbox.className = "cv-export-checkbox";
      checkbox.type = "button";
      checkbox.dataset.index = String(index);
      checkbox.dataset.selectionKey = key;
      checkbox.dataset.selected = selected ? "true" : "false";
      checkbox.textContent = selected ? "✓" : "";
      checkbox.setAttribute("aria-label", t("aria_select_message_export", "Select message for export"));
      checkbox.setAttribute("aria-pressed", String(selected));
      checkbox.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggleCheckbox(checkbox);
      });
      var messageClickHandler = function (event) {
        if (shouldIgnoreSelectionClick(event)) return;
        event.preventDefault();
        event.stopPropagation();
        toggleCheckbox(checkbox);
      };
      wrapper.__chatVaultClickHandler = messageClickHandler;
      turnEl.addEventListener("click", messageClickHandler, true);
      wrapper.appendChild(checkbox);
      document.body.appendChild(wrapper);
      selectionWrappers.push(wrapper);
    });
    updatePositions();
  }

  renderVisibleControls();

  window.addEventListener("scroll", updatePositions, true);
  window.addEventListener("resize", updatePositions, true);
  selectionCleanup.push(function () {
    window.removeEventListener("scroll", updatePositions, true);
    window.removeEventListener("resize", updatePositions, true);
    clearVisibleControls();
  });

  var refreshTimer = null;
  var mutationRoot = document.querySelector("main") || document.body;
  var observer = new MutationObserver(function () {
    var mutations = Array.prototype.slice.call(arguments[0] || []);
    var onlySelectionChrome = mutations.length && mutations.every(function (mutation) {
      var nodes = Array.prototype.slice.call(mutation.addedNodes || []).concat(Array.prototype.slice.call(mutation.removedNodes || []));
      return nodes.length && nodes.every(function (node) {
        return node && node.nodeType === 1 && node.classList && node.classList.contains("cv-export-checkbox-wrapper");
      });
    });
    if (onlySelectionChrome) return;
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      renderVisibleControls();
    }, 120);
  });
  observer.observe(mutationRoot, { childList: true, subtree: true });
  selectionCleanup.push(function () {
    observer.disconnect();
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  });
}

function toggleCheckbox(checkbox, force) {
  var next = typeof force === "boolean" ? force : checkbox.dataset.selected !== "true";
  checkbox.dataset.selected = next ? "true" : "false";
  checkbox.setAttribute("aria-pressed", String(next));
  checkbox.textContent = next ? "✓" : "";
  var wrapper = checkbox.closest(".cv-export-checkbox-wrapper");
  if (wrapper) {
    var key = wrapper.dataset.selectionKey || checkbox.dataset.selectionKey || "";
    if (key) {
      if (next) {
        selectionSelectedKeys.add(key);
        rememberSelectionMessage(key, wrapper.__chatVaultMessage, Number(wrapper.dataset.index));
      } else {
        selectionSelectedKeys.delete(key);
        selectionSelectedMessages.delete(key);
      }
    }
    if (wrapper.__chatVaultTurnElement) {
      wrapper.__chatVaultTurnElement.classList.toggle("chatvault-export-selected", next);
    }
    if (wrapper.__chatVaultHighlightElement) {
      wrapper.__chatVaultHighlightElement.classList.toggle("chatvault-export-selected-content", next);
    }
  }
  notifySelectionChange();
}

function exitSelectionMode() {
  selectionCleanup.splice(0).forEach(function (cleanup) {
    try { cleanup(); } catch (error) { /* ignore */ }
  });
  selectionWrappers = [];
  selectionSelectedKeys = new Set();
  resetSelectionState();
  notifySelectionChange();
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

function getSelectedMessages() {
  var seenKeys = new Set();
  var entries = [];

  parseMessages().forEach(function (message, index) {
    var key = getSelectionMessageKey(message, index);
    if (!selectionSelectedKeys.has(key)) return;
    var cached = selectionSelectedMessages.get(key);
    seenKeys.add(key);
    entries.push({
      order: cached ? cached.order : index,
      index: getMessageOriginalIndex(message, index),
      message: cloneExportMessage(message)
    });
  });

  selectionSelectedMessages.forEach(function (entry, key) {
    if (!seenKeys.has(key)) entries.push(entry);
  });

  return getSortedSelectionEntries(entries)
    .map(function (entry) { return cloneExportMessage(entry.message); });
}

function getSelectedCount() {
  return selectionSelectedMessages.size || getSelectedIndices().length;
}

function clearSelection() {
  selectionSelectedKeys = new Set();
  resetSelectionState();
  document.querySelectorAll(".cv-export-checkbox").forEach(function (checkbox) {
    toggleCheckbox(checkbox, false);
  });
  notifySelectionChange();
}

function selectAllAssistant() {
  document.querySelectorAll(".cv-export-checkbox").forEach(function (checkbox) {
    var wrapper = checkbox.closest(".cv-export-checkbox-wrapper");
    toggleCheckbox(checkbox, wrapper && wrapper.__chatVaultRole === "assistant");
  });
}

function clearInlineExportButtons() {
  inlineExportHandler = null;
  closeInlineMenu();
  inlineButtonCleanup.splice(0).forEach(function (cleanup) {
    try { cleanup(); } catch (error) { /* ignore */ }
  });
  document.querySelectorAll(".cv-message-export-button").forEach(function (button) {
    button.remove();
  });
}

function installInlineExportButtons() {
  clearInlineExportButtons();
}

function openInlineMenu(anchor, index) {
  closeInlineMenu();
  inlineMenu = document.createElement("div");
  inlineMenu.className = "cv-message-export-menu";
  inlineMenu.style.cssText = "position:fixed;z-index:2147483001;min-width:148px;background:#fff;border:1px solid #d9e2ec;border-radius:12px;box-shadow:0 18px 45px rgba(15,23,42,.18);padding:6px;";
  ["pdf", "word", "image", "html"].forEach(function (format) {
    var item = document.createElement("button");
    item.type = "button";
    item.textContent = format === "word" ? "Word DOCX" : format.toUpperCase();
    item.style.cssText = "display:block;width:100%;border:0;background:transparent;color:#17202a;text-align:left;border-radius:9px;padding:9px 10px;font:700 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;";
    item.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      closeInlineMenu();
      if (inlineExportHandler) inlineExportHandler(format, index);
    });
    inlineMenu.appendChild(item);
  });
  document.body.appendChild(inlineMenu);
  var rect = anchor.getBoundingClientRect();
  inlineMenu.style.left = Math.max(12, Math.min(rect.right - 148, window.innerWidth - 164)) + "px";
  inlineMenu.style.top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 150)) + "px";
  window.setTimeout(function () {
    document.addEventListener("click", closeInlineMenu, { once: true, capture: true });
  }, 0);
}

function closeInlineMenu() {
  if (inlineMenu) {
    inlineMenu.remove();
    inlineMenu = null;
  }
}

function onSelectionChange(callback) {
  if (typeof callback !== "function") return function () {};
  selectionChangeCallbacks.push(callback);
  return function () {
    var idx = selectionChangeCallbacks.indexOf(callback);
    if (idx >= 0) selectionChangeCallbacks.splice(idx, 1);
  };
}

function notifySelectionChange() {
  var count = getSelectedCount();
  for (var i = 0; i < selectionChangeCallbacks.length; i++) {
    try { selectionChangeCallbacks[i](count); } catch (e) {}
  }
}

export {
  ensureSelectionStyles,
  shouldIgnoreSelectionClick,
  enterSelectionMode,
  toggleCheckbox,
  exitSelectionMode,
  getSelectedIndices,
  getSelectedMessages,
  getSelectedCount,
  clearSelection,
  selectAllAssistant,
  clearInlineExportButtons,
  installInlineExportButtons,
  openInlineMenu,
  closeInlineMenu,
  onSelectionChange
};
