import { BrowserWindow, ipcMain } from 'electron'
import { llamaApiUrl, getCtxSize } from './server-manager'
import { TOOL_DEFINITIONS, executeTool, executeCustomTool } from './tools'
import * as config from './config'
import type { AgentEvent } from './types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ---------------------------------------------------------------------------
// Debug logging — writes to ~/.one-click-agent/agent-debug.log
// ---------------------------------------------------------------------------

const LOG_FILE = path.join(os.homedir(), '.one-click-agent', 'agent-debug.log')

function debugLog(category: string, ...args: any[]) {
  try {
    const ts = new Date().toISOString()
    const msg = args.map((a) => typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)).join(' ')
    const line = `[${ts}] [${category}] ${msg}\n`
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

const NEEDS_APPROVAL = new Set(['execute_command', 'write_file', 'edit_file', 'delete_file'])

const MAX_ITERATIONS = 30
const FALLBACK_CTX_TOKENS = 32768
const SUMMARIZE_TIMEOUT_MS = 60000
const MAX_EMPTY_RETRIES = 2

// Graduated compression thresholds (fraction of message budget)
const COMPRESS_TOOL_RESULTS_AT = 0.35
const SUMMARIZE_AT = 0.55
const AGGRESSIVE_PRUNE_AT = 0.80
const EMERGENCY_AT = 0.92

function keepRecentTurns(): number {
  const budget = getMessageBudget()
  if (budget < 3000) return 2
  if (budget < 6000) return 3
  return 4
}

// ---------------------------------------------------------------------------
// Accurate token counting via server /tokenize endpoint (with heuristic fallback)
// ---------------------------------------------------------------------------

let tokenizeAvailable: boolean | null = null

async function countTokensViaServer(text: string): Promise<number | null> {
  if (tokenizeAvailable === false) return null
  try {
    const r = await fetch(`${llamaApiUrl()}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) { tokenizeAvailable = false; return null }
    const json = await r.json() as any
    if (Array.isArray(json.tokens)) {
      tokenizeAvailable = true
      return json.tokens.length
    }
    return null
  } catch {
    tokenizeAvailable = false
    return null
  }
}

let tokenRatioCalibrated = false
let calibratedRatio = 3.2 // chars per token, updated after first real measurement

async function calibrateTokenRatio(): Promise<void> {
  if (tokenRatioCalibrated) return
  const sample = 'Hello, I am an AI assistant. I can help you write code, debug errors, and answer questions about programming.'
  const serverCount = await countTokensViaServer(sample)
  if (serverCount && serverCount > 0) {
    calibratedRatio = sample.length / serverCount
    tokenRatioCalibrated = true
  }
}

export const DEFAULT_SYSTEM_PROMPT = `You are an expert software engineer working as an autonomous coding agent. You operate inside a local development environment and interact with the user's project through tools.

## Core workflow

1. **Explore first.** On every new task, start by understanding the project: run list_directory to see the structure, then read_file on key files (package.json, README, config files, main entry points).
2. **Search before guessing.** Use find_files with type="content" to locate relevant code. Don't assume file locations.
3. **Read before editing.** Always read_file before using edit_file. The old_string must be copied exactly from what you read.
4. **Make targeted edits.** Use edit_file for modifying existing files — never rewrite an entire file just to change a few lines. Use write_file only for brand new files.
5. **Verify your work.** After making changes, run the project's test suite, linter, or type-checker. If you broke something, fix it immediately.
6. **Iterate.** Complex tasks require multiple rounds of explore → edit → verify. Don't try to do everything in one shot.

## Tool usage

- **read_file**: Returns line-numbered content. Use offset/limit for files > 500 lines. Always read before editing.
- **edit_file**: old_string must exactly match file content (whitespace, indentation). If not unique, include more surrounding lines for context.
- **write_file**: Only for NEW files. Creates parent directories automatically.
- **list_directory**: Tree view. Use depth=1 for quick overview, depth=4 for detailed exploration.
- **find_files**: type="name" for glob patterns ("*.tsx", "Dockerfile"), type="content" for grep-like search.
- **execute_command**: For git, build, test, lint, install commands. Always check the exit code in the result.
- **create_directory**: Creates nested directories. Use before write_file if the parent dir might not exist.
- **delete_file**: Removes a file. Use with care — verify the path first.

## Code quality

- Match existing code style exactly (indentation, quotes, semicolons, naming)
- Write clean, idiomatic code for the language/framework used
- Add error handling where appropriate
- Don't leave debug code, console.logs, or commented-out code
- Keep changes minimal and focused

## Communication

- Think step by step. Before calling tools or replying, briefly reason in **hidden scratchpad** wrapped in \`<think> ... </think>\`. This will be shown in a separate \"thinking\" panel, not as part of the final answer.
- Keep the visible answer clean: no \`<think>\` tags, only the final plan and results.
- Be concise. Explain WHAT you're doing and WHY, not HOW (the tool calls show that)
- Use markdown: \`code\`, **bold** for emphasis, lists for multiple items
- After finishing, give a brief summary of all changes made
- Respond in the same language the user writes in
- If a task is ambiguous, state your interpretation and proceed`

export const DEFAULT_SUMMARIZE_PROMPT = `You are a conversation compressor. Summarize the following conversation between a user and an AI coding agent.

Create a structured summary preserving:
1. All tasks requested and outcomes (completed / failed / in-progress)
2. Files read, created, modified, or deleted (full paths)
3. Key technical decisions and reasoning
4. Current project state and pending work
5. Important errors encountered and how they were resolved

Be concise but keep all critical details: file paths, function names, error messages, architecture decisions.
Format as a compact bullet list. Use markdown.

CONVERSATION:
`

const COMPACT_SYSTEM_PROMPT = `You are an expert autonomous coding agent with access to tools.

## Workflow
1. Explore first: list_directory, read_file on key files
2. Search before guessing: find_files with type="content"
3. Read before editing: always read_file first
4. Make targeted edits: use edit_file, not full rewrites
5. Verify: run tests/linter after changes

## Rules
- Match existing code style exactly
- Keep changes minimal and focused
- Think step by step in <think>...</think> tags
- Be concise. Respond in the user's language
- Use tools efficiently — prefer read_file over execute_command cat`

function getSystemPrompt(): string {
  const custom = config.get('systemPrompt')
  if (custom) return custom
  return ctxTokens() < 16384 ? COMPACT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT
}

function getSummarizePrompt(): string {
  return config.get('summarizePrompt') || DEFAULT_SUMMARIZE_PROMPT
}

function compactToolDefs(tools: any[]): any[] {
  return tools.map((t) => {
    const fn = t.function
    const params = fn.parameters
    const compactProps: Record<string, any> = {}
    for (const [k, v] of Object.entries(params.properties ?? {})) {
      compactProps[k] = { type: (v as any).type }
    }
    return {
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description.split('.')[0] + '.',
        parameters: { ...params, properties: compactProps },
      },
    }
  })
}

function getAllTools(): any[] {
  const customTools = config.get('customTools').filter((t) => t.enabled)
  const customDefs = customTools.map((ct) => ({
    type: 'function',
    function: {
      name: ct.name,
      description: ct.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          ct.parameters.map((p) => [p.name, { type: 'string', description: p.description }]),
        ),
        required: ct.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }))
  const all = [...TOOL_DEFINITIONS, ...customDefs]
  // On small contexts, use compact descriptions to save ~40% tool overhead
  return ctxTokens() < 16384 ? compactToolDefs(all) : all
}

interface Message {
  role: string
  content?: string
  tool_calls?: any[]
  tool_call_id?: string
}

export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

interface Session {
  id: string
  title: string
  messages: Message[]
  uiMessages: any[]
  projectContextAdded: boolean
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>()
let activeSessionId: string | null = null
let workspace = ''

let currentAbort: AbortController | null = null
let cancelRequested = false

function sessionsDir(): string {
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const d = path.join(os.homedir(), '.one-click-agent', 'sessions')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function sessionFilePath(id: string): string {
  const path = require('path')
  return path.join(sessionsDir(), `${id}.json`)
}

function saveSession(session: Session): void {
  const fs = require('fs')
  try {
    fs.writeFileSync(sessionFilePath(session.id), JSON.stringify({
      id: session.id,
      title: session.title,
      messages: session.messages,
      uiMessages: session.uiMessages,
      projectContextAdded: session.projectContextAdded,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }), 'utf-8')
  } catch {}
}

function loadAllSessions(): void {
  const fs = require('fs')
  const path = require('path')
  try {
    const dir = sessionsDir()
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json'))
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
        const data = JSON.parse(raw)
        if (data.id && Array.isArray(data.messages)) {
          sessions.set(data.id, {
            id: data.id,
            title: data.title ?? 'Без названия',
            messages: data.messages,
            uiMessages: data.uiMessages ?? [],
            projectContextAdded: data.projectContextAdded ?? false,
            createdAt: data.createdAt ?? Date.now(),
            updatedAt: data.updatedAt ?? Date.now(),
          })
        }
      } catch {}
    }
  } catch {}
}

function deleteSessionFile(id: string): void {
  const fs = require('fs')
  try { fs.unlinkSync(sessionFilePath(id)) } catch {}
}

function generateSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function titleFromMessage(text: string): string {
  const clean = text.replace(/```[\s\S]*?```/g, '').replace(/\[.*?\]/g, '').trim()
  const firstLine = clean.split('\n')[0] ?? ''
  return firstLine.length > 50 ? firstLine.slice(0, 47) + '…' : firstLine || 'Новый чат'
}

function getActiveSession(): Session {
  if (activeSessionId && sessions.has(activeSessionId)) {
    return sessions.get(activeSessionId)!
  }
  const id = generateSessionId()
  const session: Session = {
    id,
    title: 'Новый чат',
    messages: [],
    uiMessages: [],
    projectContextAdded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  sessions.set(id, session)
  activeSessionId = id
  saveSession(session)
  return session
}

// ---------------------------------------------------------------------------
// Public session management
// ---------------------------------------------------------------------------

export function createSession(): string {
  const id = generateSessionId()
  const session: Session = {
    id,
    title: 'Новый чат',
    messages: [],
    uiMessages: [],
    projectContextAdded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  sessions.set(id, session)
  activeSessionId = id
  saveSession(session)
  return id
}

export function switchSession(id: string): boolean {
  if (!sessions.has(id)) return false
  activeSessionId = id
  return true
}

export function listSessions(): SessionInfo[] {
  return [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.filter((m) => m.role === 'user').length,
    }))
}

export function deleteSession(id: string): void {
  sessions.delete(id)
  deleteSessionFile(id)
  if (activeSessionId === id) {
    activeSessionId = null
  }
}

export function renameSession(id: string, title: string): void {
  const session = sessions.get(id)
  if (session) {
    session.title = title
    saveSession(session)
  }
}

export function getActiveSessionId(): string | null {
  return activeSessionId
}

export function saveUiMessages(id: string, uiMsgs: any[]): void {
  const session = sessions.get(id)
  if (session) {
    session.uiMessages = uiMsgs
    saveSession(session)
  }
}

export function getUiMessages(id: string): any[] {
  return sessions.get(id)?.uiMessages ?? []
}

export function initSessions(): void {
  loadAllSessions()
}

function emit(win: BrowserWindow, event: AgentEvent) {
  try {
    win.webContents.send('agent-event', event)
  } catch {}
}

function emitContextUsage(win: BrowserWindow, msgs: Message[]) {
  const used = estimateContextTokens(msgs)
  const budget = getMessageBudget()
  const maxCtx = ctxTokens()
  const pct = Math.round((used / budget) * 100)
  emit(win, {
    type: 'context_usage',
    contextUsage: { usedTokens: used, budgetTokens: budget, maxContextTokens: maxCtx, percent: Math.min(pct, 100) },
  })
}

function requestApproval(win: BrowserWindow, toolName: string, args: Record<string, any>): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const handler = (_event: any, responseId: string, approved: boolean) => {
      if (responseId === id) {
        ipcMain.removeListener('command-approval-response', handler)
        resolve(approved)
      }
    }
    ipcMain.on('command-approval-response', handler)
    emit(win, { type: 'command_approval', name: toolName, args, approvalId: id })
  })
}

