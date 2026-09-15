// Scores the CURRENT spool-boundary code against a hand-verified reading of a
// real ISO, replaying it over a stored extraction payload -- so a change to
// buildSpoolsFromWeldTopology (or to how the worker feeds it) can be checked
// without paying for another vision run.
//
// The reference is the 5-sheet ISO `8"-22-214-01-CRD-0002-AC03N-N`, walked
// weld-by-weld against the drawing; see CLAUDE.md for the boundary rules.
// A miss here is not automatically a code bug: the stored payload also carries
// the model's own `closes_spool` answers, which are what the known
// valve-recall gap affects. Dump a payload first with
//   (from packages/db)  node scripts/dump-iso-welds.mjs <documentId> --out raw.json
// then                  pnpm --filter @easy/worker exec tsx scripts/replay-spools.ts raw.json

import { readFileSync } from "node:fs";
import { buildSpoolsFromWeldTopology, type WeldTopology } from "@easy/shared";
import { spoolProblems } from "../src/extraction/iso";

const REFERENCE: Record<number, Record<string, number[]>> = {
  1: {
    "N-01": [1, 2, 3, 4, 5, 6],
    "N-02": [7, 8, 9, 10, 11, 12],
    "N-03": [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
  },
  2: {
    "N-04": [1, 2, 3, 4, 5, 6],
    "N-05": [7, 8, 9, 10, 11],
    "N-06": [12, 13, 14],
    "N-07": [15, 16, 17],
    "N-08": [18, 19, 20, 21, 22],
    "N-09": [23, 24, 25, 26],
  },
  3: { "N-10": [1, 2, 3, 4, 5, 6], "N-11": [7, 8, 9, 10, 11] },
  4: { "N-12": [1, 2, 3, 4, 5, 6], "N-13": [7], "N-14": [8, 9, 10, 11, 12, 13, 14, 15, 16] },
  5: { "N-15": [1, 2, 3, 4, 5], "N-16": [6, 7, 8, 9, 10], "N-17": [11, 12], "N-18": [13, 14] },
};

interface RawWeld {
  weld_no: string;
  weld_type?: string;
  comes_after_weld?: string;
  closes_spool?: boolean;
}

const payloadPath = process.argv[2];
if (!payloadPath) {
  console.error("usage: tsx scripts/replay-spools.ts <raw.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(payloadPath, "utf8"));

// Payloads captured before spool_boundaries existed only carry the per-weld
// closes_spool flags. --simulate-boundaries rebuilds a boundary list from those
// so the validators can be exercised against a real recorded failure.
const simulate = process.argv.includes("--simulate-boundaries");

// Spool tags carry the full printed tag (`..."-AC03N-N-04`); the reference is
// keyed on just the trailing `N-04`.
const shortTag = (tag: string) => (String(tag).match(/(N-\d+)\s*$/i)?.[1] ?? String(tag)).toUpperCase();
const sameWelds = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

let exact = 0;
let total = 0;

for (const entry of raw.sheets ?? []) {
  // Each entry wraps the model's tool output as { result, pageNumber, ... }.
  const sheet = entry.result ?? entry;
  const sheetNo = Number(entry.pageNumber ?? sheet.sheet_number);
  const want = REFERENCE[sheetNo];
  if (!want) continue;

  const welds: RawWeld[] = sheet.welds ?? [];
  const weldByNo = new Map(welds.map((w) => [Number(w.weld_no), w]));

  // Mirrors the worker: the evidence-bearing boundary list wins where the
  // sheet returned one, per-weld closes_spool is the fallback, and a field
  // weld always closes the spool it ends.
  const boundaryWelds = new Set<number>();
  for (const b of sheet.spool_boundaries ?? []) {
    const no = Number(String(b?.after_weld ?? "").trim());
    if (Number.isFinite(no)) boundaryWelds.add(no);
  }
  if (boundaryWelds.size === 0) {
    for (const w of welds) if (w.closes_spool) boundaryWelds.add(Number(w.weld_no));
  }
  for (const w of welds) {
    if (String(w.weld_type ?? "").trim().toUpperCase() === "FW") boundaryWelds.add(Number(w.weld_no));
  }

  const topology: WeldTopology[] = [...weldByNo.entries()].map(([weldNo, w]) => ({
    weldNo,
    comesAfterWeld:
      w.comes_after_weld != null && String(w.comes_after_weld).trim() !== "" ? Number(w.comes_after_weld) : null,
    closesSpool: boundaryWelds.has(weldNo),
  }));

  const spoolTags: string[] = (sheet.spool_tags ?? [])
    .map((t: unknown) => (typeof t === "string" ? t : (t as { spool_tag?: string } | null)?.spool_tag))
    .filter(Boolean);

  const { spools } = buildSpoolsFromWeldTopology(topology, spoolTags);
  const got = new Map(spools.map((s) => [shortTag(s.spoolTag), s.weldNumbers]));

  console.log(`\nSheet ${sheetNo}`);

  const checked = simulate
    ? { ...sheet, spool_boundaries: welds.filter((w) => w.closes_spool).map((w) => ({ after_weld: String(w.weld_no), boundary_type: "valve", evidence: "" })) }
    : sheet;
  for (const problem of spoolProblems(checked)) console.log(`  CHECK   ${problem.slice(0, 150)}...`);

  for (const [tag, wantWelds] of Object.entries(want)) {
    total += 1;
    const g = got.get(tag);
    if (!g) {
      console.log(`  MISSING ${tag}  expected ${wantWelds.join(",")}`);
    } else if (sameWelds(g, wantWelds)) {
      exact += 1;
      console.log(`  OK      ${tag}  ${g.join(",")}`);
    } else {
      console.log(`  WRONG   ${tag}  got ${g.join(",")}  expected ${wantWelds.join(",")}`);
    }
  }
  for (const [tag, weldNumbers] of got) {
    if (!want[tag]) console.log(`  EXTRA   ${tag}  ${weldNumbers.join(",")}`);
  }
}

console.log(`\n${exact}/${total} spools match the manual reference.`);
