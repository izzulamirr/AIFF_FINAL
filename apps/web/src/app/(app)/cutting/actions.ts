"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { cuttingPartQuantities, cuttingStockPlates, documents, extractedTags } from "@easy/db";
import { nestTrueShapePlan, outlineExtentMm, type CutPart, type NestResult } from "@easy/shared";
import { createClient } from "@/lib/supabase/server";
import { isDcc } from "@/lib/roles";
import { getDb } from "@/lib/db";
import { requireProjectMembership } from "../projects/[id]/actions";

// The cutting plan is Document Control's: cutting drawings are not ISOs, so a
// plain user never reaches the page. These actions are callable directly all the
// same, so each one refuses anyone else. The message says what to do, not just no.
const DCC_ONLY = "Only Document Control (DCC) can use the cutting plan.";

export interface StockPlateInput {
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  material: string | null;
  // How many plates of this size the job may draw on.
  quantity: number;
}

// A stock list long enough to matter is a handful of rows. The cap is here so
// a malformed client cannot write an unbounded set, not because anyone would
// legitimately hold fifty plate sizes on one job.
const MAX_STOCK_ROWS = 25;

// Plate outside this range is not plate. Catching it here keeps a typo -- a
// dropped zero, a length typed into the thickness box -- from being saved and
// then quietly driving every allowance and every nest that follows it.
const LIMITS = {
  lengthMm: { min: 100, max: 30_000 },
  widthMm: { min: 100, max: 6_000 },
  thicknessMm: { min: 0.5, max: 300 },
};

// Matches the CHECK on cutting_stock_plates.quantity. A count of zero would
// mean "this row exists but may not be used", which is what deleting the row
// says more clearly.
const QUANTITY = { min: 1, max: 200 };

