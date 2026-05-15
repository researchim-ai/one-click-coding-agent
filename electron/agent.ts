import { TOOL_DEFINITIONS, executeTool, executeCustomTool, getBuiltinToolDefinitions } from './tools'
import { createCheckpoint, describeToolForCheckpoint } from './checkpoints'
import * as archive from './archive'
import { RECALL_TOOL_DEF } from './archive'
import * as projectMemory from './project-memory'
import * as toolCache from './tool-cache'
import { previewWriteFile, previewEditFile, applySelectedHunks } from './diff-hunks'
import { captureAgentFileBaseline } from './git'
import type { HunkReviewPayload, AgentMode } from './types'
import { Agent as UndiciAgent } from 'undici'
import {
  TaskState,
  type PlanStep,
  type PlanOption,
  emptyTaskState,
  applyTaskStateUpdate,
  normalizeTaskState,
  renderTaskStateForPrompt,
  UPDATE_PLAN_TOOL_DEF,
} from './task-state'
import type { AgentEvent } from './types'
import type { AppConfig } from './config'
import { load as loadConfig } from './config'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Bridge: main process implements with Electron/win; worker implements with postMessage.
export interface AgentBridge {
  emit(event: AgentEvent): void
  requestApproval(toolName: string, args: Record<string, any>): Promise<boolean>
  /** Inline per-hunk review for `write_file`/`edit_file`. The UI gets the
   *  full diff and lets the user tick which hunks to accept; we apply
   *  only the accepted ones.
   *
   *  Implementations may fall back to the plain yes/no approval path if
   *  the frontend doesn't support hunk review — in that case return
   *  `{ decision: 'accept_all' }` on yes and `{ decision: 'reject' }` on
   *  no, so the agent can't tell the difference.
   *
   *  Optional so existing test harnesses keep working unchanged. */
  requestHunkReview?(payload: import('./types').HunkReviewPayload): Promise<HunkReviewDecision>
  getConfig(): AppConfig
  getSession(): Session
  saveSession(session: Session): void
  getApiUrl(): string
  getCtxSize(): number
  setCtxSize(n: number): void
  queryActualCtxSize(): Promise<void>
  isCancelRequested(): boolean
  notifyWorkspaceChanged(): void
  /** MCP tool definitions, namespaced `mcp__<slug>__<tool>`. Snapshot from
   *  the main process — we don't refresh mid-run; new servers picked up
   *  on the next message. */
  listMcpToolDefs(): McpToolSnapshot[]
  /** Invoke an MCP tool by qualified name. Rejects if server is down or
   *  the tool isn't registered. */
  callMcpTool(qualifiedName: string, args: Record<string, any>): Promise<string>
}

export type HunkReviewDecision =
  | { decision: 'accept_all' }
  | { decision: 'accept_selected'; selectedHunkIds: number[] }
  | { decision: 'reject' }

/** Snapshot of one MCP tool, shape kept minimal so it crosses worker
 *  boundaries cheaply. */
export interface McpToolSnapshot {
  qualifiedName: string
  description: string
  inputSchema: any
}

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

const FILE_OPS_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'delete_file', 'create_directory'])
const COMMAND_TOOL = 'execute_command'

/** Tools that can mutate the filesystem — these trigger a checkpoint. Shell
 *  commands are included even though many are read-only, because we can't tell
 *  statically whether `rm -rf` is about to hit us next. */
const CHECKPOINT_TRIGGER_TOOLS = new Set<string>([
  ...FILE_OPS_TOOLS,
  COMMAND_TOOL,
])

/** First-token allowlist for shell commands we're confident are readonly. If
 *  the whole command is made of these, we skip the checkpoint — otherwise the
 *  user ends up with a snapshot chip on every `grep`, `ls`, `cat`, etc.,
 *  which is pure visual noise. When in doubt we DO snapshot. */
const READONLY_COMMANDS = new Set<string>([
  'ls', 'll', 'la', 'dir',
  'cat', 'head', 'tail', 'less', 'more', 'nl',
  'wc', 'file', 'stat', 'du', 'df', 'tree',
  'grep', 'egrep', 'fgrep', 'rg', 'ack',
  'find', 'fd', 'locate', 'which', 'whereis', 'type', 'command',
  'pwd', 'whoami', 'id', 'uname', 'hostname', 'date', 'uptime', 'realpath', 'basename', 'dirname',
  'ps', 'env', 'printenv', 'echo', 'printf', 'true', 'false',
  'readlink', 'md5sum', 'sha1sum', 'sha256sum',
  'diff', 'cmp', 'sort', 'uniq', 'awk', 'sed', // sed is only readonly without -i, see below
  'node', 'python', 'python3', 'ruby', // interpreters w/ -e/-c might write; we require no redirects (handled below)
])

/** `git` subcommands that don't mutate working tree or index. */
const READONLY_GIT_SUBCOMMANDS = new Set<string>([
  'status', 'log', 'diff', 'show', 'blame', 'branch', 'remote', 'rev-parse',
  'ls-files', 'ls-tree', 'describe', 'config', 'tag', 'shortlog', 'reflog',
  'cat-file', 'fsck', 'count-objects', 'grep',
])

