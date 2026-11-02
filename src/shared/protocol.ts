/**
 * Wire contract shared by the Host routes and the browser client.
 * @module cyberself/protocol
 */

/** Directory, relative to a workspace root, that holds the knowledge base. */
export const KB_DIRECTORY = '.cyberself'

/** Base path of the HTTP API. */
export const API_PREFIX = '/cyberself/api'

/** Path of the streaming answer endpoint. */
export const ASK_PATH = '/cyberself/api/ask'

/** Path of the cancel endpoint that stops a running answer. */
export const CANCEL_PATH = '/cyberself/api/cancel'

/** Path of the endpoint that reads and writes plugin settings. */
export const SETTINGS_PATH = '/cyberself/api/settings'

/** Path of the endpoint that turns a workspace into a library, or back. */
export const MARK_PATH = '/cyberself/api/mark'

/** Path of the plugin-wide report of what is stored on disk. */
export const STORAGE_PATH = '/cyberself/api/storage'

/** Path of the endpoint that removes every document of one library. */
export const PURGE_PATH = '/cyberself/api/purge'

/** Path of the endpoint that deletes one library together with its files. */
export const FORGET_PATH = '/cyberself/api/forget'

/**
 * What a library allows the model to read besides the library itself.
 *
 * - `library` — answers come from the library alone; the model is told not to
 *   use other tools to reach anything outside it.
 * - `open` — the library is the primary source, and material gathered with
 *   other tools may supplement it, as long as it is labelled as such.
 */
export type AnswerScope = 'library' | 'open'

/** One workspace, with the flag that says whether it is a library. */
export interface WorkspaceChoice {
  id: string
  path: string
  title: string
  /** True when the workspace carries the library marker. */
  library: boolean
  /** How far the model may reach beyond the library. */
  scope: AnswerScope
}

/** Background embedding of the chunks that still have no vector. */
export interface EmbeddingProgress {
  /** True while a run is in flight for this library. */
  running: boolean
  done: number
  total: number
  /** Why the last run stopped, when it did not finish. */
  error: string | null
}

/** Aggregate state of one knowledge base. */
export interface LibraryStats {
  dir: string
  documents: number
  chunks: number
  embedded: number
  /** Embedding model configured for this plugin. */
  configuredModel: string
  /** Embedding model that produced the stored vectors, empty when none. */
  embeddingModel: string
  /** True when the configured model answers at its endpoint right now. */
  embeddingReady: boolean
  /** State of the background run that fills in missing vectors. */
  embedding: EmbeddingProgress
  /** Absolute path of the database file. */
  file: string
  /** Bytes the library occupies on disk, including the write-ahead log. */
  bytes: number
  /** When the database was last written, or null when it does not exist. */
  updatedAt: number | null
}

/** One imported document. */
export interface DocumentView {
  id: string
  title: string
  path: string
  kind: string
  bytes: number
  importedAt: number
  chunkCount: number
  embeddedChunks: number
}

/** One chunk as listed in the document detail panel. */
export interface ChunkView {
  id: string
  ordinal: number
  page: number | null
  heading: string | null
  text: string
}

/** One retrieved excerpt offered as evidence. */
export interface Citation {
  /** 1-based number the answer must refer to. */
  index: number
  chunkId: string
  documentId: string
  title: string
  path: string
  page: number | null
  heading: string | null
  text: string
  score: number
}

/** Retrieval result without generation, used by search-as-you-type. */
export interface SearchView {
  query: string
  citations: Citation[]
  vectorHits: number
  keywordHits: number
  /** Why the list is empty or partial, when that needs saying. */
  note: string | null
}

/** One answered question. */
export interface AnswerView {
  question: string
  answer: string
  citations: Citation[]
  model: string
  /** Set when the answer was produced without usable citations. */
  warning: string | null
}

/** Result of importing one file. */
export interface ImportView {
  document: DocumentView | null
  /** Set when the file was already imported and nothing was written. */
  duplicateOf: string | null
  chunksKept: number
  chunksDropped: number
  elapsedMs: number
  /** Human-readable remark, for example that a passage was already present. */
  note: string | null
}

