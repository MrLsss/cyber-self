/**
 * Application layer: turns Host services plus the plugin config into the
 * operations the routes, the model-facing tools and the session policy call.
 * @module cyberself/service
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  CyberSelfError,
  KB_DIRECTORY,
  type AnswerScope,
  type AnswerView,
  type ChunkView,
  type Citation,
  type DocumentView,
  type EmbeddingProgress,
  type EmbeddingSettingsView,
  type ForgetView,
  type ImportView,
  type LibraryStats,
  type LibraryStorage,
  type LibraryView,
  type MarkView,
  type PurgeView,
  type ScanView,
  type SearchView,
  type SettingsView,
  type StorageView,
  type WorkspaceChoice,
} from '../shared/protocol.ts'
import { createVisionTranscriber, type ImageSaver } from './answer/vision.ts'
import { answerQuestion, type ModelRoute, type ModelStream } from './answer/qa.ts'
import type { CyberSelfConfig, EmbeddingSettings } from './config.ts'
import { embedPending } from './embed/pipeline.ts'
import { createOllamaEmbedder, type OllamaEmbedder } from './embed/ollama.ts'
import { importFile, MAX_IMPORT_BYTES, type ImportProgress } from './kb/import.ts'
import { closeKb, locateKb, openKb, type KbHandle } from './kb/db.ts'
import { materializeCitations, retrieve } from './kb/search.ts'
import {
  clearEmbeddings,
  countPendingChunks,
  deleteDocument as deleteDocumentRow,
  getDocument,
  listChunks,
  listDocuments,
  libraryStats,
  purgeDocuments,
  readMeta,
  reclaimSpace,
} from './kb/store.ts'
import { measureLibrary } from './kb/usage.ts'
import { SUPPORTED_EXTENSIONS, isImageName, isSupported } from './parse/index.ts'
import type { VisionTranscriber } from './parse/types.ts'
import type { LibrarySummary } from './policy.ts'
import {
  isLibraryWorkspace,
  libraryScope,
  setLibraryWorkspace,
  settingsFile,
  type StoredEmbeddingSettings,
} from './settings.ts'

/** Services and storage the plugin reads from the Host. */
export interface ServiceDeps {
  config: () => CyberSelfConfig
  /** Workspaces the Host knows about, one potential library per directory. */
  listWorkspaces: () => readonly Omit<WorkspaceChoice, 'library' | 'scope'>[]
  /** Model service, absent only when the Host provides none. */
  llm: ModelStream | null
  /** Attachment store used to hand images to the vision model. */
  attachments: ImageSaver | null
  /** Current default model route, read on every call. */
  route: () => ModelRoute
  /** Embedding overrides saved through the settings page. */
  readEmbeddingSettings: () => StoredEmbeddingSettings
  /** Persist embedding overrides and return the merged result. */
  writeEmbeddingSettings: (patch: StoredEmbeddingSettings) => StoredEmbeddingSettings
}

/** How long an embedding health answer is reused. */
const HEALTH_TTL_MS = 30_000

/** Documents larger than this are refused before the payload is decoded. */
const MAX_BASE64_CHARS = Math.ceil(MAX_IMPORT_BYTES * 4 / 3)

/** Directories never walked when scanning a folder for importable files. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.cyberself', 'dist', 'build', 'lib'])

/** Smallest accepted embedding request timeout. */
const MIN_TIMEOUT_MS = 1_000

/** Largest accepted embedding request timeout. */
const MAX_TIMEOUT_MS = 600_000

/** Largest accepted embedding batch. */
const MAX_BATCH_SIZE = 64

/** Largest accepted character budget per embedded chunk. */
const MAX_EMBED_CHARS = 8_000

function isDirectory(target: string): Promise<boolean> {
  return stat(target).then((info) => info.isDirectory(), () => false)
}

