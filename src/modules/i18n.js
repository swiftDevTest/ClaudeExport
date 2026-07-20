(function initChatVaultI18n() {
  "use strict";

  var LANGUAGE_STORAGE_KEY = "chatvault_ui_language_v1";
  var SUPPORTED_LANGUAGES = Object.freeze([
    "en", "zh_CN", "zh_TW", "ja", "ko", "de", "fr", "es", "pt_BR"
  ]);
  var selectedLanguage = "system";
  var resolvedLanguage = normalizeLanguage(getBrowserLanguage());
  var selectedCatalog = null;
  var readyPromise = null;
  var pendingLanguageWrite = null;

  function formatDefault(defaultText, args) {
    var text = String(defaultText || "");
    (args || []).forEach(function (arg, index) {
      text = text.replace(new RegExp("\\$" + (index + 1), "g"), String(arg));
    });
    return text;
  }

  function getMessage(key, args) {
    if (selectedCatalog && selectedCatalog[key] && typeof selectedCatalog[key].message === "string") {
      return formatDefault(selectedCatalog[key].message, args);
    }
    if (selectedLanguage !== "system") return "";
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
        return chrome.i18n.getMessage(key, args);
      }
    } catch (error) {}
    return "";
  }

  function getBrowserLanguage() {
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
        return chrome.i18n.getUILanguage() || "en";
      }
    } catch (error) {}
    return typeof navigator !== "undefined" && navigator.language ? navigator.language : "en";
  }

  function normalizeLanguage(value) {
    var input = String(value || "en").replace(/-/g, "_");
    var exact = SUPPORTED_LANGUAGES.find(function (language) {
      return language.toLowerCase() === input.toLowerCase();
    });
    if (exact) return exact;
    var base = input.split("_")[0].toLowerCase();
    if (base === "zh") return /(?:tw|hk|hant)/i.test(input) ? "zh_TW" : "zh_CN";
    return SUPPORTED_LANGUAGES.find(function (language) {
      return language.split("_")[0].toLowerCase() === base;
    }) || "en";
  }

  function getStoredLanguage() {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return resolve("system");
        chrome.storage.local.get(LANGUAGE_STORAGE_KEY, function (result) {
          if (chrome.runtime && chrome.runtime.lastError) return resolve("system");
          var value = result && result[LANGUAGE_STORAGE_KEY];
          resolve(value === "system" || SUPPORTED_LANGUAGES.includes(value) ? value : "system");
        });
      } catch (error) {
        resolve("system");
      }
    });
  }

  async function loadCatalog(language) {
    var normalized = normalizeLanguage(language);
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getURL !== "function") return null;
      var response = await fetch(chrome.runtime.getURL("_locales/" + normalized + "/messages.json"), { cache: "no-store" });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  async function applyLanguage(language) {
    selectedLanguage = language === "system" ? "system" : normalizeLanguage(language);
    resolvedLanguage = selectedLanguage === "system" ? normalizeLanguage(getBrowserLanguage()) : selectedLanguage;
    selectedCatalog = selectedLanguage === "system" ? null : await loadCatalog(resolvedLanguage);
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = resolvedLanguage.replace("_", "-");
    }
    return resolvedLanguage;
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = getStoredLanguage().then(applyLanguage);
    }
    return readyPromise;
  }

  async function setLanguage(language) {
    var next = language === "system" ? "system" : normalizeLanguage(language);
    pendingLanguageWrite = next;
    try {
      await new Promise(function (resolve, reject) {
        try {
          chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: next }, function () {
            if (chrome.runtime && chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
      readyPromise = Promise.resolve(applyLanguage(next));
      await readyPromise;
      if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
        globalThis.dispatchEvent(new CustomEvent("chatvault:language-changed", { detail: { language: resolvedLanguage } }));
      }
    } finally {
      pendingLanguageWrite = null;
    }
    return resolvedLanguage;
  }

  function t(key, defaultText) {
    var args = Array.prototype.slice.call(arguments, 2);
    var message = getMessage(key, args);
    if (message) {
      return message;
    }
    return formatDefault(defaultText, args);
  }

  function translateDOM(root) {
    var scope = root || (typeof document !== "undefined" ? document : null);
    if (!scope || typeof scope.querySelectorAll !== "function") {
      return;
    }

    scope.querySelectorAll("[data-i18n]").forEach(function (node) {
      var key = node.getAttribute("data-i18n");
      var fallback = node.textContent || "";
      node.textContent = t(key, fallback);
    });

    scope.querySelectorAll("[data-i18n-aria-label]").forEach(function (node) {
      var key = node.getAttribute("data-i18n-aria-label");
      var fallback = node.getAttribute("aria-label") || "";
      node.setAttribute("aria-label", t(key, fallback));
    });

    scope.querySelectorAll("[data-i18n-title]").forEach(function (node) {
      var key = node.getAttribute("data-i18n-title");
      var fallback = node.getAttribute("title") || "";
      node.setAttribute("title", t(key, fallback));
    });
  }

  globalThis.CHATVAULT_I18N = {
    t: t,
    translateDOM: translateDOM,
    ready: ready,
    setLanguage: setLanguage,
    getLanguage: function () { return resolvedLanguage; },
    getSelectedLanguage: function () { return selectedLanguage; },
    supportedLanguages: SUPPORTED_LANGUAGES,
    storageKey: LANGUAGE_STORAGE_KEY
  };

  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== "local" || !changes[LANGUAGE_STORAGE_KEY]) return;
        var next = changes[LANGUAGE_STORAGE_KEY].newValue || "system";
        if (pendingLanguageWrite === next) return;
        readyPromise = Promise.resolve(applyLanguage(next));
        readyPromise.then(function () {
          if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
            globalThis.dispatchEvent(new CustomEvent("chatvault:language-changed", { detail: { language: resolvedLanguage } }));
          }
        });
      });
    }
  } catch (error) {}
})();
