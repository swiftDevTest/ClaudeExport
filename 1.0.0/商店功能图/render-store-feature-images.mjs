import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeStoreCopy } from "./store-copy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(process.env.STORE_ASSET_ROOT || path.join(__dirname, "../.."));
const outDir = process.env.STORE_ASSET_OUT || __dirname;
const sourceDir = path.join(outDir, "source-screenshots");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const supportedLocales = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ja", "ko", "pt-BR"];
const locale = process.env.STORE_ASSET_LOCALE || "en";

if (!supportedLocales.includes(locale)) {
  throw new Error(`Unsupported store asset locale: ${locale}`);
}

const localeMessageDirs = {
  en: "en",
  "zh-CN": "zh_CN",
  "zh-TW": "zh_TW",
  de: "de",
  es: "es",
  fr: "fr",
  ja: "ja",
  ko: "ko",
  "pt-BR": "pt_BR",
};

// Preserve the current English-at-root convention. Other locales live in
// explicit store-language folders beside the English assets.
const outputDir = locale === "en" ? outDir : path.join(outDir, locale);

const platformThemes = {
  chatgpt: {
    platformLabel: "ChatGPT",
    ink: "#101828",
    muted: "#596779",
    accent: "#10a37f",
    accentDark: "#047857",
    accentDeep: "#063b32",
    washStart: "#f4fffb",
    washMid: "#ebf8e8",
    washEnd: "#ffffff",
    line: "#bfe5d6",
    ribbon: "#c9efe1",
    grid: "#0f766e",
    shadow: "#064e3b",
    formatWash: "#ecfdf5",
    formatLine: "#a7f3d0",
    warmWash: "#fff7ed",
    warmLine: "#fed7aa",
    coolWash: "#eff6ff",
    coolLine: "#bfdbfe",
  },
  gemini: {
    platformLabel: "Gemini",
    ink: "#111827",
    muted: "#5f6b7c",
    accent: "#2563eb",
    accentDark: "#1d4ed8",
    accentDeep: "#172554",
    washStart: "#f7faff",
    washMid: "#edf4ff",
    washEnd: "#ffffff",
    line: "#bfccff",
    ribbon: "#dbeafe",
    grid: "#2563eb",
    shadow: "#1e3a8a",
    formatWash: "#eff6ff",
    formatLine: "#bfdbfe",
    warmWash: "#f5f3ff",
    warmLine: "#ddd6fe",
    coolWash: "#ecfeff",
    coolLine: "#a5f3fc",
  },
  claude: {
    platformLabel: "Claude",
    ink: "#231814",
    muted: "#6b625c",
    accent: "#c96442",
    accentDark: "#8a3b23",
    accentDeep: "#3b241b",
    washStart: "#fffaf5",
    washMid: "#fff1e8",
    washEnd: "#ffffff",
    line: "#e8c5b0",
    ribbon: "#ffe2cc",
    grid: "#c96442",
    shadow: "#4d2d22",
    formatWash: "#fff7ed",
    formatLine: "#fed7aa",
    warmWash: "#fef2f2",
    warmLine: "#fecaca",
    coolWash: "#f7fee7",
    coolLine: "#d9f99d",
  },
};

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function firstMatch(source, pattern, fallback = "") {
  const match = source.match(pattern);
  return match ? match[1] : fallback;
}

function detectProject() {
  const configSource = readText(path.join(rootDir, "src", "product-config.js"));
  const productName = firstMatch(configSource, /productName:\s*"([^"]+)"/, "ChatGPT Export");
  const shortName = firstMatch(configSource, /shortName:\s*"([^"]+)"/, productName);
  const productSlug = firstMatch(configSource, /productSlug:\s*"([^"]+)"/, "chatgpt-export");
  const platformList = firstMatch(configSource, /supportedPlatforms:\s*\[([^\]]+)\]/, "");
  const platform = ["chatgpt", "gemini", "claude"].find((name) => {
    return productSlug.includes(name) || platformList.includes(`"${name}"`);
  }) || "chatgpt";

  const messages = readJson(path.join(rootDir, "_locales", localeMessageDirs[locale], "messages.json"));
  const extensionName = messages.extensionName?.message || productName;
  const storeName = extensionName.split(/\s*(?:-|:|：)\s*/)[0].trim();
  const displayName = storeName;

  return {
    productName,
    shortName,
    productSlug,
    platform,
    displayName,
    storeName,
    theme: platformThemes[platform],
  };
}

