/**
 * Parser dispatch: extension decides the reader, and every reader answers with
 * the same block list.
 * @module cyberself/parse
 */
import { basename, extname } from 'node:path'
import { CyberSelfError } from '../../shared/protocol.ts'
import { parseDocx } from './docx.ts'
import { decodeText } from './encoding.ts'
import { parseHtml } from './html.ts'
import { parseMarkdown, parseText } from './plain.ts'
import { parsePdf } from './pdf.ts'
import { parseSpreadsheet } from './spreadsheet.ts'
import type { ParsedDocument, ParseOptions } from './types.ts'

/** File extensions the importer accepts, without the dot. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  'pdf', 'docx', 'xlsx', 'xls', 'csv',
  'md', 'markdown', 'txt', 'text', 'log',
  'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
]

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** True when the file name carries an extension the importer handles. */
export function isSupported(name: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extname(name).replace(/^\./u, '').toLowerCase())
}

function baseTitle(name: string): string {
  const base = basename(name)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * Parse one file.
 *
 * Failures are explicit: an unsupported extension and a document that yields no
 * text both raise {@link CyberSelfError} with a message the UI can show as-is.
 */
export async function parseFile(name: string, bytes: Uint8Array, options: ParseOptions): Promise<ParsedDocument> {
  const extension = extname(name).replace(/^\./u, '').toLowerCase()
  const title = baseTitle(name)
  let document: ParsedDocument

  if (extension === 'pdf') {
    document = { kind: 'pdf', title, blocks: await parsePdf(bytes, options) }
  } else if (extension === 'docx') {
    document = { kind: 'docx', title, blocks: await parseDocx(bytes, options) }
  } else if (extension === 'csv') {
    document = { kind: extension, title, blocks: parseSpreadsheet(decodeText(bytes)) }
  } else if (extension === 'xlsx' || extension === 'xls') {
    document = { kind: extension, title, blocks: parseSpreadsheet(bytes) }
  } else if (extension === 'md' || extension === 'markdown') {
    document = { kind: 'markdown', title, blocks: parseMarkdown(decodeText(bytes)) }
  } else if (extension === 'txt' || extension === 'text' || extension === 'log') {
    document = { kind: 'text', title, blocks: parseText(decodeText(bytes)) }
  } else if (extension === 'html' || extension === 'htm') {
    const parsed = parseHtml(decodeText(bytes))
    document = { kind: 'html', title: parsed.title === '' ? title : parsed.title, blocks: parsed.blocks }
  } else if (IMAGE_MIME[extension] !== undefined) {
    if (options.vision === null) throw new CyberSelfError(422, '没有可用的视觉模型，无法读取图片里的文字')
    const transcription = await options.vision.transcribe({
      bytes,
      mime: IMAGE_MIME[extension] as string,
      label: `图片 ${basename(name)}`,
      signal: options.signal,
    })
    document = {
      kind: 'image',
      title,
      blocks: transcription.trim() === ''
        ? []
        : [{ text: transcription.trim(), page: null, heading: null }],
    }
  } else {
    throw new CyberSelfError(415, `不支持的文件类型：.${extension}`)
  }

  const textBlocks = document.blocks.filter((block) => block.text.trim() !== '')
  if (textBlocks.length === 0) {
    throw new CyberSelfError(422, `${basename(name)} 里没有读到任何文字`)
  }
  return { ...document, blocks: textBlocks }
}
