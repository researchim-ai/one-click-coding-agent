import { execSync } from 'child_process'
import os from 'os'
import type { GpuInfo, SystemResources, ServerLaunchArgs, BinarySelection } from './types'

export function detectGpus(): GpuInfo[] {
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits',
      { timeout: 10000, encoding: 'utf-8' },
    )
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [idx, name, total, free] = line.split(',').map((s) => s.trim())
        return {
          index: parseInt(idx),
          name,
          vramTotalMb: parseInt(total),
          vramFreeMb: parseInt(free),
        }
      })
  } catch {
    return []
  }
}

function detectCudaVersion(): string | null {
  try {
    const out = execSync('nvidia-smi', { timeout: 10000, encoding: 'utf-8' })
    const match = out.match(/CUDA Version:\s*(\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function detectAmdGpu(): boolean {
  const plat = process.platform
  try {
    if (plat === 'linux') {
      const out = execSync('lspci 2>/dev/null | grep -iE "VGA|3D|Display"', {
        timeout: 5000, encoding: 'utf-8',
      })
      return /amd|radeon|advanced micro/i.test(out)
    }
    if (plat === 'win32') {
      const out = execSync('wmic path win32_videocontroller get name', {
        timeout: 5000, encoding: 'utf-8',
      })
      return /amd|radeon/i.test(out)
    }
  } catch {}
  return false
}

export function detect(): SystemResources {
  const gpus = detectGpus()
  const cpus = os.cpus()
  const totalRam = os.totalmem()
  const freeRam = os.freemem()

  return {
    gpus,
    cpuModel: cpus[0]?.model ?? 'Unknown',
    cpuCores: new Set(cpus.map((_, i) => Math.floor(i / 2))).size || cpus.length,
    cpuThreads: cpus.length,
    ramTotalMb: Math.round(totalRam / (1024 * 1024)),
    ramAvailableMb: Math.round(freeRam / (1024 * 1024)),
    cudaAvailable: gpus.length > 0,
    cudaVersion: detectCudaVersion(),
    hasAmdGpu: detectAmdGpu(),
    totalVramMb: gpus.reduce((s, g) => s + g.vramTotalMb, 0),
    platform: process.platform,
    arch: process.arch,
  }
}

export function pickBinaryVariant(res: SystemResources): BinarySelection {
  const { platform, arch, cudaVersion, hasAmdGpu, gpus } = res
  const hasNvidia = gpus.length > 0

  if (platform === 'darwin') {
    const variant = arch === 'arm64' ? 'macos-arm64' : 'macos-x64'
    return { primary: variant, fallbacks: [], needsCudart: false }
  }

  if (platform === 'win32') {
    if (hasNvidia && cudaVersion) {
      const major = parseFloat(cudaVersion)
      if (major >= 13) {
        return {
          primary: 'win-cuda-13.1-x64',
          fallbacks: ['win-cuda-12.4-x64', 'win-vulkan-x64', 'win-cpu-x64'],
          needsCudart: true,
          cudartAsset: 'cudart-llama-bin-win-cuda-13.1-x64',
        }
      }
      return {
        primary: 'win-cuda-12.4-x64',
        fallbacks: ['win-vulkan-x64', 'win-cpu-x64'],
        needsCudart: true,
        cudartAsset: 'cudart-llama-bin-win-cuda-12.4-x64',
      }
    }
    if (hasAmdGpu) {
      return { primary: 'win-vulkan-x64', fallbacks: ['win-cpu-x64'], needsCudart: false }
    }
    const cpuVariant = arch === 'arm64' ? 'win-cpu-arm64' : 'win-cpu-x64'
    return { primary: cpuVariant, fallbacks: [], needsCudart: false }
  }

  // Linux with GPU: Vulkan works with both NVIDIA and AMD via drivers
  if (hasNvidia || hasAmdGpu) {
    return { primary: 'ubuntu-vulkan-x64', fallbacks: ['ubuntu-x64'], needsCudart: false }
  }

  return { primary: 'ubuntu-x64', fallbacks: [], needsCudart: false }
}

// ---------------------------------------------------------------------------
// Presets: Qwen3.5-35B-A3B (Q4_K_XL) ~19GB
// RAM = системная память для CPU-части модели + KV cache
// VRAM = видеопамять для GPU-слоёв (1 слой ≈ 300 MB)
// ---------------------------------------------------------------------------
// RAM (GB) | VRAM (GB) | Режим  | n-gpu-layers | ctx (tokens) | KV в RAM
// ---------|-----------|--------|--------------|--------------|----------
//  16      |    0      | —      | —            | не влезет    | модель 20GB
//  24      |    0      | CPU    | 0            | 4096         |
//  32      |    0      | CPU    | 0            | 8192         |
//  48      |    0      | CPU    | 0            | 16384        |
//  64+     |    0      | CPU    | 0            | 32768        |
//  16      |    8      | Hybrid | 15–20        | 4096         | тесно
//  24      |    8      | Hybrid | 18–22        | 6144         |
//  32      |    8      | Hybrid | 18–22        | 8192         |
//  48+     |    8      | Hybrid | 18–22        | 12288        |
//  16      |   12      | Hybrid | 25–30        | 4096         |
//  32      |   12      | Hybrid | 28–32        | 12288        |
//  48+     |   12      | Hybrid | 28–32        | 16384        |
//  32      |   16      | Hybrid | 40–50        | 16384        |
//  48+     |   16      | Hybrid | 40–50        | 24576        |
//  32+     |   24      | Full   | 999          | 32768–65536  | модель на GPU
//  48+     |   24      | Full   | 999          | 65536–131072 |
//  32+     |   48+     | Full   | 999          | 131072–262144|
// ---------------------------------------------------------------------------

const MODEL_RAM_MB = 20200      // модель в RAM (CPU-часть или вся при CPU)
const MODEL_VRAM_MB = 20200    // модель целиком на GPU
const RAM_OVERHEAD_MB = 3000   // ОС, приложение, буферы
const LAYER_VRAM_MB = 320      // примерный размер одного слоя на GPU

interface Preset {
  nGpuLayers: number
  ctxSize: number
  flashAttn: boolean
}

function selectPreset(ramTotalMb: number, freeVramMb: number, isLaptop: boolean): Preset {
  const ramGb = ramTotalMb / 1024
  const vramGb = freeVramMb / 1024

  // CPU-only
  if (freeVramMb < 500) {
    const ramForModel = ramTotalMb - RAM_OVERHEAD_MB
    if (ramForModel < MODEL_RAM_MB) {
      return { nGpuLayers: 0, ctxSize: 4096, flashAttn: false }
    }
    const ramForKv = ramForModel - MODEL_RAM_MB
    const ctx = ramForKv > 12000 ? 32768 : ramForKv > 6000 ? 16384 : ramForKv > 3000 ? 8192 : 4096
    return { nGpuLayers: 0, ctxSize: ctx, flashAttn: false }
  }

  // Full GPU: модель целиком на видеокарте
  if (freeVramMb >= 22000) {
    const vramForKv = freeVramMb - MODEL_VRAM_MB
    const ctx = vramForKv > 40000 ? 262144 : vramForKv > 25000 ? 131072 : vramForKv > 12000 ? 65536 : vramForKv > 5000 ? 32768 : 16384
    return { nGpuLayers: 999, ctxSize: ctx, flashAttn: true }
  }

  // Hybrid: часть слоёв на GPU, остальное на CPU
  const maxLayersOnGpu = Math.floor((freeVramMb - 2000) / LAYER_VRAM_MB)
  const nGpuLayers = Math.min(999, Math.max(8, maxLayersOnGpu))

  // Лэптопы: запас на интегрированную графику и thermal throttling
  const effN = isLaptop ? Math.min(nGpuLayers, Math.max(12, Math.floor((freeVramMb - 3500) / 380))) : nGpuLayers

  // CPU держит слои не на GPU: ~(52 - effN) * 400 MB. Оставшаяся RAM — для KV
  const estCpuLayers = Math.max(0, 52 - Math.min(effN, 52))
  const ramForCpuModel = estCpuLayers * 400
  const ramForKv = ramTotalMb - RAM_OVERHEAD_MB - ramForCpuModel

  let ctxFromRam: number
  if (ramForKv > 10000) ctxFromRam = 16384
  else if (ramForKv > 6000) ctxFromRam = 12288
  else if (ramForKv > 3000) ctxFromRam = 8192
  else if (ramForKv > 1000) ctxFromRam = 6144
  else ctxFromRam = 4096

  // Ограничение по VRAM для KV (если часть KV на GPU)
  const vramForKv = freeVramMb - (effN * LAYER_VRAM_MB)
  const ctxFromVram = vramForKv > 8000 ? 16384 : vramForKv > 4000 ? 8192 : 4096

  const ctxSize = Math.min(ctxFromRam, ctxFromVram)

  return {
    nGpuLayers: effN,
    ctxSize: Math.max(4096, ctxSize),
    flashAttn: true,
  }
}

export function computeOptimalArgs(res: SystemResources): ServerLaunchArgs {
  const threads = Math.max(1, Math.floor(res.cpuThreads / 2))
  const freeVram = res.gpus.reduce((s, g) => s + g.vramFreeMb, 0)
  const isLaptop = res.gpus.some((g) => /laptop|mobile/i.test(g.name))

  let tensorSplit: string | null = null
  if (res.gpus.length > 1) {
    const total = res.gpus.reduce((s, g) => s + g.vramFreeMb, 0)
    if (total > 0) {
      tensorSplit = res.gpus.map((g) => (g.vramFreeMb / total).toFixed(2)).join(',')
    }
  }

  const preset = selectPreset(res.ramTotalMb, freeVram, isLaptop)

  return {
    nGpuLayers: preset.nGpuLayers,
    ctxSize: preset.ctxSize,
    threads,
    tensorSplit,
    flashAttn: preset.flashAttn,
  }
}
