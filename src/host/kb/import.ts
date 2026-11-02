/**
 * Import pipeline: hash the file, parse it, chunk it, drop passages that are
 * already stored, and write the document. Vectors are filled in afterwards by
 * the background embedding run, so an import returns as soon as the text is
 * searchable by keyword.
 * @module cyberself/kb/import
 */
import type { ImportView } from '../../shared/protocol.ts'
import { CyberSelfError } from '../../shared/protocol.ts'
import type { CyberSelfConfig } from '../config.ts'
import { parseFile } from '../parse/index.ts'
import type { VisionTranscriber } from '../parse/types.ts'
import { chunkBlocks, type RawChunk } from './chunking.ts'
import { withTransaction, type KbHandle } from './db.ts'
import {
  findChunkHashes,
  findDocumentByHash,
  getDocument,
  insertChunks,
  insertDocument,
} from './store.ts'
import { sha256Bytes } from './text.ts'

/** Largest file the importer accepts. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024

/** Stage of an import, reported to whoever is watching. */
export interface ImportProgress {
  phase: 'parse' | 'write'
  done: number
  total: number
}

/** Everything the pipeline needs from the plugin. */
export interface ImportDeps {
  config: CyberSelfConfig
  vision: VisionTranscriber | null
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}

/** One file to import. */
export interface ImportInput {
  /** Absolute path or, for uploads, the file name shown in the UI. */
  sourcePath: string
  /** File name used to pick a parser and to title the document. */
  name: string
  bytes: Uint8Array
}

function renumber(chunks: readonly RawChunk[]): RawChunk[] {
  return chunks.map((chunk, ordinal) => ({ ...chunk, ordinal }))
}

/** Import one file into the knowledge base. */
export async function importFile(handle: KbHandle, input: ImportInput, deps: ImportDeps): Promise<ImportView> {
  const startedAt = Date.now()
  if (input.bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new CyberSelfError(413, `${input.name} 超过 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB，无法导入`)
  }
  const fileHash = sha256Bytes(input.bytes)
  const existingId = findDocumentByHash(handle, fileHash)
  if (existingId !== null) {
    return {
      document: getDocument(handle, existingId),
      duplicateOf: existingId,
      chunksKept: 0,
      chunksDropped: 0,
      elapsedMs: Date.now() - startedAt,
      note: '这个文件已经导入过',
    }
  }

  deps.onProgress?.({ phase: 'parse', done: 0, total: 1 })
  const parsed = await parseFile(input.name, input.bytes, {
    ocr: deps.config.ocr.enabled,
    pdfDpi: deps.config.ocr.pdfDpi,
    maxPages: deps.config.ocr.maxPages,
    concurrency: deps.config.ocr.concurrency,
    vision: deps.vision,
    signal: deps.signal,
  })

  const produced = chunkBlocks(parsed.blocks, deps.config.chunking)
  if (produced.length === 0) throw new CyberSelfError(422, `${input.name} 分块后没有内容`)

  const known = findChunkHashes(handle, produced.map((chunk) => chunk.hash))
  const kept: RawChunk[] = []
  let dropped = 0
  for (const chunk of produced) {
    if (known.has(chunk.hash)) {
      dropped += 1
      continue
    }
    known.add(chunk.hash)
    kept.push(chunk)
  }
  if (kept.length === 0) {
    return {
      document: null,
      duplicateOf: null,
      chunksKept: 0,
      chunksDropped: dropped,
      elapsedMs: Date.now() - startedAt,
      note: '这个文件的内容都已经在资料库里了',
    }
  }

  const documentId = `doc-${fileHash.slice(0, 16)}`
  const chunks = renumber(kept)
  deps.onProgress?.({ phase: 'write', done: 0, total: 1 })
  withTransaction(handle, () => {
    insertDocument(handle, {
      id: documentId,
      title: parsed.title,
      path: input.sourcePath,
      kind: parsed.kind,
      bytes: input.bytes.byteLength,
      sha256: fileHash,
      importedAt: Date.now(),
    })
    insertChunks(handle, documentId, chunks, chunks.map(() => null))
  })

  const document = getDocument(handle, documentId)
  return {
    document,
    duplicateOf: null,
    chunksKept: chunks.length,
    chunksDropped: dropped,
    elapsedMs: Date.now() - startedAt,
    note: null,
  }
}
