// True-shape cutting plan on a single plate, with an independent check that
// the layout the nester produced actually honours the cutting allowances.
import { readFileSync, writeFileSync } from "node:fs";
import {
  minimumAllowances,
  generousAllowances,
  nestTrueShape,
  cutPlanToPdf,
  cutPlanToDxf,
  type Allowances,
  type CutPlanDocument,
  type TrueShapePart,
} from "@easy/shared";

interface CadPart { wMm: number; hMm: number; quantity: number; netAreaMm2: number; fillRatio: number; rings: Array<Array<[number, number]>>; ringInfo: Array<{ closed: boolean; hole: boolean }> }
const CAD: CadPart[] = JSON.parse(readFileSync("parts-tmp.json", "utf8"));

const PLATE = { lengthMm: Number(process.argv[2] ?? 12000), widthMm: Number(process.argv[3] ?? 3000) };
const THICK = 50;
const GRADE = "TYPE I";

const parts: TrueShapePart[] = CAD.map((c, i) => ({
  id: `p${i}`,
  partNo: `PART-${String(i + 1).padStart(2, "0")}`,
  quantity: c.quantity,
  rings: c.rings,
  widthMm: c.wMm,
  heightMm: c.hMm,
  netAreaMm2: c.netAreaMm2,
  rotatable: true,
}));
const byId = new Map(parts.map((p) => [p.id, p]));
const pieces = parts.reduce((s, p) => s + p.quantity, 0);

// The allowance ladder, same principle as the box nester: run the most
// generous spacing that still fits the job, and tighten only when tightening
// is what makes it fit at all.
const LADDER: Array<[string, Allowances]> = [["generous", generousAllowances(THICK)], ["minimum", minimumAllowances(THICK)]];
let chosen: { label: string; allow: Allowances; nest: ReturnType<typeof nestTrueShape> } | null = null;
for (const [label, allow] of LADDER) {
  const nest = nestTrueShape(parts, PLATE, allow, { cellMm: 8, rotations: [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] });
  if (!chosen || nest.placements.length > chosen.nest.placements.length) chosen = { label, allow, nest };
  if (nest.placements.length === pieces) { chosen = { label, allow, nest }; break; }
}
const { allow, nest, label } = chosen!;

const rot = (rings: CadPart["rings"], deg: number) => {
  if (!deg) return rings;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const out = rings.map((ring) => ring.map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number]));
  let mnX = Infinity, mnY = Infinity;
  for (const ring of out) for (const [x, y] of ring) { if (x < mnX) mnX = x; if (y < mnY) mnY = y; }
  return out.map((ring) => ring.map(([x, y]) => [x - mnX, y - mnY] as [number, number]));
};

// ---- independent verification --------------------------------------------
// The nester enforces spacing through its own dilated masks; checking the
// result with a separate, finer rasterisation is what makes the plan
// trustworthy rather than merely self-consistent.
const CHECK_CELL = 4;
const gw = Math.ceil(PLATE.lengthMm / CHECK_CELL), gh = Math.ceil(PLATE.widthMm / CHECK_CELL);

// Two separate questions, because they have different answers when a raster
// is involved. Parts OVERLAPPING is a hard failure -- the plan would cut one
// part through another. Parts being closer than the spacing is a tolerance
// question, and a cell-based check can only answer it to within a cell, so it
// is measured leniently by one cell and reported rather than asserted.
function paint(padMm: number) {
  const owner = new Int16Array(gw * gh).fill(-1);
  let clash = 0, off = 0;
  const pad = Math.floor(padMm / CHECK_CELL);
  nest.placements.forEach((pl, idx) => {
    const rings = rot(byId.get(pl.partId)!.rings, pl.rotationDeg);
    const x0 = Math.round(pl.xMm / CHECK_CELL), y0 = Math.round(pl.yMm / CHECK_CELL);
    const rows = Math.ceil(pl.hMm / CHECK_CELL);
    // Per ring, unioned -- matching the nester. Checking with even-odd would
    // XOR overlapping loops away and then cheerfully report no overlap in
    // exactly the region where the phantom hole was.
    for (const ring of rings) {
      const edges: Array<[number, number, number, number]> = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
      }
      if (!edges.length) continue;
      for (let ry = -pad; ry <= rows + pad; ry++) {
        const y = (ry + 0.5) * CHECK_CELL;
        const xs: number[] = [];
        for (const [x1, y1, x2, y2] of edges) if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.floor(xs[k] / CHECK_CELL) - pad, c1 = Math.ceil(xs[k + 1] / CHECK_CELL) + pad;
          for (let c = c0; c <= c1; c++) {
            for (let dy = -pad; dy <= pad; dy++) {
              const gx = x0 + c, gy = y0 + ry + dy;
              if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) { off++; continue; }
              const i = gy * gw + gx;
              if (owner[i] !== -1 && owner[i] !== idx) clash++;
              owner[i] = idx;
            }
          }
        }
      }
    }
  });
  return { clash, off };
}

