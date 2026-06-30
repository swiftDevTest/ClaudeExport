import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { parseClaudeMessages } from "../src/modules/export/platforms/claude/extractor.js";

function setGlobalDom(html, url) {
  var original = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    Element: globalThis.Element
  };
  var had = {
    window: Object.prototype.hasOwnProperty.call(globalThis, "window"),
    document: Object.prototype.hasOwnProperty.call(globalThis, "document"),
    Node: Object.prototype.hasOwnProperty.call(globalThis, "Node"),
    Element: Object.prototype.hasOwnProperty.call(globalThis, "Element")
  };
  var dom = new JSDOM(html, { url: url });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.Element = dom.window.Element;

  return function restoreDom() {
    ["window", "document", "Node", "Element"].forEach(function (key) {
      if (had[key]) {
        globalThis[key] = original[key];
      } else {
        delete globalThis[key];
      }
    });
  };
}

function getImageBlocks(message) {
  return (message && message.contentBlocks || []).filter(function (block) {
    return block && block.type === "image";
  });
}

test.skip("ChatGPT DOM export does not inherit a previous uploaded image into later text-only user turns", () => {
  var restoreDom = setGlobalDom(`
    <main>
      <div data-testid="conversation-turn-1">
        <div data-message-author-role="user">
          <img src="https://files.oaiusercontent.com/uploaded-first.png" alt="Uploaded diagram">
          <div class="whitespace-pre-wrap">Explain this diagram</div>
        </div>
      </div>
      <div data-testid="conversation-turn-2">
        <div class="stale-upload-preview">
          <img src="https://files.oaiusercontent.com/uploaded-first.png" alt="Uploaded diagram">
        </div>
        <div data-message-author-role="user">
          <div class="whitespace-pre-wrap">Now answer without another image</div>
        </div>
      </div>
    </main>
  `, "https://chatgpt.com/c/test");

  try {
    var messages = parseChatGPTMessages().filter(function (message) {
      return message.role === "user";
    });

    assert.equal(messages.length, 2);
    assert.equal(getImageBlocks(messages[0]).length, 1);
    assert.equal(getImageBlocks(messages[1]).length, 0);
    assert.equal(messages[1].contentBlocks.some(function (block) {
      return block.type === "paragraph" && block.text === "Now answer without another image";
    }), true);
  } finally {
    restoreDom();
  }
});

test.skip("Gemini DOM export keeps uploaded images scoped to their owning user query", () => {
  var restoreDom = setGlobalDom(`
    <main>
      <conversation-turn>
        <user-query>
          <div class="query-text">
            <img src="https://lh3.googleusercontent.com/uploaded/user-first.png" alt="Uploaded diagram">
            <span>Explain this diagram</span>
          </div>
        </user-query>
        <model-response>
          <message-content>It is a diagram.</message-content>
        </model-response>
      </conversation-turn>
      <conversation-turn>
        <div class="stale-upload-preview">
          <img src="https://lh3.googleusercontent.com/uploaded/user-first.png" alt="Uploaded diagram">
        </div>
        <user-query>
          <div class="query-text">Now answer without another image</div>
        </user-query>
        <model-response>
          <message-content>Done.</message-content>
        </model-response>
      </conversation-turn>
    </main>
  `, "https://gemini.google.com/app/test");

  try {
    var userMessages = parseGeminiMessages().filter(function (message) {
      return message.role === "user";
    });

    assert.equal(userMessages.length, 2);
    assert.equal(getImageBlocks(userMessages[0]).length, 1);
    assert.equal(getImageBlocks(userMessages[1]).length, 0);
    assert.equal(userMessages[1].contentBlocks.some(function (block) {
      return block.type === "paragraph" && block.text === "Now answer without another image";
    }), true);
  } finally {
    restoreDom();
  }
});

test.skip("Gemini DOM export removes multi-image attachment filename metadata", () => {
  var fileNames = [
    "功能截图-文件夹管理.jpg",
    "功能截图-选中导出.jpg",
    "功能截图-设置界面.jpg",
    "功能截图-word导出效果.png",
    "功能截图-pdf效果.jpg",
    "功能截图-图片导出效果.jpg"
  ];
  var images = fileNames.map(function (name, index) {
    return '<img src="https://lh3.googleusercontent.com/uploaded/multi-' + index + '.png" width="240" height="240" alt="' + name + '">';
  }).join("");
  var filenameList = fileNames.map(function (name, index) {
    return '<li>' + (index + 1) + '. ' + name + '</li>';
  }).join("");
  var restoreDom = setGlobalDom(`
    <main>
      <conversation-turn>
        <user-query>
          <div class="query-text">
            <div class="attachment-row">${images}</div>
            <ol class="attachment-filenames">${filenameList}</ol>
            <p>这是我的插件在浏览器上的最新截图，请设计商店图。</p>
          </div>
        </user-query>
        <model-response>
          <message-content>好的。</message-content>
        </model-response>
      </conversation-turn>
      <conversation-turn>
        <div class="stale-upload-preview">${images}</div>
        <user-query>
          <div class="query-text">后续纯文字问题</div>
        </user-query>
        <model-response>
          <message-content>继续。</message-content>
        </model-response>
      </conversation-turn>
    </main>
  `, "https://gemini.google.com/app/test");

  try {
    var userMessages = parseGeminiMessages().filter(function (message) {
      return message.role === "user";
    });
    var serialized = JSON.stringify(userMessages);

    assert.equal(userMessages.length, 2);
    assert.equal(getImageBlocks(userMessages[0]).length, 6);
    assert.equal(getImageBlocks(userMessages[1]).length, 0);
    assert.equal(serialized.includes("功能截图-文件夹管理.jpg"), false);
    assert.equal(serialized.includes("功能截图-图片导出效果.jpg"), false);
    assert.equal(serialized.includes("这是我的插件在浏览器上的最新截图"), true);
  } finally {
    restoreDom();
  }
});

test("Claude DOM export does not inherit a previous uploaded image into later text-only user turns", () => {
  var restoreDom = setGlobalDom(`
    <main>
      <div data-testid="human-message">
        <div data-testid="message-content">Explain this image</div>
        <div class="attachment-preview">
          <img src="https://images.anthropic.com/uploaded-first.png" width="240" height="240" alt="Uploaded diagram">
        </div>
      </div>
      <div data-testid="assistant-message">
        <div data-testid="message-content">It is a diagram.</div>
      </div>
      <div data-testid="human-message">
        <div data-testid="message-content">Now answer without another image</div>
        <div class="stale-upload-preview">
          <img src="https://images.anthropic.com/uploaded-first.png" width="240" height="240" alt="Uploaded diagram">
        </div>
      </div>
    </main>
  `, "https://claude.ai/chat/test");

  try {
    var userMessages = parseClaudeMessages().filter(function (message) {
      return message.role === "user";
    });

    assert.equal(userMessages.length, 2);
    assert.equal(getImageBlocks(userMessages[0]).length, 1);
    assert.equal(getImageBlocks(userMessages[1]).length, 0);
    assert.equal(userMessages[1].contentBlocks.some(function (block) {
      return block.type === "paragraph" && block.text === "Now answer without another image";
    }), true);
  } finally {
    restoreDom();
  }
});
