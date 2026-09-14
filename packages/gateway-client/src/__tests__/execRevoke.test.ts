// Revoking a standing grant, and the four ways that can quietly not happen.
//
// There is no revoke RPC, so this rewrites the fleet's entire permissions
// document to remove one row. Every test here is a way the operation could
// report success while the command it was meant to stop still runs, or could
// take away more than the operator asked for.

import { describe, expect, it } from 'vitest'

import { execAllowlistEntryKey } from '../execAllowlist'
import { removeExecAllowlistEntries, revokeExecAllowlistEntries } from '../execRevoke'

const GRANT = {
  id: 'a2583e84',
  pattern: '/bin/echo',
  argPattern: 'sha256:cwd-argv:v1:f76b60c1',
  source: 'allow-always',
  lastUsedAt: 1789273436004,
}
const MARKER = { id: 'cd9cc459', pattern: '=node-command:769c1dbc', source: 'allow-always' }
const OTHER = {
  id: 'zz',
  pattern: '/usr/bin/git',
  source: 'allow-always',
  argPattern: 'sha256:cwd-argv:v1:beef',
}

const K = {
  grant: execAllowlistEntryKey(GRANT),
  marker: execAllowlistEntryKey(MARKER),
  other: execAllowlistEntryKey(OTHER),
}

type Doc = Record<string, unknown>

const doc = (over: Partial<Doc> = {}): Doc => ({
  version: 1,
  socket: { path: '/tmp/s.sock', token: 'secret' },
  defaults: { security: 'deny' },
  agents: {
    boo: {
      security: 'allowlist',
      ask: 'on-miss',
      autoAllowSkills: true,
      mcpTools: [{ name: 'thing' }],
      allowlist: [GRANT, MARKER, OTHER],
    },
    'other-boo': { security: 'allowlist', ask: 'always', allowlist: [GRANT] },
  },
  ...over,
})

/** A Gateway that enforces the CAS and answers a set with the post-write state. */
function makeGateway(initial: Doc) {
  let file: Doc = structuredClone(initial)
  let hash = 'h1'
  return {
    current: () => file,
    client: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === 'exec.approvals.get') {
          return { path: 'x', exists: true, hash, file: structuredClone(file) } as T
        }
        const p = params as { file: Doc; baseHash?: string }
        if (p.baseHash !== hash) throw new Error('exec approvals changed since last load')
        file = structuredClone(p.file)
        hash = `${hash}!`
        return { path: 'x', exists: true, hash, file: structuredClone(file) } as T
      },
    },
  }
}

const listOf = (d: Doc, id: string) =>
  ((d['agents'] as Record<string, Record<string, unknown>>)[id]?.['allowlist'] ?? []) as {
    pattern: string
  }[]

describe('removeExecAllowlistEntries', () => {
  it('keeps the rest of the Boo intact, not just the other rows', () => {
    // The posture lives in the same record as the list. A revoke that dropped the
    // bucket would take the gate down at the moment it took the grants away.
    const { next } = removeExecAllowlistEntries(doc() as never, 'boo', [K.grant, K.marker])
    const boo = (next.agents as Record<string, Record<string, unknown>>)['boo']
    expect(boo?.['ask']).toBe('on-miss')
    expect(boo?.['security']).toBe('allowlist')
    expect(boo?.['autoAllowSkills']).toBe(true)
    expect(boo?.['mcpTools']).toEqual([{ name: 'thing' }])
  })

  it('carries surviving rows across by reference, never rebuilt', () => {
    // An entry that lost its argPattern would match nothing, so the grant would be
    // gone while the row still looked present.
    const input = doc()
    const { next } = removeExecAllowlistEntries(input as never, 'boo', [K.grant])
    const survivors = listOf(next as never, 'boo')
    expect(survivors).toContain(MARKER)
    expect(survivors).toContain(OTHER)
  })

  it('touches no other agent', () => {
    const { next } = removeExecAllowlistEntries(doc() as never, 'boo', [K.grant])
    expect(listOf(next as never, 'other-boo')).toEqual([GRANT])
  })

  it('preserves the socket section, which routes approval replies', () => {
    const { next } = removeExecAllowlistEntries(doc() as never, 'boo', [K.grant])
    expect(next.socket).toEqual({ path: '/tmp/s.sock', token: 'secret' })
    expect(next.defaults).toEqual({ security: 'deny' })
  })

  it('leaves an empty allowlist rather than deleting the bucket', () => {
    const { next } = removeExecAllowlistEntries(doc() as never, 'boo', [K.grant, K.marker, K.other])
    const boo = (next.agents as Record<string, Record<string, unknown>>)['boo']
    expect(boo?.['allowlist']).toEqual([])
    expect(boo?.['ask']).toBe('on-miss')
  })

  it('reports removing nothing rather than writing an identical document', () => {
    const { removed } = removeExecAllowlistEntries(doc() as never, 'boo', ['not-a-key'])
    expect(removed).toBe(0)
  })
})

