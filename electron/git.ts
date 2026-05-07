import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { computeHunks, type Hunk } from './diff-hunks'
import { ensureShadowRepo, shadowGitDir } from './checkpoints'

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

/**
 * Normalize path to forward slashes for consistent comparison with workspace paths.
 */
function normalizeRelPath(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).join('/')
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

export interface AgentFileChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  added: number
  deleted: number
}

interface AgentDiffBaselineRecord {
  path: string
  oldContent: string | null
  pending: boolean
  acceptedHash?: string
  updatedAt: number
}

interface AgentDiffBaselineStore {
  version: 1
  records: Record<string, AgentDiffBaselineRecord>
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

function workspaceBaselineSlug(workspace: string): string {
  const abs = path.resolve(workspace)
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 16)
  const base = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'workspace'
  return `${base}-${hash}`
}

function baselineStorePath(workspace: string): string {
  return path.join(os.homedir(), '.one-click-agent', 'agent-diff-baselines', `${workspaceBaselineSlug(workspace)}.json`)
}

function emptyBaselineStore(): AgentDiffBaselineStore {
  return { version: 1, records: {} }
}

function loadBaselineStore(workspace: string): AgentDiffBaselineStore {
  try {
    const file = baselineStorePath(workspace)
    if (!fs.existsSync(file)) return emptyBaselineStore()
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!parsed || parsed.version !== 1 || typeof parsed.records !== 'object') return emptyBaselineStore()
    return parsed
  } catch {
    return emptyBaselineStore()
  }
}

function saveBaselineStore(workspace: string, store: AgentDiffBaselineStore): void {
  const file = baselineStorePath(workspace)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(store), 'utf-8')
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function readCurrentContent(abs: string): string {
  return fs.existsSync(abs) && fs.statSync(abs).isFile()
    ? fs.readFileSync(abs, 'utf-8')
    : ''
}

function readCurrentContentOrNull(abs: string): string | null {
  return fs.existsSync(abs) && fs.statSync(abs).isFile()
    ? fs.readFileSync(abs, 'utf-8')
    : null
}

export function captureAgentFileBaseline(workspace: string, filePath: string): void {
  if (!workspace?.trim() || !filePath?.trim()) return
  const rel = relativeToWorkspace(workspace, filePath)
  const abs = resolveInWorkspace(workspace, filePath)
  const store = loadBaselineStore(workspace)
  const existing = store.records[rel]
  // Preserve the first pre-agent version until the user explicitly accepts or
  // reverts. Later checkpoints/tools must not move this baseline.
  if (existing?.pending) return
  store.records[rel] = {
    path: rel,
    oldContent: readCurrentContentOrNull(abs),
    pending: true,
    updatedAt: Date.now(),
  }
  saveBaselineStore(workspace, store)
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
  baseline: 'shadow' | 'git' | 'none'
}

function emptyDiff(workspace: string, filePath: string, currentContent?: string): GitFileDiff {
  return {
    isRepo: false,
    path: filePath,
    oldContent: null,
    newContent: currentContent ?? '',
    hunks: [],
    additions: 0,
    removals: 0,
    isNewFile: false,
    hasChanges: false,
    baseline: 'none',
  }
}

function runShadowGit(workspace: string, args: string[], timeout = 10000): ReturnType<typeof spawnSync> {
  return spawnSync('git', args, {
    cwd: workspace,
    env: {
      ...process.env,
      GIT_DIR: shadowGitDir(workspace),
      GIT_WORK_TREE: path.resolve(workspace),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
    encoding: 'utf8',
    timeout,
  })
}

function hasShadowHead(workspace: string): boolean {
  if (!fs.existsSync(shadowGitDir(workspace))) return false
  const result = runShadowGit(workspace, ['rev-parse', '--verify', 'HEAD'])
  return !result.error && result.status === 0
}

function getShadowFileContentAtHead(workspace: string, relativePath: string): string | null {
  if (!hasShadowHead(workspace)) return null
  const result = runShadowGit(workspace, ['show', `HEAD:${relativePath}`])
  if (result.error || result.status !== 0) return null
  return result.stdout?.toString() ?? null
}

function shadowHeadTracksAnyFile(workspace: string): boolean {
  if (!hasShadowHead(workspace)) return false
  const result = runShadowGit(workspace, ['ls-tree', '-r', '--name-only', 'HEAD'])
  if (result.error || result.status !== 0) return false
  return !!(result.stdout?.toString() ?? '').trim()
}

function lineCount(text: string): number {
  if (!text) return 0
  return text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length
}

function parseShadowNumstat(workspace: string): Map<string, { added: number; deleted: number }> {
  const result = runShadowGit(workspace, ['diff', '--numstat', 'HEAD'], 15000)
  const map = new Map<string, { added: number; deleted: number }>()
  if (result.error || result.status !== 0) return map
  const lines = (result.stdout?.toString() ?? '').trim().split('\n').filter(Boolean)
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const added = parseInt(parts[0], 10) || 0
    const deleted = parseInt(parts[1], 10) || 0
    const filePath = normalizeRelPath(parts.slice(2).join(' '))
    if (filePath) map.set(filePath, { added, deleted })
  }
  return map
}

