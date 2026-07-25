import { emptyResponseForRequest, errorResponseForRequest, jsonResponseForRequest, isAllowedBrowserOrigin } from "../_shared/http.ts";
import { eventBelongsToProduct, getPaddleEventInfo, verifyPaddleSignature } from "../_shared/product-paddle.ts";
import { ensureProfile, getProfileByUserId, supabaseRest, updateProfile } from "../_shared/product-supabase.ts";

function toTimestamp(value: unknown) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getWebhookProductSlug(info: ReturnType<typeof getPaddleEventInfo>) {
  return info.productSlug || "unknown";
}

async function findUserIdByCustomer(customerId: string | null, productSlug: string) {
  if (!customerId) {
    return null;
  }
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_customers?paddle_customer_id=eq.${encodeURIComponent(customerId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=user_id&limit=1`
  );
  const customerUserId = typeof rows?.[0]?.user_id === "string" ? rows[0].user_id : null;
  if (customerUserId) {
    return customerUserId;
  }

  const profileRows = await supabaseRest<Record<string, unknown>[]>(
    `product_profiles?paddle_customer_id=eq.${encodeURIComponent(customerId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=user_id&limit=1`
  );
  return typeof profileRows?.[0]?.user_id === "string" ? profileRows[0].user_id : null;
}

async function findUserIdByTransaction(transactionId: string | null, productSlug: string) {
  if (!transactionId) {
    return null;
  }
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_transactions?paddle_transaction_id=eq.${encodeURIComponent(transactionId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=user_id&limit=1`
  );
  return typeof rows?.[0]?.user_id === "string" ? rows[0].user_id : null;
}

async function findUserIdBySubscription(subscriptionId: string | null, productSlug: string) {
  if (!subscriptionId) {
    return null;
  }
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_subscriptions?paddle_subscription_id=eq.${encodeURIComponent(subscriptionId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=user_id&limit=1`
  );
  return typeof rows?.[0]?.user_id === "string" ? rows[0].user_id : null;
}

async function insertWebhookEvent(event: Record<string, unknown>, info: ReturnType<typeof getPaddleEventInfo>, ignored: boolean, processed: boolean) {
  await supabaseRest("product_payment_webhook_events?on_conflict=event_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: {
      event_id: info.eventId,
      event_type: info.eventType,
      product_slug: ignored ? info.productSlug || "unknown" : getWebhookProductSlug(info),
      paddle_customer_id: info.customerId,
      paddle_subscription_id: info.subscriptionId,
      paddle_transaction_id: info.transactionId,
      paddle_price_id: info.priceId,
      user_id: info.userId,
      processed,
      ignored,
      payload: event,
      processed_at: processed ? new Date().toISOString() : null
    }
  });
}

// 抢占式去重：在处理之前先尝试插入 event_id。
// 冲突即说明重复事件，调用方应跳过处理。
async function tryAcquireWebhookLock(event: Record<string, unknown>, info: ReturnType<typeof getPaddleEventInfo>): Promise<{ duplicate: boolean }> {
  const response = await supabaseRest<{ event_id?: string }>("product_payment_webhook_events?on_conflict=event_id&select=event_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: {
      event_id: info.eventId,
      event_type: info.eventType,
      product_slug: getWebhookProductSlug(info),
      paddle_customer_id: info.customerId,
      paddle_subscription_id: info.subscriptionId,
      paddle_transaction_id: info.transactionId,
      paddle_price_id: info.priceId,
      user_id: info.userId,
      processed: false,
      ignored: false,
      payload: event,
      processed_at: null
    }
  });

  const inserted = Array.isArray(response) && response.length > 0;
  return { duplicate: !inserted };
}

async function markWebhookEventProcessed(info: ReturnType<typeof getPaddleEventInfo>, processed: boolean) {
  await supabaseRest(`product_payment_webhook_events?event_id=eq.${encodeURIComponent(info.eventId)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      processed,
      processed_at: new Date().toISOString()
    }
  });
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function getPaymentEmail(info: ReturnType<typeof getPaddleEventInfo>) {
  return normalizeEmail(info.customerEmail || info.customData.email);
}

function getTransactionStatus(info: ReturnType<typeof getPaddleEventInfo>) {
  const status = String(info.data.status || "").trim().toLowerCase();
  if (status) {
    return status;
  }
  if (info.eventType === "transaction.completed") {
    return "completed";
  }
  if (info.eventType === "transaction.paid") {
    return "paid";
  }
  return String(info.eventType || "").replace(/^transaction\./, "") || "unknown";
}

function isActiveSubscriptionStatus(status: unknown) {
  return ["active", "trialing", "past_due"].includes(String(status || "").toLowerCase());
}

async function getLatestActiveSubscription(userId: string, productSlug: string) {
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_subscriptions?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&status=in.(active,trialing,past_due)&select=*&order=updated_at.desc&limit=1`
  );
  return rows?.[0] || null;
}

async function getSubscriptionById(subscriptionId: string | null, productSlug: string) {
  if (!subscriptionId) {
    return null;
  }
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_subscriptions?paddle_subscription_id=eq.${encodeURIComponent(subscriptionId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=*&limit=1`
  );
  return rows?.[0] || null;
}

async function shouldTransactionGrantProfileAccess(info: ReturnType<typeof getPaddleEventInfo>) {
  if (info.plan?.lifetime) {
    return true;
  }

  const subscription = await getSubscriptionById(info.subscriptionId, getWebhookProductSlug(info));
  if (!subscription) {
    return true;
  }

  return isActiveSubscriptionStatus(subscription.status);
}

type ResolvedUser = { userId: string; profile: Record<string, unknown> | null };

async function getValidatedCustomUserId(info: ReturnType<typeof getPaddleEventInfo>): Promise<ResolvedUser | null> {
  if (!info.userId) {
    return null;
  }

  const expectedEmail = getPaymentEmail(info);
  const profile = await getProfileByUserId(info.userId, getWebhookProductSlug(info));
  if (!profile) {
    return null;
  }

  if (!expectedEmail) {
    return { userId: info.userId, profile };
  }

  const profileEmail = normalizeEmail(profile.email);
  if (!profileEmail || profileEmail !== expectedEmail) {
    return null;
  }

  return { userId: info.userId, profile };
}

async function resolveUserIdFromWebhook(info: ReturnType<typeof getPaddleEventInfo>): Promise<ResolvedUser | null> {
  // 安全策略：仅通过 custom_data.supabase_user_id（已邮箱校验）、
  // 历史 transaction/subscription/customer 记录反查 user_id。
  // 不再按邮箱兜底匹配 product_profiles，避免攻击者通过改邮箱冒领他人权益。
  const productSlug = getWebhookProductSlug(info);
  const validated = await getValidatedCustomUserId(info);
  if (validated) {
    return validated;
  }

  // 并发查询三类历史记录，避免串行等待。
  const [txUserId, subUserId, customerUserId] = await Promise.all([
    findUserIdByTransaction(info.transactionId, productSlug),
    findUserIdBySubscription(info.subscriptionId, productSlug),
    findUserIdByCustomer(info.customerId, productSlug)
  ]);
  const uniqueStoredOwners = Array.from(new Set([txUserId, subUserId, customerUserId].filter((value): value is string => Boolean(value))));
  if (uniqueStoredOwners.length > 1) {
    throw new Error("Conflicting Paddle ownership records.");
  }
  const userId = uniqueStoredOwners[0] || null;
  return userId ? { userId, profile: null } : null;
}

async function getLatestPaidLifetimeTransaction(userId: string, productSlug: string) {
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_transactions?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&status=in.(completed,paid,active)&billing_interval=eq.lifetime&select=*&order=updated_at.desc&limit=20`
  );
  // 排除已退款/撤单的终身交易
  const adjustments = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_adjustments?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&status=eq.approved&select=paddle_transaction_id,action,adjustment_type`
  );
  const revokedTransactionIds = new Set((adjustments || [])
    .filter((row) => String(row.action || "").startsWith("chargeback") ||
      (row.action === "refund" && row.adjustment_type === "full"))
    .map((row) => String(row.paddle_transaction_id || "")));
  return (rows || []).find((row) => !revokedTransactionIds.has(String(row.paddle_transaction_id || ""))) || null;
}

async function reconcileLifetimeAccess(userId: string, productSlug: string) {
  // 终身权益对账：检查用户是否还有有效的终身交易。
  // 退款/撤单后撤销 lifetime_access，避免资损。
  const profile = await getProfileByUserId(userId, productSlug) || {};
  const paidLifetime = await getLatestPaidLifetimeTransaction(userId, productSlug);
  const legacyLifetime = Boolean(profile.lifetime_access) && String(profile.lifetime_source || "") === "legacy";
  const activeSubscription = await getLatestActiveSubscription(userId, productSlug);
  await updateProfile(userId, {
    plan: paidLifetime || legacyLifetime || activeSubscription ? "pro" : "free",
    lifetime_access: Boolean(paidLifetime) || legacyLifetime,
    lifetime_source: paidLifetime ? "paddle" : legacyLifetime ? "legacy" : null,
    lifetime_transaction_id: paidLifetime?.paddle_transaction_id || null,
    ...(paidLifetime ? {
      paddle_transaction_id: paidLifetime.paddle_transaction_id,
      paddle_customer_id: paidLifetime.paddle_customer_id,
      paddle_price_id: paidLifetime.paddle_price_id,
      billing_interval: "lifetime"
    } : {})
  }, productSlug);
}

async function upsertCustomer(userId: string, customerId: string | null, email: string | null, productSlug: string) {
  if (!customerId) {
    return;
  }
  await supabaseRest("product_payment_customers?on_conflict=product_slug,paddle_customer_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      user_id: userId,
      product_slug: productSlug,
      provider_id: "paddle",
      paddle_customer_id: customerId,
      email
    }
  });
}

