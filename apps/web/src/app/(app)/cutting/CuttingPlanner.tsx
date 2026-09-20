"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  checkClearances,
  cutPlanToDxf,
  cutPlanToPdf,
  labelAnchor,
  nestParts,
  nestResultToCutPlan,
  type CutPart,
  type NestedPlate,
  type NestResult,
  type StockPlate,
} from "@easy/shared";
import { Alert, EmptyState } from "@/components/ui/primitives";
import { IconDownload, IconNest, IconPlus, IconPrinter } from "@/components/ui/icons";
import { runTrueShapeNest, saveCuttingQuantities, saveCuttingStock } from "./actions";

// The nest is recomputed in the browser as the stock and the allowances are
// typed. It is a pure function of the part list and those numbers, and the
// part list is small, so a round trip to the server would buy nothing but
// latency -- and being able to see the plate count move as you change the
// stock size is the point of the page.

interface StockRow {
  id: string;
  lengthMm: string;
  widthMm: string;
  thicknessMm: string;
  material: string;
  // How many plates of this size the job may use. Held as a string like the
  // rest so a half-typed number does not snap back under the cursor.
  quantity: string;
}

// Shown only when the project has no stock saved yet, so a first visit nests
// something instead of showing an empty page. The moment it is edited and
// saved it stops being a default and becomes the project's answer.
const STARTER_STOCK: StockRow[] = [
  { id: "s1", lengthMm: "6000", widthMm: "2000", thicknessMm: "12", material: "", quantity: "1" },
];

// The stock the drawing itself names, where it names one.
export interface DrawingStock {
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  material: string | null;
  statedAs: string | null;
}

export interface SavedStock {
  id: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  material: string | null;
  quantity: number;
}

const COMMON_PLATES = [
  { label: "6000 x 2000", lengthMm: 6000, widthMm: 2000 },
  { label: "3000 x 1500", lengthMm: 3000, widthMm: 1500 },
  { label: "2440 x 1220", lengthMm: 2440, widthMm: 1220 },
];

const asRows = (rows: SavedStock[]): StockRow[] =>
  rows.map((r) => ({
    id: r.id,
    lengthMm: String(r.lengthMm),
    widthMm: String(r.widthMm),
    thicknessMm: String(r.thicknessMm),
    material: r.material ?? "",
    quantity: String(r.quantity ?? 1),
  }));

