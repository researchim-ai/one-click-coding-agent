/**
 * Lightweight repository map.
 *
 * Inspired by Aider's "repomap": instead of dumping the directory tree and
 * hoping the LLM guesses where things are, we scan the workspace for
 * top-level definitions (classes / functions / exports) in each source
 * file, rank the files by importance, and produce a compact summary the
 * agent can read once to orient itself:
 *
 *     src/http.ts
 *       - class HttpServer
 *       - function makeRequest
 *       - const DEFAULT_TIMEOUT
 *     src/db/pool.ts
 *       - class Pool
 *       - function connect
 *
 * The goal is NOT a perfect AST — treesitter bindings are heavy and brittle
 * across languages. Regex-based symbol extraction is good enough to help
 * the model navigate: it ends up reading the actual file anyway when it
 * needs the body.
 *
 * Budget is strictly capped: we pick the highest-ranked files until we
 * hit the budget. Ranking prefers files in src/, top-level files, and
 * ignores vendor/build/dependency dirs.
 */
import * as fs from 'fs'
import * as path from 'path'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.cursor', 'dist', 'build', 'out',
  'target', '.venv', 'venv', '__pycache__', '.next', '.nuxt',
  'coverage', '.cache', '.pnpm-store', 'vendor', '.idea', '.vscode',
])

const SUPPORTED_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt', '.kts',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
  '.rb',
  '.php',
  '.swift',
  '.cs',
])

/** A single captured symbol from a file. */
export interface RepoSymbol {
  kind: 'class' | 'function' | 'const' | 'interface' | 'type' | 'struct' | 'enum' | 'trait'
  name: string
}

export interface RepoFileMap {
  relativePath: string
  language: string
  symbols: RepoSymbol[]
  /** Approximate importance score used for ranking. */
  score: number
}

export interface RepoMap {
  files: RepoFileMap[]
  totalFilesScanned: number
  truncated: boolean
}

/** How many files to scan at most. Protects giant monorepos from turning
 *  every turn into a stat-bomb. */
const MAX_FILES_SCANNED = 2000
/** How deep we walk. 6 covers nearly every reasonable project layout. */
const MAX_DEPTH = 6

