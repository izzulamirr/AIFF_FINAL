import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ISO_FRAME, directionAngles, pageAngleOf, plantAxis, plantBearing, plantDirection, type IsoFrame } from "@easy/shared";

// Page angles run CLOCKWISE from "right", because page y runs DOWN:
// 0 right, 90 down, 180 left, 270 up.

test("vertical on the page is UP or DOWN, and needs no north arrow", () => {
  // The one axis an isometric never tilts, so it is the same under any frame.
  for (const frame of [DEFAULT_ISO_FRAME, { northPageDeg: 30, eastIsClockwise: false }, { northPageDeg: 150, eastIsClockwise: true }]) {
    assert.equal(plantDirection(270, frame), "UP");
    assert.equal(plantDirection(90, frame), "DOWN");
    assert.equal(plantAxis(90, frame), "UP-DOWN");
  }
});

test("the north arrow fixes which drawn axis is N-S and which is E-W", () => {
  const northDownLeft: IsoFrame = { northPageDeg: 210, eastIsClockwise: true };
  assert.equal(plantDirection(210, northDownLeft), "N");
  assert.equal(plantDirection(30, northDownLeft), "S");
  assert.equal(plantAxis(30, northDownLeft), "N-S");
  assert.equal(plantAxis(150, northDownLeft), "E-W");

  // Turn the arrow onto the other drawn axis and the two swap over.
  const northUpLeft: IsoFrame = { northPageDeg: 150, eastIsClockwise: true };
  assert.equal(plantAxis(150, northUpLeft), "N-S");
  assert.equal(plantAxis(30, northUpLeft), "E-W");
});

test("the horizontal rays are N, E, S, W around the page -- never vertical", () => {
  // north-120 would land on the elevation axis, which no horizontal run can
  // occupy; the E/W pair is north+120 and north+300.
  for (const north of [30, 150, 210, 330]) {
    for (const eastIsClockwise of [true, false]) {
      const a = directionAngles({ northPageDeg: north, eastIsClockwise });
      assert.notEqual(a.E, 270, `north ${north} cw=${eastIsClockwise}: east cannot be straight up`);
      assert.notEqual(a.E, 90, `north ${north} cw=${eastIsClockwise}: east cannot be straight down`);
      assert.equal(Math.abs(a.E - a.W) % 180, 0, "east and west are opposite");
    }
  }
});

test("handedness decides EAST from WEST, and nothing else", () => {
  const cw: IsoFrame = { northPageDeg: 210, eastIsClockwise: true };
  const ccw: IsoFrame = { northPageDeg: 210, eastIsClockwise: false };
  assert.equal(plantDirection(330, cw), "E");
  assert.equal(plantDirection(330, ccw), "W");
  assert.equal(plantDirection(150, cw), "W");
  assert.equal(plantDirection(150, ccw), "E");
  // The AXIS is the same either way -- which is why a container answer does
  // not depend on getting the handedness right.
  assert.equal(plantAxis(330, cw), plantAxis(330, ccw));
});

test("a run and its reverse are opposite directions on the same axis", () => {
  assert.equal(plantDirection(210), "N");
  assert.equal(plantDirection(30), "S");
  assert.equal(plantAxis(210), plantAxis(30));
});

test("a direction off every drawn axis is not pipe", () => {
  assert.equal(plantDirection(75), null);
  assert.equal(plantAxis(75), null);
});

test("a few degrees of drafting slop still reads as the axis", () => {
  assert.equal(plantDirection(272), "UP");
  assert.equal(plantDirection(27), "S");
  assert.equal(plantDirection(153), "W");
});

test("pageAngleOf measures clockwise from right, with y running DOWN", () => {
  assert.equal(pageAngleOf({ x: 0, y: 0 }, { x: 10, y: 0 }), 0);
  assert.equal(pageAngleOf({ x: 0, y: 0 }, { x: 0, y: 10 }), 90);
  assert.equal(pageAngleOf({ x: 0, y: 0 }, { x: 0, y: -10 }), 270);
});

test("a vertical dimension on the reference sheet reads as a rise", () => {
  // Sheet 1's 202mm runs (380,172) -> (380,251): down the page, so DOWN.
  assert.equal(plantDirection(pageAngleOf({ x: 380, y: 172 }, { x: 380, y: 251 })), "DOWN");
  assert.equal(plantAxis(90), "UP-DOWN");
});

test("bearings are reported with NORTH AS ZERO, not page angles", () => {
  const cw: IsoFrame = { northPageDeg: 210, eastIsClockwise: true };
  assert.equal(plantBearing(210, cw), 0);
  assert.equal(plantBearing(330, cw), 90);
  assert.equal(plantBearing(30, cw), 180);
  assert.equal(plantBearing(150, cw), 270);
});

test("the same run drawn on a differently-oriented sheet gives the SAME bearing", () => {
  // Which is the whole point of reading the north arrow: page angle is an
  // artefact of the sheet, bearing is a fact about the plant.
  const a: IsoFrame = { northPageDeg: 210, eastIsClockwise: true };
  const b: IsoFrame = { northPageDeg: 30, eastIsClockwise: true };
  assert.equal(plantBearing(210, a), plantBearing(30, b));
  assert.equal(plantBearing(210, a), 0);
});

test("UP and DOWN are off the compass -- elevation is its own axis", () => {
  assert.equal(plantBearing(270), null);
  assert.equal(plantBearing(90), null);
  assert.equal(plantAxis(90), "UP-DOWN");
});

test("the reference frame is fixed by a run whose direction is known", () => {
  // Sheet 1's 80mm weldolet branch is drawn at page 150 (down-left) and runs
  // WEST. Everything else follows from that one fact.
  assert.equal(plantDirection(150), "W");
  assert.equal(plantDirection(330), "E");
  assert.equal(plantDirection(210), "N");
  assert.equal(plantDirection(30), "S");
  assert.equal(plantDirection(270), "UP");
  assert.equal(DEFAULT_ISO_FRAME.northPageDeg, 210);
});
