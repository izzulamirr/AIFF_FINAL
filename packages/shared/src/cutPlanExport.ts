// Exporting a cutting plan.
//
// A plan that only exists as a web page is a plan that stops at the office.
// The shop wants paper or a PDF; the CAM programmer wants geometry he can
// load, snap to and post. So the same nest is written out two ways:
//
//   PDF  -- to scale, one page per plate, for issue and for the wall.
//   DXF  -- the real cut contours as closed polylines in millimetres, on
//           layers, ready to open in AutoCAD.
//
// Not DWG. DWG is a closed binary format with no published specification and
// no trustworthy writer outside Autodesk's own libraries -- the LibreDWG we
// already use for reading has no usable write path. DXF is the interchange
// format that exists precisely for this, AutoCAD opens it natively, and
// "Save As -> DWG" from there is one step. Emitting a half-correct DWG would
// be worse than not emitting one.
//
// Both writers are dependency-free: this package must stay importable from the
// browser (the nest runs client-side) and from a plain node script, and a PDF
// toolkit in either place would be a large dependency for two pages of vector
// output.

// ---------------------------------------------------------------------------
// The drawing model
//
// Neither writer knows anything about nesting. They take geometry already
// placed on a plate, which is what lets the true-shape nester and the
// bounding-box nester share them.
// ---------------------------------------------------------------------------

export type Pt = [number, number];

export interface CutPlanLoop {
  // In the piece's own frame: origin at the top-left of its bounding box,
  // x right, y DOWN (screen convention, matching the nester).
  points: Pt[];
  closed: boolean;
  // A loop that is metal removed rather than metal kept. Drawn, but never
  // filled and never written on.
  hole: boolean;
}

export interface CutPlanPiece {
  partNo: string;
  instance: number;
  // Top-left of the bounding box, in plate coordinates, y down.
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  // Informational only -- loops arrive already rotated.
  rotationDeg: number;
  loops: CutPlanLoop[];
  // 0-based index into a palette, so a part reads as the same colour on every
  // plate and in the tables.
  colourIndex: number;
}

export interface CutPlanSheet {
  index: number; // 1-based
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  material: string | null;
  kerfMm: number;
  spacingMm: number;
  edgeMarginMm: number;
  pieces: CutPlanPiece[];
  // The far-end strip left whole, where the layout leaves one.
  remnant: { lengthMm: number; widthMm: number } | null;
}

export interface CutPlanDocument {
  title: string;
  subtitle: string;
  // A fingerprint of the layout itself. Printed on both files so a PDF and a
  // DXF can be told apart at a glance when one of them is stale -- two exports
  // of the same nest carry the same id, two different nests never do.
  planId?: string;
  // Label/value pairs across the top of every plate page.
  stats: Array<{ label: string; value: string }>;
  // Free text under the drawing -- allowances, verification, caveats.
  notes: string[];
  sheets: CutPlanSheet[];
  // The part list, printed on a final page.
  partList: Array<{ partNo: string; sizeMm: string; quantity: number; note: string; colourIndex: number }>;
}

// Distinct enough to tell twenty parts apart in print, and dark enough that a
// part mark stays readable on top of one.
export const CUT_PLAN_COLOURS: Array<[number, number, number]> = [
  [0.145, 0.388, 0.922],
  [0.086, 0.639, 0.290],
  [0.918, 0.345, 0.047],
  [0.576, 0.200, 0.918],
  [0.033, 0.569, 0.698],
  [0.792, 0.541, 0.016],
  [0.863, 0.149, 0.149],
  [0.310, 0.275, 0.898],
  [0.020, 0.588, 0.412],
  [0.859, 0.153, 0.467],
];

// AutoCAD Color Index numbers matching the palette above closely enough that a
// DXF opened next to the PDF reads as the same drawing.
const ACI_BY_COLOUR = [5, 3, 30, 200, 4, 40, 1, 170, 90, 240];

// ---------------------------------------------------------------------------
// Shared geometry helpers
// ---------------------------------------------------------------------------

// Where to put a part's name so it lands ON the part. The centre of the
// bounding box is not that point: on a concave profile -- an angle, a gusset
// with a bite out of it -- the box centre falls in the notch, outside the
// metal. This finds the interior point furthest from any edge (the pole of
// inaccessibility) by rasterising the piece and running a two-pass chamfer
// distance transform, and returns that distance too, which is the radius of
// the largest circle that fits inside the part and therefore how big the text
// is allowed to be.
export function labelAnchor(loops: CutPlanLoop[], wMm: number, hMm: number): { x: number; y: number; r: number } {
  const cell = Math.max(2, Math.max(wMm, hMm) / 200);
  const gw = Math.max(1, Math.ceil(wMm / cell));
  const gh = Math.max(1, Math.ceil(hMm / cell));
  const solid = new Uint8Array(gw * gh);

  const scan = (points: Pt[], set: boolean) => {
    const edges: Array<[number, number, number, number]> = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
    if (!edges.length) return;
    for (let row = 0; row < gh; row++) {
      const y = (row + 0.5) * cell;
      const xs: number[] = [];
      for (const [x1, y1, x2, y2] of edges) {
        if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] / cell));
        const c1 = Math.min(gw - 1, Math.floor(xs[k + 1] / cell));
        for (let c = c0; c <= c1; c++) solid[row * gw + c] = set ? 1 : 0;
      }
    }
  };

  // Solid loops one at a time and OR-ed -- a union, not an even-odd fill. Two
  // solid loops that overlap (a boss sitting on a body) would cancel each
  // other under even-odd and leave a hole through solid metal.
  for (const loop of loops) if (!loop.hole) scan(loop.points, true);
  // A hole is not somewhere to write either.
  for (const loop of loops) if (loop.hole) scan(loop.points, false);

  const INF = 1e9;
  const dist = new Float32Array(gw * gh);
  for (let i = 0; i < dist.length; i++) dist[i] = solid[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : dist[y * gw + x]);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (!solid[i]) continue;
      dist[i] = Math.min(dist[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.4142, at(x + 1, y - 1) + 1.4142);
    }
  }
  for (let y = gh - 1; y >= 0; y--) {
    for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x;
      if (!solid[i]) continue;
      dist[i] = Math.min(dist[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.4142, at(x - 1, y + 1) + 1.4142);
    }
  }

  let best = -1;
  let bx = gw / 2;
  let by = gh / 2;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const v = dist[y * gw + x];
      if (v > best && v < INF) {
        best = v;
        bx = x;
        by = y;
      }
    }
  }
  // Nothing was solid (a piece with no loops): fall back to the box centre.
  if (best < 0) return { x: wMm / 2, y: hMm / 2, r: Math.min(wMm, hMm) / 2 };
  return { x: (bx + 0.5) * cell, y: (by + 0.5) * cell, r: best * cell };
}

