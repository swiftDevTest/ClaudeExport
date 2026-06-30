import { emptyResponseForRequest, errorResponseForRequest, isAllowedBrowserOrigin, jsonResponseForRequest, readJsonBody } from "../_shared/http.ts";
import { findPlan, isProductSlugAllowed, PRODUCT_ID, PRODUCT_NAME, PRODUCT_SLUG } from "../_shared/plans.ts";
import { ensureProfile, getUserFromRequest, supabaseRest, type AuthUser } from "../_shared/supabase.ts";
import { paddleRequest } from "../_shared/paddle.ts";

const DEFAULT_CHECKOUT_RATE_LIMIT_PER_HOUR = 8;
const DEFAULT_CHECKOUT_URL = "https://tabpilotpro.com/aichatexport/checkout";
const DEFAULT_ALLOWED_CHECKOUT_ORIGINS = [
  "https://tabpilotpro.com",
  "https://www.tabpilotpro.com"
];

function getCheckoutSource(value: unknown): string {
  return String(value || "extension").trim().toLowerCase().slice(0, 40) || "extension";
}

function isWebsiteCheckoutSource(source: string): boolean {
  return ["website", "website_aichatexport", "pricing_page"].includes(source);
}

function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getAllowedCheckoutOrigins() {
  const configured = Deno.env.get("CHECKOUT_ALLOWED_ORIGINS") || "";
  return (configured ? configured.split(",") : DEFAULT_ALLOWED_CHECKOUT_ORIGINS)
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isAllowedCheckoutUrl(url: URL) {
  return url.protocol === "https:" &&
    getAllowedCheckoutOrigins().includes(url.origin) &&
    url.pathname.startsWith("/aichatexport/checkout");
}

function normalizeCheckoutUrl(rawUrl: string, fallback = DEFAULT_CHECKOUT_URL) {
  try {
    const url = new URL(rawUrl || fallback);
    if (!isAllowedCheckoutUrl(url)) {
      return fallback;
    }
    return url.toString();
  } catch (_error) {
    return fallback;
  }
}

function getConfiguredReturnUrl(envName: string) {
  const value = getString(Deno.env.get(envName));
  if (!value) {
    return "";
  }
  const normalized = normalizeCheckoutUrl(value, "");
  return normalized || "";
}

function hasDisallowedBrowserOrigin(request: Request) {
  const origin = request.headers.get("origin") || "";
  return Boolean(origin && !isAllowedBrowserOrigin(request));
}

async function findStoredPaddleCustomerId(userId: string) {
  const profileRows = await supabaseRest<Record<string, unknown>[]>(
    `profiles?id=eq.${encodeURIComponent(userId)}&product_slug=eq.${PRODUCT_SLUG}&select=paddle_customer_id&limit=1`
  );
  const profileCustomerId = getString(profileRows?.[0]?.paddle_customer_id);
  if (profileCustomerId) {
    return profileCustomerId;
  }

  const customerRows = await supabaseRest<Record<string, unknown>[]>(
    `payment_customers?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${PRODUCT_SLUG}&select=paddle_customer_id&limit=1`
  );
  return getString(customerRows?.[0]?.paddle_customer_id);
}

async function findPaddleCustomerIdByEmail(email: string) {
  if (!isValidEmail(email)) {
    return "";
  }

  const result = await paddleRequest<Record<string, unknown>>(`/customers?email=${encodeURIComponent(email)}&per_page=1`);
  const data = Array.isArray(result?.data) ? result.data.map(asRecord) : [];
  return getString(data[0]?.id);
}

async function createPaddleCustomer(user: AuthUser, email: string) {
  if (!isValidEmail(email)) {
    return "";
  }

  const result = await paddleRequest<Record<string, unknown>>("/customers", {
    method: "POST",
    idempotencyKey: `ai-chat-export:customer:${user.id || email}`,
    body: {
      email,
      custom_data: {
        product_id: PRODUCT_ID,
        product_slug: PRODUCT_SLUG,
        supabase_user_id: user.id,
        user_id: user.id
      }
    }
  });
  return getString(asRecord(result?.data).id);
}

async function persistPaddleCustomer(user: AuthUser, paddleCustomerId: string, email: string) {
  if (!user.id || !paddleCustomerId) {
    return;
  }

  await ensureProfile(user, {
    provider_id: "paddle",
    paddle_customer_id: paddleCustomerId
  });

  await supabaseRest("payment_customers?on_conflict=paddle_customer_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: {
      user_id: user.id,
      product_slug: PRODUCT_SLUG,
      provider_id: "paddle",
      paddle_customer_id: paddleCustomerId,
      email: email || user.email || null
    }
  });
}

async function getOrCreatePaddleCustomerId(user: AuthUser, requestedEmail: unknown) {
  const email = normalizeEmail(user.email || requestedEmail);
  let paddleCustomerId = await findStoredPaddleCustomerId(user.id);

  if (!paddleCustomerId && email) {
    paddleCustomerId = await findPaddleCustomerIdByEmail(email);
  }
  if (!paddleCustomerId && email) {
    paddleCustomerId = await createPaddleCustomer(user, email);
  }
  if (paddleCustomerId) {
    await persistPaddleCustomer(user, paddleCustomerId, email);
  }

  return {
    email,
    paddleCustomerId
  };
}

