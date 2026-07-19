"use strict";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "CHATVAULT_OFFSCREEN_COPY_TEXT" || message.target !== "offscreen") {
    return false;
  }

  try {
    // Offscreen documents cannot receive focus, so navigator.clipboard may
    // resolve without updating the system pasteboard. Chrome's documented
    // offscreen clipboard pattern is a selected textarea plus execCommand.
    const textarea = document.getElementById("clipboard-text");
    textarea.value = String(message.text || "");
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.value = "";
    if (!copied) {
      throw new Error("Browser refused clipboard write.");
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error?.message || "Clipboard write failed."
    });
  }
  return false;
});
