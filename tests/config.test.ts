import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let tmpHome: string | null = null
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE

function configFile(home: string): string {
  return path.join(home, '.one-click-agent', 'config.json')
}

async function loadConfigModule(homePrefix: string) {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), homePrefix))
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  vi.resetModules()
  return import('../electron/config')
}

afterEach(() => {
  process.env.HOME = originalHome
  process.env.USERPROFILE = originalUserProfile
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true })
  tmpHome = null
  vi.resetModules()
})

describe('config approval defaults', () => {
  it('defaults file and command approvals to off for new installs', async () => {
    const config = await loadConfigModule('oca-config-new-')

    const loaded = config.load()

    expect(loaded.approvalForFileOps).toBe(false)
    expect(loaded.approvalForCommands).toBe(false)
  })

  it('migrates old accidental approval defaults to off', async () => {
    const config = await loadConfigModule('oca-config-migrate-')
    const file = configFile(tmpHome!)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      lastQuant: 'UD-Q4_K_XL',
      approvalForFileOps: true,
      approvalForCommands: true,
    }), 'utf-8')
    vi.resetModules()

    const reloaded = await import('../electron/config')
    const loaded = reloaded.load()

    expect(loaded.approvalForFileOps).toBe(false)
    expect(loaded.approvalForCommands).toBe(false)
    expect(loaded.approvalDefaultsMigrated).toBe(true)
  })

  it('preserves legacy explicit approvalRequired intent', async () => {
    const config = await loadConfigModule('oca-config-legacy-')
    const file = configFile(tmpHome!)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      lastQuant: 'UD-Q4_K_XL',
      approvalRequired: true,
    }), 'utf-8')
    vi.resetModules()

    const reloaded = await import('../electron/config')
    const loaded = reloaded.load()

    expect(loaded.approvalForFileOps).toBe(true)
    expect(loaded.approvalForCommands).toBe(true)
  })
})
