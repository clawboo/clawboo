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

const { createCodexDriver, translateCodexEvent } = await import('../codexDriver')

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
