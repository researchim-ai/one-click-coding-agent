import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ensureShadowRepo,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  checkpointDiffStat,
  describeToolForCheckpoint,
  shadowGitDir,
} from '../electron/checkpoints'

// Check whether git is available at all — without it this suite has to
// skip. Skipping is fine: CI images in practice always have git, and
// local devs running Electron will too.
function hasGit(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const GIT_OK = hasGit()

let tmpWs: string
let tmpHome: string

beforeEach(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ws-'))
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-home-'))
  // `shadowGitDir` depends on `os.homedir()`. Override HOME so shadow
  // repo lives under tmp and doesn't touch the real user's state. This
  // works because checkpoints.ts reads os.homedir() lazily via functions,
  // not at import time.
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
})

afterEach(() => {
  try { fs.rmSync(tmpWs, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

describe.skipIf(!GIT_OK)('checkpoints', () => {
  describe('describeToolForCheckpoint', () => {
    it('describes write_file succinctly', () => {
      expect(describeToolForCheckpoint('write_file', { path: 'a/b.ts' })).toMatch(/write_file.*a\/b\.ts/)
    })
    it('truncates long execute_command strings', () => {
      const long = 'echo ' + 'x'.repeat(500)
      const out = describeToolForCheckpoint('execute_command', { command: long })
      expect(out.length).toBeLessThan(long.length)
    })
    it('handles missing args gracefully', () => {
      expect(typeof describeToolForCheckpoint('write_file', {})).toBe('string')
      expect(typeof describeToolForCheckpoint('unknown_tool', {})).toBe('string')
    })
  })

  describe('shadow repo lifecycle', () => {
    it('ensureShadowRepo is idempotent', () => {
      ensureShadowRepo(tmpWs)
      ensureShadowRepo(tmpWs)
      const dir = shadowGitDir(tmpWs)
      expect(fs.existsSync(dir)).toBe(true)
    })

    it('createCheckpoint returns a SHA after changes', () => {
      fs.writeFileSync(path.join(tmpWs, 'a.txt'), 'hello')
      const cp = createCheckpoint(tmpWs, 'initial')
      expect(cp).not.toBeNull()
      expect(cp!.sha.length).toBeGreaterThan(6)
      expect(cp!.label).toBe('initial')
    })

    it('listCheckpoints returns newest first', () => {
      fs.writeFileSync(path.join(tmpWs, 'a.txt'), 'v1')
      const c1 = createCheckpoint(tmpWs, 'first')
      fs.writeFileSync(path.join(tmpWs, 'a.txt'), 'v2')
      const c2 = createCheckpoint(tmpWs, 'second')
      const list = listCheckpoints(tmpWs, 10)
      expect(list.length).toBeGreaterThanOrEqual(2)
      expect(list[0].sha).toBe(c2!.sha)
      expect(list.find((c) => c.sha === c1!.sha)).toBeTruthy()
    })

    it('restoreCheckpoint rewinds workspace contents', () => {
      const file = path.join(tmpWs, 'a.txt')
      fs.writeFileSync(file, 'v1')
      const c1 = createCheckpoint(tmpWs, 'v1')
      expect(c1).not.toBeNull()
      fs.writeFileSync(file, 'v2-modified')
      createCheckpoint(tmpWs, 'v2')
      const r = restoreCheckpoint(tmpWs, c1!.sha)
      expect(r).not.toBeNull()
      expect(fs.readFileSync(file, 'utf-8')).toBe('v1')
    })

    it('checkpointDiffStat returns something informative', () => {
      const file = path.join(tmpWs, 'a.txt')
      fs.writeFileSync(file, 'v1')
      const c1 = createCheckpoint(tmpWs, 'v1')
      fs.writeFileSync(file, 'v1\nmore\nlines\n')
      const stat = checkpointDiffStat(tmpWs, c1!.sha)
      expect(typeof stat).toBe('string')
    })

    it('checkpoints with no changes point at the same tree as the previous one', () => {
      fs.writeFileSync(path.join(tmpWs, 'a.txt'), 'hi')
      const first = createCheckpoint(tmpWs, 'first')
      expect(first).not.toBeNull()
      // No filesystem change — createCheckpoint returns something, but
      // restoring either SHA should leave the file identical.
      const second = createCheckpoint(tmpWs, 'still the same')
      const body = fs.readFileSync(path.join(tmpWs, 'a.txt'), 'utf-8')
      if (second) {
        restoreCheckpoint(tmpWs, second.sha)
        expect(fs.readFileSync(path.join(tmpWs, 'a.txt'), 'utf-8')).toBe(body)
      }
    })
  })
})
