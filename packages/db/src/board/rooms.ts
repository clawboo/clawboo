// ─── Chat rooms (data-access layer) ─────────────────────────────────────────
// A team's extra conversations, each a subset of the team's members. The team's
// own group chat is the implicit DEFAULT room and has no row here (room id null
// everywhere a room id appears), so nothing about it had to move.
//
// Membership is stored but never trusted on its own: the live roster of a room is
// its stored members INTERSECTED with the team's active agents (see
// `activeRoomMemberIds`), so an agent that was archived or moved to another team
// drops out of every room without a sweep having to catch it first.

import { randomUUID } from 'node:crypto'

import {
  delegationTargetOf,
  isEngineRun,
  parseWaitingOn,
  waitsToStartByItself,
} from '@clawboo/board-core'
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { agents, roomMembers, rooms, tasks, type DbRoom, type DbTask } from '../schema'
import { classifyAttempts } from './attempts'
import { immediateWrite, withWriteRetry } from './contention'
import {
  completeExecutionProcess,
  createExecutionProcess,
  getReadyTasks,
  setTaskWaitingOn,
  listExecutions,
  updateStatus,
} from './repository'

export interface RoomWithMembers extends DbRoom {
  /** Stored member ids, oldest membership first. */
  memberIds: string[]
}

export const ROOM_NAME_MAX = 80

/** A room name with its whitespace collapsed, or null when nothing is left. */
export function normalizeRoomName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX)
  return name.length > 0 ? name : null
}

/** The team's active (non-archived) agent ids. */
function activeTeamAgentIds(db: ClawbooDb, teamId: string): Set<string> {
  const rows = db
    .select({ id: agents.id, archivedAt: agents.archivedAt })
    .from(agents)
    .where(eq(agents.teamId, teamId))
    .all()
  return new Set(rows.filter((r) => !r.archivedAt).map((r) => r.id))
}

/** The ids in `memberIds` that are NOT active members of `teamId` (empty = all
 *  valid). Duplicates count once. */
export function invalidRoomMembers(db: ClawbooDb, teamId: string, memberIds: string[]): string[] {
  const active = activeTeamAgentIds(db, teamId)
  return [...new Set(memberIds)].filter((id) => !active.has(id))
}

function memberIdsOf(db: ClawbooDb, roomId: string): string[] {
  return db
    .select({ agentId: roomMembers.agentId })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(asc(roomMembers.createdAt), asc(roomMembers.agentId))
    .all()
    .map((r) => r.agentId)
}

export interface CreateRoomInput {
  teamId: string
  name: string
  /** Validated by the caller (`invalidRoomMembers`); duplicates are ignored. */
  memberIds: string[]
  tenantId?: string | null
}

