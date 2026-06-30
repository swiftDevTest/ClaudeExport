(function initAiChatExportCheckout() {
  const SUPABASE_URL = "https://acgehhqcgreatcjcefub.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_GH05KXWPIo42YrorR0OGyQ_XdEWzY8Q";
  const PADDLE_CLIENT_TOKEN = "live_b4118db9924eb2b2405d641fe88";
  const PADDLE_SCRIPT_URL = "https://cdn.paddle.com/paddle/v2/paddle.js";
  const BASE_URL = "https://tabpilotpro.com/aichatexport";
  const SUCCESS_URL = `${BASE_URL}/checkout?status=success`;
  const CANCEL_URL = `${BASE_URL}/checkout?status=cancelled`;
  const CHECKOUT_PAGE_URL = `${BASE_URL}/checkout`;

  const PLANS = {
    monthly: {
      id: "monthly",
      title: "Pro Monthly",
      billingInterval: "monthly",
      priceId: "pri_01kvdgya1nx70xhax2h5d8at0n"
    },
    yearly: {
      id: "yearly",
      title: "Pro Yearly",
      billingInterval: "yearly",
      priceId: "pri_01kvdh0jc0nrpbfjt60509nw6x"
    },
    lifetime: {
      id: "lifetime",
      title: "Lifetime Early Bird",
      billingInterval: "lifetime",
      priceId: "pri_01kvdh1ank00x91xc3qtv2bkw2"
    }
  };

  const params = new URLSearchParams(window.location.search);
  const source = params.get("source") || "website_aichatexport";
  const requestedPlanId = params.get("plan") || "";
  const customerEmail = String(params.get("customer_email") || params.get("email") || "").trim();
  const customerName = String(params.get("customer_name") || params.get("name") || "").trim();
  const statusEl = document.querySelector("[data-role='checkout-status']");
  let checkoutLoading = false;
  let paddleReady = false;
  let paddleScriptPromise = null;

  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle("is-error", Boolean(isError));
    statusEl.style.display = message ? "block" : "none";
  }

  function setButtonsDisabled(disabled) {
    document.querySelectorAll("[data-plan]").forEach((button) => {
      button.disabled = disabled;
    });
  }

  function resetCheckoutState(message, isError) {
    checkoutLoading = false;
    setButtonsDisabled(false);
    setStatus(message || "", isError);
  }

  function getCheckoutCustomer() {
    return customerEmail ? { customer: { email: customerEmail } } : {};
  }

  function requireLinkedCheckoutCustomer() {
    if (!customerEmail) {
      throw new Error("Please sign in inside the AI Chat Export extension and open checkout again so Pro access can be linked to your account.");
    }
  }

  function loadPaddleScript() {
    if (window.Paddle) return Promise.resolve();
    if (paddleScriptPromise) return paddleScriptPromise;
    paddleScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PADDLE_SCRIPT_URL;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Secure checkout module failed to load. Please refresh or contact support."));
      document.head.appendChild(script);
    });
    return paddleScriptPromise;
  }

  async function initializePaddle() {
    if (paddleReady) return;
    await loadPaddleScript();
    if (!window.Paddle || typeof window.Paddle.Initialize !== "function") {
      throw new Error("Secure checkout module failed to load. Please refresh or contact support.");
    }
    window.Paddle.Initialize({
      token: PADDLE_CLIENT_TOKEN,
      checkout: {
        settings: {
          displayMode: "overlay",
          theme: "light",
          locale: "en",
          successUrl: SUCCESS_URL
        }
      },
      eventCallback(event) {
        if (!event || !event.name) return;
        if (event.name === "checkout.loaded") {
          setStatus("Secure checkout is open.");
        }
        if (event.name === "checkout.completed") {
          resetCheckoutState("Payment complete. Return to AI Chat Export and use Restore purchase if Pro is not visible yet.");
        }
        if (event.name === "checkout.payment.failed" || event.name === "checkout.payment.error") {
          resetCheckoutState("Payment was not completed. Please check your payment details or contact support.", true);
        }
        if (event.name === "checkout.closed") {
          resetCheckoutState("Checkout window closed. Choose a plan again when ready.", true);
        }
      }
    });
    paddleReady = true;
  }

  async function createCheckoutSession(plan) {
    requireLinkedCheckoutCustomer();
    const response = await fetch(`${SUPABASE_URL}/functions/v1/create-checkout-session`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        internal_plan: "pro",
        plan_id: plan.id,
        billing_interval: plan.billingInterval,
        currency: "USD",
        provider_id: "paddle",
        product_id: "ai_chat_export",
        product_slug: "ai-chat-export",
        product_name: "AI Chat Export",
        provider_price_id: plan.priceId,
        price_id: plan.priceId,
        source,
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        ...(customerName ? { customer_name: customerName } : {})
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.checkoutUrl) {
      throw new Error((payload && payload.message) || "Could not create checkout session. Please try again.");
    }
    return payload;
  }

  async function openCheckout(planId) {
    if (checkoutLoading) return;
    const plan = PLANS[planId] || PLANS.yearly;
    checkoutLoading = true;
    setButtonsDisabled(true);
    setStatus(`Creating a secure checkout for ${plan.title}...`);
    try {
      const checkout = await createCheckoutSession(plan);
      setStatus("Initializing secure payment...");
      await initializePaddle();
      window.Paddle.Checkout.open({
        settings: {
          displayMode: "overlay",
          theme: "light",
          locale: "en",
          successUrl: SUCCESS_URL
        },
        ...getCheckoutCustomer(),
        transactionId: checkout.transactionId
      });
    } catch (error) {
      resetCheckoutState(error && error.message ? error.message : "Checkout is temporarily unavailable. Please try again.", true);
    }
  }

  async function openPaddleTransactionCheckout(transactionId) {
    if (!transactionId) return;
    requireLinkedCheckoutCustomer();
    checkoutLoading = true;
    setButtonsDisabled(true);
    setStatus("Loading your secure payment session...");
    try {
      await initializePaddle();
      window.Paddle.Checkout.open({
        settings: {
          displayMode: "overlay",
          theme: "light",
          locale: "en",
          successUrl: SUCCESS_URL
        },
        ...getCheckoutCustomer(),
        transactionId
      });
    } catch (error) {
      resetCheckoutState(error && error.message ? error.message : "Could not open secure checkout.", true);
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-plan]");
    if (!button) return;
    openCheckout(button.dataset.plan);
  });

  if (params.get("status") === "success") {
    setStatus("Payment complete. Return to AI Chat Export and use Restore purchase if Pro is not visible yet.");
  } else if (params.get("status") === "cancelled") {
    setStatus("Checkout was cancelled. You can choose a plan again later.", true);
  } else if (!customerEmail) {
    setStatus("Please sign in inside the AI Chat Export extension and open checkout again so Pro access can be linked to your account.", true);
  } else if (params.get("_ptxn")) {
    openPaddleTransactionCheckout(params.get("_ptxn")).catch((error) => {
      resetCheckoutState(error && error.message ? error.message : "Could not load secure checkout.", true);
    });
  } else if (requestedPlanId && PLANS[requestedPlanId]) {
    openCheckout(requestedPlanId).catch((error) => {
      resetCheckoutState(error && error.message ? error.message : "Could not load secure checkout.", true);
    });
  }
})();
