const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey() {
  const configured = Deno.env.get("NOTION_TOKEN_ENCRYPTION_KEY") || "";
  if (configured.length < 32) {
    throw new Error("NOTION_TOKEN_ENCRYPTION_KEY must be a high-entropy value of at least 32 characters.");
  }
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(configured));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptNotionSecret(value: string) {
  if (!value) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), textEncoder.encode(value));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptNotionSecret(value: string | null | undefined) {
  if (!value) return "";
  const [version, encodedIv, encodedPayload] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedPayload) throw new Error("Unsupported Notion secret ciphertext.");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(encodedIv) },
    await encryptionKey(),
    base64UrlToBytes(encodedPayload)
  );
  return textDecoder.decode(decrypted);
}

export function randomOpaqueToken(byteLength = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isAllowedIdentityRedirect(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      /^[a-p]{32}\.chromiumapp\.org$/i.test(url.hostname) &&
      url.pathname === "/notion" &&
      !url.search && !url.hash;
  } catch (_error) {
    return false;
  }
}

// 按产品选择 Notion OAuth 凭证。
// ChatVault Exporter (ai-chat-export) 不配 _AI_CHAT_EXPORT 变量，fallback 到 NOTION_CLIENT_ID。
// 新产品各自配置 NOTION_CLIENT_ID_<PRODUCT> / NOTION_CLIENT_SECRET_<PRODUCT>。
export function notionOAuthBasicAuthorization(productSlug?: string) {
  // The untouched ChatVault Exporter must always use the original credentials,
  // even if an AI_CHAT_EXPORT-scoped secret is accidentally configured later.
  const slug = !productSlug || productSlug === "ai-chat-export"
    ? ""
    : productSlug.toUpperCase().replace(/-/g, "_");
  const clientId = (slug && Deno.env.get(`NOTION_CLIENT_ID_${slug}`) || "") || Deno.env.get("NOTION_CLIENT_ID") || "";
  const clientSecret = (slug && Deno.env.get(`NOTION_CLIENT_SECRET_${slug}`) || "") || Deno.env.get("NOTION_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) throw new Error("Notion OAuth client configuration is missing.");
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

// 按产品返回 Notion OAuth 回调 URL。
// ChatVault Exporter (ai-chat-export) 保持原路径 /notion-oauth，不影响线上行为。
// 新产品各自走独立的回调函数 /notion-oauth-<product>。
export function notionOAuthCallbackUri(productSlug?: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (!supabaseUrl) throw new Error("SUPABASE_URL is missing.");
  const base = `${supabaseUrl.replace(/\/$/, "")}/functions/v1`;
  if (!productSlug || productSlug === "ai-chat-export") {
    return `${base}/notion-oauth`;
  }
  // chatgpt-export → notion-oauth-chatgpt
  // claude-export → notion-oauth-claude
  // gemini-export → notion-oauth-gemini
  const suffix = productSlug.replace(/-export$/, "");
  return `${base}/notion-oauth-${suffix}`;
}

// 读取 Notion OAuth client_id（用于构造授权 URL 的 client_id 参数）。
// 与 notionOAuthBasicAuthorization 使用相同的凭证选择逻辑。
export function notionOAuthClientId(productSlug?: string) {
  const slug = !productSlug || productSlug === "ai-chat-export"
    ? ""
    : productSlug.toUpperCase().replace(/-/g, "_");
  return (slug && Deno.env.get(`NOTION_CLIENT_ID_${slug}`) || "") || Deno.env.get("NOTION_CLIENT_ID") || "";
}

export function safeNotionConnection(row: Record<string, unknown>) {
  return {
    id: String(row.id || ""),
    bot_id: String(row.bot_id || ""),
    workspace_id: String(row.workspace_id || ""),
    workspace_name: String(row.workspace_name || "Unknown Workspace"),
    workspace_icon: typeof row.workspace_icon === "string" ? row.workspace_icon : null,
    owner_user_id: typeof row.owner_user_id === "string" ? row.owner_user_id : null,
    status: String(row.status || "active"),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || "")
  };
}
