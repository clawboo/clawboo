import { describe, expect, it } from 'vitest'

import { buildTaskUpdateMessage, type TaskUpdateItem } from '../taskUpdate'

const ITEMS: TaskUpdateItem[] = [
  { by: 'Design Boo', title: 'Draft the empty state', summary: 'ok' },
]

describe('buildTaskUpdateMessage, framing options', () => {
  it('without options it is the plain board update the lead synthesizes for the user', () => {
    const plain = buildTaskUpdateMessage(ITEMS)
    expect(plain).toBe(buildTaskUpdateMessage(ITEMS, [], {}))
    expect(plain.startsWith('[Task Update]')).toBe(true)
    expect(plain).toContain('ONLY when the user is waiting')
  })

  it('a follow-up names the closed task and says the reply is not shown to the user', () => {
    const msg = buildTaskUpdateMessage(ITEMS, [], { followUp: { title: 'Fix parser' } })
    expect(msg.startsWith('[Task Update]')).toBe(true)
    expect(msg).toContain('"Fix parser"')
    expect(msg).toContain('not shown to the user')
    expect(msg).not.toContain('ONLY when the user is waiting')
  })

  it('a follow-up without a known title still says it came from a task', () => {
    expect(buildTaskUpdateMessage(ITEMS, [], { followUp: {} })).toContain('while on a task')
  })
})
