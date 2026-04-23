import { execSync, spawn, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { dataDir } from './model-manager'
import * as config from './config'
import { detect, computeOptimalArgs, pickBinaryVariant, applyGpuPreferences } from './resources'
import type { ServerLaunchArgs } from './types'

let lastServerLog: string[] = []
let activeCtxSize = 0
let serverLogStream: fs.WriteStream | null = null
let lastExitInfo: { code: number | null; signal: string | null; at: number } | null = null
let lastCrashReason: 'oom' | 'other' | null = null
let lastLaunchArgs: ServerLaunchArgs | null = null

// Signatures that indicate the server ran out of VRAM / device memory and
// needs fewer GPU layers (or CPU-only) to recover.
const OOM_SIGNATURES: RegExp[] = [
  /ErrorOutOfDeviceMemory/i,
  /vk::SystemError/i,
  /ggml_vk_create_buffer_device/i,
  /cudaErrorMemoryAllocation/i,
  /CUDA error.*out of memory/i,
  /out of memory/i,
  /failed to allocate device memory/i,
]

function logLooksLikeOOM(): boolean {
  // Scan last ~200 lines — OOM message usually lands right before exit.
  const tail = lastServerLog.slice(-200)
  return tail.some((line) => OOM_SIGNATURES.some((re) => re.test(line)))
}

const LLAMA_HOST = '127.0.0.1'
const LLAMA_PORT = 7863
const GITHUB_RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'

export function llamaApiUrl(): string {
  return `http://${LLAMA_HOST}:${LLAMA_PORT}`
}

export function serverLogPath(): string {
  return path.join(dataDir(), 'llama-server.log')
}

let serverProcess: ChildProcess | null = null

export function getServerProcessPid(): number | null {
  return serverProcess?.pid ?? null
}

export function getLastExitInfo(): { code: number | null; signal: string | null; at: number } | null {
  return lastExitInfo
}

export function getLastCrashReason(): 'oom' | 'other' | null {
  return lastCrashReason
}

export function getLastLaunchArgs(): ServerLaunchArgs | null {
  return lastLaunchArgs
}

export function resetCrashState(): void {
  lastCrashReason = null
}

/** Tail of the in-memory server log ring buffer, for slapping into error
 *  messages when /v1/chat/completions suddenly goes away. */
export function getServerLogTail(lines = 40): string {
  return lastServerLog.slice(-lines).join('\n')
}

function binDir(): string {
  return path.join(dataDir(), 'llama-bin')
}

function variantFile(): string {
  return path.join(binDir(), '.variant')
}

function getInstalledVariant(): string | null {
  try { return fs.readFileSync(variantFile(), 'utf-8').trim() } catch { return null }
}

function setInstalledVariant(variant: string): void {
  fs.mkdirSync(binDir(), { recursive: true })
  fs.writeFileSync(variantFile(), variant)
}

function serverBinName(): string {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

function findServerBin(): string | null {
  const dir = binDir()
  if (!fs.existsSync(dir)) return null

  const binPath = path.join(dir, serverBinName())
  if (fs.existsSync(binPath)) return binPath

  // release archives sometimes nest files in a subfolder
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, serverBinName())
        if (fs.existsSync(nested)) return nested
      }
    }
  } catch {}

  // system-installed fallback
  try {
    const which = execSync(
      process.platform === 'win32' ? 'where llama-server' : 'which llama-server',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim().split('\n')[0]
    if (which) return which
  } catch {}

  return null
}

export function isReady(): boolean {
  return findServerBin() !== null
}

export function isRunning(): boolean {
  if (!serverProcess) return false
  return serverProcess.exitCode === null
}

// ---------------------------------------------------------------------------
// GitHub release helpers
// ---------------------------------------------------------------------------

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const doGet = (u: string) => {
      const mod = u.startsWith('https') ? https : require('http')
      mod.get(u, { headers: { 'User-Agent': 'one-click-agent/0.1', Accept: 'application/json' } }, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location)
          return
        }
        let data = ''
        res.on('data', (c: string) => (data += c))
        res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
        res.on('error', reject)
      }).on('error', reject)
    }
    doGet(url)
  })
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

