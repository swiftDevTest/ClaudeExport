import { normalizeExportSettings } from '../utils.js';
import { getExportTheme } from './tokens.js';

export function getPdfTheme(settingsInput) {
  var settings = normalizeExportSettings(settingsInput);
  var styleId = settings.export_style || "default";
  var theme = getExportTheme(styleId);
  return {
    settings: settings,
    styleId: styleId,
    theme: theme,
    design: {
      color: theme.color,
      font: theme.font
    }
  };
}