async function handleTransaction(info: ReturnType<typeof getPaddleEventInfo>) {
  const data = info.data;
  const details = asRecord(data.details);
  const totals = asRecord(details.totals);
  const productSlug = getWebhookProductSlug(info);
  const resolved = await resolveUserIdFromWebhook(info);
  const userId = resolved?.userId || null;
  if (!info.transactionId || !info.plan) {
    return false;
  }

  const paymentEmail = getPaymentEmail(info) || null;
  if (userId) {
    await upsertCustomer(userId, info.customerId, paymentEmail, productSlug);
  }

  // 用原子化 RPC 写入 transaction，附带事件乱序保护
  // （paddle_event_is_newer 防止旧事件覆盖新事件）。
  const transactionApplied = await supabaseRest<boolean>("rpc/apply_product_payment_transaction_event", {
    method: "POST",
    body: {
      p_record: {
        paddle_transaction_id: info.transactionId,
        user_id: userId || null,
        product_slug: productSlug,
        provider_id: "paddle",
        paddle_customer_id: info.customerId,
        paddle_subscription_id: info.subscriptionId,
        paddle_price_id: info.priceId,
        plan_id: info.plan.id,
        billing_interval: info.plan.billingInterval,
        status: getTransactionStatus(info),
        total_amount: typeof totals.grand_total === "string" ? totals.grand_total : null,
        currency_code: typeof totals.currency_code === "string" ? totals.currency_code : null,
        raw: data
      },
      p_occurred_at: info.occurredAt,
      p_event_id: info.eventId
    }
  });

  // RPC 返回 false：事件已被更新的事件覆盖，跳过处理。
  if (!transactionApplied) {
    return Boolean(userId);
  }

  // 退款/撤单事件：撤销终身权益
  const isRefundEvent = ["transaction.refunded", "transaction.voided", "transaction.canceled"].includes(info.eventType);
  if (userId && isRefundEvent && info.plan.lifetime) {
    await reconcileLifetimeAccess(userId, productSlug);
    return Boolean(userId);
  }

  if (userId && ["transaction.completed", "transaction.paid"].includes(info.eventType) && await shouldTransactionGrantProfileAccess(info)) {
    // 复用 resolveUserIdFromWebhook 已校验的 profile，避免重复 UPSERT；
    // 反查路径无 profile 时才回退到 ensureProfile（同时会刷新 email）。
    const profile = resolved?.profile || await ensureProfile({ id: userId, email: paymentEmail }, {}, productSlug) || {};
    await updateProfile(userId, {
      plan: "pro",
      product_slug: productSlug,
      provider_id: "paddle",
      paddle_customer_id: info.customerId,
      paddle_subscription_id: info.subscriptionId,
      paddle_transaction_id: info.transactionId,
      paddle_price_id: info.priceId,
      billing_interval: info.plan.billingInterval,
      lifetime_access: info.plan.lifetime || Boolean(profile.lifetime_access),
      ...(info.plan.lifetime ? {
        lifetime_source: "paddle",
        lifetime_transaction_id: info.transactionId
      } : {})
    }, productSlug);
  }

  // 终身交易：对账（处理已退款等情况）
  if (userId && info.plan.lifetime) {
    await reconcileLifetimeAccess(userId, productSlug);
  }
  return Boolean(userId);
}

