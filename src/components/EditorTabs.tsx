import type { OpenFile } from '../hooks/useEditor'

interface Props {
  files: OpenFile[]
  activeFilePath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
}

const EXT_COLORS: Record<string, string> = {
  typescript: 'text-blue-400',
  javascript: 'text-yellow-400',
  python: 'text-green-400',
  rust: 'text-orange-400',
  go: 'text-cyan-400',
  java: 'text-red-400',
  ruby: 'text-red-400',
  c: 'text-blue-300',
  cpp: 'text-blue-300',
  css: 'text-pink-400',
  scss: 'text-pink-400',
  html: 'text-orange-300',
  xml: 'text-orange-300',
  json: 'text-yellow-300',
  yaml: 'text-purple-400',
  markdown: 'text-zinc-400',
  bash: 'text-green-300',
  sql: 'text-blue-300',
  dockerfile: 'text-cyan-300',
}

function LangDot({ language }: { language: string }) {
  const color = EXT_COLORS[language] ?? 'text-zinc-500'
  return <span className={`text-[8px] ${color}`}>●</span>
}

export function EditorTabs({ files, activeFilePath, onSelect, onClose }: Props) {
  if (files.length === 0) return null

  return (
    <div className="flex items-stretch bg-[#010409] border-b border-zinc-800/60 overflow-x-auto shrink-0">
      {files.map((file) => {
        const active = file.path === activeFilePath
        return (
          <div
            key={file.path}
            className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-zinc-800/40 transition-colors shrink-0 ${
              active
                ? 'bg-[#0d1117] text-zinc-200 border-t-2 border-t-blue-500'
                : 'bg-[#010409] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50 border-t-2 border-t-transparent'
            }`}
            onClick={() => onSelect(file.path)}
          >
            <LangDot language={file.language} />
            <span className="truncate max-w-[140px]">{file.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(file.path) }}
              className={`w-4 h-4 flex items-center justify-center rounded-sm text-[10px] transition-colors cursor-pointer ${
                active
                  ? 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700'
                  : 'text-transparent group-hover:text-zinc-600 hover:!text-zinc-200 hover:bg-zinc-700'
              }`}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
