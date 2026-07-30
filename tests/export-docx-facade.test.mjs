import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("buildDocxBlob has one lazy facade and forwards cancellation options", async () => {
  const source = readText("../src/modules/export.js");
  const definitions = source.match(/\bbuildDocxBlob:\s*function\b/g) || [];
  const facadeStart = source.indexOf("buildDocxBlob: function");
  const facadeEnd = source.indexOf("\n    },", facadeStart);
  const facadeSource = source.slice(facadeStart, facadeEnd);

  assert.equal(definitions.length, 1);
  assert.match(facadeSource, /ensureModules\(\)\.then/);
  assert.match(facadeSource, /buildDocxBlob\(messages, metadata, settings, options\)/);

  globalThis.window = {
    location: {
      hostname: "claude.ai",
      pathname: "/chat/test"
    }
  };
  await import(`../src/modules/export.js?docx-facade=${Date.now()}`);
  await globalThis.CHATVAULT_EXPORT_READY;

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    globalThis.CHATVAULT_EXPORT.buildDocxBlob(
      [],
      { title: "Test", platform: "claude", exportedAt: new Date().toISOString() },
      {},
      { signal: controller.signal }
    ),
    (error) => error?.name === "AbortError"
  );
});

test("core sync normalizes the facade instead of restoring the duplicate", () => {
  const syncSource = readText("../scripts/sync-core.mjs");

  assert.match(syncSource, /function normalizeExportFacade\(\)/);
  assert.match(syncSource, /Expected one buildDocxBlob facade after sync/);
  assert.match(syncSource, /normalizeExportFacade\(\);/);
  assert.match(syncSource, /_mods\.docx\.buildDocxBlob\(messages, metadata, settings, options\)/);
});