function extractThinking(content: string): [string, string] {
  let thinking = ''
  let visible = content
  const re = /<think>([\s\S]*?)<\/think>/g
  let match
  while ((match = re.exec(content)) !== null) {
    thinking += (thinking ? '\n' : '') + match[1].trim()
  }
  visible = content.replace(re, '').trim()
  return [thinking, visible]
}

// ---------------------------------------------------------------------------
// Streaming LLM call — SSE parser with incremental think/response emission
// ---------------------------------------------------------------------------

function parseAccumulatedThinking(content: string): { thinking: string; visible: string; thinkingDone: boolean } {
  const openIdx = content.indexOf('<think>')
  if (openIdx === -1) return { thinking: '', visible: content.trim(), thinkingDone: true }

  const closeIdx = content.indexOf('</think>')
  if (closeIdx === -1) {
    return {
      thinking: content.slice(openIdx + 7).trim(),
      visible: content.slice(0, openIdx).trim(),
      thinkingDone: false,
    }
  }

  const thinking = content.slice(openIdx + 7, closeIdx).trim()
  const visible = (content.slice(0, openIdx) + content.slice(closeIdx + 8)).trim()
  return { thinking, visible, thinkingDone: true }
}

interface StreamResult {
  content: string
  toolCalls: any[] | undefined
}

