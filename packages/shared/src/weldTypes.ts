// What counts as a FIELD WELD, in one place.
//
// This matters more than it looks: a field weld IS a forced cut, so it ends a
// spool on sight. Anything wrongly typed FW invents a spool boundary, and on a
// sheet whose cut count then stops matching its printed spool count the whole
// sheet is thrown out rather than half-trusted.
//
// The WELD LIST table has FOUR columns -- ID, ND, Type, Category -- and the
// last two are independent:
//
//   Type      BUTTWELD | FIELDWELD | TAPWELD | THREADED | SOCKETWELD
//   Category  FABRICATION-ITEM | ERECTION-ITEM
//
// Type is what KIND of weld it is. Category is WHERE it gets made: in the shop,
// or on site during erection. A weld can be a plain BUTTWELD and still be an
// ERECTION-ITEM -- the two 80mm drain branches and the 15mm vent on sheet 2 of
// the reference ISO are exactly that, and none of them is a field weld.
//
// Conflating the two is what went wrong: the extraction prompt described the
// table as grouped into "FABRICATION-ITEM rows, then ERECTION-ITEM/FIELDWELD
// rows", as though those were one category, and the model duly returned sheet
// 2's weld 5 -- a 15mm BUTTWELD whose Category is ERECTION-ITEM -- as FW. That
// single mistyped weld produced a sixth cut on a sheet that prints six spools
// and needs five, and cost the sheet its whole assignment.

/** Category values, which are never weld types however they arrive. */
const CATEGORIES = new Set(["FABRICATION-ITEM", "FABRICATIONITEM", "ERECTION-ITEM", "ERECTIONITEM", "FABRICATION", "ERECTION"]);

/** Spellings of the field-weld TYPE actually seen: the code and the table word. */
const FIELD_WELD = new Set(["FW", "FIELDWELD", "FIELD-WELD", "FIELD WELD"]);

const norm = (value: unknown): string => String(value ?? "").trim().toUpperCase();

/**
 * Is this weld a field weld -- the forced cut that ends a spool?
 *
 * Deliberately strict about what it accepts and explicit about what it refuses.
 * A Category value reaching this field at all means the two columns were
 * confused upstream, and answering "false" is right: an erection item is not a
 * forced cut, and a weld that really is one says so in its Type.
 */
export function isFieldWeld(weldType: unknown): boolean {
  const t = norm(weldType);
  if (t === "" || CATEGORIES.has(t)) return false;
  return FIELD_WELD.has(t);
}

/** True when a value is a Category rather than a weld type, so a read can say so. */
export function isWeldCategory(value: unknown): boolean {
  return CATEGORIES.has(norm(value));
}
