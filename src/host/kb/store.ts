/**
 * Row operations on one knowledge base. Everything here takes an open
 * {@link KbHandle}; connection lifetime belongs to the caller.
 * @module cyberself/kb/store
 */
import type { ChunkView, DocumentView, LibraryStats } from '../../shared/protocol.ts'
import type { KbHandle } from './db.ts'
import { decodeVector, encodeVector, withTransaction } from './db.ts'
import type { RawChunk } from './chunking.ts'

interface DocumentStatsRow {
  id: string
  title: string
  path: string
  kind: string
  bytes: number
  imported_at: number
  chunk_count: number
  embedded_chunks: number
}

interface CountRow {
  documents: number
  chunks: number
  embedded: number
}

/** Text and position of a chunk, as needed by retrieval. */
export interface ChunkRecord {
  id: string
  documentId: string
  title: string
  path: string
  ordinal: number
  text: string
  page: number | null
  heading: string | null
  embedding: Float32Array | null
}

function toDocumentView(row: DocumentStatsRow): DocumentView {
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    kind: row.kind,
    bytes: row.bytes,
    importedAt: row.imported_at,
    chunkCount: row.chunk_count,
    embeddedChunks: row.embedded_chunks,
  }
}

/** Read one meta value. */
export function readMeta(handle: KbHandle, key: string): string | null {
  const row = handle.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row === undefined ? null : row.value
}

/** Write one meta value. */
export function writeMeta(handle: KbHandle, key: string, value: string): void {
  handle.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Every document, newest import first, with chunk counts. */
export function listDocuments(handle: KbHandle): DocumentView[] {
  const rows = handle.db.prepare(`
    SELECT d.id, d.title, d.path, d.kind, d.bytes, d.imported_at,
           COUNT(c.id) AS chunk_count,
           COALESCE(SUM(CASE WHEN c.embedding IS NULL THEN 0 ELSE 1 END), 0) AS embedded_chunks
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id
    ORDER BY d.imported_at DESC, d.title ASC
  `).all() as unknown as DocumentStatsRow[]
  return rows.map(toDocumentView)
}

/** One document, or null when the id is unknown. */
export function getDocument(handle: KbHandle, id: string): DocumentView | null {
  const row = handle.db.prepare(`
    SELECT d.id, d.title, d.path, d.kind, d.bytes, d.imported_at,
           COUNT(c.id) AS chunk_count,
           COALESCE(SUM(CASE WHEN c.embedding IS NULL THEN 0 ELSE 1 END), 0) AS embedded_chunks
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    WHERE d.id = ?
    GROUP BY d.id
  `).get(id) as unknown as DocumentStatsRow | undefined
  return row === undefined ? null : toDocumentView(row)
}

/** Id of the document whose file bytes hash to `sha256`, if any. */
export function findDocumentByHash(handle: KbHandle, sha256: string): string | null {
  const row = handle.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha256) as { id: string } | undefined
  return row === undefined ? null : row.id
}

