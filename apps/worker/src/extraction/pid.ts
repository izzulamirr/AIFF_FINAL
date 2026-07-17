import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_PID_SECTIONS_TOOL,
  PID_SHEET_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { callTool, callWithRetry } from "./claudeClient";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocatePidResult {
  sheets: Array<{ sheet_number: string; drawing_title?: string; pages: PageRange }>;
}

interface PidSheetResult {
  lines: Array<{ line_number: string; size?: string; spec_class?: string; service?: string; from_equipment?: string; to_equipment?: string }>;
  valves?: Array<{ tag_number: string; valve_type?: string; line_number?: string }>;
  instruments?: Array<{ tag_number: string; instrument_type?: string; line_or_equipment_ref?: string }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("P&ID (Piping & Instrumentation Diagram)");

export const extractPidDocument: DocTypeExtractor = async (pages, apiKey, onProgress) => {
  const client = new Anthropic({ apiKey });
  const fullText = buildNumberedText(pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText })));

  const locate = await callWithRetry(() =>
    callTool<LocatePidResult>(client, {
      tool: LOCATE_PID_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText: `${fullText}\n\nIdentify each P&ID sheet's page range via the locate_pid_sheets tool call.`,
      maxTokens: 8000,
      useThinking: true,
    })
  );

  if (!locate.sheets || locate.sheets.length === 0) {
    throw new Error("locate_pid_sheets found no sheets in this document.");
  }
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ sheet_number: string; result: PidSheetResult }> = [];
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));

  for (let i = 0; i < locate.sheets.length; i++) {
    const sheet = locate.sheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const result = await callWithRetry(() =>
      callTool<PidSheetResult>(client, {
        tool: PID_SHEET_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: `${sheetText}\n\nThis is P&ID sheet "${sheet.sheet_number}". Extract its lines/valves/instruments via the record_pid_sheet tool call.`,
        maxTokens: 16000,
        useThinking: true,
      })
    );
    allSheets.push({ sheet_number: sheet.sheet_number, result });
    onProgress?.({ phase: "sheet", current: i + 1, total: locate.sheets.length, detail: sheet.sheet_number });
  }

  const tags: TagDraft[] = [];
  for (const { sheet_number, result } of allSheets) {
    for (const line of result.lines ?? []) {
      tags.push({
        tagType: "line",
        tagNumber: line.line_number,
        attributes: { sheet_number, size: line.size, spec_class: line.spec_class, service: line.service, from_equipment: line.from_equipment, to_equipment: line.to_equipment },
      });
    }
    for (const valve of result.valves ?? []) {
      tags.push({ tagType: "valve", tagNumber: valve.tag_number, attributes: { sheet_number, valve_type: valve.valve_type, line_number: valve.line_number } });
    }
    for (const instrument of result.instruments ?? []) {
      tags.push({
        tagType: "instrument",
        tagNumber: instrument.tag_number,
        attributes: { sheet_number, instrument_type: instrument.instrument_type, line_or_equipment_ref: instrument.line_or_equipment_ref },
      });
    }
  }

  return {
    rawJson: { sheets: allSheets },
    tags,
  };
};
