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

  it('can read task state for a specific non-active session', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-session-state-'))
    process.env.HOME = tmpHome
    vi.resetModules()

    const agent = await import('../electron/agent')
    const workspace = path.join(tmpHome, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })

    const first = agent.createSession(workspace)
    const firstSession = agent.getActiveSession(workspace)
    firstSession.taskState = {
      goal: 'first goal',
      plan: [{ id: 1, title: 'first step', status: 'in_progress' }],
      notes: '',
      updatedAt: Date.now(),
    }
    agent.saveSession(firstSession)

    const second = agent.createSession(workspace)
    const secondSession = agent.getActiveSession(workspace)
    secondSession.taskState = {
      goal: 'second goal',
      plan: [{ id: 1, title: 'second step', status: 'in_progress' }],
      notes: '',
      updatedAt: Date.now(),
    }
    agent.saveSession(secondSession)

    expect(agent.getSessionById(workspace, first)?.taskState?.goal).toBe('first goal')
    expect(agent.getSessionById(workspace, second)?.taskState?.goal).toBe('second goal')
  })

  it('selects a plan option and promotes its steps to the active plan', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-session-option-'))
    process.env.HOME = tmpHome
    vi.resetModules()

    const agent = await import('../electron/agent')
    const workspace = path.join(tmpHome, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })

    const id = agent.createSession(workspace)
    const session = agent.getActiveSession(workspace)
    session.taskState = {
      goal: 'choose plan',
      plan: [],
      planOptions: [
        {
          id: 'quick',
          title: 'Quick',
          summary: 'Small patch',
          steps: [{ id: 1, title: 'Patch locally', status: 'pending' }],
        },
        {
          id: 'robust',
          title: 'Robust',
          summary: 'Better design',
          recommended: true,
          steps: [
            { id: 1, title: 'Refactor boundary', status: 'pending' },
            { id: 2, title: 'Add regression tests', status: 'pending' },
          ],
        },
      ],
      notes: '',
      updatedAt: Date.now(),
    }
    agent.saveSession(session)

    const next = agent.selectPlanOption(workspace, id, 'robust')

    expect(next?.selectedPlanOptionId).toBe('robust')
    expect(next?.plan.map((s) => s.title)).toEqual(['Refactor boundary', 'Add regression tests'])
    expect(agent.getSessionById(workspace, id)?.taskState?.selectedPlanOptionId).toBe('robust')
  })
})
