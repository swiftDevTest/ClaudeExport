import { normalizeContent, chooseMoreCompleteBlocks, collectContentElements, getBlockSourceElement } from '../../parser-dom.js';
import { captureExportHtmlStyle } from '../../html-style.js';

export function parseClaudeMessages() {
  var messages = [];
  var seenClaudeUserImageKeys = new Set();
  var root = document.querySelector("main") || document.body;
  var selectors = [
    "[data-testid='human-message']",
    "[data-testid='user-message']",
    "[data-testid='assistant-message']",
    "[data-message-author-role='user']",
    "[data-message-author-role='assistant']",
    "[data-testid*='human-message']",
    "[data-testid*='user-message']",
    "[data-testid*='assistant-message']",
    "[data-testid*='chat-message']",
    "[class*='human-message']",
    "[class*='user-message']",
    "[class*='assistant-message']",
    "[data-is-streaming]"
  ];
  var allMessageEls = [];

  selectors.forEach(function (selector) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (el) {
      if (allMessageEls.some(function (existing) {
        return existing === el || existing.contains(el) || el.contains(existing);
      })) {
        return;
      }
      allMessageEls.push(el);
    });
  });

  if (!allMessageEls.length) {
    allMessageEls = root.querySelectorAll("[class*='human-message'], [class*='assistant-message'], [data-is-streaming]");
  }

  function getClaudeImageKey(block) {
    if (!block || block.type !== "image") return "";
    return String(block._claudeAttachmentId || block.normalizedSrc || block.src || block.alt || "").trim();
  }

  function isImageInsideFocusedContent(block, contentElements, contentEl) {
    if (!block || block.type !== "image") return true;
    var sourceEl = getBlockSourceElement(block);
    if (!sourceEl) return true;
    var owners = contentElements && contentElements.length ? contentElements : [contentEl];
    return owners.some(function (owner) {
      return owner && (sourceEl === owner || (owner.contains && owner.contains(sourceEl)));
    });
  }

  function filterClaudeFallbackBlocks(blocks, role, contentElements, contentEl) {
    return (blocks || []).filter(function (block) {
      if (!block || block.type !== "image" || role !== "user") return true;
      if (isImageInsideFocusedContent(block, contentElements, contentEl)) return true;
      var key = getClaudeImageKey(block);
      return !key || !seenClaudeUserImageKeys.has(key);
    });
  }

  function rememberClaudeUserImages(blocks) {
    (blocks || []).forEach(function (block) {
      var key = getClaudeImageKey(block);
      if (key) seenClaudeUserImageKeys.add(key);
    });
  }

  Array.prototype.forEach.call(allMessageEls, function (el) {
    var testId = el.getAttribute("data-testid") || "";
    var className = String(el.className || "");
    var authorRole = el.getAttribute("data-message-author-role") || "";
    var roleLabel = [testId, className, authorRole, el.getAttribute("aria-label") || ""].join(" ");
    var isUser = /(^|[-_\s])(human|user)([-_\s]|$)/i.test(roleLabel) ||
                 /(?:^|[-_\s])(human|user)(?:[A-Z])/i.test(roleLabel) ||
                 /(?:[a-z])(human|user)(?:[-_\s]|$)/i.test(roleLabel);
    var role = isUser ? "user" : "assistant";
    var contentElements = collectContentElements(el, [
      ".prose",
      "[class*='markdown']",
      "[data-testid='message-content']",
      "[data-testid='user-message']",
      "[data-testid='human-message']",
      "[data-testid='assistant-message']",
      "[data-testid*='code']",
      "[class*='code']",
      "[class*='font-mono']",
      "[class*='whitespace-pre']",
      "pre"
    ]);
    var contentEl = contentElements[0] || el;
    var focusedBlocks = contentElements.length
      ? contentElements.reduce(function (out, element) {
          return out.concat(normalizeContent(element));
        }, [])
      : normalizeContent(contentEl);
    var fallbackBlocks = filterClaudeFallbackBlocks(normalizeContent(el), role, contentElements, contentEl);
    var blocks = chooseMoreCompleteBlocks(focusedBlocks, fallbackBlocks);
    if (!blocks.length) return;
    if (role === "user") {
      rememberClaudeUserImages(blocks);
    }
    messages.push({
      role: role,
      htmlStyle: captureExportHtmlStyle(contentEl),
      turnElement: el,
      contentElement: contentEl,
      contentBlocks: blocks
    });
  });

  return messages;
}
