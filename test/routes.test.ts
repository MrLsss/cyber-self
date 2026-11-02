/**
 * HTTP surface: every route runs behind a real node server, and the streaming
 * endpoints are read the way the browser reads them.
 * @module cyberself/test/routes
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createRoutes } from '../src/host/routes.ts'
import { CyberSelf } from '../src/host/service.ts'
import {
  ASK_PATH,
  CANCEL_PATH,
  FORGET_PATH,
  MARK_PATH,
  PURGE_PATH,
  SETTINGS_PATH,
  STORAGE_PATH,
  type AnswerView,
  type AskEvent,
  type Citation,
  type DocumentView,
  type EmbeddingSettingsView,
  type ForgetView,
  type ImportEvent,
  type ImportView,
  type LibraryView,
  type MarkView,
  type PurgeView,
  type SearchView,
  type SettingsView,
  type StorageView,
  type WorkspaceChoice,
} from '../src/shared/protocol.ts'
import { GatewayModelStream } from './gateway.ts'
import { ROOT, makeConfig, makeService, tempDir } from './helpers.ts'

const DOCUMENT = `# 报销制度

## 第一章 交通费

第一条 市内交通费凭票据实报销，单次不超过一百元。

第二条 跨城出差可以乘坐高铁二等座，票价实报实销。
`

let directory = ''
let service: CyberSelf
let server: Server
let origin = ''

before(async () => {
  directory = tempDir('routes')
  await writeFile(join(directory, '报销制度.md'), DOCUMENT, 'utf8')
  service = makeService(directory, makeConfig({ answer: { maxTokens: 1024 } }), {
    llm: new GatewayModelStream(),
    route: () => ({ provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash' }),
  })
  service.mark(directory, true)
  const routes = createRoutes({
    service,
    report: (error) => { throw error },
  })
  server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? ''
    const route = routes.find((candidate) => candidate.path === path)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `没有这个接口：${path}`, status: 404 }))
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
  service.dispose()
})

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Poll the library route until the background run has written every vector. */
async function settled(): Promise<LibraryView> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await (await post('/cyberself/api/library', { dir: directory })).json() as LibraryView
    if (view.stats === null) return view
    if (!view.stats.embedding.running && view.stats.embedded === view.stats.chunks) return view
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('后台向量化没有在时限内完成')
}

async function readStream<T>(response: Response): Promise<T[]> {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u)
  assert.ok(response.body !== null)
  const decoder = new TextDecoder()
  const events: T[] = []
  let buffered = ''
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(part, { stream: true })
    for (;;) {
      const boundary = buffered.indexOf('\n\n')
      if (boundary < 0) break
      const frame = buffered.slice(0, boundary)
      buffered = buffered.slice(boundary + 2)
      const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '))
      if (line !== undefined) events.push(JSON.parse(line.slice(6)) as T)
    }
  }
  return events
}

test('a plain request answers with JSON', async () => {
  const response = await post('/cyberself/api/workspaces', {})
  assert.equal(response.status, 200)
  const choices = await response.json() as WorkspaceChoice[]
  assert.equal(choices.length, 1)
  assert.equal(choices[0]?.path, directory)
  assert.equal(choices[0]?.library, true)
})

test('a GET on a JSON route is refused', async () => {
  const response = await fetch(`${origin}/cyberself/api/library`)
  assert.equal(response.status, 405)
})

test('importing over HTTP streams progress and returns the document', async () => {
  const response = await post('/cyberself/api/import', { dir: directory, path: join(directory, '报销制度.md') })
  const events = await readStream<ImportEvent>(response)
  const phases = events.filter((event) => event.kind === 'progress').map((event) => (event as { phase: string }).phase)
  assert.deepEqual(phases, ['parse', 'write'])
  const last = events.at(-1)
  assert.equal(last?.kind, 'import')
  const view = (last as { view: ImportView }).view
  assert.ok(view.document !== null, '导入成功时应当带文档')
  assert.equal(view.document.title, '报销制度')
})

test('the library route lists what was imported', async () => {
  const view = await settled()
  assert.equal(view.library, true)
  assert.ok(view.stats !== null)
  assert.equal(view.stats.documents, 1)
  assert.equal(view.documents.length, 1)
  assert.equal(view.documents[0]?.embeddedChunks, view.documents[0]?.chunkCount)
  assert.equal(view.stats.embedding.running, false)
  assert.equal(view.stats.embedding.error, null)
})

test('the settings route reports the endpoint and saves new values', async () => {
  const initial = await post(SETTINGS_PATH, {})
  assert.equal(initial.status, 200)
  const view = await initial.json() as SettingsView
  assert.equal(view.embedding.baseURL, 'http://127.0.0.1:11434')
  assert.equal(view.embedding.reachable, true)
  assert.ok(view.embedding.installed.includes('bge-m3:latest'))
  assert.equal(view.workspaces.length, 1)

  const saved = await post(SETTINGS_PATH, {
    embedding: { baseURL: 'http://127.0.0.1:11434/', model: 'bge-m3:latest', timeoutMs: 30_000, batchSize: 4 },
  })
  assert.equal(saved.status, 200)
  const after = await saved.json() as SettingsView
  assert.equal(after.embedding.baseURL, 'http://127.0.0.1:11434')
  assert.equal(after.embedding.batchSize, 4)

  const invalid = await post(SETTINGS_PATH, { embedding: { baseURL: 'not-a-url' } })
  assert.equal(invalid.status, 400)

  const tooLong = await post(SETTINGS_PATH, { embedding: { maxChars: 9000 } })
  assert.equal(tooLong.status, 400)
  const notBoolean = await post(SETTINGS_PATH, { embedding: { dedupeNumbers: 'yes' } })
  assert.equal(notBoolean.status, 400)
})

