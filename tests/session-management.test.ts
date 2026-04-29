import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let tmpHome: string | null = null
const originalHome = process.env.HOME

afterEach(() => {
  process.env.HOME = originalHome
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    tmpHome = null
  }
  vi.resetModules()
})

describe('session management cold start', () => {
  it('can create a session before the agent bridge exists', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-session-'))
    process.env.HOME = tmpHome
    vi.resetModules()

    const agent = await import('../electron/agent')
    const workspace = path.join(tmpHome, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })

    const id = agent.createSession(workspace)

    expect(id).toMatch(/^s-/)
    const list = agent.listSessions(workspace)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(id)
    expect(list[0].mode).toBe('agent')
    expect(agent.getActiveSessionId(workspace)).toBe(id)
  })
})
