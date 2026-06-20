// Regression evals — snapshots of clawboo's load-bearing orchestration guarantees
// (sourced from REAL failures the build hardened against). Target pass rate ≈100%;
// a drop means something broke. Deterministic + code-graded → they run in the PR
// smoke subset (no live model). They grade the OUTCOME (final board state / the
// event log), never a narration.

import {
  addComment,
  canTransition,
  claimTask,
  createTask,
  getComments,
  getReadyTasks,
  getTask,
  linkDep,
  updateStatus,
} from '@clawboo/db'

import { outcomeGrader } from '../graders/code'
import type { EvalTask } from '../types'

const TEAM = 'eval-team'

export const REGRESSION_TASKS: EvalTask[] = [
  {
    id: 'reg-claim-409-no-retry',
    suite: 'regression',
    kind: 'coordination',
    smoke: true,
    description:
      'A second claim on an owned task loses (409) and is never retried — exactly one owner.',
    referenceNote: 'claimTask is an atomic CAS; the loser gets ok:false.',
    run: async (ctx) => {
      const t = createTask(ctx.db, { title: 'shared', status: 'todo', teamId: TEAM })
      const a = claimTask(ctx.db, t.id, 'agentA', 'rtA')
      const b = claimTask(ctx.db, t.id, 'agentB', 'rtB') // must lose
      return { data: { taskId: t.id, firstOk: a.ok, secondOk: b.ok } }
    },
    graders: [
      outcomeGrader(
        'exactly-one-winner',
        (o) => o.data?.['firstOk'] === true && o.data?.['secondOk'] === false,
      ),
      outcomeGrader(
        'owned-by-first',
        (o, ctx) => getTask(ctx.db, o.data?.['taskId'] as string)?.assigneeAgentId === 'agentA',
      ),
    ],
  },
  {
    id: 'reg-dep-gate',
    suite: 'regression',
    kind: 'coordination',
    smoke: true,
    description:
      'A task with an unmet dependency is NOT ready until its blocker is done (plan → dep chain).',
    referenceNote: 'getReadyTasks excludes a task whose dep is not done.',
    run: async (ctx) => {
      const blocker = createTask(ctx.db, { title: 'blocker', status: 'todo', teamId: TEAM })
      const dependent = createTask(ctx.db, { title: 'dependent', status: 'todo', teamId: TEAM })
      linkDep(ctx.db, dependent.id, blocker.id)
      const readyBefore = getReadyTasks(ctx.db, { teamId: TEAM }).some((x) => x.id === dependent.id)
      claimTask(ctx.db, blocker.id, 'agentA', 'rtA')
      updateStatus(ctx.db, blocker.id, 'done') // in_progress → done (legal)
      const readyAfter = getReadyTasks(ctx.db, { teamId: TEAM }).some((x) => x.id === dependent.id)
      return { data: { readyBefore, readyAfter } }
    },
    graders: [
      outcomeGrader('blocked-before', (o) => o.data?.['readyBefore'] === false),
      outcomeGrader('ready-after-blocker-done', (o) => o.data?.['readyAfter'] === true),
    ],
  },
  {
    id: 'reg-report-up',
    suite: 'regression',
    kind: 'coordination',
    smoke: true,
    description: 'A worker reports up a SUMMARY comment on completion (the single reduce point).',
    referenceNote: 'addComment records the report-up; getComments reads it.',
    run: async (ctx) => {
      const t = createTask(ctx.db, { title: 'do work', status: 'todo', teamId: TEAM })
      claimTask(ctx.db, t.id, 'agentA', 'rtA')
      addComment(ctx.db, t.id, 'Implemented X and verified Y.', 'agent', 'agentA')
      updateStatus(ctx.db, t.id, 'in_review')
      return {
        data: {
          taskId: t.id,
          hasReport: getComments(ctx.db, t.id).some((c) => c.body.includes('Implemented')),
        },
      }
    },
    graders: [
      outcomeGrader('report-recorded', (o) => o.data?.['hasReport'] === true),
      outcomeGrader(
        'progressed-to-review',
        (o, ctx) => getTask(ctx.db, o.data?.['taskId'] as string)?.status === 'in_review',
      ),
    ],
  },
  {
    id: 'reg-state-machine',
    suite: 'regression',
    kind: 'coding',
    smoke: true,
    description:
      'The board state machine rejects illegal skips, allows the legal flow, and locks terminals.',
    referenceNote: 'canTransition: todo↛done; todo→in_progress→done; done is terminal.',
    run: async () => ({
      data: {
        illegalRejected: !canTransition('todo', 'done'),
        legalForward: canTransition('todo', 'in_progress') && canTransition('in_progress', 'done'),
        terminalLocked: !canTransition('done', 'in_progress'),
      },
    }),
    graders: [
      outcomeGrader('illegal-skip-rejected', (o) => o.data?.['illegalRejected'] === true),
      outcomeGrader('legal-flow-allowed', (o) => o.data?.['legalForward'] === true),
      outcomeGrader('terminal-locked', (o) => o.data?.['terminalLocked'] === true),
    ],
  },
]
