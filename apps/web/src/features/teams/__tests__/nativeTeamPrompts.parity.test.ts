// Drift guard — the client's native team prompts MUST match the onboarding seed's
// canonical copies (the server can't be imported by the browser bundle, so they're
// duplicated in `nativeTeamPrompts.ts`). This test imports both.

import { describe, expect, it } from 'vitest'

// The one sanctioned src → server import: this guard only works by reading both
// copies, and it never ships (test-only, node project). See the SPA → server
// boundary rule in eslint.config.mjs.
// eslint-disable-next-line no-restricted-imports
import { LEADER_PROMPT, SPECIALIST_PROMPT } from '../../../../server/api/onboardingSeed'
import { NATIVE_LEADER_PROMPT, NATIVE_SPECIALIST_PROMPT } from '../nativeTeamPrompts'

describe('native team prompts stay in sync with the onboarding seed', () => {
  it('leader prompt matches the seed', () => {
    expect(NATIVE_LEADER_PROMPT).toBe(LEADER_PROMPT)
  })
  it('specialist prompt matches the seed', () => {
    expect(NATIVE_SPECIALIST_PROMPT).toBe(SPECIALIST_PROMPT)
  })
})
