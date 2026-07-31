(function initChatVaultPrivacyProof() {
  "use strict";

  function generateProof(input) {
    const format = String(input?.format || "pdf").toLowerCase();
    const mode = String(input?.mode || "conversation").toLowerCase();
    const platform = String(input?.platform || "claude").toLowerCase();
    const hasImages = Boolean(input?.imageSummary?.total && input.imageSummary.total > 0);

    // i18n helper: prefers chrome.i18n.getMessage (returns locale-specific catalog text),
    // falls back to defaultText (English) when no catalog is available.
    function t(key, defaultText, ...args) {
      try {
        if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
          const msg = chrome.i18n.getMessage(key, args);
          if (msg) return msg;
        }
      } catch (e) {}
      let result = String(defaultText || "");
      args.forEach((arg, i) => {
        result = result.split("$" + (i + 1)).join(String(arg));
      });
      return result;
    }

    const statements = [];

    statements.push(t("privacy_proof_local_generation", "Document format [$1] is generated 100% locally in your browser.", format.toUpperCase()));
    statements.push(t("privacy_proof_no_upload", "The extension never uploads chat text to its servers for conversion."));
    if (hasImages) {
      statements.push(t("privacy_proof_image_fetch", "As the conversation contains images, the extension will securely fetch image bytes from the original platform CDN locally."));
    }
    statements.push(t("privacy_proof_usage_local", "Guest usage is stored locally. For signed-in users, quota and plan status may be verified and synchronized with the account service; chat content and history lists are not uploaded."));

    return {
      localGeneration: true,
      uploadsChatContent: false,
      usesConversionServer: false,
      mayFetchOriginalImages: hasImages,
      storesUsageLocally: true,
      syncsSignedInUsageWithAccountService: true,
      usageCost: Number(input?.usageCost) || 1,
      statements: statements
    };
  }

  globalThis.CHATVAULT_PRIVACY_PROOF = {
    generateProof
  };
})();
