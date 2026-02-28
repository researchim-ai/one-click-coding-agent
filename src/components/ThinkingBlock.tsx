import { useState } from 'react'

interface Props {
  content: string
}

export function ThinkingBlock({ content }: Props) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const preview = lines.slice(0, 3).join('\n')
  const isLong = lines.length > 3

  return (
    <div className="my-2 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-2 px-3 py-1.5 w-full text-left cursor-pointer hover:bg-zinc-800/30 rounded-lg transition-colors"
      >
        <span className="text-[10px] text-zinc-600">{expanded ? '▼' : '▶'}</span>
        <span className="text-[11px] text-zinc-500 font-medium tracking-wide uppercase">размышления</span>
        {!expanded && isLong && (
          <span className="text-[10px] text-zinc-600 ml-auto">{lines.length} строк</span>
        )}
      </button>

      {expanded ? (
        <div className="px-3 pb-2.5 border-l-2 border-zinc-800 ml-2.5">
          <div className="thinking-text">{content}</div>
        </div>
      ) : (
        <div className="px-3 pb-1.5 border-l-2 border-zinc-800 ml-2.5">
          <div className="thinking-text line-clamp-2 opacity-60">{preview}{isLong ? '…' : ''}</div>
        </div>
      )}
    </div>
  )
}
