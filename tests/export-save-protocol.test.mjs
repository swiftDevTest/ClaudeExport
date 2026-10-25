import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const backgroundSource = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const saveSource = readFileSync(new URL("../src/modules/export/save.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/m, "").replace(/^export /gm, "");
function backgroundFunction(name) {
  const start = backgroundSource.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const next = backgroundSource.slice(start + 1).search(/\n  (?:async )?function /);
  return backgroundSource.slice(start, start + 1 + next);
}
const backendFunctions = ["sanitizeDownloadPathSegment", "sanitizeDownloadFilename", "isTrustedExportBlobUrl", "downloadItemToResponse", "getDownloadStatus", "getExportSaveOwner", "getExportSaveRequestStatus", "startExportSaveRequest"]
  .map(backgroundFunction).join("\n");
const routeStart = backgroundSource.indexOf("  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {");
const routeEnd = backgroundSource.indexOf("\n  // Top-level downloads listener", routeStart);
const eventEnd = backgroundSource.indexOf("\n  // Clean up stale download mappings", routeEnd);

function createHarness({ loseAcknowledgement = false } = {}) {
  const records = {};
  const downloads = new Map();
  const listeners = [];
  const revoked = [];
  const calls = [];
  const timers = new Map();
  const sender = { id: "extension-id", url: "https://claude.ai/chat/test", tab: { id: 7 }, documentId: "document-1" };
  let now = 0;
  let nextTimer = 0;
  let nativeCallback;
  let backendListener;
  let downloadListener;
  const backendChrome = {
    runtime: { id: "extension-id", lastError: null, onMessage: { addListener: (fn) => { backendListener = fn; } } },
    storage: { local: {
      get(key, callback) { callback({ [key]: records[key] }); },
      set(items, callback) { Object.assign(records, structuredClone(items)); callback?.(); },
      remove(key) { delete records[key]; }
    } },
    downloads: {
      download(options, callback) { calls.push({ type: "native-download", ...options }); nativeCallback = callback; },
      search({ id }, callback) { callback(downloads.has(id) ? [downloads.get(id)] : []); },
      onChanged: { addListener: (fn) => { downloadListener = fn; } }
    },
    tabs: { sendMessage(_tabId, message, callback) { listeners.forEach((fn) => fn(message)); callback?.(); } }
  };
  function startBackend() {
    const context = vm.createContext({
      chrome: backendChrome, URL, console, PRODUCT_SHORT_NAME: "Claude Export",
      TRUSTED_CONTENT_HOSTS: new Set(["claude.ai"]), rejectUntrustedSender: () => false
    });
    vm.runInContext(backendFunctions + "\n" + backgroundSource.slice(routeStart, eventEnd), context);
  }
  startBackend();
  const front = vm.createContext({
    Blob, console, Math,
    Date: class extends Date { static now() { return now; } },
    URL: { createObjectURL: () => "blob:https://claude.ai/protocol-test", revokeObjectURL: (url) => revoked.push(url) },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime: {
      lastError: null, onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage(message, callback) {
        calls.push(message);
        backendListener(message, sender, (response) => {
          if (!(loseAcknowledgement && message.type === "CHATVAULT_SAVE_EXPORT")) callback(response);
        });
      }
    } }
  });
  vm.runInContext(readFileSync(new URL("../src/modules/export-errors.js", import.meta.url), "utf8"), front);
  vm.runInContext(saveSource, front);
  async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
  return {
    records, revoked, calls, restartBackend: startBackend,
    save: () => front.saveBlob(new Blob(["export"]), "test.txt"),
    choose(state = "in_progress") {
      downloads.set(42, { id: 42, state, filename: "test.txt" });
      nativeCallback(42);
    },
    cancel() {
      backendChrome.runtime.lastError = { message: "USER_CANCELED" };
      nativeCallback(undefined);
      backendChrome.runtime.lastError = null;
    },
    complete({ event = true } = {}) {
      downloads.set(42, { id: 42, state: "complete", filename: "test.txt" });
      if (event) downloadListener({ id: 42, state: { current: "complete" } });
    },
    query(requestId, owner = sender) {
      return new Promise((resolve) => backendListener({ type: "CHATVAULT_GET_EXPORT_SAVE_STATUS", requestId }, owner, resolve));
    },
    async tick(ms) {
      await flush();
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

test("native file selection lasting over 30 seconds keeps one live save and Blob", async () => {
  const h = createHarness();
  let settled = false;
  const pending = h.save().then((result) => { settled = true; return result; });
  await h.tick(120000);
  assert.equal(settled, false);
  assert.equal(h.revoked.length, 0);
  assert.equal(h.calls.filter((c) => c.type === "native-download").length, 1);
  h.choose();
  await h.tick(1000);
  h.complete();
  assert.equal((await pending).ok, true);
  assert.deepEqual(h.revoked, ["blob:https://claude.ai/protocol-test"]);
});

test("cancelling a long-lived native file chooser releases the original Blob exactly once", async () => {
  const h = createHarness();
  const pending = h.save();
  await h.tick(90000);
  h.cancel();
  await h.tick(1000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(h.revoked.length, 1);
  await h.tick(30 * 60 * 1000);
  assert.equal(h.revoked.length, 1);
});

test("a lost save acknowledgement is reconciled without a second download", async () => {
  const h = createHarness({ loseAcknowledgement: true });
  const pending = h.save();
  await h.tick(40000);
  assert.equal(h.revoked.length, 0);
  h.choose("complete");
  await h.tick(1000);
  assert.equal((await pending).ok, true);
  assert.equal(h.calls.filter((c) => c.type === "native-download").length, 1);
  assert.equal(h.revoked.length, 1);
});

test("persisted save requests survive backend reinitialization and missing completion events", async () => {
  const h = createHarness();
  const pending = h.save();
  await h.tick(1000);
  h.choose();
  h.restartBackend();
  h.complete({ event: false });
  await h.tick(2000);
  assert.equal((await pending).ok, true);
  assert.equal(h.revoked.length, 1);
});

test("download timeout keeps the Blob until a late terminal event", async () => {
  const h = createHarness();
  const pending = h.save();
  await h.tick(0);
  h.choose();
  await h.tick(1000 + 5 * 60 * 1000);
  assert.equal((await pending).error_code, "OPERATION_TIMEOUT");
  assert.equal(h.revoked.length, 0);
  h.complete();
  assert.equal(h.revoked.length, 1);
});

test("save status is restricted to its originating document", async () => {
  const h = createHarness();
  const pending = h.save();
  await h.tick(0);
  const requestId = h.calls.find((c) => c.type === "CHATVAULT_SAVE_EXPORT").requestId;
  const forbidden = await h.query(requestId, { tab: { id: 8 }, documentId: "document-1" });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.filename, undefined);
  assert.equal((await h.query(requestId)).state, "pending");
  h.cancel();
  await h.tick(1000);
  await pending;
});
