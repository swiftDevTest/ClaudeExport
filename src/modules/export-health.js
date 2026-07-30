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

    // 5. Canvas 物理像素缩放检查（仅适用于 Image 导出）
    let estimatedImagePages = 1;
    if (format === "image" && messages.length > 0) {
      // 粗略估算渲染高度：每个字符大约占用 0.5px 物理高度（在特定宽度下分行），每个消息至少占用 120px，每张图片 300px，每个代码块 200px
      const estHeight = (totalTextChars * 0.45) + (messages.length * 100) + (imageCount * 300) + (codeBlockCount * 180);
      const maxHeight = limits.maxRenderHeight || 6000;
      
      if (estHeight > maxHeight) {
        estimatedImagePages = Math.ceil(estHeight / maxHeight);
        issues.push({
          id: "png_scale_reduced",
          severity: "info",
          message: isZh
            ? "对话内容较长，长图导出会自动降低像素倍率以适配浏览器画布限制；如需保持分页清晰度，请改用 PDF。"
            : "The chat is long. Image export will reduce its pixel scale to fit browser canvas limits; use PDF to preserve full paginated fidelity.",
          action: "use_pdf"
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

    // 7. DOM 解析丢内容检查（防止 AI 平台 DOM 变动导致静默丢消息）
    // parseStats 由 platform.parseMessages 收集，传入后用于比对候选 turn 数与实际解析数
    // 当 droppedTurnCount 较大且占比较高时，提示用户可能是扩展版本过旧或页面结构变化
    const parseStats = input?.parseStats || null;
    if (parseStats && typeof parseStats === "object") {
      const candidateCount = Number(parseStats.candidateTurnCount) || 0;
      const parsedCount = Number(parseStats.parsedMessageCount) || 0;
      const droppedCount = Number(parseStats.droppedTurnCount) || 0;
      if (candidateCount > 0 && parsedCount > 0) {
        const dropRate = droppedCount / candidateCount;
        // 阈值：丢弃数 >= 3 且丢弃率 >= 30% 才告警，避免候选选择器略宽导致的误报
        if (droppedCount >= 3 && dropRate >= 0.3) {
          if (status !== "high_risk") status = "attention";
          issues.push({
            id: "dom_parse_drop",
            severity: "attention",
            message: isZh
              ? `检测到 ${droppedCount}/${candidateCount} 个候选消息未被解析，可能是页面结构变化导致部分内容丢失。请滚动加载完整或更新扩展。`
              : `${droppedCount} of ${candidateCount} candidate messages were not parsed. The page layout may have changed; scroll to load fully or update the extension.`,
            action: "scroll_or_update_extension"
          });
        }
      } else if (candidateCount > 0 && parsedCount === 0 && mode !== "ai_only") {
        // 候选元素存在但解析结果为空，说明选择器全部失效，高风险
        status = "high_risk";
        issues.push({
          id: "dom_parse_empty",
          severity: "high_risk",
          message: isZh
            ? "页面检测到消息元素但解析结果为空，扩展可能已过时。请更新扩展后再试。"
            : "Message elements were detected on the page but parsing returned nothing. The extension may be out of date; please update.",
          action: "update_extension"
        });
      }
    }

    const result = {
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

    if (parseStats) {
      result.parseStats = {
        candidateTurnCount: Number(parseStats.candidateTurnCount) || 0,
        parsedMessageCount: Number(parseStats.parsedMessageCount) || 0,
        droppedTurnCount: Number(parseStats.droppedTurnCount) || 0
      };
    }

    return result;
  }

  globalThis.CHATVAULT_EXPORT_HEALTH = {
    checkHealth,
    _test: {
      estimateDataUrlBytes,
      formatMessage
    }
  };
})();
