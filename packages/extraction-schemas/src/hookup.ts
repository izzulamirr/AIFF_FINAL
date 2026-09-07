import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Typical instrument hook-up drawings are issued as a numbered SET -- one
// sheet per (measured variable x service), e.g. "FLOW TRANSMITTER / LIQUID
// SERVICE" as sheet 6 of 27, "PRESSURE TRANSMITTER / GAS SERVICE" as
// another. Each sheet is self-contained: its own detail, its own bill of
// materials, its own notes. Same locate -> per-sheet pattern as iso.ts.
export const LOCATE_HOOKUP_SHEETS_TOOL: ClaudeTool = {
  name: "locate_hookup_sheets",
  description:
    "Identifies each typical instrument hook-up SHEET in this document -- one entry per sheet, never one entry covering several. " +
    'Sheets of a set share a drawing number and differ by the title block\'s sheet field ("6/27") and by what the sheet is FOR, ' +
    'which is printed in the drawing title: an instrument type ("FLOW TRANSMITTER", "PRESSURE TRANSMITTER", "TEMPERATURE ELEMENT") ' +
    'and usually a service ("LIQUID SERVICE", "GAS SERVICE", "STEAM SERVICE"). Give every sheet its own single-page range. ' +
    "Never return an empty list: a document uploaded as hook-up drawings has at least one sheet.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            drawing_number: { type: "string" },
            sheet: { type: "string", description: 'The title block sheet field for THIS sheet, e.g. "6/27".' },
            title: { type: "string", description: 'The drawing title as printed, e.g. "TYPICAL INSTRUMENT HOOK-UP DRAWINGS / FLOW TRANSMITTER / LIQUID SERVICE".' },
            pages: PAGE_RANGE_SCHEMA,
          },
          required: ["pages"],
        },
      },
    },
    required: ["sheets"],
  },
};

