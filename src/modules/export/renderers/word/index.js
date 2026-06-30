import { coerceExportDocument } from '../../document.js';
import { buildDocxBlob as buildDocxBlobFromMessages } from '../../builders/docx.js';

export async function renderWordDocument(exportDocument, options) {
  var document = coerceExportDocument(exportDocument);
  return buildDocxBlobFromMessages(document.messages, document.metadata, document.settings, options);
}
