/**
 * Hierarchical conversation archive.
 *
 * When we compact old messages into a summary, we LOSE the literal text
 * forever — it's gone from the active context. For most cases the
 * summary is enough, but sometimes the agent (or the user) needs a
 * specific quote: an earlier error message, a tool result, a decision
 * rationale. This module persists a full log of every message that ever
 * entered the conversation, keyed by session, and gives the agent a
 * `recall` tool to search back through it.
 *
 * Design:
 *   - One JSONL file per session under
 *     `~/.one-click-agent/archives/<workspaceKey>/<sessionId>.jsonl`.
 *   - Append-only. Readers seek and stream, so files can grow into tens
 *     of MB without blowing memory.
 *   - Each line is an `ArchivedMessage`: role, compact content, iteration,
 *     timestamp, optional tool call / result metadata.
 *   - Search is substring-based over the raw text (case-insensitive),
 *     bounded to the most recent N matches. No embedding index — on
 *     typical conversation volumes this is plenty fast.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const ARCHIVE_ROOT = path.join(os.homedir(), '.one-click-agent', 'archives')

export interface ArchivedMessage {
  role: string
  content: string
  turn: number
  ts: number
  /** Non-empty for assistant messages that requested tool calls. */
  toolNames?: string[]
  /** For `tool` messages — which tool generated this result. */
  toolName?: string
}

function archiveFile(workspaceKey: string, sessionId: string): string {
  const dir = path.join(ARCHIVE_ROOT, workspaceKey)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${sessionId}.jsonl`)
}

/** Append a batch of messages to the archive. Silently no-ops on errors:
 *  archiving is best-effort, never let it break a live agent run. */
export function appendMessages(
  workspaceKey: string,
  sessionId: string,
  entries: ArchivedMessage[],
): void {
  if (!entries.length) return
  try {
    const file = archiveFile(workspaceKey, sessionId)
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    fs.appendFileSync(file, lines, 'utf-8')
  } catch {
    // ignore
  }
}

/** Read all archived messages for a session. Returns [] on missing file. */
export function readArchive(workspaceKey: string, sessionId: string): ArchivedMessage[] {
  try {
    const file = archiveFile(workspaceKey, sessionId)
    if (!fs.existsSync(file)) return []
    const raw = fs.readFileSync(file, 'utf-8')
    const out: ArchivedMessage[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
    return out
  } catch {
    return []
  }
}

export interface RecallHit {
  role: string
  turn: number
  ts: number
  toolName?: string
  score?: number
  /** A 240-char-ish window around the match. */
  excerpt: string
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = text.indexOf(needle, idx)) >= 0) {
    count++
    idx += Math.max(needle.length, 1)
  }
  return count
}

/** Case-insensitive search over the archive. Results are ranked by a small
 * relevance score (exact phrase, term coverage, occurrence count, freshness)
 * instead of returning only the last N raw substring matches. */
export function recall(
  workspaceKey: string,
  sessionId: string,
  query: string,
  maxHits: number = 8,
): RecallHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter((t) => t.length >= 3).slice(0, 8)
  const entries = readArchive(workspaceKey, sessionId)
  const hits: RecallHit[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!e.content) continue
    const text = e.content
    const lower = text.toLowerCase()
    const phraseIdx = lower.indexOf(q)
    const matchedTerms = terms.filter((t) => lower.includes(t))
    if (phraseIdx < 0 && matchedTerms.length === 0) continue
    const idx = phraseIdx >= 0 ? phraseIdx : lower.indexOf(matchedTerms[0])
    const before = Math.max(0, idx - 80)
    const after = Math.min(text.length, idx + q.length + 160)
    const excerpt = (before > 0 ? '…' : '') + text.slice(before, after) + (after < text.length ? '…' : '')
    const phraseScore = phraseIdx >= 0 ? 10 : 0
    const coverageScore = matchedTerms.length * 3
    const occurrenceScore = Math.min(8, countOccurrences(lower, q) * 2 + matchedTerms.reduce((acc, t) => acc + countOccurrences(lower, t), 0))
    const recencyScore = Math.min(4, Math.max(0, i + 1) / Math.max(1, entries.length) * 4)
    hits.push({
      role: e.role,
      turn: e.turn,
      ts: e.ts,
      toolName: e.toolName,
      score: phraseScore + coverageScore + occurrenceScore + recencyScore,
      excerpt,
    })
  }
  return hits
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.ts - a.ts)
    .slice(0, maxHits)
}

/** Delete the archive file for a session (called when user deletes the
 *  session). */
export function deleteArchive(workspaceKey: string, sessionId: string): void {
  try { fs.unlinkSync(archiveFile(workspaceKey, sessionId)) } catch {}
}

/** The `recall` tool definition exposed to the LLM. */
export const RECALL_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'recall',
    description:
      'Search the complete (uncompressed) conversation archive for this session. Use this when you need to look up a specific detail (error message, tool output, prior decision) that may have been compressed out of the active context. Returns up to 8 most-recent excerpts matching your query.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to search for (case-insensitive). Pick distinctive phrases — short common words give noise.',
        },
      },
      required: ['query'],
    },
  },
} as const
