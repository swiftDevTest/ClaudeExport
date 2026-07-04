import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const storageMap = new Map();

globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    lastError: null
  },
  i18n: {
    getMessage() {
      return "";
    },
    getUILanguage() {
      return "en";
    }
  },
  storage: {
    local: {
      get(keys, callback) {
        const result = {};
        if (typeof keys === "string") {
          result[keys] = storageMap.get(keys);
        } else if (Array.isArray(keys)) {
          keys.forEach((key) => {
            result[key] = storageMap.get(key);
          });
        }
        callback(result);
      },
      set(items, callback) {
        Object.keys(items || {}).forEach((key) => {
          storageMap.set(key, items[key]);
        });
        if (callback) callback();
      },
      remove(keys, callback) {
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
          storageMap.delete(key);
        });
        if (callback) callback();
      }
    }
  }
};

globalThis.CHATVAULT_I18N = {
  t(_key, fallback) {
    return fallback;
  }
};

await import("../src/product-config.js");
await import("../src/modules/entitlements.js");
await import("../src/modules/billing.js");

const productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG;
const entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
const billing = globalThis.CHATVAULT_BILLING;

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("product entitlement cache is namespaced, encrypted, and account-scoped", async () => {
  storageMap.clear();

  assert.equal(
    entitlements.ENTITLEMENT_STATE_CACHE_KEY,
    `${productConfig.storageNamespace}.entitlement_state.v1`
  );

  const cached = await entitlements.saveCachedState({
    session: {
      access_token: "secret-token",
      user: {
        id: "user-1",
        email: "vip@test.com",
        user_metadata: {
          avatar_url: "https://example.com/avatar.png",
          provider_token: "secret-provider-token"
        }
      }
    },
    profile: {
      id: "user-1",
      email: "vip@test.com",
      product_slug: productConfig.productSlug,
      plan: "pro"
    },
    usage: {
      date: entitlements.getTodayString(),
      exportedChats: 2
    }
  });

  assert.equal(cached.isProUser, true);
  assert.equal(cached.profile.product_slug, productConfig.productSlug);
  assert.equal(cached.session.user.email, "vip@test.com");

  const raw = storageMap.get(entitlements.ENTITLEMENT_STATE_CACHE_KEY);
  assert.equal(raw.v, entitlements.ENTITLEMENT_STATE_CACHE_CRYPTO_VERSION);
  assert.equal(raw.alg, entitlements.ENTITLEMENT_STATE_CACHE_CRYPTO_ALG);
  assert.equal(typeof raw.payload, "string");
  assert.equal(JSON.stringify(raw).includes("vip@test.com"), false);
  assert.equal(JSON.stringify(raw).includes("secret-token"), false);

  const loaded = await entitlements.getCachedState();
  assert.equal(loaded.profile.plan, "pro");
  assert.equal(loaded.profile.product_slug, productConfig.productSlug);

  await entitlements.clearCachedState();
  assert.equal(await entitlements.getCachedState(), null);
});

test("billing and entitlement refresh call product-scoped Edge Functions", () => {
  const contentSource = readText("../src/content.js");
  const popupSource = readText("../src/popup.js");
  const backgroundSource = readText("../src/background.js");

  assert.equal(billing.productId, productConfig.productId);
  assert.equal(billing.productSlug, productConfig.productSlug);
  assert.equal(billing.productName, productConfig.productName);
  assert.equal(billing.getPlan("monthly").price, "$3.99");
  assert.equal(billing.getPlan("yearly").price, "$24.99");
  assert.equal(billing.getPlan("lifetime").price, "$39.99");
  assert.equal(entitlements.PRO_PRICES.monthly.price, "$3.99");
  assert.equal(entitlements.PRO_PRICES.yearly.price, "$24.99");
  assert.equal(entitlements.PRO_PRICES.lifetime.price, "$39.99");
  assert.match(
    billing.createCheckoutSession.toString(),
    /\/functions\/v1\/product-create-checkout-session/
  );

  const body = billing.getCheckoutRequestBody("yearly", "test", {
    customerEmail: "buyer@example.com"
  });
  assert.equal(body.product_id, productConfig.productId);
  assert.equal(body.product_slug, productConfig.productSlug);
  assert.equal(body.product_name, productConfig.productName);
  assert.equal(body.customer_email, "buyer@example.com");
  assert.equal(body.provider_id, "paddle");

  assert.match(backgroundSource, /\/functions\/v1\/product-sync-subscription-status/);
  assert.match(contentSource, /\/functions\/v1\/product-sync-subscription-status/);
  assert.match(contentSource, /\/functions\/v1\/product-verify-export-entitlement/);
  assert.match(popupSource, /\/functions\/v1\/product-sync-subscription-status/);
  assert.match(popupSource, /\/functions\/v1\/product-verify-export-entitlement/);
});

