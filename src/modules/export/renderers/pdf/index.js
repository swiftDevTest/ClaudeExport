import { coerceExportDocument } from '../../document.js';
import {
  buildPdfBlob as buildPdfBlobFromMessages,
  renderPdfPages,
  createPdfFromJpegs
} from '../../builders/pdf.js';

export async function renderPdfDocument(exportDocument, options) {
  var document = coerceExportDocument(exportDocument);
  return buildPdfBlobFromMessages(document.messages, document.metadata, document.settings, options);
}

export {
  renderPdfPages,
  createPdfFromJpegs
};
