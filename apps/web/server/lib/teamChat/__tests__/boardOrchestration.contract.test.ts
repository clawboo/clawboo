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

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  claimTask,
  createDb,
  createTask,
  getTask,
  listTasks,
  updateStatus,
  type ClawbooDb,
  type TaskStatus,
} from '@clawboo/db'
import { runCascadeContract, type CascadeBoard } from '@clawboo/team-orchestration/contract'
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

  constructor() {
    this.dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-cascade-'))
    this.db = createDb(path.join(this.dir, 'clawboo.db'))
    this.real = createServerBoardClient(this.db)
  }

  // ── BoardClient (recorded + delegated to the real client) ──
  async createTask(input: CreateTaskInput): Promise<BoardTask | null> {
    this.onCreate?.()
    const task = await this.real.createTask({ ...input, teamId: input.teamId ?? TEAM })
    if (task) this.created.push(task)
    return task
  }
  async claim(taskId: string, assigneeAgentId: string, assigneeRuntime?: string): Promise<ClaimResult> {
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
    return listTasks(this.db, { teamId: TEAM }).length
  }
  allStatuses(): string[] {
    return listTasks(this.db, { teamId: TEAM }).map((t) => t.status)
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
  }): string {
    const t = createTask(this.db, {
      teamId: TEAM,
      title: input.title,
      sourceDelegationId: input.sourceDelegationId ?? undefined,
    })
    claimTask(this.db, t.id, input.assigneeAgentId)
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
