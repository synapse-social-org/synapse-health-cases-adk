/**
 * Render the Health Case Expert Research brief PDF Node-side using the same
 * `BriefPdfDocument` React component the web app downloads. Used to capture
 * a representative PDF artifact for QA / demos without driving the browser.
 *
 * Usage:
 *   yarn dlx tsx frontend/web/scripts/render-brief-pdf.tsx \
 *     <brief.md> <out.pdf> [caseTitle] [conditionsCsv]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ReactElement } from 'react';
// `@react-pdf/renderer`'s Node API: `ReactPDF.render(element, filePath)`.
// We pull from the package's default export the same way Next.js does for
// SSR.
import ReactPDF, { type DocumentProps } from '@react-pdf/renderer';

import { parseBrief } from '../src/app/components/HealthCases/briefPdf';
import { BriefPdfDocument } from '../src/app/components/HealthCases/BriefPdfDocument';

async function main() {
  const [inputPath, outputPath, caseTitleArg, conditionsArg] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error('Usage: render-brief-pdf.tsx <brief.md> <out.pdf> [title] [conditionsCsv]');
    process.exit(2);
  }
  const briefContent = readFileSync(resolve(inputPath), 'utf-8');
  const parsed = parseBrief(briefContent);

  const caseTitle = caseTitleArg || '67M with Vision Loss, MacTel, Diabetes, and CKD';
  const conditionTerms = (conditionsArg || 'MacTel,Diabetes,Stage 3A CKD,Vision Loss')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // BriefPdfDocument returns a `<Document>` at runtime, but its component type
  // doesn't surface DocumentProps to the caller, so we cast for ReactPDF.render
  // which requires `ReactElement<DocumentProps>`.
  const element = createElement(BriefPdfDocument, {
    caseTitle,
    conditionTerms,
    brief: parsed,
    generatedAtIso: new Date().toISOString(),
  }) as unknown as ReactElement<DocumentProps>;

  await ReactPDF.render(element, resolve(outputPath));
  console.log(`wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
