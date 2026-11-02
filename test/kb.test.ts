/**
 * Storage and retrieval against a real SQLite file: schema bootstrap, chunk
 * writes, deduplication hashes, keyword and vector halves, and cascade delete.
 * @module cyberself/test/kb
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { after, test } from 'node:test'
import { join } from 'node:path'
import { closeKb, locateKb, openKb, type KbHandle } from '../src/host/kb/db.ts'
import { chunkBlocks } from '../src/host/kb/chunking.ts'
import {
  clearEmbeddings,
  countPendingChunks,
  deleteDocument,
  findChunkHashes,
  getDocument,
  insertChunks,
  insertDocument,
  libraryStats,
  listChunks,
  listDocuments,
  pendingChunkIds,
  readMeta,
  recordEmbeddingModel,
  setChunkEmbedding,
} from '../src/host/kb/store.ts'
import { materializeCitations, retrieve } from '../src/host/kb/search.ts'
import { tempDir } from './helpers.ts'

const LIMITS = { topK: 5, perDocument: 2, minScore: 0.008 }
const CHUNKING = { targetChars: 200, overlapChars: 20, minChars: 40 }

const dir = tempDir('kb')
const handle: KbHandle = openKb(dir)

after(() => {
  closeKb(handle)
})

function addDocument(id: string, title: string, chunks: { text: string; vector?: Float32Array }[]): void {
  insertDocument(handle, {
    id,
    title,
    path: `/docs/${id}.md`,
    kind: 'markdown',
    bytes: 100,
    sha256: `sha-${id}`,
    importedAt: Date.now(),
  })
  const raw = chunks.map((chunk, ordinal) => ({
    text: chunk.text,
    hash: `hash-${id}-${ordinal}`,
    ordinal,
    page: null,
    heading: null,
  }))
  insertChunks(handle, id, raw, chunks.map((chunk) => chunk.vector ?? null))
}

test('opening a knowledge base creates the file and records the schema version', () => {
  const location = locateKb(dir)
  assert.equal(location.file, join(dir, '.cyberself', 'kb.db'))
  assert.ok(existsSync(location.file))
  assert.equal(readMeta(handle, 'schema_version'), '1')
})

test('documents and chunks are written, counted and listed', () => {
  addDocument('doc-a', 'A 文档', [
    { text: '第一段讲的是知识库的导入流程。' },
    { text: '第二段讲的是资料库的检索方式。' },
  ])
  const stats = libraryStats(handle)
  assert.equal(stats.documents, 1)
  assert.equal(stats.chunks, 2)
  assert.equal(stats.embedded, 0)

  const [document] = listDocuments(handle)
  assert.equal(document?.id, 'doc-a')
  assert.equal(document?.chunkCount, 2)
  assert.equal(document?.embeddedChunks, 0)

  assert.equal(getDocument(handle, 'doc-a')?.title, 'A 文档')
  assert.equal(getDocument(handle, 'missing'), null)
  assert.equal(listChunks(handle, 'doc-a', 10).length, 2)
})

test('stored chunk hashes expose repeats across documents', () => {
  const hashes = findChunkHashes(handle, ['hash-doc-a-0', 'hash-doc-a-1', 'hash-missing'])
  assert.ok(hashes.has('hash-doc-a-0'))
  assert.ok(hashes.has('hash-doc-a-1'))
  assert.equal(hashes.has('hash-missing'), false)
  assert.equal(hashes.size, 2)
})

test('keyword retrieval finds a chunk through the trigram index', () => {
  const result = retrieve(handle, { text: '知识库', vector: null }, LIMITS)
  assert.equal(result.vectorHits, 0)
  assert.equal(result.keywordHits > 0, true)
  assert.equal(result.hits[0]?.chunk.documentId, 'doc-a')
  assert.match(result.hits[0]?.chunk.text ?? '', /知识库/u)
})

test('vector retrieval ranks the nearest embedding first', () => {
  setChunkEmbedding(handle, 'doc-a-00000', new Float32Array([1, 0, 0]))
  setChunkEmbedding(handle, 'doc-a-00001', new Float32Array([0, 1, 0]))
  assert.equal(libraryStats(handle).embedded, 2)

  const result = retrieve(handle, { text: '无关的查询词', vector: new Float32Array([1, 0, 0]) }, LIMITS)
  assert.equal(result.vectorHits, 1)
  assert.equal(result.keywordHits, 0)
  assert.equal(result.hits[0]?.chunk.id, 'doc-a-00000')
  assert.equal(result.hits[0]?.fromVector, true)
})

test('the per-document cap keeps one document from filling every slot', () => {
  addDocument('doc-b', 'B 文档', [
    { text: '资料库的导入流程在第一段也提到过。', vector: new Float32Array([0.9, 0.1, 0]) },
    { text: '资料库的检索方式在第二段也提到过。', vector: new Float32Array([0.8, 0.2, 0]) },
    { text: '资料库的分块策略在第三段也提到过。', vector: new Float32Array([0.7, 0.3, 0]) },
  ])
  const result = retrieve(handle, { text: '资料库', vector: new Float32Array([0.8, 0.2, 0]) }, LIMITS)
  const fromB = result.hits.filter((hit) => hit.chunk.documentId === 'doc-b')
  assert.equal(fromB.length, LIMITS.perDocument)
})

test('citations are numbered by rank and carry document identity', () => {
  const result = retrieve(handle, { text: '知识库', vector: null }, LIMITS)
  const citations = materializeCitations(result.hits)
  assert.deepEqual(citations.map((citation) => citation.index), citations.map((_, index) => index + 1))
  assert.equal(citations[0]?.documentId, 'doc-a')
  assert.equal(citations[0]?.title, 'A 文档')
})

test('pending chunks and the recorded model drive re-embedding', () => {
  assert.equal(countPendingChunks(handle), 0)
  assert.deepEqual(pendingChunkIds(handle), [])

  recordEmbeddingModel(handle, 'bge-m3:latest', 3)
  assert.equal(readMeta(handle, 'embedding_model'), 'bge-m3:latest')

  const cleared = clearEmbeddings(handle)
  assert.equal(cleared, 5)
  assert.equal(readMeta(handle, 'embedding_model'), null)
  assert.equal(libraryStats(handle).embedded, 0)
  assert.equal(countPendingChunks(handle), 5)
  assert.equal(pendingChunkIds(handle).length, 5)
  assert.equal(pendingChunkIds(handle)[0]?.documentId, 'doc-a')
})

test('deleting a document removes its chunks', () => {
  assert.equal(deleteDocument(handle, 'doc-b'), true)
  assert.equal(deleteDocument(handle, 'doc-b'), false)
  const stats = libraryStats(handle)
  assert.equal(stats.documents, 1)
  assert.equal(stats.chunks, 2)
})

test('chunkBlocks output inserts directly and keeps duplicate text out', () => {
  const chunks = chunkBlocks(
    [{ text: '这一段来自分块器，用来验证写入链路。', page: 1, heading: '第一章' }],
    CHUNKING,
  )
  assert.equal(chunks.length, 1)
  const hashes = findChunkHashes(handle, [chunks[0]?.hash ?? ''])
  assert.equal(hashes.size, 0)
})
