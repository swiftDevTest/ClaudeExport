import { emptyResponseForRequest, errorResponseForRequest, isAllowedBrowserOrigin, jsonResponseForRequest, readJsonBody } from "../_shared/http.ts";
import { PRODUCT_SLUG } from "../_shared/plans.ts";
import { ensureProfile, getProfileByUserId, getUserFromRequest, publicProfile, supabaseRest } from "../_shared/supabase.ts";

const DEFAULT_FREE_DAILY_EXPORTS = 3;
const MAX_REQUESTED_COUNT = 10;
const MAX_STORED_EVENTS = 50;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getDailyLimit(profile: Record<string, unknown>) {
  if (profile.plan === "pro") {
    return 999999;
  }

  const limits = asRecord(profile.limits);
  const candidates = [
    limits.maxExportsPerDay,
    limits.daily_exports,
    limits.maxExports
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return Math.floor(number);
    }
  }

  return DEFAULT_FREE_DAILY_EXPORTS;
}

function normalizeRequestedCount(value: unknown) {
  const count = Math.max(1, Math.floor(Number(value) || 1));
  return Math.min(MAX_REQUESTED_COUNT, count);
}

function normalizeUsageRow(row: Record<string, unknown> | null, usageDate: string) {
  const exportedChats = Math.max(0, Number(row?.exported_chats || 0) || 0);
  const exportEvents = Array.isArray(row?.export_events) ? row.export_events.slice(-MAX_STORED_EVENTS) : [];
  return {
    date: usageDate,
    usage_date: usageDate,
    exportedChats,
    exported_chats: exportedChats,
    exportEvents,
    export_events: exportEvents
  };
}

async function getUsageRow(userId: string, usageDate: string) {
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `export_usage_daily?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${PRODUCT_SLUG}&usage_date=eq.${usageDate}&select=*&limit=1`
  );
  return rows?.[0] || null;
}

async function consumeUsage(userId: string, usageDate: string, requestedCount: number, dailyLimit: number) {
  return await supabaseRest<Record<string, unknown>>("rpc/consume_export_usage_daily", {
    method: "POST",
    body: {
      p_user_id: userId,
      p_product_slug: PRODUCT_SLUG,
      p_usage_date: usageDate,
      p_requested_count: requestedCount,
      p_daily_limit: dailyLimit,
      p_max_events: MAX_STORED_EVENTS
    }
  });
}

function normalizeConsumedUsage(value: Record<string, unknown> | null, usageDate: string) {
  if (!value) {
    return {
      consumed: false,
      usage: normalizeUsageRow(null, usageDate)
    };
  }

  const usage = normalizeUsageRow({
    usage_date: value.usage_date,
    exported_chats: value.exported_chats,
    export_events: value.export_events
  }, usageDate);

  return {
    consumed: value.consumed === true,
    usage
  };
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

    const body = await readJsonBody<Record<string, unknown>>(request);
    const requestedCount = normalizeRequestedCount(body.requested_count || body.count);
    const consume = body.consume === true;
    const usageDate = todayUtc();
    const profile = await getProfileByUserId(user.id) || {};
    const plan = String(profile.plan || "free");
    const isPro = plan === "pro";
    const dailyLimit = getDailyLimit(profile);

    const usageRow = await getUsageRow(user.id, usageDate);
    let usage = normalizeUsageRow(usageRow, usageDate);
    let remaining = isPro ? dailyLimit : Math.max(0, dailyLimit - usage.exportedChats);
    let allowed = isPro || requestedCount <= remaining;

    if (allowed && consume && !isPro) {
      const consumedUsage = normalizeConsumedUsage(
        await consumeUsage(user.id, usageDate, requestedCount, dailyLimit),
        usageDate
      );
      usage = consumedUsage.usage;
      remaining = Math.max(0, dailyLimit - usage.exportedChats);
      allowed = consumedUsage.consumed;
    }

    return jsonResponseForRequest(request, {
      ok: true,
      allowed,
      consume,
      requestedCount,
      remaining,
      limit: dailyLimit,
      profile: publicProfile(profile, user),
      usage
    });
  } catch (error) {
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Export entitlement verification failed.", 500);
  }
});
