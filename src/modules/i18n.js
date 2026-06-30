(function initChatVaultI18n() {
  "use strict";

  function formatDefault(defaultText, args) {
    var text = String(defaultText || "");
    (args || []).forEach(function (arg, index) {
      text = text.replace(new RegExp("\\$" + (index + 1), "g"), String(arg));
    });
    return text;
  }

  function getMessage(key, args) {
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
        return chrome.i18n.getMessage(key, args);
      }
    } catch (error) {}
    return "";
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
    translateDOM: translateDOM
  };
})();
