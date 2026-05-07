/**
 * Persistent Task State.
 *
 * Agents wander. They re-ask "what was I doing?", re-derive the same plan,
 * and occasionally throw out the plan entirely mid-run. This module gives
 * them a small structured scratchpad — goal, plan, current step, notes —
 * that's kept in the session and re-injected as an ephemeral user message
 * near the latest user turn. Keeping it out of the system prompt preserves
 * prompt-cache/KV reuse while still reminding the agent what it is doing.
 *
 * The agent writes to it via an `update_plan` tool. We render it into the
 * per-turn request context. Updates are cheap — no LLM round trip.
 */

export interface PlanStep {
  id: number
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  note?: string
}

export interface PlanOption {
  id: string
  title: string
  summary: string
  tradeoffs?: string
  risk?: 'low' | 'medium' | 'high'
  effort?: 'small' | 'medium' | 'large'
  recommended?: boolean
  steps: PlanStep[]
  files?: string[]
  tests?: string[]
}

export interface TaskState {
  /** User's one-line objective, as understood by the agent. */
  goal: string
  /** Ordered list of concrete subtasks. Keep it small (< 12). */
  plan: PlanStep[]
  /** Alternative implementation strategies drafted in Plan mode. */
  planOptions?: PlanOption[]
  /** User-approved strategy to execute in Agent mode. */
  selectedPlanOptionId?: string
  /** Free-form scratch notes: decisions made, dead-ends, open questions. */
  notes: string
  /** Last time the agent updated this state. */
  updatedAt: number
}

export function emptyTaskState(): TaskState {
  return { goal: '', plan: [], notes: '', updatedAt: 0 }
}

export function isMeaningful(t: TaskState | undefined | null): boolean {
  if (!t) return false
  return !!(t.goal?.trim() || t.plan?.length || t.planOptions?.length || t.notes?.trim())
}

/** Apply a partial update — used by the `update_plan` tool. Returns the
 *  merged state and a short human-readable diff for logging. */
export function applyTaskStateUpdate(
  prev: TaskState,
  upd: Partial<TaskState> & { plan?: PlanStep[]; planOptions?: PlanOption[] },
): { next: TaskState; summary: string } {
  const rawPlan = Array.isArray(upd.plan) ? sanitizePlan(upd.plan) : prev.plan
  const rawOptions = Array.isArray(upd.planOptions) ? sanitizePlanOptions(upd.planOptions) : prev.planOptions
  const selectedPlanOptionId = typeof upd.selectedPlanOptionId === 'string'
    ? normalizeOptionId(upd.selectedPlanOptionId)
    : prev.selectedPlanOptionId
  const next: TaskState = {
    goal: typeof upd.goal === 'string' ? upd.goal.trim() : prev.goal,
    plan: Array.isArray(upd.plan) ? normalizeLinearProgress(rawPlan) : rawPlan,
    planOptions: rawOptions,
    selectedPlanOptionId: rawOptions?.some((opt) => opt.id === selectedPlanOptionId)
      ? selectedPlanOptionId
      : undefined,
    notes: typeof upd.notes === 'string' ? upd.notes.trim() : prev.notes,
    updatedAt: Date.now(),
  }
  const parts: string[] = []
  if (next.goal !== prev.goal) parts.push(`goal: "${short(next.goal, 60)}"`)
  if (Array.isArray(upd.plan)) parts.push(`plan: ${next.plan.length} step(s)`)
  if (Array.isArray(upd.planOptions)) parts.push(`options: ${next.planOptions?.length ?? 0}`)
  if (next.selectedPlanOptionId !== prev.selectedPlanOptionId) parts.push(`selected: ${next.selectedPlanOptionId ?? 'none'}`)
  if (next.notes !== prev.notes) parts.push(`notes: ${next.notes.length}b`)
  return { next, summary: parts.join(', ') || '(no-op)' }
}

