import { describe, expect, it } from 'vitest'

import { findHandOffCycle, type HandOffLink } from '../handOffCycle'

const link = (id: string, status: string, delegatedBy: string | null): HandOffLink => ({
  id,
  status,
  delegatedBy,
  title: id,
  identifier: null,
})

describe('findHandOffCycle', () => {
  it('finds the delegator of an open ancestor', () => {
    const chain = [link('t2', 'in_progress', 'b'), link('t1', 'in_progress', 'a')]
    expect(findHandOffCycle(chain, 'a')?.id).toBe('t1')
    expect(findHandOffCycle(chain, 'b')?.id).toBe('t2')
  })

  it('lets a hand-off to someone else through', () => {
    const chain = [link('t2', 'in_progress', 'b'), link('t1', 'in_progress', 'a')]
    expect(findHandOffCycle(chain, 'c')).toBeNull()
  })

  it('counts a blocked ancestor as open and a finished one as closed', () => {
    expect(findHandOffCycle([link('t1', 'blocked', 'a')], 'a')?.id).toBe('t1')
    expect(findHandOffCycle([link('t1', 'done', 'a')], 'a')).toBeNull()
    expect(findHandOffCycle([link('t1', 'cancelled', 'a')], 'a')).toBeNull()
  })

  it('counts the run its own task even when the run just finished it', () => {
    const chain = [link('t1', 'done', 'a')]
    expect(findHandOffCycle(chain, 'a', { ownTaskId: 't1' })?.id).toBe('t1')
  })

  it('ignores a link with no delegator', () => {
    expect(findHandOffCycle([link('t1', 'todo', null)], 'a')).toBeNull()
  })
})
