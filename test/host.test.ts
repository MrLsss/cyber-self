/**
 * The plugin's boot path: applying it with no configuration must resolve the
 * defaults, mount every route, register every tool, and serve real requests.
 * @module cyberself/test/host
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { apply } from '../src/host/index.ts'
import { tempDir } from './helpers.ts'

interface MountedRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

test('apply mounts the full host surface without any configuration', async () => {
  const dir = await tempDir('host')
  const routes: MountedRoute[] = []
  const tools: string[] = []
  const disposers: (() => unknown)[] = []

  const context = {
    logger: { warn: (): void => {} },
    effect: (work: () => unknown): void => {
      const disposer = work()
      if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
    },
    on: (): (() => void) => () => {},
    webServer: {
      register: (route: MountedRoute): (() => void) => {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register: (tool: { name: string }): (() => void) => {
        tools.push(tool.name)
        return () => {}
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash' }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'workspace', path: dir, title: '测试工作区' }],
    },
    llm: null,
    attachments: null,
  }

  apply(context as never, undefined)

  const paths = routes.map((route) => route.path).sort()
  assert.deepEqual(paths, [
    '/cyberself/api/ask',
    '/cyberself/api/cancel',
    '/cyberself/api/delete',
    '/cyberself/api/document',
    '/cyberself/api/embed',
    '/cyberself/api/forget',
    '/cyberself/api/import',
    '/cyberself/api/library',
    '/cyberself/api/mark',
    '/cyberself/api/purge',
    '/cyberself/api/scan',
    '/cyberself/api/search',
    '/cyberself/api/settings',
    '/cyberself/api/storage',
    '/cyberself/api/workspaces',
  ])
  assert.deepEqual(tools.sort(), ['knowledge_documents', 'knowledge_read', 'knowledge_search'])

  const server = createServer((req, res) => {
    const route = routes.find((entry) => entry.kind === 'exact' && entry.path === (req.url ?? ''))
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`

  const choices = await fetch(`${base}/cyberself/api/workspaces`, { method: 'POST' })
  assert.equal(choices.status, 200)
  assert.deepEqual(await choices.json(), [{ id: 'workspace', path: dir, title: '测试工作区', library: false, scope: 'library' }])

  const library = await fetch(`${base}/cyberself/api/library`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  })
  assert.equal(library.status, 200)
  const body = await library.json() as { library: boolean; stats: unknown; documents: unknown[] }
  assert.equal(body.library, false)
  assert.equal(body.stats, null)
  assert.deepEqual(body.documents, [])

  const marked = await fetch(`${base}/cyberself/api/mark`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir, library: true }),
  })
  assert.equal(marked.status, 200)
  assert.deepEqual(await marked.json(), { dir, library: true, scope: 'library' })

  await new Promise<void>((resolve) => { server.close(() => resolve()) })
  for (const disposer of disposers.reverse()) await disposer()
})
