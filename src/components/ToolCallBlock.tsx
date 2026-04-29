import { useState, memo } from 'react'

interface Props {
  name: string
  args: Record<string, unknown>
  result?: string
  approvalId?: string
  approvalStatus?: 'pending' | 'approved' | 'denied'
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  appLanguage?: 'ru' | 'en'
  checkpointSha?: string
  checkpointLabel?: string
  checkpointRestored?: boolean
  onRestoreCheckpoint?: (sha: string, mode: 'files' | 'files+task') => void | Promise<void>
  workspace?: string
  onOpenFile?: (path: string) => void | Promise<void>
}

const TOOL_ICONS: Record<string, string> = {
  read_file: '○',
  write_file: '●',
  edit_file: '◐',
  list_directory: '◇',
  find_files: '◈',
  execute_command: '▸',
  create_directory: '◇',
  delete_file: '✕',
}

function formatArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'delete_file':
    case 'edit_file':
    case 'create_directory':
      return String(args.path ?? '')
    case 'list_directory':
      return String(args.path ?? '.') + (args.depth ? ` (depth: ${args.depth})` : '')
    case 'find_files':
      return `${args.type === 'content' ? 'grep' : 'glob'}: ${args.pattern}`
    case 'execute_command':
      return String(args.command ?? '')
    default: {
      const first = Object.values(args)[0]
      return typeof first === 'string' ? first : ''
    }
  }
}

function toolFilePath(name: string, args: Record<string, unknown>): string | null {
  if (!['read_file', 'write_file', 'edit_file', 'append_file', 'delete_file'].includes(name)) return null
  const p = args.path
  return typeof p === 'string' && p.trim() ? p.trim() : null
}

function resolveWorkspacePath(workspace: string | undefined, filePath: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|\/)/.test(filePath)) return filePath
  if (!workspace?.trim()) return filePath
  const sep = workspace.includes('\\') ? '\\' : '/'
  return `${workspace.replace(/[\\/]+$/, '')}${sep}${filePath.replace(/^[.\\/]+/, '')}`
}

