export const PRODUCT_ID = "ai_chat_export";
export const PRODUCT_SLUG = "ai-chat-export";
export const PRODUCT_NAME = "AI Chat Export";

export type BillingPlan = {
  id: "monthly" | "yearly" | "lifetime";
  priceId: string;
  billingInterval: "monthly" | "yearly" | "lifetime";
  lifetime: boolean;
};

export const BILLING_PLANS: BillingPlan[] = [
  {
    id: "monthly",
    priceId: "pri_01kvdgya1nx70xhax2h5d8at0n",
    billingInterval: "monthly",
    lifetime: false
  },
  {
    id: "yearly",
    priceId: "pri_01kvdh0jc0nrpbfjt60509nw6x",
    billingInterval: "yearly",
    lifetime: false
  },
  {
    id: "lifetime",
    priceId: "pri_01kvdh1ank00x91xc3qtv2bkw2",
    billingInterval: "lifetime",
    lifetime: true
  }
];

export function findPlan(input: {
  priceId?: unknown;
  providerPriceId?: unknown;
  planId?: unknown;
  billingInterval?: unknown;
}): BillingPlan | null {
  const priceId = String(input.priceId || input.providerPriceId || "").trim();
  const planId = String(input.planId || "").trim();
  const billingInterval = String(input.billingInterval || "").trim();

  return BILLING_PLANS.find((plan) => {
    return plan.priceId === priceId ||
      plan.id === planId ||
      plan.billingInterval === billingInterval;
  }) || null;
}

export function findPlanByPriceId(priceId: unknown): BillingPlan | null {
  const normalized = String(priceId || "").trim();
  return BILLING_PLANS.find((plan) => plan.priceId === normalized) || null;
}

export function isProductSlugAllowed(value: unknown) {
  const normalized = String(value || PRODUCT_SLUG).trim();
  return !normalized || normalized === PRODUCT_SLUG || normalized === PRODUCT_ID || normalized === PRODUCT_NAME;
}
