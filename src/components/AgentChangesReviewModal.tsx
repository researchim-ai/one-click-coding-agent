import { useEffect, useMemo, useState } from 'react'
import type { GitFileDiff, AgentFileChange } from '../../electron/git'

interface Props {
  workspace: string
  changes: AgentFileChange[]
  open: boolean
  busy?: boolean
  appLanguage?: 'ru' | 'en'
  onClose: () => void
  onOpenFile?: (filePath: string) => void | Promise<void>
  onKeepFile: (filePath: string) => void | Promise<void>
  onUndoFile: (filePath: string) => void | Promise<void>
  onKeepAll: () => void | Promise<void>
  onUndoAll: () => void | Promise<void>
}

function fullPath(workspace: string, relPath: string): string {
  const sep = workspace.includes('\\') ? '\\' : '/'
  return (workspace.replace(/[\\/]+$/, '') + sep + relPath.replace(/^[\\/]+/, '')).replace(/[/\\]+/g, sep)
}

function statusText(status: AgentFileChange['status'], lang: 'ru' | 'en'): string {
  if (lang === 'ru') {
    if (status === 'added' || status === 'untracked') return 'новый'
    if (status === 'deleted') return 'удалён'
    if (status === 'renamed') return 'переименован'
    return 'изменён'
  }
  if (status === 'added' || status === 'untracked') return 'new'
  if (status === 'deleted') return 'deleted'
  if (status === 'renamed') return 'renamed'
  return 'modified'
}

function statusClass(status: AgentFileChange['status']): string {
  if (status === 'added' || status === 'untracked') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
  if (status === 'deleted') return 'border-red-500/25 bg-red-500/10 text-red-300'
  if (status === 'renamed') return 'border-blue-500/25 bg-blue-500/10 text-blue-300'
  return 'border-amber-500/25 bg-amber-500/10 text-amber-300'
}

