import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function readLocale(locale) {
  return JSON.parse(readText(`../_locales/${locale}/messages.json`));
}

function placeholders(message) {
  return Array.from(String(message || "").matchAll(/\$\d+/g), (match) => match[0]).sort();
}

test("all locale catalogs cover the same keys and placeholders", () => {
  const locales = readdirSync(new URL("../_locales/", import.meta.url)).sort();
  const english = readLocale("en");
  const englishKeys = Object.keys(english).sort();

  assert.ok(locales.includes("en"));
  for (const locale of locales) {
    const catalog = readLocale(locale);
    assert.deepEqual(Object.keys(catalog).sort(), englishKeys, `${locale} key set`);
    for (const key of englishKeys) {
      assert.deepEqual(
        placeholders(catalog[key]?.message),
        placeholders(english[key]?.message),
        `${locale}.${key} placeholders`
      );
    }
  }
});

test("new connection and sync UI is localized instead of falling back to English", () => {
  const english = readLocale("en");
  const translatedKeys = [
    "connections_title",
    "language_label",
    "save_to_notion",
    "save_to_obsidian",
    "notion_disconnect_success",
    "notion_disconnect_failed",
    "notion_status_held",
    "notion_status_pending",
    "notion_status_running",
    "notion_status_retry_wait",
    "notion_status_succeeded",
    "notion_status_partial",
    "notion_status_failed",
    "notion_status_cancelled",
    "notion_datasource_fetch_failed",
    "notion_job_warnings_count",
    "notion_cancel_job",
    "notion_retry_job",
    "notion_select_database_first",
    "notion_sync_request_failed",
    "notion_err_update_conflict",
    "notion_err_replace_required",
    "notion_err_ambiguous_append",
    "notion_err_image_upload",
    "notion_err_schema",
    "notion_err_reconnect",
    "notion_err_permission",
    "notion_err_missing",
    "notion_err_rate_limited",
    "notion_err_temporary",
    "notion_err_unknown",
    "content_exporting_format",
    "selected_label_suffix",
    "obsidian_opening_folder_picker",
    "obsidian_default_note_name",
    "content_auth_session_expired",
    "content_export_fail_reauth_fix"
  ];

  for (const locale of ["de", "es", "fr", "ja", "ko", "pt_BR", "zh_CN", "zh_TW"]) {
    const catalog = readLocale(locale);
    for (const key of translatedKeys) {
      assert.notEqual(
        catalog[key]?.message,
        english[key]?.message,
        `${locale}.${key} should not use the English fallback`
      );
    }
  }
});

test("privacy proof accurately separates local conversion from account quota sync", async () => {
  globalThis.chrome = {
    i18n: {
      getMessage() {
        return "";
      }
    }
  };
  await import(`../src/modules/privacy-proof.js?test=${Date.now()}`);

  const proof = globalThis.CHATVAULT_PRIVACY_PROOF.generateProof({
    format: "pdf",
    platform: "claude",
    usageCost: 1
  });

  assert.equal(proof.localGeneration, true);
  assert.equal(proof.uploadsChatContent, false);
  assert.equal(proof.syncsSignedInUsageWithAccountService, true);
  assert.equal(proof.statements.some((statement) => statement.includes("ChatVault")), false);
  assert.equal(proof.statements.some((statement) => statement.includes("quota and plan status")), true);
});

test("selected re-export keeps its message snapshot and never expands to the full chat", () => {
  const contentSource = readText("../src/content.js");
  const performStart = contentSource.indexOf("async function performExport(options = {})");
  const performEnd = contentSource.indexOf("\n  function cancelExport()", performStart);
  const performSource = contentSource.slice(performStart, performEnd);

  assert.notEqual(performStart, -1);
  assert.notEqual(performEnd, -1);
  assert.match(performSource, /const providedMessages = Array\.isArray\(options\.messages\)/);
  assert.match(performSource, /if \(!providedMessages && !isSelectedExport && platformForExport\)/);
  assert.match(performSource, /messages: mode === "selected" \? rawMessagesForExport : null/);
  assert.match(performSource, /messagesForExport: isSelectedExport \? rawMessagesForExport : null/);
  assert.match(contentSource, /messages: Array\.isArray\(result\.messages\) \? result\.messages : null/);
});

test("reauthentication, OAuth cleanup, and batch save results preserve structured state", () => {
  const backgroundSource = readText("../src/background.js");
  const contentSource = readText("../src/content.js");
  const popupSource = readText("../src/popup.js");

  assert.match(
    backgroundSource,
    /return await runSessionMutation\(\(\) => startGoogleOAuthSessionInternal\(clientId\)\)/
  );
  assert.match(contentSource, /entitlementPreflight\.reauthenticationRequired/);
  assert.match(contentSource, /preCheckError\.reauthenticationRequired = true/);
  assert.match(contentSource, /fixAction: "sign_in"/);
  assert.match(contentSource, /const failedSavePaths = new Set/);
  assert.match(contentSource, /\.filter\(\(file\) => !failedSavePaths\.has/);
  assert.match(contentSource, /downloadPath: file\.downloadPath/);
  assert.match(popupSource, /current\.disabled = !isSupportedPage \|\| \(selectionMode && selectedCount < 1\)/);
});
