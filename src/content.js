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
  const SUPABASE_SESSION_STORAGE_KEY = "chatvault_supabase_session";
  const ENTITLEMENT_STATE_CACHE_KEY = "chatvault_exporter_entitlement_state_v1";
  const EXPORT_SETTINGS_STORAGE_KEY = "chatvault_export_settings";
  const FREE_QUOTA_EXHAUSTED_MESSAGE = "You have used today's 3 free exports.";

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
  let usageStateLoaded = false;
  let currentPreset = "default_transcript";
  let activeFormat = "pdf";
  let abortController = null;
  let batchExportAbortController = null;
  let exportPlatformFetchers = null;
  let lastReceipt = null;
  let pageToastTimer = null;
  let lastNotionSuccessDialogJobId = "";
  let activeNotionJobId = "";
  let lastObsidianSuccessDialogId = "";
  let lastBatchSyncResultDialogId = "";
  let obsidianCoordinatorPromise = null;
  let activeObsidianSingleSync = false;
  let subscribePanelRequestAt = 0;
  let runtimeMessageListenerAttached = false;
  let authStorageListenerAttached = false;
  let obsidianResultEscapeListenerAttached = false;
  let contextExportReady = false;
  let pendingContextExportRequest = null;

  // popup state 缓存：先返回上次状态，再异步刷新服务端 entitlement。
  let _popupStateCache = null;

  function invalidatePopupStateCache() {
    _popupStateCache = null;
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
    if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.getLanguage === "function") {
      return globalThis.CHATVAULT_I18N.getLanguage() || "en";
    }
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
    // redaction_enabled 与 include_prompt_appendix 当前未在导出引擎中接入
    // 强制关闭以避免用户误以为脱敏已生效
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
    return /^(pdf|word|image|markdown|html|txt|json|select)$/.test(format || "") ? format : "pdf";
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
    listenAuthStorageChanges();
    if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.ready === "function") {
      await globalThis.CHATVAULT_I18N.ready();
    }
    await loadPersistedExportSettings();
    injectShadowDOM();
    contextExportReady = true;
    flushPendingContextExportRequest();

    const preloadPromise = exporter.preload().catch((e) => {
      console.warn("Exporter preload failed:", e);
      return null;
    });

    await loadState({ localOnly: true, skipVerify: true });
    updateUIState();
    globalThis.addEventListener("chatvault:language-changed", () => {
      if (abortController || batchExportAbortController || batchModalOpen || globalThis.CHATVAULT_IS_BATCH_EXPORT) return;
      shadowContainer?.remove();
      shadowContainer = null;
      shadowRoot = null;
      injectShadowDOM();
      updateUIState();
    });
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
  async function loadState(options = {}) {
    const skipVerify = Boolean(options.skipVerify) || !!abortController;
    let authResolved = !auth;
    try {
      if (auth) {
        currentSession = await auth.getSession({ skipUserRefresh: !options.forceRefresh, allowStaleOnError: true });
        authResolved = true;
        if (currentSession?.user) {
          currentUserProfile = await refreshEntitlements(currentSession, options);
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
    } finally {
      usageStateLoaded = true;
    }

    if (!skipVerify && currentSession?.access_token && !isProUser) {
      // Run in background without awaiting, to prevent blocking initialization and state loads
      syncVerifiedExportEntitlement(1, { consume: false }).then((verification) => {
        if (!verification.ok) {
          console.info("Failed to refresh server export usage (non-critical):", verification.error);
        }
      }).catch((error) => {
        console.info("Failed to refresh server export usage (non-critical):", error);
      });
    }

    if (authResolved && !options.localOnly) {
      await cacheEntitlementState();
    }
  }

  function sessionMatchesCachedEntitlement(session, cachedState) {
    if (!session || !cachedState) return false;
    const sessionEmail = session.user?.email || "";
    const sessionUserId = session.user?.id || "";
    if (!sessionEmail && !sessionUserId) return false;
    return (!sessionEmail || cachedState.email === sessionEmail) &&
      (!sessionUserId || cachedState.profile?.id === sessionUserId || !cachedState.profile?.id);
  }

  async function getStoredAuthSessionSnapshot(sessionOverride) {
    if (sessionOverride) {
      return sessionOverride;
    }
    if (!auth) {
      return null;
    }
    if (typeof auth.getStoredSession === "function") {
      const storedSession = await auth.getStoredSession().catch(() => null);
      if (storedSession) return storedSession;
    }
    if (typeof auth.getSession === "function") {
      return auth.getSession({ skipUserRefresh: true, allowStaleOnError: true }).catch(() => null);
    }
    return null;
  }

  async function getCachedProfileForSession(session) {
    if (!entitlements || typeof entitlements.getCachedState !== "function") {
      return null;
    }
    const cached = await entitlements.getCachedState().catch(() => null);
    return sessionMatchesCachedEntitlement(session, cached) ? cached : null;
  }

  async function getPopupStateCacheSnapshot() {
    if (!_popupStateCache) {
      return null;
    }

    const cached = currentSession?.access_token
      ? await getCachedProfileForSession(currentSession)
      : null;
    if (!cached?.profile || !entitlements) {
      return _popupStateCache;
    }

    const profile = cached.profile;
    const usage = cached.usage || _popupStateCache.dailyUsage || dailyUsage;
    return {
      ..._popupStateCache,
      isProUser: entitlements.isPro(profile),
      email: cached.email || currentSession?.user?.email || _popupStateCache.email || "",
      avatarUrl: cached.avatarUrl || currentSession?.user?.user_metadata?.avatar_url || currentSession?.user?.user_metadata?.picture || _popupStateCache.avatarUrl || "",
      remainingQuota: entitlements.getRemainingFreeExports(profile, usage || {}),
      profile,
      dailyUsage: usage
    };
  }

  function buildEntitlementPopupStateSnapshot() {
    const profile = currentUserProfile || (currentSession?.user && entitlements ? entitlements.normalizeProfile({
      id: currentSession.user.id || "",
      email: currentSession.user.email || "",
      plan: "free"
    }) : null);
    const usage = dailyUsage || {};
    const remainingQuota = profile && entitlements
      ? entitlements.getRemainingFreeExports(profile, usage || {})
      : 3;

    return {
      ok: true,
      email: currentSession?.user?.email || profile?.email || "",
      avatarUrl: currentSession?.user?.user_metadata?.avatar_url || currentSession?.user?.user_metadata?.picture || "",
      isProUser: !!(profile && entitlements?.isPro(profile)),
      remainingQuota,
      profile,
      dailyUsage: usage,
      exportSettings
    };
  }

  function notifyPopupEntitlementStateUpdated() {
    try {
      if (!chrome?.runtime?.sendMessage) {
        return;
      }
      chrome.runtime.sendMessage({
        type: "CHATVAULT_ENTITLEMENT_STATE_UPDATED",
        state: buildEntitlementPopupStateSnapshot()
      }, () => {
        // No popup may be open; ignore the expected "receiving end" error.
        void chrome.runtime.lastError;
      });
    } catch (error) {}
  }

  async function getLocalUsageSnapshot() {
    if (!usageStore || typeof usageStore.getDailyUsage !== "function") {
      return null;
    }
    return usageStore.getDailyUsage().catch(() => null);
  }

  async function applyVerifiedServerUsage(usage) {
    if (!usage || typeof usage !== "object") {
      return null;
    }
    if (usageStore && typeof usageStore.setDailyUsage === "function") {
      dailyUsage = await usageStore.setDailyUsage(usage);
    } else if (entitlements && typeof entitlements.normalizeDailyUsage === "function") {
      dailyUsage = entitlements.normalizeDailyUsage(usage);
    } else {
      dailyUsage = usage;
    }
    return dailyUsage;
  }

  async function applyStoredAuthStateImmediately(sessionOverride) {
    const session = await getStoredAuthSessionSnapshot(sessionOverride);
    currentSession = session || null;
    dailyUsage = await getLocalUsageSnapshot() || dailyUsage;
    usageStateLoaded = true;

    if (session?.access_token && entitlements) {
      const cached = await getCachedProfileForSession(session);
      currentUserProfile = cached?.profile || entitlements.normalizeProfile({
        id: session.user?.id || "",
        email: session.user?.email || "",
        plan: "free"
      });
      isProUser = entitlements.isPro(currentUserProfile);
    } else {
      currentUserProfile = null;
      isProUser = false;
    }

    invalidatePopupStateCache();
    updateUIState();
    return Boolean(session?.access_token);
  }

  async function applySignedOutStateImmediately() {
    currentSession = null;
    currentUserProfile = null;
    isProUser = false;
    dailyUsage = await getLocalUsageSnapshot() || dailyUsage;
    usageStateLoaded = true;
    invalidatePopupStateCache();
    updateUIState();
  }

  function refreshAuthStateInBackground() {
    loadState({ forceRefresh: true, skipVerify: true }).then(() => {
      invalidatePopupStateCache();
      updateUIState();
      notifyPopupEntitlementStateUpdated();
    }).catch((error) => {
      console.warn("Background auth state refresh failed:", error);
    });
  }

  function getStorageChange(changes, key) {
    return changes && Object.prototype.hasOwnProperty.call(changes, key) ? changes[key] : null;
  }

  function listenAuthStorageChanges() {
    if (authStorageListenerAttached) {
      return;
    }
    authStorageListenerAttached = true;

    try {
      if (!chrome?.storage?.onChanged || typeof chrome.storage.onChanged.addListener !== "function") {
        return;
      }

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
          return;
        }

        const sessionChange = getStorageChange(changes, SUPABASE_SESSION_STORAGE_KEY);
        const entitlementChange = getStorageChange(changes, ENTITLEMENT_STATE_CACHE_KEY);
        if (!sessionChange && !entitlementChange) {
          return;
        }

        if (sessionChange) {
          if (sessionChange.newValue) {
            applyStoredAuthStateImmediately(sessionChange.newValue).catch((error) => {
              console.warn("Failed to apply updated auth session:", error);
            });
          } else {
            applySignedOutStateImmediately().catch((error) => {
              console.warn("Failed to apply signed-out auth state:", error);
            });
          }
          return;
        }

        applyStoredAuthStateImmediately().catch((error) => {
          console.warn("Failed to apply updated entitlement state:", error);
        });
      });
    } catch (error) {
      console.warn("Auth storage change listener unavailable:", error);
    }
  }

  // 获取 Pro 状态
  async function refreshEntitlements(session, options = {}) {
    if (!session?.access_token) return entitlements.normalizeProfile({ plan: "free" });
    if (!options.forceRefresh) {
      try {
        const cached = typeof entitlements.getCachedState === "function" ? await entitlements.getCachedState() : null;
        const sessionEmail = session.user?.email || "";
        const sessionUserId = session.user?.id || "";
        if (cached && (!sessionEmail || cached.email === sessionEmail) && (!sessionUserId || cached.profile?.id === sessionUserId || !cached.profile?.id)) {
          return cached.profile;
        }
      } catch (error) {
        console.warn("Cached entitlement check failed:", error);
      }
    }
    if (options.localOnly) {
      return entitlements.normalizeProfile({
        id: session.user?.id || "",
        email: session.user?.email || "",
        plan: "free"
      });
    }
    try {
      const result = await globalThis.CHATVAULT_SUPABASE_API.request("/functions/v1/product-sync-subscription-status", {
        accessToken: session.access_token,
        method: "POST"
      });
      const syncedProfile = normalizeProfileResponse(result);
      if (syncedProfile) return syncedProfile;
    } catch (err) {
      if (globalThis.CHATVAULT_DEBUG) {
        console.debug("sync-subscription-status Edge Function failed, trying profiles fallback:", err);
      }
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

  function getLocalExportAccessResult(count) {
    const requested = Math.max(1, Number(count) || 1);
    const profile = currentUserProfile || entitlements.normalizeProfile({ plan: "free" });
    const remaining = entitlements.getRemainingFreeExports(profile, dailyUsage);
    const allowed = isProUser || entitlements.isPro(profile) || remaining >= requested;
    return {
      ok: true,
      allowed,
      serverVerified: false,
      profile,
      usage: dailyUsage,
      remaining
    };
  }

  async function verifySignedInExportAccess(count) {
    if (isProUser || !currentSession?.access_token) {
      return { ok: true, allowed: true, serverVerified: false };
    }
    return syncVerifiedExportEntitlement(count, { consume: false });
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
      const localAccess = getLocalExportAccessResult(count);
      if (!localAccess.allowed || isProUser) {
        return {
          ok: false,
          allowed: false,
          serverVerified: false,
          error: tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。")
        };
      }
      console.warn("Server entitlement verification failed; using local quota fallback:", error);
      return localAccess;
    }

    if (!session?.access_token) {
      return { ok: true, allowed: true, serverVerified: false };
    }

    try {
      const result = await globalThis.CHATVAULT_SUPABASE_API.request("/functions/v1/product-verify-export-entitlement", {
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
      const serverUsage = result?.usage || result?.data?.usage || null;
      if (serverUsage) {
        await applyVerifiedServerUsage(serverUsage);
      }
      await cacheEntitlementState();
      invalidatePopupStateCache();
      notifyPopupEntitlementStateUpdated();
      const serverAllowed = result?.ok !== false && result?.allowed !== false;

      return {
        ok: true,
        allowed: serverAllowed,
        serverVerified: true,
        serverConsumed: consume && serverAllowed,
        profile: currentUserProfile,
        usage: dailyUsage,
        remaining: entitlements.getRemainingFreeExports(currentUserProfile, dailyUsage)
      };
    } catch (error) {
      const localAccess = getLocalExportAccessResult(count);
      if (!localAccess.allowed || isProUser) {
        return {
          ok: false,
          allowed: false,
          serverVerified: false,
          error: tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。")
        };
      }
      console.warn("Server entitlement verification failed; using local quota fallback:", error);
      return localAccess;
    }
  }

  async function recordSuccessfulExportUsage(count, options = {}) {
    const amount = Math.max(1, Number(count) || 1);
    if (isProUser || entitlements?.isPro?.(currentUserProfile)) {
      return { ok: true, serverVerified: false, usage: dailyUsage };
    }

    if (options.serverConsumed) {
      await cacheEntitlementState();
      invalidatePopupStateCache();
      return { ok: true, serverVerified: true, usage: dailyUsage };
    }

    if (usageStore && typeof usageStore.incrementDailyUsage === "function") {
      dailyUsage = await usageStore.incrementDailyUsage(amount);
      await cacheEntitlementState();
    }
    invalidatePopupStateCache();
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

  function getEntitlementIssue(settings, presetId, profile, format) {
    const pro = isProUser; // 支持开发者测试状态覆盖
    const preset = templatePresets.getPreset(presetId);

    if (preset?.minPlan === "pro" && !pro) {
      return "This professional template requires Pro.";
    }
    // Theme styling only applies to PDF and Image formats
    const appliesTheme = !format || format === "pdf" || format === "image";
    if (appliesTheme && !entitlements.canUseExportStyle(profile, settings?.export_style) && !pro) {
      return "Premium report themes require Pro.";
    }
    if (settings?.include_prompt_appendix && !pro) {
      return "Prompt Appendix requires Pro.";
    }
    if (settings?.show_chatvault_badge === false && !pro) {
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
  let batchMode = "files";
  let batchSelectedFormat = "pdf";
  let batchSelectedTheme = "default";
  const NOTION_UI_CACHE_KEY = "chatvault_notion_ui_cache_v1";
  let batchNotionConfig = {
    connections: [],
    dataSources: [],
    connectionId: "",
    dataSourceId: "",
    databaseId: ""
  };
  let batchNotionJobs = new Map();
  let batchNotionResults = new Map();
  let batchNotionBatchId = "";
  let batchObsidianResults = new Map();
  let batchObsidianBatchId = "";
  let batchObsidianStatus = { connected: false, permission: "missing", activeJob: null };
  let displayedConversationsCount = 0;
  const batchPageSize = 20;
  const historyPageSize = 20;
  const batchHistoryPrefetchPages = 3;
  let hasMoreConversations = true;
  let batchActiveItems = [];
  let batchChatGptSessionRequestPromise = null;
  let batchChatGptNextOffset = 0;
  let batchChatGptWebTotal = null;
  let batchChatGptLoadedAll = false;
  let batchHistoryLoadingActive = false;
  const exportFormats = ["pdf", "word", "image", "markdown", "html", "txt", "json"];
  const EXPORT_PROGRESS_INITIAL = 0.04;
  const EXPORT_PROGRESS_ESTIMATE_CAP = 0.9;
  const EXPORT_PROGRESS_TICK_MS = 1600;
  const EXPORT_PROGRESS_MIN_STEP = 0.01;
  const EXPORT_PROGRESS_MAX_STEP = 0.035;
  let exportProgressState = null;

  function loadObsidianCoordinator() {
    if (!obsidianCoordinatorPromise) {
      obsidianCoordinatorPromise = import(chrome.runtime.getURL("src/modules/obsidian/coordinator.js"));
    }
    return obsidianCoordinatorPromise;
  }

  function getExportFormatLabel(format) {
    const labels = {
      pdf: "PDF",
      word: "DOCX",
      image: "Image",
      markdown: "Markdown",
      html: "HTML",
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
      html: 8000,
      txt: 5000,
      json: 5000,
      word: 11000,
      pdf: 14000,
      image: 18000
    };
    const messageCostByFormat = {
      markdown: 160,
      html: 190,
      txt: 90,
      json: 90,
      word: 260,
      pdf: 360,
      image: 520
    };
    const imageCostByFormat = {
      markdown: 120,
      html: 700,
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
      .cv-selection-bar:not(.active),
      .cv-batch-modal-overlay:not(.active),
      .cv-notion-auth-overlay:not(.active),
      .cv-notion-success-overlay:not(.active),
      .cv-obsidian-result-overlay:not(.active),
      .cv-batch-result-overlay:not(.active),
      .cv-page-toast:not(.active) {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
      .export-progress-overlay.active,
      .cv-selection-bar.active,
      .cv-batch-modal-overlay.active,
      .cv-notion-auth-overlay.active,
      .cv-notion-success-overlay.active,
      .cv-batch-result-overlay.active,
      .cv-obsidian-result-overlay.active,
      .cv-page-toast.active {
        visibility: visible !important;
      }
    `;
    shadowRoot.appendChild(criticalStyle);

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("src/content.css");
    shadowRoot.appendChild(link);
    const obsidianLink = document.createElement("link");
    obsidianLink.rel = "stylesheet";
    obsidianLink.href = chrome.runtime.getURL("src/obsidian-content.css");
    shadowRoot.appendChild(obsidianLink);

    // 渲染 UI 骨架 (进度遮罩、浮动选择栏、批量导出弹窗和 toast)
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
            <option value="html">HTML</option>
            <option value="image">${t("format_image", isChineseUi() ? "图片" : "Image")}</option>
            <option value="txt">${tx("content_format_text", "Text", "文本")}</option>
            <option value="json">JSON</option>
          </select>
          <button class="cv-selection-btn primary" id="btn-export-selection">${t("btn_export", isChineseUi() ? "导出" : "Export")}</button>
          <button class="cv-selection-btn" id="btn-exit-selection">${tx("content_btn_exit", "Exit", "退出")}</button>
        </div>
      </div>

      <!-- 批量导出页内弹窗 -->
      <div class="cv-batch-modal-overlay" id="cv-batch-modal-overlay">
        <div class="cv-batch-modal" role="dialog" aria-modal="true" aria-labelledby="cv-batch-title-text">
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

          <div class="cv-batch-mode-tabs" role="tablist" aria-label="${tx("content_batch_action_type", "Batch action type", "批量操作类型")}">
            <button type="button" class="cv-batch-mode-tab active" id="cv-batch-mode-files" data-mode="files" role="tab" aria-selected="true">${tx("content_batch_export_files", "Export files", "导出文件")}</button>
            <button type="button" class="cv-batch-mode-tab" id="cv-batch-mode-notion" data-mode="notion" role="tab" aria-selected="false">${tx("content_batch_sync_notion", "Sync to Notion", "同步到 Notion")}</button>
            <button type="button" class="cv-batch-mode-tab cv-batch-mode-tab-obsidian" id="cv-batch-mode-obsidian" data-mode="obsidian" role="tab" aria-selected="false">${tx("obsidian_batch_sync", "Sync to Obsidian", "同步到 Obsidian")}</button>
          </div>

          <div class="cv-batch-obsidian-destination" id="cv-batch-obsidian-destination" hidden>
            <div class="cv-batch-destination-info">
              <span class="cv-batch-folder-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path>
                </svg>
              </span>
              <div class="cv-batch-path-wrap">
                <strong id="cv-batch-obsidian-vault">${tx("obsidian_not_connected", "Vault not connected", "Vault 尚未连接")}</strong>
              </div>
            </div>
            <button type="button" id="cv-batch-obsidian-configure">${tx("obsidian_configure", "Config Obsidian", "配置 Obsidian")}</button>
          </div>

          <div class="cv-batch-notion-destination" id="cv-batch-notion-destination" hidden>
            <label id="cv-batch-notion-label" for="cv-batch-notion-select">${tx("content_notion_database", "Notion Database", "Notion Database")}</label>
            <select id="cv-batch-notion-select">
              <option value="">${tx("content_notion_destination_unavailable", "Connect Notion from the extension popup", "请先在插件弹窗中连接 Notion")}</option>
            </select>
            <button type="button" class="cv-batch-notion-connect" id="cv-batch-notion-connect" hidden>${isChineseUi() ? "连接 Notion" : "Connect Notion"}</button>
            <p id="cv-batch-notion-helper"></p>
          </div>

          <!-- 搜索过滤输入框 -->
          <div class="cv-batch-search-container">
            <input type="text" class="cv-batch-search-box" id="cv-batch-search" placeholder="${tx("placeholder_batch_search", "Search by conversation title...", "搜索会话标题...")}">
          </div>

          <!-- 同步进度条 -->
          <div class="cv-batch-loading-bar" id="cv-batch-loading-indicator" style="display: none;">
            <div class="cv-batch-dot-spinner"></div>
            <span>${tx("content_syncing_sidebar", "Syncing sidebar history and loading more chats...", "正在同步侧边栏历史，加载更多聊天...")}</span>
          </div>

          <!-- 折叠设置段 -->
          <div class="cv-batch-settings-toggle">
            <div class="cv-batch-settings-header" id="cv-batch-settings-expand-btn">
              <span>⚙️ ${tx("content_export_options", "Export format and detailed settings", "导出格式与详细设置")}</span>
              <span id="cv-batch-settings-chevron">▼</span>
            </div>
            <div class="cv-batch-settings-body" id="cv-batch-settings-panel">
              <div class="cv-batch-option-group">
                <div class="cv-batch-group-title-wrapper">
                  <span class="cv-batch-group-title">${t("export_theme_label", isChineseUi() ? "导出主题与样式" : "Export Theme & Styling")}</span>
                  <button type="button" class="cv-batch-help-tooltip" aria-label="${escapeHtml(tx("export_theme_tooltip", "Themes apply only to PDF and Image exports. Other formats are not affected.", "主题仅适用于 PDF 和图片 (Image) 导出，其他格式不受影响。"))}" aria-describedby="cv-batch-theme-tooltip-text">
                    <span class="cv-batch-help-icon">?</span>
                    <span class="cv-batch-tooltip-text" id="cv-batch-theme-tooltip-text">${tx("export_theme_tooltip", "Themes apply only to PDF and Image exports. Other formats are not affected.", "主题仅适用于 PDF 和图片 (Image) 导出，其他格式不受影响。")}</span>
                  </button>
                </div>
                <div class="cv-batch-theme-grid">
                  <div class="cv-batch-theme-option active" data-theme="default">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--default"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_default", isChineseUi() ? "极简纯白" : "Minimalist")}</span>
                  </div>
                  <div class="cv-batch-theme-option" data-theme="natural">
                    <span class="cv-batch-theme-circle cv-batch-theme-circle--natural"></span>
                    <span class="cv-batch-theme-name">${t("export_theme_natural", isChineseUi() ? "自然原生" : "Natural")}</span>
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
                <button type="button" class="cv-batch-format-btn" data-format="html">HTML</button>
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

      <div class="cv-notion-auth-overlay" id="cv-notion-auth-overlay" aria-hidden="true" hidden>
        <div class="cv-notion-auth-card" role="dialog" aria-modal="true" aria-labelledby="cv-notion-auth-title">
          <div class="cv-notion-auth-mark" aria-hidden="true">
            <img src="${chrome.runtime.getURL("images/notion-app-icon.svg")}" alt="">
          </div>
          <h2 id="cv-notion-auth-title">${t("onboard_title_login", isChineseUi() ? "登录以继续" : "Sign in to continue")}</h2>
          <p>${t("notion_signin_required", isChineseUi() ? "请先登录。登录成功后，请再次点击“连接 Notion”完成工作区授权。" : "Sign in first. After sign-in, click Connect Notion again to authorize your workspace.")}</p>
          <div class="cv-notion-auth-actions">
            <button type="button" class="cv-notion-auth-cancel" id="cv-notion-auth-cancel">${t("btn_cancel", isChineseUi() ? "取消" : "Cancel")}</button>
            <button type="button" class="cv-notion-auth-confirm" id="cv-notion-auth-confirm">${t("popup_btn_login", isChineseUi() ? "登录" : "Sign In")}</button>
          </div>
        </div>
      </div>

      <div class="cv-notion-success-overlay" id="cv-notion-success-overlay" aria-hidden="true">
        <div class="cv-notion-success-card" role="dialog" aria-modal="true" aria-labelledby="cv-notion-success-title">
          <button class="cv-notion-success-close" id="cv-notion-success-close" type="button" aria-label="${getBatchCloseLabel()}">×</button>
          <div class="cv-notion-success-confetti" aria-hidden="true">
            <span>✦</span><span>●</span><strong>🎉</strong><span>●</span><span>✦</span>
          </div>
          <h2 id="cv-notion-success-title">${tx("notion_sync_success_title", "Synced to Notion", "已成功同步到 Notion")}</h2>
          <p id="cv-notion-success-desc">${tx("notion_sync_success_desc", "This conversation is ready in your Notion Database.", "当前对话已写入你选择的 Notion Database。")}</p>
          <a class="cv-notion-success-open" id="cv-notion-success-open" target="_blank" rel="noopener noreferrer">
            <span class="cv-notion-success-open-label">${tx("notion_open_page", "Open Notion page", "打开 Notion 页面")}</span>
            <strong id="cv-notion-success-document-title">${tx("notion_untitled_conversation", "Untitled conversation", "未命名会话")}</strong>
            <span class="cv-notion-success-open-arrow" aria-hidden="true">→</span>
          </a>
          <div class="cv-notion-success-actions">
            <button class="cv-notion-success-done" id="cv-notion-success-done" type="button">${tx("content_btn_done", "Done", "完成")}</button>
          </div>
        </div>
      </div>

      <div class="cv-obsidian-result-overlay" id="cv-obsidian-result-overlay" aria-hidden="true">
        <div class="cv-obsidian-result-card" role="dialog" aria-modal="true" aria-labelledby="cv-obsidian-result-title">
          <button class="cv-obsidian-result-close" id="cv-obsidian-result-close" type="button" aria-label="${getBatchCloseLabel()}">×</button>
          <div class="cv-obsidian-result-mark" id="cv-obsidian-result-mark" aria-hidden="true">✓</div>
          <h2 id="cv-obsidian-result-title">${tx("obsidian_sync_complete", "Synced to Obsidian", "已成功同步到 Obsidian")}</h2>
          <p id="cv-obsidian-result-description">${tx("obsidian_sync_complete_desc", "This conversation is ready in your Obsidian Vault.", "当前对话已写入你选择的 Obsidian Vault。")}</p>
          <button class="cv-obsidian-result-open" id="cv-obsidian-result-open" type="button">
            <span class="cv-obsidian-result-open-label">${tx("obsidian_open_note", "Open in Obsidian", "在 Obsidian 中打开")}</span>
            <strong id="cv-obsidian-result-document-title">${tx("notion_untitled_conversation", "Untitled conversation", "未命名会话")}</strong>
            <span class="cv-obsidian-result-open-arrow" aria-hidden="true">→</span>
          </button>
          <div class="cv-obsidian-result-actions">
            <button class="cv-obsidian-result-secondary" id="cv-obsidian-result-done" type="button">${tx("content_btn_done", "Done", "完成")}</button>
          </div>
        </div>
      </div>

      <div class="cv-batch-result-overlay" id="cv-batch-result-overlay" aria-hidden="true">
        <div class="cv-batch-result-card" role="dialog" aria-modal="true" aria-labelledby="cv-batch-result-title">
          <button class="cv-batch-result-close" id="cv-batch-result-close" type="button" aria-label="${getBatchCloseLabel()}">×</button>
          <div class="cv-batch-result-mark" id="cv-batch-result-mark" aria-hidden="true">✓</div>
          <h2 id="cv-batch-result-title">${t("batch_export_success", isChineseUi() ? "批量同步完成" : "Batch sync complete")}</h2>
          <p id="cv-batch-result-description"></p>
          <div class="cv-batch-result-items" id="cv-batch-result-items"></div>
          <div class="cv-batch-result-actions">
            <button type="button" id="cv-batch-result-done">${tx("content_btn_done", "Done", "完成")}</button>
          </div>
        </div>
      </div>

      <div class="cv-page-toast" id="cv-page-toast" role="status" aria-live="polite"></div>
    `;

    shadowRoot.appendChild(uiWrapper);

    const notionSuccessOverlay = shadowRoot.getElementById("cv-notion-success-overlay");
    const closeNotionSuccess = () => hideNotionSuccessDialog();
    shadowRoot.getElementById("cv-notion-success-close").addEventListener("click", closeNotionSuccess);
    shadowRoot.getElementById("cv-notion-success-done").addEventListener("click", closeNotionSuccess);
    notionSuccessOverlay.addEventListener("click", (event) => {
      if (event.target === notionSuccessOverlay) closeNotionSuccess();
    });
    shadowRoot.getElementById("cv-notion-success-open").addEventListener("click", (event) => {
      event.preventDefault();
      const url = normalizeNotionPageUrl(event.currentTarget.getAttribute("href"));
      if (!url) {
        showPageToast(tx("notion_open_page_failed", "Could not open the Notion page.", "无法打开 Notion 页面。"));
        return;
      }
      hideNotionSuccessDialog();
      chrome.runtime.sendMessage({ type: "CHATVAULT_NOTION_OPEN_PAGE", url }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          showPageToast(response?.error || tx("notion_open_page_failed", "Could not open the Notion page.", "无法打开 Notion 页面。"));
        }
      });
    });

    const obsidianResultOverlay = shadowRoot.getElementById("cv-obsidian-result-overlay");
    const closeObsidianResult = () => hideObsidianResultDialog();
    shadowRoot.getElementById("cv-obsidian-result-close").addEventListener("click", closeObsidianResult);
    shadowRoot.getElementById("cv-obsidian-result-done").addEventListener("click", closeObsidianResult);
    obsidianResultOverlay.addEventListener("click", (event) => {
      if (event.target === obsidianResultOverlay) closeObsidianResult();
    });
    shadowRoot.getElementById("cv-obsidian-result-open").addEventListener("click", () => {
      const button = shadowRoot.getElementById("cv-obsidian-result-open");
      const vaultName = button?.dataset.vaultName || "";
      const noteRelativePath = button?.dataset.notePath || "";
      if (!vaultName || !noteRelativePath) return;
      hideObsidianResultDialog();
      chrome.runtime.sendMessage({ type: "CHATVAULT_OBSIDIAN_OPEN_NOTE", vaultName, noteRelativePath }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          showPageToast(response?.error || tx("obsidian_open_failed", "Could not open Obsidian.", "无法打开 Obsidian。"));
        }
      });
      hideObsidianResultDialog();
    });
    if (!obsidianResultEscapeListenerAttached) {
      // 安全修复 P1: 使用 shadowRoot 监听 keydown，避免污染宿主页面的全局事件
      // Previously used document.addEventListener which leaked into the host page event loop.
      shadowRoot.addEventListener("keydown", (event) => {
        const currentOverlay = shadowRoot.getElementById("cv-obsidian-result-overlay");
        if (event.key === "Escape" && currentOverlay?.classList.contains("active")) hideObsidianResultDialog();
      });
      obsidianResultEscapeListenerAttached = true;
    }

    const batchResultOverlay = shadowRoot.getElementById("cv-batch-result-overlay");
    const closeBatchResult = () => hideBatchSyncResultDialog();
    shadowRoot.getElementById("cv-batch-result-close").addEventListener("click", closeBatchResult);
    shadowRoot.getElementById("cv-batch-result-done").addEventListener("click", closeBatchResult);
    batchResultOverlay.addEventListener("click", (event) => {
      if (event.target === batchResultOverlay) closeBatchResult();
    });
    shadowRoot.getElementById("cv-batch-result-items").addEventListener("click", (event) => {
      const button = event.target.closest(".cv-batch-result-item");
      if (!button) return;
      if (button.dataset.service === "notion") {
        const url = normalizeNotionPageUrl(button.dataset.url);
        if (!url) return;
        chrome.runtime.sendMessage({ type: "CHATVAULT_NOTION_OPEN_PAGE", url }, (response) => {
          if (chrome.runtime.lastError || !response?.ok) showPageToast(response?.error || tx("notion_open_page_failed", "Could not open the Notion page.", "无法打开 Notion 页面。"));
        });
        return;
      }
      const vaultName = button.dataset.vaultName || "";
      const noteRelativePath = button.dataset.notePath || "";
      if (!vaultName || !noteRelativePath) return;
      chrome.runtime.sendMessage({ type: "CHATVAULT_OBSIDIAN_OPEN_NOTE", vaultName, noteRelativePath }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) showPageToast(response?.error || tx("obsidian_open_failed", "Could not open Obsidian.", "无法打开 Obsidian。"));
      });
    });

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

    shadowRoot.querySelectorAll(".cv-batch-mode-tab").forEach((button) => {
      button.addEventListener("click", () => {
        if (globalThis.CHATVAULT_IS_BATCH_EXPORT) return;
        setBatchMode(button.getAttribute("data-mode") || "files");
      });
    });

    const batchNotionSelect = shadowRoot.getElementById("cv-batch-notion-select");
    batchNotionSelect?.addEventListener("change", () => {
      const selected = batchNotionConfig.dataSources.find((item) => {
        return `${item.connectionId}:${item.id}` === batchNotionSelect.value;
      });
      if (!selected) return;
      batchNotionConfig.connectionId = selected.connectionId;
      batchNotionConfig.dataSourceId = selected.id;
      batchNotionConfig.databaseId = selected.databaseId || "";
      persistBatchNotionSelection();
      updateBatchSelectedCount();
    });

    shadowRoot.getElementById("cv-batch-notion-connect")?.addEventListener("click", connectBatchNotionWorkspace);

    shadowRoot.getElementById("cv-batch-obsidian-configure")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "CHATVAULT_OBSIDIAN_OPEN_SETTINGS" }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          showPageToast(response?.error || tx("obsidian_settings_failed", "Could not open Obsidian settings.", "无法打开 Obsidian 设置。"));
        }
      });
    });

    // 选择导出主题
    shadowRoot.querySelectorAll(".cv-batch-theme-option").forEach(btn => {
      btn.addEventListener("click", () => {
        const theme = btn.getAttribute("data-theme");
        if (!isProUser && theme !== "default" && theme !== "natural") {
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

    // 绑定搜索输入框事件
    const searchInput = shadowRoot.getElementById("cv-batch-search");
    if (searchInput) {
      searchInput.addEventListener("input", filterBatchList);
    }

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
          row.setAttribute("aria-checked", "false");
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

    // Warm the local Notion destination cache while the picker is hidden so
    // opening the batch modal paints the user's last Database immediately.
    getBatchNotionStoredState().then((stored) => {
      if (hydrateBatchNotionCache(stored)) renderBatchNotionDestination();
    }).catch(() => {});

    // 绑定全局登录监听 Hook (防崩溃，因 popup 会更新状态)
    globalThis.CHATVAULT_SET_AUTH_LOADING = (isLoading, message) => {};
    globalThis.CHATVAULT_REFRESH_AUTH_STATE = async () => {
      await applyStoredAuthStateImmediately();
      refreshAuthStateInBackground();
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

  function collapseRepeatedBatchTitle(value) {
    const title = String(value || "").replace(/\s+/g, " ").trim();
    if (!title || title.length % 2 !== 0) return title;
    const midpoint = title.length / 2;
    const first = title.slice(0, midpoint).trim();
    const second = title.slice(midpoint).trim();
    return first && first === second ? first : title;
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
            let title = collapseRepeatedBatchTitle(lines[0] || "Untitled Chat");
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
              let title = collapseRepeatedBatchTitle(lines[0] || "Untitled Chat");
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
            let title = collapseRepeatedBatchTitle(lines[0] || "Untitled Chat");
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
        if (!session || typeof session !== "object") {
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

  async function fetchChatGptConversationPage(session, offset, limit, retries = 3) {
    const headers = {};
    if (session && session.accessToken) {
      headers.Authorization = "Bearer " + session.accessToken;
    }
    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const listResponse = await fetch(
          window.location.origin + "/backend-api/conversations?offset=" + encodeURIComponent(offset) +
            "&limit=" + encodeURIComponent(limit) + "&order=updated",
          {
            credentials: "include",
            headers
          }
        );
        if (!listResponse.ok) {
          const status = listResponse.status;
          // For auth or permanent errors, don't retry
          if (status === 401 || status === 403) {
            throw new Error("ChatGPT history request failed: " + status);
          }
          // For rate limiting, wait longer
          const delay = status === 429 ? 5000 : 1200;
          lastError = new Error("ChatGPT history request failed: " + status);
          if (attempt < retries - 1) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          continue;
        }
        return await listResponse.json();
      } catch (err) {
        // Only retry transient network errors (TypeError: Failed to fetch)
        lastError = err;
        const isNetworkError = err instanceof TypeError;
        if (!isNetworkError || attempt >= retries - 1) {
          if (!isNetworkError) throw err; // non-network errors propagate immediately
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 600 * Math.pow(2, attempt)));
      }
    }
    throw lastError;
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
    const session = await getChatGptWebSession();

    while (batchList.length < target && !batchChatGptLoadedAll) {
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
      loadedAll: batchChatGptLoadedAll,
      session
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

  function appendBatchListItems(list, startIndex, selectedIds = new Set()) {
    const itemsContainer = shadowRoot.getElementById("cv-batch-list-items");
    if (!itemsContainer) return;

    if (displayedConversationsCount === 0 && list.length === 0) {
      itemsContainer.innerHTML = '<div style="text-align:center; color:#94a3b8; font-size:12px; padding:40px 0;">💬 ' +
        escapeHtml(t("batch_export_no_chats", isChineseUi() ? "未在侧边栏找到任何会话。" : "No conversations found in the sidebar. Please expand the sidebar or refresh the page.")) +
        '</div>';
      return;
    }

    const platform = exporter.detectPlatform();
    const query = shadowRoot.getElementById("cv-batch-search")?.value.toLowerCase().trim() || "";
    const listHtml = list.map(function (item, index) {
      const realIndex = startIndex + index;
      const safeTitle = escapeHtml(item.title);
      const safeId = escapeHtml(item.id);
      const isSelected = selectedIds.has(item.id);
      const isVisible = !query || safeTitle.toLowerCase().indexOf(query) !== -1;
      return `
        <div class="cv-batch-item-row${isSelected ? " selected" : ""}" data-index="${realIndex}" data-chat-id="${safeId}" id="cv-batch-row-${realIndex}" role="checkbox" aria-checked="${isSelected}" tabindex="0" style="display: ${isVisible ? "flex" : "none"};">
          <div class="cv-batch-checkbox-wrap">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div class="cv-batch-item-info">
            <span class="cv-batch-item-title" title="${safeTitle}">${safeTitle}</span>
            <span class="cv-batch-item-subtitle">${platform} · ${tx("content_conversation_history", "Conversation history", "会话历史")}</span>
            
          </div>
          
          <!-- 状态徽章，默认隐藏 -->
          <div class="cv-batch-item-row-status">
            <button type="button" class="cv-batch-row-open" id="cv-batch-open-${realIndex}" hidden>${tx("content_open", "Open", "打开")}</button>
            <span class="cv-batch-badge waiting" id="cv-batch-badge-${realIndex}">Waiting</span>
          </div>
        </div>
      `;
    }).join("");

    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = listHtml;
    while (tempDiv.firstElementChild) {
      const rowEl = tempDiv.firstElementChild;
      fragment.appendChild(rowEl);

      const toggleRowSelection = () => {
        if (globalThis.CHATVAULT_IS_BATCH_EXPORT || rowEl.classList.contains("disabled")) return;
        rowEl.classList.toggle("selected");
        rowEl.setAttribute("aria-checked", String(rowEl.classList.contains("selected")));
        updateBatchSelectedCount();
      };
      rowEl.addEventListener("click", toggleRowSelection);
      rowEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleRowSelection();
      });
      rowEl.querySelector(".cv-batch-row-open")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const button = event.currentTarget;
        if (button.dataset.service === "obsidian") {
          const vaultName = button.dataset.vaultName || "";
          const noteRelativePath = button.dataset.notePath || "";
          if (!vaultName || !noteRelativePath) return;
          chrome.runtime.sendMessage({ type: "CHATVAULT_OBSIDIAN_OPEN_NOTE", vaultName, noteRelativePath }, () => void chrome.runtime.lastError);
          return;
        }
        const url = normalizeNotionPageUrl(button.dataset.url || "");
        if (url) chrome.runtime.sendMessage({ type: "CHATVAULT_NOTION_OPEN_PAGE", url }, () => void chrome.runtime.lastError);
      });
    }
    itemsContainer.appendChild(fragment);

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
      let historyState;
      try {
        if (loader) {
          loader.querySelector("span").textContent = displayedConversationsCount === 0
            ? tx("content_syncing_chatgpt_history", "Syncing conversations from ChatGPT history...", "正在从 ChatGPT 历史同步会话...")
            : tx("content_continuing_chatgpt_history", "Continuing to sync ChatGPT history...", "正在继续同步 ChatGPT 历史...");
        }
        historyState = await ensureChatGptBatchHistoryLoaded(targetCount);
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

      await writeBatchChatHistoryCache(platform, batchList, {
        total: batchChatGptWebTotal,
        loadedAll: batchChatGptLoadedAll,
        nextOffset: batchChatGptNextOffset
      });

      // 自动拉取后续所有页面
      if (!batchChatGptLoadedAll) {
        (async () => {
          try {
            await loadRemainingChatGptHistory(historyState.session);
          } catch (err) {
            console.warn(err);
          }
        })();
      }
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

    await writeBatchChatHistoryCache(platform, batchList, {
      total: batchList.length,
      loadedAll: !hasMoreConversations
    });
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

    const platform = exporter.detectPlatform();
    if (platform === "chatgpt" && batchHistoryLoadingActive) {
      loadMoreContainer.style.display = "flex";
      loadMoreContainer.innerHTML = `<span class="cv-batch-all-loaded">${tx("content_background_loading", "Loading more conversations in background...", "正在后台加载更多会话...")}</span>`;
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

  function getBatchCacheKey(platform) {
    const userId = currentSession?.user?.id || "guest";
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, "_");
    return `chatvault_exporter_chats:${safeUserId}:${platform}`;
  }

  async function readBatchChatHistoryCache(platform) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve(null);
        return;
      }
      const key = getBatchCacheKey(platform);
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(result && result[key] ? result[key] : null);
        }
      });
    });
  }

  async function writeBatchChatHistoryCache(platform, list, patch = {}) {
    if (!chrome?.storage?.local) return;
    const key = getBatchCacheKey(platform);
    const data = {
      cachedAt: Date.now(),
      total: typeof patch.total === "number" ? patch.total : list.length,
      loadedAll: Boolean(patch.loadedAll),
      nextOffset: patch.nextOffset || 0,
      chats: list
    };
    chrome.storage.local.set({ [key]: data }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Failed to write batch cache:", chrome.runtime.lastError.message);
      }
    });
  }

  async function performBackgroundSync(platform) {
    const loader = shadowRoot.getElementById("cv-batch-loading-indicator");
    if (platform === "chatgpt") {
      try {
        const session = await getChatGptWebSession();
        const payload = await fetchChatGptConversationPage(session, 0, historyPageSize);
        const rawItems = getConversationItems(payload);
        if (typeof payload.total === "number") {
          batchChatGptWebTotal = payload.total;
        }
        const normalizedItems = rawItems.map(normalizeChatGptHistoryItem).filter(Boolean);

        const existingById = new Map(batchList.map(item => [item.id, item]));
        const merged = [];
        normalizedItems.forEach(item => {
          existingById.delete(item.id);
          merged.push(item);
        });
        existingById.forEach(item => {
          merged.push(item);
        });
        batchList = merged;

        // A cache may contain removed or reordered chats, so its item count is
        // not a valid API cursor. Continue from the server's first-page boundary.
        batchChatGptNextOffset = rawItems.length;
        batchChatGptLoadedAll = !rawItems.length ||
          rawItems.length < historyPageSize ||
          payload?.has_more === false ||
          (typeof batchChatGptWebTotal === "number" && batchChatGptNextOffset >= batchChatGptWebTotal);

        await writeBatchChatHistoryCache(platform, batchList, {
          total: batchChatGptWebTotal,
          loadedAll: batchChatGptLoadedAll,
          nextOffset: batchChatGptNextOffset
        });

        rebuildBatchListUI();

        // 自动触发拉取后续历史
        if (!batchChatGptLoadedAll) {
          loadRemainingChatGptHistory(session).catch(e => console.warn(e));
        } else {
          renderRemainingBatchListItems();
          hasMoreConversations = false;
          updateLoadMoreUi();
        }
      } catch (error) {
        console.warn("Background ChatGPT history sync failed:", error);
      } finally {
        if (loader) loader.style.display = "none";
      }
      return;
    }

    try {
      const mergedItems = await getVisibleBatchConversations(platform, 800);
      const existingById = new Map(batchList.map(item => [item.id, item]));
      const merged = [];
      mergedItems.forEach(item => {
        existingById.delete(item.id);
        merged.push(item);
      });
      existingById.forEach(item => {
        merged.push(item);
      });
      batchList = merged;

      await writeBatchChatHistoryCache(platform, batchList, {
        total: batchList.length,
        loadedAll: false
      });

      rebuildBatchListUI();
    } catch (error) {
      console.warn("Background sidebar sync failed:", error);
    } finally {
      if (loader) loader.style.display = "none";
    }
  }

  function notionBatchMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) return reject(new Error(lastError.message));
        if (!response || response.ok === false) return reject(new Error(response?.error || "Notion request failed."));
        resolve(response);
      });
    });
  }

  function getBatchNotionStoredState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([
        NOTION_UI_CACHE_KEY,
        "chatvault_supabase_session",
        "notion_selected_connection_id",
        "notion_selected_data_sources"
      ], resolve);
    });
  }

  function normalizeBatchNotionDataSource(item, connection) {
    return {
      id: String(item?.id || ""),
      databaseId: String(item?.databaseId || ""),
      title: String(item?.title || tx("content_untitled_database", "Untitled Database", "未命名 Database")),
      connectionId: String(item?.connectionId || connection?.id || ""),
      workspaceName: String(item?.workspaceName || connection?.workspace_name || "")
    };
  }

  function hydrateBatchNotionCache(stored) {
    const cache = stored?.[NOTION_UI_CACHE_KEY];
    const sessionUserId = String(stored?.chatvault_supabase_session?.user?.id || "");
    if (!cache || cache.version !== 1 || String(cache.userId || "") !== sessionUserId) return false;
    const connections = (Array.isArray(cache.connections) ? cache.connections : [])
      .filter((item) => item?.mode === "oauth" && item?.id);
    const dataSources = (Array.isArray(cache.dataSources) ? cache.dataSources : [])
      .map((item) => normalizeBatchNotionDataSource(item))
      .filter((item) => item.id && item.connectionId);
    batchNotionConfig = {
      connections,
      dataSources,
      connectionId: String(cache.connectionId || stored.notion_selected_connection_id || ""),
      dataSourceId: String(cache.dataSourceId || stored.notion_selected_data_sources?.[cache.connectionId] || ""),
      databaseId: String(cache.databaseId || "")
    };
    return Boolean(connections.length);
  }

  function renderBatchNotionDestination() {
    const select = shadowRoot?.getElementById("cv-batch-notion-select");
    const label = shadowRoot?.getElementById("cv-batch-notion-label");
    const connectButton = shadowRoot?.getElementById("cv-batch-notion-connect");
    const helper = shadowRoot?.getElementById("cv-batch-notion-helper");
    if (!select) return;
    select.innerHTML = "";
    const dataSources = batchNotionConfig.dataSources || [];
    if (!dataSources.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = batchNotionConfig.connections.length
        ? tx("content_notion_no_database", "No authorized Database found", "未找到已授权的 Database")
        : tx("content_notion_destination_unavailable", "Connect Notion from the extension popup", "请先在插件弹窗中连接 Notion");
      select.appendChild(option);
      select.disabled = true;
      select.hidden = !batchNotionConfig.connections.length;
      if (label) label.hidden = !batchNotionConfig.connections.length;
      if (connectButton) connectButton.hidden = Boolean(batchNotionConfig.connections.length);
      if (helper) {
        helper.textContent = batchNotionConfig.connections.length
          ? tx("content_notion_share_database", "Share a Database with the Notion connection, then reopen this panel.", "请先向 Notion 连接授权一个 Database，然后重新打开此面板。")
          : currentSession?.access_token
            ? tx("content_notion_connect_helper", "Connect your Notion workspace to choose a Database.", "连接 Notion 工作区后即可选择 Database。")
            : t("notion_signin_required", isChineseUi() ? "请先登录。登录成功后，请再次点击“连接 Notion”完成工作区授权。" : "Sign in first. After sign-in, click Connect Notion again to authorize your workspace.")
      }
      updateBatchSelectedCount();
      return;
    }

    select.hidden = false;
    if (label) label.hidden = false;
    if (connectButton) connectButton.hidden = true;
    const byConnection = new Map();
    dataSources.forEach((item) => {
      if (!byConnection.has(item.connectionId)) byConnection.set(item.connectionId, []);
      byConnection.get(item.connectionId).push(item);
    });
    byConnection.forEach((items, connectionId) => {
      const connection = batchNotionConfig.connections.find((item) => item.id === connectionId);
      const parent = byConnection.size > 1 ? document.createElement("optgroup") : select;
      if (parent !== select) parent.label = connection?.workspace_name || items[0]?.workspaceName || "Notion";
      items.forEach((item) => {
        const option = document.createElement("option");
        option.value = `${item.connectionId}:${item.id}`;
        option.textContent = item.title;
        option.selected = item.connectionId === batchNotionConfig.connectionId && item.id === batchNotionConfig.dataSourceId;
        parent.appendChild(option);
      });
      if (parent !== select) select.appendChild(parent);
    });
    if (!select.value) select.value = `${dataSources[0].connectionId}:${dataSources[0].id}`;
    const selected = dataSources.find((item) => `${item.connectionId}:${item.id}` === select.value) || dataSources[0];
    batchNotionConfig.connectionId = selected.connectionId;
    batchNotionConfig.dataSourceId = selected.id;
    batchNotionConfig.databaseId = selected.databaseId;
    select.disabled = false;
    if (helper) helper.textContent = "";
    updateBatchSelectedCount();
  }

  async function persistBatchNotionSelection() {
    const stored = await getBatchNotionStoredState();
    const selectedSources = { ...(stored.notion_selected_data_sources || {}) };
    if (batchNotionConfig.connectionId && batchNotionConfig.dataSourceId) {
      selectedSources[batchNotionConfig.connectionId] = batchNotionConfig.dataSourceId;
    }
    const cache = stored[NOTION_UI_CACHE_KEY] && typeof stored[NOTION_UI_CACHE_KEY] === "object"
      ? { ...stored[NOTION_UI_CACHE_KEY] }
      : null;
    if (cache) {
      cache.connectionId = batchNotionConfig.connectionId;
      cache.dataSourceId = batchNotionConfig.dataSourceId;
      cache.databaseId = batchNotionConfig.databaseId;
      cache.updatedAt = Date.now();
    }
    await new Promise((resolve) => chrome.storage.local.set({
      notion_selected_connection_id: batchNotionConfig.connectionId,
      notion_selected_data_sources: selectedSources,
      ...(cache ? { [NOTION_UI_CACHE_KEY]: cache } : {})
    }, resolve));
  }

  async function refreshBatchNotionDestination() {
    const stored = await getBatchNotionStoredState();
    hydrateBatchNotionCache(stored);
    renderBatchNotionDestination();
    try {
      const connectionResponse = await notionBatchMessage({ type: "CHATVAULT_NOTION_LIST_CONNECTIONS" });
      const connections = (connectionResponse.connections || []).filter((item) => item?.mode === "oauth");
      const results = await Promise.all(connections.map(async (connection) => {
        try {
          const response = await notionBatchMessage({
            type: "CHATVAULT_NOTION_SEARCH_DATA_SOURCES",
            connectionId: connection.id
          });
          return (response.dataSources || []).map((item) => normalizeBatchNotionDataSource(item, connection));
        } catch (error) {
          return (batchNotionConfig.dataSources || []).filter((item) => item.connectionId === connection.id);
        }
      }));
      batchNotionConfig.connections = connections;
      batchNotionConfig.dataSources = results.flat();
      const selected = batchNotionConfig.dataSources.find((item) => (
        item.connectionId === batchNotionConfig.connectionId && item.id === batchNotionConfig.dataSourceId
      )) || batchNotionConfig.dataSources[0];
      batchNotionConfig.connectionId = selected?.connectionId || "";
      batchNotionConfig.dataSourceId = selected?.id || "";
      batchNotionConfig.databaseId = selected?.databaseId || "";
      renderBatchNotionDestination();
      if (selected) await persistBatchNotionSelection();
    } catch (error) {
      console.warn("[Notion Batch] Could not refresh destination list:", error);
    }
  }

  function showBatchNotionSignInDialog() {
    return new Promise((resolve) => {
      const overlay = shadowRoot?.getElementById("cv-notion-auth-overlay");
      const cancel = shadowRoot?.getElementById("cv-notion-auth-cancel");
      const confirm = shadowRoot?.getElementById("cv-notion-auth-confirm");
      if (!overlay || !cancel || !confirm) {
        resolve(false);
        return;
      }

      let settled = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        overlay.classList.remove("active");
        overlay.setAttribute("aria-hidden", "true");
        overlay.hidden = true;
        cancel.onclick = null;
        confirm.onclick = null;
        overlay.onclick = null;
        overlay.onkeydown = null;
        resolve(confirmed);
      };
      cancel.onclick = () => finish(false);
      confirm.onclick = () => finish(true);
      overlay.onclick = (event) => {
        if (event.target === overlay) finish(false);
      };
      overlay.onkeydown = (event) => {
        if (event.key === "Escape") finish(false);
      };
      overlay.setAttribute("aria-hidden", "false");
      overlay.hidden = false;
      overlay.offsetHeight;
      overlay.classList.add("active");
      confirm.focus();
    });
  }

  async function connectBatchNotionWorkspace() {
    const button = shadowRoot?.getElementById("cv-batch-notion-connect");
    if (button) button.disabled = true;
    try {
      if (!currentSession?.access_token) {
        const confirmed = await showBatchNotionSignInDialog();
        if (!confirmed) return;
        const signedIn = await performSignIn();
        if (!signedIn || !currentSession?.access_token) {
          showPageToast(t("popup_login_incomplete", isChineseUi() ? "登录未完成，请重试。" : "Sign-in was not completed. Please try again."));
          return;
        }
        renderBatchNotionDestination();
        showPageToast(t("notion_signin_again", isChineseUi() ? "登录成功，请再次点击“连接 Notion”继续。" : "Signed in. Click Connect Notion again to continue."));
        return;
      }

      showPageToast(t("notion_oauth_opening", isChineseUi() ? "正在打开 Notion 授权..." : "Opening Notion authorization..."));
      await notionBatchMessage({ type: "CHATVAULT_NOTION_START_OAUTH" });
      await refreshBatchNotionDestination();
      showPageToast(t("notion_oauth_success", isChineseUi() ? "Notion 已连接。" : "Notion connected."));
    } catch (error) {
      showPageToast(t("notion_oauth_failed", isChineseUi() ? "Notion 连接失败：$1" : "Notion connection failed: $1", error?.message || ""));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function obsidianBatchMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) return reject(new Error(lastError.message));
        if (!response || response.ok === false) return reject(new Error(response?.error || "Obsidian request failed."));
        resolve(response);
      });
    });
  }

  function formatTruncatedVaultPath(vaultName, notesDestination) {
    const vName = vaultName || "Obsidian Vault";
    const rawPath = `${vName} / ${notesDestination}`;
    if (rawPath.length <= 32) return rawPath;
    const parts = notesDestination.split("/").filter(Boolean);
    if (parts.length > 2) {
      return `${vName} / .../${parts.slice(-2).join("/")}`;
    } else if (parts.length === 2) {
      return `${vName} / .../${parts[1]}`;
    }
    return rawPath;
  }

  function renderBatchObsidianDestination() {
    const destination = shadowRoot?.getElementById("cv-batch-obsidian-destination");
    const vault = shadowRoot?.getElementById("cv-batch-obsidian-vault");
    const helper = shadowRoot?.getElementById("cv-batch-obsidian-helper");
    const configure = shadowRoot?.getElementById("cv-batch-obsidian-configure");
    if (!vault || !configure) return;
    if (helper) helper.textContent = "";
    destination?.classList.toggle("is-unconfigured", !batchObsidianStatus.connected);

    if (!batchObsidianStatus.connected) {
      vault.textContent = tx("obsidian_not_connected", "Vault not connected", "Vault 尚未连接");
      vault.title = tx("obsidian_not_connected", "Vault not connected", "Vault 尚未连接");
      configure.textContent = tx("obsidian_configure", "Config Obsidian", "配置 Obsidian");
    } else if (batchObsidianStatus.permission !== "granted") {
      vault.textContent = batchObsidianStatus.vaultName || "Obsidian Vault";
      vault.title = batchObsidianStatus.vaultName || "Obsidian Vault";
      configure.textContent = tx("obsidian_reauthorize", "Reauthorize", "重新授权");
    } else if (batchObsidianStatus.directoriesValid === false) {
      vault.textContent = batchObsidianStatus.vaultName || "Obsidian Vault";
      vault.title = batchObsidianStatus.vaultName || "Obsidian Vault";
      configure.textContent = tx("obsidian_repair_folders", "Repair folders", "修复目录");
    } else if (batchObsidianStatus.activeJob) {
      vault.textContent = batchObsidianStatus.vaultName || "Obsidian Vault";
      vault.title = batchObsidianStatus.vaultName || "Obsidian Vault";
      configure.textContent = tx("obsidian_settings", "Settings", "设置");
    } else {
      const hasConfiguredFolder = Boolean(batchObsidianStatus.config?.notesRoot || batchObsidianStatus.vaultName);
      if (!hasConfiguredFolder) {
        vault.textContent = tx("obsidian_not_connected", "Vault not connected", "Vault 尚未连接");
        vault.title = tx("obsidian_not_connected", "Vault not connected", "Vault 尚未连接");
        configure.textContent = tx("obsidian_configure", "Config Obsidian", "配置 Obsidian");
      } else {
        const notesDestination = batchObsidianStatus.config?.notesRoot || tx("obsidian_vault_root", "Vault root", "Vault 根目录");
        const vName = batchObsidianStatus.vaultName || "Obsidian Vault";
        const fullPath = `${vName} / ${notesDestination}`;
        vault.textContent = formatTruncatedVaultPath(vName, notesDestination);
        vault.title = fullPath;
        configure.textContent = tx("obsidian_change_folder", "Change folder", "更改目录");
      }
    }
    updateBatchSelectedCount();
  }

  async function refreshBatchObsidianDestination() {
    try {
      batchObsidianStatus = await obsidianBatchMessage({ type: "CHATVAULT_OBSIDIAN_GET_STATUS" });
    } catch (error) {
      batchObsidianStatus = { connected: false, permission: "missing", activeJob: null, error: error?.message || "" };
    }
    renderBatchObsidianDestination();
  }

  function setBatchMode(mode) {
    const nextMode = mode === "notion" || mode === "obsidian" ? mode : "files";
    if (nextMode !== batchMode && !globalThis.CHATVAULT_IS_BATCH_EXPORT && (batchNotionResults.size || batchObsidianResults.size)) {
      batchNotionJobs = new Map();
      batchNotionResults = new Map();
      batchNotionBatchId = "";
      batchObsidianResults = new Map();
      batchObsidianBatchId = "";
      shadowRoot?.querySelectorAll(".cv-batch-badge").forEach((badge) => {
        badge.className = "cv-batch-badge waiting";
        badge.textContent = "Waiting";
      });
      shadowRoot?.querySelectorAll(".cv-batch-row-open").forEach((button) => {
        button.hidden = true;
        button.dataset.url = "";
        button.dataset.service = "";
        button.dataset.vaultName = "";
        button.dataset.notePath = "";
      });
      const exportButton = shadowRoot?.getElementById("cv-batch-btn-export");
      const clearButton = shadowRoot?.getElementById("cv-batch-btn-clear");
      if (exportButton) exportButton.style.display = "flex";
      if (clearButton) clearButton.textContent = getBatchClearLabel();
    }
    batchMode = nextMode;
    shadowRoot?.querySelector(".cv-batch-modal")?.classList.toggle("notion-mode", batchMode === "notion");
    shadowRoot?.querySelector(".cv-batch-modal")?.classList.toggle("obsidian-mode", batchMode === "obsidian");
    if (!globalThis.CHATVAULT_IS_BATCH_EXPORT) {
      const title = shadowRoot?.getElementById("cv-batch-title-text");
      if (title && batchMode === "obsidian") title.textContent = tx("obsidian_batch_title", "Sync to Obsidian", "同步到 Obsidian");
      else if (title && batchMode === "notion") title.textContent = tx("content_batch_sync_notion", "Sync to Notion", "同步到 Notion");
      else if (title) title.textContent = t("batch_export", isChineseUi() ? "批量导出" : "Batch Export");
    }
    shadowRoot?.querySelectorAll(".cv-batch-mode-tab").forEach((button) => {
      const active = button.getAttribute("data-mode") === batchMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const destination = shadowRoot?.getElementById("cv-batch-notion-destination");
    const obsidianDestination = shadowRoot?.getElementById("cv-batch-obsidian-destination");
    const format = shadowRoot?.querySelector(".cv-batch-fixed-format-container");
    if (destination) destination.hidden = batchMode !== "notion";
    if (obsidianDestination) obsidianDestination.hidden = batchMode !== "obsidian";
    if (format) format.hidden = batchMode !== "files";
    updateBatchSelectedCount();
    if (batchMode === "notion") refreshBatchNotionDestination();
    if (batchMode === "obsidian") refreshBatchObsidianDestination();
  }

  function rebuildBatchListUI() {
    const itemsContainer = shadowRoot.getElementById("cv-batch-list-items");
    if (!itemsContainer) return;

    const selectedIds = new Set(
      Array.from(shadowRoot.querySelectorAll(".cv-batch-item-row.selected"))
        .map(row => row.getAttribute("data-chat-id"))
    );

    itemsContainer.innerHTML = "";
    const originalCount = displayedConversationsCount;
    displayedConversationsCount = 0;

    const pageItems = batchList.slice(0, Math.max(batchPageSize, originalCount));
    appendBatchListItems(pageItems, 0, selectedIds);
    displayedConversationsCount = pageItems.length;

    hasMoreConversations = batchList.length > displayedConversationsCount || !batchChatGptLoadedAll;
    updateLoadMoreUi();
  }

  function renderRemainingBatchListItems() {
    if (displayedConversationsCount >= batchList.length) return;

    const selectedIds = new Set(
      Array.from(shadowRoot.querySelectorAll(".cv-batch-item-row.selected"))
        .map(row => row.getAttribute("data-chat-id"))
    );
    const startIndex = displayedConversationsCount;
    appendBatchListItems(batchList.slice(startIndex), startIndex, selectedIds);
    displayedConversationsCount = batchList.length;
  }

  async function commitChatGptHistoryPage(payload, offset) {
    const rawItems = getConversationItems(payload);
    if (typeof payload.total === "number") batchChatGptWebTotal = payload.total;

    const knownIds = new Set(batchList.map(item => item.id));
    rawItems.map(normalizeChatGptHistoryItem).filter(Boolean).forEach(item => {
      if (knownIds.has(item.id)) return;
      knownIds.add(item.id);
      batchList.push(item);
    });

    batchChatGptNextOffset = Math.max(batchChatGptNextOffset, offset + rawItems.length);
    if (
      !rawItems.length ||
      rawItems.length < historyPageSize ||
      payload?.has_more === false ||
      (typeof batchChatGptWebTotal === "number" && batchChatGptNextOffset >= batchChatGptWebTotal)
    ) {
      batchChatGptLoadedAll = true;
    }

    // Cached chats do not increase batchList.length when the API returns the
    // same IDs. Reveal the range whose server cursor has now been verified;
    // otherwise page two stays hidden until the entire history finishes.
    const visiblePageEnd = Math.min(batchList.length, offset + rawItems.length);
    if (visiblePageEnd > displayedConversationsCount) {
      const selectedIds = new Set(
        Array.from(shadowRoot.querySelectorAll(".cv-batch-item-row.selected"))
          .map(row => row.getAttribute("data-chat-id"))
      );
      appendBatchListItems(
        batchList.slice(displayedConversationsCount, visiblePageEnd),
        displayedConversationsCount,
        selectedIds
      );
      displayedConversationsCount = visiblePageEnd;
    }

    hasMoreConversations = batchList.length > displayedConversationsCount || !batchChatGptLoadedAll;
    updateLoadMoreUi();

    await writeBatchChatHistoryCache("chatgpt", batchList, {
      total: batchChatGptWebTotal,
      loadedAll: batchChatGptLoadedAll,
      nextOffset: batchChatGptNextOffset
    });
  }

  async function loadRemainingChatGptHistory(session) {
    if (batchHistoryLoadingActive) return;
    batchHistoryLoadingActive = true;

    const loader = shadowRoot.getElementById("cv-batch-loading-indicator");
    
    updateLoadMoreUi();

    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    historyLoop:
    while (batchModalOpen && !batchChatGptLoadedAll && !globalThis.CHATVAULT_IS_BATCH_EXPORT && consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
      try {
        // Fetch and render the immediately-next page on its own. It must not wait
        // for speculative later pages, which may be throttled or stalled.
        const firstOffset = batchChatGptNextOffset;
        const firstPayload = await fetchChatGptConversationPage(session, firstOffset, historyPageSize);
        if (!batchModalOpen || globalThis.CHATVAULT_IS_BATCH_EXPORT) break;
        await commitChatGptHistoryPage(firstPayload, firstOffset);
        consecutiveErrors = 0;
        if (batchChatGptLoadedAll) break;

        await new Promise((resolve) => requestAnimationFrame(resolve));

        const remainingCount = typeof batchChatGptWebTotal === "number"
          ? Math.max(0, batchChatGptWebTotal - batchChatGptNextOffset)
          : historyPageSize * Math.max(0, batchHistoryPrefetchPages - 1);
        const prefetchPageCount = Math.max(0, Math.min(
          Math.max(0, batchHistoryPrefetchPages - 1),
          Math.ceil(remainingCount / historyPageSize) || 0
        ));
        const prefetchOffsets = Array.from(
          { length: prefetchPageCount },
          (_, index) => batchChatGptNextOffset + index * historyPageSize
        );
        const pageRequests = prefetchOffsets.map(async (offset, index) => {
          if (index > 0) {
            await new Promise((resolve) => setTimeout(resolve, index * 150));
          }
          try {
            const payload = await fetchChatGptConversationPage(session, offset, historyPageSize);
            return { ok: true, offset, payload };
          } catch (error) {
            return { ok: false, offset, error };
          }
        });

        // Consume in cursor order, but commit each page as soon as that request
        // resolves. A slower later request cannot hold an earlier page hostage.
        for (const pageRequest of pageRequests) {
          const result = await pageRequest;
          if (!result.ok) throw result.error || new Error("ChatGPT history request failed.");
          if (!batchModalOpen || globalThis.CHATVAULT_IS_BATCH_EXPORT) break historyLoop;
          await commitChatGptHistoryPage(result.payload, result.offset);
          consecutiveErrors = 0;
          if (batchChatGptLoadedAll) break;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      } catch (error) {
        consecutiveErrors++;
        // Use console.debug (not warn) so transient network errors don't appear
        // in the extension error panel. They are expected when the network is flaky.
        console.debug(`[ChatVault] History background load paused (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error && error.message);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * consecutiveErrors));
      }
    }

    batchHistoryLoadingActive = false;
    if (batchChatGptLoadedAll && batchModalOpen && !globalThis.CHATVAULT_IS_BATCH_EXPORT) {
      renderRemainingBatchListItems();
      hasMoreConversations = false;
    }
    if (loader) loader.style.display = "none";
    updateLoadMoreUi();
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
    batchNotionJobs = new Map();
    batchNotionResults = new Map();
    batchNotionBatchId = "";
    batchObsidianResults = new Map();
    batchObsidianBatchId = "";

    overlay.classList.add("active");
    batchModalOpen = true;
    setBatchMode(batchMode);

    // Reset search
    const searchInput = shadowRoot.getElementById("cv-batch-search");
    if (searchInput) searchInput.value = "";

    batchHistoryLoadingActive = false;
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
        const cached = await readBatchChatHistoryCache(platform);
        if (cached && Array.isArray(cached.chats) && cached.chats.length > 0) {
          batchList = cached.chats;
          batchChatGptNextOffset = cached.nextOffset || 0;
          batchChatGptWebTotal = cached.total || null;
          batchChatGptLoadedAll = Boolean(cached.loadedAll);
          displayedConversationsCount = 0;

          // Render cache instantly
          const pageItems = batchList.slice(0, batchPageSize);
          appendBatchListItems(pageItems, 0);
          displayedConversationsCount = pageItems.length;
          hasMoreConversations = batchList.length > displayedConversationsCount || !batchChatGptLoadedAll;
          updateLoadMoreUi();

          // Background sync
          if (loader) {
            loader.style.display = "flex";
            loader.querySelector("span").textContent = tx("content_background_syncing", "Updating conversation history in background...", "正在后台更新会话历史...");
            loader.querySelector(".cv-batch-dot-spinner").style.display = "block";
          }
          await performBackgroundSync(platform);
        } else {
          // Sync blockingly
          if (loader) {
            loader.style.display = "flex";
            loader.querySelector("span").textContent = tx("content_syncing_sidebar", "Syncing sidebar history and loading more chats...", "正在同步侧边栏历史，加载更多聊天...");
            loader.querySelector(".cv-batch-dot-spinner").style.display = "block";
          }
          await loadNextPageOfConversations(platform);
          await writeBatchChatHistoryCache(platform, batchList, {
            total: batchChatGptWebTotal,
            loadedAll: batchChatGptLoadedAll,
            nextOffset: batchChatGptNextOffset
          });
        }
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
    const hasNotionDestination = Boolean(batchNotionConfig.connectionId && batchNotionConfig.dataSourceId);
    const hasObsidianDestination = Boolean(batchObsidianStatus.connected && batchObsidianStatus.permission === "granted" && batchObsidianStatus.directoriesValid !== false && !batchObsidianStatus.activeJob);

    if (exportBtn) {
      if (batchMode === "notion") {
        exportBtn.textContent = count > 0
          ? tx("content_sync_chat_count", "Sync $1 chats to Notion", "同步 $1 个会话到 Notion", count)
          : tx("content_batch_sync_notion", "Sync to Notion", "同步到 Notion");
      } else if (batchMode === "obsidian") {
        exportBtn.textContent = count > 0
          ? tx("obsidian_sync_chat_count", "Sync $1 chats to Obsidian", "同步 $1 个会话到 Obsidian", count)
          : tx("obsidian_batch_sync", "Sync to Obsidian", "同步到 Obsidian");
      } else {
        exportBtn.textContent = t("btn_export", isChineseUi() ? "导出" : "Export");
      }
    }

    if (count > 10) {
      if (warning) warning.style.display = "block";
      if (exportBtn) exportBtn.disabled = true;
    } else {
      if (warning) warning.style.display = "none";
      if (exportBtn) exportBtn.disabled = count === 0;
    }

    // 达到 10 个限制时禁用未选中的项
    rows.forEach(row => {
      if (count >= 10 && !row.classList.contains("selected")) {
        row.classList.add("disabled");
        row.setAttribute("aria-disabled", "true");
      } else {
        row.classList.remove("disabled");
        row.removeAttribute("aria-disabled");
      }
    });
  }

  function filterBatchList() {
    const input = shadowRoot.getElementById("cv-batch-search");
    const query = input ? input.value.toLowerCase().trim() : "";
    const rows = shadowRoot.querySelectorAll(".cv-batch-item-row");
    let hasMatch = false;

    rows.forEach(row => {
      const titleEl = row.querySelector(".cv-batch-item-title");
      const title = titleEl ? titleEl.textContent.toLowerCase() : "";
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

    if (clearBtn) clearBtn.textContent = isExporting ? getBatchCancelLabel() : getBatchClearLabel();
    if (exportBtn) exportBtn.disabled = isExporting || shadowRoot.querySelectorAll(".cv-batch-item-row.selected").length === 0;
    if (closeBtn) closeBtn.setAttribute("aria-label", isExporting ? tx("content_cancel_export", "Cancel export", "取消导出") : getBatchCloseLabel());
    shadowRoot.querySelectorAll(".cv-batch-item-row").forEach(row => {
      row.classList.toggle("is-exporting", isExporting);
    });
    shadowRoot.querySelectorAll(".cv-batch-format-btn, .cv-batch-theme-option, .cv-batch-toggle-item input, .cv-batch-mode-tab, #cv-batch-notion-select, #cv-batch-notion-connect, #cv-batch-obsidian-configure").forEach(el => {
      el.disabled = isExporting;
    });
  }

  function updateNotionBatchRow(index, status, options = {}) {
    const row = shadowRoot?.getElementById(`cv-batch-row-${index}`);
    const badge = shadowRoot?.getElementById(`cv-batch-badge-${index}`);
    const openButton = shadowRoot?.getElementById(`cv-batch-open-${index}`);
    if (!row || !badge) return;
    const labels = {
      preparing: tx("content_notion_preparing", "Preparing", "准备中"),
      held: tx("content_notion_waiting", "Waiting", "等待中"),
      pending: tx("content_notion_queued", "Queued", "已排队"),
      running: tx("content_notion_syncing", "Syncing", "同步中"),
      retry_wait: tx("content_notion_retrying", "Retrying", "重试中"),
      succeeded: tx("content_notion_synced", "Synced", "已同步"),
      partial: tx("content_notion_partial", "Synced with warnings", "已同步，有降级"),
      failed: tx("content_notion_failed", "Failed", "失败"),
      cancelled: tx("content_notion_cancelled", "Cancelled", "已取消")
    };
    badge.className = `cv-batch-badge ${status === "succeeded" || status === "partial" ? "completed" : status === "failed" || status === "cancelled" ? "failed" : status === "preparing" || status === "running" || status === "retry_wait" ? "generating" : "loading"}`;
    badge.textContent = labels[status] || status;
    badge.title = options.error || "";
    row.dataset.notionStatus = status;
    const url = normalizeNotionPageUrl(options.notionPageUrl);
    if (openButton) {
      openButton.hidden = !url;
      openButton.dataset.url = url || "";
    }
  }

  function updateNotionBatchSummary() {
    const total = batchActiveItems.length;
    const states = Array.from(batchNotionResults.values());
    const successCount = states.filter((item) => item.status === "succeeded" || item.status === "partial").length;
    const failureCount = states.filter((item) => item.status === "failed" || item.status === "cancelled").length;
    const completedCount = successCount + failureCount;
    const runningProgress = states.reduce((sum, item) => {
      if (["succeeded", "partial", "failed", "cancelled"].includes(item.status)) return sum + 1;
      return sum + Math.max(0, Math.min(0.95, Number(item.progress || 0)));
    }, 0);
    const percent = total ? Math.round(runningProgress / total * 100) : 0;
    if (!globalThis.CHATVAULT_IS_BATCH_EXPORT) return;
    renderExportProgress("notion", {
      mode: "batch",
      title: tx("content_notion_batch_in_progress", "Syncing to Notion", "正在同步到 Notion"),
      label: tx("content_batch_sync_notion", "Sync to Notion", "同步到 Notion"),
      message: tx("content_notion_batch_progress", "$1 of $2 complete", "已完成 $1 / $2", completedCount, total),
      total,
      current: Math.min(total, completedCount + 1),
      completed: completedCount,
      issues: failureCount,
      progress: Math.min(0.99, percent / 100),
      overallProgress: Math.min(0.99, percent / 100)
    }, cancelInPageBatchExport);
  }

  function finishNotionBatchIfComplete() {
    if (!batchActiveItems.length || batchNotionResults.size < batchActiveItems.length) return false;
    const allTerminal = Array.from(batchNotionResults.values()).every((item) => (
      ["succeeded", "partial", "failed", "cancelled"].includes(item.status)
    ));
    if (!allTerminal) return false;
    globalThis.CHATVAULT_IS_BATCH_EXPORT = false;
    setBatchExportingUi(false);
    hideExportProgress();
    const values = Array.from(batchNotionResults.values());
    const successes = values.filter((item) => item.status === "succeeded" || item.status === "partial");
    const failures = values.filter((item) => item.status === "failed" || item.status === "cancelled");
    showBatchSyncResultDialog({
      id: batchNotionBatchId,
      service: "notion",
      total: batchActiveItems.length,
      successCount: successes.length,
      failureCount: failures.length,
      items: successes.map((result) => ({
        title: result.item?.title || tx("notion_untitled_conversation", "Untitled conversation", "未命名会话"),
        url: normalizeNotionPageUrl(result.notionPageUrl),
        status: result.status
      }))
    });
    return true;
  }

  function updateObsidianBatchRow(index, status, options = {}) {
    const row = shadowRoot?.getElementById(`cv-batch-row-${index}`);
    const badge = shadowRoot?.getElementById(`cv-batch-badge-${index}`);
    const openButton = shadowRoot?.getElementById(`cv-batch-open-${index}`);
    if (!row || !badge) return;
    const labels = {
      waiting: tx("obsidian_waiting", "Waiting", "等待中"),
      preparing: tx("obsidian_preparing", "Checking Vault", "检查 Vault"),
      fetching: tx("obsidian_fetching", "Getting conversation", "获取会话"),
      media: tx("obsidian_processing_media", "Processing images", "处理图片"),
      render: tx("obsidian_rendering", "Building Markdown", "生成 Markdown"),
      write: tx("obsidian_writing", "Writing to Vault", "写入 Vault"),
      succeeded: tx("obsidian_synced", "Synced", "已同步"),
      partial: tx("obsidian_synced_partial", "Synced with warnings", "已同步，有警告"),
      failed: tx("obsidian_failed", "Failed", "失败"),
      cancelled: tx("obsidian_cancelled", "Cancelled", "已取消")
    };
    const terminalSuccess = status === "succeeded" || status === "partial";
    const terminalFailure = status === "failed" || status === "cancelled";
    badge.className = `cv-batch-badge ${terminalSuccess ? "completed" : terminalFailure ? "failed" : status === "waiting" ? "loading" : "generating"}`;
    badge.textContent = labels[status] || status;
    badge.title = String(options.error || options.detail || "");
    row.dataset.obsidianStatus = status;
    if (openButton) {
      const canOpen = terminalSuccess && options.canOpenInObsidian !== false && options.vaultName && options.noteRelativePath;
      openButton.hidden = !canOpen;
      openButton.dataset.service = canOpen ? "obsidian" : "";
      openButton.dataset.vaultName = canOpen ? String(options.vaultName) : "";
      openButton.dataset.notePath = canOpen ? String(options.noteRelativePath) : "";
      openButton.dataset.url = "";
    }
  }

  function getObsidianBatchTotals() {
    const states = Array.from(batchObsidianResults.values());
    return {
      successCount: states.filter((item) => item.status === "succeeded" || item.status === "partial").length,
      failureCount: states.filter((item) => item.status === "failed" || item.status === "cancelled").length,
      savedImages: states.reduce((sum, item) => sum + Math.max(0, Number(item.savedImages || 0)), 0),
      warningCount: states.reduce((sum, item) => sum + Math.max(0, Number(item.warningCount || 0)), 0)
    };
  }

  function updateObsidianBatchSummary() {
    const total = batchActiveItems.length;
    const states = Array.from(batchObsidianResults.values());
    const totals = getObsidianBatchTotals();
    const completedCount = totals.successCount + totals.failureCount;
    const completedProgress = states.reduce((sum, item) => {
      if (["succeeded", "partial", "failed", "cancelled"].includes(item.status)) return sum + 1;
      return sum + Math.max(0, Math.min(0.98, Number(item.progress || 0)));
    }, 0);
    const percent = total ? Math.min(100, Math.round(completedProgress / total * 100)) : 0;
    if (!globalThis.CHATVAULT_IS_BATCH_EXPORT) return;
    renderExportProgress("obsidian", {
      mode: "batch",
      title: tx("obsidian_batch_in_progress", "Syncing to Obsidian", "正在同步到 Obsidian"),
      label: tx("content_batch_sync_obsidian", "Sync to Obsidian", "同步到 Obsidian"),
      message: tx("obsidian_batch_progress", "$1 of $2 complete", "已完成 $1 / $2", completedCount, total),
      total,
      current: Math.min(total, completedCount + 1),
      completed: completedCount,
      issues: totals.failureCount + totals.warningCount,
      progress: Math.min(0.99, percent / 100),
      overallProgress: Math.min(0.99, percent / 100)
    }, cancelInPageBatchExport);
  }

  function finishObsidianBatch(options = {}) {
    if (!batchActiveItems.length || batchObsidianResults.size < batchActiveItems.length) return false;
    const values = Array.from(batchObsidianResults.values());
    if (!values.every((item) => ["succeeded", "partial", "failed", "cancelled"].includes(item.status))) return false;
    globalThis.CHATVAULT_IS_BATCH_EXPORT = false;
    setBatchExportingUi(false);
    hideExportProgress();
    if (options.cancelled) {
      showPageToast(tx("obsidian_batch_cancelled", "Obsidian batch sync cancelled.", "Obsidian 批量同步已取消。"));
      return true;
    }
    const totals = getObsidianBatchTotals();
    showBatchSyncResultDialog({
      id: batchObsidianBatchId,
      service: "obsidian",
      total: batchActiveItems.length,
      ...totals,
      items: values.filter((item) => item.status === "succeeded" || item.status === "partial").map((result) => ({
        title: result.title || result.item?.title || tx("notion_untitled_conversation", "Untitled conversation", "未命名会话"),
        vaultName: result.vaultName || batchObsidianStatus.vaultName || "",
        noteRelativePath: result.noteRelativePath || "",
        canOpen: result.canOpenInObsidian !== false,
        status: result.status
      }))
    });
    return true;
  }

  function handleNotionBatchJobStatus(job) {
    const tracked = batchNotionJobs.get(String(job?.id || ""));
    if (!tracked || !batchNotionBatchId || String(job.batchId || "") !== batchNotionBatchId) return false;
    const result = {
      ...tracked,
      status: job.status,
      progress: Number(job.progress || 0) > 1 ? Number(job.progress || 0) / 100 : Number(job.progress || 0),
      notionPageUrl: job.notionPageUrl || "",
      error: job.errorMessage || job.errorCode || ""
    };
    batchNotionResults.set(tracked.index, result);
    updateNotionBatchRow(tracked.index, job.status, result);
    updateNotionBatchSummary();
    finishNotionBatchIfComplete();
    return true;
  }

  function updateBatchExportProgress(message) {
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
      await loadState({ localOnly: true, skipVerify: true });
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

  async function runInPageBatchNotionSync(selectedItems) {
    const controller = new AbortController();
    batchExportAbortController = controller;
    abortController = controller;
    const signal = controller.signal;
    batchNotionJobs = new Map();
    batchNotionResults = new Map();
    batchNotionBatchId = `notion_batch_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    batchActiveItems = selectedItems.slice();
    globalThis.CHATVAULT_IS_BATCH_EXPORT = true;
    setBatchExportingUi(true);
    closeBatchModal();

    selectedItems.forEach((item) => {
      batchNotionResults.set(item._batchIndex, {
        index: item._batchIndex,
        item,
        status: "held",
        progress: 0
      });
      updateNotionBatchRow(item._batchIndex, "held", { progress: 0 });
    });
    updateNotionBatchSummary();

    try {
      await loadState({ localOnly: true, skipVerify: true });
      if (!canUseBatchExportLocally()) {
        showBatchExportUpgradePrompt();
        throw new Error("Batch export requires Pro.");
      }
      if (!batchNotionConfig.connectionId || !batchNotionConfig.dataSourceId) {
        throw new Error(tx("content_notion_destination_required", "Choose a Notion Database first.", "请先选择 Notion Database。"));
      }
      await exporter.preload();

      for (let index = 0; index < selectedItems.length; index += 1) {
        const item = selectedItems[index];
        const rowIndex = item._batchIndex;
        let itemJobId = "";
        let itemJobReleased = false;
        if (signal.aborted) throw new DOMException("Sync cancelled.", "AbortError");
        updateNotionBatchRow(rowIndex, "preparing", { progress: 0.05 });
        batchNotionResults.set(rowIndex, { index: rowIndex, item, status: "preparing", progress: 0.05 });
        updateNotionBatchSummary();

        try {
          const pageMessages = isCurrentConversation(item)
            ? parseCurrentChatMessages({ includeHtmlStyles: true })
            : undefined;
          const messages = await fetchConversationMessagesForExport(item, {
            pageMessages,
            preserveHtmlPresentation: true,
            preserveMarkdownSemantics: true
          });
          if (!messages.length) {
            throw new Error(tx("content_no_messages_for_batch_item", "No exportable messages found.", "未找到可导出的消息。"));
          }
          if (signal.aborted) throw new DOMException("Sync cancelled.", "AbortError");

          const platform = getChatPlatform(item) || getCurrentPlatformId();
          const sourceUrl = sanitizeSourceUrl(item.url || getBatchPlatformChatUrl(platform, getChatConversationId(item)));
          const snapshot = await globalThis.CHATVAULT_EXPORT.prepareNotionJob({
            title: item.title || "AI Chat Export",
            sourceUrl,
            messages,
            platform,
            model: "",
            userId: currentSession?.user?.id || "guest",
            connectionId: batchNotionConfig.connectionId,
            databaseId: batchNotionConfig.databaseId,
            dataSourceId: batchNotionConfig.dataSourceId,
            alwaysCreate: true,
            settings: { ...exportSettings },
            signal,
            onMediaProgress: (info) => {
              const total = Math.max(1, Number(info?.total || 0));
              const progress = 0.08 + Math.min(0.17, Number(info?.completed || 0) / total * 0.17);
              batchNotionResults.set(rowIndex, { index: rowIndex, item, status: "preparing", progress });
              updateNotionBatchRow(rowIndex, "preparing", { progress });
              updateNotionBatchSummary();
            }
          });
          snapshot.batchId = batchNotionBatchId;
          snapshot.batchIndex = index;
          snapshot.batchTotal = selectedItems.length;

          const response = await notionBatchMessage({
            type: "CHATVAULT_NOTION_ENQUEUE",
            snapshot,
            deferStart: true
          });
          const jobId = String(response.job?.id || "");
          if (!jobId) throw new Error("Notion job could not be created.");
          itemJobId = jobId;
          const tracked = { index: rowIndex, item, jobId, status: "held", progress: 0.25 };
          batchNotionJobs.set(jobId, tracked);
          batchNotionResults.set(rowIndex, tracked);
          updateNotionBatchRow(rowIndex, "held", { progress: 0.25 });
          updateNotionBatchSummary();
          await notionBatchMessage({ type: "CHATVAULT_NOTION_RELEASE_JOB", jobId });
          itemJobReleased = true;
          const pending = { ...tracked, status: "pending", progress: 0.25 };
          batchNotionResults.set(rowIndex, pending);
          updateNotionBatchRow(rowIndex, "pending", pending);
          updateNotionBatchSummary();
        } catch (error) {
          if (signal.aborted || error?.name === "AbortError") throw error;
          if (itemJobId && !itemJobReleased) {
            batchNotionJobs.delete(itemJobId);
            await notionBatchMessage({ type: "CHATVAULT_NOTION_CANCEL_JOB", jobId: itemJobId }).catch(() => {});
          }
          const failed = { index: rowIndex, item, status: "failed", progress: 1, error: error?.message || "Notion sync failed." };
          batchNotionResults.set(rowIndex, failed);
          updateNotionBatchRow(rowIndex, "failed", failed);
          updateNotionBatchSummary();
        }
      }

      updateNotionBatchSummary();
      finishNotionBatchIfComplete();
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        for (const [jobId, tracked] of batchNotionJobs) {
          notionBatchMessage({ type: "CHATVAULT_NOTION_CANCEL_JOB", jobId }).catch(() => {});
          const cancelled = { ...tracked, status: "cancelled", progress: 1 };
          batchNotionResults.set(tracked.index, cancelled);
          updateNotionBatchRow(tracked.index, "cancelled", cancelled);
        }
        selectedItems.forEach((item) => {
          const current = batchNotionResults.get(item._batchIndex);
          if (!current || !["succeeded", "partial", "failed", "cancelled"].includes(current.status)) {
            const cancelled = { index: item._batchIndex, item, status: "cancelled", progress: 1 };
            batchNotionResults.set(item._batchIndex, cancelled);
            updateNotionBatchRow(item._batchIndex, "cancelled", cancelled);
          }
        });
      } else {
        if (error?.message !== "Batch export requires Pro.") {
          showPageToast(tx("notion_sync_failed", "Notion sync failed: $1", "Notion 同步失败：$1", error?.message || "Notion sync failed."));
        }
        selectedItems.forEach((item) => {
          const current = batchNotionResults.get(item._batchIndex);
          if (!current || !["succeeded", "partial", "failed", "cancelled"].includes(current.status)) {
            const failed = { index: item._batchIndex, item, status: "failed", progress: 1, error: error?.message || "Notion sync failed." };
            batchNotionResults.set(item._batchIndex, failed);
            updateNotionBatchRow(item._batchIndex, "failed", failed);
          }
        });
      }
      updateNotionBatchSummary();
      finishNotionBatchIfComplete();
    } finally {
      if (batchExportAbortController === controller) batchExportAbortController = null;
      if (abortController === controller) abortController = null;
    }
  }

  async function runInPageBatchObsidianSync(selectedItems) {
    const controller = new AbortController();
    batchExportAbortController = controller;
    abortController = controller;
    const signal = controller.signal;
    batchObsidianResults = new Map();
    batchObsidianBatchId = `obsidian_batch_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    batchActiveItems = selectedItems.slice();
    globalThis.CHATVAULT_IS_BATCH_EXPORT = true;
    setBatchExportingUi(true);
    closeBatchModal();

    selectedItems.forEach((item) => {
      const initial = { index: item._batchIndex, item, status: "waiting", progress: 0 };
      batchObsidianResults.set(item._batchIndex, initial);
      updateObsidianBatchRow(item._batchIndex, "waiting", initial);
    });
    updateObsidianBatchSummary();

    try {
      await loadState({ localOnly: true, skipVerify: true });
      if (!canUseBatchExportLocally()) {
        showBatchExportUpgradePrompt();
        throw new Error("Batch export requires Pro.");
      }
      const coordinator = await loadObsidianCoordinator();
      const status = await coordinator.getObsidianStatus();
      batchObsidianStatus = status;
      renderBatchObsidianDestination();
      if (!status.connected) throw new Error(tx("obsidian_connect_first", "Connect an Obsidian Vault first.", "请先连接 Obsidian Vault。"));
      if (status.permission !== "granted") throw new Error(tx("obsidian_reauthorize_first", "Reauthorize the Obsidian Vault first.", "请先重新授权 Obsidian Vault。"));
      if (status.directoriesValid === false) throw new Error(tx("obsidian_repair_folders", "Repair the configured Obsidian folders first.", "请先修复 Obsidian 配置目录。"));
      if (status.activeJob) throw new Error(tx("obsidian_job_running", "Another Obsidian sync is already running.", "已有 Obsidian 同步任务正在运行。"));
      await exporter.preload();

      const settings = {
        ...exportSettings,
        include_source_url: Boolean(shadowRoot?.getElementById("cv-toggle-source-url")?.checked),
        show_role_labels: shadowRoot?.getElementById("cv-toggle-role-labels")?.checked !== false
      };

      for (let index = 0; index < selectedItems.length; index += 1) {
        const item = selectedItems[index];
        const rowIndex = item._batchIndex;
        if (signal.aborted) throw new DOMException("Sync cancelled.", "AbortError");
        const fetching = { index: rowIndex, item, status: "fetching", progress: 0.04 };
        batchObsidianResults.set(rowIndex, fetching);
        updateObsidianBatchRow(rowIndex, "fetching", fetching);
        updateObsidianBatchSummary();

        try {
          const pageMessages = isCurrentConversation(item) ? parseCurrentChatMessages() : undefined;
          const captureWarnings = [];
          let messages;
          try {
            messages = await fetchConversationMessagesForExport(item, {
              pageMessages,
              preserveMarkdownSemantics: true
            });
          } catch (error) {
            if (!pageMessages?.length) throw error;
            messages = pageMessages;
            captureWarnings.push({
              code: "conversation_fetch_partial",
              detail: tx("obsidian_visible_content_fallback", "The complete conversation was unavailable; visible page content was used.", "完整会话获取失败，已使用页面可见内容。")
            });
          }
          if (!messages?.length) throw new Error(tx("content_no_messages_for_batch_item", "No exportable messages found.", "未找到可同步的消息。"));
          if (signal.aborted) throw new DOMException("Sync cancelled.", "AbortError");

          const platform = getChatPlatform(item) || getCurrentPlatformId();
          const sourceUrl = sanitizeSourceUrl(item.url || getBatchPlatformChatUrl(platform, getChatConversationId(item)));
          const result = await coordinator.syncConversationToObsidian({
            title: item.title || "AI Chat Export",
            sourceUrl,
            messages,
            platform,
            platformLabel: getPlatformLabel(platform),
            userLabel: t("export_role_user", "You Asked"),
            scope: "conversation",
            settings,
            warnings: captureWarnings,
            batchId: batchObsidianBatchId,
            signal,
            onProgress: (info) => {
              const phase = ["preflight", "media", "render", "write"].includes(info?.phase) ? info.phase : "preparing";
              const updated = {
                index: rowIndex,
                item,
                status: phase === "preflight" ? "preparing" : phase,
                progress: Number(info?.progress || 0),
                detail: info?.detail || ""
              };
              batchObsidianResults.set(rowIndex, updated);
              updateObsidianBatchRow(rowIndex, updated.status, updated);
              updateObsidianBatchSummary();
            }
          });
          const completed = { index: rowIndex, item, ...result, status: result.status === "partial" ? "partial" : "succeeded", progress: 1 };
          batchObsidianResults.set(rowIndex, completed);
          updateObsidianBatchRow(rowIndex, completed.status, completed);
          updateObsidianBatchSummary();
        } catch (error) {
          if (signal.aborted || error?.name === "AbortError") throw error;
          const failed = { index: rowIndex, item, status: "failed", progress: 1, error: error?.message || "Obsidian sync failed." };
          batchObsidianResults.set(rowIndex, failed);
          updateObsidianBatchRow(rowIndex, "failed", failed);
          updateObsidianBatchSummary();
        }
      }

      finishObsidianBatch();
      const totals = getObsidianBatchTotals();
      globalThis.CHATVAULT_ANALYTICS?.track("export_success", {
        platform: getCurrentPlatformId() || "chatgpt",
        properties: { format: "obsidian", source: "batch_sync", count: totals.successCount, failures: totals.failureCount }
      });
    } catch (error) {
      const cancelled = signal.aborted || error?.name === "AbortError";
      selectedItems.forEach((item) => {
        const current = batchObsidianResults.get(item._batchIndex);
        if (!current || !["succeeded", "partial", "failed", "cancelled"].includes(current.status)) {
          const result = { index: item._batchIndex, item, status: cancelled ? "cancelled" : "failed", progress: 1, error: cancelled ? "" : error?.message || "Obsidian sync failed." };
          batchObsidianResults.set(item._batchIndex, result);
          updateObsidianBatchRow(item._batchIndex, result.status, result);
        }
      });
      if (!cancelled && error?.message !== "Batch export requires Pro.") {
        showPageToast(tx("obsidian_sync_failed", "Obsidian sync failed: $1", "Obsidian 同步失败：$1", error?.message || "Obsidian sync failed."));
      }
      updateObsidianBatchSummary();
      finishObsidianBatch({ cancelled });
    } finally {
      if (batchExportAbortController === controller) batchExportAbortController = null;
      if (abortController === controller) abortController = null;
      refreshBatchObsidianDestination().catch(() => {});
    }
  }

  async function startInPageBatchExport() {
    const selectedRows = shadowRoot.querySelectorAll(".cv-batch-item-row.selected");
    const selectedItems = [];
    
    selectedRows.forEach(row => {
      const index = parseInt(row.getAttribute("data-index"), 10);
      if (batchList[index]) {
        selectedItems.push({ ...batchList[index], _batchIndex: index });
      }
    });

    if (selectedItems.length === 0) return;

    if (batchMode === "notion") {
      runInPageBatchNotionSync(selectedItems);
      return;
    }
    if (batchMode === "obsidian") {
      runInPageBatchObsidianSync(selectedItems);
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
    setBatchExportingUi(true);
    updateBatchExportProgress({
      status: "progress",
      currentIndex: 0,
      total: selectedItems.length,
      percent: 0,
      progressText: tx("content_progress_checking_export_access", "Preparing export...", "正在准备导出...")
    });
    closeBatchModal();

    try {
      await loadState({ localOnly: true, skipVerify: true });
      if (isBatchPreflightCancelled()) return;
      if (!isProUser && currentSession?.access_token) {
        const entitlementPreflight = await verifySignedInExportAccess(1);
        if (isBatchPreflightCancelled()) return;
        if (!entitlementPreflight.ok) {
          resetBatchPreflightUi();
          showPageToast(entitlementPreflight.error || tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。"));
          return;
        }
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
    if (batchMode === "notion") {
      batchNotionJobs.forEach((_tracked, jobId) => {
        notionBatchMessage({ type: "CHATVAULT_NOTION_CANCEL_JOB", jobId }).catch(() => {});
      });
      return;
    }
    if (batchMode === "obsidian") return;
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
  async function writeTextToClipboard(value) {
    const text = String(value || "");
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "CHATVAULT_COPY_TEXT",
          text
        });
        if (response?.ok) {
          return;
        }
        throw new Error(response?.error || "Extension clipboard write failed.");
      } catch (err) {
        console.warn("Extension clipboard copy failed:", err);
        throw new Error(tx(
          "content_copy_failed_refresh",
          "Copy failed. Refresh the page and try again.",
          "复制失败，请刷新页面后重试。"
        ));
      }
    }

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch (err) {
      console.warn("Clipboard API copy failed, trying fallback:", err);
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
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
    } catch (err) {
      console.warn("Copy fallback failed:", err);
      throw new Error(tx("content_copy_failed_refresh", "Copy failed. Refresh the page and try again.", "复制失败，请刷新页面后重试。"));
    } finally {
      textarea.remove();
    }
  }

  async function copyRawText() {
    const rawMessages = parseCurrentChatMessages();
    const plainText = exporter.getPlainText(rawMessages);
    if (!plainText) {
      return { ok: false, error: tx("content_no_copy_text", "This conversation has no text content to copy.", "当前对话没有可复制的文本内容。") };
    }
    try {
      await writeTextToClipboard(plainText);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || tx("content_copy_failed_refresh", "Copy failed. Refresh the page and try again.", "复制失败，请刷新页面后重试。") };
    }
  }

  // 手动从网页中提取消息，并做基础清洗
  function parseCurrentChatMessages(options = {}) {
    let raw = [];
    try {
      raw = exporter.parseMessages({ includeHtmlStyles: false, ...options }) || [];
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
        if (platform === "chatgpt" && pageMessages.length > 0 && typeof fetchers.mergeChatGptExportMessages === "function") {
          messages = fetchers.mergeChatGptExportMessages(messages, pageMessages);
        }
        if ((options.preserveHtmlPresentation || options.preserveMarkdownSemantics) && pageMessages.length > 0 && typeof fetchers.mergePageHtmlPresentation === "function") {
          return fetchers.mergePageHtmlPresentation(messages, pageMessages, {
            includeHtmlStyles: options.preserveHtmlPresentation === true
          });
        }
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

  async function getCurrentConversationMessagesForExport(pageMessages, options = {}) {
    const chat = getCurrentConversationForExport();
    if (!chat) return pageMessages;
    return fetchConversationMessagesForExport(chat, {
      pageMessages,
      preserveHtmlPresentation: options.preserveHtmlPresentation === true,
      preserveMarkdownSemantics: options.preserveMarkdownSemantics === true
    });
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
      } else if (currentUserProfile?.email || currentSession?.access_token) {
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
      if (!usageStateLoaded) {
        quotaInfo.innerHTML = "<b>" + escapeHtml(tx("content_quota_loading_title", "Loading quota...", "正在读取额度...")) + "</b><br/>" +
          escapeHtml(tx("content_quota_loading_desc", "Checking today's local export usage.", "正在读取今日本地导出次数。"));
        return;
      }
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
    await applySignedOutStateImmediately();
  }

  async function performSignIn() {
    if (!auth || typeof auth.signInWithGoogle !== "function") {
      throw new Error(tx("content_login_service_unavailable", "Sign-in is temporarily unavailable. Refresh the page and try again.", "登录服务暂时不可用，请刷新页面后重试。"));
    }

    const session = await auth.signInWithGoogle();
    if (!session) {
      return false;
    }

    await applyStoredAuthStateImmediately(session);
    refreshAuthStateInBackground();
    return true;
  }

  // 购买跳转流程
  async function triggerCheckout() {
    showPageToast(tx("content_open_subscribe_panel", "Opening AI Chat Export Pro plans...", "正在打开 AI Chat Export Pro 订阅方案..."));
    openSubscribePanelFromPage();
  }

  function getUpgradePromptMessage(message) {
    if (message === "You have used today's 3 free saved exports." || message === FREE_QUOTA_EXHAUSTED_MESSAGE) {
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
    if (batchModalOpen) {
      closeBatchModal();
    }

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

  function normalizeNotionPageUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const hostname = url.hostname.toLowerCase();
      const trustedHost = hostname === "notion.so" || hostname.endsWith(".notion.so") ||
        hostname === "notion.site" || hostname.endsWith(".notion.site");
      return url.protocol === "https:" && trustedHost ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function hideNotionSuccessDialog() {
    if (!shadowRoot) return;
    const overlay = shadowRoot.getElementById("cv-notion-success-overlay");
    if (!overlay) return;
    overlay.classList.remove("active");
    overlay.setAttribute("aria-hidden", "true");
  }

  function showNotionSuccessDialog(job) {
    if (!shadowRoot || !job) return;
    const jobId = String(job.id || job.jobId || job.notionPageUrl || "");
    if (jobId && lastNotionSuccessDialogJobId === jobId) return;
    const overlay = shadowRoot.getElementById("cv-notion-success-overlay");
    const openLink = shadowRoot.getElementById("cv-notion-success-open");
    if (!overlay || !openLink) return;
    const title = shadowRoot.getElementById("cv-notion-success-title");
    const description = shadowRoot.getElementById("cv-notion-success-desc");
    const documentTitle = shadowRoot.getElementById("cv-notion-success-document-title");
    const partial = job.status === "partial";
    if (title) {
      title.textContent = partial
        ? tx("notion_sync_partial_title", "Synced to Notion with warnings", "已同步到 Notion，但有部分内容降级")
        : tx("notion_sync_success_title", "Synced to Notion", "已成功同步到 Notion");
    }
    if (description) {
      description.textContent = partial
        ? tx("notion_sync_partial_desc", "The page was created successfully. Open it to review any content that could not be preserved exactly.", "Notion 页面已成功创建，请打开页面检查未能完全保留的内容。")
        : tx("notion_sync_success_desc", "This conversation is ready in your Notion Database.", "当前对话已写入你选择的 Notion Database。");
    }
    const url = normalizeNotionPageUrl(job.notionPageUrl);
    if (documentTitle) {
      documentTitle.textContent = String(job.title || tx("notion_untitled_conversation", "Untitled conversation", "未命名会话")).trim();
    }
    openLink.hidden = !url;
    if (url) {
      openLink.setAttribute("href", url);
      openLink.removeAttribute("aria-disabled");
    } else {
      openLink.removeAttribute("href");
      openLink.setAttribute("aria-disabled", "true");
    }
    overlay.classList.add("active");
    overlay.setAttribute("aria-hidden", "false");
    lastNotionSuccessDialogJobId = jobId;
    const closeButton = shadowRoot.getElementById("cv-notion-success-close");
    if (closeButton) closeButton.focus();
  }

  function hideObsidianResultDialog() {
    if (!shadowRoot) return;
    const overlay = shadowRoot.getElementById("cv-obsidian-result-overlay");
    if (!overlay) return;
    overlay.classList.remove("active");
    overlay.setAttribute("aria-hidden", "true");
  }

  function hideBatchSyncResultDialog() {
    const overlay = shadowRoot?.getElementById("cv-batch-result-overlay");
    if (!overlay) return;
    overlay.classList.remove("active");
    overlay.setAttribute("aria-hidden", "true");
  }

  function showBatchSyncResultDialog(result) {
    if (!shadowRoot || !result) return;
    const resultId = String(result.id || `${result.service}:${result.total}:${result.successCount}:${result.failureCount}`);
    if (resultId && resultId === lastBatchSyncResultDialogId) return;
    const overlay = shadowRoot.getElementById("cv-batch-result-overlay");
    const title = shadowRoot.getElementById("cv-batch-result-title");
    const description = shadowRoot.getElementById("cv-batch-result-description");
    const itemsContainer = shadowRoot.getElementById("cv-batch-result-items");
    const mark = shadowRoot.getElementById("cv-batch-result-mark");
    if (!overlay || !itemsContainer) return;

    const service = result.service === "obsidian" ? "obsidian" : "notion";
    const total = Math.max(0, Number(result.total || 0));
    const successCount = Math.max(0, Number(result.successCount || 0));
    const failureCount = Math.max(0, Number(result.failureCount || 0));
    const partial = failureCount > 0 || Number(result.warningCount || 0) > 0;
    const failed = successCount === 0;
    title.textContent = failed
      ? tx("content_notion_failed", "Batch sync failed", "批量同步失败")
      : partial
        ? service === "obsidian"
          ? tx("obsidian_sync_partial_title", "Obsidian sync completed with warnings", "Obsidian 同步完成，但有部分警告")
          : tx("notion_sync_partial_title", "Synced to Notion with warnings", "已同步到 Notion，但有部分警告")
        : service === "obsidian"
          ? tx("obsidian_batch_complete", "Obsidian batch sync complete", "Obsidian 批量同步完成")
          : tx("notion_sync_success_title", "Synced to Notion", "已成功同步到 Notion");
    description.textContent = failed
      ? tx("obsidian_batch_all_failed", "No conversations could be synced.", "没有会话同步成功。")
      : `${tx("content_batch_success_failure", "Success: $1, failed: $2", "成功：$1，失败：$2", successCount, failureCount)}. ${service === "obsidian"
        ? tx("obsidian_batch_complete_desc", "Open any saved note below.", "可点击下方任意笔记打开。")
        : tx("notion_sync_success_desc", "Open any saved page below.", "可点击下方任意页面打开。")}`;
    mark.textContent = failed ? "×" : partial ? "!" : "✓";
    mark.dataset.status = failed ? "failed" : partial ? "partial" : "succeeded";
    itemsContainer.replaceChildren();

    (result.items || []).forEach((item) => {
      const canOpen = service === "notion" ? Boolean(normalizeNotionPageUrl(item.url)) : Boolean(item.canOpen && item.vaultName && item.noteRelativePath);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cv-batch-result-item";
      button.disabled = !canOpen;
      button.dataset.service = service;
      if (service === "notion") button.dataset.url = normalizeNotionPageUrl(item.url);
      else {
        button.dataset.vaultName = String(item.vaultName || "");
        button.dataset.notePath = String(item.noteRelativePath || "");
      }
      const serviceLabel = document.createElement("span");
      serviceLabel.textContent = service === "obsidian"
        ? tx("obsidian_open_note", "Open in Obsidian", "在 Obsidian 中打开")
        : tx("notion_open_page", "Open Notion page", "打开 Notion 页面");
      const itemTitle = document.createElement("strong");
      itemTitle.textContent = String(item.title || tx("notion_untitled_conversation", "Untitled conversation", "未命名会话"));
      const arrow = document.createElement("b");
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = canOpen ? "→" : "";
      button.append(serviceLabel, itemTitle, arrow);
      itemsContainer.appendChild(button);
    });

    overlay.classList.add("active");
    overlay.setAttribute("aria-hidden", "false");
    lastBatchSyncResultDialogId = resultId;
    shadowRoot.getElementById("cv-batch-result-close")?.focus();
  }

  function showObsidianResultDialog(result) {
    if (!shadowRoot || !result) return;
    const resultId = String(result.id || result.jobId || result.batchId || `${result.status}:${result.noteRelativePath || ""}`);
    if (resultId && resultId === lastObsidianSuccessDialogId) return;
    const overlay = shadowRoot.getElementById("cv-obsidian-result-overlay");
    const title = shadowRoot.getElementById("cv-obsidian-result-title");
    const description = shadowRoot.getElementById("cv-obsidian-result-description");
    const open = shadowRoot.getElementById("cv-obsidian-result-open");
    const documentTitle = shadowRoot.getElementById("cv-obsidian-result-document-title");
    const mark = shadowRoot.getElementById("cv-obsidian-result-mark");
    if (!overlay || !open) return;

    const failed = result.status === "failed";
    const partial = result.status === "partial" || Number(result.failureCount || 0) > 0 || Number(result.warningCount || 0) > 0;
    const isBatch = Boolean(result.batchId || Number(result.total || 0) > 1);

    if (mark) {
      mark.textContent = failed ? "×" : partial ? "!" : "✓";
      mark.dataset.status = failed ? "failed" : partial ? "partial" : "succeeded";
    }

    if (title) {
      title.textContent = failed
        ? tx("obsidian_sync_failed_title", "Obsidian sync failed", "同步到 Obsidian 失败")
        : partial
          ? tx("obsidian_sync_partial_title", "Obsidian sync completed with warnings", "Obsidian 同步完成，但有部分警告")
          : isBatch
            ? tx("obsidian_batch_complete", "Obsidian batch sync complete", "Obsidian 批量同步完成")
            : tx("obsidian_sync_complete", "Synced to Obsidian", "已成功同步到 Obsidian");
    }
    if (description) {
      description.hidden = false;
      description.textContent = failed
        ? String(result.error || tx("obsidian_sync_failed_desc", "No note was created. Check Vault access and try again.", "未创建笔记，请检查 Vault 权限后重试。"))
        : partial
          ? tx("obsidian_sync_partial_desc", "The note was created successfully. Open it to review any content that could not be preserved exactly.", "Obsidian 笔记已成功创建，请打开检查未能完全保留的内容。")
          : tx("obsidian_sync_complete_desc", "This conversation is ready in your Obsidian Vault.", "当前对话已写入你选择的 Obsidian Vault。");
    }

    const notePath = String(result.noteRelativePath || "");
    const vaultName = String(result.vaultName || "");
    if (documentTitle) documentTitle.textContent = String(result.title || notePath.replace(/^.*\//, "").replace(/\.md$/i, "") || tx("notion_untitled_conversation", "Untitled conversation", "未命名会话"));
    open.hidden = !notePath || !vaultName || failed || result.canOpenInObsidian === false;
    open.dataset.notePath = notePath;
    open.dataset.vaultName = vaultName;
    overlay.classList.add("active");
    overlay.setAttribute("aria-hidden", "false");
    lastObsidianSuccessDialogId = resultId;
    shadowRoot.getElementById("cv-obsidian-result-close")?.focus();
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
  async function performExport(options = {}) {
    const formatForExport = activeFormat || "pdf";
    const copyToClipboard = options.copyToClipboard === true && formatForExport === "json" && !globalThis.CHATVAULT_IS_BATCH_EXPORT;
    const requestSettings = options.settings && typeof options.settings === "object"
      ? options.settings
      : null;
    const platformForExport = exporter.detectPlatform();
    const isSelectedExport = exportSettings.mode === "selected";

    if (!platformForExport) {
      showPageToast(t("toast_no_open_chat", isChineseUi() ? "请在支持的 AI 对话页打开并加载聊天内容后再导出。" : "Open a ChatGPT, Claude, or Gemini conversation to export."));
      return;
    }

    // A direct export request carries the freshest popup state. Do not let an
    // older asynchronous storage snapshot overwrite it before rendering.
    if (!requestSettings) {
      await loadPersistedExportSettings();
    }
    const presetForExport = currentPreset;
    const settingsForExport = requestSettings
      ? { ...exportSettings, ...requestSettings }
      : { ...exportSettings };
    const controller = new AbortController();
    abortController = controller;
    const signal = controller.signal;
    const isSingleExport = !globalThis.CHATVAULT_IS_BATCH_EXPORT;
    let serverConsumedExportUsage = false;

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

    const localEntitlementPreflight = getLocalExportAccessResult(1);
    const entitlementIssue = getEntitlementIssue(settingsForExport, presetForExport, currentUserProfile, formatForExport);

    if (isSingleExport) {
      renderExportProgress(formatForExport, {
        mode: "single",
        title: getSingleExportProgressTitle(formatForExport),
        message: tx("content_progress_checking_export_access", "Preparing export...", "正在准备导出..."),
        progress: EXPORT_PROGRESS_INITIAL,
        overallProgress: EXPORT_PROGRESS_INITIAL
      }, cancelExport);
    }

    await loadState({ localOnly: true, skipVerify: true });
    if (isCurrentExportCancelled()) return;
    const entitlementPreflight = await verifySignedInExportAccess(1);
    if (isCurrentExportCancelled()) return;
    if (!entitlementPreflight.ok) {
      hideExportProgress();
      clearCurrentExportController();
      showPageToast(entitlementPreflight.error || tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。"));
      return;
    }
    if (!entitlementPreflight.allowed) {
      hideExportProgress();
      clearCurrentExportController();
      showUpgradePrompt(FREE_QUOTA_EXHAUSTED_MESSAGE);
      return;
    }
    if (hasKnownExhaustedFreeQuota()) {
      hideExportProgress();
      clearCurrentExportController();
      showUpgradePrompt(FREE_QUOTA_EXHAUSTED_MESSAGE);
      return;
    }

    const remaining = entitlements.getRemainingFreeExports(currentUserProfile, dailyUsage);
    if (!isProUser && remaining <= 0) {
      hideExportProgress();
      clearCurrentExportController();
      showUpgradePrompt(FREE_QUOTA_EXHAUSTED_MESSAGE);
      return;
    }

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
        message: tx("content_progress_initializing", "Exporting...", "正在导出..."),
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

    const pageParseOptions = { includeHtmlStyles: formatForExport === "html" };
    const pageMessagesForExport = isSelectedExport && typeof exporter.getSelectedMessages === "function"
      ? exporter.getSelectedMessages(pageParseOptions)
      : parseCurrentChatMessages(pageParseOptions);
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
        rawMessagesForExport = await getCurrentConversationMessagesForExport(pageMessagesForExport, {
          preserveHtmlPresentation: formatForExport === "html",
          preserveMarkdownSemantics: formatForExport === "markdown"
        });
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
    let exportProgressNotice = "";
    let exportProgressNoticeSeverity = "";
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
        exportStats: exportStatsForProgress,
        notice: exportProgressNotice,
        noticeSeverity: exportProgressNoticeSeverity
      });
      reportBatchItemProgress(safePercent, message);
    }

    setExportProgress(tx("content_progress_initializing", "Exporting...", "正在导出..."), EXPORT_PROGRESS_INITIAL * 100);

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
          imageLimits: exporter.IMAGE_LIMITS,
          parseStats: typeof exporter.getParseStats === "function" ? exporter.getParseStats() : null
        });
        const progressIssues = (health.issues || []).filter(
          (issue) => issue && issue.id !== "empty_conversation" && issue.message
        );
        const blockingIssues = progressIssues.filter((issue) => issue.severity === "high_risk");
        if (progressIssues.length > 0) {
          exportProgressNotice = progressIssues.map((issue) => issue.message).join("\n");
          exportProgressNoticeSeverity = blockingIssues.length > 0 ? "high_risk" : "attention";
          setExportProgress(
            blockingIssues.length > 0
              ? t("popup_health_high_risk", "High Risk Issues")
              : tx("content_progress_formatting", "Applying export formatting...", "正在应用导出格式..."),
            16
          );
        }
        if (blockingIssues.length > 0) {
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
        {
          exportStats: exportStatsForProgress,
          notice: exportProgressNotice,
          noticeSeverity: exportProgressNoticeSeverity
        }
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

      if (!isProUser && currentSession?.access_token) {
        setExportProgress(tx("content_progress_checking_export_access", "Preparing export...", "正在准备导出..."), 90);
        const entitlementVerification = await syncVerifiedExportEntitlement(1, { consume: true });
        if (!entitlementVerification.ok) {
          throw new Error(entitlementVerification.error || tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。"));
        }
        if (!entitlementVerification.allowed) {
          hideExportProgress();
          clearCurrentExportController();
          showUpgradePrompt(FREE_QUOTA_EXHAUSTED_MESSAGE);
          return;
        }
        serverConsumedExportUsage = Boolean(entitlementVerification.serverConsumed);
      }

      // 7. 保存导出文件
      setExportProgress(tx("content_progress_downloading", "Preparing safe download...", "正在准备安全下载..."), 94);

      if (signal.aborted) {
        throw new Error("Export cancelled.");
      }

      if (!globalThis.CHATVAULT_IS_BATCH_EXPORT && !copyToClipboard) {
        suppressSingleProgressAfterSaveDialog = true;
        hideExportProgress();
      }

      let saveResult;
      if (copyToClipboard) {
        setExportProgress(tx("content_progress_copying_json", "Copying JSON...", "正在复制 JSON..."), 96);
        const jsonText = typeof blobResult.blob.text === "function"
          ? await blobResult.blob.text()
          : new TextDecoder().decode(await blobResult.blob.arrayBuffer());
        await writeTextToClipboard(jsonText);
        saveResult = { ok: true, copied: true, filename: blobResult.filename };
        suppressSingleProgressAfterSaveDialog = true;
        hideExportProgress();
      } else {
        saveResult = await exporter.saveBlob(blobResult.blob, blobResult.filename, {
          saveAs: settingsForExport.saveAs !== false
        });
      }

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
        await recordSuccessfulExportUsage(1, { serverConsumed: serverConsumedExportUsage });
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
      if (copyToClipboard) {
        showPageToast(tx("content_json_copied", "JSON copied to clipboard.", "JSON 已复制到剪贴板。"));
      }
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
    if (activeNotionJobId) {
      const jobId = activeNotionJobId;
      activeNotionJobId = "";
      chrome.runtime.sendMessage({ type: "CHATVAULT_NOTION_CANCEL_JOB", jobId }, () => void chrome.runtime.lastError);
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

  async function prepareSingleObsidianSync() {
    if (activeObsidianSingleSync || globalThis.CHATVAULT_IS_BATCH_EXPORT) {
      throw new Error(tx("obsidian_sync_running", "An Obsidian sync is already running in this tab.", "当前标签页已有 Obsidian 同步任务运行。"));
    }
    await loadState({ localOnly: true, skipVerify: true });
    const coordinator = await loadObsidianCoordinator();
    const status = await coordinator.getObsidianStatus();
    if (!status.connected) throw new Error(tx("obsidian_connect_first", "Connect an Obsidian Vault first.", "请先连接 Obsidian Vault。"));
    if (status.permission !== "granted") throw new Error(tx("obsidian_reauthorize_first", "Reauthorize the Obsidian Vault first.", "请先重新授权 Obsidian Vault。"));
    if (status.directoriesValid === false) throw new Error(tx("obsidian_repair_folders", "Repair the configured Obsidian folders first.", "请先修复 Obsidian 配置目录。"));
    if (status.activeJob) throw new Error(tx("obsidian_job_running", "Another Obsidian sync is already running.", "已有 Obsidian 同步任务正在运行。"));
    const selectionMode = Boolean(document.querySelector(".cv-export-checkbox-wrapper") || shadowRoot?.getElementById("selection-bar")?.classList.contains("active"));
    const selectedCount = typeof exporter.getSelectedCount === "function" ? exporter.getSelectedCount() : 0;
    if (selectionMode && selectedCount < 1) {
      throw new Error(tx("obsidian_select_message_first", "Select at least one message before syncing.", "请先选择至少一条消息后再同步。"));
    }
    if (!getLocalFreeQuotaAllowed(1) || hasKnownExhaustedFreeQuota()) {
      throw new Error(FREE_QUOTA_EXHAUSTED_MESSAGE);
    }
    const entitlement = await verifySignedInExportAccess(1);
    if (!entitlement.ok) throw new Error(entitlement.error || tx("content_entitlement_verify_failed", "Could not verify your export entitlement.", "无法验证导出权益。"));
    if (!entitlement.allowed) throw new Error(FREE_QUOTA_EXHAUSTED_MESSAGE);
    return { coordinator, status, selectionMode, selectedCount };
  }

  async function runSingleObsidianSync(config, preflight) {
    activeObsidianSingleSync = true;
    const controller = new AbortController();
    abortController = controller;
    const signal = controller.signal;
    const settings = config?.settings && typeof config.settings === "object" ? config.settings : {};
    let serverConsumedUsage = false;

    try {
      const selectedCount = Math.max(0, Number(preflight.selectedCount || 0));
      const scope = preflight.selectionMode ? "selected" : "conversation";
      renderExportProgress("obsidian", {
        mode: "single",
        title: tx("obsidian_sync_progress_title", "Syncing to Obsidian", "正在同步到 Obsidian"),
        message: scope === "selected"
          ? tx("obsidian_getting_selected", "Getting selected messages...", "正在获取已选消息...")
          : tx("obsidian_getting_conversation", "Getting complete conversation...", "正在获取完整会话..."),
        progress: 0.06,
        overallProgress: 0.06
      }, cancelExport);

      const pageMessages = scope === "selected"
        ? exporter.getSelectedMessages()
        : parseCurrentChatMessages();
      if (!pageMessages?.length) {
        throw new Error(scope === "selected"
          ? tx("content_select_one_before_export", "Select at least one message before syncing.", "请先选择至少一条消息后再同步。")
          : tx("obsidian_sync_no_messages", "No conversation messages were found on this page.", "当前页面没有找到可同步的会话消息。"));
      }

      let messages = pageMessages;
      const captureWarnings = [];
      if (scope === "conversation") {
        try {
          messages = await getCurrentConversationMessagesForExport(pageMessages, { preserveMarkdownSemantics: true });
        } catch (error) {
          console.warn("Full conversation fetch failed before Obsidian sync, using parsed page messages:", error);
          messages = pageMessages;
          captureWarnings.push({
            code: "conversation_fetch_partial",
            detail: tx("obsidian_visible_content_fallback", "The complete conversation was unavailable; visible page content was used.", "完整会话获取失败，已使用页面可见内容。")
          });
        }
      }
      if (signal.aborted) throw new DOMException("Sync cancelled.", "AbortError");

      const result = await preflight.coordinator.syncConversationToObsidian({
        status: preflight.status,
        title: exporter.getConversationTitle(),
        sourceUrl: sanitizeSourceUrl(window.location.href),
        messages,
        platform: exporter.detectPlatform(),
        platformLabel: getPlatformLabel(exporter.detectPlatform()),
        userLabel: t("export_role_user", "You Asked"),
        scope,
        selectedCount: scope === "selected" ? selectedCount : undefined,
        settings,
        warnings: captureWarnings,
        signal,
        beforeFinalize: !isProUser && currentSession?.access_token ? async () => {
          const entitlement = await syncVerifiedExportEntitlement(1, { consume: true });
          serverConsumedUsage = Boolean(entitlement.ok && entitlement.allowed && entitlement.serverConsumed);
          if (!entitlement.ok || !entitlement.allowed) {
            throw new Error(FREE_QUOTA_EXHAUSTED_MESSAGE);
          }
        } : null,
        onProgress: (info) => {
          const messagesByPhase = {
            preflight: tx("obsidian_checking_vault", "Checking Vault access...", "正在检查 Vault..."),
            media: info?.detail || tx("obsidian_processing_media", "Processing images...", "正在处理图片..."),
            render: tx("obsidian_rendering", "Building Obsidian Markdown...", "正在生成 Obsidian Markdown..."),
            write: tx("obsidian_writing", "Writing note to Vault...", "正在写入 Vault..."),
            complete: tx("obsidian_finishing", "Finishing sync...", "正在完成同步...")
          };
          renderExportProgress("obsidian", {
            mode: "single",
            title: tx("obsidian_sync_progress_title", "Syncing to Obsidian", "正在同步到 Obsidian"),
            message: messagesByPhase[info?.phase] || info?.detail || "",
            progress: Number(info?.progress || 0),
            overallProgress: Number(info?.progress || 0)
          }, info?.phase === "complete" ? null : cancelExport);
        }
      });

      if (!isProUser) {
        await recordSuccessfulExportUsage(1, { serverConsumed: serverConsumedUsage });
        updateUIState();
      }
      if (scope === "selected") {
        exporter.exitSelectionMode();
        shadowRoot?.getElementById("selection-bar")?.classList.remove("active");
      }
      hideExportProgress();
      showObsidianResultDialog(result);
      globalThis.CHATVAULT_ANALYTICS?.track("export_success", {
        platform: exporter.detectPlatform(),
        properties: { format: "obsidian", source: "current_chat", scope }
      });
    } catch (error) {
      hideExportProgress();
      if (signal.aborted || error?.name === "AbortError") {
        showPageToast(tx("obsidian_sync_cancelled", "Obsidian sync cancelled.", "Obsidian 同步已取消。"));
      } else {
        showPageToast(tx("obsidian_sync_failed", "Obsidian sync failed: $1", "Obsidian 同步失败：$1", error?.message || "Obsidian sync failed."));
        globalThis.CHATVAULT_ANALYTICS?.track("export_failed", {
          platform: exporter.detectPlatform(),
          properties: { format: "obsidian", source: "current_chat", error_category: error?.code || "sync" }
        });
      }
    } finally {
      activeObsidianSingleSync = false;
      if (abortController === controller) abortController = null;
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
            await auth?.clearSession?.();
          } catch (error) {}
          try {
            await entitlements?.clearCachedState?.();
          } catch (error) {}
          try {
            await new Promise((resolve) => chrome.storage.local.remove([
              NOTION_UI_CACHE_KEY,
              "notion_selected_connection_id",
              "notion_selected_data_sources"
            ], resolve));
          } catch (error) {}
          batchNotionConfig = {
            mode: "unlinked",
            connections: [],
            dataSources: [],
            connectionId: "",
            dataSourceId: "",
            databaseId: ""
          };
          currentSession = null;
          currentUserProfile = null;
          isProUser = false;
          updateUIState();
          renderBatchNotionDestination();
          sendResponse({ ok: true });
        })();
        return true;
      }

      // 2. 为 Popup 提供最新的运行状态数据
      if (message.type === "CHATVAULT_GET_POPUP_STATE") {
        (async () => {
          try {
            // 使用缓存快速响应 popup，服务端 entitlement 在响应后异步刷新。
            if (!message.forceRefresh && _popupStateCache) {
              const popupStateCacheSnapshot = await getPopupStateCacheSnapshot();
              // 缓存命中，但 lastReceipt 和 exportSettings 需实时更新
              sendResponse({
                ...popupStateCacheSnapshot,
                exportSettings: exportSettings,
                lastReceipt: lastReceipt
              });
              if (currentSession?.access_token) {
                refreshAuthStateInBackground();
              }
              return;
            }

            await loadState({ forceRefresh: !!message.forceRefresh, localOnly: !message.forceRefresh, skipVerify: !message.forceRefresh });
            const rawMessages = parseCurrentChatMessages();
            const mode = exportSettings.export_ai_replies_only ? "ai_only" : "conversation";
            const platform = exporter.detectPlatform();
            
            const transformed = templatePresets.transformMessages(rawMessages, mode, exportSettings);
            const health = exportHealth.checkHealth({
              messages: transformed,
              format: activeFormat || "pdf",
              mode,
              platform,
              imageLimits: exporter.IMAGE_LIMITS,
              parseStats: typeof exporter.getParseStats === "function" ? exporter.getParseStats() : null
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

            updateUIState();

            sendResponse(stateSnapshot);
            if (!message.forceRefresh && currentSession?.access_token) {
              refreshAuthStateInBackground();
            }
          } catch (e) {
            console.error("Error in CHATVAULT_GET_POPUP_STATE:", e);
            sendResponse({ ok: false, error: e.message });
          }
        })();
        return true;
      }

      if (message.type === "CHATVAULT_OBSIDIAN_SELECTION_STATUS") {
        const selectionMode = Boolean(document.querySelector(".cv-export-checkbox-wrapper") || shadowRoot?.getElementById("selection-bar")?.classList.contains("active"));
        sendResponse({
          ok: true,
          selectionMode,
          selectedCount: typeof exporter.getSelectedCount === "function" ? exporter.getSelectedCount() : 0,
          syncRunning: activeObsidianSingleSync || (globalThis.CHATVAULT_IS_BATCH_EXPORT && batchMode === "obsidian")
        });
        return false;
      }

      if (message.type === "CHATVAULT_POPUP_OBSIDIAN_SYNC") {
        (async () => {
          let started = false;
          try {
            await waitForContextExportReady();
            const preflight = await prepareSingleObsidianSync();
            if (message.config?.settings && typeof message.config.settings === "object") {
              exportSettings = { ...exportSettings, ...message.config.settings };
              persistExportSettings();
            }
            started = true;
            sendResponse({ ok: true, syncStarted: true });
            await runSingleObsidianSync({ ...message.config, settings: { ...exportSettings, ...(message.config?.settings || {}) } }, preflight);
          } catch (error) {
            if (!started) {
              if (error?.message === FREE_QUOTA_EXHAUSTED_MESSAGE) showUpgradePrompt(FREE_QUOTA_EXHAUSTED_MESSAGE);
              sendResponse({ ok: false, error: error?.message || tx("obsidian_sync_failed", "Obsidian sync could not start.", "无法开始 Obsidian 同步。") });
            }
          }
        })();
        return true;
      }

      if (message.type === "CHATVAULT_NOTION_JOB_STATUS" && message.job) {
        const job = message.job;
        if (handleNotionBatchJobStatus(job)) {
          sendResponse({ ok: true });
          return false;
        }
        if (job.batchId) {
          sendResponse({ ok: true });
          return false;
        }
        const isActiveSingleJob = activeNotionJobId && String(job.id || "") === activeNotionJobId;
        if (isActiveSingleJob && ["held", "pending", "running", "retry_wait"].includes(job.status)) {
          const rawJobProgress = Number(job.progress || 0) > 1 ? Number(job.progress || 0) / 100 : Number(job.progress || 0);
          const progress = Math.max(0.35, Math.min(0.94, 0.35 + rawJobProgress * 0.59));
          renderExportProgress("notion", {
            mode: "single",
            title: tx("notion_sync_progress_title", "Syncing to Notion", "正在同步到 Notion"),
            message: job.status === "retry_wait"
              ? tx("notion_sync_retrying", "Notion is busy. Retrying safely...", "Notion 当前繁忙，正在安全重试...")
              : tx("notion_sync_writing", "Writing conversation to Notion...", "正在将会话写入 Notion..."),
            progress,
            overallProgress: progress
          }, cancelExport);
        }
        if (job.status === "succeeded" || job.status === "partial") {
          if (isActiveSingleJob) {
            activeNotionJobId = "";
            hideExportProgress();
          }
          showNotionSuccessDialog(job);
        } else if (job.status === "failed") {
          if (isActiveSingleJob) {
            activeNotionJobId = "";
            hideExportProgress();
          }
          showPageToast(tx("notion_sync_failed", "Notion sync failed: $1", "Notion 同步失败：$1", job.errorMessage || job.errorCode));
        } else if (job.status === "cancelled" && isActiveSingleJob) {
          activeNotionJobId = "";
          hideExportProgress();
          showPageToast(tx("notion_sync_cancelled", "Sync cancelled.", "同步已取消。"));
        }
        sendResponse({ ok: true });
        return false;
      }

      // 2.5 处理 Popup 发起的 Notion 同步
      if (message.type === "CHATVAULT_POPUP_NOTION_SYNC") {
        (async () => {
          let syncStarted = false;
          let enqueueResult = null;
          let notionJobReleased = false;
          let notionSyncController = null;
          try {
            await waitForContextExportReady();
            notionSyncController = new AbortController();
            abortController = notionSyncController;
            const signal = notionSyncController.signal;
            syncStarted = true;
            sendResponse({ ok: true, syncStarted: true });

            renderExportProgress("notion", {
              mode: "single",
              title: tx("notion_sync_progress_title", "Syncing to Notion", "正在同步到 Notion"),
              message: tx("notion_sync_preparing", "Preparing conversation...", "正在准备会话..."),
              progress: 0.1,
              overallProgress: 0.1
            }, cancelExport);

            const platformForSync = exporter.detectPlatform();
            // Notion needs the live DOM presentation for syntax-token colors and
            // rendered math source. This is scoped to Notion and does not alter
            // the parsing path used by PDF, Markdown, HTML, TXT, or JSON exports.
            const pageParseOptions = { includeHtmlStyles: true };
            const pageMessagesForSync = parseCurrentChatMessages(pageParseOptions);
            if (!pageMessagesForSync.length) {
              throw new Error(tx("notion_sync_no_messages", "No conversation messages were found on this page.", "当前页面没有找到可同步的会话消息。"));
            }
            let rawMessagesForSync = pageMessagesForSync;
            const notionCaptureWarnings = [];

            if (platformForSync && pageMessagesForSync.length > 0) {
              try {
                rawMessagesForSync = await getCurrentConversationMessagesForExport(pageMessagesForSync, {
                  preserveHtmlPresentation: true,
                  preserveMarkdownSemantics: true
                });
              } catch (e) {
                console.warn("Full conversation fetch failed before sync, using parsed page messages:", e);
                rawMessagesForSync = pageMessagesForSync;
                notionCaptureWarnings.push({
                  code: "conversation_fetch_partial",
                  detail: "The complete conversation API was unavailable; visible page content was used."
                });
              }
            }
            if (signal.aborted) throw new Error("Sync cancelled.");

            const title = exporter.getConversationTitle();
            const sourceUrl = sanitizeSourceUrl(window.location.href);

            const snapshot = await globalThis.CHATVAULT_EXPORT.prepareNotionJob({
              title,
              sourceUrl,
              messages: rawMessagesForSync,
              platform: platformForSync,
              model: message.config.model || "",
              userId: currentSession?.user?.id || "guest",
              connectionId: message.config.connectionId,
              databaseId: message.config.databaseId,
              dataSourceId: message.config.dataSourceId,
              alwaysCreate: true,
              settings: message.config.settings || {},
              warnings: notionCaptureWarnings,
              signal,
              onMediaProgress: (info) => {
                if (signal.aborted) throw new Error("Sync cancelled.");
                const total = Math.max(1, Number(info.total || 0));
                const progress = 0.15 + Math.min(0.2, Number(info.completed || 0) / total * 0.2);
                renderExportProgress("notion", {
                  mode: "single",
                  title: tx("notion_sync_progress_title", "Syncing to Notion", "正在同步到 Notion"),
                  message: tx("notion_sync_capturing_media", "Capturing conversation media...", "正在采集会话图片..."),
                  progress,
                  overallProgress: progress
                }, cancelExport);
              }
            });

            enqueueResult = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage({
                type: "CHATVAULT_NOTION_ENQUEUE",
                snapshot,
                deferStart: true
              }, (response) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) return reject(new Error(lastError.message));
                if (!response || !response.ok) return reject(new Error(response?.error || "Could not enqueue Notion sync."));
                resolve(response);
              });
            });
            activeNotionJobId = String(enqueueResult.job?.id || "");

            const shouldConsumeUsage = !enqueueResult.job?.deduplicated;
            let serverConsumedNotionUsage = false;
            if (shouldConsumeUsage && !isProUser && currentSession?.access_token) {
              const entitlementVerification = await syncVerifiedExportEntitlement(1, { consume: true });
              if (!entitlementVerification.ok) {
                throw new Error(entitlementVerification.error || tx("content_entitlement_verify_failed", "Could not verify your export entitlement. Check your connection and try again.", "无法验证您的导出权益，请检查网络后重试。"));
              }
              if (!entitlementVerification.allowed) {
                showUpgradePrompt(FREE_QUOTA_EXHAUSTED_MESSAGE);
                throw new Error(tx("popup_free_quota_exhausted", "You have used today's 3 free exports.", "今日免费导出次数已用完。"));
              }
              serverConsumedNotionUsage = Boolean(entitlementVerification.serverConsumed);
            }

            await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage({
                type: "CHATVAULT_NOTION_RELEASE_JOB",
                jobId: enqueueResult.job.id
              }, (response) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) return reject(new Error(lastError.message));
                if (!response || !response.ok) return reject(new Error(response?.error || "Could not start Notion sync."));
                resolve(response);
              });
            });
            notionJobReleased = true;

            if (shouldConsumeUsage && !isProUser) {
              await recordSuccessfulExportUsage(1, { serverConsumed: serverConsumedNotionUsage });
              updateUIState();
            }

            renderExportProgress("notion", {
              mode: "single",
              title: tx("notion_sync_progress_title", "Syncing to Notion", "正在同步到 Notion"),
              message: tx("notion_sync_writing", "Writing conversation to Notion...", "正在将会话写入 Notion..."),
              progress: 0.35,
              overallProgress: 0.35
            }, cancelExport);

            chrome.runtime.sendMessage({
              type: "CHATVAULT_NOTION_SYNC_STATUS",
              status: "queued",
              job: enqueueResult.job
            });

          } catch (error) {
            if (!syncStarted) {
              sendResponse({
                ok: false,
                error: error?.message || tx("notion_sync_failed", "Notion sync could not start.", "无法开始 Notion 同步。")
              });
              return;
            }
            if (enqueueResult?.job?.id && !notionJobReleased && !enqueueResult.job.deduplicated) {
              try {
                await chrome.runtime.sendMessage({
                  type: "CHATVAULT_NOTION_CANCEL_JOB",
                  jobId: enqueueResult.job.id
                });
              } catch (_cancelError) {}
            }
            hideExportProgress();
            activeNotionJobId = "";
            if (error.message !== "Sync cancelled.") {
              console.error("Notion sync failed:", error);
              showPageToast(tx("notion_sync_failed", "Notion sync failed: $1", "同步至 Notion 失败：$1", error.message));
              chrome.runtime.sendMessage({
                type: "CHATVAULT_NOTION_SYNC_STATUS",
                status: "error",
                error: error.message
              });
            } else {
              showPageToast(tx("notion_sync_cancelled", "Sync cancelled.", "同步已取消。"));
            }
          } finally {
            if (notionSyncController && abortController === notionSyncController) {
              abortController = null;
            }
          }
        })();
        return true;
      }

      // 3. 处理 Popup 发起的导出
      if (message.type === "CHATVAULT_POPUP_EXPORT") {
        (async () => {
          let exportStarted = false;
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
            // Confirm that the in-page exporter has taken over before closing
            // the browser popup. The export continues independently while the
            // page-level progress UI remains available.
            exportStarted = true;
            sendResponse({ ok: true, exportStarted: true });
            await performExport({
              copyToClipboard: message.copyToClipboard === true,
              settings: message.settings
            });
            await loadState({ localOnly: true, skipVerify: true });
          } catch (error) {
            if (!exportStarted) {
              sendResponse({
                ok: false,
                error: error?.message || tx("content_export_failed_message", "Export failed.", "导出失败。")
              });
              return;
            }
            console.error("Popup export failed after it started:", error);
            showPageToast(error?.message || tx("content_export_failed_message", "Export failed.", "导出失败。"));
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
            showPageToast(t("popup_login_failed", isChineseUi() ? "登录失败：$1" : "Sign-in failed: $1", messageText));
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
            if (message.preferredMode === "obsidian") setBatchMode("obsidian");
            else if (message.preferredMode === "notion") setBatchMode("notion");
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
