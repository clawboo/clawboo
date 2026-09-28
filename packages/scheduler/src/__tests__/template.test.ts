import { describe, expect, it } from 'vitest'

import { parseTaskTemplate, routineTargetOf, taskTemplateSchema } from '../template'

describe('taskTemplateSchema target', () => {
  it('accepts both routine targets', () => {
    expect(taskTemplateSchema.parse({ title: 'Standup', target: 'team' }).target).toBe('team')
    expect(taskTemplateSchema.parse({ title: 'Inbox', target: 'agent' }).target).toBe('agent')
  })

  it('rejects an unknown target', () => {
    expect(() => taskTemplateSchema.parse({ title: 'x', target: 'everyone' })).toThrow()
  })

  it('leaves a template written before targets existed without one', () => {
    const legacy = parseTaskTemplate(JSON.stringify({ title: 'Old routine', kind: 'code' }))
    expect(legacy).not.toBeNull()
    expect(legacy!.target).toBeUndefined()
  })
})

describe('routineTargetOf', () => {
  it('reads the stored target', () => {
    expect(routineTargetOf({ target: 'team' })).toBe('team')
    expect(routineTargetOf({ target: 'agent' })).toBe('agent')
  })

  it('treats a template with no target as an agent routine', () => {
    expect(routineTargetOf({})).toBe('agent')
    expect(routineTargetOf({ target: null })).toBe('agent')
  })
})
