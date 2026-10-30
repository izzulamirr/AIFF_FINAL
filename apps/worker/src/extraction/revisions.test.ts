import test from "node:test";
import assert from "node:assert/strict";
import { currentDocuments, documentFamily, resolveDocumentVersions, revisionFromFileName } from "@easy/shared";

let n = 0;
const doc = (docType: string, fileName: string, uploaded: string) => ({ id: `d${++n}`, docType, fileName, uploadedAt: new Date(uploaded) });

test("reads the revision off the end of a file name", () => {
  assert.equal(revisionFromFileName("8015-0152-CP05-22-214-PC-PD-04002_E.pdf")?.revision, "E");
  assert.equal(revisionFromFileName("PACE-P001-EXE-MESB-0000-PRO-LST-0001_A_NEW.xlsx")?.revision, "A");
  assert.equal(revisionFromFileName("PACE-P001-EXE-MESB-3000-PRO-PID-0010.pdf"), null);
  assert.equal(revisionFromFileName("AC03N.pdf"), null);
});

test("a copy marker and the case do not make a different document", () => {
  assert.equal(documentFamily("spec_sheet", "AC03U_corrected (3).xlsx"), documentFamily("spec_sheet", "AC03U_corrected.xlsx"));
  assert.equal(documentFamily("pid", "X-PD-04002_D.pdf"), documentFamily("pid", "x-pd-04002_E.PDF"));
});

test("a client spec and an admin item list sharing a name stay separate", () => {
  assert.notEqual(documentFamily("spec_sheet", "AC03N.pdf"), documentFamily("spec_sheet", "AC03N.xlsx"));
});

test("the higher revision in the name is current, whichever was uploaded last", () => {
  const e = doc("pid", "8015-0152-CP05-22-214-PC-PD-04002_E.pdf", "2026-10-29");
  const d = doc("pid", "8015-0152-CP05-22-214-PC-PD-04002_D.pdf", "2026-10-30");
  const v = resolveDocumentVersions([d, e]);
  assert.equal(v.get(e.id)?.current, true);
  assert.equal(v.get(d.id)?.current, false);
  assert.equal(v.get(d.id)?.supersededBy, e.id);
  assert.equal(v.get(d.id)?.orderedBy, "the revision in the file name");
});

test("the same name uploaded again is a new revision: the latest upload is current", () => {
  const old = doc("pll", "22-214.xlsx", "2026-08-04");
  const mid = doc("pll", "22-214.xlsx", "2026-08-10");
  const latest = doc("pll", "22-214.xlsx", "2026-09-24");
  assert.deepEqual(currentDocuments([old, latest, mid]), [latest]);
  assert.equal(resolveDocumentVersions([old, mid, latest]).get(old.id)?.orderedBy, "upload date");
});

test("letter against number cannot be ordered by name, so the upload date decides", () => {
  const letter = doc("pid", "X-PD-04002_D.pdf", "2026-10-01");
  const number = doc("pid", "X-PD-04002_1.pdf", "2026-10-05");
  assert.deepEqual(currentDocuments([letter, number]), [number]);
});

test("different documents, and a document alone, are all current", () => {
  const a = doc("pid", "8015-0152-CP05-22-214-PC-PD-04002_D.pdf", "2026-10-27");
  const b = doc("pid", "8015-0152-CP05-22-411-PC-PD-04010_D.pdf", "2026-07-14");
  const c = doc("hookup", "INSTRUMENT HOOKUP.pdf", "2026-08-12");
  assert.deepEqual(currentDocuments([a, b, c]), [a, b, c]);
  assert.equal(resolveDocumentVersions([a]).get(a.id)?.orderedBy, null);
});

test("an ISO's revision comes from the drawing, not its name", () => {
  const a = doc("iso", "18-22-214-01-CRD-0005-AC03N-P-01.pdf", "2026-10-27");
  const b = doc("iso", "18-22-214-01-CRD-0005-AC03N-P.pdf", "2026-10-29");
  const known = new Map([
    [a.id, { revision: "A", current: false }],
    [b.id, { revision: "B", current: true }],
  ]);
  assert.deepEqual(currentDocuments([a, b], known), [b]);
  assert.equal(resolveDocumentVersions([a, b], known).get(b.id)?.revision, "B");
});
