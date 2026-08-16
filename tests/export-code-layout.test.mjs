import test from "node:test";
import assert from "node:assert/strict";

import { createExportPlatformFetchers } from "../src/modules/export/platform-fetchers.js";
import { createExportDocument } from "../src/modules/export/document.js";

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
