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
const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  children: [] as Record<string, unknown>[],
}))

vi.mock('node:child_process', () => {
  const makeChild = (): unknown => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    const child: Record<string, unknown> = {
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      kill: () => undefined,
      // DELIBERATELY no `pid`: killProcessTree early-returns without one, so a
      // test can never signal a real process group via `process.kill(-pid)`.
      exitCode: null,
      signalCode: null,
      // Let a test drive the lifecycle the shutdown path actually waits on.
      emitClose: () => {
        child['exitCode'] = 0
        for (const fn of listeners['close'] ?? []) fn(0, null)
      },
    }
    const add = (ev: string, fn: (...a: unknown[]) => void): unknown => {
      ;(listeners[ev] ??= []).push(fn)
      return child
    }
    child['on'] = add
    child['once'] = add
    return child
  }
  return {
    spawn: (command: string, args: string[], opts: Record<string, unknown>) => {
      spawnState.calls.push({ command, args, opts })
      const child = makeChild()
      spawnState.children.push(child as Record<string, unknown>)
      return child
    },
  }
})

const { createSpawnDriver, killLiveSubprocesses, shutdownLiveSubprocesses } =
  await import('../subprocess')

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

// A spawned runtime child is detached and never unref'd, so it OUTLIVES the server
// unless shutdown reaps it explicitly. Without that, a Ctrl-C leaves an agent CLI
// running against a task worktree while boot reconciliation hands that task to
// another runner — two live runs, and untracked provider spend.
describe('killLiveSubprocesses — shutdown reaps running children', () => {
  it('reports the children it terminated and empties the registry', async () => {
    killLiveSubprocesses() // start from a clean registry

    const mk = () =>
      createSpawnDriver({
        resolve: async () => ({ command: '/abs/codex', args: ['exec', 'work'] }),
        parseLine: () => [],
        onClose: () => [],
      })
    await mk().start()
    await mk().start()

    // Both live children are reaped...
    expect(killLiveSubprocesses()).toBe(2)
    // ...and the registry is cleared, so a second pass is a no-op.
    expect(killLiveSubprocesses()).toBe(0)
  })

  it('is safe to call when nothing is running', () => {
    expect(killLiveSubprocesses()).toBe(0)
  })
})

// `killLiveSubprocesses` only SENDS SIGTERM; killTree then schedules a SIGKILL
// escalation on a timer. A signal handler that calls process.exit(0) right after
// destroys that timer with the process, so a child ignoring SIGTERM outlives the
// server. Shutdown therefore waits — but must never be able to hang.
describe('shutdownLiveSubprocesses — waits for children, bounded', () => {
  const startOne = async () => {
    await createSpawnDriver({
      resolve: async () => ({ command: '/abs/codex', args: ['exec', 'work'] }),
      parseLine: () => [],
      onClose: () => [],
    }).start()
    return spawnState.children[spawnState.children.length - 1]!
  }

  beforeEach(() => {
    spawnState.children.length = 0
    killLiveSubprocesses() // start from an empty registry
  })

  it('returns immediately when nothing is running', async () => {
    await expect(shutdownLiveSubprocesses(50)).resolves.toEqual({ signalled: 0, exited: 0 })
  })

  it('waits for a child to close and reports it exited', async () => {
    const child = await startOne()
    // Close on the next tick, as a real child would after SIGTERM.
    setTimeout(() => (child['emitClose'] as () => void)(), 5)

    const started = Date.now()
    const out = await shutdownLiveSubprocesses(2_000)

    expect(out).toEqual({ signalled: 1, exited: 1 })
    // Resolved on the close, NOT by burning the full timeout.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('gives up on the deadline when a child never dies, instead of hanging', async () => {
    await startOne() // never emits close — the stuck-child case

    const started = Date.now()
    const out = await shutdownLiveSubprocesses(60)
    const elapsed = Date.now() - started

    expect(out.signalled).toBe(1)
    expect(out.exited).toBe(0) // it never closed
    expect(elapsed).toBeGreaterThanOrEqual(50) // it did wait
    expect(elapsed).toBeLessThan(2_000) // but it gave up — shutdown cannot hang
  })

  it('does not let a child that starts DURING shutdown escape', async () => {
    const first = await startOne() // keeps the wait pending (never closes)

    const shutdown = shutdownLiveSubprocesses(200)
    // A run that spawns after the snapshot was taken.
    const late = await startOne()
    const out = await shutdown

    // The late child was not in the snapshot...
    expect(out.signalled).toBe(1)
    // ...so it must remain tracked for the synchronous fallback rather than being
    // silently dropped, which would let it outlive the server.
    expect(killLiveSubprocesses()).toBe(1)
    expect(first).not.toBe(late)
  })

  it('clears the registry so a second pass is a no-op', async () => {
    await startOne()
    await shutdownLiveSubprocesses(60)
    await expect(shutdownLiveSubprocesses(60)).resolves.toEqual({ signalled: 0, exited: 0 })
  })
})
