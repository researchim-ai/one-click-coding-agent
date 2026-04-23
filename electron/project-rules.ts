/**
 * Project-level agent instructions, loaded from a handful of conventional
 * files and injected into the system prompt at session start.
 *
 * Supported filenames (checked in this order — all found are concatenated):
 *   AGENTS.md                     — cross-tool industry convention (OpenAI,
 *                                   Anthropic, Aider, and friends use it)
 *   CLAUDE.md                     — Claude-specific rules
 *   .cursorrules                  — legacy single-file Cursor rules
 *   .cursor/rules/*.md            — current Cursor convention (many files)
 *   .github/copilot-instructions.md — GitHub Copilot convention
 *
 * These are project-scoped, never edited by us. If a user has rules they
 * already wrote for other tools, we pick them up for free.
 */
import * as fs from 'fs'
import * as path from 'path'

/** Hard ceiling on total rule content we'll inject. Protects small contexts
 *  from being eaten by a giant AGENTS.md. 16 KB ≈ ~4k tokens — enough for
 *  long style guides, still leaves room for actual work. */
export const MAX_RULES_BYTES = 16 * 1024

export interface LoadedRuleFile {
  /** Absolute path. */
  path: string
  /** Path relative to workspace root, for UI display. */
  relativePath: string
  /** Byte length of the file content (pre-truncation). */
  bytes: number
}

export interface ProjectRules {
  /** Combined markdown block ready to be prefixed to the system prompt.
   *  Empty string if no rule files were found. */
  content: string
  /** Which files contributed content (in load order). */
  files: LoadedRuleFile[]
  /** Whether we had to truncate the combined content to fit MAX_RULES_BYTES. */
  truncated: boolean
}

/** Read a single file if it exists and is a regular file under MAX size.
 *  Returns null for missing / oversized / unreadable. */
function readRuleFile(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) return null
    // Cap each individual file at 2× the total limit — we'll trim later.
    if (stat.size > MAX_RULES_BYTES * 2) {
      return fs.readFileSync(absPath, 'utf-8').slice(0, MAX_RULES_BYTES * 2)
    }
    return fs.readFileSync(absPath, 'utf-8')
  } catch {
    return null
  }
}

/** Enumerate the candidate files in priority order. */
function candidateFiles(workspace: string): string[] {
  const ws = path.resolve(workspace)
  const list: string[] = [
    path.join(ws, 'AGENTS.md'),
    path.join(ws, 'AGENT.md'),
    path.join(ws, 'CLAUDE.md'),
    path.join(ws, '.cursorrules'),
    path.join(ws, '.github', 'copilot-instructions.md'),
  ]
  // .cursor/rules/*.md — add them sorted alphabetically so the order is
  // stable across runs.
  try {
    const rulesDir = path.join(ws, '.cursor', 'rules')
    if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
      const entries = fs.readdirSync(rulesDir).sort()
      for (const e of entries) {
        if (e.endsWith('.md') || e.endsWith('.mdc')) list.push(path.join(rulesDir, e))
      }
    }
  } catch {}
  return list
}

export function loadProjectRules(workspace: string): ProjectRules {
  if (!workspace) return { content: '', files: [], truncated: false }

  const files: LoadedRuleFile[] = []
  const blocks: string[] = []
  let totalBytes = 0
  let truncated = false

  for (const abs of candidateFiles(workspace)) {
    const raw = readRuleFile(abs)
    if (raw == null) continue
    const trimmed = raw.trim()
    if (!trimmed) continue

    const rel = path.relative(workspace, abs)
    const bytes = Buffer.byteLength(trimmed, 'utf-8')
    // Wrap each file in a fenced section so the LLM can tell them apart.
    const block = `### ${rel}\n${trimmed}`
    const blockBytes = Buffer.byteLength(block, 'utf-8')

    if (totalBytes + blockBytes > MAX_RULES_BYTES) {
      // Try to include as much of this file as still fits. If even a trimmed
      // version would be useless (< 256 bytes), skip it.
      const remaining = MAX_RULES_BYTES - totalBytes - (`### ${rel}\n\n… [truncated]\n`.length)
      if (remaining > 256) {
        const sliced = trimmed.slice(0, remaining)
        const block2 = `### ${rel}\n${sliced}\n… [truncated]\n`
        blocks.push(block2)
        files.push({ path: abs, relativePath: rel, bytes })
        totalBytes += Buffer.byteLength(block2, 'utf-8')
      }
      truncated = true
      break
    }

    blocks.push(block)
    files.push({ path: abs, relativePath: rel, bytes })
    totalBytes += blockBytes
  }

  if (blocks.length === 0) {
    return { content: '', files: [], truncated: false }
  }

  const header = '## Project-specific rules\nThe user has committed the following agent instructions to this repository. Treat them as authoritative — they override generic defaults when in conflict.\n'
  const content = `${header}\n${blocks.join('\n\n')}\n`
  return { content, files, truncated }
}

/** Lightweight metadata lookup used by IPC — no full file content, just the
 *  list of filenames + sizes, for the UI pill. */
export function describeProjectRules(workspace: string): { files: LoadedRuleFile[]; truncated: boolean; totalBytes: number } {
  const r = loadProjectRules(workspace)
  return {
    files: r.files,
    truncated: r.truncated,
    totalBytes: r.files.reduce((acc, f) => acc + f.bytes, 0),
  }
}
