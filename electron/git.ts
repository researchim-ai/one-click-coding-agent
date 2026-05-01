import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { computeHunks, type Hunk } from './diff-hunks'

export interface GitFileStatus {
  /** Path relative to repo root (forward slashes) */
  path: string
  /** X Y from porcelain: M=modified, A=added, D=deleted, U=unmerged, ?=untracked, etc. */
  status: string
}

export interface GitStatus {
  branch: string | null
  /** List of changed files; empty if not a repo or error */
  files: GitFileStatus[]
  isRepo: boolean
}

const sep = path.sep

/**
 * Normalize path to forward slashes for consistent comparison with workspace paths.
 */
function normalizeRelPath(p: string): string {
  return p.split(sep).filter(Boolean).join('/')
}

/**
 * Get git status for the given workspace directory.
 * Runs `git status --porcelain -b` and parses output.
 */
export function getStatus(workspace: string): GitStatus {
  if (!workspace?.trim()) {
    return { branch: null, files: [], isRepo: false }
  }

  const result = spawnSync('git', ['status', '--porcelain', '-b'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10000,
  })

  if (result.error || result.status !== 0) {
    return { branch: null, files: [], isRepo: false }
  }

  const out = (result.stdout || '').trim()
  const lines = out ? out.split('\n') : []
  let branch: string | null = null
  const files: GitFileStatus[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const match = line.slice(3).match(/^([^\s.]+)/)
      if (match) branch = match[1]
      continue
    }
    if (line.length >= 4) {
      const xy = line.slice(0, 2)
      let filePath = line.slice(3).replace(/^"[^"]*"|^'[^']*'/, (m) => m.slice(1, -1)).trim()
      if (filePath.includes(' -> ')) filePath = filePath.split(' -> ')[1]?.trim() || filePath
      if (filePath) {
        files.push({
          path: normalizeRelPath(filePath),
          status: xy,
        })
      }
    }
  }

  return {
    branch,
    files,
    isRepo: true,
  }
}

export interface GitNumstatEntry {
  path: string
  added: number
  deleted: number
}

/**
 * Get added/deleted line counts per file (for diff stats in UI).
 * Runs `git diff --numstat HEAD` and parses output.
 */
export function getNumstat(workspace: string): GitNumstatEntry[] {
  if (!workspace?.trim()) return []

  const result = spawnSync('git', ['diff', '--numstat', 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 15000,
  })

  if (result.error || result.status !== 0) return []

  const lines = (result.stdout || '').trim().split('\n')
  const entries: GitNumstatEntry[] = []
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts.length >= 3) {
      const added = parseInt(parts[0], 10) || 0
      const deleted = parseInt(parts[1], 10) || 0
      let filePath = parts.slice(2).join(' ').trim()
      if (filePath.includes(' -> ')) filePath = filePath.split(' -> ')[1]?.trim() || filePath
      if (filePath) entries.push({ path: normalizeRelPath(filePath), added, deleted })
    }
  }
  return entries
}

/**
 * Get file content from HEAD (for diff view: original version).
 * Returns null if file is new (untracked) or error.
 */
export function getFileContentAtHead(workspace: string, relativePath: string): string | null {
  if (!workspace?.trim() || !relativePath?.trim()) return null

  const normalized = relativePath.split(path.sep).filter(Boolean).join('/')
  const result = spawnSync('git', ['show', `HEAD:${normalized}`], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10000,
  })

  if (result.error || result.status !== 0) return null
  return result.stdout ?? null
}

function relativeToWorkspace(workspace: string, filePath: string): string {
  const ws = path.resolve(workspace)
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspace, filePath)
  const rel = path.relative(ws, abs)
  return normalizeRelPath(rel)
}

function resolveInWorkspace(workspace: string, filePath: string): string {
  const ws = path.resolve(workspace)
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspace, filePath)
  if (!abs.startsWith(ws) && !abs.startsWith(ws + path.sep)) {
    throw new Error(`Access denied: ${abs} is outside workspace ${ws}`)
  }
  return abs
}

export interface GitFileDiff {
  isRepo: boolean
  path: string
  oldContent: string | null
  newContent: string
  hunks: Hunk[]
  additions: number
  removals: number
  isNewFile: boolean
  hasChanges: boolean
}

export function getFileDiff(workspace: string, filePath: string, currentContent?: string): GitFileDiff {
  if (!workspace?.trim() || !filePath?.trim()) {
    return { isRepo: false, path: filePath, oldContent: null, newContent: currentContent ?? '', hunks: [], additions: 0, removals: 0, isNewFile: false, hasChanges: false }
  }
  const status = getStatus(workspace)
  if (!status.isRepo) {
    return { isRepo: false, path: filePath, oldContent: null, newContent: currentContent ?? '', hunks: [], additions: 0, removals: 0, isNewFile: false, hasChanges: false }
  }
  const rel = relativeToWorkspace(workspace, filePath)
  const abs = resolveInWorkspace(workspace, filePath)
  const oldContent = getFileContentAtHead(workspace, rel)
  const newContent = typeof currentContent === 'string'
    ? currentContent
    : fs.existsSync(abs)
      ? fs.readFileSync(abs, 'utf-8')
      : ''

  if (oldContent === null) {
    if (!newContent) {
      return { isRepo: true, path: rel, oldContent: null, newContent, hunks: [], additions: 0, removals: 0, isNewFile: true, hasChanges: false }
    }
    const hunks = computeHunks('', newContent)
    return {
      isRepo: true,
      path: rel,
      oldContent: null,
      newContent,
      hunks,
      additions: hunks.reduce((n, h) => n + h.additions, 0),
      removals: 0,
      isNewFile: true,
      hasChanges: hunks.length > 0,
    }
  }

  const hunks = computeHunks(oldContent, newContent)
  return {
    isRepo: true,
    path: rel,
    oldContent,
    newContent,
    hunks,
    additions: hunks.reduce((n, h) => n + h.additions, 0),
    removals: hunks.reduce((n, h) => n + h.removals, 0),
    isNewFile: false,
    hasChanges: hunks.length > 0,
  }
}

export function discardFileChanges(workspace: string, filePath: string): { ok: true; deleted: boolean; path: string } {
  const rel = relativeToWorkspace(workspace, filePath)
  const abs = resolveInWorkspace(workspace, filePath)
  const oldContent = getFileContentAtHead(workspace, rel)
  if (oldContent === null) {
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
    return { ok: true, deleted: true, path: rel }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, oldContent, 'utf-8')
  return { ok: true, deleted: false, path: rel }
}
