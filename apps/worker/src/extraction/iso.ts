import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_ISO_SECTIONS_TOOL,
  ISO_SHEET_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { enrichIsoLineAttrs, normalizeSlope, assignItemSpec, parsePressureRating } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages } from "../pdfImages";
import { normalizeCellValue } from "./pll";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocateIsoResult {
  sheets: Array<{ drawing_number: string; sheet?: string; pages: PageRange }>;
}

interface IsoSheetResult {
  document_number?: string;
  drawing_number?: string;
  line_number: string;
  size?: string;
  spec_class?: string;
  service?: string;
  from_location?: string;
  to_location?: string;
  slope?: string;
  scale?: string;
  sheet?: string;
  revision?: string;
  owner_pid_no?: string;
  pid_no?: string;
  owner_ga_dwg_no?: string;
  ga_dwg_no?: string;
  design_pressure?: string;
  design_temperature?: string;
  operating_pressure?: string;
  operating_temperature?: string;
  hydrotest_pressure?: string;
  hydrotest_temperature?: string;
  painting_system?: string;
  radiograph?: string;
  test_type?: string;
  insul_spec?: string;
  insul_thickness_mm?: string;
  spec_breaks?: Array<{ spec_class: string; location_note?: string; rating?: string }>;
  bom_items: Array<{
    item_no: string;
    description: string;
    component_type?: string;
    size?: string;
    quantity?: string;
    material?: string;
    item_code?: string;
    item_spec_class?: string;
    item_spec_basis?: string;
  }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("piping isometric drawing");

function pageRangeToNumbers(range: PageRange): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) numbers.push(n);
  return numbers;
}

