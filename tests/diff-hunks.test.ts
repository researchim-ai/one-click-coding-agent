import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  computeHunks,
  applySelectedHunks,
  previewWriteFile,
  previewEditFile,
} from '../electron/diff-hunks'

describe('computeHunks', () => {
  it('returns no hunks for identical inputs', () => {
    expect(computeHunks('a\nb\nc', 'a\nb\nc')).toEqual([])
  })

  it('captures a single-line substitution as one hunk', () => {
    const oldText = 'alpha\nbeta\ngamma\n'
    const newText = 'alpha\nBETA\ngamma\n'
    const hunks = computeHunks(oldText, newText)
    expect(hunks.length).toBe(1)
    const h = hunks[0]
    expect(h.additions).toBe(1)
    expect(h.removals).toBe(1)
    const removed = h.lines.find((l) => l.kind === 'remove')!
    const added = h.lines.find((l) => l.kind === 'add')!
    expect(removed.text).toBe('beta')
    expect(added.text).toBe('BETA')
  })

  it('merges two close change runs into one hunk when within 2 * context', () => {
    const oldText = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n')
    const newText = ['1', '2x', '3', '4', '5', '6x', '7', '8'].join('\n')
    const hunks = computeHunks(oldText, newText, 3)
    expect(hunks.length).toBe(1)
    expect(hunks[0].additions + hunks[0].removals).toBe(4)
  })

  it('splits far-apart changes into separate hunks', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n')
    const newLines = oldText.split('\n').slice()
    newLines[1] = 'xxx' // line 2
    newLines[18] = 'yyy' // line 19
    const hunks = computeHunks(oldText, newLines.join('\n'), 2)
    expect(hunks.length).toBe(2)
    expect(hunks[0].id).toBe(0)
    expect(hunks[1].id).toBe(1)
  })

  it('tracks pure additions (file grew)', () => {
    const oldText = 'a\nb\n'
    const newText = 'a\nb\nc\nd\n'
    const hunks = computeHunks(oldText, newText)
    expect(hunks.length).toBe(1)
    expect(hunks[0].removals).toBe(0)
    expect(hunks[0].additions).toBeGreaterThanOrEqual(2)
  })
})

describe('applySelectedHunks', () => {
  const oldText = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n')
  const modifiedLines = oldText.split('\n').slice()
  modifiedLines[1] = 'XXX'
  modifiedLines[18] = 'YYY'
  const newText = modifiedLines.join('\n')
  const hunks = computeHunks(oldText, newText, 2)

  it('empty selection returns the old text unchanged', () => {
    expect(applySelectedHunks(oldText, hunks, [])).toBe(oldText)
  })

  it('all hunks selected reproduces the new text', () => {
    const all = hunks.map((h) => h.id)
    expect(applySelectedHunks(oldText, hunks, all)).toBe(newText)
  })

  it('accepts only the first hunk, rejecting the second', () => {
    expect(hunks.length).toBe(2)
    const applied = applySelectedHunks(oldText, hunks, [hunks[0].id])
    expect(applied.split('\n')[1]).toBe('XXX')
    expect(applied.split('\n')[18]).toBe('line19')
  })

  it('handles a pure-addition hunk at the end', () => {
    const old = 'a\nb\n'
    const nw = 'a\nb\nc\n'
    const hs = computeHunks(old, nw)
    expect(hs.length).toBe(1)
    expect(applySelectedHunks(old, hs, [])).toBe(old)
    expect(applySelectedHunks(old, hs, [hs[0].id])).toBe(nw)
  })
})

describe('previewWriteFile', () => {
  it('returns a single synthetic hunk for a new file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-preview-'))
    try {
      const res = previewWriteFile({ path: 'brand-new.ts', content: 'export const x = 1\n' }, tmp)
      expect(res.oldContent).toBeNull()
      expect(res.identical).toBe(false)
      expect(res.hunks.length).toBe(1)
      expect(res.hunks[0].removals).toBe(0)
      expect(res.hunks[0].additions).toBeGreaterThan(0)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reports identical when content matches existing file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-preview-'))
    try {
      fs.writeFileSync(path.join(tmp, 'same.txt'), 'hello\n')
      const res = previewWriteFile({ path: 'same.txt', content: 'hello\n' }, tmp)
      expect(res.identical).toBe(true)
      expect(res.hunks).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('splits a partial rewrite into hunks against existing content', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-preview-'))
    try {
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'a\nb\nc\nd\ne\n')
      const res = previewWriteFile({ path: 'a.txt', content: 'a\nB\nc\nd\nE\n' }, tmp)
      expect(res.identical).toBe(false)
      expect(res.hunks.length).toBeGreaterThanOrEqual(1)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('previewEditFile', () => {
  it('returns an error when old_string is not found', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-preview-'))
    try {
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello world\n')
      const res = previewEditFile({ path: 'a.txt', old_string: 'foobar', new_string: 'x' }, tmp)
      expect('error' in res).toBe(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns a diff for a valid edit', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-preview-'))
    try {
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'let x = 1\nlet y = 2\n')
      const res = previewEditFile(
        { path: 'a.txt', old_string: 'let x = 1', new_string: 'const x = 1' },
        tmp,
      )
      expect('error' in res).toBe(false)
      if ('hunks' in res) {
        expect(res.hunks.length).toBe(1)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
