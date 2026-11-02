/**
 * Embedding pipeline: fills in vectors for chunks that do not have one yet.
 * Chunks are written first and embedded afterwards, so a stopped server never
 * leaves a half-imported document — and a re-run picks up where it stopped.
 *
 * The text handed to the model is not always the stored text: table rows whose
 * numbers differ describe the same thing, and a long chunk can be cut to its
 * head. Both choices only change what the vector is built from; the stored text
 * keeps every word for keyword search.
 * @module cyberself/embed/pipeline
 */
import { withTransaction, type KbHandle } from '../kb/db.ts'
import {
  chunkTexts,
  pendingChunkIds,
  recordEmbeddingModel,
  setChunkEmbedding,
} from '../kb/store.ts'
import type { OllamaEmbedder } from './ollama.ts'

/** Progress of one embedding run. */
export interface EmbedProgress {
  done: number
  total: number
}

/** One chunk waiting for a vector. */
export interface EmbedItem {
  id: string
  text: string
  /** Document kind, which decides whether numbers count as meaning. */
  kind: string
}

/** Options for {@link embedChunks} and {@link embedPending}. */
export interface EmbedOptions {
  /** Chunks handled per round; each round reads its own texts. */
  batchSize: number
  /** Characters handed to the model per chunk; 0 keeps the whole chunk. */
  maxChars?: number
  /** Table rows that differ only in numbers share one vector. */
  dedupeNumbers?: boolean
  /** Vectors already computed, so a repeated key never reaches the model twice. */
  cache?: Map<string, Float32Array>
  signal?: AbortSignal | undefined
  onProgress?: (progress: EmbedProgress) => void
}

/** Kinds whose chunks are table rows. */
const SPREADSHEET_KINDS = new Set(['xlsx', 'xls', 'csv'])

/** How many reused vectors one run keeps in memory. */
const CACHE_LIMIT = 4096

/** How many vectors one call produced, and how wide they are. */
export interface EmbedResult {
  embedded: number
  dimensions: number
}

/**
 * Text handed to the model: numbers of a table row become `#`, then the text is
 * cut to `maxChars`. A chunk of prose keeps its numbers — there they are meaning.
 */
export function embeddingKey(text: string, kind: string, options: EmbedOptions): string {
  const masked = options.dedupeNumbers === true && SPREADSHEET_KINDS.has(kind)
    ? text.replace(/\d+/gu, '#')
    : text
  const limit = options.maxChars ?? 0
  return limit > 0 && masked.length > limit ? masked.slice(0, limit) : masked
}

/**
 * Embed the given chunks, sending one text per distinct key and writing that
 * one vector to every chunk that shares the key.
 */
export async function embedChunks(
  handle: KbHandle,
  embedder: OllamaEmbedder,
  items: readonly EmbedItem[],
  options: EmbedOptions,
): Promise<EmbedResult> {
  if (items.length === 0) return { embedded: 0, dimensions: 0 }

  const keys: string[] = []
  const slots = new Map<string, number>()
  const slotOf: number[] = []
  const known: (Float32Array | undefined)[] = []
  for (const item of items) {
    const key = embeddingKey(item.text, item.kind, options)
    let slot = slots.get(key)
    if (slot === undefined) {
      slot = keys.length
      slots.set(key, slot)
      keys.push(key)
      known.push(options.cache?.get(key))
    }
    slotOf.push(slot)
  }

  const missing = keys.filter((_, index) => known[index] === undefined)
  const fresh = missing.length === 0 ? [] : await embedder.embed(missing, options.signal)
  if (fresh.length !== missing.length) {
    throw new Error(`嵌入结果应有 ${missing.length} 条向量，实际 ${fresh.length} 条`)
  }
  let next = 0
  for (let index = 0; index < keys.length; index += 1) {
    if (known[index] !== undefined) continue
    const vector = fresh[next]
    next += 1
    if (vector === undefined) throw new Error(`嵌入结果缺少第 ${index + 1} 条向量`)
    known[index] = vector
    const key = keys[index]
    if (options.cache !== undefined && key !== undefined && options.cache.size < CACHE_LIMIT) {
      options.cache.set(key, vector)
    }
  }

  withTransaction(handle, () => {
    items.forEach((item, index) => {
      const vector = known[slotOf[index] ?? -1]
      if (vector === undefined) throw new Error(`嵌入结果缺少第 ${index + 1} 条向量`)
      setChunkEmbedding(handle, item.id, vector)
    })
  })
  return { embedded: items.length, dimensions: known[0]?.length ?? 0 }
}

/**
 * Embed every pending chunk, returning how many were written. Throws when the
 * embedding server fails; vectors already written stay in place.
 */
export async function embedPending(
  handle: KbHandle,
  embedder: OllamaEmbedder,
  options: EmbedOptions,
): Promise<number> {
  const batchSize = Math.max(1, options.batchSize)
  const pending = pendingChunkIds(handle)
  const total = pending.length
  let done = 0
  let dimensions = 0
  let cache: Map<string, Float32Array> | undefined
  let cachedDocument: string | null = null

  for (let start = 0; start < pending.length; start += batchSize) {
    if (options.signal?.aborted === true) break
    const slice = pending.slice(start, start + batchSize)
    const documentId = slice[0]?.documentId ?? null
    if (documentId !== cachedDocument) {
      cachedDocument = documentId
      cache = undefined
    }
    const texts = chunkTexts(handle, slice.map((chunk) => chunk.id))
    const items: EmbedItem[] = []
    for (const chunk of slice) {
      const text = texts.get(chunk.id)
      if (text === undefined) continue
      if (cache === undefined && options.dedupeNumbers === true && SPREADSHEET_KINDS.has(chunk.kind)) {
        cache = new Map()
      }
      items.push({ id: chunk.id, text, kind: chunk.kind })
    }
    const result = await embedChunks(handle, embedder, items, {
      ...options,
      ...(cache === undefined ? {} : { cache }),
    })
    if (result.dimensions > 0) dimensions = result.dimensions
    done += result.embedded
    options.onProgress?.({ done, total })
  }

  if (done > 0) recordEmbeddingModel(handle, embedder.model, dimensions)
  return done
}
