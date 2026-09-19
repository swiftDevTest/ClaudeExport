import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pdfBuilderSource = readFileSync(new URL("../src/modules/export/builders/pdf.js", import.meta.url), "utf8");

globalThis.chrome = globalThis.chrome || {
  i18n: {
    getMessage() { return ""; },
    getUILanguage() { return "en"; }
  }
};

const { renderPdfPages } = await import("../src/modules/export/builders/pdf.js");
const { buildImageBlob } = await import("../src/modules/export/builders/image.js");

function installFakeCanvasDocument(options = {}) {
  const previousDocument = globalThis.document;
  const canvases = [];
  let maxLiveCanvases = 0;
  let blobAttempts = 0;

  function updateLiveCanvasCount() {
    const live = canvases.filter(({ canvas }) => canvas.width > 1 && canvas.height > 1).length;
    maxLiveCanvases = Math.max(maxLiveCanvases, live);
  }

  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      const drawCalls = [];
      const stateStack = [];
      const context = {
        font: "15px sans-serif",
        fillStyle: "#000",
        strokeStyle: "#000",
        lineWidth: 1,
        textAlign: "start",
        textBaseline: "alphabetic",
        clipActive: false,
        scale() {},
        fillRect() {},
        strokeRect() {},
        drawImage() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        arc() {},
        rect() {},
        clip() { this.clipActive = true; },
        fill() {},
        stroke() {},
        save() {
          stateStack.push({
            clipActive: this.clipActive,
            font: this.font,
            fillStyle: this.fillStyle,
            strokeStyle: this.strokeStyle,
            lineWidth: this.lineWidth,
            textAlign: this.textAlign,
            textBaseline: this.textBaseline
          });
        },
        restore() {
          const state = stateStack.pop();
          if (state) Object.assign(this, state);
        },
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        createPattern() { return {}; },
        measureText(value) {
          const text = String(value || "");
          return {
            width: text.length * 7,
            actualBoundingBoxAscent: 11,
            actualBoundingBoxDescent: 3
          };
        },
        fillText(value, x, y) {
          drawCalls.push({
            text: String(value || ""),
            x,
            y,
            font: this.font,
            clipActive: this.clipActive
          });
        }
      };
      let canvasWidth = 0;
      let canvasHeight = 0;
      const canvas = {
        get width() { return canvasWidth; },
        set width(value) { canvasWidth = value; updateLiveCanvasCount(); },
        get height() { return canvasHeight; },
        set height(value) { canvasHeight = value; updateLiveCanvasCount(); },
        getContext() { return context; },
        toBlob(callback, type) {
          blobAttempts += 1;
          const finish = () => callback(options.failBlob
            ? null
            : new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: type || "image/jpeg" }));
          if (options.deferBlob) setTimeout(finish, 1);
          else finish();
        }
      };
      canvases.push({ canvas, context, drawCalls });
      return canvas;
    }
  };

  return {
    canvases,
    get maxLiveCanvases() { return maxLiveCanvases; },
    get blobAttempts() { return blobAttempts; },
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  };
}

function pdfSettings(overrides = {}) {
  return {
    export_style: "natural",
    show_conversation_title: false,
    show_platform_name: false,
    show_export_time: false,
    include_source_url: false,
    show_role_labels: false,
    show_chatvault_badge: true,
    align_user_messages_right: false,
    ...overrides
  };
}

async function renderWithFakeCanvas(messages, settings = pdfSettings()) {
  const fake = installFakeCanvasDocument();
  try {
    const pages = await renderPdfPages(messages, {
      title: "Long content regression",
      platform: "chatgpt",
      scope: "conversation"
    }, settings, {}, {});
    return { pages, canvases: fake.canvases };
  } finally {
    fake.restore();
  }
}

function assertContentStaysAboveFooter(canvases) {
  const contentCalls = canvases.flatMap(({ drawCalls }) => drawCalls.filter((call) => call.clipActive));
  assert.ok(contentCalls.length > 0);
  assert.ok(contentCalls.every((call) => call.y <= 1049), "body text must stay above the PDF footer boundary");
  canvases.forEach(({ drawCalls }) => {
    const footer = drawCalls.filter((call) => call.text === "Exported by AI Chat Export");
    assert.equal(footer.length, 1);
    assert.equal(footer[0].clipActive, false);
    assert.equal(footer[0].y, 1087);
  });
}

test("PDF export fits tall image rows to remaining page height", () => {
  assert.match(pdfBuilderSource, /MIN_FITTED_IMAGE_ROW_HEIGHT\s*=\s*180/);
  assert.match(pdfBuilderSource, /function fitPdfImageRowToHeight/);
  assert.match(pdfBuilderSource, /maxOriginalHeight\s*=\s*Math\.max\(1,\s*maxHeight - 16\)/);
  assert.match(pdfBuilderSource, /fittedBlock\.height\s*=\s*fittedBlock\.originalHeight \+ 16/);
  assert.match(pdfBuilderSource, /newPage\(\);\s*await drainPageJobsIfNeeded\(\);\s*fittedRow = fitPdfImageRowToHeight/s);
  assert.match(pdfBuilderSource, /renderPdfImageGridRow\(fittedRow, imgX, y\)/);
});

