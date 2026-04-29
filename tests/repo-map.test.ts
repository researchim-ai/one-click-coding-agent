import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildRepoMap, renderRepoMap } from '../electron/repo-map'

let tmpWs: string

beforeEach(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-'))
})
afterEach(() => {
  try { fs.rmSync(tmpWs, { recursive: true, force: true }) } catch {}
})

function write(rel: string, content: string) {
  const abs = path.join(tmpWs, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

describe('repo-map', () => {
  it('extracts classes/functions/interfaces from TypeScript', () => {
    write('src/foo.ts', `
export class Foo {}
export interface Bar { x: number }
export type Baz = string
export function hello() {}
export const THE_ANSWER = 42
`)
    const map = buildRepoMap(tmpWs)
    expect(map.files).toHaveLength(1)
    const kinds = map.files[0].symbols.map((s) => `${s.kind}:${s.name}`)
    expect(kinds).toContain('class:Foo')
    expect(kinds).toContain('interface:Bar')
    expect(kinds).toContain('type:Baz')
    expect(kinds).toContain('function:hello')
    expect(kinds).toContain('const:THE_ANSWER')
  })

  it('extracts Python classes and functions', () => {
    write('lib/mod.py', `
class Service:
    pass

async def fetch():
    return 1

def helper():
    return 2
`)
    const map = buildRepoMap(tmpWs)
    const kinds = map.files[0].symbols.map((s) => `${s.kind}:${s.name}`)
    expect(kinds).toContain('class:Service')
    expect(kinds).toContain('function:fetch')
    expect(kinds).toContain('function:helper')
  })

  it('extracts Rust structs, enums, traits, functions', () => {
    write('src/main.rs', `
pub struct Point { x: i32 }
pub enum Color { Red, Green }
pub trait Draw {}
pub fn draw() {}
async fn fetch() {}
`)
    const map = buildRepoMap(tmpWs)
    const kinds = map.files[0].symbols.map((s) => `${s.kind}:${s.name}`)
    expect(kinds).toContain('struct:Point')
    expect(kinds).toContain('enum:Color')
    expect(kinds).toContain('trait:Draw')
    expect(kinds).toContain('function:draw')
    expect(kinds).toContain('function:fetch')
  })

  it('extracts Go structs, interfaces, functions', () => {
    write('go/server.go', `
package main

type User struct { Name string }
type Reader interface { Read() }
func Run() {}
func (s *Server) Handle() {}
`)
    const map = buildRepoMap(tmpWs)
    const kinds = map.files[0].symbols.map((s) => `${s.kind}:${s.name}`)
    expect(kinds).toContain('struct:User')
    expect(kinds).toContain('interface:Reader')
    expect(kinds).toContain('function:Run')
    expect(kinds).toContain('function:Handle')
  })

  it('skips ignored directories (node_modules, .git, dist…)', () => {
    write('node_modules/pkg/index.js', 'export class Skipped {}')
    write('.git/hooks/pre-commit', 'class Skipped {}')
    write('dist/bundle.js', 'export class Skipped {}')
    write('src/kept.ts', 'export class Kept {}')
    const map = buildRepoMap(tmpWs)
    const allSymbols = map.files.flatMap((f) => f.symbols.map((s) => s.name))
    expect(allSymbols).toContain('Kept')
    expect(allSymbols).not.toContain('Skipped')
  })

  it('ranks top-level src/ higher than deeply nested tests', () => {
    write('src/a.ts', 'export class A {}')
    write('src/tests/b.ts', 'export class B {}')
    const map = buildRepoMap(tmpWs)
    const aScore = map.files.find((f) => f.relativePath === 'src/a.ts')!.score
    const bScore = map.files.find((f) => f.relativePath === 'src/tests/b.ts')!.score
    expect(aScore).toBeGreaterThan(bScore)
  })

  it('respects the byte budget by truncating', () => {
    // Create 20 files; a tight budget should force truncation.
    for (let i = 0; i < 20; i++) {
      write(`src/m${i}.ts`, `export class Cls${i} {}\nexport function fn${i}() {}`)
    }
    const map = buildRepoMap(tmpWs, 200)
    expect(map.truncated).toBe(true)
    expect(map.files.length).toBeLessThan(20)
  })

  it('renderRepoMap produces the expected markdown shape', () => {
    write('src/a.ts', 'export class A {}')
    const map = buildRepoMap(tmpWs)
    const out = renderRepoMap(map)
    expect(out).toMatch(/## Repo map/)
    expect(out).toMatch(/src\/a\.ts/)
    expect(out).toMatch(/class A/)
  })

  it('returns empty output for a workspace with no source files', () => {
    write('README.md', '# just docs')
    const map = buildRepoMap(tmpWs)
    expect(map.files).toHaveLength(0)
    expect(renderRepoMap(map)).toBe('')
  })
})
