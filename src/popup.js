(function initPopup() {
  "use strict";

  var activeTabId = null;
  var activePlatform = "";
  var isSupportedPage = false;
  var localSettings = {};
  var isProUser = false;
  var showSubscriptionPanel = null;
  var toastTimer = null;
  var latestCachedEntitlementState = null;
  var pendingSubscribePanelHandled = false;
  var pendingSubscribeRequestMaxAgeMs = 2 * 60 * 1000;
  var pendingSubscribeRequestKey = "chatvault_open_subscribe_panel_request";
  var pendingCheckoutIntentKey = "chatvault_pending_checkout_intent_v1";
  var pendingCheckoutInlineFlowActive = false;
  var pendingCheckoutResumeInFlight = false;

  function formatDefault(defaultText, args) {
    var text = String(defaultText || "");
    (args || []).forEach(function (arg, index) {
      text = text.replace(new RegExp("\\$" + (index + 1), "g"), String(arg));
    });
    return text;
  }

  function t(key, defaultText) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.t === "function") {
      return globalThis.CHATVAULT_I18N.t.apply(globalThis.CHATVAULT_I18N, [key, defaultText].concat(args));
    }
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
        var message = chrome.i18n.getMessage(key, args);
        if (message) return message;
      }
    } catch (error) {}
    return formatDefault(defaultText, args);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function setText(selector, key, defaultText) {
    var el = document.querySelector(selector);
    if (el) el.textContent = t(key, defaultText);
  }

  function setTitle(selector, key, defaultText) {
    var el = document.querySelector(selector);
    if (el) el.setAttribute("title", t(key, defaultText));
  }

  function setAriaLabel(selector, key, defaultText) {
    var el = document.querySelector(selector);
    if (el) el.setAttribute("aria-label", t(key, defaultText));
  }

  function getUILanguage() {
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
        return chrome.i18n.getUILanguage() || "en";
      }
    } catch (error) {}
    return "en";
  }

  function applyPopupI18n() {
    document.documentElement.lang = getUILanguage().replace("_", "-");
    document.title = t("extensionShortName", "AI Chat Export");
    if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.translateDOM === "function") {
      globalThis.CHATVAULT_I18N.translateDOM();
    }

    setText("#btn-upgrade-vip", "btn_upgrade", "Upgrade To Pro");
    setText("#login-btn span", "popup_btn_login", "Sign In");

    setText("#unsupported-overlay h3", "popup_unsupported_title", "Unsupported Page");
    setText("#unsupported-overlay p", "popup_unsupported_desc", "Use this extension on one of these AI chat pages:");
    setText("#btn-open-chatgpt", "popup_open_chatgpt", "Open ChatGPT");

    setText(".platform-row-title span", "popup_current_session", "Current session");
    setText(".platform-row-title strong", "popup_auto_detect_platform", "Auto-detect platform");

    setTitle("#banner-batch-export", "popup_batch_export_title_attr", "Batch export conversations from the current platform");
    setText("#banner-batch-export .banner-text h3", "popup_batch_export_compact", "Batch Export");
    setText("#banner-batch-export .banner-text p", "popup_batch_export_desc", "Multi-chat export");
    setTitle("#banner-custom-export", "popup_custom_export_title_attr", "Enter conversation selection mode");
    setText("#banner-custom-export .banner-text h3", "popup_custom_export", "Custom Export");
    setText("#banner-custom-export .banner-text p", "popup_custom_export_desc", "Select messages");

    var oneClickTitle = document.querySelector(".one-click-section .section-header h3");
    if (oneClickTitle && oneClickTitle.firstChild) {
      oneClickTitle.firstChild.nodeValue = t("popup_one_click_export", "One-click Export");
    }
    setText('[data-format="pdf"] small', "popup_format_pdf_hint", "Formatted save");
    setText('[data-format="word"] small', "popup_format_word_hint", "Editable");
    setText('[data-format="markdown"] small', "popup_format_markdown_hint", "Knowledge base");
    setText('[data-format="image"] .format-name', "format_image", "Image");
    setText('[data-format="image"] small', "popup_format_image_hint", "Share card");
    setText('[data-format="txt"] .format-name', "popup_format_text_name", "Text");
    setText('[data-format="txt"] small', "popup_format_text_hint", "Plain content");
    setText('[data-format="json"] small', "popup_format_json_hint", "Structured");

    setText(".privacy-text strong", "popup_privacy_title", "100% local and private");
    setText(".privacy-text span", "popup_privacy_desc", "All parsing and exports happen locally in your browser. Your chat data is not uploaded.");
    setText("#quota-status-info", "popup_quota_loading", "Loading usage quota...");

    setText("#panel-settings .section-card:nth-of-type(1) h3", "export_theme_label", "Export Theme & Styling");
    setText('[data-theme="default"] .theme-name', "export_theme_default", "Minimalist");
    setText('[data-theme="midnight"] .theme-name', "export_theme_midnight", "Midnight Dark");
    setText('[data-theme="editorial"] .theme-name', "export_theme_editorial", "Editorial");
    setText('[data-theme="terminal"] .theme-name', "export_theme_terminal", "Terminal");
    setText('[data-theme="newsprint"] .theme-name', "export_theme_newsprint", "Newsprint");
    setText('[data-theme="aurora"] .theme-name', "export_theme_aurora", "Aurora");
    setText('[data-theme="mckinsey"] .theme-name', "export_theme_mckinsey", "McKinsey");
    setText('[data-theme="oxford"] .theme-name', "export_theme_oxford", "Oxford");

    setText("#panel-settings .section-card:nth-of-type(2) h3", "popup_settings_section_title", "Content Export Settings");
    setSettingTexts("toggle-title", "export_opt_title", "Conversation Title", "popup_title_desc", "Show the conversation title at the top of the document");
    setSettingTexts("toggle-time", "export_opt_time", "Export Time", "popup_time_desc", "Insert an export timestamp in the document header");
    setSettingTexts("toggle-ai-only", "export_opt_ai_only", "AI Replies Only", "popup_ai_only_desc", "Filter user prompts and keep only AI replies");
    setSettingTexts("toggle-watermark", "popup_watermark_title", "Hide AI Chat Export Watermark", "popup_watermark_desc", "Remove the AI Chat Export signature from the document end (Pro)");
    setSettingTexts("toggle-source-url", "export_opt_url", "Source URL", "popup_source_url_desc", "Append the original conversation URL to the exported document");
    setSettingTexts("toggle-platform-name", "export_opt_platform", "Platform Name", "popup_platform_name_desc", "Show the source platform in the document header");
    setSettingTexts("toggle-role-labels", "export_opt_role", "Role Labels", "popup_role_labels_desc", "Show User / Assistant labels before chat content");
    setSettingTexts("toggle-align-right", "export_opt_align_right", "Align My Questions Right", "popup_align_right_desc", "Right-align your questions in PDF and image exports");

    setTitle('.footer-tab[data-tab-id="dashboard"]', "popup_export_panel_title", "Export panel");
    setText('.footer-tab[data-tab-id="dashboard"] span', "btn_export", "Export");
    setTitle('.footer-tab[data-tab-id="settings"]', "popup_export_settings_title", "Export settings");
    setText('.footer-tab[data-tab-id="settings"] span', "tab_settings", "Settings");

    setText(".subscribe-header h2", "billing_title", "Upgrade To AI Chat Export Pro");
    setAriaLabel("#btn-close-subscribe", "btn_cancel", "Cancel");
    setText(".subscribe-subtitle", "billing_desc", "Unlock higher local export limits, polished themes, batch workflows, and PDF, Docs, MD and More output.");
    updateSubscribeLoginWarningText();
    setPlanCardTexts("monthly", "billing_badge_monthly", "Monthly Pro", "billing_discount_monthly", "Save 44%", "billing_plan_title_monthly", "Pro Monthly", "billing_cadence_month", "/ month");
    setPlanCardTexts("yearly", "billing_badge_yearly", "Yearly Pro", "billing_discount_yearly", "Save 50%", "billing_plan_title_yearly", "Pro Yearly", "billing_cadence_year", "/ year");
    setText(".recommended-tag", "popup_recommended", "Recommended");
    setPlanCardTexts("lifetime", "billing_badge_lifetime", "Lifetime Pro", "billing_discount_lifetime", "Save 62%", "billing_plan_title_lifetime", "Lifetime Early Bird", "billing_cadence_lifetime", "one-time");
    setFeatureTexts();
    var subscribeSubmit = document.getElementById("btn-subscribe-submit");
    if (subscribeSubmit) {
      subscribeSubmit.textContent = t("billing_continue_with_plan", "Continue with $1", getPlanTitle("yearly"));
    }
    setText("#btn-subscribe-restore", "billing_btn_restore", "Restore purchase");
    setText(".subscribe-footnote", "billing_footnote", "Exports are generated locally from the page you choose. Checkout opens on the AI Chat Export pricing page and is processed by a secure payment processor. AI Chat Export stores settings, sign-in email, and membership status only. Chat content is never saved.");

    setText(".confirm-modal-header h3", "popup_confirm_logout_title", "Log out");
    setText(".confirm-modal-message", "popup_confirm_logout_message", "Log out of the current account?");
    setText("#confirm-btn-cancel", "btn_cancel", "Cancel");
    setText("#confirm-btn-ok", "btn_logout", "Log Out");
  }

  function setSettingTexts(inputId, titleKey, titleDefault, descKey, descDefault) {
    var input = document.getElementById(inputId);
    var row = input ? input.closest(".settings-toggle-row") : null;
    if (!row) return;
    var title = row.querySelector(".toggle-title");
    var desc = row.querySelector(".toggle-desc");
    if (title) title.textContent = t(titleKey, titleDefault);
    if (desc) desc.textContent = t(descKey, descDefault);
  }

  function setPlanCardTexts(planId, tagKey, tagDefault, discountKey, discountDefault, titleKey, titleDefault, cadenceKey, cadenceDefault) {
    var card = document.querySelector('[data-plan-id="' + planId + '"]');
    if (!card) return;
    var tag = card.querySelector(".plan-tag");
    var discount = card.querySelector(".plan-discount-badge");
    var title = card.querySelector(".plan-title");
    var cadence = card.querySelector(".plan-price-cadence");
    if (tag) tag.textContent = t(tagKey, tagDefault);
    if (discount) discount.textContent = t(discountKey, discountDefault);
    if (title) title.textContent = t(titleKey, titleDefault);
    if (cadence) cadence.textContent = t(cadenceKey, cadenceDefault);
  }

  function setFeatureTexts() {
    var features = [
      ["popup_benefit_unlimited_exports", "Unlimited local exports"],
      ["popup_benefit_report_themes", "Publication-grade themes"],
      ["popup_benefit_local_receipts", "Local export receipts"],
      ["popup_benefit_hide_watermark", "Hide all export watermarks"],
      ["popup_benefit_zip_download", "Code package ZIP download"],
      ["popup_benefit_shared_pro", "Shared Pro access"]
    ];
    document.querySelectorAll(".feature-tick-item span:last-child").forEach(function (el, index) {
      var item = features[index];
      if (item) el.textContent = t(item[0], item[1]);
    });
  }

  function updateSubscribeLoginWarningText() {
    var warning = document.querySelector("#subscribe-login-warning .warning-text");
    var link = document.getElementById("subscribe-login-link");
    if (!warning || !link) return;
    warning.textContent = "";
    link.textContent = t("popup_btn_login", "sign in");
    warning.append(
      t("popup_subscribe_login_prefix", "You are not signed in. "),
      link,
      t("popup_subscribe_login_suffix", " first to bind Pro automatically before checkout.")
    );
  }

  function getPlanTitle(planId) {
    if (planId === "monthly") return t("billing_plan_title_monthly", "Pro Monthly");
    if (planId === "lifetime") return t("billing_plan_title_lifetime", "Lifetime Early Bird");
    return t("billing_plan_title_yearly", "Pro Yearly");
  }

  function normalizeSubscribePlanId(planId) {
    var value = String(planId || "").trim();
    if (value === "monthly" || value === "yearly" || value === "lifetime") return value;
    return "yearly";
  }

  function getSelectedSubscribePlanId() {
    var checkedRadio = document.querySelector('input[name="subscribe-plan"]:checked');
    return normalizeSubscribePlanId(checkedRadio ? checkedRadio.value : "yearly");
  }

  function selectSubscribePlan(planId) {
    var normalizedPlanId = normalizeSubscribePlanId(planId);
    var card = document.querySelector('[data-plan-id="' + normalizedPlanId + '"]');
    var radio = card ? card.querySelector(".plan-radio") : document.querySelector('input[name="subscribe-plan"][value="' + normalizedPlanId + '"]');
    var submitBtn = document.getElementById("btn-subscribe-submit");
    document.querySelectorAll(".plan-option-card").forEach(function (item) {
      item.classList.toggle("active", item === card);
    });
    if (radio) radio.checked = true;
    if (submitBtn) {
      submitBtn.textContent = t("billing_continue_with_plan", "Continue with $1", getPlanTitle(normalizedPlanId));
    }
  }

  function openSubscribePanel(planId) {
    selectSubscribePlan(planId);
    if (typeof showSubscriptionPanel === "function") {
      showSubscriptionPanel();
    }
  }

  function createPendingCheckoutIntent(planId, source) {
    var billing = globalThis.CHATVAULT_BILLING;
    if (billing && typeof billing.createCheckoutIntent === "function") {
      return billing.createCheckoutIntent(planId || "yearly", source || "popup_subscribe");
    }
    return {
      at: Date.now(),
      planId: normalizeSubscribePlanId(planId),
      source: source || "popup_subscribe"
    };
  }

  function normalizePendingCheckoutIntent(value) {
    var billing = globalThis.CHATVAULT_BILLING;
    if (billing && billing.checkoutIntentStorageKey) {
      pendingCheckoutIntentKey = billing.checkoutIntentStorageKey;
    }
    if (billing && typeof billing.normalizeCheckoutIntent === "function") {
      return billing.normalizeCheckoutIntent(value);
    }
    if (!value || typeof value !== "object") {
      return null;
    }
    var age = Date.now() - Number(value.at || 0);
    if (!Number.isFinite(age) || age < 0 || age > 5 * 60 * 1000) {
      return null;
    }
    return {
      at: Number(value.at),
      planId: normalizeSubscribePlanId(value.planId || value.plan || value.sku),
      source: value.source || "popup_subscribe"
    };
  }

  function getChromeStorage() {
    try {
      return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (error) {
      return null;
    }
  }

  function storageGet(key) {
    return new Promise(function (resolve) {
      var storage = getChromeStorage();
      if (!storage) {
        resolve(null);
        return;
      }
      storage.get(key, function (result) {
        try {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
        } catch (error) {
          resolve(null);
          return;
        }
        resolve(result && result[key] ? result[key] : null);
      });
    });
  }

  function storageSet(items) {
    return new Promise(function (resolve) {
      var storage = getChromeStorage();
      if (!storage) {
        resolve(false);
        return;
      }
      storage.set(items, function () {
        try {
          resolve(!chrome.runtime.lastError);
        } catch (error) {
          resolve(true);
        }
      });
    });
  }

  function storageRemove(key) {
    return new Promise(function (resolve) {
      var storage = getChromeStorage();
      if (!storage) {
        resolve();
        return;
      }
      storage.remove(key, function () {
        resolve();
      });
    });
  }

  async function savePendingCheckoutIntent(planId, source) {
    var billing = globalThis.CHATVAULT_BILLING;
    if (billing && billing.checkoutIntentStorageKey) {
      pendingCheckoutIntentKey = billing.checkoutIntentStorageKey;
    }
    await storageSet({ [pendingCheckoutIntentKey]: createPendingCheckoutIntent(planId, source) });
  }

  async function getPendingCheckoutIntent() {
    var billing = globalThis.CHATVAULT_BILLING;
    if (billing && billing.checkoutIntentStorageKey) {
      pendingCheckoutIntentKey = billing.checkoutIntentStorageKey;
    }
    var intent = normalizePendingCheckoutIntent(await storageGet(pendingCheckoutIntentKey));
    if (!intent) {
      await storageRemove(pendingCheckoutIntentKey);
    }
    return intent;
  }

  function clearPendingCheckoutIntent() {
    return storageRemove(pendingCheckoutIntentKey);
  }

  async function maybeOpenPendingSubscribePanel() {
    if (pendingSubscribePanelHandled) return;
    pendingSubscribePanelHandled = true;

    var requested = false;
    var planId = "";

    try {
      var urlParams = new URLSearchParams(window.location.search || "");
      requested = urlParams.get("subscribe") === "1" || urlParams.get("panel") === "subscribe";
      planId = urlParams.get("plan") || "";
    } catch (error) {}

    try {
      var pendingRequest = await storageGet(pendingSubscribeRequestKey);
      if (pendingRequest && typeof pendingRequest === "object") {
        var createdAt = Number(pendingRequest.at || 0);
        if (!createdAt || Date.now() - createdAt < pendingSubscribeRequestMaxAgeMs) {
          requested = true;
          planId = pendingRequest.planId || planId;
        }
        await storageRemove(pendingSubscribeRequestKey);
      }
    } catch (error) {
      console.warn("Failed to read pending subscribe panel request:", error);
    }

    if (requested) {
      openSubscribePanel(planId);
    }
  }

  function setQuotaInfo(quotaInfo, remainingQuota, pro) {
    if (!quotaInfo) return;
    quotaInfo.textContent = "";
    if (pro) {
      quotaInfo.textContent = t("popup_pro_quota_status", "Unlimited exports available");
      return;
    }
    quotaInfo.textContent = t("popup_quota_remaining", "Today's remaining quota: $1 / 3 exports", remainingQuota);
  }

  async function hydrateCachedEntitlementState() {
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    if (!entitlements || typeof entitlements.getCachedState !== "function") {
      return false;
    }

    try {
      var cached = await entitlements.getCachedState();
      if (!cached) {
        latestCachedEntitlementState = null;
        return false;
      }

      var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
      if (cached.email && auth && typeof auth.getStoredSession === "function") {
        var storedSession = await auth.getStoredSession().catch(function () {
          return null;
        });
        var storedEmail = storedSession?.user?.email || "";
        if ((!storedSession?.access_token && !storedEmail) || (storedEmail && storedEmail !== cached.email)) {
          if (typeof entitlements.clearCachedState === "function") {
            await entitlements.clearCachedState();
          }
          latestCachedEntitlementState = null;
          return false;
        }
      }

      latestCachedEntitlementState = cached;
      isProUser = !!cached.isProUser;
      updateLocalUI(cached.session, cached.profile, cached.remainingQuota);
      return true;
    } catch (error) {
      latestCachedEntitlementState = null;
      console.warn("Cached entitlement state loading failed:", error);
      return false;
    }
  }

  function cacheEntitlementStateFromResponse(response) {
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    if (!response || !entitlements || typeof entitlements.saveCachedState !== "function") {
      return;
    }

    var profile = response.profile || {
      email: response.email || "",
      plan: response.isProUser ? "pro" : "free"
    };
    var sessionUser = response.email ? {
      email: response.email,
      user_metadata: {
        avatar_url: response.avatarUrl || "",
        picture: response.avatarUrl || ""
      }
    } : null;

    entitlements.saveCachedState({
      profile: profile,
      usage: response.dailyUsage || {},
      sessionUser: sessionUser
    }).catch(function (error) {
      console.warn("Cached entitlement state save failed:", error);
    });
  }

  function updateProCrown(isPro) {
    var crown = document.getElementById("pro-crown-indicator");
    if (!crown) return;
    crown.classList.toggle("active", !!isPro);
    crown.setAttribute("aria-hidden", isPro ? "false" : "true");
  }

  function setToggleChecked(id, checked) {
    var el = document.getElementById(id);
    if (el) el.checked = !!checked;
  }

  function sortSettingsRowsByChecked() {
    var card = document.getElementById("content-export-settings-card");
    if (!card) return;
    var rows = Array.prototype.slice.call(card.querySelectorAll(".settings-toggle-row[data-sortable-setting]"));
    rows.forEach(function (row, index) {
      if (!row.dataset.settingOrder) row.dataset.settingOrder = String(index);
    });
    rows
      .sort(function (a, b) {
        var aChecked = !!(a.querySelector("input[type='checkbox']")?.checked);
        var bChecked = !!(b.querySelector("input[type='checkbox']")?.checked);
        if (aChecked !== bChecked) return bChecked ? 1 : -1;
        return Number(a.dataset.settingOrder || 0) - Number(b.dataset.settingOrder || 0);
      })
      .forEach(function (row) {
        card.appendChild(row);
      });
  }

  function setRefreshRequired(quotaInfo) {
    if (!quotaInfo) return;
    quotaInfo.textContent = "";
    var title = document.createElement("div");
    title.className = "inline-error-message";
    title.textContent = t("popup_refresh_required_title", "Please refresh the page to activate the extension");
    var desc = document.createElement("div");
    desc.className = "inline-helper";
    desc.textContent = t("popup_refresh_required_desc", "The extension was just loaded or updated. Open AI conversation pages must be refreshed once before popup communication works.");
    quotaInfo.append(title, desc);
  }

  document.addEventListener("DOMContentLoaded", async function () {
    applyPopupI18n();
    await hydrateCachedEntitlementState();

    // 1. 初始化平台及链接监听
    document.getElementById("btn-open-chatgpt").addEventListener("click", function () {
      chrome.tabs.create({ url: "https://claude.ai/" });
      window.close();
    });

    // 2. 检测当前网页并初始化通信
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var activeTab = tabs[0];
      if (!activeTab || !activeTab.url) {
        showUnsupportedPage();
        loadStateLocally();
        return;
      }

      activeTabId = activeTab.id;
      var url = null;
      try {
        url = new URL(activeTab.url);
      } catch (e) {
        showUnsupportedPage();
        loadStateLocally();
        return;
      }

      var platform = getSupportedPlatform(url.hostname);
      if (!platform) {
        showUnsupportedPage();
        loadStateLocally();
        return;
      }

      isSupportedPage = true;
      activePlatform = platform;
      hideUnsupportedPage();

      // 确定平台标签
      var box = document.querySelector('[data-platform-id="' + activePlatform + '"]');
      if (box) box.classList.add("active");

      // Cached state is already shown above; the supported page must be the source of truth.
      fetchStateFromPage(true);
    });

    // 3. 绑定底部 Tab 导航
    document.querySelectorAll(".footer-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        var tabId = tab.getAttribute("data-tab-id");
        document.querySelectorAll(".footer-tab").forEach(function (t) { t.classList.remove("active"); });
        tab.classList.add("active");

        document.querySelectorAll(".tab-panel").forEach(function (panel) {
          panel.classList.remove("active");
        });
        var targetPanel = document.getElementById("panel-" + tabId);
        if (targetPanel) targetPanel.classList.add("active");
      });
    });

    // 4. 绑定格式导出按钮
    document.querySelectorAll("[data-format]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var format = btn.getAttribute("data-format");
        if (!requireSupportedPage()) return;

        // 读取 popup 当前最新设置，随导出消息一并发送给 content.js
        var themeOption = document.querySelector(".theme-option.active");
        var currentSettings = {
          redaction_enabled: false,
          show_conversation_title: document.getElementById("toggle-title") ? document.getElementById("toggle-title").checked : true,
          show_export_time: document.getElementById("toggle-time") ? document.getElementById("toggle-time").checked : true,
          export_ai_replies_only: document.getElementById("toggle-ai-only") ? document.getElementById("toggle-ai-only").checked : false,
          include_prompt_appendix: false,
          show_chatvault_badge: document.getElementById("toggle-watermark") ? !document.getElementById("toggle-watermark").checked : true,
          include_source_url: document.getElementById("toggle-source-url") ? document.getElementById("toggle-source-url").checked : false,
          show_platform_name: document.getElementById("toggle-platform-name") ? document.getElementById("toggle-platform-name").checked : true,
          show_role_labels: document.getElementById("toggle-role-labels") ? document.getElementById("toggle-role-labels").checked : true,
          align_user_messages_right: document.getElementById("toggle-align-right") ? document.getElementById("toggle-align-right").checked : true,
          export_style: themeOption ? themeOption.getAttribute("data-theme") : "default"
        };

        sendMessageToActivePage({
          type: "CHATVAULT_POPUP_EXPORT",
          format: format,
          settings: currentSettings
        }, {
          keepOpen: true
        });
      });
    });

    // 5. 绑定自定义选择导出
    document.getElementById("banner-custom-export").addEventListener("click", function () {
      sendMessageToActivePage({ type: "CHATVAULT_POPUP_CUSTOM_EXPORT" });
    });

    // 6. 复制全文入口已从弹窗首页移除，保留消息处理供旧入口或快捷入口复用。

    // 8. 绑定切换设置项
    var toggleIds = ["title", "time", "ai-only", "watermark", "source-url", "platform-name", "role-labels", "align-right"];
    toggleIds.forEach(function (id) {
      var el = document.getElementById("toggle-" + id);
      if (el) {
        el.addEventListener("change", function () {
          if (!isProUser && id === "watermark") {
            if (el.checked) {
              el.checked = false; // 恢复未勾选状态
              if (typeof showSubscriptionPanel === "function") {
                showSubscriptionPanel();
              }
              sortSettingsRowsByChecked();
              return;
            }
          }
          sortSettingsRowsByChecked();
          updateSettingsOnPage();
        });
      }
    });

    // 9. 绑定主题风格选择
    document.querySelectorAll(".theme-option").forEach(function (opt) {
      opt.addEventListener("click", function () {
        var theme = opt.getAttribute("data-theme");
        if (!isProUser && theme !== "default") {
          if (typeof showSubscriptionPanel === "function") {
            showSubscriptionPanel();
          }
          return;
        }
        document.querySelectorAll(".theme-option").forEach(function (o) { o.classList.remove("active"); });
        opt.classList.add("active");
        updateSettingsOnPage();
      });
    });

    // === VIP 订阅面板内嵌绑定逻辑 ===
    var subscribePanel = document.getElementById("panel-subscribe");

    showSubscriptionPanel = function () {
      if (subscribePanel) {
        subscribePanel.style.display = "flex";
        updateSubscriptionUIState();
      }
    };

    var closeSubscribeBtn = document.getElementById("btn-close-subscribe");
    if (closeSubscribeBtn) {
      closeSubscribeBtn.onclick = function (e) {
        if (e) e.preventDefault();
        if (subscribePanel) subscribePanel.style.display = "none";
      };
    }

    // 方案卡片选择切换
    var planCards = document.querySelectorAll(".plan-option-card");
    planCards.forEach(function (card) {
      card.onclick = function () {
        planCards.forEach(function (c) { c.classList.remove("active"); });
        card.classList.add("active");
        var radio = card.querySelector(".plan-radio");
        if (radio) radio.checked = true;
        updateSubscriptionUIState();
      };
    });

    function updateSubscriptionUIState() {
      var checkedRadio = document.querySelector('input[name="subscribe-plan"]:checked');
      var submitBtn = document.getElementById("btn-subscribe-submit");
      if (!checkedRadio || !submitBtn) return;

      var planVal = checkedRadio.value;
      submitBtn.textContent = t("billing_continue_with_plan", "Continue with $1", getPlanTitle(planVal));

      // 实时获取并展现未登录提示
      var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
      var loginWarning = document.getElementById("subscribe-login-warning");
      if (auth && loginWarning) {
        auth.getSession({ skipUserRefresh: false, allowStaleOnError: true }).then(function (session) {
          if (hasActiveAuthSession(session)) {
            loginWarning.style.display = "none";
          } else {
            loginWarning.style.display = "flex";
          }
        }).catch(function () {
          loginWarning.style.display = "flex";
        });
      }
    }

    // 绑定提示条中的登录链接点击
    var subscribeLoginLink = document.getElementById("subscribe-login-link");
    if (subscribeLoginLink) {
      subscribeLoginLink.onclick = async function (e) {
        if (e) e.preventDefault();
        try {
          await openAuthenticatedCheckout(getSelectedSubscribePlanId(), "popup_subscribe");
          window.close();
        } catch (err) {
          console.error("Checkout after sign-in error:", err);
          alert(getCheckoutErrorMessage(err));
        }
      };
    }

    // 立即订阅结账逻辑
    var subscribeSubmitBtn = document.getElementById("btn-subscribe-submit");
    if (subscribeSubmitBtn) {
      subscribeSubmitBtn.onclick = async function (e) {
        if (e) e.preventDefault();

        var planId = getSelectedSubscribePlanId();

        var originalText = subscribeSubmitBtn.textContent;
        subscribeSubmitBtn.disabled = true;
        subscribeSubmitBtn.textContent = t("toast_opening_checkout", "Opening secure checkout...");

        try {
          var source = "popup_subscribe";
          await openAuthenticatedCheckout(planId, source);
          window.close();
        } catch (err) {
          console.error("Checkout error:", err);
          if (isAuthRequiredError(err) || isLoginError(err)) {
            alert(err && err.message ? err.message : t("popup_subscribe_signin_confirm", "Sign in with Google first to bind Pro access automatically before checkout."));
          } else {
            alert(t("popup_checkout_error", "Checkout failed: $1", getCheckoutErrorMessage(err)));
          }
        } finally {
          subscribeSubmitBtn.disabled = false;
          subscribeSubmitBtn.textContent = originalText;
        }
      };
    }

    // 恢复购买逻辑
    var subscribeRestoreBtn = document.getElementById("btn-subscribe-restore");
    if (subscribeRestoreBtn) {
      subscribeRestoreBtn.onclick = async function (e) {
        if (e) e.preventDefault();
        var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
        if (!auth) return;

        var session = null;
        try {
          session = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: true });
        } catch (err) {}

        if (!hasActiveAuthSession(session)) {
          alert(t("popup_restore_login_required", "Please sign in first, then restore purchase to sync your Pro status."));
          return;
        }

        subscribeRestoreBtn.disabled = true;
        var originalText = subscribeRestoreBtn.textContent;
        subscribeRestoreBtn.textContent = t("popup_restoring", "Restoring...");

        try {
          var api = globalThis.CHATVAULT_SUPABASE_API;
          if (api && session.access_token) {
            await api.request("/functions/v1/sync-subscription-status", {
              accessToken: session.access_token,
              method: "POST"
            });
            alert(t("popup_restore_submitted", "Restore request submitted. Close and reopen the popup to see the latest status."));
            if (isSupportedPage && activeTabId) {
              fetchStateFromPage(true);
            } else {
              loadStateLocally();
            }
            if (subscribePanel) subscribePanel.style.display = "none";
          } else {
            alert(t("popup_service_unavailable", "Service is unavailable. Please try again later."));
          }
        } catch (err) {
          console.error("Restore error:", err);
          alert(t("popup_restore_failed", "Restore purchase failed: $1", err && err.message ? err.message : t("popup_try_later", "Please try again later.")));
        } finally {
          subscribeRestoreBtn.disabled = false;
          subscribeRestoreBtn.textContent = originalText;
        }
      };
    }

    // === 批量导出逻辑 ===
    var batchBtn = document.getElementById("banner-batch-export");

    if (batchBtn) {
      batchBtn.addEventListener("click", function () {
        if (!requireSupportedPage()) return;

        // Send a message to the content script to display the in-page batch export modal
        chrome.tabs.sendMessage(activeTabId, { type: "CHATVAULT_SHOW_BATCH_EXPORT" });
        window.close(); // Close the extension popup
      });
    }

    maybeOpenPendingSubscribePanel();
    resumePendingCheckoutAfterAuth();
  });

  function showUnsupportedPage() {
    isSupportedPage = false;
    activePlatform = "";
    hideUnsupportedPage();
    var panel = document.getElementById("health-warning-container");
    if (panel) panel.innerHTML = "";
  }

  function hideUnsupportedPage() {
    var overlay = document.getElementById("unsupported-overlay");
    if (overlay) {
      overlay.style.display = "none";
      overlay.setAttribute("aria-hidden", "true");
    }
  }

  function getSupportedPlatform(hostname) {
    var host = String(hostname || "").toLowerCase();
    if (host === "claude.ai" || host.endsWith(".claude.ai")) return "claude";
    return "";
  }

  function requireSupportedPage() {
    if (isSupportedPage && activeTabId) return true;
    showUnsupportedToast();
    return false;
  }

  function showUnsupportedToast() {
    showToast(t("toast_no_open_chat", "Open a Claude conversation to export."));
  }

  function showToast(message) {
    var toast = document.getElementById("popup-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("active");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("active");
    }, 2200);
  }

  function sendMessageToActivePage(payload, options) {
    if (!requireSupportedPage()) return;
    options = options || {};
    chrome.tabs.sendMessage(activeTabId, payload, function (response) {
      if (chrome.runtime.lastError) {
        showToast(t("popup_refresh_page_retry", "Please refresh the current AI conversation page and try again."));
        return;
      }
      if (response && response.ok === false) {
        showToast(response.error || t("popup_operation_failed", "Operation failed. Please try again later."));
        return;
      }
      if (options.successToast) {
        showToast(options.successToast);
      }
      if (typeof options.onSuccess === "function") {
        options.onSuccess(response || {});
      }
      if (options.keepOpen) {
        refreshPopupState(true);
        return;
      }
      setTimeout(function () {
        window.close();
      }, Number.isFinite(Number(options.closeDelay)) ? Number(options.closeDelay) : 150);
    });
  }

  // 从页面获取状态并同步到弹出窗口 UI
  function refreshPopupState(forceRefresh) {
    if (isSupportedPage && activeTabId) {
      fetchStateFromPage(forceRefresh);
    } else {
      loadStateLocally();
    }
  }

  function hasActiveAuthSession(session) {
    return !!(session && session.access_token);
  }

  function createPopupFlowError(code, message) {
    var error = new Error(message || t("popup_try_later", "Please try again later."));
    error.code = code;
    return error;
  }

  function isAuthRequiredError(error) {
    return !!(error && error.code === "CHATVAULT_AUTH_REQUIRED");
  }

  function isLoginError(error) {
    return !!(error && error.code === "CHATVAULT_LOGIN_FAILED");
  }

  function isBackendSchemaCacheError(error) {
    var message = String(error && error.message ? error.message : error || "");
    return /schema cache|payment_products|Could not find the table/i.test(message);
  }

  function getCheckoutErrorMessage(error) {
    if (isBackendSchemaCacheError(error)) {
      return t("popup_checkout_service_syncing", "Checkout service is updating. Please reopen AI Chat Export and try again in a moment.");
    }
    return error && error.message ? error.message : t("popup_checkout_unavailable", "Could not open checkout. Please try again later.");
  }

  function openCheckoutTab(url) {
    return new Promise(function (resolve, reject) {
      if (!url) {
        reject(new Error(t("popup_checkout_unavailable", "Could not open checkout. Please try again later.")));
        return;
      }

      try {
        if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function") {
          chrome.tabs.create({ url: url }, function () {
            try {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message || t("popup_checkout_unavailable", "Could not open checkout. Please try again later.")));
                return;
              }
            } catch (error) {}
            resolve(true);
          });
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }

      try {
        var opened = window.open(url, "_blank");
        if (!opened) {
          reject(new Error(t("popup_checkout_popup_blocked", "The browser blocked checkout. Please try again.")));
          return;
        }
        resolve(true);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function getPurchaseSession(options) {
    options = options || {};
    var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    if (!auth || typeof auth.getSession !== "function") {
      throw createPopupFlowError("CHATVAULT_LOGIN_FAILED", t("popup_login_service_unavailable", "Sign-in is temporarily unavailable. Please refresh and try again."));
    }

    var session = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false }).catch(function () {
      return null;
    });

    if (!hasActiveAuthSession(session)) {
      if (typeof auth.signInWithGoogle !== "function") {
        throw createPopupFlowError("CHATVAULT_LOGIN_FAILED", t("popup_login_service_unavailable", "Sign-in is temporarily unavailable. Please refresh and try again."));
      }
      if (options.persistIntent !== false && options.planId) {
        pendingCheckoutInlineFlowActive = true;
        await savePendingCheckoutIntent(options.planId, options.source || "popup_subscribe");
      }
      try {
        session = await auth.signInWithGoogle();
      } catch (error) {
        if (options.persistIntent !== false && options.planId) {
          await clearPendingCheckoutIntent();
        }
        throw createPopupFlowError("CHATVAULT_LOGIN_FAILED", t("popup_login_failed", "Sign-in failed: $1", error && error.message ? error.message : t("popup_try_later", "Please try again later.")));
      }
      if (!hasActiveAuthSession(session)) {
        session = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false }).catch(function () {
          return null;
        });
      }
    }

    if (!hasActiveAuthSession(session)) {
      if (options.persistIntent !== false && options.planId) {
        await clearPendingCheckoutIntent();
      }
      throw createPopupFlowError("CHATVAULT_AUTH_REQUIRED", t("popup_subscribe_signin_confirm", "Sign in with Google first to bind Pro access automatically before checkout."));
    }

    return session;
  }

  async function openAuthenticatedCheckout(planId, source, options) {
    options = options || {};
    var billing = globalThis.CHATVAULT_BILLING;
    if (!billing || typeof billing.createCheckoutSession !== "function") {
      throw new Error(t("popup_checkout_unavailable", "Could not open checkout. Please try again later."));
    }

    var normalizedPlanId = normalizeSubscribePlanId(planId);
    var session = null;
    try {
      session = await getPurchaseSession({
        planId: normalizedPlanId,
        source: source || "popup_subscribe",
        persistIntent: options.persistIntent !== false
      });
    } finally {
      pendingCheckoutInlineFlowActive = false;
    }
    var checkout = await billing.createCheckoutSession({
      accessToken: session.access_token,
      customerEmail: session.user && session.user.email ? session.user.email : "",
      planId: normalizedPlanId,
      source: source || "popup_subscribe"
    });

    if (!checkout || !checkout.checkoutUrl) {
      throw new Error(t("popup_checkout_unavailable", "Could not open checkout. Please try again later."));
    }

    await openCheckoutTab(checkout.checkoutUrl);
    await clearPendingCheckoutIntent();
    return checkout;
  }

  async function resumePendingCheckoutAfterAuth() {
    if (pendingCheckoutInlineFlowActive || pendingCheckoutResumeInFlight) {
      return;
    }

    var intent = await getPendingCheckoutIntent();
    if (!intent) {
      return;
    }

    var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    var session = auth && typeof auth.getSession === "function"
      ? await auth.getSession({ skipUserRefresh: false, allowStaleOnError: true }).catch(function () { return null; })
      : null;

    selectSubscribePlan(intent.planId);
    if (!hasActiveAuthSession(session)) {
      if (typeof showSubscriptionPanel === "function") {
        showSubscriptionPanel();
      }
      return;
    }

    pendingCheckoutResumeInFlight = true;
    try {
      await openAuthenticatedCheckout(intent.planId, intent.source || "popup_subscribe", { persistIntent: false });
      window.close();
    } catch (error) {
      console.warn("Pending checkout resume failed:", error);
      showToast(getCheckoutErrorMessage(error));
    } finally {
      pendingCheckoutResumeInFlight = false;
    }
  }

  async function handlePopupAuthClick() {
    var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    if (!auth) return;

    try {
      var session = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: true }).catch(function () {
        return null;
      });

      if (isProUser || hasActiveAuthSession(session)) {
        var confirmed = await showCustomConfirm(
          t("popup_confirm_logout_title", "Log out"),
          t("popup_confirm_logout_message", "Log out of the current account?")
        );
        if (!confirmed) {
          return;
        }
        if (isSupportedPage && activeTabId) {
          try {
            chrome.tabs.sendMessage(activeTabId, { type: "CHATVAULT_POPUP_LOGOUT" }, function () {
              var err = chrome.runtime.lastError; // Ignore errors
            });
          } catch (e) {}
        }
        await auth.signOut();
        showToast(t("popup_signed_out", "Signed out."));
      } else {
        var signedInSession = await auth.signInWithGoogle();
        if (!signedInSession) {
          showToast(t("popup_login_incomplete", "Sign-in was not completed. Please try again."));
          return;
        }
        showToast(t("popup_login_success", "Signed in."));
      }

      refreshPopupState(true);
    } catch (error) {
      showToast(t("popup_login_failed", "Sign-in failed: $1", error && error.message ? error.message : t("popup_try_later", "Please try again later.")));
      try {
        globalThis.CHATVAULT_SET_AUTH_LOADING?.(false);
      } catch (err) {}
    }
  }

  // 从页面获取状态并同步到弹出窗口 UI
  function fetchStateFromPage(forceRefresh) {
    if (!activeTabId || !isSupportedPage) return;

    chrome.tabs.sendMessage(activeTabId, { type: "CHATVAULT_GET_POPUP_STATE", forceRefresh: !!forceRefresh }, function (response) {
      if (chrome.runtime.lastError || !response || !response.ok) {
        // Page needs refresh or extension context invalidated
        hydrateCachedEntitlementState().then(function (usedCache) {
          if (!usedCache) {
            setRefreshRequired(document.getElementById("quota-status-info"));
          }
        });
        return;
      }

      cacheEntitlementStateFromResponse(response);

      // 更新账号登录态与配额状态
      var loginBtn = document.getElementById("login-btn");
      var isLoggedIn = !!response.email;
      var email = response.email || "";
      var avatarUrl = response.avatarUrl || "";
      var actualPro = !!response.isProUser;

      updateAuthButton(isLoggedIn, actualPro, email, avatarUrl);

      if (loginBtn) {
        loginBtn.onclick = function () {
          handlePopupAuthClick();
        };
      }

      isProUser = actualPro;
      var quotaInfo = document.getElementById("quota-status-info");
      var upgradeBtn = document.getElementById("btn-upgrade-vip");
      if (quotaInfo) {
        if (actualPro) {
          setQuotaInfo(quotaInfo, response.remainingQuota, true);
          if (upgradeBtn) upgradeBtn.style.display = "none";
        } else {
          setQuotaInfo(quotaInfo, response.remainingQuota, false);
          if (upgradeBtn) {
            upgradeBtn.style.display = "block";
            upgradeBtn.onclick = function (e) {
              if (e) e.preventDefault();
              if (typeof showSubscriptionPanel === "function") {
                showSubscriptionPanel();
              }
            };
          }
        }
      }

      // 同步设置项到控制面板
      localSettings = response.exportSettings || {};
      
      setToggleChecked("toggle-title", !!localSettings.show_conversation_title);
      setToggleChecked("toggle-time", !!localSettings.show_export_time);
      setToggleChecked("toggle-ai-only", !!localSettings.export_ai_replies_only);
      setToggleChecked("toggle-watermark", !localSettings.show_chatvault_badge);
      setToggleChecked("toggle-source-url", !!localSettings.include_source_url);
      setToggleChecked("toggle-platform-name", !!localSettings.show_platform_name);
      setToggleChecked("toggle-role-labels", !!localSettings.show_role_labels);
      setToggleChecked("toggle-align-right", !!localSettings.align_user_messages_right);
      sortSettingsRowsByChecked();

      // 主题高亮
      document.querySelectorAll(".theme-option").forEach(function (opt) {
        opt.classList.remove("active");
        if (opt.getAttribute("data-theme") === (localSettings.export_style || "default")) {
          opt.classList.add("active");
        }
      });

      // 同步健康度检查
      if (response.health) {
        renderHealthCheckUI(response.health);
      }
    });
  }

  // 渲染健康度 UI (复用逻辑)
  function renderHealthCheckUI(health) {
    var panel = document.getElementById("health-warning-container");
    panel.innerHTML = "";
    if (health.status === "ready") return;

    var visibleIssues = (health.issues || []).filter(function (issue) {
      return issue && issue.id !== "empty_conversation";
    });
    if (visibleIssues.length === 0) return;

    var cssClass = "success";
    var titleText = "Ready to Export";

    var hasHighRisk = visibleIssues.some(function (issue) { return issue.severity === "high_risk"; });
    var hasAttention = visibleIssues.some(function (issue) { return issue.severity === "attention"; });

    if (hasHighRisk) {
      cssClass = "danger";
      titleText = t("popup_health_high_risk", "High Risk Issues");
    } else if (hasAttention || health.status === "attention") {
      cssClass = "warning";
      titleText = t("popup_health_attention", "Attention Required");
    }

    var issuesHtml = "";
    if (visibleIssues.length > 0) {
      issuesHtml = '<ul class="info-panel-list">' +
        visibleIssues.map(function (iss) { return "<li>" + escapeHtml(iss.message || "") + "</li>"; }).join("") +
        "</ul>";
    }

    panel.innerHTML = 
      '<div class="info-panel ' + cssClass + '">' +
        '<div class="info-panel-title">' + escapeHtml(titleText) + '</div>' +
        issuesHtml +
      '</div>';
  }

  // 向页面推送修改后的设置项
  function updateSettingsOnPage() {
    var themeOption = document.querySelector(".theme-option.active");
    var style = themeOption ? themeOption.getAttribute("data-theme") : "default";

    var nextSettings = {
      redaction_enabled: false,
      show_conversation_title: document.getElementById("toggle-title").checked,
      show_export_time: document.getElementById("toggle-time").checked,
      export_ai_replies_only: document.getElementById("toggle-ai-only").checked,
      include_prompt_appendix: false,
      show_chatvault_badge: !document.getElementById("toggle-watermark").checked,
      include_source_url: document.getElementById("toggle-source-url") ? document.getElementById("toggle-source-url").checked : false,
      show_platform_name: document.getElementById("toggle-platform-name") ? document.getElementById("toggle-platform-name").checked : true,
      show_role_labels: document.getElementById("toggle-role-labels") ? document.getElementById("toggle-role-labels").checked : true,
      align_user_messages_right: document.getElementById("toggle-align-right") ? document.getElementById("toggle-align-right").checked : true,
      export_style: style
    };

    if (!activeTabId || !isSupportedPage) {
      localSettings = nextSettings;
      return;
    }

    chrome.tabs.sendMessage(activeTabId, {
      type: "CHATVAULT_POPUP_UPDATE_SETTINGS",
      settings: nextSettings
    }, function () {
      // settings 已同步到 content.js，content.js 端会自动使缓存失效。
      // 不需要在这里再次全量拉取状态（会触发不必要的健康检查和隐私断言计算）。
      // 本地 localSettings 记录最新值即可。
      localSettings = nextSettings;
    });
  }

  // 从本地存储加载状态（针对不支持的页面，无法和 content.js 通信）
  async function mirrorVerifiedUsageLocally(usage) {
    var usageStore = globalThis.CHATVAULT_USAGE_STORE;
    if (!usageStore || typeof usageStore.setDailyUsage !== "function" || !usage) {
      return usage;
    }
    try {
      return await usageStore.setDailyUsage(usage);
    } catch (error) {
      console.warn("Local verified usage mirror failed:", error);
      return usage;
    }
  }

  async function fetchVerifiedEntitlementState(session) {
    var api = globalThis.CHATVAULT_SUPABASE_API;
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    if (!api || !entitlements || !session?.access_token) {
      return null;
    }

    try {
      var result = await api.request("/functions/v1/verify-export-entitlement", {
        accessToken: session.access_token,
        method: "POST",
        body: {
          requested_count: 1,
          consume: false
        }
      });
      if (!result || result.ok === false) {
        return null;
      }

      var candidate = result.profile || result.data?.profile || null;
      var profile = entitlements.normalizeProfile(candidate || {
        id: session.user?.id || "",
        email: session.user?.email || "",
        plan: "free"
      });
      var usage = entitlements.normalizeDailyUsage(result.usage || {}, entitlements.getTodayString());
      usage = await mirrorVerifiedUsageLocally(usage);

      return {
        profile: profile,
        usage: usage,
        remainingQuota: entitlements.getRemainingFreeExports(profile, usage)
      };
    } catch (error) {
      if (globalThis.CHATVAULT_DEBUG) {
        console.debug("Verified entitlement state unavailable.", error);
      }
      return null;
    }
  }

  async function loadStateLocally() {
    var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    var usageStore = globalThis.CHATVAULT_USAGE_STORE;

    var session = null;
    var profile = null;
    var usage = null;
    var remainingQuota = 3;
    var verifiedState = null;

    await hydrateCachedEntitlementState();
    if (latestCachedEntitlementState) {
      profile = latestCachedEntitlementState.profile || null;
      usage = latestCachedEntitlementState.usage || null;
    }

    try {
      if (auth) {
        session = await auth.getSession({ skipUserRefresh: true });
      }
    } catch (e) {
      console.warn("Local auth loading failed:", e);
    }

    if (session?.user && entitlements) {
      verifiedState = await fetchVerifiedEntitlementState(session);
      if (verifiedState) {
        profile = verifiedState.profile;
        usage = verifiedState.usage;
        remainingQuota = verifiedState.remainingQuota;
      }
      if (!profile) {
        profile = entitlements.normalizeProfile({
          id: session.user?.id || "",
          email: session.user?.email || "",
          plan: "free"
        });
      }
    } else if (entitlements) {
      profile = entitlements.normalizeProfile({ plan: "free" });
    }

    try {
      if (!usage && usageStore) {
        usage = await usageStore.getDailyUsage();
      }
    } catch (e) {
      console.warn("Local usage loading failed:", e);
    }

    if (entitlements && profile) {
      isProUser = entitlements.isPro(profile);
      if (!verifiedState) {
        remainingQuota = entitlements.getRemainingFreeExports(profile, usage || {});
      }
    }

    // 更新 UI
    updateLocalUI(session, profile, remainingQuota);

    try {
      if (entitlements && typeof entitlements.saveCachedState === "function" && profile) {
        await entitlements.saveCachedState({
          session: session,
          profile: profile,
          usage: usage || {}
        });
      }
    } catch (error) {
      console.warn("Local entitlement state cache save failed:", error);
    }
  }

  // 全局登录 Loading Hook
  globalThis.CHATVAULT_SET_AUTH_LOADING = function (isLoading, message) {
    var loginBtn = document.getElementById("login-btn");
    if (!loginBtn) return;
    if (isLoading) {
      loginBtn.classList.add("is-loading");
      loginBtn.disabled = true;
      loginBtn.innerHTML = '<span class="spinner"></span><span>' + escapeHtml(t("popup_auth_loading", "Signing in...")) + '</span>';
    } else {
      loginBtn.classList.remove("is-loading");
      loginBtn.disabled = false;
    }
  };

  // 全局登录态更新 Hook
  globalThis.CHATVAULT_REFRESH_AUTH_STATE = async function (options) {
    refreshPopupState(true);
    await resumePendingCheckoutAfterAuth();
  };

  // 共享更新登录状态与头像 UI 辅助函数
  function updateAuthButton(isLoggedIn, isPro, email, avatarUrl) {
    var loginBtn = document.getElementById("login-btn");
    if (!loginBtn) return;

    updateProCrown(isPro);
    loginBtn.classList.toggle("is-pro", isPro);
    loginBtn.classList.toggle("is-authenticated", isLoggedIn);
    loginBtn.style.color = "";
    loginBtn.style.borderColor = "";
    loginBtn.classList.remove("is-loading");
    loginBtn.disabled = false;

    if (isLoggedIn) {
      var accountLabel = email || (isPro ? t("popup_account", "Account") : t("popup_free_account", "Free Account"));
      loginBtn.setAttribute("title", accountLabel);
      loginBtn.setAttribute("aria-label", accountLabel);
      var avatarHtml = "";
      if (avatarUrl) {
        avatarHtml = '<img src="' + escapeAttribute(avatarUrl) + '" class="user-avatar" referrerpolicy="no-referrer" alt="Avatar">';
      } else {
        avatarHtml = '<svg class="user-avatar-placeholder" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">' +
          '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
          '<circle cx="12" cy="7" r="4"/>' +
          '</svg>';
      }
      loginBtn.innerHTML = avatarHtml;
    } else {
      loginBtn.removeAttribute("title");
      loginBtn.setAttribute("aria-label", t("popup_btn_login", "Sign In"));
      loginBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
        '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>' +
        '</svg><span>' + escapeHtml(t("popup_btn_login", "Sign In")) + '</span>';
    }
  }

  // 显示自定义确认弹窗
  function showCustomConfirm(title, message) {
    return new Promise(function (resolve) {
      var modal = document.getElementById("custom-confirm-modal");
      if (!modal) {
        resolve(false);
        return;
      }

      // 更新文本
      var titleEl = modal.querySelector(".confirm-modal-header h3");
      if (titleEl) titleEl.textContent = title;
      var msgEl = modal.querySelector(".confirm-modal-message");
      if (msgEl) msgEl.textContent = message;

      // 显示弹窗并启动渐入动画
      modal.style.display = "flex";
      modal.offsetHeight; // 强制重绘以确保过渡动画生效
      modal.classList.add("active");

      var btnCancel = document.getElementById("confirm-btn-cancel");
      var btnOk = document.getElementById("confirm-btn-ok");

      function cleanUp() {
        modal.classList.remove("active");
        setTimeout(function () {
          modal.style.display = "none";
        }, 180);
        btnCancel.onclick = null;
        btnOk.onclick = null;
      }

      btnCancel.onclick = function (e) {
        if (e) e.preventDefault();
        cleanUp();
        resolve(false);
      };

      btnOk.onclick = function (e) {
        if (e) e.preventDefault();
        cleanUp();
        resolve(true);
      };
    });
  }

  function updateLocalUI(session, profile, remainingQuota) {
    // 1. 更新登录按钮
    var loginBtn = document.getElementById("login-btn");
    var isLoggedIn = hasActiveAuthSession(session) || !!session?.user?.email;
    var email = session?.user?.email || "";
    var avatarUrl = session?.user?.user_metadata?.avatar_url || session?.user?.user_metadata?.picture || "";

    updateAuthButton(isLoggedIn, isProUser, email, avatarUrl);

    if (loginBtn) {
      loginBtn.onclick = function () {
        handlePopupAuthClick();
      };
    }

    // 2. 更新配额状态与升级按钮
    var quotaInfo = document.getElementById("quota-status-info");
    var upgradeBtn = document.getElementById("btn-upgrade-vip");
    if (quotaInfo) {
      if (isProUser) {
        setQuotaInfo(quotaInfo, remainingQuota, true);
        if (upgradeBtn) upgradeBtn.style.display = "none";
      } else {
        setQuotaInfo(quotaInfo, remainingQuota, false);
          if (upgradeBtn) {
            upgradeBtn.style.display = "block";
            upgradeBtn.onclick = function (e) {
              if (e) e.preventDefault();
              if (typeof showSubscriptionPanel === "function") {
                showSubscriptionPanel();
              }
            };
          }
      }
    }

  }
})();
