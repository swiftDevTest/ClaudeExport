import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createExportPlatformFetchers } from "../src/modules/export/platform-fetchers.js";

const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
function extract(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  const tail = source.slice(start + 1);
  const next = tail.search(/\n  (?:async )?function /);
  return source.slice(start, start + 1 + (next >= 0 ? next : tail.indexOf("\n  // 执行初始化")));
}
function install(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}
function text(messages) {
  return messages.map((m) => m.contentBlocks.map((b) => b.text).join(" "));
}
const rootId = "00000000-0000-4000-8000-000000000000";
function tree(leaf = "a2") {
  return { current_leaf_message_uuid: leaf, chat_messages: [
    { uuid: "a2", parent_message_uuid: "u", sender: "assistant", text: "Current answer" },
    { uuid: "u", parent_message_uuid: rootId, sender: "human", text: "Question" },
    { uuid: "a1", parent_message_uuid: "u", sender: "assistant", text: "Old answer" }
  ] };
}
function fetchHarness(t, fetch) {
  install(t, "window", { location: new URL("https://claude.ai/chat/test") });
  install(t, "fetch", fetch);
  return createExportPlatformFetchers({ ensureCanReadChatBody() {}, getChatConversationId: (chat) => chat.id });
}

test("Claude selects the requested branch and restores parent order, including older selections", () => {
  const f = createExportPlatformFetchers();
  assert.deepEqual(text(f.parseClaudeConversationPayload(tree())), ["Question", "Current answer"]);
  assert.deepEqual(text(f.parseClaudeConversationPayload({ conversation: tree("a1") })), ["Question", "Old answer"]);
  const linear = tree();
  delete linear.current_leaf_message_uuid;
  linear.chat_messages = linear.chat_messages.filter((m) => m.uuid !== "a1");
  assert.deepEqual(text(f.parseClaudeConversationPayload(linear)), ["Question", "Current answer"]);
});

test("ambiguous, cyclic, duplicate and incomplete Claude branches fail before rendering", () => {
  const f = createExportPlatformFetchers();
  const cases = [
    { ...tree(), current_leaf_message_uuid: "missing" },
    { ...tree(), current_leaf_message_uuid: "" },
    { ...tree(), chat_messages: tree().chat_messages.filter((m) => m.uuid !== "u") },
    { ...tree(), chat_messages: tree().chat_messages.concat(tree().chat_messages[0]) },
    { ...tree(), chat_messages: tree().chat_messages.map((m) => ({ ...m, parent_message_uuid: m.uuid })) },
    { ...tree(), chat_messages: tree().chat_messages.map(({ parent_message_uuid, ...m }) => m) }
  ];
  for (const payload of cases) assert.throws(() => f.parseClaudeConversationPayload(payload), { code: "CONVERSATION_COMPLETENESS_RISK" });
});

test("Claude tree fallback exports only the current branch", async (t) => {
  const urls = [];
  const f = fetchHarness(t, async (url) => {
    urls.push(url);
    if (url.endsWith("/api/organizations")) return Response.json([{ uuid: "org" }]);
    return url.endsWith("?tree=true") ? Response.json(tree()) : new Response("", { status: 503 });
  });
  assert.deepEqual(text(await f.fetchClaudeConversationMessages({ id: "test" })), ["Question", "Current answer"]);
  assert.equal(urls.length, 3);
});

test("a tree endpoint without branch identity cannot silently export its whole response", async (t) => {
  const f = fetchHarness(t, async (url) => {
    if (url.endsWith("/api/organizations")) return Response.json([{ uuid: "org" }]);
    return url.endsWith("?tree=true")
      ? Response.json({ chat_messages: [{ sender: "human", text: "Question" }, { sender: "assistant", text: "Unverified answer" }] })
      : new Response("", { status: 503 });
  });
  await assert.rejects(f.fetchClaudeConversationMessages({ id: "test" }), { code: "CONVERSATION_COMPLETENESS_RISK" });
});

