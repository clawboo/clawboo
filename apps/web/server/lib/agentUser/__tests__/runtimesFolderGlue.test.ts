// The two links between the runtimes folder and agents on their own OS user:
// the startup check is told every launcher and the command it runs, and the
// runtimes folder must stay apart from the agent user's home.

import { afterEach, describe, expect, it, vi } from 'vitest'

const launches: Record<
  string,
  { launcher: string; command: string; record: { interpreter?: { path: string } } } | null
> = {}
const apart: { label: string; dir: () => string | null }[] = []

vi.mock('../../runtimeFolder', () => ({
  ownedRuntimeLaunch: (name: string) => launches[name] ?? null,
  keepRuntimesDirApartFrom: (label: string, dir: () => string | null) => {
    const entry = { label, dir }
    apart.push(entry)
    return () => apart.splice(apart.indexOf(entry), 1)
  },
}))
vi.mock('../../platform', () => ({
  resolveRuntimeBin: (name: string) => (name === 'codex' ? '/rt/bin/codex' : null),
}))
vi.mock('../../runtimes/agentSdkBinary', () => ({ resolveAgentSdkBinary: () => null }))
vi.mock('../../secretsVault', () => ({
  secretValuesForExposureCheck: () => [],
  getVaultPaths: () => ({}),
}))
vi.mock('../../bootAccessToken', () => ({
  resolveBootAccessToken: () => ({ ok: true, token: 'tok' }),
}))

afterEach(() => {
  for (const k of Object.keys(launches)) delete launches[k]
})

describe('runtimes folder and the agent user', () => {
  it('names each launcher Clawboo installed and the command it runs, once each', async () => {
    launches['openclaw'] = {
      launcher: '/rt/bin/openclaw',
      command: '/opt/node24/bin/node',
      record: {},
    }
    launches['codex'] = { launcher: '/rt/bin/codex', command: '/opt/node24/bin/node', record: {} }
    launches['hermes'] = {
      launcher: '/rt/bin/hermes',
      command: '/rt/hermes/current/hermes-script',
      record: { interpreter: { path: '/rt/hermes/python/bin/python3.14' } },
    }
    const { gatherCheckInputs } = await import('../serverBoot')
    const bins = gatherCheckInputs().runtimeBinaries
    expect(bins).toContainEqual({ runtime: 'openclaw', path: '/rt/bin/openclaw' })
    expect(bins).toContainEqual({ runtime: 'openclaw', path: '/opt/node24/bin/node' })
    expect(bins).toContainEqual({ runtime: 'codex', path: '/opt/node24/bin/node' })
    // codex's launcher is also what PATH lookup found: listed once.
    expect(bins.filter((b) => b.runtime === 'codex' && b.path === '/rt/bin/codex')).toHaveLength(1)
    // Hermes's launcher runs a script on its own Python: all three are listed.
    expect(bins).toContainEqual({ runtime: 'hermes', path: '/rt/bin/hermes' })
    expect(bins).toContainEqual({ runtime: 'hermes', path: '/rt/hermes/current/hermes-script' })
    expect(bins).toContainEqual({ runtime: 'hermes', path: '/rt/hermes/python/bin/python3.14' })
  })

  it("keeps the runtimes folder apart from the agent user's home, registered once", async () => {
    const { keepRuntimesApartFromAgentHome } = await import('../boot')
    const { setActiveAgentHost } = await import('../state')
    keepRuntimesApartFromAgentHome()
    keepRuntimesApartFromAgentHome()
    const mine = apart.filter((a) => a.label === "the agent user's home")
    expect(mine).toHaveLength(1)
    expect(mine[0]!.dir()).toBeNull()
    setActiveAgentHost({
      client: { closed: null },
      hello: { home: '/var/lib/clawboo-agent' },
      config: {},
    } as never)
    expect(mine[0]!.dir()).toBe('/var/lib/clawboo-agent')
    setActiveAgentHost(null)
  })
})