async function getLatestRelease(): Promise<{ tag: string; assets: ReleaseAsset[] }> {
  const body = await fetchJson(GITHUB_RELEASE_API)
  return {
    tag: body.tag_name,
    assets: (body.assets ?? []).map((a: any) => ({
      name: a.name,
      browser_download_url: a.browser_download_url,
      size: a.size,
    })),
  }
}

function matchAsset(assets: ReleaseAsset[], variant: string): ReleaseAsset | null {
  return assets.find((a) => a.name.includes(`-bin-${variant}.`)) ?? null
}

function matchCudartAsset(assets: ReleaseAsset[], name: string): ReleaseAsset | null {
  return assets.find((a) => a.name.startsWith(name)) ?? null
}

// ---------------------------------------------------------------------------
// Download with progress
// ---------------------------------------------------------------------------

function downloadFile(
  url: string, dest: string, win: BrowserWindow, label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part'
    const doGet = (u: string) => {
      https.get(u, { headers: { 'User-Agent': 'one-click-agent/0.1' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} при скачивании ${label}`))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        const totalMb = Math.round(total / (1024 * 1024))
        let downloaded = 0
        let lastEmit = 0

        const file = fs.createWriteStream(tmp)
        res.pipe(file)
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          const now = Date.now()
          if (now - lastEmit > 400) {
            const dm = Math.round(downloaded / (1024 * 1024))
            const pct = total > 0 ? (downloaded / total) * 100 : 0
            emitBuild(win, `${label}: ${dm}/${totalMb} МБ (${pct.toFixed(1)}%)`)
            lastEmit = now
          }
        })
        file.on('finish', () => {
          file.close()
          fs.renameSync(tmp, dest)
          resolve()
        })
        res.on('error', (e) => { try { fs.unlinkSync(tmp) } catch {} reject(e) })
        file.on('error', (e) => { try { fs.unlinkSync(tmp) } catch {} reject(e) })
      }).on('error', reject)
    }
    doGet(url)
  })
}

// ---------------------------------------------------------------------------
// Extract archive
// ---------------------------------------------------------------------------

function extractArchive(archivePath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    execSync(`tar xzf "${archivePath}" -C "${destDir}"`, { timeout: 120000 })
  } else if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'"`,
        { timeout: 120000 },
      )
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { timeout: 120000 })
    }
  }
}

// ---------------------------------------------------------------------------
// Verify binary works
// ---------------------------------------------------------------------------

