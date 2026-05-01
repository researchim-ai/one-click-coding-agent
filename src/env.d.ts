/// <reference types="vite/client" />

interface ElectronAPI {
  getStatus(): Promise<import('../electron/types').AppStatus>
  detectResources(): Promise<import('../electron/types').SystemResources>
  getModelVariants(
    override?: Pick<import('../electron/config').AppConfig, 'gpuMode' | 'gpuIndex'>
  ): Promise<import('../electron/types').ModelVariantInfo[]>
  getModelFamilies(): Promise<import('../electron/types').ModelFamily[]>
  selectModelVariant(quant: string): Promise<void>
  getWebSearchStatus(
    override?: Partial<import('../electron/config').AppConfig>
  ): Promise<import('../electron/types').WebSearchStatus>
  ensureWebSearch(
    override?: Partial<import('../electron/config').AppConfig>
  ): Promise<import('../electron/types').WebSearchStatus>
  setAppLanguage(lang: 'ru' | 'en'): Promise<import('../electron/config').AppConfig>
  openExternalUrl(url: string): Promise<boolean>
  getConfig(): Promise<import('../electron/config').AppConfig>
  saveConfig(partial: Partial<import('../electron/config').AppConfig>): Promise<import('../electron/config').AppConfig>
  getTools(): Promise<import('../electron/types').ToolInfo[]>
  saveCustomTool(tool: import('../electron/config').CustomTool): Promise<import('../electron/config').CustomTool[]>
  deleteCustomTool(toolId: string): Promise<import('../electron/config').CustomTool[]>
  getPrompts(): Promise<{
    systemPrompt: string | null
    summarizePrompt: string | null
    defaultSystemPrompt: string
    defaultSummarizePrompt: string
  }>
  savePrompts(prompts: { systemPrompt?: string | null; summarizePrompt?: string | null }): Promise<void>
  resetAllDefaults(): Promise<void>
  restartServer(): Promise<{ requestedCtx: number; actualCtx: number } | void>
  autoSetup(): Promise<void>
  downloadModel(): Promise<string>
  ensureLlama(): Promise<void>
  getLlamaReleaseInfo(): Promise<import('../electron/types').LlamaReleaseInfo>
  updateLlama(): Promise<import('../electron/types').LlamaReleaseInfo>
  startServer(): Promise<void>
  stopServer(): Promise<void>
  sendMessage(msg: string, workspace: string): Promise<string>
  resetAgent(workspace: string): Promise<void>
  cancelAgent(): Promise<void>
  setWorkspace(ws: string): Promise<void>
  getRecentWorkspaces(): Promise<string[]>
  pickDirectory(): Promise<string | null>
  listFiles(workspace: string, dirPath?: string): Promise<import('../electron/types').FileTreeEntry[]>
  getGitStatus(workspace: string): Promise<import('../electron/git').GitStatus>
  getGitNumstat(workspace: string): Promise<import('../electron/git').GitNumstatEntry[]>
  getGitFileAtHead(workspace: string, relativePath: string): Promise<string | null>
  getGitFileDiff(workspace: string, filePath: string, currentContent?: string): Promise<import('../electron/git').GitFileDiff>
  discardGitFileChanges(workspace: string, filePath: string): Promise<{ ok: true; deleted: boolean; path: string }>
  readFileContent(filePath: string): Promise<{ content: string; size: number; lines: number }>
  writeFile(filePath: string, content: string): Promise<void>
  tsGetDefinition(workspacePath: string, filePath: string, fileContent: string, line: number, column: number): Promise<{ path: string; startLine: number; startColumn: number; endLine: number; endColumn: number } | null>
  tsGetHover(workspacePath: string, filePath: string, fileContent: string, line: number, column: number): Promise<{ contents: string } | null>
  tsGetCompletions(workspacePath: string, filePath: string, fileContent: string, line: number, column: number): Promise<{ label: string; kind: number; insertText?: string; detail?: string }[]>
  tsGetDiagnostics(workspacePath: string, filePath: string, fileContent?: string): Promise<{ line: number; column: number; message: string; severity: 'error' | 'warning' }[]>
  pyResolveModule(workspacePath: string, moduleName: string): Promise<string | null>
  respondApproval(approvalId: string, approved: boolean): void
  respondHunkReview(
    approvalId: string,
    decision:
      | { decision: 'accept_all' }
      | { decision: 'accept_selected'; selectedHunkIds: number[] }
      | { decision: 'reject' },
  ): void
  getTaskState(workspace: string, sessionId?: string): Promise<import('../electron/task-state').TaskState | null>