function looksReadonlyCommand(command: string): boolean {
  const s = (command ?? '').trim()
  if (!s) return true
  // Any redirection, pipe-into-mutating-tool, or command-substitution escape
  // hatch → we can't reason about it safely, assume destructive.
  if (/[>]|<\(|\$\(|`|\btee\b|\bxargs\b|\bmv\b|\brm\b|\bcp\b|\bmkdir\b|\btouch\b|\bln\b|\bchmod\b|\bchown\b|\binstall\b|\bdd\b|\btruncate\b|\brsync\b|\bpip\b|\bnpm\b|\byarn\b|\bpnpm\b|\bmake\b|\bcargo\b|\bgo\s+build\b|\bgo\s+install\b/i.test(s)) {
    return false
  }
  // sed -i mutates in place; plain sed is fine.
  if (/\bsed\b.*\s-i\b/.test(s)) return false
  // Every segment (separated by && / || / ; / |) must be readonly.
  const segments = s.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean)
  return segments.every(segmentIsReadonly)
}

function segmentIsReadonly(seg: string): boolean {
  let s = seg.trim()
  if (!s) return true
  // Strip leading `cd <path>` — pure directory change never writes workspace
  // files. `cd X && rest` is handled by the outer split, but within a single
  // segment we also recognise it in case someone didn't use &&.
  const cdOnly = s.match(/^cd\s+\S+$/)
  if (cdOnly) return true
  const cdThen = s.match(/^cd\s+\S+\s+(.+)$/)
  if (cdThen) s = cdThen[1].trim()

  const head = s.split(/\s+/)[0] ?? ''
  if (!head) return false
  if (head === 'git') {
    const sub = s.split(/\s+/)[1] ?? ''
    return READONLY_GIT_SUBCOMMANDS.has(sub)
  }
  return READONLY_COMMANDS.has(head)
}

/** Take a shadow-git snapshot before a destructive tool runs, so the user
 *  can one-click revert. Any failure is swallowed — checkpoints are a "nice
 *  to have", never a reason to block an actual agent action. */
function maybeCheckpoint(
  toolName: string,
  toolArgs: Record<string, any>,
  workspace: string,
): { sha: string; label: string; timestampMs: number } | undefined {
  if (!CHECKPOINT_TRIGGER_TOOLS.has(toolName)) return undefined
  // Skip pure read-only shell commands (grep/ls/cat/git status/…): nothing to
  // roll back, and users were (rightly) confused by a "restore" chip on a
  // plain `grep`.
  if (toolName === COMMAND_TOOL && looksReadonlyCommand(String(toolArgs?.command ?? ''))) {
    return undefined
  }
  try {
    if (['write_file', 'edit_file', 'append_file', 'delete_file'].includes(toolName) && typeof toolArgs?.path === 'string') {
      captureAgentFileBaseline(workspace, toolArgs.path)
    }
    const cp = createCheckpoint(workspace, describeToolForCheckpoint(toolName, toolArgs))
    if (!cp) return undefined
    return cp
  } catch (e: any) {
    debugLog('CHECKPOINT', `failed before ${toolName}: ${e?.message ?? e}`)
    return undefined
  }
}

/** Ask the user to review a proposed file change hunk by hunk, then apply
 *  only the hunks they approved. Returns the string the agent sees as the
 *  tool result. Errors from the preview (e.g. `edit_file` old_string
 *  missing) short-circuit back to the model unchanged, so the model can
 *  self-correct — exactly like before inline review existed. */
async function reviewAndApplyWrite(
  toolName: 'write_file' | 'edit_file',
  toolArgs: Record<string, any>,
  workspace: string,
  approvalId: string,
): Promise<string> {
  const preview = toolName === 'write_file'
    ? previewWriteFile({ path: String(toolArgs.path ?? ''), content: String(toolArgs.content ?? '') }, workspace)
    : previewEditFile(
        { path: String(toolArgs.path ?? ''), old_string: String(toolArgs.old_string ?? ''), new_string: String(toolArgs.new_string ?? '') },
        workspace,
      )

  if ('error' in preview) return preview.error

  // Zero-change writes: silently accept without bugging the user.
  if (preview.identical) {
    return `No-op: ${preview.path} already has the requested content.`
  }

  const payload: HunkReviewPayload = {
    approvalId,
    toolName,
    filePath: preview.path,
    oldContent: preview.oldContent,
    newContent: preview.newContent,
    hunks: preview.hunks,
    isNewFile: preview.oldContent === null,
  }
  doEmit({ type: 'hunk_review', name: toolName, approvalId, args: toolArgs, hunkReview: payload })

  const decision = await doRequestHunkReview(payload)

  if (decision.decision === 'reject') {
    return `[Denied by user] Operation "${toolName}" was not approved.`
  }

  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const absPath = path.isAbsolute(preview.path) ? preview.path : path.join(workspace, preview.path)

  if (decision.decision === 'accept_all') {
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, preview.newContent)
    } catch (e: any) {
      return `Error: ${e?.message ?? String(e)}`
    }
    return toolName === 'write_file'
      ? `Created ${preview.path} (${preview.newContent.split('\n').length} lines, ${preview.newContent.length} bytes)`
      : `Edited ${preview.path}: replaced via hunk-review (${preview.hunks.length} hunk(s) accepted)`
  }

  // accept_selected
  const selectedIds = decision.selectedHunkIds ?? []
  if (selectedIds.length === 0) {
    return `[Denied by user] No hunks accepted for "${toolName}" on ${preview.path}.`
  }
  const baseText = preview.oldContent ?? ''
  const applied = applySelectedHunks(baseText, preview.hunks, selectedIds)
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, applied)
  } catch (e: any) {
    return `Error: ${e?.message ?? String(e)}`
  }
  const accepted = selectedIds.length
  const total = preview.hunks.length
  return `${toolName === 'write_file' ? 'Wrote' : 'Edited'} ${preview.path}: applied ${accepted}/${total} hunk(s) via review (${applied.split('\n').length} lines, ${applied.length} bytes)`
}

const FALLBACK_CTX_TOKENS = 32768
const SUMMARIZE_TIMEOUT_MS = 60000

let currentBridge: AgentBridge | null = null

/** Dedicated undici dispatcher for the streaming LLM endpoint.
 *
 *  Node 18+ uses undici as its fetch implementation, which defaults to
 *  `headersTimeout = 300s` and `bodyTimeout = 300s`. A cold llama.cpp
 *  server on Vulkan prefilling a 90K-token prompt can take minutes to
 *  send even the FIRST byte of the SSE stream, after which the default
 *  fetch dies with a cryptic `fetch failed` / `UND_ERR_HEADERS_TIMEOUT`.
 *
 *  For this one endpoint we explicitly want "wait as long as it takes":
 *  the user has already been told "this is going to be slow" the moment
 *  they asked a question against a huge context, and our application-
 *  level idle timer inside `streamLlmResponse` is the source of truth
 *  for stall detection (and it only starts ticking after the first byte
 *  arrives). So turn off undici's own impatience here.
 */
const llmStreamDispatcher = new UndiciAgent({
  headersTimeout: 0,      // never give up waiting for the response headers
  bodyTimeout: 0,         // never give up mid-stream either
  keepAliveTimeout: 600_000, // keep the connection warm for reuse across turns
  keepAliveMaxTimeout: 600_000,
  connectTimeout: 10_000, // initial TCP connect can still fail fast
})

function doEmit(e: AgentEvent): void { currentBridge!.emit(e) }
function doRequestApproval(name: string, args: Record<string, any>): Promise<boolean> { return currentBridge!.requestApproval(name, args) }
function doRequestHunkReview(payload: HunkReviewPayload): Promise<HunkReviewDecision> {
  const fn = currentBridge?.requestHunkReview
  if (!fn) {
    // Host doesn't know about hunk review — fall back to a plain approval so
    // the agent flow stays identical to the old "yes/no" world.
    return doRequestApproval(payload.toolName, { path: payload.filePath }).then((ok) =>
      ok ? ({ decision: 'accept_all' } as HunkReviewDecision) : ({ decision: 'reject' } as HunkReviewDecision),
    )
  }
  return fn.call(currentBridge, payload)
}
function doGetConfig(): AppConfig { return currentBridge!.getConfig() }
function doGetSession(): Session { return currentBridge!.getSession() }
function doSaveSession(s: Session): void { currentBridge!.saveSession(s) }
function doGetApiUrl(): string { return currentBridge!.getApiUrl() }
function doGetCtxSize(): number { return currentBridge!.getCtxSize() }
function doSetCtxSize(n: number): void { currentBridge!.setCtxSize(n) }
function doQueryActualCtxSize(): Promise<void> { return currentBridge!.queryActualCtxSize() }
function doIsCancelRequested(): boolean { return currentBridge!.isCancelRequested() }

function getDefaultAgentMode(): AgentMode {
  try {
    return (currentBridge?.getConfig() ?? loadConfig()).defaultMode ?? 'agent'
  } catch {
    return 'agent'
  }
}

function getMaxIterations(): number { return doGetConfig().maxIterations || 200 }
function getBaseTemperature(): number { return doGetConfig().temperature ?? 0.3 }
function getIdleTimeoutMs(): number { return (doGetConfig().idleTimeoutSec || 60) * 1000 }
function getMaxEmptyRetries(): number { return doGetConfig().maxEmptyRetries || 3 }

const LOOP_GUARDED_READONLY_TOOLS = new Set(['read_file', 'list_directory', 'find_files'])
const MAX_IDENTICAL_READONLY_TOOL_CALLS_PER_TURN = 2
const MAX_LOOP_NUDGES_PER_TURN = 3

/** Whether this tool requires user approval given current config (file ops vs commands split). */
function needsApprovalForTool(toolName: string, isCustom: boolean): boolean {
  const cfg = doGetConfig()
  if (isCustom) return (cfg.approvalForFileOps ?? false) || (cfg.approvalForCommands ?? false)
  if (FILE_OPS_TOOLS.has(toolName)) return cfg.approvalForFileOps ?? false
  if (toolName === COMMAND_TOOL) return cfg.approvalForCommands ?? false
  return false
}

// Graduated compression thresholds (fraction of message budget).
//
// These were deliberately tightened in the perf pass: large contexts
// turn prefill latency O(N^2) on the attention side, so keeping the
// typical prompt ~half the window is a much better trade than letting
// it drift toward the emergency ceiling on every turn. With the KV
// cache now actually reused (taskState is no longer baked into the
// system prompt), tier 1/2/3 compaction runs far less often AND costs
// less when it does.
const COMPRESS_TOOL_RESULTS_AT = 0.25
const SUMMARIZE_AT = 0.45
const AGGRESSIVE_PRUNE_AT = 0.65
const EMERGENCY_AT = 0.85

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
    const r = await fetch(`${doGetApiUrl()}/tokenize`, {
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

## Dynamic context discovery

- The initial prompt contains only a compact project index. Pull deeper context on demand instead of assuming it is already loaded.
- Use get_project_context(section="overview") to orient, section="rules" before editing when rule files exist, and get_repo_map/search_code_index/get_symbol_context to jump to likely implementation files.
- Do not repeatedly list/read broad project context if you already have enough evidence. Prefer focused find_files/read_file calls.

## Self-check before final answer

When you changed files, installed dependencies, altered configuration, or affected runtime behavior:
- Before your final visible answer, run the most relevant available checks with execute_command: type-check, lint, tests, build, or a narrower command if the repo clearly has one.
- If a check is too expensive, unavailable, or unsafe, state that explicitly in the final checklist.
- Your final answer must include a short verification checklist with pass/fail/skipped status.
- If checks fail, fix the issue and rerun the relevant check before finalizing whenever possible.

## Tool usage

- **get_project_context / get_repo_map / search_code_index / get_symbol_context**: Dynamically fetch overview, project rules, repo map, symbol search, or focused symbol context only when needed. Prefer this over relying on a huge initial prompt.
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

- If you need scratchpad, keep it brief (max 8 lines) and wrap it in \`<think> ... </think>\`. Never continue private reasoning outside those tags.
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
1. Explore first: get_project_context overview/rules/repo_map as needed, then read_file on key files
2. Search before guessing: find_files with type="content"
3. Read before editing: always read_file first
4. Make targeted edits: use edit_file, not full rewrites
5. Verify: after changes, run relevant tests/linter/type-check/build before final answer

## Rules
- Match existing code style exactly
- Keep changes minimal and focused
- If useful, write a very brief private scratchpad in <think>...</think>; never continue private reasoning outside those tags
- Be concise. Respond in the user's language
- Use tools efficiently — fetch project context dynamically with get_project_context and prefer read_file over execute_command cat
- write_file: max 80 lines per call. For larger files: write skeleton first, then edit_file to fill sections
- Final answer after edits must include a short verification checklist; mark unavailable/expensive checks as skipped with reason
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
  const custom = doGetConfig().systemPrompt
  const base = custom || (ctxTokens() < 16384 ? COMPACT_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT)
  return base + getOsInfo()
}

/** Sentinel marking the ephemeral task-state message so we can find and
 *  replace/strip it in-place without touching anything else. Lives in the
 *  CONTENT of a synthetic user message that sits directly before the
 *  latest real user message — keeping the system prompt and the entire
 *  history stable across turns so llama.cpp's `cache_prompt` KV-cache
 *  actually kicks in.
 *
 *  Historical note: this block used to be appended to the system prompt
 *  directly. That looked clean, but any `update_plan` change would
 *  mutate the first message's tokens and invalidate the whole KV cache —
 *  re-prefilling every tool result, message, and system prompt on every
 *  turn. On long contexts (90K+ tokens) that was minutes of compute. */
const TASK_STATE_BEGIN = '<!--taskstate:begin-->'
const TASK_STATE_END = '<!--taskstate:end-->'

const UPDATE_PROJECT_MEMORY_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'update_project_memory',
    description:
      'Persist an important project-level memory for future sessions: architecture decisions, user/project preferences, known issues, or durable notes. Use sparingly for facts that should survive chat resets.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['decision', 'preference', 'known_issue', 'note'],
          description: 'Kind of memory to store.',
        },
        title: { type: 'string', description: 'Short title.' },
        content: { type: 'string', description: 'Concrete durable detail to remember.' },
      },
      required: ['category', 'title', 'content'],
    },
  },
}

const SAVE_PLAN_ARTIFACT_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'save_plan_artifact',
    description:
      'Save a polished Markdown implementation plan as PLAN.md in the workspace and show it to the user. Use in Plan mode after you have explored the project and called update_plan. This is the only workspace write allowed in Plan mode.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Full Markdown content for PLAN.md. Include headings, implementation steps, risks, verification checklist, and Mermaid diagrams when useful.',
        },
      },
      required: ['content'],
    },
  },
}

function updatePlanToolDefForMode(mode: AgentMode): any {
  if (mode !== 'plan') return UPDATE_PLAN_TOOL_DEF
  const toolDef = JSON.parse(JSON.stringify(UPDATE_PLAN_TOOL_DEF))
  toolDef.function.description =
    'Record DRAFT plan options for user review. In Plan mode this is not execution progress: every implementation step must be pending unless it is genuinely blocked by missing information. Prefer 2-3 planOptions when there are meaningful approaches (quick fix, balanced, robust). Do not mark steps in_progress/completed and do not set selectedPlanOptionId unless the user explicitly chose an option.'
  toolDef.function.parameters.properties.plan.description =
    'Ordered draft steps for the recommended/default option. Replace the whole plan, do not append. In Plan mode, statuses must be pending or blocked only.'
  toolDef.function.parameters.properties.plan.items.properties.status.description =
    'Draft status. In Plan mode use pending for normal steps and blocked only for unresolved questions; never use in_progress or completed.'
  toolDef.function.parameters.properties.planOptions.description =
    '2-3 alternative implementation strategies for user selection. Include a quick/small option, a balanced recommended option, and a robust/architectural option when those trade-offs exist.'
  toolDef.function.parameters.properties.selectedPlanOptionId.description =
    'Only set after the user explicitly chooses an option. Leave empty while drafting choices.'
  return toolDef
}

function taskStateUpdateForMode(args: Record<string, any>, mode: AgentMode): Record<string, any> {
  if (mode !== 'plan') return args
  const next = { ...args }
  if (Array.isArray(args.plan)) {
    next.plan = args.plan.map((step: any): Partial<PlanStep> => ({
      ...step,
      status: step?.status === 'blocked' ? 'blocked' : 'pending',
    }))
  }
  if (Array.isArray(args.planOptions)) {
    next.planOptions = args.planOptions.map((opt: any): Partial<PlanOption> => ({
      ...opt,
      steps: Array.isArray(opt?.steps)
        ? opt.steps.map((step: any): Partial<PlanStep> => ({
          ...step,
          status: step?.status === 'blocked' ? 'blocked' : 'pending',
        }))
        : [],
    }))
  }
  delete next.selectedPlanOptionId
  return {
    ...next,
  }
}

function isTaskStateEphemeral(m: { role: string; content?: string | null }): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(TASK_STATE_BEGIN)
}

function stripOldTaskState(messages: Message[]): void {
  // Remove any legacy in-place blocks from the system prompt (older
  // sessions may still carry them) and drop any stale ephemeral messages.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTaskStateEphemeral(messages[i])) messages.splice(i, 1)
  }
  const sys = messages[0]
  if (sys && sys.role === 'system' && typeof sys.content === 'string' && sys.content.includes(TASK_STATE_BEGIN)) {
    const re = new RegExp(`\\n*${TASK_STATE_BEGIN}[\\s\\S]*?${TASK_STATE_END}\\n*`, 'g')
    const stripped = sys.content.replace(re, '').trimEnd()
    if (stripped !== sys.content) messages[0] = { ...sys, content: stripped }
  }
}

/** Mode-specific instruction block. Rendered into the ephemeral
 *  task-state message (not the system prompt!) so switching mode mid-
 *  session doesn't invalidate the KV cache. Returns '' for agent mode
 *  to avoid adding extra tokens in the default case. */
function renderModeInstruction(mode: AgentMode, lang: 'ru' | 'en'): string {
  if (mode === 'agent') return ''
  if (mode === 'chat') {
    return lang === 'ru'
      ? '## Режим: Chat (обсуждение)\n\nТы в режиме обсуждения. Инструменты отключены: ты не можешь читать или менять файлы, запускать команды, искать в интернете. Отвечай текстом — объясняй, анализируй, предлагай варианты. Если задача требует действий над проектом, предложи пользователю переключиться в режим Plan (для исследования) или Agent (для выполнения).'
      : '## Mode: Chat (discussion)\n\nYou are in discussion mode. All tools are disabled: you cannot read or modify files, run commands, or search the web. Respond with text only — explain, analyse, offer options. If the task needs hands-on actions, suggest the user switch to Plan mode (for exploration) or Agent mode (for execution).'
  }
  // plan
  return lang === 'ru'
    ? `## Режим: Plan (планирование, только чтение)

Ты в режиме планирования. Это отдельный этап согласования, а не начало выполнения. Доступны только инструменты исследования и планирования: get_project_context, get_repo_map, search_code_index, get_symbol_context, read_file, list_directory, find_files, fetch_url, search_web, recall, update_plan, save_plan_artifact.

Писать/редактировать исходные файлы, запускать команды и выполнять шаги плана ЗАПРЕЩЕНО. Plan-режим должен вести себя как продвинутый planning-агент: уточнить требования, изучить проект, предложить план, обсудить корректировки и ждать явного подтверждения пользователя.

Обязательный процесс:
1. Исследуй проект read-only инструментами. Не отвечай "на глаз", если можно проверить файлы.
2. Если задача неоднозначна или есть важные развилки, задай 1-3 уточняющих вопроса и остановись. Не создавай финальный план через догадки.
3. Если есть несколько разумных подходов, вызови update_plan с 2-3 "planOptions": быстрый/минимальный, сбалансированный рекомендованный, и надёжный/архитектурный. У каждого варианта должны быть summary, tradeoffs, risk, effort, likely files, tests и steps.
4. Также заполни "plan" шагами выбранного тобой рекомендуемого варианта, чтобы старый UI и Agent имели дефолтный путь. Все обычные шаги в Plan-режиме должны быть pending; используй blocked только для открытых вопросов. Никогда не ставь in_progress/completed в Plan-режиме и не выставляй selectedPlanOptionId без выбора пользователя.
5. Сохрани полноценный Markdown-план через save_plan_artifact — это создаст/обновит PLAN.md и автоматически покажет его пользователю.
6. Markdown PLAN.md должен быть именно проектом плана на согласование и включать:
   - "Цель"
   - "Что известно из проекта"
   - "Открытые вопросы / предположения"
   - "Варианты исполнения" с 2-3 стратегиями, плюсами/минусами, риском и трудоёмкостью
   - "Архитектура / поток" с Mermaid-диаграммой, если есть процесс/компоненты
   - "Пошаговый план реализации"
   - "Файлы и зоны изменений"
   - "Риски и неизвестные"
   - "План проверки / тесты"
   - "Критерии готовности"
7. Диаграммы пиши в fenced-блоках mermaid. Если диаграмма неуместна, явно напиши почему.
8. Заверши фразой: «План сохранён в PLAN.md и ожидает подтверждения. Выберите вариант исполнения, обсудите правки или нажмите «Выполнить план», чтобы переключиться в режим Agent».

НЕ начинай выполнять шаги плана, НЕ отмечай прогресс выполнения и НЕ переходи в Agent сам. Это сделает приложение только после явного подтверждения пользователя.`
    : `## Mode: Plan (read-only planning)

You are in planning mode. This is an approval/discussion stage, not execution. Only research and planning tools are available: get_project_context, get_repo_map, search_code_index, get_symbol_context, read_file, list_directory, find_files, fetch_url, search_web, recall, update_plan, save_plan_artifact.

Writing/editing source files, running commands, and executing plan steps is FORBIDDEN. Plan mode should behave like an advanced planning agent: clarify requirements, inspect the project, propose a plan, discuss revisions, and wait for explicit user approval.

Required process:
1. Explore the project with read-only tools. Do not answer from vibes when files can be inspected.
2. If the task is ambiguous or has important forks, ask 1-3 clarifying questions and stop. Do not create a final plan by guessing.
3. If there are multiple reasonable approaches, call update_plan with 2-3 "planOptions": a quick/minimal option, a balanced recommended option, and a robust/architectural option. Each option needs summary, tradeoffs, risk, effort, likely files, tests, and steps.
4. Also fill "plan" with the steps of your recommended/default option so legacy UI and Agent have a default path. In Plan mode all normal steps must be pending; use blocked only for open questions. Never set in_progress/completed and never set selectedPlanOptionId without the user choosing an option.
5. Save the full Markdown plan via save_plan_artifact — this creates/updates PLAN.md and automatically shows it to the user.
6. PLAN.md must be a draft for approval and include:
   - "Goal"
   - "What is known from the project"
   - "Open questions / assumptions"
   - "Execution options" with 2-3 strategies, pros/cons, risk, and effort
   - "Architecture / flow" with a Mermaid diagram when components or process exist
   - "Implementation steps"
   - "Files and change areas"
   - "Risks and unknowns"
   - "Verification / tests"
   - "Done criteria"
7. Write diagrams in fenced mermaid blocks. If a diagram is not appropriate, say why.
8. End with: "Plan saved to PLAN.md and awaiting approval. Choose an execution option, discuss revisions, or press 'Apply plan' to switch to Agent mode."

Do NOT start executing plan steps, do NOT mark execution progress, and do NOT switch to Agent yourself. The app will do that only after explicit user approval.`
}

function renderProjectMemoryForPrompt(workspace: string, lang: 'ru' | 'en'): string {
  const memory = projectMemory.readProjectMemory(workspace)
  if (!memory) return ''
  return lang === 'ru'
    ? `## Память проекта\n\nЭто долговременная память по текущему workspace: архитектурные решения, предпочтения и известные проблемы. Учитывай её, но если она конфликтует с текущим кодом или прямым запросом пользователя — проверь файлы и следуй более свежему источнику.\n\n${memory}`
    : `## Project Memory\n\nThis is long-term memory for the current workspace: architecture decisions, preferences, and known issues. Use it, but if it conflicts with current code or the user's direct request, inspect files and follow the fresher source.\n\n${memory}`
}

/** Build a NEW message array with the current taskState AND mode
 *  instruction inserted as an ephemeral user message right before the
 *  latest real user turn. The source array (and session.messages) is
 *  never mutated — this keeps the persisted history clean and lets us
 *  regenerate the note per turn without worrying about stale copies.
 *
 *  Also strips any legacy taskState block that older sessions may have
 *  embedded directly in the system prompt. */
function withTaskStateEphemeral(messages: Message[], session: Session): Message[] {
  if (!messages.length) return messages
  let out = messages

  // 1. Strip legacy in-system-prompt block (migration for old sessions).
  const sys = out[0]
  if (sys && sys.role === 'system' && typeof sys.content === 'string' && sys.content.includes(TASK_STATE_BEGIN)) {
    const re = new RegExp(`\\n*${TASK_STATE_BEGIN}[\\s\\S]*?${TASK_STATE_END}\\n*`, 'g')
    const stripped = sys.content.replace(re, '').trimEnd()
    if (stripped !== sys.content) {
      out = [{ ...sys, content: stripped }, ...out.slice(1)]
    }
  }

  // 2. Drop any ephemeral left over from a previous call (defensive — we
  //    never persist them, so in practice there won't be any).
  if (out.some(isTaskStateEphemeral)) {
    out = out.filter((m) => !isTaskStateEphemeral(m))
  }

  const lang: 'ru' | 'en' = (doGetConfig().appLanguage === 'en' ? 'en' : 'ru')
  const mode: AgentMode = session.mode ?? getDefaultAgentMode()
  const modeText = renderModeInstruction(mode, lang)
  const memoryText = renderProjectMemoryForPrompt(workspace, lang)
  const taskText = renderTaskStateForPrompt(session.taskState, lang)

  // If there's nothing to say (agent mode + empty taskState), keep the
  // prompt minimal to maximise KV-cache reuse.
  if (!modeText && !memoryText && !taskText) return out

  const body = [modeText, memoryText, taskText].filter(Boolean).join('\n\n')
  // Use role=user — every chat template handles user messages; a
  // mid-conversation second system message trips some jinja templates.
  const ephemeral: Message = {
    role: 'user',
    content: `${TASK_STATE_BEGIN}\n${body}\n${TASK_STATE_END}`,
  }

  // Find the last *real* user message (skip compaction prologue). Drop
  // the ephemeral IMMEDIATELY before it, so everything earlier — system
  // prompt, compacted summary, all older turns — stays byte-identical
  // across turns. That's what lets llama.cpp's `cache_prompt` reuse the
  // huge prefix KV instead of re-prefilling tens of thousands of tokens.
  let insertAt = out.length
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role === 'user' && !isCompactionPrologue(m)) {
      insertAt = i
      break
    }
  }
  const next = out.slice()
  next.splice(insertAt, 0, ephemeral)
  return next
}

// Legacy name kept as an alias for a one-shot compat shim during the
// refactor — intentionally NOT used anywhere. All call-sites now go
// through `withTaskStateEphemeral`.
function refreshSystemPromptWithTaskState(_messages: Message[], _session: Session): void {
  // no-op — kept to preserve the symbol in case of external references.
  void _messages; void _session; void stripOldTaskState
}

function getSummarizePrompt(): string {
  return doGetConfig().summarizePrompt || DEFAULT_SUMMARIZE_PROMPT
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

/** Names of the built-in tools that are safe to expose in `plan` mode:
 *  they read the workspace or the web, but never mutate files, run
 *  commands, or call out to write-capable APIs. Kept narrow by design —
 *  when in doubt, omit, and let the user switch to `agent` mode. */
const PLAN_MODE_BUILTIN_ALLOWLIST = new Set([
  'get_project_context',
  'get_repo_map',
  'search_code_index',
  'get_symbol_context',
  'read_file',
  'list_directory',
  'find_files',
  'search_web',
  'fetch_url',
])

function getAllTools(mode: AgentMode = 'agent'): any[] {
  // In `chat` mode we strip all tools. The model becomes a plain
  // chatbot — faster prefill (no tool defs in the prompt), zero risk of
  // accidental writes, and the jinja template still works because
  // llama-server treats an empty tools array as "no tool calls".
  if (mode === 'chat') return []

  const cfg = doGetConfig()
  const customTools = cfg.customTools.filter((t) => t.enabled)
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
  const builtins = getBuiltinToolDefinitions(cfg)

  // MCP tools: whatever the main-process MCP manager has discovered from
  // currently-connected servers, exposed to the LLM as `mcp__<slug>__<tool>`.
  // Descriptions are tagged with a "[MCP: server]" prefix so the model knows
  // these are user-provisioned integrations — empirically this nudges
  // smaller models to use them more intentionally.
  const mcpDefs = currentBridge!.listMcpToolDefs().map((t) => ({
    type: 'function',
    function: {
      name: t.qualifiedName,
      description: t.description || `MCP tool: ${t.qualifiedName}`,
      parameters: t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} },
    },
  }))

  let all = [...builtins, updatePlanToolDefForMode(mode), SAVE_PLAN_ARTIFACT_TOOL_DEF, UPDATE_PROJECT_MEMORY_TOOL_DEF, RECALL_TOOL_DEF, ...customDefs, ...mcpDefs]

  if (mode === 'plan') {
      // Plan mode: keep the read-only builtins, drop every custom and MCP
      // tool (we can't reason about their side effects), keep
      // `save_plan_artifact` is the one allowed write in plan mode: it can
      // only create/update PLAN.md. This is the set advertised to the LLM; the
    // tool dispatcher additionally double-checks at call time so a
    // jailbroken prompt can't slip past the allowlist.
    all = all.filter((t) => {
      const name = t?.function?.name
      if (!name) return false
      if (name === 'update_plan' || name === 'save_plan_artifact' || name === 'recall') return true
      return PLAN_MODE_BUILTIN_ALLOWLIST.has(name)
    })
  }

  // On small contexts, use compact descriptions to save ~40% tool overhead
  return ctxTokens() < 16384 ? compactToolDefs(all) : all
}

