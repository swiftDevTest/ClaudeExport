import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, posix } from "node:path";

function readText(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function getRuntimeModuleRoots() {
  const exportSource = readText("../src/modules/export.js");
  return Array.from(
    exportSource.matchAll(/resolveModulePath\("([^"]+)"\)/g),
    (match) => match[1]
  );
}

function getStaticModuleImports(modulePath) {
  const source = readText(`../${modulePath}`);
  return Array.from(
    source.matchAll(/(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+\.js)["']/g),
    (match) => match[1]
  )
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => posix.normalize(posix.join(dirname(modulePath), specifier)));
}

function collectRuntimeModuleGraph() {
  const pending = getRuntimeModuleRoots();
  const seen = new Set();

  while (pending.length) {
    const modulePath = pending.pop();
    if (!modulePath || seen.has(modulePath)) continue;
    seen.add(modulePath);
    getStaticModuleImports(modulePath).forEach((dependencyPath) => {
      if (!seen.has(dependencyPath)) {
        pending.push(dependencyPath);
      }
    });
  }

  return Array.from(seen).sort();
}

test("manifest exposes every export module loaded at runtime", () => {
  const manifest = readJson("../manifest.json");
  const runtimeModules = collectRuntimeModuleGraph();
  const exposedResources = new Set(
    (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || [])
  );

  assert.notEqual(runtimeModules.length, 0, "expected export.js to declare runtime-loaded modules");
  assert.deepEqual(
    runtimeModules.filter((modulePath) => !exposedResources.has(modulePath)),
    []
  );
});
