/**
 * Plain text and Markdown: paragraphs separated by blank lines, headings taken
 * from Markdown's `#` markers.
 * @module cyberself/parse/plain
 */
import type { ParsedBlock } from './types.ts'

/** Split plain text into one block per blank-line-separated paragraph. */
export function parseText(text: string): ParsedBlock[] {
  return text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => ({ text: paragraph, page: null, heading: null }))
}

/**
 * Read Markdown into blocks, tracking the nearest heading so later chunks know
 * which section they came from. Fenced code stays verbatim in one block.
 */
export function parseMarkdown(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  let heading: string | null = null
  let buffer: string[] = []
  let fence: string | null = null

  const flush = (): void => {
    const body = buffer.join('\n').trim()
    if (body !== '') blocks.push({ text: body, page: null, heading })
    buffer = []
  }

  for (const line of text.split(/\r?\n/u)) {
    const fenceMatch = /^\s*(```+|~~~+)/u.exec(line)
    if (fence !== null) {
      if (fenceMatch !== null && line.trim().startsWith(fence)) {
        fence = null
        flush()
        continue
      }
      buffer.push(line)
      continue
    }
    if (fenceMatch !== null) {
      flush()
      fence = fenceMatch[1] ?? '```'
      continue
    }
    const headingMatch = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (headingMatch !== null) {
      flush()
      heading = (headingMatch[2] ?? '').replace(/#+\s*$/u, '').trim() || null
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return blocks
}
