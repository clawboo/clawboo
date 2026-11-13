// The two browser-connector backends of the fill: the Playwright code runs the way
// Playwright MCP runs it (a bare vm context with only `page`), checks the frame's
// address before it evaluates anything, and the answers of both connectors are
// read for their result alone.

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

function fakePage(url: string) {
  const evaluated: string[] = []
  return {
    evaluated,
    page: {
      mainFrame: () => ({
        url: () => url,
        evaluate: async (expression: string) => {
          evaluated.push(expression)
          return { ok: true }
        },
      }),
    },
  }
}

describe('the Playwright code', () => {
  const fn = 'function (a) { return a }'

  it('evaluates on the origin, with no Node globals in scope', async () => {
    const { page, evaluated } = fakePage('https://bank.example/login?next=/x')
    const out = await runLikePlaywright(playwrightCode(fn, [SECRET], 'https://bank.example'), page)
    expect(out).toEqual({
      frameUrl: 'https://bank.example/login?next=/x',
      ran: true,
      value: { ok: true },
    })
    expect(evaluated).toHaveLength(1)
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
      const { page, evaluated } = fakePage(url)
      const out = await runLikePlaywright(
        playwrightCode(fn, [SECRET], 'https://bank.example'),
        page,
      )
      expect(out).toEqual({ frameUrl: url, ran: false })
      expect(evaluated).toHaveLength(0)
    }
  })

  it('carries the arguments as JSON, so a value cannot break out of the string', async () => {
    const tricky = '"); throw new Error("x"); ("'
    const { page, evaluated } = fakePage('https://bank.example/')
    await runLikePlaywright(playwrightCode(fn, [tricky], 'https://bank.example'), page)
    expect(evaluated[0]).toBe(`(${fn})(${JSON.stringify(tricky)})`)
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
    expect(run).toEqual({ frameUrl: 'https://bank.example/', value: { status: 'filled' } })
    expect(JSON.stringify(run)).not.toContain(SECRET)
    expect(playwrightResult('### Error\nboom')).toBeNull()
    expect(playwrightResult(`### Result\n{"frameUrl":"https://x.example/","ran":false}`)).toEqual({
      frameUrl: 'https://x.example/',
      value: undefined,
    })
  })

  it('reads a DevTools evaluate_script answer', () => {
    const text = 'Script ran on page and returned:\n```json\n{"status":"no_form","fields":[]}\n```'
    expect(devtoolsResult(text)).toEqual({
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