export function AgentChangesReviewModal({
  workspace,
  changes,
  open,
  busy = false,
  appLanguage = 'ru',
  onClose,
  onOpenFile,
  onKeepFile,
  onUndoFile,
  onKeepAll,
  onUndoAll,
}: Props) {
  const L = appLanguage === 'ru'
  const t = (ru: string, en: string) => (L ? ru : en)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, GitFileDiff | null>>({})
  const [loading, setLoading] = useState(false)
  const selectedChange = useMemo(
    () => changes.find((change) => change.path === selectedPath) ?? changes[0] ?? null,
    [changes, selectedPath],
  )
  const selectedDiff = selectedChange ? diffs[selectedChange.path] : null

  useEffect(() => {
    if (!open) return
    setSelectedPath((prev) => (prev && changes.some((change) => change.path === prev) ? prev : changes[0]?.path ?? null))
  }, [changes, open])

  useEffect(() => {
    if (!open || !workspace || changes.length === 0 || !window.api?.getGitFileDiff) {
      setDiffs({})
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all(changes.map(async (change) => {
      const path = fullPath(workspace, change.path)
      try {
        const diff = await window.api.getGitFileDiff(workspace, path)
        return [change.path, diff] as const
      } catch {
        return [change.path, null] as const
      }
    })).then((entries) => {
      if (!cancelled) setDiffs(Object.fromEntries(entries))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [changes, open, workspace])

  if (!open) return null

  const totals = changes.reduce((acc, change) => {
    acc.added += change.added
    acc.deleted += change.deleted
    return acc
  }, { added: 0, deleted: 0 })

  const selectedFullPath = selectedChange ? fullPath(workspace, selectedChange.path) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-[#0d1117] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-zinc-100">
              {t('Проверка изменений агента', 'Review agent changes')}
            </div>
            <div className="mt-0.5 text-xs text-zinc-500">
              {t(`${changes.length} файлов`, `${changes.length} files`)}
              <span className="mx-1 text-zinc-700">·</span>
              <span className="text-emerald-400">+{totals.added}</span>
              <span className="mx-1 text-zinc-700">/</span>
              <span className="text-red-400">-{totals.deleted}</span>
              {loading && <span className="ml-2 text-zinc-600">{t('загрузка diff…', 'loading diff…')}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={onKeepAll}
            disabled={busy || changes.length === 0}
            className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('Принять всё', 'Keep all')}
          </button>
          <button
            type="button"
            onClick={onUndoAll}
            disabled={busy || changes.length === 0}
            className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/18 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('Откатить всё', 'Undo all')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            {t('Закрыть', 'Close')}
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-zinc-800 bg-zinc-950/35 p-2">
            {changes.length === 0 && (
              <div className="p-4 text-center text-xs text-zinc-500">
                {t('Непринятых изменений нет.', 'No pending changes.')}
              </div>
            )}
            {changes.map((change) => {
              const selected = selectedChange?.path === change.path
              return (
                <button
                  key={change.path}
                  type="button"
                  onClick={() => setSelectedPath(change.path)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                    selected ? 'bg-blue-500/15 ring-1 ring-blue-500/35' : 'hover:bg-zinc-800/70'
                  }`}
                  title={change.path}
                >
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold ${statusClass(change.status)}`}>
                    {statusText(change.status, appLanguage)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{change.path}</span>
                  {(change.added > 0 || change.deleted > 0) && (
                    <span className="shrink-0 text-[10px] tabular-nums">
                      {change.added > 0 && <span className="text-emerald-400">+{change.added}</span>}
                      {change.added > 0 && change.deleted > 0 && <span className="mx-0.5 text-zinc-700">/</span>}
                      {change.deleted > 0 && <span className="text-red-400">-{change.deleted}</span>}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex min-h-0 flex-col">
            {selectedChange && selectedFullPath ? (
              <>
                <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-zinc-300" title={selectedFullPath}>
                      {selectedChange.path}
                    </div>
                    <div className="mt-0.5 text-[10px] text-zinc-600">
                      {selectedDiff?.hunks?.length ?? 0} {t('блоков изменений', 'hunks')}
                    </div>
                  </div>
                  {selectedChange.status !== 'deleted' && onOpenFile && (
                    <button
                      type="button"
                      onClick={() => onOpenFile(selectedFullPath)}
                      className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                    >
                      {t('Открыть файл', 'Open file')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onKeepFile(selectedFullPath)}
                    disabled={busy}
                    className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/18 disabled:opacity-50"
                  >
                    {t('Принять файл', 'Keep file')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onUndoFile(selectedFullPath)}
                    disabled={busy}
                    className="rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/18 disabled:opacity-50"
                  >
                    {t('Откатить файл', 'Undo file')}
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-950/35">
                  {selectedDiff?.hunks?.length ? (
                    selectedDiff.hunks.map((hunk, idx) => (
                      <div key={`${selectedChange.path}:${idx}`} className="border-b border-zinc-800/70">
                        <div className="flex items-center gap-2 bg-zinc-900/80 px-3 py-1.5 font-mono text-xs text-zinc-400">
                          <span>@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@</span>
                          <span className="ml-auto text-emerald-400">+{hunk.additions}</span>
                          <span className="text-red-400">-{hunk.removals}</span>
                        </div>
                        <pre className="text-[12px] font-mono leading-snug">
                          {hunk.lines.map((line, lineIdx) => {
                            const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
                            const cls = line.kind === 'add'
                              ? 'bg-emerald-500/10 text-emerald-200'
                              : line.kind === 'remove'
                                ? 'bg-red-500/10 text-red-200'
                                : 'text-zinc-400'
                            return (
                              <div key={lineIdx} className={`flex ${cls}`}>
                                <span className="w-10 shrink-0 select-none pr-2 text-right text-zinc-600">{line.oldLine ?? ''}</span>
                                <span className="w-10 shrink-0 select-none pr-2 text-right text-zinc-600">{line.newLine ?? ''}</span>
                                <span className="w-4 shrink-0 select-none text-center">{sign}</span>
                                <span className="min-w-0 flex-1 whitespace-pre pr-3">{line.text || '\u00A0'}</span>
                              </div>
                            )
                          })}
                        </pre>
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-sm text-zinc-500">
                      {loading ? t('Загружаю diff…', 'Loading diff…') : t('Diff недоступен или изменений нет.', 'Diff unavailable or no changes.')}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
                {t('Выбери файл для проверки.', 'Select a file to review.')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
