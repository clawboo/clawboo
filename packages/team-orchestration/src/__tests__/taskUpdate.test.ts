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

describe('buildTaskUpdateMessage, a person deciding a task on the board', () => {
  it('a person marking it done reads as a finish, not a failure', () => {
    const msg = buildTaskUpdateMessage([
      { by: 'Design Boo', title: 'Draft the empty state', summary: 'x', outcome: 'person_done' },
    ])
    expect(msg).toContain("✓ Marked done by a person (it was Design Boo's)")
    expect(msg).toContain('"Draft the empty state"')
    expect(msg).not.toContain('DID NOT COMPLETE')
    expect(msg).not.toContain('did NOT complete')
    expect(msg).not.toContain('A person cancelled')
  })

  it('a cancel says so on its entry and tells the reader not to redo it', () => {
    const msg = buildTaskUpdateMessage([
      {
        by: 'Design Boo',
        title: 'Draft the empty state',
        summary: 'x',
        outcome: 'person_cancelled',
      },
    ])
    expect(msg).toContain("✕ Cancelled by a person (it was Design Boo's)")
    expect(msg).toContain(
      'A person cancelled it on the board. Do NOT redo cancelled work or hand it to anyone again.',
    )
    // A person's cancel is a decision, not a failure the reader must chase.
    expect(msg).not.toContain('did NOT complete')
    expect(msg).not.toContain('⚠')
  })

  it('counts the cancels when a batch mixes them with other results', () => {
    const items: TaskUpdateItem[] = [
      { by: 'Design Boo', title: 'a', summary: 'x', outcome: 'person_cancelled' },
      { by: 'Bug Boo', title: 'b', summary: 'y' },
      { by: 'Test Boo', title: 'c', summary: 'z', outcome: 'error' },
    ]
    const msg = buildTaskUpdateMessage(items)
    expect(msg).toContain('A person cancelled 1 of these on the board.')
    // The real failure is still the only one flagged as a failure.
    expect(msg).toContain('⚠ 1 of these did NOT complete')
    expect(msg).toContain('✓ Bug Boo')
  })

  it('a batch the person cancelled entirely says "all of them"', () => {
    const msg = buildTaskUpdateMessage([
      { by: 'Design Boo', title: 'a', summary: 'x', outcome: 'person_cancelled' },
      { by: 'Bug Boo', title: 'b', summary: 'y', outcome: 'person_cancelled' },
    ])
    expect(msg).toContain('A person cancelled all of them on the board.')
  })
})
