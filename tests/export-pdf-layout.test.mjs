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

test("PDF footer includes platform when platform metadata is enabled", () => {
  assert.match(pdfBuilderSource, /!settings\.show_chatvault_badge && !settings\.show_platform_name && !settings\.show_export_time/);
  assert.match(pdfBuilderSource, /settings\.show_platform_name && metadata\.platform/);
  assert.match(pdfBuilderSource, /footer\.push\(platformLabel\)/);
});
