/**
 * Tool-result cache.
 *
 * Coding agents spend an astonishing amount of context re-reading the same
 * files and re-running the same read-only commands (`ls`, `grep`, `git
 * status`, …). This module caches those results, content-addressed by tool
 * name + args + (for file reads) mtime. Two wins:
 *
 *  1. **Short-circuit**: on a cache hit we skip re-executing the tool and
 *     return the stored result with a small "[↺ cached]" marker. Very fast.
 *
 *  2. **Retrospective dedup**: when a new tool_result comes back identical
 *     to an earlier one in the conversation, we rewrite the *earlier* ones
 *     into a one-line pointer, freeing 5–50 KB of context. Next summary /
 *     send reuses the freed budget for actual progress.
 *
 * All caching is best-effort — if we're unsure, we just don't cache.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

/** Cache entries live this long by default — some commands (grep, ls) can
 *  go stale on real filesystems even without our tools touching them. For
 *  `read_file` we use mtime instead, no time-based TTL. */
const READONLY_COMMAND_TTL_MS = 60_000

/** Max entries retained. LRU-style eviction. Sized so total memory stays
 *  well under a few MB even with large file reads. */
const MAX_ENTRIES = 128

/** Result payloads larger than this are NOT cached — no point caching a
 *  10MB binary, and short-circuiting it would just waste RAM. */
const MAX_RESULT_BYTES = 2 * 1024 * 1024

/** Tools whose results are worth caching. Anything else is either too
 *  rare, too destructive, or already cheap to re-run. */
const CACHEABLE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'find_files',
  'search_in_files',
  'grep',
  // execute_command is cached only for read-only commands — we detect at
  // call site via a helper
])

export interface CacheEntry {
  key: string
  /** The tool result payload (text). */
  result: string
  /** SHA-256 of `result` — also used as the "contentHash" for dedup. */
  contentHash: string
  /** Timestamp of the cached call. */
  cachedAt: number
  /** Expires at (Date.now()). 0 = no time-based expiry (file-backed). */
  expiresAt: number
  /** For file-backed entries (`read_file`), the mtime we captured. */
  mtimeMs: number | null
  /** For file-backed entries, the absolute path we're tracking. */
  trackedFile: string | null
  /** Iteration when it was first cached — used to build "cached at turn N"
   *  markers in the LLM-facing text. */
  iteration: number
}

interface ConversationDedupeState {
  /** Map of contentHash → count of occurrences already replaced in history,
   *  so we only touch each one once. */
  replacedHashes: Set<string>
}

const cache = new Map<string, CacheEntry>()
let hits = 0
let misses = 0

// Per-session dedup state keyed by session id.
const dedupState = new Map<string, ConversationDedupeState>()

function hashKey(toolName: string, args: Record<string, any>): string {
  // Stable args stringify — sort keys so {a:1,b:2} and {b:2,a:1} match.
  const sorted: any = {}
  for (const k of Object.keys(args).sort()) sorted[k] = args[k]
  const s = toolName + '|' + JSON.stringify(sorted)
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
}

function hashContent(result: string): string {
  return crypto.createHash('sha256').update(result).digest('hex').slice(0, 16)
}

/** Called on tool-result receipt to ensure LRU order. */
function touch(key: string, entry: CacheEntry) {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_ENTRIES) {
    const firstKey = cache.keys().next().value
    if (firstKey === undefined) break
    cache.delete(firstKey)
  }
}

function getFileMtime(absPath: string): number | null {
  try {
    return fs.statSync(absPath).mtimeMs
  } catch {
    return null
  }
}

/** Heuristic: is this `execute_command` invocation safe to cache?
 *  Must be a read-only command (mirrors the list in agent.ts but kept
 *  here to avoid a circular import). Cached only for the TTL window. */
