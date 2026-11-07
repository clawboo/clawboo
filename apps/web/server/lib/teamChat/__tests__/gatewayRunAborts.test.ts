// Moving a deleted room's unfinished task closes its OpenClaw run in the database,
// where no Gateway client reaches. At boot no engine has aborted that run either, and
// the Gateway may not be connected yet. So the closed runs wait here, and are aborted
// in the Gateway once it is, without ever touching a run a live engine owns.

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  archiveRoom,
  claimTask,
  createExecutionProcess,
  createRoom,
  createTask,
  moveArchivedRoomTasks,
  reconcileOrphans,
  teams,
} from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const delivers = vi.hoisted(() => [] as Array<{ abortMap: Map<string, unknown> }>)

// The run primitive is faked so a test can put a run in the engine's own abort map.
vi.mock('../serverDeliver', () => ({
  createServerDeliver: (deps: { abortMap: Map<string, unknown> }) => {
    delivers.push(deps)
    return async () => undefined
  },
}))

const { getDb, getDbPath, resetDb } = await import('../../db')
const { getTeamOrchestrator, isTeamSessionLive, resetTeamOrchestrators } =
  await import('../teamOrchestrator')
const { createGatewayRunAborts, GATEWAY_ABORT_GIVE_UP_MS, queueGatewayAborts } =
  await import('../gatewayRunAborts')

const KEY = 'agent:bea:team:T:room:R'

function fakeClient(abort: (key: string) => Promise<unknown> = async () => ({ ok: true })) {
  const calls: string[] = []
  return {
    calls,
    client: {
      sessions: {
        abort: (key: string) => {
          calls.push(key)
          return abort(key)
        },
      },
    },
  }
}

