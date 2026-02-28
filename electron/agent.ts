import { BrowserWindow, ipcMain } from 'electron'
import { llamaApiUrl, getCtxSize } from './server-manager'
import { TOOL_DEFINITIONS, executeTool } from './tools'
import type { AgentEvent } from './types'

const NEEDS_APPROVAL = new Set(['execute_command', 'write_file', 'edit_file', 'delete_file'])

const MAX_ITERATIONS = 30
const MAX_TOOL_RESULT_CHARS = 40000

const CHARS_PER_TOKEN = 3
const SUMMARIZE_THRESHOLD = 0.60
const KEEP_RECENT_TURNS = 6
const SUMMARY_MAX_TOKENS = 4096
const FALLBACK_MAX_CONTEXT_CHARS = 120000

const SYSTEM_PROMPT = `You are an expert software engineer working as an autonomous coding agent. You operate inside a local development environment and interact with the user's project through tools.

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
): Promise<StreamResult> {
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen',
      messages: msgs,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 32768,
      stream: true,
    }),
    signal,
  })

  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`HTTP ${r.status}: ${errBody.slice(0, 500)}`)
  }

  if (!r.body) {
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
  let emitThrottle = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

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

        // Emit visible response (throttled to every ~80ms worth of chunks)
        if (visible.length > lastVisibleLen) {
          emitThrottle++
          if (emitThrottle % 3 === 0 || thinkingDone) {
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

  const toolCalls = toolCallMap.size > 0 ? [...toolCallMap.values()] : undefined

  return { content: accContent, toolCalls }
}

function getMaxContextChars(): number {
  const ctx = getCtxSize()
  if (ctx > 0) return ctx * CHARS_PER_TOKEN
  return FALLBACK_MAX_CONTEXT_CHARS
}

function estimateContextSize(msgs: Message[]): number {
  let total = 0
  for (const m of msgs) {
    total += (m.content ?? '').length
    if (m.tool_calls) total += JSON.stringify(m.tool_calls).length
  }
  return total
}

// ---------------------------------------------------------------------------
// Context summarization — calls the LLM to compress old conversation history
// ---------------------------------------------------------------------------

const SUMMARIZE_PROMPT = `You are a conversation compressor. Summarize the following conversation between a user and an AI coding agent.

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

function formatMessagesForSummary(msgs: Message[]): string {
  const parts: string[] = []
  for (const m of msgs) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      parts.push(`**User:** ${m.content ?? ''}`)
    } else if (m.role === 'assistant') {
      const text = (m.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      if (m.tool_calls && m.tool_calls.length > 0) {
        const calls = m.tool_calls.map((tc: any) => {
          const args = typeof tc.function?.arguments === 'string'
            ? tc.function.arguments.slice(0, 200)
            : JSON.stringify(tc.function?.arguments ?? {}).slice(0, 200)
          return `${tc.function?.name}(${args}…)`
        }).join(', ')
        parts.push(`**Assistant:** ${text ? text + ' ' : ''}[Tools: ${calls}]`)
      } else if (text) {
        parts.push(`**Assistant:** ${text}`)
      }
    } else if (m.role === 'tool') {
      const preview = (m.content ?? '').slice(0, 300)
      parts.push(`**Tool result** (${m.tool_call_id ?? '?'}): ${preview}${(m.content ?? '').length > 300 ? '…' : ''}`)
    }
  }
  return parts.join('\n\n')
}

function findSummarySplitIndex(msgs: Message[]): number {
  let userCount = 0
  let splitIdx = msgs.length

  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      userCount++
      if (userCount >= KEEP_RECENT_TURNS) {
        splitIdx = i
        break
      }
    }
  }

  // Walk backward from splitIdx to find a safe break point (before a user message,
  // not in the middle of a tool_call → tool_result chain)
  while (splitIdx > 0 && msgs[splitIdx]?.role !== 'user') {
    splitIdx++
  }

  return Math.min(splitIdx, msgs.length)
}

async function summarizeOldMessages(
  oldMsgs: Message[],
  apiUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const text = formatMessagesForSummary(oldMsgs)
  if (text.length < 500) return null

  const maxPromptChars = getMaxContextChars() * 0.5
  const truncatedText = text.length > maxPromptChars
    ? text.slice(0, maxPromptChars * 0.7) + '\n\n…[middle omitted]…\n\n' + text.slice(-maxPromptChars * 0.2)
    : text

  try {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen',
        messages: [{ role: 'user', content: SUMMARIZE_PROMPT + truncatedText }],
        temperature: 0.1,
        max_tokens: SUMMARY_MAX_TOKENS,
      }),
      signal,
    })
    if (!r.ok) return null
    const json = await r.json() as any
    const content = json.choices?.[0]?.message?.content
    return content && content.length > 50 ? content : null
  } catch {
    return null
  }
}

