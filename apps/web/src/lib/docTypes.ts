// What kinds of document the app reads, what each is called, where each is
// uploaded, and what format each arrives in.
//
// One module, because the labels used to be copied into every page that showed a
// document and had already drifted -- and because the rules below decide what is
// read, which is not a thing to keep in two places.
//
// ---------------------------------------------------------------------------
// AN UPLOAD KIND IS NOT A DOCUMENT TYPE.
//
// Two kinds share the stored type `spec_sheet`, and the FORMAT tells them apart:
//
//   Admin Pipe Spec    XLSX   ours. The spec table a line's BOM is checked
//                             against. Uploaded on the project page.
//   Client Pipe Spec   PDF    theirs. Extracted too, so the admin spec can be
//                             checked against it. Uploaded in the library.
//
// Both are read by the same extractor and both keep their extracted data. The
// split is a rule the refinery already works to -- an admin spec is always a
// spreadsheet, a client spec always a plotted document -- so encoding it in the
// format costs no migration and reclassifies every spec already uploaded
// correctly, on the spot.
//
// The cost of doing it this way is that the distinction is IMPLIED rather than
// stored: a client spec arriving as XLSX would be taken for an admin one. If
// that ever happens, the fix is a real `client_spec` document type, which needs
// a check-constraint migration and a backfill keyed on exactly this rule.
//
// ---------------------------------------------------------------------------
// WHERE: the project page takes what is being CHECKED. The library holds what
// it is checked AGAINST -- reference that is set up once and then stops being
// thought about, unlike the ISOs, which keep arriving.
//
// "In the library" says nothing about whether a document is read. The legend
// teaches P&ID symbol reading, the line list is what every design basis is
// checked against, and the client spec is what the admin spec is checked
// against. All of them are `documents` rows and all of them are extracted.
// ---------------------------------------------------------------------------

import type { DocType } from "@easy/shared";

export interface UploadKind {
  /** The value the upload form submits, and the key everything else uses. */
  key: string;
  /** What it is STORED as. Several kinds may share one. */
  docType: DocType;
  label: string;
  /** Accepted file extensions. The first is the usual one. */
  formats: readonly string[];
  /** One sentence: what it is for, shown beside the choice. */
  hint: string;
  where: "project" | "library" | "tool";
}

export const UPLOAD_KINDS: readonly UploadKind[] = [
  {
    key: "iso",
    docType: "iso",
    label: "ISO",
    formats: ["pdf"],
    hint: "The isometrics being checked -- spools, welds, BOM and design basis are read from these.",
    where: "project",
  },
  {
    key: "admin_spec",
    docType: "spec_sheet",
    label: "Admin Pipe Spec",
    formats: ["xlsx"],
    hint: "Your own piping-class spec table, which each line's bill of material is checked against.",
    where: "project",
  },
  {
    key: "client_spec",
    docType: "spec_sheet",
    label: "Client Pipe Spec",
    formats: ["pdf"],
    hint: "The client's own piping spec. Read, so the admin spec can be checked against it.",
    where: "library",
  },
  {
    key: "pid_legend",
    docType: "pid_legend",
    label: "P&ID Legend",
    formats: ["pdf"],
    hint: "The symbol and abbreviation key. Upload it BEFORE this project's P&IDs -- they read their symbols against it.",
    where: "library",
  },
  {
    key: "pid",
    docType: "pid",
    label: "P&ID",
    formats: ["pdf"],
    hint: "Checked against each ISO's routing and in-line components.",
    where: "library",
  },
  {
    key: "pll",
    docType: "pll",
    label: "Line List (PLL)",
    formats: ["xlsx", "csv", "pdf"],
    hint: "Every ISO's design basis is checked against it.",
    where: "library",
  },
  { key: "hmb", docType: "hmb", label: "H&MB", formats: ["xlsx", "csv", "pdf"], hint: "Heat and mass balance.", where: "library" },
  { key: "pfd", docType: "pfd", label: "PFD", formats: ["pdf"], hint: "Process flow diagram.", where: "library" },
  { key: "ga", docType: "ga", label: "GA", formats: ["pdf"], hint: "General arrangement.", where: "library" },
  // Uploaded on their own pages, not from either list.
  {
    key: "hookup",
    docType: "hookup",
    label: "Hook-up typical",
    formats: ["pdf"],
    hint: "The standard installation details instruments are checked against.",
    where: "tool",
  },
  {
    key: "cutting",
    docType: "cutting",
    label: "Cutting plate",
    // A plotted PDF records the dimension figures but not the geometry -- the
    // outlines arrive exploded into disconnected dash fragments that no
    // tolerance can regroup. The DWG or DXF carries the profiles themselves,
    // which is the only way the nest can work to the real shape rather than to
    // a bounding box.
    formats: ["dwg", "dxf", "pdf"],
    hint: "The parts to nest onto stock plate.",
    where: "tool",
  },
];

