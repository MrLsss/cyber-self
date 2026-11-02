/**
 * Chunking: turns parsed document blocks into the units that get embedded and
 * cited. Boundaries follow paragraphs and headings; only a paragraph longer
 * than the target length is cut, and then it is cut at sentence ends.
 * @module cyberself/kb/chunking
 */
import type { ChunkingSettings } from '../config.ts'
import { collapseWhitespace, normalizeForHash, sha256Text, splitSentences } from './text.ts'

/** A run of text from one parser, carrying the page and heading it sits under. */
export interface SourceBlock {
  text: string
  page: number | null
  heading: string | null
}

/** A chunk ready to be stored. */
export interface RawChunk {
  text: string
  hash: string
  ordinal: number
  page: number | null
  heading: string | null
}

interface Pending {
  parts: string[]
  length: number
  page: number | null
  heading: string | null
}

function emptyPending(heading: string | null, page: number | null): Pending {
  return { parts: [], length: 0, page, heading }
}

/**
 * Split one over-long paragraph into sentence-packed pieces, each at most
 * `targetChars`, repeating the tail of the previous piece as `overlapChars`.
 */
function splitLongParagraph(paragraph: string, settings: ChunkingSettings): string[] {
  const pieces: string[] = []
  let current = ''
  for (const sentence of splitSentences(paragraph)) {
    if (sentence.length > settings.targetChars) {
      if (current !== '') {
        pieces.push(current)
        current = ''
      }
      for (let offset = 0; offset < sentence.length; offset += settings.targetChars) {
        pieces.push(sentence.slice(offset, offset + settings.targetChars))
      }
      continue
    }
    if (current !== '' && current.length + 1 + sentence.length > settings.targetChars) {
      pieces.push(current)
      const tail = current.slice(-settings.overlapChars)
      current = settings.overlapChars > 0 && tail !== '' ? `${tail} ${sentence}` : sentence
    } else {
      current = current === '' ? sentence : `${current} ${sentence}`
    }
  }
  if (current !== '') pieces.push(current)
  return pieces
}

/**
 * Pack parsed blocks into chunks.
 *
 * A heading change always closes the current chunk, so a chunk never mixes
 * two sections; consecutive short blocks under the same heading are merged so
 * that a bulleted list does not become a dozen one-line chunks.
 */
export function chunkBlocks(blocks: readonly SourceBlock[], settings: ChunkingSettings): RawChunk[] {
  const chunks: RawChunk[] = []
  let pending = emptyPending(null, null)

  const flush = (): void => {
    const heading = pending.heading
    const page = pending.page
    if (pending.parts.length === 0) {
      pending = emptyPending(heading, null)
      return
    }
    const text = pending.parts.join('\n')
    pending = emptyPending(heading, null)
    if (text.trim() === '') return
    const previous = chunks[chunks.length - 1]
    if (
      previous !== undefined
      && text.length < settings.minChars
      && previous.heading === heading
      && previous.text.length + text.length <= settings.targetChars * 2
    ) {
      previous.text = `${previous.text}\n${text}`
      previous.hash = sha256Text(normalizeForHash(previous.text))
      return
    }
    chunks.push({
      text,
      hash: sha256Text(normalizeForHash(text)),
      ordinal: chunks.length,
      page,
      heading,
    })
  }

  for (const block of blocks) {
    const paragraphs = block.text.split(/\n\s*\n/u)
    for (const rawParagraph of paragraphs) {
      const paragraph = collapseWhitespace(rawParagraph)
      if (paragraph === '') continue
      if (pending.heading !== block.heading) {
        flush()
        pending.heading = block.heading
      }
      if (pending.parts.length === 0) pending.page = block.page
      if (paragraph.length > settings.targetChars) {
        for (const piece of splitLongParagraph(paragraph, settings)) {
          if (pending.parts.length > 0) {
            flush()
            pending.heading = block.heading
            pending.page = block.page
          }
          pending.parts.push(piece)
          pending.length = piece.length
          flush()
        }
        pending.heading = block.heading
        continue
      }
      if (pending.length > 0 && pending.length + 1 + paragraph.length > settings.targetChars) {
        flush()
        pending.heading = block.heading
        pending.page = block.page
      }
      pending.parts.push(paragraph)
      pending.length += paragraph.length + 1
    }
  }
  flush()
  return chunks.map((chunk, ordinal) => ({ ...chunk, ordinal }))
}