test("auth and entitlement UI refresh mirrors the ChatVault fixed flow", () => {
  const popupSource = readText("../src/popup.js");
  const contentSource = readText("../src/content.js");
  const backgroundSource = readText("../src/background.js");

  const backgroundStart = backgroundSource.indexOf("const session = await exchangeGoogleIdTokenForSupabaseSession");
  const backgroundEnd = backgroundSource.indexOf("resolve({ session", backgroundStart);
  const backgroundAuthSource = backgroundSource.slice(backgroundStart, backgroundEnd);
  const popupHookStart = popupSource.indexOf("globalThis.CHATVAULT_REFRESH_AUTH_STATE = async function");
  const popupHookEnd = popupSource.indexOf("\n  // 共享更新登录状态", popupHookStart);
  const popupHookSource = popupSource.slice(popupHookStart, popupHookEnd);
  const contentHookStart = contentSource.indexOf("globalThis.CHATVAULT_REFRESH_AUTH_STATE = async");
  const contentHookEnd = contentSource.indexOf("\n  }\n\n\n  // === 侧边栏抓取工具函数", contentHookStart);
  const contentHookSource = contentSource.slice(contentHookStart, contentHookEnd);
  const contentSignInStart = contentSource.indexOf("async function performSignIn()");
  const contentSignInEnd = contentSource.indexOf("\n  // 购买跳转流程", contentSignInStart);
  const contentSignInSource = contentSource.slice(contentSignInStart, contentSignInEnd);

  assert.notEqual(backgroundStart, -1);
  assert.notEqual(backgroundEnd, -1);
  assert.notEqual(popupHookStart, -1);
  assert.notEqual(popupHookEnd, -1);
  assert.notEqual(contentHookStart, -1);
  assert.notEqual(contentHookEnd, -1);
  assert.notEqual(contentSignInStart, -1);
  assert.notEqual(contentSignInEnd, -1);

  assert.match(backgroundAuthSource, /syncSubscriptionStatusForSession\(session\)\.catch/);
  assert.doesNotMatch(backgroundAuthSource, /await syncSubscriptionStatusForSession\(session\)/);
  assert.match(popupSource, /chrome\.storage\.onChanged\.addListener/);
  assert.match(contentSource, /chrome\.storage\.onChanged\.addListener/);
  assert.match(contentSource, /applyStoredAuthStateImmediately\(sessionChange\.newValue\)/);
  assert.match(popupSource, /if \(!sessionEmail && !sessionUserId\) return false;/);
  assert.match(contentSource, /if \(!sessionEmail && !sessionUserId\) return false;/);
  assert.ok(popupHookSource.indexOf("await showStoredAuthStateImmediately()") < popupHookSource.indexOf("refreshPopupState(true)"));
  assert.ok(contentHookSource.indexOf("await applyStoredAuthStateImmediately()") < contentHookSource.indexOf("refreshAuthStateInBackground()"));
  assert.ok(contentSignInSource.indexOf("await applyStoredAuthStateImmediately(session)") < contentSignInSource.indexOf("refreshAuthStateInBackground()"));
});

