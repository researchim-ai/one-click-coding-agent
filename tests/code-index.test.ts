import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCodeIndex,
  getCodeIndexStatus,
  getSymbolContext,
  invalidateWorkspace,
  renderCodeIndexMap,
  searchCodeIndex,
} from '../electron/code-index'

let tmpWs: string

beforeEach(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-'))
})

afterEach(() => {
  try { fs.rmSync(tmpWs, { recursive: true, force: true }) } catch {}
})

function write(rel: string, content: string) {
  const abs = path.join(tmpWs, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

describe('code-index', () => {
  it('indexes symbols, imports, and exports with line numbers', () => {
    write('src/service.ts', [
      "import { helper } from './helper'",
      'export interface Options { ok: boolean }',
      'export class Service {}',
      'export function run() { return helper() }',
    ].join('\n'))

    const index = buildCodeIndex(tmpWs)
    const file = index.files.find((entry) => entry.relativePath === 'src/service.ts')
    expect(file).toBeTruthy()
    expect(file?.imports).toContain('./helper')
    expect(file?.exports).toContain('Options')
    expect(file?.symbols.map((s) => `${s.kind}:${s.name}:${s.line}`)).toContain('class:Service:3')
  })

  it('searches symbols and returns focused symbol context', () => {
    write('src/agent.ts', [
      'export class AgentRunner {',
      '  run() { return 1 }',
      '}',
    ].join('\n'))
    buildCodeIndex(tmpWs)

    expect(searchCodeIndex(tmpWs, 'AgentRunner')).toContain('src/agent.ts:1 class AgentRunner')
    const ctx = getSymbolContext(tmpWs, 'AgentRunner')
    expect(ctx).toContain('src/agent.ts:1')
    expect(ctx).toContain('export class AgentRunner')
  })

  it('reports stale status after invalidation', () => {
    write('src/a.ts', 'export function a() {}')
    buildCodeIndex(tmpWs)
    expect(getCodeIndexStatus(tmpWs).stale).toBe(false)
    invalidateWorkspace(tmpWs)
    expect(getCodeIndexStatus(tmpWs).stale).toBe(true)
  })

  it('renders a compact repo map', () => {
    write('src/a.ts', 'export function hello() {}')
    const out = renderCodeIndexMap(tmpWs, 2000)
    expect(out).toContain('## Code index / repo map')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('function hello')
  })
})