export function createRoom(db: ClawbooDb, input: CreateRoomInput): RoomWithMembers {
  const now = Date.now()
  const room: DbRoom = {
    id: randomUUID(),
    teamId: input.teamId,
    name: input.name,
    tenantId: input.tenantId ?? null,
    archivedAt: null,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const memberIds = [...new Set(input.memberIds)]
  immediateWrite(db, (tx) => {
    tx.insert(rooms).values(room).run()
    memberIds.forEach((agentId, i) => {
      tx.insert(roomMembers)
        .values({ roomId: room.id, agentId, createdAt: now + i })
        .run()
    })
  })
  return { ...room, memberIds }
}

export function getRoom(db: ClawbooDb, roomId: string): RoomWithMembers | null {
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get() as DbRoom | undefined
  return room ? { ...room, memberIds: memberIdsOf(db, roomId) } : null
}

/** The room when it exists, belongs to `teamId` and is not archived; else null. */
export function getActiveRoom(
  db: ClawbooDb,
  teamId: string,
  roomId: string,
): RoomWithMembers | null {
  const room = getRoom(db, roomId)
  if (!room || room.teamId !== teamId || room.archivedAt !== null) return null
  return room
}

export function listRooms(
  db: ClawbooDb,
  teamId: string,
  opts: { includeArchived?: boolean } = {},
): RoomWithMembers[] {
  const conds = [eq(rooms.teamId, teamId)]
  if (!opts.includeArchived) conds.push(isNull(rooms.archivedAt))
  const rows = db
    .select()
    .from(rooms)
    .where(and(...conds))
    .orderBy(asc(rooms.createdAt), asc(rooms.id))
    .all() as DbRoom[]
  if (rows.length === 0) return []
  const members = db
    .select({ roomId: roomMembers.roomId, agentId: roomMembers.agentId })
    .from(roomMembers)
    .where(
      inArray(
        roomMembers.roomId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(roomMembers.createdAt), asc(roomMembers.agentId))
    .all()
  const byRoom = new Map<string, string[]>()
  for (const m of members) {
    const list = byRoom.get(m.roomId) ?? []
    list.push(m.agentId)
    byRoom.set(m.roomId, list)
  }
  return rows.map((r) => ({ ...r, memberIds: byRoom.get(r.id) ?? [] }))
}

export function renameRoom(db: ClawbooDb, roomId: string, name: string): RoomWithMembers | null {
  withWriteRetry(() =>
    db.update(rooms).set({ name, updatedAt: Date.now() }).where(eq(rooms.id, roomId)).run(),
  )
  return getRoom(db, roomId)
}

/** Pin the room to the top of the sidebar's room list, or unpin it. */
export function setRoomPinned(
  db: ClawbooDb,
  roomId: string,
  pinned: boolean,
): RoomWithMembers | null {
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(rooms)
      .set({ pinnedAt: pinned ? now : null, updatedAt: now })
      .where(eq(rooms.id, roomId))
      .run(),
  )
  return getRoom(db, roomId)
}

/** Replace the room's member set (validated by the caller). Members kept keep
 *  their original join time, so the roster order is stable across edits. */
export function setRoomMembers(
  db: ClawbooDb,
  roomId: string,
  memberIds: string[],
): RoomWithMembers | null {
  const wanted = [...new Set(memberIds)]
  const now = Date.now()
  immediateWrite(db, (tx) => {
    const current = new Set(
      tx
        .select({ agentId: roomMembers.agentId })
        .from(roomMembers)
        .where(eq(roomMembers.roomId, roomId))
        .all()
        .map((r) => r.agentId),
    )
    const drop = [...current].filter((id) => !wanted.includes(id))
    if (drop.length > 0)
      tx.delete(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), inArray(roomMembers.agentId, drop)))
        .run()
    wanted
      .filter((id) => !current.has(id))
      .forEach((agentId, i) => {
        tx.insert(roomMembers)
          .values({ roomId, agentId, createdAt: now + i })
          .run()
      })
    tx.update(rooms).set({ updatedAt: now }).where(eq(rooms.id, roomId)).run()
  })
  return getRoom(db, roomId)
}

/** Add members, leaving the room's current ones in place (validated by the
 *  caller). Use this, not `setRoomMembers`, to add an agent: a replace sent
 *  from a stale roster drops whoever joined in the meantime, while each add
 *  inserts only its own rows. */
export function addRoomMembers(
  db: ClawbooDb,
  roomId: string,
  memberIds: string[],
): RoomWithMembers | null {
  const added = [...new Set(memberIds)]
  const now = Date.now()
  immediateWrite(db, (tx) => {
    added.forEach((agentId, i) => {
      tx.insert(roomMembers)
        .values({ roomId, agentId, createdAt: now + i })
        .onConflictDoNothing()
        .run()
    })
    tx.update(rooms).set({ updatedAt: now }).where(eq(rooms.id, roomId)).run()
  })
  return getRoom(db, roomId)
}

/** Archive a room: it leaves every list, and nothing is deleted. */
export function archiveRoom(db: ClawbooDb, roomId: string): RoomWithMembers | null {
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(rooms)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(eq(rooms.id, roomId), isNull(rooms.archivedAt)))
      .run(),
  )
  return getRoom(db, roomId)
}

