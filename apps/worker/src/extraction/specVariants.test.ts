// Which variant an admin item-list line is -- 90 or 45 degree elbow, eccentric
// or concentric reducer, straight or reduced tee -- read from its own text.
//
// These pin the rule on wording the admin export actually uses ("REDU CONC",
// "ELBOW 90DEG, LR") and on the near-misses that would break a looser reading.
import test from "node:test";
import assert from "node:assert/strict";
import { adminVariant } from "@easy/shared";

const line = (type: string, description: string, material = "") => ({ type, description, material });

test("an elbow is told apart by its angle", () => {
  assert.equal(adminVariant(line("ELBO", "ELBOW 90DEG, LR, SMLS, ASME B16.9 BW"))?.label, "90°");
  assert.equal(adminVariant(line("ELBO", "ELBOW 45 DEG, LR, SMLS"))?.label, "45°");
  assert.equal(adminVariant(line("ELBO", "ELBOW 45-DEG"))?.label, "45°");
  assert.equal(adminVariant(line("ELBO", "ELBOW 90°"))?.label, "90°");
});

test("a 90 degree elbow sorts ahead of a 45", () => {
  const a = adminVariant(line("ELBO", "ELBOW 90DEG"))!;
  const b = adminVariant(line("ELBO", "ELBOW 45DEG"))!;
  assert.ok(a.order < b.order);
});

test("a rating or a schedule is not an angle", () => {
  // "150# RF" and "SCH80" both carry two-and-three digit numbers.
  assert.equal(adminVariant(line("ELBO", "ELBOW LR 150# RF SCH80 SMLS"))?.label, "Not stated");
});

test("a reducer is eccentric or concentric", () => {
  assert.equal(adminVariant(line("REDU", "REDU ECC, SMLS, BW"))?.label, "Eccentric (RE)");
  assert.equal(adminVariant(line("REDU", "REDU CONC, SMLS, BW"))?.label, "Concentric (RC)");
  assert.equal(adminVariant(line("REDU", "REDUCER, ECCENTRIC"))?.label, "Eccentric (RE)");
  assert.equal(adminVariant(line("REDU", "REDUCER, CONCENTRIC"))?.label, "Concentric (RC)");
});

test("the spec's own RE / RC codes count, but only when no word did", () => {
  assert.equal(adminVariant(line("REDU", "REDUCER RE, SMLS"))?.label, "Eccentric (RE)");
  assert.equal(adminVariant(line("REDU", "REDUCER RC, SMLS"))?.label, "Concentric (RC)");
  // A word wins over a code sitting earlier in the text.
  assert.equal(adminVariant(line("REDU", "RC 4 X 3 CONCENTRIC"))?.label, "Concentric (RC)");
});

test("where a line names two variants the earlier one is the component", () => {
  assert.equal(adminVariant(line("REDU", "REDU CONC, ECC TRANSITION"))?.label, "Concentric (RC)");
});

test("a tee is straight or reduced", () => {
  assert.equal(adminVariant(line("TEE", "EQUAL TEE, SMLS"))?.label, "Straight");
  assert.equal(adminVariant(line("TEE", "STRAIGHT TEE"))?.label, "Straight");
  assert.equal(adminVariant(line("TEE", "REDUCING TEE, SMLS"))?.label, "Reduced");
  assert.equal(adminVariant(line("TEE", "TEE, REDUCED"))?.label, "Reduced");
});

test("a line that names no variant is still counted, as not stated", () => {
  // null would drop it from the split and quietly lose it from the totals.
  assert.equal(adminVariant(line("REDU", "REDUCER, SMLS, BW"))?.label, "Not stated");
  assert.equal(adminVariant(line("TEE", "TEE, SMLS"))?.label, "Not stated");
});

test("anything that is not an elbow, reducer or tee has no variants", () => {
  assert.equal(adminVariant(line("VALV", "BALL VALVE 90DEG")), null);
  assert.equal(adminVariant(line("FLAN", "FLANGE WN 150# RF")), null);
  assert.equal(adminVariant(line("TUBE", "PIPE BE EFW")), null);
});

test("the material text and catalogue reference are read too", () => {
  assert.equal(adminVariant(line("REDU", "REDUCER", "A234 GR WPB CONC"))?.label, "Concentric (RC)");
  assert.equal(adminVariant({ type: "ELBO", description: "", material: "", catalogueRef: "ELBOW-90DEG-LR" })?.label, "90°");
});
