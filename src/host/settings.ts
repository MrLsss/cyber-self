/**
 * Durable state that outlives one Host process: the plugin settings shared by
 * every workspace, and the per-workspace marker that declares a library.
 * @module cyberself/settings
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CyberSelfError, KB_DIRECTORY } from '../shared/protocol.ts'
import type { AnswerScope } from '../shared/protocol.ts'
import type { EmbeddingSettings } from './config.ts'

/** File name of the per-workspace marker inside {@link KB_DIRECTORY}. */
const MARKER_FILE = 'config.json'

/** Schema version written into every file this module owns. */
const FORMAT_VERSION = 1

/** Root of the DSH home that owns the global settings file. */
export function dshHome(): string {
  const configured = process.env.DSH_HOME
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

/** Absolute path of the global settings file. */
export function settingsFile(): string {
  return join(dshHome(), 'cyberself', 'settings.json')
}

/** Embedding overrides saved through the settings page. */
export type StoredEmbeddingSettings = Partial<EmbeddingSettings>

interface StoredSettings {
  version?: number
  embedding?: StoredEmbeddingSettings
}

/** Shape of `<workspace>/.cyberself/config.json`. */
interface LibraryMarker {
  version?: number
  library?: boolean
  scope?: AnswerScope
}

function readJsonFile<T extends object>(file: string): T {
  if (!existsSync(file)) return {} as T
  const text = readFileSync(file, 'utf8')
  try {
    const parsed = JSON.parse(text) as T
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    return parsed
  } catch {
    throw new CyberSelfError(500, `设置文件不是合法的 JSON：${file}`)
  }
}

function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/** Embedding overrides saved so far; empty when nothing was saved yet. */
export function readEmbeddingSettings(): StoredEmbeddingSettings {
  return readJsonFile<StoredSettings>(settingsFile()).embedding ?? {}
}

/** Merge embedding overrides into the settings file and return the new state. */
export function writeEmbeddingSettings(patch: StoredEmbeddingSettings): StoredEmbeddingSettings {
  const file = settingsFile()
  const current = readJsonFile<StoredSettings>(file)
  const merged: StoredEmbeddingSettings = { ...current.embedding, ...patch }
  writeJsonFile(file, { ...current, version: FORMAT_VERSION, embedding: merged })
  return merged
}

/** Absolute path of the marker that declares a workspace a library. */
export function libraryMarker(dir: string): string {
  return join(dir, KB_DIRECTORY, MARKER_FILE)
}

/** True when the workspace carries the library marker. */
export function isLibraryWorkspace(dir: string): boolean {
  const file = libraryMarker(dir)
  if (!existsSync(file)) return false
  const parsed = readJsonFile<LibraryMarker>(file)
  return parsed.library !== false
}

/** How far the model may reach beyond this library; a workspace without the marker defaults to `library`. */
export function libraryScope(dir: string): AnswerScope {
  const file = libraryMarker(dir)
  if (!existsSync(file)) return 'library'
  return readJsonFile<LibraryMarker>(file).scope === 'open' ? 'open' : 'library'
}

/** Turn a workspace into a library, or drop the marker while keeping the database. */
export function setLibraryWorkspace(dir: string, library: boolean, scope?: AnswerScope): void {
  const file = libraryMarker(dir)
  if (library) {
    const current = existsSync(file) ? readJsonFile<LibraryMarker>(file) : {}
    const next: AnswerScope = scope ?? (current.scope === 'open' ? 'open' : 'library')
    writeJsonFile(file, { ...current, version: FORMAT_VERSION, library: true, scope: next })
    return
  }
  if (existsSync(file)) rmSync(file)
}
