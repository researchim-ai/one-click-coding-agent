type AgentFileChange = import('../../electron/git').AgentFileChange

interface Props {
  changes: AgentFileChange[]
  busy?: boolean
  appLanguage?: 'ru' | 'en'
  onReview: () => void
  onKeepAll: () => void | Promise<void>
  onUndoAll: () => void | Promise<void>
}

function changeKindText(changes: AgentFileChange[], lang: 'ru' | 'en'): string {
  const created = changes.filter((c) => c.status === 'added' || c.status === 'untracked').length
  const modified = changes.filter((c) => c.status === 'modified').length
  const deleted = changes.filter((c) => c.status === 'deleted').length
  const parts: string[] = []
  if (created) parts.push(lang === 'ru' ? `${created} новых` : `${created} new`)
  if (modified) parts.push(lang === 'ru' ? `${modified} изменённых` : `${modified} modified`)
  if (deleted) parts.push(lang === 'ru' ? `${deleted} удалённых` : `${deleted} deleted`)
  return parts.join(' · ')
}

export function AgentChangesBar({ changes, busy = false, appLanguage = 'ru', onReview, onKeepAll, onUndoAll }: Props) {
  if (changes.length === 0) return null
  const L = appLanguage === 'ru'
  const added = changes.reduce((sum, change) => sum + change.added, 0)
  const deleted = changes.reduce((sum, change) => sum + change.deleted, 0)
  const kinds = changeKindText(changes, appLanguage)

  return (
    <div className="shrink-0 border-t border-amber-500/20 bg-[#10151f]/95 px-3 py-2 shadow-[0_-10px_30px_rgba(0,0,0,0.25)]">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.55)]" />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-zinc-200">
              {L
                ? `Изменения агента: ${changes.length} ${changes.length === 1 ? 'файл' : 'файлов'}`
                : `Agent changes: ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`}
            </div>
            <div className="truncate text-[10px] text-zinc-500">
              {kinds || (L ? 'есть непринятые изменения' : 'pending changes')}
              {(added > 0 || deleted > 0) && (
                <>
                  <span className="mx-1 text-zinc-700">·</span>
                  {added > 0 && <span className="text-emerald-400">+{added}</span>}
                  {added > 0 && deleted > 0 && <span className="mx-1 text-zinc-700">/</span>}
                  {deleted > 0 && <span className="text-red-400">-{deleted}</span>}
                </>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onReview}
          disabled={busy}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-blue-500/60 hover:bg-blue-500/10 hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {L ? 'Проверить' : 'Review'}
        </button>
        <button
          type="button"
          onClick={onKeepAll}
          disabled={busy}
          className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-50"
          title={L ? 'Принять все изменения агента' : 'Keep all agent changes'}
        >
          {L ? 'Принять всё' : 'Keep all'}
        </button>
        <button
          type="button"
          onClick={onUndoAll}
          disabled={busy}
          className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/18 disabled:cursor-not-allowed disabled:opacity-50"
          title={L ? 'Откатить все изменения агента' : 'Undo all agent changes'}
        >
          {L ? 'Откатить всё' : 'Undo all'}
        </button>
      </div>
    </div>
  )
}
