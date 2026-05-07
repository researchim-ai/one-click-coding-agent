import { describe, it, expect } from 'vitest'
import {
  emptyTaskState,
  applyTaskStateUpdate,
  renderTaskStateForPrompt,
  isMeaningful,
  UPDATE_PLAN_TOOL_DEF,
} from '../electron/task-state'

describe('task-state', () => {
  describe('applyTaskStateUpdate', () => {
    it('applies goal and plan to an empty state', () => {
      const { next, summary } = applyTaskStateUpdate(emptyTaskState(), {
        goal: 'Ship feature X',
        plan: [
          { title: 'Design', status: 'completed' },
          { title: 'Code', status: 'in_progress' },
        ] as any,
      })
      expect(next.goal).toBe('Ship feature X')
      expect(next.plan).toHaveLength(2)
      expect(next.plan[0].id).toBe(1)
      expect(next.plan[0].status).toBe('completed')
      expect(summary).toMatch(/goal:/)
      expect(summary).toMatch(/2 step/)
    })

    it('preserves fields that are not supplied', () => {
      const prev = applyTaskStateUpdate(emptyTaskState(), {
        goal: 'original goal',
        notes: 'original notes',
      }).next
      const { next } = applyTaskStateUpdate(prev, { plan: [{ title: 'new', status: 'pending' }] as any })
      expect(next.goal).toBe('original goal')
      expect(next.notes).toBe('original notes')
      expect(next.plan).toHaveLength(1)
    })

    it('drops plan items with empty titles', () => {
      const { next } = applyTaskStateUpdate(emptyTaskState(), {
        plan: [
          { title: '   ', status: 'pending' },
          { title: 'real', status: 'pending' },
          { title: '', status: 'pending' },
        ] as any,
      })
      expect(next.plan).toHaveLength(1)
      expect(next.plan[0].title).toBe('real')
    })

    it('normalizes unknown statuses to pending', () => {
      const { next } = applyTaskStateUpdate(emptyTaskState(), {
        plan: [{ title: 'x', status: 'nonsense' as any }] as any,
      })
      expect(next.plan[0].status).toBe('pending')
    })

    it('marks previous pending steps completed when a later step is in progress', () => {
      const { next } = applyTaskStateUpdate(emptyTaskState(), {
        plan: [
          { title: 'Analyze existing code', status: 'pending' },
          { title: 'Create network.py', status: 'pending' },
          { title: 'Create policy.py', status: 'pending' },
          { title: 'Rewrite mcts.py', status: 'pending' },
          { title: 'Create trainer.py', status: 'in_progress' },
          { title: 'Write README.md', status: 'pending' },
        ] as any,
      })

      expect(next.plan.map((s) => s.status)).toEqual([
        'completed',
        'completed',
        'completed',
        'completed',
        'in_progress',
        'pending',
      ])
    })

    it('does not overwrite blocked previous steps during progress normalization', () => {
      const { next } = applyTaskStateUpdate(emptyTaskState(), {
        plan: [
          { title: 'Investigate flaky check', status: 'blocked' },
          { title: 'Implement fallback', status: 'pending' },
          { title: 'Run tests', status: 'in_progress' },
        ] as any,
      })

      expect(next.plan.map((s) => s.status)).toEqual(['blocked', 'completed', 'in_progress'])
    })

    it('caps the plan at 24 items so giant states do not wreck the prompt', () => {
      const huge = Array.from({ length: 100 }, (_, i) => ({ title: `step ${i}`, status: 'pending' }))
      const { next } = applyTaskStateUpdate(emptyTaskState(), { plan: huge as any })
      expect(next.plan.length).toBeLessThanOrEqual(24)
    })

    it('stores sanitized plan options and validates the selected option', () => {
      const { next, summary } = applyTaskStateUpdate(emptyTaskState(), {
        planOptions: [
          {
            id: 'Balanced Option!',
            title: 'Balanced',
            summary: 'Good default',
            risk: 'medium',
            effort: 'medium',
            recommended: true,
            files: ['src/App.tsx'],
            tests: ['npm test'],
            steps: [
              { title: 'Inspect flow', status: 'completed' },
              { title: 'Implement UI', status: 'in_progress' },
            ],
          },
          { id: 'bad', title: '', summary: 'no title', steps: [] },
        ] as any,
        selectedPlanOptionId: 'Balanced Option!',
      })

      expect(next.planOptions).toHaveLength(1)
      expect(next.planOptions?.[0].id).toBe('balanced-option')
      expect(next.planOptions?.[0].steps.map((s) => s.status)).toEqual(['pending', 'pending'])
      expect(next.selectedPlanOptionId).toBe('balanced-option')
      expect(summary).toMatch(/options: 1/)
      expect(summary).toMatch(/selected: balanced-option/)
    })

    it('updates updatedAt on every apply', () => {
      const a = applyTaskStateUpdate(emptyTaskState(), { goal: 'x' }).next
      const b = applyTaskStateUpdate(a, { goal: 'y' }).next
      expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt)
    })
  })

  describe('isMeaningful', () => {
    it('is false for an empty state', () => {
      expect(isMeaningful(emptyTaskState())).toBe(false)
      expect(isMeaningful(null)).toBe(false)
      expect(isMeaningful(undefined)).toBe(false)
    })

    it('is true if ANY field is populated', () => {
      expect(isMeaningful({ ...emptyTaskState(), goal: 'x' })).toBe(true)
      expect(isMeaningful({ ...emptyTaskState(), plan: [{ id: 1, title: 'x', status: 'pending' }] })).toBe(true)
      expect(isMeaningful({ ...emptyTaskState(), planOptions: [{
        id: 'a',
        title: 'A',
        summary: 'S',
        steps: [{ id: 1, title: 'x', status: 'pending' }],
      }] })).toBe(true)
      expect(isMeaningful({ ...emptyTaskState(), notes: 'x' })).toBe(true)
    })
  })

  describe('renderTaskStateForPrompt', () => {
    it('returns empty string for an empty state', () => {
      expect(renderTaskStateForPrompt(emptyTaskState(), 'ru')).toBe('')
    })

    it('renders goal + plan + notes with status icons', () => {
      const state = applyTaskStateUpdate(emptyTaskState(), {
        goal: 'G',
        plan: [
          { title: 'a', status: 'completed' },
          { title: 'b', status: 'in_progress' },
          { title: 'c', status: 'blocked' },
          { title: 'd', status: 'pending', note: 'wait' },
        ] as any,
        notes: 'N',
      }).next
      const out = renderTaskStateForPrompt(state, 'en')
      expect(out).toMatch(/Goal:.*G/)
      expect(out).toMatch(/\[x\] a/)
      expect(out).toMatch(/\[~\] b/)
      expect(out).toMatch(/\[!\] c/)
      expect(out).toMatch(/\[ \] d — wait/)
      expect(out).toMatch(/Notes:/)
    })

    it('switches between ru and en labels', () => {
      const state = applyTaskStateUpdate(emptyTaskState(), { goal: 'X' }).next
      expect(renderTaskStateForPrompt(state, 'ru')).toMatch(/Цель:/)
      expect(renderTaskStateForPrompt(state, 'en')).toMatch(/Goal:/)
    })

    it('renders execution options and selected option into the prompt', () => {
      const state = applyTaskStateUpdate(emptyTaskState(), {
        goal: 'G',
        planOptions: [{
          id: 'robust',
          title: 'Robust',
          summary: 'Safer architecture',
          risk: 'low',
          effort: 'large',
          steps: [{ title: 'Refactor boundary', status: 'pending' }],
        }] as any,
        selectedPlanOptionId: 'robust',
      }).next
      const out = renderTaskStateForPrompt(state, 'en')
      expect(out).toMatch(/Execution options/)
      expect(out).toMatch(/robust: Robust/)
      expect(out).toMatch(/selected/)
      expect(out).toMatch(/Refactor boundary/)
    })
  })

  describe('tool definition', () => {
    it('is a valid OpenAI-style function def', () => {
      expect(UPDATE_PLAN_TOOL_DEF.type).toBe('function')
      expect(UPDATE_PLAN_TOOL_DEF.function.name).toBe('update_plan')
      expect(UPDATE_PLAN_TOOL_DEF.function.parameters.type).toBe('object')
      expect(UPDATE_PLAN_TOOL_DEF.function.parameters.properties.planOptions).toBeTruthy()
    })
  })
})
