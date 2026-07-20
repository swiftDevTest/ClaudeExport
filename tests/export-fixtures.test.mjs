import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { onLine: true }
});

globalThis.localStorage = {
  values: new Map(),
  get length() {
    return this.values.size;
  },
  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  },
  key(index) {
    return Array.from(this.values.keys())[index] || null;
  },
  setItem(key, value) {
    this.values.set(key, String(value));
  },
  removeItem(key) {
    this.values.delete(key);
  }
};

await import("../src/modules/export.js");
await globalThis.CHATVAULT_EXPORT_READY;

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "export");

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(fixtureRoot, relativePath), "utf8"));
}

function stableBlockSnapshot(block) {
  if (block.type === "image") {
    return {
      type: "image",
      sourceKind: block.sourceKind,
      normalizedSrc: block.normalizedSrc,
      originalIndex: block.originalIndex,
      alt: block.alt
    };
  }

  if (block.type === "heading") {
    return {
      type: "heading",
      level: block.level,
      text: block.text || ""
    };
  }

  return {
    type: block.type,
    text: block.text || ""
  };
}

function stableExportSnapshot(messages) {
  return (messages || []).map((message) => ({
    role: message.role,
    blocks: (message.contentBlocks || []).map(stableBlockSnapshot)
  }));
}

function getImageBlocks(messages) {
  return (messages || []).flatMap((message) =>
    (message.contentBlocks || []).filter((block) => block && block.type === "image")
  );
}

function assertStableImageModel(images, fixtureId) {
  images.forEach((block) => {
    assert.equal(Boolean(block.imageId), true, `${fixtureId} image should have imageId`);
    assert.equal(Boolean(block.sourceKind), true, `${fixtureId} image should have sourceKind`);
    assert.equal(Number.isInteger(block.originalIndex), true, `${fixtureId} image should have originalIndex`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(block, "normalizedSrc"),
      true,
      `${fixtureId} image should have normalizedSrc`
    );
  });
}

const fixtureManifest = readJson("manifest.json");

for (const fixture of fixtureManifest.fixtures) {
  test(`export fixture ${fixture.id}`, () => {
    const input = readJson(fixture.input);
    const expected = readJson(fixture.expected);
    const resolved = globalThis.CHATVAULT_EXPORT._test.resolveMessages({
      ...input,
      platform: fixture.platform || input.platform,
      scope: input.scope || "conversation",
      settings: input.settings || {}
    });

    assert.equal(resolved.ok, true, resolved.error || "fixture should resolve");

    const images = getImageBlocks(resolved.messages);
    assert.equal(images.length, expected.assertions.imageCount);
    assertStableImageModel(images, fixture.id);
    assert.deepEqual(stableExportSnapshot(resolved.messages), expected.messages);

    const serialized = JSON.stringify({
      messages: resolved.messages,
      snapshot: stableExportSnapshot(resolved.messages)
    });
    (expected.assertions.forbiddenText || []).forEach((text) => {
      assert.equal(serialized.includes(text), false, `${fixture.id} should not contain ${text}`);
    });
  });
}
