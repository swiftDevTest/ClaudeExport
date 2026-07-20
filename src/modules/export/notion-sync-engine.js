// Notion renderer and capture helpers.
// The renderer consumes ChatVault's structured Export Document Model. It never
// reparses DOM-visible plain text as Markdown when structured segments exist.

import { createExportDocument } from "./document.js";
import { fetchImageBytes } from "./media.js";
import { sanitizeExportText, sanitizeInlineSegmentText, sanitizeImageAlt, t, mapLimit, canvasToBlob } from "./utils.js";

const GENERIC_IMAGE_ALT_RE = /^(?:image|attached\s+image|uploaded\s+image|upload(?:ed)?\s+file|background\s+image|svg\s+diagram|gemini\s+image)$/i;
const FILENAME_LIKE_RE = /^[^\s\\/]{1,180}\.(?:png|jpe?g|gif|webp|bmp|svg|heic|tiff?|pdf|docx?|xlsx?|zip|txt|csv|json)$/i;

function isGenericOrFilenameImageAlt(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (GENERIC_IMAGE_ALT_RE.test(text)) return true;
  if (FILENAME_LIKE_RE.test(text)) return true;
  return false;
}

export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_LIMITS = Object.freeze({
  textContent: 2000,
  equationExpression: 1000,
  arrayItems: 100,
  requestBytes: 450 * 1024,
  requestBlocks: 900,
  captureImageBytes: 8 * 1024 * 1024,
  freeWorkspaceImageBytes: Math.floor(4.5 * 1024 * 1024),
  mediaCaptureConcurrency: 3
});

const NOTION_COLORS = new Set([
  "default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
  "gray_background", "brown_background", "orange_background", "yellow_background", "green_background",
  "blue_background", "purple_background", "pink_background", "red_background"
]);

const NOTION_CODE_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#", "css",
  "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran", "f#", "gherkin",
  "glsl", "go", "graphql", "groovy", "haskell", "html", "java", "javascript", "json", "julia",
  "kotlin", "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown", "markup",
  "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php", "plain text",
  "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass", "scala",
  "scheme", "scss", "shell", "sql", "swift", "typescript", "vb.net", "verilog", "vhdl",
  "visual basic", "webassembly", "xml", "yaml"
]);

const NOTION_IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
  "image/heic", "image/tiff", "image/bmp"
]);
const NOTION_SOURCE_BLOCK_TYPES = new Set([
  "paragraph", "heading", "code", "list", "blockquote", "quote", "table", "image", "separator"
]);

const CODE_LANGUAGE_ALIASES = Object.freeze({
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "shell",
  zsh: "shell",
  fish: "shell",
  cpp: "c++",
  cxx: "c++",
  cs: "c#",
  yml: "yaml",
  rb: "ruby",
  dockerfile: "docker",
  text: "plain text",
  plaintext: "plain text",
  txt: "plain text"
});

function createWarning(code, detail) {
  return { code, detail: String(detail || "").slice(0, 500) };
}

function pushWarning(warnings, code, detail) {
  if (!Array.isArray(warnings)) return;
  const next = createWarning(code, detail);
  if (!warnings.some((item) => item && item.code === next.code && item.detail === next.detail)) {
    warnings.push(next);
  }
}

function unicodeChunks(value, maxLength) {
  const chars = Array.from(String(value == null ? "" : value));
  if (!chars.length) return [];
  const output = [];
  for (let index = 0; index < chars.length; index += maxLength) {
    output.push(chars.slice(index, index + maxLength).join(""));
  }
  return output;
}

function byteLength(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
  return unescape(encodeURIComponent(text)).length;
}

function normalizeLinkUrl(value, warnings) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length > NOTION_LIMITS.textContent) {
    pushWarning(warnings, "link_url_too_long", raw.slice(0, 80));
    return "";
  }
  try {
    const parsed = new URL(raw);
    if (!/^(https?:|mailto:|tel:)$/.test(parsed.protocol)) {
      pushWarning(warnings, "link_protocol_unsupported", parsed.protocol);
      return "";
    }
    return parsed.toString();
  } catch (error) {
    pushWarning(warnings, "link_url_invalid", raw.slice(0, 80));
    return "";
  }
}

function normalizeNotionColor(value) {
  const color = String(value || "").trim().toLowerCase();
  return NOTION_COLORS.has(color) ? color : "default";
}

const NOTION_COLOR_RGB = Object.freeze({
  gray: [120, 119, 116],
  brown: [159, 107, 83],
  orange: [217, 115, 13],
  yellow: [203, 145, 47],
  green: [68, 131, 97],
  blue: [51, 126, 169],
  purple: [144, 101, 176],
  pink: [193, 76, 138],
  red: [212, 76, 71]
});

function parseCssRgb(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "transparent") return null;
  const named = {
    black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128],
    red: [255, 0, 0], orange: [255, 165, 0], yellow: [255, 255, 0], green: [0, 128, 0],
    blue: [0, 0, 255], purple: [128, 0, 128], pink: [255, 192, 203], brown: [165, 42, 42]
  };
  if (named[raw]) return { rgb: named[raw], alpha: 1 };
  const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let body = hex[1];
    if (body.length === 3 || body.length === 4) body = body.split("").map((char) => char + char).join("");
    if (body.length === 6 || body.length === 8) {
      return {
        rgb: [0, 2, 4].map((index) => parseInt(body.slice(index, index + 2), 16)),
        alpha: body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1
      };
    }
  }
  const rgb = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgb) return null;
  const slashParts = rgb[1].split("/");
  const parts = slashParts[0].split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map((part) => {
    const number = Number.parseFloat(part);
    return part.endsWith("%") ? Math.round(number * 2.55) : Math.round(number);
  });
  if (channels.some((number) => !Number.isFinite(number))) return null;
  const alphaPart = slashParts[1] || parts[3] || "1";
  const alphaNumber = Number.parseFloat(alphaPart);
  const alpha = alphaPart.endsWith("%") ? alphaNumber / 100 : alphaNumber;
  return {
    rgb: channels.map((number) => Math.max(0, Math.min(255, number))),
    alpha: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1
  };
}

