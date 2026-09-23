// A BOM item that names a specific material belongs to the class whose spec
// carries that material -- see packages/shared/src/specEvidence.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { classByMaterialEvidence, materialMarkers } from "@easy/shared";

const CLAD_PIPE =
  "PIPE BE SMLS ASME B36.10, A106 GR B, NACE MR0175/ISO 15156, + 3MM ALLOY 625 CLAD PIPE BE SMLS ASME B36.10, A106 GR B, NACE MR0175/ISO 15156, SCH20";

test("the specific materials an item names are read, and plain grades are not", () => {
  assert.deepEqual(materialMarkers(CLAD_PIPE).sort(), ["ALLOY625", "CLAD"]);
  assert.deepEqual(materialMarkers("PIPE BE SMLS ASME B36.10, A106 GR B, SCH40"), []);
  assert.deepEqual(materialMarkers("CHECK VALVE, A216 WCB BODY+ALLOY 625 WELD OVERLAY BODY").sort(), ["ALLOY625", "OVERLAY"]);
});

test("a clad pipe moves to the class whose spec says clad, off the class it was placed in", () => {
  const moved = classByMaterialEvidence(CLAD_PIPE, "AC03N", [
    { code: "AC03N", specText: "A106 Gr.B, SMLS" },
    { code: "BC70N", specText: "A106 Gr.B + 3mm Alloy 625 clad, SMLS" },
  ]);
  assert.equal(moved?.code, "BC70N");
  assert.deepEqual(moved?.markers.sort(), ["ALLOY625", "CLAD"]);
});

test("an item that names no specific material is left where it is", () => {
  assert.equal(
    classByMaterialEvidence("PIPE BE SMLS ASME B36.10, A106 GR B, SCH40", "AC03N", [
      { code: "AC03N", specText: "A106 Gr.B, SMLS" },
      { code: "BC70N", specText: "A106 Gr.B + 3mm Alloy 625 clad" },
    ]),
    null
  );
});

test("nothing moves when the other class's spec does not carry the material either", () => {
  assert.equal(
    classByMaterialEvidence(CLAD_PIPE, "AC03N", [
      { code: "AC03N", specText: "A106 Gr.B, SMLS" },
      { code: "BC70N", specText: "A106 Gr.B, SMLS" },
    ]),
    null
  );
});

test("an item already in the class that carries the material stays", () => {
  assert.equal(
    classByMaterialEvidence(CLAD_PIPE, "BC70N", [
      { code: "AC03N", specText: "A106 Gr.B, SMLS" },
      { code: "BC70N", specText: "A106 Gr.B + 3mm Alloy 625 clad" },
    ]),
    null
  );
});

test("a tie between two classes changes nothing", () => {
  assert.equal(
    classByMaterialEvidence(CLAD_PIPE, "AC03N", [
      { code: "AC03N", specText: "carbon steel" },
      { code: "BC70N", specText: "Alloy 625 clad" },
      { code: "BC71N", specText: "Alloy 625 clad" },
    ]),
    null
  );
});

test("a class with no matching row offers no evidence", () => {
  assert.equal(
    classByMaterialEvidence(CLAD_PIPE, "AC03N", [
      { code: "AC03N", specText: "A106 Gr.B" },
      { code: "BC70N", specText: null },
    ]),
    null
  );
});

test("an unassigned item is placed by the material it names", () => {
  assert.equal(
    classByMaterialEvidence(CLAD_PIPE, "Unassigned", [
      { code: "AC03N", specText: "A106 Gr.B" },
      { code: "BC70N", specText: "Alloy 625 clad" },
    ])?.code,
    "BC70N"
  );
});

test("punctuation and spacing in the material do not matter", () => {
  assert.equal(
    classByMaterialEvidence("PIPE, ALLOY-625 CLAD", "AC03N", [
      { code: "AC03N", specText: "" },
      { code: "BC70N", specText: "alloy 625 cladding" },
    ])?.code,
    "BC70N"
  );
});
