// The Hermes branch of the install route: after a finished install, a gateway
// still running the old one is restarted onto it, and a restart that fails is
// said in the install's own answer, not only in the log.

import type { Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  gatewayState: 'running' as string,
  restartError: null as Error | null,
  restarts: 0,
}))

vi.mock('../hermes', () => ({
  hermesGateway: () => ({
    status: () => ({ state: state.gatewayState }),
    restart: async () => {
      state.restarts += 1
      if (state.restartError) throw state.restartError
      return {}
    },
  }),
  startHermesIfWanted: async () => undefined,
}))
vi.mock('../hermes/install', () => ({
  installHermesRelease: async () => ({ version: '0.23.1' }),
  managedHermesCommand: () => '/opt/runtimes/hermes/v0.23.1/venv/bin/hermes',
}))

import type { RuntimeDescriptor } from '../descriptor'
import { installHermes } from '../hermesInstall'

async function install(): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = []
  let ended: () => void = () => undefined
  const done = new Promise<void>((r) => (ended = r))
  const res = {
    write(chunk: string) {
      for (const m of chunk.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]!))
      return true
    },
    end() {
      ended()
    },
  } as unknown as Response
  installHermes(res, { name: 'Hermes' } as RuntimeDescriptor, { child: null })
  await done
  return events
}

describe('installHermes', () => {
  beforeEach(() => {
    state.gatewayState = 'running'
    state.restartError = null
    state.restarts = 0
  })

  it('restarts a running gateway onto the new install and says it is done', async () => {
    const events = await install()
    expect(state.restarts).toBe(1)
    expect(events.at(-1)).toEqual({ type: 'complete', success: true })
  })

  it('says so when the gateway does not come back after the install', async () => {
    state.restartError = new Error('Hermes did not answer on its port.')
    const events = await install()
    expect(state.restarts).toBe(1)
    const complete = events.at(-1)!
    // The install itself stands; the gateway's failure is named.
    expect(complete).toMatchObject({ type: 'complete', success: true })
    expect(String(complete['warning'])).toMatch(/gateway did not start again/)
    expect(String(complete['warning'])).toContain('Hermes did not answer on its port.')
  })
})