const project = detectProject();
const colors = project.theme;

const files = {
  logo: path.join(rootDir, "images", "store-icon-128.png"),
  platform: path.join(rootDir, "images", `platform-${project.platform}.svg`),
  platformPng: path.join(rootDir, "images", `platform-${project.platform}.png`),
  plugin: path.join(sourceDir, "plugin-popup.png"),
  batch: path.join(sourceDir, "batch-export.png"),
  settings: path.join(sourceDir, "settings.png"),
  select: path.join(sourceDir, "select-messages.png"),
};

function dataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".svg" ? "image/svg+xml" : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

const imageData = Object.fromEntries(
  Object.entries(files)
    .filter(([, file]) => fs.existsSync(file))
    .map(([key, file]) => [key, dataUri(file)]),
);

if (!imageData.plugin || !imageData.batch || !imageData.settings || !imageData.select) {
  throw new Error(`Missing source screenshots in ${sourceDir}`);
}

let clipCounter = 0;

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function estimateTextWidth(value, size) {
  return Array.from(String(value)).reduce((sum, char) => {
    return sum + (char.charCodeAt(0) > 255 ? size : size * 0.58);
  }, 0);
}

function fitFontSize(value, preferred, maxWidth, minimum) {
  const estimated = estimateTextWidth(value, preferred);
  if (estimated <= maxWidth) return preferred;
  return Math.max(minimum, Math.floor(preferred * (maxWidth / estimated)));
}

function defs() {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${colors.washStart}"/>
        <stop offset="58%" stop-color="${colors.washMid}"/>
        <stop offset="100%" stop-color="${colors.washEnd}"/>
      </linearGradient>
      <linearGradient id="darkPanel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${colors.accentDeep}"/>
        <stop offset="100%" stop-color="${colors.accentDark}"/>
      </linearGradient>
      <linearGradient id="accentPanel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${colors.accent}"/>
        <stop offset="100%" stop-color="${colors.accentDark}"/>
      </linearGradient>
      <linearGradient id="softPanel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.94"/>
        <stop offset="100%" stop-color="${colors.washMid}" stop-opacity="0.58"/>
      </linearGradient>
      <filter id="deepShadow" x="-18%" y="-18%" width="136%" height="142%">
        <feDropShadow dx="0" dy="28" stdDeviation="24" flood-color="${colors.shadow}" flood-opacity="0.18"/>
      </filter>
      <filter id="softShadow" x="-18%" y="-18%" width="136%" height="142%">
        <feDropShadow dx="0" dy="16" stdDeviation="14" flood-color="${colors.shadow}" flood-opacity="0.14"/>
      </filter>
      <filter id="tightShadow" x="-14%" y="-14%" width="128%" height="132%">
        <feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="${colors.shadow}" flood-opacity="0.12"/>
      </filter>
      <pattern id="fineGrid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M40 0H0V40" fill="none" stroke="${colors.grid}" stroke-width="1" opacity="0.055"/>
      </pattern>
    </defs>
    <style>
      svg {
        font-family: "PingFang SC", "Avenir Next", "Helvetica Neue", Arial, "Noto Sans CJK SC", sans-serif;
        text-rendering: geometricPrecision;
      }
      text {
        font-family: "PingFang SC", "Avenir Next", "Helvetica Neue", Arial, "Noto Sans CJK SC", sans-serif;
      }
    </style>
  `;
}

const t = makeStoreCopy(locale, colors.platformLabel);

function base(width, height, variant = 0) {
  const sweepY = Math.round(height * 0.2);
  const lowerY = Math.round(height * 0.77);
  const bandA = variant % 2 ? colors.ribbon : colors.line;
  return `
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#fineGrid)" opacity="0.5"/>
    <path d="M-${width * 0.08} ${sweepY} C ${width * 0.16} ${sweepY - 56} ${width * 0.36} ${sweepY + 46} ${width * 0.58} ${sweepY - 10} C ${width * 0.8} ${sweepY - 66} ${width * 0.92} ${sweepY - 26} ${width * 1.08} ${sweepY + 4}" fill="none" stroke="${bandA}" stroke-width="${height > 400 ? 42 : 24}" opacity="0.34"/>
    <path d="M-${width * 0.05} ${lowerY} C ${width * 0.22} ${lowerY - 60} ${width * 0.36} ${lowerY + 70} ${width * 0.58} ${lowerY - 22} C ${width * 0.8} ${lowerY - 110} ${width * 0.92} ${lowerY - 38} ${width * 1.08} ${lowerY - 74}" fill="none" stroke="${colors.ribbon}" stroke-width="${height > 400 ? 72 : 36}" opacity="0.28"/>
    <path d="M${width * 0.68} -40h${width * 0.46}l-${width * 0.14} ${height + 100}h-${width * 0.5}z" fill="#ffffff" opacity="${variant % 2 ? 0.44 : 0.3}"/>
    <path d="M${width * 0.03} ${height * 0.9}h${width * 0.36}" stroke="${colors.line}" stroke-width="1" opacity="0.62"/>
  `;
}

function brandMark(x, y, size = 52, withName = false) {
  const mark = imageData.logo
    ? `<image href="${imageData.logo}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`
    : `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#accentPanel)"/>`;
  return `
    <g>
      ${mark}
      ${withName ? `<text x="${x + size + 16}" y="${y + size * 0.66}" font-size="${Math.round(size * 0.42)}" font-weight="840" fill="${colors.ink}">${esc(project.displayName)}</text>` : ""}
    </g>
  `;
}

