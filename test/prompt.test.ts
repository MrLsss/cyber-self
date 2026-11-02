/**
 * Prompt assembly and citation checking: what the model is shown, and how its
 * bracket numbers are read back and validated against that evidence list.
 * @module cyberself/test/prompt
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Citation } from '../src/shared/protocol.ts'
import {
  buildEvidencePrompt,
  parseCitationIndexes,
  selectEvidence,
} from '../src/host/answer/prompt.ts'

function citation(index: number, text: string, page: number | null = null, heading: string | null = null): Citation {
  return {
    index,
    chunkId: `chunk-${index}`,
    documentId: `doc-${index}`,
    title: `文档${index}`,
    path: `/docs/${index}.md`,
    page,
    heading,
    text,
    score: 1 / index,
  }
}

test('parseCitationIndexes reads every bracket style and drops duplicates', () => {
  assert.deepEqual(parseCitationIndexes('结论如下[1]。依据还有[2][1]和【3】。'), [1, 2, 3])
  assert.deepEqual(parseCitationIndexes('没有引用的一段话。'), [])
  assert.deepEqual(parseCitationIndexes('[0][7]'), [0, 7])
})

test('buildEvidencePrompt numbers the excerpts and keeps their location', () => {
  const prompt = buildEvidencePrompt('报销标准是多少？', [
    citation(1, '第一条 差旅费按标准报销。', 3, '第一章 总则'),
    citation(2, '第二条 住宿费按城市分级。'),
  ])
  assert.match(prompt, /^问题：报销标准是多少？/u)
  assert.match(prompt, /\[1\]《文档1》 第 3 页 · 第一章 总则/u)
  assert.match(prompt, /\[2\]《文档2》\n第二条 住宿费按城市分级。/u)
})

test('selectEvidence stops before the character budget is exceeded', () => {
  const citations = [citation(1, 'a'.repeat(40)), citation(2, 'b'.repeat(40)), citation(3, 'c'.repeat(400))]
  const selected = selectEvidence(citations, 250)
  assert.deepEqual(selected.map((item) => item.index), [1, 2])
})

test('selectEvidence always keeps the first excerpt', () => {
  const selected = selectEvidence([citation(1, 'x'.repeat(500))], 100)
  assert.equal(selected.length, 1)
})

test('an empty evidence list stays empty', () => {
  assert.deepEqual(selectEvidence([], 1000), [])
})