async function streamLlmResponse(
  apiUrl: string,
  msgs: Message[],
  win: BrowserWindow,
  fullResponseSoFar: string,
  signal: AbortSignal,
  maxTokensOverride?: number,
): Promise<StreamResult> {
  const cleanMsgs = sanitizeMessages(msgs)
  const maxTok = (maxTokensOverride && maxTokensOverride > 0) ? maxTokensOverride : getMaxResponseTokens()
  const msgRoles = cleanMsgs.map((m) => m.role + (m.tool_calls ? `(${m.tool_calls.length}tc)` : '')).join(', ')
  debugLog('STREAM', `Sending request: ${cleanMsgs.length} msgs [${msgRoles}], max_tokens=${maxTok}, ctx=${ctxTokens()}, budget=${getMessageBudget()}, used=${estimateContextTokens(cleanMsgs)}`)

  const startMs = Date.now()
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen',
      messages: cleanMsgs,
      tools: getAllTools(),
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: maxTok,
      stream: true,
    }),
    signal,
  })

  debugLog('STREAM', `Response status: ${r.status} (${Date.now() - startMs}ms)`)

  if (!r.ok) {
    const errBody = await r.text()
    debugLog('STREAM', `ERROR body: ${errBody.slice(0, 1000)}`)
    throw new Error(`HTTP ${r.status}: ${errBody.slice(0, 500)}`)
  }

  if (!r.body) {
    debugLog('STREAM', 'ERROR: No response body')
    throw new Error('No response body for streaming')
  }

  const reader = (r.body as any).getReader()
  const decoder = new TextDecoder()

  let accContent = ''
  let lastThinkLen = 0
  let lastVisibleLen = 0
  let wasThinkingDone = true
  const toolCallMap = new Map<number, any>()
  let sseBuffer = ''
  let lastEmitMs = 0
  const EMIT_INTERVAL_MS = 150 // max ~7 UI updates per second

  // Idle timeout: abort if no data received for 60s (server stalled)
  const IDLE_TIMEOUT_MS = 60000
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let chunkCount = 0
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      debugLog('STREAM', `IDLE TIMEOUT after ${Date.now() - startMs}ms, ${chunkCount} chunks received, content=${accContent.length}chars`)
      try { reader.cancel() } catch {}
    }, IDLE_TIMEOUT_MS)
  }
  resetIdle()

  while (true) {
    const { done, value } = await reader.read()
    if (done) { if (idleTimer) clearTimeout(idleTimer); break }
    chunkCount++
    resetIdle()

    sseBuffer += decoder.decode(value, { stream: true })
    const lines = sseBuffer.split('\n')
    sseBuffer = lines.pop()!

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (!trimmed.startsWith('data: ')) continue

      let chunk: any
      try {
        chunk = JSON.parse(trimmed.slice(6))
      } catch { continue }

      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue

      // Accumulate content tokens
      if (delta.content) {
        accContent += delta.content

        const { thinking, visible, thinkingDone } = parseAccumulatedThinking(accContent)

        // Emit thinking-done transition
        if (thinkingDone && !wasThinkingDone) {
          emit(win, { type: 'status', content: '' })
        }
        wasThinkingDone = thinkingDone

        // Emit thinking delta
        if (thinking.length > lastThinkLen) {
          emit(win, { type: 'thinking', content: thinking.slice(lastThinkLen) })
          lastThinkLen = thinking.length
        }

        // Emit visible response (time-based throttle — max ~7 updates/sec)
        if (visible.length > lastVisibleLen) {
          const now = Date.now()
          if (now - lastEmitMs >= EMIT_INTERVAL_MS || thinkingDone) {
            lastEmitMs = now
            const fullNow = fullResponseSoFar
              ? fullResponseSoFar + '\n\n' + visible
              : visible
            emit(win, { type: 'response', content: fullNow, done: false })
          }
          lastVisibleLen = visible.length
        }
      }

      // Accumulate tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, {
              id: tc.id ?? '',
              type: tc.type ?? 'function',
              function: {
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              },
            })
          } else {
            const existing = toolCallMap.get(idx)!
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.function.name += tc.function.name
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          }
        }
      }
    }
  }

  // Final visible emission to ensure nothing is lost
  const { visible: finalVisible } = parseAccumulatedThinking(accContent)
  if (finalVisible.length > 0) {
    const fullNow = fullResponseSoFar
      ? fullResponseSoFar + '\n\n' + finalVisible
      : finalVisible
    emit(win, { type: 'response', content: fullNow, done: false })
  }

  const rawToolCalls = toolCallMap.size > 0 ? [...toolCallMap.values()] : undefined
  const toolCalls = validateAndFixToolCalls(rawToolCalls)

  const elapsedMs = Date.now() - startMs
  const tcNames = toolCalls?.map((tc: any) => tc.function?.name).join(', ') ?? 'none'
  debugLog('STREAM', `Completed: ${elapsedMs}ms, content=${accContent.length}chars, toolCalls=${tcNames}, rawTC=${rawToolCalls?.length ?? 0}, validTC=${toolCalls?.length ?? 0}`)

  return { content: accContent, toolCalls }
}

// ---------------------------------------------------------------------------
// Token estimation — heuristic with calibration from /tokenize
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  if (!text) return 0
  // Use calibrated ratio (updated by calibrateTokenRatio if server available)
  const base = Math.ceil(text.length / calibratedRatio)
  // Extra overhead for structured content (JSON, code) which tokenizes denser
  const jsonBrackets = (text.match(/[{}\[\]":,]/g) || []).length
  const structureBonus = Math.ceil(jsonBrackets * 0.1)
  return base + structureBonus + 4
}

function estimateContextTokens(msgs: Message[]): number {
  let total = 4
  for (const m of msgs) {
    total += 4
    total += estimateTokens(m.content ?? '')
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls))
  }
  return total
}

async function countContextTokensAccurate(msgs: Message[]): Promise<number> {
  const fullText = msgs.map((m) => {
    let s = `<|${m.role}|>\n${m.content ?? ''}`
    if (m.tool_calls) s += '\n' + JSON.stringify(m.tool_calls)
    return s
  }).join('\n')
  const serverCount = await countTokensViaServer(fullText)
  if (serverCount !== null) {
    const overhead = msgs.length * 4 + 4
    const total = serverCount + overhead
    const heuristic = estimateContextTokens(msgs)
    debugLog('TOKENS', `Accurate: ${total} (server=${serverCount}+overhead=${overhead}), heuristic=${heuristic}, diff=${((total-heuristic)/heuristic*100).toFixed(0)}%`)
    return total
  }
  return estimateContextTokens(msgs)
}

function toolsOverheadTokens(): number {
  return estimateTokens(JSON.stringify(getAllTools()))
}

// ---------------------------------------------------------------------------
// Context budget — allocates tokens across zones
// ---------------------------------------------------------------------------