function validate(rows: StockPlateInput[]): StockPlateInput[] {
  if (rows.length > MAX_STOCK_ROWS) throw new Error(`Too many stock rows -- the limit is ${MAX_STOCK_ROWS}.`);
  return rows.map((row, i) => {
    const at = `Stock row ${i + 1}`;
    for (const key of ["lengthMm", "widthMm", "thicknessMm"] as const) {
      const value = row[key];
      const limit = LIMITS[key];
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${at}: ${key} must be a number.`);
      if (value < limit.min || value > limit.max) {
        throw new Error(`${at}: ${key} of ${value} mm is outside the ${limit.min}-${limit.max} mm range plate comes in.`);
      }
    }
    const quantity = Math.floor(Number(row.quantity));
    if (!Number.isFinite(quantity) || quantity < QUANTITY.min || quantity > QUANTITY.max) {
      throw new Error(`${at}: number of plates must be a whole number between ${QUANTITY.min} and ${QUANTITY.max}.`);
    }
    const material = typeof row.material === "string" ? row.material.trim().slice(0, 120) : "";
    return {
      lengthMm: row.lengthMm,
      widthMm: row.widthMm,
      thicknessMm: row.thicknessMm,
      material: material || null,
      quantity,
    };
  });
}

export interface SavedStockRow {
  id: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  material: string | null;
  quantity: number;
}

export type SaveStockResult = { ok: true; rows: SavedStockRow[] } | { ok: false; error: string };

// Replaces the project's whole stock list in one transaction. Replace rather
// than merge because the list IS the answer to "what are we cutting from" --
// a partial write would leave a plate on the list that the person editing had
// just deleted, and the nest would go on using it.
//
// Failure is RETURNED, not thrown. A thrown server action reaches the browser
// as an opaque digest in production, so "it will not save" is all anyone can
// see -- exactly the report this page got. A returned reason survives the
// boundary and can be put on screen next to the button.
export async function saveCuttingStock(projectId: string, rows: StockPlateInput[]): Promise<SaveStockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You are signed out -- sign in again and the numbers on screen will still be here." };
  if (!isDcc(user)) return { ok: false, error: DCC_ONLY };

  let clean: StockPlateInput[];
  try {
    await requireProjectMembership(projectId, user.id);
    clean = validate(rows);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The stock list was rejected." };
  }

  const db = getDb();

  let saved;
  try {
    saved = await db.transaction(async (tx) => {
      await tx.delete(cuttingStockPlates).where(eq(cuttingStockPlates.projectId, projectId));
      if (clean.length === 0) return [];
      return tx
        .insert(cuttingStockPlates)
        .values(clean.map((row, i) => ({ ...row, projectId, sortOrder: i })))
        .returning();
    });
  } catch (err) {
    return { ok: false, error: `The database refused the write: ${err instanceof Error ? err.message : String(err)}` };
  }

  revalidatePath("/cutting");

  // The rows as the database now holds them, sent back so the page shows what
  // was written rather than what was typed. Until this returns, "saved" is a
  // claim; after it, it is a read.
  return {
    ok: true,
    rows: saved
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((row) => ({
        id: row.id,
        lengthMm: row.lengthMm,
        widthMm: row.widthMm,
        thicknessMm: row.thicknessMm,
        material: row.material,
        quantity: row.quantity,
      })),
  };
}

// ---------------------------------------------------------------------------
// True-shape nesting
//
// Run on the server, and only when asked. It rasterises every part at every
// candidate angle and searches, which takes seconds rather than milliseconds
// -- on the main thread of a browser that is a frozen page, and it is not
// something to redo on every keystroke in the stock table. The box nest stays
// live underneath it as the thing you edit against.
// ---------------------------------------------------------------------------

export type TrueShapeNestResult = { ok: true; nest: NestResult } | { ok: false; error: string };

export async function runTrueShapeNest(
  projectId: string,
  drawingId: string | null,
  stock: StockPlateInput & { id: string },
  allowRotation: boolean
): Promise<TrueShapeNestResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You are signed out." };
  // Running a nest changes nothing, but it reads the project's cutting drawings,
  // which a plain user does not see -- so it is Document Control's like the rest.
  if (!isDcc(user)) return { ok: false, error: DCC_ONLY };
  try {
    await requireProjectMembership(projectId, user.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not a member of this project." };
  }

  const db = getDb();
  const projectDocs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.docType, "cutting")));
  const docIds = drawingId ? projectDocs.filter((d) => d.id === drawingId).map((d) => d.id) : projectDocs.map((d) => d.id);
  if (docIds.length === 0) return { ok: false, error: "No cutting drawings in this project." };

  const rows = await db
    .select()
    .from(extractedTags)
    .where(and(inArray(extractedTags.documentId, docIds), eq(extractedTags.tagType, "cut_item")));

  const parts: CutPart[] = rows
    .map((row) => {
      const a = row.attributes as Record<string, unknown>;
      const numberOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const rings = Array.isArray(a.outline_rings) ? (a.outline_rings as Array<Array<[number, number]>>) : null;
      const extent = rings ? outlineExtentMm(rings) : null;
      return {
        id: String(row.id),
        partNo: row.tagNumber,
        description: null,
        shape: "profile" as const,
        lengthMm: extent?.lengthMm ?? numberOr(a.length_mm) ?? 0,
        widthMm: extent?.widthMm ?? numberOr(a.width_mm) ?? 0,
        thicknessMm: numberOr(a.thickness_mm),
        material: typeof a.material === "string" ? a.material : null,
        quantity: numberOr(a.quantity) ?? 1,
        rotatable: a.rotatable !== false,
        outlinePath: typeof a.outline_path === "string" ? a.outline_path : null,
        outlineRings: Array.isArray(a.outline_rings) ? (a.outline_rings as CutPart["outlineRings"]) : null,
        outlineRingInfo: Array.isArray(a.outline_ring_info) ? (a.outline_ring_info as CutPart["outlineRingInfo"]) : null,
        netAreaMm2: numberOr(a.net_area_mm2),
      };
    })
    .filter((p) => p.lengthMm > 0 && p.widthMm > 0)
    .sort((a, b) => b.lengthMm * b.widthMm - a.lengthMm * a.widthMm);

  // Same rule the page applies: where the CAD read of a drawing exists, it
  // supersedes the PDF read of it. Without this the PDF's copies of the same
  // pieces come back as "no outline geometry" and read as work not nested.
  const outlined = parts.filter((p) => p.outlineRings?.length);
  const toNest = outlined.length > 0 ? outlined : parts;

  if (outlined.length === 0) {
    return {
      ok: false,
      error:
        "None of these parts carry an outline, so there is no true shape to nest to. They were read from a plotted PDF, which " +
        "records dimensions but not geometry -- upload the DWG or DXF of the same drawing and it will be read as shapes.",
    };
  }

  try {
    const nest = nestTrueShapePlan(toNest, { ...stock, id: stock.id }, { allowRotation });
    return { ok: true, nest };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The true-shape nest failed." };
  }
}

// ---------------------------------------------------------------------------
// Quantities
//
// What the geometry gives is how many times a shape was DRAWN. What the shop
// needs is how many to cut, and on a cutting sheet those routinely differ: one
// representative piece is laid out and the parts table says "x 4". So the
// drawn count seeds the number and this records the real one, keyed on the
// part mark so re-extracting the same drawing does not lose it.
// ---------------------------------------------------------------------------

export type SaveQuantitiesResult = { ok: true } | { ok: false; error: string };

const MAX_QUANTITY = 9999;

export async function saveCuttingQuantities(
  projectId: string,
  rows: Array<{ partMark: string; quantity: number }>
): Promise<SaveQuantitiesResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You are signed out." };
  if (!isDcc(user)) return { ok: false, error: DCC_ONLY };
  try {
    await requireProjectMembership(projectId, user.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not a member of this project." };
  }

  const clean: Array<{ partMark: string; quantity: number }> = [];
  for (const row of rows) {
    const mark = String(row.partMark ?? "").trim().slice(0, 120);
    if (!mark) continue;
    const quantity = Math.floor(Number(row.quantity));
    // Zero is allowed and means "not cutting this one this time", which is a
    // real thing to want and clearer than deleting the row.
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
      return { ok: false, error: `${mark}: quantity must be a whole number between 0 and ${MAX_QUANTITY}.` };
    }
    clean.push({ partMark: mark, quantity });
  }

  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      await tx.delete(cuttingPartQuantities).where(eq(cuttingPartQuantities.projectId, projectId));
      if (clean.length > 0) {
        await tx.insert(cuttingPartQuantities).values(clean.map((row) => ({ ...row, projectId })));
      }
    });
  } catch (err) {
    return { ok: false, error: `The database refused the write: ${err instanceof Error ? err.message : String(err)}` };
  }

  revalidatePath("/cutting");
  return { ok: true };
}
