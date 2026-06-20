// The Codex driver's terminal must be idempotent across the subprocess
// substrate's 'error'+'close' double-fire: `createSpawnDriver` invokes `onClose`
// from BOTH the child's 'error' and 'close' handlers, and a spawn of a missing
// binary fires both ('error' = ENOENT, then 'close'). Without the `sawResult`
// guard the driver would synthesize TWO `result` terminals from one run.
//
// This drives the REAL `createCodexDriver` against a REAL OS spawn — only the
// binary-path resolver is stubbed to a guaranteed-missing path, so the production
// `onClose` runs and the double-fire comes from the kernel, not a fake.

import type { CodexNativeEvent } from '@clawboo/adapter-codex'
import type { StartOpts } from '@clawboo/executor'
import { describe, expect, it, vi } from 'vitest'

import type { RuntimeRunContext } from '../types'

vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return { ...actual, resolveRuntimeBin: () => '/nonexistent/clawboo-codex-doublefire' }
})

const { createCodexDriver } = await import('../codexDriver')

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
