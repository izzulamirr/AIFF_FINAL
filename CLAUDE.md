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
used to scatter them). That is pinned as a test.

The boundary pass has been measured once, on the reference ISO's two worst sheets
(`scripts/probe-boundaries.ts`, ~$0.89 for both):

- **Valve enumeration works.** Sheet 2 returned 8 valves against a BOM of exactly 8;
  sheet 5 returned 6 against exactly 6. Main-run vs branch was right on every
  small-bore valve.
- **Tying a valve to a weld number did not.** Sheet 2 reported *all four* of its ball
  valves as sitting after weld 14. Pass 1 is not reading the weld list — pass 2 is —
  so placing valves in the weld numbering was the same "two jobs at once" mistake at a
  smaller scale. Pass 2 is now always handed the boundary valves by name and asked to
  place them; pass 1's own weld numbers are passed on only when every boundary got a
  distinct one.
- **The model contradicted its own observations.** Both of sheet 5's check valves came
  back on the main run, flanged both sides, pipe continuing past — and `is_boundary`
  false. `boundaryValvesOf` now applies that conjunction in code.

Pass 2 has since been measured on the same sheet, replaying that saved pass-1 answer
(`scripts/probe-sheet.ts`, ~$0.89):

- **It recovered the boundary pass 1 missed.** Told it had 4 of 5 cuts, it found the
  150mm gate valve in the reduced main-run section — the one pass 1 had filed as a
  branch. The count-mismatch note in `buildBoundaryNote` is what does this.
- **Welds and bores read correctly**: 26 welds, with 5/6 at 15mm, 10/11 and 21/22 at
  80mm, 14/15 at 150mm, and both 80mm branches hanging off the right takeoff welds.
- **Placement is the unsolved part.** It returned boundaries after welds 3, 8, 13, 17,
  23 where the drawing has 4, 9, 14, 17, 20.

### Placing a valve in the weld numbering — the open problem

`scripts/probe-placement.ts` isolates just this step (supply the weld list and the
valves, ask only which weld each valve sits after; ~$0.36 a run instead of ~$0.89).
Two runs on the reference sheet 2, and the failure is stable:

| Attempt | Answer | Correct |
|---|---|---|
| Inside the full sheet pass | 3, 8, 13, 17, 23 | 1/5 |
| Placement asked alone, flange wording spelled out | 1, 7, 14, 17, 23 | 2/5 |
| Same, plus the main-run weld sequence supplied | 3, 7, 14, 17, 23 | 2/5 |
| **The drawing** | **4, 9, 14, 17, 20** | |

Every answer picks welds that are **consecutive** — (3,4), (7,8), (14,15), (17,18),
(23,24). The two it gets right, 14 and 17, are exactly the two valves whose flanking
welds genuinely are consecutive. The correct pairs for the other three are (4,7),
(9,12) and (20,23): they straddle a gap, because the branch welds (5/6, 10/11, 21/22)
are numbered in between. Telling it that explicitly, and giving it the main-run
sequence so the gaps were visible, did not change the answer.

So: the model locates a valve to roughly the right stretch of pipe but cannot reliably
say which weld mark is adjacent to it, and defaults to the weld numbered just before.
What has been tried and did not work: the flange-weld wording, requiring the downstream
weld as well to force the pair to be considered, and supplying the main-run sequence.

Worth noting for whoever picks this up: a drain or vent branch is usually placed right
beside an isolation valve, to drain the section the valve isolates — so a branch
takeoff sitting immediately next to a main-run valve is a real piping pattern, not a
quirk of this drawing. That makes "the main-run weld just before a branch-number gap"
a tempting rule, and three of sheet 2's five cuts fit it. It is a heuristic, not a
rule, and it has not been tested on another drawing — do not encode it without one.

#### Per-valve crops: the next lever, part-tested

`renderPdfPageCrops` in `pdfImages.ts` cuts a close-up centred on one point, rendering
the page at whatever scale makes that region land near 1568px, so detail *grows* as the
frame narrows. `scripts/dump-crops.ts` writes them out to look at;
`scripts/probe-valve-crop.ts` asks the flanking-weld question about a single valve with
one crop and nothing else in frame (~$0.08 a call).

