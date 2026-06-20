import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { getSessionBySourceId, getSessionLineage, recordRotation } from '../index'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

describe('recordRotation — session lineage', () => {
  it('links a successor to its predecessor via parentSessionId', () => {
    const { predecessor, successor } = recordRotation(db, {
      predecessorSessionKey: 'runtime:claude-code:task:t1',
      successorSessionKey: 'runtime:claude-code:task:t1:r1',
      agentId: 'claude-1',
      teamId: 'team-1',
      runtime: 'claude-code',
    })
    expect(predecessor.parentSessionId).toBeNull()
    expect(successor.parentSessionId).toBe(predecessor.id)
    expect(successor.sourceId).toBe('claude-code')
    expect(successor.status).toBe('active')
    expect(predecessor.status).toBe('closed')
  })

  it('builds a queryable rotation chain (newest-first)', () => {
    const r1 = recordRotation(db, {
      predecessorSessionKey: 'sk',
      successorSessionKey: 'sk:r1',
      runtime: 'claude-code',
    })
    const r2 = recordRotation(db, {
      predecessorSessionKey: 'sk:r1',
      successorSessionKey: 'sk:r2',
      runtime: 'claude-code',
    })
    const chain = getSessionLineage(db, r2.successor.id)
    // sk:r2 -> sk:r1 -> sk
    expect(chain.map((s) => s.sourceSessionId)).toEqual(['sk:r2', 'sk:r1', 'sk'])
    expect(r2.predecessor.id).toBe(r1.successor.id) // sk:r1 reused, not duplicated
  })

  it('is idempotent — re-recording the same rotation does not duplicate rows', () => {
    const a = recordRotation(db, {
      predecessorSessionKey: 'sk',
      successorSessionKey: 'sk:r1',
      runtime: 'claude-code',
    })
    const b = recordRotation(db, {
      predecessorSessionKey: 'sk',
      successorSessionKey: 'sk:r1',
      runtime: 'claude-code',
    })
    expect(b.predecessor.id).toBe(a.predecessor.id)
    expect(b.successor.id).toBe(a.successor.id)
    // Only the two rows exist (unique on source_id + source_session_id).
    expect(getSessionBySourceId(db, 'claude-code', 'sk')?.id).toBe(a.predecessor.id)
    expect(getSessionBySourceId(db, 'claude-code', 'sk:r1')?.id).toBe(a.successor.id)
  })

  it('scopes the lineage to the runtime origin (sourceId)', () => {
    recordRotation(db, {
      predecessorSessionKey: 'sk',
      successorSessionKey: 'sk:r1',
      runtime: 'hermes',
    })
    expect(getSessionBySourceId(db, 'hermes', 'sk')).toBeDefined()
    expect(getSessionBySourceId(db, 'claude-code', 'sk')).toBeUndefined()
  })
})
