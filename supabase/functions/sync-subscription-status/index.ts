import { emptyResponseForRequest, errorResponseForRequest, isAllowedBrowserOrigin, jsonResponseForRequest } from "../_shared/http.ts";
import { PRODUCT_SLUG } from "../_shared/plans.ts";
import { ensureProfile, getProfileByUserId, getUserFromRequest, publicProfile, supabaseRest, updateProfile } from "../_shared/supabase.ts";

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

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function getStoredCustomerIds(userId: string, profile: Record<string, unknown>) {
  const ids = new Set<string>();
  const profileCustomerId = getString(profile.paddle_customer_id);
  if (profileCustomerId) {
    ids.add(profileCustomerId);
  }

  const customers = await supabaseRest<Record<string, unknown>[]>(
    `payment_customers?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${PRODUCT_SLUG}&select=paddle_customer_id`
  );
  (customers || []).forEach((row) => {
    const customerId = getString(row.paddle_customer_id);
    if (customerId) {
      ids.add(customerId);
    }
  });

  return Array.from(ids);
}

async function getLatestPaidTransactionForUser(userId: string, profile: Record<string, unknown>) {
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `payment_transactions?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${PRODUCT_SLUG}&status=in.(completed,paid,active)&select=*&order=updated_at.desc&limit=1`
  );
  if (isPaidTransaction(rows?.[0])) {
    return rows[0];
  }

  const customerIds = await getStoredCustomerIds(userId, profile);
  for (const customerId of customerIds) {
    const customerRows = await supabaseRest<Record<string, unknown>[]>(
      `payment_transactions?paddle_customer_id=eq.${encodeURIComponent(customerId)}&product_slug=eq.${PRODUCT_SLUG}&status=in.(completed,paid,active)&select=*&order=updated_at.desc&limit=1`
    );
    const transaction = customerRows?.[0] || null;
    if (isPaidTransaction(transaction)) {
      if (!transaction.user_id) {
        await supabaseRest(`payment_transactions?paddle_transaction_id=eq.${encodeURIComponent(String(transaction.paddle_transaction_id))}`, {
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
    const user = await getUserFromRequest(request);
    await ensureProfile(user);

    let profile = await getProfileByUserId(user.id) || {};
    const subscriptions = await supabaseRest<Record<string, unknown>[]>(
      `payment_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&product_slug=eq.${PRODUCT_SLUG}&select=*&order=updated_at.desc`
    );
    const activeSubscription = (subscriptions || []).find(isActiveSubscription) || null;
    const paidTransaction = activeSubscription ? null : await getLatestPaidTransactionForUser(user.id, profile);
    const lifetimeAccess = Boolean(profile.lifetime_access) || isLifetimeTransaction(paidTransaction);
    const nextPlan = lifetimeAccess || activeSubscription || paidTransaction ? "pro" : "free";

    const updatedProfile = await updateProfile(user.id, {
      email: user.email || profile.email || null,
      plan: nextPlan,
      ...(paidTransaction ? {
        paddle_customer_id: paidTransaction.paddle_customer_id,
        paddle_subscription_id: paidTransaction.paddle_subscription_id || profile.paddle_subscription_id || null,
        paddle_transaction_id: paidTransaction.paddle_transaction_id,
        paddle_price_id: paidTransaction.paddle_price_id,
        billing_interval: paidTransaction.billing_interval,
        lifetime_access: lifetimeAccess
      } : lifetimeAccess ? { lifetime_access: true } : {}),
      ...(activeSubscription ? {
        paddle_subscription_id: activeSubscription.paddle_subscription_id,
        paddle_customer_id: activeSubscription.paddle_customer_id,
        paddle_price_id: activeSubscription.paddle_price_id,
        billing_interval: activeSubscription.billing_interval,
        current_period_end: activeSubscription.current_period_end
      } : {})
    });

    return jsonResponseForRequest(request, {
      ok: true,
      profile: publicProfile(updatedProfile, user)
    });
  } catch (error) {
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Subscription sync failed.", 500);
  }
});
