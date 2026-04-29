import { useMemo, useState } from 'react'
import type { HunkReviewPayload, HunkReviewHunk } from '../../electron/types'

interface Props {
  review: HunkReviewPayload
  onDecide: (
    approvalId: string,
    decision:
      | { decision: 'accept_all' }
      | { decision: 'accept_selected'; selectedHunkIds: number[] }
      | { decision: 'reject' },
  ) => void
  appLanguage?: 'ru' | 'en'
}

/** Inline diff + per-hunk accept/reject modal. The agent is blocked
 *  waiting for a decision — we always resolve by calling `onDecide`
 *  exactly once with one of {accept_all, accept_selected, reject}. */
export function HunkReviewModal({ review, onDecide, appLanguage = 'ru' }: Props) {
  const L = appLanguage
  const t = (ru: string, en: string) => (L === 'ru' ? ru : en)

  const [selected, setSelected] = useState<Set<number>>(() => new Set(review.hunks.map((h) => h.id)))

  const totalAdds = useMemo(() => review.hunks.reduce((a, h) => a + h.additions, 0), [review.hunks])
  const totalRems = useMemo(() => review.hunks.reduce((a, h) => a + h.removals, 0), [review.hunks])

  const toggleHunk = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setSelected((prev) => (prev.size === review.hunks.length ? new Set() : new Set(review.hunks.map((h) => h.id))))
  }

  const applySelected = () => {
    const ids = Array.from(selected).sort((a, b) => a - b)
    if (ids.length === review.hunks.length) {
      onDecide(review.approvalId, { decision: 'accept_all' })
    } else if (ids.length === 0) {
      onDecide(review.approvalId, { decision: 'reject' })
    } else {
      onDecide(review.approvalId, { decision: 'accept_selected', selectedHunkIds: ids })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 py-6">
      <div className="w-full max-w-4xl max-h-full flex flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
          <span className="text-blue-400 font-mono text-sm">{review.toolName}</span>
          <span className="text-zinc-400 font-mono text-sm flex-1 truncate" title={review.filePath}>
            {review.filePath}
          </span>
          {review.isNewFile && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              {t('новый файл', 'new file')}
            </span>
          )}
          <span className="text-xs text-emerald-400/80 font-mono">+{totalAdds}</span>
          <span className="text-xs text-red-400/80 font-mono">−{totalRems}</span>
        </div>

        <div className="px-4 py-2 border-b border-zinc-800/80 flex items-center gap-3 text-xs text-zinc-400">
          <button
            onClick={toggleAll}
            className="px-2 py-0.5 rounded hover:bg-zinc-800 text-zinc-300 border border-zinc-700/60 cursor-pointer"
          >
            {selected.size === review.hunks.length
              ? t('снять все', 'clear all')
              : t('выбрать все', 'select all')}
          </button>
          <span>
            {t(
              `${selected.size} из ${review.hunks.length} блоков выбрано`,
              `${selected.size} of ${review.hunks.length} hunks selected`,
            )}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto bg-zinc-950/40">
          {review.hunks.length === 0 && (
            <div className="p-6 text-center text-zinc-500 text-sm">
              {t('Изменений нет.', 'No changes.')}
            </div>
          )}
          {review.hunks.map((hunk) => (
            <HunkBlock
              key={hunk.id}
              hunk={hunk}
              selected={selected.has(hunk.id)}
              onToggle={() => toggleHunk(hunk.id)}
              appLanguage={L}
            />
          ))}
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
          <button
            onClick={() => onDecide(review.approvalId, { decision: 'reject' })}
            className="px-3 py-1.5 rounded text-zinc-300 bg-zinc-800 hover:bg-zinc-700 text-sm cursor-pointer"
          >
            {t('Отклонить всё', 'Reject all')}
          </button>
          <button
            onClick={() => onDecide(review.approvalId, { decision: 'accept_all' })}
            className="px-3 py-1.5 rounded text-white bg-blue-600/80 hover:bg-blue-500 text-sm cursor-pointer"
          >
            {t('Принять всё', 'Accept all')}
          </button>
          <button
            onClick={applySelected}
            disabled={selected.size === 0 || selected.size === review.hunks.length}
            className="px-3 py-1.5 rounded text-white bg-emerald-600/80 hover:bg-emerald-500 text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('Применить только выбранные блоки', 'Apply only the ticked hunks')}
          >
            {t('Применить выбранные', 'Apply selected')}
          </button>
        </div>
      </div>
    </div>
  )
}

function HunkBlock({
  hunk,
  selected,
  onToggle,
  appLanguage,
}: {
  hunk: HunkReviewHunk
  selected: boolean
  onToggle: () => void
  appLanguage: 'ru' | 'en'
}) {
  const t = (ru: string, en: string) => (appLanguage === 'ru' ? ru : en)
  return (
    <div className={`border-b border-zinc-800/60 ${selected ? '' : 'opacity-50'}`}>
      <div className="px-3 py-1.5 bg-zinc-900/70 text-xs text-zinc-400 font-mono flex items-center gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="accent-emerald-500 cursor-pointer"
          aria-label={t('Принять этот блок', 'Accept this hunk')}
        />
        <span>
          @@ −{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
        </span>
        <span className="flex-1" />
        <span className="text-emerald-400/80">+{hunk.additions}</span>
        <span className="text-red-400/80">−{hunk.removals}</span>
      </div>
      <pre className="px-0 py-0 text-[12px] font-mono leading-snug whitespace-pre overflow-x-auto">
        {hunk.lines.map((line, idx) => {
          const bg =
            line.kind === 'add'
              ? 'bg-emerald-500/10 text-emerald-200'
              : line.kind === 'remove'
                ? 'bg-red-500/10 text-red-200'
                : 'text-zinc-400'
          const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
          const lineNumOld = line.oldLine != null ? String(line.oldLine) : ''
          const lineNumNew = line.newLine != null ? String(line.newLine) : ''
          return (
            <div key={idx} className={`flex ${bg}`}>
              <span className="w-10 shrink-0 text-right pr-2 text-zinc-600 select-none">{lineNumOld}</span>
              <span className="w-10 shrink-0 text-right pr-2 text-zinc-600 select-none">{lineNumNew}</span>
              <span className="w-4 shrink-0 text-center select-none">{sign}</span>
              <span className="flex-1 pr-3 whitespace-pre">{line.text || '\u00A0'}</span>
            </div>
          )
        })}
      </pre>
    </div>
  )
}
