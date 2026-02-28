import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import type { FileTreeEntry } from './types'

if (process.env.ELECTRON_NO_SANDBOX || process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.disableHardwareAcceleration()
}
import { detect } from './resources'
import * as modelManager from './model-manager'
import * as serverManager from './server-manager'
import { runAgent, resetAgent, setWorkspace } from './agent'

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
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  serverManager.stop()
  if (process.platform !== 'darwin') app.quit()
})

function registerIpcHandlers() {
  ipcMain.handle('detect-resources', () => detect())

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
    serverManager.start(modelPath, mainWindow ?? undefined)
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
      serverManager.start(modelPath, mainWindow ?? undefined)
      await serverManager.waitReady(300, mainWindow ?? undefined)
    }
  })

  ipcMain.handle('send-message', async (_e, msg: string, workspace: string) => {
    if (!mainWindow) throw new Error('No window')
    return runAgent(msg, workspace, mainWindow)
  })

  ipcMain.handle('reset-agent', () => resetAgent())
  ipcMain.handle('set-workspace', (_e, ws: string) => setWorkspace(ws))

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
}