test("Claude finds a conversation in a non-first organization without active flags", async (t) => {
  const urls = [];
  const f = fetchHarness(t, async (url) => {
    urls.push(url);
    if (url.endsWith("/api/organizations")) return Response.json([{ uuid: "personal" }, { uuid: "team" }]);
    return url.includes("/team/") ? Response.json(tree()) : new Response("", { status: 404 });
  });
  assert.deepEqual(text(await f.fetchClaudeConversationMessages({ id: "test" })), ["Question", "Current answer"]);
  assert.equal(urls.length, 3);
  assert.ok(urls[2].includes("/team/"));
});

test("Claude prioritizes a current organization hint and bounds organization recovery", async (t) => {
  const urls = [];
  const f = fetchHarness(t, async (url) => {
    urls.push(url);
    if (url.endsWith("/api/organizations")) return Response.json(Array.from({ length: 10 }, (_, i) => ({ uuid: `org${i}`, active: i === 0 })));
    return new Response("", { status: 404 });
  });
  install(t, "document", { cookie: "other=value; lastActiveOrg=org9" });
  await assert.rejects(f.fetchClaudeConversationMessages({ id: "test" }), /404/);
  assert.ok(urls[1].includes("/org9/"));
  assert.equal(urls.length, 6);
  urls.length = 0;
  await assert.rejects(f.fetchClaudeConversationMessages({ id: "test", organizationId: "org8" }), /404/);
  assert.ok(urls[1].includes("/org8/"));
});

test("Claude does not search other organizations for authentication, rate limit or outage failures", async (t) => {
  let status = 401;
  const urls = [];
  const f = fetchHarness(t, async (url) => {
    urls.push(url);
    return url.endsWith("/api/organizations") ? Response.json([{ uuid: "one" }, { uuid: "two" }]) : new Response("", { status });
  });
  for (status of [401, 429, 503]) {
    urls.length = 0;
    await assert.rejects(f.fetchClaudeConversationMessages({ id: "test" }), new RegExp(String(status)));
    assert.equal(urls.some((url) => url.includes("/two/")), false);
    assert.equal(urls.length, status === 503 ? 3 : 2);
  }
});

test("cancellation prevents the next organization lookup", async (t) => {
  const controller = new AbortController();
  const urls = [];
  const f = fetchHarness(t, async (url) => {
    urls.push(url);
    if (url.endsWith("/api/organizations")) return Response.json([{ uuid: "one" }, { uuid: "two" }]);
    controller.abort();
    return new Response("", { status: 404 });
  });
  await assert.rejects(f.fetchClaudeConversationMessages({ id: "test" }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(urls.length, 2);
});

test("valid single-role Claude responses export, while an unparsed reply remains blocking", async () => {
  const f = createExportPlatformFetchers();
  const context = {
    getChatPlatform: () => "claude", getCurrentPageMessagesForChat: () => [],
    getExportPlatformFetchers: async () => f, isCurrentConversation: () => false,
    cloneExportMessages: structuredClone, createFullConversationUnavailableError: (e) => e
  };
  vm.runInNewContext(extract("getBlockingConversationRiskReasons") + "\n" + extract("fetchConversationMessagesForExport"), context);
  for (const sender of ["human", "assistant"]) {
    f.fetchClaudeConversationMessages = async () => f.parseClaudeConversationPayload({ chat_messages: [{ sender, text: "A complete single turn" }] });
    assert.equal((await context.fetchConversationMessagesForExport({ id: "test" })).length, 1);
  }
  f.fetchClaudeConversationMessages = async () => f.parseClaudeConversationPayload({ chat_messages: [
    { sender: "human", text: "Question" }, { sender: "assistant", content: [{ type: "unknown_reply", payload: {} }] }
  ] });
  await assert.rejects(context.fetchConversationMessagesForExport({ id: "test" }), /unparsed_message/);
});

function taskContext(overrides = {}) {
  const context = {
    AbortController, DOMException, CHATVAULT_IS_BATCH_EXPORT: false,
    abortController: null, batchExportAbortController: null, activeNotionJobId: "", activeObsidianSingleSync: false,
    tx: (_key, fallback) => fallback, ...overrides
  };
  vm.runInNewContext(extract("hasActiveExportTask") + "\n" + extract("acquireExportTaskController"), context);
  return context;
}

test("every batch mode refuses an existing single task before changing state", async () => {
  for (const batchMode of ["local", "notion", "obsidian"]) {
    const original = new AbortController();
    let toastCount = 0;
    const context = taskContext({ abortController: original, batchMode, showPageToast: () => toastCount++ });
    vm.runInNewContext(extract("startInPageBatchExport"), context);
    await context.startInPageBatchExport();
    assert.equal(context.abortController, original);
    assert.equal(context.batchExportAbortController, null);
    assert.equal(toastCount, 1);
  }
});

test("popup sync entrypoints refuse an active export or background Notion job", async () => {
  for (const type of ["CHATVAULT_POPUP_NOTION_SYNC", "CHATVAULT_POPUP_OBSIDIAN_SYNC"]) {
    let listener;
    const original = new AbortController();
    const context = taskContext({
      abortController: original, runtimeMessageListenerAttached: false, FREE_QUOTA_EXHAUSTED_MESSAGE: "quota",
      chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } }
    });
    vm.runInNewContext(extract("listenMessages"), context);
    context.listenMessages();
    const response = await new Promise((resolve) => listener({ type }, {}, resolve));
    assert.equal(response.ok, false);
    assert.match(response.error, /already running/);
    assert.equal(context.abortController, original);
  }
  const context = taskContext({ activeNotionJobId: "background-job" });
  assert.throws(() => context.acquireExportTaskController(), /already running/);
});

