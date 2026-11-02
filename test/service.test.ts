/**
 * Service integration against the real local Ollama embedding server and a real
 * SQLite file: the library marker, import, deduplication, retrieval with
 * vectors, and the refusals that keep the model out of conversations the
 * library cannot support.
 * @module cyberself/test/service
 */
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { CyberSelfError } from '../src/shared/protocol.ts'
import type { CyberSelf } from '../src/host/service.ts'
import { isLibraryWorkspace } from '../src/host/settings.ts'
import { makeConfig, makeService, tempDir } from './helpers.ts'

const dir = tempDir('service')
const idle = tempDir('idle')
const outside = tempDir('outside')
const travel = join(dir, '差旅费管理办法.md')
const notes = join(dir, '会议记录.txt')
const binary = join(dir, '程序.exe')

const service: CyberSelf = makeService(dir, makeConfig({ chunking: { targetChars: 300, overlapChars: 30, minChars: 40 } }), {
  listWorkspaces: () => [
    { id: 'ws-test', path: dir, title: '测试工作区' },
    { id: 'ws-idle', path: idle, title: '空闲工作区' },
  ],
})

before(() => {
  writeFileSync(travel, [
    '# 差旅费管理办法',
    '',
    '## 第一章 总则',
    '',
    '第一条 为了规范差旅费管理，制定本办法。出差人员应当事先填写出差申请单，经部门负责人批准后执行。',
    '',
    '## 第二章 报销标准',
    '',
    '第二条 住宿费按城市分级报销：一类城市每晚不超过六百元，二类城市每晚不超过四百元。',
    '',
    '第三条 市内交通费凭票据实报销，单次不超过一百元。',
  ].join('\n'), 'utf8')
  writeFileSync(notes, '周会记录\n\n本周完成了资料库的导入流程，下周开始做检索质量评估。\n', 'utf8')
  writeFileSync(binary, 'MZ')
  service.mark(dir, true)
})

after(() => {
  service.dispose()
})

test('a marked workspace has an empty library and a reachable embedding model', async () => {
  const view = await service.library(dir)
  assert.equal(view.library, true)
  assert.ok(view.stats !== null)
  assert.equal(view.stats.documents, 0)
  assert.equal(view.stats.chunks, 0)
  assert.equal(view.stats.configuredModel, 'bge-m3:latest')
  assert.equal(view.stats.embeddingReady, true)
  assert.deepEqual(view.documents, [])
  assert.equal(view.scope, 'library')
  assert.deepEqual(service.choices()[0], { id: 'ws-test', path: dir, title: '测试工作区', library: true, scope: 'library' })
})

test('the answer scope follows the marker and survives a re-mark', async () => {
  service.mark(dir, true, 'open')
  assert.equal(service.scopeOf(dir), 'open')
  assert.equal((await service.library(dir)).scope, 'open')
  assert.equal(service.choices()[0]?.scope, 'open')

  service.mark(dir, true)
  assert.equal(service.scopeOf(dir), 'open', '不给 scope 时保留原来的范围')

  service.mark(dir, true, 'library')
  assert.equal(service.scopeOf(dir), 'library')
  assert.equal((await service.library(dir)).scope, 'library')
})

test('an unmarked workspace reports no library and refuses library work', async () => {
  const view = await service.library(idle)
  assert.equal(view.library, false)
  assert.equal(view.stats, null)
  assert.deepEqual(view.documents, [])
  assert.equal(view.scope, 'library')
  assert.equal(service.isLibrary(idle), false)
  await assert.rejects(
    () => service.importFromPath(idle, travel),
    (error: unknown) => error instanceof CyberSelfError && error.status === 409,
  )
})

test('the workspace list is the only set of openable directories', () => {
  assert.throws(() => service.resolveDir(outside), (error: unknown) => error instanceof CyberSelfError && error.status === 403)
  assert.throws(() => service.resolveDir(join(dir, 'missing')), (error: unknown) => error instanceof CyberSelfError && error.status === 404)
  assert.equal(service.resolveDir(dir), dir)
})

