/**
 * The settings page: where the embedding endpoint is configured and where each
 * workspace is turned into a library.
 * @module cyberself/client/settings
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Button, Input, SegmentedControl, type SegmentedControlOption } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  SETTINGS_PATH,
  type AnswerScope,
  type ForgetView,
  type LibraryStorage,
  type PurgeView,
  type SettingsView,
  type StorageView,
  type WorkspaceChoice,
} from '../shared/protocol.ts'
import { formatSize, postJson } from './base.ts'
import {
  forgetLibrary,
  invalidateLibraries,
  loadStorage,
  markLibrary,
  purgeLibrary,
} from './data.ts'

/** Props the settings shell hands to every section. */
interface SettingsSectionProps {
  close: () => void
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

const SCOPE_OPTIONS: readonly SegmentedControlOption<AnswerScope>[] = [
  { value: 'library', label: '仅资料库' },
  { value: 'open', label: '允许补充' },
]

const DEDUPE_OPTIONS: readonly SegmentedControlOption<string>[] = [
  { value: 'on', label: '只有数字不同就共用向量' },
  { value: 'off', label: '每块单独生成' },
]

export function LibrarySettings(props: SettingsSectionProps): ReactElement {
  const [view, setView] = useState<SettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('')
  const [batchSize, setBatchSize] = useState('')
  const [maxChars, setMaxChars] = useState('')
  const [dedupeNumbers, setDedupeNumbers] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [storage, setStorage] = useState<StorageView | null>(null)
  const [pending, setPending] = useState<{ dir: string; mode: 'purge' | 'forget' } | null>(null)

  const adopt = useCallback((next: SettingsView): void => {
    setView(next)
    setBaseURL(next.embedding.baseURL)
    setModel(next.embedding.model)
    setTimeoutMs(String(next.embedding.timeoutMs))
    setBatchSize(String(next.embedding.batchSize))
    setMaxChars(String(next.embedding.maxChars))
    setDedupeNumbers(next.embedding.dedupeNumbers)
  }, [])

  const load = useCallback((): void => {
    setBusy(true)
    postJson<SettingsView>(SETTINGS_PATH, {})
      .then((next) => {
        adopt(next)
        setError(null)
      })
      .catch((reason: unknown) => {
        setError(message(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }, [adopt])

  useEffect(() => {
    load()
  }, [load])

  const reloadStorage = useCallback((): void => {
    loadStorage()
      .then((next) => {
        setStorage(next)
      })
      .catch((reason: unknown) => {
        setError(message(reason))
      })
  }, [])

  useEffect(() => {
    reloadStorage()
  }, [reloadStorage])

  const save = (): void => {
    setBusy(true)
    setError(null)
    setNote(null)
    postJson<SettingsView>(SETTINGS_PATH, {
      embedding: {
        baseURL,
        model,
        timeoutMs: Number(timeoutMs),
        batchSize: Number(batchSize),
        maxChars: Number(maxChars),
        dedupeNumbers,
      },
    })
      .then((next) => {
        adopt(next)
        setNote('已保存')
      })
      .catch((reason: unknown) => {
        setError(message(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const toggle = (workspace: WorkspaceChoice): void => {
    setBusy(true)
    setError(null)
    setNote(null)
    markLibrary(workspace.path, !workspace.library)
      .then((result) => {
        setView((current) => current === null
          ? current
          : {
            ...current,
            workspaces: current.workspaces.map((candidate) => (
              candidate.path === result.dir
                ? { ...candidate, library: result.library, scope: result.scope }
                : candidate
            )),
          })
        setNote(result.library ? `已把《${workspace.title}》设为资料库` : `已把《${workspace.title}》移出资料库`)
        invalidateLibraries()
      })
      .catch((reason: unknown) => {
        setError(message(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const changeScope = (workspace: WorkspaceChoice, next: AnswerScope): void => {
    if (next === workspace.scope) return
    setBusy(true)
    setError(null)
    setNote(null)
    markLibrary(workspace.path, true, next)
      .then((result) => {
        setView((current) => current === null
          ? current
          : {
            ...current,
            workspaces: current.workspaces.map((candidate) => (
              candidate.path === result.dir
                ? { ...candidate, library: result.library, scope: result.scope }
                : candidate
            )),
          })
        setNote(next === 'library'
          ? `《${workspace.title}》只依据资料原文回答`
          : `《${workspace.title}》允许补充资料库外的内容`)
        invalidateLibraries()
      })
      .catch((reason: unknown) => {
        setError(message(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const clearData = (entry: LibraryStorage, mode: 'purge' | 'forget'): void => {
    setPending(null)
    setBusy(true)
    setError(null)
    setNote(null)
    const work = mode === 'purge' ? purgeLibrary(entry.dir) : forgetLibrary(entry.dir)
    work
      .then(async (result) => {
        setNote(mode === 'purge'
          ? `已清空《${entry.title}》：删除 ${(result as PurgeView).removed} 份资料，释放 ${formatSize((result as PurgeView).reclaimed)}`
          : `已删除《${entry.title}》的资料库文件：${(result as ForgetView).removed ? '已移除' : '本来就不存在'}`)
        invalidateLibraries()
        adopt(await postJson<SettingsView>(SETTINGS_PATH, {}))
        reloadStorage()
      })
      .catch((reason: unknown) => {
        setError(message(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const embedding = view?.embedding ?? null

  return (
    <div className="cs-settings">
      <div className="cs-settings-head">
        <h2 className="cs-settings-title">资料库</h2>
        <span className="cs-grow" />
        <Button size="sm" variant="outline" disabled={busy} onClick={load}>重新检测</Button>
        <Button size="sm" variant="ghost" onClick={props.close}>关闭</Button>
      </div>

      <section className="cs-settings-block">
        <h3 className="cs-settings-subtitle">嵌入服务</h3>
        <p className="cs-muted">
          资料分块后用这里的模型生成向量，检索时先算向量再补关键词。
          {view === null ? '' : `设置保存在 ${view.file}。`}
        </p>
        <div className="cs-settings-grid">
          <label className="cs-field">
            <span>服务地址</span>
            <Input value={baseURL} placeholder="http://127.0.0.1:11434" onChange={(event) => { setBaseURL(event.currentTarget.value) }} />
          </label>
          <label className="cs-field">
            <span>模型</span>
            <Input value={model} placeholder="bge-m3:latest" list="cyberself-models" onChange={(event) => { setModel(event.currentTarget.value) }} />
            <datalist id="cyberself-models">
              {(embedding?.installed ?? []).map((name) => <option key={name} value={name} />)}
            </datalist>
          </label>
          <label className="cs-field">
            <span>单次超时（毫秒）</span>
            <Input value={timeoutMs} onChange={(event) => { setTimeoutMs(event.currentTarget.value) }} />
          </label>
          <label className="cs-field">
            <span>每批条数</span>
            <Input value={batchSize} onChange={(event) => { setBatchSize(event.currentTarget.value) }} />
          </label>
          <label className="cs-field">
            <span>每块字符上限（0 表示整块送进模型）</span>
            <Input value={maxChars} onChange={(event) => { setMaxChars(event.currentTarget.value) }} />
          </label>
          <label className="cs-field cs-field-wide">
            <span>表格分块去重</span>
            <SegmentedControl
              id="cs-settings-dedupe"
              value={dedupeNumbers ? 'on' : 'off'}
              options={DEDUPE_OPTIONS}
              onChange={(next) => { setDedupeNumbers(next === 'on') }}
              label="表格分块去重"
              className="cs-segments"
            />
          </label>
        </div>
        <p className="cs-muted">
          模型、每块字符上限或表格分块去重改变后，保存会清空已有向量并在后台重新向量化全部资料。
        </p>
        <div className="cs-settings-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={save}>保存</Button>
          <span className={embedding !== null && embedding.reachable ? 'cs-ok' : 'cs-warn'}>
            {embedding === null ? '' : embedding.reachable ? '连接正常' : '连接失败'}
          </span>
          {embedding?.note === null || embedding === null ? null : <span className="cs-error">{embedding.note}</span>}
        </div>
      </section>

      <section className="cs-settings-block">
        <h3 className="cs-settings-subtitle">工作区</h3>
        <p className="cs-muted">
          被设为资料库的工作区会建一个独立的库，对话里只检索这个库。回答范围决定模型能不能用其他工具取用资料库以外的内容。
        </p>
        <div className="cs-list">
          {(view?.workspaces ?? []).map((workspace) => (
            <div key={workspace.id} className="cs-doc">
              <span className="cs-doc-main">
                <span className="cs-name">{workspace.title}</span>
              </span>
              <SegmentedControl
                id={`cs-settings-scope-${workspace.id}`}
                value={workspace.scope}
                options={SCOPE_OPTIONS}
                onChange={(next) => { changeScope(workspace, next) }}
                label={`${workspace.title} 的回答范围`}
                disabled={busy || !workspace.library}
                className="cs-segments"
              />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { toggle(workspace) }}>
                {workspace.library ? '移出资料库' : '设为资料库'}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="cs-settings-block">
        <h3 className="cs-settings-subtitle">存储</h3>
        <p className="cs-muted">
          每个资料库各自一个 SQLite 文件，放在工作区下的 <code>{storage?.root ?? '.cyberself'}</code> 目录里；
          资料原文、分块与向量都只存在这些文件中。插件自身的设置保存在 <code>{storage?.settingsFile ?? ''}</code>。
        </p>
        {storage === null ? <p className="cs-muted">正在读取存储信息</p> : (
          <>
            <div className="cs-storage-totals">
              <span>{storage.libraries.length} 个资料库</span>
              <span>{storage.totals.documents} 份资料</span>
              <span>{storage.totals.chunks} 段分块</span>
              <span>已向量化 {storage.totals.embedded} 段</span>
              <span>合计占用 {formatSize(storage.totals.bytes)}</span>
            </div>
            {storage.libraries.length === 0 ? <p className="cs-muted">还没有资料库。把某个工作区设为资料库后，这里会显示它占用的空间。</p> : null}
            <div className="cs-list">
              {storage.libraries.map((entry) => (
                <div key={entry.dir} className="cs-doc cs-storage-row">
                  <span className="cs-doc-main">
                    <span className="cs-name">{entry.title}</span>
                    <span className="cs-muted">
                      {entry.documents} 份 · {entry.chunks} 段 · 已向量化 {entry.embedded} 段 · {formatSize(entry.bytes)}
                    </span>
                    <span className="cs-muted cs-path" title={entry.file}>{entry.file}</span>
                    <span className="cs-muted">
                      {entry.updatedAt === null ? '尚未写入' : `最后写入 ${new Date(entry.updatedAt).toLocaleString()}`}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || entry.documents === 0}
                    onClick={() => { setPending({ dir: entry.dir, mode: 'purge' }) }}
                  >
                    清空资料
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => { setPending({ dir: entry.dir, mode: 'forget' }) }}
                  >
                    删除数据
                  </Button>
                </div>
              ))}
            </div>
            {pending === null ? null : (
              <div className="cs-row cs-confirm">
                <span className="cs-muted">
                  {pending.mode === 'purge'
                    ? '清空后这个工作区仍是资料库，所有资料、分块与向量都会被删除，数据库文件随之缩小。'
                    : '删除数据会移除整个 .cyberself 目录（数据库、向量与资料库标记），这个工作区将不再是资料库。'}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    const entry = storage?.libraries.find((candidate) => candidate.dir === pending.dir)
                    if (entry !== undefined) clearData(entry, pending.mode)
                  }}
                >
                  确认
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPending(null) }}>取消</Button>
              </div>
            )}
          </>
        )}
      </section>

      {error === null ? null : <div className="cs-error">{error}</div>}
      {note === null ? null : <div className="cs-muted">{note}</div>}
    </div>
  )
}