function ctxTokens(): number {
  const ctx = getCtxSize()
  return ctx > 0 ? ctx : FALLBACK_CTX_TOKENS
}

function getUsableBudget(): number {
  return ctxTokens() - toolsOverheadTokens()
}

function getMaxResponseTokens(): number {
  const budget = getUsableBudget()
  // Scale minimum with context: small contexts get smaller min to leave room for messages
  const minTokens = Math.max(1024, Math.min(4096, Math.floor(budget * 0.25)))
  return Math.min(16384, Math.max(minTokens, Math.floor(budget * 0.30)))
}

function getMessageBudget(): number {
  return getUsableBudget() - getMaxResponseTokens()
}

function dynamicToolResultLimit(): number {
  const budget = getMessageBudget()
  const charBudget = Math.floor(budget * calibratedRatio)
  return Math.min(Math.max(1500, Math.floor(charBudget * 0.15)), 40000)
}

function smartTruncateToolResult(toolName: string, result: string, maxChars: number): string {
  if (result.length <= maxChars) return result

  // For file reads — keep head/tail structure (usually you want both top and bottom)
  if (toolName === 'read_file') {
    return compressToolResultText(result, maxChars)
  }

  // For directory listings — keep first N lines (shallow hierarchy most useful)
  if (toolName === 'list_directory') {
    const lines = result.split('\n')
    let acc = ''
    for (const line of lines) {
      if ((acc.length + line.length + 1) > maxChars - 50) {
        return acc + `\n… [${lines.length} total entries, truncated]`
      }
      acc += (acc ? '\n' : '') + line
    }
    return acc
  }

  // For command output — keep last N lines (errors usually at the end)
  if (toolName === 'execute_command') {
    const lines = result.split('\n')
    const headBudget = Math.floor(maxChars * 0.3)
    const tailBudget = Math.floor(maxChars * 0.5)
    const headLines: string[] = []
    let headLen = 0
    for (const line of lines) {
      if (headLen + line.length + 1 > headBudget) break
      headLines.push(line)
      headLen += line.length + 1
    }
    const tailLines: string[] = []
    let tailLen = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      if (tailLen + lines[i].length + 1 > tailBudget) break
      tailLines.unshift(lines[i])
      tailLen += lines[i].length + 1
    }
    return headLines.join('\n') +
      `\n\n… [${lines.length} lines, middle omitted] …\n\n` +
      tailLines.join('\n')
  }

  // For search results — keep head (most relevant matches first)
  if (toolName === 'find_files') {
    const lines = result.split('\n')
    let acc = ''
    for (const line of lines) {
      if ((acc.length + line.length + 1) > maxChars - 50) {
        return acc + `\n… [more results truncated]`
      }
      acc += (acc ? '\n' : '') + line
    }
    return acc
  }

  return compressToolResultText(result, maxChars)
}

// ---------------------------------------------------------------------------
// Message sanitization — fix/remove broken tool_calls that poison history
// ---------------------------------------------------------------------------

function isValidToolCallArgs(argsStr: string): boolean {
  try {
    JSON.parse(argsStr)
    return true
  } catch {
    return false
  }
}

function sanitizeMessages(msgs: Message[]): Message[] {
  let result: Message[] = []
  const brokenCallIds = new Set<string>()

  // Pass 1: Fix/remove broken tool_calls
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const validCalls: any[] = []
      for (const tc of m.tool_calls) {
        const argsStr = typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {})
        if (isValidToolCallArgs(argsStr)) {
          validCalls.push(tc)
        } else {
          brokenCallIds.add(tc.id)
        }
      }

      if (validCalls.length > 0) {
        result.push({ ...m, tool_calls: validCalls })
      } else if (m.content) {
        result.push({ role: 'assistant', content: m.content })
      }
      continue
    }

    if (m.role === 'tool' && m.tool_call_id && brokenCallIds.has(m.tool_call_id)) {
      continue
    }

    result.push(m)
  }

  // Pass 2: Remove orphaned tool results (tool_call_id not in any preceding assistant)
  const validCallIds = new Set<string>()
  const cleaned: Message[] = []
  for (const m of result) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) validCallIds.add(tc.id)
      }
    }
    if (m.role === 'tool' && m.tool_call_id && !validCallIds.has(m.tool_call_id)) {
      continue
    }
    cleaned.push(m)
  }
  result = cleaned

  // Pass 3: Merge consecutive assistant messages (llama.cpp rejects 2+ in a row)
  const merged: Message[] = []
  for (const m of result) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null
    if (m.role === 'assistant' && prev?.role === 'assistant' && !prev.tool_calls && !m.tool_calls) {
      const combinedContent = [prev.content, m.content].filter(Boolean).join('\n\n')
      merged[merged.length - 1] = { role: 'assistant', content: combinedContent }
    } else if (m.role === 'assistant' && prev?.role === 'assistant') {
      // Two assistant messages but one has tool_calls — keep the one with tool_calls
      if (m.tool_calls && m.tool_calls.length > 0) {
        if (!prev.tool_calls || prev.tool_calls.length === 0) {
          merged[merged.length - 1] = m
        }
        // else both have tool_calls — skip the second one (shouldn't happen but safe)
      }
      // else prev has tool_calls, m doesn't — skip m
    } else {
      merged.push(m)
    }
  }

  const removedBroken = msgs.length - result.length
  const removedOrphans = result.length - cleaned.length
  const mergedCount = cleaned.length - merged.length
  if (removedBroken > 0 || removedOrphans > 0 || mergedCount > 0) {
    debugLog('SANITIZE', `Cleaned: ${removedBroken} broken, ${removedOrphans} orphans, ${mergedCount} merged. ${msgs.length} → ${merged.length} msgs`)
  }

  // Pass 4: Fix ending — server rejects 2+ trailing assistant messages
  // Keep at most one trailing assistant if it has tool_calls (expecting tool results next)
  while (merged.length > 1) {
    const last = merged[merged.length - 1]
    const prev = merged[merged.length - 2]
    if (last.role === 'assistant' && prev.role === 'assistant') {
      // Two assistant messages at the end — remove the older one (merge content into last)
      const combinedContent = [prev.content, last.content].filter(Boolean).join('\n\n')
      const keepCalls = last.tool_calls || prev.tool_calls
      merged.splice(merged.length - 2, 2, {
        role: 'assistant',
        content: combinedContent || undefined,
        ...(keepCalls ? { tool_calls: keepCalls } : {}),
      })
    } else {
      break
    }
  }

  return merged
}

function validateAndFixToolCalls(toolCalls: any[] | undefined): any[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return toolCalls
  const valid: any[] = []
  for (const tc of toolCalls) {
    const argsStr = typeof tc.function?.arguments === 'string'
      ? tc.function.arguments
      : JSON.stringify(tc.function?.arguments ?? {})
    if (isValidToolCallArgs(argsStr)) {
      valid.push(tc)
    }
  }
  return valid.length > 0 ? valid : undefined
}

