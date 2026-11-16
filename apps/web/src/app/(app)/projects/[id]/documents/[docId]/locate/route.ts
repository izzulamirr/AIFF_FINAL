import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
// The v4 API: the SDK's structured-output helper is built on it (zod 3.25 ships it as "zod/v4").
import * as z from "zod/v4";
import { documents, findingLocations, projects } from "@easy/db";
import { canReadOrganization } from "@/lib/access";
import { getDb } from "@/lib/db";
import { isMissingTable } from "@/lib/progress";
import { getSessionUser } from "@/lib/session";

// Where report findings sit on one ISO sheet, for a sheet with NO text layer.
//
// Most ISOs carry their lettering as text, and the report finds each error on the
// drawing by reading that text in the browser -- exact and free. Some CAD exports
// turn every letter into lines, leaving nothing to read. For those sheets only, the
// browser sends the rendered sheet here and Claude looks for each item.
//
// Each answer is kept (finding_locations), so an item costs one call ever: the
// browser first asks WITHOUT the image, gets whatever is already known, and sends
// the image only when something is still unknown.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = "claude-opus-5-5";
const MAX_ITEMS = 40;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const RequestBody = z.object({
  page: z.number().int().min(1).max(500),
  items: z
    .array(z.object({ ref: z.string().min(1).max(20), describe: z.string().min(3).max(400) }))
    .min(1)
    .max(MAX_ITEMS),
  /** The rendered sheet as a JPEG data URL. Sent only once the server has said it needs it. */
  image: z.string().startsWith("data:image/jpeg;base64,").optional(),
});

// What Claude returns: per item, a box in fractions of the image, or found=false.
const Located = z.object({
  items: z.array(
    z.object({
      ref: z.string(),
      found: z.boolean(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
  ),
});

interface Result {
  ref: string;
  found: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

const keyOf = (describe: string) => createHash("sha256").update(describe).digest("hex").slice(0, 40);
const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

export async function POST(request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id: projectId, docId } = await params;
  const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!UUID.test(projectId) || !UUID.test(docId)) return notFound();

  // The same rule as reading the file itself.
  const db = getDb();
  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId || document.docType !== "iso") return notFound();
  const [project] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || !(await canReadOrganization(session, project.organizationId))) return notFound();

  const parsed = RequestBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  const { page, items, image } = parsed.data;
  const keyed = items.map((i) => ({ ...i, key: keyOf(i.describe) }));

  // ---- What is already known.
  const known = new Map<string, Result>();
  let cacheReady = true;
  try {
    const rows = await db
      .select()
      .from(findingLocations)
      .where(
        and(
          eq(findingLocations.documentId, docId),
          eq(findingLocations.page, page),
          inArray(
            findingLocations.itemKey,
            keyed.map((k) => k.key)
          )
        )
      );
    for (const row of rows) {
      for (const k of keyed.filter((k) => k.key === row.itemKey)) {
        known.set(k.ref, { ref: k.ref, found: row.found, x: row.x ?? 0, y: row.y ?? 0, w: row.w ?? 0, h: row.h ?? 0 });
      }
    }
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    cacheReady = false;
  }

  const missing = keyed.filter((k) => !known.has(k.ref));
  if (missing.length === 0) return NextResponse.json({ results: [...known.values()] });
  // Without credentials there is nothing to ask -- say so now, rather than having
  // the browser upload the sheet first only to be told the same thing.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return NextResponse.json({
      results: [...known.values()],
      error: "This sheet has no text layer, so its errors can only be found by AI, and no Claude API key is set for the web app (ANTHROPIC_API_KEY in apps/web/.env).",
    });
  }
  if (!image) return NextResponse.json({ results: [...known.values()], needImage: true });

  const data = image.slice("data:image/jpeg;base64,".length);
  if (data.length * 0.75 > MAX_IMAGE_BYTES) return NextResponse.json({ error: "The sheet image is too large." }, { status: 413 });

  // ---- Ask Claude about the rest.
  const list = missing.map((m) => `- ${m.ref}: ${m.describe}`).join("\n");
  let located: Result[];
  try {
    const client = new Anthropic();
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // If the request is declined, it is re-run on Claude Opus 4.8 in the same call.
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
      output_config: { effort: "medium", format: betaZodOutputFormat(Located) },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
            {
              type: "text",
              text:
                "This is one sheet of a piping isometric drawing (an ISO). A checker's report found errors on it, " +
                "and each one has to be marked on the sheet. For every item below, find it on the image and give a box " +
                "round it as fractions of the image: x and y are the box's top-left corner, w and h its width and height, " +
                "all from 0 to 1 (0,0 is the top-left of the image).\n\n" +
                "Where the item is a row of the bill of material, box that row of the table. Where it is a weld, box its " +
                "number flag and the weld dot it points at. Where it is a title-block field, box that field.\n\n" +
                "If you cannot find an item with confidence, set found to false and the box to zeros. A blank is better " +
                "than a guess: a marker in the wrong place sends the designer to the wrong part of the drawing.\n\n" +
                `Items (ref: what to find):\n${list}\n\nAnswer every ref exactly once.`,
            },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return NextResponse.json({ results: [...known.values()], error: "The drawing could not be read for this sheet." });
    }
    const wanted = new Set(missing.map((m) => m.ref));
    located = response.parsed_output.items
      .filter((i) => wanted.has(i.ref))
      .map((i) => {
        const x = clamp01(i.x);
        const y = clamp01(i.y);
        const ok = i.found && i.w > 0 && i.h > 0;
        return { ref: i.ref, found: ok, x, y, w: ok ? Math.min(clamp01(i.w), 1 - x) : 0, h: ok ? Math.min(clamp01(i.h), 1 - y) : 0 };
      });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ results: [...known.values()], error: "No Claude API key is set for the web app (ANTHROPIC_API_KEY in apps/web/.env)." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ results: [...known.values()], error: "Claude is busy. Open the report again in a minute." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("locate: Claude API error", err.status, err.message);
      return NextResponse.json({ results: [...known.values()], error: "The drawing could not be read for this sheet." });
    }
    throw err;
  }

  // An item Claude did not answer about is recorded as not found, so it is not
  // asked about (and paid for) again on every open.
  const answered = new Set(located.map((l) => l.ref));
  for (const m of missing) if (!answered.has(m.ref)) located.push({ ref: m.ref, found: false, x: 0, y: 0, w: 0, h: 0 });

  if (cacheReady) {
    const keyByRef = new Map(missing.map((m) => [m.ref, m.key]));
    const rows = located.map((l) => ({
      documentId: docId,
      page,
      itemKey: keyByRef.get(l.ref)!,
      found: l.found,
      x: l.found ? l.x : null,
      y: l.found ? l.y : null,
      w: l.found ? l.w : null,
      h: l.found ? l.h : null,
      model: MODEL,
    }));
    await db
      .insert(findingLocations)
      .values(rows)
      .onConflictDoNothing()
      .catch((err) => console.error("locate: could not store the locations", err));
  }

  return NextResponse.json({ results: [...known.values(), ...located], ai: true });
}
