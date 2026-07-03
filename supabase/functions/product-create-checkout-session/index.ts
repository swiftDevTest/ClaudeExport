import { emptyResponseForRequest, errorResponseForRequest, isAllowedBrowserOrigin, jsonResponseForRequest, readJsonBody } from "../_shared/http.ts";
import { findPlan, getNewProductFromInput, isProductSlugAllowed, type ProductBillingConfig } from "../_shared/product-plans.ts";
import { ensureProfile, getUserFromRequest, supabaseRest, type AuthUser } from "../_shared/product-supabase.ts";
import { PaddleApiError, paddleRequest } from "../_shared/product-paddle.ts";

const DEFAULT_CHECKOUT_RATE_LIMIT_PER_HOUR = 120;
const DEFAULT_RECENT_CHECKOUT_REUSE_MS = 10 * 60 * 1000;
const DEFAULT_ALLOWED_CHECKOUT_ORIGINS = [
  "https://tabpilotpro.com",
  "https://www.tabpilotpro.com"
];

function getCheckoutSource(value: unknown): string {
  return String(value || "extension").trim().toLowerCase().slice(0, 40) || "extension";
}

function isWebsiteCheckoutSource(source: string): boolean {
  return source === "website" || source === "pricing_page" || source.startsWith("website_");
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

function isPaddleCustomerPermissionError(error: unknown) {
  return error instanceof PaddleApiError &&
    error.status === 403 &&
    error.path.startsWith("/customers");
}

function shouldRequirePaddleCustomerBinding() {
  return (Deno.env.get("PADDLE_REQUIRE_CUSTOMER_BINDING") || "").trim().toLowerCase() === "true";
}

function logPaddleCustomerBindingSkipped(stage: string, error: unknown) {
  if (error instanceof PaddleApiError) {
    console.warn("Paddle customer binding skipped.", {
      stage,
      status: error.status,
      code: error.code,
      request_id: error.requestId
    });
    return;
  }

  console.warn("Paddle customer binding skipped.", {
    stage,
    message: error instanceof Error ? error.message : String(error)
  });
}

function getPaddleCheckoutErrorDetails(error: PaddleApiError) {
  return {
    provider: "paddle",
    status: error.status,
    code: error.code,
    request_id: error.requestId
  };
}

function getAllowedCheckoutOrigins() {
  const configured = Deno.env.get("CHECKOUT_ALLOWED_ORIGINS") || "";
  return (configured ? configured.split(",") : DEFAULT_ALLOWED_CHECKOUT_ORIGINS)
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function isAllowedCheckoutUrl(url: URL, product: ProductBillingConfig) {
  let configuredPath = "/aichatexport/checkout";
  try {
    configuredPath = new URL(product.checkoutUrl).pathname;
  } catch (_error) {}

  return url.protocol === "https:" &&
    getAllowedCheckoutOrigins().includes(url.origin) &&
    url.pathname === configuredPath;
}

function normalizeCheckoutUrl(rawUrl: string, product: ProductBillingConfig) {
  const fallback = product.checkoutUrl;
  try {
    const url = new URL(rawUrl || fallback);
    if (!isAllowedCheckoutUrl(url, product)) {
      return fallback;
    }
    return url.toString();
  } catch (_error) {
    return fallback;
  }
}

function getConfiguredReturnUrl(envName: string, product: ProductBillingConfig) {
  const value = getString(Deno.env.get(envName));
  if (!value) {
    return "";
  }
  const normalized = normalizeCheckoutUrl(value, product);
  return normalized || "";
}

function getRecentCheckoutReuseMs() {
  const configured = Number(Deno.env.get("RECENT_CHECKOUT_REUSE_MS") || DEFAULT_RECENT_CHECKOUT_REUSE_MS);
  return Number.isFinite(configured) && configured >= 60 * 1000 ? Math.floor(configured) : DEFAULT_RECENT_CHECKOUT_REUSE_MS;
}

function hasDisallowedBrowserOrigin(request: Request) {
  const origin = request.headers.get("origin") || "";
  return Boolean(origin && !isAllowedBrowserOrigin(request));
}

async function findStoredPaddleCustomerId(userId: string, productSlug: string) {
  const profileRows = await supabaseRest<Record<string, unknown>[]>(
    `product_profiles?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=paddle_customer_id&limit=1`
  );
  const profileCustomerId = getString(profileRows?.[0]?.paddle_customer_id);
  if (profileCustomerId) {
    return profileCustomerId;
  }

  const customerRows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_customers?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=paddle_customer_id&limit=1`
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

async function createPaddleCustomer(user: AuthUser, email: string, product: ProductBillingConfig) {
  if (!isValidEmail(email)) {
    return "";
  }

  const result = await paddleRequest<Record<string, unknown>>("/customers", {
    method: "POST",
    idempotencyKey: `${product.productSlug}:customer:${user.id || email}`,
    body: {
      email,
      custom_data: {
        product_id: product.productId,
        product_slug: product.productSlug,
        supabase_user_id: user.id,
        user_id: user.id
      }
    }
  });
  return getString(asRecord(result?.data).id);
}

async function persistPaddleCustomer(user: AuthUser, paddleCustomerId: string, email: string, product: ProductBillingConfig) {
  if (!user.id || !paddleCustomerId) {
    return;
  }

  await ensureProfile(user, {
    provider_id: "paddle",
    paddle_customer_id: paddleCustomerId
  }, product.productSlug);

  await supabaseRest("product_payment_customers?on_conflict=product_slug,paddle_customer_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: {
      user_id: user.id,
      product_slug: product.productSlug,
      provider_id: "paddle",
      paddle_customer_id: paddleCustomerId,
      email: email || user.email || null
    }
  });
}

async function getOrCreatePaddleCustomerId(user: AuthUser, requestedEmail: unknown, product: ProductBillingConfig) {
  const email = normalizeEmail(user.email || requestedEmail);
  let paddleCustomerId = await findStoredPaddleCustomerId(user.id, product.productSlug);

  if (!paddleCustomerId && email) {
    try {
      paddleCustomerId = await findPaddleCustomerIdByEmail(email);
    } catch (error) {
      if (!shouldRequirePaddleCustomerBinding() && isPaddleCustomerPermissionError(error)) {
        logPaddleCustomerBindingSkipped("find_customer_by_email", error);
        return { email, paddleCustomerId: "" };
      }
      throw error;
    }
  }
  if (!paddleCustomerId && email) {
    try {
      paddleCustomerId = await createPaddleCustomer(user, email, product);
    } catch (error) {
      if (!shouldRequirePaddleCustomerBinding() && isPaddleCustomerPermissionError(error)) {
        logPaddleCustomerBindingSkipped("create_customer", error);
        return { email, paddleCustomerId: "" };
      }
      throw error;
    }
  }
  if (paddleCustomerId) {
    await persistPaddleCustomer(user, paddleCustomerId, email, product);
  }

  return {
    email,
    paddleCustomerId
  };
}

function buildCheckoutUrl(rawUrl: string, planId: string, source: string, customer: { email: string; paddleCustomerId: string }, product: ProductBillingConfig) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("product", product.productSlug);
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

async function consumeCheckoutRateLimit(userId: string, source: string, productSlug: string) {
  const configured = Number(Deno.env.get("CHECKOUT_RATE_LIMIT_PER_HOUR") || DEFAULT_CHECKOUT_RATE_LIMIT_PER_HOUR);
  const limit = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_CHECKOUT_RATE_LIMIT_PER_HOUR;
  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const bucketKey = `${productSlug}:checkout:${userId}:${source}:${hourBucket}`;
  const consumed = await supabaseRest<boolean>("rpc/try_consume_product_edge_rate_limit", {
    method: "POST",
    body: {
      p_bucket_key: bucketKey,
      p_product_slug: productSlug,
      p_increment: 1,
      p_limit: limit
    }
  });
  return consumed === true;
}

function isReusableCheckoutStatus(status: string) {
  return !status || ["created", "draft", "ready"].includes(status.toLowerCase());
}

function getCheckoutUrlFromRawTransaction(raw: unknown) {
  const transaction = asRecord(raw);
  const checkout = asRecord(transaction.checkout);
  return getString(checkout.url);
}

async function findReusableCheckoutSession(userId: string, planId: string, productSlug: string) {
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_transactions?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&plan_id=eq.${encodeURIComponent(planId)}&select=paddle_transaction_id,status,raw,created_at&order=created_at.desc&limit=8`
  );
  const now = Date.now();
  const maxAgeMs = getRecentCheckoutReuseMs();

  for (const row of rows || []) {
    const createdAt = Date.parse(getString(row.created_at));
    if (!Number.isFinite(createdAt) || now - createdAt > maxAgeMs) {
      continue;
    }

    const status = getString(row.status);
    if (!isReusableCheckoutStatus(status)) {
      continue;
    }

    const checkoutUrl = getCheckoutUrlFromRawTransaction(row.raw);
    if (!checkoutUrl) {
      continue;
    }

    return {
      checkoutUrl,
      transactionId: getString(row.paddle_transaction_id) || null
    };
  }

  return null;
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
    const product = getNewProductFromInput(body);
    if (!product) {
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
        ? `Sign in to ${product.productName} first, then open checkout again so Pro access can be linked to your account.`
        : "Please sign in before starting checkout so Pro access can be linked to your account.";
      return errorResponseForRequest(request, message, 401);
    }

    const plan = findPlan({
      priceId: body.price_id,
      providerPriceId: body.provider_price_id,
      planId: body.plan_id || body.plan,
      billingInterval: body.billing_interval
    }, product.productSlug);
    if (!plan) {
      return errorResponseForRequest(request, "Unsupported Paddle price id.", 400);
    }
    if (!plan.priceId) {
      return errorResponseForRequest(request, `${product.productName} Paddle price id is not configured.`, 503);
    }

    await ensureProfile(user, {}, product.productSlug);

    const reusableCheckout = await findReusableCheckoutSession(user.id, plan.id, product.productSlug);
    if (reusableCheckout) {
      return jsonResponseForRequest(request, {
        ok: true,
        provider: "paddle",
        checkoutUrl: reusableCheckout.checkoutUrl,
        transactionId: reusableCheckout.transactionId,
        reused: true,
        plan
      });
    }

    const checkoutAllowed = await consumeCheckoutRateLimit(user.id, source, product.productSlug);
    if (!checkoutAllowed) {
      const fallbackCheckout = await findReusableCheckoutSession(user.id, plan.id, product.productSlug);
      if (fallbackCheckout) {
        return jsonResponseForRequest(request, {
          ok: true,
          provider: "paddle",
          checkoutUrl: fallbackCheckout.checkoutUrl,
          transactionId: fallbackCheckout.transactionId,
          reused: true,
          plan
        });
      }
      return errorResponseForRequest(request, "Too many checkout attempts. Please try again later.", 429);
    }

    const rawCheckoutUrl = normalizeCheckoutUrl(getString(body.checkout_url) || Deno.env.get("PADDLE_CHECKOUT_URL") || product.checkoutUrl, product);
    const successUrl = getConfiguredReturnUrl("CHECKOUT_SUCCESS_URL", product);
    const cancelUrl = getConfiguredReturnUrl("CHECKOUT_CANCEL_URL", product);
    const idempotencyWindow = Math.floor(Date.now() / getRecentCheckoutReuseMs());
    const idempotencyKey = `${product.productSlug}:${user.id}:${plan.id}:${source}:${idempotencyWindow}`;
    const customer = await getOrCreatePaddleCustomerId(user, body.customer_email, product);
    const checkoutUrl = buildCheckoutUrl(rawCheckoutUrl, plan.id, source, customer, product);

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
        product_id: product.productId,
        product_slug: product.productSlug,
        product_name: product.productName,
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
      await supabaseRest("product_payment_transactions?on_conflict=paddle_transaction_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          paddle_transaction_id: paddleTransactionId,
          user_id: user.id,
          product_slug: product.productSlug,
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
    if (error instanceof PaddleApiError) {
      return errorResponseForRequest(
        request,
        "Paddle checkout is temporarily unavailable. Please try again later.",
        502,
        getPaddleCheckoutErrorDetails(error)
      );
    }
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Checkout session failed.", 500);
  }
});
