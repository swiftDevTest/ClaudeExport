import test from "node:test";
import assert from "node:assert/strict";

import { createExportPlatformFetchers } from "../src/modules/export/platform-fetchers.js";
import { createExportDocument } from "../src/modules/export/document.js";
import { wordCodeBlock } from "../src/modules/export/builders/docx.js";

const diagram = [
  "                 iOS Native",
  "                     │",
  "        ┌────────────┼────────────┐",
  "        ↓            ↓            ↓",
  "   Native Router   Bridge     Lifecycle",
  "        │            │            │",
  "        └──────── FlutterEngine ───┘"
].join("\n");

test("ChatGPT API Markdown parsing preserves positional spaces in fenced diagrams", () => {
  const fetchers = createExportPlatformFetchers();
  const blocks = fetchers._test.plainTextToExportBlocks("```\n" + diagram + "\n```");

  assert.deepEqual(blocks, [{ type: "code", language: "", text: diagram }]);
});

test("export normalization never collapses spaces inside code diagrams", () => {
  const fetchers = createExportPlatformFetchers();
  const cloned = fetchers.cloneExportMessages([{
    role: "assistant",
    contentBlocks: [{ type: "code", text: diagram }]
  }]);
  const document = createExportDocument({ messages: cloned });

  assert.equal(cloned[0].contentBlocks[0].text, diagram);
  assert.equal(document.messages[0].contentBlocks[0].text, diagram);
});

test("page syntax-highlight segments cannot collapse API code newlines", () => {
  const fetchers = createExportPlatformFetchers();
  const formattedJson = [
    "{",
    "  \"aps\": {",
    "    \"alert\": {",
    "      \"title\": \"新消息\",",
    "      \"body\": \"你收到一条新消息\"",
    "    },",
    "    \"badge\": 1,",
    "    \"sound\": \"default\"",
    "  }",
    "}"
  ].join("\n");
  const compactPresentation = formattedJson.replace(/\n\s*/g, " ");
  const apiMessages = [{
    role: "assistant",
    contentBlocks: [{ type: "code", language: "json", text: formattedJson }]
  }];
  const pageMessages = [{
    role: "assistant",
    contentBlocks: [{
      type: "code",
      language: "json",
      text: formattedJson,
      codeSegments: [{ text: compactPresentation }]
    }]
  }];

  const merged = fetchers.mergePageHtmlPresentation(apiMessages, pageMessages);

  assert.equal(merged[0].contentBlocks[0].text, formattedJson);
});

test("page code with more line structure can restore compact API code", () => {
  const fetchers = createExportPlatformFetchers();
  const formattedJson = "{\n  \"aps\": {\n    \"badge\": 1\n  }\n}";
  const compactJson = formattedJson.replace(/\n\s*/g, " ");
  const apiMessages = [{
    role: "assistant",
    contentBlocks: [{ type: "code", language: "json", text: compactJson }]
  }];
  const pageMessages = [{
    role: "assistant",
    contentBlocks: [{
      type: "code",
      language: "json",
      text: formattedJson
    }]
  }];

  const merged = fetchers.mergePageHtmlPresentation(apiMessages, pageMessages);

  assert.equal(merged[0].contentBlocks[0].text, formattedJson);
});

test("page code with richer indentation can restore equally line-broken API code", () => {
  const fetchers = createExportPlatformFetchers();
  const apiText = "final class Counter {\nlet value = 1\n}";
  const pageText = "final class Counter {\n  let value = 1\n}";
  const merged = fetchers.mergePageHtmlPresentation([{
    role: "assistant",
    contentBlocks: [{ type: "code", language: "swift", text: apiText }]
  }], [{
    role: "assistant",
    contentBlocks: [{
      type: "code",
      language: "swift",
      text: pageText,
      codeSegments: [{ text: pageText }]
    }]
  }]);

  assert.equal(merged[0].contentBlocks[0].text, pageText);
});

test("page code cannot erase API indentation when line counts are equal", () => {
  const fetchers = createExportPlatformFetchers();
  const apiText = "final class Counter {\n  let value = 1\n}";
  const pageText = "final class Counter {\nlet value = 1\n}";
  const merged = fetchers.mergePageHtmlPresentation([{
    role: "assistant",
    contentBlocks: [{ type: "code", language: "swift", text: apiText }]
  }], [{
    role: "assistant",
    contentBlocks: [{
      type: "code",
      language: "swift",
      text: pageText,
      codeSegments: [{ text: pageText }]
    }]
  }]);

  assert.equal(merged[0].contentBlocks[0].text, apiText);
});

test("export normalization does not rewrite intentionally compact JSON", () => {
  const compactJson = '{"value":1e+10,"empty":{}}';
  const document = createExportDocument({
    messages: [{
      role: "assistant",
      contentBlocks: [{ type: "code", language: "json", text: compactJson }]
    }]
  });

  assert.equal(document.messages[0].contentBlocks[0].text, compactJson);
});

test("Word code blocks preserve leading indentation and tabs", () => {
  const source = "{\n  \"aps\": {\n\t\"badge\": 1\n  }\n}";
  const xml = wordCodeBlock({ type: "code", language: "json", text: source }, false, {
    codeLabel: "64748B",
    codeText: "E5EEF8",
    codeBorder: "162334",
    codeBg: "162334"
  });

  assert.ok(xml.includes('<w:t xml:space="preserve">  &quot;aps&quot;: {</w:t>'));
  assert.ok(xml.includes('<w:tab/><w:t xml:space="preserve">&quot;badge&quot;: 1</w:t>'));
});