test("PDF footer includes only branding without platform and export time", () => {
  assert.match(pdfBuilderSource, /if \(!settings\.show_chatvault_badge\) return;/);
  assert.match(pdfBuilderSource, /ctx\.fillText\(t\("export_pdf_footer_branding"/);
  assert.doesNotMatch(pdfBuilderSource, /footer\.push\(getPlatformLabel\(metadata\.platform\)\)/);
  assert.doesNotMatch(pdfBuilderSource, /footer\.push\(formatDateDisplay\(metadata\.exportedAt\)\)/);
});

test("PDF export paginates long lists without orphan headings, clipping, or footer overlap", async () => {
  const items = Array.from({ length: 120 }, (_, index) => ({ text: `Question${index + 1}` }));
  const href = "https://example.com/long-list";
  const { pages, canvases } = await renderWithFakeCanvas([{
    role: "assistant",
    contentBlocks: [
      { type: "heading", level: 2, text: "Long list" },
      { type: "list", ordered: true, items },
      { type: "paragraph", text: "Linked appendix", segments: [{ text: "Linked appendix", href }] }
    ]
  }]);

  assert.ok(pages.length >= 3);
  assertContentStaysAboveFooter(canvases);

  const markers = canvases.flatMap(({ drawCalls }) => drawCalls)
    .filter((call) => /^\d+\.$/.test(call.text))
    .map((call) => Number(call.text.slice(0, -1)));
  assert.deepEqual(markers, Array.from({ length: 120 }, (_, index) => index + 1));

  const headingPage = canvases.findIndex(({ drawCalls }) => drawCalls.some((call) => call.text === "Long list"));
  const firstItemPage = canvases.findIndex(({ drawCalls }) => drawCalls.some((call) => call.text === "1."));
  assert.equal(headingPage, firstItemPage);
  assert.ok(pages.flatMap((page) => page.links || []).some((link) => link.href === href));
});

test("PDF export bounds live page canvases inside one very long message", async () => {
  const fake = installFakeCanvasDocument({ deferBlob: true });
  try {
    const items = Array.from({ length: 320 }, (_, index) => ({ text: `MemoryItem${index + 1}` }));
    const pages = await renderPdfPages([{
      role: "assistant",
      contentBlocks: [{ type: "list", ordered: true, items }]
    }], {
      title: "Memory regression",
      platform: "chatgpt",
      scope: "conversation"
    }, pdfSettings(), {}, {});

    assert.ok(pages.length >= 7);
    assert.ok(fake.maxLiveCanvases <= 3, `expected at most 3 live page canvases, got ${fake.maxLiveCanvases}`);
  } finally {
    fake.restore();
  }
});

test("PDF export restores the five-page encoding pipeline for ordinary content", async () => {
  const fake = installFakeCanvasDocument({ deferBlob: true });
  try {
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: "assistant",
      contentBlocks: [{
        type: "paragraph",
        text: `Fast message ${index + 1} ` + "plain text ".repeat(32)
      }]
    }));
    const pages = await renderPdfPages(messages, {
      title: "Fast ordinary export",
      platform: "chatgpt",
      scope: "conversation"
    }, pdfSettings(), {}, {});

    assert.ok(pages.length >= 8);
    assert.ok(fake.maxLiveCanvases > 3, `expected fast pipeline to exceed the conservative limit, got ${fake.maxLiveCanvases}`);
    assert.ok(fake.maxLiveCanvases <= 6, `expected at most 6 live canvases, got ${fake.maxLiveCanvases}`);
  } finally {
    fake.restore();
  }
});

test("PDF export settles rejected page encoders and releases canvases after a later render error", async () => {
  const fake = installFakeCanvasDocument({ deferBlob: true, failBlob: true });
  let contentBlockReads = 0;
  const failingMessage = {
    role: "assistant",
    get contentBlocks() {
      contentBlockReads += 1;
      if (contentBlockReads > 1) throw new Error("synthetic render failure");
      return [{ type: "paragraph", text: "profile pass" }];
    }
  };

  try {
    await assert.rejects(renderPdfPages([{
      role: "assistant",
      contentBlocks: [{
        type: "paragraph",
        text: Array.from({ length: 55 }, (_, index) => `Pending page line ${index + 1}`).join("\n")
      }]
    }, failingMessage], {
      title: "Pending encoder cleanup",
      platform: "chatgpt",
      scope: "conversation"
    }, pdfSettings(), {}, {}), /synthetic render failure/);

    assert.equal(fake.blobAttempts, 2, "the pending encoder and its fallback retry must both settle");
    assert.ok(fake.canvases.length >= 2);
    assert.ok(fake.canvases.every(({ canvas }) => canvas.width === 1 && canvas.height === 1));
  } finally {
    fake.restore();
  }
});