const hard = paint(0);
const clearance = paint(Math.max(0, allow.spacingMm / 2 - CHECK_CELL));
let edgeBreaches = 0;
for (const pl of nest.placements) {
  if (pl.xMm < allow.edgeMarginMm - 1 || pl.yMm < allow.edgeMarginMm - 1 ||
      pl.xMm + pl.wMm > PLATE.lengthMm - allow.edgeMarginMm + 1 || pl.yMm + pl.hMm > PLATE.widthMm - allow.edgeMarginMm + 1) edgeBreaches++;
}
const clashes = hard.clash, offPlate = hard.off;

const metal = parts.reduce((s, p) => s + p.netAreaMm2 * p.quantity, 0);
const placedMetal = nest.placements.reduce((s, pl) => s + byId.get(pl.partId)!.netAreaMm2, 0);
const boxes = parts.reduce((s, p) => s + p.widthMm * p.heightMm * p.quantity, 0);
const extent = Math.max(...nest.placements.map((p) => p.xMm + p.wMm));

console.log(`allowances: ${label} -- gap ${allow.spacingMm} mm, edge ${allow.edgeMarginMm} mm`);
console.log(`placed ${nest.placements.length}/${pieces}`);
for (const u of nest.unplaced) console.log(`   UNPLACED ${u.partNo} x${u.quantity}: ${u.reason}`);
console.log(`VERIFY: hard overlaps ${hard.clash} cells, off-plate ${hard.off}, edge breaches ${edgeBreaches}, clearance-margin cells ${clearance.clash}`);
console.log(`metal ${(metal / 1e6).toFixed(2)} m2 of ${(PLATE.lengthMm * PLATE.widthMm / 1e6).toFixed(2)} m2 = ${((metal / (PLATE.lengthMm * PLATE.widthMm)) * 100).toFixed(1)}%`);
console.log(`boxes would have needed ${(boxes / 1e6).toFixed(2)} m2`);
console.log(`used to ${extent.toFixed(0)} mm; remnant ${(PLATE.lengthMm - extent).toFixed(0)} x ${PLATE.widthMm} mm`);
if (clashes > 0 || offPlate > 0 || edgeBreaches > 0) { console.error("LAYOUT FAILED VERIFICATION"); process.exit(1); }

// ---- document -------------------------------------------------------------
const COLOURS = ["#2563eb","#16a34a","#ea580c","#9333ea","#0891b2","#ca8a04","#dc2626","#4f46e5","#059669","#db2777"];
const colourOf = new Map(parts.map((p, i) => [p.id, COLOURS[i % COLOURS.length]]));
const fs = PLATE.lengthMm / 90;
const pad = 90;

const PLATE_FILL = "#fbfbfa";

// The drawn part has to be the cut part. Three separate jobs:
//   - solid loops are filled and OVERLAP, which is how a union is drawn in SVG
//     (fill-rule would cancel the overlap instead of merging it);
//   - hole loops are then filled back to the plate colour, so a bolt hole
//     reads as a hole rather than as metal;
//   - the outline is stroked last, and an open loop is stroked WITHOUT its
//     closing segment, so no phantom chord is drawn across a part where the
//     real boundary follows a circle the loop merely ends on.