export const ToolCallBlock = memo(function ToolCallBlock({
  name, args, result, approvalId, approvalStatus, onApprove, onDeny, appLanguage = 'ru',
  checkpointSha, checkpointLabel, checkpointRestored, onRestoreCheckpoint, workspace, onOpenFile,
}: Props) {
  const L = appLanguage
  const t = (ru: string, en: string) => (L === 'ru' ? ru : en)
  const [expanded, setExpanded] = useState(false)
  const [restoreMenu, setRestoreMenu] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const icon = TOOL_ICONS[name] ?? '◦'
  const brief = formatArgs(name, args)
  const truncBrief = brief.length > 90 ? brief.slice(0, 87) + '…' : brief
  const isError = result?.startsWith('Error:') || result?.startsWith('[Denied')
  const isComplete = result !== undefined
  const isPending = approvalStatus === 'pending'
  const isDenied = approvalStatus === 'denied'
  const filePath = toolFilePath(name, args)

  const statusColor = isDenied
    ? 'text-red-400/70'
    : isComplete
      ? isError ? 'text-red-400/70' : 'text-emerald-400/70'
      : isPending ? 'text-amber-400/70' : 'text-zinc-600'

  const statusIcon = isDenied ? '✕' : isComplete ? (isError ? '✕' : '✓') : isPending ? '⏸' : '…'

  return (
    <div className={`rounded-md overflow-hidden text-xs font-mono ${
      isPending ? 'ring-1 ring-amber-500/30' : ''
    }`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded((v) => !v)
          }
        }}
        className="w-full px-2.5 py-1.5 bg-zinc-800/40 text-left hover:bg-zinc-800/70 transition-colors flex items-center gap-1.5 cursor-pointer group"
      >
        <span className="text-zinc-600 text-[10px] group-hover:text-zinc-400 transition-colors">{icon}</span>
        <span className="text-blue-400/80 font-semibold">{name}</span>
        {filePath && onOpenFile ? (
          <button
            type="button"
            title={t('Открыть файл', 'Open file')}
            onClick={(e) => {
              e.stopPropagation()
              onOpenFile(resolveWorkspacePath(workspace, filePath))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onOpenFile(resolveWorkspacePath(workspace, filePath))
              }
            }}
            className="text-sky-300/85 hover:text-sky-200 hover:underline underline-offset-2 truncate flex-1 min-w-0 cursor-pointer"
          >
            {truncBrief}
          </button>
        ) : (
          <span className="text-zinc-600 truncate flex-1 min-w-0">{truncBrief}</span>
        )}
        <span className={`${statusColor} shrink-0 text-[10px]`}>{statusIcon}</span>
      </div>

      {isPending && approvalId && (
        <div className="flex items-center gap-2 px-2.5 py-2 bg-amber-500/5 border-t border-amber-500/15">
          <span className="text-[11px] text-amber-300/80 flex-1">{t('Разрешить выполнение?', 'Allow execution?')}</span>
          <button
            onClick={() => onApprove?.(approvalId)}
            className="px-2.5 py-1 bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] rounded font-medium cursor-pointer transition-colors"
          >
            {t('Да', 'Yes')}
          </button>
          <button
            onClick={() => onDeny?.(approvalId)}
            className="px-2.5 py-1 bg-zinc-700/60 hover:bg-zinc-600 text-zinc-300 text-[11px] rounded font-medium cursor-pointer transition-colors"
          >
            {t('Нет', 'No')}
          </button>
        </div>
      )}

      {expanded && (
        <div className="bg-zinc-950/60 border-t border-zinc-800/40">
          {!isComplete && (
            <pre className="px-2.5 py-1.5 text-zinc-600 text-[11px] whitespace-pre-wrap">
              {JSON.stringify(args, null, 2)}
            </pre>
          )}
          {result && (
            <pre className={`px-2.5 py-1.5 text-[11px] whitespace-pre-wrap max-h-60 overflow-y-auto ${
              isError ? 'text-red-400/80' : 'text-zinc-500'
            }`}>
              {result}
            </pre>
          )}
        </div>
      )}

      {checkpointSha && !isPending && isComplete && !isError && (
        <div className="px-2.5 py-0.5 border-t border-zinc-800/30 flex items-center justify-end gap-2 text-[10.5px]">
          {checkpointRestored ? (
            <span className="text-emerald-400/80">
              {t('восстановлено ✓', 'restored ✓')}
            </span>
          ) : (
            <div className="relative">
              <button
                onClick={() => setRestoreMenu((v) => !v)}
                disabled={restoring}
                className="px-1.5 py-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 cursor-pointer transition-colors disabled:opacity-50"
                title={
                  (checkpointLabel ? `${checkpointLabel}\n` : '') +
                  `${t('снимок', 'snapshot')} ${checkpointSha.slice(0, 10)}`
                }
              >
                {restoring ? t('откат…', 'restoring…') : t('↩ откатить', '↩ restore')}
              </button>
              {restoreMenu && (
                <div className="absolute right-0 top-full mt-1 z-10 min-w-[220px] rounded-md border border-zinc-700/60 bg-zinc-900 shadow-lg py-1">
                  <button
                    onClick={async () => {
                      setRestoreMenu(false)
                      if (!onRestoreCheckpoint) return
                      setRestoring(true)
                      try { await onRestoreCheckpoint(checkpointSha, 'files') } finally { setRestoring(false) }
                    }}
                    className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 cursor-pointer"
                  >
                    {t('Только файлы', 'Files only')}
                    <div className="text-[10px] text-zinc-500">
                      {t('вернуть файлы, чат оставить', 'revert files, keep chat')}
                    </div>
                  </button>
                  <button
                    onClick={async () => {
                      setRestoreMenu(false)
                      if (!onRestoreCheckpoint) return
                      const ok = confirm(
                        t(
                          'Откатить файлы И удалить сообщения чата после этой точки?',
                          'Revert files AND delete chat messages after this point?',
                        ),
                      )
                      if (!ok) return
                      setRestoring(true)
                      try { await onRestoreCheckpoint(checkpointSha, 'files+task') } finally { setRestoring(false) }
                    }}
                    className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 cursor-pointer"
                  >
                    {t('Файлы + чат', 'Files + chat')}
                    <div className="text-[10px] text-zinc-500">
                      {t('откатить всё к этой точке', 'roll back everything to this point')}
                    </div>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
