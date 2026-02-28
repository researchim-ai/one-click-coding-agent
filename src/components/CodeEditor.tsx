import { useEffect, useRef, useMemo, useState, type MouseEvent } from 'react'
import hljs from 'highlight.js'
import type { OpenFile } from '../hooks/useEditor'
import { ContextMenu, type MenuItem } from './ContextMenu'

export interface CodeSelectionInfo {
  filePath: string
  relativePath: string
  startLine: number
  endLine: number
  content: string
  language: string
}

interface Props {
  file: OpenFile
  workspace?: string
  onAttachCode?: (info: CodeSelectionInfo) => void
}

export function CodeEditor({ file, workspace, onAttachCode }: Props) {
  const codeRef = useRef<HTMLDivElement>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  const highlighted = useMemo(() => {
    try {
      if (file.language && file.language !== 'plaintext') {
        const result = hljs.highlight(file.content, { language: file.language, ignoreIllegals: true })
        return result.value
      }
    } catch {}
    return hljs.highlightAuto(file.content).value
  }, [file.content, file.language])

  const lines = file.content.split('\n')
  const gutterWidth = String(lines.length).length

  useEffect(() => {
    if (codeRef.current) codeRef.current.scrollTop = 0
  }, [file.path])

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  const getSelection = () => window.getSelection()?.toString() ?? ''

  const getSelectionLineRange = (): { start: number; end: number } | null => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !codeRef.current) return null

    const findLineNum = (node: Node): number | null => {
      let el: Node | null = node
      while (el && el !== codeRef.current) {
        if (el instanceof HTMLElement && el.tagName === 'TR' && el.dataset.line) {
          return parseInt(el.dataset.line, 10)
        }
        el = el.parentNode
      }
      return null
    }

    const anchorLine = sel.anchorNode ? findLineNum(sel.anchorNode) : null
    const focusLine = sel.focusNode ? findLineNum(sel.focusNode) : null

    if (anchorLine == null || focusLine == null) return null
    return {
      start: Math.min(anchorLine, focusLine),
      end: Math.max(anchorLine, focusLine),
    }
  }

  const relPath = (fullPath: string) => {
    if (workspace && fullPath.startsWith(workspace)) {
      return fullPath.slice(workspace.length).replace(/^[\\/]/, '') || fullPath
    }
    return fullPath
  }

  const buildMenu = (): MenuItem[] => {
    const sel = getSelection()
    const items: MenuItem[] = []

    if (sel) {
      items.push({
        label: 'Копировать',
        icon: '📋',
        shortcut: 'Ctrl+C',
        action: () => window.api.copyToClipboard(sel),
      })

      if (onAttachCode) {
        const range = getSelectionLineRange()
        if (range) {
          items.push({
            label: `Прикрепить к чату (L${range.start}–${range.end})`,
            icon: '💬',
            action: () => {
              const selectedLines = lines.slice(range.start - 1, range.end).join('\n')
              onAttachCode({
                filePath: file.path,
                relativePath: relPath(file.path),
                startLine: range.start,
                endLine: range.end,
                content: selectedLines,
                language: file.language,
              })
            },
          })
        }
      }

      items.push({
        label: 'Найти выделение',
        icon: '🔎',
        shortcut: 'Ctrl+F',
        disabled: true,
        action: () => {},
      })
      items.push({ label: '', separator: true, action: () => {} })
    }

    items.push({
      label: 'Выделить всё',
      icon: '▣',
      shortcut: 'Ctrl+A',
      action: () => {
        if (codeRef.current) {
          const range = document.createRange()
          range.selectNodeContents(codeRef.current)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
      },
    })

    items.push({ label: '', separator: true, action: () => {} })

    items.push({
      label: 'Копировать путь к файлу',
      icon: '📋',
      action: () => window.api.copyToClipboard(file.path),
    })
    items.push({
      label: 'Копировать относительный путь',
      icon: '📋',
      action: () => window.api.copyToClipboard(relPath(file.path)),
    })
    items.push({
      label: 'Показать в проводнике',
      icon: '📂',
      action: () => window.api.revealInExplorer(file.path),
    })

    return items
  }

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 bg-[#0d1117] border-b border-zinc-800/60 text-[11px] text-zinc-500 font-mono shrink-0">
        {file.path.split(/[\\/]/).map((part, i, arr) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-zinc-700">/</span>}
            <span className={i === arr.length - 1 ? 'text-zinc-300' : ''}>{part}</span>
          </span>
        ))}
      </div>

      {/* Code area */}
      <div
        ref={codeRef}
        className="flex-1 overflow-auto font-mono text-[13px] leading-[20px] select-text"
        onContextMenu={handleContextMenu}
      >
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} data-line={i + 1} className="hover:bg-zinc-800/20 group">
                <td
                  className="sticky left-0 text-right pr-4 pl-4 select-none text-zinc-600 bg-[#0d1117] group-hover:text-zinc-500 transition-colors align-top"
                  style={{ width: `${gutterWidth + 4}ch`, minWidth: '3.5rem' }}
                >
                  {i + 1}
                </td>
                <td className="pr-8 whitespace-pre align-top">
                  <span dangerouslySetInnerHTML={{ __html: getLineHtml(highlighted, i) }} />
                  {line === '' && '\u00A0'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-4 px-4 py-1 bg-[#0d1117] border-t border-zinc-800/60 text-[11px] text-zinc-600 font-mono shrink-0">
        <span>{file.language}</span>
        <span>{file.lines} lines</span>
        <span>{formatSize(file.size)}</span>
        <span className="ml-auto">UTF-8</span>
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenu()}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

function getLineHtml(fullHtml: string, lineIndex: number): string {
  const lines = splitHtmlByLines(fullHtml)
  return lines[lineIndex] ?? ''
}

function splitHtmlByLines(html: string): string[] {
  const result: string[] = []
  let current = ''
  let openTags: string[] = []

  const tagRegex = /(<\/?span[^>]*>)/g
  const parts = html.split(tagRegex)

  for (const part of parts) {
    if (part.startsWith('<span')) {
      openTags.push(part)
      current += part
    } else if (part === '</span>') {
      openTags.pop()
      current += part
    } else {
      const textLines = part.split('\n')
      for (let i = 0; i < textLines.length; i++) {
        current += textLines[i]
        if (i < textLines.length - 1) {
          for (let j = openTags.length - 1; j >= 0; j--) current += '</span>'
          result.push(current)
          current = openTags.join('')
        }
      }
    }
  }
  result.push(current)
  return result
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