// Is this point on the part's metal? Union of the solid loops, minus the
// holes -- the same rule the fills and the nester use.
function onMetal(pt: Pt, loops: CutPlanLoop[]): boolean {
  const crosses = (ring: Pt[]) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  let solid = false;
  for (const loop of loops) if (!loop.hole && crosses(loop.points)) solid = true;
  if (!solid) return false;
  for (const loop of loops) if (loop.hole && crosses(loop.points)) return false;
  return true;
}

/**
 * The largest text height at which the whole mark sits on the part's metal.
 *
 * The inscribed radius that sizes the label comes from a distance transform on
 * a raster, and a raster rounds -- so a height derived from it can put a
 * corner of the text a few millimetres over the cut line. Rather than pad the
 * estimate and make every label smaller than it needs to be, the box itself is
 * tested against the outline and shrunk only while it actually overhangs.
 */
export function fitLabelHeight(
  text: string,
  anchor: { x: number; y: number },
  loops: CutPlanLoop[],
  maxHeight: number,
  // Width per unit of height. Helvetica's own metrics are right for the PDF,
  // where we control the font; a DXF is drawn by CAD in whatever text style it
  // resolves -- usually txt.shx, which is wider than Helvetica. Fitting to the
  // narrower font would let the mark overhang the cut line in the very program
  // the file is opened in.
  unitsOverride?: number
): number {
  const units = Math.max(1, unitsOverride ?? textWidth(text, 1));
  let height = maxHeight;
  for (let attempt = 0; attempt < 12; attempt++) {
    const halfW = (units * height) / 2;
    const halfH = height / 2;
    // Corners and edge midpoints: a concave edge can cut into the middle of a
    // side without touching either corner.
    const probes: Pt[] = [
      [anchor.x - halfW, anchor.y - halfH],
      [anchor.x + halfW, anchor.y - halfH],
      [anchor.x - halfW, anchor.y + halfH],
      [anchor.x + halfW, anchor.y + halfH],
      [anchor.x, anchor.y - halfH],
      [anchor.x, anchor.y + halfH],
      [anchor.x - halfW, anchor.y],
      [anchor.x + halfW, anchor.y],
    ];
    if (probes.every((pt) => onMetal(pt, loops))) return height;
    height *= 0.85;
  }
  return height;
}

// Helvetica's real advance widths vary by about a third between "l" and "W",
// which is enough to throw a centred part mark visibly off. This is not the
// full AFM table -- it is the three classes that matter, which centres a part
// mark to within a percent or so of true.
function textWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) {
    if ("iljI|.,:;'`!" .includes(ch)) units += 0.28;
    else if ("frt()[]{}/\\-" .includes(ch)) units += 0.36;
    else if ("MWmw@%" .includes(ch)) units += 0.85;
    else if (ch === " ") units += 0.28;
    else units += 0.58;
  }
  return units * size;
}

// The writers are ASCII-only by construction: PDF string escaping and DXF
// group values both have encoding rules that are not worth carrying for the
// sake of an em dash in a note.
function ascii(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/×/g, "x")
    .replace(/²/g, "2")
    .replace(/°/g, " deg")
    .replace(/[^\x20-\x7e]/g, "");
}

// ---------------------------------------------------------------------------
// PDF
//
// Written by hand against the PDF 1.4 spec. Only what a technical drawing
// needs: vector paths, filled and stroked, and text in the two standard
// Helvetica faces, which every reader has built in so nothing is embedded.
// ---------------------------------------------------------------------------

// The colour mixed towards the plate's own white. Used instead of alpha so
// that overlapping fills of the same colour land on the same value.
function tint(rgb: [number, number, number], amount = 0.22): [number, number, number] {
  return [
    amount * rgb[0] + (1 - amount) * 0.984,
    amount * rgb[1] + (1 - amount) * 0.984,
    amount * rgb[2] + (1 - amount) * 0.98,
  ];
}

const PT_PER_MM = 72 / 25.4;
// A3 landscape, in points. Big enough to read a 12 m plate at 1:100.
const PAGE_W = 420 * PT_PER_MM;
const PAGE_H = 297 * PT_PER_MM;
const MARGIN = 12 * PT_PER_MM;

class Content {
  private parts: string[] = [];

  private n(value: number): string {
    // Three decimals is a thousandth of a point. Trailing zeros are dropped
    // because a content stream of a 21-part nest is mostly numbers.
    return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
  }

  push(line: string) {
    this.parts.push(line);
  }

  save() {
    this.push("q");
  }

  restore() {
    this.push("Q");
  }

