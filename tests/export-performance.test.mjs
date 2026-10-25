import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

globalThis.chrome = globalThis.chrome || {
  i18n: {
    getMessage() { return ""; },
    getUILanguage() { return "en"; }
  }
};

const {
  getAdaptiveImageExportProfile,
  getFittedCanvasScale,
  collectVisualExportStats,
  createExportScheduler,
  mapLimit
} = await import("../src/modules/export/utils.js");
const {
  getImagePreloadConcurrency,
  preloadCanvasImages,
  releaseCanvasImageCache,
  getCanvasImageCacheStats
} = await import("../src/modules/export/media.js");
const { createPdfFromJpegs, getPdfRenderProfile, getPdfPagePipelinePlan } = await import("../src/modules/export/builders/pdf.js");
const { createExportDocument } = await import("../src/modules/export/document.js");
const { resolveMessages, getMessagesPlainText } = await import("../src/modules/export/platform.js");

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
    maxPendingPageJobs: 3
  });
  assert.deepEqual(getPdfRenderProfile(large, 16), {
    conservative: true,
    scale: 2.5,
    maxPendingPageJobs: 2
  });
  assert.equal(getPdfRenderProfile(small, 4).scale, 2.25);
});

test("visual export stats preserve eligibility and PDF profile counting semantics", () => {
  const messages = [{
    role: "assistant",
    contentBlocks: [
      { type: "paragraph", text: "Alpha" },
      { type: "code", text: "line1\nline2" },
      { type: "image", alt: "Chart" },
      { type: "list", items: [{ text: "One", subItems: [{ text: "Nested" }] }] },
      { type: "table", headers: ["Key", "Value"], rows: [["A", "B"]] }
    ]
  }];
  const stats = collectVisualExportStats(messages);

  assert.equal(stats.messageCount, 1);
  assert.equal(stats.blockCount, 5);
  assert.equal(stats.imageCount, 1);
  assert.equal(stats.codeBlockCount, 1);
  assert.equal(stats.maxCodeCharCount, 11);
  assert.equal(stats.listItemCount, 2);
  assert.equal(stats.tableCellCount, 4);
  assert.equal(stats.tableCharCount, "Key Value A B".length);
  assert.equal(stats.plainTextCharCount > 0, true);
  assert.deepEqual(getPdfRenderProfile(messages, 16, stats), getPdfRenderProfile(messages, 16));
});

test("visual export stats preserve legacy plain-text length semantics", () => {
  const fixtures = [
    [],
    [{ contentBlocks: [] }],
    [{ contentBlocks: [{ type: "paragraph", text: "   \n\t" }] }],
    [
      {
        contentBlocks: [
          { type: "paragraph", text: "  Alpha  " },
          { type: "code", text: "const value = 1;\n\nreturn value;" },
          { type: "math", text: "  x \\quad + y  " },
          { type: "image", alt: "Chart" }
        ]
      },
      { contentBlocks: [{ type: "paragraph", text: "\n\t" }] },
      {
        contentBlocks: [
          { type: "list", items: [{ text: "One", subItems: [{ text: "Nested" }] }, { text: "Two" }] },
          { type: "table", headers: ["Key", "Value"], rows: [["A", "B"], ["C", "D"]] }
        ]
      }
    ]
  ];

  fixtures.forEach((messages) => {
    assert.equal(
      collectVisualExportStats(messages).plainTextCharCount,
      getMessagesPlainText(messages).length
    );
  });
});

