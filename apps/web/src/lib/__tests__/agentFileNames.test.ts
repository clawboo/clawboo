// @clawboo/agent-registry keeps a LOCAL copy of AGENT_FILE_NAMES (so the package
// stays dependency-free / browser-safe) that mirrors @clawboo/protocol's. Nothing
// enforces they stay in sync, and they're used interchangeably (the REST file-name
// validator reads the agent-registry copy; file writes elsewhere use protocol's).
// This test is that enforcement: if the two lists drift, it fails.

import { AGENT_FILE_NAMES as REGISTRY_NAMES } from '@clawboo/agent-registry'
import { AGENT_FILE_NAMES as PROTOCOL_NAMES } from '@clawboo/protocol'
import { describe, expect, it } from 'vitest'

describe('AGENT_FILE_NAMES duplication', () => {
  it('the agent-registry copy equals the protocol copy (same names, same order)', () => {
    expect([...REGISTRY_NAMES]).toEqual([...PROTOCOL_NAMES])
  })
})