function cssColorToNotion(value, background = false) {
  const parsed = parseCssRgb(value);
  if (!parsed || parsed.alpha < 0.15) return "default";
  const [red, green, blue] = parsed.rgb;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (!background && (max < 45 || min > 225) && max - min < 25) return "default";
  if (background && min > 238) return "default";
  let best = "gray";
  let bestDistance = Infinity;
  Object.entries(NOTION_COLOR_RGB).forEach(([name, target]) => {
    const distance = (red - target[0]) ** 2 + (green - target[1]) ** 2 + (blue - target[2]) ** 2;
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  });
  return background ? `${best}_background` : best;
}

function annotationsFromSegment(segment) {
  const marks = segment && segment.marks && typeof segment.marks === "object" ? segment.marks : {};
  const htmlStyle = segment && segment.htmlStyle && typeof segment.htmlStyle === "object" ? segment.htmlStyle : {};
  const htmlBackground = cssColorToNotion(htmlStyle["background-color"], true);
  const htmlForeground = cssColorToNotion(htmlStyle.color, false);
  return {
    bold: Boolean(segment && segment.bold || marks.bold),
    italic: Boolean(segment && segment.italic || marks.italic),
    strikethrough: Boolean(segment && segment.strike || marks.strike),
    underline: Boolean(segment && segment.underline || marks.underline),
    code: Boolean(segment && segment.code || marks.code),
    color: marks.highlight || segment && segment.highlight
      ? "yellow_background"
      : htmlBackground !== "default"
        ? htmlBackground
        : htmlForeground !== "default"
          ? htmlForeground
          : normalizeNotionColor(segment && segment.notionColor)
  };
}

const UNICODE_MATH_REPLACEMENTS = Object.freeze({
  "−": "-", "×": "\\times ", "÷": "\\div ", "·": "\\cdot ", "±": "\\pm ",
  "≤": "\\le ", "≥": "\\ge ", "≠": "\\ne ", "≈": "\\approx ", "∞": "\\infty ",
  "∑": "\\sum ", "∏": "\\prod ", "∫": "\\int ", "∂": "\\partial ", "∇": "\\nabla ",
  "√": "\\sqrt{}", "→": "\\to ", "←": "\\leftarrow ", "↔": "\\leftrightarrow ",
  "∈": "\\in ", "∉": "\\notin ", "⊂": "\\subset ", "⊆": "\\subseteq ",
  "α": "\\alpha ", "β": "\\beta ", "γ": "\\gamma ", "δ": "\\delta ", "ε": "\\epsilon ",
  "θ": "\\theta ", "λ": "\\lambda ", "μ": "\\mu ", "π": "\\pi ", "ρ": "\\rho ",
  "σ": "\\sigma ", "τ": "\\tau ", "φ": "\\phi ", "ω": "\\omega ",
  "Γ": "\\Gamma ", "Δ": "\\Delta ", "Θ": "\\Theta ", "Λ": "\\Lambda ", "Π": "\\Pi ",
  "Σ": "\\Sigma ", "Φ": "\\Phi ", "Ω": "\\Omega "
});

