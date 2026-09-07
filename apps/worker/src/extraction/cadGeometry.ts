// Real part outlines, from CAD.
//
// A plotted PDF of a cutting drawing does not carry the parts. It carries a
// picture of them: the outline is exploded into thousands of disconnected
// dash segments with no grouping, mixed in with dimension lines that look
// exactly the same, at a scale nothing states. Reading sizes off it with a
// vision model works; recovering the geometry does not, and four different
// attempts established that no tolerance separates "same outline" from
// "different object" once the linetype has been exploded.
//
// The CAD file does carry them, because that is what a CAD file is. This turns
// its entities into closed part profiles. No model is involved and no API is
// called -- it is arithmetic, so the same file always gives the same parts.

export interface CadVertex {
  x: number;
  y: number;
  // LWPOLYLINE bulge: the tangent of a quarter of the included angle of the
  // arc running to the NEXT vertex. Ignoring it chops every radiused corner
  // off as a straight chord.
  bulge?: number;
}

export interface CadEntity {
  type: string;
  layer: string;
  vertices?: CadVertex[];
  flag?: number; // bit 1 set = closed polyline
  center?: { x: number; y: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  startPoint?: { x: number; y: number };
  endPoint?: { x: number; y: number };
}

export type Ring = Array<[number, number]>;

export interface CadPart {
  partNo: string;
  widthMm: number;
  heightMm: number;
  netAreaMm2: number;
  fillRatio: number;
  quantity: number;
  rings: Ring[];
  ringInfo: Array<{ closed: boolean; hole: boolean }>;
  outlinePath: string;
  // Where it sat in model space, so a part can be found on the original
  // drawing when someone disagrees with it.
  atXMm: number;
  atYMm: number;
  entityCount: number;
  openLoops: number;
}

export interface LayerReport {
  layer: string;
  entities: number;
  closureScore: number;
  used: boolean;
  reason: string;
}

export interface CadReadResult {
  parts: CadPart[];
  pieces: number;
  totalMetalMm2: number;
  totalBoxMm2: number;
  layers: LayerReport[];
}

const TAU = Math.PI * 2;

// Annotation, not metal. Dimensions are their own entity type, which is what
// makes them droppable here and impossible to drop from a plotted PDF.
const ANNOTATION_TYPES = new Set([
  "DIMENSION",
  "TEXT",
  "MTEXT",
  "LEADER",
  "MULTILEADER",
  "HATCH",
  "SOLID",
  "POINT",
  "ATTDEF",
  "ATTRIB",
  "TOLERANCE",
  "VIEWPORT",
]);

const GEOMETRY_TYPES = new Set(["LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE"]);

interface Fragment {
  pts: Ring;
  closed: boolean;
}

// Every entity reduced to a polyline. Arcs are flattened finely enough that a
// 2 m radius still reads as a curve on a plate layout and cuts as one.
function flatten(e: CadEntity): Fragment[] {
  if (e.type === "CIRCLE" && e.center && e.radius != null) {
    const n = 64;
    const pts: Ring = [];
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n;
      pts.push([e.center.x + e.radius * Math.cos(a), e.center.y + e.radius * Math.sin(a)]);
    }
    return [{ pts, closed: true }];
  }
  if (e.type === "ARC" && e.center && e.radius != null) {
    let a0 = e.startAngle ?? 0;
    let a1 = e.endAngle ?? 0;
    if (a1 < a0) a1 += TAU;
    const n = Math.max(8, Math.ceil(((a1 - a0) / TAU) * 64));
    const pts: Ring = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([e.center.x + e.radius * Math.cos(a), e.center.y + e.radius * Math.sin(a)]);
    }
    return [{ pts, closed: false }];
  }
  if (e.type === "LINE" && e.startPoint && e.endPoint) {
    return [{ pts: [[e.startPoint.x, e.startPoint.y], [e.endPoint.x, e.endPoint.y]], closed: false }];
  }

  const v = e.vertices ?? [];
  if (v.length < 2) return [];
  const closed = ((e.flag ?? 0) & 1) === 1;
  const pts: Ring = [];
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const last = i === v.length - 1;
    if (last && !closed) {
      pts.push([a.x, a.y]);
      break;
    }
    pts.push([a.x, a.y]);
    const bulge = a.bulge ?? 0;
    if (Math.abs(bulge) > 1e-9) {
      const theta = 4 * Math.atan(bulge);
      const chord = Math.hypot(b.x - a.x, b.y - a.y);
      if (chord > 1e-9) {
        const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const d = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2)) * (bulge > 0 ? 1 : -1);
        const ux = -(b.y - a.y) / chord;
        const uy = (b.x - a.x) / chord;
        const cx = mx + ux * d;
        const cy = my + uy * d;
        let s = Math.atan2(a.y - cy, a.x - cx);
        let t = Math.atan2(b.y - cy, b.x - cx);
        if (theta > 0 && t < s) t += TAU;
        if (theta < 0 && t > s) t -= TAU;
        const n = Math.max(6, Math.ceil((Math.abs(t - s) / TAU) * 64));
        for (let k = 1; k < n; k++) {
          const ang = s + ((t - s) * k) / n;
          pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
        }
      }
    }
  }
  return [{ pts, closed }];
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The drawn outline of a part is not one entity. CAD splits it wherever the
// draughtsman released the mouse: a polyline for the straight run, an arc for
// the radius, a two-point line closing the back. Treating each fragment as its
// own closed ring fills thin slivers instead of the part -- and a nester then
// reads the part's own interior as free plate and drops another part into it.
// So fragments are stitched back into loops first.
//
// The endpoints here are exact CAD coordinates, so a couple of millimetres of
// tolerance is enough and nothing else is anywhere near them.
const STITCH_TOL = 2.5;

