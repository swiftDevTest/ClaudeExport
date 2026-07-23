import { emptyResponseForRequest, errorResponseForRequest, isAllowedBrowserOrigin, jsonResponseForRequest, readJsonBody } from "../_shared/http.ts";
import { getNewProductFromInput } from "../_shared/product-plans.ts";
import { ensureProfile, getProfileByUserId, getUserFromRequest, publicProfile, supabaseRest, updateProfile } from "../_shared/product-supabase.ts";

function isActiveSubscription(row: Record<string, unknown>) {
  const status = String(row.status || "").toLowerCase();
  if (!["active", "trialing", "past_due"].includes(status)) {
    return false;
  }
  const periodEnd = row.current_period_end ? new Date(String(row.current_period_end)).getTime() : 0;
  return !periodEnd || periodEnd > Date.now();
}

function isPaidTransaction(row: Record<string, unknown> | null | undefined) {
  return ["completed", "paid", "active"].includes(String(row?.status || "").toLowerCase());
}

function isLifetimeTransaction(row: Record<string, unknown> | null | undefined) {
  return String(row?.billing_interval || "").toLowerCase() === "lifetime" ||
    String(row?.plan_id || "").toLowerCase() === "lifetime";
}

function isPaidLifetimeTransaction(row: Record<string, unknown> | null | undefined) {
  return isPaidTransaction(row) && isLifetimeTransaction(row);
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function getStoredCustomerIds(userId: string, profile: Record<string, unknown>, productSlug: string) {
  const ids = new Set<string>();
  const profileCustomerId = getString(profile.paddle_customer_id);
  if (profileCustomerId) {
    ids.add(profileCustomerId);
  }

  const customers = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_customers?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=paddle_customer_id`
  );
  (customers || []).forEach((row) => {
    const customerId = getString(row.paddle_customer_id);
    if (customerId) {
      ids.add(customerId);
    }
  });

  return Array.from(ids);
}

async function getLatestPaidLifetimeTransactionForUser(userId: string, profile: Record<string, unknown>, productSlug: string) {
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_transactions?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&status=in.(completed,paid,active)&select=*&order=updated_at.desc&limit=20`
  );
  const directTransaction = (rows || []).find(isPaidLifetimeTransaction) || null;
  if (directTransaction) {
    return directTransaction;
  }

  const customerIds = await getStoredCustomerIds(userId, profile, productSlug);
  for (const customerId of customerIds) {
    const customerRows = await supabaseRest<Record<string, unknown>[]>(
      `product_payment_transactions?paddle_customer_id=eq.${encodeURIComponent(customerId)}&product_slug=eq.${encodeURIComponent(productSlug)}&status=in.(completed,paid,active)&select=*&order=updated_at.desc&limit=20`
    );
    const transaction = (customerRows || []).find(isPaidLifetimeTransaction) || null;
    if (transaction) {
      if (!transaction.user_id) {
        await supabaseRest(`product_payment_transactions?paddle_transaction_id=eq.${encodeURIComponent(String(transaction.paddle_transaction_id))}&product_slug=eq.${encodeURIComponent(productSlug)}`, {
          method: "PATCH",
          prefer: "return=minimal",
          body: { user_id: userId }
        });
      }
      return transaction;
    }
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
  if (!isAllowedBrowserOrigin(request)) {
    return errorResponseForRequest(request, "Origin is not allowed.", 403);
  }

  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const product = getNewProductFromInput(body);
    if (!product) {
      return errorResponseForRequest(request, "Unsupported product.", 400);
    }
    const productSlug = product.productSlug;
    const user = await getUserFromRequest(request);
    await ensureProfile(user, {}, productSlug);

    let profile = await getProfileByUserId(user.id, productSlug) || {};
    const subscriptions = await supabaseRest<Record<string, unknown>[]>(
      `product_payment_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=*&order=updated_at.desc`
    );
    const activeSubscription = (subscriptions || []).find(isActiveSubscription) || null;
    // Fix H4: always check paid lifetime transaction to detect refunds.
    // Previously skipped when activeSubscription existed, and trusted profile.lifetime_access
    // which could be stale after a refund. Now derives lifetimeAccess from actual transaction state.
    const paidLifetimeTransaction = await getLatestPaidLifetimeTransactionForUser(user.id, profile, productSlug);
    const lifetimeAccess = Boolean(paidLifetimeTransaction);
    const nextPlan = lifetimeAccess || activeSubscription ? "pro" : "free";

    const updatedProfile = await updateProfile(user.id, {
      email: user.email || profile.email || null,
      plan: nextPlan,
      product_slug: productSlug,
      // Fix H4: always set lifetime_access explicitly so refunded lifetime is revoked
      // even when user has an active subscription.
      lifetime_access: lifetimeAccess,
      ...(!activeSubscription && !lifetimeAccess ? {
        current_period_end: null
      } : {}),
      ...(paidLifetimeTransaction ? {
        paddle_customer_id: paidLifetimeTransaction.paddle_customer_id,
        paddle_subscription_id: paidLifetimeTransaction.paddle_subscription_id || profile.paddle_subscription_id || null,
        paddle_transaction_id: paidLifetimeTransaction.paddle_transaction_id,
        paddle_price_id: paidLifetimeTransaction.paddle_price_id,
        billing_interval: paidLifetimeTransaction.billing_interval
      } : {}),
      ...(activeSubscription ? {
        paddle_subscription_id: activeSubscription.paddle_subscription_id,
        paddle_customer_id: activeSubscription.paddle_customer_id,
        paddle_price_id: activeSubscription.paddle_price_id,
        billing_interval: activeSubscription.billing_interval,
        current_period_end: activeSubscription.current_period_end
      } : {})
    }, productSlug);

    return jsonResponseForRequest(request, {
      ok: true,
      profile: publicProfile(updatedProfile, user)
    });
  } catch (error) {
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Subscription sync failed.", 500);
  }
});