function isReadonlyCommand(command: string): boolean {
  const s = (command ?? '').trim()
  if (!s) return false
  if (/[>]|<\(|\$\(|`|\btee\b|\bxargs\b|\bmv\b|\brm\b|\bcp\b|\bmkdir\b|\btouch\b|\bln\b|\bchmod\b|\bchown\b|\binstall\b|\bdd\b|\btruncate\b|\brsync\b|\bpip\b|\bnpm\b|\byarn\b|\bpnpm\b|\bmake\b|\bcargo\b|\bgo\s+build\b|\bgo\s+install\b/i.test(s)) {
    return false
  }
  if (/\bsed\b.*\s-i\b/.test(s)) return false
  // Accept common readonly heads.
  const first = s.split(/\s+/)[0]?.split(/[&|;]/)[0] ?? ''
  const readonlyHeads = new Set([
    'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'pwd', 'whoami',
    'echo', 'printf', 'date', 'which', 'whereis', 'type', 'env',
    'grep', 'egrep', 'fgrep', 'rg', 'find', 'locate', 'tree',
    'git', 'diff', 'sort', 'uniq', 'awk', 'sed', 'cut',
    'du', 'df', 'ps', 'top', 'free', 'uptime',
    'node', 'python', 'python3', 'ruby', 'cd',
  ])
  return readonlyHeads.has(first)
}

/** Resolve the absolute file path for `read_file`-style tools, so we can
 *  stat its mtime. Returns null if we can't make sense of args. */
function resolveFileFromArgs(toolName: string, args: Record<string, any>, workspace: string): string | null {
  if (toolName !== 'read_file') return null
  const p = typeof args.path === 'string' ? args.path : null
  if (!p) return null
  return path.isAbsolute(p) ? p : path.join(workspace, p)
}

/** Look up a cached result. Returns null on miss (caller should execute
 *  and then call `put`). */
export function lookup(toolName: string, args: Record<string, any>, workspace: string): CacheEntry | null {
  const isCommand = toolName === 'execute_command'
  const isCacheable = CACHEABLE_TOOLS.has(toolName) || (isCommand && isReadonlyCommand(args?.command ?? ''))
  if (!isCacheable) { misses++; return null }

  const key = hashKey(toolName, args)
  const hit = cache.get(key)
  if (!hit) { misses++; return null }

  const now = Date.now()

  // File-backed entries: verify mtime unchanged. For `read_file` we also
  // check that the file still exists (deletion invalidates trivially).
  if (hit.trackedFile != null) {
    const m = getFileMtime(hit.trackedFile)
    if (m == null || m !== hit.mtimeMs) {
      cache.delete(key)
      misses++
      return null
    }
  } else if (hit.expiresAt && now > hit.expiresAt) {
    cache.delete(key)
    misses++
    return null
  }

  touch(key, hit)
  hits++
  return hit
}

/** Store a result. `iteration` is only used to stamp the entry so later
 *  LLM-facing markers can say "cached at turn N". */
export function put(toolName: string, args: Record<string, any>, result: string, workspace: string, iteration: number): CacheEntry | null {
  if (!result || Buffer.byteLength(result, 'utf-8') > MAX_RESULT_BYTES) return null

  const isCommand = toolName === 'execute_command'
  const isCacheable = CACHEABLE_TOOLS.has(toolName) || (isCommand && isReadonlyCommand(args?.command ?? ''))
  if (!isCacheable) return null

  const key = hashKey(toolName, args)
  const contentHash = hashContent(result)
  const now = Date.now()
  const trackedFile = resolveFileFromArgs(toolName, args, workspace)
  const mtimeMs = trackedFile ? getFileMtime(trackedFile) : null
  const expiresAt = trackedFile ? 0 : now + READONLY_COMMAND_TTL_MS

  const entry: CacheEntry = {
    key,
    result,
    contentHash,
    cachedAt: now,
    expiresAt,
    mtimeMs,
    trackedFile,
    iteration,
  }
  touch(key, entry)
  return entry
}

/** Invalidate any cache entries that reference the given file. Called
 *  whenever the agent modifies a file so subsequent `read_file` calls
 *  actually re-read fresh content. */
export function invalidateFile(absPath: string): void {
  for (const [key, e] of cache) {
    if (e.trackedFile && e.trackedFile === absPath) cache.delete(key)
  }
}

/** Invalidate everything (called when workspace changes or session resets). */
export function clear(): void {
  cache.clear()
  dedupState.clear()
}

/** Cheap metrics for UI / diagnostics. */
export function getStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: cache.size }
}

/** Reset stats — called at the start of a new agent run so per-run hit
 *  counts reflect that run only. */
export function resetStats(): void {
  hits = 0
  misses = 0
}

// ---------------------------------------------------------------------------
// Retrospective dedup — rewrite earlier identical tool_results into pointers
// ---------------------------------------------------------------------------

export interface MessageLike {
  role: string
  content?: string | null
  tool_call_id?: string
  [k: string]: any
}

/** When we've just put a new tool_result with `contentHash`, scan back
 *  through the conversation and replace any OLDER tool_result messages
 *  that contain the same content with a short pointer. Returns the number
 *  of messages modified. Safe to call after every tool execution.
 *
 *  We don't touch the most recent matching message itself — the model
 *  needs to see the fresh payload. */
export function dedupHistoricalResults(
  msgs: MessageLike[],
  sessionId: string,
  newestContentHash: string,
  pointerText: string,
): number {
  if (!sessionId || msgs.length < 3) return 0
  const st = dedupState.get(sessionId) ?? { replacedHashes: new Set() }
  dedupState.set(sessionId, st)

  // Walk from the back, skip the latest tool message that presumably
  // holds the fresh content, then rewrite older matches.
  let seenNewest = false
  let modified = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'tool' || !m.content) continue
    const h = hashContent(m.content)
    if (h !== newestContentHash) continue
    if (!seenNewest) { seenNewest = true; continue }
    if (m.content === pointerText) continue
    msgs[i] = { ...m, content: pointerText }
    modified++
  }
  if (modified > 0) st.replacedHashes.add(newestContentHash)
  return modified
}

/** Format the "short-circuit" text we return to the LLM when a cache hit
 *  fires. Keep it terse — agents can get confused by verbose markers. */
export function renderCachedShortCircuit(entry: CacheEntry, turn: number): string {
  const ageSec = Math.floor((Date.now() - entry.cachedAt) / 1000)
  const where = entry.trackedFile ? ` (file mtime unchanged)` : ''
  const header = `[↺ cached result, reused from turn ${entry.iteration}, ${ageSec}s ago${where}]`
  return `${header}\n${entry.result}`
}

/** Format the pointer text used to replace duplicated older results. */
export function renderDedupPointer(newestIteration: number, kind: string): string {
  return `[↺ same ${kind} result is shown again at turn ${newestIteration}. Refer to that turn for the content.]`
}
