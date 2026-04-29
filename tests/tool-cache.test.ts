import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as tc from '../electron/tool-cache'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tool-cache-'))
}

describe('tool-cache', () => {
  beforeEach(() => {
    tc.clear()
    tc.resetStats()
  })

  describe('basic hit/miss', () => {
    it('misses on cold cache', () => {
      const dir = tmpDir()
      expect(tc.lookup('read_file', { path: 'x' }, dir)).toBeNull()
      expect(tc.getStats().misses).toBe(1)
      expect(tc.getStats().hits).toBe(0)
    })

    it('returns the stored result on hit', () => {
      const dir = tmpDir()
      const file = path.join(dir, 'a.txt')
      fs.writeFileSync(file, 'hello')
      tc.put('read_file', { path: file }, 'hello', dir, 1)
      const hit = tc.lookup('read_file', { path: file }, dir)
      expect(hit).not.toBeNull()
      expect(hit!.result).toBe('hello')
      expect(tc.getStats().hits).toBe(1)
    })

    it('only caches the whitelisted tools', () => {
      const dir = tmpDir()
      expect(tc.put('write_file', { path: 'a' }, 'x', dir, 1)).toBeNull()
      expect(tc.put('delete_file', { path: 'a' }, 'x', dir, 1)).toBeNull()
      expect(tc.put('execute_command', { command: 'rm -rf foo' }, 'x', dir, 1)).toBeNull()
    })

    it('does NOT cache results larger than the byte limit', () => {
      const dir = tmpDir()
      const huge = 'x'.repeat(3 * 1024 * 1024)
      expect(tc.put('read_file', { path: 'big.txt' }, huge, dir, 1)).toBeNull()
    })

    it('argument order does not matter for cache key', () => {
      const dir = tmpDir()
      tc.put('grep', { q: 'foo', path: 'src' }, 'match', dir, 1)
      const hit = tc.lookup('grep', { path: 'src', q: 'foo' }, dir)
      expect(hit).not.toBeNull()
    })
  })

  describe('file-backed invalidation', () => {
    it('invalidates on mtime change', async () => {
      const dir = tmpDir()
      const file = path.join(dir, 'a.txt')
      fs.writeFileSync(file, 'first')
      tc.put('read_file', { path: file }, 'first', dir, 1)

      // Bump mtime forward deterministically.
      const future = (Date.now() + 1000) / 1000
      fs.utimesSync(file, future, future)
      fs.writeFileSync(file, 'second')

      expect(tc.lookup('read_file', { path: file }, dir)).toBeNull()
    })

    it('invalidateFile drops matching entries', () => {
      const dir = tmpDir()
      const file = path.join(dir, 'a.txt')
      fs.writeFileSync(file, 'x')
      tc.put('read_file', { path: file }, 'x', dir, 1)
      expect(tc.lookup('read_file', { path: file }, dir)).not.toBeNull()

      tc.invalidateFile(file)
      expect(tc.lookup('read_file', { path: file }, dir)).toBeNull()
    })

    it('invalidates when the file disappears', () => {
      const dir = tmpDir()
      const file = path.join(dir, 'a.txt')
      fs.writeFileSync(file, 'x')
      tc.put('read_file', { path: file }, 'x', dir, 1)
      fs.unlinkSync(file)
      expect(tc.lookup('read_file', { path: file }, dir)).toBeNull()
    })
  })

  describe('readonly command heuristic', () => {
    it('caches pure read-only shell commands', () => {
      const dir = tmpDir()
      const stored = tc.put('execute_command', { command: 'ls -la' }, 'total 0', dir, 1)
      expect(stored).not.toBeNull()
    })

    it('refuses obviously mutating commands', () => {
      const dir = tmpDir()
      for (const cmd of ['rm -rf foo', 'echo x > f', 'npm install', 'mv a b', 'sed -i s/a/b/ f']) {
        expect(tc.put('execute_command', { command: cmd }, 'ok', dir, 1)).toBeNull()
      }
    })

    it('treats git status / diff as readonly', () => {
      const dir = tmpDir()
      expect(tc.put('execute_command', { command: 'git status' }, 'clean', dir, 1)).not.toBeNull()
      expect(tc.put('execute_command', { command: 'git diff --stat' }, '...', dir, 1)).not.toBeNull()
    })
  })

  describe('retrospective dedup', () => {
    it('rewrites older tool messages with the same content hash', () => {
      const msgs: any[] = [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'IDENTICAL' },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'IDENTICAL' },
      ]
      const e = tc.put('grep', { q: 'y' }, 'IDENTICAL', '/tmp', 5)
      const n = tc.dedupHistoricalResults(msgs, 'sess', e!.contentHash, tc.renderDedupPointer(5, 'grep'))
      expect(n).toBe(1)
      expect(msgs[1].content).toMatch(/same grep result/)
      expect(msgs[3].content).toBe('IDENTICAL')
    })

    it('is idempotent — already-replaced pointers are not rewritten', () => {
      const pointer = '[↺ same grep result is shown again at turn 5. Refer to that turn for the content.]'
      const msgs: any[] = [
        { role: 'tool', content: pointer },
        { role: 'tool', content: 'IDENTICAL' },
      ]
      const e = tc.put('grep', { q: 'y' }, 'IDENTICAL', '/tmp', 5)
      const n = tc.dedupHistoricalResults(msgs, 'sess', e!.contentHash, pointer)
      expect(n).toBe(0)
    })
  })

  describe('short-circuit rendering', () => {
    it('renders cache markers the LLM can parse', () => {
      const dir = tmpDir()
      const file = path.join(dir, 'a.txt')
      fs.writeFileSync(file, 'body')
      const entry = tc.put('read_file', { path: file }, 'body', dir, 3)!
      const out = tc.renderCachedShortCircuit(entry, 7)
      expect(out).toMatch(/↺ cached result/)
      expect(out).toMatch(/turn 3/)
      expect(out).toMatch(/file mtime unchanged/)
      expect(out).toContain('body')
    })
  })
})
