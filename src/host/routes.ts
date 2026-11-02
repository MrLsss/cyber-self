/**
 * HTTP surface of the plugin: JSON endpoints under {@link API_PREFIX}, plus
 * server-sent-event streams for question answering, import and embedding.
 * @module cyberself/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PREFIX,
  ASK_PATH,
  CANCEL_PATH,
  CyberSelfError,
  FORGET_PATH,
  MARK_PATH,
  PURGE_PATH,
  SETTINGS_PATH,
  STORAGE_PATH,
  type AskEvent,
  type AskRequest,
  type AnswerScope,
  type CancelRequest,
  type ErrorBody,
  type ImportEvent,
  type ImportRequest,
  type MarkRequest,
  type MarkView,
  type SettingsRequest,
} from '../shared/protocol.ts'
import type { ImportProgress } from './kb/import.ts'
import { parseEmbeddingPatch, type CyberSelf } from './service.ts'

/** Largest JSON body accepted on ordinary endpoints. */
const MAX_JSON_BYTES = 1024 * 1024

/** Largest upload payload accepted. */
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024

/** What the routes need from the plugin. */
export interface RouteDeps {
  service: CyberSelf
  /** Where an unexpected failure is logged; the caller still gets a response. */
  report: (error: unknown) => void
}

/** Writer of one server-sent-event stream. */
type StreamWriter = (event: unknown) => void

function endpoint(name: string): string {
  return `${API_PREFIX}/${name}`
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read the whole request body, refusing anything above the limit. */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > limit) throw new CyberSelfError(413, '请求内容超过限制')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson<T>(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<T> {
  const text = await readBody(req, limit)
  if (text === '') throw new CyberSelfError(400, '请求内容为空')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new CyberSelfError(400, '请求内容不是合法的 JSON')
  }
}

function requirePost(req: IncomingMessage): void {
  if (req.method !== 'POST') throw new CyberSelfError(405, '只接受 POST 请求')
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new CyberSelfError(400, `缺少 ${field}`)
  return value
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new CyberSelfError(400, `${field} 必须是布尔值`)
  return value
}

function requireScope(value: unknown): AnswerScope | undefined {
  if (value === undefined) return undefined
  if (value !== 'library' && value !== 'open') throw new CyberSelfError(400, 'scope 只能是 library 或 open')
  return value
}