function platformSeal(x, y, size = 54) {
  const img = imageData.platform || imageData.platformPng;
  if (!img) {
    return `
      <g transform="translate(${x} ${y})" filter="url(#tightShadow)">
        <rect width="${size}" height="${size}" rx="${Math.round(size * 0.28)}" fill="#ffffff" stroke="${colors.line}"/>
        <text x="${size / 2}" y="${size * 0.62}" font-size="${Math.round(size * 0.25)}" font-weight="860" fill="${colors.accentDark}" text-anchor="middle">${esc(colors.platformLabel.slice(0, 2))}</text>
      </g>
    `;
  }
  return `
    <g transform="translate(${x} ${y})" filter="url(#tightShadow)">
      <rect width="${size}" height="${size}" rx="${Math.round(size * 0.28)}" fill="#ffffff" stroke="${colors.line}"/>
      <image href="${img}" x="${size * 0.22}" y="${size * 0.22}" width="${size * 0.56}" height="${size * 0.56}" preserveAspectRatio="xMidYMid meet"/>
    </g>
  `;
}

function copyBlock({ label, title, body, bullets = [] }, x, y, options = {}) {
  const titleLines = Array.isArray(title) ? title : [title];
  const bodyLines = Array.isArray(body) ? body : [body];
  const maxTextWidth = options.maxTextWidth || 620;
  const preferredTitleSize = options.titleSize || 58;
  const preferredBodySize = options.bodySize || 24;
  const preferredBulletSize = options.bulletSize || 24;
  const titleSize = Math.min(...titleLines.map((line) => fitFontSize(line, preferredTitleSize, maxTextWidth, options.minTitleSize || 38)));
  const bodySize = Math.min(...bodyLines.map((line) => fitFontSize(line, preferredBodySize, maxTextWidth, options.minBodySize || 17)));
  const bulletSize = bullets.length
    ? Math.min(...bullets.map((line) => fitFontSize(line, preferredBulletSize, maxTextWidth - 34, options.minBulletSize || 17)))
    : preferredBulletSize;
  const labelHeight = options.labelHeight || 42;
  const labelWidth = Math.min(options.labelMaxWidth || 390, Math.max(150, estimateTextWidth(label, 19) + 48));
  const titleY = y + labelHeight + 86;
  const titleLineHeight = titleSize + 8;
  const bodyY = titleY + (titleLines.length - 1) * titleLineHeight + titleSize + 34;
  const bodyLineHeight = bodySize + 13;
  const bulletY = bodyY + (bodyLines.length - 1) * bodyLineHeight + bodySize + 48;
  return `
    <g>
      <rect x="${x}" y="${y}" width="${labelWidth}" height="${labelHeight}" rx="${labelHeight / 2}" fill="#ffffff" stroke="${colors.line}" filter="url(#tightShadow)"/>
      <text x="${x + 22}" y="${y + 27}" font-size="19" font-weight="820" fill="${colors.accentDark}">${esc(label)}</text>
      ${titleLines.map((line, index) => `
        <text x="${x}" y="${titleY + index * titleLineHeight}" font-size="${titleSize}" font-weight="870" fill="${colors.ink}">${esc(line)}</text>
      `).join("")}
      ${bodyLines.map((line, index) => `
        <text x="${x}" y="${bodyY + index * bodyLineHeight}" font-size="${bodySize}" font-weight="640" fill="${colors.muted}">${esc(line)}</text>
      `).join("")}
      ${bullets.map((item, index) => `
        <g transform="translate(${x} ${bulletY + index * 48})">
          <circle cx="11" cy="-8" r="10" fill="${colors.formatWash}" stroke="${colors.accent}" stroke-width="2"/>
          <path d="M6 -9l4 4 8-10" fill="none" stroke="${colors.accentDark}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="34" y="0" font-size="${bulletSize}" font-weight="720" fill="${colors.ink}">${esc(item)}</text>
        </g>
      `).join("")}
    </g>
  `;
}

