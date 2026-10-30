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

#### Reading the FLOW ARROW off the drawing — the code now does what the rule says

`src/extraction/isoFlowArrows.ts`. The revised reference ISO draws flow arrows, so
"follow a drawn flow arrow where there is one" stopped being advice to the model and
became something the geometry can read. Free.

**Why a bare "filled triangle" search is useless.** A page holds 2,500–5,200 filled
triangles: glyph strokes in the title block and tables, every leader's arrowhead, every
dimension terminator. An earlier attempt reported 58–60 mid-pipe hits a page and was
abandoned as too noisy.

**Three things together pick them out, and the separation is total.** Measured across
both revisions — the earlier drawing has no flow arrows at all, which makes it a true
negative control:

| page | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| filled triangles | 2957 | 5195 | 3428 | 4745 | 2577 |
| ON a pipe (≤4pt) | 783 | 806 | 386 | 652 | 485 |
| …and ALONG it (≤10°) | 342 | 239 | 137 | 205 | 137 |
| **…and with an OUTLINE** | **1** | **1** | **1** | **1** | **0** |
| same pages, OLD drawing | 0 | 0 | 0 | 0 | 0 |

Not one false positive on five sheets that have none. Every hit sits 0.2–1.3pt off the
pipe and 1.0–1.9° off its axis, so nothing is near a threshold, and sheet 5 has no
near-miss even at 12pt — it simply has no arrow drawn.

**The OUTLINE is the discriminator.** A flow arrow is a filled triangle PLUS a stroked
four-point outline round it that CROSSES ITSELF; a leader or dimension arrowhead is the
filled triangle alone. That same self-crossing outline is what fooled the spool cut
finder into reading an arrow as a valve — the shape that broke that is the shape that
identifies this.

Deliberately **not** filtered by size, though every arrow measures 13.7–15.0pt: the
conjunction already separates the two drawings completely, so a size bound would add
nothing but a number fitted to one CAD library.

**Take the apex from the BASE MIDPOINT, not the centroid.** The centroid sits a third of
the way up and skews the direction on a stubby head. The apex is the vertex furthest
from the midpoint of the opposite edge.

**What it is used for: orienting the run walk.** `isoRunOrder` had no reading of the
flow at all — it started from "the end nearest the lowest-numbered weld", on the
reasoning that CAD numbers welds along the run. That is an assumption about the
draughtsman. An arrow fixes the direction of travel on the edge it sits on, and the
run's start is then whichever open end lies upstream — found by removing that edge from
the graph and seeing which side the upstream node falls on, which is exact and copes
with a run that doubles back.

**It confirms the numbering rather than overturning it, which is why the swap is safe.**
On all four sheets with an arrow the upstream end is the one the numbering had already
chosen, and every ordering is unchanged — sheet 3, the yardstick, still comes out
`1,2,3,4,5,7,8,9,10,11`. The original drawing is bit-for-bit unchanged, still 55 welds
ordered, still oriented by numbering. `orientedBy` says which rule decided and whether
the two agreed, and is stored by `export-weld-geometry.ts` alongside the arrows.

**Sheet 4's arrow points UP**, at page angle 269° — a riser. The fallback in
`FLOW_DIRECTION_RULE` is "where there is none, flow runs downward", so on that sheet the
default is simply wrong, which is the whole argument for reading the arrow. The other
three sit at 331.9°, within 2° of the 330 isometric axis; every arrow landing on a real
drawn axis is independent confirmation the direction maths is right.

```
pnpm --filter @easy/worker exec tsx scripts/probe-flow-arrow-candidates.ts <pdf> [page]
pnpm --filter @easy/worker exec tsx scripts/probe-run-order.ts <pdf> <flag-labels.json> [page]
```

The first prints every filled triangle against all three tests, so the rule can be
re-derived from measurements on a new drawing rather than trusted. The second prints the
walk and what oriented it — **run it on sheet 3 and check that order before believing
anything else here**, since four different attempts at widening the run graph each
reached more welds and got sheet 3 wrong.

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

#### Scored against a real re-extraction — why the wiring below exists

This is the measurement that justified wiring the cut finder into the worker;
it describes the pipeline BEFORE that was done. The geometry answer was stored
in the database by scripts and the worker's own extraction was untouched by any
of it, so a re-extraction overwrote the lot — and one did, on 15 Sep 2026. Every
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

#### The cut finder is now IN the worker — a re-extraction produces this itself

`apps/worker/src/extraction/isoGeometrySpools.ts`, called from
`extractIsoDocument`. The scripts below still work and are still the way to
re-apply an answer by hand, but they are no longer the only way to get one: an
extraction now returns the drawing's spools as its own result.

How a sheet is read, in order:

1. **The flag pre-pass, free.** `locateWeldFlags` finds every weld mark and its
   number flag off the vector paths.
2. **One contact sheet for the whole document** puts a NUMBER against each
   flag. Accepted only where a page's labels come back a complete,
   unduplicated 1..N (`numberingComplete`) — a misread shows up as a gap or a
   repeat, so this is a real check and not a formality.
3. **The sheet pass, unchanged**, reads the title block, the BOM and the WELD
   LIST. That is what the model is good at, and it is the only source of a
   weld's TYPE.
4. **One more contact sheet** reads the spool TAG strings, so each tag's own
   leader says which block it names rather than sorted order guessing.
5. **`readGeometrySpools`, free**, finds the cuts and assigns every weld.

**Pass 1 — the boundary pass — only runs where step 2 failed.** It costs about
$0.89 a sheet and places 6 of 12 boundaries; the geometry places 18 of 18 on
both revisions of the reference ISO. Paying for the worse answer and discarding
it is pure cost. It is kept, not deleted, because it is still the whole answer
on a sheet whose flags could not be read.

So the wiring is CHEAPER than what it replaces: about $4.45 of boundary passes
off a five-sheet ISO, against roughly $0.15 of contact sheets.

Two things follow from having an exact weld set, both new:

- **The retry is judged on the WELD LIST, not the boundaries** (`weldListProblems`).
  Where geometry has the sheet, every complaint `spoolProblems` makes is about a
  boundary read nothing uses any more, and a retry is a second 32k-token sheet
  pass. What is worth re-reading is the weld list, and the geometry gives a
  known-exact set of IDs to check it against — which catches the duplicate-weld
  and 17-rows-for-16 failures vision has actually produced.
- **A spool row can no longer be invented.** Blocks come from the tags the sheet
  prints, so every row has a printed name and every printed tag with welds gets
  one. `buildSpoolsFromWeldTopology` mints `spool-<n>` when the walk finds more
  spools than tags, which used to put a row in the database claiming welds a
  real spool also claimed.

A sheet the geometry REFUSES falls through to the vision path untouched, and
`rawJson` carries the geometry so `rebuild-iso-tags.ts` replays the whole answer
for nothing.

**Check the wiring without paying**, replaying a saved flag read:

```
pnpm --filter @easy/worker exec tsx scripts/probe-iso-geometry.ts \
  <file.pdf> raw.json flag-labels.json [out-raw.json] [--tag-labels tags.json]
```

It runs the exact code path the worker runs. On the revised reference ISO all
five sheets resolve — 93 of 93 welds placed, 19 rows for the 18 printed spools
(N-15 spans sheets 4 and 5), none invented. On the original, sheets 1, 3, 4 and
5 reproduce the hand-verified table exactly, sheet 4's N-13/N-14 included.

To re-apply an answer to a document by hand, the script route is unchanged:

```
cd packages/db && node scripts/dump-weld-list.mjs welds.json
pnpm --filter @easy/worker exec tsx scripts/spool-cuts.ts <file.pdf> welds.json geometry.json cuts.json
cd packages/db && node scripts/import-weld-geometry.mjs geometry.json
cd packages/db && node scripts/import-spool-cuts.mjs cuts.json --write
cd packages/db && node scripts/apply-drawing-spools.mjs cuts.json --write
```

`geometry.json` survives a re-extraction untouched: it is read from the PDF, not
the database.

#### A VALVE SYMBOL IS NOT A BOUNDARY — only the flanges are

The cut finder used to take three kinds of candidate: a flange pair, a
self-crossing quad (the hourglass a gate valve is drawn as), and a pair of
matching triangles. The two symbol fallbacks are **gone**, and this is worth not
re-adding.

Measured across both revisions of the reference ISO, every one of the 18
verified cuts is found by the FLANGE PAIRS. The fallbacks contributed not one
cut of their own — every hit they produced duplicated a flange pair already
found.

What they did produce is a false positive that cost a whole sheet. **The revised
drawing added FLOW ARROWS.** An arrowhead is outlined as a four-point path that
crosses itself — the same signature as a valve hourglass — and it sits, by
definition, on the pipe between two welds. On sheet 2 one arrow invented a sixth
cut where the sheet prints six spools and needs five, the count check threw the
sheet out, and all 27 of its welds went unassigned.

An arrowhead also passes the flange bar's own shape test (the one on page 2
measures 15.3 long by 5.4 short, a ratio of 2.8 against a threshold of 2.5), so
two arrows on one straight run could pair into a joint that is not there.
`findFlanges` therefore rejects a **self-crossing** path: a flange bar is a
simple quad and does not cross itself. Both facts are pinned as tests against
the real arrow's geometry.

The general rule, which the fallbacks quietly worked against: a spool ends where
the line comes apart with a spanner, and that is ALWAYS a pair of flange bars,
whatever symbol happens to sit between them.

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

#### Which tag names which spool — follow the LEADER, not the number

**Sheet 4's open question is settled: the middle 6000mm piece is N-14.** It was
confirmed twice, by rendering the sheet and by tracing the leaders, and the
user confirmed it independently. `assignSpools` maps tags onto blocks in
SORTED ORDER, which gave that block to N-13 and was simply wrong: the tag
numbers on sheet 4 are not in run order.

```
N-12 -> welds 1-6      (below the lower FW)
N-14 -> weld 7         (the 6000mm piece BETWEEN the two FW ticks)
N-13 -> welds 8-16     (the top run)
```

`src/extraction/isoSpoolTags.ts` reads this off the drawing. A spool tag is a
boxed tag string with a leader to the run, so find the box, walk the leader,
and see which piece it lands on:

```
pnpm --filter @easy/worker exec tsx scripts/export-spool-tags.ts     <file.pdf> geometry.json cuts.json spool-tags.json [--preview tags.png] [--labels-from labels.json]
pnpm --filter @easy/worker exec tsx scripts/spool-cuts.ts     <file.pdf> welds.json geometry.json cuts.json --tags spool-tags.json
```

Tracing is free. Reading the tag STRING in each box is the only part needing
eyes, and `--preview` lays the boxes out as one contact sheet — all 17 of the
reference ISO's tags were read off it at no cost and replayed through
`--labels-from`, the same arrangement as the weld flags.

Three things this needed that the cut finder did not:

- **A leader POINTS at the run, it need not touch it.** Two of sheet 4's three
  are broken where the 15109mm overall dimension crosses them, leaving the tip
  ~65pt short. Put the tip on the nearest pipe segment before asking anything
  of it.
- **A far longer flanking reach: 240pt against the cut finder's 90.** That one
  looks for the welds either side of a VALVE, which are close together; this
  looks for the welds at either END OF A SPOOL. Sheet 4's 6000mm piece has its
  welds 144pt apart, so a 90pt reach finds one of them and reports no pair.
- **A tag landing between welds in different blocks names the LATER block**,
  because a field weld closes the spool it ends — the same rule the dimension
  placer uses.

