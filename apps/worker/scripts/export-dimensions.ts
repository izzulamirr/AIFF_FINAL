// Exports every DIMENSION on an isometric: where it is, what it spans, which
// axis it runs on, and -- optionally -- the length printed against it.
//
//   pnpm --filter @easy/worker exec tsx scripts/export-dimensions.ts <file.pdf> <out.json> \
//       [--read-labels 1,2,3] [--preview sheet.png] [--labels-from labels.json]
//
// Everything but the NUMBER is free: the geometry says where each dimension
// is and what it brackets (src/extraction/isoDimensions.ts). The number has to
// be read, because an isometric is not drawn to scale -- but by then it is a
// short digit string in a box that has already been cut out and blown up, so
// one contact sheet covers a whole document in a single call.
//
// --preview writes the exact image the call would send WITHOUT sending it, and
// --labels-from replays a set of readings, so the render can be checked and
// the labels can even be read off it by hand for nothing. Do that first.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ISO_DIMENSIONS_TOOL, buildSystemPrompt } from "@easy/extraction-schemas";
import { readDimensions, type IsoDimension } from "../src/extraction/isoDimensions";
import { readPageCount } from "../src/pdfGeometry";
import { renderMultiPageContactSheet, type ContactSheetRegion } from "../src/pdfImages";

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(__dirname, "../.env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

/** Every dimension with a readable label, tagged "<page>-<index>". */
/**
 * A label box narrower than this across is not a number -- it is one stray
 * stroke the finder latched onto.
 *
 * A three-digit label measures 18-20pt on these sheets. Sheet 2's 178 came
 * back as 9x10pt holding a single tick, and rendered as an unreadable
 * fragment: no way to read the number, and no way to tell that was why.
 */
const SUSPECT_LABEL_PT = 14;
/**
 * What such a box is widened to instead.
 *
 * SIZE A CROP BY WHAT MUST BE READABLE, NOT BY WHAT MUST BE VISIBLE -- the
 * lesson the per-valve crops taught, in a second place. Applied ONLY to the
 * suspect boxes: widening every cell puts a neighbouring number in frame and
 * then the cell shows two, with no way to tell which is the dimension.
 */
const RESCUE_CROP_PT = 44;

/** A box too small to hold a number, opened out about its own centre. */
const atLeast = (b: { x0: number; y0: number; x1: number; y1: number }) => {
  if (Math.max(b.x1 - b.x0, b.y1 - b.y0) >= SUSPECT_LABEL_PT) return b;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const half = RESCUE_CROP_PT / 2;
  return { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
};

// A dimension with NO label box is left out of the contact sheet -- there is
// nothing to crop -- but every other cell keeps the name it had, because the
// name is the dimension's own index and not its position in the grid. A cell
// renamed by a neighbour dropping out would silently invalidate every saved
// reading, which is the one thing --labels-from cannot survive.
const regionsFor = (page: number, dims: IsoDimension[]): ContactSheetRegion[] =>
  dims
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.labelBox)
    .map(({ d, i }) => ({
      label: `${page}-${i + 1}`,
      bbox: atLeast(d.labelBox!),
      // The number reads ALONG its dimension line, so turn the crop upright.
      // Folded to the nearest half-turn first: a label at 150 degrees reads
      // the same way up as one at -30, and rotating it by 150 would stand it
      // on its head.
      rotateDeg: ((d.degrees + 90) % 180) - 90,
    }));

async function readValues(
  buf: Buffer,
  byPage: Array<{ pageNumber: number; regions: ContactSheetRegion[] }>,
  previewPath?: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const png = await renderMultiPageContactSheet(buf, byPage);
  if (!png) return out;
  const cellCount = byPage.reduce((n, p) => n + p.regions.length, 0);
  console.log(`   contact sheet: ${cellCount} dimension labels from pages ${byPage.map((p) => p.pageNumber).join(", ")} in one image`);
  if (previewPath) {
    writeFileSync(previewPath, Buffer.from(png, "base64"));
    console.log(`   preview written to ${previewPath} -- nothing sent, no cost`);
    return out;
  }

  const client = new Anthropic({ apiKey: loadApiKey() });
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    system: buildSystemPrompt("piping isometric drawing"),
    tools: [ISO_DIMENSIONS_TOOL],
    tool_choice: { type: "tool", name: ISO_DIMENSIONS_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          {
            type: "text",
            text:
              `Each box is one dimension's printed length, cut from an isometric drawing. The cell label is printed under each box as "#1-8", "#2-3" and so on -- the first part is the drawing sheet, the rest its position in this grid.\n` +
              `Read the NUMBER in every box, digits only. Most are rotated to run along their own dimension line; read them in whatever orientation they are printed.\n` +
              `A box may also clip a cut-piece marker in angle brackets (<6>), a square BOM item balloon ([9]) or a hexagonal weld flag (BW7). None of those is the dimension.\n` +
              `There are ${cellCount} cells; return ${cellCount} entries, giving each cell's printed label in the "cell" field exactly as shown (e.g. "1-8"). Leave "value" empty for any box you cannot read with confidence.`,
          },
        ],
      },
    ],
  });
  const block = message.content.find((b) => b.type === "tool_use");
  if (block && block.type === "tool_use") {
    for (const d of (block.input as { dimensions?: Array<{ cell: string | number; value: string }> }).dimensions ?? []) {
      out.set(String(d.cell).trim(), String(d.value ?? "").trim());
    }
  }
  const u = message.usage;
  const cost = (u.input_tokens / 1e6) * 15 + (u.output_tokens / 1e6) * 75;
  console.log(`   read ${out.size} values  (${u.input_tokens} in / ${u.output_tokens} out, ~$${cost.toFixed(3)})`);
  return out;
}