function pill(x, y, label, tone = "light") {
  const w = Math.max(86, estimateTextWidth(label, 16) + 34);
  const isDark = tone === "dark";
  return `
    <g>
      <rect x="${x}" y="${y}" width="${w}" height="40" rx="20" fill="${isDark ? "url(#darkPanel)" : "#ffffff"}" stroke="${isDark ? colors.accent : colors.line}"/>
      <text x="${x + w / 2}" y="${y + 26}" font-size="16" font-weight="840" fill="${isDark ? "#ffffff" : colors.accentDark}" text-anchor="middle">${esc(label)}</text>
    </g>
  `;
}

function formatPills(x, y, labels, darkFirst = true) {
  let currentX = x;
  return labels.map((label, index) => {
    const w = Math.max(86, estimateTextWidth(label, 16) + 34);
    const node = pill(currentX, y, label, darkFirst && index === 0 ? "dark" : "light");
    currentX += w + 18;
    return node;
  }).join("");
}

function screenshotFrame({ img, x, y, w, h, rx = 24, fit = "slice", border = "#ffffff", rotate = 0, opacity = 1 }) {
  const id = `clip-${clipCounter++}`;
  return `
    <g transform="translate(${x} ${y}) rotate(${rotate} ${w / 2} ${h / 2})" filter="url(#deepShadow)" opacity="${opacity}">
      <defs>
        <clipPath id="${id}">
          <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}"/>
        </clipPath>
      </defs>
      <rect x="-10" y="-10" width="${w + 20}" height="${h + 20}" rx="${rx + 10}" fill="#ffffff" opacity="0.82"/>
      <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" fill="#ffffff" stroke="${border}" stroke-width="2"/>
      <image href="${img}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid ${fit}" clip-path="url(#${id})"/>
      <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" fill="none" stroke="#ffffff" stroke-opacity="0.88" stroke-width="2"/>
    </g>
  `;
}

