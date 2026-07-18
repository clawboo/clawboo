// The Codex driver's terminal must be idempotent across the subprocess
// substrate's 'error'+'close' double-fire: `createSpawnDriver` invokes `onClose`
// from BOTH the child's 'error' and 'close' handlers, and a spawn of a missing
// binary fires both ('error' = ENOENT, then 'close'). Without the `sawResult`
// guard the driver would synthesize TWO `result` terminals from one run.
//
// This drives the REAL `createCodexDriver` against a REAL OS spawn — only the
// binary-path resolver is stubbed to a guaranteed-missing path, so the production
// `onClose` runs and the double-fire comes from the kernel, not a fake.

import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { CodexNativeEvent } from '@clawboo/adapter-codex'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeRunContext } from '../types'

vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return { ...actual, resolveRuntimeBin: () => '/nonexistent/clawboo-codex-doublefire' }
})

const {
  buildCodexExecArgs,
  createCodexDriver,
  hasUsableCodexAuth,
  seedCodexAuth,
  translateCodexEvent,
} = await import('../codexDriver')

describe('createCodexDriver — terminal idempotent across the error+close double-fire', () => {
  it('synthesizes exactly ONE result terminal when the spawn fires both error and close', async () => {
    const opts: StartOpts = {
      agentId: 'codex-1',
      sessionKey: 'runtime:codex:task:t1',
      message: 'do X',
    }
    const ctx: RuntimeRunContext = {}
    const driver = createCodexDriver(opts, ctx)

    const events: CodexNativeEvent[] = []
    driver.onEvent((e) => events.push(e))
    await driver.start()

    // Let the missing-binary spawn's 'error' (ENOENT) + 'close' both fire + flush.
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !events.some((e) => e.type === 'result')) {
      await new Promise((r) => setTimeout(r, 25))
    }
    await new Promise((r) => setTimeout(r, 50)) // grace for any second onClose

    const terminals = events.filter((e) => e.type === 'result')
    expect(terminals).toHaveLength(1)
  })
})

// ─── Leader continuity: argv, auth validation, freshness seeding, fail-fast ──

describe('buildCodexExecArgs (pure argv — confirmed against the 0.136 CLI)', () => {
  it('a fresh run: exec --json + bypass flags, prompt LAST', () => {
    expect(buildCodexExecArgs({ prompt: 'do X', model: 'gpt-5-codex' })).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--model',
      'gpt-5-codex',
      'do X',
    ])
  })

  it('a resumed run: `exec resume <thread-id>` with the SAME flags (leader turn 2+)', () => {
    expect(buildCodexExecArgs({ prompt: 'synthesize', resume: 'thread-abc' })).toEqual([
      'exec',
      'resume',
      'thread-abc',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      'synthesize',
    ])
  })
})

describe('hasUsableCodexAuth (parse-validated, never a bare file-exists check)', () => {
  const { mkdtempSync, writeFileSync } = fsSync
  it('OAuth tokens or an API key ⇒ usable; empty/garbage/missing ⇒ not', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-codex-auth-'))
    const p = (name: string): string => path.join(dir, name)

    writeFileSync(
      p('oauth.json'),
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }),
    )
    expect(hasUsableCodexAuth(p('oauth.json'))).toBe(true)

    writeFileSync(p('refresh-only.json'), JSON.stringify({ tokens: { refresh_token: 'r' } }))
    expect(hasUsableCodexAuth(p('refresh-only.json'))).toBe(true)

    writeFileSync(p('apikey.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))
    expect(hasUsableCodexAuth(p('apikey.json'))).toBe(true)

    writeFileSync(p('empty-tokens.json'), JSON.stringify({ tokens: { access_token: '' } }))
    expect(hasUsableCodexAuth(p('empty-tokens.json'))).toBe(false)

    writeFileSync(p('garbage.json'), 'not json {')
    expect(hasUsableCodexAuth(p('garbage.json'))).toBe(false)

    expect(hasUsableCodexAuth(p('missing.json'))).toBe(false)
  })
})

