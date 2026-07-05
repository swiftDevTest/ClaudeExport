(function initChatVaultWelcomePage() {
  "use strict";

  const productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  const storageKey = typeof productConfig.storageKey === "function"
    ? productConfig.storageKey
    : (name) => `chatvault_exporter.${name}`;
  const productName = productConfig.productName || "Claude Export";
  const supportedPlatforms = Array.isArray(productConfig.supportedPlatforms) && productConfig.supportedPlatforms.length
    ? productConfig.supportedPlatforms
    : ["claude"];
  const platformLabels = productConfig.platformLabels || {};
  const ONBOARDING_STATE_KEY = storageKey("onboarding.v1");
  const PLATFORM_DETAILS = {
    chatgpt: {
      label: "ChatGPT",
      icon: "images/platform-chatgpt.png",
      url: "https://chatgpt.com/"
    },
    claude: {
      label: "Claude",
      icon: "images/platform-claude.svg",
      url: "https://claude.ai/"
    },
    gemini: {
      label: "Gemini",
      icon: "images/platform-gemini.svg",
      url: "https://gemini.google.com/"
    }
  };

  function t(key, defaultText, ...args) {
    return typeof CHATVAULT_I18N !== "undefined"
      ? CHATVAULT_I18N.t(key, defaultText, ...args)
      : args.reduce((text, arg, index) => text.replace(new RegExp("\\\$" + (index + 1), "g"), String(arg)), defaultText);
  }

  function getPrimaryPlatform() {
    return supportedPlatforms[0] || "claude";
  }

  function getPlatformDetails(platform) {
    return PLATFORM_DETAILS[platform] || PLATFORM_DETAILS["claude"] || PLATFORM_DETAILS.chatgpt;
  }

  function getPlatformLabel(platform) {
    return platformLabels[platform] || getPlatformDetails(platform).label || "AI";
  }

  function setRoleText(role, text) {
    document.querySelectorAll(`[data-role="${role}"]`).forEach((element) => {
      element.textContent = text;
    });
  }

  function setRoleAttribute(role, name, value) {
    document.querySelectorAll(`[data-role="${role}"]`).forEach((element) => {
      element.setAttribute(name, value);
    });
  }

  function applyProductTheme(target) {
    if (productConfig && typeof productConfig.applyThemeVars === "function") {
      productConfig.applyThemeVars(target || document.documentElement);
    }
  }

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
    const selectedPlatform = platform || getPrimaryPlatform();
    const details = getPlatformDetails(selectedPlatform);

    if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function") {
      chrome.tabs.create({ url: details.url });
      return;
    }

    window.location.href = details.url;
  }

  function applyProductChrome() {
    const platform = getPrimaryPlatform();
    const details = getPlatformDetails(platform);
    const platformLabel = getPlatformLabel(platform);

    applyProductTheme(document.documentElement);
    document.title = t("welcome_page_title", "Welcome to $1", productName);

    document.querySelectorAll(".cv-brand span").forEach((element) => {
      element.textContent = productName;
    });

    document.querySelectorAll("[data-role='primary-platform']").forEach((button) => {
      button.dataset.platform = platform;
      button.hidden = false;
    });

    document.querySelectorAll("[data-role='platform-icon']").forEach((image) => {
      image.src = details.icon;
      image.alt = "";
    });

    setRoleText(
      "welcome-lede",
      t("welcome_lede", "Open $1 first. $2 will meet you there so you can export your first conversation.", platformLabel, productName)
    );
    setRoleText("platform-main", t("welcome_open_gpt", "Open $1", platformLabel));
    setRoleText("platform-sub", t("welcome_sub_gpt", "Best first step: export current chat", platformLabel));
    setRoleText(
      "activation-note",
      t("welcome_pin_wait", "Pinning can wait. The important part is opening $1 where $2 can appear.", platformLabel, productName)
    );
    setRoleText("title-pin", t("welcome_title_pin", "Pin $1 when you are ready.", productName));
    setRoleText(
      "pin-desc",
      t("welcome_pin_desc", "Chrome requires this step to be done manually. Click the puzzle icon, find $1, then click the pin icon.", productName)
    );
    setRoleText(
      "pin-status",
      t("welcome_pin_status_init", "If it is not pinned yet, $1 still works on $2 pages.", productName, platformLabel)
    );
    setRoleText(
      "privacy-note",
      t("welcome_privacy_footnote", "$1 stores settings and daily free quotas only. It does not store prompts, replies, platform cookies, access tokens, or refresh tokens.", productName)
    );
    setRoleAttribute("activation-panel", "aria-label", t("welcome_aria_open_platform", "Open $1", platformLabel));
    setRoleAttribute("pin-row", "aria-label", t("welcome_aria_pin_chatvault", "Pin $1", productName));
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
    button.textContent = t("welcome_btn_checking", "Checking...");

    const settings = await getActionUserSettings();
    const isPinned = Boolean(settings && settings.isOnToolbar);

    button.disabled = false;

    if (isPinned) {
      button.classList.add("is-confirmed");
      button.textContent = t("welcome_btn_pinned", "Pinned");
      setPinStatus(
        t("welcome_pin_success", "Nice. $1 is visible in your Chrome toolbar.", productName),
        "success"
      );

      return writeState({
        status: "welcome_seen",
        pinConfirmedAt: new Date().toISOString()
      });
    }

    button.classList.add("is-attention");
    button.textContent = t("welcome_btn_check_again", "Check again");
    setPinStatus(
      t("welcome_pin_failed", "Not pinned yet. Use Chrome's puzzle icon in the toolbar, then click the pin next to $1.", productName),
      "attention"
    );

    return writeState({
      status: "welcome_seen",
      pinCheckPromptedAt: new Date().toISOString()
    });
  }

  function handlePlatformClick(button) {
    const platform = button.dataset.platform || getPrimaryPlatform();

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

    applyProductChrome();
    markWelcomeSeen();

    document.querySelector("[data-action='confirm-pin']")?.addEventListener("click", (event) => {
      checkPinStatus(event.currentTarget);
    });

    document.querySelectorAll("[data-platform]").forEach((button) => {
      button.addEventListener("click", () => handlePlatformClick(button));
    });
  });
})();
