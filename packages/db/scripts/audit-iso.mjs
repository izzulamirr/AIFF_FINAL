// Cross-check a stored ISO extraction against the drawing's own geometry and
// the domain rules. Free -- no API call. Reports, never writes.
//
//   node scripts/audit-iso.mjs <geometry.json> <cuts.json> <dims.json> [documentId]
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const here = dirname(fileURLToPath(import.meta.url));
function url(){ if(process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for(const rel of ["../../apps/worker/.env","../../apps/web/.env.local"]){ try{ const t=readFileSync(resolve(here,"..",rel),"utf8");
    const l=t.split(/\r?\n/).find(x=>x.startsWith("DATABASE_URL=")); if(l) return l.slice(13).trim().replace(/^["']|["']$/g,""); }catch{} }
  throw new Error("DATABASE_URL not found"); }

const [, , geomPath, cutsPath, dimsPath, docArg] = process.argv;
const D = docArg ?? "820944b2-b2b9-467d-a005-22b05e53121d";
const geom = JSON.parse(readFileSync(geomPath, "utf8"));
const cuts = JSON.parse(readFileSync(cutsPath, "utf8"));
const dims = JSON.parse(readFileSync(dimsPath, "utf8"));
const short = (s) => String(s ?? "").replace(/^.*-N-/, "N-");
const FW = (t) => /^(FW|FIELDWELD|FIELD WELD)$/i.test(String(t ?? "").trim());

const sql = postgres(url(), { prepare: false });
const problems = [], notes = [];
try {
  const welds = await sql`SELECT source_page, attributes FROM extracted_tags WHERE document_id=${D} AND tag_type='weld'`;
  const spools = await sql`SELECT tag_number, source_page, attributes FROM extracted_tags WHERE document_id=${D} AND tag_type='spool'`;

  // 1. every flag on the drawing has a weld row
  console.log("1. WELD COVERAGE");
  for (const p of geom.pages) {
    const rows = welds.filter((w) => w.source_page === p.page);
    const ok = rows.length === p.flagCount;
    console.log(`   page ${p.page}: ${p.flagCount} flags on the drawing, ${rows.length} rows${ok ? "" : "   <-- MISMATCH"}`);
    if (!ok) problems.push(`page ${p.page}: ${p.flagCount} flags but ${rows.length} weld rows`);
  }

  // 2. every weld belongs to a spool, and blocks are contiguous
  console.log("\n2. SPOOL ASSIGNMENT");
  const unassigned = welds.filter((w) => !String(w.attributes.spool_no ?? "").trim() || w.attributes.spool_no === "-");
  console.log(`   ${welds.length - unassigned.length}/${welds.length} welds carry a spool${unassigned.length ? `   <-- ${unassigned.length} do not` : ""}`);
  if (unassigned.length) problems.push(`${unassigned.length} welds have no spool`);
  const byPageSpool = new Map();
  for (const w of welds) {
    const k = `${w.source_page}|${w.attributes.spool_no}`;
    (byPageSpool.get(k) ?? byPageSpool.set(k, []).get(k)).push(Number(w.attributes.weld_no));
  }
  for (const [k, ns] of byPageSpool) {
    const s = ns.slice().sort((a, b) => a - b);
    const gaps = s.some((n, i) => i > 0 && n !== s[i - 1] + 1);
    if (gaps) { const [pg, sp] = k.split("|"); notes.push(`page ${pg} ${short(sp)} weld numbers are not contiguous: [${s.join(",")}]`); }
  }

  // 3. every spool referenced has a row
  console.log("\n3. SPOOL ROWS");
  const refd = new Set(welds.map((w) => `${w.source_page}|${String(w.attributes.spool_no).trim()}`));
  const rowd = new Set(spools.map((r) => `${r.source_page}|${String(r.tag_number).trim()}`));
  const missing = [...refd].filter((k) => !rowd.has(k));
  const orphan = [...rowd].filter((k) => !refd.has(k));
  console.log(`   ${refd.size} spools referenced by welds, ${rowd.size} spool rows`);
  for (const k of missing) problems.push(`no spool row for ${short(k.split("|")[1])} on page ${k.split("|")[0]}`);
  for (const k of orphan) notes.push(`spool row ${short(k.split("|")[1])} (page ${k.split("|")[0]}) has no welds`);

  // 4. envelopes: arithmetic, and the 6000mm forced-cut rule
  console.log("\n4. ENVELOPES");
  let sized = 0;
  for (const r of spools) {
    const e = r.attributes.envelope;
    if (!e) continue;
    sized++;
    for (const [ax, key] of [["UP-DOWN", "upDownMm"], ["N-S", "nsMm"], ["E-W", "ewMm"]]) {
      const sum = (e.parts[ax] ?? []).reduce((n, p) => n + p.mm, 0);
      if (Math.abs(sum - e[key]) > 0.5) problems.push(`${short(r.tag_number)} ${ax}: total ${e[key]} but its parts add to ${sum}`);
    }
    // The 6000mm rule is about a single continuous PIECE of pipe, not the
    // spool's extent along an axis: an axis total is a sum of separate legs,
    // and three 2m legs in line are not a 6m piece needing a cut.
    const parts = Object.values(e.parts).flat();
    const longestPiece = parts.reduce((n, x) => Math.max(n, x.mm), 0);
    const fw = welds.filter((w) => w.attributes.spool_no === r.tag_number && FW(w.attributes.weld_type)).length;
    if (longestPiece > 6000 && fw === 0) {
      notes.push(`${short(r.tag_number)} has a single ${longestPiece}mm length with no field weld -- over the 6000mm forced cut`);
    }
    const axisTotal = Math.max(e.upDownMm, e.nsMm, e.ewMm);
    if (axisTotal > 6000 && longestPiece <= 6000) {
      notes.push(`${short(r.tag_number)} totals ${axisTotal}mm on one axis but its longest single length is ${longestPiece}mm -- a sum of legs, not one piece`);
    }
  }
  console.log(`   ${sized} of ${spools.length} spool rows carry a derived envelope`);

  // 5. what the sheets printed that reached no spool
  console.log("\n5. DIMENSIONS");
  const total = dims.pages.reduce((n, p) => n + p.dimensions.length, 0);
  const read = dims.pages.reduce((n, p) => n + p.dimensions.filter((d) => d.mm != null).length, 0);
  const anyEnv = spools.map((r) => r.attributes.envelope).filter(Boolean);
  const used = new Set(anyEnv.flatMap((e) => Object.values(e.parts).flat().map((p) => p.cell)));
  const unplacedCells = new Set(anyEnv.flatMap((e) => (e.unplaced ?? []).map((u) => u.cell)));
  console.log(`   ${total} detected, ${read} read, ${used.size} in an envelope, ${unplacedCells.size} reported unplaced`);
  const missingCells = [];
  for (const p of dims.pages) for (const d of p.dimensions)
    if (d.mm != null && !used.has(d.cell) && !unplacedCells.has(d.cell)) missingCells.push(d.cell);
  if (missingCells.length) notes.push(`${missingCells.length} read lengths are neither in an envelope nor reported unplaced: ${missingCells.slice(0,12).join(" ")}`);

  // 6. sheets the cut finder refused
  console.log("\n6. SHEETS LEFT ALONE");
  for (const p of cuts.pages) if (!p.trusted) { console.log(`   page ${p.page}: refused (${p.cuts.length} cuts found)`); notes.push(`page ${p.page} was left alone, so its spools have no assignment from the drawing`); }

  console.log(`\n${"=".repeat(60)}`);
  console.log(problems.length ? `PROBLEMS (${problems.length}):` : "NO PROBLEMS");
  for (const x of problems) console.log(`  x ${x}`);
  console.log(notes.length ? `\nWORTH KNOWING (${notes.length}):` : "");
  for (const x of notes) console.log(`  . ${x}`);
} finally { await sql.end(); }
