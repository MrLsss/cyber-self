/**
 * PDF pages are read through their text layer; a page without one is rendered
 * to PNG and transcribed by the vision model, which is what makes scanned
 * documents searchable.
 *
 * Both unpdf entry points take ownership of the buffer they are given and
 * detach it, so every call gets its own copy — the bytes are read once per page
 * from the caller's array.
 * @module cyberself/parse/pdf
 */
import { extractText, renderPageAsImage } from 'unpdf'
import { CyberSelfError } from '../../shared/protocol.ts'
import { mapWithConcurrency } from './pool.ts'
import { SCANNED_PAGE_THRESHOLD, type ParsedBlock, type ParseOptions } from './types.ts'

/** Render scale that turns the configured dots per inch into PDF points. */
function renderScale(pdfDpi: number): number {
  return Math.max(0.5, pdfDpi / 72)
}

/** Read the abort flag through a call, so a value seen before an await is not reused. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Parse every page of a PDF into blocks carrying their page number. */
export async function parsePdf(bytes: Uint8Array, options: ParseOptions): Promise<ParsedBlock[]> {
  const extracted = await extractText(new Uint8Array(bytes), { mergePages: false })
  const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text]
  const vision = options.vision
  const slots: (ParsedBlock | null)[] = pages.map(() => null)
  const scanned: number[] = []

  pages.forEach((page, index) => {
    const pageNumber = index + 1
    const text = page.trim()
    if (text.length >= SCANNED_PAGE_THRESHOLD) {
      slots[index] = { text, page: pageNumber, heading: null }
      return
    }
    if (!options.ocr || vision === null) {
      if (text !== '') slots[index] = { text, page: pageNumber, heading: null }
      return
    }
    if (scanned.length < options.maxPages) scanned.push(pageNumber)
  })

  const render = async (pageNumber: number): Promise<ArrayBuffer> => {
    try {
      return await renderPageAsImage(new Uint8Array(bytes), pageNumber, {
        canvasImport: () => import('@napi-rs/canvas'),
        scale: renderScale(options.pdfDpi),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new CyberSelfError(500, `PDF 第 ${pageNumber} 页没有文字层，需要渲染成图片再转写，但这一步失败了：${reason}`)
    }
  }

  if (vision !== null) {
    await mapWithConcurrency(scanned, options.concurrency, async (pageNumber) => {
      if (aborted(options.signal)) return
      const image = await render(pageNumber)
      if (aborted(options.signal)) return
      const transcription = await vision.transcribe({
        bytes: new Uint8Array(image),
        mime: 'image/png',
        label: `PDF 第 ${pageNumber} 页`,
        signal: options.signal,
      })
      const text = (pages[pageNumber - 1] ?? '').trim()
      const merged = [text, transcription.trim()].filter((part) => part !== '').join('\n')
      if (merged !== '') slots[pageNumber - 1] = { text: merged, page: pageNumber, heading: null }
    })
  }

  return slots.filter((block): block is ParsedBlock => block !== null)
}
