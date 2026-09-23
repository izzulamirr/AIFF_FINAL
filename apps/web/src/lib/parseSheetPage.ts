// Parses a document_pages.pageText value produced by
// apps/worker/src/spreadsheetText.ts (a "[Worksheet: <name>]" header line
// followed by tab-separated rows) back into structured cells, so a page can
// render an XLSX upload's tabular content without needing a Claude call.
//
// Ported from the sibling AIFF_LATEST project, unchanged. The tab-separated
// "[Worksheet: name]" format it parses is identical between the two repos --
// see spreadsheetText.ts's own extractXlsxPages, which only changed how a
// single cell's TEXT is formatted (percentages, decimals), never the page
// shape this file reads.

export interface ParsedSheetPage {
  worksheetName: string | null;
  headers: string[];
  rows: string[][];
}

export function parseTabSeparatedPage(pageText: string | null): ParsedSheetPage | null {
  if (!pageText) return null;
  const lines = pageText.split("\n");

  const worksheetMatch = lines[0]?.match(/^\[Worksheet: (.*)\]$/);
  const start = worksheetMatch ? 1 : 0;
  const worksheetName = worksheetMatch ? worksheetMatch[1] : null;

  const dataLines = lines.slice(start).filter((l) => l.length > 0);
  if (dataLines.length < 2) return null;

  const headers = dataLines[0].split("\t");
  const rows = dataLines.slice(1).map((l) => l.split("\t"));
  return { worksheetName, headers, rows };
}

export function findColumnIndex(headers: string[], substr: string): number {
  const needle = substr.toLowerCase();
  return headers.findIndex((h) => h.toLowerCase().includes(needle));
}

// Every non-blank column NOT already captured by a named SheetItem field,
// kept in the sheet's own column order (not re-sorted) -- that order is
// already the source's own logical grouping (geometry params, then port/size
// params, then material/admin params), so it's preserved rather than
// alphabetized.
function extraAttributes(headers: string[], row: string[], usedIndices: Set<number>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((header, i) => {
    if (usedIndices.has(i)) return;
    const value = row[i];
    if (value) out.push([header, value]);
  });
  return out;
}

// One row of an item-list-style catalogue export (SPREF / SPEC OF SPCO /
// GTYPE OF CATREF / Catalogue reference / detailing text / material text /
// Size P1-P3) -- the shape confirmed against a real company export. Column
// order is looked up by header name, not fixed index, so a re-ordered or
// re-named export doesn't silently misparse.
export interface SheetItem {
  reference: string;
  type: string;
  specCode: string;
  catalogueRef: string;
  description: string;
  material: string;
  sizeP1: string;
  sizeP2: string;
  sizeP3: string;
  // Every other non-blank column on this row that isn't one of the fields
  // above, in the sheet's own column order -- e.g. for a catalogue export,
  // EndType_S-ALL / FlangeStd_S-ALL / PressureClass_S-ALL / Manufacturer /
  // PartStatus etc., which the named fields above don't have room for.
  attributes: Array<[string, string]>;
}

// Admin item lists carry the real spec text across TWO separate columns --
// RTEXT/"detailing text" (description) and XTEXT/"material text" (material)
// -- neither of which alone is the full spec line (e.g. "PIPE BE EFW, 100%
// RT, ASME B36.10" vs "A672 GR C65, CL12, 100%RT NACE MR0175/ISO 15156, SCH
// 20"). Shared by every page that displays an admin item's own text (as
// opposed to the client spec row it matched against), so they can't drift
// apart on how that combination is formatted.
export function combineAdminText(item: SheetItem): string {
  const desc = item.description.trim();
  const material = item.material.trim();
  if (desc && material) return `${desc},${material}`;
  return desc || material || "(no description)";
}

