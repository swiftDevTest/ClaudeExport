import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

function installDom() {
  const dom = new JSDOM(`<!doctype html>
    <html>
      <body>
        <main>
          <div data-testid="human-message">
            <div data-testid="message-content">Hello from the user.</div>
          </div>
          <div data-testid="assistant-message">
            <div class="prose"><p>Hello from the assistant.</p></div>
          </div>
        </main>
      </body>
    </html>`, {
    url: "https://claude.ai/chat/test-chat",
    pretendToBeVisual: true
  });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.chrome = {
    i18n: {
      getMessage() {
        return "";
      }
    }
  };

  return dom;
}

test("selection count subscribers survive entering selection mode", async () => {
  const dom = installDom();
  const selection = await import("../src/modules/export/selection.js");

  const counts = [];
  selection.onSelectionChange((count) => {
    counts.push(count);
  });

  selection.enterSelectionMode();
  selection.selectAllAssistant();

  assert.equal(selection.getSelectedCount(), 1);
  assert.equal(counts.includes(1), true);

  selection.exitSelectionMode();
  dom.window.close();
});

test("each selection control toggles its own conversation message", async () => {
  const dom = installDom();
  const selection = await import("../src/modules/export/selection.js");

  selection.enterSelectionMode();
  const checkboxes = Array.from(document.querySelectorAll(".cv-export-checkbox"));
  assert.equal(checkboxes.length, 2);

  checkboxes[0].click();
  assert.equal(checkboxes[0].dataset.selected, "true");
  assert.equal(checkboxes[1].dataset.selected, "false");
  assert.equal(selection.getSelectedCount(), 1);

  checkboxes[1].click();
  assert.equal(checkboxes[0].dataset.selected, "true");
  assert.equal(checkboxes[1].dataset.selected, "true");
  assert.equal(selection.getSelectedCount(), 2);

  selection.exitSelectionMode();
  dom.window.close();
});