const SUPERSCRIPT_DIGITS = Object.freeze({ "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-" });
const SUBSCRIPT_DIGITS = Object.freeze({ "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "₊": "+", "₋": "-" });

export function normalizeNotionEquationExpression(value) {
  let expression = String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .trim();
  if (/^\$\$[\s\S]*\$\$$/.test(expression)) expression = expression.slice(2, -2).trim();
  else if (/^\$[^$][\s\S]*\$$/.test(expression)) expression = expression.slice(1, -1).trim();
  else if (/^\\\([\s\S]*\\\)$/.test(expression) || /^\\\[[\s\S]*\\\]$/.test(expression)) expression = expression.slice(2, -2).trim();
  expression = expression
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, (text) => `^{${Array.from(text, (char) => SUPERSCRIPT_DIGITS[char] || char).join("")}}`)
    .replace(/[₀₁₂₃₄₅₆₇₈₉₊₋]+/g, (text) => `_{${Array.from(text, (char) => SUBSCRIPT_DIGITS[char] || char).join("")}}`)
    .replace(/[−×÷·±≤≥≠≈∞∑∏∫∂∇√→←↔∈∉⊂⊆αβγδεθλμπρστφωΓΔΘΛΠΣΦΩ]/g, (char) => UNICODE_MATH_REPLACEMENTS[char] || char)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return expression.slice(0, 8000);
}

function isMathSegment(segment) {
  const marks = segment && segment.marks || {};
  return Boolean(segment && segment.math || marks.math);
}

function richTextObjectForChunk(segment, text, warnings) {
  if (isMathSegment(segment)) {
    const expression = normalizeNotionEquationExpression(text);
    if (Array.from(expression).length <= NOTION_LIMITS.equationExpression) {
      return { type: "equation", equation: { expression } };
    }
    pushWarning(warnings, "equation_too_long", expression.slice(0, 80));
    return {
      type: "text",
      text: { content: "[LaTeX exceeds Notion limit] " + expression.slice(0, NOTION_LIMITS.textContent - 32) },
      annotations: { ...annotationsFromSegment(segment), code: true }
    };
  }

  const href = normalizeLinkUrl(segment && (segment.href || segment.url), warnings);
  const textObject = { content: text };
  if (href) textObject.link = { url: href };
  return {
    type: "text",
    text: textObject,
    annotations: annotationsFromSegment(segment)
  };
}

function normalizeSegments(segments, fallbackText) {
  const source = Array.isArray(segments) && segments.length
    ? segments
    : [{ text: String(fallbackText == null ? "" : fallbackText) }];
  return source.map((segment) => {
    if (typeof segment === "string") return { text: segment };
    return segment && typeof segment === "object" ? segment : null;
  }).filter(Boolean);
}

/**
 * Convert structured inline segments into one or more Notion rich_text arrays.
 * Each returned array respects both per-item and per-array Notion limits.
 */
export function encodeInlineSegments(segments, fallbackText, warnings = []) {
  const items = [];
  normalizeSegments(segments, fallbackText).forEach((segment) => {
    const marks = segment && segment.marks || {};
    if (segment && (segment.superscript || segment.subscript) || marks.superscript || marks.subscript) {
      pushWarning(warnings, "inline_style_unsupported", "Notion does not support superscript or subscript rich-text annotations; text was preserved.");
    }
    const text = isMathSegment(segment)
      ? normalizeNotionEquationExpression(segment.text)
      : sanitizeInlineSegmentText(segment.text == null ? "" : segment.text);
    if (!text) return;
    if (isMathSegment(segment)) {
      if (Array.from(text.trim()).length <= NOTION_LIMITS.equationExpression) {
        items.push(richTextObjectForChunk(segment, text, warnings));
      } else {
        pushWarning(warnings, "equation_too_long", text.slice(0, 80));
        unicodeChunks(text, NOTION_LIMITS.textContent).forEach((chunk) => {
          items.push({
            type: "text",
            text: { content: chunk },
            annotations: { ...annotationsFromSegment(segment), code: true }
          });
        });
      }
      return;
    }
    unicodeChunks(text, NOTION_LIMITS.textContent).forEach((chunk) => {
      items.push(richTextObjectForChunk(segment, chunk, warnings));
    });
  });

  if (!items.length) return [[]];
  const pages = [];
  for (let index = 0; index < items.length; index += NOTION_LIMITS.arrayItems) {
    pages.push(items.slice(index, index + NOTION_LIMITS.arrayItems));
  }
  return pages;
}

export function splitTextToRichTextArray(text, annotations = {}) {
  return unicodeChunks(String(text == null ? "" : text), NOTION_LIMITS.textContent).map((content) => ({
    type: "text",
    text: { content },
    annotations: {
      bold: Boolean(annotations.bold),
      italic: Boolean(annotations.italic),
      strikethrough: Boolean(annotations.strikethrough || annotations.strike),
      underline: Boolean(annotations.underline),
      code: Boolean(annotations.code),
      color: normalizeNotionColor(annotations.color)
    }
  }));
}

/**
 * Compatibility fallback for sources that truly only provide Markdown text.
 * The production structured path does not use this function.
 */
export function parseTextToRichTextElements(text, warnings = []) {
  const value = String(text == null ? "" : text);
  if (!value) return [];
  const output = [];
  const token = /(\$\$[^$]+\$\$|\\\[[\s\S]*?\\\]|\\\([^\n]*?\\\)|\*\*[^*\n]+\*\*|(?<!\w)__[^_\n]+__(?!\w)|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|mailto:|tel:)[^\s)]+\)|\$[^$\n]+\$|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\w_])_[^_\n]+_(?![\w_]))/g;
  let cursor = 0;
  let match;
  while ((match = token.exec(value))) {
    if (match.index > cursor) output.push(...splitTextToRichTextArray(value.slice(cursor, match.index)));
    const raw = match[0];
    if (raw.startsWith("**") || raw.startsWith("__")) {
      output.push(...splitTextToRichTextArray(raw.slice(2, -2), { bold: true }));
    } else if (raw.startsWith("~~")) {
      output.push(...splitTextToRichTextArray(raw.slice(2, -2), { strikethrough: true }));
    } else if (raw.startsWith("`")) {
      output.push(...splitTextToRichTextArray(raw.slice(1, -1), { code: true }));
    } else if (raw.startsWith("[")) {
      const link = raw.match(/^\[([^\]]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)$/);
      if (link) {
        const url = normalizeLinkUrl(link[2], warnings);
        splitTextToRichTextArray(link[1]).forEach((item) => {
          if (url) item.text.link = { url };
          output.push(item);
        });
      }
    } else if (raw.startsWith("$") || raw.startsWith("\\(") || raw.startsWith("\\[")) {
      const expression = normalizeNotionEquationExpression(raw);
      if (Array.from(expression).length <= NOTION_LIMITS.equationExpression) {
        output.push(richTextObjectForChunk({ text: expression, marks: { math: true } }, expression, warnings));
      } else {
        pushWarning(warnings, "equation_too_long", expression.slice(0, 80));
        output.push(...splitTextToRichTextArray(expression, { code: true }));
      }
    } else {
      output.push(...splitTextToRichTextArray(raw.slice(1, -1), { italic: true }));
    }
    cursor = match.index + raw.length;
  }
  if (cursor < value.length) output.push(...splitTextToRichTextArray(value.slice(cursor)));
  return output;
}

export function mapLanguageToNotion(language) {
  const value = String(language || "").toLowerCase().trim();
  const normalized = CODE_LANGUAGE_ALIASES[value] || value;
  return NOTION_CODE_LANGUAGES.has(normalized) ? normalized : "plain text";
}

function createNode(block, children = [], extra = {}) {
  return { block, children, ...extra };
}

function inlineRichTextPages(segments, text, warnings) {
  const fallbackItems = !Array.isArray(segments) || !segments.length
    ? parseTextToRichTextElements(text, warnings)
    : null;
  return fallbackItems
    ? Array.from({ length: Math.max(1, Math.ceil(fallbackItems.length / NOTION_LIMITS.arrayItems)) }, (_, index) => (
        fallbackItems.slice(index * NOTION_LIMITS.arrayItems, (index + 1) * NOTION_LIMITS.arrayItems)
      ))
    : encodeInlineSegments(segments, text, warnings);
}

function richTextBlocks(type, segments, text, warnings, extra = {}) {
  const pages = inlineRichTextPages(segments, text, warnings);
  return pages.map((richText, index) => {
    const currentType = index === 0 ? type : "paragraph";
    return createNode({
      object: "block",
      type: currentType,
      [currentType]: { rich_text: richText, ...extra }
    });
  });
}

function equationNodesFromParagraph(block, warnings) {
  const meaningful = normalizeSegments(block && block.segments, block && block.text)
    .filter((segment) => String(segment && segment.text || "").trim());
  if (meaningful.length !== 1 || !isMathSegment(meaningful[0])) return null;
  const expression = normalizeNotionEquationExpression(meaningful[0].text);
  if (!expression) return null;
  if (Array.from(expression).length > NOTION_LIMITS.equationExpression) {
    pushWarning(warnings, "equation_too_long", "Block equation exceeded Notion's expression limit and was preserved as LaTeX code.");
    return codeNodes({ text: expression, language: "latex" }, warnings);
  }
  return [createNode({
    object: "block",
    type: "equation",
    equation: { expression }
  })];
}

