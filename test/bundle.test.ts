/**
 * The shipped client bundle driven through the real web module system: it must
 * register one factory, materialize under the module table's `require`, and hand
 * the shell `name`/`inject`/`apply`. A bundle the shell cannot materialize stops
 * the whole renderer boot, so this test loads the artifact exactly the way the
 * app does.
 * @module cyberself/test/bundle
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import * as react from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import * as primitives from './shims/primitives.ts'
import { ROOT } from './helpers.ts'

const CLIENT_MODULES = resolve(ROOT, 'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js')

interface BundleRegistration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

interface ModuleSystem {
  import: (specifier: string, parentURL: string, attrs: Record<string, unknown>) => Promise<unknown>
  importError: (id: string) => Error | undefined
}

/** One slot registration the plugin submitted. */
interface Registration {
  options: { name: string; key?: string; id?: string; order?: number; label?: unknown }
  component: (props: Record<string, unknown>) => unknown
}

const requests: string[] = []
const SESSION = 'session-1'
const DIRECTORY = '/tmp/工作区'

Object.assign(globalThis, {
  fetch: async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    requests.push(url)
    const body = url.includes('/api/library')
      ? {
          dir: DIRECTORY,
          library: true,
          scope: 'library',
          stats: {
            dir: DIRECTORY,
            documents: 1,
            chunks: 3,
            embedded: 3,
            configuredModel: 'bge-m3:latest',
            embeddingModel: 'bge-m3:latest',
            embeddingReady: true,
            embedding: { running: false, done: 3, total: 3, error: null },
            file: `${DIRECTORY}/.cyberself/kb.db`,
            bytes: 2048,
            updatedAt: 1_700_000_000_000,
          },
          documents: [],
        }
      : url.includes('/api/settings')
        ? {
            embedding: {
              baseURL: 'http://127.0.0.1:11434',
              model: 'bge-m3:latest',
              timeoutMs: 30_000,
              batchSize: 8,
              maxChars: 2000,
              dedupeNumbers: true,
              reachable: true,
              note: null,
              installed: ['bge-m3:latest'],
            },
            workspaces: [{ id: 'w', path: DIRECTORY, title: '工作区', library: true, scope: 'library' }],
            file: '/tmp/home/cyberself/settings.json',
          }
        : url.includes('/api/storage')
          ? {
              root: '.cyberself',
              settingsFile: '/tmp/home/cyberself/settings.json',
              libraries: [{
                dir: DIRECTORY,
                title: '工作区',
                scope: 'library',
                documents: 1,
                chunks: 3,
                embedded: 3,
                bytes: 2048,
                file: `${DIRECTORY}/.cyberself/kb.db`,
                updatedAt: 1_700_000_000_000,
              }],
              totals: { libraries: 1, documents: 1, chunks: 3, embedded: 3, bytes: 2048 },
            }
          : { library: false, dir: DIRECTORY, stats: null, documents: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  },
})

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
}

