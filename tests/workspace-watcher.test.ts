import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as toolCache from '../electron/tool-cache'
import * as watcher from '../electron/workspace-watcher'

let tmp: string | null = null
afterEach(() => {
  try { watcher.stopWatching() } catch {}
  toolCache.clear()
  if (tmp) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    tmp = null
  }
})

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

describe('workspace-watcher → tool-cache', () => {
  it('invalidates tool-cache when a watched file changes externally', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-watch-'))
    const file = path.join(tmp, 'code.ts')
    fs.writeFileSync(file, 'export const x = 1\n')

    // Prime the cache with a fake read_file entry pointing at `file`.
    toolCache.put('read_file', { path: 'code.ts' }, 'old content', tmp, 1)
    expect(toolCache.lookup('read_file', { path: 'code.ts' }, tmp)).toBeTruthy()

    watcher.watchWorkspace(tmp)

    // External change on disk (simulates user editing in VS Code).
    fs.writeFileSync(file, 'export const x = 2\n')

    // Wait for fs.watch -> debounce (40ms) -> invalidation.
    await delay(200)
    watcher.__flushPendingForTests()

    expect(toolCache.lookup('read_file', { path: 'code.ts' }, tmp)).toBeNull()
  })

  it('ignores changes under ignored dirs like node_modules', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-watch-'))
    const nm = path.join(tmp, 'node_modules')
    fs.mkdirSync(nm)
    const insideNm = path.join(nm, 'garbage.txt')
    fs.writeFileSync(insideNm, 'noise')

    // Track one real file and prime its cache entry.
    const real = path.join(tmp, 'app.ts')
    fs.writeFileSync(real, 'a')
    toolCache.put('read_file', { path: 'app.ts' }, 'cached', tmp, 1)

    watcher.watchWorkspace(tmp)

    // Touch a node_modules file — must NOT invalidate anything.
    fs.writeFileSync(insideNm, 'noise2')
    await delay(150)
    watcher.__flushPendingForTests()

    // Our unrelated cache entry for app.ts should still be there.
    expect(toolCache.lookup('read_file', { path: 'app.ts' }, tmp)).not.toBeNull()
  })

  it('stopWatching clears pending timers and is idempotent', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-watch-'))
    watcher.watchWorkspace(tmp)
    watcher.stopWatching()
    watcher.stopWatching() // double-stop must not throw
    expect(watcher.__getWatchedRoot()).toBeNull()
  })
})