function splitCodeAtLineBoundaries(text, maxChars = 120000) {
  const value = String(text == null ? "" : text);
  if (Array.from(value).length <= maxChars) return [value];
  const lines = value.split("\n");
  const chunks = [];
  let current = "";
  lines.forEach((line) => {
    const candidate = current ? current + "\n" + line : line;
    if (Array.from(candidate).length > maxChars && current) {
      chunks.push(current);
      current = line;
      return;
    }
    if (Array.from(line).length > maxChars) {
      if (current) chunks.push(current);
      const hardChunks = unicodeChunks(line, maxChars);
      chunks.push(...hardChunks.slice(0, -1));
      current = hardChunks[hardChunks.length - 1] || "";
      return;
    }
    current = candidate;
  });
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

function codeNodes(block, warnings) {
  const language = mapLanguageToNotion(block && block.language);
  if (block && block.language && language === "plain text" && !/^(?:text|txt|plaintext|plain text)$/i.test(String(block.language))) {
    pushWarning(warnings, "unsupported_code_language", String(block.language).slice(0, 80));
  }
  const text = String(block && block.text || "");
  const capturedSegments = Array.isArray(block && block.codeSegments) ? block.codeSegments : [];
  const segments = capturedSegments.length && capturedSegments.map((segment) => String(segment && segment.text || "")).join("") === text
    ? capturedSegments
    : [{ text, htmlStyle: block && block.codeStyle }];
  const richTextItems = [];
  segments.forEach((segment) => {
    const segmentText = String(segment && segment.text || "");
    if (!segmentText) return;
    const htmlStyle = segment && segment.htmlStyle || block && block.codeStyle;
    const color = annotationsFromSegment({ htmlStyle }).color;
    splitTextToRichTextArray(segmentText, { color }).forEach((item) => {
      const previous = richTextItems[richTextItems.length - 1];
      if (previous && previous.annotations && previous.annotations.color === item.annotations.color &&
          Array.from(previous.text.content).length + Array.from(item.text.content).length <= NOTION_LIMITS.textContent) {
        previous.text.content += item.text.content;
      } else {
        richTextItems.push(item);
      }
    });
  });
  const pages = [];
  for (let index = 0; index < richTextItems.length; index += NOTION_LIMITS.arrayItems) {
    pages.push(richTextItems.slice(index, index + NOTION_LIMITS.arrayItems));
  }
  if (!pages.length) pages.push([]);
  if (pages.length > 1) pushWarning(warnings, "code_block_split", String(pages.length));
  return pages.map((richText) => createNode({
    object: "block",
    type: "code",
    code: {
      rich_text: richText,
      language
    }
  }));
}

function cellRichText(value, warnings) {
  const pages = inlineRichTextPages(null, String(value == null ? "" : value), warnings);
  if (pages.length > 1) {
    pushWarning(warnings, "table_cell_truncated", String(value).slice(0, 80));
    return pages[0];
  }
  return pages[0];
}

function tableNodes(block, warnings) {
  const headers = Array.isArray(block && block.headers) ? block.headers : [];
  const rows = Array.isArray(block && block.rows) ? block.rows : [];
  const sourceWidth = Math.max(
    headers.length,
    ...rows.map((row) => Array.isArray(row) ? row.length : 0)
  );
  if (!sourceWidth) return [];
  const allRows = headers.length ? [headers, ...rows] : rows;
  const hasOversizedCell = allRows.some((row) => (Array.isArray(row) ? row : []).some((cell) => {
    return Array.from(String(cell == null ? "" : cell)).length > NOTION_LIMITS.textContent;
  }));
  if (sourceWidth > NOTION_LIMITS.arrayItems || hasOversizedCell) {
    pushWarning(
      warnings,
      sourceWidth > NOTION_LIMITS.arrayItems ? "table_columns_unsupported" : "table_cell_too_long",
      "The table exceeded native Notion table limits and was preserved as plain-text code."
    );
    const plainText = allRows.map((row) => (Array.isArray(row) ? row : []).map((cell) => {
      return String(cell == null ? "" : cell).replace(/\t/g, "    ");
    }).join("\t")).join("\n");
    return codeNodes({ text: plainText, language: "plain text" }, warnings);
  }
  const width = sourceWidth;

  const normalizedRows = [];
  if (headers.length) normalizedRows.push(headers);
  rows.forEach((row) => normalizedRows.push(Array.isArray(row) ? row : []));
  const rowNodes = normalizedRows.map((row) => {
    const cells = Array.from({ length: width }, (_, index) => cellRichText(row[index] || "", warnings));
    if (row.length !== width) pushWarning(warnings, "table_row_normalized", `${row.length}/${width}`);
    return createNode({ object: "block", type: "table_row", table_row: { cells } });
  });

  return [createNode({
    object: "block",
    type: "table",
    table: {
      table_width: width,
      has_column_header: headers.length > 0,
      has_row_header: false
    }
  }, rowNodes, { bootstrapChildren: 1 })];
}

function listItemNodes(items, ordered, warnings) {
  const type = ordered ? "numbered_list_item" : "bulleted_list_item";
  return (Array.isArray(items) ? items : []).map((item) => {
    const richPages = inlineRichTextPages(item && item.segments, item && item.text || "", warnings);
    const nestedOrdered = item && item.subItemsOrdered != null ? item.subItemsOrdered : ordered;
    const children = listItemNodes(item && item.subItems, Boolean(nestedOrdered), warnings);
    if (richPages.length > 1) {
      richPages.slice(1).forEach((page) => {
        children.unshift(createNode({ object: "block", type: "paragraph", paragraph: { rich_text: page } }));
      });
    }
    return createNode({
      object: "block",
      type,
      [type]: { rich_text: richPages[0] || [] }
    }, children);
  });
}

function imageNode(block, mediaBySource, warnings) {
  const src = String(block && (block.src || block.url || block.text) || "");
  const media = mediaBySource.get(src);
  if (!media || media.error) {
    pushWarning(warnings, "image_unavailable", media && media.error || src.slice(0, 120));
    return createNode({
      object: "block",
      type: "callout",
      callout: {
        rich_text: splitTextToRichTextArray(`[Image unavailable] ${sanitizeExportText(block && block.alt || "Image")}`),
        icon: { emoji: "⚠️" },
        color: "yellow_background"
      }
    });
  }
  // 仅在 alt 是有意义描述时才设置 caption，避免文件名 / 通用占位文字出现在图片下方
  const sanitizedAlt = sanitizeImageAlt(block && block.alt);
  const caption = sanitizedAlt && !isGenericOrFilenameImageAlt(sanitizedAlt)
    ? splitTextToRichTextArray(sanitizedAlt)
    : [];
  return createNode({
    object: "block",
    type: "image",
    image: {
      caption,
      type: "file_upload",
      file_upload: { id: "__CHATVAULT_MEDIA_PENDING__" }
    }
  }, [], { mediaRef: media.id });
}

function contentBlocksToNodes(contentBlocks, mediaBySource, warnings) {
  const output = [];
  (Array.isArray(contentBlocks) ? contentBlocks : []).forEach((block) => {
    if (!block || !block.type) return;
    switch (block.type) {
      case "paragraph":
        {
          const equations = equationNodesFromParagraph(block, warnings);
          if (equations) output.push(...equations);
          else output.push(...richTextBlocks("paragraph", block.segments, block.text, warnings));
        }
        break;
      case "heading": {
        const level = Math.max(1, Math.min(3, Number(block.level) || 1));
        output.push(...richTextBlocks(`heading_${level}`, block.segments, block.text, warnings));
        break;
      }
      case "blockquote":
      case "quote":
        output.push(...richTextBlocks("quote", block.segments, block.text, warnings));
        break;
      case "code":
        output.push(...codeNodes(block, warnings));
        break;
      case "separator":
        output.push(createNode({ object: "block", type: "divider", divider: {} }));
        break;
      case "image":
        output.push(imageNode(block, mediaBySource, warnings));
        break;
      case "table": {
        output.push(...tableNodes(block, warnings));
        break;
      }
      case "list":
        output.push(...listItemNodes(block.items, Boolean(block.ordered), warnings));
        break;
      default:
        pushWarning(warnings, "unsupported_block", block.type);
        output.push(createNode({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: splitTextToRichTextArray(`[Unsupported content: ${block.type}] ${block.text || ""}`) }
        }));
    }
  });
  return output;
}

