import { BrowserWindow, ipcMain } from 'electron'
import { llamaApiUrl } from './server-manager'
import { TOOL_DEFINITIONS, executeTool } from './tools'
import type { AgentEvent } from './types'

const NEEDS_APPROVAL = new Set(['execute_command', 'write_file', 'edit_file', 'delete_file'])

const MAX_ITERATIONS = 30
const MAX_TOOL_RESULT_CHARS = 40000
const MAX_CONTEXT_CHARS = 800000 // ~200K tokens rough estimate

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

let messages: Message[] = []
let workspace = ''
let projectContextAdded = false

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

// Estimate character count across all messages
function estimateContextSize(msgs: Message[]): number {
  let total = 0
  for (const m of msgs) {
    total += (m.content ?? '').length
    if (m.tool_calls) total += JSON.stringify(m.tool_calls).length
  }
  return total
}

// Prune old tool results to keep context within budget
function pruneContext(msgs: Message[]): Message[] {
  let size = estimateContextSize(msgs)
  if (size <= MAX_CONTEXT_CHARS) return msgs

  const result = [...msgs]
  // Find tool result messages (oldest first) and truncate their content
  for (let i = 0; i < result.length && size > MAX_CONTEXT_CHARS; i++) {
    const m = result[i]
    if (m.role === 'tool' && m.content && m.content.length > 2000) {
      const saved = m.content.length - 500
      result[i] = { ...m, content: m.content.slice(0, 300) + '\n… [pruned to save context]\n' + m.content.slice(-200) }
      size -= saved
    }
  }

  // If still too large, remove oldest user/assistant pairs (keep system + last 10 exchanges)
  if (size > MAX_CONTEXT_CHARS) {
    const system = result.find((m) => m.role === 'system')
    const rest = result.filter((m) => m.role !== 'system')
    const keep = Math.max(20, rest.length - Math.floor(rest.length * 0.3))
    const pruned = rest.slice(rest.length - keep)
    return system ? [system, ...pruned] : pruned
  }

  return result
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
  projectContextAdded = false // re-detect on workspace change
}

export function resetAgent() {
  messages = []
  projectContextAdded = false
}

export async function runAgent(userMessage: string, ws: string, win: BrowserWindow): Promise<string> {
  workspace = ws

  // On first message in this session, prepend project context
  if (!projectContextAdded && ws) {
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
    projectContextAdded = true
  } else if (!messages.some((m) => m.role === 'system')) {
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT })
  }

  messages.push({ role: 'user', content: userMessage })

  // Prune context if needed
  messages = pruneContext(messages)

  const apiUrl = `${llamaApiUrl()}/v1/chat/completions`
  let fullResponse = ''

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response: any
    try {
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen',
          messages,
          tools: TOOL_DEFINITIONS,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 32768,
        }),
        signal: AbortSignal.timeout(300000),
      })
      if (!r.ok) {
        const errBody = await r.text()
        emit(win, { type: 'error', content: `LLM HTTP ${r.status}: ${errBody.slice(0, 500)}` })
        return `Error: HTTP ${r.status}`
      }
      response = await r.json()
    } catch (e: any) {
      emit(win, { type: 'error', content: `LLM request failed: ${e.message}` })
      return `Error: ${e.message}`
    }

    const msg = response.choices?.[0]?.message
    if (!msg) {
      const errInfo = JSON.stringify(response).slice(0, 500)
      emit(win, { type: 'error', content: `Unexpected LLM response: ${errInfo}` })
      return 'Empty response'
    }

    const content = msg.content ?? ''
    const toolCalls = msg.tool_calls as any[] | undefined

    const [thinking, visible] = extractThinking(content)
    if (thinking) emit(win, { type: 'thinking', content: thinking })

    // No tool calls → final response
    if (!toolCalls || toolCalls.length === 0) {
      const finalText = visible || content
      fullResponse += (fullResponse ? '\n\n' : '') + finalText
      emit(win, { type: 'response', content: fullResponse, done: true })
      messages.push({ role: 'assistant', content })
      return fullResponse
    }

    // Has tool calls — accumulate partial text
    if (visible) {
      fullResponse += (fullResponse ? '\n\n' : '') + visible
      emit(win, { type: 'response', content: fullResponse, done: false })
    }

    messages.push(msg)

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

      // Truncate for LLM context
      let llmResult = result
      if (llmResult.length > MAX_TOOL_RESULT_CHARS) {
        const head = llmResult.slice(0, MAX_TOOL_RESULT_CHARS * 0.7)
        const tail = llmResult.slice(-MAX_TOOL_RESULT_CHARS * 0.2)
        llmResult = head + `\n\n… [${Math.round(result.length / 1024)}KB total, middle truncated] …\n\n` + tail
      }

      messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: llmResult })
    }

    // Prune after each iteration to stay within budget
    messages = pruneContext(messages)
  }

  const msg = 'Reached maximum iterations. Stopping.'
  fullResponse += (fullResponse ? '\n\n' : '') + msg
  emit(win, { type: 'response', content: fullResponse, done: true })
  return fullResponse
}
