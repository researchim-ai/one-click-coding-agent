import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import * as git from '../electron/git'

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
})