// ---------------------------------------------------------------------------
// Message cleaning — strip thinking, compress tool results
// ---------------------------------------------------------------------------

function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

function compressToolResultText(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = Math.floor(maxChars * 0.25)
  return (
    content.slice(0, headSize) +
    `\n\n… [${Math.round(content.length / 1024)}KB, middle omitted] …\n\n` +
    content.slice(-tailSize)
  )
}

function toolCallOneLiner(msg: Message): string {
  if (!msg.tool_calls || msg.tool_calls.length === 0) return ''
  return msg.tool_calls.map((tc: any) => {
    const name = tc.function?.name ?? '?'
    let args: string
    try {
      const parsed = typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function?.arguments ?? {}
      const keys = Object.keys(parsed)
      args = keys.slice(0, 2).map((k) => {
        const v = String(parsed[k])
        return `${k}=${v.length > 60 ? v.slice(0, 57) + '…' : v}`
      }).join(', ')
    } catch {
      args = '…'
    }
    return `${name}(${args})`
  }).join('; ')
}

// ---------------------------------------------------------------------------
// Working memory — structured state that survives summarization
// ---------------------------------------------------------------------------

interface WorkingMemory {
  currentTask: string
  filesModified: string[]
  keyFacts: string[]
}

function extractWorkingMemory(msgs: Message[]): WorkingMemory {
  const mem: WorkingMemory = { currentTask: '', filesModified: [], keyFacts: [] }
  const modifiedFiles = new Set<string>()

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'user' && !mem.currentTask) {
      const clean = (m.content ?? '').replace(/```[\s\S]*?```/g, '').trim()
      mem.currentTask = clean.length > 300 ? clean.slice(0, 297) + '…' : clean
    }
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name
        if (!name) continue
        try {
          const args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments) : tc.function.arguments
          if ((name === 'write_file' || name === 'edit_file') && args.path) {
            modifiedFiles.add(args.path)
          }
        } catch {}
      }
    }
    if (m.role === 'tool' && m.content) {
      const c = m.content
      if (c.startsWith('Error') || c.includes('Exit code: 1')) {
        const line = c.split('\n')[0] ?? ''
        if (line.length > 10 && mem.keyFacts.length < 5) {
          mem.keyFacts.push(line.slice(0, 150))
        }
      }
    }
  }

  mem.filesModified = [...modifiedFiles].slice(0, 20)
  return mem
}

function formatWorkingMemory(mem: WorkingMemory): string {
  const parts: string[] = []
  if (mem.currentTask) {
    parts.push(`**Current task:** ${mem.currentTask}`)
  }
  if (mem.filesModified.length > 0) {
    parts.push(`**Files modified:** ${mem.filesModified.join(', ')}`)
  }
  if (mem.keyFacts.length > 0) {
    parts.push(`**Key context:**\n${mem.keyFacts.map((f) => `- ${f}`).join('\n')}`)
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Tiered compression pipeline
// ---------------------------------------------------------------------------

// Tier 0: Strip thinking from stored assistant messages (done on insert, not here)

// Tier 1: Compress old tool results — those the model has already acted upon
function tier1CompressOldToolResults(msgs: Message[]): { msgs: Message[]; saved: number } {
  let saved = 0
  const result = [...msgs]

  const recentTurns = keepRecentTurns()
  let recentStart = result.length
  let userCount = 0
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      userCount++
      if (userCount >= recentTurns) { recentStart = i; break }
    }
  }

  for (let i = 0; i < recentStart; i++) {
    const m = result[i]
    if (m.role === 'tool' && m.content && m.content.length > 800) {
      const compressed = compressToolResultText(m.content, 400)
      saved += m.content.length - compressed.length
      result[i] = { ...m, content: compressed }
    }
  }

  return { msgs: result, saved }
}

// Tier 2: Collapse entire old tool-call chains to one-liners
function tier2CollapseOldChains(msgs: Message[]): { msgs: Message[]; saved: number } {
  let saved = 0
  const result: Message[] = []

  const recentTurns = keepRecentTurns()
  let recentStart = msgs.length
  let userCount = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      userCount++
      if (userCount >= recentTurns) { recentStart = i; break }
    }
  }

  let i = 0
  while (i < msgs.length) {
    if (i >= recentStart) {
      result.push(msgs[i])
      i++
      continue
    }

    const m = msgs[i]

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const chainSummary = toolCallOneLiner(m)
      const toolCount = m.tool_calls.length
      let toolResults: string[] = []
      let j = i + 1
      while (j < msgs.length && j < i + 1 + toolCount && msgs[j].role === 'tool') {
        const r = msgs[j].content ?? ''
        const isError = r.startsWith('Error') || r.includes('Exit code: 1')
        if (isError) {
          toolResults.push(r.length > 150 ? r.slice(0, 147) + '…' : r)
        } else {
          toolResults.push(r.length > 80 ? r.slice(0, 77) + '…' : r)
        }
        saved += (msgs[j].content ?? '').length
        j++
      }

      const oldText = (m.content ? stripThinking(m.content) : '')
      saved += (m.content ?? '').length

      const collapsed = [
        oldText ? oldText + '\n' : '',
        `[Executed: ${chainSummary}]`,
        toolResults.length > 0 ? toolResults.map((r) => `→ ${r}`).join('\n') : '',
      ].filter(Boolean).join('\n')

      saved -= collapsed.length
      result.push({ role: 'assistant', content: collapsed })
      i = j
      continue
    }

    result.push(m)
    i++
  }

  return { msgs: result, saved }
}