/** Single-line regexes per language. Cheap to evaluate, good recall. */
const LANG_PATTERNS: Record<string, { lang: string; patterns: Array<{ kind: RepoSymbol['kind']; re: RegExp }> }> = {
  '.ts': {
    lang: 'typescript',
    patterns: [
      { kind: 'class',     re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'type',      re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
      { kind: 'enum',      re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'function',  re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
      { kind: 'const',     re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
    ],
  },
  '.py': {
    lang: 'python',
    patterns: [
      { kind: 'class',    re: /^\s*class\s+([A-Za-z_][\w]*)/ },
      { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
    ],
  },
  '.rs': {
    lang: 'rust',
    patterns: [
      { kind: 'struct',   re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/ },
      { kind: 'enum',     re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/ },
      { kind: 'trait',    re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/ },
      { kind: 'function', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
    ],
  },
  '.go': {
    lang: 'go',
    patterns: [
      { kind: 'struct',   re: /^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/ },
      { kind: 'interface',re: /^\s*type\s+([A-Za-z_][\w]*)\s+interface\b/ },
      { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/ },
    ],
  },
  '.java': {
    lang: 'java',
    patterns: [
      { kind: 'class',     re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/ },
      { kind: 'interface', re: /^\s*(?:public\s+|private\s+)?interface\s+([A-Za-z_][\w]*)/ },
      { kind: 'enum',      re: /^\s*(?:public\s+|private\s+)?enum\s+([A-Za-z_][\w]*)/ },
    ],
  },
  '.c':   { lang: 'c',    patterns: [{ kind: 'function', re: /^\s*(?:static\s+|extern\s+)?[A-Za-z_][\w\s*]*\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{?/ }] },
}

LANG_PATTERNS['.tsx'] = LANG_PATTERNS['.ts']
LANG_PATTERNS['.js'] = LANG_PATTERNS['.ts']
LANG_PATTERNS['.jsx'] = LANG_PATTERNS['.ts']
LANG_PATTERNS['.mjs'] = LANG_PATTERNS['.ts']
LANG_PATTERNS['.cjs'] = LANG_PATTERNS['.ts']
LANG_PATTERNS['.cc'] = LANG_PATTERNS['.c']
LANG_PATTERNS['.cpp'] = LANG_PATTERNS['.c']
LANG_PATTERNS['.cxx'] = LANG_PATTERNS['.c']
LANG_PATTERNS['.h'] = LANG_PATTERNS['.c']
LANG_PATTERNS['.hpp'] = LANG_PATTERNS['.c']
LANG_PATTERNS['.kt'] = LANG_PATTERNS['.java']
LANG_PATTERNS['.kts'] = LANG_PATTERNS['.java']

/** Walk the workspace, respecting depth + ignore rules. Returns a list of
 *  absolute paths together with their relative display path. */
function* walk(root: string, dir: string, depth: number): Generator<{ abs: string; rel: string }> {
  if (depth > MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue
    if (IGNORED_DIRS.has(e.name)) continue
    const abs = path.join(dir, e.name)
    const rel = path.relative(root, abs)
    if (e.isDirectory()) {
      yield* walk(root, abs, depth + 1)
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      if (SUPPORTED_EXT.has(ext)) yield { abs, rel }
    }
  }
}

/** Cheap importance score: top-level files and files in common "source"
 *  directories win over deeply-nested ones. Test/spec files are down-
 *  ranked — useful information, but usually not what the agent wants to
 *  read first. */
function rankFile(rel: string): number {
  let score = 10
  const depth = rel.split(path.sep).length
  score -= Math.max(0, depth - 1) * 1.5
  if (/(^|\/)(src|lib|app|electron|frontend|backend|server|client)(\/|$)/.test(rel)) score += 3
  if (/(^|\/)(test|tests|__tests__|spec|__mocks__|mocks|fixtures)(\/|$)/.test(rel)) score -= 3
  if (/\.(test|spec)\.(ts|tsx|js|jsx|py|rs|go)$/.test(rel)) score -= 4
  if (/^(main|index|cli|app|server)\./.test(path.basename(rel))) score += 2
  if (/\.d\.ts$/.test(rel)) score -= 5
  return score
}

/** Extract symbols from file contents using the per-language regex set.
 *  Caps at SYMBOLS_PER_FILE to keep output compact. */
const SYMBOLS_PER_FILE = 18
function extractSymbols(content: string, ext: string): RepoSymbol[] {
  const spec = LANG_PATTERNS[ext]
  if (!spec) return []
  const syms: RepoSymbol[] = []
  const seen = new Set<string>()
  const lines = content.split('\n')
  const maxLines = Math.min(lines.length, 4000)
  for (let i = 0; i < maxLines && syms.length < SYMBOLS_PER_FILE; i++) {
    const line = lines[i]
    if (line.length > 300) continue
    for (const p of spec.patterns) {
      const m = line.match(p.re)
      if (m && m[1] && !seen.has(p.kind + ':' + m[1])) {
        if (m[1].length > 60) continue
        if (/^_+$/.test(m[1])) continue
        syms.push({ kind: p.kind, name: m[1] })
        seen.add(p.kind + ':' + m[1])
        break
      }
    }
  }
  return syms
}

/** Build the repo map. `byteBudget` caps how much text the rendered map
 *  may occupy. Returns ranked files; actual rendering is done by
 *  {@link renderRepoMap}. */
export function buildRepoMap(workspaceRoot: string, byteBudget: number = 4000): RepoMap {
  const all: RepoFileMap[] = []
  let count = 0
  let truncated = false
  for (const { abs, rel } of walk(workspaceRoot, workspaceRoot, 0)) {
    if (count++ >= MAX_FILES_SCANNED) { truncated = true; break }
    let text: string
    try {
      const stat = fs.statSync(abs)
      if (stat.size > 512 * 1024) continue // skip huge files, usually generated
      text = fs.readFileSync(abs, 'utf-8')
    } catch { continue }
    if (!text || /\0/.test(text.slice(0, 1024))) continue
    const ext = path.extname(abs).toLowerCase()
    const symbols = extractSymbols(text, ext)
    if (symbols.length === 0) continue
    all.push({
      relativePath: rel.replace(/\\/g, '/'),
      language: LANG_PATTERNS[ext]?.lang ?? ext.slice(1),
      symbols,
      score: rankFile(rel),
    })
  }
  all.sort((a, b) => b.score - a.score)

  // Greedy pack within byteBudget.
  const picked: RepoFileMap[] = []
  let bytes = 0
  for (const f of all) {
    const rendered = renderFileEntry(f)
    const add = Buffer.byteLength(rendered, 'utf-8') + 1
    if (bytes + add > byteBudget) { truncated = true; break }
    bytes += add
    picked.push(f)
  }
  return { files: picked, totalFilesScanned: count, truncated }
}

function renderFileEntry(f: RepoFileMap): string {
  const head = `${f.relativePath}`
  const body = f.symbols.map((s) => `  - ${s.kind} ${s.name}`).join('\n')
  return `${head}\n${body}`
}

/** Render the repo map as a compact markdown section suitable for the
 *  initial project-context prompt. Returns '' if empty. */
export function renderRepoMap(map: RepoMap): string {
  if (!map.files.length) return ''
  const lines: string[] = ['## Repo map (symbol index)']
  lines.push(
    '_A ranked sample of top-level definitions per file. Use this to jump directly to the right module instead of re-scanning the tree. Read a file for the body when you need it._',
  )
  for (const f of map.files) lines.push(renderFileEntry(f))
  if (map.truncated) lines.push(`…[${map.totalFilesScanned} files scanned, output truncated]`)
  return lines.join('\n')
}
