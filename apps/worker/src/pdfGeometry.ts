// Reads a PDF page's DRAWN GEOMETRY -- the actual line and shape paths -- rather
// than a picture of it.
//
// Why this exists: on a CAD-exported isometric, a weld is a small filled dot on
// the pipe with a thin leader line running out to a hexagonal flag carrying its
// number. Working out which flag belongs to which dot is the step that vision
// keeps getting wrong: the leaders are long, they cross each other and they
// cross the pipe, so it is line-tracing rather than recognition. The same sheet,
// cropped and asked three times, gave three different answers.
//
// But the drawing is still vector. Every leader and every dot is a real path in
// the content stream, so following a leader from its dot to its flag is graph
// work, not perception -- deterministic, repeatable and free.
//
// Text is NOT recoverable this way on these sheets: the exporter outlines it, so
// `getTextContent()` returns nothing and a weld's number is a set of glyph
// paths. That is fine for what this module is for -- the weld list table already
// says which weld IDs exist, so the open question is only which mark is which.
import { readFile } from "node:fs/promises";
// Must come before the pdf.js require -- see pdfPolyfills.ts.
import "./pdfPolyfills";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

export interface Point {
  x: number;
  y: number;
}

export interface GeomPath {
  /** Points in PDF user space, CTM already applied, y still PDF-up. */
  points: Point[];
  /** Line width in user space, after the CTM's scale. */
  lineWidth: number;
  /** How the path was painted: stroked, filled, or both. */
  paint: "stroke" | "fill" | "fillStroke" | "none";
  closed: boolean;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** Longest side of the bounding box -- the cheap size test. */
  extent: number;
}

export interface PageGeometry {
  pageNumber: number;
  width: number;
  height: number;
  paths: GeomPath[];
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  // m2 applied first, then m1 -- the order pdf.js's `transform` op composes in.
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function apply(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** How much the matrix scales lengths, averaged over the two axes. */
function scaleOf(m: Matrix): number {
  return (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
}

/** How many pages the document has -- so a script need not hard-code a count. */
export async function readPageCount(filePathOrBuffer: string | Buffer): Promise<number> {
  const data = Buffer.isBuffer(filePathOrBuffer) ? new Uint8Array(filePathOrBuffer) : new Uint8Array(await readFile(filePathOrBuffer));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  return pdf.numPages as number;
}

export async function readPageGeometry(filePathOrBuffer: string | Buffer, pageNumber: number): Promise<PageGeometry> {
  const data = Buffer.isBuffer(filePathOrBuffer) ? new Uint8Array(filePathOrBuffer) : new Uint8Array(await readFile(filePathOrBuffer));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;

  // Start from the viewport's own matrix rather than the identity, so points
  // come out in the same space the rendered image uses -- origin top-left, y
  // down, and the page's /Rotate already taken into account. Without this a
  // rotated sheet's geometry lands transposed against its own page box.
  let ctm: Matrix = [...viewport.transform] as Matrix;
  let lineWidth = 1;
  const stack: Array<{ ctm: Matrix; lineWidth: number }> = [];
  const paths: GeomPath[] = [];

  // constructPath builds the path; the paint operator that follows says what was
  // done with it, so a path is only emitted once its paint op is seen.
  let pending: Array<{ points: Point[]; closed: boolean }> = [];

  const flush = (paint: GeomPath["paint"], closedByOp: boolean) => {
    for (const sub of pending) {
      if (sub.points.length < 2) {
        // A degenerate subpath is still meaningful: a filled dot can come
        // through as a tiny closed run, and a single moveTo is not.
        if (sub.points.length === 0) continue;
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of sub.points) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      paths.push({
        points: sub.points,
        lineWidth,
        paint,
        closed: sub.closed || closedByOp,
        bbox: { x0, y0, x1, y1 },
        extent: Math.max(x1 - x0, y1 - y0),
      });
    }
    pending = [];
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    switch (fn) {
      case OPS.save:
        stack.push({ ctm, lineWidth });
        break;
      case OPS.restore: {
        const prev = stack.pop();
        if (prev) {
          ctm = prev.ctm;
          lineWidth = prev.lineWidth;
        }
        break;
      }
      case OPS.transform:
        ctm = multiply(ctm, args as Matrix);
        break;
      case OPS.setLineWidth:
        lineWidth = (args[0] as number) * scaleOf(ctm);
        break;
      case OPS.constructPath: {
        const [cmds, coords] = args as [number[], number[]];
        let a = 0;
        let cur: Point[] = [];
        let closed = false;
        const push = () => {
          if (cur.length) pending.push({ points: cur, closed });
          cur = [];
          closed = false;
        };
        for (const c of cmds) {
          if (c === OPS.moveTo) {
            push();
            cur = [apply(ctm, coords[a], coords[a + 1])];
            a += 2;
          } else if (c === OPS.lineTo) {
            cur.push(apply(ctm, coords[a], coords[a + 1]));
            a += 2;
          } else if (c === OPS.curveTo) {
            // Only the endpoint is kept: these drawings are polylines with the
            // occasional rounded corner, and control points are not wanted.
            cur.push(apply(ctm, coords[a + 4], coords[a + 5]));
            a += 6;
          } else if (c === OPS.curveTo2 || c === OPS.curveTo3) {
            cur.push(apply(ctm, coords[a + 2], coords[a + 3]));
            a += 4;
          } else if (c === OPS.closePath) {
            closed = true;
          } else if (c === OPS.rectangle) {
            const [rx, ry, rw, rh] = [coords[a], coords[a + 1], coords[a + 2], coords[a + 3]];
            push();
            pending.push({
              points: [
                apply(ctm, rx, ry),
                apply(ctm, rx + rw, ry),
                apply(ctm, rx + rw, ry + rh),
                apply(ctm, rx, ry + rh),
              ],
              closed: true,
            });
            a += 4;
          }
        }
        push();
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
        flush("stroke", fn === OPS.closeStroke);
        break;
      case OPS.fill:
      case OPS.eoFill:
        flush("fill", true);
        break;
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        flush("fillStroke", fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke);
        break;
      case OPS.endPath:
        flush("none", false);
        break;
      default:
        break;
    }
  }

  return { pageNumber, width: viewport.width, height: viewport.height, paths };
}
