import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("Notion uses the shared, deduplicated Supabase refresh path", () => {
  const source = read("src/notion-background.js");
  const refreshSection = source.slice(
    source.indexOf("async function getFreshSupabaseSession"),
    source.indexOf("async function callEdgeFunction")
  );

  assert.match(refreshSection, /CHATVAULT_SUPABASE_REFRESH_SESSION/);
  assert.match(refreshSection, /await storageSet\("local", \{ \[SESSION_KEY\]: mergedSession \}\)/);
  assert.doesNotMatch(refreshSection, /auth\/v1\/token\?grant_type=refresh_token/);
});

test("Notion does not turn an expired product session into a disconnected workspace", () => {
  const background = read("src/notion-background.js");
  const popup = read("src/popup.js");

  assert.doesNotMatch(background, /if \(!output\.length && error\.status !== 401\) throw error/);
  assert.match(background, /status: Number\(error\.status \|\| 0\)/);
  assert.match(popup, /refreshUser: true,\s+allowStaleOnError: false/);
  assert.match(popup, /error\.status = Number\(response\?\.status \|\| 0\)/);
});
