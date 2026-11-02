/**
 * DOCX: convert to Markdown with mammoth, keep its heading structure, and send
 * any inline pictures through the vision model so text inside screenshots is
 * searchable too.
 * @module cyberself/parse/docx
 */
import { convertToMarkdown, images } from 'mammoth'
import { parseMarkdown } from './plain.ts'
import { mapWithConcurrency } from './pool.ts'
import type { ParsedBlock, ParseOptions, VisionRequest } from './types.ts'

const IMAGE_MARKDOWN = /!\[[^\]]*\]\([^)]*\)/gu

/** Parse a Word document into blocks. */
export async function parseDocx(bytes: Uint8Array, options: ParseOptions): Promise<ParsedBlock[]> {
  const vision = options.vision
  const pictures: VisionRequest[] = []
  const convertImage = images.imgElement(async (image) => {
    if (!options.ocr || vision === null) return { src: '' }
    const buffer = await image.read()
    pictures.push({
      bytes: new Uint8Array(buffer),
      mime: image.contentType === '' ? 'image/png' : image.contentType,
      label: image.altText === undefined ? 'Word 文档中的图片' : `Word 文档中的图片：${image.altText}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return { src: '' }
  })
  const result = await convertToMarkdown({ buffer: Buffer.from(bytes) }, { convertImage })
  const blocks = parseMarkdown(result.value.replace(IMAGE_MARKDOWN, ''))
  if (vision === null || pictures.length === 0) return blocks
  const transcriptions = await mapWithConcurrency(pictures, options.concurrency, (request) => vision.transcribe(request))
  for (const transcription of transcriptions) {
    const text = transcription.trim()
    if (text !== '') blocks.push({ text, page: null, heading: '文档内图片' })
  }
  return blocks
}
