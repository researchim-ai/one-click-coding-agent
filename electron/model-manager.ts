import { BrowserWindow } from 'electron'
import https from 'https'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { DownloadProgress } from './types'

const REPO_ID = 'unsloth/Qwen3.5-35B-A3B-GGUF'
const QUANT = 'UD-Q4_K_XL'
const MAX_RETRIES = 3
const RETRY_BASE_MS = 2000

export function dataDir(): string {
  const d = path.join(os.homedir(), '.one-click-agent')
  fs.mkdirSync(d, { recursive: true })
  return d
}

export function modelsDir(): string {
  const d = path.join(dataDir(), 'models')
  fs.mkdirSync(d, { recursive: true })
  return d
}

export function getModelPath(): string | null {
  const dir = modelsDir()
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.gguf'))
  return files.length > 0 ? path.join(dir, files[0]) : null
}

export function isDownloaded(): boolean {
  return getModelPath() !== null
}

interface HfSibling {
  rfilename: string
}

async function findModelFilename(): Promise<string> {
  const url = `https://huggingface.co/api/models/${REPO_ID}`
  const body = await fetchJson(url)
  const siblings: HfSibling[] = body.siblings ?? []
  const quantNorm = QUANT.toLowerCase().replace(/-/g, '_')
  const match = siblings
    .filter((s) => s.rfilename.endsWith('.gguf'))
    .find((s) => s.rfilename.toLowerCase().replace(/-/g, '_').includes(quantNorm))

  if (!match) {
    const available = siblings.filter((s) => s.rfilename.endsWith('.gguf')).map((s) => s.rfilename)
    throw new Error(`Quant '${QUANT}' not found. Available: ${available.join(', ')}`)
  }
  return match.rfilename
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const get = (u: string) => {
      https.get(u, { headers: { 'User-Agent': 'one-click-agent/0.1' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location)
          return
        }
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
        res.on('error', reject)
      }).on('error', reject)
    }
    get(url)
  })
}

function emitProgress(win: BrowserWindow, p: DownloadProgress) {
  win.webContents.send('download-progress', p)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function downloadWithResume(
  url: string, dest: string, win: BrowserWindow, attempt: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part'
    let existingBytes = 0
    try {
      const stat = fs.statSync(tmp)
      existingBytes = stat.size
    } catch {}

    const doGet = (u: string) => {
      const headers: Record<string, string> = { 'User-Agent': 'one-click-agent/0.1' }
      if (existingBytes > 0) {
        headers['Range'] = `bytes=${existingBytes}-`
      }

      https.get(u, { headers }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location)
          return
        }

        const isPartial = res.statusCode === 206
        const isOk = res.statusCode === 200

        if (!isOk && !isPartial) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        // If server ignores Range and sends full file, reset
        if (isOk && existingBytes > 0) {
          existingBytes = 0
        }

        const contentLength = parseInt(res.headers['content-length'] ?? '0', 10)
        const total = isPartial ? existingBytes + contentLength : contentLength
        const totalMb = Math.round(total / (1024 * 1024))
        let downloaded = existingBytes
        let lastEmit = 0

        const file = fs.createWriteStream(tmp, { flags: isPartial ? 'a' : 'w' })
        res.pipe(file)

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          const now = Date.now()
          if (now - lastEmit > 500) {
            const dm = Math.round(downloaded / (1024 * 1024))
            const pct = total > 0 ? (downloaded / total) * 100 : 0
            emitProgress(win, {
              downloadedMb: dm,
              totalMb,
              percent: Math.round(pct * 10) / 10,
              status: `${dm} / ${totalMb} МБ (${pct.toFixed(1)}%)${attempt > 1 ? ` [попытка ${attempt}]` : ''}`,
            })
            lastEmit = now
          }
        })

        file.on('finish', () => {
          file.close()
          fs.renameSync(tmp, dest)
          emitProgress(win, { downloadedMb: totalMb, totalMb, percent: 100, status: 'Модель скачана!' })
          resolve()
        })

        res.on('error', (e) => reject(e))
        file.on('error', (e) => reject(e))
      }).on('error', reject)
    }
    doGet(url)
  })
}

export async function download(win: BrowserWindow): Promise<string> {
  emitProgress(win, { downloadedMb: 0, totalMb: 0, percent: 0, status: 'Поиск файла модели…' })

  const filename = await findModelFilename()
  const dest = path.join(modelsDir(), filename)

  if (fs.existsSync(dest)) {
    emitProgress(win, { downloadedMb: 1, totalMb: 1, percent: 100, status: 'Модель уже скачана' })
    return dest
  }

  const url = `https://huggingface.co/${REPO_ID}/resolve/main/${filename}`
  emitProgress(win, { downloadedMb: 0, totalMb: 0, percent: 0, status: `Скачивание ${filename}…` })

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadWithResume(url, dest, win, attempt)
      return dest
    } catch (e: any) {
      lastError = e
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1)
        emitProgress(win, {
          downloadedMb: 0, totalMb: 0, percent: 0,
          status: `Ошибка: ${e.message}. Повтор через ${delay / 1000}с…`,
        })
        await sleep(delay)
      }
    }
  }

  throw lastError ?? new Error('Download failed')
}
