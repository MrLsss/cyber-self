/**
 * Vision transcription: the output budget is generous enough for a reasoning
 * model to think and still write, and an empty reply is asked once more.
 * @module cyberself/test/vision
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createVisionTranscriber } from '../src/host/answer/vision.ts'
import type { OcrSettings } from '../src/host/config.ts'
import type { ModelStream } from '../src/host/answer/qa.ts'
import { CyberSelfError } from '../src/shared/protocol.ts'

const OCR: OcrSettings = {
  enabled: true,
  provider: '',
  model: '',
  pdfDpi: 160,
  maxPages: 40,
  concurrency: 3,
}

/** Answers each call with the next scripted reply and records the options it saw. */
class ScriptedModel implements ModelStream {
  readonly calls: GenerateOptions[] = []
  private readonly replies: string[][]

  constructor(replies: string[][]) {
    this.replies = replies
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const reply = this.replies.shift() ?? []
    for (const text of reply) yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const SAVER = {
  async saveImages(inputs: readonly { name: string }[]) {
    return inputs.map((input) => ({ id: `image-${input.name}`, mediaType: 'image/png', width: 1, height: 1 }))
  },
}

function transcriber(model: ModelStream) {
  return createVisionTranscriber(
    model,
    SAVER as never,
    () => ({ provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash' }),
    () => OCR,
  )
}

test('an empty reply is transcribed once more', async () => {
  const model = new ScriptedModel([[], ['体检套餐', ' 明细']])
  const text = await transcriber(model).transcribe({ bytes: new Uint8Array([1]), mime: 'image/png', label: '图片 套餐.png' })
  assert.equal(text, '体检套餐 明细')
  assert.equal(model.calls.length, 2)
})

test('the output budget leaves room for a reasoning model to think', async () => {
  const model = new ScriptedModel([['正文']])
  await transcriber(model).transcribe({ bytes: new Uint8Array([1]), mime: 'image/png', label: '图片 一.png' })
  assert.equal(model.calls[0]?.maxTokens, 16_384)
  assert.equal(model.calls[0]?.temperature, 0)
})

test('a model failure is raised with the image name', async () => {
  const failing: ModelStream = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'boom' } } } as StreamChunk
    },
  }
  await assert.rejects(
    () => transcriber(failing).transcribe({ bytes: new Uint8Array([1]), mime: 'image/png', label: '图片 二.png' }),
    (error: unknown) => error instanceof CyberSelfError && error.status === 502 && /图片 二\.png/u.test(error.message),
  )
})
