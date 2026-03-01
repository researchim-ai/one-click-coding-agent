import fs from 'fs'
import path from 'path'
import os from 'os'

export interface CustomTool {
  id: string
  name: string
  description: string
  command: string
  parameters: { name: string; description: string; required: boolean }[]
  enabled: boolean
}

export interface AppConfig {
  lastQuant: string
  ctxSize: number | null
  customTools: CustomTool[]
  systemPrompt: string | null
  summarizePrompt: string | null
}

const DEFAULT_CONFIG: AppConfig = {
  lastQuant: 'UD-Q4_K_XL',
  ctxSize: null,
  customTools: [],
  systemPrompt: null,
  summarizePrompt: null,
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
    cached = { ...DEFAULT_CONFIG, ...parsed }
    return cached!
  } catch {
    cached = { ...DEFAULT_CONFIG }
    return cached!
  }
}

export function save(partial: Partial<AppConfig>): AppConfig {
  const current = load()
  const updated = { ...current, ...partial }
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
