import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Isometric drawings are usually one drawing per line/spool, each carrying a
// Bill of Material (BOM) table for that line's pipe/fittings/flanges/valves.
// Locate each drawing by its drawing number, then extract each separately --
// same locate -> per-sheet pattern as pid.ts.
export const LOCATE_ISO_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_iso_sheets",
  description:
    "Identifies each isometric SHEET in this document -- one entry per sheet, never one entry covering several sheets. " +
    'A multi-sheet drawing repeats the SAME drawing number on every sheet and distinguishes them only by the title block\'s "SHEET n OF m" field, ' +
    "so key each entry by drawing number AND sheet number and give it its own single-page range. A 3-page document showing " +
    '"SHEET 1 OF 3", "SHEET 2 OF 3", "SHEET 3 OF 3" must return three entries, each with pages start = end = that page.',
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            drawing_number: { type: "string" },
            sheet: {
              type: "string",
              description: 'The title block\'s sheet field for THIS sheet, e.g. "1 OF 3". Required when the document holds more than one sheet.',
            },
            pages: PAGE_RANGE_SCHEMA,
          },
          required: ["drawing_number", "pages"],
        },
      },
    },
    required: ["sheets"],
  },
};

// Spool boundaries get their own pass, run before the sheet is read, because
// asking for them as one field among forty of a full sheet extraction did not
// work: on a busy sheet the model stopped looking for valves and divided the
// weld numbering into even pieces instead (26 welds and 6 spools came back cut
// at welds 4, 8, 12, 16, 20). Alone, with nothing else to record, finding the
// valves is a small task that a sweep of the drawing actually answers.
//
// It asks for EVERY valve rather than only the boundaries -- enumerating what
// is drawn is a far more reliable request than picking out a subset, the BOM
// gives a count to check the enumeration against, and whether each one is a
// boundary is then a local yes/no about that one valve instead of a judgement
// about the sheet as a whole.
export const ISO_SPOOL_BOUNDARIES_TOOL: ClaudeTool = {
  name: "locate_iso_spool_boundaries",
  description:
    "Finds where one pipe spool ends and the next begins on a single isometric sheet, by locating every valve and every field weld drawn on it. " +
    "A spool is one shop-welded assembly: it is fabricated in the shop and trucked to site, so it can only end where the pipe can actually be taken apart or where it must be cut to fit. " +
    "Record what is drawn on the sheet -- do not infer boundaries from the weld numbering.",
  input_schema: {
    type: "object",
    properties: {
      line_size: {
        type: "string",
        description:
          'The nominal size of the MAIN RUN itself, from the title block / line number (e.g. "8\\"" or "200"). This is what separates a main-run valve from a small-bore branch valve, so read it first.',
      },
      spool_tags: {
        type: "array",
        items: { type: "string" },
        description:
          'The spool tags from this sheet\'s own "PIPE SPOOLS" schedule (a short list near the title block), in the order printed. This SETS THE COUNT: N tags means the sheet is cut into N spools, so N-1 boundaries must be found below. Leave empty only if the sheet prints no such list.',
      },
      valves: {
        type: "array",
        description:
          "EVERY valve drawn anywhere on this sheet -- main run and branches alike, boundary or not. Sweep the whole drawing and list them all; the BOM's valve rows tell you how many there should be, so cross-check your count against it before answering. " +
          "A valve is drawn as a bowtie/hourglass symbol on the pipe, usually with its BOM item balloon leadered to it and often an operator (handwheel, lever, VALVE_WRENCH callout) drawn alongside. " +
          "Listing a valve and marking it not-a-boundary is correct and expected; missing one entirely is not.",
        items: {
          type: "object",
          properties: {
            item_no: { type: "string", description: "The BOM item number in the balloon leadered to this valve, as printed. Blank if no balloon is legible." },
            description: { type: "string", description: 'What this valve is, from its BOM row, e.g. "200mm BALL VALVE, RB, 150# RF, TRUNNION". Enough to tell it from the sheet\'s other valves.' },
            size: { type: "string", description: 'This valve\'s nominal size as printed in its BOM row or beside the symbol, e.g. "200" or "8\\"".' },
            on_main_run: {
              type: "boolean",
              description:
                "true if this valve sits on the MAIN RUN -- the through-line the sheet is drawing, at line_size. false if it sits on a BRANCH: a smaller-bore takeoff (drain, vent, instrument tap) that leaves the main run and dead-ends at its own blind flange or cap. Size is the giveaway -- a valve smaller than line_size is nearly always on a branch.",
            },
            flanged_both_sides: {
              type: "boolean",
              description:
                "true if a flange is drawn on BOTH sides of this valve -- a heavy bar across the pipe either side of the bowtie, with the BOM carrying a matching pair of flanges and a stud-bolt/gasket set. That bolted pair is what lets the pipe come apart here. A valve welded straight into the line is not a boundary.",
            },
            pipe_continues_past: {
              type: "boolean",
              description:
                "true if the main run carries on past this valve to more pipe on this sheet. false if the run ends here (the sheet's last item, a blind flange, a cap, or the far side of a \"CONT'D ON ...\" box). A valve with nothing after it does not start a new spool, because there is nothing left to put in one.",
            },
            is_boundary: {
              type: "boolean",
              description:
                "true only when all three of on_main_run, flanged_both_sides and pipe_continues_past are true. This is the valve the spool is broken at.",
            },
            nearest_upstream_weld: {
              type: "string",
              description:
                'The ID number of the weld immediately BEFORE this valve along the main run -- the weld joining the pipe to the valve\'s own upstream flange, which is the very last weld mark you pass walking toward it, not the one before that. Read the label printed at that mark (a small flag like "BW12" gives "12") and give the bare number. ' +
                "Blank it rather than guessing: a wrong number here is worse than none, and no two valves can share one. Every valve on the sheet sits at its own point on the run, so if you find yourself about to give the same weld for two different valves, you have not read the marks -- leave them blank instead.",
            },
            location_note: {
              type: "string",
              description: 'Where this valve sits, in words, so the reading can be checked, e.g. "on the 200mm run just downstream of the 200x150 reducer, between BW12 and BW13".',
            },
          },
          required: ["is_boundary"],
        },
      },
      field_welds: {
        type: "array",
        description:
          'Every FIELD WELD drawn on this sheet. A field weld is the forced cut made once a continuous welded run passes the 6000mm that will fit on a truck, and it is drawn as a distinct hatched "FW" tick at that weld\'s own point on the isometric (sometimes beside the weld\'s number label rather than replacing it). Every field weld ends a spool. ' +
          "Read these off the DRAWING, not off the weld list table's row order -- that table is often grouped by category (all FABRICATION-ITEM rows, then all ERECTION-ITEM/FIELDWELD rows), which does not match physical position along the pipe.",
        items: {
          type: "object",
          properties: {
            weld_no: { type: "string", description: "The weld's ID number, bare, as printed at the hatched FW mark." },
            evidence: { type: "string", description: 'What identifies it, e.g. "hatched FW tick at BW6; the 6200mm dimension runs from the start of the sheet to this point".' },
          },
          required: ["weld_no"],
        },
      },
    },
    required: ["valves", "field_welds"],
  },
};