function verifyBinary(binPath: string): boolean {
  try {
    execSync(`"${binPath}" --version`, { timeout: 10000, encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// IPC emit
// ---------------------------------------------------------------------------

function emitBuild(win: BrowserWindow, msg: string) {
  win.webContents.send('build-status', msg)
}

// ---------------------------------------------------------------------------
// ensureBinary: download pre-built binary from GitHub Releases
// ---------------------------------------------------------------------------

export async function ensureBinary(win: BrowserWindow): Promise<string> {
  const existing = findServerBin()
  const installedVariant = getInstalledVariant()
  if (existing && installedVariant) {
    emitBuild(win, `llama-server уже установлен (${installedVariant})`)
    return existing
  }

  const res = detect()
  const selection = pickBinaryVariant(res)

  emitBuild(win, `Система: ${res.platform}/${res.arch}` +
    (res.cudaVersion ? `, CUDA ${res.cudaVersion}` : '') +
    (res.hasAmdGpu ? ', AMD GPU' : '') +
    (res.gpus.length > 0 ? `, ${res.gpus.map((g) => g.name).join(', ')}` : ', без GPU'))

  emitBuild(win, 'Запрос последнего релиза llama.cpp…')
  const release = await getLatestRelease()
  emitBuild(win, `Релиз: ${release.tag}`)

  const variants = [selection.primary, ...selection.fallbacks]

  for (const variant of variants) {
    const asset = matchAsset(release.assets, variant)
    if (!asset) {
      emitBuild(win, `Бинарник '${variant}' не найден, пробуем следующий…`)
      continue
    }

    const sizeMb = Math.round(asset.size / (1024 * 1024))
    emitBuild(win, `Скачивание ${variant} (${sizeMb} МБ)…`)

    const dir = binDir()
    fs.mkdirSync(dir, { recursive: true })
    const archivePath = path.join(dir, asset.name)

    try {
      await downloadFile(asset.browser_download_url, archivePath, win, variant)
    } catch (e: any) {
      emitBuild(win, `Ошибка скачивания ${variant}: ${e.message}`)
      continue
    }

    emitBuild(win, 'Распаковка…')
    try {
      extractArchive(archivePath, dir)
    } catch (e: any) {
      emitBuild(win, `Ошибка распаковки: ${e.message}`)
      continue
    }

    // On Windows+CUDA, also download cudart DLLs
    if (selection.needsCudart && variant === selection.primary && selection.cudartAsset) {
      const cudart = matchCudartAsset(release.assets, selection.cudartAsset)
      if (cudart) {
        emitBuild(win, 'Скачивание CUDA runtime…')
        const cudartPath = path.join(dir, cudart.name)
        try {
          await downloadFile(cudart.browser_download_url, cudartPath, win, 'cudart')
          extractArchive(cudartPath, dir)
          try { fs.unlinkSync(cudartPath) } catch {}
        } catch (e: any) {
          emitBuild(win, `Предупреждение: не удалось скачать cudart: ${e.message}`)
        }
      }
    }

    try { fs.unlinkSync(archivePath) } catch {}

    const bin = findServerBin()
    if (!bin) {
      emitBuild(win, `llama-server не найден после распаковки ${variant}`)
      continue
    }

    if (process.platform !== 'win32') {
      try { fs.chmodSync(bin, 0o755) } catch {}
    }

    if (verifyBinary(bin)) {
      setInstalledVariant(variant)
      emitBuild(win, `llama-server (${variant}) готов!`)
      return bin
    }

    emitBuild(win, `Бинарник ${variant} не запускается, пробуем следующий…`)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }

  throw new Error('Не удалось установить llama-server. Проверьте интернет-соединение.')
}

// ---------------------------------------------------------------------------
// Start / Stop / Health
// ---------------------------------------------------------------------------

export function getServerLog(): string[] {
  return lastServerLog
}

export function getCtxSize(): number {
  return activeCtxSize
}

export function setCtxSize(size: number): void {
  if (size > 0) activeCtxSize = size
}

export async function queryActualCtxSize(): Promise<number | null> {
  try {
    const r = await fetch(`${llamaApiUrl()}/props`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const json = await r.json() as any
    const realCtx = json.default_generation_settings?.n_ctx
    if (realCtx && realCtx > 0) {
      if (realCtx !== activeCtxSize) {
        console.log(`[server-manager] Server actual n_ctx=${realCtx}, was tracking ${activeCtxSize} — correcting`)
        activeCtxSize = realCtx
      }
      return realCtx
    }
    return null
  } catch {
    return null
  }
}

export function start(
  modelPath: string, win?: BrowserWindow, args?: ServerLaunchArgs,
  quant?: string, userCtxSize?: number | null,
): void {
  if (isRunning()) throw new Error('Server already running')

  // Kill any orphan llama-server processes from previous app sessions
  killOrphanServers()

  const bin = findServerBin()
  if (!bin) throw new Error('llama-server not found — run ensureBinary first')

  const cfg = config.load()
  const detected = detect()
  const effectiveResources = applyGpuPreferences(detected, cfg.gpuMode, cfg.gpuIndex)
  const selectedGpu = effectiveResources.gpus[0] ?? null
  const la = args ?? computeOptimalArgs(effectiveResources, quant, userCtxSize)
  activeCtxSize = la.ctxSize
  lastLaunchArgs = la
  lastCrashReason = null
  const cmdArgs = [
    '--model', modelPath,
    '--host', LLAMA_HOST,
    '--port', String(LLAMA_PORT),
    '--jinja',
    '--n-gpu-layers', String(la.nGpuLayers),
    '--ctx-size', String(la.ctxSize),
    '--threads', String(la.threads),
    '--cache-type-k', la.cacheTypeK,
    '--cache-type-v', la.cacheTypeV,
  ]
  // Large context: bigger batch speeds up prompt ingestion (fewer steps). Default -b 2048, -ub 512.
  if (la.ctxSize >= 131072) {
    cmdArgs.push('--batch-size', '512', '--ubatch-size', '512')
  } else if (la.ctxSize >= 65536) {
    cmdArgs.push('--batch-size', '512')
  } else if (la.ctxSize >= 32768) {
    cmdArgs.push('--batch-size', '512')
  }
  // Lock model in RAM to avoid swap (consistent speed on local machine)
  if (process.platform !== 'win32') cmdArgs.push('--mlock')
  if (la.tensorSplit) cmdArgs.push('--tensor-split', la.tensorSplit)
  if (la.flashAttn) cmdArgs.push('--flash-attn', 'on')

  lastServerLog = []
  lastExitInfo = null

  // Rotate + open a persistent log file so crashes aren't lost when the in-memory
  // ring buffer wraps or after the process dies. This is the thing we surface
  // inside "fetch failed" errors now.
  try { serverLogStream?.end() } catch {}
  serverLogStream = null
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    serverLogStream = fs.createWriteStream(serverLogPath(), { flags: 'a' })
    serverLogStream.write(`\n===== ${new Date().toISOString()} spawn llama-server =====\n`)
    serverLogStream.write(`cmd: ${bin} ${cmdArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`)
    serverLogStream.write(`env.CUDA_VISIBLE_DEVICES=${(cfg.gpuMode === 'single' && selectedGpu) ? selectedGpu.index : '<unset>'}\n`)
  } catch (e: any) {
    console.error('[server-manager] Cannot open server log file:', e?.message ?? e)
  }

  if (win) {
    emitBuild(win, `Запуск: ${path.basename(bin)}`)
    emitBuild(win, 'GGML_CUDA_DISABLE_GRAPHS=1 (multi-GPU stability)')
    if (cfg.gpuMode === 'single' && selectedGpu) {
      emitBuild(win, `GPU mode: single (GPU ${selectedGpu.index}: ${selectedGpu.name})`)
      emitBuild(win, `Visible GPU env: CUDA_VISIBLE_DEVICES=${selectedGpu.index}, GGML_VK_VISIBLE_DEVICES=${selectedGpu.index}`)
    } else if (cfg.gpuMode === 'split' && detected.gpus.length > 1) {
      emitBuild(win, `GPU mode: split (experimental, GPUs: ${detected.gpus.map((gpu) => gpu.index).join(', ')})`)
    }
    emitBuild(win, `GPU layers: ${la.nGpuLayers}, ctx: ${la.ctxSize}, threads: ${la.threads}` +
      `, kv-cache: ${la.cacheTypeK}` +
      (la.tensorSplit ? `, tensor-split: ${la.tensorSplit}` : '') +
      (la.flashAttn ? ', flash-attn: on' : ''))
  }

  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, GGML_CUDA_DISABLE_GRAPHS: '1' }
  if (cfg.gpuMode === 'single' && selectedGpu) {
    spawnEnv.CUDA_VISIBLE_DEVICES = String(selectedGpu.index)
    spawnEnv.GGML_VK_VISIBLE_DEVICES = String(selectedGpu.index)
  } else {
    delete spawnEnv.CUDA_VISIBLE_DEVICES
    delete spawnEnv.GGML_VK_VISIBLE_DEVICES
  }
  serverProcess = spawn(bin, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: false, env: spawnEnv })
  console.log(`[server-manager] spawned llama-server pid=${serverProcess.pid}, ctx=${la.ctxSize}, nGpuLayers=${la.nGpuLayers}`)

  const handleOutput = (data: Buffer) => {
    const text = data.toString()
    try { serverLogStream?.write(text) } catch {}
    const lines = text.split('\n').filter(Boolean)
    for (const line of lines) {
      lastServerLog.push(line)
      if (lastServerLog.length > 400) lastServerLog.shift()
      if (win) emitBuild(win, `[server] ${line}`)
      // Mark OOM as soon as the signature shows up — Vulkan sometimes throws
      // but the process lingers a bit before SIGABRT, and we want to trigger
      // a retry fast instead of waiting for the whole "fetch failed" round trip.
      if (lastCrashReason !== 'oom' && OOM_SIGNATURES.some((re) => re.test(line))) {
        lastCrashReason = 'oom'
        console.log(`[server-manager] detected OOM signature in server output: ${line.trim().slice(0, 160)}`)
      }
    }
  }

  serverProcess.stdout?.on('data', handleOutput)
  serverProcess.stderr?.on('data', handleOutput)
  serverProcess.on('exit', (code, signal) => {
    lastExitInfo = { code, signal, at: Date.now() }
    const pid = serverProcess?.pid
    const crashed = code !== 0 || signal !== null
    lastCrashReason = crashed ? (logLooksLikeOOM() ? 'oom' : 'other') : null
    console.log(`[server-manager] llama-server exited: pid=${pid}, code=${code}, signal=${signal}, crashReason=${lastCrashReason ?? 'clean'}`)
    try {
      serverLogStream?.write(`\n===== ${new Date().toISOString()} exit code=${code} signal=${signal} =====\n`)
      serverLogStream?.end()
    } catch {}
    serverLogStream = null
    if (win && code !== null && code !== 0) {
      emitBuild(win, `llama-server завершился с кодом ${code}${signal ? ` (signal ${signal})` : ''}`)
    }
    serverProcess = null
  })
}

export function stop(): void {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM')
    setTimeout(() => {
      if (serverProcess && serverProcess.exitCode === null) serverProcess.kill('SIGKILL')
    }, 10000)
  }
  serverProcess = null
  killOrphanServers()
}

function killOrphanServers(): void {
  try {
    if (process.platform === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${LLAMA_PORT} ^| findstr LISTENING') do taskkill /F /PID %a`, { timeout: 5000, stdio: 'ignore' })
    } else {
      const out = execSync(`lsof -ti :${LLAMA_PORT} 2>/dev/null || true`, { timeout: 5000, encoding: 'utf-8' }).trim()
      if (out) {
        for (const pid of out.split('\n').filter(Boolean)) {
          try { process.kill(parseInt(pid), 'SIGKILL') } catch {}
        }
        console.log(`[server-manager] Killed orphan processes on port ${LLAMA_PORT}: ${out.replace(/\n/g, ', ')}`)
      }
    }
  } catch {}
}

export async function waitReady(timeoutSecs = 300, win?: BrowserWindow): Promise<boolean> {
  const deadline = Date.now() + timeoutSecs * 1000
  let lastReport = 0
  while (Date.now() < deadline) {
    if (!serverProcess || serverProcess.exitCode !== null) {
      const code = serverProcess?.exitCode ?? 'unknown'
      const tail = lastServerLog.slice(-10).join('\n')
      throw new Error(
        `llama-server упал (код ${code}).\nПоследний вывод:\n${tail}`
      )
    }

    try {
      const r = await fetch(`${llamaApiUrl()}/health`, { signal: AbortSignal.timeout(3000) })
      const body = await r.json() as any
      if (body.status === 'ok') {
        await queryActualCtxSize()
        return true
      }
      if (body.status === 'loading model' && win) {
        const now = Date.now()
        if (now - lastReport > 3000) {
          const pct = body.progress !== undefined ? ` (${Math.round(body.progress * 100)}%)` : ''
          emitBuild(win, `Загрузка модели в память${pct}…`)
          lastReport = now
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500))
  }
  const tail = lastServerLog.slice(-10).join('\n')
  throw new Error(
    `Сервер не ответил за ${timeoutSecs} секунд.\nПоследний вывод:\n${tail}`
  )
}

export async function health(): Promise<{ status: string }> {
  try {
    const r = await fetch(`${llamaApiUrl()}/health`, { signal: AbortSignal.timeout(5000) })
    return await r.json() as { status: string }
  } catch {
    return { status: 'unreachable' }
  }
}