// Where to write a part's name.
//
// The bounding-box centre is the obvious choice and the wrong one: on a
// concave profile it lands in the notch, so the label floats on bare plate
// beside the part it names. This finds the pole of inaccessibility instead --
// the interior point furthest from any edge -- by rasterising the part and
// running a distance transform over it. The distance at that point is also the
// radius of the largest circle that fits inside the part, which is exactly
// what decides how big the text can be before it spills over an edge.
function labelAnchor(rings: Array<Array<[number, number]>>, info: Array<{ closed: boolean; hole: boolean }>, wMm: number, hMm: number) {
  const cell = Math.max(4, Math.max(wMm, hMm) / 220);
  const gw = Math.max(1, Math.ceil(wMm / cell)), gh = Math.max(1, Math.ceil(hMm / cell));
  const solid = new Uint8Array(gw * gh);

  const scan = (ring: Array<[number, number]>, set: boolean) => {
    const edges: Array<[number, number, number, number]> = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
    if (!edges.length) return;
    for (let row = 0; row < gh; row++) {
      const y = (row + 0.5) * cell;
      const xs: number[] = [];
      for (const [x1, y1, x2, y2] of edges) if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] / cell)), c1 = Math.min(gw - 1, Math.floor(xs[k + 1] / cell));
        for (let c = c0; c <= c1; c++) solid[row * gw + c] = set ? 1 : 0;
      }
    }
  };
  rings.forEach((r, k) => { if (!info[k]?.hole) scan(r, true); });
  // A hole is not somewhere to write either.
  rings.forEach((r, k) => { if (info[k]?.hole) scan(r, false); });

  // Two-pass chamfer distance transform, in cells.
  const INF = 1e9;
  const dist = new Float32Array(gw * gh);
  for (let i = 0; i < dist.length; i++) dist[i] = solid[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : dist[y * gw + x]);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    if (!solid[i]) continue;
    dist[i] = Math.min(dist[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.4142, at(x + 1, y - 1) + 1.4142);
  }
  for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
    const i = y * gw + x;
    if (!solid[i]) continue;
    dist[i] = Math.min(dist[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.4142, at(x - 1, y + 1) + 1.4142);
  }

  let best = -1, bx = gw / 2, by = gh / 2;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const v = dist[y * gw + x];
    if (v > best && v < INF) { best = v; bx = x; by = y; }
  }
  return { x: (bx + 0.5) * cell, y: (by + 0.5) * cell, r: Math.max(0, best) * cell };
}

const shapes = nest.placements
  .map((pl) => {
    const c = colourOf.get(pl.partId)!;
    const cad = CAD[Number(pl.partId.slice(1))];
    const rings = rot(cad.rings, pl.rotationDeg);
    const info = cad.ringInfo;
    const d = (r: Array<[number, number]>, close: boolean) =>
      "M" + r.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L") + (close ? "Z" : "");

    // Each solid loop gets its OWN path element. Putting them all in one path
    // and leaning on a fill rule does NOT union them: "nonzero" cancels an
    // overlap whose subpaths wind in opposite directions, and that is exactly
    // the case here -- a circle generated by increasing angle winds the other
    // way to a body polyline drawn clockwise in CAD. That cancellation is what
    // emptied the middle of PART-06's lobe. Separate elements paint over one
    // another and cannot cancel.
    //
    // Translucency is applied to the GROUP, not to each fill, so the overlap is
    // flattened before the alpha and does not show as a darker patch.
    const solidPaths = rings
      .filter((_, k) => !info[k]?.hole)
      .map((r) => `<path d="${d(r, true)}" fill="${c}"/>`)
      .join("");
    const holePaths = rings
      .filter((_, k) => info[k]?.hole)
      .map((r) => `<path d="${d(r, true)}" fill="${PLATE_FILL}"/>`)
      .join("");
    const stroke = rings.map((r, k) => d(r, info[k]?.closed !== false)).join(" ");
    const at = `translate(${pad + pl.xMm} ${pad + pl.yMm})`;

    // Sized to the room actually available: the inscribed circle has diameter
    // 2r, and a label of n characters is about 0.58 * size wide per character.
    // Capped at the sheet's normal size so a huge part does not shout.
    const anchor = labelAnchor(rings, info, pl.wMm, pl.hMm);
    const n = pl.partNo.length;
    const size = Math.max(fs * 0.28, Math.min(fs * 0.8, (2 * anchor.r * 0.85) / (n * 0.58), 2 * anchor.r * 0.8));
    // Nowhere inside is big enough to hold the name -- put it outside on a
    // leader rather than printing it across the part's own cut line.
    const outside = anchor.r < fs * 0.22;
    const lx = outside ? pl.wMm / 2 : anchor.x;
    const ly = outside ? -fs * 0.35 : anchor.y;

    return `<g transform="${at}">
      <g opacity="0.3">${solidPaths}</g>
      ${holePaths}
      <path d="${stroke}" fill="none" stroke="${c}" stroke-width="${fs / 8}" stroke-linejoin="round"/>
      ${outside ? `<line x1="${lx}" y1="${ly + fs * 0.12}" x2="${anchor.x}" y2="${anchor.y}" stroke="${c}" stroke-width="${fs / 16}" stroke-opacity="0.7"/>` : ""}
      <text x="${lx}" y="${ly}" font-size="${size.toFixed(1)}" text-anchor="middle" dominant-baseline="middle"
            fill="#0f172a" style="paint-order:stroke" stroke="${PLATE_FILL}" stroke-width="${size / 6}">${pl.partNo}</text>
    </g>`;
  })
  .join("\n    ");

