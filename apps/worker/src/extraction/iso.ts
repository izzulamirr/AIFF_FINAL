import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_ISO_SECTIONS_TOOL,
  ISO_SHEET_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { enrichIsoLineAttrs, normalizeSlope } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages } from "../pdfImages";
import { normalizeCellValue } from "./pll";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocateIsoResult {
  sheets: Array<{ drawing_number: string; pages: PageRange }>;
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
  bom_items: Array<{
    item_no: string;
    description: string;
    component_type?: string;
    size?: string;
    quantity?: string;
    material?: string;
    item_code?: string;
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
      userText: `${fullText}\n\nThe attached page image(s) are the actual drawing content -- use them as the primary source, the text above (if any) is often just a footer/watermark. Identify each isometric drawing's page range via the locate_iso_sheets tool call.`,
      maxTokens: 8000,
      useThinking: true,
      images: renderedPages.map((r) => r.pngBase64),
    })
  );

  if (!locate.sheets || locate.sheets.length === 0) {
    throw new Error("locate_iso_sheets found no drawings in this document.");
  }
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ drawing_number: string; result: IsoSheetResult }> = [];
  for (let i = 0; i < locate.sheets.length; i++) {
    const sheet = locate.sheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const sheetImages = pageRangeToNumbers(sheet.pages)
      .map((n) => imageByPage.get(n))
      .filter((img): img is string => Boolean(img));
    const result = await callWithRetry(() =>
      callTool<IsoSheetResult>(client, {
        tool: ISO_SHEET_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText:
          `${sheetText}\n\nThis is isometric drawing "${sheet.drawing_number}". The attached page image(s) are the actual drawing -- ` +
          `read the title block and Bill of Material table directly from the image(s); the text above (if any) is often just a footer/watermark, not the real content. ` +
          `Extract the full title block (document number, drawing number, line number, size, spec, service, scale, sheet, revision, owner P&ID no., P&ID no., ` +
          `owner GA drawing no., GA drawing no., any slope annotation, design/operating/hydrotest pressure and temperature, painting system, radiograph, test type, insulation spec, insulation thickness) ` +
          `and Bill of Material rows via the record_iso_sheet tool call. ` +
          `For from_location/to_location: trace the drawn pipe run itself from one end to the other -- the start is the callout where the piping begins ` +
          `(equipment/nozzle connection, tie-in flag, or a "CONT'D FROM ..." continuation box) and the end is the callout where it terminates ` +
          `("CONT'D ON ...", equipment/nozzle, or tie-in). These callouts sit at the ends of the drawn pipeline, not in the title block. ` +
          `Read each unit from its column header and append it to the value (e.g. under a "PRESS. kPag" header the value 5 becomes "5 kPag"; under "TEMP. °C" the value 90 becomes "90 °C"; ` +
          `"INSUL/THK(MM)" of 25 becomes "25 mm"). Leave non-numeric placeholders such as NA, NIL. or AMB. exactly as printed. ` +
          `Where one field holds more than one value, join them with " / " -- never a line break.`,
        maxTokens: 16000,
        useThinking: true,
        images: sheetImages,
      })
    );
    allSheets.push({ drawing_number: sheet.drawing_number, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locate.sheets.length, detail: sheet.drawing_number });
  }

  const tags: TagDraft[] = [];
  const n = normalizeCellValue; // collapse any embedded newlines to " / "
  for (const { drawing_number, result } of allSheets) {
    if (result.line_number) {
      const lineNumber = n(result.line_number) ?? result.line_number;
      tags.push({
        tagType: "line",
        tagNumber: lineNumber,
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
        }),
      });
    }
    for (const item of result.bom_items ?? []) {
      tags.push({
        tagType: "bom_item",
        tagNumber: item.item_no,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          description: item.description,
          component_type: item.component_type,
          size: item.size,
          quantity: item.quantity,
          material: item.material,
          item_code: item.item_code,
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
