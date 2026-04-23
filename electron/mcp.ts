/**
 * MCP (Model Context Protocol) client manager.
 *
 * Lives in the Electron main process. Agent worker talks to this via
 * AgentBridge callbacks so only one copy of each MCP subprocess exists
 * per-app, survives agent restarts, and is cleanly torn down on quit.
 *
 * We support the stdio transport only — sufficient for all the official
 * reference servers (@modelcontextprotocol/server-filesystem, -github,
 * -postgres, -brave-search, -sqlite, etc.) and avoids the headaches of
 * picking ports / managing auth for the HTTP transport.
 *
 * Only the `tools` capability is surfaced today. Resources/prompts can be
 * added later without breaking this API.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig } from './config'

export interface McpToolDef {
  /** Full namespaced name exposed to the LLM: `mcp__<serverslug>__<toolname>`. */
  qualifiedName: string
  /** Server slug derived from config.name. */
  serverId: string
  /** Raw tool name as reported by the server. */
  rawName: string
  description: string
  /** JSON schema for the tool's arguments. */
  inputSchema: any
}

export interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  /** Non-empty when the last connect attempt failed. */
  lastError: string | null
  /** Timestamp of last successful connect/tool-refresh. */
  lastConnectedAt: number | null
  /** Number of tools the server exposes. Only meaningful when connected. */
  toolCount: number
}

interface ServerHandle {
  config: McpServerConfig
  slug: string
  client: Client | null
  transport: StdioClientTransport | null
  tools: McpToolDef[]
  status: McpServerStatus
  /** In-flight connect promise — lets many callers await one connect. */
  connecting: Promise<void> | null
  /** stderr tail for diagnostics in the UI. */
  stderrTail: string
}

const TOOL_PREFIX = 'mcp__'
const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000
const STDERR_TAIL_MAX = 8 * 1024

/** All known server handles, keyed by config.id. */
const handles = new Map<string, ServerHandle>()

function slugify(name: string): string {
  // Namespaced tool names become `mcp__<slug>__<tool>`. The slug must be a
  // valid JS identifier segment so OpenAI-style tool-name regex doesn't
  // reject it. Drop everything non-alnum, collapse repeats, fall back to
  // `srv` for empty input.
  const s = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return s || 'srv'
}

function makeHandle(cfg: McpServerConfig): ServerHandle {
  return {
    config: cfg,
    slug: slugify(cfg.name),
    client: null,
    transport: null,
    tools: [],
    connecting: null,
    stderrTail: '',
    status: {
      id: cfg.id,
      name: cfg.name,
      connected: false,
      lastError: null,
      lastConnectedAt: null,
      toolCount: 0,
    },
  }
}

/** Reconcile handles against the latest config list. Adds missing handles,
 *  removes orphaned ones (disconnecting them), and restarts handles whose
 *  command/args/env changed. Safe to call as often as you like. */
export async function reconcileServers(cfgs: McpServerConfig[]): Promise<void> {
  const seen = new Set<string>()
  for (const cfg of cfgs) {
    seen.add(cfg.id)
    const existing = handles.get(cfg.id)
    if (!existing) {
      handles.set(cfg.id, makeHandle(cfg))
      continue
    }
    const changed =
      existing.config.command !== cfg.command ||
      JSON.stringify(existing.config.args) !== JSON.stringify(cfg.args) ||
      JSON.stringify(existing.config.env || {}) !== JSON.stringify(cfg.env || {}) ||
      existing.config.name !== cfg.name
    existing.config = cfg
    existing.slug = slugify(cfg.name)
    existing.status.name = cfg.name
    if (changed && existing.client) {
      await disconnect(existing)
    }
    if (!cfg.enabled && existing.client) {
      await disconnect(existing)
    }
  }
  // Remove stale handles.
  for (const [id, h] of handles) {
    if (!seen.has(id)) {
      if (h.client) await disconnect(h)
      handles.delete(id)
    }
  }
}

async function disconnect(h: ServerHandle): Promise<void> {
  const c = h.client
  h.client = null
  h.transport = null
  h.tools = []
  h.status.connected = false
  h.status.toolCount = 0
  if (c) {
    try { await c.close() } catch {}
  }
}