  // Session management (workspace-scoped)
  createSession(workspace: string): Promise<string>
  switchSession(workspace: string, id: string): Promise<boolean>
  listSessions(workspace: string): Promise<import('../electron/agent').SessionInfo[]>
  deleteSession(workspace: string, id: string): Promise<void>
  renameSession(workspace: string, id: string, title: string): Promise<void>
  getActiveSessionId(workspace: string): Promise<string | null>
  saveUiMessages(workspace: string, id: string, msgs: any[]): Promise<void>
  getUiMessages(workspace: string, id: string): Promise<any[]>
  setSessionMode(
    workspace: string,
    id: string,
    mode: import('../electron/types').AgentMode,
  ): Promise<import('../electron/types').AgentMode | null>
  savePlanArtifact(workspace: string, id?: string, content?: string): Promise<{ path: string; content: string }>

  // Shadow-git checkpoints
  listCheckpoints(workspace: string, limit?: number): Promise<import('../electron/types').CheckpointInfo[]>
  restoreCheckpoint(
    workspace: string,
    sha: string,
  ): Promise<{ ok: boolean; safety: import('../electron/types').CheckpointInfo | null }>
  createCheckpoint(workspace: string, label: string): Promise<import('../electron/types').CheckpointInfo | null>
  checkpointDiffStat(workspace: string, sha: string): Promise<string>

  // Project rules info (AGENTS.md / CLAUDE.md / .cursorrules / .cursor/rules/*)
  getProjectRulesInfo(workspace: string): Promise<{
    files: { path: string; relativePath: string; bytes: number }[]
    truncated: boolean
    totalBytes: number
  }>

  // /context breakdown + message pinning
  getContextBreakdown(workspace: string): Promise<{
    usedTokens: number
    budgetTokens: number
    maxContextTokens: number
    percent: number
    categories: { key: string; label: string; tokens: number; messages: number }[]
    cache: { hits: number; misses: number; size: number }
  } | null>
  togglePin(workspace: string, messageId: string): Promise<{ pinned: boolean }>
  getPinnedMessages(workspace: string): Promise<string[]>

  // MCP (Model Context Protocol)
  mcpListServers(): Promise<import('../electron/config').McpServerConfig[]>
  mcpGetStatus(): Promise<import('../electron/mcp').McpServerStatus[]>
  mcpGetTools(): Promise<{ qualifiedName: string; serverId: string; rawName: string; description: string }[]>
  mcpGetStderrTail(serverId: string): Promise<string>
  mcpSaveServer(server: import('../electron/config').McpServerConfig): Promise<import('../electron/mcp').McpServerStatus[]>
  mcpDeleteServer(serverId: string): Promise<import('../electron/mcp').McpServerStatus[]>
  mcpConnect(serverId: string): Promise<import('../electron/mcp').McpServerStatus>
  mcpDisconnect(serverId: string): Promise<import('../electron/mcp').McpServerStatus[]>

  onAgentEvent(cb: (event: import('../electron/types').AgentEvent) => void): () => void
  onDownloadProgress(cb: (progress: import('../electron/types').DownloadProgress) => void): () => void
  onBuildStatus(cb: (status: string) => void): () => void
  onMenuAction(cb: (action: string, payload?: unknown) => void): () => void
  onAppLanguageChanged(cb: (lang: 'ru' | 'en') => void): () => void
  onWorkspaceFilesChanged(cb: () => void): () => void

  // Window controls
  winMinimize(): void
  winMaximize(): void
  winClose(): void
  winIsMaximized(): Promise<boolean>

  // File operations
  createFile(filePath: string): Promise<void>
  createDirectory(dirPath: string): Promise<void>
  renameFile(oldPath: string, newPath: string): Promise<void>
  deletePath(targetPath: string): Promise<void>
  copyToClipboard(text: string): Promise<void>
  revealInExplorer(targetPath: string): Promise<void>
  openInTerminalPath(dirPath: string): Promise<string>

  // Terminal
  terminalCreate(cwd: string): Promise<string>
  terminalInput(id: string, data: string): void
  terminalResize(id: string, cols: number, rows: number): void
  terminalKill(id: string): void
  onTerminalData(cb: (id: string, data: string) => void): () => void
  onTerminalExit(cb: (id: string, exitCode: number) => void): () => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
