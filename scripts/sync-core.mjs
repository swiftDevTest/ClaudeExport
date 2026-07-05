import { existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 平台专属配置
const PLATFORM = "claude";
const PRODUCT_SLUG = "claude-export";

// 路径定义
const REPO_ROOT = join(__dirname, "..");
const SHARE_ROOT = join(REPO_ROOT, "node_modules", "@chatexport/core");
const SOURCE_EXPORT_DIR = join(SHARE_ROOT, "src", "modules", "export");
const TARGET_EXPORT_DIR = join(REPO_ROOT, "src", "modules", "export");

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function copyRecursive(src, dest, excludeDirs = []) {
  const stats = statSync(src);
  if (stats.isDirectory()) {
    const name = src.split(/[\\/]/).pop();
    if (excludeDirs.includes(name)) {
      return;
    }
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry), excludeDirs);
    }
    return;
  }
  if (stats.isFile()) {
    if (src.split(/[\\/]/).pop() === ".DS_Store") return;
    ensureDir(dirname(dest));
    copyFileSync(src, dest);
  }
}

function generateRegistry() {
  const registryCode = `// 由同步脚本自动重写生成，只引入当前平台的提取逻辑
import {
  PLATFORM_CLAUDE,
  detectPlatform
} from '../utils.js';
import { parseClaudeMessages } from './claude/extractor.js';

export var PLATFORM_EXPORT_REGISTRY = {
  claude: {
    id: PLATFORM_CLAUDE,
    label: "Claude",
    parseMessages: parseClaudeMessages
  }
};

export function getPlatformAdapter(platform) {
  return PLATFORM_EXPORT_REGISTRY[platform || detectPlatform()] || null;
}

export function parseMessagesForPlatform(platform) {
  var adapter = getPlatformAdapter(platform);
  return adapter && typeof adapter.parseMessages === "function"
    ? adapter.parseMessages()
    : [];
}

export function getRegisteredExportPlatforms() {
  return Object.keys(PLATFORM_EXPORT_REGISTRY);
}
`;
  const registryPath = join(TARGET_EXPORT_DIR, "platforms", "registry.js");
  writeFileSync(registryPath, registryCode, "utf8");
}

function applyPlatformFallbacks() {
  const productNameFallback = 'globalThis.CHATVAULT_PRODUCT_CONFIG?.productName || "Claude Export"';
  [
    "builders/docx.js",
    "builders/image.js",
    "builders/pdf.js",
    "message-adapter.js",
    "utils.js"
  ].forEach((relativePath) => {
    const filePath = join(TARGET_EXPORT_DIR, relativePath);
    if (!existsSync(filePath)) return;
    const source = readFileSync(filePath, "utf8")
      .replace(/globalThis\.CHATVAULT_PRODUCT_CONFIG\?\.productName \|\| "[^"]+"/g, productNameFallback);
    writeFileSync(filePath, source, "utf8");
  });

  const selectionPath = join(TARGET_EXPORT_DIR, "selection.js");
  if (existsSync(selectionPath)) {
    const source = readFileSync(selectionPath, "utf8")
      .replace(/primary: vars\["--cv-primary"\] \|\| "#[0-9a-fA-F]{6}"/, 'primary: vars["--cv-primary"] || "#c96442"')
      .replace(/rgb: vars\["--cv-primary-rgb"\] \|\| "[^"]+"/, 'rgb: vars["--cv-primary-rgb"] || "201, 100, 66"')
      .replace(/border: vars\["--accent-wash"\] \|\| "#[0-9a-fA-F]{6}"/, 'border: vars["--accent-wash"] || "#fff1e8"');
    writeFileSync(selectionPath, source, "utf8");
  }

  const tokensPath = join(TARGET_EXPORT_DIR, "themes", "tokens.js");
  if (existsSync(tokensPath)) {
    const source = readFileSync(tokensPath, "utf8").replace(
      /var FALLBACK_BRAND_THEME = \{[\s\S]*?\n\};/,
      "var FALLBACK_BRAND_THEME = {\n  primary: \"#c96442\",\n  primaryDark: \"#7c2d12\",\n  wash: \"#fff1e8\",\n  soft: \"#fff7f0\",\n  border: \"#e8c5b0\"\n};"
    );
    writeFileSync(tokensPath, source, "utf8");
  }
}

