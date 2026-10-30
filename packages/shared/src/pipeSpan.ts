// How far apart pipe supports may sit -- the SPAN STANDARD.
//
// A support span is not one number. It depends on four things, and getting
// any of them wrong gives an answer that looks authoritative and is not:
//
//   the SIZE      a bigger pipe is stiffer but much heavier, and weight wins
//   the MATERIAL  stainless sags further than carbon steel at the same size
//   the AREA      a process area span is shorter than a pipe-rack one
//   the SHAPE     a straight run carries further than one turning a corner
//
// The fourth is the one people leave out. A span is quoted as a single figure
// per size, and then the same figure is applied to a run that turns through
// an elbow, hangs a dead leg, or carries a branch tee -- each of which adds
// weight the straight-run figure never accounted for. The project's span
// sheet draws all six cases separately, and this module keeps them separate.
//
// WHAT IS HERE IS WHAT THE SHEET PRINTS, AND NOTHING ELSE. One sheet has been
// supplied: 8" NPS Sch-20, carbon steel, process area. Every other size,
// schedule and material returns "no standard" rather than a number. That is
// the same rule `nominalBoreOdMm` follows and for the same reason -- a guessed
// span is a number that makes an unsupported run look supported.

/**
 * The six cases the span sheet draws. A span is judged as whichever of these
 * it actually is; where more than one applies, the SHORTEST governs.
 */
export type SpanConfiguration =
  | "straight"
  | "l-turn"
  | "v-turn"
  | "branch-tee"
  | "supported-riser"
  | "hanging-drop";

// Noun phrases, so they read correctly wherever they are dropped in: after a
// figure ("7200mm straight run"), in a list of the cases that were beaten
// ("also 6000mm carrying a branch tee"), and on their own as a label.
export const SPAN_CONFIGURATION_LABEL: Record<SpanConfiguration, string> = {
  straight: "straight run",
  "l-turn": "turning through one elbow (L)",
  "v-turn": "turning down and back up through a low elbow (V)",
  "branch-tee": "carrying a branch tee",
  "supported-riser": "with a vertical leg supported at its base",
  "hanging-drop": "hanging an unsupported drop leg",
};

export interface SpanStandard {
  /** Material family, as `materialFamily` normalises it. */
  material: string;
  npsInch: number;
  schedule: string;
  /** "process" here; a pipe-rack sheet would be its own entry. */
  area: string;
  /** Max support spacing, in mm, for each configuration the sheet draws. */
  spans: Partial<Record<SpanConfiguration, number>>;
  /**
   * A limit on the VERTICAL LEG itself, not on the span. Two of the sheet's
   * cases carry one, and it is a separate test: a 900mm drop off a 6000mm
   * horizontal breaks the span and not the leg, and the report has to say
   * which.
   */
  verticalLegMaxMm: Partial<Record<SpanConfiguration, number>>;
  source: string;
}

/**
 * The project's span sheet, transcribed.
 *
 * READING THE TWO "Max" CASES. The sheet draws a vertical leg twice, with
 * different numbers against each, and the pairing is what makes them
 * different cases rather than a contradiction:
 *
 *   3400 Max vertical / 7200 horizontal -- the riser has its OWN support at
 *     the base, so it carries its own weight and the horizontal keeps the
 *     full straight-run span.
 *   1100 Max vertical / 5500 horizontal -- the drop leg hangs off the
 *     horizontal with nothing under it, so its weight lands on the
 *     horizontal, and that span comes down accordingly.
 *
 * That is the only reading under which a SHORTER permitted leg goes with a
 * SHORTER permitted span. It is a reading of a drawing, not a quotation, so
 * the page prints it beside every verdict that depends on it -- confirm it
 * against the sheet before signing anything off.
 */
export const PROCESS_AREA_SPANS: SpanStandard[] = [
  {
    material: "carbon steel",
    npsInch: 8,
    schedule: "20",
    area: "process",
    spans: {
      straight: 7200,
      "l-turn": 7700,
      "v-turn": 6400,
      "branch-tee": 6000,
      "supported-riser": 7200,
      "hanging-drop": 5500,
    },
    verticalLegMaxMm: {
      "supported-riser": 3400,
      "hanging-drop": 1100,
    },
    source: '8"NPS Sch-20 Process Area Spans (project span sheet)',
  },
];

