import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

export type ProjectMemoryCategory = 'decision' | 'preference' | 'known_issue' | 'note'

export interface ProjectMemoryEntry {
  category: ProjectMemoryCategory
  title: string
  content: string
}

const ROOT = path.join(os.homedir(), '.one-click-agent', 'project-memory')

function workspaceKey(workspace: string): string {
  const normalized = path.normalize(workspace || '').trim()
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function memoryPath(workspace: string): string {
  fs.mkdirSync(ROOT, { recursive: true })
  return path.join(ROOT, `${workspaceKey(workspace)}.md`)
}

function cleanLine(s: string): string {
  return String(s ?? '').replace(/\r/g, '').trim()
}

function categoryLabel(category: ProjectMemoryCategory): string {
  switch (category) {
    case 'decision': return 'Architecture decision'
    case 'preference': return 'Project preference'
    case 'known_issue': return 'Known issue'
    default: return 'Note'
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function readProjectMemory(workspace: string, maxChars = 6000): string {
  if (!workspace?.trim()) return ''
  try {
    const raw = fs.readFileSync(memoryPath(workspace), 'utf-8').trim()
    if (!raw) return ''
    if (raw.length <= maxChars) return raw
    return raw.slice(0, maxChars).trimEnd() + '\n\n<!-- project memory truncated -->'
  } catch {
    return ''
  }
}

export function appendProjectMemory(workspace: string, entry: ProjectMemoryEntry): string {
  if (!workspace?.trim()) throw new Error('Workspace is required')
  const title = cleanLine(entry.title)
  const content = cleanLine(entry.content)
  if (!title) throw new Error('Memory title is required')
  if (!content) throw new Error('Memory content is required')

  const file = memoryPath(workspace)
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trimEnd() : ''
  const stamp = new Date().toISOString().slice(0, 10)
  const block = [
    `### ${categoryLabel(entry.category)}: ${title}`,
    '',
    `- Date: ${stamp}`,
    `- Category: ${entry.category}`,
    `- Detail: ${content}`,
  ].join('\n')
  const heading = `### ${categoryLabel(entry.category)}: ${title}`
  let next: string
  if (existing.includes(heading)) {
    const re = new RegExp(`### ${escapeRegExp(categoryLabel(entry.category))}: ${escapeRegExp(title)}\\n[\\s\\S]*?(?=\\n### |$)`)
    next = existing.replace(re, block)
    if (next === existing) next = `${existing}\n\n${block}`
  } else {
    next = existing ? `${existing}\n\n${block}` : `# Project Memory\n\n${block}`
  }
  next = next.trimEnd() + '\n'
  fs.writeFileSync(file, next, 'utf-8')
  return file
}

