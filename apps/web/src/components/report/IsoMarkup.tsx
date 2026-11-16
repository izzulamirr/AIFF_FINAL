"use client";

import { useEffect, useState } from "react";
import { loadPdfjs, type PdfDoc } from "@/lib/pdfjsClient";

// The ISO with the report's errors marked on it -- what a checker does with a red
// pen, done from the report's own findings.
//
// Each sheet that has a finding is drawn, and every finding that can be placed gets
// a numbered marker carrying its report ref ("2.3"). A marker links to its row in
// the report, and a row's ref links back to its marker.
//
// HOW AN ITEM IS FOUND
//   1. The drawing's own text layer (free, exact). Most ISOs keep their lettering
//      as text, so a BOM description, weld flag, instrument tag or spool tag can be
//      looked up and its box taken straight from the PDF.
//   2. Only where a sheet has NO text layer -- the CAD turned every letter into
//      lines -- the rendered sheet is sent to Claude to find the items (see the
//      `locate` route). Each answer is stored, so a sheet is paid for once. Those
//      markers are drawn dashed and say "found by AI", because they are a reading
//      of the picture, not a lookup.
// A finding that cannot be placed either way is listed under its sheet rather than
// marked somewhere it might not be.

export interface MarkupFinding {
  /** The report ref, "2.3". */
  ref: string;
  page: number;
  terms: string[];
  describe: string | null;
  /** False for a finding shown for information only. */
  error: boolean;
  /** A few words for the marker's tooltip. */
  label: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed {
  ref: string;
  box: Box;
  how: "text" | "ai";
  error: boolean;
  label: string;
}

interface Sheet {
  page: number;
  image: string | null;
  placed: Placed[];
  unlocated: string[];
  status: "loading" | "ready" | "error";
  /** Why some markers are missing or found by AI, in a sentence. */
  note: string | null;
  /** What it is doing right now, while loading. */
  phase: string | null;
}

/** Wide enough to read a weld number when zoomed, small enough to keep as an image. */
const RENDER_WIDTH = 2200;
/** Claude's vision input is most accurate at or below this long side. */
const AI_LONG_SIDE = 1568;
/** A sheet with fewer text runs than this has no usable text layer. */
const MIN_TEXT_RUNS = 12;
/** A term that matches more places than this identifies nothing. */
const MAX_HITS = 3;
/** How many neighbouring text runs may be joined to match one term. */
const JOIN = 6;

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, "");
const anchor = (ref: string) => ref.replace(/\./g, "-");

interface Run {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
}

type TextItem = { str: string; transform: number[]; width: number };

/** Each text run's box on the rendered page, in pixels. Rotated text gets the box round its four corners. */
function runsOf(items: TextItem[], viewportTransform: number[], scale: number, multiply: (a: number[], b: number[]) => number[]): Run[] {
  const out: Run[] = [];
  for (const item of items) {
    const text = norm(item.str ?? "");
    if (!text) continue;
    const t = multiply(viewportTransform, item.transform);
    const angle = Math.atan2(t[1], t[0]);
    const size = Math.hypot(t[2], t[3]) || 8;
    const len = Math.max(item.width * scale, size * 0.6 * text.length * 0.5);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // "Up" from the baseline, in page pixels (y runs down).
    const ux = dy;
    const uy = -dx;
    const xs = [t[4], t[4] + dx * len, t[4] + ux * size, t[4] + dx * len + ux * size];
    const ys = [t[5], t[5] + dy * len, t[5] + uy * size, t[5] + dy * len + uy * size];
    out.push({ text, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), size });
  }
  return out;
}

/**
 * Every place a term is printed, as boxes. Neighbouring runs are joined, so a weld
 * flag drawn as "BW" + "12" still matches "BW12" -- but only runs that sit close
 * together, so two words that happen to be adjacent in the file are not.
 * Null when the term matches too many places to point at one.
 */
