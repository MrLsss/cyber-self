/**
 * Calls the plugin's HTTP API from the browser half, plus the store that keeps
 * one workspace's library state current.
 * @module cyberself/client/data
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  FORGET_PATH,
  MARK_PATH,
  PURGE_PATH,
  STORAGE_PATH,
  type AnswerScope,
  type Citation,
  type DocumentView,
  type ForgetView,
  type ImportEvent,
  type ImportView,
  type LibraryView,
  type MarkView,
  type PurgeView,
  type SearchView,
  type StorageView,
} from '../shared/protocol.ts'
import { postJson, postStream, readBase64 } from './base.ts'

/** One import or embedding progress tick. */
export interface Progress {
  phase: 'parse' | 'write'
  done: number
  total: number
}

/** Answer to one "what does this library hold" question. */
export interface LibraryState {
  view: LibraryView | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** Cached state of one library directory. */
interface LibraryEntry {
  view: LibraryView | null
  error: string | null
  loading: boolean
  stale: boolean
}

const EMPTY: LibraryEntry = { view: null, error: null, loading: false, stale: false }
const entries = new Map<string, LibraryEntry>()
const listeners = new Set<() => void>()

function read(dir: string): LibraryEntry {
  return entries.get(dir) ?? EMPTY
}

function publish(dir: string, patch: Partial<LibraryEntry>): void {
  entries.set(dir, { ...read(dir), ...patch })
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Mark every cached library stale, so the next draw re-reads it. */
export function invalidateLibraries(): void {
  for (const [dir, entry] of entries) entries.set(dir, { ...entry, stale: true })
  for (const listener of listeners) listener()
}

/** Re-read one library and let every seat showing it redraw. */
export function refreshLibrary(dir: string): void {
  publish(dir, { loading: true, stale: false })
  postJson<LibraryView>('library', { dir })
    .then((view) => {
      publish(dir, { view, error: null, loading: false, stale: false })
    })
    .catch((reason: unknown) => {
      publish(dir, { error: reason instanceof Error ? reason.message : String(reason), loading: false, stale: false })
    })
}

/** Load, and re-load, one library directory. */
export function useLibrary(dir: string | undefined): LibraryState {
  const entry = useSyncExternalStore(subscribe, () => dir === undefined ? EMPTY : read(dir))

  const reload = useCallback(() => {
    if (dir !== undefined) refreshLibrary(dir)
  }, [dir])

  useEffect(() => {
    if (dir === undefined) return
    if (entries.get(dir) === undefined || entry.stale) refreshLibrary(dir)
  }, [dir, entry.stale])

  return { view: entry.view, error: entry.error, loading: entry.loading, reload }
}

/** Mark or unmark one directory as a library, optionally changing its answer scope. */
export async function markLibrary(dir: string, library: boolean, scope?: AnswerScope): Promise<MarkView> {
  return await postJson<MarkView>(MARK_PATH, { dir, library, scope })
}

/** Upload one browser file through the import stream. */
export async function importUpload(
  dir: string,
  file: File,
  onProgress: (progress: Progress) => void,
  signal?: AbortSignal,
): Promise<ImportView> {
  const data = await readBase64(file)
  let imported: ImportView | null = null
  await postStream<ImportEvent>('import', { dir, name: file.name, data }, (event) => {
    if (event.kind === 'progress') onProgress(event)
    else if (event.kind === 'import') imported = event.view
    else if (event.kind === 'error') throw new Error(event.message)
  }, signal)
  if (imported === null) throw new Error('导入没有返回结果')
  return imported
}

/** Import one file that already lives on the Host. */
export async function importPath(
  dir: string,
  path: string,
  onProgress: (progress: Progress) => void,
  signal?: AbortSignal,
): Promise<ImportView> {
  let imported: ImportView | null = null
  await postStream<ImportEvent>('import', { dir, path }, (event) => {
    if (event.kind === 'progress') onProgress(event)
    else if (event.kind === 'import') imported = event.view
    else if (event.kind === 'error') throw new Error(event.message)
  }, signal)
  if (imported === null) throw new Error('导入没有返回结果')
  return imported
}

/** Files under one directory that the plugin can import. */
export interface ScanView {
  files: string[]
  skipped: string[]
}

export async function scanDirectory(dir: string, path: string): Promise<ScanView> {
  return await postJson<ScanView>('scan', { dir, path })
}

/** Start filling in missing vectors; the run continues after the response. */
export async function embedMissing(
  dir: string,
  onProgress: (progress: Progress) => void,
  signal?: AbortSignal,
): Promise<{ remaining: number }> {
  let done = { remaining: 0 }
  await postStream<ImportEvent>('embed', { dir }, (event) => {
    if (event.kind === 'progress') onProgress(event)
    else if (event.kind === 'embedded') done = { remaining: event.remaining }
    else if (event.kind === 'error') throw new Error(event.message)
  }, signal)
  return done
}

export async function removeDocument(dir: string, id: string): Promise<{ deleted: boolean }> {
  return await postJson<{ deleted: boolean }>('delete', { dir, id })
}

/** Remove every document of one library, keeping the library itself. */
export async function purgeLibrary(dir: string): Promise<PurgeView> {
  return await postJson<PurgeView>(PURGE_PATH, { dir })
}

/** Delete one library together with its files. */
export async function forgetLibrary(dir: string): Promise<ForgetView> {
  return await postJson<ForgetView>(FORGET_PATH, { dir })
}

/** What the Host stores for this plugin, and where. */
export async function loadStorage(): Promise<StorageView> {
  return await postJson<StorageView>(STORAGE_PATH, {})
}

export interface DocumentDetail {
  document: DocumentView
  chunks: { id: string; ordinal: number; page: number | null; heading: string | null; text: string }[]
}

export async function loadDocument(dir: string, id: string): Promise<DocumentDetail> {
  return await postJson<DocumentDetail>('document', { dir, id })
}

export async function searchLibrary(dir: string, query: string): Promise<SearchView> {
  return await postJson<SearchView>('search', { dir, query })
}

/** Cited chunks from the last search, indexed from one. */
export type { Citation }
