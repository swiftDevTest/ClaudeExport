(function initChatVaultBilling() {
  const checkoutUrl = "https://tabpilotpro.com/claude/checkout.html";
  const productId = "claude_export";
  const productSlug = "claude-export";
  const productName = "Claude Export";
  const checkoutIntentStorageKey = "chatvault_pending_checkout_intent_v1";
  const checkoutIntentMaxAgeMs = 5 * 60 * 1000;

  const t = (key, def) => {
    return (globalThis.CHATVAULT_I18N && globalThis.CHATVAULT_I18N.t)
      ? globalThis.CHATVAULT_I18N.t(key, def)
      : def;
  };

  const plans = [
    {
      id: "monthly",
      sku: "pro_monthly",
      priceId: "pri_01kvdgya1nx70xhax2h5d8at0n",
      internalPlan: "pro",
      billingInterval: "monthly",
      title: t("billing_plan_title_monthly", "Pro Monthly"),
      originalPrice: "$8.99",
      price: "$4.99",
      cadence: t("billing_cadence_month", "/ month"),
      badge: t("billing_badge_monthly", "Monthly VIP"),
      offerLabel: t("billing_offer_label", "Limited-time offer"),
      discount: t("billing_discount_monthly", "Save 44%"),
      shortLabel: t("billing_badge_monthly", "Monthly VIP"),
      activeLabel: t("billing_badge_monthly", "Monthly VIP"),
      tone: "monthly",
      description: t("billing_plan_desc_monthly", "PDF, Docs, MD and More exports plus premium styles."),
      detail: t("billing_plan_detail_monthly", "Best if you want to try Pro first.")
    },
    {
      id: "yearly",
      sku: "pro_yearly",
      priceId: "pri_01kvdh0jc0nrpbfjt60509nw6x",
      internalPlan: "pro",
      billingInterval: "yearly",
      title: t("billing_plan_title_yearly", "Pro Yearly"),
      originalPrice: "$59.99",
      price: "$29.99",
      cadence: t("billing_cadence_year", "/ year"),
      badge: t("billing_badge_yearly", "Yearly VIP"),
      shortLabel: t("billing_badge_yearly", "Yearly VIP"),
      activeLabel: t("billing_badge_yearly", "Yearly VIP"),
      tone: "yearly",
      offerLabel: t("billing_offer_label", "Limited-time offer"),
      discount: t("billing_discount_yearly", "Save 50%"),
      description: t("billing_plan_desc_yearly", "Higher local export limits for regular AI users."),
      detail: t("billing_plan_detail_yearly", "Unlimited exports and premium templates all year.")
    },
    {
      id: "lifetime",
      sku: "pro_lifetime",
      priceId: "pri_01kvdh1ank00x91xc3qtv2bkw2",
      internalPlan: "pro",
      billingInterval: "lifetime",
      title: t("billing_plan_title_lifetime", "Lifetime Early Bird"),
      originalPrice: "$129.99",
      price: "$49.99",
      cadence: t("billing_cadence_lifetime", "one-time"),
      badge: t("billing_badge_lifetime", "Lifetime VIP"),
      shortLabel: t("billing_badge_lifetime", "Lifetime VIP"),
      activeLabel: t("billing_badge_lifetime", "Lifetime VIP"),
      offerLabel: t("billing_offer_label", "Limited-time offer"),
      discount: t("billing_discount_lifetime", "Save 62%"),
      tone: "lifetime",
      description: t("billing_plan_desc_lifetime", "Pay once. Keep Pro exports and all premium features."),
      detail: t("billing_plan_detail_lifetime", "Early supporter price.")
    }
  ];

  const benefits = [
    t("billing_benefit_pdf", "PDF, Docs, MD and More export"),
    t("billing_benefit_word", "Polished document output"),
    t("billing_benefit_image", "Image export snapshots"),
    t("billing_benefit_premium_styles", "Premium report styles (Oxford, McKinsey)"),
    t("billing_benefit_receipt_local", "Local export receipts"),
    t("billing_benefit_unlimited", "Unlimited daily chat exports"),
    t("billing_benefit_watermark", "Hide Claude Export watermark"),
    t("billing_benefit_receipt", "Download sidecar export receipt"),
    t("billing_benefit_shared", "Shared Pro VIP status with ChatVault AI"),
    t("billing_benefit_platforms", "ChatGPT, Claude & Gemini support")
  ];

  function getDefaultPlan() {
    return plans.find((plan) => plan.id === "yearly") || plans[0] || null;
  }

  function getPlan(planId) {
    const normalizedPlanId = String(planId || "").trim();

    if (!normalizedPlanId) {
      return getDefaultPlan();
    }

    return plans.find((plan) => plan.id === normalizedPlanId || plan.sku === normalizedPlanId) || null;
  }

  function requirePlan(planId) {
    const plan = getPlan(planId);

    if (!plan) {
      throw new Error(t("billing_err_plan_unavailable", "Selected billing plan is unavailable. Please choose another plan."));
    }

    return plan;
  }

  function getCheckoutUrl(planId, source = "extension", options = {}) {
    const plan = requirePlan(planId || "yearly");
    const params = new URLSearchParams({
      product: productSlug,
      plan: plan.id,
      source
    });
    const customerEmail = String(options.customerEmail || options.email || "").trim();
    const customerName = String(options.customerName || options.name || "").trim();

    if (customerEmail) {
      params.set("email", customerEmail);
      params.set("customer_email", customerEmail);
    }

    if (customerName) {
      params.set("customer_name", customerName);
    }

    return `${checkoutUrl}?${params.toString()}`;
  }

  function getCheckoutRequestBody(planId, source = "extension", options = {}) {
    const plan = requirePlan(planId || "yearly");

    return {
      internal_plan: plan.internalPlan || "pro",
      billing_interval: plan.billingInterval || plan.id,
      currency: options.currency || "USD",
      product_id: productId,
      product_slug: productSlug,
      product_name: productName,
      provider_price_id: plan.priceId,
      price_id: plan.priceId,
      provider_id: "paddle",
      source,
      ...(options.customerEmail ? { customer_email: options.customerEmail } : {}),
      ...(options.customerName ? { customer_name: options.customerName } : {})
    };
  }

  function createCheckoutIntent(planId = "yearly", source = "popup_subscribe", now = Date.now()) {
    const plan = requirePlan(planId || "yearly");
    return {
      at: Number(now) || Date.now(),
      planId: plan.id,
      source: String(source || "popup_subscribe")
    };
  }

  function normalizeCheckoutIntent(value, now = Date.now(), maxAgeMs = checkoutIntentMaxAgeMs) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const at = Number(value.at || 0);
    if (!Number.isFinite(at) || at <= 0 || Number(now) - at > maxAgeMs) {
      return null;
    }

    const plan = getPlan(value.planId || value.plan || value.sku || "yearly");
    if (!plan) {
      return null;
    }

    return {
      at,
      planId: plan.id,
      source: String(value.source || "popup_subscribe")
    };
  }

  async function createCheckoutSession(options = {}) {
    const api = options.api || globalThis.CHATVAULT_SUPABASE_API;

    if (!api || typeof api.request !== "function") {
      throw new Error(t("billing_err_unavailable", "Checkout is temporarily unavailable. Please try again later."));
    }

    const plan = requirePlan(options.planId || options.plan || "yearly");
    const result = await api.request("/functions/v1/create-checkout-session", {
      accessToken: options.accessToken,
      body: getCheckoutRequestBody(plan.id, options.source || "extension", options),
      method: "POST",
      timeoutMs: options.timeoutMs || 20000
    });

    if (!result || !result.checkoutUrl) {
      throw new Error(t("billing_err_unavailable", "Checkout is temporarily unavailable. Please try again later."));
    }

    const providerId = result.provider || result.providerId || "";

    if (providerId && providerId !== "paddle") {
      throw new Error(t("billing_err_paddle_unavailable", "Paddle checkout is temporarily unavailable. Please try again later."));
    }

    return {
      ...result,
      plan
    };
  }

  globalThis.CHATVAULT_BILLING = {
    benefits,
    checkoutUrl,
    checkoutIntentMaxAgeMs,
    checkoutIntentStorageKey,
    createCheckoutSession,
    createCheckoutIntent,
    getCheckoutRequestBody,
    getCheckoutUrl,
    normalizeCheckoutIntent,
    requirePlan,
    getPlan,
    productId,
    productSlug,
    productName,
    plans
  };
})();