/** Connect a single server if not already connected. Re-throws the last
 *  error if the connect fails, but caches the error into status.lastError
 *  so the UI can still show it. */
async function ensureConnected(h: ServerHandle): Promise<void> {
  if (!h.config.enabled) {
    throw new Error(`MCP server "${h.config.name}" is disabled`)
  }
  if (h.client) return
  if (h.connecting) return h.connecting

  h.connecting = (async () => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    for (const [k, v] of Object.entries(h.config.env || {})) {
      env[k] = v
    }

    const transport = new StdioClientTransport({
      command: h.config.command,
      args: h.config.args || [],
      env,
      stderr: 'pipe',
    })
    h.transport = transport

    // Capture stderr for diagnostics — handy when a server can't find
    // an API key etc. Keep only the tail so we don't leak memory for
    // chatty servers.
    const stderr = transport.stderr
    if (stderr && typeof (stderr as any).on === 'function') {
      ;(stderr as any).on('data', (chunk: Buffer | string) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        h.stderrTail = (h.stderrTail + s).slice(-STDERR_TAIL_MAX)
      })
    }

    const client = new Client(
      { name: 'one-click-coding-agent', version: '1.0.0' },
      { capabilities: {} },
    )
    h.client = client

    // Wire up close/error so we recover from crashed servers instead of
    // leaving stale handles pretending to be connected.
    transport.onclose = () => {
      h.client = null
      h.transport = null
      h.tools = []
      h.status.connected = false
      h.status.toolCount = 0
    }
    transport.onerror = (err) => {
      h.status.lastError = err?.message || String(err)
    }

    const connectPromise = client.connect(transport)
    await withTimeout(connectPromise, CONNECT_TIMEOUT_MS, `MCP connect timeout: ${h.config.name}`)

    // Refresh tool list immediately so the first call doesn't have to wait.
    await refreshTools(h)

    h.status.connected = true
    h.status.lastError = null
    h.status.lastConnectedAt = Date.now()
  })().catch(async (err) => {
    h.status.lastError = err?.message || String(err)
    h.status.connected = false
    if (h.client) {
      try { await h.client.close() } catch {}
      h.client = null
      h.transport = null
    }
    throw err
  }).finally(() => {
    h.connecting = null
  })

  return h.connecting
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(msg)), ms)
    p.then(
      (v) => { clearTimeout(to); resolve(v) },
      (e) => { clearTimeout(to); reject(e) },
    )
  })
}

async function refreshTools(h: ServerHandle): Promise<void> {
  if (!h.client) return
  try {
    const res = await h.client.listTools({})
    const tools: McpToolDef[] = []
    for (const t of res.tools ?? []) {
      tools.push({
        qualifiedName: `${TOOL_PREFIX}${h.slug}__${t.name}`,
        serverId: h.config.id,
        rawName: t.name,
        description: (t as any).description ?? '',
        inputSchema: (t as any).inputSchema ?? { type: 'object', properties: {} },
      })
    }
    h.tools = tools
    h.status.toolCount = tools.length
  } catch (err: any) {
    h.status.lastError = err?.message || String(err)
    h.tools = []
    h.status.toolCount = 0
  }
}

/** Kick off connects for every enabled server without awaiting — used at
 *  app start so we don't block UI. Any failures land in status.lastError. */
export function connectAllInBackground(cfgs: McpServerConfig[]): void {
  reconcileServers(cfgs).then(() => {
    for (const h of handles.values()) {
      if (h.config.enabled) {
        ensureConnected(h).catch(() => { /* error already captured in status */ })
      }
    }
  }).catch(() => { /* reconcile never throws meaningfully */ })
}

/** Explicitly connect one server and await the result. Used by the UI
 *  "Connect" button so the user gets a spinner that actually resolves. */
export async function connectOne(serverId: string, cfg?: McpServerConfig): Promise<McpServerStatus> {
  if (cfg) {
    await reconcileServers([
      ...[...handles.values()].map((h) => h.config).filter((c) => c.id !== serverId),
      cfg,
    ])
  }
  const h = handles.get(serverId)
  if (!h) throw new Error(`Unknown MCP server: ${serverId}`)
  try {
    await ensureConnected(h)
  } catch {
    // error is in status.lastError — return status so UI updates anyway
  }
  return { ...h.status }
}

