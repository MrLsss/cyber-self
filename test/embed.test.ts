/**
 * The embedding pipeline against the real local Ollama server: table rows whose
 * numbers differ share one vector, prose keeps its numbers, and the character
 * cap makes chunks with the same head share one vector too.
 * @module cyberself/test/embed
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { closeKb, decodeVector, openKb, type KbHandle } from '../src/host/kb/db.ts'
import { insertChunks, insertDocument } from '../src/host/kb/store.ts'
import { createOllamaEmbedder } from '../src/host/embed/ollama.ts'
import { embedPending } from '../src/host/embed/pipeline.ts'
import { makeConfig, tempDir } from './helpers.ts'

const config = makeConfig()
const embedder = createOllamaEmbedder(config.embedding)
const handles: KbHandle[] = []

after(() => {
  for (const handle of handles) closeKb(handle)
})

/** A library holding one document whose chunks are the given texts. */
function library(label: string, kind: string, texts: readonly string[]): KbHandle {
  const handle = openKb(tempDir(label))
  handles.push(handle)
  insertDocument(handle, {
    id: 'doc-1',
    title: label,
    path: `/docs/${label}`,
    kind,
    bytes: 100,
    sha256: `sha-${label}`,
    importedAt: Date.now(),
  })
  insertChunks(handle, 'doc-1', texts.map((text, ordinal) => ({
    text,
    hash: `hash-${label}-${ordinal}`,
    ordinal,
    page: null,
    heading: null,
  })), texts.map(() => null))
  return handle
}

/** The stored vector of one chunk. */
function vectorOf(handle: KbHandle, id: string): Float32Array {
  const row = handle.db.prepare('SELECT embedding FROM chunks WHERE id = ?').get(id) as
    | { embedding: Uint8Array | null }
    | undefined
  assert.ok(row !== undefined, `没有这个分块：${id}`)
  assert.ok(row.embedding !== null, `分块没有向量：${id}`)
  return decodeVector(row.embedding)
}

test('table rows that differ only in numbers share one vector', async () => {
  const handle = library('dedupe', 'xlsx', [
    '第一季度 | 收入 | 1200 | 3000',
    '第一季度 | 收入 | 4500 | 8000',
    '第一季度 | 收入 | 900 | 120',
  ])
  const written = await embedPending(handle, embedder, { batchSize: 8, dedupeNumbers: true })
  assert.equal(written, 3)
  const first = vectorOf(handle, 'doc-1-00000')
  assert.deepEqual(vectorOf(handle, 'doc-1-00001'), first)
  assert.deepEqual(vectorOf(handle, 'doc-1-00002'), first)
})

test('prose keeps its numbers, so different figures get different vectors', async () => {
  const handle = library('prose', 'markdown', [
    '二零二三年公司营业收入为一千二百万元。',
    '二零二四年公司营业收入为一千二百万元。',
  ])
  await embedPending(handle, embedder, { batchSize: 8, dedupeNumbers: true })
  const first = vectorOf(handle, 'doc-1-00000')
  assert.notDeepEqual(vectorOf(handle, 'doc-1-00001'), first)
})

test('the character cap makes chunks with the same head share one vector', async () => {
  const head = '这一段用于验证字符上限，两个分块的前半部分完全一致。'.repeat(8)
  const texts = [`${head}甲`, `${head}乙`]
  const capped = library('capped', 'markdown', texts)
  await embedPending(capped, embedder, { batchSize: 8, maxChars: 200 })
  assert.deepEqual(vectorOf(capped, 'doc-1-00001'), vectorOf(capped, 'doc-1-00000'))

  const whole = library('whole', 'markdown', texts)
  await embedPending(whole, embedder, { batchSize: 8, maxChars: 0 })
  assert.notDeepEqual(vectorOf(whole, 'doc-1-00001'), vectorOf(whole, 'doc-1-00000'))
})
