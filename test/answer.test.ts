/**
 * End-to-end answer generation: a real document in a real library, a real
 * embedding model and a real chat model.
 * @module cyberself/test/answer
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { CyberSelfError } from '../src/shared/protocol.ts'
import { CyberSelf } from '../src/host/service.ts'
import { GatewayModelStream } from './gateway.ts'
import { makeConfig, makeService, tempDir } from './helpers.ts'

const DOCUMENT = `# 差旅费管理办法

## 第一章 总则

第一条 为了规范差旅费管理，制定本办法。出差人员应当事先填写出差申请单，经部门负责人批准后执行。

## 第二章 报销标准

第二条 住宿费按城市分级报销：一类城市每晚不超过六百元，二类城市每晚不超过四百元。

第三条 市内交通费凭票据实报销，单次不超过一百元。

第四条 伙食补助按出差自然日计算，每人每日一百元。
`

let directory = ''
let service: CyberSelf

before(async () => {
  directory = tempDir('answer')
  await writeFile(join(directory, '差旅费管理办法.md'), DOCUMENT, 'utf8')
  service = makeService(directory, makeConfig({ answer: { temperature: 0.2, maxTokens: 1024 } }), {
    llm: new GatewayModelStream(),
    route: () => ({ provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash' }),
  })
  service.mark(directory, true)
  await service.importFromPath(directory, join(directory, '差旅费管理办法.md'))
})

after(() => {
  service.dispose()
})

test('an answer cites the evidence it was given', async () => {
  const streamed: string[] = []
  const answer = await service.ask({
    dir: directory,
    question: '一类城市住宿费每晚最多报销多少？',
    signal: new AbortController().signal,
    onToken: (text) => streamed.push(text),
  })
  assert.ok(answer.citations.length > 0)
  assert.ok(answer.answer.includes('600') || answer.answer.includes('六百'))
  assert.equal(answer.warning, null)
  assert.equal(answer.model, 'magpie/opencode-go/deepseek-v4.1-flash')
  assert.ok(streamed.join('').length > 0)
  for (const index of answer.answer.matchAll(/[[【](\d{1,3})[\]】]/gu)) {
    const value = Number(index[1])
    assert.ok(value >= 1 && value <= answer.citations.length, `引用编号 ${value} 超出范围`)
  }
})

test('a question outside the library is refused before any model call', async () => {
  await assert.rejects(
    () => service.ask({
      dir: directory,
      question: '这台服务器的显卡型号是什么？',
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof CyberSelfError && error.status === 422,
  )
})