**Why this is trustworthy: it reproduces the old answer everywhere it should.**
Of the 15 tags whose leaders resolve, **13 agree with sorted order and the two
that disagree are sheet 4's N-13 and N-14** — the exact pair already suspected.
A re-ordering is accepted only if it is a PERMUTATION of the tags the sheet
prints: every tag used once, none invented, none dropped. Anything else keeps
sorted order, which at least uses each tag once.

#### Reading the DIMENSIONS -- built, run for real, 78 of 80 right

Needed because **an isometric is NOT drawn to scale**: on the reference ISO one
run gives 202mm over 70pt and another 464mm over 91pt, so a length can only be
READ, never measured off the page.

But only the NUMBER has to be read. `src/extraction/isoDimensions.ts` gets
everything else from the geometry, free: a dimension is a light-weight line on
a drawing axis with an ARROWHEAD AT EACH END, and its arrowheads sit exactly at
the extent measured. Across the five sheets that finds **83 dimensions**.

```
pnpm --filter @easy/worker exec tsx scripts/export-dimensions.ts <file.pdf> out.json     [--read-labels 1,2,3] [--preview sheet.png] [--labels-from labels.json]
```

**A dimension comes in TWO drawn shapes and both must be looked for.** The
second is a line BROKEN to make room for its own number, so each half carries
an arrowhead at only its OUTER end -- looking for a head at both ends of one
segment misses them entirely. Two halves pair when they are collinear with
their **arrowheads outermost** and a number printed in the gap. "Outermost" is
what does the work: it separates a split dimension from the JUNCTION of two
chained dimensions, where the facing halves are collinear too but meet head to
head at the extension line they share.

**Measure TIP to TIP, not centre to centre.** The arrows point INWARD with
their apexes on the line: the 184's tips are at 380.6 and 420.1 (39.5pt) while
its arrowhead CENTRES are at 377.0 and 423.6 (46.6pt). The centre figure
matches no witness line and no piece of pipe, and over-reports every span by
one arrowhead length.

**A glyph is small and STROKED -- point count is NOT the test.** A digit can be
very few points (a `7` is 3, a `4` is 4 on this drawing), so a minimum of 6
made the whole of `474` invisible and the label finder settled on the
`WOL 200X80` callout beside it, on four labels. What that minimum was really
trying to exclude is arrowheads, and those are excluded by being FILLED.

**Grow the label ALONG the text's own direction.** A dimension's number is
rotated to read along its dimension line, so its glyphs lie in a narrow band
parallel to it while other nearby text sits across that band. Distance alone
does not separate them -- widening the search to catch a long number's outer
digits also chained `WOL 200X80` onto it. Direction does.

**"Connected to the pipes" = a WITNESS line crosses the tip.** Both ends need
not have one (where an end lands straight on the object none is drawn), but
where both do they must be PARALLEL -- that is exactly the condition making the
drawn length equal the measured length. The witness runs on ANOTHER isometric
axis, not perpendicular: the 184's pair both run at 30 degrees while it is
vertical. Two ways to get this wrong, both found by checking the rejects
against the drawing rather than trusting the count:

- requiring a witness at BOTH ends threw out sheet 1's two 385 branch dimensions
- taking each end's LONGEST candidate independently threw out sheet 3's 721
  main-run dimension, whose tips each have a leader crossing them as well --
  look for a parallel PAIR across the two ends instead

With those fixed, **all 83 measure pipe**. So the filter excludes nothing: the
detector's own constraints already admit only run dimensions. The small
"arrows-outside" details (a 24mm gasket gap) never enter -- that shape is
indistinguishable from a chain junction and is reported, never taken.

##### The real run: $0.150, and the preview caught both errors

One call, 83 labels from all five sheets on one contact sheet: **2,308 in /
1,544 out, ~$0.150**. 80 values returned, 3 correctly left blank (one of them a
`BW` weld flag -- it refused rather than inventing a length, which is the
"a blank beats a guess" instruction working).

**Of the 80, two were wrong, and reading the free preview by hand found exactly
those two:**

| cell | returned | drawing | |
|---|---|---|---|
| 4-6 | 8000 | **6000** | leading 6 read as 8 -- and 6000 is the forced-cut length |
| 5-10 | 289 | **299** | middle 9 read as 8 |

Both are digit confusions on rotated text. The other 78 agreed character for
character with the hand read. **So `--preview` is not only a cost-saver, it is
a second opinion**: read the preview yourself, run the call, and the cells the
two disagree on are the cells to go and look at. Correct them by writing the
full set to a JSON file and replaying with `--labels-from`, which costs nothing
and re-runs the checks.

The mm-per-point check printed per axis is weak by design -- the sheet is not
to scale, so it flags real variation as often as a misread. It says where to
look, it does not decide.

##### MATCH AN ARROWHEAD TO A LINE END ON ITS APEX, NOT ITS CENTRE

The two drawn forms put different parts of the arrow at the end it terminates.
An INWARD arrow has its apex exactly on the line's end; an OUTWARD one sits
beyond it, apex nearest and centre half an arrowhead further out again. Matching
on the centre alone therefore works for one form and not the other, and it cost
a whole length: sheet 2's **920** is 82pt of drawn line with its apexes 95.5pt
apart, and the centre test found the upper end at 2.9pt and missed the lower at
10.5, so the pair never formed and N-09 had no E-W extent at all.

`headNear` now takes whichever of apex or centre is nearer. Swept on both
revisions with that in place: 6 gives 89/90 and still misses the 920, **7 gives
92/92 and finds it**, 8 gives 90/90, and 9 falls to 87/87 as heads begin pairing
with ends they do not belong to. 7 is the peak and it is the same on both
drawings.

Do NOT reach for `HEAD_TOLERANCE_PT` alone: swept on the centre test it peaks at
10 (90/91), still never finds the 920, admits spans at 27 and 26 degrees that
are on no drawing axis, and silently grows a page 1 span from 126 to 132pt —
which moves a hand-verified spool.

##### RESCUE A LABEL CROP THAT CAME BACK TOO SMALL TO READ

`labelFor` grows a box out from the glyph nearest the dimension's midpoint.
Where it latches onto the wrong stroke the box comes back tiny, and the cell
renders as an unreadable fragment -- no way to read the number, and no way to
see that was why. Sheet 2's **178** got a 9x10pt box holding a single tick.

A three-digit label measures 18-20pt on these sheets, so a box under
`SUSPECT_LABEL_PT` (14) across is not a number and is opened out to
`RESCUE_CROP_PT` (44) about its own centre. Both of page 2's broken cells then
read plainly.

Applied ONLY to the suspect boxes. Flooring EVERY cell was tried first and it
puts a neighbouring number in frame -- the cell then shows two, with no way to
tell which belongs to the dimension, which is the failure the tight box exists
to prevent.

`labelBox` is now carried into the JSON as well, so a cell that came back
unreadable can be traced to a box on the wrong glyphs rather than guessed at.

**The label finder is now the weakest step, and the contact sheet says so
plainly.** Sheet 4 cost N-12 both of its extents, and neither was a detection
failure -- both dimensions were found, only their numbers were not read:

| cell | what the crop showed | should be |
|---|---|---|
| 4-8 | **"BW4"** -- the box landed on a weld flag | 1500 |
| 4-10 | a fragment; the box is 9x20pt | 10614 |

Two distinct faults. The first is the grower seeding on a WELD FLAG's text
within `LABEL_REACH_PT` of the midpoint -- nothing excludes flag glyphs, and a
hexagon's label is as much a small stroked run as a digit is. The second is a
rotated 5-digit number needing ~33pt along its own reading direction and the
grower stopping at 20; the size rescue does not fire because it tests the
LONGER side, and a rotated label is legitimately thin.

The FIRST is now fixed, by the rule below. The second is not. Read the preview
before trusting a sheet's numbers -- it is free, and it shows exactly which
cells failed and why.

###### THE NUMBER SITS ON THE DIMENSION'S OWN LINE -- seed there, not nearest

`LABEL_ACROSS_PT` in `isoDimensions.ts`. This is what found N-15's **WEST 305**,
and the case is worth keeping because the failure looked like a success.

Beside a field weld the sheet prints an **"FW" note and a hatched tick right
against the pipe**. N-15's west extent is 305mm, too small an extent to hold its
own number, so CAD pushes that number OUT ALONG the dimension line past the
arrowheads -- 34pt from the midpoint of a 23pt span. The "FW" is 17pt away. The
grower seeded on whatever glyph was NEAREST THE MIDPOINT, took the note, and
then grew a perfectly tidy 14x19pt box round it. Nothing looked wrong: the cell
rendered cleanly, it simply held the wrong text.

`LABEL_BAND_PT` did not catch it and could not. That band is measured FROM THE
SEED, so it holds a run together once started -- a seed on the wrong text grows
a confident box round the wrong text. Where a run STARTS is a separate job.

A number belongs to a dimension by sitting ON ITS LINE: in the gap of a split
line, just clear of a continuous one, or further out along that same line where
the extent is too small. What it never does is stand off to the side.

MEASURED on every label box of both revisions, as the distance from the
dimension's own line to the box centre:

| | genuine | the failures |
|---|---|---|
| revised | 0 -- 8.6 (90 labels, all read correctly) | 15.8, 20.6, 29.0 |
| original | 0 -- 9.0 (89 labels, all read correctly) | 13.9, 21.7, 29.0 |

**Nothing at all between 9.0 and 13.9 on either drawing**, and the six outliers
are exactly the six cells that came back wrong or unreadable. 11 sits in the
gap. Re-running both drawings with it: **90 of 93 and 89 of 92 label boxes are
byte-identical**, and the only three that move on each are those failures.

| | was | now |
|---|---|---|
| revised 4-2 | the "FW" note | **305** |
| revised 4-9 | the weld flag "BW4" | **1500** |
| revised 3-5 | a fragment | **no box** -- nothing is printed near that line |
| original 4-8 | the weld flag "BW4" | **1500** |
| original 4-10 | a fragment | a different fragment; the growth fault above |

Two things follow. **Where nothing is in the band there is NO LABEL, and that is
reported** -- a cell showing text belonging to something else is worse than no
cell, because it invites a reading. And a dimension with no box is now possible
at all, which `regionsFor` in `export-dimensions.ts` was not written for: it
cropped before it filtered and threw. Its cell names come from the dimension's
own INDEX, never its position in the grid, so a neighbour dropping out must not
renumber anything -- that would silently invalidate every saved `--labels-from`
reading.

**What this buys, end to end.** The 305 is the piece between the field weld at
BW12 and the bend, and the 3100 printed beside it is the whole leg from that
bend down to BW14 -- the same shape as sheet 1's 1186-less-305. So
`subtractOvershoots` now resolves BOTH ends of it:

```
N-15   UP 1723   N 4152   W 305         <- was missing its west extent
N-16   UP 5580   E 754    W 2795        <- 3100 less the 305, was unplaced
```

Every other spool envelope on the document is unchanged (18 of 20). The 305 is
also independent confirmation of an earlier hand calculation: the half elbow
worked out from the CUT PIECE LIST as (3100 - 2491)/2 = **304.5**, against a
printed **305**.

One consequence to watch. N-16 now carries lengths running BOTH WAYS on one
axis, and the axis total is a SUM (754 + 2795 = 3549) where the bounding extent
is 2795. The page splits it correctly and shows "WEST 2795, EAST 754", but
`checkSpoolFit` is handed `ewMm`, so N-16's container answer is conservative by
754mm. That is the known sum-vs-extent limitation, which needs the run topology
to resolve -- it errs toward the bigger container, which is the safe direction,
but it is not the answer.

```
pnpm --filter @easy/worker exec tsx scripts/probe-glyph-runs.ts <pdf> <page> <x0> <y0> <x1> <y1> [reachPt]
```

