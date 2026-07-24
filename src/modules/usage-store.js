(function initChatVaultUsageStore() {
  const productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  const storageKey = typeof productConfig.storageKey === "function"
    ? productConfig.storageKey
    : (name) => `chatvault_exporter.${name}`;
  const USAGE_KEY = storageKey("daily_usage.v1");
  const MAX_EXPORT_EVENTS = 50;
  const USAGE_LOCK_NAME = "chatvault-usage-store-lock";
  function withUsageLock(fn) {
    if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
      return navigator.locks.request(USAGE_LOCK_NAME, () => fn());
    }
    return fn();
  }

  function getChromeLocalStorage() {
    try {
      return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (e) {
      return null;
    }
  }

  function getTodayString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function getDailyUsage() {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();
      const today = getTodayString();

      if (!storage) {
        // Fallback for non-extension environments (e.g. testing)
        try {
          const raw = localStorage.getItem(USAGE_KEY);
          const val = raw ? JSON.parse(raw) : null;
          resolve(normalize(val, today));
        } catch (e) {
          resolve({ date: today, exportedChats: 0 });
        }
        return;
      }

      storage.get(USAGE_KEY, (result) => {
        if (chrome.runtime.lastError) {
          resolve({ date: today, exportedChats: 0 });
          return;
        }
        const val = result[USAGE_KEY];
        resolve(normalize(val, today));
      });
    });
  }

  function saveDailyUsage(usage) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();

      if (!storage) {
        try {
          localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
        } catch (e) {}
        resolve();
        return;
      }

      storage.set({ [USAGE_KEY]: usage }, () => {
        resolve();
      });
    });
  }

  async function incrementDailyUsage(count = 1) {
    return withUsageLock(async () => {
      const current = await getDailyUsage();
      current.exportedChats = Math.max(0, current.exportedChats + count);

      // Log export event metadata
      if (!current.exportEvents) {
        current.exportEvents = [];
      }
      current.exportEvents.push({
        at: new Date().toISOString(),
        count: count
      });
      if (current.exportEvents.length > MAX_EXPORT_EVENTS) {
        current.exportEvents = current.exportEvents.slice(-MAX_EXPORT_EVENTS);
      }

      await saveDailyUsage(current);
      return current;
    });
  }

  async function setDailyUsage(usage) {
    const today = getTodayString();
    const current = normalize(await getDailyUsage(), today);
    const incoming = normalize(usage, today);
    const merged = mergeDailyUsage(current, incoming, today);
    await saveDailyUsage(merged);
    return merged;
  }

  async function resetDailyUsage() {
    const today = getTodayString();
    const fresh = { date: today, exportedChats: 0, exportEvents: [] };
    await saveDailyUsage(fresh);
    return fresh;
  }

  function normalize(value, today) {
    const targetDate = today || getTodayString();
    if (!value || typeof value !== "object") {
      return { date: targetDate, exportedChats: 0, exportEvents: [] };
    }
    if (value.usage_date) {
      const usageDate = String(value.usage_date);
      if (usageDate !== targetDate) {
        return { date: targetDate, exportedChats: 0, exportEvents: [] };
      }
      return {
        date: usageDate,
        usage_date: usageDate,
        exportedChats: Math.max(0, Number(value.exportedChats || value.exported_chats || value.count || value.used || 0)),
        exportEvents: Array.isArray(value.exportEvents) ? value.exportEvents.slice(-MAX_EXPORT_EVENTS) : Array.isArray(value.export_events) ? value.export_events.slice(-MAX_EXPORT_EVENTS) : []
      };
    }
    if (value.date && value.date !== targetDate) {
      return { date: targetDate, exportedChats: 0, exportEvents: [] };
    }
    return {
      date: targetDate,
      exportedChats: Math.max(0, Number(value.exportedChats || value.exported_chats || value.count || value.used || 0)),
      exportEvents: Array.isArray(value.exportEvents) ? value.exportEvents.slice(-MAX_EXPORT_EVENTS) : []
    };
  }

  function mergeDailyUsage(current, incoming, today) {
    const targetDate = today || getTodayString();
    const currentUsage = normalize(current, targetDate);
    const incomingUsage = normalize(incoming, targetDate);
    const exportEvents = [
      ...(Array.isArray(currentUsage.exportEvents) ? currentUsage.exportEvents : []),
      ...(Array.isArray(incomingUsage.exportEvents) ? incomingUsage.exportEvents : [])
    ];
    const seenEvents = new Set();
    const dedupedEvents = [];

    exportEvents.forEach((event) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const key = `${event.at || ""}|${event.count || ""}`;
      if (seenEvents.has(key)) {
        return;
      }
      seenEvents.add(key);
      dedupedEvents.push(event);
    });

    const merged = {
      date: targetDate,
      exportedChats: Math.max(
        Math.max(0, Number(currentUsage.exportedChats) || 0),
        Math.max(0, Number(incomingUsage.exportedChats) || 0)
      ),
      exportEvents: dedupedEvents.slice(-MAX_EXPORT_EVENTS)
    };

    if (currentUsage.usage_date === targetDate || incomingUsage.usage_date === targetDate) {
      merged.usage_date = targetDate;
    }

    return merged;
  }

  globalThis.CHATVAULT_USAGE_STORE = {
    MAX_EXPORT_EVENTS,
    getDailyUsage,
    incrementDailyUsage,
    setDailyUsage,
    resetDailyUsage,
    getTodayString
  };
})();
