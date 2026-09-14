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

`buildSpoolsFromWeldTopology` in `packages/shared/src/spoolRules.ts` walks those
per-weld answers into spools deterministically, then maps them onto the sheet's own
printed `spool_tags` in order.

**Known gap (unresolved as of the last session):** this fixed the *ordering*
failure mode (spools are now always internally sequential), but valve-detection
*recall* on dense sheets (multiple valves close together) is still inconsistent —
the model sometimes doesn't set `closes_spool: true` at the right position, or at
all, on a busy sheet. Verified by hand against all 5 sheets of the reference ISO;
only the simplest sheet (one field weld, two spools) came back perfectly correct on
a real API run. If picking this up again, the next lever to try is probably
per-valve close-up tiles rather than the current fixed 3×2 whole-sheet tile grid.

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
