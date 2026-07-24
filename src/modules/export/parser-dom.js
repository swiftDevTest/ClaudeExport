import { isChatVaultNode, isIgnoredContentNode, isTrustedConversationImageSrc, isPlatformOrSystemIcon, isSubstantialSvg, convertSvgToDataUrl, isDalleMetadataText, isGeminiImagePlaceholderText, hasImageAttachment, cleanText, cleanInlineSegments, stripThoughtText, isIgnoredRoleLabel, isGeminiUINoiseText, isImageOrFileSignature, sanitizeExportText, decodeVisibleTextEscapes, getBlockText, getPlainText, dedupeImageBlocksWithinMessage } from './utils.js';
import { captureExportHtmlStyle, getExportHtmlStyleDifference, isExportHtmlStyleCaptureEnabled, isTransparentCssColor } from './html-style.js';

export function getElementLabel(element) {
  if (!element) return "";
  return [
    element.tagName,
    element.getAttribute && element.getAttribute("data-testid"),
    element.getAttribute && element.getAttribute("data-language"),
    element.getAttribute && element.getAttribute("aria-label"),
    element.className
  ].map(function (item) { return String(item || ""); }).join(" ");
}

export function isCodeLikeElement(element) {
  if (!element || !element.tagName) return false;
  var tag = String(element.tagName || "").toLowerCase();
  if (tag === "pre") return true;
  var label = getElementLabel(element);
  return /\b(?:code|syntax|highlight|shiki|hljs|font-mono|language-[a-z0-9_-]+)\b/i.test(label);
}

