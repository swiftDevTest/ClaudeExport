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
  "https://gemini.google.com",
  "chrome-extension://cjkfchfnmbhcpmbhobdanongbjkcbagj"
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
    return url.protocol === "chrome-extension:" && /^[a-p]{32}$/.test(url.hostname);
  } catch (_error) {
    return false;
  }
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
