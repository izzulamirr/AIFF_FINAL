# AIFF — project context for Claude Code

AIFF is an AI-powered cross-document engineering review platform for a chemical plant
("Covalent Kwinana Lithium Refinery"). It extracts structured data from P&IDs, ISOs
(piping isometrics), hookup drawings, cutting-plate drawings, etc., and cross-checks
them against each other (e.g. an ISO's BOM against its P&ID, an ISO's design basis
against the line list).

## Monorepo layout
- `apps/web` — Next.js app (document upload, review UI, cross-document checks)
- `apps/worker` — Node/tsx background job processor (pg-boss queue) that runs the
  actual Claude vision extraction per document
- `packages/db` — Drizzle ORM schema + `postgres` client (Supabase Postgres)
- `packages/shared` — shared types and deterministic business logic (spec-break
  placement, spool-boundary resolution, etc.)
- `packages/extraction-schemas` — Claude tool schemas + prompts for each doc type

Run `pnpm dev` from the repo root. Node/pnpm version is pinned via `packageManager`
in the root `package.json` — if `pnpm dev` fails with a broken-release error, run
`corepack use pnpm@latest`.

## ISO spool & weld extraction — the domain rules

This was reverse-engineered by hand against a real 5-sheet ISO
(`8"-22-214-01-CRD-0002-AC03N-N`) and is now encoded in the extraction prompt/schema.
If you're debugging spool/weld extraction, this is the rule:

- A **spool** is one shop-welded assembly. It ends ONLY at:
  1. a **valve flanged on both sides** — the only real bolted disassembly point, or
  2. a **forced cut past 6000mm** of continuous welded pipe, marked by a **field weld**.
- Nothing else ends a spool. An elbow, reducer, or branch takeoff (weldolet/reducing
  tee) never does.
- A **branch rides along** inside whichever spool contains its takeoff point, all the
  way to its own dead end (typically its own small valve + blind flange) — even when
  that's the very last thing before the next main-run valve. A branch never gets its
  own spool and never interrupts the main run's numbering.
- A **field weld belongs to (closes) the spool it ends**, not the spool that starts
  after it. If a spool needs two forced cuts back to back, the bare piece between the
  two field welds is its own spool even with zero other welds in it.
- **Real spool tags are printed on the sheet** — a "PIPE SPOOLS" schedule near the
  title block lists them (e.g. `..."-N-04"`, `"-N-05"`), each with its own
  pointer-arrow leader onto the isometric. Always prefer reading these over inventing
  synthetic tag numbers.
- **Trust the drawing over the weld-list table's row order** when identifying field
  welds: the WELD LIST table can be sorted by category (all FABRICATION-ITEM rows
  first, then all ERECTION-ITEM/FIELDWELD rows), which does NOT match physical
  position along the pipe. A genuine field weld carries a distinct hatched "FW" mark
  at its own point on the isometric — if that mark's position disagrees with the
  table's row order, the mark on the drawing wins.

### Current extraction pipeline design (as of the last session)

`apps/worker/src/extraction/iso.ts` + `packages/extraction-schemas/src/iso.ts` ask
the model to answer a small **local** question per weld instead of grouping a whole
sheet's welds into spools in one shot (that whole-sheet approach reliably produced
out-of-sequence groupings, e.g. `[5,6,13]`):
- `comes_after_weld` — which weld sits immediately before this one (branches are just
  two welds sharing one `comes_after_weld` parent)
- `closes_spool` — does a spool end right at this weld

### Boundaries get their own pass, before the sheet is read

Each sheet is read **twice**, and the order matters:

1. `ISO_SPOOL_BOUNDARIES_TOOL` (`locate_iso_spool_boundaries`) — finds only where the
   spools break, and nothing else.
2. `ISO_SHEET_TOOL` (`record_iso_sheet`) — the full read, handed pass 1's boundaries
   as given, so its job for spools is just the welds and their `comes_after_weld`.

This split exists because asking for boundaries as one field among forty did not work.
On a busy sheet the model stopped looking for valves altogether and divided the weld
numbering into even pieces: sheet 2 of the reference ISO came back cut at welds 4, 8,
12, 16 and 20 — 26 welds and 6 spools, spaced exactly 4 apart. Rendering that sheet's
tiles and reading them by hand settled *why*: the valves are perfectly legible at the
current 3×2 tiling (bowtie symbols with flange bars and BOM balloons leadered to
them), so it was never a resolution problem, and denser tiles would not have fixed it.
It was attention. Alone, with nothing else to record, finding the valves is a task a
sweep of the drawing actually answers.

Pass 1 asks for **every valve on the sheet**, not just the boundary ones — enumerating
what is drawn is far more reliable than picking out a subset, the BOM's valve rows
give a count to check against, and each valve then answers three local yes/no
questions (on the main run? flanged both sides? does pipe continue past it?) instead
of one whole-sheet judgement. On the reference sheet 2 that enumeration lands on the
right number by itself: four 200mm ball valves plus one 150mm gate valve in the
reduced section = the five boundaries its PIPE SPOOLS schedule implies.

