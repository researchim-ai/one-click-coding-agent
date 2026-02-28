import { useState, useCallback } from 'react'

export interface OpenFile {
  path: string
  name: string
  content: string
  language: string
  lines: number
  size: number
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java',
  rb: 'ruby', php: 'php', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', kt: 'kotlin', scala: 'scala',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less', sass: 'scss',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile', makefile: 'makefile',
  gitignore: 'plaintext', env: 'plaintext', txt: 'plaintext',
  lock: 'json', prisma: 'prisma',
}

function detectLanguage(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  if (lower === 'cmakelists.txt') return 'cmake'
  const ext = lower.split('.').pop() ?? ''
  return EXT_TO_LANG[ext] ?? 'plaintext'
}

export function useEditor() {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)

  const openFile = useCallback(async (filePath: string) => {
    // Already open? Just activate
    const existing = openFiles.find((f) => f.path === filePath)
    if (existing) {
      setActiveFilePath(filePath)
      return
    }

    try {
      const { content, size, lines } = await window.api.readFileContent(filePath)
      const name = filePath.split(/[\\/]/).pop() ?? filePath
      const language = detectLanguage(name)
      const file: OpenFile = { path: filePath, name, content, language, lines, size }
      setOpenFiles((prev) => [...prev, file])
      setActiveFilePath(filePath)
    } catch (e: any) {
      console.error('Failed to open file:', e)
    }
  }, [openFiles])

  const closeFile = useCallback((filePath: string) => {
    setOpenFiles((prev) => {
      const updated = prev.filter((f) => f.path !== filePath)
      if (activeFilePath === filePath) {
        const idx = prev.findIndex((f) => f.path === filePath)
        const next = updated[Math.min(idx, updated.length - 1)]
        setActiveFilePath(next?.path ?? null)
      }
      return updated
    })
  }, [activeFilePath])

  const refreshFile = useCallback(async (filePath: string) => {
    try {
      const { content, size, lines } = await window.api.readFileContent(filePath)
      setOpenFiles((prev) =>
        prev.map((f) => f.path === filePath ? { ...f, content, size, lines } : f)
      )
    } catch {}
  }, [])

  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null

  return {
    openFiles,
    activeFile,
    activeFilePath,
    openFile,
    closeFile,
    refreshFile,
    setActiveFilePath,
  }
}
