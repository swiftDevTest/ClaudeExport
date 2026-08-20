import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import { createExportPlatformFetchers } from "../src/modules/export/platform-fetchers.js";
import { createExportMessageAdapter } from "../src/modules/export/message-adapter.js";

function read(relativePath) {
  return readFileSync(new URL("../" + relativePath, import.meta.url), "utf8");
}

function completePayload(answer = "Complete answer") {
  return {
    current_node: "assistant-node",
    mapping: {
      "root-node": {
        id: "root-node",
        parent: null,
        children: ["user-node"],
        message: null
      },
      "user-node": {
        id: "user-node",
        parent: "root-node",
        children: ["assistant-node"],
        message: {
          author: { role: "user" },
          content: { content_type: "text", parts: ["Question"] }
        }
      },
      "assistant-node": {
        id: "assistant-node",
        parent: "user-node",
        children: [],
        message: {
          author: { role: "assistant" },
          content: { content_type: "text", parts: [answer] }
        }
      }
    }
  };
}

function installChatGptDom(path = "/c/completeness-test") {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const dom = new JSDOM("<!doctype html><main></main>", { url: "https://chatgpt.com" + path });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  };
}

test("ChatGPT full export still uses cookie auth when session lookup fails", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  let authorization = "not-requested";
  globalThis.fetch = async (_url, options = {}) => {
    authorization = new Headers(options.headers || {}).get("authorization");
    return new Response(JSON.stringify(completePayload()), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { throw new Error("session endpoint unavailable"); },
      getChatConversationId() { return "completeness-test"; }
    });
    const messages = await fetchers.fetchChatGptConversationMessages({ platform: "chatgpt" });
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(authorization, null);
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("ChatGPT full export retries a transient conversation response", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 503 });
    return new Response(JSON.stringify(completePayload("Recovered answer")), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { return {}; },
      getChatConversationId() { return "completeness-test"; }
    });
    const messages = await fetchers.fetchChatGptConversationMessages({ platform: "chatgpt" });
    assert.equal(calls, 2);
    assert.match(JSON.stringify(messages), /Recovered answer/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("ChatGPT full export retries a transient network error", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(completePayload("Recovered after network failure")), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { return {}; },
      getChatConversationId() { return "completeness-test"; }
    });
    const messages = await fetchers.fetchChatGptConversationMessages({ platform: "chatgpt" });
    assert.equal(calls, 2);
    assert.match(JSON.stringify(messages), /Recovered after network failure/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("ChatGPT full export does not retry an oversized response", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 * 1024 + 1)
      }
    });
  };

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { return {}; },
      getChatConversationId() { return "completeness-test"; }
    });
    await assert.rejects(
      fetchers.fetchChatGptConversationMessages({ platform: "chatgpt" }),
      /too much data/i
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("ChatGPT full export does not retry malformed JSON", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{not-valid-json", {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { return {}; },
      getChatConversationId() { return "completeness-test"; }
    });
    await assert.rejects(
      fetchers.fetchChatGptConversationMessages({ platform: "chatgpt" }),
      /json|unexpected|property name/i
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("ChatGPT full export cancellation aborts immediately without retrying", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options = {}) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      if (options.signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { return {}; },
      getChatConversationId() { return "completeness-test"; }
    });
    const controller = new AbortController();
    const request = fetchers.fetchChatGptConversationMessages(
      { platform: "chatgpt" },
      { signal: controller.signal }
    );
    controller.abort();
    await assert.rejects(request, (error) => error?.name === "AbortError");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("ChatGPT full export retries with cookies when a cached bearer token is stale", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  const authorizations = [];
  globalThis.fetch = async (_url, options = {}) => {
    const authorization = new Headers(options.headers || {}).get("authorization");
    authorizations.push(authorization);
    if (authorization) return new Response("expired", { status: 401 });
    return new Response(JSON.stringify(completePayload("Cookie retry answer")), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { return { accessToken: "stale-token" }; },
      getChatConversationId() { return "completeness-test"; }
    });
    const messages = await fetchers.fetchChatGptConversationMessages({ platform: "chatgpt" });
    assert.deepEqual(authorizations, ["Bearer stale-token", null]);
    assert.match(JSON.stringify(messages), /Cookie retry answer/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("ChatGPT full export rejects a conversation path with a missing ancestor", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    current_node: "tail-node",
    mapping: {
      "tail-node": {
        id: "tail-node",
        parent: "missing-parent",
        children: [],
        message: {
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Only the tail was returned"] }
        }
      }
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { return {}; },
      getChatConversationId() { return "completeness-test"; }
    });
    await assert.rejects(
      fetchers.fetchChatGptConversationMessages({ platform: "chatgpt" }),
      /incomplete conversation path/i
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("an entirely unknown ChatGPT turn is reported as a blocking completeness risk", async () => {
  const restoreDom = installChatGptDom();
  const previousFetch = globalThis.fetch;
  const payload = completePayload();
  payload.mapping["assistant-node"].message.content = {
    content_type: "multimodal_text",
    parts: [{ content_type: "future_visible_answer", payload: { value: "New answer shape" } }]
  };
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

  try {
    const fetchers = createExportPlatformFetchers({
      ensureCanReadChatBody() {},
      async getChatGptWebSession() { return {}; },
      getChatConversationId() { return "completeness-test"; }
    });
    const messages = await fetchers.fetchChatGptConversationMessages({ platform: "chatgpt" });
    const risk = fetchers.detectApiCompletenessRisk(messages);
    assert.equal(risk.needsFallback, true);
    assert.ok(risk.reasons.includes("unknown_content_type"));
    assert.ok(risk.reasons.includes("missing_assistant_role"));
  } finally {
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("content export recognizes Custom GPT chat URLs and forbids implicit page fallback", () => {
  const source = read("src/content.js");
  const idStart = source.indexOf("function getPlatformChatIdFromUrl(");
  const idEnd = source.indexOf("\n  function getChatPlatform", idStart);
  const idSource = source.slice(idStart, idEnd);
  const context = {
    URL,
    window: { location: { origin: "https://chatgpt.com" } }
  };
  vm.runInNewContext(`${idSource}\nthis.getId = getPlatformChatIdFromUrl;`, context);

  assert.equal(context.getId("https://chatgpt.com/c/standard-id", "chatgpt"), "standard-id");
  assert.equal(context.getId("https://chatgpt.com/g/g-custom-assistant/c/custom-id", "chatgpt"), "custom-id");

  const fetchStart = source.indexOf("async function fetchConversationMessagesForExport(");
  const fetchEnd = source.indexOf("\n  async function getCurrentConversationMessagesForExport", fetchStart);
  const fetchSource = source.slice(fetchStart, fetchEnd);
  assert.match(fetchSource, /options\.allowPageFallback === true/);
  assert.match(fetchSource, /createFullConversationUnavailableError\(error, platform\)/);
  assert.doesNotMatch(fetchSource, /falling back to current page messages/);
  assert.match(source, /completeError\.code = "FULL_CONVERSATION_UNAVAILABLE"/);

  const performStart = source.indexOf("async function performExport(options = {})");
  const performEnd = source.indexOf("\n  \/\/ 取消或关闭导出提示罩", performStart);
  const performSource = source.slice(performStart, performEnd);
  assert.match(performSource, /export stopped to prevent an incomplete file/);
  assert.doesNotMatch(performSource, /using parsed page messages/);
});

test("ChatGPT missing-role-only risk remains exportable after path validation", () => {
  const source = read("src/content.js");
  const helperStart = source.indexOf("function getBlockingConversationRiskReasons(");
  const helperEnd = source.indexOf("\n  async function fetchConversationMessagesForExport", helperStart);
  const helperSource = source.slice(helperStart, helperEnd);
  const context = {};
  vm.runInNewContext(`${helperSource}\nthis.getReasons = getBlockingConversationRiskReasons;`, context);

  assert.deepEqual(
    Array.from(context.getReasons({ reasons: ["missing_assistant_role"] }, "chatgpt")),
    []
  );
  assert.deepEqual(
    Array.from(context.getReasons({ reasons: ["missing_user_role"] }, "chatgpt")),
    []
  );
  assert.deepEqual(
    Array.from(context.getReasons({ reasons: ["missing_assistant_role", "unknown_content_type"] }, "chatgpt")),
    ["missing_assistant_role", "unknown_content_type"]
  );
  assert.deepEqual(
    Array.from(context.getReasons({ reasons: ["missing_assistant_role"] }, "claude")),
    ["missing_assistant_role"]
  );
});

test("ChatGPT full-conversation requests use the expanded bounded envelope", () => {
  const source = read("src/modules/export/platform-fetchers.js");
  assert.match(source, /CHATGPT_CONVERSATION_REQUEST_TIMEOUT_MS = 60000/);
  assert.match(source, /CHATGPT_CONVERSATION_RESPONSE_MAX_BYTES = 64 \* 1024 \* 1024/);
  assert.match(source, /CHATGPT_CONVERSATION_FETCH_ATTEMPTS = 2/);
});

test("shared adapters reject Claude and Gemini API failures unless visible-page mode is explicit", async () => {
  const pageMessages = [
    { role: "user", contentBlocks: [{ type: "paragraph", text: "Visible question" }] },
    { role: "assistant", contentBlocks: [{ type: "paragraph", text: "Visible answer" }] }
  ];

  for (const platform of ["claude", "gemini"]) {
    const adapter = createExportMessageAdapter({
      getCurrentPlatformId() { return platform; },
      getChatPlatform(chat) { return chat.platform; },
      getChatConversationId(chat) { return chat.id; },
      isCurrentConversation() { return true; },
      getExportService() {
        return { parseMessages() { return pageMessages; } };
      },
      cloneExportMessages(messages) {
        return JSON.parse(JSON.stringify(messages));
      },
      async fetchClaudeConversationMessages() {
        throw new Error("Claude API unavailable");
      },
      async fetchGeminiConversationMessages() {
        throw new Error("Gemini API unavailable");
      }
    });
    const chat = { id: `${platform}-conversation`, platform };

    await assert.rejects(
      adapter.fetchConversationMessagesForExport(chat),
      new RegExp(`${platform} API unavailable`, "i")
    );
    const explicitPageMessages = await adapter.fetchConversationMessagesForExport(chat, {
      allowPageFallback: true
    });
    assert.deepEqual(explicitPageMessages, pageMessages);
  }
});
