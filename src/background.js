(function initChatVaultBackground() {
  "use strict";

  const ONBOARDING_STATE_KEY = "chatvault.exporter.onboarding.v1";
  const OPEN_SUBSCRIBE_PANEL_REQUEST_KEY = "chatvault_open_subscribe_panel_request";
  const SESSION_KEY = "chatvault_supabase_session";
  const ENTITLEMENT_STATE_CACHE_KEY = "chatvault_exporter_entitlement_state_v1";
  const MAX_IMAGE_FETCH_BYTES = 16 * 1024 * 1024;
  const SUPABASE_URL = "https://acgehhqcgreatcjcefub.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_GH05KXWPIo42YrorR0OGyQ_XdEWzY8Q";
  const SUPABASE_REFRESH_RESULT_TTL_MS = 30 * 1000;
  const supabaseRefreshPromises = new Map();
  const supabaseRefreshResults = new Map();
  const TRUSTED_CONTENT_HOSTS = new Set([
    "chatgpt.com",
    "chat.openai.com",
    "claude.ai",
    "gemini.google.com"
  ]);

  function isTrustedContentUrl(urlStr) {
    try {
      const url = new URL(String(urlStr || ""));
      return url.protocol === "https:" && TRUSTED_CONTENT_HOSTS.has(url.hostname.toLowerCase());
    } catch (error) {
      return false;
    }
  }

  function isTrustedExtensionUrl(urlStr) {
    try {
      const url = new URL(String(urlStr || ""));
      return url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id;
    } catch (error) {
      return false;
    }
  }

  function isTrustedSender(sender) {
    const senderUrl = sender?.url || sender?.tab?.url || "";
    if (!senderUrl && sender?.id === chrome.runtime.id) {
      return true;
    }
    return isTrustedContentUrl(senderUrl) || isTrustedExtensionUrl(senderUrl);
  }

  function rejectUntrustedSender(sender, sendResponse) {
    if (isTrustedSender(sender)) {
      return false;
    }
    sendResponse({ ok: false, error: "SecurityError: Untrusted message sender." });
    return true;
  }

  function sanitizeTokenLikeFields(value) {
    if (!value || typeof value !== "object") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(sanitizeTokenLikeFields);
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/(token|secret|password|credential)/i.test(key))
        .map(([key, fieldValue]) => [key, sanitizeTokenLikeFields(fieldValue)])
    );
  }

  function sanitizeSessionForStorage(session) {
    if (!session) {
      return session;
    }

    const { provider_token, provider_refresh_token, user, ...rest } = session;
    const minimalUser = user
      ? { id: user.id, email: user.email, user_metadata: sanitizeTokenLikeFields(user.user_metadata) }
      : null;

    return { ...rest, ...(minimalUser ? { user: minimalUser } : {}) };
  }

  function getTodayString() {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function normalizeProfileForCache(profile, session) {
    const source = profile && typeof profile === "object" ? profile : {};
    return {
      id: source.id || session?.user?.id || "",
      email: source.email || session?.user?.email || "",
      plan: source.plan === "pro" ? "pro" : "free",
      feature_flags: source.feature_flags && typeof source.feature_flags === "object" ? source.feature_flags : {},
      limits: source.limits && typeof source.limits === "object" ? source.limits : {},
      updated_at: source.updated_at || ""
    };
  }

  function normalizeUsageForCache(usage) {
    const source = usage && typeof usage === "object" ? usage : {};
    const usageDate = source.usage_date || source.date || getTodayString();
    return {
      date: usageDate,
      usage_date: usageDate,
      exportedChats: Math.max(0, Number(source.exportedChats || source.exported_chats || source.count || source.used || 0))
    };
  }

  async function saveEntitlementCache(session, profile, usage) {
    if (!session?.user?.id && !profile?.id && !session?.user?.email && !profile?.email) {
      return null;
    }

    const normalizedProfile = normalizeProfileForCache(profile, session);
    const snapshot = {
      cachedAt: Date.now(),
      profile: normalizedProfile,
      usage: normalizeUsageForCache(usage),
      sessionUser: session?.user ? {
        id: session.user.id || normalizedProfile.id,
        email: session.user.email || normalizedProfile.email,
        user_metadata: sanitizeTokenLikeFields(session.user.user_metadata || {})
      } : {
        id: normalizedProfile.id,
        email: normalizedProfile.email,
        user_metadata: {}
      }
    };

    await storageSet({ [ENTITLEMENT_STATE_CACHE_KEY]: snapshot });
    return snapshot;
  }

  function blobToDataUrl(blob) {
    if (typeof FileReader === "function") {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Failed to read image data."));
        reader.readAsDataURL(blob);
      });
    }

    if (typeof FileReaderSync === "function") {
      return Promise.resolve(new FileReaderSync().readAsDataURL(blob));
    }

    return blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.byteLength; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return "data:" + (blob.type || "application/octet-stream") + ";base64," + btoa(binary);
    });
  }

  function dataUrlPayload(dataUrl) {
    const commaIndex = String(dataUrl || "").indexOf(",");
    return commaIndex >= 0 ? String(dataUrl).slice(commaIndex + 1) : "";
  }

  async function refreshSupabaseSession(refreshToken) {
    const token = String(refreshToken || "");
    if (!token) {
      throw new Error("Missing refresh token.");
    }

    const cached = supabaseRefreshResults.get(token);
    if (cached && Date.now() - cached.createdAt <= SUPABASE_REFRESH_RESULT_TTL_MS) {
      return cached.result;
    }
    supabaseRefreshResults.delete(token);

    if (!supabaseRefreshPromises.has(token)) {
      const promise = (async () => {
        const response = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            Authorization: "Bearer " + SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ refresh_token: token })
        });

        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch (error) {
          payload = null;
        }

        if (!response.ok) {
          const message = payload?.message || text || "Supabase refresh failed: " + response.status;
          const requestError = new Error(message);
          requestError.status = response.status;
          requestError.code = payload?.code || null;
          throw requestError;
        }

        return payload;
      })();

      supabaseRefreshPromises.set(token, promise);
      promise
        .then(
          (result) => {
            supabaseRefreshResults.set(token, {
              createdAt: Date.now(),
              result
            });
          },
          () => {}
        )
        .finally(() => {
          supabaseRefreshPromises.delete(token);
          pruneSupabaseRefreshResults();
        });
    }

    return supabaseRefreshPromises.get(token);
  }

  async function exchangeGoogleIdTokenForSupabaseSession(idToken, accessToken, nonce) {
    const response = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=id_token", {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: "Bearer " + SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: "google",
        id_token: idToken,
        access_token: accessToken,
        nonce
      })
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.message || text || "Supabase sign-in failed: " + response.status;
      const requestError = new Error(message);
      requestError.status = response.status;
      requestError.code = payload?.code || null;
      throw requestError;
    }

    if (!payload?.access_token || !payload?.refresh_token) {
      throw new Error("Supabase sign-in did not return a complete session.");
    }

    const expiresIn = Number(payload.expires_in || 3600);
    let session = {
      ...payload,
      token_type: payload.token_type || "bearer",
      expires_in: Number.isFinite(expiresIn) ? expiresIn : 3600,
      expires_at: Number(payload.expires_at || Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 3600))
    };

    if (!session.user?.id) {
      session = {
        ...session,
        user: await fetchSupabaseUser(session.access_token)
      };
    }

    const storedSession = sanitizeSessionForStorage(session);
    await storageSet({ [SESSION_KEY]: storedSession });
    return storedSession;
  }

  async function fetchSupabaseUser(accessToken) {
    const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
      method: "GET",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json"
      }
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.message || text || "Supabase user fetch failed: " + response.status;
      const requestError = new Error(message);
      requestError.status = response.status;
      requestError.code = payload?.code || null;
      throw requestError;
    }

    return payload;
  }

  async function syncSubscriptionStatusForSession(session) {
    if (!session?.access_token) {
      return null;
    }

    const response = await fetch(SUPABASE_URL + "/functions/v1/sync-subscription-status", {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      }
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.message || text || "Subscription sync failed: " + response.status;
      const requestError = new Error(message);
      requestError.status = response.status;
      requestError.code = payload?.code || null;
      throw requestError;
    }

    const profile = payload?.profile || payload?.data?.profile || payload;
    await saveEntitlementCache(session, profile, payload?.usage || payload?.data?.usage || {});
    return payload;
  }

  function pruneSupabaseRefreshResults() {
    const now = Date.now();
    supabaseRefreshResults.forEach((value, key) => {
      if (!value || now - value.createdAt > SUPABASE_REFRESH_RESULT_TTL_MS) {
        supabaseRefreshResults.delete(key);
      }
    });
  }

  function sanitizeDownloadPathSegment(value) {
    return String(value || "")
      .replace(/[<>:"\\|?*\x00-\x1f]/g, "")
      .replace(/^\.+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function sanitizeDownloadFilename(value) {
    const parts = String(value || "Claude-Export")
      .replace(/\\/g, "/")
      .split("/")
      .map(sanitizeDownloadPathSegment)
      .filter(Boolean)
      .slice(-12);

    return parts.join("/") || "Claude-Export";
  }

  function isTrustedExportBlobUrl(value) {
    try {
      const outerUrl = new URL(String(value || ""));
      if (outerUrl.protocol !== "blob:") {
        return false;
      }

      const innerUrl = new URL(outerUrl.pathname);
      if (innerUrl.protocol === "chrome-extension:" && innerUrl.hostname === chrome.runtime.id) {
        return true;
      }

      return innerUrl.protocol === "https:" && TRUSTED_CONTENT_HOSTS.has(innerUrl.hostname.toLowerCase());
    } catch (error) {
      return false;
    }
  }

  function downloadItemToResponse(item, filename) {
    if (!item) {
      return { ok: true, state: "unknown", filename };
    }

    if (item.state === "complete") {
      return { ok: true, downloadId: item.id, filename: filename || item.filename, state: "complete" };
    }

    if (item.state === "interrupted") {
      const isCancelled = item.error === "USER_CANCELED";
      return {
        ok: false,
        downloadId: item.id,
        filename: filename || item.filename,
        state: "interrupted",
        cancelled: isCancelled,
        error: item.error || "Download interrupted"
      };
    }

    return {
      ok: true,
      downloadId: item.id,
      filename,
      state: item.state || "in_progress"
    };
  }

  function getDownloadStatus(downloadId, filename, callback) {
    chrome.downloads.search({ id: downloadId }, (results) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        callback({ ok: false, error: lastError.message || "Could not read download status." });
        return;
      }
      callback(downloadItemToResponse(results && results[0], filename));
    });
  }

  function createRandomHex(byteLength = 32) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(value) {
    const msgBuffer = new TextEncoder().encode(value);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function getIdentityRedirectUri() {
    if (chrome.identity && typeof chrome.identity.getRedirectURL === "function") {
      return chrome.identity.getRedirectURL();
    }

    return `https://${chrome.runtime.id}.chromiumapp.org/`;
  }

  function getOAuthParams(redirectUrl) {
    const urlObject = new URL(redirectUrl);
    const hashParams = new URLSearchParams(urlObject.hash ? urlObject.hash.substring(1) : "");
    const searchParams = urlObject.searchParams || new URLSearchParams();
    const params = new URLSearchParams(searchParams.toString());

    hashParams.forEach((value, key) => {
      params.set(key, value);
    });

    return params;
  }

  function getOAuthErrorMessage(params, fallbackMessage) {
    const description = params.get("error_description") || params.get("error") || fallbackMessage;
    return String(description || fallbackMessage || "Authorization failed.").replace(/\+/g, " ");
  }

  function openWelcomePage() {
    const welcomeUrl = chrome.runtime.getURL("welcome.html");

    if (chrome.tabs && typeof chrome.tabs.create === "function") {
      chrome.tabs.create({ url: welcomeUrl });
      return;
    }

    if (self.clients && typeof self.clients.openWindow === "function") {
      self.clients.openWindow(welcomeUrl);
    }
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(value, () => resolve());
      } catch (error) {
        resolve();
      }
    });
  }

  function openSubscribePopupFallback(source = "extension", planId = "yearly") {
    return new Promise((resolve) => {
      const params = new URLSearchParams({
        subscribe: "1",
        source: String(source || "extension"),
        plan: String(planId || "yearly")
      });
      const popupUrl = chrome.runtime.getURL(`src/popup.html?${params.toString()}`);
      if (chrome.windows && typeof chrome.windows.create === "function") {
        chrome.windows.create({
          url: popupUrl,
          type: "popup",
          width: 760,
          height: 920,
          focused: true
        }, () => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({ ok: true, opened: "popup_window" });
        });
        return;
      }

      if (chrome.tabs && typeof chrome.tabs.create === "function") {
        chrome.tabs.create({ url: popupUrl }, () => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({ ok: true, opened: "popup_tab" });
        });
        return;
      }

      resolve({ ok: false, error: "Unable to open subscribe panel." });
    });
  }

  async function openSubscribePanel(source = "extension", planId = "yearly") {
    await storageSet({
      [OPEN_SUBSCRIBE_PANEL_REQUEST_KEY]: {
        at: Date.now(),
        source,
        planId
      }
    });

    if (String(source || "").startsWith("extension_vip_modal")) {
      return openSubscribePopupFallback(source, planId);
    }

    if (chrome.action && typeof chrome.action.openPopup === "function") {
      try {
        await chrome.action.openPopup();
        return { ok: true, opened: "action_popup" };
      } catch (error) {
        console.warn("chrome.action.openPopup failed, using fallback window:", error);
      }
    }

    return openSubscribePopupFallback(source, planId);
  }

  function createContextMenus() {
    if (!chrome.contextMenus) {
      return;
    }

    chrome.contextMenus.removeAll(() => {
      const targetPatterns = [
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://claude.ai/*",
        "https://gemini.google.com/*"
      ];

      chrome.contextMenus.create({
        id: "chatvault_export_parent",
        title: chrome.i18n.getMessage("contextMenuExportParent") || "Claude Export",
        contexts: ["page"],
        documentUrlPatterns: targetPatterns
      }, () => {
        if (chrome.runtime.lastError) {}
      });

      const formats = [
        { id: "pdf", titleMsg: "contextMenuExportPdf", defaultTitle: "Export to PDF" },
        { id: "word", titleMsg: "contextMenuExportWord", defaultTitle: "Export to Word" },
        { id: "markdown", titleMsg: "contextMenuExportMarkdown", defaultTitle: "Export to Markdown" },
        { id: "image", titleMsg: "contextMenuExportImage", defaultTitle: "Export to Image" },
        { id: "txt", titleMsg: "contextMenuExportText", defaultTitle: "Export to Text" },
        { id: "json", titleMsg: "contextMenuExportJson", defaultTitle: "Export to JSON" }
      ];

      formats.forEach(item => {
        chrome.contextMenus.create({
          id: `chatvault_export_${item.id}`,
          parentId: "chatvault_export_parent",
          title: chrome.i18n.getMessage(item.titleMsg) || item.defaultTitle,
          contexts: ["page"],
          documentUrlPatterns: targetPatterns
        }, () => {
          if (chrome.runtime.lastError) {}
        });
      });
    });
  }

  chrome.runtime.onInstalled.addListener((details) => {
    createContextMenus();

    if (!details || details.reason !== "install") {
      return;
    }

    chrome.storage.local.set({
      [ONBOARDING_STATE_KEY]: {
        status: "not_started",
        installedAt: new Date().toISOString(),
        welcomeSeenAt: ""
      }
    }, openWelcomePage);
  });

  function sendContextExportMessage(tabId, format, allowRetry) {
    chrome.tabs.sendMessage(tabId, {
      type: "CHATVAULT_TRIGGER_EXPORT",
      format: format
    }, (response) => {
      const failed = Boolean(chrome.runtime.lastError) || !response || response.ok === false;
      if (failed && allowRetry) {
        sendContextExportMessage(tabId, format, false);
      }
    });
  }

  if (chrome.contextMenus) {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (tab && tab.id && info.menuItemId && info.menuItemId.startsWith("chatvault_export_")) {
        const format = info.menuItemId.replace("chatvault_export_", "");
        sendContextExportMessage(tab.id, format, true);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "CHATVAULT_OPEN_SUBSCRIBE") {
      if (rejectUntrustedSender(sender, sendResponse)) return false;
      (async () => {
        const result = await openSubscribePanel(message.source || "extension", message.planId || "yearly");
        sendResponse(result);
      })();
      return true;
    }

    if (message && message.type === "CHATVAULT_OPEN_EXPORT_H5") {
      if (rejectUntrustedSender(sender, sendResponse)) return false;
      const targetUrl = isTrustedExtensionUrl(message.url) ? message.url : chrome.runtime.getURL("welcome.html");
      chrome.tabs.create({ url: targetUrl });
      sendResponse({ ok: true });
      return true;
    }

    if (message && message.type === "CHATVAULT_START_GOOGLE_OAUTH") {
      if (rejectUntrustedSender(sender, sendResponse)) return false;
      (async () => {
        try {
          const identityRedirectUri = getIdentityRedirectUri();
          const clientId = String(message.clientId || "").trim();
          if (!clientId || clientId === "YOUR_GOOGLE_CLIENT_ID") {
            sendResponse({ ok: false, error: "Please configure googleClientId in supabase-config.js first." });
            return;
          }

          const rawNonce = createRandomHex(32);
          const hashedNonce = await sha256Hex(rawNonce);
          const redirectUri = encodeURIComponent(identityRedirectUri);
          const scope = encodeURIComponent("openid email profile");
          const responseType = encodeURIComponent("id_token token");
          const state = createRandomHex(16);
          const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&response_type=${responseType}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&nonce=${hashedNonce}`;

          chrome.identity.launchWebAuthFlow({
            url: authUrl,
            interactive: true
          }, async (redirectUrl) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              sendResponse({ ok: false, error: lastError.message });
              return;
            }

            if (!redirectUrl) {
              sendResponse({ ok: false, error: "Authorization failed: no redirect URL." });
              return;
            }

            try {
              const params = getOAuthParams(redirectUrl);
              if (params.has("error") || params.has("error_description")) {
                sendResponse({
                  ok: false,
                  error: `${getOAuthErrorMessage(params, "Authorization failed.")} Google client ID: ${clientId}. Redirect URI: ${identityRedirectUri}`
                });
                return;
              }

              const idToken = params.get("id_token");
              const accessToken = params.get("access_token");
              const returnedState = params.get("state");

              if (returnedState !== state) {
                sendResponse({ ok: false, error: "Google OAuth state validation failed." });
                return;
              }

              if (!idToken) {
                sendResponse({ ok: false, error: "Missing ID Token in Google response." });
                return;
              }

              const session = await exchangeGoogleIdTokenForSupabaseSession(idToken, accessToken, rawNonce);
              try {
                await syncSubscriptionStatusForSession(session);
              } catch (syncError) {
                console.warn("Failed to sync subscription status after sign-in:", syncError);
              }
              sendResponse({ ok: true, session, redirectUri: identityRedirectUri });
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();

      return true; // Keep message channel open for async response
    }

    if (message && message.type === "CHATVAULT_SUPABASE_REFRESH_SESSION") {
      if (rejectUntrustedSender(sender, sendResponse)) return false;

      refreshSupabaseSession(message.refreshToken)
        .then((session) => {
          sendResponse({ ok: true, session });
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error.message || "Supabase refresh failed.",
            status: error.status || 0,
            code: error.code || null
          });
        });

      return true;
    }

    if (message && message.type === "CHATVAULT_FETCH_IMAGE_BYTES") {
      if (rejectUntrustedSender(sender, sendResponse)) return false;
      const isTrustedImageOrigin = (urlStr) => {
        try {
          const url = new URL(urlStr);
          const hostname = url.hostname.toLowerCase();
          if (hostname === "chatgpt.com" || hostname === "chat.openai.com" || hostname === "claude.ai" || hostname === "gemini.google.com") {
            return true;
          }
          if (hostname.endsWith(".oaiusercontent.com") || hostname.endsWith(".googleusercontent.com")) {
            return true;
          }
          if (hostname === "images.anthropic.com" || hostname === "media.anthropic.com") {
            return true;
          }
          if (/^lh\d+\.google\.com$/.test(hostname)) {
            return true;
          }
        } catch (e) {
          return false;
        }
        return false;
      };
      const isTrustedCredentialedImageApi = (urlStr) => {
        try {
          const url = new URL(urlStr);
          const hostname = url.hostname.toLowerCase();
          const isInternalHost = hostname === "chatgpt.com" || hostname === "chat.openai.com" || hostname === "claude.ai";
          return isInternalHost && (url.pathname.includes("/api/") || url.pathname.includes("/backend-api/"));
        } catch (e) {
          return false;
        }
      };

      if (!isTrustedImageOrigin(message.url)) {
        sendResponse({
          ok: false,
          error: "SecurityError: Untrusted image origin: " + String(message.url || "").substring(0, 120)
        });
        return false;
      }

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;
      
      const fetchOpts = {
        method: "GET",
        referrerPolicy: "no-referrer",
        signal: controller ? controller.signal : undefined
      };
      
      if (isTrustedCredentialedImageApi(message.url)) {
        fetchOpts.credentials = "include";
      }

      fetch(message.url, fetchOpts)
        .then(response => {
          if (!response.ok) throw new Error("HTTP error " + response.status);
          const contentLength = Number(response.headers.get("content-length") || 0);
          if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_FETCH_BYTES) {
            throw new Error("Image is too large to export safely. Reduce images or export a shorter conversation.");
          }
          const mimeType = response.headers.get("content-type") || "image/png";
          return response.blob().then(blob => {
            return { mimeType, blob };
          });
        })
        .then(async res => {
          if (res.blob.size > MAX_IMAGE_FETCH_BYTES) {
            throw new Error("Image is too large to export safely. Reduce images or export a shorter conversation.");
          }
          const dataUrl = await blobToDataUrl(res.blob);
          sendResponse({ ok: true, base64: dataUrlPayload(dataUrl), mimeType: res.mimeType });
        })
        .catch(err => {
          sendResponse({
            ok: false,
            error: (err.name || "Error") + ": " + (err.message || "Failed to fetch image.")
          });
        })
        .finally(() => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        });
      return true; // Keep message channel open for async response
    }

    if (message && message.type === "CHATVAULT_GET_DOWNLOAD_STATUS") {
      if (rejectUntrustedSender(sender, sendResponse)) return false;
      getDownloadStatus(Number(message.downloadId), sanitizeDownloadFilename(message.filename), sendResponse);
      return true;
    }

    if (!message || message.type !== "CHATVAULT_SAVE_EXPORT") {
      return false;
    }
    if (rejectUntrustedSender(sender, sendResponse)) return false;

    const dataUrl = typeof message.dataUrl === "string" ? message.dataUrl : "";
    const blobUrl = typeof message.blobUrl === "string" ? message.blobUrl : "";
    const downloadUrl = dataUrl.startsWith("data:")
      ? dataUrl
      : isTrustedExportBlobUrl(blobUrl)
        ? blobUrl
        : "";
    const filename = sanitizeDownloadFilename(message.filename);
    const saveAs = message.saveAs !== false;

    if (!downloadUrl) {
      sendResponse({ ok: false, error: "Export data is not available." });
      return false;
    }

    chrome.downloads.download({
      url: downloadUrl,
      filename,
      saveAs,
      conflictAction: saveAs ? "prompt" : "uniquify"
    }, (downloadId) => {
      const lastError = chrome.runtime.lastError;

      if (lastError) {
        const messageText = lastError.message || "Download canceled.";
        sendResponse({
          ok: false,
          cancelled: /cancel/i.test(messageText) || /USER_CANCELED/i.test(messageText),
          error: messageText
        });
        return;
      }

      // Check if it already completed synchronously
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (results && results[0]) {
          const status = downloadItemToResponse(results[0], filename);
          if (status.state === "complete" || status.state === "interrupted") {
            sendResponse(status);
            return;
          }
        }

        // If still in progress, save the mapping to storage and respond back with in_progress
        if (sender && sender.tab && Number.isInteger(sender.tab.id)) {
          const mappingKey = `chatvault_download_mapping_${downloadId}`;
          chrome.storage.local.set({
            [mappingKey]: {
              tabId: sender.tab.id,
              filename: filename,
              createdAt: Date.now()
            }
          }, () => {
            sendResponse({ ok: true, downloadId, filename, state: "in_progress" });
          });
        } else {
          sendResponse({ ok: true, downloadId, filename, state: "in_progress" });
        }
      });
    });

    return true;
  });

  // Top-level downloads listener to survive Service Worker suspension
  if (chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      const state = delta.state?.current;
      if (state !== "complete" && state !== "interrupted") {
        return;
      }

      const downloadId = delta.id;
      const mappingKey = `chatvault_download_mapping_${downloadId}`;

      chrome.storage.local.get(mappingKey, (result) => {
        const mapping = result[mappingKey];
        if (!mapping) {
          return;
        }

        const tabId = mapping.tabId;
        const filename = mapping.filename;

        // Clean up mapping
        chrome.storage.local.remove(mappingKey);

        const isCancelled = state === "interrupted" && delta.error?.current === "USER_CANCELED";
        const errorMsg = state === "interrupted" ? (delta.error?.current || "Download interrupted") : null;

        // Notify the content script tab
        chrome.tabs.sendMessage(tabId, {
          type: "CHATVAULT_DOWNLOAD_STATUS",
          downloadId: downloadId,
          state: state,
          filename: filename,
          cancelled: isCancelled,
          error: errorMsg
        }, () => {
          // Ignore lastError if tab was closed
          const err = chrome.runtime.lastError;
        });
      });
    });
  }

  // Clean up stale download mappings on startup
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(null, (items) => {
      if (chrome.runtime.lastError) return;
      const now = Date.now();
      const keysToRemove = [];
      Object.keys(items || {}).forEach((key) => {
        if (key.startsWith("chatvault_download_mapping_")) {
          const mapping = items[key];
          if (mapping && now - (mapping.createdAt || 0) > 2 * 60 * 60 * 1000) {
            keysToRemove.push(key);
          }
        }
      });
      if (keysToRemove.length > 0) {
        chrome.storage.local.remove(keysToRemove);
      }
    });
  }

  self.addEventListener("install", () => {
    self.skipWaiting();
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
  });
})();