/** Runtime guard used by the tool dispatcher. Returns `true` iff a tool
 *  with the given name is allowed to execute under the current mode. In
 *  `chat` mode nothing is; in `plan` only the allowlist (plus
 *  update_plan/recall); in `agent` everything is allowed. Kept in sync
 *  with `getAllTools` but applied defensively because the LLM may still
 *  try to call a tool that it "remembers" from a previous turn or a
 *  prompt injection. */
function isToolAllowedInMode(name: string, mode: AgentMode): boolean {
  if (mode === 'agent') return true
  if (mode === 'chat') return false
  // plan
  if (name === 'update_plan' || name === 'save_plan_artifact' || name === 'recall') return true
  return PLAN_MODE_BUILTIN_ALLOWLIST.has(name)
}

function isMcpTool(name: string): boolean {
  return typeof name === 'string' && name.startsWith('mcp__')
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
  /** Per-session operating mode (chat/plan/agent). Defaults to
   *  `config.defaultMode` on new sessions. Sent to the UI so the sidebar
   *  can tag each chat and so the mode switcher knows what to pre-select. */
  mode?: AgentMode
}

export interface Session {
  id: string
  title: string
  messages: Message[]
  uiMessages: any[]
  projectContextAdded: boolean
  createdAt: number
  updatedAt: number
  /** Workspace key (hash) so we know which folder to save to when updating from worker. */
  workspaceKey?: string
  /** Persistent task state — goal / plan / notes. Surfaced in the system
   *  prompt so the agent never forgets what it was doing. See task-state.ts. */
  taskState?: TaskState
  /** Message ids that the user has "pinned" — these survive compaction
   *  and summarisation. Keyed by the `id` we attach to UI messages. */
  pinnedMessageIds?: string[]
  /** Operating mode (chat/plan/agent). Undefined means "use the app
   *  default" — we normalise that to a concrete value the moment it
   *  matters. See `AgentMode` in types.ts. */
  mode?: AgentMode
}

// ---------------------------------------------------------------------------
// Session storage (per-workspace: each project has its own chats)
// ---------------------------------------------------------------------------

const BASE_SESSIONS_DIR = path.join(os.homedir(), '.one-click-agent', 'sessions')
const ACTIVE_FILE = '_active.json'

