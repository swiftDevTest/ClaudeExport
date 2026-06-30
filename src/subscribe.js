(function initSubscribePage() {
  "use strict";

  const auth = globalThis.CHATVAULT_SUPABASE_AUTH;
  const billing = globalThis.CHATVAULT_BILLING;
  const checkoutIntentStorageKey = billing?.checkoutIntentStorageKey || "chatvault_pending_checkout_intent_v1";
  
  let currentSession = null;
  let checkoutInlineFlowActive = false;
  let checkoutResumeInFlight = false;

  function hasActiveAuthSession(session) {
    return !!(session && session.access_token);
  }

  function isBackendSchemaCacheError(error) {
    const message = String(error && error.message ? error.message : error || "");
    return /schema cache|payment_products|Could not find the table/i.test(message);
  }

  function getCheckoutErrorMessage(error) {
    if (isBackendSchemaCacheError(error)) {
      return "结账服务正在更新，请稍后重新打开 AI Chat Export 再试。";
    }
    return error && error.message ? error.message : "请稍后再试。";
  }

  function openCheckoutUrl(url) {
    return new Promise((resolve, reject) => {
      if (!url) {
        reject(new Error("无法构建结账页面，请稍后再试。"));
        return;
      }

      try {
        if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function") {
          chrome.tabs.create({ url }, () => {
            try {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message || "无法打开结账页面，请稍后再试。"));
                return;
              }
            } catch (error) {}
            resolve(true);
          });
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }

      try {
        const opened = window.open(url, "_blank");
        if (!opened) {
          reject(new Error("浏览器拦截了结账页面，请重试。"));
          return;
        }
        resolve(true);
      } catch (error) {
        reject(error);
      }
    });
  }

  function getChromeStorage() {
    try {
      return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (error) {
      return null;
    }
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      const storage = getChromeStorage();
      if (!storage) {
        resolve(null);
        return;
      }
      storage.get(key, (result) => {
        try {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
        } catch (error) {
          resolve(null);
          return;
        }
        resolve(result ? result[key] || null : null);
      });
    });
  }

  function storageSet(items) {
    return new Promise((resolve) => {
      const storage = getChromeStorage();
      if (!storage) {
        resolve(false);
        return;
      }
      storage.set(items, () => {
        resolve(true);
      });
    });
  }

  function storageRemove(key) {
    return new Promise((resolve) => {
      const storage = getChromeStorage();
      if (!storage) {
        resolve();
        return;
      }
      storage.remove(key, () => {
        resolve();
      });
    });
  }

  async function savePendingCheckoutIntent(planId, source) {
    if (!billing || typeof billing.createCheckoutIntent !== "function") {
      return;
    }
    await storageSet({ [checkoutIntentStorageKey]: billing.createCheckoutIntent(planId || "yearly", source || "subscribe_page") });
  }

  async function getPendingCheckoutIntent() {
    if (!billing || typeof billing.normalizeCheckoutIntent !== "function") {
      return null;
    }
    const intent = billing.normalizeCheckoutIntent(await storageGet(checkoutIntentStorageKey));
    if (!intent) {
      await storageRemove(checkoutIntentStorageKey);
    }
    return intent;
  }

  function clearPendingCheckoutIntent() {
    return storageRemove(checkoutIntentStorageKey);
  }

  async function checkUserSession() {
    try {
      if (auth) {
        currentSession = await auth.getSession({ skipUserRefresh: true });
        updateUserHeader();
      }
    } catch (e) {
      console.warn("Failed to get session:", e);
    }
  }

  function updateUserHeader() {
    const header = document.querySelector(".cv-header");
    if (!header) return;

    // Check if user status element already exists, if not create one
    let statusEl = document.getElementById("user-status-banner");
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.id = "user-status-banner";
      statusEl.style.marginTop = "10px";
      statusEl.style.fontSize = "13px";
      statusEl.style.padding = "6px 16px";
      statusEl.style.borderRadius = "99px";
      statusEl.style.background = "rgba(255,255,255,0.05)";
      statusEl.style.border = "1px solid rgba(255,255,255,0.08)";
      statusEl.style.display = "inline-flex";
      statusEl.style.alignItems = "center";
      statusEl.style.gap = "10px";
      header.appendChild(statusEl);
    }

    statusEl.replaceChildren();

    if (currentSession?.user) {
      const email = currentSession.user.email || "已登录用户";
      const label = document.createElement("span");
      label.style.color = "#9ca3af";
      label.append("已登录账号: ");
      const strong = document.createElement("strong");
      strong.style.color = "#fff";
      strong.textContent = email;
      label.appendChild(strong);

      const switchBtn = document.createElement("a");
      switchBtn.href = "#";
      switchBtn.id = "btn-switch-account";
      switchBtn.style.color = "#3b82f6";
      switchBtn.style.textDecoration = "none";
      switchBtn.style.fontWeight = "600";
      switchBtn.textContent = "切换账号";
      switchBtn.onclick = async (e) => {
        e.preventDefault();
        if (confirm("确定要退出当前账号并切换吗？")) {
          await auth.signOut();
          currentSession = null;
          updateUserHeader();
        }
      };

      statusEl.append(label, switchBtn);
    } else {
      const label = document.createElement("span");
      label.style.color = "#9ca3af";
      label.textContent = "尚未登录，订阅前请先";

      const loginBtn = document.createElement("button");
      loginBtn.id = "btn-login-now";
      loginBtn.style.background = "none";
      loginBtn.style.border = "none";
      loginBtn.style.color = "#10b981";
      loginBtn.style.cursor = "pointer";
      loginBtn.style.fontWeight = "700";
      loginBtn.style.padding = "0";
      loginBtn.style.fontSize = "13px";
      loginBtn.style.textDecoration = "underline";
      loginBtn.textContent = "登录账号";
      loginBtn.onclick = async () => {
        try {
          await auth.signInWithGoogle();
          await checkUserSession();
        } catch (error) {
          alert("登录失败：" + (error && error.message ? error.message : "请稍后再试。"));
        }
      };

      statusEl.append(label, loginBtn);
    }
  }

  async function ensureCheckoutSession(options = {}) {
    if (!auth || typeof auth.getSession !== "function") {
      throw new Error("登录服务暂时不可用，请刷新后再试。");
    }

    currentSession = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false }).catch(() => null);
    if (!hasActiveAuthSession(currentSession)) {
      if (options.planId) {
        checkoutInlineFlowActive = true;
        await savePendingCheckoutIntent(options.planId, options.source || "subscribe_page");
      }
      try {
        currentSession = await auth.signInWithGoogle();
      } catch (error) {
        if (options.planId) {
          await clearPendingCheckoutIntent();
        }
        throw error;
      }
      if (!hasActiveAuthSession(currentSession)) {
        currentSession = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false }).catch(() => null);
      }
    }

    if (!hasActiveAuthSession(currentSession)) {
      if (options.planId) {
        await clearPendingCheckoutIntent();
      }
      throw new Error("订阅前请先登录，以便自动绑定 Pro 权益。");
    }

    updateUserHeader();
    return currentSession;
  }

  async function handleCheckout(planId, buttonEl) {
    const originalText = buttonEl.textContent;
    buttonEl.disabled = true;
    buttonEl.textContent = "正在打开结账页面...";

    try {
      const source = "subscribe_page";
      const session = await ensureCheckoutSession({ planId, source });
      const email = session?.user?.email || "";
      const checkout = await billing.createCheckoutSession({
        accessToken: session.access_token,
        customerEmail: email,
        planId,
        source
      });
      const checkoutUrl = checkout?.checkoutUrl || "";

      if (checkoutUrl) {
        await openCheckoutUrl(checkoutUrl);
        await clearPendingCheckoutIntent();
      } else {
        alert("无法构建结账页面，请稍后再试。");
      }
    } catch (err) {
      console.error("Checkout error:", err);
      alert("结账时发生错误: " + getCheckoutErrorMessage(err));
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = originalText;
      checkoutInlineFlowActive = false;
    }
  }

  async function resumePendingCheckoutAfterAuth() {
    if (checkoutInlineFlowActive || checkoutResumeInFlight) {
      return;
    }
    const intent = await getPendingCheckoutIntent();
    if (!intent) {
      return;
    }
    if (!hasActiveAuthSession(currentSession)) {
      await checkUserSession();
    }
    if (!hasActiveAuthSession(currentSession)) {
      return;
    }

    checkoutResumeInFlight = true;
    try {
      const checkout = await billing.createCheckoutSession({
        accessToken: currentSession.access_token,
        customerEmail: currentSession?.user?.email || "",
        planId: intent.planId,
        source: intent.source || "subscribe_page"
      });
      if (checkout?.checkoutUrl) {
        await openCheckoutUrl(checkout.checkoutUrl);
        await clearPendingCheckoutIntent();
      }
    } catch (error) {
      console.warn("Pending checkout resume failed:", error);
    } finally {
      checkoutResumeInFlight = false;
    }
  }

  // Hook for Supabase OAuth redirect or login callback
  globalThis.CHATVAULT_REFRESH_AUTH_STATE = async () => {
    await checkUserSession();
    await resumePendingCheckoutAfterAuth();
  };

  document.addEventListener("DOMContentLoaded", async () => {
    await checkUserSession();
    await resumePendingCheckoutAfterAuth();

    // Bind subscribe buttons
    document.querySelectorAll(".cv-plan-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const planId = btn.getAttribute("data-plan-id");
        handleCheckout(planId, btn);
      });
    });

    // Handle policy link clicks (mock links or direct to standard terms)
    document.getElementById("link-terms").onclick = (e) => {
      e.preventDefault();
      alert("服务条款：AI Chat Export 仅用于个人日常提取和保存 AI 对话。严禁利用本工具抓取敏感、非法或侵犯版权的数据。");
    };

    document.getElementById("link-privacy").onclick = (e) => {
      e.preventDefault();
      alert("隐私政策：我们绝不收集、上传或在服务器存储您的任何聊天内容。所有分析、排版和文件生成完全发生在您的浏览器本地。");
    };
  });
})();
