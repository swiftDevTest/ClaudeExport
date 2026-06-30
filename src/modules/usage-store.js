(function initChatVaultUsageStore() {
  const USAGE_KEY = "chatvault_exporter_daily_usage";
  const MAX_EXPORT_EVENTS = 50;

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
  }

  async function setDailyUsage(usage) {
    const current = normalize(usage, getTodayString());
    await saveDailyUsage(current);
    return current;
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

  globalThis.CHATVAULT_USAGE_STORE = {
    MAX_EXPORT_EVENTS,
    getDailyUsage,
    incrementDailyUsage,
    setDailyUsage,
    resetDailyUsage,
    getTodayString
  };
})();
