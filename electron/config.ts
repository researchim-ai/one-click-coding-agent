import fs from 'fs'
import path from 'path'
import os from 'os'
import type { GpuMode, AgentMode } from './types'

export type WebSearchProvider = 'disabled' | 'managed-searxng' | 'custom-searxng'
export type AppLanguage = 'ru' | 'en'

export interface CustomTool {
  id: string
  name: string
  description: string
  command: string
  parameters: { name: string; description: string; required: boolean }[]
  enabled: boolean
}

/** One user-configured MCP (Model Context Protocol) server. We currently
 *  support stdio transport only — the overwhelming majority of open-source
 *  MCP servers ship that way, and it sidesteps all the auth/port-selection
 *  headaches of the HTTP transport for a local app. */
export interface McpServerConfig {
  id: string
  /** Display name shown in UI and used to namespace tool names. Slugified
   *  internally for the `mcp__<slug>__<tool>` prefix. */
  name: string
  /** Executable path or command (e.g. `npx`, `uvx`, `/usr/local/bin/my-srv`). */
  command: string
  /** Command-line args. Passed verbatim — quote-handling is the user's job. */
  args: string[]
  /** Extra env vars merged on top of the process env. Values may contain
   *  things like API keys — callers should treat this as sensitive. */
  env?: Record<string, string>
  enabled: boolean
}

export interface AppConfig {
  lastQuant: string
  ctxSize: number | null
  gpuMode: GpuMode
  gpuIndex: number | null
  webSearchProvider: WebSearchProvider
  searxngBaseUrl: string | null
  appLanguage: AppLanguage
  customTools: CustomTool[]
  mcpServers: McpServerConfig[]
  systemPrompt: string | null
  summarizePrompt: string | null
  maxIterations: number
  temperature: number
  idleTimeoutSec: number
  maxEmptyRetries: number
  /** @deprecated use approvalForFileOps/approvalForCommands */
  approvalRequired?: boolean
  /** Ask before write_file, edit_file, append_file, delete_file, create_directory */
  approvalForFileOps: boolean
  /** Ask before execute_command */
  approvalForCommands: boolean
  /** Internal migration marker: old builds accidentally defaulted approvals on. */
  approvalDefaultsMigrated?: boolean
  /** Default mode for newly-created chat sessions. Per-session overrides
   *  live on `Session.mode` and are what the agent actually consults at
   *  runtime. See `AgentMode` in types.ts for the semantics. */
  defaultMode: AgentMode
}

const DEFAULT_CONFIG: AppConfig = {
  lastQuant: 'UD-Q3_K_XL',
  ctxSize: null,
  gpuMode: 'single',
  gpuIndex: 0,
  webSearchProvider: 'disabled',
  searxngBaseUrl: null,
  appLanguage: 'ru',
  customTools: [],
  mcpServers: [],
  systemPrompt: null,
  summarizePrompt: null,
  maxIterations: 200,
  temperature: 0.3,
  idleTimeoutSec: 60,
  maxEmptyRetries: 3,
  approvalForFileOps: false,
  approvalForCommands: false,
  approvalDefaultsMigrated: true,
  defaultMode: 'agent',
}

export function resetToDefaults(): AppConfig {
  const fresh = { ...DEFAULT_CONFIG, customTools: [] }
  const dir = path.dirname(configPath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(fresh, null, 2))
  cached = fresh
  return fresh
}

function configPath(): string {
  return path.join(os.homedir(), '.one-click-agent', 'config.json')
}

let cached: AppConfig | null = null

export function load(): AppConfig {
  if (cached) return cached
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    const loaded = { ...DEFAULT_CONFIG, ...parsed }
    // Migrate old single approvalRequired to the two new flags
    if (parsed.approvalRequired !== undefined && (parsed.approvalForFileOps === undefined || parsed.approvalForCommands === undefined)) {
      loaded.approvalForFileOps = Boolean(parsed.approvalRequired)
      loaded.approvalForCommands = Boolean(parsed.approvalRequired)
      loaded.approvalDefaultsMigrated = true
    } else if (parsed.approvalDefaultsMigrated !== true) {
      // Builds before 0.1.2 accidentally wrote approvals as enabled by
      // default. Treat unmarked configs as old defaults, not as an explicit
      // user choice, so upgrades stop asking on every file edit.
      loaded.approvalForFileOps = false
      loaded.approvalForCommands = false
      loaded.approvalDefaultsMigrated = true
    }
    cached = loaded
    return loaded
  } catch {
    cached = { ...DEFAULT_CONFIG }
    return cached!
  }
}

export function save(partial: Partial<AppConfig>): AppConfig {
  const current = load()
  const touchesApprovals = 'approvalForFileOps' in partial || 'approvalForCommands' in partial
  const updated = { ...current, ...partial, ...(touchesApprovals ? { approvalDefaultsMigrated: true } : {}) }
  const dir = path.dirname(configPath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(updated, null, 2))
  cached = updated
  return updated
}

export function get<K extends keyof AppConfig>(key: K): AppConfig[K] {
  return load()[key]
}

export function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
  save({ [key]: value })
}
