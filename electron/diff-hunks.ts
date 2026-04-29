/**
 * Line-level diff + hunk grouping + selective apply.
 *
 * Powers the "inline diff per-hunk" review UX: when the agent proposes a
 * `write_file` or `edit_file`, we split the change into logical hunks and
 * let the user accept or reject each one. The rest stays outside any
 * Electron/renderer dependency so it's trivially unit-testable.
 *
 * The diff algorithm is a classic LCS (longest-common-subsequence) on
 * lines. For the typical agent change (< a few thousand lines), this is
 * fast and produces human-friendly hunks. We don't try to compete with
 * Myers for huge files — if you're diffing a 50K-line file you have
 * bigger problems.
 */

import fs from 'fs'
import path from 'path'

export type HunkLineKind = 'context' | 'add' | 'remove'

export interface HunkLine {
  kind: HunkLineKind
  /** 1-based line number in the "old" text (null for pure additions). */
  oldLine: number | null
  /** 1-based line number in the "new" text (null for pure removals). */
  newLine: number | null
  text: string
}

export interface Hunk {
  /** Stable id within this diff — 0-based index. */
  id: number
  /** Starting line in the old file (1-based), 0 if file is new. */
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
  /** Convenience counts for the UI ("+12 / -3"). */
  additions: number
  removals: number
}

export interface DiffResult {
  /** Path (workspace-relative or absolute — caller decides). */
  path: string
  /** `null` if the target file doesn't exist yet — the change creates it. */
  oldContent: string | null
  newContent: string
  hunks: Hunk[]
  /** True when oldContent === newContent. Callers typically skip the review. */
  identical: boolean
}

// ---------------------------------------------------------------------------
// Line-level diff (LCS)
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  // Preserve trailing empty line (common for files ending with \n). We want
  // a diff that correctly represents "added a trailing newline".
  if (text === '') return []
  return text.split('\n')
}

/** Standard LCS DP table. Returns an operation list in order:
 *  'eq' (take from both), 'del' (take from old), 'ins' (take from new). */
type Op = { kind: 'eq' | 'del' | 'ins'; oldIdx?: number; newIdx?: number }

function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  // 2-row DP to keep memory linear. We still need the full table to walk
  // back, so use it anyway — ok for expected sizes (< 10K lines).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const ops: Op[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'eq', oldIdx: i - 1, newIdx: j - 1 })
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ kind: 'del', oldIdx: i - 1 })
      i--
    } else {
      ops.push({ kind: 'ins', newIdx: j - 1 })
      j--
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', oldIdx: i - 1 })
    i--
  }
  while (j > 0) {
    ops.push({ kind: 'ins', newIdx: j - 1 })
    j--
  }
  return ops.reverse()
}

/** Group raw edit ops into hunks, each wrapped in `context` lines of
 *  unchanged text. Consecutive changes separated by less than
 *  `2 * context` unchanged lines are merged into a single hunk so the
 *  user doesn't have to click accept on 10 tiny hunks that all logically
 *  belong together. */
export function computeHunks(oldText: string, newText: string, context = 3): Hunk[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const ops = lcsDiff(oldLines, newLines)

  // First pass: find "change runs" (contiguous sequences of del/ins).
  interface Run {
    opStart: number
    opEnd: number // exclusive
  }
  const runs: Run[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k].kind === 'eq') {
      k++
      continue
    }
    const start = k
    while (k < ops.length && ops[k].kind !== 'eq') k++
    runs.push({ opStart: start, opEnd: k })
  }
  if (runs.length === 0) return []

  // Second pass: merge runs whose gap of unchanged ops is less than 2 * context.
  const merged: Run[] = []
  for (const run of runs) {
    const prev = merged[merged.length - 1]
    if (prev && run.opStart - prev.opEnd < 2 * context) {
      prev.opEnd = run.opEnd
    } else {
      merged.push({ ...run })
    }
  }

  // Third pass: expand each run with `context` unchanged ops on both sides
  // to form the final hunk boundaries.
  const hunks: Hunk[] = []
  merged.forEach((run, idx) => {
    const startOp = Math.max(0, run.opStart - context)
    const endOp = Math.min(ops.length, run.opEnd + context)
    const lines: HunkLine[] = []
    let oldStart = -1
    let newStart = -1
    let oldCount = 0
    let newCount = 0
    let adds = 0
    let rems = 0
    for (let p = startOp; p < endOp; p++) {
      const op = ops[p]
      if (op.kind === 'eq') {
        const oldIdx = op.oldIdx!
        const newIdx = op.newIdx!
        if (oldStart < 0) oldStart = oldIdx + 1
        if (newStart < 0) newStart = newIdx + 1
        oldCount++
        newCount++
        lines.push({ kind: 'context', oldLine: oldIdx + 1, newLine: newIdx + 1, text: oldLines[oldIdx] })
      } else if (op.kind === 'del') {
        const oldIdx = op.oldIdx!
        if (oldStart < 0) oldStart = oldIdx + 1
        oldCount++
        rems++
        lines.push({ kind: 'remove', oldLine: oldIdx + 1, newLine: null, text: oldLines[oldIdx] })
      } else {
        const newIdx = op.newIdx!
        if (newStart < 0) newStart = newIdx + 1
        newCount++
        adds++
        lines.push({ kind: 'add', oldLine: null, newLine: newIdx + 1, text: newLines[newIdx] })
      }
    }
    hunks.push({
      id: idx,
      oldStart: oldStart < 0 ? 0 : oldStart,
      oldCount,
      newStart: newStart < 0 ? 0 : newStart,
      newCount,
      lines,
      additions: adds,
      removals: rems,
    })
  })
  return hunks
}