test("async entitlement refresh updates the already-open popup", () => {
  const popupSource = readText("../src/popup.js");
  const contentSource = readText("../src/content.js");

  const listenerStart = popupSource.indexOf("function listenContentEntitlementUpdates()");
  const listenerEnd = popupSource.indexOf("\n  async function getLocalFreeQuotaGateState", listenerStart);
  const notifyStart = contentSource.indexOf("function notifyPopupEntitlementStateUpdated()");
  const notifyEnd = contentSource.indexOf("\n  async function getLocalUsageSnapshot", notifyStart);
  const refreshStart = contentSource.indexOf("function refreshAuthStateInBackground()");
  const refreshEnd = contentSource.indexOf("\n  function getStorageChange", refreshStart);
  const verifyStart = contentSource.indexOf("async function syncVerifiedExportEntitlement");
  const verifyEnd = contentSource.indexOf("\n  async function recordSuccessfulExportUsage", verifyStart);
  const listenerSource = popupSource.slice(listenerStart, listenerEnd);
  const notifySource = contentSource.slice(notifyStart, notifyEnd);
  const refreshSource = contentSource.slice(refreshStart, refreshEnd);
  const verifySource = contentSource.slice(verifyStart, verifyEnd);

  assert.notEqual(listenerStart, -1);
  assert.notEqual(listenerEnd, -1);
  assert.notEqual(notifyStart, -1);
  assert.notEqual(notifyEnd, -1);
  assert.notEqual(refreshStart, -1);
  assert.notEqual(refreshEnd, -1);
  assert.notEqual(verifyStart, -1);
  assert.notEqual(verifyEnd, -1);

  assert.match(listenerSource, /CHATVAULT_ENTITLEMENT_STATE_UPDATED/);
  assert.match(listenerSource, /sender\.tab\.id !== activeTabId/);
  assert.match(listenerSource, /applyVerifiedPopupStateResponse\(message\.state \|\| message\)/);
  assert.match(notifySource, /CHATVAULT_ENTITLEMENT_STATE_UPDATED/);
  assert.match(notifySource, /buildEntitlementPopupStateSnapshot\(\)/);
  assert.match(refreshSource, /notifyPopupEntitlementStateUpdated\(\)/);
  assert.match(verifySource, /notifyPopupEntitlementStateUpdated\(\)/);
});

test("export entitlement verification falls back to local quota gates", () => {
  const contentSource = readText("../src/content.js");
  const localResultStart = contentSource.indexOf("function getLocalExportAccessResult");
  const verifyStart = contentSource.indexOf("async function syncVerifiedExportEntitlement");
  const verifyEnd = contentSource.indexOf("\n  async function recordSuccessfulExportUsage", verifyStart);
  const performStart = contentSource.indexOf("async function performExport()");
  const performEnd = contentSource.indexOf("\n  function cancelExport()", performStart);
  const batchStart = contentSource.indexOf("async function startInPageBatchExport()");
  const batchEnd = contentSource.indexOf("\n  function cancelInPageBatchExport()", batchStart);
  const verifySource = contentSource.slice(verifyStart, verifyEnd);
  const performSource = contentSource.slice(performStart, performEnd);
  const batchSource = contentSource.slice(batchStart, batchEnd);

  assert.notEqual(localResultStart, -1);
  assert.notEqual(verifyStart, -1);
  assert.notEqual(verifyEnd, -1);
  assert.notEqual(performStart, -1);
  assert.notEqual(performEnd, -1);
  assert.notEqual(batchStart, -1);
  assert.notEqual(batchEnd, -1);
  assert.match(verifySource, /const localAccess = getLocalExportAccessResult\(count\)/);
  assert.match(verifySource, /if \(!localAccess\.allowed \|\| isProUser\)/);
  assert.match(verifySource, /Server entitlement verification failed; using local quota fallback/);
  assert.match(verifySource, /return localAccess;/);
  assert.ok(performSource.indexOf("const localEntitlementPreflight = getLocalExportAccessResult(1)") < performSource.indexOf("renderExportProgress(formatForExport"));
  assert.ok(performSource.indexOf("const entitlementIssue = getEntitlementIssue") < performSource.indexOf("renderExportProgress(formatForExport"));
  assert.ok(performSource.indexOf("renderExportProgress(formatForExport") < performSource.indexOf("const entitlementPreflight = await verifySignedInExportAccess(1)"));
  assert.ok(batchSource.indexOf("if (!canUseBatchExportLocally())") < batchSource.indexOf("updateBatchExportProgress({"));
});

test("popup export closes before long-running page export work", () => {
  const popupSource = readText("../src/popup.js");
  const exportMessageIndex = popupSource.indexOf('type: "CHATVAULT_POPUP_EXPORT"');
  const closeImmediatelyIndex = popupSource.indexOf("closeImmediately: true", exportMessageIndex);
  const sendMessageStart = popupSource.indexOf("function sendMessageToActivePage(payload, options)");
  const sendMessageEnd = popupSource.indexOf("\n  // 从页面获取状态", sendMessageStart);
  const sendMessageSource = popupSource.slice(sendMessageStart, sendMessageEnd);

  assert.notEqual(exportMessageIndex, -1);
  assert.notEqual(closeImmediatelyIndex, -1);
  assert.notEqual(sendMessageStart, -1);
  assert.notEqual(sendMessageEnd, -1);
  assert.match(sendMessageSource, /options\.closeImmediately/);
  assert.match(sendMessageSource, /window\.close\(\)/);
});