export const HOOKUP_SHEET_TOOL: ClaudeTool = {
  name: "record_hookup_sheet",
  description:
    "Records what one typical instrument hook-up sheet applies to, its bill of materials, and -- for every BOM row -- which " +
    "discipline supplies it. The discipline split is the reason this is extracted: a piping engineer can only be held to the " +
    "piping-scope components, so each row has to be placed on one side of the break.",
  input_schema: {
    type: "object",
    properties: {
      drawing_number: { type: "string" },
      sheet: { type: "string" },
      revision: { type: "string" },
      title: { type: "string", description: "The full drawing title as printed." },
      instrument_type: {
        type: "string",
        description:
          'What the sheet is a typical FOR, from the title, normalised to the device: "flow transmitter", "pressure transmitter", ' +
          '"temperature transmitter", "level transmitter", "pressure gauge", "temperature element". Use the words in the title; do not invent a device the sheet does not name.',
      },
      measured_variable: {
        type: "string",
        description: 'The variable this hook-up measures, one word: "flow", "pressure", "temperature", "level", "analysis". Taken from the instrument type.',
      },
      service: {
        type: "string",
        description: 'The service the sheet is for, as printed: "liquid", "gas", "steam", "vapour". Blank when the sheet names no service.',
      },
      mounting: {
        type: "string",
        description: 'Any mounting/elevation requirement stated in the notes, e.g. "transmitter shall be mounted below tapping point". Blank if none.',
      },
      slope: { type: "string", description: 'Any impulse-line slope printed on the detail, e.g. "1:12". Blank if none.' },
      discipline_break_note: {
        type: "string",
        description:
          'How this sheet marks the split of supply between disciplines, quoted as printed -- typically a break line on the detail labelled "BY PIPING" on one side and "BY INSTR." / "BY INSTRUMENT" on the other, and/or notes such as ' +
          '"ORIFICE FLANGE NUTS & BOLTS BY INSTRUMENT" or "5 VALVE MANIFOLD SHALL BE SUPPLIED BY TRANSMITTER SUPPLIER". Record every such marker you can see. Blank if the sheet marks none.',
      },
      bom_items: {
        type: "array",
        description:
          "Every row of the sheet's BILL OF MATERIALS, in order. These are the components the typical requires for ONE instrument " +
          '(a note usually says so explicitly, e.g. "QUANTITY SHOWN IN THIS SHEET IS APPLICABLE FOR ONE TAG ONLY").',
        items: {
          type: "object",
          properties: {
            item_no: { type: "string", description: 'The BOM ITEM column, e.g. "001A", "021A". Leave blank if the row has none.' },
            quantity: { type: "string", description: 'The QTY column exactly as printed -- including non-numeric entries such as "AS REQD.".' },
            size: { type: "string", description: 'The SIZE column as printed, e.g. "1/4\\" OD", "1/2\\" NPT(M) x 1/2\\" OD".' },
            description: { type: "string", description: 'The DESCRIPTION column as printed, e.g. "NEEDLE VALVE TUBE END CONNECTIONS, 6000#".' },
            material: { type: "string", description: "The MTR'L column as printed, including a note reference such as \"NOTE-4\"." },
            discipline: {
              type: "string",
              description:
                'Which discipline supplies THIS row: "piping", "instrument", or "undetermined". ' +
                'DECIDE IT FROM THE DRAWING FIRST: follow the row\'s balloon to where the component sits on the detail and see which side of the drawn "BY PIPING | BY INSTR." break line it falls on. A note naming a supplier is equally decisive ("SUPPLIED BY TRANSMITTER SUPPLIER" is instrument scope, "AS PER PIPING STANDARD DETAILS" is piping scope). ' +
                'ONLY where the sheet marks no break and no note applies, fall back to the rule: PIPING supplies the process tap (weldolet/sockolet/nozzle), the root/isolation valve, orifice flanges and anything else welded or flanged to the process line; INSTRUMENT supplies the tubing, tube fittings and connectors, branch tees, needle/gauge valves on the tubing, the valve manifold and the instrument itself. ' +
                'Use "undetermined" only when the sheet genuinely gives no basis to place a row -- never as a way of avoiding a judgement the drawing supports.',
            },
            discipline_basis: {
              type: "string",
              description:
                'How discipline was decided, so a reviewer can audit it: "drawn break" (traced the balloon across the BY PIPING / BY INSTR. line), "note" (quote the note), or "rule" (the sheet marks no break for this row).',
            },
          },
          required: ["description"],
        },
      },
      implied_items: {
        type: "array",
        description:
          "Components this typical REQUIRES but does not itemise in the bill of materials -- the ones a note or the detail defers " +
          'to another document. This matters more than it sounds: a hook-up sheet often lists only the instrument-scope tubing and ' +
          'fittings, and hands the piping-scope components to a standard detail, e.g. "PROCESS CONNECTION SIZE AND TYPE OF ISOLATION ' +
          'VALVE (SBB OR DBB) SHALL BE AS PER PIPING STANDARD DETAILS ... DWG NO. ...". That isolation valve is still required, and it ' +
          "is the piping engineer's to supply, so record it here rather than leaving the sheet looking as though piping supplies " +
          "nothing. Also record components drawn on the detail with a callout but no BOM row (orifice flanges, the tap itself). " +
          "THE PRIMARY ELEMENT COUNTS TOO: an orifice hook-up draws the orifice PLATE between its orifice flanges -- on the detail it is the " +
          "tab protruding from the flange joint -- and that plate is the thing being measured, not an accessory. Record it as its own item " +
          "alongside the flange pair; recording only the flanges leaves the assembly with nothing in it. " +
          "Leave empty when the BOM covers everything the sheet requires.",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: 'What the component is, as the sheet names it, e.g. "isolation valve (SBB or DBB) at process connection", "orifice flanges".' },
            size: { type: "string", description: "Size if the sheet states one. Blank where it defers that too." },
            quantity: {
              type: "string",
              description:
                "How many the typical needs FOR ONE TAG -- COUNT THEM ON THE DETAIL, do not assume one. A differential measurement taps the line TWICE: an orifice-plate flow transmitter draws a valve on each of the two taps and runs two impulse lines to the manifold, so its isolation valve quantity is 2, not 1. " +
                "A single-tap device (pressure transmitter, pressure gauge) is 1. The BOM corroborates the count -- two impulse lines need twice the tube connectors, so a row like \"MALE CONNECTOR 1/2\\\" NPT(M) x 1/2\\\" OD, 4 Nos\" means two lines of two, hence two tappings.",
            },
            discipline: {
              type: "string",
              description: 'Which discipline supplies it -- "piping", "instrument" or "undetermined" -- decided the same way as for BOM rows.',
            },
            deferred_to: {
              type: "string",
              description: 'The document the sheet defers this component to, as printed, e.g. "piping standard details (construction standard) DWG NO. 8015-0152-...". Blank if it is not deferred, only un-itemised.',
            },
            source_note: { type: "string", description: "The note or callout that requires it, quoted." },
          },
          required: ["description"],
        },
      },
      notes: {
        type: "array",
        description: "The sheet's numbered NOTES, as printed, in order.",
        items: { type: "string" },
      },
    },
    required: ["bom_items"],
  },
};
