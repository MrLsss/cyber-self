/**
 * Chunk boundaries: heading changes, over-long paragraphs, short-block merging,
 * and the hashes used for deduplication.
 * @module cyberself/test/chunking
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChunkingSettings } from '../src/host/config.ts'
import { chunkBlocks, type SourceBlock } from '../src/host/kb/chunking.ts'

const SETTINGS: ChunkingSettings = { targetChars: 60, overlapChars: 10, minChars: 20 }

function block(text: string, heading: string | null = null, page: number | null = null): SourceBlock {
  return { text, page, heading }
}

test('a heading change starts a new chunk', () => {
  const chunks = chunkBlocks([block('第一章的正文内容比较长，足够独立成块。', '第一章'), block('第二章的正文内容同样足够长。', '第二章')], SETTINGS)
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks.map((chunk) => chunk.heading), ['第一章', '第二章'])
  assert.deepEqual(chunks.map((chunk) => chunk.ordinal), [0, 1])
})

test('paragraphs under one heading pack up to the target length', () => {
  const short = '这一句刚好够短。'
  const chunks = chunkBlocks([block([short, short, short].join('\n\n'), '总则')], SETTINGS)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]?.text.split('\n').length, 3)
})

test('an over-long paragraph is cut at sentence ends and keeps the overlap tail', () => {
  const sentence = '这是一个用于测试分块边界的完整句子。'
  const text = sentence.repeat(8)
  const chunks = chunkBlocks([block(text, '长段落')], SETTINGS)
  assert.ok(chunks.length >= 2, `expected several chunks, got ${chunks.length}`)
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= SETTINGS.targetChars + SETTINGS.overlapChars, `chunk too long: ${chunk.text.length}`)
  }
  const second = chunks[1]?.text ?? ''
  const firstTail = (chunks[0]?.text ?? '').slice(-SETTINGS.overlapChars)
  assert.ok(second.startsWith(firstTail), `second chunk should repeat the tail: ${second}`)
})

test('a short block joins the previous chunk of the same heading', () => {
  const chunks = chunkBlocks([block('这一段的内容已经足够长了，可以单独成为一个块。', '总则'), block('短句。', '总则')], SETTINGS)
  assert.equal(chunks.length, 1)
  assert.ok(chunks[0]?.text.endsWith('短句。'))
})

test('a short block under a different heading stays its own chunk', () => {
  const chunks = chunkBlocks([block('这一段的内容已经足够长了，可以单独成为一个块。', '总则'), block('短句。', '附则')], SETTINGS)
  assert.equal(chunks.length, 2)
})

test('chunk hashes ignore whitespace and case so duplicates collide', () => {
  const first = chunkBlocks([block('Duplicate  Text  Here.')], SETTINGS)
  const second = chunkBlocks([block('duplicate text here.')], SETTINGS)
  assert.equal(first[0]?.hash, second[0]?.hash)
})

test('empty blocks produce no chunks', () => {
  assert.deepEqual(chunkBlocks([block('   '), block('')], SETTINGS), [])
})
