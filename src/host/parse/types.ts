/**
 * Parser contract: every supported file type turns into the same block list,
 * which chunking then packs into retrievable units.
 * @module cyberself/parse/types
 */

/** A run of text together with the page and heading it appeared under. */
export interface ParsedBlock {
  text: string
  page: number | null
  heading: string | null
}

/** Result of parsing one file. */
export interface ParsedDocument {
  /** Short parser name stored with the document: pdf, docx, xlsx, html, markdown, text, image. */
  kind: string
  title: string
  blocks: ParsedBlock[]
}

/** One image handed to the vision model. */
export interface VisionRequest {
  bytes: Uint8Array
  mime: string
  /** Human-readable origin, used in the transcription prompt. */
  label: string
  signal?: AbortSignal | undefined
}

/** Transcription through whichever vision model the Host is configured with. */
export interface VisionTranscriber {
  transcribe(request: VisionRequest): Promise<string>
}

/** Options every parser receives. */
export interface ParseOptions {
  /** Transcribe scanned pages and pictures. */
  ocr: boolean
  /** Page render resolution for scanned PDF pages. */
  pdfDpi: number
  /** Maximum pages transcribed per document. */
  maxPages: number
  /** How many pages or pictures are transcribed at the same time. */
  concurrency: number
  vision: VisionTranscriber | null
  signal?: AbortSignal | undefined
}

/** Text shorter than this on a PDF page is treated as a scanned page. */
export const SCANNED_PAGE_THRESHOLD = 40
