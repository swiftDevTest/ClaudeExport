import { getPlatformLabel, t, formatDateDisplay, sanitizeFilename, notifyProgress, yieldToBrowser, sanitizeExportText, sanitizeInlineSegmentText, sanitizeImageAlt, normalizeExportLinkHref, mapLimit, formatLatexUnicode, ensureImageBlockMetadata, getImageDedupKey, parseInlineMarkdown, getPrefixedInlineSegments } from '../utils.js';
import { preloadImageForDocx, calculateWordImageDimensions } from '../media.js';
import { createZip } from '../zip.js';
import { getWordTheme } from '../themes/word.js';

export function xmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F]/g, "");
}

export function wordRun(text, options) {
  var props = "";
  var opts = options || {};
  if (opts.bold) props += "<w:b/>";
  if (opts.italic) props += "<w:i/>";
  if (opts.strike) props += "<w:strike/>";
  if (opts.underline) props += '<w:u w:val="single"/>';
  if (opts.superscript) props += '<w:vertAlign w:val="superscript"/>';
  if (opts.subscript) props += '<w:vertAlign w:val="subscript"/>';
  if (opts.highlight) props += '<w:highlight w:val="yellow"/>';
  if (opts.color) props += '<w:color w:val="' + xmlEscape(opts.color) + '"/>';
  if (opts.size) props += '<w:sz w:val="' + Math.round(Number(opts.size) * 2) + '"/>';
  if (opts.font) props += '<w:rFonts w:ascii="' + xmlEscape(opts.font) + '" w:hAnsi="' + xmlEscape(opts.font) + '"/>';
  if (opts.position !== undefined) props += '<w:position w:val="' + Math.round(Number(opts.position) || 0) + '"/>';
  if (opts.shading) props += '<w:shd w:val="clear" w:fill="' + xmlEscape(opts.shading) + '"/>';

  var sourceText = opts.formatLatex === false ? text : formatLatexUnicode(text);
  var sanitizedText = opts.preserveSegmentSpace
    ? sanitizeInlineSegmentText(sourceText)
    : sanitizeExportText(sourceText);
  var chunks = sanitizedText.split("\n");
  var body = chunks.map(function (chunk, index) {
    return (index ? "<w:br/>" : "") + '<w:t xml:space="preserve">' + xmlEscape(chunk) + "</w:t>";
  }).join("");

  return "<w:r>" + (props ? "<w:rPr>" + props + "</w:rPr>" : "") + body + "</w:r>";
}

function getDocxHyperlinkRelId(registry, href) {
  if (!registry) return "";
  var normalizedHref = normalizeExportLinkHref(href);
  if (!normalizedHref) return "";
  if (!registry.byHref) registry.byHref = new Map();
  if (!registry.entries) registry.entries = [];
  if (registry.byHref.has(normalizedHref)) {
    return registry.byHref.get(normalizedHref);
  }
  var relId = "rIdLink" + (registry.entries.length + 1);
  registry.byHref.set(normalizedHref, relId);
  registry.entries.push({
    id: relId,
    target: normalizedHref
  });
  return relId;
}

