/**
 * Browser side transport: requests resolve against the page base so they work
 * behind the desktop shell's custom scheme and behind a reverse proxy prefix.
 * @module cyberself/client/base
 */
import { API_PREFIX, type ErrorBody } from '../shared/protocol.ts'

const PREFIX = `${API_PREFIX.replace(/^\/+/u, '')}/`

/** Absolute URL of one plugin route, anchored at the page itself. */
export function endpoint(path: string): string {
  const base = document.baseURI.replace(/[?#].*$/u, '')
  const rooted = base.endsWith('/') ? base : `${base}/`
  const trimmed = path.replace(/^\/+/u, '')
  const relative = trimmed.startsWith(PREFIX) ? trimmed : `${PREFIX}${trimmed}`
  return new URL(relative, rooted).toString()
}

async function failure(response: Response): Promise<Error> {
  const text = await response.text()
  try {
    const body = JSON.parse(text) as Partial<ErrorBody>
    if (typeof body.error === 'string' && body.error !== '') return new Error(body.error)
  } catch {
    // The body was not our JSON envelope; fall through to the raw text.
  }
  return new Error(text === '' ? `请求失败（${response.status}）` : text)
}

/** POST JSON and decode the JSON response. */
export async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw await failure(response)
  return await response.json() as T
}

/** POST JSON and deliver each server-sent event to the callback. */
export async function postStream<T>(
  path: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(endpoint(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw await failure(response)
  if (response.body === null) throw new Error('回答流没有开始')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const line = frame.split('\n').find((part) => part.startsWith('data: '))
      if (line !== undefined) onEvent(JSON.parse(line.slice(6)) as T)
      boundary = buffer.indexOf('\n\n')
    }
  }
}

/** Read a file as base64 without its data-URL prefix. */
export async function readBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < buffer.length; offset += step) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + step))
  }
  return btoa(binary)
}

/** Human-readable byte count. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
