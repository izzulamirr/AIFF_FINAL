import { PAGE_RANGE_SCHEMA, type ClaudeTool } from "./common";

// Cutting-plate drawings: the plate parts of a job laid out in CAD model
// space, each drawn to scale, dimensioned, and labelled with its part mark.
// They are not a table -- there is no bill of materials to read down. Each
// part is a drawn outline with its dimensions strung around it, so the
// extraction is a reading of the geometry, not of a schedule.
//
// WHY THIS IS A VISION EXTRACTION, not a text or vector one. On a real
// cutting sheet plotted from AutoCAD model space the only PDF text is the
// dimension figures; the part marks are drawn in a CAD stroke font, i.e. as
// line work, and never appear in the text layer. The outlines themselves are
// plotted in a dashed linetype, which the PDF stores as thousands of
// individual dash segments with no closed path anywhere -- reassembling them
// into a profile means bridging gaps as large as the spacing between separate
// entities, which merges parts into their own dimension lines. So the
// drawing is read as a picture, and what is asked for is the one thing a
// cutting sheet always states unambiguously: each part's mark and the
// dimensioned BOX it is drawn inside.
export const LOCATE_CUTTING_SHEETS_TOOL: ClaudeTool = {
  name: "locate_cutting_sheets",
  description:
    "Identifies each cutting-plate SHEET in this document -- one entry per sheet, never one entry covering several. " +
    "A cutting sheet shows plate parts drawn to scale with dimensions and part marks. Give every sheet its own single-page range. " +
    "Never return an empty list: a document uploaded as a cutting plate drawing has at least one sheet.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            drawing_number: { type: "string" },
            sheet: { type: "string", description: 'The title block sheet field for THIS sheet, e.g. "2/5". Blank if the sheet has no title block.' },
            title: { type: "string", description: 'The drawing title as printed, e.g. "CUTTING PLATE".' },
            pages: PAGE_RANGE_SCHEMA,
          },
          required: ["pages"],
        },
      },
    },
    required: ["sheets"],
  },
};

export const CUTTING_ITEMS_TOOL: ClaudeTool = {
  name: "record_cutting_items",
  description:
    "Records every plate part drawn on one cutting sheet: its part mark, the overall size of the box it is dimensioned inside, " +
    "and its plate thickness and material where the drawing states them. These sizes are what the nesting plan reserves on the " +
    "plate, so they must be the sizes the drawing prints -- never estimated off the picture.",
  input_schema: {
    type: "object",
    properties: {
      drawing_number: { type: "string" },
      sheet: { type: "string" },
      revision: { type: "string" },
      title: { type: "string", description: "The drawing title as printed." },
      plate_size: {
        type: "string",
        description:
          'The STOCK PLATE the parts are to be cut from, exactly as the drawing prints it. Cutting sheets state this in the title '
          + 'block or a note, e.g. "PLATE SIZE : PL 50mm X 3000mm X 12000mm". Capture the whole string. This is the single most '
          + "useful thing on the sheet after the parts themselves: it is what the nesting plan buys, and without it a planner has to "
          + "guess the stock. Blank only if the drawing genuinely states no plate size.",
      },
      plate_length_mm: { type: "number", description: "The LONGEST of the three figures in the plate size, in mm -- the plate length (e.g. 12000)." },
      plate_width_mm: { type: "number", description: "The middle figure, in mm -- the plate width (e.g. 3000)." },
      plate_thickness: {
        type: "string",
        description:
          'Plate thickness for the whole sheet, if the drawing states one anywhere -- a title-block note, a general note ' +
          '("ALL PLATES 12 THK"), or a material callout. Include the unit as printed. Blank if the sheet never states a thickness: ' +
          "that is normal on a model-space cutting plot and is not something to infer from the part marks.",
      },
      material: {
        type: "string",
        description: 'Plate grade for the whole sheet if stated, e.g. "A516 GR.70", "S275JR". Blank if the sheet does not state one.',
      },
      units: {
        type: "string",
        description:
          'The unit the dimension figures are in, as the drawing declares it -- normally "mm". Say "mm" only if the drawing ' +
          "supports it (a note, a title block, or figures in the thousands for a part metres across). Never guess between mm and inches.",
      },
      parts: {
        type: "array",
        description:
          "One entry per plate part drawn on the sheet. Count them off the drawing and record EVERY one, including the small " +
          "parts tucked between the large ones -- a part left out is a part that never gets cut. Two parts with the same mark " +
          "drawn twice are ONE part with quantity 2.",
        items: {
          type: "object",
          properties: {
            part_mark: {
              type: "string",
              description:
                'The part mark lettered on or beside the part, exactly as drawn, e.g. "BT1A-0107-6-1001", "BMA-6250-4-1004". ' +
                "It is drawn in a CAD stroke font and is often rotated 90 degrees to read up the part -- read it anyway. " +
                "Leave blank ONLY for a part that genuinely carries no mark.",
            },
            length_mm: {
              type: "number",
              description:
                "The LONGER side of the part's overall bounding box, in mm, TAKEN FROM THE PRINTED DIMENSION FIGURE. " +
                "A cutting sheet dimensions each part across the full extent of a box drawn round it -- that box, and the two " +
                "figures on its sides, is what this asks for. Where the extreme dimension is printed as a chain of figures " +
                "along one side, the overall is their sum, and it is usually also printed as its own overall figure -- prefer the " +
                "printed overall. Do not measure off the image and do not round.",
            },
            width_mm: { type: "number", description: "The SHORTER side of the same bounding box, in mm, from the printed dimension figure." },
            shape: {
              type: "string",
              description:
                'What the part is: "rectangle" for a plain rectangular plate, "circle" for a disc or ring (give its diameter as ' +
                'BOTH length_mm and width_mm), "profile" for anything cut to an irregular outline -- a gusset with a radius bitten ' +
                "out of it, a wedge, a lug, an arm. Most parts on a cutting sheet are profiles; call a part a rectangle only when " +
                "its outline really is four straight sides.",
            },
            thickness_mm: {
              type: "number",
              description:
                "This part's plate thickness in mm where the drawing states it against THIS part. Leave blank if it does not -- " +
                "the part mark is not a thickness, however much a digit inside it may look like one.",
            },
            material: { type: "string", description: "This part's plate grade where stated against this part. Blank otherwise." },
            quantity: {
              type: "integer",
              description:
                'How many of this part the sheet calls for. Use the printed quantity if there is one ("2 OFF", "QTY 4"). ' +
                "If the sheet prints no quantity, it is 1 per time the part is drawn -- do not invent a higher count.",
            },
            grain_direction: {
              type: "string",
              description:
                "Any rolling/grain direction called out for this part, as printed. A part with one CANNOT be turned in the nest. " +
                "Blank where the drawing calls out none, which is the normal case.",
            },
            dimension_figures: {
              type: "array",
              description:
                "Every dimension figure printed around this part, exactly as printed and including the diameter symbol where " +
                'there is one ("2318.55", "Ø438.79", "50.40"). This is the audit trail for the two sizes above -- a reviewer ' +
                "checks the box size against these rather than against the picture.",
              items: { type: "string" },
            },
          },
          required: ["length_mm", "width_mm"],
        },
      },
      notes: {
        type: "array",
        description: "Any general notes printed on the sheet, as printed, in order.",
        items: { type: "string" },
      },
    },
    required: ["parts"],
  },
};
