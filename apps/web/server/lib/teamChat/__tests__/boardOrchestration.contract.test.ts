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

import type { ResultClaim } from '@clawboo/board-core'
import { describe, expect } from 'vitest'

import {
  answerQuestion,
  claimTask,
  createDb,
  createExecutionProcess,
  executionProcesses,
  createTask,
  getTask,
  listTaskQuestions,
  listTasks,
  recordResultClaim,
  LOCAL_PERSON,
  parseQuestionPayload,
  planApprovalSettingKey,
  setSetting,
  updateStatus,
  type ClawbooDb,
  type TaskStatus,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import {
  runCascadeContract,
  type CascadeBoard,
  type SeedExecState,
} from '@clawboo/team-orchestration/contract'
import type {
  BoardTask,
  ClaimResult,
  ClaimRun,
  CompleteExecutionOutcome,
  CreateTaskInput,
  EngineBoardClient,
  ExecutionRef,
  HandOffCapacity,
  HandOffInput,
  HandOffLink,
  HandOffResult,
  PlanProposal,
  ProposePlanInput,
  TaskDetail,
} from '@clawboo/team-orchestration'

import { createServerBoardClient } from '../serverBoardClient'

// MUST match the teamId the contract's `makeHarness` wires into the engine deps.
const TEAM = 't1'

class RealCascadeBoard implements CascadeBoard {
  private dir: string
  private db: ClawbooDb
  private real: EngineBoardClient
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

  // ── A plan that waits for a person ──
  setPlanApproval(on: boolean): void {
    setSetting(this.db, planApprovalSettingKey(TEAM), JSON.stringify({ on }))
  }
  waitingPlans(): Array<{ questionId: string; taskId: string; steps: string[] }> {
    return this.ownTasks().flatMap((t) =>
      listTaskQuestions(this.db, t.id)
        .filter((q) => q.status === 'pending' && q.kind === 'suggest_tasks')
        .map((q) => ({
          questionId: q.id,
          taskId: q.taskId,
          steps: (parseQuestionPayload(q.payload)?.tasks ?? []).map((step) => step.title),
        })),
    )
  }
  answerPlan(
    questionId: string,
    answer: { accepted: boolean; note?: string },
  ): { ok: boolean; created: number } {
    const r = answerQuestion(this.db, questionId, answer, { person: LOCAL_PERSON })
    return r.ok ? { ok: true, created: r.created?.length ?? 0 } : { ok: false, created: 0 }
  }
  planApprovalOn(teamId: string): Promise<boolean> {
    return this.real.planApprovalOn!(teamId)
  }
  proposePlan(input: ProposePlanInput): Promise<PlanProposal> {
    return this.real.proposePlan!(input)
  }
  closeWaitingPlans(teamId: string): Promise<void> {
    return this.real.closeWaitingPlans!(teamId)
  }
  startingWithoutAsking(input: {
    teamId: string
    agentId: string
    taskId: string | null
    parentTaskId: string | null
  }): Promise<void> {
    return this.real.startingWithoutAsking!(input)
  }

  // ── BoardClient (recorded + delegated to the real client) ──
  async createTask(input: CreateTaskInput): Promise<BoardTask | null> {
    this.onCreate?.()
    const task = await this.real.createTask({ ...input, teamId: input.teamId ?? TEAM })
    if (task) this.created.push(task)
    return task
  }
  async createHandOff(input: HandOffInput): Promise<HandOffResult> {
    this.onCreate?.()
    const result = await this.real.createHandOff({ ...input, teamId: input.teamId ?? TEAM })
    if (result.ok && !result.deduplicated) this.created.push(result.task)
    return result
  }
  handOffRoom(
    teamId: string,
    parentTaskId: string | null,
    opts?: { newRequest?: boolean },
  ): Promise<HandOffCapacity | null> {
    return this.real.handOffRoom(teamId, parentTaskId, opts)
  }
  mainTaskState(taskId: string) {
    return this.real.mainTaskState(taskId)
  }
  openMainTasks(teamId: string) {
    return this.real.openMainTasks(teamId)
  }
  closeMainTask(taskId: string, to: 'done' | 'cancelled') {
    return this.real.closeMainTask(taskId, to)
  }
  parkMainTask(taskId: string, need: string) {
    return this.real.parkMainTask(taskId, need)
  }
  resumeMainTask(taskId: string) {
    return this.real.resumeMainTask(taskId)
  }
  handOffChain(taskId: string): Promise<HandOffLink[] | null> {
    return this.real.handOffChain(taskId)
  }
  delegationFailure(teamId: string, target: string, task: string) {
    return this.real.delegationFailure(teamId, target, task)
  }
  noteDelegationFailure(teamId: string, target: string, task: string): Promise<void> {
    return this.real.noteDelegationFailure(teamId, target, task)
  }
  markDelegationFailureNotified(teamId: string, target: string, task: string): Promise<void> {
    return this.real.markDelegationFailureNotified(teamId, target, task)
  }
  clearDelegationFailure(teamId: string, target: string, task: string): Promise<void> {
    return this.real.clearDelegationFailure(teamId, target, task)
  }
  async claim(
    taskId: string,
    assigneeAgentId: string,
    assigneeRuntime?: string,
    run?: ClaimRun,
  ): Promise<ClaimResult> {
    this.onClaim?.()
    this.claims.push(taskId)
    if (this.forceClaimConflict) return { ok: false, reason: 'conflict' }
    const claim = await this.real.claim(taskId, assigneeAgentId, assigneeRuntime, run)
    if (claim.ok && claim.execution) this.execCount += 1
    return claim
  }
  async updateStatus(
    taskId: string,
    status: string,
    opts?: Parameters<EngineBoardClient['updateStatus']>[2],
  ): Promise<boolean> {
    const ok = await this.real.updateStatus(taskId, status, opts)
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
  async createExecution(
    taskId: string,
    executorType: string,
    opts?: { runReason?: string },
  ): Promise<ExecutionRef | null> {
    const ref = await this.real.createExecution(taskId, executorType, opts)
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
  subtasksOf(taskId: string) {
    return this.real.subtasksOf(taskId)
  }
  resultClaim(execId: string) {
    return this.real.resultClaim(execId)
  }
  releaseSubtaskWait(taskId: string) {
    return this.real.releaseSubtaskWait(taskId)
  }
  runsOnTaskRunner(taskId: string) {
    return this.real.runsOnTaskRunner(taskId)
  }
  seedResultClaim(taskId: string, claim: ResultClaim): void {
    const agent = getTask(this.db, taskId)?.assigneeAgentId ?? ''
    expect(recordResultClaim(this.db, taskId, agent, claim)).toEqual({ ok: true })
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
      const row = createExecutionProcess(this.db, {
        taskId: t.id,
        executorType: exec === 'running-executor' ? 'codex' : 'openclaw',
        engineRun: exec === 'running-openclaw',
      })
      if (exec === 'running-old-openclaw')
        this.db
          .update(executionProcesses)
          .set({ engineRun: null })
          .where(eq(executionProcesses.id, row.id))
          .run()
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