export function extractCodeLanguage(element) {
  if (!element || !element.querySelector) return "";

  var codeEl = element.matches && element.matches("code") ? element : element.querySelector("code");
  var dataLanguage = (codeEl && codeEl.getAttribute && codeEl.getAttribute("data-language")) ||
    (element.getAttribute && element.getAttribute("data-language")) ||
    "";
  if (dataLanguage) return dataLanguage;

  var label = getElementLabel(codeEl || element);
  var match = label.match(/language-([a-z0-9_-]+)/i);
  if (match) return match[1];

  // Some platforms render a visible language chip outside <code>. Keep this
  // deliberately narrow so toolbar text or prose is never mistaken for a
  // language (a prior broad "decoration span" selector caused that regression).
  var langEl = element.querySelector("[class*='code-lang'], [class*='code-language'], [class*='code-header'] [data-language], [class*='code-header'] span");
  if (langEl && langEl.textContent) {
    var txt = String((langEl.getAttribute && langEl.getAttribute("data-language")) || langEl.textContent || "")
      .trim()
      .toLowerCase()
      .replace(/^(?:language|lang|code)\s*:\s*/i, "");
    var knownLanguage = /^(?:abap|arduino|bash|basic|c|c\+\+|cpp|c#|csharp|clojure|css|dart|diff|dockerfile?|elixir|elm|erlang|f#|fortran|go|graphql|groovy|haskell|html|java|javascript|js|json|julia|kotlin|latex|less|lisp|lua|makefile|markdown|matlab|mermaid|objective-c|ocaml|perl|php|plaintext|powershell|python|py|r|ruby|rust|sass|scala|scheme|scss|shell|sql|swift|text|typescript|ts|tsx|vb\.net|verilog|vhdl|xml|yaml|yml|zsh)$/i;
    if (knownLanguage.test(txt)) {
      return txt;
    }
  }

  return "";
}

export function cleanCodeText(element) {
  if (!element) return "";
  var target = element;
  if (element.querySelector) {
    target = element.querySelector("pre code") || element.querySelector("pre") || element.querySelector("code") || element;
  }
  var clone = target.cloneNode ? target.cloneNode(true) : null;
  if (clone && clone.querySelectorAll) {
    Array.prototype.forEach.call(clone.querySelectorAll("button,svg,path,[data-testid*='copy'],[class*='copy'],[class*='toolbar'],[data-testid*='toolbar']"), function (node) {
      node.remove();
    });
  }
  return String((clone || target).textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function getCodeTextElement(element) {
  if (!element) return null;
  if (!element.querySelector) return element;
  return element.querySelector("pre code") || element.querySelector("pre") || element.querySelector("code") || element;
}

function captureCodeBlockVisualStyle(element) {
  if (!isExportHtmlStyleCaptureEnabled()) return undefined;
  var current = element && (String(element.tagName || "").toLowerCase() === "pre"
    ? element
    : element.querySelector && element.querySelector("pre") || element);
  var fallback;
  for (var depth = 0; current && depth < 5; depth += 1) {
    var style = captureExportHtmlStyle(current);
    if (!fallback && style) fallback = { ...style };
    if (style && !isTransparentCssColor(style["background-color"])) return style;
    var parent = current.parentElement;
    if (!parent) break;
    var preCount = parent.querySelectorAll ? parent.querySelectorAll("pre").length : 0;
    if (depth > 0 && preCount > 1) break;
    current = parent;
  }
  if (fallback && isTransparentCssColor(fallback["background-color"])) {
    delete fallback["background-color"];
  }
  return fallback;
}

function attachCodeBlockPresentation(block, element) {
  var result = attachBlockSource(block, element);
  var visualStyle = captureCodeBlockVisualStyle(element);
  if (visualStyle) result.htmlStyle = visualStyle;
  return result;
}

function sameCodeSegmentStyle(first, second) {
  return JSON.stringify(first && first.htmlStyle || {}) === JSON.stringify(second && second.htmlStyle || {});
}

function trimCodeSegments(segments) {
  var result = (segments || []).filter(function (segment) {
    return segment && segment.text !== "";
  }).map(function (segment) {
    return Object.assign({}, segment);
  });
  while (result.length && /^\s*$/.test(result[0].text)) result.shift();
  while (result.length && /^\s*$/.test(result[result.length - 1].text)) result.pop();
  if (!result.length) return [];
  result[0].text = result[0].text.replace(/^\s+/, "");
  result[result.length - 1].text = result[result.length - 1].text.replace(/\s+$/, "");
  return result.filter(function (segment) { return segment.text !== ""; });
}

export function extractCodeSegments(element) {
  if (!isExportHtmlStyleCaptureEnabled()) return undefined;
  var target = getCodeTextElement(element);
  if (!target) return undefined;
  var segments = [];
  var baseStyle = captureExportHtmlStyle(target);

  function push(text, htmlStyle) {
    var value = String(text || "").replace(/\u00a0/g, " ");
    if (!value) return;
    var segment = { text: value };
    if (htmlStyle) segment.htmlStyle = htmlStyle;
    var previous = segments[segments.length - 1];
    if (previous && sameCodeSegmentStyle(previous, segment)) previous.text += value;
    else segments.push(segment);
  }

  function walk(node, inheritedStyle) {
    if (!node) return;
    if (node.nodeType === 3) {
      push(node.textContent || "", getExportHtmlStyleDifference(inheritedStyle, baseStyle));
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.matches && node.matches("button,svg,path,[data-testid*='copy'],[class*='copy'],[class*='toolbar'],[data-testid*='toolbar']")) return;
    var computedStyle = captureExportHtmlStyle(node) || inheritedStyle;
    var htmlStyle = getExportHtmlStyleDifference(computedStyle, baseStyle);
    if (String(node.tagName || "").toLowerCase() === "br") {
      push("\n", htmlStyle);
      return;
    }
    Array.prototype.forEach.call(node.childNodes || [], function (child) {
      walk(child, computedStyle);
    });
  }

  walk(target, baseStyle);
  var result = trimCodeSegments(segments);
  return result.length ? result : undefined;
}

export function isSubstantialCodeText(text) {
  var value = String(text || "");
  return value.length > 80 || /\n/.test(value) || /[{};#@]/.test(value);
}

export function collectContentElements(root, selectors) {
  var elements = [];
  if (!root || !root.querySelectorAll) return elements;

  function add(element) {
    if (!element || isIgnoredContentNode(element)) return;
    if (elements.some(function (existing) {
      return existing === element || existing.contains(element) || element.contains(existing);
    })) {
      return;
    }
    elements.push(element);
  }

  selectors.forEach(function (selector) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), add);
  });

  return elements;
}

export function attachBlockSource(block, element) {
  if (!block || !element) return block;
  if (block.type !== "image" && block.type !== "separator") {
    block.textSource = "dom";
  }
  var htmlStyle = captureExportHtmlStyle(element);
  if (htmlStyle) block.htmlStyle = htmlStyle;
  if (typeof Object.defineProperty !== "function") return block;
  try {
    Object.defineProperty(block, "__sourceElement", {
      value: element,
      enumerable: false,
      configurable: true
    });
  } catch (error) {}
  return block;
}

export function getBlockSourceElement(block) {
  return block && block.__sourceElement || null;
}

function createInlineTextBlock(type, text, element, extra) {
  var block = Object.assign({ type: type, text: text }, extra || {});
  var segments = cleanInlineSegments(element);
  if (hasMeaningfulInlineSegments(segments)) {
    block.segments = segments;
    if (segments.some(function (segment) { return Boolean(segment && segment.marks && segment.marks.math); })) {
      block.text = segments.map(function (segment) { return String(segment && segment.text || ""); }).join("").trim();
    }
  }
  return attachBlockSource(block, element);
}

function hasMeaningfulInlineSegments(segments) {
  return Array.isArray(segments) && segments.some(function (segment) {
    var marks = segment && segment.marks || {};
    return Boolean(segment && segment.href) || Boolean(marks.bold || marks.italic || marks.code || marks.strike ||
      marks.superscript || marks.subscript || marks.highlight || marks.underline || marks.math) ||
      Boolean(segment && segment.htmlStyle && Object.keys(segment.htmlStyle).length);
  });
}

export function markStructuralNodes(root) {
  var structSet = new WeakSet();
  if (!root || typeof root.querySelectorAll !== "function") {
    return structSet;
  }
  try {
    var leaves = root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,code,ul,ol,table,blockquote,hr,img,svg");
    Array.prototype.forEach.call(leaves, function (leaf) {
      var curr = leaf;
      while (curr && curr !== root) {
        if (structSet.has(curr)) break;
        structSet.add(curr);
        curr = curr.parentElement;
      }
    });
  } catch (e) {
  }
  return structSet;
}

export function normalizeContent(element) {
  var blocks = [];
  var structSet = markStructuralNodes(element);
  walkElement(element, blocks, structSet);
  var merged = mergeAdjacentParagraphs(blocks);
  var listMerged = mergeAdjacentLists(merged);
  var result = deduplicateBlocks(listMerged);
  return result;
}

export function mergeAdjacentParagraphs(blocks) {
  var out = [];
  blocks.forEach(function (block) {
    if (!block || !block.type) return;
    if (block.type === "paragraph" && !block.text) return;
    if (block.type === "paragraph" && out.length && out[out.length - 1].type === "paragraph") {
      if (block.segments || out[out.length - 1].segments || block.htmlStyle || out[out.length - 1].htmlStyle) {
        out.push(block);
        return;
      }
      out[out.length - 1].text += "\n" + block.text;
      return;
    }
    out.push(block);
  });
  return out;
}

  function mergeAdjacentLists(blocks) {
    var out = [];
    (blocks || []).forEach(function (block) {
      if (!block || block.type !== "list") { out.push(block); return; }
      var prev = out[out.length - 1];
      if (prev && prev.type === "list" && prev.ordered === block.ordered && !block.start) {
        prev.items = (prev.items || []).concat(block.items || []);
        return;
      }
      out.push(block);
    });
    return out;
  }

export function walkElement(parent, blocks, structSet, depth) {
  if (!parent || isIgnoredContentNode(parent)) return;
  if ((depth || 0) > 60) return; // Guard: prevent stack overflow on deeply nested DOM
  if (!structSet) {
    structSet = markStructuralNodes(parent);
  }

  var parentTag = String(parent.tagName || "").toLowerCase();
  if (parentTag === "pre" || (isCodeLikeElement(parent) && !parent.querySelector("p,ul,ol,table,blockquote,img"))) {
    var parentCodeText = cleanCodeText(parent);
    if (parentCodeText && (parentTag === "pre" || isSubstantialCodeText(parentCodeText))) {
      if (!isDalleMetadataText(parentCodeText) && !isGeminiImagePlaceholderText(parentCodeText)) {
        blocks.push(attachCodeBlockPresentation({
          type: "code",
          language: extractCodeLanguage(parent),
          text: parentCodeText,
          codeSegments: extractCodeSegments(parent),
          codeStyle: captureExportHtmlStyle(getCodeTextElement(parent))
        }, parent));
      }
      return;
    }
  }

  var directText = Array.prototype.slice.call(parent.childNodes || []).filter(function (node) {
    return node.nodeType === 3;
  }).map(function (node) {
    return String(node.textContent || "").replace(/\s+/g, " ").trim();
  }).filter(Boolean).join(" ");
  directText = sanitizeExportText(decodeVisibleTextEscapes(stripThoughtText(directText)));
  if (isIgnoredRoleLabel(directText)) {
    directText = "";
  }
  if (directText && !isDalleMetadataText(directText) && !isGeminiImagePlaceholderText(directText) && !isGeminiUINoiseText(directText, parent)) {
    blocks.push(attachBlockSource({ type: "paragraph", text: directText }, parent));
  }

  var children = Array.prototype.slice.call(parent.children || []).filter(function (child) {
    return !isIgnoredContentNode(child);
  });

  if (!children.length) {
    var text = directText ? "" : cleanText(parent);
    if (isIgnoredRoleLabel(text)) {
      text = "";
    }
    if (text && !isDalleMetadataText(text) && !isGeminiImagePlaceholderText(text) && !isGeminiUINoiseText(text, parent)) {
      blocks.push(createInlineTextBlock("paragraph", text, parent));
    }
    return;
  }

  children.forEach(function (child) {
    var tag = String(child.tagName || "").toLowerCase();
    if (!tag) return;

    if (/^h[1-6]$/.test(tag)) {
      var headingText = cleanText(child);
      if (isIgnoredRoleLabel(headingText) || isGeminiUINoiseText(headingText, child)) {
        return;
      }
      blocks.push(attachBlockSource({
        type: "heading",
        level: Number(tag.slice(1)),
        text: headingText
      }, child));
      var headingSegments = cleanInlineSegments(child);
      if (hasMeaningfulInlineSegments(headingSegments)) {
        blocks[blocks.length - 1].segments = headingSegments;
      }
      return;
    }

    if (tag === "p") {
      var paragraphText = cleanText(child);
      if (isIgnoredRoleLabel(paragraphText)) {
        return;
      }
      if (paragraphText && !isDalleMetadataText(paragraphText) && !isGeminiImagePlaceholderText(paragraphText) && !isGeminiUINoiseText(paragraphText, child)) {
        blocks.push(createInlineTextBlock("paragraph", paragraphText, child));
      }
      return;
    }

    if (tag === "pre" || (isCodeLikeElement(child) && !child.querySelector("pre") && !child.querySelector("p,ul,ol,table,blockquote,img"))) {
      var codeText = cleanCodeText(child);
      if (codeText && (tag === "pre" || isSubstantialCodeText(codeText))) {
        if (!isDalleMetadataText(codeText) && !isGeminiImagePlaceholderText(codeText)) {
          blocks.push(attachCodeBlockPresentation({
            type: "code",
            language: extractCodeLanguage(child),
            text: codeText,
            codeSegments: extractCodeSegments(child),
            codeStyle: captureExportHtmlStyle(getCodeTextElement(child))
          }, child));
        }
        return;
      }
    }

    if (tag === "ul" || tag === "ol") {
      var listBlock = attachBlockSource({
        type: "list",
        ordered: tag === "ol",
        items: extractListItems(child)
      }, child);
      if (tag === "ol") {
        var startAttr = child.getAttribute && child.getAttribute("start");
        var startNum = parseInt(startAttr, 10);
        if (!isNaN(startNum) && startNum > 0 && startNum !== 1) {
          listBlock.start = startNum;
        }
      }
      blocks.push(listBlock);
      return;
    }

    if (tag === "table") {
      blocks.push(attachBlockSource(extractTable(child), child));
      return;
    }

    if (tag === "blockquote") {
      var blockquoteText = cleanText(child);
      if (isIgnoredRoleLabel(blockquoteText)) {
        return;
      }
      if (blockquoteText && !isDalleMetadataText(blockquoteText) && !isGeminiImagePlaceholderText(blockquoteText) && !isGeminiUINoiseText(blockquoteText, child)) {
        blocks.push(createInlineTextBlock("blockquote", blockquoteText, child));
      }
      return;
    }

    if (tag === "hr") {
      blocks.push(attachBlockSource({ type: "separator" }, child));
      return;
    }

    if (tag === "img") {
      var altText = child.getAttribute("alt") || "";
      var rawSrc = child.getAttribute("src") || "";
      var imgSrc = rawSrc || child.getAttribute("data-src") || child.getAttribute("srcset") || "";

      var hasSrcset = child.getAttribute("srcset");
      if (hasSrcset && (!imgSrc || imgSrc.indexOf("image_generation_content") !== -1 || imgSrc.startsWith("data:image/svg+xml"))) {
        var srcsetParts = String(hasSrcset).split(",").map(function (s) {
          return s.trim().split(" ")[0];
        }).filter(Boolean);
        if (srcsetParts.length > 0) {
          imgSrc = srcsetParts[srcsetParts.length - 1];
        }
      }

      if (imgSrc && imgSrc.indexOf("image_generation_content") !== -1 && child.closest) {
        try {
          var turnEl = child.closest('model-response, [data-test-id="model-response"], .model-response, conversation-turn, .conversation-turn, message-content, .response-container');
          if (turnEl) {
            var matchIdx = (imgSrc.match(/image_generation_content\/(\d+)/) || [])[1];
            var parsedIdx = matchIdx != null ? parseInt(matchIdx, 10) : 0;
            var turnImgs = turnEl.querySelectorAll('img, source');
            var realTurnCandidates = [];
            for (var t = 0; t < turnImgs.length; t += 1) {
              var candidateUrl = turnImgs[t].getAttribute("src") || turnImgs[t].getAttribute("srcset") || turnImgs[t].getAttribute("data-src") || "";
              if (candidateUrl && candidateUrl.indexOf(",") !== -1) {
                var parts = candidateUrl.split(",").map(function (s) { return s.trim().split(" ")[0]; }).filter(Boolean);
                if (parts.length > 0) candidateUrl = parts[parts.length - 1];
              }
              if (candidateUrl && candidateUrl.indexOf("image_generation_content") === -1 && !isPlatformOrSystemIcon(candidateUrl)) {
                if (realTurnCandidates.indexOf(candidateUrl) === -1) {
                  realTurnCandidates.push(candidateUrl);
                }
              }
            }
            if (realTurnCandidates.length > 0) {
              imgSrc = (Number.isFinite(parsedIdx) && parsedIdx < realTurnCandidates.length)
                ? realTurnCandidates[parsedIdx]
                : realTurnCandidates[0];
            }
          }
        } catch (e) {}
      }

      if (!imgSrc && child.parentElement && child.parentElement.tagName.toLowerCase() === "picture") {
        var sourceEl = child.parentElement.querySelector("source");
        if (sourceEl) {
          imgSrc = sourceEl.getAttribute("srcset") || sourceEl.getAttribute("src") || "";
        }
      }

      if (imgSrc && imgSrc.indexOf(",") !== -1) {
        var srcsetParts = imgSrc.split(",").map(function (s) {
          return s.trim().split(" ")[0];
        }).filter(Boolean);
        if (srcsetParts.length > 0) {
          imgSrc = srcsetParts[srcsetParts.length - 1];
        }
      }

      var isSystemIcon = isPlatformOrSystemIcon(imgSrc);
      var isRoleAlt = false;
      if (altText) {
        var trimmedAlt = altText.replace(/\s+/g, " ").trim();
        if (isIgnoredRoleLabel(trimmedAlt) || /^(avatar|profile|logo|system|icon|user profile picture)$/i.test(trimmedAlt)) {
          isRoleAlt = true;
        }
      }

      var widthAttr = child.getAttribute("width");
      var heightAttr = child.getAttribute("height");
      var isSmallIcon = false;
      if (widthAttr && heightAttr) {
        var w = parseInt(widthAttr, 10);
        var h = parseInt(heightAttr, 10);
        if (!isNaN(w) && !isNaN(h) && w <= 48 && h <= 48) {
          isSmallIcon = true;
        }
      }

      var isLargeImage = false;
      if (isTrustedConversationImageSrc(imgSrc)) {
        isLargeImage = true;
      }

      if (child.naturalWidth > 96 && child.naturalHeight > 96) {
        isLargeImage = true;
      }

      if (widthAttr && heightAttr) {
        var w = parseInt(widthAttr, 10);
        var h = parseInt(heightAttr, 10);
        if (!isNaN(w) && !isNaN(h) && w > 96 && h > 96) {
          isLargeImage = true;
        }
      }

      var shouldSkip = false;
      var isSmallSize = isSmallIcon;
      if (child.naturalWidth > 0 && child.naturalWidth <= 48) {
        isSmallSize = true;
      }
      var isAccountAvatarPath = !isLargeImage && /(?:googleusercontent\.com\/a\/|googleusercontent\.com\/a-|\/ogw\/|photo\.jpg|avatar)/i.test(imgSrc);

      if (isSystemIcon) {
        shouldSkip = true;
      } else if (isRoleAlt) {
        shouldSkip = true;
      } else if ((isSmallSize && !isLargeImage) || isAccountAvatarPath) {
        shouldSkip = true;
      }

      if (shouldSkip) {
        return;
      }

      var cleanAlt = altText;
      if (isRoleAlt) {
        cleanAlt = "Uploaded Image";
      }
      var _imgBlock = attachBlockSource({ type: "image", alt: cleanAlt || "Image", src: imgSrc }, child);
      blocks.push(_imgBlock);
      return;
    }

    if (tag === "svg") {
      if (isSubstantialSvg(child)) {
        var svgDataUrl = convertSvgToDataUrl(child);
        if (svgDataUrl) {
          blocks.push(attachBlockSource({
            type: "image",
            alt: child.getAttribute("alt") || "SVG Diagram",
            src: svgDataUrl
          }, child));
          return;
        }
      }
    }

    var styleAttr = child.getAttribute("style") || "";
    if (styleAttr && styleAttr.indexOf("background-image") !== -1) {
      var bgMatch = styleAttr.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (bgMatch && bgMatch[1]) {
        var bgSrc = bgMatch[1];
        if (isTrustedConversationImageSrc(bgSrc) && !isPlatformOrSystemIcon(bgSrc)) {
          blocks.push(attachBlockSource({
            type: "image",
            alt: "Background Image",
            src: bgSrc
          }, child));
          return;
        }
      }
    }

    var foundSrc = "";
    if (child.attributes) {
      for (var i = 0; i < child.attributes.length; i++) {
        var attr = child.attributes[i];
        var name = attr.name;
        if (name === "class" || name === "id" || name === "style" || name === "role" || name === "tabindex" || name.indexOf("aria-") === 0) continue;
        var val = attr.value || "";
        if (val && isImageOrFileSignature(val)) {
          var urlMatch = val.match(/url\(['"]?([^'")\s]+)['"]?\)/);
          var possibleSrc = urlMatch ? urlMatch[1] : val;
          if (possibleSrc) {
            if (isTrustedConversationImageSrc(possibleSrc) && !isPlatformOrSystemIcon(possibleSrc) && possibleSrc.length > 12) {
              foundSrc = possibleSrc;
              break;
            }
          }
        }
      }
    }

    if (foundSrc) {
      var isBareId = !/^(https?:\/\/|blob:|data:|\/\/|\/)/i.test(foundSrc);
      var hasImgChild = !!child.querySelector("img,svg");
      if (isBareId && hasImgChild) {
        walkElement(child, blocks, structSet, (depth || 0) + 1);
        return;
      }
      blocks.push(attachBlockSource({
        type: "image",
        alt: child.getAttribute("alt") || "Image",
        src: foundSrc
      }, child));
      return;
    }

    if (child.querySelector && structSet.has(child)) {
      walkElement(child, blocks, structSet, (depth || 0) + 1);
      return;
    }

    var text = cleanText(child);
    if (text && !isIgnoredRoleLabel(text) && !isDalleMetadataText(text) && !isGeminiImagePlaceholderText(text)) {
      blocks.push(createInlineTextBlock("paragraph", text, child));
    }
  });
}

var EXPORT_LIST_MAX_DEPTH = 32;
var EXPORT_LIST_MAX_ITEMS = 2000;

export function extractListItems(listEl, depth, budget) {
  var currentDepth = Number.isFinite(Number(depth)) ? Number(depth) : 0;
  var remaining = budget || { value: EXPORT_LIST_MAX_ITEMS };
  if (!listEl || currentDepth >= EXPORT_LIST_MAX_DEPTH || remaining.value <= 0) return [];
  var items = [];
  var lis = listEl.querySelectorAll(":scope > li");
  Array.prototype.forEach.call(lis, function (li) {
    if (remaining.value <= 0) return;
    remaining.value -= 1;
    var clone = li.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll("ul,ol"), function (nested) {
      nested.remove();
    });
    var subItems = [];
    var subItemsOrdered;
    Array.prototype.forEach.call(li.querySelectorAll(":scope > ul, :scope > ol"), function (nestedList) {
      if (subItemsOrdered === undefined) subItemsOrdered = String(nestedList.tagName || "").toLowerCase() === "ol";
      subItems = subItems.concat(extractListItems(nestedList, currentDepth + 1, remaining));
    });
    var segments = cleanInlineSegments(clone);
    if (!hasMeaningfulInlineSegments(segments)) {
      segments = undefined;
    }
    items.push({
      text: cleanText(clone),
      textSource: "dom",
      segments: segments,
      subItems: subItems,
      subItemsOrdered: subItemsOrdered
    });
  });
  return items;
}

