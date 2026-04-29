import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadProjectRules, describeProjectRules } from '../electron/project-rules'

let tmpWs: string

beforeEach(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'project-rules-'))
})
afterEach(() => {
  try { fs.rmSync(tmpWs, { recursive: true, force: true }) } catch {}
})

function write(rel: string, content: string) {
  const abs = path.join(tmpWs, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

describe('project-rules', () => {
  it('returns empty metadata when no rule files exist', () => {
    const info = describeProjectRules(tmpWs)
    expect(info.files).toHaveLength(0)
    expect(info.totalBytes).toBe(0)
  })

  it('loads AGENTS.md', () => {
    write('AGENTS.md', '# Project rules\nPrefer small PRs.')
    const info = describeProjectRules(tmpWs)
    expect(info.files.length).toBeGreaterThan(0)
    expect(info.files.some((f) => f.relativePath === 'AGENTS.md')).toBe(true)
    const { content } = loadProjectRules(tmpWs)
    expect(content).toContain('Prefer small PRs')
    expect(content).toContain('AGENTS.md')
  })

  it('loads multiple conventional file names', () => {
    write('CLAUDE.md', 'use claude rules')
    write('.cursorrules', 'use cursor rules')
    write('.github/copilot-instructions.md', 'use copilot rules')
    const info = describeProjectRules(tmpWs)
    const names = info.files.map((f) => f.relativePath).sort()
    expect(names).toContain('CLAUDE.md')
    expect(names).toContain('.cursorrules')
    expect(names).toContain('.github/copilot-instructions.md')
  })

  it('picks up files under .cursor/rules/', () => {
    write('.cursor/rules/one.md', 'first rule')
    write('.cursor/rules/two.md', 'second rule')
    const info = describeProjectRules(tmpWs)
    const names = info.files.map((f) => f.relativePath).sort()
    expect(names).toEqual(expect.arrayContaining(['.cursor/rules/one.md', '.cursor/rules/two.md']))
  })

  it('truncates when total content exceeds the byte budget', () => {
    const huge = 'x'.repeat(200_000)
    write('AGENTS.md', huge)
    write('CLAUDE.md', huge)
    const { content, truncated } = loadProjectRules(tmpWs)
    expect(truncated).toBe(true)
    expect(content.length).toBeLessThan(huge.length * 2)
  })

  it('content is wrapped with file markers for traceability', () => {
    write('AGENTS.md', 'hello')
    write('CLAUDE.md', 'world')
    const { content } = loadProjectRules(tmpWs)
    expect(content).toMatch(/AGENTS\.md/)
    expect(content).toMatch(/CLAUDE\.md/)
  })

  it('returns empty for an invalid workspace path', () => {
    const info = describeProjectRules('/nonexistent/path/definitely-not-there')
    expect(info.files).toHaveLength(0)
  })
})
