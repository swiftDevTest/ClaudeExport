import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");
const distRoot = join(repoRoot, "dist");
const stagingRoot = join(distRoot, "extension");

const includePaths = [
  "_locales",
  "images",
  "src",
  "manifest.json",
  "welcome.html"
];

const excludedNames = new Set([
  ".DS_Store"
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertVersionsMatch() {
  const manifest = readJson(join(repoRoot, "manifest.json"));
  const pkg = readJson(join(repoRoot, "package.json"));
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest.json version ${manifest.version} does not match package.json version ${pkg.version}`);
  }
  return { version: manifest.version, name: pkg.name };
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function copyRecursive(src, dest) {
  const name = src.split(/[\\/]/).pop();
  if (excludedNames.has(name)) {
    return;
  }

  const stats = statSync(src);
  if (stats.isDirectory()) {
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
    return;
  }

  if (!stats.isFile()) {
    return;
  }

  ensureDir(dirname(dest));
  copyFileSync(src, dest);
}

function listPackagedFiles(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listPackagedFiles(fullPath, root);
    }
    return relative(root, fullPath).replace(/\\/g, "/");
  });
}

function prepareReleaseManifest() {
  const manifestPath = join(stagingRoot, "manifest.json");
  const manifest = readJson(manifestPath);
  delete manifest.key;
  if (Object.hasOwn(manifest, "key")) {
    throw new Error("Chrome Web Store package manifest must not include key");
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function createZip(version, name) {
  const zipPath = join(distRoot, `${name}-${version}.zip`);
  rmSync(zipPath, { force: true });
  const result = spawnSync("zip", ["-qr", zipPath, "."], {
    cwd: stagingRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  return zipPath;
}

function main() {
  const { version, name } = assertVersionsMatch();
  rmSync(stagingRoot, { recursive: true, force: true });
  ensureDir(stagingRoot);

  for (const item of includePaths) {
    const src = join(repoRoot, item);
    if (!existsSync(src)) {
      throw new Error(`Required package path is missing: ${item}`);
    }
    copyRecursive(src, join(stagingRoot, item));
  }
  prepareReleaseManifest();

  const files = listPackagedFiles(stagingRoot);
  const forbiddenPrefixes = ["site/", "supabase/", "tests/", "node_modules/", "dist/", ".git/"];
  const forbidden = files.filter((file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix)));
  if (forbidden.length > 0) {
    throw new Error(`Forbidden files were packaged:\n${forbidden.join("\n")}`);
  }

  const zipPath = createZip(version, name);
  console.log(`Packaged ${files.length} files`);
  console.log(`Staging directory: ${relative(repoRoot, stagingRoot)}`);
  console.log(`ZIP: ${relative(repoRoot, zipPath)}`);
}

main();
