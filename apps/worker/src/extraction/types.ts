import type { DocType, TagType } from "@easy/shared";
import type { ExtractedPage } from "../pdfText";

export interface ExtractionProgress {
  phase: string;
  current: number;
  total: number;
  detail?: string;
}

export type OnProgress = (evt: ExtractionProgress) => void;

// One row destined for extracted_tags -- the shape-agnostic cross-document
// join surface (see architecture plan section on correlation).
export interface TagDraft {
  tagType: TagType;
  tagNumber: string;
  sourcePage?: number | null;
  attributes: Record<string, unknown>;
}

export interface DocumentExtractionResult {
  rawJson: unknown; // full-fidelity extraction, stored in extraction_results
  tags: TagDraft[]; // flattened for extracted_tags
}

export interface DocTypeExtractor {
  // pdfBuffer lets an extractor render page images for Claude's vision input
  // when the document's text layer is insufficient (see pdfImages.ts) --
  // only ISO's extractor uses it so far, existing extractors ignore it.
  (pages: ExtractedPage[], apiKey: string, onProgress?: OnProgress, pdfBuffer?: Buffer): Promise<DocumentExtractionResult>;
}

export type ExtractorRegistry = Record<DocType, DocTypeExtractor>;
