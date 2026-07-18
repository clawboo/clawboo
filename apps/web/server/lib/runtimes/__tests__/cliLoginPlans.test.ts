// The pure half of the UI-driven ChatGPT sign-in: per-tool spawn plans (argv /
// env / PTY wrapper / platform gating) + the output parsers (fed real ANSI /
// box-drawing samples pinned from the installed CLIs' source).

import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildCliLoginPlan,
  CLI_LOGIN_COMMANDS,
  createCliLoginParser,
  isCliLoginTool,
  stripAnsi,
} from '../cliLoginPlans'

const bins: Record<string, string> = {
  codex: '/usr/local/bin/codex',
  hermes: '/Users/u/Library/Python/3.14/bin/hermes',
  openclaw: '/usr/local/bin/openclaw',
}
const resolve = (name: string): string | null => bins[name] ?? null

describe('buildCliLoginPlan (spawn table)', () => {
  it('codex: plain `codex login` (browser flow — headless-safe, the CLI opens the browser)', () => {
    const r = buildCliLoginPlan('codex', 'darwin', resolve)
    if (!r.ok) throw new Error('expected ok')
    expect(r.plan.command).toBe(bins['codex'])
    expect(r.plan.args).toEqual(['login'])
    expect(r.plan.displayCommand).toBe('codex login')
  })

  it('hermes: `auth add openai-codex --type oauth` (the REAL flow — `hermes login` is a dead stub) with PYTHONUNBUFFERED + bin-dir PATH', () => {
    const r = buildCliLoginPlan('hermes', 'linux', resolve)
    if (!r.ok) throw new Error('expected ok')
    expect(r.plan.command).toBe(bins['hermes'])
    expect(r.plan.args).toEqual(['auth', 'add', 'openai-codex', '--type', 'oauth'])
    // LOAD-BEARING: block-buffered pipes would hide the device code for 15 min.
    expect(r.plan.env['PYTHONUNBUFFERED']).toBe('1')
    expect(r.plan.env['PATH']).toContain(path.dirname(bins['hermes']!))
    expect(r.plan.displayCommand).toBe('hermes auth add openai-codex')
  })

  it('openclaw on darwin: BSD `script -q /dev/null <bin> …` PTY wrapper (the stdin.isTTY guard)', () => {
    const r = buildCliLoginPlan('openclaw', 'darwin', resolve)
    if (!r.ok) throw new Error('expected ok')
    expect(r.plan.command).toBe('script')
    expect(r.plan.args).toEqual([
      '-q',
      '/dev/null',
      bins['openclaw'],
      'models',
      'auth',
      'login',
      '--provider',
      'openai-codex',
    ])
    expect(r.plan.env['COLUMNS']).toBe('120')
  })

  it('openclaw on linux: util-linux `script -qec "<cmd>" /dev/null` (one command string, quoted bin)', () => {
    const r = buildCliLoginPlan('openclaw', 'linux', resolve)
    if (!r.ok) throw new Error('expected ok')
    expect(r.plan.command).toBe('script')
    expect(r.plan.args).toEqual([
      '-qec',
      `'${bins['openclaw']}' models auth login --provider openai-codex`,
      '/dev/null',
    ])
  })

  it('openclaw on win32: UNSUPPORTED_PLATFORM (no PTY without a native dep) → the UI copy-fallback', () => {
    const r = buildCliLoginPlan('openclaw', 'win32', resolve)
    expect(r).toMatchObject({ ok: false, code: 'UNSUPPORTED_PLATFORM' })
  })

  it('a missing binary is NOT_INSTALLED for every tool', () => {
    for (const tool of ['codex', 'hermes', 'openclaw'] as const) {
      const r = buildCliLoginPlan(tool, 'darwin', () => null)
      expect(r).toMatchObject({ ok: false, code: 'NOT_INSTALLED' })
    }
  })

  it('isCliLoginTool guards the route param', () => {
    expect(isCliLoginTool('codex')).toBe(true)
    expect(isCliLoginTool('openclaw')).toBe(true)
    expect(isCliLoginTool('clawboo-native')).toBe(false)
    expect(isCliLoginTool(undefined)).toBe(false)
  })

  it('display commands match the documented manual fallbacks', () => {
    expect(CLI_LOGIN_COMMANDS.hermes).toBe('hermes auth add openai-codex')
    // NO --device-code: the default oauth method is the ungated browser-PKCE flow.
    expect(CLI_LOGIN_COMMANDS.openclaw).toBe('openclaw models auth login --provider openai-codex')
  })
})