function batchInterface(x, y, w, h) {
  const p = colors.platformLabel;
  const rows = [
    "Research notes",
    "Project handoff",
    "Technical plan",
    "Study guide",
    "Code review",
    "Weekly summary",
  ];
  const rowStart = 206;
  const rowGap = 52;

  return `
    <g transform="translate(${x} ${y})" filter="url(#deepShadow)">
      <rect x="0" y="0" width="${w}" height="${h}" rx="30" fill="#ffffff" stroke="${colors.line}" stroke-width="2"/>
      <text x="28" y="43" font-size="24" font-weight="860" fill="${colors.ink}">Batch Export ${esc(p)} Chats</text>
      <path d="M${w - 38} 25l14 14m0-14l-14 14" stroke="${colors.muted}" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M0 66h${w}" stroke="${colors.line}" stroke-width="1.5"/>

      <g transform="translate(24 82)">
        <rect x="0" y="0" width="${w - 48}" height="54" rx="18" fill="${colors.formatWash}" stroke="${colors.line}"/>
        <rect x="4" y="4" width="190" height="46" rx="15" fill="#ffffff" stroke="${colors.line}" filter="url(#tightShadow)"/>
        <text x="99" y="34" font-size="16" font-weight="850" fill="${colors.ink}" text-anchor="middle">Export files</text>
        <text x="300" y="34" font-size="16" font-weight="780" fill="${colors.muted}" text-anchor="middle">Sync to Notion</text>
        <text x="500" y="34" font-size="16" font-weight="780" fill="${colors.muted}" text-anchor="middle">Sync to Obsidian</text>
      </g>

      <rect x="24" y="152" width="${w - 48}" height="42" rx="14" fill="#f8fafc" stroke="#e2e8f0"/>
      <text x="44" y="179" font-size="16" font-weight="640" fill="#94a3b8">Search conversation titles…</text>

      ${rows.map((title, index) => {
        const rowY = rowStart + index * rowGap;
        return `
          <g transform="translate(24 ${rowY})">
            <rect x="0" y="0" width="${w - 48}" height="42" rx="12" fill="${index === 1 ? colors.formatWash : "#fbfdff"}" stroke="#e2e8f0"/>
            <rect x="16" y="11" width="20" height="20" rx="5" fill="#ffffff" stroke="${index === 1 ? colors.accent : "#cbd5e1"}" stroke-width="2"/>
            <text x="52" y="27" font-size="17" font-weight="740" fill="${colors.ink}">${esc(title)}</text>
            <text x="${w - 78}" y="27" font-size="13" font-weight="650" fill="#94a3b8" text-anchor="end">${esc(project.platform)} · Conversation history</text>
          </g>
        `;
      }).join("")}

      <path d="M0 526h${w}" stroke="${colors.line}" stroke-width="1.5"/>
      <g transform="translate(24 542)">
        ${["PDF", "Word", "Markdown", "HTML", "Image", "Text"].map((format, index) => {
          const tileW = 88;
          const tileX = index * 96;
          return `
            <g transform="translate(${tileX} 0)">
              <rect x="0" y="0" width="${tileW}" height="38" rx="11" fill="${index === 0 ? colors.warmWash : "#f8fafc"}" stroke="${index === 0 ? colors.accent : "#dbe3ee"}"/>
              <text x="${tileW / 2}" y="25" font-size="13" font-weight="800" fill="${index === 0 ? colors.accentDark : colors.muted}" text-anchor="middle">${format}</text>
            </g>
          `;
        }).join("")}
      </g>
      <path d="M0 594h${w}" stroke="${colors.line}" stroke-width="1.5"/>
      <text x="28" y="624" font-size="16" font-weight="680" fill="${colors.muted}">Selected 0 chats (max 10)</text>
      <rect x="${w - 142}" y="604" width="114" height="28" rx="12" fill="${colors.line}"/>
      <text x="${w - 85}" y="624" font-size="14" font-weight="820" fill="#ffffff" text-anchor="middle">Export</text>
    </g>
  `;
}

function darkInfoCard(x, y, title, body, stat) {
  return `
    <g transform="translate(${x} ${y})" filter="url(#softShadow)">
      <rect x="0" y="0" width="330" height="160" rx="28" fill="url(#darkPanel)"/>
      <text x="28" y="52" font-size="28" font-weight="850" fill="#ffffff">${esc(title)}</text>
      <text x="28" y="86" font-size="16" font-weight="660" fill="#e7fff7" opacity="0.82">${esc(body)}</text>
      <path d="M28 110h274" stroke="#ffffff" stroke-width="1" opacity="0.22"/>
      <text x="28" y="138" font-size="20" font-weight="850" fill="#ffffff">${esc(stat)}</text>
    </g>
  `;
}

function formatTile(x, y, title, body, fill, stroke, textColor) {
  return `
    <g transform="translate(${x} ${y})">
      <rect x="0" y="0" width="132" height="112" rx="24" fill="${fill}" stroke="${stroke}"/>
      <text x="66" y="50" font-size="25" font-weight="870" fill="${textColor}" text-anchor="middle">${esc(title)}</text>
      <text x="66" y="78" font-size="13" font-weight="720" fill="${textColor}" opacity="0.82" text-anchor="middle">${esc(body)}</text>
    </g>
  `;
}

function slidePlugin() {
  return svg(1280, 800, `
    ${base(1280, 800, 0)}
    ${brandMark(76, 70, 52, true)}
    ${platformSeal(548, 66, 56)}
    ${copyBlock(t.slide1, 76, 168, { maxTextWidth: 600, bulletSize: 22 })}
    <rect x="714" y="42" width="500" height="690" rx="46" fill="url(#softPanel)" stroke="${colors.line}" opacity="0.72"/>
    ${screenshotFrame({ img: imageData.plugin, x: 748, y: 58, w: 430, h: 645, rx: 30 })}
    ${formatPills(76, 718, ["PDF", "Word", "Markdown", "PNG"])}
  `);
}

