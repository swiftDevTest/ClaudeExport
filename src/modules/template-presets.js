(function initChatVaultTemplatePresets() {
  "use strict";

  const PRESETS = [
    {
      id: "default_transcript",
      label: "Default Transcript",
      minPlan: "free",
      defaults: {
        mode: "conversation",
        format: "pdf",
        export_style: "default",
        show_conversation_title: true,
        show_platform_name: true,
        show_role_labels: true,
        show_export_time: true,
        include_source_url: false,
        redaction_enabled: false
      }
    },
    {
      id: "ai_only_report",
      label: "AI-only Report",
      minPlan: "free",
      defaults: {
        mode: "ai_only",
        format: "pdf",
        export_style: "default",
        show_conversation_title: true,
        show_platform_name: false,
        show_role_labels: false,
        show_export_time: true,
        include_source_url: false,
        redaction_enabled: false,
        include_prompt_appendix: false,
        generate_toc: true
      }
    },
    {
      id: "qa_transcript",
      label: "Q&A Transcript",
      minPlan: "free",
      defaults: {
        mode: "conversation",
        format: "pdf",
        export_style: "default",
        show_conversation_title: true,
        show_platform_name: true,
        show_role_labels: true,
        show_export_time: true,
        include_source_url: false,
        redaction_enabled: false
      }
    },
    {
      id: "research_brief",
      label: "Research Brief",
      minPlan: "pro",
      defaults: {
        mode: "ai_only",
        format: "pdf",
        export_style: "oxford",
        show_conversation_title: true,
        show_platform_name: false,
        show_role_labels: false,
        show_export_time: true,
        include_source_url: false,
        redaction_enabled: false,
        include_prompt_appendix: true,
        generate_toc: true
      }
    }
  ];

  function getPreset(presetId) {
    return PRESETS.find(p => p.id === presetId) || PRESETS[0];
  }

  function applyPreset(presetId, currentSettings = {}) {
    const preset = getPreset(presetId);
    return {
      ...currentSettings,
      ...preset.defaults
    };
  }

  // 核心逻辑：对 AI-only 模式进行重构和结构优化
  function transformMessages(messages, mode, settings = {}) {
    const cloned = JSON.parse(JSON.stringify(messages || []));

    if (mode !== "ai_only") {
      return cloned;
    }

    const transformed = [];
    const prompts = [];
    let lastUserPrompt = "";

    cloned.forEach((msg, idx) => {
      if (msg.role === "user") {
        // 提取用户的 Prompt 文本用于附录或转为标题
        let promptText = "";
        if (Array.isArray(msg.contentBlocks)) {
          promptText = msg.contentBlocks
            .filter(b => b && (b.type === "paragraph" || b.type === "heading"))
            .map(b => b.text || "")
            .join("\n")
            .trim();
        }
        if (promptText) {
          lastUserPrompt = promptText;
          prompts.push({ index: idx, text: promptText });
        }
      } else if (msg.role === "assistant") {
        const newMsg = {
          role: "assistant",
          contentBlocks: Array.isArray(msg.contentBlocks) ? [...msg.contentBlocks] : []
        };

        // Prompt text must not enter the default export. Only an explicit setting may use it as a section title.
        if (settings.use_prompt_as_section_title && lastUserPrompt && lastUserPrompt.length > 0 && lastUserPrompt.length < 80) {
          const cleanPrompt = lastUserPrompt.replace(/\n+/g, " ");
          const headingBlock = {
            type: "heading",
            level: 3,
            text: cleanPrompt
          };
          newMsg.contentBlocks.unshift(headingBlock);
        }

        if (settings.include_prompt_appendix && lastUserPrompt) {
          newMsg.exportMeta = {
            sourcePrompt: lastUserPrompt,
            includeInPromptAppendix: true
          };
        }

        transformed.push(newMsg);
        // 清空，防止多次对应同一个 Prompt
        lastUserPrompt = "";
      }
    });

    // Pro 功能：如果启用了附录 (Prompt Appendix)，将原始 Prompt 作为附录追加在最后
    if (settings.include_prompt_appendix && prompts.length > 0) {
      let isZh = false;
      try {
        if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
          const lang = chrome.i18n.getUILanguage() || "";
          isZh = lang.startsWith("zh");
        }
      } catch (e) {}

      const appendixBlocks = [
        {
          type: "heading",
          level: 2,
          text: isZh ? "附录：原始提问清单" : "Appendix: Original Prompts"
        }
      ];

      prompts.forEach((p, i) => {
        appendixBlocks.push({
          type: "paragraph",
          text: `${i + 1}. ${p.text}`
        });
      });

      transformed.push({
        role: "system",
        contentBlocks: appendixBlocks
      });
    }

    return transformed;
  }

  globalThis.CHATVAULT_TEMPLATE_PRESETS = {
    PRESETS,
    getPreset,
    applyPreset,
    transformMessages
  };
})();
