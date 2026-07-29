import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// P&IDs are schematic drawings, usually one sheet per PDF page. Locate each
// sheet by its title-block drawing/sheet number, then extract each sheet
// separately -- validate early whether plain text extraction (cheap) gives
// Claude enough context to associate tags with lines, or whether sheets need
// to go through as native PDF page images instead (see the architecture
// plan's section 3.1 note on this).
export const LOCATE_PID_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_pid_sheets",
  description:
    "Identifies which page(s) contain each P&ID drawing sheet, keyed by the sheet/drawing number in its title block. " +
    'Classify each sheet\'s type: most P&IDs are "process" sheets; a sheet whose drawing title is a Legend, Symbols, ' +
    'Abbreviations, or Typical Details sheet (rather than an actual process P&ID) is "legend" -- many projects keep the ' +
    "legend in a completely separate document that references these process sheets rather than including it here; if so, no sheet in this document is a legend sheet.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sheet_number: {
              type: "string",
              description:
                "The drawing number printed in the TITLE BLOCK (bottom-right corner of the sheet), e.g. \"PACE-P001-EXE-MESB-3000-PRO-PID-0010\". Never take this from an off-page connector box, a notes reference, or another drawing's number mentioned on the sheet -- only the title block's own drawing number.",
            },
            drawing_title: { type: "string" },
            sheet_type: { type: "string", enum: ["process", "legend"] },
            pages: PAGE_RANGE_SCHEMA,
          },
          required: ["sheet_number", "pages"],
        },
      },
    },
    required: ["sheets"],
  },
};

// A legend/symbols/abbreviations sheet is almost entirely graphical (symbol
// shapes next to their meaning) with little of that association recoverable
// from plain text, so it's read from a rendered page image rather than text
// alone -- see pdfImages.ts and how the ISO extractor uses it.
export const PID_LEGEND_TOOL: ClaudeTool = {
  name: "record_pid_legend",
  description:
    "Records EVERY definition from a P&ID legend/symbols/abbreviations sheet. Work through the sheet column by column, table by table, top to bottom, and record every row of every table -- line notation, tag/numbering format decoders and their letter/code sub-tables, abbreviations, valve and in-line symbols, safety devices, primary elements, instrument bubbles, instrument identification letters, tag prefix numbers, equipment shapes, representation-vs-details typicals, and numbered notes. A legend sheet commonly holds 100-300 items; do not stop early or summarize.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            symbol: { type: "string", description: 'The symbol name or abbreviation as labeled, e.g. "FIC", "GATE VALVE", "///" for insulation' },
            meaning: { type: "string", description: "What it represents" },
            category: {
              type: "string",
              description:
                'One of: "line_type" (line notation/styles), "line_notation" (pipe identification code format decoder), "equipment_tag_format" (equipment numbering format decoder), "equipment_letter" (equipment identification code letters), "service_code" (fluid/service codes), "pipe_class_rating", "pipe_material", "corrosion_allowance", "valve_end_connection", "tracing_insulation", "abbreviation", "valve" (valve symbols), "inline_symbol" (flanges, reducers, strainers, blinds, spacers...), "safety_device" (PSV, bursting disc, vents, flame arrestor...), "primary_element" (orifice plate, flowmeters, RO...), "instrument_bubble" (instrument circle/square mounting-location symbols, trip interlock, selectable), "instrument_letter" (instrument identification letter table: first-letter variable + succeeding function letters), "tag_prefix_number" (system/area prefix numbers), "equipment_symbol" (vessel/exchanger/pump/conveyor shapes), "miscellaneous", "typical" ("P&ID REPRESENTATION vs DETAILS" rows), "note" (numbered general notes). Use the closest one; never invent new names.',
            },
            applies_to: {
              type: "string",
              description:
                'For "typical" rows only: the instrument-type letters of the simplified P&ID symbol this detail expands, e.g. "FT" (orifice-plate flow transmitter), "TG", "TT", "PG", "PIT", "LT". Blank otherwise.',
            },
            implied_components: {
              type: "string",
              description:
                'For "typical" rows only: every component the DETAILS drawing shows that the simplified P&ID representation hides, joined " / " with counts, e.g. "FE orifice plate / 2x isolation valve / instrument manifold" or "TW thermowell / INST-PIP spec break". These parts exist in reality and appear on the ISO even though the P&ID does not draw them. Blank otherwise.',
            },
          },
          required: ["symbol", "meaning"],
        },
      },
    },
    required: ["items"],
  },
};