// Tier 3: LLM-based summarization of old conversation
async function tier3Summarize(
  msgs: Message[],
  apiUrl: string,
  win: BrowserWindow,
  signal?: AbortSignal,
): Promise<Message[]> {
  const systemMsg = msgs.find((m) => m.role === 'system')

  const recentTurns = keepRecentTurns()
  let recentStart = msgs.length
  let userCount = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      userCount++
      if (userCount >= recentTurns) { recentStart = i; break }
    }
  }
  while (recentStart > 0 && msgs[recentStart]?.role !== 'user') recentStart++

  const oldMessages = msgs.slice(systemMsg ? 1 : 0, recentStart)
  const recentMessages = msgs.slice(recentStart)

  if (oldMessages.length < 3) return msgs

  emit(win, { type: 'status', content: '🗜️ Суммаризация старой истории…' })

  const workingMem = extractWorkingMemory(msgs)

  // Format old messages compactly for summarization
  const parts: string[] = []
  for (const m of oldMessages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      parts.push(`**User:** ${(m.content ?? '').slice(0, 500)}`)
    } else if (m.role === 'assistant') {
      const text = stripThinking(m.content ?? '').slice(0, 400)
      parts.push(`**Assistant:** ${text}`)
    } else if (m.role === 'tool') {
      parts.push(`**Tool:** ${(m.content ?? '').slice(0, 200)}`)
    }
  }
  const conversationText = parts.join('\n\n')

  const maxSummaryInputTokens = Math.floor(getMessageBudget() * 0.4)
  const maxSummaryInputChars = maxSummaryInputTokens * 3
  const truncatedText = conversationText.length > maxSummaryInputChars
    ? conversationText.slice(0, Math.floor(maxSummaryInputChars * 0.7)) +
      '\n\n…[middle omitted]…\n\n' +
      conversationText.slice(-Math.floor(maxSummaryInputChars * 0.2))
    : conversationText

  try {
    const summaryAbort = new AbortController()
    const summaryTimeout = setTimeout(() => {
      try { summaryAbort.abort() } catch {}
    }, SUMMARIZE_TIMEOUT_MS)
    const combinedSignal = signal
      ? AbortSignal.any([signal, summaryAbort.signal])
      : summaryAbort.signal

    const summaryMaxTokens = Math.min(1024, Math.floor(getMessageBudget() * 0.3))
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen',
        messages: [{ role: 'user', content: getSummarizePrompt() + truncatedText }],
        temperature: 0.1,
        max_tokens: Math.max(256, summaryMaxTokens),
      }),
      signal: combinedSignal,
    })
    clearTimeout(summaryTimeout)
    if (!r.ok) return msgs
    const json = await r.json() as any
    const summary = json.choices?.[0]?.message?.content
    if (!summary || summary.length < 50) return msgs

    const memBlock = formatWorkingMemory(workingMem)
    const baseSystem = systemMsg?.content ?? getSystemPrompt()

    const marker = '\n\n## Working memory\n'
    const markerIdx = baseSystem.indexOf(marker)
    const cleanBase = markerIdx >= 0 ? baseSystem.slice(0, markerIdx) : baseSystem

    const summaryMarker = '\n\n## Summary of earlier conversation\n'
    const summaryIdx = cleanBase.indexOf(summaryMarker)
    const pureBase = summaryIdx >= 0 ? cleanBase.slice(0, summaryIdx) : cleanBase

    // Budget for system prompt: leave enough room for recent messages
    const budget = getMessageBudget()
    const recentTokens = estimateContextTokens(recentMessages)
    const sysTokenBudget = Math.max(500, budget - recentTokens - 100)
    const sysCharBudget = Math.floor(sysTokenBudget * calibratedRatio)

    // Build system content, truncating summary/memory if needed
    let summaryText = summary
    let memText = memBlock
    const baseLen = pureBase.length + marker.length + summaryMarker.length + 20
    const availForSummary = sysCharBudget - baseLen
    if (availForSummary < 200) {
      summaryText = ''
      memText = ''
    } else {
      const memLen = memText.length
      const summaryBudget = availForSummary - Math.min(memLen, Math.floor(availForSummary * 0.3))
      if (summaryText.length > summaryBudget) {
        summaryText = summaryText.slice(0, summaryBudget - 10) + '\n…[truncated]'
      }
      if (memText.length > Math.floor(availForSummary * 0.3)) {
        memText = memText.slice(0, Math.floor(availForSummary * 0.3) - 10) + '\n…'
      }
    }

    const newSystem = pureBase +
      (memText ? marker + memText + '\n' : '') +
      (summaryText ? summaryMarker + summaryText + '\n' : '')

    // Also truncate recent tool results if still too big
    const compactRecent = recentMessages.map((m) => {
      if (m.role === 'tool' && m.content && m.content.length > 600) {
        return { ...m, content: compressToolResultText(m.content, 400) }
      }
      return m
    })

    const compacted: Message[] = [
      { role: 'system', content: newSystem },
      ...compactRecent,
    ]

    const newTokens = estimateContextTokens(compacted)
    const pctUsed = Math.round((newTokens / budget) * 100)
    emit(win, {
      type: 'status',
      content: `✅ Контекст сжат: ${oldMessages.length} сообщений → саммари. ~${pctUsed}% бюджета`,
    })

    return compacted
  } catch {
    return msgs
  }
}

// Tier 4: Emergency hard prune — absolute last resort
function tier4EmergencyPrune(msgs: Message[]): Message[] {
  const budget = getMessageBudget()

  const result = [...msgs]

  // Step 1: Aggressively truncate all tool results
  for (let i = 0; i < result.length; i++) {
    const m = result[i]
    if (m.role === 'tool' && m.content && m.content.length > 200) {
      result[i] = { ...m, content: m.content.slice(0, 150) + '\n…[pruned]' }
    }
  }

  // Step 2: Strip summary and working memory from system prompt
  const sysIdx = result.findIndex((m) => m.role === 'system')
  if (sysIdx >= 0 && result[sysIdx].content) {
    let sysTxt = result[sysIdx].content!
    const summaryMark = sysTxt.indexOf('\n\n## Summary of earlier')
    if (summaryMark >= 0) sysTxt = sysTxt.slice(0, summaryMark)
    const memMark = sysTxt.indexOf('\n\n## Working memory')
    if (memMark >= 0) sysTxt = sysTxt.slice(0, memMark)
    result[sysIdx] = { ...result[sysIdx], content: sysTxt }
  }

  let tokens = estimateContextTokens(result)
  if (tokens <= budget) return result

  // Step 3: Drop messages from the front (keep system + last N)
  const system = result.find((m) => m.role === 'system')
  const rest = result.filter((m) => m.role !== 'system')

  let keep = rest.length
  while (keep > 2) {
    keep--
    const candidate = system ? [system, ...rest.slice(rest.length - keep)] : rest.slice(rest.length - keep)
    if (estimateContextTokens(candidate) <= budget) return candidate
  }

  // Step 4: Hard truncate system prompt to fit
  const lastMsgs = rest.slice(-2)
  const restTokens = estimateContextTokens(lastMsgs)
  const sysTokenBudget = Math.max(100, budget - restTokens - 50)
  const sysCharBudget = Math.floor(sysTokenBudget * calibratedRatio)

  if (system && system.content) {
    const sysTruncated = system.content.slice(0, sysCharBudget) + '\n…[truncated]'
    return [{ ...system, content: sysTruncated }, ...lastMsgs]
  }

  return system ? [system, ...lastMsgs] : lastMsgs
}

// ---------------------------------------------------------------------------
// Main context management — graduated compression pipeline
// ---------------------------------------------------------------------------

