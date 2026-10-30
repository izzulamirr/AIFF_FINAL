// Free: does reading an ISA tag WITHOUT its hyphen change any answer it
// should not? Prints OLD vs NEW `classifyInstrument` over every row in the
// database that could reach it.
//
//   cd packages/db && node scripts/probe-isa-tags.mjs
//
// It carries its own copy of the rule, which is the usual probe trade-off:
// it can be run against a new drawing before touching the real classifier,
// and it will drift from `apps/web/src/lib/verifyIso.ts` if that changes.
// Check the two still agree before believing a sweep.
//
// The hyphen in "FT-0003" is a CONVENTION, not part of the tag, and this
// project's ISO writes its instrument BOM rows without one ("FT0003"). But
// the hyphen is also what currently keeps material codes out -- "SS316L"
// would decode as a speed switch -- so dropping it is a change to measure,
// not to assume.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
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

const ISA_VARIABLES = { A: "analysis", D: "density", F: "flow", H: "hand", I: "current", J: "power", L: "level", M: "moisture", P: "pressure", Q: "quantity", S: "speed", T: "temperature", V: "vibration", W: "weight", X: "unclassified", Z: "position" };
const ISA_FUNCTIONS = { A: "alarm", C: "controller", E: "element", G: "gauge", I: "indicator", R: "recorder", S: "switch", T: "transmitter", V: "valve", W: "well", Y: "relay" };
const NON_INSTRUMENT_PREFIXES = new Set(["ASME", "ASTM", "API", "ISO", "MSS", "NACE", "BS", "EN", "DIN", "SA", "SS", "CS", "SCH", "MR"]);

const DEVICE_WORDS = /\binstrument\b|transmitter|\bindicator\b|controller|thermowell|\bgauge\b|\bswitch\b|\belement\b|\brecorder\b/;

function decode(letters) {
  const v = ISA_VARIABLES[letters[0]];
  if (!v) return null;
  for (let i = letters.length - 1; i >= 1; i--) {
    const f = ISA_FUNCTIONS[letters[i]];
    if (f) return `${v} ${f}`;
  }
  return null;
}

function classify(text, { bareTags }) {
  const raw = String(text ?? "");
  const t = raw.toLowerCase();

  const variable = Object.values(ISA_VARIABLES).find((v) => new RegExp(`\\b${v}\\b`).test(t));
  const fn = Object.entries(ISA_FUNCTIONS).find(([, f]) => new RegExp(`\\b${f}\\b`).test(t))?.[1];
  if (variable && fn) return `${variable} ${fn}`;

  const tag = raw.toUpperCase().match(/\b([A-Z]{2,4})-(?=[A-Z]?\d{2})/);
  if (tag && !NON_INSTRUMENT_PREFIXES.has(tag[1])) {
    const d = decode(tag[1]);
    if (d) return d;
  }

  // THE CANDIDATE. Same letters, no hyphen -- allowed only where the row has
  // already said it is an instrument, which is what the hyphen was standing
  // in for.
  if (bareTags && DEVICE_WORDS.test(t)) {
    // NOT after a hyphen: "XI-VKA102" is a tag whose LOOP NUMBER carries an
    // area prefix, and reading "VKA102" as a group decodes the area code as
    // a device -- a vibration alarm where the drawing says indicator.
    // Every candidate, not just the first: "INSTRUMENT, SS316 BODY, FT0003"
    // would otherwise stop at the blacklisted SS316 and never reach the tag.
    for (const bare of raw.toUpperCase().matchAll(/(?:^|[^-A-Z0-9])([A-Z]{2,4})(\d{2,6})\b/g)) {
      if (NON_INSTRUMENT_PREFIXES.has(bare[1])) continue;
      const d = decode(bare[1]);
      if (d) return d;
    }
  }

  return /\binstrument\b/.test(t) ? "instrument (other)" : null;
}

const sql = postgres(loadDatabaseUrl(), { prepare: false });
try {
  const rows = await sql`
    SELECT tag_type, tag_number, attributes FROM extracted_tags
    WHERE tag_type IN ('bom_item','valve','fitting','instrument','hookup_item')
  `;
  let changed = 0;
  const seen = new Set();
  for (const r of rows) {
    const a = r.attributes ?? {};
    const text = `${a.component_type ?? ""} ${a.description ?? ""} ${a.valve_type ?? ""} ${a.fitting_type ?? ""} ${a.instrument_type ?? ""} ${r.tag_number ?? ""}`;
    const before = classify(text, { bareTags: false });
    const after = classify(text, { bareTags: true });
    if (before === after) continue;
    changed++;
    const key = `${before} -> ${after} | ${text.trim().replace(/\s+/g, " ").slice(0, 100)}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`[${r.tag_type}] ${key}`);
    }
  }
  console.log(`\n${changed} of ${rows.length} rows change answer (${seen.size} distinct)`);
} finally {
  await sql.end();
}
