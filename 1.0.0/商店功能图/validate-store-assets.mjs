import fs from "node:fs";
import path from "node:path";

const [outputDir, expectedPlatform] = process.argv.slice(2);
if (!outputDir || !expectedPlatform) {
  throw new Error("Usage: node validate-store-assets.mjs <output-dir> <ChatGPT|Gemini|Claude>");
}

const localeDirs = {
  en: "",
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
  de: "de",
  es: "es",
  fr: "fr",
  ja: "ja",
  ko: "ko",
  "pt-BR": "pt-BR",
};

const assets = {
  "01-plugin-popup": [1280, 800],
  "02-batch-export": [1280, 800],
  "03-export-theme-settings": [1280, 800],
  "04-select-messages-export": [1280, 800],
  "05-local-private-report": [1280, 800],
  "promo-small-440x280": [440, 280],
  "promo-marquee-1400x560": [1400, 560],
};

const platforms = ["ChatGPT", "Gemini", "Claude"];
const forbiddenPlatforms = platforms.filter((name) => name !== expectedPlatform);
const failures = [];
let checkedPairs = 0;

function readPngSize(file) {
  const bytes = fs.readFileSync(file);
  const signature = bytes.subarray(1, 4).toString("ascii");
  if (signature !== "PNG") throw new Error(`Not a PNG: ${file}`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

for (const [locale, localeDir] of Object.entries(localeDirs)) {
  const dir = localeDir ? path.join(outputDir, localeDir) : outputDir;
  for (const [name, expectedSize] of Object.entries(assets)) {
    const png = path.join(dir, `${name}.png`);
    const svg = path.join(dir, `${name}.svg`);
    for (const file of [png, svg]) {
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        failures.push(`${locale}: missing or empty ${path.basename(file)}`);
      }
    }
    if (!fs.existsSync(png) || !fs.existsSync(svg)) continue;

    const pngSize = readPngSize(png);
    if (pngSize[0] !== expectedSize[0] || pngSize[1] !== expectedSize[1]) {
      failures.push(`${locale}: ${name}.png is ${pngSize.join("x")}, expected ${expectedSize.join("x")}`);
    }

    const svgText = fs.readFileSync(svg, "utf8");
    const expectedRoot = `width="${expectedSize[0]}" height="${expectedSize[1]}"`;
    if (!svgText.includes(expectedRoot)) {
      failures.push(`${locale}: ${name}.svg has an unexpected canvas size`);
    }
    const visibleText = [...svgText.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
      .map((match) => match[1].replace(/<[^>]+>/g, " "))
      .join(" ");
    for (const forbidden of forbiddenPlatforms) {
      if (visibleText.includes(forbidden)) {
        failures.push(`${locale}: ${name}.svg visibly mentions forbidden platform ${forbidden}`);
      }
    }
    const imageCount = (svgText.match(/<image\b/g) || []).length;
    if (name === "promo-marquee-1400x560" && imageCount !== 3) {
      failures.push(`${locale}: ${name}.svg must contain only logo, platform seal, and one main UI screenshot`);
    }
    if (name === "02-batch-export" && imageCount !== 1) {
      failures.push(`${locale}: ${name}.svg must use the product-specific generated batch interface`);
    }
    checkedPairs += 1;
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Validated ${checkedPairs} SVG/PNG pairs for ${expectedPlatform}: 9 locales, correct sizes, no cross-platform labels.`);
