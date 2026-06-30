import test from "node:test";
import assert from "node:assert/strict";

test("export save uses Blob URLs whenever the browser supports them", async () => {
  const originalChrome = globalThis.chrome;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
  const calls = [];

  globalThis.URL.createObjectURL = () => "blob:https://chatgpt.com/small-export-blob-id";
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        calls.push(message);
        callback({ ok: true, filename: message.filename });
      }
    }
  };

  try {
    const { saveBlob } = await import("../src/modules/export/save.js");
    const result = await saveBlob(new Blob(["small export"], { type: "text/plain" }), "Folder/Export.txt", {
      saveAs: false
    });

    assert.deepEqual(result, { ok: true, filename: "Folder/Export.txt" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "CHATVAULT_SAVE_EXPORT");
    assert.equal(calls[0].filename, "Folder/Export.txt");
    assert.equal(calls[0].saveAs, false);
    assert.equal(calls[0].dataUrl, "");
    assert.equal(calls[0].blobUrl, "blob:https://chatgpt.com/small-export-blob-id");
  } finally {
    if (originalCreateObjectURL === undefined) {
      delete globalThis.URL.createObjectURL;
    } else {
      globalThis.URL.createObjectURL = originalCreateObjectURL;
    }
    if (originalRevokeObjectURL === undefined) {
      delete globalThis.URL.revokeObjectURL;
    } else {
      globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    }
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});

test("export save rejects large data URL fallback when Blob URLs are unavailable", async () => {
  const originalChrome = globalThis.chrome;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
  const calls = [];

  globalThis.URL.createObjectURL = undefined;
  globalThis.URL.revokeObjectURL = undefined;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        calls.push(message);
        callback({ ok: true, filename: message.filename });
      }
    }
  };

  try {
    const { MAX_EXPORT_SAVE_BYTES, saveBlob } = await import("../src/modules/export/save.js");
    const result = await saveBlob(new Blob(["x".repeat(MAX_EXPORT_SAVE_BYTES + 1)], { type: "text/plain" }), "Large.txt");

    assert.equal(result.ok, false);
    assert.match(result.error, /too large for the Chrome message bridge/);
    assert.equal(calls.length, 0);
  } finally {
    if (originalCreateObjectURL === undefined) {
      delete globalThis.URL.createObjectURL;
    } else {
      globalThis.URL.createObjectURL = originalCreateObjectURL;
    }
    if (originalRevokeObjectURL === undefined) {
      delete globalThis.URL.revokeObjectURL;
    } else {
      globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    }
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});