test("PDF page pipeline planner bounds canvas bytes without changing scale", () => {
  const highMemory = getPdfPagePipelinePlan({ scale: 3, deviceMemory: 16, currentMaximum: 5 });
  const unknownMemory = getPdfPagePipelinePlan({ scale: 3, deviceMemory: 0, currentMaximum: 5 });
  const imageHeavy = getPdfPagePipelinePlan({
    scale: 3,
    deviceMemory: 16,
    currentMaximum: 5,
    decodedImagePixels: 16 * 1024 * 1024
  });

  assert.equal(highMemory.maxPendingPageJobs, 3);
  assert.equal(unknownMemory.maxPendingPageJobs, 2);
  assert.equal(imageHeavy.maxPendingPageJobs, 2);
  assert.equal(highMemory.estimatedPageBytes, 794 * 1123 * 3 * 3 * 4);
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

test("mapLimit waits for sibling workers before surfacing a rejection", async () => {
  let siblingSettled = false;
  const startedAt = Date.now();
  await assert.rejects(mapLimit(["reject", "slow"], 2, async (value) => {
    if (value === "reject") throw new Error("synthetic worker failure");
    await new Promise((resolve) => setTimeout(resolve, 25));
    siblingSettled = true;
    return value;
  }), /synthetic worker failure/);

  assert.equal(siblingSettled, true);
  assert.ok(Date.now() - startedAt >= 20, "rejection must wait for the delayed sibling cleanup window");
});

test("image pixel-budget rejection releases the decoded resource before returning", async () => {
  const previousDocument = globalThis.document;
  const previousImage = globalThis.Image;
  const previousCreateObjectURL = globalThis.URL.createObjectURL;
  const previousRevokeObjectURL = globalThis.URL.revokeObjectURL;
  const canvases = [];

  class FakeImage {
    constructor() {
      this.naturalWidth = 10000;
      this.naturalHeight = 100000;
      this.onload = null;
      this.onerror = null;
    }
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src || ""; }
    removeAttribute(name) {
      if (name === "src") this._src = "";
    }
  }

  globalThis.document = {
    querySelectorAll() { return []; },
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      let width = 0;
      let height = 0;
      const canvas = {
        get width() { return width; },
        set width(value) { width = value; },
        get height() { return height; },
        set height(value) { height = value; },
        getContext() {
          return { drawImage() {}, imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
        }
      };
      canvases.push(canvas);
      return canvas;
    }
  };
  globalThis.Image = FakeImage;
  globalThis.URL.createObjectURL = () => "blob:pixel-budget-test";
  globalThis.URL.revokeObjectURL = () => {};

  try {
    const messages = [{
      contentBlocks: Array.from({ length: 4 }, (_, index) => ([{
          type: "image",
          src: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, index]).toString("base64")}`
        }, {
          type: "paragraph",
          text: `separator ${index}`
        }])).flat()
    }];
    const cache = await preloadCanvasImages(messages, { imageRenderScale: 3 });
    assert.equal(getCanvasImageCacheStats(cache).entryCount, 3);
    assert.equal(canvases.filter((canvas) => canvas.width === 1 && canvas.height === 1).length, 1);

    releaseCanvasImageCache(cache);
    assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousImage === undefined) delete globalThis.Image;
    else globalThis.Image = previousImage;
    globalThis.URL.createObjectURL = previousCreateObjectURL;
    globalThis.URL.revokeObjectURL = previousRevokeObjectURL;
  }
});

test("canvas image caches release aliased decoded resources exactly once", () => {
  let canvasReleases = 0;
  let imageReleases = 0;
  const canvas = {
    width: 1200,
    height: 800,
    getContext() {},
    set width(value) { this._width = value; canvasReleases += 1; },
    get width() { return this._width || 1200; }
  };
  const image = {
    src: "blob:test",
    onload() {},
    onerror() {},
    removeAttribute(name) {
      assert.equal(name, "src");
      imageReleases += 1;
      this.src = "";
    }
  };
  const cache = {
    first: { element: canvas, width: 1200, height: 800 },
    firstAlias: { element: canvas, width: 1200, height: 800 },
    second: { element: image }
  };

  assert.deepEqual(getCanvasImageCacheStats(cache), {
    entryCount: 2,
    decodedPixels: 1200 * 800
  });

  releaseCanvasImageCache(cache);

  assert.deepEqual(Object.keys(cache), []);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
  assert.equal(canvasReleases, 1);
  assert.equal(imageReleases, 1);
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
});

test("export scheduler yields by elapsed time and aborts at checkpoints", async () => {
  const times = [0, 5, 13, 14];
  const scheduler = createExportScheduler({ sliceMs: 12, now: () => times.shift() ?? 14 });
  assert.equal(await scheduler.checkpoint(), false);
  assert.equal(await scheduler.checkpoint(), true);

  const controller = new AbortController();
  controller.abort();
  const aborted = createExportScheduler({ signal: controller.signal, now: () => 0 });
  await assert.rejects(aborted.checkpoint(), { name: "AbortError" });
});

test("temporary media canvases and batch Blobs are released eagerly", () => {
  const mediaSource = readFileSync(new URL("../src/modules/export/media.js", import.meta.url), "utf8");
  const contentSource = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  assert.match(mediaSource, /finally\s*\{[\s\S]*?releaseCanvasBitmap\(canvas\)/);
  assert.match(contentSource, /saveBatchPreparedFiles\(\[preparedFile\]/);
  assert.match(contentSource, /file\.blob = null/);
});

test("batch prefetch executes in order without fetching the whole batch", async () => {
  const contentSource = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const start = contentSource.indexOf("function createOrderedBatchPrefetch(");
  let end = contentSource.indexOf("\n  async function runInPageBatchExport(", start);
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

test("consumed batch payloads can be collected while the prefetcher is still alive", () => {
  const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const start = source.indexOf("function createOrderedBatchPrefetch(");
  const factory = source.slice(start, source.indexOf("async function runInPageBatchExport(", start)).trim();
  const probe = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    const create = (${factory});
    const refs = [];
    globalThis.prefetch = create(Array.from({length:40}, (_,i)=>i), async id => {
      const value = {id, bytes:new Uint8Array(128*1024)};
      refs.push(new WeakRef(value)); return value;
    }, 2, new AbortController().signal);
    async function consume() { for(let i=0;i<40;i++) await globalThis.prefetch.get(i); }
    await consume();
    await new Promise(setImmediate); global.gc();
    console.log(refs.filter(ref => ref.deref()).length);
  `], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "0", "consumed payloads must not remain in settled slot promises");
});

test("disposing batch prefetch during an in-flight fetch starts no further work", async () => {
  const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const start = source.indexOf("function createOrderedBatchPrefetch(");
  const factory = source.slice(start, source.indexOf("async function runInPageBatchExport(", start)).trim();
  const create = new Function('return (' + factory + ');')();
  const started = [];
  let finish;
  const prefetch = create([0, 1, 2], async index => {
    started.push(index);
    if (index === 0) return new Promise(resolve => { finish = resolve; });
    return index;
  }, 2, new AbortController().signal);
  const first = prefetch.get(0);
  await Promise.resolve();
  prefetch.dispose();
  finish("finished");
  await first;
  assert.deepEqual(started, [0, 1]);
  await assert.rejects(prefetch.get(1), { name: "AbortError" });
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
