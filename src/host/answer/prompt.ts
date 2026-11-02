/**
 * Prompt construction and citation parsing for the answering step. The model
 * only ever sees the numbered excerpts retrieval produced, and every number it
 * writes is checked against that list afterwards.
 * @module cyberself/answer/prompt
 */
import type { Citation } from '../../shared/protocol.ts'

/** Instruction block that fixes the answer format. */
export const ANSWER_SYSTEM_PROMPT = [
  '你是资料库问答助手。你只能依据这次给出的资料片段回答，不能使用片段之外的知识。',
  '',
  '规则：',
  '1. 每个论断后面用方括号编号标注来源，例如 [1]；同一句依据多条资料时写作 [1][3]。',
  '2. 只允许使用这次给出的编号，未给出的编号不能出现。',
  '3. 资料不足以回答时，直接说明缺少哪一类资料，不要猜测。',
  '4. 先给结论，再给依据；用自己的话概括，不要整段抄写原文。',
].join('\n')

/** Instruction sent when the first answer cited nothing. */
export const VERIFY_INSTRUCTION = '你刚才的回答没有标注任何引用。请重新回答这个问题，每个论断都必须带上资料片段编号，例如 [1]。'

/** Keep the evidence block within the configured character budget. */
export function selectEvidence(citations: readonly Citation[], maxChars: number): Citation[] {
  const selected: Citation[] = []
  let used = 0
  for (const citation of citations) {
    const cost = citation.text.length + 80
    if (selected.length > 0 && used + cost > maxChars) break
    selected.push(citation)
    used += cost
  }
  return selected
}

/** Render the numbered evidence block handed to the model. */
export function buildEvidencePrompt(question: string, evidence: readonly Citation[]): string {
  const parts: string[] = [`问题：${question}`, '', '资料片段：']
  for (const citation of evidence) {
    const location = citation.page === null ? '' : ` 第 ${citation.page} 页`
    const section = citation.heading === null ? '' : ` · ${citation.heading}`
    parts.push('', `[${citation.index}]《${citation.title}》${location}${section}`, citation.text)
  }
  parts.push('', '请依据以上片段回答问题。')
  return parts.join('\n')
}

/** Every citation number written in the answer, in order, without duplicates. */
export function parseCitationIndexes(answer: string): number[] {
  const found: number[] = []
  const seen = new Set<number>()
  for (const match of answer.matchAll(/[[【](\d{1,3})[\]】]/gu)) {
    const value = Number(match[1])
    if (!Number.isInteger(value) || seen.has(value)) continue
    seen.add(value)
    found.push(value)
  }
  return found
}
