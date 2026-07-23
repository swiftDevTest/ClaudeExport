(function initChatVaultEntitlements() {
  const DEFAULT_FREE_LIMITS = Object.freeze({
    maxExports: 3,
    maxExportsPerDay: 3
  });
  const PRO_LIMIT = 999999;
  const productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  const storageKey = typeof productConfig.storageKey === "function"
    ? productConfig.storageKey
    : (name) => `chatvault_exporter.${name}`;
  const ENTITLEMENT_STATE_CACHE_KEY = storageKey("entitlement_state.v1");
  const ENTITLEMENT_STATE_CACHE_CRYPTO_VERSION = 1;
  const ENTITLEMENT_STATE_CACHE_CRYPTO_ALG = "AES-GCM";
  const ENTITLEMENT_STATE_CACHE_KEY_ID = `${productConfig.storageNamespace || "chatvault_exporter"}-entitlement-cache-v1`;
  const ENTITLEMENT_CACHE_TTL_MS = 5 * 60 * 1000;
  let entitlementCacheCryptoKeyPromise = null;

  const PRO_PRICES = Object.freeze({
    monthly: { sku: "pro_monthly", label: "Pro Monthly", price: "$3.99", cadence: "/ month" },
    yearly: { sku: "pro_yearly", label: "Pro Yearly", price: "$24.99", cadence: "/ year" },
    lifetime: { sku: "pro_lifetime", label: "Lifetime Early Bird", price: "$39.99", cadence: "one-time" }
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
      id: profile?.id || profile?.user_id || "",
      email: profile?.email || "",
      product_slug: profile?.product_slug || productConfig.productSlug || "ai-chat-export",
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
    if (!styleId || styleId === "default" || styleId === "natural") {
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

  function getRuntimeId() {
    try {
      return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id
        ? chrome.runtime.id
        : "dev";
    } catch (error) {
      return "dev";
    }
  }

  function getCacheCrypto() {
    try {
      return typeof globalThis.crypto !== "undefined" &&
        globalThis.crypto &&
        globalThis.crypto.subtle &&
        typeof globalThis.crypto.getRandomValues === "function"
        ? globalThis.crypto
        : null;
    } catch (error) {
      return null;
    }
  }

  function bytesToBase64(bytes) {
    if (typeof btoa === "function") {
      let binary = "";
      for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]);
      }
      return btoa(binary);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString("base64");
    }
    return "";
  }

  function base64ToBytes(value) {
    if (!value || typeof value !== "string") {
      return null;
    }
    try {
      if (typeof atob === "function") {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      }
      if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(value, "base64"));
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function isEncryptedCachedEntitlementState(value) {
    return !!(value &&
      typeof value === "object" &&
      value.v === ENTITLEMENT_STATE_CACHE_CRYPTO_VERSION &&
      value.alg === ENTITLEMENT_STATE_CACHE_CRYPTO_ALG &&
      value.kid === ENTITLEMENT_STATE_CACHE_KEY_ID &&
      typeof value.iv === "string" &&
      typeof value.payload === "string");
  }

  async function getEntitlementCacheCryptoKey() {
    const cryptoRef = getCacheCrypto();
    if (!cryptoRef || typeof TextEncoder !== "function") {
      return null;
    }
    if (!entitlementCacheCryptoKeyPromise) {
      const keySeed = `${ENTITLEMENT_STATE_CACHE_KEY_ID}:${getRuntimeId()}`;
      entitlementCacheCryptoKeyPromise = cryptoRef.subtle
        .digest("SHA-256", new TextEncoder().encode(keySeed))
        .then((digest) => cryptoRef.subtle.importKey("raw", digest, ENTITLEMENT_STATE_CACHE_CRYPTO_ALG, false, ["encrypt", "decrypt"]))
        .catch(() => null);
    }
    return entitlementCacheCryptoKeyPromise;
  }

  async function encryptCachedEntitlementState(snapshot) {
    const cryptoRef = getCacheCrypto();
    const key = await getEntitlementCacheCryptoKey();
    if (!cryptoRef || !key || typeof TextEncoder !== "function") {
      return snapshot;
    }

    try {
      const iv = cryptoRef.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
      const encrypted = await cryptoRef.subtle.encrypt({ name: ENTITLEMENT_STATE_CACHE_CRYPTO_ALG, iv }, key, encoded);
      return {
        v: ENTITLEMENT_STATE_CACHE_CRYPTO_VERSION,
        alg: ENTITLEMENT_STATE_CACHE_CRYPTO_ALG,
        kid: ENTITLEMENT_STATE_CACHE_KEY_ID,
        iv: bytesToBase64(iv),
        payload: bytesToBase64(new Uint8Array(encrypted))
      };
    } catch (error) {
      return snapshot;
    }
  }

  async function decryptCachedEntitlementState(value) {
    // SECURITY: Reject plaintext cache entries to prevent cache poisoning (C2).
    // Only accept properly encrypted structures with valid crypto metadata.
    if (!isEncryptedCachedEntitlementState(value)) {
      return null;
    }

    const cryptoRef = getCacheCrypto();
    const key = await getEntitlementCacheCryptoKey();
    const iv = base64ToBytes(value.iv);
    const payload = base64ToBytes(value.payload);
    if (!cryptoRef || !key || !iv || !payload || typeof TextDecoder !== "function") {
      return null;
    }

    try {
      const decrypted = await cryptoRef.subtle.decrypt({ name: ENTITLEMENT_STATE_CACHE_CRYPTO_ALG, iv }, key, payload);
      return JSON.parse(new TextDecoder().decode(decrypted));
    } catch (error) {
      return null;
    }
  }

  async function readCachedEntitlementSnapshot() {
    const stored = await storageGet(ENTITLEMENT_STATE_CACHE_KEY);
    if (!stored) {
      return null;
    }
    return decryptCachedEntitlementState(stored);
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

    // Enforce TTL so stale Pro status expires and re-verifies with server (H1).
    // For Pro status, expire after TTL. For general cache (email/avatar), allow longer.
    const profile = normalizeProfile(value.profile || {});
    const isCachedPro = isPro(profile);
    if (isCachedPro && Date.now() - cachedAt > ENTITLEMENT_CACHE_TTL_MS) {
      return null;
    }

    const usage = normalizeDailyUsage(value.usage || {}, getTodayString());
    const sessionUser = getSessionUserForCache(value, profile);
    const email = profile.email || sessionUser?.email || "";
    const avatarUrl = sessionUser?.user_metadata?.avatar_url || sessionUser?.user_metadata?.picture || "";
    const remainingQuota = getRemainingFreeExports(profile, usage);

    return {
      cachedAt,
      email,
      avatarUrl,
      isProUser: isCachedPro,
      profile,
      remainingQuota,
      usage,
      session: email || sessionUser?.id ? { user: sessionUser || { id: profile.id, email, user_metadata: {} } } : null,
      sessionUser
    };
  }

  async function getCachedState() {
    const cachedState = normalizeCachedEntitlementState(await readCachedEntitlementSnapshot());
    if (!cachedState) {
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

    await storageSet(ENTITLEMENT_STATE_CACHE_KEY, await encryptCachedEntitlementState(snapshot));
    return normalizeCachedEntitlementState(snapshot);
  }

  function clearCachedState() {
    return storageRemove(ENTITLEMENT_STATE_CACHE_KEY);
  }

  globalThis.CHATVAULT_ENTITLEMENTS = {
    DEFAULT_FREE_LIMITS,
    ENTITLEMENT_STATE_CACHE_KEY,
    ENTITLEMENT_STATE_CACHE_CRYPTO_ALG,
    ENTITLEMENT_STATE_CACHE_CRYPTO_VERSION,
    ENTITLEMENT_CACHE_TTL_MS,
    PRO_LIMIT,
    PRO_PRICES,
    canUseExport,
    canUseExportStyle,
    clearCachedState,
    freeExportLimitMessage,
    getCachedState,
    getRemainingFreeExports,
    isPro,
    normalizeLimits,
    normalizeProfile,
    normalizeDailyUsage,
    saveCachedState,
    getTodayString
  };
})();