/** Insert a document row. */
export function insertDocument(
  handle: KbHandle,
  document: { id: string; title: string; path: string; kind: string; bytes: number; sha256: string; importedAt: number },
): void {
  handle.db.prepare(`
    INSERT INTO documents (id, title, path, kind, bytes, sha256, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(document.id, document.title, document.path, document.kind, document.bytes, document.sha256, document.importedAt)
}

/** Chunk ids looked up in one statement; keeps every `IN` list well under the SQLite variable limit. */
const LOOKUP_BATCH = 400

/** Which of `hashes` are already stored, used to drop repeated passages before writing. */
export function findChunkHashes(handle: KbHandle, hashes: readonly string[]): Set<string> {
  const found = new Set<string>()
  for (let start = 0; start < hashes.length; start += LOOKUP_BATCH) {
    const slice = hashes.slice(start, start + LOOKUP_BATCH)
    const placeholders = slice.map(() => '?').join(', ')
    const rows = handle.db.prepare(`SELECT hash FROM chunks WHERE hash IN (${placeholders})`)
      .all(...slice) as unknown as { hash: string }[]
    for (const row of rows) found.add(row.hash)
  }
  return found
}

/** Identifier of one chunk row inside its document. */
export function chunkId(documentId: string, ordinal: number): string {
  return `${documentId}-${ordinal.toString().padStart(5, '0')}`
}

/** Insert chunks; a null vector leaves the chunk pending embedding. */
export function insertChunks(
  handle: KbHandle,
  documentId: string,
  chunks: readonly RawChunk[],
  vectors: readonly (Float32Array | null)[],
): void {
  const statement = handle.db.prepare(`
    INSERT INTO chunks (id, document_id, ordinal, text, hash, page, heading, embedding, embedding_dim)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  withTransaction(handle, () => {
    chunks.forEach((chunk, index) => {
      const vector = vectors[index] ?? null
      statement.run(
        chunkId(documentId, chunk.ordinal),
        documentId,
        chunk.ordinal,
        chunk.text,
        chunk.hash,
        chunk.page,
        chunk.heading,
        vector === null ? null : encodeVector(vector),
        vector === null ? null : vector.length,
      )
    })
  })
}

/** Remove a document and, by cascade, its chunks. */
export function deleteDocument(handle: KbHandle, id: string): boolean {
  const result = handle.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  return result.changes > 0
}

/** Remove every document, and with them every chunk and vector. */
export function purgeDocuments(handle: KbHandle): number {
  const result = withTransaction(handle, () => handle.db.prepare('DELETE FROM documents').run())
  handle.db.prepare("DELETE FROM meta WHERE key IN ('embedding_model', 'embedding_dim')").run()
  return Number(result.changes)
}

/** Return freed pages to the filesystem, so the database file really shrinks. */
export function reclaimSpace(handle: KbHandle): void {
  handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  handle.db.exec('VACUUM')
  handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}

/** Counts for the library header. */
export function libraryStats(handle: KbHandle): Omit<LibraryStats, 'dir' | 'configuredModel' | 'embeddingModel' | 'embeddingReady' | 'embedding' | 'file' | 'bytes' | 'updatedAt'> {
  const row = handle.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents) AS documents,
      (SELECT COUNT(*) FROM chunks) AS chunks,
      (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded
  `).get() as unknown as CountRow | undefined
  return row === undefined ? { documents: 0, chunks: 0, embedded: 0 } : row
}

/** Chunks of one document in reading order. */
export function listChunks(handle: KbHandle, documentId: string, limit: number): ChunkView[] {
  const rows = handle.db.prepare(`
    SELECT id, ordinal, page, heading, text FROM chunks
    WHERE document_id = ? ORDER BY ordinal ASC LIMIT ?
  `).all(documentId, limit) as unknown as { id: string; ordinal: number; page: number | null; heading: string | null; text: string }[]
  return rows
}

/** Chunks that still need a vector, oldest document first, without reading their text. */
export function pendingChunkIds(handle: KbHandle): { id: string; documentId: string; kind: string }[] {
  return handle.db.prepare(`
    SELECT c.id, c.document_id AS documentId, d.kind FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.embedding IS NULL
    ORDER BY d.imported_at ASC, c.ordinal ASC
  `).all() as unknown as { id: string; documentId: string; kind: string }[]
}

/** Text of the named chunks, keyed by id; chunks deleted meanwhile are simply absent. */
export function chunkTexts(handle: KbHandle, ids: readonly string[]): Map<string, string> {
  const texts = new Map<string, string>()
  for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
    const slice = ids.slice(start, start + LOOKUP_BATCH)
    const placeholders = slice.map(() => '?').join(', ')
    const rows = handle.db.prepare(`SELECT id, text FROM chunks WHERE id IN (${placeholders})`)
      .all(...slice) as unknown as { id: string; text: string }[]
    for (const row of rows) texts.set(row.id, row.text)
  }
  return texts
}

/** How many chunks are waiting for a vector. */
export function countPendingChunks(handle: KbHandle): number {
  const row = handle.db.prepare('SELECT COUNT(*) AS total FROM chunks WHERE embedding IS NULL').get() as { total: number } | undefined
  return row === undefined ? 0 : row.total
}

/** Store one vector. */
export function setChunkEmbedding(handle: KbHandle, id: string, vector: Float32Array): void {
  handle.db.prepare('UPDATE chunks SET embedding = ?, embedding_dim = ? WHERE id = ?')
    .run(encodeVector(vector), vector.length, id)
}

/** Record which model produced the stored vectors. */
export function recordEmbeddingModel(handle: KbHandle, model: string, dimensions: number): void {
  writeMeta(handle, 'embedding_model', model)
  writeMeta(handle, 'embedding_dim', String(dimensions))
}

/** Drop every vector so the base can be re-embedded with a different model. */
export function clearEmbeddings(handle: KbHandle): number {
  const result = handle.db.prepare('UPDATE chunks SET embedding = NULL, embedding_dim = NULL WHERE embedding IS NOT NULL').run()
  handle.db.prepare("DELETE FROM meta WHERE key IN ('embedding_model', 'embedding_dim')").run()
  return Number(result.changes)
}

/** Every chunk with a vector, with its document title and path attached. */
export function embeddableChunks(handle: KbHandle): ChunkRecord[] {
  const rows = handle.db.prepare(`
    SELECT c.id, c.document_id, d.title, d.path, c.ordinal, c.text, c.page, c.heading, c.embedding
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.embedding IS NOT NULL
  `).all() as unknown as {
    id: string
    document_id: string
    title: string
    path: string
    ordinal: number
    text: string
    page: number | null
    heading: string | null
    embedding: Uint8Array
  }[]
  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    title: row.title,
    path: row.path,
    ordinal: row.ordinal,
    text: row.text,
    page: row.page,
    heading: row.heading,
    embedding: decodeVector(row.embedding),
  }))
}
