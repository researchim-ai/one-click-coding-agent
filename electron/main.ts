import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, globalShortcut } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Worker } from 'worker_threads'
import type { FileTreeEntry } from './types'

const SESSION_WRITE_YIELD_EVERY = 12 // yield to event loop every N messages (avoids "app not responding" with huge context)

nativeTheme.themeSource = 'dark'

// Force dark GTK theme for native menu bar on Linux
if (process.platform === 'linux') {
  process.env.GTK_THEME = 'Adwaita:dark'
  app.commandLine.appendSwitch('force-dark-mode')
}
// Force dark title bar on Windows
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('force-dark-mode')
}

if (process.env.ELECTRON_NO_SANDBOX || process.argv.includes('--no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.disableHardwareAcceleration()
}
import { detect, evaluateVariants, loadModelArch, getArch, applyGpuPreferences, computeOptimalArgs } from './resources'
import * as modelManager from './model-manager'
import * as serverManager from './server-manager'
import * as config from './config'
import * as checkpoints from './checkpoints'
import { describeProjectRules } from './project-rules'
import * as mcp from './mcp'
import { TOOL_DEFINITIONS } from './tools'
import { MODEL_FAMILIES } from './resources'
import { normalizeTaskState } from './task-state'
import { ensureWebSearchBackend, getWebSearchStatus } from './searxng'
import {
  runAgent, resetAgent, setWorkspace, cancelAgent,
  createSession, switchSession, listSessions, deleteSession,
  renameSession, getActiveSessionId, initSessions,
  saveUiMessages, getUiMessages,
  getActiveSession, getSessionPathForWorker, saveSession as persistSession, isCancelRequested,
  updateSessionFromWorker,
  computeContextBreakdown, toggleMessagePin, listPinnedMessages,
  setSessionMode,
  savePlanArtifact, savePlanArtifactContent,
  DEFAULT_SYSTEM_PROMPT, DEFAULT_SUMMARIZE_PROMPT,
  type SessionInfo, type AgentBridge,
} from './agent'
import type { AgentMode } from './types'
import * as terminalManager from './terminal-manager'
import * as tsService from './ts-service'
import * as pyResolve from './py-resolve'
import * as git from './git'
import * as recentWorkspaces from './recent-workspaces'
import * as workspaceWatcher from './workspace-watcher'
import type { ToolInfo } from './types'

let mainWindow: BrowserWindow | null = null
let agentWorker: Worker | null = null
let pendingSendResolve: ((result: string) => void) | null = null

const WORKSPACE_CHANGED_DEBOUNCE_MS = 1200
let workspaceChangedTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWorkspaceChangedNotify(): void {
  if (workspaceChangedTimer) clearTimeout(workspaceChangedTimer)
  workspaceChangedTimer = setTimeout(() => {
    workspaceChangedTimer = null
    try { mainWindow?.webContents.send('workspace-files-changed') } catch {}
  }, WORKSPACE_CHANGED_DEBOUNCE_MS)
}

let ensureServerInFlight: Promise<void> | null = null

/** Quick TCP-level probe — `isRunning()` only tells us the child process hasn't
 *  died, but the HTTP server can be unreachable (zombie process, port still
 *  bound but accept loop gone, early-init crash) and the worker would just get
 *  `fetch failed`. We want to catch that before kicking off a request. */
async function probeServerReachable(): Promise<boolean> {
  const url = `${serverManager.llamaApiUrl()}/health`
  const startedAt = Date.now()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
    const body = await r.text().catch(() => '')
    const ok = r.ok || r.status < 500
    console.log(`[probe] GET ${url} -> ${r.status} (${Date.now() - startedAt}ms), ok=${ok}, body=${body.slice(0, 160)}`)
    return ok
  } catch (e: any) {
    console.log(`[probe] GET ${url} FAILED (${Date.now() - startedAt}ms): ${e?.name ?? ''} ${e?.message ?? e}`)
    return false
  }
}

/** Make sure llama-server is up before running the agent. Auto-starts it if it
 *  isn't, so `send-message` never silently fails with `fetch failed` when the
 *  process died (crash, app restart race, user stopped it, etc).
 *
 *  We check both the process handle AND a live `/health` probe — llama.cpp can
 *  get into weird zombie states (socket still bound, accept loop dead) that
 *  `isRunning()` alone wouldn't catch. */
