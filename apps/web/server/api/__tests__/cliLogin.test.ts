// POST /api/auth/cli-login/:tool — the UI-driven ChatGPT sign-in relay. Mocks
// the process spawner (controllable fake child), platform bins, killTree, and
// the auth probes; asserts the SSE event sequence (output lines ANSI-stripped +
// structured device-code/auth-url), the KILLABLE lifetime (client close kills
// the tree), in-flight replacement, and PROBE-driven completion (exit code
// alone never claims loggedIn).

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const platformState = vi.hoisted(() => ({ bins: {} as Record<string, string | null> }))
vi.mock('../../lib/platform', () => ({
  isWindows: false,
  resolveRuntimeBin: (n: string) => platformState.bins[n] ?? null,
  resolveShimName: (n: string) => n,
  findExecutable: (n: string) => platformState.bins[n] ?? null,
}))

const probeState = vi.hoisted(() => ({
  codexLoggedIn: false,
  hermesAuth: false,
  openclawProfile: false,
  codexCacheInvalidated: 0,
}))
vi.mock('../../lib/runtimes/codexAuth', () => ({
  isCodexLoggedIn: () => Promise.resolve(probeState.codexLoggedIn),
  invalidateCodexAuthCache: () => {
    probeState.codexCacheInvalidated += 1
  },
  userCodexHome: () => '/nonexistent',
  userCodexAuthPath: () => '/nonexistent/auth.json',
}))
vi.mock('../../lib/runtimes/hermesAuth', () => ({
  isHermesCodexAuthPresent: () => probeState.hermesAuth,
  hasUsableHermesCodexAuth: () => probeState.hermesAuth,
  userHermesHome: () => '/nonexistent',
  userHermesAuthPath: () => '/nonexistent/auth.json',
}))
vi.mock('../../lib/openclawEnv', () => ({
  detectOauthProfileProviders: () =>
    probeState.openclawProfile ? new Set(['openai-codex']) : new Set(),
}))
// The store WATCHER's cheap codex tick (file-based, vs the CLI-status probe at close).
vi.mock('../../lib/runtimes/codexDriver', () => ({
  hasUsableCodexAuth: () => probeState.codexLoggedIn,
}))

const killState = vi.hoisted(() => ({ killed: [] as unknown[] }))
vi.mock('../../lib/runtimes/killTree', () => ({
  killProcessTree: (child: unknown) => {
    killState.killed.push(child)
    ;(child as { killed: boolean }).killed = true
  },
}))

interface FakeChild {
  killed: boolean
  emitStdout: (text: string) => void
  emitClose: (code: number | null, signal?: string | null) => void
  stdout: { on: (e: string, h: (c: Buffer) => void) => void }
  stderr: { on: (e: string, h: (c: Buffer) => void) => void }
  on: (e: string, h: (...a: unknown[]) => void) => FakeChild
}
const spawnState = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[],
  children: [] as FakeChild[],
}))
vi.mock('node:child_process', () => {
  const makeChild = (): FakeChild => {
    const outHandlers: ((c: Buffer) => void)[] = []
    const closeHandlers: ((code: number | null, signal?: string | null) => void)[] = []
    const child: FakeChild = {
      killed: false,
      stdout: {
        on: (e, h) => {
          if (e === 'data') outHandlers.push(h)
        },
      },
      stderr: { on: () => {} },
      on(e, h) {
        if (e === 'close') closeHandlers.push(h as (code: number | null) => void)
        return this
      },
      emitStdout(text) {
        for (const h of outHandlers) h(Buffer.from(text))
      },
      emitClose(code, signal = null) {
        for (const h of closeHandlers) h(code, signal)
      },
    }
    return child
  }
  return {
    spawn: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawnState.calls.push({ cmd, args, env: opts.env })
      const child = makeChild()
      spawnState.children.push(child)
      return child
    },
  }
})

import { cliLoginPOST } from '../cliLogin'