test("checkout allows valid browser extension origins", () => {
  const httpSource = readText("../supabase/functions/_shared/http.ts");
  assert.match(httpSource, /function isAllowedChromeExtensionOrigin\(origin: string\)/);
  assert.match(httpSource, /url\.protocol === "chrome-extension:"/);
  assert.match(httpSource, /\^\[a-p\]\{32\}\$/);
  assert.match(httpSource, /isAllowedChromeExtensionOrigin\(origin\)/);

  const runtimeSource = httpSource
    .slice(
      httpSource.indexOf("const DEFAULT_ALLOWED_BROWSER_ORIGINS"),
      httpSource.indexOf("export function corsHeadersForRequest")
    )
    .replace("export function isAllowedBrowserOrigin(request: Request)", "function isAllowedBrowserOrigin(request)")
    .replace("function isAllowedChromeExtensionOrigin(origin: string)", "function isAllowedChromeExtensionOrigin(origin)");
  const loadHttpRuntime = new Function("Deno", runtimeSource + "; return { isAllowedBrowserOrigin };");
  const { isAllowedBrowserOrigin } = loadHttpRuntime({ env: { get() { return ""; } } });
  const requestWithOrigin = (origin) => ({
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "origin" ? origin : null;
      }
    }
  });

  assert.equal(isAllowedBrowserOrigin(requestWithOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")), true);
  assert.equal(isAllowedBrowserOrigin(requestWithOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")), true);
  assert.equal(isAllowedBrowserOrigin(requestWithOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/path")), false);
  assert.equal(isAllowedBrowserOrigin(requestWithOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaq")), false);
  assert.equal(isAllowedBrowserOrigin(requestWithOrigin("moz-extension://123e4567-e89b-12d3-a456-426614174000")), true);
  assert.equal(isAllowedBrowserOrigin(requestWithOrigin("safari-web-extension://123e4567-e89b-12d3-a456-426614174000")), true);
  assert.equal(isAllowedBrowserOrigin(requestWithOrigin("https://evil.example")), false);
});

test("product backend contract is present for local deployment and review", () => {
  const productFunctions = [
    "product-create-checkout-session",
    "product-payment-webhook",
    "product-sync-subscription-status",
    "product-verify-export-entitlement",
    "product-analytics-identify",
    "product-analytics-track"
  ];

  productFunctions.forEach((name) => {
    assert.equal(existsSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url)), true);
  });

  [
    "product-paddle.ts",
    "product-plans.ts",
    "product-supabase.ts"
  ].forEach((name) => {
    assert.equal(existsSync(new URL(`../supabase/functions/_shared/${name}`, import.meta.url)), true);
  });

  const migration = readText("../supabase/migrations/202607020001_product_export_isolation.sql");
  const checkout = readText("../supabase/functions/product-create-checkout-session/index.ts");
  const paddle = readText("../supabase/functions/_shared/product-paddle.ts");
  const plans = readText("../supabase/functions/_shared/product-plans.ts");
  const config = readText("../supabase/config.toml");

  assert.match(migration, /create table if not exists public\.product_profiles/);
  assert.match(migration, /create table if not exists public\.product_export_usage_daily/);
  assert.match(migration, /consume_product_export_usage_daily/);
  assert.match(paddle, /export class PaddleApiError extends Error/);
  assert.match(checkout, /isPaddleCustomerPermissionError/);
  assert.match(checkout, /PADDLE_REQUIRE_CUSTOMER_BINDING/);
  assert.match(checkout, /"Paddle checkout is temporarily unavailable\. Please try again later\."/);
  assert.match(plans, /"chatgpt-export"/);
  assert.match(plans, /"claude-export"/);
  assert.match(plans, /"gemini-export"/);
  assert.match(config, /\[functions\.product-create-checkout-session\]\s+verify_jwt = true/);
  assert.match(config, /\[functions\.product-payment-webhook\]\s+verify_jwt = false/);
  assert.match(config, /\[functions\.product-sync-subscription-status\]\s+verify_jwt = true/);
  assert.match(config, /\[functions\.product-verify-export-entitlement\]\s+verify_jwt = true/);
});
