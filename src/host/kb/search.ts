/**
 * Retrieval: a vector scan over stored chunk embeddings fused with an FTS5
 * trigram keyword search through reciprocal rank fusion. Both halves are
 * optional — a knowledge base without vectors still answers by keyword.
 * @module cyberself/kb/search
 */
import type { Citation } from '../../shared/protocol.ts'
import type { KbHandle } from './db.ts'
import { decodeVector } from './db.ts'
import type { ChunkRecord } from './store.ts'

/** How many candidates each half contributes to the fusion. */
const CANDIDATES = 80

/** Rank fusion damping; the usual value from the original RRF paper. */
const RRF_K = 60

/** One fused retrieval candidate. */
export interface RankedChunk {
  chunk: ChunkRecord
  score: number
  fromVector: boolean
  fromKeyword: boolean
}

/** Retrieval output with the two halves' candidate counts. */
export interface RetrievalResult {
  hits: RankedChunk[]
  vectorHits: number
  keywordHits: number
}

/** Retrieval limits coming from the plugin config. */
export interface RetrievalLimits {
  topK: number
  perDocument: number
  /** Cosine floor a vector candidate must reach; unrelated text scores far lower. */
  minScore: number
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

/**
 * Terms handed to the trigram index: latin words of two characters or more,
 * and every three-character window of a Han run. Trigram indexes cannot match
 * shorter text, so a two-character run is left out instead of widening the
 * query into noise.
 */
export function keywordTerms(text: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  const add = (term: string): void => {
    const key = term.toLowerCase()
    if (key === '' || seen.has(key)) return
    seen.add(key)
    terms.push(key)
  }
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_+-]*/gu)) {
    if (match[0].length >= 2) add(match[0])
  }
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    const run = match[0]
    for (let offset = 0; offset + 3 <= run.length; offset += 1) add(run.slice(offset, offset + 3))
  }
  return terms.slice(0, 24)
}

/** Build the FTS5 MATCH expression for a query, or null when nothing is indexable. */
export function ftsExpression(text: string): string | null {
  const terms = keywordTerms(text)
  if (terms.length === 0) return null
  return terms.map((term) => `"${term.replace(/"/gu, '""')}"`).join(' OR ')
}

function scanVectors(handle: KbHandle, query: Float32Array, floor: number): { id: string; score: number }[] {
  const statement = handle.db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL')
  const scored: { id: string; score: number }[] = []
  for (const row of statement.iterate() as Iterable<{ id: string; embedding: Uint8Array }>) {
    const score = cosine(query, decodeVector(row.embedding))
    if (score >= floor) scored.push({ id: row.id, score })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, CANDIDATES)
}

function scanKeywords(handle: KbHandle, text: string): { id: string; score: number }[] {
  const expression = ftsExpression(text)
  if (expression === null) return []
  const rows = handle.db.prepare(`
    SELECT chunks_fts.rowid AS rowid, bm25(chunks_fts) AS rank
    FROM chunks_fts
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(expression, CANDIDATES) as unknown as { rowid: number; rank: number }[]
  const lookup = handle.db.prepare('SELECT id FROM chunks WHERE rowid = ?')
  const scored: { id: string; score: number }[] = []
  for (const row of rows) {
    const found = lookup.get(row.rowid) as { id: string } | undefined
    if (found === undefined) continue
    scored.push({ id: found.id, score: -row.rank })
  }
  return scored
}

function loadChunk(handle: KbHandle, id: string): ChunkRecord | null {
  const row = handle.db.prepare(`
    SELECT c.id, c.document_id, d.title, d.path, c.ordinal, c.text, c.page, c.heading, c.embedding
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.id = ?
  `).get(id) as unknown as {
    id: string
    document_id: string
    title: string
    path: string
    ordinal: number
    text: string
    page: number | null
    heading: string | null
    embedding: Uint8Array | null
  } | undefined
  if (row === undefined) return null
  return {
    id: row.id,
    documentId: row.document_id,
    title: row.title,
    path: row.path,
    ordinal: row.ordinal,
    text: row.text,
    page: row.page,
    heading: row.heading,
    embedding: row.embedding === null ? null : decodeVector(row.embedding),
  }
}

/**
 * Fuse both halves and apply the per-document cap, so one long document cannot
 * fill every slot. `query` may carry a null vector: keyword search still runs.
 */
export function retrieve(
  handle: KbHandle,
  input: { text: string; vector: Float32Array | null },
  limits: RetrievalLimits,
): RetrievalResult {
  const vectorList = input.vector === null ? [] : scanVectors(handle, input.vector, limits.minScore)
  const keywordList = scanKeywords(handle, input.text)
  const fused = new Map<string, { score: number; fromVector: boolean; fromKeyword: boolean }>()
  const merge = (list: readonly { id: string }[], fromVector: boolean): void => {
    list.forEach((item, rank) => {
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = fused.get(item.id)
      if (existing === undefined) {
        fused.set(item.id, { score: contribution, fromVector, fromKeyword: !fromVector })
        return
      }
      existing.score += contribution
      existing.fromVector ||= fromVector
      existing.fromKeyword ||= !fromVector
    })
  }
  merge(vectorList, true)
  merge(keywordList, false)

  const ordered = [...fused.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((left, right) => right.score - left.score)

  const perDocument = new Map<string, number>()
  const hits: RankedChunk[] = []
  for (const entry of ordered) {
    if (hits.length >= limits.topK) break
    const chunk = loadChunk(handle, entry.id)
    if (chunk === null) continue
    const used = perDocument.get(chunk.documentId) ?? 0
    if (used >= limits.perDocument) continue
    perDocument.set(chunk.documentId, used + 1)
    hits.push({ chunk, score: entry.score, fromVector: entry.fromVector, fromKeyword: entry.fromKeyword })
  }
  return { hits, vectorHits: vectorList.length, keywordHits: keywordList.length }
}

/** Number the retrieved chunks in ranking order, which is what the prompt cites. */
export function materializeCitations(hits: readonly RankedChunk[]): Citation[] {
  return hits.map((hit, index) => ({
    index: index + 1,
    chunkId: hit.chunk.id,
    documentId: hit.chunk.documentId,
    title: hit.chunk.title,
    path: hit.chunk.path,
    page: hit.chunk.page,
    heading: hit.chunk.heading,
    text: hit.chunk.text,
    score: Math.round(hit.score * 1000) / 1000,
  }))
}
