// oauthFlow — the sign-out race.
//
// The flow had no test file at all, which is how a signed-out connector could be
// re-authorized by its own callback: `clearOAuth` emptied the vault while the
// pending listener kept running, and the exchange that landed a moment later
// wrote its tokens straight back.
//
// Everything outside the flow is stubbed at two seams: `@clawboo/mcp` for
// discovery and the code exchange, and the local listener/store. The listener's
// `waitForCallback` is a promise this file resolves by hand, which is what makes
// the race deterministic rather than timing-dependent.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveStoredTokens = vi.fn()
const exchangeCode = vi.fn()
const listenerClose = vi.fn()

/** Resolves the pending callback, standing in for the provider's redirect. */
let deliverCallback: (cb: { code: string; state: string }) => void = () => {}
/** The `state` beginAuthorization minted, captured so the callback can echo it. */
let issuedState = ''

vi.mock('@clawboo/mcp', () => ({
  buildAuthorizeUrl: ({ state }: { state: string }) => {
    issuedState = state
    return `https://provider.example/authorize?state=${state}`
  },
  createPkce: () => ({ verifier: 'v', challenge: 'c', method: 'S256' }),
  discoverResourceMetadata: async () => ({
    resource: 'https://server.example',
    authorization_servers: ['https://provider.example'],
  }),
  discoverAuthServer: async () => ({ issuer: 'https://provider.example' }),
  exchangeCode: (...args: unknown[]) => exchangeCode(...args),
  isLoopbackUrl: () => false,
  refreshToken: vi.fn(),
  registerClient: async () => ({ client_id: 'cid' }),
}))

vi.mock('../oauthListener', () => ({
  startOAuthListener: async () => ({
    redirectUri: 'http://127.0.0.1:9999/callback',
    waitForCallback: () =>
      new Promise<{ code: string; state: string }>((resolve) => {
        deliverCallback = resolve
      }),
    settle: vi.fn(),
    close: listenerClose,
  }),
}))

vi.mock('../oauthStore', () => ({
  getStoredClient: () => undefined,
  getStoredTokens: () => undefined,
  saveStoredClient: vi.fn(),
  saveStoredTokens: (...args: unknown[]) => saveStoredTokens(...args),
}))

const { beginAuthorization, cancelPendingAuth, awaitAuthorization } = await import('../oauthFlow')

/**
 * Drain the completion chain.
 *
 * A single macrotask is not enough: the callback resolves, then an async `then`
 * awaits `exchangeCode`, then the write happens, so the write lands several
 * microtask turns later. A weak drain made these tests pass against the
 * unfixed code, which is the one thing a regression test must not do.
 */
const settle = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < 25; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  exchangeCode.mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
})

describe('oauthFlow — a cancelled sign-in cannot publish tokens', () => {
  it('stores tokens when the callback lands on a sign-in nobody cancelled', async () => {
    await beginAuthorization('control', 'https://server.example')
    deliverCallback({ code: 'abc', state: issuedState })
    await awaitAuthorization('control').catch(() => {})
    await settle()

    expect(saveStoredTokens).toHaveBeenCalledTimes(1)
    expect(saveStoredTokens).toHaveBeenCalledWith(
      'control',
      expect.objectContaining({ access_token: 'at' }),
    )
  })

  // THE REGRESSION. Sign-out drops the pending entry; the callback then arrives
  // for a sign-in that is no longer current and must be refused. Before the fix
  // this wrote a token for a connector the operator had just revoked.
  it('refuses a callback that lands AFTER sign-out cancelled the sign-in', async () => {
    await beginAuthorization('revoked', 'https://server.example')

    expect(cancelPendingAuth('revoked')).toBe(true)

    deliverCallback({ code: 'abc', state: issuedState })
    await settle()

    expect(saveStoredTokens).not.toHaveBeenCalled()
  })

  // The narrower window: sign-out arrives while the code exchange is already in
  // flight, so cancelling cannot recall it. The identity check before the write
  // is the only thing that can still refuse, which is why it does not live in
  // the `finally` that runs after the write.
  it('refuses when sign-out lands DURING the code exchange', async () => {
    let releaseExchange: () => void = () => {}
    exchangeCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseExchange = () => resolve({ access_token: 'at', expires_in: 3600 })
        }),
    )

    await beginAuthorization('mid-flight', 'https://server.example')
    deliverCallback({ code: 'abc', state: issuedState })
    await settle() // the exchange is now pending

    cancelPendingAuth('mid-flight')
    releaseExchange()
    await settle()

    expect(saveStoredTokens).not.toHaveBeenCalled()
  })

  it('closes the listener when a sign-in is cancelled, and reports nothing to cancel', () => {
    expect(cancelPendingAuth('never-started')).toBe(false)
  })
})