async function ensureLlamaServerRunning(): Promise<void> {
  if (ensureServerInFlight) {
    console.log('[ensure-server] already in flight, awaiting existing promise')
    return ensureServerInFlight
  }

  const alive = serverManager.isRunning()
  const pid = serverManager.getServerProcessPid()
  console.log(`[ensure-server] enter: isRunning=${alive}, pid=${pid}`)

  // If the process is alive AND the socket is reachable, we're done.
  if (alive) {
    const reachable = await probeServerReachable()
    if (reachable) {
      console.log('[ensure-server] process alive AND reachable — no-op')
      return
    }
    console.log('[ensure-server] process alive but socket NOT reachable — will restart')
  }

  ensureServerInFlight = (async () => {
    // Process might be alive but wedged — tear it down before starting a new
    // one so we don't fight over the port.
    if (serverManager.isRunning()) {
      console.log('[ensure-server] stopping wedged process…')
      serverManager.stop()
      await new Promise((r) => setTimeout(r, 1000))
    }

    if (!serverManager.isReady()) {
      if (!mainWindow) throw new Error('llama-server не установлен')
      console.log('[ensure-server] binary missing, downloading…')
      await serverManager.ensureBinary(mainWindow)
    }

    const modelPath = modelManager.getModelPath()
    if (!modelPath) {
      throw new Error(`Модель не найдена на диске. Квант: ${modelManager.getSelectedQuant()}. Запустите установку через окно настроек.`)
    }

    loadModelArch(modelPath)
    const ctxSize = config.get('ctxSize')
    const quant = modelManager.getSelectedQuant()

    // Retry loop: if the server crashes with OOM (Vulkan/CUDA allocate fail),
    // progressively offload more layers to CPU/RAM until it starts cleanly.
    // 1.0 = what the calculator picked, each attempt halves nGpuLayers, then 0.
    const cfg = config.load()
    const res = applyGpuPreferences(detect(), cfg.gpuMode, cfg.gpuIndex)
    const baseArgs = computeOptimalArgs(res, quant, ctxSize)
    const arch = getArch()
    const fullLayers = Math.min(baseArgs.nGpuLayers === 999 ? arch.blockCount : baseArgs.nGpuLayers, arch.blockCount)
    let schedule = [
      fullLayers,
      Math.floor(fullLayers * 0.75),
      Math.floor(fullLayers * 0.5),
      Math.floor(fullLayers * 0.25),
      0,
    ].filter((v, i, a) => v >= 0 && a.indexOf(v) === i)

    // If the previous run crashed with OOM, skip layer counts >= whatever we
    // tried last — going back to them is guaranteed to OOM again.
    const prevReason = serverManager.getLastCrashReason()
    const prevArgs = serverManager.getLastLaunchArgs()
    if (prevReason === 'oom' && prevArgs) {
      const prevN = prevArgs.nGpuLayers === 999 ? arch.blockCount : prevArgs.nGpuLayers
      const trimmed = schedule.filter((v) => v < prevN)
      if (trimmed.length > 0) {
        console.log(`[ensure-server] previous run OOM'd at nGpuLayers=${prevN}, skipping higher attempts. schedule=${trimmed.join(',')}`)
        schedule = trimmed
      }
    }
    const layerSchedule = schedule

    let lastErr: any = null
    for (let attempt = 0; attempt < layerSchedule.length; attempt++) {
      const n = layerSchedule[attempt]
      const attemptArgs = attempt === 0 && baseArgs.nGpuLayers === 999
        ? baseArgs   // keep 999 ("all") sentinel on first try — lets llama.cpp spill safely.
        : { ...baseArgs, nGpuLayers: n, flashAttn: n > 0 ? baseArgs.flashAttn : false }

      console.log(`[ensure-server] attempt ${attempt + 1}/${layerSchedule.length}: quant=${quant}, ctx=${attemptArgs.ctxSize}, nGpuLayers=${attemptArgs.nGpuLayers} (full=${fullLayers})`)
      if (mainWindow) {
        const statusText = attempt === 0
          ? `⏳ Запускаю llama.cpp (ctx=${attemptArgs.ctxSize}, GPU-слоёв: ${attemptArgs.nGpuLayers})…`
          : `⚠ Не хватило памяти — пробую с ${attemptArgs.nGpuLayers} GPU-слоями (остальное в RAM)…`
        try {
          mainWindow.webContents.send('agent-event', {
            type: 'status',
            content: statusText,
          })
          mainWindow.webContents.send('build-status', statusText)
        } catch {}
      }

      try {
        serverManager.start(modelPath, mainWindow ?? undefined, attemptArgs, quant, ctxSize)
        const spawnedPid = serverManager.getServerProcessPid()
        console.log(`[ensure-server] waiting for /health ok (pid=${spawnedPid}, timeout=300s)…`)
        await serverManager.waitReady(300, mainWindow ?? undefined)
        console.log(`[ensure-server] READY: pid=${spawnedPid}, actual_ctx=${serverManager.getCtxSize()}, nGpuLayers=${attemptArgs.nGpuLayers}`)
        return
      } catch (err: any) {
        lastErr = err
        // Clean up before next attempt
        if (serverManager.isRunning()) serverManager.stop()
        // Give the exit handler a moment to fire + scan log for OOM markers.
        await new Promise((r) => setTimeout(r, 1200))
        const reason = serverManager.getLastCrashReason()
        console.error(`[ensure-server] attempt ${attempt + 1} failed: ${err?.message ?? err} (crashReason=${reason})`)
        // Only retry for OOM; other errors (missing binary, bad model) won't
        // be fixed by fewer GPU layers, so fail fast.
        if (reason !== 'oom') throw err
        if (attempt + 1 >= layerSchedule.length) break
      }
    }
    throw lastErr ?? new Error('llama-server не стартовал (OOM)')
  })().finally(() => { ensureServerInFlight = null })

  return ensureServerInFlight
}

/** When a stream fetch blows up with "fetch failed" it almost always means
 *  llama-server crashed or closed the connection. `/health` and the process
 *  handle can lie for a few seconds (zombie state), so before we re-emit the
 *  error to the UI we tail the server log and tack the real reason on. */
function enrichAgentEvent(event: any): any {
  if (!event || event.type !== 'error' || typeof event.content !== 'string') return event
  const msg = event.content
  const isFetchErr = /fetch failed/i.test(msg) || /ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg)
  if (!isFetchErr) return event

  const exit = serverManager.getLastExitInfo()
  const pid = serverManager.getServerProcessPid()
  const alive = serverManager.isRunning()
  const tail = serverManager.getServerLogTail(25) || '(пусто)'

  console.log(`[agent-error] fetch failed. serverRunning=${alive}, pid=${pid}, exit=${JSON.stringify(exit)}`)
  console.log(`[agent-error] server log tail:\n${tail}`)

  let diag = `\n\n— diagnostics —\nllama-server: ${alive ? 'alive' : 'dead'}`
  if (pid) diag += `, pid=${pid}`
  if (exit) {
    const ago = ((Date.now() - exit.at) / 1000).toFixed(1)
    diag += `\nlast exit: code=${exit.code}, signal=${exit.signal ?? '—'}, ${ago}s назад`
  }
  diag += `\nserver log tail (последние ${tail.split('\n').length} строк, полный файл: ${serverManager.serverLogPath()}):\n${tail}`

  // Kick off a restart so the NEXT message has a live server. Non-blocking.
  if (!alive) {
    console.log('[agent-error] scheduling server restart after fetch failed')
    ensureLlamaServerRunning().catch((e) => console.error('[agent-error] restart failed:', e?.message ?? e))
  }

  return { ...event, content: `${msg}${diag}` }
}

