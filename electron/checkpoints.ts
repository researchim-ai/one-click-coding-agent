/**
 * Shadow-git checkpoints: a safety net for agent edits.
 *
 * Idea (same as Roo Code): we keep a *second* git repository outside of the
 * user's workspace, whose work-tree is the workspace itself. Every time the
 * agent is about to modify files, we take a snapshot (commit) in that shadow
 * repo. The user's own .git (if any) is completely untouched, so no commits
 * pollute their history and no merges fight with the agent's snapshots.
 *
 * Restore = hard reset of the shadow repo, which rewrites the workspace files
 * back to the state at that checkpoint. Before every restore we take ANOTHER
 * checkpoint, so "undo the undo" is always possible.
 *
 * Storage: ~/.one-click-agent/checkpoints/<hash-of-workspace-abs-path>/.git
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as os from 'os'

export interface Checkpoint {
  sha: string
  label: string
  timestampMs: number
}

function rootDir(): string {
  return path.join(os.homedir(), '.one-click-agent', 'checkpoints')
}

function workspaceSlug(workspace: string): string {
  const abs = path.resolve(workspace)
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 12)
  // Append a human-readable basename so the directory is scannable by eye.
  const base = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32) || 'workspace'
  return `${base}-${hash}`
}

export function shadowGitDir(workspace: string): string {
  return path.join(rootDir(), workspaceSlug(workspace), '.git')
}

function gitEnv(workspace: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: shadowGitDir(workspace),
    GIT_WORK_TREE: path.resolve(workspace),
    GIT_AUTHOR_NAME: 'one-click-agent',
    GIT_AUTHOR_EMAIL: 'agent@local',
    GIT_COMMITTER_NAME: 'one-click-agent',
    GIT_COMMITTER_EMAIL: 'agent@local',
    // Don't honor ~/.gitconfig or /etc/gitconfig — we want a consistent
    // identity for agent snapshots even when the user has signing
    // requirements, custom hooks, templateDir, etc.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // templateDir=/dev/null stops `git init` from copying the user's hooks
    // (we don't want pre-commit running on agent snapshots).
    GIT_TEMPLATE_DIR: '/dev/null',
  }
}

function runGit(args: string[], workspace: string, opts: { allowFail?: boolean } = {}): string {
  try {
    const out = execFileSync('git', args, {
      cwd: path.resolve(workspace),
      env: gitEnv(workspace),
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.toString().trim()
  } catch (e: any) {
    if (opts.allowFail) return ''
    const stderr = e?.stderr?.toString?.() ?? ''
    throw new Error(`git ${args.join(' ')} failed: ${stderr || e?.message || e}`)
  }
}

// Patterns applied as a fallback via .git/info/exclude — merged with the
// user's .gitignore. Intentionally close to what Roo Code / Aider ignore by
// default. We never snapshot these because (a) restore would overwrite user
// state we shouldn't touch, and (b) they'd balloon repo size.
const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules/',
  '.git/',
  '.venv/', 'venv/', 'env/',
  '__pycache__/',
  'dist/', 'build/', '.next/', '.nuxt/',
  '.cache/', '.turbo/', '.parcel-cache/',
  'target/',
  'coverage/', '.nyc_output/',
  '*.log',
  '*.pyc',
  '*.class',
  '*.o', '*.a', '*.so', '*.dylib',
  '.DS_Store', 'Thumbs.db',
  '.one-click-agent/',
]

let initializedRepos = new Set<string>()

export function ensureShadowRepo(workspace: string): void {
  const gitDir = shadowGitDir(workspace)
  const key = path.resolve(workspace)
  if (initializedRepos.has(key) && fs.existsSync(gitDir)) return

  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(path.dirname(gitDir), { recursive: true })
    // `git init` with GIT_DIR pointing at a non-existent dir creates it there.
    runGit(['init', '--quiet'], workspace)
    // Write a sane default exclude file — respects the user's own .gitignore
    // but also protects us when the workspace has none (we don't want to
    // snapshot 2 GB of node_modules as the "initial" state).
    try {
      const excludePath = path.join(gitDir, 'info', 'exclude')
      fs.mkdirSync(path.dirname(excludePath), { recursive: true })
      fs.writeFileSync(excludePath, DEFAULT_EXCLUDE_PATTERNS.join('\n') + '\n')
    } catch {}
    // One initial empty commit so HEAD always resolves.
    runGit(['commit', '--allow-empty', '-m', 'init', '--quiet'], workspace, { allowFail: true })
  }
  // Always set identity — keeps things predictable regardless of user state.
  runGit(['config', 'user.name', 'one-click-agent'], workspace, { allowFail: true })
  runGit(['config', 'user.email', 'agent@local'], workspace, { allowFail: true })
  // Make commits fast: don't autogc on every operation.
  runGit(['config', 'gc.auto', '0'], workspace, { allowFail: true })
  // Larger packfiles are fine; we never push this repo.
  runGit(['config', 'core.compression', '1'], workspace, { allowFail: true })
  initializedRepos.add(key)
}

function headSha(workspace: string): string | null {
  try {
    return runGit(['rev-parse', 'HEAD'], workspace) || null
  } catch {
    return null
  }
}

/**
 * Take a snapshot of the workspace. If nothing has changed since HEAD, returns
 * the existing HEAD (dedup — we don't bloat the log with identical commits).
 */
