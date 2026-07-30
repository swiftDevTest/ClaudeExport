import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pdfBuilderSource = readFileSync(new URL("../src/modules/export/builders/pdf.js", import.meta.url), "utf8");

test("PDF export fits tall image rows to remaining page height", () => {
  assert.match(pdfBuilderSource, /MIN_FITTED_IMAGE_ROW_HEIGHT\s*=\s*180/);
  assert.match(pdfBuilderSource, /function fitPdfImageRowToHeight/);
  assert.match(pdfBuilderSource, /maxOriginalHeight\s*=\s*Math\.max\(1,\s*maxHeight - 16\)/);
  assert.match(pdfBuilderSource, /fittedBlock\.height\s*=\s*fittedBlock\.originalHeight \+ 16/);
  assert.match(pdfBuilderSource, /newPage\(\);\s*fittedRow = fitPdfImageRowToHeight/s);
  assert.match(pdfBuilderSource, /renderPdfImageGridRow\(fittedRow, imgX, y\)/);
});

test("PDF footer only shows branding watermark, without platform or time", () => {
  assert.match(pdfBuilderSource, /if \(!settings\.show_chatvault_badge\) return;/);
  assert.match(pdfBuilderSource, /ctx\.fillText\(t\("export_pdf_footer_branding"/);
  assert.doesNotMatch(pdfBuilderSource, /footer\.push\(getPlatformLabel\(metadata\.platform\)\)/);
  assert.doesNotMatch(pdfBuilderSource, /footer\.push\(formatDateDisplay\(metadata\.exportedAt\)\)/);
});
