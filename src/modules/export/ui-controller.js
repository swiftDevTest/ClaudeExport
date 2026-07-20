function t(key, defaultText, ...args) {
  if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.t === "function") {
    return globalThis.CHATVAULT_I18N.t(key, defaultText, ...args);
  }
  if (args.length > 0) {
    var formatted = defaultText;
    args.forEach(function (arg, index) {
      formatted = formatted.replace(new RegExp(`\\$${index + 1}`, "g"), arg);
    });
    return formatted;
  }
  return defaultText;
}

function defaultEscapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createExportUiController(options) {
  var deps = options || {};
  var menu = deps.exportFormatMenu;
  var exportState = deps.exportState || {};
  var exportFormats = deps.exportFormats || ["pdf", "word", "image", "markdown", "html", "txt", "json"];
  var t = deps.t || function (key, defaultText) { return defaultText || key; };
  var escapeHtml = deps.escapeHtml || defaultEscapeHtml;
  var selectedLabel = deps.selectedLabel || function (count) { return String(count) + " Selected"; };

  function hideFormatMenu() {
    exportState.menuContext = null;
    exportState.menuAnchor = null;
    if (menu) {
      menu.textContent = "";
      menu.classList.add("is-hidden");
    }

    if (typeof deps.onMenuClosed === "function") {
      deps.onMenuClosed();
    }
  }

  function isQuickExportMenuOpen() {
    var context = exportState.menuContext;
    return Boolean(menu) &&
      !menu.classList.contains("is-hidden") &&
      context &&
      !context.compact &&
      (context.mode === "current" || context.mode === "selected");
  }

  function replayQuickExportButtonAnimation(button) {
    if (!button || !button.classList) {
      return;
    }

    button.classList.remove("is-quick-export-animating");
    if (typeof button.offsetWidth === "number") {
      void button.offsetWidth;
    }
    button.classList.add("is-quick-export-animating");
    window.setTimeout(function () {
      button.classList.remove("is-quick-export-animating");
    }, 460);
  }

  function getMenuPosition(anchor, fallbackX, fallbackY) {
    var rect = anchor && typeof anchor.getBoundingClientRect === "function" ? anchor.getBoundingClientRect() : null;
    var x = rect ? rect.left : (fallbackX == null ? window.innerWidth - 190 : fallbackX);
    var y = rect ? rect.bottom + 8 : (fallbackY == null ? 120 : fallbackY);
    var width = exportState.menuContext && exportState.menuContext.compact ? 148 : 260;
    return {
      x: Math.max(12, Math.min(x, window.innerWidth - width - 12)),
      y: Math.max(12, Math.min(y, window.innerHeight - 235))
    };
  }

  function getFormatButtonMarkup(format) {
    var labels = {
      pdf: t("format_pdf", "PDF"),
      word: t("format_word", "Word"),
      image: t("format_image", "Image"),
      markdown: t("format_markdown", "Markdown"),
      html: t("format_html", "HTML"),
      txt: t("content_format_text", "Text"),
      json: "JSON"
    };
    var badges = {
      pdf: "P",
      word: "W",
      image: "I",
      markdown: "M",
      html: "H",
      txt: "T",
      json: "J"
    };
    return '<button class="cv-export-format-button" type="button" data-action="export-format-choice" data-export-format="' + format + '">' +
      '<span class="cv-export-format-badge">' + badges[format] + '</span><span>' + escapeHtml(labels[format]) + "</span></button>";
  }

  function openFormatMenu(context, anchor, fallbackX, fallbackY) {
    if (!menu) return;
    var selectModeActive = Boolean(deps.isSelectModeActive && deps.isSelectModeActive());
    var nextContext = {
      mode: selectModeActive && context.mode === "current" ? "selected" : context.mode,
      folderId: context.folderId || "",
      folderChatId: context.folderChatId || "",
      recordType: context.recordType || "",
      recordKey: context.recordKey || "",
      title: context.title || t("btn_export", "Export"),
      compact: Boolean(context.compact),
      hideTitle: Boolean(context.hideTitle),
      keepSourceMenu: Boolean(context.keepSourceMenu),
      source: context.source || ""
    };
    exportState.menuContext = nextContext;
    exportState.menuAnchor = anchor || exportState.menuAnchor || null;
    var position = getMenuPosition(anchor, fallbackX, fallbackY);
    if (!nextContext.keepSourceMenu && typeof deps.closeSourceMenus === "function") {
      deps.closeSourceMenus();
    }

    var showSelect = nextContext.mode === "current";
    var title = nextContext.mode === "selected" ? t("export_selected_as", "Export Selected As") : nextContext.title;
    var formatButtons = exportFormats.map(getFormatButtonMarkup).join("");
    var selectionCount = typeof deps.getSelectionCount === "function" ? deps.getSelectionCount() : 0;
    var selectionTools = nextContext.compact
      ? ""
      : selectModeActive
        ? '\n          <div class="cv-export-menu-tools">\n            <div class="cv-export-menu-status">' + escapeHtml(selectedLabel(selectionCount)) + '</div>\n            <button class="cv-export-format-button is-secondary" type="button" data-action="export-select-ai">' + escapeHtml(t("btn_select_ai", "AI Replies")) + '</button>\n            <button class="cv-export-format-button is-secondary" type="button" data-action="export-clear-selection">' + escapeHtml(t("btn_clear", "Clear")) + '</button>\n            <button class="cv-export-format-button is-danger" type="button" data-action="export-select-cancel">' + escapeHtml(t("btn_cancel_select", "Cancel Select")) + '</button>\n          </div>\n        '
        : showSelect
          ? '\n            <div class="cv-export-menu-tools">\n              <button class="cv-export-format-button is-secondary" type="button" data-action="quick-select-export">' + escapeHtml(t("btn_select_messages", "Select Messages")) + '</button>\n            </div>\n          '
          : "";

    menu.dataset.variant = nextContext.compact ? "compact" : "quick";
    menu.dataset.source = nextContext.source || "";
    menu.innerHTML =
      (nextContext.hideTitle ? "" : '<div class="cv-export-format-title">' + escapeHtml(title) + "</div>") +
      '<div class="cv-export-format-actions">' + formatButtons + "</div>" +
      selectionTools;
    menu.style.left = position.x + "px";
    menu.style.top = position.y + "px";
    menu.classList.remove("is-hidden");

    if (typeof deps.onMenuOpened === "function") {
      deps.onMenuOpened();
    }
  }

  return {
    hideFormatMenu: hideFormatMenu,
    isQuickExportMenuOpen: isQuickExportMenuOpen,
    replayQuickExportButtonAnimation: replayQuickExportButtonAnimation,
    openFormatMenu: openFormatMenu,
    getMenuPosition: getMenuPosition,
    getFormatButtonMarkup: getFormatButtonMarkup
  };
}