export function wordParagraph(text, options) {
  var opts = options || {};
  var pPr = "";
  if (opts.style) pPr += '<w:pStyle w:val="' + opts.style + '"/>';
  if (opts.keepNext) pPr += '<w:keepNext/>';
  var spacingAfter = opts.spacing;
  var spacingBefore = opts.spacingBefore;
  if (opts.shading && opts.centerShadedText !== false && spacingAfter !== undefined && spacingBefore === undefined) {
    var totalSpacing = Math.max(0, Number(spacingAfter) || 0);
    var beforeRatio = Number(opts.shadedSpacingBeforeRatio);
    if (!Number.isFinite(beforeRatio)) beforeRatio = 0.62;
    beforeRatio = Math.max(0, Math.min(1, beforeRatio));
    spacingBefore = Math.ceil(totalSpacing * beforeRatio);
    spacingAfter = Math.max(0, totalSpacing - spacingBefore);
  }
  if (spacingAfter !== undefined || spacingBefore !== undefined) {
    pPr += '<w:spacing' +
      (spacingBefore !== undefined ? ' w:before="' + spacingBefore + '"' : "") +
      (spacingAfter !== undefined ? ' w:after="' + spacingAfter + '"' : "") +
      "/>";
  }
  if (opts.indentLeft || opts.indentRight) {
    pPr += '<w:ind' +
      (opts.indentLeft ? ' w:left="' + opts.indentLeft + '"' : "") +
      (opts.indentRight ? ' w:right="' + opts.indentRight + '"' : "") +
      "/>";
  }
  if (opts.shading) pPr += '<w:shd w:val="clear" w:fill="' + opts.shading + '"/>';
  if (opts.align) pPr += '<w:jc w:val="' + opts.align + '"/>';
  if (opts.textAlignment) pPr += '<w:textAlignment w:val="' + opts.textAlignment + '"/>';
  if (opts.borderColor) {
    var side = opts.borderSide || "left";
    pPr += '<w:pBdr><' + side + ' w:val="single" w:sz="16" w:space="8" w:color="' + opts.borderColor + '"/></w:pBdr>';
  }

  var runsXml = "";
  if (Array.isArray(opts.segments) && opts.segments.length) {
    runsXml = opts.segments.map(function (segment) {
      var marks = segment.marks || {};
      var isCode = Boolean(marks.code || segment.code);
      var isMath = Boolean(marks.math || segment.math);
      var chunkOpts = Object.assign({}, opts, {
        bold: opts.bold || marks.bold || segment.bold,
        italic: opts.italic || marks.italic || segment.italic,
        strike: opts.strike || marks.strike || segment.strike,
        superscript: opts.superscript || marks.superscript || segment.superscript,
        subscript: opts.subscript || marks.subscript || segment.subscript,
        highlight: opts.highlight || marks.highlight || segment.highlight,
        underline: opts.underline || marks.underline || segment.underline || Boolean(segment.href),
        font: isCode ? "Consolas" : opts.font,
        shading: isCode ? (opts.inlineCodeBg || "F1F5F9") : opts.textShading,
        color: isCode ? (opts.inlineCodeText || "0F6574") : (segment.href ? "0563C1" : opts.color),
        preserveSegmentSpace: true
      });
      var segmentText = isMath
        ? formatLatexUnicode("\\(" + sanitizeInlineSegmentText(segment.text || "").trim() + "\\)")
        : segment.text;
      var runXml = wordRun(segmentText, chunkOpts);
      var relId = getDocxHyperlinkRelId(opts.hyperlinks, segment.href);
      return relId
        ? '<w:hyperlink r:id="' + xmlEscape(relId) + '" w:history="1">' + runXml + "</w:hyperlink>"
        : runXml;
    }).join("");
  } else if (opts.plainText) {
    runsXml = wordRun(text, opts.textShading ? Object.assign({}, opts, { shading: opts.textShading }) : opts);
  } else {
    var chunks = parseInlineMarkdown(text);
    runsXml = chunks.map(function (chunk) {
      var chunkOpts = Object.assign({}, opts, {
        bold: opts.bold || chunk.bold,
        italic: opts.italic || chunk.italic,
        font: chunk.code ? "Consolas" : opts.font,
        shading: chunk.code ? (opts.inlineCodeBg || "F1F5F9") : opts.textShading,
        color: chunk.code ? (opts.inlineCodeText || "0F6574") : opts.color
      });
      return wordRun(chunk.text, chunkOpts);
    }).join("");
  }

  return "<w:p>" + (pPr ? "<w:pPr>" + pPr + "</w:pPr>" : "") + runsXml + "</w:p>";
}

