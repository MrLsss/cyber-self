/**
 * Vision transcription: stores the image through the attachment service, then
 * asks the configured vision model to return the text in it verbatim.
 *
 * A reasoning model spends part of its output budget thinking, and a page full
 * of small text can use up the whole budget before it writes a single
 * character, so the budget is generous and an empty reply is asked once more.
 * @module cyberself/answer/vision
 */
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CyberSelfError } from '../../shared/protocol.ts'
import type { OcrSettings } from '../config.ts'
import type { VisionRequest, VisionTranscriber } from '../parse/types.ts'
import type { ModelRoute, ModelStream } from './qa.ts'

/** What transcription needs from the attachment service. */
export interface ImageSaver {
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
}

const TRANSCRIPTION_PROMPT = [
  '把这张图片里的所有文字按原来的阅读顺序转写出来。',
  '保留标题层级、列表和表格的行列关系；表格用 Markdown 表格。',
  '不要描述图片，不要补充图中没有的内容。图片里没有文字时返回空字符串。',
].join('\n')

const TRANSCRIPTION_MAX_TOKENS = 16_384

async function readTranscription(llm: ModelStream, options: GenerateOptions, label: string): Promise<string> {
  const chunks: AsyncIterable<StreamChunk> = llm.stream(options)
  let text = ''
  let failure: string | null = null
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') failure = '转写被中止'
    else if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = '模型调用失败'
  }
  if (failure !== null) throw new CyberSelfError(502, `${label} 转写失败：${failure}`)
  return text.trim()
}

/** Build a transcriber bound to the live model route and OCR settings. */
export function createVisionTranscriber(
  llm: ModelStream,
  attachments: ImageSaver,
  resolveRoute: () => ModelRoute,
  settings: () => OcrSettings,
): VisionTranscriber {
  return {
    async transcribe(request: VisionRequest) {
      const config = settings()
      const route = resolveRoute()
      const provider = config.provider === '' ? route.provider : config.provider
      const model = config.model === '' ? route.model : config.model
      const [reference] = await attachments.saveImages([{
        data: request.bytes,
        mediaType: request.mime as ImageMediaType,
        name: request.label,
      }])
      if (reference === undefined) throw new CyberSelfError(502, `无法保存 ${request.label} 用于转写`)

      const options: GenerateOptions = {
        provider,
        model,
        system: TRANSCRIPTION_PROMPT,
        messages: [{
          role: 'user' as const,
          content: [
            { type: 'image' as const, attachment: reference },
            { type: 'text' as const, text: '请转写这张图片。' },
          ],
        }],
        temperature: 0,
        maxTokens: TRANSCRIPTION_MAX_TOKENS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      const first = await readTranscription(llm, options, request.label)
      if (first !== '' || request.signal?.aborted === true) return first
      return await readTranscription(llm, options, request.label)
    },
  }
}
