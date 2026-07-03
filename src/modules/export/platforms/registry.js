import {
  PLATFORM_CHATGPT,
  PLATFORM_CLAUDE,
  PLATFORM_GEMINI,
  detectPlatform
} from '../utils.js';
import { parseChatGPTMessages } from './chatgpt/extractor.js';
import { parseClaudeMessages } from './claude/extractor.js';
import { parseGeminiMessages } from './gemini/extractor.js';

export var PLATFORM_EXPORT_REGISTRY = {
  chatgpt: {
    id: PLATFORM_CHATGPT,
    label: "ChatGPT",
    parseMessages: parseChatGPTMessages
  },
  claude: {
    id: PLATFORM_CLAUDE,
    label: "Claude",
    parseMessages: parseClaudeMessages
  },
  gemini: {
    id: PLATFORM_GEMINI,
    label: "Gemini",
    parseMessages: parseGeminiMessages
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
