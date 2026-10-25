import test from "node:test";
import assert from "node:assert/strict";

function installGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

test("math rendering retries stylesheet failures on the next export", async (t) => {
  let fetches = 0;
  installGlobal(t, "Image", class {});
  installGlobal(t, "document", { body: null });
  installGlobal(t, "fetch", async () => {
    fetches++;
    if (fetches === 1) throw new Error("Temporary stylesheet failure");
    return new Response(".katex { color: black; }");
  });
  const { renderMathPngAsset } = await import("../src/modules/export/math.js?review-css-recovery");
  await renderMathPngAsset({ text: "x^2", display: true });
  await renderMathPngAsset({ text: "x^2", display: true });
  assert.equal(fetches, 2);
});

test("math rendering retries unavailable layout without refetching a valid stylesheet", async (t) => {
  let fetches = 0;
  let layoutAttempts = 0;
  installGlobal(t, "Image", class {});
  installGlobal(t, "document", { get body() { layoutAttempts++; return null; } });
  installGlobal(t, "fetch", async () => { fetches++; return new Response(".katex {}"); });
  const { renderMathPngAsset } = await import("../src/modules/export/math.js?review-layout-recovery");
  await Promise.all([renderMathPngAsset({ text: "y^2" }), renderMathPngAsset({ text: "y^2" })]);
  assert.equal(layoutAttempts, 1, "concurrent render requests share one attempt");
  await renderMathPngAsset({ text: "y^2" });
  assert.equal(layoutAttempts, 2);
  assert.equal(fetches, 1);
});