function getMessageWordStyle(themeWord, isUser, alignRight, hyperlinks) {
  return {
    shading: isUser ? themeWord.userBg : themeWord.assistantBg,
    borderColor: isUser ? themeWord.userBorder : themeWord.assistantBorder,
    borderSide: alignRight ? "right" : "left",
    indentLeft: alignRight ? 720 : undefined,
    indentRight: alignRight ? undefined : 240,
    inlineCodeBg: themeWord.inlineCodeBg,
    inlineCodeText: themeWord.inlineCodeText,
    textAlignment: isUser ? "center" : undefined,
    position: isUser ? -8 : undefined,
    hyperlinks: hyperlinks
  };
}

function mergeWordOptions(base, extra) {
  return Object.assign({}, extra || {}, base || {});
}

function getVisualWordBlock(block, role) {
  if (role === "user" && block && block.type === "blockquote") {
    return Object.assign({}, block, { type: "paragraph" });
  }
  return block;
}

function getWordBlockPlainText(block) {
  if (!block) return "";
  if (block.text != null) return String(block.text);
  if (Array.isArray(block.segments)) {
    return block.segments.map(function (segment) {
      return segment && segment.text != null ? String(segment.text) : "";
    }).join("");
  }
  return "";
}

function getEstimatedWordLineUnits(text) {
  var units = 0;
  var chars = Array.from(String(text || ""));
  chars.forEach(function (char) {
    if (/\s/.test(char)) {
      units += 0.6;
    } else if (/[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFFEF]/.test(char)) {
      units += 2;
    } else {
      units += 1;
    }
  });
  return units;
}

function shouldRightAlignUserWordText(blocks, alignRight, role) {
  if (!alignRight || role !== "user" || !Array.isArray(blocks) || blocks.length !== 1) return false;
  var block = getVisualWordBlock(blocks[0], role);
  if (!block || (block.type !== "paragraph" && block.type !== "heading")) return false;
  var text = getWordBlockPlainText(block);
  if (!text.trim() || /[\r\n]/.test(text)) return false;
  return getEstimatedWordLineUnits(text) <= 52;
}

function wordRoleLabel(label, alignRight, isUser, themeWord) {
  var text = String(label || "");
  var align = alignRight ? "right" : "left";
  var color = isUser ? themeWord.roleUserColor : themeWord.roleAssistantColor;
  var opts = {
    bold: true,
    color: color,
    size: 10,
    spacing: 70,
    spacingBefore: 80,
    align: align,
    keepNext: true,
    plainText: true
  };
  if (themeWord.roleLabelBg) opts.shading = themeWord.roleLabelBg;
  if (themeWord.roleLabelBg) {
    opts.textShading = themeWord.roleLabelBg;
    opts.shading = undefined;
  }
  if (themeWord.roleLabelBorder) {
    opts.borderColor = themeWord.roleLabelBorder;
    opts.borderSide = alignRight ? "right" : "left";
  }

  return wordParagraph(text, opts);
}

export function wordTable(table, alignRight, themeWord) {
  var rows = [];
  if (table.headers && table.headers.length) rows.push({ cells: table.headers, header: true });
  (table.rows || []).forEach(function (row) { rows.push({ cells: row, header: false }); });
  if (!rows.length) return "";
  var numCols = Math.max.apply(null, rows.map(function (row) { return row.cells ? row.cells.length : 0; }));
  var cellWidth = Math.floor(9000 / (numCols || 1));
  var tblPrAlign = alignRight ? '<w:jc w:val="right"/>' : '';
  var border = themeWord.tableBorder || "D9E2EC";
  return "<w:tbl><w:tblPr>" + tblPrAlign + "<w:tblW w:w=\"9000\" w:type=\"dxa\"/><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:color=\"" + border + "\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"" + border + "\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"" + border + "\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"" + border + "\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"" + border + "\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"" + border + "\"/></w:tblBorders></w:tblPr>" + rows.map(function (row) {
    return "<w:tr>" + row.cells.map(function (cell) {
      var fill = row.header ? "<w:shd w:val=\"clear\" w:fill=\"" + themeWord.tableHeaderBg + "\"/>" : "";
      return "<w:tc><w:tcPr><w:tcW w:w=\"" + cellWidth + "\" w:type=\"dxa\"/>" + fill + "</w:tcPr>" + wordParagraph(cell, {
        bold: row.header,
        spacing: 80,
        color: row.header ? themeWord.tableHeaderText : themeWord.colorText,
        inlineCodeBg: themeWord.inlineCodeBg,
        inlineCodeText: themeWord.inlineCodeText
      }) + "</w:tc>";
    }).join("") + "</w:tr>";
  }).join("") + "</w:tbl>";
}

