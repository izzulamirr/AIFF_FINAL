import { and, eq, inArray } from "drizzle-orm";
import { extractedTags, findings } from "@easy/db";
import { normalizeTagNumber } from "@easy/shared";
import { getDb } from "./db";

type ExtractedTag = typeof extractedTags.$inferSelect;
type Finding = typeof findings.$inferInsert;

export interface VerifyIsoBomInput {
  projectId: string;
  isoDocumentId: string;
  pllDocumentId?: string;
  specDocumentId?: string;
  pidDocumentId?: string;
  gaDocumentId?: string;
}

// Gate-ordered ISO verification chain, per the piping QA workflow:
//   0. Document/admin (title block completeness)
//   1. Line exists in the PLL (fail = stop)
//   2. Design basis, ISO title block vs PLL (class mismatch = stop)
//   3. P&ID cross-check
//   4. Spec compliance (material etc. per class)
//   5. Geometry/drafting  -- NOT verifiable from extracted data, skipped
//   6. Supports
//   7. BOM internal consistency (item codes resolve to spec catalogue)
//   8. GA routing
// Checks that need data we don't extract (north arrow, holds, dimensional
// closure, weld counts, coordinates, quantities-counted-vs-stated, MTO
// roll-up, clash detection) are intentionally NOT approximated -- a check
// that can't actually be performed must not silently "pass".
//
// fieldChecked is prefixed "N." with the gate number so the UI can group
// and order findings by gate.
export async function verifyIsoBom(input: VerifyIsoBomInput): Promise<{ findingsCreated: number }> {
  const { projectId, isoDocumentId, pllDocumentId, specDocumentId, pidDocumentId, gaDocumentId } = input;
  const db = getDb();

  const docIds = [isoDocumentId, pllDocumentId, specDocumentId, pidDocumentId, gaDocumentId].filter((id): id is string => Boolean(id));
  const allTags = await db.select().from(extractedTags).where(inArray(extractedTags.documentId, docIds));

  const isoLines = allTags.filter((t) => t.documentId === isoDocumentId && t.tagType === "line");
  const isoBomItems = allTags.filter((t) => t.documentId === isoDocumentId && t.tagType === "bom_item");
  const pllLines = pllDocumentId ? allTags.filter((t) => t.documentId === pllDocumentId && t.tagType === "line") : [];
  const specClasses = specDocumentId ? allTags.filter((t) => t.documentId === specDocumentId && t.tagType === "spec_class") : [];
  const pidLines = pidDocumentId ? allTags.filter((t) => t.documentId === pidDocumentId && t.tagType === "line") : [];
  const pidValves = pidDocumentId ? allTags.filter((t) => t.documentId === pidDocumentId && t.tagType === "valve") : [];
  const pidInstruments = pidDocumentId ? allTags.filter((t) => t.documentId === pidDocumentId && t.tagType === "instrument") : [];
  const gaLines = gaDocumentId ? allTags.filter((t) => t.documentId === gaDocumentId && t.tagType === "line") : [];
  const gaSupports = gaDocumentId ? allTags.filter((t) => t.documentId === gaDocumentId && t.tagType === "support") : [];

  const specByNorm = new Map(specClasses.map((s) => [normalizeTagNumber(s.tagNumber), s] as const));
  const pllByNorm = new Map<string, ExtractedTag[]>();
  for (const l of pllLines) {
    const key = l.tagNumberNormalized;
    const list = pllByNorm.get(key);
    if (list) list.push(l);
    else pllByNorm.set(key, [l]);
  }
  const pidByNorm = new Map(pidLines.map((l) => [l.tagNumberNormalized, l] as const));
  const gaByNorm = new Map(gaLines.map((l) => [l.tagNumberNormalized, l] as const));

  const out: Finding[] = [];
  let stopped = false;

  // ---- Gate 0: Document / admin --------------------------------------
  // Title block completeness on the ISO itself. North arrow, hold flags,
  // transmittal revision match, and continuation-sheet back-links are not
  // extractable from the current pipeline -- not checked.
  const REQUIRED_TITLE_BLOCK_FIELDS = ["document_number", "drawing_number", "revision", "sheet", "spec_class", "size"] as const;
  for (const line of isoLines) {
    const attrs = line.attributes as Record<string, unknown>;
    for (const field of REQUIRED_TITLE_BLOCK_FIELDS) {
      if (isBlank(attrs[field])) {
        out.push(makeFinding(projectId, line, isoDocumentId, undefined, `0.${field}`, null, null, "warning", `Title block field "${field}" is missing/blank on the ISO.`));
      }
    }
  }

  // ---- Gate 1: Line exists (PLL) -- fail = stop -----------------------
  if (!pllDocumentId) {
    if (isoLines[0]) {
      out.push(
        makeFinding(projectId, isoLines[0], isoDocumentId, undefined, "1.line_exists", null, null, "info", "Gate 1 skipped: no Process Line List (PLL) document selected. Upload a PLL and select it to run gates 1-2.")
      );
    }
  } else {
    for (const line of isoLines) {
      const attrs = line.attributes as Record<string, unknown>;
      const matches = pllByNorm.get(line.tagNumberNormalized) ?? [];

      if (matches.length === 0) {
        out.push(makeFinding(projectId, line, isoDocumentId, pllDocumentId, "1.line_exists", line.tagNumber, null, "error", `ISO line ${line.tagNumber} was not found in the PLL. Chain stopped.`));
        stopped = true;
        continue;
      }
      if (matches.length > 1) {
        out.push(makeFinding(projectId, line, isoDocumentId, pllDocumentId, "1.duplicates", line.tagNumber, String(matches.length), "warning", `Line ${line.tagNumber} appears ${matches.length} times in the PLL.`));
      }

      // Line number decode: size / class / insulation tokens embedded in the
      // line number string should agree with the title block's own fields.
      const norm = (v: unknown) => normalizeTagNumber(String(v ?? "")).replace(/[^A-Z0-9"]/g, "");
      const lineNorm = norm(line.tagNumber);
      for (const [field, label] of [
        ["size", "size"],
        ["spec_class", "class"],
      ] as const) {
        const value = attrs[field];
        if (!isBlank(value) && !lineNorm.includes(norm(value))) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, undefined, `1.decode_${label}`, String(value), line.tagNumber, "warning", `The ${label} "${value}" from the title block does not appear in line number "${line.tagNumber}".`)
          );
        }
      }

      const pll = matches[0];
      const pllAttrs = pll.attributes as Record<string, unknown>;
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "1.size", attrs.size, pllAttrs.size, "error");
      // From/To: the ISO extraction currently has no from/to fields, so
      // this workflow item can't be checked yet -- see gap notes.
    }

    // Reverse check: PLL lines with no ISO anywhere in the project.
    const projectIsoLines = await db
      .select({ norm: extractedTags.tagNumberNormalized })
      .from(extractedTags)
      .where(and(eq(extractedTags.projectId, projectId), eq(extractedTags.docType, "iso"), eq(extractedTags.tagType, "line")));
    const isoNorms = new Set(projectIsoLines.map((r) => r.norm));
    for (const pll of pllLines) {
      if (!isoNorms.has(pll.tagNumberNormalized)) {
        out.push(makeFinding(projectId, pll, isoDocumentId, pllDocumentId, "1.reverse", pll.tagNumber, null, "info", `PLL line ${pll.tagNumber} has no ISO in this project (yet).`));
      }
    }
  }

  // ---- Gate 2: Design basis (ISO title block vs PLL) -------------------
  // Class mismatch = stop. Blank on either side is skipped, not a mismatch.
  if (!stopped && pllDocumentId) {
    for (const line of isoLines) {
      const attrs = line.attributes as Record<string, unknown>;
      const pll = (pllByNorm.get(line.tagNumberNormalized) ?? [])[0];
      if (!pll) continue; // gate 1 already flagged it
      const pllAttrs = pll.attributes as Record<string, unknown>;

      if (!isBlank(attrs.spec_class) && !isBlank(pllAttrs.spec_class) && normalizeTagNumber(String(attrs.spec_class)) !== normalizeTagNumber(String(pllAttrs.spec_class))) {
        out.push(
          makeFinding(projectId, line, isoDocumentId, pllDocumentId, "2.piping_class", String(attrs.spec_class), String(pllAttrs.spec_class), "error", `Piping class mismatch between ISO and PLL for line ${line.tagNumber}. Chain stopped.`)
        );
        stopped = true;
        continue;
      }

      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.design_pressure", attrs.design_pressure, pllAttrs.design_pressure, "error");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.design_temperature", attrs.design_temperature, pllAttrs.design_temperature, "error");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.operating_pressure", attrs.operating_pressure, pllAttrs.operating_pressure, "warning");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.operating_temperature", attrs.operating_temperature, pllAttrs.operating_temperature, "warning");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.test_pressure", attrs.hydrotest_pressure, pllAttrs.test_pressure, "error");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.service", attrs.service, pllAttrs.service, "warning");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.paint_system", attrs.painting_system, pllAttrs.paint_system, "warning");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.insulation_thickness", attrs.insul_thickness_mm, pllAttrs.insulation_thickness, "warning");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.insulation_code", attrs.insul_spec, pllAttrs.insulation_code, "warning");
      compareText(out, projectId, line, isoDocumentId, pllDocumentId, "2.pwht", attrs.pwht, pllAttrs.pwht, "warning");
      compareNumeric(out, projectId, line, isoDocumentId, pllDocumentId, "2.ndt_percent", attrs.radiograph, pllAttrs.ndt_percent, "warning");
    }
  }

  // ---- Gate 3: P&ID ----------------------------------------------------
  if (!stopped && pidDocumentId) {
    for (const line of isoLines) {
      const attrs = line.attributes as Record<string, unknown>;
      const match = pidByNorm.get(line.tagNumberNormalized);
      if (!match) {
        out.push(makeFinding(projectId, line, isoDocumentId, pidDocumentId, "3.line_on_pid", line.tagNumber, null, "error", `Line ${line.tagNumber} on the ISO was not found on the P&ID.`));
        continue;
      }
      const matchAttrs = match.attributes as Record<string, unknown>;
      compareText(out, projectId, line, isoDocumentId, pidDocumentId, "3.size", attrs.size, matchAttrs.size, "warning");

      // Component presence, both directions, at the granularity the
      // extractions support: P&ID valves/instruments referencing this line
      // vs. ISO BOM valve/instrument items. The ISO BOM has counts and item
      // codes but usually no per-valve tag numbers, so this compares counts
      // and instrument tags -- it can't match individual untagged valves.
      const lineNorm = line.tagNumberNormalized;
      const refersToLine = (t: ExtractedTag, key: string) => {
        const ref = (t.attributes as Record<string, unknown>)[key];
        return typeof ref === "string" && normalizeTagNumber(ref) === lineNorm;
      };
      const pidLineValves = pidValves.filter((v) => refersToLine(v, "line_number"));
      const pidLineInstruments = pidInstruments.filter((i) => refersToLine(i, "line_or_equipment_ref"));

      const bomForLine = isoBomItems.filter((b) => {
        const ln = (b.attributes as Record<string, unknown>).line_number;
        return typeof ln === "string" && normalizeTagNumber(ln) === lineNorm;
      });
      const bomValveCount = bomForLine
        .filter((b) => String((b.attributes as Record<string, unknown>).component_type ?? "").toLowerCase().includes("valve"))
        .reduce((sum, b) => sum + (parseNumber((b.attributes as Record<string, unknown>).quantity) ?? 1), 0);

      if (pidLineValves.length > 0 && bomValveCount < pidLineValves.length) {
        out.push(
          makeFinding(projectId, line, isoDocumentId, pidDocumentId, "3.valves", String(bomValveCount), String(pidLineValves.length), "warning", `P&ID shows ${pidLineValves.length} valve(s) on line ${line.tagNumber}, but the ISO BOM only lists ${bomValveCount}.`)
        );
      }

      for (const instrument of pidLineInstruments) {
        const instNorm = normalizeTagNumber(instrument.tagNumber);
        const onIso = bomForLine.some((b) => {
          const a = b.attributes as Record<string, unknown>;
          return (typeof a.item_code === "string" && normalizeTagNumber(a.item_code).includes(instNorm)) || (typeof a.description === "string" && normalizeTagNumber(a.description).includes(instNorm));
        });
        if (!onIso) {
          out.push(
            makeFinding(projectId, line, isoDocumentId, pidDocumentId, "3.instrument", null, instrument.tagNumber, "warning", `Instrument ${instrument.tagNumber} on the P&ID (line ${line.tagNumber}) was not found in the ISO BOM.`)
          );
        }
      }
      // Flow direction, slope, tie-in numbers, spec-break/drain/vent/blind
      // placement, and equipment/nozzle tag positions are not extractable
      // from the current pipeline -- not checked (see gap notes).
    }
  }

  // ---- Gate 4: Specs ---------------------------------------------------
  const specClassByLine = new Map<string, ExtractedTag | undefined>();
  if (!stopped && specDocumentId) {
    for (const line of isoLines) {
      const attrs = line.attributes as Record<string, unknown>;
      const specClassCode = typeof attrs.spec_class === "string" ? attrs.spec_class : undefined;
      if (!specClassCode) continue;
      const spec = specByNorm.get(normalizeTagNumber(specClassCode));
      specClassByLine.set(line.tagNumber, spec);
      if (!spec) {
        out.push(
          makeFinding(projectId, line, isoDocumentId, specDocumentId, "4.spec_class", specClassCode, null, "error", `Line ${line.tagNumber} references spec class "${specClassCode}", which was not found in the uploaded spec sheet.`)
        );
      }
    }

    for (const item of isoBomItems) {
      const attrs = item.attributes as Record<string, unknown>;
      const lineNumber = typeof attrs.line_number === "string" ? attrs.line_number : undefined;
      if (!lineNumber) continue;
      const spec = specClassByLine.get(lineNumber);
      if (!spec) continue;

      const category = mapComponentCategory(typeof attrs.component_type === "string" ? attrs.component_type : undefined);
      if (!category) continue; // fasteners/supports/instruments: governed elsewhere, skipped (not silently passed as in-spec)

      const specAttrs = spec.attributes as Record<string, unknown>;
      const rows = (specAttrs[category] as Array<Record<string, unknown>>) ?? [];
      if (rows.length === 0) continue;

      const matchedRow = findSpecRow(rows, attrs.item_code);
      if (matchedRow) {
        // Wrong item: the code exists but the BOM's own fields contradict
        // what the spec row requires.
        compareText(out, projectId, item, isoDocumentId, specDocumentId, "4.material", attrs.material, matchedRow.material, "error");
      }
    }
  }

  // ---- Gate 5: Geometry / drafting --------------------------------------
  // Dimensional closure, continuity, coordinates/elevations, weld types and
  // counts, field-vs-shop welds, branch orientation, bolt hole orientation,
  // and size-change-without-reducer all require geometry the extraction
  // pipeline does not capture. Intentionally NOT checked -- no findings
  // emitted, so absence of findings here must not be read as a pass.

  // ---- Gate 6: Supports --------------------------------------------------
  if (!stopped) {
    const supportItems = isoBomItems.filter((b) => String((b.attributes as Record<string, unknown>).component_type ?? "").toLowerCase().includes("support"));
    for (const support of supportItems) {
      const attrs = support.attributes as Record<string, unknown>;
      const description = String(attrs.description ?? "");
      // Every support must carry a type designation (e.g. SW100, RB201).
      if (!/[A-Z]{1,3}\d{2,}/.test(description)) {
        out.push(makeFinding(projectId, support, isoDocumentId, undefined, "6.support_type", description, null, "warning", `Support BOM item ${support.tagNumber} has no recognizable support type designation.`));
      } else if (gaDocumentId && gaSupports.length > 0) {
        const typeMatch = description.match(/[A-Z]{1,3}\d{2,}/g) ?? [];
        const inGa = gaSupports.some((g) => {
          const gAttrs = g.attributes as Record<string, unknown>;
          const gText = `${g.tagNumber} ${String(gAttrs.support_type ?? "")}`;
          return typeMatch.some((t) => normalizeTagNumber(gText).includes(normalizeTagNumber(t)));
        });
        if (!inGa) {
          out.push(
            makeFinding(projectId, support, isoDocumentId, gaDocumentId, "6.support_in_ga", typeMatch.join(", "), null, "warning", `Support type(s) ${typeMatch.join(", ")} from ISO BOM item ${support.tagNumber} not found among the GA's supports.`)
          );
        }
      }
    }
    // Support standard and stress-isometric cross-checks need those document
    // types, which don't exist yet -- not checked.
  }

  // ---- Gate 7: BOM ------------------------------------------------------
  if (!stopped && specDocumentId) {
    for (const item of isoBomItems) {
      const attrs = item.attributes as Record<string, unknown>;
      const itemCode = typeof attrs.item_code === "string" ? attrs.item_code : undefined;
      const lineNumber = typeof attrs.line_number === "string" ? attrs.line_number : undefined;
      if (!itemCode || !lineNumber) continue;
      const spec = specClassByLine.get(lineNumber);
      if (!spec) continue;

      const category = mapComponentCategory(typeof attrs.component_type === "string" ? attrs.component_type : undefined);
      if (!category) continue;
      const specAttrs = spec.attributes as Record<string, unknown>;
      const rows = (specAttrs[category] as Array<Record<string, unknown>>) ?? [];
      if (rows.length === 0) continue;

      if (!findSpecRow(rows, itemCode)) {
        // Not-in-spec: the code doesn't resolve to the catalogue at all --
        // deliberately distinct from gate 4's "wrong item" material check.
        const specClassLabel = typeof specAttrs.class_code === "string" ? specAttrs.class_code : spec.tagNumber;
        out.push(
          makeFinding(projectId, item, isoDocumentId, specDocumentId, "7.item_code", itemCode, null, "warning", `BOM item ${item.tagNumber} (${itemCode}, ${category}) does not resolve to any entry under spec class "${specClassLabel}" -- not-in-spec.`)
        );
      }
    }
    // Drawn-vs-list reconciliation, quantity counting, cut-length checks,
    // and MTO roll-up need drawing geometry / an MTO document -- not checked.
  }

  // ---- Gate 8: GA --------------------------------------------------------
  if (!stopped && gaDocumentId) {
    for (const line of isoLines) {
      const match = gaByNorm.get(line.tagNumberNormalized);
      if (!match) {
        out.push(makeFinding(projectId, line, isoDocumentId, gaDocumentId, "8.line_routing", line.tagNumber, null, "warning", `Line ${line.tagNumber} on the ISO was not found in the GA's pipe routing.`));
      }
    }
    // Coordinates, elevations, clearances, clash detection, and battery
    // limit alignment are not extractable -- not checked.
  }

  // Re-verifying should reflect current state, not accumulate stale
  // findings from earlier runs.
  await db.delete(findings).where(eq(findings.docAId, isoDocumentId));
  if (out.length > 0) {
    await db.insert(findings).values(out);
  }

  return { findingsCreated: out.length };
}