export const PID_SHEET_TOOL: ClaudeTool = {
  name: "record_pid_sheet",
  description: "Records line list rows, valve tags, and instrument tags visible on one P&ID sheet.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_number: { type: "string" },
            size: { type: "string" },
            spec_class: { type: "string" },
            service: { type: "string" },
            from_equipment: {
              type: "string",
              description:
                'Where the line comes from on this sheet. Prefer the equipment TAG (e.g. "V-A100"), not the display name (e.g. not "CONTACTOR A") when both are shown. If the line arrives through an off-page connector, record the far-side equipment tag from the connector\'s label (a connector labeled "FROM / TO V-A102" means the far side is "V-A102") -- never the literal "FROM / TO" wording. Off-page connectors are two-way; do not worry about flow direction.',
            },
            to_equipment: {
              type: "string",
              description:
                'Where the line goes on this sheet. Same rules as from_equipment: prefer the equipment tag, and for an off-page connector record the far-side equipment tag from its label.',
            },
            slope: {
              type: "string",
              description: 'Any slope annotation printed on the line, e.g. "1:100" (often next to a small triangle symbol). Blank if none.',
            },
            continues_on: {
              type: "string",
              description:
                'If the line leaves this sheet through an off-page connector, the target drawing/sheet reference printed in the connector box (e.g. "A1A101"). Several references join with " / ". Blank if the line starts and ends on this sheet.',
            },
          },
          required: ["line_number"],
        },
      },
      valves: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tag_number: { type: "string" },
            valve_type: { type: "string" },
            line_number: { type: "string" },
          },
          required: ["tag_number"],
        },
        description:
          "Only symbols the project legend's VALVE category defines belong here (gate/globe/ball/butterfly/check/control valves, PSVs...). Control valves (PCV/TCV/LCV/FCV/XV etc.) are VALVES under their own tag, even though the tag looks instrument-like. Expansion joints/bellows (EJ-xxx), strainers, hoses and other legend in-line symbols are NOT valves -- record them under fittings even when they carry a tag.",
      },
      fittings: {
        type: "array",
        description:
          "Inline piping symbols drawn ON a line: flange pairs/joints (incl. nozzle mating flanges), blind/spectacle/spade flanges and blanked stubs, spacers, concentric/eccentric reducers, expansion joints/bellows (INCLUDING tagged ones like EJ-A101 -- put the tag in fitting_type), strainers, hoses, removable spools. Consult the project legend's categories: only its VALVE-category symbols go under valves; its in-line symbols belong here. NOT instruments. One entry per symbol occurrence.",
        items: {
          type: "object",
          properties: {
            fitting_type: { type: "string", description: 'e.g. "inline flange pair", "blind flange DN50 drain stub", "concentric reducer"' },
            line_number: { type: "string", description: "The full line number this fitting sits on" },
            size: { type: "string" },
            quantity: { type: "string", description: 'Number of this symbol at this spot, default "1"' },
          },
          required: ["fitting_type"],
        },
      },
      instruments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tag_number: { type: "string" },
            instrument_type: { type: "string" },
            line_or_equipment_ref: { type: "string" },
            parent_valve: {
              type: "string",
              description:
                'If this instrument is an accessory mounted on / part of a valve assembly -- a positioner (ZC), position indicator (ZI), position transmitter (ZIT), limit/position switches (ZSO/ZSC/ZSH/ZSL), solenoid (XY), or an attached handswitch (HS) drawn connected to the valve\'s actuator -- record the primary valve\'s tag here (e.g. ZI-A102 and ZIT-A102 on control valve PCV-A102 get parent_valve "PCV-A102"). Blank for standalone instruments.',
            },
            parent_instrument: {
              type: "string",
              description:
                'If this instrument belongs to another instrument\'s loop, record the PRIMARY instrument\'s tag here. Follow the whole signal chain from the primary element: EVERY instrument in the same loop (usually the same loop number) connected back to the primary gets this field -- all pointing at the one primary, never chained to each other. The thermowell (TW) is ALWAYS the primary when present (e.g. TW-A111 primary; TT-A111, TI-A111 and TIC-A111 ALL get parent_instrument "TW-A111"); with no TW, the field transmitter (TT/PIT/FIT...) is the primary and its indicators/controllers (TI/PI/TIC/PIC...) point at it. Blank for standalone instruments and for primaries themselves.',
            },
          },
          required: ["tag_number"],
        },
      },
    },
    required: ["lines"],
  },
};
