import { coerceExportDocument } from '../../document.js';
import { buildImageBlob as buildImageBlobFromMessages } from '../../builders/image.js';

export async function renderImageDocument(exportDocument, options) {
  var document = coerceExportDocument(exportDocument);
  return buildImageBlobFromMessages(document.messages, document.metadata, document.settings, options);
}
