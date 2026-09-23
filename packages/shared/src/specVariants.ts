// The sub-type an admin item-list line belongs to, for the three fittings whose
// admin lines run together under ONE client spec row but are really separate
// procurement items:
//
//   ELBO   a 90 degree and a 45 degree elbow
//   REDU   an eccentric (RE) and a concentric (RC) reducer
//   TEE    a straight (equal) tee and a reduced (reducing) tee
//
// A client spec states a component once for a whole size range -- "Elbow" or
// "Reducer (Concentric/Eccentric)" -- while the admin take-off states one line
// per size, schedule AND variant. Listed under that single client row, thirty
// 90 degree lines and thirty 45 degree lines read as one undifferentiated block,
// and the reviewer has to read every line to find out which is which. Naming
// the variant lets the page split them.
//
// Read from the line's own text, the same place the matching in
// verifySpecCrossCheck.ts reads a fitting's type from: the admin export has no
// column for any of this, only free-text description and material.

export interface AdminVariant {
  /** Stable key, for grouping. */
  key: string;
  /** What to show. */
  label: string;
  /** Display order within its type -- lower first. */
  order: number;
}

/** The fields of an admin line this reads. Structural, so the web app's SheetItem satisfies it as-is. */
export interface VariantSubject {
  type: string;
  description: string;
  material: string;
  catalogueRef?: string;
}

const NOT_STATED: AdminVariant = { key: "not-stated", label: "Not stated", order: 999 };

interface Candidate {
  re: RegExp;
  variant: AdminVariant;
}

/**
 * The variant whose keyword appears EARLIEST in the text, or null.
 *
 * Earliest, not first-listed: a line can name two ("CONC TO ECC"), and the
 * component's own name is the leading noun with anything after it secondary --
 * the same tiebreak resolveHint uses for valves, for the same reason.
 */
function earliest(text: string, candidates: Candidate[]): AdminVariant | null {
  let best: { index: number; variant: AdminVariant } | null = null;
  for (const { re, variant } of candidates) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, variant };
  }
  return best ? best.variant : null;
}

const ECCENTRIC: AdminVariant = { key: "eccentric", label: "Eccentric (RE)", order: 1 };
const CONCENTRIC: AdminVariant = { key: "concentric", label: "Concentric (RC)", order: 2 };
const STRAIGHT: AdminVariant = { key: "straight", label: "Straight", order: 1 };
const REDUCED: AdminVariant = { key: "reduced", label: "Reduced", order: 2 };

/**
 * `null` for anything that is not an elbow, reducer or tee -- those have no
 * variants to split. For the three that do, a line that names none is
 * "Not stated" rather than null: it still belongs to the split, and hiding it
 * would lose lines from the count.
 */
export function adminVariant(item: VariantSubject): AdminVariant | null {
  const type = item.type.trim().toUpperCase();
  const text = `${item.description} ${item.material} ${item.catalogueRef ?? ""}`;

  if (type.startsWith("ELBO")) {
    // "90DEG", "90 DEG", "90-DEG", "45 DEGREES", "90°". A bare number is not
    // an angle: "150# RF" and "SCH80" are everywhere in these lines.
    const m = /\b(\d{2,3})\s*-?\s*(?:DEG(?:REES?)?\b|°)/i.exec(text);
    if (!m) return NOT_STATED;
    const degrees = Number(m[1]);
    // Larger angle first, so 90 leads 45.
    return { key: `${degrees}deg`, label: `${degrees}°`, order: 360 - degrees };
  }

  if (type.startsWith("REDU")) {
    // The words first. RE and RC are the spec's own codes and short enough to
    // turn up inside something else, so they only count when no word did.
    const named = earliest(text, [
      { re: /\bECC(?:ENTRIC)?\b/i, variant: ECCENTRIC },
      { re: /\bCONC(?:ENTRIC)?\b/i, variant: CONCENTRIC },
    ]);
    if (named) return named;
    return (
      earliest(text, [
        { re: /\bRE\b/, variant: ECCENTRIC },
        { re: /\bRC\b/, variant: CONCENTRIC },
      ]) ?? NOT_STATED
    );
  }

  if (type.startsWith("TEE")) {
    return (
      earliest(text, [
        { re: /\bREDUC(?:ING|ED|TION)\b/i, variant: REDUCED },
        { re: /\b(?:EQUAL|STRAIGHT)\b/i, variant: STRAIGHT },
      ]) ?? NOT_STATED
    );
  }

  return null;
}