function isolatePlatformModule() {
  const platformPath = join(TARGET_EXPORT_DIR, "platform.js");
  if (!existsSync(platformPath)) return;

  const source = readFileSync(platformPath, "utf8")
    .replace(/\nimport \{ parseChatGPTMessages as parseChatGPTMessagesFromPlatform \} from '\.\/platforms\/chatgpt\/extractor\.js';\nimport \{ parseClaudeMessages as parseClaudeMessagesFromPlatform \} from '\.\/platforms\/claude\/extractor\.js';\nimport \{ parseGeminiMessages as parseGeminiMessagesFromPlatform \} from '\.\/platforms\/gemini\/extractor\.js';/g, "")
    .replace(/function parseChatGPTMessages\(\) {\n  return parseChatGPTMessagesFromPlatform\(\);\n}/g, 'function parseChatGPTMessages() {\n  return parseMessagesForPlatform("chatgpt");\n}')
    .replace(/function parseClaudeMessages\(\) {\n  return parseClaudeMessagesFromPlatform\(\);\n}/g, 'function parseClaudeMessages() {\n  return parseMessagesForPlatform("claude");\n}')
    .replace(/function parseGeminiMessages\(\) {\n  return parseGeminiMessagesFromPlatform\(\);\n}/g, 'function parseGeminiMessages() {\n  return parseMessagesForPlatform("gemini");\n}');
  writeFileSync(platformPath, source, "utf8");
}

function updateVersion() {
  const sharePkg = JSON.parse(readFileSync(join(SHARE_ROOT, "package.json"), "utf8"));
  const localPkgPath = join(REPO_ROOT, "package.json");
  const localPkg = JSON.parse(readFileSync(localPkgPath, "utf8"));

  localPkg["chat-export-version"] = sharePkg.version;
  writeFileSync(localPkgPath, JSON.stringify(localPkg, null, 2) + "\n", "utf8");
  console.log(`Updated local dependency chat-export-version to: ${sharePkg.version}`);
}

function updateSupabaseConfig() {
  const configCode = `globalThis.CHATVAULT_SUPABASE_CONFIG = {
  url: "https://acgehhqcgreatcjcefub.supabase.co",
  publishableKey: "sb_publishable_GH05KXWPIo42YrorR0OGyQ_XdEWzY8Q",
  googleClientId: "285963973789-94pbkh7qlk0o04d2ji3uggecs27td888.apps.googleusercontent.com"
};

globalThis.CHATVAULT_ENV = {
  PLATFORM_TARGET: "${PLATFORM}",
  PRODUCT_SLUG: "${PRODUCT_SLUG}"
};
`;
  writeFileSync(join(REPO_ROOT, "src", "supabase-config.js"), configCode, "utf8");
  console.log(`Configured supabase-config.js for product: ${PRODUCT_SLUG}`);
}

function main() {
  console.log(`Syncing ChatExportPlatform to ${PLATFORM} Exporter...`);

  if (!existsSync(SOURCE_EXPORT_DIR)) {
    console.error(`Error: ChatExportPlatform source library not found at: ${SOURCE_EXPORT_DIR}`);
    process.exit(1);
  }

  // 1. 清理并重新拷贝核心目录
  rmSync(TARGET_EXPORT_DIR, { recursive: true, force: true });
  ensureDir(TARGET_EXPORT_DIR);
  copyRecursive(SOURCE_EXPORT_DIR, TARGET_EXPORT_DIR);

  // 2. 恢复当前产品的品牌 fallback，并生成隔离平台的 registry.js
  applyPlatformFallbacks();
  generateRegistry();
  isolatePlatformModule();

  // 3. 更新本地 package.json 依赖版本与 supabase-config
  updateVersion();
  updateSupabaseConfig();

  console.log("Core sync completed successfully.");
}

main();