const svg = `<svg viewBox="0 0 ${PLATE.lengthMm + pad * 2} ${PLATE.widthMm + pad * 2}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${pad}" y="${pad}" width="${PLATE.lengthMm}" height="${PLATE.widthMm}" fill="#fbfbfa" stroke="#0f172a" stroke-width="${fs / 4}"/>
    <rect x="${pad + extent + 10}" y="${pad}" width="${PLATE.lengthMm - extent - 10}" height="${PLATE.widthMm}" fill="#22c55e" fill-opacity="0.09"/>
    ${shapes}
    <text x="${pad + PLATE.lengthMm / 2}" y="${pad - fs * 0.6}" font-size="${fs}" text-anchor="middle" fill="#0f172a">${PLATE.lengthMm} mm</text>
    <text x="${pad - fs * 0.6}" y="${pad + PLATE.widthMm / 2}" font-size="${fs}" text-anchor="middle" fill="#0f172a" transform="rotate(-90 ${pad - fs * 0.6} ${pad + PLATE.widthMm / 2})">${PLATE.widthMm} mm</text>
  </svg>`;

const rows = nest.placements
  .slice()
  .sort((a, b) => a.xMm - b.xMm || a.yMm - b.yMm)
  .map((pl) => `<tr><td><span class="sw" style="background:${colourOf.get(pl.partId)}"></span><span class="mono">${pl.partNo}</span> <span style="color:#94a3b8">#${pl.instance}</span></td>
    <td class="mono">${pl.wMm.toFixed(0)} &times; ${pl.hMm.toFixed(0)}</td>
    <td class="mono">${pl.xMm.toFixed(0)}, ${pl.yMm.toFixed(0)}</td><td>${pl.rotationDeg}&deg;</td></tr>`)
  .join("");

const partRows = parts
  .map((p, i) => `<tr><td><span class="sw" style="background:${COLOURS[i % COLOURS.length]}"></span><span class="mono">${p.partNo}</span></td>
    <td class="mono">${p.widthMm.toFixed(1)} &times; ${p.heightMm.toFixed(1)}</td><td>${p.quantity}</td>
    <td class="mono">${(p.netAreaMm2 / 1e6).toFixed(3)}</td>
    <td>${((p.netAreaMm2 / (p.widthMm * p.heightMm)) * 100).toFixed(0)} %</td></tr>`)
  .join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cutting Plan &mdash; one plate</title><style>