  fillColour(rgb: [number, number, number]) {
    this.push(`${this.n(rgb[0])} ${this.n(rgb[1])} ${this.n(rgb[2])} rg`);
  }

  strokeColour(rgb: [number, number, number]) {
    this.push(`${this.n(rgb[0])} ${this.n(rgb[1])} ${this.n(rgb[2])} RG`);
  }

  lineWidth(w: number) {
    this.push(`${this.n(w)} w`);
  }

  alpha(name: string) {
    this.push(`/${name} gs`);
  }

  rect(x: number, y: number, w: number, h: number, op: "f" | "S" | "B") {
    this.push(`${this.n(x)} ${this.n(y)} ${this.n(w)} ${this.n(h)} re ${op}`);
  }

  poly(points: Pt[], closed: boolean, op: "f" | "S" | "B" | "n") {
    if (points.length < 2) return;
    this.push(`${this.n(points[0][0])} ${this.n(points[0][1])} m`);
    for (let i = 1; i < points.length; i++) this.push(`${this.n(points[i][0])} ${this.n(points[i][1])} l`);
    if (closed) this.push("h");
    this.push(op);
  }

  line(x1: number, y1: number, x2: number, y2: number) {
    this.push(`${this.n(x1)} ${this.n(y1)} m ${this.n(x2)} ${this.n(y2)} l S`);
  }

  // x,y is the text baseline origin in page points, y up.
  text(x: number, y: number, size: number, str: string, opts: { bold?: boolean; align?: "left" | "centre" | "right" } = {}) {
    const clean = ascii(str);
    if (!clean) return;
    const w = textWidth(clean, size);
    const dx = opts.align === "centre" ? -w / 2 : opts.align === "right" ? -w : 0;
    const escaped = clean.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    this.push(
      `BT /${opts.bold ? "F2" : "F1"} ${this.n(size)} Tf ${this.n(x + dx)} ${this.n(y)} Td (${escaped}) Tj ET`
    );
  }

  toString(): string {
    return this.parts.join("\n");
  }
}

