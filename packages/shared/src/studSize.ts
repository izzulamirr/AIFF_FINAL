// A stud bolt's order size, from the size the BOM states.
//
// A BOM gives a stud as diameter x length in millimetres ("16X89", "24X172"). The DIAMETER is a
// standard size and is kept as stated. The LENGTH is what is ordered in steps of 5 mm, so it is
// taken UP to the next multiple of 5: 89 -> 90, 102 -> 105, 108 -> 110, 172 -> 175. Always up,
// never down -- a stud rounded down is a stud that does not reach -- and a length already on a
// multiple of 5 is left alone.

export interface StudSize {
  /** The BOM's own figures. */
  diameterMm: number;
  lengthMm: number;
  /** As ordered: the diameter as stated, the length up to the next 5 mm. */
  orderDiameterMm: number;
  orderLengthMm: number;
}

/** The step studs are made to length in. */
export const STUD_LENGTH_STEP_MM = 5;

/** A length taken up to the next multiple of 5; itself where it already is one. */
export function roundUpToFive(n: number): number {
  return Math.ceil(n / STUD_LENGTH_STEP_MM - 1e-9) * STUD_LENGTH_STEP_MM;
}

/** "16X89", "16 x 89 mm", "24x172" -> the size and its order size. Null where it is not diameter x length. */
export function studOrderSize(raw: unknown): StudSize | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[xX\u00d7]\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const diameterMm = Number(m[1]);
  const lengthMm = Number(m[2]);
  if (!(diameterMm > 0) || !(lengthMm > 0)) return null;
  return { diameterMm, lengthMm, orderDiameterMm: diameterMm, orderLengthMm: roundUpToFive(lengthMm) };
}

/** "16X90" */
export const formatStudSize = (s: Pick<StudSize, "orderDiameterMm" | "orderLengthMm">) => `${s.orderDiameterMm}X${s.orderLengthMm}`;

/** The nut counts a stud line states: "(WITH 2 NUTS)" -> [2]. A merged BOM row can state more than one. */
export function studNutCounts(text: unknown): number[] {
  const found = new Set<number>();
  for (const m of String(text ?? "").matchAll(/\bWITH\s*(\d+)\s*NUTS?\b/gi)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}