function thinkingToNodes(message, mediaBySource, warnings) {
  if (Array.isArray(message && message.thinkingBlocks) && message.thinkingBlocks.length) {
    return contentBlocksToNodes(message.thinkingBlocks, mediaBySource, warnings);
  }
  const value = sanitizeExportText(message && message.thinking || "");
  if (!value) return [];
  return splitCodeAtLineBoundaries(value, 120000).map((chunk) => createNode({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: splitTextToRichTextArray(chunk) }
  }));
}

function getPlatformFromUrl(url) {
  const value = String(url || "");
  if (/chatgpt\.com|chat\.openai\.com/.test(value)) return "ChatGPT";
  if (/claude\.ai/.test(value)) return "Claude";
  if (/gemini\.google\.com/.test(value)) return "Gemini";
  return "AI";
}

function getPlatformDisplayName(platform, sourceUrl) {
  const value = String(platform || "").trim().toLowerCase();
  if (value === "chatgpt" || value === "openai" || value === "chatgpt.com") return "ChatGPT";
  if (value === "claude" || value === "claude.ai") return "Claude";
  if (value === "gemini" || value === "gemini.google.com") return "Gemini";
  return getPlatformFromUrl(sourceUrl);
}

function formatLocalizedExportDate(date) {
  const d = new Date(date);
  if (!date || isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function createMetadataCallout(options, warnings) {
  const exportedAt = options && options.exportedAt;
  const sourceUrl = options && options.sourceUrl;
  const platformLabel = options && options.platformLabel || "AI";
  const richText = [];

  const timeStr = formatLocalizedExportDate(exportedAt);
  if (timeStr) {
    splitTextToRichTextArray(t("notion_metadata_exported", "Exported"), { bold: true })
      .forEach((item) => richText.push(item));
    splitTextToRichTextArray(`: ${timeStr}`).forEach((item) => richText.push(item));
  }

  const hasFromLine = Boolean(platformLabel && platformLabel !== "AI" || sourceUrl);
  if (hasFromLine) {
    if (richText.length) {
      splitTextToRichTextArray("\n").forEach((item) => richText.push(item));
    }
    splitTextToRichTextArray(t("notion_metadata_from", "From"), { bold: true })
      .forEach((item) => richText.push(item));
    splitTextToRichTextArray(": ").forEach((item) => richText.push(item));
    const url = normalizeLinkUrl(sourceUrl, warnings);
    if (url) {
      richText.push({
        type: "text",
        text: { content: platformLabel, link: { url } },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "blue" }
      });
    } else {
      splitTextToRichTextArray(platformLabel).forEach((item) => richText.push(item));
    }
  }

  if (!richText.length) return null;
  return createNode({
    object: "block",
    type: "callout",
    callout: {
      rich_text: richText,
      icon: { emoji: "📌" },
      color: "gray_background"
    }
  }, [], { metadataCallout: true });
}

function messagesToTree(messages, options, mediaBySource, warnings) {
  const settings = options && options.settings || {};
  const platform = options && options.platform || getPlatformFromUrl(options && options.sourceUrl);
  const platformLabel = getPlatformDisplayName(platform, options && options.sourceUrl);
  const filtered = (Array.isArray(messages) ? messages : []).filter((message) => {
    return !settings.export_ai_replies_only || message && message.role !== "user";
  });
  const nodes = [];

  const metadataNode = createMetadataCallout({
    exportedAt: options && options.exportedAt,
    sourceUrl: options && options.sourceUrl,
    platformLabel
  }, warnings);
  if (metadataNode) nodes.push(metadataNode);

  filtered.forEach((message, index) => {
    if (index > 0) nodes.push(createNode({ object: "block", type: "divider", divider: {} }));

    const thinking = thinkingToNodes(message, mediaBySource, warnings);
    if (thinking.length) {
      nodes.push(createNode({
        object: "block",
        type: "toggle",
        toggle: {
          rich_text: splitTextToRichTextArray(t("notion_thinking_process", "Thinking Process (思考过程)")),
          color: "purple_background"
        }
      }, thinking));
    }

    const content = Array.isArray(message && message.contentBlocks) && message.contentBlocks.length
      ? contentBlocksToNodes(message.contentBlocks, mediaBySource, warnings)
      : richTextBlocks("paragraph", null, message && message.content || "", warnings);

    if (settings.show_role_labels === false) {
      nodes.push(...content);
      return;
    }
    const isUser = message && message.role === "user";
    nodes.push(createNode({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: splitTextToRichTextArray(isUser ? t("export_role_user", "You Asked") : platformLabel, { bold: true }),
        color: isUser ? "gray_background" : "default"
      }
    }));
    nodes.push(...content);
  });
  return nodes;
}