test('the mark route turns the library marker on and off', async () => {
  const off = await post(MARK_PATH, { dir: directory, library: false })
  const view = await off.json() as MarkView
  assert.deepEqual(view, { dir: directory, library: false, scope: 'library' })
  const library = await (await post('/cyberself/api/library', { dir: directory })).json() as LibraryView
  assert.equal(library.library, false)
  assert.equal(library.stats, null)

  const on = await post(MARK_PATH, { dir: directory, library: true })
  assert.deepEqual(await on.json() as MarkView, { dir: directory, library: true, scope: 'library' })

  const opened = await post(MARK_PATH, { dir: directory, library: true, scope: 'open' })
  assert.deepEqual(await opened.json() as MarkView, { dir: directory, library: true, scope: 'open' })
  const narrowed = await post(MARK_PATH, { dir: directory, library: true, scope: 'library' })
  assert.deepEqual(await narrowed.json() as MarkView, { dir: directory, library: true, scope: 'library' })

  const rejected = await post(MARK_PATH, { dir: directory, library: true, scope: 'everything' })
  assert.equal(rejected.status, 400)
})

test('search and document detail answer over HTTP', async () => {
  await settled()
  const search = await post('/cyberself/api/search', { dir: directory, query: '高铁票怎么报销' })
  const found = await search.json() as SearchView
  assert.ok(found.citations.length > 0)
  const detail = await post('/cyberself/api/document', { dir: directory, id: found.citations[0]?.documentId ?? '' })
  const view = await detail.json() as { document: DocumentView; chunks: unknown[] }
  assert.ok(view.chunks.length > 0)
})

test('asking streams tokens and then the answer', async () => {
  const events = await readStream<AskEvent>(await post(ASK_PATH, {
    id: 'ask-1',
    dir: directory,
    question: '跨城出差能坐什么车？',
  }))
  const tokens = events.filter((event) => event.kind === 'token')
  assert.ok(tokens.length > 0)
  const last = events.at(-1)
  assert.equal(last?.kind, 'answer')
  const answer = (last as { answer: AnswerView }).answer
  assert.ok(answer.answer.length > 0)
  assert.ok(answer.citations.length > 0)
  for (const citation of answer.citations as Citation[]) {
    assert.ok(citation.index >= 1)
  }
})

test('cancelling an unknown question is a 404', async () => {
  const response = await post(CANCEL_PATH, { id: 'nobody' })
  assert.equal(response.status, 404)
  const body = await response.json() as { status: number; error: string }
  assert.equal(body.status, 404)
  assert.match(body.error, /没有正在进行的回答/u)
})

test('errors carry their status and message', async () => {
  const notWorkspace = await post('/cyberself/api/library', { dir: ROOT })
  assert.equal(notWorkspace.status, 403)
  const body = await notWorkspace.json() as { error: string }
  assert.match(body.error, /工作区/u)

  const missing = await post('/cyberself/api/library', { dir: join(directory, '不存在的子目录') })
  assert.equal(missing.status, 404)
})

test('an unmarked workspace refuses library work over HTTP', async () => {
  const extra = join(directory, '补充说明.md')
  await writeFile(extra, '# 补充说明\n\n住宿费票据需要在报销单上逐张粘贴。\n', 'utf8')
  const unmark = await post(MARK_PATH, { dir: directory, library: false })
  assert.equal(unmark.status, 200)
  const previous = await post('/cyberself/api/library', { dir: directory }).then(async (response) => await response.json() as LibraryView)
  assert.equal(previous.library, false)
  const response = await post('/cyberself/api/import', { dir: directory, path: extra })
  const events = await readStream<ImportEvent>(response)
  const last = events.at(-1)
  assert.equal(last?.kind, 'error')
  assert.match((last as { message: string }).message, /还不是资料库/u)
  await post(MARK_PATH, { dir: directory, library: true })
})

test('an unknown endpoint is not served', async () => {
  const response = await post('/cyberself/api/nothing', {})
  assert.equal(response.status, 404)
})

test('the storage route reports where the data lives and how much it takes', async () => {
  const response = await post(STORAGE_PATH, {})
  assert.equal(response.status, 200)
  const view = await response.json() as StorageView
  assert.equal(view.root, '.cyberself')
  assert.equal(view.libraries.length, 1)
  const entry = view.libraries[0]
  assert.ok(entry !== undefined)
  assert.equal(entry.dir, directory)
  assert.ok(entry.bytes > 0)
  assert.equal(entry.file, join(directory, '.cyberself', 'kb.db'))
  assert.equal(view.totals.libraries, 1)
  assert.equal(view.totals.documents, entry.documents)
})

test('the purge route empties a library over HTTP', async () => {
  const before = await (await post('/cyberself/api/library', { dir: directory })).json() as LibraryView
  assert.ok(before.stats !== null)
  assert.ok(before.stats.documents > 0)

  const response = await post(PURGE_PATH, { dir: directory })
  assert.equal(response.status, 200)
  const purged = await response.json() as PurgeView
  assert.equal(purged.dir, directory)
  assert.equal(purged.removed, before.stats.documents)
  assert.ok(purged.reclaimed >= 0)

  const after = await (await post('/cyberself/api/library', { dir: directory })).json() as LibraryView
  assert.ok(after.stats !== null)
  assert.equal(after.stats.documents, 0)
  assert.deepEqual(after.documents, [])
  assert.equal(after.library, true)
})

test('the forget route deletes the library directory and its marker', async () => {
  const response = await post(FORGET_PATH, { dir: directory })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json() as ForgetView, { dir: directory, removed: true })
  assert.equal(existsSync(join(directory, '.cyberself')), false)
  const storage = await (await post(STORAGE_PATH, {})).json() as StorageView
  assert.equal(storage.libraries.length, 0)
})