function sanitizePlan(raw: any[]): PlanStep[] {
  const out: PlanStep[] = []
  for (let i = 0; i < raw.length && out.length < 24; i++) {
    const s = raw[i] ?? {}
    const title = typeof s.title === 'string' ? s.title.trim().slice(0, 200) : ''
    if (!title) continue
    let status: PlanStep['status'] = 'pending'
    if (s.status === 'in_progress' || s.status === 'completed' || s.status === 'blocked') status = s.status
    const note = typeof s.note === 'string' && s.note.trim() ? s.note.trim().slice(0, 500) : undefined
    out.push({ id: out.length + 1, title, status, note })
  }
  return out
}

function sanitizePlanOptions(raw: any[]): PlanOption[] {
  const out: PlanOption[] = []
  for (let i = 0; i < raw.length && out.length < 4; i++) {
    const opt = raw[i] ?? {}
    const title = typeof opt.title === 'string' ? opt.title.trim().slice(0, 120) : ''
    const summary = typeof opt.summary === 'string' ? opt.summary.trim().slice(0, 500) : ''
    const steps = Array.isArray(opt.steps) ? sanitizePlan(opt.steps).map((step) => ({ ...step, status: 'pending' as const })) : []
    if (!title || !summary || steps.length === 0) continue

    const id = normalizeOptionId(typeof opt.id === 'string' ? opt.id : '') || `option-${out.length + 1}`
    const risk: PlanOption['risk'] = opt.risk === 'low' || opt.risk === 'medium' || opt.risk === 'high' ? opt.risk : undefined
    const effort: PlanOption['effort'] = opt.effort === 'small' || opt.effort === 'medium' || opt.effort === 'large' ? opt.effort : undefined
    const files = sanitizeStringList(opt.files, 12, 160)
    const tests = sanitizeStringList(opt.tests, 12, 220)
    const tradeoffs = typeof opt.tradeoffs === 'string' && opt.tradeoffs.trim()
      ? opt.tradeoffs.trim().slice(0, 800)
      : undefined

    out.push({
      id,
      title,
      summary,
      tradeoffs,
      risk,
      effort,
      recommended: opt.recommended === true,
      steps,
      files: files.length ? files : undefined,
      tests: tests.length ? tests : undefined,
    })
  }
  return out
}