export function extractTable(tableEl) {
  var headers = [];
  var rows = [];
  var thead = tableEl.querySelector(":scope > thead, > thead");

  if (thead) {
    // 只选择直接子元素，避免嵌套表格的 th 被错误包含
    Array.prototype.forEach.call(thead.querySelectorAll(":scope > tr > th, > tr > th"), function (th) {
      headers.push(cleanText(th));
    });
  }

  // 只选择 table 的直接子 tr（不包含嵌套表格中的 tr）
  var directTrs = tableEl.querySelectorAll(":scope > tbody > tr, > tr, > tbody > tr");
  if (!directTrs.length) {
    directTrs = tableEl.querySelectorAll("tbody > tr, > tr");
  }

  Array.prototype.forEach.call(directTrs, function (tr) {
    if (thead && (tr.parentElement === thead || thead.contains(tr))) return;
    var cells = [];
    // 只选择 tr 的直接子单元格，避免嵌套表格的单元格被包含
    Array.prototype.forEach.call(tr.children, function (cell) {
      if (cell.tagName === "TD" || cell.tagName === "TH") {
        cells.push(cleanText(cell));
      }
    });
    if (!cells.length) return;
    if (!headers.length && !rows.length) {
      headers = cells;
    } else {
      rows.push(cells);
    }
  });

  return { type: "table", headers: headers, rows: rows };
}