describe('revokeExecAllowlistEntries', () => {
  it('removes both rows of a mint and proves it from the Gateway reply', async () => {
    const gw = makeGateway(doc())
    const res = await revokeExecAllowlistEntries(gw.client, {
      agentId: 'boo',
      keys: [K.grant, K.marker],
    })
    expect(res).toEqual({ outcome: 'revoked', removed: 2, remaining: 1 })
    expect(listOf(gw.current(), 'boo')).toEqual([OTHER])
  })

  it('REFUSES when the grant also lives in the wildcard bucket', async () => {
    // The union is wildcard ++ agent. Removing only the agent copy would leave the
    // command running while the post-write check of the agent bucket came back
    // clean, which is a revoke button that reports success and changes nothing.
    const gw = makeGateway(
      doc({
        agents: {
          boo: { ask: 'on-miss', allowlist: [GRANT, MARKER] },
          '*': { allowlist: [GRANT] },
        },
      }),
    )
    const res = await revokeExecAllowlistEntries(gw.client, { agentId: 'boo', keys: [K.grant] })
    expect(res).toEqual({ outcome: 'blocked-wildcard', keys: [K.grant] })
    // And nothing was written.
    expect(listOf(gw.current(), 'boo')).toHaveLength(2)
  })

  it('re-checks the wildcard bucket on a retry, not just on the first read', async () => {
    // The document is re-read on a conflict, so a wildcard copy that appeared in
    // between must still block. Checking once up front would miss it.
    let gets = 0
    const file: Doc = doc({ agents: { boo: { ask: 'on-miss', allowlist: [GRANT] } } })
    let hash = 'h1'
    const client = {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === 'exec.approvals.get') {
          gets += 1
          if (gets === 2) {
            ;(file['agents'] as Record<string, unknown>)['*'] = { allowlist: [GRANT] }
          }
          return { path: 'x', exists: true, hash, file: structuredClone(file) } as T
        }
        const p = params as { baseHash?: string }
        if (p.baseHash !== hash) throw new Error('exec approvals changed since last load')
        hash = 'h2'
        throw new Error('exec approvals changed since last load')
      },
    }
    const res = await revokeExecAllowlistEntries(client, { agentId: 'boo', keys: [K.grant] })
    expect(res).toEqual({ outcome: 'blocked-wildcard', keys: [K.grant] })
  })

  it('says already-absent rather than success when nothing matched', async () => {
    // Distinct from success on purpose: "it is gone" and "it was never here" lead
    // an operator to different conclusions about what their Boo can do.
    const gw = makeGateway(doc())
    const res = await revokeExecAllowlistEntries(gw.client, { agentId: 'boo', keys: ['nope'] })
    expect(res).toEqual({ outcome: 'already-absent' })
    expect(listOf(gw.current(), 'boo')).toHaveLength(3)
  })

  it('says no-such-agent when the Boo has no bucket', async () => {
    const gw = makeGateway(doc())
    const res = await revokeExecAllowlistEntries(gw.client, {
      agentId: 'never-configured',
      keys: [K.grant],
    })
    expect(res).toEqual({ outcome: 'no-such-agent' })
  })

  it('refuses to call it revoked when the Gateway still lists the row', async () => {
    // A Gateway that accepts the write and returns a document still containing the
    // entry. Reporting success from the payload we SENT rather than the state it
    // reports is the whole failure this guard exists for.
    const client = {
      call: async <T>(method: string): Promise<T> => {
        const f = doc()
        if (method === 'exec.approvals.get') {
          return { path: 'x', exists: true, hash: 'h1', file: f } as T
        }
        return { path: 'x', exists: true, hash: 'h2', file: f } as T
      },
    }
    const res = await revokeExecAllowlistEntries(client, { agentId: 'boo', keys: [K.grant] })
    expect(res).toEqual({ outcome: 'not-verified', keys: [K.grant] })
  })

  it('refuses to call it revoked when the Gateway returns no post-state', async () => {
    const client = {
      call: async <T>(method: string): Promise<T> => {
        if (method === 'exec.approvals.get') {
          return { path: 'x', exists: true, hash: 'h1', file: doc() } as T
        }
        return undefined as T
      },
    }
    const res = await revokeExecAllowlistEntries(client, { agentId: 'boo', keys: [K.grant] })
    expect(res).toEqual({ outcome: 'not-verified', keys: [K.grant] })
  })

  it('writes nothing at all for an empty request', async () => {
    const gw = makeGateway(doc())
    expect(await revokeExecAllowlistEntries(gw.client, { agentId: 'boo', keys: [] })).toEqual({
      outcome: 'already-absent',
    })
    expect(listOf(gw.current(), 'boo')).toHaveLength(3)
  })
})
