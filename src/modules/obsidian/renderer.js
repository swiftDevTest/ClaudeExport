// Obsidian-only Markdown renderer. This module deliberately does not depend on
// Notion or the generic Markdown export builder.

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanText(value) {
  return String(value == null ? "" : value).replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
}

function yamlString(value) {
  return `"${cleanText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function escapeInline(value) {
  return cleanText(value).replace(/([\\`*_[\]<>])/g, "\\$1");
}

function escapeRenderedLinkText(value) {
  return cleanText(value).replace(/\]/g, "\\]");
}

function escapeLinkDestination(value) {
  return encodeURI(cleanText(value).trim()).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function portableLinkDestination(value) {
  const href = cleanText(value).trim();
  if (/^(?:https?:|mailto:|tel:)/i.test(href)) return href;
  return "";
}

function wrapMarkdown(text, marker) {
  const value = String(text || "");
  const leading = value.match(/^\s+/)?.[0] || "";
  const trailing = value.match(/\s+$/)?.[0] || "";
  const core = value.slice(leading.length, value.length - trailing.length);
  return core ? `${leading}${marker}${core}${marker}${trailing}` : value;
}

function renderInlineCode(value) {
  const text = cleanText(value);
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((part) => part.length));
  const fence = "`".repeat(Math.max(1, longest + 1));
  const padded = /^`|`$|^\s|\s$/.test(text) ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function findClosingMarker(source, marker, start) {
  let index = start;
  while (index < source.length) {
    index = source.indexOf(marker, index);
    if (index < 0) return -1;
    if (source[index - 1] !== "\\") return index;
    index += marker.length;
  }
  return -1;
}

function renderMarkdownSource(value, depth = 0) {
  const source = cleanText(value);
  if (!source || depth > 6) return escapeInline(source);
  let output = "";
  let index = 0;

  while (index < source.length) {
    if (source[index] === "\\" && /[\\`*_[\]~=$]/.test(source[index + 1] || "")) {
      output += `\\${source[index + 1]}`;
      index += 2;
      continue;
    }

    const codeRun = source.slice(index).match(/^`+/)?.[0] || "";
    if (codeRun) {
      const end = findClosingMarker(source, codeRun, index + codeRun.length);
      if (end >= 0) {
        output += renderInlineCode(source.slice(index + codeRun.length, end));
        index = end + codeRun.length;
        continue;
      }
    }

    const link = source.slice(index).match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|tel:[^\s)]+|sandbox:\/mnt\/data\/[^\s)]+)\)/i);
    if (link) {
      output += `[${escapeRenderedLinkText(renderMarkdownSource(link[1], depth + 1))}](${escapeLinkDestination(link[2])})`;
      index += link[0].length;
      continue;
    }

    const math = source.slice(index).match(/^\$([^$\n]+)\$/);
    const looksLikeCurrencyRange = Boolean(math && /^\s*\d/.test(math[1]) && /\d/.test(source[index + math[0].length] || ""));
    if (math && !looksLikeCurrencyRange) {
      output += `$${math[1].trim()}$`;
      index += math[0].length;
      continue;
    }

    const pairedMarkers = [
      ["**", "**"],
      ["__", "**"],
      ["~~", "~~"],
      ["==", "=="],
      ["*", "*"],
      ["_", "*"]
    ];
    let matched = false;
    for (const [sourceMarker, outputMarker] of pairedMarkers) {
      if (!source.startsWith(sourceMarker, index)) continue;
      if (sourceMarker.includes("_")) {
        const beforeOpen = source[index - 1] || "";
        const afterOpen = source[index + sourceMarker.length] || "";
        if (/[\p{L}\p{N}]/u.test(beforeOpen) && /[\p{L}\p{N}]/u.test(afterOpen)) continue;
      }
      const end = findClosingMarker(source, sourceMarker, index + sourceMarker.length);
      const inner = end >= 0 ? source.slice(index + sourceMarker.length, end) : "";
      if (!inner || /^\s|\s$/.test(inner)) continue;
      if (sourceMarker.includes("_")) {
        const beforeClose = source[end - 1] || "";
        const afterClose = source[end + sourceMarker.length] || "";
        if (/[\p{L}\p{N}]/u.test(beforeClose) && /[\p{L}\p{N}]/u.test(afterClose)) continue;
      }
      output += `${outputMarker}${renderMarkdownSource(inner, depth + 1)}${outputMarker}`;
      index = end + sourceMarker.length;
      matched = true;
      break;
    }
    if (matched) continue;

    const next = source.slice(index + 1).search(/[\\`*_[\]~=$]/);
    const end = next < 0 ? source.length : index + 1 + next;
    output += escapeInline(source.slice(index, end));
    index = end;
  }
  return output;
}

function stripRedundantWrapper(value, marks) {
  let text = cleanText(value);
  const wrappers = [];
  if (marks.bold) wrappers.push("**", "__");
  if (marks.strike) wrappers.push("~~");
  if (marks.highlight) wrappers.push("==");
  if (marks.italic) wrappers.push("*", "_");
  for (const marker of wrappers) {
    if (text.startsWith(marker) && text.endsWith(marker) && text.length > marker.length * 2) {
      text = text.slice(marker.length, -marker.length);
      break;
    }
  }
  return text;
}

function renderSegments(block, sourceUrl) {
  const segments = Array.isArray(block && block.segments) ? block.segments : [];
  if (!segments.length) return renderMarkdownSource(block && block.text || "");
  return segments.map((segment) => {
    if (!segment) return "";
    const marks = segment.marks && typeof segment.marks === "object" ? segment.marks : {};
    const isMath = Boolean(segment.math || marks.math);
    const isCode = Boolean(segment.code || marks.code);
    const normalizedMarks = {
      bold: Boolean(segment.bold || marks.bold),
      italic: Boolean(segment.italic || marks.italic),
      strike: Boolean(segment.strike || marks.strike),
      highlight: Boolean(segment.highlight || marks.highlight)
    };
    let text = cleanText(segment.text || "");
    if (isMath) {
      text = `$${text.replace(/^\$+|\$+$/g, "").trim()}$`;
    } else if (isCode) {
      text = renderInlineCode(text);
    } else {
      text = renderMarkdownSource(stripRedundantWrapper(text, normalizedMarks));
    }
    if (!isMath && !isCode) {
      if (normalizedMarks.strike) text = wrapMarkdown(text, "~~");
      if (normalizedMarks.bold) text = wrapMarkdown(text, "**");
      if (normalizedMarks.italic) text = wrapMarkdown(text, "*");
      if (normalizedMarks.highlight) text = `==${text}==`;
      if (segment.underline || marks.underline) text = `<u>${text}</u>`;
      if (segment.superscript || marks.superscript) text = `<sup>${text}</sup>`;
      if (segment.subscript || marks.subscript) text = `<sub>${text}</sub>`;
    }
    const href = portableLinkDestination(segment.href || marks.href || "");
    if (href) {
      text = `[${escapeRenderedLinkText(text)}](${escapeLinkDestination(href)})`;
    }
    return text;
  }).join("");
}

function isStandaloneMathBlock(block) {
  const segments = Array.isArray(block?.segments) ? block.segments.filter((segment) => cleanText(segment?.text || "").trim()) : [];
  return segments.length === 1 && Boolean(segments[0]?.math || segments[0]?.marks?.math);
}

function codeFenceFor(value) {
  const longest = Math.max(0, ...(cleanText(value).match(/`+/g) || []).map((part) => part.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function renderCode(block) {
  const code = cleanText(block && (block.code || block.text) || "").replace(/\n+$/, "");
  const language = cleanText(block && (block.language || block.lang) || "").trim().toLowerCase().replace(/[^a-z0-9_+#.-]/g, "");
  const fence = codeFenceFor(code);
  return `${fence}${language}\n${code}\n${fence}`;
}

function tableCell(value) {
  return cleanText(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>").trim() || " ";
}

function renderTable(block) {
  const headers = Array.isArray(block && block.headers) ? block.headers : [];
  const rows = Array.isArray(block && block.rows) ? block.rows : [];
  const width = Math.max(headers.length, ...rows.map((row) => Array.isArray(row) ? row.length : 0), 1);
  const normalizedHeaders = Array.from({ length: width }, (_, index) => tableCell(headers[index] || `Column ${index + 1}`));
  const lines = [
    `| ${normalizedHeaders.join(" | ")} |`,
    `| ${normalizedHeaders.map(() => "---").join(" | ")} |`
  ];
  rows.forEach((row) => {
    const cells = Array.from({ length: width }, (_, index) => tableCell(Array.isArray(row) ? row[index] : ""));
    lines.push(`| ${cells.join(" | ")} |`);
  });
  return lines.join("\n");
}

function renderListItems(items, ordered, depth, sourceUrl) {
  const source = Array.isArray(items) ? items : [];
  const lines = [];
  source.forEach((item, index) => {
    const prefix = ordered ? `${index + 1}.` : "-";
    const text = item && Array.isArray(item.segments) ? renderSegments(item, sourceUrl) : renderMarkdownSource(item && item.text || item || "");
    const taskMarker = item && typeof item.checked === "boolean" ? `[${item.checked ? "x" : " "}] ` : "";
    lines.push(`${"  ".repeat(depth)}${prefix} ${taskMarker}${text || " "}`);
    const children = item && (item.subItems || item.children);
    const childOrdered = item && typeof item.childrenOrdered === "boolean" ? item.childrenOrdered : ordered;
    if (Array.isArray(children) && children.length) lines.push(renderListItems(children, childOrdered, depth + 1, sourceUrl));
  });
  return lines.join("\n");
}

function normalizeImageKey(block, messageIndex, blockIndex) {
  const src = cleanText(block && (block.src || block.url || block.sourceUrl) || "").trim();
  return src || `image:${messageIndex}:${blockIndex}`;
}

function renderBlock(block, context) {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "heading": {
      const level = Math.max(2, Math.min(6, Number(block.level || 1) + 1));
      return `${"#".repeat(level)} ${renderSegments(block, context.metadata.sourceUrl).trim()}`;
    }
    case "paragraph": {
      if (isStandaloneMathBlock(block)) {
        const expression = cleanText(block.segments[0].text || "").replace(/^\$+|\$+$/g, "").trim();
        return `$$\n${expression}\n$$`;
      }
      return renderSegments(block, context.metadata.sourceUrl);
    }
    case "math": {
      const expression = cleanText(block.expression || block.text || "").replace(/^\$+|\$+$/g, "").trim();
      return expression ? `$$\n${expression}\n$$` : "";
    }
    case "code": return renderCode(block);
    case "list": return renderListItems(block.items, Boolean(block.ordered || block.style === "ordered" || block.listType === "ordered"), 0, context.metadata.sourceUrl);
    case "table": return renderTable(block);
    case "blockquote":
    case "quote": return renderSegments(block, context.metadata.sourceUrl).split("\n").map((line) => `> ${line}`).join("\n");
    case "separator": return "---";
    case "image": {
      const key = normalizeImageKey(block, context.messageIndex, context.blockIndex);
      const media = context.mediaBySource.get(key);
      const alt = cleanText(block.alt || block.title || "Conversation image").replace(/[\[\]]/g, "").slice(0, 180);
      if (media && media.linkPath) return `![${alt}](<${media.linkPath}>)`;
      return `> [!warning] Image unavailable${alt ? `: ${alt}` : ""}`;
    }
    default: return renderMarkdownSource(block.text || "");
  }
}

function renderMessage(message, messageIndex, input) {
  const settings = input.settings || {};
  const lines = [];
  if (settings.show_role_labels !== false && message.role !== "system") {
    const platformLabel = input.metadata.platformLabel || input.metadata.platform || "Assistant";
    const label = message.role === "user" ? input.metadata.userLabel || "You Asked" : platformLabel;
    lines.push(`## ${label}`, "");
  }
  const blocks = Array.isArray(message.contentBlocks) ? message.contentBlocks : [];
  blocks.forEach((block, blockIndex) => {
    const rendered = renderBlock(block, { ...input, messageIndex, blockIndex });
    if (rendered.trim()) lines.push(rendered, "");
  });
  if (!blocks.length && message.content) lines.push(renderMarkdownSource(message.content), "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function collectObsidianImages(messages) {
  const seen = new Set();
  const images = [];
  (Array.isArray(messages) ? messages : []).forEach((message, messageIndex) => {
    (Array.isArray(message && message.contentBlocks) ? message.contentBlocks : []).forEach((block, blockIndex) => {
      if (!block || block.type !== "image") return;
      const key = normalizeImageKey(block, messageIndex, blockIndex);
      if (seen.has(key)) return;
      seen.add(key);
      images.push({
        key,
        sourceUrl: cleanText(block.src || block.url || block.sourceUrl || "").trim(),
        alt: cleanText(block.alt || block.title || "Conversation image").slice(0, 180),
        messageIndex,
        blockIndex
      });
    });
  });
  return images;
}

export function renderObsidianMarkdown(input = {}) {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const settings = input.settings && typeof input.settings === "object" ? input.settings : {};
  const mediaBySource = input.mediaBySource instanceof Map ? input.mediaBySource : new Map();
  const platform = cleanText(metadata.platform || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "unknown";
  const platformTag = cleanText(metadata.platformLabel || platform.charAt(0).toUpperCase() + platform.slice(1)).trim() || "AI";
  const exportedAt = formatExportedAt(metadata.exportedAt);
  const frontmatter = [
    "---",
    `From Source: ${yamlString(metadata.sourceUrl || "")}`,
    `Exported Time: ${yamlString(exportedAt)}`,
    "tags:",
    "  - AI-Chat-Exporter",
    `  - ${yamlString(platformTag)}`,
    `chatvault_id: ${yamlString(input.sourceKey || input.runId || "")}`,
    "---",
    ""
  ];

  const body = [];
  if (settings.show_conversation_title !== false && metadata.title) body.push(`# ${escapeInline(metadata.title)}`, "");
  (Array.isArray(input.messages) ? input.messages : []).forEach((message, index) => {
    const rendered = renderMessage(message, index, { metadata, settings, mediaBySource });
    if (rendered) body.push(rendered, "");
  });
  return [...frontmatter, ...body].join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

export const OBSIDIAN_RENDERER_VERSION = "obsidian-markdown-v1";

function formatExportedAt(value) {
  let date = null;
  if (value instanceof Date) {
    date = value;
  } else if (value) {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) {
    if (typeof value === "string" && value.trim()) return cleanText(value).trim();
    date = new Date();
  }
  const part = (number, size = 2) => String(Math.abs(number)).padStart(size, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}
