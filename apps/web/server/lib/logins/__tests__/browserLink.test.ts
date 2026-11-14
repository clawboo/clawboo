// The two browser-connector backends of the fill: the Playwright code runs the way
// Playwright MCP runs it (a bare vm context with only `page`), checks the frame's
// address and certificate before it evaluates anything, evaluates in a world of its
// own (never the page's), and the answers of both connectors are read for their
// result alone.

import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

import { devtoolsResult, playwrightCode, playwrightResult } from '../browserLink'

const SECRET = 'value-that-must-not-travel-back'

/** What Playwright MCP 0.0.79's browser_run_code_unsafe does with `code`. */
async function runLikePlaywright(code: string, page: unknown): Promise<unknown> {
  const context = vm.createContext({ page })
  const fn = vm.runInContext(`(${code})`, context) as (p: unknown) => Promise<unknown>
  return JSON.parse(JSON.stringify(await fn(page)))
}

interface SecurityState {
  securityState: string
  certificateSecurityState?: { certificateNetworkError?: string | null } | null
}

interface FakePageOptions {
  /** The main frame's address by the time the CDP session asks (a tab that moved on). */
  frameTreeUrl?: string
  /** The security state the browser reports; null reports none at all. */
  security?: SecurityState | null
}

/** A Playwright page with just what the code uses, and a CDP session that records. */
function fakePage(url: string, opts: FakePageOptions = {}) {
  const evaluated: { expression: string; contextId: unknown }[] = []
  const mainWorld: string[] = []
  const sent: string[] = []
  const state = { sessions: 0, detached: 0 }
  const handlers = new Map<string, (event: unknown) => void>()
  const cdp = {
    on: (event: string, handler: (e: unknown) => void) => handlers.set(event, handler),
    send: async (method: string, params: Record<string, unknown> = {}) => {
      sent.push(method)
      switch (method) {
        case 'Security.enable': {
          const security = opts.security === undefined ? { securityState: 'secure' } : opts.security
          if (security) {
            handlers.get('Security.visibleSecurityStateChanged')?.({
              visibleSecurityState: security,
            })
          }
          return {}
        }
        case 'Page.getFrameTree':
          return { frameTree: { frame: { id: 'F1', url: opts.frameTreeUrl ?? url } } }
        case 'Page.createIsolatedWorld':
          return { executionContextId: 7 }
        case 'Runtime.evaluate':
          evaluated.push({
            expression: params['expression'] as string,
            contextId: params['contextId'],
          })
          return { result: { value: { ok: true } } }
        default:
          throw new Error(`unexpected ${method}`)
      }
    },
    detach: async () => {
      state.detached++
    },
  }
  return {
    evaluated,
    mainWorld,
    sent,
    state,
    page: {
      mainFrame: () => ({
        url: () => url,
        // The page's own world: a page can hook what runs here.
        evaluate: async (expression: string) => {
          mainWorld.push(expression)
          return { ok: true }
        },
      }),
      waitForTimeout: async () => undefined,
      context: () => ({
        newCDPSession: async () => {
          state.sessions++
          return cdp
        },
      }),
    },
  }
}

