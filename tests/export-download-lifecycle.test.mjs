import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function createSaveHarness({ initial, status, earlyEvent } = {}) {
  const listeners = [];
  const revoked = [];
  const calls = [];
  const timers = new Map();
  let now = 0;
  let nextTimer = 0;
  const context = vm.createContext({
    Blob, console,
    URL: {
      createObjectURL: () => "blob:https://claude.ai/export-test",
      revokeObjectURL: (url) => revoked.push(url)
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage(message, callback) {
          calls.push(message);
          if (message.type === "CHATVAULT_SAVE_EXPORT") {
            if (earlyEvent) listeners.forEach((listener) => listener({ type: "CHATVAULT_DOWNLOAD_STATUS", downloadId: 42, ...earlyEvent }));
            callback({ ok: true, downloadId: 42, filename: "test.txt", state: "in_progress", ...initial });
          } else {
            callback({ ok: true, state: "in_progress", ...status });
          }
        }
      }
    }
  });
  vm.runInContext(readFileSync(new URL("../src/modules/export-errors.js", import.meta.url), "utf8"), context);
  const source = readFileSync(new URL("../src/modules/export/save.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/m, "")
    .replace(/^export /gm, "");
  vm.runInContext(source, context);
  return {
    revoked, calls,
    save: () => context.saveBlob(new Blob(["test"]), "test.txt"),
    async tick(ms) {
      for (let i = 0; i < 15; i++) await Promise.resolve();
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        for (let i = 0; i < 15; i++) await Promise.resolve();
      }
      now = end;
    }
  };
}

test("completed downloads immediately release their original Blob URL", async () => {
  const harness = createSaveHarness({ initial: { state: "complete" } });
  assert.equal((await harness.save()).ok, true);
  assert.deepEqual(harness.revoked, ["blob:https://claude.ai/export-test"]);
  await harness.tick(300000);
  assert.equal(harness.revoked.length, 1);
});

test("an early completion event settles the save and releases the Blob URL", async () => {
  const harness = createSaveHarness({ earlyEvent: { state: "complete", filename: "chosen.txt" } });
  const result = await harness.save();
  assert.equal(result.ok, true);
  assert.equal(result.filename, "chosen.txt");
  assert.equal(harness.revoked.length, 1);
});

test("lost completion events are recovered by querying download status", async () => {
  const harness = createSaveHarness({ status: { state: "complete", filename: "chosen.txt" } });
  const pending = harness.save();
  await Promise.resolve();
  await harness.tick(1000);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.filename, "chosen.txt");
  assert.equal(harness.calls[1].type, "CHATVAULT_GET_DOWNLOAD_STATUS");
  assert.equal(harness.revoked.length, 1);
});

test("cancelled and interrupted downloads never report success", async () => {
  for (const cancelled of [true, false]) {
    const harness = createSaveHarness({ status: { state: "interrupted", cancelled, error: cancelled ? "USER_CANCELED" : "DISK_FULL" } });
    const pending = harness.save();
    await Promise.resolve();
    await harness.tick(1000);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(Boolean(result.cancelled), cancelled);
    assert.equal(harness.revoked.length, 1);
  }
});

test("unconfirmed download timeout is a failure and eventually releases the original URL", async () => {
  const harness = createSaveHarness();
  const pending = harness.save();
  await Promise.resolve();
  await harness.tick(300000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "OPERATION_TIMEOUT");
  assert.equal(harness.revoked.length, 0);
  await harness.tick(30 * 60 * 1000);
  assert.deepEqual(harness.revoked, ["blob:https://claude.ai/export-test"]);
});