function buildCheckoutUrl(rawUrl: string, planId: string, source: string, customer: { email: string; paddleCustomerId: string }) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("product", PRODUCT_SLUG);
    url.searchParams.set("plan", planId);
    url.searchParams.set("source", source);
    if (customer.email) {
      url.searchParams.set("email", customer.email);
      url.searchParams.set("customer_email", customer.email);
    }
    if (customer.paddleCustomerId) {
      url.searchParams.set("paddle_customer_id", customer.paddleCustomerId);
    }
    return url.toString();
  } catch (_error) {
    return rawUrl;
  }
}

async function consumeCheckoutRateLimit(userId: string, source: string) {
  const configured = Number(Deno.env.get("CHECKOUT_RATE_LIMIT_PER_HOUR") || DEFAULT_CHECKOUT_RATE_LIMIT_PER_HOUR);
  const limit = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_CHECKOUT_RATE_LIMIT_PER_HOUR;
  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const bucketKey = `${PRODUCT_SLUG}:checkout:${userId}:${source}:${hourBucket}`;
  const consumed = await supabaseRest<boolean>("rpc/try_consume_edge_rate_limit", {
    method: "POST",
    body: {
      p_bucket_key: bucketKey,
      p_product_slug: PRODUCT_SLUG,
      p_increment: 1,
      p_limit: limit
    }
  });
  return consumed === true;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return emptyResponseForRequest(request, isAllowedBrowserOrigin(request) ? 204 : 403);
  }
  if (request.method !== "POST") {
    return errorResponseForRequest(request, "Method not allowed.", 405);
  }

  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const source = getCheckoutSource(body.source);
    if (!isProductSlugAllowed(body.product_slug || body.product_id || body.product)) {
      return errorResponseForRequest(request, "Unsupported product.", 400);
    }

    if (hasDisallowedBrowserOrigin(request)) {
      return errorResponseForRequest(request, "Origin is not allowed.", 403);
    }

    let user: AuthUser;
    try {
      user = await getUserFromRequest(request);
    } catch (_error) {
      const message = isWebsiteCheckoutSource(source)
        ? "Sign in to AI Chat Export first, then open checkout again so Pro access can be linked to your account."
        : "Please sign in before starting checkout so Pro access can be linked to your account.";
      return errorResponseForRequest(request, message, 401);
    }

    const plan = findPlan({
      priceId: body.price_id,
      providerPriceId: body.provider_price_id,
      planId: body.plan_id || body.plan,
      billingInterval: body.billing_interval
    });
    if (!plan) {
      return errorResponseForRequest(request, "Unsupported Paddle price id.", 400);
    }

    await ensureProfile(user);

    const checkoutAllowed = await consumeCheckoutRateLimit(user.id, source);
    if (!checkoutAllowed) {
      return errorResponseForRequest(request, "Too many checkout attempts. Please try again later.", 429);
    }

    const rawCheckoutUrl = normalizeCheckoutUrl(Deno.env.get("PADDLE_CHECKOUT_URL") || DEFAULT_CHECKOUT_URL);
    const successUrl = getConfiguredReturnUrl("CHECKOUT_SUCCESS_URL");
    const cancelUrl = getConfiguredReturnUrl("CHECKOUT_CANCEL_URL");
    const idempotencyKey = `ai-chat-export:${user.id}:${plan.id}:${Date.now()}`;
    const customer = await getOrCreatePaddleCustomerId(user, body.customer_email);
    const checkoutUrl = buildCheckoutUrl(rawCheckoutUrl, plan.id, source, customer);

    const transactionPayload = {
      ...(customer.paddleCustomerId ? { customer_id: customer.paddleCustomerId } : {}),
      items: [
        {
          price_id: plan.priceId,
          quantity: 1
        }
      ],
      checkout: {
        url: checkoutUrl
      },
      custom_data: {
        product_id: PRODUCT_ID,
        product_slug: PRODUCT_SLUG,
        product_name: PRODUCT_NAME,
        supabase_user_id: user.id,
        user_id: user.id,
        email: customer.email || user.email || null,
        paddle_customer_id: customer.paddleCustomerId || null,
        plan_id: plan.id,
        billing_interval: plan.billingInterval,
        price_id: plan.priceId,
        provider_price_id: plan.priceId,
        source,
        success_url: successUrl || null,
        cancel_url: cancelUrl || null
      }
    };

    const paddleResult = await paddleRequest<Record<string, unknown>>("/transactions", {
      method: "POST",
      idempotencyKey,
      body: transactionPayload
    });
    const data = (paddleResult.data || {}) as Record<string, unknown>;
    const checkout = (data.checkout || {}) as Record<string, unknown>;
    const paddleCheckoutUrl = typeof checkout.url === "string" ? checkout.url : "";
    const paddleTransactionId = getString(data.id);

    if (!paddleCheckoutUrl) {
      return errorResponseForRequest(request, "Paddle did not return a checkout URL.", 502, paddleResult);
    }

    if (paddleTransactionId) {
      await supabaseRest("payment_transactions?on_conflict=paddle_transaction_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          paddle_transaction_id: paddleTransactionId,
          user_id: user.id,
          product_slug: PRODUCT_SLUG,
          provider_id: "paddle",
          paddle_customer_id: customer.paddleCustomerId || null,
          paddle_subscription_id: null,
          paddle_price_id: plan.priceId,
          plan_id: plan.id,
          billing_interval: plan.billingInterval,
          status: getString(data.status) || "created",
          raw: data
        }
      });
    }

    return jsonResponseForRequest(request, {
      ok: true,
      provider: "paddle",
      checkoutUrl: paddleCheckoutUrl,
      transactionId: paddleTransactionId || null,
      plan
    });
  } catch (error) {
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Checkout session failed.", 500);
  }
});