function slideBatch() {
  return svg(1280, 800, `
    ${base(1280, 800, 1)}
    ${brandMark(76, 70, 46, false)}
    ${copyBlock(t.slide2, 76, 168, { maxTextWidth: 420, titleSize: 54, bodySize: 22, bulletSize: 21 })}
    <rect x="518" y="60" width="712" height="690" rx="46" fill="#ffffff" opacity="0.48" stroke="${colors.line}"/>
    ${batchInterface(548, 88, 650, 638)}
    ${darkInfoCard(804, 560, t.slide2.cardTitle, t.slide2.cardBody, t.slide2.cardStat)}
  `);
}

function slideSettings() {
  return svg(1280, 800, `
    ${base(1280, 800, 2)}
    ${brandMark(76, 70, 46, false)}
    ${copyBlock(t.slide3, 76, 168, { maxTextWidth: 600 })}
    <rect x="720" y="42" width="500" height="690" rx="46" fill="url(#softPanel)" stroke="${colors.line}" opacity="0.72"/>
    ${screenshotFrame({ img: imageData.settings, x: 752, y: 58, w: 430, h: 642, rx: 30 })}
    ${darkInfoCard(536, 514, t.slide3.cardTitle, t.slide3.cardBody, t.slide3.cardStat)}
  `);
}

function slideSelect() {
  return svg(1280, 800, `
    ${base(1280, 800, 3)}
    ${brandMark(76, 70, 46, false)}
    ${copyBlock(t.slide4, 76, 166, { maxTextWidth: 380 })}
    <rect x="480" y="84" width="784" height="592" rx="42" fill="#ffffff" opacity="0.48" stroke="${colors.line}"/>
    ${screenshotFrame({ img: imageData.select, x: 506, y: 110, w: 730, h: 544, rx: 26, fit: "meet" })}
    ${pill(884, 680, t.selectionPill, "dark")}
    ${pill(1080, 680, t.exportPill, "dark")}
  `);
}

function slidePrivacyReport() {
  return svg(1280, 800, `
    ${base(1280, 800, 4)}
    ${brandMark(76, 70, 46, false)}
    ${copyBlock(t.slide5, 76, 166, { maxTextWidth: 470 })}
    <g transform="translate(582 96)" filter="url(#deepShadow)">
      <rect x="0" y="0" width="596" height="530" rx="34" fill="#ffffff" stroke="${colors.line}"/>
      <rect x="28" y="28" width="540" height="126" rx="28" fill="url(#darkPanel)"/>
      <text x="62" y="78" font-size="32" font-weight="870" fill="#ffffff">${esc(t.pipelineTitle)}</text>
      <text x="62" y="116" font-size="17" font-weight="660" fill="#ffffff" opacity="0.78">${esc(t.pipelineSub)}</text>
      <g transform="translate(42 202)">
        ${formatTile(0, 0, "Notion", t.notionBody, colors.warmWash, colors.warmLine, colors.accentDark)}
        ${formatTile(154, 0, "Obsidian", t.obsidianBody, colors.coolWash, colors.coolLine, colors.accentDark)}
        ${formatTile(308, 0, "PDF / DOC", t.localFilesBody, colors.formatWash, colors.formatLine, colors.accentDark)}
      </g>
      <g transform="translate(42 350)">
        <rect x="0" y="0" width="382" height="88" rx="26" fill="${colors.formatWash}" stroke="${colors.line}"/>
        <circle cx="44" cy="44" r="20" fill="#ffffff" stroke="${colors.line}"/>
        <path d="M34 44l8 8 15-22" fill="none" stroke="${colors.accentDark}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="82" y="39" font-size="20" font-weight="850" fill="${colors.ink}">${esc(t.noServerTitle)}</text>
        <text x="82" y="64" font-size="14" font-weight="650" fill="${colors.muted}">${esc(t.noServerSub)}</text>
      </g>
    </g>
    ${screenshotFrame({ img: imageData.plugin, x: 1002, y: 430, w: 168, h: 252, rx: 22 })}
    <g transform="translate(586 652)" filter="url(#softShadow)">
      <rect x="0" y="0" width="300" height="72" rx="24" fill="#ffffff" stroke="${colors.line}"/>
      <circle cx="42" cy="36" r="18" fill="${colors.formatWash}" stroke="${colors.line}"/>
      <path d="M33 36l7 7 13-18" fill="none" stroke="${colors.accentDark}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="76" y="31" font-size="${fitFontSize(t.noUploadTitle, 18, 202, 13)}" font-weight="850" fill="${colors.ink}">${esc(t.noUploadTitle)}</text>
      <text x="76" y="53" font-size="${fitFontSize(t.noUploadSub, 13, 202, 10)}" font-weight="660" fill="${colors.muted}">${esc(t.noUploadSub)}</text>
    </g>
  `);
}

