/**
 * HTML: take the page's main content area, drop chrome, and emit headings with
 * the paragraphs that follow them.
 *
 * The content area is walked once, node by node: a block element is emitted and
 * its subtree is left alone, so a paragraph inside a list item is not repeated.
 * A table is emitted as one line per row.
 * @module cyberself/parse/html
 */
import { load, type Cheerio, type CheerioAPI } from 'cheerio'
import { isTag, type AnyNode, type ParentNode } from 'domhandler'
import type { ParsedBlock } from './types.ts'

const DROPPED = 'script, style, noscript, template, nav, header, footer, aside, form, iframe, svg, canvas, button'
const CONTENT_SELECTORS = ['article', 'main', '[role=main]', '.markdown-body', '#content', '.content']
const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre', 'dt', 'dd'])

/** Title and blocks of one HTML document. */
export interface ParsedHtml {
  title: string
  blocks: ParsedBlock[]
}

function textOf(raw: string): string {
  return raw.replace(/[ \t\u00A0]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
}

/** One line per table row, cells separated by a pipe, so a row stays a unit. */
function tableRows($: CheerioAPI, table: AnyNode): string[] {
  const rows: string[] = []
  for (const row of $(table).find('tr').toArray()) {
    const cells: string[] = []
    for (const cell of $(row).children('th, td').toArray()) {
      const text = textOf($(cell).text())
      if (text !== '') cells.push(text)
    }
    if (cells.length > 0) rows.push(cells.join(' | '))
  }
  return rows
}

/** Parse an HTML page into blocks, preferring a semantic content container. */
export function parseHtml(html: string): ParsedHtml {
  const $ = load(html)
  $(DROPPED).remove()

  let root: Cheerio<AnyNode> = $('body')
  for (const selector of CONTENT_SELECTORS) {
    const candidate = $(selector).first()
    if (candidate.length > 0 && candidate.text().trim().length > 200) {
      root = candidate
      break
    }
  }

  const title = ($('title').first().text() || $('h1').first().text()).replace(/\s+/gu, ' ').trim()
  const blocks: ParsedBlock[] = []
  let heading: string | null = null

  const walk = (parent: ParentNode): void => {
    for (const node of parent.children) {
      if (!isTag(node)) continue
      const tag = node.tagName.toLowerCase()
      if (tag === 'table') {
        for (const row of tableRows($, node)) blocks.push({ text: row, page: null, heading })
        continue
      }
      if (!BLOCK_TAGS.has(tag)) {
        walk(node)
        continue
      }
      const text = tag === 'pre' ? $(node).text().trim() : textOf($(node).text())
      if (text === '') {
        walk(node)
        continue
      }
      if (/^h[1-6]$/u.test(tag)) heading = text
      blocks.push({ text, page: null, heading })
    }
  }

  const start = root[0]
  if (start !== undefined) {
    if (isTag(start)) walk(start)
    else if (start.type === 'root') walk(start)
  }
  return { title, blocks }
}
