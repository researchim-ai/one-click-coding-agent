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

export interface TaskState {
  /** User's one-line objective, as understood by the agent. */
  goal: string
  /** Ordered list of concrete subtasks. Keep it small (< 12). */
  plan: PlanStep[]
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
  return !!(t.goal?.trim() || t.plan?.length || t.notes?.trim())
}

/** Apply a partial update — used by the `update_plan` tool. Returns the
 *  merged state and a short human-readable diff for logging. */
export function applyTaskStateUpdate(
  prev: TaskState,
  upd: Partial<TaskState> & { plan?: PlanStep[] },
): { next: TaskState; summary: string } {
  const rawPlan = Array.isArray(upd.plan) ? sanitizePlan(upd.plan) : prev.plan
  const next: TaskState = {
    goal: typeof upd.goal === 'string' ? upd.goal.trim() : prev.goal,
    plan: Array.isArray(upd.plan) ? normalizeLinearProgress(rawPlan) : rawPlan,
    notes: typeof upd.notes === 'string' ? upd.notes.trim() : prev.notes,
    updatedAt: Date.now(),
  }
  const parts: string[] = []
  if (next.goal !== prev.goal) parts.push(`goal: "${short(next.goal, 60)}"`)
  if (Array.isArray(upd.plan)) parts.push(`plan: ${next.plan.length} step(s)`)
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
  return { ...t, plan }
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
      },
    },
  },
} as const
