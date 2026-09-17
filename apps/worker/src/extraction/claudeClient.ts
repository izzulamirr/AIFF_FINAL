// Shared Claude call helper -- same shape proven in AIFF's
// electron/specExtraction.js: forced tool-use, adaptive thinking, streaming
// (avoids request timeouts on long documents), extract the tool_use block.
import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeTool } from "@easy/extraction-schemas";

/**
 * What the calls have cost so far.
 *
 * A full ISO extraction is two vision passes per sheet with the page image
 * and its tiles attached each time, which is the most expensive thing this
 * codebase does. Reporting the real figure afterwards -- rather than an
 * estimate made beforehand -- is the only way anyone can decide whether to
 * run it again.
 */
export const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

/** Opus pricing, USD per million tokens. */
const IN_PER_M = 15;
const OUT_PER_M = 75;

export const usageCostUsd = () => (usage.inputTokens / 1e6) * IN_PER_M + (usage.outputTokens / 1e6) * OUT_PER_M;

export function resetUsage() {
  usage.calls = 0;
  usage.inputTokens = 0;
  usage.outputTokens = 0;
}

export async function callTool<T = unknown>(
  client: Anthropic,
  opts: {
    tool: ClaudeTool;
    systemPrompt: string;
    userText: string;
    maxTokens: number;
    useThinking: boolean;
    // Base64-encoded PNG page images -- for schematic/CAD-exported drawings
    // (ISOs, P&IDs, PFDs) where the title block/tables are vector graphics
    // with little or no real text layer, and plain text extraction (see
    // pdfText.ts) isn't enough (confirmed on a real ISO upload).
    images?: string[];
  }
): Promise<T> {
  const content: Anthropic.MessageParam["content"] = [
    ...(opts.images ?? []).map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } })),
    { type: "text" as const, text: opts.userText },
  ];

  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: opts.maxTokens,
    ...(opts.useThinking ? { thinking: { type: "adaptive" as const } } : {}),
    system: opts.systemPrompt,
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content }],
  });

  const finalMessage = await stream.finalMessage();
  usage.calls += 1;
  usage.inputTokens += finalMessage.usage?.input_tokens ?? 0;
  usage.outputTokens += finalMessage.usage?.output_tokens ?? 0;
  const toolUse = finalMessage.content.find((b) => b.type === "tool_use" && b.name === opts.tool.name);
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`Claude did not return a ${opts.tool.name} tool call.`);
  }
  return toolUse.input as T;
}

export async function callWithRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