async function handleSubscription(info: ReturnType<typeof getPaddleEventInfo>) {
  const data = info.data;
  const currentBillingPeriod = asRecord(data.current_billing_period);
  const productSlug = getWebhookProductSlug(info);
  const resolved = await resolveUserIdFromWebhook(info);
  const userId = resolved?.userId || null;
  if (!userId || !info.subscriptionId || !info.plan) {
    return false;
  }

  await upsertCustomer(userId, info.customerId, getPaymentEmail(info) || null, productSlug);

  // 跨产品订阅冲突检查：同一 paddle_subscription_id 不能被多个 user_id 持有。
  // 这是安全加固，防止攻击者通过改邮箱冒领他人订阅。
  const previousSubscriptions = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_subscriptions?paddle_subscription_id=eq.${encodeURIComponent(info.subscriptionId)}&select=product_slug,user_id,status`
  );
  if ((previousSubscriptions || []).some((row) => typeof row.user_id === "string" && row.user_id !== userId)) {
    throw new Error("Conflicting cross-product Paddle subscription ownership.");
  }

  // 用原子化 RPC 写入 subscription，附带事件乱序保护
  const subscriptionApplied = await supabaseRest<boolean>("rpc/apply_product_payment_subscription_event", {
    method: "POST",
    body: {
      p_record: {
        paddle_subscription_id: info.subscriptionId,
        user_id: userId,
        product_slug: productSlug,
        provider_id: "paddle",
        paddle_customer_id: info.customerId,
        paddle_price_id: info.priceId,
        plan_id: info.plan.id,
        billing_interval: info.plan.billingInterval,
        status: String(data.status || ""),
        current_period_start: toTimestamp(currentBillingPeriod.starts_at),
        current_period_end: toTimestamp(currentBillingPeriod.ends_at),
        canceled_at: toTimestamp(data.canceled_at),
        raw: data
      },
      p_occurred_at: info.occurredAt,
      p_event_id: info.eventId
    }
  });

  if (!subscriptionApplied) {
    return true;
  }

  // 对账：如果此订阅之前属于其他产品，需要为这些产品重新计算 lifetime_access
  const previousProductSlugs = Array.from(new Set((previousSubscriptions || [])
    .filter((row) => row.user_id === userId && typeof row.product_slug === "string" && row.product_slug !== productSlug)
    .map((row) => String(row.product_slug))));
  for (const previousProductSlug of previousProductSlugs) {
    await reconcileLifetimeAccess(userId, previousProductSlug);
  }

  const active = isActiveSubscriptionStatus(data.status);
  // 复用 resolveUserIdFromWebhook 已校验的 profile，避免重复 UPSERT；
  // 反查路径无 profile 时才回退到 ensureProfile（同时会刷新 email）。
  const profile = resolved?.profile || await ensureProfile({ id: userId, email: getPaymentEmail(info) || null }, {}, productSlug) || {};
  const latestActiveSubscription = active ? null : await getLatestActiveSubscription(userId, productSlug);
  const profileSubscription = latestActiveSubscription || null;
  await updateProfile(userId, {
    plan: active || Boolean(profileSubscription) || Boolean(profile.lifetime_access) ? "pro" : "free",
    product_slug: productSlug,
    provider_id: "paddle",
    paddle_customer_id: profileSubscription?.paddle_customer_id || info.customerId,
    paddle_subscription_id: profileSubscription?.paddle_subscription_id || info.subscriptionId,
    paddle_price_id: profileSubscription?.paddle_price_id || info.priceId,
    billing_interval: profileSubscription?.billing_interval || info.plan.billingInterval,
    current_period_end: profileSubscription?.current_period_end || toTimestamp(currentBillingPeriod.ends_at)
  }, productSlug);
  return true;
}

async function handleAdjustment(info: ReturnType<typeof getPaddleEventInfo>) {
  // 处理 Paddle adjustment 事件（退款/撤单/争议）。
  // 关联到原 transaction，更新 user_id 和 product_slug 后调用 RPC。
  const data = info.data;
  const adjustmentId = String(data.id || "");
  if (!adjustmentId.startsWith("adj_") || !info.transactionId) return false;
  const transactions = await supabaseRest<Record<string, unknown>[]>(
    `product_payment_transactions?paddle_transaction_id=eq.${encodeURIComponent(info.transactionId)}&select=*&limit=1`
  );
  const transaction = transactions?.[0] || null;
  const userId = typeof transaction?.user_id === "string" ? transaction.user_id : null;
  const productSlug = typeof transaction?.product_slug === "string" ? transaction.product_slug : null;
  if (!transaction || !userId || !productSlug) return false;
  info.userId = userId;
  info.productSlug = productSlug;
  const applied = await supabaseRest<boolean>("rpc/apply_product_payment_adjustment_event", {
    method: "POST",
    body: {
      p_record: {
        paddle_adjustment_id: adjustmentId,
        paddle_transaction_id: info.transactionId,
        user_id: userId,
        product_slug: productSlug,
        action: String(data.action || "").toLowerCase(),
        adjustment_type: String(data.type || "").toLowerCase(),
        status: String(data.status || "").toLowerCase(),
        raw: data
      },
      p_occurred_at: info.occurredAt,
      p_event_id: info.eventId
    }
  });
  let duplicateRetry = false;
  if (!applied) {
    const adjustmentRows = await supabaseRest<Record<string, unknown>[]>(
      `product_payment_adjustments?product_slug=eq.${encodeURIComponent(productSlug)}&paddle_adjustment_id=eq.${encodeURIComponent(adjustmentId)}&select=last_event_id&limit=1`
    );
    duplicateRetry = adjustmentRows?.[0]?.last_event_id === info.eventId;
  }
  // 退款/撤单后对账终身权益
  if ((applied || duplicateRetry) && String(transaction.billing_interval || "").toLowerCase() === "lifetime") {
    await reconcileLifetimeAccess(userId, productSlug);
  }
  return true;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    // 对齐其他端点：用 Request 版本响应，按 origin 白名单决定是否放行，避免返回 Access-Control-Allow-Origin: *
    return emptyResponseForRequest(request, isAllowedBrowserOrigin(request) ? 204 : 403);
  }
  if (request.method !== "POST") {
    return errorResponseForRequest(request, "Method not allowed.", 405);
  }

  try {
    const rawBody = await request.text();
    const valid = await verifyPaddleSignature(rawBody, request.headers.get("paddle-signature"));
    if (!valid) {
      return errorResponseForRequest(request, "Invalid Paddle webhook signature.", 401);
    }

    const event = JSON.parse(rawBody) as Record<string, unknown>;
    const info = getPaddleEventInfo(event);

    // 事件 ID 和时间戳格式校验
    if (!/^evt_[a-z0-9]+$/i.test(info.eventId) || !info.occurredAt) {
      return errorResponseForRequest(request, "Invalid Paddle event identity or timestamp.", 400);
    }

    // adjustment 事件单独路由（不经过 eventBelongsToProduct 检查）
    if (info.eventType.startsWith("adjustment.")) {
      // adjustment 事件也需要抢占式去重
      const lock = await tryAcquireWebhookLock(event, info);
      if (lock.duplicate) {
        return jsonResponseForRequest(request, { ok: true, processed: false, duplicate: true });
      }
      let processed = false;
      let processingError: Error | null = null;
      try {
        processed = await handleAdjustment(info);
      } catch (error) {
        processingError = error instanceof Error ? error : new Error(String(error));
      }
      if (processingError) {
        await supabaseRest(`product_payment_webhook_events?event_id=eq.${encodeURIComponent(info.eventId)}`, {
          method: "DELETE",
          prefer: "return=minimal"
        }).catch(() => void 0);
        throw processingError;
      }
      await markWebhookEventProcessed(info, processed);
      return jsonResponseForRequest(request, { ok: true, processed, ignored: !processed });
    }

    if (!eventBelongsToProduct(info)) {
      await insertWebhookEvent(event, info, true, false);
      return jsonResponseForRequest(request, { ok: true, ignored: true });
    }

    // 抢占式去重：先尝试插入 event_id，冲突即跳过处理。
    const lock = await tryAcquireWebhookLock(event, info);
    if (lock.duplicate) {
      return jsonResponseForRequest(request, { ok: true, processed: false, duplicate: true });
    }

    let processed = false;
    let processingError: Error | null = null;
    try {
      if (info.eventType.startsWith("transaction.")) {
        processed = await handleTransaction(info);
      } else if (info.eventType.startsWith("subscription.")) {
        processed = await handleSubscription(info);
      }
    } catch (error) {
      processingError = error instanceof Error ? error : new Error(String(error));
    }

    if (processingError) {
      // 处理失败：删除锁定记录，允许 Paddle 重试同一事件（重新 INSERT event_id）。
      // tryAcquireWebhookLock 使用 ON CONFLICT DO NOTHING，若记录仍存在则重试会被跳过，
      // 因此必须 DELETE 而非 PATCH。DELETE 本身失败的概率极低（.catch 容错），
      // 最坏情况下事件卡在 processed=false，需人工介入，但不会破坏幂等性。
      await supabaseRest(`product_payment_webhook_events?event_id=eq.${encodeURIComponent(info.eventId)}`, {
        method: "DELETE",
        prefer: "return=minimal"
      }).catch(() => void 0);
      throw processingError;
    }

    // 处理成功：更新 processed 状态
    await markWebhookEventProcessed(info, processed);

    return jsonResponseForRequest(request, { ok: true, processed });
  } catch (error) {
    // 不把内部异常 message 回传给调用方，避免泄漏 Supabase / Paddle 后端细节。
    console.error("Payment webhook failed.", error);
    return errorResponseForRequest(request, "Payment webhook failed.", 500);
  }
});
