import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import * as git from '../electron/git'
import * as checkpoints from '../electron/checkpoints'

function hasGit(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-git-diff-'))
  execSync('git init', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.name test', { cwd: dir })
  execSync('git config user.email test@example.com', { cwd: dir })
  return dir
}

describe.runIf(hasGit())('git file diff helpers', () => {
  it('returns hunks for modified tracked files', () => {
    const repo = makeRepo()
    try {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n')
      execSync('git add a.txt && git commit -m init', { cwd: repo, stdio: 'ignore' })
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')

      const diff = git.getFileDiff(repo, path.join(repo, 'a.txt'))

      expect(diff.hasChanges).toBe(true)
      expect(diff.isNewFile).toBe(false)
      expect(diff.additions).toBeGreaterThan(0)
      expect(diff.removals).toBeGreaterThan(0)
      expect(diff.hunks.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('restores tracked files to HEAD when discarded', () => {
    const repo = makeRepo()
    try {
      const file = path.join(repo, 'a.txt')
      fs.writeFileSync(file, 'original\n')
      execSync('git add a.txt && git commit -m init', { cwd: repo, stdio: 'ignore' })
      fs.writeFileSync(file, 'changed\n')

      const result = git.discardFileChanges(repo, file)

      expect(result.deleted).toBe(false)
      expect(fs.readFileSync(file, 'utf-8')).toBe('original\n')
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('treats untracked files as new and deletes them on discard', () => {
    const repo = makeRepo()
    try {
      execSync('git commit --allow-empty -m init', { cwd: repo, stdio: 'ignore' })
      const file = path.join(repo, 'new.txt')
      fs.writeFileSync(file, 'hello\n')

      const diff = git.getFileDiff(repo, file)
      const result = git.discardFileChanges(repo, file)

      expect(diff.isNewFile).toBe(true)
      expect(diff.additions).toBeGreaterThan(0)
      expect(result.deleted).toBe(true)
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('uses shadow checkpoints as the baseline outside user git repos', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-shadow-diff-'))
    try {
      const file = path.join(workspace, 'agent.txt')
      fs.writeFileSync(file, 'before\nline\n')
      checkpoints.createCheckpoint(workspace, 'before agent edit')
      fs.writeFileSync(file, 'before\nchanged\nadded\n')

      const diff = git.getFileDiff(workspace, file)

      expect(diff.baseline).toBe('shadow')
      expect(diff.hasChanges).toBe(true)
      expect(diff.additions).toBeGreaterThan(0)
      expect(diff.removals).toBeGreaterThan(0)
      const changes = git.getAgentFileChanges(workspace)
      expect(changes).toMatchObject([
        { path: 'agent.txt', status: 'modified' },
      ])
      expect(changes[0].added).toBeGreaterThan(0)
      expect(changes[0].deleted).toBeGreaterThan(0)
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('keeps per-file agent baseline after later checkpoints advance', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-agent-baseline-persist-'))
    try {
      const file = path.join(workspace, 'agent.txt')
      fs.writeFileSync(file, 'before\nline\n')
      git.captureAgentFileBaseline(workspace, file)
      checkpoints.createCheckpoint(workspace, 'before first agent edit')
      fs.writeFileSync(file, 'before\nchanged\n')

      // A later agent tool/checkpoint snapshots the already changed worktree.
      // Inline diff must still compare against the original per-file baseline.
      checkpoints.createCheckpoint(workspace, 'before later agent edit')

      const diff = git.getFileDiff(workspace, file)
      expect(diff.baseline).toBe('shadow')
      expect(diff.hasChanges).toBe(true)
      expect(diff.oldContent).toBe('before\nline\n')
      expect(diff.newContent).toBe('before\nchanged\n')
      expect(git.getAgentFileChanges(workspace)).toMatchObject([
        { path: 'agent.txt', status: 'modified' },
      ])
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('lists agent-created files for sidebar badges', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-agent-sidebar-new-'))
    try {
      fs.writeFileSync(path.join(workspace, 'base.txt'), 'base\n')
      checkpoints.createCheckpoint(workspace, 'before agent create')
      fs.writeFileSync(path.join(workspace, 'created.txt'), 'new\nfile\n')

      const changes = git.getAgentFileChanges(workspace)

      expect(changes).toEqual([
        { path: 'created.txt', status: 'untracked', added: 2, deleted: 0 },
      ])
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not treat an empty shadow init commit as a real agent baseline', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-empty-shadow-'))
    try {
      const file = path.join(workspace, 'existing.txt')
      fs.writeFileSync(file, 'already here\n')
      checkpoints.ensureShadowRepo(workspace)

      const diff = git.getFileDiff(workspace, file)

      expect(diff.baseline).toBe('none')
      expect(diff.hasChanges).toBe(false)
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('accepts shadow diff by advancing the shadow baseline for the file', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-shadow-accept-'))
    try {
      const file = path.join(workspace, 'agent.txt')
      fs.writeFileSync(file, 'before\n')
      git.captureAgentFileBaseline(workspace, file)
      checkpoints.createCheckpoint(workspace, 'before agent edit')
      fs.writeFileSync(file, 'after\n')

      expect(git.getFileDiff(workspace, file).hasChanges).toBe(true)
      git.acceptFileChanges(workspace, file)

      const diff = git.getFileDiff(workspace, file)
      expect(diff.hasChanges).toBe(false)
      expect(diff.baseline).toBe('shadow')
      expect(git.getAgentFileChanges(workspace)).toEqual([])
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('accept hides agent diff in a user git repo instead of falling back to git HEAD', () => {
    const repo = makeRepo()
    try {
      const file = path.join(repo, 'tracked.txt')
      fs.writeFileSync(file, 'before\n')
      execSync('git add tracked.txt && git commit -m init', { cwd: repo, stdio: 'ignore' })

      git.captureAgentFileBaseline(repo, file)
      checkpoints.createCheckpoint(repo, 'before agent edit')
      fs.writeFileSync(file, 'after\n')
      expect(git.getFileDiff(repo, file).baseline).toBe('shadow')
      expect(git.getFileDiff(repo, file).hasChanges).toBe(true)

      git.acceptFileChanges(repo, file)

      const afterAccept = git.getFileDiff(repo, file)
      expect(afterAccept.baseline).toBe('shadow')
      expect(afterAccept.hasChanges).toBe(false)
      // The user's git still sees the worktree as modified, but the agent UI
      // should not re-surface the accepted agent diff.
      expect(git.getStatus(repo).files.some((f) => f.path === 'tracked.txt')).toBe(true)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reverts shadow diff back to the pre-agent checkpoint baseline', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-shadow-revert-'))
    try {
      const file = path.join(workspace, 'agent.txt')
      fs.writeFileSync(file, 'before\n')
      git.captureAgentFileBaseline(workspace, file)
      checkpoints.createCheckpoint(workspace, 'before agent edit')
      fs.writeFileSync(file, 'after\n')

      const result = git.discardFileChanges(workspace, file)

      expect(result.deleted).toBe(false)
      expect(fs.readFileSync(file, 'utf-8')).toBe('before\n')
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })
})
