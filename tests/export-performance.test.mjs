import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.chrome = globalThis.chrome || {
  i18n: {
    getMessage() { return ""; },
    getUILanguage() { return "en"; }
  }
};

const {
  getAdaptiveImageExportProfile,
  getFittedCanvasScale
} = await import("../src/modules/export/utils.js");
const { getImagePreloadConcurrency } = await import("../src/modules/export/media.js");
const { createPdfFromJpegs, getPdfRenderProfile } = await import("../src/modules/export/builders/pdf.js");
const { createExportDocument } = await import("../src/modules/export/document.js");
const { resolveMessages } = await import("../src/modules/export/platform.js");

test("normalized export documents retain flattened blocks and portable generated-file links", () => {
  const source = "sandbox:/mnt/data/Performance_Report.md";
  const href = "https://chatgpt.com/backend-api/files/file-performance/download";
  const resolved = resolveMessages({
    platform: "chatgpt",
    title: "Performance regression",
    messages: [{
      role: "assistant",
      contentBlocks: [{
        type: "paragraph",
        text: "Performance Report",
        generatedFile: { name: "Performance_Report.md", source, href },
        segments: [{ text: "Performance Report", href: source }]
      }]
    }],
    settings: {}
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.document._normalized, true);
  assert.equal(resolved.document.contentBlocks.length, 1);
  assert.equal(resolved.messages[0].contentBlocks[0].segments[0].href, href);

  const platformSource = readFileSync(new URL("../src/modules/export/platform.js", import.meta.url), "utf8");
  assert.match(platformSource, /createExportDocument\(\{\s*[\s\S]*?_normalized:\s*true,/);
});

test("normalized fast path preserves role, style, and message-index normalization", () => {
  const resolved = resolveMessages({
    platform: "chatgpt",
    messages: [{
      role: "tool",
      htmlStyle: {
        color: "#123456",
        "background-image": "url(javascript:alert(1))"
      },
      contentBlocks: [{ type: "paragraph", text: "Tool output" }]
    }, {
      role: "user",
      contentBlocks: [{ type: "paragraph", text: "Follow-up" }]
    }],
    settings: {}
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.messages[0].role, "assistant");
  assert.equal(resolved.messages[0].index, 0);
  assert.deepEqual(resolved.messages[0].htmlStyle, { color: "#123456" });
  assert.equal(resolved.messages[1].role, "user");
  assert.equal(resolved.messages[1].index, 1);
});

test("normalized documents rebuild a consistent flat block view", () => {
  const source = "sandbox:/mnt/data/current.md";
  const href = "https://chatgpt.com/backend-api/files/current/download";
  const document = createExportDocument({
    _normalized: true,
    messages: [{
      role: "assistant",
      contentBlocks: [{
        type: "paragraph",
        text: "Current",
        generatedFile: { name: "current.md", source, href },
        segments: [{ text: "Current", href: source }]
      }]
    }],
    contentBlocks: [{ type: "paragraph", text: "Stale" }]
  });

  assert.equal(document.contentBlocks.length, 1);
  assert.equal(document.contentBlocks[0].text, "Current");
  assert.equal(document.contentBlocks[0].segments[0].href, href);
});

test("image export profile lowers scale and pixel budget on constrained devices", () => {
  assert.deepEqual(getAdaptiveImageExportProfile(4), {
    preferredScale: 2.5,
    maxCanvasPixels: 36 * 1000 * 1000
  });
  assert.deepEqual(getAdaptiveImageExportProfile(8), {
    preferredScale: 3,
    maxCanvasPixels: 48 * 1000 * 1000
  });
  assert.equal(getAdaptiveImageExportProfile(16).preferredScale, 4);
  assert.equal(getFittedCanvasScale(1080, 10000, 4, 1.5, 36 * 1000 * 1000) < 2, true);
});

test("PDF render profile preserves normal quality and bounds costly exports", () => {
  const small = [{ role: "assistant", contentBlocks: [{ type: "paragraph", text: "Small export" }] }];
  const large = [{ role: "assistant", contentBlocks: [{ type: "paragraph", text: "x".repeat(120001) }] }];

  assert.deepEqual(getPdfRenderProfile(small, 16), {
    conservative: false,
    scale: 3,
    maxPendingPageJobs: 5
  });
  assert.deepEqual(getPdfRenderProfile(large, 16), {
    conservative: true,
    scale: 2.5,
    maxPendingPageJobs: 2
  });
  assert.equal(getPdfRenderProfile(small, 4).scale, 2.25);
});

test("adaptive PDF canvas scales preserve the logical paper size", async () => {
  for (const scale of [2.25, 2.5, 3]) {
    const pdf = createPdfFromJpegs([{
      width: Math.round(794 * scale),
      height: Math.round(1123 * scale),
      logicalWidth: 794,
      logicalHeight: 1123,
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      links: []
    }], scale);
    const source = new TextDecoder("latin1").decode(await pdf.arrayBuffer());
    assert.match(source, /\/MediaBox \[0 0 596 842\]/);
  }
});

test("shared image preload concurrency honors per-format safety caps", () => {
  const concurrency = getImagePreloadConcurrency(4);
  assert.ok(concurrency >= 1 && concurrency <= 4);
  assert.equal(getImagePreloadConcurrency(1), 1);
});

test("temporary media canvases and batch Blobs are released eagerly", () => {
  const mediaSource = readFileSync(new URL("../src/modules/export/media.js", import.meta.url), "utf8");
  const contentSource = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  assert.match(mediaSource, /finally\s*\{[\s\S]*?releaseCanvasBitmap\(canvas\)/);
  assert.match(contentSource, /saveBatchPreparedFiles\(\[preparedFile\]/);
  assert.match(contentSource, /file\.blob = null/);
});

test("batch prefetch is a bounded sliding window with safe quota handling", () => {
  const contentSource = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const prefetchStart = contentSource.indexOf("function createOrderedBatchPrefetch(");
  const prefetchEnd = contentSource.indexOf("async function runInPageBatchExport(", prefetchStart);
  const prefetchSource = contentSource.slice(prefetchStart, prefetchEnd);
  const batchStart = prefetchEnd;
  const batchEnd = contentSource.indexOf("async function runInPageBatchNotionSync(", batchStart);
  const batchSource = contentSource.slice(batchStart, batchEnd);

  assert.match(prefetchSource, /for \(let index = 0; index < workerCount; index \+= 1\) startNext\(\)/);
  assert.match(prefetchSource, /const result = await slots\[index\];\s*startNext\(\)/);
  assert.doesNotMatch(prefetchSource, /while \([^)]*source\.length[^)]*\)/);
  assert.ok(
    /if \(savedCount > 0 && !usageSettlementStarted\)/.test(batchSource) ||
      /await requireVerifiedProBatchAccess\(/.test(batchSource),
    "saved files must either settle Free usage on cancellation or be protected by a Pro-only gate"
  );
});

test("batch prefetch executes in order without fetching the whole batch", async () => {
  const contentSource = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const start = contentSource.indexOf("function createOrderedBatchPrefetch(");
  let end = contentSource.indexOf("\n  let displayedConversationsCount", start);
  if (end < 0) end = contentSource.indexOf("\n\n  async function runInPageBatchExport(", start);
  const factorySource = contentSource.slice(start, end).trim();
  const createPrefetch = new Function('"use strict"; return (' + factorySource + ');')();
  const starts = [];
  const resolvers = new Map();
  const worker = (item) => {
    starts.push(item);
    return new Promise((resolve) => resolvers.set(item, resolve));
  };
  const controller = new AbortController();
  const prefetch = createPrefetch([0, 1, 2, 3], worker, 2, controller.signal);

  await Promise.resolve();
  assert.deepEqual(starts, [0, 1]);
  resolvers.get(1)("one");
  const firstPromise = prefetch.get(0);
  await Promise.resolve();
  assert.deepEqual(starts, [0, 1], "a completed later slot must not advance the window");
  resolvers.get(0)("zero");
  assert.deepEqual(await firstPromise, { value: "zero" });
  await Promise.resolve();
  assert.deepEqual(starts, [0, 1, 2]);

  assert.deepEqual(await prefetch.get(1), { value: "one" });
  await Promise.resolve();
  assert.deepEqual(starts, [0, 1, 2, 3]);
  controller.abort();
  resolvers.get(2)("two");
  resolvers.get(3)("three");
});

test("batch save converts thrown errors to failures and always releases Blobs", async () => {
  const contentSource = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const start = contentSource.indexOf("async function saveBatchPreparedFiles(");
  const end = contentSource.indexOf("\n  // 更新整体面板状态", start);
  const factorySource = contentSource.slice(start, end).trim();
  const throwingExporter = {
    async saveBlob() {
      throw new Error("simulated save failure");
    }
  };
  const saveBatch = new Function("exporter", '"use strict"; return (' + factorySource + ');')(throwingExporter);
  const file = {
    title: "Failure",
    filename: "failure.pdf",
    downloadPath: "Batch/failure.pdf",
    blob: { size: 123 }
  };
  const result = await saveBatch([file], "Batch");

  assert.equal(result.ok, false);
  assert.equal(result.savedCount, 0);
  assert.equal(file.blob, null);
  assert.match(String(result.error || result.failures?.[0]?.error || ""), /failed|failure/i);
});
