"use strict";

function createMissingDependencyError(name) {
    return new Error("ChatVault export platform fetcher dependency is missing: " + name);
  }

  function requireFn(deps, name) {
    if (deps && typeof deps[name] === "function") {
      return deps[name];
    }
    throw createMissingDependencyError(name);
  }

  const GEMINI_AT_TOKEN_MIN_LENGTH = 8;
  const GEMINI_AT_TOKEN_MAX_LENGTH = 4096;
  const GEMINI_BATCH_RESPONSE_MAX_CHARS = 10 * 1024 * 1024;
  const PLATFORM_EXPORT_REQUEST_TIMEOUT_MS = 25000;
  const CLAUDE_ATTACHMENT_FETCH_TIMEOUT_MS = 4000;
  const CLAUDE_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;
  const CLAUDE_ATTACHMENT_CONCURRENCY = 4;
  const THOUGHT_LINE_PATTERN = /^\s*(?:已\s*(?:思考|推理)|思考中|推理中|思考(?:了)?|推理(?:了)?|(?:Thought|Reasoned|Worked)\s+(?:for|about)|Thinking|Reasoning|Working)(?:\b|[\s:：,，。.·-]|$)[\s\S]{0,160}$/i;
  const THOUGHT_ATTR_PATTERN = /\b(?:reasoning|thought|thinking|chain[-_ ]?of[-_ ]?thought|model[-_ ]?thought|oai[-_ ]?reasoning)\b/i;

  async function mapLimit(array, limit, fn) {
    var results = [];
    var index = 0;
    async function worker() {
      while (index < array.length) {
        var currentIndex = index++;
        results[currentIndex] = await fn(array[currentIndex], currentIndex);
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, array.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  function normalizeExportBlock(block) {
    if (!block || typeof block !== "object") {
      return block;
    }

    const copy = { ...block };
    if (typeof copy.text === "string") {
      copy.text = normalizeExportText(copy.text);
    }
    if (Array.isArray(copy.headers)) {
      copy.headers = copy.headers.map((cell) => normalizeExportText(cell));
    }
    if (Array.isArray(copy.rows)) {
      copy.rows = copy.rows.map((row) => (row || []).map((cell) => normalizeExportText(cell)));
    }
    if (Array.isArray(copy.items)) {
      copy.items = copy.items.map((item) => ({
        ...item,
        text: normalizeExportText(item?.text),
        subItems: Array.isArray(item?.subItems)
          ? item.subItems.map((sub) => ({ ...sub, text: normalizeExportText(sub?.text) }))
          : []
      }));
    }
    return copy;
  }

  function cloneExportBlocks(blocks = []) {
    return JSON.parse(JSON.stringify(blocks)).map(normalizeExportBlock);
  }

  function orderUserImageBlocksFirst(role, blocks = []) {
    if (role !== "user") {
      return blocks;
    }

    const images = [];
    const rest = [];
    blocks.forEach((block) => {
      if (block?.type === "image") {
        images.push(block);
      } else {
        rest.push(block);
      }
    });

    return images.length ? images.concat(rest) : blocks;
  }

  function sanitizeExportImageAlt(value) {
    const text = normalizeExportText(value).replace(/\s+/g, " ").trim();
    if (!text || isDalleMetadataText(text) || text.length > 180) {
      return "Image";
    }
    return text;
  }

  function normalizeExportImageSrc(src) {
    const value = String(src || "").trim();
    if (!value) return "";
    const fileIdMatch = value.match(/(file[-_][A-Za-z0-9_-]+)/);
    if (fileIdMatch) return fileIdMatch[1];
    if (value.startsWith("blob:") || value.startsWith("data:")) return value;
    return value.split("#")[0];
  }

  function hashExportImageIdentity(value) {
    const text = String(value || "image");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function inferExportImageSourceKind(block) {
    const sourceKind = String(block?.sourceKind || "").toLowerCase();
    if (/^(uploaded|generated|remote|data-url|fallback|blob|thumbnail)$/.test(sourceKind)) return sourceKind;
    const src = String(block?.src || "");
    if (!src) return "fallback";
    if (src.startsWith("data:")) return "data-url";
    if (src.startsWith("blob:")) return "blob";
    if (/image_generation_content|dalle|generated/i.test(src)) return "generated";
    if (block?._chatGptFileId || block?._claudeAttachmentId) return "uploaded";
    return "remote";
  }

  function ensureExportImageBlockMetadata(block, index = 0) {
    if (!block || block.type !== "image") return block;
    const sharedEnsureImageBlockMetadata = globalThis.CHATVAULT_EXPORT?.ensureImageBlockMetadata;
    if (typeof sharedEnsureImageBlockMetadata === "function") {
      try {
        return sharedEnsureImageBlockMetadata(block, index);
      } catch (error) {
        // The export module may still be lazy-loading; keep the local fallback for content adapters.
      }
    }
    const next = {
      ...block,
      alt: sanitizeExportImageAlt(block.alt),
      normalizedSrc: block.normalizedSrc || block._chatGptFileId || block._claudeAttachmentId || normalizeExportImageSrc(block.src),
      originalIndex: block.originalIndex != null && Number.isFinite(Number(block.originalIndex)) ? Number(block.originalIndex) : index
    };
    next.sourceKind = inferExportImageSourceKind(next);
    if (!next.imageId) {
      const identity = next._chatGptFileId || next._claudeAttachmentId || next.normalizedSrc || next.src || next.alt || next.originalIndex;
      next.imageId = `img_${hashExportImageIdentity(`${next.sourceKind}:${identity}`)}`;
    }
    return next;
  }

  function getExportImageDedupKey(block) {
    if (!block || block.type !== "image") return "";
    return block._chatGptFileId ||
      block._claudeAttachmentId ||
      block.normalizedSrc ||
      normalizeExportImageSrc(block.src);
  }

  function hasExportMessageTextContent(message) {
    return (message?.contentBlocks || []).some((block) => {
      if (!block || block.type === "image") return false;
      if (block.type === "list") {
        return (block.items || []).some((item) => {
          return String(item?.text || "").trim() ||
            (item?.subItems || []).some((sub) => String(sub?.text || "").trim());
        });
      }
      if (block.type === "table") {
        return (block.headers || []).concat(...(block.rows || [])).some((cell) => String(cell || "").trim());
      }
      return String(block.text || "").trim();
    });
  }

  function filterInheritedUserImages(messages = []) {
    const priorUserImageKeys = new Set();

    return (messages || []).map((message) => {
      if (!message || message.role !== "user") {
        return message;
      }

      const hasText = hasExportMessageTextContent(message);
      const nextBlocks = [];

      (message.contentBlocks || []).forEach((block) => {
        if (block?.type !== "image") {
          nextBlocks.push(block);
          return;
        }

        const key = getExportImageDedupKey(block);
        if (hasText && key && priorUserImageKeys.has(key)) {
          return;
        }

        nextBlocks.push(block);
      });

      nextBlocks.forEach((block) => {
        if (block?.type !== "image") return;
        const key = getExportImageDedupKey(block);
        if (key) {
          priorUserImageKeys.add(key);
        }
      });

      return {
        ...message,
        contentBlocks: nextBlocks
      };
    }).filter((message) => message?.contentBlocks?.length);
  }

  function isMoreCompleteExportImageBlock(candidate, current) {
    if (!candidate || candidate.type !== "image") return false;
    if (!current || current.type !== "image") return true;
    if (!current.src && candidate.src) return true;
    if (!current.normalizedSrc && candidate.normalizedSrc) return true;
    return false;
  }

  function dedupeImageBlocksWithinMessage(blocks = []) {
    const seenKeys = new Map();
    const finalBlocks = [];

    blocks.forEach((block) => {
      if (block?.type !== "image") {
        finalBlocks.push(block);
        return;
      }

      const key = getExportImageDedupKey(block);
      if (key && seenKeys.has(key)) {
        const existingIndex = seenKeys.get(key);
        if (isMoreCompleteExportImageBlock(block, finalBlocks[existingIndex])) {
          finalBlocks[existingIndex] = block;
        }
        return;
      }
      if (key) {
        seenKeys.set(key, finalBlocks.length);
      }
      finalBlocks.push(block);
    });

    return finalBlocks;
  }

  function cloneExportMessages(messages = []) {
    return messages
      .filter((message) => message && (message.role === "user" || message.role === "assistant"))
      .map((message) => {
        const blocks = cloneExportBlocks(message.contentBlocks || []).map((block, index) => (
          block?.type === "image" ? ensureExportImageBlockMetadata(block, index) : block
        ));
        const finalBlocks = dedupeImageBlocksWithinMessage(blocks);

        const contentBlocks = orderUserImageBlocksFirst(message.role, finalBlocks);
        var clonedMessage = {
          role: message.role,
          contentBlocks
        };
        if (message.htmlStyle && typeof message.htmlStyle === "object") {
          clonedMessage.htmlStyle = { ...message.htmlStyle };
        }
        return clonedMessage;
      })
      .filter((message) => message.contentBlocks.length);
  }

  function getPresentationBlockText(block) {
    if (!block) return "";
    if (block.type === "table") {
      return (block.headers && block.headers.length ? [block.headers] : []).concat(block.rows || [])
        .map(function (row) { return (row || []).join(" "); })
        .join("\n");
    }
    if (block.type === "list") {
      return (block.items || []).map(function flatten(item) {
        if (!item) return "";
        return [item.text || ""].concat((item.subItems || []).map(flatten)).filter(Boolean).join("\n");
      }).filter(Boolean).join("\n");
    }
    return String(block.text || "");
  }

  function getPresentationMessageText(message) {
    return (message && message.contentBlocks || []).map(getPresentationBlockText).filter(Boolean).join("\n");
  }

  function normalizePresentationMatchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function stripInlineMarkdownForPresentationMatch(value) {
    return String(value || "")
      .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
      .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
      .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
      .replace(/\$([^$\n]+)\$/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(`+)([\s\S]*?)\1/g, "$2")
      .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
      .replace(/~~([\s\S]*?)~~/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
      .replace(/\\([`*_~\[\]\\])/g, "$1");
  }

  function getPresentationBlockMatchText(block) {
    var text = getPresentationBlockText(block);
    return normalizePresentationMatchText(block && block.type === "code"
      ? text
      : stripInlineMarkdownForPresentationMatch(text));
  }

  function getPresentationMessageMatchText(message) {
    return (message && message.contentBlocks || []).map(function (block) {
      return (block && block.type || "") + ":" + getPresentationBlockMatchText(block);
    }).join("\n");
  }

  function copyPagePresentation(target, source, includeHtmlStyles) {
    if (!target || !source) return;
    if (target.type === "code" && Array.isArray(source.codeSegments)) {
      var pageCodeText = source.codeSegments.map(function (segment) {
        return String(segment && segment.text || "");
      }).join("");
      if (pageCodeText && normalizePresentationMatchText(pageCodeText) === normalizePresentationMatchText(target.text)) {
        target.text = pageCodeText;
      }
    }
    if (includeHtmlStyles) {
      ["htmlStyle", "codeStyle", "codeSegments"].forEach(function (key) {
        if (source[key] != null) target[key] = source[key];
      });
    }
    if (Array.isArray(source.segments)) {
      var sourceText = source.segments.map(function (segment) { return String(segment && segment.text || ""); }).join("");
      if (normalizePresentationMatchText(sourceText) === normalizePresentationMatchText(stripInlineMarkdownForPresentationMatch(target.text))) {
        target.text = sourceText;
        target.segments = includeHtmlStyles ? source.segments : source.segments.map(function (segment) {
          var cleanSegment = segment && typeof segment === "object" ? { ...segment } : { text: String(segment || "") };
          delete cleanSegment.htmlStyle;
          delete cleanSegment.mathMl;
          return cleanSegment;
        });
      }
    }
  }

  export function mergePageHtmlPresentation(messages, pageMessages, options) {
    var output = cloneExportMessages(messages || []);
    var page = cloneExportMessages(pageMessages || []);
    var includeHtmlStyles = !options || options.includeHtmlStyles !== false;
    var usedMessageIndexes = new Set();
    var messageIndexesByKey = new Map();
    output.forEach(function (message, index) {
      var key = message.role + "\n" + getPresentationMessageMatchText(message);
      if (!messageIndexesByKey.has(key)) messageIndexesByKey.set(key, []);
      messageIndexesByKey.get(key).push(index);
    });

    page.forEach(function (pageMessage, pageIndex) {
      var pageText = getPresentationMessageMatchText(pageMessage);
      var key = pageMessage.role + "\n" + pageText;
      var candidates = messageIndexesByKey.get(key) || [];
      var matchIndex = candidates.find(function (candidateIndex) {
        return !usedMessageIndexes.has(candidateIndex);
      });
      if (!Number.isFinite(matchIndex)) matchIndex = -1;
      if (matchIndex < 0 && output[pageIndex] && output[pageIndex].role === pageMessage.role) {
        matchIndex = pageIndex;
      }
      if (matchIndex < 0 || usedMessageIndexes.has(matchIndex)) return;
      usedMessageIndexes.add(matchIndex);

      var targetMessage = output[matchIndex];
      if (includeHtmlStyles && pageMessage.htmlStyle) targetMessage.htmlStyle = pageMessage.htmlStyle;
      var usedBlockIndexes = new Set();
      (pageMessage.contentBlocks || []).forEach(function (pageBlock, blockIndex) {
        var pageBlockText = getPresentationBlockMatchText(pageBlock);
        var targetIndex = (targetMessage.contentBlocks || []).findIndex(function (candidate, candidateIndex) {
          return !usedBlockIndexes.has(candidateIndex) && candidate.type === pageBlock.type &&
            getPresentationBlockMatchText(candidate) === pageBlockText;
        });
        if (targetIndex < 0 && targetMessage.contentBlocks[blockIndex] && targetMessage.contentBlocks[blockIndex].type === pageBlock.type) {
          targetIndex = blockIndex;
        }
        if (targetIndex < 0 || usedBlockIndexes.has(targetIndex)) return;
        usedBlockIndexes.add(targetIndex);
        copyPagePresentation(targetMessage.contentBlocks[targetIndex], pageBlock, includeHtmlStyles);
      });
    });

    return output;
  }

  function extractChatGptFileId(value) {
    const raw = String(value || "").replace(/^[a-z0-9-_]+:\/\//i, "");
    const match = raw.match(/(file[-_][A-Za-z0-9_-]+)/);
    return match ? match[1] : "";
  }

  function getChatGptDownloadUrlFromPayload(value, depth = 0) {
    if (!value || depth > 4) return "";
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^(https?:\/\/|blob:|data:|\/)/i.test(trimmed)) {
        return trimmed;
      }
      return "";
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = getChatGptDownloadUrlFromPayload(item, depth + 1);
        if (nested) return nested;
      }
      return "";
    }
    if (typeof value !== "object") return "";

    const directKeys = ["download_url", "downloadUrl", "url", "href", "content_url", "contentUrl"];
    for (const key of directKeys) {
      const nested = getChatGptDownloadUrlFromPayload(value[key], depth + 1);
      if (nested) return nested;
    }
    for (const key of Object.keys(value)) {
      if (directKeys.includes(key)) continue;
      const nested = getChatGptDownloadUrlFromPayload(value[key], depth + 1);
      if (nested) return nested;
    }

    return "";
  }

  function normalizeChatGptDownloadUrl(value) {
    const url = String(value || "").trim();
    if (!url) return "";
    if (url.startsWith("/")) {
      return `${window.location.origin}${url}`;
    }
    return url;
  }

  function getChatGptConversationUnavailableMessage(status) {
    var statusLabel = status ? " (" + status + ")" : "";
    return "ChatGPT conversation is not available" + statusLabel + ". Refresh ChatGPT, make sure you are signed in, then try exporting again.";
  }

  function normalizeChatGptExportRole(message, contentBlocks = []) {
    const role = normalizeExportRole(message?.author?.role || message?.role);
    if (role) return role;
    const rawRole = String(message?.author?.role || message?.role || "").toLowerCase();
    const hasImage = (contentBlocks || []).some((block) => block?.type === "image");
    if (hasImage && /(?:tool|system)/.test(rawRole)) {
      return "assistant";
    }
    return "";
  }

  function dedupeChatGptImageOnlyEchoes(messages = []) {
    messages.forEach((message) => {
      if (!message || message.role !== "assistant") return;
      message.contentBlocks = dedupeImageBlocksWithinMessage(message.contentBlocks || []);
    });
    collapseChatGptAssistantToolImageEchoes(messages);
  }

  function getChatGptAssistantImageEchoKeys(message) {
    return (message?.contentBlocks || [])
      .filter((block) => block?.type === "image")
      .map((block, index) => getExportImageDedupKey(ensureExportImageBlockMetadata(block, index)))
      .filter(Boolean);
  }

  function isChatGptToolImageEcho(message) {
    if (!message || message.role !== "assistant") return false;
    const rawRole = String(message._chatVaultRawRole || "").toLowerCase();
    if (!/(?:tool|system)/.test(rawRole)) return false;
    const blocks = message.contentBlocks || [];
    return blocks.length > 0 && blocks.every((block) => block?.type === "image");
  }

  function collapseChatGptAssistantToolImageEchoes(messages = []) {
    const imageKeysInAssistantMessages = new Set();
    messages.forEach((message) => {
      if (!message || message.role !== "assistant" || isChatGptToolImageEcho(message)) {
        return;
      }
      getChatGptAssistantImageEchoKeys(message).forEach((key) => imageKeysInAssistantMessages.add(key));
    });

    const seenToolEchoSignatures = new Set();
    const collapsed = [];
    messages.forEach((message) => {
      if (!isChatGptToolImageEcho(message)) {
        collapsed.push(message);
        return;
      }

      const keys = getChatGptAssistantImageEchoKeys(message);
      const signature = keys.join("|");
      const mirrorsAssistantMessage = keys.length > 0 && keys.every((key) => imageKeysInAssistantMessages.has(key));
      const repeatedToolEcho = signature && seenToolEchoSignatures.has(signature);

      if (mirrorsAssistantMessage || repeatedToolEcho) {
        return;
      }
      if (signature) {
        seenToolEchoSignatures.add(signature);
      }
      collapsed.push(message);
    });

    messages.splice(0, messages.length, ...collapsed);
  }

  function mergeChatGptExportMessages(apiMessages) {
    return cloneExportMessages(apiMessages);
  }

  function mergeGeminiExportMessages(primaryMessages) {
    return cloneExportMessages(primaryMessages);
  }

  function normalizeExportRole(value) {
    const role = String(value || "").toLowerCase();
    if (/assistant|bot|model|ai/.test(role)) return "assistant";
    if (/user|human/.test(role)) return "user";
    return "";
  }

  function stripThoughtText(value) {
    return String(value || "")
      .split("\n")
      .filter((line) => !THOUGHT_LINE_PATTERN.test(line.trim()))
      .join("\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  function isInternalTurnMarker(prefix, target) {
    prefix = String(prefix || "").toLowerCase();
    target = String(target || "").toLowerCase();
    if (!target) return false;
    if (prefix === target && target.length >= 3) return true;
    if (prefix === "cite" || prefix === "citation" || prefix === "source" || prefix === "reference" || prefix === "ref") return true;
    if (!prefix && /^(?:search|source|result|open|view|news)$/.test(target)) return true;
    return false;
  }

  function stripInternalTurnMarkers(value) {
    function removeMarkers(text) {
      return String(text || "").replace(/\b([a-z][a-z0-9_]{0,30})?turn\d{1,12}([a-z][a-z0-9_]{0,30})\d+\b/gi, (match, prefix, target) => {
        return isInternalTurnMarker(prefix, target) ? "" : match;
      });
    }

    const lines = String(value || "").split(/\r?\n/);
    return lines.map((line) => removeMarkers(line))
      .filter((line, index) => line.trim() || !lines[index].trim())
      .join("\n")
      .replace(/[ \t]+([。.,，:：;；!?！？])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .trim();
  }

  function isThoughtContentValue(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    const type = String(value.type || value.content_type || value.kind || value.name || value.role || "").trim();
    if (/^(analysis|reasoning|thinking|thought|chain_of_thought|model_thought)$/i.test(type)) {
      return true;
    }

    const label = [
      value.title,
      value.label,
      value.summary,
      value.status,
      value.display_name
    ].map((item) => String(item || "")).join(" ");

    return THOUGHT_ATTR_PATTERN.test(label) || THOUGHT_LINE_PATTERN.test(label.trim());
  }

  function stripInvisibleTextControls(value) {
    return String(value || "")
      .replace(/[\u200b-\u200d\uFEFF\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/[\u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  }

  function normalizeStructuredLinkPart(value) {
    return stripInvisibleTextControls(value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function chooseStructuredLinkText(label, href) {
    const cleanLabel = normalizeStructuredLinkPart(label);
    const cleanHref = normalizeStructuredLinkPart(href);
    if (cleanLabel && cleanLabel !== cleanHref) return cleanLabel;
    return cleanHref;
  }

  function sanitizeStructuredLinkText(value) {
    let text = stripInvisibleTextControls(value);
    let previous = "";
    let guard = 0;

    while (text !== previous && guard++ < 2000) {
      previous = text;
      text = text.replace(/url\s*\ue202([^\ue202\ue201]*)\ue202([^\ue202\ue201]*)\ue201/gi, (match, label, href) => {
        return chooseStructuredLinkText(label, href) || "";
      });
      text = text.replace(/\ue202([^\ue202\ue201]*)\ue202([^\ue202\ue201]*)\ue201/g, (match, label, href) => {
        return chooseStructuredLinkText(label, href) || "";
      });
      text = text.replace(/url\s*\ue202([^\ue202\ue201]*)\ue201/gi, (match, label) => {
        return normalizeStructuredLinkPart(label);
      });
      text = text.replace(/\ue202([^\ue202\ue201]*)\ue201/g, (match, label) => {
        return normalizeStructuredLinkPart(label);
      });
    }

    return text
      .replace(/[\ue000-\uf8ff]/g, "")
      .replace(/([\u3001-\u303f\uff01-\uff1f\uff5b-\uff60])[\t \u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]+(?=\S)/g, "$1")
      .replace(/([\u3400-\u9fff]):[\t \u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]+(?=\S)/g, "$1:");
  }

  function normalizeStructuredUiKey(key) {
    return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  }

  function parseJsonObjectAt(source, startIndex) {
    const text = String(source || "");
    const start = Number(startIndex);
    if (!Number.isFinite(start) || text[start] !== "{") return null;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return {
              value: JSON.parse(text.slice(start, index + 1)),
              end: index + 1
            };
          } catch (error) {
            return null;
          }
        }
      }
    }

    return null;
  }

  function hasStructuredUiQuestionShape(value, depth = 0) {
    if (!value || depth > 5) return false;
    if (Array.isArray(value)) {
      return value.some((item) => hasStructuredUiQuestionShape(item, depth + 1));
    }
    if (typeof value !== "object") return false;

    const keys = Object.keys(value);
    const normalizedKeys = keys.map(normalizeStructuredUiKey);
    const hasQuestionText = normalizedKeys.some((key) => (
      key === "question" || key === "prompt" || key === "label" || key === "title"
    ));
    const hasChoices = normalizedKeys.some((key) => (
      key === "options" || key === "choices" || key === "items" || key === "answers"
    ));
    if (hasQuestionText && hasChoices) return true;

    for (let index = 0; index < keys.length; index += 1) {
      const key = normalizedKeys[index];
      if (key === "questions" || key === "fields" || key === "inputs" || key === "controls") {
        if (hasStructuredUiQuestionShape(value[keys[index]], depth + 1)) return true;
      }
    }

    return false;
  }

  function isStructuredUiPayloadValue(value, depth = 0, allowShapeOnly = false) {
    if (!value || typeof value !== "object" || depth > 5) return false;
    if (Array.isArray(value)) {
      return value.some((item) => isStructuredUiPayloadValue(item, depth + 1, allowShapeOnly));
    }

    const keys = Object.keys(value);
    const normalizedKeys = keys.map(normalizeStructuredUiKey);
    if (normalizedKeys.some((key) => key === "askuserinput" || key === "userinput" || key === "genui")) {
      return true;
    }

    const typeLabel = [
      value.type,
      value.content_type,
      value.kind,
      value.name,
      value.role,
      value.component,
      value.widget
    ].map((item) => String(item || "")).join(" ");
    if (/\b(?:genui|interactive|widget|component|form|input|select|multiselect|singleselect|checkbox|radio|choice|question)\b/i.test(typeLabel) &&
        hasStructuredUiQuestionShape(value, depth + 1)) {
      return true;
    }

    return Boolean(allowShapeOnly && hasStructuredUiQuestionShape(value, depth + 1));
  }

  function stripSerializedUiPayloads(value) {
    let source = String(value || "");
    if (!source) return "";
    if (!/(?:^|\b)genui\s*\{|\{\s*"|(?:^|\n)[ \t]*genui[A-Za-z0-9_-]{3,64}[ \t]*(?:\n|$)/i.test(source)) {
      return source;
    }

    const markerPattern = /\bgenui\s*(?=\{)/gi;
    let output = "";
    let cursor = 0;
    let match;
    while ((match = markerPattern.exec(source)) !== null) {
      const jsonStart = source.indexOf("{", markerPattern.lastIndex - 1);
      const parsed = parseJsonObjectAt(source, jsonStart);
      if (!parsed || !isStructuredUiPayloadValue(parsed.value, 0, true)) {
        continue;
      }
      output += source.slice(cursor, match.index).replace(/[ \t]+$/g, "");
      cursor = parsed.end;
      markerPattern.lastIndex = parsed.end;
    }

    if (cursor > 0) {
      source = output + source.slice(cursor);
    }

    const trimmed = source.trim();
    if (trimmed[0] === "{") {
      const parsedWhole = parseJsonObjectAt(trimmed, 0);
      if (parsedWhole && parsedWhole.end === trimmed.length && isStructuredUiPayloadValue(parsedWhole.value, 0, false)) {
        return "";
      }
    }

    return stripStandaloneGenUiPlaceholderTokens(source
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim());
  }

  function isStandaloneGenUiPlaceholderToken(value) {
    const text = stripInvisibleTextControls(value).trim();
    return /^genui[A-Za-z0-9_-]{3,64}$/.test(text);
  }

  function hasStandaloneGenUiPlaceholderToken(value) {
    return String(value || "").split(/\r?\n/).some((line) => isStandaloneGenUiPlaceholderToken(line));
  }

  function stripStandaloneGenUiPlaceholderTokens(value) {
    const source = String(value || "");
    if (!source || !/\bgenui[A-Za-z0-9_-]{3,64}\b/.test(source)) return source;

    let removed = false;
    const lines = source.split(/\r?\n/).filter((line) => {
      if (isStandaloneGenUiPlaceholderToken(line)) {
        removed = true;
        return false;
      }
      return true;
    });

    if (!removed) return source;
    return lines.join("\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function valueHasStandaloneGenUiPlaceholderToken(value, seen, depth = 0) {
    if (value == null || depth > 6) return false;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return hasStandaloneGenUiPlaceholderToken(value);
    }
    if (typeof value !== "object") return false;

    if (!seen) seen = new Set();
    if (seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.some((item) => valueHasStandaloneGenUiPlaceholderToken(item, seen, depth + 1));
    }

    return Object.keys(value).some((key) => valueHasStandaloneGenUiPlaceholderToken(value[key], seen, depth + 1));
  }

  function normalizeExportText(value) {
    const text = stripInternalTurnMarkers(stripThoughtText(sanitizeStructuredLinkText(stripStandaloneGenUiPlaceholderTokens(stripSerializedUiPayloads(value)))
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim()));
    return stripClaudeUnsupportedMediaPlaceholderText(text);
  }

  function stripClaudeUnsupportedMediaPlaceholderText(text) {
    let sawPlaceholder = false;
    const cleaned = String(text || "")
      .split("\n")
      .filter((line) => {
        if (isClaudeUnsupportedMediaPlaceholderText(line) || isImagePlaceholderTagText(line)) {
          sawPlaceholder = true;
          return false;
        }
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return sawPlaceholder ? cleaned : String(text || "");
  }

  function isImagePlaceholderTagText(text) {
    if (!text) return false;
    const normalized = stripInvisibleTextControls(text)
      .replace(/\s+/g, " ")
      .trim();
    return /^\[Image\]$/i.test(normalized);
  }

  function isClaudeUnsupportedMediaPlaceholderText(text) {
    if (!text) return false;
    const normalized = stripInvisibleTextControls(text)
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return false;
    return /^This block is not supported on your current device yet\.?$/i.test(normalized);
  }

  function isDalleMetadataText(text) {
    if (!text) return false;
    const trimmed = String(text).trim();

    // JSON metadata/tool calls
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && (
          parsed.size || parsed.referenced_image_ids || parsed.n || parsed.prompt ||
          parsed.open || parsed.search_query || parsed.response_length || parsed.ref_id ||
          Array.isArray(parsed.open) || Array.isArray(parsed.search_query)
        )) {
          return true;
        }
      } catch (e) {}
    }

    if (/"size"\s*:\s*"\d+x\d+"/.test(trimmed) && (/"referenced_image_ids"/.test(trimmed) || /"prompt"/.test(trimmed))) {
      return true;
    }

    if (/"response_length"\s*:\s*"/i.test(trimmed) && (/"open"/i.test(trimmed) || /"search_query"/i.test(trimmed) || /"ref_id"/i.test(trimmed))) {
      return true;
    }

    // Filter Python / Bash tool execution code
    if (/^bash\s+-lc\s+python3/i.test(trimmed)) return true;
    if (trimmed.indexOf("import requests") !== -1 && trimmed.indexOf("requests.get") !== -1) {
      if (trimmed.indexOf("<<'PY'") !== -1 || trimmed.indexOf("PY") !== -1) {
        return true;
      }
    }

    // Filter Python Tracebacks and command errors
    if (trimmed.indexOf("Traceback (most recent call last):") !== -1) return true;
    if (/socket\.gaierror:\s+\[Errno\s+-?\d+\]/i.test(trimmed)) return true;
    if (/\b(?:urllib3|requests)\.exceptions\.\w+Error:/i.test(trimmed)) return true;
    if (/HTTPSConnectionPool\(host=.*Failed\s+to\s+resolve/i.test(trimmed)) return true;
    if (/^Command\s+['"]bash\s+-lc\s+.*failed\s+with\s+status/i.test(trimmed)) return true;

    // Filter DALL-E tool output: file paths, dimensions, aspect ratios, inspection prompts
    if (/\/mnt\/data\//.test(trimmed)) return true;
    if (/\(\s*wxh\s*=/.test(trimmed)) return true;
    if (/exact aspect ratio/.test(trimmed)) return true;
    if (/visually inspect the generated image/.test(trimmed)) return true;
    if (/ghostwriter_images/.test(trimmed)) return true;
    if (/^\S+\.png\s*\(/.test(trimmed)) return true;
    // Filter DALL-E model captions / internal prompt text and watermark tokens
    if (/\<\|has_watermark\|\>/.test(trimmed)) return true;
    if (/\<\|no_watermark\|\>/.test(trimmed)) return true;
    if (/^Model caption\s*:/i.test(trimmed)) return true;
    if (/close to aspect ratio/i.test(trimmed)) return true;
    if (/^I'll create\b.*\bimage\b/i.test(trimmed) && trimmed.length < 200) return true;
    if (/^I'll generate\b.*\bimage\b/i.test(trimmed) && trimmed.length < 200) return true;
    return false;
  }

  function extractTextFromContentValue(value, seen) {
    if (value == null) {
      return "";
    }

    if (typeof value === "object") {
      if (!seen) seen = new Set();
      if (seen.has(value)) return "";
      seen.add(value);
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = stripSerializedUiPayloads(stripThoughtText(value));
      return isDalleMetadataText(text) ? "" : text;
    }

    if (Array.isArray(value)) {
      return value.map(item => extractTextFromContentValue(item, seen)).filter(Boolean).join("\n\n");
    }

    if (typeof value !== "object") {
      return "";
    }

    if (isThoughtContentValue(value)) {
      return "";
    }

    if (isStructuredUiPayloadValue(value)) {
      return "";
    }

    const directText = value.text || value.content || value.value || value.markdown || value.transcript;
    if (typeof directText === "string") {
      const text = stripSerializedUiPayloads(stripThoughtText(directText));
      return isDalleMetadataText(text) ? "" : text;
    }

    if (Array.isArray(value.parts)) {
      return value.parts.map(item => extractTextFromContentValue(item, seen)).filter(Boolean).join("\n\n");
    }

    if (Array.isArray(value.content)) {
      return value.content.map(item => extractTextFromContentValue(item, seen)).filter(Boolean).join("\n\n");
    }

    if (value.content && typeof value.content === "object") {
      return extractTextFromContentValue(value.content, seen);
    }

    if (value.message && typeof value.message === "object") {
      return extractTextFromContentValue(value.message, seen);
    }

    if (Array.isArray(value.blocks)) {
      return value.blocks.map(item => extractTextFromContentValue(item, seen)).filter(Boolean).join("\n\n");
    }

    if (Array.isArray(value.children)) {
      return value.children.map(item => extractTextFromContentValue(item, seen)).filter(Boolean).join("\n\n");
    }

    if (value.type === "image" || value.content_type === "image_asset_pointer") {
      return "";
    }

    if (value.file_name || value.filename) {
      return `[File: ${value.file_name || value.filename}]`;
    }

    return "";
  }

  function isMarkdownTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || "");
  }

  function splitMarkdownTableRow(line) {
    return String(line || "")
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function parseMarkdownTable(lines, startIndex) {
    if (!lines[startIndex + 1] || !isMarkdownTableSeparator(lines[startIndex + 1])) {
      return null;
    }

    const headers = splitMarkdownTableRow(lines[startIndex]);
    const rows = [];
    let index = startIndex + 2;

    while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) {
      rows.push(splitMarkdownTableRow(lines[index]));
      index += 1;
    }

    return {
      block: { type: "table", headers, rows },
      nextIndex: index
    };
  }

  function cleanFencedCodeText(lines) {
    const normalized = (lines || []).map((line) => String(line || "").replace(/\r$/, ""));
    while (normalized.length && !normalized[0].trim()) {
      normalized.shift();
    }
    while (normalized.length && !normalized[normalized.length - 1].trim()) {
      normalized.pop();
    }
    return normalized.join("\n");
  }

  function getClosingFenceLength(line) {
    const match = String(line || "").trim().match(/^(`{3,})\s*$/);
    return match ? match[1].length : 0;
  }

  function getOpeningCodeFenceLength(line) {
    const match = String(line || "").trim().match(/^(`{3,})([^`]*)$/);
    return match ? match[1].length : 0;
  }

  function getOpeningDirectiveFenceLength(line) {
    const trimmed = String(line || "").trim();
    const match = trimmed.match(/^(:{3,})([A-Za-z][A-Za-z0-9_-]*)([\s\S]*)$/);
    if (!match) {
      return 0;
    }
    const rest = (match[3] || "").trim();
    if (!rest) {
      return match[1].length;
    }
    if (/^(?:\{[^}]*\}|\[[^\]]*\]\s*(?:\{[^}]*\})?)$/.test(rest)) {
      return match[1].length;
    }
    return 0;
  }

  function getClosingDirectiveFenceLength(line) {
    const match = String(line || "").trim().match(/^(:{3,})\s*$/);
    return match ? match[1].length : 0;
  }

  function pushDirectiveBoundary(lines) {
    if (!lines.length || lines[lines.length - 1].trim()) {
      lines.push("");
    }
  }

  function unwrapMarkdownDirectiveContainers(value) {
    const lines = String(value || "").split("\n");
    const output = [];
    const directiveStack = [];
    let codeFenceLength = 0;

    lines.forEach((line) => {
      if (codeFenceLength > 0) {
        output.push(line);
        if (getClosingFenceLength(line) >= codeFenceLength) {
          codeFenceLength = 0;
        }
        return;
      }

      const codeOpeningLength = getOpeningCodeFenceLength(line);
      if (codeOpeningLength > 0) {
        codeFenceLength = codeOpeningLength;
        output.push(line);
        return;
      }

      const closingDirectiveLength = getClosingDirectiveFenceLength(line);
      if (directiveStack.length && closingDirectiveLength >= directiveStack[directiveStack.length - 1]) {
        directiveStack.pop();
        pushDirectiveBoundary(output);
        return;
      }

      const openingDirectiveLength = getOpeningDirectiveFenceLength(line);
      if (openingDirectiveLength > 0) {
        directiveStack.push(openingDirectiveLength);
        pushDirectiveBoundary(output);
        return;
      }

      output.push(line);
    });

    return output.join("\n");
  }

  function plainTextToExportBlocks(input, options = {}) {
    const text = normalizeExportText(unwrapMarkdownDirectiveContainers(input));
    if (!text) {
      return [];
    }

    const blocks = [];
    const lines = text.split("\n");
    let paragraph = [];
    let index = 0;

    function flushParagraph() {
      const value = paragraph.join("\n").trim();
      if (value) {
        blocks.push({ type: "paragraph", text: value });
      }
      paragraph = [];
    }

    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!trimmed) {
        flushParagraph();
        index += 1;
        continue;
      }

      // Check for Markdown images or image URLs
      const mdImgMatch = trimmed.match(/^!\[(.*?)\]\((.*?)\)$/);
      if (mdImgMatch) {
        flushParagraph();
        blocks.push({
          type: "image",
          src: mdImgMatch[2].trim(),
          alt: mdImgMatch[1].trim() || "Image"
        });
        index += 1;
        continue;
      }

      const mdLinkMatch = trimmed.match(/^\[(.*?)\]\((.*?)\)$/);
      if (mdLinkMatch) {
        const linkUrl = mdLinkMatch[2].trim();
        const isImage = /googleusercontent\.com\/image_generation_content/i.test(linkUrl) ||
                        /\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?.*)?$/i.test(linkUrl);
        if (isImage) {
          flushParagraph();
          blocks.push({
            type: "image",
            src: linkUrl,
            alt: mdLinkMatch[1].trim() || "Image"
          });
          index += 1;
          continue;
        }
      }

      if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
        const isImage = /googleusercontent\.com\/image_generation_content/i.test(trimmed) ||
                        /\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?.*)?$/i.test(trimmed);
        if (isImage) {
          flushParagraph();
          blocks.push({
            type: "image",
            src: trimmed,
            alt: "Image"
          });
          index += 1;
          continue;
        }
      }

      const fenceMatch = trimmed.match(/^(`{3,})([^`]*)$/);
      if (fenceMatch) {
        flushParagraph();
        const fenceLength = fenceMatch[1].length;
        const language = (fenceMatch[2] || "").trim();
        const codeLines = [];
        index += 1;
        while (index < lines.length && getClosingFenceLength(lines[index]) < fenceLength) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        blocks.push({ type: "code", language, text: cleanFencedCodeText(codeLines) });
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        blocks.push({
          type: "heading",
          level: Math.min(4, headingMatch[1].length),
          text: headingMatch[2].trim()
        });
        index += 1;
        continue;
      }

      const table = /\|/.test(trimmed) ? parseMarkdownTable(lines, index) : null;
      if (table) {
        flushParagraph();
        blocks.push(table.block);
        index = table.nextIndex;
        continue;
      }

      const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
      const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (unorderedMatch || orderedMatch) {
        flushParagraph();
        const ordered = Boolean(orderedMatch);
        const items = [];

        while (index < lines.length) {
          const itemLine = lines[index].trim();
          const itemMatch = ordered
            ? itemLine.match(/^\d+[.)]\s+(.+)$/)
            : itemLine.match(/^[-*+]\s+(.+)$/);
          if (!itemMatch) break;
          items.push({ text: itemMatch[1].trim(), subItems: [] });
          index += 1;
        }

        blocks.push({ type: "list", ordered, items });
        continue;
      }

      if (!options.preserveQuoteMarkers && trimmed.startsWith(">")) {
        flushParagraph();
        const quoteLines = [];
        while (index < lines.length && lines[index].trim().startsWith(">")) {
          quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
          index += 1;
        }
        blocks.push({ type: "blockquote", text: quoteLines.join("\n").trim() });
        continue;
      }

      if (/^[-*_]{3,}$/.test(trimmed)) {
        flushParagraph();
        blocks.push({ type: "separator" });
        index += 1;
        continue;
      }

      paragraph.push(line);
      index += 1;
    }

    flushParagraph();
    return blocks;
  }

  function getChatGptConversationNodes(payload) {
    const mapping = payload?.mapping && typeof payload.mapping === "object" ? payload.mapping : {};
    let currentNodeId = payload?.current_node;

    if (!currentNodeId) {
      try {
        const parentIds = new Set(
          Object.values(mapping)
            .map((node) => node?.parent)
            .filter(Boolean)
        );
        let latestLeaf = null;
        let latestTime = 0;

        Object.values(mapping).forEach((node) => {
          if (!node || !node.id) return;
          if (!parentIds.has(node.id)) {
            const time = node.message?.update_time || node.message?.create_time || node.update_time || node.create_time || 0;
            if (time > latestTime) {
              latestTime = time;
              latestLeaf = node;
            }
          }
        });

        if (latestLeaf) {
          currentNodeId = latestLeaf.id;
        }
      } catch (err) {
      }
    }

    const path = [];
    const seen = new Set();
    let node = currentNodeId ? mapping[currentNodeId] : null;

    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      path.unshift(node);
      node = node.parent ? mapping[node.parent] : null;
    }

    if (path.length) {
      return path;
    }

    return Object.values(mapping).sort((a, b) => {
      const left = a?.message?.create_time || a?.message?.update_time || 0;
      const right = b?.message?.create_time || b?.message?.update_time || 0;
      return left - right;
    });
  }

  function appendTextExportBlocks(blocks, text, options = {}) {
    plainTextToExportBlocks(text, options).forEach((block) => blocks.push(block));
  }

  function getChatGptImageBlockFromContentPart(part) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return null;
    }

    const type = String(part.content_type || part.type || "").toLowerCase();
    const pointerFileId = extractChatGptFileId(part.asset_pointer || part.file_id || part.fileId || part.id || "");
    if (type === "image_asset_pointer" && pointerFileId) {
      const fileId = pointerFileId;
      if (!fileId) return null;
      return ensureExportImageBlockMetadata({
        type: "image",
        src: "",
        alt: part.alt || part.name || "Image",
        _chatGptFileId: fileId,
        sourceKind: "generated"
      });
    }

    if (type.indexOf("image") !== -1) {
      const src = part.url || part.src || part.image_url?.url || part.source?.url || "";
      if (src) {
        const fileIdMatch = src.match(/(file[-_][A-Za-z0-9_-]+)/);
        let fileId = fileIdMatch ? fileIdMatch[1] : null;
        if (!fileId) {
          fileId = pointerFileId;
        }
        return ensureExportImageBlockMetadata({
          type: "image",
          src,
          alt: part.alt || part.name || "Image",
          sourceKind: type.indexOf("generation") !== -1 ? "generated" : "remote",
          ...(fileId ? { _chatGptFileId: fileId } : {})
        });
      }
      if (pointerFileId) {
        const isGenerated = type.indexOf("generation") !== -1 || type === "image_asset_pointer" || Boolean(part.metadata?.dalle);
        return ensureExportImageBlockMetadata({
          type: "image",
          src: "",
          alt: part.alt || part.name || "Image",
          _chatGptFileId: pointerFileId,
          sourceKind: isGenerated ? "generated" : "uploaded"
        });
      }
    }

    return null;
  }

  function collectChatGptImageBlocksFromValue(value, imageBlocks = [], seenObjects = new WeakSet()) {
    if (!value || typeof value !== "object") {
      return imageBlocks;
    }
    if (seenObjects.has(value)) {
      return imageBlocks;
    }
    seenObjects.add(value);

    if (Array.isArray(value)) {
      value.forEach((item) => collectChatGptImageBlocksFromValue(item, imageBlocks, seenObjects));
      return imageBlocks;
    }

    const directImage = getChatGptImageBlockFromContentPart(value);
    if (directImage) {
      imageBlocks.push(directImage);
    }

    ["parts", "content", "items", "children", "images", "attachments", "files"].forEach((key) => {
      const nested = value[key];
      if (nested && typeof nested === "object") {
        collectChatGptImageBlocksFromValue(nested, imageBlocks, seenObjects);
      }
    });

    return imageBlocks;
  }

  function getChatGptAttachmentImageBlocks(message) {
    const attachments = message?.metadata?.attachments;
    if (!Array.isArray(attachments)) {
      return [];
    }

    return attachments
      .map((att) => {
        const mimeType = String(att?.mime_type || att?.mimeType || att?.file_type || "").toLowerCase();
        const fileName = String(att?.name || att?.file_name || att?.filename || "");
        const isImage = mimeType.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName);
        const rawFileId = String(att?.id || att?.file_id || att?.fileId || "").replace(/^[a-z0-9-_]+:\/\//i, "");
        const fileId = extractChatGptFileId(rawFileId) || rawFileId;
        if (!isImage || !fileId) {
          return null;
        }
        return ensureExportImageBlockMetadata({
          type: "image",
          src: "",
          alt: fileName || "Attached Image",
          _chatGptFileId: fileId,
          sourceKind: "uploaded"
        });
      })
      .filter(Boolean);
  }

  function getChatGptContentPartTypeLabel(part) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return "";
    }

    return [
      part.content_type,
      part.type,
      part.kind,
      part.name,
      part.role,
      part.channel,
      part.recipient,
      part.target,
      part.metadata?.type,
      part.metadata?.content_type,
      part.metadata?.recipient
    ].map((item) => String(item || "")).join(" ").trim().toLowerCase();
  }

  function isChatGptVisibleTextPartType(typeLabel) {
    const label = String(typeLabel || "").toLowerCase();
    if (!label) return false;
    return /(?:^|\s)(?:text|markdown|paragraph|message|multimodal_text|input_text|output_text|audio_transcript|transcript)(?:\s|$)/.test(label);
  }

  function hasChatGptControlPartFields(part) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return false;
    }

    return Boolean(
      part.recipient ||
      part.target ||
      part.channel === "tool" ||
      part.arguments ||
      part.args ||
      part.parameters ||
      part.input ||
      part.tool_call_id ||
      part.call_id ||
      part.callId ||
      part.tool_name ||
      part.toolName ||
      part.function_call ||
      part.action ||
      part.metadata?.recipient ||
      part.metadata?.tool_call_id ||
      part.metadata?.call_id ||
      part.metadata?.tool_name ||
      part.metadata?.function_call
    );
  }

  function isChatGptInternalContentPart(part) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return false;
    }

    if (isThoughtContentValue(part) || isStructuredUiPayloadValue(part)) {
      return true;
    }

    const typeLabel = getChatGptContentPartTypeLabel(part);
    if (/\b(?:tool|function|recipient|web[_ -]?(?:search|browse)|browser|code[_ -]?interpreter|execution|command|system|analysis|reasoning|thought|widget|component|canvas|artifact)\b/i.test(typeLabel)) {
      return true;
    }

    return hasChatGptControlPartFields(part) && !isChatGptVisibleTextPartType(typeLabel);
  }

  function shouldExtractChatGptTextPart(part) {
    if (part == null) return false;
    if (typeof part === "string" || typeof part === "number" || typeof part === "boolean") return true;
    if (Array.isArray(part)) return true;
    if (typeof part !== "object") return false;
    if (getChatGptImageBlockFromContentPart(part)) return false;
    if (isChatGptInternalContentPart(part)) return false;

    const typeLabel = getChatGptContentPartTypeLabel(part);
    if (typeLabel) {
      return isChatGptVisibleTextPartType(typeLabel);
    }

    return true;
  }

  function extractTextFromChatGptContentPart(part) {
    if (!shouldExtractChatGptTextPart(part)) {
      return "";
    }

    return extractTextFromContentValue(part);
  }

  function chatGptMessageToExportBlocks(message) {
    const blocks = [];
    const content = message?.content;
    const parts = Array.isArray(content?.parts) ? content.parts : null;
    const seenFileIds = new Set();
    const preserveQuoteMarkers = String(message?.author?.role || "").toLowerCase() === "user";
    const textOptions = { preserveQuoteMarkers };

    if (parts) {
      parts.forEach((part) => {
        const imageBlock = getChatGptImageBlockFromContentPart(part);
        if (imageBlock) {
          if (imageBlock._chatGptFileId) {
            seenFileIds.add(imageBlock._chatGptFileId);
          }
          blocks.push(imageBlock);
          return;
        }
        appendTextExportBlocks(blocks, extractTextFromChatGptContentPart(part), textOptions);
      });
    } else {
      appendTextExportBlocks(blocks, extractTextFromChatGptContentPart(content), textOptions);
    }

    collectChatGptImageBlocksFromValue(content)
      .filter((block) => {
        const key = block._chatGptFileId || block.src || "";
        if (!key || seenFileIds.has(key)) {
          return false;
        }
        seenFileIds.add(key);
        return true;
      })
      .forEach((block) => blocks.push(block));

    const attachmentBlocks = getChatGptAttachmentImageBlocks(message)
      .filter((block) => {
        if (!block._chatGptFileId || seenFileIds.has(block._chatGptFileId)) {
          return false;
        }
        seenFileIds.add(block._chatGptFileId);
        return true;
      });

    if (attachmentBlocks.length) {
      const role = normalizeExportRole(message?.author?.role);
      if (role === "user") {
        blocks.unshift(...attachmentBlocks);
      } else {
        blocks.push(...attachmentBlocks);
      }
    }

    const finalBlocks = [];
    const seenImageKeys = new Map();

    blocks.forEach((block) => {
      if (block?.type === "image") {
        const imageBlock = ensureExportImageBlockMetadata(block, finalBlocks.length);
        const key = getExportImageDedupKey(imageBlock);
        if (key && seenImageKeys.has(key)) {
          const existingIndex = seenImageKeys.get(key);
          if (isMoreCompleteExportImageBlock(imageBlock, finalBlocks[existingIndex])) {
            finalBlocks[existingIndex] = imageBlock;
          }
          return;
        }
        if (key) {
          seenImageKeys.set(key, finalBlocks.length);
        }
        imageBlock.originalIndex = finalBlocks.length;
        finalBlocks.push(imageBlock);
      } else {
        finalBlocks.push(block);
      }
    });

    return finalBlocks;
  }

  function getPlatformTimerApi() {
    const hasWindowTimers = typeof window !== "undefined" &&
      typeof window.setTimeout === "function" &&
      typeof window.clearTimeout === "function";
    return {
      set: hasWindowTimers ? window.setTimeout.bind(window) : setTimeout,
      clear: hasWindowTimers ? window.clearTimeout.bind(window) : clearTimeout
    };
  }

  function withPlatformTimeout(promise, timeoutMs, timeoutMessage) {
    if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) {
      return promise;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timerApi = getPlatformTimerApi();
      const timeoutId = timerApi.set(() => {
        if (settled) return;
        settled = true;
        reject(new Error(timeoutMessage));
      }, Number(timeoutMs));

      promise.then((value) => {
        if (settled) return;
        settled = true;
        timerApi.clear(timeoutId);
        resolve(value);
      }).catch((error) => {
        if (settled) return;
        settled = true;
        timerApi.clear(timeoutId);
        reject(error);
      });
    });
  }

  function readPlatformResponseBody(response, bodyType, platformLabel, timeoutMs = PLATFORM_EXPORT_REQUEST_TIMEOUT_MS) {
    const label = platformLabel || "Platform";
    const reader = bodyType === "blob"
      ? response.blob()
      : bodyType === "text"
        ? response.text()
        : response.json();
    return withPlatformTimeout(reader, timeoutMs, `${label} response timed out. Refresh ${label} and try again.`);
  }

  async function fetchPlatformConversationPayload(url, options = {}, platformLabel = "Platform", responseType = "json") {
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Number(options.timeoutMs)
      : PLATFORM_EXPORT_REQUEST_TIMEOUT_MS;
    const fetchOptions = { ...options };
    delete fetchOptions.timeoutMs;

    let timedOut = false;
    let timeoutId = null;
    let controller = null;
    let abortListener = null;
    const timerApi = getPlatformTimerApi();

    if (typeof AbortController !== "undefined" && timeoutMs > 0) {
      controller = new AbortController();
      timeoutId = timerApi.set(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      if (fetchOptions.signal) {
        abortListener = () => controller.abort();
        if (fetchOptions.signal.aborted) {
          controller.abort();
        } else {
          fetchOptions.signal.addEventListener("abort", abortListener, { once: true });
        }
      }
      fetchOptions.signal = controller.signal;
    }

    try {
      const response = await fetch(url, fetchOptions);
      if (!response.ok || responseType === "none") {
        return { response, body: null };
      }

      const body = await readPlatformResponseBody(response, responseType, platformLabel, timeoutMs);
      return { response, body };
    } catch (error) {
      if (timedOut || error?.name === "AbortError") {
        throw new Error(`${platformLabel} conversation request timed out. Refresh ${platformLabel} and try again.`);
      }
      throw error;
    } finally {
      if (timeoutId !== null) {
        timerApi.clear(timeoutId);
      }
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  function getClaudeOrganizationIdFromPayload(payload) {
    const candidates = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.organizations)
        ? payload.organizations
        : Array.isArray(payload?.data)
          ? payload.data
          : payload?.current_organization
            ? [payload.current_organization]
            : payload
              ? [payload]
              : [];
    const active = candidates.find((item) => item?.active || item?.is_active || item?.uuid || item?.id) || candidates[0];
    return active?.uuid || active?.id || active?.organization_uuid || active?.organizationId || "";
  }

  async function getClaudeOrganizationIdForExport() {
    const { response, body } = await fetchPlatformConversationPayload(`${window.location.origin}/api/organizations`, {
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    }, "Claude", "json");

    if (!response.ok) {
      throw new Error(`Claude organization request failed: ${response.status}`);
    }

    const organizationId = getClaudeOrganizationIdFromPayload(body);
    if (!organizationId) {
      throw new Error("Claude organization could not be resolved for export.");
    }

    return organizationId;
  }

  function getClaudeMessagesFromPayload(payload) {
    if (Array.isArray(payload?.chat_messages)) return payload.chat_messages;
    if (Array.isArray(payload?.messages)) return payload.messages;
    if (Array.isArray(payload?.conversation?.chat_messages)) return payload.conversation.chat_messages;
    if (Array.isArray(payload?.conversation?.messages)) return payload.conversation.messages;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  function extractImagesFromClaudeMessage(message, organizationId, rawConversationId) {
    const images = [];
    if (!message) return images;

    // Helper to process a file reference
    function processFileItem(item) {
      if (!item) return;

      const fileKind = String(item.file_kind || item.kind || "").toLowerCase();
      const fileType = String(item.file_type || item.mime_type || item.mediaType || "").toLowerCase();
      const fileName = String(item.file_name || item.name || item.fileName || "").toLowerCase();

      // Determine if it is an image using file_kind, file_type or file extension
      const isImage = fileKind.indexOf("image") !== -1 ||
                      fileType.indexOf("image/") !== -1 ||
                      /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(fileName);

      const itemId = item.uuid || item.id || item.file_uuid;

      if (isImage && itemId) {
        // Try every possible URL field, prioritize preview_url and preview_asset.url for Claude
        let src = item.preview_url ||
                  (item.preview_asset && item.preview_asset.url) ||
                  item.url ||
                  item.download_url ||
                  item.src ||
                  item.content_url ||
                  item.file_url ||
                  item.media_url ||
                  item.presigned_url ||
                  item.thumbnail_url ||
                  item.rendered_url || "";

        // Ensure relative URLs are made absolute using location.origin
        if (src && typeof src === "string") {
          src = src.trim();
          if (src.startsWith("/")) {
            src = window.location.origin + src;
          }
        }

        if (!src && organizationId && rawConversationId) {
          // Construct a placeholder - will be resolved later by tryFetchClaudeAttachment
          src = "__claude_attachment__\n" + organizationId + "\n" + rawConversationId + "\n" + itemId;
        }

        if (src) {
          images.push(ensureExportImageBlockMetadata({
            type: "image",
            src: src,
            alt: item.file_name || item.name || item.fileName || "Attachment Image",
            _claudeAttachmentId: itemId,
            _claudeOrgId: organizationId,
            _claudeConvId: rawConversationId,
            sourceKind: "uploaded"
          }, images.length));
        }
      }
    }

    // 1. Check attachments array
    const attachments = message.attachments;
    if (Array.isArray(attachments)) {
      attachments.forEach(processFileItem);
    }

    // 2. Check files array (alternate naming in some Claude endpoints)
    const files = message.files;
    if (Array.isArray(files)) {
      files.forEach(processFileItem);
    }

    // 3. Check content array for rich items (images with base64 or URL)
    const content = message.content;
    if (Array.isArray(content)) {
      content.forEach((item) => {
        if (!item) return;
        const isImage = item.type === "image" || item.content_type === "image";
        if (isImage) {
          let src = item.url || item.src || "";
          if (!src && item.source) {
            if (item.source.type === "base64" && item.source.data && item.source.media_type) {
              src = `data:${item.source.media_type};base64,${item.source.data}`;
            }
          }
          if (src) {
            images.push(ensureExportImageBlockMetadata({
              type: "image",
              src: src,
              alt: item.alt || "Image",
              sourceKind: src.startsWith("data:") ? "data-url" : "remote"
            }, images.length));
          }
        }
      });
    }

    return images;
  }

  function getClaudeImageKey(block) {
    return block?._claudeAttachmentId || block?.src || "";
  }

  function appendClaudeImageBlocks(blocks, images, seenImages) {
    images.forEach((image) => {
      const key = getClaudeImageKey(image);
      if (key && seenImages.has(key)) {
        return;
      }
      if (key) {
        seenImages.add(key);
      }
      blocks.push(ensureExportImageBlockMetadata({ ...image }, blocks.length));
    });
  }

  function markImageBlockLoadFailed(block, fallbackLabel = "Attachment") {
    block.type = "paragraph";
    block.text = `[Image: ${sanitizeExportImageAlt(block.alt || fallbackLabel)} - Load Failed]`;
    block.sourceKind = "fallback";
    delete block.src;
  }

  function isClaudeImageContentType(contentType) {
    const type = String(contentType || "").toLowerCase();
    return type.indexOf("image/") !== -1 || type.indexOf("application/octet-stream") !== -1;
  }

  function getResponseContentLength(response) {
    const size = Number(response && response.headers && response.headers.get("content-length") || 0);
    return Number.isFinite(size) && size > 0 ? size : 0;
  }

  async function readClaudeImageResponse(response, label = "Claude attachment") {
    const contentType = String(response && response.headers && response.headers.get("content-type") || "");
    if (!isClaudeImageContentType(contentType)) {
      return null;
    }

    const contentLength = getResponseContentLength(response);
    if (contentLength > CLAUDE_ATTACHMENT_MAX_BYTES) {
      return null;
    }

    const blob = await readPlatformResponseBody(response, "blob", label, CLAUDE_ATTACHMENT_FETCH_TIMEOUT_MS);
    const blobSize = Number(blob && blob.size || 0);
    if (blobSize <= 100 || blobSize > CLAUDE_ATTACHMENT_MAX_BYTES) {
      return null;
    }

    const buffer = await withPlatformTimeout(
      blob.arrayBuffer(),
      CLAUDE_ATTACHMENT_FETCH_TIMEOUT_MS,
      label + " response timed out. Refresh Claude and try again."
    );
    return { buffer, mimeType: contentType.indexOf("image/") !== -1 ? contentType : "image/png" };
  }

  async function fetchClaudeImageResource(url, label = "Claude attachment") {
    const result = await fetchPlatformConversationPayload(url, {
      credentials: "include",
      headers: { Accept: "image/*,*/*" },
      timeoutMs: CLAUDE_ATTACHMENT_FETCH_TIMEOUT_MS
    }, label, "none");
    if (!result.response.ok) {
      return null;
    }
    return readClaudeImageResponse(result.response, label);
  }

  function claudeMessageToExportBlocks(message, organizationId = "", rawConversationId = "") {
    const blocks = [];
    const seenImages = new Set();
    const role = normalizeExportRole(message?.sender || message?.role || message?.author || message?.type);
    const detachedImages = extractImagesFromClaudeMessage({
      attachments: message?.attachments,
      files: message?.files
    }, organizationId, rawConversationId);
    const content = message?.content;

    if (role === "user" && detachedImages.length) {
      appendClaudeImageBlocks(blocks, detachedImages, seenImages);
    }

    if (Array.isArray(content)) {
      content.forEach((item) => {
        const contentImages = extractImagesFromClaudeMessage({ content: [item] }, organizationId, rawConversationId);
        if (contentImages.length) {
          appendClaudeImageBlocks(blocks, contentImages, seenImages);
          return;
        }
        appendTextExportBlocks(blocks, extractTextFromContentValue(item));
      });
    } else {
      appendTextExportBlocks(blocks, extractTextFromContentValue(
        message?.text ||
        content ||
        message?.message ||
        message?.parts
      ));
    }

    if (role !== "user" && detachedImages.length) {
      appendClaudeImageBlocks(blocks, detachedImages, seenImages);
    }

    return orderUserImageBlocksFirst(role, blocks);
  }

  async function tryFetchClaudeAttachment(organizationId, conversationId, attachmentId) {
    const origin = window.location.origin;
    const orgEnc = encodeURIComponent(organizationId);
    const convEnc = encodeURIComponent(conversationId);
    const attEnc = encodeURIComponent(attachmentId);

    // Try multiple possible Claude attachment download URL patterns
    const candidateUrls = [
      `${origin}/api/organizations/${orgEnc}/chat_conversations/${convEnc}/attachments/${attEnc}/content`,
      `${origin}/api/organizations/${orgEnc}/chat_conversations/${convEnc}/attachments/${attEnc}`,
      `${origin}/api/organizations/${orgEnc}/chat_conversations/${convEnc}/files/${attEnc}/content`,
      `${origin}/api/organizations/${orgEnc}/chat_conversations/${convEnc}/files/${attEnc}`,
      `${origin}/api/organizations/${orgEnc}/files/${attEnc}/content`,
      `${origin}/api/organizations/${orgEnc}/files/${attEnc}`,
      `${origin}/api/files/${attEnc}`
    ];

    for (const url of candidateUrls) {
      try {
        const result = await fetchPlatformConversationPayload(url, {
          credentials: "include",
          headers: { Accept: "image/*,*/*" },
          timeoutMs: CLAUDE_ATTACHMENT_FETCH_TIMEOUT_MS
        }, "Claude attachment", "none");
        const response = result.response;
        if (!response.ok) {
          continue;
        }
        const contentType = response.headers.get("content-type") || "";
        // If the response is JSON, it might be metadata rather than the image itself
        if (contentType.indexOf("application/json") !== -1) {
          const json = await readPlatformResponseBody(response, "json", "Claude attachment", CLAUDE_ATTACHMENT_FETCH_TIMEOUT_MS);
          // Check if JSON contains a URL to the actual image
          const imageUrl = json.url || json.download_url || json.presigned_url || json.content_url || "";
          if (imageUrl) {
            const imageResult = await fetchClaudeImageResource(imageUrl, "Claude attachment image");
            if (imageResult) return imageResult;
          }
          continue;
        }
        // Response is binary image data
        const binaryResult = await readClaudeImageResponse(response, "Claude attachment");
        if (binaryResult) return binaryResult;
      } catch (err) {
      }
    }
    return null;
  }

  async function fetchDirectImageUrl(url) {
    try {
      const result = await fetchPlatformConversationPayload(url, {
        credentials: "include",
        headers: { Accept: "image/*,*/*" },
        timeoutMs: CLAUDE_ATTACHMENT_FETCH_TIMEOUT_MS
      }, "Claude attachment", "none");
      const response = result.response;
      if (!response.ok) {
        return null;
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.indexOf("application/json") !== -1) {
        const json = await readPlatformResponseBody(response, "json", "Claude attachment", CLAUDE_ATTACHMENT_FETCH_TIMEOUT_MS);
        const imageUrl = json.url || json.download_url || json.presigned_url || json.content_url || "";
        if (imageUrl) {
          return fetchClaudeImageResource(imageUrl, "Claude attachment image");
        }
        return null;
      }
      return readClaudeImageResponse(response, "Claude attachment");
    } catch (err) {
    }
    return null;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async function resolveClaudeImageBlocks(messages) {
    const downloadJobs = [];

    function pushClaudeImageJob(block, loader) {
      downloadJobs.push(async function () {
        const result = await loader();
        if (result) {
          block.src = `data:${result.mimeType};base64,${arrayBufferToBase64(result.buffer)}`;
        } else {
          markImageBlockLoadFailed(block, "Attachment");
        }
      });
    }

    messages.forEach((msg) => {
      if (!msg || !Array.isArray(msg.contentBlocks)) return;
      msg.contentBlocks.forEach((block) => {
        if (block.type !== "image") return;

        // 1. Check placeholder URLs
        if (block.src && block.src.startsWith("__claude_attachment__\n")) {
          const raw = block.src.slice("__claude_attachment__\n".length);
          const parts = raw.split("\n");
          const orgId = parts[0] || "";
          const convId = parts[1] || "";
          const attId = parts[2] || "";
          pushClaudeImageJob(block, function () {
            return tryFetchClaudeAttachment(orgId, convId, attId);
          });
        }
        // 2. Check direct /api/ images URLs
        else if (block.src && block.src.includes("/api/") && block.src.startsWith("http")) {
          const src = block.src;
          pushClaudeImageJob(block, function () {
            return fetchDirectImageUrl(src);
          });
        }
        // 3. Fallback when there's an api path but is relative or needs parameters resolved
        else if (block._claudeAttachmentId && block.src && block.src.indexOf("/api/") !== -1) {
          const attId = block._claudeAttachmentId;
          const orgId = block._claudeOrgId;
          const convId = block._claudeConvId;
          if (orgId && convId && attId) {
            pushClaudeImageJob(block, function () {
              return tryFetchClaudeAttachment(orgId, convId, attId);
            });
          }
        }
      });
    });

    if (downloadJobs.length > 0) {
      await mapLimit(downloadJobs, CLAUDE_ATTACHMENT_CONCURRENCY, function (job) {
        return job();
      });
    }

    // Clean up internal metadata fields
    messages.forEach((msg) => {
      if (!msg || !Array.isArray(msg.contentBlocks)) return;
      msg.contentBlocks.forEach((block) => {
        delete block._claudeAttachmentId;
        delete block._claudeOrgId;
        delete block._claudeConvId;
      });
    });
  }

  function parseClaudeConversationPayload(payload, organizationId = "", rawConversationId = "") {
    const rawMessages = getClaudeMessagesFromPayload(payload);
    const messages = rawMessages
      .map((message) => {
        const role = message?.sender || message?.role || message?.author || message?.type;
        const normalizedRole = normalizeExportRole(role);
        const contentBlocks = orderUserImageBlocksFirst(normalizedRole, claudeMessageToExportBlocks(message, organizationId, rawConversationId));
        return normalizedRole && contentBlocks.length
          ? {
              role: normalizedRole,
              contentBlocks
            }
          : null;
      })
      .filter(Boolean);

    return filterInheritedUserImages(messages);
  }



  function getGeminiCurrentBasePrefix() {
    const match = window.location.pathname.match(/^\/u\/\d+(?=\/|$)/);
    return match ? match[0] : "";
  }

  function getGeminiRouteForChat(chat, getConversationId) {
    const conversationId = typeof getConversationId === "function" ? getConversationId(chat) : (chat && (chat.conversationId || chat.id) || "");
    let basePrefix = getGeminiCurrentBasePrefix();
    let kind = "app";
    let sourcePath = `${basePrefix}/app/${encodeURIComponent(conversationId)}`;

    try {
      const url = new URL(chat?.url || sourcePath, window.location.origin);
      const path = url.pathname.replace(/\/+$/, "");
      const appMatch = path.match(/^(\/u\/\d+)?\/app\/([^/?#]+)/);
      const gemMatch = path.match(/^(\/u\/\d+)?\/gem\/([^/?#]+)\/([^/?#]+)/);

      if (gemMatch) {
        basePrefix = gemMatch[1] || basePrefix;
        kind = "gem";
        sourcePath = `${basePrefix}/gem/${encodeURIComponent(decodeURIComponent(gemMatch[2]))}/${encodeURIComponent(conversationId)}`;
      } else if (appMatch) {
        basePrefix = appMatch[1] || basePrefix;
        sourcePath = `${basePrefix}/app/${encodeURIComponent(conversationId)}`;
      }
    } catch (error) {
      // Keep the default route.
    }

    return {
      basePrefix,
      chatId: conversationId,
      kind,
      sourcePath
    };
  }

  function getGeminiAtToken() {
    function normalizeToken(value) {
      const token = String(value || "").trim();

      if (
        token.length < GEMINI_AT_TOKEN_MIN_LENGTH ||
        token.length > GEMINI_AT_TOKEN_MAX_LENGTH ||
        /[\s<>"'`\\]/.test(token)
      ) {
        return "";
      }

      return token;
    }

    const input = document.querySelector('input[name="at"]');
    const inputToken = normalizeToken(input?.value);
    if (inputToken) {
      return inputToken;
    }

    const html = document.documentElement?.innerHTML || "";
    const match = html.match(/"SNlM0e":"([^"]+)"/);
    return match ? normalizeToken(match[1]) : "";
  }

  function parseGeminiBatchExecutePayloads(text, rpcId) {
    let body = String(text || "");
    if (body.length > GEMINI_BATCH_RESPONSE_MAX_CHARS) {
      throw new Error("Gemini returned too much conversation data to export safely. Try exporting a shorter conversation.");
    }

    if (body.startsWith(")]}'")) {
      const newlineIndex = body.indexOf("\n");
      body = newlineIndex >= 0 ? body.slice(newlineIndex + 1) : "";
    }

    const payloads = [];
    const lines = body.split("\n").filter((line) => line.trim());

    for (let index = 0; index < lines.length;) {
      const length = Number.parseInt(lines[index], 10);
      const jsonLine = Number.isFinite(length) ? lines[index + 1] : lines[index];
      index += Number.isFinite(length) ? 2 : 1;

      let segment;
      try {
        segment = JSON.parse(jsonLine || "");
      } catch (error) {
        continue;
      }

      if (!Array.isArray(segment)) {
        continue;
      }

      segment.forEach((entry) => {
        if (!Array.isArray(entry) || entry[0] !== "wrb.fr" || entry[1] !== rpcId || typeof entry[2] !== "string") {
          return;
        }

        try {
          payloads.push(JSON.parse(entry[2]));
        } catch (error) {
          // Ignore malformed RPC payloads.
        }
      });
    }

    return payloads;
  }

  function isGeminiPayloadImageUrl(url) {
    const src = String(url || "").trim();
    if (!/^https?:\/\//i.test(src)) return false;
    if (!(src.indexOf("googleusercontent.com") !== -1 || /lh\d+\.google\.com/i.test(src))) return false;
    return !/(favicon|googleusercontent\.com\/a\/|googleusercontent\.com\/a-|\/ogw\/|immersive_entry_chip|entry_chip|logo|sprite|emoji)/i.test(src);
  }

  function getGeminiPayloadUrls(text) {
    const urls = [];
    String(text || "").replace(/https?:\/\/[^\s"'<>\\\])]+/g, (match) => {
      const cleaned = match.replace(/[),.;:!?]+$/g, "");
      if (cleaned) urls.push(cleaned);
      return match;
    });
    return urls;
  }

  function stripGeminiPayloadImageUrls(text) {
    return String(text || "").replace(/https?:\/\/[^\s"'<>\\\])]+/g, (match) => {
      const cleaned = match.replace(/[),.;:!?]+$/g, "");
      return isGeminiPayloadImageUrl(cleaned) ? "" : match;
    });
  }

  const GEMINI_MIME_TYPE_PATTERN = /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|tiff|avif|heic|heif)$/i;
  const GEMINI_BASE64_BLOB_PATTERN = /^\$[A-Za-z0-9+/=]{20,}$/;
  const GEMINI_IMAGE_FILENAME_PATTERN = /^image_[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp|bmp|tiff|avif|heic|heif)$/i;
  const GEMINI_ATTACHMENT_FILENAME_PATTERN = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|avif|heic|heif)$/i;
  const GEMINI_PAYLOAD_CONTENT_KEYS = ["parts", "content", "message", "blocks", "children"];
  const GEMINI_PAYLOAD_MEDIA_KEY_PATTERN = /^(?:image|images|imageUrl|image_url|imageUri|image_uri|img|src|url|uri|media|attachment|attachments|file|files|thumbnail|thumbnails)$/i;

  function isGeminiInlineImageArray(value) {
    if (!Array.isArray(value)) return false;
    if (value.length < 2 || value.length > 4) return false;
    const first = String(value[0] || "");
    const second = String(value[1] || "");
    if (GEMINI_IMAGE_FILENAME_PATTERN.test(first) && GEMINI_BASE64_BLOB_PATTERN.test(second)) return true;
    if (GEMINI_BASE64_BLOB_PATTERN.test(first)) return true;
    if (value.length >= 3 && GEMINI_BASE64_BLOB_PATTERN.test(second) && GEMINI_MIME_TYPE_PATTERN.test(String(value[2] || ""))) return true;
    return false;
  }

  var GEMINI_IMAGE_GENERATION_MARKER_RE = /`?image_generation\.ImageGenerationUsecase\b/;

  function stripGeminiImageGenerationMarker(text) {
    if (!text || typeof text !== "string") return text;
    if (!GEMINI_IMAGE_GENERATION_MARKER_RE.test(text)) return text;
    var cleaned = text.replace(/\n`?image_generation\.ImageGenerationUsecase[\s\S]*$/, "").trim();
    return cleaned || text;
  }

  function normalizeGeminiAttachmentMetadataLine(text) {
    return String(text || "")
      .replace(/[\u200b-\u200d\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripGeminiAttachmentListMarker(text) {
    return normalizeGeminiAttachmentMetadataLine(text)
      .replace(/^(?:[-*+]|\u2022)\s+/, "")
      .replace(/^\d+\s*[.)\u3001\uff0e\u3002]\s*/, "")
      .trim();
  }

  function isGeminiAttachmentFilenameLine(text) {
    const value = stripGeminiAttachmentListMarker(text);
    if (!value || value.length > 180 || !GEMINI_ATTACHMENT_FILENAME_PATTERN.test(value)) return false;
    if (/^https?:\/\//i.test(value)) return false;
    if (/^(?:please|analy[sz]e|compare|summari[sz]e|explain|describe|review|check|use|open|read|请|帮|分析|对比|解释|总结|查看|打开|读取)\b/i.test(value)) {
      return false;
    }
    return true;
  }

  function stripGeminiAttachmentMetadataText(text) {
    let removed = false;
    const kept = String(text || "").split(/\n+/).filter((line) => {
      if (isGeminiAttachmentFilenameLine(line)) {
        removed = true;
        return false;
      }
      return true;
    });
    return removed ? kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() : String(text || "");
  }

  function isGeminiPayloadNoiseString(value) {
    const text = normalizeExportText(stripGeminiAttachmentMetadataText(stripGeminiPayloadImageUrls(value)));
    if (!text) return true;
    if (/^rc_[\w-]+$/i.test(text)) return true;
    if (/^(user|model|assistant|human)$/i.test(text)) return true;
    if (GEMINI_MIME_TYPE_PATTERN.test(text)) return true;
    if (GEMINI_BASE64_BLOB_PATTERN.test(text)) return true;
    if (GEMINI_IMAGE_FILENAME_PATTERN.test(text)) return true;
    if (isGeminiAttachmentFilenameLine(text)) return true;
    if (GEMINI_IMAGE_GENERATION_MARKER_RE.test(text) && text.replace(/`?image_generation\.ImageGenerationUsecase[\s\S]*/, "").trim().length < 10) return true;
    return false;
  }

  function joinGeminiPayloadTextParts(parts) {
    return normalizeExportText((parts || [])
      .map((part) => normalizeExportText(part))
      .filter(Boolean)
      .join("\n"))
      .replace(/\n{3,}/g, "\n\n");
  }

  function extractGeminiPayloadText(value) {
    if (value == null) {
      return "";
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return "";
    }

    if (typeof value === "string") {
      const text = normalizeExportText(stripGeminiAttachmentMetadataText(stripGeminiPayloadImageUrls(value)));
      return isGeminiPayloadNoiseString(text) ? "" : stripGeminiImageGenerationMarker(text);
    }

    if (Array.isArray(value)) {
      if (isGeminiInlineImageArray(value)) {
        return "";
      }
      return joinGeminiPayloadTextParts(value.map(extractGeminiPayloadText));
    }

    if (typeof value !== "object" || isThoughtContentValue(value)) {
      return "";
    }

    const directText = value.text || value.value || value.markdown || value.transcript;
    if (typeof directText === "string") {
      const text = normalizeExportText(stripGeminiAttachmentMetadataText(stripGeminiPayloadImageUrls(directText)));
      if (isGeminiPayloadNoiseString(text)) return "";
      return stripGeminiImageGenerationMarker(text);
    }

    return joinGeminiPayloadTextParts(
      GEMINI_PAYLOAD_CONTENT_KEYS
        .map((key) => value[key])
        .filter((item) => Array.isArray(item) || (item && typeof item === "object"))
        .map(extractGeminiPayloadText)
    );
  }

  function collectGeminiPayloadRealImageUrls(value, out, seen) {
    if (value == null) return;
    if (typeof value === "string") {
      getGeminiPayloadUrls(value).forEach((url) => {
        if (
          isGeminiPayloadImageUrl(url) &&
          url.indexOf("image_generation_content") === -1 &&
          !seen.has(url)
        ) {
          seen.add(url);
          out.push(url);
        }
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectGeminiPayloadRealImageUrls(item, out, seen));
      return;
    }
    if (typeof value === "object") {
      Object.keys(value).forEach((key) => collectGeminiPayloadRealImageUrls(value[key], out, seen));
    }
  }

  function collectGeminiPayloadImageBlocks(value, realImageUrls, out, seen) {
    if (value == null) return;
    if (typeof value === "string") {
      getGeminiPayloadUrls(value).forEach((url) => {
        if (!isGeminiPayloadImageUrl(url)) return;
        let finalUrl = url;
        const placeholderMatch = finalUrl.match(/image_generation_content\/(\d+)/);
        if (placeholderMatch) {
          const mappedUrl = realImageUrls[Number(placeholderMatch[1])];
          if (mappedUrl) finalUrl = mappedUrl;
        }
        if (seen.has(finalUrl)) return;
        seen.add(finalUrl);
        out.push({
          type: "image",
          alt: "Gemini Image",
          src: finalUrl
        });
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectGeminiPayloadImageBlocks(item, realImageUrls, out, seen));
      return;
    }
    if (typeof value === "object") {
      const directText = value.text || value.value || value.markdown || value.transcript;
      const hasDirectText = typeof directText === "string";
      if (hasDirectText) {
        collectGeminiPayloadImageBlocks(directText, realImageUrls, out, seen);
      }

      let usedStructuredChild = false;
      if (!hasDirectText) {
        GEMINI_PAYLOAD_CONTENT_KEYS.forEach((key) => {
          if (Array.isArray(value[key]) || (value[key] && typeof value[key] === "object")) {
            usedStructuredChild = true;
            collectGeminiPayloadImageBlocks(value[key], realImageUrls, out, seen);
          }
        });
      }

      if (usedStructuredChild) {
        return;
      }

      Object.keys(value).forEach((key) => {
        if (GEMINI_PAYLOAD_MEDIA_KEY_PATTERN.test(key)) {
          collectGeminiPayloadImageBlocks(value[key], realImageUrls, out, seen);
        }
      });
    }
  }

  function resolveGeminiPayloadImageUrl(url, realImageUrls) {
    let finalUrl = String(url || "").replace(/[),.;:!?]+$/g, "");
    const placeholderMatch = finalUrl.match(/image_generation_content\/(\d+)/);
    if (placeholderMatch) {
      const mappedUrl = realImageUrls[Number(placeholderMatch[1])];
      if (mappedUrl) finalUrl = mappedUrl;
    }
    return finalUrl;
  }

  function appendGeminiPayloadTextBlocks(out, text) {
    const normalized = normalizeExportText(stripGeminiAttachmentMetadataText(stripGeminiPayloadImageUrls(text)));
    if (!normalized || isGeminiPayloadNoiseString(normalized)) {
      return;
    }
    appendTextExportBlocks(out, normalized);
  }

  function appendGeminiPayloadStringBlocks(value, realImageUrls, out, seenImages) {
    const raw = String(value || "");
    const pattern = /https?:\/\/[^\s"'<>\\\])]+/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(raw))) {
      const cleaned = match[0].replace(/[),.;:!?]+$/g, "");
      if (!isGeminiPayloadImageUrl(cleaned)) {
        continue;
      }

      appendGeminiPayloadTextBlocks(out, raw.slice(lastIndex, match.index));
      const finalUrl = resolveGeminiPayloadImageUrl(cleaned, realImageUrls);
      if (finalUrl && !seenImages.has(finalUrl)) {
        seenImages.add(finalUrl);
        out.push({
          type: "image",
          alt: "Gemini Image",
          src: finalUrl
        });
      }
      lastIndex = match.index + match[0].length;
    }

    appendGeminiPayloadTextBlocks(out, raw.slice(lastIndex));
  }

  function appendGeminiPayloadBlocksInOrder(value, realImageUrls, out, seenImages) {
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      return;
    }

    if (typeof value === "string") {
      appendGeminiPayloadStringBlocks(value, realImageUrls, out, seenImages);
      return;
    }

    if (Array.isArray(value)) {
      if (isGeminiInlineImageArray(value)) return;
      value.forEach((item) => appendGeminiPayloadBlocksInOrder(item, realImageUrls, out, seenImages));
      return;
    }

    if (typeof value !== "object" || isThoughtContentValue(value)) {
      return;
    }

    const directText = value.text || value.value || value.markdown || value.transcript;
    const hasDirectText = typeof directText === "string";
    if (hasDirectText) {
      appendGeminiPayloadStringBlocks(directText, realImageUrls, out, seenImages);
    }

    let usedStructuredChild = false;
    if (!hasDirectText) {
      GEMINI_PAYLOAD_CONTENT_KEYS.forEach((key) => {
        if (Array.isArray(value[key]) || (value[key] && typeof value[key] === "object")) {
          usedStructuredChild = true;
          appendGeminiPayloadBlocksInOrder(value[key], realImageUrls, out, seenImages);
        }
      });
    }

    if (usedStructuredChild) {
      return;
    }

    Object.keys(value).forEach((key) => {
      if (GEMINI_PAYLOAD_MEDIA_KEY_PATTERN.test(key)) {
        appendGeminiPayloadBlocksInOrder(value[key], realImageUrls, out, seenImages);
      }
    });
  }

  function geminiPayloadValueToExportMessage(role, value, realImageUrls) {
    const normalizedRole = normalizeExportRole(role);
    const contentBlocks = [];
    const seenImages = new Set();
    appendGeminiPayloadBlocksInOrder(value, realImageUrls, contentBlocks, seenImages);

    if (!contentBlocks.length) {
      appendTextExportBlocks(contentBlocks, extractGeminiPayloadText(value));
      collectGeminiPayloadImageBlocks(value, realImageUrls, contentBlocks, new Set(contentBlocks
        .filter((block) => block?.type === "image" && block.src)
        .map((block) => block.src)));
    }

    const orderedContentBlocks = orderUserImageBlocksFirst(normalizedRole, contentBlocks);

    return normalizedRole && orderedContentBlocks.length
      ? {
          role: normalizedRole,
          contentBlocks: orderedContentBlocks
        }
      : null;
  }

  function hasGeminiPayloadContent(value) {
    const imageBlocks = [];
    collectGeminiPayloadImageBlocks(value, [], imageBlocks, new Set());
    return Boolean(extractGeminiPayloadText(value) || imageBlocks.length);
  }

  function isGeminiUserPayloadNode(node) {
    return Array.isArray(node) &&
      Array.isArray(node[0]) &&
      (node[1] === 1 || node[1] === 2) &&
      hasGeminiPayloadContent(node[0]);
  }

  function isGeminiAssistantPayloadNode(node) {
    return Array.isArray(node) &&
      typeof node[0] === "string" &&
      node[0].startsWith("rc_") &&
      Array.isArray(node[1]) &&
      hasGeminiPayloadContent(node[1]);
  }

  function getGeminiAssistantNodeFromContainer(node) {
    if (isGeminiAssistantPayloadNode(node)) {
      return node;
    }

    if (!Array.isArray(node)) {
      return null;
    }

    const candidate = Array.isArray(node[0]) && Array.isArray(node[0][0])
      ? node[0][0]
      : null;
    if (isGeminiAssistantPayloadNode(candidate)) {
      return candidate;
    }

    for (const child of node) {
      const nested = Array.isArray(child) ? getGeminiAssistantNodeFromContainer(child) : null;
      if (nested) return nested;
    }

    return null;
  }

  function isGeminiTimestampPair(node) {
    return Array.isArray(node) &&
      node.length === 2 &&
      typeof node[0] === "number" &&
      typeof node[1] === "number" &&
      node[0] > 1600000000;
  }

  function detectGeminiPayloadTurn(node) {
    if (!Array.isArray(node)) {
      return null;
    }

    let userNode = null;
    let assistantNode = null;
    let timestamp = null;

    node.forEach((child) => {
      if (!userNode && isGeminiUserPayloadNode(child)) {
        userNode = child;
      }
      if (!assistantNode) {
        assistantNode = getGeminiAssistantNodeFromContainer(child);
      }
      if (isGeminiTimestampPair(child) && (!timestamp || child[0] > timestamp[0])) {
        timestamp = child;
      }
    });

    if ((!userNode && !assistantNode) || !timestamp) {
      return null;
    }

    return {
      userValue: userNode ? userNode[0] : null,
      assistantValue: assistantNode ? assistantNode[1] : null,
      timestamp
    };
  }

  function parseGeminiConversationPayloads(payloads) {
    const turns = [];
    const seen = new Set();
    const realImageUrls = [];
    collectGeminiPayloadRealImageUrls(payloads, realImageUrls, new Set());

    function scan(node) {
      if (!Array.isArray(node)) {
        return;
      }

      const turn = detectGeminiPayloadTurn(node);
      if (turn) {
        const userImages = [];
        const assistantImages = [];
        collectGeminiPayloadImageBlocks(turn.userValue, realImageUrls, userImages, new Set());
        collectGeminiPayloadImageBlocks(turn.assistantValue, realImageUrls, assistantImages, new Set());
        const key = JSON.stringify([
          extractGeminiPayloadText(turn.userValue),
          extractGeminiPayloadText(turn.assistantValue),
          userImages.map((block) => block.src).join("|"),
          assistantImages.map((block) => block.src).join("|"),
          turn.timestamp?.[0] || 0,
          turn.timestamp?.[1] || 0
        ]);
        if (!seen.has(key)) {
          seen.add(key);
          turns.push({
            ...turn,
            order: turns.length
          });
        }
      }

      node.forEach(scan);
    }

    payloads.forEach(scan);
    turns.sort((left, right) => {
      const leftTime = left.timestamp?.[0] || 0;
      const rightTime = right.timestamp?.[0] || 0;
      if (leftTime && rightTime && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return (left.order || 0) - (right.order || 0);
    });

    const messages = turns.flatMap((turn) => {
      return [
        geminiPayloadValueToExportMessage("user", turn.userValue, realImageUrls),
        geminiPayloadValueToExportMessage("assistant", turn.assistantValue, realImageUrls)
      ].filter(Boolean);
    });

    return filterInheritedUserImages(messages);
  }




  export function createExportPlatformFetchers(options) {
    var deps = options || {};

    async function fetchChatGptConversationMessages(chat, options) {
      options = options || {};
      requireFn(deps, "ensureCanReadChatBody")(chat);
      var chatGptSession = await requireFn(deps, "getChatGptWebSession")();
      var rawConversationId = requireFn(deps, "getChatConversationId")(chat);

      if (!rawConversationId) {
        throw new Error("Conversation ID is missing for export.");
      }

      var conversationId = encodeURIComponent(rawConversationId);
      var conversationResult = await fetchPlatformConversationPayload(window.location.origin + "/backend-api/conversation/" + conversationId, {
        credentials: "include",
        headers: {
          Authorization: "Bearer " + chatGptSession.accessToken
        }
      }, "ChatGPT", "json");
      var response = conversationResult.response;

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(getChatGptConversationUnavailableMessage(response.status));
        }
        throw new Error("ChatGPT conversation request failed: " + response.status);
      }

      var payload = conversationResult.body;
      var nodes = getChatGptConversationNodes(payload);
      var messages = [];
      var fileUrlPromises = new Map();
      var pageImageSourcesByFileId = new Map();
      var pageImageSources = [];

      (options.pageMessages || []).forEach(function (message) {
        (message && message.contentBlocks || []).forEach(function (block) {
          if (!block || block.type !== "image" || !block.src) return;
          var fileId = extractChatGptFileId(block._chatGptFileId || block.normalizedSrc || block.src);
          var pageSource = {
            src: block.src,
            fileId: fileId,
            role: normalizeExportRole(message.role),
            sourceKind: String(block.sourceKind || "").toLowerCase(),
            used: false
          };
          pageImageSources.push(pageSource);
          if (fileId && !pageImageSourcesByFileId.has(fileId)) {
            pageImageSourcesByFileId.set(fileId, block.src);
          }
        });
      });

      function consumePageImageSourceByFileId(fileId) {
        if (!fileId) return "";
        for (var index = 0; index < pageImageSources.length; index += 1) {
          var source = pageImageSources[index];
          if (!source.used && source.fileId === fileId) {
            source.used = true;
            return source.src;
          }
        }
        return pageImageSourcesByFileId.get(fileId) || "";
      }

      function consumePageImageSourceForBlock(block, role) {
        if (!pageImageSources.length) return "";
        var targetRole = normalizeExportRole(role);
        var targetKind = String(block && block.sourceKind || "").toLowerCase();
        var passes = [
          function (source) { return targetRole && source.role === targetRole && targetKind && source.sourceKind === targetKind; },
          function (source) { return targetRole && source.role === targetRole; },
          function (source) { return targetKind && source.sourceKind === targetKind; },
          function () { return true; }
        ];

        for (var passIndex = 0; passIndex < passes.length; passIndex += 1) {
          for (var sourceIndex = 0; sourceIndex < pageImageSources.length; sourceIndex += 1) {
            var source = pageImageSources[sourceIndex];
            if (source.fileId) continue;
            if (!source.used && passes[passIndex](source)) {
              source.used = true;
              return source.src;
            }
          }
        }

        return "";
      }

      function getFileDownloadUrl(fileId) {
        if (!fileUrlPromises.has(fileId)) {
          fileUrlPromises.set(fileId, (async function () {
            try {
              var fileResult = await fetchPlatformConversationPayload(window.location.origin + "/backend-api/files/" + encodeURIComponent(fileId) + "/download", {
                credentials: "include",
                timeoutMs: 4000,
                headers: {
                  Authorization: "Bearer " + chatGptSession.accessToken
                }
              }, "ChatGPT file", "none");
              var fileResp = fileResult.response;
              if (!fileResp.ok) {
                return "";
              }
              var contentType = String(fileResp.headers.get("content-type") || "").toLowerCase();
              if (contentType.indexOf("application/json") !== -1 || contentType.indexOf("+json") !== -1) {
                var fileData = await readPlatformResponseBody(fileResp, "json", "ChatGPT file", 4000);
                return normalizeChatGptDownloadUrl(getChatGptDownloadUrlFromPayload(fileData));
              }
              if (contentType.indexOf("image/") !== -1 || contentType.indexOf("application/octet-stream") !== -1) {
                var blob = await readPlatformResponseBody(fileResp, "blob", "ChatGPT file", 4000);
                return URL.createObjectURL(blob);
              }
              if (fileResp.redirected && fileResp.url) {
                return fileResp.url;
              }
              if (contentType.indexOf("text/") !== -1) {
                var text = await readPlatformResponseBody(fileResp, "text", "ChatGPT file", 4000);
                return normalizeChatGptDownloadUrl(getChatGptDownloadUrlFromPayload(text));
              }
              try {
                var jsonData = await readPlatformResponseBody(fileResp.clone(), "json", "ChatGPT file", 4000);
                return normalizeChatGptDownloadUrl(getChatGptDownloadUrlFromPayload(jsonData));
              } catch (jsonErr) {
                var fallbackBlob = await readPlatformResponseBody(fileResp, "blob", "ChatGPT file", 4000);
                return fallbackBlob.size ? URL.createObjectURL(fallbackBlob) : "";
              }
            } catch (err) {
              return "";
            }
          })());
        }
        return fileUrlPromises.get(fileId);
      }

      nodes.forEach(function (node) {
        var message = node && node.message;
        if (!message) return;

        var hasUnresolvedGenUi = valueHasStandaloneGenUiPlaceholderToken(message.content);
        var contentBlocks = chatGptMessageToExportBlocks(message);
        var role = normalizeChatGptExportRole(message, contentBlocks);
        if (!role || !contentBlocks.length) return;

        var msgObj = {
          role: role,
          contentBlocks: contentBlocks,
          _chatVaultRawRole: message && (message.author && message.author.role || message.role) || ""
        };
        if (hasUnresolvedGenUi) {
          msgObj._chatVaultHasUnresolvedGenUi = true;
        }

        messages.push(msgObj);

      });

      messages = filterInheritedUserImages(messages);

      var imageBlocksByFileId = new Map();
      messages.forEach(function (msg) {
        (msg.contentBlocks || []).forEach(function (block) {
          if (block && block._chatGptFileId) {
            if (!imageBlocksByFileId.has(block._chatGptFileId)) {
              imageBlocksByFileId.set(block._chatGptFileId, []);
            }
            imageBlocksByFileId.get(block._chatGptFileId).push({ block: block, role: msg.role });
          }
        });
      });

      if (imageBlocksByFileId.size > 0) {
        var fileEntries = Array.from(imageBlocksByFileId.entries());
        await mapLimit(fileEntries, 6, async function (entry) {
          var fileId = entry[0];
          var blockEntries = entry[1];
          var downloadUrl = consumePageImageSourceByFileId(fileId) || await getFileDownloadUrl(fileId);
          if (!downloadUrl && blockEntries.length) {
            downloadUrl = consumePageImageSourceForBlock(blockEntries[0].block, blockEntries[0].role);
          }
          blockEntries.forEach(function (blockEntry) {
            var block = blockEntry.block;
            if (downloadUrl) {
              block.src = downloadUrl;
              block.normalizedSrc = fileId;
            } else {
              block.type = "paragraph";
              block.text = "[Image: " + (block.alt || "Image") + "]";
              delete block.src;
            }
          });
        });
      }

      dedupeChatGptImageOnlyEchoes(messages);

      messages.forEach(function (msg) {
        msg.contentBlocks.forEach(function (block) {
          if (block && block._chatGptFileId) {
            block.normalizedSrc = block.normalizedSrc || block._chatGptFileId;
          }
          delete block._chatGptFileId;
        });
        delete msg._chatVaultRawRole;
      });

      return messages.filter(function (msg) {
        return msg.contentBlocks && msg.contentBlocks.length > 0;
      });
    }

    async function fetchClaudeConversationMessages(chat) {
      requireFn(deps, "ensureCanReadChatBody")(chat);
      var organizationId = await getClaudeOrganizationIdForExport();
      var rawConversationId = requireFn(deps, "getChatConversationId")(chat);

      if (!rawConversationId) {
        throw new Error("Conversation ID is missing for export.");
      }

      var conversationId = encodeURIComponent(rawConversationId);
      var endpoints = [
        "/api/organizations/" + encodeURIComponent(organizationId) + "/chat_conversations/" + conversationId,
        "/api/organizations/" + encodeURIComponent(organizationId) + "/chat_conversations/" + conversationId + "?tree=true"
      ];
      var lastError = null;

      for (var index = 0; index < endpoints.length; index += 1) {
        try {
          var result = await fetchPlatformConversationPayload(window.location.origin + endpoints[index], {
            credentials: "include",
            headers: {
              Accept: "application/json"
            }
          }, "Claude", "json");

          if (!result.response.ok) {
            lastError = new Error("Claude conversation request failed: " + result.response.status);
            continue;
          }

          var messages = parseClaudeConversationPayload(result.body, organizationId, rawConversationId);
          if (messages.length) {
            await resolveClaudeImageBlocks(messages);
            return messages;
          }
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error("Claude conversation body could not be loaded.");
    }

    async function fetchGeminiConversationMessages(chat) {
      requireFn(deps, "ensureCanReadChatBody")(chat);
      var rawConversationId = requireFn(deps, "getChatConversationId")(chat);

      if (!rawConversationId) {
        throw new Error("Conversation ID is missing for export.");
      }

      var at = "";
      var maxRetries = 5;
      var retryDelayMs = 500;
      for (var attempt = 1; attempt <= maxRetries; attempt += 1) {
        at = getGeminiAtToken();
        if (at) {
          break;
        }
        if (attempt < maxRetries) {
          await new Promise(function (resolve) { setTimeout(resolve, retryDelayMs); });
        }
      }

      if (!at) {
        throw new Error("Gemini session token is missing or invalid. Please refresh the Gemini page, reopen the conversation, and try again.");
      }

      var route = getGeminiRouteForChat(chat, requireFn(deps, "getChatConversationId"));
      var conversationKey = rawConversationId.startsWith("c_") ? rawConversationId : "c_" + rawConversationId;
      var params = new URLSearchParams({
        rpcids: "hNvQHb",
        "source-path": route.sourcePath,
        hl: document.documentElement.lang || "en",
        rt: "c"
      });
      var innerArgs = JSON.stringify([conversationKey, 1000, null, 1, [1], [4], null, 1]);
      var body = new URLSearchParams({
        "f.req": JSON.stringify([[["hNvQHb", innerArgs, null, "generic"]]]),
        at: at
      });
      var fetchResult = await fetchPlatformConversationPayload(window.location.origin + route.basePrefix + "/_/BardChatUi/data/batchexecute?" + params.toString(), {
        body: body.toString() + "&",
        credentials: "include",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Same-Domain": "1"
        },
        method: "POST"
      }, "Gemini", "text");

      if (!fetchResult.response.ok) {
        throw new Error("Gemini conversation request failed: " + fetchResult.response.status);
      }

      var contentLength = Number(fetchResult.response.headers.get("content-length") || 0);
      var maxResponseChars = GEMINI_BATCH_RESPONSE_MAX_CHARS;
      if (maxResponseChars > 0 && contentLength > maxResponseChars) {
        throw new Error("Gemini returned too much conversation data to export safely. Try exporting a shorter conversation.");
      }

      var payloads = parseGeminiBatchExecutePayloads(fetchResult.body, "hNvQHb");
      var messages = parseGeminiConversationPayloads(payloads);
      if (!messages.length) {
        throw new Error("Gemini conversation body could not be loaded.");
      }

      return messages;
    }

    return {
      fetchChatGptConversationMessages: fetchChatGptConversationMessages,
      fetchClaudeConversationMessages: fetchClaudeConversationMessages,
      fetchGeminiConversationMessages: fetchGeminiConversationMessages,
      cloneExportMessages: cloneExportMessages,
      mergeChatGptExportMessages: mergeChatGptExportMessages,
      mergeGeminiExportMessages: mergeGeminiExportMessages,
      mergePageHtmlPresentation: mergePageHtmlPresentation
    };
  }