function blockWithBootstrapChildren(node) {
  const block = JSON.parse(JSON.stringify(node.block));
  if (node.bootstrapChildren && node.children.length) {
    const childBlocks = node.children.slice(0, node.bootstrapChildren).map((child) => child.block);
    block[block.type].children = childBlocks;
  }
  return block;
}

function batchEntries(entries) {
  const batches = [];
  let current = [];
  let currentBytes = byteLength({ children: [] });
  let currentBlocks = 0;
  entries.forEach((entry) => {
    const entryBytes = byteLength(entry.block) + 2;
    const entryBlocks = 1 + countNestedBlocks(entry.block);
    const exceeds = current.length >= NOTION_LIMITS.arrayItems ||
      currentBytes + entryBytes > NOTION_LIMITS.requestBytes ||
      currentBlocks + entryBlocks > NOTION_LIMITS.requestBlocks;
    if (exceeds && current.length) {
      batches.push(current);
      current = [];
      currentBytes = byteLength({ children: [] });
      currentBlocks = 0;
    }
    current.push(entry);
    currentBytes += entryBytes;
    currentBlocks += entryBlocks;
  });
  if (current.length) batches.push(current);
  return batches;
}

function countNestedBlocks(value) {
  if (!value || typeof value !== "object") return 0;
  let count = 0;
  Object.entries(value).forEach(([key, child]) => {
    if (key === "children" && Array.isArray(child)) count += child.length;
    if (Array.isArray(child)) child.forEach((item) => { count += countNestedBlocks(item); });
    else if (child && typeof child === "object") count += countNestedBlocks(child);
  });
  return count;
}

function createOperations(tree) {
  let localCounter = 0;
  let operationCounter = 0;
  const operations = [];

  function visit(parentRef, nodes) {
    const entries = nodes.map((node) => {
      const localId = `block_${String(++localCounter).padStart(6, "0")}`;
      node.localId = localId;
      return {
        localId,
        block: blockWithBootstrapChildren(node),
        mediaRef: node.mediaRef || null,
        metadataCallout: Boolean(node.metadataCallout)
      };
    });
    batchEntries(entries).forEach((batch) => {
      operations.push({
        id: `operation_${String(++operationCounter).padStart(6, "0")}`,
        type: "append_children",
        parentRef,
        entries: batch
      });
    });
    nodes.forEach((node) => {
      const skipped = Number(node.bootstrapChildren || 0);
      const remaining = node.children.slice(skipped);
      if (remaining.length) visit(node.localId, remaining);
    });
  }

  visit("page", tree);
  return operations;
}

export function createNotionRenderPlan(input = {}) {
  const warnings = Array.isArray(input.warnings) ? input.warnings.slice() : [];
  const media = Array.isArray(input.media) ? input.media : [];
  const mediaBySource = new Map(media.map((item) => [String(item && item.sourceUrl || ""), item]));
  const sourceMessages = (Array.isArray(input.messages) ? input.messages : []).map((message) => {
    if (!message || typeof message !== "object") return message;
    if (Array.isArray(message.contentBlocks) && message.contentBlocks.length) return message;
    return {
      ...message,
      contentBlocks: [{ type: "paragraph", text: String(message.content || "") }]
    };
  });
  sourceMessages.forEach((message) => {
    const blocks = [
      ...(Array.isArray(message && message.contentBlocks) ? message.contentBlocks : []),
      ...(Array.isArray(message && message.thinkingBlocks) ? message.thinkingBlocks : [])
    ];
    blocks.forEach((block) => {
      if (block && block.type && !NOTION_SOURCE_BLOCK_TYPES.has(block.type)) {
        pushWarning(warnings, "unsupported_source_block", String(block.type).slice(0, 80));
      }
    });
  });
  const document = createExportDocument({
    platform: input.platform,
    scope: input.settings && input.settings.export_ai_replies_only ? "ai_only" : "conversation",
    messages: sourceMessages,
    settings: input.settings || {},
    metadata: {
      title: input.title,
      sourceUrl: input.sourceUrl,
      exportedAt: new Date(input.exportedAt || Date.now())
    }
  });
  const normalizedMessagesByIndex = new Map(document.messages.map((message, index) => [
    Number.isFinite(Number(message.index)) ? Number(message.index) : index,
    message
  ]));
  const notionMessages = sourceMessages.map((sourceMessage, index) => {
    const sourceIndex = Number.isFinite(Number(sourceMessage && sourceMessage.index))
      ? Number(sourceMessage.index)
      : index;
    const normalized = normalizedMessagesByIndex.get(sourceIndex);
    const hasThinking = Boolean(
      sourceMessage && String(sourceMessage.thinking || "").trim() ||
      Array.isArray(sourceMessage && sourceMessage.thinkingBlocks) && sourceMessage.thinkingBlocks.length
    );
    if (!normalized && !hasThinking) return null;
    return {
      ...(normalized || {
        role: sourceMessage && sourceMessage.role === "user" ? "user" : "assistant",
        index: sourceIndex,
        contentBlocks: []
      }),
      thinking: sourceMessage && sourceMessage.thinking,
      thinkingBlocks: sourceMessage && sourceMessage.thinkingBlocks
    };
  }).filter(Boolean);
  const tree = messagesToTree(notionMessages, {
    settings: document.settings,
    platform: input.platform,
    sourceUrl: input.sourceUrl,
    exportedAt: document.metadata.exportedAt
  }, mediaBySource, warnings);
  const resolvedPlatform = input.platform || getPlatformFromUrl(input.sourceUrl);
  const pageTitle = document.settings.show_conversation_title === false
    ? `${String(resolvedPlatform || "AI").replace(/^./, (character) => character.toUpperCase())} Conversation`
    : document.metadata.title;
  return {
    version: 2,
    rendererVersion: "notion-block-v2",
    title: pageTitle,
    sourceUrl: document.metadata.sourceUrl,
    platform: resolvedPlatform,
    model: input.model || "",
    exportedAt: document.metadata.exportedAt.toISOString(),
    operations: createOperations(tree),
    warnings,
    partial: warnings.some((warning) => /unavailable|unsupported|truncated|too_long|partial|failed|fallback/.test(warning.code))
  };
}

