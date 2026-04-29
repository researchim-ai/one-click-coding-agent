import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let tmpHome: string | null = null
const originalHome = process.env.HOME

afterEach(() => {
  process.env.HOME = originalHome
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true })
  tmpHome = null
  vi.resetModules()
})

describe('project memory and plan artifact', () => {
  it('persists project memory outside chat sessions', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-memory-'))
    process.env.HOME = tmpHome
    vi.resetModules()

    const memory = await import('../electron/project-memory')
    const workspace = path.join(tmpHome, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })

    memory.appendProjectMemory(workspace, {
      category: 'decision',
      title: 'Use Vite',
      content: 'The frontend build system is Vite.',
    })

    const rendered = memory.readProjectMemory(workspace)
    expect(rendered).toContain('Architecture decision: Use Vite')
    expect(rendered).toContain('The frontend build system is Vite.')
  })

  it('saves PLAN.md from the active session task state', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-plan-'))
    process.env.HOME = tmpHome
    vi.resetModules()

    const agent = await import('../electron/agent')
    const workspace = path.join(tmpHome, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })

    const id = agent.createSession(workspace)
    const session = agent.getActiveSession(workspace)
    session.taskState = {
      goal: 'Ship plan artifacts',
      plan: [
        { id: '1', title: 'Add save button', status: 'completed' },
        { id: '2', title: 'Write IPC handler', status: 'pending' },
      ],
      notes: 'Keep it simple.',
    }
    agent.saveSession(session)

    const saved = agent.savePlanArtifact(workspace, id)
    expect(saved.path).toBe(path.join(workspace, 'PLAN.md'))
    const content = fs.readFileSync(saved.path, 'utf-8')
    expect(content).toContain('# PLAN')
    expect(content).toContain('Ship plan artifacts')
    expect(content).toContain('[completed] Add save button')
    expect(content).toContain('```mermaid')
  })
})