describe('gateway run aborts', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-gateway-aborts-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    delivers.length = 0
  })

  afterEach(async () => {
    vi.useRealTimers()
    resetTeamOrchestrators()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  describe('the waiting list', () => {
    const queue = (over: Partial<Parameters<typeof createGatewayRunAborts>[0]> = {}) =>
      createGatewayRunAborts({ client: () => null, isLive: () => false, ...over })

    it('holds a run while the Gateway is not connected, and aborts it once it is', async () => {
      vi.useFakeTimers()
      let connected: ReturnType<typeof fakeClient>['client'] | null = null
      const gateway = fakeClient()
      const aborts = queue({ client: () => connected })

      aborts.add([KEY])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(gateway.calls).toEqual([])
      expect(aborts.pending()).toEqual([KEY])

      connected = gateway.client
      await vi.advanceTimersByTimeAsync(60_000)
      expect(gateway.calls).toEqual([KEY])
      expect(aborts.pending()).toEqual([])

      // Done with it: nothing more goes to the Gateway, and the timer has stopped.
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(gateway.calls).toEqual([KEY])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('aborts at once when the Gateway is already connected', async () => {
      const gateway = fakeClient()
      const aborts = queue({ client: () => gateway.client })
      aborts.add([KEY])
      await vi.waitFor(() => expect(gateway.calls).toEqual([KEY]))
      await vi.waitFor(() => expect(aborts.pending()).toEqual([]))
    })

    it('asks once for many runs on one session', async () => {
      const gateway = fakeClient()
      const aborts = queue({ client: () => gateway.client })
      aborts.add([KEY, KEY])
      await vi.waitFor(() => expect(aborts.pending()).toEqual([]))
      expect(gateway.calls).toEqual([KEY])
    })

    it('tries a failed abort again until one lands', async () => {
      vi.useFakeTimers()
      let refuse = true
      const gateway = fakeClient(async () => {
        if (refuse) throw new Error('gateway_disconnected')
        return { ok: true }
      })
      const aborts = queue({ client: () => gateway.client })
      aborts.add([KEY])
      await vi.advanceTimersByTimeAsync(0)
      expect(gateway.calls).toEqual([KEY])
      expect(aborts.pending()).toEqual([KEY])

      refuse = false
      await vi.advanceTimersByTimeAsync(60_000)
      expect(gateway.calls.length).toBeGreaterThan(1)
      expect(aborts.pending()).toEqual([])
    })

    it('never aborts a session a live engine owns, then or later', async () => {
      vi.useFakeTimers()
      let live = true
      const gateway = fakeClient()
      const aborts = queue({ client: () => gateway.client, isLive: () => live })
      aborts.add([KEY])
      await vi.advanceTimersByTimeAsync(0)
      expect(gateway.calls).toEqual([])
      // Forgotten rather than kept: whatever runs on that session now is not the
      // run that was closed.
      expect(aborts.pending()).toEqual([])
      live = false
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(gateway.calls).toEqual([])
    })

    it('asks about the engine right before the abort, not when the run was queued', async () => {
      vi.useFakeTimers()
      let connected: ReturnType<typeof fakeClient>['client'] | null = null
      let live = false
      const gateway = fakeClient()
      const aborts = queue({ client: () => connected, isLive: () => live })
      aborts.add([KEY])
      await vi.advanceTimersByTimeAsync(0)
      live = true
      connected = gateway.client
      await vi.advanceTimersByTimeAsync(60_000)
      expect(gateway.calls).toEqual([])
    })

    it('gives up after its time, on a Gateway that never connects', async () => {
      vi.useFakeTimers()
      const gateway = fakeClient()
      let connected: ReturnType<typeof fakeClient>['client'] | null = null
      const aborts = queue({ client: () => connected })
      aborts.add([KEY])
      await vi.advanceTimersByTimeAsync(GATEWAY_ABORT_GIVE_UP_MS - 60_000)
      expect(aborts.pending()).toEqual([KEY])
      await vi.advanceTimersByTimeAsync(60_000 * 2)
      expect(aborts.pending()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      connected = gateway.client
      aborts.add([])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(gateway.calls).toEqual([])
    })

    it('does not stack passes behind a slow abort', async () => {
      vi.useFakeTimers()
      let finish = (): void => undefined
      const gateway = fakeClient(
        () =>
          new Promise((res) => {
            finish = () => res({ ok: true })
          }),
      )
      const aborts = queue({ client: () => gateway.client })
      aborts.add([KEY])
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(gateway.calls).toEqual([KEY])
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect(aborts.pending()).toEqual([])
    })
  })

  describe('from the room move', () => {
    /** Team T, room R, an agent on `runtime` with a running engine task in the room,
     *  and the room archived with its run not stopped: the state a boot pass finds. */
    function bootState(runtime: string): void {
      const db = getDb()
      const now = Date.now()
      db.insert(teams)
        .values({ id: 'T', name: 'T', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
        .run()
      db.insert(agents)
        .values({
          id: 'bea',
          name: 'Bea',
          gatewayId: 'bea',
          sourceId: runtime,
          runtime,
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      const room = createRoom(db, { teamId: 'T', name: 'Design', memberIds: ['bea'] })
      const task = createTask(db, {
        title: 'Running step',
        teamId: 'T',
        roomId: room.id,
        sourceDelegationId: 'r1:deleg:agent:bea:reflectTo:lead',
      }).id
      claimTask(db, task, 'bea')
      // The engine labels every run it drives `openclaw`, whatever the runtime.
      createExecutionProcess(db, { taskId: task, executorType: 'openclaw', engineRun: true })
      archiveRoom(db, room.id)
    }

    it('aborts the OpenClaw run through the Gateway once connected', async () => {
      vi.useFakeTimers()
      bootState('openclaw')
      const db = getDb()
      const { closedRuns } = moveArchivedRoomTasks(db)
      expect(closedRuns).toHaveLength(1)

      let connected: ReturnType<typeof fakeClient>['client'] | null = null
      const gateway = fakeClient()
      const aborts = createGatewayRunAborts({ client: () => connected, isLive: () => false })
      queueGatewayAborts(db, closedRuns, aborts)
      await vi.advanceTimersByTimeAsync(0)
      expect(gateway.calls).toEqual([])

      connected = gateway.client
      await vi.advanceTimersByTimeAsync(60_000)
      expect(gateway.calls).toEqual([`agent:bea:team:T:room:${closedRuns[0]!.roomId}`])
    })

    it('aborts a run the boot reap closed before the move reached it', async () => {
      // A server that crashed more than the beat window ago: boot reaps first.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      bootState('openclaw')
      const db = getDb()
      expect(reconcileOrphans(db, { staleAfterMs: -1 }).reconciled).toBe(1)
      const { closedRuns } = moveArchivedRoomTasks(db)
      const gateway = fakeClient()
      const aborts = createGatewayRunAborts({ client: () => gateway.client, isLive: () => false })
      queueGatewayAborts(db, closedRuns, aborts)
      await vi.waitFor(() => expect(aborts.pending()).toEqual([]))
      expect(gateway.calls).toEqual([`agent:bea:team:T:room:${closedRuns[0]!.roomId}`])
    })

    it('leaves a run on another runtime alone: the engine label is not proof of OpenClaw', async () => {
      bootState('claude-code')
      const db = getDb()
      const { closedRuns } = moveArchivedRoomTasks(db)
      expect(closedRuns).toHaveLength(1)
      const gateway = fakeClient()
      const aborts = createGatewayRunAborts({ client: () => gateway.client, isLive: () => false })
      queueGatewayAborts(db, closedRuns, aborts)
      expect(aborts.pending()).toEqual([])
      expect(gateway.calls).toEqual([])
    })

    it('never reaches for the server’s own list when there is nothing to abort', () => {
      // A native-only install: the list, and the Gateway registry behind it, stay unbuilt.
      expect(() => queueGatewayAborts(getDb(), [])).not.toThrow()
    })

    it('never throws into the boot pass, even on a closed database', () => {
      const aborts = createGatewayRunAborts({ client: () => null, isLive: () => false })
      expect(() =>
        queueGatewayAborts(
          undefined as never,
          [{ taskId: 't', execId: 'e', teamId: 'T', roomId: 'R', agentId: 'bea' }],
          aborts,
        ),
      ).not.toThrow()
    })
  })

  describe('its two callers', () => {
    // Merges touch both files, and neither pass can be driven here without a server.
    const source = (rel: string): string =>
      readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8')

    it.each(['index.ts', 'api/rooms.ts'])('%s queues what the room move closed', (file) => {
      const code = source(file)
      const move = code.indexOf('moveArchivedRoomTasks(db, {')
      expect(move).toBeGreaterThan(-1)
      expect(code.indexOf('queueGatewayAborts(db, closedRuns)', move)).toBeGreaterThan(move)
    })
  })

  describe('isTeamSessionLive', () => {
    function seedTeam(): string {
      const db = getDb()
      const now = Date.now()
      db.insert(teams)
        .values({ id: 'T', name: 'T', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
        .run()
      db.insert(agents)
        .values({
          id: 'bea',
          name: 'Bea',
          gatewayId: 'bea',
          sourceId: 'openclaw',
          runtime: 'openclaw',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      return createRoom(db, { teamId: 'T', name: 'Design', memberIds: ['bea'] }).id
    }

    it('is true only while a resident engine has a run going on that session', () => {
      const roomId = seedTeam()
      const key = `agent:bea:team:T:room:${roomId}`
      expect(isTeamSessionLive(key)).toBe(false)

      getTeamOrchestrator('T', { roomId })
      expect(isTeamSessionLive(key)).toBe(false)

      const engine = delivers.at(-1)!
      engine.abortMap.set(key, { adapter: {}, run: {} })
      expect(isTeamSessionLive(key)).toBe(true)
      expect(isTeamSessionLive('agent:bea:team:T')).toBe(false)

      engine.abortMap.delete(key)
      expect(isTeamSessionLive(key)).toBe(false)
    })
  })
})
