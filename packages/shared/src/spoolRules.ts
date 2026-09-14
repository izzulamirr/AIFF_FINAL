// Pipe spool boundaries on an isometric are read directly off the sheet
// itself: its own "PIPE SPOOLS" schedule gives the spool tags, in order, and
// each weld's own local neighbourhood gives the boundaries between them. The
// model is deliberately never asked to sort a whole sheet's welds into
// buckets in one shot (that consistently produced wrong, out-of-sequence
// groupings) -- instead every weld answers two small LOCAL questions: which
// weld sits immediately before it (comes_after_weld), and whether a spool
// ends right at it (closes_spool). See spool_tags and welds.comes_after_weld
// / welds.closes_spool in packages/extraction-schemas/src/iso.ts for the
// exact boundary rule given to the model: a spool ends only at a valve
// flanged on both sides, or at a forced cut past 6000mm marked by a field
// weld -- nothing else, so a branch takeoff never gets closes_spool true and
// simply inherits whatever spool its takeoff point belongs to.
//
// buildSpoolsFromWeldTopology walks the tree those per-weld answers
// describe -- a branch is just two or more welds sharing one
// comes_after_weld parent -- and assigns every weld to a spool purely from
// that local data, then maps the resulting spool count onto spool_tags
// positionally (both are read in the same run order).
export interface WeldTopology {
  weldNo: number;
  /** The weld immediately before this one, on whichever path (mainline or branch) it sits on. Null for the sheet's first weld. */
  comesAfterWeld: number | null;
  /** true if a spool ends AT this weld (a valve sits right after it, or this weld is itself the field weld closing a forced 6000mm cut). */
  closesSpool: boolean;
}

export interface ResolvedSpool {
  spoolTag: string;
  /** 1-based, in walk order. */
  index: number;
  weldNumbers: number[];
}

export interface ResolvedSpools {
  spools: ResolvedSpool[];
  /** WELD ID -> spool tag, for tagging each weld row. */
  weldToSpoolTag: Map<number, string>;
  /** Welds whose comes_after_weld pointed at a weld ID not present on this sheet -- surfaced so a broken link is visible rather than silently dropped. */
  orphanWelds: number[];
}

export function buildSpoolsFromWeldTopology(welds: WeldTopology[], spoolTags: string[]): ResolvedSpools {
  const byNo = new Map(welds.map((w) => [w.weldNo, w]));
  const childrenOf = new Map<number, number[]>();
  const roots: number[] = [];
  const orphanWelds: number[] = [];

  for (const w of welds) {
    if (w.comesAfterWeld == null) {
      roots.push(w.weldNo);
    } else if (byNo.has(w.comesAfterWeld)) {
      const list = childrenOf.get(w.comesAfterWeld) ?? [];
      list.push(w.weldNo);
      childrenOf.set(w.comesAfterWeld, list);
    } else {
      // Points at a weld ID that isn't on this sheet -- place it as its own
      // root rather than dropping it, but flag the broken link.
      roots.push(w.weldNo);
      orphanWelds.push(w.weldNo);
    }
  }

  const weldSpoolIndex = new Map<number, number>();
  let spoolCounter = 0;

  function walk(weldNo: number, currentSpoolIndex: number) {
    if (weldSpoolIndex.has(weldNo)) return; // guards a cyclic or duplicated comes_after_weld
    weldSpoolIndex.set(weldNo, currentSpoolIndex);
    const nextSpoolIndex = byNo.get(weldNo)?.closesSpool ? ++spoolCounter : currentSpoolIndex;
    for (const child of childrenOf.get(weldNo) ?? []) walk(child, nextSpoolIndex);
  }

  // Roots are walked in the order the model listed the welds, which is the
  // order it swept the sheet -- normally just one true root (the sheet's
  // first weld) plus any orphaned links.
  for (const root of roots) {
    if (weldSpoolIndex.has(root)) continue;
    walk(root, ++spoolCounter);
  }

  const weldNumbersByIndex = new Map<number, number[]>();
  for (const [weldNo, idx] of weldSpoolIndex) {
    const list = weldNumbersByIndex.get(idx) ?? [];
    list.push(weldNo);
    weldNumbersByIndex.set(idx, list);
  }

  const indices = [...weldNumbersByIndex.keys()].sort((a, b) => a - b);
  const spools: ResolvedSpool[] = indices.map((idx, i) => ({
    spoolTag: spoolTags[i] ?? `spool-${idx}`, // falls back to a synthetic tag if fewer tags were read than spools actually walked out
    index: i + 1,
    weldNumbers: (weldNumbersByIndex.get(idx) ?? []).sort((a, b) => a - b),
  }));

  const weldToSpoolTag = new Map<number, string>();
  for (const spool of spools) for (const weldNo of spool.weldNumbers) weldToSpoolTag.set(weldNo, spool.spoolTag);

  return { spools, weldToSpoolTag, orphanWelds };
}