test('the client bundle materializes through the web module system', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    url: 'http://127.0.0.1:63039/',
  })
  const browser = dom.window as unknown as Window & typeof globalThis
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Element: browser.Element,
    SVGElement: browser.SVGElement,
    localStorage: browser.localStorage,
  })
  Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true })

  const captured: BundleRegistration[] = []
  Object.assign(globalThis, {
    window: Object.assign(browser, {
      __ModuleLoader__: { load: (registration: BundleRegistration): void => { captured.push(registration) } },
    }),
  })

  runInThisContext(readFileSync(CLIENT_MODULES, 'utf8'))
  const shell = captured[0]?.factory(() => { throw new Error('模块系统自身没有外部依赖') }) as {
    createClientModuleSystem: (
      target: unknown,
      bootstrap: { id: string; exports: Record<string, unknown> },
      options: {
        boot: unknown
        staticModules: Record<string, unknown>
        loadBundle: (url: string) => Promise<void>
      },
    ) => ModuleSystem
    parseDshClient: (pkg: string, value: unknown) => unknown
  }
  assert.ok(shell !== undefined)

  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { dsh?: { client?: unknown } }
  assert.notEqual(shell.parseDshClient('cyberself', manifest.dsh?.client), undefined)

  const url = 'plugin/cyberself/client.js'
  const boot = {
    rev: 'test',
    release: { version: '2.0.21-next', commit: 'test' },
    entries: [{ id: 'cyberself', url, rev: 'abc', inject: ['react'], external: [] }],
    batches: [{ phase: 'application', url, rev: 'abc', entries: ['cyberself'] }],
  }

  const target = {
    mode: 'queue' as 'queue' | 'live',
    pendingQueue: [] as BundleRegistration[],
    load(registration: BundleRegistration): void { target.pendingQueue.push(registration) },
    create(): never { throw new Error('本测试直接持有模块系统') },
  }

  const modules = shell.createClientModuleSystem(
    target,
    { id: '@deepseek-ai/dsh-client-modules', exports: shell as unknown as Record<string, unknown> },
    {
      boot,
      staticModules: { react, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives },
      loadBundle: async () => {
        Object.assign(globalThis, {
          window: Object.assign(browser, { __ModuleLoader__: target }),
        })
        runInThisContext(readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8'))
      },
    },
  )

  const client = await modules.import('cyberself', '', {}) as Record<string, unknown>
  assert.equal(modules.importError('cyberself'), undefined)
  assert.deepEqual(client.inject, ['slots', 'sidebarRight', 'sidebarRightTabs', 'workspaces'])
  assert.equal(client.name, 'cyberself')

  const registrations: Registration[] = []
  const tabs: { id: string; kind: string; title: () => string }[] = []
  const opened: string[] = []
  const context = {
    effect: (work: () => unknown): unknown => work(),
    workspaces: {
      list: {
        getSnapshot: () => ({
          items: [{ workspaceId: 'w', path: DIRECTORY, title: '工作区', sessionIds: [SESSION], createdAt: '', updatedAt: '' }],
        }),
        subscribe: () => () => {},
      },
    },
    sidebarRight: {
      openTab: (kind: string): void => { opened.push(kind) },
    },
    sidebarRightTabs: {
      register: (definition: { id: string; kind: string; title: () => string }): (() => void) => {
        tabs.push(definition)
        return () => {}
      },
    },
    slots: {
      inject: (_name: string, work: () => unknown): unknown => work(),
      register: (options: Registration['options'], component: Registration['component']): (() => void) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  const apply = client.apply as (ctx: unknown) => void
  apply(context)

  assert.deepEqual(tabs.map((tab) => [tab.id, tab.kind, tab.title()]), [['cyberself', 'cyberself.library', '资料库']])

  const names = registrations.map((entry) => entry.options.name)
  assert.deepEqual(names, [
    'sidebar.right.pane.tab',
    'conversation.session.header.utilities',
    'settings.section',
  ])
  assert.equal(registrations[0]?.options.key, 'cyberself')
  const directory = registrations.at(-1)
  assert.ok(directory !== undefined)
  assert.equal(directory.options.id, 'cyberself')
  assert.equal(directory.options.label, '资料库')

  const tab = registrations[0]
  assert.ok(tab !== undefined)
  const host = browser.document.getElementById('host')
  assert.ok(host !== null)
  const root = createRoot(host)
  root.render(createElement(tab.component as never, { sessionId: SESSION }))
  await settle()

  const text = host.textContent ?? ''
  assert.match(text, /1 份 · 3 段 · 已向量化 3 段/u)
  assert.match(text, /占用 2 KB/u)
  assert.match(text, /仅资料库/u)
  assert.match(text, /允许补充/u)
  assert.match(text, /还没有资料/u)
  assert.match(text, /清空资料/u)
  assert.match(text, /kb\.db/u)
  assert.ok(
    requests.some((request) => request.includes('/cyberself/api/library')),
    `没有发出资料库请求，实际请求：${JSON.stringify(requests)}`,
  )
  root.unmount()

  const toggle = registrations[1]
  assert.ok(toggle !== undefined)
  const bar = browser.document.createElement('div')
  browser.document.body.append(bar)
  const barRoot = createRoot(bar)
  barRoot.render(createElement(toggle.component as never, {}))
  await settle()
  const entry = [...bar.querySelectorAll('button')].find((button) => (button.title ?? '') === '资料库')
  assert.ok(entry !== undefined, `没有资料库入口，实际文本：${bar.textContent ?? ''}`)
  entry.click()
  assert.deepEqual(opened, ['cyberself.library'])
  barRoot.unmount()

  const settings = registrations[2]
  assert.ok(settings !== undefined)
  const page = browser.document.createElement('div')
  browser.document.body.append(page)
  const pageRoot = createRoot(page)
  pageRoot.render(createElement(settings.component as never, { close: () => {} }))
  await settle()
  const pageText = page.textContent ?? ''
  assert.match(pageText, /嵌入服务/u)
  assert.match(pageText, /存储/u)
  assert.match(pageText, /1 个资料库/u)
  assert.match(pageText, /合计占用/u)
  assert.match(pageText, /\.cyberself\/kb\.db/u)
  assert.match(pageText, /清空资料/u)
  assert.match(pageText, /删除数据/u)
  assert.ok(
    requests.some((request) => request.includes('/cyberself/api/storage')),
    `没有请求存储信息，实际请求：${JSON.stringify(requests)}`,
  )
  pageRoot.unmount()

  dom.window.close()
})
