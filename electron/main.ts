import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron'
import path from 'path'
import fs from 'fs'
import type { FileTreeEntry } from './types'

if (process.env.ELECTRON_NO_SANDBOX || process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.disableHardwareAcceleration()
}
import { detect, evaluateVariants } from './resources'
import * as modelManager from './model-manager'
import * as serverManager from './server-manager'
import {
  runAgent, resetAgent, setWorkspace, cancelAgent,
  createSession, switchSession, listSessions, deleteSession,
  renameSession, getActiveSessionId, initSessions,
  saveUiMessages, getUiMessages,
  type SessionInfo,
} from './agent'
import * as terminalManager from './terminal-manager'

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'One-Click Coding Agent',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  initSessions()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  terminalManager.killAll()
  serverManager.stop()
  if (process.platform !== 'darwin') app.quit()
})

function registerIpcHandlers() {
  ipcMain.handle('detect-resources', () => detect())

  ipcMain.handle('get-model-variants', () => evaluateVariants(detect()))

  ipcMain.handle('select-model-variant', (_e, quant: string) => {
    modelManager.setSelectedQuant(quant)
  })

  ipcMain.handle('get-status', async () => {
    const running = serverManager.isRunning()
    return {
      serverRunning: running,
      modelDownloaded: modelManager.isDownloaded(),
      modelPath: modelManager.getModelPath(),
      llamaReady: serverManager.isReady(),
      serverHealth: running ? await serverManager.health() : { status: 'stopped' },
    }
  })

  ipcMain.handle('download-model', async () => {
    if (!mainWindow) throw new Error('No window')
    return modelManager.download(mainWindow)
  })

  ipcMain.handle('ensure-llama', async () => {
    if (!mainWindow) throw new Error('No window')
    await serverManager.ensureBinary(mainWindow)
  })

  ipcMain.handle('start-server', async () => {
    const modelPath = modelManager.getModelPath()
    if (!modelPath) throw new Error('Модель не скачана')
    if (!serverManager.isReady()) throw new Error('llama-server не установлен')
    serverManager.start(modelPath, mainWindow ?? undefined, undefined, modelManager.getSelectedQuant())
    await serverManager.waitReady(300, mainWindow ?? undefined)
  })

  ipcMain.handle('stop-server', () => {
    serverManager.stop()
  })

  ipcMain.handle('auto-setup', async () => {
    if (!mainWindow) throw new Error('No window')

    if (!serverManager.isReady()) {
      await serverManager.ensureBinary(mainWindow)
    }

    let modelPath = modelManager.getModelPath()
    if (!modelPath) {
      modelPath = await modelManager.download(mainWindow)
    }

    if (!serverManager.isRunning()) {
      serverManager.start(modelPath, mainWindow ?? undefined, undefined, modelManager.getSelectedQuant())
      await serverManager.waitReady(300, mainWindow ?? undefined)
    }
  })

  ipcMain.handle('send-message', async (_e, msg: string, workspace: string) => {
    if (!mainWindow) throw new Error('No window')
    return runAgent(msg, workspace, mainWindow)
  })

  ipcMain.handle('cancel-agent', () => cancelAgent())

  ipcMain.handle('reset-agent', () => resetAgent())
  ipcMain.handle('set-workspace', (_e, ws: string) => setWorkspace(ws))

  // Session management
  ipcMain.handle('create-session', () => createSession())
  ipcMain.handle('switch-session', (_e, id: string) => switchSession(id))
  ipcMain.handle('list-sessions', () => listSessions())
  ipcMain.handle('delete-session', (_e, id: string) => deleteSession(id))
  ipcMain.handle('rename-session', (_e, id: string, title: string) => renameSession(id, title))
  ipcMain.handle('get-active-session-id', () => getActiveSessionId())
  ipcMain.handle('save-ui-messages', (_e, id: string, msgs: any[]) => saveUiMessages(id, msgs))
  ipcMain.handle('get-ui-messages', (_e, id: string) => getUiMessages(id))

  ipcMain.handle('pick-directory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Выбери рабочую директорию проекта',
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  const IGNORED = new Set([
    'node_modules', '.git', '__pycache__', '.next', '.nuxt',
    'dist', 'build', '.cache', '.venv', 'venv', 'env',
    '.tox', 'coverage', '.nyc_output', '.turbo', 'target',
    'dist-electron', '.one-click-agent',
  ])

  function readTree(dir: string, depth: number): FileTreeEntry[] {
    if (depth <= 0) return []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map((e) => {
        const fullPath = path.join(dir, e.name)
        if (e.isDirectory()) {
          return { name: e.name, path: fullPath, isDir: true, children: readTree(fullPath, depth - 1) }
        }
        return { name: e.name, path: fullPath, isDir: false }
      })
  }

  ipcMain.handle('list-files', (_e, workspace: string, dirPath?: string) => {
    const target = dirPath ?? workspace
    if (!target) return []
    return readTree(target, 4)
  })

  ipcMain.handle('read-file-content', (_e, filePath: string) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const stat = fs.statSync(filePath)
      return { content, size: stat.size, lines: content.split('\n').length }
    } catch (e: any) {
      throw new Error(`Cannot read file: ${e.message}`)
    }
  })

  // File creation
  ipcMain.handle('create-file', (_e, filePath: string) => {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', 'utf-8')
    }
  })

  ipcMain.handle('create-directory', (_e, dirPath: string) => {
    fs.mkdirSync(dirPath, { recursive: true })
  })

  // File operations
  ipcMain.handle('rename-file', (_e, oldPath: string, newPath: string) => {
    const dir = path.dirname(newPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.renameSync(oldPath, newPath)
  })

  ipcMain.handle('delete-path', (_e, targetPath: string) => {
    const stat = fs.statSync(targetPath)
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(targetPath)
    }
  })

  ipcMain.handle('copy-to-clipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('reveal-in-explorer', (_e, targetPath: string) => {
    shell.showItemInFolder(targetPath)
  })

  ipcMain.handle('open-in-terminal-path', (_e, dirPath: string) => {
    if (!mainWindow) throw new Error('No window')
    return terminalManager.create(dirPath, mainWindow)
  })

  // Terminal IPC
  ipcMain.handle('terminal-create', (_e, cwd: string) => {
    if (!mainWindow) throw new Error('No window')
    return terminalManager.create(cwd, mainWindow)
  })

  ipcMain.on('terminal-input', (_e, id: string, data: string) => {
    terminalManager.write(id, data)
  })

  ipcMain.on('terminal-resize', (_e, id: string, cols: number, rows: number) => {
    terminalManager.resize(id, cols, rows)
  })

  ipcMain.on('terminal-kill', (_e, id: string) => {
    terminalManager.kill(id)
  })
}
