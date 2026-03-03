import { BrowserWindow, ipcMain } from 'electron'
import { llamaApiUrl, getCtxSize, setCtxSize, queryActualCtxSize } from './server-manager'
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

const NEEDS_APPROVAL = new Set(['execute_command', 'write_file', 'edit_file', 'delete_file', 'append_file'])

const MAX_ITERATIONS = 30
const FALLBACK_CTX_TOKENS = 32768
const SUMMARIZE_TIMEOUT_MS = 60000
const MAX_EMPTY_RETRIES = 3

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

## File writing limits

- **write_file**: Keep content under 80 lines per call. For larger files:
  1. Write the skeleton first (imports, structure, empty function bodies)
  2. Then use edit_file to fill in each section incrementally
  3. Or use append_file to add content to the end of an existing file
- NEVER put an entire large application (HTML+CSS+JS) into a single write_file call
- Break large applications into multiple files/modules when possible
- If a file needs 200+ lines, always split across multiple tool calls

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

export const DEFAULT_SUMMARIZE_PROMPT = `You are compacting an AI coding agent's conversation history. Create a STRUCTURED summary the agent can use to continue working seamlessly.

CRITICAL — preserve these sections:
1. **CURRENT STEP**: What was the agent doing right now? What was the last action and its result?
2. **PLAN**: What steps remain? What is the overall approach? List numbered steps.
3. **FILES**: ALL file paths mentioned — created, modified, read, deleted. Use full paths.
4. **WHAT WORKED**: Successful operations and their key results (1 line each).
5. **WHAT FAILED**: Errors encountered, approaches that did NOT work, and why. Include error messages verbatim.
6. **DECISIONS**: Key technical decisions and alternatives considered.
7. **NEXT ACTION**: What should the agent do immediately next?

Rules:
- Be extremely concise but preserve ALL file paths and error messages verbatim.
- Use bullet points, not prose.
- The agent will use this summary to continue — omitting details means lost work.

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
- Use tools efficiently — prefer read_file over execute_command cat
- write_file: max 80 lines per call. For larger files: write skeleton first, then edit_file to fill sections
- Use append_file to add content to existing files incrementally`

function getOsInfo(): string {
  const platform = process.platform
  const isWin = platform === 'win32'
  const isMac = platform === 'darwin'
  const osName = isWin ? 'Windows' : isMac ? 'macOS' : 'Linux'
  const shell = isWin ? 'PowerShell/cmd' : (process.env.SHELL?.split('/').pop() ?? 'bash')
  return `\n\n## Environment\n- **OS**: ${osName} (${process.arch})\n- **Shell**: ${shell}\n` +
    (isWin
      ? '- Use Windows-compatible commands: `dir` instead of `ls`, `type` instead of `cat`, `del` instead of `rm`, `mkdir` (works on both), `move` instead of `mv`, `copy` instead of `cp`\n- Use `\\\\` or `/` for path separators in commands\n- PowerShell commands like `Get-ChildItem`, `Get-Content` also work\n'
      : '- Standard Unix commands available: `ls`, `cat`, `rm`, `mv`, `cp`, `grep`, `find`, etc.\n')
}