function find(runs: Run[], term: string, pageW: number, pageH: number): Box[] | null {
  const want = norm(term);
  if (want.length < 3) return [];
  const hits: Box[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (!want.includes(runs[i].text.slice(0, Math.min(3, runs[i].text.length))) && !runs[i].text.includes(want)) continue;
    let joined = "";
    let box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let j = i; j < Math.min(runs.length, i + JOIN); j++) {
      const r = runs[j];
      joined += r.text;
      box = { x0: Math.min(box.x0, r.x0), y0: Math.min(box.y0, r.y0), x1: Math.max(box.x1, r.x1), y1: Math.max(box.y1, r.y1) };
      // Runs too far apart are not one piece of text.
      if (box.x1 - box.x0 > pageW * 0.4 || box.y1 - box.y0 > pageH * 0.08) break;
      const at = joined.indexOf(want);
      if (at >= 0) {
        // A number must end where the term ends: "SW2" is not weld 2 when the
        // flag reads "SW20", whether the 0 is in this run or the next one.
        if (/\d$/.test(want)) {
          // The next run counts only if it sits right beside this one -- the "0" of
          // a flag drawn as "SW"+"2"+"0". The next run in the FILE can be anywhere:
          // on CRD-0005 it is the "...P-01-03" tag on the line below, and reading
          // its leading "1" as a continuation threw away a perfect match.
          const next = runs[j + 1];
          // Beside = on the same line (the boxes overlap vertically) and within a
          // character's width -- the next line of a list sits close but below.
          const beside = next != null && next.x0 <= box.x1 + r.size && next.x1 >= box.x0 - r.size && next.y0 < box.y1 && next.y1 > box.y0;
          const after = joined[at + want.length] ?? (beside ? next.text[0] : "");
          if (/\d/.test(after)) break;
        }
        // Box only the runs the match actually covers: "SW20"+"SW21" joined finds
        // SW21, but the box must not swallow the SW20 flag in front of it.
        let start = i;
        let skipped = 0;
        while (start < j && skipped + runs[start].text.length <= at) skipped += runs[start++].text.length;
        const span = runs.slice(start, j + 1);
        const x0 = Math.min(...span.map((s) => s.x0));
        const y0 = Math.min(...span.map((s) => s.y0));
        const x1 = Math.max(...span.map((s) => s.x1));
        const y1 = Math.max(...span.map((s) => s.y1));
        const pad = r.size * 0.5;
        hits.push({ x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 });
        i = j;
        break;
      }
      if (joined.length > want.length + 40) break;
    }
    if (hits.length > MAX_HITS) return null;
  }
  return hits;
}