export const PROJECT_UPLOAD_KINDS = UPLOAD_KINDS.filter((k) => k.where === "project");
export const LIBRARY_UPLOAD_KINDS = UPLOAD_KINDS.filter((k) => k.where === "library");

export const kindByKey = (key: string): UploadKind | undefined => UPLOAD_KINDS.find((k) => k.key === key);

export const extensionOfFile = (fileName: string): string => fileName.toLowerCase().split(".").pop() ?? "";

/**
 * Which kind a STORED document is, from what it is and what it is called.
 *
 * Where one stored type serves several kinds, the file's format decides -- that
 * is the whole admin/client split. A file whose format matches no kind falls
 * back to the first for its type, so it is still named and still listed, and
 * `formatMismatch` is what reports it as wrong.
 */
export function kindOfDocument(docType: string, fileName: string): UploadKind | undefined {
  const candidates = UPLOAD_KINDS.filter((k) => k.docType === docType);
  if (candidates.length <= 1) return candidates[0];
  const ext = extensionOfFile(fileName);
  return candidates.find((k) => k.formats.includes(ext)) ?? candidates[0];
}

/** What to call a document on screen -- the KIND, so an admin and a client spec read differently. */
export function labelForDocument(docType: string, fileName: string): string {
  return kindOfDocument(docType, fileName)?.label ?? docType;
}

/** What to call a bare document type, where no file name is to hand. */
export function labelForDocType(docType: string): string {
  return UPLOAD_KINDS.find((k) => k.docType === docType)?.label ?? docType;
}

/** Is this document reference -- listed in the library rather than on the project page? */
export function isLibraryDocument(docType: string, fileName: string): boolean {
  return kindOfDocument(docType, fileName)?.where === "library";
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
};

/** What Storage is told a file is. Unknown falls back to PDF. */
export const contentTypeOf = (fileName: string): string => MIME[extensionOfFile(fileName)] ?? "application/pdf";

/** The `accept` attribute for one kind's file input. */
export const acceptFor = (kind: UploadKind): string =>
  kind.formats.flatMap((ext) => [`.${ext}`, MIME[ext]]).filter(Boolean).join(",");

/** "XLSX" / "XLSX, CSV or PDF" -- what to print beside the file input. */
export function formatHintFor(kind: UploadKind): string {
  const upper = kind.formats.map((e) => e.toUpperCase());
  if (upper.length === 1) return upper[0];
  return `${upper.slice(0, -1).join(", ")} or ${upper[upper.length - 1]}`;
}

/**
 * Why this file cannot be uploaded as this kind, or null if it can.
 *
 * The fact AND where the file should go, because a PDF offered as an admin spec
 * is not a mistake -- it is the client's spec, which has a home of its own, and
 * "XLSX only" leaves somebody holding a document with nowhere to put it.
 */
export function uploadFormatProblem(kind: UploadKind, fileName: string): string | null {
  const ext = extensionOfFile(fileName);
  if (kind.formats.includes(ext)) return null;

  // Where another kind takes exactly this file, name it. That is the answer,
  // and it is more useful than the rule that refused them.
  const elsewhere = UPLOAD_KINDS.find((k) => k !== kind && k.formats.includes(ext) && k.docType === kind.docType);
  const fact = `${kind.label} is read from ${formatHintFor(kind)}. This is a ${ext.toUpperCase()}.`;
  if (elsewhere) {
    return `${fact} A pipe spec as a ${ext.toUpperCase()} is the ${elsewhere.label} -- upload it in this project's library, where it is read and the admin spec is checked against it.`;
  }
  return fact;
}

/**
 * Why a STORED document's file does not fit any kind of its type, or null.
 *
 * Only genuinely wrong files: a spec PDF is not one of these, it is a Client
 * Pipe Spec. Used to flag documents stored before the format rules existed.
 */
export function formatMismatch(docType: string, fileName: string): string | null {
  const ext = extensionOfFile(fileName);
  const candidates = UPLOAD_KINDS.filter((k) => k.docType === docType);
  if (candidates.length === 0 || candidates.some((k) => k.formats.includes(ext))) return null;
  const names = [...new Set(candidates.flatMap((k) => k.formats))].map((e) => e.toUpperCase());
  return `${labelForDocType(docType)} is read from ${names.join(" or ")}. This is a ${ext.toUpperCase()}.`;
}