function stitch(fragments: Fragment[]): Ring[] {
  const loops: Ring[] = fragments.filter((f) => f.closed).map((f) => f.pts);
  const open = fragments.filter((f) => !f.closed).map((f) => f.pts);
  const used = new Array(open.length).fill(false);

  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = open[i].slice();
    for (let grew = true; grew; ) {
      grew = false;
      for (let j = 0; j < open.length && !grew; j++) {
        if (used[j]) continue;
        const f = open[j];
        const s = f[0];
        const e = f[f.length - 1];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        if (dist(tail, s) <= STITCH_TOL) {
          chain = chain.concat(f.slice(1));
          used[j] = grew = true;
        } else if (dist(tail, e) <= STITCH_TOL) {
          chain = chain.concat(f.slice(0, -1).reverse());
          used[j] = grew = true;
        } else if (dist(head, e) <= STITCH_TOL) {
          chain = f.slice(0, -1).concat(chain);
          used[j] = grew = true;
        } else if (dist(head, s) <= STITCH_TOL) {
          chain = f.slice(1).reverse().concat(chain);
          used[j] = grew = true;
        }
      }
    }
    loops.push(chain);
  }
  return loops;
}

function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function ringLength(r: Ring): number {
  let len = 0;
  for (let i = 1; i < r.length; i++) len += dist(r[i - 1], r[i]);
  return len;
}

const isClosedRing = (r: Ring) => r.length > 2 && dist(r[0], r[r.length - 1]) <= STITCH_TOL;

// Net metal, measured off a raster of the UNION of the loops. Union rather
// than even-odd because a circle on one of these parts is as often a boss
// standing proud of the outline as a hole through it, and filling both solid
// errs toward reserving MORE metal -- the safe direction on a cutting plan.
function unionAreaMm2(loops: Ring[], cell = 4): number {
  let mnX = Infinity;
  let mnY = Infinity;
  let mxX = -Infinity;
  let mxY = -Infinity;
  for (const l of loops) {
    for (const [x, y] of l) {
      if (x < mnX) mnX = x;
      if (y < mnY) mnY = y;
      if (x > mxX) mxX = x;
      if (y > mxY) mxY = y;
    }
  }
  if (!Number.isFinite(mnX)) return 0;
  const w = Math.ceil((mxX - mnX) / cell) + 2;
  const h = Math.ceil((mxY - mnY) / cell) + 2;
  const grid = new Uint8Array(w * h);
  for (const loop of loops) {
    const edges: Array<[number, number, number, number]> = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
    for (let row = 0; row < h; row++) {
      const y = mnY + (row + 0.5) * cell;
      const xs: number[] = [];
      for (const [x1, y1, x2, y2] of edges) {
        if ((y >= y1 && y < y2) || (y >= y2 && y < y1)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.floor((xs[k] - mnX) / cell));
        const c1 = Math.min(w - 1, Math.ceil((xs[k + 1] - mnX) / cell));
        for (let c = c0; c <= c1; c++) grid[row * w + c] = 1;
      }
    }
  }
  let n = 0;
  for (let i = 0; i < grid.length; i++) n += grid[i];
  return n * cell * cell;
}