// Narrows an admin group down to the row(s) that actually apply to one BOM
// item.
//
// WHY THIS IS NEEDED. A client spec sheet states a component as ONE row
// covering a whole range -- `A234 GR WPB, SMLS, LR, BW ASME B16.9(1/2"-24")`
// is a single ELBOW line for every size in that range. The admin take-off
// states the same component as one row PER combination of size, schedule,
// angle and construction, so a group keyed on the matched spec row holds
// 30-odd rows. Every one of them is a legitimate member of that group, so
// nothing was "wrong" -- but printing all of them against a single 80 NS
// SCH40 90-degree elbow buries the one line a reviewer needs in thirty
// lines about SCH20/30/80/160 and 45-degree elbows that this item is not.
//
// An attribute the BOM item states that NO row in the admin group satisfies,
// while the admin rows DO state that attribute -- i.e. the two documents
// contradict each other rather than one of them being silent.
export interface AdminAttributeMismatch {
  attribute: string;
  wanted: string;
  found: string[];
}

export interface AdminMatchNarrowing {
  matches: SheetItem[];
  mismatches: AdminAttributeMismatch[];
}

// A filter that finds NOTHING is the most important result this function can
// produce, and it must never be quietly discarded.
//
// Worked example that forced this design. ISO BOM item 4 is an 80 NS SCH40
// elbow. The AC03N admin take-off holds exactly two DN80 elbow rows and both
// are SCH80 -- there is no SCH40 elbow at that size in it at all. An earlier
// version of this function simply skipped any filter that emptied the list,
// so the schedule filter found no SCH40, declined to apply, and the angle and
// construction filters then narrowed the group to ONE SCH80 row. The reviewer
// was shown a single confident-looking line that silently contradicted the
// BOM it was supposed to confirm -- strictly worse than the thirty-row dump
// it replaced, because thirty rows at least make it obvious that none of them
// says SCH40.
//
// So a filter that empties the list now RECORDS the contradiction instead of
// stepping over it. The distinction that matters is between the admin sheet
// DISAGREEING and the admin sheet being SILENT: BC70N's elbow rows state no
// schedule at all, which is not a conflict and must not be reported as one,
// whereas AC03N states SCH80 explicitly, which is.
export function narrowAdminMatches(matches: SheetItem[], bomItem: { size?: unknown; description?: unknown }): AdminMatchNarrowing {
  const mismatches: AdminAttributeMismatch[] = [];
  if (matches.length === 0) return { matches, mismatches };
  const bomText = String(bomItem.description ?? "").toUpperCase();
  const textOf = (m: SheetItem) => `${m.description} ${m.material}`.toUpperCase();

  let out = matches;
  // `valueOf` returns what a row states for this attribute, or null when the
  // row is silent about it -- silence is what separates a real contradiction
  // from an admin sheet that just doesn't record the attribute.
  const refine = (attribute: string, wanted: string, valueOf: (m: SheetItem) => string | null) => {
    const next = out.filter((m) => valueOf(m) === wanted);
    if (next.length > 0) {
      out = next;
      return;
    }
    const found = [...new Set(out.map(valueOf).filter((v): v is string => v !== null))];
    if (found.length > 0) mismatches.push({ attribute, wanted, found });
  };

  // 1. SIZE, which is COMPOUND for a branch fitting. A weldolet's BOM size
  //    reads "200X80" -- from a 200 NS run to an 80 NS branch -- and the
  //    admin take-off carries those two halves in separate columns: sizeP1 is
  //    the run, sizeP3 the branch (verified against its own olet rows, where
  //    a 200x80 weldolet is P1=200.00, P3=80.00).
  //
  //    Stripping the non-digits out of "200X80" produced the nonsense DN
  //    "20080", which matched nothing, so every size in the sheet was
  //    reported as a mismatch -- the filter was comparing a size that does
  //    not exist against a column that never held one.
  const dnOf = (raw: unknown) => {
    const n = Number(String(raw ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const compoundSize = /^(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)$/.exec(String(bomItem.size ?? "").trim());
  if (compoundSize) {
    refine("size", `${Number(compoundSize[1])} x ${Number(compoundSize[2])} mm`, (m) => {
      const run = dnOf(m.sizeP1);
      const branch = dnOf(m.sizeP3);
      if (run === null) return null;
      return branch === null ? `${run} mm` : `${run} x ${branch} mm`;
    });
  } else {
    const bomDn = dnOf(bomItem.size);
    if (bomDn !== null) refine("size", `${bomDn} mm`, (m) => (dnOf(m.sizeP1) === null ? null : `${dnOf(m.sizeP1)} mm`));
  }

  // 2. SCHEDULE, compound for the same reason. "SCH20XSCH40" is SCH20 on the
  //    run and SCH40 on the branch, and reading only the first token compared
  //    a weldolet's RUN schedule against whatever schedule another row
  //    happened to state first -- so the one genuinely matching row could not
  //    win. Both halves are read now and both are shown in the mismatch, so a
  //    reviewer can see which END of the fitting disagrees.
  //
  //    Schedule is the attribute most worth flagging when it differs: it is
  //    wall thickness, and a fitting on the wrong schedule will not match the
  //    pipe it welds to. Bare STD/XS/XXS are schedules too -- the admin sheet
  //    writes "STD x SCH80" -- but a BARE NUMBER never is, since "200 x 80"
  //    is a size; requiring the SCH prefix on numeric parts keeps the two
  //    apart. XXS is listed before XS so the longer token wins.
  const PART = "(?:SCH\\s*\\.?\\s*\\d+|XXS|XS|STD)";
  const COMPOUND_SCHEDULE = new RegExp(`\\b(${PART})\\s*[xX]\\s*(${PART})\\b`, "i");
  const SINGLE_SCHEDULE = new RegExp(`\\b${PART}\\b`, "i");
  const normPart = (p: string) => p.replace(/[\s.]/g, "").toUpperCase();
  const schedOf = (text: string) => {
    const compound = COMPOUND_SCHEDULE.exec(text);
    if (compound) return `${normPart(compound[1])} x ${normPart(compound[2])}`;
    const single = SINGLE_SCHEDULE.exec(text);
    return single ? normPart(single[0]) : null;
  };
  const bomSched = schedOf(bomText);
  if (bomSched) refine("schedule", bomSched, (m) => schedOf(textOf(m)));

  // 3. ANGLE, for elbows and bends.
  const ANGLE = /\b(\d{2,3})\s*DEG\b/;
  const angleOf = (text: string) => {
    const m = ANGLE.exec(text);
    return m ? `${m[1]}DEG` : null;
  };
  const bomAngle = angleOf(bomText);
  if (bomAngle) refine("angle", bomAngle, (m) => angleOf(textOf(m)));

  // 4. CONSTRUCTION. Seamless and welded are separate procurement items even
  //    at the same size and schedule.
  const CONSTRUCTIONS = ["SMLS", "EFW", "ERW", "WELDED"];
  const constructionOf = (text: string) => CONSTRUCTIONS.find((c) => text.includes(c)) ?? null;
  const bomConstruction = constructionOf(bomText);
  if (bomConstruction) refine("construction", bomConstruction, (m) => constructionOf(textOf(m)));

  // Rows identical once combined add nothing but length.
  const seen = new Set<string>();
  const deduped = out.filter((m) => {
    const key = combineAdminText(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { matches: deduped, mismatches };
}

export function extractSheetItems(pageText: string | null): SheetItem[] {
  const parsed = parseTabSeparatedPage(pageText);
  if (!parsed) return [];

  if (findColumnIndex(parsed.headers, "gtype") !== -1 && findColumnIndex(parsed.headers, "catalogue") !== -1) {
    return extractItemListShape(parsed);
  }
  if (findColumnIndex(parsed.headers, "itemcode") !== -1 && findColumnIndex(parsed.headers, "material") !== -1) {
    return extractCatalogueShape(parsed);
  }
  return []; // not a shape this parser recognizes
}

// Shape 1: a company item-list export -- SPREF / SPEC OF SPCO / GTYPE OF
// CATREF / Catalogue reference / detailing text / material text / Size
// P1-P3, one flat sheet listing every component of every type.
function extractItemListShape(parsed: ParsedSheetPage): SheetItem[] {
  const typeIdx = findColumnIndex(parsed.headers, "gtype");
  const catalogueIdx = findColumnIndex(parsed.headers, "catalogue");
  const refIdx = findColumnIndex(parsed.headers, "spref");
  const specIdx = findColumnIndex(parsed.headers, "spec of");
  const descIdx = findColumnIndex(parsed.headers, "detailing text");
  const materialIdx = findColumnIndex(parsed.headers, "material text");
  const p1Idx = findColumnIndex(parsed.headers, "size p1");
  const p2Idx = findColumnIndex(parsed.headers, "size p2");
  const p3Idx = findColumnIndex(parsed.headers, "size p3");
  const usedIndices = new Set([typeIdx, catalogueIdx, refIdx, specIdx, descIdx, materialIdx, p1Idx, p2Idx, p3Idx].filter((i) => i !== -1));

  const items: SheetItem[] = [];
  for (const row of parsed.rows) {
    const type = row[typeIdx] ?? "";
    if (!type) continue;
    items.push({
      reference: refIdx !== -1 ? row[refIdx] ?? "" : "",
      type,
      specCode: specIdx !== -1 ? row[specIdx] ?? "" : "",
      catalogueRef: row[catalogueIdx] ?? "",
      description: descIdx !== -1 ? row[descIdx] ?? "" : "",
      material: materialIdx !== -1 ? row[materialIdx] ?? "" : "",
      sizeP1: p1Idx !== -1 ? row[p1Idx] ?? "" : "",
      sizeP2: p2Idx !== -1 ? row[p2Idx] ?? "" : "",
      sizeP3: p3Idx !== -1 ? row[p3Idx] ?? "" : "",
      attributes: extraAttributes(parsed.headers, row, usedIndices),
    });
  }
  return items;
}

// Shape 2: an AVEVA/SmartPlant "PnP" piping component catalogue export --
// one worksheet per component type (the worksheet name IS the type, e.g.
// "BALL VALVE"), columns include ItemCode / Material / ShortDescription /
// NominalDiameter_S-ALL / CatalogPartId. This is a parts library, not a
// project piping material spec -- it has no class_code or size-range
// concept, so specCode is left blank.
function extractCatalogueShape(parsed: ParsedSheetPage): SheetItem[] {
  const itemCodeIdx = findColumnIndex(parsed.headers, "itemcode");
  // ItemCode is only populated on some rows (e.g. one "family" row) --
  // confirmed on a real sheet ("PIPE NIPPLE, LONG TYPE") where 9 of 10 real
  // size-variant rows had a blank ItemCode but a real "Sizes" value (the
  // per-size label column, e.g. `1/4"`, `1 1/2"`). Sizes is the reliable
  // per-row identifier for these parametric catalogue sheets, so it's used
  // both as the inclusion filter and as a fallback reference/size.
  const sizesIdx = findColumnIndex(parsed.headers, "sizes");
  const catalogIdx = findColumnIndex(parsed.headers, "catalogpartid");
  const materialIdx = findColumnIndex(parsed.headers, "material");
  const descIdx = findColumnIndex(parsed.headers, "shortdescription");
  const nominalIdx = findColumnIndex(parsed.headers, "nominaldiameter");
  const type = parsed.worksheetName ?? "UNKNOWN";
  const usedIndices = new Set([itemCodeIdx, sizesIdx, catalogIdx, materialIdx, descIdx, nominalIdx].filter((i) => i !== -1));

  const items: SheetItem[] = [];
  for (const row of parsed.rows) {
    const itemCode = itemCodeIdx !== -1 ? row[itemCodeIdx] ?? "" : "";
    const sizesLabel = sizesIdx !== -1 ? row[sizesIdx] ?? "" : "";
    if (!itemCode && !sizesLabel) continue; // no identifying data on this row at all
    items.push({
      reference: itemCode || sizesLabel,
      type,
      specCode: "",
      catalogueRef: catalogIdx !== -1 ? row[catalogIdx] ?? "" : "",
      description: descIdx !== -1 ? row[descIdx] ?? "" : "",
      material: materialIdx !== -1 ? row[materialIdx] ?? "" : "",
      sizeP1: (nominalIdx !== -1 ? row[nominalIdx] : "") || sizesLabel,
      sizeP2: "",
      sizeP3: "",
      attributes: extraAttributes(parsed.headers, row, usedIndices),
    });
  }
  return items;
}