test("PDF pagination draws every uniquely marked message exactly once and in order", async () => {
  const markers = Array.from({ length: 180 }, (_, index) => `MSG-${String(index + 1).padStart(4, "0")}`);
  const messages = markers.map((marker, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    contentBlocks: [{
      type: "paragraph",
      text: `${marker} rendered payload ${"detail ".repeat(index % 11)}`.trim()
    }]
  }));
  const { pages, canvases } = await renderWithFakeCanvas(messages);

  assert.ok(pages.length >= 5);
  assertContentStaysAboveFooter(canvases);
  const drawnMarkers = canvases
    .flatMap(({ drawCalls }) => drawCalls)
    .flatMap((call) => call.text.match(/MSG-\d{4}/g) || []);
  assert.deepEqual(drawnMarkers, markers);
});

test("PDF export draws unstyled text directly while retaining rich link rendering", async () => {
  const href = "https://example.com/rich";
  const { pages, canvases } = await renderWithFakeCanvas([{
    role: "assistant",
    contentBlocks: [
      { type: "heading", level: 2, text: "Plain heading" },
      { type: "paragraph", text: "Plain paragraph" },
      { type: "paragraph", text: "Rich link", segments: [{ text: "Rich link", href }] }
    ]
  }]);

  const calls = canvases.flatMap(({ drawCalls }) => drawCalls);
  const heading = calls.find((call) => call.text === "Plain heading");
  const paragraph = calls.find((call) => call.text === "Plain paragraph");
  assert.match(heading.font, /^800 /);
  assert.doesNotMatch(paragraph.font, /^normal /);
  assert.ok(pages.flatMap((page) => page.links || []).some((link) => link.href === href));
});

test("PDF export paginates long blockquotes and oversized table rows", async () => {
  const quoteText = Array.from({ length: 90 }, (_, index) => `QuoteLine${index + 1}`).join("\n");
  const tableText = Array.from({ length: 100 }, (_, index) => `TableLine${index + 1}`).join("\n");
  const { canvases } = await renderWithFakeCanvas([{
    role: "assistant",
    contentBlocks: [
      { type: "heading", level: 2, text: "Quote section" },
      { type: "blockquote", text: quoteText },
      { type: "heading", level: 2, text: "Table section" },
      { type: "table", headers: ["Details"], rows: [[tableText]] }
    ]
  }]);

  assertContentStaysAboveFooter(canvases);
  const allCalls = canvases.flatMap(({ drawCalls }) => drawCalls);
  assert.ok(allCalls.some((call) => call.text === "QuoteLine90"));
  assert.ok(allCalls.some((call) => call.text === "TableLine100"));

  const headingPage = canvases.findIndex(({ drawCalls }) => drawCalls.some((call) => call.text === "Table section"));
  const tablePage = canvases.findIndex(({ drawCalls }) => drawCalls.some((call) => call.text === "TableLine1"));
  assert.equal(headingPage, tablePage);
});

test("Image export keeps a long list complete and places branding after the content", async () => {
  const fake = installFakeCanvasDocument();
  try {
    const items = Array.from({ length: 120 }, (_, index) => ({ text: `ImageItem${index + 1}` }));
    const blob = await buildImageBlob([{
      role: "assistant",
      contentBlocks: [{ type: "list", ordered: true, items }]
    }], {
      title: "Long image",
      platform: "chatgpt",
      scope: "conversation"
    }, pdfSettings(), {});
    assert.equal(blob.type, "image/png");

    const rendered = fake.canvases.find(({ drawCalls }) => drawCalls.some((call) => call.text === "Exported by AI Chat Export"));
    assert.ok(rendered);
    const markers = rendered.drawCalls
      .filter((call) => /^\d+\.$/.test(call.text))
      .map((call) => Number(call.text.slice(0, -1)));
    assert.deepEqual(markers, Array.from({ length: 120 }, (_, index) => index + 1));

    const footerY = rendered.drawCalls.find((call) => call.text === "Exported by AI Chat Export").y;
    const lastMarkerY = rendered.drawCalls.find((call) => call.text === "120.").y;
    assert.ok(lastMarkerY < footerY);
  } finally {
    fake.restore();
  }
});

test("Image export keeps every positional space in a code diagram", async () => {
  const diagram = [
    "                 iOS Native",
    "                     │",
    "        ┌────────────┼────────────┐",
    "        ↓            ↓            ↓",
    "   Native Router   Bridge     Lifecycle",
    "        │            │            │",
    "        └──────── FlutterEngine ───┘"
  ];
  const fake = installFakeCanvasDocument();
  try {
    await buildImageBlob([{
      role: "assistant",
      contentBlocks: [{ type: "code", text: diagram.join("\n") }]
    }], {
      title: "Diagram",
      platform: "chatgpt",
      scope: "conversation"
    }, pdfSettings(), {});

    const rendered = fake.canvases.find(({ drawCalls }) => drawCalls.some((call) => call.text === diagram[0]));
    assert.ok(rendered, "the first diagram row should be drawn verbatim");
    diagram.forEach((line) => {
      assert.ok(rendered.drawCalls.some((call) => call.text === line), `diagram row must retain its exact spaces: ${line}`);
    });
  } finally {
    fake.restore();
  }
});