// Inject summary into system message
function injectSummary(systemContent: string, summary: string): string {
  const marker = '\n\n## Summary of earlier conversation\n'
  const idx = systemContent.indexOf(marker)
  const base = idx >= 0 ? systemContent.slice(0, idx) : systemContent
  return base + marker + summary + '\n'
}

// Emergency fallback: hard prune when summarization fails or context still too large
function hardPruneContext(msgs: Message[]): Message[] {
  const maxChars = getMaxContextChars()
  let size = estimateContextSize(msgs)
  if (size <= maxChars) return msgs

  const result = [...msgs]

  for (let i = 0; i < result.length && size > maxChars; i++) {
    const m = result[i]
    if (m.role === 'tool' && m.content && m.content.length > 2000) {
      const saved = m.content.length - 500
      result[i] = { ...m, content: m.content.slice(0, 300) + '\n… [pruned]\n' + m.content.slice(-200) }
      size -= saved
    }
  }

  if (size > maxChars) {
    const system = result.find((m) => m.role === 'system')
    const rest = result.filter((m) => m.role !== 'system')
    const keep = Math.max(20, rest.length - Math.floor(rest.length * 0.3))
    const pruned = rest.slice(rest.length - keep)
    return system ? [system, ...pruned] : pruned
  }

  return result
}

// Main context management: summarize if approaching limit, hard-prune as last resort
async function manageContext(
  msgs: Message[],
  apiUrl: string,
  win: BrowserWindow,
  signal?: AbortSignal,
): Promise<Message[]> {
  const maxChars = getMaxContextChars()
  const size = estimateContextSize(msgs)

  if (size <= maxChars * SUMMARIZE_THRESHOLD) return msgs

  // Find the split point: keep recent turns, summarize the rest
  const nonSystem = msgs.filter((m) => m.role !== 'system')
  if (nonSystem.length < 10) return hardPruneContext(msgs)

  const splitIdx = findSummarySplitIndex(msgs)
  const systemMsg = msgs.find((m) => m.role === 'system')
  const oldMessages = msgs.slice(systemMsg ? 1 : 0, splitIdx)
  const recentMessages = msgs.slice(splitIdx)

  if (oldMessages.length < 4) return hardPruneContext(msgs)

  emit(win, { type: 'status', content: '🗜️ Сжатие контекста — суммаризация истории…' })

  const summary = await summarizeOldMessages(oldMessages, apiUrl, signal)

  if (summary) {
    const baseSystem = systemMsg?.content ?? SYSTEM_PROMPT
    const newSystemContent = injectSummary(baseSystem, summary)
    const compacted: Message[] = [
      { role: 'system', content: newSystemContent },
      ...recentMessages,
    ]

    const newSize = estimateContextSize(compacted)
    const ctxTokens = getCtxSize()
    const pctUsed = ctxTokens > 0 ? Math.round((newSize / CHARS_PER_TOKEN / ctxTokens) * 100) : '?'
    emit(win, {
      type: 'status',
      content: `✅ Контекст сжат: ${oldMessages.length} сообщений → саммари. Использовано ~${pctUsed}% окна`,
    })

    return hardPruneContext(compacted)
  }

  emit(win, { type: 'status', content: '⚠️ Суммаризация не удалась, жёсткая обрезка контекста' })
  return hardPruneContext(msgs)
}