function sanitizeStringList(raw: any, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim().slice(0, maxLen) : ''
    if (s) out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

function normalizeOptionId(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

function normalizeLinearProgress(plan: PlanStep[]): PlanStep[] {
  const activeIndex = plan.map((s) => s.status).lastIndexOf('in_progress')
  if (activeIndex <= 0) return plan

  return plan.map((step, idx) => {
    if (idx >= activeIndex) return step
    if (step.status === 'blocked' || step.status === 'completed') return step
    return { ...step, status: 'completed' }
  })
}

export function normalizeTaskState(t: TaskState | undefined | null): TaskState | null {
  if (!t) return null
  const plan = Array.isArray(t.plan) ? normalizeLinearProgress(t.plan) : []
  const planOptions = Array.isArray(t.planOptions) ? sanitizePlanOptions(t.planOptions) : undefined
  const selectedPlanOptionId = planOptions?.some((opt) => opt.id === t.selectedPlanOptionId)
    ? t.selectedPlanOptionId
    : undefined
  return { ...t, plan, planOptions, selectedPlanOptionId }
}

function short(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

const STATUS_ICON: Record<PlanStep['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  blocked: '[!]',
}

/** Render the task state into a system-prompt block. Returns empty string
 *  if the state is not meaningful (so we don't clutter the prompt for
 *  throwaway queries like "what's 2+2?"). */
export function renderTaskStateForPrompt(t: TaskState | undefined | null, lang: 'ru' | 'en' = 'ru'): string {
  if (!isMeaningful(t)) return ''
  const s = normalizeTaskState(t)!
  const lines: string[] = []
  const title = lang === 'ru' ? '## Текущая задача' : '## Current task'
  lines.push(title)
  if (s.goal) {
    lines.push(lang === 'ru' ? `**Цель:** ${s.goal}` : `**Goal:** ${s.goal}`)
  }
  if (s.plan.length > 0) {
    lines.push('')
    lines.push(lang === 'ru' ? '**План:**' : '**Plan:**')
    for (const step of s.plan) {
      const note = step.note ? ` — ${step.note}` : ''
      lines.push(`- ${STATUS_ICON[step.status]} ${step.title}${note}`)
    }
  }
  if (s.planOptions?.length) {
    lines.push('')
    lines.push(lang === 'ru' ? '**Варианты исполнения:**' : '**Execution options:**')
    for (const opt of s.planOptions) {
      const selected = opt.id === s.selectedPlanOptionId
      const badges = [
        selected ? (lang === 'ru' ? 'выбран' : 'selected') : '',
        opt.recommended ? (lang === 'ru' ? 'рекомендован' : 'recommended') : '',
        opt.risk ? `risk: ${opt.risk}` : '',
        opt.effort ? `effort: ${opt.effort}` : '',
      ].filter(Boolean).join(', ')
      lines.push(`- ${opt.id}: ${opt.title}${badges ? ` (${badges})` : ''} — ${opt.summary}`)
      if (opt.steps.length) {
        for (const step of opt.steps) lines.push(`  - ${step.title}${step.note ? ` — ${step.note}` : ''}`)
      }
    }
  }
  if (s.notes) {
    lines.push('')
    lines.push(lang === 'ru' ? '**Заметки:**' : '**Notes:**')
    lines.push(s.notes)
  }
  lines.push('')
  lines.push(
    lang === 'ru'
      ? '> _Обновляй план инструментом `update_plan`, когда меняется цель, появляется новый шаг или ты завершил подзадачу._'
      : '> _Update this via the `update_plan` tool when the goal changes, you break work into steps, or you finish a subtask._',
  )
  return lines.join('\n')
}

/** The `update_plan` tool definition, in OpenAI-ish JSON schema. */
export const UPDATE_PLAN_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'update_plan',
    description:
      'Record the task state: the user goal, a short ordered plan, and free-form notes. Call this once you understand the task, whenever the plan changes, when you start a step, and after completing a step. When moving to step N, mark all earlier non-blocked steps as completed and mark exactly the current step as in_progress. The state is re-injected into every prompt so you always know where you are. Keep the plan small (<=10 steps). Avoid repeating information already in the messages; this is a scratchpad, not a log.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'One-line description of what the user asked for, in their own words.',
        },
        plan: {
          type: 'array',
          description: 'Ordered list of subtasks. Replace the whole plan, do not append.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short title of the step.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'blocked'],
                description: 'Status of the step.',
              },
              note: { type: 'string', description: 'Optional short note (decision, blocker, etc.).' },
            },
            required: ['title', 'status'],
          },
        },
        notes: {
          type: 'string',
          description: 'Freeform notes: key decisions, dead-ends, open questions. Replace wholesale.',
        },
        planOptions: {
          type: 'array',
          description: 'Alternative implementation strategies for Plan mode. Provide 2-3 options when there are meaningful trade-offs.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable short id like quick-fix, balanced, robust.' },
              title: { type: 'string', description: 'Human-readable strategy title.' },
              summary: { type: 'string', description: 'What this option does and when to choose it.' },
              tradeoffs: { type: 'string', description: 'Pros/cons and notable trade-offs.' },
              risk: { type: 'string', enum: ['low', 'medium', 'high'] },
              effort: { type: 'string', enum: ['small', 'medium', 'large'] },
              recommended: { type: 'boolean', description: 'True for the best default option.' },
              files: { type: 'array', items: { type: 'string' }, description: 'Likely files or areas affected.' },
              tests: { type: 'array', items: { type: 'string' }, description: 'Verification commands or test areas.' },
              steps: {
                type: 'array',
                description: 'Concrete execution steps for this option.',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'blocked'] },
                    note: { type: 'string' },
                  },
                  required: ['title', 'status'],
                },
              },
            },
            required: ['id', 'title', 'summary', 'steps'],
          },
        },
        selectedPlanOptionId: {
          type: 'string',
          description: 'The option id approved by the user. Leave unset while drafting options in Plan mode.',
        },
      },
    },
  },
} as const
