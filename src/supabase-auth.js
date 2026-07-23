(function initChatVaultSupabaseAuth() {
  const api = globalThis.CHATVAULT_SUPABASE_API;
  const config = globalThis.CHATVAULT_SUPABASE_CONFIG;
  const productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
  const storageKey = typeof productConfig.storageKey === "function"
    ? productConfig.storageKey
    : (name) => `chatvault_exporter.${name}`;
  const SESSION_KEY = storageKey("supabase_session.v1");
  const ENTITLEMENT_STATE_CACHE_KEY = storageKey("entitlement_state.v1");
  const REFRESH_MARGIN_SECONDS = 300;
  let refreshSessionPromise = null;
  let refreshSessionPromiseToken = "";

  if (!api || !config) {
    throw new Error("ChatVault Supabase API is missing.");
  }

  function getChromeLocalStorage() {
    try {
      return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (error) {
      return null;
    }
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();

      if (!storage) {
        resolve(null);
        return;
      }

      try {
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

          resolve(result[key] || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();

      if (!storage) {
        resolve();
        return;
      }

      try {
        storage.set({ [key]: value }, resolve);
      } catch (error) {
        resolve();
      }
    });
  }

  function storageRemove(key) {
    return new Promise((resolve) => {
      const storage = getChromeLocalStorage();

      if (!storage) {
        resolve();
        return;
      }

      try {
        storage.remove(key, resolve);
      } catch (error) {
        resolve();
      }
    });
  }

  function getCleanRedirectUrl() {
    const url = new URL(window.location.href);
    url.hash = "";
    return url.toString();
  }

  function cleanAuthHash() {
    if (!window.location.hash) {
      return;
    }

    const params = new URLSearchParams(window.location.hash.slice(1));
    const hasAuthPayload = params.has("access_token") || params.has("error") || params.has("error_description");

    if (hasAuthPayload) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }

  function sessionFromHash() {
    if (!window.location.hash) {
      return null;
    }

    const params = new URLSearchParams(window.location.hash.slice(1));

    if (params.has("error") || params.has("error_description")) {
      const description = params.get("error_description") || params.get("error") || "Supabase login failed.";
      cleanAuthHash();
      throw new Error(description.replace(/\+/g, " "));
    }

    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (!accessToken || !refreshToken) {
      return null;
    }

    const expiresIn = Number(params.get("expires_in") || 3600);
    const expiresAt = Number(params.get("expires_at") || Math.floor(Date.now() / 1000) + expiresIn);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: params.get("token_type") || "bearer",
      expires_in: expiresIn,
      expires_at: expiresAt,
      provider_token: params.get("provider_token") || null,
      provider_refresh_token: params.get("provider_refresh_token") || null,
      user: null
    };
  }

  function decodeJwtPayload(token) {
    if (!token || typeof token !== "string") {
      return null;
    }

    const parts = token.split(".");
    if (parts.length < 2) {
      return null;
    }

    try {
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
      const binary = typeof atob === "function"
        ? atob(padded)
        : "";
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const decoded = typeof TextDecoder === "function"
        ? new TextDecoder("utf-8").decode(bytes)
        : decodeURIComponent(Array.from(bytes, (byte) => "%" + byte.toString(16).padStart(2, "0")).join(""));

      return decoded ? JSON.parse(decoded) : null;
    } catch (error) {
      return null;
    }
  }

  // Define getJwtExpiresAt for compatibility
  function getJwtExpiresAt(token) {
    const payload = decodeJwtPayload(token);
    const exp = Number(payload?.exp || 0);
    return Number.isFinite(exp) && exp > 0 ? exp : 0;
  }

  function getSessionExpiresAt(session) {
    const jwtExpiresAt = getJwtExpiresAt(session?.access_token);
    const storedExpiresAt = Number(session?.expires_at || 0);

    if (jwtExpiresAt > 0) {
      return jwtExpiresAt;
    }

    return Number.isFinite(storedExpiresAt) ? storedExpiresAt : 0;
  }

  function isSessionFresh(session, minTtlSeconds = REFRESH_MARGIN_SECONDS) {
    if (!session || !session.access_token) {
      return false;
    }

    const expiresAt = getSessionExpiresAt(session);

    if (!expiresAt) {
      return true;
    }

    return expiresAt - Math.floor(Date.now() / 1000) > minTtlSeconds;
  }

  function normalizeSession(baseSession, updates = {}) {
    const expiresIn = Number(updates.expires_in || baseSession?.expires_in || 3600);
    const accessToken = updates.access_token || baseSession?.access_token || "";
    const expiresAt = Number(updates.expires_at || getJwtExpiresAt(accessToken) || Math.floor(Date.now() / 1000) + expiresIn);

    return {
      ...baseSession,
      ...updates,
      access_token: accessToken,
      refresh_token: updates.refresh_token || baseSession?.refresh_token || "",
      token_type: updates.token_type || baseSession?.token_type || "bearer",
      expires_in: Number.isFinite(expiresIn) ? expiresIn : 3600,
      expires_at: Number.isFinite(expiresAt) ? expiresAt : Math.floor(Date.now() / 1000) + 3600,
      user: updates.user || baseSession?.user || null
    };
  }

  function isLikelyAuthError(error) {
    const message = String(error?.message || error || "");
    const code = String(error?.code || error?.payload?.code || "");

    return error?.status === 401 ||
      error?.status === 403 ||
      code === "PGRST303" ||
      /jwt|token|session/i.test(message) && /expired|invalid|missing|refresh|revoked/i.test(message);
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

  async function storeSession(session) {
    await storageSet(SESSION_KEY, sanitizeSessionForStorage(session));
    return session;
  }

  async function getStoredSession() {
    return storageGet(SESSION_KEY);
  }

  async function clearSession() {
    await storageRemove(SESSION_KEY);
  }

  function refreshSessionThroughBackground(refreshToken) {
    return new Promise((resolve, reject) => {
      try {
        if (
          typeof chrome === "undefined" ||
          !chrome.runtime ||
          typeof chrome.runtime.sendMessage !== "function"
        ) {
          resolve(null);
          return;
        }

        chrome.runtime.sendMessage({
          type: "CHATVAULT_SUPABASE_REFRESH_SESSION",
          refreshToken
        }, (reply) => {
          let lastError = null;
          try {
            lastError = chrome.runtime.lastError;
          } catch (error) {
            lastError = null;
          }

          if (lastError) {
            reject(new Error(lastError.message || "Supabase refresh service is unavailable."));
            return;
          }

          if (!reply) {
            reject(new Error("Supabase refresh service returned an empty response."));
            return;
          }

          if (!reply.ok) {
            const requestError = new Error(reply.error || "Supabase refresh failed.");
            requestError.status = reply.status || 0;
            requestError.code = reply.code || null;
            reject(requestError);
            return;
          }

          resolve(reply.session || null);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function refreshSession(session, options = {}) {
    if (!session || !session.refresh_token) {
      return null;
    }

    const minTtlSeconds = Number.isFinite(Number(options.minTtlSeconds))
      ? Number(options.minTtlSeconds)
      : REFRESH_MARGIN_SECONDS;

    if (!options.forceRefresh && isSessionFresh(session, minTtlSeconds)) {
      return session;
    }

    const refreshToken = session.refresh_token;
    if (!refreshSessionPromise || refreshSessionPromiseToken !== refreshToken) {
      refreshSessionPromiseToken = refreshToken;
      refreshSessionPromise = (async () => {
        const refreshed = await refreshSessionThroughBackground(refreshToken)
          || await api.request("/auth/v1/token?grant_type=refresh_token", {
            body: {
              refresh_token: refreshToken
            },
            method: "POST"
          });

        return storeSession(normalizeSession(session, refreshed));
      })().finally(() => {
        if (refreshSessionPromiseToken === refreshToken) {
          refreshSessionPromise = null;
          refreshSessionPromiseToken = "";
        }
      });
    }

    return refreshSessionPromise;
  }

  async function getUser(accessToken) {
    return api.request("/auth/v1/user", {
      accessToken
    });
  }

  async function getSession(options = {}) {
    // SECURITY: Do not implicitly read session from window.location.hash.
    // The OAuth flow uses chrome.identity.launchWebAuthFlow (handled in background.js)
    // which stores the session directly. Reading tokens from the hash without state
    // validation enables session fixation attacks (C1).
    cleanAuthHash();

    let session = await getStoredSession();

    if (!session) {
      return null;
    }

    const originalSession = session;
    const canReturnStoredSession = () => {
      return options.allowStaleOnError !== false && originalSession?.access_token && originalSession?.user?.id;
    };

    try {
      session = await refreshSession(session, {
        forceRefresh: Boolean(options.forceRefresh),
        minTtlSeconds: options.minTtlSeconds
      });

      if (!session) {
        if (canReturnStoredSession()) {
          return originalSession;
        }
        return null;
      }

      if (options.skipUserRefresh && session.user?.id) {
        await storeSession(session);
        return session;
      }

      try {
        const user = session.user?.id && !options.refreshUser ? session.user : await getUser(session.access_token);
        const sessionWithUser = {
          ...session,
          user
        };
        await storeSession(sessionWithUser);
        return sessionWithUser;
      } catch (userError) {
        if (!isLikelyAuthError(userError)) {
          throw userError;
        }

        const refreshedSession = await refreshSession(session, {
          forceRefresh: true,
          minTtlSeconds: 0
        });
        const user = await getUser(refreshedSession.access_token);
        const sessionWithUser = {
          ...refreshedSession,
          user
        };
        await storeSession(sessionWithUser);
        return sessionWithUser;
      }
    } catch (error) {
      const storedSession = await getStoredSession();

      // Only return stale session on transient network errors, not auth errors.
      // If refresh_token is revoked/expired (auth error), returning stale gives a
      // false "logged in" state while all API calls fail with 401 (H8).
      const isAuthError = isLikelyAuthError(error);
      const staleAllowed = options.allowStaleOnError !== false && !isAuthError;
      if (staleAllowed && storedSession?.access_token && storedSession?.user?.id) {
        return storedSession;
      }

      throw error;
    }
  }

  async function signInWithIdToken(idToken, accessToken, nonce) {
    try {
      const refreshed = await api.request("/auth/v1/token?grant_type=id_token", {
        body: {
          provider: "google",
          id_token: idToken,
          access_token: accessToken,
          nonce: nonce
        },
        method: "POST"
      });

      const session = normalizeSession(null, refreshed);
      await storeSession(session);
      return session;
    } catch (error) {
      throw error;
    }
  }

  function signInWithGoogle() {
    const setAuthLoading = (isLoading, message) => {
      try {
        globalThis.CHATVAULT_SET_AUTH_LOADING?.(isLoading, message);
      } catch (error) {
        // Loading UI is best-effort only.
      }
    };

    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      setAuthLoading(false);
      return Promise.reject(new Error("Google Sign-In requires the ChatVault extension background service."));
    }

    if (!config.googleClientId || config.googleClientId === "YOUR_GOOGLE_CLIENT_ID") {
      setAuthLoading(false);
      return Promise.reject(new Error("Please configure googleClientId in src/supabase-config.js first."));
    }

    return new Promise((resolve, reject) => {
      setAuthLoading(true, "Opening Google Sign-In...");
      chrome.runtime.sendMessage({
        type: "CHATVAULT_START_GOOGLE_OAUTH",
        clientId: config.googleClientId
      }, async (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          setAuthLoading(false);
          reject(new Error(lastError.message || "Failed to initiate Google Login."));
          return;
        }

        if (!response || !response.ok) {
          setAuthLoading(false);
          const message = response?.error || "Google Login failed.";
          if (/user canceled|user cancelled|did not approve|closed/i.test(message)) {
            resolve(null);
          } else {
            reject(new Error(message));
          }
          return;
        }

        try {
          setAuthLoading(true, "Signing In To ChatVault...");
          let session = response.session
            ? await storeSession(normalizeSession(null, response.session))
            : await signInWithIdToken(response.idToken, response.accessToken, response.nonce);
          if (response.session) {
            try {
              session = await getSession({ skipUserRefresh: false, allowStaleOnError: true }) || session;
            } catch (error) {
              // Background has already stored the session; user data can refresh on the next popup open.
            }
          }
          setAuthLoading(false);
          if (globalThis.CHATVAULT_REFRESH_AUTH_STATE) {
            await globalThis.CHATVAULT_REFRESH_AUTH_STATE({ showSuccess: true });
          } else {
            window.location.reload();
          }
          resolve(session);
        } catch (err) {
          setAuthLoading(false);
          reject(err instanceof Error ? err : new Error(String(err || "Authentication failed.")));
        }
      });
    }).catch((error) => {
      setAuthLoading(false);
      throw error;
    });
  }

  async function signOut() {
    const session = await getStoredSession();

    if (session && session.access_token) {
      try {
        await api.request("/auth/v1/logout", {
          accessToken: session.access_token,
          method: "POST"
        });
      } catch (error) {
        // Local logout should still succeed if the network request fails.
      }
    }

    await clearSession();
    await storageRemove(ENTITLEMENT_STATE_CACHE_KEY);
    try {
      await globalThis.CHATVAULT_ENTITLEMENTS?.clearCachedState?.();
    } catch (error) {
      // Entitlement cache cleanup is best-effort; local auth state is already cleared.
    }

    // Clean up all user-scoped cached state to prevent cross-account leakage (H9).
    const cleanupKeys = [
      storageKey("pending_checkout_intent.v1"),
      storageKey("recent_checkout_session.v1"),
      storageKey("open_subscribe_panel_request.v1"),
      storageKey("analytics.identify_done.v1"),
      "notion_token",
      "notion_db_id",
      "notion_selected_connection_id",
      "notion_selected_data_sources",
      "chatvault_notion_ui_cache_v1"
    ];
    try {
      await storageRemove(cleanupKeys);
    } catch (error) {
      // Best-effort cleanup; storage may already be empty.
    }
  }

  globalThis.CHATVAULT_SUPABASE_AUTH = {
    clearSession,
    getCleanRedirectUrl,
    getStoredSession,
    getSession,
    isLikelyAuthError,
    refreshSession,
    signInWithGoogle,
    signOut,
    _test: {
      decodeJwtPayload
    }
  };
})();
