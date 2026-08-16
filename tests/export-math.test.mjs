import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.chrome = globalThis.chrome || {
  i18n: { getMessage() { return ""; }, getUILanguage() { return "en"; } }
};
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;

const { createExportDocument, validateExportDocument } = await import("../src/modules/export/document.js");
const { buildMarkdownBlob } = await import("../src/modules/export/builders/markdown.js");
const { buildHtmlBlob } = await import("../src/modules/export/builders/html.js");
const { buildJsonBlob } = await import("../src/modules/export/builders/json.js");
const { wordBlocks } = await import("../src/modules/export/builders/docx.js");
const { normalizeContent } = await import("../src/modules/export/parser-dom.js");
const { createExportPlatformFetchers } = await import("../src/modules/export/platform-fetchers.js");
const { getMathAssetKey } = await import("../src/modules/export/math.js");

const settings = {
  export_ai_replies_only: false,
  show_export_time: false,
  show_conversation_title: false,
  show_platform_name: false,
  show_role_labels: false,
  show_chatvault_badge: false,
  include_source_url: false,
  align_user_messages_right: false,
  export_style: "natural"
};

test("semantic display math preserves LaTeX and source MathML in the export document", () => {
  const inputMathMl = '<math display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>';
  const document = createExportDocument({
    messages: [{ role: "assistant", contentBlocks: [{
      type: "math", text: "\\frac{a}{b}", display: true, mathMl: inputMathMl
    }]}]
  });
  const block = document.messages[0].contentBlocks[0];
  assert.equal(validateExportDocument(document).ok, true);
  assert.equal(block.type, "math");
  assert.equal(block.text, "\\frac{a}{b}");
  assert.equal(block.display, true);
  assert.match(block.mathMl, /<math\b/);
  assert.match(block.mathMl, /<mfrac>/);
});

test("DOM display equations become standalone math blocks instead of paragraphs", () => {
  document.body.innerHTML = `
    <main><div data-testid="conversation-turn-1"><div data-message-author-role="assistant">
      <div class="markdown"><div class="katex-display"><span class="katex">
        <math display="block"><semantics><mfrac><mi>a</mi><mi>b</mi></mfrac><annotation encoding="application/x-tex">\\frac{a}{b}</annotation></semantics></math>
      </span></div></div>
    </div></div></main>`;
  const block = normalizeContent(document.querySelector(".markdown"))[0];
  assert.equal(block.type, "math");
  assert.equal(block.text, "\\frac{a}{b}");
  assert.match(block.mathMl, /<mfrac>/);
});

test("API Markdown parser creates semantic blocks for both display-math delimiters", () => {
  const parse = createExportPlatformFetchers()._test.plainTextToExportBlocks;
  assert.deepEqual(parse("Before\n\n$$\n\\frac{a}{b}\n$$\n\nAfter"), [
    { type: "paragraph", text: "Before" },
    { type: "math", text: "\\frac{a}{b}", display: true },
    { type: "paragraph", text: "After" }
  ]);
  assert.deepEqual(parse("\\[\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}\\]"), [{
    type: "math", text: "\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}", display: true
  }]);
  const inline = parse("最后一行：公式 $\\left(\\frac{a+b}{c}\\right)^n$ 应与普通文本一起出现。")[0];
  assert.deepEqual(inline.segments, [
    { text: "最后一行：公式 " },
    { text: "\\left(\\frac{a+b}{c}\\right)^n", marks: { math: true } },
    { text: " 应与普通文本一起出现。" }
  ]);
});

test("math export uses standard Markdown delimiters and MathML-capable HTML/JSON", async () => {
  const messages = [{ role: "assistant", contentBlocks: [
    { type: "paragraph", segments: [{ text: "Area: " }, { text: "x^2", marks: { math: true } }] },
    { type: "math", text: "\\frac{a+b}{c}", display: true }
  ]}];
  const metadata = { title: "Math", platform: "chatgpt", exportedAt: new Date("2026-08-16T00:00:00Z") };
  const [markdown, html, json] = await Promise.all([
    buildMarkdownBlob(messages, metadata, settings, {}).then((blob) => blob.text()),
    buildHtmlBlob(messages, metadata, settings, {}).then((blob) => blob.text()),
    buildJsonBlob(messages, metadata, settings, {}).then((blob) => blob.text())
  ]);
  assert.match(markdown, /Area: \$x\^2\$/);
  assert.match(markdown, /\$\$\n\\frac\{a\+b\}\{c\}\n\$\$/);
  assert.match(html, /class="math-display/);
  assert.match(html, /<math\b/);
  const jsonBlock = JSON.parse(json).messages[0].contentBlocks[1];
  assert.equal(jsonBlock.text, "\\frac{a+b}{c}");
  assert.equal(jsonBlock.display, true);
});

test("Markdown preserves raw TeX from API paragraphs instead of converting it to Unicode", async () => {
  const markdown = await (await buildMarkdownBlob([{ role: "assistant", contentBlocks: [{
    type: "paragraph",
    text: "行内：\\(x^2+y^2=r^2\\)\n\n\\[A=\\begin{bmatrix}1 & 2\\\\3 & 4\\end{bmatrix}\\]"
  }]}], {}, settings, {})).text();
  assert.match(markdown, /行内：\$x\^2\+y\^2=r\^2\$/);
  assert.match(markdown, /\$\$\nA=\\begin\{bmatrix\}1 & 2\\\\3 & 4\\end\{bmatrix\}\n\$\$/);
  assert.doesNotMatch(markdown, /x²|\(√|\(π\)/);
});

test("Word falls back to readable formula text if the shared raster asset cannot be made", () => {
  const xml = wordBlocks([{ type: "math", text: "\\frac{a}{b}", display: true }], {}, false, {
    colorText: "1A202C", inlineCodeBg: "F1F5F9", inlineCodeText: "0F6574"
  }, "assistant", null, true);
  assert.match(xml, /Cambria Math/);
  assert.match(xml, /a/);
  assert.match(xml, /b/);
});

test("Word embeds inline semantic math through the shared formula image cache", () => {
  const block = { type: "paragraph", text: "Area: x²", segments: [
    { text: "Area: " }, { text: "x^2", marks: { math: true } }
  ] };
  const key = "__math__" + getMathAssetKey({ type: "math", text: "x^2", display: false }, 18);
  const xml = wordBlocks([block], {
    [key]: { id: 9, relId: "rIdImage9", path: "media/image9.png", width: 20, height: 18 }
  }, false, { colorText: "1A202C", inlineCodeBg: "F1F5F9", inlineCodeText: "0F6574" }, "assistant", null, true);
  assert.match(xml, /rIdImage9/);
  assert.doesNotMatch(xml, /x²/);
});
