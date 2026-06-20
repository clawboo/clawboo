// Capability evals — "what can the orchestration do WELL?" Two of these are
// ABLATION-SENSITIVE by construction: they model real clawboo behaviors that
// depend on a specific subsystem, so removing it measurably drops the pass rate.
// (cap-cross-runtime-resume needs structured state; cap-verification-catches-bug
// needs the verifier.) The third exercises end-to-end delegation. Deterministic +
// code-graded so the same tasks run in the PR smoke subset; the nightly adds
// live-model graders for the subjective dimensions.

import {
  addComment,
  claimTask,
  createTask,
  getComments,
  getTask,
  releaseTask,
  updateStatus,
} from '@clawboo/db'

import { outcomeGrader } from '../graders/code'
import type { EvalTask } from '../types'

const TEAM = 'eval-team'

export const CAPABILITY_TASKS: EvalTask[] = [
  {
    id: 'cap-cross-runtime-resume',
    suite: 'capability',
    kind: 'coordination',
    smoke: true,
    description:
      'Agent A pauses mid-task; a DIFFERENT runtime resumes from the structured handoff — without it, B starts cold and fails.',
    referenceNote: 'The worktree/board structured handoff carries cross-runtime state.',
    run: async (ctx) => {
      const t = createTask(ctx.db, { title: 'multi-step build', status: 'todo', teamId: TEAM })
      claimTask(ctx.db, t.id, 'agentA', 'rtA')
      // A does step 1 and (only with structured state) records a handoff.
      if (ctx.flags.structuredState)
        addComment(ctx.db, t.id, 'HANDOFF: step1 done; next=step2', 'agent', 'agentA')
      releaseTask(ctx.db, t.id) // pause → todo
      // A different runtime resumes.
      claimTask(ctx.db, t.id, 'agentB', 'rtB')
      const handoff = ctx.flags.structuredState
        ? getComments(ctx.db, t.id).find((c) => c.body.includes('HANDOFF'))
        : undefined
      const resumed = Boolean(handoff)
      if (resumed) updateStatus(ctx.db, t.id, 'in_review') // B can only finish with the carried context
      return { data: { taskId: t.id, resumed } }
    },
    graders: [
      outcomeGrader('resumed-with-context', (o) => o.data?.['resumed'] === true),
      outcomeGrader(
        'task-completed',
        (o, ctx) => getTask(ctx.db, o.data?.['taskId'] as string)?.status === 'in_review',
      ),
    ],
  },
  {
    id: 'cap-verification-catches-bug',
    suite: 'capability',
    kind: 'coding',
    smoke: true,
    description:
      'Bad work is caught by the independent verifier and NOT promoted to done — without it, the bad work self-certifies.',
    referenceNote: 'builder ≠ judge: a failing gate reverts in_review → in_progress.',
    run: async (ctx) => {
      const t = createTask(ctx.db, { title: 'fix the auth bypass', status: 'todo', teamId: TEAM })
      claimTask(ctx.db, t.id, 'agentA', 'rtA')
      updateStatus(ctx.db, t.id, 'in_review')
      const badWork = true
      let promotedBadWork = false
      if (ctx.flags.verify) {
        // The gate catches it → reverted, never shipped.
        if (badWork) updateStatus(ctx.db, t.id, 'in_progress')
      } else {
        // No independent judge → the generator self-certifies the bad work.
        promotedBadWork = updateStatus(ctx.db, t.id, 'done').ok
      }
      return { data: { taskId: t.id, promotedBadWork } }
    },
    graders: [
      outcomeGrader('bad-work-not-shipped', (o) => o.data?.['promotedBadWork'] === false),
      outcomeGrader(
        'not-done',
        (o, ctx) => getTask(ctx.db, o.data?.['taskId'] as string)?.status !== 'done',
      ),
    ],
  },
  {
    id: 'cap-delegation-fanout',
    suite: 'capability',
    kind: 'coordination',
    smoke: true,
    description:
      'A leader delegates two subtasks; both are claimed, worked, and reported up to the single reduce point.',
    referenceNote: 'Two child tasks under one parent; each completes + reports up.',
    run: async (ctx) => {
      const root = createTask(ctx.db, { title: 'ship feature', status: 'todo', teamId: TEAM })
      claimTask(ctx.db, root.id, 'leader', 'rtL')
      const subs = ['frontend', 'backend'].map((title) =>
        createTask(ctx.db, { title, status: 'todo', teamId: TEAM, parentTaskId: root.id }),
      )
      let reported = 0
      for (const s of subs) {
        claimTask(ctx.db, s.id, `worker-${s.title}`, 'rtW')
        addComment(ctx.db, s.id, `${s.title} done`, 'agent', `worker-${s.title}`)
        updateStatus(ctx.db, s.id, 'in_review')
        if (getComments(ctx.db, s.id).length > 0) reported += 1
      }
      return { data: { reported, expected: subs.length } }
    },
    graders: [
      outcomeGrader(
        'all-subtasks-reported-up',
        (o) => o.data?.['reported'] === o.data?.['expected'],
      ),
    ],
  },
]
