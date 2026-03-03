import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AppStatus, DownloadProgress, SystemResources } from './types'

contextBridge.exposeInMainWorld('api', {
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('get-status'),
  detectResources: (): Promise<SystemResources> => ipcRenderer.invoke('detect-resources'),
  getModelVariants: (): Promise<any[]> => ipcRenderer.invoke('get-model-variants'),
  selectModelVariant: (quant: string): Promise<void> => ipcRenderer.invoke('select-model-variant', quant),
  getConfig: (): Promise<any> => ipcRenderer.invoke('get-config'),
  saveConfig: (partial: any): Promise<any> => ipcRenderer.invoke('save-config', partial),
  getTools: (): Promise<any[]> => ipcRenderer.invoke('get-tools'),
  saveCustomTool: (tool: any): Promise<any[]> => ipcRenderer.invoke('save-custom-tool', tool),
  deleteCustomTool: (toolId: string): Promise<any[]> => ipcRenderer.invoke('delete-custom-tool', toolId),
  getPrompts: (): Promise<any> => ipcRenderer.invoke('get-prompts'),
  savePrompts: (prompts: any): Promise<void> => ipcRenderer.invoke('save-prompts', prompts),
  resetAllDefaults: (): Promise<void> => ipcRenderer.invoke('reset-all-defaults'),
  restartServer: (): Promise<{ requestedCtx: number; actualCtx: number } | void> => ipcRenderer.invoke('restart-server'),
  autoSetup: (): Promise<void> => ipcRenderer.invoke('auto-setup'),
  downloadModel: (): Promise<string> => ipcRenderer.invoke('download-model'),
  ensureLlama: (): Promise<void> => ipcRenderer.invoke('ensure-llama'),
  startServer: (): Promise<void> => ipcRenderer.invoke('start-server'),
  stopServer: (): Promise<void> => ipcRenderer.invoke('stop-server'),
  sendMessage: (msg: string, workspace: string): Promise<string> =>
    ipcRenderer.invoke('send-message', msg, workspace),
  resetAgent: (): Promise<void> => ipcRenderer.invoke('reset-agent'),
  cancelAgent: (): Promise<void> => ipcRenderer.invoke('cancel-agent'),
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
  onMenuAction: (cb: (action: string) => void) => {
    const listener = (_: any, action: string) => cb(action)
    ipcRenderer.on('menu-action', listener)
    return () => { ipcRenderer.removeListener('menu-action', listener) }
  },
  onWorkspaceFilesChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('workspace-files-changed', listener)
    return () => { ipcRenderer.removeListener('workspace-files-changed', listener) }
  },
  respondApproval: (approvalId: string, approved: boolean) => {
    ipcRenderer.send('command-approval-response', approvalId, approved)
  },

  // Session management
  createSession: (): Promise<string> => ipcRenderer.invoke('create-session'),
  switchSession: (id: string): Promise<boolean> => ipcRenderer.invoke('switch-session', id),
  listSessions: (): Promise<any[]> => ipcRenderer.invoke('list-sessions'),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke('delete-session', id),
  renameSession: (id: string, title: string): Promise<void> => ipcRenderer.invoke('rename-session', id, title),
  getActiveSessionId: (): Promise<string | null> => ipcRenderer.invoke('get-active-session-id'),
  saveUiMessages: (id: string, msgs: any[]): Promise<void> => ipcRenderer.invoke('save-ui-messages', id, msgs),
  getUiMessages: (id: string): Promise<any[]> => ipcRenderer.invoke('get-ui-messages', id),

  // File operations
  createFile: (filePath: string): Promise<void> => ipcRenderer.invoke('create-file', filePath),
  createDirectory: (dirPath: string): Promise<void> => ipcRenderer.invoke('create-directory', dirPath),
  renameFile: (oldPath: string, newPath: string): Promise<void> => ipcRenderer.invoke('rename-file', oldPath, newPath),
  deletePath: (targetPath: string): Promise<void> => ipcRenderer.invoke('delete-path', targetPath),
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('copy-to-clipboard', text),
  revealInExplorer: (targetPath: string): Promise<void> => ipcRenderer.invoke('reveal-in-explorer', targetPath),
  openInTerminalPath: (dirPath: string): Promise<string> => ipcRenderer.invoke('open-in-terminal-path', dirPath),

  // Window controls (frameless)
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('win-is-maximized'),

  // Terminal
  terminalCreate: (cwd: string): Promise<string> => ipcRenderer.invoke('terminal-create', cwd),
  terminalInput: (id: string, data: string) => ipcRenderer.send('terminal-input', id, data),
  terminalResize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal-resize', id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.send('terminal-kill', id),
  onTerminalData: (cb: (id: string, data: string) => void) => {
    const listener = (_: any, id: string, data: string) => cb(id, data)
    ipcRenderer.on('terminal-data', listener)
    return () => { ipcRenderer.removeListener('terminal-data', listener) }
  },
  onTerminalExit: (cb: (id: string, exitCode: number) => void) => {
    const listener = (_: any, id: string, exitCode: number) => cb(id, exitCode)
    ipcRenderer.on('terminal-exit', listener)
    return () => { ipcRenderer.removeListener('terminal-exit', listener) }
  },
})
