// Makes the STORED spool match the one read off the drawing, for every weld
// the two disagree about.
//
//   node scripts/apply-drawing-spools.mjs <spool-cuts.json> [documentId] [--write]
//
// Up to now the drawing's answer sat beside the stored one as
// attributes.geometry_spool so the two could be compared. This promotes it:
// attributes.spool_no becomes what the drawing says.
//
// Both sides of the record move together, because they would otherwise
// contradict each other -- a weld row carries its own spool_no, and each spool
// row carries the weld_numbers it contains, and the document page reads both.
//
// Reversible and safe to re-run:
//   - the value being replaced is kept as attributes.spool_no_vision, written
//     only the first time so a second run cannot overwrite the original with an
//     already-corrected one,
//   - no row is created and none is deleted,
//   - a sheet whose cut count did not match its printed spool count is not
//     trusted by spool-cuts.ts, is absent from its output, and is left alone
//     here too.
//
// Branch-ness is a property of the WELD, not of the spool: a weld that moves to
// a different spool is still on the same branch it always was. So the existing
// mainline/branch split is carried across rather than recomputed -- recomputing
// it from bore would be wrong anyway, since a reduced section of the MAIN RUN
// is narrower than line size without being a branch (sheet 2's 150mm welds).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOC_ID = "820944b2-b2b9-467d-a005-22b05e53121d";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const rel of ["../../../apps/worker/.env", "../../../apps/web/.env.local"]) {
    try {
      const text = readFileSync(resolve(here, rel), "utf8");
      const line = text.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
      if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next candidate
    }
  }
  throw new Error("DATABASE_URL not found");
}

const [, , jsonPath, ...rest] = process.argv;
if (!jsonPath) {
  console.error("usage: node scripts/apply-drawing-spools.mjs <spool-cuts.json> [documentId] [--write]");
  process.exit(1);
}
const write = rest.includes("--write");
const documentId = rest.find((a) => !a.startsWith("--")) ?? DEFAULT_DOC_ID;
const data = JSON.parse(readFileSync(jsonPath, "utf8"));
const sql = postgres(loadDatabaseUrl(), { prepare: false });

const num = (v) => Number(String(v ?? "").trim());

try {
  const welds = await sql`
    SELECT id, source_page, attributes FROM extracted_tags
    WHERE document_id = ${documentId} AND tag_type = 'weld'
    ORDER BY source_page, id
  `;
  const spools = await sql`
    SELECT id, source_page, tag_number, attributes FROM extracted_tags
    WHERE document_id = ${documentId} AND tag_type = 'spool'
    ORDER BY source_page, id
  `;
  console.log(`${welds.length} weld rows, ${spools.length} spool rows\n`);

  const weldUpdates = [];
  const spoolUpdates = [];
  let alreadyRight = 0;

  for (const page of data.pages) {
    if (!page.trusted) {
      console.log(`page ${page.page}: not trusted by the cut finder, left alone`);
      continue;
    }
    const pageWelds = welds.filter((w) => w.source_page === page.page);
    const pageSpools = spools.filter((s) => s.source_page === page.page);

    // Which spool the drawing puts each weld in.
    const drawn = new Map();
    for (const a of page.assignment) drawn.set(a.weldNo, a.spool);

    // Branch-ness as the sheet already records it, kept across the move.
    const onBranch = new Set();
    for (const s of pageSpools) for (const n of s.attributes?.branch_weld_numbers ?? []) onBranch.add(num(n));

    const moved = [];
    for (const row of pageWelds) {
      const no = num(row.attributes?.weld_no);
      const want = drawn.get(no);
      if (!want) continue;
      const have = String(row.attributes?.spool_no ?? "");
      if (have === want) {
        alreadyRight++;
        continue;
      }
      const attrs = { ...row.attributes, spool_no: want };
      // Only the FIRST time: never let a re-run bury the original.
      if (attrs.spool_no_vision == null) attrs.spool_no_vision = have;
      weldUpdates.push({ id: row.id, attributes: attrs });
      moved.push(`weld ${no}: ${have.slice(-5)} -> ${want.slice(-5)}`);
    }

    // Rebuild each spool row's membership from the same assignment.
    const whyFor = new Map((page.evidence ?? []).map((e) => [e.cut, e.why]));
    const cuts = [...page.cuts].sort((a, b) => a - b);
    const ordered = [...pageSpools].sort((a, b) => num(a.attributes?.spool_index) - num(b.attributes?.spool_index));
    for (const s of ordered) {
      const mine = [...drawn.entries()]
        .filter(([, tag]) => tag === s.tag_number)
        .map(([no]) => no)
        .sort((a, b) => a - b);
      if (mine.length === 0) continue;
      const idx = ordered.indexOf(s);
      const closesAt = cuts[idx];
      const note =
        closesAt != null && whyFor.has(closesAt)
          ? whyFor.get(closesAt)
          : idx === ordered.length - 1
            ? "runs to the end of the sheet"
            : String(s.attributes?.note ?? "");
      const attrs = {
        ...s.attributes,
        weld_numbers: mine,
        mainline_weld_numbers: mine.filter((n) => !onBranch.has(n)),
        branch_weld_numbers: mine.filter((n) => onBranch.has(n)),
        note,
      };
      const same =
        JSON.stringify(attrs.weld_numbers) === JSON.stringify(s.attributes?.weld_numbers ?? []) &&
        attrs.note === String(s.attributes?.note ?? "");
      if (same) continue;
      spoolUpdates.push({ id: s.id, tag: s.tag_number, attributes: attrs, before: s.attributes?.weld_numbers ?? [] });
    }

    console.log(`page ${page.page}: ${moved.length} weld${moved.length === 1 ? "" : "s"} move`);
    for (const m of moved) console.log(`    ${m}`);
  }

  console.log(`\n${alreadyRight} welds already matched the drawing`);
  console.log(`${weldUpdates.length} weld rows to change, ${spoolUpdates.length} spool rows to rebuild`);
  for (const s of spoolUpdates) {
    console.log(`    ${s.tag.slice(-5)}: [${s.before.join(",")}] -> [${s.attributes.weld_numbers.join(",")}]`);
  }

  if (!write) {
    console.log(`\n(dry run -- pass --write to store)`);
  } else {
    for (const u of [...weldUpdates, ...spoolUpdates]) {
      await sql`UPDATE extracted_tags SET attributes = ${sql.json(u.attributes)} WHERE id = ${u.id}`;
    }
    console.log(`\nstored. the drawing's answer is now the spool of record; the previous value is kept as spool_no_vision`);
  }
} finally {
  await sql.end();
}