export function deduplicateBlocks(blocks) {
  return dedupeImageBlocksWithinMessage(blocks);
}

export function orderBlocksByFallbackMediaPosition(primaryBlocks, fallbackBlocks) {
  var primary = primaryBlocks || [];
  var fallback = fallbackBlocks || [];
  var primaryImages = primary.filter(function (block) { return block && block.type === "image"; });
  var fallbackImageCount = fallback.filter(function (block) { return block && block.type === "image"; }).length;
  if (!primaryImages.length || primaryImages.length !== fallbackImageCount) {
    return primary;
  }

  var primaryTextBlocks = primary.filter(function (block) { return block && block.type !== "image"; });
  if (!primaryTextBlocks.length || !fallback.length) {
    return primary;
  }

  var merged = [];
  var imageIndex = 0;
  var textIndex = 0;
  fallback.forEach(function (block) {
    if (block && block.type === "image") {
      if (imageIndex < primaryImages.length) {
        merged.push(primaryImages[imageIndex++]);
      }
      return;
    }
    if (textIndex < primaryTextBlocks.length) {
      merged.push(primaryTextBlocks[textIndex++]);
    }
  });

  while (textIndex < primaryTextBlocks.length) {
    merged.push(primaryTextBlocks[textIndex++]);
  }
  while (imageIndex < primaryImages.length) {
    merged.push(primaryImages[imageIndex++]);
  }

  return merged.length ? merged : primary;
}

