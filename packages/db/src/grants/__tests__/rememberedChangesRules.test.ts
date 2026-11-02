// Remembered approvals saved before an Always could cover an external change.
//
// Those rules were minted when the broker asked again on every external change
// regardless, so they changed nothing. Once Always could stop that prompt they
// would have started approving changes nobody agreed to remember, including on
// Playwright tools that were destructive when the rule was saved.

import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, getSetting, type ClawbooDb } from '../../db'
import {
  REMEMBERED_CHANGES_RULES_FLAG,
  listStandingRules,
  mintStandingRule,
  retireRulesFromBeforeRememberedChanges,
  upsertGrant,
} from '../repository'

let db: ClawbooDb
let grantId: string

beforeEach(() => {
  db = createDb(':memory:')
  grantId = upsertGrant(db, {
    subjectKind: 'agent',
    subjectId: 'a1',
    capabilityKind: 'connector',
    connectorId: 'conn:connector:clawboo:mcp:playwright',
    capabilityId: null,
    mode: 'write',
    approvalPolicy: 'risk',
  }).id
})

const rule = (toolName: string, decision: 'allow' | 'deny') =>
  mintStandingRule(db, {
    grantId,
    toolName,
    argsShape: null,
    decision,
    expiresAt: Date.now() + 60_000,
  })

describe('retireRulesFromBeforeRememberedChanges', () => {
  it('deletes the allow rules saved before, keeps deny rules, and runs once', () => {
    rule('mcp__playwright__browser_click', 'allow')
    rule('mcp__playwright__browser_navigate', 'allow')
    rule('mcp__playwright__browser_evaluate', 'deny')

    expect(retireRulesFromBeforeRememberedChanges(db)).toBe(2)
    expect(listStandingRules(db, grantId).map((r) => r.decision)).toEqual(['deny'])
    expect(getSetting(db, REMEMBERED_CHANGES_RULES_FLAG)).not.toBeNull()

    // A rule minted after the upgrade is one given with the new meaning.
    rule('mcp__playwright__browser_click', 'allow')
    expect(retireRulesFromBeforeRememberedChanges(db)).toBe(0)
    expect(listStandingRules(db, grantId)).toHaveLength(2)
  })
})
