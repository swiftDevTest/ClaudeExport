(function initChatVaultDeveloperExport() {
  "use strict";

  const EXTENSION_MAP = {
    javascript: ".js",
    js: ".js",
    python: ".py",
    py: ".py",
    typescript: ".ts",
    ts: ".ts",
    html: ".html",
    css: ".css",
    json: ".json",
    shell: ".sh",
    bash: ".sh",
    sh: ".sh",
    rust: ".rs",
    rs: ".rs",
    go: ".go",
    cpp: ".cpp",
    c: ".c",
    java: ".java",
    kotlin: ".kt",
    ruby: ".rb",
    php: ".php",
    sql: ".sql",
    markdown: ".md",
    md: ".md",
    yaml: ".yaml",
    yml: ".yaml",
    xml: ".xml"
  };

  function extractCodeBlocks(messages) {
    const blocks = [];
    const languages = {};
    let codeBlockCount = 0;

    (messages || []).forEach((msg, msgIdx) => {
      if (!Array.isArray(msg.contentBlocks)) return;

      msg.contentBlocks.forEach((block) => {
        if (block && block.type === "code") {
          codeBlockCount++;
          const lang = String(block.language || "text").toLowerCase();
          
          languages[lang] = (languages[lang] || 0) + 1;

          const ext = EXTENSION_MAP[lang] || ".txt";
          const id = `code_${String(codeBlockCount).padStart(3, '0')}`;
          const suggestedFilename = `snippet-${String(codeBlockCount).padStart(3, '0')}${ext}`;

          blocks.push({
            id,
            language: lang,
            messageIndex: msgIdx,
            suggestedFilename,
            text: block.text || ""
          });
        }
      });
    });

    return {
      codeBlockCount,
      languages,
      blocks
    };
  }

  globalThis.CHATVAULT_DEVELOPER_EXPORT = {
    extractCodeBlocks
  };
})();
