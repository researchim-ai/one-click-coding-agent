import { useState, useEffect, useCallback, useRef, memo, type KeyboardEvent, type MouseEvent } from 'react'
import type { FileTreeEntry } from '../../electron/types'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface Props {
  workspace: string
  onWorkspaceChange: (ws: string) => void
  onFileClick: (filePath: string) => void
  serverOnline: boolean
  onReset: () => void
  onOpenTerminalAt?: (dir: string) => void
  onAttachToChat?: (filePath: string) => void
}

interface CtxMenuState {
  x: number
  y: number
  entry: FileTreeEntry
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
    c: '🇨', cpp: '⊕', h: '🇭', hpp: '⊕',
    swift: '🧡', kt: '🟣', dart: '🎯', vue: '💚', svelte: '🔥',
  }
  return <span className="text-[11px] opacity-70">{icons[ext] ?? '📄'}</span>
}

function InlineInput({
  onSubmit, onCancel, placeholder, depth, defaultValue,
}: {
  onSubmit: (name: string) => void
  onCancel: () => void
  placeholder: string
  depth: number
  defaultValue?: string
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    if (defaultValue) ref.current?.select()
  }, [defaultValue])

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const val = ref.current?.value.trim()
      if (val) onSubmit(val)
      else onCancel()
    }
    if (e.key === 'Escape') onCancel()
  }

  return (
    <div className="flex items-center gap-1.5 py-[2px] px-2" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
      <input
        ref={ref}
        type="text"
        defaultValue={defaultValue}
        placeholder={placeholder}
        onKeyDown={handleKey}
        onBlur={onCancel}
        className="flex-1 bg-zinc-800 border border-blue-500/60 rounded px-1.5 py-0.5 text-xs text-zinc-100 outline-none placeholder-zinc-600 min-w-0"
      />
    </div>
  )
}

function TreeNode({
  entry, depth, onFileClick, onRefresh, onContextMenu,
  renamingPath, ctxCreateAt, onRenameSubmit, onRenameCancel,
  onCtxCreateSubmit, onCtxCreateCancel,
}: {
  entry: FileTreeEntry
  depth: number
  onFileClick: (path: string) => void
  onRefresh: () => void
  onContextMenu: (e: MouseEvent, entry: FileTreeEntry) => void
  renamingPath: string | null
  ctxCreateAt: { dirPath: string; type: 'file' | 'dir' } | null
  onRenameSubmit: (newName: string) => void
  onRenameCancel: () => void
  onCtxCreateSubmit: (name: string) => void
  onCtxCreateCancel: () => void
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null)

  const isRenaming = renamingPath === entry.path
  const isCtxCreateTarget = ctxCreateAt?.dirPath === entry.path

  // auto-expand when context-menu create targets this dir
  useEffect(() => {
    if (isCtxCreateTarget) setExpanded(true)
  }, [isCtxCreateTarget])

  const handleCreate = async (name: string) => {
    const sep = entry.path.includes('\\') ? '\\' : '/'
    const fullPath = entry.path + sep + name
    try {
      if (creating === 'dir') {
        await window.api.createDirectory(fullPath)
      } else {
        await window.api.createFile(fullPath)
        onFileClick(fullPath)
      }
    } catch (e) {
      console.error('Create failed:', e)
    }
    setCreating(null)
    onRefresh()
  }

  const handleCtx = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e, entry)
  }

  if (isRenaming) {
    return (
      <InlineInput
        depth={depth}
        placeholder="новое имя…"
        defaultValue={entry.name}
        onSubmit={onRenameSubmit}
        onCancel={onRenameCancel}
      />
    )
  }

  if (!entry.isDir) {
    return (
      <button
        onClick={() => onFileClick(entry.path)}
        onContextMenu={handleCtx}
        className="w-full flex items-center gap-1.5 py-[3px] px-2 hover:bg-zinc-800/60 rounded text-xs cursor-pointer select-none text-left group"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <FileIcon name={entry.name} isDir={false} />
        <span className="truncate text-zinc-300">{entry.name}</span>
      </button>
    )
  }

  return (
    <div>
      <div
        onContextMenu={handleCtx}
        className="w-full flex items-center gap-1.5 py-[3px] px-2 hover:bg-zinc-800/60 rounded text-xs select-none group"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer text-left"
        >
          <span className="text-zinc-500 text-[10px] w-3 text-center">{expanded ? '▼' : '▶'}</span>
          <FileIcon name={entry.name} isDir={true} />
          <span className="truncate text-zinc-200 font-medium">{entry.name}</span>
        </button>
        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(true); setCreating('file') }}
            className="w-4 h-4 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 cursor-pointer text-[10px]"
            title="Новый файл"
          >+</button>
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(true); setCreating('dir') }}
            className="w-4 h-4 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 cursor-pointer text-[9px]"
            title="Новая папка"
          >📁</button>
        </div>
      </div>
      {expanded && (
        <>
          {isCtxCreateTarget && (
            <InlineInput
              depth={depth + 1}
              placeholder={ctxCreateAt.type === 'dir' ? 'имя папки…' : 'имя файла…'}
              onSubmit={onCtxCreateSubmit}
              onCancel={onCtxCreateCancel}
            />
          )}
          {creating && (
            <InlineInput
              depth={depth + 1}
              placeholder={creating === 'dir' ? 'имя папки…' : 'имя файла…'}
              onSubmit={handleCreate}
              onCancel={() => setCreating(null)}
            />
          )}
          {entry.children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              onRefresh={onRefresh}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              ctxCreateAt={ctxCreateAt}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onCtxCreateSubmit={onCtxCreateSubmit}
              onCtxCreateCancel={onCtxCreateCancel}
            />
          ))}
        </>
      )}
    </div>
  )
}