// Get project structure for auto-context
function getProjectContext(ws: string): string {
  try {
    const tree = executeTool('list_directory', { depth: 2 }, ws)
    let ctx = `## Current project\n\nWorkspace: ${ws}\n\n\`\`\`\n${tree}\n\`\`\`\n`

    // Try to detect project type from common files
    const fs = require('fs')
    const path = require('path')
    const indicators: [string, string][] = [
      ['package.json', 'Node.js/JavaScript project'],
      ['Cargo.toml', 'Rust project'],
      ['go.mod', 'Go project'],
      ['pyproject.toml', 'Python project (pyproject)'],
      ['requirements.txt', 'Python project'],
      ['pom.xml', 'Java/Maven project'],
      ['build.gradle', 'Java/Gradle project'],
      ['CMakeLists.txt', 'C/C++ CMake project'],
      ['Makefile', 'Project with Makefile'],
      ['docker-compose.yml', 'Docker Compose project'],
      ['Dockerfile', 'Dockerized project'],
    ]
    const detected: string[] = []
    for (const [file, desc] of indicators) {
      if (fs.existsSync(path.join(ws, file))) detected.push(desc)
    }
    if (detected.length > 0) {
      ctx += `\nDetected: ${detected.join(', ')}\n`
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
        { role: 'system', content: SYSTEM_PROMPT + '\n\n' + ctx },
        ...messages.filter((m) => m.role !== 'system'),
      ]
    } else {
      if (!messages.some((m) => m.role === 'system')) {
        messages.unshift({ role: 'system', content: SYSTEM_PROMPT })
      }
    }
    session.projectContextAdded = true
  } else if (!messages.some((m) => m.role === 'system')) {
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT })
  }

  messages.push({ role: 'user', content: userMessage })
  session.messages = messages

  const apiUrl = `${llamaApiUrl()}/v1/chat/completions`

  // Summarize/prune context if approaching limit
  messages = await manageContext(messages, apiUrl, win)
  session.messages = messages
  let fullResponse = ''

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (cancelRequested) {
      emit(win, { type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
      session.updatedAt = Date.now()
      saveSession(session)
      return 'Canceled'
    }

    let streamResult: StreamResult
    try {
      const controller = new AbortController()
      currentAbort = controller
      const timeout = setTimeout(() => {
        try { controller.abort() } catch {}
      }, 300000)

      streamResult = await streamLlmResponse(apiUrl, messages, win, fullResponse, controller.signal)
      clearTimeout(timeout)
    } catch (e: any) {
      if (cancelRequested && e?.name === 'AbortError') {
        emit(win, { type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
        session.updatedAt = Date.now()
        saveSession(session)
        return 'Canceled'
      }
      emit(win, { type: 'error', content: `LLM request failed: ${e.message}` })
      session.updatedAt = Date.now()
      saveSession(session)
      return `Error: ${e.message}`
    }

    const content = streamResult.content
    const toolCalls = streamResult.toolCalls

    if (!content && !toolCalls) {
      emit(win, { type: 'error', content: 'Empty LLM response' })
      return 'Empty response'
    }

    const [, visible] = extractThinking(content)

    // No tool calls → final response
    if (!toolCalls || toolCalls.length === 0) {
      const finalText = visible || content
      fullResponse += (fullResponse ? '\n\n' : '') + finalText
      emit(win, { type: 'response', content: fullResponse, done: true })
      messages.push({ role: 'assistant', content })
      session.messages = messages
      session.updatedAt = Date.now()
      saveSession(session)
      return fullResponse
    }

    // Has tool calls — accumulate partial text
    if (visible) {
      fullResponse += (fullResponse ? '\n\n' : '') + visible
    }

    messages.push({
      role: 'assistant',
      content: content || undefined,
      tool_calls: toolCalls,
    })

    // Execute tool calls
    for (const tc of toolCalls) {
      const fn = tc.function
      const toolName = fn.name
      let toolArgs: Record<string, any>
      try {
        toolArgs = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
      } catch {
        toolArgs = {}
      }

      emit(win, { type: 'tool_call', name: toolName, args: toolArgs })

      // Request user approval for destructive operations
      let result: string
      if (NEEDS_APPROVAL.has(toolName)) {
        const approved = await requestApproval(win, toolName, toolArgs)
        if (approved) {
          result = executeTool(toolName, toolArgs, workspace)
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

      // Truncate for LLM context
      let llmResult = result
      if (llmResult.length > MAX_TOOL_RESULT_CHARS) {
        const head = llmResult.slice(0, MAX_TOOL_RESULT_CHARS * 0.7)
        const tail = llmResult.slice(-MAX_TOOL_RESULT_CHARS * 0.2)
        llmResult = head + `\n\n… [${Math.round(result.length / 1024)}KB total, middle truncated] …\n\n` + tail
      }

      messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: llmResult })
    }

    // Summarize/prune after each iteration to stay within budget
    messages = await manageContext(messages, apiUrl, win)
    session.messages = messages
  }

  const msg = 'Reached maximum iterations. Stopping.'
  fullResponse += (fullResponse ? '\n\n' : '') + msg
  emit(win, { type: 'response', content: fullResponse, done: true })
  session.updatedAt = Date.now()
  saveSession(session)
  return fullResponse
}