function promoSmall() {
  return svg(440, 280, `
    ${base(440, 280, 5)}
    <rect x="20" y="20" width="400" height="240" rx="30" fill="#ffffff" opacity="0.86" stroke="${colors.line}"/>
    ${brandMark(36, 36, 38, false)}
    <text x="86" y="61" font-size="${fitFontSize(project.displayName, 21, 170, 16)}" font-weight="870" fill="${colors.ink}">${esc(project.displayName)}</text>
    <text x="36" y="107" font-size="${fitFontSize(t.smallTitle, 24, 220, 17)}" font-weight="880" fill="${colors.accentDark}">${esc(t.smallTitle)}</text>
    <text x="36" y="137" font-size="${fitFontSize(t.smallSub, 14, 222, 10)}" font-weight="700" fill="${colors.muted}">${esc(t.smallSub)}</text>
    <g transform="translate(36 171)">
      <circle cx="8" cy="-4" r="8" fill="${colors.accent}"/>
      <path d="M4 -4l3 3 5-7" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="23" y="0" font-size="${fitFontSize(t.batchLabel, 14, 192, 10)}" font-weight="800" fill="${colors.ink}">${esc(t.batchLabel)}</text>
    </g>
    <g transform="translate(36 201)">
      <circle cx="8" cy="-4" r="8" fill="${colors.accent}"/>
      <path d="M4 -4l3 3 5-7" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="23" y="0" font-size="${fitFontSize(t.privateLabel, 14, 192, 10)}" font-weight="800" fill="${colors.ink}">${esc(t.privateLabel)}</text>
    </g>
    <g transform="translate(36 223)">
      <rect x="0" y="0" width="220" height="27" rx="13.5" fill="${colors.formatWash}" stroke="${colors.line}"/>
      <text x="110" y="18" font-size="${fitFontSize(t.noUploadSub, 11, 194, 9)}" font-weight="760" fill="${colors.accentDark}" text-anchor="middle">${esc(t.noUploadSub)}</text>
    </g>
    ${screenshotFrame({ img: imageData.plugin, x: 284, y: 34, w: 122, h: 202, rx: 18, fit: "meet" })}
  `);
}

function promoMarquee() {
  return svg(1400, 560, `
    ${base(1400, 560, 6)}
    <path d="M0 0h1400v560H0z" fill="#ffffff" opacity="0.14"/>
    ${brandMark(80, 74, 62, true)}
    ${platformSeal(636, 76, 62)}
    <text x="80" y="204" font-size="${fitFontSize(t.promoTitle, 59, 630, 42)}" font-weight="880" fill="${colors.ink}">${esc(t.promoTitle)}</text>
    <text x="80" y="262" font-size="${fitFontSize(t.promoSub, 25, 630, 17)}" font-weight="660" fill="${colors.muted}">${esc(t.promoSub)}</text>
    ${formatPills(80, 318, ["PDF", "Word", "Markdown", "PNG", "JSON"])}
    <rect x="746" y="22" width="594" height="516" rx="48" fill="#ffffff" opacity="0.5" stroke="${colors.line}"/>
    ${screenshotFrame({ img: imageData.plugin, x: 878, y: 30, w: 330, h: 500, rx: 28, fit: "meet" })}
    <g transform="translate(80 410)" filter="url(#softShadow)">
      <rect x="0" y="0" width="250" height="72" rx="24" fill="url(#darkPanel)"/>
      <text x="28" y="31" font-size="20" font-weight="850" fill="#ffffff">${esc(t.batchLabel)}</text>
      <text x="28" y="54" font-size="14" font-weight="660" fill="#ffffff" opacity="0.76">${esc(t.batchSub)}</text>
    </g>
    <g transform="translate(356 410)">
      <rect x="0" y="0" width="312" height="72" rx="24" fill="#ffffff" stroke="${colors.line}"/>
      <text x="28" y="31" font-size="17" font-weight="840" fill="${colors.accentDark}">${esc(t.privateLabel)}</text>
      <text x="28" y="54" font-size="14" font-weight="650" fill="${colors.muted}">${esc(t.privateSub)}</text>
    </g>
  `);
}

