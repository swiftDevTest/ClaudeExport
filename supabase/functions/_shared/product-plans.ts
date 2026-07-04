export const DEFAULT_PRODUCT_SLUG = "ai-chat-export";
export const PRODUCT_SLUG = DEFAULT_PRODUCT_SLUG;
export const PRODUCT_ID = "ai_chat_export";
export const PRODUCT_NAME = "AI Chat Export";

const NEW_PRODUCT_SLUGS = new Set([
  "chatgpt-export",
  "claude-export",
  "gemini-export"
]);

export type BillingPlan = {
  id: "monthly" | "yearly" | "lifetime";
  priceId: string;
  billingInterval: "monthly" | "yearly" | "lifetime";
  lifetime: boolean;
};

export type ProductBillingConfig = {
  productId: string;
  productSlug: string;
  productName: string;
  checkoutUrl: string;
  billingPlans: BillingPlan[];
};

type ProductConfigInput = {
  product_id?: string;
  productSlug?: string;
  product_slug?: string;
  productName?: string;
  product_name?: string;
  checkoutUrl?: string;
  checkout_url?: string;
  prices?: Record<string, string>;
  billingPlans?: BillingPlan[];
  billing_plans?: BillingPlan[];
};

const AI_CHAT_EXPORT_PRICES = {
  monthly: "pri_01kvdgya1nx70xhax2h5d8at0n",
  yearly: "pri_01kvdh0jc0nrpbfjt60509nw6x",
  lifetime: "pri_01kvdh1ank00x91xc3qtv2bkw2"
};

const PRODUCT_DEFAULTS: Record<string, ProductBillingConfig> = {
  "ai-chat-export": createProductConfig({
    productId: "ai_chat_export",
    productSlug: "ai-chat-export",
    productName: "AI Chat Export",
    checkoutUrl: "https://tabpilotpro.com/aichatexport/checkout",
    prices: AI_CHAT_EXPORT_PRICES
  }),
  "chatgpt-export": createProductConfig({
    productId: "chatgpt_export",
    productSlug: "chatgpt-export",
    productName: "ChatGPT Export",
    checkoutUrl: "https://tabpilotpro.com/chatgpt/checkout.html",
    prices: {
      monthly: Deno.env.get("CHATGPT_EXPORT_MONTHLY_PRICE_ID") || "pri_01kwkjv6hp7vvd49r12gf43jpq",
      yearly: Deno.env.get("CHATGPT_EXPORT_YEARLY_PRICE_ID") || "pri_01kwkjw7mgfjzt6qvkw0ncx5ag",
      lifetime: Deno.env.get("CHATGPT_EXPORT_LIFETIME_PRICE_ID") || "pri_01kwkk01daqp2vd5exwam7wafr"
    }
  }),
  "claude-export": createProductConfig({
    productId: "claude_export",
    productSlug: "claude-export",
    productName: "Claude Export",
    checkoutUrl: "https://tabpilotpro.com/claude/checkout.html",
    prices: {
      monthly: Deno.env.get("CLAUDE_EXPORT_MONTHLY_PRICE_ID") || "pri_01kwkkbazhrwpgttsa18j4g1pg",
      yearly: Deno.env.get("CLAUDE_EXPORT_YEARLY_PRICE_ID") || "pri_01kwkkd4065nnr6b6ktsx3w2qa",
      lifetime: Deno.env.get("CLAUDE_EXPORT_LIFETIME_PRICE_ID") || "pri_01kwkke4mdmre2xme8t4n5mya3"
    }
  }),
  "gemini-export": createProductConfig({
    productId: "gemini_export",
    productSlug: "gemini-export",
    productName: "Gemini Export",
    checkoutUrl: "https://tabpilotpro.com/gemini/checkout.html",
    prices: {
      monthly: Deno.env.get("GEMINI_EXPORT_MONTHLY_PRICE_ID") || "pri_01kwkk5fmnk5xepdzn5nex7x3z",
      yearly: Deno.env.get("GEMINI_EXPORT_YEARLY_PRICE_ID") || "pri_01kwkk78xb8fnnda0rzfnwjvn8",
      lifetime: Deno.env.get("GEMINI_EXPORT_LIFETIME_PRICE_ID") || "pri_01kwkk8611y95my6dgmzhbynvp"
    }
  })
};

function createPlan(id: BillingPlan["id"], priceId: string): BillingPlan {
  return {
    id,
    priceId,
    billingInterval: id,
    lifetime: id === "lifetime"
  };
}

