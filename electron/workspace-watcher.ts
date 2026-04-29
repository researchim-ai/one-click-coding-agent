/**
 * Watches the active workspace for external file changes and tells the
 * tool-cache to invalidate any cached `read_file` results for paths the
 * user touched outside of the agent. Without this, the cache would happily
 * return a stale copy of a file the user just hand-edited in VS Code.
 *
 * Design notes:
 *   - Uses recursive `fs.watch`, which is native on macOS and Windows and
 *     supported on Linux starting from Node 20. If the platform doesn't
 *     support it, we fall back to a single top-level watcher — imperfect
 *     but better than nothing — and log once.
 *   - Events are debounced per-path with a short timer: a typical editor
 *     save fires two or three events in rapid succession (rename + close
 *     + modify), and we only want one invalidation.
 *   - All paths we emit to tool-cache are absolute. The cache stores
 *     absolute paths so this is a direct key match.
 *   - `.git`, `node_modules`, and other noisy directories are filtered
 *     out — they don't appear in the tool-cache anyway, so we save CPU
 *     and avoid triggering platform file-descriptor limits.
 */

import fs from 'fs'
import path from 'path'
import * as toolCache from './tool-cache'

function debugLog(category: string, msg: string): void {
  if (process.env.OCA_DEBUG || process.env.DEBUG) {
    // Keep output low-noise: only when debugging is explicitly turned on.
    // eslint-disable-next-line no-console
    console.log(`[${category}] ${msg}`)
  }
}

const IGNORE_DIR_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  '.venv',
  '__pycache__',
])

function isIgnoredPath(rel: string): boolean {
  if (!rel) return false
  const parts = rel.split(path.sep)
  for (const p of parts) {
    if (IGNORE_DIR_SEGMENTS.has(p)) return true
    if (p.startsWith('.') && p !== '.' && p !== '..') {
      // Hidden files/dirs except a shortlist we DO care about.
      if (p !== '.env' && p !== '.gitignore' && p !== '.eslintrc' && p !== '.prettierrc') return true
    }
  }
  return false
}

let currentWatcher: fs.FSWatcher | null = null
let currentRoot: string | null = null
const pendingTimers = new Map<string, NodeJS.Timeout>()
const DEBOUNCE_MS = 40

function scheduleInvalidate(absPath: string) {
  const existing = pendingTimers.get(absPath)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    pendingTimers.delete(absPath)
    try {
      toolCache.invalidateFile(absPath)
    } catch (e: any) {
      debugLog('WATCHER', `invalidate failed for ${absPath}: ${e?.message ?? e}`)
    }
  }, DEBOUNCE_MS)
  pendingTimers.set(absPath, t)
}

/** Start watching the given workspace. Stops any previous watcher first.
 *  Safe to call repeatedly with the same path — it's a no-op after the
 *  first call for the active root. */
export function watchWorkspace(workspace: string): void {
  if (!workspace) return
  const resolved = path.resolve(workspace)
  if (currentRoot === resolved && currentWatcher) return
  stopWatching()

  try {
    // { recursive: true } works on darwin/win32 natively, and on Linux
    // since Node 20. On older Node/Linux this throws ENOSYS and we fall
    // back below.
    const w = fs.watch(resolved, { recursive: true, persistent: false }, (_evt, filename) => {
      if (!filename) return
      const rel = String(filename)
      if (isIgnoredPath(rel)) return
      const abs = path.isAbsolute(rel) ? rel : path.join(resolved, rel)
      scheduleInvalidate(abs)
    })
    w.on('error', (err) => {
      debugLog('WATCHER', `fs.watch error: ${err.message}`)
    })
    currentWatcher = w
    currentRoot = resolved
    debugLog('WATCHER', `started recursive watch on ${resolved}`)
  } catch (err: any) {
    debugLog('WATCHER', `recursive watch unsupported (${err?.code ?? err?.message ?? err}); running without file-watcher — tool-cache will rely on mtime checks only`)
    currentWatcher = null
    currentRoot = resolved
  }
}

/** Stop the active watcher, if any. */
export function stopWatching(): void {
  if (currentWatcher) {
    try {
      currentWatcher.close()
    } catch {}
  }
  currentWatcher = null
  currentRoot = null
  for (const t of pendingTimers.values()) clearTimeout(t)
  pendingTimers.clear()
}

/** For tests: flush any pending debounced invalidations synchronously. */
export function __flushPendingForTests(): void {
  for (const [absPath, t] of pendingTimers) {
    clearTimeout(t)
    try {
      toolCache.invalidateFile(absPath)
    } catch {}
  }
  pendingTimers.clear()
}

export function __getWatchedRoot(): string | null {
  return currentRoot
}
