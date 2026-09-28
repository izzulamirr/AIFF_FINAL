// A page's text as POSITIONED items, in the same space readPageGeometry uses -- origin
// top-left, y down, the page's /Rotate applied -- so a piece of text can be placed
// against the lines drawn around it.
//
// extractPdfPages() flattens a page to one string, which loses where each word sat. For
// a table that is fatal: a value in a merged cell reads the same wherever the cell was
// drawn, and which columns it spans is exactly what the position says.
import { readFile } from "node:fs/promises";
// Must come before the pdf.js require -- see pdfPolyfills.ts.
import "./pdfPolyfills";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

export interface TextItem {
  str: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export async function readTextItems(filePathOrBuffer: string | Buffer, pageNumber: number): Promise<TextItem[]> {
  const data = Buffer.isBuffer(filePathOrBuffer) ? new Uint8Array(filePathOrBuffer) : new Uint8Array(await readFile(filePathOrBuffer));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const items: TextItem[] = [];
  for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
    const str = (raw.str ?? "").trim();
    if (!str || !raw.transform) continue;
    // Item transform -> viewport space. The text's own origin is its baseline start.
    const m = pdfjsLib.Util.transform(viewport.transform, raw.transform) as number[];
    const width = raw.width ?? 0;
    const height = raw.height ?? Math.hypot(m[2], m[3]);
    // In viewport space the baseline start is (m[4], m[5]); the glyphs rise above it.
    const x0 = m[4];
    const yBase = m[5];
    items.push({ str, x0, x1: x0 + width * viewport.scale, y0: yBase - height * viewport.scale, y1: yBase });
  }
  return items;
}
