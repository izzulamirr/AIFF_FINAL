import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Isometric drawings are usually one drawing per line/spool, each carrying a
// Bill of Material (BOM) table for that line's pipe/fittings/flanges/valves.
// Locate each drawing by its drawing number, then extract each separately --
// same locate -> per-sheet pattern as pid.ts.
export const LOCATE_ISO_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_iso_sheets",
  description: "Identifies which page(s) contain each isometric drawing, keyed by its drawing number in the title block.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            drawing_number: { type: "string" },
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
    "Records the title block info, line/spec info, and Bill of Material rows for one isometric drawing. Append the unit from the title block's column header to every measured value (e.g. \"5 kPag\", \"90 °C\", \"25 mm\"). Leave non-numeric placeholders such as NA / NIL. / AMB. exactly as printed.",
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
      bom_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item_no: { type: "string" }, // the BOM row's own ID/item number (e.g. "1", "2")
            description: { type: "string" },
            component_type: { type: "string" }, // pipe | fittings | fasteners | valves | pipe supports | instruments | ...
            size: { type: "string" },
            quantity: { type: "string" },
            material: { type: "string" },
            item_code: { type: "string" }, // the BOM's "ITEM CODE" column (e.g. "P9610-C", "HK9511") -- references a specific row in the piping spec, NOT a class code like "150JY11"
          },
          required: ["item_no", "description"],
        },
      },
    },
    required: ["line_number", "bom_items"],
  },
};
