// A sheet number as a reader says it: "1 of 5", never "1/5".
//
// Title blocks print the sheet every which way -- "1/5", "1 / 5", "SHEET 1 OF 5",
// "1 OF 5" -- and the extraction keeps what was printed. This turns any of those
// into one form for display. Anything it does not recognise (a lone "3", a page
// fallback like "page 4") is returned as it was rather than guessed at.
export function sheetLabel(raw: string | null | undefined): string {
  const text = String(raw ?? "").trim();
  const m = /^(?:sheet\s*|sht\.?\s*)?(\d+)\s*(?:\/|of)\s*(\d+)$/i.exec(text);
  return m ? `${Number(m[1])} of ${Number(m[2])}` : text;
}
