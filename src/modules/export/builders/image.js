import {
  getPlatformLabel,
  t,
  formatDateDisplay,
  IMAGE_RENDER_WIDTH,
  IMAGE_EXPORT_SCALE,
  IMAGE_PREVIEW_SCALE,
  IMAGE_MIN_EXPORT_SCALE,
  notifyProgress,
  yieldToBrowser,
  sanitizeImageAlt,
  createCanvas,
  canvasToBlob,
  getFittedCanvasScale,
  wrapText,
  cleanInlineMarkdownText,
  getInlinePlainText,
  getInlineRichText,
  drawRoundRect,
  drawPremiumCard,
  drawMacTerminalHeader,
  wrapRichText,
  getFontsForStyle
} from '../utils.js';
import { preloadCanvasImages } from '../media.js';
import { getImageTheme } from '../themes/image.js';

var SEPARATOR_MARGIN_TOP = 25;
var SEPARATOR_MARGIN_BOTTOM = 25;
var IMAGE_MESSAGE_BOTTOM_GAP = 32;
var IMAGE_FOOTER_TOP_GAP = 28;
var IMAGE_FOOTER_BOTTOM_GAP = 36;
var IMAGE_HEADER_TOP = 70;
var IMAGE_TITLE_LINE_HEIGHT = 42;
var IMAGE_TITLE_META_GAP = 14;
var IMAGE_META_LINE_HEIGHT = 24;
var IMAGE_HEADER_RULE_TOP_GAP = 26;
var IMAGE_HEADER_RULE_BOTTOM_GAP = 34;

