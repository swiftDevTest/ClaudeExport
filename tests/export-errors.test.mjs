import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/modules/export-errors.js", import.meta.url), "utf8");

function loadErrors() {
  const context = vm.createContext({ console });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "export-errors.js" });
  return context.CHATVAULT_EXPORT_ERRORS;
}

test("structured export errors normalize legacy codes without losing phase metadata", () => {
  const errors = loadErrors();
  const details = errors.normalize({
    code: "CONVERSATION_COMPLETENESS_RISK",
    message: "Conversation completeness check failed"
  }, { format: "pdf", platform: "chatgpt" });

  assert.equal(details.code, "PLATFORM_SCHEMA_CHANGED");
  assert.equal(details.phase, "parse");
  assert.equal(details.retryable, true);
  assert.equal(details.format, "pdf");
  assert.equal(details.platform, "chatgpt");
});

test("structured export errors provide deterministic fallbacks and safe response fields", () => {
  const errors = loadErrors();
  const imageFailure = errors.normalize(new Error("Image exceeds the maximum canvas limit."), { phase: "render" });
  assert.equal(imageFailure.code, "IMAGE_CANVAS_LIMIT");
  assert.equal(imageFailure.fallbackFormat, "pdf");

  const response = errors.serialize(new Error("Extension context invalidated. Please refresh."));
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    error_code: "EXTENSION_CONTEXT_INVALIDATED",
    error_phase: "initialize",
    retryable: true
  });
});

test("structured export errors distinguish cancellation, save denial, timeout, and network failures", () => {
  const errors = loadErrors();
  const cancelled = new Error("cancelled");
  cancelled.name = "AbortError";
  assert.equal(errors.normalize(cancelled).code, "EXPORT_CANCELLED");
  assert.equal(errors.normalize(new Error("Chrome download was blocked.")).code, "SAVE_DENIED");
  assert.equal(errors.normalize(new Error("Export save timed out.")).code, "OPERATION_TIMEOUT");
  assert.equal(errors.normalize(new TypeError("Failed to fetch")).code, "NETWORK_ERROR");
});

test("release manifest loads the structured error protocol before content and popup entrypoints", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.ok(scripts.includes("src/modules/export-errors.js"));
  assert.ok(scripts.indexOf("src/modules/export-errors.js") < scripts.indexOf("src/content.js"));

  const popupHtml = readFileSync(new URL("../src/popup.html", import.meta.url), "utf8");
  assert.match(popupHtml, /modules\/export-errors\.js[\s\S]*popup\.js/);
});

test("export entrypoints preserve structured fields across render, save, and popup boundaries", () => {
  const content = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  const engine = readFileSync(new URL("../src/modules/export/engine.js", import.meta.url), "utf8");
  const save = readFileSync(new URL("../src/modules/export/save.js", import.meta.url), "utf8");

  assert.match(content, /function buildStructuredErrorResponse\([\s\S]*?exportErrors\?\.serialize[\s\S]*?\.\.\.details/);
  assert.match(content, /currentExportPhase = "render"[\s\S]*?currentExportPhase = "save"[\s\S]*?currentExportPhase = "complete"/);
  assert.match(engine, /function structuredFailure\([\s\S]*?error_code[\s\S]*?error_phase/);
  assert.match(save, /function structuredSaveFailure\([\s\S]*?error_code[\s\S]*?error_phase/);
});
