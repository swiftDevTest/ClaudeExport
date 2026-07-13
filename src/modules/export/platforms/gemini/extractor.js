import { isGeminiUINoiseText, isGeminiUINoiseContainer, isIgnoredRoleLabel, isIgnoredContentNode } from '../../utils.js';
import { normalizeContent, chooseMoreCompleteBlocks, collectContentElements, getBlockSourceElement } from '../../parser-dom.js';
import { captureExportHtmlStyle } from '../../html-style.js';
import { compareElementsInDocument, pushDistinctDocumentElement } from '../shared.js';

export function parseGeminiMessages() {
  var messages = [];
  var root = document.querySelector("infinite-scroller, .conversation-container, main, mat-sidenav-content, [role='main']") || document.body;
  var turnSelectors = [
    "conversation-turn",
    ".conversation-turn",
    "[class*='conversation-turn']",
    "[data-test-id='conversation-turn']"
  ];
  var userSelectors = [
    "user-query",
    "[data-test-id='user-query']",
    ".user-query",
    ".query-container",
    "[class*='query-text']",
    ".query-text",
    ".query-content",
    "[class*='query-content']",
    ".user-prompt",
    "[class*='user-prompt']",
    "[data-message-author-role='user']",
    "[data-testid*='user']",
    "[data-test-id*='user']",
    "[class*='user-message']",
    "[class*='human-message']"
  ];
  var responseSelectors = [
    "model-response",
    "[data-test-id='model-response']",
    ".model-response",
    ".response-container",
    "message-content",
    ".markdown",
    "[class*='markdown']",
    "[data-message-author-role='assistant']",
    "[data-testid*='assistant']",
    "[data-test-id*='assistant']",
    "[class*='assistant-message']",
    "[class*='model-response']"
  ];
  var turns = [];
  var seenGeminiUserImageKeys = new Set();
  var geminiAttachmentFilenamePattern = /\.(?:png|jpe?g|gif|webp|bmp|svg|tiff?|avif|heic|heif)$/i;
  var geminiTurnOwnerSelector = "conversation-turn, .conversation-turn, [class*='conversation-turn'], [data-test-id='conversation-turn']";
  var geminiUserOwnerSelector = 'user-query, [data-test-id="user-query"], .user-query, .query-container, [class*="user-query"], [class*="query-container"], [class*="query-content"], .user-prompt, [class*="user-prompt"], [data-message-author-role="user"], [data-testid*="user"], [data-test-id*="user"], [class*="user-message"], [class*="human-message"]';
  var geminiAssistantOwnerSelector = 'model-response, [data-test-id="model-response"], .model-response, .response-container, message-content, .markdown, [class*="markdown"], [data-message-author-role="assistant"], [data-testid*="assistant"], [data-test-id*="assistant"], [class*="assistant-message"], [class*="model-response"]';

  function isInsideGeminiUserElement(element) {
    return Boolean(element && element.closest && element.closest(geminiUserOwnerSelector));
  }

  function isInsideConversationTurn(element) {
    return Boolean(element && element.closest && element.closest(geminiTurnOwnerSelector));
  }

  function closestGeminiOwner(element, selector) {
    if (!element || typeof element.closest !== "function") return null;
    try {
      return element.closest(selector);
    } catch (error) {
      return null;
    }
  }

  function isElementAfter(left, right) {
    if (!left || !right || typeof left.compareDocumentPosition !== "function") return false;
    var position = left.compareDocumentPosition(right);
    return typeof Node !== "undefined" && Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function getGeminiImageKey(block) {
    if (!block || block.type !== "image") return "";
    return String(block.normalizedSrc || block.src || block.alt || "").trim();
  }

  function rememberGeminiUserImageBlocks(blocks) {
    (blocks || []).forEach(function (block) {
      var key = getGeminiImageKey(block);
      if (key) seenGeminiUserImageKeys.add(key);
    });
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
    var value = stripGeminiAttachmentListMarker(text);
    if (!value || value.length > 180 || !geminiAttachmentFilenamePattern.test(value)) return false;
    if (/^https?:\/\//i.test(value)) return false;
    if (/^(?:please|analy[sz]e|compare|summari[sz]e|explain|describe|review|check|use|open|read|请|帮|分析|对比|解释|总结|查看|打开|读取)\b/i.test(value)) {
      return false;
    }
    return true;
  }

  function stripGeminiAttachmentMetadataText(text) {
    var lines = String(text || "").split(/\n+/);
    var removed = false;
    var kept = lines.filter(function (line) {
      if (isGeminiAttachmentFilenameLine(line)) {
        removed = true;
        return false;
      }
      return true;
    });
    return removed ? kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() : String(text || "");
  }

  function filterGeminiAttachmentMetadataItems(items) {
    return (items || []).map(function (item) {
      var text = stripGeminiAttachmentMetadataText(item && item.text);
      return {
        ...item,
        text: text,
        subItems: filterGeminiAttachmentMetadataItems(item && item.subItems)
      };
    }).filter(function (item) {
      return Boolean(item && (item.text || item.subItems && item.subItems.length));
    });
  }

  function filterGeminiAttachmentMetadataBlocks(blocks, role) {
    if (role !== "user") return blocks || [];
    return (blocks || []).map(function (block) {
      if (!block || !block.type) return block;
      if (block.type === "list") {
        var items = filterGeminiAttachmentMetadataItems(block.items);
        return items.length ? { ...block, items: items } : null;
      }
      if (block.type === "image") {
        return isGeminiAttachmentFilenameLine(block.alt) ? { ...block, alt: "Uploaded Image" } : block;
      }
      if (block.type === "paragraph" || block.type === "heading" || block.type === "blockquote" || block.type === "code") {
        var text = stripGeminiAttachmentMetadataText(block.text);
        return text ? { ...block, text: text } : null;
      }
      return block;
    }).filter(Boolean);
  }

  function isGeminiBlockOwnedBy(block, ownerEl, contentEl, turnEl, ownerSelector) {
    if (!block || block.type !== "image") return true;
    var sourceEl = getBlockSourceElement(block);
    if (!sourceEl || typeof sourceEl.closest !== "function") return true;

    var sourceTurn = closestGeminiOwner(sourceEl, geminiTurnOwnerSelector);
    if (turnEl && sourceTurn && sourceTurn !== turnEl) {
      return false;
    }

    if (contentEl && (sourceEl === contentEl || (contentEl.contains && contentEl.contains(sourceEl)))) {
      return true;
    }

    var currentOwner = closestGeminiOwner(contentEl, ownerSelector) ||
      closestGeminiOwner(ownerEl, ownerSelector) ||
      ownerEl;
    var sourceOwner = closestGeminiOwner(sourceEl, ownerSelector);

    if (sourceOwner && currentOwner && sourceOwner !== currentOwner) {
      return false;
    }

    return Boolean(ownerEl && ownerEl.contains && ownerEl.contains(sourceEl));
  }

  function chooseGeminiOwnedBlocks(focusedBlocks, fallbackBlocks, ownerEl, contentEl, turnEl, role) {
    var ownerSelector = role === "assistant" ? geminiAssistantOwnerSelector : geminiUserOwnerSelector;
    var scopedFallback = (fallbackBlocks || []).filter(function (block) {
      return isGeminiBlockOwnedBy(block, ownerEl, contentEl, turnEl, ownerSelector);
    });
    return chooseMoreCompleteBlocks(focusedBlocks, scopedFallback, { minTextDelta: 8 });
  }

  function getGeminiTurnUserImageBlocks(turnEl, userEl, contentEl, responseEl) {
    if (!turnEl) return [];
    return normalizeContent(turnEl).filter(function (block) {
      if (!block || block.type !== "image") return false;
      var sourceEl = getBlockSourceElement(block);
      if (!sourceEl) return false;
      var sourceTurn = closestGeminiOwner(sourceEl, geminiTurnOwnerSelector);
      if (sourceTurn && sourceTurn !== turnEl) return false;
      if (responseEl && (sourceEl === responseEl || (responseEl.contains && responseEl.contains(sourceEl)))) {
        return false;
      }
      if (userEl && (sourceEl === userEl || (userEl.contains && userEl.contains(sourceEl)))) {
        return true;
      }
      var currentOwner = closestGeminiOwner(contentEl, geminiUserOwnerSelector) ||
        closestGeminiOwner(userEl, geminiUserOwnerSelector) ||
        userEl;
      var sourceOwner = closestGeminiOwner(sourceEl, geminiUserOwnerSelector);
      if (sourceOwner && currentOwner && sourceOwner === currentOwner) {
        return true;
      }
      if (sourceOwner && currentOwner && sourceOwner !== currentOwner) {
        return false;
      }
      if (userEl && responseEl && isElementAfter(userEl, sourceEl) && isElementAfter(sourceEl, responseEl)) {
        var key = getGeminiImageKey(block);
        return !key || !seenGeminiUserImageKeys.has(key);
      }
      return false;
    });
  }

  function getPrimaryGeminiUserContentElements(elements) {
    var list = elements || [];
    if (list.length <= 1) return list;
    var textElement = list.find(function (element) {
      var text = String(element && element.textContent || "").replace(/\s+/g, " ").trim();
      return text && !isIgnoredRoleLabel(text) && !isGeminiUINoiseText(text, element);
    });
    return textElement ? [textElement] : [list[0]];
  }

  turnSelectors.forEach(function (selector) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (el) {
      if (!isGeminiUINoiseContainer(el) && !isIgnoredContentNode(el)) {
        pushDistinctDocumentElement(turns, el);
      }
    });
  });
  turns.sort(compareElementsInDocument);

  var UNIQUE_USER_SELECTORS = [
    "user-query",
    "[data-test-id='user-query']",
    ".user-query",
    ".query-container",
    ".query-content",
    ".user-prompt",
    "[data-message-author-role='user']"
  ];
  var UNIQUE_ASSISTANT_SELECTORS = [
    "model-response",
    "[data-test-id='model-response']",
    ".model-response",
    ".response-container",
    "message-content",
    "[data-message-author-role='assistant']"
  ];

  var orphanUserEls = [];
  userSelectors.forEach(function (selector) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (element) {
      if (!isInsideConversationTurn(element) && !isGeminiUINoiseContainer(element) && !isIgnoredContentNode(element)) {
        var containsResponse = UNIQUE_ASSISTANT_SELECTORS.some(function (resSel) {
          try {
            return element !== root && element.querySelector && element.querySelector(resSel) !== null;
          } catch (e) {
            return false;
          }
        });
        if (!containsResponse) {
          pushDistinctDocumentElement(orphanUserEls, element);
        }
      }
    });
  });

  var orphanResponseEls = [];
  responseSelectors.forEach(function (selector) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (element) {
      if (!isInsideConversationTurn(element) && !isInsideGeminiUserElement(element) && !isGeminiUINoiseContainer(element) && !isIgnoredContentNode(element)) {
        var containsUser = UNIQUE_USER_SELECTORS.some(function (userSel) {
          try {
            return element !== root && element.querySelector && element.querySelector(userSel) !== null;
          } catch (e) {
            return false;
          }
        });
        if (!containsUser) {
          pushDistinctDocumentElement(orphanResponseEls, element);
        }
      }
    });
  });

  var candidates = [];
  turns.forEach(function (el) {
    candidates.push({ type: "turn", element: el });
  });
  orphanUserEls.forEach(function (el) {
    candidates.push({ type: "user", element: el });
  });
  orphanResponseEls.forEach(function (el) {
    candidates.push({ type: "assistant", element: el });
  });

  candidates.sort(function (a, b) {
    return compareElementsInDocument(a.element, b.element);
  });

  if (candidates.length) {
    Array.prototype.forEach.call(candidates, function (cand) {
      if (cand.type === "turn") {
        var turn = cand.element;
        var responseEl = responseSelectors.map(function (selector) {
          return turn.querySelector(selector);
        }).find(function (element) {
          return element && !isInsideGeminiUserElement(element);
        });

        var userEl = userSelectors.map(function (selector) {
          return turn.querySelector(selector);
        }).find(Boolean);

        if (!userEl) {
          var userCandidates = [];
          Array.prototype.forEach.call(turn.querySelectorAll("*"), function (child) {
            if (responseEl && (responseEl === child || responseEl.contains(child))) {
              return;
            }
            if (isIgnoredContentNode(child)) {
              return;
            }
            var directText = Array.prototype.slice.call(child.childNodes || []).filter(function (node) {
              return node.nodeType === 3;
            }).map(function (node) {
              return String(node.textContent || "").trim();
            }).filter(Boolean).join(" ");

            if (directText && !isIgnoredRoleLabel(directText)) {
              userCandidates.push(child);
            }
          });

          if (userCandidates.length) {
            var highestUser = userCandidates[0];
            while (highestUser.parentElement && highestUser.parentElement !== turn &&
                   (!responseEl || !highestUser.parentElement.contains(responseEl))) {
              highestUser = highestUser.parentElement;
            }
            userEl = highestUser;
          }
        }

        if (!responseEl) {
          var responseCandidates = [];
          Array.prototype.forEach.call(turn.querySelectorAll("*"), function (child) {
            if (userEl && (userEl === child || userEl.contains(child))) {
              return;
            }
            if (isIgnoredContentNode(child)) {
              return;
            }
            var directText = Array.prototype.slice.call(child.childNodes || []).filter(function (node) {
              return node.nodeType === 3;
            }).map(function (node) {
              return String(node.textContent || "").trim();
            }).filter(Boolean).join(" ");

            if (directText && !isIgnoredRoleLabel(directText)) {
              responseCandidates.push(child);
            }
          });

          if (responseCandidates.length) {
            var highestResponse = responseCandidates[0];
            while (highestResponse.parentElement && highestResponse.parentElement !== turn &&
                   (!userEl || !highestResponse.parentElement.contains(userEl))) {
              highestResponse = highestResponse.parentElement;
            }
            responseEl = highestResponse;
          }
        }

        if (userEl) {
          var contentElements = collectContentElements(userEl, [
            '.query-text',
            '[class*="query-text"]',
            '[data-test-id="user-query"]',
            '.user-query',
            '.query-container',
            '.whitespace-pre-wrap',
            '[class*="whitespace-pre"]',
            '.query-content',
            '[class*="query-content"]',
            '.user-prompt',
            '[class*="user-prompt"]'
          ]);
          contentElements = getPrimaryGeminiUserContentElements(contentElements);
          var contentEl = contentElements[0] || userEl;
          var focusedBlocks = contentElements.length
            ? contentElements.reduce(function (out, element) {
                return out.concat(normalizeContent(element));
              }, [])
            : normalizeContent(contentEl);
          var userFallbackBlocks = normalizeContent(userEl).filter(function (block) {
            return isGeminiBlockOwnedBy(block, userEl, contentEl, turn, geminiUserOwnerSelector);
          }).concat(getGeminiTurnUserImageBlocks(turn, userEl, contentEl, responseEl));
          var blocks = filterGeminiAttachmentMetadataBlocks(chooseMoreCompleteBlocks(focusedBlocks, userFallbackBlocks, { minTextDelta: 8 }), "user");
          if (blocks.length) {
            rememberGeminiUserImageBlocks(blocks);
            messages.push({
              role: "user",
              htmlStyle: captureExportHtmlStyle(contentEl),
              turnElement: turn,
              contentElement: contentEl,
              contentBlocks: blocks
            });
          }
        }

        if (responseEl) {
          var responseContentElements = collectContentElements(responseEl, [
            'message-content',
            '[data-test-id="model-response"]',
            '.model-response',
            '.response-container',
            '.markdown',
            '[class*="markdown"]',
            'pre'
          ]);
          var responseContentEl = responseContentElements[0] || responseEl;
          var responseFocusedBlocks = responseContentElements.length
            ? responseContentElements.reduce(function (out, element) {
                return out.concat(normalizeContent(element));
              }, [])
            : normalizeContent(responseContentEl);
          var responseBlocks = chooseGeminiOwnedBlocks(responseFocusedBlocks, normalizeContent(responseEl), responseEl, responseContentEl, turn, "assistant");
          if (responseBlocks.length) {
            messages.push({
              role: "assistant",
              htmlStyle: captureExportHtmlStyle(responseContentEl),
              turnElement: turn,
              contentElement: responseContentEl,
              contentBlocks: responseBlocks
            });
          }
        }
      } else {
        var role = cand.type;
        var el = cand.element;
        var selectors = role === "user"
          ? ['.query-text', '[class*="query-text"]', '[data-test-id="user-query"]', '.user-query', '.whitespace-pre-wrap', '.query-content', '[class*="query-content"]', '.user-prompt', '[class*="user-prompt"]']
          : ['message-content', '[data-test-id="model-response"]', '.model-response', '.markdown', '[class*="markdown"]', 'pre'];
        var contentElements = collectContentElements(el, selectors);
        if (role === "user") {
          contentElements = getPrimaryGeminiUserContentElements(contentElements);
        }
        var contentEl = contentElements[0] || el;
        var focusedBlocks = contentElements.length
          ? contentElements.reduce(function (out, element) {
              return out.concat(normalizeContent(element));
            }, [])
          : normalizeContent(contentEl);
        var blocks = filterGeminiAttachmentMetadataBlocks(chooseGeminiOwnedBlocks(focusedBlocks, normalizeContent(el), el, contentEl, null, role), role);
        if (blocks.length) {
          if (role === "user") {
            rememberGeminiUserImageBlocks(blocks);
          }
          messages.push({
            role: role,
            htmlStyle: captureExportHtmlStyle(contentEl),
            turnElement: el,
            contentElement: contentEl,
            contentBlocks: blocks
          });
        }
      }
    });
    return messages;
  }

  return messages;
}
