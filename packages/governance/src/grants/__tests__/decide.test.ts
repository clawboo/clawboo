import { describe, expect, it } from 'vitest'

import {
  decideGrant,
  isMutating,
  requiredMode,
  selectGrant,
  type Grant,
  type GrantApprovalReason,
  type GrantDecisionInput,
  type GrantDenyReason,
  type GrantToolFacts,
} from '../index'

const NOW = 1_700_000_000_000

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 'grant_1',
    subjectKind: 'agent',
    subjectId: 'agent_1',
    capabilityKind: 'tool',
    connectorId: 'conn_1',
    capabilityId: null,
    toolAllow: ['*'],
    toolDeny: [],
    mode: 'write',
    approvalPolicy: 'risk',
    state: 'active',
    expiresAt: null,
    specHashPin: null,
    toolsHashPin: null,
    callCeilingPerHour: null,
    ...overrides,
  }
}

function tool(overrides: Partial<GrantToolFacts> = {}): GrantToolFacts {
  return { name: 'read_file', readOnly: true, risk: 'safe', ...overrides }
}

function decide(input: Partial<GrantDecisionInput> = {}) {
  return decideGrant({ grants: [grant()], tool: tool(), now: NOW, ...input })
}

describe('requiredMode / isMutating', () => {
  it('maps annotations to a mode ceiling', () => {
    expect(requiredMode(tool({ readOnly: true }))).toBe('read')
    expect(requiredMode(tool({ readOnly: false }))).toBe('write')
    expect(requiredMode(tool({ readOnly: false, destructive: true }))).toBe('admin')
  })

  it('lets readOnly win over a contradictory destructive flag', () => {
    // Per the MCP spec, destructive is meaningful only when readOnly is false.
    expect(requiredMode(tool({ readOnly: true, destructive: true }))).toBe('read')
  })

  it('treats an unannotated tool as mutating', () => {
    expect(isMutating({ name: 'x' })).toBe(true)
    expect(isMutating(tool({ readOnly: true }))).toBe(false)
  })
})

describe('selectGrant', () => {
  it('returns null for no grants', () => {
    expect(selectGrant([])).toBeNull()
  })

  it('prefers the most specific subject', () => {
    const g = selectGrant([
      grant({ id: 'g_global', subjectKind: 'global', subjectId: null }),
      grant({ id: 'g_agent', subjectKind: 'agent' }),
      grant({ id: 'g_team', subjectKind: 'team', subjectId: 'team_1' }),
    ])
    expect(g?.id).toBe('g_agent')
  })

  it('prefers an active grant over an inactive one at the same specificity', () => {
    const g = selectGrant([
      grant({ id: 'g_stale', state: 'suspended' }),
      grant({ id: 'g_live', state: 'active' }),
    ])
    expect(g?.id).toBe('g_live')
  })
})

// ── every deny reason, one case each ───────────────────────────────────────
describe('deny reasons', () => {
  const cases: Array<[GrantDenyReason, Partial<GrantDecisionInput>]> = [
    ['no-grant', { grants: [] }],
    ['grant-revoked', { grants: [grant({ state: 'revoked' })] }],
    ['grant-suspended', { grants: [grant({ state: 'suspended' })] }],
    ['grant-proposed', { grants: [grant({ state: 'proposed' })] }],
    ['grant-expired', { grants: [grant({ state: 'expired' })] }],
    ['grant-expired', { grants: [grant({ expiresAt: NOW - 1 })] }],
    ['spec-drift', { grants: [grant({ specHashPin: 'aaa' })], currentSpecHash: 'bbb' }],
    ['spec-drift', { grants: [grant({ toolsHashPin: 'aaa' })], currentToolsHash: 'bbb' }],
    ['tool-not-in-scope', { grants: [grant({ toolAllow: ['write_*'] })] }],
    ['tool-not-in-scope', { grants: [grant({ toolDeny: ['read_*'] })] }],
    ['mode-insufficient', { grants: [grant({ mode: 'read' })], tool: tool({ readOnly: false }) }],
    ['rate-limited', { grants: [grant({ callCeilingPerHour: 10 })], callsInWindow: 10 }],
    [
      'standing-deny',
      {
        standingRules: [
          {
            id: 'rule_1',
            grantId: 'grant_1',
            toolName: 'read_file',
            argsShape: null,
            decision: 'deny' as const,
            expiresAt: null,
          },
        ],
      },
    ],
  ]

  it.each(cases)('denies with %s', (reason, input) => {
    const d = decide(input)
    expect(d.kind).toBe('deny')
    if (d.kind === 'deny') expect(d.reason).toBe(reason)
  })

  it('does not treat an unpinned grant as drifted', () => {
    expect(decide({ currentSpecHash: 'anything' }).kind).toBe('allow')
  })

  it('allows exactly below the rate ceiling', () => {
    expect(decide({ grants: [grant({ callCeilingPerHour: 10 })], callsInWindow: 9 }).kind).toBe(
      'allow',
    )
  })
})