function num(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A plate count of "0" or "" is a half-typed 1, not an instruction to nest on
// nothing, so it reads as one plate until a real number replaces it.
function count(value: string): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

// Like count(), but zero is a legitimate answer: "not cutting this one on this
// run" is a thing to want, and it is clearer than deleting the row.
function count0(value: string): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

// Enough distinct hues to tell parts apart on a plate, cycled by part rather
// than by placement so the four copies of one part read as one part.
const PART_COLOURS = [
  "#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2",
  "#ca8a04", "#dc2626", "#4f46e5", "#059669", "#db2777",
];

export function CuttingPlanner({
  projectId,
  projectName,
  drawingId,
  parts,
  drawnQuantities,
  savedQuantities,
  initialStock,
  drawingStock,
}: {
  projectId: string;
  projectName: string;
  drawingId: string | null;
  parts: CutPart[];
  // How many times each shape was DRAWN on the sheet, before anyone said how
  // many to cut. Shown next to the editable figure so the two are never
  // confused for each other.
  drawnQuantities: Record<string, number>;
  savedQuantities: Record<string, number>;
  initialStock: SavedStock[];
  drawingStock?: DrawingStock | null;
}) {
  const [stock, setStock] = useState<StockRow[]>(() =>
    initialStock.length
      ? asRows(initialStock)
      : drawingStock
        ? [{
            id: "drawing",
            lengthMm: String(drawingStock.lengthMm),
            widthMm: String(drawingStock.widthMm),
            thicknessMm: String(drawingStock.thicknessMm),
            material: drawingStock.material ?? "",
            quantity: "1",
          }]
        : STARTER_STOCK
  );
  // What is actually in the database, so the page can say whether what is on
  // screen has been written down yet -- a plan nested against unsaved stock is
  // a plan the next person to open the project will not see.
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(initialStock.length ? asRows(initialStock) : null));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  // Parts turn freely, and there is nothing to ask about it: a plate has no
  // grain, so the only thing that ever fixes a part's orientation is a
  // called-out rolling direction on the drawing -- and that travels with the
  // part (CutPart.rotatable), where the nester already honours it per piece.
  // A global switch could only ever make the nest worse than the drawing
  // requires, so it is not offered.
  const allowRotation = true;
  // Two different questions get asked of this page. "Will it fit on the plate
  // I have?" needs the counts respected; "how much plate should I order?"
  // needs them ignored. The counts are still what is saved either way -- this
  // only says whether the nest is allowed to exceed them.
  const [unlimited, setUnlimited] = useState(false);
  const router = useRouter();

  const dirty = JSON.stringify(stock) !== savedSnapshot;

  const save = () => {
    setSaveError(null);
    const rows = stock.map((row) => ({
      lengthMm: num(row.lengthMm),
      widthMm: num(row.widthMm),
      thicknessMm: num(row.thicknessMm),
      material: row.material.trim() || null,
      quantity: count(row.quantity),
    }));
    startSaving(async () => {
      // The action returns its reason rather than throwing it, so a refusal --
      // a number out of range, a lost session -- lands on screen instead of
      // disappearing into a server digest.
      const result = await saveCuttingStock(projectId, rows);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      // Adopt what the database now holds, ids included. Marking the typed
      // rows as saved instead would leave the page claiming a state it had
      // never read back -- which is how stock came to look saved and then
      // vanish on refresh.
      const written = asRows(result.rows);
      setStock(written);
      setSavedSnapshot(JSON.stringify(written));
    });
  };

  const stocks: StockPlate[] = useMemo(
    () =>
      stock
        .map((row) => ({
          id: row.id,
          lengthMm: num(row.lengthMm),
          widthMm: num(row.widthMm),
          thicknessMm: num(row.thicknessMm),
          material: row.material.trim() || null,
          quantity: unlimited ? null : count(row.quantity),
        }))
        .filter((s) => s.lengthMm > 0 && s.widthMm > 0 && s.thicknessMm > 0),
    [stock, unlimited]
  );

  const boxNest = useMemo(() => nestParts(parts, stocks, { allowRotation }), [parts, stocks, allowRotation]);

  // The true-shape nest, when one has been run. Held rather than derived: it
  // takes seconds, so it is an answer to a question you asked, not something
  // that recomputes under you as you type.
  const [shapeNest, setShapeNest] = useState<NestResult | null>(null);
  const [shapeError, setShapeError] = useState<string | null>(null);
  const [shaping, startShaping] = useTransition();
  // Any edit to the stock or the rotation rule invalidates it -- a layout for
  // a plate you are no longer cutting from is worse than no layout.
  const shapeKey = JSON.stringify(stocks);
  const [shapeKeyRun, setShapeKeyRun] = useState<string | null>(null);
  const shapeStale = shapeNest != null && shapeKeyRun !== shapeKey;
  const nest = shapeNest && !shapeStale ? shapeNest : boxNest;

  // Every part that came from CAD, and therefore has a cut line rather than
  // just a size.
  const outlined = parts.filter((p) => p.outlineRings?.length).length;

  const runShapeNest = () => {
    setShapeError(null);
    const target = stocks[0];
    if (!target) {
      setShapeError("Set a stock plate first.");
      return;
    }
    const key = shapeKey;
    startShaping(async () => {
      const result = await runTrueShapeNest(
        projectId,
        drawingId,
        {
          id: target.id,
          lengthMm: target.lengthMm,
          widthMm: target.widthMm,
          thicknessMm: target.thicknessMm,
          material: target.material,
          quantity: target.quantity ?? 1,
        },
        allowRotation
      );
      if (!result.ok) {
        setShapeError(result.error);
        setShapeNest(null);
        return;
      }
      setShapeNest(result.nest);
      setShapeKeyRun(key);
    });
  };

  const colourOf = useMemo(() => {
    const map = new Map<string, string>();
    parts.forEach((p, i) => map.set(p.id, PART_COLOURS[i % PART_COLOURS.length]));
    return (partId: string) => map.get(partId) ?? "#64748b";
  }, [parts]);

  // Both files are built in the browser, from the nest already on screen.
  // Going to the server for them would mean nesting twice and having to keep
  // the two results identical -- and what is exported has to be exactly what
  // was looked at and approved, not a re-run of it.
  // Both files are cut from ONE plan object, built once per click. Building
  // them from separate calls invited exactly the failure that showed up: a DXF
  // downloaded from one nest and a PDF from a later one, each internally
  // correct and the pair disagreeing. Both now carry the same layout id, so a
  // stale pair is visible without opening them.
  const buildPlan = () =>
    nestResultToCutPlan(nest, {
      title: `Cutting Plan - ${projectName}`,
      subtitle:
        `${stocks.map((s) => `${s.lengthMm} x ${s.widthMm} x ${s.thicknessMm} mm${s.material ? ` ${s.material}` : ""}`).join("; ")}` +
        ` - plasma - ${new Date().toISOString().slice(0, 10)}`,
      extraNotes: [
        shapeNest && !shapeStale
          ? "Nested on the parts' TRUE OUTLINES, read from the CAD file -- parts sit inside each other's concave regions."
          : "Nested on BOUNDING BOXES. Each part reserves the full rectangle around it.",
      ],
    });

  const saveBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    // Revoked on the next tick: revoking synchronously can beat the download
    // in some browsers and hand the user an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const download = (kinds: Array<"pdf" | "dxf">) => {
    const plan = buildPlan();
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `Cutting Plan - ${projectName} - ${stamp} - ${plan.planId}`;
    // Spaced out, not fired in one tick. Two programmatic downloads started
    // together get one of them dropped by the browser -- which lands as a
    // zero-byte file next to a good one, and nothing on screen says so.
    kinds.forEach((kind, i) => {
      window.setTimeout(() => {
        saveBlob(
          kind === "pdf"
            ? new Blob([cutPlanToPdf(plan) as BlobPart], { type: "application/pdf" })
            : new Blob([cutPlanToDxf(plan)], { type: "application/dxf" }),
          `${base}.${kind}`
        );
      }, i * 700);
    });
  };

  // Exporting the bounding-box layout while the true-shape one is still being
  // computed is the worst thing this page can do: the file looks finished,
  // carries fewer pieces and looser allowances, and nothing on it says it was
  // the draft. So export is shut until the layout on screen is the real one.
  const exportBlocked = outlined > 0 && (shaping || !shapeNest || shapeStale);

  // Where the parts have real outlines, the true-shape layout is the answer --
  // the bounding-box one reserves a rectangle per part and on irregular
  // profiles that is most of a plate wasted. So it runs on its own rather than
  // waiting to be asked, once, when the page opens. The button stays for
  // re-running it after the stock changes.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || outlined === 0 || shapeNest || shaping) return;
    autoRan.current = true;
    runShapeNest();
    // Deliberately only on the part list: re-running on every stock keystroke
    // would queue a five-second search per character typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlined]);

  // Quantities are edited against the drawn counts and saved as a set, the
  // same way the stock is: a half-saved parts list would nest a job nobody
  // asked for.
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.keys(drawnQuantities).map((mark) => [mark, String(savedQuantities[mark] ?? drawnQuantities[mark] ?? 1)])
    )
  );
  const [qtySnapshot, setQtySnapshot] = useState(() =>
    JSON.stringify(
      Object.fromEntries(
        Object.keys(drawnQuantities).map((mark) => [mark, String(savedQuantities[mark] ?? drawnQuantities[mark] ?? 1)])
      )
    )
  );
  const [qtyError, setQtyError] = useState<string | null>(null);
  const [savingQty, startSavingQty] = useTransition();
  const qtyDirty = JSON.stringify(qty) !== qtySnapshot;

  const saveQuantities = () => {
    setQtyError(null);
    const snapshot = JSON.stringify(qty);
    startSavingQty(async () => {
      const result = await saveCuttingQuantities(
        projectId,
        Object.entries(qty).map(([partMark, value]) => ({ partMark, quantity: count0(value) }))
      );
      if (!result.ok) {
        setQtyError(result.error);
        return;
      }
      setQtySnapshot(snapshot);
      // The nest is a function of the quantities, and they now live on the
      // server -- so the page has to come back from the server to reflect them.
      router.refresh();
    });
  };

  // Measured on the finished outlines, not on the raster the nester placed
  // them with. This is the number that says whether the pieces cut to size.
  const clearance = useMemo(() => checkClearances(nest), [nest]);

  // A shortfall is the one condition that changes what the page is saying:
  // the layouts stop being "the plan" and become "the plan for the plate you
  // have", with the rest listed as not cut.
  const short = nest.stockUsage.some((u) => u.short);

  const updateStock = (id: string, patch: Partial<StockRow>) =>
    setStock((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-6">
      {/* ---- stock and allowances ------------------------------------- */}
      <div className="no-print card">
        <h2 className="card-title">Plate stock</h2>
        {drawingStock && (
          <p className="callout mt-3 text-xs">
            The drawing states its own stock
            {drawingStock.statedAs ? ` — “${drawingStock.statedAs}”` : ""}, and that is what is loaded below. Change it
            only if you are actually cutting from something else.
          </p>
        )}
        <p className="mb-4 mt-2 max-w-3xl text-[0.8125rem] leading-relaxed text-muted-foreground">
          The plate you are cutting from. Parts are grouped by thickness first &mdash; a 12 mm part cannot come off a 10 mm plate &mdash;
          so add a row per thickness you hold. A row left without a grade is treated as usable for any part.{" "}
          <strong className="text-foreground">Plates available</strong> is how many of that size the job may use: the nest will not
          open one more than that, and anything that will not fit within them is reported rather than drawn onto plate nobody has.
        </p>
        <div className="overflow-hidden rounded-lg border">
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Length (mm)</th>
                  <th>Width (mm)</th>
                  <th>Thickness (mm)</th>
                  <th>Grade</th>
                  <th>Plates available</th>
                  <th>Plates used</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {stock.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <input
                        value={row.lengthMm}
                        onChange={(e) => updateStock(row.id, { lengthMm: e.target.value })}
                        className="input input-sm w-28"
                        inputMode="decimal"
                        aria-label="Plate length in millimetres"
                      />
                    </td>
                    <td>
                      <input
                        value={row.widthMm}
                        onChange={(e) => updateStock(row.id, { widthMm: e.target.value })}
                        className="input input-sm w-28"
                        inputMode="decimal"
                        aria-label="Plate width in millimetres"
                      />
                    </td>
                    <td>
                      <input
                        value={row.thicknessMm}
                        onChange={(e) => updateStock(row.id, { thicknessMm: e.target.value })}
                        className="input input-sm w-24"
                        inputMode="decimal"
                        aria-label="Plate thickness in millimetres"
                      />
                    </td>
                    <td>
                      <input
                        value={row.material}
                        onChange={(e) => updateStock(row.id, { material: e.target.value })}
                        placeholder="e.g. A516 GR.70"
                        className="input input-sm w-44"
                        aria-label="Plate grade"
                      />
                    </td>
                    <td>
                      <input
                        value={row.quantity}
                        onChange={(e) => updateStock(row.id, { quantity: e.target.value.replace(/[^0-9]/g, "") })}
                        className="input input-sm w-20"
                        inputMode="numeric"
                        disabled={unlimited}
                        aria-label="Plates available"
                        title={unlimited ? "Ignored while the nest is allowed as many plates as it needs." : undefined}
                      />
                    </td>
                    <td className="tabular-nums">
                      {(() => {
                        const use = nest.stockUsage.find((u) => u.stockId === row.id);
                        if (!use) return <span className="text-muted-foreground">&mdash;</span>;
                        return (
                          <span className={use.short ? "font-medium text-danger" : use.used === 0 ? "text-muted-foreground" : "text-foreground"}>
                            {use.used}
                            {use.available != null ? ` of ${use.available}` : ""}
                            {use.short ? " — not enough" : ""}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="text-right">
                      {stock.length > 1 && (
                        <button
                          onClick={() => setStock((rows) => rows.filter((r) => r.id !== row.id))}
                          className="btn btn-danger btn-xs"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={() =>
              setStock((rows) => [
                ...rows,
                { id: `s${Date.now()}`, lengthMm: "6000", widthMm: "2000", thicknessMm: "", material: "", quantity: "1" },
              ])
            }
            className="btn btn-secondary btn-xs"
          >
            <IconPlus size={13} />
            Add plate size
          </button>
          <span className="text-muted-foreground">Quick set first row:</span>
          {COMMON_PLATES.map((p) => (
            <button
              key={p.label}
              onClick={() => stock[0] && updateStock(stock[0].id, { lengthMm: String(p.lengthMm), widthMm: String(p.widthMm) })}
              className="btn btn-secondary btn-xs"
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span className="font-medium">
            Use as many plates as the job needs
            <span className="mt-0.5 block max-w-3xl text-xs font-normal leading-relaxed text-muted-foreground">
              Ignores the counts above and answers &ldquo;how much plate should I order?&rdquo;. Leave it off to answer &ldquo;does it
              fit on the plate I have?&rdquo; &mdash; then anything that does not fit is listed rather than nested onto plate nobody
              holds. The counts are saved either way.
            </span>
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="btn btn-primary"
          >
            {saving ? "Saving..." : "Save stock for this project"}
          </button>
          {saveError ? (
            <span className="text-xs text-danger">{saveError}</span>
          ) : dirty ? (
            <span className="text-xs text-warning">
              Unsaved &mdash; the nest below already uses these figures, but nobody else on the project will see them until you save.
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Saved to the project &mdash; it will be here on your next visit.</span>
          )}
        </div>
      </div>

      {/* ---- result ---------------------------------------------------- */}
      {/* Gated on what was EXTRACTED, not on what is being cut. Setting every
          quantity to zero is allowed, and gating on the nested parts would then
          take the quantity table off the page along with everything else --
          leaving no way to put a number back. */}
      {Object.keys(drawnQuantities).length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconNest />} title="No parts extracted yet">
            Upload a cutting drawing and wait for its extraction to finish.
          </EmptyState>
        </div>
      ) : (
        <>
          {/* The quantity decision comes before the layout, because it is
              the input to it: how many of each part, then where they go. */}
          <div className="card">
            <h2 className="card-title mb-1">Parts read from the drawing &mdash; and how many to cut</h2>
            <p className="mb-4 max-w-3xl text-[0.8125rem] leading-relaxed text-muted-foreground">
              <strong className="text-foreground">Drawn</strong> is how many times the extraction found that shape on the sheet. That is
              a measurement, not an instruction: a cutting sheet often lays out one representative piece and states the real count in
              its parts table. So <strong className="text-foreground">To cut</strong> is yours to set, and it is what the nest below
              uses. Set it to 0 to leave a part out of this run.
            </p>
            <div className="overflow-hidden rounded-lg border">
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Part mark</th>
                      <th className="w-24">Shape</th>
                      <th className="w-40">Cut size (mm)</th>
                      <th className="w-24">Thk</th>
                      <th className="w-16">Drawn</th>
                      <th className="w-24">To cut</th>
                      <th>Dimensions printed on the drawing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(drawnQuantities).map((mark) => {
                      const p = parts.find((q) => q.partNo === mark);
                      const drawn = drawnQuantities[mark];
                      const value = qty[mark] ?? String(drawn);
                      const changed = count0(value) !== drawn;
                      return (
                        <tr key={mark} className={count0(value) === 0 ? "opacity-50" : ""}>
                          <td>
                            {p && (
                              <span className="inline-block h-3 w-3 rounded-sm align-middle" style={{ background: colourOf(p.id) }} />
                            )}{" "}
                            <span className="font-mono text-xs font-medium">{mark}</span>
                            {p && !p.rotatable && <span className="ml-2 text-xs text-warning">grain fixed</span>}
                          </td>
                          <td className="text-xs text-muted-foreground">{p?.shape ?? "-"}</td>
                          <td className="font-mono text-xs">
                            {p ? `${p.lengthMm.toFixed(2)} × ${p.widthMm.toFixed(2)}` : "-"}
                          </td>
                          <td className="text-xs">
                            {p?.thicknessMm ?? <span className="text-warning">not stated</span>}
                          </td>
                          <td className="text-xs tabular-nums text-muted-foreground">{drawn}</td>
                          <td>
                            <input
                              value={value}
                              onChange={(e) => setQty((q) => ({ ...q, [mark]: e.target.value.replace(/[^0-9]/g, "") }))}
                              inputMode="numeric"
                              aria-label={`Number of ${mark} to cut`}
                              className={`input input-sm w-16 ${changed ? "border-primary font-medium" : ""}`}
                            />
                          </td>
                          <td className="text-xs text-muted-foreground">{p?.description ?? "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
              <button
                onClick={saveQuantities}
                disabled={savingQty || !qtyDirty}
                className="btn btn-primary"
              >
                {savingQty ? "Saving..." : "Save quantities and re-nest"}
              </button>
              {qtyError ? (
                <span className="text-xs text-danger">{qtyError}</span>
              ) : qtyDirty ? (
                <span className="text-xs text-warning">
                  Unsaved &mdash; the layout below is still nesting the old counts.
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {Object.entries(qty).reduce((sum, [, v]) => sum + count0(v), 0)} piece
                  {Object.entries(qty).reduce((sum, [, v]) => sum + count0(v), 0) === 1 ? "" : "s"} to cut across{" "}
                  {Object.values(qty).filter((v) => count0(v) > 0).length} part
                  {Object.values(qty).filter((v) => count0(v) > 0).length === 1 ? "" : "s"}.
                </span>
              )}
            </div>
          </div>

          <div className="no-print card flex flex-col gap-3">
            <h2 className="card-title">How the parts are arranged</h2>
            {outlined === 0 ? (
              <p className="max-w-3xl text-[0.8125rem] leading-relaxed text-muted-foreground">
                These parts came from a plotted PDF, which records the dimension figures but not the geometry &mdash; so each part is
                nested and drawn as its <strong className="text-foreground">bounding box</strong>, the rectangle it reserves, not the
                shape that gets cut. <strong className="text-foreground">Upload the DWG or DXF of the same drawing</strong> and the real
                profiles are read straight out of it; parts then nest inside each other&apos;s concave regions instead of each paying
                for a full rectangle.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={runShapeNest}
                    disabled={shaping}
                    className="btn btn-primary"
                  >
                    {shaping ? "Nesting to the true shapes..." : shapeNest && !shapeStale ? "Re-run true-shape nest" : "Nest to the true shapes"}
                  </button>
                  {shapeError ? (
                    <span className="max-w-2xl text-xs text-danger">{shapeError}</span>
                  ) : shaping ? (
                    <span className="text-xs text-muted-foreground">
                      Rasterising every part at every angle and searching &mdash; this takes a few seconds.
                    </span>
                  ) : shapeStale ? (
                    <span className="text-xs text-warning">
                      The stock changed since this was nested &mdash; showing the bounding-box layout again. Re-run it.
                    </span>
                  ) : shapeNest ? (
                    <span className="text-xs text-success">
                      Nested on the true outlines. Everything below is this layout.
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {outlined} of {parts.length} parts carry a real cut line. Until you run this, the layout below reserves a full
                      rectangle for each one.
                    </span>
                  )}
                </div>
                <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                  The bounding-box nest is instant and updates as you edit the stock, so it is what you plan against. The true-shape nest
                  is the one to issue: it packs the profiles themselves, which on an irregular part is the difference between paying for
                  the rectangle and paying for the metal.
                </p>
              </>
            )}
          </div>


          {parts.length === 0 && (
            <Alert tone="warning">
              Every part is set to cut 0, so there is nothing to nest. Put a count against the parts you are cutting in the table below
              and save.
            </Alert>
          )}

          {clearance.plates.length > 0 && (
            <Alert tone={clearance.ok ? "success" : "danger"}>
              {clearance.ok ? (
                <>
                  <strong>Cutting allowance checked.</strong> Measured between the finished outlines, the tightest gap anywhere on this
                  layout is <strong>{clearance.minGapMm} mm</strong> against the {clearance.plates[0].requiredGapMm} mm required, and the
                  closest approach to a plate edge is <strong>{clearance.minEdgeMm} mm</strong> against{" "}
                  {clearance.plates[0].requiredEdgeMm} mm. Every piece keeps its full kerf and web, so every piece cuts to the drawn size.
                </>
              ) : (
                <>
                  <strong>
                    {clearance.violations.length} place{clearance.violations.length === 1 ? " is" : "s are"} tighter than the cutting
                    allowance.
                  </strong>{" "}
                  Tightest gap {clearance.minGapMm} mm against {clearance.plates[0].requiredGapMm} mm required. Those pieces may come off
                  undersized.
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {clearance.violations.slice(0, 6).map((v, i) => (
                      <li key={i}>
                        {v.a} to {v.b}: <span className="font-mono">{v.actualMm} mm</span> where {v.requiredMm} mm is required
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Alert>
          )}

          <div className="flex flex-wrap gap-4">
            <Stat
              label={unlimited ? "Plates required" : "Plates used"}
              value={
                unlimited || nest.totals.plateCountAvailable == null
                  ? String(nest.totals.plateCount)
                  : `${nest.totals.plateCount} of ${nest.totals.plateCountAvailable}`
              }
              tone={short ? "warn" : "plain"}
            />
            <Stat label="Plate bought" value={`${nest.totals.plateAreaM2.toFixed(2)} m²`} />
            <Stat label="Taken by parts" value={`${nest.totals.partAreaM2.toFixed(2)} m²`} />
            <Stat label="Waste" value={`${nest.totals.wasteM2.toFixed(2)} m²`} tone={nest.totals.utilisation < 0.6 ? "warn" : "plain"} />
            <Stat label="Utilisation" value={`${(nest.totals.utilisation * 100).toFixed(1)} %`} tone={nest.totals.utilisation < 0.6 ? "warn" : "good"} />
          </div>

          <p className="callout max-w-3xl text-xs leading-relaxed">
            Utilisation is measured on each part&apos;s <strong className="text-foreground">bounding box</strong>, which is what the
            drawing dimensions and what this plan reserves. A part cut to an irregular profile &mdash; a gusset with a radius bitten out
            of it &mdash; does not use all of its box, so the real metal taken is lower than the figure above and the plate count is an
            honest upper bound. Closing that gap needs the true outline, which a plotted PDF does not carry; the CAD DXF does.
          </p>

          {nest.assumedThicknessParts.length > 0 && (
            <Alert tone="warning">
              The drawing states no plate thickness for{" "}
              {nest.assumedThicknessParts.length === parts.length ? "any part" : `${nest.assumedThicknessParts.length} part(s)`}, so they
              are nested on the first stock row ({stocks[0]?.thicknessMm ?? "?"} mm). That is only right if that is the plate going on the
              table &mdash; set the thickness above to the one you are cutting.
            </Alert>
          )}

          {short && (
            <Alert tone="danger">
              The stock list allows {nest.totals.plateCountAvailable ?? 0} plate
              {nest.totals.plateCountAvailable === 1 ? "" : "s"} and the job does not fit on{" "}
              {nest.totals.plateCountAvailable === 1 ? "it" : "them"}. The layouts below are for the plate you have; everything that
              needs another plate is listed under <strong>Not nested</strong>. Raise a count above, or tick &ldquo;use as many plates as
              the job needs&rdquo; to see how many it would actually take.
            </Alert>
          )}

          {nest.unplaced.length > 0 && (
            <div className="card card-danger card-flush">
              <div className="card-header">
                <h2 className="card-title text-danger">Not nested</h2>
              </div>
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Part</th>
                      <th className="w-20">Qty</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nest.unplaced.map((u, i) => (
                      <tr key={`${u.part.id}-${i}`}>
                        <td className="font-mono text-xs font-medium">{u.part.partNo}</td>
                        <td className="tabular-nums">{u.quantity}</td>
                        <td className="text-xs text-muted-foreground">{u.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {nest.plates.map((plate) => (
            <PlateView key={plate.index} plate={plate} colourOf={colourOf} />
          ))}

          {/* Last, because exporting is the end of the job: everything above
              is what you are deciding, and this is what you take away. */}
          <div className="no-print card flex flex-col gap-3">
            <h2 className="card-title">Export this plan</h2>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => download(["pdf", "dxf"])}
                disabled={exportBlocked}
                className="btn btn-primary"
              >
                <IconDownload size={16} />
                Download PDF + DXF
              </button>
              <button
                onClick={() => download(["pdf"])}
                disabled={exportBlocked}
                className="btn btn-secondary"
              >
                PDF only
              </button>
              <button
                onClick={() => download(["dxf"])}
                disabled={exportBlocked}
                className="btn btn-secondary"
              >
                DXF only
              </button>
              {exportBlocked && (
                <span className="text-xs text-warning">
                  {shaping
                    ? "Waiting for the true-shape nest to finish — exporting now would give you the bounding-box draft."
                    : "Re-run the true-shape nest first — the layout on screen is the bounding-box draft."}
                </span>
              )}
              <button onClick={() => window.print()} className="btn btn-secondary">
                <IconPrinter size={16} />
                Print this page
              </button>
            </div>
            <div className="callout flex max-w-3xl flex-col gap-2 text-xs leading-relaxed">
              <p>
                The <strong className="text-foreground">PDF</strong> is drawn to scale, A3 landscape, one page per plate, with that
                plate&apos;s cut list under the layout and the allowances printed on it &mdash; issue it to the shop as it is. The{" "}
                <strong className="text-foreground">DXF</strong> is the geometry itself in millimetres, on layers (
                <span className="font-mono">CUT</span>, <span className="font-mono">HOLES</span>,{" "}
                <span className="font-mono">PLATE</span>, <span className="font-mono">EDGE_MARGIN</span>,{" "}
                <span className="font-mono">TEXT</span>), for loading into CAD or CAM.
              </p>
              <p>
                Both files are written from one snapshot of the layout and stamped with the same{" "}
                <strong className="text-foreground">layout id</strong> &mdash; it is in the file name and printed on the drawing. If a
                PDF and a DXF ever show different ids, one of them is from an older nest; take them again together.
              </p>
              <p>
                There is no DWG. DWG is a closed binary format with no published specification and no writer worth trusting outside
                Autodesk&apos;s own; DXF is the interchange format that exists for exactly this, and AutoCAD opens it and saves it as
                DWG in one step. A half-correct DWG would be worse than none.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "plain" }: { label: string; value: string; tone?: "plain" | "good" | "warn" }) {
  const toneClass = tone === "good" ? "stat-good" : tone === "warn" ? "stat-warning" : "";
  return (
    <div className={`stat ${toneClass}`.trim()}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
    </div>
  );
}

// The plate drawn to scale, so the plan can be read the way it will be cut:
// every gap on screen is the gap the torch leaves.
function PlateView({ plate, colourOf }: { plate: NestedPlate; colourOf: (partId: string) => string }) {
  const pad = 40; // room for the plate's own dimension labels
  const vbW = plate.lengthMm + pad * 2;
  const vbH = plate.widthMm + pad * 2;
  // Labels are drawn in plate millimetres, so they have to be sized in them
  // too or they vanish on a 6 m plate and swamp a 1 m one.
  const fs = Math.max(plate.lengthMm, plate.widthMm) / 55;

  return (
    <div className="print-plate card">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="card-title">
          Plate {plate.index} &mdash; {plate.lengthMm} × {plate.widthMm} × {plate.thicknessMm} mm
          {plate.material ? ` ${plate.material}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          {plate.placements.length} part{plate.placements.length === 1 ? "" : "s"} &middot; {(plate.utilisation * 100).toFixed(1)} % used
          &middot; {((plate.plateAreaMm2 - plate.partAreaMm2) / 1_000_000).toFixed(2)} m² waste &middot; {plate.allowances.spacingMm} mm
          between parts, {plate.allowances.edgeMarginMm} mm off the edge
          {plate.largestOffcut
            ? ` · largest usable offcut approx. ${plate.largestOffcut.lengthMm} × ${plate.largestOffcut.widthMm} mm`
            : ""}
        </p>
      </div>

      {/* The drawing is dark ink on light paper -- its dimension labels sit
          OUTSIDE the plate, on whatever is behind the SVG -- so it is given a
          white sheet to sit on in either theme. Without one, dark mode put dark
          labels on a dark card. */}
      <svg viewBox={`0 0 ${vbW} ${vbH}`} className="w-full rounded-lg border bg-white" style={{ maxHeight: "70vh" }} role="img">
        <rect x={pad} y={pad} width={plate.lengthMm} height={plate.widthMm} fill="#f8fafc" stroke="#0f172a" strokeWidth={fs / 6} />

        {plate.placements.map((pl) => {
          const colour = colourOf(pl.partId);
          const cx = pad + pl.x + pl.w / 2;
          const cy = pad + pl.y + pl.h / 2;
          // The real outline, drawn where the part sits. A rotated placement
          // turns the path about the box centre so the profile follows the
          // box rather than staying stubbornly upright inside it -- except
          // where the nester baked an arbitrary angle into the path already,
          // in which case `rotated` is false and nothing more is done to it.
          const at = pl.rotated
            ? `translate(${pad + pl.x} ${pad + pl.y}) rotate(90) translate(0 -${pl.w})`
            : `translate(${pad + pl.x} ${pad + pl.y})`;
          const d = (points: Array<[number, number]>, close: boolean) =>
            "M" + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L") + (close ? "Z" : "");

          // Each solid loop gets its OWN filled element. One path plus a fill
          // rule does not union them: "nonzero" cancels an overlap whose
          // subpaths wind opposite ways, which is exactly a circular boss
          // drawn over a body polyline -- and the cancellation empties the
          // middle of the part. Holes are then painted back to plate colour,
          // and the cut line is stroked last so nothing paints over it.
          const outline = pl.outlineLoops?.length ? (
            <g transform={at}>
              <g opacity={0.28}>
                {pl.outlineLoops.filter((l) => !l.hole).map((l, k) => (
                  <path key={`s${k}`} d={d(l.points, true)} fill={colour} />
                ))}
              </g>
              {pl.outlineLoops.filter((l) => l.hole).map((l, k) => (
                <path key={`h${k}`} d={d(l.points, true)} fill="#f8fafc" />
              ))}
              <path
                d={pl.outlineLoops.map((l) => d(l.points, l.closed)).join(" ")}
                fill="none"
                stroke={colour}
                strokeWidth={fs / 7}
                strokeLinejoin="round"
              />
            </g>
          ) : pl.outlinePath ? (
            <path
              d={pl.outlinePath}
              fill={colour}
              fillOpacity={0.22}
              stroke={colour}
              strokeWidth={fs / 7}
              strokeLinejoin="round"
              transform={at}
            />
          ) : null;

          const body =
            outline ??
            (pl.shape === "circle" ? (
              <ellipse cx={cx} cy={cy} rx={pl.w / 2} ry={pl.h / 2} fill={colour} fillOpacity={0.18} stroke={colour} strokeWidth={fs / 6} />
            ) : (
              <rect
                x={pad + pl.x}
                y={pad + pl.y}
                width={pl.w}
                height={pl.h}
                fill={colour}
                fillOpacity={0.18}
                stroke={colour}
                strokeWidth={fs / 6}
                // A profile does not fill its box, and drawing it as a solid
                // rectangle would claim it does. The dashed edge says "this
                // is the reserved extent", not "this is the cut line".
                strokeDasharray={pl.shape === "profile" ? `${fs / 2} ${fs / 3}` : undefined}
              />
            ));
          return (
            <g key={`${pl.partId}-${pl.instance}`}>
              {/* The reserved extent stays visible behind the profile: the
                  gap between the two is the metal this nest is paying for and
                  not using, which is the thing worth seeing. */}
              {outline && !pl.outlineLoops?.length && (
                <rect
                  x={pad + pl.x}
                  y={pad + pl.y}
                  width={pl.w}
                  height={pl.h}
                  fill="none"
                  stroke={colour}
                  strokeOpacity={0.28}
                  strokeWidth={fs / 12}
                  strokeDasharray={`${fs / 2} ${fs / 3}`}
                />
              )}
              {body}
              {/* Anchored where the part actually has room, not at the centre
                  of its box: on a concave profile the box centre is in the
                  notch, off the metal. Sized to the largest circle that fits
                  there, so a small part gets small text instead of a mark
                  three times its own width lying across its neighbours. */}
              {(() => {
                const anchor =
                  pl.outlineLoops?.length && !pl.rotated ? labelAnchor(pl.outlineLoops, pl.w, pl.h) : null;
                const lx = anchor ? pad + pl.x + anchor.x : cx;
                const ly = anchor ? pad + pl.y + anchor.y : cy;
                const room = anchor ? anchor.r * 2 * 0.85 : Math.min(pl.w, pl.h) * 0.8;
                const size = Math.max(fs * 0.3, Math.min(fs, room / (pl.partNo.length * 0.58)));
                // The size line is the first thing to go: on a cluster of
                // small parts it is what turns labels into a pile.
                const showSize = size > fs * 0.72;
                return (
                  <>
                    <text
                      x={lx}
                      y={ly}
                      fontSize={size}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#0f172a"
                      stroke="#f8fafc"
                      strokeWidth={size / 6}
                      paintOrder="stroke"
                    >
                      {pl.partNo}
                      {pl.rotationDeg ? ` ${pl.rotationDeg}°` : pl.rotated ? " ⟲" : ""}
                    </text>
                    {showSize && (
                      <text
                        x={lx}
                        y={ly + size * 1.25}
                        fontSize={size * 0.72}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#64748b"
                        stroke="#f8fafc"
                        strokeWidth={size / 9}
                        paintOrder="stroke"
                      >
                        {Math.round(pl.w)} × {Math.round(pl.h)}
                      </text>
                    )}
                  </>
                );
              })()}
            </g>
          );
        })}

        <text x={pad + plate.lengthMm / 2} y={pad - fs * 0.8} fontSize={fs} textAnchor="middle" fill="#0f172a">
          {plate.lengthMm} mm
        </text>
        <text
          x={pad - fs * 0.8}
          y={pad + plate.widthMm / 2}
          fontSize={fs}
          textAnchor="middle"
          fill="#0f172a"
          transform={`rotate(-90 ${pad - fs * 0.8} ${pad + plate.widthMm / 2})`}
        >
          {plate.widthMm} mm
        </text>
      </svg>
    </div>
  );
}
