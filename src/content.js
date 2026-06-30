(function initChatVaultContentScript() {
  "use strict";

  // 防止重复注入
  if (globalThis.CHATVAULT_EXPORTER_INJECTED) {
    return;
  }
  globalThis.CHATVAULT_EXPORTER_INJECTED = true;

  const auth = globalThis.CHATVAULT_SUPABASE_AUTH;
  const entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
  const usageStore = globalThis.CHATVAULT_USAGE_STORE;
  const privacyProof = globalThis.CHATVAULT_PRIVACY_PROOF;
  const exportHealth = globalThis.CHATVAULT_EXPORT_HEALTH;
  const templatePresets = globalThis.CHATVAULT_TEMPLATE_PRESETS;
  const developerExport = globalThis.CHATVAULT_DEVELOPER_EXPORT;
  const shareCards = globalThis.CHATVAULT_SHARE_CARDS;
  const exporter = globalThis.CHATVAULT_EXPORT;
  const EXPORT_SETTINGS_STORAGE_KEY = "chatvault_export_settings";

  if (!exporter) {
    console.error("[AI Chat Export] Shared export core is missing. Refresh the page.");
    return;
  }

  function cleanupExportObjectUrls() {
    try {
      exporter.revokePlatformObjectUrls?.();
    } catch (error) {}
  }

  let shadowRoot = null;
  let shadowContainer = null;
  let isProUser = false;
  let currentUserProfile = null;
  let currentSession = null;
  let dailyUsage = { date: "", exportedChats: 0 };
  let currentPreset = "default_transcript";
  let activeFormat = "pdf";
  let abortController = null;
  let batchExportAbortController = null;
  let exportPlatformFetchers = null;
  let lastReceipt = null;
  let pageToastTimer = null;
  let subscribePanelRequestAt = 0;
  let runtimeMessageListenerAttached = false;
  let contextExportReady = false;
  let pendingContextExportRequest = null;

  // popup state 缓存（避免每次打开 popup 都触发 API 请求）
  let _popupStateCache = null;
  let _popupStateCacheAt = 0;
  const POPUP_STATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

  function invalidatePopupStateCache() {
    _popupStateCache = null;
    _popupStateCacheAt = 0;
  }

  // HTML 转义工具，防止会话标题等外部文本注入 HTML
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getUiLanguage() {
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
        return chrome.i18n.getUILanguage() || "en";
      }
    } catch (error) {}
    return "en";
  }

  function isChineseUi() {
    return /^zh(?:_|-|$)/i.test(getUiLanguage());
  }

  function isBackendSchemaCacheError(error) {
    const message = String(error?.message || error || "");
    return /schema cache|payment_products|Could not find the table/i.test(message);
  }

  function formatDefaultText(defaultText, args) {
    let text = String(defaultText || "");
    (args || []).forEach((arg, index) => {
      text = text.replace(new RegExp("\\$" + (index + 1), "g"), String(arg));
    });
    return text;
  }

  function t(key, defaultText, ...args) {
    if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.t === "function") {
      return globalThis.CHATVAULT_I18N.t(key, defaultText, ...args);
    }
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
        const message = chrome.i18n.getMessage(key, args);
        if (message) return message;
      }
    } catch (error) {}
    return formatDefaultText(defaultText, args);
  }

  function tx(key, englishText, chineseText, ...args) {
    return t(key, isChineseUi() ? chineseText : englishText, ...args);
  }

  function getBatchClearLabel() {
    return tx("content_btn_clear", "Clear", "清除");
  }

  function getBatchCancelLabel() {
    return t("btn_cancel", isChineseUi() ? "取消" : "Cancel");
  }

  function getBatchCloseLabel() {
    return tx("content_btn_close", "Close", "关闭");
  }

  // 默认配置设置 (合并 Preset 和自定义选项)
  let exportSettings = {
    export_ai_replies_only: false,
    show_export_time: true,
    show_conversation_title: true,
    show_platform_name: true,
    show_role_labels: true,
    show_chatvault_badge: true,
    include_source_url: false,
    align_user_messages_right: true,
    export_style: "default",
    redaction_enabled: false,
    include_prompt_appendix: false,
    generate_toc: false
  };

  function sanitizeExportSettings(settings) {
    const next = settings && typeof settings === "object" ? settings : {};
    next.redaction_enabled = false;
    next.include_prompt_appendix = false;
    return next;
  }

  function persistExportSettings() {
    try {
      sanitizeExportSettings(exportSettings);
      if (chrome?.storage?.local) {
        chrome.storage.local.set({ [EXPORT_SETTINGS_STORAGE_KEY]: exportSettings }, () => {
          if (chrome.runtime.lastError) {
            console.warn("Failed to persist export settings:", chrome.runtime.lastError.message);
          }
        });
      }
    } catch (error) {
      console.warn("Failed to persist export settings:", error);
    }
  }

  async function loadPersistedExportSettings() {
    try {
      const data = await new Promise((resolve) => {
        chrome.storage.local.get(EXPORT_SETTINGS_STORAGE_KEY, (result) => resolve(result || {}));
      });
      const saved = data && data[EXPORT_SETTINGS_STORAGE_KEY];
      if (saved && typeof saved === "object") {
        exportSettings = sanitizeExportSettings({ ...exportSettings, ...saved });
        if (exportSettings.export_style) {
          batchSelectedTheme = exportSettings.export_style;
        }
      }
    } catch (error) {
      console.warn("Failed to load persisted export settings:", error);
    }
  }

  function normalizeContextExportFormat(format) {
    return /^(pdf|word|image|markdown|txt|json|select)$/.test(format || "") ? format : "pdf";
  }

  function isContextExportReady() {
    return contextExportReady && Boolean(shadowRoot) && typeof performExport === "function";
  }

  function queueContextExportRequest(format) {
    pendingContextExportRequest = {
      format: normalizeContextExportFormat(format),
      queuedAt: Date.now()
    };
  }

  function flushPendingContextExportRequest() {
    if (!pendingContextExportRequest || !isContextExportReady()) {
      return;
    }
    const request = pendingContextExportRequest;
    pendingContextExportRequest = null;
    window.setTimeout(() => {
      executeContextExportRequest(request.format).catch((error) => {
        showPageToast(error?.message || t("toast_export_failed", isChineseUi() ? "导出失败。" : "Export failed."));
      });
    }, 0);
  }

  function waitForContextExportReady(timeoutMs) {
    if (isContextExportReady()) {
      return Promise.resolve();
    }
    const timeout = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 8000;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      function checkReady() {
        if (isContextExportReady()) {
          resolve();
          return;
        }
        if (Date.now() - startedAt >= timeout) {
          reject(new Error(tx("content_export_ui_not_ready", "Export UI is still loading. Refresh the page and try again.", "导出界面仍在加载，请刷新页面后重试。")));
          return;
        }
        window.setTimeout(checkReady, 100);
      }
      checkReady();
    });
  }

  async function executeContextExportRequest(formatInput) {
    const format = normalizeContextExportFormat(formatInput);
    if (format === "select") {
      await exporter.preload();
      exporter.enterSelectionMode();
      const bar = shadowRoot && shadowRoot.getElementById("selection-bar");
      if (bar) {
        bar.classList.add("active");
      }
      return;
    }

    activeFormat = format;
    await performExport();
  }

  // 初始化 DOM 注入
  async function init() {
    listenMessages();
    await loadPersistedExportSettings();
    injectShadowDOM();
    updateUIState();
    contextExportReady = true;
    flushPendingContextExportRequest();

    const preloadPromise = exporter.preload().catch((e) => {
      console.warn("Exporter preload failed:", e);
      return null;
    });

    await loadState();
    updateUIState();
    await preloadPromise;

    // 绑定选择数变动事件
    if (exporter.onSelectionChange) {
      exporter.onSelectionChange((count) => {
        if (!shadowRoot) return;
        const countEl = shadowRoot.getElementById("selection-count-num");
        if (countEl) countEl.textContent = count;
      });
    }

  }

  // 加载登录及额度状态
  async function loadState() {
    let authResolved = !auth;
    try {
      if (auth) {
        currentSession = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: true });
        authResolved = true;
        if (currentSession?.user) {
          currentUserProfile = await refreshEntitlements(currentSession);
          isProUser = entitlements.isPro(currentUserProfile);
        } else {
          isProUser = false;
          currentUserProfile = null;
        }
      }
    } catch (e) {
      console.warn("Failed to load user session/entitlements:", e);
    }

    try {
      if (usageStore) {
        dailyUsage = await usageStore.getDailyUsage();
      }
    } catch (e) {
      console.warn("Failed to load daily usage storage:", e);
    }

    if (currentSession?.access_token && !isProUser) {
      try {
        const verification = await syncVerifiedExportEntitlement(1, { consume: false });
        if (!verification.ok) {
          console.warn("Failed to refresh server export usage:", verification.error);
        }
      } catch (error) {
        console.warn("Failed to refresh server export usage:", error);
      }
    }

    if (authResolved) {
      await cacheEntitlementState();
    }
  }

  // 获取 Pro 状态
  async function refreshEntitlements(session) {
    if (!session?.access_token) return entitlements.normalizeProfile({ plan: "free" });
    try {
      const result = await globalThis.CHATVAULT_SUPABASE_API.request("/functions/v1/sync-subscription-status", {
        accessToken: session.access_token,
        method: "POST"
      });
      const syncedProfile = normalizeProfileResponse(result);
      if (syncedProfile) return syncedProfile;
    } catch (err) {
      console.warn("sync-subscription-status Edge Function failed, trying profiles fallback:", err);
    }
    try {
      const profile = await globalThis.CHATVAULT_SUPABASE_API.request("/rest/v1/profiles?id=eq." + session.user.id + "&select=id,email,plan,feature_flags,limits,updated_at", {
        accessToken: session.access_token,
        method: "GET"
      });
      if (Array.isArray(profile) && profile[0]) {
        return entitlements.normalizeProfile(profile[0]);
      }
    } catch (err) {
      console.error("Fallback query to profiles table failed:", err);
    }
    try {
      const cached = typeof entitlements.getCachedState === "function" ? await entitlements.getCachedState() : null;
      const sessionEmail = session.user?.email || "";
      const sessionUserId = session.user?.id || "";
      if (cached && (!sessionEmail || cached.email === sessionEmail) && (!sessionUserId || cached.profile?.id === sessionUserId || !cached.profile?.id)) {
        return cached.profile;
      }
    } catch (error) {
      console.warn("Cached entitlement fallback failed:", error);
    }
    return entitlements.normalizeProfile({
      id: session.user?.id || "",
      email: session.user?.email || "",
      plan: "free"
    });
  }

  function normalizeProfileResponse(result) {
    const candidate = result?.profile || result?.data?.profile || result;
    if (candidate && typeof candidate === "object" && (candidate.plan || candidate.id || candidate.email)) {
      return entitlements.normalizeProfile(candidate);
    }
    return null;
  }

  async function cacheEntitlementState() {
    try {
      if (!entitlements || typeof entitlements.saveCachedState !== "function") {
        return;
      }
      const profile = currentUserProfile ? {
        ...currentUserProfile,
        id: currentUserProfile.id || currentSession?.user?.id || "",
        email: currentUserProfile.email || currentSession?.user?.email || ""
      } : entitlements.normalizeProfile({
        id: currentSession?.user?.id || "",
        email: currentSession?.user?.email || "",
        plan: "free"
      });
      await entitlements.saveCachedState({
        session: currentSession,
        profile: profile,
        usage: dailyUsage
      });
    } catch (error) {
      console.warn("Failed to cache entitlement state:", error);
    }
  }

  function getUsageCount(value) {
    const source = value && typeof value === "object" ? value : {};
    return Math.max(0, Number(source.exportedChats || source.exported_chats || source.count || source.used || 0));
  }

  function hasKnownExhaustedFreeQuota() {
    if (isProUser) {
      return false;
    }
    if (currentUserProfile && entitlements.isPro(currentUserProfile)) {
      return false;
    }
    const profile = currentUserProfile || entitlements.normalizeProfile({ plan: "free" });
    return entitlements.getRemainingFreeExports(profile, dailyUsage) <= 0;
  }

  function getLocalFreeQuotaAllowed(count) {
    if (isProUser || entitlements?.isPro?.(currentUserProfile)) {
      return true;
    }
    const profile = currentUserProfile || entitlements.normalizeProfile({ plan: "free" });
    return entitlements.canUseExport(profile, dailyUsage, count);
  }

  async function syncVerifiedExportEntitlement(conversationCount, options = {}) {
    const count = Math.max(1, Number(conversationCount) || 1);
    const consume = Boolean(options.consume);

    if (!auth || typeof auth.getSession !== "function") {
      return { ok: true, allowed: true, serverVerified: false };
    }

    let session = null;
    try {
      session = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false });
    } catch (error) {
      if (!consume && isBackendSchemaCacheError(error)) {
        console.warn("Server entitlement verification schema is stale; using local quota fallback:", error);
        return { ok: true, allowed: true, serverVerified: false };
      }
      return {
        ok: false,
        allowed: false,
        serverVerified: false,
        error: tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。")
      };
    }

    if (!session?.access_token) {
      return { ok: true, allowed: true, serverVerified: false };
    }

    try {
      const result = await globalThis.CHATVAULT_SUPABASE_API.request("/functions/v1/verify-export-entitlement", {
        accessToken: session.access_token,
        method: "POST",
        body: {
          requested_count: count,
          consume
        }
      });

      currentSession = session;
      const syncedProfile = normalizeProfileResponse(result);
      if (syncedProfile) {
        currentUserProfile = syncedProfile;
        isProUser = entitlements.isPro(currentUserProfile);
      }
      await cacheEntitlementState();
      invalidatePopupStateCache();
      const localAllowed = getLocalFreeQuotaAllowed(count);

      return {
        ok: true,
        allowed: localAllowed,
        serverVerified: true,
        profile: currentUserProfile,
        usage: dailyUsage,
        remaining: entitlements.getRemainingFreeExports(currentUserProfile, dailyUsage)
      };
    } catch (error) {
      return {
        ok: false,
        allowed: false,
        serverVerified: false,
        error: tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。")
      };
    }
  }

  async function recordSuccessfulExportUsage(count) {
    const amount = Math.max(1, Number(count) || 1);
    if (isProUser || entitlements?.isPro?.(currentUserProfile)) {
      return { ok: true, serverVerified: false, usage: dailyUsage };
    }

    if (usageStore && typeof usageStore.incrementDailyUsage === "function") {
      dailyUsage = await usageStore.incrementDailyUsage(amount);
      await cacheEntitlementState();
    }
    invalidatePopupStateCache();
    if (currentSession?.access_token) {
      syncVerifiedExportEntitlement(amount, { consume: true }).catch((error) => {
        console.warn("Server export usage sync failed; local free quota remains authoritative:", error);
      });
    }
    return { ok: true, serverVerified: false, usage: dailyUsage };
  }

  function sanitizeSourceUrl(rawUrl) {
    const sensitiveKey = /^(token|key|secret|password|passwd|session|auth|access_token|refresh_token|id_token|code)$/i;
    try {
      const url = new URL(String(rawUrl || ""), window.location.href);
      Array.from(url.searchParams.keys()).forEach((key) => {
        if (sensitiveKey.test(key)) {
          url.searchParams.set(key, "REDACTED_PARAM");
        }
      });
      url.hash = "";
      return url.toString();
    } catch (error) {
      return String(rawUrl || "").replace(/([?&#](?:token|key|secret|password|passwd|session|auth|access_token|refresh_token|id_token|code)=)[^&#]+/gi, "$1REDACTED_PARAM");
    }
  }

  function getEntitlementIssue(settings, presetId, profile) {
    const pro = isProUser; // 支持开发者测试状态覆盖
    const preset = templatePresets.getPreset(presetId);

    if (preset?.minPlan === "pro" && !pro) {
      return "This professional template requires Pro.";
    }
    if (!entitlements.canUseExportStyle(profile, settings.export_style) && !pro) {
      return "Premium report themes require Pro.";
    }
    if (settings.include_prompt_appendix && !pro) {
      return "Prompt Appendix requires Pro.";
    }
    if (settings.show_chatvault_badge === false && !pro) {
      return "Hiding watermark requires Pro.";
    }
    return "";
  }

  function canUseBatchExportLocally() {
    return Boolean(isProUser || entitlements?.isPro?.(currentUserProfile));
  }

  function showBatchExportUpgradePrompt() {
    showUpgradePrompt("Batch export requires Pro.");
  }

  let batchModalOpen = false;
  let batchList = [];
  let batchSelectedFormat = "pdf";
  let batchSelectedTheme = "default";
  let displayedConversationsCount = 0;
  const batchPageSize = 20;
  const historyPageSize = 20;
  let hasMoreConversations = true;
  let batchActiveItems = [];
  let batchChatGptSessionRequestPromise = null;
  let batchChatGptNextOffset = 0;
  let batchChatGptWebTotal = null;
  let batchChatGptLoadedAll = false;
  const exportFormats = ["pdf", "word", "image", "markdown", "txt", "json"];
  const EXPORT_PROGRESS_INITIAL = 0.04;
  const EXPORT_PROGRESS_ESTIMATE_CAP = 0.9;
  const EXPORT_PROGRESS_TICK_MS = 1600;
  const EXPORT_PROGRESS_MIN_STEP = 0.01;
  const EXPORT_PROGRESS_MAX_STEP = 0.035;
  let exportProgressState = null;

  function getExportFormatLabel(format) {
    const labels = {
      pdf: "PDF",
      word: "DOCX",
      image: "Image",
      markdown: "Markdown",
      txt: "Text",
      json: "JSON"
    };
    const key = String(format || "pdf").toLowerCase();
    return labels[key] || key.toUpperCase();
  }

  function clampExportProgress(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
  }

  function getExportProgressSource(progress) {
    return progress && progress.overallProgress != null ? progress.overallProgress : progress && progress.progress;
  }

  function getBatchExportVisibleProgress(rawProgress) {
    const raw = clampExportProgress(rawProgress);
    if (raw >= 1) return 1;
    return Math.min(
      EXPORT_PROGRESS_ESTIMATE_CAP,
      EXPORT_PROGRESS_INITIAL + (EXPORT_PROGRESS_ESTIMATE_CAP - EXPORT_PROGRESS_INITIAL) * raw
    );
  }

  function getExportProgressKey(format, progress) {
    progress = progress || {};
    return [
      format || "pdf",
      progress.mode === "batch" ? "batch" : "single",
      progress.title || progress.label || "",
      progress.total || progress.batchTotal || 0
    ].join(":");
  }

  function getExportBlockTextLength(block) {
    if (!block) return 0;
    let length = String(block.text || block.plainText || block.alt || "").length;
    if (Array.isArray(block.segments)) {
      length += block.segments.reduce((sum, segment) => sum + String(segment?.text || "").length, 0);
    }
    if (Array.isArray(block.rows)) {
      length += block.rows.reduce((sum, row) => {
        const cells = Array.isArray(row) ? row : row?.cells;
        return sum + (Array.isArray(cells) ? cells.join(" ").length : 0);
      }, 0);
    }
    return length;
  }

  function getExportProgressStats(messages) {
    const stats = {
      messages: 0,
      blocks: 0,
      chars: 0,
      images: 0,
      codeBlocks: 0
    };
    if (!Array.isArray(messages)) return stats;

    stats.messages = messages.length;
    messages.forEach((message) => {
      const blocks = Array.isArray(message?.contentBlocks) ? message.contentBlocks : [];
      stats.blocks += blocks.length;
      blocks.forEach((block) => {
        stats.chars += getExportBlockTextLength(block);
        if (block?.type === "image") stats.images += 1;
        if (block?.type === "code") stats.codeBlocks += 1;
      });
    });
    return stats;
  }

  function estimateExportProgressDurationMs(format, progress) {
    progress = progress || {};
    const stats = progress.exportStats || {};
    const formatKey = exportFormats.includes(format) ? format : "pdf";
    const total = Math.max(0, Number(progress.total || progress.batchTotal) || 0);
    const messageCount = Math.max(1, Number(stats.messages || stats.messageCount || progress.messageCount || total) || 1);
    const charCount = Math.max(0, Number(stats.chars || stats.charCount) || 0);
    const imageCount = Math.max(0, Number(stats.images || stats.imageCount) || 0);
    const codeBlockCount = Math.max(0, Number(stats.codeBlocks || stats.codeBlockCount) || 0);
    const baseByFormat = {
      markdown: 7000,
      txt: 5000,
      json: 5000,
      word: 11000,
      pdf: 14000,
      image: 18000
    };
    const messageCostByFormat = {
      markdown: 160,
      txt: 90,
      json: 90,
      word: 260,
      pdf: 360,
      image: 520
    };
    const imageCostByFormat = {
      markdown: 120,
      txt: 40,
      json: 40,
      word: 850,
      pdf: 1100,
      image: 1600
    };
    let duration = (baseByFormat[formatKey] || baseByFormat.pdf) +
      Math.min(26000, messageCount * (messageCostByFormat[formatKey] || messageCostByFormat.pdf)) +
      Math.min(24000, Math.ceil(charCount / 1000) * 180) +
      Math.min(20000, imageCount * (imageCostByFormat[formatKey] || imageCostByFormat.pdf)) +
      Math.min(10000, codeBlockCount * 420);

    if (progress.mode === "batch" && total > 1) {
      duration = Math.max(duration, 9000 + Math.min(171000, total * 2800));
      return Math.max(12000, Math.min(180000, duration));
    }

    return Math.max(7000, Math.min(formatKey === "image" ? 70000 : 56000, duration));
  }

  function getVisibleExportProgressValue(progress) {
    progress = progress || {};
    const raw = clampExportProgress(getExportProgressSource(progress));
    if (raw >= 1) return 1;
    return Math.min(EXPORT_PROGRESS_ESTIMATE_CAP, raw);
  }

  function withVisibleExportProgress(progress, visibleProgress) {
    const next = {
      ...(progress || {}),
      overallProgress: clampExportProgress(visibleProgress)
    };
    if (next.mode === "batch") {
      next.progress = clampExportProgress(next.progress);
    } else {
      next.progress = next.overallProgress;
    }
    return next;
  }

  function stopEstimatedExportProgress() {
    if (exportProgressState?.timer) {
      window.clearTimeout(exportProgressState.timer);
    }
    exportProgressState = null;
  }

  function renderExportProgressRaw(format, progress, onCancel) {
    if (!shadowRoot || !exporter?.renderProgressUI) return;
    exporter.renderProgressUI(format, progress, shadowRoot, onCancel);
  }

  function scheduleEstimatedExportProgress() {
    if (!exportProgressState) return;
    if (exportProgressState.timer) {
      window.clearTimeout(exportProgressState.timer);
      exportProgressState.timer = null;
    }
    if (exportProgressState.current >= EXPORT_PROGRESS_ESTIMATE_CAP) return;
    exportProgressState.timer = window.setTimeout(tickEstimatedExportProgress, EXPORT_PROGRESS_TICK_MS);
  }

  function tickEstimatedExportProgress() {
    const state = exportProgressState;
    if (!state) return;

    const elapsed = Math.max(0, Date.now() - state.startedAt);
    const duration = Math.max(1, state.durationMs);
    const ratio = Math.min(1, elapsed / duration);
    const eased = 1 - Math.pow(1 - ratio, 1.35);
    const target = EXPORT_PROGRESS_INITIAL + (EXPORT_PROGRESS_ESTIMATE_CAP - EXPORT_PROGRESS_INITIAL) * eased;

    if (target > state.current) {
      const step = Math.max(
        EXPORT_PROGRESS_MIN_STEP,
        Math.min(EXPORT_PROGRESS_MAX_STEP, target - state.current)
      );
      state.current = Math.min(EXPORT_PROGRESS_ESTIMATE_CAP, state.current + step);
      renderExportProgressRaw(
        state.format,
        withVisibleExportProgress(state.progress, state.current),
        state.onCancel
      );
    }

    scheduleEstimatedExportProgress();
  }

  function getEstimatedExportProgress(format, progress, onCancel) {
    progress = progress || {};
    const key = getExportProgressKey(format, progress);
    const visibleSource = getVisibleExportProgressValue(progress);
    const now = Date.now();

    if (!exportProgressState || exportProgressState.key !== key) {
      stopEstimatedExportProgress();
      exportProgressState = {
        key,
        format,
        progress,
        onCancel,
        current: Math.max(EXPORT_PROGRESS_INITIAL, visibleSource),
        startedAt: now,
        durationMs: estimateExportProgressDurationMs(format, progress),
        timer: null
      };
    } else {
      const durationMs = estimateExportProgressDurationMs(format, progress);
      const completedRatio = (exportProgressState.current - EXPORT_PROGRESS_INITIAL) /
        Math.max(0.01, EXPORT_PROGRESS_ESTIMATE_CAP - EXPORT_PROGRESS_INITIAL);
      exportProgressState.progress = {
        ...exportProgressState.progress,
        ...progress
      };
      exportProgressState.onCancel = onCancel;
      exportProgressState.format = format;
      exportProgressState.durationMs = durationMs;
      exportProgressState.startedAt = now - Math.max(0, Math.min(1, completedRatio)) * durationMs;
      exportProgressState.current = Math.max(exportProgressState.current, visibleSource);
    }

    scheduleEstimatedExportProgress();
    return withVisibleExportProgress(exportProgressState.progress, exportProgressState.current);
  }

  function createExportCancelHandler() {
    return () => {
      cancelExport();
      showPageToast(t("batch_export_cancelled", isChineseUi() ? "导出已取消。" : "Export cancelled."));
    };
  }

  function renderExportProgress(format, progress, onCancel) {
    const cancelHandler = onCancel === undefined ? createExportCancelHandler() : onCancel;
    renderExportProgressRaw(format, getEstimatedExportProgress(format, progress || {}, cancelHandler), cancelHandler);
  }

  function hideExportProgress() {
    stopEstimatedExportProgress();
    if (exporter?.hideProgressUI) {
      exporter.hideProgressUI();
    }
  }

  function getSingleExportProgressTitle(format) {
    return tx("content_exporting_format", "Exporting $1", "正在导出 $1", getExportFormatLabel(format));
  }

  function getExportProgressHandler(label, formatHint, meta) {
    const format = formatHint || "pdf";
    const mode = meta && meta.mode === "batch" ? "batch" : "single";
    const onCancel = mode === "batch" ? cancelInPageBatchExport : createExportCancelHandler();

    return (progress) => {
      progress = progress || {};
      const itemProgress = clampExportProgress(
        progress.progress != null ? progress.progress : Number(progress.percent || 0) / 100
      );
      const total = Number(meta?.total || meta?.batchTotal) || 0;
      const current = Number(meta?.current || meta?.batchIndex) || 0;
      const batchRawProgress = total > 0
        ? clampExportProgress(((Math.max(1, current) - 1) + itemProgress) / total)
        : itemProgress;
      const overallProgress = mode === "batch"
        ? getBatchExportVisibleProgress(batchRawProgress)
        : itemProgress;

      renderExportProgress(format, {
        ...progress,
        ...(meta || {}),
        mode,
        label,
        title: meta?.title || (mode === "batch" ? t("batch_export", isChineseUi() ? "批量导出" : "Batch Export") : getSingleExportProgressTitle(format)),
        progress: itemProgress,
        overallProgress
      }, onCancel);
    };
  }

  // 注入 Shadow DOM
  function injectShadowDOM() {
    shadowContainer = document.createElement("div");
    shadowContainer.id = "chatvault-exporter-root";
    shadowContainer.style.position = "absolute";
    shadowContainer.style.top = "0";
    shadowContainer.style.left = "0";
    shadowContainer.style.zIndex = "2147483647";
    document.body.appendChild(shadowContainer);

    shadowRoot = shadowContainer.attachShadow({ mode: "open" });

    // 引入 CSS
    const criticalStyle = document.createElement("style");
    criticalStyle.textContent = `
      .export-progress-overlay:not(.active),
      .cv-vip-modal-overlay:not(.active),
      .cv-selection-bar:not(.active),
      .cv-batch-modal-overlay:not(.active),
      .cv-page-toast:not(.active) {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
      .export-progress-overlay.active,
      .cv-vip-modal-overlay.active,
      .cv-selection-bar.active,
      .cv-batch-modal-overlay.active,
      .cv-page-toast.active {
        visibility: visible !important;
      }
    `;
    shadowRoot.appendChild(criticalStyle);

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("src/content.css");
    shadowRoot.appendChild(link);

    // 渲染 UI 骨架 (进度遮罩、浮动选择栏、VIP升级提示、以及批量导出弹窗)
    const uiWrapper = document.createElement("div");
    uiWrapper.innerHTML = `
      <!-- 进度进度遮罩 -->
      <div class="export-progress-overlay" id="progress-overlay">
        <div class="spinner"></div>
        <div class="progress-text" id="progress-text">Preparing...</div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progress-bar-fill"></div>
        </div>
        <div class="progress-subtext" id="progress-subtext">0% completed</div>
        <button class="progress-cancel-btn" id="cancel-export-btn">Cancel</button>
      </div>

      <!-- 浮动选择工具栏 -->
      <div class="cv-selection-bar" id="selection-bar">
        <div class="cv-selection-info">
          <span>${tx("content_selected_short", "Selected", "已选")}</span><span class="cv-selection-count" id="selection-count-num">0</span>
        </div>
        <div class="cv-selection-actions">
          <button class="cv-selection-btn" id="btn-select-all-ai">${t("btn_select_ai", isChineseUi() ? "全选 AI" : "Select AI Replies")}</button>
          <button class="cv-selection-btn" id="btn-clear-selection">${t("btn_clear", isChineseUi() ? "清空" : "Clear")}</button>
          <select class="cv-selection-select" id="selection-format-select">
            <option value="pdf">PDF</option>
            <option value="word">Word</option>
            <option value="markdown">Markdown</option>
            <option value="image">${t("format_image", isChineseUi() ? "图片" : "Image")}</option>
            <option value="txt">${tx("content_format_text", "Text", "文本")}</option>
            <option value="json">JSON</option>
          </select>
          <button class="cv-selection-btn primary" id="btn-export-selection">${t("btn_export", isChineseUi() ? "导出" : "Export")}</button>
          <button class="cv-selection-btn" id="btn-exit-selection">${tx("content_btn_exit", "Exit", "退出")}</button>
        </div>
      </div>

      <!-- VIP 升级提示弹窗 -->
      <div class="cv-vip-modal-overlay" id="vip-modal-overlay">
        <div class="cv-vip-modal">
          <div class="cv-vip-crown-container">
            <span class="cv-vip-crown">👑</span>
          </div>
          <h3 class="cv-vip-modal-title">${t("billing_title", isChineseUi() ? "升级至 AI Chat Export Pro" : "Upgrade To AI Chat Export Pro")}</h3>
          <div class="cv-vip-modal-body" id="vip-modal-body">
            ${tx("content_upgrade_body", "You are using a Pro feature. Upgrade to unlock it.", "您正在使用 Pro 专属功能，升级后即可解锁。")}
          </div>
          <div class="cv-vip-modal-actions">
            <button class="cv-vip-btn secondary" id="btn-close-vip-modal">${getBatchCancelLabel()}</button>
            <button class="cv-vip-btn primary" id="btn-go-subscribe">${tx("content_go_subscribe", "Subscribe", "前往订阅")}</button>
          </div>
        </div>
      </div>

      <!-- 批量导出页内弹窗 -->
      <div class="cv-batch-modal-overlay" id="cv-batch-modal-overlay">
        <div class="cv-batch-modal">
          <div class="cv-batch-header">
            <h2>
              <span style="font-size:16px;">👑</span>
              <span id="cv-batch-title-text">${t("batch_export", isChineseUi() ? "批量导出" : "Batch Export")}</span>
            </h2>
            <button class="cv-batch-close-btn" id="cv-batch-btn-close" aria-label="${getBatchCloseLabel()}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>



          <!-- 同步进度条 -->
          <div class="cv-batch-loading-bar" id="cv-batch-loading-indicator" style="display: none;">
            <div class="cv-batch-dot-spinner"></div>
            <span>${tx("content_syncing_sidebar", "Syncing sidebar history and loading more chats...", "正在同步侧边栏历史，加载更多聊天...")}</span>
          </div>

          <div class="cv-batch-export-progress-panel" id="cv-batch-export-progress-panel" style="display: none;">
            <div class="cv-batch-export-progress-head">
              <span id="cv-batch-export-progress-title">${t("batch_export_preparing", isChineseUi() ? "准备批量导出..." : "Preparing for export...")}</span>
              <span id="cv-batch-export-progress-percent">0%</span>
            </div>
            <div class="cv-batch-export-progress-bar">
              <div class="cv-batch-export-progress-fill" id="cv-batch-export-progress-fill"></div>
            </div>
            <div class="cv-batch-export-progress-detail" id="cv-batch-export-progress-detail">${tx("content_waiting_batch_start", "Waiting for the background export task to start", "等待后台导出任务启动")}</div>
          </div>

          <!-- 折叠设置段 -->
          <div class="cv-batch-settings-toggle">
            <div class="cv-batch-settings-header" id="cv-batch-settings-expand-btn">
              <span>⚙️ ${tx("content_export_options", "Export format and detailed settings", "导出格式与详细设置")}</span>
              <span id="cv-batch-settings-chevron">▼</span>
            </div>
            <div class="cv-batch-settings-body" id="cv-batch-settings-panel">
              <div class="cv-batch-option-group">
                <span class="cv-batch-group-title">${t("export_theme_label", isChineseUi() ? "导出主题与样式" : "Export Theme & Styling")}</span>
                <div class="cv-batch-theme-grid">
                  <div class="cv-batch-theme-option active" data-theme="default">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--default"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_default", isChineseUi() ? "极简纯白" : "Minimalist")}</span>
                  </div>
                  <div class="cv-batch-theme-option" data-theme="midnight">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--midnight"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_midnight", isChineseUi() ? "暗黑深邃" : "Midnight Dark")}</span>
                    <span class="cv-batch-theme-pro-badge">PRO</span>
                  </div>
                  <div class="cv-batch-theme-option" data-theme="editorial">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--editorial"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_editorial", isChineseUi() ? "学术社评" : "Editorial")}</span>
                    <span class="cv-batch-theme-pro-badge">PRO</span>
                  </div>
                  <div class="cv-batch-theme-option" data-theme="terminal">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--terminal"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_terminal", isChineseUi() ? "赛博终端" : "Terminal")}</span>
                    <span class="cv-batch-theme-pro-badge">PRO</span>
                  </div>
                  <div class="cv-batch-theme-option" data-theme="newsprint">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--newsprint"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_newsprint", isChineseUi() ? "复古印报" : "Newsprint")}</span>
                    <span class="cv-batch-theme-pro-badge">PRO</span>
                  </div>
                  <div class="cv-batch-theme-option" data-theme="aurora">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--aurora"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_aurora", isChineseUi() ? "流光极光" : "Aurora")}</span>
                    <span class="cv-batch-theme-pro-badge">PRO</span>
                  </div>
                  <div class="cv-batch-theme-option" data-theme="mckinsey">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--mckinsey"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_mckinsey", isChineseUi() ? "麦肯锡商务" : "McKinsey")}</span>
                    <span class="cv-batch-theme-pro-badge">PRO</span>
                  </div>
                  <div class="cv-batch-theme-option" data-theme="oxford">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--oxford"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_oxford", isChineseUi() ? "学术深青" : "Oxford")}</span>
                    <span class="cv-batch-theme-pro-badge">PRO</span>
                  </div>
                </div>
              </div>
              <div class="cv-batch-option-group">
                <span class="cv-batch-group-title">${tx("content_detail_toggles", "Detailed toggles", "详细开关")}</span>
                <div class="cv-batch-toggles">
                  <label class="cv-batch-toggle-item">
                    <input type="checkbox" id="cv-toggle-title" checked>
                    <span>${t("export_opt_title", isChineseUi() ? "包含会话标题" : "Conversation Title")}</span>
                  </label>
                  <label class="cv-batch-toggle-item">
                    <input type="checkbox" id="cv-toggle-ai-only">
                    <span>${t("export_opt_ai_only", isChineseUi() ? "仅导出 AI 回复" : "AI Replies Only")}</span>
                  </label>
                  <label class="cv-batch-toggle-item">
                    <input type="checkbox" id="cv-toggle-watermark">
                    <span>${tx("content_toggle_watermark", "Hide product watermark", "隐藏产品水印")}</span>
                  </label>
                  <label class="cv-batch-toggle-item">
                    <input type="checkbox" id="cv-toggle-source-url">
                    <span>${t("export_opt_url", isChineseUi() ? "包含会话源链接" : "Source URL")}</span>
                  </label>
                  <label class="cv-batch-toggle-item">
                    <input type="checkbox" id="cv-toggle-platform-name" checked>
                    <span>${t("export_opt_platform", isChineseUi() ? "包含平台名称" : "Platform Name")}</span>
                  </label>
                  <label class="cv-batch-toggle-item">
                    <input type="checkbox" id="cv-toggle-role-labels" checked>
                    <span>${t("export_opt_role", isChineseUi() ? "显示发言角色" : "Role Labels")}</span>
                  </label>
                  <label class="cv-batch-toggle-item" style="grid-column: span 2;">
                    <input type="checkbox" id="cv-toggle-align-right" checked>
                    <span>${t("export_opt_align_right", isChineseUi() ? "用户发言靠右对齐" : "Align My Questions Right")}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- 对话复选框列表 -->
          <div class="cv-batch-list-wrapper scroller" id="cv-batch-list-container">
            <!-- 动态生成行 -->
          </div>

          <!-- 固定展示的导出方式 -->
          <div class="cv-batch-fixed-format-container">
            <div class="cv-batch-option-group">
              <div class="cv-batch-format-btns">
                <button type="button" class="cv-batch-format-btn active" data-format="pdf">PDF</button>
                <button type="button" class="cv-batch-format-btn" data-format="word">Word</button>
                <button type="button" class="cv-batch-format-btn" data-format="markdown">Markdown</button>
                <button type="button" class="cv-batch-format-btn" data-format="image">${t("format_image", isChineseUi() ? "图片" : "Image")}</button>
                <button type="button" class="cv-batch-format-btn" data-format="txt">${tx("content_format_text", "Text", "文本")}</button>
                <button type="button" class="cv-batch-format-btn" data-format="json">JSON</button>
              </div>
            </div>
          </div>

          <!-- 限制警告 -->
          <div class="cv-batch-limit-warning" id="cv-batch-limit-warning" style="display: none;">
            ${t("batch_export_limit_warning", isChineseUi() ? "为了导出体验，一次最多选择 10 个会话，请分多次导出。" : "For the best experience, you can export up to 10 chats at a time. Please export in multiple batches.")}
          </div>

          <!-- 底部控制栏 -->
          <div class="cv-batch-footer">
            <div class="cv-batch-footer-left">
              ${tx("content_selected_prefix", "Selected ", "已选择 ")}<span id="cv-batch-selected-count" style="font-weight:700; color:#d97706;">0</span>${tx("content_selected_batch_suffix", " chats (max 10)", " 个会话（最多 10 个）")}
            </div>
            <div class="cv-batch-footer-right">
              <button class="cv-batch-btn secondary" id="cv-batch-btn-clear">${getBatchClearLabel()}</button>
              <button class="cv-batch-btn primary" id="cv-batch-btn-export" disabled>${t("btn_export", isChineseUi() ? "导出" : "Export")}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="cv-page-toast" id="cv-page-toast" role="status" aria-live="polite"></div>
    `;

    shadowRoot.appendChild(uiWrapper);

    // 绑定事件
    shadowRoot.getElementById("cancel-export-btn").addEventListener("click", cancelExport);

    // 绑定浮动选择栏事件
    shadowRoot.getElementById("btn-select-all-ai").addEventListener("click", () => {
      exporter.selectAllAssistant();
    });

    shadowRoot.getElementById("btn-clear-selection").addEventListener("click", () => {
      exporter.clearSelection();
    });

    shadowRoot.getElementById("btn-exit-selection").addEventListener("click", () => {
      exporter.exitSelectionMode();
      shadowRoot.getElementById("selection-bar").classList.remove("active");
    });

    shadowRoot.getElementById("btn-export-selection").addEventListener("click", async () => {
      const formatSelect = shadowRoot.getElementById("selection-format-select");
      activeFormat = formatSelect.value;
      
      // 设置导出模式为 "selected"
      exportSettings.mode = "selected";
      try {
        await performExport();
      } finally {
        // 导出后恢复默认
        exportSettings.mode = undefined;
      }
    });

    // 绑定 VIP 升级弹窗事件
    shadowRoot.getElementById("btn-close-vip-modal").addEventListener("click", () => {
      shadowRoot.getElementById("vip-modal-overlay").classList.remove("active");
    });
    shadowRoot.getElementById("btn-go-subscribe").addEventListener("click", () => {
      shadowRoot.getElementById("vip-modal-overlay").classList.remove("active");
      chrome.runtime.sendMessage({ type: "CHATVAULT_OPEN_SUBSCRIBE", source: "extension_vip_modal", planId: "yearly" }, (response) => {
        if (chrome.runtime.lastError || !response || response.ok === false) {
          showPageToast(tx("content_open_subscribe_panel_failed", "Open the AI Chat Export toolbar popup to subscribe.", "请打开浏览器工具栏中的 AI Chat Export 弹窗完成订阅。"));
        }
      });
    });

    // === 绑定页内批量导出弹窗事件 ===
    
    // 折叠配置面板
    shadowRoot.getElementById("cv-batch-settings-expand-btn").addEventListener("click", () => {
      const panel = shadowRoot.getElementById("cv-batch-settings-panel");
      const chevron = shadowRoot.getElementById("cv-batch-settings-chevron");
      if (panel && chevron) {
        const isActive = panel.classList.toggle("active");
        chevron.textContent = isActive ? "▲" : "▼";
      }
    });

    // 选择导出格式
    shadowRoot.querySelectorAll(".cv-batch-format-btns .cv-batch-format-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const format = btn.getAttribute("data-format");
        if (format) {
          shadowRoot.querySelectorAll(".cv-batch-format-btns .cv-batch-format-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          batchSelectedFormat = format;
        }
      });
    });

    // 选择导出主题
    shadowRoot.querySelectorAll(".cv-batch-theme-option").forEach(btn => {
      btn.addEventListener("click", () => {
        const theme = btn.getAttribute("data-theme");
        if (!isProUser && theme !== "default") {
          showUpgradePrompt("Premium report themes require Pro.");
          return;
        }
        shadowRoot.querySelectorAll(".cv-batch-theme-option").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        batchSelectedTheme = theme;
        exportSettings = { ...exportSettings, export_style: theme };
        persistExportSettings();
      });
    });



    // 清除 / 取消 / 关闭 按钮
    const clearBtn = shadowRoot.getElementById("cv-batch-btn-clear");
    clearBtn.addEventListener("click", () => {
      if (clearBtn.textContent === getBatchCancelLabel()) {
        cancelInPageBatchExport();
      } else if (clearBtn.textContent === getBatchCloseLabel()) {
        closeBatchModal();
      } else {
        // 清除所有选择
        shadowRoot.querySelectorAll(".cv-batch-item-row.selected").forEach(row => {
          row.classList.remove("selected");
        });
        updateBatchSelectedCount();
      }
    });

    // 点击 X 关闭按钮
    shadowRoot.getElementById("cv-batch-btn-close").addEventListener("click", () => {
      if (globalThis.CHATVAULT_IS_BATCH_EXPORT) {
        cancelInPageBatchExport();
      } else {
        closeBatchModal();
      }
    });

    // 保存（导出）按钮
    shadowRoot.getElementById("cv-batch-btn-export").addEventListener("click", startInPageBatchExport);

    const batchOverlay = shadowRoot.getElementById("cv-batch-modal-overlay");
    if (batchOverlay) {
      batchOverlay.addEventListener("wheel", trapBatchModalWheel, { passive: false });
    }

    // 绑定全局登录监听 Hook (防崩溃，因 popup 会更新状态)
    globalThis.CHATVAULT_SET_AUTH_LOADING = (isLoading, message) => {};
    globalThis.CHATVAULT_REFRESH_AUTH_STATE = async () => {
      await loadState();
      updateUIState();
    };
  }


  // === 侧边栏抓取工具函数（模块顶层，可被 showBatchExportModal 调用）===

  function isElementVisible(element) {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function trapBatchModalWheel(event) {
    const overlay = shadowRoot && shadowRoot.getElementById("cv-batch-modal-overlay");
    if (!overlay || !overlay.classList.contains("active")) return;

    const target = event.target && event.target.nodeType === 1 ? event.target : event.target?.parentElement;
    const scrollable = target && target.closest ? target.closest("#cv-batch-list-container") : null;
    if (!scrollable) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const deltaY = Number(event.deltaY) || 0;
    const atTop = scrollable.scrollTop <= 0;
    const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1;
    if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
      event.preventDefault();
    }
    event.stopPropagation();
  }

  function getSidebarAnchorSelector(platform) {
    if (platform === "chatgpt") return 'a[href*="/c/"]';
    if (platform === "claude") return 'a[href*="/chat/"]';
    if (platform === "gemini") return 'a[href*="/app/chat/"], a[href*="/app/"], a[href*="/gem/"]';
    return "";
  }

  function findSidebarRoot(platform) {
    const anchorSelector = getSidebarAnchorSelector(platform);
    if (!anchorSelector) return null;
    const rootSelectors = [
      "nav",
      "aside",
      '[data-testid*="sidebar"]',
      '[class*="sidebar"]',
      "mat-sidenav",
      "bard-sidenav"
    ];

    for (const selector of rootSelectors) {
      const candidates = document.querySelectorAll(selector);
      for (const candidate of candidates) {
        if (candidate && candidate.querySelector && candidate.querySelector(anchorSelector) && isElementVisible(candidate)) {
          return candidate;
        }
      }
    }

    const firstAnchor = document.querySelector(anchorSelector);
    return firstAnchor ? firstAnchor.closest("nav, aside, mat-sidenav, bard-sidenav, [data-testid*='sidebar'], [class*='sidebar']") : null;
  }

  function findSidebarScrollContainer(sidebarRoot) {
    const root = sidebarRoot || document;
    const rootElement = root === document
      ? (document.scrollingElement || document.documentElement || document.body)
      : root;
    if (!rootElement) return null;

    if (rootElement.scrollHeight > rootElement.clientHeight) {
      const style = window.getComputedStyle(rootElement);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || root === document) {
        return rootElement;
      }
    }

    if (root.scrollHeight > root.clientHeight) {
      const style = window.getComputedStyle(root);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return root;
      }
    }
    const elements = root.querySelectorAll('*');
    for (const el of elements) {
      const style = window.getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        return el;
      }
    }
    return rootElement;
  }

  function scrapeSidebarList(platform, root) {
    const list = [];
    const ids = new Set();
    const scope = root || findSidebarRoot(platform) || document;

    function resolveSidebarHref(href, fallbackPath) {
      try {
        return href ? new URL(href, window.location.origin).toString() : window.location.origin + fallbackPath;
      } catch (error) {
        return window.location.origin + fallbackPath;
      }
    }
    
    if (platform === "chatgpt") {
      const elements = scope.querySelectorAll('a[href*="/c/"]');
      elements.forEach(el => {
        const href = el.getAttribute("href") || "";
        const match = href.match(/\/c\/([^\/\?\#]+)/);
        if (match) {
          const id = match[1];
          if (!ids.has(id)) {
            ids.add(id);
            let text = el.textContent || "";
            const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
            let title = lines[0] || "Untitled Chat";
            if (title.length > 100) title = title.substring(0, 100) + "...";
            list.push({ id, title, url: resolveSidebarHref(href, "/c/" + id), platform });
          }
        }
      });
    } else if (platform === "claude") {
      const elements = scope.querySelectorAll('a[href*="/chat/"]');
      elements.forEach(el => {
        const href = el.getAttribute("href") || "";
        const match = href.match(/\/chat\/([^\/\?\#]+)/);
        if (match) {
          const id = match[1];
          if (id !== "settings" && id !== "new") {
            if (!ids.has(id)) {
              ids.add(id);
              let text = el.textContent || "";
              const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
              let title = lines[0] || "Untitled Chat";
              list.push({ id, title, url: resolveSidebarHref(href, "/chat/" + id), platform });
            }
          }
        }
      });
    } else if (platform === "gemini") {
      const elements = scope.querySelectorAll('a[href*="/app/chat/"], a[href*="/app/"], a[href*="/gem/"]');
      elements.forEach(el => {
        const href = el.getAttribute("href") || "";
        const match = href.match(/\/(?:app\/chat|app|gem\/[^\/\?\#]+)\/([^\/\?\#]+)/);
        if (match) {
          const id = match[1];
          if (!ids.has(id)) {
            ids.add(id);
            let text = el.textContent || "";
            const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
            let title = lines[0] || "Untitled Chat";
            list.push({ id, title, url: resolveSidebarHref(href, "/app/" + id), platform });
          }
        }
      });
    }
    return list;
  }

  function getConversationItems(payload) {
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.conversations)) return payload.conversations;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  function resetBatchChatGptHistoryState() {
    batchChatGptSessionRequestPromise = null;
    batchChatGptNextOffset = 0;
    batchChatGptWebTotal = null;
    batchChatGptLoadedAll = false;
  }

  function getBatchPlatformChatUrl(platform, conversationId) {
    const id = encodeURIComponent(String(conversationId || ""));
    const origin = window.location.origin;

    if (platform === "claude") {
      return origin + "/chat/" + id;
    }

    if (platform === "gemini") {
      return origin + "/app/" + id;
    }

    return origin + "/c/" + id;
  }

  async function getVisibleBatchConversations(platform, limit) {
    const sidebarRoot = findSidebarRoot(platform);
    const visibleItems = scrapeSidebarList(platform, sidebarRoot);
    return visibleItems.slice(0, Math.max(1, Number(limit) || 200));
  }

  async function syncVisibleSidebarConversations(platform, targetCount) {
    const sidebarRoot = findSidebarRoot(platform);
    const scroller = findSidebarScrollContainer(sidebarRoot);
    const maxItems = Math.max(targetCount, 800);
    const maxAttempts = 8;
    let totalAdded = 0;
    let sawLazyLoadSignal = false;
    let previousScrollHeight = scroller ? scroller.scrollHeight : 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const beforeCount = batchList.length;
      const mergedItems = await getVisibleBatchConversations(platform, maxItems);
      totalAdded += mergeSidebarBatchItems(mergedItems);

      if (batchList.length >= targetCount) {
        break;
      }

      if (!scroller) {
        break;
      }

      const beforeScrollTop = scroller.scrollTop;
      const beforeScrollHeight = scroller.scrollHeight;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 650));

      const afterScrollHeight = scroller.scrollHeight;
      const moved = scroller.scrollTop !== beforeScrollTop;
      const heightChanged = afterScrollHeight !== beforeScrollHeight || afterScrollHeight !== previousScrollHeight;
      const addedThisAttempt = batchList.length > beforeCount;
      sawLazyLoadSignal = sawLazyLoadSignal || moved || heightChanged || addedThisAttempt;
      previousScrollHeight = afterScrollHeight;

      if (!heightChanged && !addedThisAttempt && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        break;
      }
    }

    const finalItems = await getVisibleBatchConversations(platform, maxItems);
    const finalAdded = mergeSidebarBatchItems(finalItems);
    totalAdded += finalAdded;
    sawLazyLoadSignal = sawLazyLoadSignal || finalAdded > 0;

    return {
      addedCount: totalAdded,
      mayHaveMore: batchList.length > targetCount || sawLazyLoadSignal
    };
  }

  function getChatGptSessionUnavailableMessage(status) {
    const statusLabel = status ? " (" + status + ")" : "";
    return "ChatGPT session is not available" + statusLabel + ". Refresh ChatGPT, make sure you are signed in, then try exporting again.";
  }

  async function getChatGptWebSession() {
    if (!/^(chatgpt\.com|chat\.openai\.com)$/.test(window.location.hostname)) {
      throw new Error("Open ChatGPT before loading ChatGPT data.");
    }

    if (!batchChatGptSessionRequestPromise) {
      batchChatGptSessionRequestPromise = (async () => {
        const sessionResponse = await fetch(window.location.origin + "/api/auth/session", {
          credentials: "include"
        });
        if (!sessionResponse.ok) {
          throw new Error(getChatGptSessionUnavailableMessage(sessionResponse.status));
        }
        const session = await sessionResponse.json();
        if (!session || !session.accessToken) {
          throw new Error(getChatGptSessionUnavailableMessage());
        }
        return session;
      })();
    }

    try {
      return await batchChatGptSessionRequestPromise;
    } finally {
      batchChatGptSessionRequestPromise = null;
    }
  }

  async function fetchChatGptConversationPage(session, offset, limit) {
    const listResponse = await fetch(
      window.location.origin + "/backend-api/conversations?offset=" + encodeURIComponent(offset) +
        "&limit=" + encodeURIComponent(limit) + "&order=updated",
      {
        credentials: "include",
        headers: {
          Authorization: "Bearer " + session.accessToken
        }
      }
    );
    if (!listResponse.ok) {
      throw new Error("ChatGPT history request failed: " + listResponse.status);
    }
    return listResponse.json();
  }

  function normalizeChatGptHistoryItem(item) {
    if (!item || typeof item !== "object") return null;
    const id = item.id || item.conversation_id || item.conversationId || item.uuid;
    if (!id) return null;
    const title = String(item.title || item.name || item.summary || "Untitled Chat").trim() || "Untitled Chat";
    return {
      id: String(id),
      title: title.length > 100 ? title.substring(0, 100) + "..." : title,
      url: window.location.origin + "/c/" + encodeURIComponent(String(id)),
      updatedAt: item.update_time || item.updated_at || item.create_time || item.created_at || null
    };
  }

  async function fetchChatGptHistoryConversations(limit, offset) {
    const maxItems = Math.max(1, Number(limit) || historyPageSize);
    const startOffset = Math.max(0, Number(offset) || 0);
    const session = await getChatGptWebSession();
    const list = [];
    const knownIds = new Set();
    let currentOffset = startOffset;
    let hasMore = true;

    while (list.length < maxItems) {
      const pageLimit = Math.min(historyPageSize, maxItems - list.length);
      const payload = await fetchChatGptConversationPage(session, currentOffset, pageLimit);
      const pageItems = getConversationItems(payload);
      pageItems.forEach((item) => {
        const normalized = normalizeChatGptHistoryItem(item);
        if (!normalized || knownIds.has(normalized.id)) return;
        knownIds.add(normalized.id);
        list.push(normalized);
      });

      const responseOffset = Number(payload?.offset);
      const responseLimit = Number(payload?.limit || pageItems.length);
      const nextOffset = responseOffset + responseLimit;
      const totalAvailable = Number(payload?.total);
      if (
        pageItems.length < pageLimit ||
        payload?.has_more === false ||
        (Number.isFinite(totalAvailable) && currentOffset + pageItems.length >= totalAvailable)
      ) {
        hasMore = false;
        break;
      }
      currentOffset = Number.isFinite(nextOffset) && nextOffset > currentOffset
        ? nextOffset
        : currentOffset + pageItems.length;
      if (pageItems.length === 0) {
        hasMore = false;
        break;
      }
    }

    return { list, hasMore };
  }

  function getBatchChatGptHistoryErrorMessage(error) {
    const fallback = "Failed to load ChatGPT history. Refresh ChatGPT, make sure you are signed in, then try again.";
    return error && error.message ? error.message : fallback;
  }

  async function ensureChatGptBatchHistoryLoaded(targetCount) {
    const target = Math.max(1, Number(targetCount) || batchPageSize);

    while (batchList.length < target && !batchChatGptLoadedAll) {
      const session = await getChatGptWebSession();
      const payload = await fetchChatGptConversationPage(session, batchChatGptNextOffset, historyPageSize);
      const rawItems = getConversationItems(payload);

      if (typeof payload.total === "number") {
        batchChatGptWebTotal = payload.total;
      }

      const normalizedItems = rawItems.map(normalizeChatGptHistoryItem).filter(Boolean);
      mergeSidebarBatchItems(normalizedItems);
      batchChatGptNextOffset += rawItems.length;

      if (
        !rawItems.length ||
        rawItems.length < historyPageSize ||
        payload?.has_more === false ||
        (typeof batchChatGptWebTotal === "number" && batchChatGptNextOffset >= batchChatGptWebTotal)
      ) {
        batchChatGptLoadedAll = true;
        break;
      }
    }

    return {
      total: batchChatGptWebTotal,
      loadedAll: batchChatGptLoadedAll
    };
  }

  function mergeSidebarBatchItems(items) {
    const knownIds = new Set(batchList.map(item => item.id));
    let addedCount = 0;
    items.forEach(item => {
      if (!item || !item.id || knownIds.has(item.id)) return;
      knownIds.add(item.id);
      batchList.push(item);
      addedCount++;
    });
    return addedCount;
  }

  async function collectSidebarConversations(platform, limit) {
    if (platform === "chatgpt") {
      const result = await fetchChatGptHistoryConversations(limit || 200, 0);
      return result.list.slice(0, Math.max(1, Number(limit) || 200));
    }

    const maxItems = Math.max(1, Number(limit) || 200);
    return getVisibleBatchConversations(platform, maxItems);
  }

  function appendBatchListItems(list, startIndex) {
    const itemsContainer = shadowRoot.getElementById("cv-batch-list-items");
    if (!itemsContainer) return;

    if (displayedConversationsCount === 0 && list.length === 0) {
      itemsContainer.innerHTML = '<div style="text-align:center; color:#94a3b8; font-size:12px; padding:40px 0;">💬 ' +
        escapeHtml(t("batch_export_no_chats", isChineseUi() ? "未在侧边栏找到任何会话。" : "No conversations found in the sidebar. Please expand the sidebar or refresh the page.")) +
        '</div>';
      return;
    }

    const platform = exporter.detectPlatform();
    const listHtml = list.map(function (item, index) {
      const realIndex = startIndex + index;
      const safeTitle = escapeHtml(item.title);
      const safeId = escapeHtml(item.id);
      return `
        <div class="cv-batch-item-row" data-index="${realIndex}" data-chat-id="${safeId}" id="cv-batch-row-${realIndex}">
          <div class="cv-batch-checkbox-wrap">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div class="cv-batch-item-info">
            <span class="cv-batch-item-title" title="${safeTitle}">${safeTitle}</span>
            <span class="cv-batch-item-subtitle">${platform} · ${tx("content_conversation_history", "Conversation history", "会话历史")}</span>
            
            <!-- 行内进度条，默认隐藏 -->
            <div class="cv-batch-row-progress-container" id="cv-batch-progress-bg-${realIndex}">
              <div class="cv-batch-row-progress-bg">
                <div class="cv-batch-row-progress-fill" id="cv-batch-progress-fill-${realIndex}" style="width: 0%;"></div>
              </div>
              <span class="cv-batch-row-progress-text" id="cv-batch-progress-text-${realIndex}">-</span>
            </div>
          </div>
          
          <!-- 状态徽章，默认隐藏 -->
          <div class="cv-batch-item-row-status">
            <span class="cv-batch-badge waiting" id="cv-batch-badge-${realIndex}">Waiting</span>
          </div>
        </div>
      `;
    }).join("");

    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = listHtml;
    while (tempDiv.firstChild) {
      const rowEl = tempDiv.firstChild;
      itemsContainer.appendChild(rowEl);

      rowEl.addEventListener("click", () => {
        if (globalThis.CHATVAULT_IS_BATCH_EXPORT || rowEl.classList.contains("disabled")) return;
        rowEl.classList.toggle("selected");
        updateBatchSelectedCount();
      });
    }

    updateBatchSelectedCount();
  }

  async function loadNextPageOfConversations(platform) {
    const loader = shadowRoot.getElementById("cv-batch-loading-indicator");
    if (loader) {
      loader.style.display = "flex";
      loader.querySelector("span").textContent = displayedConversationsCount === 0
        ? tx("content_syncing_sidebar", "Syncing sidebar history and loading more chats...", "正在同步侧边栏历史，加载更多聊天...")
        : tx("content_continuing_sidebar_sync", "Continuing to load sidebar history...", "正在继续加载侧边栏历史...");
      loader.querySelector(".cv-batch-dot-spinner").style.display = "block";
    }

    const targetCount = displayedConversationsCount + batchPageSize;

    if (platform === "chatgpt") {
      try {
        if (loader) {
          loader.querySelector("span").textContent = displayedConversationsCount === 0
            ? tx("content_syncing_chatgpt_history", "Syncing conversations from ChatGPT history...", "正在从 ChatGPT 历史同步会话...")
            : tx("content_continuing_chatgpt_history", "Continuing to sync ChatGPT history...", "正在继续同步 ChatGPT 历史...");
        }
        await ensureChatGptBatchHistoryLoaded(targetCount);
      } catch (error) {
        console.warn("ChatGPT history API failed:", error);
        if (loader) loader.style.display = "none";
        if (displayedConversationsCount === 0) {
          const itemsContainer = shadowRoot.getElementById("cv-batch-list-items");
          if (itemsContainer) {
            itemsContainer.innerHTML = '<div style="text-align:center; color:#b45309; font-size:12px; line-height:1.5; padding:40px 18px;">' +
              escapeHtml(getBatchChatGptHistoryErrorMessage(error)) +
              '</div>';
          }
        }
        hasMoreConversations = false;
        updateLoadMoreUi();
        return;
      }

      if (loader) loader.style.display = "none";
      const pageItems = batchList.slice(displayedConversationsCount, targetCount);
      if (pageItems.length > 0) {
        appendBatchListItems(pageItems, displayedConversationsCount);
        displayedConversationsCount += pageItems.length;
      }
      hasMoreConversations = batchList.length > displayedConversationsCount || !batchChatGptLoadedAll;
      updateLoadMoreUi();
      return;
    }

    const syncResult = await syncVisibleSidebarConversations(platform, targetCount);

    if (loader) {
      loader.querySelector("span").textContent = tx("content_found_syncing", "Found $1 conversations.", "已发现 $1 个会话。", batchList.length);
    }

    if (loader) loader.style.display = "none";

    const pageItems = batchList.slice(displayedConversationsCount, targetCount);

    if (pageItems.length > 0) {
      appendBatchListItems(pageItems, displayedConversationsCount);
      displayedConversationsCount += pageItems.length;
    }

    hasMoreConversations = batchList.length > displayedConversationsCount ||
                           syncResult.mayHaveMore;

    updateLoadMoreUi();
  }

  async function onLoadMoreClick() {
    const loadMoreBtn = shadowRoot.getElementById("cv-batch-btn-load-more");
    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = tx("content_loading_more", "Loading...", "正在加载...");
    }
    const platform = exporter.detectPlatform();
    await loadNextPageOfConversations(platform);
  }

  function updateLoadMoreUi() {
    const loadMoreContainer = shadowRoot.getElementById("cv-batch-load-more-container");
    if (!loadMoreContainer) return;

    const query = shadowRoot.getElementById("cv-batch-search")?.value.toLowerCase().trim();
    if (query) {
      loadMoreContainer.style.display = "none";
      return;
    }

    if (hasMoreConversations) {
      loadMoreContainer.style.display = "flex";
      loadMoreContainer.innerHTML = `<button type="button" id="cv-batch-btn-load-more" class="cv-batch-btn-load-more">${t("folders_load_more", tx("content_load_more", "Load More", "加载更多"))}</button>`;
      shadowRoot.getElementById("cv-batch-btn-load-more").addEventListener("click", onLoadMoreClick);
    } else {
      if (displayedConversationsCount > 0) {
        loadMoreContainer.style.display = "flex";
        loadMoreContainer.innerHTML = `<span class="cv-batch-all-loaded">${tx("content_all_conversations_loaded", "All conversations loaded", "已加载全部会话")}</span>`;
      } else {
        loadMoreContainer.style.display = "none";
      }
    }
  }

  function showBatchExportModal() {
    const overlay = shadowRoot.getElementById("cv-batch-modal-overlay");
    if (!overlay) return;

    const platform = exporter.detectPlatform();
    const titleTextEl = shadowRoot.getElementById("cv-batch-title-text");
    if (titleTextEl) {
      let platformName = "ChatGPT";
      if (platform === "claude") platformName = "Claude";
      else if (platform === "gemini") platformName = "Gemini";
      titleTextEl.innerHTML = tx("content_batch_export_platform", "Batch export <b>$1</b> chats", "批量导出 <b>$1</b> 会话", platformName);
    }

    shadowRoot.getElementById("cv-batch-list-container").scrollTop = 0;
    
    const panel = shadowRoot.getElementById("cv-batch-settings-panel");
    const chevron = shadowRoot.getElementById("cv-batch-settings-chevron");
    if (panel) panel.classList.remove("active");
    if (chevron) chevron.textContent = "▼";

    // Sync active theme cards
    shadowRoot.querySelectorAll(".cv-batch-theme-option").forEach(card => {
      const themeId = card.getAttribute("data-theme");
      card.classList.toggle("active", themeId === batchSelectedTheme);
    });

    shadowRoot.querySelector(".cv-batch-settings-toggle").style.display = "none";
    shadowRoot.getElementById("cv-batch-limit-warning").style.display = "none";
    
    const clearBtn = shadowRoot.getElementById("cv-batch-btn-clear");
    clearBtn.style.display = "flex";
    clearBtn.textContent = getBatchClearLabel();
    const exportBtn = shadowRoot.getElementById("cv-batch-btn-export");
    exportBtn.style.display = "flex";
    exportBtn.disabled = true;
    const progressPanel = shadowRoot.getElementById("cv-batch-export-progress-panel");
    if (progressPanel) progressPanel.style.display = "none";

    overlay.classList.add("active");
    batchModalOpen = true;

    batchList = [];
    batchActiveItems = [];
    resetBatchChatGptHistoryState();
    displayedConversationsCount = 0;
    hasMoreConversations = true;

    const listWrapper = shadowRoot.getElementById("cv-batch-list-container");
    listWrapper.innerHTML = `
      <div id="cv-batch-list-items"></div>
      <div class="cv-batch-load-more-container" id="cv-batch-load-more-container" style="display: none;"></div>
    `;

    const loader = shadowRoot.getElementById("cv-batch-loading-indicator");

    (async () => {
      try {
        await loadNextPageOfConversations(platform);
      } catch (err) {
        console.error("Batch sidebar sync failed:", err);
        if (loader) {
          loader.querySelector("span").textContent = tx("content_sidebar_sync_failed", "Sidebar sync failed. Please try again.", "同步侧边栏失败，请重试");
          loader.querySelector(".cv-batch-dot-spinner").style.display = "none";
        }
      }
    })();
  }

  function updateBatchSelectedCount() {
    const rows = shadowRoot.querySelectorAll(".cv-batch-item-row");
    const selectedRows = shadowRoot.querySelectorAll(".cv-batch-item-row.selected");
    const count = selectedRows.length;

    const countEl = shadowRoot.getElementById("cv-batch-selected-count");
    if (countEl) countEl.textContent = count;

    const warning = shadowRoot.getElementById("cv-batch-limit-warning");
    const exportBtn = shadowRoot.getElementById("cv-batch-btn-export");

    if (count > 10) {
      if (warning) warning.style.display = "block";
      if (exportBtn) exportBtn.disabled = true;
    } else {
      if (warning) warning.style.display = "none";
      if (exportBtn) exportBtn.disabled = (count === 0);
    }

    // 达到 10 个限制时禁用未选中的项
    rows.forEach(row => {
      if (count >= 10 && !row.classList.contains("selected")) {
        row.classList.add("disabled");
      } else {
        row.classList.remove("disabled");
      }
    });
  }

  function filterBatchList() {
    const query = shadowRoot.getElementById("cv-batch-search").value.toLowerCase().trim();
    const rows = shadowRoot.querySelectorAll(".cv-batch-item-row");
    let hasMatch = false;

    rows.forEach(row => {
      const title = row.querySelector(".cv-batch-item-title").textContent.toLowerCase();
      if (title.indexOf(query) !== -1) {
        row.style.display = "flex";
        hasMatch = true;
      } else {
        row.style.display = "none";
      }
    });

    const loadMoreContainer = shadowRoot.getElementById("cv-batch-load-more-container");
    if (loadMoreContainer) {
      loadMoreContainer.style.display = query ? "none" : (hasMoreConversations ? "flex" : "none");
    }
  }

  function closeBatchModal() {
    const overlay = shadowRoot.getElementById("cv-batch-modal-overlay");
    if (overlay) {
      overlay.classList.remove("active");
    }
    batchModalOpen = false;
  }

  function setBatchExportingUi(isExporting) {
    const clearBtn = shadowRoot.getElementById("cv-batch-btn-clear");
    const exportBtn = shadowRoot.getElementById("cv-batch-btn-export");
    const closeBtn = shadowRoot.getElementById("cv-batch-btn-close");
    const progressPanel = shadowRoot.getElementById("cv-batch-export-progress-panel");

    if (clearBtn) clearBtn.textContent = isExporting ? getBatchCancelLabel() : getBatchClearLabel();
    if (exportBtn) exportBtn.disabled = isExporting || shadowRoot.querySelectorAll(".cv-batch-item-row.selected").length === 0;
    if (closeBtn) closeBtn.setAttribute("aria-label", isExporting ? tx("content_cancel_export", "Cancel export", "取消导出") : getBatchCloseLabel());
    if (progressPanel) progressPanel.style.display = "none";

    shadowRoot.querySelectorAll(".cv-batch-item-row").forEach(row => {
      row.classList.toggle("is-exporting", isExporting);
    });
    shadowRoot.querySelectorAll(".cv-batch-format-btn, .cv-batch-theme-option, .cv-batch-toggle-item input").forEach(el => {
      el.disabled = isExporting;
    });
  }

  function updateBatchExportProgress(message) {
    const progressPanel = shadowRoot.getElementById("cv-batch-export-progress-panel");
    if (progressPanel) progressPanel.style.display = "none";

    const total = Math.max(1, Number(message.total || batchActiveItems.length || 1));
    const currentIndex = Math.max(0, Math.min(total - 1, Number(message.currentIndex ?? message.index ?? 0) || 0));
    const itemPercent = Math.max(0, Math.min(100, Number(message.percent) || 0));
    let completedUnits = currentIndex + itemPercent / 100;

    if (message.status === "item_success" || message.status === "item_failure") {
      completedUnits = currentIndex + 1;
    } else if (message.status === "success") {
      completedUnits = total;
    }

    const overallPercent = Math.max(0, Math.min(100, Math.round((completedUnits / total) * 100)));
    const isComplete = message.status === "success";
    const isCancelled = message.status === "cancelled";
    const issueCount = Math.max(0, Number(message.failureCount || message.issues || 0) || 0);
    const completedCount = isComplete
      ? Math.max(0, Number(message.successCount || total - issueCount) || 0)
      : Math.min(total, Math.floor(completedUnits));
    const title = isComplete
      ? t("batch_export_success", isChineseUi() ? "批量导出已完成！" : "Batch export completed!")
      : isCancelled
        ? t("batch_export_cancelled", isChineseUi() ? "批量导出已取消" : "Export cancelled.")
        : t("batch_export", isChineseUi() ? "批量导出" : "Batch Export");
    const detail = message.progressText || message.title || tx("content_generating_local_file", "Generating local file...", "正在生成本地文件...");

    renderExportProgress(batchSelectedFormat, {
      mode: "batch",
      title,
      label: t("batch_export", isChineseUi() ? "批量导出" : "Batch Export"),
      message: detail,
      total,
      current: Math.min(total, currentIndex + 1),
      completed: completedCount,
      issues: issueCount,
      progress: itemPercent / 100,
      overallProgress: isComplete ? 1 : overallPercent / 100
    }, isComplete || isCancelled ? null : cancelInPageBatchExport);
  }

  async function createBatchExportBlobForItem(item, messages, format, settings, signal, index, total) {
    const platform = getChatPlatform(item) || getCurrentPlatformId();
    const mode = settings.export_ai_replies_only ? "ai_only" : "conversation";
    const transformed = templatePresets.transformMessages(messages, mode, settings);
    let processedMessages = transformed;
    let redactionSummary = { enabled: false, totalMatches: 0, byType: {} };

    const sourceUrl = sanitizeSourceUrl(item.url || getBatchPlatformChatUrl(platform, getChatConversationId(item)));
    const privacyProofResult = privacyProof.generateProof({
      format,
      mode,
      platform,
      settings,
      usageCost: 1,
      imageSummary: {
        total: processedMessages.reduce((sum, msg) => sum + (Array.isArray(msg.contentBlocks) ? msg.contentBlocks.filter((b) => b.type === "image").length : 0), 0),
        requiresOriginalPlatformFetch: true
      }
    });

    const codeIndex = developerExport.extractCodeBlocks(processedMessages);
    const metadata = {
      platform,
      title: item.title || "AI Chat Export",
      sourceUrl,
      messageCount: processedMessages.length,
      redaction: redactionSummary,
      codeIndex,
      privacyProof: privacyProofResult
    };

    return exporter.createExportBlob({
      format,
      messages: processedMessages,
      settings,
      metadata,
      title: metadata.title,
      sourceUrl: metadata.sourceUrl,
      scope: mode,
      signal,
      onProgress: (info) => {
        if (signal.aborted) {
          throw new Error("Export cancelled.");
        }
        const progressMessage = info?.progressText || info?.message || tx("content_generating_export_file", "Generating local export file...", "正在生成本地导出文件...");
        const rawPercent = typeof info?.percent === "number"
          ? info.percent
          : typeof info?.progress === "number"
            ? info.progress * 100
            : 0;
        updateBatchExportProgress({
          status: "item_progress",
          index,
          currentIndex: index,
          total,
          percent: Math.max(0, Math.min(100, Math.round(rawPercent))),
          progressText: progressMessage
        });
      }
    });
  }

  async function runInPageBatchExport(selectedItems, format, settings) {
    const controller = new AbortController();
    batchExportAbortController = controller;
    abortController = controller;
    const signal = controller.signal;
    const total = selectedItems.length;
    const rootName = getBatchExportFolderName();
    const preparedFiles = [];
    const usedPaths = new Set();
    const failures = [];

    try {
      await loadState();
      await exporter.preload();

      for (let index = 0; index < selectedItems.length; index += 1) {
        if (signal.aborted) throw new Error("Export cancelled.");
        const item = selectedItems[index];
        updateBatchExportProgress({
          status: "progress",
          currentIndex: index,
          index,
          total,
          percent: 0,
          progressText: tx("content_loading_conversation_data", "Loading conversation data: $1", "正在加载会话数据：$1", item.title || "")
        });

        try {
          const messages = await fetchConversationMessagesForExport(item);
          if (signal.aborted) throw new Error("Export cancelled.");
          if (!messages.length) {
            throw new Error(tx("content_no_messages_for_batch_item", "No exportable messages found.", "未找到可导出的消息。"));
          }

          updateBatchExportProgress({
            status: "item_progress",
            currentIndex: index,
            index,
            total,
            percent: 12,
            progressText: tx("content_generating_export_file", "Generating local export file...", "正在生成本地导出文件...")
          });

          const blobResult = await createBatchExportBlobForItem(item, messages, format, settings, signal, index, total);
          if (!blobResult || !blobResult.ok || !blobResult.blob) {
            throw new Error(blobResult?.error || "Export failed.");
          }

          preparedFiles.push({
            title: item.title || "",
            filename: blobResult.filename,
            blob: blobResult.blob,
            downloadPath: getAvailableBatchDownloadPath(usedPaths, rootName, blobResult.filename)
          });

          updateBatchExportProgress({
            status: "item_success",
            index,
            currentIndex: index,
            total,
            percent: 100,
            successCount: preparedFiles.length,
            failureCount: failures.length,
            title: item.title || ""
          });
        } catch (error) {
          if (error?.message === "Export cancelled." || error?.name === "AbortError") {
            throw error;
          }
          failures.push({ title: item.title || "", error: error.message || "Export failed." });
          updateBatchExportProgress({
            status: "item_failure",
            index,
            currentIndex: index,
            total,
            percent: 100,
            successCount: preparedFiles.length,
            failureCount: failures.length,
            title: item.title || "",
            error: error.message || "Export failed."
          });
        }
      }

      if (!preparedFiles.length) {
        throw new Error(failures[0]?.error || tx("content_batch_no_files", "No conversations were exported.", "没有成功导出的会话。"));
      }

      updateBatchExportProgress({
        status: "item_progress",
        currentIndex: Math.max(0, total - 1),
        index: Math.max(0, total - 1),
        total,
        percent: 100,
        successCount: preparedFiles.length,
        failureCount: failures.length,
        progressText: tx("content_batch_saving_zip", "Preparing save file...", "正在准备保存文件...")
      });

      hideExportProgress();
      const saveResult = await saveBatchPreparedFiles(preparedFiles, rootName);
      if (!saveResult || !saveResult.ok) {
        if (saveResult?.cancelled) {
          showPageToast(tx("content_export_save_cancelled", "Export cancelled.", "导出已取消。"));
          return;
        }
        throw new Error(saveResult?.error || "Export save failed.");
      }

      if (!isProUser && usageStore && typeof usageStore.incrementDailyUsage === "function") {
        await recordSuccessfulExportUsage(preparedFiles.length);
        updateUIState();
      }

      if (failures.length) {
        showPageToast(tx("content_batch_partial_failure", "Some chats failed to export: $1", "部分会话导出失败：$1", failures.length));
      }
      globalThis.CHATVAULT_ANALYTICS?.track("export_success", {
        platform: getCurrentPlatformId() || "chatgpt",
        properties: { format, source: "batch_export", count: preparedFiles.length }
      });
    } catch (error) {
      if (error?.message === "Export cancelled." || error?.name === "AbortError") {
        showPageToast(t("batch_export_cancelled", isChineseUi() ? "导出已取消。" : "Export cancelled."));
      } else {
        showPageToast(tx("content_export_failed_message", "Export failed: $1", "导出失败：$1", error.message || "Export failed."));
        globalThis.CHATVAULT_ANALYTICS?.track("export_failed", {
          platform: getCurrentPlatformId() || "chatgpt",
          properties: { format, source: "batch_export", error_category: "export_build" }
        });
      }
    } finally {
      hideExportProgress();
      globalThis.CHATVAULT_IS_BATCH_EXPORT = false;
      setBatchExportingUi(false);
      updateBatchSelectedCount();
      cleanupExportObjectUrls();
      if (batchExportAbortController === controller) batchExportAbortController = null;
      if (abortController === controller) abortController = null;
    }
  }

  async function startInPageBatchExport() {
    const selectedRows = shadowRoot.querySelectorAll(".cv-batch-item-row.selected");
    const selectedItems = [];
    
    selectedRows.forEach(row => {
      const index = parseInt(row.getAttribute("data-index"), 10);
      if (batchList[index]) {
        selectedItems.push(batchList[index]);
      }
    });

    if (selectedItems.length === 0) return;

    if (!canUseBatchExportLocally()) {
      showBatchExportUpgradePrompt();
      return;
    }

    batchActiveItems = selectedItems.slice();
    const preflightController = new AbortController();
    batchExportAbortController = preflightController;
    abortController = preflightController;

    function clearBatchPreflightController() {
      if (batchExportAbortController === preflightController) batchExportAbortController = null;
      if (abortController === preflightController) abortController = null;
    }

    function resetBatchPreflightUi() {
      hideExportProgress();
      globalThis.CHATVAULT_IS_BATCH_EXPORT = false;
      setBatchExportingUi(false);
      updateBatchSelectedCount();
      clearBatchPreflightController();
    }

    function isBatchPreflightCancelled() {
      if (!preflightController.signal.aborted) {
        return false;
      }
      clearBatchPreflightController();
      return true;
    }

    globalThis.CHATVAULT_IS_BATCH_EXPORT = true;
    batchModalOpen = true;
    setBatchExportingUi(true);
    updateBatchExportProgress({
      status: "progress",
      currentIndex: 0,
      total: selectedItems.length,
      percent: 0,
      progressText: tx("content_progress_checking_export_access", "Checking export access...", "正在检查导出权限...")
    });

    try {
      await loadState();
      if (isBatchPreflightCancelled()) return;
      if (!canUseBatchExportLocally()) {
        resetBatchPreflightUi();
        showBatchExportUpgradePrompt();
        return;
      }

      const verification = await syncVerifiedExportEntitlement(selectedItems.length);
      if (isBatchPreflightCancelled()) return;
      if (!verification.ok) {
        resetBatchPreflightUi();
        showPageToast(verification.error || tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。"));
        return;
      }
      if (!canUseBatchExportLocally()) {
        resetBatchPreflightUi();
        showBatchExportUpgradePrompt();
        return;
      }

      // 读取设置配置
      const showTitle = shadowRoot.getElementById("cv-toggle-title").checked;
      const aiOnly = shadowRoot.getElementById("cv-toggle-ai-only").checked;
      const watermark = shadowRoot.getElementById("cv-toggle-watermark").checked;
      const sourceUrl = shadowRoot.getElementById("cv-toggle-source-url").checked;
      const platformName = shadowRoot.getElementById("cv-toggle-platform-name").checked;
      const roleLabels = shadowRoot.getElementById("cv-toggle-role-labels").checked;
      const alignRight = shadowRoot.getElementById("cv-toggle-align-right").checked;

      const currentSettings = {
        redaction_enabled: false,
        show_conversation_title: showTitle,
        export_ai_replies_only: aiOnly,
        include_prompt_appendix: false,
        show_chatvault_badge: !watermark,
        include_source_url: sourceUrl,
        show_platform_name: platformName,
        show_role_labels: roleLabels,
        align_user_messages_right: alignRight,
        export_style: batchSelectedTheme
      };

      updateBatchExportProgress({
        status: "progress",
        currentIndex: 0,
        total: selectedItems.length,
        percent: 0,
        progressText: tx("content_local_batch_export_starting", "Starting local batch export...", "正在启动本地批量导出...")
      });
      closeBatchModal();

      const titleTextEl = shadowRoot.getElementById("cv-batch-title-text");
      if (titleTextEl) {
        titleTextEl.innerHTML = tx("content_batch_exporting_count", "Exporting <b>$1</b> chats", "正在批量导出 <b>$1</b> 个会话", selectedItems.length);
      }

      runInPageBatchExport(selectedItems, batchSelectedFormat, currentSettings);
    } catch (error) {
      if (!preflightController.signal.aborted) {
        resetBatchPreflightUi();
        showPageToast(tx("content_export_failed_message", "Export failed: $1", "导出失败：$1", error?.message || "Export failed."));
      }
    } finally {
      clearBatchPreflightController();
    }
  }

  function cancelInPageBatchExport() {
    if (batchExportAbortController) {
      batchExportAbortController.abort();
    }
    globalThis.CHATVAULT_IS_BATCH_EXPORT = false;
    setBatchExportingUi(false);
    hideExportProgress();
    closeBatchModal();
  }

  function handleBatchStatusMessage(message) {
    if (!globalThis.CHATVAULT_IS_BATCH_EXPORT) return;
    
    const selectedRows = shadowRoot.querySelectorAll(".cv-batch-item-row.selected");
    const total = Math.max(1, Number(message.total || batchActiveItems.length || selectedRows.length || 1));

    if (message.status === "progress") {
      const idx = message.currentIndex;
      updateBatchExportProgress({
        ...message,
        total,
        percent: 0,
        progressText: tx("content_opening_conversation_page", "Opening conversation page...", "正在打开会话页面...")
      });
      const titleTextEl = shadowRoot.getElementById("cv-batch-title-text");
      if (titleTextEl) {
        titleTextEl.innerHTML = tx("content_exporting_index_title", "Exporting ($1/$2): <b style='color:#d97706;'>$3</b>", "正在导出 ($1/$2)：<b style='color:#d97706;'>$3</b>", idx + 1, total, escapeHtml(message.title || ""));
      }
      
      const row = selectedRows[idx];
      if (row) {
        const badge = row.querySelector(".cv-batch-badge");
        if (badge) {
          badge.className = "cv-batch-badge loading";
          badge.textContent = "Loading page";
        }
      }
    }
    
    else if (message.status === "item_progress") {
      updateBatchExportProgress({
        ...message,
        total,
        progressText: message.progressText || tx("content_generating_export_file", "Generating local export file...", "正在生成本地导出文件...")
      });
      const row = selectedRows[message.index];
      if (row) {
        const displayStatus = (message.percent < 10) ? "scraping" : "generating";
        const badge = row.querySelector(".cv-batch-badge");
        if (badge) {
          badge.className = "cv-batch-badge " + displayStatus;
          badge.textContent = (displayStatus === "scraping") ? "Scraping content" : "Rendering document";
        }
        
        const progressBg = row.querySelector(".cv-batch-row-progress-container");
        const progressFill = row.querySelector(".cv-batch-row-progress-fill");
        const progressText = row.querySelector(".cv-batch-row-progress-text");
        
        if (progressBg) progressBg.style.display = "flex";
        if (progressFill) progressFill.style.width = message.percent + "%";
        if (progressText) progressText.textContent = message.percent + "%";
      }
    }
    
    else if (message.status === "item_success") {
      updateBatchExportProgress({
        ...message,
        total,
        percent: 100,
        progressText: tx("content_completed_title", "Completed: $1", "已完成：$1", message.title || "")
      });
      const row = selectedRows[message.index];
      if (row) {
        const badge = row.querySelector(".cv-batch-badge");
        if (badge) {
          badge.className = "cv-batch-badge completed";
          badge.textContent = "Completed";
        }
        const progressBg = row.querySelector(".cv-batch-row-progress-container");
        const progressFill = row.querySelector(".cv-batch-row-progress-fill");
        const progressText = row.querySelector(".cv-batch-row-progress-text");
        if (progressBg) progressBg.style.display = "flex";
        if (progressFill) progressFill.style.width = "100%";
        if (progressText) progressText.textContent = "100%";
      }
    }
    
    else if (message.status === "item_failure") {
      updateBatchExportProgress({
        ...message,
        total,
        percent: 100,
        progressText: tx("content_export_failed_title", "Export failed: $1", "导出失败：$1", message.error || message.title || "")
      });
      const row = selectedRows[message.index];
      if (row) {
        const badge = row.querySelector(".cv-batch-badge");
        if (badge) {
          badge.className = "cv-batch-badge failed";
          badge.textContent = "Failed";
          badge.setAttribute("title", message.error || "Export failed");
        }
        const progressBg = row.querySelector(".cv-batch-row-progress-container");
        const progressText = row.querySelector(".cv-batch-row-progress-text");
        if (progressBg) progressBg.style.display = "flex";
        if (progressText) progressText.textContent = "Error";
      }
    }
    
    else if (message.status === "success") {
      updateBatchExportProgress({
        ...message,
        total,
        percent: 100,
        progressText: tx("content_batch_success_failure", "Success: $1, failed: $2", "成功：$1，失败：$2", message.successCount, message.failureCount)
      });
      globalThis.CHATVAULT_IS_BATCH_EXPORT = false;
      setBatchExportingUi(false);
      const titleTextEl = shadowRoot.getElementById("cv-batch-title-text");
      if (titleTextEl) {
        titleTextEl.textContent = t("batch_export_success", isChineseUi() ? "批量导出已完成！" : "Batch export completed!");
      }
      
      const clearBtn = shadowRoot.getElementById("cv-batch-btn-clear");
      if (clearBtn) {
        clearBtn.textContent = getBatchCloseLabel();
      }
      const exportBtn = shadowRoot.getElementById("cv-batch-btn-export");
      if (exportBtn) {
        exportBtn.disabled = true;
      }
      
      window.setTimeout(hideExportProgress, 1200);
    }
    
    else if (message.status === "cancelled") {
      globalThis.CHATVAULT_IS_BATCH_EXPORT = false;
      setBatchExportingUi(false);
      updateBatchExportProgress({
        ...message,
        total,
        percent: 0,
        progressText: t("batch_export_cancelled", isChineseUi() ? "导出已取消" : "Export cancelled.")
      });
      window.setTimeout(hideExportProgress, 600);
      closeBatchModal();
      showPageToast(t("batch_export_cancelled", isChineseUi() ? "导出已被取消。" : "Export cancelled."));
    }
  }

  // 复制纯文本
  async function copyRawText() {
    const rawMessages = parseCurrentChatMessages();
    const plainText = exporter.getPlainText(rawMessages);
    if (!plainText) {
      return { ok: false, error: tx("content_no_copy_text", "This conversation has no text content to copy.", "当前对话没有可复制的文本内容。") };
    }

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(plainText);
        return { ok: true };
      }
    } catch (err) {
      console.warn("Clipboard API copy failed, trying fallback:", err);
    }

    const textarea = document.createElement("textarea");
    textarea.value = plainText;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);

    try {
      textarea.focus();
      textarea.select();
      const copied = document.execCommand && document.execCommand("copy");
      if (!copied) {
        throw new Error("Browser refused clipboard write.");
      }
      return { ok: true };
    } catch (err) {
      console.warn("Copy fallback failed:", err);
      return { ok: false, error: tx("content_copy_failed_refresh", "Copy failed. Refresh the page and try again.", "复制失败，请刷新页面后重试。") };
    } finally {
      textarea.remove();
    }
  }

  // 手动从网页中提取消息，并做基础清洗
  function parseCurrentChatMessages() {
    let raw = [];
    try {
      raw = exporter.parseMessages() || [];
    } catch (e) {
      console.warn("DOM parsing error in export engine:", e);
    }
    return raw;
  }

  function isChatGptHost() {
    return /^(chatgpt\.com|chat\.openai\.com)$/.test(window.location.hostname);
  }

  function isClaudeHost() {
    return /(^|\.)claude\.ai$/.test(window.location.hostname);
  }

  function isGeminiHost() {
    return window.location.hostname === "gemini.google.com";
  }

  function getPlatformFromUrl(value) {
    try {
      const url = new URL(value || window.location.href, window.location.origin);
      const hostname = url.hostname;
      if (/^(chatgpt\.com|chat\.openai\.com)$/.test(hostname)) return "chatgpt";
      if (/(^|\.)claude\.ai$/.test(hostname)) return "claude";
      if (hostname === "gemini.google.com") return "gemini";
    } catch (error) {}
    return exporter.detectPlatform() || "";
  }

  function getCurrentPlatformId() {
    return getPlatformFromUrl(window.location.href);
  }

  function getPlatformLabel(platform) {
    if (platform === "claude") return "Claude";
    if (platform === "gemini") return "Gemini";
    if (platform === "chatgpt") return "ChatGPT";
    return "AI";
  }

  function getPlatformChatIdFromUrl(value, platform) {
    if (!value) return "";
    try {
      const url = new URL(value, window.location.origin);
      const pathPattern = platform === "claude"
        ? /\/chat\/([^/?#]+)/
        : platform === "gemini"
          ? /\/(?:app|gem\/[^/?#]+)\/([^/?#]+)/
          : /^\/c\/([^/?#]+)/;
      const match = url.pathname.match(pathPattern);
      return match && match[1] ? decodeURIComponent(match[1]) : "";
    } catch (error) {
      return "";
    }
  }

  function getChatPlatform(chat) {
    if (chat?.platform === "chatgpt" || chat?.platform === "claude" || chat?.platform === "gemini") {
      return chat.platform;
    }
    return chat?.url ? getPlatformFromUrl(chat.url) : getCurrentPlatformId();
  }

  function getChatConversationId(chat) {
    return chat?.conversationId || chat?.id || getPlatformChatIdFromUrl(chat?.url || "", getChatPlatform(chat));
  }

  function getCurrentConversationForExport() {
    const platform = getCurrentPlatformId();
    const conversationId = getPlatformChatIdFromUrl(window.location.href, platform);
    if (!platform || !conversationId) return null;
    return {
      id: conversationId,
      conversationId,
      platform,
      title: exporter.getConversationTitle ? exporter.getConversationTitle() : "AI Chat Export",
      url: window.location.href
    };
  }

  function isCurrentConversation(chat) {
    const current = getCurrentConversationForExport();
    return Boolean(
      current &&
      current.platform === getChatPlatform(chat) &&
      current.conversationId &&
      current.conversationId === getChatConversationId(chat)
    );
  }

  function cloneExportMessages(messages) {
    try {
      return JSON.parse(JSON.stringify(messages || []));
    } catch (error) {
      return [];
    }
  }

  function getCurrentPageMessagesForChat(chat, pageMessages) {
    if (!isCurrentConversation(chat)) return [];
    if (Array.isArray(pageMessages)) return cloneExportMessages(pageMessages);
    return cloneExportMessages(parseCurrentChatMessages());
  }

  function getCrossPlatformExportMessage(platform) {
    const label = getPlatformLabel(platform);
    const host = platform === "claude"
      ? "https://claude.ai"
      : platform === "gemini"
        ? "https://gemini.google.com"
        : "https://chatgpt.com";
    return "Open " + label + " (" + host + ") and export this conversation there.";
  }

  function ensureCanReadChatBody(chat) {
    const platform = getChatPlatform(chat);
    const currentPlatform = getCurrentPlatformId();
    if (platform !== currentPlatform) {
      throw new Error(getCrossPlatformExportMessage(platform));
    }
    if (platform === "chatgpt" && !isChatGptHost()) throw new Error(getCrossPlatformExportMessage("chatgpt"));
    if (platform === "claude" && !isClaudeHost()) throw new Error(getCrossPlatformExportMessage("claude"));
    if (platform === "gemini" && !isGeminiHost()) throw new Error(getCrossPlatformExportMessage("gemini"));
  }

  async function getExportPlatformFetchers() {
    await exporter.preload();
    if (!exportPlatformFetchers) {
      if (typeof exporter.createExportPlatformFetchers !== "function") {
        throw new Error("Export image fetcher is not available. Refresh the page and try again.");
      }
      exportPlatformFetchers = exporter.createExportPlatformFetchers({
        ensureCanReadChatBody,
        getChatGptWebSession,
        getChatConversationId
      });
    }
    return exportPlatformFetchers;
  }

  async function fetchConversationMessagesForExport(chat, options = {}) {
    const platform = getChatPlatform(chat);
    const pageMessages = getCurrentPageMessagesForChat(chat, options.pageMessages);
    const fetchers = await getExportPlatformFetchers();

    try {
      let messages = [];
      if (platform === "gemini") {
        messages = await fetchers.fetchGeminiConversationMessages(chat);
      } else if (platform === "claude") {
        messages = await fetchers.fetchClaudeConversationMessages(chat);
      } else {
        messages = await fetchers.fetchChatGptConversationMessages(chat, { pageMessages });
      }

      if (Array.isArray(messages) && messages.length > 0) {
        return cloneExportMessages(messages);
      }
      if (pageMessages.length > 0) {
        return pageMessages;
      }
      return [];
    } catch (error) {
      if (pageMessages.length > 0) {
        console.warn("Full conversation fetch failed, falling back to current page messages:", error);
        return pageMessages;
      }
      throw error;
    }
  }

  async function getCurrentConversationMessagesForExport(pageMessages) {
    const chat = getCurrentConversationForExport();
    if (!chat) return pageMessages;
    return fetchConversationMessagesForExport(chat, { pageMessages });
  }

  function sanitizeBatchPathSegment(value, fallback = "Untitled") {
    return String(value || fallback)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/^\.+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 96) || fallback;
  }

  function getBatchExportFolderName(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    const stamp = [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-") + " " + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join("-");
    return sanitizeBatchPathSegment("AI Chat Export " + stamp, "AI Chat Export");
  }

  function splitBatchFilename(filename) {
    const clean = sanitizeBatchPathSegment(filename, "AI-Chat-Export");
    const match = clean.match(/^(.*?)(\.[^.]+)$/);
    return match
      ? { base: match[1] || "AI-Chat-Export", ext: match[2] }
      : { base: clean, ext: "" };
  }

  function getAvailableBatchDownloadPath(usedPaths, rootName, preferredName) {
    const parts = splitBatchFilename(preferredName);
    const root = sanitizeBatchPathSegment(rootName, "AI Chat Export");
    for (let index = 0; index < 1000; index += 1) {
      const candidateName = index
        ? parts.base + "-" + (index + 1) + parts.ext
        : parts.base + parts.ext;
      const candidatePath = root ? root + "/" + candidateName : candidateName;
      if (!usedPaths.has(candidatePath)) {
        usedPaths.add(candidatePath);
        return candidatePath;
      }
    }
    const fallbackPath = root + "/" + parts.base + "-" + Date.now() + parts.ext;
    usedPaths.add(fallbackPath);
    return fallbackPath;
  }

  async function saveBatchPreparedFiles(preparedFiles, rootName) {
    if (!preparedFiles.length) {
      return { ok: false, error: "No files were prepared." };
    }
    for (const file of preparedFiles) {
      const result = await exporter.saveBlob(file.blob, file.downloadPath, { saveAs: false });
      if (!result.ok) return result;
    }
    return { ok: true, filename: rootName };
  }

  // 更新整体面板状态
  function updateUIState() {
    if (!shadowRoot) return;

    // 1. 更新登录按钮状态
    const loginBtn = shadowRoot.getElementById("login-btn");
    if (loginBtn) {
      if (isProUser) {
        loginBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round">
            <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5L3 8z"></path>
            <path d="M5 18h14"></path>
          </svg>
          <span>${t("popup_account", isChineseUi() ? "账号" : "Account")}</span>
        `;
        loginBtn.style.color = "#92400e";
        loginBtn.style.borderColor = "#f59e0b";
      } else if (currentUserProfile?.email) {
        loginBtn.innerHTML = t("popup_free_account", isChineseUi() ? "免费账号" : "Free Account");
        loginBtn.style.color = "";
        loginBtn.style.borderColor = "";
      } else {
        loginBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>
          </svg>
          <span>${t("popup_btn_login", isChineseUi() ? "登录" : "Sign In")}</span>
        `;
        loginBtn.style.color = "";
        loginBtn.style.borderColor = "";
      }
    }

    // 2. 更新配额状态
    const quotaInfo = shadowRoot.getElementById("quota-status-info");
    if (quotaInfo) {
      const remaining = entitlements.getRemainingFreeExports(currentUserProfile, dailyUsage);
      if (isProUser) {
        quotaInfo.innerHTML = "<b>" + escapeHtml(t("popup_pro_quota_status", isChineseUi() ? "无限导出额度可用" : "Unlimited exports available")) + "</b><br/>" +
          escapeHtml(tx("content_pro_quota_desc", "Unlimited report-grade PDF and Word exports are available. All premium business themes are unlocked.", "拥有无限次出版级 PDF、Word 导出额度，已解锁全部高级商业排版主题。"));
      } else {
        quotaInfo.innerHTML = "<b>" + escapeHtml(tx("content_guest_quota_mode", "Guest free quota mode", "Guest 免登录额度模式")) + "</b><br/>" +
          escapeHtml(tx("content_quota_remaining_prefix", "Today's remaining quota: ", "今日剩余额度：")) + "<b>" + remaining + " / 3</b> " + escapeHtml(tx("content_quota_remaining_suffix", "exports.", "次保存机会。")) + "<br/>" +
          "<span style='font-size:11px; color: var(--text-secondary);'>" + escapeHtml(tx("content_upgrade_quota_hint", "Upgrade to Pro to remove quota and watermark limits.", "升级到 Pro 可解除全部额度及水印限制。")) + "</span>";
      }
    }
  }

  // 登出流程
  async function performSignOut() {
    await auth.signOut();
    invalidatePopupStateCache();
    await loadState();
    updateUIState();
  }

  async function performSignIn() {
    if (!auth || typeof auth.signInWithGoogle !== "function") {
      throw new Error(tx("content_login_service_unavailable", "Sign-in is temporarily unavailable. Refresh the page and try again.", "登录服务暂时不可用，请刷新页面后重试。"));
    }

    const session = await auth.signInWithGoogle();
    if (!session) {
      return false;
    }

    await loadState();
    invalidatePopupStateCache();
    updateUIState();
    return true;
  }

  // 购买跳转流程
  async function triggerCheckout() {
    try {
      const billing = globalThis.CHATVAULT_BILLING;
      if (!billing || typeof billing.createCheckoutSession !== "function") {
        throw new Error(tx("content_checkout_unavailable", "Checkout is temporarily unavailable. Refresh the page and try again.", "结账服务暂时不可用，请刷新页面后重试。"));
      }
      if (!auth || typeof auth.getSession !== "function") {
        throw new Error(tx("content_login_service_unavailable", "Sign-in is temporarily unavailable. Refresh the page and try again.", "登录服务暂时不可用，请刷新页面后重试。"));
      }

      let session = currentSession?.access_token ? currentSession : null;
      if (!session) {
        session = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false }).catch(() => null);
      }
      if (!session?.access_token) {
        session = await auth.signInWithGoogle();
        if (!session?.access_token) {
          session = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false }).catch(() => null);
        }
      }
      if (!session?.access_token) {
        throw new Error(tx("content_checkout_login_required", "Please sign in before checkout so Pro access can be linked to your account.", "请先登录再订阅，以便自动绑定 Pro 权益。"));
      }

      currentSession = session;
      const email = session?.user?.email || currentUserProfile?.email || "";
      const source = "exporter_extension";
      const checkout = await billing.createCheckoutSession({
        accessToken: session.access_token,
        customerEmail: email,
        planId: "yearly",
        source
      });
      const checkoutUrl = checkout?.checkoutUrl || "";
      if (!checkoutUrl) {
        throw new Error(tx("content_checkout_unavailable", "Checkout is temporarily unavailable. Refresh the page and try again.", "结账服务暂时不可用，请刷新页面后重试。"));
      }

      window.open(checkoutUrl, "_blank");
    } catch (e) {
      console.warn("Failed to build checkout URL:", e);
      alert(tx("content_checkout_open_failed", "Could not open checkout: $1", "无法打开购买页面：$1", e && e.message ? e.message : tx("content_refresh_retry", "Refresh the page and try again.", "请刷新页面后重试。")));
    }
  }

  function getUpgradePromptMessage(message) {
    if (message === "You have used today's 3 free saved exports.") {
      return tx("content_upgrade_free_limit", "You have used today's 3 free exports.", "您今日已使用完 3 次免费导出额度限制。");
    }
    if (message === "This professional template requires Pro.") {
      return tx("content_upgrade_template", "The selected professional template requires Pro.", "所选的场景化专业模板需要 Pro 权限。");
    }
    if (message === "Premium report themes require Pro.") {
      return tx("content_upgrade_theme", "Premium report themes require Pro.", "高级商务排版主题（如 Oxford、McKinsey）需要 Pro 权限。");
    }
    if (message === "Batch export requires Pro.") {
      return tx("content_upgrade_batch_export", "Batch export requires Pro.", "批量导出需要 Pro 权限。");
    }
    if (message === "Prompt Appendix requires Pro.") {
      return tx("content_upgrade_appendix", "Prompt Appendix requires Pro.", "附带 Prompt 提问附录功能需要 Pro 权限。");
    }
    if (message === "Hiding watermark requires Pro.") {
      return tx("content_upgrade_watermark", "Hiding the AI Chat Export watermark requires Pro.", "隐藏 AI Chat Export 水印签名需要 Pro 权限。");
    }
    return String(message || tx("content_upgrade_desc", "Upgrade to AI Chat Export Pro to remove quota limits.", "升级到 Pro 可解除额度限制。"));
  }

  function openSubscribePanelFromPage() {
    const now = Date.now();
    if (now - subscribePanelRequestAt < 1200) {
      return;
    }
    subscribePanelRequestAt = now;
    chrome.runtime.sendMessage({ type: "CHATVAULT_OPEN_SUBSCRIBE", source: "extension_vip_modal_limit", planId: "yearly" }, (response) => {
      if (chrome.runtime.lastError || !response || response.ok === false) {
        showPageToast(tx("content_open_subscribe_panel_failed", "Open the AI Chat Export toolbar popup to subscribe.", "请打开浏览器工具栏中的 AI Chat Export 弹窗完成订阅。"));
      }
    });
  }

  function showUpgradePrompt(message) {
    showPageToast(getUpgradePromptMessage(message));
    openSubscribePanelFromPage();
  }

  function showPageToast(message) {
    if (!shadowRoot) return;
    const toast = shadowRoot.getElementById("cv-page-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("active");
    if (pageToastTimer) clearTimeout(pageToastTimer);
    pageToastTimer = setTimeout(() => {
      toast.classList.remove("active");
    }, 2400);
  }

  function findScrollContainer() {
    const platform = exporter.detectPlatform();
    let scroller = null;
    if (platform === "gemini") {
      scroller = document.querySelector('infinite-scroller, .conversation-container, mat-sidenav-content');
    } else if (platform === "chatgpt") {
      scroller = document.querySelector('main div.overflow-y-auto, div[class*="react-scroll-to-bottom"]');
    } else if (platform === "claude") {
      scroller = document.querySelector('main div.overflow-y-auto, div.overflow-y-auto');
    }
    if (!scroller) {
      const main = document.querySelector('main') || document.body;
      const elements = main.querySelectorAll('*');
      for (const el of elements) {
        const style = window.getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
          scroller = el;
          break;
        }
      }
    }
    return scroller || document.querySelector('main') || document.body;
  }

  async function scrollAndLoadAllMessages() {
    const scroller = findScrollContainer();
    if (!scroller) return;

    let previousHeight = 0;
    let stableCount = 0;
    const maxAttempts = 30;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (scroller === document.body || scroller === document.documentElement) {
        window.scrollTo(0, 0);
      } else {
        scroller.scrollTop = 0;
      }

      await new Promise(r => setTimeout(r, 400));

      const currentHeight = (scroller === document.body || scroller === document.documentElement)
        ? document.documentElement.scrollHeight
        : scroller.scrollHeight;

      if (currentHeight === previousHeight) {
        stableCount++;
        if (stableCount >= 3) break;
      } else {
        stableCount = 0;
      }
      previousHeight = currentHeight;
    }

    if (scroller === document.body || scroller === document.documentElement) {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 核心：执行文档导出
  async function performExport() {
    const formatForExport = activeFormat || "pdf";
    const platformForExport = exporter.detectPlatform();
    const isSelectedExport = exportSettings.mode === "selected";

    if (!platformForExport) {
      showPageToast(t("toast_no_open_chat", isChineseUi() ? "请在支持的 AI 对话页打开并加载聊天内容后再导出。" : "Open a ChatGPT, Claude, or Gemini conversation to export."));
      return;
    }

    if (hasKnownExhaustedFreeQuota()) {
      showUpgradePrompt("You have used today's 3 free saved exports.");
      return;
    }

    const presetForExport = currentPreset;
    const settingsForExport = { ...exportSettings };
    const controller = new AbortController();
    abortController = controller;
    const signal = controller.signal;
    const isSingleExport = !globalThis.CHATVAULT_IS_BATCH_EXPORT;

    function clearCurrentExportController() {
      if (abortController === controller) {
        abortController = null;
      }
    }

    function isCurrentExportCancelled() {
      if (!signal.aborted) {
        return false;
      }
      hideExportProgress();
      clearCurrentExportController();
      return true;
    }

    if (isSingleExport) {
      renderExportProgress(formatForExport, {
        mode: "single",
        title: getSingleExportProgressTitle(formatForExport),
        message: tx("content_progress_checking_export_access", "Checking export access...", "正在检查导出权限..."),
        progress: EXPORT_PROGRESS_INITIAL,
        overallProgress: EXPORT_PROGRESS_INITIAL
      });
    }

    await loadState();
    if (isCurrentExportCancelled()) return;

    const verification = await syncVerifiedExportEntitlement(1);
    if (isCurrentExportCancelled()) return;
    if (!verification.ok) {
      hideExportProgress();
      clearCurrentExportController();
      showPageToast(verification.error || tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。"));
      return;
    }

    const remaining = entitlements.getRemainingFreeExports(currentUserProfile, dailyUsage);
    if (!isProUser && (verification.allowed === false || remaining <= 0)) {
      hideExportProgress();
      clearCurrentExportController();
      showUpgradePrompt("You have used today's 3 free saved exports.");
      return;
    }

    const entitlementIssue = getEntitlementIssue(settingsForExport, presetForExport, currentUserProfile);
    if (entitlementIssue) {
      hideExportProgress();
      clearCurrentExportController();
      showUpgradePrompt(entitlementIssue);
      return;
    }

    if (isSingleExport) {
      renderExportProgress(formatForExport, {
        mode: "single",
        title: getSingleExportProgressTitle(formatForExport),
        message: tx("content_progress_initializing", "Initializing export engine...", "正在初始化导出引擎..."),
        progress: EXPORT_PROGRESS_INITIAL,
        overallProgress: EXPORT_PROGRESS_INITIAL
      }, cancelExport);
    }

    try {
      await exporter.preload();
    } catch (error) {
      hideExportProgress();
      clearCurrentExportController();
      showPageToast(tx("content_export_engine_load_failed", "Export engine failed to load. Refresh the page and try again.", "导出引擎加载失败，请刷新页面后重试。"));
      return;
    }
    if (isCurrentExportCancelled()) return;

    if (globalThis.CHATVAULT_IS_BATCH_EXPORT) {
      try {
        await scrollAndLoadAllMessages();
      } catch (err) {
        console.warn("Failed to scroll and load all messages:", err);
      }
    }

    const pageMessagesForExport = isSelectedExport && typeof exporter.getSelectedMessages === "function"
      ? exporter.getSelectedMessages()
      : parseCurrentChatMessages();
    let rawMessagesForExport = pageMessagesForExport;
    if (!isSelectedExport && platformForExport && pageMessagesForExport.length > 0) {
      if (!globalThis.CHATVAULT_IS_BATCH_EXPORT) {
        renderExportProgress(formatForExport, {
          mode: "single",
          title: getSingleExportProgressTitle(formatForExport),
          message: tx("content_progress_loading_full_conversation", "Loading complete conversation data...", "正在加载完整会话数据..."),
          progress: 0.08,
          overallProgress: 0.08
        });
      }
      try {
        rawMessagesForExport = await getCurrentConversationMessagesForExport(pageMessagesForExport);
        if (isCurrentExportCancelled()) return;
      } catch (error) {
        console.warn("Full conversation fetch failed before export, using parsed page messages:", error);
        rawMessagesForExport = pageMessagesForExport;
      }
    }
    if (!platformForExport || rawMessagesForExport.length === 0) {
      hideExportProgress();
      clearCurrentExportController();
      showPageToast(isSelectedExport
        ? tx("content_select_one_before_export", "Select at least one message before exporting.", "请先选择至少一条对话后再导出。")
        : t("toast_no_open_chat", isChineseUi() ? "请在支持的 AI 对话页打开并加载聊天内容后再导出。" : "Open a ChatGPT, Claude, or Gemini conversation to export."));
      return;
    }

    // 使用 ChatVault AI 3.1.5 同款顶部进度条，避免全屏遮罩挡住页面/批量列表。
    const overlay = shadowRoot.getElementById("progress-overlay");
    if (overlay) overlay.classList.remove("active");
    let exportStatsForProgress = getExportProgressStats(rawMessagesForExport);
    let suppressSingleProgressAfterSaveDialog = false;

    function reportBatchItemProgress(percent, message) {
      return { percent, message };
    }

    function setExportProgress(message, percent) {
      if (suppressSingleProgressAfterSaveDialog && !globalThis.CHATVAULT_IS_BATCH_EXPORT) {
        return;
      }
      const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
      renderExportProgress(formatForExport, {
        mode: "single",
        title: getSingleExportProgressTitle(formatForExport),
        message: message || "Preparing conversation export",
        progress: safePercent / 100,
        overallProgress: safePercent / 100,
        exportStats: exportStatsForProgress
      });
      reportBatchItemProgress(safePercent, message);
    }

    setExportProgress(tx("content_progress_initializing", "Initializing export engine...", "正在初始化导出引擎..."), EXPORT_PROGRESS_INITIAL * 100);

    try {
      // 1. 抓取聊天消息
      setExportProgress(tx("content_progress_parsing", "Parsing page content...", "正在解析页面内容..."), 8);
      const rawMessages = rawMessagesForExport;
      
      if (signal.aborted) throw new Error("Export cancelled.");

      const mode = settingsForExport.mode || (settingsForExport.export_ai_replies_only ? "ai_only" : "conversation");
      
      // 2. 模板结构优化转换
      setExportProgress(tx("content_progress_formatting", "Applying export formatting...", "正在应用导出格式..."), 16);
      const transformed = templatePresets.transformMessages(rawMessages, mode, settingsForExport);

      // 2.5 导出前健康检查（批量导出模式下跳过，避免阻塞自动化流程）
      if (!globalThis.CHATVAULT_IS_BATCH_EXPORT) {
        const health = exportHealth.checkHealth({
          messages: transformed,
          format: formatForExport,
          mode,
          platform: platformForExport,
          imageLimits: exporter.IMAGE_LIMITS
        });
        const blockingIssues = (health.issues || []).filter(
          (issue) => issue.severity === "high_risk" && issue.id !== "empty_conversation"
        );
        if (blockingIssues.length > 0) {
          hideExportProgress();
          showPageToast(blockingIssues.map((issue) => issue.message).join(" / "));
          return;
        }
      }

      // 2.6 生成隐私证明（用于记录到凭证，不阻塞导出）
      const privacyProofResult = privacyProof.generateProof({
        format: formatForExport,
        mode,
        platform: platformForExport,
        settings: settingsForExport,
        usageCost: 1,
        imageSummary: {
          total: transformed.reduce((sum, msg) => sum + (Array.isArray(msg.contentBlocks) ? msg.contentBlocks.filter((b) => b.type === "image").length : 0), 0),
          requiresOriginalPlatformFetch: true
        }
      });

      let redactionSummary = { enabled: false, totalMatches: 0, byType: {} };
      let processedMessages = transformed;
      exportStatsForProgress = getExportProgressStats(processedMessages);
      const selectedMessagesForBlob = mode === "selected" ? processedMessages : undefined;

      // 3. 提取开发代码块索引 (若有)
      const codeIndex = developerExport.extractCodeBlocks(processedMessages);
      
      // 5. 编译元数据
      const metadata = {
        platform: exporter.detectPlatform(),
        title: exporter.getConversationTitle(),
        sourceUrl: sanitizeSourceUrl(window.location.href),
        messageCount: processedMessages.length,
        redaction: redactionSummary,
        codeIndex,
        privacyProof: privacyProofResult
      };

      // 6. 执行核心导出 (在浏览器本地渲染并生成 Blob/ZIP/PNG)
      setExportProgress(tx("content_progress_building", "Building document...", "正在构建文档..."), 32);

      await exporter.preload();
      const builderProgressHandler = getExportProgressHandler(
        getExportFormatLabel(formatForExport),
        formatForExport,
        { exportStats: exportStatsForProgress }
      );

      const blobResult = await exporter.createExportBlob({
        format: formatForExport,
        messages: processedMessages,
        selectedMessages: selectedMessagesForBlob,
        settings: settingsForExport,
        metadata,
        title: metadata.title,
        sourceUrl: metadata.sourceUrl,
        scope: mode,
        signal,
        onProgress: (info) => {
          if (signal.aborted) {
            throw new Error("Export cancelled.");
          }
          const progressMessage = info?.progressText || info?.message || tx("content_progress_building", "Building document...", "正在构建文档...");
          builderProgressHandler({
            ...(info || {}),
            message: progressMessage
          });
          const percent = info && typeof info.percent === "number"
            ? info.percent
            : info && typeof info.progress === "number"
              ? info.progress * 100
              : null;
          if (percent !== null) {
            reportBatchItemProgress(percent, progressMessage);
          }
        }
      });

      if (abortController.signal.aborted) {
        throw new Error("Export cancelled.");
      }

      if (!blobResult || !blobResult.ok) {
        throw new Error(blobResult?.error || "Blob creation failed");
      }

      // 7. 保存导出文件
      setExportProgress(tx("content_progress_downloading", "Preparing safe download...", "正在准备安全下载..."), 94);

      if (signal.aborted) {
        throw new Error("Export cancelled.");
      }

      if (!globalThis.CHATVAULT_IS_BATCH_EXPORT) {
        suppressSingleProgressAfterSaveDialog = true;
        hideExportProgress();
      }

      const saveResult = await exporter.saveBlob(blobResult.blob, blobResult.filename, {
        saveAs: settingsForExport.saveAs !== false
      });

      if (signal.aborted) {
        throw new Error("Export cancelled.");
      }
      if (saveResult?.cancelled) {
        hideExportProgress();
        showPageToast(tx("content_export_save_cancelled", "Export cancelled.", "导出已取消。"));
        return;
      }
      if (!saveResult || !saveResult.ok) {
        globalThis.CHATVAULT_ANALYTICS?.track("export_failed", {
          platform: metadata.platform,
          properties: { format: formatForExport, source: "current_chat", error_category: "export_build" }
        });
        throw new Error(saveResult?.error || "Save dialog is not available.");
      }

      // 8. 成功后生成凭证
      setExportProgress(tx("content_progress_receipt", "Generating export receipt...", "正在生成导出凭证..."), 98);
      try {
        const receipt = await globalThis.CHATVAULT_EXPORT_RECEIPT.generateReceipt(blobResult.blob, {
          platform: metadata.platform,
          sourceUrl: metadata.sourceUrl,
          format: formatForExport,
          mode,
          messageCount: metadata.messageCount,
          redaction: redactionSummary,
          filename: saveResult.filename || blobResult.filename
        });
        lastReceipt = receipt;
      } catch (e) {
        console.warn("Receipt generation failed:", e);
      }

      // 9. 扣除本地 Guest 次数
      if (!isProUser) {
        await recordSuccessfulExportUsage(1);
        updateUIState();
      }

      // 10. 如果是选择模式导出，成功后自动退出选择模式
      if (mode === "selected") {
        exporter.exitSelectionMode();
        const bar = shadowRoot.getElementById("selection-bar");
        if (bar) bar.classList.remove("active");
      }

      globalThis.CHATVAULT_ANALYTICS?.track("export_success", {
        platform: metadata.platform,
        properties: { format: formatForExport, source: "current_chat" }
      });
      if (!suppressSingleProgressAfterSaveDialog || globalThis.CHATVAULT_IS_BATCH_EXPORT) {
        setExportProgress(tx("content_progress_complete", "Export complete.", "导出完成。"), 100);
      }
      if (!globalThis.CHATVAULT_IS_BATCH_EXPORT && !suppressSingleProgressAfterSaveDialog) {
        window.setTimeout(hideExportProgress, 900);
      }

    } catch (e) {
      if (e.message !== "Export cancelled.") {
        hideExportProgress();
        showPageToast(tx("content_export_failed_message", "Export failed: $1", "导出失败：$1", e.message || t("toast_export_failed", isChineseUi() ? "导出失败。" : "Export failed.")));

        globalThis.CHATVAULT_ANALYTICS?.track("export_failed", {
          platform: exporter.detectPlatform(),
          properties: { format: formatForExport, source: "current_chat", error_category: "export_build" }
        });
      } else {
        hideExportProgress();
        showPageToast(t("batch_export_cancelled", isChineseUi() ? "导出已取消。" : "Export cancelled."));
      }
      if (globalThis.CHATVAULT_IS_BATCH_EXPORT) {
        throw e;
      }
    } finally {
      cleanupExportObjectUrls();
      clearCurrentExportController();
    }
  }

  // 取消或关闭导出提示罩
  function cancelExport() {
    if (abortController) {
      abortController.abort();
    }
    hideExportProgress();
    const overlay = shadowRoot.getElementById("progress-overlay");
    if (overlay) {
      overlay.classList.remove("active");
    }
    const cancelBtn = shadowRoot.getElementById("cancel-export-btn");
    if (cancelBtn) {
      cancelBtn.textContent = "Cancel";
    }
  }

  // 监听后台主动触发的消息 (例如右键菜单或 contextMenu, 以及来自 popup.js 的导出配置)
  function listenMessages() {
    if (runtimeMessageListenerAttached) {
      return;
    }
    runtimeMessageListenerAttached = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return;

      // 1. 处理右键菜单或通知触发的直接导出
      if (message.type === "CHATVAULT_TRIGGER_EXPORT") {
        const format = normalizeContextExportFormat(message.format);
        if (!isContextExportReady()) {
          queueContextExportRequest(format);
          sendResponse({ ok: true, queued: true });
          return true;
        }

        executeContextExportRequest(format).catch((error) => {
          showPageToast(error?.message || t("toast_export_failed", isChineseUi() ? "导出失败。" : "Export failed."));
        });
        sendResponse({ ok: true });
        return true;
      }

      // 1.5 处理 Popup 发送的登出消息，强制重置网页端会话状态与缓存
      if (message.type === "CHATVAULT_POPUP_LOGOUT") {
        (async () => {
          _popupStateCache = null;
          try {
            await entitlements?.clearCachedState?.();
          } catch (error) {}
          currentSession = null;
          currentUserProfile = null;
          isProUser = false;
          updateUIState();
          sendResponse({ ok: true });
        })();
        return true;
      }

      // 2. 为 Popup 提供最新的运行状态数据
      if (message.type === "CHATVAULT_GET_POPUP_STATE") {
        (async () => {
          try {
            // 使用缓存（5分钟内复用，减少不必要的 API 请求）
            const now = Date.now();
            if (!message.forceRefresh && _popupStateCache && (now - _popupStateCacheAt) < POPUP_STATE_CACHE_TTL_MS) {
              // 缓存命中，但 lastReceipt 和 exportSettings 需实时更新
              sendResponse({
                ..._popupStateCache,
                exportSettings: exportSettings,
                lastReceipt: lastReceipt
              });
              return;
            }

            await loadState();
            const rawMessages = parseCurrentChatMessages();
            const mode = exportSettings.export_ai_replies_only ? "ai_only" : "conversation";
            const platform = exporter.detectPlatform();
            
            const transformed = templatePresets.transformMessages(rawMessages, mode, exportSettings);
            const health = exportHealth.checkHealth({
              messages: transformed,
              format: activeFormat || "pdf",
              mode,
              platform,
              imageLimits: exporter.IMAGE_LIMITS
            });
            
            const proof = privacyProof.generateProof({
              format: activeFormat || "pdf",
              mode,
              platform,
              settings: exportSettings,
              usageCost: 1,
              imageSummary: {
                total: health.summary.imageCount,
                requiresOriginalPlatformFetch: true
              }
            });

            const remaining = entitlements.getRemainingFreeExports(currentUserProfile, dailyUsage);
            
            const stateSnapshot = {
              ok: true,
              isProUser: isProUser,
              email: currentUserProfile?.email || currentSession?.user?.email || "",
              avatarUrl: currentSession?.user?.user_metadata?.avatar_url || currentSession?.user?.user_metadata?.picture || "",
              remainingQuota: remaining,
              profile: currentUserProfile,
              dailyUsage: dailyUsage,
              exportSettings: exportSettings,
              privacyProof: proof,
              lastReceipt: lastReceipt,
              health: health
            };

            // 存入缓存
            _popupStateCache = stateSnapshot;
            _popupStateCacheAt = now;

            updateUIState();

            sendResponse(stateSnapshot);
          } catch (e) {
            console.error("Error in CHATVAULT_GET_POPUP_STATE:", e);
            sendResponse({ ok: false, error: e.message });
          }
        })();
        return true;
      }

      // 3. 处理 Popup 发起的导出
      if (message.type === "CHATVAULT_POPUP_EXPORT") {
        (async () => {
          try {
            await waitForContextExportReady();
            activeFormat = normalizeContextExportFormat(message.format);
            // 如果 popup 携带了最新设置，先同步更新
            if (message.settings && typeof message.settings === "object") {
              exportSettings = { ...exportSettings, ...message.settings };
              if (exportSettings.export_style) {
                batchSelectedTheme = exportSettings.export_style;
              }
              persistExportSettings();
              invalidatePopupStateCache();
            }
            await performExport();
            await loadState();
            const remaining = entitlements.getRemainingFreeExports(currentUserProfile, dailyUsage);
            sendResponse({
              ok: true,
              isProUser,
              remainingQuota: remaining,
              dailyUsage,
              profile: currentUserProfile
            });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error?.message || tx("content_export_failed_message", "Export failed.", "导出失败。")
            });
          }
        })();
        return true;
      }

      // 4. 处理 Popup 发起的自定义选择性导出
      if (message.type === "CHATVAULT_POPUP_CUSTOM_EXPORT") {
        (async () => {
          try {
            await waitForContextExportReady();
            await executeContextExportRequest("select");
            sendResponse({ ok: true });
          } catch (error) {
            sendResponse({ ok: false, error: error?.message || tx("content_export_failed_message", "Export failed.", "导出失败。") });
          }
        })();
        return true;
      }

      // 5. 处理 Popup 发起的一键复制
      if (message.type === "CHATVAULT_POPUP_COPY_TEXT") {
        (async () => {
          try {
            sendResponse(await copyRawText());
          } catch (e) {
            sendResponse({ ok: false, error: e.message || tx("content_copy_failed_refresh", "Copy failed. Refresh the page and try again.", "复制失败，请刷新页面后重试。") });
          }
        })();
        return true;
      }

      // 6. 处理 Popup 发起的登录状态切换
      if (message.type === "CHATVAULT_POPUP_LOGIN_CLICK") {
        (async () => {
          try {
            if (isProUser || currentUserProfile) {
              await performSignOut();
            } else {
              await performSignIn();
            }
            sendResponse({ ok: true });
          } catch (error) {
            const messageText = error && error.message ? error.message : tx("content_login_failed_refresh", "Sign-in failed. Refresh the page and try again.", "登录失败，请刷新页面后重试。");
            alert(t("popup_login_failed", isChineseUi() ? "登录失败：$1" : "Sign-in failed: $1", messageText));
            sendResponse({ ok: false, error: messageText });
          }
        })();
        return true;
      }

      // 7. 处理 Popup 实时变动的选项配置
      if (message.type === "CHATVAULT_POPUP_UPDATE_SETTINGS") {
        exportSettings = { ...exportSettings, ...message.settings };
        if (exportSettings.export_style) {
          batchSelectedTheme = exportSettings.export_style;
        }
        persistExportSettings();
        // 设置变更后使 popup state 缓存失效，确保下次打开 popup 拉取最新健康检查结果
        invalidatePopupStateCache();
        sendResponse({ ok: true });
        return true;
      }

      // 8. 处理 Scrape Sidebar 请求
      if (message.type === "CHATVAULT_SCRAPE_SIDEBAR") {
        (async () => {
          try {
            const platform = exporter.detectPlatform();
            const list = await collectSidebarConversations(platform, Number(message.limit) || 200);
            sendResponse({ ok: true, list });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        })();
        return true;
      }

      // 9. 处理展示批量导出弹窗请求
      if (message.type === "CHATVAULT_SHOW_BATCH_EXPORT") {
        (async () => {
          try {
            await waitForContextExportReady();
            showBatchExportModal();
            sendResponse({ ok: true });
          } catch (error) {
            sendResponse({ ok: false, error: error?.message || tx("content_export_failed_message", "Export failed.", "导出失败。") });
          }
        })();
        return true;
      }

      // 10. 处理批量导出状态更新消息
      if (message.type === "CHATVAULT_BATCH_EXPORT_STATUS") {
        handleBatchStatusMessage(message);
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  // 执行初始化
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
