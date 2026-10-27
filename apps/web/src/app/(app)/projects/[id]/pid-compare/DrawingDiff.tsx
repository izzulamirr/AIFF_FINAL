"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The two P&IDs drawn one over the other, with every difference coloured in --
// the overlay a checker makes on a light table, done in the browser.
//
// Both sheets are rendered at the same size and compared ink for ink: ink only on
// the earlier sheet is REMOVED (red), ink only on the latest is ADDED (blue), ink
// on both is unchanged (grey). It compares pictures, not extracted data, so it
// costs nothing, needs no AI, and works the same on a flattened or scanned sheet.
// Changed pixels are grouped into numbered areas that can be jumped to.
//
// What it cannot do is tell a moved item from a removed-and-added one, or say WHAT
// changed -- the tables below the drawing do that from the extraction. And two
// sheets that do not share a frame (a different sheet size or margin) will light up
// everywhere; the page says so when the sizes differ.

type PdfLib = typeof import("pdfjs-dist");
type PdfDoc = Awaited<ReturnType<PdfLib["getDocument"]>["promise"]>;

let pdfjs: Promise<PdfLib> | null = null;
function loadPdfjs(): Promise<PdfLib> {
  if (!pdfjs) {
    pdfjs = import("pdfjs-dist").then((lib) => {
      lib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.js", import.meta.url));
      return lib;
    });
  }
  return pdfjs;
}

export interface DiffDocument {
  id: string;
  fileName: string;
  pageCount: number | null;
}

interface Region {
  n: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "added" | "removed" | "changed";
}

/** Width the sheets are compared at, in pixels. Enough to read a tag number when zoomed. */
const WIDTH = 2600;
/** Ink is anything darker than this (0-255). */
const INK = 170;
/** How far a line may shift between the two renders and still count as the same line. */
const TOLERANCE = 2;
/** Changed pixels are grouped in cells this size; a cell needs MIN_PIXELS to count. */
const CELL = 24;
const MIN_PIXELS = 6;

const COLOR = {
  same: [190, 196, 204],
  removed: [220, 38, 38],
  added: [37, 99, 235],
} as const;

async function renderPage(doc: PdfDoc, pageNumber: number, width: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function inkMask(img: ImageData): Uint8Array {
  const { data } = img;
  const mask = new Uint8Array(img.width * img.height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    mask[p] = data[i + 3] > 0 && lum < INK ? 1 : 0;
  }
  return mask;
}

/** Grow every inked pixel by `r` in each direction (separable: rows, then columns). */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      for (let dx = Math.max(0, x - r); dx <= Math.min(w - 1, x + r); dx++) rows[row + dx] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!rows[y * w + x]) continue;
      for (let dy = Math.max(0, y - r); dy <= Math.min(h - 1, y + r); dy++) out[dy * w + x] = 1;
    }
  }
  return out;
}

