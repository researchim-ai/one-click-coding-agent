import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { dataDir } from './model-manager'

export type CodeSymbolKind = 'class' | 'function' | 'const' | 'interface' | 'type' | 'struct' | 'enum' | 'trait'

export interface CodeSymbol {
  kind: CodeSymbolKind
  name: string
  line: number
  preview: string
}

export interface CodeIndexFile {
  relativePath: string
  language: string
  size: number
  mtimeMs: number
  imports: string[]
  exports: string[]
  symbols: CodeSymbol[]
  score: number
}

export interface CodeIndex {
  version: 1
  workspace: string
  updatedAt: number
  filesScanned: number
  truncated: boolean
  files: CodeIndexFile[]
}

export interface CodeIndexStatus {
  indexed: boolean
  stale: boolean
  updatedAt: number | null
  files: number
  symbols: number
  truncated: boolean
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.cursor', 'dist', 'dist-electron', 'build', 'out',
  'target', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'coverage',
  '.cache', '.pnpm-store', 'vendor', '.idea', '.vscode',
])

const SUPPORTED_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java',
  '.kt', '.kts', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.rb', '.php',
  '.swift', '.cs',
])

const MAX_FILES_SCANNED = 3000
const MAX_DEPTH = 8
const SYMBOLS_PER_FILE = 80
const CACHE_MAX_AGE_MS = 60 * 60 * 1000

const memoryCache = new Map<string, CodeIndex>()
const staleWorkspaces = new Set<string>()

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.rs': 'rust',
  '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.h': 'c', '.hpp': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.cs': 'csharp',
}

