(function initChatVaultExportHealth() {
  "use strict";

  function formatMessage(template, args = []) {
    return String(template || "").replace(/\$(\d+)/g, (match, index) => {
      const value = args[Number(index) - 1];
      return value === undefined || value === null ? match : String(value);
    });
  }

  function estimateDataUrlBytes(src) {
    if (!src || typeof src !== "string" || src.indexOf("data:") !== 0) {
      return 0;
    }
    const commaIndex = src.indexOf(",");
    if (commaIndex === -1) {
      return 0;
    }
    const meta = src.slice(5, commaIndex);
    const payload = src.slice(commaIndex + 1).replace(/\s/g, "");
    if (/;base64(?:;|$)/i.test(";" + meta)) {
      return Math.ceil(payload.length * 0.75);
    }
    try {
      return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
    } catch (error) {
      return payload.length;
    }
  }

  function checkHealth(input) {
    const messages = Array.isArray(input?.messages) ? input.messages : [];
    const format = String(input?.format || "pdf").toLowerCase();
    const mode = String(input?.mode || "conversation").toLowerCase();
    const platform = String(input?.platform || "chatgpt").toLowerCase();
    const limits = input?.imageLimits || { maxChars: 12000, maxMessages: 40, maxCodeChars: 8000, maxRenderHeight: 6000 };
    const maxCodeChars = Number.isFinite(Number(limits.maxCodeChars)) ? Number(limits.maxCodeChars) : 8000;

    let isZh = false;
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
        const lang = chrome.i18n.getUILanguage() || "";
        isZh = lang.startsWith("zh");
      }
    } catch (e) {}

    let userCount = 0;
    let assistantCount = 0;
    let imageCount = 0;
    let estimatedEmbeddedImageBytes = 0;
    let codeBlockCount = 0;
    let totalTextChars = 0;

    messages.forEach((msg) => {
      if (msg.role === "user") userCount++;
      else if (msg.role === "assistant") assistantCount++;

      if (Array.isArray(msg.contentBlocks)) {
        msg.contentBlocks.forEach((block) => {
          if (block.type === "image") {
            imageCount++;
            estimatedEmbeddedImageBytes += estimateDataUrlBytes(block.src);
          } else if (block.type === "code") {
            codeBlockCount++;
            totalTextChars += (block.text || "").length;
          } else if (block.text) {
            totalTextChars += block.text.length;
          }
        });
      }
    });

    const issues = [];
    let status = "ready";

    // 1. 空内容检查
    if (messages.length === 0) {
      status = "high_risk";
      issues.push({
        id: "empty_conversation",
        severity: "high_risk",
        message: isZh ? "当前会话没有检测到有效的聊天信息，请等待页面加载。" : "No messages detected in this conversation. Please wait for the page to load.",
        action: "wait_load"
      });
    }

    // 2. AI-only 模式下无 assistant 消息检查
    if (mode === "ai_only" && assistantCount === 0) {
      status = "high_risk";
      issues.push({
        id: "empty_ai_only",
        severity: "high_risk",
        message: isZh ? "在[仅导出AI回复]模式下未检测到AI的消息。" : "No assistant replies found in AI-only mode.",
        action: "change_mode"
      });
    }

    // 3. 懒加载内容检查 (如果消息数量过少且存在平台特征)
    if (messages.length > 0 && messages.length <= 2) {
      issues.push({
        id: "lazy_load_hint",
        severity: "info",
        message: isZh ? "提示：如果聊天记录很长，请滚动页面以确保所有消息都已被加载到网页中。" : "Tip: If the chat is long, scroll the page to ensure all messages are fully loaded in the browser.",
        action: "scroll_page"
      });
    }

    // 4. 图片风险检查（是否存在不信任来源或图片过多）
    if (estimatedEmbeddedImageBytes > 32 * 1024 * 1024) {
      status = "high_risk";
      issues.push({
        id: "embedded_images_too_large",
        severity: "high_risk",
        message: isZh ? "本对话内嵌图片体积过大。请减少图片或拆分导出，以避免浏览器内存不足。" : "Embedded images are too large for a safe export. Reduce images or split the export to avoid running out of browser memory.",
        action: "split_export"
      });
    } else if (estimatedEmbeddedImageBytes > 20 * 1024 * 1024) {
      if (status !== "high_risk") status = "attention";
      issues.push({
        id: "embedded_images_large",
        severity: "attention",
        message: isZh ? "本对话包含较大的内嵌图片，导出可能占用较多内存。" : "This chat contains large embedded images and may use significant memory during export.",
        action: "split_export"
      });
    }

    if (imageCount > 10) {
      if (status !== "high_risk") status = "attention";
      issues.push({
        id: "high_image_count",
        severity: "attention",
        message: formatMessage(isZh ? "本对话包含大量图片 ($1 张)，可能需要较长时间抓取并构建文档。" : "This chat contains many images ($1), which might take longer to download and build.", [imageCount]),
        args: [imageCount],
        action: "wait_longer"
      });
    }

    // 5. Canvas 物理像素超高分割检查（仅适用于 Image 导出）
    let estimatedImagePages = 1;
    if (format === "image" && messages.length > 0) {
      // 粗略估算渲染高度：每个字符大约占用 0.5px 物理高度（在特定宽度下分行），每个消息至少占用 120px，每张图片 300px，每个代码块 200px
      const estHeight = (totalTextChars * 0.45) + (messages.length * 100) + (imageCount * 300) + (codeBlockCount * 180);
      const maxHeight = limits.maxRenderHeight || 6000;
      
      if (estHeight > maxHeight) {
        estimatedImagePages = Math.ceil(estHeight / maxHeight);
        if (status !== "high_risk") status = "attention";
        issues.push({
          id: "png_will_split",
          severity: "attention",
          message: isZh ? `对话内容较长，生成的长图将被自动分割为 ${estimatedImagePages} 张图片，以防浏览器崩溃。` : `The chat is long. The image export will be automatically split into ${estimatedImagePages} images to prevent browser crash.`,
          action: "split_image"
        });
      }
    }

    // 6. 超长代码块检测
    let hasUltraLongCode = false;
    messages.forEach((msg) => {
      if (Array.isArray(msg.contentBlocks)) {
        msg.contentBlocks.forEach((block) => {
          if (block.type === "code" && (block.text || "").length > maxCodeChars) {
            hasUltraLongCode = true;
          }
        });
      }
    });
    if (hasUltraLongCode) {
      if (status !== "high_risk") status = "attention";
      issues.push({
        id: "ultra_long_code",
        severity: "attention",
        message: isZh ? "检测到超长代码块，建议使用 Word/PDF 导出以保证最佳排版效果。" : "Large code blocks detected. Word or PDF export is recommended for better formatting.",
        action: "use_pdf_or_word"
      });
    }

    return {
      status,
      summary: {
        messageCount: messages.length,
        assistantCount,
        userCount,
        imageCount,
        estimatedEmbeddedImageBytes,
        codeBlockCount,
        estimatedImagePages
      },
      issues
    };
  }

  globalThis.CHATVAULT_EXPORT_HEALTH = {
    checkHealth,
    _test: {
      estimateDataUrlBytes,
      formatMessage
    }
  };
})();