Looking at the crops settles that legibility is not the obstacle: at 0.1×0.14 of the
page, the weld flags, flange bars and item balloons around a valve are all crisp, far
clearer than in any tile. One call was run against the first valve on sheet 2:

- It **correctly refused to guess** the upstream weld — "leader goes to a flag
  off-image/not legible" — instead of inventing a plausible number. That is the
  behaviour the earlier attempts lacked, and it comes from telling it a blank is
  better than a guess. Keep that instruction.
- It returned `2` for the downstream weld, reading the **square item balloon `[2]`**
  (the weldolet's BOM number) as a weld. Weld flags are HEXAGONAL and labelled `BW7` /
  `FW6` / `TH6`; square boxes are BOM item balloons and never carry a weld number.
  Nothing in the prompt had said so. It does now — **untested**, credit ran out.
- The crop was too tight: a weld's number flag can sit well off the pipe, so a frame
  that holds the valve and both weld dots can still cut off the flags that name them.
  `MIN_CROP_FRACTION` now floors the region size. Size a crop by what must be
  READABLE, not by what must be VISIBLE.

The two fixes helped but **did not solve it**. The same valve on sheet 2, same crop,
asked three times, gave three different answers:

| run | flanking welds read |
|---|---|
| 1 | blank, and `2` — the square item balloon |
| 2 | `BW3` and `BW7` |
| 3 | `BW7` and `BW9` |

The flags themselves are legible — by run 2 it was volunteering "the square box [14] is
the valve BOM balloon, not a weld", so the hexagonal/square distinction landed. What it
cannot do reliably is match each weld DOT to its OWN flag: the leaders are long, they
cross each other and they cross the pipe, and following one to its end is line-tracing
rather than recognition. Run 3 contradicted itself in its own description — "its leader
runs down to the hexagonal flag BW7 (upper area)".

**So per-valve crops are not the answer either.** Legibility was never the constraint;
leader-to-flag attribution is, and making the picture bigger does not help with it.

One more design error found and fixed on the way: **do not ask for the upstream and
downstream weld.** Which side of a valve is upstream depends on the flow direction, and
a close-up crop does not show it — a run read the drawing correctly ("the dot on the
upper-right side goes to BW7") and then filled the two fields the wrong way round. Ask
for the flanking pair UNORDERED and order it in code from the weld chain, which does
know the run's direction.

#### A caveat on the scores above

The 4, 9, 14, 17, 20 that earlier attempts were scored against is **inferred, not
verified**. What was verified by hand is the spool *membership* — N-04 = welds 1-6,
N-05 = 7-11, and so on. The boundary weld numbers were then derived by assuming the run
passes through the welds in numeric order.

The crop reading gives reason to doubt that: it puts the first valve between welds 3
and 7, not 4 and 7. Both are consistent with N-04 holding welds 1-6 — they differ only
in whether the run reaches weld 3 before or after weld 4. Weld numbering on an ISO does
not have to follow run order (the weld_no schema text warns about exactly this), so
"boundary after weld 3" with the run going ...2 -> 4 -> 3 -> valve -> 7... would put
welds 1-6 in N-04 just as well.

This matters because `buildSpoolsFromWeldTopology` works on the topology, never on the
numbers: get `comes_after_weld` right and the boundary lands correctly whichever way
the numbering runs. So before scoring another placement run, confirm against the
drawing which welds actually flank each valve. Some of the earlier 1/5 and 2/5 scores
may have been against the wrong expectation.

#### Tracing direction — a rule from the piping side

Which way a run goes is not guesswork, and `FLOW_DIRECTION_RULE` in
`packages/extraction-schemas/src/iso.ts` now carries it into every prompt that needs an
order (`comes_after_weld`, boundary placement):

> Follow a drawn flow arrow where there is one. Where there is none, **flow runs
> downward** — start at the top of the run and work down; the EL elevations at the run's
> ends confirm which end is high. Where the run splits at a branch, take the **EAST leg
> first, then the WEST**. A branch is a detour you come back from, never a change of
> direction of the main run.

Also spelled out alongside it: *before* means before **in that walk**, not
lower-numbered. Welds are frequently numbered out of the order the pipe reaches them, so
a run can go weld 2, then 4, then 3 — record what the drawing shows and never reorder to
make numbers ascend. This is why `buildSpoolsFromWeldTopology` works on topology alone.

#### What to try next, and what is already ruled out

Ruled out by measurement, do not spend on these again:
- more/denser tiles — the valves and flags are already legible at 3×2
- per-valve close-up crops — legible, but the readings are unstable (above)
- prompt wording about which weld to pick — three variants, no improvement
- **reading the labels as PDF text** — checked: page 2 of the reference ISO returns
  **0 text items**. The CAD export outlined every label, so `BW7` is vector paths, not
  text. `pdfText.ts` seeing only a footer watermark is the same fact.

**The weld list table is the complete set of welds on a sheet.** Nothing else drawn is a
weld, so any number reported that is not one of its IDs was read off something else — a
square BOM item balloon, most often. Both the schema and the probe now say so, and the
probe rejects an out-of-list number rather than passing it on. Weld identity is a solved
input; only ORDER and ADJACENCY need the drawing.

#### Reading welds off the geometry — built, and it works

`src/pdfGeometry.ts` recovers a page's drawn paths (CTM tracked through the
save/restore/transform stack, based on the viewport matrix so a rotated sheet lands the
right way up). `src/extraction/isoWeldMarks.ts` then finds each weld and its number flag
without looking at a picture:

- **A weld number flag is a hexagon outline** — 7 points (six corners plus the close),
  all drawn to one height (15pt here), width varying with label length.
- **A weld mark is a small filled blob near the leader's far end.** Deliberately *not*
  tested for roundness: a weld dot is a circle drawn in one of the three isometric
  planes, so it projects to an ellipse squashed differently depending on which way its
  pipe runs — a real one came through at 7.2 × 2.3pt. Requiring roundness cost 8 of 26
  welds on one sheet.
- **A leader is walked, not read.** CAD splits a bent leader into separate segments, so
  the tracer indexes segment endpoints and walks flag → segment → segment until it
  arrives at a mark.

Measured across all five sheets of the reference ISO (`scripts/trace-weld-marks.ts`,
free to run):

| sheet | flags found | welds known | leaders traced |
|---|---|---|---|
| 1 | 25 | 25 | 23 |
| 2 | 26 | 26 | 25 |
| 3 | 11 | 11 | **11** |
| 4 | 16 | 16 | **16** |
| 5 | 14 | 14 | **14** |
| **total** | **92** | **92** | **89 (97%)** |

**Weld detection is exact on every sheet** — 92 flags against 92 hand-verified welds,
no miscounts and no duplicates, which vision never managed (it once reported weld 1
twice on sheet 4 and produced 17 rows for 16 welds).

Two things took the trace from 75 to 87:

- **Leaders end in an ARROWHEAD, drawn as its own filled triangle**, so the leader LINE
  stops at the arrow's base, several points short of the mark it points at. Widening the
  arrival radius blindly starts matching whatever mark is nearby; instead, when a leader
  stops short, the mark is looked for STRAIGHT ON from it — nearest mark within 40pt and
  a ~28 degree cone of the direction the leader was travelling. `markDistance` is
  reported so a reviewer can tell a landed match (~3pt, certain) from a pointed one.
- **Each mark belongs to exactly one flag.** Two flags claiming the same mark means one
  leader was followed somewhere wrong, so the better fit keeps it and the other is
  returned as untraced rather than reporting a weld at another weld's position. That
  check stays clean at every threshold tried, which is the main evidence the pointing
  matches are not grabbing each other's marks.

Two smaller thresholds account for the last few: a real leader can be as short as 7pt
(`MIN_LEADER_PT`), and a leader can start up to ~5pt off the flag's box rather than
touching it. A leader can also OVERSHOOT — run a little past its dot rather than
stopping at it, putting the mark behind the tip where the forward cone cannot see it —
so a short any-direction fallback (`OVERSHOOT_PT`) catches that.

Sheets 3, 4 and 5 are complete. The last 3, on sheets 1 and 2, fail EARLIER than
arrival: no candidate leader segment is found leaving the flag at all, so there is no
tip to match from. Raising the arrival tolerances does nothing for them (swept 22 →
55pt: no change, no collisions), which is the evidence that the problem is at the start
of the walk, not the end. Whatever attaches those flags to their marks is either not a
stroked segment or begins further from the flag box than anything else on the sheet —
worth cropping one and looking, the way the arrowhead and ellipse cases were settled.

#### Reading the numbers: a contact sheet of flags

Geometry cannot read the number inside a flag — the exporter outlines text, so a label
is glyph paths and `getTextContent()` returns nothing. But knowing every flag's exact
box turns that into a different job. `renderRegionContactSheet` in `pdfImages.ts` cuts
each flag out at 5x and lays them on one numbered grid, and `ISO_WELD_FLAGS_TOOL` reads
them. The model never has to find anything — it reads short labels that are already
isolated and blown up.

On sheet 2 of the reference ISO: **26/26 labels read exactly**, complete and unique
1..26. 2,844 input tokens for the whole sheet's welds (~$0.08) against ~16k for the tile
set. Run it with `scripts/probe-flag-labels.ts`, which also checks the numbers read form
a complete unduplicated set — a strong self-check, since a misread almost always shows
up as a gap or a repeat.

**The flag's prefix is NOT the weld type — do not use it as one.** Loading the geometry
against the existing weld rows put this beyond doubt: the prefix disagreed with the weld
list on 3 of 36 welds, and in every case the weld list is right. Sheet 3's weld 6 is a
FIELD weld (hand-verified: it closes N-10) yet its flag reads `BW6`; sheet 2's welds 9
and 20 are TAPWELDs yet read `BW9` and `BW20`. The flag numbers the weld; the WELD LIST
table types it, and a field weld is marked separately by its hatched "FW" tick on the
drawing. Take the NUMBER and the POSITION from geometry, and the TYPE from the table.

Thinking is deliberately off for that call: it is reading, not reasoning.

**Render the contact sheet and look at it before paying for it.** `--preview <out.png>`
on `scripts/export-weld-geometry.ts` builds the exact image the call would send and
writes it to disk instead of sending it, and `--labels-from <labels.json>` replays a set
of readings ({"2-1": "BW7", ...}) without a call at all. Two things that buys:

- A broken render costs nothing to find. `renderMultiPageContactSheet` had never
  actually been run when it was first needed for sheets 1 and 5.
- The sheet is legible enough that the labels can be read straight off the preview and
  fed back through `--labels-from`, for nothing. All 39 flags of sheets 1 and 5 were
  read this way and agreed character-for-character with what the paid run had returned
  — 39 of 39. **The self-check is what makes that safe**: the numbers on each page
  must come back as a complete, unduplicated 1..N, and `reportCompleteness` says so
  explicitly. Send every flag on the page including untraced ones, or that check cannot
  run.

So the weld half is done: **detection exact (92/92 by geometry), numbering exact (26/26
by contact sheet), position for 87/92** — sheets 3 and 5 complete, 5 leaders outstanding
across sheets 1, 2 and 4.

#### Seeing it in the database

```
pnpm --filter @easy/worker exec tsx scripts/export-weld-geometry.ts <file.pdf> out.json [--read-labels 2,3] [--preview sheet.png] [--labels-from labels.json]
cd packages/db && node scripts/import-weld-geometry.mjs out.json [documentId]
```

The export is free except for `--read-labels`, which sends one contact sheet per named
page to put a weld number against each position. The import adds a `geometry` block to
each matching weld row's attributes — position as a page fraction, the fit in points,
run order, `comes_after`, `on_branch` — **without deleting or creating any row**, so the
drawing-derived answer sits next to what the vision extraction recorded and the two can
be compared in place.

On the reference ISO that is 36 weld rows enriched (sheets 2 and 3, the ones whose flags
were read), with fits of 2.9–3.4pt for a leader that lands on its mark. A weld the
geometry located but could not name is reported, never guessed at.

#### Spool membership without run order — this is the one that works

**A spool is a CONTIGUOUS block of weld numbers.** Checked against all five sheets as
stored and against the hand-verified answer, and it holds everywhere. That collapses the
problem: a sheet's spool assignment is fully described by its CUT POINTS, N printed
spool tags means N-1 cuts, and **run order is not needed at all** — which is why the
ordering work above, still unsolved, does not block this.

`src/extraction/isoSpoolCuts.ts` finds the cuts. A cut is at exactly two things:

1. **A field weld** — read straight off the weld list, no drawing needed. On sheet 3
   that is the entire answer, and on sheet 4 both cuts.
2. **A bolted joint on the main run** — found geometrically, below.

**Look for the FLANGES, not the valve.** This is what took sheet 5 from 1 cut of 3 to
3 of 3. Its three boundaries are a ball valve, a flanged swing check valve and a wafer
check valve, and only the ball valve has a symbol worth recognising — the swing check
is drawn as nothing but the gap between its two flanges. Valve symbols are whatever the
CAD library happened to contain; a bolted joint is always the same picture, **a pair of
flange bars facing each other**.

A flange is a short bar drawn across the pipe: a 4-corner polyline (usually 5 points,
the first repeated), longest edge several times its shortest. On these sheets every one
measures 26.3 x 15.2pt, long edge 24.3, ratio 4.0, lw 0.72 — identical at every joint,
which is why they are paired by likeness TO EACH OTHER rather than against any absolute
size. Two bars make a joint when they are alike in size, parallel, and close enough to
be bolted.

Four things that each cost a cut when they were wrong:

- **A joint sits ON the pipe.** The title block and BOM table are full of glyph strokes
  making these shapes — 140 of them on sheet 1 — and none is near a weld.
- **Flanges bolt FACE TO FACE.** The line joining two bars' centres must run ACROSS
  their faces, not along them. Two bars offset ALONG their faces are two different
  pipes' fittings that happen to be adjacent: sheet 1's two 15mm vent branches each end
  in a socket-weld fitting drawn as a bar, and pairing those invented a third cut
  between welds 18 and 21. This test is the whole difference between 2 cuts and 3 there.
- **Take one weld from EACH SIDE**, decided by the two welds lying in OPPOSITE
  directions from the joint — not by projecting onto an axis taken from the symbol. A
  valve drawn as two triangles can have both triangles sharing one bbox centre, making
  that axis **(0,0)**; every weld then projected to side zero, nothing was found on
  either side, and two real boundaries on sheet 5 were dropped by a bare `continue` with
  no diagnostic. Nor simply the two nearest: those can both be on one side, which put
  one of sheet 2's cuts three welds early.
- **Do NOT filter by the sheet's main bore.** A valve in a REDUCED section of the main
  run is smaller than the line size and still cuts a spool — sheet 2's 150mm gate
  valve sits between two 150mm welds on a 200mm line. Require only that the two flanking
  welds match EACH OTHER.

**Requiring a weld on BOTH sides is what excludes a branch**, with no rule about bores
or branches needed. A branch dead-ends in a blind flange, which is bolted on rather than
welded, so there is no weld beyond it; a tie-in at the edge of the sheet is the same
shape, the line continuing onto another drawing. Both drop out on their own.

The cut itself is **`max(flanking welds) - 1`**: everything numbered below the joint's
downstream weld belongs to the spool ending there, branch welds numbered in between
included, which is the "branch rides along" rule falling out for free.

Measured against the reference ISO — **every sheet now resolves**:

| sheet | spools | cuts found | result |
|---|---|---|---|
| 1 | 3 | **2 of 2** — field weld 12, joint 6/7 | all 25 welds agree with what was stored |
| 2 | 6 | **5 of 5** — after 6, 11, 14, 17, 22 | matches the hand-verified answer exactly |
| 3 | 2 | **1 of 1** — field weld 6 | agrees with what was stored |
| 4 | 3 | **2 of 2** — field welds 6, 7 | one weld moves, N-13 -> N-12 |
| 5 | 4 | **3 of 3** — after 5, 10, 12 | eight welds move; verified four ways |

**A sheet whose cut count does not match its printed spool count is left alone, never
guessed at.** That check is what caught the sheet-1 over-cut described above.

On sheet 2 this moves welds 13 and 14 into N-06 and weld 17 into N-07, exactly the
correction the hand-verified answer calls for. Sheet 5 is the one the stored extraction
had most wrong: the drawing gives N-15 = 1-5, N-16 = 6-10, N-17 = 11-12, N-18 = 13-14,
against a stored N-15 = {1} alone. Four independent things agree on it — the BOM's
own item list (items 9, 10, 11 being the wafer check, the swing check and two ball
valves), the flange pairs in the geometry, the printed spool-tag count, and **each spool
tag's pointer leader landing inside the block of welds claimed for it**, which is worth
remembering as a free cross-check on any sheet.

```
cd packages/db && node scripts/dump-weld-list.mjs welds.json
pnpm --filter @easy/worker exec tsx scripts/spool-cuts.ts <file.pdf> welds.json geometry.json cuts.json
cd packages/db && node scripts/import-spool-cuts.mjs cuts.json --write
```

The import writes `attributes.geometry_spool` next to the stored `spool_no` and changes
nothing else, so the document page shows both and a reviewer can see which welds the
drawing disagrees about.

One bug worth remembering: an unread flag label parsed to weld number **0**, not null
(`Number("") === 0`), and a cut computed from it landed at -1 — which then accidentally
satisfied the "right number of cuts" check on sheet 1. Guard for `> 0`, not just
non-null.

#### Scored against a real re-extraction — the pipeline does NOT reproduce this

The geometry answer is stored in the database by scripts, and the worker's own
extraction is untouched by any of it: `apps/worker/src/extraction/iso.ts` still
drives spools through the two vision passes and `buildSpoolsFromWeldTopology`.
So a re-extraction overwrites the lot — and one did, on 15 Sep 2026. Every
`extracted_tags` row for the document was deleted and recreated, taking
`attributes.geometry_spool` and `attributes.spool_no_vision` with it.

Scored against the hand-verified `REFERENCE` table in `scripts/replay-spools.ts`:

| | spools correct |
|---|---|
| the real extraction, as it left the database | **2 of 18** |
| the same payload replayed through current code (`replay:spools`, free) | **2 of 18** |
| the geometry cut finder | **18 of 18** |

The replay agreeing with the stored rows is the useful part: it means the 2/18
is not drift between code and data, it is what this pipeline produces. Use
`replay:spools` to answer "would a re-run give the same" WITHOUT paying for a
vision run — it re-runs the deterministic half over the stored payload.

**That REFERENCE table predates the geometry work** (committed in `f1c22d2`,
long before), and it carries all five sheets. The flange-joint detector
reproduces it exactly, sheets 4 and 5 included — which is independent
confirmation of the two sheets that had no other check, arrived at from the
drawing's geometry with the table never consulted.

**A re-extraction also feeds two bad inputs back into the cut finder**, and both
are worth recognising because neither looks like a spool problem:

- **An invented spool tag inflates the count.** `buildSpoolsFromWeldTopology`
  mints `spool-<n>` when the topology walks out more spools than were read, and
  sheet 1 came back with four where three are printed. The "N tags means N-1
  cuts" check only means anything over tags the SHEET printed, so
  `dump-weld-list.mjs` now excludes synthetic ones, and
  `apply-drawing-spools.mjs` empties an invented row rather than leave it
  claiming welds the real spool also claims.
- **A mistyped FW invents a cut.** Sheet 2 weld 5 is a 15mm vent-branch weld;
  the re-extraction typed it FW, and since a field weld IS a forced cut, that
  produced 6 cuts where the sheet prints 6 spools and needs 5. The sheet is
  therefore left alone, which is the count check doing its job — it refuses
  rather than guessing. Sheet 2 is the only one of the five still wrong, and it
  is wrong because of a weld-list read, not a boundary.

So the weld TYPE is now the weakest input. Geometry supplies the number and the
position, the table supplies the type, and when the table is misread there is
currently nothing to catch it. The drawing does carry the answer — a genuine
field weld has its own hatched "FW" tick at its point on the isometric — so
corroborating a claimed FW against that tick is the obvious next geometric
check, and would take sheet 2 to 6 of 6 without touching anything else.

**The durable fix is to wire the cut finder into the worker** so extraction
produces this answer itself instead of a script correcting it afterwards. Until
that happens, treat any re-extraction as destroying the corrections, and
re-apply them with:

```
cd packages/db && node scripts/dump-weld-list.mjs welds.json
pnpm --filter @easy/worker exec tsx scripts/spool-cuts.ts <file.pdf> welds.json geometry.json cuts.json
cd packages/db && node scripts/import-weld-geometry.mjs geometry.json
cd packages/db && node scripts/import-spool-cuts.mjs cuts.json --write
cd packages/db && node scripts/apply-drawing-spools.mjs cuts.json --write
```

`geometry.json` survives a re-extraction untouched: it is read from the PDF, not
the database.

#### The WELD LIST has a Type column AND a Category column — they are not the same

This is the bug that cost sheet 2 its whole assignment, and it is worth knowing
before reading any weld list. The table has four columns:

```
ID | ND | Type                                           | Category
   |    | BUTTWELD FIELDWELD TAPWELD THREADED SOCKETWELD | FABRICATION-ITEM  ERECTION-ITEM
```

**Type is what kind of weld it is. Category is only where it gets made** — in
the shop, or on site during erection. They are independent. A plain BUTTWELD is
very often an ERECTION-ITEM: on sheet 2 of the reference ISO, welds 5, 10 and 21
are all BUTTWELD / ERECTION-ITEM, being the 15mm vent and the two 80mm drain
branches that get tied in on site. **None of them is a field weld.**

The extraction prompt described the table as grouped into "all FABRICATION-ITEM
rows, then all ERECTION-ITEM/FIELDWELD rows", as though those were one category.
The model duly read the Category column and returned sheet 2's weld 5 as FW. And
since a field weld IS the forced cut, that one mistyped weld produced a sixth cut
on a sheet that prints six spools and needs five — so the count check threw the
whole sheet out. One column confused, one sheet lost.

`src/extraction/weldTypes.ts` now holds the only test for this. It accepts FW,
FIELDWELD and FIELD WELD, and explicitly refuses the Category values, so a
Category arriving in the type field answers "not a field weld" rather than
matching by accident. Every field-weld test in `iso.ts` and `isoSpoolCuts.ts`
goes through it. Note `normalizeKey(w.weld_type) === "FW"` was ALSO too strict in
the other direction — a model returning the table word "FIELDWELD" instead of
the code would have been missed silently.

**Correcting a stored type:** `packages/db/scripts/fix-weld-types.mjs` takes a
list of `page` / `weldNo` / `weldType` / `why` objects and requires the `why`,
keeping the replaced value as `weld_type_extracted`. The weld type is the one
input geometry cannot supply — number and position come off the flags and
leaders, the type comes off the table — so it is the input most worth being able
to correct by hand.

#### A field weld is marked on the drawing, and the mark wins

Sheet 4 is the case that proves the existing rule. Its WELD LIST gives Type
FIELDWELD for IDs **10 and 11**. The drawing carries hatched **FW** ticks at
welds **6 and 7**, right beside those two weld dots, on the two 6000mm pieces the
CUT PIECE LIST shows with WS ends. The hand-verified reference agrees with the
drawing: cuts after 6 and 7.

So the table's own Type column can point at the wrong IDs, and "trust the hatched
mark over the table" is not a nicety. **Detecting that tick geometrically is the
obvious next check** — it would have caught sheet 2's phantom FW without any
hand correction, and would confirm sheet 4 against its own table. Everything
needed is already there: the tick is a small hatched mark sitting on the pipe at
a known weld position.

**An open question on sheet 4, not resolved.** Following the spool tag leaders
the way sheet 5 was checked, N-12 lands on the run below the lower FW, **N-14
lands on the 6000mm piece between the two FW ticks**, and N-13 lands on the run
between welds 13 and 14 — which would make the middle spool N-14, not N-13. The
reference and `assignSpools` both map tags onto blocks in sorted order, giving
N-13 the middle. The weld GROUPING is identical either way (1-6 / 7 / 8-16); only
which tag names the middle piece is in doubt. Worth confirming against the
drawing before relying on sheet 4 tag names.

#### Ordering the welds along the run — works, does not yet generalize

`src/extraction/isoRunOrder.ts` walks the run and emits each weld's `comesAfter` and
whether it sits on a branch — which is exactly what `comes_after_weld` is, and what
`buildSpoolsFromWeldTopology` consumes. Verified end to end on sheet 3 against the real
weld numbers (`scripts/probe-weld-chain.ts`, ~$0.04):

```
BW1 -> BW2 -> BW3 -> BW4 -> BW5 -> BW7 -> BW8 -> BW9 -> BW10 -> BW11
```

Every placed weld in the right order. Three things had to be right:

- **Page position cannot orient the walk.** An isometric is drawn on three 30-degree
  axes, so "up and to the right" on paper is a HORIZONTAL direction in the plant, not a
  rise — "flow runs downward" is about elevation, which the page's y does not carry. The
  weld NUMBERING orients it instead: start from the end nearest the lowest-numbered
  weld. (Geometry still supplies adjacency and branches, which numbering cannot.)
- **Continue from where the run actually arrived**, not from the longest edge at the
  node. Node merging has to be loose enough to bridge a fitting (a valve with its
  flanges breaks the drawn line), which pulls several distinct points into one node —
  and "longest first" then jumps clean over the short connector the run really takes.
  This alone moved BW3 from the end of the chain to its right place.
- **Sweep leftover components**, or welds on a stretch the first walk never reaches are
  silently dropped.

**Where it stops:** only **55 of 87** located welds get ordered, and sheet 3 is the only
one that comes out clean. The cause is measured, not guessed — the run is found by line
weight, and the heaviest weight does not carry the whole run:

| page | marks on `lw=1.98` |
|---|---|
| 1 | 20/23 |
| 2 | 13/25 |
| 3 | 10/11 |
| 4 | 7/14 |
| 5 | 5/14 |

So the pipe is drawn at MIXED weights and cannot be isolated by weight alone.

**Four ways of finding the run have now been tried. Read this before trying a fifth.**
Each one after the first reached MORE welds and ordered them WRONG, and each was
reverted, because a wrong `comes_after_weld` puts welds in the wrong spool — worse than
leaving them unplaced. Sheet 3 is the yardstick: the shipped version orders it exactly.

| approach | placed | sheet 3 order |
|---|---|---|
| heaviest line weight *(shipped)* | 55/89 | `1,2,3,4,5,7,8,9,10,11` ✅ |
| isometric axis, segments split at marks | 87/89 | `1,2,11,10,8,7,5,4,3,9` ✗ |
| grow from weld-carrying segments | 89/89 | `1,11,10,9,8,7,4,5,3,2` ✗ |
| …plus axis filter, tight vertices, collinear bridges | 87/89 | `5,7,4,11,9,8,1,3,2,10` ✗ |

What was learned, and is worth keeping:

- **The axis rule is real.** Measured against known-run segments, every one lies at 30,
  90 or 150 degrees. But so does every DIMENSION line, since a dimension is drawn
  parallel to what it measures — so the axis alone selects both.
- **Segments must be split at the marks.** CAD does not break a line for a weld, so a
  mark sits partway along a segment rather than at a vertex; without splitting, almost
  nothing connects.
- **Leaders poison a weld-seeded grow.** A leader ENDS at a weld mark, so "carries a
  mark" selects every leader too and the run grows out into the annotation. The axis
  test excludes them, which is the one thing that must not be dropped.
- **Loose node merging tangles a dense graph.** Merging ends within the fitting gap
  (26pt) pulls distinct points into one node and the walk hops between unrelated
  stretches. Tight vertices plus explicit collinear bridges is the right shape — but on
  its own it did not fix the ordering either.

So coverage is not the hard part; **adjacency is**. Every attempt that widened the graph
also introduced a route between welds that are not neighbours. The next attempt should
probably stop trying to classify the run at all and instead verify each candidate
adjacency — two welds are neighbours only if the path between them is short, stays on
one axis or turns at a single elbow, and passes no third weld — rejecting a link that
does not look like a real piece of pipe rather than curating the segment set up front.

#### Geometry spike — the raw numbers behind the above

Page 2 of the reference ISO through `getOperatorList()`:

| | |
|---|---|
| `constructPath` ops | 11,310 |
| subpaths recovered | 13,926 |
| runs over 40pt (pipe and leaders) | 13,040 |
| `closeFillStroke` (filled shapes — dots, flags) | 2,578 |

The drawing is fully vector: the pipe polyline, every leader line and every weld dot are
real paths. So matching a weld dot to its flag can be **graph traversal instead of
vision** — follow the leader path from the dot and see which flag outline it lands in.

One wrinkle: `constructPath` args come back in pre-transform space (values like
31248, 22560), so the CTM stack has to be tracked through the 85 `transform` ops to map
them to page coordinates. That is the main work in the spike.

The flag's NUMBER would still need reading, but only for a small glyph group at a known
location — a far easier ask than "find the flag this dot belongs to", and it could even
be matched against the weld list's known IDs rather than read open-endedly.

The ordering and branch handling hold up on the hardest sheet; what remains is this
one-weld offset rather than a structural failure. Scored against the older stored
payload the code gives **12/18**.

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
