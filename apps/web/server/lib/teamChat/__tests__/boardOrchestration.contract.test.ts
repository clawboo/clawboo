// The REAL-board side of the cascade CONTRACT: run the SAME `runCascadeContract`
// scenarios (defined once in @clawboo/team-orchestration/contract) against the
// production `serverBoardClient` over a fresh temp SQLite per scenario. This is the
// dual-run the brief asks for — the pure-engine suite proves the cascade LOGIC
// against an in-memory fake; this proves those invariants hold against the REAL
// @clawboo/db board state machine (atomic claim, updateStatus legality + →todo
// unassign, cancelDependents, getReadyTasks), catching any divergence between the
// fake's mirror and the real repo.
//
// The wrapper records the engine's calls (for the contract's call-based assertions)
// and reads live status from the real DB (for the status assertions). Task ids are
// the real UUIDs the repo issues — the contract captures them dynamically from
// `board.created`, so nothing is hardcoded to `task-N`.
//
// The suite runs twice: once over the team's own group chat (no room) and once
// over a ROOM-scoped client, the way a chat room's engine binds it. The room run
// also seeds a live delegation in the team's default room; if room scoping leaked,
// the room engine's resume would adopt it and the scenarios that hand work to
// that agent would wait on a session that is not theirs.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe } from 'vitest'

import {
  claimTask,
  createDb,
  createExecutionProcess,
  createTask,
  getTask,
  listTasks,
  updateStatus,
  type ClawbooDb,
  type TaskStatus,
} from '@clawboo/db'
import {
  runCascadeContract,
  type CascadeBoard,
  type SeedExecState,
} from '@clawboo/team-orchestration/contract'
import type {
  BoardClient,
  BoardTask,
  ClaimResult,
  CompleteExecutionOutcome,
  CreateTaskInput,
  ExecutionRef,
  TaskDetail,
} from '@clawboo/team-orchestration'

import { createServerBoardClient } from '../serverBoardClient'

// MUST match the teamId the contract's `makeHarness` wires into the engine deps.
const TEAM = 't1'

class RealCascadeBoard implements CascadeBoard {
  private dir: string
  private db: ClawbooDb
  private real: BoardClient
  /** Undefined = an unscoped client (the team's group chat, as before rooms). */
  private readonly roomId: string | undefined

  created: BoardTask[] = []
  claims: string[] = []
  statusUpdates: { taskId: string; status: string }[] = []
  completed: { execId: string; outcome: CompleteExecutionOutcome }[] = []
  comments: { taskId: string; body: string }[] = []
  private depShadow = new Map<string, string[]>()
  execCount = 0
  forceClaimConflict = false
  onCreate?: () => void
  onClaim?: () => void

  constructor(roomId?: string) {
    this.roomId = roomId
    this.dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-cascade-'))
    this.db = createDb(path.join(this.dir, 'clawboo.db'))
    this.real =
      roomId === undefined
        ? createServerBoardClient(this.db)
        : createServerBoardClient(this.db, { roomId })
    if (roomId !== undefined) {
      // Another chat's live work: a delegation in the team's default room, held by
      // an agent the scenarios delegate to.
      const noise = createTask(this.db, {
        teamId: TEAM,
        title: 'default-room work',
        sourceDelegationId: 'rN:deleg:agent:a2:reflectTo:leader',
      })
      claimTask(this.db, noise.id, 'a2')
      createExecutionProcess(this.db, { taskId: noise.id, executorType: 'openclaw' })
    }
  }

  /** This board's tasks: its room's when room-scoped. */
  private ownTasks() {
    return listTasks(
      this.db,
      this.roomId === undefined ? { teamId: TEAM } : { teamId: TEAM, roomId: this.roomId },
    )
  }

