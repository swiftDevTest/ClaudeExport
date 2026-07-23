import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleOAuthCallback } from "../_shared/notion-oauth-callback.ts";

// Claude Export 的 Notion OAuth 回调。
// Redirect URI: https://acgehhqcgreatcjcefub.supabase.co/functions/v1/notion-oauth-claude
serve(async (request) => {
  return await handleOAuthCallback(request, "claude-export");
});
