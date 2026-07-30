(function initPopup() {
  "use strict";

    var activeTabId = null;
  var activePlatform = "";
  var isSupportedPage = false;
  var localSettings = {};
  var localSettingsRevision = 0;
  var isProUser = false;
  var showSubscriptionPanel = null;
  var toastTimer = null;
  var latestCachedEntitlementState = null;
  var latestRemainingQuota = 3;
  var latestQuotaKnown = false;
  var pendingSubscribePanelHandled = false;
  var pendingSubscribeRequestMaxAgeMs = 2 * 60 * 1000;
  var productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  var storageKey = typeof productConfig.storageKey === "function"
    ? productConfig.storageKey
    : function (name) { return "claude_export." + name; };
  var productId = productConfig.productId || "claude_export";
  var productSlug = productConfig.productSlug || "claude-export";
  var productName = productConfig.productName || "Claude Export";
  var productPlatformLabels = productConfig.platformLabels || {};
  var supportedPlatforms = Array.isArray(productConfig.supportedPlatforms) && productConfig.supportedPlatforms.length
    ? productConfig.supportedPlatforms
    : ["chatgpt", "claude", "gemini"];
  var supabaseSessionStorageKey = storageKey("supabase_session.v1");
  var entitlementStateCacheKey = storageKey("entitlement_state.v1");
  var exportSettingsStorageKey = storageKey("export_settings.v1");
  var obsidianVisibilityStorageKey = storageKey("show_obsidian_sync.v1");
  var pendingSubscribeRequestKey = storageKey("open_subscribe_panel_request.v1");
  var pendingCheckoutIntentKey = storageKey("pending_checkout_intent.v1");
  var recentCheckoutSessionKey = storageKey("recent_checkout_session.v1");
  var recentCheckoutSessionMaxAgeMs = 10 * 60 * 1000;
  var checkoutFlowPromise = null;
  var authStorageListenerAttached = false;
  var locallySignedOut = false;
  var obsidianSyncVisible = true;
  var obsidianUiReady = false;
  var obsidianStatus = null;

  function applyProductTheme(target) {
    if (productConfig && typeof productConfig.applyThemeVars === "function") {
      productConfig.applyThemeVars(target || document.documentElement);
    }
  }

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
    if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.getLanguage === "function") {
      return globalThis.CHATVAULT_I18N.getLanguage() || "en";
    }
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
        return chrome.i18n.getUILanguage() || "en";
      }
    } catch (error) {}
    return "en";
  }

  function obsidianText(english, chinese) {
    // Match only Simplified Chinese; zh-TW has its own catalog and falls back to English here.
    const lang = getUILanguage() || "";
    const isSimplifiedZh = /^zh[-_](?:CN|Hans|SG|MO)$/i.test(lang) || (/^zh(?:_|-|$)/i.test(lang) && !/^zh[-_](?:TW|HK|Hant)$/i.test(lang));
    return isSimplifiedZh ? chinese : english;
  }

  function ot(key, english, chinese, ...args) {
    return t(key, obsidianText(english, chinese), ...args);
  }

  function applyPopupI18n() {
    document.documentElement.lang = getUILanguage().replace("_", "-");
    document.title = t("extensionShortName", "Claude Export");
    if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.translateDOM === "function") {
      globalThis.CHATVAULT_I18N.translateDOM();
    }

    setText("#btn-upgrade-vip", "btn_upgrade", "Upgrade To Pro");
    setText("#login-btn span", "popup_btn_login", "Sign In");

    setText("#unsupported-overlay h3", "popup_unsupported_title", "Unsupported Page");
    setText("#unsupported-overlay p", "popup_unsupported_desc", "Use this extension on one of these AI chat pages:");
    setText("#btn-open-chatgpt", "popup_open_chatgpt", "Open Claude");

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
      oneClickTitle.firstChild.nodeValue = t("popup_one_click_export", "One-Click Export");
    }
    setText("#btn-copy-json", "popup_copy_json", "Copy JSON");
    setText('[data-format="pdf"] small', "popup_format_pdf_hint", "Formatted save");
    setText('[data-format="word"] small', "popup_format_word_hint", "Editable");
    setText('[data-format="markdown"] small', "popup_format_markdown_hint", "Knowledge base");
    setText('[data-format="html"] .format-name', "format_html", "HTML");
    setText('[data-format="html"] small', "popup_format_html_hint", "Offline webpage");
    setText('[data-format="image"] .format-name', "format_image", "Image");
    setText('[data-format="image"] small', "popup_format_image_hint", "Share card");
    setText('[data-format="txt"] .format-name', "popup_format_text_name", "Text");
    setText('[data-format="txt"] small', "popup_format_text_hint", "Plain content");
    setText('[data-format="json"] small', "popup_format_json_hint", "Structured");

    setText(".privacy-text strong", "popup_privacy_title", "100% local and private");
    setText(".privacy-text span", "popup_privacy_desc", "All parsing and exports happen locally in your browser. Your chat data is not uploaded.");
    setText(".contact-text-title", "popup_contact_title", "Need help?");
    setText(".contact-text-desc", "popup_contact_desc", "Have any questions? Feel free to reach out to us.");
    setText("#quota-status-info", "popup_quota_loading", "Loading usage quota...");

    var connectionsTitle = document.querySelector("#connection-settings-card h3");
    if (connectionsTitle) connectionsTitle.textContent = t("connections_title", obsidianText("Connections", "连接管理"));
    setText("#theme-settings-title", "export_theme_label", "Export Theme & Styling");
    setText("#theme-tooltip-text", "export_theme_tooltip", "Themes apply only to PDF and Image exports. Other formats are not affected.");
    setAriaLabel("#theme-help-tooltip", "export_theme_tooltip", "Themes apply only to PDF and Image exports. Other formats are not affected.");
    setText('[data-theme="default"] .theme-name', "export_theme_default", "Minimalist");
    setText('[data-theme="natural"] .theme-name', "export_theme_natural", "Natural");
    setText('[data-theme="midnight"] .theme-name', "export_theme_midnight", "Midnight Dark");
    setText('[data-theme="editorial"] .theme-name', "export_theme_editorial", "Editorial");
    setText('[data-theme="terminal"] .theme-name', "export_theme_terminal", "Terminal");
    setText('[data-theme="newsprint"] .theme-name', "export_theme_newsprint", "Newsprint");
    setText('[data-theme="aurora"] .theme-name', "export_theme_aurora", "Aurora");
    setText('[data-theme="mckinsey"] .theme-name', "export_theme_mckinsey", "McKinsey");
    setText('[data-theme="oxford"] .theme-name', "export_theme_oxford", "Oxford");

    setText("#content-export-settings-card h3", "popup_settings_section_title", "Content Export Settings");
    setSettingTexts("toggle-title", "export_opt_title", "Conversation Title", "popup_title_desc", "Show the conversation title at the top of the document");
    setSettingTexts("toggle-time", "export_opt_time", "Export Time", "popup_time_desc", "Insert an export timestamp in the document header");
    setSettingTexts("toggle-ai-only", "export_opt_ai_only", "AI Replies Only", "popup_ai_only_desc", "Filter user prompts and keep only AI replies");
    setSettingTexts("toggle-watermark", "popup_watermark_title", "Hide Claude Export Watermark", "popup_watermark_desc", "Remove the Claude Export signature from the document end (Pro)");
    setSettingTexts("toggle-source-url", "export_opt_url", "Source URL", "popup_source_url_desc", "Append the original conversation URL to the exported document");
    setSettingTexts("toggle-platform-name", "export_opt_platform", "Platform Name", "popup_platform_name_desc", "Show the source platform in the document header");
    setSettingTexts("toggle-role-labels", "export_opt_role", "Role Labels", "popup_role_labels_desc", "Show User / Assistant labels before chat content");
    setSettingTexts("toggle-align-right", "export_opt_align_right", "Align My Questions Right", "popup_align_right_desc", "Right-align your questions in PDF and image exports");
    setSettingTexts("toggle-obsidian-sync", "popup_show_obsidian_sync", obsidianText("Show Obsidian Sync", "显示 Obsidian 同步"), "popup_show_obsidian_sync_desc", obsidianText("Show single and batch Obsidian sync in the export panel", "在导出面板显示单个与批量 Obsidian 同步"));
    var languageTitle = document.querySelector(".language-settings-copy .toggle-title");
    if (languageTitle) languageTitle.textContent = t("language_label", "Language");
    setText('#ui-language-select option[value="system"]', "popup_language_system", "System Default");
    var notionHeading = document.querySelector(".notion-sync-heading h3");
    if (notionHeading) notionHeading.textContent = t("save_to_notion", obsidianText("Save to Notion", "保存到 Notion"));
    var notionDisclosure = t(
      "notion_data_disclosure",
      "When you sync, the selected conversation and included images are sent directly to your connected Notion workspace. $1 does not receive or store this content.",
      productName
    );
    var notionTooltipText = document.getElementById("notion-tooltip-text");
    if (notionTooltipText) notionTooltipText.textContent = notionDisclosure;
    var notionHelpTooltip = document.getElementById("notion-help-tooltip");
    if (notionHelpTooltip) notionHelpTooltip.setAttribute("aria-label", notionDisclosure);
    setText("#btn-oauth-notion", "notion_connect", obsidianText("Connect Notion", "连接 Notion"));
    setText("#btn-connect-notion-settings", "notion_connect", obsidianText("Connect Notion", "连接 Notion"));
    var notionSave = document.getElementById("btn-sync-notion-oauth");
    if (notionSave) notionSave.textContent = t("btn_save", obsidianText("Save", "保存"));
    setText("#btn-disconnect-oauth", "notion_disconnect", obsidianText("Disconnect", "断开连接"));
    var obsidianHeading = document.querySelector(".obsidian-sync-heading h3");
    if (obsidianHeading) obsidianHeading.textContent = t("save_to_obsidian", obsidianText("Save to Obsidian", "保存到 Obsidian"));
    setText("#obsidian-connection-status", "obsidian_sync_subtitle", obsidianText("Local Markdown and assets", "本地 Markdown 与资源"));
    setText("#obsidian-settings-configure", "obsidian_configure", obsidianText("Config Obsidian", "配置 Obsidian"));
    setText("#obsidian-sync-disconnect", "obsidian_disconnect", obsidianText("Disconnect", "断开连接"));

    setTitle('.footer-tab[data-tab-id="dashboard"]', "popup_export_panel_title", "Export panel");
    setText('.footer-tab[data-tab-id="dashboard"] span', "btn_export", "Export");
    setTitle('.footer-tab[data-tab-id="settings"]', "popup_export_settings_title", "Export settings");
    setText('.footer-tab[data-tab-id="settings"] span', "tab_settings", "Settings");

    setText(".subscribe-header h2", "billing_title", "Upgrade To Claude Export Pro");
    setAriaLabel("#btn-close-subscribe", "btn_cancel", "Cancel");
    setText(".subscribe-subtitle", "billing_desc", "Unlock higher local export limits, polished themes, batch workflows, and PDF, Docs, MD and More output.");
    updateSubscribeLoginWarningText();
    setPlanCardTexts("monthly", "billing_badge_monthly", "Monthly Pro", "billing_discount_monthly", "Save 56%", "billing_plan_title_monthly", "Pro Monthly", "billing_cadence_month", "/ month");
    setPlanCardTexts("yearly", "billing_badge_yearly", "Yearly Pro", "billing_discount_yearly", "Save 58%", "billing_plan_title_yearly", "Pro Yearly", "billing_cadence_year", "/ year");
    setText(".recommended-tag", "popup_recommended", "Recommended");
    setPlanCardTexts("lifetime", "billing_badge_lifetime", "Lifetime Pro", "billing_discount_lifetime", "Save 69%", "billing_plan_title_lifetime", "Lifetime Early Bird", "billing_cadence_lifetime", "one-time");
    ["monthly", "yearly", "lifetime"].forEach(updatePlanPriceDisplay);
    setFeatureTexts();
    var subscribeSubmit = document.getElementById("btn-subscribe-submit");
    if (subscribeSubmit) {
      subscribeSubmit.textContent = getCheckoutButtonLabel("yearly");
    }
    setText("#btn-subscribe-restore", "billing_btn_restore", "Restore purchase");
    setText(".subscribe-footnote", "billing_footnote", "Exports are generated locally from the page you choose. Checkout opens on the Claude Export pricing page and is processed by a secure payment processor. Claude Export stores settings, sign-in email, and membership status only. Chat content is never saved.");

    setText(".confirm-modal-header h3", "popup_confirm_logout_title", "Log out");
    setText(".confirm-modal-message", "popup_confirm_logout_message", "Log out of the current account?");
    setText("#confirm-btn-cancel", "btn_cancel", "Cancel");
    setText("#confirm-btn-ok", "btn_confirm", "Confirm");
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
      ["popup_benefit_notion_obsidian", "Notion & Obsidian sync"],
      ["popup_benefit_unlimited_exports", "Unlimited local exports"],
      ["popup_benefit_report_themes", "Publication-grade themes"],
      ["popup_benefit_hide_watermark", "Hide all export watermarks"],
      ["popup_benefit_local_receipts", "Local export receipts"],
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

  function getBillingPlan(planId) {
    var billing = globalThis.CHATVAULT_BILLING;
    return billing && typeof billing.getPlan === "function" ? billing.getPlan(planId) : null;
  }

  function getCheckoutButtonLabel(planId) {
    var plan = getBillingPlan(planId);
    var title = (plan && plan.title) || getPlanTitle(planId);
    var prefix = t("billing_continue_with_plan", "Continue with $1", title);
    if (!plan || !plan.price) return prefix;
    return prefix + " - " + plan.price + (plan.cadence ? " " + plan.cadence : "");
  }

  function updatePlanPriceDisplay(planId) {
    var plan = getBillingPlan(planId);
    var card = document.querySelector('[data-plan-id="' + planId + '"]');
    if (!plan || !card) return;

    var originalPrice = card.querySelector(".plan-price-original");
    var price = card.querySelector(".plan-price");
    var cadence = card.querySelector(".plan-price-cadence");
    var detail = card.querySelector(".plan-price-detail");
    if (originalPrice) originalPrice.textContent = plan.displayOriginalPrice || plan.originalPrice || "";
    if (price) price.textContent = plan.displayPrice || plan.price || "";
    if (cadence) cadence.textContent = plan.displayCadence || plan.cadence || "";
    if (detail) detail.textContent = plan.billingDetail || "";
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
      submitBtn.textContent = getCheckoutButtonLabel(normalizedPlanId);
    }
  }

  function openSubscribePanel(planId) {
    selectSubscribePlan(planId);
    if (typeof showSubscriptionPanel === "function") {
      showSubscriptionPanel();
    }
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

  function clearPendingCheckoutIntent() {
    return storageRemove(pendingCheckoutIntentKey);
  }

  function isTrustedCheckoutUrl(url) {
    try {
      var parsed = new URL(String(url || ""));
      var host = parsed.hostname.toLowerCase();
      return parsed.protocol === "https:" && (
        host === "checkout.paddle.com" ||
        host.endsWith(".paddle.com") ||
        host === "tabpilotpro.com" ||
        host === "www.tabpilotpro.com"
      );
    } catch (error) {
      return false;
    }
  }

  function normalizeRecentCheckoutSession(value, planId, source) {
    if (!value || typeof value !== "object") return null;
    var at = Number(value.at || 0);
    var normalizedPlanId = normalizeSubscribePlanId(planId);
    var normalizedSource = String(source || "popup_subscribe");
    if (!Number.isFinite(at) || Date.now() - at > recentCheckoutSessionMaxAgeMs) return null;
    if (normalizeSubscribePlanId(value.planId) !== normalizedPlanId) return null;
    if (String(value.source || "popup_subscribe") !== normalizedSource) return null;
    if (!isTrustedCheckoutUrl(value.checkoutUrl)) return null;
    return {
      ok: true,
      provider: "paddle",
      checkoutUrl: String(value.checkoutUrl),
      transactionId: value.transactionId || null,
      planId: normalizedPlanId,
      source: normalizedSource,
      reused: true
    };
  }

  async function getRecentCheckoutSession(planId, source) {
    return normalizeRecentCheckoutSession(await storageGet(recentCheckoutSessionKey), planId, source);
  }

  async function saveRecentCheckoutSession(checkout, planId, source) {
    if (!checkout || !isTrustedCheckoutUrl(checkout.checkoutUrl)) return;
    await storageSet({
      [recentCheckoutSessionKey]: {
        at: Date.now(),
        planId: normalizeSubscribePlanId(planId),
        source: String(source || "popup_subscribe"),
        checkoutUrl: checkout.checkoutUrl,
        transactionId: checkout.transactionId || null
      }
    });
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
        // Fix M5: require valid createdAt AND within max age (was inverted, allowing at=0 to always trigger).
        if (createdAt > 0 && Date.now() - createdAt < pendingSubscribeRequestMaxAgeMs) {
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
    latestRemainingQuota = Math.max(0, Number(remainingQuota) || 0);
    latestQuotaKnown = true;
    if (pro) {
      quotaInfo.textContent = t("popup_pro_quota_status", "Unlimited exports available");
      return;
    }
    // Fix M6: use actual daily limit from entitlements config instead of hardcoded "3".
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    var dailyLimit = entitlements?.DEFAULT_FREE_LIMITS?.maxExportsPerDay || 3;
    quotaInfo.textContent = t("popup_quota_remaining", "Today's remaining quota: $1 / $2 exports", remainingQuota, dailyLimit);
  }

  function responseHasAccountIdentity(response) {
    return Boolean(
      response?.email ||
      response?.profile?.email ||
      response?.profile?.id
    );
  }

  async function clearCachedEntitlementState() {
    latestCachedEntitlementState = null;
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    if (entitlements && typeof entitlements.clearCachedState === "function") {
      await entitlements.clearCachedState();
    }
  }

  async function getActiveStoredSessionForResponse(response) {
    if (!responseHasAccountIdentity(response)) {
      return null;
    }

    var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    if (!auth || typeof auth.getStoredSession !== "function") {
      return null;
    }

    var session = await auth.getStoredSession().catch(function () {
      return null;
    });
    if (!hasActiveAuthSession(session)) {
      return null;
    }

    var responseEmail = response.email || response.profile?.email || "";
    var responseUserId = response.profile?.id || "";
    var sessionEmail = session.user?.email || "";
    var sessionUserId = session.user?.id || "";
    var hasComparableIdentity = Boolean(
      (responseEmail && sessionEmail) ||
      (responseUserId && sessionUserId)
    );
    if (!hasComparableIdentity) {
      return null;
    }
    if (responseEmail && sessionEmail && responseEmail !== sessionEmail) {
      return null;
    }
    if (responseUserId && sessionUserId && responseUserId !== sessionUserId) {
      return null;
    }

    return session;
  }

  async function applyVerifiedPopupStateResponse(response, options) {
    if (!response || response.ok === false) {
      return false;
    }

    if (responseHasAccountIdentity(response)) {
      var session = await getActiveStoredSessionForResponse(response);
      if (!session) {
        await clearCachedEntitlementState().catch(function (error) {
          console.warn("Cached entitlement state clear failed:", error);
        });
        await showSignedOutStateImmediately();
        return false;
      }
    }

    return applyPopupStateResponse(response, options);
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
      if (!auth || typeof auth.getStoredSession !== "function") {
        latestCachedEntitlementState = null;
        return false;
      }
      var storedSession = await auth.getStoredSession().catch(function () {
        return null;
      });
      var storedEmail = storedSession?.user?.email || "";
      var storedUserId = storedSession?.user?.id || "";
      var cachedEmail = cached.email || cached.profile?.email || "";
      var cachedUserId = cached.profile?.id || cached.sessionUser?.id || "";
      // SECURITY: Require identity match. Empty fields are tolerated (treated as wildcard) but at least one identity field must be present and non-empty fields must match.
      var sessionMatchesCache = hasActiveAuthSession(storedSession) &&
        (storedEmail || storedUserId) &&
        (cachedEmail || cachedUserId) &&
        (!storedEmail || !cachedEmail || storedEmail === cachedEmail) &&
        (!storedUserId || !cachedUserId || storedUserId === cachedUserId);
      if (!sessionMatchesCache) {
        await clearCachedEntitlementState();
        return false;
      }

      latestCachedEntitlementState = cached;
      isProUser = !!cached.isProUser;
      // 历史 bug：cached.session 没有 access_token（entitlements.js 构造时仅含 user 字段），
      // 直接传给 updateLocalUI 会让 hasActiveAuthSession 返回 false，UI 显示"未登录"。
      // 修复：上方 sessionMatchesCache 已校验 storedSession 有 access_token 且身份匹配 cached，
      // 优先传 storedSession 让登录态正确显示，cached.session 仅作兜底。
      updateLocalUI(storedSession || cached.session, cached.profile, cached.remainingQuota);
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
    if (!responseHasAccountIdentity(response)) {
      clearCachedEntitlementState().catch(function (error) {
        console.warn("Cached entitlement state clear failed:", error);
      });
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
    latestCachedEntitlementState = {
      profile: profile,
      usage: response.dailyUsage || {},
      sessionUser: sessionUser,
      remainingQuota: response.remainingQuota,
      isProUser: !!response.isProUser
    };
    latestRemainingQuota = Math.max(0, Number(response.remainingQuota) || 0);
    latestQuotaKnown = true;

    entitlements.saveCachedState({
      profile: profile,
      usage: response.dailyUsage || {},
      sessionUser: sessionUser
    }).catch(function (error) {
      console.warn("Cached entitlement state save failed:", error);
    });
  }

  function applyExportSettingsToControls(settings) {
    if (!settings || typeof settings !== "object") {
      return false;
    }

    localSettings = { ...localSettings, ...settings };
    setToggleChecked("toggle-title", !!localSettings.show_conversation_title);
    setToggleChecked("toggle-time", !!localSettings.show_export_time);
    setToggleChecked("toggle-ai-only", !!localSettings.export_ai_replies_only);
    setToggleChecked("toggle-watermark", !localSettings.show_chatvault_badge);
    setToggleChecked("toggle-source-url", !!localSettings.include_source_url);
    setToggleChecked("toggle-platform-name", !!localSettings.show_platform_name);
    setToggleChecked("toggle-role-labels", !!localSettings.show_role_labels);
    setToggleChecked("toggle-align-right", !!localSettings.align_user_messages_right);

    var style = localSettings.export_style || "default";
    var matchedTheme = false;
    document.querySelectorAll(".theme-option").forEach(function (opt) {
      var active = opt.getAttribute("data-theme") === style;
      opt.classList.toggle("active", active);
      if (active) matchedTheme = true;
    });
    if (!matchedTheme) {
      var defaultTheme = document.querySelector('.theme-option[data-theme="default"]');
      if (defaultTheme) defaultTheme.classList.add("active");
      localSettings.export_style = "default";
    }
    return true;
  }

  async function loadPersistedExportSettingsIntoPopup() {
    if (!chrome?.storage?.local) {
      return false;
    }
    try {
      var stored = await new Promise(function (resolve) {
        chrome.storage.local.get(exportSettingsStorageKey, function (result) {
          resolve(result || {});
        });
      });
      return applyExportSettingsToControls(stored[exportSettingsStorageKey]);
    } catch (error) {
      console.warn("Failed to restore export settings in popup:", error);
      return false;
    }
  }

  function applyPopupStateResponse(response, options) {
    if (!response || response.ok === false) {
      return false;
    }
    if (locallySignedOut && responseHasAccountIdentity(response)) {
      return false;
    }

    cacheEntitlementStateFromResponse(response);

    // 更新账号登录态与配额状态
    var loginBtn = document.getElementById("login-btn");
    var isLoggedIn = responseHasAccountIdentity(response);
    var email = response.email || response.profile?.email || "";
    var avatarUrl = response.avatarUrl || "";
    var actualPro = isLoggedIn && !!response.isProUser;

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

    // Once the user changes a setting in this popup, delayed state responses
    // must not restore an older theme or toggle snapshot.
    if (!(options && options.preserveLocalSettings)) {
      applyExportSettingsToControls(response.exportSettings);
    }

    return true;
  }

  function listenContentEntitlementUpdates() {
    if (!chrome?.runtime?.onMessage || typeof chrome.runtime.onMessage.addListener !== "function") {
      return;
    }

    chrome.runtime.onMessage.addListener(function (message, sender) {
      if (!message || message.type !== "CHATVAULT_ENTITLEMENT_STATE_UPDATED") {
        return;
      }
      if (activeTabId && sender?.tab?.id && sender.tab.id !== activeTabId) {
        return;
      }

      applyVerifiedPopupStateResponse(message.state || message, {
        preserveLocalSettings: localSettingsRevision > 0
      }).catch(function (error) {
        console.warn("Failed to apply entitlement state update:", error);
      });
    });
  }

  async function getLocalFreeQuotaGateState() {
    if (isProUser) {
      return { exhausted: false, remainingQuota: latestRemainingQuota };
    }

    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    var usageStore = globalThis.CHATVAULT_USAGE_STORE;
    if (!entitlements || !usageStore || typeof usageStore.getDailyUsage !== "function") {
      return { exhausted: latestQuotaKnown && latestRemainingQuota <= 0, remainingQuota: latestRemainingQuota };
    }

    var profile = latestCachedEntitlementState && latestCachedEntitlementState.profile
      ? latestCachedEntitlementState.profile
      : entitlements.normalizeProfile({ plan: "free" });
    if (entitlements.isPro(profile)) {
      return { exhausted: false, remainingQuota: latestRemainingQuota };
    }

    var usage = await usageStore.getDailyUsage().catch(function () {
      return null;
    });
    var remaining = entitlements.getRemainingFreeExports(profile, usage || {});
    latestRemainingQuota = remaining;
    latestQuotaKnown = true;
    return { exhausted: remaining <= 0, remainingQuota: remaining };
  }

  function sessionMatchesCachedState(session, cachedState) {
    if (!session || !cachedState) return false;
    var sessionEmail = session.user?.email || "";
    var sessionUserId = session.user?.id || "";
    if (!sessionEmail && !sessionUserId) return false;
    // SECURITY: Require strict identity match. Reject cache entries with empty
    // identity to prevent impersonation via crafted cache (C3).
    var cachedEmail = cachedState.email || cachedState.profile?.email || "";
    var cachedUserId = cachedState.profile?.id || cachedState.sessionUser?.id || "";
    if (!cachedEmail && !cachedUserId) return false;
    var emailMatches = !sessionEmail || !cachedEmail || cachedEmail === sessionEmail;
    var userIdMatches = !sessionUserId || !cachedUserId || cachedUserId === sessionUserId;
    return emailMatches && userIdMatches;
  }

  async function getStoredAuthSessionSnapshot() {
    var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    if (!auth) return null;

    if (typeof auth.getStoredSession === "function") {
      var storedSession = await auth.getStoredSession().catch(function () {
        return null;
      });
      if (storedSession) return storedSession;
    }

    if (typeof auth.getSession === "function") {
      return auth.getSession({ skipUserRefresh: true, allowStaleOnError: true }).catch(function () {
        return null;
      });
    }

    return null;
  }

  async function getCachedProfileForSession(session) {
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    if (!entitlements) return null;

    if (sessionMatchesCachedState(session, latestCachedEntitlementState)) {
      return latestCachedEntitlementState;
    }

    if (typeof entitlements.getCachedState !== "function") {
      return null;
    }

    var cached = await entitlements.getCachedState().catch(function () {
      return null;
    });
    if (!sessionMatchesCachedState(session, cached)) {
      return null;
    }

    latestCachedEntitlementState = cached;
    return cached;
  }

  async function getLocalUsageSnapshot() {
    var usageStore = globalThis.CHATVAULT_USAGE_STORE;
    if (!usageStore || typeof usageStore.getDailyUsage !== "function") {
      return null;
    }
    return usageStore.getDailyUsage().catch(function () {
      return null;
    });
  }

  async function mergeVerifiedUsageWithLocal(usage) {
    var usageStore = globalThis.CHATVAULT_USAGE_STORE;
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    if (!usage || typeof usage !== "object") {
      return getLocalUsageSnapshot();
    }
    if (usageStore && typeof usageStore.setDailyUsage === "function") {
      return usageStore.setDailyUsage(usage).catch(function () {
        return getLocalUsageSnapshot();
      });
    }
    if (entitlements && typeof entitlements.normalizeDailyUsage === "function") {
      return entitlements.normalizeDailyUsage(usage);
    }
    return usage;
  }

  async function showStoredAuthStateImmediately() {
    var session = await getStoredAuthSessionSnapshot();
    if (!hasActiveAuthSession(session)) {
      return false;
    }
    locallySignedOut = false;

    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    var cached = await getCachedProfileForSession(session);
    var profile = cached?.profile || null;
    var usage = cached?.usage || await getLocalUsageSnapshot();
    var remainingQuota = cached ? cached.remainingQuota : latestRemainingQuota;

    if (entitlements) {
      if (!profile) {
        profile = entitlements.normalizeProfile({
          id: session.user?.id || "",
          email: session.user?.email || "",
          plan: "free"
        });
      }
      isProUser = entitlements.isPro(profile);
      if (!cached || !Number.isFinite(Number(remainingQuota))) {
        remainingQuota = entitlements.getRemainingFreeExports(profile, usage || {});
      }
    } else {
      isProUser = false;
    }

    updateLocalUI(session, profile, remainingQuota);

    var loginWarning = document.getElementById("subscribe-login-warning");
    if (loginWarning) {
      loginWarning.style.display = "none";
    }

    return true;
  }

  async function showSignedOutStateImmediately() {
    locallySignedOut = true;
    latestCachedEntitlementState = null;
    isProUser = false;

    notionConfig = {
      mode: "unlinked",
      connections: [],
      dataSources: [],
      connectionId: "",
      dataSourceId: "",
      databaseId: "",
      workspaceName: ""
    };
    try {
      await new Promise((resolve) => chrome.storage.local.remove([
        NOTION_UI_CACHE_KEY,
        NOTION_SELECTED_CONNECTION_ID_KEY,
        NOTION_SELECTED_DATA_SOURCES_KEY
      ], resolve));
    } catch (err) {}
    updateNotionUI();

    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    var usage = await getLocalUsageSnapshot();
    var profile = entitlements ? entitlements.normalizeProfile({ plan: "free" }) : null;
    var remainingQuota = entitlements ? entitlements.getRemainingFreeExports(profile, usage || {}) : latestRemainingQuota;
    updateLocalUI(null, profile, remainingQuota);
  }

  function getStorageChange(changes, key) {
    return changes && Object.prototype.hasOwnProperty.call(changes, key) ? changes[key] : null;
  }

  function listenAuthStorageChanges() {
    if (authStorageListenerAttached) {
      return;
    }
    authStorageListenerAttached = true;

    try {
      if (!chrome?.storage?.onChanged || typeof chrome.storage.onChanged.addListener !== "function") {
        return;
      }

      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== "local") {
          return;
        }

        var sessionChange = getStorageChange(changes, supabaseSessionStorageKey);
        var entitlementChange = getStorageChange(changes, entitlementStateCacheKey);
        if (!sessionChange && !entitlementChange) {
          return;
        }

        if (sessionChange) {
          if (sessionChange.newValue) {
            showStoredAuthStateImmediately().catch(function (error) {
              console.warn("Failed to apply updated auth session:", error);
            });
          } else {
            showSignedOutStateImmediately().catch(function (error) {
              console.warn("Failed to apply signed-out auth state:", error);
            });
          }
          return;
        }

        showStoredAuthStateImmediately().catch(function (error) {
          console.warn("Failed to apply updated entitlement state:", error);
        });
      });
    } catch (error) {
      console.warn("Auth storage change listener unavailable:", error);
    }
  }

  async function blockExportIfFreeQuotaExhausted() {
    var gate = await getLocalFreeQuotaGateState();
    if (!gate.exhausted) {
      return false;
    }

    showToast(t("popup_free_quota_exhausted", "You have used today's 3 free exports."));
    if (typeof showSubscriptionPanel === "function") {
      showSubscriptionPanel();
    }
    return true;
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

  function applyObsidianSyncVisibility(visible) {
    obsidianSyncVisible = visible !== false;
    var section = document.getElementById("obsidian-sync-section");
    var toggle = document.getElementById("toggle-obsidian-sync");
    if (section) section.style.display = obsidianSyncVisible && obsidianUiReady ? "block" : "none";
    if (toggle) toggle.checked = obsidianSyncVisible;
  }

  function loadObsidianSyncVisibility() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(obsidianVisibilityStorageKey, function (stored) {
        var visible = !stored || stored[obsidianVisibilityStorageKey] !== false;
        applyObsidianSyncVisibility(visible);
        resolve(visible);
      });
    });
  }

  function saveObsidianSyncVisibility(visible) {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [obsidianVisibilityStorageKey]: visible !== false }, resolve);
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

  function getCurrentExportSettingsFromPopup() {
    var themeOption = document.querySelector(".theme-option.active");
    return {
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
  }

  function bindThemeSelection() {
    var themeGrid = document.querySelector(".settings-theme-grid");
    if (!themeGrid || themeGrid.dataset.bound === "true") {
      return;
    }
    themeGrid.dataset.bound = "true";
    document.querySelectorAll(".theme-option").forEach(function (opt) {
      opt.addEventListener("click", function () {
        var theme = opt.getAttribute("data-theme");
        if (!isProUser && theme !== "default" && theme !== "natural") {
          if (typeof showSubscriptionPanel === "function") {
            showSubscriptionPanel();
          }
          return;
        }
        document.querySelectorAll(".theme-option").forEach(function (item) {
          item.classList.remove("active");
        });
        opt.classList.add("active");
        updateSettingsOnPage();
      });
    });
    themeGrid.classList.remove("is-initializing");
    themeGrid.setAttribute("aria-busy", "false");
  }

  function ensureSubscriptionPanelOpener() {
    if (typeof showSubscriptionPanel === "function") {
      return;
    }
    var subscribePanel = document.getElementById("panel-subscribe");
    showSubscriptionPanel = function () {
      if (subscribePanel) {
        subscribePanel.style.display = "flex";
        updateSubscriptionUIState();
      }
    };
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (globalThis.CHATVAULT_I18N && typeof globalThis.CHATVAULT_I18N.ready === "function") {
      await globalThis.CHATVAULT_I18N.ready();
    }
    applyPopupI18n();
    await loadPersistedExportSettingsIntoPopup();
    var languageSelect = document.getElementById("ui-language-select");
    if (languageSelect && globalThis.CHATVAULT_I18N) {
      languageSelect.value = globalThis.CHATVAULT_I18N.getSelectedLanguage?.() || "system";
      languageSelect.addEventListener("change", async function () {
        languageSelect.disabled = true;
        try {
          await globalThis.CHATVAULT_I18N.setLanguage(languageSelect.value);
          location.reload();
        } catch (error) {
          languageSelect.disabled = false;
          showToast(error?.message || t("popup_language_change_failed", "Could not change language."));
        }
      });
    }
    await loadObsidianSyncVisibility();
    listenAuthStorageChanges();
    listenContentEntitlementUpdates();
    const restoredStoredAuth = await showStoredAuthStateImmediately();
    const notionInitialization = initializeNotionSyncUI();
    // Settings always needs the persisted Vault status, even when the dashboard
    // Obsidian section has been hidden with the visibility toggle.
    const obsidianInitialization = initializeObsidianSyncUI();
    if (!restoredStoredAuth) {
      await hydrateCachedEntitlementState();
    }
    ensureSubscriptionPanelOpener();
    bindThemeSelection();

    // Notion renders from its safe local UI cache while the connection and
    // Database list are refreshed silently in the background.
    await notionInitialization;
    await obsidianInitialization;

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
      refreshObsidianStatus().catch(function (error) {
        console.warn("[Obsidian Sync] Could not refresh selection status:", error);
      });

      // 确定平台标签
      var box = document.querySelector('[data-platform-id="' + activePlatform + '"]');
      if (box) box.classList.add("active");

      // Cached state is already shown above; the supported page must be the source of truth.
      fetchStateFromPage(false);
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
      btn.addEventListener("click", async function () {
        var format = btn.getAttribute("data-format");
        if (!requireSupportedPage()) return;
        if (await blockExportIfFreeQuotaExhausted()) return;

        var currentSettings = getCurrentExportSettingsFromPopup();

        sendMessageToActivePage({
          type: "CHATVAULT_POPUP_EXPORT",
          format: format,
          settings: currentSettings
        }, {
          closeImmediately: true
        });
      });
    });

    var copyJsonButton = document.getElementById("btn-copy-json");
    if (copyJsonButton) {
      copyJsonButton.addEventListener("click", async function () {
        if (!requireSupportedPage()) return;
        if (await blockExportIfFreeQuotaExhausted()) return;
        copyJsonButton.disabled = true;
        sendMessageToActivePage({
          type: "CHATVAULT_POPUP_EXPORT",
          format: "json",
          copyToClipboard: true,
          settings: getCurrentExportSettingsFromPopup()
        }, {
          closeImmediately: true,
          onError: function () { copyJsonButton.disabled = false; }
        });
      });
    }

    // 5. 绑定自定义选择导出
    document.getElementById("banner-custom-export").addEventListener("click", async function () {
      if (await blockExportIfFreeQuotaExhausted()) return;
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
              return;
            }
          }
          updateSettingsOnPage();
        });
      }
    });

    var obsidianVisibilityToggle = document.getElementById("toggle-obsidian-sync");
    if (obsidianVisibilityToggle) {
      obsidianVisibilityToggle.addEventListener("change", async function () {
        var visible = obsidianVisibilityToggle.checked;
        applyObsidianSyncVisibility(visible);
        await saveObsidianSyncVisibility(visible);
        if (visible) initializeObsidianSyncUI().catch(function (error) {
          console.warn("[Obsidian Sync] UI initialization failed:", error);
        });
      });
    }

    // === VIP 订阅面板内嵌绑定逻辑 ===
    var subscribePanel = document.getElementById("panel-subscribe");
    ensureSubscriptionPanelOpener();

    var proCrown = document.getElementById("pro-crown-indicator");
    if (proCrown) {
      proCrown.onclick = function (e) {
        if (e) e.preventDefault();
        showSubscriptionPanel();
      };
    }

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

      submitBtn.disabled = false;
      var planVal = checkedRadio.value;
      submitBtn.textContent = getCheckoutButtonLabel(planVal);

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
          await signInBeforeCheckoutOnly({ skipSignInConfirm: true });
          updateSubscriptionUIState();
          showToast(t("popup_checkout_signed_in_retry", "Signed in. Select your plan and click Continue again to open checkout."));
        } catch (err) {
          // Closing or declining Google OAuth is normal cancellation, not an
          // extension error. Real sign-in failures remain visible to the user.
          if (isAuthCancelledError(err)) return;
          console.error("Checkout sign-in error:", err);
          showToast(getCheckoutErrorMessage(err));
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
          var checkoutResult = await openAuthenticatedCheckout(planId, source);
          if (checkoutResult && checkoutResult.signedInOnly) {
            updateSubscriptionUIState();
            showToast(t("popup_checkout_signed_in_retry", "Signed in. Select your plan and click Continue again to open checkout."));
            return;
          }
          window.close();
        } catch (err) {
          console.error("Checkout error:", err);
          if (isAuthCancelledError(err)) {
            return;
          }
          if (isAuthRequiredError(err) || isLoginError(err)) {
            showToast(err && err.message ? err.message : t("popup_subscribe_signin_confirm", "Sign in with Google first to bind Pro access automatically before checkout."));
          } else {
            showToast(t("popup_checkout_error", "Checkout failed: $1", getCheckoutErrorMessage(err)));
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
          showToast(t("popup_restore_login_required", "Please sign in first, then restore purchase to sync your Pro status."));
          return;
        }

        subscribeRestoreBtn.disabled = true;
        var originalText = subscribeRestoreBtn.textContent;
        subscribeRestoreBtn.textContent = t("popup_restoring", "Restoring...");

        try {
          var api = globalThis.CHATVAULT_SUPABASE_API;
          if (api && session.access_token) {
            await api.request("/functions/v1/product-sync-subscription-status", {
              accessToken: session.access_token,
              method: "POST",
              body: {
                product_id: productConfig.productId,
                product_slug: productConfig.productSlug,
                product_name: productConfig.productName
              }
            });
            showToast(t("popup_restore_submitted", "Restore request submitted. Close and reopen the popup to see the latest status."));
            if (isSupportedPage && activeTabId) {
              fetchStateFromPage(true);
            } else {
              loadStateLocally();
            }
            if (subscribePanel) subscribePanel.style.display = "none";
          } else {
            showToast(t("popup_service_unavailable", "Service is unavailable. Please try again later."));
          }
        } catch (err) {
          console.error("Restore error:", err);
          showToast(t("popup_restore_failed", "Restore purchase failed: $1", err && err.message ? err.message : t("popup_try_later", "Please try again later.")));
        } finally {
          subscribeRestoreBtn.disabled = false;
          subscribeRestoreBtn.textContent = originalText;
        }
      };
    }

    // === 批量导出逻辑 ===
    var batchBtn = document.getElementById("banner-batch-export");

    if (batchBtn) {
      batchBtn.addEventListener("click", async function () {
        if (!requireSupportedPage()) return;
        if (await blockExportIfFreeQuotaExhausted()) return;

        // Send a message to the content script to display the in-page batch export modal using safe wrapper
        sendMessageToActivePage({ type: "CHATVAULT_SHOW_BATCH_EXPORT" });
      });
    }

    maybeOpenPendingSubscribePanel();
    clearPendingCheckoutIntent();
  });

  function showUnsupportedPage() {
    isSupportedPage = false;
    activePlatform = "";
    hideUnsupportedPage();
    document.querySelectorAll(".platform-icon-box").forEach(function (box) {
      box.classList.remove("active");
    });
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
    if (host === "chatgpt.com" || host === "chat.openai.com") return "chatgpt";
    if (host === "gemini.google.com") return "gemini";
    if (host === "claude.ai" || host.endsWith(".claude.ai")) return "claude";
    return "";
  }

  function requireSupportedPage() {
    if (isSupportedPage && activeTabId) return true;
    showUnsupportedToast();
    return false;
  }

  function showUnsupportedToast() {
    showToast(t("toast_no_open_chat", "Open and load a Claude conversation to export."));
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
    if (options.closeImmediately) {
      try { window.close(); } catch (e) {}
    }
    chrome.tabs.sendMessage(activeTabId, payload, function (response) {
      if (chrome.runtime.lastError) {
        if (typeof options.onError === "function") options.onError(chrome.runtime.lastError);
        showToast(t("popup_refresh_page_retry", "Please refresh the current AI conversation page and try again."));
        return;
      }
      if (response && response.ok === false) {
        if (typeof options.onError === "function") options.onError(response);
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

  function isAuthCancelledError(error) {
    return !!(error && error.code === "CHATVAULT_AUTH_CANCELLED");
  }

  function isBackendSchemaCacheError(error) {
    var message = String(error && error.message ? error.message : error || "");
    if (error && error.code === "PGRST205") return true;
    if (/Could not find the (?:'|\")?public\.\w+/i.test(message)) return true;
    if (/schema cache miss/i.test(message)) return true;
    return false;
  }

  function isCheckoutRateLimitedError(error) {
    var message = String(error && error.message ? error.message : error || "");
    return (error && Number(error.status) === 429) || /too many checkout attempts/i.test(message);
  }

  function getCheckoutErrorMessage(error) {
    if (isBackendSchemaCacheError(error)) {
      return t("popup_checkout_service_syncing", "Checkout service is updating. Please reopen Claude Export and try again in a moment.");
    }
    if (isCheckoutRateLimitedError(error)) {
      return t("popup_checkout_rate_limited", "Checkout is already being prepared. Please wait a moment and try again.");
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

  function showCheckoutSignInConfirm(options) {
    options = options || {};
    if (options.skipSignInConfirm === true) {
      return Promise.resolve(true);
    }
    return showCustomConfirm(
      t("popup_checkout_signin_title", "Sign in before checkout"),
      t("popup_checkout_signin_message", "Sign in with Google first. After sign-in, click Continue again to open secure checkout."),
      {
        okText: t("popup_checkout_signin_ok", "Sign in"),
        cancelText: t("btn_cancel", "Cancel"),
        variant: "checkout",
        icon: "→"
      }
    );
  }

  async function signInBeforeCheckoutOnly(options) {
    options = options || {};
    var confirmed = await showCheckoutSignInConfirm(options);
    if (!confirmed) {
      throw createPopupFlowError("CHATVAULT_AUTH_CANCELLED", t("popup_subscribe_signin_confirm", "Sign in with Google first to bind Pro access automatically before checkout."));
    }

    var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    if (!auth || typeof auth.signInWithGoogle !== "function") {
      throw createPopupFlowError("CHATVAULT_LOGIN_FAILED", t("popup_login_service_unavailable", "Sign-in is temporarily unavailable. Please refresh and try again."));
    }

    var signedInSession = await auth.signInWithGoogle();
    if (!hasActiveAuthSession(signedInSession)) {
      signedInSession = await auth.getSession?.({ skipUserRefresh: false, allowStaleOnError: false }).catch(function () {
        return null;
      });
    }
    if (!hasActiveAuthSession(signedInSession)) {
      throw createPopupFlowError("CHATVAULT_AUTH_CANCELLED", t("popup_subscribe_signin_confirm", "Sign in with Google first to bind Pro access automatically before checkout."));
    }

    await clearPendingCheckoutIntent();
    await showStoredAuthStateImmediately();
    refreshPopupState(true);
    return signedInSession;
  }

  function openAuthenticatedCheckout(planId, source, options) {
    if (checkoutFlowPromise) {
      return checkoutFlowPromise;
    }
    checkoutFlowPromise = runAuthenticatedCheckout(planId, source, options).finally(function () {
      checkoutFlowPromise = null;
    });
    return checkoutFlowPromise;
  }

  async function runAuthenticatedCheckout(planId, source, options) {
    options = options || {};
    var billing = globalThis.CHATVAULT_BILLING;
    if (!billing || typeof billing.createCheckoutSession !== "function") {
      throw new Error(t("popup_checkout_unavailable", "Could not open checkout. Please try again later."));
    }

    var normalizedPlanId = normalizeSubscribePlanId(planId);
    var auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    var existingSession = auth && typeof auth.getSession === "function"
      ? await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false }).catch(function () { return null; })
      : null;
    if (!hasActiveAuthSession(existingSession)) {
      await signInBeforeCheckoutOnly(options);
      return { ok: true, signedInOnly: true };
    }

    var session = existingSession;
    var cachedCheckout = await getRecentCheckoutSession(normalizedPlanId, source || "popup_subscribe");
    if (cachedCheckout) {
      await openCheckoutTab(cachedCheckout.checkoutUrl);
      await clearPendingCheckoutIntent();
      return cachedCheckout;
    }

    var checkout = await billing.createCheckoutSession({
      accessToken: session.access_token,
      customerEmail: session.user && session.user.email ? session.user.email : "",
      planId: normalizedPlanId,
      source: source || "popup_subscribe"
    });

    if (!checkout || !checkout.checkoutUrl) {
      if (hasActiveAuthSession(session)) {
        await clearPendingCheckoutIntent();
      }
      throw new Error(t("popup_checkout_unavailable", "Could not open checkout. Please try again later."));
    }

    try {
      await saveRecentCheckoutSession(checkout, normalizedPlanId, source || "popup_subscribe");
      await openCheckoutTab(checkout.checkoutUrl);
      await clearPendingCheckoutIntent();
    } catch (error) {
      if (hasActiveAuthSession(session)) {
        await clearPendingCheckoutIntent();
      }
      throw error;
    }
    return checkout;
  }

  function sendLogoutToActivePage() {
    if (!isSupportedPage || !activeTabId || !chrome?.tabs?.sendMessage) {
      return Promise.resolve();
    }

    return new Promise(function (resolve) {
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      };
      var timeoutId = setTimeout(finish, 1500);
      try {
        chrome.tabs.sendMessage(activeTabId, { type: "CHATVAULT_POPUP_LOGOUT" }, function () {
          var err = chrome.runtime.lastError; // Ignore tabs without a live content script.
          finish();
        });
      } catch (e) {
        finish();
      }
    });
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
          t("popup_confirm_logout_message", "Log out of the current account?"),
          {
            okText: t("btn_logout", "Log Out"),
            cancelText: t("btn_cancel", "Cancel"),
            variant: "danger",
            icon: "!"
          }
        );
        if (!confirmed) {
          return;
        }
        await auth.signOut();
        await sendLogoutToActivePage();
        await showSignedOutStateImmediately();
        showToast(t("popup_signed_out", "Signed out."));
        return;
      } else {
        var signedInSession = await auth.signInWithGoogle();
        if (!signedInSession) {
          showToast(t("popup_login_incomplete", "Sign-in was not completed. Please try again."));
          return;
        }
        await showStoredAuthStateImmediately();
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

      applyVerifiedPopupStateResponse(response, {
        preserveLocalSettings: localSettingsRevision > 0
      }).catch(function (error) {
        console.warn("Failed to apply popup state response:", error);
      });
    });
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

    localSettingsRevision += 1;
    localSettings = nextSettings;

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        chrome.storage.local.set({ [exportSettingsStorageKey]: nextSettings });
      } catch (e) {}
    }

    if (!activeTabId || !isSupportedPage) {
      localSettings = nextSettings;
      return;
    }

    chrome.tabs.sendMessage(activeTabId, {
      type: "CHATVAULT_POPUP_UPDATE_SETTINGS",
      settings: nextSettings
    }, function () {
      var lastError = chrome.runtime.lastError;
      if (lastError) {
        showToast(t("popup_refresh_page_retry", "Please refresh the current AI conversation page and try again."));
        return;
      }
      // settings 已同步到 content.js，content.js 端会自动使缓存失效。
      // 不需要在这里再次全量拉取状态（会触发不必要的健康检查和隐私断言计算）。
      // localSettings 在发送消息前已经同步，避免旧异步响应覆盖当前选择。
    });
  }

  // 从本地存储加载状态（针对不支持的页面，无法和 content.js 通信）
  async function fetchVerifiedEntitlementState(session) {
    var api = globalThis.CHATVAULT_SUPABASE_API;
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    if (!api || !entitlements || !session?.access_token) {
      return null;
    }

    try {
      var result = await api.request("/functions/v1/product-verify-export-entitlement", {
        accessToken: session.access_token,
        method: "POST",
        body: {
          product_id: productConfig.productId,
          product_slug: productConfig.productSlug,
          product_name: productConfig.productName,
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

      return {
        profile: profile,
        usage: result.usage || result.data?.usage || null
      };
    } catch (error) {
      if (globalThis.CHATVAULT_DEBUG) {
        console.debug("Verified entitlement state unavailable.", error);
      }
      return null;
    }
  }

  async function refreshVerifiedEntitlementStateInBackground(session) {
    var entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
    if (!session?.access_token || !entitlements) {
      return;
    }

    var verifiedState = await fetchVerifiedEntitlementState(session);
    if (!verifiedState || !verifiedState.profile) {
      return;
    }

    var profile = verifiedState.profile;
    var usage = await mergeVerifiedUsageWithLocal(verifiedState.usage) || {};
    var remainingQuota = entitlements.getRemainingFreeExports(profile, usage || {});
    isProUser = entitlements.isPro(profile);
    latestRemainingQuota = remainingQuota;
    latestQuotaKnown = true;
    updateLocalUI(session, profile, remainingQuota);

    try {
      if (typeof entitlements.saveCachedState === "function") {
        latestCachedEntitlementState = await entitlements.saveCachedState({
          session: session,
          profile: profile,
          usage: usage || {}
        });
      }
    } catch (error) {
      console.warn("Verified entitlement cache save failed:", error);
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
    var shouldRefreshEntitlement = false;

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
      var cacheMatchesUser = profile && (profile.id === session.user.id || profile.email === session.user.email);
      if (!cacheMatchesUser) {
        profile = null;
        shouldRefreshEntitlement = true;
      } else {
        shouldRefreshEntitlement = true;
      }
      if (!profile) {
        profile = entitlements.normalizeProfile({
          id: session.user?.id || "",
          email: session.user?.email || "",
          plan: "free"
        });
      }
    } else if (entitlements && !profile) {
      // session 读取失败时保留已从缓存恢复的 profile，避免把已登录用户
      // 短暂显示成 Free/Sign In（loadStateLocally 在非 AI 网站会被调用，
      // 此时 auth.getSession 可能返回 null，不应覆盖 showStoredAuthStateImmediately
      // 已经显示的头像/Pro 状态，后台刷新会负责同步真实状态）。
      profile = entitlements.normalizeProfile({ plan: "free" });
    }

    try {
      if (usageStore) {
        usage = await usageStore.getDailyUsage();
      }
    } catch (e) {
      console.warn("Local usage loading failed:", e);
    }

    if (entitlements && profile) {
      isProUser = entitlements.isPro(profile);
      remainingQuota = entitlements.getRemainingFreeExports(profile, usage || {});
    }

    // 更新 UI
    // 当 auth.getSession 返回 null（常见于非 AI 网站上的 session 刷新失败），
    // 不能直接传 null 给 updateLocalUI，否则 hasActiveAuthSession(null)=false
    // 会把按钮重置成 "Sign In"，覆盖 showStoredAuthStateImmediately 已经显示的头像。
    // 改用 auth.getStoredSession() 拿到本地存储的 session 快照（不发起网络请求）。
    var sessionForUI = session;
    if (!sessionForUI && auth && typeof auth.getStoredSession === "function") {
      try {
        sessionForUI = await auth.getStoredSession();
      } catch (_e) {
        // ignore — fall back to null below
      }
    }
    updateLocalUI(sessionForUI, profile, remainingQuota);

    if (shouldRefreshEntitlement) {
      refreshVerifiedEntitlementStateInBackground(session).catch(function (error) {
        console.warn("Background entitlement refresh failed:", error);
      });
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
    await showStoredAuthStateImmediately();
    refreshPopupState(true);
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
  function showCustomConfirm(title, message, options) {
    options = options || {};
    return new Promise(function (resolve) {
      var modal = document.getElementById("custom-confirm-modal");
      if (!modal) {
        resolve(false);
        return;
      }

      modal.classList.remove("confirm-modal-checkout", "confirm-modal-danger", "confirm-modal-notion");
      if (options.variant === "checkout") {
        modal.classList.add("confirm-modal-checkout");
      } else if (options.variant === "danger") {
        modal.classList.add("confirm-modal-danger");
      } else if (options.variant === "notion") {
        modal.classList.add("confirm-modal-notion");
      }

      // 更新文本
      var titleEl = modal.querySelector(".confirm-modal-header h3");
      if (titleEl) titleEl.textContent = title;
      var msgEl = modal.querySelector(".confirm-modal-message");
      if (msgEl) msgEl.textContent = message;
      var iconEl = modal.querySelector(".confirm-modal-icon");
      if (iconEl) {
        iconEl.replaceChildren();
        if (options.iconUrl) {
          var iconImage = document.createElement("img");
          iconImage.src = options.iconUrl;
          iconImage.alt = "";
          iconEl.appendChild(iconImage);
        } else {
          iconEl.textContent = options.icon || "?";
        }
      }

      // 显示弹窗并启动渐入动画
      modal.style.display = "flex";
      modal.offsetHeight; // 强制重绘以确保过渡动画生效
      modal.classList.add("active");

      var btnCancel = document.getElementById("confirm-btn-cancel");
      var btnOk = document.getElementById("confirm-btn-ok");
      if (btnCancel) btnCancel.textContent = options.cancelText || t("btn_cancel", "Cancel");
      if (btnOk) btnOk.textContent = options.okText || t("btn_confirm", "Confirm");

      function cleanUp() {
        modal.classList.remove("active");
        setTimeout(function () {
          modal.style.display = "none";
          modal.classList.remove("confirm-modal-checkout", "confirm-modal-danger", "confirm-modal-notion");
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
    var isLoggedIn = hasActiveAuthSession(session);
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

  // ====== Notion Sync UI & Logic Integration ======
  let notionConfig = {
    mode: "unlinked",
    connections: [],
    dataSources: [],
    connectionId: "",
    dataSourceId: "",
    databaseId: "",
    workspaceName: ""
  };
  const NOTION_UI_CACHE_KEY = storageKey("notion_ui_cache.v1");
  const NOTION_SELECTED_CONNECTION_ID_KEY = storageKey("notion_selected_connection_id");
  const NOTION_SELECTED_DATA_SOURCES_KEY = storageKey("notion_selected_data_sources");
  let notionUiInitialized = false;

  function notionCacheUserId(stored) {
    // Fix H10: use namespaced session key to match actual storage.
    return String(stored?.[supabaseSessionStorageKey]?.user?.id || "");
  }

  function safeCachedConnections(connections) {
    return (Array.isArray(connections) ? connections : []).filter((item) => item?.mode === "oauth").slice(0, 20).map((item) => ({
      id: String(item?.id || "").slice(0, 200),
      mode: "oauth",
      workspace_name: String(item?.workspace_name || "").slice(0, 200),
      data_source_id: String(item?.data_source_id || "").slice(0, 200)
    })).filter((item) => item.id);
  }

  function safeCachedDataSources(dataSources) {
    return (Array.isArray(dataSources) ? dataSources : []).slice(0, 500).map((item) => ({
      id: String(item?.id || "").slice(0, 200),
      databaseId: String(item?.databaseId || "").slice(0, 200),
      title: String(item?.title || "Untitled Database").slice(0, 300),
      connectionId: String(item?.connectionId || "").slice(0, 200),
      workspaceName: String(item?.workspaceName || "").slice(0, 200)
    })).filter((item) => item.id && item.connectionId);
  }

  function hydrateNotionUiCache(stored) {
    const cache = stored?.[NOTION_UI_CACHE_KEY];
    if (!cache || cache.version !== 1 || cache.userId !== notionCacheUserId(stored)) return false;
    if (cache.mode !== "oauth" && cache.mode !== "unlinked") return false;
    const connections = safeCachedConnections(cache.connections);
    const dataSources = safeCachedDataSources(cache.dataSources);
    if (cache.mode === "oauth" && !connections.some((item) => item.id === cache.connectionId)) return false;
    notionConfig = {
      mode: cache.mode,
      connections,
      dataSources,
      connectionId: String(cache.connectionId || ""),
      dataSourceId: String(cache.dataSourceId || ""),
      databaseId: String(cache.databaseId || ""),
      workspaceName: String(cache.workspaceName || "")
    };
    return true;
  }

  function buildNotionUiCache(stored) {
    return {
      version: 1,
      userId: notionCacheUserId(stored),
      mode: notionConfig.mode === "oauth" ? "oauth" : "unlinked",
      connections: safeCachedConnections(notionConfig.connections).filter((item) => item.mode === "oauth"),
      dataSources: safeCachedDataSources(notionConfig.dataSources),
      connectionId: notionConfig.connectionId,
      dataSourceId: notionConfig.dataSourceId,
      databaseId: notionConfig.databaseId,
      workspaceName: notionConfig.workspaceName,
      updatedAt: Date.now()
    };
  }

  function notionBackgroundMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) return reject(new Error(lastError.message));
        if (!response || !response.ok) {
          const error = new Error(response?.error || "Notion background request failed.");
          error.status = Number(response?.status || 0);
          error.code = response?.code || "notion_background_error";
          return reject(error);
        }
        resolve(response);
      });
    });
  }

  function getStoredNotionSelection() {
    return new Promise((resolve) => {
      chrome.storage.local.get([
        NOTION_SELECTED_CONNECTION_ID_KEY,
        NOTION_SELECTED_DATA_SOURCES_KEY,
        supabaseSessionStorageKey,
        NOTION_UI_CACHE_KEY,
        "notion_token",
        "notion_db_id"
      ], resolve);
    });
  }

  async function cleanupLegacyManualNotionConfig(stored) {
    if (!stored.notion_token && !stored.notion_db_id) return;
    await new Promise((resolve) => chrome.storage.local.remove(["notion_token", "notion_db_id"], resolve));
  }

  async function loadNotionConfig(storedInput) {
    const stored = storedInput || await getStoredNotionSelection();
    try {
      await cleanupLegacyManualNotionConfig(stored);
    } catch (error) {
      console.warn("[Notion Sync] Legacy manual configuration cleanup failed:", error);
    }

    let connections;
    try {
      const response = await notionBackgroundMessage({ type: "CHATVAULT_NOTION_LIST_CONNECTIONS" });
      connections = (response.connections || []).filter((item) => item?.mode === "oauth");
    } catch (error) {
      console.warn("[Notion Sync] Failed to load connections:", error);
      return false;
    }

    const selectedConnection = connections.find((item) => item.id === stored[NOTION_SELECTED_CONNECTION_ID_KEY]) ||
      connections[0] || null;
    const selectedSources = stored[NOTION_SELECTED_DATA_SOURCES_KEY] || {};
    const availableConnectionIds = new Set(connections.map((item) => item.id));
    const cachedDataSources = (notionConfig.dataSources || []).filter((item) => availableConnectionIds.has(item.connectionId));
    notionConfig.connections = connections;
    notionConfig.dataSources = cachedDataSources;
    notionConfig.connectionId = selectedConnection?.id || "";
    notionConfig.mode = selectedConnection ? "oauth" : "unlinked";
    notionConfig.workspaceName = selectedConnection?.workspace_name || "";
    notionConfig.dataSourceId = selectedSources[notionConfig.connectionId] ||
      cachedDataSources.find((item) => item.connectionId === notionConfig.connectionId && item.id === notionConfig.dataSourceId)?.id ||
      selectedConnection?.data_source_id || "";
    notionConfig.databaseId = cachedDataSources.find((item) => (
      item.connectionId === notionConfig.connectionId && item.id === notionConfig.dataSourceId
    ))?.databaseId || "";
    return true;
  }

  async function saveNotionSelection(storedInput) {
    const stored = storedInput || await getStoredNotionSelection();
    const sources = { ...(stored[NOTION_SELECTED_DATA_SOURCES_KEY] || {}) };
    if (notionConfig.connectionId && notionConfig.dataSourceId) {
      sources[notionConfig.connectionId] = notionConfig.dataSourceId;
    }
    await new Promise((resolve) => chrome.storage.local.set({
      [NOTION_SELECTED_CONNECTION_ID_KEY]: notionConfig.connectionId,
      [NOTION_SELECTED_DATA_SOURCES_KEY]: sources,
      [NOTION_UI_CACHE_KEY]: buildNotionUiCache(stored)
    }, resolve));
  }

  function updateNotionUI() {
    const unlinkedView = document.getElementById("notion-unlinked-view");
    const oauthView = document.getElementById("notion-oauth-view");
    const connectionStatus = document.getElementById("notion-connection-status");
    const settingsStatus = document.getElementById("notion-settings-status");
    const disconnectButton = document.getElementById("btn-disconnect-oauth");
    const settingsConnectButton = document.getElementById("btn-connect-notion-settings");
    if (unlinkedView) unlinkedView.style.display = "none";
    if (oauthView) oauthView.style.display = "none";

    if (notionConfig.mode === "oauth") {
      if (oauthView) oauthView.style.display = "block";
      const connectedLabel = notionConfig.workspaceName || t("notion_connected", "Connected");
      if (connectionStatus) connectionStatus.textContent = connectedLabel;
      if (settingsStatus) settingsStatus.textContent = connectedLabel;
      if (disconnectButton) disconnectButton.hidden = false;
      if (settingsConnectButton) settingsConnectButton.hidden = true;
      renderNotionDataSourceOptions();
    } else {
      if (unlinkedView) unlinkedView.style.display = "block";
      const unlinkedLabel = t("notion_not_connected", obsidianText("Not connected", "尚未连接"));
      if (connectionStatus) connectionStatus.textContent = unlinkedLabel;
      if (settingsStatus) settingsStatus.textContent = unlinkedLabel;
      if (disconnectButton) disconnectButton.hidden = true;
      if (settingsConnectButton) settingsConnectButton.hidden = false;
    }
  }

  async function loadSharedDataSourcesDropdown(options = {}) {
    const dbSelect = document.getElementById("notion-db-select");
    const oauthConnections = (notionConfig.connections || []).filter((item) => item.mode === "oauth");
    if (!dbSelect || !oauthConnections.length) return;
    const previousDataSources = notionConfig.dataSources || [];
    try {
      const responses = await Promise.all(oauthConnections.map(async (connection) => {
        try {
          const response = await notionBackgroundMessage({
            type: "CHATVAULT_NOTION_SEARCH_DATA_SOURCES",
            connectionId: connection.id
          });
          return {
            connectionId: connection.id,
            ok: true,
            dataSources: (response.dataSources || []).map((dataSource) => ({
              ...dataSource,
              connectionId: connection.id,
              workspaceName: connection.workspace_name || ""
            }))
          };
        } catch (error) {
          console.warn("[Notion Sync] Could not load Databases for a connection:", error);
          return { connectionId: connection.id, ok: false, dataSources: [] };
        }
      }));
      const successfulConnections = new Set(responses.filter((item) => item.ok).map((item) => item.connectionId));
      if (!successfulConnections.size && options.preserveExisting === true && previousDataSources.length) {
        renderNotionDataSourceOptions();
        return false;
      }
      const dataSources = [
        ...responses.flatMap((item) => item.dataSources),
        ...previousDataSources.filter((item) => !successfulConnections.has(item.connectionId))
      ];
      notionConfig.dataSources = dataSources;
      let selected = dataSources.find((item) => (
        item.connectionId === notionConfig.connectionId && item.id === notionConfig.dataSourceId
      ));
      if (!selected) {
        selected = dataSources[0] || null;
        // Keep connectionId tied to the active OAuth connection even when no
        // data sources are shared yet. Clearing it would break disconnect and
        // make the UI look like the workspace was never authorized.
        notionConfig.connectionId = selected?.connectionId ||
          (oauthConnections.find((item) => successfulConnections.has(item.id))?.id) ||
          notionConfig.connectionId;
        notionConfig.dataSourceId = selected?.id || "";
      }
      notionConfig.databaseId = selected?.databaseId || "";
      dbSelect.disabled = false;
      renderNotionDataSourceOptions();
      await saveNotionSelection();
      return true;
    } catch (error) {
      if (options.preserveExisting === true && previousDataSources.length) {
        notionConfig.dataSources = previousDataSources;
        renderNotionDataSourceOptions();
      } else {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = t("notion_datasource_fetch_failed", obsidianText(`Fetch failed ($1)`, `拉取失败 ($1)`), error && error.message ? error.message : obsidianText("unknown error", "未知错误"));
        dbSelect.replaceChildren(option);
      }
      return false;
    }
  }

  function renderNotionDataSourceOptions() {
    const dbSelect = document.getElementById("notion-db-select");
    if (!dbSelect) return;
    const dataSources = notionConfig.dataSources || [];
    const helper = document.getElementById("notion-db-helper");
    dbSelect.innerHTML = "";
    if (!dataSources.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("notion_no_data_source", "No authorized Database found");
      dbSelect.appendChild(option);
      dbSelect.disabled = true;
      if (helper) {
        helper.textContent = t("notion_share_database_hint", "Share a Notion Database with the ChatVault connection (open a Database → ⋯ → Connections → add ChatVault), then reopen this popup.");
        helper.style.display = "block";
      }
      return;
    }
    if (helper) helper.style.display = "none";
    const workspaceCount = new Set(dataSources.map((item) => item.connectionId)).size;
    dataSources.forEach((dataSource) => {
      const option = document.createElement("option");
      option.value = `${dataSource.connectionId}:${dataSource.id}`;
      option.dataset.connectionId = dataSource.connectionId || "";
      option.dataset.dataSourceId = dataSource.id || "";
      option.dataset.databaseId = dataSource.databaseId || "";
      option.textContent = workspaceCount > 1 && dataSource.workspaceName
        ? `${dataSource.title} / ${dataSource.workspaceName}`
        : dataSource.title;
      option.selected = dataSource.connectionId === notionConfig.connectionId && dataSource.id === notionConfig.dataSourceId;
      dbSelect.appendChild(option);
    });
    dbSelect.disabled = false;
    dbSelect.onchange = async function () {
      if (!dbSelect.value) return;
      const selectedOption = dbSelect.selectedOptions[0];
      notionConfig.connectionId = selectedOption?.dataset.connectionId || "";
      notionConfig.dataSourceId = selectedOption?.dataset.dataSourceId || "";
      notionConfig.databaseId = selectedOption?.dataset.databaseId || "";
      await saveNotionSelection();
    };
  }

  async function refreshNotionUi(options = {}) {
    const loaded = await loadNotionConfig(options.stored);
    if (!loaded) return false;

    if (notionConfig.mode === "oauth") {
      const hasCachedOauthView = options.cachedMode === "oauth";
      if (hasCachedOauthView) updateNotionUI();
      await loadSharedDataSourcesDropdown({
        preserveExisting: hasCachedOauthView
      });
      updateNotionUI();
      return true;
    }

    updateNotionUI();
    await saveNotionSelection(options.stored);
    return true;
  }

  function notionStatusLabel(status) {
    var map = {
      held: t("notion_status_held", obsidianText("Queued", "准备同步")),
      pending: t("notion_status_pending", obsidianText("Pending", "等待同步")),
      running: t("notion_status_running", obsidianText("Syncing", "正在同步")),
      retry_wait: t("notion_status_retry_wait", obsidianText("Waiting to retry", "等待重试")),
      succeeded: t("notion_status_succeeded", obsidianText("Sync succeeded", "同步成功")),
      partial: t("notion_status_partial", obsidianText("Completed with warnings", "完成但有降级")),
      failed: t("notion_status_failed", obsidianText("Sync failed", "同步失败")),
      cancelled: t("notion_status_cancelled", obsidianText("Cancelled", "已取消"))
    };
    return map[status] || status;
  }

  function renderNotionJob(job) {
    const container = document.getElementById("notion-job-status");
    if (!container) return;
    if (!job) {
      container.style.display = "none";
      return;
    }
    container.style.display = "block";
    container.innerHTML = "";
    const summary = document.createElement("div");
    summary.textContent = `${notionStatusLabel(job.status)} · ${job.progress || 0}%${job.warningCount ? ` · ${t("notion_job_warnings_count", obsidianText("$1 warnings", "$1 个警告"), job.warningCount)}` : ""}`;
    container.appendChild(summary);
    if (job.errorMessage) {
      const error = document.createElement("div");
      error.style.color = "#ef4444";
      error.textContent = job.errorCode ? t(job.errorCode, job.errorMessage) : job.errorMessage;
      container.appendChild(error);
    }
    if (Array.isArray(job.warnings) && job.warnings.length) {
      const warnings = document.createElement("ul");
      warnings.style.margin = "5px 0 0 14px";
      warnings.style.padding = "0";
      job.warnings.slice(0, 3).forEach((warning) => {
        const item = document.createElement("li");
        item.textContent = warning.detail || warning.code;
        warnings.appendChild(item);
      });
      container.appendChild(warnings);
    }
    const actions = document.createElement("div");
    actions.style.marginTop = "5px";
    if (["held", "pending", "running", "retry_wait"].includes(job.status)) {
      const cancel = document.createElement("button");
      cancel.className = "notion-save-btn";
      cancel.textContent = t("notion_cancel_job", obsidianText("Cancel task", "取消任务"));
      cancel.onclick = async () => {
        const response = await notionBackgroundMessage({ type: "CHATVAULT_NOTION_CANCEL_JOB", jobId: job.id });
        renderNotionJob(response.job);
      };
      actions.appendChild(cancel);
    }
    if (job.status === "failed") {
      const retry = document.createElement("button");
      retry.className = "notion-save-btn";
      retry.textContent = t("notion_retry_job", obsidianText("Retry", "重试"));
      retry.onclick = async () => {
        const response = await notionBackgroundMessage({ type: "CHATVAULT_NOTION_RETRY_JOB", jobId: job.id });
        renderNotionJob(response.job);
      };
      actions.appendChild(retry);
    }
    if (["failed", "cancelled", "succeeded", "partial"].includes(job.status)) {
      const clear = document.createElement("button");
      clear.className = "notion-save-btn";
      clear.textContent = t("notion_clear_task", "Clear local task");
      clear.style.marginLeft = "5px";
      clear.onclick = async () => {
        await notionBackgroundMessage({ type: "CHATVAULT_NOTION_CLEAR_JOB", jobId: job.id });
        renderNotionJob(null);
      };
      actions.appendChild(clear);
    }
    if (job.notionPageUrl) {
      const open = document.createElement("button");
      open.className = "notion-save-btn";
      open.textContent = t("notion_open_page", obsidianText("Open Notion", "打开 Notion"));
      open.style.marginLeft = "5px";
      open.onclick = () => {
        try {
          const url = new URL(job.notionPageUrl);
          if (url.protocol === "https:" && (/\.notion\.so$/i.test(url.hostname) || /^notion\.so$/i.test(url.hostname))) {
            chrome.tabs.create({ url: url.toString() });
          }
        } catch (_) {
          // 忽略非法 URL，避免被注入任意页面
        }
      };
      actions.appendChild(open);
    }
    if (actions.childNodes.length) container.appendChild(actions);
  }

  async function loadRecentNotionJobs() {
    try {
      const response = await notionBackgroundMessage({ type: "CHATVAULT_NOTION_LIST_JOBS" });
      renderNotionJob((response.jobs || [])[0] || null);
    } catch (error) {
      console.warn("[Notion Sync] Could not load job status:", error);
    }
  }

  async function triggerNotionSync() {
    if (!requireSupportedPage()) return;
    if (await blockExportIfFreeQuotaExhausted()) return;

    if (!notionConfig.connectionId || !notionConfig.dataSourceId) {
      showToast(t("notion_select_database_first", obsidianText("Please select a Notion Database first.", "请先选择一个 Notion Database。")));
      return;
    }

    const themeOption = document.querySelector(".theme-option.active");
    const currentSettings = {
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
      type: "CHATVAULT_POPUP_NOTION_SYNC",
      config: {
        connectionId: notionConfig.connectionId,
        dataSourceId: notionConfig.dataSourceId,
        databaseId: notionConfig.databaseId,
        alwaysCreate: true,
        settings: currentSettings
      }
    }, function(response) {
      if (response && response.ok) {
        window.close();
      } else {
        showToast(t("notion_sync_request_failed", obsidianText("Sync request failed. Make sure the page is refreshed and ready.", "同步请求发送失败，请确认页面已刷新并且就绪。")));
      }
    });
  }

  let notionOauthInFlight = false;

  async function connectNotionWorkspace() {
    // 防止用户快速重复点击导致并发 OAuth 流程
    if (notionOauthInFlight) return;
    notionOauthInFlight = true;
    const buttons = [
      document.getElementById("btn-oauth-notion"),
      document.getElementById("btn-connect-notion-settings")
    ].filter(Boolean);
    const auth = globalThis.CHATVAULT_SUPABASE_AUTH;
    buttons.forEach((button) => {
      button.disabled = true;
      if (button.id === "btn-oauth-notion") {
        button.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;margin-right:6px;"></span>' + escapeHtml(t("notion_connecting", "Connecting...", "连接中..."));
      }
    });
    try {
      let session = auth ? await auth.getSession({ skipUserRefresh: true }).catch(() => null) : null;
      if (!hasActiveAuthSession(session)) {
        const confirmed = await showCustomConfirm(
          t("onboard_title_login", "Sign in to continue"),
          t("notion_signin_required", "Sign in first. Notion workspace authorization will open automatically after sign-in."),
          {
            okText: t("popup_btn_login", "Sign In"),
            cancelText: t("btn_cancel", "Cancel"),
            variant: "notion",
            iconUrl: chrome.runtime.getURL("images/notion-app-icon.svg")
          }
        );
        if (!confirmed) return;
        if (!auth || typeof auth.signInWithGoogle !== "function") {
          showToast(t("popup_login_service_unavailable", "Sign-in is temporarily unavailable. Please refresh and try again."));
          return;
        }
        try {
          session = await auth.signInWithGoogle();
          if (!hasActiveAuthSession(session)) {
            session = await auth.getSession?.({ skipUserRefresh: false, allowStaleOnError: false }).catch(() => null);
          }
          if (!hasActiveAuthSession(session)) {
            showToast(t("popup_login_incomplete", "Sign-in was not completed. Please try again."));
            return;
          }
          await showStoredAuthStateImmediately();
          refreshPopupState(true);
        } catch (loginError) {
          showToast(t("popup_login_failed", "Sign-in failed: $1", loginError?.message || "Sign-in failed."));
          return;
        }
      }
      showToast(t("notion_oauth_opening", "Opening Notion authorization..."));
      await notionBackgroundMessage({ type: "CHATVAULT_NOTION_START_OAUTH" });
      await refreshNotionUi();
      showToast(t("notion_oauth_success", "Notion connected."));
    } catch (error) {
      showToast(t("notion_oauth_failed", "Notion connection failed: $1", error.message));
    } finally {
      notionOauthInFlight = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function disconnectNotionWorkspace() {
    const button = document.getElementById("btn-disconnect-oauth");
    // notionConfig.connectionId may be empty when loadSharedDataSourcesDropdown
    // found no data sources and cleared the selection. Fall back to the first
    // OAuth connection id so disconnect still works in that state.
    const connectionId = notionConfig.connectionId ||
      (notionConfig.connections || []).find((item) => item?.mode === "oauth")?.id || "";
    if (!connectionId) return;
    if (button) button.disabled = true;
    try {
      await notionBackgroundMessage({
        type: "CHATVAULT_NOTION_DISCONNECT",
        connectionId
      });
      notionConfig = {
        mode: "unlinked",
        connections: [],
        dataSources: [],
        connectionId: "",
        dataSourceId: "",
        databaseId: "",
        workspaceName: ""
      };
      await refreshNotionUi();
      showToast(t("notion_disconnect_success", obsidianText("Notion disconnected.", "已断开 Notion。")));
    } catch (error) {
      showToast(t("notion_disconnect_failed", obsidianText(`Could not disconnect Notion: $1`, `无法断开 Notion：$1`), error && error.message ? error.message : ""));
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function initializeNotionSyncUI() {
    if (notionUiInitialized) return;
    notionUiInitialized = true;
    const notionSection = document.getElementById("notion-sync-section");
    if (notionSection) notionSection.style.display = "block";

    // Bind actions before the silent connection refresh so the cached/unlinked
    // first paint is immediately interactive when the popup is reopened.
    const oauthBtn = document.getElementById("btn-oauth-notion");
    if (oauthBtn) {
      oauthBtn.addEventListener("click", connectNotionWorkspace);
    }
    const settingsConnectBtn = document.getElementById("btn-connect-notion-settings");
    if (settingsConnectBtn) {
      settingsConnectBtn.addEventListener("click", connectNotionWorkspace);
    }
    const syncNotionOauthBtn = document.getElementById("btn-sync-notion-oauth");
    if (syncNotionOauthBtn) {
      syncNotionOauthBtn.addEventListener("click", triggerNotionSync);
    }
    const disconnectOauthBtn = document.getElementById("btn-disconnect-oauth");
    if (disconnectOauthBtn) {
      disconnectOauthBtn.addEventListener("click", disconnectNotionWorkspace);
    }

    const stored = await getStoredNotionSelection();
    const hasCachedUi = hydrateNotionUiCache(stored);
    const cachedMode = hasCachedUi ? notionConfig.mode : "";
    if (!hasCachedUi) {
      notionConfig.mode = "unlinked";
    }
    updateNotionUI();
    const refreshPromise = refreshNotionUi({ stored, cachedMode }).catch((error) => {
      console.warn("[Notion Sync] Silent UI refresh failed:", error);
      return false;
    });
    if (!hasCachedUi) {
      const refreshed = await refreshPromise;
      if (!refreshed) {
        notionConfig.mode = "unlinked";
        updateNotionUI();
      }
    }
  }

  function obsidianBackgroundMessageOnce(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          const error = new Error(lastError.message || "Obsidian background request failed.");
          error._transient = /could not establish connection|receiving end does not exist|message port closed|extension context invalidated/i.test(lastError.message || "");
          return reject(error);
        }
        if (!response || !response.ok) {
          const error = new Error(response?.error || "Obsidian background request failed.");
          error.code = response?.code || "obsidian_error";
          return reject(error);
        }
        resolve(response);
      });
    });
  }

  async function obsidianBackgroundMessage(payload) {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await obsidianBackgroundMessageOnce(payload);
      } catch (error) {
        if (!error._transient || attempt >= maxRetries) throw error;
        await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
      }
    }
  }

  function obsidianPageMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!activeTabId || !isSupportedPage) return reject(new Error("Open a supported AI conversation first."));
      chrome.tabs.sendMessage(activeTabId, payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) return reject(new Error(lastError.message || "Could not reach the conversation page."));
        if (!response || response.ok === false) return reject(new Error(response?.error || "Obsidian page request failed."));
        resolve(response);
      });
    });
  }

  function openObsidianSettings() {
    const suffix = activeTabId ? `?returnTabId=${encodeURIComponent(activeTabId)}` : "";
    chrome.tabs.create({ url: chrome.runtime.getURL(`src/obsidian-settings.html${suffix}`) });
    window.close();
  }

  function getObsidianCurrentSettings() {
    return {
      show_conversation_title: document.getElementById("toggle-title")?.checked !== false,
      show_export_time: document.getElementById("toggle-time")?.checked !== false,
      export_ai_replies_only: document.getElementById("toggle-ai-only")?.checked === true,
      include_source_url: document.getElementById("toggle-source-url")?.checked === true,
      show_platform_name: document.getElementById("toggle-platform-name")?.checked !== false,
      show_role_labels: document.getElementById("toggle-role-labels")?.checked !== false
    };
  }

  function getObsidianSelectionStatus() {
    if (!activeTabId || !isSupportedPage) return Promise.resolve({ selectedCount: 0, selectionMode: false });
    return obsidianPageMessage({ type: "CHATVAULT_OBSIDIAN_SELECTION_STATUS" })
      .catch(() => ({ selectedCount: 0, selectionMode: false }));
  }

  function renderObsidianStatus(status, selection) {
    const main = document.querySelector(".obsidian-sync-main");
    const state = document.getElementById("obsidian-sync-state");
    const current = document.getElementById("obsidian-sync-current");
    const disconnect = document.getElementById("obsidian-sync-disconnect");
    const configure = document.getElementById("obsidian-settings-configure");
    const connectionStatus = document.getElementById("obsidian-connection-status");
    const settingsStatus = document.getElementById("obsidian-settings-status");
    if (!state || !current) return;
    const isConnected = Boolean(status?.connected);
    const selectedCount = Math.max(0, Number(selection?.selectedCount || 0));
    const selectionMode = Boolean(selection?.selectionMode);
    main?.classList.toggle("is-unconfigured", !isConnected);
    if (configure) configure.hidden = isConnected;
    if (connectionStatus) {
      connectionStatus.textContent = isConnected
        ? status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault")
        : ot("obsidian_not_connected", "Not connected", "尚未配置");
    }
    state.className = "obsidian-sync-state";
    state.innerHTML = "";
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    if (!status?.connected) {
      title.textContent = ot("obsidian_not_connected", "Vault not connected", "Vault 尚未连接");
      detail.textContent = ot("obsidian_connect_helper", "Choose a local Vault to save this conversation.", "选择本地 Vault 后即可保存当前对话。");
      current.textContent = ot("obsidian_configure", "Config Obsidian", "配置 Obsidian");
      current.disabled = false;
      if (disconnect) disconnect.hidden = true;
      if (settingsStatus) settingsStatus.textContent = ot("obsidian_not_connected", "Vault not connected", "Vault 尚未连接");
      state.classList.add("is-warning");
    } else if (status.permission === "prompt") {
      // queryPermission timed out (common on Service Worker cold-start).
      // This is temporary — do not tell the user to reauthorize.
      title.textContent = status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault");
      detail.textContent = ot("obsidian_permission_checking", "Checking Vault permission...", "正在检查 Vault 权限...");
      current.textContent = ot("obsidian_retry_check", "Retry", "重试");
      current.disabled = false;
      if (disconnect) disconnect.hidden = false;
      if (settingsStatus) settingsStatus.textContent = `${status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault")} | ${ot("obsidian_permission_checking", "Checking permission", "检查权限中")}`;
      state.classList.add("is-warning");
    } else if (status.permission !== "granted") {
      title.textContent = status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault");
      detail.textContent = ot("obsidian_permission_required", "Vault permission must be granted again.", "Vault 权限已失效，需要重新授权。");
      current.textContent = ot("obsidian_reauthorize", "Reauthorize Vault", "重新授权 Vault");
      current.disabled = false;
      if (disconnect) disconnect.hidden = false;
      if (settingsStatus) settingsStatus.textContent = `${status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault")} | ${ot("obsidian_permission_required", "Permission required", "需要重新授权")}`;
      state.classList.add("is-warning");
    } else if (status.directoriesValid === false) {
      title.textContent = status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault");
      const isUnconfigured = status.directoriesConfigured === false;
      detail.textContent = isUnconfigured
        ? ot("obsidian_choose_folders", "Choose a notes folder to start syncing.", "请选择一个笔记目录以开始同步。")
        : ot("obsidian_directories_missing", "A configured folder is missing. Repair it before syncing.", "配置目录已丢失，请修复后再同步。");
      current.textContent = isUnconfigured
        ? ot("obsidian_configure", "Config Obsidian", "配置 Obsidian")
        : ot("obsidian_repair_folders", "Repair Vault folders", "修复 Vault 目录");
      current.disabled = false;
      if (disconnect) disconnect.hidden = false;
      if (settingsStatus) settingsStatus.textContent = `${status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault")} | ${isUnconfigured ? ot("obsidian_not_configured", "Not configured", "未配置") : ot("obsidian_directories_missing", "Folders need repair", "目录需要修复")}`;
      state.classList.add("is-warning");
    } else if (status.activeJob || selection?.syncRunning) {
      title.textContent = status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault");
      detail.textContent = ot("obsidian_sync_busy", "A sync task is writing to this Vault.", "已有同步任务正在写入此 Vault。");
      current.textContent = ot("obsidian_syncing", "Syncing", "同步中");
      current.disabled = true;
      if (disconnect) disconnect.hidden = false;
      if (settingsStatus) settingsStatus.textContent = `${status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault")} | ${ot("obsidian_syncing", "Syncing", "同步中")}`;
    } else {
      title.textContent = status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault");
      const notesDestination = status.config?.notesRoot || ot("obsidian_vault_root", "Vault root", "Vault 根目录");
      detail.textContent = `${notesDestination} | ${ot("obsidian_ready", "Ready", "可同步")}`;
      current.textContent = selectedCount > 0
        ? ot("obsidian_sync_selected_short", "Sync $1", "同步 $1 条", selectedCount)
        : selectionMode
          ? ot("obsidian_select_message_first_short", "Select messages", "请选择消息")
          : ot("obsidian_sync_current_short", "Sync", "同步");
      current.disabled = !isSupportedPage || (selectionMode && selectedCount < 1);
      if (disconnect) disconnect.hidden = false;
      if (settingsStatus) settingsStatus.textContent = `${status.vaultName || ot("obsidian_vault", "Obsidian Vault", "Obsidian Vault")} | ${notesDestination}`;
    }
    state.append(title, detail);
    state.setAttribute("aria-label", status?.connected
      ? ot("obsidian_change_folder", "Change Obsidian folders", "更换 Obsidian 文件夹")
      : ot("obsidian_configure", "Config Obsidian", "配置 Obsidian"));
  }

  async function refreshObsidianStatus() {
    let timeout = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(ot("obsidian_status_failed", "Could not check Vault status.", "无法检查 Vault 状态。"))), 5000);
    });
    const checkPromise = (async () => {
      const [status, selection] = await Promise.all([
        obsidianBackgroundMessage({ type: "CHATVAULT_OBSIDIAN_GET_STATUS" }).catch(() => ({ connected: false })),
        getObsidianSelectionStatus().catch(() => ({ selectedCount: 0, selectionMode: false }))
      ]);
      return { status: status || { connected: false }, selection: selection || { selectedCount: 0, selectionMode: false } };
    })();
    try {
      const { status, selection } = await Promise.race([checkPromise, timeoutPromise]);
      obsidianStatus = status || { connected: false };
      renderObsidianStatus(obsidianStatus, selection);
      return obsidianStatus;
    } catch (error) {
      console.warn("[Obsidian Sync] refreshObsidianStatus failed or timed out:", error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function triggerObsidianSync() {
    // When permission query timed out (prompt), retry the status check first
    // instead of forcing the user back to the settings page.
    if (obsidianStatus?.permission === "prompt") {
      try {
        await refreshObsidianStatus();
      } catch (error) { /* ignore, fall through */ }
      if (obsidianStatus?.permission === "prompt") {
        openObsidianSettings();
        return;
      }
    }
    if (!obsidianStatus?.connected || obsidianStatus.permission !== "granted" || obsidianStatus.directoriesValid === false) {
      openObsidianSettings();
      return;
    }
    if (!requireSupportedPage()) return;
    if (await blockExportIfFreeQuotaExhausted()) return;
    const button = document.getElementById("obsidian-sync-current");
    if (button) button.disabled = true;
    try {
      await obsidianPageMessage({
        type: "CHATVAULT_POPUP_OBSIDIAN_SYNC",
        config: { settings: getObsidianCurrentSettings() }
      });
      window.close();
    } catch (error) {
      if (button) button.disabled = false;
      showToast(error?.message || ot("obsidian_start_failed", "Could not start Obsidian sync. Refresh the page and try again.", "无法开始 Obsidian 同步，请刷新页面后重试。"));
    }
  }

  async function disconnectObsidianVault() {
    const button = document.getElementById("obsidian-sync-disconnect");
    if (button) button.disabled = true;
    try {
      const status = await obsidianBackgroundMessage({ type: "CHATVAULT_OBSIDIAN_DISCONNECT" });
      obsidianStatus = status;
      renderObsidianStatus(status, { selectedCount: 0, selectionMode: false });
      showToast(ot("obsidian_disconnected", "Obsidian disconnected. Existing files were kept.", "已断开 Obsidian，现有文件不会被删除。"));
    } catch (error) {
      showToast(error?.message || ot("obsidian_disconnect_failed", "Could not disconnect Obsidian.", "无法断开 Obsidian。"));
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function initializeObsidianSyncUI() {
    obsidianUiReady = true;
    applyObsidianSyncVisibility(obsidianSyncVisible);
    const state = document.getElementById("obsidian-sync-state");
    const current = document.getElementById("obsidian-sync-current");
    const disconnect = document.getElementById("obsidian-sync-disconnect");
    const settingsConfigure = document.getElementById("obsidian-settings-configure");
    if (state && !state.dataset.bound) {
      state.dataset.bound = "true";
      state.addEventListener("click", openObsidianSettings);
    }
    if (current && !current.dataset.bound) {
      current.dataset.bound = "true";
      current.addEventListener("click", triggerObsidianSync);
    }
    if (disconnect && !disconnect.dataset.bound) {
      disconnect.dataset.bound = "true";
      disconnect.addEventListener("click", disconnectObsidianVault);
    }
    if (settingsConfigure && !settingsConfigure.dataset.bound) {
      settingsConfigure.dataset.bound = "true";
      settingsConfigure.addEventListener("click", openObsidianSettings);
    }
    try {
      await refreshObsidianStatus();
    } catch (error) {
      console.warn("[Obsidian Sync] initializeObsidianSyncUI status error, rendering unconfigured:", error);
      renderObsidianStatus({ connected: false }, { selectedCount: 0, selectionMode: false });
    }
  }

  // 监听持久化 Background 任务状态。
  chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === "CHATVAULT_NOTION_JOB_STATUS" && message.job) {
      renderNotionJob(message.job);
    }
  });

})();