// Global export progress strip management inside ChatVault Export.
var progressStripElement = null;

function clamp01(value) {
  var number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function getPositiveInteger(value) {
  var number = Math.floor(Number(value) || 0);
  return number > 0 ? number : 0;
}

function getFormatDisplayName(format) {
  var key = String(format || "pdf").toLowerCase();
  if (key === "word") return "DOCX";
  if (key === "markdown") return "Markdown";
  if (key === "html") return "HTML";
  if (key === "image") return "Image";
  if (key === "txt") return "Text";
  if (key === "json") return "JSON";
  return key.toUpperCase();
}

function getProgressMode(progress) {
  return progress && progress.mode === "batch" ? "batch" : "single";
}

function getProgressPercent(progress) {
  var source = progress && progress.overallProgress != null ? progress.overallProgress : progress && progress.progress;
  return Math.round(clamp01(source) * 100);
}

function getProgressTitle(format, progress) {
  if (progress && progress.title) {
    return String(progress.title);
  }
  if (getProgressMode(progress) === "batch") {
    return String((progress && progress.label) || "Batch export");
  }
  return "Exporting " + getFormatDisplayName(format);
}

function getProgressDetail(progress, percent) {
  if (getProgressMode(progress) !== "batch") {
    return percent + "%";
  }

  var total = getPositiveInteger(progress && (progress.total || progress.batchTotal));
  var current = getPositiveInteger(progress && (progress.current || progress.batchIndex));
  var completed = getPositiveInteger(progress && (progress.completed || progress.batchCompleted));
  var issues = getPositiveInteger(progress && (progress.issues || progress.failed));
  var parts = [];

  if (total) {
    var progressStr = Math.min(current || completed, total) + "/" + total;
    parts.push(t("export_progress_detail_conversations", "$1 conversations", progressStr));
  }
  if (completed) {
    parts.push(t("export_progress_detail_ready", "$1 ready", completed));
  }
  if (issues) {
    parts.push(issues === 1
      ? t("export_progress_detail_issue", "$1 issue", issues)
      : t("export_progress_detail_issues", "$1 issues", issues));
  }
  parts.push(percent + "%");

  return parts.join(" / ");
}

export function renderProgressUI(format, progress, targetShadowRoot, onCancel) {
  if (!targetShadowRoot) return;

  progress = progress || {};
  var mode = getProgressMode(progress);
  var percent = getProgressPercent(progress);

  if (!progressStripElement) {
    progressStripElement = document.createElement("div");
    progressStripElement.className = "cv-export-progress-strip";
    progressStripElement.setAttribute("role", "status");
    progressStripElement.setAttribute("aria-live", "polite");
    progressStripElement.innerHTML = `
      <div class="cv-export-progress-main">
        <div class="cv-export-progress-copy">
          <div class="cv-export-progress-title"></div>
          <div class="cv-export-progress-status"></div>
        </div>
        <div class="cv-export-progress-percent"></div>
        <button class="cv-export-progress-cancel" type="button">${t("btn_cancel", "Cancel")}</button>
      </div>
      <div class="cv-export-progress-track" aria-hidden="true">
        <div class="cv-export-progress-fill"></div>
      </div>
      <div class="cv-export-progress-detail"></div>
      <div class="cv-export-progress-notice" hidden></div>
    `;
    targetShadowRoot.appendChild(progressStripElement);
  } else if (!progressStripElement.isConnected || progressStripElement.parentElement !== targetShadowRoot) {
    targetShadowRoot.appendChild(progressStripElement);
  }

  var title = getProgressTitle(format, progress);
  var status = String(progress.message || t("content_progress_checking_export_access", "Preparing export..."));
  var notice = String(progress.notice || "");
  var noticeSeverity = String(progress.noticeSeverity || "");

  progressStripElement.dataset.mode = mode;
  progressStripElement.classList.remove("is-hidden");
  progressStripElement.setAttribute(
    "aria-label",
    title + ". " + status + ". " + percent + "%" + (notice ? ". " + notice : "")
  );

  var titleEl = progressStripElement.querySelector(".cv-export-progress-title");
  if (titleEl) titleEl.textContent = title;

  var statusEl = progressStripElement.querySelector(".cv-export-progress-status");
  if (statusEl) statusEl.textContent = status;

  var percentEl = progressStripElement.querySelector(".cv-export-progress-percent");
  if (percentEl) percentEl.textContent = percent + "%";

  var detailEl = progressStripElement.querySelector(".cv-export-progress-detail");
  if (detailEl) detailEl.textContent = getProgressDetail(progress, percent);

  var noticeEl = progressStripElement.querySelector(".cv-export-progress-notice");
  if (noticeEl) {
    noticeEl.hidden = !notice;
    noticeEl.dataset.severity = noticeSeverity;
    noticeEl.textContent = notice;
  }

  var fillEl = progressStripElement.querySelector(".cv-export-progress-fill");
  if (fillEl) {
    fillEl.style.transform = "scaleX(" + (percent / 100) + ")";
  }

  var cancelBtn = progressStripElement.querySelector(".cv-export-progress-cancel");
  if (cancelBtn) {
    cancelBtn.hidden = typeof onCancel !== "function";
    cancelBtn.onclick = function () {
      if (typeof onCancel === "function") onCancel();
      hideProgressUI();
    };
  }
}

export function hideProgressUI() {
  if (progressStripElement) {
    progressStripElement.classList.add("is-hidden");
    var el = progressStripElement;
    progressStripElement = null;
    setTimeout(function () {
      if (el && el.parentElement) {
        el.remove();
      }
    }, 220);
  }
}
