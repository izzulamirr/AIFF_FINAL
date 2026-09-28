import Anthropic from "@anthropic-ai/sdk";
import { buildSpecClassesFromItemList, extractSheetItems } from "@easy/shared";
import {
  LOCATE_SPEC_SECTIONS_TOOL,
  SPEC_CLASS_INDEX_TOOL,
  SPEC_CLASS_DETAIL_TOOL,
  SPEC_BRANCH_TABLES_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { callTool, callWithRetry } from "./claudeClient";
import { classRowsFromTable } from "./specTable";
import { readSpecPageTable } from "./specTablePdf";
import type { DocTypeExtractor, TagDraft } from "./types";

// Direct generalization of AIFF's electron/specExtraction.js pipeline
// (locate -> class index -> per-class detail -> branch tables -> merge).
// Unlike P&ID/PFD, spec sheets don't carry physical tag numbers -- they
// define per-class-size-range rules. Each class_code becomes a
// tagType: "spec_class" row so rule evaluation can join a P&ID/PFD line's
// spec_class field against this class's rules (see types.ts's TagType doc
// comment).

interface LocateSpecResult {
  class_index_pages?: PageRange;
  classes: Array<{ class_code: string; detail_pages: PageRange }>;
  branch_table_pages?: PageRange;
}

interface SpecClassIndexResult {
  classes: Array<Record<string, unknown> & { class_code: string }>;
}

interface SpecClassDetailResult {
  pipes?: Array<Record<string, unknown>>;
  fittings?: Array<Record<string, unknown>>;
  flanges?: Array<Record<string, unknown>>;
  valves?: Array<Record<string, unknown>>;
}

interface SpecBranchTablesResult {
  branch_tables: Array<Record<string, unknown>>;
}

const SYSTEM_PROMPT = buildSystemPrompt("Piping Material Specification");

/**
 * A class's pipe / fitting / flange rows read from the geometry of the page that holds its
 * size table, or null when no page in its range yields a table that reads cleanly (every
 * size column covered exactly once by each pipe row).
 */
async function geometryRowsFor(buffer: Buffer, range: PageRange | undefined) {
  if (!range) return null;
  for (let page = range.start; page <= range.end; page++) {
    try {
      const table = await readSpecPageTable(buffer, page);
      const rows = table ? classRowsFromTable(table) : null;
      if (table && rows && rows.pipes.length >= 3 && rows.issues.length === 0) return { page, columns: table.columns.length, rows };
    } catch (err) {
      // A page whose geometry cannot be read falls back to the model, as it always did.
      console.warn(`Spec table geometry: page ${page} could not be read:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

// An admin item-list workbook is already structured -- every line names its class, its
// component type and its size -- so its classes are built straight from those columns.
// Sending it through the extraction below costs several passes over the whole workbook on
// a top-tier model to re-derive what the columns already say. A workbook that is NOT an
// item list (no lines recognised) falls through to the model as before.
function specClassesFromWorkbook(pages: Array<{ pageNumber: number; pageText: string | null }>, fileName: string) {
  const items = pages.flatMap((p) => extractSheetItems(p.pageText));
  if (items.length === 0) return null;
  // A workbook that is one class per file leaves Spec-of blank: name the class for the file.
  const fallback = fileName.replace(/\.[^.]+$/, "").trim();
  const classes = buildSpecClassesFromItemList(items, fallback);
  return classes.length > 0 ? { items: items.length, classes } : null;
}

export const extractSpecSheetDocument: DocTypeExtractor = async (pages, apiKey, onProgress, pdfBuffer, context) => {
  if (context?.fileName.toLowerCase().endsWith(".xlsx")) {
    const built = specClassesFromWorkbook(pages, context.fileName);
    if (built) {
      onProgress?.({ phase: "class_detail", current: built.classes.length, total: built.classes.length });
      return {
        rawJson: {
          source: "item_list_workbook",
          note: "Classes built from the workbook's own columns; no model call.",
          items: built.items,
          classes: built.classes.map((c) => ({
            class_code: c.class_code,
            pipes: (c.attributes.pipes as unknown[]).length,
            fittings: (c.attributes.fittings as unknown[]).length,
            flanges: (c.attributes.flanges as unknown[]).length,
            valves: (c.attributes.valves as unknown[]).length,
          })),
        },
        tags: built.classes.map((c) => ({ tagType: "spec_class" as const, tagNumber: c.class_code, attributes: c.attributes })),
      };
    }
  }

  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const locate = await callWithRetry(() =>
    callTool<LocateSpecResult>(client, {
      tool: LOCATE_SPEC_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nIdentify the section page ranges via the locate_spec_sections tool call.`,
      maxTokens: 8000,
      useThinking: true,
    })
  );

  if (!locate.classes || locate.classes.length === 0) {
    throw new Error("locate_spec_sections found no classes in this document.");
  }
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const classIndexText = locate.class_index_pages ? sliceText(pageList, locate.class_index_pages) : fullText;
  const classIndex = await callWithRetry(() =>
    callTool<SpecClassIndexResult>(client, {
      tool: SPEC_CLASS_INDEX_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${classIndexText}\n\nExtract the Piping Class Index rows via the record_class_index tool call.`,
      maxTokens: 16000,
      useThinking: true,
    })
  );
  onProgress?.({ phase: "class_index", current: 1, total: 1 });

  const detailByClass = new Map<string, SpecClassDetailResult>();
  const geometryRead = new Map<string, { page: number; columns: number }>();
  for (let i = 0; i < locate.classes.length; i++) {
    const cls = locate.classes[i];
    const detailText = sliceText(pageList, cls.detail_pages);
    const detail = await callWithRetry(() =>
      callTool<SpecClassDetailResult>(client, {
        tool: SPEC_CLASS_DETAIL_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: `${detailText}\n\nThis is the detailed datasheet for piping class "${cls.class_code}". Extract its pipe/fitting/flange/valve rows via the record_class_detail tool call.`,
        maxTokens: 16000,
        useThinking: true,
      })
    );
    // The model is unreliable on which size columns a merged cell covers. Where the page
    // has a text layer and drawn rules, that is a matter of coordinates: the table's own
    // geometry decides, and the model's pipes, fittings and flanges are replaced by it.
    // Valves stay with the model. A page it cannot read cleanly keeps the model's answer.
    if (pdfBuffer) {
      const read = await geometryRowsFor(pdfBuffer, cls.detail_pages);
      if (read) {
        detail.pipes = read.rows.pipes.map((p) => ({ ...p }));
        if (read.rows.fittings.length > 0) detail.fittings = read.rows.fittings;
        if (read.rows.flanges.length > 0) detail.flanges = read.rows.flanges;
        geometryRead.set(cls.class_code, { page: read.page, columns: read.columns });
      }
    }
    detailByClass.set(cls.class_code, detail);
    onProgress?.({ phase: "class_detail", current: i + 1, total: locate.classes.length, detail: cls.class_code });
  }

  let branchTables: Array<Record<string, unknown>> = [];
  if (locate.branch_table_pages) {
    const branchText = sliceText(pageList, locate.branch_table_pages);
    const branchResult = await callWithRetry(() =>
      callTool<SpecBranchTablesResult>(client, {
        tool: SPEC_BRANCH_TABLES_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: `${branchText}\n\nExtract the branch table matrix rows via the record_branch_tables tool call.`,
        maxTokens: 16000,
        useThinking: true,
      })
    );
    branchTables = branchResult.branch_tables ?? [];
  }
  onProgress?.({ phase: "branch_tables", current: 1, total: 1 });

  const tags: TagDraft[] = classIndex.classes.map((cls) => ({
    tagType: "spec_class",
    tagNumber: cls.class_code,
    attributes: {
      ...cls,
      pipes: detailByClass.get(cls.class_code)?.pipes ?? [],
      fittings: detailByClass.get(cls.class_code)?.fittings ?? [],
      flanges: detailByClass.get(cls.class_code)?.flanges ?? [],
      valves: detailByClass.get(cls.class_code)?.valves ?? [],
    },
  }));

  return {
    rawJson: {
      classes: classIndex.classes,
      detail: Object.fromEntries(detailByClass),
      branch_tables: branchTables,
      // Which classes had their pipes, fittings and flanges read from the page's geometry.
      geometry: Object.fromEntries(geometryRead),
    },
    tags,
  };
};