// ── every approval reason, one case each ───────────────────────────────────
describe('approval reasons', () => {
  const LETHAL = {
    readsPrivateData: true,
    ingestsUntrustedContent: true,
    canEgress: true,
  }

  const cases: Array<[GrantApprovalReason, Partial<GrantDecisionInput>]> = [
    ['policy-always', { grants: [grant({ approvalPolicy: 'always' })] }],
    [
      'policy-writes',
      { grants: [grant({ approvalPolicy: 'writes' })], tool: tool({ readOnly: false }) },
    ],
    [
      'risk-destructive',
      { tool: tool({ readOnly: false, risk: 'destructive' }), grants: [grant({ mode: 'admin' })] },
    ],
    ['risk-external', { tool: tool({ readOnly: false, risk: 'external' }) }],
    ['lethal-trifecta', { runTrifecta: LETHAL }],
    [
      'tainted-run',
      { tainted: true, tool: tool({ trifecta: { ...LETHAL, readsPrivateData: false } }) },
    ],
    ['never-remembered', { tool: tool({ neverRemember: true }) }],
  ]

  it.each(cases)('requires approval with %s', (reason, input) => {
    const d = decide(input)
    expect(d.kind).toBe('require_approval')
    if (d.kind === 'require_approval') expect(d.reason).toBe(reason)
  })

  it('marks the trifecta and taint verdicts never-rememberable', () => {
    for (const input of [
      { runTrifecta: LETHAL },
      { tainted: true, tool: tool({ trifecta: LETHAL }) },
    ]) {
      const d = decide(input)
      expect(d.kind).toBe('require_approval')
      if (d.kind === 'require_approval') expect(d.neverRemember).toBe(true)
    }
  })
})

// ── the two orderings that carry weight ────────────────────────────────────
describe('evaluation order', () => {
  it('reports drift rather than scope when a renamed tool would satisfy the new scope', () => {
    // A rug-pulled server renames its tool AND the grant covers the new name.
    // Checking scope first would wave this through.
    const d = decide({
      grants: [grant({ specHashPin: 'approved', toolAllow: ['*'] })],
      currentSpecHash: 'rugpulled',
    })
    expect(d.kind).toBe('deny')
    if (d.kind === 'deny') expect(d.reason).toBe('spec-drift')
  })

  it('does not let approvalPolicy:never disarm the trifecta gate', () => {
    const d = decide({
      grants: [grant({ approvalPolicy: 'never' })],
      runTrifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    })
    expect(d.kind).toBe('require_approval')
    if (d.kind === 'require_approval') expect(d.reason).toBe('lethal-trifecta')
  })

  it('does not let a standing allow survive a tainted run', () => {
    const d = decide({
      tainted: true,
      tool: tool({
        trifecta: { readsPrivateData: false, ingestsUntrustedContent: false, canEgress: true },
      }),
      standingRules: [
        {
          id: 'rule_1',
          grantId: 'grant_1',
          toolName: 'read_file',
          argsShape: null,
          decision: 'allow',
          expiresAt: null,
        },
      ],
    })
    expect(d.kind).toBe('require_approval')
    if (d.kind === 'require_approval') expect(d.reason).toBe('tainted-run')
  })
})

