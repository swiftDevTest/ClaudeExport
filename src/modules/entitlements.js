(function initChatVaultEntitlements() {
  const DEFAULT_FREE_LIMITS = Object.freeze({
    maxExports: 3,
    maxExportsPerDay: 3
  });
  const PRO_LIMIT = 999999;
  const ENTITLEMENT_STATE_CACHE_KEY = "chatvault_exporter_entitlement_state_v1";
  const ENTITLEMENT_STATE_CACHE_TTL_MS = 30 * 60 * 1000;

  const PRO_PRICES = Object.freeze({
    monthly: { sku: "pro_monthly", label: "Pro Monthly", price: "$4.99", cadence: "/ month" },
    yearly: { sku: "pro_yearly", label: "Pro Yearly", price: "$29.99", cadence: "/ year" },
    lifetime: { sku: "pro_lifetime", label: "Lifetime Early Bird", price: "$49.99", cadence: "one-time" }
  });

  function isPro(profile) {
    return profile?.plan === "pro";
  }

  function normalizeLimits(profile) {
    if (isPro(profile)) {
      return {
        maxExports: PRO_LIMIT,
        maxExportsPerDay: PRO_LIMIT
      };
    }

    return {
      ...DEFAULT_FREE_LIMITS,
      ...(profile?.limits && typeof profile.limits === "object" ? profile.limits : {})
    };
  }

  function normalizeProfile(profile) {
    const normalized = {
      id: profile?.id || "",
      email: profile?.email || "",
      plan: profile?.plan === "pro" ? "pro" : "free",
      feature_flags: profile?.feature_flags && typeof profile.feature_flags === "object" ? profile.feature_flags : {},
      limits: profile?.limits && typeof profile.limits === "object" ? profile.limits : {},
      updated_at: profile?.updated_at || ""
    };

    return {
      ...normalized,
      normalizedLimits: normalizeLimits(normalized)
    };
  }

  function limitLabel(limit) {
    return Number.isFinite(limit) && limit < PRO_LIMIT ? String(limit) : "more";
  }

  function getTodayString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getUsageCount(usage = {}) {
    return Math.max(0, Number(usage.exportedChats || usage.exported_chats || usage.count || usage.used || 0));
  }

  function getRemainingFreeExports(profile, usage = {}) {
    const limits = normalizeLimits(profile);
    const today = getTodayString();
    let used = 0;
    const usageDate = usage.usage_date || usage.date || "";
    if (usageDate) {
      if (usageDate === today) {
        used = getUsageCount(usage);
      }
    } else {
      used = getUsageCount(usage);
    }
    return Math.max(0, limits.maxExportsPerDay - used);
  }

  function canUseExport(profile, usage = {}, conversationCount = 1) {
    if (isPro(profile)) {
      return true;
    }
    const count = Math.max(1, Number(conversationCount) || 1);
    return getRemainingFreeExports(profile, usage) >= count;
  }

  function canUseExportStyle(profile, styleId) {
    if (!styleId || styleId === "default") {
      return true;
    }
    return isPro(profile);
  }

  function freeExportLimitMessage(profile, usage = {}, conversationCount = 1) {
    const limits = normalizeLimits(profile);
    const remaining = getRemainingFreeExports(profile, usage);
    const count = Math.max(1, Number(conversationCount) || 1);
    if (count > remaining) {
      return `This export contains ${count} chats, but Free has ${remaining} exports left today. Upgrade to Pro.`;
    }
    return `Free includes ${limitLabel(limits.maxExportsPerDay)} daily chat exports. Upgrade to Pro for unlimited exports and premium styles.`;
  }

  function normalizeDailyUsage(value, date) {
    const targetDate = date || getTodayString();
    if (!value || typeof value !== "object") {
      return { date: targetDate, exportedChats: 0 };
    }
    if (value.usage_date) {
      const usageDate = String(value.usage_date);
      if (usageDate !== targetDate) {
        return { date: targetDate, exportedChats: 0 };
      }
      return {
        date: usageDate,
        usage_date: usageDate,
        exportedChats: Math.max(0, Number(value.exportedChats || value.exported_chats || value.count || value.used || 0))
      };
    }
    if (value.date && value.date !== targetDate) {
      return { date: targetDate, exportedChats: 0 };
    }
    return {
      date: targetDate,
      exportedChats: Math.max(0, Number(value.exportedChats || value.exported_chats || value.count || value.used || 0))
    };
  }

  function getChromeLocalStorage() {
    try {
      return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (error) {
      return null;
    }
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();
      if (!storage) {
        resolve(null);
        return;
      }
      try {
        storage.get(key, (result) => {
          try {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
          } catch (error) {
            resolve(null);
            return;
          }
          resolve(result ? result[key] || null : null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();
      if (!storage) {
        resolve();
        return;
      }
      try {
        storage.set({ [key]: value }, resolve);
      } catch (error) {
        resolve();
      }
    });
  }

  function storageRemove(key) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();
      if (!storage) {
        resolve();
        return;
      }
      try {
        storage.remove(key, resolve);
      } catch (error) {
        resolve();
      }
    });
  }

  function sanitizeProfileForCache(profile) {
    const normalized = normalizeProfile(profile);
    return {
      id: normalized.id,
      email: normalized.email,
      plan: normalized.plan,
      feature_flags: normalized.feature_flags,
      limits: normalized.limits,
      updated_at: normalized.updated_at
    };
  }

  function pickUserMetadata(user) {
    const metadata = user?.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
    return {
      avatar_url: metadata.avatar_url || "",
      picture: metadata.picture || ""
    };
  }

  function getSessionUserForCache(value, profile) {
    const user = value?.session?.user || value?.user || value?.sessionUser || null;
    const metadata = pickUserMetadata(user);
    const email = user?.email || profile?.email || "";
    const id = user?.id || profile?.id || "";

    if (!email && !id && !metadata.avatar_url && !metadata.picture) {
      return null;
    }

    return {
      id,
      email,
      user_metadata: metadata
    };
  }

  function normalizeCachedEntitlementState(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const cachedAt = Number(value.cachedAt || 0);
    if (!Number.isFinite(cachedAt) || cachedAt <= 0) {
      return null;
    }

    const profile = normalizeProfile(value.profile || {});
    const usage = normalizeDailyUsage(value.usage || {}, getTodayString());
    const sessionUser = getSessionUserForCache(value, profile);
    const email = profile.email || sessionUser?.email || "";
    const avatarUrl = sessionUser?.user_metadata?.avatar_url || sessionUser?.user_metadata?.picture || "";
    const remainingQuota = getRemainingFreeExports(profile, usage);

    return {
      cachedAt,
      email,
      avatarUrl,
      isProUser: isPro(profile),
      profile,
      remainingQuota,
      usage,
      session: email || sessionUser?.id ? { user: sessionUser || { id: profile.id, email, user_metadata: {} } } : null,
      sessionUser
    };
  }

  function isCachedStateFresh(cachedState, maxAgeMs) {
    const ageLimit = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : ENTITLEMENT_STATE_CACHE_TTL_MS;
    return !!(cachedState && Date.now() - cachedState.cachedAt <= ageLimit);
  }

  async function getCachedState(options = {}) {
    const cachedState = normalizeCachedEntitlementState(await storageGet(ENTITLEMENT_STATE_CACHE_KEY));
    if (!cachedState) {
      return null;
    }
    if (!options.includeExpired && !isCachedStateFresh(cachedState, options.maxAgeMs)) {
      return null;
    }
    return cachedState;
  }

  async function saveCachedState(value = {}) {
    const profile = sanitizeProfileForCache(value.profile || {});
    const usage = normalizeDailyUsage(value.usage || {}, getTodayString());
    const snapshot = {
      cachedAt: Date.now(),
      profile,
      usage,
      sessionUser: getSessionUserForCache(value, profile)
    };

    await storageSet(ENTITLEMENT_STATE_CACHE_KEY, snapshot);
    return normalizeCachedEntitlementState(snapshot);
  }

  function clearCachedState() {
    return storageRemove(ENTITLEMENT_STATE_CACHE_KEY);
  }

  globalThis.CHATVAULT_ENTITLEMENTS = {
    DEFAULT_FREE_LIMITS,
    ENTITLEMENT_STATE_CACHE_KEY,
    ENTITLEMENT_STATE_CACHE_TTL_MS,
    PRO_LIMIT,
    PRO_PRICES,
    canUseExport,
    canUseExportStyle,
    clearCachedState,
    freeExportLimitMessage,
    getCachedState,
    getRemainingFreeExports,
    isPro,
    isCachedStateFresh,
    normalizeLimits,
    normalizeProfile,
    normalizeDailyUsage,
    saveCachedState,
    getTodayString
  };
})();