describe('seedCodexAuth (managed-home freshness decision — never clobber a rotated token)', () => {
  let userHome: string
  let managed: string
  let prevCodexHome: string | undefined
  const USABLE = JSON.stringify({ tokens: { access_token: 'user-token', refresh_token: 'r' } })

  beforeEach(async () => {
    userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-user-'))
    managed = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-managed-'))
    prevCodexHome = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = userHome // userCodexAuthPath() honours CODEX_HOME
  })
  afterEach(async () => {
    if (prevCodexHome === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = prevCodexHome
    await fs.rm(userHome, { recursive: true, force: true })
    await fs.rm(managed, { recursive: true, force: true })
  })

  it('seeds the user login into an EMPTY managed home (and no-ops with no user login)', async () => {
    await seedCodexAuth(managed) // no user auth.json → nothing seeded, no throw
    expect(fsSync.existsSync(path.join(managed, 'auth.json'))).toBe(false)

    await fs.writeFile(path.join(userHome, 'auth.json'), USABLE)
    await seedCodexAuth(managed)
    expect(hasUsableCodexAuth(path.join(managed, 'auth.json'))).toBe(true)
  })

  it('KEEPS a fresher managed token (the CLI rotates refresh tokens IN the managed home)', async () => {
    const userAuth = path.join(userHome, 'auth.json')
    const managedAuth = path.join(managed, 'auth.json')
    await fs.writeFile(userAuth, USABLE)
    await fs.writeFile(
      managedAuth,
      JSON.stringify({ tokens: { access_token: 'rotated', refresh_token: 'rotated-r' } }),
    )
    // The user's copy is OLDER than the managed (rotated) one.
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(userAuth, past, past)

    await seedCodexAuth(managed)
    const kept = JSON.parse(await fs.readFile(managedAuth, 'utf8')) as {
      tokens: { access_token: string }
    }
    expect(kept.tokens.access_token).toBe('rotated') // NOT clobbered by the stale user copy
  })

  it('REPLACES the managed token when the user re-logged-in (user file newer)', async () => {
    const userAuth = path.join(userHome, 'auth.json')
    const managedAuth = path.join(managed, 'auth.json')
    await fs.writeFile(managedAuth, JSON.stringify({ tokens: { access_token: 'old-managed' } }))
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(managedAuth, past, past)
    await fs.writeFile(userAuth, USABLE) // fresh re-login, newer mtime

    await seedCodexAuth(managed)
    const kept = JSON.parse(await fs.readFile(managedAuth, 'utf8')) as {
      tokens: { access_token: string }
    }
    expect(kept.tokens.access_token).toBe('user-token')
  })
})

describe('managed-home fail-fast (the Paperclip guard)', () => {
  let userHome: string
  let managed: string
  let prevCodexHome: string | undefined

  beforeEach(async () => {
    userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-user-'))
    managed = await fs.mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-managed-'))
    prevCodexHome = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = userHome // an EMPTY user home — no login anywhere
  })
  afterEach(async () => {
    if (prevCodexHome === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = prevCodexHome
    await fs.rm(userHome, { recursive: true, force: true })
    await fs.rm(managed, { recursive: true, force: true })
  })

  it('a MANAGED run with no usable credential fails fast with an explicit terminal', async () => {
    const opts: StartOpts = {
      agentId: 'codex-1',
      sessionKey: 'agent:codex-1:team:T',
      message: 'go',
    }
    const driver = createCodexDriver(opts, { homeDir: managed })
    const events: CodexNativeEvent[] = []
    driver.onEvent((e) => events.push(e))
    // createSpawnDriver routes a resolve() throw through onClose → a synthesized
    // FAILED result terminal (never a rejection, never a spawn): the engine
    // reflects the explicit message instead of codex 401-ing cryptically.
    await driver.start()
    const terminal = events.find((e) => e.type === 'result')
    expect(terminal).toMatchObject({ type: 'result', ok: false })
    expect((terminal as { errorMessage?: string }).errorMessage).toMatch(
      /no Codex credentials provisioned/,
    )
  })

  it('a THROWAWAY run keeps the historic lenient behavior (no auth guard)', async () => {
    const opts: StartOpts = {
      agentId: 'codex-1',
      sessionKey: 'runtime:codex:task:t1',
      message: 'go',
    }
    const driver = createCodexDriver(opts, {}) // no homeDir → mkdtemp path
    // start() resolves — the (stubbed-missing) binary spawn surfaces its own error
    // through the event stream, exactly as before this change.
    await expect(driver.start()).resolves.toBeUndefined()
  })
})

// The event SHAPES below are the exact ones `codex exec --json` (0.136) emits,
// captured live. Regression guard for the "codex just echoes the prompt" bug:
// codex wraps the reply in { type:'item.completed', item:{ type:'agent_message',
// text } }, and the parser only unwrapped a `msg` field — so the reply text was
// dropped, the run summary came back EMPTY, and the board fell back to
// "<title> completed." even though the run had succeeded.
describe('translateCodexEvent — codex 0.136 item-wrapped events', () => {
  const fresh = (): Parameters<typeof translateCodexEvent>[1] => ({
    lastText: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    sawResult: false,
  })

  it('captures the item-wrapped agent_message so the run summary is the real reply', () => {
    const state = fresh()
    translateCodexEvent({ type: 'thread.started', thread_id: 'th-1' }, state)
    translateCodexEvent({ type: 'turn.started' }, state)
    const textEvents = translateCodexEvent(
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'pong' } },
      state,
    )
    expect(textEvents).toEqual([{ type: 'text', text: 'pong' }])
    expect(state.lastText).toBe('pong')

    // turn.completed carries usage at the TOP level and is the terminal.
    const terminal = translateCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 34115, output_tokens: 22 } },
      state,
    )
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ type: 'result', ok: true, summary: 'pong' })
    expect(state.usage).toEqual({ inputTokens: 34115, outputTokens: 22 })
  })

  it('does NOT mistake an item.completed for the terminal (only turn.completed is)', () => {
    const state = fresh()
    const evs = translateCodexEvent(
      { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } },
      state,
    )
    expect(evs.some((e) => e.type === 'result')).toBe(false)
    expect(state.sawResult).toBe(false)
  })

  it('still handles the legacy msg-wrapped shape (agent_message + task_complete)', () => {
    const state = fresh()
    translateCodexEvent({ msg: { type: 'agent_message', message: 'legacy' } }, state)
    expect(state.lastText).toBe('legacy')
    const terminal = translateCodexEvent({ msg: { type: 'task_complete' } }, state)
    expect(terminal[0]).toMatchObject({ type: 'result', summary: 'legacy' })
  })
})