  // ── BoardClient (recorded + delegated to the real client) ──
  async createTask(input: CreateTaskInput): Promise<BoardTask | null> {
    this.onCreate?.()
    const task = await this.real.createTask({ ...input, teamId: input.teamId ?? TEAM })
    if (task) this.created.push(task)
    return task
  }
  async claim(
    taskId: string,
    assigneeAgentId: string,
    assigneeRuntime?: string,
  ): Promise<ClaimResult> {
    this.onClaim?.()
    this.claims.push(taskId)
    if (this.forceClaimConflict) return { ok: false, reason: 'conflict' }
    return this.real.claim(taskId, assigneeAgentId, assigneeRuntime)
  }
  async updateStatus(taskId: string, status: string): Promise<boolean> {
    const ok = await this.real.updateStatus(taskId, status)
    if (ok) this.statusUpdates.push({ taskId, status })
    return ok
  }
  async addComment(
    taskId: string,
    body: string,
    authorType?: 'agent' | 'user' | 'system',
    authorAgentId?: string,
  ): Promise<void> {
    this.comments.push({ taskId, body })
    return this.real.addComment(taskId, body, authorType, authorAgentId)
  }
  getTask(taskId: string): Promise<TaskDetail | null> {
    return this.real.getTask(taskId)
  }
  listExecutions(
    taskId: string,
  ): Promise<Array<{ id: string; status: string; executorType?: string }> | null> {
    return this.real.listExecutions(taskId)
  }
  async createExecution(taskId: string, executorType: string): Promise<ExecutionRef | null> {
    const ref = await this.real.createExecution(taskId, executorType)
    if (ref) this.execCount += 1
    return ref
  }
  async completeExecution(execId: string, outcome: CompleteExecutionOutcome): Promise<void> {
    this.completed.push({ execId, outcome })
    return this.real.completeExecution(execId, outcome)
  }
  async linkDep(taskId: string, dependsOnTaskId: string): Promise<boolean> {
    const list = this.depShadow.get(taskId) ?? []
    list.push(dependsOnTaskId)
    this.depShadow.set(taskId, list)
    return this.real.linkDep(taskId, dependsOnTaskId)
  }
  getReadyTasks(teamId: string): Promise<BoardTask[]> {
    return this.real.getReadyTasks(teamId)
  }
  listTasks(teamId: string): Promise<BoardTask[]> {
    return this.real.listTasks(teamId)
  }
  async cancelDependents(taskId: string): Promise<Array<{ id: string; title?: string }>> {
    const cancelled = await this.real.cancelDependents(taskId)
    for (const c of cancelled) this.statusUpdates.push({ taskId: c.id, status: 'cancelled' })
    return cancelled
  }

  // ── CascadeBoard inspection (live DB reads) + control ──
  statusOf(taskId: string): string | undefined {
    return getTask(this.db, taskId)?.status
  }
  depsOf(taskId: string): readonly string[] {
    return this.depShadow.get(taskId) ?? []
  }
  taskCount(): number {
    return this.ownTasks().length
  }
  allStatuses(): string[] {
    return this.ownTasks().map((t) => t.status)
  }
  forceRelease(taskId: string): void {
    // Simulate an EXTERNAL release (the server stale-sweep): route through the repo
    // directly (not the recorded wrapper) so it isn't counted as an engine update.
    updateStatus(this.db, taskId, 'todo' as TaskStatus)
  }
  seedInProgress(input: {
    title: string
    sourceDelegationId: string | null
    assigneeAgentId: string
    exec?: SeedExecState
  }): string {
    const t = createTask(this.db, {
      teamId: TEAM,
      title: input.title,
      sourceDelegationId: input.sourceDelegationId ?? undefined,
      ...(this.roomId !== undefined ? { roomId: this.roomId } : {}),
    })
    claimTask(this.db, t.id, input.assigneeAgentId)
    // A refresh scenario normally has a live ENGINE run behind the row; the
    // other two shapes exist so the resume guards are actually exercised.
    const exec = input.exec ?? 'running-openclaw'
    if (exec !== 'none') {
      createExecutionProcess(this.db, {
        taskId: t.id,
        executorType: exec === 'running-executor' ? 'codex' : 'openclaw',
      })
    }
    return t.id
  }
  dispose(): void {
    try {
      ;(this.db as unknown as { $client?: { close?: () => void } }).$client?.close?.()
    } catch {
      // best-effort
    }
    rmSync(this.dir, { recursive: true, force: true })
  }
}

runCascadeContract({ makeBoard: () => new RealCascadeBoard() })

describe('in a chat room', () => {
  runCascadeContract({ makeBoard: () => new RealCascadeBoard('room-1') })
})