test("popup sync reserves its controller before preflight and frees it when preflight fails", async () => {
  for (const type of ["CHATVAULT_POPUP_NOTION_SYNC", "CHATVAULT_POPUP_OBSIDIAN_SYNC"]) {
    let listener;
    let rejectPreflight;
    const context = taskContext({
      runtimeMessageListenerAttached: false, FREE_QUOTA_EXHAUSTED_MESSAGE: "quota",
      chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
      waitForContextExportReady: () => new Promise((_resolve, reject) => { rejectPreflight = reject; }),
      prepareSingleObsidianSync: () => new Promise((_resolve, reject) => { rejectPreflight = reject; }),
      renderExportProgress() {}, hideExportProgress() {}, showPageToast() {}, cancelExport() {}
    });
    vm.runInNewContext(extract("listenMessages"), context);
    context.listenMessages();
    const first = new Promise((resolve) => listener({ type }, {}, resolve));
    const original = context.abortController;
    assert.ok(original);
    const second = await new Promise((resolve) => listener({ type }, {}, resolve));
    assert.equal(second.ok, false);
    assert.equal(context.abortController, original);
    rejectPreflight(new Error("Preflight failed"));
    const result = await first;
    assert.equal(result.ok, type === "CHATVAULT_POPUP_OBSIDIAN_SYNC");
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assert.equal(context.abortController, null);
  }
});

test("a batch preflight keeps one controller through handoff and releases it after failure", async () => {
  let fail;
  let handedOff;
  const context = taskContext({
    batchMode: "local", batchList: [{ id: "one" }], batchActiveItems: [], isProUser: true,
    batchSelectedFormat: "pdf", batchSelectedTheme: "natural",
    shadowRoot: {
      querySelectorAll: () => [{ getAttribute: () => "0" }],
      getElementById: () => ({ checked: true })
    },
    showPageToast() {}, setBatchExportingUi() {}, updateBatchExportProgress() {}, closeBatchModal() {},
    updateBatchSelectedCount() {}, hideExportProgress() {}, canUseBatchExportLocally: () => true,
    loadState: async () => {},
    runInPageBatchExport: async (_items, _format, _settings, controller) => {
      handedOff = controller;
      await new Promise((_resolve, reject) => { fail = reject; });
    }, friendlyExportError: (e) => e.message
  });
  vm.runInNewContext(extract("startInPageBatchExport"), context);
  const pending = context.startInPageBatchExport();
  const original = context.abortController;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(handedOff, original);
  assert.throws(() => context.acquireExportTaskController(), /already running/);
  fail(new Error("Batch initialization failed"));
  await pending;
  assert.equal(context.abortController, null);
  assert.equal(context.batchExportAbortController, null);
  assert.equal(context.CHATVAULT_IS_BATCH_EXPORT, false);
});
