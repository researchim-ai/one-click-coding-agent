/// <reference types="vite/client" />

interface ElectronAPI {
  getStatus(): Promise<import('../electron/types').AppStatus>
  detectResources(): Promise<import('../electron/types').SystemResources>
  getModelVariants(): Promise<import('../electron/types').ModelVariantInfo[]>
  selectModelVariant(quant: string): Promise<void>
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
  restartServer(): Promise<void>
  autoSetup(): Promise<void>
  downloadModel(): Promise<string>
  ensureLlama(): Promise<void>
  startServer(): Promise<void>
  stopServer(): Promise<void>
  sendMessage(msg: string, workspace: string): Promise<string>
  resetAgent(): Promise<void>
  cancelAgent(): Promise<void>
  setWorkspace(ws: string): Promise<void>
  pickDirectory(): Promise<string | null>
  listFiles(workspace: string, dirPath?: string): Promise<import('../electron/types').FileTreeEntry[]>
  readFileContent(filePath: string): Promise<{ content: string; size: number; lines: number }>
  respondApproval(approvalId: string, approved: boolean): void

  // Session management
  createSession(): Promise<string>
  switchSession(id: string): Promise<boolean>
  listSessions(): Promise<import('../electron/agent').SessionInfo[]>
  deleteSession(id: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  getActiveSessionId(): Promise<string | null>
  saveUiMessages(id: string, msgs: any[]): Promise<void>
  getUiMessages(id: string): Promise<any[]>

  onAgentEvent(cb: (event: import('../electron/types').AgentEvent) => void): () => void
  onDownloadProgress(cb: (progress: import('../electron/types').DownloadProgress) => void): () => void
  onBuildStatus(cb: (status: string) => void): () => void
  onMenuAction(cb: (action: string) => void): () => void
  onWorkspaceFilesChanged(cb: () => void): () => void

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
