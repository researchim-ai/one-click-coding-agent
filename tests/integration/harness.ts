/**
 * Integration-test harness for `runAgent` WITHOUT Electron.
 *
 * Sets up:
 *   - a temporary workspace directory
 *   - an isolated $HOME so `~/.one-click-agent/...` side-effects don't leak
 *   - an in-memory `AgentBridge` stub that captures emitted events
 *   - a programmable fetch mock that returns OpenAI-style SSE streams for
 *     `/v1/chat/completions`. Each call pulls the next scripted response
 *     from the queue so each test can decide exactly what the LLM "says".
 *
 * A single test typically:
 *   1. `const h = await makeHarness()`
 *   2. `h.enqueueAssistantToolCall({ name, args })` one or more times
 *   3. `h.enqueueAssistantText('final reply')`
 *   4. `await runAgent(userMsg, h.workspace, h.bridge)`
 *   5. assert on `h.bridge.events`, `h.fetchCalls`, `h.session.messages`, ...
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import type { AgentBridge, McpToolSnapshot, Session } from '../../electron/agent'
import type { AppConfig } from '../../electron/config'
import type { Message } from '../../electron/types'

// -------------------- scripted LLM responses ---------------------------------

export interface ScriptedToolCall {
  id?: string
  name: string
  args: Record<string, any>
}

export interface ScriptedResponse {
  /** Visible assistant text (may be empty when the response is pure tool calls). */
  content?: string
  /** Tool calls to emit in the completion. */
  toolCalls?: ScriptedToolCall[]
  /** Finish reason reported by the server. Defaults to 'stop'/'tool_calls'. */
  finishReason?: string
}

export function renderSseStream(resp: ScriptedResponse): string {
  const chunks: string[] = []
  const toolCalls = resp.toolCalls ?? []
  const hasTools = toolCalls.length > 0

  // role delta first
  chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n`)

  if (resp.content) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: resp.content } }] })}\n`)
  }

  if (hasTools) {
    toolCalls.forEach((tc, idx) => {
      const id = tc.id ?? `call_${idx}_${Math.random().toString(36).slice(2, 8)}`
      const tcDelta = {
        index: idx,
        id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }
      chunks.push(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tcDelta] } }] })}\n`,
      )
    })
  }

  const finish = resp.finishReason ?? (hasTools ? 'tool_calls' : 'stop')
  chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n`)
  chunks.push('data: [DONE]\n')
  return chunks.join('\n')
}

export interface FetchCall {
  url: string
  body: any
}

export type HunkReviewStubDecision =
  | { decision: 'accept_all' }
  | { decision: 'accept_selected'; selectedHunkIds: number[] }
  | { decision: 'reject' }

export interface Harness {
  workspace: string
  home: string
  config: AppConfig
  session: Session
  bridge: AgentBridge
  events: any[]
  fetchCalls: FetchCall[]
  responseQueue: ScriptedResponse[]
  hunkReviewCalls: any[]
  setHunkReviewResponder(fn: (review: any) => HunkReviewStubDecision): void
  enqueue(resp: ScriptedResponse): void
  enqueueAssistantText(text: string): void
  enqueueAssistantToolCall(tc: ScriptedToolCall, content?: string): void
  cleanup(): void
}

function makeDefaultConfig(): AppConfig {
  return {
    lastQuant: 'UD-Q4_K_XL',
    ctxSize: 32768,
    gpuMode: 'single',
    gpuIndex: 0,
    webSearchProvider: 'disabled',
    searxngBaseUrl: null,
    appLanguage: 'ru',
    customTools: [],
    mcpServers: [],
    systemPrompt: null,
    summarizePrompt: null,
    maxIterations: 20,
    temperature: 0.3,
    idleTimeoutSec: 60,
    maxEmptyRetries: 3,
    approvalForFileOps: false,
    approvalForCommands: false,
    defaultMode: 'agent',
  }
}