function imageSourcesFromMessages(messages) {
  const sources = [];
  (Array.isArray(messages) ? messages : []).forEach((message) => {
    const blocks = [
      ...(Array.isArray(message && message.contentBlocks) ? message.contentBlocks : []),
      ...(Array.isArray(message && message.thinkingBlocks) ? message.thinkingBlocks : [])
    ];
    blocks.forEach((block) => {
      if (!block || block.type !== "image") return;
      const sourceUrl = String(block.src || block.url || block.text || "");
      if (sourceUrl && !sources.some((item) => item.sourceUrl === sourceUrl)) {
        sources.push({ sourceUrl, alt: sanitizeExportText(block.alt || "Image") });
      }
    });
  });
  return sources;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function extensionForMime(mimeType) {
  const normalized = String(mimeType || "image/png").toLowerCase();
  if (normalized.includes("jpeg")) return "jpg";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("svg")) return "svg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("heic")) return "heic";
  if (normalized.includes("tiff")) return "tiff";
  if (normalized.includes("bmp")) return "bmp";
  return "png";
}

async function compressNotionStaticImage(result, signal) {
  const bytes = result && result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result && result.bytes || 0);
  const mimeType = String(result && result.mimeType || "").toLowerCase();
  const requiresConversion = mimeType === "image/bmp";
  if (bytes.byteLength <= NOTION_LIMITS.freeWorkspaceImageBytes && !requiresConversion) return { bytes, mimeType };
  if (!["image/png", "image/jpeg", "image/webp", "image/bmp"].includes(mimeType)) return { bytes, mimeType };
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return { bytes, mimeType };
  if (signal && signal.aborted) throw new DOMException("Notion media capture cancelled.", "AbortError");

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    const width = Math.max(1, Number(bitmap.width || result.width || 1));
    const height = Math.max(1, Number(bitmap.height || result.height || 1));
    const maxDimensionScale = Math.min(1, 4096 / Math.max(width, height));
    const scales = [maxDimensionScale, maxDimensionScale * 0.85, maxDimensionScale * 0.7, maxDimensionScale * 0.55]
      .filter((scale, index, all) => scale > 0.1 && all.indexOf(scale) === index);
    let best = null;
    for (const scale of scales) {
      if (signal && signal.aborted) throw new DOMException("Notion media capture cancelled.", "AbortError");
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) break;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.72, 0.58]) {
        const blob = await canvasToBlob(canvas, "image/webp", quality, 8000);
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= NOTION_LIMITS.freeWorkspaceImageBytes) break;
      }
      if (best && best.size <= NOTION_LIMITS.freeWorkspaceImageBytes) break;
    }
    if (best && best.size < bytes.byteLength) {
      return { bytes: new Uint8Array(await best.arrayBuffer()), mimeType: "image/webp", compressed: true };
    }
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
  return { bytes, mimeType };
}

export async function captureNotionMedia(messages, options = {}) {
  const fetcher = options.fetchImageBytes || fetchImageBytes;
  const sources = imageSourcesFromMessages(messages);
  let completed = 0;
  const captured = await mapLimit(sources, NOTION_LIMITS.mediaCaptureConcurrency, async (source, index) => {
    const id = `media_${String(index + 1).padStart(6, "0")}`;
    try {
      const result = await fetcher(source.sourceUrl, { signal: options.signal });
      if (!result || !result.bytes || !result.mimeType) throw new Error("Image bytes are unavailable.");
      if (result.bytes.byteLength > NOTION_LIMITS.captureImageBytes) throw new Error("Image exceeds the 8 MiB capture limit.");
      if (!NOTION_IMAGE_MIME_TYPES.has(String(result.mimeType).toLowerCase())) {
        throw new Error(`Notion does not support this image type: ${result.mimeType}`);
      }
      const prepared = await compressNotionStaticImage(result, options.signal);
      const base64 = bytesToBase64(prepared.bytes);
      return { media: {
        id,
        sourceUrl: source.sourceUrl,
        alt: source.alt,
        filename: `${id}.${extensionForMime(prepared.mimeType)}`,
        mimeType: prepared.mimeType,
        byteLength: prepared.bytes.byteLength,
        contentHash: await sha256Hex(base64),
        base64,
        compressed: Boolean(prepared.compressed)
      }, warning: null };
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      const detail = error && error.message || "Image capture failed.";
      return {
        media: { id, sourceUrl: source.sourceUrl, alt: source.alt, error: detail },
        warning: createWarning("image_unavailable", detail)
      };
    } finally {
      completed += 1;
      if (typeof options.onProgress === "function") {
        options.onProgress({ completed, total: sources.length });
      }
    }
  });
  return {
    media: captured.map((item) => item.media),
    warnings: captured.map((item) => item.warning).filter(Boolean)
  };
}

