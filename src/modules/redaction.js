(function initChatVaultRedaction() {
  "use strict";

  // 内置正则表达式
  const RULES = {
    email: {
      regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}/g,
      replacement: "[REDACTED: EMAIL]"
    },
    phone: {
      // 匹配国际和常见电话格式，如 +86 138-0000-0000, 13800000000, +1 123-456-7890 等
      regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|\b1[3-9]\d{9}\b/g,
      replacement: "[REDACTED: PHONE]"
    },
    api_key: {
      // 仅匹配明确前缀或明确凭据字段后的 token，避免误伤 MD5、Git SHA 等普通长串。
      regex: /\b(sk-[a-zA-Z0-9]{32,128}|ghp_[a-zA-Z0-9]{36,255}|github_pat_[a-zA-Z0-9_]{40,255})\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|secret|password|passwd|token|key)([\s=:\'\"#\-]+)([a-zA-Z0-9_\-.]{16,128})/gi,
      replacement: "[REDACTED: API_KEY]"
    },
    credit_card_like: {
      // 匹配 13 到 19 位的信用卡号
      regex: /\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b|\b\d{13,19}\b/g,
      replacement: "[REDACTED: CREDIT_CARD]"
    },
    sensitive_url_param: {
      // 匹配 URL 中诸如 token=xxx，secret=xxx 的查询参数
      regex: /(?<=[?&])((?:token|key|secret|password|session|auth|access_token)=)([a-zA-Z0-9_\-\.\%]{8,128})/gi,
      replacement: "REDACTED_PARAM"
    }
  };

  function redactText(text, options, summary) {
    if (!text || typeof text !== "string") {
      return text;
    }

    let result = text;

    // 1. 应用内置规则
    Object.keys(RULES).forEach((ruleKey) => {
      const rule = RULES[ruleKey];
      
      if (ruleKey === "sensitive_url_param") {
        result = result.replace(rule.regex, (match, paramNameWithEquals, paramValue) => {
          summary.totalMatches++;
          summary.byType[ruleKey] = (summary.byType[ruleKey] || 0) + 1;
          return paramNameWithEquals + rule.replacement;
        });
      } else if (ruleKey === "api_key") {
        result = result.replace(rule.regex, (match, prefixedKey, separator, value) => {
          summary.totalMatches++;
          summary.byType[ruleKey] = (summary.byType[ruleKey] || 0) + 1;
          if (separator && value) {
            return match.slice(0, match.length - String(value).length) + rule.replacement;
          }
          return rule.replacement;
        });
      } else {
        result = result.replace(rule.regex, (match) => {
          summary.totalMatches++;
          summary.byType[ruleKey] = (summary.byType[ruleKey] || 0) + 1;
          return rule.replacement;
        });
      }
    });

    // 2. 应用自定义规则 (仅 Pro)
    if (Array.isArray(options?.customRules)) {
      options.customRules.forEach((rule) => {
        if (!rule || !rule.enabled || !rule.pattern) return;
        try {
          const regex = new RegExp(rule.pattern, "gi");
          const replacement = rule.replacement || "[REDACTED]";
          result = result.replace(regex, (match) => {
            summary.totalMatches++;
            const label = rule.id || rule.label || "custom";
            summary.byType[label] = (summary.byType[label] || 0) + 1;
            return replacement;
          });
        } catch (e) {
          console.warn("Invalid custom rule pattern:", rule.pattern, e);
        }
      });
    }

    return result;
  }

  function redactMessages(messages, options = {}) {
    const enabled = options.redaction_enabled !== false;
    const redactCode = options.redactCodeBlocks !== false;
    
    // 如果没有启用脱敏，直接深拷贝并返回
    if (!enabled) {
      return {
        messages: JSON.parse(JSON.stringify(messages || [])),
        summary: { enabled: false, totalMatches: 0, byType: {} }
      };
    }

    const cloned = JSON.parse(JSON.stringify(messages || []));
    const summary = {
      enabled: true,
      totalMatches: 0,
      byType: {}
    };

    cloned.forEach((msg) => {
      if (Array.isArray(msg.contentBlocks)) {
        msg.contentBlocks.forEach((block) => {
          if (!block) return;
          
          if (block.type === "code") {
            if (redactCode && typeof block.text === "string") {
              block.text = redactText(block.text, options, summary);
            }
          } else if (typeof block.text === "string") {
            block.text = redactText(block.text, options, summary);
          }

          if (block.type === "image" && typeof block.alt === "string") {
            block.alt = redactText(block.alt, options, summary);
          }
        });
      }

      if (msg.exportMeta && typeof msg.exportMeta === "object") {
        Object.keys(msg.exportMeta).forEach((key) => {
          if (typeof msg.exportMeta[key] === "string") {
            msg.exportMeta[key] = redactText(msg.exportMeta[key], options, summary);
          }
        });
      }
    });

    return {
      messages: cloned,
      summary: summary
    };
  }

  globalThis.CHATVAULT_REDACTION = {
    redactMessages,
    _test: {
      redactText
    }
  };
})();
