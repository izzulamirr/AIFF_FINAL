import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_HOOKUP_SHEETS_TOOL,
  HOOKUP_SHEET_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import type { HookupDiscipline } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages, renderPdfPageTiles } from "../pdfImages";
import { normalizeCellValue } from "./pll";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocateHookupResult {
  sheets: Array<{ drawing_number?: string; sheet?: string; title?: string; pages: PageRange }>;
}

interface HookupSheetResult {
  drawing_number?: string;
  sheet?: string;
  revision?: string;
  title?: string;
  instrument_type?: string;
  measured_variable?: string;
  service?: string;
  mounting?: string;
  slope?: string;
  discipline_break_note?: string;
  notes?: string[];
  implied_items?: Array<{
    description: string;
    size?: string;
    quantity?: string;
    discipline?: string;
    deferred_to?: string;
    source_note?: string;
  }>;
  bom_items: Array<{
    item_no?: string;
    quantity?: string;
    size?: string;
    description: string;
    material?: string;
    discipline?: string;
    discipline_basis?: string;
  }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("typical instrument hook-up drawing");

function pageRangeToNumbers(range: PageRange): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) numbers.push(n);
  return numbers;
}

function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

// The model is asked for one of three words; anything else is treated as
// unplaced rather than silently trusted, so a typo cannot quietly move a
// component into the piping scope a reviewer is then held to.
function normalizeDiscipline(value: unknown): HookupDiscipline {
  const s = String(value ?? "").trim().toLowerCase();
  if (s.startsWith("pip")) return "piping";
  if (s.startsWith("inst")) return "instrument";
  return "undetermined";
}

