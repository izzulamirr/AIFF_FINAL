import { combineAdminText, type SheetItem } from "@easy/shared";

// Reading an admin item list's lines lives in @easy/shared (sheetItems.ts), where the
// worker can use it too. Re-exported here so the web app's imports do not change.
export { parseTabSeparatedPage, findColumnIndex, extractSheetItems, combineAdminText } from "@easy/shared";
export type { ParsedSheetPage, SheetItem } from "@easy/shared";

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
  // A BOM size can carry its unit ("200 x 80 mm"); left on, the pair no longer
  // parses and the digits run together into a size that exists nowhere.
  const compoundSize = /^(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)$/.exec(String(bomItem.size ?? "").trim().replace(/\s*mm$/i, ""));
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

// Of the admin lines that all satisfy a BOM item, the one(s) that read most like it.
//
// narrowAdminMatches keeps every line that agrees on size, schedule, angle and
// construction, and an admin list often holds near-twins beyond those -- a ball valve
// listed once reduced-bore (RB) and once full-bore (FB), the rest of the text the
// same. Printing both against one BOM row shows the same two lines twice over. The
// line that shares the most wording with the BOM's own description is the one it
// refers to, so only that is kept; lines that tie are all kept, since nothing says
// which of them is meant.
export function closestAdminLines(lines: SheetItem[], bomDescription: string): SheetItem[] {
  if (lines.length < 2) return lines;
  const tokens = (text: string) => new Set(text.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length > 1));
  const bom = tokens(bomDescription);
  if (bom.size === 0) return lines;
  const scored = lines.map((line) => {
    const own = tokens(combineAdminText(line));
    let shared = 0;
    for (const t of own) if (bom.has(t)) shared += 1;
    return { line, score: shared / (own.size + bom.size - shared) };
  });
  const best = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score >= best - 1e-9).map((s) => s.line);
}

