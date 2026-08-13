// Converts an .xlsx workbook into per-sheet text "pages" for the text-based
// extractors (PLL/H&MB/spec) -- each worksheet becomes one page of
// tab-separated rows, so Claude sees the same tabular text it would get
// from a CSV export of that sheet.
import ExcelJS from "exceljs";
import type { ExtractedPage } from "./pdfText";

// ExcelJS's cell.text returns the STORED value, ignoring the cell's number
// format -- which is not what the engineer reading the sheet sees, and on a
// line list the difference changes the engineering meaning:
//
//   RADIOGRAPHY   stored 1        format "0%"            shown as 100%
//   TEST PRESSURE stored 42.150000000000006
//                                 format "#,##0.0"       shown as 42.2
//
// Both went into extraction verbatim, so a 100% NDT requirement was recorded
// as "1 %" and a test pressure disagreed with the ISO's 42.2 barg by pure
// float noise. Excel stores a percentage as its fraction, so the "1" is not
// a typo in the source workbook -- it is the format that carries the meaning.
//
// This is not a full number-format engine (dates, colours, conditional
// sections and text placeholders are left to cell.text); it handles the two
// cases that silently corrupt values, and otherwise just trims IEEE noise.
function decimalsIn(numFmt: string): number | null {
  // Take the first format section -- "#,##0.0;[Red]#,##0.0" is positive;negative.
  const section = numFmt.split(";")[0];
  const match = section.match(/\.(0+)/);
  return match ? match[1].length : null;
}

export function formatCellText(cell: { text?: string; value: unknown; numFmt?: string }): string {
  const raw = cell.value;
  // A formula cell holds { formula, result }; the result is what is displayed.
  const value = raw && typeof raw === "object" && "result" in raw ? (raw as { result: unknown }).result : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return cell.text ?? "";

  const numFmt = cell.numFmt ?? "";
  const decimals = decimalsIn(numFmt);
  if (numFmt.includes("%")) {
    const pct = value * 100;
    return `${decimals != null ? pct.toFixed(decimals) : String(Number(pct.toPrecision(12)))}%`;
  }
  if (decimals != null) return value.toFixed(decimals);
  // An integer format ("#,##0") is deliberately NOT applied: Excel would show
  // a density of 779.7 as 780, and rounding real precision away cannot be
  // undone, whereas carrying the extra digit costs nothing.
  // No format to follow: 42.150000000000006 is an artifact of the arithmetic
  // that produced it, not a precision the sheet is asserting.
  return String(Number(value.toPrecision(12)));
}

export async function extractXlsxPages(buffer: Buffer): Promise<ExtractedPage[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const pages: ExtractedPage[] = [];
  // Sequential numbering, NOT ExcelJS's sheetId -- workbook-internal sheet
  // ids can repeat or skip (sheets deleted/copied in Excel), which violated
  // document_pages' (document_id, page_number) unique constraint on a real
  // upload.
  workbook.eachSheet((sheet) => {
    const rows: string[] = [`[Worksheet: ${sheet.name}]`];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(formatCellText(cell));
      });
      rows.push(cells.join("\t"));
    });
    pages.push({ pageNumber: pages.length + 1, pageText: rows.join("\n").trim() || null });
  });
  return pages;
}
