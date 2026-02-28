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

export function computeOptimalArgs(res: SystemResources): ServerLaunchArgs {
  const threads = Math.max(1, Math.floor(res.cpuThreads / 2))

  if (res.gpus.length === 0) {
    // CPU-only: limited by RAM, be conservative
    const ramForCtx = res.ramAvailableMb - 22000 // model ~19GB + overhead
    const ctxSize = ramForCtx > 16000 ? 32768 : ramForCtx > 8000 ? 16384 : 8192
    return { nGpuLayers: 0, ctxSize, threads, tensorSplit: null, flashAttn: false }
  }

  const freeVram = res.gpus.reduce((s, g) => s + g.vramFreeMb, 0)
  let tensorSplit: string | null = null

  if (res.gpus.length > 1) {
    const total = res.gpus.reduce((s, g) => s + g.vramFreeMb, 0)
    if (total > 0) {
      tensorSplit = res.gpus.map((g) => (g.vramFreeMb / total).toFixed(2)).join(',')
    }
  }

  // Qwen3.5-35B-A3B (MoE, 3B active) — model ~19GB in Q4_K_XL
  // Native context: 262,144 tokens (extensible to 1M)
  // KV cache is relatively small due to MoE architecture (~0.5MB/token)
  // Remaining VRAM after model weights feeds the KV cache
  const vramForKv = freeVram - 20000 // model weight + safety margin (MB)
  let ctxSize: number
  if (vramForKv > 40000) {
    ctxSize = 262144   // 256K — full native context
  } else if (vramForKv > 25000) {
    ctxSize = 131072   // 128K
  } else if (vramForKv > 12000) {
    ctxSize = 65536    // 64K
  } else if (vramForKv > 5000) {
    ctxSize = 32768    // 32K
  } else {
    ctxSize = 16384    // 16K minimum with GPU
  }

  return {
    nGpuLayers: 999,
    ctxSize,
    threads,
    tensorSplit,
    flashAttn: true,
  }
}