function svg(width, height, content) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs()}
  ${content}
</svg>
`;
}

const allAssets = [
  { name: "01-plugin-popup", width: 1280, height: 800, render: slidePlugin },
  { name: "02-batch-export", width: 1280, height: 800, render: slideBatch },
  { name: "03-export-theme-settings", width: 1280, height: 800, render: slideSettings },
  { name: "04-select-messages-export", width: 1280, height: 800, render: slideSelect },
  { name: "05-local-private-report", width: 1280, height: 800, render: slidePrivacyReport },
  { name: "promo-small-440x280", width: 440, height: 280, render: promoSmall },
  { name: "promo-marquee-1400x560", width: 1400, height: 560, render: promoMarquee },
];

const requestedAssetName = process.env.STORE_ASSET_NAME;
const assets = requestedAssetName
  ? allAssets.filter((asset) => asset.name === requestedAssetName)
  : allAssets;

if (requestedAssetName && assets.length === 0) {
  throw new Error(`Unknown store asset: ${requestedAssetName}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runChromeScreenshot({ svgPath, pngPath, width, height }) {
  const args = [
    chromePath,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--run-all-compositor-stages-before-draw",
    `--screenshot=${pngPath}`,
    `--window-size=${width},${height}`,
    pathToFileURL(svgPath).href,
  ];
  return spawnSync("/bin/zsh", ["-lc", args.map(shellQuote).join(" ")], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30000,
  });
}

function renderPng(asset, svgPath, pngPath) {
  let result = runChromeScreenshot({
    svgPath,
    pngPath,
    width: asset.width,
    height: asset.height,
  });
  if (fs.existsSync(pngPath)) return result;

  const safeBase = `${asset.name}-${locale}-${process.pid}-${Date.now()}`;
  const tmpSvgPath = path.join("/private/tmp", `${safeBase}.svg`);
  const tmpPngPath = path.join("/private/tmp", `${safeBase}.png`);
  fs.copyFileSync(svgPath, tmpSvgPath);
  fs.rmSync(tmpPngPath, { force: true });

  result = runChromeScreenshot({
    svgPath: tmpSvgPath,
    pngPath: tmpPngPath,
    width: asset.width,
    height: asset.height,
  });

  if (fs.existsSync(tmpPngPath)) {
    fs.copyFileSync(tmpPngPath, pngPath);
  }

  fs.rmSync(tmpSvgPath, { force: true });
  fs.rmSync(tmpPngPath, { force: true });
  return result;
}

fs.mkdirSync(outputDir, { recursive: true });

for (const asset of assets) {
  clipCounter = 0;
  fs.writeFileSync(path.join(outputDir, `${asset.name}.svg`), asset.render(), "utf8");
}

if (process.env.STORE_ASSET_SVG_ONLY === "1") {
  console.log(`Generated ${assets.length} ${locale} SVG store assets for ${project.displayName} in ${outputDir}`);
  process.exit(0);
}

if (!fs.existsSync(chromePath)) {
  console.warn(`Chrome not found at ${chromePath}; SVG files were generated only.`);
  process.exit(0);
}

for (const asset of assets) {
  const svgPath = path.join(outputDir, `${asset.name}.svg`);
  const pngPath = path.join(outputDir, `${asset.name}.png`);
  fs.rmSync(pngPath, { force: true });
  const result = renderPng(asset, svgPath, pngPath);

  if (!fs.existsSync(pngPath)) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    if (result.error) console.error(result.error);
    throw new Error(`Failed to render ${pngPath}`);
  }

  console.log(`Rendered ${path.basename(pngPath)} (${fs.statSync(pngPath).size} bytes)`);
}

console.log(`Generated ${assets.length} ${locale} store assets for ${project.displayName} in ${outputDir}`);
