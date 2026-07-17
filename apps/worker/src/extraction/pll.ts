import Anthropic from "@anthropic-ai/sdk";
import { LOCATE_PLL_SECTIONS_TOOL, PLL_TABLE_TOOL, buildSystemPrompt, buildNumberedText, sliceText, type PageRange } from "@easy/extraction-schemas";
import { callTool, callWithRetry } from "./claudeClient";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocatePllResult {
  line_table_pages: PageRange;
}

interface PllTableResult {
  lines: Array<{
    line_number: string;
    fluid_code?: string;
    size?: string;
    spec_class?: string;
    insulation_code?: string;
    insulation_thickness?: string;
    from_location?: string;
    to_location?: string;
    design_pressure?: string;
    design_temperature?: string;
    operating_pressure?: string;
    operating_temperature?: string;
    test_pressure?: string;
    test_medium?: string;
    service?: string;
    ndt_percent?: string;
    pwht?: string;
    paint_system?: string;
    corrosion_allowance?: string;
    pid_no?: string;
  }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("Process Line List (PLL)");

// PLLs are genuine tables with a real text layer -- same text-first
// locate -> extract shape as hmb.ts.
export const extractPllDocument: DocTypeExtractor = async (pages, apiKey, onProgress) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const locate = await callWithRetry(() =>
    callTool<LocatePllResult>(client, {
      tool: LOCATE_PLL_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nIdentify the line list table's page range via the locate_pll_sections tool call.`,
      maxTokens: 4000,
      useThinking: true,
    })
  );
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const tableText = sliceText(pageList, locate.line_table_pages) || fullText;
  const result = await callWithRetry(() =>
    callTool<PllTableResult>(client, {
      tool: PLL_TABLE_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${tableText}\n\nExtract every line list row via the record_pll_table tool call.`,
      maxTokens: 32000,
      useThinking: true,
    })
  );
  onProgress?.({ phase: "line_table", current: 1, total: 1 });

  const tags: TagDraft[] = (result.lines ?? []).map((line) => ({
    tagType: "line",
    tagNumber: line.line_number,
    attributes: {
      fluid_code: line.fluid_code,
      size: line.size,
      spec_class: line.spec_class,
      insulation_code: line.insulation_code,
      insulation_thickness: line.insulation_thickness,
      from_location: line.from_location,
      to_location: line.to_location,
      design_pressure: line.design_pressure,
      design_temperature: line.design_temperature,
      operating_pressure: line.operating_pressure,
      operating_temperature: line.operating_temperature,
      test_pressure: line.test_pressure,
      test_medium: line.test_medium,
      service: line.service,
      ndt_percent: line.ndt_percent,
      pwht: line.pwht,
      paint_system: line.paint_system,
      corrosion_allowance: line.corrosion_allowance,
      pid_no: line.pid_no,
    },
  }));

  return { rawJson: result, tags };
};