/**
 * The room's LIVE roster: its stored members that are still active agents of the
 * room's team, in membership order. Empty for an unknown or archived room.
 */
export function activeRoomMemberIds(db: ClawbooDb, teamId: string, roomId: string): string[] {
  const room = getActiveRoom(db, teamId, roomId)
  if (!room) return []
  const active = activeTeamAgentIds(db, teamId)
  return room.memberIds.filter((id) => active.has(id))
}

/** Every room id the team has ever had, archived ones included (for sweeps). */
export function listRoomIdsForTeam(db: ClawbooDb, teamId: string): string[] {
  return db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.teamId, teamId))
    .all()
    .map((r) => r.id)
}

/** An engine run the room move closed, with what names its session. */
export interface ClosedRoomRun {
  taskId: string
  execId: string
  teamId: string
  roomId: string
  agentId: string
}

/** What `moveArchivedRoomTasks` did. */
export interface MovedRoomTasks {
  moved: DbTask[]
  closedRuns: ClosedRoomRun[]
}

/** A task stopped while it waited in To do to start by itself no longer waits. */
function clearWaitToStart(db: ClawbooDb, task: DbTask): void {
  if (waitsToStartByItself(parseWaitingOn(task.waitingOn))) setTaskWaitingOn(db, task.id, null)
}

/**
 * A person's Stop in a room with no engine loaded: the tasks waiting in To do to start by
 * themselves (their turn to try again, or room in a budget) still have to hear it. The
 * dispatch pump builds no engine for them until their wait ends, so a Stop would find
 * nothing to tell and they would start anyway. The same mark an engine's Stop writes, and
 * the fire policy reads it the same way. Returns the tasks it stopped.
 */
export function stopTasksWaitingToStart(
  db: ClawbooDb,
  scope: { teamId: string; roomId: string | null },
): DbTask[] {
  const stoppedTasks: DbTask[] = []
  for (const task of getReadyTasks(db, scope)) {
    if (!waitsToStartByItself(parseWaitingOn(task.waitingOn))) continue
    if (!delegationTargetOf(task.sourceDelegationId)) continue
    const stop = createExecutionProcess(db, {
      taskId: task.id,
      executorType: 'openclaw',
      engineRun: true,
    })
    completeExecutionProcess(db, stop.id, { status: 'cancelled', byPerson: true })
    clearWaitToStart(db, task)
    stoppedTasks.push(task)
  }
  return stoppedTasks
}

/**
 * Move the unfinished tasks of archived rooms to the team's own chat (room null),
 * stopped, and return them. Archiving a room only stamps the room, and the only
 * engine left to run its tasks is the team chat's, which reads tasks with no
 * room: until they move, Retry, Assign and a reply on them start nothing.
 *
 * Stopped first, the way the room engine's own Stop stops its work, so nothing
 * starts in the team chat until a person retries it:
 *  - a task still running in the room with an engine run (`isEngineRun`) no engine
 *    stopped: after a restart a room's engine is built only for ready work, so
 *    nothing else would. Its run is closed as cancelled and the task goes back to
 *    To do. Moved while running, the stale sweep would release it and the team
 *    chat's pump would start it again;
 *  - a ready task bound to an agent gets a created-and-cancelled execution,
 *    unless its last run already says so. Otherwise the pump would start it as
 *    soon as it arrived, and archiving a room would start the work it was meant
 *    to stop.
 * A task still waiting on another one in the same room is not marked: it runs
 * once a person retries the step before it and that step is done. One waiting on
 * a task outside the room is marked as a ready one is: that task can finish on its
 * own, and the step would then start with nobody retrying it. Finished tasks stay
 * where they are. `skip` names tasks the team chat never runs (the task runner's): they
 * move but are not stopped, as the room engine's Stop leaves them too.
 *
 * The caller stops the room's engine first and waits for that Stop to be
 * written. `roomId` limits the move to one archived room (the archive route);
 * without it every archived room is swept (the boot pass, which also covers rooms
 * archived before this existed). Idempotent.
 *
 * `closedRuns` lists the engine runs no engine stopped: the ones this closed, and a
 * moved task's last run if it ended as a crash (the boot reap runs first, and takes a
 * run already silent past its window). This layer has no Gateway client, so an
 * OpenClaw one may still be going there, and the server aborts it (see the server's
 * `gatewayRunAborts`).
 */