test('importing a markdown file parses, chunks and embeds it', async () => {
  const phases: string[] = []
  const view = await service.importFromPath(dir, travel, (progress) => {
    phases.push(progress.phase)
  })
  assert.equal(view.duplicateOf, null)
  assert.ok(view.document !== null, '导入成功时应当带文档')
  assert.equal(view.document.title, '差旅费管理办法')
  assert.ok(view.chunksKept >= 2, `expected several chunks, got ${view.chunksKept}`)
  assert.ok(phases.includes('parse'))
  assert.ok(phases.includes('write'))

  await service.waitForEmbedding(dir)
  const library = await service.library(dir)
  assert.ok(library.stats !== null)
  assert.equal(library.stats.documents, 1)
  assert.equal(library.stats.embedded, library.stats.chunks)
  assert.equal(library.stats.embeddingModel, 'bge-m3:latest')
})

test('importing the same file again is reported as a duplicate', async () => {
  const first = (await service.library(dir)).documents[0]
  assert.ok(first !== undefined)
  const view = await service.importFromPath(dir, travel)
  assert.equal(view.duplicateOf, first.id)
  const library = await service.library(dir)
  assert.ok(library.stats !== null)
  assert.equal(library.stats.documents, 1)
})

test('an upload travels the same pipeline as a path import', async () => {
  const bytes = Buffer.from('附录\n\n本附录说明了报销单的填写方式。\n', 'utf8')
  const view = await service.importUpload(dir, '附录.txt', bytes.toString('base64'))
  assert.equal(view.duplicateOf, null)
  assert.ok(view.document !== null, '上传成功时应当带文档')
  assert.equal(view.document.title, '附录')
  const library = await service.library(dir)
  assert.ok(library.stats !== null)
  assert.equal(library.stats.documents, 2)
})

test('search embeds the query and returns numbered citations', async () => {
  await service.waitForEmbedding(dir)
  const view = await service.search(dir, '住宿费报销标准')
  assert.ok(view.citations.length >= 1, 'expected at least one citation')
  assert.equal(view.citations[0]?.index, 1)
  assert.ok(view.vectorHits > 0, 'expected the vector half to contribute')
  const documents = (await service.library(dir)).documents
  assert.equal(view.citations[0]?.documentId, documents.find((document) => document.title === '差旅费管理办法')?.id)
  assert.match(view.citations[0]?.text ?? '', /住宿费|报销/u)
})

test('searching for something absent returns no citations and says why', async () => {
  const view = await service.search(dir, '量子计算机的制冷方案')
  assert.deepEqual(view.citations, [])
  assert.ok(view.note !== null)
})

test('asking with evidence but no model service is refused with 503', async () => {
  const controller = new AbortController()
  await assert.rejects(
    () => service.ask({ dir, question: '住宿费能报销多少？', signal: controller.signal }),
    (error: unknown) => error instanceof CyberSelfError && error.status === 503,
  )
})

test('asking about a topic the library does not cover never reaches the model', async () => {
  const controller = new AbortController()
  await assert.rejects(
    () => service.ask({ dir, question: '量子计算机的制冷方案是什么？', signal: controller.signal }),
    (error: unknown) => error instanceof CyberSelfError && error.status === 422,
  )
})

test('scanning a directory lists importable files and skips the rest', async () => {
  const found = await service.scan(dir, dir)
  assert.ok(found.files.includes(travel))
  assert.ok(found.files.includes(notes))
  assert.ok(found.files.every((file) => !file.includes('程序.exe')))
  assert.ok(found.skipped.includes(binary))
})

test('document detail returns the stored chunks in order', async () => {
  const document = (await service.library(dir)).documents.find((item) => item.title === '差旅费管理办法')
  assert.ok(document !== undefined)
  const detail = await service.detail(dir, document.id)
  assert.equal(detail.document.id, document.id)
  assert.deepEqual(detail.chunks.map((chunk) => chunk.ordinal), detail.chunks.map((_, index) => index))
  assert.ok(detail.chunks.some((chunk) => chunk.heading === '第二章 报销标准'))
})

