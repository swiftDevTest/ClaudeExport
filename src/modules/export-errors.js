(function initChatVaultExportErrors() {
  "use strict";

  const CODES = Object.freeze({
    CANCELLED: "EXPORT_CANCELLED",
    CONTEXT_INVALIDATED: "EXTENSION_CONTEXT_INVALIDATED",
    ENGINE_UNAVAILABLE: "EXPORT_ENGINE_UNAVAILABLE",
    AUTH_REQUIRED: "AUTH_REQUIRED",
    AUTH_EXPIRED: "AUTH_SESSION_EXPIRED",
    ENTITLEMENT_DENIED: "ENTITLEMENT_DENIED",
    NETWORK: "NETWORK_ERROR",
    PLATFORM_UNAVAILABLE: "PLATFORM_UNAVAILABLE",
    PLATFORM_SCHEMA_CHANGED: "PLATFORM_SCHEMA_CHANGED",
    CONTENT_INCOMPLETE: "CONTENT_INCOMPLETE",
    MEDIA_LOAD_FAILED: "MEDIA_LOAD_FAILED",
    MEMORY_LIMIT: "MEMORY_LIMIT",
    IMAGE_CANVAS_LIMIT: "IMAGE_CANVAS_LIMIT",
    RENDER_FAILED: "RENDER_FAILED",
    SAVE_DENIED: "SAVE_DENIED",
    SAVE_CANCELLED: "SAVE_CANCELLED",
    TIMEOUT: "OPERATION_TIMEOUT",
    UNKNOWN: "UNKNOWN_ERROR"
  });

  const PHASES = Object.freeze({
    INITIALIZE: "initialize",
    AUTH: "auth",
    FETCH: "fetch",
    PARSE: "parse",
    MEDIA: "media",
    RENDER: "render",
    SAVE: "save",
    COMPLETE: "complete"
  });

  const KNOWN_CODES = new Set(Object.values(CODES));
  const KNOWN_PHASES = new Set(Object.values(PHASES));
  const CODE_ALIASES = Object.freeze({
    IMAGE_CANVAS_LIMIT_EXCEEDED: CODES.IMAGE_CANVAS_LIMIT,
    FULL_CONVERSATION_UNAVAILABLE: CODES.CONTENT_INCOMPLETE,
    CONVERSATION_COMPLETENESS_RISK: CODES.PLATFORM_SCHEMA_CHANGED,
    CHATGPT_CONVERSATION_NOT_FOUND: CODES.PLATFORM_UNAVAILABLE,
    CHATVAULT_AUTH_REQUIRED: CODES.AUTH_REQUIRED,
    CHATVAULT_LOGIN_FAILED: CODES.AUTH_REQUIRED,
    chatvault_reauthentication_required: CODES.AUTH_EXPIRED
  });

  const DEFAULTS = Object.freeze({
    [CODES.CANCELLED]: { phase: PHASES.COMPLETE, retryable: true },
    [CODES.CONTEXT_INVALIDATED]: { phase: PHASES.INITIALIZE, retryable: true },
    [CODES.ENGINE_UNAVAILABLE]: { phase: PHASES.INITIALIZE, retryable: true },
    [CODES.AUTH_REQUIRED]: { phase: PHASES.AUTH, retryable: true },
    [CODES.AUTH_EXPIRED]: { phase: PHASES.AUTH, retryable: true },
    [CODES.ENTITLEMENT_DENIED]: { phase: PHASES.AUTH, retryable: false },
    [CODES.NETWORK]: { phase: PHASES.FETCH, retryable: true },
    [CODES.PLATFORM_UNAVAILABLE]: { phase: PHASES.FETCH, retryable: true },
    [CODES.PLATFORM_SCHEMA_CHANGED]: { phase: PHASES.PARSE, retryable: true },
    [CODES.CONTENT_INCOMPLETE]: { phase: PHASES.PARSE, retryable: true },
    [CODES.MEDIA_LOAD_FAILED]: { phase: PHASES.MEDIA, retryable: true, fallbackFormat: "pdf" },
    [CODES.MEMORY_LIMIT]: { phase: PHASES.RENDER, retryable: true, fallbackFormat: "markdown" },
    [CODES.IMAGE_CANVAS_LIMIT]: { phase: PHASES.RENDER, retryable: true, fallbackFormat: "pdf" },
    [CODES.RENDER_FAILED]: { phase: PHASES.RENDER, retryable: true },
    [CODES.SAVE_DENIED]: { phase: PHASES.SAVE, retryable: true },
    [CODES.SAVE_CANCELLED]: { phase: PHASES.SAVE, retryable: true },
    [CODES.TIMEOUT]: { phase: PHASES.FETCH, retryable: true },
    [CODES.UNKNOWN]: { phase: PHASES.INITIALIZE, retryable: true }
  });

  function boundedText(value, maxLength) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(1, Number(maxLength) || 240));
  }

  function inferCode(error) {
    const rawCode = String(error?.error_code || error?.errorCode || error?.code || "");
    if (KNOWN_CODES.has(rawCode)) return rawCode;
    if (CODE_ALIASES[rawCode]) return CODE_ALIASES[rawCode];

    const name = String(error?.name || "");
    const message = boundedText(error?.message || error?.error || error, 1000);
    if (name === "AbortError" || /^(?:export|save|operation)?\s*cancel(?:led|ed)?\.?$/i.test(message)) {
      return /save/i.test(message) ? CODES.SAVE_CANCELLED : CODES.CANCELLED;
    }
    if (/context invalidated|extension context invalidated/i.test(message)) return CODES.CONTEXT_INVALIDATED;
    if (/export engine.*(?:missing|unavailable|failed to load)|shared export core is missing/i.test(message)) return CODES.ENGINE_UNAVAILABLE;
    if (/session.*expired|sign[- ]?in session.*expired|reauthentication/i.test(message)) return CODES.AUTH_EXPIRED;
    if (/sign in|required.*sign in|authentication required/i.test(message)) return CODES.AUTH_REQUIRED;
    if (/daily export limit|quota|entitlement.*(?:denied|not allowed)/i.test(message)) return CODES.ENTITLEMENT_DENIED;
    if (/completeness check|unknown content type|unknown types|page layout may have changed|schema changed/i.test(message)) return CODES.PLATFORM_SCHEMA_CHANGED;
    if (/complete conversation|conversation page did not expose every|partial file|content.*incomplete/i.test(message)) return CODES.CONTENT_INCOMPLETE;
    if (/history request failed|conversation.*not found|session is not available|open (?:chatgpt|claude|gemini) before/i.test(message)) return CODES.PLATFORM_UNAVAILABLE;
    if (/canvas limit|image.*too (?:large|long)|maximum canvas/i.test(message)) return CODES.IMAGE_CANVAS_LIMIT;
    if (/out of memory|memory limit|allocation.*fail|maximum call stack/i.test(message)) return CODES.MEMORY_LIMIT;
    if (/image.*(?:load|fetch).*fail|media.*fail|tainted canvas|cross-origin image/i.test(message)) return CODES.MEDIA_LOAD_FAILED;
    if (/save dialog|download.*(?:denied|not allowed|blocked|fail)|save.*not available/i.test(message)) return CODES.SAVE_DENIED;
    if (/timed out|timeout/i.test(message)) return CODES.TIMEOUT;
    if (/failed to fetch|networkerror|network request failed|load failed|\b(?:502|503|504)\b/i.test(message)) return CODES.NETWORK;
    if (/blob creation|render.*fail|document.*could not be built/i.test(message)) return CODES.RENDER_FAILED;
    return CODES.UNKNOWN;
  }

  function normalize(error, context) {
    const source = error && typeof error === "object" ? error : { message: String(error || "") };
    const code = inferCode(source);
    const defaults = DEFAULTS[code] || DEFAULTS[CODES.UNKNOWN];
    const requestedPhase = String(context?.phase || source.error_phase || source.phase || "");
    const phase = KNOWN_PHASES.has(requestedPhase) ? requestedPhase : defaults.phase;
    const requestedFallback = String(context?.fallbackFormat || source.fallback_format || source.fallbackFormat || "");
    const fallbackFormat = /^(?:pdf|markdown|word|html|txt|json|image)$/.test(requestedFallback)
      ? requestedFallback
      : defaults.fallbackFormat || "";
    return Object.freeze({
      code,
      originalCode: boundedText(source.code || source.error_code || source.errorCode, 80),
      phase,
      retryable: typeof context?.retryable === "boolean"
        ? context.retryable
        : typeof source.retryable === "boolean"
          ? source.retryable
          : defaults.retryable !== false,
      fallbackFormat,
      message: boundedText(source.message || source.error, 500),
      name: boundedText(source.name, 80) || "Error",
      format: boundedText(context?.format || source.format, 24),
      platform: boundedText(context?.platform || source.platform, 24)
    });
  }

  function apply(error, context) {
    const target = error instanceof Error ? error : new Error(String(error?.message || error || "Export failed."));
    const details = normalize(target, context);
    target.code = details.code;
    target.errorCode = details.code;
    target.phase = details.phase;
    target.retryable = details.retryable;
    if (details.fallbackFormat) target.fallbackFormat = details.fallbackFormat;
    return target;
  }

  function serialize(error, context) {
    const details = normalize(error, context);
    return {
      error_code: details.code,
      error_phase: details.phase,
      retryable: details.retryable,
      fallback_format: details.fallbackFormat || undefined
    };
  }

  globalThis.CHATVAULT_EXPORT_ERRORS = Object.freeze({
    CODES,
    PHASES,
    inferCode,
    normalize,
    apply,
    serialize
  });
})();
