// PATCH /api/openclaw/config writes a per-agent model override into OpenClaw's
// own openclaw.json. It used to append to the legacy `agents.list` array.
//
// OpenClaw 2026.9 keys the roster by agent id under `agents.entries`. The two
// shapes are an either/or, not a pair: `list` alone is accepted as a legacy
// alias, but alongside `entries` the Gateway rejects the file with
// `Unrecognized key: "list"` at `agents` and then will not start at all
// (measured against a real 2026.9.2 Gateway). Since `openclaw doctor` migrates
// every upgraded install to `entries`, the old code path meant one model change
// in clawboo wrote a config the Gateway could no longer load.
//
// These tests drive the real handler against a sandboxed state dir and read the
// file back, because the bug was never in the intent, only in the key written.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openclawConfigPATCH } from '../system'

function mockRes(): { res: Response; statusCode: () => number } {
  let code = 200
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code }
}

describe('PATCH /api/openclaw/config: agent roster shape', () => {
  let home: string
  let stateDir: string
  let configPath: string
  const saved: Record<string, string | undefined> = {}

  const writeConfig = (agents: unknown): void => {
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: 'local', port: 18789, auth: { mode: 'token', token: 'x' } },
        agents,
      }),
      'utf8',
    )
  }
  const readConfig = (): Record<string, never> =>
    JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, never>

  const patchModel = async (agentId: string, model: string | null): Promise<void> => {
    const { res } = mockRes()
    await openclawConfigPATCH(
      { body: { agentModel: { agentId, model } } } as unknown as Request,
      res,
    )
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-roster-'))
    stateDir = path.join(home, '.openclaw')
    mkdirSync(stateDir, { recursive: true })
    configPath = path.join(stateDir, 'openclaw.json')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR']) saved[k] = process.env[k]
    process.env['CLAWBOO_HOME'] = home
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('writes the override under agents.entries, keyed by id', async () => {
    writeConfig({ ownership: 'explicit', entries: { main: {}, 'code-reviewer-boo': {} } })
    await patchModel('code-reviewer-boo', 'openrouter/some/model')

    const agents = readConfig()['agents'] as Record<string, never>
    expect((agents['entries'] as Record<string, never>)['code-reviewer-boo']).toEqual({
      model: 'openrouter/some/model',
    })
  })

  it('NEVER leaves `list` and `entries` in the same file', async () => {
    // The exact combination the Gateway refuses to load. A legacy array is
    // folded in and dropped rather than written alongside.
    writeConfig({ list: [{ id: 'main' }, { id: 'boo', model: 'old/model' }] })
    await patchModel('boo', 'new/model')

    const agents = readConfig()['agents'] as Record<string, never>
    expect('list' in agents).toBe(false)
    expect(Object.keys(agents['entries'] as Record<string, never>).sort()).toEqual(['boo', 'main'])
  })

  it("carries a legacy entry's other properties across the migration", async () => {
    writeConfig({ list: [{ id: 'boo', model: 'old/model', workspace: '/w/boo' }] })
    await patchModel('boo', 'new/model')

    const entries = (readConfig()['agents'] as Record<string, never>)['entries'] as Record<
      string,
      never
    >
    // `id` becomes the key and is not duplicated into the value.
    expect(entries['boo']).toEqual({ model: 'new/model', workspace: '/w/boo' })
  })

  it('clearing the model drops only the override, never the agent', async () => {
    // Under `list` an entry holding nothing but an id was spliced out, which was
    // harmless. Under `entries` the KEY is the agent's roster membership, so the
    // same move would delete the agent.
    writeConfig({
      ownership: 'explicit',
      entries: { main: {}, boo: { model: 'old/model', workspace: '/w/boo' } },
    })
    await patchModel('boo', null)

    const entries = (readConfig()['agents'] as Record<string, never>)['entries'] as Record<
      string,
      never
    >
    expect('boo' in entries).toBe(true)
    expect(entries['boo']).toEqual({ workspace: '/w/boo' })
  })

  it('keeps an agent that had no entry at all when its model is cleared', async () => {
    writeConfig({ ownership: 'explicit', entries: { main: {} } })
    await patchModel('brand-new-boo', '')

    const entries = (readConfig()['agents'] as Record<string, never>)['entries'] as Record<
      string,
      never
    >
    expect(entries['brand-new-boo']).toEqual({})
  })

  it('sets ownership=explicit when the write makes the roster multi-agent', async () => {
    // A multi-agent roster with no owner is rejected:
    //   multi-agent rosters require agents.ownership="explicit" ...
    writeConfig({ entries: { main: {} } })
    await patchModel('second-boo', 'openrouter/some/model')

    expect((readConfig()['agents'] as Record<string, never>)['ownership']).toBe('explicit')
  })

  it('does not overwrite an ownership the operator already chose', async () => {
    writeConfig({ ownership: 'inherit', entries: { main: {}, boo: {} } })
    await patchModel('boo', 'openrouter/some/model')

    expect((readConfig()['agents'] as Record<string, never>)['ownership']).toBe('inherit')
  })

  it('leaves a single-agent roster without an ownership marker', async () => {
    // Only a MULTI-agent roster needs one, and writing settings nobody asked for
    // is how config files drift.
    writeConfig({ entries: { main: {} } })
    await patchModel('main', 'openrouter/some/model')

    expect('ownership' in (readConfig()['agents'] as Record<string, never>)).toBe(false)
  })
})
