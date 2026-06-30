// 由同步脚本自动重写生成，只引入当前平台的提取逻辑
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
