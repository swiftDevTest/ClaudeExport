(function initChatVaultExportReceipt() {
  "use strict";

  async function calculateSha256(arrayBuffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function sanitizeSourceUrl(rawUrl) {
    const sensitiveKey = /^(token|key|secret|password|passwd|session|auth|access_token|refresh_token|id_token|code)$/i;
    try {
      const url = new URL(String(rawUrl || ""));
      Array.from(url.searchParams.keys()).forEach((key) => {
        if (sensitiveKey.test(key)) {
          url.searchParams.set(key, "REDACTED_PARAM");
        }
      });
      url.hash = "";
      return url.toString();
    } catch (error) {
      return String(rawUrl || "").replace(/([?&#](?:token|key|secret|password|passwd|session|auth|access_token|refresh_token|id_token|code)=)[^&#]+/gi, "$1REDACTED_PARAM");
    }
  }

  async function generateReceipt(blob, metadata = {}) {
    let sha256 = "";
    let sizeBytes = 0;

    if (blob) {
      sizeBytes = blob.size;
      try {
        const buffer = await blob.arrayBuffer();
        sha256 = await calculateSha256(buffer);
      } catch (e) {
        console.error("Failed to compute SHA-256 of export blob:", e);
      }
    }

    const receipt = {
      version: 1,
      generatedAt: new Date().toISOString(),
      extensionName: "Claude Export",
      extensionVersion: (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "1.0.0"),
      platform: String(metadata.platform || "chatgpt"),
      sourceUrl: sanitizeSourceUrl(metadata.sourceUrl || (typeof window !== "undefined" ? window.location.href : "")),
      format: String(metadata.format || "pdf"),
      mode: String(metadata.mode || "conversation"),
      messageCount: Number(metadata.messageCount) || 0,
      redaction: {
        enabled: Boolean(metadata.redaction?.enabled),
        totalMatches: Number(metadata.redaction?.totalMatches) || 0,
        byType: metadata.redaction?.byType || {}
      },
      localGeneration: true,
      usesConversionServer: false,
      file: {
        name: String(metadata.filename || "export"),
        mimeType: blob ? blob.type : "",
        sizeBytes: sizeBytes,
        sha256: sha256
      }
    };

    return receipt;
  }

  globalThis.CHATVAULT_EXPORT_RECEIPT = {
    generateReceipt,
    _test: {
      calculateSha256,
      sanitizeSourceUrl
    }
  };
})();