function agentChangeFromBaseline(workspace: string, record: AgentDiffBaselineRecord): AgentFileChange | null {
  if (!record.pending) return null
  const abs = path.join(workspace, record.path)
  const newContent = readCurrentContent(abs)
  const diff = buildDiff(record.path, record.oldContent, newContent, 'shadow', true)
  if (!diff.hasChanges) return null
  let status: AgentFileChange['status'] = 'modified'
  if (record.oldContent === null) status = 'untracked'
  else if (!fs.existsSync(abs)) status = 'deleted'
  return {
    path: record.path,
    status,
    added: diff.additions,
    deleted: status === 'deleted' && diff.removals === 0 ? lineCount(record.oldContent ?? '') : diff.removals,
  }
}

export function getAgentFileChanges(workspace: string): AgentFileChange[] {
  if (!workspace?.trim()) return []
  const store = loadBaselineStore(workspace)
  const baselineChanges = Object.values(store.records)
    .map((record) => agentChangeFromBaseline(workspace, record))
    .filter((change): change is AgentFileChange => !!change)
  if (baselineChanges.length > 0) return baselineChanges

  if (!hasShadowHead(workspace) || !shadowHeadTracksAnyFile(workspace)) return []
  const statusResult = runShadowGit(workspace, ['status', '--porcelain'], 15000)
  if (statusResult.error || statusResult.status !== 0) return []

  const numstat = parseShadowNumstat(workspace)
  const changes: AgentFileChange[] = []
  const seen = new Set<string>()
  const lines = (statusResult.stdout?.toString() ?? '').split('\n').filter(Boolean)
  for (const line of lines) {
    const xy = line.slice(0, 2)
    let rel = line.slice(3).trim()
    if (!rel) continue
    if (rel.includes(' -> ')) rel = rel.split(' -> ')[1]?.trim() || rel
    rel = normalizeRelPath(rel.replace(/^"|"$/g, ''))
    if (!rel || seen.has(rel)) continue
    seen.add(rel)

    let status: AgentFileChange['status'] = 'modified'
    if (xy.includes('?')) status = 'untracked'
    else if (xy.includes('A')) status = 'added'
    else if (xy.includes('D')) status = 'deleted'
    else if (xy.includes('R')) status = 'renamed'

    let counts = numstat.get(rel) ?? { added: 0, deleted: 0 }
    if ((status === 'untracked' || status === 'added') && counts.added === 0) {
      const abs = path.join(workspace, rel)
      counts = {
        added: fs.existsSync(abs) && fs.statSync(abs).isFile() ? lineCount(fs.readFileSync(abs, 'utf-8')) : 0,
        deleted: 0,
      }
    }
    if (status === 'deleted' && counts.deleted === 0) {
      counts = { added: 0, deleted: lineCount(getShadowFileContentAtHead(workspace, rel) ?? '') }
    }
    changes.push({ path: rel, status, added: counts.added, deleted: counts.deleted })
  }
  return changes
}

function buildDiff(
  rel: string,
  oldContent: string | null,
  newContent: string,
  baseline: GitFileDiff['baseline'],
  isRepo: boolean,
): GitFileDiff {
  if (oldContent === null) {
    if (!newContent) {
      return { isRepo, path: rel, oldContent: null, newContent, hunks: [], additions: 0, removals: 0, isNewFile: true, hasChanges: false, baseline }
    }
    const hunks = computeHunks('', newContent)
    return {
      isRepo,
      path: rel,
      oldContent: null,
      newContent,
      hunks,
      additions: hunks.reduce((n, h) => n + h.additions, 0),
      removals: 0,
      isNewFile: true,
      hasChanges: hunks.length > 0,
      baseline,
    }
  }

  const hunks = computeHunks(oldContent, newContent)
  return {
    isRepo,
    path: rel,
    oldContent,
    newContent,
    hunks,
    additions: hunks.reduce((n, h) => n + h.additions, 0),
    removals: hunks.reduce((n, h) => n + h.removals, 0),
    isNewFile: false,
    hasChanges: hunks.length > 0,
    baseline,
  }
}

