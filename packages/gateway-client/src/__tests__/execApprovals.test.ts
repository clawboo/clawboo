// The fleet's permissions document, and the two ways writing it used to lose data.
//
// This file had no tests. Both defects it pins were shipped, both reported
// success, and neither left anything on screen to show what had happened.
//
//  1. "Run Freely" DELETED EVERY STANDING GRANT. Setting a Boo to execAsk 'off'
//     dropped its whole bucket so policy would fall back to the Gateway defaults.
//     The posture reasoning was right; the bucket is also where that Boo's
//     allowlist lives, so the least alarming option in the dropdown quietly threw
//     away every "Always" the operator had ever granted it.
//  2. THE COMPARE-AND-SWAP WAS DECORATIVE. On a base-hash conflict the writer
//     re-read the snapshot, took only its new hash, and re-sent the document it
//     had computed from the stale read. The other writer's committed change was
//     erased and the call returned normally. The other writer is the Gateway
//     itself, which mints allowlist entries when someone answers "Always".

import { describe, expect, it } from 'vitest'

import { mutateExecApprovalsDoc, upsertExecApprovalPolicy } from '../execApprovals'

type Doc = Record<string, unknown>

/** A Gateway that stores a document and enforces the base-hash CAS for real. */
function makeGateway(
  initial: Doc,
  opts: { conflictOnce?: string; onConflict?: (f: Doc) => void } = {},
) {
  let file: Doc = structuredClone(initial)
  let hash = 'h1'
  let pendingConflict = opts.conflictOnce ?? null
  const sets: Doc[] = []

  return {
    sets,
    current: () => file,
    /** Simulate another writer committing between this client's get and set. */
    commitElsewhere: (mutate: (f: Doc) => void) => {
      mutate(file)
      hash = `${hash}+`
    },
    client: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === 'exec.approvals.get') {
          return { path: 'x', exists: true, hash, file: structuredClone(file) } as T
        }
        if (method === 'exec.approvals.set') {
          const p = params as { file: Doc; baseHash?: string }
          if (pendingConflict) {
            const msg = pendingConflict
            pendingConflict = null
            // A real conflict happens BECAUSE someone else committed, so the
            // double commits their change at the moment it refuses this one.
            if (opts.onConflict) {
              opts.onConflict(file)
              hash = `${hash}+`
            }
            throw new Error(msg)
          }
          if (p.baseHash !== hash) {
            throw new Error(
              'exec approvals changed since last load; re-run exec.approvals.get and retry',
            )
          }
          sets.push(structuredClone(p.file))
          file = structuredClone(p.file)
          hash = `${hash}!`
          return undefined as T
        }
        throw new Error(`unexpected method ${method}`)
      },
    },
  }
}

const GRANT = {
  id: 'a2583e84',
  pattern: '/bin/echo',
  argPattern: 'sha256:cwd-argv:v1:f76b60c1',
  source: 'allow-always',
  lastUsedAt: 1789273436004,
}

const withGrants = (): Doc => ({
  version: 1,
  socket: { path: '/tmp/s.sock', token: 'secret' },
  defaults: { security: 'deny', ask: 'off' },
  agents: {
    'browser-test-boo': { security: 'allowlist', ask: 'on-miss', allowlist: [GRANT] },
    'other-boo': { security: 'allowlist', ask: 'always', allowlist: [{ pattern: '/bin/ls' }] },
  },
})

const agentsOf = (d: Doc) => d['agents'] as Record<string, Record<string, unknown>>