interface SseRes {
  res: Response
  events: () => Record<string, unknown>[]
  ended: () => boolean
  statusCode: () => number
  emitClose: () => void
}
function sseRes(): SseRes {
  let code = 200
  let ended = false
  const frames: Record<string, unknown>[] = []
  const closeHandlers: (() => void)[] = []
  const res = {
    setHeader() {},
    flushHeaders() {},
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      frames.push(b as Record<string, unknown>)
      return this
    },
    write(chunk: string) {
      const m = chunk.match(/^data: (.*)\n\n$/s)
      if (m) frames.push(JSON.parse(m[1]!) as Record<string, unknown>)
      return true
    },
    end() {
      ended = true
    },
    get writableEnded() {
      return ended
    },
    on(e: string, h: () => void) {
      if (e === 'close') closeHandlers.push(h)
    },
  } as unknown as Response
  return {
    res,
    events: () => frames,
    ended: () => ended,
    statusCode: () => code,
    emitClose: () => {
      for (const h of closeHandlers) h()
    },
  }
}
const req = (tool: string): Request =>
  ({ params: { tool }, query: {}, body: {} }) as unknown as Request

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('POST /api/auth/cli-login/:tool', () => {
  beforeEach(() => {
    platformState.bins = {
      codex: '/bin/codex',
      hermes: '/py/bin/hermes',
      openclaw: '/bin/openclaw',
    }
    probeState.codexLoggedIn = false
    probeState.hermesAuth = false
    probeState.openclawProfile = false
    probeState.codexCacheInvalidated = 0
    spawnState.calls = []
    spawnState.children = []
    killState.killed = []
  })

  it('404s an unknown tool (plain JSON, no stream)', () => {
    const m = sseRes()
    cliLoginPOST(req('clawboo-native'), m.res)
    expect(m.statusCode()).toBe(404)
  })

  it('NOT_INSTALLED is a typed SSE error (the UI degrades to the copy-command)', () => {
    platformState.bins['hermes'] = null
    const m = sseRes()
    cliLoginPOST(req('hermes'), m.res)
    expect(m.events()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'NOT_INSTALLED' }),
    )
    expect(m.ended()).toBe(true)
    expect(spawnState.calls).toHaveLength(0)
  })

  it('hermes happy path: spawns the REAL flow, relays stripped output + device-code, probe drives loggedIn', async () => {
    const m = sseRes()
    cliLoginPOST(req('hermes'), m.res)
    const call = spawnState.calls[0]!
    expect(call.cmd).toBe('/py/bin/hermes')
    expect(call.args).toEqual(['auth', 'add', 'openai-codex', '--type', 'oauth'])
    expect(call.env['PYTHONUNBUFFERED']).toBe('1') // block-buffering would hide the code

    const child = spawnState.children[0]!
    child.emitStdout(
      '  1. Open this URL in your browser:\n     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n  2. Enter this code:\n     \x1b[94mKXTV-PQRS\x1b[0m\n',
    )
    // The structured signal + the ANSI-stripped raw lines both stream.
    expect(m.events()).toContainEqual({
      type: 'device-code',
      url: 'https://auth.openai.com/codex/device',
      code: 'KXTV-PQRS',
    })
    expect(
      m.events().some((e) => e['type'] === 'output' && String(e['line']).includes('KXTV-PQRS')),
    ).toBe(true)
    expect(m.events().every((e) => !JSON.stringify(e).includes('\\u001b'))).toBe(true)

    probeState.hermesAuth = true // the CLI wrote the pool credential
    child.emitClose(0)
    await flush()
    expect(m.events()).toContainEqual({ type: 'complete', success: true, loggedIn: true })
    expect(m.ended()).toBe(true)
  })

  it('exit 0 WITHOUT the store materializing is NOT loggedIn (probe is the truth)', async () => {
    const m = sseRes()
    cliLoginPOST(req('hermes'), m.res)
    spawnState.children[0]!.emitClose(0)
    await flush()
    expect(m.events()).toContainEqual(
      expect.objectContaining({ type: 'complete', success: false, loggedIn: false }),
    )
  })

  it('codex: relays the browser-flow auth URL; completion invalidates the login cache before probing', async () => {
    const m = sseRes()
    cliLoginPOST(req('codex'), m.res)
    expect(spawnState.calls[0]).toMatchObject({ cmd: '/bin/codex', args: ['login'] })
    spawnState.children[0]!.emitStdout(
      'If your browser did not open, navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?x=1\n',
    )
    expect(m.events()).toContainEqual({
      type: 'auth-url',
      url: 'https://auth.openai.com/oauth/authorize?x=1',
    })
    probeState.codexLoggedIn = true
    spawnState.children[0]!.emitClose(0)
    await flush()
    expect(probeState.codexCacheInvalidated).toBeGreaterThan(0)
    expect(m.events()).toContainEqual({ type: 'complete', success: true, loggedIn: true })
  })

  it('openclaw: PTY-wrapped via `script`, browser-PKCE by default; the `Open:` line becomes auth-url', async () => {
    const m = sseRes()
    cliLoginPOST(req('openclaw'), m.res)
    const call = spawnState.calls[0]!
    expect(call.cmd).toBe('script') // the stdin.isTTY guard demands a PTY
    // NO --device-code: the default oauth method is the ungated browser flow.
    expect(call.args.join(' ')).toContain('models auth login --provider openai-codex')
    expect(call.args.join(' ')).not.toContain('--device-code')
    spawnState.children[0]!.emitStdout(
      'Open: https://auth.openai.com/oauth/authorize?client_id=app_x&state=z\n',
    )
    expect(m.events()).toContainEqual({
      type: 'auth-url',
      url: 'https://auth.openai.com/oauth/authorize?client_id=app_x&state=z',
    })
    probeState.openclawProfile = true
    spawnState.children[0]!.emitClose(0)
    await flush()
    expect(m.events()).toContainEqual({ type: 'complete', success: true, loggedIn: true })
  })

  it('the store WATCHER completes on the credential landing on disk — WITHOUT the child exiting', async () => {
    // The slow-openclaw case: a >16s sign-in shows the CLI's paste-prompt, which
    // holds the process open after the callback succeeds. Completion must come
    // from the auth store, and the lingering child gets reaped.
    vi.useFakeTimers()
    try {
      const m = sseRes()
      cliLoginPOST(req('openclaw'), m.res)
      expect(m.events()).not.toContainEqual(expect.objectContaining({ type: 'complete' }))
      probeState.openclawProfile = true // the profile lands on disk mid-flow
      await vi.advanceTimersByTimeAsync(3_100)
      expect(m.events()).toContainEqual({ type: 'complete', success: true, loggedIn: true })
      expect(m.ended()).toBe(true)
      expect(killState.killed).toHaveLength(1) // the lingering child is reaped
    } finally {
      vi.useRealTimers()
    }
  })

  it('client disconnect (Cancel) kills the child TREE', () => {
    const m = sseRes()
    cliLoginPOST(req('codex'), m.res)
    expect(killState.killed).toHaveLength(0)
    m.emitClose()
    expect(killState.killed).toHaveLength(1)
  })

  it('a second login for the same tool REPLACES the first (kills its tree)', () => {
    const a = sseRes()
    cliLoginPOST(req('hermes'), a.res)
    const first = spawnState.children[0]!
    const b = sseRes()
    cliLoginPOST(req('hermes'), b.res)
    expect(killState.killed).toContain(first)
  })

  it('a signal-killed / exit-130 child reads as CANCELLED, never a false failure', async () => {
    const m = sseRes()
    cliLoginPOST(req('hermes'), m.res)
    spawnState.children[0]!.emitClose(130)
    await flush()
    expect(m.events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'CANCELLED' }))
  })
})