Free. Prints every contiguous glyph run near a dimension with how far it sits
ALONG and ACROSS that dimension's line -- which is how the table above was
measured, and the way to re-derive the threshold on a drawing this repo has
not seen rather than trusting 11.

##### TURN THE NUMBER UPRIGHT BEFORE READING IT

Every misread this pipeline has produced is a rotated digit, and always the
same kind: 4-6 came back **8000 for 6000**, 5-10 **289 for 299**, 2-2 **251 for
257**. A dimension's number reads ALONG its own dimension line, so on an
isometric most of them arrive at 30 or 150 degrees, and a 7 on its side looks
like a 1.

`ContactSheetRegion` now takes `rotateDeg`, and the dimension export passes
each label's own angle, folded to the nearest half turn (`((deg + 90) % 180) -
90` — a label at 150 reads the same way up as one at -30, and turning it by 150
would stand it on its head). The cell is turned by MINUS that about its centre,
and the grid leaves room for the diagonal so corners are not clipped.

It costs nothing and it is checkable for nothing: render `--preview` and read
the sheet yourself. On page 2 all 24 labels come out horizontal and legible,
2-2 plainly reads 257, and the other 23 agree with what was already stored.

##### WHICH SHEET ACTUALLY MOVED -- ask before paying to re-read one

```
pnpm --filter @easy/worker exec tsx scripts/probe-page-diff.ts <old.pdf> <new.pdf>
```

Free. A revision usually touches one sheet, and a sheet pass costs ~$0.63, so
knowing which sheet changed is worth knowing before spending. It hashes every
page's path coordinates, paints and line widths.

**Count the coordinates, not the objects.** Path counts, weld-flag counts and
flange-bar counts were all IDENTICAL across the revision that renumbered sheet
5's spool tags -- swapping "N-15" for "N-17" replaces one glyph with another
and every count survives. Only the hash saw it.

It earned its keep at once: sheets 1-4 came back bit-identical and sheet 5
CHANGED, so the re-extraction the revision seemed to call for turned out to
cost **nothing**. Comparing the weld positions confirmed sheet 5's welds were
untouched too, which meant the weld list, the BOM and the title block could not
have changed -- the only thing to re-read was the four tag strings, and those
come off the free tag contact sheet.

##### PASS --bores, OR THE WALK CAN ROOT AT A VENT STUB

`export-weld-geometry.ts` takes `--bores <weld-list.json>` purely for each
weld's SIZE. Leaving it off does not fail and does not warn; it just turns off
the small-bore guard in `isoRunOrder`, and a sheet whose only open end is a
vent or drain stub then roots the whole fragment at that dead end and orients
it backwards.

That is not theoretical. Page 2 of the reference ISO, built without `--bores`,
came back `orientedBy: "a drawn flow arrow"` with 5 oriented segments and
flipped N-04's hand-verified **DOWN 506 to UP 506** -- one leg, on one sheet,
in a document of twenty spools. Nothing else in the file looked wrong. It was
caught by diffing the envelopes against the previous build, which is the reason
to keep the old one.

With the bores supplied, the guard removes the stub's end, no upstream end is
left for the arrow to root at, page 2 falls back to `"the end nearest weld 1"`
and the 506 reads DOWN again.

**The worker never hits this** -- `readGeometrySpools` has the weld list in hand
and always passes the bores. Only the script can be run without it, so the
script now says so on stderr when it is. Two rules worth carrying:

- **Diff the envelopes after any geometry rebuild.** One flipped leg in twenty
  spools is invisible in a summary and obvious in a diff.
- `orientedBy` is the field that tells you which rule decided. A sheet that
  says "a drawn flow arrow" where it used to say "the end nearest weld 1" has
  had its orientation changed by something, and that something is worth finding
  before trusting the result.

##### The numbering settled: 20 blocks, 20 names, nothing spans

Worth recording because it was argued from arithmetic before the drawing
confirmed it. Blocks per sheet, all found geometrically:

| sheet | 1 | 2 | 3 | 4 | 5 | total |
|---|---|---|---|---|---|---|
| blocks (cuts + 1) | 3 | 6 | 2 | 5 | 4 | **20** |

Sheets 1-4 use N-01..N-16 -- exactly 16 names for 16 blocks, one each. So sheet
5's four blocks need four FRESH names, N-17..N-20, and **no spool spans two
sheets anywhere in this document**. The revision that followed prints exactly
that, which is the drawing agreeing with the count rather than the count being
fitted to the drawing.

The earlier reading -- sheet 5 renumbered +1, making N-16 span sheets 4 and 5 --
satisfied `spoolTagClashes` (N-16 was the last block of sheet 4 and the first of
sheet 5, which is what a genuine continuation looks like) and was still wrong.
**The clash check tests that a spanning tag is PLAUSIBLE, not that it spans.**
Counting blocks against names is the check that catches it, and it is free.

#### Will it ship? The container check

`packages/shared/src/containerFit.ts`, free to run, no API call:

```
pnpm --filter @easy/worker exec tsx scripts/check-container-fit.ts <spools.json>
pnpm --filter @easy/worker exec tsx scripts/check-container-fit.ts --size 6000x400x400 --field-welds 1
```

It takes an ENVELOPE rather than deriving one, so a hand-measured spool and an
extracted one are checked the same way. Three things a naive "is it shorter
than the container" test gets wrong, each pinned as a test:

- **A spool can be turned, angled, and TILTED.** All six orientations are
  tried, then free rotation, in three stages of rising difficulty:
  `straight`, `angled` (swung flat across the floor) and `tilted` (turned in
  all three axes). A 20ft is 5,898mm end to end, 6,350mm across the floor and
  6,786mm corner to corner, so a 6,000mm spool of small section goes in swung
  about 13 degrees and a 6,500mm one goes in tilted. Length alone decides
  nothing -- **cross-section does**, because a fatter spool sweeps a wider
  path as it turns: at 6,150mm a 219mm spool can be swung flat, a 404mm one
  has to come off the floor as well, and a 900mm one fits no attitude at all.
  The EASIEST attitude that works is the one reported.
- **Free rotation uses the OBB-to-AABB extent** (`sum_j |R_ij| * s_j`),
  searched coarse-then-fine over yaw/pitch/roll. That test is CONSERVATIVE --
  the bounding box fitting is sufficient for the spool to fit, never the
  other way round -- which is the safe direction for a shipping answer, and
  for a long thin run of pipe the two are nearly the same thing.
- **The angle reported is the one with the MOST room, not the least swing.**
  The shallowest angle that works is by definition the one touching the end
  wall -- it came out at 1mm of clearance on a 6,150mm spool, which is not a
  loading instruction. A few degrees further over turns that into 43mm.
- **Angling is a decision, not a default.** It costs usable floor and needs
  blocking against the pipe working back square, so `smallest` and
  `smallestStraight` are both reported: "a 40ft square, or a 20ft if you are
  willing to swing it" is the actual choice, and it is not the code's to
  make.
- **It has to get THROUGH THE DOOR.** The opening is smaller than the section
  behind it -- 2,340 x 2,280 against 2,352 x 2,393 on a 20ft -- so a spool can
  fit the space and still not go in end-first. That is what open-top and flat
  rack are for, and they carry `special: true` so a plain dry box always wins
  where one works: ranking on internal VOLUME alone answered "20ft open top"
  for a spool an ordinary 20ft takes, because the open top's roof rails cost
  it 46mm of height.
- **A field weld needs slack.** NOTE 4 on the reference ISO: "WHENEVER FIELD
  ADJUSTED JOINT (FAJ) IS INDICATED, AN EXCESS OF 150mm TO BE PROVIDED". That
  excess is extra pipe left on the spool, so it ships. Give `axis` if the
  joint's direction is known; otherwise it goes on the LONGEST side, which is
  the worst case and the one that decides a container.

Container internals VARY by operator and build year by a few tens of mm, which
is the same order as a tight clearance -- so a fit under `MARGINAL_MM` (50mm)
is reported as marginal, meaning "confirm against the actual container", not
"yes". Pass your own specs to override the nominal list.

**A 20ft is often quoted as 5.89 x 2.33 x 2.4m, and the list here says
5898 x 2352 x 2393. Do not "correct" it to the quoted figures.** The 2.33 is
a rule of thumb for the cross-section, not the internal width: the ISO
internal width is 2352 and the DOOR is 2340, so setting the internal width to
2330 makes the door wider than the box it opens into and breaks the
door-is-smaller-than-the-section invariant (7 tests catch this). The practical
limit the 2.33 rule is reaching for is already enforced, and more tightly --
the door is 2340 x 2280, so 2280 binds before 2330 ever does.

##### TWENTY FOOT ONLY -- and a spool that beats one is a RESULT, not a gap

`TWENTY_FOOT_CONTAINERS` is what the page and `check-container-fit.ts` check
against: a filter of `STANDARD_CONTAINERS`, not a second table, so the specs
cannot drift apart. `--all-sizes` puts the full equipment list back for a
one-off question.

This refinery does not ship anything larger, so answering "40ft HC" is not an
answer -- it hides the thing worth knowing. **Report WILL NOT SHIP and mean
it**: that names a spool which has to be cut differently or moved some other
way, and the spool rules are what decide which. A fit report that always finds
something is not a report.

On the reference ISO, 20ft only, with free turning: **19 of 20 fit**, and the
twentieth misses by 29mm.

Five need turning, and all five are 6000mm forced cuts or near it -- N-10,
N-12, N-13, N-14 swung flat, N-16 tilted. Loaded square none of them goes in,
which is the 5,898mm usable length biting on the rule that produces 6000mm
pieces. The "Allow turning and angling" checkbox keeps that a decision rather
than an assumption: angling costs floor and needs blocking.

##### THE LEGS CHAIN -- the spool's real shape is recoverable, and the box is wrong

`scripts/probe-spool-legs.ts`, free. **12 of the 20 spools chain into a single
run today**, N-02 among them:

```
N-02:  DOWN 1412 -> E 1500 -> E 1000 -> E 937 -> S 1500 -> S 881
N-10:  UP 457 -> N 721 -> E 6000
N-16:  E 754 -> UP 5580 -> W 2795
```

Every placed length carries the segment of pipe it ATTACHES to, and those
segments join end to end. So the run's ORDER comes out of the attach points
with no weld graph to solve -- the thing this file calls unsolved is unsolved
for ORDERING WELDS, not for ordering the legs an envelope is built from.

**Why it matters: the bounding box stacks legs that are at opposite ends.**
N-02 goes DOWN 1412, then EAST 3437, then SOUTH 2381 -- east is the MIDDLE
part, and the other two legs are at either END of it. They never share a
cross-section. The envelope reports 1412 x 2381 x 3437 and the fit reads that
as a solid block whose section is 1412 x 2381, which is a shape the spool does
not have anywhere along its length.

Lay the 3437 east leg along the container and the section holds ONE leg at any
station: 1412 goes in easily, and 2381 -- a single thin member -- lies on the
door diagonal (3267mm) with room. **N-02 ships.** Only the box says otherwise.

That also settles `axisExtent` properly where a run chains: the max(one
direction, other) bound is the best you can do WITHOUT the order, and with the
order the extent is exact. N-16's E 754 -> UP 5580 -> W 2795 gives an E-W
extent of 2795 either way, so the bound was tight there -- but it is a bound,
and this is the measurement.

**BUILT.** `packages/shared/src/spoolShape.ts`: `chainLegs` walks the legs into
a run and `shapeExtent` measures it; `fitsAsRun` in `containerFit.ts` fits the
RUN instead of its bounding box, given the pipe's OD. `buildSpoolEnvelopes`
emits `shape` on every envelope whose legs chain, the importer stores it, and
the page passes it to `checkSpoolFit`.

**11 of 20 chain.** The other nine fork and keep the bounding box, so the
answer for them is exactly what it was.

A rotated BOX has eight corners and its extent is `sum_j |R_ij| * s_j`; a
rotated RUN has only the corners it actually has, and the air between its legs
turns with it instead of sweeping. The test is on the convex hull of those
corners grown by one pipe diameter -- the spool lies inside that hull, so a
hull that fits means a spool that fits. Still the safe direction, just far less
slack thrown away.

With it, **every one of the 20 ships in a 20ft**:

| | as a box | as the run |
|---|---|---|
| N-02 | over by 29mm | **angled, 175mm** |
| N-10 + its field weld | over by 8mm | **tilted, 40mm** |

**Clearances also came DOWN where the box was flattering**, which is the other
half of being right: N-16 went from 319mm to 103, N-11 from 1619 to 1400. The
envelope's extents are a CENTRELINE -- they come from dimensions between weld
points -- so the box was never counting the pipe's own 219mm. The run does.

Three things worth keeping:

- **Refuse a fork, never pick an arm.** An earlier probe walked forks and
  reported N-03's two parallel 385mm branch legs as one sequential run. Taking
  either arm silently drops the other, and the dropped arm is real pipe that
  still has to go in the box. `chainLegs` returns null instead, which is why
  the count is 11 and not the 12 that looser walk claimed.
- **The bore is not the outside diameter.** The weld list prints the bore;
  what occupies a container is the OD, and at small sizes the gap is half as
  much again (15 -> 21.3). `nominalBoreOdMm` is the B36.10 table and returns
  null off it rather than guessing -- a guess here is a number that makes a
  spool look like it fits.
- **A field weld's excess is pipe on the END of the run**, so
  `withFieldWeldAllowance` carries the last leg further rather than fattening
  a box. That is what it physically is.

##### THE CROSS-SECTION DIAGONAL, and exactly what it is the limit OF

Pythagoras on a 20ft, which is the number to reach for when asking how big a
leg can be laid across the box:

| | section | diagonal |
|---|---|---|
| 20ft GP body | 2352 x 2393 | **3355mm** |
| 20ft GP **door** | 2340 x 2280 | **3267mm** |
| 20ft open top (no door) | 2352 x 2347 | **3323mm** |

**The DOOR is the limit on a dry box, not the section** -- 3267, not 3355. A
top-loaded box has no opening to pass, so its section diagonal is the whole
answer, which is 56mm MORE than a GP allows despite the open top being the
smaller space. That is the reason a 20ft open top is worth keeping on the
list.

**And the member's own thickness comes off it.** Found by bisection, not
derived -- the search is what it is:

| pipe OD | 20ft GP | 20ft open top |
|---|---|---|
| 1mm (a line) | 3266 | 3320 |
| 100mm | 3166 | 3221 |
| **219mm (8" line)** | **3047** | **3102** |
| 400mm | 2867 | 2921 |

So on this refinery's 200NB line the practical answer is about **3.0 metres**
across the section, not 3.35.

**THE DIAGONAL IS FOR A MEMBER, NOT FOR A BLOCK, and that distinction is the
whole of what is still unsolved.** A thin leg laid corner to corner uses the
full diagonal. A solid section gets NOTHING from it, because turning a
rectangle only ever grows its bounding box -- 5000 x 1 x 3200 goes in and
5000 x 1400 x 3200 does not. N-02 falls on the wrong side of exactly that
line: its 1412 x 2381 cross-section is two thin legs in reality and a solid
2381-wide block to this code, and 2381 beats a 2280 door opening.

Pinned as three tests. The search resolution was suspected first and cleared:
a 3260mm member really does not pass a 2340 x 2280 opening at any angle,
because 3267 less its own thickness is under 3260. Bisecting for the true
limit is what settled it.

##### A NEAR MISS IS NOT A NO -- report how far it missed

`NEAR_MISS_MM` (50, the same figure as `MARGINAL_MM` and for the same reason).
`FitResult.shortfallMm` carries how far the BEST attitude was over.

Without it a 6mm miss and a 3-metre miss both read "will not ship", which are
not the same answer. **N-10 carrying its 150mm field-weld allowance is
6150 x 721 x 457 and misses a 20ft by single-digit millimetres** -- an
exhaustive 0.25-degree sweep puts the true figure at 5.6mm, at yaw 15 / pitch
15 / roll 45.75, with extents 5904 x 2353 x 2399 against 5898 x 2352 x 2393.
That is 0.09% of its length, on a spec quoted to the millimetre and built to
rather less. Calling it "no" is a stronger claim than the specs support, and
it is the claim that sends someone away to re-cut a spool that goes in.

So a miss inside the threshold reports the container with a `?` and "over by
Nmm -- measure the actual box" instead of "none". Two guards keep it honest:

- **A spool that cannot pass the DOOR gets no reprieve.** Being millimetres
  from fitting the body is no comfort if it never gets inside, so the
  shortfall is only computed where the opening is not the blocker.
- **A miss by metres is not dressed up as a near miss.** Both pinned as tests.

The shipped search (3-degree sweep, then 0.25 around the best) reports 8mm
where the exhaustive sweep says 5.6 -- the right order, and honest, but do not
quote it as a measurement.

**What it is really telling you** is that the BOX is the wrong model, not that
the container is too small. N-10 is a 6000mm run of 219mm pipe with a 721mm
leg and a 457mm leg; the 721 x 457 section exists at the ENDS, not along the
length. As bare pipe the same spool swings in with 162mm to spare. The box is
mostly air, and closing that gap needs the run's topology.

**N-02 is the one that does not ship**, and it misses by very little:

```
1412 x 2381 x 3437
  20ft GP        the DOOR -- 2381 against a 2340 opening      41mm over
  20ft open top  the section -- 2381 against 2352 wide        29mm over
