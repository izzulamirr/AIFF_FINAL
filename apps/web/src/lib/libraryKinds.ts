// The library's kinds and accepted file types -- plain values with no imports.
//
// Kept apart from library.ts on purpose: that file reads the database, and the
// upload form is a client component. A client component that imports anything
// touching the database drags the Postgres driver into the browser bundle, and the
// build fails on it (`Can't resolve 'fs'`). Whatever a client component needs
// from the library belongs here.

export const LIBRARY_CATEGORIES = ["legend", "specification", "standard", "template", "datasheet", "other"] as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<LibraryCategory, string> = {
  legend: "Legend",
  specification: "Specification",
  standard: "Standard",
  template: "Template",
  datasheet: "Datasheet",
  other: "Other",
};

export const isLibraryCategory = (value: string): value is LibraryCategory => (LIBRARY_CATEGORIES as readonly string[]).includes(value);

/** Where library files sit in the "documents" bucket, apart from the drawings (which start with a project id). */
export const LIBRARY_PREFIX = "library";

// What a library can hold. Wider than what the extraction reads, since nothing
// here is read: it is kept and handed back. Executables and scripts are not on it.
export const LIBRARY_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
};

export const LIBRARY_ACCEPT = Object.keys(LIBRARY_EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(",");

export const extensionOf = (fileName: string): string => fileName.split(".").pop()?.toLowerCase() ?? "";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
