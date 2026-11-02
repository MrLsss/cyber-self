/**
 * A real model client for the test suite: it speaks the OpenAI-compatible
 * streaming protocol to the gateway this machine already runs, so answer
 * generation is exercised against an actual model.
 * @module cyberself/test/gateway
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ModelStream } from '../src/host/answer/qa.ts'

/** Chat message as the gateway expects it. */
interface GatewayMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Stream deltas worth reading out of one chunk. */
interface GatewayChunk {
  choices?: {
    delta?: { content?: string | null }
    finish_reason?: string | null
  }[]
  error?: { message?: string }
}

function textOf(options: GenerateOptions): GatewayMessage[] {
  const messages: GatewayMessage[] = []
  if (typeof options.system === 'string' && options.system !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
    if (typeof message.content === 'string') {
      messages.push({ role, content: message.content })
      continue
    }
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('\n')
    messages.push({ role, content: text })
  }
  return messages
}

function finishOf(reason: string | null | undefined): StreamChunk {
  if (reason === 'length') return { type: 'finish', reason: { kind: 'max-tokens' } }
  return { type: 'finish', reason: { kind: 'stop' } }
}

/** Model client pointing at the local gateway. */
export class GatewayModelStream implements ModelStream {
  private readonly baseURL: string
  private readonly apiKey: string | null

  constructor(baseURL = 'http://127.0.0.1:3425/v1', apiKey: string | null = null) {
    this.baseURL = baseURL
    this.apiKey = apiKey
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey !== null) headers.authorization = `Bearer ${this.apiKey}`
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model,
        messages: textOf(options),
        stream: true,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok || response.body === null) {
      const detail = await response.text()
      throw new Error(`模型网关返回 ${response.status}：${detail.slice(0, 400)}`)
    }

    const decoder = new TextDecoder()
    let buffered = ''
    let reason: string | null = null
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(part, { stream: true })
      for (;;) {
        const boundary = buffered.indexOf('\n\n')
        if (boundary < 0) break
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') continue
          const chunk = JSON.parse(payload) as GatewayChunk
          if (chunk.error !== undefined) throw new Error(`模型网关报告错误：${chunk.error.message ?? ''}`)
          const choice = chunk.choices?.[0]
          const text = choice?.delta?.content ?? ''
          if (text !== '') yield { type: 'text-delta', index: 0, text }
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) reason = choice.finish_reason
        }
      }
    }
    yield finishOf(reason)
  }
}
