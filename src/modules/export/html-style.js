var HTML_STYLE_PROPERTIES = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration-line",
  "text-decoration-color",
  "text-transform",
  "white-space",
  "word-break",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-radius",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left"
];

function isSafeStyleValue(value) {
  var text = String(value == null ? "" : value).trim();
  if (!text || text.length > 240) return false;
  if (/[;{}<>\r\n]/.test(text)) return false;
  return !/(?:url\s*\(|expression\s*\(|javascript\s*:|@import|\\)/i.test(text);
}

export function sanitizeExportHtmlStyle(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  var result = {};
  HTML_STYLE_PROPERTIES.forEach(function (property) {
    var value = input[property];
    if (isSafeStyleValue(value)) result[property] = String(value).trim();
  });
  return Object.keys(result).length ? result : undefined;
}

export function getExportHtmlStyleDifference(input, base) {
  var style = sanitizeExportHtmlStyle(input);
  if (!style) return undefined;
  var baseStyle = sanitizeExportHtmlStyle(base) || {};
  var result = {};
  HTML_STYLE_PROPERTIES.forEach(function (property) {
    if (style[property] && style[property] !== baseStyle[property]) {
      result[property] = style[property];
    }
  });
  return Object.keys(result).length ? result : undefined;
}

export function captureExportHtmlStyle(element) {
  if (!element || element.nodeType !== 1) return undefined;
  var view = element.ownerDocument && element.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return undefined;
  try {
    var computed = view.getComputedStyle(element);
    var result = {};
    HTML_STYLE_PROPERTIES.forEach(function (property) {
      var value = computed.getPropertyValue(property);
      if (value) result[property] = value;
    });
    return sanitizeExportHtmlStyle(result);
  } catch (error) {
    return undefined;
  }
}

export function serializeExportHtmlStyle(input) {
  var style = sanitizeExportHtmlStyle(input);
  if (!style) return "";
  return HTML_STYLE_PROPERTIES.map(function (property) {
    return style[property] ? property + ":" + style[property] : "";
  }).filter(Boolean).join(";");
}
