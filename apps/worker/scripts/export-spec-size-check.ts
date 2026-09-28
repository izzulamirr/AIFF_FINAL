// Free. A workbook that lays the size headers read off each client spec PDF beside what the
// app has stored for the same class, size by size, so a wrong band is visible at a glance.
//
//   pnpm --filter @easy/worker exec tsx scripts/export-spec-size-check.ts <pdf-folder> <out.xlsx> [--account <email>] [--project <name>]
//
// --account keeps only projects in organizations that account belongs to; --project keeps only
// projects with that name (case-insensitive). Both are optional.
//
// The PDF side is read from the page's own geometry (see src/extraction/specTable.ts) and is
// the reference. The app side is whatever is stored in the database for that document.
// Reads the database with the worker's own connection settings; changes nothing.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
  if (m && m[1] === "DATABASE_URL") process.env.DATABASE_URL = m[2].replace(/^["']|["']$/g, "");
}

const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/MM$/i, "").replace(/^SCH\s*/i, "").replace(/\s+/g, "");
const looseText = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

async function main() {
  const [, , folder, out, ...flags] = process.argv;
  if (!folder || !out) throw new Error("usage: export-spec-size-check.ts <pdf-folder> <out.xlsx> [--account <email>] [--project <name>]");
  const flag = (name: string) => {
    const i = flags.indexOf(name);
    return i !== -1 ? flags[i + 1] : undefined;
  };
  const accountEmail = flag("--account");
  const projectName = flag("--project");

  const { createDb } = await import("@easy/db");
  const { documents, extractedTags, projects, organizationMembers } = await import("@easy/db");
  const { eq, sql } = await import("drizzle-orm");
  const { parseNpsInches } = await import("@easy/shared");
  const { readSpecPageTable } = await import("../src/extraction/specTablePdf");
  const { classRowsFromTable } = await import("../src/extraction/specTable");
  const { readPageCount } = await import("../src/pdfGeometry");

  const db = createDb(process.env.DATABASE_URL!);
  let allowedProjects = await db.select().from(projects);
  if (accountEmail) {
    const found = await db.execute(sql`select id from auth.users where lower(email) = ${accountEmail.toLowerCase()} limit 1`);
    const userId = (found as unknown as Array<{ id: string }>)[0]?.id;
    if (!userId) throw new Error(`No account with the email ${accountEmail}.`);
    const orgIds = new Set((await db.select().from(organizationMembers)).filter((m) => m.userId === userId).map((m) => m.organizationId));
    allowedProjects = allowedProjects.filter((p) => orgIds.has(p.organizationId));
  }
  if (projectName) allowedProjects = allowedProjects.filter((p) => p.name.trim().toLowerCase() === projectName.trim().toLowerCase());
  const projs = new Map(allowedProjects.map((p) => [p.id, p.name]));
  console.log(`scope: ${projs.size} project(s): ${allowedProjects.map((p) => `${p.name} [${p.id.slice(0, 8)}]`).join(", ") || "none"}`);
  const docs = (await db.select().from(documents)).filter(
    (d) => projs.has(d.projectId) && d.docType === "spec_sheet" && d.fileName.toLowerCase().endsWith(".pdf")
  );

  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet("Header sizes");
  const detail = wb.addWorksheet("Size by size");
  const help = wb.addWorksheet("Read me");

  summary.columns = [
    { header: "Class (file)", key: "cls", width: 14 },
    { header: "Project", key: "project", width: 16 },
    { header: "Uploaded", key: "up", width: 12 },
    { header: "Header sizes on the PDF", key: "pdf", width: 60 },
    { header: "# PDF", key: "npdf", width: 7 },
    { header: "Bands the app stored (pipes)", key: "app", width: 60 },
    { header: "# app", key: "napp", width: 7 },
    { header: "PDF sizes with a WRONG schedule/ends in the app", key: "wrong", width: 46 },
    { header: "PDF sizes the app has no band for", key: "missing", width: 34 },
    { header: "Verdict", key: "verdict", width: 14 },
  ];
  detail.columns = [
    { header: "Class (file)", key: "cls", width: 14 },
    { header: "Project", key: "project", width: 16 },
    { header: "Size (PDF header)", key: "size", width: 16 },
    { header: "PDF schedule", key: "ps", width: 13 },
    { header: "App schedule", key: "as", width: 13 },
    { header: "PDF ends", key: "pe", width: 9 },
    { header: "App ends", key: "ae", width: 9 },
    { header: "PDF material", key: "pm", width: 38 },
    { header: "App material", key: "am", width: 38 },
    { header: "App band (size range)", key: "band", width: 20 },
    { header: "Status", key: "status", width: 14 },
  ];

  const fill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });
  const RED = fill("FFF8D7DA");
  const GREEN = fill("FFD4EDDA");
  const AMBER = fill("FFFFF3CD");

  const pdfCache = new Map<string, Awaited<ReturnType<typeof readOnePdf>>>();
  async function readOnePdf(file: string) {
    const buf = readFileSync(file);
    const pages = await readPageCount(buf);
    for (let p = 1; p <= pages; p++) {
      const table = await readSpecPageTable(buf, p);
      const rows = table ? classRowsFromTable(table) : null;
      if (table && rows) return { table, rows, page: p };
    }
    return null;
  }

  const seen: string[] = [];
  for (const doc of docs.sort((a, b) => a.fileName.localeCompare(b.fileName) || +a.uploadedAt - +b.uploadedAt)) {
    const local = path.join(folder, doc.fileName);
    const stem = doc.fileName.replace(/\.[^.]+$/, "");
    const project = projs.get(doc.projectId) ?? "?";
    const up = doc.uploadedAt.toISOString().slice(0, 10);
    if (!existsSync(local)) {
      seen.push(`${doc.fileName} (${project}, ${up}): no local copy in ${folder}, so not compared`);
      continue;
    }
    if (!pdfCache.has(local)) pdfCache.set(local, await readOnePdf(local));
    const read = pdfCache.get(local);
    if (!read) {
      seen.push(`${doc.fileName} (${project}, ${up}): no size table with a Schedule row was found on the PDF`);
      continue;
    }

    const tags = (await db.select().from(extractedTags).where(eq(extractedTags.documentId, doc.id))).filter((t) => t.tagType === "spec_class");
    // The class whose code starts with the file's own name (the PDF prints "AC03N1").
    const tag = tags.find((t) => t.tagNumber.toUpperCase().startsWith(stem.toUpperCase())) ?? tags[0];
    const stored = (((tag?.attributes as Record<string, unknown> | undefined)?.pipes as Array<Record<string, unknown>> | undefined) ?? []).map((r) => ({
      min: parseNpsInches(r.size_min),
      max: parseNpsInches(r.size_max),
      label: r.size_min === r.size_max ? String(r.size_min) : `${r.size_min}-${r.size_max}`,
      schedule: r.schedule,
      end: r.end_type,
      material: r.material ?? r.description,
    }));

    const wrong: string[] = [];
    const missing: string[] = [];
    for (const [i, col] of read.table.columns.entries()) {
      const pipe = read.rows.pipes[i];
      const lo = parseNpsInches(col.min);
      const hit = stored.filter((s) => s.min != null && s.max != null && lo != null && lo >= s.min - 1e-9 && lo <= s.max + 1e-9);
      let status = "OK";
      if (hit.length === 0) {
        status = "NOT STORED";
        missing.push(col.label);
      } else if (hit.length > 1 || norm(hit[0].schedule) !== norm(pipe.schedule) || (pipe.end_type && hit[0].end && norm(hit[0].end) !== norm(pipe.end_type))) {
        status = "DIFFERENT";
        wrong.push(`${col.label} (PDF ${pipe.schedule} / app ${hit.map((h) => h.schedule).join(", ")})`);
      } else if (looseText(hit[0].material) !== looseText(pipe.material)) {
        status = "MATERIAL";
      }
      const row = detail.addRow({
        cls: stem,
        project,
        size: col.label,
        ps: pipe.schedule,
        as: hit.map((h) => h.schedule).join(" | ") || "-",
        pe: pipe.end_type,
        ae: hit.map((h) => h.end).join(" | ") || "-",
        pm: pipe.material,
        am: hit.map((h) => h.material).join(" | ") || "-",
        band: hit.map((h) => h.label).join(" | ") || "-",
        status,
      });
      row.getCell("status").fill = status === "OK" ? GREEN : status === "MATERIAL" ? AMBER : RED;
      if (status === "DIFFERENT") {
        row.getCell("as").fill = RED;
        row.getCell("ae").fill = RED;
      }
    }

    const verdict = wrong.length === 0 && missing.length === 0 ? "MATCHES PDF" : "HAS ERRORS";
    const srow = summary.addRow({
      cls: stem,
      project,
      up,
      pdf: read.table.columns.map((c) => c.label).join("  |  "),
      npdf: read.table.columns.length,
      app: stored.map((s) => `${s.label}: ${s.schedule ?? "?"}`).join("  |  ") || "(nothing stored)",
      napp: stored.length,
      wrong: wrong.join("; ") || "-",
      missing: missing.join(", ") || "-",
      verdict,
    });
    srow.getCell("verdict").fill = verdict === "MATCHES PDF" ? GREEN : RED;
    srow.alignment = { wrapText: true, vertical: "top" };
  }

  for (const ws of [summary, detail]) {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = fill("FFE9ECEF");
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }
  detail.autoFilter = { from: "A1", to: "K1" };

  help.columns = [{ width: 120 }];
  [
    "Size headers on each client spec PDF, against what the app has stored for the same class.",
    "",
    "PDF side: read from the page's own drawing -- the text of the SIZE row, and the cell edges around every Schedule / Ends / Mat'l value -- so a merged cell is given to exactly the size columns it spans.",
    "App side: the class's Pipe rows as stored in the database for that uploaded document.",
    "",
    "Header sizes sheet: one row per uploaded PDF. 'HAS ERRORS' means at least one size has a different schedule/ends in the app, or no band at all.",
    "Size by size sheet: one row per size column. DIFFERENT = the app's schedule or ends is not what the PDF says. NOT STORED = the app has no band covering that size. MATERIAL = schedule and ends agree, the material text differs (often just wording).",
    "",
    "A document uploaded before the geometry reader was added still holds the model's answer; re-upload it (with the worker restarted) to see the corrected result.",
    ...(seen.length ? ["", "Not compared:", ...seen.map((s) => "  - " + s)] : []),
  ].forEach((line) => help.addRow([line]));
  help.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(out);
  console.log(`wrote ${out}: ${summary.rowCount - 1} PDFs, ${detail.rowCount - 1} size rows`);
  for (const s of seen) console.log("  not compared:", s);
  process.exit(0);
}
main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