describe('the Playwright code', () => {
  const fn = 'function (a) { return a }'

  it('evaluates on the origin in its own world, with no Node globals in scope', async () => {
    const fake = fakePage('https://bank.example/login?next=/x')
    const out = await runLikePlaywright(
      playwrightCode(fn, [SECRET], 'https://bank.example'),
      fake.page,
    )
    expect(out).toEqual({
      frameUrl: 'https://bank.example/login?next=/x',
      ran: true,
      value: { ok: true },
    })
    expect(fake.evaluated).toHaveLength(1)
    expect(fake.evaluated[0]?.contextId).toBe(7)
    // Never through the page's own world, where a page could read the source.
    expect(fake.mainWorld).toHaveLength(0)
    expect(fake.sent).toEqual([
      'Security.enable',
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ])
    expect(fake.state.detached).toBe(1)
  })

  it('evaluates nothing anywhere else', async () => {
    for (const url of [
      'https://bank.example.evil.test/login',
      'https://bank.example@evil.test/',
      'https://bank.example:8443/',
      'http://bank.example/',
      'https://evil.test/?u=https://bank.example/',
      'about:blank',
      'data:text/html,https://bank.example/',
    ]) {
      const fake = fakePage(url)
      const out = await runLikePlaywright(
        playwrightCode(fn, [SECRET], 'https://bank.example'),
        fake.page,
      )
      expect(out).toEqual({ frameUrl: url, ran: false })
      expect(fake.evaluated).toHaveLength(0)
      expect(fake.mainWorld).toHaveLength(0)
    }
  })

  it('evaluates nothing when the tab has moved on by the time the session reads it', async () => {
    const fake = fakePage('https://bank.example/login', { frameTreeUrl: 'https://evil.test/' })
    const out = await runLikePlaywright(
      playwrightCode(fn, [SECRET], 'https://bank.example'),
      fake.page,
    )
    expect(out).toEqual({ frameUrl: 'https://evil.test/', ran: false })
    expect(fake.evaluated).toHaveLength(0)
    expect(fake.state.detached).toBe(1)
  })

  it('evaluates nothing on a page with a certificate error', async () => {
    const states: SecurityState[] = [
      { securityState: 'insecure-broken' },
      {
        securityState: 'insecure',
        certificateSecurityState: { certificateNetworkError: 'net::ERR_CERT_AUTHORITY_INVALID' },
      },
    ]
    for (const security of states) {
      const fake = fakePage('https://bank.example/login', { security })
      const out = await runLikePlaywright(
        playwrightCode(fn, [SECRET], 'https://bank.example'),
        fake.page,
      )
      expect(out).toEqual({ frameUrl: 'https://bank.example/login', ran: false, insecure: true })
      expect(fake.evaluated).toHaveLength(0)
      expect(fake.mainWorld).toHaveLength(0)
    }
  })

  it('evaluates nothing when the browser reports no security state to vouch for it', async () => {
    // Playwright's bare headless shell reports none.
    const fake = fakePage('https://bank.example/login', { security: null })
    const out = await runLikePlaywright(
      playwrightCode(fn, [SECRET], 'https://bank.example'),
      fake.page,
    )
    expect(out).toEqual({ frameUrl: 'https://bank.example/login', ran: false, unverifiable: true })
    expect(fake.evaluated).toHaveLength(0)
  })

  it('needs no certificate on a plain http address', async () => {
    const fake = fakePage('http://localhost:3000/login', { security: null })
    const out = (await runLikePlaywright(
      playwrightCode(fn, [SECRET], 'http://localhost:3000'),
      fake.page,
    )) as { ran: boolean }
    expect(out.ran).toBe(true)
    expect(fake.evaluated).toHaveLength(1)
  })

  it('carries the arguments as JSON, so a value cannot break out of the string', async () => {
    const tricky = '"); throw new Error("x"); ("'
    const fake = fakePage('https://bank.example/')
    await runLikePlaywright(playwrightCode(fn, [tricky], 'https://bank.example'), fake.page)
    expect(fake.evaluated[0]?.expression).toBe(`(${fn})(${JSON.stringify(tricky)})`)
  })
})

describe('reading the connectors answers', () => {
  it('takes only the result out of a Playwright answer that echoes the code', () => {
    const text = [
      '### Result',
      JSON.stringify({ frameUrl: 'https://bank.example/', ran: true, value: { status: 'filled' } }),
      '### Ran Playwright code',
      '```js',
      `await (async (page) => { /* ${SECRET} */ })(page);`,
      '```',
      '### Page',
      '- Page URL: https://bank.example/',
    ].join('\n')
    const run = playwrightResult(text)
    expect(run).toEqual({
      kind: 'ran',
      frameUrl: 'https://bank.example/',
      value: { status: 'filled' },
    })
    expect(JSON.stringify(run)).not.toContain(SECRET)
    expect(playwrightResult('### Error\nboom')).toBeNull()
    expect(playwrightResult(`### Result\n{"frameUrl":"https://x.example/","ran":false}`)).toEqual({
      kind: 'ran',
      frameUrl: 'https://x.example/',
      value: undefined,
    })
    expect(
      playwrightResult(`### Result\n{"frameUrl":"https://x.example/","ran":false,"insecure":true}`),
    ).toEqual({ kind: 'insecure' })
    expect(
      playwrightResult(
        `### Result\n{"frameUrl":"https://x.example/","ran":false,"unverifiable":true}`,
      ),
    ).toEqual({ kind: 'unverifiable' })
  })

  it('reads a DevTools evaluate_script answer', () => {
    const text = 'Script ran on page and returned:\n```json\n{"status":"no_form","fields":[]}\n```'
    expect(devtoolsResult(text)).toEqual({
      kind: 'ran',
      frameUrl: null,
      value: { status: 'no_form', fields: [] },
    })
    expect(devtoolsResult('Error: no page')).toBeNull()
  })
})

describe('a page that hooks the call', () => {
  it('sees no value before the origin check refuses it', async () => {
    // A hostile page the tab moved to after the probe: it hooks what it can.
    const { callExpression } = await import('../browserLink')
    const { PAGE_FILL_SOURCES } = await import('../pageFill')
    const seen: unknown[] = []
    const context = vm.createContext({
      location: { origin: 'https://evil.test' },
      console,
    })
    vm.runInContext(
      `Function.prototype.apply = function (_t, a) { leak(a) }; Function.prototype.call = function (_t, ...a) { leak(a) };`,
      Object.assign(context, { leak: (a: unknown) => seen.push(a) }),
    )
    const out = vm.runInContext(
      callExpression(PAGE_FILL_SOURCES.fill, ['https://bank.example', 'user@x', SECRET, null]),
      context,
    ) as { status: string }
    expect(out.status).toBe('not_on_site')
    expect(JSON.stringify(seen)).not.toContain(SECRET)
  })
})
