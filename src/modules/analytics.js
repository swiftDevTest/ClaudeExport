(function initChatVaultAnalytics() {
  "use strict";

  const productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  const storageKey = typeof productConfig.storageKey === "function"
    ? productConfig.storageKey
    : (name) => `chatvault_exporter.${name}`;
  const QUEUE_KEY = storageKey("analytics.queue.v1");
  const GUEST_ID_KEY = storageKey("analytics.guest_id.v1");
  const IDENTIFY_DONE_KEY = storageKey("analytics.identify_done.v1");
  const TRACKED_ONCE_KEY = storageKey("analytics.tracked_once.v1");
  const memoryStorageFallback = new Map();

  const ALLOWED_EVENTS = new Set([
    "auth_success",
    "export_success",
    "export_failed",
    "vip_view_exposure",
    "vip_sku_click",
    "vip_signin_required",
    "vip_purchase_click",
    "vip_style_click"
  ]);

  const ALLOWED_PLATFORMS = new Set(["chatgpt", "claude", "gemini", "unknown"]);

  const PROPERTY_RULES = {
    platform: { type: "enum", values: new Set(["chatgpt", "claude", "gemini", "unknown"]) },
    entry_point: { type: "enum", values: new Set(["sidebar", "settings", "export_modal", "limit_prompt", "style_panel", "billing_checkout", "billing_restore"]) },
    source: { type: "enum", values: new Set(["current_chat", "bookmark", "batch_export", "popup_subscribe", "subscribe_page", "exporter_extension"]) },
    error_category: { type: "enum", values: new Set(["network", "quota", "auth", "platform_dom", "export_build", "unknown"]) },
    format: { type: "enum", values: new Set(["word", "pdf", "image", "markdown", "txt", "json"]) },
    sku: { type: "enum", values: new Set(["monthly", "yearly", "lifetime"]) },
    intent: { type: "enum", values: new Set(["checkout", "restore"]) },
    style_key: { type: "enum", values: new Set(["default", "midnight", "editorial", "terminal", "newsprint", "aurora", "oxford", "mckinsey"]) },
    count: { type: "integer", min: 1, max: 10 }
  };

  const EVENT_PROPERTIES_MAP = {
    auth_success: ["entry_point"],
    export_success: ["format", "source", "count"],
    export_failed: ["format", "source", "count", "error_category"],
    vip_view_exposure: ["entry_point"],
    vip_sku_click: ["sku", "entry_point"],
    vip_signin_required: ["sku", "intent", "entry_point"],
    vip_purchase_click: ["sku", "entry_point"],
    vip_style_click: ["style_key", "format", "entry_point"]
  };

  const ONCE_BEHAVIOR_KEY_MAP = {
    auth_success: "auth_success",
    vip_view_exposure: "vip_view_exposure",
    vip_sku_click: "vip_sku_click",
    vip_signin_required: "vip_signin_required",
    vip_purchase_click: "vip_purchase_click",
    vip_style_click: "vip_style_click"
  };

  function getChromeLocalStorage() {
    try {
      return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (e) {
      return null;
    }
  }

  function canUseBackgroundAnalytics() {
    try {
      return typeof chrome !== "undefined" &&
        chrome.runtime &&
        typeof chrome.runtime.sendMessage === "function";
    } catch (e) {
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        if (!canUseBackgroundAnalytics()) {
          reject(new Error("Extension background messaging is unavailable."));
          return;
        }
        chrome.runtime.sendMessage(message, (reply) => {
          let lastError = null;
          try {
            lastError = chrome.runtime.lastError;
          } catch (e) {
            lastError = null;
          }

          if (lastError) {
            reject(new Error(lastError.message || "Extension background messaging failed."));
            return;
          }
          resolve(reply || null);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function sendAnalyticsEventToBackground(event) {
    const reply = await sendRuntimeMessage({
      type: "CHATVAULT_ANALYTICS_TRACK",
      event
    });
    if (!reply || reply.ok !== true) {
      throw new Error(reply?.error || "Analytics background queue failed.");
    }
    return reply;
  }

  async function requestBackgroundFlush() {
    if (!canUseBackgroundAnalytics()) {
      await flush();
      return;
    }
    try {
      await sendRuntimeMessage({ type: "CHATVAULT_ANALYTICS_FLUSH" });
    } catch (_) {
      await flush();
    }
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();
      if (!storage) {
        try {
          const val = memoryStorageFallback.get(key);
          resolve(val ? JSON.parse(val) : null);
        } catch (_) {
          resolve(null);
        }
        return;
      }
      try {
        storage.get(key, (result) => {
          if (chrome.runtime?.lastError) {
            resolve(null);
            return;
          }
          resolve(result[key] || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();
      if (!storage) {
        try {
          memoryStorageFallback.set(key, JSON.stringify(value));
        } catch (_) {}
        resolve();
        return;
      }
      try {
        storage.set({ [key]: value }, resolve);
      } catch (_) {
        resolve();
      }
    });
  }

  function generateUuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0,
        v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  let guestIdCache = null;
  async function getOrCreateGuestId() {
    if (guestIdCache) {
      return guestIdCache;
    }
    let id = await storageGet(GUEST_ID_KEY);
    if (!id) {
      id = generateUuid();
      await storageSet(GUEST_ID_KEY, id);
    }
    guestIdCache = id;
    return id;
  }

  function sanitizePropertiesClient(eventName, properties) {
    const allowedKeys = EVENT_PROPERTIES_MAP[eventName];
    if (!allowedKeys || !properties || typeof properties !== "object") {
      return {};
    }
    const sanitized = {};
    for (const key of allowedKeys) {
      if (key in properties) {
        const val = properties[key];
        const rule = PROPERTY_RULES[key];
        if (rule) {
          if (rule.type === "enum") {
            if (rule.values.has(val)) {
              sanitized[key] = val;
            }
          } else if (rule.type === "integer") {
            const number = Math.floor(Number(val));
            if (Number.isFinite(number)) {
              sanitized[key] = Math.max(rule.min || 0, Math.min(rule.max || number, number));
            }
          }
        }
      }
    }
    return sanitized;
  }

  function normalizeTrackedOnceStore(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function getOnceBehaviorKey(eventName) {
    return ONCE_BEHAVIOR_KEY_MAP[eventName] || "";
  }

  async function getActorScope() {
    try {
      const session = await globalThis.CHATVAULT_SUPABASE_AUTH?.getStoredSession?.();
      if (session?.user?.id) {
        return `user:${session.user.id}`;
      }
    } catch (_) {}

    const guestId = await getOrCreateGuestId();
    return `guest:${guestId}`;
  }

  async function getOnceState(eventName) {
    const behaviorKey = getOnceBehaviorKey(eventName);
    if (!behaviorKey) {
      return null;
    }

    const scope = await getActorScope();
    const tracked = normalizeTrackedOnceStore(await storageGet(TRACKED_ONCE_KEY));
    return {
      behaviorKey,
      scope,
      alreadyTracked: Boolean(tracked[scope]?.[behaviorKey])
    };
  }

  async function markTrackedOnce(onceState) {
    if (!onceState?.scope || !onceState?.behaviorKey) {
      return;
    }

    const tracked = normalizeTrackedOnceStore(await storageGet(TRACKED_ONCE_KEY));
    tracked[onceState.scope] = {
      ...(tracked[onceState.scope] || {}),
      [onceState.behaviorKey]: new Date().toISOString()
    };
    await storageSet(TRACKED_ONCE_KEY, tracked);
  }

  async function mergeGuestTrackedOnceToUser(guestId, session) {
    const userId = session?.user?.id;
    if (!guestId || !userId) {
      return;
    }

    const tracked = normalizeTrackedOnceStore(await storageGet(TRACKED_ONCE_KEY));
    const guestScope = `guest:${guestId}`;
    const userScope = `user:${userId}`;
    const guestValues = tracked[guestScope];
    if (!guestValues || typeof guestValues !== "object") {
      return;
    }

    tracked[userScope] = {
      ...guestValues,
      ...(tracked[userScope] || {})
    };
    await storageSet(TRACKED_ONCE_KEY, tracked);
  }

  let isFlushing = false;

  async function flush() {
    return; // 注销埋点
  }

  async function track(eventName, options = {}) {
    return; // 注销埋点
  }

  async function identify() {
    return; // 注销埋点
  }

  let flushInterval = null;
  function startSyncTimer() {
    return; // 注销定时器
  }

  function stopSyncTimer() {
    if (!flushInterval) return;
    clearInterval(flushInterval);
    flushInterval = null;
  }

  globalThis.CHATVAULT_ANALYTICS = {
    track,
    identify,
    getOrCreateGuestId,
    _test: {
      storageGet,
      storageSet,
      sanitizePropertiesClient,
      getOnceBehaviorKey,
      flush,
      stopSyncTimer
    }
  };

  startSyncTimer();
})();
