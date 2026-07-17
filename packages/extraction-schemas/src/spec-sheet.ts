import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Same proven shape as AIFF's electron/specExtraction.js: locate the Class
// Index, then per-class detail pages, then branch tables; extract each
// separately. Reused here as a *pattern*, not copied code.
export const LOCATE_SPEC_SECTIONS_TOOL: ClaudeTool = {
  name: "locate_spec_sections",
  description:
    "Identifies which page ranges contain the Piping Class Index, each class's detailed datasheet, and the branch tables in this Piping Material Specification document.",
  input_schema: {
    type: "object",
    properties: {
      class_index_pages: PAGE_RANGE_SCHEMA,
      classes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            class_code: { type: "string" },
            detail_pages: PAGE_RANGE_SCHEMA,
          },
          required: ["class_code", "detail_pages"],
        },
      },
      branch_table_pages: PAGE_RANGE_SCHEMA,
    },
    required: ["classes"],
  },
};

export const SPEC_CLASS_INDEX_TOOL: ClaudeTool = {
  name: "record_class_index",
  description: "Records the Piping Class Index / summary table rows.",
  input_schema: {
    type: "object",
    properties: {
      classes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            class_code: { type: "string" },
            service: { type: "string" },
            size_min: { type: "string" },
            size_max: { type: "string" },
            material: { type: "string" },
            corrosion_allowance: { type: "string" },
            design_code: { type: "string" },
            nace_sour_service: { type: "boolean" },
            max_pressure: { type: "string" },
            temp_range: { type: "string" },
            asme_class: { type: "string" },
            flange_facing: { type: "string" },
            gasket_type: { type: "string" },
            stud_bolts: { type: "string" },
            nde_extent: { type: "string" },
            pwht_required: { type: "boolean" },
            remarks: { type: "string" },
          },
          required: ["class_code"],
        },
      },
    },
    required: ["classes"],
  },
};

export const SPEC_CLASS_DETAIL_TOOL: ClaudeTool = {
  name: "record_class_detail",
  description: "Records the per-size-range pipe/fitting/flange/valve rows for a single piping class's detailed datasheet.",
  input_schema: {
    type: "object",
    properties: {
      pipes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            size_min: { type: "string" },
            size_max: { type: "string" },
            schedule: { type: "string" },
            end_type: { type: "string" },
            material: { type: "string" },
            item_code: { type: "string" }, // this row's own item/component code, if the spec sheet lists one (e.g. "P9610-C") -- an ISO's BOM references these
          },
        },
      },
      fittings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fitting_type: { type: "string" },
            size_min: { type: "string" },
            size_max: { type: "string" },
            material: { type: "string" },
            end_type: { type: "string" },
            item_code: { type: "string" },
          },
        },
      },
      flanges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            flange_type: { type: "string" },
            size_min: { type: "string" },
            size_max: { type: "string" },
            facing: { type: "string" },
            material: { type: "string" },
            gasket_type: { type: "string" },
            stud_bolts: { type: "string" },
            item_code: { type: "string" },
          },
        },
      },
      valves: {
        type: "array",
        items: {
          type: "object",
          properties: {
            valve_type: { type: "string" },
            size_min: { type: "string" },
            size_max: { type: "string" },
            description: { type: "string" },
            valve_index_code: { type: "string" },
          },
        },
      },
    },
  },
};

export const SPEC_BRANCH_TABLES_TOOL: ClaudeTool = {
  name: "record_branch_tables",
  description: "Records the branch table matrix rows (e.g. Types T2/T3/T4/T6).",
  input_schema: {
    type: "object",
    properties: {
      branch_tables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            branch_type: { type: "string" },
            header_size: { type: "string" },
            branch_size: { type: "string" },
            fitting_type: { type: "string" },
          },
          required: ["branch_type", "header_size", "branch_size"],
        },
      },
    },
    required: ["branch_tables"],
  },
};
