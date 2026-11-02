/**
 * Spreadsheets: one block per non-empty row, with the sheet name as heading, so
 * chunking can pack rows and each citation still names its sheet.
 * @module cyberself/parse/spreadsheet
 */
import * as XLSX from 'xlsx'
import type { ParsedBlock } from './types.ts'

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\s+/gu, ' ').trim()
}

/**
 * Parse an XLSX/XLS/CSV workbook into rows.
 *
 * A CSV arrives as text because the bytes are UTF-8 encoded by whoever wrote
 * the file, and the workbook reader would otherwise decode them as a binary
 * code page and mangle every non-ASCII character.
 */
export function parseSpreadsheet(input: Uint8Array | string): ParsedBlock[] {
  const workbook = typeof input === 'string'
    ? XLSX.read(input.replace(/^\uFEFF/u, ''), { type: 'string' })
    : XLSX.read(input, { type: 'array' })
  const blocks: ParsedBlock[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (sheet === undefined) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false })
    for (const row of rows) {
      const cells = row.map(cellText).filter((cell) => cell !== '')
      if (cells.length === 0) continue
      blocks.push({ text: cells.join(' | '), page: null, heading: sheetName })
    }
  }
  return blocks
}