export function wordCodeBlock(block, alignRight, themeWord) {
  var label = block.language
    ? wordParagraph(block.language.toUpperCase(), { bold: true, color: themeWord.codeLabel, size: 9, spacing: 80, align: alignRight ? "right" : undefined, plainText: true })
    : "";
  var lines = String(block.text || "").split("\n");
  var linesXml = lines.map(function (line, index) {
    var isLast = index === lines.length - 1;
    return wordParagraph(line, { font: "Consolas", size: 10, color: themeWord.codeText, spacing: isLast ? 80 : 0, formatLatex: false, plainText: true });
  }).join("");

  var tblPrAlign = alignRight ? '<w:jc w:val="right"/>' : '';

  return '<w:tbl><w:tblPr>' + tblPrAlign + '<w:tblW w:w="8666" w:type="dxa"/><w:tblInd w:w="180" w:type="dxa"/><w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:color="' + themeWord.codeBorder + '"/>' +
    '<w:left w:val="single" w:sz="4" w:color="' + themeWord.codeBorder + '"/>' +
    '<w:bottom w:val="single" w:sz="4" w:color="' + themeWord.codeBorder + '"/>' +
    '<w:right w:val="single" w:sz="4" w:color="' + themeWord.codeBorder + '"/>' +
    '</w:tblBorders></w:tblPr><w:tr><w:tc><w:tcPr>' +
    '<w:shd w:val="clear" w:fill="' + themeWord.codeBg + '"/>' +
    '<w:tcMar><w:top w:w="160" w:type="dxa"/><w:left w:w="220" w:type="dxa"/><w:bottom w:w="160" w:type="dxa"/><w:right w:w="220" w:type="dxa"/></w:tcMar>' +
    '</w:tcPr>' +
    label +
    linesXml +
    '</w:tc></w:tr></w:tbl>';
}

export function wordImageParagraph(cached, alt, alignRight) {
  var dims = calculateWordImageDimensions(cached.width, cached.height);
  var cx = dims.cx;
  var cy = dims.cy;
  var jc = alignRight ? "right" : "center";

  return '<w:p><w:pPr><w:jc w:val="' + jc + '"/><w:spacing w:after="120"/></w:pPr>' +
    wordImageRun(cached, alt, cx, cy) +
  '</w:p>';
}

function wordImageRun(cached, alt, cx, cy) {
  return '<w:r>' +
      '<w:drawing>' +
        '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
          '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
          '<wp:docPr id="' + cached.id + '" name="Image ' + cached.id + '" descr="' + xmlEscape(sanitizeImageAlt(alt)) + '"/>' +
          '<wp:cNvGraphicFramePr>' +
            '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>' +
          '</wp:cNvGraphicFramePr>' +
          '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
            '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
              '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
                '<pic:nvPicPr>' +
                  '<pic:cNvPr id="' + cached.id + '" name="' + xmlEscape(cached.path) + '"/>' +
                  '<pic:cNvPicPr/>' +
                '</pic:nvPicPr>' +
                '<pic:blipFill>' +
                  '<a:blip r:embed="' + cached.relId + '"/>' +
                  '<a:stretch><a:fillRect/></a:stretch>' +
                '</pic:blipFill>' +
                '<pic:spPr>' +
                  '<a:xfrm>' +
                    '<a:off x="0" y="0"/>' +
                    '<a:ext cx="' + cx + '" cy="' + cy + '"/>' +
                  '</a:xfrm>' +
                  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
                '</pic:spPr>' +
              '</pic:pic>' +
            '</a:graphicData>' +
          '</a:graphic>' +
        '</wp:inline>' +
      '</w:drawing>' +
    '</w:r>';
}