function requireInteger(input: unknown, field: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
    throw new CyberSelfError(400, `${field} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return input
}

/**
 * Validate the embedding part of a settings request.
 * @param input - the raw `embedding` member of the request body.
 * @returns only the fields that were present and valid.
 */
export function parseEmbeddingPatch(input: unknown): StoredEmbeddingSettings {
  if (input === undefined) return {}
  if (input === null || typeof input !== 'object') throw new CyberSelfError(400, 'embedding 必须是对象')
  const body = input as Record<string, unknown>
  const patch: StoredEmbeddingSettings = {}
  if (body.baseURL !== undefined) {
    if (typeof body.baseURL !== 'string' || !/^https?:\/\//u.test(body.baseURL)) {
      throw new CyberSelfError(400, 'baseURL 必须是以 http:// 或 https:// 开头的地址')
    }
    patch.baseURL = body.baseURL.replace(/\/+$/u, '')
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || body.model.trim() === '') throw new CyberSelfError(400, 'model 不能为空')
    patch.model = body.model.trim()
  }
  if (body.timeoutMs !== undefined) {
    patch.timeoutMs = requireInteger(body.timeoutMs, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  }
  if (body.batchSize !== undefined) {
    patch.batchSize = requireInteger(body.batchSize, 'batchSize', 1, MAX_BATCH_SIZE)
  }
  if (body.maxChars !== undefined) {
    patch.maxChars = requireInteger(body.maxChars, 'maxChars', 0, MAX_EMBED_CHARS)
  }
  if (body.dedupeNumbers !== undefined) {
    if (typeof body.dedupeNumbers !== 'boolean') throw new CyberSelfError(400, 'dedupeNumbers 必须是布尔值')
    patch.dedupeNumbers = body.dedupeNumbers
  }
  return patch
}

/** The plugin's operations over every library it has opened. */
export class CyberSelf {
  private readonly deps: ServiceDeps
  private readonly handles = new Map<string, KbHandle>()
  private storedEmbedding: StoredEmbeddingSettings
  private health: { key: string; at: number; ready: boolean; message: string | null } | null = null
  /** Background embedding runs, one per library directory. */
  private readonly jobs = new Map<string, EmbeddingProgress>()
  /** Completion of the run in {@link jobs}, so callers can wait for it. */
  private readonly runs = new Map<string, Promise<void>>()
  private readonly aborters = new Map<string, AbortController>()

  constructor(deps: ServiceDeps) {
    this.deps = deps
    this.storedEmbedding = deps.readEmbeddingSettings()
  }

  /** Close every open database. */
  dispose(): void {
    for (const abort of this.aborters.values()) abort.abort()
    this.aborters.clear()
    this.jobs.clear()
    this.runs.clear()
    for (const handle of this.handles.values()) closeKb(handle)
    this.handles.clear()
  }

  /** Effective embedding settings: the profile configuration overridden by the settings page. */
  embeddingSettings(): EmbeddingSettings {
    return { ...this.deps.config().embedding, ...this.storedEmbedding }
  }

  private embedder(): OllamaEmbedder {
    return createOllamaEmbedder(this.embeddingSettings())
  }

  /** State of the background run for one library. */
  private embeddingProgress(dir: string): EmbeddingProgress {
    const job = this.jobs.get(dir)
    if (job === undefined) return { running: false, done: 0, total: 0, error: null }
    return { running: job.running, done: job.done, total: job.total, error: job.error }
  }

  /**
   * Start the background run that fills in missing vectors. One run per library:
   * a second call while it is working is a no-op, and the run keeps going after
   * the request that started it has answered.
   */
  private startEmbedding(dir: string): void {
    const current = this.jobs.get(dir)
    if (current?.running === true) return
    const job: EmbeddingProgress = { running: true, done: 0, total: 0, error: null }
    this.jobs.set(dir, job)
    const run = this.runEmbedding(dir, job)
    this.runs.set(dir, run)
    void run.then(() => {
      if (this.runs.get(dir) === run) this.runs.delete(dir)
    })
  }

  private async runEmbedding(dir: string, job: EmbeddingProgress): Promise<void> {
    const handle = this.kb(dir)
    const abort = new AbortController()
    this.aborters.set(dir, abort)
    try {
      for (;;) {
        if (abort.signal.aborted) break
        const settings = this.embeddingSettings()
        const stored = readMeta(handle, 'embedding_model')
        if (stored !== null && stored !== settings.model) clearEmbeddings(handle)
        const written = await embedPending(handle, this.embedder(), {
          batchSize: settings.batchSize,
          maxChars: settings.maxChars,
          dedupeNumbers: settings.dedupeNumbers,
          signal: abort.signal,
          onProgress: (progress) => {
            job.done = progress.done
            job.total = progress.total
          },
        })
        if (written === 0) break
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error)
    } finally {
      job.running = false
      this.aborters.delete(dir)
    }
  }

  /** Workspaces the Host knows about, each flagged with its library marker and its answer scope. */
  choices(): WorkspaceChoice[] {
    return this.deps.listWorkspaces().map((workspace) => ({
      ...workspace,
      library: isLibraryWorkspace(workspace.path),
      scope: libraryScope(workspace.path),
    }))
  }

  /**
   * Canonicalize a requested directory and refuse anything that is not a
   * registered workspace: a library only exists inside a workspace.
   */
  resolveDir(input: string): string {
    if (input.trim() === '') throw new CyberSelfError(400, '缺少工作区目录')
    const absolute = resolve(input)
    let canonical: string
    try {
      canonical = realpathSync(absolute)
    } catch {
      throw new CyberSelfError(404, `目录不存在：${absolute}`)
    }
    const known = this.deps.listWorkspaces().some((workspace) => workspace.path === canonical)
    if (!known) throw new CyberSelfError(403, `不是已注册的工作区：${canonical}`)
    return canonical
  }

  /** Refuse library operations in a workspace that was never turned into one. */
  private requireLibrary(dir: string): string {
    const canonical = this.resolveDir(dir)
    if (!isLibraryWorkspace(canonical)) {
      throw new CyberSelfError(409, `这个工作区还不是资料库：${canonical}`)
    }
    return canonical
  }

  /** Open (or reuse) the database of a canonical workspace directory. */
  private kb(dir: string): KbHandle {
    const existing = this.handles.get(dir)
    if (existing !== undefined) return existing
    const handle = openKb(dir)
    this.handles.set(dir, handle)
    return handle
  }

  /** True when the directory carries the library marker; used by the session policy. */
  isLibrary(dir: string): boolean {
    return isLibraryWorkspace(resolve(dir))
  }

  /** How far the model may reach beyond this library; used by the session policy. */
  scopeOf(dir: string): AnswerScope {
    return libraryScope(resolve(dir))
  }

  /** Counts of the library in this directory, or null when it is not a library. */
  librarySummary(dir: string): LibrarySummary | null {
    const canonical = resolve(dir)
    if (!isLibraryWorkspace(canonical)) return null
    return libraryStats(this.kb(canonical))
  }

  /** Turn a workspace into a library, or drop the marker while keeping the database. */
  mark(dirInput: string, library: boolean, scope?: AnswerScope): MarkView {
    const dir = this.resolveDir(dirInput)
    setLibraryWorkspace(dir, library, scope)
    return { dir, library, scope: libraryScope(dir) }
  }

  private async embeddingHealth(): Promise<{ ready: boolean; message: string | null }> {
    const settings = this.embeddingSettings()
    const key = `${settings.baseURL}|${settings.model}`
    const now = Date.now()
    if (this.health !== null && this.health.key === key && now - this.health.at < HEALTH_TTL_MS) return this.health
    const probe = await this.embedder().probe()
    this.health = { key, at: now, ...probe }
    return this.health
  }

  /** Header state plus the document list; a workspace without the marker reports empty. */
  async library(dirInput: string): Promise<LibraryView> {
    const dir = this.resolveDir(dirInput)
    const scope = libraryScope(dir)
    if (!isLibraryWorkspace(dir)) return { dir, library: false, scope, stats: null, documents: [] }
    const handle = this.kb(dir)
    const counts = libraryStats(handle)
    const stored = readMeta(handle, 'embedding_model')
    const health = await this.embeddingHealth()
    const failed = (this.jobs.get(dir)?.error ?? null) !== null
    if (counts.chunks > counts.embedded && !failed) this.startEmbedding(dir)
    const stats: LibraryStats = {
      dir,
      documents: counts.documents,
      chunks: counts.chunks,
      embedded: counts.embedded,
      configuredModel: this.embeddingSettings().model,
      embeddingModel: stored === null ? '' : stored,
      embeddingReady: health.ready,
      embedding: this.embeddingProgress(dir),
      ...measureLibrary(dir),
    }
    return { dir, library: true, scope, stats, documents: listDocuments(handle) }
  }

  /** One document with its first chunks, for the detail view. */
  async detail(dirInput: string, id: string): Promise<{ document: DocumentView; chunks: ChunkView[] }> {
    const dir = this.requireLibrary(dirInput)
    const handle = this.kb(dir)
    const document = getDocument(handle, id)
    if (document === null) throw new CyberSelfError(404, `没有这个文档：${id}`)
    return { document, chunks: listChunks(handle, id, 200) }
  }

  private async citations(dir: string, text: string): Promise<SearchView> {
    const handle = this.kb(dir)
    const health = await this.embeddingHealth()
    const counts = libraryStats(handle)
    const stored = readMeta(handle, 'embedding_model')
    const model = this.embeddingSettings().model
    let vector: Float32Array | null = null
    let note: string | null = health.message

    if (!health.ready) {
      note = `${health.message ?? '嵌入服务不可用'}，这次只用关键词检索`
    } else if (counts.embedded === 0) {
      note = '资料库里还没有向量，这次只用关键词检索'
    } else if (stored !== null && stored !== model) {
      note = `资料库的向量来自 ${stored}，与当前模型 ${model} 不同，这次只用关键词检索`
    } else {
      const [embedding] = await this.embedder().embed([text])
      vector = embedding ?? null
    }

    const retrieval = retrieve(handle, { text, vector }, this.deps.config().retrieval)
    const citations: Citation[] = materializeCitations(retrieval.hits)
    return {
      query: text,
      citations,
      vectorHits: retrieval.vectorHits,
      keywordHits: retrieval.keywordHits,
      note: citations.length === 0 && note === null ? '资料库里没有匹配的内容' : note,
    }
  }

  /** Retrieval only, used by the tools and the search box. */
  async search(dirInput: string, text: string): Promise<SearchView> {
    const dir = this.requireLibrary(dirInput)
    const query = text.trim()
    if (query === '') throw new CyberSelfError(400, '缺少查询内容')
    return this.citations(dir, query)
  }

  /** Retrieve, then answer. An empty retrieval never reaches the model. */
  async ask(input: {
    dir: string
    question: string
    signal: AbortSignal
    onToken?: (text: string) => void
  }): Promise<AnswerView> {
    const dir = this.requireLibrary(input.dir)
    const question = input.question.trim()
    if (question === '') throw new CyberSelfError(400, '缺少问题')
    const found = await this.citations(dir, question)
    if (found.citations.length === 0) {
      throw new CyberSelfError(422, `${found.note ?? '资料库里没有相关内容'}，请先导入相关资料再提问`)
    }
    const llm = this.deps.llm
    if (llm === null) throw new CyberSelfError(503, '没有可用的模型服务，无法生成回答')
    return answerQuestion(llm, this.deps.route(), {
      question,
      citations: found.citations,
      settings: this.deps.config().answer,
      maxEvidenceChars: this.deps.config().retrieval.maxEvidenceChars,
      signal: input.signal,
      ...(input.onToken === undefined ? {} : { onToken: input.onToken }),
    })
  }

  /** Import one file from an absolute Host path. */
  async importFromPath(dirInput: string, filePath: string, onProgress?: (progress: ImportProgress) => void): Promise<ImportView> {
    const dir = this.requireLibrary(dirInput)
    const absolute = resolve(filePath)
    const info = await stat(absolute).catch(() => null)
    if (info === null || !info.isFile()) throw new CyberSelfError(404, `文件不存在：${absolute}`)
    if (!isSupported(absolute)) throw new CyberSelfError(415, `不支持的文件类型：${basename(absolute)}`)
    const bytes = await readFile(absolute)
    const view = await importFile(this.kb(dir), { sourcePath: absolute, name: basename(absolute), bytes }, {
      config: this.deps.config(),
      vision: this.visionGrab(),
      ...(onProgress === undefined ? {} : { onProgress }),
    })
    if (view.document !== null) this.startEmbedding(dir)
    return view
  }

  /** Import one uploaded file sent as base64. */
  async importUpload(dirInput: string, name: string, data: string, onProgress?: (progress: ImportProgress) => void): Promise<ImportView> {
    const dir = this.requireLibrary(dirInput)
    if (data.length > MAX_BASE64_CHARS) {
      throw new CyberSelfError(413, `${name} 超过 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB，无法导入`)
    }
    if (!isSupported(name)) throw new CyberSelfError(415, `不支持的文件类型：${name}`)
    const bytes = Buffer.from(data, 'base64')
    const view = await importFile(this.kb(dir), { sourcePath: name, name, bytes }, {
      config: this.deps.config(),
      vision: this.visionGrab(),
      ...(onProgress === undefined ? {} : { onProgress }),
    })
    if (view.document !== null) this.startEmbedding(dir)
    return view
  }

  /**
   * List importable files under a Host directory, so the UI can show what an
   * import would cost before the model starts working through it.
   */
  async scan(dirInput: string, path: string): Promise<ScanView> {
    this.requireLibrary(dirInput)
    const root = resolve(path)
    if (!await isDirectory(root)) throw new CyberSelfError(404, `目录不存在：${root}`)
    const files: string[] = []
    const skipped: string[] = []
    let totalBytes = 0
    let images = 0
    const walk = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name)) continue
          await walk(full)
          continue
        }
        if (!entry.isFile()) continue
        const extension = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.includes(extension)) {
          skipped.push(full)
          continue
        }
        files.push(full)
        totalBytes += (await stat(full)).size
        if (isImageName(entry.name)) images += 1
      }
    }
    await walk(root)
    files.sort()
    return { files, skipped, totalBytes, images }
  }

  /** Remove a document and its chunks, then return the freed disk space. */
  async removeDocument(dirInput: string, id: string): Promise<{ deleted: boolean }> {
    const dir = this.requireLibrary(dirInput)
    const handle = this.kb(dir)
    const deleted = deleteDocumentRow(handle, id)
    if (!deleted) throw new CyberSelfError(404, `没有这个文档：${id}`)
    reclaimSpace(handle)
    return { deleted }
  }

  /** Remove every document of one library; the marker and the settings stay. */
  async purge(dirInput: string): Promise<PurgeView> {
    const dir = this.requireLibrary(dirInput)
    const before = measureLibrary(dir)
    const handle = this.kb(dir)
    const removed = purgeDocuments(handle)
    reclaimSpace(handle)
    const after = measureLibrary(dir)
    this.jobs.delete(dir)
    return { dir, removed, reclaimed: Math.max(0, before.bytes - after.bytes) }
  }

  /**
   * Delete one library together with its files: the database, the vectors and
   * the marker that made the workspace a library.
   */
  forget(dirInput: string): ForgetView {
    const dir = this.resolveDir(dirInput)
    const handle = this.handles.get(dir)
    if (handle !== undefined) {
      closeKb(handle)
      this.handles.delete(dir)
    }
    this.jobs.delete(dir)
    const location = locateKb(dir)
    const existed = existsSync(location.root)
    rmSync(location.root, { recursive: true, force: true })
    return { dir, removed: existed }
  }

  /** Every library on disk, with the space it occupies. */
  storage(): StorageView {
    const libraries: LibraryStorage[] = []
    for (const workspace of this.deps.listWorkspaces()) {
      const dir = workspace.path
      if (!isLibraryWorkspace(dir)) continue
      const usage = measureLibrary(dir)
      const present = existsSync(usage.file)
      const counts = present
        ? libraryStats(this.kb(dir))
        : { documents: 0, chunks: 0, embedded: 0 }
      libraries.push({
        dir,
        title: workspace.title,
        scope: libraryScope(dir),
        documents: counts.documents,
        chunks: counts.chunks,
        embedded: counts.embedded,
        bytes: usage.bytes,
        file: usage.file,
        updatedAt: usage.updatedAt,
      })
    }
    const totals = libraries.reduce(
      (sum, library) => ({
        libraries: sum.libraries + 1,
        documents: sum.documents + library.documents,
        chunks: sum.chunks + library.chunks,
        embedded: sum.embedded + library.embedded,
        bytes: sum.bytes + library.bytes,
      }),
      { libraries: 0, documents: 0, chunks: 0, embedded: 0, bytes: 0 },
    )
    return { root: KB_DIRECTORY, settingsFile: settingsFile(), libraries, totals }
  }

  /**
   * Start embedding every chunk that lacks a vector, after a model change for
   * example. The run continues in the background; its progress is reported by
   * {@link library}.
   */
  async embedMissing(dirInput: string): Promise<{ remaining: number }> {
    const dir = this.requireLibrary(dirInput)
    const handle = this.kb(dir)
    const stored = readMeta(handle, 'embedding_model')
    if (stored !== null && stored !== this.embeddingSettings().model) clearEmbeddings(handle)
    const remaining = countPendingChunks(handle)
    if (this.jobs.get(dir)?.running !== true) {
      this.jobs.delete(dir)
      this.startEmbedding(dir)
    }
    return { remaining }
  }

  /** Wait until the background run of one library has nothing left to do. */
  async waitForEmbedding(dirInput: string): Promise<void> {
    const dir = this.resolveDir(dirInput)
    await this.runs.get(dir)
  }

  /** Current settings, plus whether the embedding endpoint answers right now. */
  async settings(): Promise<SettingsView> {
    const embedding = this.embeddingSettings()
    this.health = null
    const probe = await this.embedder().probe()
    const installed = await this.embedder().models()
    const view: EmbeddingSettingsView = {
      baseURL: embedding.baseURL,
      model: embedding.model,
      timeoutMs: embedding.timeoutMs,
      batchSize: embedding.batchSize,
      maxChars: embedding.maxChars,
      dedupeNumbers: embedding.dedupeNumbers,
      reachable: probe.ready,
      note: probe.message,
      installed,
    }
    return { embedding: view, workspaces: this.choices(), file: settingsFile() }
  }

  /** Persist embedding overrides, then report the state that took effect. */
  async saveSettings(patch: StoredEmbeddingSettings): Promise<SettingsView> {
    if (Object.keys(patch).length > 0) {
      const previous = this.embeddingSettings()
      const next = { ...previous, ...patch }
      const rebuilt = next.model !== previous.model
        || next.maxChars !== previous.maxChars
        || next.dedupeNumbers !== previous.dedupeNumbers
      if (rebuilt) {
        const probe = await createOllamaEmbedder(next).probe()
        if (!probe.ready) {
          throw new CyberSelfError(409, `设置没有保存：改完要重建全部向量，而新的嵌入服务现在不可用（${probe.message ?? '探测失败'}）`)
        }
      }
      this.storedEmbedding = this.deps.writeEmbeddingSettings(patch)
      this.health = null
      for (const dir of [...this.jobs.keys()]) {
        if (this.jobs.get(dir)?.running !== true) this.jobs.delete(dir)
      }
      if (rebuilt) {
        for (const [dir, handle] of this.handles) {
          clearEmbeddings(handle)
          this.startEmbedding(dir)
        }
      }
    }
    return this.settings()
  }

  private visionGrab(): VisionTranscriber | null {
    return this.deps.llm === null || this.deps.attachments === null
      ? null
      : createVisionTranscriber(this.deps.llm, this.deps.attachments, () => this.deps.route(), () => this.deps.config().ocr)
  }
}