/** Disconnect one server explicitly. */
export async function disconnectOne(serverId: string): Promise<void> {
  const h = handles.get(serverId)
  if (!h) return
  await disconnect(h)
}

/** Snapshot of every known server's status — cheap, no I/O. */
export function listStatus(): McpServerStatus[] {
  return [...handles.values()].map((h) => ({ ...h.status }))
}

/** Return the stderr tail for a server, for UI diagnostics. */
export function getStderrTail(serverId: string): string {
  return handles.get(serverId)?.stderrTail ?? ''
}

/** All tools from all currently-connected servers, namespaced. Safe to call
 *  often — just reads cached data. */
export function listAllTools(): McpToolDef[] {
  const out: McpToolDef[] = []
  for (const h of handles.values()) {
    if (!h.client || !h.config.enabled) continue
    out.push(...h.tools)
  }
  return out
}

/** Resolve a qualified tool name back to its server + raw name, or null
 *  if it doesn't match any known MCP tool. */
export function resolveQualifiedName(qualifiedName: string): { h: ServerHandle; rawName: string } | null {
  if (!qualifiedName.startsWith(TOOL_PREFIX)) return null
  for (const h of handles.values()) {
    for (const t of h.tools) {
      if (t.qualifiedName === qualifiedName) return { h, rawName: t.rawName }
    }
  }
  return null
}

export function isMcpToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(TOOL_PREFIX)
}

/** Invoke a tool by qualified name. Lazily connects the owning server if
 *  needed. Returns a best-effort string — MCP results are structured, we
 *  flatten to something the LLM can read. */
export async function callTool(qualifiedName: string, args: Record<string, any>): Promise<string> {
  const hit = resolveQualifiedName(qualifiedName)
  if (!hit) {
    // Server may not have been connected yet — try to find it by slug.
    const m = qualifiedName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
    if (m) {
      for (const h of handles.values()) {
        if (h.slug === m[1]) {
          await ensureConnected(h)
          const again = resolveQualifiedName(qualifiedName)
          if (again) return callToolInternal(again.h, again.rawName, args)
        }
      }
    }
    throw new Error(`Unknown MCP tool: ${qualifiedName}`)
  }
  await ensureConnected(hit.h)
  return callToolInternal(hit.h, hit.rawName, args)
}

async function callToolInternal(h: ServerHandle, rawName: string, args: Record<string, any>): Promise<string> {
  if (!h.client) throw new Error(`MCP server "${h.config.name}" not connected`)
  const res = await withTimeout(
    h.client.callTool({ name: rawName, arguments: args }),
    CALL_TIMEOUT_MS,
    `MCP tool call timeout: ${rawName}`,
  )
  return flattenCallResult(res)
}

/** MCP tool results come back as an array of content blocks (text, image,
 *  resource). Agents only understand text, so we coalesce everything into
 *  a single string. */
function flattenCallResult(res: any): string {
  if (!res) return ''
  if (typeof res === 'string') return res
  const parts: string[] = []
  const content = Array.isArray(res.content) ? res.content : []
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[image: ${block.mimeType || 'unknown'}]`)
    else if (block.type === 'resource' && block.resource) {
      const r = block.resource
      parts.push(`[resource ${r.uri ?? ''}]\n${r.text ?? ''}`)
    } else if (block.type === 'audio') parts.push(`[audio: ${block.mimeType || 'unknown'}]`)
    else if (typeof block.text === 'string') parts.push(block.text)
  }
  let out = parts.join('\n\n').trim()
  if (res.isError) out = `[MCP tool reported error]\n${out}`
  // Structured result fallback: some servers include `structuredContent`.
  if (!out && res.structuredContent) out = JSON.stringify(res.structuredContent, null, 2)
  return out || '[empty result]'
}

/** Shut down every server. Called on app quit. */
export async function shutdownAll(): Promise<void> {
  const tasks: Promise<void>[] = []
  for (const h of handles.values()) {
    if (h.client) tasks.push(disconnect(h))
  }
  await Promise.allSettled(tasks)
}
