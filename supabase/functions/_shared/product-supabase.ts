import { DEFAULT_PRODUCT_SLUG, resolveProductSlug } from "./product-plans.ts";

export type AuthUser = {
  id: string;
  email?: string | null;
};

export type RestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  prefer?: string;
};

export function getSupabaseUrl() {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) {
    throw new Error("SUPABASE_URL is not configured.");
  }
  return url.replace(/\/$/, "");
}

export function getServiceRoleKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) {
    return legacy;
  }

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (parsed && typeof parsed === "object") {
        const firstKey = Object.values(parsed).find((value) => typeof value === "string" && value.length > 20);
        if (typeof firstKey === "string") {
          return firstKey;
        }
      }
    } catch (_error) {
      // Fall through to the explicit error below.
    }
  }

  throw new Error("Supabase service role key is not available.");
}

export async function supabaseRest<T = unknown>(path: string, options: RestOptions = {}): Promise<T> {
  const method = options.method || "GET";
  const serviceRoleKey = getServiceRoleKey();
  const response = await fetch(`${getSupabaseUrl()}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase REST ${method} ${path} failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) as T : null as T;
}

export async function getUserFromRequest(request: Request): Promise<AuthUser> {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error("Missing user access token.");
  }

  const accessToken = match[1];
  const response = await fetch(`${getSupabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: getServiceRoleKey(),
      Authorization: `Bearer ${accessToken}`
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Invalid user access token: ${response.status} ${text}`);
  }

  const user = JSON.parse(text) as AuthUser;
  if (!user?.id) {
    throw new Error("User session has no id.");
  }
  return user;
}

export async function ensureProfile(user: AuthUser, updates: Record<string, unknown> = {}, productSlugInput?: unknown) {
  const productSlug = resolveProductSlug(productSlugInput || updates.product_slug || DEFAULT_PRODUCT_SLUG);
  const rows = await supabaseRest<Record<string, unknown>[]>("product_profiles?on_conflict=user_id,product_slug", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      user_id: user.id,
      email: user.email || null,
      ...updates,
      product_slug: productSlug
    }
  });
  return rows?.[0] || null;
}

export async function getProfileByUserId(userId: string, productSlugInput?: unknown) {
  const productSlug = resolveProductSlug(productSlugInput || DEFAULT_PRODUCT_SLUG);
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_profiles?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}&select=*&limit=1`
  );
  return rows?.[0] || null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrDefault(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function publicProfile(profile: Record<string, unknown> | null | undefined, user?: AuthUser) {
  const source = asRecord(profile);
  return {
    id: stringOrDefault(source.id || source.user_id, user?.id || ""),
    user_id: stringOrDefault(source.user_id, user?.id || ""),
    email: stringOrDefault(source.email, user?.email || ""),
    product_slug: stringOrDefault(source.product_slug, DEFAULT_PRODUCT_SLUG),
    plan: source.plan === "pro" ? "pro" : "free",
    feature_flags: asRecord(source.feature_flags),
    limits: asRecord(source.limits),
    billing_interval: stringOrDefault(source.billing_interval),
    current_period_end: stringOrDefault(source.current_period_end),
    lifetime_access: source.lifetime_access === true,
    updated_at: stringOrDefault(source.updated_at)
  };
}

export async function updateProfile(userId: string, updates: Record<string, unknown>, productSlugInput?: unknown) {
  const productSlug = resolveProductSlug(productSlugInput || updates.product_slug || DEFAULT_PRODUCT_SLUG);
  const rows = await supabaseRest<Record<string, unknown>[]>(
    `product_profiles?user_id=eq.${encodeURIComponent(userId)}&product_slug=eq.${encodeURIComponent(productSlug)}`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        ...updates,
        product_slug: productSlug
      }
    }
  );
  return rows?.[0] || null;
}