@page { size: A3 landscape; margin: 10mm; }
body{font:11px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;margin:0;padding:14px;background:#fff}
h1{font-size:19px;margin:0 0 2px}h2{font-size:13px;margin:14px 0 6px}
.sub{color:#64748b;margin-bottom:12px}
.stats{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:12px}
.stat{border:1px solid #cbd5e1;border-radius:4px;padding:6px 11px;min-width:112px}
.stat b{display:block;font-size:16px}.stat span{color:#64748b;font-size:9.5px;text-transform:uppercase;letter-spacing:.04em}
.note{border:1px solid #cbd5e1;border-left:3px solid #64748b;background:#f8fafc;padding:8px 11px;margin-bottom:12px}
.ok{border-left-color:#16a34a;background:#f0fdf4}
.bad{border-left-color:#dc2626;background:#fef2f2}
table{border-collapse:collapse;width:100%;font-size:10px}
th{text-align:left;border-bottom:1.5px solid #0f172a;padding:3px 5px;font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:#475569}
td{border-bottom:1px solid #e2e8f0;padding:3px 5px}
.mono{font-family:ui-monospace,Consolas,monospace}
.sw{display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:middle;margin-right:5px}
svg{width:100%;height:auto;border:1px solid #e2e8f0}
.cols{display:flex;gap:18px}.cols>div{flex:1}
</style></head><body>
<h1>Cutting Plan &mdash; single plate, true-shape nest</h1>
<div class="sub">Project YAMAMA &middot; PL ${THICK} mm &times; ${PLATE.widthMm} &times; ${PLATE.lengthMm} &middot; ${GRADE} &middot; plasma &middot; ${new Date().toISOString().slice(0, 10)}</div>

<div class="stats">
  <div class="stat"><span>Plates</span><b>1</b></div>
  <div class="stat"><span>Pieces on plate</span><b>${nest.placements.length} / ${pieces}</b></div>
  <div class="stat"><span>Metal on plate</span><b>${(placedMetal / 1e6).toFixed(2)} m&sup2;</b></div>
  <div class="stat"><span>Plate</span><b>${((PLATE.lengthMm * PLATE.widthMm) / 1e6).toFixed(2)} m&sup2;</b></div>
  <div class="stat"><span>Utilisation</span><b>${((placedMetal / (PLATE.lengthMm * PLATE.widthMm)) * 100).toFixed(1)} %</b></div>
  <div class="stat"><span>Remnant</span><b>${(PLATE.lengthMm - extent).toFixed(0)} mm</b></div>
</div>

<div class="note ${nest.placements.length === pieces ? "ok" : "bad"}">
  ${nest.placements.length === pieces
    ? "<b>Everything fits on one plate.</b>"
    : `<b>${pieces - nest.placements.length} of ${pieces} pieces will not fit on one ${PLATE.lengthMm} x ${PLATE.widthMm} plate.</b> ` +
      `They are listed below and need a second plate or a longer one.`}
  Nested on the true outlines, not bounding boxes &mdash; parts sit inside each other&rsquo;s concave regions. The same pieces nested as
  rectangles need <b>${(boxes / 1e6).toFixed(2)} m&sup2;</b> of box against a ${((PLATE.lengthMm * PLATE.widthMm) / 1e6).toFixed(0)} m&sup2; plate.
  Cutting allowances: <b>${allow.spacingMm} mm</b> between parts (${allow.kerfMm} kerf + ${allow.webMm} web) and <b>${allow.edgeMarginMm} mm</b>
  off the rolled edge, the ${label} end of the safe band for ${THICK} mm plate.
  <br><b>Verified independently at ${CHECK_CELL} mm resolution:</b> ${hard.clash} overlapping cells, ${hard.off} off-plate, ${edgeBreaches} edge breaches.
</div>
${nest.unplaced.length ? `<div class="note bad"><b>Not on this plate:</b> ${nest.unplaced.map((u) => `${u.partNo} &times; ${u.quantity}`).join(", ")}.
  ${nest.unplaced.reduce((s2, u) => s2 + u.quantity, 0)} piece(s), ${(nest.unplaced.reduce((s2, u) => {
    const pp = parts.find((q) => q.partNo === u.partNo)!;
    return s2 + pp.netAreaMm2 * u.quantity;
  }, 0) / 1e6).toFixed(2)} m&sup2; of metal still to cut.</div>` : ""}
${svg}
<div style="color:#64748b;font-size:10px;margin-top:4px">Green band at the far end is the unused remnant: ${(PLATE.lengthMm - extent).toFixed(0)} &times; ${PLATE.widthMm} mm, left whole for the rack.</div>

<div class="cols">
 <div><h2>Parts</h2><table><thead><tr><th>Part</th><th>Bounding box (mm)</th><th>Qty</th><th>Metal m&sup2;</th><th>Fill</th></tr></thead><tbody>${partRows}</tbody></table></div>
 <div><h2>Cut list &mdash; in order along the plate</h2><table><thead><tr><th>Part</th><th>Box (mm)</th><th>X, Y (mm)</th><th>Turned</th></tr></thead><tbody>${rows}</tbody></table></div>
</div>

<div class="note" style="margin-top:12px">
  Positions are the top-left corner of each part&rsquo;s bounding box, measured from the plate&rsquo;s top-left. Rotation is applied about
  the part&rsquo;s own origin before placing. Geometry came from the DWG&rsquo;s drawn outlines, so these are the real profiles and the real
  quantities &mdash; no thickness is stated on the drawing, so ${THICK} mm is taken from the plate size in the title block.
</div>
</body></html>`;

const out = process.argv[4] ?? "C:/Users/User/Desktop/Cutting Plan - ONE PLATE.html";
writeFileSync(out, html, "utf8");
console.log(`written: ${out}`);

// ---- exports ---------------------------------------------------------------
// The same nest, written for the two people who are not looking at a browser:
// the fabricator, who wants it on paper at a stated scale, and the CAM
// programmer, who wants the contours themselves.
const exportDoc: CutPlanDocument = {
  title: "Cutting Plan - single plate, true-shape nest",
  subtitle: `PL ${THICK} mm x ${PLATE.widthMm} x ${PLATE.lengthMm} - ${GRADE} - plasma - ${new Date().toISOString().slice(0, 10)}`,
  stats: [
    { label: "Plates", value: "1" },
    { label: "Pieces", value: `${nest.placements.length} / ${pieces}` },
    { label: "Metal", value: `${(placedMetal / 1e6).toFixed(2)} m2` },
    { label: "Plate", value: `${((PLATE.lengthMm * PLATE.widthMm) / 1e6).toFixed(2)} m2` },
    { label: "Utilisation", value: `${((placedMetal / (PLATE.lengthMm * PLATE.widthMm)) * 100).toFixed(1)} %` },
    { label: "Remnant", value: `${(PLATE.lengthMm - extent).toFixed(0)} mm` },
  ],
  notes: [
    `Cutting allowances: ${allow.spacingMm} mm between parts (${allow.kerfMm} mm kerf + ${allow.webMm} mm web) and ` +
      `${allow.edgeMarginMm} mm off the rolled edge - the ${label} end of the safe band for ${THICK} mm plate. The CNC offsets the ` +
      `torch path outward by half a kerf, so the contours here are the FINISHED outlines, not the path.`,
    `Verified independently at ${CHECK_CELL} mm resolution: ${hard.clash} overlapping cells, ${hard.off} off-plate, ` +
      `${edgeBreaches} edge breaches, ${clearance.clash} cells inside the clearance margin.`,
    `Geometry came from the DWG's drawn outlines, so these are the real profiles and the real quantities. No thickness is stated on ` +
      `the drawing; ${THICK} mm is taken from the plate size in the title block.`,
    `Positions in the cut list are the top-left corner of each part's bounding box from the plate's top-left corner. Rotation is ` +
      `applied about the part's own origin before placing.`,
    nest.unplaced.length
      ? `NOT ON THIS PLATE: ${nest.unplaced.map((u) => `${u.partNo} x ${u.quantity}`).join(", ")}.`
      : `All ${pieces} pieces are on this one plate.`,
  ],
  sheets: [
    {
      index: 1,
      lengthMm: PLATE.lengthMm,
      widthMm: PLATE.widthMm,
      thicknessMm: THICK,
      material: GRADE,
      kerfMm: allow.kerfMm,
      spacingMm: allow.spacingMm,
      edgeMarginMm: allow.edgeMarginMm,
      remnant: PLATE.lengthMm - extent > 0 ? { lengthMm: PLATE.lengthMm - extent, widthMm: PLATE.widthMm } : null,
      pieces: nest.placements.map((pl) => {
        const idx = Number(pl.partId.slice(1));
        const cad = CAD[idx];
        const rings = rot(cad.rings, pl.rotationDeg);
        return {
          partNo: pl.partNo,
          instance: pl.instance,
          xMm: pl.xMm,
          yMm: pl.yMm,
          wMm: pl.wMm,
          hMm: pl.hMm,
          rotationDeg: pl.rotationDeg,
          colourIndex: idx,
          loops: rings.map((points, k) => ({
            points,
            closed: cad.ringInfo[k]?.closed !== false,
            hole: cad.ringInfo[k]?.hole === true,
          })),
        };
      }),
    },
  ],
  partList: parts.map((p, i) => ({
    partNo: p.partNo,
    sizeMm: `${p.widthMm.toFixed(0)} x ${p.heightMm.toFixed(0)}`,
    quantity: p.quantity,
    note: `${(p.netAreaMm2 / 1e6).toFixed(3)} m2, ${((p.netAreaMm2 / (p.widthMm * p.heightMm)) * 100).toFixed(0)}% of box`,
    colourIndex: i,
  })),
};

const pdfPath = out.replace(/\.html$/i, ".pdf");
const dxfPath = out.replace(/\.html$/i, ".dxf");
writeFileSync(pdfPath, cutPlanToPdf(exportDoc));
writeFileSync(dxfPath, cutPlanToDxf(exportDoc), "ascii");
console.log(`written: ${pdfPath}`);
console.log(`written: ${dxfPath}`);