function getAgentWorker(): Worker {
  if (!agentWorker) {
    const workerPath = path.join(__dirname, 'agent-worker.js')
    agentWorker = new Worker(workerPath, { stdout: true, stderr: true })
    agentWorker.on('message', (msg: any) => {
      if (msg.type === 'emit' && mainWindow) {
        try { mainWindow.webContents.send('agent-event', enrichAgentEvent(msg.event)) } catch {}
      } else if (msg.type === 'approval' && mainWindow) {
        const handler = (_: any, responseId: string, approved: boolean) => {
          if (responseId === msg.approvalId) {
            ipcMain.removeListener('command-approval-response', handler)
            agentWorker?.postMessage({ type: 'approval-result', approvalId: msg.approvalId, approved })
          }
        }
        ipcMain.on('command-approval-response', handler)
        try { mainWindow.webContents.send('agent-event', { type: 'command_approval', name: msg.name, args: msg.args, approvalId: msg.approvalId }) } catch {}
      } else if (msg.type === 'hunk-review' && mainWindow) {
        // Renderer replies via ipcMain 'hunk-review-response' carrying the user's
        // per-hunk decision. The hunk-review event itself was already emitted by
        // the agent (see runAgent → reviewAndApplyWrite), so we only wire the
        // response channel here.
        const review = msg.review as import('./types').HunkReviewPayload
        const handler = (_: any, responseId: string, decision: import('./agent').HunkReviewDecision) => {
          if (responseId === review.approvalId) {
            ipcMain.removeListener('hunk-review-response', handler)
            agentWorker?.postMessage({ type: 'hunk-review-result', approvalId: review.approvalId, decision })
          }
        }
        ipcMain.on('hunk-review-response', handler)
      } else if (msg.type === 'workspace-changed' && mainWindow) {
        scheduleWorkspaceChangedNotify()
      } else if (msg.type === 'session-update') {
        updateSessionFromWorker(msg.session)
      } else if (msg.type === 'query-ctx') {
        serverManager.queryActualCtxSize().then(() => {
          agentWorker?.postMessage({ type: 'query-ctx-result', id: msg.id, ctxSize: serverManager.getCtxSize() })
        }).catch(() => {
          agentWorker?.postMessage({ type: 'query-ctx-result', id: msg.id, ctxSize: serverManager.getCtxSize() })
        })
      } else if (msg.type === 'mcp-call') {
        mcp.callTool(msg.qualifiedName, msg.args)
          .then((result) => {
            agentWorker?.postMessage({ type: 'mcp-call-result', id: msg.id, result })
          })
          .catch((err: any) => {
            agentWorker?.postMessage({ type: 'mcp-call-result', id: msg.id, error: err?.message ?? String(err) })
          })
      } else if (msg.type === 'done') {
        if (msg.session) updateSessionFromWorker(msg.session, true)
        if (pendingSendResolve) {
          pendingSendResolve(msg.result ?? '')
          pendingSendResolve = null
        }
      }
    })
    agentWorker.on('error', (err) => {
      if (pendingSendResolve) {
        pendingSendResolve(`Error: ${err.message}`)
        pendingSendResolve = null
      }
    })
  }
  return agentWorker
}

