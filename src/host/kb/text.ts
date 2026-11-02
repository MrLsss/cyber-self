/**
 * Text normalization and hashing shared by chunking and the import pipeline.
 * @module cyberself/kb/text
 */
import { createHash } from 'node:crypto'

/** SHA-256 of raw bytes, lowercase hex. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** SHA-256 of a string, lowercase hex. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Collapse every whitespace run to one space and trim. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Form compared for deduplication: whitespace collapsed, case folded, and
 * full-width punctuation folded to its ASCII counterpart so the same sentence
 * copied from a PDF and from a web page hashes identically.
 */
export function normalizeForHash(text: string): string {
  return collapseWhitespace(text)
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
}

/** Join text paragraphs so a chunk reads as continuous prose. */
export function joinParagraphs(paragraphs: readonly string[]): string {
  return paragraphs.map((part) => collapseWhitespace(part)).filter((part) => part !== '').join('\n')
}

/** Split one paragraph into sentence-sized pieces, keeping terminators attached. */
export function splitSentences(text: string): string[] {
  const pieces = text.split(/(?<=[。！？；!?;\n])\s*/u)
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '')
}
