// Renders PDF pages to PNG images for Claude's vision input. Needed for
// schematic/CAD-exported drawings (ISOs, P&IDs, PFDs) where the title block,
// dimensions, and tables are drawn as vector graphics with little or no real
// text layer -- confirmed on a real ISO upload where plain text extraction
// (pdfText.ts) yielded only a footer watermark, nothing from the title block
// or BOM table. Uses @napi-rs/canvas (prebuilt binaries, no native
// compilation) since the plain `canvas` package fails to build on this
// machine (missing cairo.h / incomplete MSBuild toolchain).
import { readFile } from "node:fs/promises";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

export interface RenderedPage {
  pageNumber: number;
  pngBase64: string;
}

// 2x scale keeps small title-block text/dimensions legible to Claude without
// producing excessively large payloads.
const RENDER_SCALE = 2;

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(canvasAndContext: { canvas: Canvas }, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: { canvas: Canvas | null }) {
    canvasAndContext.canvas = null;
  }
}

export async function renderPdfPages(filePathOrBuffer: string | Buffer, pageNumbers: number[]): Promise<RenderedPage[]> {
  const data = Buffer.isBuffer(filePathOrBuffer) ? new Uint8Array(filePathOrBuffer) : new Uint8Array(await readFile(filePathOrBuffer));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true, canvasFactory: new NodeCanvasFactory() }).promise;

  const rendered: RenderedPage[] = [];
  for (const pageNumber of pageNumbers) {
    if (pageNumber < 1 || pageNumber > pdf.numPages) continue;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    rendered.push({ pageNumber, pngBase64: canvas.toBuffer("image/png").toString("base64") });
  }
  return rendered;
}