function pdfBytes(objects: string[]): Uint8Array {
  const header = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  let body = "";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(header.length + body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  const text = header + body + xref + trailer;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * The plan as a PDF: one page per plate, drawn to scale, plus a final page
 * carrying the part list and the cut list.
 */
export function cutPlanToPdf(doc: CutPlanDocument): Uint8Array {
  const pages: Array<{ content: string }> = [];

  // A wide plate on a landscape sheet leaves the bottom third empty. That gap
  // is where the cut list for that plate belongs -- the fabricator setting up
  // wants the positions next to the picture, not on another sheet. Only the
  // plates whose list did not fit are carried over to the summary page.
  const carried: CutPlanSheet[] = [];
  for (const sheet of doc.sheets) {
    const page = sheetPage(doc, sheet);
    if (!page.printedCutList) carried.push(sheet);
    pages.push({ content: page.content });
  }
  pages.push({ content: listPage(doc, carried) });

  // 1 catalog, 2 pages, 3 F1, 4 F2, 5 ExtGState, then content/page pairs.
  const objects: string[] = [];
  const pageIds: number[] = [];
  objects.push(""); // 1 catalog, patched below
  objects.push(""); // 2 pages, patched below
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  // Kept so the resource dictionary stays valid for older files; nothing in
  // the content stream uses transparency any more (see tint()).
  objects.push("<< /Type /ExtGState /ca 1 /CA 1 >>");

  for (const page of pages) {
    objects.push(`<< /Length ${page.content.length} >>\nstream\n${page.content}\nendstream`);
    const streamId = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GSA 5 0 R >> >> /Contents ${streamId} 0 R >>`
    );
    pageIds.push(objects.length);
  }

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  return pdfBytes(objects);
}

function header(c: Content, doc: CutPlanDocument, sub: string): number {
  let y = PAGE_H - MARGIN - 13;
  c.fillColour([0.06, 0.09, 0.16]);
  c.text(MARGIN, y, 15, doc.title, { bold: true });
  if (doc.planId) {
    c.fillColour([0.42, 0.47, 0.53]);
    c.text(PAGE_W - MARGIN, y, 9, `layout ${doc.planId}`, { align: "right" });
  }
  y -= 13;
  c.fillColour([0.35, 0.4, 0.47]);
  c.text(MARGIN, y, 8.5, sub);
  y -= 6;
  return y;
}

function statsRow(c: Content, doc: CutPlanDocument, top: number): number {
  const boxH = 30;
  const boxW = (PAGE_W - 2 * MARGIN - (doc.stats.length - 1) * 6) / Math.max(1, doc.stats.length);
  let x = MARGIN;
  for (const stat of doc.stats) {
    c.strokeColour([0.8, 0.84, 0.88]);
    c.lineWidth(0.6);
    c.rect(x, top - boxH, boxW, boxH, "S");
    c.fillColour([0.42, 0.47, 0.53]);
    c.text(x + 5, top - 11, 6.5, stat.label.toUpperCase());
    c.fillColour([0.06, 0.09, 0.16]);
    c.text(x + 5, top - 24, 11, stat.value, { bold: true });
    x += boxW + 6;
  }
  return top - boxH - 10;
}

function sheetPage(doc: CutPlanDocument, sheet: CutPlanSheet): { content: string; printedCutList: boolean } {
  const c = new Content();
  const plateLabel =
    `Plate ${sheet.index} of ${doc.sheets.length}  -  ${sheet.lengthMm} x ${sheet.widthMm} x ${sheet.thicknessMm} mm` +
    (sheet.material ? `  ${sheet.material}` : "");
  let y = header(c, doc, `${plateLabel}   |   ${doc.subtitle}`);
  y = statsRow(c, doc, y);

  // Notes go at the foot, so measure them first and give the drawing the rest.
  const noteSize = 7.6;
  const noteLines: string[] = [];
  for (const note of doc.notes) noteLines.push(...wrap(note, PAGE_W - 2 * MARGIN, noteSize));
  const notesH = noteLines.length * (noteSize + 2.4) + 6;

  const availW = PAGE_W - 2 * MARGIN;
  const availH = y - MARGIN - notesH - 16;
  // 14 mm of the drawing area is kept for the plate's own dimension text.
  const scale = Math.min((availW - 26) / sheet.lengthMm, (availH - 26) / sheet.widthMm);
  const drawW = sheet.lengthMm * scale;
  const drawH = sheet.widthMm * scale;
  const ox = MARGIN + (availW - drawW) / 2;
  // Hung from the top of the drawing area rather than centred in it: a plate
  // four times as long as it is wide leaves a deep band of nothing, and that
  // band is worth more as one block under the drawing (where the cut list
  // goes) than split into two useless halves above and below it.
  const oyTop = y - 14;

  // Inside this transform, x is right and y is DOWN in millimetres, which is
  // the frame the nester works in -- so placements go straight in with no
  // per-point arithmetic and no chance of a sign error in it.
  const toPage = (x: number, yDown: number): Pt => [ox + x * scale, oyTop - yDown * scale];

  c.save();
  c.push(`${scale} 0 0 ${-scale} ${ox} ${oyTop} cm`);
  c.lineWidth(0.5 / scale);

  // The plate.
  c.fillColour([0.984, 0.984, 0.98]);
  c.rect(0, 0, sheet.lengthMm, sheet.widthMm, "f");

  // The remnant, called out so nobody weighs in a usable strip.
  if (sheet.remnant && sheet.remnant.lengthMm > 0) {
    c.fillColour(tint([0.133, 0.773, 0.369], 0.28));
    c.rect(sheet.lengthMm - sheet.remnant.lengthMm, 0, sheet.remnant.lengthMm, sheet.remnant.widthMm, "f");
  }

  // The edge margin: the band the torch must stay out of.
  c.strokeColour([0.8, 0.84, 0.88]);
  c.lineWidth(0.4 / scale);
  c.rect(sheet.edgeMarginMm, sheet.edgeMarginMm, sheet.lengthMm - 2 * sheet.edgeMarginMm, sheet.widthMm - 2 * sheet.edgeMarginMm, "S");

  c.strokeColour([0.06, 0.09, 0.16]);
  c.lineWidth(1.2 / scale);
  c.rect(0, 0, sheet.lengthMm, sheet.widthMm, "S");

  // The pieces. Fill first for every piece, then the cut lines, so a fill can
  // never paint over a neighbour's contour.
  for (const piece of sheet.pieces) {
    const rgb = CUT_PLAN_COLOURS[piece.colourIndex % CUT_PLAN_COLOURS.length];
    // Each solid loop filled separately: one path plus a winding rule would
    // cancel two loops that wind opposite ways, which is how a boss overlapping
    // a body turns into a hole through solid metal.
    //
    // Filled with an OPAQUE tint rather than a translucent full-strength
    // colour. Two overlapping loops of the same part -- a boss sitting on a
    // body -- would each lay down their own alpha and show the overlap as a
    // darker patch, which reads as a feature that is not there. An opaque tint
    // paints the same value twice and merges cleanly, and it also keeps
    // transparency out of a file that is going to a plotter.
    c.save();
    c.push(`1 0 0 1 ${piece.xMm} ${piece.yMm} cm`);
    c.fillColour(tint(rgb));
    for (const loop of piece.loops) if (!loop.hole) c.poly(loop.points, true, "f");
    // A hole is metal removed, so it goes back to plate colour -- painted after
    // the body, in the same pass, so it can never be tinted by it.
    c.fillColour([0.984, 0.984, 0.98]);
    for (const loop of piece.loops) if (loop.hole) c.poly(loop.points, true, "f");
    c.restore();
  }

  for (const piece of sheet.pieces) {
    const rgb = CUT_PLAN_COLOURS[piece.colourIndex % CUT_PLAN_COLOURS.length];
    c.save();
    c.push(`1 0 0 1 ${piece.xMm} ${piece.yMm} cm`);
    c.strokeColour(rgb);
    c.lineWidth(1.1 / scale);
    for (const loop of piece.loops) c.poly(loop.points, loop.closed, "S");
    c.restore();
  }
  c.restore();

  // Text is drawn in page space, not inside the flipped transform -- a mirrored
  // CTM would mirror the glyphs with it.
  const baseText = Math.max(5, Math.min(9, drawH / 26));

  // Labels that will not fit inside their part have to go somewhere, and a
  // cluster of small parts sends them all to the same somewhere -- which is
  // how a nest of eight pads ends up with eight marks printed on top of each
  // other and none of them readable. So every label claims a rectangle, and a
  // label that would land on a claimed one is moved before it is drawn.
  const claimed: Array<[number, number, number, number]> = [];
  const clashes = (x: number, y: number, w: number, h: number) =>
    claimed.some(([cx, cy, cw, ch]) => x < cx + cw && x + w > cx && y < cy + ch && y + h > cy);

  // Biggest first: a large part's label is the one that cannot move far, so it
  // picks its spot before the small ones have to work around each other.
  const labelled = sheet.pieces
    .map((piece) => ({ piece, anchor: labelAnchor(piece.loops, piece.wMm, piece.hMm) }))
    .sort((a, b) => b.anchor.r - a.anchor.r);

  for (const { piece, anchor } of labelled) {
    const rgb = CUT_PLAN_COLOURS[piece.colourIndex % CUT_PLAN_COLOURS.length];
    // Sized to the room actually there: the inscribed circle is 2r across,
    // and the mark has to fit inside it.
    const room = 2 * anchor.r * scale * 0.86;
    const inSize = Math.min(baseText, room / Math.max(1, textWidth(piece.partNo, 1)), 2 * anchor.r * scale * 0.8);
    const at = toPage(piece.xMm + anchor.x, piece.yMm + anchor.y);

    if (inSize >= 4.2) {
      // It fits on the part. An inside label sits on its own metal, so it can
      // only collide with somebody else's leader text -- claim it and move on.
      const w = textWidth(piece.partNo, inSize);
      claimed.push([at[0] - w / 2, at[1] - inSize * 0.7, w, inSize * 1.4]);
      c.fillColour([0.06, 0.09, 0.16]);
      c.text(at[0], at[1] - inSize * 0.34, inSize, piece.partNo, { align: "centre", bold: true });
      continue;
    }

    // Too small to write on. Try the free space around it, nearest first, and
    // only give up on finding clear space after everything has been tried.
    const size = Math.max(4.4, baseText * 0.62);
    const w = textWidth(piece.partNo, size);
    const h = size * 1.35;
    const boxTop = toPage(piece.xMm + piece.wMm / 2, piece.yMm);
    const boxBottom = toPage(piece.xMm + piece.wMm / 2, piece.yMm + piece.hMm);
    const boxLeft = toPage(piece.xMm, piece.yMm + piece.hMm / 2);
    const boxRight = toPage(piece.xMm + piece.wMm, piece.yMm + piece.hMm / 2);
    const step = h * 1.1;
    const candidates: Pt[] = [];
    for (let ring = 0; ring < 5; ring++) {
      candidates.push([boxTop[0], boxTop[1] + h * 0.7 + ring * step]);
      candidates.push([boxBottom[0], boxBottom[1] - h * 0.7 - ring * step]);
      candidates.push([boxRight[0] + w / 2 + 3 + ring * step, boxRight[1]]);
      candidates.push([boxLeft[0] - w / 2 - 3 - ring * step, boxLeft[1]]);
    }
    const spot =
      candidates.find(
        (pt) =>
          !clashes(pt[0] - w / 2, pt[1] - h / 2, w, h) &&
          pt[0] - w / 2 > MARGIN &&
          pt[0] + w / 2 < PAGE_W - MARGIN &&
          pt[1] - h / 2 > MARGIN &&
          pt[1] + h / 2 < PAGE_H - MARGIN
      ) ?? candidates[0];

    claimed.push([spot[0] - w / 2, spot[1] - h / 2, w, h]);
    // A leader, because a label that has moved this far is otherwise a mark
    // floating on bare plate with nothing to say which part it names.
    c.strokeColour(rgb);
    c.lineWidth(0.4);
    c.line(spot[0], spot[1] + (spot[1] > at[1] ? -h * 0.45 : h * 0.45), at[0], at[1]);
    c.fillColour([0.06, 0.09, 0.16]);
    c.text(spot[0], spot[1] - size * 0.34, size, piece.partNo, { align: "centre", bold: true });
  }

  // Plate dimensions.
  c.fillColour([0.06, 0.09, 0.16]);
  c.text(ox + drawW / 2, oyTop + 5, 8, `${sheet.lengthMm} mm`, { align: "centre" });
  c.text(ox - 4, oyTop - drawH / 2, 8, `${sheet.widthMm} mm`, { align: "right" });
  c.fillColour([0.42, 0.47, 0.53]);
  c.text(ox + drawW, oyTop - drawH - 9, 7, `scale 1:${Math.round(1 / (scale / PT_PER_MM))}`, { align: "right" });

  let ny = MARGIN + notesH - 8;
  c.fillColour([0.28, 0.33, 0.4]);
  for (const line of noteLines) {
    c.text(MARGIN, ny, noteSize, line);
    ny -= noteSize + 2.4;
  }

  // The gap between the drawing and the notes.
  const gapTop = oyTop - drawH - 24;
  const gapBottom = MARGIN + notesH + 6;
  const printedCutList = cutListBlock(c, sheet, gapTop, gapBottom);

  return { content: c.toString(), printedCutList };
}

// The cut list laid into whatever space is left, in as many columns as fit.
// Returns false without drawing anything if the whole list will not fit --
// half a cut list is worse than none, because the missing half looks like
// parts that are not on the plate.
function cutListBlock(c: Content, sheet: CutPlanSheet, top: number, bottom: number): boolean {
  const rowH = 10;
  const colW = 190;
  const gutter = 16;
  const rows = Math.floor((top - bottom - 16) / rowH);
  const cols = Math.floor((PAGE_W - 2 * MARGIN + gutter) / (colW + gutter));
  if (rows < 4 || cols < 1 || rows * cols < sheet.pieces.length) return false;

  const ordered = sheet.pieces.slice().sort((a, b) => a.xMm - b.xMm || a.yMm - b.yMm);
  const perCol = Math.ceil(ordered.length / Math.min(cols, Math.ceil(ordered.length / rows) || 1));

  c.fillColour([0.06, 0.09, 0.16]);
  c.text(MARGIN, top, 9, "Cut list - in order along the plate", { bold: true });

  ordered.forEach((piece, i) => {
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const x = MARGIN + col * (colW + gutter);
    const y = top - 16 - row * rowH;
    if (row === 0) {
      c.fillColour([0.42, 0.47, 0.53]);
      c.text(x, y + 8, 6, "PART");
      c.text(x + 78, y + 8, 6, "X, Y (MM)");
      c.text(x + 148, y + 8, 6, "TURNED");
      c.strokeColour([0.06, 0.09, 0.16]);
      c.lineWidth(0.6);
      c.line(x, y + 5, x + colW, y + 5);
    }
    c.fillColour(CUT_PLAN_COLOURS[piece.colourIndex % CUT_PLAN_COLOURS.length]);
    c.rect(x, y - 0.5, 4.5, 4.5, "f");
    c.fillColour([0.06, 0.09, 0.16]);
    c.text(x + 8, y, 7.5, `${piece.partNo} #${piece.instance}`);
    c.text(x + 78, y, 7.5, `${Math.round(piece.xMm)}, ${Math.round(piece.yMm)}`);
    c.text(x + 148, y, 7.5, piece.rotationDeg ? `${piece.rotationDeg} deg` : "-");
  });
  return true;
}

function wrap(text: string, widthPt: number, size: number): string[] {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) > widthPt && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// The summary page: the part list always, and the cut lists for any plates
// whose own page had no room for one.
function listPage(doc: CutPlanDocument, carried: CutPlanSheet[]): string {
  const c = new Content();
  let y = header(c, doc, `${doc.subtitle}   |   part list and cut list`);
  y -= 8;

  const colW = (PAGE_W - 2 * MARGIN - 18) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colW + 18;

  const swatch = (x: number, yy: number, colourIndex: number) => {
    c.fillColour(CUT_PLAN_COLOURS[colourIndex % CUT_PLAN_COLOURS.length]);
    c.rect(x, yy - 0.5, 5, 5, "f");
  };

  // --- parts -------------------------------------------------------------
  let ly = y;
  c.fillColour([0.06, 0.09, 0.16]);
  c.text(leftX, ly, 10, "Parts", { bold: true });
  ly -= 12;
  c.fillColour([0.42, 0.47, 0.53]);
  c.text(leftX, ly, 6.5, "PART");
  c.text(leftX + 120, ly, 6.5, "SIZE (MM)");
  c.text(leftX + 210, ly, 6.5, "QTY");
  c.text(leftX + 236, ly, 6.5, "NOTE");
  ly -= 3;
  c.strokeColour([0.06, 0.09, 0.16]);
  c.lineWidth(0.8);
  c.line(leftX, ly, leftX + colW, ly);
  ly -= 10;

  for (const part of doc.partList) {
    if (ly < MARGIN + 12) break;
    swatch(leftX, ly, part.colourIndex);
    c.fillColour([0.06, 0.09, 0.16]);
    c.text(leftX + 9, ly, 8, part.partNo);
    c.text(leftX + 120, ly, 8, part.sizeMm);
    c.text(leftX + 210, ly, 8, String(part.quantity));
    c.fillColour([0.42, 0.47, 0.53]);
    c.text(leftX + 236, ly, 7.5, part.note);
    ly -= 11;
    c.strokeColour([0.9, 0.92, 0.94]);
    c.lineWidth(0.4);
    c.line(leftX, ly + 4, leftX + colW, ly + 4);
  }

  // --- cut list ----------------------------------------------------------
  // Empty when every plate carried its own, which is the usual case for a
  // wide plate on a landscape sheet.
  if (carried.length === 0) {
    c.fillColour([0.42, 0.47, 0.53]);
    c.text(rightX, y, 8, "The cut list for each plate is printed on that plate's own page.");
    return c.toString();
  }

  let ry = y;
  c.fillColour([0.06, 0.09, 0.16]);
  c.text(rightX, ry, 10, "Cut list - in order along each plate", { bold: true });
  ry -= 12;
  c.fillColour([0.42, 0.47, 0.53]);
  c.text(rightX, ry, 6.5, "PLATE / PART");
  c.text(rightX + 130, ry, 6.5, "BOX (MM)");
  c.text(rightX + 215, ry, 6.5, "X, Y (MM)");
  c.text(rightX + 300, ry, 6.5, "TURNED");
  ry -= 3;
  c.strokeColour([0.06, 0.09, 0.16]);
  c.lineWidth(0.8);
  c.line(rightX, ry, rightX + colW, ry);
  ry -= 10;

  for (const sheet of carried) {
    const ordered = sheet.pieces.slice().sort((a, b) => a.xMm - b.xMm || a.yMm - b.yMm);
    for (const piece of ordered) {
      if (ry < MARGIN + 12) break;
      swatch(rightX, ry, piece.colourIndex);
      c.fillColour([0.06, 0.09, 0.16]);
      c.text(rightX + 9, ry, 8, `${sheet.index}  ${piece.partNo} #${piece.instance}`);
      c.text(rightX + 130, ry, 8, `${Math.round(piece.wMm)} x ${Math.round(piece.hMm)}`);
      c.text(rightX + 215, ry, 8, `${Math.round(piece.xMm)}, ${Math.round(piece.yMm)}`);
      c.text(rightX + 300, ry, 8, piece.rotationDeg ? `${piece.rotationDeg} deg` : "-");
      ry -= 11;
      c.strokeColour([0.9, 0.92, 0.94]);
      c.lineWidth(0.4);
      c.line(rightX, ry + 4, rightX + colW, ry + 4);
    }
  }

  return c.toString();
}

// ---------------------------------------------------------------------------
// DXF
//
// AutoCAD R12 ASCII. Deliberately the oldest dialect still in general use:
// it needs no handles, no object dictionaries and no class table, which is
// exactly the machinery that makes a hand-written newer DXF fail to load. Every
// CAD and CAM package made since reads R12.
//
// Coordinates are millimetres, and Y is flipped on the way out -- the nester
// works with Y down from the top-left of the plate, CAD works with Y up from
// the bottom-left.
// ---------------------------------------------------------------------------

const LAYERS: Array<{ name: string; aci: number; note: string }> = [
  { name: "PLATE", aci: 7, note: "the stock plate outline" },
  { name: "EDGE_MARGIN", aci: 8, note: "keep-out band along the rolled edge" },
  { name: "CUT", aci: 1, note: "part contours - the torch path" },
  { name: "HOLES", aci: 5, note: "internal cut-outs" },
  { name: "TEXT", aci: 3, note: "part marks" },
  { name: "REMNANT", aci: 3, note: "usable offcut" },
];

class Dxf {
  private out: string[] = [];

  code(code: number, value: string | number) {
    this.out.push(String(code));
    if (typeof value !== "number") {
      this.out.push(value);
      return;
    }
    // Group codes 60-79 and 90-99 are integers in DXF, and a reader handed
    // "1.0000" as a closed-polyline flag rejects the entity. The 10-59 range
    // is real numbers and needs the decimals.
    const isInt = (code >= 60 && code <= 79) || (code >= 90 && code <= 99) || (code >= 170 && code <= 179);
    this.out.push(isInt ? String(Math.round(value)) : trim(value));
  }

  polyline(points: Pt[], closed: boolean, layer: string, aci?: number) {
    if (points.length < 2) return;
    this.code(0, "POLYLINE");
    this.code(8, layer);
    if (aci != null) this.code(62, aci);
    // 66 = "vertices follow", required in R12 and the reason a POLYLINE with
    // no SEQEND is rejected outright.
    this.code(66, 1);
    this.code(10, 0);
    this.code(20, 0);
    this.code(30, 0);
    this.code(70, closed ? 1 : 0);
    for (const [x, y] of points) {
      this.code(0, "VERTEX");
      this.code(8, layer);
      this.code(10, x);
      this.code(20, y);
      this.code(30, 0);
    }
    this.code(0, "SEQEND");
    this.code(8, layer);
  }

  text(x: number, y: number, height: number, value: string, layer: string, centred = true) {
    const clean = ascii(value);
    if (!clean) return;
    this.code(0, "TEXT");
    this.code(8, layer);
    this.code(10, x);
    this.code(20, y);
    this.code(30, 0);
    this.code(40, height);
    this.code(1, clean);
    if (centred) {
      // 72=1 centred, 73=2 middle. Both require the alignment point in 11/21,
      // and the 10/20 pair is then ignored -- writing only one of the three is
      // the usual reason hand-made DXF text lands in the wrong place.
      this.code(72, 1);
      this.code(73, 2);
      this.code(11, x);
      this.code(21, y);
      this.code(31, 0);
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, layer: string) {
    this.code(0, "LINE");
    this.code(8, layer);
    this.code(10, x1);
    this.code(20, y1);
    this.code(30, 0);
    this.code(11, x2);
    this.code(21, y2);
    this.code(31, 0);
  }

  toString(): string {
    return this.out.join("\r\n") + "\r\n";
  }
}

function trim(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  const rounded = Math.round(value * 10000) / 10000;
  return rounded.toFixed(4);
}

/**
 * The plan as an R12 DXF in millimetres. Every plate in one file, stacked with
 * a gap between them and captioned, because a shop that gets six files loses
 * one.
 */
export function cutPlanToDxf(doc: CutPlanDocument): string {
  const d = new Dxf();

  // Plates are stacked upward with a clear gap, tallest first in the y sense.
  const gap = Math.max(200, Math.max(...doc.sheets.map((s) => s.widthMm)) * 0.18);
  const origins: number[] = [];
  let cursor = 0;
  for (const sheet of doc.sheets) {
    origins.push(cursor);
    cursor += sheet.widthMm + gap;
  }
  const extX = Math.max(...doc.sheets.map((s) => s.lengthMm));
  const extY = cursor;

  d.code(0, "SECTION");
  d.code(2, "HEADER");
  d.code(9, "$ACADVER");
  d.code(1, "AC1009");
  d.code(9, "$INSBASE");
  d.code(10, 0);
  d.code(20, 0);
  d.code(30, 0);
  d.code(9, "$EXTMIN");
  d.code(10, 0);
  d.code(20, 0);
  d.code(30, 0);
  d.code(9, "$EXTMAX");
  d.code(10, extX);
  d.code(20, extY);
  d.code(30, 0);
  d.code(9, "$LIMMIN");
  d.code(10, 0);
  d.code(20, 0);
  d.code(9, "$LIMMAX");
  d.code(10, extX);
  d.code(20, extY);
  // 4 = millimetres. R12 predates this variable but readers that understand it
  // will place the drawing in mm instead of guessing, and the rest ignore it.
  d.code(9, "$INSUNITS");
  d.code(70, 4);
  d.code(0, "ENDSEC");

  d.code(0, "SECTION");
  d.code(2, "TABLES");

  d.code(0, "TABLE");
  d.code(2, "LTYPE");
  d.code(70, 1);
  d.code(0, "LTYPE");
  d.code(2, "CONTINUOUS");
  d.code(70, 0);
  d.code(3, "Solid line");
  d.code(72, 65);
  d.code(73, 0);
  d.code(40, 0);
  d.code(0, "ENDTAB");

  d.code(0, "TABLE");
  d.code(2, "LAYER");
  d.code(70, LAYERS.length + 1);
  d.code(0, "LAYER");
  d.code(2, "0");
  d.code(70, 0);
  d.code(62, 7);
  d.code(6, "CONTINUOUS");
  for (const layer of LAYERS) {
    d.code(0, "LAYER");
    d.code(2, layer.name);
    d.code(70, 0);
    d.code(62, layer.aci);
    d.code(6, "CONTINUOUS");
  }
  d.code(0, "ENDTAB");

  // Every TEXT entity refers to a text style, and defaults to STANDARD when it
  // does not name one. A DXF that never defines STANDARD is a DXF whose text
  // may not draw.
  d.code(0, "TABLE");
  d.code(2, "STYLE");
  d.code(70, 1);
  d.code(0, "STYLE");
  d.code(2, "STANDARD");
  d.code(70, 0);
  d.code(40, 0);
  d.code(41, 1);
  d.code(50, 0);
  d.code(71, 0);
  d.code(42, 2.5);
  d.code(3, "txt");
  d.code(4, "");
  d.code(0, "ENDTAB");
  d.code(0, "ENDSEC");

  // R12 readers expect the section even when there is nothing in it.
  d.code(0, "SECTION");
  d.code(2, "BLOCKS");
  d.code(0, "ENDSEC");

  d.code(0, "SECTION");
  d.code(2, "ENTITIES");

  doc.sheets.forEach((sheet, i) => {
    const base = origins[i];
    // Plate frame (y down) -> DXF frame (y up), with the plate's own offset.
    const fy = (yDown: number) => base + (sheet.widthMm - yDown);

    d.polyline(
      [
        [0, base],
        [sheet.lengthMm, base],
        [sheet.lengthMm, base + sheet.widthMm],
        [0, base + sheet.widthMm],
      ],
      true,
      "PLATE"
    );

    const m = sheet.edgeMarginMm;
    d.polyline(
      [
        [m, base + m],
        [sheet.lengthMm - m, base + m],
        [sheet.lengthMm - m, base + sheet.widthMm - m],
        [m, base + sheet.widthMm - m],
      ],
      true,
      "EDGE_MARGIN"
    );

    if (sheet.remnant && sheet.remnant.lengthMm > 0) {
      const x0 = sheet.lengthMm - sheet.remnant.lengthMm;
      d.polyline(
        [
          [x0, base],
          [sheet.lengthMm, base],
          [sheet.lengthMm, base + sheet.remnant.widthMm],
          [x0, base + sheet.remnant.widthMm],
        ],
        true,
        "REMNANT"
      );
    }

    const caption = Math.max(sheet.widthMm / 30, 25);
    d.text(
      sheet.lengthMm / 2,
      base + sheet.widthMm + caption * 1.6,
      caption,
      `PLATE ${sheet.index} OF ${doc.sheets.length}  ${sheet.lengthMm} x ${sheet.widthMm} x ${sheet.thicknessMm}` +
        (sheet.material ? `  ${sheet.material}` : "") +
        `   KERF ${sheet.kerfMm}  GAP ${sheet.spacingMm}  EDGE ${sheet.edgeMarginMm}`,
      "TEXT"
    );

    for (const piece of sheet.pieces) {
      const aci = ACI_BY_COLOUR[piece.colourIndex % ACI_BY_COLOUR.length];
      for (const loop of piece.loops) {
        const pts: Pt[] = loop.points.map(([x, y]) => [piece.xMm + x, fy(piece.yMm + y)]);
        d.polyline(pts, loop.closed, loop.hole ? "HOLES" : "CUT", aci);
      }
    }

    // Marks last, and every one of them INSIDE the part it names.
    //
    // The PDF pushes a mark that will not fit out to a leader line, because
    // paper cannot be zoomed and a 4 mm label is unreadable on it. A DXF has
    // no such problem: the drawing is opened in CAD, where zooming is free, so
    // a small mark is a small mark and not a lost one. A mark sitting on bare
    // plate beside its part, on the other hand, is genuinely ambiguous -- it
    // reads as belonging to whichever neighbour it happens to be nearest.
    //
    // So the height is whatever fits, with no floor worth arguing about, and
    // there is no outside case. Labels cannot collide either: each sits within
    // its own part's metal, and parts do not overlap.
    const markH = Math.max(20, Math.min(sheet.widthMm / 34, sheet.lengthMm / 150));

    for (const piece of sheet.pieces) {
      const anchor = labelAnchor(piece.loops, piece.wMm, piece.hMm);
      // The text box has to fit INSIDE the inscribed circle, so it is the
      // diagonal of the box that is bounded by the diameter, not its width.
      // 0.72 em per character: a conservative stand-in for CAD's own text
      // style, which is wider than the font the PDF is set in.
      const units = Math.max(1, piece.partNo.length * 0.72);
      const fits = (2 * anchor.r * 0.92) / Math.sqrt(units * units + 1);
      // ...and then checked against the outline itself, because the radius
      // above is a raster estimate and a millimetre of overhang across a cut
      // line is exactly the ambiguity this is meant to remove.
      const height = Math.max(3, fitLabelHeight(piece.partNo, anchor, piece.loops, Math.min(markH, fits), units));
      d.text(piece.xMm + anchor.x, fy(piece.yMm + anchor.y), height, piece.partNo, "TEXT");
    }
  });

  // The notes go on the drawing, not just in the PDF -- whoever opens the DXF
  // is the one who needs to know what spacing it was nested to.
  let ny = -Math.max(200, extY * 0.03);
  const noteH = Math.max(20, extX / 260);
  const heading = doc.planId ? `${doc.title}   [layout ${doc.planId}]` : doc.title;
  for (const note of [heading, doc.subtitle, ...doc.notes]) {
    d.text(0, ny, noteH, note, "TEXT", false);
    ny -= noteH * 2;
  }
  for (const layer of LAYERS) {
    d.text(0, ny, noteH, `LAYER ${layer.name}: ${layer.note}`, "TEXT", false);
    ny -= noteH * 1.6;
  }

  d.code(0, "ENDSEC");
  d.code(0, "EOF");
  return d.toString();
}
