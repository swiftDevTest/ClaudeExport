(function initSubscribePage() {
  "use strict";

  const auth = globalThis.CHATVAULT_SUPABASE_AUTH;
  const billing = globalThis.CHATVAULT_BILLING;
  const productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  const productName = productConfig.productName || "Claude Export";
  const isolatedMembership = productConfig.isolatedMembership === true;
  const checkoutIntentStorageKey = billing?.checkoutIntentStorageKey || "chatvault_pending_checkout_intent_v1";
  
  let currentSession = null;
  let checkoutLoading = false;

  function applyProductTheme(target) {
    if (productConfig && typeof productConfig.applyThemeVars === "function") {
      productConfig.applyThemeVars(target || document.documentElement);
    }
  }

  function hasActiveAuthSession(session) {
    return !!(session && session.access_token);
  }

  function isBackendSchemaCacheError(error) {
    const message = String(error && error.message ? error.message : error || "");
    return /schema cache|payment_products|Could not find the table/i.test(message);
  }

  function getCheckoutErrorMessage(error) {
    if (isBackendSchemaCacheError(error)) {
      return `结账服务正在更新，请稍后重新打开 ${productName} 再试。`;
    }
    return error && error.message ? error.message : "请稍后再试。";
  }

  function openCheckoutTabViaBackground(url) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
        resolve(false);
        return;
      }
      try {
        chrome.runtime.sendMessage({
          type: "CHATVAULT_OPEN_CHECKOUT_TAB",
          url
        }, (response) => {
          if (chrome.runtime.lastError || !response || !response.ok) {
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  function openCheckoutTabDirect(url, resolve, reject) {
    try {
      if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function") {
        chrome.tabs.create({ url, active: true }, () => {
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
        reject(new Error("浏览器拦截了结账页面，请允许弹窗后重试。"));
        return;
      }
      resolve(true);
    } catch (error) {
      reject(error);
    }
  }

  function openCheckoutTab(url) {
    return new Promise(async (resolve, reject) => {
      if (!url) {
        reject(new Error("无法构建结账页面，请稍后再试。"));
        return;
      }

      // Prefer background script path: validates URL and is robust after async
      // sign-in flows where the original user gesture context is lost.
      const opened = await openCheckoutTabViaBackground(url);
      if (opened) {
        resolve(true);
        return;
      }

      // Fallback: direct chrome.tabs.create (works from extension pages)
      openCheckoutTabDirect(url, resolve, reject);
    });
  }

  function getChromeStorage() {
    try {
      return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (error) {
      return null;
    }
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
      switchBtn.style.color = "var(--cv-primary)";
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
      loginBtn.style.color = "var(--cv-primary)";
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
    let signedInOnly = false;
    if (!hasActiveAuthSession(currentSession)) {
      try {
        currentSession = await auth.signInWithGoogle();
      } catch (error) {
        throw error;
      }
      if (!hasActiveAuthSession(currentSession)) {
        currentSession = await auth.getSession({ skipUserRefresh: false, allowStaleOnError: false }).catch(() => null);
      }
      signedInOnly = hasActiveAuthSession(currentSession);
    }

    if (!hasActiveAuthSession(currentSession)) {
      throw new Error("订阅前请先登录，以便自动绑定 Pro 权益。");
    }

    await clearPendingCheckoutIntent();
    updateUserHeader();
    return {
      session: currentSession,
      signedInOnly
    };
  }

  async function handleCheckout(planId, buttonEl) {
    // Debounce: ignore clicks while a checkout is already in progress. This
    // prevents state from getting stuck if a previous click is still awaiting
    // session refresh or the checkout network request, which is the main cause
    // of "clicking the pay button has no response" for already-signed-in users.
    if (checkoutLoading) {
      return;
    }

    checkoutLoading = true;
    const originalText = buttonEl.textContent;
    buttonEl.disabled = true;
    buttonEl.textContent = "正在打开结账页面...";

    try {
      const source = "subscribe_page";
      const checkoutSession = await ensureCheckoutSession({ planId, source });
      if (checkoutSession.signedInOnly) {
        alert("登录成功。请再次点击当前订阅按钮打开结账页面。");
        return;
      }
      const session = checkoutSession.session;
      const email = session?.user?.email || "";
      const checkout = await billing.createCheckoutSession({
        accessToken: session.access_token,
        customerEmail: email,
        planId,
        source
      });
      const checkoutUrl = checkout?.checkoutUrl || "";

      if (checkoutUrl) {
        await openCheckoutTab(checkoutUrl);
        await clearPendingCheckoutIntent();
      } else {
        alert("无法构建结账页面，请稍后再试。");
      }
    } catch (err) {
      console.error("Checkout error:", err);
      alert("结账时发生错误: " + getCheckoutErrorMessage(err));
    } finally {
      checkoutLoading = false;
      buttonEl.disabled = false;
      buttonEl.textContent = originalText;
    }
  }

  function applyProductCopy() {
    applyProductTheme(document.documentElement);
    document.title = `升级至 ${productName} Pro`;
    document.querySelectorAll(".cv-brand span").forEach((element) => {
      element.textContent = productName;
    });
    const title = document.querySelector(".cv-title");
    if (title) {
      title.textContent = `升级至 ${productName} Pro`;
    }
    document.querySelectorAll(".cv-feature-text h3").forEach((heading) => {
      if (/隐藏 .*水印/.test(heading.textContent || "")) {
        heading.textContent = `隐藏 ${productName} 水印`;
      }
    });
    document.querySelectorAll(".cv-feature-text p").forEach((paragraph) => {
      paragraph.textContent = (paragraph.textContent || "")
        .replace(/Claude Export/g, productName);
    });
    if (isolatedMembership) {
      document.querySelectorAll(".cv-feature-item.text-highlight").forEach((element) => {
        element.remove();
      });
      document.querySelectorAll(".cv-faq-item").forEach((item) => {
        const text = item.textContent || "";
        if (/互通 Pro|主管理器/.test(text)) {
          item.remove();
        }
      });
      const subtitle = document.querySelector(".cv-subtitle");
      if (subtitle) {
        subtitle.textContent = "解除额度限制，解锁出版级排版主题、本地导出凭证和独立 Pro 会员权益。";
      }
    }
  }

  // Hook for Supabase OAuth redirect or login callback
  globalThis.CHATVAULT_REFRESH_AUTH_STATE = async () => {
    await checkUserSession();
    await clearPendingCheckoutIntent();
  };

  document.addEventListener("DOMContentLoaded", async () => {
    applyProductCopy();
    await checkUserSession();
    await clearPendingCheckoutIntent();

    // 监听 storage 变化，在其他页面（如 popup）登出时同步状态
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if ("chatvault_supabase_session" in changes) {
          checkUserSession();
        }
      });
    }

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
      alert(`服务条款：${productName} 仅用于个人日常提取和保存 AI 对话。严禁利用本工具抓取敏感、非法或侵犯版权的数据。`);
    };

    document.getElementById("link-privacy").onclick = (e) => {
      e.preventDefault();
      alert("隐私政策：我们绝不收集、上传或在服务器存储您的任何聊天内容。所有分析、排版和文件生成完全发生在您的浏览器本地。");
    };
  });
})();
