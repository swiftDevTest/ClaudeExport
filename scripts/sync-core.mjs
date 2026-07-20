import { existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 平台专属配置
const PLATFORM = "claude";
const PLATFORM_CONSTANT = "PLATFORM_CLAUDE";
const PLATFORM_LABEL = "Claude";
const PRODUCT_SLUG = "claude-export";
const PRODUCT_NAME = "Claude Export";
const GOOGLE_CLIENT_ID = "285963973789-94pbkh7qlk0o04d2ji3uggecs27td888.apps.googleusercontent.com";

// 品牌色 fallback
const BRAND_PRIMARY = "#c96442";
const BRAND_PRIMARY_DARK = "#7c2d12";
const BRAND_PRIMARY_RGB = "201, 100, 66";
const BRAND_WASH = "#fff1e8";
const BRAND_SOFT = "#fff7f0";
const BRAND_BORDER = "#e8c5b0";

// 路径定义：源目录为 ChatVault Exporter（主产品，保持最新功能代码）
const REPO_ROOT = join(__dirname, "..");
const SOURCE_ROOT = join(REPO_ROOT, "..", "ChatVault Exporter");
const SOURCE_EXPORT_DIR = join(SOURCE_ROOT, "src", "modules", "export");
const TARGET_EXPORT_DIR = join(REPO_ROOT, "src", "modules", "export");

const FILES_TO_SYNC = [
  { src: "src/modules/export.js", dest: "src/modules/export.js" },
  { src: "src/modules/export-message-adapter.js", dest: "src/modules/export-message-adapter.js" },
  { src: "src/modules/privacy-proof.js", dest: "src/modules/privacy-proof.js" },
  { src: "src/modules/redaction.js", dest: "src/modules/redaction.js" },
  { src: "src/modules/share-cards.js", dest: "src/modules/share-cards.js" },
  { src: "src/modules/template-presets.js", dest: "src/modules/template-presets.js" },
  { src: "src/modules/developer-export.js", dest: "src/modules/developer-export.js" },
  { src: "src/modules/export-health.js", dest: "src/modules/export-health.js" },
  { src: "src/modules/export-receipt.js", dest: "src/modules/export-receipt.js" },
  { src: "src/modules/i18n.js", dest: "src/modules/i18n.js" },
  { src: "src/offscreen.js", dest: "src/offscreen.js" },
  { src: "src/offscreen.html", dest: "src/offscreen.html" },
  { src: "src/obsidian-background.js", dest: "src/obsidian-background.js" },
  { src: "tests/export-fixtures.test.mjs", dest: "tests/export-fixtures.test.mjs" }
];

const DIRS_TO_SYNC = [
  { src: "src/modules/export", dest: "src/modules/export" },
  { src: "src/modules/obsidian", dest: "src/modules/obsidian" },
  { src: "tests/fixtures/export", dest: "tests/fixtures/export" }
];

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// 使用 readFileSync + writeFileSync 代替 copyFileSync，规避 macOS copyfile syscall 限制
function copyFileSafe(src, dest) {
  ensureDir(dirname(dest));
  const content = readFileSync(src);
  writeFileSync(dest, content);
}

function copyRecursive(src, dest) {
  const stats = statSync(src);
  if (stats.isDirectory()) {
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
    return;
  }
  if (stats.isFile()) {
    if (src.split(/[\\/]/).pop() === ".DS_Store") return;
    copyFileSafe(src, dest);
  }
}

function generateRegistry() {
  const registryCode = "// 由同步脚本自动重写生成，只引入当前平台的提取逻辑\n" +
    "import {\n" +
    "  " + PLATFORM_CONSTANT + ",\n" +
    "  detectPlatform\n" +
    "} from '../utils.js';\n" +
    "import { parse" + PLATFORM_LABEL + "Messages } from './" + PLATFORM + "/extractor.js';\n\n" +
    "export var PLATFORM_EXPORT_REGISTRY = {\n" +
    "  " + PLATFORM + ": {\n" +
    "    id: " + PLATFORM_CONSTANT + ",\n" +
    "    label: \"" + PLATFORM_LABEL + "\",\n" +
    "    parseMessages: parse" + PLATFORM_LABEL + "Messages\n" +
    "  }\n" +
    "};\n\n" +
    "export function getPlatformAdapter(platform) {\n" +
    "  return PLATFORM_EXPORT_REGISTRY[platform || detectPlatform()] || null;\n" +
    "}\n\n" +
    "export function parseMessagesForPlatform(platform) {\n" +
    "  var adapter = getPlatformAdapter(platform);\n" +
    "  return adapter && typeof adapter.parseMessages === \"function\"\n" +
    "    ? adapter.parseMessages()\n" +
    "    : [];\n" +
    "}\n\n" +
    "export function getRegisteredExportPlatforms() {\n" +
    "  return Object.keys(PLATFORM_EXPORT_REGISTRY);\n" +
    "}\n";
  const registryPath = join(TARGET_EXPORT_DIR, "platforms", "registry.js");
  writeFileSync(registryPath, registryCode, "utf8");
  console.log("Generated platform-isolated registry.js for: " + PLATFORM);
}

function applyPlatformFallbacks() {
  const productNameFallback = "globalThis.CHATVAULT_PRODUCT_CONFIG?.productName || \"" + PRODUCT_NAME + "\"";

  ["builders/docx.js", "builders/image.js", "builders/pdf.js", "message-adapter.js", "utils.js"].forEach(function (relativePath) {
    const filePath = join(TARGET_EXPORT_DIR, relativePath);
    if (!existsSync(filePath)) return;
    const source = readFileSync(filePath, "utf8")
      .replace(/globalThis\.CHATVAULT_PRODUCT_CONFIG\?\.productName \|\| "[^"]+"/g, productNameFallback);
    writeFileSync(filePath, source, "utf8");
  });

  const receiptPath = join(REPO_ROOT, "src", "modules", "export-receipt.js");
  if (existsSync(receiptPath)) {
    const source = readFileSync(receiptPath, "utf8")
      .replace(/extensionName:\s*"[^"]+"/g, "extensionName: " + productNameFallback);
    writeFileSync(receiptPath, source, "utf8");
  }

  const selectionPath = join(TARGET_EXPORT_DIR, "selection.js");
  if (existsSync(selectionPath)) {
    const source = readFileSync(selectionPath, "utf8")
      .replace(/primary: vars\["--cv-primary"\] \|\| "#[0-9a-fA-F]{6}"/, "primary: vars[\"--cv-primary\"] || \"" + BRAND_PRIMARY + "\"")
      .replace(/rgb: vars\["--cv-primary-rgb"\] \|\| "[^"]+"/, "rgb: vars[\"--cv-primary-rgb\"] || \"" + BRAND_PRIMARY_RGB + "\"")
      .replace(/border: vars\["--accent-wash"\] \|\| "#[0-9a-fA-F]{6}"/, "border: vars[\"--accent-wash\"] || \"" + BRAND_WASH + "\"");
    writeFileSync(selectionPath, source, "utf8");
  }

  const tokensPath = join(TARGET_EXPORT_DIR, "themes", "tokens.js");
  if (existsSync(tokensPath)) {
    const source = readFileSync(tokensPath, "utf8").replace(
      /var FALLBACK_BRAND_THEME = \{[\s\S]*?\n\};/,
      "var FALLBACK_BRAND_THEME = {\n  primary: \"" + BRAND_PRIMARY + "\",\n  primaryDark: \"" + BRAND_PRIMARY_DARK + "\",\n  wash: \"" + BRAND_WASH + "\",\n  soft: \"" + BRAND_SOFT + "\",\n  border: \"" + BRAND_BORDER + "\"\n};"
    );
    writeFileSync(tokensPath, source, "utf8");
  }
}

function isolatePlatformModule() {
  const platformPath = join(TARGET_EXPORT_DIR, "platform.js");
  if (!existsSync(platformPath)) return;

  const source = readFileSync(platformPath, "utf8")
    .replace(/\nimport \{ parseChatGPTMessages as parseChatGPTMessagesFromPlatform \} from '\.\/platforms\/chatgpt\/extractor\.js';\nimport \{ parseClaudeMessages as parseClaudeMessagesFromPlatform \} from '\.\/platforms\/claude\/extractor\.js';\nimport \{ parseGeminiMessages as parseGeminiMessagesFromPlatform \} from '\.\/platforms\/gemini\/extractor\.js';/g, "")
    .replace(/function parseChatGPTMessages\(\) \{\n  return parseChatGPTMessagesFromPlatform\(\);\n\}/g, "function parseChatGPTMessages() {\n  return parseMessagesForPlatform(\"chatgpt\");\n}")
    .replace(/function parseClaudeMessages\(\) \{\n  return parseClaudeMessagesFromPlatform\(\);\n\}/g, "function parseClaudeMessages() {\n  return parseMessagesForPlatform(\"claude\");\n}")
    .replace(/function parseGeminiMessages\(\) \{\n  return parseGeminiMessagesFromPlatform\(\);\n\}/g, "function parseGeminiMessages() {\n  return parseMessagesForPlatform(\"gemini\");\n}");
  writeFileSync(platformPath, source, "utf8");
}

function cleanupUnusedPlatformExtractors() {
  const platformsDir = join(TARGET_EXPORT_DIR, "platforms");
  if (!existsSync(platformsDir)) return;
  ["chatgpt", "claude", "gemini"].forEach(function (platform) {
    if (PLATFORM === platform) return;
    const platformDir = join(platformsDir, platform);
    if (existsSync(platformDir)) {
      rmSync(platformDir, { recursive: true, force: true });
      console.log("Removed unused platform extractor: " + platform);
    }
  });
}

function updateSupabaseConfig() {
  const configCode = "globalThis.CHATVAULT_SUPABASE_CONFIG = {\n  url: \"https://acgehhqcgreatcjcefub.supabase.co\",\n  publishableKey: \"sb_publishable_GH05KXWPIo42YrorR0OGyQ_XdEWzY8Q\",\n  googleClientId: \"" + GOOGLE_CLIENT_ID + "\"\n};\n\nglobalThis.CHATVAULT_ENV = {\n  PLATFORM_TARGET: \"" + PLATFORM + "\",\n  PRODUCT_SLUG: \"" + PRODUCT_SLUG + "\"\n};\n";
  writeFileSync(join(REPO_ROOT, "src", "supabase-config.js"), configCode, "utf8");
  console.log("Configured supabase-config.js for product: " + PRODUCT_SLUG);
}

function updateManifestResources() {
  const manifestPath = join(REPO_ROOT, "manifest.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const newResources = [
    "src/modules/export/notion-sync-engine.js",
    "src/modules/obsidian/coordinator.js",
    "src/modules/obsidian/renderer.js",
    "src/modules/obsidian/media.js"
  ];

  if (Array.isArray(manifest.web_accessible_resources)) {
    manifest.web_accessible_resources = manifest.web_accessible_resources.map(function (entry) {
      if (!entry || !Array.isArray(entry.resources)) return entry;
      const merged = Array.from(new Set(entry.resources.concat(newResources)));
      return Object.assign({}, entry, { resources: merged });
    });
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("Updated manifest.json web_accessible_resources.");
}

function updateVersion() {
  const sourcePkgPath = join(SOURCE_ROOT, "package.json");
  const localPkgPath = join(REPO_ROOT, "package.json");
  if (!existsSync(sourcePkgPath) || !existsSync(localPkgPath)) return;
  const sourcePkg = JSON.parse(readFileSync(sourcePkgPath, "utf8"));
  const localPkg = JSON.parse(readFileSync(localPkgPath, "utf8"));
  localPkg["chat-export-version"] = sourcePkg.version;
  writeFileSync(localPkgPath, JSON.stringify(localPkg, null, 2) + "\n", "utf8");
  console.log("Updated local dependency chat-export-version to: " + sourcePkg.version);
}

function main() {
  console.log("Syncing ChatVault Exporter -> " + PRODUCT_NAME + "...");

  if (!existsSync(SOURCE_EXPORT_DIR)) {
    console.error("Error: ChatVault Exporter source not found at: " + SOURCE_EXPORT_DIR);
    process.exit(1);
  }

  for (const item of FILES_TO_SYNC) {
    const srcPath = join(SOURCE_ROOT, item.src);
    const destPath = join(REPO_ROOT, item.dest);
    if (existsSync(srcPath)) {
      copyFileSafe(srcPath, destPath);
      console.log("Synced file: " + item.dest);
    } else {
      console.warn("Warning: Source file not found: " + srcPath);
    }
  }

  for (const item of DIRS_TO_SYNC) {
    const srcPath = join(SOURCE_ROOT, item.src);
    const destPath = join(REPO_ROOT, item.dest);
    if (!existsSync(srcPath)) {
      console.warn("Warning: Source directory not found: " + srcPath);
      continue;
    }
    if (item.src === "src/modules/export") {
      rmSync(destPath, { recursive: true, force: true });
      ensureDir(destPath);
    }
    copyRecursive(srcPath, destPath);
    console.log("Synced directory: " + item.dest);
  }

  applyPlatformFallbacks();
  generateRegistry();
  isolatePlatformModule();
  cleanupUnusedPlatformExtractors();

  updateVersion();
  updateSupabaseConfig();
  updateManifestResources();

  console.log("Core sync completed successfully.");
}

main();
