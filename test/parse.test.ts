/**
 * Parsers: Markdown headings, HTML chrome removal, plain paragraphs, CSV sheets,
 * PDF pages, and the explicit refusals for unsupported and empty files.
 * @module cyberself/test/parse
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { extractText, renderPageAsImage } from 'unpdf'
import type { ParseOptions } from '../src/host/parse/types.ts'
import { isSupported, parseFile, SUPPORTED_EXTENSIONS } from '../src/host/parse/index.ts'
import { CyberSelfError } from '../src/shared/protocol.ts'

const OPTIONS: ParseOptions = {
  ocr: true,
  pdfDpi: 160,
  maxPages: 40,
  concurrency: 3,
  vision: null,
}

/** A text-layer PDF made from three short paragraphs. */
const PDF = readFileSync(join(import.meta.dirname, 'fixtures', 'travel.pdf'))

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

test('supported extensions are recognised with or without upper case', () => {
  assert.deepEqual([...SUPPORTED_EXTENSIONS].sort(), [
    'csv', 'docx', 'gif', 'htm', 'html', 'jpeg', 'jpg', 'log', 'markdown',
    'md', 'pdf', 'png', 'text', 'txt', 'webp', 'xls', 'xlsx',
  ])
  assert.equal(isSupported('笔记.md'), true)
  assert.equal(isSupported('表格.CSV'), true)
  assert.equal(isSupported('扫描件.pdf'), true)
  assert.equal(isSupported('图片.png'), true)
  assert.equal(isSupported('程序.exe'), false)
  assert.equal(isSupported('没有扩展名'), false)
})

test('markdown keeps the heading each paragraph sits under', async () => {
  const document = await parseFile('章节.md', bytesOf([
    '# 第一章 总则',
    '',
    '第一条 为了规范管理，制定本办法。',
    '',
    '## 第二节 适用范围',
    '',
    '本办法适用于全部部门。',
  ].join('\n')), OPTIONS)

  assert.equal(document.kind, 'markdown')
  assert.equal(document.title, '章节')
  assert.deepEqual(document.blocks.map((block) => block.heading), ['第一章 总则', '第二节 适用范围'])
  assert.match(document.blocks[0]?.text ?? '', /第一条/u)
})

test('markdown keeps fenced code in one block', async () => {
  const document = await parseFile('代码.md', bytesOf('## 示例\n\n```ts\nconst value = 1\n\nconst other = 2\n```\n'), OPTIONS)
  const fenced = document.blocks.find((block) => block.text.includes('const value'))
  assert.ok(fenced !== undefined)
  assert.match(fenced.text, /const other = 2/u)
})

test('html drops navigation and keeps article paragraphs with headings', async () => {
  const html = `<!doctype html><html><head><title>条文全文</title></head><body>
    <nav><a href="/">首页</a></nav>
    <article>
      <h1>第一章 总则</h1>
      <p>第一条 本规定用于测试正文提取。</p>
      <p>第二条 导航与页脚不应出现在结果里。</p>
    </article>
    <footer>版权所有</footer>
  </body></html>`
  const document = await parseFile('page.html', bytesOf(html), OPTIONS)
  assert.equal(document.kind, 'html')
  assert.equal(document.title, '条文全文')
  const text = document.blocks.map((block) => block.text).join('\n')
  assert.match(text, /第一条 本规定/u)
  assert.doesNotMatch(text, /首页/u)
  assert.doesNotMatch(text, /版权所有/u)
})

test('html keeps a nested paragraph inside its list item', async () => {
  const html = '<html><body><article><ul><li><p>第一条 列表里的段落。</p></li></ul><p>第二条 普通段落。</p></article></body></html>'
  const document = await parseFile('list.html', bytesOf(html), OPTIONS)
  assert.deepEqual(document.blocks.map((block) => block.text), ['第一条 列表里的段落。', '第二条 普通段落。'])
})

test('html emits one block per table row with the cells kept apart', async () => {
  const html = `<html><body><article>
    <h2>入口地址</h2>
    <table>
      <tr><th>名称</th><th>地址</th></tr>
      <tr><td>运维</td><td>/ops</td></tr>
      <tr><td>监控</td><td>/monitor</td></tr>
    </table>
  </article></body></html>`
  const document = await parseFile('table.html', bytesOf(html), OPTIONS)
  assert.deepEqual(document.blocks.map((block) => block.text), ['入口地址', '名称 | 地址', '运维 | /ops', '监控 | /monitor'])
  assert.equal(document.blocks[1]?.heading, '入口地址')
})

test('a text file saved as GBK is decoded instead of turned into mojibake', async () => {
  const gbk = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xb2, 0xbf, 0xa1, 0xa3])
  const document = await parseFile('旧文件.txt', gbk, OPTIONS)
  assert.equal(document.blocks[0]?.text, '第一部。')
})

test('plain text becomes one block per blank-line separated paragraph', async () => {
  const document = await parseFile('记录.txt', bytesOf('第一段内容。\n\n第二段内容。\n'), OPTIONS)
  assert.equal(document.kind, 'text')
  assert.equal(document.blocks.length, 2)
  assert.equal(document.blocks[0]?.text, '第一段内容。')
})

test('csv rows become blocks named after the sheet', async () => {
  const csv = '名称,数量\n螺丝,12\n垫片,30\n'
  const document = await parseFile('库存.csv', bytesOf(csv), OPTIONS)
  assert.equal(document.kind, 'csv')
  assert.ok(document.blocks.length >= 2)
  assert.match(document.blocks[0]?.text ?? '', /名称 \| 数量/u)
  assert.match(document.blocks[1]?.text ?? '', /螺丝 \| 12/u)
})

test('pdf pages keep their page numbers and text', async () => {
  const document = await parseFile('差旅.pdf', PDF, OPTIONS)
  assert.equal(document.kind, 'pdf')
  assert.ok(document.blocks.length >= 1)
  assert.deepEqual(document.blocks.map((block) => block.page), document.blocks.map((_, index) => index + 1))
  assert.match(document.blocks.map((block) => block.text).join('\n'), /travel expenses/u)
})

test('a page renders after the text pass has taken the bytes', async () => {
  await extractText(new Uint8Array(PDF), { mergePages: false })
  const image = await renderPageAsImage(new Uint8Array(PDF), 1, {
    canvasImport: () => import('@napi-rs/canvas'),
    scale: 1,
  })
  const header = new Uint8Array(image, 0, 8)
  assert.deepEqual([...header], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

test('an unsupported extension is refused with 415', async () => {
  await assert.rejects(
    () => parseFile('程序.exe', bytesOf('MZ'), OPTIONS),
    (error: unknown) => error instanceof CyberSelfError && error.status === 415,
  )
})

test('a document without text is refused with 422', async () => {
  await assert.rejects(
    () => parseFile('空白.md', bytesOf('   \n\n  '), OPTIONS),
    (error: unknown) => error instanceof CyberSelfError && error.status === 422,
  )
})

test('an image without a vision model is refused with 422', async () => {
  await assert.rejects(
    () => parseFile('图片.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), OPTIONS),
    (error: unknown) => error instanceof CyberSelfError && error.status === 422 && /视觉模型/u.test(error.message),
  )
})