/** Stable key for workspace so sessions are stored in their own folder. */
function getWorkspaceKey(ws: string): string {
  if (!ws || !ws.trim()) return '_empty'
  const normalized = path.normalize(ws).trim()
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function sessionsDir(ws: string): string {
  const d = path.join(BASE_SESSIONS_DIR, getWorkspaceKey(ws))
  fs.mkdirSync(d, { recursive: true })
  return d
}

function sessionFilePath(ws: string, id: string): string {
  return path.join(sessionsDir(ws), `${id}.json`)
}

/** In-memory: sessions per workspace (workspaceKey -> Map<sessionId, Session>). */
const sessionsByWorkspace = new Map<string, Map<string, Session>>()
/** Active session id per workspace (workspaceKey -> sessionId). */
const activeIdByWorkspace = new Map<string, string>()

let workspace = ''
let currentAbort: AbortController | null = null
let cancelRequested = false

function getSessionsMap(ws: string): Map<string, Session> {
  const key = getWorkspaceKey(ws)
  if (!sessionsByWorkspace.has(key)) {
    sessionsByWorkspace.set(key, new Map())
  }
  return sessionsByWorkspace.get(key)!
}

function loadSessionsForWorkspace(ws: string): void {
  if (!ws || !ws.trim()) return
  const key = getWorkspaceKey(ws)
  if (sessionsByWorkspace.has(key)) return
  const map = new Map<string, Session>()
  sessionsByWorkspace.set(key, map)
  try {
    const dir = sessionsDir(ws)
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json') && f !== ACTIVE_FILE)
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
        const data = JSON.parse(raw)
        if (data.id && Array.isArray(data.messages)) {
          const session: Session = {
            id: data.id,
            title: data.title ?? 'Без названия',
            messages: data.messages,
            uiMessages: data.uiMessages ?? [],
            projectContextAdded: data.projectContextAdded ?? false,
            createdAt: data.createdAt ?? Date.now(),
            updatedAt: data.updatedAt ?? Date.now(),
            workspaceKey: key,
            taskState: data.taskState && typeof data.taskState === 'object' ? data.taskState : undefined,
            pinnedMessageIds: Array.isArray(data.pinnedMessageIds) ? data.pinnedMessageIds : [],
            mode: (data.mode === 'chat' || data.mode === 'plan' || data.mode === 'agent') ? data.mode : undefined,
          }
          map.set(session.id, session)
        }
      } catch {}
    }
    const activePath = path.join(dir, ACTIVE_FILE)
    if (fs.existsSync(activePath)) {
      const activeRaw = fs.readFileSync(activePath, 'utf-8')
      const activeData = JSON.parse(activeRaw)
      if (typeof activeData?.activeSessionId === 'string' && map.has(activeData.activeSessionId)) {
        activeIdByWorkspace.set(key, activeData.activeSessionId)
      }
    }
  } catch {}
}

function saveActiveId(ws: string): void {
  if (!ws?.trim()) return
  const key = getWorkspaceKey(ws)
  const activeId = activeIdByWorkspace.get(key) ?? null
  try {
    const dir = sessionsDir(ws)
    fs.writeFileSync(path.join(dir, ACTIVE_FILE), JSON.stringify({ activeSessionId: activeId }), 'utf-8')
  } catch {}
}

export function saveSession(session: Session): void {
  const key = session.workspaceKey ?? getWorkspaceKey(workspace)
  try {
    const dir = path.join(BASE_SESSIONS_DIR, key)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify({
      id: session.id,
      title: session.title,
      messages: session.messages,
      uiMessages: session.uiMessages,
      projectContextAdded: session.projectContextAdded,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      workspaceKey: session.workspaceKey ?? key,
      taskState: session.taskState,
      pinnedMessageIds: session.pinnedMessageIds ?? [],
      mode: session.mode,
    }), 'utf-8')
  } catch {}
}

function deleteSessionFile(ws: string, id: string): void {
  try { fs.unlinkSync(sessionFilePath(ws, id)) } catch {}
}

function generateSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function titleFromMessage(text: string): string {
  const clean = text.replace(/```[\s\S]*?```/g, '').replace(/\[.*?\]/g, '').trim()
  const firstLine = clean.split('\n')[0] ?? ''
  return firstLine.length > 50 ? firstLine.slice(0, 47) + '…' : firstLine || 'Новый чат'
}

/** Path where main process writes session for worker (same layout as our storage). */
export function getSessionPathForWorker(ws: string, sessionId: string): string {
  return sessionFilePath(ws, sessionId)
}

export function getActiveSession(ws: string): Session {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  const map = getSessionsMap(ws)
  const activeId = activeIdByWorkspace.get(key)
  if (activeId && map.has(activeId)) {
    return map.get(activeId)!
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
    workspaceKey: key,
    mode: getDefaultAgentMode(),
  }
  map.set(id, session)
  activeIdByWorkspace.set(key, id)
  saveSession(session)
  saveActiveId(ws)
  return session
}

export function getSessionById(ws: string, id: string): Session | null {
  loadSessionsForWorkspace(ws)
  return getSessionsMap(ws).get(id) ?? null
}

// ---------------------------------------------------------------------------
// Public session management (all take workspace)
// ---------------------------------------------------------------------------

export function createSession(ws: string): string {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  const map = getSessionsMap(ws)
  const id = generateSessionId()
  const session: Session = {
    id,
    title: 'Новый чат',
    messages: [],
    uiMessages: [],
    projectContextAdded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspaceKey: key,
    mode: getDefaultAgentMode(),
  }
  map.set(id, session)
  activeIdByWorkspace.set(key, id)
  saveSession(session)
  saveActiveId(ws)
  return id
}

export function switchSession(ws: string, id: string): boolean {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  const map = getSessionsMap(ws)
  if (!map.has(id)) return false
  activeIdByWorkspace.set(key, id)
  saveActiveId(ws)
  return true
}

export function listSessions(ws: string): SessionInfo[] {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  return [...map.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.filter((m) => m.role === 'user').length,
      mode: s.mode,
    }))
}

/** Update the operating mode of a session (chat/plan/agent). Returns
 *  the new mode. Safe to call while the agent is idle; if a request is
 *  in flight the change will take effect on the next turn because the
 *  system prompt is rebuilt at the top of each iteration. */
export function setSessionMode(ws: string, id: string, mode: AgentMode): AgentMode {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  const session = map.get(id)
  if (!session) return mode
  session.mode = mode
  session.updatedAt = Date.now()
  saveSession(session)
  return mode
}

export function selectPlanOption(ws: string, id: string, optionId: string): TaskState | null {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  const session = map.get(id)
  if (!session) return null
  const prev = normalizeTaskState(session.taskState) ?? emptyTaskState()
  const selected = prev.planOptions?.find((opt) => opt.id === optionId)
  if (!selected) return prev
  const { next } = applyTaskStateUpdate(prev, {
    selectedPlanOptionId: selected.id,
    plan: selected.steps,
  })
  session.taskState = next
  session.updatedAt = Date.now()
  saveSession(session)
  return next
}

function renderPlanArtifact(session: Session): string {
  const ts = normalizeTaskState(session.taskState) ?? emptyTaskState()
  const goal = ts.goal?.trim() || session.title || 'Implementation plan'
  const plan = Array.isArray(ts.plan) ? ts.plan : []
  const lines: string[] = [
    '# PLAN',
    '',
    '## Goal',
    '',
    goal,
    '',
    '## Task State',
    '',
  ]
  if (plan.length > 0) {
    lines.push(...plan.map((step, idx) => {
      const status = step.status ?? 'pending'
      const note = step.note ? `\n  - Note: ${step.note}` : ''
      return `${idx + 1}. [${status}] ${step.title}${note}`
    }))
  } else {
    lines.push('- No structured plan steps recorded yet.')
  }
  if (ts.planOptions?.length) {
    lines.push('', '## Execution Options', '')
    for (const opt of ts.planOptions) {
      const badges = [
        opt.id === ts.selectedPlanOptionId ? 'selected' : '',
        opt.recommended ? 'recommended' : '',
        opt.risk ? `risk: ${opt.risk}` : '',
        opt.effort ? `effort: ${opt.effort}` : '',
      ].filter(Boolean).join(', ')
      lines.push(`### ${opt.title}${badges ? ` (${badges})` : ''}`)
      lines.push('', opt.summary)
      if (opt.tradeoffs) lines.push('', `Trade-offs: ${opt.tradeoffs}`)
      if (opt.files?.length) lines.push('', 'Likely files / areas:', ...opt.files.map((f) => `- ${f}`))
      if (opt.tests?.length) lines.push('', 'Verification:', ...opt.tests.map((t) => `- ${t}`))
      if (opt.steps.length) {
        lines.push('', 'Steps:')
        lines.push(...opt.steps.map((step, idx) => `${idx + 1}. ${step.title}${step.note ? ` — ${step.note}` : ''}`))
      }
      lines.push('')
    }
  }
  lines.push(
    '',
    '## Notes',
    '',
    ts.notes?.trim() || '- No notes recorded.',
    '',
    '## Flow',
    '',
    '```mermaid',
    'flowchart TD',
    '  A[Plan saved] --> B[Apply plan]',
    '  B --> C[Agent executes steps]',
    '  C --> D[Run verification]',
    '  D --> E[Final checklist]',
    '```',
    '',
    '## Verification Checklist',
    '',
    '- [ ] Relevant tests selected',
    '- [ ] Type-check/lint/build run where applicable',
    '- [ ] Risks reviewed',
    '- [ ] Done criteria satisfied',
    '',
  )
  return lines.join('\n')
}

export function savePlanArtifact(ws: string, id?: string): { path: string; content: string } {
  if (!ws?.trim()) throw new Error('Workspace is required')
  loadSessionsForWorkspace(ws)
  const session = id ? getSessionsMap(ws).get(id) : getActiveSession(ws)
  if (!session) throw new Error('Session not found')
  const content = renderPlanArtifact(session)
  const file = path.join(ws, 'PLAN.md')
  fs.writeFileSync(file, content, 'utf-8')
  return { path: file, content }
}

export function savePlanArtifactContent(ws: string, content: string): { path: string; content: string } {
  if (!ws?.trim()) throw new Error('Workspace is required')
  const trimmed = String(content ?? '').trim()
  if (!trimmed) throw new Error('PLAN.md content is required')
  const file = path.join(ws, 'PLAN.md')
  fs.writeFileSync(file, trimmed.endsWith('\n') ? trimmed : trimmed + '\n', 'utf-8')
  return { path: file, content: trimmed }
}

export function deleteSession(ws: string, id: string): void {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  const map = getSessionsMap(ws)
  map.delete(id)
  deleteSessionFile(ws, id)
  try { archive.deleteArchive(key, id) } catch {}
  if (activeIdByWorkspace.get(key) === id) {
    const first = map.keys().next().value
    if (first) activeIdByWorkspace.set(key, first)
    else activeIdByWorkspace.delete(key)
    saveActiveId(ws)
  }
}

export function renameSession(ws: string, id: string, title: string): void {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  const session = map.get(id)
  if (session) {
    session.title = title
    saveSession(session)
  }
}

export function getActiveSessionId(ws: string): string | null {
  loadSessionsForWorkspace(ws)
  const key = getWorkspaceKey(ws)
  return activeIdByWorkspace.get(key) ?? null
}

// Debounced session persist so main process doesn't block on every tool call
let pendingSessionPersist: Session | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 1000

function flushSessionPersist(): void {
  if (pendingSessionPersist) {
    const s = pendingSessionPersist
    pendingSessionPersist = null
    saveSession(s)
  }
  persistTimer = null
}

/** Called from main when worker sends session-update. In-memory update + debounced disk write. */
export function updateSessionFromWorker(session: Session, immediate = false): void {
  const key = session.workspaceKey ?? getWorkspaceKey(workspace)
  const map = sessionsByWorkspace.get(key)
  if (map) map.set(session.id, session)
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = null
    pendingSessionPersist = session
    flushSessionPersist()
  } else {
    pendingSessionPersist = session
    if (!persistTimer) persistTimer = setTimeout(flushSessionPersist, PERSIST_DEBOUNCE_MS)
  }
}

export function saveUiMessages(ws: string, id: string, uiMsgs: any[]): void {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  const session = map.get(id)
  if (session) {
    session.uiMessages = uiMsgs
    saveSession(session)
  }
}

export function getUiMessages(ws: string, id: string): any[] {
  loadSessionsForWorkspace(ws)
  const map = getSessionsMap(ws)
  return map.get(id)?.uiMessages ?? []
}

export function initSessions(): void {
  fs.mkdirSync(BASE_SESSIONS_DIR, { recursive: true })
}

function emitContextUsage(msgs: Message[]) {
  const used = estimateContextTokens(msgs)
  const budget = getMessageBudget()
  const maxCtx = ctxTokens()
  const pct = Math.round((used / budget) * 100)
  doEmit({
    type: 'context_usage',
    contextUsage: { usedTokens: used, budgetTokens: budget, maxContextTokens: maxCtx, percent: Math.min(pct, 100) },
  })
}

