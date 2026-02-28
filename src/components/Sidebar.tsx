import { useState, useEffect, useCallback } from 'react'
import type { FileTreeEntry } from '../../electron/types'

interface Props {
  workspace: string
  onWorkspaceChange: (ws: string) => void
  onFileClick: (filePath: string) => void
  serverOnline: boolean
  onReset: () => void
}

function FileIcon({ name, isDir }: { name: string; isDir: boolean }) {
  if (isDir) return <span className="text-blue-400 text-[11px]">📁</span>
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const icons: Record<string, string> = {
    ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️', json: '📋',
    py: '🐍', rs: '🦀', go: '🔵', java: '☕', rb: '💎',
    md: '📝', txt: '📄', yml: '⚙️', yaml: '⚙️', toml: '⚙️',
    html: '🌐', css: '🎨', scss: '🎨', svg: '🖼️', png: '🖼️',
    sh: '🐚', bash: '🐚', dockerfile: '🐳',
    lock: '🔒', gitignore: '👁️',
  }
  return <span className="text-[11px] opacity-70">{icons[ext] ?? '📄'}</span>
}

function TreeNode({
  entry, depth, onFileClick,
}: {
  entry: FileTreeEntry; depth: number; onFileClick: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(depth < 1)

  if (!entry.isDir) {
    return (
      <button
        onClick={() => onFileClick(entry.path)}
        className="w-full flex items-center gap-1.5 py-[3px] px-2 hover:bg-zinc-800/60 rounded text-xs cursor-pointer select-none text-left"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <FileIcon name={entry.name} isDir={false} />
        <span className="truncate text-zinc-300">{entry.name}</span>
      </button>
    )
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-1.5 py-[3px] px-2 hover:bg-zinc-800/60 rounded text-xs cursor-pointer select-none"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <span className="text-zinc-500 text-[10px] w-3 text-center">{expanded ? '▼' : '▶'}</span>
        <FileIcon name={entry.name} isDir={true} />
        <span className="truncate text-zinc-200 font-medium">{entry.name}</span>
      </button>
      {expanded && entry.children?.map((child) => (
        <TreeNode key={child.path} entry={child} depth={depth + 1} onFileClick={onFileClick} />
      ))}
    </div>
  )
}

export function Sidebar({ workspace, onWorkspaceChange, onFileClick, serverOnline, onReset }: Props) {
  const [tree, setTree] = useState<FileTreeEntry[]>([])
  const [loading, setLoading] = useState(false)

  const loadTree = useCallback(async () => {
    if (!workspace) { setTree([]); return }
    setLoading(true)
    try {
      const files = await window.api.listFiles(workspace)
      setTree(files)
    } catch {
      setTree([])
    }
    setLoading(false)
  }, [workspace])

  useEffect(() => { loadTree() }, [loadTree])

  const handlePickDir = async () => {
    const dir = await window.api.pickDirectory()
    if (dir) onWorkspaceChange(dir)
  }

  const dirName = workspace ? workspace.split(/[\\/]/).pop() || workspace : null

  return (
    <aside className="h-full bg-[#010409] border-r border-zinc-800/60 flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-zinc-800/60 flex items-center gap-2">
        <button
          onClick={handlePickDir}
          className="flex-1 flex items-center gap-2 min-w-0 hover:text-blue-400 transition-colors cursor-pointer"
          title={workspace || 'Открыть проект'}
        >
          <span className="text-sm">⚡</span>
          {dirName ? (
            <span className="text-[12px] font-semibold truncate">{dirName}</span>
          ) : (
            <span className="text-[12px] text-zinc-500">Открыть проект…</span>
          )}
        </button>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onReset}
            title="Новый чат"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[10px]"
          >
            ✦
          </button>
          <button
            onClick={loadTree}
            title="Обновить"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[11px]"
          >
            ↻
          </button>
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {!workspace && (
          <div className="px-4 py-8 text-center">
            <button
              onClick={handlePickDir}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
            >
              📂 Открыть проект
            </button>
            <p className="text-[10px] text-zinc-600 mt-2">Выбери директорию</p>
          </div>
        )}
        {workspace && loading && (
          <div className="px-4 py-4 text-xs text-zinc-500">Загрузка…</div>
        )}
        {workspace && !loading && tree.length === 0 && (
          <div className="px-4 py-4 text-xs text-zinc-500">Пусто</div>
        )}
        {tree.map((entry) => (
          <TreeNode key={entry.path} entry={entry} depth={0} onFileClick={onFileClick} />
        ))}
      </div>

      {/* Status */}
      <div className="px-3 py-1.5 border-t border-zinc-800/60 flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${serverOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className="text-[10px] text-zinc-500 truncate">
          {serverOnline ? 'Онлайн' : 'Оффлайн'}
        </span>
      </div>
    </aside>
  )
}
