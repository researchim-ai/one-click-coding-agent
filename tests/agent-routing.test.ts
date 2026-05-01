import { describe, expect, it } from 'vitest'
import { routeModeForMessage } from '../src/hooks/useAgent'

describe('agent mode routing', () => {
  it('keeps plan requests in Plan even when the user mentions implementation', () => {
    expect(routeModeForMessage('Составь план и потом сделай это', 'agent')).toBe('plan')
    expect(routeModeForMessage('Нужен roadmap, потом реализуй', 'agent')).toBe('plan')
  })

  it('does not treat a casual ok in Plan as approval to execute', () => {
    expect(routeModeForMessage('ок', 'plan')).toBe('plan')
    expect(routeModeForMessage('давай', 'plan')).toBe('plan')
  })

  it('switches to Agent only for explicit plan execution requests', () => {
    expect(routeModeForMessage('Выполни этот план', 'plan')).toBe('agent')
    expect(routeModeForMessage('apply the plan', 'plan')).toBe('agent')
  })
})