export async function buildImageBlob(messages, metadata, settingsInput, options) {
  options = options || {};
  function throwIfAborted() {
    if (options.signal && options.signal.aborted) {
      var err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
  }

  throwIfAborted();
  var imageCache = await preloadCanvasImages(messages, options);
  throwIfAborted();
  var themeConfig = getImageTheme(settingsInput);
  var settings = themeConfig.settings;
  var theme = themeConfig.theme;
  var width = IMAGE_RENDER_WIDTH;
  var scale = options && options.preview ? IMAGE_PREVIEW_SCALE : IMAGE_EXPORT_SCALE;
  var pad = 64;
  var contentWidth = width - pad * 2;
  var measure = createCanvas(width, 10, 1);
  var measureCtx = measure.ctx;
  var messageLayouts = [];
  var y = IMAGE_HEADER_TOP;
  var imageBodyFont = "18px " + theme.font.body;
  var imageBodyLineHeight = 29;
  var hasHeaderMeta = settings.show_platform_name || settings.show_export_time;

  var titleLines = [];
  if (settings.show_conversation_title) {
    titleLines = wrapText(measureCtx, metadata.title || "Untitled Chat", contentWidth, "800 34px " + theme.font.title).slice(0, 4);
    y += titleLines.length * IMAGE_TITLE_LINE_HEIGHT;
  }

  if (titleLines.length && hasHeaderMeta) {
    y += IMAGE_TITLE_META_GAP;
  }

  if (hasHeaderMeta) {
    y += IMAGE_META_LINE_HEIGHT;
  }

  y += IMAGE_HEADER_RULE_TOP_GAP + IMAGE_HEADER_RULE_BOTTOM_GAP;

  notifyProgress(options, t("export_progress_measuring", "Measuring image layout"), 0.08);
  for (var mi = 0; mi < messages.length; mi++) {
    throwIfAborted();
    var message = messages[mi];
    var layout = measureImageMessage(message);
    messageLayouts.push(layout);
    y += layout.cardHeight + IMAGE_MESSAGE_BOTTOM_GAP;
    if (mi % 5 === 4 || mi === messages.length - 1) {
      notifyProgress(options, t("export_progress_measuring", "Measuring image layout"), 0.08 + 0.24 * ((mi + 1) / Math.max(1, messages.length)));
      await yieldToBrowser();
    }
  }

  function getImageCodeFrame(width) {
    var inset = Math.min(16, Math.max(8, Math.round(width * 0.018)));
    return {
      inset: inset,
      width: Math.max(220, width - inset * 2),
      paddingX: 18
    };
  }

  function getVisualMessageBlock(block, role) {
    if (role === "user" && block && block.type === "blockquote") {
      return Object.assign({}, block, { type: "paragraph" });
    }
    return block;
  }

  function measureImageMessage(message) {
    var isUser = message.role === "user";
    var alignRight = isUser && settings.align_user_messages_right;
    
    var maxCardWidth = alignRight ? contentWidth * 0.75 : contentWidth;
    var maxInnerWidth = maxCardWidth - 48;
    var allBlocks = (message.contentBlocks || []).map(function (block) {
      return measureImageBlock(getVisualMessageBlock(block, message.role), maxInnerWidth);
    }).filter(Boolean);
    
    var bubbleBlocks = allBlocks.filter(function (b) { return b.type !== "image"; });
    
    var cardWidth = alignRight ? contentWidth * 0.75 : contentWidth;
    if (alignRight && bubbleBlocks.length > 0) {
      var maxContentW = 0;
      bubbleBlocks.forEach(function (block) {
        if (block.type === "paragraph" || block.type === "heading") {
          if (block.lines) {
            block.lines.forEach(function (line) {
              var w = measureCtx.measureText(line).width;
              if (w > maxContentW) maxContentW = w;
            });
          }
        } else if (block.type === "code") {
          var w = block.frameWidth || 0;
          if (w > maxContentW) maxContentW = w;
        } else if (block.type === "list") {
          var w = block.maxWidth || 0;
          if (w > maxContentW) maxContentW = w;
        } else if (block.type === "blockquote") {
          var maxQuoteLineW = 0;
          if (block.lines) {
            block.lines.forEach(function (line) {
              var w = measureCtx.measureText(line).width + 42;
              if (w > maxQuoteLineW) maxQuoteLineW = w;
            });
          }
          if (maxQuoteLineW > maxContentW) maxContentW = maxQuoteLineW;
        } else {
          if (block.width && block.width > maxContentW) maxContentW = block.width;
        }
      });
      var limit = contentWidth * 0.75;
      cardWidth = Math.min(limit, Math.max(120, maxContentW + 48));
    }
    
    var currentRoleHeight = 0;
    if (settings.show_role_labels && metadata.scope !== "ai_only") {
      currentRoleHeight = 39;
    }
    
    var flowSections = buildImageFlowSections(allBlocks, cardWidth);
    var totalFlowHeight = flowSections.reduce(function (sum, section, index) {
      return sum + section.height + (index ? 14 : 0);
    }, 0);
    var imageRows = flowSections
      .filter(function (section) { return section.type === "images"; })
      .flatMap(function (section) { return section.rows; });
    var bubbleHeight = flowSections
      .filter(function (section) { return section.type === "bubble"; })
      .reduce(function (sum, section) { return sum + section.height; }, 0);
    var labelInBubble = false;
    var totalHeight = currentRoleHeight + totalFlowHeight + (currentRoleHeight > 0 ? 8 : 0);
    
    return {
      message: message,
      blocks: allBlocks,
      bubbleBlocks: bubbleBlocks,
      imageRows: imageRows,
      flowSections: flowSections,
      roleHeight: currentRoleHeight,
      cardHeight: totalHeight,
      bubbleHeight: bubbleHeight,
      cardWidth: cardWidth,
      alignRight: alignRight,
      labelInBubble: labelInBubble
    };
  }

  function buildImageFlowSections(blocks, cardWidth) {
    var sections = [];
    var pendingText = [];
    var pendingImages = [];

    function flushText() {
      if (!pendingText.length) return;
      var contentHeight = pendingText.reduce(function (sum, block, index) {
        return sum + block.height + (index ? 8 : 0);
      }, 0);
      sections.push({
        type: "bubble",
        blocks: pendingText,
        height: 18 + Math.max(contentHeight, imageBodyLineHeight) + 18
      });
      pendingText = [];
    }

    function flushImages() {
      if (!pendingImages.length) return;
      var rows = measureImageGridRows(pendingImages, cardWidth);
      var height = rows.reduce(function (sum, row, index) {
        return sum + row.height + (index ? 8 : 0);
      }, 0);
      sections.push({
        type: "images",
        rows: rows,
        height: height
      });
      pendingImages = [];
    }

    (blocks || []).forEach(function (block) {
      if (block.type === "image") {
        flushText();
        pendingImages.push(block);
        return;
      }
      flushImages();
      pendingText.push(block);
    });

    flushText();
    flushImages();
    return sections;
  }

  function measureImageBlock(block, width) {
    if (!block) return null;
    if (block.type === "heading") {
      var headingSize = block.level === 1 ? 27 : block.level === 2 ? 24 : 21;
      var headingFont = "850 " + headingSize + "px " + theme.font.title;
      var headingText = getInlinePlainText(block);
      var headingRichText = getInlineRichText(block);
      var headingLines = wrapText(measureCtx, cleanInlineMarkdownText(headingText), width, headingFont);
      var richLines = wrapRichText(measureCtx, headingRichText, width, headingFont, theme.font);
      return {
        type: "heading",
        lines: headingLines.length ? headingLines : [""],
        richLines: richLines,
        font: headingFont,
        lineHeight: headingSize + 11,
        height: richLines.length * (headingSize + 11)
      };
    }

    if (block.type === "paragraph") {
      var paragraphText = getInlinePlainText(block);
      var paragraphRichText = getInlineRichText(block);
      var paragraphLines = wrapText(measureCtx, cleanInlineMarkdownText(paragraphText), width, imageBodyFont);
      var richLines = wrapRichText(measureCtx, paragraphRichText, width, imageBodyFont, theme.font);
      return {
        type: "paragraph",
        lines: paragraphLines.length ? paragraphLines : [""],
        richLines: richLines,
        font: imageBodyFont,
        lineHeight: imageBodyLineHeight,
        height: Math.max(1, richLines.length) * imageBodyLineHeight
      };
    }

    if (block.type === "code") {
      var codeFont = "15px " + theme.font.mono;
      var frame = getImageCodeFrame(width);
      var codeLines = wrapText(measureCtx, block.text, frame.width - frame.paddingX * 2, codeFont);
      var isTerminalTheme = theme.id === "aurora" || theme.id === "terminal";
      var codeHeader = (block.language || isTerminalTheme) ? 32 : 16;
      var codeLineHeight = 24;
      return {
        type: "code",
        lines: codeLines.length ? codeLines : [""],
        font: codeFont,
        lineHeight: codeLineHeight,
        language: block.language || "",
        frameInset: frame.inset,
        frameWidth: frame.width,
        paddingX: frame.paddingX,
        height: Math.max(1, codeLines.length) * codeLineHeight + codeHeader + 22
      };
    }

    if (block.type === "list") {
      var groups = [];
      var maxLineWidth = 0;
      (block.items || []).forEach(function (item, index) {
        var itemFont = imageBodyFont;
        var textIndent = 26;
        var richLines = wrapRichText(measureCtx, getInlineRichText(item), width - textIndent, itemFont, theme.font);
        
        var fonts = getFontsForStyle(itemFont, theme.font);
        richLines.forEach(function (line) {
          var w = 0;
          line.chunks.forEach(function (chunk) {
            measureCtx.font = chunk.bold ? fonts.bold : (chunk.italic ? fonts.italic : (chunk.code ? fonts.code : fonts.normal));
            w += measureCtx.measureText(chunk.text).width;
          });
          w += textIndent + 16; // 额外增加 xOffset 基准
          if (w > maxLineWidth) maxLineWidth = w;
        });
        
        groups.push({
          richLines: richLines,
          xOffset: 16,
          textIndent: textIndent,
          lineHeight: 28,
          font: itemFont,
          ordered: block.ordered,
          index: index + 1,
          isSub: false
        });
        (item.subItems || []).forEach(function (sub) {
          var subFont = "16px " + theme.font.body;
          var subTextIndent = 24;
          var subRichLines = wrapRichText(measureCtx, getInlineRichText(sub), width - 28 - subTextIndent, subFont, theme.font);
          
          var subFonts = getFontsForStyle(subFont, theme.font);
          subRichLines.forEach(function (line) {
            var w = 0;
            line.chunks.forEach(function (chunk) {
              measureCtx.font = chunk.bold ? subFonts.bold : (chunk.italic ? subFonts.italic : (chunk.code ? subFonts.code : subFonts.normal));
              w += measureCtx.measureText(chunk.text).width;
            });
            w += 28 + subTextIndent + 16;
            if (w > maxLineWidth) maxLineWidth = w;
          });
          groups.push({
            richLines: subRichLines,
            xOffset: 44, // 16 + 28
            textIndent: subTextIndent,
            lineHeight: 24,
            font: subFont,
            ordered: false,
            isSub: true
          });
        });
      });
      return {
        type: "list",
        groups: groups,
        height: groups.reduce(function (sum, group) {
          return sum + Math.max(1, group.richLines.length) * group.lineHeight;
        }, 0) + 8,
        maxWidth: Math.min(width, maxLineWidth)
      };
    }

    if (block.type === "blockquote") {
      var quoteFont = "italic 17px " + theme.font.body;
      var quoteText = getInlinePlainText(block);
      var quoteRichText = getInlineRichText(block);
      var richLines = wrapRichText(measureCtx, quoteRichText, width - 42, quoteFont, theme.font);
      var quoteLines = wrapText(measureCtx, cleanInlineMarkdownText(quoteText), width - 42, quoteFont);
      return {
        type: "blockquote",
        lines: quoteLines.length ? quoteLines : [""],
        richLines: richLines,
        font: quoteFont,
        lineHeight: 27,
        height: Math.max(1, richLines.length) * 27 + 30
      };
    }

    if (block.type === "table") {
      return measureImageTable(block, width);
    }

    if (block.type === "image") {
      var cached = imageCache && imageCache[block.src];
      if (cached) {
        var targetW = Math.min(width, cached.width);
        if (targetW > 450) targetW = 450;
        var targetH = (cached.height / cached.width) * targetW;
        return { type: "image", src: block.src, width: targetW, height: targetH + 18, originalHeight: targetH };
      }
      var placeholderW = Math.min(width, 450);
      var placeholderH = 120;
      return {
        type: "image",
        src: block.src,
        width: placeholderW,
        height: placeholderH + 18,
        originalHeight: placeholderH,
        placeholder: true,
        alt: block.alt || "Image"
      };
    }

    if (block.type === "separator") {
      return { type: "separator", height: SEPARATOR_MARGIN_TOP + SEPARATOR_MARGIN_BOTTOM };
    }

    return null;
  }

  function measureImageGridRows(imageBlocks, maxWidth) {
    if (!imageBlocks || !imageBlocks.length) return [];
    if (imageBlocks.length === 1) {
      var single = imageBlocks[0];
      return [{
        blocks: [single],
        width: single.width,
        height: single.height,
        square: false
      }];
    }

    var gap = 10;
    var columns = Math.min(6, imageBlocks.length);
    var squareSize = Math.floor((maxWidth - gap * (columns - 1)) / columns);
    squareSize = Math.max(72, Math.min(150, squareSize));
    while (columns > 1 && squareSize * columns + gap * (columns - 1) > maxWidth) {
      columns -= 1;
      squareSize = Math.floor((maxWidth - gap * (columns - 1)) / columns);
      squareSize = Math.max(72, Math.min(150, squareSize));
    }

    var rows = [];
    for (var index = 0; index < imageBlocks.length; index += columns) {
      var rowBlocks = imageBlocks.slice(index, index + columns);
      rows.push({
        blocks: rowBlocks,
        width: rowBlocks.length * squareSize + gap * Math.max(0, rowBlocks.length - 1),
        height: squareSize + 12,
        square: true,
        squareSize: squareSize,
        gap: gap
      });
    }
    return rows;
  }

  function measureImageTable(block, width) {
    var rows = [];
    if (block.headers && block.headers.length) rows.push({ cells: block.headers, header: true });
    (block.rows || []).forEach(function (row) { rows.push({ cells: row, header: false }); });
    if (!rows.length) return null;
    var columnCount = Math.max.apply(null, rows.map(function (row) { return row.cells.length; }));
    var cellWidth = width / Math.max(1, columnCount);
    var rowLayouts = rows.map(function (row) {
      var cellLines = row.cells.map(function (cell) {
        return wrapText(measureCtx, cleanInlineMarkdownText(cell), cellWidth - 18, (row.header ? "800 " : "") + "14px " + theme.font.body);
      });
      var rowHeight = Math.max(38, Math.max.apply(null, cellLines.map(function (lines) { return Math.max(1, lines.length); })) * 20 + 20);
      return { header: row.header, cellLines: cellLines, rowHeight: rowHeight };
    });
    return {
      type: "table",
      columnCount: columnCount,
      cellWidth: cellWidth,
      rows: rowLayouts,
      height: rowLayouts.reduce(function (sum, row) { return sum + row.rowHeight; }, 0) + 12
    };
  }

  var footerHeight = settings.show_chatvault_badge ? IMAGE_FOOTER_TOP_GAP + IMAGE_FOOTER_BOTTOM_GAP + 22 : 34;
  var height = Math.max(720, Math.ceil(y + footerHeight));
  if (!(options && options.preview)) {
    var fittedScale = getFittedCanvasScale(width, height, scale, IMAGE_MIN_EXPORT_SCALE);
    if (!fittedScale) {
      throw new Error(t("export_image_canvas_limit", "This conversation is too long for a high-quality image export because browsers limit canvas size. Export as PDF instead."));
    }
    scale = fittedScale;
  }
  var c = createCanvas(width, height, scale);
  var ctx = c.ctx;
  throwIfAborted();
  y = IMAGE_HEADER_TOP;
  notifyProgress(options, t("export_progress_rendering", "Rendering image"), 0.36);

  if (theme.bg.type === "mesh") {
    ctx.fillStyle = theme.bg.colors[0];
    ctx.fillRect(0, 0, width, height);

    var g1 = ctx.createRadialGradient(0, 0, 10, 0, 0, width * 0.9);
    g1.addColorStop(0, "rgba(228, 213, 246, 0.85)");
    g1.addColorStop(1, "rgba(228, 213, 246, 0)");
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, width, height);

    var g2 = ctx.createRadialGradient(width, height, 10, width, height, width * 0.9);
    g2.addColorStop(0, "rgba(211, 243, 238, 0.85)");
    g2.addColorStop(1, "rgba(211, 243, 238, 0)");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, width, height);
  } else if (theme.bg.type === "gradient") {
    var bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, theme.bg.colors[0]);
    bg.addColorStop(0.45, theme.bg.colors[1]);
    bg.addColorStop(1, theme.bg.colors[2]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.fillStyle = theme.bg.colors[0];
    ctx.fillRect(0, 0, width, height);
  }

  if (theme.id === "newsprint") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.015)";
    for (var i = 0; i < 400; i++) {
      var rx = Math.random() * width;
      var ry = Math.random() * height;
      var rw = Math.random() * 2 + 1;
      var rh = Math.random() * 2 + 1;
      ctx.fillRect(rx, ry, rw, rh);
    }
  }

  ctx.fillStyle = theme.color.accent;
  ctx.fillRect(0, 0, width, 7);

  function imageLabelBaseline(top, height) {
    var metrics = ctx.measureText("Hg");
    if (metrics && Number.isFinite(metrics.actualBoundingBoxAscent) && Number.isFinite(metrics.actualBoundingBoxDescent)) {
      return top + height / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
    }
    return top + height / 2 + 4;
  }

  function drawFallbackPlaceholderImage(x, cursor, width, block) {
    var w = block.width || Math.min(width, 450);
    var h = block.originalHeight || 120;
    var px = x + Math.max(0, (width - w) / 2);
    var py = cursor + 6;
    drawRoundRect(ctx, px, py, w, h, 8, theme.color.cardBgAssistant, theme.color.cardBorderAssistant);
    ctx.font = "italic 15px " + theme.font.body;
    ctx.fillStyle = theme.color.muted;
    var label = "📷 [" + sanitizeImageAlt(block.alt) + " - Load Failed]";
    var textW = ctx.measureText(label).width;
    var textX = px + Math.max(0, (w - textW) / 2);
    var textY = imageLabelBaseline(py, h);
    ctx.fillText(label, textX, textY);
  }

  function renderImageBlock(block, x, cursor, width, alignRight) {
    function drawRichChunk(chunk, currentX, textY, fontSize, fonts, defaultColor) {
      ctx.font = chunk.bold ? fonts.bold : (chunk.italic ? fonts.italic : (chunk.code ? fonts.code : fonts.normal));
      var chunkW = ctx.measureText(chunk.text).width;
      
      if (chunk.code) {
        ctx.save();
        var isDark = theme.id === "midnight";
        ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(100, 116, 139, 0.09)";
        var bgH = fontSize + 2;
        var bgY = textY - 1;
        var bgX = currentX - 3;
        var bgW = chunkW + 6;
        var radius = 3;
        
        ctx.beginPath();
        ctx.moveTo(bgX + radius, bgY);
        ctx.lineTo(bgX + bgW - radius, bgY);
        ctx.quadraticCurveTo(bgX + bgW, bgY, bgX + bgW, bgY + radius);
        ctx.lineTo(bgX + bgW, bgY + bgH - radius);
        ctx.quadraticCurveTo(bgX + bgW, bgY + bgH, bgX + bgW - radius, bgY + bgH);
        ctx.lineTo(bgX + radius, bgY + bgH);
        ctx.quadraticCurveTo(bgX, bgY + bgH, bgX, bgY + bgH - radius);
        ctx.lineTo(bgX, bgY + radius);
        ctx.quadraticCurveTo(bgX, bgY, bgX + radius, bgY);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        
        ctx.fillStyle = theme.color.accentDark;
      } else {
        ctx.fillStyle = defaultColor || theme.color.ink;
      }
      
      ctx.fillText(chunk.text, currentX, textY);
      return chunkW;
    }

    if (block.type === "image") {
      if (block.src && imageCache && imageCache[block.src]) {
        var cached = imageCache[block.src];
        try {
          var imageX = x + Math.max(0, (width - block.width) / 2);
          ctx.drawImage(cached.element, imageX, cursor + 6, block.width, block.originalHeight);
        } catch (ex) {
          drawFallbackPlaceholderImage(x, cursor, width, block);
        }
        return cursor + block.height;
      } else {
        drawFallbackPlaceholderImage(x, cursor, width, block);
        return cursor + block.height;
      }
    }

    if (block.type === "heading" || block.type === "paragraph") {
      var oldBaseline = ctx.textBaseline;
      ctx.textBaseline = "top";
      var fontSize = block.type === "heading" ? (block.font.includes("27px") ? 27 : block.font.includes("24px") ? 24 : 21) : 18;
      var yOffset = (block.lineHeight - fontSize) / 2;
      var fonts = getFontsForStyle(block.font, theme.font);

      if (block.richLines) {
        block.richLines.forEach(function (line) {
          var currentX = x;
          line.chunks.forEach(function (chunk) {
            currentX += drawRichChunk(chunk, currentX, cursor + yOffset, fontSize, fonts, theme.color.ink);
          });
          cursor += block.lineHeight;
        });
      } else {
        ctx.font = block.font;
        ctx.fillStyle = theme.color.ink;
        block.lines.forEach(function (line) {
          ctx.fillText(line, x, cursor + yOffset);
          cursor += block.lineHeight;
        });
      }
      ctx.textBaseline = oldBaseline;
      return cursor;
    }

    if (block.type === "code") {
      var frame = getImageCodeFrame(width);
      var frameX = x + (block.frameInset ?? frame.inset);
      var frameWidth = block.frameWidth || frame.width;
      var paddingX = block.paddingX || frame.paddingX;
      drawRoundRect(ctx, frameX, cursor, frameWidth, block.height - 8, 11, theme.color.codeBg, theme.color.cardBorderAssistant);
      
      var isTerminalTheme = theme.id === "aurora" || theme.id === "terminal";
      if (isTerminalTheme) {
        drawMacTerminalHeader(ctx, frameX, cursor, frameWidth, 30, block.language || "code");
        var codeY = cursor + 48;
        ctx.font = block.font;
        ctx.fillStyle = theme.color.codeText;
        block.lines.forEach(function (line) {
          ctx.fillText(line, frameX + paddingX, codeY);
          codeY += block.lineHeight;
        });
      } else {
        var codeY = cursor + (block.language ? 22 : 16);
        if (block.language) {
          ctx.font = "850 11px " + theme.font.body;
          ctx.fillStyle = theme.color.muted;
          ctx.fillText(block.language.toUpperCase(), frameX + paddingX, codeY);
          codeY += 19;
        }
        ctx.font = block.font;
        ctx.fillStyle = theme.color.codeText;
        block.lines.forEach(function (line) {
          ctx.fillText(line, frameX + paddingX, codeY);
          codeY += block.lineHeight;
        });
      }
      return cursor + block.height;
    }

    if (block.type === "list") {
      var oldBaseline = ctx.textBaseline;
      ctx.textBaseline = "top";
      block.groups.forEach(function (group) {
        var fonts = getFontsForStyle(group.font, theme.font);
        var bulletX = x + group.xOffset;
        var fontSize = group.font.includes("16px") ? 16 : 18;
        var yOffset = (group.lineHeight - fontSize) / 2;
        if (group.richLines) {
          group.richLines.forEach(function (line, lineIndex) {
            var currentX = x + group.xOffset + (group.textIndent || 0);
            
            if (lineIndex === 0) {
              ctx.save();
              ctx.fillStyle = theme.color.ink;
              ctx.font = group.font;
              if (group.ordered) {
                var numStr = group.index + ".";
                ctx.fillText(numStr, bulletX, cursor + yOffset);
              } else {
                var centerY = cursor + group.lineHeight / 2;
                ctx.beginPath();
                if (group.isSub) {
                  ctx.strokeStyle = theme.color.ink;
                  ctx.lineWidth = 1.5;
                  ctx.arc(bulletX + 5, centerY, 3, 0, Math.PI * 2);
                  ctx.stroke();
                } else {
                  ctx.fillStyle = theme.color.ink;
                  ctx.arc(bulletX + 5, centerY, 3, 0, Math.PI * 2);
                  ctx.fill();
                }
              }
              ctx.restore();
            }

            line.chunks.forEach(function (chunk) {
              currentX += drawRichChunk(chunk, currentX, cursor + yOffset, fontSize, fonts, theme.color.ink);
            });
            cursor += group.lineHeight;
          });
        } else {
          ctx.font = group.font;
          ctx.fillStyle = theme.color.ink;
          group.lines.forEach(function (line) {
            ctx.fillText(line, x + group.xOffset, cursor + yOffset);
            cursor += group.lineHeight;
          });
        }
      });
      ctx.textBaseline = oldBaseline;
      return cursor + 8;
    }

    if (block.type === "blockquote") {
      drawRoundRect(ctx, x, cursor, width, block.height - 6, 10, theme.color.quoteBg, theme.color.cardBorderAssistant);
      ctx.fillStyle = theme.color.quoteBorder;
      ctx.fillRect(x, cursor + 8, 4, Math.max(12, block.height - 22));
      var fonts = getFontsForStyle(block.font, theme.font);
      var oldBaseline = ctx.textBaseline;
      ctx.textBaseline = "top";
      var quoteY = cursor + 15;
      if (block.richLines) {
        block.richLines.forEach(function (line) {
          var currentX = x + 20;
          line.chunks.forEach(function (chunk) {
            currentX += drawRichChunk(chunk, currentX, quoteY, 17, fonts, theme.color.ink);
          });
          quoteY += block.lineHeight;
        });
      } else {
        ctx.font = block.font;
        ctx.fillStyle = theme.color.ink;
        block.lines.forEach(function (line) {
          ctx.fillText(line, x + 20, quoteY);
          quoteY += block.lineHeight;
        });
      }
      ctx.textBaseline = oldBaseline;
      return cursor + block.height;
    }

    if (block.type === "table") {
      return renderImageTable(block, x, cursor);
    }

    if (block.type === "separator") {
      ctx.strokeStyle = theme.color.cardBorderAssistant;
      ctx.beginPath();
      ctx.moveTo(x, cursor + SEPARATOR_MARGIN_TOP);
      ctx.lineTo(x + width, cursor + SEPARATOR_MARGIN_TOP);
      ctx.stroke();
      return cursor + block.height;
    }

    return cursor;
  }

  function roundedImagePath(x, y, width, height, radius) {
    var r = Math.min(radius || 0, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawSquareThumbnail(block, x, y, size) {
    var cached = block && block.src && imageCache && imageCache[block.src];
    if (!cached) {
      var fallbackBlock = Object.assign({}, block, {
        width: size,
        height: size + 12,
        originalHeight: size
      });
      drawFallbackPlaceholderImage(x, y - 6, size, fallbackBlock);
      return;
    }

    try {
      ctx.save();
      roundedImagePath(x, y, size, size, 18);
      ctx.clip();
      var srcW = cached.width;
      var srcH = cached.height;
      var side = Math.min(srcW, srcH);
      var sx = Math.max(0, (srcW - side) / 2);
      var sy = Math.max(0, (srcH - side) / 2);
      ctx.drawImage(cached.element, sx, sy, side, side, x, y, size, size);
      ctx.restore();
      ctx.save();
      roundedImagePath(x, y, size, size, 18);
      ctx.strokeStyle = "rgba(15, 23, 42, 0.10)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    } catch (error) {
      ctx.restore();
      var failedBlock = Object.assign({}, block, {
        width: size,
        height: size + 12,
        originalHeight: size
      });
      drawFallbackPlaceholderImage(x, y - 6, size, failedBlock);
    }
  }

  function renderImageGridRow(row, x, cursor) {
    if (!row || !row.blocks || !row.blocks.length) return cursor;
    if (!row.square) {
      var block = row.blocks[0];
      return renderImageBlock(block, x, cursor, block.width, false);
    }

    var imageY = cursor + 6;
    row.blocks.forEach(function (block, index) {
      var imageX = x + index * (row.squareSize + row.gap);
      drawSquareThumbnail(block, imageX, imageY, row.squareSize);
    });
    return cursor + row.height;
  }

  function renderImageTable(block, x, cursor) {
    block.rows.forEach(function (row) {
      var cellX = x;
      row.cellLines.forEach(function (lines) {
        ctx.fillStyle = row.header ? theme.color.cardBgUser : theme.color.cardBgAssistant;
        ctx.fillRect(cellX, cursor, block.cellWidth, row.rowHeight);
        ctx.strokeStyle = theme.color.cardBorderAssistant;
        ctx.strokeRect(cellX, cursor, block.cellWidth, row.rowHeight);
        ctx.font = (row.header ? "800 " : "") + "14px " + theme.font.body;
        ctx.fillStyle = row.header ? theme.color.accentDark : theme.color.ink;
        lines.forEach(function (line, lineIndex) {
          ctx.fillText(line, cellX + 9, cursor + 22 + lineIndex * 20);
        });
        cellX += block.cellWidth;
      });
      cursor += row.rowHeight;
    });
    return cursor + 12;
  }

  var oldHeaderBaseline = ctx.textBaseline;
  ctx.textBaseline = "top";
  if (settings.show_conversation_title) {
    ctx.font = "800 34px " + theme.font.title;
    ctx.fillStyle = theme.color.ink;
    titleLines.forEach(function (line) {
      ctx.fillText(line, pad, y);
      y += IMAGE_TITLE_LINE_HEIGHT;
    });
  }

  if (titleLines.length && hasHeaderMeta) {
    y += IMAGE_TITLE_META_GAP;
  }

  if (hasHeaderMeta) {
    ctx.font = "700 16px " + theme.font.body;
    ctx.fillStyle = theme.color.muted;
    var meta = [];
    if (settings.show_platform_name) meta.push(getPlatformLabel(metadata.platform));
    if (settings.show_export_time) meta.push(formatDateDisplay(metadata.exportedAt));
    ctx.fillText(meta.join(" · "), pad, y);
    y += IMAGE_META_LINE_HEIGHT;
  }
  ctx.textBaseline = oldHeaderBaseline;

  y += IMAGE_HEADER_RULE_TOP_GAP;
  var titleRule = ctx.createLinearGradient(pad, y, width - pad, y);
  titleRule.addColorStop(0, theme.color.accent);
  titleRule.addColorStop(0.22, theme.color.cardBorderAssistant || theme.color.line || theme.color.accent);
  titleRule.addColorStop(1, theme.color.line || theme.color.cardBorderAssistant || theme.color.accent);
  ctx.strokeStyle = titleRule;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(width - pad, y);
  ctx.stroke();
  ctx.lineWidth = 1;
  y += IMAGE_HEADER_RULE_BOTTOM_GAP;

  for (var layoutIndex = 0; layoutIndex < messageLayouts.length; layoutIndex++) {
    throwIfAborted();
    var layout = messageLayouts[layoutIndex];
    var message = layout.message;
    var cardWidth = layout.cardWidth || contentWidth;
    var cardX = layout.alignRight ? (pad + contentWidth - cardWidth) : pad;

    var cardFill = message.role === "user" ? theme.color.cardBgUser : theme.color.cardBgAssistant;
    var cardStroke = message.role === "user" ? theme.color.cardBorderUser : theme.color.cardBorderAssistant;
    var cardShadow = theme.color.shadow || "transparent";
    
    var currentY = y;
    
    if (!layout.labelInBubble && layout.roleHeight) {
      var label = message.role === "user" ? t("export_role_user", "You Asked") : getPlatformLabel(metadata.platform).toUpperCase();
      ctx.font = "850 13px " + theme.font.body;
      var tagWidth = ctx.measureText(label).width + 26;
      var tagFill = message.role === "user" ? theme.color.tagBgUser : theme.color.tagBgAssistant;
      var tagStroke = message.role === "user" ? theme.color.tagBorderUser : theme.color.tagBorderAssistant;
      
      var tagX = layout.alignRight ? (cardX + cardWidth - tagWidth) : cardX;
      drawRoundRect(ctx, tagX, currentY, tagWidth, 28, 8, tagFill, tagStroke);
      var tagText = message.role === "user"
        ? (theme.color.tagTextUser || theme.color.accentDark)
        : (theme.color.tagTextAssistant || theme.color.muted);
      ctx.fillStyle = tagText;
      ctx.fillText(label, tagX + 13, imageLabelBaseline(currentY, 28));
      currentY += layout.roleHeight + 8;
    }
    
    (layout.flowSections || []).forEach(function (section, sectionIndex) {
      if (sectionIndex) currentY += 14;

      if (section.type === "images") {
        section.rows.forEach(function (row, index) {
          if (index) currentY += 8;
          var imgX;
          if (layout.alignRight) {
            imgX = pad + contentWidth - row.width;
          } else {
            if (settings.align_user_messages_right) {
              imgX = pad;
            } else {
              imgX = pad + Math.max(0, (contentWidth - row.width) / 2);
            }
          }
          currentY = renderImageGridRow(row, imgX, currentY);
        });
        return;
      }

      if (section.type !== "bubble") {
        return;
      }

      drawPremiumCard(ctx, cardX, currentY, cardWidth, section.height, 16, cardFill, cardStroke, cardShadow);
      if (theme.id !== "editorial" && !layout.alignRight) {
        ctx.fillStyle = message.role === "user" ? theme.color.accent : theme.color.muted;
        ctx.fillRect(cardX, currentY + 20, 4, Math.max(12, section.height - 40));
      }
      var innerX = cardX + 24;
      var innerWidth = cardWidth - 48;
      var innerY = currentY + 18;

      section.blocks.forEach(function (block, index) {
        if (index) innerY += 8;
        innerY = renderImageBlock(block, innerX, innerY, innerWidth, false);
      });

      currentY += section.height;
    });
    
    y = currentY + IMAGE_MESSAGE_BOTTOM_GAP;
    if (layoutIndex % 5 === 4 || layoutIndex === messageLayouts.length - 1) {
      notifyProgress(options, t("export_progress_rendering", "Rendering image"), 0.36 + 0.5 * ((layoutIndex + 1) / Math.max(1, messageLayouts.length)));
      await yieldToBrowser();
    }
  }

  if (settings.show_chatvault_badge) {
    var footerY = y + IMAGE_FOOTER_TOP_GAP;
    ctx.font = "800 18px " + theme.font.body;
    var logoGradient = ctx.createLinearGradient(pad, footerY, pad + 120, footerY);
    logoGradient.addColorStop(0, theme.color.accent);
    logoGradient.addColorStop(1, theme.color.accentDark);
    ctx.fillStyle = logoGradient;
    ctx.fillText("ChatVault AI", pad, footerY);
    ctx.font = "500 14px " + theme.font.body;
    ctx.fillStyle = theme.color.muted;
    ctx.fillText(t("export_image_footer_sub", "Local export · content not stored"), pad + 130, footerY);
  }

  notifyProgress(options, t("export_progress_saving", "Saving image"), 0.94);
  throwIfAborted();
  var imageBlob = await canvasToBlob(c.canvas, "image/png");
  throwIfAborted();
  notifyProgress(options, t("export_progress_ready", "Image ready"), 1);
  return imageBlob;
}
