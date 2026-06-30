import { normalizeExportSettings } from '../utils.js';
import { getExportTheme } from './tokens.js';

export function getImageTheme(settingsInput) {
  var settings = normalizeExportSettings(settingsInput);
  var styleId = settings.export_style || "default";
  return {
    settings: settings,
    styleId: styleId,
    theme: getExportTheme(styleId)
  };
}