/** Body of an import request: a host path, or uploaded bytes as base64. */
export interface ImportRequest {
  dir: string
  /** Absolute path on the Host; used when no upload payload is sent. */
  path?: string
  /** File name of an upload. */
  name?: string
  /** Base64 payload of an upload. */
  data?: string
}

/** Payload of a library listing response. */
export interface LibraryView {
  dir: string
  /** False for a workspace that was never turned into a library. */
  library: boolean
  /** How far the model may reach beyond this library. */
  scope: AnswerScope
  stats: LibraryStats | null
  documents: DocumentView[]
}

/** Body of a mark request. */
export interface MarkRequest {
  dir: string
  library: boolean
  /** New answer scope; omitted keeps the scope the marker already carries. */
  scope?: AnswerScope
}

/** Answer to a mark request. */
export interface MarkView {
  dir: string
  library: boolean
  scope: AnswerScope
}

/** One library as counted on disk, for the settings page. */
export interface LibraryStorage {
  dir: string
  title: string
  scope: AnswerScope
  documents: number
  chunks: number
  embedded: number
  /** Bytes the library occupies on disk. */
  bytes: number
  /** Absolute path of the database file. */
  file: string
  /** When the database was last written, or null when it does not exist. */
  updatedAt: number | null
}

/** Everything the settings page shows about stored data. */
export interface StorageView {
  /** Directory, relative to a workspace root, where the databases live. */
  root: string
  /** Where the plugin settings file lives. */
  settingsFile: string
  libraries: LibraryStorage[]
  totals: {
    libraries: number
    documents: number
    chunks: number
    embedded: number
    bytes: number
  }
}

/** Answer to a purge request. */
export interface PurgeView {
  dir: string
  /** Documents that were removed. */
  removed: number
  /** Bytes reclaimed from the database file. */
  reclaimed: number
}

/** Answer to a forget request. */
export interface ForgetView {
  dir: string
  /** True when the library directory was removed. */
  removed: boolean
}

/** Effective embedding configuration, plus what the endpoint reports right now. */
export interface EmbeddingSettingsView {
  baseURL: string
  model: string
  timeoutMs: number
  batchSize: number
  /** Characters handed to the model per chunk; 0 keeps the whole chunk. */
  maxChars: number
  /** Table rows that differ only in numbers share one vector. */
  dedupeNumbers: boolean
  /** True when the endpoint answers and the configured model is installed. */
  reachable: boolean
  /** Why the endpoint is not usable, when that needs saying. */
  note: string | null
  /** Model names the endpoint has installed. */
  installed: string[]
}

/** Everything the settings page shows. */
export interface SettingsView {
  embedding: EmbeddingSettingsView
  workspaces: WorkspaceChoice[]
  /** Where the saved settings live. */
  file: string
}

/** Body of a settings request: empty reads, an `embedding` object writes. */
export interface SettingsRequest {
  embedding?: Partial<EmbeddingSettingsView>
}

/** Body of a question request. */
export interface AskRequest {
  /** Identifier the client picks, so a cancel can name this run. */
  id: string
  dir: string
  question: string
}

/** Body of a cancel request. */
export interface CancelRequest {
  id: string
}

/** Frames the Host streams back on the ask endpoint, one JSON object per event. */
export type AskEvent =
  | { kind: 'token'; text: string }
  | { kind: 'answer'; answer: AnswerView }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/** Frames streamed by the import and embedding endpoints. */
export type ImportEvent =
  | { kind: 'progress'; phase: 'parse' | 'write'; done: number; total: number }
  | { kind: 'import'; view: ImportView }
  | { kind: 'embedded'; remaining: number }
  | { kind: 'error'; message: string }

/** Body returned for every failed request. */
export interface ErrorBody {
  error: string
  status: number
}

/** Failure carrying the HTTP status the route should report. */
export class CyberSelfError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CyberSelfError'
    this.status = status
  }
}
