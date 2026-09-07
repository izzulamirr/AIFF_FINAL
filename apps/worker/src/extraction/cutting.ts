import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_CUTTING_SHEETS_TOOL,
  CUTTING_ITEMS_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import type { CutShape } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages, renderPdfPageTiles } from "../pdfImages";
import { normalizeCellValue } from "./pll";
import { cadFormatOf, readCadEntities } from "./cadRead";
import { partsFromCadEntities } from "./cadGeometry";
import type { DocTypeExtractor, DocumentExtractionResult, OnProgress, TagDraft } from "./types";

interface LocateCuttingResult {
  sheets: Array<{ drawing_number?: string; sheet?: string; title?: string; pages: PageRange }>;
}

interface CuttingSheetResult {
  drawing_number?: string;
  sheet?: string;
  revision?: string;
  title?: string;
  plate_size?: string;
  plate_length_mm?: number;
  plate_width_mm?: number;
  plate_thickness?: string;
  material?: string;
  units?: string;
  notes?: string[];
  parts: Array<{
    part_mark?: string;
    length_mm?: number;
    width_mm?: number;
    shape?: string;
    thickness_mm?: number;
    material?: string;
    quantity?: number;
    grain_direction?: string;
    dimension_figures?: string[];
  }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("plate cutting drawing");

function pageRangeToNumbers(range: PageRange): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) numbers.push(n);
  return numbers;
}

function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function normalizeShape(value: unknown): CutShape {
  const s = String(value ?? "").trim().toLowerCase();
  if (s.startsWith("rect") || s.startsWith("square")) return "rectangle";
  if (s.startsWith("circ") || s.startsWith("disc") || s.startsWith("disk") || s.startsWith("ring") || s.startsWith("round")) return "circle";
  // Anything else is treated as a cut profile, which is the conservative
  // reading: a profile reserves its whole box, a rectangle claims the box IS
  // the part. Guessing "rectangle" wrongly would understate nothing but would
  // tell a reviewer the outline is square when it is not.
  return "profile";
}

