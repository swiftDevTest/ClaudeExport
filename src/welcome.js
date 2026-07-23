(function initChatVaultWelcomePage() {
  "use strict";

  // Fix H10: use product-config storageKey to ensure namespace consistency with background.js.
  const productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  const storageKey = typeof productConfig.storageKey === "function"
    ? productConfig.storageKey
    : (name) => `chatvault_exporter.${name}`;
  const ONBOARDING_STATE_KEY = storageKey("onboarding.v1");
  const PLATFORM_URLS = {
    chatgpt: "https://chatgpt.com/",
    claude: "https://claude.ai/",
    gemini: "https://gemini.google.com/"
  };

  function getStorage() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return null;
    }

    return chrome.storage.local;
  }

  function readState() {
    const storage = getStorage();

    if (!storage) {
      return Promise.resolve({});
    }

    return new Promise((resolve) => {
      storage.get(ONBOARDING_STATE_KEY, (result) => {
        resolve(result?.[ONBOARDING_STATE_KEY] || {});
      });
    });
  }

  function writeState(patch) {
    const storage = getStorage();

    if (!storage) {
      return Promise.resolve();
    }

    return readState().then((current) => new Promise((resolve) => {
      storage.set({
        [ONBOARDING_STATE_KEY]: {
          ...current,
          ...patch
        }
      }, resolve);
    }));
  }

  function getActionUserSettings() {
    if (typeof chrome === "undefined" || !chrome.action || typeof chrome.action.getUserSettings !== "function") {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let settled = false;

      try {
        const maybePromise = chrome.action.getUserSettings((settings) => {
          settled = true;
          resolve(settings || null);
        });

        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise
            .then((settings) => {
              if (!settled) {
                resolve(settings || null);
              }
            })
            .catch(() => {
              if (!settled) {
                resolve(null);
              }
            });
        }
      } catch (error) {
        resolve(null);
      }
    });
  }

  function openPlatform(platform) {
    const url = PLATFORM_URLS[platform] || PLATFORM_URLS.chatgpt;

    if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function") {
      chrome.tabs.create({ url });
      return;
    }

    window.location.href = url;
  }

  function markWelcomeSeen() {
    return writeState({
      status: "welcome_seen",
      welcomeSeenAt: new Date().toISOString()
    });
  }

  function applyDocumentLanguage() {
    try {
      const uiLanguage = typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function"
        ? chrome.i18n.getUILanguage()
        : "";

      if (uiLanguage) {
        document.documentElement.lang = uiLanguage.replace("_", "-");
      }
    } catch (error) {
      document.documentElement.lang = "en";
    }
  }

  function setPinStatus(message, tone) {
    const status = document.querySelector("[data-role='pin-status']");

    if (status) {
      status.textContent = message;
      status.dataset.tone = tone || "";
    }
  }

  async function checkPinStatus(button) {
    button.disabled = true;
    button.classList.remove("is-confirmed", "is-attention");
    button.textContent = typeof CHATVAULT_I18N !== "undefined" ? CHATVAULT_I18N.t("welcome_btn_checking", "Checking...") : "Checking...";

    const settings = await getActionUserSettings();
    const isPinned = Boolean(settings && settings.isOnToolbar);

    button.disabled = false;

    if (isPinned) {
      button.classList.add("is-confirmed");
      button.textContent = typeof CHATVAULT_I18N !== "undefined" ? CHATVAULT_I18N.t("welcome_btn_pinned", "Pinned") : "Pinned";
      setPinStatus(
        typeof CHATVAULT_I18N !== "undefined"
          ? CHATVAULT_I18N.t("welcome_pin_success", "Nice. AI Chat Export is visible in your Chrome toolbar.")
          : "Nice. AI Chat Export is visible in your Chrome toolbar.",
        "success"
      );

      return writeState({
        status: "welcome_seen",
        pinConfirmedAt: new Date().toISOString()
      });
    }

    button.classList.add("is-attention");
    button.textContent = typeof CHATVAULT_I18N !== "undefined" ? CHATVAULT_I18N.t("welcome_btn_check_again", "Check again") : "Check again";
    setPinStatus(
      typeof CHATVAULT_I18N !== "undefined"
        ? CHATVAULT_I18N.t("welcome_pin_failed", "Not pinned yet. Use Chrome's puzzle icon in the toolbar, then click the pin next to AI Chat Export.")
        : "Not pinned yet. Use Chrome's puzzle icon in the toolbar, then click the pin next to AI Chat Export.",
      "attention"
    );

    return writeState({
      status: "welcome_seen",
      pinCheckPromptedAt: new Date().toISOString()
    });
  }

  function handlePlatformClick(button) {
    const platform = button.dataset.platform || "chatgpt";

    writeState({
      status: "welcome_seen",
      preferredActivation: "guided_setup",
      selectedPlatform: platform,
      platformOpenedAt: new Date().toISOString()
    }).finally(() => {
      openPlatform(platform);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyDocumentLanguage();

    if (typeof CHATVAULT_I18N !== "undefined") {
      CHATVAULT_I18N.translateDOM();
    }
    markWelcomeSeen();

    document.querySelector("[data-action='confirm-pin']")?.addEventListener("click", (event) => {
      checkPinStatus(event.currentTarget);
    });

    document.querySelectorAll("[data-platform]").forEach((button) => {
      button.addEventListener("click", () => handlePlatformClick(button));
    });
  });
})();