describe('upsertExecApprovalPolicy', () => {
  it('KEEPS the standing grants when a Boo is set to run freely', async () => {
    const gw = makeGateway(withGrants())
    await upsertExecApprovalPolicy(gw.client, 'browser-test-boo', 'off')

    const bucket = agentsOf(gw.current())['browser-test-boo']
    expect(bucket?.['allowlist']).toEqual([GRANT])
  })

  it('still falls back to the Gateway defaults, by dropping only the posture fields', async () => {
    // The absent-field fallback is what makes this safe: resolveAgentSecurityField
    // and resolveAgentAskField test `rawAgent[field] != null` and fall through to
    // the wildcard and defaults, so a bucket holding only an allowlist resolves
    // exactly as a missing bucket does.
    const gw = makeGateway(withGrants())
    await upsertExecApprovalPolicy(gw.client, 'browser-test-boo', 'off')

    const bucket = agentsOf(gw.current())['browser-test-boo']
    expect(bucket).not.toHaveProperty('security')
    expect(bucket).not.toHaveProperty('ask')
  })

  it('leaves no empty bucket when there was nothing else to keep', async () => {
    const gw = makeGateway({
      version: 1,
      agents: { boo: { security: 'allowlist', ask: 'always' } },
    })
    await upsertExecApprovalPolicy(gw.client, 'boo', 'off')
    expect(agentsOf(gw.current())).not.toHaveProperty('boo')
  })

  it('spends no write at all when the Boo has no policy to turn off', async () => {
    const gw = makeGateway({ version: 1, agents: {} })
    await upsertExecApprovalPolicy(gw.client, 'never-configured', 'off')
    expect(gw.sets).toHaveLength(0)
  })

  it('carries an allowlist entry across by reference, never rebuilt', async () => {
    // An entry that loses its argPattern matches nothing, so the grant is gone
    // while the row still looks present.
    const gw = makeGateway(withGrants())
    await upsertExecApprovalPolicy(gw.client, 'browser-test-boo', 'always')
    expect(agentsOf(gw.current())['browser-test-boo']?.['allowlist']).toEqual([GRANT])
  })

  it('does not erase a grant minted while this change was in flight', async () => {
    // THE LOST UPDATE, driven through the public function so it runs against the
    // shipped implementation too. The old writer answered a base-hash conflict by
    // re-reading only the HASH and re-sending the document computed from its
    // stale read, so the entry the Gateway had just minted for an operator's
    // "Always" was erased, and the posture change reported success.
    const gw = makeGateway(withGrants(), {
      conflictOnce: 'exec approvals changed since last load; re-run exec.approvals.get and retry',
      onConflict: (f) => {
        const boo = agentsOf(f)['browser-test-boo'] as Record<string, unknown>
        boo['allowlist'] = [GRANT, { pattern: '/usr/bin/git', source: 'allow-always' }]
      },
    })

    await upsertExecApprovalPolicy(gw.client, 'browser-test-boo', 'always')

    const list = agentsOf(gw.current())['browser-test-boo']?.['allowlist'] as unknown[]
    expect(list).toHaveLength(2)
    expect(agentsOf(gw.current())['browser-test-boo']?.['ask']).toBe('always')
  })

  it('preserves the socket section and every other agent', async () => {
    const gw = makeGateway(withGrants())
    await upsertExecApprovalPolicy(gw.client, 'browser-test-boo', 'on-miss')
    expect(gw.current()['socket']).toEqual({ path: '/tmp/s.sock', token: 'secret' })
    expect(gw.current()['defaults']).toEqual({ security: 'deny', ask: 'off' })
    expect(agentsOf(gw.current())['other-boo']?.['ask']).toBe('always')
  })
})

describe('mutateExecApprovalsDoc', () => {
  it('does NOT erase what another writer committed mid-flight', async () => {
    // The lost update. The old writer re-sent its stale document with a fresh
    // hash, so the grant minted between the get and the set vanished and the call
    // reported success.
    const gw = makeGateway(withGrants())
    let seen = 0
    await mutateExecApprovalsDoc(gw.client, (current) => {
      seen += 1
      if (seen === 1) {
        gw.commitElsewhere((f) => {
          agentsOf(f)['late-boo'] = { security: 'allowlist', ask: 'on-miss', allowlist: [GRANT] }
        })
      }
      const agents = { ...(current?.agents ?? {}) }
      agents['browser-test-boo'] = { ...agents['browser-test-boo'], ask: 'always' }
      return { version: 1, agents, socket: current?.socket, defaults: current?.defaults } as never
    })

    expect(seen).toBe(2) // re-ran the intent against the fresh read
    expect(agentsOf(gw.current())).toHaveProperty('late-boo')
    expect(agentsOf(gw.current())['browser-test-boo']?.['ask']).toBe('always')
  })

  it('retries a conflict the Gateway actually spells', async () => {
    const gw = makeGateway(withGrants(), {
      conflictOnce: 'exec approvals base hash required; re-run exec.approvals.get and retry',
    })
    const out = await mutateExecApprovalsDoc(gw.client, (c) => ({ ...c, version: 1 }) as never)
    expect(out).toEqual({ wrote: true, attempts: 2 })
  })

  it('does NOT retry an error that merely mentions a hash', async () => {
    // `/hash|changed|re-run/i` also matched "exec approvals changed after
    // migration loaded them". Retrying a write the Gateway refused for another
    // reason is how a permissions document gets overwritten by accident.
    const gw = makeGateway(withGrants(), {
      conflictOnce: 'exec approvals archive hash differs from the claimed source',
    })
    await expect(
      mutateExecApprovalsDoc(gw.client, (c) => ({ ...c, version: 1 }) as never),
    ).rejects.toThrow(/archive hash/)
    expect(gw.sets).toHaveLength(0)
  })

  it('gives up loudly rather than reporting a write it never landed', async () => {
    const gw = makeGateway(withGrants())
    await expect(
      mutateExecApprovalsDoc(
        gw.client,
        (current) => {
          // Always racing: something else commits before every attempt.
          gw.commitElsewhere(() => {})
          return { version: 1, agents: current?.agents ?? {} } as never
        },
        { attempts: 3 },
      ),
    ).rejects.toThrow(/changed since last load/)
  })

  it('writes nothing when the caller says there is nothing to change', async () => {
    const gw = makeGateway(withGrants())
    const out = await mutateExecApprovalsDoc(gw.client, () => null)
    expect(out).toEqual({ wrote: false, attempts: 1 })
    expect(gw.sets).toHaveLength(0)
  })
})

describe('a reply the writer does not understand', () => {
  it('refuses rather than treating it as an empty document', async () => {
    // The failure mode this forecloses: build a fresh document from `undefined`
    // and write it over the fleet's real policy, reporting success. Throwing lets
    // the caller say the gate was not applied, which is the truth.
    const client = { call: async <T>(): Promise<T> => undefined as T }
    await expect(
      mutateExecApprovalsDoc(client, (c) => ({ ...c, version: 1 }) as never),
    ).rejects.toThrow(/did not return a policy snapshot/)
  })
})
