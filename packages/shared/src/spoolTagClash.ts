/**
 * A spool number must name ONE piece of pipe.
 *
 * It is legitimate for a tag to appear on two sheets: a spool runs off the
 * edge of one drawing and carries on at the start of the next, and both sheets
 * label it. It is NOT legitimate for a tag to appear twice on pieces that are
 * not that single continuation -- then two different assemblies carry the same
 * number, and the shop builds one of them twice or not at all.
 *
 * This happens through ordinary revision drift, and it did here: a revision
 * added a spool to sheet 4, its printed tags went from four to five, and sheet
 * 5's tags were not renumbered to follow. N-15 then named both sheet 4's
 * welds 9-12 and sheet 5's welds 1-5, and N-16 named sheet 4's welds 13-17 and
 * sheet 5's welds 6-10 -- four pieces sharing two numbers, on a drawing that
 * looks perfectly tidy sheet by sheet. Neither sheet is wrong on its own,
 * which is exactly why it needs checking ACROSS them.
 *
 * The test is what a continuation actually looks like: the tag is the LAST
 * block of the earlier sheet and the FIRST block of the next one, with the
 * sheets consecutive. Anything else is two pieces wearing one number.
 */
export interface SpoolBlock {
  page: number;
  spool: string;
  /** The welds in this block, on this sheet. Numbering restarts per sheet. */
  weldNumbers: number[];
}

export interface SpoolTagClash {
  spool: string;
  pages: number[];
  why: string;
}

const lowest = (b: SpoolBlock) => Math.min(...b.weldNumbers);

export function spoolTagClashes(blocks: SpoolBlock[]): SpoolTagClash[] {
  const usable = blocks.filter((b) => b.spool && b.weldNumbers.length > 0);
  // Which blocks each sheet holds, in run order -- the order of their weld
  // numbers, since a spool is a contiguous block of them.
  const byPage = new Map<number, SpoolBlock[]>();
  for (const b of usable) byPage.set(b.page, [...(byPage.get(b.page) ?? []), b]);
  for (const list of byPage.values()) list.sort((x, y) => lowest(x) - lowest(y));

  const bySpool = new Map<string, SpoolBlock[]>();
  for (const b of usable) bySpool.set(b.spool, [...(bySpool.get(b.spool) ?? []), b]);

  const out: SpoolTagClash[] = [];
  for (const [spool, list] of bySpool) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((x, y) => x.page - y.page);
    const pages = sorted.map((b) => b.page);
    const say = (why: string) => out.push({ spool, pages, why });

    if (new Set(pages).size !== pages.length) {
      say(`names ${list.length} separate blocks on sheet ${pages[0]} -- a spool is one contiguous block of welds`);
      continue;
    }
    if (pages.some((p, i) => i > 0 && p !== pages[i - 1] + 1)) {
      say(`is on sheets ${pages.join(", ")}, which do not run on from one another`);
      continue;
    }
    const isLastOn = (b: SpoolBlock) => (byPage.get(b.page) as SpoolBlock[]).at(-1) === b;
    const isFirstOn = (b: SpoolBlock) => (byPage.get(b.page) as SpoolBlock[])[0] === b;
    const only = (b: SpoolBlock) => (byPage.get(b.page) as SpoolBlock[]).length === 1;

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!isLastOn(first)) {
      say(`is on sheets ${pages.join(" and ")}, but on sheet ${first.page} it is not the last spool -- a continuation leaves at the END of a sheet`);
      continue;
    }
    if (!isFirstOn(last)) {
      say(`is on sheets ${pages.join(" and ")}, but on sheet ${last.page} it is not the first spool -- a continuation arrives at the START of a sheet`);
      continue;
    }
    const middles = sorted.slice(1, -1);
    if (middles.some((b) => !only(b))) {
      say(`is on sheets ${pages.join(", ")} but shares a middle sheet with another spool -- a spool crossing a whole sheet is the only one on it`);
    }
  }
  return out.sort((a, b) => a.spool.localeCompare(b.spool));
}
