// Spec classes built straight from an admin item-list workbook, with no model call.
//
// These pin the labels the web app's type matching depends on, the DN -> NPS size
// conversion, and the cases a looser reading would get wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSpecClassesFromItemList, type SheetItem } from "@easy/shared";

const line = (type: string, description: string, material: string, sizeP1: string, extra: Partial<SheetItem> = {}): SheetItem => ({
  reference: "",
  type,
  specCode: "AC03N",
  catalogueRef: "",
  description,
  material,
  sizeP1,
  sizeP2: "",
  sizeP3: "",
  attributes: [],
  ...extra,
});

const classOf = (items: SheetItem[], fallback = "FILE") => buildSpecClassesFromItemList(items, fallback);
const attrs = (items: SheetItem[]) => classOf(items)[0].attributes as Record<string, Array<Record<string, unknown>>>;

test("one class per Spec-of code, with the four categories", () => {
  const out = classOf([
    line("TUBE", "PIPE BE SMLS", "A106 GR B, SCH40", "80"),
    line("ELBO", "ELBOW 90DEG, LR, SMLS BW", "A234 GR.WPB SCH40", "80"),
    line("FLAN", "FLANGE WN ASME B16.5 150# RF", "A105N SCH80", "80"),
    line("VALV", "GATE VALVE, 150# RF", "", "80"),
    line("TUBE", "PIPE BE SMLS", "A106 GR B, SCH20", "200", { specCode: "BC70N" }),
  ]);
  assert.deepEqual(out.map((c) => c.class_code).sort(), ["AC03N", "BC70N"]);
  const a = out.find((c) => c.class_code === "AC03N")!.attributes as Record<string, unknown[]>;
  assert.equal(a.pipes.length, 1);
  assert.equal(a.fittings.length, 1);
  assert.equal(a.flanges.length, 1);
  assert.equal(a.valves.length, 1);
});

test("a size in DN millimetres becomes the NPS inches the client spec uses", () => {
  const a = attrs([line("TUBE", "PIPE", "SCH40", "15"), line("TUBE", "PIPE", "SCH40", "40"), line("TUBE", "PIPE", "SCH40", "200")]);
  assert.deepEqual(a.pipes.map((r) => r.size_min), ["1/2", "1 1/2", "8"]);
  assert.equal(a.pipes[0].size_max, "1/2");
});

test("rows carry the labels the cross-check looks for", () => {
  const a = attrs([
    line("ELBO", "ELBOW 90DEG", "", "80"),
    line("TEE", "EQUAL TEE", "", "80"),
    line("TEE", "REDUCING TEE", "", "80"),
    line("REDU", "REDU CONC", "", "80"),
    line("OLET", "WELDOLET BW", "", "200", { sizeP3: "80" }),
    line("FBLI", "FLANGE BLIND 150# RF", "", "80"),
    line("PCOM", "SPECTACLE BLIND 150# RF", "", "200"),
    line("PCOM", "SPADE & SPACER 150# RF", "", "200"),
    line("FLAN", "FLANGE ORIFICE WN 300# RF", "", "200"),
    line("GASK", "GASKET, SPIRAL WD, 150# RF", "", "80"),
  ]);
  const labels = a.fittings.map((r) => r.fitting_type).concat(a.flanges.map((r) => r.flange_type));
  for (const want of [
    "Elbow",
    "Tee (Straight)",
    "Tee (Reduced)",
    "Reducer (Concentric/Eccentric)",
    "O'let (Weldolet)",
    "Blind flange",
    "Spectacle blind",
    "Spade & Spacer",
    "Orifice Flanges",
    "Gasket",
  ]) {
    assert.ok(labels.includes(want), `missing label ${want}`);
  }
});

test("a weldolet keeps its run size as the size and its branch beside it", () => {
  const a = attrs([line("OLET", "WELDOLET BW", "A105N SCH20xSCH80", "200", { sizeP3: "80" })]);
  assert.equal(a.fittings[0].size_min, "8");
  assert.equal(a.fittings[0].branch_size, "3");
  assert.equal(a.fittings[0].schedule, "20 x 80");
});

test("a valve is named by the body type it leads with", () => {
  const a = attrs([
    line("VALV", "CHECK VALVE, BALL LIFT TYPE, 300# RF", "", "80"),
    line("VALV", "BALL VALVE, RB, 150# RF", "", "80"),
    line("VALV", "PLUG VALVE, 150# RF", "", "80"),
  ]);
  const types = a.valves.map((r) => r.valve_type).sort();
  assert.deepEqual(types, ["Ball", "Check", "Valve"]);
});

test("a flange or valve carries its pressure class, a pipe its schedule", () => {
  const a = attrs([line("FLAN", "FLANGE WN 300# RF", "A105N SCH80", "80"), line("TUBE", "PIPE", "A106 GR B, SCH40", "80")]);
  assert.equal(a.flanges[0].class, "300");
  assert.equal(a.pipes[0].schedule, "40");
});

test("lines with no Spec-of go under the file's own class", () => {
  const out = classOf([line("TUBE", "PIPE", "SCH40", "80", { specCode: "" })], "1C1F");
  assert.equal(out[0].class_code, "1C1F");
});

test("things that are not part of a piping class are left out", () => {
  const out = classOf([line("ATTA", "PIPE SUPPORT", "", "200"), line("WELD", "FIELD WELD", "", "200"), line("INST", "INSTRUMENT", "", "15")]);
  assert.equal(out.length, 0);
});

test("identical lines are one row, and rows come out in size order", () => {
  const a = attrs([line("TUBE", "PIPE", "SCH40", "200"), line("TUBE", "PIPE", "SCH40", "15"), line("TUBE", "PIPE", "SCH40", "15")]);
  assert.equal(a.pipes.length, 2);
  assert.deepEqual(a.pipes.map((r) => r.size_min), ["1/2", "8"]);
});

test("a size that is not a standard DN is left off rather than guessed", () => {
  const a = attrs([line("TUBE", "PIPE", "SCH40", "77")]);
  assert.equal(a.pipes[0].size_min, undefined);
});
