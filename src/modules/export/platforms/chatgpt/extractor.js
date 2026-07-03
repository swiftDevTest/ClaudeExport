import { normalizeContent, chooseMoreCompleteBlocks, collectContentElements, getBlockSourceElement } from '../../parser-dom.js';

var CHATGPT_TURN_SELECTOR = "[data-testid^='conversation-turn-']";
var CHATGPT_ROLE_OWNER_SELECTOR = "[data-message-author-role='user'], [data-message-author-role='assistant']";

function closestChatGptElement(element, selector) {
  if (!element || typeof element.closest !== "function") return null;
  try {
    return element.closest(selector);
  } catch (error) {
    return null;
  }
}

function getChatGptRoleOwner(turn, role, authorEl, contentEl) {
  if (authorEl) return authorEl;
  var selector = "[data-message-author-role='" + role + "']";
  return closestChatGptElement(contentEl, selector) ||
    (turn && turn.querySelector && turn.querySelector(selector)) ||
    contentEl ||
    turn;
}

function isChatGptImageOwnedBy(block, ownerEl, contentEl, turnEl) {
  if (!block || block.type !== "image") return true;
  var sourceEl = getBlockSourceElement(block);
  if (!sourceEl || typeof sourceEl.closest !== "function") return true;

  if (contentEl && (sourceEl === contentEl || (contentEl.contains && contentEl.contains(sourceEl)))) {
    return true;
  }

  if (ownerEl && (sourceEl === ownerEl || (ownerEl.contains && ownerEl.contains(sourceEl)))) {
    return true;
  }

  var sourceTurn = closestChatGptElement(sourceEl, CHATGPT_TURN_SELECTOR);
  if (turnEl && sourceTurn && sourceTurn !== turnEl) {
    return false;
  }

  var sourceOwner = closestChatGptElement(sourceEl, CHATGPT_ROLE_OWNER_SELECTOR);
  var currentOwner = closestChatGptElement(ownerEl, CHATGPT_ROLE_OWNER_SELECTOR) || ownerEl;
  if (sourceOwner && currentOwner && sourceOwner !== currentOwner) {
    return false;
  }

  return false;
}

function chooseChatGptOwnedBlocks(focusedBlocks, fallbackBlocks, ownerEl, contentEl, turnEl) {
  var scopedFallback = (fallbackBlocks || []).filter(function (block) {
    return isChatGptImageOwnedBy(block, ownerEl, contentEl, turnEl);
  });
  return chooseMoreCompleteBlocks(focusedBlocks, scopedFallback);
}

export function parseChatGPTMessages() {
  var messages = [];



  var turns = document.querySelectorAll(CHATGPT_TURN_SELECTOR);
  if (!turns.length) {
    turns = document.querySelectorAll("[data-message-author-role]");
  }

  Array.prototype.forEach.call(turns, function (turn) {
    var role = "";
    var authorEl = turn.querySelector("[data-message-author-role]") || (turn.matches && turn.matches("[data-message-author-role]") ? turn : null);
    if (authorEl) {
      role = authorEl.getAttribute("data-message-author-role") || "";
    }
    if (!role) {
      role = turn.getAttribute("data-turn") || "";
    }
    if (!role) {
      var testId = turn.getAttribute("data-testid") || "";
      if (testId.indexOf("user") !== -1 || turn.querySelector(".user-message-bubble-color")) {
        role = "user";
      } else if (testId.indexOf("assistant") !== -1 || turn.querySelector(".markdown")) {
        role = "assistant";
      }
    }
    if (role !== "user" && role !== "assistant") return;



    var contentElements = [];
    if (role === "assistant") {
      contentElements = collectContentElements(turn, [
        "[data-message-author-role='assistant'] .markdown",
        ".markdown",
        ".agent-turn",
        "[data-message-author-role='assistant']"
      ]);
    } else {
      contentElements = collectContentElements(turn, [
        "[data-message-author-role='user'] .whitespace-pre-wrap",
        ".whitespace-pre-wrap",
        "[class*='whitespace-pre']",
        "[data-message-author-role='user']"
      ]);
    }

    var contentEl = contentElements[0] || turn;
    var ownerEl = getChatGptRoleOwner(turn, role, authorEl, contentEl);
    var focusedBlocks = contentElements.length
      ? contentElements.reduce(function (out, element) {
          return out.concat(normalizeContent(element));
        }, [])
      : normalizeContent(contentEl);
    var turnBlocks = normalizeContent(turn);
    var blocks = chooseChatGptOwnedBlocks(focusedBlocks, turnBlocks, ownerEl, contentEl, turn);
    if (!blocks.length) return;
    messages.push({
      role: role,
      turnElement: turn,
      contentElement: contentEl,
      contentBlocks: blocks
    });
  });

  return messages;
}
