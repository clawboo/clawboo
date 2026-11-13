// The in-app sign-in with agents on their own OS user (CLAWBOO_AGENT_USER): the
// Codex and Hermes logins run as the agent user, through the agent host, so the
// login they make is the agents' own. OpenClaw's stays a server spawn, because
// its agents run in its Gateway as the server's user. In its own file because
// `vi.mock` is file-global.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteSpawnOptions } from '../../lib/agentUser/client'
import { setActiveAgentHost } from '../../lib/agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../lib/agentUser/__tests__/inProcessHost'

const bins = vi.hoisted(() => ({ map: {} as Record<string, string> }))
vi.mock('../../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/platform')>()),
  resolveRuntimeBin: (name: string) => bins.map[name] ?? null,
}))
// The person's own Codex login, as `codex login status` would report it: never
// signed in here, and never run for real.
vi.mock('../../lib/runtimes/codexAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/runtimes/codexAuth')>()),
  isCodexLoggedIn: () => Promise.resolve(false),
}))

const { cliLoginPOST } = await import('../cliLogin')

const posix = process.platform !== 'win32'

function sseRes(): {
  res: Response
  events: () => Record<string, unknown>[]
  ended: () => boolean
  cancel: () => void
} {
  let ended = false
  const frames: Record<string, unknown>[] = []
  const closeHandlers: (() => void)[] = []
  const res = {
    setHeader() {},
    flushHeaders() {},
    status() {
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
    cancel: () => {
      for (const h of closeHandlers) h()
    },
  }
}

const req = (tool: string): Request =>
  ({ params: { tool }, query: {}, body: {} }) as unknown as Request

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  expect(cond()).toBe(true)
}

let tmp: string
/** The agent user's home, as the host reports it. */
let agentHome: string
let active: InProcessHost | null = null
let spawns: RemoteSpawnOptions[] = []

/** Each fake prints a sign-in URL and then runs `tail` (it signs nothing in). */
function fakeBins(tail: string): void {
  for (const tool of ['codex', 'hermes', 'openclaw']) {
    const bin = path.join(tmp, 'bin', tool)
    fs.writeFileSync(bin, `#!/bin/sh\necho "Open: https://auth.example.invalid/x"\n${tail}\n`, {
      mode: 0o755,
    })
    bins.map[tool] = bin
  }
}

/** A sign-in landing in the agent user's own store, as the CLI run as that user
 *  would leave it. */
function agentSignedIn(tool: 'codex' | 'hermes'): void {
  const dir = path.join(agentHome, tool === 'codex' ? '.codex' : '.hermes')
  fs.mkdirSync(dir, { recursive: true })
  const auth =
    tool === 'codex'
      ? { tokens: { access_token: 'a', refresh_token: 'r' } }
      : { credential_pool: { 'openai-codex': [{ access_token: 'a' }] } }
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth))
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-login-agent-')))
  agentHome = path.join(tmp, 'agent')
  for (const d of ['bin', 'agent', 'operator']) fs.mkdirSync(path.join(tmp, d))
  fakeBins('exit 1')
  // The person's own home: no login of theirs in it.
  vi.stubEnv('HOME', path.join(tmp, 'operator'))
  vi.stubEnv('CODEX_HOME', undefined)
  vi.stubEnv('HERMES_HOME', undefined)
  vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
  const h = startInProcessHost()
  active = h
  const hello = await h.client.waitForHello()
  setActiveAgentHost({
    client: h.client,
    hello: { ...hello, home: agentHome },
    config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
  })
  spawns = []
  const spawn = h.client.spawn.bind(h.client)
  vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
    spawns.push(o)
    return spawn(o)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  active?.client.close()
  active = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.runIf(posix)('in-app sign-in with agents on their own OS user', () => {
  it.each(['codex', 'hermes'])(
    'runs the %s login through the agent host, as a process-group leader',
    async (tool) => {
      const m = sseRes()
      cliLoginPOST(req(tool), m.res)
      await until(() => m.ended())

      expect(spawns).toHaveLength(1)
      expect(spawns[0]).toMatchObject({ command: bins.map[tool], group: true })
      // The CLI's own output still reaches the person.
      expect(m.events()).toContainEqual({
        type: 'output',
        line: 'Open: https://auth.example.invalid/x',
      })
    },
  )

  it.each(['codex', 'hermes'] as const)(
    "completes a %s sign-in that landed in the agent user's own store",
    async (tool) => {
      agentSignedIn(tool)
      const m = sseRes()
      cliLoginPOST(req(tool), m.res)
      await until(() => m.ended())
      expect(m.events()).toContainEqual({ type: 'complete', success: true, loggedIn: true })
    },
  )

  it("does not take the person's own login for the agents' sign-in", async () => {
    // The person is signed in; the agent user is not.
    fs.mkdirSync(path.join(tmp, 'operator', '.hermes'))
    fs.writeFileSync(
      path.join(tmp, 'operator', '.hermes', 'auth.json'),
      JSON.stringify({ credential_pool: { 'openai-codex': [{ access_token: 'a' }] } }),
    )
    const m = sseRes()
    cliLoginPOST(req('hermes'), m.res)
    await until(() => m.ended())
    expect(m.events()).toContainEqual(
      expect.objectContaining({ type: 'complete', success: false, loggedIn: false }),
    )
  })

  it("sees the agents' login while the CLI still runs, and stops it", async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    fakeBins('exec sleep 30')
    const m = sseRes()
    cliLoginPOST(req('codex'), m.res)
    await until(() => spawns.length === 1)
    agentSignedIn('codex')
    vi.advanceTimersByTime(3_000)
    await until(() => m.ended())
    expect(m.events()).toContainEqual({ type: 'complete', success: true, loggedIn: true })
  })

  it("keeps the OpenClaw login a server spawn: its Gateway runs as the server's user", () => {
    const m = sseRes()
    cliLoginPOST(req('openclaw'), m.res)
    expect(spawns).toHaveLength(0)
    m.cancel()
  })
})
