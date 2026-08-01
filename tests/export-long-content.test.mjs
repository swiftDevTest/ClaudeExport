import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || {
  i18n: {
    getMessage() { return ""; },
    getUILanguage() { return "en"; }
  }
};

const { buildMarkdownBlob } = await import("../src/modules/export/builders/markdown.js");
const { buildTxtBlob } = await import("../src/modules/export/builders/txt.js");
const { buildJsonBlob } = await import("../src/modules/export/builders/json.js");
const { buildHtmlBlob } = await import("../src/modules/export/builders/html.js");
const { wordBlocks } = await import("../src/modules/export/builders/docx.js");
const { getWordTheme } = await import("../src/modules/export/themes/word.js");

function settings() {
  return {
    export_style: "natural",
    export_ai_replies_only: false,
    show_conversation_title: false,
    show_platform_name: false,
    show_export_time: false,
    include_source_url: false,
    show_role_labels: false,
    show_chatvault_badge: false,
    align_user_messages_right: false
  };
}

function longContentFixture() {
  const items = Array.from({ length: 180 }, (_, index) => ({
    text: `LongItem${String(index + 1).padStart(3, "0")}`,
    subItems: [{ text: `NestedItem${String(index + 1).padStart(3, "0")}` }]
  }));
  return [{
    role: "assistant",
    contentBlocks: [
      { type: "heading", level: 2, text: "Long export" },
      { type: "list", ordered: true, start: 1, items },
      {
        type: "table",
        headers: ["Key", "Value"],
        rows: [["FirstRow", "FirstValue"], ["LastRow", "LastValue"]]
      },
      { type: "blockquote", text: "FinalQuote" }
    ]
  }];
}

test("non-paginated and native-paginated exports retain long structured content", async () => {
  const messages = longContentFixture();
  const metadata = { title: "Long export", platform: "chatgpt" };
  const exportSettings = settings();
  const [markdown, text, json, html] = await Promise.all([
    buildMarkdownBlob(messages, metadata, exportSettings, {}).then((blob) => blob.text()),
    buildTxtBlob(messages, metadata, exportSettings, {}).then((blob) => blob.text()),
    buildJsonBlob(messages, metadata, exportSettings, {}).then((blob) => blob.text()),
    buildHtmlBlob(messages, metadata, exportSettings, {}).then((blob) => blob.text())
  ]);

  [markdown, text, html].forEach((output) => {
    assert.match(output, /LongItem001/);
    assert.match(output, /LongItem180/);
    assert.match(output, /NestedItem180/);
    assert.match(output, /LastValue/);
    assert.match(output, /FinalQuote/);
  });

  const parsed = JSON.parse(json);
  assert.equal(parsed.messages[0].contentBlocks[1].items.length, 180);
  assert.equal(parsed.messages[0].contentBlocks[1].items[179].text, "LongItem180");
  assert.equal(parsed.messages[0].contentBlocks[1].items[179].subItems[0].text, "NestedItem180");

  const wordTheme = getWordTheme(exportSettings);
  const wordXml = wordBlocks(messages[0].contentBlocks, {}, false, wordTheme.word, "assistant", {
    byHref: new Map(),
    entries: []
  }, true);
  assert.match(wordXml, /LongItem001/);
  assert.match(wordXml, /LongItem180/);
  assert.match(wordXml, /NestedItem180/);
  assert.match(wordXml, /LastValue/);
  assert.match(wordXml, /FinalQuote/);
});