function getSystemPrompt(): string {
  const custom = config.get('systemPrompt')
  const base = custom || (ctxTokens() < 16384 ? COMPACT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT)
  return base + getOsInfo()
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
// Recover tool calls that the model wrote as text instead of using the API
// Qwen sometimes generates <tool_call>...</tool_call> or ```tool_call\n...\n``` in content/thinking
// ---------------------------------------------------------------------------

function extractTextToolCalls(content: string): { name: string; args: Record<string, any> }[] {
  const results: { name: string; args: Record<string, any> }[] = []

  // Pattern 1: <tool_call> <function=NAME> <parameter=KEY>VALUE</parameter> ... </function> </tool_call>
  const xmlPattern = /<tool_call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g
  let match
  while ((match = xmlPattern.exec(content)) !== null) {
    const name = match[1]
    const body = match[2]
    const args: Record<string, any> = {}
    const paramRe = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g
    let pm
    while ((pm = paramRe.exec(body)) !== null) {
      const val = pm[2].trim()
      // Try parsing as number
      args[pm[1]] = /^\d+$/.test(val) ? parseInt(val) : val
    }
    if (name) results.push({ name, args })
  }

  // Pattern 2: {"name": "tool_name", "arguments": {...}} or tool_call JSON
  const jsonPattern = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g
  while ((match = jsonPattern.exec(content)) !== null) {
    try {
      const name = match[1]
      const args = JSON.parse(match[2])
      if (name && typeof args === 'object') results.push({ name, args })
    } catch {}
  }

  return results
}

// ---------------------------------------------------------------------------
// Progressive file content streaming — extract partial content from tool call
// arguments as they're being generated, so the UI can show file writes in real-time
// ---------------------------------------------------------------------------

const FILE_CONTENT_TOOLS = new Set(['write_file', 'edit_file', 'append_file'])
const TOOL_STREAM_INTERVAL_MS = 200

function extractPartialFileContent(partialArgs: string, toolName: string): { path: string; content: string } | null {
  // Tool args are partial JSON like: {"path": "foo.js", "content": "line1\nline2...
  // We need to extract the path and the content field from incomplete JSON
  const contentKey = toolName === 'edit_file' ? 'new_string' : 'content'

  // Extract path
  const pathMatch = partialArgs.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const filePath = pathMatch?.[1] ?? ''

  // Find the content/new_string field start
  const keyPattern = new RegExp(`"${contentKey}"\\s*:\\s*"`)
  const keyMatch = keyPattern.exec(partialArgs)
  if (!keyMatch) return null

  const contentStart = keyMatch.index + keyMatch[0].length
  let raw = partialArgs.slice(contentStart)

  // Remove trailing quote if the JSON is complete
  if (raw.endsWith('"}') || raw.endsWith('", ') || raw.endsWith('",')) {
    raw = raw.replace(/"\s*[,}]\s*$/, '')
  } else if (raw.endsWith('"')) {
    raw = raw.slice(0, -1)
  }

  // Unescape JSON string
  try {
    const content = JSON.parse(`"${raw}"`)
    return { path: filePath, content }
  } catch {
    // If JSON parse fails, do basic unescaping
    const content = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    return { path: filePath, content }
  }
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
  rawToolCalls: any[] | undefined
  finishReason: string | null
}

async function streamLlmResponse(
  apiUrl: string,
  msgs: Message[],
  win: BrowserWindow,
  fullResponseSoFar: string,
  signal: AbortSignal,
  maxTokensOverride?: number,
  temperatureOverride?: number,
): Promise<StreamResult> {
  const cleanMsgs = sanitizeMessages(msgs)
  const maxTok = (maxTokensOverride && maxTokensOverride > 0) ? maxTokensOverride : getMaxResponseTokens()
  const temp = temperatureOverride ?? 0.3
  const msgRoles = cleanMsgs.map((m) => m.role + (m.tool_calls ? `(${m.tool_calls.length}tc)` : '')).join(', ')
  debugLog('STREAM', `Sending request: ${cleanMsgs.length} msgs [${msgRoles}], max_tokens=${maxTok}, temp=${temp}, ctx=${ctxTokens()}, budget=${getMessageBudget()}, used=${estimateContextTokens(cleanMsgs)}`)

  const startMs = Date.now()
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen',
      messages: cleanMsgs,
      tools: getAllTools(),
      tool_choice: 'auto',
      temperature: temp,
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
  let lastToolStreamMs = 0
  const EMIT_INTERVAL_MS = 150 // max ~7 UI updates per second
  let finishReason: string | null = null

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

      const choice = chunk.choices?.[0]
      if (choice?.finish_reason) finishReason = choice.finish_reason
      const delta = choice?.delta
      if (!delta) continue

      // Log first few chunks for debugging empty responses
      if (chunkCount <= 3) {
        debugLog('SSE_CHUNK', `#${chunkCount}: content=${JSON.stringify(delta.content)}, tc=${delta.tool_calls ? 'yes' : 'no'}, role=${delta.role ?? '-'}, finish=${choice.finish_reason ?? '-'}`)
      }

      // Capture reasoning_content (Qwen's separate thinking field)
      if (delta.reasoning_content) {
        const rc = delta.reasoning_content
        accContent += accContent.includes('<think>') ? rc : `<think>${rc}`
        const { thinking } = parseAccumulatedThinking(accContent)
        if (thinking.length > lastThinkLen) {
          emit(win, { type: 'thinking', content: thinking.slice(lastThinkLen) })
          lastThinkLen = thinking.length
        }
        wasThinkingDone = false
      }

      // Accumulate content tokens
      if (delta.content) {
        // Close any open reasoning_content thinking block before visible content
        if (!wasThinkingDone && !delta.content.includes('<think>')) {
          accContent += '</think>'
          wasThinkingDone = true
          emit(win, { type: 'status', content: '' })
        }
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

          // Stream file content for write/edit/append tools
          const entry = toolCallMap.get(idx)!
          const toolName = entry.function.name
          if (FILE_CONTENT_TOOLS.has(toolName)) {
            const now = Date.now()
            if (now - lastToolStreamMs >= TOOL_STREAM_INTERVAL_MS) {
              lastToolStreamMs = now
              const partial = extractPartialFileContent(entry.function.arguments, toolName)
              if (partial) {
                emit(win, {
                  type: 'tool_streaming',
                  name: toolName,
                  toolStreamPath: partial.path,
                  toolStreamContent: partial.content,
                })
              }
            }
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

  // Final tool streaming emission (ensure UI gets the complete content)
  for (const entry of toolCallMap.values()) {
    if (FILE_CONTENT_TOOLS.has(entry.function.name)) {
      const partial = extractPartialFileContent(entry.function.arguments, entry.function.name)
      if (partial) {
        emit(win, {
          type: 'tool_streaming',
          name: entry.function.name,
          toolStreamPath: partial.path,
          toolStreamContent: partial.content,
          done: true,
        })
      }
    }
  }

  const rawToolCalls = toolCallMap.size > 0 ? [...toolCallMap.values()] : undefined
  const toolCalls = validateAndFixToolCalls(rawToolCalls)

  const elapsedMs = Date.now() - startMs
  const tcNames = toolCalls?.map((tc: any) => tc.function?.name).join(', ') ?? 'none'
  const contentPreview = accContent.length > 200 ? accContent.slice(0, 200) + '…' : accContent
  debugLog('STREAM', `Completed: ${elapsedMs}ms, ${chunkCount} chunks, content=${accContent.length}chars, rawTC=${rawToolCalls?.length ?? 0}, validTC=${toolCalls?.length ?? 0}, tools=[${tcNames}], finish=${finishReason}`)
  if (accContent.length === 0 && !rawToolCalls) {
    debugLog('STREAM', `WARNING: Completely empty response! ${chunkCount} SSE chunks received but no content or tool calls extracted`)
  }
  if (rawToolCalls && (!toolCalls || toolCalls.length === 0)) {
    const rawName = rawToolCalls[0]?.function?.name ?? '?'
    const rawArgsLen = rawToolCalls[0]?.function?.arguments?.length ?? 0
    debugLog('STREAM', `WARNING: All ${rawToolCalls.length} tool calls invalid! fn=${rawName}, argsLen=${rawArgsLen}, finish=${finishReason}, first300: ${rawToolCalls[0]?.function?.arguments?.slice(0, 300)}`)
  }
  debugLog('STREAM', `Content preview: ${contentPreview || '(empty)'}`)

  return { content: accContent, toolCalls, rawToolCalls, finishReason }
}

// ---------------------------------------------------------------------------
// Token estimation — heuristic with calibration from /tokenize
// ---------------------------------------------------------------------------

// Correction factor for heuristic: calibrated from first accurate count.
// Default 1.5 because chat templates add ~50% overhead (role tokens, <|im_start|>, etc.)
let heuristicCorrectionFactor = 1.5

function estimateTokens(text: string): number {
  if (!text) return 0
  const base = Math.ceil(text.length / calibratedRatio)
  const jsonBrackets = (text.match(/[{}\[\]":,]/g) || []).length
  const structureBonus = Math.ceil(jsonBrackets * 0.1)
  return base + structureBonus + 4
}

function estimateContextTokensRaw(msgs: Message[]): number {
  let total = 4
  for (const m of msgs) {
    total += 4
    total += estimateTokens(m.content ?? '')
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls))
  }
  return total
}

function estimateContextTokens(msgs: Message[]): number {
  return Math.ceil(estimateContextTokensRaw(msgs) * heuristicCorrectionFactor)
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

    // Calibrate heuristic correction factor from real data
    const rawHeuristic = estimateContextTokensRaw(msgs)
    if (rawHeuristic > 50) {
      const newFactor = total / rawHeuristic
      // Smooth update (moving average) to avoid jumps
      heuristicCorrectionFactor = heuristicCorrectionFactor * 0.3 + newFactor * 0.7
    }

    const correctedHeuristic = estimateContextTokens(msgs)
    debugLog('TOKENS', `Accurate: ${total} (server=${serverCount}+overhead=${overhead}), heuristic=${correctedHeuristic}, correction=${heuristicCorrectionFactor.toFixed(2)}`)
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
  // On small contexts, limit tool results much harder to prevent context bloat
  if (budget < 8000) return Math.min(Math.max(800, Math.floor(charBudget * 0.08)), 3000)
  if (budget < 15000) return Math.min(Math.max(1200, Math.floor(charBudget * 0.10)), 5000)
  return Math.min(Math.max(1500, Math.floor(charBudget * 0.15)), 40000)
}

function smartTruncateToolResult(toolName: string, result: string, maxChars: number): string {
  if (result.length <= maxChars) return result

  // For file reads — context-aware auto-limiting
  if (toolName === 'read_file') {
    const budget = getMessageBudget()
    const lines = result.split('\n')
    const totalLines = lines.length

    // On small contexts, aggressively limit line count even if chars would fit
    let maxLines = Infinity
    if (budget < 8000) maxLines = 100
    else if (budget < 15000) maxLines = 200
    else if (budget < 30000) maxLines = 400

    if (totalLines > maxLines && maxLines < Infinity) {
      const headCount = Math.floor(maxLines * 0.6)
      const tailCount = Math.floor(maxLines * 0.35)
      const head = lines.slice(0, headCount).join('\n')
      const tail = lines.slice(-tailCount).join('\n')
      const hint = `\n\n… [${totalLines} lines total, showing first ${headCount} + last ${tailCount}. Use offset/limit params to read specific sections.]\n\n`
      const truncated = head + hint + tail
      return truncated.length <= maxChars ? truncated : compressToolResultText(result, maxChars)
    }

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
  while (merged.length > 1) {
    const last = merged[merged.length - 1]
    const prev = merged[merged.length - 2]
    if (last.role === 'assistant' && prev.role === 'assistant') {
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

  // Pass 5: Trailing assistant without tool_calls → "response prefill" error with enable_thinking.
  // Convert it to user context so the model can continue without prefill conflict.
  if (merged.length > 0) {
    const last = merged[merged.length - 1]
    if (last.role === 'assistant' && !last.tool_calls) {
      merged.pop()
      if (last.content) {
        merged.push({ role: 'user', content: `[Previous assistant work summary]\n${last.content}\n\nPlease continue the task.` })
      }
    }
  }

  // Pass 6: Ensure at least one user message exists (Qwen template hard requirement)
  const hasUser = merged.some((m) => m.role === 'user')
  if (!hasUser) {
    const sysIdx = merged.findIndex((m) => m.role === 'system')
    merged.splice(sysIdx >= 0 ? sysIdx + 1 : 0, 0, { role: 'user', content: 'Continue with the current task.' })
    debugLog('SANITIZE', 'Injected synthetic user message — template requires at least one')
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
// Truncated tool call repair — salvage partial write_file / edit_file content
// ---------------------------------------------------------------------------

function tryRepairTruncatedToolCall(tc: any): { name: string; args: Record<string, any>; truncated: boolean } | null {
  const fnName = tc.function?.name
  const argsStr = tc.function?.arguments
  if (!fnName || !argsStr || typeof argsStr !== 'string') return null
  if (argsStr.length < 20) return null

  // Only repair write_file and edit_file — the tools that carry large content
  if (fnName !== 'write_file' && fnName !== 'edit_file' && fnName !== 'append_file') return null

  // First try: maybe it's already valid
  try {
    const parsed = JSON.parse(argsStr)
    return { name: fnName, args: parsed, truncated: false }
  } catch {}

  // The JSON is truncated mid-string. Strategy: trim trailing bytes and try closing
  for (let trim = 0; trim < 20; trim++) {
    const base = trim > 0 ? argsStr.slice(0, -trim) : argsStr
    // Try closing with just quote + brace (most common: truncated inside a string value)
    for (const suffix of ['"}', '\\n"}', '"}}\n']) {
      try {
        const parsed = JSON.parse(base + suffix)
        if (parsed.path) {
          debugLog('REPAIR', `Repaired ${fnName}: trimmed ${trim} chars, path=${parsed.path}, content=${(parsed.content ?? '').length} chars`)
          return { name: fnName, args: parsed, truncated: true }
        }
      } catch {}
    }
  }

  // Aggressive: find the last complete JSON key-value and build from there
  const pathMatch = argsStr.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (pathMatch && fnName === 'write_file') {
    const contentMatch = argsStr.match(/"content"\s*:\s*"/)
    if (contentMatch) {
      const contentStart = argsStr.indexOf(contentMatch[0]) + contentMatch[0].length
      let rawContent = argsStr.slice(contentStart)
      // Strip trailing incomplete escape
      rawContent = rawContent.replace(/\\[^"\\\/bfnrtu]?$/, '')
      // Unescape the content we have
      try {
        const fakeJson = `{"v":"${rawContent}"}`
        const parsed = JSON.parse(fakeJson)
        debugLog('REPAIR', `Aggressive repair ${fnName}: path=${pathMatch[1]}, content=${parsed.v.length} chars`)
        return { name: fnName, args: { path: pathMatch[1], content: parsed.v }, truncated: true }
      } catch {}
      // Last resort: raw content without JSON unescaping
      const plainContent = rawContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      if (plainContent.length > 50) {
        debugLog('REPAIR', `Raw repair ${fnName}: path=${pathMatch[1]}, content=${plainContent.length} chars`)
        return { name: fnName, args: { path: pathMatch[1], content: plainContent }, truncated: true }
      }
    }
  }

  return null
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
  currentPlan: string[]
  approach: string
  filesModified: string[]
  filesRead: string[]
  keyFacts: string[]
  lastResults: string[]
}

function extractWorkingMemory(msgs: Message[]): WorkingMemory {
  const mem: WorkingMemory = {
    currentTask: '', currentPlan: [], approach: '',
    filesModified: [], filesRead: [], keyFacts: [], lastResults: [],
  }
  const modifiedFiles = new Set<string>()
  const readFiles = new Set<string>()

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]

    // Extract current task from last user message
    if (m.role === 'user' && !mem.currentTask) {
      const clean = (m.content ?? '').replace(/```[\s\S]*?```/g, '').replace(/\[Context was compacted[\s\S]*?\]/, '').trim()
      if (clean.length > 5) {
        mem.currentTask = clean.length > 300 ? clean.slice(0, 297) + '…' : clean
      }
    }

    // Extract plan (numbered lists) and approach from assistant messages
    if (m.role === 'assistant' && m.content && mem.currentPlan.length === 0) {
      const text = stripThinking(m.content ?? '')
      // Look for numbered plan: "1. ...", "2. ..." etc.
      const planMatch = text.match(/(?:^|\n)\s*\d+[\.\)]\s+.+/g)
      if (planMatch && planMatch.length >= 2) {
        mem.currentPlan = planMatch.slice(0, 6).map((s) => s.trim().slice(0, 120))
      }
      // Approach: first meaningful sentence of the last assistant content
      if (!mem.approach && text.length > 10) {
        const firstSentence = text.replace(/\n/g, ' ').match(/^(.{10,200}?[.!?])/)
        if (firstSentence) mem.approach = firstSentence[1]
      }
    }

    // Track files modified and read
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name
        if (!name) continue
        try {
          const args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments) : tc.function.arguments
          if ((name === 'write_file' || name === 'edit_file' || name === 'append_file') && args.path) {
            modifiedFiles.add(args.path)
          }
          if (name === 'create_directory' && args.path) {
            modifiedFiles.add(args.path + '/')
          }
          if (name === 'read_file' && args.path) {
            readFiles.add(args.path)
          }
        } catch {}
      }
    }

    // Extract key facts and last significant results
    if (m.role === 'tool' && m.content) {
      const c = m.content
      if (c.startsWith('Error') || c.includes('Exit code: 1')) {
        const line = c.split('\n')[0] ?? ''
        if (line.length > 10 && mem.keyFacts.length < 5) {
          mem.keyFacts.push(line.slice(0, 150))
        }
      }
      // Track last significant results (both success and error)
      if (mem.lastResults.length < 3) {
        const firstLine = c.split('\n')[0] ?? ''
        if (firstLine.length > 5) {
          mem.lastResults.push(firstLine.slice(0, 100))
        }
      }
    }
  }

  mem.filesModified = [...modifiedFiles].slice(0, 20)
  mem.filesRead = [...readFiles].slice(0, 15)
  return mem
}

function formatWorkingMemory(mem: WorkingMemory): string {
  const parts: string[] = []
  if (mem.currentTask) {
    parts.push(`**Current task:** ${mem.currentTask}`)
  }
  if (mem.approach) {
    parts.push(`**Current approach:** ${mem.approach}`)
  }
  if (mem.currentPlan.length > 0) {
    parts.push(`**Plan:**\n${mem.currentPlan.join('\n')}`)
  }
  if (mem.filesModified.length > 0) {
    parts.push(`**Files created/modified (do NOT re-read):** ${mem.filesModified.join(', ')}`)
  }
  if (mem.filesRead.length > 0) {
    const readOnly = mem.filesRead.filter((f) => !mem.filesModified.includes(f))
    if (readOnly.length > 0) {
      parts.push(`**Files already read (use offset/limit if needed again):** ${readOnly.join(', ')}`)
    }
  }
  if (mem.keyFacts.length > 0) {
    parts.push(`**Key facts:**\n${mem.keyFacts.map((f) => `- ${f}`).join('\n')}`)
  }
  if (mem.lastResults.length > 0) {
    parts.push(`**Recent results:** ${mem.lastResults.join(' | ')}`)
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
  const budget = getMessageBudget()

  // Adaptive limits based on context size
  const oldThreshold = budget < 8000 ? 300 : budget < 15000 ? 500 : 800
  const oldLimit = budget < 8000 ? 150 : budget < 15000 ? 250 : 400
  // Also compress recent results on small contexts (but less aggressively)
  const recentThreshold = budget < 8000 ? 600 : budget < 15000 ? 1200 : Infinity
  const recentLimit = budget < 8000 ? 300 : budget < 15000 ? 600 : Infinity

  const recentTurns = keepRecentTurns()
  let recentStart = result.length
  let userCount = 0
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      userCount++
      if (userCount >= recentTurns) { recentStart = i; break }
    }
  }

  for (let i = 0; i < result.length; i++) {
    const m = result[i]
    if (m.role !== 'tool' || !m.content) continue

    const isOld = i < recentStart
    const threshold = isOld ? oldThreshold : recentThreshold
    const limit = isOld ? oldLimit : recentLimit

    if (m.content.length > threshold) {
      const compressed = compressToolResultText(m.content, limit)
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

  // Step 3: Drop messages from the front (keep system + last user + last N)
  const system = result.find((m) => m.role === 'system')
  const rest = result.filter((m) => m.role !== 'system')

  // Always preserve the last user message to satisfy chat template requirements
  let lastUserIdx = -1
  for (let j = rest.length - 1; j >= 0; j--) {
    if (rest[j].role === 'user') { lastUserIdx = j; break }
  }

  let keep = rest.length
  while (keep > 2) {
    keep--
    let kept = rest.slice(rest.length - keep)
    // Ensure the last user message is always included
    if (lastUserIdx >= 0 && rest.length - keep > lastUserIdx) {
      const userMsg = rest[lastUserIdx]
      if (!kept.some((m) => m.role === 'user')) {
        kept = [userMsg, ...kept]
      }
    }
    const candidate = system ? [system, ...kept] : kept
    if (estimateContextTokens(candidate) <= budget) return candidate
  }

  // Step 4: Hard truncate system prompt to fit
  const lastMsgs = lastUserIdx >= 0
    ? [rest[lastUserIdx], ...rest.slice(-2).filter((m) => m !== rest[lastUserIdx])].slice(0, 3)
    : rest.slice(-2)
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
// Inject working memory into system prompt — survives compression
// ---------------------------------------------------------------------------

function injectWorkingMemory(msgs: Message[], originalMsgs: Message[]): Message[] {
  const mem = extractWorkingMemory(originalMsgs)
  const memBlock = formatWorkingMemory(mem)
  if (!memBlock) return msgs

  const sysIdx = msgs.findIndex((m) => m.role === 'system')
  if (sysIdx < 0) return msgs

  let sysTxt = msgs[sysIdx].content ?? ''
  const memMark = sysTxt.indexOf('\n\n## Working memory\n')
  if (memMark >= 0) sysTxt = sysTxt.slice(0, memMark)

  // Budget: working memory shouldn't exceed 15% of message budget
  const maxChars = Math.floor(getMessageBudget() * calibratedRatio * 0.15)
  const memTrimmed = memBlock.length > maxChars ? memBlock.slice(0, maxChars - 10) + '\n…' : memBlock

  sysTxt += '\n\n## Working memory\n' + memTrimmed
  msgs[sysIdx] = { ...msgs[sysIdx], content: sysTxt }
  return msgs
}

// ---------------------------------------------------------------------------
// Rehydration: guide model after compaction so it doesn't re-read everything
// ---------------------------------------------------------------------------

function getLastToolAction(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const names = m.tool_calls.map((tc) => {
        const name = tc.function?.name ?? '?'
        try {
          const args = typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments) : tc.function?.arguments
          const target = args?.path ?? args?.command?.slice(0, 60) ?? ''
          return target ? `${name}(${target})` : name
        } catch { return name }
      })
      return names.join(', ')
    }
  }
  return 'unknown'
}

function injectRehydrationHint(msgs: Message[], originalMsgs: Message[]): Message[] {
  const mem = extractWorkingMemory(originalMsgs)
  const lastAction = getLastToolAction(originalMsgs)
  const recentFiles = mem.filesModified.slice(-3)

  const parts: string[] = [
    '[Context was compacted to save space. Summary of earlier work is in the system prompt above.]',
  ]
  if (lastAction !== 'unknown') {
    parts.push(`Your last action was: ${lastAction}`)
  }
  if (recentFiles.length > 0) {
    parts.push(`Files you were working on: ${recentFiles.join(', ')}`)
  }
  parts.push('Continue from where you left off. Do NOT re-read files you already read unless you need a specific section (use offset/limit). Proceed with the next step of the task.')

  msgs.push({ role: 'user', content: parts.join('\n') })
  return msgs
}

// ---------------------------------------------------------------------------
// Main context management — graduated compression pipeline
// ---------------------------------------------------------------------------

let lastTier3Iteration = -10

async function manageContext(
  msgs: Message[],
  apiUrl: string,
  win: BrowserWindow,
  signal?: AbortSignal,
  iteration?: number,
): Promise<Message[]> {
  const budget = getMessageBudget()
  let tokens = estimateContextTokens(msgs)

  debugLog('CTX', `manageContext: ${msgs.length} msgs, ${tokens} tokens, budget=${budget}, ctx=${ctxTokens()}, ratio=${(tokens/budget*100).toFixed(0)}%`)

  // Under threshold — no compression needed
  if (tokens <= budget * COMPRESS_TOOL_RESULTS_AT) return msgs

  // Preserve original messages for working memory extraction before compression
  const originalMsgs = [...msgs]
  let current = msgs

  // Tier 1: Compress old tool results
  if (tokens > budget * COMPRESS_TOOL_RESULTS_AT) {
    const { msgs: compressed } = tier1CompressOldToolResults(current)
    current = compressed
    tokens = estimateContextTokens(current)
    if (tokens <= budget * SUMMARIZE_AT) {
      return injectWorkingMemory(current, originalMsgs)
    }
  }

  // Tier 2: Collapse old tool-call chains
  if (tokens > budget * SUMMARIZE_AT) {
    const nonSystem = current.filter((m) => m.role !== 'system')
    if (nonSystem.length >= 6) {
      const { msgs: collapsed } = tier2CollapseOldChains(current)
      current = collapsed
      tokens = estimateContextTokens(current)
      if (tokens <= budget * AGGRESSIVE_PRUNE_AT) {
        return injectWorkingMemory(current, originalMsgs)
      }
    }
  }

  // Tier 3: LLM summarization (with cooldown to avoid spamming on small contexts)
  const iter = iteration ?? 0
  const tier3Cooldown = budget < 8000 ? 5 : budget < 15000 ? 3 : 2
  const tier3Ready = (iter - lastTier3Iteration) >= tier3Cooldown

  if (tokens > budget * SUMMARIZE_AT && tier3Ready) {
    const nonSystem = current.filter((m) => m.role !== 'system')
    if (nonSystem.length >= 4) {
      current = await tier3Summarize(current, apiUrl, win, signal)
      lastTier3Iteration = iter
      tokens = estimateContextTokens(current)
      current = injectRehydrationHint(current, originalMsgs)
      if (tokens <= budget * EMERGENCY_AT) return current
    }
  }

  // Tier 4: Emergency prune
  if (tokens > budget * EMERGENCY_AT) {
    emit(win, { type: 'status', content: '⚠️ Экстренная обрезка контекста' })
    current = tier4EmergencyPrune(current)
    current = injectRehydrationHint(current, originalMsgs)
  }

  return current
}

// Cached project context — invalidated on workspace change
let projectContextCache: { ws: string; ctx: string; ts: number } | null = null
const PROJECT_CTX_CACHE_TTL = 60000

export function invalidateProjectContextCache() {
  projectContextCache = null
}

function getProjectContext(ws: string): string {
  try {
    // Return cached if fresh
    if (projectContextCache && projectContextCache.ws === ws && (Date.now() - projectContextCache.ts) < PROJECT_CTX_CACHE_TTL) {
      return budgetTrimProjectContext(projectContextCache.ctx)
    }

    // Build full context (cached at max detail level)
    const tree = executeTool('list_directory', { depth: 2 }, ws)
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

    projectContextCache = { ws, ctx, ts: Date.now() }
    return budgetTrimProjectContext(ctx)
  } catch {
    return ''
  }
}

function budgetTrimProjectContext(ctx: string): string {
  const ctxSize = ctxTokens()
  // Budget-aware sizing: smaller contexts get smaller repo maps
  let maxLines: number
  if (ctxSize < 16384) maxLines = 15
  else if (ctxSize < 32768) maxLines = 30
  else maxLines = Infinity

  if (maxLines < Infinity) {
    const lines = ctx.split('\n')
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + '\n…[truncated]\n'
    }
  }

  const budgetFraction = ctxSize < 16384 ? 0.12 : ctxSize < 32768 ? 0.20 : 0.35
  const budgetForCtx = Math.max(Math.floor(getMessageBudget() * budgetFraction), 200)
  if (ctx.length > budgetForCtx) {
    return ctx.slice(0, budgetForCtx - 20) + '\n…[truncated]\n'
  }
  return ctx
}

export function setWorkspace(ws: string) {
  workspace = ws
  invalidateProjectContextCache()
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
  lastTier3Iteration = -10

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

  // Verify actual server ctx size (catches mismatches from server auto-reducing ctx)
  queryActualCtxSize().catch(() => {})

  // Summarize/prune context if approaching limit
  messages = await manageContext(messages, apiUrl, win)
  session.messages = messages
  emitContextUsage(win, messages)
  let fullResponse = ''
  let emptyRetries = 0

  // Track files created this turn to detect pointless re-reads after compression
  const filesCreatedThisTurn = new Set<string>()
  let consecutiveReReads = 0

  // General loop detection: same tool + same args repeated
  let lastToolSig = ''
  let sameToolRepeatCount = 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (cancelRequested) {
      emit(win, { type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
      session.updatedAt = Date.now()
      saveSession(session)
      return 'Canceled'
    }

    // Signal the UI to start a new assistant "bubble" for each iteration
    if (i > 0) {
      emit(win, { type: 'new_turn' })
      fullResponse = ''
    }

    // Pre-flight: sanitize structure + ensure messages fit in context budget
    messages = sanitizeMessages(messages)
    const accurateTokens = await countContextTokensAccurate(messages)
    const preflightBudget = getMessageBudget()
    const serverCtx = ctxTokens()
    debugLog('PREFLIGHT', `iter=${i}, msgs=${messages.length}, tokens=${accurateTokens}, budget=${preflightBudget}, ctx=${serverCtx}, ratio=${(accurateTokens/preflightBudget*100).toFixed(0)}%, maxResp=${getMaxResponseTokens()}`)

    if (accurateTokens > preflightBudget * EMERGENCY_AT) {
      emit(win, { type: 'status', content: '🗜️ Обрезка контекста перед запросом…' })
      messages = tier4EmergencyPrune(messages)
      messages = sanitizeMessages(messages)
      session.messages = messages
    }

    // Hard clamp: max_tokens must NEVER exceed (server ctx - prompt tokens)
    // This prevents HTTP 400 "exceeds available context size" errors
    const postPruneTokens = await countContextTokensAccurate(messages)
    const desiredMaxTokens = getMaxResponseTokens()
    const hardLimit = Math.max(256, serverCtx - postPruneTokens - 50)
    const effectiveMaxTokens = Math.min(desiredMaxTokens, hardLimit)
    if (effectiveMaxTokens < desiredMaxTokens) {
      debugLog('PREFLIGHT', `Clamped max_tokens: ${desiredMaxTokens} → ${effectiveMaxTokens} (ctx=${serverCtx}, prompt=${postPruneTokens})`)
    }

    let streamResult: StreamResult
    try {
      const controller = new AbortController()
      currentAbort = controller
      // No fixed total timeout — idle timeout inside streamLlmResponse handles stalls
      // Only abort on user cancel or server idle (120s no data)

      const retryTemp = emptyRetries > 0 ? 0.3 + emptyRetries * 0.2 : undefined
      streamResult = await streamLlmResponse(apiUrl, messages, win, fullResponse, controller.signal, effectiveMaxTokens, retryTemp)
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
        emit(win, { type: 'error', content: 'Соединение с моделью прервано (сервер не отвечал 60 секунд). Попробуйте ещё раз.' })
        session.updatedAt = Date.now()
        saveSession(session)
        return 'Error: connection lost'
      }

      if (isContextError) {
        // Extract real n_ctx from server error and auto-correct our tracking
        const ctxMatch = errMsg.match(/n_ctx[":=\s]*(\d+)/)
        if (ctxMatch) {
          const realCtx = parseInt(ctxMatch[1])
          if (realCtx > 0 && realCtx !== ctxTokens()) {
            debugLog('CTX_FIX', `Server reports n_ctx=${realCtx}, we tracked ${ctxTokens()} — correcting!`)
            setCtxSize(realCtx)
            emitContextUsage(win, messages)
          }
        }

        emit(win, { type: 'status', content: `🔧 Ошибка контекста (реальный ctx=${ctxTokens()}) — очищаю и повторяю…` })
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
    const rawToolCalls = streamResult.rawToolCalls
    const finishReason = streamResult.finishReason

    // --- Truncated tool call handling ---
    // Model tried to call a tool but JSON was too large and got cut off
    if (!toolCalls && rawToolCalls && rawToolCalls.length > 0) {
      debugLog('TRUNCATED', `Detected truncated tool call(s): ${rawToolCalls.length}, finish=${finishReason}`)

      let repaired = false
      for (const rawTc of rawToolCalls) {
        const repair = tryRepairTruncatedToolCall(rawTc)
        if (repair && repair.truncated) {
          const { name: repairName, args: repairArgs } = repair
          debugLog('TRUNCATED', `Repaired ${repairName}: path=${repairArgs.path}, chars=${(repairArgs.content ?? '').length}`)
          emit(win, { type: 'status', content: `🔧 Tool call обрезался — спасаю частичный контент (${(repairArgs.content ?? '').length} символов)…` })
          emit(win, { type: 'tool_call', name: repairName, args: repairArgs })

          const needsApproval = NEEDS_APPROVAL.has(repairName)
          const approved = needsApproval ? await requestApproval(win, repairName, repairArgs) : true

          if (approved) {
            const result = executeTool(repairName, repairArgs, workspace)
            const uiResult = result.length > 5000 ? result.slice(0, 5000) : result
            emit(win, { type: 'tool_result', name: repairName, result: uiResult })

            const fsModTools = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory', 'append_file'])
            if (fsModTools.has(repairName) && !result.startsWith('Error') && !result.startsWith('[Denied')) {
              try { win.webContents.send('workspace-files-changed') } catch {}
            }

            const tcId = rawTc.id || `repair-${Date.now()}`
            messages.push({
              role: 'assistant',
              tool_calls: [{ id: tcId, type: 'function', function: { name: repairName, arguments: JSON.stringify(repairArgs) } }],
            })
            messages.push({ role: 'tool' as any, tool_call_id: tcId, content: result.slice(0, dynamicToolResultLimit()) })

            // Self-correction: tell model what happened and how to continue
            const contentLen = (repairArgs.content ?? '').length
            messages.push({
              role: 'user',
              content: `⚠️ Your ${repairName} call was truncated by the generation limit — the file was saved with partial content (${contentLen} chars). The file is INCOMPLETE. Please:\n1. read_file to see what was saved\n2. Use edit_file or append_file to add the remaining content in small chunks (under 100 lines per call)\nDo NOT rewrite the entire file — continue from where it was cut off.`,
            })
            repaired = true
          } else {
            messages.push({ role: 'assistant', content: `Tried to ${repairName} but approval was denied.` })
          }
        }
      }

      if (repaired) {
        session.messages = messages
        saveSession(session)
        emitContextUsage(win, messages)
        continue
      }

      // Could not repair — give self-correction feedback without executing
      const rawName = rawToolCalls[0]?.function?.name ?? 'unknown'
      debugLog('TRUNCATED', `Could not repair ${rawName}, giving feedback`)
      emit(win, { type: 'status', content: `⚠️ Tool call "${rawName}" обрезался — прошу модель разбить на части…` })
      messages.push({ role: 'assistant', content: `I tried to call ${rawName} but the content was too large and the JSON was truncated.` })
      messages.push({
        role: 'user',
        content: `Your ${rawName} tool call failed — the JSON arguments were truncated because the content was too large for a single generation. IMPORTANT: Break large file writes into smaller steps:\n1. First write_file with just the skeleton/structure (imports, basic HTML structure, empty function bodies) — under 80 lines\n2. Then use edit_file to fill in each section one at a time\n3. Or use append_file to add content incrementally\nNever put more than 100 lines of content in a single tool call.`,
      })
      session.messages = messages
      saveSession(session)
      continue
    }

    // --- Recover text-based tool calls from content/thinking ---
    // Model sometimes writes tool calls as text instead of using the API
    if (!toolCalls && content) {
      const textCalls = extractTextToolCalls(content)
      if (textCalls.length > 0) {
        debugLog('TEXT_TOOL', `Recovered ${textCalls.length} text-based tool call(s): ${textCalls.map((t) => t.name).join(', ')}`)
        const [thinking] = extractThinking(content)
        if (thinking) {
          emit(win, { type: 'thinking', content: thinking })
        }

        const recoveredCustomTools = config.get('customTools')
        for (const tc of textCalls) {
          emit(win, { type: 'tool_call', name: tc.name, args: tc.args })

          const isCustom = recoveredCustomTools.some((ct: any) => ct.name === tc.name)
          if (isCustom || NEEDS_APPROVAL.has(tc.name)) {
            const approved = await requestApproval(win, tc.name, tc.args)
            if (!approved) {
              const deniedResult = `[Denied by user] Operation "${tc.name}" was not approved.`
              emit(win, { type: 'tool_result', name: tc.name, result: deniedResult })
              messages.push({ role: 'assistant', content: stripThinking(content) })
              messages.push({ role: 'user', content: deniedResult })
              break
            }
          }

          let result: string
          if (isCustom) {
            const ct = recoveredCustomTools.find((t: any) => t.name === tc.name)
            result = ct ? executeCustomTool(ct, tc.args, workspace) : `Error: custom tool "${tc.name}" not found`
          } else {
            result = executeTool(tc.name, tc.args, workspace)
          }

          const uiResult = result.length > 5000 ? result.slice(0, 5000) + '\n… [truncated]' : result
          emit(win, { type: 'tool_result', name: tc.name, result: uiResult })

          // Build proper tool_calls message format
          const callId = `text_tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          messages.push({
            role: 'assistant',
            content: stripThinking(content),
            tool_calls: [{ id: callId, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }],
          })
          messages.push({ role: 'tool', tool_call_id: callId, content: smartTruncateToolResult(tc.name, result, dynamicToolResultLimit()) })
        }

        session.messages = messages
        saveSession(session)
        emitContextUsage(win, messages)
        continue
      }
    }

    // --- Truly empty response handling ---
    // Also treat responses that are ONLY thinking (no visible content) as empty
    const visibleContent = content ? extractThinking(content)[1].trim() : ''
    const isEffectivelyEmpty = !visibleContent && !toolCalls
    if (isEffectivelyEmpty) {
      const usedTokens = estimateContextTokens(messages)
      const budgetNow = getMessageBudget()
      const usageRatio = usedTokens / budgetNow
      debugLog('EMPTY', `Empty response #${emptyRetries + 1}, msgs=${messages.length}, tokens=${usedTokens}, budget=${budgetNow}, usage=${(usageRatio * 100).toFixed(0)}%`)
      emptyRetries++

      if (emptyRetries <= MAX_EMPTY_RETRIES) {
        if (usageRatio > 0.5) {
          emit(win, { type: 'status', content: `⚠️ Пустой ответ — обрезаю контекст и повторяю (${emptyRetries}/${MAX_EMPTY_RETRIES})…` })
          messages = tier4EmergencyPrune(messages)
          session.messages = messages
        } else {
          // Nudge the model — add a user message to break the empty-response loop
          const lastMsg = messages[messages.length - 1]
          const afterTool = lastMsg?.role === 'tool'
          const nudge = afterTool
            ? 'The tool above returned a result. Please analyze it and continue with the task. Respond in the user\'s language.'
            : 'Please respond to the user\'s request. Think step by step and use tools as needed.'
          messages.push({ role: 'user', content: `[System: empty response detected, retry ${emptyRetries}/${MAX_EMPTY_RETRIES}] ${nudge}` })
          debugLog('EMPTY', `Added nudge message (afterTool=${afterTool})`)
          emit(win, { type: 'status', content: `⚠️ Пустой ответ от модели — повторяю с подсказкой (${emptyRetries}/${MAX_EMPTY_RETRIES})…` })
        }
        saveSession(session)
        continue
      }
      emit(win, { type: 'error', content: 'Модель вернула пустой ответ после нескольких попыток. Попробуйте переформулировать запрос или начать новый чат.' })
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

      // Track files created this turn
      if ((toolName === 'write_file' || toolName === 'append_file' || toolName === 'create_directory') && toolArgs.path) {
        filesCreatedThisTurn.add(toolArgs.path)
      }

      // General loop detection: same tool + same args called repeatedly
      const readOnlyTools = new Set(['read_file', 'list_directory', 'find_files'])
      const toolSig = `${toolName}:${JSON.stringify(toolArgs)}`
      if (toolSig === lastToolSig && readOnlyTools.has(toolName)) {
        sameToolRepeatCount++
        debugLog('LOOP', `Duplicate ${toolName} call #${sameToolRepeatCount + 1}: ${toolArgs.path ?? ''}`)
        if (sameToolRepeatCount >= 2) {
          const skipMsg = `You already called ${toolName} with these exact arguments ${sameToolRepeatCount + 1} times. The result hasn't changed. Stop re-reading and proceed with the actual task. If you need to modify a file, use edit_file. If you're stuck, explain what you're trying to do.`
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: skipMsg })
          emit(win, { type: 'tool_result', name: toolName, result: skipMsg })
          continue
        }
      } else {
        sameToolRepeatCount = 0
      }
      lastToolSig = toolSig

      // Detect pointless re-reads of files we JUST created
      if (toolName === 'read_file' && toolArgs.path && filesCreatedThisTurn.has(toolArgs.path)) {
        consecutiveReReads++
        debugLog('LOOP', `Re-read of just-created file: ${toolArgs.path} (consecutive: ${consecutiveReReads})`)
        if (consecutiveReReads >= 3) {
          const skipMsg = `You just created ${toolArgs.path} in this session — its contents are exactly what you wrote. Instead of re-reading files you just created, continue with the next step of the task. What files still need to be created or modified?`
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: skipMsg })
          emit(win, { type: 'tool_result', name: toolName, result: skipMsg })
          continue
        }
      } else {
        consecutiveReReads = 0
      }

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
      const fsModTools = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory', 'append_file'])
      if (fsModTools.has(toolName) && !result.startsWith('Error') && !result.startsWith('[Denied')) {
        invalidateProjectContextCache()
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
    messages = await manageContext(messages, apiUrl, win, undefined, i)
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