```

No rotation helps, and the reason is worth knowing: **turning a rectangle only
ever grows its bounding box**, so where the two larger sides both beat the
opening there is no angle that shrinks them. Its 2381 is 1500+881 SOUTH and
its 3437 is 937+1000+1500 EAST -- all one way each, so `axisExtent` has
nothing to cancel either.

It would go in as REAL PIPE. A thin L tilts out of the door plane and passes;
a solid 1412 x 2381 x 3437 block does not. That gap is the box model, not the
rotation, and closing it needs the run's topology. 41mm on a nominal opening
is also inside the range real containers vary by, so this one is worth a tape
measure before it is believed.

**Two numbers worth knowing for this refinery.** A 20ft's usable length is
5,898mm, so:

- the **6,000mm forced cut** that the spool rules produce overruns a 20ft by
  102mm, so every 6000mm piece is a 40ft job **loaded square** -- but a bare
  200NB run (219mm OD) still goes in a 20ft angled, and so does the same
  piece carrying its 150mm field-weld allowance, at 20 degrees with 43mm to
  spare. Tight enough to confirm against the actual container
- loaded square and with a field weld, the longest spool that still makes a
  20ft is **5,748mm**

**ONE ROW PER SPOOL, even where it spans sheets.** A spool does not stop being
one thing because the draughtsman ran out of paper. N-15 and N-16 each carry on
from sheet 4 onto sheet 5, and the page showed each of them TWICE -- one row
with four welds and "not read" for the size, another with five welds and the
size. A loader reading that counts two spools and ships the wrong number. The
size was never missing either: it is derived from the lengths on BOTH sheets
and stored once, so the other row simply had nothing on it.

`buildContainerSpools` merges by spool tag, summing the welds and field welds
and taking whichever row carries the envelope; the sheet reads "4 & 5 / 5".
Merged THERE and not in the extraction, where a row per sheet is the right
shape -- weld numbers restart on every sheet, so the per-sheet rows are what
keeps "weld 12 of sheet 4" apart from "weld 12 of sheet 5".

**The page.** `/containers` (`apps/web/src/app/(app)/containers/`) lists every
spool with its weld and FIELD WELD counts read from the extraction. The size
is filled in from the derived envelope, marked `derived` and shown with the
lengths that produced it, and any box can be typed over -- which drops the
badge and the workings. The
field-weld count is the input most easily forgotten and the one that decides a
borderline load, so it shows whether or not a size has been typed yet. A
checkbox switches free turning off, to answer "and what if we load it square".
`isFieldWeld` moved to `@easy/shared` for this page: two copies of "what counts
as a field weld" is exactly the split that let Type and Category be confused in
the first place.

#### The plant axes behind the drawn ones

`packages/shared/src/isoAxes.ts`. An isometric draws three axes 120 degrees
apart, and each is a real direction in the plant:

```
page 270 (straight up)  ->  UP / DOWN     -- elevation, always
the other two           ->  N / S and E / W, fixed by the NORTH ARROW
```

- **Vertical needs no arrow.** An isometric never tilts the elevation axis, so
  a dimension drawn at 90 degrees on the page is a rise or a drop and nothing
  else. A spool's HEIGHT is the one extent nameable with no reference to the
  sheet at all.
- **Bearings are reported with NORTH AS ZERO** (`plantBearing`): north 0, east
  90, south 180, west 270, measured in the plant, not on the page. Two
  drawings of the same run with different north arrows give different page
  angles and the same bearing -- which is the point of reading the arrow.
- **There is no fixed offset from north to east.** An isometric has six rays:
  two horizontal axes (30/210 and 150/330) and the vertical (90/270). Given
  north, the E-W axis is already decided -- it is the other horizontal pair --
  and exactly one of north+120 / north+240 lands on it while the other lands
  on the VERTICAL, where no horizontal run can go. Handedness only chooses
  which END of that axis is east. Getting this wrong is what a first pass at
  `directionAngles` did, and it silently put EAST straight up for half the
  possible frames.
- **Getting the arrow wrong costs naming, not answers.** A shipping envelope
  is three extents; swapping which is called N-S and which E-W leaves the set
  of three unchanged, so a container result is unaffected. Only the REPORTING
  needs the arrow right.

- **There are SIX directions, not three axes**: N, S, E, W, UP, DOWN. A
  SEGMENT has a direction, so it gets one of the six. A DIMENSION does not --
  it brackets an extent without saying which way the pipe runs -- so it only
  ever gets an axis. That is why the per-spool table groups by axis while
  the run walk works in directions.

**Fix the frame from a RUN WHOSE DIRECTION IS KNOWN, not from the arrow.**
Sheet 1's 80mm weldolet branch -- the one its 404mm dimension spans -- is
drawn at page 150 (down-left) and runs WEST. That fixes the whole frame:

```
N  210  up-left      bearing 0      E  330  up-right    bearing 90
S   30  down-right   bearing 180    W  150  down-left   bearing 270
UP 270  up           (no bearing)   DOWN 90 down        (no bearing)
```

Two wrong guesses got there, both worth not repeating:

- **`NS` is NEAR SIDE, not "north side".** It says which side of the pipe an
  olet sits on in the view; `FS` is the other one. Neither is compass
  evidence, and `WOL 200X80 NS` sits right beside the weldolet that actually
  runs WEST, so reading it as north is not a harmless slip.
- **"Down-left" reasoning cuts both ways.** Page y runs DOWN so down-left is
  150, but which drawn axis north lies on still has to come from the drawing.
  Guessing north onto the branch's own axis put N where W belongs.

The independent check that agrees: sheet 1's valve carries a
`VALVE_WRENCH SOUTH` note with its wrench drawn toward page 30, giving south
at 30 and north at 210 by a different route. **The arrow symbol itself is
still not auto-detected** -- three geometric searches returned callout
balloons, BOM boxes and the company logo. Three geometric searches failed to find it on the reference sheet --
isolated filled shapes, small boxes containing a filled shape, and large
filled triangles all returned callout balloons, BOM boxes and the company
logo. Worth another attempt before relying on the axis NAMES for a drawing
whose orientation is not known.

#### Per-spool envelopes -- derived, and now verified on one spool

```
pnpm --filter @easy/worker exec tsx scripts/export-spool-envelopes.ts     dims.json geometry.json cuts.json envelopes.json
cd packages/db && node scripts/import-spool-envelopes.mjs envelopes.json --write
```

A printed length is tied to a spool by WHERE IT ATTACHES TO THE PIPE.
`pipeAttachment` in `isoDimensions.ts` does the geometry, `placeDimension` in
`packages/shared/src/spoolEnvelope.ts` decides what it means.

**Slide the dimension back onto the run.** A dimension is drawn PARALLEL to
what it measures and offset from it, and both ends are offset by the SAME
amount along the witness direction -- that equal offset is exactly what makes
the drawn length equal the measured one. So a single distance slides the whole
dimension onto its subject, and each pipe segment parallel to it proposes one
such distance. Take the one with the most pipe under it.

**The coverage is the answer, not the offset.** A spool is what is WELDED
together; a valve is bolted in between two flanges and ships on its own, so a
dimension spanning one brackets no pipe at all. That is what separates a
length that belongs to a spool from one that does not, and on this document
the separation is absolute:

| | coverage |
|---|---|
| every length drawn over a run | **46% -- 100%** |
| every length spanning a bolted-in valve | **exactly 0%** |
| in between | nothing |

All eight of the 464mm valve assemblies are rejected, on four different
sheets, and so are the five 210mm ones. Anything from 5% to 40% gives the same
answer, so `MIN_PIPE_COVERAGE = 0.2` is reading a gap in the drawing rather
than being fitted to it. Three of the rejects were checked by rendering them:
sheet 5's 502mm spans a wafer check valve between two flanges, sheet 3's 659mm
spans a valve and ends on a DASHED tie-in with a break symbol, and sheet 1's
210mm spans the branch's own valve below BW1. All three are right to drop.

**NO PIPE UNDER THE SPAN IS NOT ALWAYS A VALVE.** The coverage test exists
because a valve is bolted in between two flanges and ships on its own, so a
length across one belongs to no spool — and the eight 464mm valve assemblies
it rejects are all correct. But a **REDUCING TEE or a reducer interrupts the
drawn line just as completely and is a FABRICATION item**: welded in, shipped
with the spool. Both read 0% coverage, so coverage cannot tell them apart, and
N-06 came out 653 when the drawing says 894.

The BORE does tell them apart, because a reducer is where the line changes
size. Sheet 2 carries both cases 30pt from each other:

| | spans welds | bores | |
|---|---|---|---|
| 2-11 = 241mm | 14 and 15 | 200 and **150** | the reducing tee — **keep it** |
| 2-9 = 273mm | 15 and 16 | 150 and 150 | the gate valve — drop it |

So a length with nil coverage is still refused UNLESS its two flanking welds
differ in bore. The bore is the one thing geometry cannot supply — it comes
off the WELD LIST — so it now travels with the assignment through
`spool-cuts.ts`, and where it is absent the old answer stands rather than
every valve assembly being let in.

Tried first and not sharp enough: testing whether a BOLTED JOINT (a flange
pair, the same detector the cut finder uses) lies within the span. It gets the
valves right, but the nearest joint is 29pt from the reducing tee and 21pt
from a length that must stay out — too close to separate.

Two details the second case forced, N-07 (751 where the drawing says 840):

- **Judge the bore on the welds along the SPAN'S OWN LINE, not on the two its
  ends matched.** A short piece across a reducer can have both ends nearest the
  SAME weld — sheet 2's 89mm measures 14.6pt on the page and both its ends
  resolve to weld 16, while the size change is between weld 16 at 150 and weld
  17 at 200, the pair straddling it.
- **Those welds must be AT the span.** `REDUCER_WELD_PT` is 60. The 89's pair
  sits 3 and 36pt away; sheet 1's 108mm, which must stay out, has its nearest
  weld 107pt off and the next 135 — welds elsewhere on the run whose differing
  bores would otherwise fake a size change, and letting them count put 108mm
  into N-03.

**And the 89 was not being DETECTED at all.** `MIN_DIMENSION_PT` was 20; the 89
spans 14.6pt apex to apex, its arrows drawn OUTSIDE because the extent will not
fit them within — the same shape as sheet 1's 305, just smaller. Swept on both
revisions: 20, 16 and 14 give the same count except that 14 admits this one; 12
admits one more, a 12.1pt span on page 1 with no pipe under it; below 10
nothing further appears. **14 takes the length the drawing prints and nothing
else.** An earlier sweep tried 14 and recorded "one extra dimension, on sheet
2, not the 305" as if it were noise — it was this 89.

Adding a dimension RENUMBERS every cell and invalidates the read labels, so
carry them across by each span's MIDPOINT and angle (all 79 carried; only the
new cell needed eyes).

**Then both ends must agree on a spool.** Where they name different ones the
length crosses a boundary and belongs wholly to neither -- except when the two
welds are CONSECUTIVE, which puts them either side of the cut itself, and the
pipe between them is the first piece of the later spool (a field weld closes
the spool it ends). That is sheet 4's 6000mm piece between its two FW ticks.
Sheet 4's 15109mm overall and sheet 3's 6761mm span further than one spool and
are reported, not placed.

**One firm end is enough when the other reaches no weld at all.** An end can
legitimately land on something that is not a weld: the start of a run, an
elbow, a tie-in continuing onto another sheet, or a weld whose leader could
not be traced. Sheet 1 has two of those last, and one of them is what its
202mm from weld 5 lands on -- without this rule N-01 comes out 386 instead of
588. The match must be within 30pt when it is deciding alone, and the other
end must reach NO weld: an end reaching a DIFFERENT spool is a crossing.

**Verified against the drawing.** N-01 of the reference ISO is **588mm down
and 404mm west** (hand-checked), and that is what comes out:

```
N-01   DOWN  1-2 202   1-4 202   1-8 184     = 588
       W     1-3 404                         = 404
       rejected: 1-1 464, 1-6 464 (valve assemblies), 1-11 210 (its own valve)
