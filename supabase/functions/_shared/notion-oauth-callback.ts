import { supabaseRest } from "./supabase.ts";
import {
  encryptNotionSecret,
  isAllowedIdentityRedirect,
  notionOAuthBasicAuthorization,
  notionOAuthCallbackUri,
  randomOpaqueToken,
  sha256Hex
} from "./notion-secrets.ts";

type StateRow = {
  chatvault_user_id: string;
  final_redirect_uri: string;
  flow_challenge_hash: string;
  product_slug: string;
};

function safeHtml(message: string) {
  const escaped = message.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] || character);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Notion OAuth</title></head><body><p>${escaped}</p></body></html>`;
}

function htmlResponse(message: string, status: number) {
  return new Response(safeHtml(message), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

// 共享的 Notion OAuth 回调处理逻辑。
// productSlug 由调用方（notion-oauth-chatgpt / notion-oauth-claude / notion-oauth-gemini）硬编码传入。
// ChatVault Exporter 的 notion-oauth 回调不在本文件中，保持原样不动。
export async function handleOAuthCallback(request: Request, productSlug: string) {
  if (request.method !== "GET") return htmlResponse("Method not allowed.", 405);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  if (!state) return htmlResponse("Authorization state is missing or expired.", 400);

  let stateRow: StateRow | null = null;
  try {
    const stateHash = await sha256Hex(state);
    const consumed = await supabaseRest<StateRow[]>("rpc/consume_notion_oauth_state", {
      method: "POST",
      body: { p_state_hash: stateHash }
    });
    stateRow = consumed && consumed[0] || null;
    if (!stateRow) return htmlResponse("Authorization state is invalid, expired, or already used.", 400);
    if (!isAllowedIdentityRedirect(stateRow.final_redirect_uri)) {
      return htmlResponse("Authorization redirect URI is untrusted.", 400);
    }

    const providerError = url.searchParams.get("error");
    if (providerError) {
      const redirect = new URL(stateRow.final_redirect_uri);
      redirect.searchParams.set("error", providerError === "access_denied" ? "access_denied" : "oauth_failed");
      return Response.redirect(redirect.toString(), 302);
    }

    const code = url.searchParams.get("code") || "";
    if (!code) return htmlResponse("Authorization code is missing.", 400);
    const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: notionOAuthBasicAuthorization(productSlug),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: notionOAuthCallbackUri(productSlug)
      })
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token || !tokenData.bot_id || !tokenData.workspace_id) {
      return htmlResponse("Notion authorization could not be completed. Please try again.", 502);
    }

    const accessCiphertext = await encryptNotionSecret(String(tokenData.access_token));
    const refreshCiphertext = tokenData.refresh_token
      ? await encryptNotionSecret(String(tokenData.refresh_token))
      : null;
    const ownerUserId = tokenData.owner && tokenData.owner.user && tokenData.owner.user.id || null;
    const connections = await supabaseRest<Record<string, unknown>[]>(
      "notion_connections?on_conflict=chatvault_user_id,product_slug,bot_id",
      {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=representation",
        body: {
          chatvault_user_id: stateRow.chatvault_user_id,
          bot_id: String(tokenData.bot_id),
          workspace_id: String(tokenData.workspace_id),
          workspace_name: tokenData.workspace_name || "Unknown Workspace",
          workspace_icon: tokenData.workspace_icon || null,
          owner_user_id: ownerUserId,
          access_token_ciphertext: accessCiphertext,
          refresh_token_ciphertext: refreshCiphertext,
          key_version: 1,
          status: "pending_oauth",
          product_slug: productSlug,
          updated_at: new Date().toISOString(),
          last_refreshed_at: new Date().toISOString(),
          revoked_at: null
        }
      }
    );
    const connectionId = String(connections && connections[0] && connections[0].id || "");
    if (!connectionId) return htmlResponse("Notion connection could not be stored.", 500);

    const resultCode = randomOpaqueToken(32);
    const resultIssued = await supabaseRest<boolean>("rpc/issue_notion_oauth_result", {
      method: "POST",
      body: {
        p_result_code_hash: await sha256Hex(resultCode),
        p_user_id: stateRow.chatvault_user_id,
        p_connection_id: connectionId,
        p_flow_challenge_hash: stateRow.flow_challenge_hash,
        p_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      }
    });
    if (!resultIssued) return htmlResponse("Too many pending authorization results. Please try again later.", 429);
    const redirect = new URL(stateRow.final_redirect_uri);
    redirect.searchParams.set("result_code", resultCode);
    return Response.redirect(redirect.toString(), 302);
  } catch (_error) {
    if (stateRow) {
      const redirect = new URL(stateRow.final_redirect_uri);
      redirect.searchParams.set("error", "oauth_failed");
      return Response.redirect(redirect.toString(), 302);
    }
    return htmlResponse("Notion authorization failed safely. Please return to the extension and try again.", 500);
  }
}