// Hook-up typicals are single-detail CAD sheets: a small isometric of the
// assembly, a balloon per component, a BOM table and a notes block. The
// balloons and the "BY PIPING | BY INSTR." break line are small annotations,
// so the same tiling the ISO and P&ID extractors use applies here -- the
// discipline of each row is decided by which side of that line its balloon
// falls on, which is unreadable on a downsampled full sheet.
export const extractHookupDocument: DocTypeExtractor = async (pages, apiKey, onProgress, pdfBuffer) => {
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
    callTool<LocateHookupResult>(client, {
      tool: LOCATE_HOOKUP_SHEETS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText:
        `${fullText}\n\nThe attached page image(s) are the actual drawing content -- use them as the primary source; the text above (if any) is often just a footer. ` +
        `Identify every hook-up SHEET via the locate_hookup_sheets tool call: one entry per sheet, each with its own single-page range, ` +
        `and read from each title block what that sheet is a typical for (instrument type and service).`,
      maxTokens: 8000,
      useThinking: true,
      images: renderedPages.map((r) => r.pngBase64),
    })
  );

  // A hook-up set is one sheet per page. If locate returns nothing, or
  // collapses the set into one multi-page entry, fall back to a sheet per
  // page rather than extracting only the first -- the same failure the ISO
  // and legend extractors were bitten by.
  const located = asArray(locate.sheets).flatMap((sheet) => {
    const numbers = pageRangeToNumbers(sheet.pages).filter((n) => imageByPage.has(n) || pageList.some((p) => p.pageNumber === n));
    if (numbers.length <= 1) return [sheet];
    return numbers.map((n) => ({ ...sheet, pages: { start: n, end: n } as PageRange }));
  });
  const locatedSheets: LocateHookupResult["sheets"] =
    located.length > 0 ? located : allPageNumbers.map((n) => ({ pages: { start: n, end: n } as PageRange }));
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ pageNumber: number; result: HookupSheetResult }> = [];
  for (let i = 0; i < locatedSheets.length; i++) {
    const sheet = locatedSheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const sheetImages = pageRangeToNumbers(sheet.pages)
      .map((n) => imageByPage.get(n))
      .filter((img): img is string => Boolean(img));
    const sheetTiles = pageRangeToNumbers(sheet.pages).flatMap((n) => tilesByPage.get(n) ?? []);

    const result = await callWithRetry(() =>
      callTool<HookupSheetResult>(client, {
        tool: HOOKUP_SHEET_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\nThis is hook-up sheet ${sheet.sheet ?? `page ${sheet.pages.start}`}${sheet.title ? ` -- "${sheet.title}"` : ""}. ` +
          `The FIRST image is the whole sheet. ` +
          (sheetTiles.length
            ? `The REMAINING ${sheetTiles.length} images are overlapping close-up tiles of it, in reading order, at far higher resolution. Item balloons, the discipline break line and its "BY PIPING" / "BY INSTR." labels are only legible in the TILES -- read them there. Adjacent tiles OVERLAP, so a component appearing in two tiles is ONE component. `
            : "") +
          `Record the title block, what the sheet is a typical for, and its full BILL OF MATERIALS via the record_hookup_sheet tool call.\n\n` +
          `THE DISCIPLINE SPLIT IS THE POINT OF THIS EXTRACTION. A hook-up typical is supplied by two departments, and a piping engineer can only be held to the piping half. ` +
          `For EVERY BOM row decide which side supplies it, and say how you decided:\n` +
          `1. Follow the row's balloon to the component on the detail, then see which side of the drawn break line it sits on -- that line runs across the assembly and is labelled "BY PIPING" on one side and "BY INSTR." (or "BY INSTRUMENT") on the other. Basis "drawn break".\n` +
          `2. A note naming a supplier decides it outright: "5 VALVE MANIFOLD SHALL BE SUPPLIED BY TRANSMITTER SUPPLIER" and "ORIFICE FLANGE NUTS & BOLTS BY INSTRUMENT" are instrument scope; "AS PER PIPING STANDARD DETAILS" is piping scope. Basis "note", quoting it.\n` +
          `3. ONLY where neither applies, use the rule -- PIPING: the process tap (weldolet/sockolet/nozzle), the root/isolation valve, orifice flanges, anything welded or flanged to the process line. INSTRUMENT: tubing, tube fittings and connectors, branch tees, needle/gauge valves on the tubing, the manifold, the instrument. Basis "rule".\n` +
          `Record the break itself in discipline_break_note, quoted as printed. Also capture every numbered note, and any mounting or slope requirement stated (e.g. "TRANSMITTER SHALL BE MOUNTED BELOW TAPPING POINT", "SLOPE 1:12") -- those are checkable requirements, not decoration.\n\n` +
          `IMPLIED ITEMS: a hook-up sheet frequently itemises only the instrument-scope tubing and fittings and DEFERS the piping-scope components to another document -- "PROCESS CONNECTION SIZE AND TYPE OF ISOLATION VALVE (SBB OR DBB) SHALL BE AS PER PIPING STANDARD DETAILS ... DWG NO. ...". That isolation valve is still required and is piping's to supply. Record every such component under implied_items with its discipline and the note it comes from, plus anything drawn on the detail with a callout but no BOM row (orifice flanges, the process tap). Without these the sheet reads as though piping supplies nothing at all, which is the opposite of the truth.`,
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
    const sheetAttrs = {
      drawing_number: n(result.drawing_number),
      sheet: n(result.sheet),
      revision: n(result.revision),
      title: n(result.title),
      instrument_type: n(result.instrument_type),
      measured_variable: n(result.measured_variable)?.toLowerCase(),
      service: n(result.service)?.toLowerCase(),
      mounting: n(result.mounting),
      slope: n(result.slope),
      discipline_break_note: n(result.discipline_break_note),
      notes: asArray(result.notes).map((note) => n(note)).filter(Boolean),
    };

    // One tag per sheet, so a sheet with an unreadable BOM still surfaces as
    // a typical the project holds rather than vanishing.
    const sheetKey = [sheetAttrs.instrument_type, sheetAttrs.service].filter(Boolean).join(" / ") || sheetAttrs.title || `sheet ${sheetAttrs.sheet ?? pageNumber}`;
    tags.push({
      tagType: "legend_item",
      tagNumber: sheetKey,
      sourcePage: pageNumber,
      attributes: { ...sheetAttrs, kind: "hookup sheet", item_count: asArray(result.bom_items).length },
    });

    // Deferred/un-itemised components are recorded as ordinary hook-up items
    // so the check treats them the same -- they are required either way, and
    // on a sheet that hands every piping component to a standard detail they
    // are the ONLY piping-scope rows there are.
    for (const item of asArray(result.implied_items)) {
      tags.push({
        tagType: "hookup_item",
        tagNumber: n(item.description) ?? item.description,
        sourcePage: pageNumber,
        attributes: {
          ...sheetAttrs,
          item_no: null,
          quantity: n(item.quantity),
          size: n(item.size),
          description: item.description,
          discipline: normalizeDiscipline(item.discipline),
          discipline_basis: n(item.source_note) ?? "implied by the sheet's notes",
          implied: true,
          deferred_to: n(item.deferred_to),
        },
      });
    }

    for (const item of asArray(result.bom_items)) {
      const discipline = normalizeDiscipline(item.discipline);
      tags.push({
        tagType: "hookup_item",
        // Item numbers restart on every sheet, so the sheet's own key is what
        // makes a row identifiable; a row printed without one falls back to
        // its description, as the ISO BOM's added rows do.
        tagNumber: n(item.item_no) ?? n(item.description) ?? item.description,
        sourcePage: pageNumber,
        attributes: {
          ...sheetAttrs,
          item_no: n(item.item_no),
          quantity: n(item.quantity),
          size: n(item.size),
          description: item.description,
          material: n(item.material),
          discipline,
          discipline_basis: n(item.discipline_basis),
        },
      });
    }
  }

  return { rawJson: { sheets: allSheets }, tags };
};