async function manageContext(
  msgs: Message[],
  apiUrl: string,
  win: BrowserWindow,
  signal?: AbortSignal,
): Promise<Message[]> {
  const budget = getMessageBudget()
  let tokens = estimateContextTokens(msgs)

  debugLog('CTX', `manageContext: ${msgs.length} msgs, ${tokens} tokens, budget=${budget}, ctx=${ctxTokens()}, ratio=${(tokens/budget*100).toFixed(0)}%`)

  // Under threshold — no compression needed
  if (tokens <= budget * COMPRESS_TOOL_RESULTS_AT) return msgs

  let current = msgs

  // Tier 1: Compress old tool results
  if (tokens > budget * COMPRESS_TOOL_RESULTS_AT) {
    const { msgs: compressed } = tier1CompressOldToolResults(current)
    current = compressed
    tokens = estimateContextTokens(current)
    if (tokens <= budget * SUMMARIZE_AT) return current
  }

  // Tier 2: Collapse old tool-call chains
  if (tokens > budget * SUMMARIZE_AT) {
    const nonSystem = current.filter((m) => m.role !== 'system')
    if (nonSystem.length >= 6) {
      const { msgs: collapsed } = tier2CollapseOldChains(current)
      current = collapsed
      tokens = estimateContextTokens(current)
      if (tokens <= budget * AGGRESSIVE_PRUNE_AT) return current
    }
  }

  // Tier 3: LLM summarization
  if (tokens > budget * SUMMARIZE_AT) {
    const nonSystem = current.filter((m) => m.role !== 'system')
    if (nonSystem.length >= 4) {
      current = await tier3Summarize(current, apiUrl, win, signal)
      tokens = estimateContextTokens(current)
      if (tokens <= budget * EMERGENCY_AT) return current
    }
  }

  // Tier 4: Emergency prune
  if (tokens > budget * EMERGENCY_AT) {
    emit(win, { type: 'status', content: '⚠️ Экстренная обрезка контекста' })
    current = tier4EmergencyPrune(current)
  }

  return current
}

function getProjectContext(ws: string): string {
  try {
    const ctx_size = ctxTokens()
    // On small contexts, project info is luxury — keep minimal
    const budgetFraction = ctx_size < 16384 ? 0.15 : ctx_size < 32768 ? 0.25 : 0.4
    const budgetForCtx = Math.max(Math.floor(getMessageBudget() * budgetFraction), 300)

    const depth = budgetForCtx > 2000 ? 2 : 1
    const tree = executeTool('list_directory', { depth }, ws)
    let ctx = `## Project: ${ws}\n\`\`\`\n${tree}\n\`\`\`\n`

    const fs = require('fs')
    const path = require('path')
    const indicators: [string, string][] = [
      ['package.json', 'Node.js'],
      ['Cargo.toml', 'Rust'],
      ['go.mod', 'Go'],
      ['pyproject.toml', 'Python'],
      ['requirements.txt', 'Python'],
      ['pom.xml', 'Java/Maven'],
      ['CMakeLists.txt', 'C/C++ CMake'],
      ['Dockerfile', 'Docker'],
    ]
    const detected: string[] = []
    for (const [file, desc] of indicators) {
      if (fs.existsSync(path.join(ws, file))) detected.push(desc)
    }
    if (detected.length > 0) {
      ctx += `Type: ${detected.join(', ')}\n`
    }

    if (ctx.length > budgetForCtx) {
      ctx = ctx.slice(0, budgetForCtx - 20) + '\n…[truncated]\n'
    }
    return ctx
  } catch {
    return ''
  }
}

export function setWorkspace(ws: string) {
  workspace = ws
  for (const session of sessions.values()) {
    session.projectContextAdded = false
  }
}

export function resetAgent() {
  const session = getActiveSession()
  session.messages = []
  session.projectContextAdded = false
  session.updatedAt = Date.now()
  saveSession(session)
}

export function cancelAgent() {
  cancelRequested = true
  if (currentAbort) {
    try {
      currentAbort.abort()
    } catch {
      // ignore
    }
  }
}

