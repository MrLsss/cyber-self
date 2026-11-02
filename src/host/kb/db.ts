/**
 * Knowledge base storage: one SQLite file per workspace, opened through
 * `node:sqlite`. Vectors are float32 blobs on the chunk row; full-text search
 * uses an FTS5 trigram index kept in sync by triggers.
 * @module cyberself/kb/db
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KB_DIRECTORY } from '../../shared/protocol.ts'

/** Filesystem layout of one knowledge base. */
export interface KbLocation {
  /** Workspace directory the base belongs to. */
  dir: string
  /** `<dir>/.cyberself`. */
  root: string
  /** `<dir>/.cyberself/kb.db`. */
  file: string
}

/** An open knowledge base. */
export interface KbHandle extends KbLocation {
  db: DatabaseSync
  /** Counter behind {@link withTransaction}'s savepoint names. */
  savepoints: number
}

const SCHEMA_VERSION = 1

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  page INTEGER,
  heading TEXT,
  embedding BLOB,
  embedding_dim INTEGER
);
CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`

/** Resolve the knowledge base location of a workspace without touching disk. */
export function locateKb(dir: string): KbLocation {
  const root = join(dir, KB_DIRECTORY)
  return { dir, root, file: join(root, 'kb.db') }
}

/** Open (creating on first use) the knowledge base of a workspace. */
export function openKb(dir: string): KbHandle {
  const location = locateKb(dir)
  mkdirSync(location.root, { recursive: true })
  const db = new DatabaseSync(location.file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(DDL)
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  if (version === undefined) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  }
  return { ...location, db, savepoints: 0 }
}

/** Close an open knowledge base. */
export function closeKb(handle: KbHandle): void {
  handle.db.close()
}

/**
 * Run `work` inside one transaction, nesting safely: a savepoint is used so a
 * caller that already opened a transaction (importing a file writes the document
 * and its chunks together) keeps its own boundary.
 */
export function withTransaction<T>(handle: KbHandle, work: () => T): T {
  const savepoint = `cyberself_${handle.savepoints += 1}`
  handle.db.exec(`SAVEPOINT ${savepoint}`)
  try {
    const value = work()
    handle.db.exec(`RELEASE ${savepoint}`)
    return value
  } catch (error) {
    handle.db.exec(`ROLLBACK TO ${savepoint}`)
    handle.db.exec(`RELEASE ${savepoint}`)
    throw error
  }
}

/** Encode a vector as the little-endian float32 blob stored in SQLite. */
export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength).slice()
}

/** Decode a float32 blob back into a vector. */
export function decodeVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}