/**
 * What can be checked without knowing the answer.
 *
 * The weld flags have a strong self-check -- the numbers must come back as a
 * complete unduplicated 1..N. Lengths have no such invariant, so the checks
 * here are weaker and are reported rather than enforced: every cell answered,
 * every answer numeric, and how far from being to scale each axis is. That
 * last one is the useful one. A sheet is not drawn to scale, so mm-per-point
 * varies -- but a reading that is an order of magnitude out of line with its
 * neighbours on the same axis is far more likely to be a misread digit than a
 * draughtsman's break, and it says WHICH cell to go and look at.
 */
function report(page: number, dims: IsoDimension[], values: Map<string, string>) {
  const want = dims.filter((d) => d.labelBox).length;
  const got: Array<{ cell: string; mm: number; pt: number; deg: number }> = [];
  const blank: string[] = [];
  dims.forEach((d, i) => {
    if (!d.labelBox) return;
    const cell = `${page}-${i + 1}`;
    const raw = values.get(cell);
    if (raw == null) return;
    const mm = Number(raw);
    if (!raw || !Number.isFinite(mm) || mm <= 0) blank.push(cell);
    else got.push({ cell, mm, pt: d.pagePt, deg: d.degrees });
  });
  console.log(`page ${page}: ${got.length}/${want} values read${blank.length ? `, unreadable: ${blank.join(", ")}` : ""}`);
  for (const axis of [30, 90, 150]) {
    const on = got.filter((g) => Math.abs(g.deg - axis) <= 4);
    if (on.length < 2) continue;
    const scales = on.map((g) => g.mm / g.pt).sort((a, b) => a - b);
    const med = scales[Math.floor(scales.length / 2)];
    const odd = on.filter((g) => g.mm / g.pt > med * 4 || g.mm / g.pt < med / 4);
    console.log(
      `   axis ${String(axis).padStart(3)}deg: ${on.length} read, ${med.toFixed(1)} mm/pt median` +
        (odd.length ? `  -- CHECK ${odd.map((g) => `${g.cell}=${g.mm}(${(g.mm / g.pt).toFixed(1)})`).join(", ")}` : "")
    );
  }
}

async function main() {
  const [, , pdfPath, outPath, ...rest] = process.argv;
  if (!pdfPath || !outPath) {
    console.error("usage: tsx scripts/export-dimensions.ts <file.pdf> <out.json> [--read-labels 1,2] [--preview x.png] [--labels-from x.json]");
    process.exit(1);
  }
  const arg = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const previewPath = arg("--preview");
  const labelsFrom = arg("--labels-from");
  const buf = readFileSync(pdfPath);
  const pageCount = await readPageCount(buf);
  const labelPages = (arg("--read-labels") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => n >= 1 && n <= pageCount);

  // Find every dimension first -- free, and on every page whether or not its
  // labels are being read, so the geometry is complete in the output either way.
  const located: Array<{ page: number; dims: IsoDimension[]; width: number; height: number }> = [];
  for (let page = 1; page <= pageCount; page++) {
    const r = await readDimensions(buf, page);
    located.push({ page, dims: r.dimensions, width: r.width, height: r.height });
    const split = r.dimensions.filter((d) => d.drawnAs === "split").length;
    const pipe = r.dimensions.filter((d) => d.measuresPipe).length;
    console.log(
      `page ${page}: ${r.dimensions.length} dimensions (${split} split by their text), ${pipe} measuring pipe, ${r.dimensions.filter((d) => d.labelBox).length} with a label box`
    );
  }

  // Replaying a saved set of labels checks every page it covers, not just the
  // pages a --read-labels run would have named -- checking is the whole point
  // of replaying.
  const wanted = labelsFrom ? located : located.filter((l) => labelPages.includes(l.page));
  const values = labelsFrom
    ? new Map<string, string>(Object.entries(JSON.parse(readFileSync(labelsFrom, "utf8")) as Record<string, string>))
    : labelPages.length
      ? await readValues(buf, wanted.map((l) => ({ pageNumber: l.page, regions: regionsFor(l.page, l.dims) })), previewPath)
      : new Map<string, string>();
  if (labelsFrom) console.log(`\n   ${values.size} values read from ${labelsFrom} -- no call made`);
  if (previewPath) return;
  console.log("");
  for (const l of wanted) report(l.page, l.dims, values);

  const pages = located.map(({ page, dims, width, height }) => ({
    page,
    width,
    height,
    dimensions: dims.map((d, i) => {
      const raw = values.get(`${page}-${i + 1}`);
      const mm = Number(raw);
      return {
        cell: `${page}-${i + 1}`,
        mm: raw && Number.isFinite(mm) && mm > 0 ? mm : null,
        from: { x: Number(d.from.x.toFixed(1)), y: Number(d.from.y.toFixed(1)) },
        to: { x: Number(d.to.x.toFixed(1)), y: Number(d.to.y.toFixed(1)) },
        // Where the number was found. Carried so a cell that came back
        // unreadable can be traced to a box on the wrong glyphs rather than
        // guessed at.
        labelBox: d.labelBox ?? null,
        pagePt: d.pagePt,
        degrees: d.degrees,
        drawnAs: d.drawnAs,
        measuresPipe: d.measuresPipe,
        witnessDegrees: d.witnessDegrees,
        // Where it meets the run, and how much pipe is under it. This is
        // what puts the length into a spool later.
        attach: d.attach,
      };
    }),
  }));

  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 2));
  const total = pages.reduce((s, p) => s + p.dimensions.length, 0);
  const read = pages.reduce((s, p) => s + p.dimensions.filter((d) => d.mm != null).length, 0);
  console.log(`\nwrote ${outPath}: ${total} dimensions, ${read} with a length`);
}

main();
