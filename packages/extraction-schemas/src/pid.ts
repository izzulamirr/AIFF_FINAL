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
    "Identifies which page(s) contain each P&ID drawing sheet, keyed by the sheet/drawing number in its title block.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sheet_number: { type: "string" },
            drawing_title: { type: "string" },
            pages: PAGE_RANGE_SCHEMA,
          },
          required: ["sheet_number", "pages"],
        },
      },
    },
    required: ["sheets"],
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
            from_equipment: { type: "string" },
            to_equipment: { type: "string" },
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
      },
      instruments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tag_number: { type: "string" },
            instrument_type: { type: "string" },
            line_or_equipment_ref: { type: "string" },
          },
          required: ["tag_number"],
        },
      },
    },
    required: ["lines"],
  },
};