```

Reading the branch settles why each rejection is right: the weldolet taps the
main run at BW4, runs west 404 to the elbow at BW2, then drops 184 to BW1
where it welds to a flange -- and the 210 spans the VALVE bolted below that
flange, which ships separately. The other seventeen envelopes are unverified.

**An earlier note in this file said N-01 was "404 up and 404 west". It is
588 down.** The 404 was the main run's drop alone; it missed the branch's own
184mm fall below the takeoff.

**Match the weld GENEROUSLY; the guard is that both ends agree.** The radius
is 150pt, not something tight. Weld tracing leaves real holes -- sheet 1's
welds 5 and 9 both have untraced leaders -- and a tight radius turns every
hole into a dropped length: its 1000mm run sits between welds 8 and 10 with
weld 9 missing, about 100pt from either, and a 60pt radius lost it. What
actually protects the answer is the two ends naming the same spool, not how
near the nearest weld happens to be.

**A printed length can measure more pipe than the spool owns.** Sheet 1's
1186 runs from the elbow PAST the field weld at weld 12, and the sheet prints
the 305mm overshoot as its OWN dimension, labelled FW. The spool ends at the
field weld, so its share is 881, and N-02's south extent is 1500 + 881 =
2381, not 2686.

**That 305 cannot be worked out by scaling — it has to be read.** It spans
21pt for 305mm while the 1186 beside it on the SAME run spans 108pt: 14.3
against 11.0 mm/pt. The page is not linear even along one piece of pipe,
which is the "never measure off the page" rule biting at the smallest scale.

##### Why it was missed, and the fix: MEASURE APEX TO APEX

The reader missed it for a reason worth keeping, because it was wrong about
something general. **An arrowhead can point either way, and the drawn line
is not the span.**

```
INWARD   sheet 1's 184: base at 373.5, apex at 380.6 -- the apex IS the
         line's end, so line length == span
OUTWARD  sheet 1's 305: a 10.1pt line between apexes 24.3pt apart, the
         arrows sitting beyond each end pointing out at the witnesses
