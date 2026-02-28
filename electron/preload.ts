import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AppStatus, DownloadProgress, SystemResources } from './types'

contextBridge.exposeInMainWorld('api', {
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('get-status'),
  detectResources: (): Promise<SystemResources> => ipcRenderer.invoke('detect-resources'),
  autoSetup: (): Promise<void> => ipcRenderer.invoke('auto-setup'),
  downloadModel: (): Promise<string> => ipcRenderer.invoke('download-model'),
  ensureLlama: (): Promise<void> => ipcRenderer.invoke('ensure-llama'),
  startServer: (): Promise<void> => ipcRenderer.invoke('start-server'),
  stopServer: (): Promise<void> => ipcRenderer.invoke('stop-server'),
  sendMessage: (msg: string, workspace: string): Promise<string> =>
    ipcRenderer.invoke('send-message', msg, workspace),
  resetAgent: (): Promise<void> => ipcRenderer.invoke('reset-agent'),
  setWorkspace: (ws: string): Promise<void> => ipcRenderer.invoke('set-workspace', ws),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('pick-directory'),
  listFiles: (workspace: string, dirPath?: string): Promise<import('./types').FileTreeEntry[]> =>
    ipcRenderer.invoke('list-files', workspace, dirPath),
  readFileContent: (filePath: string): Promise<{ content: string; size: number; lines: number }> =>
    ipcRenderer.invoke('read-file-content', filePath),

  onAgentEvent: (cb: (event: AgentEvent) => void) => {
    const listener = (_: any, data: AgentEvent) => cb(data)
    ipcRenderer.on('agent-event', listener)
    return () => { ipcRenderer.removeListener('agent-event', listener) }
  },
  onDownloadProgress: (cb: (progress: DownloadProgress) => void) => {
    const listener = (_: any, data: DownloadProgress) => cb(data)
    ipcRenderer.on('download-progress', listener)
    return () => { ipcRenderer.removeListener('download-progress', listener) }
  },
  onBuildStatus: (cb: (status: string) => void) => {
    const listener = (_: any, data: string) => cb(data)
    ipcRenderer.on('build-status', listener)
    return () => { ipcRenderer.removeListener('build-status', listener) }
  },
  respondApproval: (approvalId: string, approved: boolean) => {
    ipcRenderer.send('command-approval-response', approvalId, approved)
  },
})
