/**
 * The per-session prompt contribution: it appears for sessions working inside a
 * library, disappears elsewhere, and repeats only when the library changed.
 * @module cyberself/test/policy
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { registerLibraryPolicy } from '../src/host/policy.ts'
import type { CyberSelf } from '../src/host/service.ts'
import { makeService, tempDir } from './helpers.ts'
import type { ServiceDeps } from '../src/host/service.ts'

interface Step {
  agent: { session: { header: { id: string; cwd?: string } } }
  signal: AbortSignal
}

type Handler = (step: Step, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>

const entered: PreStepDecision = { kind: 'enter', messages: [] }

const dir = tempDir('policy')
const other = tempDir('policy-other')
const service: CyberSelf = makeService(dir)

const handlers: Handler[] = []
const context = {
  on: (_event: string, handler: Handler): void => {
    handlers.push(handler)
  },
} as unknown as Context

registerLibraryPolicy(context, service)

function step(cwd: string, id = 'session-a'): Step {
  return { agent: { session: { header: { id, cwd } } }, signal: new AbortController().signal }
}

async function next(): Promise<PreStepDecision> {
  return entered
}

function injected(decision: PreStepDecision): string[] {
  if (decision.kind === 'reject') return []
  return decision.messages.flatMap((message) => message.content.flatMap((block) => (
    block.type === 'text' ? [block.text] : []
  )))
}

const run = handlers[0]
assert.ok(run !== undefined, '策略应当注册一个 pre-step 处理器')

test('a library workspace gains the answering rules', async () => {
  service.mark(dir, true)
  const decision = await run(step(dir), next)
  const texts = injected(decision)
  assert.equal(texts.length, 1)
  const text = texts[0] ?? ''
  assert.match(text, /知识库|资料库/u)
  assert.match(text, /knowledge_search/u)
  assert.match(text, /资料库现状：0 份资料/u)
  if (decision.kind === 'enter') {
    const source = decision.messages[0]?.source
    assert.equal(source?.kind, 'cyberself')
  }
})

test('the same session is not told twice while the library is unchanged', async () => {
  const decision = await run(step(dir), next)
  assert.deepEqual(injected(decision), [])
})

test('another session is told, and a changed library refreshes the count', async () => {
  writeFileSync(join(dir, '制度.md'), '# 制度\n\n## 报销\n\n住宿费每晚不超过六百元。\n', 'utf8')
  await service.importFromPath(dir, join(dir, '制度.md'))

  const fresh = await run(step(dir, 'session-b'), next)
  assert.equal(injected(fresh).length, 1)
  assert.match(injected(fresh)[0] ?? '', /资料库现状：1 份资料/u)

  const stale = await run(step(dir, 'session-a'), next)
  assert.equal(injected(stale).length, 1)
  assert.match(injected(stale)[0] ?? '', /资料库现状：1 份资料/u)
})

test('a workspace that is not a library gets nothing', async () => {
  const decision = await run(step(other), next)
  assert.deepEqual(injected(decision), [])
})

test('switching the answer scope tells the same session again', async () => {
  service.mark(dir, true, 'open')
  const opened = await run(step(dir), next)
  const openText = injected(opened)[0] ?? ''
  assert.match(openText, /资料库外/u)
  assert.doesNotMatch(openText, /不要用其他工具/u)

  service.mark(dir, true, 'library')
  const narrowed = await run(step(dir), next)
  const libraryText = injected(narrowed)[0] ?? ''
  assert.match(libraryText, /不要用其他工具/u)
  assert.doesNotMatch(libraryText, /资料库外/u)
})

test('a rejected step stays rejected', async () => {
  const rejected: PreStepDecision = { kind: 'reject' }
  const decision = await run(step(dir), async () => rejected)
  assert.equal(decision.kind, 'reject')
})
