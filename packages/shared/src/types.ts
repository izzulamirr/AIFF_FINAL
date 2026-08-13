// 'hookup' is a typical instrument hook-up drawing: the standard assembly
// connecting an instrument to the process (tap, root valve, tubing,
// manifold), issued as a set of sheets keyed by measured variable and
// service. A P&ID simplifies all of that to a bubble, so the hookup sheet is
// what says which components a shop drawing must actually show.
export const DOC_TYPES = ["pid", "hmb", "pfd", "spec_sheet", "iso", "ga", "pll", "pid_legend", "hookup"] as const;
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
// 'spool' and 'weld' rows come from a spooled (fabrication-issued) ISO.
// A spool is a shop-prefabricated section of the line, keyed by its spool
// number (the line number plus a -NN suffix); a weld is one joint marked on
// the drawing by an SW/FW diamond, keyed by its weld number. Both are
// per-drawing fabrication data, not cross-document tags -- they are what the
// weld count and spool list are derived from.
// 'hookup_item' rows come from a hook-up typical's bill of materials, keyed
// by the sheet's item number. Each carries the discipline that supplies it,
// which is the whole point: only the piping-scope items are checkable
// against an ISO.
export const TAG_TYPES = ["line", "equipment", "instrument", "valve", "stream", "spec_class", "bom_item", "support", "legend_item", "fitting", "spool", "weld", "hookup_item"] as const;

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