export function getFileDiff(workspace: string, filePath: string, currentContent?: string): GitFileDiff {
  if (!workspace?.trim() || !filePath?.trim()) {
    return emptyDiff(workspace, filePath, currentContent)
  }
  const rel = relativeToWorkspace(workspace, filePath)
  const abs = resolveInWorkspace(workspace, filePath)
  const newContent = typeof currentContent === 'string'
    ? currentContent
    : fs.existsSync(abs)
      ? fs.readFileSync(abs, 'utf-8')
      : ''

  const baselineRecord = loadBaselineStore(workspace).records[rel]
  if (baselineRecord?.pending) {
    return buildDiff(rel, baselineRecord.oldContent, newContent, 'shadow', true)
  }
  if (baselineRecord?.acceptedHash && baselineRecord.acceptedHash === contentHash(newContent)) {
    return buildDiff(rel, newContent, newContent, 'shadow', true)
  }

  // Preferred baseline: the shadow checkpoint captured immediately before an
  // agent file-mutating tool ran. This works even when the user's workspace is
  // not a git repo and avoids comparing against unrelated pre-existing user
  // changes.
  if (hasShadowHead(workspace)) {
    const oldContent = getShadowFileContentAtHead(workspace, rel)
    // A shadow repo may exist with only its initial empty commit (for example
    // after opening the checkpoints UI). Do not treat every existing workspace
    // file as a new agent-created file until a real checkpoint has tracked at
    // least one file.
    if (oldContent !== null || shadowHeadTracksAnyFile(workspace)) {
      return buildDiff(rel, oldContent, newContent, 'shadow', true)
    }
  }

  // Fallback for normal manual edits in git repositories.
  const status = getStatus(workspace)
  if (!status.isRepo) return emptyDiff(workspace, rel, newContent)
  return buildDiff(rel, getFileContentAtHead(workspace, rel), newContent, 'git', true)
}

export function discardFileChanges(workspace: string, filePath: string): { ok: true; deleted: boolean; path: string } {
  const rel = relativeToWorkspace(workspace, filePath)
  const abs = resolveInWorkspace(workspace, filePath)
  const store = loadBaselineStore(workspace)
  const baselineRecord = store.records[rel]
  if (baselineRecord?.pending) {
    if (baselineRecord.oldContent === null) {
      if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
      delete store.records[rel]
      saveBaselineStore(workspace, store)
      return { ok: true, deleted: true, path: rel }
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, baselineRecord.oldContent, 'utf-8')
    delete store.records[rel]
    saveBaselineStore(workspace, store)
    return { ok: true, deleted: false, path: rel }
  }

  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : ''
  const diff = getFileDiff(workspace, filePath, current)
  const oldContent = diff.hasChanges ? diff.oldContent : getFileContentAtHead(workspace, rel)
  if (oldContent === null) {
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
    return { ok: true, deleted: true, path: rel }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, oldContent, 'utf-8')
  return { ok: true, deleted: false, path: rel }
}

export function acceptFileChanges(workspace: string, filePath: string): { ok: true; path: string; baseline: 'shadow' } {
  const rel = relativeToWorkspace(workspace, filePath)
  const abs = resolveInWorkspace(workspace, filePath)
  const currentContent = readCurrentContent(abs)
  const store = loadBaselineStore(workspace)
  store.records[rel] = {
    path: rel,
    oldContent: currentContent,
    pending: false,
    acceptedHash: contentHash(currentContent),
    updatedAt: Date.now(),
  }
  saveBaselineStore(workspace, store)

  ensureShadowRepo(workspace)
  runShadowGit(workspace, ['add', '-A', '--', rel], 15000)
  const status = runShadowGit(workspace, ['status', '--porcelain', '--', rel], 15000)
  if ((status.stdout?.toString() ?? '').trim()) {
    runShadowGit(workspace, ['commit', '-m', `accept inline diff ${rel}`, '--quiet'], 30000)
  }
  return { ok: true, path: rel, baseline: 'shadow' }
}
