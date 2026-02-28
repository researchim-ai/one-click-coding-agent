/// <reference types="vite/client" />

interface ElectronAPI {
  getStatus(): Promise<import('../electron/types').AppStatus>
  detectResources(): Promise<import('../electron/types').SystemResources>
  autoSetup(): Promise<void>
  downloadModel(): Promise<string>
  ensureLlama(): Promise<void>
  startServer(): Promise<void>
  stopServer(): Promise<void>
  sendMessage(msg: string, workspace: string): Promise<string>
  resetAgent(): Promise<void>
  setWorkspace(ws: string): Promise<void>
  pickDirectory(): Promise<string | null>
  listFiles(workspace: string, dirPath?: string): Promise<import('../electron/types').FileTreeEntry[]>
  readFileContent(filePath: string): Promise<{ content: string; size: number; lines: number }>
  respondApproval(approvalId: string, approved: boolean): void
  onAgentEvent(cb: (event: import('../electron/types').AgentEvent) => void): () => void
  onDownloadProgress(cb: (progress: import('../electron/types').DownloadProgress) => void): () => void
  onBuildStatus(cb: (status: string) => void): () => void

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
