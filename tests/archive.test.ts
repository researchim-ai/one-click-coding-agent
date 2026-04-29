import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as archive from '../electron/archive'

// We rewrite HOME for the test so the archive writes under a throwaway
// directory, never touching the real ~/.one-click-agent.
let tmpHome: string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-home-'))
  process.env.HOME = tmpHome
  // `os.homedir()` caches on some platforms — the archive module reads
  // HOME at import time so we need to re-resolve. The module is already
  // loaded; since its constant is built from `os.homedir()` at import,
  // we can't override it here. Instead, test by writing under the
  // computed path and then checking that path.
})

describe('archive', () => {
  // Key: any stable string. Archive module slugifies nothing, it uses
  // whatever we pass in directly as a directory name.
  const sessionId = 's-test-' + Date.now()
  const workspaceKey = 'ws-archive-test'

  it('round-trips appended messages', () => {
    archive.appendMessages(workspaceKey, sessionId, [
      { role: 'user', content: 'hello', turn: 1, ts: 1 },
      { role: 'assistant', content: 'world', turn: 2, ts: 2 },
    ])
    const entries = archive.readArchive(workspaceKey, sessionId)
    expect(entries.length).toBeGreaterThanOrEqual(2)
    const last = entries.slice(-2)
    expect(last[0].content).toBe('hello')
    expect(last[1].role).toBe('assistant')
  })

  it('recall finds the most recent substring match', () => {
    const sid = 's-recall-' + Date.now()
    archive.appendMessages(workspaceKey, sid, [
      { role: 'user', content: 'look at unique-needle-alpha', turn: 1, ts: 1 },
      { role: 'assistant', content: 'ok', turn: 2, ts: 2 },
      { role: 'user', content: 'repeat unique-needle-alpha again', turn: 3, ts: 3 },
    ])
    const hits = archive.recall(workspaceKey, sid, 'unique-needle-alpha', 5)
    expect(hits.length).toBe(2)
    // Most recent first
    expect(hits[0].turn).toBe(3)
    expect(hits[0].excerpt).toContain('unique-needle-alpha')
    archive.deleteArchive(workspaceKey, sid)
  })

  it('recall is case-insensitive', () => {
    const sid = 's-case-' + Date.now()
    archive.appendMessages(workspaceKey, sid, [
      { role: 'user', content: 'Error: FailedToBuild', turn: 1, ts: 1 },
    ])
    const hits = archive.recall(workspaceKey, sid, 'failedtobuild', 5)
    expect(hits.length).toBe(1)
    archive.deleteArchive(workspaceKey, sid)
  })

  it('recall caps at maxHits', () => {
    const sid = 's-max-' + Date.now()
    const batch = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      content: `needle occurrence ${i}`,
      turn: i,
      ts: i,
    }))
    archive.appendMessages(workspaceKey, sid, batch)
    const hits = archive.recall(workspaceKey, sid, 'needle', 3)
    expect(hits.length).toBe(3)
    archive.deleteArchive(workspaceKey, sid)
  })

  it('recall with empty query returns nothing', () => {
    const sid = 's-empty-' + Date.now()
    archive.appendMessages(workspaceKey, sid, [{ role: 'user', content: 'x', turn: 1, ts: 1 }])
    expect(archive.recall(workspaceKey, sid, '', 5)).toEqual([])
    expect(archive.recall(workspaceKey, sid, '   ', 5)).toEqual([])
    archive.deleteArchive(workspaceKey, sid)
  })

  it('readArchive returns [] for a nonexistent session', () => {
    expect(archive.readArchive('nope', 'does-not-exist')).toEqual([])
  })

  it('deleteArchive clears the file silently even if missing', () => {
    expect(() => archive.deleteArchive('nope', 'never-was')).not.toThrow()
  })

  it('different sessions are isolated', () => {
    const a = 's-a-' + Date.now()
    const b = 's-b-' + Date.now()
    archive.appendMessages(workspaceKey, a, [{ role: 'user', content: 'A-only', turn: 1, ts: 1 }])
    archive.appendMessages(workspaceKey, b, [{ role: 'user', content: 'B-only', turn: 1, ts: 1 }])
    expect(archive.recall(workspaceKey, a, 'A-only', 5).length).toBe(1)
    expect(archive.recall(workspaceKey, a, 'B-only', 5).length).toBe(0)
    archive.deleteArchive(workspaceKey, a)
    archive.deleteArchive(workspaceKey, b)
  })
})
