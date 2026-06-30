(function initChatVaultSupabaseApi() {
  const config = globalThis.CHATVAULT_SUPABASE_CONFIG;

  if (!config || !config.url || !config.publishableKey) {
    throw new Error("ChatVault Supabase config is missing.");
  }

  const baseUrl = config.url.replace(/\/$/, "");

  function createRequestError(response, errorText) {
    let payload = null;

    try {
      payload = JSON.parse(errorText);
    } catch (error) {
      payload = null;
    }

    const message = payload?.message || errorText || `Supabase request failed: ${response.status}`;
    const requestError = new Error(message);
    requestError.status = response.status;
    requestError.code = payload?.code || null;
    requestError.details = payload?.details || null;
    requestError.hint = payload?.hint || null;
    requestError.payload = payload;
    return requestError;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isRetryableRequestError(error) {
    if (!error) {
      return false;
    }

    if (error.name === "AbortError") {
      return true;
    }

    if (error.status) {
      return error.status >= 500 && error.status < 600;
    }

    return error instanceof TypeError || /network|fetch failed|failed to fetch|load failed|timeout/i.test(error.message || "");
  }

  async function request(path, options = {}) {
    const {
      accessToken,
      body,
      headers = {},
      method = "GET",
      retryCount,
      retryDelayMs = 250,
      timeoutMs = 15000
    } = options;

    const normalizedMethod = String(method || "GET").toUpperCase();
    const requestedRetries = Number(
      retryCount === undefined && /^(GET|HEAD)$/.test(normalizedMethod)
        ? 1
        : retryCount || 0
    );
    const maxAttempts = 1 + (Number.isFinite(requestedRetries) ? Math.max(0, requestedRetries) : 0);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = timeoutMs > 0 ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: normalizedMethod,
          signal: controller ? controller.signal : undefined,
          headers: {
            apikey: config.publishableKey,
            Authorization: `Bearer ${accessToken || config.publishableKey}`,
            "Content-Type": "application/json",
            ...headers
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw createRequestError(response, errorText);
        }

        if (response.status === 204) {
          return null;
        }

        return response.json();
      } catch (error) {
        const canRetry = attempt < maxAttempts - 1 && isRetryableRequestError(error);

        if (!canRetry) {
          throw error;
        }

        await wait(retryDelayMs);
      } finally {
        if (timer !== null) {
          clearTimeout(timer);
        }
      }
    }

    return null;
  }

  globalThis.CHATVAULT_SUPABASE_API = {
    config,
    request
  };
})();
