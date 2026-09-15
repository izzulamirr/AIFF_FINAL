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
// Must come before the pdf.js require -- see pdfPolyfills.ts.
import "./pdfPolyfills";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

export interface RenderedPage {
  pageNumber: number;
  pngBase64: string;
}

// 2x scale keeps small title-block text/dimensions legible to Claude without
// producing excessively large payloads.
const RENDER_SCALE = 2;

// The API rejects an image whose base64 payload exceeds 10 MB, or whose
// either side exceeds 8000 px, with a 400 that fails the whole extraction.
// Large-format drawings hit both: an A1 sheet is 2384x1684 pt, so 2x is
// 4768x3368, and a dense CAD sheet at that size encodes to a PNG whose base64
// runs past 10 MB. That is exactly how a P&ID failed with
// "image exceeds 10 MB maximum: 13856080 bytes" and, on a larger sheet,
// "At least one of the image dimensions exceed max allowed size: 8000 pixels".
// Both limits are enforced here so a big sheet renders smaller instead of
// killing the job.
const MAX_IMAGE_DIMENSION = 8000;
const MAX_IMAGE_BASE64_BYTES = 9_500_000; // under the API's 10485760, with margin
// Below this the drawing stops being legible, so failing loudly beats silently
// sending Claude an unreadable image.
const MIN_RENDER_SCALE = 0.5;

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

// The API downsamples any image to ~1568 px on its long edge before the model
// sees it. A large-format drawing is 2384x1684 pt, so the WHOLE sheet arrives
// at 1568 px wide and a 3" valve symbol is about 10 px across -- too small to
// tell an empty bowtie (gate) from one with an open circle (ball) or a filled
// circle (globe). Rendering at a higher scale does not help: the extra pixels
// are thrown away before the model reads them.
//
// Splitting the sheet into overlapping tiles is the only way to raise the
// resolution the model actually receives: each tile covers ~1/6 of the sheet
// and is downsampled to 1568 px on its own, so the same symbol arrives around
// 3x larger in each direction. Tiles overlap so a symbol sitting on a cut line
// is whole in at least one of them.
export interface RenderedTile {
  pageNumber: number;
  row: number;
  col: number;
  cols: number;
  rows: number;
  pngBase64: string;
}

const TILE_COLS = 3;
const TILE_ROWS = 2;
const TILE_OVERLAP = 0.08; // fraction of a tile repeated on each side

export async function renderPdfPageTiles(
  filePathOrBuffer: string | Buffer,
  pageNumbers: number[],
  cols = TILE_COLS,
  rows = TILE_ROWS
): Promise<RenderedTile[]> {
  const data = Buffer.isBuffer(filePathOrBuffer) ? new Uint8Array(filePathOrBuffer) : new Uint8Array(await readFile(filePathOrBuffer));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true, canvasFactory: new NodeCanvasFactory() }).promise;

  const tiles: RenderedTile[] = [];
  for (const pageNumber of pageNumbers) {
    if (pageNumber < 1 || pageNumber > pdf.numPages) continue;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const full = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: full.getContext("2d"), viewport }).promise;

    const tileW = viewport.width / cols;
    const tileH = viewport.height / rows;
    const padX = tileW * TILE_OVERLAP;
    const padY = tileH * TILE_OVERLAP;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const sx = Math.max(0, col * tileW - padX);
        const sy = Math.max(0, row * tileH - padY);
        const sw = Math.min(viewport.width - sx, tileW + padX * 2);
        const sh = Math.min(viewport.height - sy, tileH + padY * 2);
        const tile = createCanvas(Math.round(sw), Math.round(sh));
        tile.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, Math.round(sw), Math.round(sh));
        tiles.push({
          pageNumber,
          row: row + 1,
          col: col + 1,
          cols,
          rows,
          pngBase64: tile.toBuffer("image/png").toString("base64"),
        });
      }
    }
  }
  return tiles;
}

