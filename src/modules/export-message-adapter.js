(function initChatVaultExportMessageAdapter() {
  "use strict";

  var productName = globalThis.CHATVAULT_PRODUCT_CONFIG?.productName || "Claude Export";
  var productConfig = globalThis.CHATVAULT_PRODUCT_CONFIG || {};

  function defaultPlatformLabel(platform) {
    if (platform === "claude") return "Claude";
    if (platform === "gemini") return "Gemini";
    if (platform === "chatgpt") return "ChatGPT";
    return "AI";
  }

  function getSupportedPlatformLabel() {
    var platformLabels = productConfig.platformLabels || {};
    var supportedPlatforms = Array.isArray(productConfig.supportedPlatforms) && productConfig.supportedPlatforms.length
      ? productConfig.supportedPlatforms
      : ["chatgpt", "claude", "gemini"];
    var names = supportedPlatforms.map(function (platform) {
      return platformLabels[platform] || defaultPlatformLabel(platform);
    });
    if (!names.length) return "supported AI chat";
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + " or " + names[1];
    return names.slice(0, -1).join(", ") + ", or " + names[names.length - 1];
  }

  function createExportMessageAdapter(options) {
    var deps = options || {};

    function getChatPlatform(chat) {
      return deps.getChatPlatform ? deps.getChatPlatform(chat) : chat && chat.platform || "chatgpt";
    }

    function getChatConversationId(chat) {
      return deps.getChatConversationId ? deps.getChatConversationId(chat) : chat && (chat.conversationId || chat.id) || "";
    }

    function isCurrentConversation(chat) {
      return deps.isCurrentConversation ? deps.isCurrentConversation(chat) : false;
    }

    function getCrossPlatformExportMessage(platform) {
      var label = deps.getPlatformLabel ? deps.getPlatformLabel(platform) : defaultPlatformLabel(platform);
      var host = platform === "claude"
        ? "https://claude.ai"
        : platform === "gemini"
          ? "https://gemini.google.com"
          : "https://chatgpt.com";
      var currentLabel = deps.getPlatformLabel ? deps.getPlatformLabel(deps.getCurrentPlatformId ? deps.getCurrentPlatformId() : "") : "";
      return "Open " + label + " (" + host + ") and use " + productName + " there to export this conversation body. " + (currentLabel || "This page") + " cannot read " + label + " message content.";
    }

    function getPlatformExportRequirement(platform) {
      if (platform === "claude") return "Claude";
      if (platform === "gemini") return "Gemini";
      return "ChatGPT";
    }

    function getUnsupportedChatBodyExportReason(chat, currentPlatform) {
      if (deps.isProjectRecord && deps.isProjectRecord(chat)) {
        return "Projects do not have a single conversation body to export";
      }

      var platform = getChatPlatform(chat);
      var label = deps.getPlatformLabel ? deps.getPlatformLabel(platform) : defaultPlatformLabel(platform);
      var activePlatform = typeof currentPlatform === "undefined"
        ? (deps.getCurrentPlatformId ? deps.getCurrentPlatformId() : "")
        : currentPlatform;

      if (!getChatConversationId(chat)) {
        return "Conversation ID is missing";
      }

      if (platform !== "chatgpt" && platform !== "claude" && platform !== "gemini") {
        return label + " is not supported for conversation body export";
      }

      if (!activePlatform) {
        return "Open " + getSupportedPlatformLabel() + " before exporting conversation bodies";
      }

      if (platform !== activePlatform) {
        return label + " chats can only be exported from " + getPlatformExportRequirement(platform);
      }

      return "";
    }

    function ensureCanReadChatBody(chat) {
      var platform = getChatPlatform(chat);
      var currentPlatform = deps.getCurrentPlatformId ? deps.getCurrentPlatformId() : "";

      if (platform !== currentPlatform) {
        throw new Error(getCrossPlatformExportMessage(platform));
      }

      if (platform === "chatgpt" && deps.isChatGptHost && !deps.isChatGptHost()) {
        throw new Error(getCrossPlatformExportMessage("chatgpt"));
      }

      if (platform === "claude" && deps.isClaudeHost && !deps.isClaudeHost()) {
        throw new Error(getCrossPlatformExportMessage("claude"));
      }

      if (platform === "gemini" && deps.isGeminiHost && !deps.isGeminiHost()) {
        throw new Error(getCrossPlatformExportMessage("gemini"));
      }
    }

    async function fetchConversationMessagesForExport(chat) {
      if (deps.isProjectRecord && deps.isProjectRecord(chat)) {
        throw new Error("Projects do not have a single conversation body to export.");
      }

      var unsupportedReason = getUnsupportedChatBodyExportReason(chat);
      if (unsupportedReason) {
        throw new Error(unsupportedReason);
      }

      var exportService = deps.getExportService ? deps.getExportService() : null;
      var pageMessages = exportService && exportService.parseMessages && isCurrentConversation(chat)
        ? deps.cloneExportMessages(exportService.parseMessages())
        : [];

      var platform = getChatPlatform(chat);

      if (platform !== "chatgpt" && platform !== "claude" && platform !== "gemini" && isCurrentConversation(chat) && pageMessages && pageMessages.length > 0) {
        return pageMessages;
      }

      try {
        if (platform === "gemini") {
          try {
            var geminiMessages = await deps.fetchGeminiConversationMessages(chat);
            return isCurrentConversation(chat) && pageMessages.length
              ? deps.mergeGeminiExportMessages(geminiMessages, pageMessages)
              : geminiMessages;
          } catch (geminiError) {
            if (pageMessages.length) {
              return pageMessages;
            }
            throw geminiError;
          }
        }

        if (platform === "claude") {
          return await deps.fetchClaudeConversationMessages(chat);
        }

        var chatGptMessages = await deps.fetchChatGptConversationMessages(chat, { pageMessages: pageMessages });
        return isCurrentConversation(chat) && pageMessages.length
          ? deps.mergeChatGptExportMessages(chatGptMessages, pageMessages)
          : chatGptMessages;
      } catch (error) {
        if (deps.logFetchFailure) {
          deps.logFetchFailure(error, pageMessages);
        }
        if (pageMessages.length) {
          return pageMessages;
        }
        throw error;
      }
    }

    async function attachCurrentConversationMessagesForExport(request) {
      if (request.messages || request.scope === "selected" || request.scope === "assistant_single") {
        return request;
      }

      if (request.scope !== "conversation" && request.scope !== "ai_only") {
        return request;
      }

      var chat = deps.getCurrentConversationForExport ? deps.getCurrentConversationForExport() : null;
      if (!chat) {
        if (deps.logAttachSkipped) deps.logAttachSkipped();
        return request;
      }

      var messages = await fetchConversationMessagesForExport(chat);
      return {
        ...request,
        messages: messages,
        platform: chat.platform,
        title: chat.title,
        sourceUrl: chat.url
      };
    }

    return {
      getCrossPlatformExportMessage: getCrossPlatformExportMessage,
      getUnsupportedChatBodyExportReason: getUnsupportedChatBodyExportReason,
      ensureCanReadChatBody: ensureCanReadChatBody,
      fetchConversationMessagesForExport: fetchConversationMessagesForExport,
      attachCurrentConversationMessagesForExport: attachCurrentConversationMessagesForExport
    };
  }

  globalThis.CHATVAULT_EXPORT_MESSAGE_ADAPTER = {
    createExportMessageAdapter: createExportMessageAdapter
  };
})();
