import { useEffect, useRef, useMemo } from 'react'
import hljs from 'highlight.js'
import type { OpenFile } from '../hooks/useEditor'

interface Props {
  file: OpenFile
}

export function CodeEditor({ file }: Props) {
  const codeRef = useRef<HTMLDivElement>(null)

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
      <div ref={codeRef} className="flex-1 overflow-auto font-mono text-[13px] leading-[20px] select-text">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-zinc-800/20 group">
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
    </div>
  )
}

function getLineHtml(fullHtml: string, lineIndex: number): string {
  // Split highlighted HTML by newlines, preserving tags
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
      // Text content — split by newlines
      const textLines = part.split('\n')
      for (let i = 0; i < textLines.length; i++) {
        current += textLines[i]
        if (i < textLines.length - 1) {
          // Close all open tags for this line
          for (let j = openTags.length - 1; j >= 0; j--) current += '</span>'
          result.push(current)
          // Reopen tags for next line
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