function wordImageSpacerRun() {
  return '<w:r><w:t xml:space="preserve">  </w:t></w:r>';
}

export function wordImageGridParagraph(blocks, imageCache, alignRight, themeWord) {
  var squareCx = 980000;
  var squareCy = 980000;
  var jc = alignRight ? "right" : "center";
  var xml = "";

  for (var index = 0; index < (blocks || []).length; index += 6) {
    var rowBlocks = (blocks || []).slice(index, index + 6);
    var runs = [];
    var fallbackXml = "";

    rowBlocks.forEach(function (block) {
      var cached = imageCache && imageCache[block.src];
      if (cached) {
        if (runs.length) runs.push(wordImageSpacerRun());
        runs.push(wordImageRun(cached, sanitizeImageAlt(block.alt), squareCx, squareCy));
      } else {
        fallbackXml += wordParagraph("[Image: " + sanitizeImageAlt(block.alt) + " - Load Failed]", {
          italic: true,
          color: themeWord.colorMuted,
          spacing: 100,
          align: alignRight ? "right" : undefined
        });
      }
    });

    if (runs.length) {
      xml += '<w:p><w:pPr><w:jc w:val="' + jc + '"/><w:spacing w:after="80"/></w:pPr>' + runs.join("") + '</w:p>';
    }
    xml += fallbackXml;
  }

  return xml;
}

export function wordBlocks(blocks, imageCache, alignRight, themeWord, role, hyperlinks) {
  var xml = "";
  var isUser = role === "user";
  var messageStyle = getMessageWordStyle(themeWord, isUser, alignRight, hyperlinks);
  // Right-align only likely single-line user prompts; wrapped text should start from the left.
  var messageTextAlign = shouldRightAlignUserWordText(blocks, alignRight, role) ? "right" : undefined;
  for (var blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    var block = getVisualWordBlock(blocks[blockIndex], role);
    if (block.type === "heading") {
      xml += wordParagraph(block.text, mergeWordOptions({
        style: "Heading" + Math.min(4, block.level || 2),
        bold: true,
        spacing: 120,
        color: themeWord.colorTitle,
        align: messageTextAlign,
        segments: getPrefixedInlineSegments("", block.segments)
      }, messageStyle));
    } else if (block.type === "paragraph") {
      xml += wordParagraph(block.text, mergeWordOptions({
        spacing: 120,
        color: themeWord.colorText,
        align: messageTextAlign,
        segments: getPrefixedInlineSegments("", block.segments)
      }, messageStyle));
    } else if (block.type === "code") {
      xml += wordCodeBlock(block, alignRight, themeWord);
    } else if (block.type === "list") {
      block.items.forEach(function (item, index) {
        var itemPrefix = block.ordered ? (index + 1) + ".  " : "•  ";
        xml += wordParagraph(itemPrefix + item.text, mergeWordOptions({
          spacing: 80,
          color: themeWord.colorText,
          align: messageTextAlign,
          segments: getPrefixedInlineSegments(itemPrefix, item.segments)
        }, messageStyle));
        (item.subItems || []).forEach(function (sub) {
          var subPrefix = "    ◦  ";
          xml += wordParagraph(subPrefix + sub.text, mergeWordOptions({
            spacing: 80,
            color: themeWord.colorText,
            align: messageTextAlign,
            segments: getPrefixedInlineSegments(subPrefix, sub.segments)
          }, messageStyle));
        });
      });
    } else if (block.type === "table") {
      xml += wordTable(block, alignRight, themeWord);
    } else if (block.type === "blockquote") {
      xml += wordParagraph(block.text, {
        italic: true,
        shading: themeWord.quoteBg,
        borderColor: themeWord.quoteBorder,
        borderSide: alignRight ? "right" : "left",
        spacing: 160,
        spacingBefore: 80,
        indentLeft: alignRight ? undefined : 180,
        indentRight: alignRight ? 180 : 120,
        color: themeWord.quoteText,
        align: messageTextAlign,
        inlineCodeBg: themeWord.inlineCodeBg,
        inlineCodeText: themeWord.inlineCodeText,
        hyperlinks: hyperlinks,
        segments: getPrefixedInlineSegments("", block.segments)
      });
    } else if (block.type === "image") {
      var imageRun = [block];
      while (blockIndex + 1 < blocks.length && blocks[blockIndex + 1].type === "image") {
        imageRun.push(blocks[blockIndex + 1]);
        blockIndex += 1;
      }
      if (imageRun.length > 1) {
        xml += wordImageGridParagraph(imageRun, imageCache, alignRight, themeWord);
      } else {
        var cached = imageCache && imageCache[block.src];
        if (cached) {
          xml += wordImageParagraph(cached, sanitizeImageAlt(block.alt), alignRight);
        } else {
          xml += wordParagraph("[Image: " + sanitizeImageAlt(block.alt) + " - Load Failed]", { italic: true, color: themeWord.colorMuted, spacing: 100, align: alignRight ? "right" : undefined });
        }
      }
    } else if (block.type === "separator") {
      xml += wordParagraph(" ", { borderColor: themeWord.separatorColor || "D9E2EC", spacing: 120 });
    }
  }
  return xml;
}