export function chooseMoreCompleteBlocks(primaryBlocks, fallbackBlocks, options) {
  var primary = deduplicateBlocks(primaryBlocks || []);
  var fallback = deduplicateBlocks(fallbackBlocks || []);

  var countMedia = function (blocks) {
    return (blocks || []).filter(function (b) {
      return b && (b.type === "image" || b.type === "table");
    }).length;
  };
  var primaryMediaCount = countMedia(primary);
  var fallbackMediaCount = countMedia(fallback);

  if (fallbackMediaCount > primaryMediaCount) {
    return fallback;
  }

  var primaryText = getPlainText(primary);
  var fallbackText = getPlainText(fallback);
  var requestedDelta = options && Number.isFinite(Number(options.minTextDelta))
    ? Math.max(0, Number(options.minTextDelta))
    : null;
  var meaningfulDelta = requestedDelta === null
    ? Math.max(40, Math.round(primaryText.length * 0.15))
    : requestedDelta;

  if (fallback.length && fallbackText.length > primaryText.length + meaningfulDelta) {
    return fallback;
  }

  if (primaryMediaCount > 0 && primaryMediaCount === fallbackMediaCount) {
    primary = orderBlocksByFallbackMediaPosition(primary, fallback);
  }

  var chosen = primary.length ? primary : fallback;
  return chosen;
}
