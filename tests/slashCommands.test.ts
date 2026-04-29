import { describe, it, expect } from 'vitest'
import {
  SLASH_COMMANDS,
  findSlashCommand,
  parseSlashInput,
  filterSlashCommands,
  expandSlashTemplate,
} from '../src/slashCommands'

describe('slashCommands catalogue', () => {
  it('has unique names', () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every prompt command has templates for both languages', () => {
    for (const c of SLASH_COMMANDS) {
      if (c.kind === 'prompt') {
        expect(c.template?.ru).toBeTruthy()
        expect(c.template?.en).toBeTruthy()
      }
    }
  })

  it('every action command has an actionId', () => {
    for (const c of SLASH_COMMANDS) {
      if (c.kind === 'action') expect(c.actionId).toBeTruthy()
    }
  })
})

describe('findSlashCommand', () => {
  it('finds by primary name', () => {
    expect(findSlashCommand('fix')?.name).toBe('fix')
  })
  it('finds by alias', () => {
    expect(findSlashCommand('tests')?.name).toBe('test')
    expect(findSlashCommand('ctx')?.name).toBe('context')
    expect(findSlashCommand('reset')?.name).toBe('clear')
  })
  it('returns null for unknown commands', () => {
    expect(findSlashCommand('gibberish')).toBeNull()
  })
  it('is case-insensitive', () => {
    expect(findSlashCommand('FIX')?.name).toBe('fix')
  })
})

describe('parseSlashInput', () => {
  it('parses a bare command', () => {
    expect(parseSlashInput('/clear')).toEqual({ name: 'clear', arg: '' })
  })
  it('parses a command with an argument', () => {
    expect(parseSlashInput('/fix the off-by-one bug')).toEqual({ name: 'fix', arg: 'the off-by-one bug' })
  })
  it('tolerates leading whitespace', () => {
    expect(parseSlashInput('   /explain this')).toEqual({ name: 'explain', arg: 'this' })
  })
  it('returns null for non-slash input', () => {
    expect(parseSlashInput('hello')).toBeNull()
    expect(parseSlashInput('/')).toBeNull()
  })
  it('supports multi-line arguments', () => {
    const parsed = parseSlashInput('/explain foo\nbar\nbaz')
    expect(parsed?.name).toBe('explain')
    expect(parsed?.arg).toBe('foo\nbar\nbaz')
  })
})

describe('filterSlashCommands', () => {
  it('returns the full list for empty prefix', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_COMMANDS.length)
  })
  it('filters by prefix (incl. aliases)', () => {
    const r = filterSlashCommands('te')
    const names = r.map((c) => c.name)
    expect(names).toContain('test')
  })
  it('is case-insensitive', () => {
    const r = filterSlashCommands('EX')
    expect(r.some((c) => c.name === 'explain')).toBe(true)
  })
})

describe('mode slash commands', () => {
  it('defines /chat /plan /agent as actions with distinct actionIds', () => {
    const chat = findSlashCommand('chat')
    const plan = findSlashCommand('plan')
    const agent = findSlashCommand('agent')
    expect(chat?.kind).toBe('action')
    expect(chat?.actionId).toBe('mode-chat')
    expect(plan?.kind).toBe('action')
    expect(plan?.actionId).toBe('mode-plan')
    expect(agent?.kind).toBe('action')
    expect(agent?.actionId).toBe('mode-agent')
  })
  it('/plan no longer resolves to a prompt template', () => {
    // Regression: used to collide with the "draft a plan" prompt.
    const plan = findSlashCommand('plan')!
    expect(plan.template).toBeUndefined()
  })
})

describe('expandSlashTemplate', () => {
  it('substitutes ${arg}', () => {
    const cmd = findSlashCommand('fix')!
    const out = expandSlashTemplate(cmd, 'in handler.ts', 'en')
    expect(out).toMatch(/in handler\.ts/)
  })
  it('omits the arg section when empty', () => {
    const cmd = findSlashCommand('fix')!
    const outEmpty = expandSlashTemplate(cmd, '', 'en')
    expect(outEmpty).not.toMatch(/\$\{arg\}/)
  })
  it('falls back to en template if ru missing (defensive)', () => {
    const fake: any = { template: { en: 'hello ${arg}' } }
    expect(expandSlashTemplate(fake, 'x', 'ru')).toBe('hello \n\nx')
  })
})