export async function buildDocxBlob(messages, metadata, settingsInput, options) {
  options = options || {};
  var signal = options.signal;
  var themeConfig = getWordTheme(settingsInput);
  var settings = themeConfig.settings;
  var title = metadata.title || "Untitled Chat";
  var platform = getPlatformLabel(metadata.platform);
  var date = formatDateDisplay(metadata.exportedAt);
  var themeWord = themeConfig.word;
  var pageBg = themeConfig.pageBg;
  var hyperlinks = {
    byHref: new Map(),
    entries: []
  };

  function throwIfAborted() {
    if (signal && signal.aborted) {
      var err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
  }

  throwIfAborted();
  notifyProgress(options, t("export_progress_preparing_docx", "Preparing Word document"), 0.06);

  var imageEntriesByKey = new Map();
  messages.forEach(function (message) {
    (message.contentBlocks || []).forEach(function (block, blockIndex) {
      if (block.type === "image" && block.src) {
        var imageBlock = ensureImageBlockMetadata(block, blockIndex);
        var key = getImageDedupKey(imageBlock) || block.src;
        var entry = imageEntriesByKey.get(key);
        if (!entry) {
          entry = {
            key: key,
            src: block.src,
            aliases: new Set()
          };
          imageEntriesByKey.set(key, entry);
        }
        entry.aliases.add(block.src);
      }
    });
  });


  var uniqueImages = Array.from(imageEntriesByKey.values()).filter(function (entry) { return entry.src; });
  var imageCache = {};
  if (uniqueImages.length > 0) {
    var loadedImages = 0;
    var preloadedResults = await mapLimit(uniqueImages, 2, async function (entry, index) {
      throwIfAborted();
      var result = await preloadImageForDocx(entry.src, index, options);
      throwIfAborted();
      loadedImages += 1;
      notifyProgress(
        options,
        t("export_progress_loading_images", "Loading images"),
        0.08 + 0.22 * (loadedImages / Math.max(1, uniqueImages.length))
      );
      return result;
    });
    preloadedResults.forEach(function (res, idx) {
      if (res) {
        var entry = uniqueImages[idx];
        var originalSrc = entry && entry.src;
        imageCache[res.src] = res;
        if (originalSrc && originalSrc !== res.src) {
          imageCache[originalSrc] = res;
        }
        if (entry && entry.key) {
          imageCache[entry.key] = res;
        }
        if (entry && entry.aliases) {
          entry.aliases.forEach(function (alias) {
            imageCache[alias] = res;
          });
        }
      }
    });
  }

  var bodyParts = [];

  if (settings.show_conversation_title) {
    bodyParts.push(wordParagraph(title, {
      style: "Title",
      bold: true,
      size: 24,
      spacing: 120,
      color: themeWord.colorTitle,
      shading: themeWord.titleBg,
      borderColor: themeWord.titleBorder,
      plainText: true
    }));
  }
  var meta = [];
  var metaSegments = [];
  function addMetaSegment(text, href) {
    if (metaSegments.length) {
      metaSegments.push({ text: " · " });
    }
    metaSegments.push(href ? { text: text, href: href } : { text: text });
  }
  if (settings.show_platform_name) {
    meta.push(platform);
    addMetaSegment(platform);
  }
  if (settings.show_export_time) {
    meta.push(date);
    addMetaSegment(date);
  }
  if (settings.include_source_url && metadata.sourceUrl) {
    meta.push(metadata.sourceUrl);
    addMetaSegment(metadata.sourceUrl, metadata.sourceUrl);
  }
  if (meta.length) {
    bodyParts.push(wordParagraph(meta.join(" · "), {
      color: themeWord.metaText,
      size: 10,
      spacing: 220,
      shading: themeWord.metaBg,
      borderColor: themeWord.metaBorder,
      textAlignment: "center",
      position: -8,
      plainText: true,
      hyperlinks: hyperlinks,
      segments: metaSegments
    }));
  }

  for (var mi = 0; mi < messages.length; mi++) {
    throwIfAborted();
    var message = messages[mi];
    var isUser = message.role === "user";
    var alignRight = isUser && settings.align_user_messages_right;
    if (settings.show_role_labels && metadata.scope !== "ai_only") {
      bodyParts.push(wordRoleLabel(isUser ? t("export_role_user", "You Asked") : platform.toUpperCase(), alignRight, isUser, themeWord));
    }
    bodyParts.push(wordBlocks(message.contentBlocks, imageCache, alignRight, themeWord, message.role, hyperlinks));
    bodyParts.push(wordParagraph("", { spacing: 120, align: alignRight ? "right" : undefined }));
    if (mi % 5 === 0 || mi === messages.length - 1) {
      notifyProgress(
        options,
        t("export_progress_building_word", "Building Word document"),
        0.34 + 0.48 * ((mi + 1) / Math.max(1, messages.length))
      );
      await yieldToBrowser();
    }
  }

  if (settings.show_chatvault_badge) {
    bodyParts.push(wordParagraph(t("export_branding_footer", "Exported locally by AI Chat Export"), { color: themeWord.colorMuted, size: 9, spacing: 80 }));
  }
  var body = bodyParts.join("");

  var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<w:background w:color="' + pageBg + '"/>' +
    "<w:body>" + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";

  var zipFiles = [
    { path: "_rels/.rels", content: packageRelsXml() },
    { path: "word/styles.xml", content: stylesXml(themeWord) },
    { path: "docProps/core.xml", content: coreXml(title) },
    { path: "docProps/app.xml", content: appXml() },
    { path: "word/document.xml", content: documentXml }
  ];

  Object.values(imageCache).forEach(function (img) {
    zipFiles.push({
      path: "word/" + img.path,
      content: img.bytes
    });
  });

  zipFiles.push({ path: "[Content_Types].xml", content: contentTypesXml(imageCache) });
  zipFiles.push({ path: "word/_rels/document.xml.rels", content: documentRelsXml(imageCache, hyperlinks) });

  notifyProgress(options, t("export_progress_saving", "Saving export"), 0.88);
  var blob = new Blob([createZip(zipFiles)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  notifyProgress(options, t("export_progress_ready", "Export ready"), 1);
  return blob;
}

export function contentTypesXml(imageCache) {
  var extensions = { rels: true, xml: true };
  var imageDefaults = "";
  Object.values(imageCache || {}).forEach(function (img) {
    if (!extensions[img.ext]) {
      extensions[img.ext] = true;
      imageDefaults += '<Default Extension="' + img.ext + '" ContentType="' + img.mimeType + '"/>';
    }
  });

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    imageDefaults +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>";
}

export function packageRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>";
}

export function documentRelsXml(imageCache, hyperlinks) {
  var relsXml = "";
  Object.values(imageCache || {}).forEach(function (img) {
    relsXml += '<Relationship Id="' + img.relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + img.path + '"/>';
  });
  (hyperlinks && hyperlinks.entries || []).forEach(function (link) {
    relsXml += '<Relationship Id="' + xmlEscape(link.id) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xmlEscape(link.target) + '" TargetMode="External"/>';
  });

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    relsXml +
    "</Relationships>";
}

export function stylesXml(themeWord) {
  var fontAscii = (themeWord && themeWord.fontAscii) || "Georgia";
  var fontEastAsia = (themeWord && themeWord.fontEastAsia) || "DengXian";
  var colorTitle = (themeWord && themeWord.colorTitle) || "0F6574";
  var colorText = (themeWord && themeWord.colorText) || "1A202C";

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/>' +
      '<w:pPr><w:spacing w:line="320" w:lineRule="auto" w:after="160"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="' + fontAscii + '" w:hAnsi="' + fontAscii + '" w:eastAsia="' + fontEastAsia + '" w:cs="Arial"/><w:sz w:val="22"/><w:color w:val="' + colorText + '"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title">' +
      '<w:name w:val="Title"/>' +
      '<w:pPr><w:spacing w:line="320" w:lineRule="auto" w:after="240"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="' + fontAscii + '" w:hAnsi="' + fontAscii + '" w:eastAsia="' + fontEastAsia + '" w:cs="Arial"/><w:b/><w:sz w:val="48"/><w:color w:val="' + colorTitle + '"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
      '<w:name w:val="heading 1"/>' +
      '<w:pPr><w:spacing w:line="320" w:lineRule="auto" w:before="240" w:after="120"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="' + fontAscii + '" w:hAnsi="' + fontAscii + '" w:eastAsia="' + fontEastAsia + '" w:cs="Arial"/><w:b/><w:sz w:val="36"/><w:color w:val="' + colorTitle + '"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2">' +
      '<w:name w:val="heading 2"/>' +
      '<w:pPr><w:spacing w:line="320" w:lineRule="auto" w:before="200" w:after="100"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="' + fontAscii + '" w:hAnsi="' + fontAscii + '" w:eastAsia="' + fontEastAsia + '" w:cs="Arial"/><w:b/><w:sz w:val="30"/><w:color w:val="' + colorText + '"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3">' +
      '<w:name w:val="heading 3"/>' +
      '<w:pPr><w:spacing w:line="320" w:lineRule="auto" w:before="160" w:after="80"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="' + fontAscii + '" w:hAnsi="' + fontAscii + '" w:eastAsia="' + fontEastAsia + '" w:cs="Arial"/><w:b/><w:sz w:val="26"/><w:color w:val="' + colorText + '"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading4">' +
      '<w:name w:val="heading 4"/>' +
      '<w:pPr><w:spacing w:line="320" w:lineRule="auto" w:before="120" w:after="60"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="' + fontAscii + '" w:hAnsi="' + fontAscii + '" w:eastAsia="' + fontEastAsia + '" w:cs="Arial"/><w:b/><w:sz w:val="24"/><w:color w:val="' + colorText + '"/></w:rPr>' +
    '</w:style>' +
    "</w:styles>";
}

export function coreXml(title) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xmlEscape(title) + "</dc:title><dc:creator>AI Chat Export</dc:creator>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString() + "</dcterms:created>" +
    "</cp:coreProperties>";
}

export function appXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AI Chat Export</Application></Properties>';
}