export const Sidebar = memo(function Sidebar({ workspace, onWorkspaceChange, onFileClick, serverOnline, onReset, onOpenTerminalAt, onAttachToChat }: Props) {
  const [tree, setTree] = useState<FileTreeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [creatingRoot, setCreatingRoot] = useState<'file' | 'dir' | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renamingOrigName, setRenamingOrigName] = useState<string>('')
  const [ctxCreateAt, setCtxCreateAt] = useState<{ dirPath: string; type: 'file' | 'dir' } | null>(null)

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

  const loadTreeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadTreeRef = useRef(loadTree)
  loadTreeRef.current = loadTree
  const debouncedLoadTree = useCallback(() => {
    if (loadTreeTimerRef.current) clearTimeout(loadTreeTimerRef.current)
    loadTreeTimerRef.current = setTimeout(() => {
      loadTreeTimerRef.current = null
      loadTreeRef.current()
    }, 500)
  }, [])

  useEffect(() => {
    if (!window.api?.onWorkspaceFilesChanged || !workspace) return
    const unsub = window.api.onWorkspaceFilesChanged(debouncedLoadTree)
    return () => {
      unsub()
      if (loadTreeTimerRef.current) {
        clearTimeout(loadTreeTimerRef.current)
        loadTreeTimerRef.current = null
      }
    }
  }, [workspace, debouncedLoadTree])

  const handlePickDir = async () => {
    const dir = await window.api.pickDirectory()
    if (dir) onWorkspaceChange(dir)
  }

  const handleCreateRoot = async (name: string) => {
    const sep = workspace.includes('\\') ? '\\' : '/'
    const fullPath = workspace + sep + name
    try {
      if (creatingRoot === 'dir') {
        await window.api.createDirectory(fullPath)
      } else {
        await window.api.createFile(fullPath)
        onFileClick(fullPath)
      }
    } catch (e) {
      console.error('Create failed:', e)
    }
    setCreatingRoot(null)
    loadTree()
  }

  const handleRenameSubmit = async (newName: string) => {
    if (!renamingPath) return
    const sep = renamingPath.includes('\\') ? '\\' : '/'
    const parts = renamingPath.split(sep)
    parts[parts.length - 1] = newName
    const newPath = parts.join(sep)
    try {
      await window.api.renameFile(renamingPath, newPath)
    } catch (e) {
      console.error('Rename failed:', e)
    }
    setRenamingPath(null)
    loadTree()
  }

  const handleCtxCreateSubmit = async (name: string) => {
    if (!ctxCreateAt) return
    const sep = ctxCreateAt.dirPath.includes('\\') ? '\\' : '/'
    const fullPath = ctxCreateAt.dirPath + sep + name
    try {
      if (ctxCreateAt.type === 'dir') {
        await window.api.createDirectory(fullPath)
      } else {
        await window.api.createFile(fullPath)
        onFileClick(fullPath)
      }
    } catch (e) {
      console.error('Create failed:', e)
    }
    setCtxCreateAt(null)
    loadTree()
  }

  const handleDelete = async (entry: FileTreeEntry) => {
    const label = entry.isDir ? 'папку' : 'файл'
    if (!confirm(`Удалить ${label} "${entry.name}"?`)) return
    try {
      await window.api.deletePath(entry.path)
    } catch (e) {
      console.error('Delete failed:', e)
    }
    loadTree()
  }

  const handleContextMenu = (e: MouseEvent, entry: FileTreeEntry) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const relPath = (fullPath: string) => {
    if (fullPath.startsWith(workspace)) {
      const rel = fullPath.slice(workspace.length).replace(/^[\\/]/, '')
      return rel || fullPath
    }
    return fullPath
  }

  const buildMenuItems = (entry: FileTreeEntry): MenuItem[] => {
    const items: MenuItem[] = []

    if (!entry.isDir) {
      items.push({
        label: 'Открыть',
        icon: '📄',
        action: () => onFileClick(entry.path),
      })
      if (onAttachToChat) {
        items.push({
          label: 'Прикрепить к чату (@)',
          icon: '💬',
          action: () => onAttachToChat(entry.path),
        })
      }
      items.push({ label: '', separator: true, action: () => {} })
    }

    if (entry.isDir) {
      items.push({
        label: 'Новый файл…',
        icon: '+',
        action: () => setCtxCreateAt({ dirPath: entry.path, type: 'file' }),
      })
      items.push({
        label: 'Новая папка…',
        icon: '📁',
        action: () => setCtxCreateAt({ dirPath: entry.path, type: 'dir' }),
      })
      if (onOpenTerminalAt) {
        items.push({
          label: 'Открыть терминал здесь',
          icon: '▸',
          action: () => onOpenTerminalAt(entry.path),
        })
      }
      items.push({ label: '', separator: true, action: () => {} })
    }

    items.push({
      label: 'Копировать путь',
      icon: '📋',
      action: () => window.api.copyToClipboard(entry.path),
    })
    items.push({
      label: 'Копировать относительный путь',
      icon: '📋',
      action: () => window.api.copyToClipboard(relPath(entry.path)),
    })
    items.push({
      label: 'Показать в проводнике',
      icon: '📂',
      action: () => window.api.revealInExplorer(entry.path),
    })

    items.push({ label: '', separator: true, action: () => {} })

    items.push({
      label: 'Переименовать',
      icon: '✏️',
      shortcut: 'F2',
      action: () => {
        setRenamingPath(entry.path)
        setRenamingOrigName(entry.name)
      },
    })
    items.push({
      label: 'Удалить',
      icon: '🗑️',
      danger: true,
      shortcut: 'Del',
      action: () => handleDelete(entry),
    })

    return items
  }

  const dirName = workspace ? workspace.split(/[\\/]/).pop() || workspace : null

  return (
    <aside className="h-full bg-[#0d1117] border-r border-zinc-800/60 flex flex-col">
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
          {workspace && (
            <>
              <button onClick={() => setCreatingRoot('file')} title="Новый файл"
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[12px]">+</button>
              <button onClick={() => setCreatingRoot('dir')} title="Новая папка"
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[10px]">📁</button>
            </>
          )}
          <button onClick={onReset} title="Новый чат"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[10px]">✦</button>
          <button onClick={loadTree} title="Обновить"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-[11px]">↻</button>
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {!workspace && (
          <div className="px-4 py-8 text-center">
            <button onClick={handlePickDir} className="text-sm text-blue-400 hover:text-blue-300 transition-colors cursor-pointer">📂 Открыть проект</button>
            <p className="text-[10px] text-zinc-600 mt-2">Выбери директорию</p>
          </div>
        )}
        {workspace && loading && <div className="px-4 py-4 text-xs text-zinc-500">Загрузка…</div>}
        {workspace && !loading && tree.length === 0 && !creatingRoot && <div className="px-4 py-4 text-xs text-zinc-500">Пусто</div>}
        {creatingRoot && (
          <InlineInput depth={0} placeholder={creatingRoot === 'dir' ? 'имя папки…' : 'имя файла…'} onSubmit={handleCreateRoot} onCancel={() => setCreatingRoot(null)} />
        )}
        {ctxCreateAt?.dirPath === workspace && (
          <InlineInput
            depth={0}
            placeholder={ctxCreateAt.type === 'dir' ? 'имя папки…' : 'имя файла…'}
            onSubmit={handleCtxCreateSubmit}
            onCancel={() => setCtxCreateAt(null)}
          />
        )}
        {tree.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            onFileClick={onFileClick}
            onRefresh={loadTree}
            onContextMenu={handleContextMenu}
            renamingPath={renamingPath}
            ctxCreateAt={ctxCreateAt}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={() => setRenamingPath(null)}
            onCtxCreateSubmit={handleCtxCreateSubmit}
            onCtxCreateCancel={() => setCtxCreateAt(null)}
          />
        ))}
      </div>

      {/* Status */}
      <div className="px-3 py-1.5 border-t border-zinc-800/60 flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${serverOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className="text-[10px] text-zinc-500 truncate">{serverOnline ? 'Онлайн' : 'Оффлайн'}</span>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenuItems(ctxMenu.entry)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  )
})