```

CAD draws them outward when the extent is too small to fit the arrows
inside. The line branch measured the SEGMENT, so the 305 came out 10.1pt,
under `MIN_DIMENSION_PT`, and was thrown away. Taking `ha.apex`/`hb.apex`
covers both shapes at once, because for an inward arrow the apex and the
line's end are the same point. In every case the apex lands exactly on the
witness line -- that is what makes it the measured point.

One guard is needed with it. An arrowhead can be matched to an end it does
not belong to, and the apexes then drag the span off the drawing axis; that
showed up immediately as dimensions reported at 21 and 41 degrees. So the
apex span is used only where it stays on-axis and within `APEX_DRIFT_DEG`
of the drawn line, and otherwise the drawn line wins.

Result: **83 -> 85 dimensions**, no off-axis ones, and the 305 detected as a
24.3pt span at 30 degrees from (760.7,443.6) to (781.8,455.7), both apexes
on their witness lines. Its attach then ends at (781.8,498.0) -- the SAME
point the 1186's attach ends at -- which is the geometry confirming it is
exactly the 1186's tail.

Ruled out along the way, do not spend on these again:

| tried | result |
|---|---|
| `MIN_HALF_PT` 4 -> 2.5 | no change at all |
| `MIN_DIMENSION_PT` 20 -> 14 | one extra dimension, on sheet 2, not the 305 |
| both together | still nothing, and no rejection RECORDED -- the halves never form |
| a terminator rule for slender filled triangles | **175 candidate pairs**, nearly all title-block glyphs |

The two big filled triangles beside the 305 look like a terminator pair and
are not: they share the edge (761.1,441.5)-(781.4,442.1) exactly with apexes
on OPPOSITE sides, so together they are a filled parallelogram 17.9 x 9.6,
not two arrows.

**Renumbering.** Adding dimensions renumbers every `cell` and invalidates
the read labels. Carry them across by matching each span's MIDPOINT and
angle rather than its endpoints -- the endpoints move when a span grows by
an arrowhead at each end, the midpoint does not. That carried 80 of 85
automatically; of the five left, three had never been read anyway, so only
two needed eyes.

##### And then SUBTRACT it

Detecting the 305 is not enough on its own: added, it inflates the spool;
dropped as "contained", it leaves the 1186 overstating it. The spool's share
is the DIFFERENCE, and `subtractOvershoots` takes it.

A tail is told from an ordinary nested part by two things: the length it sits
in is FLAGGED as overshooting its spool's boundary weld, and it SHARES AN END
with that length. An overall dimension's parts sit in the middle and share no
end, so `outermost` still drops those (sheet 4's 15109 over its 6000).

**Containment has to be judged on the PIPE, not on the drawn lines.** This is
what made the rule miss at first. A dimension is drawn at whatever offset
suits the sheet, and two at different offsets project onto the axis at
different places even when one brackets the other -- sheet 1's 305 sits
inside the 1186 on the run and OUTSIDE it on paper. So the held span is the
ATTACH, and both ends of the 305 and the 1186 then coincide at (781.8,498).

With that, both hand-verified spools come out of the drawing alone, no
corrections:

```
N-01   DOWN 202+202+184 = 588      WEST 404
N-02   DOWN 1412   SOUTH 1500+881 = 2381   EAST 937+1000+1500 = 3437
```

where the 881 is the printed 1186 less the printed 305, and the part keeps
`printedMm: 1186` with the reason, so the page shows "881 (of 1186 printed)".

**The rule that catches this class, without needing the 305 read.** A spool
ends at its boundary weld; a dimension does not have to. So project the
spool's own boundary weld onto the length's line, and if it lands strictly
INSIDE the span, the pipe beyond it belongs to the next spool and the total
is an over-estimate. Positional, so it needs no scale.

What separates a real overshoot from nothing is measured, not guessed. A
dimension normally ends at the FITTING -- the flange face, the pipe end --
not at the weld dot a few points inside it, so a small run-past is ordinary.
Across the reference ISO the two groups do not overlap:

```
ordinary:  6.8  7.0  7.1  7.2  8.9  10.2  10.2  10.5  11.9  11.9  11.9
real:                          18.2  18.2  19.1  20.0  20.7  21.3
```

N-01's verified 588 pins the bottom of that -- its 202 runs 7pt past weld 6
and must NOT be docked -- and the 1186 that genuinely runs past the field
weld is 20. `MIN_OVERSHOOT_PT` is 15, in the gap. Six lengths are flagged
across the document; N-02's is the one confirmed against the drawing, the
other five are unchecked and the page marks them.

The flag is a REVIEW PROMPT, not a correction: it says "this runs past the
weld that ends the spool, go and read the overshoot the sheet prints". It
would have caught the 1186 before a human did, which is the whole point.

Until the reader finds the 305 itself, `--corrections` carries the number,
and REQUIRES a reason:

```
pnpm --filter @easy/worker exec tsx scripts/export-spool-envelopes.ts     dims.json geometry.json cuts.json envelopes.json --corrections fix-lengths.json
```

```json
{ "1-7": { "mm": 881, "why": "the printed 1186 runs past the field weld at weld 12; the sheet prints the 305mm overshoot separately" } }
```

The part keeps `printedMm`, and the page shows "881 (of 1186 printed)" with
the reason on hover. A figure that silently disagrees with the drawing is
unreviewable, which is the whole point of the workings.

**A length reports EVERY weld it reaches, not just the one it is keyed by.**
`placeDimension` returns `weldNos`, one per end. Keying by a single weld hid
the thing the container check most needs: a length ending AT its spool's
closing weld is keyed by the weld at its OTHER end, so N-02's 881 named weld 11
while the field weld it runs to is 12. `fieldWeldSide` then matched nothing and
fell through to the longest side, putting the 150mm on the 3437mm east leg
instead of the N-S one carrying the weld — the exact error the rule below
exists to prevent, defeated by the key rather than by the rule.

**A boundary-crossing length still has a share, where the sheet prints the part
beyond it.** `subtractOvershoots` already handles a length that stays in one
spool and merely runs past its closing weld (sheet 1's 1186 less its 305). The
same thing happens with the length reaching properly into the NEXT spool: both
ends then name different spools and the whole thing is refused. Sheet 3's 6761
runs from inside N-10 up to the apex in N-11, the sheet prints that last stretch
as its own 761, and **6000mm of N-10 — the forced-cut length — went
unreported**. The tail is recognised as it is there: a shorter length on the
same line, inside this one, sharing an end.

Two guards, both learned by breaking something:

- **The tail and what remains must be NEIGHBOURS.** Removing one printed tail
  can only resolve a length crossing ONE boundary. Sheet 4's 15109 runs N-12
  through N-15; taking its 3100 off left 12009 still spanning three, and it
  landed in N-12 as a 12-metre extent.
- Checking instead that the remainder's interior welds are all one spool's is
  NOT enough — that remainder had no weld inside it at all, so the test passed
  on no evidence.

**Put the field weld's 150mm on the axis the field weld is ON.** The check
falls back to the longest side when the direction is unknown, and that is the
WORST CASE rather than the answer — it is deliberately conservative about
which container, but it puts the slack in the wrong place. N-02's field weld
is on its N-S leg, not its 3437mm east one:

| 150mm placed on | ships as | result |
|---|---|---|
| the N-S leg, where the FW is | 1412 x **2531** x 3437 | 40ft HC, **54mm** clearance |
| the longest side | 1412 x 2381 x 3587 | 40ft HC, 204mm — too optimistic |

The page works the axis out itself: the envelope part whose `weldNo` is a
field weld names it. This is what `axis` on `checkSpoolFit` was always for.

**Nothing is guessed, and nothing is silently dropped.** A length that reaches
no weld, spans a bolted joint, or crosses more than one spool comes back in
`unplaced` with the reason, is stored on the sheet's spool rows, and is shown
on the page under "on this sheet, in no spool". A length a reviewer can see
printed but cannot find in the workings is worse than a wrong total.

**Containment is still applied.** A sheet prints both the whole and its parts,
so `outermost` drops any span nested inside a longer one on the same axis.

**The page names each extent by its DIRECTION, and shows only the axes that
have one.** "DOWN 588, WEST 404", not "588 x 0 x 404" under a fixed
UP-DOWN x N-S x E-W heading: a spool occupies at most three axes and usually
fewer, so the fixed triple spends most of its width on zeroes and still
leaves the reader working out which way round it is. Where an axis holds
lengths running BOTH ways it is named by the axis instead, since neither
direction is then the honest answer.

##### Which way a leg runs comes from the PIPE, and the flow arrow is what says so

**A DIMENSION HAS NO DIRECTION.** It brackets an extent. The two endpoints CAD
writes for it are in whatever order the exporter emitted, and `drawnAs` used to
be `plantDirection(pageAngleOf(d.from, d.to))` — reading a direction out of that
order, which is reading noise. This file said a dimension "only ever gets an
axis" while the code was doing the opposite.

It looks harmless until it isn't. N-03's five vertical legs came back **UP, UP,
DOWN, UP, UP** and its height was labelled "UP-DOWN 1498" — one run of pipe,
dropping the whole way, described as doing both. The user spotted it: *"N-03
suppose to be down only, no up."*

The fix is the flow arrow, through two steps:

- `isoRunOrder` emits **`orientedSegments`** — every run segment pointed the way
  the pipe travels. NOT taken from the weld walk, which has to tell branch from
  main run and is only right on one sheet. Flow enters at one end and travels
  outward, so orienting every edge AWAY FROM THE START is the whole answer: a
  breadth-first sweep from the start node the arrow fixes, indifferent to weld
  adjacency, branch classification and numbering alike.
- `buildSpoolEnvelopes` takes those segments and names each leg from the pipe
  under it — nearest segment ON THE DIMENSION'S OWN AXIS, within
  `RUN_DIRECTION_PT`. A dimension is drawn parallel to what it measures, so a
  segment on another axis is a different leg and must not name it.

Result on the revised reference ISO: **every axis of every spool now resolves to
a single direction**, no "UP-DOWN" or "E-W" labels left. N-01 (588 DOWN / 404 W)
and N-02 are unchanged and still match the hand-verified answer.

Two legs FLIPPED, and both were wrong before — the old value was noise, so a
change is not a regression:

- **N-10 is UP 457**, verified against the drawing: BW1 sits at the BOTTOM of
  that leg with its valve below it, and the run ascends BW1 → BW2 → … → BW11
  before dropping 444 into "CONT. ON …N-2". An inverted U, up one end and down
  the other, which is why the sheet needs both.
- **N-13 is UP 6000** on sheet 4, whose flow arrow points straight up.

**A spool's legs do NOT all run the same way.** N-03 drops 2376 down its main
leg and RISES 385 up each of two 15mm weldolet branches.

**EVERY SHEET CARRIES A FLOW ARROW, and where one is found the drawing wins.**
`buildSpoolEnvelopes` takes the run segments a flow arrow orients and names a
leg from the pipe under it; only where no arrow evidences the fragment does the
drawn endpoint order stand. Two things had to be right before that was safe:

- **Orient ONLY an arrow-rooted fragment.** The run graph comes from the
  heaviest line weight and leaves a sheet in disconnected pieces; rooting an
  arrow-less piece at its topmost open end is a guess, and measured against the
  drawn order it reversed every horizontal on two sheets (48 agreed, 24
  differed, all in whole components).
- **Do not root at a small-bore stub** (`boreOf`, above). Page 2's walk started
  at weld 6, a 15mm THREADED weld at the bottom of a vent branch ending in a
  closed valve, and read that branch's 506mm drop as a RISE.

With both, N-10's 457 reads UP -- BW1 sits at the bottom of that leg with its
valve below and the run ascends -- while N-04's 506 vent branch still reads
DOWN, which the two rules could not do separately.

**The outline does NOT sit exactly on the fill.** `OUTLINE_PT` was 3 and sheet
5's arrow missed by a tenth of a point: the outline is a four-point path whose
corners are not the triangle's, so its bbox centre drifts, 3.1pt there.
Measured THROUGH THE MODULE on both revisions -- not through the probe, which
carries its own copy of the rules and hid this for several sweeps -- 3 finds 4
of the 5 arrows while 4, 5, 6 and 8 all find 5 of 5 with none on the drawing
that has none. 5 sits mid-plateau.

Sheet 5's arrow then **OVERRULED the weld numbering**, the only sheet where the
two disagree -- which is the whole reason for preferring the drawing.

**And the direction is the DRAWN ENDPOINT ORDER after all.** Two attempts to
replace it were both reverted, and the measurement is worth keeping so nobody
spends a third time on it. The override read each leg's direction off the pipe
underneath, orienting the run graph outward from the end a flow arrow points
away from. Scored against the drawn order across both drawings: **48 legs
agreed, 24 differed** — and the differences were not scattered. They came in
whole components: every horizontal on page 2, every one on page 5, both branch
legs on page 1. That is the signature of a FRAGMENT ROOTED BACKWARDS, not of a
bad endpoint order. The run graph is built from the heaviest line weight, which
leaves a sheet in several disconnected pieces, and a piece holding no flow
arrow has nothing to root it but a guess at which end comes first.

Every case checkable against the drawing went to the drawn order: page 1's two
weldolet branches rise 385 each, page 2's run goes EAST and its vent branch
drops 506, and the hand-verified N-01 and N-02 are unchanged by it. So the
drawn order stands and the flow arrow is kept for what it is reliably good at —
orienting the weld walk in `isoRunOrder`.

Also tried and reverted, in the same attempt: orienting EVERY disconnected
component (rooting the arrow-less ones at their topmost open end) and using
weld BORE to stop the walk rooting at a small-bore branch stub. The first is
what produced the 24 wrong legs. The second is sound in principle — a 15mm vent
cannot be a 200mm line's inlet, and page 2's walk does start at the dead end of
one — but it only moves the walk's start, which the envelopes no longer depend
on. **Do not re-attempt the override without fixing component rooting first;
the 48/24 comparison is the test it has to pass.**

##### Three more things N-03 caught, all of them costing real millimetres

The user's answer — **DOWN 2882, UP 770, E 2216** — did not match, and the gap
was not one bug but three. Worth reading together, because each is a different
way of confusing "the same axis" with "the same piece of pipe".

**1. A dimension slid 141pt onto a pipe it does not measure.** `pipeAttachment`
takes the offset with the MOST pipe under it, and a 15mm branch leg is short
and thin while the 200mm main run beside it is long, heavy and parallel. Both
385mm branch rises, and both 111mm lengths above the branches' own valves, slid
131-141pt onto the main run and came back 86-95% "covered" by another leg's
pipe. That cost the direction (the main run drops where the branches rise) AND
let the 111s in, when what they actually span is a bolted-in valve.

The fix is a REACH CAP, measured and identical on both revisions of the drawing:
offsets actually used cluster hard at 42-43pt (the first dimension chain), with
further chains at 59, 71, 81 and 85, and then NOTHING until 118.
`MAX_WITNESS_REACH_PT` was 200, which let all of it through; **100 sits in the
measured gap**. With it the 385s attach to their own branches and read UP, and
the 111s find no pipe at any reachable offset and are correctly dropped.

Tried and reverted: choosing the NEAREST offset rather than the best-covered
one. It fixes this case but breaks the general one — a pipe 40pt away covering
20% of the span should lose to one 100pt away covering all of it. The cap is
enough on its own.

**2. Two parallel legs, and one swallowed the other.** `outermost` projects a
span onto its own direction, so two legs running the same way at different
places on the sheet collapse onto the same interval and the shorter looks
nested in the longer. N-03's 506mm drop (attaching at x=1007) vanished inside
its 2376mm drop (at x=782). Containment now needs ONE LINE, not one axis —
`SAME_LINE_PT` is 10pt, and it is safe to be that tight because containment is
judged on the ATTACH: sheet 4's 15109 overall and both its parts attach at
*exactly* x=695.5, being all on the one piece of pipe.

**3. A length was refused for crossing a boundary it does not cross.** The
2376mm drop runs from the elbow at the top of the leg down to weld 14. Its
upper end lands 27pt from weld 12 — the field weld closing N-02, sitting on the
horizontal leg above the corner — and 41pt from weld 13, so the two ends read
N-02 and N-03 and the whole 2376 went unreported.

A dimension ends at the FITTING, not at the weld dot a few points inside it, so
an end can brush the last weld of the previous spool. What it MEASURES is the
pipe between its ends, so **the welds INSIDE the span are what say whose that
is**; where they all belong to one spool, that is the answer whatever the ends
touch. The old "two CONSECUTIVE welds" exception is the case where nothing is
inside, and is kept for it (sheet 4's 6000mm piece between its two FW ticks).

**And the page reports both directions, not the axis.** An axis carrying
lengths both ways is split: "DOWN 2882, UP 770", never "UP-DOWN 3652", which is
a number describing nothing — neither the drop, nor the rise, nor the height of
anything.

**There is nothing to type on that page.** The sizes are read off the
drawing; the job is to VERIFY them, which is what the per-direction lengths
under each one are for.

**It is stored carrying `parts`.** Each part keeps its `cell` and the
direction it is DRAWN in, and the page lists them ONE BY ONE under all six
directions -- never rolled into a sum:

```
N-01   UP   0  -           N-02   UP   0  -
       DOWN 3  1-2 202            DOWN 1  1-12 1412
               1-4 202            N    0  -
               1-8 184            S    2  1-5 1500   1-7 1186
       N 0  S 0  E 0              E    2  1-15 937   1-22 1500
       W    1  1-3 404            W    0  -

