/**
 * What one knowledge base occupies on disk.
 * @module cyberself/kb/usage
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { locateKb } from './db.ts'

/** Files that carry a library: the database itself, its log and its shards. */
const DATA_PREFIX = 'kb.db'

/** Size and last write of the files that carry one library. */
export interface LibraryUsage {
  /** Absolute path of the database file. */
  file: string
  /** Bytes on disk, counting the write-ahead log. */
  bytes: number
  /** Milliseconds since the epoch; null when nothing was written yet. */
  updatedAt: number | null
}

/** Measures the files of one library without creating anything. */
export function measureLibrary(dir: string): LibraryUsage {
  const location = locateKb(dir)
  const usage: LibraryUsage = { file: location.file, bytes: 0, updatedAt: null }
  if (!existsSync(location.root)) return usage
  for (const entry of readdirSync(location.root)) {
    if (!entry.startsWith(DATA_PREFIX)) continue
    const stat = statSync(join(location.root, entry), { throwIfNoEntry: false })
    if (stat === undefined) continue
    usage.bytes += stat.size
    if (usage.updatedAt === null || stat.mtimeMs > usage.updatedAt) usage.updatedAt = stat.mtimeMs
  }
  return usage
}