export interface ContextBreakdown {
  usedTokens: number
  budgetTokens: number
  maxContextTokens: number
  percent: number
  categories: Array<{ key: string; label: string; tokens: number; messages: number }>
  cache: { hits: number; misses: number; size: number }
}

/** Produce a per-category breakdown of what's currently eating context.
 *  Used by the /context slash command and the Context meter tooltip. */
export function computeContextBreakdown(ws: string): ContextBreakdown {
  const session = getActiveSession(ws)
  const msgs = session.messages ?? []
  const budget = getMessageBudget()
  const maxCtx = ctxTokens()
  const used = estimateContextTokens(msgs)

  const cats: Record<string, { label: string; tokens: number; messages: number }> = {
    system: { label: 'System prompt', tokens: 0, messages: 0 },
    prologue: { label: 'Compacted prologue', tokens: 0, messages: 0 },
    user: { label: 'User messages', tokens: 0, messages: 0 },
    assistant: { label: 'Assistant replies', tokens: 0, messages: 0 },
    thinking: { label: 'Assistant thinking (<think>)', tokens: 0, messages: 0 },
    tool: { label: 'Tool results', tokens: 0, messages: 0 },
    tool_calls: { label: 'Tool call requests', tokens: 0, messages: 0 },
  }
  const ratio = calibratedRatio
  const tok = (s: string | undefined) => (s ? Math.ceil((s?.length ?? 0) / ratio) : 0)

  for (const m of msgs) {
    if (m.role === 'system') {
      cats.system.tokens += tok(m.content)
      cats.system.messages++
    } else if (isCompactionPrologue(m as any)) {
      cats.prologue.tokens += tok(m.content)
      cats.prologue.messages++
    } else if (m.role === 'user') {
      cats.user.tokens += tok(m.content)
      cats.user.messages++
    } else if (m.role === 'assistant') {
      const c = m.content ?? ''
      const thinkMatches = [...c.matchAll(/<think>([\s\S]*?)<\/think>/g)]
      let thinkChars = 0
      for (const mm of thinkMatches) thinkChars += (mm[1]?.length ?? 0)
      cats.thinking.tokens += Math.ceil(thinkChars / ratio)
      cats.assistant.tokens += Math.max(0, tok(c) - Math.ceil(thinkChars / ratio))
      cats.assistant.messages++
      if (m.tool_calls) {
        cats.tool_calls.tokens += Math.ceil(JSON.stringify(m.tool_calls).length / ratio)
      }
    } else if (m.role === 'tool') {
      cats.tool.tokens += tok(m.content)
      cats.tool.messages++
    }
  }

  return {
    usedTokens: used,
    budgetTokens: budget,
    maxContextTokens: maxCtx,
    percent: Math.min(100, Math.round((used / budget) * 100)),
    categories: Object.entries(cats)
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.tokens - a.tokens),
    cache: toolCache.getStats(),
  }
}

/** Toggle "pinned" status for an assistant/user message (by its uiMessage
 *  id). Pinned messages are protected from compaction/summarisation. */
export function toggleMessagePin(ws: string, messageId: string): boolean {
  const session = getActiveSession(ws)
  const set = new Set(session.pinnedMessageIds ?? [])
  let pinned: boolean
  if (set.has(messageId)) { set.delete(messageId); pinned = false }
  else { set.add(messageId); pinned = true }
  session.pinnedMessageIds = [...set]
  session.updatedAt = Date.now()
  saveSession(session)
  return pinned
}

export function listPinnedMessages(ws: string): string[] {
  const session = getActiveSession(ws)
  return [...(session.pinnedMessageIds ?? [])]
}

const FINAL_ANSWER_MARKER_RE = /(?:^|\n)\s*(?:final answer|final|answer|ответ|итог|результат|кратко)\s*[:：]\s*/i
const REASONING_LEAK_START_RE = /^\s*(?:the user (?:wants|asked|asks|is asking|said|provided)|user wants|i need to|i should|let me|we need to|actually,|wait,|first, i need|the task is|пользователь (?:хочет|просит|сказал|уточнил)|мне нужно сначала|я должен|сначала я|давайте я подумаю)/i

function splitReasoningLeak(text: string): { thinking: string; visible: string; leaked: boolean; open: boolean } {
  const trimmed = text.trim()
  if (!trimmed || !REASONING_LEAK_START_RE.test(trimmed)) {
    return { thinking: '', visible: text.trim(), leaked: false, open: false }
  }

  const marker = FINAL_ANSWER_MARKER_RE.exec(trimmed)
  if (marker && marker.index > 0) {
    return {
      thinking: trimmed.slice(0, marker.index).trim(),
      visible: trimmed.slice(marker.index + marker[0].length).trim(),
      leaked: true,
      open: false,
    }
  }

  return { thinking: trimmed, visible: '', leaked: true, open: true }
}

function extractThinking(content: string): [string, string] {
  let thinking = ''
  let visible = content
  const re = /<think>([\s\S]*?)<\/think>/g
  let match
  while ((match = re.exec(content)) !== null) {
    thinking += (thinking ? '\n' : '') + match[1].trim()
  }
  visible = content.replace(re, '')
  if (hasOpenThinkingBlock(visible)) {
    const openIdx = visible.lastIndexOf('<think>')
    thinking += (thinking ? '\n' : '') + visible.slice(openIdx + 7).trim()
    visible = visible.slice(0, openIdx)
  }
  const leak = splitReasoningLeak(visible)
  if (leak.leaked) thinking += (thinking ? '\n' : '') + leak.thinking
  visible = leak.visible
  return [thinking, visible]
}

function hasOpenThinkingBlock(content: string): boolean {
  return content.lastIndexOf('<think>') > content.lastIndexOf('</think>')
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
  if (openIdx === -1) {
    const leak = splitReasoningLeak(content)
    return {
      thinking: leak.thinking,
      visible: leak.visible,
      thinkingDone: !leak.open,
    }
  }

  const closeIdx = content.indexOf('</think>')
  if (closeIdx === -1) {
    return {
      thinking: content.slice(openIdx + 7).trim(),
      visible: content.slice(0, openIdx).trim(),
      thinkingDone: false,
    }
  }

  let thinking = content.slice(openIdx + 7, closeIdx).trim()
  const visibleCandidate = (content.slice(0, openIdx) + content.slice(closeIdx + 8)).trim()
  const leak = splitReasoningLeak(visibleCandidate)
  if (leak.leaked) thinking += (thinking ? '\n' : '') + leak.thinking
  return { thinking, visible: leak.visible, thinkingDone: !leak.open }
}

interface StreamResult {
  content: string
  toolCalls: any[] | undefined
  rawToolCalls: any[] | undefined
  finishReason: string | null
  elapsedMs: number
  estimatedOutputTokens: number
}