sheet 1 -- printed, in no spool:
  1-1 464 (no pipe)    1-6 464 (no pipe)    1-9 18 (no pipe)
  1-10 18 (no pipe)    1-11 210 (no pipe)   1-24 108 (no pipe)
  1-26 15 (no pipe)    1-18 1000 (no weld)
```

The unplaced list is shown once per SHEET, not once per spool: every spool on
a sheet carries the same list, and repeating it on each row buries it.

Three deliberate choices there, each one someone asked for after the version
before it could not be checked:

- **Six directions, not three axes.** At axis level N-02's stray 404 was
  just another number in the E-W pile; on its own under W it was obviously
  N-01's branch. That is how this bug was found.
- **Never summed.** A total is a number to agree with; a list is something to
  go through.
- **All six shown, empty ones included.** An empty direction is evidence:
  N-01 having nothing sideways is how its missing branch announced itself.

The `cell` is what makes it checkable -- it names the box on the dimension
contact sheet the length was read from.

**There is no `derived` flag and no badge.** One was carried for a while,
meaning "nobody has confirmed this", and nothing ever read it except the badge
that displayed it -- so it marked every row forever and said the same thing
about a spool checked against the drawing as about one nobody had looked at.
The workings ARE the confirmation mechanism: a length with its cell can be
checked, a badge cannot. Removed from the page, the exporter, the importer and
the stored attributes.

Removed with it: the "(of N printed)" note on a corrected length and the
"past weld N" overshoot warning. Both were review prompts on a figure the
reviewer has since been through by hand.

**AN AXIS TOTAL IS max(one direction, the other) -- NOT the sum.** This was
a sum, and the sum is wrong whenever a run doubles back: 754 EAST then 2795
WEST does not reach 3549, it covers ground twice.

`axisExtent` in `spoolEnvelope.ts`. **The bound is tight without knowing the
order the legs run in**, which is what makes it usable while the topology is
unsolved. The proof is short enough to keep: walking the run gives a position
after each leg, and the extent is the highest position reached minus the
lowest. Getting from the highest to the lowest travels only in the negative
direction, so that drop is at most the sum of the negative legs; if the lowest
comes first, the same argument bounds it by the sum of the positive legs. So
the extent never exceeds the LARGER of the two sums -- and it is reached, by
the order taking every positive leg before every negative one.

It is still an upper bound on a real run, since alternating legs cancel
further than the grouped order does. Safe direction for shipping, and the page
lists the legs so it can be argued with.

Two figures moved, both toward the drawing:

| | summed | extent | |
|---|---|---|---|
| N-03 up-down | 3652 | **2882** | the user's verified DOWN 2882 / UP 770 |
| N-16 E-W | 3549 | **2795** | E 754 + W 2795 |

N-03 landing exactly on a hand-verified number it was never fitted to is the
evidence this is right and not just smaller.

Free probes, all geometry-only, for working on this:

```
pnpm --filter @easy/worker exec tsx scripts/probe-dim-pipe.ts   <pdf> <page> dims.json geometry.json cuts.json
pnpm --filter @easy/worker exec tsx scripts/probe-witness.ts    <pdf> <page> <x> <y> [radius]
pnpm --filter @easy/worker exec tsx scripts/probe-box.ts        <pdf> <page> <x0> <y0> <x1> <y1> [minLen]
pnpm --filter @easy/worker exec tsx scripts/probe-lw.ts         <pdf> <page> [minLw]
pnpm --filter @easy/worker exec tsx scripts/dump-region.ts      <pdf> <page> <x0> <y0> <x1> <y1> <out.png>
```

**`readPageGeometry` returns y-DOWN despite what its comment says.** Larger y
is lower on the page, which is what `pageAngleOf` and the whole dimension
reader assume. A probe that flips y lands in the title block and finds table
rules where it expected witness lines -- an hour went into that.

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

## Pipe supports — the span check

`/supports` (`apps/web/src/app/(app)/supports/`), its own tab beside Spooling.
It reads the ISO extraction and nothing else, which is the point: support
adequacy is answered off ONE drawing.

**It used to be "gate 6" of the cross-document ISO compile, and has been moved
out.** What lived there was two string tests — does a support BOM row name a
type designation, and does that designation appear on the GA. Neither is the
question anyone has about supports. The question is **whether the pipe is held
up often enough**, and nothing about answering it needs a P&ID, a line list or
a GA, so it should not sit behind a compile that stops when one is missing.

### DO NOT TRY TO RECOGNISE A SUPPORT SYMBOL

`apps/worker/src/extraction/isoPipeSupports.ts`. Same lesson the cut finder
learned about valves: a support symbol is whatever the CAD library contained —
a shoe, a clamp, a guide and a rest are all drawn differently, and the
reference ISO draws **both** its types as a bare short bar across the pipe with
nothing to tell them apart.

What is always the same is that a support is a **BOM item**, so it carries a
square item balloon on a leader like everything else on the sheet — and the BOM
already says which item numbers are supports. So the job is not "find a
support", it is "find the balloons and keep the ones the BOM calls supports".
Recognition replaced by a lookup against a table that was already read.

Three numbered shapes on this drawing, and they are disjoint:

| shape | what it is | module |
|---|---|---|
| **SQUARE** box | a BOM item balloon | `isoPipeSupports.ts` |
| HEXAGON flag | a weld number (BW7, FW12) | `isoWeldMarks.ts` |
| wide ROUNDED box | a spool tag | `isoSpoolTags.ts` |

**A box with no leader is a table cell.** The BOM table puts several hundred
boxes of almost exactly balloon size on page 1. Requiring a leader that lands
on the run is what separates them, which is why the size bounds are loose and
must stay loose — a three-digit item number widens the box.

**Measured on the reference ISO, page 1: 23 balloons, 5 of them supports —
exactly the BOM's 3 × item 18 and 2 × item 19.** `supportCountCheck` makes that
a real check, not a formality: the BOM is a table and its quantities are the
number to trust, so a detector that found four of five has not finished.

### THE SPAN IS A SUM OF PRINTED LENGTHS, NEVER A PAGE MEASUREMENT

An isometric is not to scale — this repo has one run at 14.3 mm/pt and another
at 11.0 on the same sheet. Page geometry is good for exactly one thing here:
saying WHICH printed lengths lie between two supports.

**What makes that work is that the draughtsman breaks the dimension chain AT
each support.** Page 1's east run reads elbow → 1500 → support → 1000 →
support → 937 → corner, so every span is a whole number of printed legs and
nothing is interpolated. `supportSpans` chains the dimension attach segments
(the same end-to-end join `chainLegs` uses, 6pt), places each support on a
node, and sums the legs between consecutive ones:

```
1-8  -> 1-10   1000mm   printed 1-19           0 turns -> straight run
1-10 -> 1-13   2437mm   printed 1-17 + 1-5     1 turn  -> L or V
```

- **A support 12pt or more from any node sits MID-LEG and gets no span.**
  Apportioning the leg by page distance would be measuring off the drawing
  again. Measured: the three real supports land 3.6, 5.8 and 6.7pt from their
  node, because the leader stops at the support bar rather than the centreline,
  and the next node is never nearer than ~90pt.
- **A leg whose label was never read leaves the span null, not short.**
- **A PRIMARY and the SECONDARY installed on it are ONE support point.** They
  land on the same node; two points there reports a zero-length span between a
  support and the one bolted on top of it.
- Forks are refused rather than walked, for the reason `chainLegs` refuses
  them: the dropped arm is real pipe carrying real weight.

### READ THE SUPPORTS THROUGH FIRST, THEN DO THE SPAN

`supportSpansWhenComplete` is the gate, and the order is not housekeeping.
A span is the gap between two CONSECUTIVE supports, and *consecutive* is only
knowable once they have all been found. Miss one and the two either side pair
with each other:

```
found  18-1 ...... 18-2 ...... 18-3     spans 1000, 2437   correct
missed 18-1 ................. 18-3      span 3437          invented
```

Both failures follow, and they point opposite ways. The invented gap can
exceed the standard and send someone to add a support that is already there;
and where the missed one was at the END of a run, the last real span is never
reported at all, so an over-long gap passes in silence. A check that can fail
in both directions on the same input is not a check.

**The BOM's quantity is the gate**, because it is a TABLE: read once, not
dependent on finding a symbol, and the only thing on the sheet that knows how
many supports there are meant to be. Where the count does not match, NO span
is computed and the reason is stored in `spans_withheld` and shown on the
page. Same rule the spool cut finder follows when its cut count disagrees with
the printed spool count — leave the sheet alone, never guess at it.

Verified both ways on the reference ISO: with all five balloons read the
spans come out 1000 and 2437; blank one label and the sheet reports *"the BOM
calls for 5 supports and 4 were located (item 18: 2 of 3)"* and no spans at
all, where the ungated version had happily produced 3437.

**Withheld is not the same as none**, and the page must not render them alike
— a silently empty span column reads as "nothing wrong here".

### THE RUN HAS TWO ENDS

Reporting only the gaps BETWEEN supports passes a sheet in silence while the
pipe hangs off either end of it. `supportSpans` emits those stretches too,
as `kind: "run-end"`.

On the reference ISO that is the difference between "both spans fine" and the
actual picture: **2912mm of pipe before the first support, 1412 of it
vertical.** Judged as a hanging drop the sheet caps that leg at 1100, so it
flags 312mm over; judged as a riser supported at its base (3400) it is fine,
and the drawing does not say which.

**A run-end is REPORTED, not failed.** The end of a dimension chain can be an
anchor, an equipment nozzle, a dead end, or the point where the line carries
on to the next sheet, and what holds it there is usually not on this drawing.
The length and the verdict are given; the reader decides.

### SUPPORTS ON SHEET 1 ONLY -- and that is the finding

Measured on the reference ISO, two independent ways: the BOM lists supports
on sheet 1 alone, and the geometry finds no support balloon among the 37 on
sheets 2-5.

| sheet | pipe | supports |
|---|---|---|
| 1 | 9.8 m of 8" | 3 primary + 2 secondary |
| 2 | 4.1 m of 8" | **none** |
| 3 | 7.1 m of 6" | **none** |
| 4 | **30.8 m of 8"** | **none** |
| 5 | 2.7 m of 8" | **none** |

At the 7200mm straight-run limit sheet 4 alone needs at least four
intermediate supports. Worth knowing before reading a clean span report as a
clean drawing: **every span on this document passes, and 45 metres of its
pipe has nothing under it.** A rack run is often held by structure drawn on a
separate support drawing rather than ballooned on the ISO, so this is a "go
and check", not a defect -- but on the ISO's own terms the pipe is unheld.

Sheet 3 is 6" and no 6" span sheet has been supplied, so it would return "no
standard" rather than a guess even if it had supports.

### A SPAN IS NOT ONE FIGURE PER SIZE

`packages/shared/src/pipeSpan.ts`. Four things decide it, and the fourth is the
one that gets dropped: SIZE (heavier wins over stiffer), MATERIAL (stainless
sags further), AREA (process is shorter than a rack), and **SHAPE**.

The project's span sheet draws the same 8" pipe six ways:

| case | max span |
|---|---|
| straight run | 7200 |
| turning through one elbow (L) | **7700** |
| turning down and back up through a low elbow (V) | 6400 |
| carrying a branch tee | 6000 |
| vertical leg supported at its base (leg ≤ 3400) | 7200 |
| hanging an unsupported drop leg (leg ≤ 1100) | 5500 |

**The L turn carries FURTHER than the straight run.** It reads like a
transcription error and it is what the sheet draws — pinned as a test, because
"correcting" 7700 to 7200 overrides the standard with an assumption.

**THE SHORTEST APPLICABLE CASE GOVERNS.** A real span is several cases at once,
and taking any but the smallest permits a span the sheet does not. `checkSpan`
names the cases it beat so the choice is checkable.

**The two "Max" cases are a READING of the drawing, not a quotation.** The only
reading under which a *shorter* permitted leg goes with a *shorter* permitted
span is that they are different cases: the 3400 riser has its own support at
the base so the horizontal keeps 7200; the 1100 drop hangs off the horizontal
with nothing under it, so its weight lands on that span and it falls to 5500.
Confirm it against the sheet.

**The vertical leg is checked SEPARATELY from the span it hangs off** — two
different corrections, and one combined figure sends a designer to fix the
wrong thing.

**Only the supplied sheet is in the table.** 8" NPS Sch-20 carbon steel,
process area; everything else returns "no standard" with the missing input
named, the rule `nominalBoreOdMm` follows. A guessed span is a number that
makes an unsupported run look supported. The standard is chosen off the
**largest PIPE row in the sheet's own BOM** — not a valve, whose body is a
different material in the same BOM.

### THE SPAN'S LENGTHS ARE THE CONTAINER CHECK'S LENGTHS

`printedLengths` in `apps/web/src/lib/supports.ts` reads the spool envelopes
already stored on the sheet and indexes them by contact-sheet cell. The spans
resolve their legs through that map, so **the drawing is read once and used
twice** — the support page and the shipping page can never quote different
figures for one piece of pipe, and there is no second dimension file to keep
in step.

It prefers `printedMm` over `mm` where they differ. They differ when a length
runs past the weld that closes its spool, and `mm` is then the SPOOL'S SHARE —
but a support span does not care where a spool ends. The pipe is continuous
once erected, so the whole printed figure is the length between two supports,
not the part on one side of a field weld.

### AND THE FLOW FOLLOWS THE SAME SOURCE

Each envelope part carries `drawnAs`, the plant direction the flow-arrow and
run-order work already resolved. So the SHAPE of a span comes from the same
rows as its length and the two cannot disagree.

`configurationsFromDirections` in `pipeSpan.ts`:

| legs run | it is | max |
|---|---|---|
| all one way | straight run | 7200 |
| two horizontals, no change of elevation | **an L** — one corner in plan | 7700 |
| both UP and DOWN | **a V** — down and back up through a low elbow | 6400 |
| a vertical among horizontals | either vertical case; shortest governs | 5500 |

**This closed the open limitation.** With only a turn COUNT to go on, both the
L and the V had to be offered and the shorter governed, so every genuine L was
judged 1300mm tighter than the sheet allows. The reference ISO's second span —
937 EAST then 1500 SOUTH — now reads **L, 7700mm** instead of V, 6400mm.

Still conservative where the drawing genuinely does not say: a vertical leg
among horizontals could be a riser carrying its own support (7200) or a drop
hanging off the run (5500), and nothing on the sheet says which, so both are
offered.

### Running it, all free

```
pnpm --filter @easy/worker exec tsx scripts/fetch-document.ts <id|name> out.pdf
cd packages/db && node scripts/dump-bom.mjs bom.json <documentId>
pnpm --filter @easy/worker exec tsx scripts/export-dimensions.ts <pdf> dims.json --labels-from dim-labels.json
pnpm --filter @easy/worker exec tsx scripts/export-pipe-supports.ts <pdf> bom.json supports.json --labels-from balloon-labels.json --dims dims.json [--preview balloons.png]
cd packages/db && node scripts/import-pipe-supports.mjs supports.json <documentId> --write
```

`fetch-document.ts` is worth knowing about generally: **every geometric probe
in this repo takes a PDF path, and the PDFs live in Supabase Storage, not the
working tree.** Without it the free tools can only be run on a file someone
downloaded by hand.

Reading the number inside each balloon is the only step needing eyes, and
`--preview` writes the exact contact sheet a call would send instead of sending
it — all 23 of page 1's balloons and all 27 of its dimension labels were read
off previews for **$0.00**. Same arrangement as the weld flags and spool tags.

The importer **replaces** this document's `pipe_support` rows rather than
adding to them. A support is a position on a drawing, not an accumulating
fact — and the older shape of this data is exactly what happens otherwise: the
same support 18-1 was in the database four times with four different spans
(2500, 0, 2437, 3623), because it had been measured by eye off a drawing that
is not to scale. That older data had **no producer at all** — it came from an
extraction schema that no longer existed, so a re-extraction wiped it the way
one wiped `geometry_spool`.

### What is still open

- **A vertical leg's case is still ambiguous.** Riser (7200) or drop (5500)
  depends on whether it carries its own support at the base, which the sheet
  does not state; both are offered and the shorter governs.
- **The branch-tee case is unreachable** until the span walk reads a tee on
  the run between two supports.
- **A span whose legs are not all in a spool envelope falls back** to the
  export's own `span_mm` and a turn count, which cannot tell an L from a V.
  That happens on a sheet whose envelopes were never built.
- Only page 1 of the reference ISO has been run end to end; the other four
  sheets need their balloon labels read off the preview, which is free.

## Instrument hook-up verification

`/hookup` checks an ISO against the project's typical hook-up set. The chain is
short and every link has to hold: the ISO BOM row names a device, the device
picks a typical, and the typical's piping-scope rows are looked for in the BOM.

### THE HYPHEN IN AN ISA TAG IS A CONVENTION, NOT PART OF THE TAG

`classifyInstrument` in `apps/web/src/lib/verifyIso.ts`. This broke the whole
page on a real drawing and the symptom named nothing useful:

```
FT0003  instrument (other)
  No typical in this set covers a instrument instrument on liquid service.
