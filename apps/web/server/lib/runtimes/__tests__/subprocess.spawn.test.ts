// The shared subprocess driver must NEVER spawn with `shell: true` — an untrusted
// prompt is passed as an argv element, so a shell would let cmd metacharacters in
// it execute. Mocks node:child_process to record the spawn options and assert the
// shell is off while the malicious prompt is passed verbatim (inert without a shell).

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', () => ({ isWindows: false }))

interface SpawnCall {
  command: string
  args: string[]
  opts: Record<string, unknown>
}
const spawnState = vi.hoisted(() => ({ calls: [] as SpawnCall[] }))

vi.mock('node:child_process', () => {
  const makeChild = (): unknown => {
    const child: Record<string, unknown> = {
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      kill: () => undefined,
    }
    child['on'] = () => child // chainable no-op for 'error'/'close'
    return child
  }
  return {
    spawn: (command: string, args: string[], opts: Record<string, unknown>) => {
      spawnState.calls.push({ command, args, opts })
      return makeChild()
    },
  }
})

const { createSpawnDriver } = await import('../subprocess')

describe('createSpawnDriver — never spawns with a shell', () => {
  it('passes shell:false and the untrusted prompt verbatim as argv', async () => {
    spawnState.calls.length = 0
    const driver = createSpawnDriver({
      resolve: async () => ({
        command: '/abs/codex',
        args: ['exec', 'do X & calc.exe'], // a metachar-laden prompt
      }),
      parseLine: () => [],
      onClose: () => [],
    })
    await driver.start()

    expect(spawnState.calls).toHaveLength(1)
    const call = spawnState.calls[0]!
    // The core invariant: the shell is NEVER enabled.
    expect(call.opts['shell']).toBe(false)
    // On non-Windows the prompt reaches spawn as a raw argv element — inert
    // because there is no shell to interpret the `&`.
    expect(call.args).toContain('do X & calc.exe')
    expect(call.command).toBe('/abs/codex')
  })

  it('scrubs clawboo server secrets from the spawned env (granted keys survive)', async () => {
    spawnState.calls.length = 0
    const prevGw = process.env['GATEWAY_AUTH_TOKEN']
    const prevStudio = process.env['STUDIO_ACCESS_TOKEN']
    process.env['GATEWAY_AUTH_TOKEN'] = 'gw-secret'
    process.env['STUDIO_ACCESS_TOKEN'] = 'studio-secret'
    try {
      const driver = createSpawnDriver({
        resolve: async () => ({
          command: '/abs/hermes',
          args: ['chat'],
          env: { OPENROUTER_API_KEY: 'granted' },
        }),
        parseLine: () => [],
        onClose: () => [],
      })
      await driver.start()

      const env = spawnState.calls[0]!.opts['env'] as Record<string, string>
      expect(env['GATEWAY_AUTH_TOKEN']).toBeUndefined()
      expect(env['STUDIO_ACCESS_TOKEN']).toBeUndefined()
      expect(env['OPENROUTER_API_KEY']).toBe('granted') // the runtime's granted key
      expect(env['PATH']).toBe(process.env['PATH']) // benign env preserved
    } finally {
      if (prevGw === undefined) delete process.env['GATEWAY_AUTH_TOKEN']
      else process.env['GATEWAY_AUTH_TOKEN'] = prevGw
      if (prevStudio === undefined) delete process.env['STUDIO_ACCESS_TOKEN']
      else process.env['STUDIO_ACCESS_TOKEN'] = prevStudio
    }
  })
})
