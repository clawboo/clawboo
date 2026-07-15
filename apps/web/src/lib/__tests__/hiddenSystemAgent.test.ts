import { describe, expect, it } from 'vitest'

import { isHiddenGatewayDefault } from '../hiddenSystemAgent'

const MAIN = { id: 'main' }
const REGULAR = { id: 'thumbnail-advisor-boo' }

describe('isHiddenGatewayDefault', () => {
  it('hides the Gateway "main" default in native-first (main is NOT the identified Boo Zero)', () => {
    // defaultId → native Boo Zero, so booZeroAgentId is the native id, not "main".
    expect(isHiddenGatewayDefault(MAIN, 'main', 'native-boo-zero-9bde3c')).toBe(true)
  })

  it('KEEPS "main" in a pure-OpenClaw install (main IS Boo Zero — the crowned leader)', () => {
    // resolveBooZero falls back to the Gateway default, so booZeroAgentId === "main".
    // The `id !== booZeroAgentId` guard is load-bearing here.
    expect(isHiddenGatewayDefault(MAIN, 'main', 'main')).toBe(false)
  })

  it('never hides a regular (non-default) agent', () => {
    expect(isHiddenGatewayDefault(REGULAR, 'main', 'native-boo-zero-9bde3c')).toBe(false)
  })

  it('no-ops before the Gateway default id is known', () => {
    expect(isHiddenGatewayDefault(MAIN, null, 'native-boo-zero-9bde3c')).toBe(false)
  })

  it('no-ops before Boo Zero is identified (avoids a hide→show flash)', () => {
    // While booZeroAgentId is still null we can't know whether main IS Boo Zero
    // (pure-OpenClaw), so keep it visible until identification lands.
    expect(isHiddenGatewayDefault(MAIN, 'main', null)).toBe(false)
  })
})
