"use strict";

const INCOMPLETE_EXPORT_NOTICE_PREFIX = "AI Chat Export notice:";

function defaultPlatformLabel(platform) {
    if (platform === "claude") return "Claude";
    if (platform === "gemini") return "Gemini";
    if (platform === "chatgpt") return "ChatGPT";
    return "AI";
  }

  export function createExportMessageAdapter(options) {
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
      return "Open " + label + " (" + host + ") and use AI Chat Export there to export this conversation body. " + (currentLabel || "This page") + " cannot read " + label + " message content.";
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
        return "Open ChatGPT, Claude, or Gemini before exporting conversation bodies";
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

    function getCurrentPageMessages(chat) {
      if (!isCurrentConversation(chat)) {
        return [];
      }

      var exportService = deps.getExportService ? deps.getExportService() : null;
      if (!exportService || !exportService.parseMessages) {
        return [];
      }

      var messages = exportService.parseMessages({ includeHtmlStyles: false });
      return deps.cloneExportMessages ? deps.cloneExportMessages(messages) : JSON.parse(JSON.stringify(messages || []));
    }

    function getMessageRole(message) {
      return String(message && message.role || "").toLowerCase();
    }

    function hasMessageRole(messages, role) {
      var targetRole = String(role || "").toLowerCase();
      return (Array.isArray(messages) ? messages : []).some(function (message) {
        return getMessageRole(message) === targetRole;
      });
    }

    function shouldUsePageMessagesForIncompleteApi(messages, pageMessages) {
      if (!Array.isArray(messages) || !messages.length || !Array.isArray(pageMessages) || !pageMessages.length) {
        return false;
      }
      if (pageMessages.length <= messages.length) {
        return false;
      }

      var pageHasUser = hasMessageRole(pageMessages, "user");
      var pageHasAssistant = hasMessageRole(pageMessages, "assistant");
      if (!pageHasUser || !pageHasAssistant) {
        return false;
      }

      return (pageHasUser && !hasMessageRole(messages, "user")) ||
        (pageHasAssistant && !hasMessageRole(messages, "assistant"));
    }

    function cloneExportMessages(messages) {
      return deps.cloneExportMessages ? deps.cloneExportMessages(messages) : JSON.parse(JSON.stringify(messages || []));
    }

    function isStandaloneGenUiPlaceholderToken(value) {
      var text = String(value == null ? "" : value).replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").trim();
      return /^genui[A-Za-z0-9_-]{3,64}$/.test(text);
    }

    function stripStandaloneGenUiPlaceholderLines(value) {
      var source = String(value == null ? "" : value);
      if (!source || !/\bgenui[A-Za-z0-9_-]{3,64}\b/.test(source)) return source;
      var removed = false;
      var lines = source.split(/\r?\n/).filter(function (line) {
        if (isStandaloneGenUiPlaceholderToken(line)) {
          removed = true;
          return false;
        }
        return true;
      });
      return removed ? lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() : source;
    }

    function textHasStandaloneGenUiPlaceholder(value) {
      return String(value == null ? "" : value).split(/\r?\n/).some(function (line) {
        return isStandaloneGenUiPlaceholderToken(line);
      });
    }

    function blockToPlainText(block) {
      if (!block || typeof block !== "object") return "";
      if (block.type === "table") {
        var rows = [];
        if (Array.isArray(block.headers)) rows.push(block.headers.join(" "));
        (block.rows || []).forEach(function (row) {
          rows.push((row || []).join(" "));
        });
        return rows.join("\n");
      }
      if (block.type === "list") {
        return (block.items || []).map(function flattenItem(item) {
          if (!item) return "";
          var subText = (item.subItems || []).map(flattenItem).filter(Boolean).join("\n");
          return [item.text || "", subText].filter(Boolean).join("\n");
        }).filter(Boolean).join("\n");
      }
      return String(block.text || "");
    }

    function messageToPlainText(message) {
      return (message && message.contentBlocks || []).map(blockToPlainText).filter(Boolean).join("\n");
    }

    function messageHasUnresolvedGenUiPlaceholder(message) {
      if (!message) return false;
      if (message._chatVaultHasUnresolvedGenUi) return true;
      return (message.contentBlocks || []).some(function (block) {
        return block && (block._chatVaultHasUnresolvedGenUi || textHasStandaloneGenUiPlaceholder(block.text));
      });
    }

    function normalizeComparableGenUiText(value) {
      return stripStandaloneGenUiPlaceholderLines(value)
        .replace(/：/g, ":")
        .replace(/\s+/g, " ")
        .trim();
    }

    function compactTextLength(value) {
      return normalizeComparableGenUiText(value).replace(/\s+/g, "").length;
    }

    function isRicherGenUiPageMessage(apiMessage, pageMessage, sameIndex) {
      if (!pageMessage || getMessageRole(apiMessage) !== getMessageRole(pageMessage)) return false;
      var apiText = normalizeComparableGenUiText(messageToPlainText(apiMessage));
      var pageText = normalizeComparableGenUiText(messageToPlainText(pageMessage));
      var apiLength = compactTextLength(apiText);
      var pageLength = compactTextLength(pageText);
      if (!pageText || pageLength <= apiLength + 8) return false;
      if (!apiText) return true;
      if (pageText.indexOf(apiText) !== -1) return true;
      return Boolean(sameIndex && apiLength < 40);
    }

    function findRicherPageMessageForGenUi(apiMessage, apiIndex, pageMessages, usedPageIndexes) {
      var sameIndexMessage = pageMessages[apiIndex];
      if (!usedPageIndexes.has(apiIndex) && isRicherGenUiPageMessage(apiMessage, sameIndexMessage, true)) {
        return apiIndex;
      }

      var bestIndex = -1;
      var bestDistance = Infinity;
      pageMessages.forEach(function (pageMessage, pageIndex) {
        if (usedPageIndexes.has(pageIndex)) return;
        if (!isRicherGenUiPageMessage(apiMessage, pageMessage, false)) return;
        var distance = Math.abs(pageIndex - apiIndex);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = pageIndex;
        }
      });
      return bestIndex;
    }

    function replaceUnresolvedGenUiMessagesFromPage(messages, pageMessages) {
      if (!Array.isArray(messages) || !messages.length || !Array.isArray(pageMessages) || !pageMessages.length) {
        return null;
      }
      if (!messages.some(messageHasUnresolvedGenUiPlaceholder)) {
        return null;
      }

      var output = cloneExportMessages(messages);
      var pageClones = cloneExportMessages(pageMessages);
      var usedPageIndexes = new Set();
      var replaced = false;

      output.forEach(function (message, index) {
        if (!messageHasUnresolvedGenUiPlaceholder(message)) return;
        var pageIndex = findRicherPageMessageForGenUi(message, index, pageClones, usedPageIndexes);
        if (pageIndex < 0) return;
        usedPageIndexes.add(pageIndex);
        output[index] = pageClones[pageIndex];
        replaced = true;
      });

      return replaced ? output : null;
    }

    function allowsAssistantOnly(options) {
      return options && options.scope === "ai_only";
    }

    function isLikelyIncompleteConversationMessages(messages, options) {
      if (allowsAssistantOnly(options)) {
        return false;
      }

      return Array.isArray(messages) &&
        messages.length > 0 &&
        hasMessageRole(messages, "assistant") &&
        !hasMessageRole(messages, "user");
    }

    function getChatTitle(chat) {
      return String(chat && chat.title || "").trim();
    }

    function getIncompleteConversationMessage(chat) {
      var platform = getChatPlatform(chat);
      var label = deps.getPlatformLabel ? deps.getPlatformLabel(platform) : defaultPlatformLabel(platform);
      var title = getChatTitle(chat);
      var titleLabel = title ? "\"" + title + "\"" : "this conversation";
      return INCOMPLETE_EXPORT_NOTICE_PREFIX + " This export may be incomplete. " + label + " returned AI replies for " + titleLabel + " without the original user questions, so AI Chat Export exported the available replies and marked this file. To recover the missing questions, open this conversation in " + label + " and export again, or use Select messages export after the conversation is open.";
    }

    function hasIncompleteExportNotice(messages) {
      return (Array.isArray(messages) ? messages : []).some(function (message) {
        return (message && message.contentBlocks || []).some(function (block) {
          return String(block && block.text || "").indexOf(INCOMPLETE_EXPORT_NOTICE_PREFIX) === 0;
        });
      });
    }

    function prependIncompleteExportNotice(chat, messages) {
      var list = Array.isArray(messages) ? messages : [];
      if (hasIncompleteExportNotice(list)) {
        return list;
      }

      return [{
        role: "assistant",
        contentBlocks: [{
          type: "paragraph",
          text: getIncompleteConversationMessage(chat)
        }]
      }].concat(list);
    }

    function ensureCompleteConversationMessages(chat, messages, options) {
      if (isLikelyIncompleteConversationMessages(messages, options)) {
        return prependIncompleteExportNotice(chat, messages);
      }

      return messages;
    }

    function returnApiMessagesOrPageFallback(chat, messages, pageMessages, options) {
      var fallbackMessages = Array.isArray(pageMessages) ? pageMessages : getCurrentPageMessages(chat);
      if (shouldUsePageMessagesForIncompleteApi(messages, fallbackMessages)) {
        return ensureCompleteConversationMessages(chat, fallbackMessages, options);
      }

      var repairedMessages = replaceUnresolvedGenUiMessagesFromPage(messages, fallbackMessages);
      if (repairedMessages) {
        return ensureCompleteConversationMessages(chat, repairedMessages, options);
      }

      if (Array.isArray(messages) && messages.length > 0) {
        return ensureCompleteConversationMessages(chat, messages, options);
      }

      return fallbackMessages.length
        ? ensureCompleteConversationMessages(chat, fallbackMessages, options)
        : messages;
    }

    async function fetchConversationMessagesForExport(chat, options) {
      if (deps.isProjectRecord && deps.isProjectRecord(chat)) {
        throw new Error("Projects do not have a single conversation body to export.");
      }

      var unsupportedReason = getUnsupportedChatBodyExportReason(chat);
      if (unsupportedReason) {
        throw new Error(unsupportedReason);
      }

      var platform = getChatPlatform(chat);

      if (platform !== "chatgpt" && platform !== "claude" && platform !== "gemini") {
        var unsupportedPageMessages = getCurrentPageMessages(chat);
        if (unsupportedPageMessages.length > 0) {
          return unsupportedPageMessages;
        }
      }

      try {
        if (platform === "gemini") {
          var geminiPageMessages = getCurrentPageMessages(chat);
          try {
            var geminiMessages = await deps.fetchGeminiConversationMessages(chat);
            return returnApiMessagesOrPageFallback(chat, geminiMessages, geminiPageMessages, options);
          } catch (geminiError) {
            if (geminiPageMessages.length) {
              return ensureCompleteConversationMessages(chat, geminiPageMessages, options);
            }
            throw geminiError;
          }
        }

        if (platform === "claude") {
          try {
            var claudeMessages = await deps.fetchClaudeConversationMessages(chat);
            return returnApiMessagesOrPageFallback(chat, claudeMessages, null, options);
          } catch (claudeError) {
            var claudePageMessages = getCurrentPageMessages(chat);
            if (claudePageMessages.length) {
              return ensureCompleteConversationMessages(chat, claudePageMessages, options);
            }
            throw claudeError;
          }
        }

        var chatGptPageMessages = [];
        try {
          chatGptPageMessages = getCurrentPageMessages(chat);
          var chatGptMessages = await deps.fetchChatGptConversationMessages(chat, { pageMessages: chatGptPageMessages });
          if (typeof deps.mergeChatGptExportMessages === "function" && chatGptPageMessages.length) {
            chatGptMessages = deps.mergeChatGptExportMessages(chatGptMessages, chatGptPageMessages);
          }
          return returnApiMessagesOrPageFallback(chat, chatGptMessages, chatGptPageMessages, options);
        } catch (chatGptError) {
          if (chatGptPageMessages.length) {
            return ensureCompleteConversationMessages(chat, chatGptPageMessages, options);
          }
          var fallbackChatGptPageMessages = getCurrentPageMessages(chat);
          if (fallbackChatGptPageMessages.length) {
            return ensureCompleteConversationMessages(chat, fallbackChatGptPageMessages, options);
          }
          throw chatGptError;
        }
      } catch (error) {
        if (deps.logFetchFailure) {
          var pageMessages = [];
          try {
            pageMessages = getCurrentPageMessages(chat);
          } catch (pageError) {
            pageMessages = [];
          }
          deps.logFetchFailure(error, pageMessages);
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

      var messages = await fetchConversationMessagesForExport(chat, { scope: request.scope });
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
