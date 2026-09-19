import {
  getPlatformLabel,
  t,
  formatDateDisplay,
  IMAGE_RENDER_WIDTH,
  notifyProgress,
  yieldToBrowser,
  sanitizeExportText,
  sanitizeImageAlt,
  normalizeExportLinkHref,
  mapLimit,
  formatLatexUnicode,
  createCanvas,
  canvasToBlob,
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
import { preloadCanvasImages, imageBytesCache } from '../media.js';
import { getPdfTheme } from '../themes/pdf.js';
import { getMathAssetKey, mathFallbackText, preloadMathAssets } from '../math.js';

var SEPARATOR_MARGIN_TOP = 25;
var SEPARATOR_MARGIN_BOTTOM = 25;
var PDF_MAX_PAGES = 300;
var PDF_MAX_ENCODED_PAGE_BYTES = 150 * 1024 * 1024;
var PDF_MAX_TABLE_ROW_LINES = 40;
var PDF_FAST_PENDING_PAGE_JOBS = 5;
var PDF_CONSERVATIVE_PENDING_PAGE_JOBS = 2;
var PDF_DEFAULT_CANVAS_SCALE = 3;
var PDF_CONSERVATIVE_CANVAS_SCALE = 2.5;
var PDF_LOW_MEMORY_CANVAS_SCALE = 2.25;

function getInlineValueLength(value) {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) {
    return value.reduce(function (sum, item) { return sum + getInlineValueLength(item); }, 0);
  }
  if (!value || typeof value !== "object") return 0;
  if (typeof value.text === "string") return value.text.length;
  if (Array.isArray(value.segments)) return getInlineValueLength(value.segments);
  return 0;
}

function getExplicitLineCount(value) {
  var text = typeof value === "string"
    ? value
    : value && typeof value.text === "string"
      ? value.text
      : "";
  return text ? text.split(/\r?\n/).length : 0;
}

function shouldUseConservativePdfEncoding(messages, deviceMemoryInput) {
  var totalTextLength = 0;
  var totalBlocks = 0;
  var imageCount = 0;
  var oversizedStructure = false;

  (messages || []).forEach(function (message) {
    (message && message.contentBlocks || []).forEach(function (block) {
      if (!block || oversizedStructure) return;
      totalBlocks += 1;

      if (block.type === "image") {
        imageCount += 1;
        return;
      }

      if (block.type === "list") {
        var listUnits = 0;
        (block.items || []).forEach(function (item) {
          listUnits += 1;
          totalTextLength += getInlineValueLength(item);
          (item && item.subItems || []).forEach(function (subItem) {
            listUnits += 1;
            totalTextLength += getInlineValueLength(subItem);
          });
        });
        if (listUnits >= 160) oversizedStructure = true;
        return;
      }

      if (block.type === "table") {
        var rows = block.rows || [];
        totalTextLength += getInlineValueLength(block.headers || []);
        rows.forEach(function (row) {
          (row || []).forEach(function (cell) {
            totalTextLength += getInlineValueLength(cell);
            if (getExplicitLineCount(cell) >= 60) oversizedStructure = true;
          });
        });
        if (rows.length >= 60) oversizedStructure = true;
        return;
      }

      totalTextLength += getInlineValueLength(block);
      if ((block.type === "blockquote" || block.type === "code") && getExplicitLineCount(block) >= 120) {
        oversizedStructure = true;
      }
    });
  });

  var deviceMemory = Number(deviceMemoryInput);
  if (!Number.isFinite(deviceMemory) || deviceMemory <= 0) {
    try {
      deviceMemory = Number(globalThis.navigator && globalThis.navigator.deviceMemory || 0);
    } catch (error) {
      deviceMemory = 0;
    }
  }

  return oversizedStructure ||
    totalTextLength >= 120000 ||
    totalBlocks >= 600 ||
    imageCount >= 12 ||
    (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4);
}

export function getPdfRenderProfile(messages, deviceMemoryInput) {
  var deviceMemory = Number(deviceMemoryInput);
  if (!Number.isFinite(deviceMemory) || deviceMemory <= 0) {
    try {
      deviceMemory = Number(globalThis.navigator && globalThis.navigator.deviceMemory || 0);
    } catch (error) {
      deviceMemory = 0;
    }
  }
  var conservative = shouldUseConservativePdfEncoding(messages, deviceMemory);
  var scale = deviceMemory > 0 && deviceMemory <= 4
    ? PDF_LOW_MEMORY_CANVAS_SCALE
    : conservative
      ? PDF_CONSERVATIVE_CANVAS_SCALE
      : PDF_DEFAULT_CANVAS_SCALE;
  return {
    conservative: conservative,
    scale: scale,
    maxPendingPageJobs: conservative
      ? PDF_CONSERVATIVE_PENDING_PAGE_JOBS
      : PDF_FAST_PENDING_PAGE_JOBS
  };
}

function isPlainPdfRichLine(line) {
  return Boolean(line && Array.isArray(line.chunks) && line.chunks.every(function (chunk) {
    return !chunk || (!chunk.bold && !chunk.italic && !chunk.code && !chunk.href);
  }));
}

// 判断颜色字符串是否为透明（"transparent" 或 alpha=0 的 rgba），用于占位框等场景回退到可见色
function isTransparentPdfColor(value) {
  if (!value || typeof value !== "string") return false;
  var v = value.trim().toLowerCase();
  if (v === "transparent") return true;
  var m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    var parts = m[1].split(",").map(function (s) { return s.trim(); });
    var alpha = parts.length === 4 ? parseFloat(parts[3]) : 1;
    return alpha === 0;
  }
  return false;
}

function getCenteredTextBaseline(ctx, top, height) {
  var metrics = ctx.measureText("Hg");
  if (metrics && Number.isFinite(metrics.actualBoundingBoxAscent) && Number.isFinite(metrics.actualBoundingBoxDescent)) {
    return top + height / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  }
  return top + height / 2 + 4;
}

async function buildPdfBlobInternal(messages, metadata, settingsInput, options) {
  options = options || {};
  if (options.signal && options.signal.aborted) {
    var abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    throw abortErr;
  }
  var renderProfile = getPdfRenderProfile(messages);
  var imageCache = await preloadCanvasImages(messages, Object.assign({}, options, {
    imageRenderScale: renderProfile.scale
  }));
  var mathAssets = await preloadMathAssets(messages, options, 15, true);
  notifyProgress(options, t("export_progress_paginating_doc", "Paginating export"), 0.04);
  var pages = await renderPdfPages(messages, metadata, settingsInput, {
    signal: options.signal,
    onProgress: function (progress) {
      notifyProgress(options, progress.message || t("export_progress_paginating_doc", "Paginating export"), 0.04 + 0.62 * (progress.progress || 0));
    }
  }, imageCache, mathAssets);
  notifyProgress(options, t("export_progress_generating_pdf", "Generating PDF"), 0.68);
  var pdf = createPdfFromJpegs(pages, pages[0] && pages[0].canvasScale || PDF_DEFAULT_CANVAS_SCALE);
  notifyProgress(options, t("export_progress_ready_doc", "Export ready"), 1);
  return pdf;
}

export async function buildPdfBlob(messages, metadata, settingsInput, options) {
  try {
    return await buildPdfBlobInternal(messages, metadata, settingsInput, options);
  } finally {
    imageBytesCache.clear();
  }
}

