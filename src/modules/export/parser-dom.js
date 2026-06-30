import { isChatVaultNode, isIgnoredContentNode, isTrustedConversationImageSrc, isPlatformOrSystemIcon, isSubstantialSvg, convertSvgToDataUrl, isDalleMetadataText, isGeminiImagePlaceholderText, hasImageAttachment, cleanText, cleanInlineSegments, stripThoughtText, isIgnoredRoleLabel, isGeminiUINoiseText, isImageOrFileSignature, sanitizeExportText, decodeVisibleTextEscapes, getBlockText, getPlainText, dedupeImageBlocksWithinMessage } from './utils.js';

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
  return /\b(?:code|syntax|highlight|shiki|hljs|font-mono|whitespace-pre|language-[a-z0-9_-]+)\b/i.test(label);
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
  return match ? match[1] : "";
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
  if (!block || !element || typeof Object.defineProperty !== "function") return block;
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
  }
  return block;
}

function hasMeaningfulInlineSegments(segments) {
  return Array.isArray(segments) && segments.some(function (segment) {
    var marks = segment && segment.marks || {};
    return Boolean(segment && segment.href) || Boolean(marks.bold || marks.italic || marks.code);
  });
}

export function markStructuralNodes(root) {
  var structSet = new WeakSet();
  if (!root || typeof root.querySelectorAll !== "function") {
    return structSet;
  }
  try {
    var leaves = root.querySelectorAll("h1,h2,h3,h4,p,pre,code,ul,ol,table,blockquote,hr,img,svg");
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
  var result = deduplicateBlocks(merged);
  return result;
}

export function mergeAdjacentParagraphs(blocks) {
  var out = [];
  blocks.forEach(function (block) {
    if (!block || !block.type) return;
    if (block.type === "paragraph" && !block.text) return;
    if (block.type === "paragraph" && out.length && out[out.length - 1].type === "paragraph") {
      if (block.segments || out[out.length - 1].segments) {
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
        blocks.push({
          type: "code",
          language: extractCodeLanguage(parent),
          text: parentCodeText
        });
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
    blocks.push({ type: "paragraph", text: directText });
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

    if (/^h[1-4]$/.test(tag)) {
      var headingText = cleanText(child);
      if (isIgnoredRoleLabel(headingText) || isGeminiUINoiseText(headingText, child)) {
        return;
      }
      blocks.push({
        type: "heading",
        level: Number(tag.slice(1)),
        text: headingText
      });
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
          blocks.push({
            type: "code",
            language: extractCodeLanguage(child),
            text: codeText
          });
        }
        return;
      }
    }

    if (tag === "ul" || tag === "ol") {
      blocks.push({
        type: "list",
        ordered: tag === "ol",
        items: extractListItems(child)
      });
      return;
    }

    if (tag === "table") {
      blocks.push(extractTable(child));
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
      blocks.push({ type: "separator" });
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

export function extractListItems(listEl) {
  var items = [];
  var lis = listEl.querySelectorAll(":scope > li");
  Array.prototype.forEach.call(lis, function (li) {
    var clone = li.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll("ul,ol"), function (nested) {
      nested.remove();
    });
    var subItems = [];
    Array.prototype.forEach.call(li.querySelectorAll(":scope > ul, :scope > ol"), function (nestedList) {
      subItems = subItems.concat(extractListItems(nestedList));
    });
    var segments = cleanInlineSegments(clone);
    if (!hasMeaningfulInlineSegments(segments)) {
      segments = undefined;
    }
    items.push({
      text: cleanText(clone),
      segments: segments,
      subItems: subItems
    });
  });
  return items;
}

export function extractTable(tableEl) {
  var headers = [];
  var rows = [];
  var thead = tableEl.querySelector("thead");

  if (thead) {
    Array.prototype.forEach.call(thead.querySelectorAll("th"), function (th) {
      headers.push(cleanText(th));
    });
  }

  Array.prototype.forEach.call(tableEl.querySelectorAll("tr"), function (tr) {
    if (thead && tr.parentElement === thead) return;
    var cells = [];
    Array.prototype.forEach.call(tr.querySelectorAll("td,th"), function (cell) {
      cells.push(cleanText(cell));
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
