import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || {
  i18n: {
    getMessage() { return ""; },
    getUILanguage() { return "en"; }
  }
};

const { buildHtmlBlob } = await import("../src/modules/export/builders/html.js");
const { buildFilename } = await import("../src/modules/export/utils.js");
const { getExportTheme } = await import("../src/modules/export/themes/tokens.js");
const { getPdfTheme } = await import("../src/modules/export/themes/pdf.js");
const { getWordTheme } = await import("../src/modules/export/themes/word.js");
const { getImageTheme } = await import("../src/modules/export/themes/image.js");
await import("../src/modules/entitlements.js");

function settings(overrides = {}) {
  return {
    export_ai_replies_only: false,
    show_export_time: true,
    show_conversation_title: true,
    show_platform_name: true,
    show_role_labels: true,
    show_chatvault_badge: true,
    include_source_url: true,
    align_user_messages_right: true,
    export_style: "natural",
    ...overrides
  };
}

test("HTML export creates a safe self-contained document", async () => {
  const image = "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2010%2010%22%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%2F%3E%3C%2Fsvg%3E";
  const blob = await buildHtmlBlob([
    {
      role: "user",
      contentBlocks: [
        {
          type: "paragraph",
          segments: [
            { text: "<script>alert(1)</script>" },
            { text: " safe", href: "https://example.com/path" },
            { text: " unsafe", href: "javascript:alert(1)" }
          ]
        }
      ]
    },
    {
      role: "assistant",
      contentBlocks: [
        { type: "heading", level: 1, text: "Result" },
        { type: "paragraph", text: "Actor 遇到 `await`，称为 **Actor Reentrancy**。" },
        { type: "code", language: "js", text: "const value = '<tag>';" },
        { type: "table", headers: ["A", "B"], rows: [["1", "2"]] },
        { type: "image", src: image, alt: "Chart" }
      ]
    }
  ], {
    title: "Unsafe <Title>",
    platform: "chatgpt",
    exportedAt: new Date("2026-07-13T00:00:00Z"),
    sourceUrl: "https://chatgpt.com/c/test"
  }, settings(), {});

  assert.equal(blob.type, "text/html;charset=utf-8");
  const html = await blob.text();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Unsafe &lt;Title&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html, /src="https?:/i);
  assert.match(html, /<table>/);
  assert.match(html, /background:#fff/);
  assert.match(html, /Actor 遇到 <code>await<\/code>，称为 <strong>Actor Reentrancy<\/strong>。/);
  assert.doesNotMatch(html, /`await`|\*\*Actor Reentrancy\*\*/);
  assert.doesNotMatch(html, /class="role"/);
  assert.doesNotMatch(html, /<span>ChatGPT<\/span>/);
});

test("HTML export settings filter user messages and optional header content", async () => {
  const blob = await buildHtmlBlob([
    { role: "user", contentBlocks: [{ type: "paragraph", text: "PROMPT" }] },
    { role: "assistant", contentBlocks: [{ type: "paragraph", text: "ANSWER" }] }
  ], { title: "Hidden title", platform: "claude" }, settings({
    export_ai_replies_only: true,
    show_conversation_title: false,
    show_platform_name: false,
    show_export_time: false,
    show_role_labels: false,
    show_chatvault_badge: false,
    include_source_url: false
  }), {});
  const html = await blob.text();
  assert.doesNotMatch(html, /PROMPT/);
  assert.match(html, /ANSWER/);
  assert.doesNotMatch(html, /<header>/);
  assert.doesNotMatch(html, /<footer>/);
  assert.doesNotMatch(html, /class="role"/);
});

test("HTML filename and natural theme are registered", () => {
  assert.equal(buildFilename("html", "conversation", { title: "Example" }), "Example.html");
  const natural = getExportTheme("natural");
  assert.equal(natural.id, "natural");
  assert.equal(natural.bg.colors[0], "#ffffff");
  assert.equal(natural.color.cardBgUser, "transparent");
  assert.equal(getPdfTheme(settings()).styleId, "natural");
  assert.equal(getImageTheme(settings()).theme.color.cardBgAssistant, "transparent");
  assert.equal(getWordTheme(settings()).pageBg, "FFFFFF");
  const entitlements = globalThis.CHATVAULT_ENTITLEMENTS;
  const freeProfile = entitlements.normalizeProfile({ plan: "free" });
  assert.equal(entitlements.canUseExportStyle(freeProfile, "natural"), true);
  assert.equal(entitlements.canUseExportStyle(freeProfile, "midnight"), false);
});