// Isometric drawings are graphics-heavy CAD exports -- the title block,
// line callouts, and BOM table are usually vector art with little or no
// real text layer (confirmed on a real upload: plain text extraction
// yielded only a footer watermark, nothing else). Page images are sent to
// Claude alongside whatever text does exist, rather than relying on text
// extraction alone like the other document types.
export const extractIsoDocument: DocTypeExtractor = async (pages, apiKey, onProgress, pdfBuffer) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const allPageNumbers = pages.map((p) => p.pageNumber);
  const renderedPages = pdfBuffer ? await renderPdfPages(pdfBuffer, allPageNumbers) : [];
  const imageByPage = new Map(renderedPages.map((r) => [r.pageNumber, r.pngBase64]));

  const locate = await callWithRetry(() =>
    callTool<LocateIsoResult>(client, {
      tool: LOCATE_ISO_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText:
        `${fullText}\n\nThe attached page image(s) are the actual drawing content -- use them as the primary source, the text above (if any) is often just a footer/watermark. ` +
        `Identify every isometric SHEET via the locate_iso_sheets tool call: one entry per sheet, each with its own single-page range. ` +
        `Sheets of a multi-sheet drawing repeat the same drawing number and differ only by the title block's "SHEET n OF m" -- read that field on each page and return a separate entry per page, never one entry spanning them.`,
      maxTokens: 8000,
      useThinking: true,
      images: renderedPages.map((r) => r.pngBase64),
    })
  );

  if (!locate.sheets || locate.sheets.length === 0) {
    throw new Error("locate_iso_sheets found no drawings in this document.");
  }

  // Guard: sheets of a multi-sheet drawing share one drawing number and
  // differ only by "SHEET n OF m", so locate can collapse them into a single
  // multi-page entry -- which then extracts only the first sheet's BOM and
  // silently loses the rest (seen on a real 3-sheet drawing: 11 of 45 rows).
  // Any entry spanning several pages is split into one entry per page, so
  // every sheet is always read on its own.
  const locatedSheets = locate.sheets.flatMap((sheet) => {
    const numbers = pageRangeToNumbers(sheet.pages).filter((n) => imageByPage.has(n) || pageList.some((p) => p.pageNumber === n));
    if (numbers.length <= 1) return [sheet];
    return numbers.map((n) => ({ ...sheet, pages: { start: n, end: n } as PageRange }));
  });
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ drawing_number: string; pageNumber: number; result: IsoSheetResult }> = [];
  for (let i = 0; i < locatedSheets.length; i++) {
    const sheet = locatedSheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const sheetImages = pageRangeToNumbers(sheet.pages)
      .map((n) => imageByPage.get(n))
      .filter((img): img is string => Boolean(img));
    const result = await callWithRetry(() =>
      callTool<IsoSheetResult>(client, {
        tool: ISO_SHEET_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\nThis is isometric drawing "${sheet.drawing_number}"${sheet.sheet ? `, sheet ${sheet.sheet}` : ""} -- page ${sheet.pages.start} of the document. The attached page image is THIS sheet only, so extract only the title block and BOM printed on it -- ` +
          `read the title block and Bill of Material table directly from the image(s); the text above (if any) is often just a footer/watermark, not the real content. ` +
          `Extract the full title block (document number, drawing number, line number, size, spec, service, scale, sheet, revision, owner P&ID no., P&ID no., ` +
          `owner GA drawing no., GA drawing no., any slope annotation, design/operating/hydrotest pressure and temperature, painting system, radiograph, test type, insulation spec, insulation thickness) ` +
          `and Bill of Material rows via the record_iso_sheet tool call. ` +
          `For from_location/to_location: trace the drawn pipe run itself from one end to the other -- the start is the callout where the piping begins ` +
          `(equipment/nozzle connection, tie-in flag, or a "CONT'D FROM ..." continuation box) and the end is the callout where it terminates ` +
          `("CONT'D ON ...", equipment/nozzle, or tie-in). These callouts sit at the ends of the drawn pipeline, not in the title block. ` +
          `Read each unit from its column header and append it to the value (e.g. under a "PRESS. kPag" header the value 5 becomes "5 kPag"; under "TEMP. °C" the value 90 becomes "90 °C"; ` +
          `"INSUL/THK(MM)" of 25 becomes "25 mm"). Leave non-numeric placeholders such as NA, NIL. or AMB. exactly as printed. ` +
          `Where one field holds more than one value, join them with " / " -- never a line break.\n\n` +
          `SPEC BREAKS: check the drawing for "MATL <class>" callout boxes -- a pair of them either side of a joint marks a material/spec break, and the continuation line number may carry a different class too. Record every class present under spec_breaks (including the title-block class) with its pressure class in rating. ` +
          `Then set item_spec_class on EVERY BOM row: a spec break is a point on the run, so each item sits on one definite side. ` +
          `Place un-rated rows (plain pipe, weldolets, butt-weld elbows/tees/reducers) by POSITION -- follow the row's item-number balloons to where they sit on the drawn run and decide whether that point is upstream or downstream of the "MATL" callouts. A repeated item code split across two rows is the giveaway that one row is each side (e.g. pipe 28.1M on the long upstream run vs pipe 1.5M on the short stub past the break; 7 elbows upstream vs 1 downstream) -- place each row by where its balloons actually are, and record item_spec_basis "position". ` +
          `Place rated rows AWAY FROM THE BREAK JOINT by their own rating (item_spec_basis "rating"): a "150# RF" flange, gasket, "150RF" bolt or 150# valve is the 150# class, a "300# RF" one or an alloy-overlay valve is the 300# class. ` +
          `CRITICAL: rating does NOT identify the side AT the break joint, because that joint is rate-matched to the HIGHER class -- the mating flange on the lower-rated side, the joint gasket and its bolts are all made to the higher rating so they bolt together, yet the flange still BELONGS to the lower class because the break is at the joint face, after it. On a 150#/300# break a 300# flange sitting upstream of the MATL callout is a 150#-class item rate-matched up, NOT a 300#-class item. Place break-joint hardware by POSITION, basis "position (rate-matched to the higher class)". ` +
          `Never place by rating where the rating comes from the component's own standard either: ASME B16.36 orifice flanges and their gaskets start at 300#, so a 150# line's orifice assembly is 300# with no break involved -- place those by position. ` +
          `A sheet with no "MATL" callouts has no break on it: set item_spec_class to the title-block class for every row on that sheet, basis "sheet has no spec break".`,
        maxTokens: 16000,
        useThinking: true,
        images: sheetImages,
      })
    );
    allSheets.push({ drawing_number: sheet.drawing_number, pageNumber: sheet.pages.start, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locatedSheets.length, detail: `${sheet.drawing_number}${sheet.sheet ? ` sheet ${sheet.sheet}` : ""}` });
  }

  const tags: TagDraft[] = [];
  const n = normalizeCellValue; // collapse any embedded newlines to " / "
  for (const { drawing_number, pageNumber, result } of allSheets) {
    // Classes present on this sheet, with their pressure class where known --
    // the basis for placing each BOM item when the drawing has a spec break.
    const specsWithRatings = (result.spec_breaks ?? []).map((b) => ({
      spec_class: b.spec_class,
      location_note: b.location_note,
      rating: parsePressureRating(b.rating) ?? (b.rating ? Number(String(b.rating).replace(/\D/g, "")) || null : null),
    }));

    if (result.line_number) {
      const lineNumber = n(result.line_number) ?? result.line_number;
      tags.push({
        tagType: "line",
        tagNumber: lineNumber,
        // The sheet this row was read from -- a multi-sheet drawing's BOM is
        // per sheet, and a spec break can apply to one sheet only, so the
        // page is what ties a row to its sheet (see the BOM-by-spec view).
        sourcePage: pageNumber,
        // enrichIsoLineAttrs decodes the line-number convention
        // (size-service-class-unique-insulation-heattrace) and fills any
        // field the title block left blank or as an "XX.XX" placeholder.
        attributes: enrichIsoLineAttrs(lineNumber, {
          drawing_number: n(result.drawing_number) ?? drawing_number,
          document_number: n(result.document_number),
          size: n(result.size),
          spec_class: n(result.spec_class),
          service: n(result.service),
          from_location: n(result.from_location),
          to_location: n(result.to_location),
          slope: normalizeSlope(n(result.slope)),
          scale: n(result.scale),
          sheet: n(result.sheet),
          revision: n(result.revision),
          owner_pid_no: n(result.owner_pid_no),
          pid_no: n(result.pid_no),
          owner_ga_dwg_no: n(result.owner_ga_dwg_no),
          ga_dwg_no: n(result.ga_dwg_no),
          design_pressure: n(result.design_pressure),
          design_temperature: n(result.design_temperature),
          operating_pressure: n(result.operating_pressure),
          operating_temperature: n(result.operating_temperature),
          hydrotest_pressure: n(result.hydrotest_pressure),
          hydrotest_temperature: n(result.hydrotest_temperature),
          painting_system: n(result.painting_system),
          radiograph: n(result.radiograph),
          test_type: n(result.test_type),
          insul_spec: n(result.insul_spec),
          insul_thickness_mm: n(result.insul_thickness_mm),
          // Every class present on the drawing (a spec break means the line
          // carries two) -- gate 4/7 validate each BOM item against its own
          // class rather than the title block's.
          spec_breaks: specsWithRatings,
        }),
      });
    }
    for (const item of result.bom_items ?? []) {
      tags.push({
        tagType: "bom_item",
        tagNumber: item.item_no,
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          description: item.description,
          component_type: item.component_type,
          size: item.size,
          quantity: item.quantity,
          material: item.material,
          item_code: item.item_code,
          // The class governing THIS item on a spec-break drawing. Falls back
          // to a deterministic rating match (150# -> the 150# class, 300# ->
          // the 300# class) when the extraction left it blank; stays blank for
          // items with no rating signature rather than guessing a side.
          item_spec_class:
            n(item.item_spec_class) ??
            assignItemSpec(`${item.description ?? ""} ${item.item_code ?? ""}`, specsWithRatings)?.spec_class,
          // How the class was decided, so a reviewer can audit it: the
          // extraction reports its own basis (position/rating/rate-matched),
          // and the deterministic rating fallback labels itself.
          item_spec_basis:
            n(item.item_spec_basis) ??
            (n(item.item_spec_class)
              ? undefined
              : assignItemSpec(`${item.description ?? ""} ${item.item_code ?? ""}`, specsWithRatings)
                ? "rating"
                : undefined),
          // The line's own spec class (e.g. "150JY11") -- item_code (e.g.
          // "P9610-C") is what should be looked up within that class's
          // pipes/fittings/flanges/valves, not compared as if it were a
          // class code itself (see verifyIso.ts).
          spec_class: result.spec_class,
        },
      });
    }
  }

  return { rawJson: { sheets: allSheets }, tags };
};