export function createCheckpoint(workspace: string, label: string): Checkpoint | null {
  try {
    ensureShadowRepo(workspace)
    runGit(['add', '-A'], workspace, { allowFail: true })
    const status = runGit(['status', '--porcelain'], workspace, { allowFail: true })
    if (!status) {
      const head = headSha(workspace)
      if (!head) return null
      return { sha: head, label, timestampMs: Date.now() }
    }
    runGit(['commit', '-m', label, '--quiet'], workspace, { allowFail: true })
    const sha = headSha(workspace)
    if (!sha) return null
    return { sha, label, timestampMs: Date.now() }
  } catch (e: any) {
    console.error('[checkpoints] createCheckpoint failed:', e?.message ?? e)
    return null
  }
}

export function listCheckpoints(workspace: string, limit = 200): Checkpoint[] {
  try {
    ensureShadowRepo(workspace)
    const out = runGit(
      ['log', '-n', String(limit), '--pretty=format:%H%x09%ct%x09%s'],
      workspace,
      { allowFail: true },
    )
    if (!out) return []
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, tsStr, ...rest] = line.split('\t')
      return {
        sha,
        timestampMs: (parseInt(tsStr, 10) || 0) * 1000,
        label: rest.join('\t') || '(no message)',
      }
    })
  } catch {
    return []
  }
}

/**
 * Restore workspace files to the given checkpoint SHA. Before doing so, we
 * take one more snapshot of the *current* state so the restore itself is
 * reversible.
 */
export function restoreCheckpoint(workspace: string, sha: string): Checkpoint | null {
  ensureShadowRepo(workspace)
  // Snapshot current state first so "undo the undo" is always one click away.
  const safety = createCheckpoint(workspace, `before-restore-of-${sha.slice(0, 10)}`)
  // Validate SHA exists in shadow repo before destructive action.
  try {
    runGit(['cat-file', '-e', `${sha}^{commit}`], workspace)
  } catch (e: any) {
    throw new Error(`Checkpoint ${sha.slice(0, 10)} not found in shadow repo`)
  }
  runGit(['reset', '--hard', sha, '--quiet'], workspace)
  // `reset --hard` doesn't remove untracked files. Do a clean to match the
  // checkpoint state exactly, but be conservative: only files the shadow repo
  // knows are ignored by `.gitignore` are preserved. Other untracked-but-not-
  // ignored files (agent-created garbage) get pruned.
  runGit(['clean', '-fd'], workspace, { allowFail: true })
  return safety
}

/** Short human-friendly diff summary for UI tooltips. */
export function checkpointDiffStat(workspace: string, sha: string): string {
  try {
    ensureShadowRepo(workspace)
    return runGit(['diff', '--stat', `${sha}^..${sha}`], workspace, { allowFail: true })
  } catch {
    return ''
  }
}

/** Build a short label from a tool name + args. Used as commit message. */
export function describeToolForCheckpoint(name: string, args: Record<string, any>): string {
  const p = typeof args?.path === 'string' ? args.path : ''
  const cmd = typeof args?.command === 'string' ? args.command : ''
  switch (name) {
    case 'write_file':      return `before write_file ${p}`
    case 'edit_file':       return `before edit_file ${p}`
    case 'append_file':     return `before append_file ${p}`
    case 'delete_file':     return `before delete_file ${p}`
    case 'create_directory':return `before create_directory ${p}`
    case 'execute_command': return `before execute_command ${cmd.slice(0, 80)}`
    default:                return `before ${name}`
  }
}
