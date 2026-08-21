import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { cleanCodeText } from "../src/modules/export/parser-dom.js";

function createJson(lineCount) {
  if (!lineCount) {
    return [
      "{",
      '  "aps": {',
      '    "alert": {',
      '      "title": "新消息",',
      '      "body": "你收到一条新消息"',
      "    },",
      '    "badge": 1,',
      '    "sound": "default"',
      "  }",
      "}"
    ].join("\n");
  }

  var rows = Array.from({ length: lineCount }, function (_, index) {
    return '  "key' + String(index).padStart(4, "0") + '": ' + index + (index < lineCount - 1 ? "," : "");
  });
  return ["{"].concat(rows, ["}"]).join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function createEditor(json, tokenize) {
  var lines = json.split("\n").map(function (line) {
    var body = tokenize
      ? (line.match(/.{1,8}/g) || [""]).map(function (chunk) {
          return '<span class="syntax-token">' + escapeHtml(chunk) + "</span>";
        }).join("")
      : escapeHtml(line);
    return '<div class="cm-line">' + body + "</div>";
  }).join("");
  var dom = new JSDOM('<pre><div class="toolbar">JSON<button>Copy</button></div><div class="cm-content">' + lines + "</div></pre>");
  var pre = dom.window.document.querySelector("pre");
  var body = dom.window.document.querySelector(".cm-content");
  return { dom: dom, pre: pre, body: body };
}

test("CodeMirror JSON export preserves every rendered line and indentation", () => {
  var json = createJson(0);
  var editor = createEditor(json, false);
  Object.defineProperty(editor.pre, "innerText", { configurable: true, value: "JSON\n" + json });
  Object.defineProperty(editor.body, "innerText", { configurable: true, value: json });

  assert.equal(cleanCodeText(editor.pre), json);
});

test("large tokenized editors do not trigger innerText reads per token", () => {
  var json = createJson(1000);
  var editor = createEditor(json, true);
  var reads = 0;

  Object.defineProperty(editor.pre, "innerText", {
    configurable: true,
    get: function () {
      reads += 1;
      return "JSON\n" + json;
    }
  });
  Object.defineProperty(editor.body, "innerText", {
    configurable: true,
    get: function () {
      reads += 1;
      return json;
    }
  });

  assert.equal(cleanCodeText(editor.pre), json);
  assert.ok(reads <= 4, "innerText reads must stay fixed; reads=" + reads);
});
