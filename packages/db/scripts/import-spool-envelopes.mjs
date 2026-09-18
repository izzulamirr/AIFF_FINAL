// Stores each spool's DERIVED overall size, so the container page can show it.
//
//   pnpm --filter @easy/worker exec tsx scripts/export-spool-envelopes.ts //       dims.json geometry.json cuts.json envelopes.json      # works it out
//   node scripts/import-spool-envelopes.mjs envelopes.json [documentId] [--write]
//
// Writes attributes.envelope onto each spool row and changes nothing else. No
// row is created or deleted. The block carries the totals AND the dimensions
// that produced them:
//
//   { upDownMm, nsMm, ewMm, parts: { "UP-DOWN": [{cell, mm}], ... }, unplaced }
//
// `parts` is the point. Each length is tied to a spool by where it ATTACHES
// to the pipe, and the one spool verified by hand -- N-01, 588mm down and
// 404mm west -- comes out exactly: 202+202+184 down, 404 west. The other
// seventeen are unverified, so the page still shows the workings beside the
// figure. Someone who knows the drawing can then see WHICH length does not
// belong, which a bare number would never let them catch.
//
// Lengths that could not be placed are stored too, under `unplaced`. Most
// are valve assemblies -- a valve is bolted in between two flanges and ships
// on its own -- and saying so beats dropping them silently.
//
// The workings ARE the confirmation: each length carries the cell it was read
// from, so the figure can be checked against the drawing rather than taken on
// trust. There is no separate "unconfirmed" flag -- one was carried for a
// while and nothing ever read it but a badge.

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

const [, , envPath, ...rest] = process.argv;
if (!envPath) {
  console.error("usage: node scripts/import-spool-envelopes.mjs <envelopes.json> [documentId] [--write]");
  process.exit(1);
}
const write = rest.includes("--write");
const documentId = rest.find((a) => !a.startsWith("--")) ?? DEFAULT_DOC_ID;

// Worked out by the worker (which owns @easy/shared); this script only stores
// it, the same split as the weld-geometry and spool-cut imports.
const { envelopes, unplaced = [] } = JSON.parse(readFileSync(envPath, "utf8"));
if (unplaced.length > 0) console.log(`${unplaced.length} lengths were not placed in any spool; each is stored with its sheet`);
console.log(`${envelopes.length} spool envelopes from ${envPath}\n`);

const sql = postgres(loadDatabaseUrl(), { prepare: false });
try {
  const rows = await sql`
    SELECT id, tag_number, source_page, attributes FROM extracted_tags
    WHERE document_id = ${documentId} AND tag_type = 'spool'
  `;
  // KEYED BY SHEET AS WELL AS TAG. A spool carrying onto the next sheet has a
  // row per sheet and an envelope per sheet, and keying on the tag alone wrote
  // both envelopes onto whichever row the map happened to hold -- N-15's sheet
  // 4 row came out empty while its sheet 5 figures appeared twice.
  const key = (tag, page) => `${String(tag ?? "").trim()}@${page ?? ""}`;
  const byTagPage = new Map(rows.map((r) => [key(r.tag_number, r.source_page), r]));
  // An envelopes file written before they were page-scoped carries no page;
  // fall back to matching on the tag alone so it still imports.
  const byTag = new Map(rows.map((r) => [String(r.tag_number ?? "").trim(), r]));

  const updates = [];
  for (const e of envelopes) {
    const row = byTagPage.get(key(e.spool, e.page)) ?? (e.page == null ? byTag.get(e.spool) : undefined);
    const size = `${e.upDownMm} up, ${e.nsMm} N-S, ${e.ewMm} E-W`;
    if (!row) {
      console.log(`${e.spool}: no spool row -- skipped  (${size})`);
      continue;
    }
    const attrs = {
      ...row.attributes,
      envelope: {
        upDownMm: e.upDownMm,
        nsMm: e.nsMm,
        ewMm: e.ewMm,
        parts: e.parts,
        // What this sheet printed that went nowhere, so a reviewer is not
        // left wondering where a length they can see on the drawing went.
        unplaced: unplaced.filter((u) => u.page === e.page),
        // THE RUN, where the legs chained. This is what lets the container
        // check work on the pipe instead of on the box around it, so it has
        // to survive the trip through the database.
        ...(e.shape ? { shape: e.shape } : {}),
      },
    };
    updates.push({ id: row.id, attributes: attrs });
    const workings = Object.entries(e.parts)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `${k}=${v.map((x) => x.mm).join("+")}`)
      .join("  ");
    console.log(`${e.spool}: ${size}`);
    console.log(`    ${workings}`);
  }

  if (!write) {
    console.log(`\n${updates.length} spool${updates.length === 1 ? "" : "s"} to update (dry run -- pass --write to store)`);
  } else {
    for (const u of updates) {
      await sql`UPDATE extracted_tags SET attributes = ${sql.json(u.attributes)} WHERE id = ${u.id}`;
    }
    console.log(`\nstored ${updates.length} envelope${updates.length === 1 ? "" : "s"}; every one carries the lengths that produced it`);
  }
} finally {
  await sql.end();
}
