import { emptyResponseForRequest, errorResponseForRequest, isAllowedBrowserOrigin, jsonResponseForRequest, readJsonBody } from "../_shared/http.ts";
import { getNewProductFromInput } from "../_shared/product-plans.ts";
import { getUserFromRequest, supabaseRest } from "../_shared/product-supabase.ts";

const ALLOWED_EVENTS = new Set([
  "auth_success",
  "export_success",
  "export_failed",
  "vip_view_exposure",
  "vip_sku_click",
  "vip_signin_required",
  "vip_purchase_click",
  "vip_style_click"
]);
const ALLOWED_PLATFORMS = new Set(["chatgpt", "claude", "gemini", "unknown"]);
const GUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROPERTY_KEY_PATTERN = /^[a-z0-9_]{1,40}$/i;
const MAX_EVENTS_PER_MINUTE_PER_GUEST = 120;
const MAX_EVENTS_PER_MINUTE_PER_SOURCE = 300;

function sanitizeProperties(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const output: Record<string, unknown> = {};
  for (const [key, propertyValue] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (!PROPERTY_KEY_PATTERN.test(key)) {
      continue;
    }
    if (
      propertyValue === null ||
      typeof propertyValue === "string" ||
      typeof propertyValue === "number" ||
      typeof propertyValue === "boolean"
    ) {
      output[key] = typeof propertyValue === "string" ? propertyValue.slice(0, 200) : propertyValue;
    }
  }

  return output;
}

function sanitizeEvent(value: unknown, guestId: string, userId: string | null, productSlug: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  const eventName = String(event.event_name || "");
  if (!ALLOWED_EVENTS.has(eventName)) {
    return null;
  }

  const platform = ALLOWED_PLATFORMS.has(String(event.platform)) ? String(event.platform) : "unknown";
  const clientTimestamp = event.client_timestamp ? String(event.client_timestamp) : null;
  const properties = sanitizeProperties(event.properties);

  return {
    guest_id: guestId,
    user_id: userId,
    product_slug: productSlug,
    event_name: eventName,
    platform,
    properties,
    client_timestamp: clientTimestamp
  };
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getClientAddress(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") || "";
  const candidates = [
    request.headers.get("cf-connecting-ip") || "",
    request.headers.get("x-real-ip") || "",
    forwardedFor.split(",")[0] || ""
  ];
  const address = candidates.map((value) => value.trim()).find(Boolean) || "unknown";
  return address.slice(0, 80);
}

async function getSourceFingerprint(request: Request) {
  const origin = request.headers.get("origin") || "no-origin";
  const userAgent = (request.headers.get("user-agent") || "unknown").slice(0, 160);
  return await sha256Hex(`${origin}|${getClientAddress(request)}|${userAgent}`);
}

async function consumeRateLimit(bucketKey: string, eventCount: number, limit: number, productSlug: string) {
  const consumed = await supabaseRest<boolean>("rpc/try_consume_product_edge_rate_limit", {
    method: "POST",
    body: {
      p_bucket_key: bucketKey,
      p_product_slug: productSlug,
      p_increment: eventCount,
      p_limit: limit
    }
  });
  return consumed === true;
}

async function consumeAnalyticsRateLimit(request: Request, guestId: string, eventCount: number, productSlug: string) {
  const minuteBucket = Math.floor(Date.now() / 60000);
  const guestBucketKey = `${productSlug}:analytics:guest:${guestId}:${minuteBucket}`;
  const sourceBucketKey = `${productSlug}:analytics:source:${await getSourceFingerprint(request)}:${minuteBucket}`;

  const guestAllowed = await consumeRateLimit(guestBucketKey, eventCount, MAX_EVENTS_PER_MINUTE_PER_GUEST, productSlug);
  if (!guestAllowed) {
    return false;
  }

  return await consumeRateLimit(sourceBucketKey, eventCount, MAX_EVENTS_PER_MINUTE_PER_SOURCE, productSlug);
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
    const guestId = String(body.guest_id || "").trim();
    if (!GUEST_ID_PATTERN.test(guestId)) {
      return errorResponseForRequest(request, "guest_id is invalid.", 400);
    }

    let userId: string | null = null;
    try {
      const user = await getUserFromRequest(request);
      userId = user.id;
    } catch (_error) {
      userId = null;
    }

    const events = Array.isArray(body.events) ? body.events : [];
    const rows = events
      .slice(0, 25)
      .map((event) => sanitizeEvent(event, guestId, userId, productSlug))
      .filter((event): event is Record<string, unknown> => Boolean(event));

    if (rows.length > 0) {
      const allowed = await consumeAnalyticsRateLimit(request, guestId, rows.length, productSlug);
      if (!allowed) {
        return errorResponseForRequest(request, "Analytics rate limit exceeded.", 429);
      }
      await supabaseRest("product_analytics_events", {
        method: "POST",
        prefer: "return=minimal",
        body: rows
      });
    }

    return jsonResponseForRequest(request, { ok: true, inserted: rows.length });
  } catch (error) {
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Analytics track failed.", 500);
  }
});
