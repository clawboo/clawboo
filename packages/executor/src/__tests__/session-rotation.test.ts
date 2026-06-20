import { describe, expect, it, vi } from 'vitest'

import type { RunHandle, RuntimeAdapter } from '../types'
import {
  buildRotationHandoffNote,
  DEFAULT_ROTATION,
  rotateSession,
  shouldRotate,
  type RotationHandoff,
} from '../session-rotation'

describe('shouldRotate', () => {
  it('rotates at or above the threshold of the context window', () => {
    expect(shouldRotate({ tokensUsed: 170_000, contextWindow: 200_000, thresholdPct: 0.85 })).toBe(
      true,
    )
    expect(shouldRotate({ tokensUsed: 200_000, contextWindow: 200_000, thresholdPct: 0.85 })).toBe(
      true,
    )
  })

  it('does not rotate below the threshold', () => {
    expect(shouldRotate({ tokensUsed: 100_000, contextWindow: 200_000, thresholdPct: 0.85 })).toBe(
      false,
    )
  })

  it('is inert when the context window is unknown (0) — never rotates on the watermark', () => {
    expect(shouldRotate({ tokensUsed: 999_999, contextWindow: 0, thresholdPct: 0.85 })).toBe(false)
  })

  it('is inert when the threshold is non-positive', () => {
    expect(shouldRotate({ tokensUsed: 999_999, contextWindow: 200_000, thresholdPct: 0 })).toBe(
      false,
    )
  })
})

describe('buildRotationHandoffNote', () => {
  const handoff: RotationHandoff = {
    taskId: 't1',
    predecessorSessionKey: 'runtime:claude-code:task:t1',
    predecessorSessionId: 'sess-1',
    reason: 'max_turns',
    lastSummary: 'wired the parser; NEXT finish the writer',
    tokensUsed: 180_000,
    rotationIndex: 2,
  }

  it('renders a short note naming the reason, index, and last progress', () => {
    const note = buildRotationHandoffNote(handoff)
    expect(note).toContain('Session handoff (rotation)')
    expect(note).toContain('Reason: max_turns')
    expect(note).toContain('Rotation: #2')
    expect(note).toContain('wired the parser')
    expect(note).toContain('only the context you actually need')
  })

  it('omits the progress line when there is no summary', () => {
    const note = buildRotationHandoffNote({ ...handoff, lastSummary: '' })
    expect(note).not.toContain('Last progress')
  })
})

describe('rotateSession', () => {
  function fakeAdapter(opts: { withCodec: boolean; serializeThrows?: boolean }): {
    adapter: RuntimeAdapter
    serialize: ReturnType<typeof vi.fn>
  } {
    const serialize = vi.fn(async (run: RunHandle) => {
      if (opts.serializeThrows) throw new Error('codec boom')
      return JSON.stringify({ sessionKey: run.sessionKey, sessionId: run.runId })
    })
    const adapter = {
      id: 'claude-code',
      participantKind: 'agent',
      ...(opts.withCodec
        ? {
            sessionCodec: {
              serialize,
              restore: async () => ({ adapterId: 'claude-code', sessionKey: 'x', runId: null }),
            },
          }
        : {}),
    } as unknown as RuntimeAdapter
    return { adapter, serialize }
  }

  const current: RunHandle = {
    adapterId: 'claude-code',
    sessionKey: 'runtime:claude-code:task:t1',
    runId: 'sess-1',
  }
  const handoff: RotationHandoff = {
    taskId: 't1',
    predecessorSessionKey: current.sessionKey,
    predecessorSessionId: 'sess-1',
    reason: 'max_turns',
    lastSummary: 'partial work',
    tokensUsed: 180_000,
    rotationIndex: 1,
  }

  it('serializes the predecessor, restarts with the rendered note, and records lineage', async () => {
    const { adapter, serialize } = fakeAdapter({ withCodec: true })
    const successor: RunHandle = {
      adapterId: 'claude-code',
      sessionKey: `${current.sessionKey}:r1`,
      runId: null,
    }
    const restart = vi.fn(async (note: string) => {
      expect(note).toContain('Session handoff (rotation)')
      return successor
    })
    const recordRotation = vi.fn()

    const out = await rotateSession({ adapter, current, handoff, restart, recordRotation })

    expect(serialize).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledOnce()
    expect(recordRotation).toHaveBeenCalledOnce()
    const recordArg = recordRotation.mock.calls[0]![0] as {
      serialized: string | null
      successor: RunHandle
    }
    expect(recordArg.serialized).toContain('sess-1')
    expect(recordArg.successor).toBe(successor)
    expect(out).toBe(successor)
  })

  it('proceeds with serialized=null when the adapter has no codec', async () => {
    const { adapter, serialize } = fakeAdapter({ withCodec: false })
    const successor: RunHandle = {
      adapterId: 'claude-code',
      sessionKey: `${current.sessionKey}:r1`,
      runId: null,
    }
    const recordRotation = vi.fn()
    const out = await rotateSession({
      adapter,
      current,
      handoff,
      restart: async () => successor,
      recordRotation,
    })
    expect(serialize).not.toHaveBeenCalled()
    expect(
      (recordRotation.mock.calls[0]![0] as { serialized: string | null }).serialized,
    ).toBeNull()
    expect(out).toBe(successor)
  })

  it('tolerates a throwing codec (continuity rides the note, not the blob)', async () => {
    const { adapter } = fakeAdapter({ withCodec: true, serializeThrows: true })
    const successor: RunHandle = {
      adapterId: 'claude-code',
      sessionKey: `${current.sessionKey}:r1`,
      runId: null,
    }
    const recordRotation = vi.fn()
    const out = await rotateSession({
      adapter,
      current,
      handoff,
      restart: async () => successor,
      recordRotation,
    })
    expect(
      (recordRotation.mock.calls[0]![0] as { serialized: string | null }).serialized,
    ).toBeNull()
    expect(out).toBe(successor)
  })

  it('never throws when recordRotation throws (lineage/obs is best-effort)', async () => {
    const { adapter } = fakeAdapter({ withCodec: true })
    const successor: RunHandle = {
      adapterId: 'claude-code',
      sessionKey: `${current.sessionKey}:r1`,
      runId: null,
    }
    const out = await rotateSession({
      adapter,
      current,
      handoff,
      restart: async () => successor,
      recordRotation: () => {
        throw new Error('db down')
      },
    })
    expect(out).toBe(successor)
  })
})

describe('DEFAULT_ROTATION', () => {
  it('ships conservative defaults', () => {
    expect(DEFAULT_ROTATION.thresholdPct).toBe(0.85)
    expect(DEFAULT_ROTATION.maxRotations).toBe(3)
  })
})
