import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createExportPlatformFetchers } from "../src/modules/export/platform-fetchers.js";
import { selectDistinctDocumentElements, collapseNestedDocumentElements } from "../src/modules/export/platforms/shared.js";
import { sanitizeFilename, detectPlatform } from "../src/modules/export/utils.js";
import { preloadImageForDocx, imageBytesCache } from "../src/modules/export/media.js";

function installGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

test("Claude product rejects foreign fetchers and hosts before any request", async (t) => {
  installGlobal(t, "CHATVAULT_PRODUCT_CONFIG", { supportedPlatforms: ["claude"] });
  installGlobal(t, "window", { location: new URL("https://claude.ai/chat/test") });
  let requests = 0;
  installGlobal(t, "fetch", async () => { requests++; throw new Error("Unexpected request"); });
  const fetchers = createExportPlatformFetchers({ ensureCanReadChatBody() {}, getChatConversationId() { return "test"; } });
  for (const [platform, method] of [["chatgpt", "fetchChatGptConversationMessages"], ["gemini", "fetchGeminiConversationMessages"]]) {
    await assert.rejects(fetchers[method]({ platform, id: "test" }), /only read Claude/);
  }
  for (const url of ["https://chatgpt.com/c/test", "https://gemini.google.com/app/test", "https://other.claude.ai/chat/test"]) {
    window.location = new URL(url);
    assert.equal(detectPlatform(), "");
    await assert.rejects(fetchers.fetchClaudeConversationMessages({ platform: "claude", id: "test" }), /does not match/);
  }
  assert.equal(requests, 0);
  window.location = new URL("https://claude.ai/chat/test");
  assert.equal(detectPlatform(), "claude");

  const context = { window, CHATVAULT_PRODUCT_CONFIG: { supportedPlatforms: ["claude"] } };
  vm.runInNewContext(readFileSync(new URL("../src/modules/export.js", import.meta.url), "utf8"), context);
  assert.equal(context.CHATVAULT_EXPORT.detectPlatform(), "claude");
  window.location = new URL("https://chatgpt.com/c/test");
  assert.equal(context.CHATVAULT_EXPORT.detectPlatform(), "");
});

test("large DOM candidate sets retain selector priority and document order without dropping turns", () => {
  const dom = new JSDOM(`<main>${Array.from({ length: 1200 }, (_, i) => `<article id="m${i}"><p id="p${i}">Message ${i}</p></article>`).join("")}</main>`);
  const document = dom.window.document;
  const articles = Array.from(document.querySelectorAll("article"));
  const paragraphs = Array.from(document.querySelectorAll("p"));
  assert.deepEqual(selectDistinctDocumentElements([...articles].reverse().concat(paragraphs, articles)), articles);
  assert.deepEqual(selectDistinctDocumentElements(paragraphs.concat(articles)), paragraphs);
  assert.equal(collapseNestedDocumentElements(articles).length, 1200);
  dom.window.close();
});

test("Claude exports use the active organization instead of the first valid ID", async (t) => {
  installGlobal(t, "window", { location: new URL("https://claude.ai/chat/test") });
  const urls = [];
  installGlobal(t, "fetch", async (url) => {
    urls.push(url);
    if (url.endsWith("/api/organizations")) {
      return Response.json([{ uuid: "personal", active: false }, { uuid: "team", is_active: true }]);
    }
    return Response.json({ chat_messages: [
      { sender: "human", text: "Question" },
      { sender: "assistant", text: "Team answer" }
    ] });
  });
  const fetchers = createExportPlatformFetchers({ ensureCanReadChatBody() {}, getChatConversationId(chat) { return chat.id; } });
  await assert.rejects(fetchers.fetchClaudeConversationMessages({ platform: "claude" }), /ID is missing/);
  assert.equal(urls.length, 0);
  const messages = await fetchers.fetchClaudeConversationMessages({ platform: "claude", id: "test" });
  assert.equal(messages.length, 2);
  assert.equal(urls[1], "https://claude.ai/api/organizations/team/chat_conversations/test");
});

test("Claude Markdown tables keep escaped pipes inside cells", () => {
  const fetchers = createExportPlatformFetchers();
  const messages = fetchers.parseClaudeConversationPayload({ chat_messages: [{
    sender: "assistant", text: "| Command | Meaning |\n| --- | --- |\n| a\\|b | alternative |\n| c | next |"
  }] });
  const table = messages[0].contentBlocks.find((block) => block.type === "table");
  assert.deepEqual(table.headers, ["Command", "Meaning"]);
  assert.deepEqual(table.rows, [["a|b", "alternative"], ["c", "next"]]);
});

test("structured-only Claude replies are complete and whitespace-only turns are empty", () => {
  const fetchers = createExportPlatformFetchers();
  const user = { role: "user", contentBlocks: [{ type: "paragraph", text: "Question" }] };
  for (const block of [
    { type: "image", src: "data:image/png;base64,AA==" },
    { type: "table", headers: ["A"], rows: [["B"]] },
    { type: "list", items: [{ text: "Item" }] }
  ]) {
    assert.equal(fetchers.detectApiCompletenessRisk([user, { role: "assistant", contentBlocks: [block] }]).needsFallback, false);
  }
  const risk = fetchers.detectApiCompletenessRisk([user, { role: "assistant", contentBlocks: [{ type: "paragraph", text: "   " }] }, null]);
  assert.equal(risk.emptyContentBlockCount, 2);
  assert.ok(risk.reasons.includes("high_empty_ratio"));
});

test("export filenames avoid Windows device names, trailing dots, and split emoji", () => {
  assert.equal(sanitizeFilename("CON.txt"), "CON_.txt");
  assert.equal(sanitizeFilename("conversation... "), "conversation");
  assert.equal(sanitizeFilename("x".repeat(79) + "🙂"), "x".repeat(79));
});

test("Word converts WebP payloads into real PNG bytes and releases its canvas", async (t) => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const canvases = [];
  installGlobal(t, "Image", class {
    naturalWidth = 32;
    naturalHeight = 24;
    set src(value) { queueMicrotask(() => this.onload?.()); }
  });
  installGlobal(t, "document", {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = {
        width: 0, height: 0,
        getContext() { return { drawImage() {} }; },
        toBlob(callback, type) { callback(new Blob([png], { type })); }
      };
      canvases.push(canvas);
      return canvas;
    }
  });
  t.after(() => imageBytesCache.clear());
  const result = await preloadImageForDocx("data:image/webp;base64,UklGRgQAAABXRUJQ", 0);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.ext, "png");
  assert.deepEqual(result.bytes, png);
  assert.equal(result.width, 32);
  assert.equal(result.height, 24);
  assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
});
