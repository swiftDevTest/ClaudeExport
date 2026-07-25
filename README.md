# ChatVault Exporter

## Release Checklist

Run the release gate before uploading a Chrome Web Store package:

```bash
npm run release:check
```

The package script writes a clean extension bundle to `dist/extension/` and a ZIP named `dist/chatvault-exporter-<version>.zip`. The bundle is generated from an allowlist so `site/`, `supabase/`, `tests/`, `node_modules/`, old ZIPs, and local metadata are not included.

Before submitting to Chrome Web Store:

1. Confirm `manifest.json`, `package.json`, and the release ZIP filename use the same new version.
2. Confirm the production Chrome Web Store extension ID has a matching Google OAuth redirect URI.
3. Configure `CHATVAULT_ALLOWED_ORIGINS` with the official site, supported AI platform origins, and exact Chrome extension IDs. Do not use `chrome-extension://*`.
4. Deploy pending Supabase migrations and Edge Functions, then smoke test checkout, webhook entitlement sync, restore purchase, and the 3-export free limit.
5. Complete Chrome Web Store privacy/data-use disclosures for account email, user ID, subscription state, non-content analytics events, and user-initiated Notion sync. Local exports do not upload chat bodies to ChatVault servers.

## OAuth Redirects

The source manifest intentionally does not pin a public `key`. Unpacked builds may therefore use a development extension ID, while the Chrome Web Store build uses its assigned production ID.

Register this exact Google OAuth redirect URI on the Google OAuth client configured in `src/supabase-config.js`:

`https://ljlmljccgbogejkhlnldgolahihniebj.chromiumapp.org/`

Current Google OAuth client ID:

`285963973789-94pbkh7qlk0o04d2ji3uggecs27td888.apps.googleusercontent.com`

The URI above is the production Chrome Web Store redirect. Register any unpacked-development ID separately when testing Google OAuth locally.

Do not reuse competitor or placeholder Chrome Web Store IDs in OAuth configuration.
