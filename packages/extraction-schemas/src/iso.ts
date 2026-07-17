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

export const ISO_SHEET_TOOL: ClaudeTool = {
  name: "record_iso_sheet",
  description: "Records the title block info, line/spec info, and Bill of Material rows for one isometric drawing.",
  input_schema: {
    type: "object",
    properties: {
      document_number: { type: "string" },
      drawing_number: { type: "string" },
      line_number: { type: "string" },
      size: { type: "string" },
      spec_class: { type: "string" },
      service: { type: "string" },
      scale: { type: "string" },
      sheet: { type: "string" }, // e.g. "1 OF 4"
      revision: { type: "string" },
      owner_pid_no: { type: "string" }, // owner/client's own P&ID drawing number, if different from pid_no
      pid_no: { type: "string" }, // the P&ID drawing number this ISO cross-references
      owner_ga_dwg_no: { type: "string" },
      ga_dwg_no: { type: "string" }, // the GA drawing number this ISO cross-references
      design_pressure: { type: "string" }, // title block's DESIGN row, PRESS. column
      design_temperature: { type: "string" }, // title block's DESIGN row, TEMP. column
      operating_pressure: { type: "string" }, // title block's OPERATING row, PRESS. column
      operating_temperature: { type: "string" }, // title block's OPERATING row, TEMP. column
      hydrotest_pressure: { type: "string" }, // title block's HYDROTEST row, PRESS. column
      hydrotest_temperature: { type: "string" }, // title block's HYDROTEST row, TEMP. column
      painting_system: { type: "string" },
      radiograph: { type: "string" },
      test_type: { type: "string" },
      insul_spec: { type: "string" },
      insul_thickness_mm: { type: "string" },
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
