/** Operating mode for a chat session. Inspired by Cursor / Claude Code:
 *
 *   - `chat`  — pure conversation. All tools are stripped; the model can
 *               only reply with text. Safe, fastest prefill (no tool
 *               definitions in the prompt), great for "explain this" /
 *               "what do you think about…" questions.
 *   - `plan`  — read-only exploration + planning. The model has access to
 *               `get_project_context`, `read_file`, `list_directory`,
 *               `find_files`, `search_web`, `fetch_url`, `recall`,
 *               `update_plan` — but nothing that
 *               mutates the workspace. It
 *               is instructed to explore and produce a `TaskState`; the
 *               UI then offers an "Apply plan" button that switches the
 *               session to `agent` mode for execution.
 *   - `agent` — full autonomy, all tools available (default today).
 */
export type AgentMode = 'chat' | 'plan' | 'agent'

export interface GpuInfo {
  index: number
  name: string
  vramTotalMb: number
  vramFreeMb: number
}

export type GpuMode = 'single' | 'split'

export interface SystemResources {
  gpus: GpuInfo[]
  cpuModel: string
  cpuCores: number
  cpuThreads: number
  ramTotalMb: number
  ramAvailableMb: number
  cudaAvailable: boolean
  cudaVersion: string | null
  hasAmdGpu: boolean
  totalVramMb: number
  platform: NodeJS.Platform
  arch: string
}

export interface BinarySelection {
  primary: string
  fallbacks: string[]
  needsCudart: boolean
  cudartAsset?: string
}

export interface LlamaReleaseInfo {
  installed: boolean
  installedVariant: string | null
  installedTag: string | null
  latestTag: string | null
  updateAvailable: boolean
  binaryPath: string | null
  error?: string
}

export interface ServerLaunchArgs {
  nGpuLayers: number
  ctxSize: number
  threads: number
  tensorSplit: string | null
  flashAttn: boolean
  cacheTypeK: string
  cacheTypeV: string
}

export interface DownloadProgress {
  downloadedMb: number
  totalMb: number
  percent: number
  status: string
}

export interface CheckpointInfo {
  sha: string
  label: string
  timestampMs: number
}

export interface AgentEvent {
  type: 'status' | 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'error' | 'command_approval' | 'hunk_review' | 'context_usage' | 'new_turn' | 'tool_streaming' | 'stream_stats' | 'task_state' | 'plan_artifact'
  content?: string
  name?: string
  args?: Record<string, unknown>
  result?: string
  done?: boolean
  approvalId?: string
  toolStreamPath?: string
  toolStreamContent?: string
  contextUsage?: {
    usedTokens: number
    budgetTokens: number
    maxContextTokens: number
    percent: number
  }
  /** Tokens per second from last completed stream (emitted after each LLM response). */
  tokensPerSecond?: number
  /** Attached to `tool_call` events for file-modifying tools: the SHA of the
   *  shadow-git commit captured right before the tool ran. The UI surfaces a
   *  "Restore" button on the tool card that hits checkpoint:restore with this
   *  SHA, so the user can undo an agent edit with one click. */
  checkpoint?: CheckpointInfo
  /** Attached to `hunk_review` events: the diff the user must approve hunk
   *  by hunk before a `write_file`/`edit_file` is applied. Reviewing is
   *  opt-in (config.approvalForFileOps) — when disabled the agent writes
   *  straight through with no prompt, exactly like before this feature. */
  hunkReview?: HunkReviewPayload
  /** Attached to `task_state` events: a snapshot of the agent's current
   *  goal/plan/notes. Emitted whenever the agent calls `update_plan`, so
   *  the UI can live-update the task panel mid-turn without waiting for
   *  the next finished assistant message. Any-typed to keep this types
   *  module free of deep imports from task-state.ts. */
  taskState?: unknown
  /** Attached to `plan_artifact` events: path to the generated PLAN.md. */
  planArtifactPath?: string
}

/** Per-file diff sent to the UI for inline hunk review. */
export interface HunkReviewPayload {
  approvalId: string
  toolName: 'write_file' | 'edit_file'
  filePath: string
  oldContent: string | null
  newContent: string
  hunks: HunkReviewHunk[]
  isNewFile: boolean
}

export interface HunkReviewHunk {
  id: number
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  additions: number
  removals: number
  lines: { kind: 'context' | 'add' | 'remove'; oldLine: number | null; newLine: number | null; text: string }[]
}

export interface AppStatus {
  serverRunning: boolean
  modelDownloaded: boolean
  modelPath: string | null
  llamaReady: boolean
  serverHealth: { status: string }
}

export interface FileTreeEntry {
  name: string
  path: string
  isDir: boolean
  children?: FileTreeEntry[]
}

export interface ModelVariant {
  quant: string
  bits: number
  label: string
  sizeMb: number
  quality: number
  repoId?: string
  family: string
}

export interface ModelFamily {
  id: string
  label: string
  description: string
  repoId: string
  defaultQuant: string
  filenameTag: string
  recommended?: boolean
}

export interface ModelVariantInfo extends ModelVariant {
  fits: boolean
  maxCtx: number
  selectableMaxCtx: number
  fullGpuMaxCtx: number
  mode: 'cpu' | 'hybrid' | 'full_gpu'
  recommended: boolean
}

export interface ToolInfo {
  name: string
  description: string
  builtin: boolean
  enabled: boolean
  id?: string
  command?: string
  parameters?: { name: string; description: string; required: boolean }[]
}

export interface WebSearchStatus {
  provider: import('./config').WebSearchProvider
  dockerAvailable: boolean
  customUrlConfigured: boolean
  effectiveBaseUrl: string | null
  healthy: boolean
  detail: string
}
