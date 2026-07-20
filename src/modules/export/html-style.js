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

// Keep legacy callers presentation-safe. New non-HTML call sites explicitly
// disable capture so an extension reload cannot pair an old content script with
// new modules that silently drop HTML styles.
var htmlStyleCaptureEnabled = true;

export function isExportHtmlStyleCaptureEnabled() {
  return htmlStyleCaptureEnabled;
}

export function withExportHtmlStyleCapture(enabled, callback) {
  var previous = htmlStyleCaptureEnabled;
  htmlStyleCaptureEnabled = enabled === true;
  try {
    return callback();
  } finally {
    htmlStyleCaptureEnabled = previous;
  }
}

export function isTransparentCssColor(value) {
  var text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text || text === "transparent") return true;

  var functionMatch = text.match(/^([a-z]+)\(([\s\S]*)\)$/i);
  if (!functionMatch) return false;
  var name = functionMatch[1];
  var body = functionMatch[2].trim();
  var alpha = "";

  var slashIndex = body.lastIndexOf("/");
  if (slashIndex >= 0) {
    alpha = body.slice(slashIndex + 1).trim();
  } else if ((name === "rgba" || name === "hsla") && body.indexOf(",") >= 0) {
    alpha = body.slice(body.lastIndexOf(",") + 1).trim();
  }

  if (!alpha || !/^(?:0+(?:\.0+)?|0+(?:\.0+)?%)$/.test(alpha)) return false;
  return /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)$/.test(name);
}

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
  if (!htmlStyleCaptureEnabled) return undefined;
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
