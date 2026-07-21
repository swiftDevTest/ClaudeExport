(function initChatVaultPrivacyProof() {
  "use strict";

  function generateProof(input) {
    const format = String(input?.format || "pdf").toLowerCase();
    const mode = String(input?.mode || "conversation").toLowerCase();
    const platform = String(input?.platform || "chatgpt").toLowerCase();
    const hasImages = Boolean(input?.imageSummary?.total && input.imageSummary.total > 0);
    
    // Detect UI language if available
    let isZh = false;
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
        const lang = chrome.i18n.getUILanguage() || "";
        isZh = lang.startsWith("zh");
      }
    } catch (e) {}

    const statements = [];
    
    if (isZh) {
      statements.push(`文档格式为 [${format.toUpperCase()}]，完全在您浏览器的本地生成。`);
      statements.push("聊天文本正文绝对不会上传到 ChatVault 远程服务器进行转档。");
      if (hasImages) {
        statements.push("由于对话包含图片，扩展仅会通过浏览器后台从原 AI 平台的可信 CDN 拉取图片字节用于排版。");
      }
      statements.push("扣额计数保存在本地；VIP 状态仅通过账号服务校验，不会上传聊天正文或扫描历史聊天列表。");
    } else {
      statements.push(`Document format [${format.toUpperCase()}] is generated 100% locally in your browser.`);
      statements.push("Chat content text is never uploaded to ChatVault servers for conversion.");
      if (hasImages) {
        statements.push("As the conversation contains images, the extension will securely fetch image bytes from the original platform CDN locally.");
      }
      statements.push("Usage count is stored locally; VIP status is checked through the account service without uploading chat content or scanning your chat history list.");
    }

    return {
      localGeneration: true,
      uploadsChatContent: false,
      usesConversionServer: false,
      mayFetchOriginalImages: hasImages,
      storesUsageLocally: true,
      usageCost: Number(input?.usageCost) || 1,
      statements: statements
    };
  }

  globalThis.CHATVAULT_PRIVACY_PROOF = {
    generateProof
  };
})();
