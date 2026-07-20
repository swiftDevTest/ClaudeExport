import { getPlainText, notifyProgress, t, yieldToBrowser } from '../utils.js';

function stripHtmlPresentationFromSegment(segment) {
  if (!segment || typeof segment !== "object") return segment;
  var copy = { ...segment };
  delete copy.htmlStyle;
  delete copy.mathMl;
  return copy;
}

function stripHtmlPresentationFromListItem(item) {
  if (!item || typeof item !== "object") return item;
  var copy = { ...item };
  delete copy.textSource;
  if (Array.isArray(copy.segments)) copy.segments = copy.segments.map(stripHtmlPresentationFromSegment);
  if (Array.isArray(copy.subItems)) copy.subItems = copy.subItems.map(stripHtmlPresentationFromListItem);
  return copy;
}

function stripHtmlPresentationFromBlock(block) {
  if (!block || typeof block !== "object") return block;
  var copy = { ...block };
  delete copy.htmlStyle;
  delete copy.codeStyle;
  delete copy.codeSegments;
  delete copy.textSource;
  if (Array.isArray(copy.segments)) copy.segments = copy.segments.map(stripHtmlPresentationFromSegment);
  if (Array.isArray(copy.items)) copy.items = copy.items.map(stripHtmlPresentationFromListItem);
  return copy;
}

export async function buildJsonBlob(messages, metadata, settings, options) {
  var opts = options || {};
  var signal = opts.signal;
  var data = {
    title: (metadata && metadata.title) || "Untitled Chat",
    platform: (metadata && metadata.platform) || "",
    sourceUrl: (metadata && (metadata.sourceUrl || metadata.url || metadata.source)) || "",
    exportedAt: (metadata && metadata.exportedAt) || new Date().toISOString(),
    messages: []
  };
  notifyProgress(opts, t("export_progress_preparing_json", "Preparing JSON export"), 0.06);

  for (var i = 0; i < messages.length; i++) {
    if (signal && signal.aborted) {
      var err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    var msg = messages[i];
    
    // Filter out user messages if "Export AI Replies Only" is enabled
    if (settings.export_ai_replies_only && msg.role === "user") {
      continue;
    }

    var textContent = getPlainText(msg.contentBlocks || []);
    data.messages.push({
      role: msg.role,
      content: textContent,
      contentBlocks: (msg.contentBlocks || []).map(stripHtmlPresentationFromBlock)
    });

    if (i % 5 === 0 || i === messages.length - 1) {
      notifyProgress(
        opts,
        t("export_progress_building_json", "Building JSON export"),
        0.08 + 0.78 * ((i + 1) / Math.max(1, messages.length))
      );
      await yieldToBrowser();
    }
  }

  var jsonText = JSON.stringify(data, null, 2);
  notifyProgress(opts, t("export_progress_saving", "Saving export"), 0.88);
  var blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
  notifyProgress(opts, t("export_progress_ready", "Export ready"), 1);
  return blob;
}
