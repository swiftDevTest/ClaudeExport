import { handleOAuthCallback } from "../_shared/notion-oauth-callback.ts";

// Claude Export 的 Notion OAuth 回调。
// Redirect URI: https://acgehhqcgreatcjcefub.supabase.co/functions/v1/notion-oauth-claude
Deno.serve(async (request) => {
  return await handleOAuthCallback(request, "claude-export");
});