Boundaries carry **evidence** (the valve's BOM item and where it sits, or the weld
carrying the hatched FW tick), so a guess is visible rather than merely plausible.

`buildSpoolsFromWeldTopology` in `packages/shared/src/spoolRules.ts` walks those
answers into spools deterministically, then maps them onto the sheet's printed
`spool_tags` in order. Where a weld closes a spool, only the **main run** starts the
next one — any branch taking off at that same weld keeps the closing spool's index.
The main run is told apart from a branch by, in order: the child's own bore (a branch
is smaller-bore; the run size is taken as the *mode* of the sheet's own weld sizes, so
no unit conversion and no hard-coded sizes), whether its whole subtree stays at that
bore (a weldolet tap is made at full bore but drops smaller just after), and finally
subtree size (the run carries on to the end of the sheet, a branch dead-ends).

Two things are decided in code rather than asked of the model: a **field weld always
closes** the spool it ends, and the evidence-backed boundary list **wins over** the
per-weld `closes_spool` flags where both are present.

### Checks that gate a read, and the retry

`spoolProblems` in `apps/worker/src/extraction/iso.ts` judges a sheet against what
that same sheet prints, and a failure triggers one retry that quotes the specific
defect back (plus the sheet's own valve rows from the BOM just read, which turns
"find the valves" into "find these valves"):
- the PIPE SPOOLS schedule fixes the count — N tags means exactly N-1 cuts
- a weld typed FW must be a boundary, since a field weld *is* the forced cut
- a boundary typed `valve` must name the valve it saw
- **valve** boundaries at exactly equal intervals are rejected as arithmetic rather
  than reading (field welds are exempt — regular forced cuts are exactly what the
  6000mm rule produces)

The retry is only accepted if it has strictly fewer problems than the first attempt.

### Checking this without paying for a vision run

```
pnpm --filter @easy/worker test                                     # 25 offline cases
cd packages/db && node scripts/check-spools.mjs [documentId]        # what's in the DB now
cd packages/db && node scripts/dump-iso-welds.mjs <docId> --out raw.json
pnpm --filter @easy/worker replay:spools raw.json                   # what the code would produce
```

The test suite pins the rules against drawings deliberately unlike the reference one
(imperial bores, other tag conventions, no field welds, nested branches,
non-contiguous weld numbering) so the logic can't quietly become fitted to one ISO.
`check-spools.mjs` scores the rows actually stored and `replay:spools` re-runs the
current code over a stored payload — the two disagreeing means the DB rows are stale
relative to the code.

**Cost note:** the boundary pass is an extra tool call per sheet (~16k max tokens,
same images). A 5-sheet ISO goes from 5 sheet calls to 5 + 5.

**What is and isn't verified.** The deterministic half is settled: given correct
boundaries, every sheet of the reference ISO resolves exactly, sheet 2 included (26
welds, 6 spools, three branches all taking off at closing welds — the arrangement that
used to scatter them). That is pinned as a test. What is *not* verified is whether the
model, asked on its own, actually finds the valves — that needs a real vision run, and
the stored payload predates the boundary pass. Scored against that old payload the code
gives **12/18**, all six misses being boundaries put at the wrong weld.

Note the boundary weld is the last **main-run** weld before the valve, not the last
weld by number: on sheet 2 the cuts are after welds 4, 9, 14, 17, 20, because the
branches hanging off welds 9 and 20 ride along inside the spools that close there.
Don't assume tiling is the lever if a sheet reads badly — check first whether the
detail is legible, with `scripts/dump-tiles.ts`, before spending on more tiles.

Also note: tool-call JSON is **not** strictly validated against `input_schema`. Real
runs have returned `spool_tags` as objects (`{spool_tag, ends_at_mainline_weld}`)
rather than the declared `string[]`, so the worker unwraps both shapes. Expect
field-name/shape drift and parse defensively.

### Windows/tooling gotchas hit while working on this
- A long-running `tsx watch` worker process does **not** reliably reload changes made
  to a sibling workspace package (e.g. `packages/extraction-schemas`) even though it
  does reload changes to its own directory (`apps/worker`). If a schema/prompt change
  isn't showing up in real API output, kill and restart the worker process fully
  rather than trusting the watcher.
- `postgres` (npm package) can't infer parameter types inside `jsonb_build_object(...)`
  or `INSERT ... SELECT` — add explicit `::text`/`::int` casts, or split into a typed
  SELECT + plain `INSERT ... VALUES`.
- The `postgres` package only resolves from `packages/db` (direct dependency) — run
  ad hoc DB scripts from there, not from `apps/web` or `apps/worker`.

## Where the rest of the context lives
- `git log` — actual change history and commit messages.
- This session's Claude Code memory files (if present on this machine) at
  `~/.claude/projects/<hash-of-this-path>/memory/` — user preferences and
  session-to-session feedback, not duplicated here since it isn't portable across
  machines the way this file is.
