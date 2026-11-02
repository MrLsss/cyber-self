/**
 * Answer generation: one streaming call against the Host's model route, with a
 * single verification call when the first answer cites nothing.
 * @module cyberself/answer/qa
 */
import type { GenerateOptions, ReasoningEffortId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AnswerSettings } from '../config.ts'
import { CyberSelfError, type AnswerView, type Citation } from '../../shared/protocol.ts'
import {
  ANSWER_SYSTEM_PROMPT,
  VERIFY_INSTRUCTION,
  buildEvidencePrompt,
  parseCitationIndexes,
  selectEvidence,
} from './prompt.ts'

/** Provider route plus model id, optionally with a reasoning effort. */
export interface ModelRoute {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

/** What answering and transcription need from the Host model service. */
export interface ModelStream {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Everything one answer needs. */
export interface AnswerInput {
  question: string
  citations: readonly Citation[]
  settings: AnswerSettings
  maxEvidenceChars: number
  signal: AbortSignal
  /** Called with each streamed text fragment so the UI can render as it arrives. */
  onToken?: (text: string) => void
}

interface StreamOutcome {
  text: string
  failure: string | null
}

async function streamAnswer(
  llm: ModelStream,
  route: ModelRoute,
  input: AnswerInput,
  prompt: string,
  onToken: ((text: string) => void) | undefined,
): Promise<StreamOutcome> {
  const options: GenerateOptions = {
    provider: input.settings.provider === '' ? route.provider : input.settings.provider,
    model: input.settings.model === '' ? route.model : input.settings.model,
    system: ANSWER_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] }],
    temperature: input.settings.temperature,
    maxTokens: input.settings.maxTokens,
    signal: input.signal,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
  const chunks: AsyncIterable<StreamChunk> = llm.stream(options)
  let text = ''
  let failure: string | null = null
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      onToken?.(chunk.text)
      continue
    }
    if (chunk.type !== 'finish') continue
    const reason = chunk.reason
    if (reason.kind === 'error') failure = `模型调用失败：${describeFailure(reason.failure)}`
    else if (reason.kind === 'aborted') failure = '模型调用被中止'
    else if (reason.kind === 'tool-calls') failure = '模型返回了工具调用，本次回答已丢弃'
  }
  return { text: text.trim(), failure }
}

function describeFailure(failure: unknown): string {
  if (failure !== null && typeof failure === 'object') {
    const record = failure as { code?: unknown; message?: unknown }
    const code = typeof record.code === 'string' ? record.code : ''
    const message = typeof record.message === 'string' ? record.message : ''
    const parts = [code, message].filter((part) => part !== '')
    if (parts.length > 0) return parts.join(' · ')
  }
  return String(failure)
}

/**
 * Answer one question from numbered evidence.
 *
 * When the answer cites nothing, and verification is enabled, the model is
 * asked once more with the first attempt in view; the cited attempt wins.
 */
export async function answerQuestion(llm: ModelStream, route: ModelRoute, input: AnswerInput): Promise<AnswerView> {
  const evidence = selectEvidence(input.citations, input.maxEvidenceChars)
  if (evidence.length === 0) throw new CyberSelfError(422, '这次检索没有可用的资料片段')

  const modelLabel = `${input.settings.provider === '' ? route.provider : input.settings.provider}/${input.settings.model === '' ? route.model : input.settings.model}`
  const prompt = buildEvidencePrompt(input.question, evidence)
  const first = await streamAnswer(llm, route, input, prompt, input.onToken)
  if (first.failure !== null) throw new CyberSelfError(502, first.failure)
  if (first.text === '') throw new CyberSelfError(502, '模型没有返回任何内容')

  const numbers = parseCitationIndexes(first.text)
  const valid = numbers.filter((index) => index >= 1 && index <= evidence.length)
  const invalid = numbers.filter((index) => index < 1 || index > evidence.length)

  if (valid.length > 0) {
    return {
      question: input.question,
      answer: first.text,
      citations: evidence,
      model: modelLabel,
      warning: invalid.length === 0 ? null : `回答引用了不存在的编号：${invalid.join('、')}`,
    }
  }

  if (!input.settings.verify) {
    return {
      question: input.question,
      answer: first.text,
      citations: evidence,
      model: modelLabel,
      warning: '回答没有引用任何资料片段',
    }
  }

  const retryPrompt = [
    buildEvidencePrompt(input.question, evidence),
    '',
    VERIFY_INSTRUCTION,
    '',
    `上一次的回答是：${first.text}`,
  ].join('\n')
  const second = await streamAnswer(llm, route, input, retryPrompt, input.onToken)
  if (second.failure !== null) throw new CyberSelfError(502, second.failure)
  const retryNumbers = parseCitationIndexes(second.text)
  const retryValid = retryNumbers.filter((index) => index >= 1 && index <= evidence.length)
  if (retryValid.length > 0) {
    return {
      question: input.question,
      answer: second.text,
      citations: evidence,
      model: modelLabel,
      warning: null,
    }
  }
  return {
    question: input.question,
    answer: second.text === '' ? first.text : second.text,
    citations: evidence,
    model: modelLabel,
    warning: '回答没有引用任何资料片段',
  }
}
