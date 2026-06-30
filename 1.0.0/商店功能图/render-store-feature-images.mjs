import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const outDir = __dirname;
const sourceDir = path.join(outDir, "source-screenshots");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const colors = {
  ink: "#101828",
  muted: "#596779",
  faint: "#8b98aa",
  accent: "#10b981",
  accentDark: "#05634f",
  accentDeep: "#073f35",
  mint: "#e8f8f1",
  paper: "#fbfffc",
  line: "#cfe2da",
  slate: "#15261f",
};

const locale = process.env.STORE_ASSET_LOCALE === "zh-CN" ? "zh-CN" : "en";
const outputDir = locale === "zh-CN" ? path.join(outDir, "zh-CN") : outDir;

const files = {
  logo: path.join(rootDir, "images", "store-icon-128.png"),
  plugin: path.join(sourceDir, "plugin-popup.png"),
  batch: path.join(sourceDir, "batch-export.png"),
  settings: path.join(sourceDir, "settings.png"),
  select: path.join(sourceDir, "select-messages.png"),
  polished: path.join(rootDir, "site", "assets", "chatvault-store-03-polished-exports.png"),
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

let clipCounter = 0;

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function defs() {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#f4fffb"/>
        <stop offset="52%" stop-color="#ecf8e5"/>
        <stop offset="100%" stop-color="#ffffff"/>
      </linearGradient>
      <linearGradient id="darkPanel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0c4a3d"/>
        <stop offset="100%" stop-color="#072f29"/>
      </linearGradient>
      <linearGradient id="greenPanel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#18c794"/>
        <stop offset="100%" stop-color="#06765e"/>
      </linearGradient>
      <filter id="deepShadow" x="-18%" y="-18%" width="136%" height="142%">
        <feDropShadow dx="0" dy="28" stdDeviation="24" flood-color="#063f35" flood-opacity="0.18"/>
      </filter>
      <filter id="softShadow" x="-18%" y="-18%" width="136%" height="142%">
        <feDropShadow dx="0" dy="16" stdDeviation="14" flood-color="#063f35" flood-opacity="0.14"/>
      </filter>
      <filter id="tightShadow" x="-14%" y="-14%" width="128%" height="132%">
        <feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#063f35" flood-opacity="0.12"/>
      </filter>
      <pattern id="fineGrid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M40 0H0V40" fill="none" stroke="#0f766e" stroke-width="1" opacity="0.045"/>
      </pattern>
    </defs>
    <style>
      svg {
        font-family: "Avenir Next", "Helvetica Neue", Arial, "PingFang SC", "Noto Sans CJK SC", sans-serif;
        text-rendering: geometricPrecision;
      }
      .headline { font-size: 60px; font-weight: 840; fill: ${colors.ink}; letter-spacing: 0; }
      .body { font-size: 25px; font-weight: 620; fill: ${colors.muted}; letter-spacing: 0; }
      .small { font-size: 16px; font-weight: 720; fill: ${colors.muted}; letter-spacing: 0; }
      .mono { font-family: "SFMono-Regular", Menlo, Consolas, monospace; }
    </style>
  `;
}

const copy = {
  en: {
    slide1: {
      label: "Extension panel",
      title: ["Export AI", "chats fast"],
      body: ["Save conversations as PDF, Word, Markdown,", "Image, Text, or JSON. No chat upload."],
      bullets: ["Auto-detect ChatGPT / Gemini / Claude", "Clear free quota", "Local privacy notice"],
    },
    slide2: {
      label: "Batch export",
      title: ["Package", "many chats"],
      body: ["Select multiple conversations.", "Export them in one format."],
      bullets: ["Up to 10 chats", "Switch formats fast", "Built for archives"],
      cardTitle: "Batch ready",
      cardBody: "Select chats, then export",
      cardStat: "PDF / Word / MD",
    },
    slide3: {
      label: "Export settings",
      title: ["Themes and", "fields"],
      body: ["Minimalist, Editorial, Terminal, Oxford.", "Control title, time, and platform fields."],
      bullets: ["Professional export themes", "Document field controls", "Clear Pro feature labels"],
      cardTitle: "Theme presets",
      cardBody: "Reports, papers, terminal style",
      cardStat: "8 export themes",
    },
    slide4: {
      label: "Selected export",
      title: ["Keep only", "what matters"],
      body: ["Select key messages on the page,", "or grab AI replies in one click.", "Long chats become clean files."],
      bullets: ["Pick specific messages", "Filter AI replies fast", "Change format before export"],
    },
    slide5: {
      label: "Local private export",
      title: ["Turn chats", "into reports"],
      body: ["Chat content stays on your device.", "Files are ready to edit, share, and archive."],
      bullets: ["PDF / Word / PNG generated locally", "Redact sensitive info on device", "Receipts help verify exports"],
    },
    smallTitle: "Export chats locally",
    smallSub: "PDF, Word, Markdown, Image",
    promoTitle: "Export chats locally",
    promoSub: "ChatGPT, Gemini and Claude to polished local files.",
  },
  "zh-CN": {
    slide1: {
      label: "插件主面板",
      title: ["一键导出", "AI 对话"],
      body: ["PDF、Word、Markdown、图片、Text、JSON", "都在浏览器本地生成，不上传聊天正文。"],
      bullets: ["自动识别 ChatGPT / Gemini / Claude", "免费额度清晰可见", "本地隐私提示常驻"],
    },
    slide2: {
      label: "批量导出",
      title: ["多会话", "一次打包"],
      body: ["从会话列表中选择多个聊天，统一导出为", "PDF、Word、Markdown、图片、Text 或 JSON。"],
      bullets: ["最多 10 个聊天", "格式切换不离开弹窗", "适合项目归档和资料整理"],
      cardTitle: "Batch ready",
      cardBody: "选择聊天后即可导出",
      cardStat: "PDF / Word / MD",
    },
    slide3: {
      label: "导出设置",
      title: ["主题与字段", "都可控"],
      body: ["Minimalist、Editorial、Terminal、Oxford 等主题", "搭配标题、时间、平台名等内容开关。"],
      bullets: ["专业主题样式", "文档字段开关", "Pro 能力清晰标记"],
      cardTitle: "Theme presets",
      cardBody: "报告、学术、终端风格",
      cardStat: "8 export themes",
    },
    slide4: {
      label: "选择消息导出",
      title: ["只保留", "重点内容"],
      body: ["在页面上勾选关键消息，", "或一键选择 AI 回复。", "长对话也能清爽导出。"],
      bullets: ["选择指定消息", "AI 回复快速筛选", "导出前格式可切换"],
    },
    slide5: {
      label: "本地安全导出",
      title: ["从聊天", "变成报告"],
      body: ["聊天内容留在本机，导出文件适合编辑、", "分发、分享和长期归档。"],
      bullets: ["PDF / Word / PNG 本地生成", "敏感信息可本地脱敏", "导出凭证便于验证"],
    },
    smallTitle: "Export chats locally",
    smallSub: "PDF, Word, Markdown, Image",
    promoTitle: "Export chats locally",
    promoSub: "ChatGPT, Gemini and Claude to polished local files.",
  },
};

const t = copy[locale];

function base(width, height, variant = 0) {
  const sweepY = Math.round(height * 0.19);
  const lowerY = Math.round(height * 0.76);
  return `
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#fineGrid)" opacity="0.5"/>
    <path d="M-${width * 0.08} ${sweepY} C ${width * 0.18} ${sweepY - 52} ${width * 0.34} ${sweepY + 44} ${width * 0.58} ${sweepY - 8} C ${width * 0.78} ${sweepY - 52} ${width * 0.92} ${sweepY - 24} ${width * 1.08} ${sweepY + 2}" fill="none" stroke="#bdebdc" stroke-width="${height > 400 ? 42 : 24}" opacity="0.28"/>
    <path d="M-${width * 0.05} ${lowerY} C ${width * 0.22} ${lowerY - 58} ${width * 0.36} ${lowerY + 68} ${width * 0.58} ${lowerY - 22} C ${width * 0.8} ${lowerY - 110} ${width * 0.92} ${lowerY - 38} ${width * 1.08} ${lowerY - 72}" fill="none" stroke="${variant % 2 ? "#d6ead6" : "#c8efe2"}" stroke-width="${height > 400 ? 68 : 34}" opacity="0.33"/>
    <path d="M${width * 0.68} -40h${width * 0.46}l-${width * 0.14} ${height + 100}h-${width * 0.5}z" fill="#ffffff" opacity="${variant % 2 ? 0.38 : 0.27}"/>
  `;
}

function brandMark(x, y, size = 46, withName = false) {
  const img = imageData.logo
    ? `<image href="${imageData.logo}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`
    : `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#greenPanel)"/>`;
  return `
    <g>
      ${img}
      ${withName ? `<text x="${x + size + 16}" y="${y + size * 0.66}" font-size="${Math.round(size * 0.42)}" font-weight="820" fill="${colors.ink}">AI Chat Export</text>` : ""}
    </g>
  `;
}

function copyBlock({ label, title, body, bullets = [] }, x, y, options = {}) {
  const titleLines = Array.isArray(title) ? title : [title];
  const bodyLines = Array.isArray(body) ? body : [body];
  const titleSize = options.titleSize || 58;
  const bodySize = options.bodySize || 24;
  const labelHeight = options.labelHeight || 42;
  const labelWidth = Math.min(options.labelMaxWidth || 350, Math.max(154, label.length * 15 + 48));
  const titleY = y + labelHeight + 86;
  const bodyY = titleY + titleLines.length * (titleSize + 7) + 30;
  const bulletY = bodyY + bodyLines.length * (bodySize + 12) + 48;
  return `
    <g>
      <rect x="${x}" y="${y}" width="${labelWidth}" height="${labelHeight}" rx="${labelHeight / 2}" fill="#ffffff" stroke="${colors.line}" filter="url(#tightShadow)"/>
      <text x="${x + 22}" y="${y + 27}" font-size="19" font-weight="820" fill="${colors.accentDark}">${esc(label)}</text>
      <text x="${x}" y="${titleY}" font-size="${titleSize}" font-weight="860" fill="${colors.ink}">
        ${titleLines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : titleSize + 7}">${esc(line)}</tspan>`).join("")}
      </text>
      <text x="${x}" y="${bodyY}" font-size="${bodySize}" font-weight="620" fill="${colors.muted}">
        ${bodyLines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : bodySize + 12}">${esc(line)}</tspan>`).join("")}
      </text>
      ${bullets.map((item, index) => `
        <g transform="translate(${x} ${bulletY + index * 48})">
          <circle cx="11" cy="-8" r="10" fill="#e7fff5" stroke="${colors.accent}" stroke-width="2"/>
          <path d="M6 -9l4 4 8-10" fill="none" stroke="${colors.accentDark}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="34" y="0" font-size="24" font-weight="720" fill="${colors.slate}">${esc(item)}</text>
        </g>
      `).join("")}
    </g>
  `;
}

function pill(x, y, label, tone = "light") {
  const w = Math.max(86, label.length * 13 + 34);
  const isDark = tone === "dark";
  return `
    <g>
      <rect x="${x}" y="${y}" width="${w}" height="40" rx="20" fill="${isDark ? colors.accentDeep : "#ffffff"}" stroke="${isDark ? "#2ed4a6" : "#bde7d8"}"/>
      <text x="${x + w / 2}" y="${y + 26}" font-size="16" font-weight="820" fill="${isDark ? "#ffffff" : colors.accentDark}" text-anchor="middle">${esc(label)}</text>
    </g>
  `;
}

function screenshotFrame({ img, x, y, w, h, rx = 24, fit = "cover", border = "#ffffff", rotate = 0 }) {
  const id = `clip-${clipCounter++}`;
  return `
    <g transform="translate(${x} ${y}) rotate(${rotate} ${w / 2} ${h / 2})" filter="url(#deepShadow)">
      <defs>
        <clipPath id="${id}">
          <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}"/>
        </clipPath>
      </defs>
      <rect x="-10" y="-10" width="${w + 20}" height="${h + 20}" rx="${rx + 10}" fill="#ffffff" opacity="0.82"/>
      <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" fill="#ffffff" stroke="${border}" stroke-width="2"/>
      <image href="${img}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid ${fit}" clip-path="url(#${id})"/>
      <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" fill="none" stroke="rgba(255,255,255,0.88)" stroke-width="2"/>
    </g>
  `;
}

function darkInfoCard(x, y, title, body, stat) {
  return `
    <g transform="translate(${x} ${y})" filter="url(#softShadow)">
      <rect x="0" y="0" width="310" height="156" rx="26" fill="url(#darkPanel)"/>
      <text x="28" y="50" font-size="28" font-weight="840" fill="#ffffff">${esc(title)}</text>
      <text x="28" y="84" font-size="16" font-weight="660" fill="#b9eadd">${esc(body)}</text>
      <path d="M28 108h254" stroke="#2b7567" stroke-width="1"/>
      <text x="28" y="135" font-size="20" font-weight="840" fill="#65f0bd">${esc(stat)}</text>
    </g>
  `;
}

function slidePlugin() {
  return svg(1280, 800, `
    ${base(1280, 800, 0)}
    ${brandMark(76, 70, 50, true)}
    ${copyBlock(t.slide1, 76, 170)}
    ${screenshotFrame({ img: imageData.plugin, x: 742, y: 58, w: 430, h: 645, rx: 30, fit: "slice" })}
    ${pill(76, 718, "PDF")}
    ${pill(176, 718, "Word")}
    ${pill(286, 718, "Markdown")}
    ${pill(430, 718, "PNG")}
  `);
}

function slideBatch() {
  return svg(1280, 800, `
    ${base(1280, 800, 1)}
    ${copyBlock(t.slide2, 76, 170)}
    ${screenshotFrame({ img: imageData.batch, x: 554, y: 88, w: 650, h: 638, rx: 30, fit: "slice" })}
    ${darkInfoCard(812, 560, t.slide2.cardTitle, t.slide2.cardBody, t.slide2.cardStat)}
  `);
}

function slideSettings() {
  return svg(1280, 800, `
    ${base(1280, 800, 2)}
    ${copyBlock(t.slide3, 76, 170)}
    ${screenshotFrame({ img: imageData.settings, x: 744, y: 58, w: 430, h: 642, rx: 30, fit: "slice" })}
    ${darkInfoCard(550, 514, t.slide3.cardTitle, t.slide3.cardBody, t.slide3.cardStat)}
  `);
}

function slideSelect() {
  return svg(1280, 800, `
    ${base(1280, 800, 3)}
    ${copyBlock(t.slide4, 76, 170)}
    ${screenshotFrame({ img: imageData.select, x: 506, y: 110, w: 730, h: 544, rx: 26, fit: "slice" })}
    ${locale === "en" ? `
      <g>
        <rect x="1082" y="277" width="78" height="24" rx="12" fill="#f8fbfb" stroke="#d9e7e7"/>
        <text x="1121" y="293" font-size="12" font-weight="720" fill="${colors.muted}" text-anchor="middle">WHO +3</text>
      </g>
    ` : ""}
    ${pill(892, 678, "Selected 2", "dark")}
    ${pill(1084, 678, "Export", "dark")}
  `);
}

function slidePrivacyReport() {
  return svg(1280, 800, `
    ${base(1280, 800, 4)}
    ${copyBlock(t.slide5, 76, 166)}
    <g transform="translate(584 104)" filter="url(#deepShadow)">
      <rect x="0" y="0" width="594" height="520" rx="34" fill="#ffffff" stroke="${colors.line}"/>
      <rect x="28" y="28" width="538" height="126" rx="28" fill="url(#darkPanel)"/>
      <text x="62" y="78" font-size="32" font-weight="860" fill="#ffffff">Local export pipeline</text>
      <text x="62" y="116" font-size="17" font-weight="660" fill="#c9f7e8">AI chat content stays in your browser</text>
      <g transform="translate(42 202)">
        <rect x="0" y="0" width="132" height="112" rx="24" fill="#fff7ed" stroke="#fed7aa"/>
        <text x="66" y="50" font-size="25" font-weight="860" fill="#c2410c" text-anchor="middle">PDF</text>
        <text x="66" y="78" font-size="13" font-weight="700" fill="#9a3412" text-anchor="middle">Formatted</text>
        <rect x="154" y="0" width="132" height="112" rx="24" fill="#eff6ff" stroke="#bfdbfe"/>
        <text x="220" y="50" font-size="25" font-weight="860" fill="#1d4ed8" text-anchor="middle">Word</text>
        <text x="220" y="78" font-size="13" font-weight="700" fill="#1e40af" text-anchor="middle">Editable</text>
        <rect x="308" y="0" width="132" height="112" rx="24" fill="#ecfdf5" stroke="#a7f3d0"/>
        <text x="374" y="50" font-size="25" font-weight="860" fill="${colors.accentDark}" text-anchor="middle">PNG</text>
        <text x="374" y="78" font-size="13" font-weight="700" fill="${colors.accentDark}" text-anchor="middle">Share card</text>
      </g>
      <g transform="translate(42 350)">
        <rect x="0" y="0" width="360" height="88" rx="26" fill="#f7fffb" stroke="${colors.line}"/>
        <circle cx="44" cy="44" r="20" fill="#dcfff1"/>
        <path d="M34 44l8 8 15-22" fill="none" stroke="${colors.accentDark}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="82" y="39" font-size="20" font-weight="850" fill="${colors.ink}">No conversion server</text>
        <text x="82" y="64" font-size="14" font-weight="650" fill="${colors.muted}">Files are generated locally.</text>
      </g>
    </g>
    ${screenshotFrame({ img: imageData.plugin, x: 1000, y: 430, w: 168, h: 252, rx: 22, fit: "slice", rotate: 0 })}
    <g transform="translate(586 650)" filter="url(#softShadow)">
      <rect x="0" y="0" width="290" height="72" rx="24" fill="#ffffff" stroke="${colors.line}"/>
      <circle cx="42" cy="36" r="18" fill="#dcfff1"/>
      <path d="M33 36l7 7 13-18" fill="none" stroke="${colors.accentDark}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="76" y="31" font-size="18" font-weight="840" fill="${colors.ink}">No upload</text>
      <text x="76" y="53" font-size="13" font-weight="660" fill="${colors.muted}">local conversion only</text>
    </g>
  `);
}

function promoSmall() {
  return svg(440, 280, `
    ${base(440, 280, 5)}
    <rect x="20" y="20" width="400" height="240" rx="30" fill="#ffffff" opacity="0.82" stroke="${colors.line}"/>
    ${brandMark(42, 42, 48, false)}
    <text x="104" y="72" font-size="29" font-weight="860" fill="${colors.ink}">AI Chat Export</text>
    <text x="42" y="122" font-size="25" font-weight="860" fill="${colors.accentDark}">${esc(t.smallTitle)}</text>
    <text x="42" y="152" font-size="15" font-weight="680" fill="${colors.muted}">PDF, Word, Markdown, Image</text>
    <g transform="translate(42 184)">
      <rect x="0" y="0" width="164" height="48" rx="24" fill="url(#darkPanel)"/>
      <text x="24" y="29" font-size="17" font-weight="840" fill="#ffffff">Batch export</text>
    </g>
    <g transform="translate(218 184)">
      <rect x="0" y="0" width="158" height="48" rx="24" fill="#f7fffb" stroke="#bde7d8"/>
      <text x="24" y="29" font-size="17" font-weight="820" fill="${colors.accentDark}">Local files</text>
    </g>
  `);
}

function promoMarquee() {
  return svg(1400, 560, `
    ${base(1400, 560, 6)}
    <path d="M0 0h1400v560H0z" fill="#ffffff" opacity="0.16"/>
    ${brandMark(80, 74, 62, true)}
    <text x="80" y="204" font-size="60" font-weight="870" fill="${colors.ink}">${esc(t.promoTitle)}</text>
    <text x="80" y="262" font-size="25" font-weight="650" fill="${colors.muted}">${esc(t.promoSub)}</text>
    ${pill(80, 318, "PDF", "dark")}
    ${pill(184, 318, "Word")}
    ${pill(300, 318, "Markdown")}
    ${pill(448, 318, "PNG")}
    ${pill(550, 318, "JSON")}
    ${screenshotFrame({ img: imageData.plugin, x: 1040, y: 52, w: 228, h: 430, rx: 28, fit: "slice", rotate: 0 })}
    ${screenshotFrame({ img: imageData.select, x: 790, y: 150, w: 396, h: 294, rx: 24, fit: "slice", rotate: -1 })}
    ${locale === "en" ? `
      <g>
        <rect x="1090" y="232" width="58" height="18" rx="9" fill="#f8fbfb" stroke="#d9e7e7"/>
        <text x="1119" y="245" font-size="9" font-weight="760" fill="${colors.muted}" text-anchor="middle">WHO +3</text>
      </g>
    ` : ""}
    <g transform="translate(80 410)" filter="url(#softShadow)">
      <rect x="0" y="0" width="244" height="72" rx="24" fill="url(#darkPanel)"/>
      <text x="28" y="31" font-size="20" font-weight="850" fill="#ffffff">Batch export</text>
      <text x="28" y="54" font-size="14" font-weight="660" fill="#b9eadd">Package multi-chat files</text>
    </g>
    <g transform="translate(348 410)">
      <rect x="0" y="0" width="312" height="72" rx="24" fill="#ffffff" stroke="${colors.line}"/>
      <text x="28" y="31" font-size="17" font-weight="820" fill="${colors.accentDark}">100% local and private</text>
      <text x="28" y="54" font-size="14" font-weight="640" fill="${colors.muted}">No upload for conversion.</text>
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