function isBlank(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim().toUpperCase();
  return s === "" || s === "NA" || s === "N/A" || s === "NIL" || s === "NIL." || s === "-";
}

function parseNumber(value: unknown): number | null {
  if (isBlank(value)) return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function findSpecRow(rows: Array<Record<string, unknown>>, itemCode: unknown): Record<string, unknown> | undefined {
  if (typeof itemCode !== "string" || !itemCode) return undefined;
  const codeNorm = normalizeTagNumber(itemCode);
  return rows.find((row) => {
    const rowCode = typeof row.item_code === "string" ? row.item_code : typeof row.valve_index_code === "string" ? row.valve_index_code : undefined;
    return rowCode != null && normalizeTagNumber(rowCode) === codeNorm;
  });
}

function mapComponentCategory(componentType: string | undefined): "pipes" | "fittings" | "flanges" | "valves" | null {
  if (!componentType) return null;
  const t = componentType.toLowerCase();
  if (t.includes("pipe") && !t.includes("support")) return "pipes";
  if (t.includes("fitting")) return "fittings";
  if (t.includes("flange")) return "flanges";
  if (t.includes("valve")) return "valves";
  return null;
}

function makeFinding(
  projectId: string,
  tag: ExtractedTag,
  docAId: string,
  docBId: string | undefined,
  fieldChecked: string,
  valueA: unknown,
  valueB: unknown,
  severity: "error" | "warning" | "info",
  notes?: string
): Finding {
  return {
    projectId,
    tagNumber: tag.tagNumber,
    docAId,
    docBId: docBId ?? null,
    fieldChecked,
    valueA: valueA == null ? null : String(valueA),
    valueB: valueB == null ? null : String(valueB),
    severity,
    status: "open",
    notes: notes ?? null,
  };
}

// Text comparison: blank on either side = skipped, never a mismatch.
function compareText(out: Finding[], projectId: string, tag: ExtractedTag, docAId: string, docBId: string | undefined, field: string, valueA: unknown, valueB: unknown, severity: "error" | "warning" | "info") {
  if (isBlank(valueA) || isBlank(valueB)) return;
  const a = String(valueA).trim().toLowerCase();
  const b = String(valueB).trim().toLowerCase();
  if (a !== b) out.push(makeFinding(projectId, tag, docAId, docBId, field, valueA, valueB, severity));
}

// Numeric comparison: extracts the number from each side so "150", "150 C",
// and "150.0" agree (units normalised before comparing). Blank/NA/NIL on
// either side = skipped. Falls back to text comparison when either side
// has no parseable number (e.g. "AMB.").
function compareNumeric(out: Finding[], projectId: string, tag: ExtractedTag, docAId: string, docBId: string | undefined, field: string, valueA: unknown, valueB: unknown, severity: "error" | "warning" | "info") {
  if (isBlank(valueA) || isBlank(valueB)) return;
  const a = parseNumber(valueA);
  const b = parseNumber(valueB);
  if (a == null || b == null) {
    compareText(out, projectId, tag, docAId, docBId, field, valueA, valueB, severity);
    return;
  }
  if (a !== b) out.push(makeFinding(projectId, tag, docAId, docBId, field, valueA, valueB, severity));
}