export function moveArchivedRoomTasks(
  db: ClawbooDb,
  opts: { roomId?: string; skip?: (task: DbTask) => boolean } = {},
): MovedRoomTasks {
  const archived = db
    .select({ id: rooms.id, teamId: rooms.teamId })
    .from(rooms)
    .where(
      opts.roomId
        ? and(isNotNull(rooms.archivedAt), eq(rooms.id, opts.roomId))
        : isNotNull(rooms.archivedAt),
    )
    .all()
  const stopped = 'Stopped: its chat room was archived.'
  const moved: DbTask[] = []
  const closedRuns: ClosedRoomRun[] = []
  for (const room of archived) {
    const running = db
      .select()
      .from(tasks)
      .where(and(eq(tasks.roomId, room.id), eq(tasks.status, 'in_progress')))
      .all() as DbTask[]
    for (const task of running) {
      if (opts.skip?.(task)) continue
      const execs = listExecutions(db, task.id)
      const last = execs[execs.length - 1]
      if (!last || last.status !== 'running' || !isEngineRun(last)) continue
      const closed = completeExecutionProcess(db, last.id, {
        status: 'cancelled',
        error: stopped,
        byPerson: true,
      })
      // Read before the move to To do clears the assignee.
      const agentId = task.assigneeAgentId ?? delegationTargetOf(task.sourceDelegationId)
      if (closed && agentId)
        closedRuns.push({
          taskId: task.id,
          execId: last.id,
          teamId: room.teamId,
          roomId: room.id,
          agentId,
        })
      updateStatus(db, task.id, 'todo')
    }
    // Released with its assignee cleared, so the delegation names the agent. Read
    // before the markers below, which become the task's last run.
    const released = db
      .select()
      .from(tasks)
      .where(and(eq(tasks.roomId, room.id), eq(tasks.status, 'todo'), eq(tasks.dropped, 0)))
      .all() as DbTask[]
    for (const task of released) {
      if (opts.skip?.(task)) continue
      const agentId = delegationTargetOf(task.sourceDelegationId)
      const last = listExecutions(db, task.id).at(-1)
      if (agentId && last && isEngineRun(last) && classifyAttempts([last]).lastKind === 'crash')
        closedRuns.push({
          taskId: task.id,
          execId: last.id,
          teamId: room.teamId,
          roomId: room.id,
          agentId,
        })
    }
    const waitingOutside = db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.roomId, room.id),
          eq(tasks.status, 'todo'),
          eq(tasks.dropped, 0),
          sql`EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = ${tasks.id} AND dt.status != 'done' AND (dt.room_id IS NULL OR dt.room_id != ${room.id}))`,
        ),
      )
      .all() as DbTask[]
    const ready = getReadyTasks(db, { teamId: room.teamId, roomId: room.id })
    for (const task of [...ready, ...waitingOutside]) {
      if (!delegationTargetOf(task.sourceDelegationId) || opts.skip?.(task)) continue
      const execs = listExecutions(db, task.id)
      if (execs.length > 0 && execs[execs.length - 1]!.status === 'cancelled') continue
      const stop = createExecutionProcess(db, {
        taskId: task.id,
        executorType: 'openclaw',
        engineRun: true,
      })
      completeExecutionProcess(db, stop.id, { status: 'cancelled', error: stopped, byPerson: true })
      clearWaitToStart(db, task)
    }
    const rows = withWriteRetry(() =>
      db
        .update(tasks)
        .set({ roomId: null, updatedAt: Date.now() })
        .where(and(eq(tasks.roomId, room.id), notInArray(tasks.status, ['done', 'cancelled'])))
        .returning()
        .all(),
    ) as DbTask[]
    moved.push(...rows)
  }
  return { moved, closedRuns }
}