describe('parsers (fixture output pinned from the installed CLIs)', () => {
  it('hermes: the ANSI-wrapped code on the line AFTER "2. Enter this code:"', () => {
    const parse = createCliLoginParser('hermes')
    const lines = [
      'To continue, follow these steps:',
      '',
      '  1. Open this URL in your browser:',
      '     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m',
      '',
      '  2. Enter this code:',
      '     \x1b[94mKXTV-PQRS\x1b[0m',
      '',
      'Waiting for sign-in... (press Ctrl+C to cancel)',
    ]
    let signal = null
    for (const raw of lines) signal = parse(stripAnsi(raw)) ?? signal
    expect(signal).toEqual({
      deviceCode: { url: 'https://auth.openai.com/codex/device', code: 'KXTV-PQRS' },
    })
  })

  it('openclaw browser flow (the default we spawn): the `Open: <authorize-url>` line', () => {
    const parse = createCliLoginParser('openclaw')
    const lines = [
      '\x1b[2m│\x1b[0m  Browser will open for OpenAI authentication.',
      '\x1b[2m│\x1b[0m  OpenAI OAuth uses localhost:1455 for the callback.',
      'Open: https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&code_challenge=y&state=z',
    ]
    let signal = null
    for (const raw of lines) signal = parse(stripAnsi(raw)) ?? signal
    expect(signal).toEqual({
      authUrl:
        'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&code_challenge=y&state=z',
    })
  })

  it('openclaw device flow (belt-and-suspenders for a manual --device-code run): `Code:` note line', () => {
    const parse = createCliLoginParser('openclaw')
    const lines = [
      '\x1b[2m│\x1b[0m  Open this URL in your browser and enter the code below.',
      '\x1b[2m│\x1b[0m  URL: https://auth.openai.com/codex/device',
      '\x1b[2m│\x1b[0m  Code: WDJB-MJHT',
      '\x1b[2m│\x1b[0m  Code expires in 15 minutes. Never share it.',
    ]
    let signal = null
    for (const raw of lines) signal = parse(stripAnsi(raw)) ?? signal
    expect(signal).toEqual({
      deviceCode: { url: 'https://auth.openai.com/codex/device', code: 'WDJB-MJHT' },
    })
  })

  it('codex: relays the browser-flow auth URL (and never treats the device URL as one)', () => {
    const parse = createCliLoginParser('codex')
    expect(
      parse(
        'If your browser did not open, navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=y',
      ),
    ).toEqual({ authUrl: 'https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=y' })
    expect(parse('1. Open this link in your browser https://auth.openai.com/codex/device')).toEqual(
      { authUrl: 'https://auth.openai.com/codex/device' },
    )
    expect(parse('Successfully logged in.')).toBeNull()
  })

  it('stripAnsi removes escape sequences + box chrome but keeps the payload', () => {
    expect(stripAnsi('\x1b[94mABCD-EFGH\x1b[0m')).toBe('ABCD-EFGH')
    expect(stripAnsi('│  Code: WDJB-MJHT  │').trim()).toBe('Code: WDJB-MJHT')
    // ESC-anchored: bracketed PROSE without an escape byte survives intact.
    expect(stripAnsi('note [94m is a color code; [1] is a footnote')).toBe(
      'note [94m is a color code; [1] is a footnote',
    )
  })
})
