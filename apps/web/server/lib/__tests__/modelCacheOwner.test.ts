// OpenClaw 2026.9 refuses `openclaw models list` on a multi-agent install that
// names no owner, which a clawboo team on OpenClaw typically produces. The
// listing must then ask again with `--agent`, and must not
// send that flag to an install that never asked for it (older OpenClaw versions
// may not know it). The CLI is mocked; the OpenClaw config is a real file.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  // promisify(execFile) resolves to this custom implementation.
  return { execFile: Object.assign(() => {}, { [promisify.custom]: listMock }) }
})

// The exact refusal OpenClaw 2026.9.2 printed on 2026-10-22 (exit 1).
const NO_OWNER =
  'Multiple agents are configured, but model inspection has no explicit owner. Pass --agent <id> or set agents.defaults.systemAgent.agentId.'
const refusal = (): Error =>
  Object.assign(new Error('Command failed: openclaw models list --all --json'), {
    stdout: JSON.stringify({ ok: false, error: { type: 'cli_error', message: NO_OWNER } }),
    stderr: `[openclaw] Could not start the CLI.\n[openclaw] Reason: ${NO_OWNER}\n`,
  })
const LISTING = {
  stdout: JSON.stringify({
    count: 1,
    models: [
      {
        key: 'openai/gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        input: '',
        contextWindow: 272000,
        local: false,
        available: true,
        tags: [],
      },
    ],
  }),
  stderr: '',
}
const argsOf = (call: number): string[] => listMock.mock.calls[call]?.[1] as string[]

let stateDir: string
let savedStateDir: string | undefined

function writeRoster(agents: unknown): void {
  writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify({ agents }))
}

beforeEach(() => {
  vi.resetModules()
  listMock.mockReset()
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-oc-models-'))
  savedStateDir = process.env['OPENCLAW_STATE_DIR']
  process.env['OPENCLAW_STATE_DIR'] = stateDir
})
afterEach(() => {
  vi.useRealTimers()
  if (savedStateDir === undefined) delete process.env['OPENCLAW_STATE_DIR']
  else process.env['OPENCLAW_STATE_DIR'] = savedStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

describe('pickModelInspectionAgent', () => {
  it('prefers the one entry marked default, then main, then the first (keyed roster)', async () => {
    const { pickModelInspectionAgent } = await import('../modelCache')
    const roster = (entries: Record<string, unknown>) => ({ agents: { entries } })
    expect(pickModelInspectionAgent(roster({ a: {}, main: {}, b: { default: true } }))).toBe('b')
    expect(pickModelInspectionAgent(roster({ a: {}, main: {} }))).toBe('main')
    expect(pickModelInspectionAgent(roster({ writer: {}, coder: {} }))).toBe('writer')
    // Two markers are no marker.
    expect(
      pickModelInspectionAgent(roster({ a: { default: true }, b: { default: true }, main: {} })),
    ).toBe('main')
  })

  it('reads the legacy agents.list array too, and is null with no agents', async () => {
    const { pickModelInspectionAgent } = await import('../modelCache')
    expect(pickModelInspectionAgent({ agents: { list: [{ id: 'x' }, { id: 'main' }] } })).toBe(
      'main',
    )
    expect(pickModelInspectionAgent({ agents: { list: [{}, { id: 'y' }] } })).toBe('y')
    expect(pickModelInspectionAgent({ agents: { entries: {} } })).toBeNull()
    expect(pickModelInspectionAgent(null)).toBeNull()
  })
})

describe('getModelsFromCli on a multi-agent OpenClaw', () => {
  it('an install that lists fine runs the plain command, with no --agent', async () => {
    listMock.mockResolvedValue(LISTING)
    const { getModelsFromCli } = await import('../modelCache')
    expect(await getModelsFromCli()).not.toBeNull()
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(argsOf(0)).toEqual(['models', 'list', '--all', '--json'])
  })

  it('a refusal for want of an owner is asked again with --agent, and the catalog loads', async () => {
    writeRoster({ ownership: 'explicit', entries: { 'coder-boo': {}, main: {} } })
    listMock.mockRejectedValueOnce(refusal()).mockResolvedValueOnce(LISTING)
    const { getModelsFromCli, getContextWindowFromCli } = await import('../modelCache')
    const groups = await getModelsFromCli()
    expect(groups?.flatMap((g) => g.models.map((m) => m.id))).toEqual(['openai/gpt-5.6-luna'])
    expect(argsOf(1)).toEqual(['models', 'list', '--all', '--json', '--agent', 'main'])
    // The context windows come back with it (what a config write budgets on).
    expect(await getContextWindowFromCli('openai/gpt-5.6-luna')).toBe(272000)
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('remembers the install needs an owner: the next refresh spawns once, flagged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    writeRoster({ entries: { main: {}, other: {} } })
    listMock.mockRejectedValueOnce(refusal()).mockResolvedValue(LISTING)
    const { getModelsFromCli } = await import('../modelCache')
    await getModelsFromCli()
    vi.setSystemTime(Date.now() + 6 * 60 * 1000) // past the 5-minute cache
    await getModelsFromCli()
    expect(listMock).toHaveBeenCalledTimes(3)
    expect(argsOf(2)).toContain('--agent')
  })

  it('a flagged call that fails sends the next refresh plain again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    writeRoster({ entries: { main: {}, other: {} } })
    listMock
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce(LISTING)
      .mockRejectedValueOnce(new Error("error: unknown option '--agent'"))
      .mockResolvedValueOnce(LISTING)
    const { getModelsFromCli } = await import('../modelCache')
    await getModelsFromCli()
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    await getModelsFromCli() // flagged, fails: the last good groups are kept
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    expect(await getModelsFromCli()).not.toBeNull()
    expect(argsOf(3)).toEqual(['models', 'list', '--all', '--json'])
  })

  it('any other failure is not retried', async () => {
    writeRoster({ entries: { main: {}, other: {} } })
    listMock.mockRejectedValue(new Error('openclaw: command not found'))
    const { getModelsFromCli } = await import('../modelCache')
    expect(await getModelsFromCli()).toBeNull()
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('an owner refusal with no readable roster is not retried', async () => {
    listMock.mockRejectedValue(refusal())
    const { getModelsFromCli } = await import('../modelCache')
    expect(await getModelsFromCli()).toBeNull()
    expect(listMock).toHaveBeenCalledTimes(1)
  })
})
