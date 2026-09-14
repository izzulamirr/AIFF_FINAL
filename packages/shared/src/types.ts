// 'hookup' is a typical instrument hook-up drawing: the standard assembly
// connecting an instrument to the process (tap, root valve, tubing,
// manifold), issued as a set of sheets keyed by measured variable and
// service. A P&ID simplifies all of that to a bubble, so the hookup sheet is
// what says which components a shop drawing must actually show.
//
// 'cutting' is a cutting-plate drawing: the plate parts of a job drawn to
// scale in model space, each dimensioned inside its own box, to be cut from
// sheet. It carries no line number and joins to nothing -- it is an input to
// the nesting plan, not to cross-document correlation.
export const DOC_TYPES = ["pid", "hmb", "pfd", "spec_sheet", "iso", "ga", "pll", "pid_legend", "hookup", "cutting"] as const;
export type DocType = (typeof DOC_TYPES)[number];

// 'spec_class' is a special case: spec sheets define rules keyed by class
// code (e.g. "A1A"), not physical tags -- P&ID/PFD lines carry a spec_class
// field that joins against this during rule evaluation, rather than an
// exact tag_number match like the other tag types use.
//
// 'bom_item' rows come from an ISO's Bill of Material (keyed by item_no, not
// cross-document-correlated by tag number -- they're checked against their
// referenced spec_class instead, see lib/verifyIso.ts). 'support' rows come
// from a GA's pipe support schedule (keyed by support_tag). 'legend_item'
// rows come from a P&ID's legend/symbols/abbreviations sheet -- keyed by
// the symbol or abbreviation itself, not a physical tag.
// 'fitting' rows are untagged inline piping symbols drawn on a P&ID line
// (flange pairs, blinds, reducers, expansion joints, strainers...) -- keyed
// by their fitting type, referenced to a line via attributes.line_number.
//
// 'cut_item' rows come from a cutting-plate drawing -- one plate part, keyed
// by its part mark, carrying the bounding box the nest has to reserve for it.
// 'hookup_item' rows come from a hook-up typical's bill of materials, keyed
// by the sheet's item number. Each carries the discipline that supplies it,
// which is the whole point: only the piping-scope items are checkable
// against an ISO.
//
// 'spool' rows are keyed by the tag printed in the sheet's own "PIPE SPOOLS"
// schedule (e.g. "...-N-04") -- a spool is a shop-fabricated section of an
// ISO's run, bounded by a valve flanged on both sides (the only real
// disassembly point) or by a forced field-weld cut when the welded run would
// exceed the max spool length; a branch takeoff rides along inside whichever
// spool contains it rather than getting one of its own. The model is never
// asked to group a whole sheet's welds into spools directly -- each weld
// answers two small local questions instead (which weld comes before it, and
// whether a spool ends at it), and buildSpoolsFromWeldTopology in
// @easy/shared's spoolRules walks those per-weld answers into spools. See
// welds.comes_after_weld/closes_spool in packages/extraction-schemas/src/iso.ts
// for the full rule as given to the model.
// 'weld' rows are one joint marked on the drawing, keyed by its WELD LIST ID
// number. Its spool_no attribute is joined from that same walk, not computed
// from geometry -- see extractIsoDocument in apps/worker/src/extraction/iso.ts.
export const TAG_TYPES = ["line", "equipment", "instrument", "valve", "stream", "spec_class", "bom_item", "support", "legend_item", "fitting", "spool", "weld", "hookup_item", "cut_item"] as const;

// Which discipline supplies a hook-up component. Read from the drawn
// "BY PIPING | BY INSTR." break where the sheet marks one; otherwise decided
// by the rule that piping owns the tap, the root/isolation valve and
// anything welded to the line, and instrumentation owns the tubing,
// connectors and manifold from there on.
export const HOOKUP_DISCIPLINES = ["piping", "instrument", "undetermined"] as const;
export type HookupDiscipline = (typeof HOOKUP_DISCIPLINES)[number];
export type TagType = (typeof TAG_TYPES)[number];

export const ORG_ROLES = ["owner", "admin", "reviewer", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const FINDING_STATUSES = ["open", "investigating", "resolved", "false_positive"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const SEVERITIES = ["error", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const EXTRACTION_JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type ExtractionJobStatus = (typeof EXTRACTION_JOB_STATUSES)[number];

export interface ExtractionProgressEvent {
  phase: string; // e.g. 'locate_sections' | 'sheet_3_of_12' | 'merge'
  current: number;
  total: number;
  detail?: string;
}
