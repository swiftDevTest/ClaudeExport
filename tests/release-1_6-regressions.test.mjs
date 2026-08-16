import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL("../" + relativePath, import.meta.url), "utf8");
}

test("yieldToBrowser closes both MessageChannel ports after yielding", async () => {
  const originalMessageChannel = globalThis.MessageChannel;
  const ports = [];

  class FakeMessageChannel {
    constructor() {
      const port1 = {
        closed: false,
        close() { this.closed = true; },
        postMessage() { queueMicrotask(() => port2.onmessage?.()); }
      };
      const port2 = {
        closed: false,
        onmessage: null,
        close() { this.closed = true; }
      };
      this.port1 = port1;
      this.port2 = port2;
      ports.push(port1, port2);
    }
  }

  globalThis.MessageChannel = FakeMessageChannel;
  try {
    const { yieldToBrowser } = await import("../src/modules/export/utils.js?release-1-6-message-channel");
    await yieldToBrowser();
    assert.equal(ports.length, 2);
    assert.ok(ports.every((port) => port.closed));
  } finally {
    if (originalMessageChannel === undefined) delete globalThis.MessageChannel;
    else globalThis.MessageChannel = originalMessageChannel;
  }
});

test("export engine preserves incomplete-export notices in the generated file", async () => {
  const originalChrome = globalThis.chrome;
  const originalWindow = globalThis.window;
  globalThis.chrome = {
    i18n: {
      getMessage() { return ""; },
      getUILanguage() { return "en"; }
    }
  };
  globalThis.window = { location: { hostname: "claude.ai", href: "https://claude.ai/c/test" } };
  try {
    const { createExportBlob } = await import("../src/modules/export/engine.js?release-1-6-notice");
    const notice = "Claude Export notice: This export may be incomplete because Claude Export returned an unknown message format.";
    const result = await createExportBlob({
      format: "txt",
      platform: "claude",
      scope: "conversation",
      title: "Incomplete export",
      messages: [{
        role: "assistant",
        contentBlocks: [{ type: "paragraph", text: notice }]
      }],
      settings: {
        show_conversation_title: false,
        show_platform_name: false,
        show_export_time: false,
        show_role_labels: false,
        show_chatvault_badge: false
      }
    });
    assert.equal(result.ok, true);
    assert.match(await result.blob.text(), /This export may be incomplete/);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("clearing Help Center search removes a stale no-results message", () => {
  const source = read("src/help.js");
  assert.match(
    source,
    /if \(!query\)[\s\S]*?getElementById\("help-no-results-msg"\)[\s\S]*?\.remove\(\)[\s\S]*?return;/
  );
});

test("theme preview normalizes regional system language codes", () => {
  const source = read("src/theme-preview.js");
  assert.match(source, /replace\(\/-\/g,'_'\)/);
  assert.match(source, /base==='zh'/);
  assert.match(source, /'zh_TW':'zh_CN'/);
  assert.match(source, /base==='pt'\)return'pt_BR'/);
  assert.match(source, /normalizePreviewLanguage\(navigator\.language\|\|'en'\)/);
});