/** Fail a step that never finishes, naming it -- a stuck step must not look like "still loading". */
function within<T>(promise: Promise<T>, seconds: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${seconds} seconds and was stopped.`)), seconds * 1000);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

type Locate = (
  page: number,
  items: Array<{ ref: string; describe: string }>,
  canvas: HTMLCanvasElement
) => Promise<{ boxes: Map<string, Box>; error: string | null }>;

/**
 * One sheet, in steps, each reported as it starts so the page says what it is
 * doing. The picture is handed back as soon as it is drawn -- the markers follow --
 * so the drawing is never held back behind the search.
 */
async function readSheet(
  doc: PdfDoc,
  multiply: (a: number[], b: number[]) => number[],
  page: number,
  findings: MarkupFinding[],
  locate: Locate,
  update: (patch: Partial<Sheet>) => void
): Promise<Sheet> {
  update({ phase: `Drawing page ${page}…` });
  const p = await within(doc.getPage(page), 30, `Opening page ${page}`);
  const base = p.getViewport({ scale: 1 });
  const scale = RENDER_WIDTH / base.width;
  const viewport = p.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await within(p.render({ canvasContext: ctx, viewport }).promise, 60, `Drawing page ${page}`);
  const image = canvas.toDataURL("image/jpeg", 0.9);
  update({ image, phase: "Finding the errors on the drawing…" });

  const content = await within(p.getTextContent(), 30, `Reading the text of page ${page}`);
  const runs = runsOf(content.items as TextItem[], viewport.transform, scale, multiply);
  const W = canvas.width;
  const H = canvas.height;
  // A weld flag is a few pixels across at full-sheet size; a box that small is
  // invisible until zoomed. Grow small boxes about their centre to a readable size.
  const MIN = W * 0.018;
  const frac = (b: Box): Box => {
    const w = Math.max(b.w, MIN);
    const h = Math.max(b.h, MIN);
    const x = b.x - (w - b.w) / 2;
    const y = b.y - (h - b.h) / 2;
    return { x: x / W, y: y / H, w: w / W, h: h / H };
  };

  const placed: Placed[] = [];
  const unlocated: string[] = [];
  let note: string | null = null;

  if (runs.length >= MIN_TEXT_RUNS) {
    for (const f of findings) {
      let boxes: Box[] = [];
      for (const term of f.terms) {
        const found = find(runs, term, W, H);
        if (found && found.length > 0) {
          boxes = found;
          break;
        }
      }
      if (boxes.length === 0) unlocated.push(f.ref);
      for (const b of boxes) placed.push({ ref: f.ref, box: frac(b), how: "text", error: f.error, label: f.label });
    }
  } else {
    // No text layer: ask Claude, for the findings that can be described.
    const askable = findings.filter((f) => f.describe);
    for (const f of findings) if (!f.describe) unlocated.push(f.ref);
    if (askable.length > 0) {
      update({ phase: `This sheet has no text layer. Asking AI to find ${askable.length} item${askable.length === 1 ? "" : "s"} (up to a minute the first time)…` });
      try {
        const { boxes, error } = await within(
          locate(
            page,
            askable.map((f) => ({ ref: f.ref, describe: f.describe! })),
            canvas
          ),
          150,
          "Finding the errors with AI"
        );
        for (const f of askable) {
          const b = boxes.get(f.ref);
          if (b) placed.push({ ref: f.ref, box: b, how: "ai", error: f.error, label: f.label });
          else unlocated.push(f.ref);
        }
        note = error ?? "This sheet has no text layer, so its markers were found by AI from the picture. Check them against the drawing.";
      } catch (err) {
        // The drawing is still worth showing without its markers.
        for (const f of askable) unlocated.push(f.ref);
        note = err instanceof Error ? err.message : "The errors could not be found on this sheet.";
      }
    } else {
      note = "This sheet has no text layer, so its errors could not be found on it.";
    }
  }

  return { page, image, placed, unlocated, status: "ready", note, phase: null };
}

/** The sheet scaled for Claude, as a JPEG data URL. */
function forClaude(canvas: HTMLCanvasElement): string {
  const k = Math.min(1, AI_LONG_SIDE / Math.max(canvas.width, canvas.height));
  const small = document.createElement("canvas");
  small.width = Math.round(canvas.width * k);
  small.height = Math.round(canvas.height * k);
  const ctx = small.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  return small.toDataURL("image/jpeg", 0.85);
}

export function IsoMarkup({
  projectId,
  documentId,
  findings,
  fileUrl,
}: {
  projectId: string;
  documentId: string;
  findings: MarkupFinding[];
  /** Where to read the PDF from. Defaults to the document's own file route. */
  fileUrl?: string;
}) {
  const pages = [...new Set(findings.map((f) => f.page))].sort((a, b) => a - b);
  const [sheets, setSheets] = useState<Sheet[]>(() =>
    pages.map((page) => ({ page, image: null, placed: [], unlocated: [], status: "loading", note: null, phase: "Loading the drawing…" }))
  );
  const [zoomed, setZoomed] = useState<Set<number>>(new Set());
  const key = findings.map((f) => `${f.ref}@${f.page}`).join("|");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const setAll = (patch: Partial<Sheet>) => !cancelled && setSheets((prev) => prev.map((s) => (s.status === "loading" ? { ...s, ...patch } : s)));
      try {
        setAll({ phase: "Starting the PDF viewer…" });
        const lib = await within(loadPdfjs(), 30, "Starting the PDF viewer");
        setAll({ phase: "Downloading the drawing…" });
        const res = await within(fetch(fileUrl ?? `/projects/${projectId}/documents/${documentId}/file`), 60, "Downloading the drawing");
        if (!res.ok) throw new Error(`The drawing could not be loaded (${res.status}).`);
        const bytes = new Uint8Array(await within(res.arrayBuffer(), 60, "Downloading the drawing"));
        setAll({ phase: "Opening the drawing…" });
        // A pdf.js worker that failed to start leaves this waiting for ever -- hence the limit.
        const doc = await within(lib.getDocument({ data: bytes }).promise, 30, "Opening the drawing");

        const locate: Locate = async (page, items, canvas) => {
          const url = `/projects/${projectId}/documents/${documentId}/locate`;
          const post = async (body: object) => {
            const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            // A server error comes back as a page, not JSON -- say so plainly.
            if (!r.headers.get("content-type")?.includes("application/json")) throw new Error(`The AI search could not be run (${r.status}).`);
            return r.json();
          };
          // Ask first without the picture: what is already known costs nothing.
          let answer = await post({ page, items });
          if (answer.needImage) answer = await post({ page, items, image: forClaude(canvas) });
          const boxes = new Map<string, Box>();
          for (const r of (answer.results ?? []) as Array<{ ref: string; found: boolean } & Box>) {
            if (r.found) boxes.set(r.ref, { x: r.x, y: r.y, w: r.w, h: r.h });
          }
          return { boxes, error: (answer.error as string | undefined) ?? null };
        };

        // Every sheet at once, not one after another: a sheet with no text layer
        // waits on an AI call of up to a minute, and five of those in a row kept
        // the last sheet waiting for minutes. Each sheet shows as it finishes.
        await Promise.all(
          pages.map(async (page) => {
            let sheet: Sheet;
            try {
              if (page > doc.numPages) throw new Error(`The drawing has no page ${page}.`);
              const update = (patch: Partial<Sheet>) => !cancelled && setSheets((prev) => prev.map((s) => (s.page === page ? { ...s, ...patch } : s)));
              sheet = await readSheet(doc, lib.Util.transform, page, findings.filter((f) => f.page === page), locate, update);
            } catch (err) {
              sheet = { page, image: null, placed: [], unlocated: [], status: "error", note: err instanceof Error ? err.message : "This sheet could not be drawn.", phase: null };
            }
            if (!cancelled) setSheets((prev) => prev.map((s) => (s.page === page ? sheet : s)));
          })
        );
      } catch (err) {
        if (!cancelled) {
          const note = err instanceof Error ? err.message : "The drawing could not be loaded.";
          setSheets((prev) => prev.map((s) => ({ ...s, status: "error", note, phase: null })));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `key` stands in for the findings: a new array of the same findings must not redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId, key]);

  if (pages.length === 0) return null;

  return (
    <div className="flex flex-col gap-5">
      {sheets.map((s) => {
        const errors = new Set(s.placed.filter((p) => p.error).map((p) => p.ref)).size;
        const isZoomed = zoomed.has(s.page);
        // An item found in two places gets two markers; the link target is the first.
        const firstOf = new Set<string>();
        return (
          <figure key={s.page} className="m-0 flex flex-col gap-2 break-inside-avoid">
            <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-semibold">Page {s.page}</span>
              {s.status === "ready" && (
                <span className="text-muted-foreground">
                  {s.placed.length === 0 ? "nothing could be marked" : `${errors} error${errors === 1 ? "" : "s"} marked`}
                </span>
              )}
              {s.status === "ready" && s.image && (
                <button
                  type="button"
                  className="no-print btn btn-ghost btn-xs ml-auto"
                  onClick={() =>
                    setZoomed((prev) => {
                      const next = new Set(prev);
                      if (next.has(s.page)) next.delete(s.page);
                      else next.add(s.page);
                      return next;
                    })
                  }
                >
                  {isZoomed ? "Fit to width" : "Zoom in"}
                </button>
              )}
            </figcaption>

            <div className={`relative rounded-md border bg-white ${isZoomed ? "max-h-[80vh] overflow-auto" : "overflow-hidden"}`}>
              {s.status === "loading" && !s.image && (
                <div className="flex aspect-[1.414] w-full items-center justify-center text-sm text-muted-foreground" role="status">
                  {s.phase ?? "Loading the drawing…"}
                </div>
              )}
              {/* The drawing is up; the markers are still being found. */}
              {s.status === "loading" && s.image && (
                <div className="no-print absolute inset-x-0 top-0 z-10 bg-card/90 px-3 py-1.5 text-xs text-muted-foreground" role="status">
                  {s.phase}
                </div>
              )}
              {s.status === "error" && <div className="p-6 text-sm text-danger">{s.note}</div>}
              {s.image && (
                <div className="relative" style={{ width: isZoomed ? "250%" : "100%" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a rendered data URL, not a static asset */}
                  <img src={s.image} alt={`Page ${s.page} of the drawing, with the errors marked`} className="block h-auto w-full" />
                  {s.placed.map((p, i) => {
                    const id = firstOf.has(p.ref) ? undefined : `mark-${anchor(p.ref)}`;
                    firstOf.add(p.ref);
                    return (
                      <a
                        key={`${p.ref}-${i}`}
                        id={id}
                        href={`#finding-${anchor(p.ref)}`}
                        title={`${p.ref} · ${p.label}${p.how === "ai" ? " · found by AI" : ""}`}
                        className={`iso-mark absolute rounded-[3px] border-2 ${p.how === "ai" ? "border-dashed" : ""} ${
                          p.error ? "border-danger-solid bg-danger-solid/10" : "border-warning-solid bg-warning-solid/10"
                        }`}
                        style={{ left: `${p.box.x * 100}%`, top: `${p.box.y * 100}%`, width: `${p.box.w * 100}%`, height: `${p.box.h * 100}%` }}
                      >
                        <span
                          className={`absolute -top-[1.35em] left-[-2px] whitespace-nowrap rounded-sm px-1 text-[11px] font-bold leading-[1.3] text-white ${
                            p.error ? "bg-danger-solid" : "bg-warning-solid"
                          }`}
                        >
                          {p.ref}
                        </span>
                      </a>
                    );
                  })}
                </div>
              )}
            </div>

            {s.status === "ready" && (s.unlocated.length > 0 || s.note) && (
              <p className="text-xs text-muted-foreground">
                {s.note && <span className="block">{s.note}</span>}
                {s.unlocated.length > 0 && (
                  <span className="block">
                    Not found on the drawing:{" "}
                    {s.unlocated.map((ref, i) => (
                      <span key={ref}>
                        {i > 0 && ", "}
                        <a href={`#finding-${anchor(ref)}`} className="link">
                          {ref}
                        </a>
                      </span>
                    ))}
                    . See the rows below.
                  </span>
                )}
              </p>
            )}
          </figure>
        );
      })}
    </div>
  );
}
