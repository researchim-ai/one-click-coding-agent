import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { executeTool, getBuiltinToolDefinitions } from '../electron/tools'

// Most executeTool paths are thin wrappers over fs. We exercise the
// critical ones (read/write/list/edit) on a throwaway workspace. These
// tests double as a guardrail against accidental edit of the
// shell-exec path security model.

let tmpWs: string

beforeEach(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-ws-'))
})
afterEach(() => {
  try { fs.rmSync(tmpWs, { recursive: true, force: true }) } catch {}
})

describe('executeTool', () => {
  describe('write_file / read_file', () => {
    it('round-trips a file', () => {
      const w = executeTool('write_file', { path: 'hello.txt', content: 'hi' }, tmpWs)
      expect(w).not.toMatch(/^Error/i)
      const r = executeTool('read_file', { path: 'hello.txt' }, tmpWs)
      expect(r).toContain('hi')
    })

    it('read_file on a missing path returns an error string', () => {
      const r = executeTool('read_file', { path: 'nope.txt' }, tmpWs)
      expect(r).toMatch(/error|not exist|not found/i)
    })

    it('refuses absolute / traversal paths outside the workspace', () => {
      const r = executeTool('read_file', { path: '/etc/passwd' }, tmpWs)
      expect(r).toMatch(/error|outside|forbidden/i)
    })
  })

  describe('list_directory', () => {
    it('lists files at the workspace root', () => {
      fs.writeFileSync(path.join(tmpWs, 'a.txt'), 'x')
      fs.mkdirSync(path.join(tmpWs, 'sub'))
      const r = executeTool('list_directory', { path: '.' }, tmpWs)
      expect(r).toMatch(/a\.txt/)
      expect(r).toMatch(/sub/)
    })
  })

  describe('create_directory / delete_file', () => {
    it('creates nested directories', () => {
      const r = executeTool('create_directory', { path: 'a/b/c' }, tmpWs)
      expect(r).not.toMatch(/^Error/i)
      expect(fs.existsSync(path.join(tmpWs, 'a/b/c'))).toBe(true)
    })

    it('deletes a file that exists', () => {
      fs.writeFileSync(path.join(tmpWs, 'bye.txt'), 'x')
      const r = executeTool('delete_file', { path: 'bye.txt' }, tmpWs)
      expect(r).not.toMatch(/^Error/i)
      expect(fs.existsSync(path.join(tmpWs, 'bye.txt'))).toBe(false)
    })
  })

  describe('edit_file', () => {
    it('replaces a literal block', () => {
      fs.writeFileSync(path.join(tmpWs, 'f.ts'), 'const x = 1\nconst y = 2\n')
      const r = executeTool('edit_file', {
        path: 'f.ts',
        old_string: 'const x = 1',
        new_string: 'const x = 42',
      }, tmpWs)
      expect(r).not.toMatch(/^Error/i)
      const body = fs.readFileSync(path.join(tmpWs, 'f.ts'), 'utf-8')
      expect(body).toContain('const x = 42')
      expect(body).toContain('const y = 2')
    })

    it('fails cleanly when old_string is not found', () => {
      fs.writeFileSync(path.join(tmpWs, 'f.ts'), 'const x = 1\n')
      const r = executeTool('edit_file', {
        path: 'f.ts',
        old_string: 'nope',
        new_string: 'y',
      }, tmpWs)
      expect(r).toMatch(/error|not found/i)
    })
  })

  describe('find_files', () => {
    it('finds files by glob pattern', () => {
      fs.writeFileSync(path.join(tmpWs, 'a.ts'), '')
      fs.writeFileSync(path.join(tmpWs, 'b.ts'), '')
      fs.writeFileSync(path.join(tmpWs, 'c.js'), '')
      const r = executeTool('find_files', { pattern: '*.ts' }, tmpWs)
      expect(r).toContain('a.ts')
      expect(r).toContain('b.ts')
      expect(r).not.toContain('c.js')
    })
  })

  describe('code index tools', () => {
    it('searches code index and reads symbol context', () => {
      fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true })
      fs.writeFileSync(path.join(tmpWs, 'src', 'runner.ts'), 'export class Runner {}\n')

      const search = executeTool('search_code_index', { query: 'Runner' }, tmpWs)
      expect(search).toContain('src/runner.ts:1 class Runner')

      const ctx = executeTool('get_symbol_context', { symbol: 'Runner' }, tmpWs)
      expect(ctx).toContain('export class Runner')
    })
  })
})

describe('tool definitions', () => {
  it('returns a non-empty builtin list', () => {
    const defs = getBuiltinToolDefinitions({
      approvalPolicy: 'always',
      customTools: [],
    } as any)
    expect(Array.isArray(defs)).toBe(true)
    expect(defs.length).toBeGreaterThan(3)
    for (const d of defs) {
      expect(d.type).toBe('function')
      expect(typeof d.function.name).toBe('string')
    }
  })
})
