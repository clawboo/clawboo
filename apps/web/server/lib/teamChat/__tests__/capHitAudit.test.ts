// The docs promise that hitting an orchestrator cap leaves a `cap_hit` row in the
// governance audit feed (filterable as `eventType=cap_hit`). The engine fired
// `onCapHit` but nothing was wired to it, so that trail never existed. These tests
// pin the wiring, and that it can never break a cascade.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDb, listGovernanceAudit } from '@clawboo/db'
import { describe, expect, it } from 'vitest'

import { auditCapHit } from '../capHitAudit'

describe('cap-hit audit wiring', () => {
  it('writes a filterable cap_hit row carrying the team, source task, and ceiling', () => {
    const db = createDb(':memory:')
    auditCapHit(db, 'team-1', { kind: 'fanout', sourceTaskId: 'task-9' }, 8)

    const rows = listGovernanceAudit(db, { eventType: 'cap_hit' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.teamId).toBe('team-1')
    expect(rows[0]?.taskId).toBe('task-9')
    expect(JSON.parse(rows[0]!.summary) as unknown).toEqual({ kind: 'fanout', max: 8 })
  })

  it('records a leader-initiated cap hit, which has no source task', () => {
    const db = createDb(':memory:')
    auditCapHit(db, 'team-1', { kind: 'fanout', sourceTaskId: null }, 8)

    const rows = listGovernanceAudit(db, { eventType: 'cap_hit' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.taskId).toBeNull()
  })

  it('never throws — the engine calls this inside its spawn loop', () => {
    // A closed connection makes the insert fail; a cascade must survive it.
    const db = createDb(':memory:')
    ;(db as unknown as { $client: { close: () => void } }).$client.close()

    expect(() => auditCapHit(db, 'team-1', { kind: 'fanout', sourceTaskId: null }, 8)).not.toThrow()
  })

  // The helper working proves nothing if nobody calls it — and "declared but never
  // wired" is exactly how this trail went missing for the whole life of the caps.
  // A source-level guard is the only cheap way to catch a silent un-wiring (same
  // approach as the CI --frozen-lockfile and import-boundary guards).
  it('is actually wired into the team orchestrator, not just exported', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(path.join(here, '..', 'teamOrchestrator.ts'), 'utf8')
    expect(src).toMatch(/onCapHit:\s*\(info\)\s*=>\s*auditCapHit\(/)
  })
})