// Dimensions are read off the drawing as printed figures. A figure that came
// back as a string ("2318.55", "Ø438.79") is still usable -- the leading
// number is the dimension -- but a figure that parses to nothing is not, and
// a part with no size cannot be nested.
function toMm(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const match = String(value ?? "").match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// A cutting sheet is one drawing per page, densely packed with parts that
// carry no table to fall back on. Everything worth reading -- the part marks
// in their CAD stroke font, the dimension figures, which figure belongs to
// which part -- is small line work on a large-format sheet, so the tiling the
// ISO and hook-up extractors use is not an optimisation here, it is the only
// way the marks are legible at all.
// A CAD file is read, not interpreted. The outlines are in it as geometry, so
// there is nothing for a model to judge and nothing to spend on an API call --
// and the result is deterministic, which a plan that gets signed has to be.
async function extractCuttingFromCad(
  buffer: Buffer,
  format: "dwg" | "dxf",
  onProgress?: OnProgress
): Promise<DocumentExtractionResult> {
  onProgress?.({ phase: "cad", current: 0, total: 2, detail: `reading ${format.toUpperCase()}` });
  const entities = await readCadEntities(buffer, format);
  if (entities.length === 0) {
    throw new Error(
      `No geometry found in this ${format.toUpperCase()}. If it was exported from a viewer rather than from CAD it may hold only a raster image.`
    );
  }

  onProgress?.({ phase: "cad", current: 1, total: 2, detail: "building outlines" });
  const read = partsFromCadEntities(entities);
  if (read.parts.length === 0) {
    throw new Error(
      `Read ${entities.length} entities from this ${format.toUpperCase()} but none of them closed into a part outline. ` +
        `Layers seen: ${read.layers.map((l) => `${l.layer} (${l.entities})`).join(", ")}.`
    );
  }

  const usedLayers = read.layers.filter((l) => l.used);
  const doubtful = usedLayers.every((l) => l.closureScore < 0.6);

  const tags: TagDraft[] = read.parts.map((part) => ({
    tagType: "cut_item" as const,
    tagNumber: part.partNo,
    sourcePage: 1,
    attributes: {
      part_mark: null,
      // The DWG carries no text for these marks -- they are drawn as line
      // work, which is exactly why the PDF had to be read as a picture. So the
      // parts are numbered by size and the real marks stay with the PDF
      // extraction, to be matched by eye.
      marked: false,
      // The X and Y extents as drawn, NOT long-side-first. The outline below
      // is in this same frame -- origin at the top-left of this box, x across,
      // y down -- so swapping these to put the long side first would leave a
      // tall part sitting in a wide box with its profile hanging out the side.
      // Which way round the part goes on the plate is the nester's decision,
      // and it turns the outline with the box when it makes it.
      length_mm: part.widthMm,
      width_mm: part.heightMm,
      shape: "profile",
      thickness_mm: null,
      thickness_source: null,
      material: null,
      quantity: part.quantity,
      grain_direction: null,
      rotatable: true,
      dimension_figures: [],
      // What makes this different from the PDF read: the actual cut line.
      outline_path: part.outlinePath,
      outline_rings: part.rings,
      outline_ring_info: part.ringInfo,
      net_area_mm2: part.netAreaMm2,
      fill_ratio: part.fillRatio,
      geometry_source: format,
      at_x_mm: part.atXMm,
      at_y_mm: part.atYMm,
      open_loops: part.openLoops,
    },
  }));

  return {
    rawJson: {
      source: format,
      entities: entities.length,
      pieces: read.pieces,
      totalMetalM2: +(read.totalMetalMm2 / 1e6).toFixed(3),
      totalBoxM2: +(read.totalBoxMm2 / 1e6).toFixed(3),
      layers: read.layers,
      doubtful,
      parts: read.parts.map((p) => ({
        partNo: p.partNo,
        widthMm: p.widthMm,
        heightMm: p.heightMm,
        quantity: p.quantity,
        netAreaMm2: p.netAreaMm2,
        fillRatio: p.fillRatio,
        entities: p.entityCount,
        loops: p.rings.length,
        openLoops: p.openLoops,
      })),
    },
    tags,
  };
}

export const extractCuttingDocument: DocTypeExtractor = async (pages, apiKey, onProgress, pdfBuffer, context) => {
  // A DWG or DXF goes down the geometry path. Everything below it -- the
  // vision read of a plotted sheet -- is the fallback for when only the PDF
  // exists, and it can only ever recover sizes, never the profile.
  const cadFormat = cadFormatOf(context?.fileName ?? "");
  if (cadFormat) {
    if (!pdfBuffer) throw new Error("The CAD file was not passed to the extractor.");
    return extractCuttingFromCad(pdfBuffer, cadFormat, onProgress);
  }

  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const allPageNumbers = pages.map((p) => p.pageNumber);
  const renderedPages = pdfBuffer ? await renderPdfPages(pdfBuffer, allPageNumbers) : [];
  const imageByPage = new Map(renderedPages.map((r) => [r.pageNumber, r.pngBase64]));
  const renderedTiles = pdfBuffer ? await renderPdfPageTiles(pdfBuffer, allPageNumbers) : [];
  const tilesByPage = new Map<number, typeof renderedTiles>();
  for (const tile of renderedTiles) {
    const list = tilesByPage.get(tile.pageNumber) ?? [];
    list.push(tile);
    tilesByPage.set(tile.pageNumber, list);
  }

  const locate = await callWithRetry(() =>
    callTool<LocateCuttingResult>(client, {
      tool: LOCATE_CUTTING_SHEETS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText:
        `${fullText}\n\nThe attached page image(s) are the actual drawing content -- use them as the primary source. ` +
        `The text above is only the dimension figures the CAD export left behind: the part marks are drawn as line work and are NOT in it. ` +
        `Identify every cutting SHEET via the locate_cutting_sheets tool call: one entry per sheet, each with its own single-page range.`,
      maxTokens: 8000,
      useThinking: true,
      images: renderedPages.map((r) => r.pngBase64),
    })
  );

  // One sheet per page, same as the hook-up and legend sets. A locate step
  // that returns nothing, or folds the whole document into one range, must
  // not cost us every page but the first.
  const located = asArray(locate.sheets).flatMap((sheet) => {
    const numbers = pageRangeToNumbers(sheet.pages).filter((n) => imageByPage.has(n) || pageList.some((p) => p.pageNumber === n));
    if (numbers.length <= 1) return [sheet];
    return numbers.map((n) => ({ ...sheet, pages: { start: n, end: n } as PageRange }));
  });
  const locatedSheets: LocateCuttingResult["sheets"] =
    located.length > 0 ? located : allPageNumbers.map((n) => ({ pages: { start: n, end: n } as PageRange }));
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ pageNumber: number; result: CuttingSheetResult }> = [];
  for (let i = 0; i < locatedSheets.length; i++) {
    const sheet = locatedSheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const sheetImages = pageRangeToNumbers(sheet.pages)
      .map((n) => imageByPage.get(n))
      .filter((img): img is string => Boolean(img));
    const sheetTiles = pageRangeToNumbers(sheet.pages).flatMap((n) => tilesByPage.get(n) ?? []);

    const result = await callWithRetry(() =>
      callTool<CuttingSheetResult>(client, {
        tool: CUTTING_ITEMS_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\nThis is cutting sheet ${sheet.sheet ?? `page ${sheet.pages.start}`}${sheet.title ? ` -- "${sheet.title}"` : ""}. ` +
          `The text above is the sheet's dimension figures as the CAD export stored them -- every figure on the drawing is in that list, ` +
          `so use it to get the digits EXACTLY right, and use the images to decide which figure belongs to which part. ` +
          `The FIRST image is the whole sheet. ` +
          (sheetTiles.length
            ? `The REMAINING ${sheetTiles.length} images are overlapping close-up tiles of it, in reading order, at far higher resolution. The part marks are drawn in a CAD stroke font and are only legible in the TILES -- read them there. Adjacent tiles OVERLAP, so a part appearing in two tiles is ONE part, and a part cut by a tile edge is the same part continuing in the next tile. `
            : "") +
          `Record every plate part via the record_cutting_items tool call.\n\n` +
          `WHAT A CUTTING SHEET IS. Each part is drawn to scale as its true outline -- mostly irregular profiles: gussets with a pipe ` +
          `radius bitten out, wedges, lugs, arms -- and around each one a BOX is drawn to its overall extent, with a figure on the side ` +
          `and a figure on the end. That box is what the nesting plan reserves on the plate, so those two figures are the two this ` +
          `extraction exists to capture. Read them from the printed figures; NEVER scale them off the picture.\n\n` +
          `THE PART MARK IS THE KEY. It is lettered on or beside each part ("BT1A-0107-6-1001", "BMA-6250-4-1004") and is frequently ` +
          `turned 90 degrees to read up the part rather than across it. Read it in that orientation rather than skipping it. A part ` +
          `recorded without its mark cannot be found on the plate once it is cut.\n\n` +
          `COUNT EVERY PART. The small parts sit in the gaps between the large ones and are the easiest to miss; a part left out is a ` +
          `part that never gets cut. Where the same mark is drawn more than once, that is ONE part with a quantity, not two parts.\n\n` +
          `THE STOCK PLATE. A cutting sheet usually names the plate it is all to be cut from, in the title block or a note -- ` +
          `"PLATE SIZE : PL 50mm X 3000mm X 12000mm", "MATERIAL TYPE/GRADE : TYPE I". Capture that string verbatim in plate_size and ` +
          `split it into plate_length_mm / plate_width_mm / plate_thickness. Read the three figures in the order the drawing gives them ` +
          `and sort them by magnitude: the largest is the length, the middle the width, the smallest the thickness. Getting this right ` +
          `saves the planner guessing the stock, and the cutting allowances are derived from that thickness.

` +
          `THICKNESS. Record a thickness ONLY where the drawing states one -- a general note, a title block, a callout against the part. ` +
          `A cutting plot from model space frequently states none at all, and that is a legitimate answer: leave it blank. Do NOT read a ` +
          `thickness out of the part mark, however much one of its digits may look like one.`,
        maxTokens: 16000,
        useThinking: true,
        images: [...sheetImages, ...sheetTiles.map((t) => t.pngBase64)],
      })
    );
    allSheets.push({ pageNumber: sheet.pages.start, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locatedSheets.length, detail: sheet.title ?? sheet.sheet ?? `page ${sheet.pages.start}` });
  }

  const tags: TagDraft[] = [];
  const n = normalizeCellValue;
  for (const { pageNumber, result } of allSheets) {
    const sheetThickness = toMm(result.plate_thickness);
    const sheetAttrs = {
      drawing_number: n(result.drawing_number),
      sheet: n(result.sheet),
      revision: n(result.revision),
      title: n(result.title),
      units: n(result.units) ?? "mm",
      sheet_thickness_mm: sheetThickness,
      sheet_thickness_text: n(result.plate_thickness),
      sheet_material: n(result.material),
      // The stock plate the drawing itself names. Where it is stated there is
      // nothing for a planner to choose: this IS the plate being cut, and the
      // allowances follow from its thickness.
      sheet_plate_size: n(result.plate_size),
      sheet_plate_length_mm: toMm(result.plate_length_mm),
      sheet_plate_width_mm: toMm(result.plate_width_mm),
      notes: asArray(result.notes).map((note) => n(note)).filter(Boolean),
    };

    let unmarked = 0;
    for (const part of asArray(result.parts)) {
      const lengthMm = toMm(part.length_mm);
      const widthMm = toMm(part.width_mm);
      // The two figures are named length and width, but a drawing dimensions
      // a box whichever way round suits it. The nest does not care which is
      // which -- it cares that the long side is the long side.
      const long = lengthMm != null && widthMm != null ? Math.max(lengthMm, widthMm) : lengthMm ?? widthMm;
      const short = lengthMm != null && widthMm != null ? Math.min(lengthMm, widthMm) : lengthMm ?? widthMm;

      // An unmarked part still has to be cut, so it is kept and given a
      // positional name rather than dropped for want of a key -- the
      // pipeline discards a tag with an empty tag number.
      const mark = n(part.part_mark) ?? `UNMARKED-${pageNumber}-${++unmarked}`;
      const quantity = Number.isFinite(part.quantity) && (part.quantity ?? 0) > 0 ? Math.round(part.quantity!) : 1;
      const grain = n(part.grain_direction);

      tags.push({
        tagType: "cut_item",
        tagNumber: mark,
        sourcePage: pageNumber,
        attributes: {
          ...sheetAttrs,
          part_mark: n(part.part_mark),
          marked: Boolean(n(part.part_mark)),
          length_mm: long,
          width_mm: short,
          shape: normalizeShape(part.shape),
          // A thickness stated against the part wins over one stated for the
          // sheet; where neither exists the nest assumes the stock, and says
          // so, rather than dropping the part.
          thickness_mm: toMm(part.thickness_mm) ?? sheetThickness,
          thickness_source: toMm(part.thickness_mm) != null ? "part" : sheetThickness != null ? "sheet" : null,
          material: n(part.material) ?? sheetAttrs.sheet_material,
          quantity,
          grain_direction: grain,
          // A called-out rolling direction fixes the part's orientation on
          // the plate: turning it would satisfy the geometry and break the
          // spec, so the nester is told it may not.
          rotatable: !grain,
          dimension_figures: asArray(part.dimension_figures).map((f) => n(f)).filter(Boolean),
        },
      });
    }
  }

  return { rawJson: { sheets: allSheets }, tags };
};
