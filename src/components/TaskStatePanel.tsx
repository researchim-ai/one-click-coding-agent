import { useEffect, useState } from 'react'
import type { TaskState, PlanStep } from '../../electron/task-state'

interface Props {
  workspace: string
  /** Bump this value to trigger a refetch (e.g. pass messages.length). */
  refreshKey?: unknown
  appLanguage?: 'ru' | 'en'
  /** If provided, render this snapshot directly instead of fetching via
   *  IPC. The agent pushes a `task_state` event after every
   *  `update_plan` call, so this lets the panel update live in the
   *  middle of a long agent turn — before any new chat message lands. */
  liveState?: unknown
  /** Current session mode. When === 'plan' and a non-empty plan is
   *  present, we render an "Apply plan" button that switches the
   *  session to agent mode and kicks off execution. */
  mode?: 'chat' | 'plan' | 'agent'
  /** Called when the user presses "Apply plan". Parent switches the
   *  session into agent mode and sends a short "execute the plan"
   *  message — the agent picks it up with a non-empty `taskState`
   *  already in place, so it can start working immediately. */
  onApplyPlan?: () => void
  /** Disable the Apply-plan button while the agent is busy. */
  busy?: boolean
  /** Persist the current task state as PLAN.md in the workspace. */
  onSavePlan?: () => void
}

const STATUS_ICON: Record<PlanStep['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  blocked: '◆',
}

const STATUS_COLOR: Record<PlanStep['status'], string> = {
  pending: 'text-zinc-500',
  in_progress: 'text-amber-400',
  completed: 'text-emerald-400',
  blocked: 'text-red-400',
}

function isMeaningful(t: TaskState | null): boolean {
  if (!t) return false
  return !!(t.goal?.trim() || t.plan?.length || t.notes?.trim())
}

/** Sidebar-style card that surfaces the agent's persistent task state
 *  (goal, plan, notes). Mirrors what the agent sees injected into its
 *  system prompt on every turn — useful both as feedback ("is the agent
 *  on track?") and to catch plan drift. Hidden when empty. */
export function TaskStatePanel({ workspace, refreshKey, appLanguage = 'ru', liveState, mode, onApplyPlan, busy, onSavePlan }: Props) {
  const L = appLanguage
  const t = (ru: string, en: string) => (L === 'ru' ? ru : en)
  const [state, setState] = useState<TaskState | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  // Whenever the parent hands us a new live snapshot (pushed by the
  // agent on `update_plan`), show it immediately. This is what makes
  // the panel tick step-by-step during a single long agent turn.
  useEffect(() => {
    if (liveState === undefined || liveState === null) return
    setState(liveState as TaskState)
  }, [liveState])

  // Fallback path: fetch from the backend when the chat mounts or when
  // the message list grows (end of a turn, session switch, etc.). The
  // live-push path is primary — this just covers cold starts.
  useEffect(() => {
    if (!workspace || !window.api?.getTaskState) {
      setState(null)
      return
    }
    let cancelled = false
    window.api
      .getTaskState(workspace)
      .then((ts) => {
        if (!cancelled) setState(ts ?? null)
      })
      .catch(() => {
        if (!cancelled) setState(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspace, refreshKey])

  // If parent provides a snapshot (including explicit null), treat it as
  // authoritative for the active session. Falling back to local fetched
  // state after `null` caused stale plans to remain visible after restart
  // or session switches.
  const effective: TaskState | null = liveState !== undefined ? (liveState as TaskState | null) : state
  if (!isMeaningful(effective)) return null
  const s = effective!

  const done = s.plan.filter((p) => p.status === 'completed').length
  const total = s.plan.length
  const inProgress = s.plan.find((p) => p.status === 'in_progress')

  return (
    <div className="mx-3 mt-2 mb-1 rounded-md border border-zinc-800/80 bg-zinc-900/60 text-xs">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-zinc-800/60 transition-colors cursor-pointer rounded-t-md"
      >
        <span className="text-blue-400/80 text-[11px] font-medium">
          {mode === 'plan' ? t('План на согласовании', 'Plan for approval') : t('Текущая задача', 'Current task')}
        </span>
        {s.goal && (
          <span className="flex-1 truncate text-zinc-300" title={s.goal}>
            {s.goal}
          </span>
        )}
        {total > 0 && (
          <span className="text-zinc-500 font-mono text-[10.5px]">
            {done}/{total}
          </span>
        )}
        <span className="text-zinc-500 text-[10px]">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-2 pt-1 border-t border-zinc-800/60 space-y-2">
          {s.goal && !collapsed && (
            <div className="text-zinc-300 leading-snug">{s.goal}</div>
          )}

          {s.plan.length > 0 && (
            <ul className="space-y-0.5">
              {s.plan.map((step) => (
                <li
                  key={step.id}
                  className={`flex items-start gap-2 leading-snug ${
                    step.status === 'completed' ? 'text-zinc-500 line-through decoration-zinc-700' : 'text-zinc-300'
                  } ${step === inProgress ? 'font-medium' : ''}`}
                >
                  <span className={`${STATUS_COLOR[step.status]} mt-[1px] text-[10px] shrink-0`}>
                    {STATUS_ICON[step.status]}
                  </span>
                  <span className="flex-1 break-words">
                    {step.title}
                    {step.note && (
                      <span className="block text-[10.5px] text-zinc-500 mt-0.5">{step.note}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {s.notes && (
            <div className="pt-1 border-t border-zinc-800/60 text-zinc-400 leading-snug whitespace-pre-wrap">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">
                {t('Заметки:', 'Notes:')}
              </span>
              {s.notes}
            </div>
          )}

          {mode === 'plan' && s.plan.length > 0 && (onApplyPlan || onSavePlan) && (
            <div className="pt-1 border-t border-zinc-800/60 flex flex-wrap items-center gap-2">
              {onSavePlan && (
                <button
                  disabled={busy}
                  onClick={onSavePlan}
                  className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-200 text-[11px] font-medium hover:bg-zinc-700 ring-1 ring-zinc-700/60 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('Сохранить текущий план в PLAN.md', 'Save the current plan to PLAN.md')}
                >
                  {t('Сохранить PLAN.md', 'Save PLAN.md')}
                </button>
              )}
              {onApplyPlan && (
                <button
                  disabled={busy}
                  onClick={onApplyPlan}
                  className="px-2.5 py-1 rounded bg-blue-500/20 text-blue-200 text-[11px] font-medium hover:bg-blue-500/30 ring-1 ring-blue-500/30 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t(
                    'Явно подтвердить план, переключиться в Agent и начать выполнение',
                    'Explicitly approve the plan, switch to Agent, and start execution',
                  )}
                >
                  {t('▶ Выполнить утверждённый план', '▶ Apply approved plan')}
                </button>
              )}
              <span className="text-[10.5px] text-zinc-500">
                {t(
                  'Plan-режим только готовит и обсуждает план. Выполнение начнётся только после явного подтверждения.',
                  'Plan mode only drafts and discusses the plan. Execution starts only after explicit approval.',
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
