/**
 * Text normalization and sentence splitting, the parts every parser and the
 * deduplication step rely on.
 * @module cyberself/test/text
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collapseWhitespace,
  joinParagraphs,
  normalizeForHash,
  sha256Text,
  splitSentences,
} from '../src/host/kb/text.ts'

test('collapseWhitespace folds runs of whitespace into single spaces', () => {
  assert.equal(collapseWhitespace('  第一行\n\n\t第二行  '), '第一行 第二行')
  assert.equal(collapseWhitespace(''), '')
})

test('normalizeForHash folds full-width forms and lowercases latin text', () => {
  assert.equal(normalizeForHash('ＡＢＣ　１２３'), 'abc 123')
  assert.equal(normalizeForHash('总  则\n\n第一条'), '总 则 第一条')
  assert.equal(normalizeForHash('ABC'), normalizeForHash('abc'))
})

test('sha256Text is stable and distinguishes different text', () => {
  assert.equal(sha256Text('资料'), sha256Text('资料'))
  assert.notEqual(sha256Text('资料'), sha256Text('资料库'))
  assert.match(sha256Text('资料'), /^[0-9a-f]{64}$/)
})

test('splitSentences cuts after Chinese and latin sentence endings', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？'])
  assert.deepEqual(splitSentences('One. Two? Three'), ['One. Two?', 'Three'])
  assert.deepEqual(splitSentences('两条并列；第三条'), ['两条并列；', '第三条'])
  assert.deepEqual(splitSentences('没有标点的一段'), ['没有标点的一段'])
})

test('joinParagraphs puts one line break between paragraphs and drops blanks', () => {
  assert.equal(joinParagraphs(['第一段', '第二段']), '第一段\n第二段')
  assert.equal(joinParagraphs(['第一段', '   ', '第二段']), '第一段\n第二段')
})
