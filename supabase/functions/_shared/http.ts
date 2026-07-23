export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-chatvault-client, x-client-info, apikey, content-type, paddle-signature",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
};

const DEFAULT_ALLOWED_BROWSER_ORIGINS = [
  "https://tabpilotpro.com",
  "https://www.tabpilotpro.com",
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://claude.ai",
  "https://gemini.google.com"
  // 注意：chrome-extension / moz-extension / safari-web-extension 协议 origin 不在此处放行，
  // 统一由 isAllowedChromeExtensionOrigin 处理，避免本表与扩展 ID 白名单行为不一致。
];

function getConfiguredAllowedOrigins() {
  const configured = Deno.env.get("CHATVAULT_ALLOWED_ORIGINS") || "";
  return (configured ? configured.split(",") : DEFAULT_ALLOWED_BROWSER_ORIGINS)
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isAllowedChromeExtensionOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (url.protocol === "chrome-extension:") {
      // 仅允许在配置白名单中的扩展 ID，不再接受任意 32 字符 ID。
      // 通过 CHATVAULT_ALLOWED_EXTENSION_IDS 环境变量配置（逗号分隔）。
      const allowed = (Deno.env.get("CHATVAULT_ALLOWED_EXTENSION_IDS") || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (allowed.length === 0) {
        // 未配置白名单时仅允许本仓库已知的扩展 ID（chatgpt-export）
        return url.hostname === "cjkfchfnmbhcpmbhobdanongbjkcbagj" && (url.pathname === "" || url.pathname === "/");
      }
      return allowed.includes(url.hostname) && (url.pathname === "" || url.pathname === "/");
    }
    // Firefox & Safari 扩展：同样要求显式配置白名单（环境变量值为 UUID）
    if (/^(moz|safari-web)-extension:\/\//i.test(origin)) {
      const allowed = (Deno.env.get("CHATVAULT_ALLOWED_EXTENSION_IDS") || "")
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean);
      if (allowed.length === 0) {
        return false;
      }
      return allowed.includes(origin.toLowerCase().replace(/\/$/, ""));
    }
  } catch (_error) {
    return false;
  }
  return false;
}

export function isAllowedBrowserOrigin(request: Request) {
  const origin = request.headers.get("origin") || "";
  if (!origin) {
    return false;
  }

  const allowedOrigins = getConfiguredAllowedOrigins();
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (isAllowedChromeExtensionOrigin(origin)) {
    return true;
  }

  return false;
}

export function corsHeadersForRequest(request: Request) {
  const origin = request.headers.get("origin") || "";
  const headers: Record<string, string> = {
    ...corsHeaders,
    "Vary": "Origin"
  };

  if (origin && isAllowedBrowserOrigin(request)) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else {
    delete headers["Access-Control-Allow-Origin"];
  }

  return headers;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

export function emptyResponse(status = 204) {
  return new Response(null, {
    status,
    headers: corsHeaders
  });
}

export function errorResponse(message: string, status = 400, details?: unknown) {
  return jsonResponse({
    ok: false,
    message,
    ...(details === undefined ? {} : { details })
  }, status);
}

export function jsonResponseForRequest(request: Request, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeadersForRequest(request),
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

export function emptyResponseForRequest(request: Request, status = 204) {
  return new Response(null, {
    status,
    headers: corsHeadersForRequest(request)
  });
}

export function errorResponseForRequest(request: Request, message: string, status = 400, details?: unknown) {
  return jsonResponseForRequest(request, {
    ok: false,
    message,
    ...(details === undefined ? {} : { details })
  }, status);
}

export async function readJsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return await request.json();
  } catch (_error) {
    return {} as T;
  }
}