function createMainBridge(win: BrowserWindow): AgentBridge {
  return {
    emit(e) {
      try { win.webContents.send('agent-event', e) } catch {}
    },
    requestApproval(name: string, args: Record<string, any>) {
      return new Promise((resolve) => {
        const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const handler = (_: any, responseId: string, approved: boolean) => {
          if (responseId === id) {
            ipcMain.removeListener('command-approval-response', handler)
            resolve(approved)
          }
        }
        ipcMain.on('command-approval-response', handler)
        try { win.webContents.send('agent-event', { type: 'command_approval', name, args, approvalId: id }) } catch {}
      })
    },
    requestHunkReview(review) {
      return new Promise((resolve) => {
        const handler = (_: any, responseId: string, decision: import('./agent').HunkReviewDecision) => {
          if (responseId === review.approvalId) {
            ipcMain.removeListener('hunk-review-response', handler)
            resolve(decision)
          }
        }
        ipcMain.on('hunk-review-response', handler)
      })
    },
    getConfig() { return config.load() },
    getSession() { return getActiveSession('') },
    saveSession(s) { persistSession(s) },
    getApiUrl() { return serverManager.llamaApiUrl() },
    getCtxSize() { return serverManager.getCtxSize() },
    setCtxSize(n) { serverManager.setCtxSize(n) },
    async queryActualCtxSize() { await serverManager.queryActualCtxSize() },
    isCancelRequested() { return isCancelRequested() },
    notifyWorkspaceChanged() { scheduleWorkspaceChangedNotify() },
    listMcpToolDefs() {
      return mcp.listAllTools().map((t) => ({
        qualifiedName: t.qualifiedName,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    },
    callMcpTool(name: string, args: Record<string, any>) {
      return mcp.callTool(name, args)
    },
  }
}

function sendMenuAction(action: string, payload?: unknown) {
  if (payload !== undefined) {
    mainWindow?.webContents.send('menu-action', action, payload)
  } else {
    mainWindow?.webContents.send('menu-action', action)
  }
}

const MENU_STRINGS: Record<config.AppLanguage, Record<string, string>> = {
  ru: {
    about: 'О программе',
    quit: 'Выход',
    file: 'Файл',
    openFolder: 'Открыть папку…',
    chooseFolder: 'Выберите папку проекта',
    recent: 'Недавние',
    noRecent: '(нет недавних проектов)',
    agent: 'Агент',
    newChat: 'Новый чат',
    stopRequest: 'Остановить запрос',
    resetContext: 'Сброс контекста',
    settings: 'Настройки',
    settingsModel: 'Модель и контекст…',
    settingsTools: 'Инструменты…',
    settingsPrompts: 'Промпты агента…',
    settingsWebSearch: 'Веб-поиск…',
    resetAll: 'Сбросить всё по умолчанию',
    resetTitle: 'Сброс настроек',
    resetMessage: 'Все настройки будут сброшены к значениям по умолчанию: квантизация, контекст, промпты, пользовательские инструменты.',
    resetCancel: 'Отмена',
    resetConfirm: 'Сбросить',
    edit: 'Правка',
    undo: 'Отменить',
    redo: 'Повторить',
    cut: 'Вырезать',
    copy: 'Копировать',
    paste: 'Вставить',
    selectAll: 'Выделить всё',
    view: 'Вид',
    terminal: 'Терминал',
    sidebar: 'Боковая панель',
    reload: 'Перезагрузить',
    devTools: 'Инструменты разработчика',
    resetZoom: 'Сбросить масштаб',
    zoomIn: 'Увеличить',
    zoomOut: 'Уменьшить',
    fullscreen: 'Полноэкранный режим',
    help: 'Помощь',
    github: 'GitHub репозиторий',
    language: 'Язык',
    languageRu: 'Русский',
    languageEn: 'English',
  },
  en: {
    about: 'About',
    quit: 'Quit',
    file: 'File',
    openFolder: 'Open folder…',
    chooseFolder: 'Choose project folder',
    recent: 'Recent',
    noRecent: '(no recent projects)',
    agent: 'Agent',
    newChat: 'New chat',
    stopRequest: 'Stop request',
    resetContext: 'Reset context',
    settings: 'Settings',
    settingsModel: 'Model & context…',
    settingsTools: 'Tools…',
    settingsPrompts: 'Agent prompts…',
    settingsWebSearch: 'Web search…',
    resetAll: 'Reset everything to defaults',
    resetTitle: 'Reset settings',
    resetMessage: 'All settings will be reset to defaults: quantization, context, prompts, custom tools.',
    resetCancel: 'Cancel',
    resetConfirm: 'Reset',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    terminal: 'Terminal',
    sidebar: 'Sidebar',
    reload: 'Reload',
    devTools: 'Developer Tools',
    resetZoom: 'Reset zoom',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fullscreen: 'Fullscreen',
    help: 'Help',
    github: 'GitHub repository',
    language: 'Language',
    languageRu: 'Русский',
    languageEn: 'English',
  },
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin'
  const lang = config.get('appLanguage') || 'ru'
  const t = MENU_STRINGS[lang] ?? MENU_STRINGS.ru
  const currentLang = config.get('appLanguage') || 'ru'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const, label: t.about },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const, label: t.quit },
      ],
    }] : []),
    {
      label: t.file,
      submenu: [
        {
          label: t.openFolder,
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, {
              title: t.chooseFolder,
              properties: ['openDirectory'],
            })
            if (!result.canceled && result.filePaths[0]) {
              const dir = result.filePaths[0]
              recentWorkspaces.addRecentWorkspace(dir)
              sendMenuAction('open-recent', dir)
              buildAppMenu()
            }
          },
        },
        { type: 'separator' },
        {
          label: t.recent,
          submenu: recentWorkspaces.getRecentWorkspaces().length === 0
            ? [{ label: t.noRecent, enabled: false }]
            : recentWorkspaces.getRecentWorkspaces().map((dir) => ({
                label: path.basename(dir) || dir,
                click: () => {
                  recentWorkspaces.addRecentWorkspace(dir)
                  sendMenuAction('open-recent', dir)
                  buildAppMenu()
                },
              })),
        },
      ],
    },
    {
      label: t.agent,
      submenu: [
        { label: t.newChat, accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-chat') },
        { type: 'separator' },
        { label: t.stopRequest, accelerator: 'Escape', click: () => cancelAgent() },
        { label: t.resetContext, accelerator: 'CmdOrCtrl+Shift+Delete', click: () => sendMenuAction('reset-context') },
        { type: 'separator' },
        ...(!isMac ? [
          { role: 'quit' as const, label: t.quit, accelerator: 'CmdOrCtrl+Q' },
        ] : []),
      ],
    },
    {
      label: t.settings,
      submenu: [
        { label: t.settingsModel, click: () => sendMenuAction('settings-model') },
        { label: t.settingsTools, click: () => sendMenuAction('settings-tools') },
        { label: t.settingsPrompts, click: () => sendMenuAction('settings-prompts') },
        { label: t.settingsWebSearch, click: () => sendMenuAction('settings-web-search') },
        { type: 'separator' },
        {
          label: t.language,
          submenu: [
            {
              label: t.languageRu,
              type: 'radio' as const,
              checked: currentLang === 'ru',
              click: () => {
                config.set('appLanguage', 'ru')
                buildAppMenu()
                try { mainWindow?.webContents.send('app-language-changed', 'ru') } catch {}
              },
            },
            {
              label: t.languageEn,
              type: 'radio' as const,
              checked: currentLang === 'en',
              click: () => {
                config.set('appLanguage', 'en')
                buildAppMenu()
                try { mainWindow?.webContents.send('app-language-changed', 'en') } catch {}
              },
            },
          ],
        },
        { type: 'separator' },
        {
          label: t.resetAll,
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow!, {
              type: 'warning',
              buttons: [t.resetCancel, t.resetConfirm],
              defaultId: 0,
              cancelId: 0,
              title: t.resetTitle,
              message: t.resetMessage,
            })
            if (result.response === 1) {
              config.resetToDefaults()
              sendMenuAction('defaults-reset')
            }
          },
        },
      ],
    },
    {
      label: t.edit,
      submenu: [
        { role: 'undo', label: t.undo },
        { role: 'redo', label: t.redo },
        { type: 'separator' },
        { role: 'cut', label: t.cut },
        { role: 'copy', label: t.copy },
        { role: 'paste', label: t.paste },
        { role: 'selectAll', label: t.selectAll },
      ],
    },
    {
      label: t.view,
      submenu: [
        { label: t.terminal, accelerator: 'Ctrl+`', click: () => sendMenuAction('toggle-terminal') },
        { label: t.sidebar, accelerator: 'CmdOrCtrl+B', click: () => sendMenuAction('toggle-sidebar') },
        { type: 'separator' },
        { role: 'reload', label: t.reload },
        { role: 'toggleDevTools', label: t.devTools },
        { type: 'separator' },
        { role: 'resetZoom', label: t.resetZoom },
        { role: 'zoomIn', label: t.zoomIn },
        { role: 'zoomOut', label: t.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.fullscreen },
      ],
    },
    {
      label: t.help,
      submenu: [
        {
          label: t.github,
          click: () => shell.openExternal('https://github.com'),
        },
        { type: 'separator' },
        ...(!isMac ? [
          { role: 'about' as const, label: t.about },
        ] : []),
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function createWindow() {
  buildAppMenu()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'One-Click Coding Agent',
    backgroundColor: '#09090b',
    darkTheme: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.once('did-finish-load', () => {
      globalShortcut.register('F12', () => mainWindow?.webContents.toggleDevTools())
      globalShortcut.register('CommandOrControl+Shift+I', () => mainWindow?.webContents.toggleDevTools())
    })
    mainWindow.on('closed', () => {
      globalShortcut.unregister('F12')
      globalShortcut.unregister('CommandOrControl+Shift+I')
    })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  initSessions()
  registerIpcHandlers()
  createWindow()
  // Pre-create agent worker so first send-message doesn't block on Worker load
  setImmediate(() => { try { getAgentWorker() } catch {} })
  // Do NOT auto-start llama-server on app launch. Users must first see the
  // setup screen, review core settings (model, quant, context, GPU), and
  // explicitly press Launch. On-demand startup still happens when the user
  // sends a message after skipping setup.

  // Kick MCP servers in the background — any configured+enabled server
  // gets connected so its tools show up on the first send-message. Failures
  // are stored per-server in status.lastError; nothing blocks startup.
  try {
    mcp.connectAllInBackground(config.get('mcpServers') ?? [])
  } catch (e) {
    console.error('[mcp] connectAllInBackground failed:', e)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  terminalManager.killAll()
  serverManager.stop()
  mcp.shutdownAll().catch(() => {})
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  serverManager.stop()
  mcp.shutdownAll().catch(() => {})
  try { workspaceWatcher.stopWatching() } catch {}
})

function registerIpcHandlers() {
  ipcMain.handle('detect-resources', () => detect())

  ipcMain.handle('get-model-variants', (_e, override?: Partial<config.AppConfig>) => {
    const modelPath = modelManager.getModelPath()
    if (modelPath) loadModelArch(modelPath)
    const cfg = { ...config.load(), ...override }
    return evaluateVariants(applyGpuPreferences(detect(), cfg.gpuMode, cfg.gpuIndex))
  })

  ipcMain.handle('get-model-families', () => MODEL_FAMILIES)

  ipcMain.handle('select-model-variant', (_e, quant: string) => {
    modelManager.setSelectedQuant(quant)
  })

  ipcMain.handle('get-web-search-status', (_e, override?: Partial<config.AppConfig>) => {
    const cfg = { ...config.load(), ...(override || {}) }
    return getWebSearchStatus({
      webSearchProvider: cfg.webSearchProvider,
      searxngBaseUrl: cfg.searxngBaseUrl,
    })
  })

  ipcMain.handle('ensure-web-search', async (_e, override?: Partial<config.AppConfig>) => {
    const cfg = { ...config.load(), ...(override || {}) }
    return await ensureWebSearchBackend({
      webSearchProvider: cfg.webSearchProvider,
      searxngBaseUrl: cfg.searxngBaseUrl,
    })
  })

  ipcMain.handle('set-app-language', (_e, lang: config.AppLanguage) => {
    if (lang !== 'ru' && lang !== 'en') return config.load()
    const updated = config.save({ appLanguage: lang })
    buildAppMenu()
    try { mainWindow?.webContents.send('app-language-changed', lang) } catch {}
    return updated
  })

  ipcMain.handle('open-external-url', async (_e, url: string) => {
    if (typeof url !== 'string') return false
    if (!/^https?:\/\//i.test(url)) return false
    try { await shell.openExternal(url); return true } catch { return false }
  })

  ipcMain.handle('get-config', () => config.load())

  ipcMain.handle('save-config', (_e, partial: Partial<config.AppConfig>) => {
    return config.save(partial)
  })

  ipcMain.handle('get-tools', (): ToolInfo[] => {
    const builtins: ToolInfo[] = TOOL_DEFINITIONS.map((t: any) => ({
      name: t.function.name,
      description: t.function.description,
      builtin: true,
      enabled: true,
    }))
    const custom: ToolInfo[] = config.get('customTools').map((ct) => ({
      name: ct.name,
      description: ct.description,
      builtin: false,
      enabled: ct.enabled,
      id: ct.id,
      command: ct.command,
      parameters: ct.parameters,
    }))
    return [...builtins, ...custom]
  })

  ipcMain.handle('save-custom-tool', (_e, tool: config.CustomTool) => {
    const tools = config.get('customTools')
    const idx = tools.findIndex((t) => t.id === tool.id)
    if (idx >= 0) tools[idx] = tool
    else tools.push(tool)
    config.set('customTools', tools)
    return tools
  })

  ipcMain.handle('delete-custom-tool', (_e, toolId: string) => {
    const tools = config.get('customTools').filter((t) => t.id !== toolId)
    config.set('customTools', tools)
    return tools
  })

  ipcMain.handle('get-prompts', () => ({
    systemPrompt: config.get('systemPrompt'),
    summarizePrompt: config.get('summarizePrompt'),
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    defaultSummarizePrompt: DEFAULT_SUMMARIZE_PROMPT,
  }))

  ipcMain.handle('save-prompts', (_e, prompts: { systemPrompt?: string | null; summarizePrompt?: string | null }) => {
    if (prompts.systemPrompt !== undefined) config.set('systemPrompt', prompts.systemPrompt)
    if (prompts.summarizePrompt !== undefined) config.set('summarizePrompt', prompts.summarizePrompt)
  })

  ipcMain.handle('reset-all-defaults', () => {
    config.resetToDefaults()
  })

  ipcMain.handle('restart-server', async (_e) => {
    serverManager.stop()
    await new Promise((r) => setTimeout(r, 2000))
    if (!serverManager.isReady()) throw new Error('llama-server не установлен')
    let modelPath = modelManager.getModelPath()
    if (!modelPath) {
      if (!mainWindow) throw new Error('Модель не скачана')
      const quant = modelManager.getSelectedQuant()
      mainWindow.webContents.send('build-status', `⬇️ Модель ${quant} не найдена локально — скачиваю выбранную модель…`)
      modelPath = await modelManager.download(mainWindow)
    }
    loadModelArch(modelPath)
    const ctxSize = config.get('ctxSize')
    console.log(`[restart-server] Requested ctx=${ctxSize}, quant=${modelManager.getSelectedQuant()}`)
    serverManager.resetCrashState()
    await ensureLlamaServerRunning()
    const actualCtx = serverManager.getCtxSize()
    console.log(`[restart-server] Server ready, actual ctx=${actualCtx}`)
    return { requestedCtx: ctxSize, actualCtx }
  })

  // Window control handlers (frameless window)
  ipcMain.on('win-minimize', () => mainWindow?.minimize())
  ipcMain.on('win-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on('win-close', () => mainWindow?.close())
  ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false)

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

  ipcMain.handle('llama:get-release-info', async () => {
    return serverManager.getLlamaReleaseInfo()
  })

  ipcMain.handle('llama:update', async () => {
    if (!mainWindow) throw new Error('No window')
    const wasRunning = serverManager.isRunning()
    const previousArgs = serverManager.getLastLaunchArgs()
    const info = await serverManager.updateBinary(mainWindow)

    if (wasRunning) {
      const restartStatus = previousArgs
        ? `🔁 llama.cpp обновлён — перезапускаю сервер с прежними параметрами (ctx=${previousArgs.ctxSize}, GPU-слоёв: ${previousArgs.nGpuLayers})…`
        : '🔁 llama.cpp обновлён — перезапускаю сервер…'
      mainWindow.webContents.send('build-status', restartStatus)

      let modelPath = modelManager.getModelPath()
      if (!modelPath) {
        const quant = modelManager.getSelectedQuant()
        mainWindow.webContents.send('build-status', `⬇️ Модель ${quant} не найдена локально — скачиваю выбранную модель…`)
        modelPath = await modelManager.download(mainWindow)
      }
      loadModelArch(modelPath)

      if (previousArgs) {
        try {
          serverManager.resetCrashState()
          serverManager.start(modelPath, mainWindow ?? undefined, previousArgs, modelManager.getSelectedQuant(), previousArgs.ctxSize)
          await serverManager.waitReady(300, mainWindow ?? undefined)
          mainWindow.webContents.send('build-status', '✅ llama.cpp обновлён и сервер перезапущен')
          return serverManager.getLlamaReleaseInfo()
        } catch (err: any) {
          console.warn(`[llama:update] restart with previous launch args failed: ${err?.message ?? err}`)
          if (serverManager.isRunning()) serverManager.stop()
          await new Promise((r) => setTimeout(r, 1200))
          serverManager.resetCrashState()
          mainWindow.webContents.send('build-status', '⚠️ Прежние параметры не запустились — подбираю безопасные параметры…')
        }
      }

      await ensureLlamaServerRunning()
      mainWindow.webContents.send('build-status', '✅ llama.cpp обновлён и сервер перезапущен')
      return serverManager.getLlamaReleaseInfo()
    }

    return info
  })

  ipcMain.handle('start-server', async () => {
    // Idempotent: UI triggers this on mount even when auto-start already kicked
    // in, and racing two starts produced a noisy "Server already running" error
    // that surfaced as "can't start server" in the setup wizard.
    if (serverManager.isRunning() && await probeServerReachable()) {
      console.log('[start-server] server already running and reachable, no-op')
      return
    }
    await ensureLlamaServerRunning()
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
      loadModelArch(modelPath)
      const ctxSize = config.get('ctxSize')
      const quant = modelManager.getSelectedQuant()
      console.log(`[auto-setup] Starting server: quant=${quant}, ctx=${ctxSize}`)
      serverManager.start(modelPath, mainWindow ?? undefined, undefined, quant, ctxSize)
      await serverManager.waitReady(300, mainWindow ?? undefined)
      console.log(`[auto-setup] Server ready, actual ctx=${serverManager.getCtxSize()}`)
    } else {
      console.log(`[auto-setup] Server already running, ctx=${serverManager.getCtxSize()}`)
    }
  })

  ipcMain.handle('send-message', async (_e, msg: string, workspace: string) => {
    if (!mainWindow) throw new Error('No window')

    console.log(`[send-message] incoming: workspace=${workspace}, msgLen=${msg?.length ?? 0}`)

    // Ensure llama-server is actually up before sending the prompt: the worker
    // does a bare `fetch()` and without this guard a stopped/crashed server
    // just produces a cryptic `TypeError: fetch failed` in the chat.
    try {
      const processAlive = serverManager.isRunning()
      const reachable = processAlive && await probeServerReachable()
      console.log(`[send-message] preflight: processAlive=${processAlive}, reachable=${reachable}, pid=${serverManager.getServerProcessPid()}`)
      if (!reachable) {
        try { mainWindow.webContents.send('agent-event', { type: 'status', content: '⏳ Запускаю llama.cpp сервер…' }) } catch {}
      }
      await ensureLlamaServerRunning()
      // Final sanity check — if /health STILL doesn't answer, don't hand off
      // to the worker (it would just loop into `fetch failed` and land us
      // back here through enrichAgentEvent).
      const finalReach = await probeServerReachable()
      console.log(`[send-message] post-ensure: reachable=${finalReach}, pid=${serverManager.getServerProcessPid()}`)
      if (!finalReach) {
        throw new Error('сервер запустился, но /health недоступен')
      }
    } catch (err: any) {
      const reason = String(err?.message ?? err)
      const tail = serverManager.getServerLogTail(20)
      console.error(`[send-message] server unavailable: ${reason}`)
      if (tail) console.error(`[send-message] server log tail:\n${tail}`)
      try {
        mainWindow.webContents.send('agent-event', {
          type: 'error',
          content: `llama.cpp сервер не запущен — ${reason}.\n\nПоследние строки server-лога (${serverManager.serverLogPath()}):\n${tail || '(пусто)'}\n\nОткрой «Настройки → Модель и контекст», чтобы перезапустить сервер.`,
        })
      } catch {}
      return `Server unavailable: ${reason}`
    }

    return new Promise<string>((resolve) => {
      pendingSendResolve = resolve
      setImmediate(async () => {
        const session = getActiveSession(workspace)
        const configVal = config.load()
        const apiUrl = serverManager.llamaApiUrl()
        const ctxSize = serverManager.getCtxSize() || 32768
        const sessionPath = getSessionPathForWorker(workspace, session.id)
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
        const stream = fs.createWriteStream(sessionPath, { encoding: 'utf-8' })
        const write = (s: string) => stream.write(s)
        write('{"id":')
        write(JSON.stringify(session.id))
        write(',"title":')
        write(JSON.stringify(session.title))
        write(',"messages":[')
        for (let i = 0; i < session.messages.length; i++) {
          write((i ? ',' : '') + JSON.stringify(session.messages[i]))
          if (i > 0 && i % SESSION_WRITE_YIELD_EVERY === 0) await new Promise<void>(r => setImmediate(r))
        }
        write('],"uiMessages":')
        write(JSON.stringify(session.uiMessages || []))
        write(',"projectContextAdded":')
        write(String(session.projectContextAdded))
        write(',"createdAt":')
        write(String(session.createdAt))
        write(',"updatedAt":')
        write(String(session.updatedAt))
        write(',"workspaceKey":')
        write(JSON.stringify(session.workspaceKey ?? ''))
        write('}')
        await new Promise<void>((res, rej) => { stream.once('finish', res); stream.once('error', rej); stream.end() })
        // Snapshot the current MCP tool catalogue so the worker can hand
        // it to the LLM without needing its own view of the MCP registry.
        // We don't await a refresh here — connectAllInBackground() runs at
        // startup and any enabled-but-not-yet-connected servers will be
        // picked up on the *next* message, not mid-flight.
        const mcpToolDefs = mcp.listAllTools().map((t) => ({
          qualifiedName: t.qualifiedName,
          description: t.description,
          inputSchema: t.inputSchema,
        }))
        getAgentWorker().postMessage({
          type: 'run',
          payload: { message: msg, workspace, config: configVal, apiUrl, ctxSize, sessionPath, mcpToolDefs },
        })
      })
    })
  })

  ipcMain.handle('cancel-agent', () => {
    cancelAgent()
    if (agentWorker && pendingSendResolve) agentWorker.postMessage({ type: 'cancel' })
  })

  ipcMain.handle('reset-agent', (_e, workspace: string) => resetAgent(workspace))
  ipcMain.handle('set-workspace', (_e, ws: string) => {
    setWorkspace(ws)
    recentWorkspaces.addRecentWorkspace(ws)
    buildAppMenu()
    try { workspaceWatcher.watchWorkspace(ws) } catch {}
  })

  // Session management (all workspace-scoped)
  ipcMain.handle('create-session', (_e, workspace: string) => createSession(workspace))
  ipcMain.handle('switch-session', (_e, workspace: string, id: string) => switchSession(workspace, id))
  ipcMain.handle('list-sessions', (_e, workspace: string) => listSessions(workspace))
  ipcMain.handle('delete-session', (_e, workspace: string, id: string) => deleteSession(workspace, id))
  ipcMain.handle('rename-session', (_e, workspace: string, id: string, title: string) => renameSession(workspace, id, title))
  ipcMain.handle('get-active-session-id', (_e, workspace: string) => getActiveSessionId(workspace))
  ipcMain.handle('save-ui-messages', (_e, workspace: string, id: string, msgs: any[]) => saveUiMessages(workspace, id, msgs))
  ipcMain.handle('get-ui-messages', (_e, workspace: string, id: string) => getUiMessages(workspace, id))
  ipcMain.handle('session:set-mode', (_e, workspace: string, id: string, mode: AgentMode) => {
    if (mode !== 'chat' && mode !== 'plan' && mode !== 'agent') return null
    return setSessionMode(workspace, id, mode)
  })
  ipcMain.handle('plan:save-artifact', (_e, workspace: string, id?: string, content?: string) => {
    const saved = typeof content === 'string' && content.trim()
      ? savePlanArtifactContent(workspace, content)
      : savePlanArtifact(workspace, id)
    try { mainWindow?.webContents.send('workspace-files-changed') } catch {}
    return saved
  })

  ipcMain.handle('get-recent-workspaces', () => recentWorkspaces.getRecentWorkspaces())

  // --- Shadow-git checkpoints ---
  // Each file-modifying tool call in the agent stamps a snapshot into a
  // shadow repo; these IPCs let the UI list and roll back to them.
  ipcMain.handle('checkpoints:list', (_e, workspace: string, limit?: number) => {
    if (!workspace) return []
    try { return checkpoints.listCheckpoints(workspace, limit ?? 200) } catch { return [] }
  })
  ipcMain.handle('checkpoints:restore', async (_e, workspace: string, sha: string) => {
    if (!workspace || !sha) throw new Error('checkpoints:restore needs workspace and sha')
    const safety = checkpoints.restoreCheckpoint(workspace, sha)
    // The file tree on disk just changed wholesale — tell the renderer to
    // refresh the sidebar / open files.
    scheduleWorkspaceChangedNotify()
    return { ok: true, safety }
  })
  ipcMain.handle('checkpoints:create', (_e, workspace: string, label: string) => {
    if (!workspace) throw new Error('checkpoints:create needs workspace')
    return checkpoints.createCheckpoint(workspace, label || 'manual checkpoint')
  })
  ipcMain.handle('checkpoints:diff-stat', (_e, workspace: string, sha: string) => {
    if (!workspace || !sha) return ''
    try { return checkpoints.checkpointDiffStat(workspace, sha) } catch { return '' }
  })

  // Project rules (AGENTS.md / CLAUDE.md / .cursorrules / .cursor/rules/*) —
  // the renderer calls this to show a "rules loaded" pill, purely cosmetic.
  ipcMain.handle('project-rules:info', (_e, workspace: string) => {
    if (!workspace) return { files: [], truncated: false, totalBytes: 0 }
    try { return describeProjectRules(workspace) }
    catch { return { files: [], truncated: false, totalBytes: 0 } }
  })

  // ---- Context inspector (`/context`) and message pinning --------------
  // The /context slash command asks for a per-category breakdown, so users
  // can see which part of the conversation is eating budget. Pinning lets
  // them mark messages to survive the next compaction.
  ipcMain.handle('context:breakdown', (_e, workspace: string) => {
    if (!workspace) return null
    try { return computeContextBreakdown(workspace) } catch { return null }
  })
  ipcMain.handle('context:toggle-pin', (_e, workspace: string, messageId: string) => {
    if (!workspace || !messageId) return { pinned: false }
    try { return { pinned: toggleMessagePin(workspace, messageId) } }
    catch { return { pinned: false } }
  })
  ipcMain.handle('context:pinned', (_e, workspace: string) => {
    if (!workspace) return []
    try { return listPinnedMessages(workspace) } catch { return [] }
  })

  // Read-only snapshot of the agent's task state (goal, plan, notes). The
  // sidebar polls this on session change and on tool_result events so the
  // UI always reflects whatever the agent last wrote through `update_plan`.
  ipcMain.handle('task-state:get', (_e, workspace: string) => {
    if (!workspace) return null
    try {
      const sess = getActiveSession(workspace)
      return normalizeTaskState(sess?.taskState ?? null)
    } catch { return null }
  })

  // ---- MCP (Model Context Protocol) -----------------------------------
  // The settings panel talks to these. `mcp:list-servers` + `mcp:status`
  // are read-only snapshots; the save/remove/connect handlers mutate
  // config and kick off reconciliation. Tool list is surfaced per-server
  // so the UI can show "connected, N tools: foo, bar".

  ipcMain.handle('mcp:list-servers', () => {
    return config.get('mcpServers') ?? []
  })
  ipcMain.handle('mcp:status', () => mcp.listStatus())
  ipcMain.handle('mcp:tools', () => mcp.listAllTools().map((t) => ({
    qualifiedName: t.qualifiedName,
    serverId: t.serverId,
    rawName: t.rawName,
    description: t.description,
  })))
  ipcMain.handle('mcp:stderr-tail', (_e, serverId: string) => mcp.getStderrTail(serverId))
  ipcMain.handle('mcp:save-server', async (_e, server: config.McpServerConfig) => {
    const list = config.get('mcpServers') ?? []
    const idx = list.findIndex((s) => s.id === server.id)
    const next = [...list]
    if (idx >= 0) next[idx] = server
    else next.push(server)
    config.set('mcpServers', next)
    await mcp.reconcileServers(next)
    // Best-effort auto-connect if enabled.
    if (server.enabled) {
      try { await mcp.connectOne(server.id) } catch { /* errors surfaced via status */ }
    }
    return mcp.listStatus()
  })
  ipcMain.handle('mcp:delete-server', async (_e, serverId: string) => {
    const list = (config.get('mcpServers') ?? []).filter((s) => s.id !== serverId)
    config.set('mcpServers', list)
    await mcp.reconcileServers(list)
    return mcp.listStatus()
  })
  ipcMain.handle('mcp:connect', async (_e, serverId: string) => {
    return mcp.connectOne(serverId)
  })
  ipcMain.handle('mcp:disconnect', async (_e, serverId: string) => {
    await mcp.disconnectOne(serverId)
    return mcp.listStatus()
  })

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

  async function readTree(dir: string, depth: number): Promise<FileTreeEntry[]> {
    if (depth <= 0) return []
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const filtered = entries
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    const out: FileTreeEntry[] = []
    for (const e of filtered) {
      const fullPath = path.join(dir, e.name)
      if (e.isDirectory()) {
        out.push({ name: e.name, path: fullPath, isDir: true, children: await readTree(fullPath, depth - 1) })
      } else {
        out.push({ name: e.name, path: fullPath, isDir: false })
      }
    }
    return out
  }

  ipcMain.handle('list-files', async (_e, workspace: string, dirPath?: string) => {
    const target = dirPath ?? workspace
    if (!target) return []
    return readTree(target, 4)
  })

  ipcMain.handle('git-status', (_e, workspace: string) => git.getStatus(workspace))
  ipcMain.handle('git-numstat', (_e, workspace: string) => git.getNumstat(workspace))
  ipcMain.handle('git-file-at-head', (_e, workspace: string, relativePath: string) => git.getFileContentAtHead(workspace, relativePath))

  ipcMain.handle('read-file-content', async (_e, filePath: string) => {
    try {
      const [content, stat] = await Promise.all([
        fs.promises.readFile(filePath, 'utf-8'),
        fs.promises.stat(filePath),
      ])
      return { content, size: stat.size, lines: content.split('\n').length }
    } catch (e: any) {
      throw new Error(`Cannot read file: ${e.message}`)
    }
  })

  ipcMain.handle('write-file', async (_e, filePath: string, content: string) => {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    await fs.promises.writeFile(filePath, content, 'utf-8')
  })

  ipcMain.handle('ts-get-definition', (_e, workspacePath: string, filePath: string, fileContent: string, line: number, column: number) => {
    return tsService.getDefinition(workspacePath, filePath, fileContent, line, column)
  })
  ipcMain.handle('ts-get-hover', (_e, workspacePath: string, filePath: string, fileContent: string, line: number, column: number) => {
    return tsService.getHover(workspacePath, filePath, fileContent, line, column)
  })
  ipcMain.handle('ts-get-completions', (_e, workspacePath: string, filePath: string, fileContent: string, line: number, column: number) => {
    return tsService.getCompletions(workspacePath, filePath, fileContent, line, column)
  })
  ipcMain.handle('ts-get-diagnostics', (_e, workspacePath: string, filePath: string, fileContent?: string) => {
    return tsService.getDiagnostics(workspacePath, filePath, fileContent)
  })
  ipcMain.handle('py-resolve-module', (_e, workspacePath: string, moduleName: string) => {
    return pyResolve.resolvePythonModule(workspacePath, moduleName)
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
