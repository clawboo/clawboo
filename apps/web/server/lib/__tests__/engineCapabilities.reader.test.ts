// The two flags the reader key lane added: `auth.readerKey`, on only when an
// administrator set a reader key (which needs the sign-in proxy lane on), and
// `system.live`, the liveness probe, always on.

import { generateKeyPairSync } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildEngineCapabilities } from '../engineCapabilities'
import { resetOperatorSettings } from '../operatorSettings'

const proxyPem = generateKeyPairSync('ed25519')
  .publicKey.export({ format: 'pem', type: 'spki' })
  .toString()
const readerPem = generateKeyPairSync('ed25519')
  .publicKey.export({ format: 'pem', type: 'spki' })
  .toString()

beforeEach(() => resetOperatorSettings())
afterEach(() => {
  resetOperatorSettings()
  vi.unstubAllEnvs()
})

describe('capability flags for the reader key and the liveness probe', () => {
  it('reports no reader key, and the probe, with nothing set', () => {
    const { features } = buildEngineCapabilities()
    expect(features['auth.readerKey']).toBe(false)
    expect(features['system.live']).toBe(true)
  })

  it('reports the reader key once one is set beside the lane', () => {
    vi.stubEnv('CLAWBOO_PROXY_IDENTITY', 'required')
    vi.stubEnv('CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY', proxyPem)
    vi.stubEnv('CLAWBOO_PROXY_IDENTITY_ISSUER', 'https://proxy.example.com')
    vi.stubEnv('CLAWBOO_PROXY_IDENTITY_AUDIENCE', 'clawboo')
    vi.stubEnv('CLAWBOO_PROXY_IDENTITY_READER_PUBLIC_KEY', readerPem)
    const { features } = buildEngineCapabilities()
    expect(features['auth.readerKey']).toBe(true)
    expect(features['system.live']).toBe(true)
  })
})