/**
 * Nominal bore in mm to NPS in inches (ASME B36.10).
 *
 * The ISO prints DN; the span sheet is headed in NPS. Neither document is
 * going to use the other's units, so they are reconciled here rather than by
 * whoever reads the page.
 */
const DN_TO_NPS: Record<number, number> = {
  15: 0.5, 20: 0.75, 25: 1, 32: 1.25, 40: 1.5, 50: 2, 65: 2.5, 80: 3,
  100: 4, 125: 5, 150: 6, 200: 8, 250: 10, 300: 12, 350: 14, 400: 16,
  450: 18, 500: 20, 600: 24,
};

/** NPS inches for a bore given as DN mm, or already in inches. Null off-table. */
export function npsInchOf(size: string | number | undefined | null): number | null {
  if (size == null) return null;
  const text = String(size).trim();
  if (!text) return null;
  // An inch figure is written with a " or the word, or is simply small: no
  // line is DN 8, and no pipe is 200 inches.
  const inches = text.match(/^(\d+(?:\.\d+)?|\d+\/\d+|\d+\s+\d+\/\d+)\s*(?:"|''|in\b|inch)/i);
  if (inches) return parseInchFraction(inches[1]);
  const n = Number(text.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return DN_TO_NPS[n] ?? null;
}

function parseInchFraction(text: string): number | null {
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = text.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The material FAMILY a spec or description names, which is the grain the
 * span sheet works at.
 *
 * A106 GR B, A234 WPB and A105N are all carbon steel and all span the same;
 * the sheet has one row for the family, not one per grade. Returns null for
 * anything it cannot place -- the caller then has no standard rather than the
 * wrong one.
 *
 * Order matters: "A216 WCB BODY, SS316L TRIM" is a carbon steel valve with a
 * stainless trim, and it is the BODY that sags.
 */
export function materialFamily(text: unknown): string | null {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\ba106\b|\ba105|\ba234|\ba216|\ba516|carbon steel|\bcs\b|\bwpb\b|\bwcb\b/.test(t)) return "carbon steel";
  if (/\ba312\b|\ba182\b|\ba403\b|stainless|\bss\s?3\d\d|\b3(?:04|16|21|47)l?\b|duplex/.test(t)) return "stainless steel";
  if (/alloy\s*625|inconel|\ba333\b|chrome|\b\d+cr\b|\bp11\b|\bp22\b/.test(t)) return "alloy steel";
  return null;
}

/** The schedule a description states ("SCH20", "SCH 40", "S-10"). */
export function scheduleOf(text: unknown): string | null {
  const m = String(text ?? "").toUpperCase().match(/\bS(?:CH)?\.?\s*-?\s*(\d{1,3}S?|STD|XS|XXS)\b/);
  return m ? m[1] : null;
}

export interface SpanLookup {
  npsInch: number | null;
  schedule: string | null;
  material: string | null;
  /** Defaults to "process"; a rack sheet would name its own. */
  area?: string;
}

/** The sheet that governs this pipe, or null where none has been supplied. */
export function findSpanStandard(at: SpanLookup, standards: SpanStandard[] = PROCESS_AREA_SPANS): SpanStandard | null {
  if (at.npsInch == null || !at.schedule || !at.material) return null;
  const area = at.area ?? "process";
  const schedule = at.schedule.toUpperCase().replace(/^0+(?=\d)/, "");
  return (
    standards.find(
      (s) =>
        s.npsInch === at.npsInch &&
        s.material === at.material &&
        s.area === area &&
        s.schedule.toUpperCase() === schedule
    ) ?? null
  );
}

export interface SpanInput extends SpanLookup {
  /** Centre to centre between the two supports, in mm. */
  lengthMm: number;
  /**
   * Every configuration this span is. A run that turns an elbow AND carries a
   * branch is both, and the shorter of the two governs -- which is the whole
   * reason this is a list and not one value.
   */
  configurations: SpanConfiguration[];
  /** The vertical leg's own length, where the span has one. */
  verticalLegMm?: number | null;
}

export interface SpanVerdict {
  status: "within" | "over" | "no standard";
  /** The governing figure, and which case produced it. */
  maxSpanMm: number | null;
  governing: SpanConfiguration | null;
  /** How far over, in mm. Null unless the status is "over". */
  overByMm: number | null;
  /**
   * How many supports have to be ADDED inside this stretch for no gap in it
   * to exceed the standard. Zero unless the status is "over".
   *
   * The actionable half of the answer. "2437mm over" says something is
   * wrong; "add two supports" says what to do about it, and the two are not
   * the same sentence -- a 30-metre unheld run reported only as a shortfall
   * in millimetres leaves the reader doing the division.
   */
  supportsRequired: number;
  /** How much room is left. Null unless the status is "within". */
  slackMm: number | null;
  /**
   * The vertical leg's own breach, where there is one. SEPARATE from the
   * span: a leg that is too long and a span that is too long are two
   * different corrections, and reporting them as one figure tells a designer
   * to fix the wrong thing.
   */
  verticalLegOverByMm: number | null;
  /** Said in words, so the verdict can be argued with rather than believed. */
  basis: string;
}

/**
 * Is this span within the standard?
 *
 * THE SHORTEST APPLICABLE CASE GOVERNS. Where a span is several of the
 * sheet's cases at once, taking any but the smallest permits a span the sheet
 * does not -- and the cases overlap constantly on a real run, where one piece
 * of pipe turns a corner and carries a tee between the same two supports.
 */
export function checkSpan(input: SpanInput, standards: SpanStandard[] = PROCESS_AREA_SPANS): SpanVerdict {
  const standard = findSpanStandard(input, standards);
  if (!standard) {
    const missing = [
      input.npsInch == null ? "size" : null,
      !input.schedule ? "schedule" : null,
      !input.material ? "material" : null,
    ].filter(Boolean);
    return {
      status: "no standard",
      maxSpanMm: null,
      governing: null,
      overByMm: null,
      slackMm: null,
      supportsRequired: 0,
      verticalLegOverByMm: null,
      basis:
        missing.length > 0
          ? `no span standard can be chosen -- the ${missing.join(" and ")} of this line ${missing.length > 1 ? "are" : "is"} not known`
          : `no span sheet supplied for ${input.npsInch}" NPS Sch-${input.schedule} ${input.material} in a ${input.area ?? "process"} area`,
    };
  }

  // A span with no configuration named is still a span of pipe, and the
  // straight-run figure is the one that always applies.
  const cases = input.configurations.length > 0 ? input.configurations : (["straight"] as SpanConfiguration[]);
  const applicable = cases
    .map((c) => ({ c, mm: standard.spans[c] }))
    .filter((x): x is { c: SpanConfiguration; mm: number } => typeof x.mm === "number")
    .sort((a, b) => a.mm - b.mm);

  if (applicable.length === 0) {
    return {
      status: "no standard",
      maxSpanMm: null,
      governing: null,
      overByMm: null,
      slackMm: null,
      supportsRequired: 0,
      verticalLegOverByMm: null,
      basis: `${standard.source} does not draw ${cases.map((c) => SPAN_CONFIGURATION_LABEL[c]).join(" or ")}`,
    };
  }

  const [governing, ...alsoApply] = applicable;

  let verticalLegOverByMm: number | null = null;
  if (input.verticalLegMm != null) {
    for (const { c } of applicable) {
      const limit = standard.verticalLegMaxMm[c];
      if (limit != null && input.verticalLegMm > limit) {
        verticalLegOverByMm = Math.max(verticalLegOverByMm ?? 0, Math.round(input.verticalLegMm - limit));
      }
    }
  }

  const over = Math.round(input.lengthMm - governing.mm);
  const ruledOut = alsoApply.length > 0 ? `; also ${alsoApply.map((x) => `${x.mm}mm ${SPAN_CONFIGURATION_LABEL[x.c]}`).join(", ")}` : "";
  const legNote =
    verticalLegOverByMm != null ? `; the vertical leg is ${verticalLegOverByMm}mm over its own limit` : "";
  const basis = `${standard.source}: ${governing.mm}mm ${SPAN_CONFIGURATION_LABEL[governing.c]}${ruledOut}${legNote}`;

  return {
    status: over > 0 ? "over" : "within",
    maxSpanMm: governing.mm,
    governing: governing.c,
    overByMm: over > 0 ? over : null,
    // Math.abs, not -over: a span exactly at the limit gives -0, which reads
    // as "-0 mm spare" on the page and is not equal to 0 under Object.is.
    slackMm: over > 0 ? null : Math.abs(over),
    supportsRequired: over > 0 ? supportsRequired(input.lengthMm, governing.mm) : 0,
    verticalLegOverByMm,
    basis,
  };
}

/**
 * Which of the span sheet's cases a span is, read off the DIRECTIONS its legs
 * run in.
 *
 * THE FLOW FOLLOWS THE SAME SOURCE AS THE LENGTHS. Each leg's `drawnAs` is
 * the plant direction the envelope work already worked out -- so the shape of
 * a span comes from the same rows as its length, and the two cannot disagree.
 *
 * What the directions settle that a bare turn count cannot:
 *
 *   a V is specifically DOWN then back UP through a low elbow, so the legs
 *     contain both UP and DOWN
 *   an L is one corner in PLAN -- two different horizontal directions, no
 *     change of elevation
 *
 * That distinction is worth 1300mm (7700 against 6400) and used to be given
 * away: with only "it turns" to go on, both had to be offered and the shorter
 * governed, so every genuine L was judged as a V.
 *
 * Still conservative where the drawing genuinely does not say: a vertical leg
 * alongside horizontals could be a riser carrying its own support (7200) or a
 * drop hanging off the run (5500), and nothing here knows which, so both are
 * offered and `checkSpan` takes the shorter.
 */
export const VERTICAL_DIRECTIONS = new Set(["UP", "DOWN"]);

export function configurationsFromDirections(directions: string[]): SpanConfiguration[] {
  const seen = [...new Set(directions.map((d) => d.trim().toUpperCase()).filter(Boolean))];
  if (seen.length <= 1) return ["straight"];

  const verticals = seen.filter((d) => VERTICAL_DIRECTIONS.has(d));
  const horizontals = seen.filter((d) => !VERTICAL_DIRECTIONS.has(d));
  const out: SpanConfiguration[] = [];

  // Down and back up: the V the sheet draws.
  if (verticals.includes("UP") && verticals.includes("DOWN")) out.push("v-turn");
  // A corner in plan, with no change of elevation: the L.
  else if (horizontals.length > 1 && verticals.length === 0) out.push("l-turn");

  // One vertical leg among horizontals. Which of the sheet's two vertical
  // cases it is depends on whether that leg is supported at its base, which
  // the drawing does not state -- so offer both and let the shorter govern.
  if (verticals.length > 0 && horizontals.length > 0) out.push("supported-riser", "hanging-drop");

  return out.length > 0 ? out : ["l-turn", "v-turn"];
}

/**
 * How many supports must be ADDED inside a stretch of pipe so that no gap in
 * it exceeds the standard.
 *
 * Dividing the length by the limit gives the number of GAPS needed; the
 * supports are the joints between them, so there is one fewer. A 30.8m run
 * at 7200mm is five gaps and therefore four new supports.
 *
 * A LOWER BOUND where the length is a sheet's total rather than one run:
 * several separate runs each need their own supports, so the true figure can
 * only be higher. Report it as "at least".
 */
export function supportsRequired(lengthMm: number, maxSpanMm: number): number {
  if (!(maxSpanMm > 0) || !(lengthMm > 0)) return 0;
  return Math.max(0, Math.ceil(lengthMm / maxSpanMm) - 1);
}
