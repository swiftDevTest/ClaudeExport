import katex from '../../vendor/katex/katex.mjs';
import { formatLatexUnicode, sanitizeExportMathMl } from './utils.js';

var KATEX_CSS_URL = new URL('../../vendor/katex/katex.min.css', import.meta.url).href;
var mathAssetCache = new Map();
var katexCssPromise = null;
var MATH_ASSET_CACHE_MAX = 96;
var MATH_ASSET_LOAD_TIMEOUT_MS = 5000;
var MATH_ASSET_MAX_DIMENSION = 4096;
var MATH_ASSET_MAX_PIXELS = 8 * 1024 * 1024;
var MATH_EXPORT_MAX_ASSETS = 96;
var MATH_EXPORT_RENDER_CONCURRENCY = 3;

export function normalizeMathLatex(value) {
  var source = String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
  if (/^\$\$[\s\S]*\$\$$/.test(source)) source = source.slice(2, -2).trim();
  else if (/^\$[^$][\s\S]*\$$/.test(source)) source = source.slice(1, -1).trim();
  else if (/^\\\([\s\S]*\\\)$/.test(source) || /^\\\[[\s\S]*\\\]$/.test(source)) source = source.slice(2, -2).trim();
  return source.slice(0, 8000);
}

export function isDisplayMathBlock(block) {
  return Boolean(block && block.type === 'math' && block.display !== false);
}

export function getMathAssetKey(block, fontSize) {
  var expression = normalizeMathLatex(block && block.text);
  return expression
    ? [expression, isDisplayMathBlock(block) ? 'display' : 'inline', Math.max(12, Math.min(32, Number(fontSize) || 18))].join('|')
    : '';
}

export function mathFallbackText(value) {
  return formatLatexUnicode('\\(' + normalizeMathLatex(value) + '\\)');
}

export function renderMathMl(latex, display) {
  var expression = normalizeMathLatex(latex);
  if (!expression) return '';
  try {
    return String(katex.renderToString(expression, {
      displayMode: display === true,
      output: 'mathml',
      throwOnError: false,
      strict: 'ignore'
    }) || '');
  } catch (error) {
    return '';
  }
}

export function getMathMl(block) {
  var existing = sanitizeExportMathMl(block && block.mathMl);
  return existing || sanitizeExportMathMl(renderMathMl(block && block.text, isDisplayMathBlock(block)));
}