```

The ISO lists its instruments as `component_type "INSTRUMENT"`, description
**`FT0003`** — no hyphen. The tag decoder required one (`\b[A-Z]{2,4}-`), so
all three instruments fell through to the `instrument (other)` catch-all, which
names no measured variable. `matchHookupSheet` keys on the variable, so nothing
could ever match, and the set it was looking for was sitting right there in the
same project.

**The hyphen was never the evidence.** It is a cheap stand-in for "this token is
a tag, not a material code", and it is load-bearing: without it `SS316L` decodes
as a speed switch and `ASME B16.5` as an analysis element, and both appear in
nearly every BOM description. So the bare form is read LAST, after the spelled
out words and the hyphenated tag, and only with the evidence the hyphen stood
in for:

- the row has to SAY it is an instrument (the same `DEVICE_WORDS` the instrument
  branch of `classifyComponent` gates on — one regex, shared, because two
  answers to "is this an instrument" is the split that lets one of them rot)
- the prefix must not be in `NON_INSTRUMENT_PREFIXES`
- the letters must decode to a variable AND a function
- **the token must not FOLLOW a hyphen.** `XI-VKA102` is a tag whose loop
  number carries a three-letter area prefix, which defeats the hyphenated
  pattern; reading its `VKA102` as a letter group turns an indicator into a
  vibration alarm. This was the only false positive the measurement found, and
  it found three of them.
- scan EVERY candidate token, not the first — `INSTRUMENT, SS316 BODY, FT0003`
  otherwise stops at the blacklisted `SS316` and never reaches the tag

**Measured before it was applied**, across every BOM, valve, fitting, instrument
and hook-up row in the database — 1,112 rows: **18 change answer, and they are
the three instruments on this ISO.** Nothing else in the corpus moves.

```
cd packages/db && node scripts/probe-isa-tags.mjs     # free, prints the diff
```

Ruled out along the way: a minimum loop-number LENGTH. At 3 digits it admits
the pipe-support type codes (`SC101` → "speed controller", `SW100` → "speed
well"); 4 digits is clean on this corpus but is a number fitted to one plant's
numbering, where "the row says it is an instrument" is a reason.

`isaTagOf` takes the same rule and **normalises the bare form INTO the
hyphenated one**, which is its whole job — the ISO writes `FT0003` and the P&ID
`FT-0003`, and pairing them is what stops one instrument being reported twice,
once as missing from each drawing.

**Name the failure by the DEVICE, not the variable.** "a pressure instrument"
leaves a reviewer unable to tell whether the set lacks a gauge, a transmitter or
a differential one — and where the tag would not decode at all, the variable IS
"instrument", which is what printed `a instrument instrument`.

### A MISSING TYPICAL IS SOMETIMES THE RIGHT ANSWER

With the above fixed, this project's ISO resolves `FT0003` → flow transmitter /
liquid and `PT0004` → pressure transmitter / liquid, both matching every
piping-scope row. **`TT0003` still reports no typical, and that is correct**:
the uploaded set is 27 pages, pages 5–27 are its 23 typicals, all 23 extracted,
and not one of them is temperature. The page is reporting a gap in the hook-up
set, not a gap in itself. Check the page coverage before assuming otherwise — a
set whose typicals stop short looks exactly like a classifier that stopped
working.

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