const SYMBOL_PATTERNS: Array<{ kind: CodeSymbolKind; re: RegExp }> = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: 'enum', re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)/ },
  { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  { kind: 'struct', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/ },
  { kind: 'enum', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/ },
  { kind: 'trait', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/ },
  { kind: 'function', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
  { kind: 'struct', re: /^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/ },
  { kind: 'interface', re: /^\s*type\s+([A-Za-z_][\w]*)\s+interface\b/ },
  { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/ },
]

function workspaceKey(workspace: string): string {
  return path.resolve(workspace)
}

function cachePath(workspace: string): string {
  const hash = crypto.createHash('sha1').update(workspaceKey(workspace)).digest('hex')
  return path.join(dataDir(), 'code-index', `${hash}.json`)
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/')
}

function* walk(root: string, dir: string, depth: number): Generator<{ abs: string; rel: string }> {
  if (depth > MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    if (IGNORED_DIRS.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    const rel = path.relative(root, abs)
    if (entry.isDirectory()) yield* walk(root, abs, depth + 1)
    else if (entry.isFile() && SUPPORTED_EXT.has(path.extname(entry.name).toLowerCase())) yield { abs, rel }
  }
}

function rankFile(rel: string): number {
  const normalized = normalizeRel(rel)
  let score = 10
  const depth = normalized.split('/').length
  score -= Math.max(0, depth - 1) * 1.5
  if (/(^|\/)(src|lib|app|electron|frontend|backend|server|client)(\/|$)/.test(normalized)) score += 3
  if (/(^|\/)(test|tests|__tests__|spec|fixtures)(\/|$)/.test(normalized)) score -= 3
  if (/\.(test|spec)\.(ts|tsx|js|jsx|py|rs|go)$/.test(normalized)) score -= 4
  if (/^(main|index|cli|app|server)\./.test(path.basename(normalized))) score += 2
  return score
}

function extractSymbols(lines: string[]): CodeSymbol[] {
  const out: CodeSymbol[] = []
  const seen = new Set<string>()
  const maxLines = Math.min(lines.length, 6000)
  for (let i = 0; i < maxLines && out.length < SYMBOLS_PER_FILE; i++) {
    const line = lines[i]
    if (!line || line.length > 500) continue
    for (const pattern of SYMBOL_PATTERNS) {
      const match = line.match(pattern.re)
      const name = match?.[1]
      if (!name || name.length > 80) continue
      const key = `${pattern.kind}:${name}:${i + 1}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: pattern.kind, name, line: i + 1, preview: line.trim().slice(0, 240) })
      break
    }
  }
  return out
}

function extractImports(lines: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/,
    /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    /^\s*from\s+([A-Za-z_][\w.]+)\s+import\b/,
    /^\s*import\s+([A-Za-z_][\w.]+)/,
    /^\s*use\s+([A-Za-z_][\w:]+)/,
  ]
  for (const line of lines.slice(0, 2000)) {
    for (const re of patterns) {
      const match = line.match(re)
      const value = match?.[1]
      if (value && !seen.has(value)) {
        seen.add(value)
        out.push(value)
        break
      }
    }
    if (out.length >= 60) break
  }
  return out
}

function extractExports(lines: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of lines.slice(0, 3000)) {
    const match = line.match(/^\s*export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/)
      ?? line.match(/^\s*module\.exports\.([A-Za-z_$][\w$]*)\s*=/)
    const value = match?.[1]
    if (value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
    if (out.length >= 60) break
  }
  return out
}

function isCacheFresh(index: CodeIndex): boolean {
  if (Date.now() - index.updatedAt > CACHE_MAX_AGE_MS) return false
  for (const file of index.files) {
    try {
      const stat = fs.statSync(path.join(index.workspace, file.relativePath))
      if (stat.size !== file.size || Math.round(stat.mtimeMs) !== Math.round(file.mtimeMs)) return false
    } catch {
      return false
    }
  }
  return true
}

function loadDiskCache(workspace: string): CodeIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(workspace), 'utf-8')) as CodeIndex
    if (parsed.version !== 1 || workspaceKey(parsed.workspace) !== workspaceKey(workspace)) return null
    return parsed
  } catch {
    return null
  }
}

function saveDiskCache(index: CodeIndex): void {
  const file = cachePath(index.workspace)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(index), 'utf-8')
}

export function buildCodeIndex(workspace: string): CodeIndex {
  const root = workspaceKey(workspace)
  const files: CodeIndexFile[] = []
  let filesScanned = 0
  let truncated = false

  for (const { abs, rel } of walk(root, root, 0)) {
    if (filesScanned++ >= MAX_FILES_SCANNED) { truncated = true; break }
    let stat: fs.Stats
    let text: string
    try {
      stat = fs.statSync(abs)
      if (stat.size > 768 * 1024) continue
      text = fs.readFileSync(abs, 'utf-8')
    } catch { continue }
    if (!text || /\0/.test(text.slice(0, 2048))) continue
    const lines = text.split('\n')
    const symbols = extractSymbols(lines)
    const imports = extractImports(lines)
    const exports = extractExports(lines)
    if (symbols.length === 0 && imports.length === 0 && exports.length === 0) continue
    const ext = path.extname(abs).toLowerCase()
    files.push({
      relativePath: normalizeRel(rel),
      language: LANG_BY_EXT[ext] ?? ext.slice(1),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      imports,
      exports,
      symbols,
      score: rankFile(rel) + Math.min(8, symbols.length * 0.4) + Math.min(3, imports.length * 0.05),
    })
  }

  files.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
  const index: CodeIndex = { version: 1, workspace: root, updatedAt: Date.now(), filesScanned, truncated, files }
  memoryCache.set(root, index)
  staleWorkspaces.delete(root)
  saveDiskCache(index)
  return index
}

export function getCodeIndex(workspace: string, force = false): CodeIndex {
  const key = workspaceKey(workspace)
  if (!force && !staleWorkspaces.has(key)) {
    const mem = memoryCache.get(key)
    if (mem && isCacheFresh(mem)) return mem
    const disk = loadDiskCache(key)
    if (disk && isCacheFresh(disk)) {
      memoryCache.set(key, disk)
      return disk
    }
  }
  return buildCodeIndex(key)
}

export function invalidateWorkspace(workspace: string): void {
  const key = workspaceKey(workspace)
  staleWorkspaces.add(key)
  memoryCache.delete(key)
}

export function getCodeIndexStatus(workspace: string): CodeIndexStatus {
  const key = workspaceKey(workspace)
  const cached = memoryCache.get(key) ?? loadDiskCache(key)
  const stale = !cached || staleWorkspaces.has(key) || !isCacheFresh(cached)
  return {
    indexed: !!cached,
    stale,
    updatedAt: cached?.updatedAt ?? null,
    files: cached?.files.length ?? 0,
    symbols: cached?.files.reduce((sum, file) => sum + file.symbols.length, 0) ?? 0,
    truncated: cached?.truncated ?? false,
  }
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_$.-]+/i).filter((x) => x.length >= 2)
}

function matchScore(haystack: string, tokens: string[]): number {
  const h = haystack.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (h === token) score += 20
    else if (h.includes(token)) score += 5
  }
  return score
}

export function renderCodeIndexMap(workspace: string, maxBytes = 8000): string {
  const index = getCodeIndex(workspace)
  const lines = [
    '## Code index / repo map',
    `Indexed files: ${index.files.length}; symbols: ${index.files.reduce((n, f) => n + f.symbols.length, 0)}; scanned: ${index.filesScanned}`,
    'Use search_code_index for targeted lookup and get_symbol_context before editing symbol-heavy files.',
    '',
  ]
  let bytes = Buffer.byteLength(lines.join('\n'), 'utf-8')
  for (const file of index.files) {
    const entry = [
      file.relativePath,
      ...file.symbols.slice(0, 12).map((s) => `  - L${s.line} ${s.kind} ${s.name}`),
      file.imports.length ? `  imports: ${file.imports.slice(0, 8).join(', ')}` : '',
    ].filter(Boolean).join('\n')
    const add = Buffer.byteLength(entry, 'utf-8') + 1
    if (bytes + add > maxBytes) {
      lines.push('…[code index truncated]')
      break
    }
    lines.push(entry)
    bytes += add
  }
  return lines.join('\n')
}

export function searchCodeIndex(workspace: string, query: string, maxResults = 20, kind?: string): string {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return 'Error: query is empty.'
  const index = getCodeIndex(workspace)
  const results: Array<{ score: number; line: string }> = []
  for (const file of index.files) {
    const fileScore = matchScore(file.relativePath, tokens) + matchScore(file.imports.join(' '), tokens)
    if (fileScore > 0) {
      results.push({ score: fileScore + file.score * 0.1, line: `${file.relativePath} (${file.language})` })
    }
    for (const sym of file.symbols) {
      if (kind && sym.kind !== kind) continue
      const score = matchScore(`${sym.name} ${sym.kind} ${file.relativePath} ${sym.preview}`, tokens)
      if (score > 0) {
        results.push({ score: score + file.score * 0.1, line: `${file.relativePath}:${sym.line} ${sym.kind} ${sym.name} — ${sym.preview}` })
      }
    }
  }
  results.sort((a, b) => b.score - a.score)
  if (results.length === 0) return `No code-index matches for "${query}".`
  return results.slice(0, Math.max(1, Math.min(maxResults, 50))).map((r, i) => `${i + 1}. ${r.line}`).join('\n')
}

export function getSymbolContext(workspace: string, symbol: string, filePath?: string, maxBytes = 12000): string {
  const index = getCodeIndex(workspace)
  const normalizedFile = filePath?.replace(/\\/g, '/')
  const matches: Array<{ file: CodeIndexFile; symbol: CodeSymbol }> = []
  for (const file of index.files) {
    if (normalizedFile && file.relativePath !== normalizedFile && !file.relativePath.endsWith(normalizedFile)) continue
    for (const sym of file.symbols) {
      if (sym.name === symbol || sym.name.toLowerCase().includes(symbol.toLowerCase())) matches.push({ file, symbol: sym })
    }
  }
  if (matches.length === 0) return `No symbol "${symbol}" found in code index.`
  const chunks: string[] = []
  let bytes = 0
  for (const match of matches.slice(0, 8)) {
    const abs = path.join(index.workspace, match.file.relativePath)
    let lines: string[]
    try { lines = fs.readFileSync(abs, 'utf-8').split('\n') } catch { continue }
    const start = Math.max(1, match.symbol.line - 25)
    const end = Math.min(lines.length, match.symbol.line + 45)
    const body = lines.slice(start - 1, end).map((line, i) => `${String(start + i).padStart(5, ' ')}|${line}`).join('\n')
    const chunk = `## ${match.file.relativePath}:${match.symbol.line} ${match.symbol.kind} ${match.symbol.name}\n${body}`
    const add = Buffer.byteLength(chunk, 'utf-8') + 2
    if (bytes + add > Math.max(1000, Math.min(maxBytes, 50000))) break
    chunks.push(chunk)
    bytes += add
  }
  return chunks.join('\n\n---\n\n') || `Symbol "${symbol}" found, but source could not be read.`
}