async function loadKatexCss() {
  if (!katexCssPromise) {
    katexCssPromise = fetch(KATEX_CSS_URL).then(function (response) {
      if (!response.ok) throw new Error('KaTeX stylesheet unavailable.');
      return response.text();
    }).then(function (css) {
      return css.replace(/url\((?:['"])?fonts\/([^)'"\s]+)(?:['"])?\)/g, function (_match, name) {
        return 'url("' + new URL('../../vendor/katex/fonts/' + name, import.meta.url).href + '")';
      });
    }).catch(function () { return ''; });
  }
  return katexCssPromise;
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cacheMathAsset(key, value) {
  if (!mathAssetCache.has(key) && mathAssetCache.size >= MATH_ASSET_CACHE_MAX) {
    mathAssetCache.delete(mathAssetCache.keys().next().value);
  }
  mathAssetCache.set(key, value);
}

async function waitForMathFonts() {
  if (!document.fonts || !document.fonts.ready) return;
  await Promise.race([
    document.fonts.ready,
    new Promise(function (resolve) { setTimeout(resolve, 800); })
  ]);
}

// Produces one local PNG asset used by Word, PDF, and image exports. It uses
// the browser's own KaTeX layout, so all generated formats share the same
// fraction, matrix, delimiter, and script geometry.
export async function renderMathPngAsset(block, options) {
  var expression = normalizeMathLatex(block && block.text);
  if (!expression || typeof document === 'undefined' || typeof Image === 'undefined') return null;
  var opts = options || {};
  var fontSize = Math.max(12, Math.min(32, Number(opts.fontSize) || 18));
  var key = getMathAssetKey(block, fontSize);
  if (mathAssetCache.has(key)) return mathAssetCache.get(key);

  var pending = (async function () {
    var css = await loadKatexCss();
    if (!css || !document.body) return null;
    var html = '';
    try {
      html = katex.renderToString(expression, {
        displayMode: isDisplayMathBlock(block),
        output: 'htmlAndMathml',
        throwOnError: false,
        strict: 'ignore'
      });
    } catch (error) {
      return null;
    }

    var host = document.createElement('div');
    var width = 0;
    var height = 0;
    host.style.cssText = 'position:fixed;left:-10000px;top:-10000px;visibility:hidden;display:inline-block;white-space:nowrap;font-size:' + fontSize + 'px;';
    host.innerHTML = '<style>' + css + '</style><span class="cv-math-asset">' + html + '</span>';
    document.body.appendChild(host);
    try {
      await waitForMathFonts();
      var rect = host.getBoundingClientRect();
      width = Math.max(1, Math.ceil(rect.width + 4));
      height = Math.max(1, Math.ceil(rect.height + 4));
    } finally {
      host.remove();
    }
    if (width > MATH_ASSET_MAX_DIMENSION || height > MATH_ASSET_MAX_DIMENSION || width * height > MATH_ASSET_MAX_PIXELS) return null;

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block;padding:2px;font-size:' + fontSize + 'px;white-space:nowrap"><style>' + css + '</style>' + html + '</div></foreignObject></svg>';
    var svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    var image = await new Promise(function (resolve) {
      var settled = false;
      var timeoutId = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, MATH_ASSET_LOAD_TIMEOUT_MS);
      var element = new Image();
      element.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(element);
      };
      element.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(null);
      };
      element.src = svgUrl;
    });
    if (!image) return null;
    var canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    var context = canvas.getContext('2d');
    if (!context) return null;
    context.scale(2, 2);
    context.drawImage(image, 0, 0, width, height);
    var dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/png');
    } finally {
      // The data URL owns the encoded bytes; release the temporary RGBA
      // backing store immediately instead of waiting for a later GC cycle.
      canvas.width = 1;
      canvas.height = 1;
    }
    return { src: dataUrl, width: width, height: height, element: image, latex: expression };
  })().catch(function () {
    // Rendering is enhancement-only. A browser that blocks SVG foreignObject
    // or local font loading still exports the preserved TeX/MathML and uses
    // the readable Unicode fallback in visual formats.
    return null;
  });
  cacheMathAsset(key, pending);
  return pending;
}

// Raster assets are intentionally generated once per export and shared by
// DOCX, PDF and bitmap output. Consumers still retain the original TeX/MathML
// in the document model; this cache is presentation-only.
export async function preloadMathAssets(messages, options, fontSize, includeInline) {
  var assets = new Map();
  var blocks = [];
  (messages || []).forEach(function (message) {
    (message && message.contentBlocks || []).forEach(function (block) {
      if (block && block.type === 'math' && normalizeMathLatex(block.text)) blocks.push(block);
      (includeInline ? (block && block.segments || []) : []).forEach(function (segment) {
        var marks = segment && segment.marks || {};
        if (segment && (segment.math || marks.math) && normalizeMathLatex(segment.text)) {
          blocks.push({ type: 'math', text: segment.text, display: false });
        }
      });
    });
  });
  var unique = new Map();
  blocks.forEach(function (block) {
    var key = getMathAssetKey(block, fontSize);
    if (key && !unique.has(key)) unique.set(key, block);
  });
  var entries = Array.from(unique.entries()).slice(0, MATH_EXPORT_MAX_ASSETS);
  var cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      if (options && options.signal && options.signal.aborted) {
        var error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      var entry = entries[cursor++];
      var asset = await renderMathPngAsset(entry[1], { fontSize: fontSize });
      if (asset) assets.set(entry[0], asset);
    }
  }
  var workers = [];
  for (var index = 0; index < Math.min(MATH_EXPORT_RENDER_CONCURRENCY, entries.length); index += 1) workers.push(worker());
  await Promise.all(workers);
  return assets;
}