function createProductConfig(input: {
  productId: string;
  productSlug: string;
  productName: string;
  checkoutUrl: string;
  prices: Record<string, string>;
}): ProductBillingConfig {
  return {
    productId: input.productId,
    productSlug: input.productSlug,
    productName: input.productName,
    checkoutUrl: input.checkoutUrl,
    billingPlans: [
      createPlan("monthly", input.prices.monthly || ""),
      createPlan("yearly", input.prices.yearly || ""),
      createPlan("lifetime", input.prices.lifetime || "")
    ]
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getEnvProductOverrides(): Record<string, ProductConfigInput> {
  const raw = Deno.env.get("PRODUCT_BILLING_CONFIG") || "";
  if (!raw) {
    return {};
  }
  try {
    return asRecord(JSON.parse(raw)) as Record<string, ProductConfigInput>;
  } catch (_error) {
    return {};
  }
}

function normalizeProductSlug(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (PRODUCT_DEFAULTS[normalized]) {
    return normalized;
  }

  const match = Object.values(PRODUCT_DEFAULTS).find((product) => {
    return normalized === product.productId ||
      normalized === product.productName.toLowerCase() ||
      normalized === product.productSlug;
  });
  return match?.productSlug || "";
}

function normalizeOverride(slug: string, override: ProductConfigInput): Partial<ProductBillingConfig> {
  const source = asRecord(override);
  const prices = asRecord(source.prices);
  const billingPlans = Array.isArray(source.billingPlans)
    ? source.billingPlans
    : Array.isArray(source.billing_plans)
      ? source.billing_plans
      : null;

  return {
    productId: String(source.product_id || source.productId || "").trim() || undefined,
    productSlug: String(source.product_slug || source.productSlug || slug).trim() || undefined,
    productName: String(source.product_name || source.productName || "").trim() || undefined,
    checkoutUrl: String(source.checkout_url || source.checkoutUrl || "").trim() || undefined,
    billingPlans: billingPlans || [
      createPlan("monthly", String(prices.monthly || "").trim()),
      createPlan("yearly", String(prices.yearly || "").trim()),
      createPlan("lifetime", String(prices.lifetime || "").trim())
    ]
  };
}

export function resolveProductSlug(value: unknown): string {
  return normalizeProductSlug(value) || DEFAULT_PRODUCT_SLUG;
}

export function resolveNewProductSlug(value: unknown): string {
  const productSlug = normalizeProductSlug(value);
  return productSlug && NEW_PRODUCT_SLUGS.has(productSlug) ? productSlug : "";
}

export function getProductConfig(productSlugInput?: unknown): ProductBillingConfig {
  const productSlug = resolveProductSlug(productSlugInput);
  const base = PRODUCT_DEFAULTS[productSlug] || PRODUCT_DEFAULTS[DEFAULT_PRODUCT_SLUG];
  const overrides = getEnvProductOverrides();
  const override = overrides[productSlug] ? normalizeOverride(productSlug, overrides[productSlug]) : {};
  return {
    ...base,
    ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined && value !== "")),
    productSlug,
    billingPlans: override.billingPlans || base.billingPlans
  };
}

export function getProductFromInput(input: Record<string, unknown> = {}): ProductBillingConfig {
  return getProductConfig(
    input.product_slug ||
      input.product ||
      input.product_id ||
      input.product_name
  );
}

export function getNewProductFromInput(input: Record<string, unknown> = {}): ProductBillingConfig | null {
  const productSlug = resolveNewProductSlug(
    input.product_slug ||
      input.product ||
      input.product_id ||
      input.product_name
  );
  return productSlug ? getProductConfig(productSlug) : null;
}

export function findPlan(input: {
  priceId?: unknown;
  providerPriceId?: unknown;
  planId?: unknown;
  billingInterval?: unknown;
}, productSlugInput?: unknown): BillingPlan | null {
  const product = getProductConfig(productSlugInput);
  const priceId = String(input.priceId || input.providerPriceId || "").trim();
  const planId = String(input.planId || "").trim();
  const billingInterval = String(input.billingInterval || "").trim();

  return product.billingPlans.find((plan) => {
    return (!!priceId && plan.priceId === priceId) ||
      plan.id === planId ||
      plan.billingInterval === billingInterval;
  }) || null;
}

export function findPlanByPriceId(priceId: unknown, productSlugInput?: unknown): BillingPlan | null {
  const normalized = String(priceId || "").trim();
  if (!normalized) {
    return null;
  }
  if (productSlugInput) {
    return findPlan({ priceId: normalized }, productSlugInput);
  }
  for (const product of Object.values(PRODUCT_DEFAULTS)) {
    const plan = findPlan({ priceId: normalized }, product.productSlug);
    if (plan) {
      return plan;
    }
  }
  return null;
}

export function isProductSlugAllowed(value: unknown) {
  return Boolean(resolveNewProductSlug(value));
}
