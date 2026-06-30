import { BillingPlan, findPlan, PRODUCT_SLUG } from "./plans.ts";

export type PaddleEventInfo = {
  eventId: string;
  eventType: string;
  data: Record<string, unknown>;
  customData: Record<string, unknown>;
  priceId: string | null;
  plan: BillingPlan | null;
  productSlug: string | null;
  userId: string | null;
  customerEmail: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  transactionId: string | null;
};

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

export async function verifyPaddleSignature(rawBody: string, signatureHeader: string | null) {
  const secret = Deno.env.get("PADDLE_WEBHOOK_SECRET");
  if (!secret) {
    throw new Error("PADDLE_WEBHOOK_SECRET is not configured.");
  }
  if (!signatureHeader) {
    return false;
  }

  const parts = signatureHeader.split(";").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("ts="))?.slice(3);
  const signatures = parts.filter((part) => part.startsWith("h1=")).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const toleranceSeconds = Number(Deno.env.get("PADDLE_WEBHOOK_TOLERANCE_SECONDS") || 300);
  const timestampSeconds = Number(timestamp);
  if (Number.isFinite(timestampSeconds) && toleranceSeconds > 0) {
    const age = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
    if (age > toleranceSeconds) {
      return false;
    }
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}:${rawBody}`));
  const computed = bytesToHex(digest);
  return signatures.some((signature) => safeEqual(signature, computed));
}

export function getPaddleApiBase() {
  return (Deno.env.get("PADDLE_ENV") || "production").toLowerCase() === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
}

export async function paddleRequest<T = unknown>(path: string, options: {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
} = {}): Promise<T> {
  const apiKey = Deno.env.get("PADDLE_API_KEY");
  if (!apiKey) {
    throw new Error("PADDLE_API_KEY is not configured.");
  }

  const response = await fetch(`${getPaddleApiBase()}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Paddle API ${path} failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) as T : null as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function getPaddleEventInfo(event: Record<string, unknown>): PaddleEventInfo {
  const data = asRecord(event.data);
  const customData = asRecord(data.custom_data);
  const details = asRecord(data.details);
  const lineItems = Array.isArray(details.line_items) ? details.line_items.map(asRecord) : [];
  const items = Array.isArray(data.items) ? data.items.map(asRecord) : [];
  const firstItem = items[0] || {};
  const firstPrice = asRecord(firstItem.price);
  const firstLineItem = lineItems[0] || {};
  const firstLineProduct = asRecord(firstLineItem.product);
  const customer = asRecord(data.customer);

  const priceId = firstString([
    data.price_id,
    firstPrice.id,
    firstItem.price_id,
    firstLineItem.price_id
  ]);
  const plan = findPlan({
    priceId,
    providerPriceId: customData.provider_price_id,
    planId: customData.plan_id || customData.plan,
    billingInterval: customData.billing_interval
  });
  const productSlug = firstString([
    customData.product_slug,
    customData.product,
    customData.product_id,
    firstLineProduct.custom_data && asRecord(firstLineProduct.custom_data).product_slug
  ]);

  return {
    eventId: firstString([event.event_id, event.id]) || `${event.event_type || "unknown"}:${crypto.randomUUID()}`,
    eventType: String(event.event_type || "unknown"),
    data,
    customData,
    priceId,
    plan,
    productSlug,
    userId: firstString([customData.supabase_user_id, customData.user_id]),
    customerEmail: firstString([customData.email, data.customer_email, customer.email]),
    customerId: firstString([data.customer_id, customData.customer_id]),
    subscriptionId: firstString([data.subscription_id, customData.subscription_id, data.id && String(data.id).startsWith("sub_") ? data.id : null]),
    transactionId: firstString([data.id && String(data.id).startsWith("txn_") ? data.id : null, data.transaction_id, customData.transaction_id])
  };
}

export function eventBelongsToProduct(info: PaddleEventInfo) {
  return info.plan !== null || info.productSlug === PRODUCT_SLUG;
}