/** Apply only the selected hunks to the old text, rejecting the rest.
 *  The result is a well-formed text that's BETWEEN `oldText` and
 *  `newText`: it contains every line that the user approved, with
 *  everything else copied from the original. */
export function applySelectedHunks(
  oldText: string,
  hunks: Hunk[],
  selectedHunkIds: number[],
): string {
  if (hunks.length === 0) return oldText
  const selected = new Set(selectedHunkIds)
  const oldLines = splitLines(oldText)
  const out: string[] = []

  // Walk through old lines; when we hit the start of a hunk, decide:
  //   - selected: emit hunk.lines (context + additions), skip removed old lines
  //   - rejected: fall through, copy old lines as-is
  let oldIdx = 0 // 0-based
  // Sort hunks by oldStart just in case.
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart)
  let h = 0
  while (oldIdx < oldLines.length) {
    const hunk = sorted[h]
    const hunkStart = hunk ? (hunk.oldStart > 0 ? hunk.oldStart - 1 : 0) : -1
    if (hunk && oldIdx === hunkStart) {
      if (selected.has(hunk.id)) {
        for (const line of hunk.lines) {
          if (line.kind === 'add' || line.kind === 'context') out.push(line.text)
        }
        oldIdx += hunk.oldCount
      } else {
        for (const line of hunk.lines) {
          if (line.kind === 'remove' || line.kind === 'context') out.push(line.text)
        }
        oldIdx += hunk.oldCount
      }
      h++
    } else {
      out.push(oldLines[oldIdx])
      oldIdx++
    }
  }

  // Handle hunks that only contain pure additions past the end of old (h < sorted.length).
  for (; h < sorted.length; h++) {
    const hunk = sorted[h]
    if (selected.has(hunk.id)) {
      for (const line of hunk.lines) {
        if (line.kind === 'add') out.push(line.text)
      }
    }
  }

  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Previews — wire-level helpers used by `agent.ts` before calling the tool
// ---------------------------------------------------------------------------

function resolveInWorkspace(filePath: string, workspace: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workspace, filePath)
}

/** Preview a `write_file` call. Returns everything a HunkReview UI needs
 *  to render, including the list of hunks if the file already exists. */
export function previewWriteFile(
  args: { path: string; content: string },
  workspace: string,
): DiffResult {
  const abs = resolveInWorkspace(args.path, workspace)
  const newContent = typeof args.content === 'string' ? args.content : ''
  let oldContent: string | null = null
  try {
    oldContent = fs.readFileSync(abs, 'utf-8')
  } catch {
    oldContent = null
  }
  if (oldContent === null) {
    // New file: render a single synthetic hunk with all additions so the
    // UI can still show "accept / reject".
    const newLines = splitLines(newContent)
    const lines: HunkLine[] = newLines.map((t, i) => ({
      kind: 'add' as const,
      oldLine: null,
      newLine: i + 1,
      text: t,
    }))
    return {
      path: args.path,
      oldContent: null,
      newContent,
      identical: false,
      hunks: lines.length
        ? [
            {
              id: 0,
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: newLines.length,
              lines,
              additions: newLines.length,
              removals: 0,
            },
          ]
        : [],
    }
  }
  if (oldContent === newContent) {
    return { path: args.path, oldContent, newContent, hunks: [], identical: true }
  }
  const hunks = computeHunks(oldContent, newContent)
  return { path: args.path, oldContent, newContent, hunks, identical: false }
}

/** Preview an `edit_file` call. Mirrors `tools.editFile`'s validation so
 *  we can show a diff without writing anything. On failure returns an
 *  `error` string instead of a DiffResult. */
export function previewEditFile(
  args: { path: string; old_string: string; new_string: string },
  workspace: string,
): DiffResult | { error: string } {
  const abs = resolveInWorkspace(args.path, workspace)
  if (!fs.existsSync(abs)) {
    return { error: `File not found: ${args.path}` }
  }
  const oldContent = fs.readFileSync(abs, 'utf-8')
  const oldStr = args.old_string ?? ''
  const newStr = args.new_string ?? ''
  const occurrences = oldContent.split(oldStr).length - 1
  if (occurrences === 0) {
    return {
      error: `Error: old_string not found in ${args.path}. Make sure you copied the exact text including whitespace.`,
    }
  }
  if (occurrences > 1) {
    return {
      error: `Error: old_string found ${occurrences} times in ${args.path}. It must be unique — include more surrounding context.`,
    }
  }
  const newContent = oldContent.replace(oldStr, newStr)
  if (oldContent === newContent) {
    return { path: args.path, oldContent, newContent, hunks: [], identical: true }
  }
  return {
    path: args.path,
    oldContent,
    newContent,
    hunks: computeHunks(oldContent, newContent),
    identical: false,
  }
}