export async function renderPdfPages(messages, metadata, settingsInput, options, imageCache, mathAssets) {
  options = options || {};
  var themeConfig = getPdfTheme(settingsInput);
  var settings = themeConfig.settings;
  var theme = themeConfig.theme;
  var DESIGN = themeConfig.design;
  var flatLayout = themeConfig.styleId === "natural";
  mathAssets = mathAssets || new Map();

  var pageWidth = 794;
  var pageHeight = 1123;
  var renderProfile = getPdfRenderProfile(messages);
  var scale = renderProfile.scale;
  var margin = 56;
  var topMargin = 54;
  var bottomMargin = 74;
  var contentWidth = pageWidth - margin * 2;
  var pageJobs = [];
  var maxPendingPageJobs = renderProfile.maxPendingPageJobs;
  var encodedPages = [];
  var totalPageCount = 0;
  var encodedPageBytes = 0;
  var current = null;
  var currentCanvas = null;
  var currentPageLinks = [];
  var ctx = null;
  var contentClipActive = false;
  var y = 0;
  var pageNumber = 0;
  // Newsprint 主题噪点 pattern 缓存：避免每页重新生成 400 个随机 fillRect。
  var newsprintNoisePattern = null;
  var bodyFont = "15px " + DESIGN.font.body;
  var bodyLineHeight = 24;
  var MIN_FITTED_IMAGE_ROW_HEIGHT = 180;

  function newPage() {
      finalizeCurrentPage();
      current = createCanvas(pageWidth, pageHeight, scale);
      ctx = current.ctx;
      currentPageLinks = [];

      if (theme.bg && theme.bg.type === "mesh") {
        ctx.fillStyle = theme.bg.colors[0];
        ctx.fillRect(0, 0, pageWidth, pageHeight);

        var g1 = ctx.createRadialGradient(0, 0, 10, 0, 0, pageWidth * 0.9);
        g1.addColorStop(0, "rgba(228, 213, 246, 0.85)");
        g1.addColorStop(1, "rgba(228, 213, 246, 0)");
        ctx.fillStyle = g1;
        ctx.fillRect(0, 0, pageWidth, pageHeight);

        var g2 = ctx.createRadialGradient(pageWidth, pageHeight, 10, pageWidth, pageHeight, pageWidth * 0.9);
        g2.addColorStop(0, "rgba(211, 243, 238, 0.85)");
        g2.addColorStop(1, "rgba(211, 243, 238, 0)");
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, pageWidth, pageHeight);
      } else if (theme.bg && theme.bg.type === "gradient") {
        var bg = ctx.createLinearGradient(0, 0, pageWidth, pageHeight);
        bg.addColorStop(0, theme.bg.colors[0]);
        bg.addColorStop(0.45, theme.bg.colors[1]);
        bg.addColorStop(1, theme.bg.colors[2]);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, pageWidth, pageHeight);
      } else {
        ctx.fillStyle = (theme.bg && theme.bg.colors && theme.bg.colors[0]) || "#ffffff";
        ctx.fillRect(0, 0, pageWidth, pageHeight);
      }
      
      if (theme.id === "newsprint") {
        // 优化：原实现每页都重新生成 400 个随机噪点并逐个 fillRect，
        // 300 页 PDF = 12 万次 fillRect 调用且每页噪点位置不同（视觉不一致）。
        // 改为首次生成离屏 canvas 噪点纹理，后续用 createPattern 复用，
        // 既提速又保证所有页噪点视觉一致。
        if (!newsprintNoisePattern) {
          var noiseCanvas = document.createElement("canvas");
          noiseCanvas.width = Math.round(pageWidth);
          noiseCanvas.height = Math.round(pageHeight);
          var noiseCtx = noiseCanvas.getContext("2d");
          noiseCtx.fillStyle = "rgba(0, 0, 0, 0.015)";
          for (var i = 0; i < 400; i++) {
            var rx = Math.random() * pageWidth;
            var ry = Math.random() * pageHeight;
            var rw = Math.random() * 2 + 1;
            var rh = Math.random() * 2 + 1;
            noiseCtx.fillRect(rx, ry, rw, rh);
          }
          newsprintNoisePattern = ctx.createPattern(noiseCanvas, "no-repeat");
          // createPattern 在创建时已快照画布像素，释放原画布位图以降低长 PDF 内存占用
          noiseCanvas.width = 1;
          noiseCanvas.height = 1;
        }
        if (newsprintNoisePattern) {
          ctx.fillStyle = newsprintNoisePattern;
          ctx.fillRect(0, 0, pageWidth, pageHeight);
        }
      }

      ctx.fillStyle = DESIGN.color.accent;
      ctx.fillRect(0, 0, pageWidth, 6);
      
      pageNumber += 1;
      y = topMargin;
      currentCanvas = current.canvas;
      drawFooter();
      // Defense in depth: even if a future block paginator regresses, body
      // drawing must never enter the reserved footer area.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, pageWidth, pageHeight - bottomMargin);
      ctx.clip();
      contentClipActive = true;
    }

  function ensure(height) {
    if (!current || y + height > pageHeight - bottomMargin) {
      newPage();
    }
  }

  function remainingPageHeight() {
    return Math.max(0, pageHeight - bottomMargin - y);
  }

  function drawFooter() {
    if (!settings.show_chatvault_badge) return;
    ctx.font = "10px " + DESIGN.font.body;
    ctx.fillStyle = DESIGN.color.muted;
    ctx.fillText(t("export_pdf_footer_branding", "Exported by AI Chat Export"), margin, pageHeight - 36);
  }

  function finalizeCurrentPage() {
    if (!currentCanvas) return;
    if (contentClipActive && ctx) {
      ctx.restore();
      contentClipActive = false;
    }
    totalPageCount += 1;
    if (totalPageCount > PDF_MAX_PAGES) {
      throw new Error(t("export_pdf_too_many_pages", "This conversation is too large to export as one PDF safely. Export a shorter range."));
    }
    var canvas = currentCanvas;
    var canvasWidth = canvas.width;
    var canvasHeight = canvas.height;
    var links = currentPageLinks.slice();
    var finalizedPageNumber = totalPageCount;
    currentCanvas = null;
    currentPageLinks = [];
    pageJobs.push((async function () {
      try {
        // Use async canvas encoding so repeated PDF exports do not monopolize the page thread.
        var blob = await canvasToBlob(canvas, "image/jpeg", 0.85);
        var bytes = new Uint8Array(await blob.arrayBuffer());
        encodedPageBytes += bytes.byteLength;
        return {
          width: canvasWidth,
          height: canvasHeight,
          bytes: bytes,
          logicalWidth: pageWidth,
          logicalHeight: pageHeight,
          canvasScale: scale,
          links: links
        };
      } catch (e) {
        // 偶发编码失败（通常是内存压力）时，先以更低质量重试一次，避免单页失败导致整个导出丢失。
        console.warn("[pdf] canvas encoding failed, retrying with lower quality", {
          page: finalizedPageNumber,
          error_type: e && e.name ? e.name : typeof e
        });
        try {
          var fallbackBlob = await canvasToBlob(canvas, "image/jpeg", 0.7);
          var fallbackBytes = new Uint8Array(await fallbackBlob.arrayBuffer());
          encodedPageBytes += fallbackBytes.byteLength;
          return {
            width: canvasWidth,
            height: canvasHeight,
            bytes: fallbackBytes,
            logicalWidth: pageWidth,
            logicalHeight: pageHeight,
            canvasScale: scale,
            links: links
          };
        } catch (e2) {
          console.warn("[pdf] canvas encoding retry also failed", {
            page: finalizedPageNumber,
            error_type: e2 && e2.name ? e2.name : typeof e2
          });
          throw new Error(t("export_pdf_encode_failed", "PDF page rendering failed. Please try again."));
        }
      } finally {
        try {
          canvas.width = 1;
          canvas.height = 1;
        } catch (e) {}
      }
    })());
  }

  async function drainPageJobs() {
    if (!pageJobs.length) return;
    var jobs = pageJobs;
    pageJobs = [];
    var results = await Promise.all(jobs);
    for (var i = 0; i < results.length; i++) {
      encodedPages.push(results[i]);
    }
    if (encodedPageBytes > PDF_MAX_ENCODED_PAGE_BYTES) {
      throw new Error(t("export_pdf_too_large", "This conversation is too large to export as one PDF safely. Export a shorter range."));
    }
  }

  async function drainPageJobsIfNeeded() {
    if (pageJobs.length < maxPendingPageJobs) return;
    await drainPageJobs();
    await yieldToBrowser();
  }

  async function settlePendingPageJobs() {
    if (!pageJobs.length) return;
    var jobs = pageJobs;
    pageJobs = [];
    await Promise.allSettled(jobs);
  }

  function releaseUnfinalizedPage() {
    if (contentClipActive && ctx) {
      try {
        ctx.restore();
      } catch (error) {}
      contentClipActive = false;
    }
    if (currentCanvas) {
      try {
        currentCanvas.width = 1;
        currentCanvas.height = 1;
      } catch (error) {}
    }
    current = null;
    currentCanvas = null;
    currentPageLinks = [];
    ctx = null;
  }

  function drawLines(lines, font, color, lineHeight, x) {
    ctx.font = font;
    ctx.fillStyle = color;
    lines.forEach(function (line) {
      ensure(lineHeight + 4);
      ctx.fillText(line, x || margin, y);
      y += lineHeight;
    });
  }

  try {
    newPage();

    if (settings.show_conversation_title) {
      var titleFont = "800 30px " + DESIGN.font.title;
      var titleLines = wrapText(ctx, cleanInlineMarkdownText(metadata.title || "Untitled Chat"), contentWidth, titleFont).slice(0, 4);
      drawLines(titleLines, titleFont, DESIGN.color.ink, 37);
      y += 8;
    }

    var meta = [];
    if (settings.show_platform_name) meta.push(getPlatformLabel(metadata.platform));
    if (settings.show_export_time) meta.push(formatDateDisplay(metadata.exportedAt));
    if (settings.include_source_url && metadata.sourceUrl) meta.push(metadata.sourceUrl);
    if (meta.length) {
      var metaFont = "700 12px " + DESIGN.font.body;
      var metaLines = wrapText(ctx, meta.join(" · "), contentWidth - 26, metaFont);
      var metaHeight = metaLines.length * 17 + 16;
      drawRoundRect(ctx, margin, y, contentWidth, metaHeight, 11, DESIGN.color.cardBgUser, DESIGN.color.cardBorderUser);
      ctx.font = metaFont;
      ctx.fillStyle = DESIGN.color.accentDark;
      var metaStartY = y + (metaHeight - metaLines.length * 17) / 2;
      metaLines.forEach(function (line, index) {
        ctx.fillText(line, margin + 13, getCenteredTextBaseline(ctx, metaStartY + index * 17, 17));
      });
      y += metaHeight;
    }
    y += 26;

    for (var mi = 0; mi < messages.length; mi++) {
      if (options && options.signal && options.signal.aborted) {
        var err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      var message = messages[mi];
      var layout = measurePdfMessage(message);
      await renderPdfMessageCard(layout);
      if (mi > 0 && mi % 20 === 0) {
        notifyProgress(options, t("export_progress_paginating_doc", "Paginating export"), 0.08 + 0.64 * ((mi + 1) / Math.max(1, messages.length)));
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
      if (pageJobs.length >= maxPendingPageJobs) {
        await drainPageJobs();
      }
    }
    notifyProgress(options, t("export_progress_paginating_doc", "Paginating export"), 0.74);
    finalizeCurrentPage();
    await drainPageJobs();
    if (!encodedPages.length) {
      throw new Error(t("export_pdf_encode_failed", "PDF page rendering failed. Please try again."));
    }
    return encodedPages;
  } catch (error) {
    releaseUnfinalizedPage();
    await settlePendingPageJobs();
    throw error;
  }

  function measurePdfMessage(message) {
    var isUser = message.role === "user";
    var alignRight = isUser && settings.align_user_messages_right;
    
    var maxCardWidth = alignRight ? contentWidth * 0.75 : contentWidth;
    var horizontalPadding = flatLayout ? 8 : 44;
    var maxInnerWidth = maxCardWidth - horizontalPadding;
    var allBlocks = expandInlineMathBlocks(message.contentBlocks).map(function (block) {
      return measurePdfBlock(getVisualMessageBlock(block, message.role), maxInnerWidth);
    }).filter(Boolean);
    
    var bubbleBlocks = allBlocks.filter(function (b) { return b.type !== "image"; });
    
    var cardWidth = alignRight ? contentWidth * 0.75 : contentWidth;
    if (alignRight && bubbleBlocks.length > 0) {
      var maxContentW = 0;
      bubbleBlocks.forEach(function (block) {
        if (block.type === "paragraph" || block.type === "heading") {
          if (block.lines) {
            ctx.font = block.font;
            block.lines.forEach(function (line) {
              var w = ctx.measureText(line).width;
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
            ctx.font = block.font;
            block.lines.forEach(function (line) {
              var w = ctx.measureText(line).width + 36;
              if (w > maxQuoteLineW) maxQuoteLineW = w;
            });
          }
          if (maxQuoteLineW > maxContentW) maxContentW = maxQuoteLineW;
        } else {
          if (block.width && block.width > maxContentW) maxContentW = block.width;
        }
      });
      var limit = contentWidth * 0.75;
      cardWidth = Math.min(limit, Math.max(120, maxContentW + horizontalPadding));
    }
    
    var currentRoleHeight = 0;
    if (settings.show_role_labels && metadata.scope !== "ai_only") {
      currentRoleHeight = flatLayout ? 22 : 31;
    }
    
    var flowSections = buildPdfFlowSections(allBlocks, cardWidth);
    var totalFlowHeight = flowSections.reduce(function (sum, section, index) {
      return sum + section.height + (index ? 12 : 0);
    }, 0);
    var imageRows = flowSections
      .filter(function (section) { return section.type === "images"; })
      .flatMap(function (section) { return section.rows; });
    var bubbleHeight = flowSections
      .filter(function (section) { return section.type === "bubble"; })
      .reduce(function (sum, section) { return sum + section.height; }, 0);
    var labelInBubble = false;
    var totalHeight = currentRoleHeight + totalFlowHeight + (currentRoleHeight > 0 ? 6 : 0);
    
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

  function getVisualMessageBlock(block, role) {
    if (role === "user" && block && block.type === "blockquote") {
      return Object.assign({}, block, { type: "paragraph" });
    }
    return block;
  }

  // Canvas cannot typeset MathML inline. Retain formula geometry by flowing a
  // semantic inline equation as its own adjacent KaTeX image row, rather than
  // flattening it to lossy Unicode text.
  function expandInlineMathBlocks(blocks) {
    var output = [];
    (blocks || []).forEach(function (block) {
      var segments = block && block.type === "paragraph" && Array.isArray(block.segments) ? block.segments : null;
      var hasMath = segments && segments.some(function (segment) {
        var marks = segment && segment.marks || {};
        return Boolean(segment && (segment.math || marks.math));
      });
      if (!hasMath) {
        output.push(block);
        return;
      }
      var textSegments = [];
      function flushText() {
        if (!textSegments.length) return;
        output.push({ ...block, type: "paragraph", text: textSegments.map(function (item) { return item.text || ""; }).join(""), segments: textSegments });
        textSegments = [];
      }
      segments.forEach(function (segment) {
        var marks = segment && segment.marks || {};
        if (segment && (segment.math || marks.math)) {
          flushText();
          output.push({ type: "math", text: segment.text || "", display: false, inline: true });
        } else if (segment) {
          textSegments.push(segment);
        }
      });
      flushText();
    });
    return output;
  }

  function buildPdfFlowSections(blocks, cardWidth) {
    var sections = [];
    var pendingText = [];
    var pendingImages = [];

    function flushText() {
      if (!pendingText.length) return;
      var contentHeight = pendingText.reduce(function (sum, block, index) {
        return sum + block.height + (index ? 5 : 0);
      }, 0);
      sections.push({
        type: "bubble",
        blocks: pendingText,
        height: (flatLayout ? 6 : 13) + Math.max(contentHeight, bodyLineHeight) + (flatLayout ? 6 : 13)
      });
      pendingText = [];
    }

    function flushImages() {
      if (!pendingImages.length) return;
      var rows = measurePdfImageGridRows(pendingImages, cardWidth);
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

  function canSplitPdfLayout(layout) {
    return layout.blocks.length > 1 || layout.blocks.some(function (block) {
      return block && block.height > 130 && /^(paragraph|code|list|blockquote|table)$/.test(block.type);
    });
  }

  function getPdfCodeFrame(width) {
    var inset = Math.min(16, Math.max(10, Math.round(width * 0.025)));
    return {
      inset: inset,
      width: Math.max(180, width - inset * 2),
      paddingX: 14,
      paddingTop: 12,
      paddingBottom: 12
    };
  }

  function shouldDrawPdfCodeHeader(block, lineStart) {
    var isTerminalTheme = theme.id === "aurora" || theme.id === "terminal";
    return lineStart === 0 && Boolean(block.language || isTerminalTheme);
  }

  function getPdfCodeHeaderHeight(block, lineStart) {
    return shouldDrawPdfCodeHeader(block, lineStart) ? 26 : 12;
  }

  function createPdfCodeChunk(block, lineStart, lineCount, heightOverride) {
    var lines = block.lines && block.lines.length ? block.lines : [""];
    var safeStart = Math.max(0, Math.min(lines.length - 1, Number(lineStart) || 0));
    var safeCount = Math.max(1, Math.min(lines.length - safeStart, Number(lineCount) || 1));
    var isFirst = safeStart === 0;
    var isLast = safeStart + safeCount >= lines.length;
    var headerHeight = getPdfCodeHeaderHeight(block, safeStart);
    var naturalHeight = safeCount * block.lineHeight + headerHeight + 18;
    return Object.assign({}, block, {
      lines: lines.slice(safeStart, safeStart + safeCount),
      language: isFirst ? block.language : "",
      lineStart: safeStart,
      drawCodeHeader: shouldDrawPdfCodeHeader(block, safeStart),
      hasTopRound: isFirst,
      hasBottomRound: isLast,
      height: isLast ? naturalHeight : Math.max(naturalHeight, heightOverride || naturalHeight)
    });
  }

  function planPdfCodeChunk(block, lineStart, availableHeight) {
    var lines = block.lines && block.lines.length ? block.lines : [""];
    var safeStart = Math.max(0, Math.min(lines.length - 1, Number(lineStart) || 0));
    var headerHeight = getPdfCodeHeaderHeight(block, safeStart);
    var minHeight = headerHeight + 18 + block.lineHeight;
    if (availableHeight < minHeight) {
      return null;
    }
    var maxLines = Math.max(1, Math.floor((availableHeight - headerHeight - 18) / block.lineHeight));
    var take = Math.min(lines.length - safeStart, maxLines);
    return {
      take: take,
      block: createPdfCodeChunk(block, safeStart, take, availableHeight)
    };
  }

  function createPdfListChunk(block, lineStart, lineCount) {
    var renderLines = block.renderLines || [];
    var safeStart = Math.max(0, Math.min(renderLines.length - 1, Number(lineStart) || 0));
    var safeCount = Math.max(1, Math.min(renderLines.length - safeStart, Number(lineCount) || 1));
    var selected = renderLines.slice(safeStart, safeStart + safeCount);
    var groups = [];
    var contentHeight = 0;

    selected.forEach(function (entry) {
      contentHeight += entry.group.lineHeight;
      var current = groups[groups.length - 1];
      if (!current || current.sourceGroupIndex !== entry.groupIndex) {
        current = Object.assign({}, entry.group, {
          richLines: [],
          sourceGroupIndex: entry.groupIndex,
          showMarker: entry.lineIndex === 0
        });
        groups.push(current);
      }
      current.richLines.push(entry.richLine);
    });

    return Object.assign({}, block, {
      groups: groups,
      height: contentHeight + 6
    });
  }

  function planPdfListChunk(block, lineStart, availableHeight) {
    var renderLines = block.renderLines || [];
    var safeStart = Math.max(0, Math.min(renderLines.length - 1, Number(lineStart) || 0));
    var take = 0;
    var contentHeight = 0;

    while (safeStart + take < renderLines.length) {
      var nextHeight = renderLines[safeStart + take].group.lineHeight;
      if (contentHeight + nextHeight + 6 > availableHeight) break;
      contentHeight += nextHeight;
      take += 1;
    }
    if (take < 1) return null;
    return {
      take: take,
      block: createPdfListChunk(block, safeStart, take)
    };
  }

  function createPdfBlockquoteChunk(block, lineStart, lineCount) {
    var lines = block.lines && block.lines.length ? block.lines : [""];
    var safeStart = Math.max(0, Math.min(lines.length - 1, Number(lineStart) || 0));
    var safeCount = Math.max(1, Math.min(lines.length - safeStart, Number(lineCount) || 1));
    var richLines = block.richLines && block.richLines.length
      ? block.richLines.slice(safeStart, safeStart + safeCount)
      : null;
    return Object.assign({}, block, {
      lines: lines.slice(safeStart, safeStart + safeCount),
      richLines: richLines,
      height: safeCount * block.lineHeight + 24
    });
  }

  function planPdfBlockquoteChunk(block, lineStart, availableHeight) {
    var lines = block.lines && block.lines.length ? block.lines : [""];
    var safeStart = Math.max(0, Math.min(lines.length - 1, Number(lineStart) || 0));
    var maxLines = Math.floor((availableHeight - 24) / block.lineHeight);
    if (maxLines < 1) return null;
    var take = Math.min(lines.length - safeStart, maxLines);
    return {
      take: take,
      block: createPdfBlockquoteChunk(block, safeStart, take)
    };
  }

  function createPdfTableChunk(block, rowStart, rowCount) {
    var rows = block.rows || [];
    var safeStart = Math.max(0, Math.min(rows.length - 1, Number(rowStart) || 0));
    var safeCount = Math.max(1, Math.min(rows.length - safeStart, Number(rowCount) || 1));
    var chunkRows = rows.slice(safeStart, safeStart + safeCount);
    return Object.assign({}, block, {
      rows: chunkRows,
      height: chunkRows.reduce(function (sum, row) { return sum + row.rowHeight; }, 0) + 12
    });
  }

  function planPdfTableChunk(block, rowStart, availableHeight) {
    var rows = block.rows || [];
    var safeStart = Math.max(0, Math.min(rows.length - 1, Number(rowStart) || 0));
    var take = 0;
    var contentHeight = 0;

    while (safeStart + take < rows.length) {
      var nextHeight = rows[safeStart + take].rowHeight;
      if (contentHeight + nextHeight + 12 > availableHeight) break;
      contentHeight += nextHeight;
      take += 1;
    }
    if (take < 1) return null;
    return {
      take: take,
      block: createPdfTableChunk(block, safeStart, take)
    };
  }

  function getPdfChunkUnitCount(block) {
    if (!block) return 0;
    if (block.type === "list") return (block.renderLines || []).length;
    if (block.type === "blockquote") return block.lines && block.lines.length ? block.lines.length : 1;
    if (block.type === "table") return (block.rows || []).length;
    return 0;
  }

  function getPdfChunkMinimumHeight(block, unitStart) {
    var safeStart = Math.max(0, Number(unitStart) || 0);
    if (block.type === "list") {
      var entry = (block.renderLines || [])[safeStart];
      return entry ? entry.group.lineHeight + 6 : 0;
    }
    if (block.type === "blockquote") return block.lineHeight + 24;
    if (block.type === "table") {
      var row = (block.rows || [])[safeStart];
      return row ? row.rowHeight + 12 : 0;
    }
    return 0;
  }

  function planPdfChunkedBlock(block, unitStart, availableHeight) {
    if (!block) return null;
    if (block.type === "list") return planPdfListChunk(block, unitStart, availableHeight);
    if (block.type === "blockquote") return planPdfBlockquoteChunk(block, unitStart, availableHeight);
    if (block.type === "table") return planPdfTableChunk(block, unitStart, availableHeight);
    return null;
  }

  function measurePdfBlock(block, width) {
    if (!block) return null;
    if (block.type === "heading") {
      var size = block.level === 1 ? 21 : block.level === 2 ? 18 : 16;
      var headingFont = "800 " + size + "px " + DESIGN.font.title;
      var headingRichText = getInlineRichText(block);
      // 优化：从 richLines 派生 lines，省去一次完整 wrapText 调用。
      var richLines = wrapRichText(ctx, headingRichText, width, headingFont, DESIGN.font);
      var headingLines = richLines.length ? richLines.map(function (line) {
        return line.chunks.map(function (c) { return c.text; }).join("");
      }) : [""];
      return { type: "heading", lines: headingLines, richLines: richLines, font: headingFont, lineHeight: size + 9, height: richLines.length * (size + 9) };
    }
    if (block.type === "paragraph") {
      var paragraphRichText = getInlineRichText(block);
      // 优化：不再单独调用 wrapText（与 wrapRichText 计算量相当但结果 lines 仅用于测量）。
      // 改为从 richLines 派生 plain text lines，测量精度不变（chunks 求和等价于 measureText(整行)）。
      var richLines = wrapRichText(ctx, paragraphRichText, width, bodyFont, DESIGN.font);
      var lines = richLines.length ? richLines.map(function (line) {
        return line.chunks.map(function (c) { return c.text; }).join("");
      }) : [""];
      return { type: "paragraph", lines: lines, richLines: richLines, font: bodyFont, lineHeight: bodyLineHeight, height: Math.max(1, richLines.length) * bodyLineHeight };
    }
    if (block.type === "math") {
      var mathAsset = mathAssets.get(getMathAssetKey(block, 15));
      if (mathAsset) {
        var mathWidth = Math.min(width, mathAsset.width);
        var mathHeight = Math.max(1, mathAsset.height * (mathWidth / Math.max(1, mathAsset.width)));
        return { type: "math", asset: mathAsset, width: mathWidth, height: mathHeight + 12, originalHeight: mathHeight };
      }
      var fallbackFont = "13px " + DESIGN.font.mono;
      var fallbackLines = wrapText(ctx, mathFallbackText(block.text), width, fallbackFont);
      return { type: "math", fallback: true, lines: fallbackLines.length ? fallbackLines : [""], font: fallbackFont, lineHeight: 20, height: Math.max(1, fallbackLines.length) * 20 + 8 };
    }
    if (block.type === "code") {
      var codeFont = "12px " + DESIGN.font.mono;
      var codeFrame = getPdfCodeFrame(width);
      var codeLines = wrapText(ctx, block.text, codeFrame.width - codeFrame.paddingX * 2, codeFont, { preserveWhitespace: true });
      var codeHeader = getPdfCodeHeaderHeight(block, 0);
      var lineCount = Math.max(1, codeLines.length);
      return {
        type: "code",
        lines: codeLines.length ? codeLines : [""],
        font: codeFont,
        lineHeight: 19,
        language: block.language || "",
        frameInset: codeFrame.inset,
        frameWidth: codeFrame.width,
        paddingX: codeFrame.paddingX,
        height: lineCount * 19 + codeHeader + 18
      };
    }
    if (block.type === "list") {
      var groups = [];
      var renderLines = [];
      var maxLineWidth = 0;
      var listStart = block.start || 1;
      (block.items || []).forEach(function (item, index) {
        var itemFont = bodyFont;
        var textIndent = 22;
        var richLines = wrapRichText(ctx, getInlineRichText(item), width - textIndent, itemFont, DESIGN.font);
        
        var fonts = getFontsForStyle(itemFont, DESIGN.font);
        richLines.forEach(function (line) {
          var w = 0;
          line.chunks.forEach(function (chunk) {
            ctx.font = chunk.bold ? fonts.bold : (chunk.italic ? fonts.italic : (chunk.code ? fonts.code : fonts.normal));
            w += ctx.measureText(chunk.text).width;
          });
          w += textIndent + 14; //基准+文字缩进
          if (w > maxLineWidth) maxLineWidth = w;
        });
        
        groups.push({
          richLines: richLines,
          xOffset: 14,
          textIndent: textIndent,
          lineHeight: 23,
          font: itemFont,
          ordered: block.ordered,
          index: listStart + index,
          isSub: false
        });
        (item.subItems || []).forEach(function (sub) {
          var subFont = "14px " + DESIGN.font.body;
          var subTextIndent = 20;
          var subRichLines = wrapRichText(ctx, getInlineRichText(sub), width - 24 - subTextIndent, subFont, DESIGN.font);
          
          var subFonts = getFontsForStyle(subFont, DESIGN.font);
          subRichLines.forEach(function (line) {
            var w = 0;
            line.chunks.forEach(function (chunk) {
              ctx.font = chunk.bold ? subFonts.bold : (chunk.italic ? subFonts.italic : (chunk.code ? subFonts.code : subFonts.normal));
              w += ctx.measureText(chunk.text).width;
            });
            w += 24 + subTextIndent + 14; //子列表基准+文字缩进+主基准
            if (w > maxLineWidth) maxLineWidth = w;
          });
          groups.push({
            richLines: subRichLines,
            xOffset: 38, // 14 + 24
            textIndent: subTextIndent,
            lineHeight: 21,
            font: subFont,
            ordered: false,
            isSub: true
          });
        });
      });
      groups.forEach(function (group, groupIndex) {
        var lines = group.richLines && group.richLines.length
          ? group.richLines
          : [{ chunks: [{ text: "" }] }];
        lines.forEach(function (richLine, lineIndex) {
          renderLines.push({
            group: group,
            groupIndex: groupIndex,
            lineIndex: lineIndex,
            richLine: richLine
          });
        });
      });
      return {
        type: "list",
        groups: groups,
        renderLines: renderLines,
        height: groups.reduce(function (sum, group) { return sum + Math.max(1, group.richLines.length) * group.lineHeight; }, 0) + 6,
        maxWidth: Math.min(width, maxLineWidth)
      };
    }
    if (block.type === "blockquote") {
      var quoteFont = "italic 14px " + DESIGN.font.body;
      var quoteText = getInlinePlainText(block);
      var quoteRichText = getInlineRichText(block);
      // 优化：从 richLines 派生 quoteLines，省去一次完整 wrapText 调用。
      var richLines = wrapRichText(ctx, quoteRichText, width - 34, quoteFont, DESIGN.font);
      var quoteLines = richLines.length ? richLines.map(function (line) {
        return line.chunks.map(function (c) { return c.text; }).join("");
      }) : [""];
      return { type: "blockquote", lines: quoteLines, richLines: richLines, font: quoteFont, lineHeight: 22, height: Math.max(1, richLines.length) * 22 + 24 };
    }
    if (block.type === "table") {
      return measurePdfTable(block, width);
    }
    if (block.type === "image") {
      var cached = imageCache && imageCache[block.src];
      if (cached) {
        var targetW = Math.min(width, cached.width);
        if (targetW > 450) targetW = 450;
        var targetH = (cached.height / cached.width) * targetW;
        return { type: "image", src: block.src, width: targetW, height: targetH + 16, originalHeight: targetH };
      }
      var placeholderW = Math.min(width, 450);
      var placeholderH = 120;
      return { type: "image", src: block.src, width: placeholderW, height: placeholderH + 16, originalHeight: placeholderH, placeholder: true, alt: block.alt || "Image" };
    }
    if (block.type === "separator") {
      return { type: "separator", height: SEPARATOR_MARGIN_TOP + SEPARATOR_MARGIN_BOTTOM };
    }
    return null;
  }

  function measurePdfImageGridRows(imageBlocks, maxWidth) {
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

    var gap = 8;
    var columns = Math.min(6, imageBlocks.length);
    var squareSize = Math.floor((maxWidth - gap * (columns - 1)) / columns);
    squareSize = Math.max(54, Math.min(112, squareSize));
    while (columns > 1 && squareSize * columns + gap * (columns - 1) > maxWidth) {
      columns -= 1;
      squareSize = Math.floor((maxWidth - gap * (columns - 1)) / columns);
      squareSize = Math.max(54, Math.min(112, squareSize));
    }

    var rows = [];
    for (var index = 0; index < imageBlocks.length; index += columns) {
      var rowBlocks = imageBlocks.slice(index, index + columns);
      rows.push({
        blocks: rowBlocks,
        width: rowBlocks.length * squareSize + gap * Math.max(0, rowBlocks.length - 1),
        height: squareSize + 16,
        square: true,
        squareSize: squareSize,
        gap: gap
      });
    }
    return rows;
  }

  function measurePdfTable(block, width) {
    var rows = [];
    if (block.headers && block.headers.length) rows.push({ cells: block.headers, header: true });
    (block.rows || []).forEach(function (row) { rows.push({ cells: row, header: false }); });
    if (!rows.length) return null;
    var columnCount = Math.max.apply(null, rows.map(function (row) { return row.cells.length; }));
    var cellWidth = width / Math.max(1, columnCount);
    var rowLayouts = rows.map(function (row) {
      var cellLines = row.cells.map(function (cell) {
        return wrapText(ctx, cleanInlineMarkdownText(cell), cellWidth - 12, (row.header ? "700 " : "") + "11px " + DESIGN.font.body);
      });
      var rowHeight = Math.max(30, Math.max.apply(null, cellLines.map(function (lines) { return lines.length; })) * 15 + 14);
      return { header: row.header, cellLines: cellLines, rowHeight: rowHeight };
    });
    var paginatedRows = [];
    rowLayouts.forEach(function (row) {
      var lineCount = Math.max.apply(null, row.cellLines.map(function (lines) { return Math.max(1, lines.length); }));
      if (lineCount <= PDF_MAX_TABLE_ROW_LINES) {
        paginatedRows.push(row);
        return;
      }
      for (var lineStart = 0; lineStart < lineCount; lineStart += PDF_MAX_TABLE_ROW_LINES) {
        var take = Math.min(PDF_MAX_TABLE_ROW_LINES, lineCount - lineStart);
        paginatedRows.push({
          header: row.header,
          cellLines: row.cellLines.map(function (lines) { return lines.slice(lineStart, lineStart + take); }),
          rowHeight: Math.max(30, take * 15 + 14)
        });
      }
    });
    return { type: "table", columnCount: columnCount, cellWidth: cellWidth, rows: paginatedRows, height: paginatedRows.reduce(function (sum, row) { return sum + row.rowHeight; }, 0) + 12 };
  }

  function drawSegmentCard(ctx, x, y, width, height, radius, fill, stroke, shadowColor, hasTopRound, hasBottomRound) {
    ctx.save();
    if (shadowColor && shadowColor !== "transparent") {
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = 24;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 10;
    }
    
    var rTop = hasTopRound ? radius : 0;
    var rBot = hasBottomRound ? radius : 0;
    
    ctx.beginPath();
    ctx.moveTo(x + rTop, y);
    ctx.lineTo(x + width - rTop, y);
    if (hasTopRound) {
      ctx.quadraticCurveTo(x + width, y, x + width, y + rTop);
    } else {
      ctx.lineTo(x + width, y);
    }
    ctx.lineTo(x + width, y + height - rBot);
    if (hasBottomRound) {
      ctx.quadraticCurveTo(x + width, y + height, x + width - rBot, y + height);
    } else {
      ctx.lineTo(x + width, y + height);
    }
    ctx.lineTo(x + rBot, y + height);
    if (hasBottomRound) {
      ctx.quadraticCurveTo(x, y + height, x, y + height - rBot);
    } else {
      ctx.lineTo(x, y + height);
    }
    ctx.lineTo(x, y + rTop);
    if (hasTopRound) {
      ctx.quadraticCurveTo(x, y, x + rTop, y);
    } else {
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      
      if (hasBottomRound) {
        ctx.moveTo(x + rBot, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - rBot);
      } else {
        ctx.moveTo(x, y + height);
      }
      
      ctx.lineTo(x, y + rTop);
      
      if (hasTopRound) {
        ctx.quadraticCurveTo(x, y, x + rTop, y);
        ctx.lineTo(x + width - rTop, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + rTop);
      } else {
        ctx.moveTo(x + width, y);
      }
      
      ctx.lineTo(x + width, y + height - rBot);
      
      if (hasBottomRound) {
        ctx.quadraticCurveTo(x + width, y + height, x + width - rBot, y + height);
        ctx.lineTo(x + rBot, y + height);
      }
      
      ctx.stroke();
    }
    ctx.restore();
  }

  function roundedPdfImagePath(x, y, width, height, radius) {
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

  function drawPdfSquareThumbnail(block, x, y, size) {
    var cached = block && block.src && imageCache && imageCache[block.src];
    if (!cached) {
      var fallbackBlock = Object.assign({}, block, {
        width: size,
        height: size + 16,
        originalHeight: size
      });
      drawFallbackPlaceholder(x, y - 8, size, fallbackBlock);
      return;
    }

    try {
      ctx.save();
      try {
        roundedPdfImagePath(x, y, size, size, 10);
        ctx.clip();
        var srcW = cached.width;
        var srcH = cached.height;
        var side = Math.min(srcW, srcH);
        var sx = Math.max(0, (srcW - side) / 2);
        var sy = Math.max(0, (srcH - side) / 2);
        ctx.drawImage(cached.element, sx, sy, side, side, x, y, size, size);
      } finally {
        ctx.restore();
      }
      ctx.save();
      try {
        roundedPdfImagePath(x, y, size, size, 10);
        ctx.strokeStyle = "rgba(15, 23, 42, 0.10)";
        ctx.lineWidth = 1;
        ctx.stroke();
      } finally {
        ctx.restore();
      }
    } catch (error) {
      var failedBlock = Object.assign({}, block, {
        width: size,
        height: size + 16,
        originalHeight: size
      });
      drawFallbackPlaceholder(x, y - 8, size, failedBlock);
    }
  }

  function renderPdfImageGridRow(row, x, cursor) {
    if (!row || !row.blocks || !row.blocks.length) return cursor;
    if (!row.square) {
      var block = row.blocks[0];
      return renderPdfBlockLayout(block, x, cursor, block.width, false);
    }

    var imageY = cursor + 8;
    row.blocks.forEach(function (block, index) {
      var imageX = x + index * (row.squareSize + row.gap);
      drawPdfSquareThumbnail(block, imageX, imageY, row.squareSize);
    });
    return cursor + row.height;
  }

  function fitPdfImageRowToHeight(row, maxHeight) {
    if (!row || row.square || !row.blocks || row.blocks.length !== 1) return row;
    if (!Number.isFinite(maxHeight) || maxHeight < MIN_FITTED_IMAGE_ROW_HEIGHT) return row;
    if (row.height <= maxHeight) return row;

    var block = row.blocks[0];
    var originalHeight = Number(block.originalHeight || 0);
    var width = Number(block.width || 0);
    if (!originalHeight || !width) return row;

    var maxOriginalHeight = Math.max(1, maxHeight - 16);
    var scaleFactor = Math.min(1, maxOriginalHeight / originalHeight);
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor >= 1) return row;

    var fittedBlock = Object.assign({}, block, {
      width: Math.max(1, width * scaleFactor),
      originalHeight: Math.max(1, originalHeight * scaleFactor)
    });
    fittedBlock.height = fittedBlock.originalHeight + 16;

    return Object.assign({}, row, {
      blocks: [fittedBlock],
      width: fittedBlock.width,
      height: fittedBlock.height
    });
  }

  async function renderPdfMessageCard(layout) {
    var message = layout.message;
    var isUser = message.role === "user";
    var cardWidth = layout.cardWidth || contentWidth;
    var cardX = layout.alignRight ? (margin + contentWidth - cardWidth) : margin;
    
    var fill = isUser ? DESIGN.color.cardBgUser : DESIGN.color.cardBgAssistant;
    var stroke = isUser ? DESIGN.color.cardBorderUser : DESIGN.color.cardBorderAssistant;
    var shadow = theme.color.shadow || "transparent";
    var bubblePaddingY = flatLayout ? 6 : 13;
    var bubblePaddingX = flatLayout ? 4 : 22;
    
    if (!layout.labelInBubble && layout.roleHeight) {
      var firstPartHeight = layout.roleHeight + 6;
      var firstSection = (layout.flowSections || [])[0];
      if (firstSection && firstSection.type === "images" && firstSection.rows.length > 0) {
        var firstRow = fitPdfImageRowToHeight(firstSection.rows[0], remainingPageHeight() - layout.roleHeight - 16);
        firstPartHeight += firstRow.height + 10;
      } else if (firstSection && firstSection.type === "bubble" && firstSection.blocks.length > 0) {
        var firstBubbleBlockHeight = firstSection.blocks[0].height || 30;
        firstPartHeight += bubblePaddingY + Math.min(60, firstBubbleBlockHeight) + bubblePaddingY;
      } else {
        firstPartHeight += 20;
      }
      ensure(firstPartHeight);
      await drainPageJobsIfNeeded();
      renderPdfRoleLabel(message, cardX, y, false, layout.alignRight, cardWidth);
      y += layout.roleHeight + 6;
    }

    async function renderPdfImageSection(section) {
      for (var index = 0; index < section.rows.length; index++) {
        var row = section.rows[index];
        if (index) y += 8;
        var fittedRow = fitPdfImageRowToHeight(row, remainingPageHeight() - 10);
        if (fittedRow.height + 10 > remainingPageHeight() && y > topMargin + 8) {
          newPage();
          await drainPageJobsIfNeeded();
          fittedRow = fitPdfImageRowToHeight(row, remainingPageHeight() - 10);
        }
        ensure(fittedRow.height + 10);
        await drainPageJobsIfNeeded();
        var imgX;
        if (layout.alignRight) {
          imgX = margin + contentWidth - fittedRow.width;
        } else {
          if (settings.align_user_messages_right) {
            imgX = margin;
          } else {
            imgX = margin + Math.max(0, (contentWidth - fittedRow.width) / 2);
          }
        }
        y = renderPdfImageGridRow(fittedRow, imgX, y) + 4;
      }
    }

    async function renderPdfBubbleSection(section) {
      var segments = [];
      (section.blocks || []).forEach(function (block, blockIndex) {
        if (block.type === "heading" || block.type === "paragraph") {
          var fontSize = block.type === "heading" ? (block.font.includes("21px") ? 21 : block.font.includes("18px") ? 18 : 16) : 15;
          block.lines.forEach(function (line, lineIndex) {
            segments.push({
              type: "line",
              text: line,
              richLine: block.richLines && block.richLines[lineIndex] ? block.richLines[lineIndex] : null,
              blockType: block.type,
              font: block.font,
              lineHeight: block.lineHeight,
              fontSize: fontSize,
              headingGroupId: block.type === "heading" ? blockIndex : null,
              headingLineIndex: block.type === "heading" ? lineIndex : null
            });
          });
          segments.push({ type: "spacing", height: 5 });
        } else if (block.type === "code") {
          segments.push({
            type: "codeBlock",
            block: block,
            lineIndex: 0
          });
          segments.push({ type: "spacing", height: 5 });
        } else if (/^(list|blockquote|table)$/.test(block.type) && getPdfChunkUnitCount(block) > 0) {
          segments.push({
            type: "chunkedBlock",
            block: block,
            unitIndex: 0
          });
          segments.push({ type: "spacing", height: 5 });
        } else {
          segments.push({
            type: "block",
            block: block
          });
          segments.push({ type: "spacing", height: 5 });
        }
      });
      if (segments.length > 0 && segments[segments.length - 1].type === "spacing") {
        segments.pop();
      }
      
      var currentIdx = 0;
      var isFirstSegment = true;

      function getSegmentHeight(seg) {
        if (!seg) return 0;
        if (seg.type === "roleLabel") return seg.height;
        if (seg.type === "line") return seg.lineHeight;
        if (seg.type === "spacing") return seg.height;
        if (seg.type === "block") return seg.block.height;
        return 0;
      }

      function getSegmentMinimumHeight(seg) {
        if (!seg) return 0;
        if (seg.type === "codeBlock") {
          var lineIndex = Number(seg.lineIndex) || 0;
          return getPdfCodeHeaderHeight(seg.block, lineIndex) + 18 + seg.block.lineHeight;
        }
        if (seg.type === "chunkedBlock") {
          return getPdfChunkMinimumHeight(seg.block, seg.unitIndex);
        }
        return getSegmentHeight(seg);
      }

      function getHeadingKeepHeight(segmentIndex) {
        var heading = segments[segmentIndex];
        if (!heading || heading.type !== "line" || heading.blockType !== "heading" || heading.headingLineIndex !== 0) {
          return 0;
        }
        var required = 0;
        var index = segmentIndex;
        while (index < segments.length) {
          var candidate = segments[index];
          if (candidate.type !== "line" || candidate.headingGroupId !== heading.headingGroupId) break;
          required += candidate.lineHeight;
          index += 1;
        }
        while (index < segments.length && segments[index].type === "spacing") {
          required += segments[index].height;
          index += 1;
        }
        if (index < segments.length) {
          required += getSegmentMinimumHeight(segments[index]);
          if (index === segments.length - 1) required += bubblePaddingY;
        } else {
          required += bubblePaddingY;
        }
        return required;
      }
      
      while (currentIdx < segments.length) {
        if (y + 30 > pageHeight - bottomMargin) {
          newPage();
          await drainPageJobsIfNeeded();
        }
        
        var isTop = isFirstSegment;
        var cardStartY = y;
        var startedAtFreshTop = cardStartY <= topMargin + 1;
        if (isTop) {
          y += bubblePaddingY;
        } else {
          cardStartY = topMargin;
          y = topMargin;
          startedAtFreshTop = true;
        }
        
        var tempY = y;
        var pageEntries = [];
        var nextIdx = currentIdx;
        var needsFreshPage = false;
        
        while (nextIdx < segments.length) {
          var seg = segments[nextIdx];
          var isLastSegment = nextIdx === segments.length - 1;

          if (seg.type === "codeBlock") {
            var codeLines = seg.block.lines && seg.block.lines.length ? seg.block.lines : [""];
            var lineIndex = Math.max(0, Math.min(codeLines.length, Number(seg.lineIndex) || 0));
            if (lineIndex >= codeLines.length) {
              nextIdx += 1;
              continue;
            }

            var availableHeight = pageHeight - bottomMargin - tempY;
            var planned = planPdfCodeChunk(seg.block, lineIndex, availableHeight);
            if (planned && isLastSegment && lineIndex + planned.take >= codeLines.length && tempY + planned.block.height + bubblePaddingY > pageHeight - bottomMargin) {
              planned = planPdfCodeChunk(seg.block, lineIndex, availableHeight - bubblePaddingY);
              if (planned && lineIndex + planned.take < codeLines.length) {
                planned.block = createPdfCodeChunk(seg.block, lineIndex, planned.take, availableHeight);
              }
            }
            if (!planned) {
              if (pageEntries.length > 0) {
                break;
              }
              if (!startedAtFreshTop) {
                needsFreshPage = true;
                break;
              }
              planned = {
                take: 1,
                block: createPdfCodeChunk(seg.block, lineIndex, 1)
              };
            }

            var nextLineIndex = lineIndex + planned.take;
            pageEntries.push({
              type: "block",
              block: planned.block,
              sourceCodeSegment: seg,
              nextLineIndex: nextLineIndex
            });
            tempY += planned.block.height;

            if (nextLineIndex >= codeLines.length) {
              nextIdx += 1;
              continue;
            }
            break;
          }

          if (seg.type === "chunkedBlock") {
            var totalUnits = getPdfChunkUnitCount(seg.block);
            var unitIndex = Math.max(0, Math.min(totalUnits, Number(seg.unitIndex) || 0));
            if (unitIndex >= totalUnits) {
              nextIdx += 1;
              continue;
            }

            var availableBlockHeight = pageHeight - bottomMargin - tempY;
            var blockPlan = planPdfChunkedBlock(seg.block, unitIndex, availableBlockHeight);
            if (blockPlan && isLastSegment && unitIndex + blockPlan.take >= totalUnits && tempY + blockPlan.block.height + bubblePaddingY > pageHeight - bottomMargin) {
              blockPlan = planPdfChunkedBlock(seg.block, unitIndex, availableBlockHeight - bubblePaddingY);
            }
            if (!blockPlan) {
              if (pageEntries.length > 0) {
                break;
              }
              if (!startedAtFreshTop) {
                needsFreshPage = true;
                break;
              }
              throw new Error(t("export_pdf_encode_failed", "PDF page rendering failed. Please try again."));
            }

            var nextUnitIndex = unitIndex + blockPlan.take;
            pageEntries.push({
              type: "block",
              block: blockPlan.block,
              sourceChunkedSegment: seg,
              nextUnitIndex: nextUnitIndex
            });
            tempY += blockPlan.block.height;

            if (nextUnitIndex >= totalUnits) {
              nextIdx += 1;
              continue;
            }
            break;
          }

          var segmentHeight = getSegmentHeight(seg);
          var needed = segmentHeight + (isLastSegment ? bubblePaddingY : 0);
          var headingKeepHeight = getHeadingKeepHeight(nextIdx);
          if (headingKeepHeight > needed) needed = headingKeepHeight;
          if (seg.type === "roleLabel" && !isLastSegment) {
            var nextMin = getSegmentMinimumHeight(segments[nextIdx + 1]);
            var isNextLast = nextIdx + 1 === segments.length - 1;
            needed += nextMin + (isNextLast ? bubblePaddingY : 0);
          }

          if (tempY + needed > pageHeight - bottomMargin) {
            if (pageEntries.length > 0) {
              break;
            }
            if (!startedAtFreshTop) {
              needsFreshPage = true;
              break;
            }
          }

          pageEntries.push(seg);
          tempY += segmentHeight;
          nextIdx += 1;
        }

        if (needsFreshPage && pageEntries.length === 0) {
          newPage();
          await drainPageJobsIfNeeded();
          continue;
        }

        if (pageEntries.length === 0) {
          newPage();
          await drainPageJobsIfNeeded();
          continue;
        }
        
        var isBottom = nextIdx >= segments.length;
        if (isBottom) {
          tempY += bubblePaddingY;
        }
        
        var cardHeight = isBottom ? (tempY - cardStartY) : ((pageHeight - bottomMargin) - cardStartY);
        
        if (!flatLayout) {
          drawSegmentCard(ctx, cardX, cardStartY, cardWidth, cardHeight, 17, fill, stroke, shadow, isTop, isBottom);
        }
        
        if (!flatLayout && theme.id !== "editorial" && !layout.alignRight) {
          ctx.fillStyle = isUser ? DESIGN.color.accent : DESIGN.color.muted;
          var barY = cardStartY + (isTop ? 13 : 0);
          var barH = cardHeight - (isTop ? 13 : 0) - (isBottom ? 13 : 0);
          if (barH > 0) {
            ctx.fillRect(cardX, barY, 4, barH);
          }
        }
        
        for (var i = 0; i < pageEntries.length; i++) {
          var seg = pageEntries[i];
          if (seg.type === "roleLabel") {
            renderPdfRoleLabel(seg.message, cardX + bubblePaddingX, y, true, seg.alignRight, cardWidth - bubblePaddingX * 2);
            y += seg.height;
          } else if (seg.type === "line") {
            y = renderPdfBlockLayout({
              type: seg.blockType || "paragraph",
              lines: [seg.text],
              richLines: seg.richLine ? [seg.richLine] : null,
              font: seg.font,
              lineHeight: seg.lineHeight,
              height: seg.lineHeight
            }, cardX + bubblePaddingX, y, cardWidth - bubblePaddingX * 2, false);
          } else if (seg.type === "spacing") {
            y += seg.height;
          } else if (seg.type === "block") {
            y = renderPdfBlockLayout(seg.block, cardX + bubblePaddingX, y, cardWidth - bubblePaddingX * 2, false);
            if (seg.sourceCodeSegment) {
              seg.sourceCodeSegment.lineIndex = seg.nextLineIndex;
            }
            if (seg.sourceChunkedSegment) {
              seg.sourceChunkedSegment.unitIndex = seg.nextUnitIndex;
            }
          }
        }
        
        if (isBottom) {
          y += bubblePaddingY;
        } else {
          y = pageHeight - bottomMargin;
          newPage();
          await drainPageJobsIfNeeded();
        }
        
        currentIdx = nextIdx;
        isFirstSegment = false;
      }
    }

    var flowSections = layout.flowSections || [];
    for (var sectionIndex = 0; sectionIndex < flowSections.length; sectionIndex++) {
      var section = flowSections[sectionIndex];
      if (sectionIndex) y += 12;
      if (section.type === "images") {
        await renderPdfImageSection(section);
      } else if (section.type === "bubble") {
        await renderPdfBubbleSection(section);
      }
    }

    y += flatLayout ? 20 : 32;
  }

  function renderPdfRoleLabel(message, x, top, inCard, alignRight, width) {
    if (!settings.show_role_labels || metadata.scope === "ai_only") return;
    var isUser = message.role === "user";
    var label = isUser ? t("export_role_user", "You Asked") : getPlatformLabel(metadata.platform).toUpperCase();
    ctx.font = "800 10px " + DESIGN.font.body;
    if (flatLayout) {
      var labelWidth = ctx.measureText(label).width;
      var labelX = alignRight ? x + width - labelWidth : x;
      ctx.fillStyle = isUser ? (DESIGN.color.tagTextUser || DESIGN.color.accentDark) : (DESIGN.color.tagTextAssistant || DESIGN.color.muted);
      ctx.fillText(label, labelX, getCenteredTextBaseline(ctx, top, 18));
      ctx.fillStyle = DESIGN.color.line;
      if (alignRight) ctx.fillRect(x, top + 9, Math.max(20, labelX - x - 12), 1);
      else ctx.fillRect(x + labelWidth + 12, top + 9, Math.max(20, width - labelWidth - 12), 1);
      return;
    }
    var tagWidth = ctx.measureText(label).width + 24;
    var tagFill = isUser ? DESIGN.color.tagBgUser : DESIGN.color.tagBgAssistant;
    var tagStroke = isUser ? DESIGN.color.tagBorderUser : DESIGN.color.tagBorderAssistant;
    
    var tagX = x;
    if (alignRight) {
      tagX = x + width - tagWidth;
    }
    
    drawRoundRect(ctx, tagX, top, tagWidth, 22, 7, tagFill, tagStroke);
    var tagText = isUser
      ? (DESIGN.color.tagTextUser || DESIGN.color.accentDark)
      : (DESIGN.color.tagTextAssistant || DESIGN.color.muted);
    ctx.fillStyle = tagText;
    var prevAlign = ctx.textAlign;
    var prevBaseline = ctx.textBaseline;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, tagX + tagWidth / 2, top + 11);
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBaseline;
    if (!inCard) {
      ctx.fillStyle = DESIGN.color.line;
      if (alignRight) {
        var leftEdge = margin;
        ctx.fillRect(leftEdge, top + 11, Math.max(28, tagX - 12 - leftEdge), 1);
      } else {
        ctx.fillRect(x + tagWidth + 12, top + 11, Math.max(28, contentWidth - tagWidth - 12), 1);
      }
    }
  }

  function drawFallbackPlaceholder(x, cursor, width, block) {
    var w = block.width || Math.min(width, 450);
    var h = block.originalHeight || 120;
    var px = x + Math.max(0, (width - w) / 2);
    var py = cursor + 8;
    // 透明色（如 natural 主题）下占位框不可见，回退到浅色以保证视觉反馈
    var placeholderBg = isTransparentPdfColor(DESIGN.color.cardBgAssistant) ? "#F1F5F9" : DESIGN.color.cardBgAssistant;
    var placeholderBorder = isTransparentPdfColor(DESIGN.color.cardBorderAssistant) ? "#E2E8F0" : DESIGN.color.cardBorderAssistant;
    drawRoundRect(ctx, px, py, w, h, 8, placeholderBg, placeholderBorder);
    ctx.font = "italic 13px " + DESIGN.font.body;
    ctx.fillStyle = DESIGN.color.muted;
    var loadFailedText = t("export_pdf_image_load_failed", "Image - Load Failed");
    var label = "📷 [" + sanitizeImageAlt(block.alt || loadFailedText) + "]";
    var textW = ctx.measureText(label).width;
    var textX = px + Math.max(0, (w - textW) / 2);
    var textY = getCenteredTextBaseline(ctx, py, h);
    ctx.fillText(label, textX, textY);
  }

  function renderPdfBlockLayout(block, x, cursor, width, alignRight) {
    function getTextTopForBaseline(textY, fontSize, metrics) {
      var ascent = metrics && Number.isFinite(metrics.actualBoundingBoxAscent)
        ? metrics.actualBoundingBoxAscent
        : fontSize * 0.78;
      var descent = metrics && Number.isFinite(metrics.actualBoundingBoxDescent)
        ? metrics.actualBoundingBoxDescent
        : fontSize * 0.22;
      var baseline = ctx.textBaseline || "alphabetic";

      if (baseline === "top" || baseline === "hanging") {
        return textY;
      }
      if (baseline === "middle") {
        return textY - (ascent + descent) / 2;
      }
      if (baseline === "bottom" || baseline === "ideographic") {
        return textY - ascent - descent;
      }
      return textY - ascent;
    }

    function drawRichChunk(chunk, currentX, textY, fontSize, fonts, defaultColor) {
      ctx.font = chunk.bold ? fonts.bold : (chunk.italic ? fonts.italic : (chunk.code ? fonts.code : fonts.normal));
      var metrics = ctx.measureText(chunk.text);
      var chunkW = metrics.width;
      
      if (chunk.code) {
        ctx.save();
        var pageBgColor = (theme.bg && theme.bg.colors && theme.bg.colors[0]) || "#ffffff";
        var bgLum = (parseInt(pageBgColor.slice(1, 3), 16) * 0.299 + parseInt(pageBgColor.slice(3, 5), 16) * 0.587 + parseInt(pageBgColor.slice(5, 7), 16) * 0.114);
        var isDark = bgLum < 128;
        ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(100, 116, 139, 0.09)";
        var bgPaddingY = Math.max(2, Math.round(fontSize * 0.14));
        var textTop = getTextTopForBaseline(textY, fontSize, metrics);
        var textHeight = metrics && Number.isFinite(metrics.actualBoundingBoxAscent) && Number.isFinite(metrics.actualBoundingBoxDescent)
          ? metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent
          : fontSize;
        var bgH = Math.max(fontSize + 4, textHeight + bgPaddingY * 2);
        var bgY = textTop - bgPaddingY;
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
        
        ctx.fillStyle = DESIGN.color.accentDark;
      } else {
        ctx.fillStyle = chunk.href ? DESIGN.color.accentDark : (defaultColor || DESIGN.color.ink);
      }
      
      ctx.fillText(chunk.text, currentX, textY);
      var href = normalizeExportLinkHref(chunk.href);
      if (href && !chunk.code && chunkW > 0) {
        var textTop = getTextTopForBaseline(textY, fontSize, metrics);
        var textHeight = metrics && Number.isFinite(metrics.actualBoundingBoxAscent) && Number.isFinite(metrics.actualBoundingBoxDescent)
          ? metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent
          : fontSize;
        currentPageLinks.push({ x: currentX, y: textTop, width: chunkW, height: Math.max(fontSize, textHeight), href: href });
        ctx.save();
        ctx.strokeStyle = DESIGN.color.accentDark;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(currentX, textTop + textHeight + 1);
        ctx.lineTo(currentX + chunkW, textTop + textHeight + 1);
        ctx.stroke();
        ctx.restore();
      }
      return chunkW;
    }

    if (block.type === "image") {
      if (block.src && imageCache && imageCache[block.src]) {
        var cached = imageCache[block.src];
        try {
          var imageX = x + Math.max(0, (width - block.width) / 2);
          ctx.drawImage(cached.element, imageX, cursor + 8, block.width, block.originalHeight);
        } catch (ex) {
          drawFallbackPlaceholder(x, cursor, width, block);
        }
        return cursor + block.height;
      } else {
        drawFallbackPlaceholder(x, cursor, width, block);
        return cursor + block.height;
      }
    }

    if (block.type === "math") {
      if (block.asset && block.asset.element) {
        try {
          var mathX = block.inline ? x : x + Math.max(0, (width - block.width) / 2);
          ctx.drawImage(block.asset.element, mathX, cursor + 3, block.width, block.originalHeight);
          return cursor + block.height;
        } catch (error) {}
      }
      ctx.font = block.font || ("13px " + DESIGN.font.mono);
      ctx.fillStyle = DESIGN.color.ink;
      block.lines.forEach(function (line, index) { ctx.fillText(line, x, cursor + 2 + index * block.lineHeight); });
      return cursor + block.height;
    }

    if (block.type === "heading" || block.type === "paragraph") {
      var oldBaseline = ctx.textBaseline;
      ctx.textBaseline = "top";
      var fontSize = block.type === "heading" ? (block.font.includes("21px") ? 21 : block.font.includes("18px") ? 18 : 16) : 15;
      var yOffset = (block.lineHeight - fontSize) / 2;
      var fonts = getFontsForStyle(block.font, DESIGN.font);

      if (block.richLines) {
        block.richLines.forEach(function (line, lineIndex) {
          if (isPlainPdfRichLine(line)) {
            ctx.font = block.font;
            ctx.fillStyle = DESIGN.color.ink;
            var plainLine = block.lines && block.lines[lineIndex] !== undefined
              ? block.lines[lineIndex]
              : line.chunks.map(function (chunk) { return chunk && chunk.text || ""; }).join("");
            ctx.fillText(plainLine, x, cursor + yOffset);
          } else {
            var currentX = x;
            line.chunks.forEach(function (chunk) {
              currentX += drawRichChunk(chunk, currentX, cursor + yOffset, fontSize, fonts, DESIGN.color.ink);
            });
          }
          cursor += block.lineHeight;
        });
      } else {
        ctx.font = block.font;
        ctx.fillStyle = DESIGN.color.ink;
        block.lines.forEach(function (line) {
          ctx.fillText(line, x, cursor + yOffset);
          cursor += block.lineHeight;
        });
      }
      ctx.textBaseline = oldBaseline;
      return cursor;
    }

    if (block.type === "code") {
      var frame = getPdfCodeFrame(width);
      var frameX = x + (block.frameInset ?? frame.inset);
      var frameWidth = block.frameWidth || frame.width;
      var paddingX = block.paddingX || frame.paddingX;
      var hasTopRound = block.hasTopRound !== false;
      var hasBottomRound = block.hasBottomRound !== false;
      var frameHeight = Math.max(28, block.height - (hasBottomRound ? 6 : 0));
      drawSegmentCard(ctx, frameX, cursor, frameWidth, frameHeight, 10, DESIGN.color.codeBg, DESIGN.color.line, "transparent", hasTopRound, hasBottomRound);
      
      var isTerminalTheme = theme.id === "aurora" || theme.id === "terminal";
      var drawCodeHeader = block.drawCodeHeader !== undefined ? block.drawCodeHeader : Boolean(block.language || isTerminalTheme);
      if (isTerminalTheme && drawCodeHeader) {
        drawMacTerminalHeader(ctx, frameX, cursor, frameWidth, 26, block.language || "code");
        var codeY = cursor + 42;
        ctx.font = block.font;
        ctx.fillStyle = DESIGN.color.codeText;
        block.lines.forEach(function (line) {
          (ctx.fillTextPreservingWhitespace || ctx.fillText).call(ctx, line, frameX + paddingX, codeY);
          codeY += block.lineHeight;
        });
      } else {
        var codeY = cursor + (drawCodeHeader && block.language ? 23 : 27);
        if (drawCodeHeader && block.language) {
          ctx.font = "800 9px " + DESIGN.font.body;
          ctx.fillStyle = DESIGN.color.muted;
          ctx.fillText(block.language.toUpperCase(), frameX + paddingX, codeY);
          codeY += 20;
        }
        ctx.font = block.font;
        ctx.fillStyle = DESIGN.color.codeText;
        block.lines.forEach(function (line) {
          (ctx.fillTextPreservingWhitespace || ctx.fillText).call(ctx, line, frameX + paddingX, codeY);
          codeY += block.lineHeight;
        });
      }
      return cursor + block.height;
    }

    if (block.type === "list") {
      block.groups.forEach(function (group) {
        var fonts = getFontsForStyle(group.font, DESIGN.font);
        var bulletX = x + group.xOffset;
        var fontSize = group.font.includes("14px") ? 14 : 15;
        if (group.richLines) {
          group.richLines.forEach(function (line, lineIndex) {
            var currentX = x + group.xOffset + (group.textIndent || 0);
            
            if (lineIndex === 0 && group.showMarker !== false) {
              ctx.save();
              ctx.fillStyle = DESIGN.color.ink;
              ctx.font = group.font;
              if (group.ordered) {
                var numStr = group.index + ".";
                ctx.fillText(numStr, bulletX, cursor + group.lineHeight);
              } else {
                var centerY = cursor + group.lineHeight - 6;
                ctx.beginPath();
                if (group.isSub) {
                  ctx.strokeStyle = DESIGN.color.ink;
                  ctx.lineWidth = 1.2;
                  ctx.arc(bulletX + 4, centerY, 2.5, 0, Math.PI * 2);
                  ctx.stroke();
                } else {
                  ctx.fillStyle = DESIGN.color.ink;
                  ctx.arc(bulletX + 4, centerY, 2.5, 0, Math.PI * 2);
                  ctx.fill();
                }
              }
              ctx.restore();
            }

            line.chunks.forEach(function (chunk) {
              currentX += drawRichChunk(chunk, currentX, cursor + group.lineHeight, fontSize, fonts, DESIGN.color.ink);
            });
            cursor += group.lineHeight;
          });
        } else {
          ctx.font = group.font;
          ctx.fillStyle = DESIGN.color.ink;
          group.lines.forEach(function (line) {
            ctx.fillText(line, x + group.xOffset, cursor + group.lineHeight);
            cursor += group.lineHeight;
          });
        }
      });
      return cursor + 6;
    }

    if (block.type === "blockquote") {
      drawRoundRect(ctx, x, cursor, width, block.height - 4, 9, DESIGN.color.quoteBg, DESIGN.color.cardBorderAssistant);
      ctx.fillStyle = DESIGN.color.quoteBorder;
      ctx.fillRect(x, cursor, 4, block.height - 4);
      var fonts = getFontsForStyle(block.font, DESIGN.font);
      var quoteY = cursor + 28;
      if (block.richLines) {
        block.richLines.forEach(function (line) {
          var currentX = x + 18;
          line.chunks.forEach(function (chunk) {
            currentX += drawRichChunk(chunk, currentX, quoteY, 14, fonts, DESIGN.color.ink);
          });
          quoteY += block.lineHeight;
        });
      } else {
        ctx.font = block.font;
        ctx.fillStyle = DESIGN.color.accentDark;
        block.lines.forEach(function (line) {
          ctx.fillText(line, x + 18, quoteY);
          quoteY += block.lineHeight;
        });
      }
      return cursor + block.height;
    }

    if (block.type === "table") {
      return renderPdfTableLayout(block, x, cursor);
    }

    if (block.type === "separator") {
      ctx.strokeStyle = DESIGN.color.line;
      ctx.beginPath();
      ctx.moveTo(x, cursor + SEPARATOR_MARGIN_TOP);
      ctx.lineTo(x + width, cursor + SEPARATOR_MARGIN_TOP);
      ctx.stroke();
      return cursor + block.height;
    }

    return cursor;
  }

  function renderFlowPdfBlock(block, x, width, alignRight) {
    if (block.type === "code") {
      renderFlowPdfCodeBlock(block, x, width, alignRight);
      return;
    }

    var remaining = remainingPageHeight();
    if (block.height <= pageHeight - topMargin - bottomMargin - 24 && (block.height + 8 <= remaining || remaining < 96)) {
      ensure(block.height + 8);
      y = renderPdfBlockLayout(block, x, y, width, alignRight) + 4;
      return;
    }

    if (block.type === "paragraph" || block.type === "heading" || block.type === "image") {
      if (block.type === "image") {
        ensure(block.height + 8);
        y = renderPdfBlockLayout(block, x, y, width, alignRight) + 4;
        return;
      }
      ctx.font = block.font;
      ctx.fillStyle = DESIGN.color.ink;
      block.lines.forEach(function (line) {
        ensure(block.lineHeight + 4);
        ctx.font = block.font;
        ctx.fillStyle = DESIGN.color.ink;
        ctx.fillText(line, x, y + block.lineHeight);
        y += block.lineHeight;
      });
      y += 8;
      return;
    }

    ensure(block.height + 8);
    y = renderPdfBlockLayout(block, x, y, width, alignRight) + 4;
  }

  function renderFlowPdfCodeBlock(block, x, width, alignRight) {
    var frame = getPdfCodeFrame(width);
    var frameX = x;
    var frameWidth = width;
    var paddingX = block.paddingX || frame.paddingX;
    var lineIndex = 0;
    var drawLanguage = Boolean(block.language);
    var lines = block.lines && block.lines.length ? block.lines : [""];

    var totalBlockHeight = lines.length * block.lineHeight + getPdfCodeHeaderHeight(block, 0) + 24;
    if (y > topMargin + 8 && totalBlockHeight < remainingPageHeight() * 1.3 && totalBlockHeight > remainingPageHeight()) {
      newPage();
    }

    while (lineIndex < lines.length || drawLanguage) {
      ensure(72);
      var available = remainingPageHeight();
      if (available < 72) {
        newPage();
        available = remainingPageHeight();
      }

      var isTerminalTheme = theme.id === "aurora" || theme.id === "terminal";
      var isFirstCodeSegment = lineIndex === 0;
      var drawHeader = drawLanguage || (isTerminalTheme && isFirstCodeSegment);
      var headerHeight = drawHeader ? 26 : 12;
      var maxLines = Math.max(1, Math.floor(Math.max(block.lineHeight, available - headerHeight - 18) / block.lineHeight));
      var take = Math.min(lines.length - lineIndex, maxLines);
      if (take < 0) take = 0;

      var segmentHeight = Math.max(48, take * block.lineHeight + headerHeight + 18);
      if (segmentHeight + 8 > remainingPageHeight() && y > topMargin + 8) {
        newPage();
        continue;
      }

      var top = y;
      var hasTopRound = lineIndex === 0;
      var hasBottomRound = lineIndex + take >= lines.length;
      var frameHeight = Math.max(28, segmentHeight - (hasBottomRound ? 6 : 0));
      drawSegmentCard(ctx, frameX, top, frameWidth, frameHeight, 10, DESIGN.color.codeBg, DESIGN.color.cardBorderAssistant, "transparent", hasTopRound, hasBottomRound);
      var codeY;
      if (isTerminalTheme && drawHeader) {
        if (drawLanguage) {
          drawMacTerminalHeader(ctx, frameX, top, frameWidth, 26, block.language || "code");
          drawLanguage = false;
        } else {
          drawMacTerminalHeader(ctx, frameX, top, frameWidth, 26, "code");
        }
        codeY = top + 42;
      } else {
        codeY = top + (drawHeader && drawLanguage ? 23 : 27);
        if (drawHeader && drawLanguage) {
          ctx.font = "800 9px " + DESIGN.font.body;
          ctx.fillStyle = DESIGN.color.muted;
          ctx.fillText(block.language.toUpperCase(), frameX + paddingX, codeY);
          codeY += 20;
          drawLanguage = false;
        }
      }

      ctx.font = block.font;
      ctx.fillStyle = DESIGN.color.codeText;
      lines.slice(lineIndex, lineIndex + take).forEach(function (line) {
        (ctx.fillTextPreservingWhitespace || ctx.fillText).call(ctx, line, frameX + paddingX, codeY);
        codeY += block.lineHeight;
      });

      lineIndex += take;
      // Guard: if take is 0 (e.g. from bad block data), force advance to prevent infinite loop
      if (take <= 0) lineIndex = Math.max(lineIndex + 1, lines.length);
      y = top + segmentHeight + 4;
    }
  }

  function renderPdfTableLayout(block, x, cursor) {
    block.rows.forEach(function (row) {
      var cellX = x;
      row.cellLines.forEach(function (lines) {
        ctx.fillStyle = row.header ? DESIGN.color.cardBgUser : DESIGN.color.cardBgAssistant;
        ctx.fillRect(cellX, cursor, block.cellWidth, row.rowHeight);
        ctx.strokeStyle = DESIGN.color.line;
        ctx.strokeRect(cellX, cursor, block.cellWidth, row.rowHeight);
        ctx.font = (row.header ? "700 " : "") + "11px " + DESIGN.font.body;
        ctx.fillStyle = row.header ? DESIGN.color.accentDark : DESIGN.color.ink;
        lines.forEach(function (line, lineIndex) {
          ctx.fillText(line, cellX + 6, cursor + 16 + lineIndex * 15);
        });
        cellX += block.cellWidth;
      });
      cursor += row.rowHeight;
    });
    return cursor + 12;
  }
}

export function dataUrlToBytes(dataUrl) {
  var base64 = dataUrl.split(",")[1] || "";
  var binary = atob(base64);
  var len = binary.length;
  // Uint8Array.from + charCodeAt 比 for 循环赋值在长字符串上更高效（V8 内部优化路径）
  return Uint8Array.from(binary, function (ch) { return ch.charCodeAt(0); });
}

export function createPdfFromJpegs(jpegPages, canvasScale) {
  if (!Array.isArray(jpegPages) || !jpegPages.length || jpegPages.length > PDF_MAX_PAGES) {
    throw new Error("PDF page count exceeds the safe export limit.");
  }
  var aggregateJpegBytes = jpegPages.reduce(function (total, page) {
    return total + Number(page && page.bytes && page.bytes.byteLength || 0);
  }, 0);
  if (aggregateJpegBytes > PDF_MAX_ENCODED_PAGE_BYTES) {
    throw new Error("PDF image data exceeds the safe export limit.");
  }
  var scale = canvasScale || 1;
  // 增量 Blob 构建：用 parts 数组替代单一巨型 Uint8Array，避免连续内存分配失败
  var parts = [];
  var offsets = [];
  var currentOffset = 0;
  var encoder = new TextEncoder();

  function escapePdfString(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[\r\n]/g, "");
  }

  // pushObject：记录对象偏移量（用于 xref 表），并追加到 parts
  function pushObject(content) {
    offsets.push(currentOffset);
    if (content instanceof Uint8Array) {
      parts.push(content);
      currentOffset += content.length;
    } else {
      var encoded = encoder.encode(content);
      parts.push(encoded);
      currentOffset += encoded.length;
    }
  }

  // pushRaw：只追加内容，不记录偏移量（用于对象内部的分片，如 image header/bytes/footer）
  function pushRaw(content) {
    if (content instanceof Uint8Array) {
      parts.push(content);
      currentOffset += content.length;
    } else {
      var encoded = encoder.encode(content);
      parts.push(encoded);
      currentOffset += encoded.length;
    }
  }

  // Header
  pushRaw(encoder.encode("%PDF-1.4\n"));

  // Catalog (obj 1)
  pushObject("1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines [] >>\nendobj\n");

  var pageEntries = jpegPages.map(function (page, index) {
    var logicalWidth = Number(page.logicalWidth) || page.width / scale;
    var logicalHeight = Number(page.logicalHeight) || page.height / scale;
    var pageW = Math.round(logicalWidth * 72 / 96);
    var pageH = Math.round(logicalHeight * 72 / 96);
    var streamContent = "q\n" + pageW + " 0 0 " + pageH + " 0 0 cm\n/Im" + index + " Do\nQ";
    var streamBytes = encoder.encode(streamContent);
    return {
      pageW: pageW,
      pageH: pageH,
      width: page.width,
      height: page.height,
      bytes: page.bytes,
      logicalWidth: logicalWidth,
      logicalHeight: logicalHeight,
      links: Array.isArray(page.links) ? page.links : [],
      streamContent: streamContent,
      streamLength: streamBytes.length
    };
  });

  var imageStartId = 3;
  var pageObjIds = [];
  var contentObjIds = [];
  var imageObjIds = [];
  for (var i = 0; i < jpegPages.length; i++) {
    pageObjIds.push(imageStartId + i * 3);
    contentObjIds.push(imageStartId + i * 3 + 1);
    imageObjIds.push(imageStartId + i * 3 + 2);
  }

  var nextAnnotationId = imageStartId + jpegPages.length * 3;
  var annotationEntriesByPage = pageEntries.map(function (entry) {
    var xScale = entry.pageW / Math.max(1, entry.logicalWidth);
    var yScale = entry.pageH / Math.max(1, entry.logicalHeight);
    return entry.links.map(function (link) {
      var href = normalizeExportLinkHref(link && link.href);
      var x = Math.max(0, Number(link && link.x) || 0);
      var top = Math.max(0, Number(link && link.y) || 0);
      var width = Math.max(1, Number(link && link.width) || 0);
      var height = Math.max(1, Number(link && link.height) || 0);
      if (!href) return null;
      return {
        id: nextAnnotationId++,
        href: href,
        rect: [
          Math.max(0, x * xScale),
          Math.max(0, entry.pageH - (top + height) * yScale),
          Math.min(entry.pageW, (x + width) * xScale),
          Math.min(entry.pageH, entry.pageH - top * yScale)
        ]
      };
    }).filter(Boolean);
  });

  // Pages object (obj 2)
  pushObject("2 0 obj\n<< /Type /Pages /Kids [" + pageObjIds.map(function (id) { return id + " 0 R"; }).join(" ") + "] /Count " + jpegPages.length + " >>\nendobj\n");

  // 每页 3 个对象：Page / Content / Image
  // Image 对象拆分为 header + 原始 bytes + footer 三个 part，避免拼接拷贝
  pageEntries.forEach(function (entry, index) {
    var annotations = annotationEntriesByPage[index] || [];
    var annots = annotations.length ? " /Annots [" + annotations.map(function (annotation) { return annotation.id + " 0 R"; }).join(" ") + "]" : "";
    pushObject(pageObjIds[index] + " 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + entry.pageW + " " + entry.pageH + "] /Contents " + contentObjIds[index] + " 0 R /Resources << /XObject << /Im" + index + " " + imageObjIds[index] + " 0 R >> >>" + annots + " >>\nendobj\n");
    pushObject(contentObjIds[index] + " 0 obj\n<< /Length " + entry.streamLength + " >>\nstream\n" + entry.streamContent + "\nendstream\nendobj\n");
    var imgHeader = encoder.encode(imageObjIds[index] + " 0 obj\n<< /Type /XObject /Subtype /Image /Width " + entry.width + " /Height " + entry.height + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + entry.bytes.length + " >>\nstream\n");
    var imgFooter = encoder.encode("\nendstream\nendobj\n");
    // image 对象只记一次偏移量（header 的起始），bytes 和 footer 作为 raw 追加
    pushObject(imgHeader);
    pushRaw(entry.bytes);
    pushRaw(imgFooter);
  });

  // Annotation 对象
  annotationEntriesByPage.forEach(function (annotations) {
    annotations.forEach(function (annotation) {
      pushObject(annotation.id + " 0 obj\n<< /Type /Annot /Subtype /Link /Rect [" + annotation.rect.map(function (value) {
        return Number(value.toFixed(2));
      }).join(" ") + "] /Border [0 0 0] /A << /S /URI /URI (" + escapePdfString(annotation.href) + ") >> >>\nendobj\n");
    });
  });

  // xref 表与 trailer
  var xrefOffset = currentOffset;
  var xref = "xref\n0 " + (offsets.length + 1) + "\n";
  xref += "0000000000 65535 f \n";
  offsets.forEach(function (offset) {
    xref += String(offset).padStart(10, "0") + " 00000 n \n";
  });

  var trailer = "trailer\n<< /Size " + (offsets.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n";

  pushRaw(encoder.encode(xref));
  pushRaw(encoder.encode(trailer));

  // 直接用 Blob 构造器组装所有 parts，无需分配单一连续 Uint8Array
  var blob = new Blob(parts, { type: "application/pdf" });
  if (blob.size > PDF_MAX_ENCODED_PAGE_BYTES + 8 * 1024 * 1024) {
    throw new Error("PDF output exceeds the safe export limit.");
  }
  return blob;
}