describe('standing rules', () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'rule_1',
    grantId: 'grant_1',
    toolName: 'read_file',
    argsShape: null as string | null,
    decision: 'allow' as const,
    expiresAt: null as number | null,
    ...over,
  })

  it('allows and reports the rule id', () => {
    const d = decide({ standingRules: [rule()] })
    expect(d.kind).toBe('allow')
    if (d.kind === 'allow') expect(d.ruleId).toBe('rule_1')
  })

  it('ignores an expired rule', () => {
    const d = decide({
      grants: [grant({ approvalPolicy: 'always' })],
      standingRules: [rule({ expiresAt: NOW - 1 })],
    })
    expect(d.kind).toBe('require_approval')
  })

  it('ignores a rule for a different tool or grant', () => {
    const d = decide({
      grants: [grant({ approvalPolicy: 'always' })],
      standingRules: [rule({ toolName: 'other' }), rule({ id: 'r2', grantId: 'other' })],
    })
    expect(d.kind).toBe('require_approval')
  })

  it('prefers an exact args-shape rule over an any-args rule', () => {
    const d = decide({
      argsShape: 'shape_a',
      standingRules: [rule({ id: 'any' }), rule({ id: 'exact', argsShape: 'shape_a' })],
    })
    expect(d.kind).toBe('allow')
    if (d.kind === 'allow') expect(d.ruleId).toBe('exact')
  })

  // Deny must not depend on row order. A user can mint a deny while an older
  // allow for the same tool is still on file, and the array's order is an
  // insertion detail, not a policy.
  it('prefers a DENY over an allow at the same specificity, whatever the order', () => {
    const allowFirst = decide({
      standingRules: [rule({ id: 'allow' }), rule({ id: 'deny', decision: 'deny' })],
    })
    expect(allowFirst.kind).toBe('deny')

    const denyFirst = decide({
      standingRules: [rule({ id: 'deny', decision: 'deny' }), rule({ id: 'allow' })],
    })
    expect(denyFirst.kind).toBe('deny')
  })

  it('prefers a DENY over an allow for the same exact args shape', () => {
    const d = decide({
      argsShape: 'shape_a',
      standingRules: [
        rule({ id: 'allow', argsShape: 'shape_a' }),
        rule({ id: 'deny', argsShape: 'shape_a', decision: 'deny' }),
      ],
    })
    expect(d.kind).toBe('deny')
  })

  it('still lets an exact ALLOW beat an any-args deny (specificity outranks deny)', () => {
    // Deny wins WITHIN a level, not across them: a broad "deny everything" plus a
    // narrow "allow this one shape" is a user deliberately carving an exception.
    const d = decide({
      argsShape: 'shape_a',
      standingRules: [
        rule({ id: 'anyDeny', decision: 'deny' }),
        rule({ id: 'exactAllow', argsShape: 'shape_a' }),
      ],
    })
    expect(d.kind).toBe('allow')
    if (d.kind === 'allow') expect(d.ruleId).toBe('exactAllow')
  })

  it('never honours a rule for a never-remembered tool', () => {
    const d = decide({ tool: tool({ neverRemember: true }), standingRules: [rule()] })
    expect(d.kind).toBe('require_approval')
    if (d.kind === 'require_approval') expect(d.reason).toBe('never-remembered')
  })
})

describe('the approval-fatigue carve-out', () => {
  it('does not prompt for a READ-ONLY tool on an external-risk connector', () => {
    // Connectors carry an `external` risk floor. Without this carve-out every
    // list/read call on every connector would prompt.
    expect(decide({ tool: tool({ readOnly: true, risk: 'external' }) }).kind).toBe('allow')
  })

  it('still prompts for a MUTATING tool on the same connector', () => {
    const d = decide({ tool: tool({ readOnly: false, risk: 'external' }) })
    expect(d.kind).toBe('require_approval')
  })

  it('still catches read-only exfiltration through the trifecta gate', () => {
    const d = decide({
      tool: tool({ readOnly: true, risk: 'external' }),
      runTrifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    })
    expect(d.kind).toBe('require_approval')
    if (d.kind === 'require_approval') expect(d.reason).toBe('lethal-trifecta')
  })
})

describe('the happy path', () => {
  it('allows a safe read under a default grant', () => {
    expect(decide().kind).toBe('allow')
  })

  it('is total: never throws on a sparse input', () => {
    expect(() => decideGrant({ grants: [], tool: { name: 'x' }, now: NOW })).not.toThrow()
  })
})
