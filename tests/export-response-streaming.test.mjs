import test from "node:test";
import assert from "node:assert/strict";
import { createExportPlatformFetchers } from "../src/modules/export/platform-fetchers.js";

const readBody = createExportPlatformFetchers()._test.readPlatformResponseBody;

function responseFromChunks(chunks, options = {}) {
  const state = { cancelled: 0, released: 0, reads: 0 };
  const response = {
    headers: new Headers(options.headers),
    body: {
      getReader() {
        return {
          async read() {
            const index = state.reads++;
            if (options.failAt === index) throw new Error("connection lost");
            return index < chunks.length ? { value: chunks[index], done: false } : { done: true };
          },
          cancel() { state.cancelled += 1; return Promise.resolve(); },
          releaseLock() { state.released += 1; }
        };
      }
    }
  };
  return { response, state };
}

test("streamed JSON and text preserve UTF-8 across every byte boundary", async () => {
  const value = { text: "中文🙂 café e\u0301", code: "a\\b\n\tend" };
  const source = "\ufeff" + JSON.stringify(value);
  const bytes = new TextEncoder().encode(source);
  const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
  for (const type of ["json", "text"]) {
    const { response, state } = responseFromChunks(chunks);
    const result = await readBody(response, type, "Fixture", 1000, bytes.length);
    assert.deepEqual(result, type === "json" ? value : JSON.stringify(value));
    assert.equal(state.cancelled, 0);
    assert.equal(state.released, 1);
  }
});

test("response decoding consumes bounded chunks without a full-size decode", async () => {
  const OriginalDecoder = globalThis.TextDecoder;
  const calls = [];
  globalThis.TextDecoder = class extends OriginalDecoder {
    decode(bytes, options) {
      calls.push({ bytes: bytes?.byteLength || 0, stream: options?.stream === true });
      return super.decode(bytes, options);
    }
  };
  try {
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    const { response } = responseFromChunks(Array(64).fill(chunk));
    const result = await readBody(response, "text", "Large fixture", 1000, 4 * 1024 * 1024);
    assert.equal(result.length, 4 * 1024 * 1024);
    assert.equal(calls.length, 65);
    assert.ok(calls.slice(0, -1).every((call) => call.stream && call.bytes === chunk.length));
    assert.deepEqual(calls.at(-1), { bytes: 0, stream: false });
  } finally {
    globalThis.TextDecoder = OriginalDecoder;
  }
});

test("streamed blobs preserve exact bytes and MIME type", async () => {
  const chunks = [new Uint8Array([0xff, 0xd8]), new Uint8Array([0, 0xff, 0xd9])];
  const { response } = responseFromChunks(chunks, { headers: { "content-type": "image/jpeg" } });
  const blob = await readBody(response, "blob", "Image", 1000, 5);
  assert.equal(blob.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([0xff, 0xd8, 0, 0xff, 0xd9]));
});

test("streaming enforces byte limits and cancels failed readers exactly once", async () => {
  const chunks = [new Uint8Array([0xe4, 0xb8, 0xad]), new Uint8Array([0xe6, 0x96, 0x87])];
  const oversized = responseFromChunks(chunks);
  await assert.rejects(readBody(oversized.response, "text", "Fixture", 1000, 5), /too much data/);
  assert.equal(oversized.state.cancelled, 1);
  assert.equal(oversized.state.released, 1);

  const failed = responseFromChunks(chunks, { failAt: 1 });
  await assert.rejects(readBody(failed.response, "text", "Fixture", 1000, 10), /connection lost/);
  assert.equal(failed.state.cancelled, 1);
  assert.equal(failed.state.released, 1);
});

test("stream cancellation interrupts a pending read and releases its lock", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  let released = 0;
  const response = {
    headers: new Headers(),
    body: { getReader() { return {
      read() { return new Promise(() => {}); },
      cancel() { cancelled += 1; return Promise.resolve(); },
      releaseLock() { released += 1; }
    }; } }
  };
  const pending = readBody(response, "text", "Fixture", 1000, 1024, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});

test("non-streaming responses retain JSON, text, blob and size-limit behavior", async () => {
  const bytes = new TextEncoder().encode('{"text":"中文🙂"}');
  const response = {
    headers: new Headers({ "content-type": "application/json" }),
    async arrayBuffer() { return bytes.buffer; }
  };
  assert.deepEqual(await readBody(response, "json", "Fallback"), { text: "中文🙂" });
  assert.equal(await readBody(response, "text", "Fallback"), new TextDecoder().decode(bytes));
  assert.deepEqual(new Uint8Array(await (await readBody(response, "blob", "Fallback")).arrayBuffer()), bytes);
  await assert.rejects(readBody(response, "text", "Fallback", 1000, bytes.length - 1), /too much data/);
});