test('removing a document deletes it and its chunks', async () => {
  const document = (await service.library(dir)).documents.find((item) => item.title === '附录')
  assert.ok(document !== undefined)
  assert.deepEqual(await service.removeDocument(dir, document.id), { deleted: true })
  await assert.rejects(
    () => service.removeDocument(dir, document.id),
    (error: unknown) => error instanceof CyberSelfError && error.status === 404,
  )
  const library = await service.library(dir)
  assert.ok(library.stats !== null)
  assert.equal(library.stats.documents, 1)
})

test('clearing vectors and re-embedding restores full coverage', async () => {
  await service.waitForEmbedding(dir)
  const missing = await service.embedMissing(dir)
  assert.equal(missing.remaining, 0)
  await service.waitForEmbedding(dir)
  const library = await service.library(dir)
  assert.ok(library.stats !== null)
  assert.equal(library.stats.embedded, library.stats.chunks)
})

test('importing a document of unsupported type is refused', async () => {
  await assert.rejects(
    () => service.importFromPath(dir, binary),
    (error: unknown) => error instanceof CyberSelfError && error.status === 415,
  )
})

test('the library marker can be turned off and on without losing the database', () => {
  assert.equal(isLibraryWorkspace(dir), true)
  service.mark(dir, false)
  assert.equal(isLibraryWorkspace(dir), false)
  assert.equal(service.librarySummary(dir), null)
  service.mark(dir, true)
  assert.equal(isLibraryWorkspace(dir), true)
  assert.ok(service.librarySummary(dir) !== null)
})

test('the library summary counts what the policy line needs', async () => {
  const summary = service.librarySummary(dir)
  assert.ok(summary !== null)
  const library = await service.library(dir)
  assert.ok(library.stats !== null)
  assert.equal(summary.documents, library.stats.documents)
  assert.equal(summary.chunks, library.stats.chunks)
  assert.equal(summary.embedded, library.stats.embedded)
})

test('the library reports where its data lives and how much it occupies', async () => {
  const library = await service.library(dir)
  assert.ok(library.stats !== null)
  assert.equal(library.stats.file, join(dir, '.cyberself', 'kb.db'))
  assert.ok(library.stats.bytes > 0, `expected a positive size, got ${library.stats.bytes}`)
  assert.ok(library.stats.updatedAt !== null)
})

test('purging a library deletes every document and gives the space back', async () => {
  const before = await service.library(dir)
  assert.ok(before.stats !== null)
  assert.ok(before.stats.documents > 0)

  const purged = await service.purge(dir)
  assert.equal(purged.removed, before.stats.documents)
  assert.ok(purged.reclaimed >= 0)

  const after = await service.library(dir)
  assert.ok(after.stats !== null)
  assert.equal(after.stats.documents, 0)
  assert.equal(after.stats.chunks, 0)
  assert.equal(after.stats.embedded, 0)
  assert.deepEqual(after.documents, [])
  assert.ok(isLibraryWorkspace(dir), '清空资料之后这个工作区仍然是资料库')

  const again = await service.importFromPath(dir, travel)
  assert.equal(again.duplicateOf, null, '清空之后同一份文件可以重新导入')
})

test('the storage report covers every library and where its files live', async () => {
  const storage = service.storage()
  assert.equal(storage.root, '.cyberself')
  assert.ok(storage.settingsFile.endsWith(join('cyberself', 'settings.json')))
  assert.equal(storage.libraries.length, 1, '只有带标记的工作区会被统计')
  const entry = storage.libraries[0]
  assert.ok(entry !== undefined)
  assert.equal(entry.dir, dir)
  assert.equal(entry.title, '测试工作区')
  assert.ok(entry.bytes > 0)
  assert.equal(entry.file, join(dir, '.cyberself', 'kb.db'))
  assert.equal(storage.totals.libraries, 1)
  assert.equal(storage.totals.documents, entry.documents)
  assert.equal(storage.totals.bytes, entry.bytes)
})

test('forgetting a library deletes its files and drops the marker', () => {
  const result = service.forget(dir)
  assert.deepEqual(result, { dir, removed: true })
  assert.equal(existsSync(join(dir, '.cyberself')), false)
  assert.equal(isLibraryWorkspace(dir), false)
  assert.equal(service.storage().libraries.length, 0)
})