export async function runAgent(userMessage: string, ws: string, win: BrowserWindow): Promise<string> {
  workspace = ws
  cancelRequested = false

  const session = getActiveSession()
  let { messages } = session

  // Auto-title from first user message
  if (session.title === 'Новый чат' && messages.filter((m) => m.role === 'user').length === 0) {
    session.title = titleFromMessage(userMessage)
  }

  // On first message in this session, prepend project context
  if (!session.projectContextAdded && ws) {
    const ctx = getProjectContext(ws)
    if (ctx) {
      messages = [
        { role: 'system', content: getSystemPrompt() + '\n\n' + ctx },
        ...messages.filter((m) => m.role !== 'system'),
      ]
    } else {
      if (!messages.some((m) => m.role === 'system')) {
        messages.unshift({ role: 'system', content: getSystemPrompt() })
      }
    }
    session.projectContextAdded = true
  } else if (!messages.some((m) => m.role === 'system')) {
    messages.unshift({ role: 'system', content: getSystemPrompt() })
  }

  messages.push({ role: 'user', content: userMessage })
  session.messages = messages

  const apiUrl = `${llamaApiUrl()}/v1/chat/completions`

  // Calibrate token ratio from server (non-blocking, happens once)
  calibrateTokenRatio().catch(() => {})

  // Summarize/prune context if approaching limit
  messages = await manageContext(messages, apiUrl, win)
  session.messages = messages
  emitContextUsage(win, messages)
  let fullResponse = ''
  let emptyRetries = 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (cancelRequested) {
      emit(win, { type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
      session.updatedAt = Date.now()
      saveSession(session)
      return 'Canceled'
    }

    // Pre-flight: sanitize structure + ensure messages fit in context budget
    messages = sanitizeMessages(messages)
    let preflightTokens: number
    const accurateCount = await countContextTokensAccurate(messages)
    preflightTokens = accurateCount
    const preflightBudget = getMessageBudget()
    debugLog('PREFLIGHT', `iter=${i}, msgs=${messages.length}, tokens=${preflightTokens}, budget=${preflightBudget}, ratio=${(preflightTokens/preflightBudget*100).toFixed(0)}%, maxResp=${getMaxResponseTokens()}`)
    if (preflightTokens > preflightBudget * EMERGENCY_AT) {
      emit(win, { type: 'status', content: '🗜️ Обрезка контекста перед запросом…' })
      messages = tier4EmergencyPrune(messages)
      messages = sanitizeMessages(messages)
      session.messages = messages
      preflightTokens = estimateContextTokens(messages)
    }

    // Final safety: if still over budget after all pruning, adjust max_tokens down
    const overBudgetRatio = preflightTokens / preflightBudget
    const effectiveMaxTokens = overBudgetRatio > 1.0
      ? Math.max(256, Math.floor(getMaxResponseTokens() * (1.0 / overBudgetRatio)))
      : 0 // 0 means use default

    let streamResult: StreamResult
    try {
      const controller = new AbortController()
      currentAbort = controller
      // No fixed total timeout — idle timeout inside streamLlmResponse handles stalls
      // Only abort on user cancel or server idle (120s no data)

      streamResult = await streamLlmResponse(apiUrl, messages, win, fullResponse, controller.signal, effectiveMaxTokens)
    } catch (e: any) {
      debugLog('ERROR', `Catch in runAgent: name=${e?.name}, message=${e?.message}, cancelRequested=${cancelRequested}, stack=${(e?.stack ?? '').slice(0, 500)}`)
      if (cancelRequested) {
        emit(win, { type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
        session.updatedAt = Date.now()
        saveSession(session)
        return 'Canceled'
      }

      const errMsg = e.message ?? String(e)
      const isAbort = e?.name === 'AbortError' || errMsg.includes('aborted')
      const isContextError = errMsg.includes('500') || errMsg.includes('400') || errMsg.includes('context')

      if (isAbort && !isContextError) {
        // Idle timeout or network abort — not user-initiated
        emit(win, { type: 'error', content: 'Соединение с моделью прервано (сервер не отвечал 2 минуты). Попробуйте ещё раз.' })
        session.updatedAt = Date.now()
        saveSession(session)
        return 'Error: connection lost'
      }

      if (isContextError) {
        emit(win, { type: 'status', content: '🔧 Ошибка контекста — очищаю и повторяю…' })
        messages = sanitizeMessages(messages)
        messages = tier4EmergencyPrune(messages)
        session.messages = messages
        saveSession(session)
        try {
          const retryController = new AbortController()
          currentAbort = retryController
          streamResult = await streamLlmResponse(apiUrl, messages, win, fullResponse, retryController.signal)
        } catch (retryErr: any) {
          emit(win, { type: 'error', content: `LLM request failed after recovery: ${retryErr.message}` })
          session.updatedAt = Date.now()
          saveSession(session)
          return `Error: ${retryErr.message}`
        }
      } else {
        emit(win, { type: 'error', content: `LLM request failed: ${errMsg}` })
        session.updatedAt = Date.now()
        saveSession(session)
        return `Error: ${errMsg}`
      }
    }

    const content = streamResult.content
    const toolCalls = streamResult.toolCalls

    if (!content && !toolCalls) {
      debugLog('EMPTY', `Empty response, retry ${emptyRetries + 1}/${MAX_EMPTY_RETRIES}, msgs=${messages.length}, tokens=${estimateContextTokens(messages)}`)
      emptyRetries++
      if (emptyRetries <= MAX_EMPTY_RETRIES) {
        emit(win, { type: 'status', content: `⚠️ Пустой ответ от модели — обрезаю контекст и повторяю (${emptyRetries}/${MAX_EMPTY_RETRIES})…` })
        messages = tier4EmergencyPrune(messages)
        session.messages = messages
        saveSession(session)
        continue
      }
      emit(win, { type: 'error', content: 'Модель не может ответить — контекст слишком большой или повреждён. Попробуйте начать новый чат.' })
      session.updatedAt = Date.now()
      saveSession(session)
      return 'Empty response after retries'
    }
    emptyRetries = 0

    const [, visible] = extractThinking(content)

    // No tool calls → final response
    if (!toolCalls || toolCalls.length === 0) {
      const finalText = visible || content
      fullResponse += (fullResponse ? '\n\n' : '') + finalText
      emit(win, { type: 'response', content: fullResponse, done: true })
      // Store without <think> blocks to save context
      messages.push({ role: 'assistant', content: stripThinking(content) })
      session.messages = messages
      session.updatedAt = Date.now()
      saveSession(session)
      return fullResponse
    }

    // Has tool calls — accumulate partial text
    if (visible) {
      fullResponse += (fullResponse ? '\n\n' : '') + visible
    }

    // Store without <think> blocks; only valid tool_calls
    const validToolCalls = validateAndFixToolCalls(toolCalls)
    if (validToolCalls && validToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: stripThinking(content) || undefined,
        tool_calls: validToolCalls,
      })
    } else {
      // All tool calls were broken (truncated mid-JSON) — treat as text response
      const brokenText = visible || stripThinking(content)
      if (brokenText) {
        fullResponse += (fullResponse ? '\n\n' : '') + brokenText
      }
      const notice = 'Модель попыталась выполнить действие, но ответ был обрезан. Попробую ещё раз.'
      emit(win, { type: 'status', content: `⚠️ ${notice}` })
      messages.push({ role: 'assistant', content: brokenText || notice })
      messages.push({ role: 'user', content: 'Your previous tool call was truncated and could not be parsed. Please try again, but break large file writes into smaller parts or use a shorter approach.' })
      session.messages = messages
      saveSession(session)
      continue
    }

    // Execute tool calls
    for (const tc of validToolCalls) {
      const fn = tc.function
      const toolName = fn.name
      let toolArgs: Record<string, any>
      try {
        toolArgs = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
      } catch {
        toolArgs = {}
      }

      emit(win, { type: 'tool_call', name: toolName, args: toolArgs })

      // Request user approval for destructive operations or custom tools
      let result: string
      const customTools = config.get('customTools')
      const isCustom = customTools.some((ct) => ct.name === toolName)

      if (isCustom || NEEDS_APPROVAL.has(toolName)) {
        const approved = await requestApproval(win, toolName, toolArgs)
        if (approved) {
          if (isCustom) {
            const ct = customTools.find((t) => t.name === toolName)!
            result = executeCustomTool(ct, toolArgs, workspace)
          } else {
            result = executeTool(toolName, toolArgs, workspace)
          }
        } else {
          result = `[Denied by user] Operation "${toolName}" was not approved.`
        }
      } else {
        result = executeTool(toolName, toolArgs, workspace)
      }

      // Truncate for UI
      const uiResult = result.length > 5000
        ? result.slice(0, 5000) + `\n… [${Math.round(result.length / 1024)}KB total]`
        : result
      emit(win, { type: 'tool_result', name: toolName, result: uiResult })

      // Notify renderer to refresh file tree when agent modifies filesystem
      const fsModTools = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory'])
      if (fsModTools.has(toolName) && !result.startsWith('Error') && !result.startsWith('[Denied')) {
        try {
          win.webContents.send('workspace-files-changed')
        } catch {}
      }

      // Truncate for LLM context — dynamic limit based on context window
      const maxToolChars = dynamicToolResultLimit()
      const llmResult = smartTruncateToolResult(toolName, result, maxToolChars)

      messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: llmResult })
    }

    // Summarize/prune after each iteration to stay within budget
    messages = await manageContext(messages, apiUrl, win)
    session.messages = messages
    emitContextUsage(win, messages)
  }

  const msg = 'Reached maximum iterations. Stopping.'
  fullResponse += (fullResponse ? '\n\n' : '') + msg
  emit(win, { type: 'response', content: fullResponse, done: true })
  session.updatedAt = Date.now()
  saveSession(session)
  return fullResponse
}
