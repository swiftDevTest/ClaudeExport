import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
function extractFunction(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0);
  const next = source.slice(start + 1).search(/\n  (?:async )?function /);
  return source.slice(start, start + 1 + next);
}

function installTaskFunctions(context) {
  Object.assign(context, { activeNotionJobId: "", activeObsidianSingleSync: false });
  vm.runInNewContext(extractFunction("hasActiveExportTask") + "\n" + extractFunction("acquireExportTaskController"), context);
}

test("navigation during conversation fetching cannot export mixed conversation data", async () => {
  const chat = { id: "original", url: "https://claude.ai/chat/original" };
  const context = {
    getCurrentConversationForExport: () => chat,
    isCurrentConversation: () => false,
    fetchConversationMessagesForExport: async () => [{ role: "assistant", contentBlocks: [{ text: "Original answer" }] }],
    isChineseUi: () => false
  };
  vm.runInNewContext(extractFunction("getCurrentConversationMessagesForExport"), context);
  await assert.rejects(context.getCurrentConversationMessagesForExport([]), /Conversation changed/);
});

test("navigation before fetching is rejected without issuing a request", async () => {
  let requests = 0;
  const context = {
    window: { location: { href: "https://claude.ai/chat/next" } },
    sanitizeSourceUrl: (url) => url,
    getCurrentConversationForExport: () => ({ id: "next" }),
    fetchConversationMessagesForExport: async () => { requests++; return []; },
    isChineseUi: () => false
  };
  vm.runInNewContext(extractFunction("getCurrentConversationMessagesForExport"), context);
  await assert.rejects(context.getCurrentConversationMessagesForExport([], { sourceUrl: "https://claude.ai/chat/original" }), /Conversation changed/);
  assert.equal(requests, 0);
});

test("a stable conversation preserves the fetched result", async () => {
  const messages = [{ role: "assistant", contentBlocks: [{ text: "Stable answer" }] }];
  const context = {
    getCurrentConversationForExport: () => ({ id: "stable" }),
    isCurrentConversation: () => true,
    fetchConversationMessagesForExport: async () => messages
  };
  vm.runInNewContext(extractFunction("getCurrentConversationMessagesForExport"), context);
  assert.equal(await context.getCurrentConversationMessagesForExport([]), messages);
});

test("single export requests cannot overwrite an active batch controller", async () => {
  for (const globalFlag of [true, false]) {
    const controller = { batch: true };
    const toasts = [];
    const context = {
      CHATVAULT_IS_BATCH_EXPORT: globalFlag,
      batchExportAbortController: controller,
      abortController: controller,
      showPageToast: (text) => toasts.push(text),
      tx: (_key, fallback) => fallback
    };
    installTaskFunctions(context);
    vm.runInNewContext(extractFunction("performExport"), context);
    await context.performExport();
    assert.equal(context.abortController, controller);
    assert.equal(toasts.length, 1);
  }
});

test("rapid export clicks share one controller and a settings failure releases the lock", async () => {
  let failSettings;
  const toasts = [];
  const context = {
    CHATVAULT_IS_BATCH_EXPORT: false,
    batchExportAbortController: null,
    abortController: null,
    activeFormat: "pdf",
    AbortController,
    exporter: { detectPlatform: () => "claude", getConversationTitle: () => "Original" },
    window: { location: { href: "https://claude.ai/chat/original" } },
    sanitizeSourceUrl: (url) => url,
    loadPersistedExportSettings: () => new Promise((_resolve, reject) => { failSettings = reject; }),
    showPageToast: (text) => toasts.push(text),
    hideExportProgress() {},
    tx: (_key, fallback) => fallback
  };
  installTaskFunctions(context);
  vm.runInNewContext(extractFunction("performExport"), context);
  const first = context.performExport();
  const controller = context.abortController;
  await context.performExport();
  assert.equal(context.abortController, controller);
  assert.equal(toasts.length, 1);
  failSettings(new Error("Settings unavailable"));
  await assert.rejects(first, /Settings unavailable/);
  assert.equal(context.abortController, null);
});
