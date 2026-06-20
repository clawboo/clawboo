import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import type { DbCapabilityInsert } from '../../schema'
import { getCapability, listCapabilities, upsertCapabilities } from '../repository'

function row(
  over: Partial<DbCapabilityInsert> & { id: string; sourceId: string },
): DbCapabilityInsert {
  return {
    sourceKey: 'k',
    kind: 'tool',
    runtime: 'clawboo-native',
    scope: 'global',
    agentId: null,
    origin: 'brokered-mcp',
    manageability: 'managed',
    name: 'n',
    description: '',
    availability: null,
    available: 1,
    diagnostics: '[]',
    provenance: null,
    status: 'ready',
    tenantId: null,
    syncedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('capabilities repository', () => {
  let dir: string
  let db: ClawbooDb

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-cap-'))
    db = createDb(path.join(dir, 'test.db'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('upserts + lists by filter', () => {
    upsertCapabilities(db, 'native', [
      row({ id: 'native:a', sourceId: 'native', name: 'A', runtime: 'clawboo-native' }),
      row({ id: 'native:b', sourceId: 'native', name: 'B', runtime: 'openclaw', kind: 'skill' }),
    ])
    expect(
      listCapabilities(db)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['native:a', 'native:b'])
    expect(listCapabilities(db, { runtime: 'openclaw' }).map((r) => r.id)).toEqual(['native:b'])
    expect(listCapabilities(db, { kind: 'skill' }).map((r) => r.id)).toEqual(['native:b'])
    expect(getCapability(db, 'native:a')?.name).toBe('A')
    expect(getCapability(db, 'missing')).toBeNull()
  })

  it('reconcile is SOURCE-SCOPED: a re-read drops only that source rows, never another source', () => {
    upsertCapabilities(db, 'native', [row({ id: 'native:a', sourceId: 'native' })])
    upsertCapabilities(db, 'hermes', [
      row({ id: 'hermes:x', sourceId: 'hermes', runtime: 'hermes' }),
    ])

    // native re-reads with a DIFFERENT row → its old row is dropped, hermes untouched.
    upsertCapabilities(db, 'native', [row({ id: 'native:c', sourceId: 'native' })])

    const ids = listCapabilities(db)
      .map((r) => r.id)
      .sort()
    expect(ids).toEqual(['hermes:x', 'native:c'])
  })

  it('empty re-read clears that source rows only', () => {
    upsertCapabilities(db, 'native', [row({ id: 'native:a', sourceId: 'native' })])
    upsertCapabilities(db, 'hermes', [row({ id: 'hermes:x', sourceId: 'hermes' })])
    upsertCapabilities(db, 'native', [])
    expect(listCapabilities(db).map((r) => r.id)).toEqual(['hermes:x'])
  })

  it('is idempotent — re-upserting the same set updates in place (no duplicates)', () => {
    const r = row({ id: 'native:a', sourceId: 'native', name: 'A' })
    upsertCapabilities(db, 'native', [r])
    upsertCapabilities(db, 'native', [{ ...r, name: 'A2' }])
    const all = listCapabilities(db)
    expect(all).toHaveLength(1)
    expect(all[0]?.name).toBe('A2')
  })
})
