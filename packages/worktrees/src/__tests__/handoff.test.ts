import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agentHandoffSchema, reconstructState, readHandoff, writeHandoff } from '../handoff'
import { SOR_FILES, writeScaffold } from '../scaffold'
import { scaffoldInput } from './gitHarness'

describe('agent handoff protocol (no git needed — pure files)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-handoff-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes + reads an AGENT_HANDOFF.json round-trip (zod-validated)', async () => {
    const written = await writeHandoff(dir, {
      handoffFrom: 'A',
      runtime: 'codex',
      completedSubtasks: ['did a'],
      brokenOrUnverified: [],
      nextBestStep: 'do b',
      commands: { init: './init.sh', verify: 'make test', start: '' },
      evidence: {},
      warnings: [],
    })
    expect(written.timestamp).toBeTruthy() // defaulted
    const read = await readHandoff(dir)
    expect(read?.runtime).toBe('codex')
    expect(read?.completedSubtasks).toEqual(['did a'])
    expect(read?.nextBestStep).toBe('do b')
  })

  it('the handoff is role-neutral — `runtime` may be a human', () => {
    const parsed = agentHandoffSchema.parse({
      handoffFrom: 'Sam (human)',
      runtime: 'human',
      timestamp: '2026-01-01T00:00:00.000Z',
      nextBestStep: 'review the PR',
    })
    expect(parsed.runtime).toBe('human')
    expect(parsed.completedSubtasks).toEqual([]) // defaulted arrays
  })

  it('reconstructState reads the handoff when present', async () => {
    await writeScaffold(dir, scaffoldInput('x'))
    await writeHandoff(dir, {
      handoffFrom: 'A',
      runtime: 'claude-code',
      completedSubtasks: ['step 1'],
      brokenOrUnverified: ['step 2 flaky'],
      nextBestStep: 'fix step 2',
      whyBlocked: null,
      commands: { init: './init.sh', verify: 'echo verify', start: 'echo start' },
      evidence: {},
      warnings: ['careful'],
    })
    const state = await reconstructState(dir)
    expect(state.hasHandoff).toBe(true)
    expect(state.done).toEqual(['step 1'])
    expect(state.broken).toEqual(['step 2 flaky'])
    expect(state.next).toBe('fix step 2')
    expect(state.lastRuntime).toBe('claude-code')
  })

  it('reconstructState falls back to task-progress.md when no handoff exists', async () => {
    await writeScaffold(dir, scaffoldInput('x'))
    // Overwrite the progress file with real (non-placeholder) bullets.
    await writeFile(
      path.join(dir, SOR_FILES.progress),
      '# Progress\n\n## Done\n\n- shipped the parser\n\n## Blocked\n\n- waiting on review\n',
      'utf8',
    )
    const state = await reconstructState(dir)
    expect(state.hasHandoff).toBe(false)
    expect(state.done).toEqual(['shipped the parser'])
    expect(state.broken).toEqual(['waiting on review'])
    // Commands recovered from the scaffold's init.sh.
    expect(state.commands.verify).toBe('echo verify')
  })

  it('a malformed handoff is treated as absent (falls back, never throws)', async () => {
    await writeScaffold(dir, scaffoldInput('x'))
    await writeFile(path.join(dir, SOR_FILES.handoff), '{ not valid json', 'utf8')
    const read = await readHandoff(dir)
    expect(read).toBeNull()
    const state = await reconstructState(dir)
    expect(state.hasHandoff).toBe(false)
  })

  it('nativeSessionId round-trips write → read → reconstructState', async () => {
    await writeHandoff(dir, {
      handoffFrom: 'A',
      runtime: 'hermes',
      completedSubtasks: ['did a'],
      brokenOrUnverified: [],
      nextBestStep: 'do b',
      commands: { init: './init.sh', verify: '', start: '' },
      evidence: {},
      warnings: [],
      nativeSessionId: 'hsess-42',
    })
    const read = await readHandoff(dir)
    expect(read?.nativeSessionId).toBe('hsess-42')
    const state = await reconstructState(dir)
    expect(state.nativeSessionId).toBe('hsess-42')
    expect(state.lastRuntime).toBe('hermes')
  })

  it('roomCursor round-trips write → read (additive optional)', async () => {
    const written = await writeHandoff(dir, {
      handoffFrom: 'leader',
      runtime: 'codex',
      completedSubtasks: [],
      brokenOrUnverified: [],
      nextBestStep: '',
      commands: { init: './init.sh', verify: '', start: '' },
      evidence: {},
      warnings: [],
      roomCursor: { roomId: 'team:t1', lastSeenSeq: 7 },
    })
    expect(written.roomCursor).toEqual({ roomId: 'team:t1', lastSeenSeq: 7 })
    const read = await readHandoff(dir)
    expect(read?.roomCursor).toEqual({ roomId: 'team:t1', lastSeenSeq: 7 })
    // A handoff without it still parses (the field is optional).
    const bare = agentHandoffSchema.parse({ handoffFrom: 'x', runtime: 'codex', timestamp: 'now' })
    expect(bare.roomCursor).toBeUndefined()
  })

  it('a legacy handoff without nativeSessionId still parses (additive zod safety) → null', async () => {
    await writeHandoff(dir, {
      handoffFrom: 'A',
      runtime: 'codex',
      completedSubtasks: [],
      brokenOrUnverified: [],
      nextBestStep: '',
      commands: { init: './init.sh', verify: '', start: '' },
      evidence: {},
      warnings: [],
    })
    const state = await reconstructState(dir)
    expect(state.hasHandoff).toBe(true)
    expect(state.nativeSessionId).toBeNull()
  })
})