const assets = [
  { name: "01-plugin-popup", width: 1280, height: 800, render: slidePlugin },
  { name: "02-batch-export", width: 1280, height: 800, render: slideBatch },
  { name: "03-export-theme-settings", width: 1280, height: 800, render: slideSettings },
  { name: "04-select-messages-export", width: 1280, height: 800, render: slideSelect },
  { name: "05-local-private-report", width: 1280, height: 800, render: slidePrivacyReport },
  { name: "promo-small-440x280", width: 440, height: 280, render: promoSmall },
  { name: "promo-marquee-1400x560", width: 1400, height: 560, render: promoMarquee },
];

fs.mkdirSync(outputDir, { recursive: true });

for (const asset of assets) {
  fs.writeFileSync(path.join(outputDir, `${asset.name}.svg`), asset.render(), "utf8");
}

if (!fs.existsSync(chromePath)) {
  console.warn(`Chrome not found at ${chromePath}; SVG files were generated only.`);
  process.exit(0);
}

for (const asset of assets) {
  const svgPath = path.join(outputDir, `${asset.name}.svg`);
  const pngPath = path.join(outputDir, `${asset.name}.png`);
  const userDataDir = path.join("/private/tmp", `chatvault-store-render-${Date.now()}-${asset.name}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const result = spawnSync(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--run-all-compositor-stages-before-draw",
    `--user-data-dir=${userDataDir}`,
    `--screenshot=${pngPath}`,
    `--window-size=${asset.width},${asset.height}`,
    pathToFileURL(svgPath).href,
  ], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 20000,
  });

  if (!fs.existsSync(pngPath)) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error(`Failed to render ${pngPath}`);
  }

  console.log(`Rendered ${path.basename(pngPath)} (${fs.statSync(pngPath).size} bytes)`);
}

console.log(`Generated ${assets.length} ${locale} store assets in ${outputDir}`);