function compare(before: HTMLCanvasElement, after: HTMLCanvasElement): { canvas: HTMLCanvasElement; regions: Region[] } {
  const w = Math.min(before.width, after.width);
  const h = Math.min(before.height, after.height);
  const a = inkMask(before.getContext("2d")!.getImageData(0, 0, w, h));
  const b = inkMask(after.getContext("2d")!.getImageData(0, 0, w, h));
  const nearA = dilate(a, w, h, TOLERANCE);
  const nearB = dilate(b, w, h, TOLERANCE);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const out = ctx.createImageData(w, h);
  const cw = Math.ceil(w / CELL);
  const ch = Math.ceil(h / CELL);
  const removedIn = new Uint32Array(cw * ch);
  const addedIn = new Uint32Array(cw * ch);

  for (let p = 0, i = 0; p < a.length; p++, i += 4) {
    let c: readonly number[] = [255, 255, 255];
    if (a[p] && !nearB[p]) {
      c = COLOR.removed;
      removedIn[Math.floor(Math.floor(p / w) / CELL) * cw + Math.floor((p % w) / CELL)]++;
    } else if (b[p] && !nearA[p]) {
      c = COLOR.added;
      addedIn[Math.floor(Math.floor(p / w) / CELL) * cw + Math.floor((p % w) / CELL)]++;
    } else if (a[p] || b[p]) {
      c = COLOR.same;
    }
    out.data[i] = c[0];
    out.data[i + 1] = c[1];
    out.data[i + 2] = c[2];
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);

  // Group changed cells into areas (8-connected), one box per area.
  const hot = (k: number) => removedIn[k] + addedIn[k] >= MIN_PIXELS;
  const seen = new Uint8Array(cw * ch);
  const regions: Region[] = [];
  for (let k = 0; k < cw * ch; k++) {
    if (seen[k] || !hot(k)) continue;
    let x0 = cw, y0 = ch, x1 = 0, y1 = 0, removed = 0, added = 0;
    const stack = [k];
    seen[k] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      const cx = cur % cw;
      const cy = Math.floor(cur / cw);
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      removed += removedIn[cur];
      added += addedIn[cur];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nk = ny * cw + nx;
          if (!seen[nk] && hot(nk)) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
    }
    const kind = removed > added * 4 ? "removed" : added > removed * 4 ? "added" : "changed";
    regions.push({ n: 0, x: Math.max(0, (x0 - 1) * CELL), y: Math.max(0, (y0 - 1) * CELL), w: (x1 - x0 + 3) * CELL, h: (y1 - y0 + 3) * CELL, kind });
  }
  // Reading order: top to bottom, then left to right.
  regions.sort((r, s) => Math.floor(r.y / 200) - Math.floor(s.y / 200) || r.x - s.x);
  regions.forEach((r, i) => (r.n = i + 1));

  ctx.lineWidth = 3;
  ctx.font = "bold 22px system-ui, sans-serif";
  for (const r of regions) {
    ctx.strokeStyle = "#d97706";
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    const label = String(r.n);
    const lw = ctx.measureText(label).width + 12;
    ctx.fillStyle = "#d97706";
    ctx.fillRect(r.x, Math.max(0, r.y - 28), lw, 28);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, r.x + 6, Math.max(20, r.y - 7));
  }
  return { canvas, regions };
}

type View = "changes" | "before" | "after";
const ZOOMS = [1, 1.5, 2, 3, 4];
/** Width over height until a sheet is drawn: A-series landscape, which P&IDs are issued on. */
const DEFAULT_ASPECT = Math.SQRT2;

