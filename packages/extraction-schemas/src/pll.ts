import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Process Line List (PLL): the authoritative per-line register -- gate 1
// and gate 2 of the ISO verification chain check every ISO against it
// (line existence, then design basis). Usually a genuine multi-page table
// with a real text layer, so text extraction is the primary path (unlike
// ISOs, which are vector CAD exports).
export const LOCATE_PLL_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_pll_sections",
  description: "Identifies the page range(s) containing the process line list table in this document.",
  input_schema: {
    type: "object",
    properties: {
      line_table_pages: PAGE_RANGE_SCHEMA,
    },
    required: ["line_table_pages"],
  },
};

export const PLL_TABLE_TOOL: ClaudeTool = {
  name: "record_pll_table",
  description: "Records per-line rows from a process line list table.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_number: { type: "string" },
            fluid_code: { type: "string" },
            size: { type: "string" },
            spec_class: { type: "string" }, // piping class, e.g. "150JY11"
            insulation_code: { type: "string" },
            insulation_thickness: { type: "string" },
            from_location: { type: "string" },
            to_location: { type: "string" },
            design_pressure: { type: "string" },
            design_temperature: { type: "string" },
            operating_pressure: { type: "string" },
            operating_temperature: { type: "string" },
            test_pressure: { type: "string" },
            test_medium: { type: "string" },
            service: { type: "string" },
            ndt_percent: { type: "string" },
            pwht: { type: "string" },
            paint_system: { type: "string" },
            corrosion_allowance: { type: "string" },
            pid_no: { type: "string" },
          },
          required: ["line_number"],
        },
      },
    },
    required: ["lines"],
  },
};
