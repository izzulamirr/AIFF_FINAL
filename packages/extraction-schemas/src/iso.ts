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
          'Spec (material class) breaks drawn on this isometric. A break is marked by "MATL <class>" callout boxes either side of a joint (usually a flanged joint), and/or by a continuation line number carrying a different class. Record one entry per class present on the drawing, INCLUDING the title-block class. Leave the array empty only when the whole drawing is one class.',
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
      spools: {
        type: "array",
        description:
          'The pipe spools this sheet is broken into. A spooled (fabrication-issued) ISO divides the run into shop-prefabricated sections, each numbered with the line number plus a "-NN" suffix (e.g. "8"-22-214-01-CRD-0002-AC03N-N-01"). They appear in TWO places and both must agree: boxed callouts on the drawing with a leader to the spool they name, and a "PIPE SPOOLS" list in the materials block. Record every distinct spool number on the sheet, once each. Leave empty for an unspooled drawing.',
        items: {
          type: "object",
          properties: {
            spool_no: { type: "string", description: 'The full spool number as printed, e.g. "8\\"-22-214-01-CRD-0002-AC03N-N-01".' },
            listed_in_pipe_spools: {
              type: "string",
              description: '"yes" if this spool number appears in the sheet\'s PIPE SPOOLS list, "no" if it is only a callout on the drawing. A callout with no matching list entry (or the reverse) is a real drafting error worth surfacing, so do not silently reconcile them.',
            },
            note: { type: "string", description: "Anything printed about this spool, e.g. what it spans. Blank if nothing." },
          },
          required: ["spool_no"],
        },
      },
      welds: {
        type: "array",
        description:
          'Every weld marked on this sheet. A weld is drawn as a small DIAMOND on the pipe containing a weld type over a number -- "SW" over "01" is shop weld 01, "FW" over "12" is field weld 12. They are numbered sequentially across the drawing and there are usually dozens per sheet. Record one entry per diamond; do not merge, skip, or renumber them, and do not count a diamond twice where overlapping tiles show it more than once. The weld COUNT is derived from this list, so a missed diamond understates it. Leave empty only if the sheet marks no welds at all.',
        items: {
          type: "object",
          properties: {
            weld_no: { type: "string", description: 'The number inside the diamond, as printed, e.g. "01", "34".' },
            weld_type: {
              type: "string",
              description: 'The letters inside the diamond: "SW" (shop weld), "FW" (field weld), or whatever else is printed. Never guess -- read the diamond.',
            },
            size: { type: "string", description: "Nominal size of the pipe at this weld, if the adjacent run is dimensioned. Blank otherwise." },
            spool_no: { type: "string", description: "The spool this weld sits within, when the spool callouts make it clear. Blank if not determinable." },
            nde_codes: {
              type: "string",
              description: 'Any inspection/NDE code boxes attached to this weld, joined with " " as printed, e.g. "F5 G9 B11", "FX GX BX", "X". These sit in rectangular boxes with a leader to the weld. Blank if none.',
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
          "Do NOT record the PIPE SPOOLS list as BOM rows: those are spool numbers, and belong in spools.",
      },
    },
    required: ["line_number", "bom_items"],
  },
};