export function DrawingDiff({ projectId, before, after }: { projectId: string; before: DiffDocument; after: DiffDocument }) {
  const [pageBefore, setPageBefore] = useState(1);
  const [pageAfter, setPageAfter] = useState(1);
  const [pages, setPages] = useState<{ before: number; after: number }>({ before: before.pageCount ?? 1, after: after.pageCount ?? 1 });
  const [view, setView] = useState<View>("changes");
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<{ state: "loading" | "ready" | "error"; message?: string }>({ state: "loading" });
  const [regions, setRegions] = useState<Region[]>([]);
  const [sizeWarning, setSizeWarning] = useState(false);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const docs = useRef<{ before?: PdfDoc; after?: PdfDoc; key?: string }>({});
  const host = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canvases = useRef<Record<View, HTMLCanvasElement | null>>({ changes: null, before: null, after: null });

  // Load both PDFs once per pair.
  const loadDocs = useCallback(async () => {
    const key = `${before.id}|${after.id}`;
    if (docs.current.key === key && docs.current.before && docs.current.after) return docs.current as Required<typeof docs.current>;
    const lib = await loadPdfjs();
    const fetchPdf = async (id: string) => {
      const res = await fetch(`/projects/${projectId}/documents/${id}/file`);
      if (!res.ok) throw new Error(`Could not load the drawing (${res.status}).`);
      return lib.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
    };
    const [b, a] = await Promise.all([fetchPdf(before.id), fetchPdf(after.id)]);
    docs.current = { before: b, after: a, key };
    setPages({ before: b.numPages, after: a.numPages });
    return docs.current as Required<typeof docs.current>;
  }, [projectId, before.id, after.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus({ state: "loading" });
      try {
        const d = await loadDocs();
        const pb = Math.min(pageBefore, d.before.numPages);
        const pa = Math.min(pageAfter, d.after.numPages);
        const [cb, ca] = await Promise.all([renderPage(d.before, pb, WIDTH), renderPage(d.after, pa, WIDTH)]);
        if (cancelled) return;
        // Give the browser a frame to paint "Comparing..." before the pixel pass.
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const { canvas, regions: found } = compare(cb, ca);
        if (cancelled) return;
        canvases.current = { changes: canvas, before: cb, after: ca };
        setSizeWarning(Math.abs(cb.height / cb.width - ca.height / ca.width) > 0.01);
        setAspect(canvas.width / canvas.height);
        setRegions(found);
        setStatus({ state: "ready" });
      } catch (err) {
        if (!cancelled) setStatus({ state: "error", message: err instanceof Error ? err.message : "The drawings could not be compared." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDocs, pageBefore, pageAfter]);

  // Show the chosen canvas, scaled by the zoom.
  useEffect(() => {
    const el = host.current;
    const canvas = canvases.current[view];
    if (!el || !canvas || status.state !== "ready") return;
    canvas.style.width = `${zoom * 100}%`;
    canvas.style.height = "auto";
    canvas.style.display = "block";
    el.replaceChildren(canvas);
  }, [view, zoom, status]);

  function goTo(r: Region) {
    const target = Math.max(zoom, 3);
    setView("changes");
    setZoom(target);
    requestAnimationFrame(() => {
      const box = scroller.current;
      const canvas = canvases.current.changes;
      if (!box || !canvas) return;
      const scale = (box.clientWidth * target) / canvas.width;
      box.scrollTo({ left: (r.x + r.w / 2) * scale - box.clientWidth / 2, top: (r.y + r.h / 2) * scale - box.clientHeight / 2, behavior: "smooth" });
    });
  }

  const pageOptions = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const counts = { added: regions.filter((r) => r.kind === "added").length, removed: regions.filter((r) => r.kind === "removed").length, changed: regions.filter((r) => r.kind === "changed").length };

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="field-label">Earlier sheet</span>
          <select value={pageBefore} onChange={(e) => setPageBefore(Number(e.target.value))} className="input input-sm w-auto">
            {pageOptions(pages.before).map((n) => (
              <option key={n} value={n}>
                Page {n}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="field-label">Latest sheet</span>
          <select value={pageAfter} onChange={(e) => setPageAfter(Number(e.target.value))} className="input input-sm w-auto">
            {pageOptions(pages.after).map((n) => (
              <option key={n} value={n}>
                Page {n}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-1" role="group" aria-label="Show">
          {(
            [
              ["changes", "Changes"],
              ["before", "Earlier"],
              ["after", "Latest"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={`btn btn-sm ${view === v ? "btn-primary" : "btn-secondary"}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Zoom">
          <button type="button" className="btn btn-secondary btn-sm" aria-label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)] ?? 1)}>
            −
          </button>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn-secondary btn-sm" aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)] ?? 1)}>
            +
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setZoom(1)}>
            Fit
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(${COLOR.removed.join(",")})` }} /> Removed (earlier only)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(${COLOR.added.join(",")})` }} /> Added (latest only)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(${COLOR.same.join(",")})` }} /> Unchanged
        </span>
        {status.state === "ready" && (
          <span className="ml-auto font-medium text-foreground">
            {regions.length === 0 ? "No differences found" : `${regions.length} changed area${regions.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>

      {sizeWarning && (
        <p className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs">
          The two sheets are different sizes or shapes, so they cannot line up exactly and most of the sheet may show as changed. Check that the right pages are paired.
        </p>
      )}

      {/* Shaped like the sheet, so Fit shows all of it: as wide as the card allows, but no
          taller than 80vh, narrowing to keep the shape on a short screen. */}
      <div
        ref={scroller}
        className={`relative mx-auto w-full rounded-lg border bg-white ${zoom === 1 ? "overflow-hidden" : "overflow-auto"}`}
        style={{ aspectRatio: `${aspect}`, maxWidth: `calc(80vh * ${aspect})` }}
      >
        {status.state !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {status.state === "loading" ? "Drawing and comparing the two sheets…" : status.message}
          </div>
        )}
        <div ref={host} />
      </div>

      {status.state === "ready" && regions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Changed areas">
          {regions.slice(0, 120).map((r) => (
            <button
              key={r.n}
              type="button"
              onClick={() => goTo(r)}
              className={`btn btn-xs ${r.kind === "removed" ? "btn-danger" : "btn-secondary"}`}
              title={r.kind === "added" ? "Added" : r.kind === "removed" ? "Removed" : "Added and removed"}
            >
              {r.n} · {r.kind}
            </button>
          ))}
          {regions.length > 120 && <span className="text-xs text-muted-foreground">+{regions.length - 120} more</span>}
          <span className="ml-auto text-xs text-muted-foreground">
            {counts.changed} changed · {counts.added} added · {counts.removed} removed
          </span>
        </div>
      )}
    </div>
  );
}
