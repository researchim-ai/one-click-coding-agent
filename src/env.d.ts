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
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