function makeEmptySession(workspace: string): Session {
  const normalized = path.normalize(workspace).trim()
  const workspaceKey = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  return {
    id: `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title: 'Новый чат',
    messages: [] as Message[],
    uiMessages: [],
    projectContextAdded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspaceKey,
  }
}

/** Build a minimal Response-like object compatible with the SSE consumer
 *  in `streamLlmResponse` (uses `r.body.getReader()` / `r.text()`). */
function makeSseResponse(body: string): Response {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(body)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const CHUNK = 256
      for (let i = 0; i < bytes.length; i += CHUNK) {
        controller.enqueue(bytes.slice(i, i + CHUNK))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

export interface HarnessOptions {
  /** Drop files into the workspace before runAgent kicks off. Useful for
   *  testing read_file / repo-map scenarios. */
  seedFiles?: Record<string, string>
  /** Tweak the config AFTER defaults are applied. */
  configOverrides?: Partial<AppConfig>
  /** Initial session.mode (chat/plan/agent). Defaults to the config's
   *  `defaultMode`. Useful to set up plan/chat-mode tests. */
  sessionMode?: 'chat' | 'plan' | 'agent'
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocaInt-'))
  const workspace = path.join(tmpRoot, 'workspace')
  const home = path.join(tmpRoot, 'home')
  await fs.promises.mkdir(workspace, { recursive: true })
  await fs.promises.mkdir(home, { recursive: true })

  // Seed workspace files.
  if (opts.seedFiles) {
    for (const [rel, content] of Object.entries(opts.seedFiles)) {
      const abs = path.join(workspace, rel)
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, content)
    }
  }

  // Isolate any HOME-relative side effects (archive, checkpoints, debug log).
  process.env.HOME = home

  const config: AppConfig = { ...makeDefaultConfig(), ...(opts.configOverrides ?? {}) }
  const session = makeEmptySession(workspace)
  session.mode = opts.sessionMode ?? config.defaultMode

  const events: any[] = []
  const responseQueue: ScriptedResponse[] = []
  const fetchCalls: FetchCall[] = []
  const hunkReviewCalls: any[] = []
  let hunkReviewResponder: (review: any) => HunkReviewStubDecision = () => ({ decision: 'accept_all' })

  // Install a global fetch mock. We respond to:
  //   - POST /v1/chat/completions   → next scripted SSE stream
  //   - POST /tokenize              → simple heuristic (len / 4 tokens)
  //   - anything else               → 404
  const origFetch = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: any, init?: any) => {
    const urlStr = typeof url === 'string' ? url : (url?.url ?? String(url))
    let body: any = {}
    try {
      body = init?.body ? JSON.parse(init.body) : {}
    } catch {
      body = { raw: init?.body }
    }
    fetchCalls.push({ url: urlStr, body })

    if (urlStr.endsWith('/v1/chat/completions')) {
      const next = responseQueue.shift()
      if (!next) {
        // Default: stop with tiny polite message so runAgent terminates.
        const sse = renderSseStream({ content: '[harness default stop]' })
        return makeSseResponse(sse)
      }
      return makeSseResponse(renderSseStream(next))
    }

    if (urlStr.endsWith('/tokenize')) {
      const content = typeof body?.content === 'string' ? body.content : ''
      const n = Math.max(1, Math.ceil(content.length / 4))
      return new Response(JSON.stringify({ tokens: new Array(n).fill(0) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('not found', { status: 404 })
  }

  const bridge: AgentBridge = {
    emit(ev) {
      events.push(ev)
    },
    requestApproval(_name, _args) {
      return Promise.resolve(true)
    },
    requestHunkReview(review) {
      hunkReviewCalls.push(review)
      return Promise.resolve(hunkReviewResponder(review) as any)
    },
    getConfig() {
      return config
    },
    getSession() {
      return session
    },
    saveSession(s) {
      Object.assign(session, s)
    },
    getApiUrl() {
      return 'http://127.0.0.1:65500'
    },
    getCtxSize() {
      return config.ctxSize ?? 32768
    },
    setCtxSize(n) {
      config.ctxSize = n
    },
    queryActualCtxSize() {
      return Promise.resolve()
    },
    isCancelRequested() {
      return false
    },
    notifyWorkspaceChanged() {},
    listMcpToolDefs(): McpToolSnapshot[] {
      return []
    },
    callMcpTool(_name, _args) {
      return Promise.reject(new Error('no mcp in harness'))
    },
  }

  const cleanup = () => {
    ;(globalThis as any).fetch = origFetch
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {}
  }

  return {
    workspace,
    home,
    config,
    session,
    bridge,
    events,
    fetchCalls,
    responseQueue,
    hunkReviewCalls,
    setHunkReviewResponder(fn) {
      hunkReviewResponder = fn
    },
    enqueue(resp) {
      responseQueue.push(resp)
    },
    enqueueAssistantText(text) {
      responseQueue.push({ content: text })
    },
    enqueueAssistantToolCall(tc, content) {
      responseQueue.push({ content, toolCalls: [tc] })
    },
    cleanup,
  }
}
