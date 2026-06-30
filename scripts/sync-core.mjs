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
const SOURCE_EXPORT_DIR = join(SHARE_ROOT, "src");
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
  googleClientId: "666614439104-f4hlm7c2vsdk9kepnmbgsk1olqca0n9s.apps.googleusercontent.com"
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

  // 1. 清理并重新拷贝核心目录（忽略 platforms）
  rmSync(TARGET_EXPORT_DIR, { recursive: true, force: true });
  ensureDir(TARGET_EXPORT_DIR);
  copyRecursive(SOURCE_EXPORT_DIR, TARGET_EXPORT_DIR, ["platforms"]);

  // 2. 拷贝 platforms/ 里的公共核心资源
  const sourcePlatformsDir = join(SOURCE_EXPORT_DIR, "platforms");
  const targetPlatformsDir = join(TARGET_EXPORT_DIR, "platforms");
  ensureDir(targetPlatformsDir);
  copyFileSync(join(sourcePlatformsDir, "shared.js"), join(targetPlatformsDir, "shared.js"));

  // 3. 拷贝 平台 专属提取器
  const sourcePlatformExt = join(sourcePlatformsDir, PLATFORM);
  const targetPlatformExt = join(targetPlatformsDir, PLATFORM);
  copyRecursive(sourcePlatformExt, targetPlatformExt);

  // 4. 生成隔离平台的 registry.js
  generateRegistry();

  // 5. 更新本地 package.json 依赖版本与 supabase-config
  updateVersion();
  updateSupabaseConfig();

  console.log("Core sync completed successfully.");
}

main();