// Measured values carry their unit inline, read from the title block's own
// column header (e.g. a "PRESS. kPag" column of 5 becomes "5 kPag", a
// "TEMP. °C" column of 90 becomes "90 °C"). Units on ISOs and line lists
// frequently differ (kPag vs barg is common), so gate 2 converts before
// comparing -- see convertPressure in apps/web/src/lib/verifyIso.ts. That
// conversion is only possible if the unit is captured here.
export const ISO_SHEET_TOOL: ClaudeTool = {
  name: "record_iso_sheet",
  description:
    "Records the title block info, line/spec info, pipe spools, welds, and Bill of Material rows for one isometric drawing. Append the unit from the title block's column header to every measured value (e.g. \"5 kPag\", \"90 °C\", \"25 mm\"). Leave non-numeric placeholders such as NA / NIL. / AMB. exactly as printed.",
  input_schema: {
    type: "object",
    properties: {
      document_number: { type: "string" },
      drawing_number: { type: "string" },
      line_number: { type: "string" },
      size: { type: "string", description: 'Nominal size as printed, e.g. "2\\"" or "50 mm"' },
      spec_class: { type: "string" },
      service: { type: "string" },
      from_location: {
        type: "string",
        description:
          "Where the pipeline STARTS, read from the drawn pipe run itself: follow the piping in the flow direction and record the callout at its start point -- an equipment/nozzle connection (e.g. \"N1 / V-101\"), a tie-in flag, or a \"CONT'D FROM <drawing no.>\" continuation box. This is on the drawing at the end of the pipe, not in the title block.",
      },
      to_location: {
        type: "string",
        description:
          "Where the pipeline ENDS, read from the drawn pipe run itself: the callout at the far end of the piping -- an equipment/nozzle connection, tie-in flag, or \"CONT'D ON <drawing no.>\" continuation box.",
      },
      slope: { type: "string", description: 'Any slope annotation printed on the drawing, e.g. "1:100", "SLOPE 1:100 TOWARDS V-101". Read the printed note; do not infer slope from the geometry. Leave blank if none is shown.' },
      scale: { type: "string" },
      sheet: { type: "string" }, // e.g. "1 OF 4"
      revision: { type: "string" },
      owner_pid_no: { type: "string" }, // owner/client's own P&ID drawing number, if different from pid_no
      pid_no: { type: "string" }, // the P&ID drawing number this ISO cross-references
      owner_ga_dwg_no: { type: "string" },
      ga_dwg_no: { type: "string" }, // the GA drawing number this ISO cross-references
      design_pressure: { type: "string", description: 'DESIGN row, PRESS. column, with the header\'s unit, e.g. "10.5 kPag"' },
      design_temperature: { type: "string", description: 'DESIGN row, TEMP. column, with unit, e.g. "150 °C"' },
      operating_pressure: { type: "string", description: 'OPERATING row, PRESS. column, with unit, e.g. "5 kPag"' },
      operating_temperature: { type: "string", description: 'OPERATING row, TEMP. column, with unit, e.g. "90 °C"' },
      hydrotest_pressure: { type: "string", description: "HYDROTEST row, PRESS. column, with unit" },
      hydrotest_temperature: { type: "string", description: 'HYDROTEST row, TEMP. column, with unit (or "AMB." as printed)' },
      painting_system: { type: "string" },
      radiograph: { type: "string" },
      test_type: { type: "string" },
      insul_spec: { type: "string" },
      insul_thickness_mm: { type: "string", description: 'Insulation thickness with unit, e.g. "25 mm"' },
      spec_breaks: {
        type: "array",
        description:
          'Spec (material class) breaks drawn on this isometric. A break is marked ONLY by "MATL <class>" callout boxes drawn either side of a joint on THIS sheet (usually a flanged joint) -- both boxes must actually be printed on this sheet\'s drawing. A "CONT\'D ON/FROM ..." reference to a different line number is NOT a break by itself: that line continues onto a separate drawing (often a genuinely unrelated line, e.g. after a size change or a tie-in), and its class says nothing about this sheet\'s own BOM. If this sheet prints no "MATL" callout pair, it is single-class -- record only the title-block class, even when a continuation target carries a different class suffix. Record one entry per class present on the drawing, INCLUDING the title-block class. Leave the array empty only when the whole drawing is one class.',
        items: {
          type: "object",
          properties: {
            spec_class: { type: "string", description: 'The piping/material class code, e.g. "AC03N", "BC70N"' },
            rating: {
              type: "string",
              description:
                'This class\'s ASME pressure class as a bare number when it can be told from the drawing or BOM, e.g. "150" or "300". A 150#/300# spec break shows both ratings in the BOM (150# flanges/gaskets/150RF bolts vs 300# ones); the class on the higher-rated side is the higher number. Blank if not determinable.',
            },
            location_note: {
              type: "string",
              description: 'Where this class applies / where the break sits, as drawn, e.g. "downstream of flanged joint at check valve, toward CONT. ON 18\\"-22-214-01-CRD-0001-BC70N-N"',
            },
          },
          required: ["spec_class"],
        },
      },
      spool_tags: {
        type: "array",
        items: { type: "string" },
        description:
          'Just the list of spool tags from this sheet\'s own "PIPE SPOOLS" schedule (a short list near the title block, e.g. "8\\"-22-214-01-CRD-0002-AC03N-N-04", "...-N-05" ...), in the order printed -- nothing else, no weld assignment here. If the sheet genuinely prints no such schedule (rare), invent sequential tags "<line_number>-01", "-02", ... This list SETS THE COUNT: N tags printed means the sheet is cut into exactly N spools, so spool_boundaries below must hold exactly N-1 entries.',
      },
      spool_boundaries: {
        type: "array",
        description:
          'The points where one spool ENDS and the next begins, in order along the run -- exactly one entry per boundary. ' +
          'COUNT IS FIXED BY THE SHEET: if spool_tags holds N tags, this array holds exactly N-1 entries, because N spools are separated by N-1 cuts. Do not return more or fewer.\n\n' +
          'A boundary exists at exactly two things and nothing else:\n' +
          '(a) a VALVE FLANGED ON BOTH SIDES sitting on the MAIN RUN -- the only real bolted disassembly point. On the isometric a valve is a bowtie/hourglass symbol with a flange (a short heavy bar across the pipe) drawn on each side of it, and it carries its own BOM item balloon. ' +
          'A valve at the dead end of a BRANCH is NOT a boundary -- the branch stays inside whichever spool its takeoff belongs to.\n' +
          '(b) a FIELD WELD -- the forced cut once a continuous welded run passes 6000mm, drawn as a distinct hatched "FW" tick at that weld.\n\n' +
          'FIND THESE BY LOOKING, NOT BY DIVIDING. Do not space the boundaries evenly along the weld numbering, and do not assume spools hold a similar number of welds each -- real spools are very uneven (one may hold a single weld, the next a dozen). ' +
          'Locate each valve symbol and each hatched FW tick on the drawing first, then read off which weld sits immediately before it. Every entry must cite what you actually saw there in evidence; if you cannot point to a specific drawn valve or FW tick, it is not a boundary.',
        items: {
          type: "object",
          properties: {
            after_weld: {
              type: "string",
              description:
                "The ID number of the last weld on the MAIN RUN before this boundary. Bare number, no prefix. " +
                "A flanged valve is drawn as: pipe -- WELD -- flange -- VALVE -- flange -- WELD -- pipe. The weld you want is the FIRST of those two, the one joining the pipe to the valve's upstream flange: walk the main run toward the valve and take the very last weld mark you pass before reaching it, not the one before that. " +
                "Being off by one here moves the whole spool boundary, and it is the most common way this goes wrong. The weld on the valve's downstream flange starts the NEXT spool, so it is never an after_weld. For a field weld, it is that weld itself. " +
                "If a branch takes off upstream of this point and dead-ends (typically at its own small valve and blind flange), that branch belongs to the spool ending here and is handled automatically -- so give the MAIN RUN's weld here, never the branch's own last weld.",
            },
            boundary_type: {
              type: "string",
              enum: ["valve", "field_weld"],
              description: '"valve" for a both-sides-flanged valve on the main run; "field_weld" for a forced 6000mm cut marked by a hatched FW tick.',
            },
            evidence: {
              type: "string",
              description:
                'What you actually see at this point on the drawing, specific enough to check. For a valve: its BOM PT NO and description plus the welds either side, e.g. "PT NO 7, 8\\" 150# GATE VALVE, flanged both sides, between welds 14 and 15". ' +
                'For a field weld: the weld ID carrying the hatched FW tick and the run dimension that forces the cut, e.g. "weld 6 carries the hatched FW mark; 6200mm dimension spans welds 1-6".',
            },
          },
          required: ["after_weld", "boundary_type", "evidence"],
        },
      },
      welds: {
        type: "array",
        description:
          'Every weld marked on this sheet, cross-referenced against the sheet\'s own WELD LIST table (columns ID / ND / Type / Category). A weld is drawn as a small diamond/hexagon mark on the pipe. Record one entry per mark -- sweep the run end to end from the TILES, there are typically a dozen or more per sheet; do not merge, skip, or renumber them, and do not count a mark twice where overlapping tiles show it more than once. Leave empty only if the sheet marks no welds at all.\n\n' +
          "Two of the fields below (comes_after_weld, closes_spool) place this weld into a pipe spool -- deliberately asked as a LOCAL question about this one weld's immediate neighbourhood, not as a whole-sheet grouping task: figure out spool membership weld by weld, not by trying to sort every weld on the sheet into buckets at once. " +
          'SPOOL BOUNDARY RULE, for closes_spool: a spool is one shop-welded assembly, and it ends ONLY at (a) a VALVE flanged on both sides sitting right after this weld (the only real bolted disassembly point), or (b) THIS weld itself being a forced cut past 6000mm of continuous welded pipe, which is exactly what a FIELD WELD marks. Nothing else ends a spool -- an elbow, reducer, or a branch takeoff (weldolet/reducing tee) never does, so closes_spool is false for those. A branch dead-ends (typically its own small valve and blind flange) without spawning a new spool -- its last weld does not need closes_spool true, because nothing continues past it anyway.',
        items: {
          type: "object",
          properties: {
            weld_no: {
              type: "string",
              description:
                'This weld\'s ID number in the WELD LIST table, as a bare number without any letter prefix (e.g. "6", "12") -- read the number printed at the mark, then use it to look up that same ID\'s row in the table for size/type. The table\'s row ORDER does not always match this weld\'s physical position along the pipe (a branch takeoff can carry an ID that is numbered out of sequence, and the table itself is sometimes grouped by category rather than by position) -- always join by the ID number itself, never by position in either the table or your walk of the drawing.',
            },
            weld_type: {
              type: "string",
              description:
                'The short code as commonly marked: BW (buttweld), FW (field weld), TW (tapweld), TH (threaded), SW (socketweld). Cross-check two sources and prefer the drawing when they conflict: (1) the WELD LIST table\'s Type column for this weld\'s ID (BUTTWELD/FIELDWELD/TAPWELD/THREADED/SOCKETWELD -- abbreviate it), and (2) the mark itself on the isometric, where a genuine field weld carries a distinct hatched "FW" tick at its own point (sometimes drawn right next to the weld\'s own number label, not replacing it). If the hatched FW mark sits at a different weld than the table\'s category-sorted position would suggest, trust the mark on the drawing.',
            },
            size: { type: "string", description: "Nominal size of the pipe at this weld, from the WELD LIST table's ND column for this ID. Blank otherwise." },
            nde_codes: {
              type: "string",
              description: 'Any inspection/NDE code boxes attached to this weld, joined with " " as printed, e.g. "F5 G9 B11", "FX GX BX", "X". These sit in rectangular boxes with a leader to the weld. Blank if none.',
            },
            comes_after_weld: {
              type: "string",
              description:
                "The weld ID number that sits immediately BEFORE this one along the pipe -- look at this weld's own mark and trace back to whatever weld/fitting comes right before it (on the mainline, or on a branch if this weld is on one). Leave BLANK only for the very first weld on the sheet's run (the one nearest its \"CONT'D FROM\" / equipment start). Two different welds legitimately sharing the same comes_after_weld value is normal and expected: it means a branch takes off right there -- both the branch's first weld and the mainline's next weld point back to that same shared weld.",
            },
            closes_spool: {
              type: "boolean",
              description:
                "true if a spool ends at THIS weld -- see the SPOOL BOUNDARY RULE above. false for every other weld, including this one being a branch's own dead-end. " +
                "This is the SAME fact as spool_boundaries, recorded against the weld: it must be true for exactly the welds you listed in spool_boundaries.after_weld, and false everywhere else. If the two disagree, re-check the drawing rather than leaving them inconsistent.",
            },
          },
          required: ["weld_no"],
        },
      },
      bom_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item_no: {
              type: "string",
              description:
                'The BOM row\'s own PT NO / item number, e.g. "1", "2". LEAVE BLANK for rows printed without one -- added/revision rows commonly carry no PT NO and no ITEM CODE. Never invent a number for them, and never skip the row because it lacks one.',
            },
            material_section: {
              type: "string",
              description:
                'Which materials block this row is printed under: "fabrication" for rows under FABRICATION MATERIALS (shop-installed: pipe, fittings, flanges, valves) or "erection" for rows under ERECTION MATERIALS (site-installed: gaskets, bolts, spectacle blinds, instruments). A sheet may print both blocks, each with its own PT NO sequence -- so the same PT NO can appear twice on one sheet and the two rows are different items. Blank if the sheet has only one unlabelled materials table.',
            },
            description: { type: "string" },
            component_type: { type: "string" }, // pipe | fittings | fasteners | valves | pipe supports | instruments | ...
            size: {
              type: "string",
              description:
                'The row\'s nominal size WITH the unit from its column header, exactly as the pressures and temperatures are done. A BOM size column headed "N.S. (MM)" holds millimetres, so a printed 25 is "25 mm" and a printed 8 is "8 mm" -- never append an inch mark to it. A column headed in inches gives "8\\"". Without the unit a bare 25 is ambiguous between DN25 and 25 inches, and the comparison against a P&ID (which writes the same valve as 1") cannot be made. For a reducer give both sizes, e.g. "200 x 150 mm".',
            },
            quantity: { type: "string" },
            material: { type: "string" },
            item_code: { type: "string" }, // the BOM's "ITEM CODE" column (e.g. "P9610-C", "HK9511") -- references a specific row in the piping spec, NOT a class code like "150JY11"
            item_spec_basis: {
              type: "string",
              description:
                'How item_spec_class was decided, so it can be audited: "position" (traced the item\'s balloon to a point up/downstream of the MATL callout), "rating" (placed by its own pressure class), "rate-matched gasket" (the break-joint gasket taking the higher class), or "sheet has no spec break". Blank when item_spec_class is blank.',
            },
            item_spec_class: {
              type: "string",
              description:
                'When the drawing has a spec break (see spec_breaks), the class that governs THIS item -- the side of the break it belongs to. A spec break is a POINT on the run, so EVERY item sits on one definite side; assign all of them, including un-rated ones. ' +
                'Use two signals. (1) POSITION -- follow each BOM item number\'s balloon/leader to where it sits on the drawn run and see whether that point is upstream or downstream of the "MATL" callouts; this is the only way to place plain pipe, weldolets and butt-weld elbows/tees/reducers, which carry no rating. A repeated item code split across two BOM rows is the giveaway that one row is each side of the break (e.g. TUBE-9 28.1M on the long upstream run and TUBE-9 1.5M on the short stub past the break; ELBO-31 qty 7 upstream and ELBO-31 qty 1 downstream) -- place each row by where its balloons actually are. ' +
                '(2) RATING, for rated items AWAY FROM THE BREAK JOINT -- a "150# RF" flange, gasket, 150RF bolt or 150# valve is the 150# class, a "300# RF" one or an alloy-overlay valve is the 300# class. ' +
                'Rating is only usable where it TELLS THE CLASSES APART. Two classes on one sheet commonly share a rating (AC03N and AC03U both 150#, with only BC70N at 300#), and a class whose rating the drawing never prints could be any of them. If the item\'s rating matches more than one class in spec_breaks, or any class there has no rating, rating decides nothing -- place by POSITION. ' +
                'CRITICAL: rating does NOT identify the side AT the break joint, because the joint is rate-matched to the HIGHER class. The mating flange on the lower-rated side, together with the joint gasket and its bolts, is made to the higher rating so the two flanges bolt together -- yet that flange still BELONGS to the lower class, because the break is at the joint face, after it. So on a 150#/300# break, a 300# flange sitting upstream of the MATL callout is a 150#-class (AC03N) item rate-matched up, NOT a 300#-class item. Place all break-joint hardware by POSITION and record basis "position (rate-matched to the higher class)". ' +
                'Never place by rating where the rating comes from the component\'s own standard rather than the line class either: ASME B16.36 orifice flanges (and their gaskets) start at 300#, so a 150# line\'s orifice assembly is 300# with no break involved -- place those by position too. ' +
                'Leave blank ONLY when the drawing genuinely does not show which side an item is on. Blank on single-class drawings and on sheets with no break.',
            },
          },
          required: ["description"],
        },
        description:
          "EVERY row printed in the sheet's materials block(s), in order. A sheet issued for fabrication prints TWO blocks -- FABRICATION MATERIALS and ERECTION MATERIALS -- each with its own PT NO sequence; record the rows of both, tagging each with material_section. " +
          "Rows added by a revision are printed WITHOUT a PT NO and WITHOUT an ITEM CODE, often in a different colour, appended under the category they belong to (an extra PIPE row, an extra 150# flange, a small-bore gate valve). They are real material and must be recorded exactly like numbered rows -- leave item_no and item_code blank and take the description, size and quantity as printed. " +
          "Do NOT record a sheet's PIPE SPOOLS list as BOM rows -- that list belongs in spool_tags instead.",
      },
    },
    required: ["line_number", "bom_items"],
  },
};
