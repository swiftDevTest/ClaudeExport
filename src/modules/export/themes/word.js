import { normalizeExportSettings } from '../utils.js';
import { getExportTheme } from './tokens.js';

export function wordHexColor(value, fallback) {
  var match = String(value || "").trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? match[1].toUpperCase() : fallback;
}

export function getWordPageBg(theme, themeWord) {
  var fromWord = wordHexColor(themeWord && themeWord.pageBg, "");
  if (fromWord) return fromWord;
  var fromTheme = theme && theme.bg && Array.isArray(theme.bg.colors)
    ? wordHexColor(theme.bg.colors[0], "")
    : "";
  return fromTheme || "FFFFFF";
}

export function normalizeWordTheme(theme) {
  var themeWord = theme && theme.word ? theme.word : {};
  var themeColor = theme && theme.color ? theme.color : {};
  var colorText = wordHexColor(themeWord.colorText, wordHexColor(themeColor.ink, "1A202C"));
  var colorTitle = wordHexColor(themeWord.colorTitle, wordHexColor(themeColor.accentDark, "0F6574"));
  var colorMuted = wordHexColor(themeWord.colorMuted, wordHexColor(themeColor.muted, "64748B"));
  var userBg = wordHexColor(themeWord.userBg, wordHexColor(themeColor.cardBgUser, "EEF8FB"));
  var userBorder = wordHexColor(themeWord.userBorder, wordHexColor(themeColor.cardBorderUser, "0F6574"));
  var assistantBg = wordHexColor(themeWord.assistantBg, wordHexColor(themeColor.cardBgAssistant, "FFFFFF"));
  var assistantBorder = wordHexColor(themeWord.assistantBorder, wordHexColor(themeColor.cardBorderAssistant, "D9E2EC"));
  var accent = wordHexColor(themeWord.accent, wordHexColor(themeColor.accent, colorTitle));
  var line = wordHexColor(themeWord.separatorColor, wordHexColor(themeColor.line, assistantBorder));
  return {
    fontAscii: themeWord.fontAscii || "Arial",
    fontEastAsia: themeWord.fontEastAsia || "DengXian",
    colorTitle: colorTitle,
    colorText: colorText,
    colorMuted: colorMuted,
    pageBg: wordHexColor(themeWord.pageBg, ""),
    titleBg: wordHexColor(themeWord.titleBg, ""),
    titleBorder: wordHexColor(themeWord.titleBorder, ""),
    metaBg: wordHexColor(themeWord.metaBg, userBg),
    metaBorder: wordHexColor(themeWord.metaBorder, assistantBorder),
    metaText: wordHexColor(themeWord.metaText, colorMuted),
    roleLabelBg: wordHexColor(themeWord.roleLabelBg, ""),
    roleLabelBorder: wordHexColor(themeWord.roleLabelBorder, ""),
    roleUserColor: wordHexColor(themeWord.roleUserColor, userBorder),
    roleAssistantColor: wordHexColor(themeWord.roleAssistantColor, colorMuted),
    userBg: userBg,
    userBorder: userBorder,
    assistantBg: assistantBg,
    assistantBorder: assistantBorder,
    inlineCodeBg: wordHexColor(themeWord.inlineCodeBg, "F1F5F9"),
    inlineCodeText: wordHexColor(themeWord.inlineCodeText, accent),
    codeBg: wordHexColor(themeWord.codeBg, wordHexColor(themeColor.codeBg, "162334")),
    codeText: wordHexColor(themeWord.codeText, wordHexColor(themeColor.codeText, "E5EEF8")),
    codeBorder: wordHexColor(themeWord.codeBorder, wordHexColor(themeColor.codeBg, "162334")),
    codeLabel: wordHexColor(themeWord.codeLabel, "9FB3C8"),
    quoteBg: wordHexColor(themeWord.quoteBg, wordHexColor(themeColor.quoteBg, "F3FBF9")),
    quoteBorder: wordHexColor(themeWord.quoteBorder, accent),
    quoteText: wordHexColor(themeWord.quoteText, colorText),
    tableHeaderBg: wordHexColor(themeWord.tableHeaderBg, "F1F5F9"),
    tableHeaderText: wordHexColor(themeWord.tableHeaderText, colorText),
    tableBorder: wordHexColor(themeWord.tableBorder, line),
    separatorColor: line
  };
}

export function getWordTheme(settingsInput) {
  var settings = normalizeExportSettings(settingsInput);
  // Word 导出强制使用 natural 主题：自定义主题只作用于 PDF 和 Image 导出。
  var styleId = "natural";
  var theme = getExportTheme(styleId);
  var word = normalizeWordTheme(theme);
  return {
    settings: settings,
    styleId: styleId,
    theme: theme,
    word: word,
    pageBg: getWordPageBg(theme, word)
  };
}