const bboxOf = (pts: Ring) => ({
  minX: Math.min(...pts.map((p) => p[0])),
  maxX: Math.max(...pts.map((p) => p[0])),
  minY: Math.min(...pts.map((p) => p[1])),
  maxY: Math.max(...pts.map((p) => p[1])),
});

interface Group {
  shapes: Fragment[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Entities belonging to one part sit together; distinct parts on a cutting
// sheet are laid out hundreds of millimetres apart.
const GROUP_GAP = 60;

function group(fragments: Fragment[]): Group[] {
  const groups: Group[] = [];
  for (const s of fragments) {
    if (s.pts.length < 2) continue;
    const b = bboxOf(s.pts);
    const hit = groups.find(
      (g) => b.minX < g.maxX + GROUP_GAP && b.maxX > g.minX - GROUP_GAP && b.minY < g.maxY + GROUP_GAP && b.maxY > g.minY - GROUP_GAP
    );
    if (hit) {
      hit.shapes.push(s);
      hit.minX = Math.min(hit.minX, b.minX);
      hit.maxX = Math.max(hit.maxX, b.maxX);
      hit.minY = Math.min(hit.minY, b.minY);
      hit.maxY = Math.max(hit.maxY, b.maxY);
    } else {
      groups.push({ shapes: [s], ...b });
    }
  }
  return groups;
}

// Which layer holds the parts.
//
// A drawing that has been through AutoCAD's PDF import carries the same
// drawing twice: the real entities, and the imported picture of them exploded
// into hundreds of disconnected dash fragments. Both look like geometry, both
// have plausible entity sizes, and picking wrongly produces a nest of
// confetti. The discriminator is not size or count -- it is whether the
// fragments STITCH: a drawn profile closes, a bag of dashes does not. So each
// layer is run through the real pipeline and scored on the fraction of its
// outline length that ends up in a closed loop.
function closureScore(fragments: Fragment[]): number {
  const groups = group(fragments);
  let closedLen = 0;
  let totalLen = 0;
  for (const g of groups) {
    for (const loop of stitch(g.shapes)) {
      const len = ringLength(loop);
      totalLen += len;
      if (isClosedRing(loop)) closedLen += len;
    }
  }
  return totalLen > 0 ? closedLen / totalLen : 0;
}

// A layer has to close most of its length to be believed. Anything under this
// is either annotation or an exploded raster of a drawing, neither of which
// can be cut.
const MIN_CLOSURE = 0.6;

export interface CadReadOptions {
  // Force a layer set instead of choosing one. For the case where the
  // heuristic picks wrongly and somebody knows better.
  layers?: string[];
}

export function partsFromCadEntities(entities: CadEntity[], options: CadReadOptions = {}): CadReadResult {
  const geometry = entities.filter((e) => GEOMETRY_TYPES.has(e.type) && !ANNOTATION_TYPES.has(e.type));

  const byLayer = new Map<string, CadEntity[]>();
  for (const e of geometry) {
    const layer = e.layer || "0";
    const list = byLayer.get(layer) ?? [];
    list.push(e);
    byLayer.set(layer, list);
  }

  const layers: LayerReport[] = [];
  for (const [layer, ents] of byLayer) {
    const fragments = ents.flatMap(flatten).filter((f) => f.pts.length >= 2);
    const score = closureScore(fragments);
    layers.push({ layer, entities: ents.length, closureScore: +score.toFixed(3), used: false, reason: "" });
  }
  layers.sort((a, b) => b.closureScore - a.closureScore || b.entities - a.entities);

  let chosen: string[];
  if (options.layers?.length) {
    chosen = options.layers;
    for (const l of layers) {
      l.used = chosen.includes(l.layer);
      l.reason = l.used ? "chosen by hand" : "not in the chosen set";
    }
  } else {
    chosen = layers.filter((l) => l.closureScore >= MIN_CLOSURE).map((l) => l.layer);
    // Nothing closed well. Rather than return no parts, take the best layer
    // and let the caller report that the profiles are doubtful.
    if (chosen.length === 0 && layers.length > 0) chosen = [layers[0].layer];
    for (const l of layers) {
      l.used = chosen.includes(l.layer);
      l.reason = l.used
        ? `${(l.closureScore * 100).toFixed(0)}% of its outline length closes into loops`
        : `only ${(l.closureScore * 100).toFixed(0)}% of its outline length closes into loops -- annotation, or a drawing exploded by PDF import`;
    }
  }

  const kept = geometry.filter((e) => chosen.includes(e.layer || "0"));
  const fragments = kept.flatMap(flatten).filter((f) => f.pts.length >= 2);
  const groups = group(fragments);

  const parts: CadPart[] = [];
  for (const g of groups) {
    const w = g.maxX - g.minX;
    const h = g.maxY - g.minY;
    if (!(w > 0) || !(h > 0)) continue;
    // Into the part's own frame, y DOWN -- the frame the nester and both
    // exporters work in, so nothing downstream has to flip anything.
    const local = g.shapes.map((s) => ({
      closed: s.closed,
      pts: s.pts.map(([x, y]) => [+(x - g.minX).toFixed(2), +(g.maxY - y).toFixed(2)] as [number, number]),
    }));
    const loops = stitch(local).filter((l) => l.length >= 3);
    if (loops.length === 0) continue;

    // Which loops are holes and which are solid. A loop wholly inside a bigger
    // one is a hole (a bolt hole through a boss); a loop that merely overlaps
    // another is a separate solid feature (a boss standing proud of the body)
    // and must be unioned with it, never subtracted. Getting this backwards is
    // what makes a drawn part disagree with the part that gets cut.
    const ringInfo = loops.map((loop, li) => {
      const area = ringArea(loop);
      const bb = bboxOf(loop);
      const cx = (bb.minX + bb.maxX) / 2;
      const cy = (bb.minY + bb.maxY) / 2;
      const hole = loops.some((other, oi) => {
        if (oi === li || ringArea(other) <= area) return false;
        const ob = bboxOf(other);
        const contained = bb.minX >= ob.minX - 1 && bb.maxX <= ob.maxX + 1 && bb.minY >= ob.minY - 1 && bb.maxY <= ob.maxY + 1;
        return contained && pointInRing([cx, cy], other);
      });
      return { closed: isClosedRing(loop), hole };
    });

    const netArea = unionAreaMm2(loops);
    parts.push({
      partNo: "",
      widthMm: +w.toFixed(2),
      heightMm: +h.toFixed(2),
      netAreaMm2: Math.round(netArea),
      fillRatio: +(netArea / (w * h)).toFixed(3),
      quantity: 1,
      rings: loops,
      ringInfo,
      outlinePath: loops.map((l) => "M" + l.map((p) => p.join(" ")).join("L") + "Z").join(" "),
      atXMm: +g.minX.toFixed(1),
      atYMm: +g.minY.toFixed(1),
      entityCount: g.shapes.length,
      openLoops: ringInfo.filter((r) => !r.closed).length,
    });
  }

  // The same shape drawn more than once is one part with a quantity. Keyed on
  // size and metal area rather than on the geometry itself: two hand-drawn
  // copies of one part are never identical to the micron, and a nest that
  // lists them separately still cuts the same pieces.
  const unique = new Map<string, CadPart>();
  for (const part of parts.sort((a, b) => b.widthMm * b.heightMm - a.widthMm * a.heightMm)) {
    const key = `${Math.round(part.widthMm)}x${Math.round(part.heightMm)}x${part.entityCount}x${Math.round(part.netAreaMm2 / 100)}`;
    const seen = unique.get(key);
    if (seen) seen.quantity += 1;
    else unique.set(key, part);
  }

  const out = [...unique.values()];
  out.forEach((p, i) => {
    p.partNo = `PART-${String(i + 1).padStart(2, "0")}`;
  });

  return {
    parts: out,
    pieces: out.reduce((sum, p) => sum + p.quantity, 0),
    totalMetalMm2: out.reduce((sum, p) => sum + p.netAreaMm2 * p.quantity, 0),
    totalBoxMm2: out.reduce((sum, p) => sum + p.widthMm * p.heightMm * p.quantity, 0),
    layers,
  };
}

function pointInRing(pt: [number, number], ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
