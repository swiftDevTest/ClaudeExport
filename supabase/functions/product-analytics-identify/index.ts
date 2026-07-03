import { emptyResponseForRequest, errorResponseForRequest, isAllowedBrowserOrigin, jsonResponseForRequest, readJsonBody } from "../_shared/http.ts";
import { getNewProductFromInput } from "../_shared/product-plans.ts";
import { ensureProfile, getUserFromRequest, supabaseRest } from "../_shared/product-supabase.ts";

const GUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const body = await readJsonBody<Record<string, unknown>>(request);
    const product = getNewProductFromInput(body);
    if (!product) {
      return errorResponseForRequest(request, "Unsupported product.", 400);
    }
    const guestId = String(body.guest_id || "").trim();
    if (!GUEST_ID_PATTERN.test(guestId)) {
      return errorResponseForRequest(request, "guest_id is invalid.", 400);
    }

    await ensureProfile(user, {}, product.productSlug);
    await supabaseRest("product_analytics_identities?on_conflict=product_slug,guest_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        guest_id: guestId,
        user_id: user.id,
        product_slug: product.productSlug
      }
    });

    return jsonResponseForRequest(request, { ok: true });
  } catch (error) {
    return errorResponseForRequest(request, error instanceof Error ? error.message : "Analytics identify failed.", 500);
  }
});
