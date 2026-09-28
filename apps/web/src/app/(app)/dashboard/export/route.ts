import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { activeOrganization, activeProjectsOf } from "@/lib/access";
import { boardOf, CHECK_LABEL, namesOf, overviewOf } from "@/lib/dashboardData";
import { progressOfProjects } from "@/lib/progress";
import { getSessionUser } from "@/lib/session";

// The dashboard as a spreadsheet, for reporting. Built from the same numbers the page draws
// (lib/dashboardData.ts), so the two cannot disagree. Document Control only, like the page.

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };

function styled(sheet: ExcelJS.Worksheet, widths: number[]) {
  sheet.columns = widths.map((width) => ({ width }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: "middle", wrapText: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

export async function GET() {
  const session = await getSessionUser();
  if (!session) return new NextResponse("Not signed in.", { status: 401 });
  if (!session.isDcc) return new NextResponse("Not available.", { status: 403 });

  const client = await activeOrganization(session);
  const projects = await activeProjectsOf(session);
  const progress = await progressOfProjects(projects);
  const overview = await overviewOf(projects);
  const names = await namesOf([...new Set(overview.flatMap((o) => o.uploaders.map((u) => u.userId)))]);
  const board = boardOf(overview, progress, names);
  const generated = new Date();

  const book = new ExcelJS.Workbook();
  book.created = generated;
  const checkLabels = CHECK_LABEL.map(([, label]) => label);

  // ---- Summary
  const summary = book.addWorksheet("Summary");
  summary.addRow(["Item", "Value"]);
  const rows: Array<[string, string | number]> = [
    ["Client", client?.name ?? ""],
    ["Generated", generated.toLocaleString("en-GB")],
    ["Projects", board.projects],
    ["Documents uploaded", board.documents],
    ["Lines checked", board.linesChecked],
    ["Total lines", board.linesTotal],
    ["Lines with errors", board.linesWithErrors],
    ["Lines with no errors", board.linesChecked - board.linesWithErrors],
    ["Errors found", board.errors],
    ["Findings for information", board.info],
  ];
  for (const r of rows) summary.addRow(r);
  summary.addRow([]);
  const sub = summary.addRow(["Errors by check", "Errors"]);
  sub.font = { bold: true };
  for (const c of board.byCheck) summary.addRow([c.label, c.value]);
  styled(summary, [34, 30]);

  // ---- Projects
  const proj = book.addWorksheet("Projects");
  proj.addRow(["Project", "ISO lines read", "Total lines", "Lines checked", "Lines with errors", "Errors", ...checkLabels, "Documents", "Last upload"]);
  for (const o of overview) {
    const total = progress?.find((p) => p.projectId === o.id)?.total ?? o.isoLines;
    const byCheck = CHECK_LABEL.map(([key]) => o.results.reduce((n, r) => n + r.byCheck[key], 0));
    proj.addRow([
      o.name,
      o.isoLines,
      total,
      o.results.filter((r) => !r.failed).length,
      o.results.filter((r) => r.errors > 0).length,
      o.results.reduce((n, r) => n + r.errors, 0),
      ...byCheck,
      o.documents,
      o.lastUpload ?? "",
    ]);
  }
  styled(proj, [30, 12, 12, 13, 15, 10, ...checkLabels.map(() => 12), 12, 20]);
  proj.getColumn(7 + checkLabels.length + 1).numFmt = "dd mmm yyyy hh:mm";

  // ---- Lines
  const lineSheet = book.addWorksheet("Lines");
  lineSheet.addRow(["Project", "Line", "Revision", "Status", "Errors", ...checkLabels, "For information", "Checks not run"]);
  for (const o of overview) {
    for (const r of [...o.results].sort((a, b) => b.errors - a.errors)) {
      lineSheet.addRow([
        o.name,
        r.lineNumber,
        r.revision ?? "",
        r.failed ? "Could not be checked" : r.errors > 0 ? "Has errors" : "No errors",
        r.errors,
        ...CHECK_LABEL.map(([key]) => r.byCheck[key]),
        r.info,
        r.notChecked,
      ]);
    }
  }
  styled(lineSheet, [26, 42, 10, 20, 9, ...checkLabels.map(() => 12), 14, 14]);
  lineSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 + checkLabels.length + 2 } };

  // ---- Users
  const users = book.addWorksheet("Users");
  users.addRow(["User", "Lines", "Documents", "Counted as"]);
  for (const u of board.users) users.addRow([u.name, u.lines, u.documents || "", board.usersBasis]);
  styled(users, [30, 10, 12, 62]);

  const buffer = await book.xlsx.writeBuffer();
  const safe = (client?.name ?? "client").replace(/[^A-Za-z0-9._-]+/g, "_");
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="AIFF-dashboard-${safe}-${generated.toISOString().slice(0, 10)}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