async function streamLlmResponse(
  apiUrl: string,
  msgs: Message[],
  fullResponseSoFar: string,
  signal: AbortSignal,
  maxTokensOverride?: number,
  temperatureOverride?: number,
  mode: AgentMode = 'agent',
): Promise<StreamResult> {
  const throwIfAborted = () => {
    if (signal.aborted || doIsCancelRequested()) {
      throw new DOMException('Aborted', 'AbortError')
    }
  }
  throwIfAborted()

  const cleanMsgs = sanitizeMessages(msgs)
  const maxTok = (maxTokensOverride && maxTokensOverride > 0) ? maxTokensOverride : getMaxResponseTokens()
  const temp = temperatureOverride ?? getBaseTemperature()
  const msgRoles = cleanMsgs.map((m) => m.role + (m.tool_calls ? `(${m.tool_calls.length}tc)` : '')).join(', ')
  debugLog('STREAM', `Sending request: ${cleanMsgs.length} msgs [${msgRoles}], max_tokens=${maxTok}, temp=${temp}, ctx=${ctxTokens()}, budget=${getMessageBudget()}, used=${estimateContextTokens(cleanMsgs)}`)

  const startMs = Date.now()
  // NOTE: we use undici's fetch with a custom dispatcher that disables
  // `headersTimeout` / `bodyTimeout`. Prefill on huge contexts can take
  // minutes before the server emits the first byte; the default 300s
  // undici timeout would otherwise kill the connection with a cryptic
  // "fetch failed" and the user would see a stack trace instead of a
  // working response. Our application-level idle timer (below) is the
  // sole authority for stall detection, and it only starts counting
  // AFTER the first chunk arrives.
  // We go through the global fetch (which IS undici in Node 18+), but
  // pass our custom dispatcher via init. In tests, `globalThis.fetch` is
  // stubbed by the harness and the dispatcher is harmlessly ignored.
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen',
      messages: cleanMsgs,
      tools: getAllTools(mode),
      // In chat mode we explicitly forbid tool calls (belt + suspenders
      // on top of sending no tool defs at all).
      tool_choice: mode === 'chat' ? 'none' : 'auto',
      temperature: temp,
      max_tokens: maxTok,
      stream: true,
      // llama.cpp-specific: tell the server to keep the prompt prefix in the
      // KV cache across requests. When the conversation grows by appending,
      // this lets the server reuse the cached prefix and prefill only the
      // new suffix — big latency win, especially on long contexts. Ignored
      // by non-llama.cpp servers.
      cache_prompt: true,
    }),
    signal,
    // `dispatcher` is an undici extension (fetch === undici's fetch in
    // Node 18+). The DOM types don't know about it, hence the cast.
    dispatcher: llmStreamDispatcher,
  } as any)

  throwIfAborted()
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
  const abortReader = () => {
    try { reader.cancel() } catch {}
  }
  signal.addEventListener('abort', abortReader, { once: true })

  let accContent = ''
  let lastThinkLen = 0
  let lastVisibleLen = 0
  let wasThinkingDone = true
  const toolCallMap = new Map<number, any>()
  let sseBuffer = ''
  let lastEmitMs = 0
  let lastToolStreamMs = 0
  let lastStreamStatsEmitMs = 0
  const EMIT_INTERVAL_MS = 150 // max ~7 UI updates per second
  const STREAM_STATS_INTERVAL_MS = 500
  let finishReason: string | null = null

  // Two-phase idle timer:
  //   Phase 1 (prefill) — before the FIRST byte arrives, the server is
  //     ingesting the prompt. On huge contexts this can legitimately
  //     take many minutes on a consumer GPU, so we give it a very
  //     generous budget (15 minutes) and rely on the user's Cancel
  //     button if something's wrong. Killing the connection here used
  //     to be the #1 source of "fetch failed" spam.
  //   Phase 2 (streaming) — once tokens start flowing, any silence of
  //     >idleTimeoutSec means the server truly stalled and we bail.
  const IDLE_TIMEOUT_STREAMING_MS = getIdleTimeoutMs()
  const IDLE_TIMEOUT_PREFILL_MS = Math.max(IDLE_TIMEOUT_STREAMING_MS, 15 * 60 * 1000)
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let chunkCount = 0
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    const ms = chunkCount === 0 ? IDLE_TIMEOUT_PREFILL_MS : IDLE_TIMEOUT_STREAMING_MS
    idleTimer = setTimeout(() => {
      const phase = chunkCount === 0 ? 'PREFILL' : 'STREAM'
      debugLog('STREAM', `IDLE TIMEOUT (${phase}) after ${Date.now() - startMs}ms, ${chunkCount} chunks received, content=${accContent.length}chars`)
      try { reader.cancel() } catch {}
    }, ms)
  }
  resetIdle()

  try {
  while (true) {
    throwIfAborted()
    const { done, value } = await reader.read()
    throwIfAborted()
    if (done) { if (idleTimer) clearTimeout(idleTimer); break }
    chunkCount++
    resetIdle()

    sseBuffer += decoder.decode(value, { stream: true })
    const lines = sseBuffer.split('\n')
    sseBuffer = lines.pop()!

    for (const line of lines) {
      throwIfAborted()
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
          doEmit( { type: 'thinking', content: thinking.slice(lastThinkLen) })
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
          doEmit( { type: 'status', content: '' })
        }
        accContent += delta.content

        const { thinking, visible, thinkingDone } = parseAccumulatedThinking(accContent)

        // Emit thinking-done transition
        if (thinkingDone && !wasThinkingDone) {
          doEmit( { type: 'status', content: '' })
        }
        wasThinkingDone = thinkingDone

        // Emit thinking delta
        if (thinking.length > lastThinkLen) {
          doEmit( { type: 'thinking', content: thinking.slice(lastThinkLen) })
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
            doEmit( { type: 'response', content: fullNow, done: false })
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
                doEmit( {
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

      // Emit tokens/s during any generation — thinking or visible (throttled)
      const now = Date.now()
      const elapsedMs = now - startMs
      if (elapsedMs >= 300 && now - lastStreamStatsEmitMs >= STREAM_STATS_INTERVAL_MS) {
        lastStreamStatsEmitMs = now
        const est = estimateTokens(accContent)
        if (est > 0) {
          doEmit({ type: 'stream_stats', tokensPerSecond: Math.round((est * 1000) / elapsedMs) })
        }
      }
    }
  }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    signal.removeEventListener('abort', abortReader)
  }

  // Final visible emission to ensure nothing is lost
  const { visible: finalVisible } = parseAccumulatedThinking(accContent)
  if (finalVisible.length > 0) {
    const fullNow = fullResponseSoFar
      ? fullResponseSoFar + '\n\n' + finalVisible
      : finalVisible
    doEmit( { type: 'response', content: fullNow, done: false })
  }

  // Final tool streaming emission (ensure UI gets the complete content)
  for (const entry of toolCallMap.values()) {
    if (FILE_CONTENT_TOOLS.has(entry.function.name)) {
      const partial = extractPartialFileContent(entry.function.arguments, entry.function.name)
      if (partial) {
        doEmit( {
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

  const estimatedOutputTokens = estimateTokens(accContent)
  return { content: accContent, toolCalls, rawToolCalls, finishReason, elapsedMs, estimatedOutputTokens }
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
  const ctx = doGetCtxSize()
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
  return extractThinking(content)[1].trim()
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

/** Marker inserted into the compaction-prologue so tier4 / later code can
 *  identify and strip it without heuristics. */
const COMPACTION_PROLOGUE_TAG = '<!--compaction:prologue-->'

function isCompactionPrologue(m: { role: string; content?: string | null }): boolean {
  return typeof m.content === 'string' && m.content.includes(COMPACTION_PROLOGUE_TAG)
}

/** Build a short synthetic user/assistant pair that carries the summary
 *  and working-memory block. Lives AFTER the system message, keeping the
 *  system prompt stable across turns for KV-cache reuse. */
function buildCompactionPrologue(summaryText: string, memText: string): Message[] {
  if (!summaryText && !memText) return []
  const lines: string[] = [COMPACTION_PROLOGUE_TAG]
  lines.push('## Context so far (compacted)')
  lines.push('')
  lines.push('_This block replaces older conversation turns that were summarised to save context. Treat it as authoritative memory of what has happened up to this point._')
  if (summaryText) {
    lines.push('')
    lines.push('### Summary of earlier conversation')
    lines.push(summaryText)
  }
  if (memText) {
    lines.push('')
    lines.push('### Working memory')
    lines.push(memText)
  }
  const userContent = lines.join('\n')
  // Using user→assistant shape is chat-template-safe everywhere. The
  // assistant "ack" is terse so it doesn't waste budget.
  return [
    { role: 'user', content: userContent },
    { role: 'assistant', content: 'Understood — continuing from the compacted state above.' },
  ]
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

    // KV-cache friendliness: keep the system prompt STABLE across turns.
    // Instead of stuffing summary/memory into messages[0].content (which
    // invalidates the entire prefix on every summarisation), we:
    //   - strip any legacy summary/memory blocks out of system,
    //   - externalise the new summary as a synthetic user/assistant pair
    //     placed right after the system message. This way only the new
    //     tail gets prefilled on the next request; the base system prompt
    //     + tools prefix remains cacheable.
    const markerMem = '\n\n## Working memory\n'
    const markerSum = '\n\n## Summary of earlier conversation\n'
    let pureBase = baseSystem
    const memIdx = pureBase.indexOf(markerMem)
    if (memIdx >= 0) pureBase = pureBase.slice(0, memIdx)
    const sumIdx = pureBase.indexOf(markerSum)
    if (sumIdx >= 0) pureBase = pureBase.slice(0, sumIdx)
    // Preserve the task-state block if present (lives at the very end).
    const tsBeginIdx = baseSystem.indexOf(TASK_STATE_BEGIN)
    const tsTail = tsBeginIdx >= 0 ? baseSystem.slice(tsBeginIdx) : ''
    if (tsTail && !pureBase.includes(TASK_STATE_BEGIN)) {
      pureBase = pureBase.trimEnd() + '\n\n' + tsTail
    }

    const budget = getMessageBudget()
    const recentTokens = estimateContextTokens(recentMessages)

    // Budget for the synthetic summary message — cap at a fraction of
    // total so we never blow the budget even with a verbose summary.
    const maxSummaryTokens = Math.max(300, Math.floor((budget - recentTokens - 500) * 0.5))
    const maxSummaryChars = Math.max(800, Math.floor(maxSummaryTokens * calibratedRatio))
    let summaryText = summary
    if (summaryText.length > maxSummaryChars) {
      summaryText = summaryText.slice(0, maxSummaryChars - 10) + '\n…[truncated]'
    }
    const memMaxChars = Math.max(400, Math.floor(maxSummaryChars * 0.3))
    let memText = memBlock
    if (memText.length > memMaxChars) memText = memText.slice(0, memMaxChars - 10) + '\n…'

    const externalizedPrologue = buildCompactionPrologue(summaryText, memText)

    // Also truncate recent tool results if still too big
    const compactRecent = recentMessages.map((m) => {
      if (m.role === 'tool' && m.content && m.content.length > 600) {
        return { ...m, content: compressToolResultText(m.content, 400) }
      }
      return m
    })

    const compacted: Message[] = [
      { role: 'system', content: pureBase },
      ...externalizedPrologue,
      ...compactRecent,
    ]

    const newTokens = estimateContextTokens(compacted)
    const pctUsed = Math.round((newTokens / budget) * 100)
    doEmit( {
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

  // Step 2: Strip summary and working memory from system prompt (legacy
  // pre-KV-friendly compaction path) and compress any externalised
  // compaction-prologue user message.
  const sysIdx = result.findIndex((m) => m.role === 'system')
  if (sysIdx >= 0 && result[sysIdx].content) {
    let sysTxt = result[sysIdx].content!
    const summaryMark = sysTxt.indexOf('\n\n## Summary of earlier')
    if (summaryMark >= 0) sysTxt = sysTxt.slice(0, summaryMark)
    const memMark = sysTxt.indexOf('\n\n## Working memory')
    if (memMark >= 0) sysTxt = sysTxt.slice(0, memMark)
    result[sysIdx] = { ...result[sysIdx], content: sysTxt }
  }
  for (let i = 0; i < result.length; i++) {
    if (isCompactionPrologue(result[i]) && result[i].content && result[i].content!.length > 600) {
      result[i] = { ...result[i], content: result[i].content!.slice(0, 500) + '\n…[prologue pruned]' }
    }
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
    '[Context was compacted to save space. See the "Context so far (compacted)" message above for the summary of earlier work.]',
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
      current = await tier3Summarize(current, apiUrl, signal)
      lastTier3Iteration = iter
      tokens = estimateContextTokens(current)
      current = injectRehydrationHint(current, originalMsgs)
      if (tokens <= budget * EMERGENCY_AT) return current
    }
  }

  // Tier 4: Emergency prune
  if (tokens > budget * EMERGENCY_AT) {
    doEmit( { type: 'status', content: '⚠️ Экстренная обрезка контекста' })
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

    // Dynamic context discovery: keep the stable prompt small. Instead of
    // stuffing rules + directory tree + repo map into the first system
    // message, ship a compact index and let the agent fetch deeper sections
    // with get_project_context when the task actually needs them.
    const ctx = executeTool('get_project_context', { section: 'overview', max_bytes: ctxTokens() < 16384 ? 1800 : 3200 }, ws)

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
}

export function resetAgent(ws: string) {
  const session = getActiveSession(ws)
  session.messages = []
  session.projectContextAdded = false
  session.updatedAt = Date.now()
  saveSession(session)
}

export function isCancelRequested(): boolean {
  return cancelRequested
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

export async function runAgent(userMessage: string, ws: string, bridge: AgentBridge): Promise<string> {
  currentBridge = bridge
  try {
  workspace = ws
  cancelRequested = false
  lastTier3Iteration = -10
  toolCache.resetStats()

  const session = doGetSession()
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

  // Archive the user message immediately — it will be preserved even if
  // later compaction replaces it with a summary pointer.
  try {
    const archiveKey = session.workspaceKey ?? ''
    archive.appendMessages(archiveKey, session.id, [
      { role: 'user', content: userMessage, turn: messages.length, ts: Date.now() },
    ])
  } catch {}

  const apiUrl = `${doGetApiUrl()}/v1/chat/completions`

  // Calibrate token ratio from server (non-blocking, happens once)
  calibrateTokenRatio().catch(() => {})

  // Verify actual server ctx size (catches mismatches from server auto-reducing ctx)
  doQueryActualCtxSize().catch(() => {})

  // Summarize/prune context if approaching limit
  messages = await manageContext(messages, apiUrl)
  session.messages = messages
  emitContextUsage( messages)
  let fullResponse = ''
  let emptyRetries = 0

  // Track files created this turn to detect pointless re-reads after compression
  const filesCreatedThisTurn = new Set<string>()
  let consecutiveReReads = 0

  // General loop detection: same read-only tool + same args repeated across
  // the whole user turn. The old guard only caught consecutive duplicates;
  // models can still loop by alternating read_file with thoughts/commands.
  const readonlyToolCallCounts = new Map<string, number>()
  let loopNudgesThisTurn = 0
  let workspaceChangedThisTurn = false
  let verificationCommandAfterChange = false
  let selfCheckNudgedThisTurn = false

  const checkRepeatedReadonlyTool = (toolName: string, toolArgs: Record<string, any>) => {
    const toolSig = `${toolName}:${JSON.stringify(toolArgs)}`
    if (!LOOP_GUARDED_READONLY_TOOLS.has(toolName)) return { action: 'allow' as const }

    const callCount = (readonlyToolCallCounts.get(toolSig) ?? 0) + 1
    readonlyToolCallCounts.set(toolSig, callCount)
    if (callCount <= MAX_IDENTICAL_READONLY_TOOL_CALLS_PER_TURN) return { action: 'allow' as const }

    loopNudgesThisTurn++
    debugLog('LOOP', `Duplicate ${toolName} call #${callCount} in turn: ${toolArgs.path ?? toolArgs.pattern ?? ''}`)
    const message = `Loop guard: you already called ${toolName} with these exact arguments ${callCount} times during this user request. The result is available in the conversation history; do not call it again. Continue with the next concrete action: edit the file, run a focused check, update the plan, or give the user a concise stuck report.`
    if (loopNudgesThisTurn >= MAX_LOOP_NUDGES_PER_TURN) {
      return {
        action: 'recover' as const,
        message,
      }
    }

    return { action: 'skip' as const, message }
  }

  const injectLoopRecovery = (message: string): void => {
    const recovery = `[System: loop guard intervention]
You are repeating the same read-only tool call and not making progress.

${message}

Do not call that same read-only tool with the same arguments again in this turn.
Use the content already present in the conversation and choose a different next action now:
- if you already know the needed change, call edit_file/write_file;
- if verification is needed, run one focused command;
- if the plan changed, call update_plan;
- if genuinely blocked, explain the missing information briefly.
Before the next tool call, state the new strategy in one sentence.`
    debugLog('LOOP', 'Injected loop-recovery supervisor message')
    doEmit({ type: 'status', content: '🧭 Агент повторяет одно действие — переключаю его на другой следующий шаг…' })
    messages.push({ role: 'user', content: recovery })
  }

  const markWorkspaceChanged = (): void => {
    workspaceChangedThisTurn = true
    verificationCommandAfterChange = false
  }

  // Archive cursor: how many messages have already been written to the
  // append-only archive. At the top of each iteration we flush everything
  // after this index, so the archive is complete even if we later compact.
  let archivedUpTo = messages.length

  agentLoop: for (let i = 0; i < getMaxIterations(); i++) {
    // Flush newly-appended messages to the session archive. We do this at
    // the START of each iteration (not just the end) so if the model
    // crashes mid-stream the archive still has the previous turn's
    // assistant + tool outputs.
    try {
      const key = session.workspaceKey ?? ''
      const batch: archive.ArchivedMessage[] = []
      for (let k = archivedUpTo; k < messages.length; k++) {
        const m = messages[k] as any
        if (!m || m.role === 'system') continue
        const toolNames = Array.isArray(m.tool_calls) ? m.tool_calls.map((tc: any) => tc?.function?.name).filter(Boolean) : undefined
        batch.push({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          turn: k,
          ts: Date.now(),
          toolNames: toolNames?.length ? toolNames : undefined,
          toolName: m.role === 'tool' ? (m._toolName ?? undefined) : undefined,
        })
      }
      if (batch.length) archive.appendMessages(key, session.id, batch)
      archivedUpTo = messages.length
    } catch {}

    if (doIsCancelRequested()) {
      doEmit( { type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
      session.updatedAt = Date.now()
      doSaveSession(session)
      return 'Canceled'
    }

    // Signal the UI to start a new assistant "bubble" for each iteration
    if (i > 0) {
      doEmit( { type: 'new_turn' })
      fullResponse = ''
    }

    // Pre-flight: sanitize structure + ensure messages fit in context budget.
    // NOTE: taskState is NOT stitched into `messages` here — it's added as
    // an ephemeral user turn inside streamLlmResponse only, so we never
    // persist it or count its tokens against the session history.
    messages = sanitizeMessages(messages)
    const accurateTokens = await countContextTokensAccurate(messages)
    const preflightBudget = getMessageBudget()
    const serverCtx = ctxTokens()
    debugLog('PREFLIGHT', `iter=${i}, msgs=${messages.length}, tokens=${accurateTokens}, budget=${preflightBudget}, ctx=${serverCtx}, ratio=${(accurateTokens/preflightBudget*100).toFixed(0)}%, maxResp=${getMaxResponseTokens()}`)

    if (accurateTokens > preflightBudget * EMERGENCY_AT) {
      doEmit( { type: 'status', content: '🗜️ Обрезка контекста перед запросом…' })
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
      doEmit({ type: 'stream_stats', tokensPerSecond: 0 })
      // No fixed total timeout — idle timeout inside streamLlmResponse handles stalls
      // Only abort on user cancel or server idle (120s no data)

      const retryTemp = emptyRetries > 0 ? getBaseTemperature() + emptyRetries * 0.2 : undefined
      // Attach the per-turn taskState note. This message lives only
      // inside this request — it is NOT written back to session.messages.
      const messagesForRequest = withTaskStateEphemeral(messages, session)
      const sessionMode: AgentMode = session.mode ?? getDefaultAgentMode()
      streamResult = await streamLlmResponse(apiUrl, messagesForRequest, fullResponse, controller.signal, effectiveMaxTokens, retryTemp, sessionMode)
    } catch (e: any) {
      debugLog('ERROR', `Catch in runAgent: name=${e?.name}, message=${e?.message}, cancelRequested=${cancelRequested}, stack=${(e?.stack ?? '').slice(0, 500)}`)
      if (doIsCancelRequested()) {
        doEmit( { type: 'status', content: '⏹ Запрос агента остановлен пользователем' })
        session.updatedAt = Date.now()
        doSaveSession(session)
        return 'Canceled'
      }

      const errMsg = e.message ?? String(e)
      const isAbort = e?.name === 'AbortError' || errMsg.includes('aborted')
      const isContextError = errMsg.includes('500') || errMsg.includes('400') || errMsg.includes('context')

      if (isAbort && !isContextError) {
        // Idle timeout or network abort — not user-initiated
        doEmit( { type: 'error', content: 'Соединение с моделью прервано (сервер не отвечал 60 секунд). Попробуйте ещё раз.' })
        session.updatedAt = Date.now()
        doSaveSession(session)
        return 'Error: connection lost'
      }

      if (isContextError) {
        // Extract real n_ctx from server error and auto-correct our tracking
        const ctxMatch = errMsg.match(/n_ctx[":=\s]*(\d+)/)
        if (ctxMatch) {
          const realCtx = parseInt(ctxMatch[1])
          if (realCtx > 0 && realCtx !== ctxTokens()) {
            debugLog('CTX_FIX', `Server reports n_ctx=${realCtx}, we tracked ${ctxTokens()} — correcting!`)
            doSetCtxSize(realCtx)
            emitContextUsage(messages)
          }
        }

        doEmit( { type: 'status', content: `🔧 Ошибка контекста (реальный ctx=${ctxTokens()}) — очищаю и повторяю…` })
        messages = sanitizeMessages(messages)
        messages = tier4EmergencyPrune(messages)
        session.messages = messages
        doSaveSession(session)
        try {
          const retryController = new AbortController()
          currentAbort = retryController
          const sessionMode: AgentMode = session.mode ?? getDefaultAgentMode()
          streamResult = await streamLlmResponse(apiUrl, withTaskStateEphemeral(messages, session), fullResponse, retryController.signal, undefined, undefined, sessionMode)
        } catch (retryErr: any) {
          doEmit( { type: 'error', content: `LLM request failed after recovery: ${retryErr.message}` })
          session.updatedAt = Date.now()
          doSaveSession(session)
          return `Error: ${retryErr.message}`
        }
      } else {
        doEmit( { type: 'error', content: `LLM request failed: ${errMsg}` })
        session.updatedAt = Date.now()
        doSaveSession(session)
        return `Error: ${errMsg}`
      }
    }

    const content = streamResult.content
    const toolCalls = streamResult.toolCalls
    const rawToolCalls = streamResult.rawToolCalls
    const finishReason = streamResult.finishReason

    if (streamResult.elapsedMs > 0 && streamResult.estimatedOutputTokens > 0) {
      const tokPerSec = Math.round((streamResult.estimatedOutputTokens * 1000) / streamResult.elapsedMs)
      doEmit({ type: 'stream_stats', tokensPerSecond: tokPerSec })
    }

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
          doEmit( { type: 'status', content: `🔧 Tool call обрезался — спасаю частичный контент (${(repairArgs.content ?? '').length} символов)…` })
          const cpRepair = maybeCheckpoint(repairName, repairArgs, workspace)
          doEmit( { type: 'tool_call', name: repairName, args: repairArgs, checkpoint: cpRepair })

          const needsApproval = needsApprovalForTool(repairName, false)
          const approved = needsApproval ? await doRequestApproval( repairName, repairArgs) : true

          if (approved) {
            const result = executeTool(repairName, repairArgs, workspace)
            const uiResult = result.length > 5000 ? result.slice(0, 5000) : result
            doEmit( { type: 'tool_result', name: repairName, result: uiResult })

            const fsModTools = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory', 'append_file'])
            if (fsModTools.has(repairName) && !result.startsWith('Error') && !result.startsWith('[Denied')) {
              markWorkspaceChanged()
              invalidateProjectContextCache()
              try { currentBridge!.notifyWorkspaceChanged() } catch {}
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
        doSaveSession(session)
        emitContextUsage( messages)
        continue
      }

      // Could not repair — give self-correction feedback without executing
      const rawName = rawToolCalls[0]?.function?.name ?? 'unknown'
      debugLog('TRUNCATED', `Could not repair ${rawName}, giving feedback`)
      doEmit( { type: 'status', content: `⚠️ Tool call "${rawName}" обрезался — прошу модель разбить на части…` })
      messages.push({ role: 'assistant', content: `I tried to call ${rawName} but the content was too large and the JSON was truncated.` })
      messages.push({
        role: 'user',
        content: `Your ${rawName} tool call failed — the JSON arguments were truncated because the content was too large for a single generation. IMPORTANT: Break large file writes into smaller steps:\n1. First write_file with just the skeleton/structure (imports, basic HTML structure, empty function bodies) — under 80 lines\n2. Then use edit_file to fill in each section one at a time\n3. Or use append_file to add content incrementally\nNever put more than 100 lines of content in a single tool call.`,
      })
      session.messages = messages
      doSaveSession(session)
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
          doEmit( { type: 'thinking', content: thinking })
        }

        const recoveredCustomTools = doGetConfig().customTools
        for (const tc of textCalls) {
          const loopGuard = checkRepeatedReadonlyTool(tc.name, tc.args)
          if (loopGuard.action !== 'allow') {
            const callId = `text_tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            const result = loopGuard.message
            messages.push({
              role: 'assistant',
              content: stripThinking(content),
              tool_calls: [{ id: callId, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }],
            })
            messages.push({ role: 'tool', tool_call_id: callId, content: result })
            if (loopGuard.action === 'recover') {
              injectLoopRecovery(loopGuard.message)
              session.messages = messages
              doSaveSession(session)
              emitContextUsage(messages)
              continue agentLoop
            }
            continue
          }

          const cpText = maybeCheckpoint(tc.name, tc.args, workspace)
          doEmit( { type: 'tool_call', name: tc.name, args: tc.args, checkpoint: cpText })

          const isCustom = recoveredCustomTools.some((ct: any) => ct.name === tc.name)
          if (needsApprovalForTool(tc.name, isCustom)) {
            const approved = await doRequestApproval( tc.name, tc.args)
            if (!approved) {
              const deniedResult = `[Denied by user] Operation "${tc.name}" was not approved.`
              doEmit( { type: 'tool_result', name: tc.name, result: deniedResult })
              messages.push({ role: 'assistant', content: stripThinking(content) })
              messages.push({ role: 'user', content: deniedResult })
              break
            }
          }

          let result: string
          if (tc.name === 'update_plan') {
            const prev = session.taskState ?? emptyTaskState()
            const mode = session.mode ?? getDefaultAgentMode()
            const { next, summary } = applyTaskStateUpdate(prev, taskStateUpdateForMode(tc.args, mode))
            session.taskState = next
            session.updatedAt = Date.now()
            result = `Task state updated (${summary}). This will be visible in the system prompt on the next turn.`
            doEmit({ type: 'task_state', taskState: next })
          } else if (isCustom) {
            const ct = recoveredCustomTools.find((t: any) => t.name === tc.name)
            result = ct ? executeCustomTool(ct, tc.args, workspace) : `Error: custom tool "${tc.name}" not found`
          } else if (isMcpTool(tc.name)) {
            try {
              result = await currentBridge!.callMcpTool(tc.name, tc.args)
            } catch (err: any) {
              result = `[MCP error] ${err?.message ?? String(err)}`
            }
          } else {
            result = executeTool(tc.name, tc.args, workspace)
          }

          const uiResult = result.length > 5000 ? result.slice(0, 5000) + '\n… [truncated]' : result
          doEmit( { type: 'tool_result', name: tc.name, result: uiResult })

          const fsModToolsText = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory', 'append_file'])
          if (fsModToolsText.has(tc.name) && !result.startsWith('Error') && !result.startsWith('[Denied')) {
            markWorkspaceChanged()
            invalidateProjectContextCache()
            try { currentBridge!.notifyWorkspaceChanged() } catch {}
          }

          if (tc.name === COMMAND_TOOL && workspaceChangedThisTurn && !result.startsWith('[Denied')) {
            verificationCommandAfterChange = true
          }

          // Build proper tool_calls message format
          const callId = `text_tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          messages.push({
            role: 'assistant',
            content: stripThinking(content),
            tool_calls: [{ id: callId, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }],
          })
          messages.push({ role: 'tool', tool_call_id: callId, content: smartTruncateToolResult(tc.name, result, dynamicToolResultLimit()) })
          if (tc.name === 'update_plan') {
            session.messages = messages
            doSaveSession(session)
          }
        }

        session.messages = messages
        doSaveSession(session)
        emitContextUsage( messages)
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

      if (emptyRetries <= getMaxEmptyRetries()) {
        if (usageRatio > 0.5) {
          doEmit( { type: 'status', content: `⚠️ Пустой ответ — обрезаю контекст и повторяю (${emptyRetries}/${getMaxEmptyRetries()})…` })
          messages = tier4EmergencyPrune(messages)
          session.messages = messages
        } else {
          // Nudge the model — add a user message to break the empty-response loop
          const lastMsg = messages[messages.length - 1]
          const afterTool = lastMsg?.role === 'tool'
          const nudge = afterTool
            ? 'The tool above returned a result. Continue with the next tool call or give a concise visible answer in the user\'s language. Do not continue hidden reasoning.'
            : 'Your previous output contained only private reasoning. Now either call the next needed tool or give the concise visible answer in the user\'s language. Do not continue hidden reasoning.'
          messages.push({ role: 'user', content: `[System: empty response detected, retry ${emptyRetries}/${getMaxEmptyRetries()}] ${nudge}` })
          debugLog('EMPTY', `Added nudge message (afterTool=${afterTool})`)
          doEmit( { type: 'status', content: `⚠️ Пустой ответ от модели — повторяю с подсказкой (${emptyRetries}/${getMaxEmptyRetries()})…` })
        }
        doSaveSession(session)
        continue
      }
      doEmit( { type: 'error', content: 'Модель вернула пустой ответ после нескольких попыток. Попробуйте переформулировать запрос или начать новый чат.' })
      session.updatedAt = Date.now()
      doSaveSession(session)
      return 'Empty response after retries'
    }
    emptyRetries = 0

    const [, visible] = extractThinking(content)

    // No tool calls → final response
    if (!toolCalls || toolCalls.length === 0) {
      const finalText = visible || content
      if (workspaceChangedThisTurn && !verificationCommandAfterChange && !selfCheckNudgedThisTurn) {
        selfCheckNudgedThisTurn = true
        const savedDraft = stripThinking(content)
        if (savedDraft) messages.push({ role: 'assistant', content: savedDraft })
        messages.push({
          role: 'user',
          content: `[System: verification required before final answer]
You changed files during this task but have not run a verification command after the latest successful change.

Before giving the final answer, run one focused execute_command check that best fits this project and change: tests, type-check, lint, build, or a narrow command. If no safe or relevant command exists, explain why in one concise sentence and then finalize with a verification checklist.

Do not redo completed edits unless the verification output shows a problem.`,
        })
        debugLog('VERIFY', 'Injected self-check nudge after workspace changes')
        doEmit({ type: 'status', content: '✅ Перед финалом прошу агента запустить проверку изменений…' })
        session.messages = messages
        doSaveSession(session)
        continue
      }
      fullResponse += (fullResponse ? '\n\n' : '') + finalText
      doEmit( { type: 'response', content: fullResponse, done: true })
      // Store without <think> blocks to save context
      messages.push({ role: 'assistant', content: stripThinking(content) })
      session.messages = messages
      session.updatedAt = Date.now()
      doSaveSession(session)
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
      doEmit( { type: 'status', content: `⚠️ ${notice}` })
      messages.push({ role: 'assistant', content: brokenText || notice })
      messages.push({ role: 'user', content: 'Your previous tool call was truncated and could not be parsed. Please try again, but break large file writes into smaller parts or use a shorter approach.' })
      session.messages = messages
      doSaveSession(session)
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

      // Mode-level tool guard. Belt-and-suspenders on top of not
      // sending the tool def to the LLM at all — a prompt-injection or
      // a model "remembering" a tool from a previous turn shouldn't be
      // able to sneak past.
      const currentMode: AgentMode = session.mode ?? getDefaultAgentMode()
      if (!isToolAllowedInMode(toolName, currentMode)) {
        const deniedMsg = `[Denied by mode] Tool "${toolName}" is not available in ${currentMode} mode. ${
          currentMode === 'chat'
            ? 'All tools are disabled in chat mode.'
            : 'In plan mode only read-only tools are allowed; ask the user to switch to agent mode to make changes.'
        }`
        doEmit({ type: 'tool_call', name: toolName, args: toolArgs })
        doEmit({ type: 'tool_result', name: toolName, result: deniedMsg })
        messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: deniedMsg })
        continue
      }

      // General loop detection: same read-only tool + same args called
      // repeatedly anywhere in this user turn. Allow two calls because a
      // healthy flow often does "read -> edit -> read to verify"; from the
      // third identical call onward, the result is stale process, not signal.
      const loopGuard = checkRepeatedReadonlyTool(toolName, toolArgs)
      if (loopGuard.action !== 'allow') {
        messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: loopGuard.message })
        if (loopGuard.action === 'recover') {
          injectLoopRecovery(loopGuard.message)
          session.messages = messages
          doSaveSession(session)
          emitContextUsage(messages)
          continue agentLoop
        }
        continue
      }

      const cpNative = maybeCheckpoint(toolName, toolArgs, workspace)
      doEmit( { type: 'tool_call', name: toolName, args: toolArgs, checkpoint: cpNative })

      // Track files created this turn
      if ((toolName === 'write_file' || toolName === 'append_file' || toolName === 'create_directory') && toolArgs.path) {
        filesCreatedThisTurn.add(toolArgs.path)
      }

      // Detect pointless re-reads of files we JUST created
      if (toolName === 'read_file' && toolArgs.path && filesCreatedThisTurn.has(toolArgs.path)) {
        consecutiveReReads++
        debugLog('LOOP', `Re-read of just-created file: ${toolArgs.path} (consecutive: ${consecutiveReReads})`)
        if (consecutiveReReads >= 3) {
          const skipMsg = `You just created ${toolArgs.path} in this session — its contents are exactly what you wrote. Instead of re-reading files you just created, continue with the next step of the task. What files still need to be created or modified?`
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: skipMsg })
          doEmit( { type: 'tool_result', name: toolName, result: skipMsg })
          continue
        }
      } else {
        consecutiveReReads = 0
      }

      // Request user approval when enabled for file ops or commands (or custom tools)
      let result: string
      let cacheHit = false
      const customTools = doGetConfig().customTools
      const isCustom = customTools.some((ct) => ct.name === toolName)
      const isMcp = isMcpTool(toolName)

      // ---- Built-in: update_plan (task-state mutator) ---------------------
      // Handled inline because it mutates the session, not the workspace,
      // and we want the updated state to flow into the NEXT system prompt
      // without a full context rebuild.
      if (toolName === 'update_plan') {
        const prev = session.taskState ?? emptyTaskState()
        const mode = session.mode ?? getDefaultAgentMode()
        const { next, summary } = applyTaskStateUpdate(prev, taskStateUpdateForMode(toolArgs, mode))
        session.taskState = next
        session.updatedAt = Date.now()
        debugLog('TASKSTATE', `update_plan: ${summary}`)
        // Push a live snapshot to the UI so the task panel can re-render
        // immediately — without this, the sidebar would freeze until the
        // agent's whole cycle finishes and a new chat message appears.
        doEmit({ type: 'task_state', taskState: next })
        const result = `Task state updated (${summary}). This will be visible in the system prompt on the next turn.`
        doEmit({ type: 'tool_result', name: toolName, result })
        messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: result })
        session.messages = messages
        doSaveSession(session)
        continue
      }

      // ---- Built-in: save_plan_artifact (PLAN.md only) ---------------------
      if (toolName === 'save_plan_artifact') {
        try {
          const saved = savePlanArtifactContent(workspace, String(toolArgs.content ?? ''))
          const result = `PLAN.md saved: ${saved.path}`
          doEmit({ type: 'plan_artifact', planArtifactPath: saved.path })
          doEmit({ type: 'tool_result', name: toolName, result })
          try { currentBridge!.notifyWorkspaceChanged() } catch {}
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: result })
        } catch (err: any) {
          const result = `Error saving PLAN.md: ${err?.message ?? String(err)}`
          doEmit({ type: 'tool_result', name: toolName, result })
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: result })
        }
        continue
      }

      // ---- Built-in: update_project_memory (durable workspace memory) -----
      if (toolName === 'update_project_memory') {
        try {
          const category = ['decision', 'preference', 'known_issue', 'note'].includes(String(toolArgs.category))
            ? String(toolArgs.category) as projectMemory.ProjectMemoryCategory
            : 'note'
          const file = projectMemory.appendProjectMemory(workspace, {
            category,
            title: String(toolArgs.title ?? ''),
            content: String(toolArgs.content ?? ''),
          })
          const result = `Project memory updated: ${file}`
          doEmit({ type: 'tool_result', name: toolName, result })
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: result })
        } catch (err: any) {
          const result = `Error updating project memory: ${err?.message ?? String(err)}`
          doEmit({ type: 'tool_result', name: toolName, result })
          messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: result })
        }
        continue
      }

      // ---- Built-in: recall (search archived history) ----------------------
      if (toolName === 'recall') {
        const q = typeof toolArgs.query === 'string' ? toolArgs.query : ''
        let result: string
        if (!q.trim()) {
          result = 'Error: `query` is required and must be a non-empty string.'
        } else {
          const key = session.workspaceKey ?? ''
          const hits = archive.recall(key, session.id, q, 8)
          if (hits.length === 0) {
            result = `No matches for "${q}" in the archive.`
          } else {
            const parts = hits.map((h, idx) => {
              const when = new Date(h.ts).toISOString().replace('T', ' ').slice(0, 19)
              const who = h.toolName ? `${h.role}(${h.toolName})` : h.role
              return `#${idx + 1} [turn ${h.turn}, ${when}, ${who}]\n${h.excerpt}`
            })
            result = `Found ${hits.length} match(es) for "${q}":\n\n${parts.join('\n\n---\n\n')}`
          }
        }
        doEmit({ type: 'tool_result', name: toolName, result: result.length > 2000 ? result.slice(0, 2000) + '…' : result })
        messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: result })
        continue
      }

      // ---- Tool-result cache (builtins only) ------------------------------
      // Check BEFORE executing: if the same (tool, args) was called recently
      // and the relevant filesystem state hasn't changed, reuse the result.
      // MCP/custom tools are not cached — we don't know their semantics.
      let cacheEntry: toolCache.CacheEntry | null = null
      if (!isCustom && !isMcp) {
        cacheEntry = toolCache.lookup(toolName, toolArgs, workspace)
      }

      const needsApproval = needsApprovalForTool(toolName, isCustom) && !isMcp

      if (cacheEntry) {
        result = toolCache.renderCachedShortCircuit(cacheEntry, i)
        cacheHit = true
      } else if (needsApproval && !isCustom && (toolName === 'write_file' || toolName === 'edit_file')) {
        // Inline per-hunk review replaces the plain yes/no prompt for file
        // writes. The user sees the diff and picks which hunks to apply.
        result = await reviewAndApplyWrite(toolName, toolArgs, workspace, tc.id)
      } else if (needsApproval) {
        const approved = await doRequestApproval( toolName, toolArgs)
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
      } else if (isMcp) {
        try {
          result = await currentBridge!.callMcpTool(toolName, toolArgs)
        } catch (err: any) {
          result = `[MCP error] ${err?.message ?? String(err)}`
        }
      } else if (isCustom) {
        const ct = customTools.find((t) => t.name === toolName)!
        result = executeCustomTool(ct, toolArgs, workspace)
      } else {
        result = executeTool(toolName, toolArgs, workspace)
      }

      // Truncate for UI
      const uiResult = result.length > 5000
        ? result.slice(0, 5000) + `\n… [${Math.round(result.length / 1024)}KB total]`
        : result
      doEmit( { type: 'tool_result', name: toolName, result: uiResult })

      // Notify renderer to refresh file tree when agent modifies filesystem
      const fsModTools = new Set(['write_file', 'edit_file', 'delete_file', 'create_directory', 'append_file'])
      if (fsModTools.has(toolName) && !result.startsWith('Error') && !result.startsWith('[Denied')) {
        markWorkspaceChanged()
        invalidateProjectContextCache()
        // Invalidate any cached read_file for the path we just wrote.
        try {
          const p = typeof (toolArgs as any).path === 'string' ? (toolArgs as any).path : null
          if (p) {
            const abs = require('path').isAbsolute(p) ? p : require('path').join(workspace, p)
            toolCache.invalidateFile(abs)
          }
        } catch {}
        try {
          try { currentBridge!.notifyWorkspaceChanged() } catch {}
        } catch {}
      }

      if (toolName === COMMAND_TOOL && workspaceChangedThisTurn && !result.startsWith('[Denied')) {
        verificationCommandAfterChange = true
      }

      // Store fresh successful results in the cache and dedup older copies.
      if (!cacheHit && !isCustom && !isMcp &&
          !result.startsWith('Error') && !result.startsWith('[Denied')) {
        const stored = toolCache.put(toolName, toolArgs, result, workspace, i)
        if (stored) {
          try {
            const pointer = toolCache.renderDedupPointer(i, toolName)
            const nRepl = toolCache.dedupHistoricalResults(messages as any, session.id, stored.contentHash, pointer)
            if (nRepl > 0) debugLog('CACHE', `retro-dedup: replaced ${nRepl} older identical tool_result(s)`)
          } catch (err: any) {
            debugLog('CACHE', 'dedup error:', err?.message ?? err)
          }
        }
      }

      // Truncate for LLM context — dynamic limit based on context window
      const maxToolChars = dynamicToolResultLimit()
      const llmResult = smartTruncateToolResult(toolName, result, maxToolChars)

      messages.push({ role: 'tool' as any, tool_call_id: tc.id, content: llmResult })
    }

    // Summarize/prune after each iteration to stay within budget
    messages = await manageContext(messages, apiUrl, undefined, i)
    session.messages = messages
    emitContextUsage( messages)
  }

  const msg = 'Reached maximum iterations. Stopping.'
  fullResponse += (fullResponse ? '\n\n' : '') + msg
  doEmit( { type: 'response', content: fullResponse, done: true })
  session.updatedAt = Date.now()
  doSaveSession(session)
  // Final archive flush — so the last turn's messages make it to the log
  // even when we hit the iteration limit.
  try {
    const key = session.workspaceKey ?? ''
    const batch: archive.ArchivedMessage[] = []
    for (let k = archivedUpTo; k < messages.length; k++) {
      const m = messages[k] as any
      if (!m || m.role === 'system') continue
      batch.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        turn: k,
        ts: Date.now(),
      })
    }
    if (batch.length) archive.appendMessages(key, session.id, batch)
  } catch {}
  return fullResponse
  } finally {
    currentBridge = null
  }
}
