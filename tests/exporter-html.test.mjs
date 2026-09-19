import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.chrome = globalThis.chrome || {
  i18n: {
    getMessage() { return ""; },
    getUILanguage() { return "en"; }
  }
};

const { buildHtmlBlob } = await import("../src/modules/export/builders/html.js");
const { buildMarkdownBlob } = await import("../src/modules/export/builders/markdown.js");
const { buildTxtBlob } = await import("../src/modules/export/builders/txt.js");
const { buildJsonBlob } = await import("../src/modules/export/builders/json.js");
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
  const previousWindow = globalThis.window;
  globalThis.window = new JSDOM("<!doctype html><html><body></body></html>").window;
  let blob;
  try {
    blob = await buildHtmlBlob([
      {
      role: "user",
      htmlStyle: { "background-color": "rgb(240, 240, 240)", "border-radius": "18px" },
      contentBlocks: [
        {
          type: "paragraph",
          htmlStyle: {
            color: "rgb(12, 34, 56)",
            "font-size": "18px",
            "padding-left": "12px",
            "background-image": "url(https://example.com/tracker.png)"
          },
          segments: [
            { text: "<script>alert(1)</script>", htmlStyle: { "font-weight": "700", color: "red;display:none" } },
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
        { type: "paragraph", text: "Actor 遇到 `await`，称为 **Actor Reentrancy**，也称为 *可重入*。" },
        {
          type: "paragraph",
          text: "旧 H2O x2 重点 下划线 x^2 + alpha",
          segments: [
            { text: "旧", marks: { strike: true } },
            { text: " H" },
            { text: "2", marks: { subscript: true } },
            { text: "O x" },
            { text: "2", marks: { superscript: true } },
            { text: " " },
            { text: "重点", marks: { highlight: true } },
            { text: " " },
            { text: "下划线", marks: { underline: true } },
            { text: " " },
            {
              text: "x^2 + \\alpha + \\sqrt{y}",
              marks: { math: true },
              mathMl: '<math onclick="alert(1)"><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>α</mi><mo>+</mo><msqrt><mi>y</mi></msqrt><script>alert(1)</script></mrow></math>'
            }
          ]
        },
        {
          type: "blockquote",
          text: "引用 `await`",
          htmlStyle: { "border-left": "0px solid rgb(218, 220, 224)", "padding-left": "24px" }
        },
        {
          type: "code",
          language: "js",
          text: "const value = '<tag>';",
          htmlStyle: { "background-color": "rgba(0, 0, 0, 0)", "border-radius": "18px" },
          codeStyle: { "font-size": "13px", "line-height": "20px" },
          codeSegments: [
            { text: "const", htmlStyle: { color: "rgb(190, 65, 55)", "font-weight": "700" } },
            { text: " value = '<tag>';", htmlStyle: { color: "red;display:none" } }
          ]
        },
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
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }

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
  assert.match(html, /style="color:rgb\(12, 34, 56\);font-size:18px;padding-left:12px"/);
  assert.match(html, /style="font-weight:700"/);
  assert.match(html, /class="message user">/);
  assert.match(html, /<span style="color:rgb\(190, 65, 55\);font-weight:700">const<\/span> value = &#39;&lt;tag&gt;&#39;;/);
  assert.match(html, /Actor 遇到 <code>await<\/code>，称为 <strong>Actor Reentrancy<\/strong>，也称为 <em>可重入<\/em>。/);
  assert.doesNotMatch(html, /`await`|\*\*Actor Reentrancy\*\*/);
  assert.match(html, /<del>旧<\/del> H<sub>2<\/sub>O x<sup>2<\/sup> <mark>重点<\/mark> <u>下划线<\/u> <span class="math-inline"><math><mrow><msup>/);
  assert.match(html, /<msqrt><mi>y<\/mi><\/msqrt>/);
  assert.doesNotMatch(html, /onclick=/i);
  assert.match(html, /<blockquote style="border-left:4px solid rgb\(218, 220, 224\);padding-left:24px">引用 <code>await<\/code><\/blockquote>/);
  assert.doesNotMatch(html, /<blockquote[^>]*border-left:0px/);
  assert.match(html, /<pre><code style="font-size:13px;line-height:20px">/);
  assert.doesNotMatch(html, /class="code-block" style="[^"]*background-color:rgba\(0, 0, 0, 0\)/);
  assert.match(html, /class="code-block" style="border-radius:18px"/);
  assert.doesNotMatch(html, /tracker\.png|display:none/);
  assert.match(html, /\.message\.user\{width:fit-content;max-width:88%;margin-left:auto;margin-right:0/);
  assert.match(html, /footer\{[^}]*border-top:0/);
  assert.doesNotMatch(html, /class="role"/);
  assert.doesNotMatch(html, /<span>ChatGPT<\/span>/);
});

test("HTML export bounds embedded image count and aggregate bytes", async () => {
  const imageOne = "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2010%2010%22%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22red%22%2F%3E%3C%2Fsvg%3E";
  const imageTwo = imageOne.replace("red", "blue");
  const messages = [{
    role: "assistant",
    contentBlocks: [
      { type: "image", src: imageOne, alt: "One" },
      { type: "image", src: imageTwo, alt: "Two" }
    ]
  }];

  const countDiagnostics = [];
  const countBlob = await buildHtmlBlob(messages, { title: "Image count", platform: "chatgpt" }, settings(), {
    maxEmbeddedImageCount: 1,
    onDiagnostic(diagnostic) { countDiagnostics.push(diagnostic); }
  });
  const countHtml = await countBlob.text();
  assert.equal((countHtml.match(/<img\b/g) || []).length, 1);
  assert.equal((countHtml.match(/class="image-placeholder"/g) || []).length, 1);
  assert.equal(countDiagnostics.some((item) => item.code === "HTML_IMAGE_COUNT_LIMIT"), true);

  const byteDiagnostics = [];
  const byteBlob = await buildHtmlBlob(messages, { title: "Image bytes", platform: "chatgpt" }, settings(), {
    maxEmbeddedImageBytes: 10,
    onDiagnostic(diagnostic) { byteDiagnostics.push(diagnostic); }
  });
  const byteHtml = await byteBlob.text();
  assert.equal((byteHtml.match(/<img\b/g) || []).length, 0);
  assert.equal((byteHtml.match(/class="image-placeholder"/g) || []).length, 2);
  assert.equal(byteDiagnostics.some((item) => item.code === "HTML_IMAGE_BYTES_LIMIT"), true);
});

test("HTML export keeps ChatGPT generated-file entries visible", async () => {
  const blob = await buildHtmlBlob([{
    role: "assistant",
    contentBlocks: [{
      type: "paragraph",
      text: "下载文件: RunLoop_面试官追问版.md",
      segments: [{ text: "下载文件: RunLoop_面试官追问版.md", href: "sandbox:/mnt/data/RunLoop_面试官追问版.md" }]
    }]
  }], { title: "Generated file", platform: "chatgpt" }, settings(), {});
  const html = await blob.text();
  assert.match(html, /下载文件:\s*RunLoop_面试官追问版\.md/);
  assert.doesNotMatch(html, /href="sandbox:/);
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

test("HTML export preserves DOM-visible Markdown markers and inline code literally", async () => {
  const blob = await buildHtmlBlob([{
    role: "assistant",
    contentBlocks: [
      {
        type: "paragraph",
        textSource: "dom",
        text: "Visible **literal markers** and `code` with \\alpha"
      },
      {
        type: "paragraph",
        textSource: "dom",
        text: "\\alpha and \\sqrt{x}",
        segments: [{ text: "\\alpha and \\sqrt{x}", marks: { code: true } }]
      },
      {
        type: "paragraph",
        text: "API `\\alpha` and **bold**"
      },
      {
        type: "blockquote",
        textSource: "dom",
        text: "Quoted **literal** text",
        htmlStyle: { "border-left": "0px solid rgb(0 0 0 / 0)" }
      },
      {
        type: "table",
        textSource: "dom",
        headers: ["**literal header**"],
        rows: [["`literal cell`"]]
      }
    ]
  }], { title: "Visible content", platform: "chatgpt" }, settings({
    show_conversation_title: false,
    show_platform_name: false,
    show_export_time: false,
    show_chatvault_badge: false
  }), {});

  const html = await blob.text();
  assert.equal(html.includes("<p>Visible **literal markers** and `code` with \\alpha</p>"), true);
  assert.equal(html.includes("<p><code>\\alpha and \\sqrt{x}</code></p>"), true);
  assert.equal(html.includes("<p>API <code>\\alpha</code> and <strong>bold</strong></p>"), true);
  assert.equal(html.includes("<blockquote>Quoted **literal** text</blockquote>"), true);
  assert.equal(html.includes("<th>**literal header**</th>"), true);
  assert.equal(html.includes("<td>`literal cell`</td>"), true);
  assert.doesNotMatch(html, /<blockquote[^>]*border-left:[^>]+>/);
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

test("custom themes apply to HTML, Word, PDF, and Image exports", async () => {
  const metadata = {
    title: "Theme scope",
    platform: "chatgpt",
    platformLabel: "ChatGPT",
    sourceUrl: "https://chatgpt.com/c/theme-scope",
    exportedAt: "2026-07-18T00:00:00.000Z"
  };
  const messages = [{
    role: "assistant",
    contentBlocks: [{ type: "paragraph", text: "Theme scope test" }]
  }];
  const naturalHtml = await buildHtmlBlob(messages, metadata, settings({ export_style: "natural" })).then((blob) => blob.text());
  const midnightHtml = await buildHtmlBlob(messages, metadata, settings({ export_style: "midnight" })).then((blob) => blob.text());
  const textBuilders = [buildMarkdownBlob, buildTxtBlob, buildJsonBlob];

  assert.notEqual(midnightHtml, naturalHtml);
  assert.match(midnightHtml, /#181818/i);
  for (const build of textBuilders) {
    const naturalOutput = await build(messages, metadata, settings({ export_style: "natural" })).then((blob) => blob.text());
    const midnightOutput = await build(messages, metadata, settings({ export_style: "midnight" })).then((blob) => blob.text());
    assert.equal(midnightOutput, naturalOutput);
  }
  assert.equal(getWordTheme(settings({ export_style: "midnight" })).styleId, "midnight");
  assert.equal(getPdfTheme(settings({ export_style: "midnight" })).styleId, "midnight");
  assert.equal(getImageTheme(settings({ export_style: "midnight" })).styleId, "midnight");
});