/** Start an event stream and return its writer. */
function openStream(res: ServerResponse): StreamWriter {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
  return (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}

function messageOf(error: unknown): string {
  if (error instanceof CyberSelfError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

function statusOf(error: unknown): number {
  return error instanceof CyberSelfError ? error.status : 500
}

function guarded(deps: RouteDeps, res: ServerResponse, work: () => Promise<void>, failStream?: StreamWriter): void {
  work().catch((error: unknown) => {
    if (statusOf(error) === 500) deps.report(error)
    if (res.headersSent) {
      failStream?.({ kind: 'error', message: messageOf(error) })
      res.end()
      return
    }
    sendJson(res, statusOf(error), { error: messageOf(error), status: statusOf(error) } satisfies ErrorBody)
  })
}

/** Every route this plugin serves. */
export function createRoutes(deps: RouteDeps): WebRoute[] {
  const { service } = deps
  const running = new Map<string, AbortController>()

  const json = (name: string, work: (req: IncomingMessage, res: ServerResponse) => Promise<void>): WebRoute => ({
    kind: 'exact',
    path: name.startsWith('/') ? name : endpoint(name),
    handler: (req, res) => guarded(deps, res, () => work(req, res)),
  })

  /**
   * A stream endpoint: the body is read and validated first, so a bad request
   * still gets a JSON error with a real status, then the stream opens.
   */
  const stream = (
    name: string,
    work: (req: IncomingMessage, res: ServerResponse, write: StreamWriter) => Promise<void>,
  ): WebRoute => ({
    kind: 'exact',
    path: name.startsWith('/') ? name : endpoint(name),
    handler: (req, res) => {
      guarded(deps, res, async () => {
        requirePost(req)
        await work(req, res, openStream(res))
        res.end()
      }, (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      })
    },
  })

  return [
    json('workspaces', async (req, res) => {
      requirePost(req)
      sendJson(res, 200, service.choices())
    }),

    json(SETTINGS_PATH, async (req, res) => {
      requirePost(req)
      const body = await readJson<SettingsRequest>(req)
      sendJson(res, 200, await service.saveSettings(parseEmbeddingPatch(body.embedding)))
    }),

    json(MARK_PATH, async (req, res) => {
      requirePost(req)
      const body = await readJson<MarkRequest>(req)
      const dir = requireString(body.dir, 'dir')
      const view = service.mark(dir, requireBoolean(body.library, 'library'), requireScope(body.scope))
      sendJson(res, 200, view satisfies MarkView)
    }),

    json('library', async (req, res) => {
      requirePost(req)
      const body = await readJson<{ dir?: unknown }>(req)
      sendJson(res, 200, await service.library(requireString(body.dir, 'dir')))
    }),

    json('search', async (req, res) => {
      requirePost(req)
      const body = await readJson<{ dir?: unknown; query?: unknown }>(req)
      sendJson(res, 200, await service.search(requireString(body.dir, 'dir'), requireString(body.query, 'query')))
    }),

    json('document', async (req, res) => {
      requirePost(req)
      const body = await readJson<{ dir?: unknown; id?: unknown }>(req)
      sendJson(res, 200, await service.detail(requireString(body.dir, 'dir'), requireString(body.id, 'id')))
    }),

    json('delete', async (req, res) => {
      requirePost(req)
      const body = await readJson<{ dir?: unknown; id?: unknown }>(req)
      sendJson(res, 200, await service.removeDocument(requireString(body.dir, 'dir'), requireString(body.id, 'id')))
    }),

    json(PURGE_PATH, async (req, res) => {
      requirePost(req)
      const body = await readJson<{ dir?: unknown }>(req)
      sendJson(res, 200, await service.purge(requireString(body.dir, 'dir')))
    }),

    json(FORGET_PATH, async (req, res) => {
      requirePost(req)
      const body = await readJson<{ dir?: unknown }>(req)
      sendJson(res, 200, service.forget(requireString(body.dir, 'dir')))
    }),

    json(STORAGE_PATH, async (req, res) => {
      requirePost(req)
      sendJson(res, 200, service.storage())
    }),

    json('scan', async (req, res) => {
      requirePost(req)
      const body = await readJson<{ dir?: unknown; path?: unknown }>(req)
      sendJson(res, 200, await service.scan(requireString(body.dir, 'dir'), requireString(body.path, 'path')))
    }),

    stream('embed', async (req, res, write) => {
      const body = await readJson<{ dir?: unknown }>(req)
      const result = await service.embedMissing(requireString(body.dir, 'dir'))
      write({ kind: 'embedded', remaining: result.remaining } satisfies ImportEvent)
    }),

    stream('import', async (req, res, write) => {
      const body = await readJson<ImportRequest>(req, MAX_UPLOAD_BYTES)
      const dir = requireString(body.dir, 'dir')
      const onProgress = (progress: ImportProgress): void => {
        write({ kind: 'progress', phase: progress.phase, done: progress.done, total: progress.total } satisfies ImportEvent)
      }
      const view = typeof body.path === 'string'
        ? await service.importFromPath(dir, body.path, onProgress)
        : await service.importUpload(dir, requireString(body.name, 'name'), requireString(body.data, 'data'), onProgress)
      write({ kind: 'import', view } satisfies ImportEvent)
    }),

    json(CANCEL_PATH, async (req, res) => {
      requirePost(req)
      const body = await readJson<CancelRequest>(req)
      const controller = running.get(requireString(body.id, 'id'))
      if (controller === undefined) throw new CyberSelfError(404, '没有正在进行的回答')
      controller.abort()
      sendJson(res, 200, { cancelled: true })
    }),

    stream(ASK_PATH, async (req, res, write) => {
      const body = await readJson<AskRequest>(req)
      const id = requireString(body.id, 'id')
      const dir = requireString(body.dir, 'dir')
      const question = requireString(body.question, 'question')
      const controller = new AbortController()
      running.set(id, controller)
      res.on('close', () => controller.abort())
      try {
        const answer = await service.ask({
          dir,
          question,
          signal: controller.signal,
          onToken: (text: string) => write({ kind: 'token', text } satisfies AskEvent),
        })
        write({ kind: 'answer', answer } satisfies AskEvent)
      } catch (error) {
        if (controller.signal.aborted) {
          write({ kind: 'cancelled' } satisfies AskEvent)
          return
        }
        if (statusOf(error) === 500) deps.report(error)
        write({ kind: 'error', message: messageOf(error) } satisfies AskEvent)
      } finally {
        running.delete(id)
      }
    }),
  ]
}