function canonicalConversationId(sourceUrl) {
  try {
    const url = new URL(String(sourceUrl || ""));
    const patterns = [
      /\/c\/([^/?#]+)/,
      /\/chat\/([^/?#]+)/,
      /\/(?:app|gem\/[^/?#]+)\/([^/?#]+)/
    ];
    for (const pattern of patterns) {
      const match = url.pathname.match(pattern);
      if (match && match[1]) return decodeURIComponent(match[1]);
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isKnownDraftRoute =
      /(?:chatgpt\.com|chat\.openai\.com)$/i.test(url.hostname) && ["/", "/c", "/new"].includes(path) ||
      /claude\.ai$/i.test(url.hostname) && ["/", "/new"].includes(path) ||
      /gemini\.google\.com$/i.test(url.hostname) && ["/", "/app"].includes(path);
    return isKnownDraftRoute ? "" : url.origin + path;
  } catch (error) {
    return "";
  }
}

function stableMessageIdentityText(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const message = source.find((item) => item && item.role === "user") || source[0] || {};
  const parts = [];
  (Array.isArray(message.contentBlocks) ? message.contentBlocks : []).forEach((block) => {
    if (!block || typeof block !== "object") return;
    if (block.text) parts.push(sanitizeExportText(block.text));
    if (block.type === "list") {
      const visitItems = (items) => (Array.isArray(items) ? items : []).forEach((item) => {
        if (item && item.text) parts.push(sanitizeExportText(item.text));
        visitItems(item && item.subItems);
      });
      visitItems(block.items);
    }
    if (block.type === "table") {
      parts.push(...(block.headers || []).map(sanitizeExportText));
      (block.rows || []).forEach((row) => parts.push(...(row || []).map(sanitizeExportText)));
    }
    if (block.type === "image" && block.alt) parts.push(sanitizeExportText(block.alt));
  });
  if (!parts.length && message.content) parts.push(sanitizeExportText(message.content));
  return parts.filter(Boolean).join("\n").slice(0, 8000) || "untitled-conversation";
}

async function sha256Hex(value) {
  if (globalThis.crypto && globalThis.crypto.subtle && typeof TextEncoder === "function") {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createSyncRunId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `run_${globalThis.crypto.randomUUID()}`;
  }
  return `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export async function prepareNotionJob(input = {}) {
  const platform = String(input.platform || getPlatformFromUrl(input.sourceUrl)).toLowerCase();
  const capture = await captureNotionMedia(input.messages, {
    fetchImageBytes: input.fetchImageBytes,
    signal: input.signal,
    onProgress: input.onMediaProgress
  });
  const canonicalId = canonicalConversationId(input.sourceUrl);
  const sourceId = canonicalId || `draft_${(await sha256Hex(
    `${platform}\n${stableMessageIdentityText(input.messages)}`
  )).slice(0, 32)}`;
  const sourceKey = await sha256Hex(`v1\n${platform}\n${sourceId}`);
  const ownerKey = await sha256Hex(`v1\n${input.userId || "guest"}\n${input.connectionId || "manual"}`);
  const renderPlan = createNotionRenderPlan({
    ...input,
    platform,
    media: capture.media,
    warnings: [...(Array.isArray(input.warnings) ? input.warnings : []), ...capture.warnings]
  });
  const sourceRevision = await sha256Hex(JSON.stringify({
    rendererVersion: renderPlan.rendererVersion,
    operations: renderPlan.operations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      parentRef: operation.parentRef,
      entries: operation.entries.filter((entry) => !entry.metadataCallout)
    })),
    media: capture.media.map((item) => ({
      id: item.id,
      sourceUrl: item.sourceUrl,
      byteLength: item.byteLength || 0,
      contentHash: item.contentHash || "",
      error: item.error || ""
    }))
  }));
  if (!renderPlan.operations.length) {
    throw new Error("No supported conversation content is available for Notion sync.");
  }
  const alwaysCreate = input.alwaysCreate !== false;
  return {
    version: 1,
    syncRunId: String(input.syncRunId || createSyncRunId()),
    alwaysCreate,
    sourceId,
    sourceKey,
    ownerKey,
    sourceRevision,
    title: renderPlan.title,
    sourceUrl: renderPlan.sourceUrl,
    platform,
    model: input.model || "",
    settings: input.settings || {},
    policy: alwaysCreate ? "create" : (["skip", "replace", "update"].includes(input.policy) ? input.policy : "replace"),
    replaceConfirmedAt: alwaysCreate ? 0 : Number(input.replaceConfirmedAt || 0),
    destination: {
      connectionId: input.connectionId || "manual",
      databaseId: input.databaseId || "",
      dataSourceId: input.dataSourceId || input.databaseId || ""
    },
    renderPlan,
    media: capture.media,
    createdAt: Date.now()
  };
}

function attachChildrenForCompatibility(block, children) {
  const copy = JSON.parse(JSON.stringify(block));
  if (children && children.length) copy[copy.type].children = children;
  return copy;
}

/** Compatibility export used by unit tests and diagnostics. */
export async function convertMessagesToBlocks(messages, _imageUploader, platform = "AI") {
  const plan = createNotionRenderPlan({ messages, platform });
  const byParent = new Map();
  plan.operations.forEach((operation) => byParent.set(operation.parentRef, operation.entries));
  function materialize(parentRef) {
    return (byParent.get(parentRef) || []).map((entry) => {
      const children = materialize(entry.localId);
      return attachChildrenForCompatibility(entry.block, children);
    });
  }
  return materialize("page");
}

async function directFetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (error) {}
  if (!response.ok) {
    const requestError = new Error(payload.message || text || `Notion request failed: ${response.status}`);
    requestError.status = response.status;
    requestError.code = payload.code || "";
    throw requestError;
  }
  return payload;
}

/**
 * Direct writer retained for Node integration tests. Browser production uses
 * the durable Background queue and never passes a Notion token to this module.
 */
export async function syncToNotion(options = {}) {
  if (!(typeof process !== "undefined" && process.versions && process.versions.node)) {
    throw new Error("Browser Notion writes must be enqueued through the Background worker.");
  }
  const plan = createNotionRenderPlan(options);
  const token = options.token;
  const dataSourceId = options.dataSourceId || options.databaseId;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json"
  };
  const schema = await directFetchJson(`https://api.notion.com/v1/data_sources/${dataSourceId}`, { headers });
  const titleEntry = Object.entries(schema.properties || {}).find(([, property]) => property && property.type === "title");
  if (!titleEntry) throw new Error("The selected Notion data source has no title property.");
  const page = await directFetchJson("https://api.notion.com/v1/pages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: { [titleEntry[0]]: { title: [{ text: { content: plan.title || "Untitled Conversation" } }] } }
    })
  });
  const refs = { page: page.id };
  for (const operation of plan.operations) {
    const parentId = refs[operation.parentRef];
    const payload = await directFetchJson(`https://api.notion.com/v1/blocks/${parentId}/children`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ children: operation.entries.map((entry) => entry.block) })
    });
    (payload.results || []).forEach((block, index) => {
      refs[operation.entries[index].localId] = block.id;
    });
  }
  return page.url;
}