// A close-up of one spot on a sheet, cut from a render made specifically for
// it rather than from the tile grid. The tiles answer "what is on this sheet";
// this answers "what exactly is at this point", which is a different question:
// reading which weld mark sits next to a particular valve needs that valve and
// both its neighbouring marks large and together in one frame, and a fixed 3x2
// grid puts them wherever the grid happens to fall.
//
// `region` is in fractions of the page (0-1), x/y being its centre. The render
// scale is chosen so the crop lands near the 1568 px the API downsamples to --
// a tighter region is rendered at a correspondingly higher scale, so detail
// grows as the frame narrows instead of the crop simply getting smaller.
//
// Size the region by what has to be READABLE, not by what has to be VISIBLE. A
// weld mark is a dot with a long leader line out to its number flag, and the
// flag can sit a good way off the pipe: a crop tight enough to hold a valve and
// both its weld dots can still cut off the flags that name them, which makes
// the crop useless for the one question it was cut for. MIN_CROP_FRACTION is
// the floor that stops a caller asking for a frame too small for any leader to
// land in.
export interface RenderedCrop {
  pageNumber: number;
  label: string;
  pngBase64: string;
}

const CROP_TARGET_PX = 1400;
const MIN_CROP_FRACTION = 0.14;

export async function renderPdfPageCrops(
  filePathOrBuffer: string | Buffer,
  pageNumber: number,
  regions: Array<{ label: string; x: number; y: number; w: number; h: number }>
): Promise<RenderedCrop[]> {
  const data = Buffer.isBuffer(filePathOrBuffer) ? new Uint8Array(filePathOrBuffer) : new Uint8Array(await readFile(filePathOrBuffer));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true, canvasFactory: new NodeCanvasFactory() }).promise;
  if (pageNumber < 1 || pageNumber > pdf.numPages) return [];
  const page = await pdf.getPage(pageNumber);

  const crops: RenderedCrop[] = [];
  for (const region of regions) {
    const w = Math.min(1, Math.max(MIN_CROP_FRACTION, region.w));
    const h = Math.min(1, Math.max(MIN_CROP_FRACTION, region.h));

    // Render the whole page at whatever scale makes THIS region come out near
    // the target size, capped so a very tight crop cannot blow up the canvas.
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(12, Math.max(1, CROP_TARGET_PX / (base.width * w)));
    const viewport = page.getViewport({ scale });
    if (Math.max(viewport.width, viewport.height) > 16000) continue;

    const full = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: full.getContext("2d"), viewport }).promise;

    const cw = viewport.width * w;
    const ch = viewport.height * h;
    const sx = Math.max(0, Math.min(viewport.width - cw, viewport.width * region.x - cw / 2));
    const sy = Math.max(0, Math.min(viewport.height - ch, viewport.height * region.y - ch / 2));

    const crop = createCanvas(Math.round(cw), Math.round(ch));
    crop.getContext("2d").drawImage(full, sx, sy, cw, ch, 0, 0, Math.round(cw), Math.round(ch));
    crops.push({ pageNumber, label: region.label, pngBase64: crop.toBuffer("image/png").toString("base64") });
  }
  return crops;
}

export async function renderPdfPages(filePathOrBuffer: string | Buffer, pageNumbers: number[]): Promise<RenderedPage[]> {
  const data = Buffer.isBuffer(filePathOrBuffer) ? new Uint8Array(filePathOrBuffer) : new Uint8Array(await readFile(filePathOrBuffer));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true, canvasFactory: new NodeCanvasFactory() }).promise;

  const rendered: RenderedPage[] = [];
  for (const pageNumber of pageNumbers) {
    if (pageNumber < 1 || pageNumber > pdf.numPages) continue;
    const page = await pdf.getPage(pageNumber);

    // Start from whatever scale keeps the sheet inside the pixel limit, then
    // step down until its encoded size fits too. Pixel count is known up
    // front; encoded size is not (it depends on how dense the drawing is), so
    // that one can only be measured by encoding.
    const base = page.getViewport({ scale: 1 });
    const longestSide = Math.max(base.width, base.height);
    let scale = Math.min(RENDER_SCALE, MAX_IMAGE_DIMENSION / longestSide);

    let pngBase64 = "";
    for (;;) {
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext("2d");
      await page.render({ canvasContext: context, viewport }).promise;
      pngBase64 = canvas.toBuffer("image/png").toString("base64");

      if (pngBase64.length <= MAX_IMAGE_BASE64_BYTES) break;
      if (scale <= MIN_RENDER_SCALE) {
        throw new Error(
          `Page ${pageNumber} still encodes to ${Math.round(pngBase64.length / 1e6)} MB at the minimum render scale ` +
            `(${MIN_RENDER_SCALE}x, ${Math.round(viewport.width)}x${Math.round(viewport.height)}) -- too large to send.`
        );
      }
      scale = Math.max(MIN_RENDER_SCALE, scale * 0.75);
    }

    rendered.push({ pageNumber, pngBase64 });
  }
  return rendered;
}
